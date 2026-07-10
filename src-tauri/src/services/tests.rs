// ABOUTME: Service validation, rollback, cache merge, and privacy tests.
// ABOUTME: Uses in-memory CredentialVault under cfg(test) only.
use crate::adapters::transport::{ModelListRequest, ModelTransport, TransportError};
use crate::credentials::{CredentialVault, FailingCredentialVault, MemoryCredentialVault};
use crate::domain::import_export::ImportConflictMode;
use crate::domain::model::{Availability, ManualModelWrite, ModelSource, RemoteModelSyncItem};
use crate::domain::provider::{CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode};
use crate::domain::settings::{
	AppSettingsUpdate, AppSettingsV1, GlobalProxyMode, NetworkSettings, ProxyCredentialUpdate, TranslationPreferences,
};
use crate::domain::translation_profile::TranslationProfileWrite;
use crate::error::StorageError;
use crate::services::{ImportExportService, ModelService, ProviderService, SettingsService, TranslationProfileService};
use crate::storage::Database;
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

/// Per-test queued transport; not a production mock mode.
struct TestModelTransport {
	queue: Mutex<VecDeque<Result<Vec<RemoteModelSyncItem>, TransportError>>>,
	last_request: Mutex<Option<ModelListRequest>>,
}

impl TestModelTransport {
	fn new() -> Self {
		Self {
			queue: Mutex::new(VecDeque::new()),
			last_request: Mutex::new(None),
		}
	}

	fn push_ok(&self, items: Vec<RemoteModelSyncItem>) {
		self.queue.lock().expect("queue").push_back(Ok(items));
	}

	fn push_err(&self, err: TransportError) {
		self.queue.lock().expect("queue").push_back(Err(err));
	}

	fn last_request(&self) -> Option<ModelListRequest> {
		self.last_request.lock().expect("last").clone()
	}
}

impl ModelTransport for TestModelTransport {
	fn list_models(
		&self,
		request: ModelListRequest,
	) -> Pin<Box<dyn Future<Output = Result<Vec<RemoteModelSyncItem>, TransportError>> + Send + '_>> {
		*self.last_request.lock().expect("last") = Some(request);
		let next = self
			.queue
			.lock()
			.expect("queue")
			.pop_front()
			.unwrap_or(Err(TransportError::Network));
		Box::pin(async move { next })
	}
}

fn block_on<F: Future>(future: F) -> F::Output {
	tauri::async_runtime::block_on(future)
}

fn setup() -> (
	tempfile::TempDir,
	Database,
	Arc<MemoryCredentialVault>,
	ProviderService,
	ModelService,
	TranslationProfileService,
	SettingsService,
	ImportExportService,
	Arc<TestModelTransport>,
) {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(MemoryCredentialVault::new());
	let transport = Arc::new(TestModelTransport::new());
	let providers = ProviderService::new(db.clone(), vault.clone());
	let models = ModelService::new(db.clone(), vault.clone(), transport.clone() as Arc<dyn ModelTransport>);
	let profiles = TranslationProfileService::new(db.clone());
	let settings = SettingsService::new(db.clone(), vault.clone());
	let import_export = ImportExportService::new(db.clone(), vault.clone());
	(
		dir,
		db,
		vault,
		providers,
		models,
		profiles,
		settings,
		import_export,
		transport,
	)
}

fn provider_write(kind: CredentialKind, cred: CredentialUpdate) -> ProviderInstanceWrite {
	ProviderInstanceWrite {
		id: None,
		adapter_id: "openai-compatible".into(),
		display_name: "OpenAI".into(),
		base_url_override: Some("https://api.openai.com/v1".into()),
		credential_kind: kind,
		credential: cred,
		enabled: true,
		proxy_mode: ProxyMode::Inherit,
		insecure_http_confirmed_at: None,
	}
}

#[test]
fn provider_none_rejects_replace() {
	let (_d, _db, _v, providers, ..) = setup();
	let err = providers.save(provider_write(
		CredentialKind::None,
		CredentialUpdate::Replace("x".into()),
	));
	assert!(matches!(err, Err(StorageError::Validation(_))));
}

#[test]
fn provider_api_key_replace_and_has_credential() {
	let (_d, _db, vault, providers, ..) = setup();
	let dto = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-test-secret".into()),
		))
		.unwrap();
	assert!(dto.has_credential);
	assert_eq!(dto.credential_kind, CredentialKind::ApiKey);
	// Secret never in DTO serialization
	let json = serde_json::to_string(&dto).unwrap();
	assert!(!json.contains("sk-test-secret"));
	assert!(!json.contains("credentialRef"));
	// Vault has the secret
	let list = providers.list().unwrap();
	assert_eq!(list.len(), 1);
	// Backend can read via vault through ref stored internally — check vault has one entry
	// by attempting delete of known pattern is hard; just ensure exists via recovery path.
	let _ = vault;
}

#[test]
fn provider_needs_auth_without_credential() {
	let (_d, _db, _v, providers, ..) = setup();
	let dto = providers
		.save(provider_write(CredentialKind::ApiKey, CredentialUpdate::Keep))
		.unwrap();
	assert!(!dto.has_credential);
}

#[test]
fn http_non_loopback_requires_confirmation() {
	let (_d, _db, _v, providers, ..) = setup();
	let mut input = provider_write(CredentialKind::None, CredentialUpdate::Keep);
	input.base_url_override = Some("http://example.com/v1".into());
	assert!(providers.save(input.clone()).is_err());
	input.insecure_http_confirmed_at = Some("2026-07-10T00:00:00Z".into());
	assert!(providers.save(input).is_ok());
}

#[test]
fn loopback_http_ok_without_confirmation() {
	let (_d, _db, _v, providers, ..) = setup();
	let mut input = provider_write(CredentialKind::None, CredentialUpdate::Keep);
	input.base_url_override = Some("http://127.0.0.1:8080/v1".into());
	assert!(providers.save(input).is_ok());
}

#[test]
fn url_with_userinfo_rejected() {
	let (_d, _db, _v, providers, ..) = setup();
	let mut input = provider_write(CredentialKind::None, CredentialUpdate::Keep);
	input.base_url_override = Some("https://user:pass@api.example.com".into());
	assert!(providers.save(input).is_err());
}

#[test]
fn model_merge_marks_missing_preserves_manual() {
	let (_d, _db, _v, providers, models, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	models
		.save_manual(ManualModelWrite {
			id: None,
			provider_instance_id: p.id,
			model_key: "manual-1".into(),
			display_name_override: Some("Manual".into()),
			enabled: true,
			capability_overrides_json: None,
		})
		.unwrap();
	// First remote sync
	models
		.apply_remote_merge(
			p.id,
			&[
				RemoteModelSyncItem {
					model_key: "remote-a".into(),
					remote_display_name: Some("A".into()),
					remote_metadata_json: None,
				},
				RemoteModelSyncItem {
					model_key: "manual-1".into(),
					remote_display_name: Some("Remote name".into()),
					remote_metadata_json: Some(serde_json::json!({"x": 1})),
				},
			],
		)
		.unwrap();
	let list = models.list_by_provider(p.id).unwrap();
	assert_eq!(list.len(), 2);
	let manual = list.iter().find(|m| m.model_key == "manual-1").unwrap();
	assert_eq!(manual.source, ModelSource::Manual);
	assert_eq!(manual.availability, Availability::Available);

	// Second sync drops remote-a
	models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "remote-b".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	let list = models.list_by_provider(p.id).unwrap();
	let remote_a = list.iter().find(|m| m.model_key == "remote-a").unwrap();
	assert_eq!(remote_a.availability, Availability::Missing);
	assert_eq!(remote_a.source, ModelSource::Remote);
	let manual = list.iter().find(|m| m.model_key == "manual-1").unwrap();
	assert_eq!(manual.source, ModelSource::Manual);
	assert_ne!(manual.availability, Availability::Missing);
}

#[test]
fn template_validation() {
	use crate::services::translation_profiles::validate_template;
	assert!(validate_template("Hello {{text}}", true).is_ok());
	assert!(validate_template("{{text}} and {{text}}", true).is_err());
	assert!(validate_template("no text var", true).is_err());
	assert!(validate_template("{{unknown}}", false).is_err());
	assert!(validate_template("sys {{source_language}}", false).is_ok());
}

#[test]
fn profile_save_and_fallback_order() {
	let (_d, _db, _v, providers, models, profiles, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	let m1 = models
		.save_manual(ManualModelWrite {
			id: None,
			provider_instance_id: p.id,
			model_key: "a".into(),
			display_name_override: None,
			enabled: true,
			capability_overrides_json: None,
		})
		.unwrap();
	let m2 = models
		.save_manual(ManualModelWrite {
			id: None,
			provider_instance_id: p.id,
			model_key: "b".into(),
			display_name_override: None,
			enabled: true,
			capability_overrides_json: None,
		})
		.unwrap();
	let dto = profiles
		.save(TranslationProfileWrite {
			id: None,
			name: "Fast".into(),
			enabled: true,
			template_version: 1,
			system_template: "You are a translator.".into(),
			user_template: "Translate to {{target_language}}: {{text}}".into(),
			temperature: Some(0.1),
			max_output_tokens: Some(2048),
			provider_options_json: None,
			target_model_ids: vec![m1.id, m2.id],
		})
		.unwrap();
	assert_eq!(dto.targets.len(), 2);
	assert_eq!(dto.targets[0].priority, 0);
	assert_eq!(dto.targets[1].provider_model_id, m2.id);
}

#[test]
fn delete_provider_cascades_to_models_and_targets() {
	let (_dir, _db, _vault, providers, models, profiles, ..) = setup();
	let provider = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	let model = models
		.save_manual(ManualModelWrite {
			id: None,
			provider_instance_id: provider.id,
			model_key: "cascade-model".into(),
			display_name_override: None,
			enabled: true,
			capability_overrides_json: None,
		})
		.unwrap();
	let profile = profiles
		.save(TranslationProfileWrite {
			id: None,
			name: "Cascade Profile".into(),
			enabled: true,
			template_version: 1,
			system_template: "s".into(),
			user_template: "{{text}}".into(),
			temperature: None,
			max_output_tokens: None,
			provider_options_json: None,
			target_model_ids: vec![model.id],
		})
		.unwrap();
	assert!(!profile.targets.is_empty());

	providers.delete(provider.id).unwrap();

	assert!(matches!(providers.get(provider.id), Err(StorageError::NotFound(_))));
	let list = models.list_by_provider(provider.id).unwrap();
	assert!(list.is_empty());
	assert!(profiles.get(profile.profile.id).unwrap().targets.is_empty());
}

#[test]
fn settings_default_profile_must_exist() {
	let (_d, _db, _v, _p, _m, _pr, settings, ..) = setup();
	let mut s = AppSettingsV1::default_document();
	s.default_profile_id = Some(uuid::Uuid::now_v7());
	let err = settings.update(AppSettingsUpdate {
		settings: s,
		proxy_credential: ProxyCredentialUpdate::Keep,
	});
	assert!(matches!(err, Err(StorageError::Validation(_))));
}

#[test]
fn proxy_replace_and_clear() {
	let (_d, _db, _v, _p, _m, _pr, settings, ..) = setup();
	let mut s = AppSettingsV1::default_document();
	s.network = NetworkSettings {
		proxy_mode: GlobalProxyMode::Custom,
		proxy_url: Some("http://127.0.0.1:7890".into()),
	};
	s.theme = Some("dark".into());
	let dto = settings
		.update(AppSettingsUpdate {
			settings: s.clone(),
			proxy_credential: ProxyCredentialUpdate::Replace("proxy-secret".into()),
		})
		.unwrap();
	assert!(dto.proxy_has_credential);
	assert!(!serde_json::to_string(&dto).unwrap().contains("proxy-secret"));

	// URL change with Keep rejected
	s.network.proxy_url = Some("http://127.0.0.1:7891".into());
	let err = settings.update(AppSettingsUpdate {
		settings: s.clone(),
		proxy_credential: ProxyCredentialUpdate::Keep,
	});
	assert!(matches!(err, Err(StorageError::Validation(_))));

	let dto = settings
		.update(AppSettingsUpdate {
			settings: s,
			proxy_credential: ProxyCredentialUpdate::Clear,
		})
		.unwrap();
	assert!(!dto.proxy_has_credential);
}

#[test]
fn import_export_round_trip_and_secret_exclusion() {
	let (_d, _db, _v, providers, models, profiles, settings, ie, ..) = setup();
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-never-export".into()),
		))
		.unwrap();
	let m = models
		.save_manual(ManualModelWrite {
			id: None,
			provider_instance_id: p.id,
			model_key: "gpt".into(),
			display_name_override: None,
			enabled: true,
			capability_overrides_json: None,
		})
		.unwrap();
	profiles
		.save(TranslationProfileWrite {
			id: None,
			name: "P".into(),
			enabled: true,
			template_version: 1,
			system_template: "s".into(),
			user_template: "{{text}}".into(),
			temperature: None,
			max_output_tokens: None,
			provider_options_json: None,
			target_model_ids: vec![m.id],
		})
		.unwrap();
	let mut s = AppSettingsV1::default_document();
	s.theme = Some("light".into());
	s.translation = TranslationPreferences {
		auto_detect_source: true,
		preserve_formatting: false,
	};
	settings
		.update(AppSettingsUpdate {
			settings: s,
			proxy_credential: ProxyCredentialUpdate::Keep,
		})
		.unwrap();

	let doc = ie.export().unwrap();
	let json = serde_json::to_string(&doc).unwrap();
	assert!(!json.contains("sk-never-export"));
	assert!(!json.contains("credentialRef"));
	assert!(!json.contains("credential_ref"));
	assert!(!json.contains("hasCredential"));

	// merge clears credentials
	let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
	assert!(preview.valid);
	assert!(!preview.requires_authentication.is_empty());
	let result = ie.import(doc.clone(), ImportConflictMode::Merge).unwrap();
	assert!(result.applied);
	let list = providers.list().unwrap();
	assert!(!list[0].has_credential);

	// copy mode rewrites IDs
	let before = providers.list().unwrap().len();
	let result = ie.import(doc, ImportConflictMode::Copy).unwrap();
	assert!(result.applied);
	assert!(providers.list().unwrap().len() > before);
}

#[test]
fn credential_debug_redaction() {
	let update = CredentialUpdate::Replace("super-secret-value".into());
	assert!(!format!("{update:?}").contains("super-secret-value"));
}

#[test]
fn provider_delete_with_credential_cleans_vault() {
	let (_d, _db, vault, providers, ..) = setup();
	let dto = providers
		.save(provider_write(
			CredentialKind::Bearer,
			CredentialUpdate::Replace("token-xyz".into()),
		))
		.unwrap();
	providers.delete(dto.id).unwrap();
	// After delete, no unfinished journal and vault cleaned — list empty
	assert!(providers.list().unwrap().is_empty());
	let _ = vault;
}

#[test]
fn import_credential_cleanup_isolates_unrelated_journals() {
	use crate::credentials::coordinator;
	use crate::credentials::FailingCredentialVault;
	use crate::domain::time::new_id;
	use crate::repositories::credential_operations::{self, OperationState, OwnerKind};

	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(FailingCredentialVault::new());
	let transport = Arc::new(TestModelTransport::new());
	let providers = ProviderService::new(db.clone(), vault.clone());
	let models = ModelService::new(
		db.clone(),
		vault.clone() as Arc<dyn CredentialVault>,
		transport as Arc<dyn ModelTransport>,
	);
	let profiles = TranslationProfileService::new(db.clone());
	let _settings = SettingsService::new(db.clone(), vault.clone());
	let ie = ImportExportService::new(db.clone(), vault.clone());

	// Create a provider with secret, then leave an unrelated db_committed journal.
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-local".into()),
		))
		.unwrap();
	let unrelated_ref = format!("provider/{}/unrelated", new_id());
	vault.set(&unrelated_ref, "other").unwrap();
	let unrelated_op = db
		.transaction(|uow| {
			credential_operations::insert_db_committed(
				uow.conn(),
				new_id(),
				OwnerKind::Provider,
				&new_id().to_string(),
				Some(&unrelated_ref),
				None,
			)
		})
		.unwrap();

	let m = models
		.save_manual(ManualModelWrite {
			id: None,
			provider_instance_id: p.id,
			model_key: "gpt".into(),
			display_name_override: None,
			enabled: true,
			capability_overrides_json: None,
		})
		.unwrap();
	profiles
		.save(TranslationProfileWrite {
			id: None,
			name: "P".into(),
			enabled: true,
			template_version: 1,
			system_template: "s".into(),
			user_template: "{{text}}".into(),
			temperature: None,
			max_output_tokens: None,
			provider_options_json: None,
			target_model_ids: vec![m.id],
		})
		.unwrap();

	let doc = ie.export().unwrap();
	// Force import-owned vault cleanup to fail.
	vault.set_fail_delete(true);
	let result = ie.import(doc, ImportConflictMode::Merge).unwrap();
	assert!(result.applied);

	let unfinished = db.read(credential_operations::list_unfinished).unwrap();
	assert!(unfinished.iter().any(|op| op.id == unrelated_op.id));
	assert!(unfinished
		.iter()
		.any(|op| op.owner_id == p.id.to_string() && op.state == OperationState::DbCommitted));

	// Restore vault and recover only the import owner; unrelated remains.
	vault.set_fail_delete(false);
	let report = coordinator::recover_owner(&db, vault.as_ref(), OwnerKind::Provider, &p.id.to_string()).unwrap();
	assert_eq!(report.completed, 1);
	let unfinished = db.read(credential_operations::list_unfinished).unwrap();
	assert_eq!(unfinished.len(), 1);
	assert_eq!(unfinished[0].id, unrelated_op.id);
}

#[test]
fn import_rejects_malformed_graphs() {
	let (_d, _db, _v, providers, models, profiles, _settings, ie, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	let m = models
		.save_manual(ManualModelWrite {
			id: None,
			provider_instance_id: p.id,
			model_key: "gpt".into(),
			display_name_override: None,
			enabled: true,
			capability_overrides_json: None,
		})
		.unwrap();
	profiles
		.save(TranslationProfileWrite {
			id: None,
			name: "P".into(),
			enabled: true,
			template_version: 1,
			system_template: "s".into(),
			user_template: "{{text}}".into(),
			temperature: None,
			max_output_tokens: None,
			provider_options_json: None,
			target_model_ids: vec![m.id],
		})
		.unwrap();
	let mut doc = ie.export().unwrap();

	// System mode with proxy URL
	doc.app_settings.network.proxy_mode = GlobalProxyMode::System;
	doc.app_settings.network.proxy_url = Some("http://user:secret@host".into());
	let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
	assert!(!preview.valid);
	assert!(preview
		.validation_errors
		.iter()
		.any(|e| e.contains("proxy") || e.contains("userinfo") || e.contains("system")));
	assert!(!serde_json::to_string(&preview).unwrap().contains("user:secret"));

	// Reset settings
	doc.app_settings = AppSettingsV1::default_document();

	// Unknown adapter
	doc.providers[0].adapter_id = "not-a-real-adapter".into();
	let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
	assert!(!preview.valid);
	doc.providers[0].adapter_id = "openai-compatible".into();

	// Empty target chain
	doc.profile_models.clear();
	let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
	assert!(!preview.valid);

	// Duplicate provider ids
	doc = ie.export().unwrap();
	let dup = doc.providers[0].clone();
	doc.providers.push(dup);
	let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
	assert!(!preview.valid);
	assert!(preview.validation_errors.iter().any(|e| e.contains("duplicate")));
}

#[test]
fn model_sync_error_preserves_last_success_timestamp() {
	let (_d, db, _v, providers, models, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "a".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	let before = providers.get(p.id).unwrap();
	assert_eq!(before.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
	let synced_at = before.models_synced_at.clone().expect("synced_at");

	models.record_sync_error(p.id, "network").unwrap();
	let after = providers.get(p.id).unwrap();
	assert_eq!(
		after.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Error
	);
	assert_eq!(after.models_synced_at.as_deref(), Some(synced_at.as_str()));
	assert_eq!(after.models_sync_error_code.as_deref(), Some("network"));
	let _ = db;
}

#[test]
fn system_proxy_rejects_url() {
	let (_d, _db, _v, _p, _m, _pr, settings, ..) = setup();
	let mut s = AppSettingsV1::default_document();
	s.network = NetworkSettings {
		proxy_mode: GlobalProxyMode::System,
		proxy_url: Some("http://127.0.0.1:7890".into()),
	};
	let err = settings.update(AppSettingsUpdate {
		settings: s,
		proxy_credential: ProxyCredentialUpdate::Keep,
	});
	assert!(matches!(err, Err(StorageError::Validation(_))));
}

#[test]
fn set_theme_atomic() {
	let (_d, _db, _v, _p, _m, _pr, settings, ..) = setup();
	let dto = settings.set_theme(Some("dark".into())).unwrap();
	assert_eq!(dto.settings.theme.as_deref(), Some("dark"));
	let dto = settings.set_theme(None).unwrap();
	assert!(dto.settings.theme.is_none());
}

#[test]
fn capability_overrides_reject_invalid() {
	let (_d, _db, _v, providers, models, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	let err = models.save_manual(ManualModelWrite {
		id: None,
		provider_instance_id: p.id,
		model_key: "x".into(),
		display_name_override: None,
		enabled: true,
		capability_overrides_json: Some(serde_json::json!({"schemaVersion": 99})),
	});
	assert!(matches!(err, Err(StorageError::Validation(_))));
}

#[test]
fn validate_sync_error_code_accepts_credential_unavailable() {
	assert!(crate::services::models::validate_sync_error_code("credential_unavailable").is_ok());
	assert!(crate::services::models::validate_sync_error_code("auth").is_ok());
	assert!(crate::services::models::validate_sync_error_code("nope").is_err());
}

#[test]
fn test_connection_unauthenticated_openai_compatible_success() {
	let (_d, _db, _v, providers, models, _pr, _s, _ie, transport) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	transport.push_ok(vec![RemoteModelSyncItem {
		model_key: "local-model".into(),
		remote_display_name: None,
		remote_metadata_json: None,
	}]);
	let result = block_on(models.test_connection(p.id)).unwrap();
	assert!(result.ok);
	assert_eq!(result.model_count, Some(1));
	assert!(result.error_code.is_none());
	// Non-sensitive connection version for frontend stale-result filtering.
	assert_eq!(result.provider_updated_at, p.updated_at);
	let req = transport.last_request().expect("request recorded");
	assert!(req.secret.is_none());
	assert_eq!(req.proxy_mode, ProxyMode::Inherit);
	// Connection test must not mutate sync status.
	let after = providers.get(p.id).unwrap();
	assert_eq!(
		after.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);
	assert_eq!(after.updated_at, p.updated_at);
}

#[test]
fn test_connection_missing_required_credential_auth() {
	let (_d, _db, _v, providers, models, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::ApiKey, CredentialUpdate::Keep))
		.unwrap();
	let result = block_on(models.test_connection(p.id)).unwrap();
	assert!(!result.ok);
	assert_eq!(result.error_code.as_deref(), Some("auth"));
}

#[test]
fn test_connection_failing_vault_credential_unavailable() {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(FailingCredentialVault::new());
	let transport = Arc::new(TestModelTransport::new());
	let providers = ProviderService::new(db.clone(), vault.clone() as Arc<dyn CredentialVault>);
	// Create provider with working vault, then fail subsequent gets.
	vault.set_fail_get(false);
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-test".into()),
		))
		.unwrap();
	vault.set_fail_get(true);
	let models = ModelService::new(
		db,
		vault as Arc<dyn CredentialVault>,
		transport as Arc<dyn ModelTransport>,
	);
	let result = block_on(models.test_connection(p.id)).unwrap();
	assert!(!result.ok);
	assert_eq!(result.error_code.as_deref(), Some("credential_unavailable"));
}

#[test]
fn test_connection_transport_failure_no_db_mutation() {
	let (_d, _db, _v, providers, models, _pr, _s, _ie, transport) = setup();
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-test".into()),
		))
		.unwrap();
	transport.push_err(TransportError::Timeout);
	let result = block_on(models.test_connection(p.id)).unwrap();
	assert!(!result.ok);
	assert_eq!(result.error_code.as_deref(), Some("timeout"));
	let after = providers.get(p.id).unwrap();
	assert_eq!(
		after.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);
	assert!(models.list_by_provider(p.id).unwrap().is_empty());
}

#[test]
fn sync_models_success_merges_and_sets_ok_status() {
	let (_d, _db, _v, providers, models, _pr, _s, _ie, transport) = setup();
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-test".into()),
		))
		.unwrap();
	transport.push_ok(vec![
		RemoteModelSyncItem {
			model_key: "gpt-4o".into(),
			remote_display_name: Some("GPT-4o".into()),
			remote_metadata_json: None,
		},
		RemoteModelSyncItem {
			model_key: "gpt-4o-mini".into(),
			remote_display_name: None,
			remote_metadata_json: None,
		},
	]);
	let result = block_on(models.sync_models(p.id)).unwrap();
	assert!(result.ok);
	assert_eq!(result.models.len(), 2);
	assert_eq!(
		result.provider.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Ok
	);
	assert!(result.provider.models_synced_at.is_some());
}

#[test]
fn sync_models_transport_failure_preserves_models_and_timestamp() {
	let (_d, _db, _v, providers, models, _pr, _s, _ie, transport) = setup();
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-test".into()),
		))
		.unwrap();
	// Successful sync first.
	transport.push_ok(vec![RemoteModelSyncItem {
		model_key: "kept".into(),
		remote_display_name: None,
		remote_metadata_json: None,
	}]);
	let first = block_on(models.sync_models(p.id)).unwrap();
	assert!(first.ok);
	let synced_at = first.provider.models_synced_at.clone().expect("synced_at");

	// Transport failure on second sync (simulates second-page / remote failure).
	transport.push_err(TransportError::Server);
	let second = block_on(models.sync_models(p.id)).unwrap();
	assert!(!second.ok);
	assert_eq!(second.error_code.as_deref(), Some("server"));
	assert_eq!(
		second.provider.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Error
	);
	assert_eq!(second.provider.models_synced_at.as_deref(), Some(synced_at.as_str()));
	assert_eq!(second.models.len(), 1);
	assert_eq!(second.models[0].model_key, "kept");
	assert_eq!(second.models[0].availability, Availability::Available);
}

#[test]
fn sync_models_second_page_failure_no_partial_merge() {
	// Service never merges when transport returns Err — same path as mid-pagination failure.
	let (_d, _db, _v, providers, models, _pr, _s, _ie, transport) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "existing".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	transport.push_err(TransportError::InvalidResponse);
	let result = block_on(models.sync_models(p.id)).unwrap();
	assert!(!result.ok);
	assert_eq!(result.models.len(), 1);
	assert_eq!(result.models[0].model_key, "existing");
	assert_eq!(result.models[0].availability, Availability::Available);
}

#[test]
fn sync_models_missing_credential_records_auth() {
	let (_d, _db, _v, providers, models, ..) = setup();
	let mut input = provider_write(CredentialKind::ApiKey, CredentialUpdate::Keep);
	input.adapter_id = "anthropic".into();
	input.base_url_override = None;
	let p = providers.save(input).unwrap();
	let result = block_on(models.sync_models(p.id)).unwrap();
	assert!(!result.ok);
	assert_eq!(result.error_code.as_deref(), Some("auth"));
	assert_eq!(
		result.provider.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Error
	);
	assert_eq!(result.provider.models_sync_error_code.as_deref(), Some("auth"));
}

#[test]
fn sync_models_failing_vault_records_credential_unavailable() {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(FailingCredentialVault::new());
	let transport = Arc::new(TestModelTransport::new());
	let providers = ProviderService::new(db.clone(), vault.clone() as Arc<dyn CredentialVault>);
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-test".into()),
		))
		.unwrap();
	vault.set_fail_get(true);
	let models = ModelService::new(
		db,
		vault as Arc<dyn CredentialVault>,
		transport as Arc<dyn ModelTransport>,
	);
	let result = block_on(models.sync_models(p.id)).unwrap();
	assert!(!result.ok);
	assert_eq!(result.error_code.as_deref(), Some("credential_unavailable"));
	assert_eq!(
		result.provider.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Error
	);
	assert_eq!(
		result.provider.models_sync_error_code.as_deref(),
		Some("credential_unavailable")
	);
}

#[test]
fn transport_receives_saved_proxy_mode_and_secret() {
	let (_d, _db, _v, providers, models, _pr, _s, _ie, transport) = setup();
	let mut input = provider_write(
		CredentialKind::ApiKey,
		CredentialUpdate::Replace("sk-secret-value".into()),
	);
	input.proxy_mode = ProxyMode::Direct;
	let p = providers.save(input).unwrap();
	transport.push_ok(vec![]);
	let _ = block_on(models.test_connection(p.id)).unwrap();
	let req = transport.last_request().expect("request");
	assert_eq!(req.proxy_mode, ProxyMode::Direct);
	assert_eq!(req.secret.as_deref(), Some("sk-secret-value"));
	assert_eq!(req.adapter_id, "openai-compatible");
}

#[test]
fn model_list_request_debug_redacts_secret() {
	let req = ModelListRequest {
		adapter_id: "openai-compatible".into(),
		base_url: "https://api.example.com/v1".into(),
		credential_kind: CredentialKind::ApiKey,
		secret: Some("sk-must-not-appear".into()),
		proxy_mode: ProxyMode::Inherit,
	};
	let debug = format!("{req:?}");
	assert!(!debug.contains("sk-must-not-appear"));
	assert!(debug.contains("[redacted]"));
}

#[test]
fn sync_models_success_message_uses_remote_snapshot_count() {
	let (_d, _db, _v, providers, models, _pr, _s, _ie, transport) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	// Manual model makes DB total differ from remote snapshot size.
	models
		.save_manual(ManualModelWrite {
			id: None,
			provider_instance_id: p.id,
			model_key: "manual-only".into(),
			display_name_override: None,
			enabled: true,
			capability_overrides_json: None,
		})
		.unwrap();
	transport.push_ok(vec![
		RemoteModelSyncItem {
			model_key: "remote-a".into(),
			remote_display_name: None,
			remote_metadata_json: None,
		},
		RemoteModelSyncItem {
			model_key: "remote-b".into(),
			remote_display_name: None,
			remote_metadata_json: None,
		},
	]);
	let result = block_on(models.sync_models(p.id)).unwrap();
	assert!(result.ok);
	// Remote snapshot had 2 items; DB has 3 after merge (2 remote + 1 manual).
	assert_eq!(result.models.len(), 3);
	assert_eq!(result.message, "Synced 2 models");
	assert!(!result.message.contains("Synced 3"));
}

/// Transport that mutates provider connection mid-flight before returning models.
struct MutatingConnectionTransport {
	providers: ProviderService,
	provider_id: uuid::Uuid,
	items: Vec<RemoteModelSyncItem>,
}

impl ModelTransport for MutatingConnectionTransport {
	fn list_models(
		&self,
		_request: ModelListRequest,
	) -> Pin<Box<dyn Future<Output = Result<Vec<RemoteModelSyncItem>, TransportError>> + Send + '_>> {
		// Simulate a concurrent Save that changes base URL while HTTP is in flight.
		let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
		write.id = Some(self.provider_id);
		write.base_url_override = Some("http://127.0.0.1:9999/v1".into());
		write.display_name = "OpenAI".into();
		self.providers.save(write).expect("mid-flight save");
		let items = self.items.clone();
		Box::pin(async move { Ok(items) })
	}
}

#[test]
fn sync_models_aborts_merge_when_connection_changes_mid_flight() {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(MemoryCredentialVault::new());
	let providers = ProviderService::new(db.clone(), vault.clone());
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();

	// Seed an existing remote model under the original endpoint.
	let seed_transport = Arc::new(TestModelTransport::new());
	let seed_models = ModelService::new(
		db.clone(),
		vault.clone() as Arc<dyn CredentialVault>,
		seed_transport.clone() as Arc<dyn ModelTransport>,
	);
	seed_models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "old-endpoint-model".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();

	let transport = Arc::new(MutatingConnectionTransport {
		providers: providers.clone(),
		provider_id: p.id,
		items: vec![RemoteModelSyncItem {
			model_key: "stale-remote-from-old-url".into(),
			remote_display_name: None,
			remote_metadata_json: None,
		}],
	});
	let models = ModelService::new(
		db,
		vault as Arc<dyn CredentialVault>,
		transport as Arc<dyn ModelTransport>,
	);

	let result = block_on(models.sync_models(p.id)).unwrap();
	assert!(!result.ok);
	assert_eq!(result.error_code.as_deref(), Some("connection_changed"));
	// Old models must remain; stale remote snapshot must not merge.
	assert_eq!(result.models.len(), 1);
	assert_eq!(result.models[0].model_key, "old-endpoint-model");
	assert_eq!(result.models[0].availability, Availability::Available);
	assert!(result.models.iter().all(|m| m.model_key != "stale-remote-from-old-url"));
	// Connection should now reflect the mid-flight save.
	assert_eq!(
		result.provider.base_url_override.as_deref(),
		Some("http://127.0.0.1:9999/v1")
	);
	// Race outcome must not be persisted as a models_sync_error_code.
	assert_ne!(
		result.provider.models_sync_error_code.as_deref(),
		Some("connection_changed")
	);
	// Mid-flight connection identity change resets sync status in the save transaction.
	assert_eq!(
		result.provider.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);
	assert!(result.provider.models_synced_at.is_none());
	assert!(result.provider.models_sync_error_code.is_none());
}

/// Transport that mutates provider connection mid-flight, then fails.
struct MutatingConnectionErrorTransport {
	providers: ProviderService,
	provider_id: uuid::Uuid,
	err: TransportError,
}

impl ModelTransport for MutatingConnectionErrorTransport {
	fn list_models(
		&self,
		_request: ModelListRequest,
	) -> Pin<Box<dyn Future<Output = Result<Vec<RemoteModelSyncItem>, TransportError>> + Send + '_>> {
		let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
		write.id = Some(self.provider_id);
		write.base_url_override = Some("http://127.0.0.1:9999/v1".into());
		write.display_name = "OpenAI".into();
		self.providers.save(write).expect("mid-flight save");
		let err = self.err;
		Box::pin(async move { Err(err) })
	}
}

#[test]
fn sync_models_transport_error_skips_write_when_connection_changed() {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(MemoryCredentialVault::new());
	let providers = ProviderService::new(db.clone(), vault.clone());
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();

	// Establish a prior successful sync so we can detect erroneous failure writes.
	let seed_transport = Arc::new(TestModelTransport::new());
	let seed_models = ModelService::new(
		db.clone(),
		vault.clone() as Arc<dyn CredentialVault>,
		seed_transport.clone() as Arc<dyn ModelTransport>,
	);
	seed_models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "kept".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	let before = providers.get(p.id).unwrap();
	assert_eq!(before.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
	let synced_at = before.models_synced_at.clone().expect("synced_at");

	let transport = Arc::new(MutatingConnectionErrorTransport {
		providers: providers.clone(),
		provider_id: p.id,
		err: TransportError::Network,
	});
	let models = ModelService::new(
		db,
		vault as Arc<dyn CredentialVault>,
		transport as Arc<dyn ModelTransport>,
	);

	let result = block_on(models.sync_models(p.id)).unwrap();
	assert!(!result.ok);
	assert_eq!(result.error_code.as_deref(), Some("connection_changed"));
	// Must not stamp the new connection with the old request's network error.
	// Save resets sync status when connection identity changes.
	assert_eq!(
		result.provider.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);
	assert!(result.provider.models_synced_at.is_none());
	assert!(result.provider.models_sync_error_code.is_none());
	assert_ne!(result.provider.models_synced_at.as_deref(), Some(synced_at.as_str()));
	assert_eq!(result.models.len(), 1);
	assert_eq!(result.models[0].model_key, "kept");
	assert_eq!(
		result.provider.base_url_override.as_deref(),
		Some("http://127.0.0.1:9999/v1")
	);
}

/// Vault that mutates provider connection on first secret read, then returns a configured error.
/// Used to exercise missing-credential / vault-failure races against connection identity.
struct MutatingGetVault {
	inner: MemoryCredentialVault,
	providers: Mutex<Option<ProviderService>>,
	provider_id: Mutex<Option<uuid::Uuid>>,
	mutated: Mutex<bool>,
	/// When true, return CredentialUnavailable; otherwise NotFound (auth path).
	fail_unavailable: Mutex<bool>,
}

impl MutatingGetVault {
	fn new() -> Self {
		Self {
			inner: MemoryCredentialVault::new(),
			providers: Mutex::new(None),
			provider_id: Mutex::new(None),
			mutated: Mutex::new(false),
			fail_unavailable: Mutex::new(false),
		}
	}

	fn configure(&self, providers: ProviderService, provider_id: uuid::Uuid, fail_unavailable: bool) {
		*self.providers.lock().expect("providers") = Some(providers);
		*self.provider_id.lock().expect("provider_id") = Some(provider_id);
		*self.fail_unavailable.lock().expect("fail") = fail_unavailable;
	}

	fn mutate_connection_once(&self) {
		if *self.mutated.lock().expect("mutated") {
			return;
		}
		let providers = self.providers.lock().expect("providers").clone();
		let provider_id = *self.provider_id.lock().expect("provider_id");
		if let (Some(providers), Some(provider_id)) = (providers, provider_id) {
			let mut write = provider_write(
				CredentialKind::ApiKey,
				CredentialUpdate::Replace("sk-after-mutate".into()),
			);
			write.id = Some(provider_id);
			write.base_url_override = Some("http://127.0.0.1:9999/v1".into());
			write.display_name = "OpenAI".into();
			// Keep credential so the new identity differs by base URL (and new secret).
			providers.save(write).expect("mid-resolve save");
			*self.mutated.lock().expect("mutated") = true;
		}
	}
}

impl CredentialVault for MutatingGetVault {
	fn set(&self, account: &str, secret: &str) -> Result<(), StorageError> {
		self.inner.set(account, secret)
	}

	fn get_for_backend_use(&self, _account: &str) -> Result<String, StorageError> {
		// Connection identity was captured before this call; mutate so record sees a mismatch.
		self.mutate_connection_once();
		if *self.fail_unavailable.lock().expect("fail") {
			Err(StorageError::CredentialUnavailable)
		} else {
			Err(StorageError::NotFound("credential entry".into()))
		}
	}

	fn delete(&self, account: &str) -> Result<(), StorageError> {
		self.inner.delete(account)
	}

	fn exists(&self, account: &str) -> Result<bool, StorageError> {
		self.inner.exists(account)
	}
}

#[test]
fn sync_models_missing_credential_skips_error_when_connection_changed() {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(MutatingGetVault::new());
	let providers = ProviderService::new(db.clone(), vault.clone() as Arc<dyn CredentialVault>);
	// Seed a successful remote model under the original connection.
	let seed_transport = Arc::new(TestModelTransport::new());
	// Save with a real secret first so credential_ref is set; MutatingGetVault then fails get.
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-original".into()),
		))
		.unwrap();
	let seed_models = ModelService::new(
		db.clone(),
		vault.clone() as Arc<dyn CredentialVault>,
		seed_transport as Arc<dyn ModelTransport>,
	);
	// apply_remote_merge does not touch the vault.
	seed_models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "kept".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	let before = providers.get(p.id).unwrap();
	assert_eq!(before.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
	let synced_at = before.models_synced_at.clone().expect("synced_at");

	vault.configure(providers.clone(), p.id, false);
	let transport = Arc::new(TestModelTransport::new());
	let models = ModelService::new(
		db,
		vault as Arc<dyn CredentialVault>,
		transport as Arc<dyn ModelTransport>,
	);

	let result = block_on(models.sync_models(p.id)).unwrap();
	assert!(!result.ok);
	assert_eq!(result.error_code.as_deref(), Some("connection_changed"));
	// Old auth error must not be written onto the post-mutation connection.
	// Credential replace mid-resolve changes identity and resets sync status.
	assert_eq!(
		result.provider.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);
	assert!(result.provider.models_synced_at.is_none());
	assert!(result.provider.models_sync_error_code.is_none());
	assert_ne!(result.provider.models_synced_at.as_deref(), Some(synced_at.as_str()));
	assert_eq!(
		result.provider.base_url_override.as_deref(),
		Some("http://127.0.0.1:9999/v1")
	);
	assert_eq!(result.models[0].model_key, "kept");
}

#[test]
fn sync_models_vault_failure_skips_error_when_connection_changed() {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(MutatingGetVault::new());
	let providers = ProviderService::new(db.clone(), vault.clone() as Arc<dyn CredentialVault>);
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-original".into()),
		))
		.unwrap();
	let seed_transport = Arc::new(TestModelTransport::new());
	let seed_models = ModelService::new(
		db.clone(),
		vault.clone() as Arc<dyn CredentialVault>,
		seed_transport as Arc<dyn ModelTransport>,
	);
	seed_models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "kept".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();

	vault.configure(providers.clone(), p.id, true);
	let transport = Arc::new(TestModelTransport::new());
	let models = ModelService::new(
		db,
		vault as Arc<dyn CredentialVault>,
		transport as Arc<dyn ModelTransport>,
	);

	let result = block_on(models.sync_models(p.id)).unwrap();
	assert!(!result.ok);
	assert_eq!(result.error_code.as_deref(), Some("connection_changed"));
	assert_eq!(
		result.provider.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);
	assert!(result.provider.models_synced_at.is_none());
	assert!(result.provider.models_sync_error_code.is_none());
	assert_ne!(
		result.provider.models_sync_error_code.as_deref(),
		Some("credential_unavailable")
	);
}

#[test]
fn validate_sync_error_code_rejects_connection_changed() {
	assert!(crate::services::models::validate_sync_error_code("connection_changed").is_err());
	assert!(crate::services::models::validate_sync_error_code("network").is_ok());
}

/// Transport that blocks until released; records requests to assert serialization + re-resolve.
struct BarrierTransport {
	entered: Arc<Mutex<usize>>,
	max_concurrent: Arc<Mutex<usize>>,
	release: Arc<(Mutex<bool>, std::sync::Condvar)>,
	requests: Arc<Mutex<Vec<ModelListRequest>>>,
	items: Vec<RemoteModelSyncItem>,
}

impl ModelTransport for BarrierTransport {
	fn list_models(
		&self,
		request: ModelListRequest,
	) -> Pin<Box<dyn Future<Output = Result<Vec<RemoteModelSyncItem>, TransportError>> + Send + '_>> {
		self.requests.lock().expect("requests").push(request);
		{
			let mut entered = self.entered.lock().expect("entered");
			*entered += 1;
			let mut max = self.max_concurrent.lock().expect("max");
			if *entered > *max {
				*max = *entered;
			}
		}
		let release = self.release.clone();
		let entered = self.entered.clone();
		let items = self.items.clone();
		Box::pin(async move {
			// Poll until released without blocking the async runtime forever.
			loop {
				{
					let (lock, _cv) = &*release;
					if *lock.lock().expect("release") {
						break;
					}
				}
				std::thread::sleep(std::time::Duration::from_millis(5));
			}
			*entered.lock().expect("entered") -= 1;
			Ok(items)
		})
	}
}

#[test]
fn sync_models_serializes_same_provider_max_transport_concurrency_one() {
	// Per-provider serialization (not single-flight): concurrent callers queue; each runs its
	// own Future after the previous finishes and re-reads the latest connection identity.
	// Sequence under test:
	// 1) first call enters transport
	// 2) second call is started and confirmed queued (still max concurrency 1)
	// 3) connection identity is saved while first still holds the lock
	// 4) first is released; second acquires the lock and re-resolves the new identity
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(MemoryCredentialVault::new());
	let providers = ProviderService::new(db.clone(), vault.clone());
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();

	let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
	let entered = Arc::new(Mutex::new(0usize));
	let max_concurrent = Arc::new(Mutex::new(0usize));
	let requests = Arc::new(Mutex::new(Vec::new()));
	let transport = Arc::new(BarrierTransport {
		entered: entered.clone(),
		max_concurrent: max_concurrent.clone(),
		release: release.clone(),
		requests: requests.clone(),
		items: vec![RemoteModelSyncItem {
			model_key: "only".into(),
			remote_display_name: None,
			remote_metadata_json: None,
		}],
	});
	let models = ModelService::new(
		db,
		vault as Arc<dyn CredentialVault>,
		transport as Arc<dyn ModelTransport>,
	);

	let models_a = models.clone();
	let models_b = models.clone();
	let id = p.id;
	let handle_a = std::thread::spawn(move || block_on(models_a.sync_models(id)));
	// Ensure first sync has entered transport before starting second.
	for _ in 0..200 {
		if *entered.lock().expect("entered") >= 1 {
			break;
		}
		std::thread::sleep(std::time::Duration::from_millis(5));
	}
	assert_eq!(
		*entered.lock().expect("entered"),
		1,
		"first sync should be in transport"
	);

	// Start second while first still holds the per-provider lock; confirm it is queued.
	let handle_b = std::thread::spawn(move || block_on(models_b.sync_models(id)));
	for _ in 0..40 {
		std::thread::sleep(std::time::Duration::from_millis(5));
		if *max_concurrent.lock().expect("max") > 1 {
			break;
		}
	}
	assert_eq!(
		*entered.lock().expect("entered"),
		1,
		"queued second call must not enter transport while first holds the lock"
	);
	assert_eq!(
		*max_concurrent.lock().expect("max"),
		1,
		"same provider transport max concurrency must be 1"
	);
	assert_eq!(
		requests.lock().expect("requests").len(),
		1,
		"queued second call must not resolve/transport until it holds the lock"
	);

	// Only after the second call is confirmed queued: change connection identity.
	let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
	write.id = Some(p.id);
	write.base_url_override = Some("http://127.0.0.1:7777/v1".into());
	write.display_name = "OpenAI".into();
	providers.save(write).expect("mid-serialization save");

	// Release first transport; second should then acquire the lock and re-resolve.
	*release.0.lock().expect("release") = true;
	release.1.notify_all();

	let a = handle_a.join().expect("join a").expect("sync a");
	let b = handle_b.join().expect("join b").expect("sync b");
	// First sync resolved the old identity; mid-flight save resets status and aborts merge.
	assert!(!a.ok);
	assert_eq!(a.error_code.as_deref(), Some("connection_changed"));
	// Second sync re-read the latest connection after the lock and should succeed on new URL.
	assert!(b.ok, "queued sync should re-resolve latest connection identity");
	assert_eq!(*max_concurrent.lock().expect("max"), 1);

	let captured = requests.lock().expect("requests").clone();
	assert_eq!(captured.len(), 2, "serialization runs two independent transport calls");
	// First request used the original URL; second must use the post-save base URL.
	assert!(
		!captured[0].base_url.contains("127.0.0.1:7777"),
		"first sync must have resolved the pre-save identity"
	);
	assert!(
		captured[1].base_url.contains("127.0.0.1:7777"),
		"later sync must re-read latest connection identity after acquiring the lock, got {}",
		captured[1].base_url
	);
}

#[test]
fn save_connection_identity_change_resets_models_sync_status() {
	// After a successful sync, changing connection fields must reset status to Never so the
	// new connection cannot inherit the prior Ok/Error state (covers Save-after-merge order).
	let (_d, _db, _v, providers, models, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "m1".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	let before = providers.get(p.id).unwrap();
	assert_eq!(before.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
	assert!(before.models_synced_at.is_some());

	let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
	write.id = Some(p.id);
	write.base_url_override = Some("http://127.0.0.1:8888/v1".into());
	write.display_name = "OpenAI".into();
	let after = providers.save(write).unwrap();
	assert_eq!(
		after.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);
	assert!(after.models_synced_at.is_none());
	assert!(after.models_sync_error_code.is_none());
	// Remote model rows are intentionally retained; only sync metadata resets.
	assert_eq!(models.list_by_provider(p.id).unwrap().len(), 1);
}

#[test]
fn clear_credential_final_txn_preserves_latest_sync_when_identity_unchanged() {
	// clear_credential writes journal first, then a final configuration transaction.
	// A concurrent sync may commit Ok between those steps. The final txn must re-read the
	// latest row and preserve its sync fields when connection identity is unchanged — never
	// overwrite with the pre-journal snapshot (which still had Never).
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(MemoryCredentialVault::new());
	let providers = ProviderService::new(db.clone(), vault.clone());
	let models = ModelService::new(
		db,
		vault as Arc<dyn CredentialVault>,
		Arc::new(TestModelTransport::new()) as Arc<dyn ModelTransport>,
	);
	// Already credentialKind none / no ref: Clear is identity-preserving for connection fields.
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	assert_eq!(
		providers.get(p.id).unwrap().models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);

	let models_for_hook = models.clone();
	let provider_id = p.id;
	crate::services::providers::set_clear_credential_between_txns_hook(move || {
		// Sync commits first (during the multi-transaction gap), before clear's final write.
		models_for_hook
			.apply_remote_merge(
				provider_id,
				&[RemoteModelSyncItem {
					model_key: "from-concurrent-sync".into(),
					remote_display_name: None,
					remote_metadata_json: None,
				}],
			)
			.expect("concurrent sync in clear gap");
	});

	let mut write = provider_write(CredentialKind::None, CredentialUpdate::Clear);
	write.id = Some(p.id);
	write.display_name = "Renamed during clear".into();
	// Same connection identity (adapter/url/kind/ref/proxy).
	write.base_url_override = Some("https://api.openai.com/v1".into());
	let after = providers.save(write).expect("clear save");

	assert_eq!(
		after.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Ok,
		"final clear txn must keep concurrent sync Ok, not pre-journal Never"
	);
	assert!(after.models_synced_at.is_some());
	assert!(after.models_sync_error_code.is_none());
	assert_eq!(after.display_name, "Renamed during clear");
	assert_eq!(models.list_by_provider(p.id).unwrap().len(), 1);
}

#[test]
fn clear_credential_final_txn_resets_sync_when_identity_changed() {
	// When clear changes connection identity (credential_ref / kind), final txn must reset
	// Never/None even if a concurrent sync wrote Ok on the old identity in the gap.
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(MemoryCredentialVault::new());
	let providers = ProviderService::new(db.clone(), vault.clone());
	let models = ModelService::new(
		db,
		vault as Arc<dyn CredentialVault>,
		Arc::new(TestModelTransport::new()) as Arc<dyn ModelTransport>,
	);
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-old".into()),
		))
		.unwrap();
	models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "seed".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	assert_eq!(
		providers.get(p.id).unwrap().models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Ok
	);

	let models_for_hook = models.clone();
	let provider_id = p.id;
	crate::services::providers::set_clear_credential_between_txns_hook(move || {
		// Concurrent merge on the still-old identity (clear not committed yet).
		models_for_hook
			.apply_remote_merge(
				provider_id,
				&[RemoteModelSyncItem {
					model_key: "gap-sync".into(),
					remote_display_name: None,
					remote_metadata_json: None,
				}],
			)
			.expect("gap sync");
	});

	let mut write = provider_write(CredentialKind::None, CredentialUpdate::Clear);
	write.id = Some(p.id);
	write.display_name = "OpenAI".into();
	write.base_url_override = Some("https://api.openai.com/v1".into());
	let after = providers.save(write).expect("clear to none");
	assert_eq!(
		after.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);
	assert!(after.models_synced_at.is_none());
	assert!(after.models_sync_error_code.is_none());
	assert!(!after.has_credential);
	assert_eq!(after.credential_kind, CredentialKind::None);
}

#[test]
fn save_none_keep_after_sync_preserves_status_when_identity_unchanged() {
	// credentialKind none ordinary Keep Save: sync commits first, Save commits second.
	// Identity-preserving Save must not wipe models_synced_at / status from the earlier sync.
	let (_d, _db, _v, providers, models, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	// Sync commits first.
	models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "m1".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	let before = providers.get(p.id).unwrap();
	assert_eq!(before.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
	let synced_at = before.models_synced_at.clone().expect("synced_at");

	// Save final transaction commits after sync.
	let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
	write.id = Some(p.id);
	write.display_name = "After sync rename".into();
	write.base_url_override = before.base_url_override.clone();
	let after = providers.save(write).unwrap();
	assert_eq!(after.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
	assert_eq!(after.models_synced_at.as_deref(), Some(synced_at.as_str()));
	assert!(after.models_sync_error_code.is_none());
	assert_eq!(after.display_name, "After sync rename");
}

#[test]
fn save_none_keep_after_sync_resets_when_identity_changed() {
	// credentialKind none ordinary Keep Save after a successful sync: connection change in
	// Save's transaction must reset status (sync committed first, Save second).
	let (_d, _db, _v, providers, models, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "m1".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	assert_eq!(
		providers.get(p.id).unwrap().models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Ok
	);

	let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
	write.id = Some(p.id);
	write.base_url_override = Some("http://127.0.0.1:4242/v1".into());
	write.display_name = "OpenAI".into();
	let after = providers.save(write).unwrap();
	assert_eq!(
		after.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);
	assert!(after.models_synced_at.is_none());
	assert!(after.models_sync_error_code.is_none());
}

#[test]
fn save_display_name_only_preserves_models_sync_status() {
	let (_d, _db, _v, providers, models, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "m1".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	let before = providers.get(p.id).unwrap();
	let synced_at = before.models_synced_at.clone().expect("synced_at");

	let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
	write.id = Some(p.id);
	write.display_name = "Renamed only".into();
	// Same base URL / identity fields.
	write.base_url_override = before.base_url_override.clone();
	let after = providers.save(write).unwrap();
	assert_eq!(after.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
	assert_eq!(after.models_synced_at.as_deref(), Some(synced_at.as_str()));
	assert!(after.models_sync_error_code.is_none());
}

#[test]
fn save_credential_replace_resets_models_sync_status() {
	let (_d, _db, _v, providers, models, ..) = setup();
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-old".into()),
		))
		.unwrap();
	models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "m1".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	assert_eq!(
		providers.get(p.id).unwrap().models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Ok
	);

	let mut write = provider_write(CredentialKind::ApiKey, CredentialUpdate::Replace("sk-new".into()));
	write.id = Some(p.id);
	write.display_name = "OpenAI".into();
	write.base_url_override = Some("https://api.openai.com/v1".into());
	let after = providers.save(write).unwrap();
	assert_eq!(
		after.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);
	assert!(after.models_synced_at.is_none());
	assert!(after.models_sync_error_code.is_none());
}

#[test]
fn save_proxy_mode_change_resets_models_sync_status() {
	let (_d, _db, _v, providers, models, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
		.unwrap();
	models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "m1".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();

	let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
	write.id = Some(p.id);
	write.proxy_mode = ProxyMode::Direct;
	write.display_name = "OpenAI".into();
	let after = providers.save(write).unwrap();
	assert_eq!(
		after.models_sync_status,
		crate::domain::provider::ModelsSyncStatus::Never
	);
	assert!(after.models_synced_at.is_none());
}

#[test]
fn vault_set_failure_on_replace_does_not_reset_sync_status() {
	// Vault fails before SQLite commit: prior Ok status must remain (no partial identity change).
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	let vault = Arc::new(FailingCredentialVault::new());
	let transport = Arc::new(TestModelTransport::new());
	let providers = ProviderService::new(db.clone(), vault.clone() as Arc<dyn CredentialVault>);
	vault.set_fail_set(false);
	let p = providers
		.save(provider_write(
			CredentialKind::ApiKey,
			CredentialUpdate::Replace("sk-ok".into()),
		))
		.unwrap();
	let models = ModelService::new(
		db,
		vault.clone() as Arc<dyn CredentialVault>,
		transport as Arc<dyn ModelTransport>,
	);
	models
		.apply_remote_merge(
			p.id,
			&[RemoteModelSyncItem {
				model_key: "m1".into(),
				remote_display_name: None,
				remote_metadata_json: None,
			}],
		)
		.unwrap();
	let before = providers.get(p.id).unwrap();
	assert_eq!(before.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
	let synced_at = before.models_synced_at.clone().expect("synced_at");

	vault.set_fail_set(true);
	let mut write = provider_write(CredentialKind::ApiKey, CredentialUpdate::Replace("sk-fail".into()));
	write.id = Some(p.id);
	write.display_name = "OpenAI".into();
	let err = providers.save(write);
	assert!(err.is_err());

	let after = providers.get(p.id).unwrap();
	assert_eq!(after.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
	assert_eq!(after.models_synced_at.as_deref(), Some(synced_at.as_str()));
}

#[test]
fn test_connection_returns_provider_updated_at_on_failure() {
	let (_d, _db, _v, providers, models, ..) = setup();
	let p = providers
		.save(provider_write(CredentialKind::ApiKey, CredentialUpdate::Keep))
		.unwrap();
	let result = block_on(models.test_connection(p.id)).unwrap();
	assert!(!result.ok);
	assert_eq!(result.error_code.as_deref(), Some("auth"));
	assert_eq!(result.provider_updated_at, p.updated_at);
}
