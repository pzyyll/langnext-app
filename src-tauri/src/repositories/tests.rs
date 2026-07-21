// ABOUTME: Repository behavior and referential-integrity tests.
// ABOUTME: Exercises CRUD, uniqueness, rollback, and credential journal rules.
use crate::domain::model::{Availability, ModelSource, ProviderModel};
use crate::domain::provider::{CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode};
use crate::domain::settings::AppSettingsV1;
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{PromptTemplate, TranslationProfile, TranslationProfileTarget};
use crate::error::StorageError;
use crate::domain::ocr_service::{BaiduOcrAction, OcrPromptTemplate, OcrProviderType, OcrService};
use crate::repositories::{
  app_credentials, app_settings, credential_operations, ocr_prompt_templates, ocr_services, provider_instances,
  provider_models, translation_profiles,
};
use crate::storage::Database;
use uuid::Uuid;

fn default_templates(system: &str, user: &str) -> (Uuid, Vec<PromptTemplate>) {
  let id = new_id();
  (
    id,
    vec![PromptTemplate {
      id,
      name: "Default".into(),
      system_template: system.into(),
      user_template: user.into(),
    }],
  )
}

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
    let (profile, prompt_templates) = {
      let (template_id, prompt_templates) = default_templates("sys", "Translate: {{text}}");
      let profile = TranslationProfile {
        id: profile_id,
        name: "Fast".into(),
        enabled: true,
        template_version: 1,
        default_prompt_template_id: template_id,
        temperature: Some(0.2),
        max_output_tokens: Some(1024),
        provider_options_json: None,
        source_lang: Some("zh".into()),
        target_lang: Some("en".into()),
        primary_lang: None,
        preferred_target_lang: None,
        language_detection: None,
        created_at: now.clone(),
        updated_at: now,
      };
      (profile, prompt_templates)
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
    translation_profiles::save_with_targets(uow.conn(), &profile, &targets, &prompt_templates, true)?;
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
fn profile_language_preferences_round_trip() {
  let (_dir, db) = setup();
  let pid = new_id();
  let mid = new_id();
  let profile_id = new_id();
  db.transaction(|uow| {
    provider_instances::insert(uow.conn(), &sample_provider(pid))?;
    provider_models::insert(uow.conn(), &sample_model(mid, pid, "a"))?;
    Ok(())
  })
  .unwrap();

  let now = now_rfc3339();
  let (profile, prompt_templates) = {
    let (template_id, prompt_templates) = default_templates("sys", "Translate: {{text}}");
    let profile = TranslationProfile {
      id: profile_id,
      name: "Prefs".into(),
      enabled: true,
      template_version: 1,
      default_prompt_template_id: template_id,
      temperature: Some(0.2),
      max_output_tokens: Some(1024),
      provider_options_json: None,
      source_lang: Some("auto".into()),
      target_lang: Some("auto".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      language_detection: None,
      created_at: now.clone(),
      updated_at: now,
    };
    (profile, prompt_templates)
  };
  db.transaction(|uow| {
    translation_profiles::save_with_targets(
      uow.conn(),
      &profile,
      &[TranslationProfileTarget {
        translation_profile_id: profile_id,
        provider_model_id: mid,
        priority: 0,
      }],
      &prompt_templates,
      true,
    )?;
    Ok(())
  })
  .unwrap();

  db.read(|conn| {
    let dto = translation_profiles::get(conn, profile_id)?;
    assert_eq!(dto.profile.primary_lang.as_deref(), Some("zh"));
    assert_eq!(dto.profile.preferred_target_lang.as_deref(), Some("en"));
    assert_eq!(dto.profile.target_lang.as_deref(), Some("auto"));
    Ok(())
  })
  .unwrap();

  // Update clears the preferences back to legacy NULLs.
  let mut cleared = profile;
  cleared.primary_lang = None;
  cleared.preferred_target_lang = None;
  cleared.updated_at = now_rfc3339();
  db.transaction(|uow| {
    translation_profiles::update_profile(uow.conn(), &cleared)?;
    Ok(())
  })
  .unwrap();
  db.read(|conn| {
    let dto = translation_profiles::get(conn, profile_id)?;
    assert_eq!(dto.profile.primary_lang, None);
    assert_eq!(dto.profile.preferred_target_lang, None);
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
    let (profile, prompt_templates) = {
      let (template_id, prompt_templates) = default_templates("s", "{{text}}");
      let profile = TranslationProfile {
        id: profile_id,
        name: "P".into(),
        enabled: true,
        template_version: 1,
        default_prompt_template_id: template_id,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: None,
        preferred_target_lang: None,
        language_detection: None,
        created_at: now.clone(),
        updated_at: now,
      };
      (profile, prompt_templates)
    };
    translation_profiles::save_with_targets(
      uow.conn(),
      &profile,
      &[TranslationProfileTarget {
        translation_profile_id: profile_id,
        provider_model_id: mid,
        priority: 0,
      }],
      &prompt_templates,
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

fn sample_baidu_ocr(id: Uuid, name: &str) -> OcrService {
  let now = now_rfc3339();
  OcrService {
    id,
    provider_type: OcrProviderType::Baidu,
    display_name: name.into(),
    enabled: true,
    sort_order: 0,
    baidu_action: Some(BaiduOcrAction::Accurate),
    api_key_ref: None,
    secret_key_ref: None,
    provider_model_id: None,
    temperature: None,
    default_prompt_template_id: None,
    created_at: now.clone(),
    updated_at: now,
  }
}

fn sample_ai_ocr(id: Uuid, model_id: Uuid, default_template_id: Uuid, name: &str) -> OcrService {
  let now = now_rfc3339();
  OcrService {
    id,
    provider_type: OcrProviderType::Ai,
    display_name: name.into(),
    enabled: true,
    sort_order: 0,
    baidu_action: None,
    api_key_ref: None,
    secret_key_ref: None,
    provider_model_id: Some(model_id),
    temperature: Some(0.2),
    default_prompt_template_id: Some(default_template_id),
    created_at: now.clone(),
    updated_at: now,
  }
}

#[test]
fn ocr_service_crud_list_order_and_template_cascade() {
  let (_dir, db) = setup();
  let baidu_a = new_id();
  let baidu_b = new_id();
  let ai_id = new_id();
  let provider_id = new_id();
  let model_id = new_id();
  let template_a = new_id();
  let template_b = new_id();

  db.transaction(|uow| {
    provider_instances::insert(uow.conn(), &sample_provider(provider_id))?;
    provider_models::insert(uow.conn(), &sample_model(model_id, provider_id, "vision"))?;

    // Insert order determines auto sort_order: 0, 1, 2.
    ocr_services::insert(uow.conn(), &sample_baidu_ocr(baidu_a, "Baidu A"))?;
    ocr_services::insert(uow.conn(), &sample_baidu_ocr(baidu_b, "Baidu B"))?;
    ocr_services::insert(
      uow.conn(),
      &sample_ai_ocr(ai_id, model_id, template_a, "AI OCR"),
    )?;

    ocr_prompt_templates::replace_for_service(
      uow.conn(),
      ai_id,
      &[
        OcrPromptTemplate {
          id: template_a,
          name: "Default".into(),
          system_template: "sys-a".into(),
          user_template: "user-a".into(),
        },
        OcrPromptTemplate {
          id: template_b,
          name: "Alt".into(),
          system_template: "sys-b".into(),
          user_template: "user-b".into(),
        },
      ],
    )?;
    Ok(())
  })
  .unwrap();

  db.read(|conn| {
    let list = ocr_services::list(conn)?;
    assert_eq!(list.len(), 3);
    assert_eq!(list[0].id, baidu_a);
    assert_eq!(list[0].sort_order, 0);
    assert_eq!(list[1].id, baidu_b);
    assert_eq!(list[1].sort_order, 1);
    assert_eq!(list[2].id, ai_id);
    assert_eq!(list[2].sort_order, 2);

    let templates = ocr_prompt_templates::list_for_service(conn, ai_id)?;
    assert_eq!(templates.len(), 2);
    assert_eq!(templates[0].id, template_a);
    assert_eq!(templates[0].name, "Default");
    assert_eq!(templates[1].id, template_b);
    assert_eq!(templates[1].name, "Alt");

    let all_templates = ocr_prompt_templates::list_all(conn)?;
    assert_eq!(all_templates.len(), 2);
    assert_eq!(all_templates[0].sort_order, 0);
    assert_eq!(all_templates[1].sort_order, 1);
    Ok(())
  })
  .unwrap();

  // Update configuration (keep credentials) + replace templates.
  let now = now_rfc3339();
  let template_c = new_id();
  db.transaction(|uow| {
    ocr_services::update_configuration_keep_credentials(
      uow.conn(),
      baidu_a,
      "Baidu A Renamed",
      false,
      Some(BaiduOcrAction::GeneralBasic),
      None,
      None,
      None,
      &now,
    )?;
    ocr_services::update_configuration_keep_credentials(
      uow.conn(),
      ai_id,
      "AI OCR Renamed",
      true,
      None,
      Some(model_id),
      Some(0.5),
      Some(template_c),
      &now,
    )?;
    ocr_prompt_templates::replace_for_service(
      uow.conn(),
      ai_id,
      &[OcrPromptTemplate {
        id: template_c,
        name: "Only".into(),
        system_template: "sys-c".into(),
        user_template: "user-c".into(),
      }],
    )?;
    Ok(())
  })
  .unwrap();

  db.read(|conn| {
    let baidu = ocr_services::get(conn, baidu_a)?;
    assert_eq!(baidu.display_name, "Baidu A Renamed");
    assert!(!baidu.enabled);
    assert_eq!(baidu.baidu_action, Some(BaiduOcrAction::GeneralBasic));

    let ai = ocr_services::get(conn, ai_id)?;
    assert_eq!(ai.display_name, "AI OCR Renamed");
    assert_eq!(ai.temperature, Some(0.5));
    assert_eq!(ai.default_prompt_template_id, Some(template_c));

    let templates = ocr_prompt_templates::list_for_service(conn, ai_id)?;
    assert_eq!(templates.len(), 1);
    assert_eq!(templates[0].id, template_c);
    assert_eq!(templates[0].name, "Only");
    Ok(())
  })
  .unwrap();

  // Delete AI service cascades prompt templates.
  db.transaction(|uow| {
    ocr_services::delete(uow.conn(), ai_id)?;
    Ok(())
  })
  .unwrap();

  db.read(|conn| {
    assert!(matches!(ocr_services::get(conn, ai_id), Err(StorageError::NotFound(_))));
    let templates = ocr_prompt_templates::list_for_service(conn, ai_id)?;
    assert!(templates.is_empty());
    let all_templates = ocr_prompt_templates::list_all(conn)?;
    assert!(all_templates.is_empty());

    let remaining = ocr_services::list(conn)?;
    assert_eq!(remaining.len(), 2);
    assert_eq!(remaining[0].id, baidu_a);
    assert_eq!(remaining[1].id, baidu_b);
    Ok(())
  })
  .unwrap();

  // Delete remaining Baidu rows.
  db.transaction(|uow| {
    ocr_services::delete(uow.conn(), baidu_a)?;
    ocr_services::delete(uow.conn(), baidu_b)?;
    Ok(())
  })
  .unwrap();
  db.read(|conn| {
    assert!(ocr_services::list(conn)?.is_empty());
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
    let (profile, prompt_templates) = {
      let (template_id, prompt_templates) = default_templates("s", "{{text}}");
      let profile = TranslationProfile {
        id: profile_id,
        name: "Chain".into(),
        enabled: true,
        template_version: 1,
        default_prompt_template_id: template_id,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: None,
        preferred_target_lang: None,
        language_detection: None,
        created_at: now.clone(),
        updated_at: now,
      };
      (profile, prompt_templates)
    };
    translation_profiles::save_with_targets(
      uow.conn(),
      &profile,
      &[TranslationProfileTarget {
        translation_profile_id: profile_id,
        provider_model_id: mid,
        priority: 0,
      }],
      &prompt_templates,
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
