// ABOUTME: Repository behavior and referential-integrity tests.
// ABOUTME: Exercises CRUD, uniqueness, rollback, and credential journal rules.
use crate::domain::model::{Availability, ModelSource, ProviderModel};
use crate::domain::provider::{CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode};
use crate::domain::settings::AppSettingsV1;
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{TranslationProfile, TranslationProfileTarget};
use crate::error::StorageError;
use crate::repositories::{
	app_credentials, app_settings, credential_operations, provider_instances, provider_models, translation_profiles,
};
use crate::storage::Database;
use uuid::Uuid;

fn setup() -> (tempfile::TempDir, Database) {
	let dir = tempfile::tempdir().unwrap();
	let db = Database::new(dir.path()).unwrap();
	db.initialize().unwrap();
	(dir, db)
}

fn sample_provider(id: Uuid) -> ProviderInstance {
	let now = now_rfc3339();
	ProviderInstance {
		id,
		adapter_id: "openai-compatible".into(),
		display_name: "Test".into(),
		base_url_override: None,
		credential_kind: CredentialKind::None,
		credential_ref: None,
		enabled: true,
		proxy_mode: ProxyMode::Inherit,
		insecure_http_confirmed_at: None,
		models_synced_at: None,
		models_sync_status: ModelsSyncStatus::Never,
		models_sync_error_code: None,
		created_at: now.clone(),
		updated_at: now,
	}
}

fn sample_model(id: Uuid, provider_id: Uuid, key: &str) -> ProviderModel {
	let now = now_rfc3339();
	ProviderModel {
		id,
		provider_instance_id: provider_id,
		model_key: key.into(),
		source: ModelSource::Manual,
		remote_display_name: None,
		display_name_override: Some(key.into()),
		enabled: true,
		availability: Availability::Available,
		remote_metadata_json: None,
		capability_overrides_json: None,
		adapter_id: None,
		last_seen_at: None,
		created_at: now.clone(),
		updated_at: now,
	}
}

#[test]
fn provider_crud() {
	let (_dir, db) = setup();
	let id = new_id();
	db.transaction(|uow| {
		provider_instances::insert(uow.conn(), &sample_provider(id))?;
		Ok(())
	})
	.unwrap();
	db.read(|conn| {
		let p = provider_instances::get(conn, id)?;
		assert_eq!(p.display_name, "Test");
		let list = provider_instances::list(conn)?;
		assert_eq!(list.len(), 1);
		Ok(())
	})
	.unwrap();
	db.transaction(|uow| {
		let mut p = provider_instances::get(uow.conn(), id)?;
		p.display_name = "Renamed".into();
		p.updated_at = now_rfc3339();
		provider_instances::update_configuration(uow.conn(), &p)?;
		Ok(())
	})
	.unwrap();
	db.read(|conn| {
		assert_eq!(provider_instances::get(conn, id)?.display_name, "Renamed");
		Ok(())
	})
	.unwrap();
	db.transaction(|uow| {
		provider_instances::delete(uow.conn(), id)?;
		Ok(())
	})
	.unwrap();
	let err = db.read(|conn| provider_instances::get(conn, id));
	assert!(matches!(err, Err(StorageError::NotFound(_))));
}

#[test]
fn duplicate_model_key_same_provider_conflicts() {
	let (_dir, db) = setup();
	let pid = new_id();
	db.transaction(|uow| {
		provider_instances::insert(uow.conn(), &sample_provider(pid))?;
		provider_models::insert(uow.conn(), &sample_model(new_id(), pid, "gpt"))?;
		let err = provider_models::insert(uow.conn(), &sample_model(new_id(), pid, "gpt"));
		assert!(matches!(err, Err(StorageError::Conflict(_))));
		Ok(())
	})
	.unwrap();
}

#[test]
fn same_model_key_across_providers_ok() {
	let (_dir, db) = setup();
	let p1 = new_id();
	let p2 = new_id();
	db.transaction(|uow| {
		provider_instances::insert(uow.conn(), &sample_provider(p1))?;
		let mut sp = sample_provider(p2);
		sp.display_name = "Other".into();
		provider_instances::insert(uow.conn(), &sp)?;
		provider_models::insert(uow.conn(), &sample_model(new_id(), p1, "gpt"))?;
		provider_models::insert(uow.conn(), &sample_model(new_id(), p2, "gpt"))?;
		Ok(())
	})
	.unwrap();
}

#[test]
fn profile_fallback_ordering_and_rollback() {
	let (_dir, db) = setup();
	let pid = new_id();
	let m1 = new_id();
	let m2 = new_id();
	let profile_id = new_id();
	db.transaction(|uow| {
		provider_instances::insert(uow.conn(), &sample_provider(pid))?;
		provider_models::insert(uow.conn(), &sample_model(m1, pid, "a"))?;
		provider_models::insert(uow.conn(), &sample_model(m2, pid, "b"))?;
		Ok(())
	})
	.unwrap();

	// Successful save
	db.transaction(|uow| {
		let now = now_rfc3339();
		let profile = TranslationProfile {
			id: profile_id,
			name: "Fast".into(),
			enabled: true,
			template_version: 1,
			system_template: "sys".into(),
			user_template: "Translate: {{text}}".into(),
			temperature: Some(0.2),
			max_output_tokens: Some(1024),
			provider_options_json: None,
			source_lang: Some("zh".into()),
			target_lang: Some("en".into()),
			created_at: now.clone(),
			updated_at: now,
		};
		let targets = vec![
			TranslationProfileTarget {
				translation_profile_id: profile_id,
				provider_model_id: m1,
				priority: 0,
			},
			TranslationProfileTarget {
				translation_profile_id: profile_id,
				provider_model_id: m2,
				priority: 1,
			},
		];
		translation_profiles::save_with_targets(uow.conn(), &profile, &targets, true)?;
		Ok(())
	})
	.unwrap();

	db.read(|conn| {
		let dto = translation_profiles::get(conn, profile_id)?;
		assert_eq!(dto.targets.len(), 2);
		assert_eq!(dto.targets[0].priority, 0);
		assert_eq!(dto.targets[1].provider_model_id, m2);
		Ok(())
	})
	.unwrap();

	// Failed transaction rolls back
	let err: Result<(), StorageError> = db.transaction(|uow| {
		translation_profiles::delete(uow.conn(), profile_id)?;
		Err(StorageError::Validation("force rollback".into()))
	});
	assert!(err.is_err());
	db.read(|conn| {
		assert!(translation_profiles::get(conn, profile_id).is_ok());
		Ok(())
	})
	.unwrap();
}

#[test]
fn delete_model_in_use_by_profile() {
	let (_dir, db) = setup();
	let pid = new_id();
	let mid = new_id();
	let profile_id = new_id();
	db.transaction(|uow| {
		provider_instances::insert(uow.conn(), &sample_provider(pid))?;
		provider_models::insert(uow.conn(), &sample_model(mid, pid, "gpt"))?;
		let now = now_rfc3339();
		let profile = TranslationProfile {
			id: profile_id,
			name: "P".into(),
			enabled: true,
			template_version: 1,
			system_template: "s".into(),
			user_template: "{{text}}".into(),
			temperature: None,
			max_output_tokens: None,
			provider_options_json: None,
			source_lang: None,
			target_lang: None,
			created_at: now.clone(),
			updated_at: now,
		};
		translation_profiles::save_with_targets(
			uow.conn(),
			&profile,
			&[TranslationProfileTarget {
				translation_profile_id: profile_id,
				provider_model_id: mid,
				priority: 0,
			}],
			true,
		)?;
		let err = provider_models::delete(uow.conn(), mid);
		assert!(matches!(err, Err(StorageError::InUse(_))));
		Ok(())
	})
	.unwrap();
}

#[test]
fn settings_singleton() {
	let (_dir, db) = setup();
	db.transaction(|uow| {
		let mut settings = app_settings::get(uow.conn())?;
		settings.theme = Some("dark".into());
		app_settings::update(uow.conn(), &settings)?;
		Ok(())
	})
	.unwrap();
	db.read(|conn| {
		let s = app_settings::get(conn)?;
		assert_eq!(s.theme.as_deref(), Some("dark"));
		assert_eq!(s.schema_version, AppSettingsV1::SCHEMA_VERSION);
		Ok(())
	})
	.unwrap();
}

#[test]
fn global_proxy_compare_and_set() {
	let (_dir, db) = setup();
	db.transaction(|uow| {
		assert!(app_credentials::get_global_proxy_ref(uow.conn())?.is_none());
		app_credentials::compare_and_set_global_proxy_ref(uow.conn(), None, Some("proxy/global/a"))?;
		assert_eq!(
			app_credentials::get_global_proxy_ref(uow.conn())?.as_deref(),
			Some("proxy/global/a")
		);
		let err = app_credentials::compare_and_set_global_proxy_ref(uow.conn(), None, Some("other"));
		assert!(matches!(err, Err(StorageError::Conflict(_))));
		Ok(())
	})
	.unwrap();
}

#[test]
fn credential_journal_one_active_per_owner() {
	let (_dir, db) = setup();
	let owner = new_id().to_string();
	db.transaction(|uow| {
		credential_operations::insert_prepared(
			uow.conn(),
			new_id(),
			credential_operations::OwnerKind::Provider,
			&owner,
			None,
			Some("provider/x/y"),
		)?;
		let err = credential_operations::insert_prepared(
			uow.conn(),
			new_id(),
			credential_operations::OwnerKind::Provider,
			&owner,
			None,
			Some("provider/x/z"),
		);
		assert!(matches!(err, Err(StorageError::CredentialBusy)));
		Ok(())
	})
	.unwrap();
}

#[test]
fn provider_reference_lifecycle() {
	// Creates provider/model/profile chain; referenced deletes return in_use; disable works.
	let (_dir, db) = setup();
	let pid = new_id();
	let mid = new_id();
	let profile_id = new_id();
	db.transaction(|uow| {
		provider_instances::insert(uow.conn(), &sample_provider(pid))?;
		provider_models::insert(uow.conn(), &sample_model(mid, pid, "gpt"))?;
		let now = now_rfc3339();
		let profile = TranslationProfile {
			id: profile_id,
			name: "Chain".into(),
			enabled: true,
			template_version: 1,
			system_template: "s".into(),
			user_template: "{{text}}".into(),
			temperature: None,
			max_output_tokens: None,
			provider_options_json: None,
			source_lang: None,
			target_lang: None,
			created_at: now.clone(),
			updated_at: now,
		};
		translation_profiles::save_with_targets(
			uow.conn(),
			&profile,
			&[TranslationProfileTarget {
				translation_profile_id: profile_id,
				provider_model_id: mid,
				priority: 0,
			}],
			true,
		)?;
		assert!(matches!(
			provider_models::delete(uow.conn(), mid),
			Err(StorageError::InUse(_))
		));
		assert!(matches!(
			provider_instances::delete(uow.conn(), pid),
			Err(StorageError::InUse(_))
		));
		provider_instances::set_enabled(uow.conn(), pid, false, &now_rfc3339())?;
		provider_models::set_enabled(uow.conn(), mid, false, &now_rfc3339())?;
		// Profile and targets remain.
		let dto = translation_profiles::get(uow.conn(), profile_id)?;
		assert_eq!(dto.targets.len(), 1);
		Ok(())
	})
	.unwrap();
}
