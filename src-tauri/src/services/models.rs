// ABOUTME: Manual model CRUD, remote-cache merge, connection/sync, and translate orchestration.
// ABOUTME: Vault and transport work run via spawn_blocking / async reqwest without exposing secrets.
use crate::adapters::catalog;
use crate::adapters::transport::{
	chat_completion_http_cancellable, chat_completion_stream_http_cancellable, ChatCompletionRequest, ModelListRequest,
	ModelTransport, TransportError,
};
use crate::credentials::CredentialVault;
use crate::domain::cancel::CancelToken;
use crate::domain::model::{
	Availability, CapabilityOverridesV1, ConnectionTestResult, ManualModelWrite, ModelConfigWrite, ModelSource,
	ProviderModel, ProviderModelDto, RemoteModelSyncItem, SyncModelsResult,
};
use crate::domain::provider::{CredentialKind, ModelsSyncStatus, ProviderInstance, ProviderInstanceDto, ProxyMode};
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation::{
	TranslateInput, TranslateResult, TranslateStreamChunk, TranslateStreamDone, TranslateStreamReset,
	TRANSLATE_CHUNK_EVENT, TRANSLATE_DONE_EVENT, TRANSLATE_RESET_EVENT,
};
use crate::domain::translation_profile::TranslationProfile;
use crate::error::StorageError;
use crate::repositories::{provider_instances, provider_models, translation_profiles};
use crate::services::translation_profiles::render_template;
use crate::storage::Database;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

type DeltaCallback<'a> = Option<&'a mut (dyn FnMut(&str) + Send)>;
type ResetCallback<'a> = Option<&'a mut (dyn FnMut(Uuid) + Send)>;

/// Soft cap on source text accepted by the translate command (matches UI max).
const MAX_TRANSLATE_SOURCE_CHARS: usize = 5000;
/// Default max output tokens for a single translation completion.
const DEFAULT_TRANSLATE_MAX_TOKENS: u32 = 4096;
/// Low temperature keeps translations more deterministic.
const DEFAULT_TRANSLATE_TEMPERATURE: f64 = 0.2;

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

	/// List every stored provider model (all channels). Used by the translate model picker.
	pub fn list_all(&self) -> Result<Vec<ProviderModelDto>, StorageError> {
		self.db.read(|conn| provider_models::list_all(conn))
	}

	pub fn save_manual(&self, input: ManualModelWrite) -> Result<ProviderModelDto, StorageError> {
		validate_manual_model(&input)?;
		let capability_overrides_json = CapabilityOverridesV1::from_json(&input.capability_overrides_json)?
			.map(|v| serde_json::to_value(v).expect("capability overrides serialize"));
		let adapter_id = normalize_model_adapter_id(&input.adapter_id)?;
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
						adapter_id,
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
					existing.adapter_id = adapter_id;
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

	/// Set optional per-model API Type override for any model source.
	/// Pass `None` (or empty) so runtime inherits the channel adapter.
	pub fn set_adapter_id(&self, id: Uuid, adapter_id: Option<String>) -> Result<ProviderModelDto, StorageError> {
		let adapter_id = normalize_model_adapter_id(&adapter_id)?;
		let now = now_rfc3339();
		self.db.transaction(|uow| {
			provider_models::set_adapter_id(uow.conn(), id, adapter_id.as_deref(), &now)?;
			provider_models::get(uow.conn(), id)
		})
	}

	/// Update display name, API Type, and capability overrides for any model source.
	pub fn update_config(&self, input: ModelConfigWrite) -> Result<ProviderModelDto, StorageError> {
		let display_name_override = normalize_display_name_override(input.display_name_override)?;
		let capability_overrides_json = CapabilityOverridesV1::from_json(&input.capability_overrides_json)?
			.map(|v| serde_json::to_value(v).expect("capability overrides serialize"));
		let adapter_id = normalize_model_adapter_id(&input.adapter_id)?;
		let now = now_rfc3339();
		self.db.transaction(|uow| {
			let mut existing = provider_models::get(uow.conn(), input.id)?;
			existing.display_name_override = display_name_override;
			existing.adapter_id = adapter_id;
			existing.capability_overrides_json = capability_overrides_json;
			existing.updated_at = now;
			provider_models::update(uow.conn(), &existing)?;
			Ok(existing)
		})
	}

	pub fn delete(&self, id: Uuid) -> Result<(), StorageError> {
		self.db.transaction(|uow| provider_models::delete(uow.conn(), id))
	}

	/// Delete many models in one transaction (all-or-nothing).
	///
	/// Input contract:
	/// - Empty list → success with `0` (no-op).
	/// - Duplicate ids are collapsed so the same id is deleted once.
	/// - Any missing or FK-restricted id aborts the whole transaction (nothing deleted).
	///
	/// Returns the number of unique ids deleted on success.
	pub fn delete_many(&self, ids: Vec<Uuid>) -> Result<usize, StorageError> {
		let mut seen = std::collections::HashSet::new();
		let unique: Vec<Uuid> = ids.into_iter().filter(|id| seen.insert(*id)).collect();
		if unique.is_empty() {
			return Ok(0);
		}
		self.db.transaction(|uow| {
			for id in &unique {
				provider_models::delete(uow.conn(), *id)?;
			}
			Ok(unique.len())
		})
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

	/// Translate `input.text` with a configured model via non-streaming chat completion.
	///
	/// When `profile_id` is set, applies profile templates and walks the fallback model chain
	/// after the primary `model_id`. Does not persist source, prompt, or response content.
	pub async fn translate(
		&self,
		input: TranslateInput,
		cancel: Option<&CancelToken>,
	) -> Result<TranslateResult, StorageError> {
		if cancel.is_some_and(|t| t.is_cancelled()) {
			return Ok(TranslateResult::cancelled(0));
		}
		let prepared = self.prepare_translate(input).await?;
		match prepared {
			TranslatePrepare::Early(result) => Ok(result),
			TranslatePrepare::Ready { attempts } => self.run_translate_attempts(attempts, false, None, None, cancel).await,
		}
	}

	/// Stream a translation: emits chunk/done/reset events on `app` for `request_id`.
	pub async fn translate_stream<R: Runtime>(
		&self,
		app: AppHandle<R>,
		request_id: String,
		input: TranslateInput,
		cancel: Option<&CancelToken>,
	) -> Result<(), StorageError> {
		if cancel.is_some_and(|t| t.is_cancelled()) {
			let _ = app.emit(
				TRANSLATE_DONE_EVENT,
				TranslateStreamDone::from_result(request_id, TranslateResult::cancelled(0)),
			);
			return Ok(());
		}
		let prepared = self.prepare_translate(input).await?;
		match prepared {
			TranslatePrepare::Early(result) => {
				let _ = app.emit(
					TRANSLATE_DONE_EVENT,
					TranslateStreamDone::from_result(request_id, result),
				);
				Ok(())
			}
			TranslatePrepare::Ready { attempts } => {
				let app_chunk = app.clone();
				let rid = request_id.clone();
				let mut on_delta = move |delta: &str| {
					let _ = app_chunk.emit(
						TRANSLATE_CHUNK_EVENT,
						TranslateStreamChunk {
							id: rid.clone(),
							delta: delta.to_string(),
						},
					);
				};
				let app_reset = app.clone();
				let rid_reset = request_id.clone();
				let mut on_reset = move |model_id: Uuid| {
					let _ = app_reset.emit(
						TRANSLATE_RESET_EVENT,
						TranslateStreamReset {
							id: rid_reset.clone(),
							model_id,
						},
					);
				};
				let result = self
					.run_translate_attempts(attempts, true, Some(&mut on_delta), Some(&mut on_reset), cancel)
					.await?;
				// Soft failures after all attempts still use done with ok=false so the UI
				// can treat them like non-stream TranslateResult failures.
				let _ = app.emit(
					TRANSLATE_DONE_EVENT,
					TranslateStreamDone::from_result(request_id, result),
				);
				Ok(())
			}
		}
	}

	async fn prepare_translate(&self, input: TranslateInput) -> Result<TranslatePrepare, StorageError> {
		let db = self.db.clone();
		let vault = self.vault.clone();
		spawn_blocking_storage(move || prepare_translate_sync(&db, vault.as_ref(), input)).await
	}

	/// Run chat completion for each prepared attempt until one succeeds.
	///
	/// On stream + fallback: emits `on_reset(next_model_id)` before the next attempt so the
	/// UI clears partial text from the failed model. Cancellation never walks the chain.
	async fn run_translate_attempts(
		&self,
		attempts: Vec<TranslateAttempt>,
		stream: bool,
		mut on_delta: DeltaCallback<'_>,
		mut on_reset: ResetCallback<'_>,
		cancel: Option<&CancelToken>,
	) -> Result<TranslateResult, StorageError> {
		let started = Instant::now();
		let mut last_failure: Option<TranslateResult> = None;
		let total = attempts.len();
		// Snapshot model ids so fallback reset can name the next model after into_iter.
		let model_ids: Vec<Uuid> = attempts.iter().map(|a| a.model_id).collect();

		for (index, attempt) in attempts.into_iter().enumerate() {
			if cancel.is_some_and(|t| t.is_cancelled()) {
				let latency_ms = started.elapsed().as_millis() as u64;
				return Ok(TranslateResult::cancelled(latency_ms));
			}

			let model_id = attempt.model_id;
			let request = attempt.request;
			let outcome = if stream {
				// Emit progressive deltas when a callback is provided.
				chat_completion_stream_http_cancellable(
					request,
					|delta| {
						if let Some(cb) = on_delta.as_mut() {
							cb(delta);
						}
					},
					cancel,
				)
				.await
			} else {
				chat_completion_http_cancellable(request, cancel).await
			};

			match outcome {
				Ok(completion) => {
					let latency_ms = started.elapsed().as_millis() as u64;
					return Ok(TranslateResult::success_with_model(
						completion.content,
						latency_ms,
						model_id,
					));
				}
				Err(TransportError::Cancelled) => {
					let latency_ms = started.elapsed().as_millis() as u64;
					return Ok(TranslateResult::cancelled(latency_ms));
				}
				Err(err) => {
					let latency_ms = started.elapsed().as_millis() as u64;
					last_failure = Some(TranslateResult::failure(err.code(), err.to_string(), latency_ms));
					// Prefer next fallback model when available.
					if index + 1 < total {
						// Reset progressive UI before the next model emits chunks.
						if stream {
							if let Some(cb) = on_reset.as_mut() {
								cb(model_ids[index + 1]);
							}
						}
						continue;
					}
				}
			}
		}

		Ok(
			last_failure
				.unwrap_or_else(|| TranslateResult::failure("invalid_response", "No translation attempts were prepared", 0)),
		)
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

enum TranslatePrepare {
	/// Soft validation / credential failure returned as a typed result (not IpcError).
	Early(TranslateResult),
	Ready {
		attempts: Vec<TranslateAttempt>,
	},
}

struct TranslateAttempt {
	model_id: Uuid,
	request: ChatCompletionRequest,
}

fn prepare_translate_sync(
	db: &Database,
	vault: &dyn CredentialVault,
	input: TranslateInput,
) -> Result<TranslatePrepare, StorageError> {
	let text = input.text.trim();
	if text.is_empty() {
		return Ok(TranslatePrepare::Early(TranslateResult::failure(
			"validation_failed",
			"Source text must not be empty",
			0,
		)));
	}
	if text.chars().count() > MAX_TRANSLATE_SOURCE_CHARS {
		return Ok(TranslatePrepare::Early(TranslateResult::failure(
			"validation_failed",
			format!("Source text must be at most {MAX_TRANSLATE_SOURCE_CHARS} characters"),
			0,
		)));
	}
	let source_lang = input.source_lang.trim();
	let target_lang = input.target_lang.trim();
	if source_lang.is_empty() || target_lang.is_empty() {
		return Ok(TranslatePrepare::Early(TranslateResult::failure(
			"validation_failed",
			"Source and target languages are required",
			0,
		)));
	}

	// Optional profile: templates + ordered fallback targets after the primary model.
	let profile: Option<TranslationProfile> = if let Some(profile_id) = input.profile_id {
		match db.read(|conn| translation_profiles::get(conn, profile_id)) {
			Ok(dto) => {
				if !dto.profile.enabled {
					return Ok(TranslatePrepare::Early(TranslateResult::failure(
						"validation_failed",
						"Selected translation profile is disabled",
						0,
					)));
				}
				Some(dto.profile)
			}
			Err(StorageError::NotFound(_)) => {
				return Ok(TranslatePrepare::Early(TranslateResult::failure(
					"validation_failed",
					"Selected translation profile was not found",
					0,
				)));
			}
			Err(e) => return Err(e),
		}
	} else {
		None
	};

	let (system_prompt, user_prompt, temperature, profile_max_tokens) = if let Some(ref profile) = profile {
		let system_prompt = render_template(&profile.system_template, source_lang, target_lang, text);
		let user_prompt = render_template(&profile.user_template, source_lang, target_lang, text);
		let temperature = profile.temperature.or(Some(DEFAULT_TRANSLATE_TEMPERATURE));
		let profile_max_tokens = profile.max_output_tokens.map(|n| n as u32);
		(system_prompt, user_prompt, temperature, profile_max_tokens)
	} else {
		(
			build_translate_system_prompt(source_lang, target_lang),
			text.to_string(),
			Some(DEFAULT_TRANSLATE_TEMPERATURE),
			None,
		)
	};

	// Model chain: primary selection first, then remaining profile targets (unique).
	let mut model_ids: Vec<Uuid> = vec![input.model_id];
	if let Some(profile_id) = input.profile_id {
		let targets = db.read(|conn| translation_profiles::list_targets(conn, profile_id))?;
		for target in targets {
			if !model_ids.contains(&target.provider_model_id) {
				model_ids.push(target.provider_model_id);
			}
		}
	}

	let mut attempts = Vec::new();
	let mut last_credential_failure: Option<TranslateResult> = None;

	for model_id in model_ids {
		let prepared = prepare_single_model_attempt(
			db,
			vault,
			model_id,
			system_prompt.clone(),
			user_prompt.clone(),
			temperature,
			profile_max_tokens,
		)?;
		match prepared {
			SingleModelPrepare::Skipped => continue,
			SingleModelPrepare::Credential(result) => {
				last_credential_failure = Some(result);
			}
			SingleModelPrepare::Ready(attempt) => {
				attempts.push(attempt);
			}
		}
	}

	if attempts.is_empty() {
		return Ok(TranslatePrepare::Early(last_credential_failure.unwrap_or_else(|| {
			TranslateResult::failure("validation_failed", "No enabled models available for translation", 0)
		})));
	}

	Ok(TranslatePrepare::Ready { attempts })
}

enum SingleModelPrepare {
	/// Model disabled / missing / provider disabled — try next.
	Skipped,
	Credential(TranslateResult),
	Ready(TranslateAttempt),
}

fn prepare_single_model_attempt(
	db: &Database,
	vault: &dyn CredentialVault,
	model_id: Uuid,
	system_prompt: String,
	user_prompt: String,
	temperature: Option<f64>,
	profile_max_tokens: Option<u32>,
) -> Result<SingleModelPrepare, StorageError> {
	// Final adapter first: model override wins, then channel. Endpoint defaults and
	// secret_required follow that adapter so transport fields stay consistent.
	match resolve_model_chat_transport(db, vault, model_id)? {
		ModelChatResolve::Skipped => Ok(SingleModelPrepare::Skipped),
		ModelChatResolve::MissingCredential => Ok(SingleModelPrepare::Credential(TranslateResult::failure(
			"auth",
			"Authentication failed",
			0,
		))),
		ModelChatResolve::CredentialStoreFailure => Ok(SingleModelPrepare::Credential(TranslateResult::failure(
			"credential_unavailable",
			"Credential store unavailable",
			0,
		))),
		ModelChatResolve::Ready {
			config,
			model_key,
			model_default_output_tokens,
		} => Ok(SingleModelPrepare::Ready(TranslateAttempt {
			model_id,
			request: ChatCompletionRequest {
				adapter_id: config.adapter_id,
				base_url: config.base_url,
				credential_kind: config.credential_kind,
				secret: config.secret,
				proxy_mode: config.proxy_mode,
				model_key,
				system_prompt,
				user_prompt,
				temperature,
				max_tokens: Some(resolve_translate_max_tokens(
					profile_max_tokens,
					model_default_output_tokens,
				)),
			},
		})),
	}
}

/// Resolved chat/translate transport fields for one model (adapter + endpoint + auth).
#[derive(Debug, Clone)]
pub(crate) struct ModelChatTransportConfig {
	pub adapter_id: String,
	pub base_url: String,
	pub credential_kind: CredentialKind,
	pub secret: Option<String>,
	pub proxy_mode: ProxyMode,
}

/// Outcome of resolving a single model's chat transport (no prompts).
#[derive(Debug, Clone)]
pub(crate) enum ModelChatResolve {
	/// Model missing / disabled / provider disabled / availability missing.
	Skipped,
	MissingCredential,
	CredentialStoreFailure,
	Ready {
		config: ModelChatTransportConfig,
		model_key: String,
		model_default_output_tokens: Option<u32>,
	},
}

/// Resolve final adapter, base URL, and credentials for a single-model chat request.
///
/// Non-empty model `adapter_id` wins over the channel adapter for adapter identity,
/// default base URL, and `secret_required`. Explicit channel `base_url_override`,
/// credential kind/ref, and proxy stay on the channel row.
///
/// Shared by stream and non-stream translate prep. Channel sync/test-connection keep
/// using [`resolve_saved_provider`] (channel adapter only).
pub(crate) fn resolve_model_chat_transport(
	db: &Database,
	vault: &dyn CredentialVault,
	model_id: Uuid,
) -> Result<ModelChatResolve, StorageError> {
	let (model, provider) = match db.read_snapshot(|conn| {
		let model = match provider_models::get(conn, model_id) {
			Ok(m) => m,
			Err(StorageError::NotFound(_)) => {
				return Ok(None);
			}
			Err(e) => return Err(e),
		};
		let provider = provider_instances::get(conn, model.provider_instance_id)?;
		Ok(Some((model, provider)))
	})? {
		Some(pair) => pair,
		None => return Ok(ModelChatResolve::Skipped),
	};

	if !model.enabled || !provider.enabled || model.availability == Availability::Missing {
		return Ok(ModelChatResolve::Skipped);
	}

	let adapter_id = resolve_model_adapter_id(model.adapter_id.as_deref(), &provider.adapter_id);
	// Prefer explicit request default, then Max Tokens (max_output_tokens). Profile still wins at resolve time.
	let model_default_output_tokens = CapabilityOverridesV1::from_json(&model.capability_overrides_json)?
		.and_then(|capabilities| capabilities.default_output_tokens.or(capabilities.max_output_tokens));
	match resolve_endpoint_and_secret(vault, &provider, &adapter_id)? {
		EndpointSecret::Missing => Ok(ModelChatResolve::MissingCredential),
		EndpointSecret::StoreFailure => Ok(ModelChatResolve::CredentialStoreFailure),
		EndpointSecret::Ready { base_url, secret } => Ok(ModelChatResolve::Ready {
			config: ModelChatTransportConfig {
				adapter_id,
				base_url,
				credential_kind: provider.credential_kind,
				secret,
				proxy_mode: provider.proxy_mode,
			},
			model_key: model.model_key,
			model_default_output_tokens,
		}),
	}
}

/// Resolve request output tokens with profile > model > application-default precedence.
pub(crate) fn resolve_translate_max_tokens(profile_value: Option<u32>, model_value: Option<u32>) -> u32 {
	profile_value.or(model_value).unwrap_or(DEFAULT_TRANSLATE_MAX_TOKENS)
}

/// Prefer a non-empty model adapter override; otherwise use the channel default.
pub(crate) fn resolve_model_adapter_id(model_adapter_id: Option<&str>, channel_adapter_id: &str) -> String {
	model_adapter_id
		.map(str::trim)
		.filter(|s| !s.is_empty())
		.map(|s| s.to_string())
		.unwrap_or_else(|| channel_adapter_id.to_string())
}

/// Normalize and validate an optional model adapter_id against the built-in catalog.
fn normalize_model_adapter_id(adapter_id: &Option<String>) -> Result<Option<String>, StorageError> {
	match adapter_id {
		None => Ok(None),
		Some(value) => {
			let trimmed = value.trim();
			if trimmed.is_empty() {
				return Ok(None);
			}
			catalog::get(trimmed)?;
			Ok(Some(trimmed.to_string()))
		}
	}
}

/// System prompt for translation. Instructs the model to output only the translation.
fn build_translate_system_prompt(source_lang: &str, target_lang: &str) -> String {
	format!(
		"You are a professional translation engine. Translate the user's text from {source_lang} to {target_lang}.\n\
		Rules:\n\
		- Output only the translated text, with no preface, labels, quotes, or explanations.\n\
		- Preserve meaning, tone, and formatting (line breaks, lists, punctuation) when possible.\n\
		- If the source is already in the target language, return it unchanged.\n\
		- Do not invent content that is not present in the source."
	)
}

fn resolve_saved_provider(
	db: &Database,
	vault: &dyn CredentialVault,
	provider_id: Uuid,
) -> Result<ResolveOutcome, StorageError> {
	// Channel-level paths (model sync, test connection): always use the channel adapter.
	// There is no specific model context here.
	let provider: ProviderInstance = db.read(|conn| provider_instances::get(conn, provider_id))?;
	let connection = ConnectionIdentity::from_provider(&provider);
	let provider_updated_at = provider.updated_at.clone();
	let adapter_id = provider.adapter_id.clone();
	match resolve_endpoint_and_secret(vault, &provider, &adapter_id)? {
		EndpointSecret::Missing => Ok(ResolveOutcome::MissingCredential {
			connection,
			provider_updated_at,
		}),
		EndpointSecret::StoreFailure => Ok(ResolveOutcome::CredentialStoreFailure {
			connection,
			provider_updated_at,
		}),
		EndpointSecret::Ready { base_url, secret } => Ok(ResolveOutcome::Ready {
			request: ModelListRequest {
				adapter_id,
				base_url,
				credential_kind: provider.credential_kind,
				secret,
				proxy_mode: provider.proxy_mode,
			},
			connection,
			provider_updated_at,
		}),
	}
}

/// Endpoint + secret resolution for a concrete adapter id.
///
/// Uses channel `base_url_override` / credential kind+ref / proxy when present;
/// default base URL and secret requirement come from `adapter_id`.
enum EndpointSecret {
	Ready { base_url: String, secret: Option<String> },
	Missing,
	StoreFailure,
}

fn resolve_endpoint_and_secret(
	vault: &dyn CredentialVault,
	provider: &ProviderInstance,
	adapter_id: &str,
) -> Result<EndpointSecret, StorageError> {
	let base_url = resolve_base_url(provider, adapter_id)?;
	match load_secret_if_needed(vault, provider, adapter_id)? {
		SecretLoad::Ready(secret) => Ok(EndpointSecret::Ready { base_url, secret }),
		SecretLoad::Missing => Ok(EndpointSecret::Missing),
		SecretLoad::StoreFailure => Ok(EndpointSecret::StoreFailure),
	}
}

fn resolve_base_url(provider: &ProviderInstance, adapter_id: &str) -> Result<String, StorageError> {
	if let Some(override_url) = provider
		.base_url_override
		.as_ref()
		.map(|s| s.trim())
		.filter(|s| !s.is_empty())
	{
		return Ok(override_url.to_string());
	}
	let meta = catalog::get(adapter_id)?;
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

fn load_secret_if_needed(
	vault: &dyn CredentialVault,
	provider: &ProviderInstance,
	adapter_id: &str,
) -> Result<SecretLoad, StorageError> {
	let required = secret_required(adapter_id, provider.credential_kind);
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

const MAX_DISPLAY_NAME_OVERRIDE_LEN: usize = 200;

/// Trim display-name override; empty/whitespace becomes None. Rejects overlong values.
fn normalize_display_name_override(value: Option<String>) -> Result<Option<String>, StorageError> {
	let Some(raw) = value else {
		return Ok(None);
	};
	let trimmed = raw.trim();
	if trimmed.is_empty() {
		return Ok(None);
	}
	if trimmed.len() > MAX_DISPLAY_NAME_OVERRIDE_LEN {
		return Err(StorageError::Validation(format!(
			"display_name_override must be at most {MAX_DISPLAY_NAME_OVERRIDE_LEN} characters"
		)));
	}
	Ok(Some(trimmed.to_string()))
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
