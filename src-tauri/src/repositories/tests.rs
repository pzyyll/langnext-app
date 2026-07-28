// ABOUTME: Repository behavior and referential-integrity tests.
// ABOUTME: Exercises CRUD, uniqueness, rollback, and credential journal rules.
use crate::domain::model::{Availability, ModelSource, ProviderModel};
use crate::domain::ocr_service::{BaiduOcrAction, OcrPromptTemplate, OcrProviderType, OcrService};
use crate::domain::plugin_package::{
  InstallOperationState, InstalledPluginVersion, PluginPackageApproval, PluginPublisher, PublisherDecision,
  PublisherSource,
};
use crate::domain::provider::{
  AuthSchemeV1, BaseUrlSource, CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode,
};
use crate::domain::service_integration::{IntegrationCredentialBinding, IntegrationHealthStatus, IntegrationInstance};
use crate::domain::settings::AppSettingsV1;
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{
  LlmModelChainEngine, PromptTemplate, TranslationProfile, TranslationProfileEngine, TranslationProfileTarget,
};
use crate::error::StorageError;
use crate::repositories::{
  app_credentials, app_settings, credential_operations, installed_plugin_versions, integration_credential_bindings,
  integration_instances, ocr_prompt_templates, ocr_services, plugin_install_operations, plugin_package_approvals,
  plugin_permission_grants, plugin_publishers, provider_instances, provider_models, translation_profiles,
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
    base_url: "https://api.openai.com/v1".into(),
    base_url_source: BaseUrlSource::PluginDefault,
    auth_scheme: AuthSchemeV1::none(),
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
        source_lang: Some("zh".into()),
        target_lang: Some("en".into()),
        primary_lang: None,
        preferred_target_lang: None,
        engine: TranslationProfileEngine::LlmModelChain(LlmModelChainEngine {
          template_version: 1,
          default_prompt_template_id: template_id,
          temperature: Some(0.2),
          max_output_tokens: Some(1024),
          provider_options_json: None,
          language_detection: None,
        }),
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
      source_lang: Some("auto".into()),
      target_lang: Some("auto".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngine::LlmModelChain(LlmModelChainEngine {
        template_version: 1,
        default_prompt_template_id: template_id,
        temperature: Some(0.2),
        max_output_tokens: Some(1024),
        provider_options_json: None,
        language_detection: None,
      }),
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
        source_lang: None,
        target_lang: None,
        primary_lang: None,
        preferred_target_lang: None,
        engine: TranslationProfileEngine::LlmModelChain(LlmModelChainEngine {
          template_version: 1,
          default_prompt_template_id: template_id,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
        }),
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
    integration_instance_id: None,
    ocr_capability_id: None,
    capability_preferences_version: None,
    capability_preferences: None,
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
    integration_instance_id: None,
    ocr_capability_id: None,
    capability_preferences_version: None,
    capability_preferences: None,
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
    ocr_services::insert(uow.conn(), &sample_ai_ocr(ai_id, model_id, template_a, "AI OCR"))?;

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
        source_lang: None,
        target_lang: None,
        primary_lang: None,
        preferred_target_lang: None,
        engine: TranslationProfileEngine::LlmModelChain(LlmModelChainEngine {
          template_version: 1,
          default_prompt_template_id: template_id,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
        }),
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

#[test]
fn provider_transport_contract_migration_backfills_auth_and_base_url() {
  use crate::storage::migrations::{self, MIGRATIONS};
  use rusqlite::Connection;

  let mut conn = Connection::open_in_memory().unwrap();
  // Apply through v10 (pre-transport-contract).
  migrations::migrate_with(&mut conn, &MIGRATIONS[..10]).unwrap();
  conn
    .execute_batch(
      r#"
      INSERT INTO provider_instances (
        id, adapter_id, display_name, base_url_override, credential_kind, credential_ref,
        enabled, proxy_mode, models_sync_status, created_at, updated_at, sort_order
      ) VALUES
      ('p-openai-auth', 'openai-compatible', 'OAI Auth', NULL, 'api_key', 'provider/x/y', 1, 'inherit', 'never', 't', 't', 0),
      ('p-openai-none', 'openai-compatible', 'OAI None', NULL, 'none', NULL, 1, 'inherit', 'never', 't', 't', 1),
      ('p-custom', 'openai-compatible', 'Custom', 'https://relay.example.com/v1', 'api_key', NULL, 1, 'inherit', 'never', 't', 't', 2),
      ('p-anthropic', 'anthropic', 'Anthropic', NULL, 'api_key', NULL, 1, 'inherit', 'never', 't', 't', 3),
      ('p-gemini', 'gemini', 'Gemini', NULL, 'api_key', NULL, 1, 'inherit', 'never', 't', 't', 4),
      ('p-deepseek-none', 'deepseek', 'DeepSeek', NULL, 'none', NULL, 1, 'inherit', 'never', 't', 't', 5);
      "#,
    )
    .unwrap();

  migrations::migrate(&mut conn).unwrap();
  assert_eq!(
    migrations::read_user_version(&conn).unwrap(),
    migrations::latest_version()
  );

  let rows: Vec<(String, String, String, String, String)> = {
    let mut stmt = conn
      .prepare(
        "SELECT id, base_url, base_url_source, auth_scheme_json, credential_kind
         FROM provider_instances ORDER BY sort_order",
      )
      .unwrap();
    stmt
      .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
      .unwrap()
      .map(|r| r.unwrap())
      .collect()
  };

  let by_id: std::collections::HashMap<_, _> = rows.into_iter().map(|r| (r.0.clone(), r)).collect();

  let openai_auth = &by_id["p-openai-auth"];
  assert_eq!(openai_auth.1, "https://api.openai.com/v1");
  assert_eq!(openai_auth.2, "plugin_default");
  assert!(openai_auth.3.contains("\"type\":\"bearer\""));

  let openai_none = &by_id["p-openai-none"];
  assert_eq!(openai_none.2, "plugin_default");
  assert!(openai_none.3.contains("\"type\":\"none\""));

  let custom = &by_id["p-custom"];
  assert_eq!(custom.1, "https://relay.example.com/v1");
  assert_eq!(custom.2, "custom");
  assert!(custom.3.contains("\"type\":\"bearer\""));

  let anthropic = &by_id["p-anthropic"];
  assert_eq!(anthropic.1, "https://api.anthropic.com");
  assert!(anthropic.3.contains("x-api-key"));
  assert!(anthropic.3.contains("\"type\":\"header\""));

  let gemini = &by_id["p-gemini"];
  assert_eq!(gemini.1, "https://generativelanguage.googleapis.com");
  assert!(gemini.3.contains("\"type\":\"query\""));
  assert!(gemini.3.contains("\"name\":\"key\""));

  let deepseek = &by_id["p-deepseek-none"];
  assert_eq!(deepseek.1, "https://api.deepseek.com");
  assert!(deepseek.3.contains("\"type\":\"none\""));
}

#[test]
fn provider_transport_contract_model_override_inventory_preserved() {
  use crate::storage::migrations::{self, MIGRATIONS};
  use rusqlite::Connection;

  let mut conn = Connection::open_in_memory().unwrap();
  migrations::migrate_with(&mut conn, &MIGRATIONS[..10]).unwrap();
  conn
    .execute_batch(
      r#"
      INSERT INTO provider_instances (
        id, adapter_id, display_name, base_url_override, credential_kind, credential_ref,
        enabled, proxy_mode, models_sync_status, created_at, updated_at, sort_order
      ) VALUES
      ('p1', 'openai-compatible', 'OAI', NULL, 'api_key', NULL, 1, 'inherit', 'never', 't', 't', 0);
      "#,
    )
    .unwrap();
  migrations::migrate(&mut conn).unwrap();
  // Preserve cross-plugin model override inventory after transport migration.
  conn
    .execute_batch(
      r#"
      INSERT INTO provider_models (
        id, provider_instance_id, model_key, source, enabled, availability, adapter_id, created_at, updated_at
      ) VALUES
      ('m1', 'p1', 'gemini-pro', 'manual', 1, 'available', 'gemini', 't', 't');
      "#,
    )
    .unwrap();

  let (provider_adapter, model_adapter, base_url_source): (String, String, String) = conn
    .query_row(
      "SELECT p.adapter_id, m.adapter_id, p.base_url_source
       FROM provider_instances p
       JOIN provider_models m ON m.provider_instance_id = p.id
       WHERE m.id = 'm1'",
      [],
      |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .unwrap();
  assert_eq!(provider_adapter, "openai-compatible");
  assert_eq!(model_adapter, "gemini");
  assert_eq!(base_url_source, "plugin_default");
}

#[test]
fn integration_instance_crud_cas_and_slot_isolation() {
  let (_dir, db) = setup();
  let id = new_id();
  let now = now_rfc3339();
  let instance = IntegrationInstance {
    id,
    plugin_id: "com.langnext.google-cloud".into(),
    plugin_version: "1.0.0".into(),
    display_name: "GCP".into(),
    enabled: true,
    config_json: r#"{"projectId":"p","location":"global","proxyMode":"inherit"}"#.into(),
    config_schema_version: 1,
    health_status: IntegrationHealthStatus::Unconfigured,
    last_validated_at: None,
    last_error_code: None,
    runtime_kind: "bundled-rust".into(),
    package_digest: None,
    execution_grant_set_revision: None,
    runtime_state: "active".into(),
    runtime_error_code: None,
    runtime_error_message: None,
    runtime_requirement_json: None,
    created_at: now.clone(),
    updated_at: now.clone(),
  };

  db.transaction(|uow| {
    integration_instances::insert(uow.conn(), &instance)?;
    let slot_a = IntegrationCredentialBinding {
      id: new_id(),
      integration_instance_id: id,
      slot_id: "service-account-json".into(),
      credential_ref: None,
      credential_revision: 0,
      created_at: now.clone(),
      updated_at: now.clone(),
    };
    integration_credential_bindings::insert(uow.conn(), &slot_a)?;
    // Slot uniqueness
    let dup = IntegrationCredentialBinding {
      id: new_id(),
      integration_instance_id: id,
      slot_id: "service-account-json".into(),
      credential_ref: None,
      credential_revision: 0,
      created_at: now.clone(),
      updated_at: now.clone(),
    };
    let err = integration_credential_bindings::insert(uow.conn(), &dup);
    assert!(matches!(err, Err(StorageError::Conflict(_))));

    let updated = integration_credential_bindings::compare_and_set_ref(
      uow.conn(),
      id,
      "service-account-json",
      None,
      Some("integration/x/service-account-json/op"),
      "t2",
    )?;
    assert_eq!(updated.credential_revision, 1);
    assert!(updated.credential_ref.is_some());

    let cleared = integration_credential_bindings::compare_and_set_ref(
      uow.conn(),
      id,
      "service-account-json",
      Some("integration/x/service-account-json/op"),
      None,
      "t3",
    )?;
    assert_eq!(cleared.credential_revision, 2);
    assert!(cleared.credential_ref.is_none());

    // CAS conflict on instance
    let err = integration_instances::compare_and_set(
      uow.conn(),
      id,
      "stale",
      "GCP2",
      true,
      &instance.config_json,
      1,
      IntegrationHealthStatus::Unvalidated,
      None,
      None,
      "t4",
    );
    assert!(matches!(err, Err(StorageError::Conflict(_))));

    // Journal: primary slot uniqueness still holds for provider
    let owner = new_id().to_string();
    credential_operations::insert_prepared(
      uow.conn(),
      new_id(),
      credential_operations::OwnerKind::Provider,
      &owner,
      None,
      Some("provider/a/b"),
    )?;
    let err = credential_operations::insert_prepared(
      uow.conn(),
      new_id(),
      credential_operations::OwnerKind::Provider,
      &owner,
      None,
      Some("provider/a/c"),
    );
    assert!(matches!(err, Err(StorageError::CredentialBusy)));

    // Integration slots are independent from each other
    credential_operations::insert_prepared_slot(
      uow.conn(),
      new_id(),
      credential_operations::OwnerKind::Integration,
      &id.to_string(),
      "service-account-json",
      None,
      Some("integration/x/service-account-json/op2"),
    )?;
    credential_operations::insert_prepared_slot(
      uow.conn(),
      new_id(),
      credential_operations::OwnerKind::Integration,
      &id.to_string(),
      "other-slot",
      None,
      Some("integration/x/other-slot/op"),
    )?;

    // OCR two owners remain independent on primary slot
    let ocr_id = new_id().to_string();
    credential_operations::insert_prepared(
      uow.conn(),
      new_id(),
      credential_operations::OwnerKind::OcrApiKey,
      &ocr_id,
      None,
      Some("ocr/a/api_key/op"),
    )?;
    credential_operations::insert_prepared(
      uow.conn(),
      new_id(),
      credential_operations::OwnerKind::OcrSecretKey,
      &ocr_id,
      None,
      Some("ocr/a/secret_key/op"),
    )?;

    integration_credential_bindings::delete_for_instance(uow.conn(), id)?;
    integration_instances::delete(uow.conn(), id)?;
    Ok(())
  })
  .unwrap();
}

#[test]
fn installed_plugin_package_lifecycle_constraints() {
  let (_dir, db) = setup();
  let digest = "a".repeat(64);
  let other_digest = "b".repeat(64);
  let now = now_rfc3339();
  let key_id = "com.example.keys.1";
  let fingerprint = "c".repeat(64);

  db.transaction(|uow| {
    plugin_publishers::insert(
      uow.conn(),
      &PluginPublisher {
        key_id: key_id.into(),
        fingerprint: fingerprint.clone(),
        public_key_hex: "d".repeat(64),
        source: PublisherSource::UserApproved,
        enabled: true,
        revoked: false,
        created_at: now.clone(),
        updated_at: now.clone(),
      },
    )?;
    installed_plugin_versions::insert(
      uow.conn(),
      &InstalledPluginVersion {
        package_digest: digest.clone(),
        plugin_id: "com.example.translate".into(),
        version: "1.0.0".into(),
        publisher_key_id: key_id.into(),
        publisher_fingerprint: fingerprint.clone(),
        runtime_kind: "wasm-component".into(),
        manifest_json: "{}".into(),
        permission_request_digest: "e".repeat(64),
        content_available: true,
        installed_at: now.clone(),
      },
    )?;
    // Unique (plugin_id, version)
    let conflict = installed_plugin_versions::insert(
      uow.conn(),
      &InstalledPluginVersion {
        package_digest: other_digest.clone(),
        plugin_id: "com.example.translate".into(),
        version: "1.0.0".into(),
        publisher_key_id: key_id.into(),
        publisher_fingerprint: fingerprint.clone(),
        runtime_kind: "wasm-component".into(),
        manifest_json: "{}".into(),
        permission_request_digest: "e".repeat(64),
        content_available: true,
        installed_at: now.clone(),
      },
    );
    assert!(matches!(conflict, Err(StorageError::Conflict(_))));

    let approval_id = new_id();
    plugin_package_approvals::insert(
      uow.conn(),
      &PluginPackageApproval {
        id: approval_id,
        package_digest: digest.clone(),
        revision: 1,
        publisher_key_id: key_id.into(),
        publisher_decision: PublisherDecision::UserApproved,
        permission_request_digest: "e".repeat(64),
        approved_at: now.clone(),
      },
    )?;
    assert_eq!(plugin_package_approvals::next_revision(uow.conn(), &digest)?, 2);

    // Package approval id cannot satisfy execution grant-set lookup.
    assert!(plugin_package_approvals::get_execution_grant_set(uow.conn(), approval_id)?.is_none());

    installed_plugin_versions::set_default(uow.conn(), "com.example.translate", &digest)?;

    // ON DELETE RESTRICT: cannot delete version while approval references it.
    let del = installed_plugin_versions::delete(uow.conn(), &digest);
    assert!(del.is_err());

    plugin_package_approvals::delete_for_package(uow.conn(), &digest)?;
    installed_plugin_versions::clear_default_if_matches(uow.conn(), &digest)?;
    installed_plugin_versions::delete(uow.conn(), &digest)?;

    let op_id = new_id();
    let op = plugin_install_operations::insert_prepared(uow.conn(), op_id, "/tmp/staging")?;
    assert_eq!(op.state, InstallOperationState::Prepared);
    plugin_install_operations::mark_verified(uow.conn(), op_id, &digest)?;
    plugin_install_operations::mark_db_committed(uow.conn(), op_id)?;
    plugin_install_operations::mark_finalized(uow.conn(), op_id)?;
    Ok(())
  })
  .unwrap();
}

#[test]
fn runtime_instance_pin_backfill_and_constraints() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let now = now_rfc3339();
  let id = new_id();

  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id,
        plugin_id: "com.langnext.google-cloud".into(),
        plugin_version: "1.0.0".into(),
        display_name: "Cloud".into(),
        enabled: true,
        config_json: "{}".into(),
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
        last_validated_at: None,
        last_error_code: None,
        runtime_kind: "bundled-rust".into(),
        package_digest: None,
        execution_grant_set_revision: None,
        runtime_state: "active".into(),
        runtime_error_code: None,
        runtime_error_message: None,
        runtime_requirement_json: None,
        created_at: now.clone(),
        updated_at: now.clone(),
      },
    )?;
    let loaded = integration_instances::get(uow.conn(), id)?;
    assert_eq!(loaded.runtime_kind, "bundled-rust");
    assert!(loaded.package_digest.is_none());
    assert!(loaded.execution_grant_set_revision.is_none());

    // Invalid wasm pin without package/grant is rejected by SQLite CHECK.
    let bad = uow.conn().execute(
      "INSERT INTO integration_instances (
            id, plugin_id, plugin_version, display_name, enabled,
            config_json, config_schema_version, health_status,
            runtime_kind, package_digest, execution_grant_set_revision,
            runtime_state, created_at, updated_at
        ) VALUES (
            'bad-wasm', 'com.example.x', '1.0.0', 'Bad', 1,
            '{}', 1, 'ready',
            'wasm-component', NULL, NULL,
            'active', ?1, ?1
        )",
      rusqlite::params![now],
    );
    assert!(bad.is_err());
    Ok(())
  })
  .unwrap();
}

#[test]
fn runtime_instance_pin_package_approval_never_authorizes_execution() {
  let (_dir, db) = setup();
  let digest = "a".repeat(64);
  let now = now_rfc3339();
  let key_id = "com.example.keys.auth";
  let fingerprint = "c".repeat(64);
  let approval_id = new_id();
  let subject_a = new_id();
  let subject_b = new_id();
  let provider_subject = new_id();

  db.transaction(|uow| {
    plugin_publishers::insert(
      uow.conn(),
      &PluginPublisher {
        key_id: key_id.into(),
        fingerprint: fingerprint.clone(),
        public_key_hex: "d".repeat(64),
        source: PublisherSource::UserApproved,
        enabled: true,
        revoked: false,
        created_at: now.clone(),
        updated_at: now.clone(),
      },
    )?;
    installed_plugin_versions::insert(
      uow.conn(),
      &InstalledPluginVersion {
        package_digest: digest.clone(),
        plugin_id: "com.example.translate".into(),
        version: "1.0.0".into(),
        publisher_key_id: key_id.into(),
        publisher_fingerprint: fingerprint.clone(),
        runtime_kind: "wasm-component".into(),
        manifest_json: "{}".into(),
        permission_request_digest: "e".repeat(64),
        content_available: true,
        installed_at: now.clone(),
      },
    )?;
    plugin_package_approvals::insert(
      uow.conn(),
      &PluginPackageApproval {
        id: approval_id,
        package_digest: digest.clone(),
        revision: 1,
        publisher_key_id: key_id.into(),
        publisher_decision: PublisherDecision::UserApproved,
        permission_request_digest: "e".repeat(64),
        approved_at: now.clone(),
      },
    )?;
    // Package approval id must never satisfy execution grant lookup.
    assert!(plugin_package_approvals::get_execution_grant_set(uow.conn(), approval_id)?.is_none());
    assert!(matches!(
      plugin_permission_grants::reject_if_package_approval_id(uow.conn(), approval_id),
      Err(StorageError::Validation(_))
    ));

    // Build full authority entries for subject A (capability + network + empty pages).
    use crate::domain::runtime_lifecycle::{
      CapabilityGrantEntryRecord, ExecutionGrantSetBundle, ExecutionGrantSetRecord, GrantSubjectKind,
      NetworkGrantEntryRecord, PageGrantEntryRecord,
    };
    use crate::domain::runtime_plugin::{
      AuthPolicyId, CapabilityId, EndpointId, HttpMethod, HttpsOrigin, NetworkGrantEntry, ResourceLimits,
      compute_authority_digest,
    };
    let grant_a = new_id();
    let caps = vec![CapabilityId::parse("translate.text@1").unwrap()];
    let net = vec![NetworkGrantEntry::new(
      CapabilityId::parse("translate.text@1").unwrap(),
      EndpointId::parse("approved").unwrap(),
      HttpsOrigin::parse("https://conformance.example").unwrap(),
      HttpMethod::Get,
      AuthPolicyId::parse("host.none.v1").unwrap(),
      ResourceLimits::default(),
    )];
    let authority = compute_authority_digest(&caps, &net, &[]);
    let bundle_a = ExecutionGrantSetBundle {
      header: ExecutionGrantSetRecord {
        id: grant_a,
        revision: 1,
        subject_kind: GrantSubjectKind::IntegrationInstance,
        subject_id: subject_a,
        plugin_id: "com.example.translate".into(),
        plugin_version: "1.0.0".into(),
        package_digest: digest.clone(),
        permission_request_digest: "e".repeat(64),
        authority_digest: authority.as_str().to_string(),
        approved_at: now.clone(),
      },
      capabilities: vec![CapabilityGrantEntryRecord {
        id: new_id(),
        grant_set_id: grant_a,
        capability_id: "translate.text@1".into(),
      }],
      network: vec![NetworkGrantEntryRecord {
        id: new_id(),
        grant_set_id: grant_a,
        capability_id: "translate.text@1".into(),
        endpoint_id: "approved".into(),
        origin: "https://conformance.example".into(),
        method: "GET".into(),
        auth_policy: "host.none.v1".into(),
        resource_mode: "bounded".into(),
        max_request_bytes: 1024 * 1024,
        max_response_bytes: 8 * 1024 * 1024,
        max_stream_bytes: 16 * 1024 * 1024,
        timeout_ms: 20_000,
      }],
      // Phase 9: page authority remains empty until explicit approval.
      pages: Vec::<PageGrantEntryRecord>::new(),
    };
    plugin_permission_grants::insert_bundle(uow.conn(), &bundle_a)?;

    // Cross-instance denial: subject B cannot load subject A grant.
    assert!(matches!(
      plugin_permission_grants::get_bundle_for_subject_package_revision(
        uow.conn(),
        GrantSubjectKind::IntegrationInstance,
        subject_b,
        &digest,
        1,
      ),
      Err(StorageError::NotFound(_))
    ));

    // Cross-provider-instance denial: provider subject cannot load integration grant.
    assert!(matches!(
      plugin_permission_grants::get_bundle_for_subject_package_revision(
        uow.conn(),
        GrantSubjectKind::ProviderInstance,
        provider_subject,
        &digest,
        1,
      ),
      Err(StorageError::NotFound(_))
    ));

    // Cross-capability: grant has translate.text@1 only — OCR capability entry absent.
    let loaded = plugin_permission_grants::get_bundle(uow.conn(), grant_a)?;
    assert!(!loaded.capabilities.iter().any(|c| c.capability_id == "ocr.image@1"));
    // Cross-origin / method / auth / resource mode: only the exact network tuple is present.
    assert_eq!(loaded.network.len(), 1);
    assert_eq!(loaded.network[0].origin, "https://conformance.example");
    assert_eq!(loaded.network[0].method, "GET");
    assert_eq!(loaded.network[0].auth_policy, "host.none.v1");
    assert_eq!(loaded.network[0].resource_mode, "bounded");
    assert!(!loaded.network.iter().any(|n| n.origin == "https://other.example"));
    assert!(!loaded.network.iter().any(|n| n.method == "POST"));
    assert!(!loaded.network.iter().any(|n| n.auth_policy == "host.api-key.header.v1"));
    assert!(!loaded.network.iter().any(|n| n.resource_mode == "unlimited"));

    // Page / action / delegation fixtures: insert a page entry and deny mismatched lookups.
    let page_id = new_id();
    uow.conn().execute(
      "INSERT INTO execution_grant_page_entries (
            id, grant_set_id, page_id, allowed_actions_json,
            delegated_capability_majors_json, delegated_endpoint_aliases_json
        ) VALUES (?1, ?2, 'settings-page', '[\"open\"]', '[\"translate.text@1\"]', '[\"approved\"]')",
      rusqlite::params![page_id.to_string(), grant_a.to_string()],
    )?;
    let with_page = plugin_permission_grants::get_bundle(uow.conn(), grant_a)?;
    assert_eq!(with_page.pages.len(), 1);
    assert_eq!(with_page.pages[0].page_id, "settings-page");
    assert_eq!(with_page.pages[0].allowed_actions, vec!["open".to_string()]);
    assert_eq!(
      with_page.pages[0].delegated_capability_majors,
      vec!["translate.text@1".to_string()]
    );
    assert_eq!(
      with_page.pages[0].delegated_endpoint_aliases,
      vec!["approved".to_string()]
    );
    // Cross-page / cross-action / cross-delegation denials (entry present but wrong values absent).
    assert!(!with_page.pages.iter().any(|p| p.page_id == "other-page"));
    assert!(
      !with_page
        .pages
        .iter()
        .any(|p| p.allowed_actions.iter().any(|a| a == "delete"))
    );
    assert!(
      !with_page
        .pages
        .iter()
        .any(|p| p.delegated_capability_majors.iter().any(|c| c == "ocr.image@1"))
    );
    assert!(
      !with_page
        .pages
        .iter()
        .any(|p| p.delegated_endpoint_aliases.iter().any(|e| e == "denied"))
    );

    // Domain digest includes page delegation + network resource mode.
    use crate::domain::runtime_plugin::PageGrantEntry;
    let page =
      PageGrantEntry::parse_with_delegation("settings-page", &["open"], &["translate.text@1"], &["approved"]).unwrap();
    let with_page_digest = compute_authority_digest(&caps, &net, &[page]);
    let without_page_digest = compute_authority_digest(&caps, &net, &[]);
    assert_ne!(with_page_digest.as_str(), without_page_digest.as_str());
    Ok(())
  })
  .unwrap();
}
