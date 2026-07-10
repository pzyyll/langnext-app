// ABOUTME: Manual model CRUD, remote-cache merge, and async connection/sync orchestration.
// ABOUTME: Vault and transport work run via spawn_blocking / async reqwest without exposing secrets.
use crate::adapters::catalog;
use crate::adapters::transport::{ModelListRequest, ModelTransport};
use crate::credentials::CredentialVault;
use crate::domain::model::{
	Availability, CapabilityOverridesV1, ConnectionTestResult, ManualModelWrite, ModelSource, ProviderModel,
	ProviderModelDto, RemoteModelSyncItem, SyncModelsResult,
};
use crate::domain::provider::{CredentialKind, ModelsSyncStatus, ProviderInstance, ProviderInstanceDto, ProxyMode};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{provider_instances, provider_models};
use crate::storage::Database;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const MAX_MODEL_KEY_LEN: usize = 256;

/// Non-persisted sync result when connection settings changed mid-flight.
pub const CONNECTION_CHANGED_CODE: &str = "connection_changed";

#[derive(Clone)]
pub struct ModelService {
	db: Database,
	vault: Arc<dyn CredentialVault>,
	transport: Arc<dyn ModelTransport>,
	/// Per-provider async locks: concurrent syncs for one provider serialize (max transport
	/// concurrency 1). Not single-flight — each waiter re-resolves connection identity after
	/// acquiring the lock and runs its own Future.
	sync_locks: Arc<StdMutex<HashMap<Uuid, Arc<AsyncMutex<()>>>>>,
}

/// Connection fields that determine which remote endpoint/auth a sync uses.
/// Compared before merge/error writes so mid-flight config saves cannot corrupt the new config.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ConnectionIdentity {
	adapter_id: String,
	base_url_override: Option<String>,
	credential_kind: CredentialKind,
	credential_ref: Option<String>,
	proxy_mode: ProxyMode,
}

impl ConnectionIdentity {
	fn from_provider(provider: &ProviderInstance) -> Self {
		Self {
			adapter_id: provider.adapter_id.clone(),
			base_url_override: provider.base_url_override.clone(),
			credential_kind: provider.credential_kind,
			credential_ref: provider.credential_ref.clone(),
			proxy_mode: provider.proxy_mode,
		}
	}
}

enum ResolveOutcome {
	Ready {
		request: ModelListRequest,
		connection: ConnectionIdentity,
		/// Provider row `updated_at` when the connection was resolved (non-sensitive version).
		provider_updated_at: String,
	},
	MissingCredential {
		connection: ConnectionIdentity,
		provider_updated_at: String,
	},
	CredentialStoreFailure {
		connection: ConnectionIdentity,
		provider_updated_at: String,
	},
}

/// Outcome of a guarded sync error write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncWriteOutcome {
	Applied,
	ConnectionChanged,
}

impl ModelService {
	pub fn new(db: Database, vault: Arc<dyn CredentialVault>, transport: Arc<dyn ModelTransport>) -> Self {
		Self {
			db,
			vault,
			transport,
			sync_locks: Arc::new(StdMutex::new(HashMap::new())),
		}
	}

	pub fn list_by_provider(&self, provider_id: Uuid) -> Result<Vec<ProviderModelDto>, StorageError> {
		self
			.db
			.read(|conn| provider_models::list_by_provider(conn, provider_id))
	}

	pub fn save_manual(&self, input: ManualModelWrite) -> Result<ProviderModelDto, StorageError> {
		validate_manual_model(&input)?;
		let capability_overrides_json = CapabilityOverridesV1::from_json(&input.capability_overrides_json)?
			.map(|v| serde_json::to_value(v).expect("capability overrides serialize"));
		self.db.transaction(|uow| {
			// Ensure provider exists.
			provider_instances::get(uow.conn(), input.provider_instance_id)?;
			let now = now_rfc3339();
			match input.id {
				None => {
					let model = ProviderModel {
						id: new_id(),
						provider_instance_id: input.provider_instance_id,
						model_key: input.model_key.clone(),
						source: ModelSource::Manual,
						remote_display_name: None,
						display_name_override: input.display_name_override.clone(),
						enabled: input.enabled,
						availability: Availability::Available,
						remote_metadata_json: None,
						capability_overrides_json,
						last_seen_at: None,
						created_at: now.clone(),
						updated_at: now,
					};
					provider_models::insert(uow.conn(), &model)?;
					Ok(model)
				}
				Some(id) => {
					let mut existing = provider_models::get(uow.conn(), id)?;
					if existing.source != ModelSource::Manual {
						return Err(StorageError::Validation(
							"only manual models can be edited with save_manual".into(),
						));
					}
					if existing.provider_instance_id != input.provider_instance_id {
						return Err(StorageError::Validation("provider_instance_id cannot change".into()));
					}
					existing.model_key = input.model_key.clone();
					existing.display_name_override = input.display_name_override.clone();
					existing.enabled = input.enabled;
					existing.capability_overrides_json = capability_overrides_json;
					existing.updated_at = now;
					provider_models::update(uow.conn(), &existing)?;
					Ok(existing)
				}
			}
		})
	}

	pub fn set_enabled(&self, id: Uuid, enabled: bool) -> Result<ProviderModelDto, StorageError> {
		let now = now_rfc3339();
		self.db.transaction(|uow| {
			provider_models::set_enabled(uow.conn(), id, enabled, &now)?;
			provider_models::get(uow.conn(), id)
		})
	}

	pub fn delete(&self, id: Uuid) -> Result<(), StorageError> {
		self.db.transaction(|uow| provider_models::delete(uow.conn(), id))
	}

	/// Pure cache-merge used after a remote model list is received.
	/// Available in tests as a direct merge helper without connection identity guards.
	#[cfg(test)]
	pub fn apply_remote_merge(
		&self,
		provider_id: Uuid,
		remote_models: &[RemoteModelSyncItem],
	) -> Result<(), StorageError> {
		self
			.apply_remote_merge_guarded(provider_id, remote_models, None)
			.map(|_| ())
	}

	/// Merge only when connection identity still matches the resolved sync request.
	///
	/// Returns `Ok(SyncWriteOutcome::ConnectionChanged)` when the provider connection was
	/// changed mid-flight so the remote snapshot must not be applied.
	fn apply_remote_merge_if_connection_matches(
		&self,
		provider_id: Uuid,
		expected: &ConnectionIdentity,
		remote_models: &[RemoteModelSyncItem],
	) -> Result<SyncWriteOutcome, StorageError> {
		self.apply_remote_merge_guarded(provider_id, remote_models, Some(expected))
	}

	/// Shared merge transaction. When `expected` is set, aborts without writing if
	/// the provider connection fields no longer match the resolved sync request.
	fn apply_remote_merge_guarded(
		&self,
		provider_id: Uuid,
		remote_models: &[RemoteModelSyncItem],
		expected: Option<&ConnectionIdentity>,
	) -> Result<SyncWriteOutcome, StorageError> {
		let seen_at = now_rfc3339();
		self.db.transaction(|uow| {
			let provider = provider_instances::get(uow.conn(), provider_id)?;
			if let Some(expected) = expected {
				let current = ConnectionIdentity::from_provider(&provider);
				if current != *expected {
					return Ok(SyncWriteOutcome::ConnectionChanged);
				}
			}
			provider_models::apply_remote_sync(uow.conn(), provider_id, remote_models, &seen_at)?;
			provider_instances::update_sync_status(
				uow.conn(),
				provider_id,
				Some(&seen_at),
				ModelsSyncStatus::Ok,
				None,
				&seen_at,
			)?;
			Ok(SyncWriteOutcome::Applied)
		})
	}

	/// Record a bounded sync failure without mutating model rows or clearing last success time.
	///
	/// When `expected` is set, compares connection identity in the same transaction and skips
	/// the write if the provider connection no longer matches the request that produced the error.
	fn record_sync_error_guarded(
		&self,
		provider_id: Uuid,
		error_code: &str,
		expected: Option<&ConnectionIdentity>,
	) -> Result<SyncWriteOutcome, StorageError> {
		validate_sync_error_code(error_code)?;
		let now = now_rfc3339();
		self.db.transaction(|uow| {
			let provider = provider_instances::get(uow.conn(), provider_id)?;
			if let Some(expected) = expected {
				let current = ConnectionIdentity::from_provider(&provider);
				if current != *expected {
					return Ok(SyncWriteOutcome::ConnectionChanged);
				}
			}
			provider_instances::update_sync_failure(
				uow.conn(),
				provider_id,
				ModelsSyncStatus::Error,
				Some(error_code),
				&now,
			)?;
			Ok(SyncWriteOutcome::Applied)
		})
	}

	/// Unguarded failure write for direct unit tests of status persistence.
	#[cfg(test)]
	pub fn record_sync_error(&self, provider_id: Uuid, error_code: &str) -> Result<(), StorageError> {
		self
			.record_sync_error_guarded(provider_id, error_code, None)
			.map(|_| ())
	}

	/// Test the saved provider connection without mutating models or sync status.
	pub async fn test_connection(&self, provider_id: Uuid) -> Result<ConnectionTestResult, StorageError> {
		let resolved = self.resolve_request(provider_id).await?;
		match resolved {
			ResolveOutcome::MissingCredential {
				provider_updated_at, ..
			} => Ok(ConnectionTestResult {
				ok: false,
				error_code: Some("auth".into()),
				message: "Authentication failed".into(),
				model_count: None,
				provider_updated_at,
			}),
			ResolveOutcome::CredentialStoreFailure {
				provider_updated_at, ..
			} => Ok(ConnectionTestResult {
				ok: false,
				error_code: Some("credential_unavailable".into()),
				message: "Credential store unavailable".into(),
				model_count: None,
				provider_updated_at,
			}),
			ResolveOutcome::Ready {
				request,
				provider_updated_at,
				..
			} => match self.transport.list_models(request).await {
				Ok(models) => Ok(ConnectionTestResult {
					ok: true,
					error_code: None,
					message: format!("Connection succeeded; {} models available", models.len()),
					model_count: Some(models.len()),
					provider_updated_at,
				}),
				Err(err) => Ok(ConnectionTestResult {
					ok: false,
					error_code: Some(err.code().into()),
					message: err.to_string(),
					model_count: None,
					provider_updated_at,
				}),
			},
		}
	}

	/// Fetch the complete remote model list, merge on success, or record a bounded sync error.
	///
	/// Concurrent syncs for the same provider are serialized via a per-provider async mutex
	/// (max transport concurrency 1). This is serialization, not single-flight: each call
	/// runs independently after the previous finishes and re-reads the latest connection
	/// identity under the lock — callers do not share one Future.
	pub async fn sync_models(&self, provider_id: Uuid) -> Result<SyncModelsResult, StorageError> {
		let lock = self.sync_lock_for(provider_id);
		let _guard = lock.lock().await;
		// Resolve connection identity only after acquiring the lock so a queued sync
		// observes saves that completed while it waited.
		self.sync_models_locked(provider_id).await
	}

	async fn sync_models_locked(&self, provider_id: Uuid) -> Result<SyncModelsResult, StorageError> {
		let resolved = self.resolve_request(provider_id).await?;
		match resolved {
			ResolveOutcome::MissingCredential { connection, .. } => {
				self
					.finish_sync_error(provider_id, &connection, "auth", "Authentication failed")
					.await
			}
			ResolveOutcome::CredentialStoreFailure { connection, .. } => {
				self
					.finish_sync_error(
						provider_id,
						&connection,
						"credential_unavailable",
						"Credential store unavailable",
					)
					.await
			}
			ResolveOutcome::Ready {
				request, connection, ..
			} => match self.transport.list_models(request).await {
				Ok(remote_models) => {
					let remote_count = remote_models.len();
					let outcome = self
						.apply_remote_merge_async(provider_id, connection, remote_models)
						.await?;
					match outcome {
						SyncWriteOutcome::ConnectionChanged => self.connection_changed_result(provider_id).await,
						SyncWriteOutcome::Applied => {
							let (models, provider) = self.read_models_and_provider(provider_id).await?;
							Ok(SyncModelsResult {
								ok: true,
								error_code: None,
								// Count is the remote snapshot size for this sync, not total DB rows
								// (manual models may make the table larger).
								message: format!("Synced {remote_count} models"),
								models,
								provider,
							})
						}
					}
				}
				Err(err) => {
					self
						.finish_sync_error(provider_id, &connection, err.code(), &err.to_string())
						.await
				}
			},
		}
	}

	/// Per-provider async lock used to serialize concurrent syncs (not single-flight).
	fn sync_lock_for(&self, provider_id: Uuid) -> Arc<AsyncMutex<()>> {
		let mut map = self.sync_locks.lock().expect("sync locks poisoned");
		map
			.entry(provider_id)
			.or_insert_with(|| Arc::new(AsyncMutex::new(())))
			.clone()
	}

	async fn resolve_request(&self, provider_id: Uuid) -> Result<ResolveOutcome, StorageError> {
		let db = self.db.clone();
		let vault = self.vault.clone();
		spawn_blocking_storage(move || resolve_saved_provider(&db, vault.as_ref(), provider_id)).await
	}

	async fn apply_remote_merge_async(
		&self,
		provider_id: Uuid,
		connection: ConnectionIdentity,
		remote_models: Vec<RemoteModelSyncItem>,
	) -> Result<SyncWriteOutcome, StorageError> {
		let service = self.clone();
		spawn_blocking_storage(move || {
			service.apply_remote_merge_if_connection_matches(provider_id, &connection, &remote_models)
		})
		.await
	}

	async fn record_sync_error_async(
		&self,
		provider_id: Uuid,
		connection: ConnectionIdentity,
		error_code: &str,
	) -> Result<SyncWriteOutcome, StorageError> {
		let service = self.clone();
		let code = error_code.to_string();
		spawn_blocking_storage(move || service.record_sync_error_guarded(provider_id, &code, Some(&connection))).await
	}

	async fn finish_sync_error(
		&self,
		provider_id: Uuid,
		connection: &ConnectionIdentity,
		error_code: &str,
		message: &str,
	) -> Result<SyncModelsResult, StorageError> {
		let outcome = self
			.record_sync_error_async(provider_id, connection.clone(), error_code)
			.await?;
		match outcome {
			SyncWriteOutcome::ConnectionChanged => self.connection_changed_result(provider_id).await,
			SyncWriteOutcome::Applied => self.failure_sync_result(provider_id, error_code, message).await,
		}
	}

	async fn connection_changed_result(&self, provider_id: Uuid) -> Result<SyncModelsResult, StorageError> {
		let (models, provider) = self.read_models_and_provider(provider_id).await?;
		Ok(SyncModelsResult {
			ok: false,
			error_code: Some(CONNECTION_CHANGED_CODE.into()),
			message: "Connection settings changed during sync; models were not updated. Sync again.".into(),
			models,
			provider,
		})
	}

	async fn read_models_and_provider(
		&self,
		provider_id: Uuid,
	) -> Result<(Vec<ProviderModelDto>, ProviderInstanceDto), StorageError> {
		let db = self.db.clone();
		spawn_blocking_storage(move || {
			db.read_snapshot(|conn| {
				let models = provider_models::list_by_provider(conn, provider_id)?;
				let row = provider_instances::get(conn, provider_id)?;
				Ok((models, ProviderInstanceDto::from(&row)))
			})
		})
		.await
	}

	async fn failure_sync_result(
		&self,
		provider_id: Uuid,
		error_code: &str,
		message: &str,
	) -> Result<SyncModelsResult, StorageError> {
		let (models, provider) = self.read_models_and_provider(provider_id).await?;
		Ok(SyncModelsResult {
			ok: false,
			error_code: Some(error_code.into()),
			message: message.into(),
			models,
			provider,
		})
	}
}

async fn spawn_blocking_storage<T, F>(f: F) -> Result<T, StorageError>
where
	T: Send + 'static,
	F: FnOnce() -> Result<T, StorageError> + Send + 'static,
{
	match tauri::async_runtime::spawn_blocking(f).await {
		Ok(result) => result,
		Err(_) => Err(StorageError::Internal("task join failed".into())),
	}
}

fn resolve_saved_provider(
	db: &Database,
	vault: &dyn CredentialVault,
	provider_id: Uuid,
) -> Result<ResolveOutcome, StorageError> {
	let provider: ProviderInstance = db.read(|conn| provider_instances::get(conn, provider_id))?;
	let connection = ConnectionIdentity::from_provider(&provider);
	let provider_updated_at = provider.updated_at.clone();
	let base_url = resolve_base_url(&provider)?;
	let secret = match load_secret_if_needed(vault, &provider)? {
		SecretLoad::Ready(secret) => secret,
		SecretLoad::Missing => {
			return Ok(ResolveOutcome::MissingCredential {
				connection,
				provider_updated_at,
			});
		}
		SecretLoad::StoreFailure => {
			return Ok(ResolveOutcome::CredentialStoreFailure {
				connection,
				provider_updated_at,
			});
		}
	};

	Ok(ResolveOutcome::Ready {
		request: ModelListRequest {
			adapter_id: provider.adapter_id,
			base_url,
			credential_kind: provider.credential_kind,
			secret,
			proxy_mode: provider.proxy_mode,
		},
		connection,
		provider_updated_at,
	})
}

fn resolve_base_url(provider: &ProviderInstance) -> Result<String, StorageError> {
	if let Some(override_url) = provider
		.base_url_override
		.as_ref()
		.map(|s| s.trim())
		.filter(|s| !s.is_empty())
	{
		return Ok(override_url.to_string());
	}
	let meta = catalog::get(&provider.adapter_id)?;
	meta
		.default_base_url
		.map(|s| s.to_string())
		.ok_or_else(|| StorageError::Validation("base URL is required for this adapter".into()))
}

enum SecretLoad {
	Ready(Option<String>),
	Missing,
	StoreFailure,
}

fn load_secret_if_needed(vault: &dyn CredentialVault, provider: &ProviderInstance) -> Result<SecretLoad, StorageError> {
	let required = secret_required(&provider.adapter_id, provider.credential_kind);
	if !required {
		return Ok(SecretLoad::Ready(None));
	}
	let Some(credential_ref) = provider.credential_ref.as_ref() else {
		return Ok(SecretLoad::Missing);
	};
	match vault.get_for_backend_use(credential_ref) {
		Ok(secret) => Ok(SecretLoad::Ready(Some(secret))),
		Err(StorageError::NotFound(_)) => Ok(SecretLoad::Missing),
		Err(StorageError::CredentialUnavailable) | Err(StorageError::CredentialAccess) => Ok(SecretLoad::StoreFailure),
		Err(other) => Err(other),
	}
}

fn secret_required(adapter_id: &str, credential_kind: CredentialKind) -> bool {
	match adapter_id {
		"openai-compatible" | "openai-responses" => {
			matches!(credential_kind, CredentialKind::ApiKey | CredentialKind::Bearer)
		}
		// Anthropic and Gemini require a stored secret for their model-list endpoints.
		"anthropic" | "gemini" => true,
		_ => true,
	}
}

fn validate_manual_model(input: &ManualModelWrite) -> Result<(), StorageError> {
	let key = input.model_key.trim();
	if key.is_empty() {
		return Err(StorageError::Validation("model_key must not be empty".into()));
	}
	if key.len() > MAX_MODEL_KEY_LEN {
		return Err(StorageError::Validation(format!(
			"model_key must be at most {MAX_MODEL_KEY_LEN} characters"
		)));
	}
	Ok(())
}

/// Validate codes that may be persisted on `models_sync_error_code`.
/// Does not accept non-persisted result codes such as `connection_changed`.
pub fn validate_sync_error_code(code: &str) -> Result<(), StorageError> {
	match code {
		"auth" | "rate_limited" | "network" | "timeout" | "server" | "invalid_response" | "credential_unavailable" => {
			Ok(())
		}
		other => Err(StorageError::Validation(format!(
			"invalid models_sync_error_code: {other}"
		))),
	}
}
