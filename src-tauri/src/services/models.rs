// ABOUTME: Manual model CRUD and pure remote-cache merge algorithm.
// ABOUTME: A future Provider adapter calls apply_remote_merge after fetching models.
use crate::domain::model::{
	Availability, CapabilityOverridesV1, ManualModelWrite, ModelSource, ProviderModel, ProviderModelDto,
	RemoteModelSyncItem,
};
use crate::domain::provider::ModelsSyncStatus;
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{provider_instances, provider_models};
use crate::storage::Database;
use uuid::Uuid;

const MAX_MODEL_KEY_LEN: usize = 256;

#[derive(Clone)]
pub struct ModelService {
	db: Database,
}

impl ModelService {
	pub fn new(db: Database) -> Self {
		Self { db }
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
	pub fn apply_remote_merge(
		&self,
		provider_id: Uuid,
		remote_models: &[RemoteModelSyncItem],
	) -> Result<(), StorageError> {
		let seen_at = now_rfc3339();
		self.db.transaction(|uow| {
			provider_instances::get(uow.conn(), provider_id)?;
			provider_models::apply_remote_sync(uow.conn(), provider_id, remote_models, &seen_at)?;
			provider_instances::update_sync_status(
				uow.conn(),
				provider_id,
				Some(&seen_at),
				ModelsSyncStatus::Ok,
				None,
				&seen_at,
			)?;
			Ok(())
		})
	}

	/// Record a bounded sync failure without mutating model rows or clearing last success time.
	pub fn record_sync_error(&self, provider_id: Uuid, error_code: &str) -> Result<(), StorageError> {
		validate_sync_error_code(error_code)?;
		let now = now_rfc3339();
		self.db.transaction(|uow| {
			provider_instances::update_sync_failure(uow.conn(), provider_id, ModelsSyncStatus::Error, Some(error_code), &now)
		})
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

pub fn validate_sync_error_code(code: &str) -> Result<(), StorageError> {
	match code {
		"auth" | "rate_limited" | "network" | "timeout" | "server" | "invalid_response" => Ok(()),
		other => Err(StorageError::Validation(format!(
			"invalid models_sync_error_code: {other}"
		))),
	}
}
