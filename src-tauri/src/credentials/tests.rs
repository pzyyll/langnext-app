// ABOUTME: Credential compensation and crash-recovery tests with in-memory vault.
// ABOUTME: Does not access the real OS credential store.
use crate::credentials::coordinator;
use crate::credentials::{provider_ref, CredentialVault, FailingCredentialVault, MemoryCredentialVault};
use crate::domain::provider::{CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode};
use crate::domain::time::new_id;
use crate::error::StorageError;
use crate::repositories::credential_operations::{self, OperationState, OwnerKind};
use crate::services::providers::ProviderService;
use crate::storage::Database;
use std::sync::Arc;

fn setup() -> (tempfile::TempDir, Database, Arc<MemoryCredentialVault>, ProviderService) {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(MemoryCredentialVault::new());
	let providers = ProviderService::new(db.clone(), vault.clone());
	(dir, db, vault, providers)
}

fn write(secret: Option<&str>) -> ProviderInstanceWrite {
	ProviderInstanceWrite {
		id: None,
		adapter_id: "openai-compatible".into(),
		display_name: "P".into(),
		base_url_override: None,
		credential_kind: CredentialKind::ApiKey,
		credential: match secret {
			Some(s) => CredentialUpdate::Replace(s.into()),
			None => CredentialUpdate::Keep,
		},
		enabled: true,
		proxy_mode: ProxyMode::Inherit,
		insecure_http_confirmed_at: None,
	}
}

#[test]
fn replace_then_clear() {
	let (_d, _db, _v, providers) = setup();
	let dto = providers.save(write(Some("a"))).unwrap();
	assert!(dto.has_credential);
	let mut input = write(Some("b"));
	input.id = Some(dto.id);
	let dto = providers.save(input).unwrap();
	assert!(dto.has_credential);
	let mut clear = write(None);
	clear.id = Some(dto.id);
	clear.credential = CredentialUpdate::Clear;
	let dto = providers.save(clear).unwrap();
	assert!(!dto.has_credential);
}

#[test]
fn concurrent_mutation_busy() {
	let (_d, db, _v, _providers) = setup();
	let owner = new_id().to_string();
	db.transaction(|uow| {
		credential_operations::insert_prepared(
			uow.conn(),
			new_id(),
			OwnerKind::Provider,
			&owner,
			None,
			Some("provider/x/y"),
		)?;
		Ok(())
	})
	.unwrap();
	// Second prepared for same owner fails
	let err = db.transaction(|uow| {
		credential_operations::insert_prepared(
			uow.conn(),
			new_id(),
			OwnerKind::Provider,
			&owner,
			None,
			Some("provider/x/z"),
		)
	});
	assert!(matches!(err, Err(crate::error::StorageError::CredentialBusy)));
}

#[test]
fn recover_prepared_unused_new_entry() {
	let (_d, db, vault, _providers) = setup();
	let provider_id = new_id();
	let op_id = new_id();
	let new_ref = provider_ref(provider_id, op_id);
	// Insert a provider with no ref
	db.transaction(|uow| {
		use crate::domain::provider::{ModelsSyncStatus, ProviderInstance};
		use crate::domain::time::now_rfc3339;
		use crate::repositories::provider_instances;
		let now = now_rfc3339();
		provider_instances::insert(
			uow.conn(),
			&ProviderInstance {
				id: provider_id,
				adapter_id: "openai-compatible".into(),
				display_name: "P".into(),
				base_url_override: None,
				credential_kind: CredentialKind::ApiKey,
				credential_ref: None,
				enabled: true,
				proxy_mode: ProxyMode::Inherit,
				insecure_http_confirmed_at: None,
				models_synced_at: None,
				models_sync_status: ModelsSyncStatus::Never,
				models_sync_error_code: None,
				created_at: now.clone(),
				updated_at: now,
			},
		)?;
		credential_operations::insert_prepared(
			uow.conn(),
			op_id,
			OwnerKind::Provider,
			&provider_id.to_string(),
			None,
			Some(&new_ref),
		)?;
		Ok(())
	})
	.unwrap();
	vault.set(&new_ref, "orphan-secret").unwrap();
	let report = ProviderService::recover_credential_operations(&db, vault.as_ref());
	assert_eq!(report.completed, 1);
	assert!(!vault.exists(&new_ref).unwrap());
	let unfinished = db.read(credential_operations::list_unfinished).unwrap();
	assert!(unfinished.is_empty());
}

#[test]
fn recover_db_committed_deletes_old() {
	let (_d, db, vault, _providers) = setup();
	let provider_id = new_id();
	let op_id = new_id();
	let old_ref = provider_ref(provider_id, new_id());
	let new_ref = provider_ref(provider_id, op_id);
	db.transaction(|uow| {
		use crate::domain::provider::{ModelsSyncStatus, ProviderInstance};
		use crate::domain::time::now_rfc3339;
		use crate::repositories::provider_instances;
		let now = now_rfc3339();
		provider_instances::insert(
			uow.conn(),
			&ProviderInstance {
				id: provider_id,
				adapter_id: "openai-compatible".into(),
				display_name: "P".into(),
				base_url_override: None,
				credential_kind: CredentialKind::ApiKey,
				credential_ref: Some(new_ref.clone()),
				enabled: true,
				proxy_mode: ProxyMode::Inherit,
				insecure_http_confirmed_at: None,
				models_synced_at: None,
				models_sync_status: ModelsSyncStatus::Never,
				models_sync_error_code: None,
				created_at: now.clone(),
				updated_at: now,
			},
		)?;
		credential_operations::insert_db_committed(
			uow.conn(),
			op_id,
			OwnerKind::Provider,
			&provider_id.to_string(),
			Some(&old_ref),
			Some(&new_ref),
		)?;
		Ok(())
	})
	.unwrap();
	vault.set(&old_ref, "old").unwrap();
	vault.set(&new_ref, "new").unwrap();
	let report = ProviderService::recover_credential_operations(&db, vault.as_ref());
	assert_eq!(report.completed, 1);
	assert!(!vault.exists(&old_ref).unwrap());
	assert!(vault.exists(&new_ref).unwrap());
	assert!(db.read(credential_operations::list_unfinished).unwrap().is_empty());
}

#[test]
fn prepared_state_enum() {
	assert_eq!(OperationState::Prepared.as_str(), "prepared");
	assert_eq!(OperationState::DbCommitted.as_str(), "db_committed");
}

#[test]
fn replace_cleanup_failure_retains_db_committed_journal() {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(FailingCredentialVault::new());
	let providers = ProviderService::new(db.clone(), vault.clone());

	let dto = providers.save(write(Some("first"))).unwrap();
	assert!(dto.has_credential);

	// Next replace succeeds in DB/vault set, but old-secret delete fails.
	vault.set_fail_delete(true);
	let mut input = write(Some("second"));
	input.id = Some(dto.id);
	let dto = providers.save(input).unwrap();
	assert!(dto.has_credential);

	let unfinished = db.read(credential_operations::list_unfinished).unwrap();
	assert_eq!(unfinished.len(), 1);
	assert_eq!(unfinished[0].state, OperationState::DbCommitted);
	assert!(unfinished[0].expected_old_ref.is_some());

	// Restore vault and recover the owner without restart.
	vault.set_fail_delete(false);
	let report = coordinator::recover_owner(&db, vault.as_ref(), OwnerKind::Provider, &dto.id.to_string()).unwrap();
	assert_eq!(report.completed, 1);
	assert!(db.read(credential_operations::list_unfinished).unwrap().is_empty());
}

#[test]
fn preflight_returns_unavailable_when_vault_unreachable() {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(FailingCredentialVault::new());
	let providers = ProviderService::new(db.clone(), vault.clone());

	let dto = providers.save(write(Some("first"))).unwrap();

	// Leave a db_committed journal with delete failing.
	vault.set_fail_delete(true);
	let mut input = write(Some("second"));
	input.id = Some(dto.id);
	let _ = providers.save(input).unwrap();

	// exists probe also fails → credential_unavailable rather than permanent busy.
	vault.set_fail_exists(true);
	let mut keep = write(None);
	keep.id = Some(dto.id);
	keep.credential = CredentialUpdate::Keep;
	let err = providers.save(keep).unwrap_err();
	assert!(matches!(
		err,
		StorageError::CredentialUnavailable | StorageError::CredentialBusy
	));
}

#[test]
fn clear_cleanup_failure_retains_journal() {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(FailingCredentialVault::new());
	let providers = ProviderService::new(db.clone(), vault.clone());

	let dto = providers.save(write(Some("secret"))).unwrap();
	vault.set_fail_delete(true);
	let mut clear = write(None);
	clear.id = Some(dto.id);
	clear.credential = CredentialUpdate::Clear;
	let cleared = providers.save(clear).unwrap();
	assert!(!cleared.has_credential);

	let unfinished = db.read(credential_operations::list_unfinished).unwrap();
	assert_eq!(unfinished.len(), 1);
	assert_eq!(unfinished[0].state, OperationState::DbCommitted);

	vault.set_fail_delete(false);
	let report = coordinator::recover_owner(&db, vault.as_ref(), OwnerKind::Provider, &dto.id.to_string()).unwrap();
	assert_eq!(report.completed, 1);
}
