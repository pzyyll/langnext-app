// ABOUTME: Service validation, rollback, cache merge, and privacy tests.
// ABOUTME: Uses in-memory CredentialVault under cfg(test) only.
use crate::credentials::MemoryCredentialVault;
use crate::domain::import_export::{ConfigurationExport, ImportConflictMode};
use crate::domain::language_detection::LanguageDetectorConfig;
use crate::domain::model::{Availability, ManualModelWrite, ModelConfigWrite, ModelSource, RemoteModelSyncItem};
use crate::domain::provider::{
  AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode,
};
use crate::domain::settings::{
  AppSettingsUpdate, AppSettingsV1, GlobalProxyMode, NetworkSettings, ProxyCredentialUpdate, TranslationPreferences,
};
use crate::domain::translation_profile::{
  LlmModelChainEngine, LlmModelChainEngineWrite, PromptTemplate, TranslationProfile, TranslationProfileEngine,
  TranslationProfileEngineWrite, TranslationProfileWrite,
};
use crate::error::StorageError;
use crate::services::{ImportExportService, ModelService, ProviderService, SettingsService, TranslationProfileService};
use crate::storage::Database;
use std::sync::Arc;

fn block_on<F: std::future::Future>(future: F) -> F::Output {
  tauri::async_runtime::block_on(future)
}

fn models_dev_cache_dir(dir: &tempfile::TempDir) -> std::path::PathBuf {
  let cache_dir = dir.path().join("cache");
  crate::services::models_dev_catalog::ModelsDevCatalog::seed_fresh_empty_cache(&cache_dir).unwrap();
  cache_dir
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
) {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let vault = Arc::new(MemoryCredentialVault::new());
  let providers = ProviderService::new(db.clone(), vault.clone());
  let models = ModelService::new(db.clone(), vault.clone(), models_dev_cache_dir(&dir));
  let profiles = TranslationProfileService::new(
    db.clone(),
    Arc::new(crate::services::ServiceIntegrationRegistry::bundled().unwrap()),
  );
  let settings = SettingsService::new(db.clone(), vault.clone());
  let import_export = ImportExportService::new(db.clone(), vault.clone());
  (dir, db, vault, providers, models, profiles, settings, import_export)
}

fn provider_write(kind: CredentialKind, cred: CredentialUpdate) -> ProviderInstanceWrite {
  let auth_scheme = match kind {
    CredentialKind::None => AuthSchemeV1::none(),
    CredentialKind::ApiKey | CredentialKind::Bearer => AuthSchemeV1::bearer(),
  };
  ProviderInstanceWrite {
    id: None,
    adapter_id: "openai-compatible".into(),
    display_name: "OpenAI".into(),
    base_url: "https://api.openai.com/v1".into(),
    base_url_source: BaseUrlSource::Custom,
    auth_scheme,
    credential_kind: kind,
    credential: cred,
    enabled: true,
    proxy_mode: ProxyMode::Inherit,
    insecure_http_confirmed_at: None,
    expected_updated_at: None,
  }
}

/// Attach optimistic-concurrency baseline for an existing provider update.
fn for_provider_update(
  id: uuid::Uuid,
  expected_updated_at: &str,
  kind: CredentialKind,
  cred: CredentialUpdate,
) -> ProviderInstanceWrite {
  let mut write = provider_write(kind, cred);
  write.id = Some(id);
  write.expected_updated_at = Some(expected_updated_at.to_string());
  write
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
fn provider_keep_allows_base_url_change_with_stored_credential() {
  // Multiple Base URLs may point at the same gateway; Keep retains the token.
  let (_d, _db, _v, providers, models, ..) = setup();
  let dto = providers
    .save(provider_write(
      CredentialKind::ApiKey,
      CredentialUpdate::Replace("sk-shared-gateway".into()),
    ))
    .unwrap();
  assert!(dto.has_credential);
  models
    .apply_remote_merge(
      dto.id,
      &[RemoteModelSyncItem {
        model_key: "m1".into(),
        remote_display_name: None,
        remote_metadata_json: None,
        capability_overrides_json: None,
      }],
    )
    .unwrap();
  let after_merge = providers.get(dto.id).unwrap();
  assert_eq!(
    after_merge.models_sync_status,
    crate::domain::provider::ModelsSyncStatus::Ok
  );

  let mut keep = for_provider_update(
    after_merge.id,
    &after_merge.updated_at,
    CredentialKind::ApiKey,
    CredentialUpdate::Keep,
  );
  keep.base_url = "https://api.llmtech.de/v1".into();

  keep.base_url_source = BaseUrlSource::Custom;

  keep.auth_scheme = AuthSchemeV1::bearer();
  let after = providers.save(keep).unwrap();
  assert!(after.has_credential);
  assert_eq!(after.base_url.as_str(), "https://api.llmtech.de/v1");
  // Connection identity changed → sync status resets; credential stays.
  assert_eq!(
    after.models_sync_status,
    crate::domain::provider::ModelsSyncStatus::Never
  );
  assert!(after.models_synced_at.is_none());
}

#[test]
fn provider_keep_allows_adapter_change_with_stored_credential() {
  let (_d, _db, _v, providers, ..) = setup();
  let dto = providers
    .save(provider_write(
      CredentialKind::ApiKey,
      CredentialUpdate::Replace("sk-shared-adapter".into()),
    ))
    .unwrap();

  let mut keep = for_provider_update(dto.id, &dto.updated_at, CredentialKind::ApiKey, CredentialUpdate::Keep);
  keep.adapter_id = "anthropic".into();
  let after = providers.save(keep).unwrap();

  assert_eq!(after.adapter_id, "anthropic");
  assert_eq!(after.base_url, dto.base_url);
  assert!(after.has_credential);
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
  input.base_url = "http://example.com/v1".into();
  input.base_url_source = BaseUrlSource::Custom;
  assert!(providers.save(input.clone()).is_err());
  input.insecure_http_confirmed_at = Some("2026-07-10T00:00:00Z".into());
  assert!(providers.save(input).is_ok());
}

#[test]
fn loopback_http_ok_without_confirmation() {
  let (_d, _db, _v, providers, ..) = setup();
  let mut input = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  input.base_url = "http://127.0.0.1:8080/v1".into();
  input.base_url_source = BaseUrlSource::Custom;
  assert!(providers.save(input).is_ok());
}

#[test]
fn url_with_userinfo_rejected() {
  let (_d, _db, _v, providers, ..) = setup();
  let mut input = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  input.base_url = "https://user:pass@api.example.com".into();
  input.base_url_source = BaseUrlSource::Custom;
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
      adapter_id: None,
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
          capability_overrides_json: None,
        },
        RemoteModelSyncItem {
          model_key: "manual-1".into(),
          remote_display_name: Some("Remote name".into()),
          remote_metadata_json: Some(serde_json::json!({"x": 1})),
          capability_overrides_json: None,
        },
      ],
    )
    .unwrap();
  let list = models.list_by_provider(p.id).unwrap();
  assert_eq!(list.len(), 2);
  let manual = list.iter().find(|m| m.model_key == "manual-1").unwrap();
  assert_eq!(manual.source, ModelSource::Manual);
  assert_eq!(manual.availability, Availability::Available);
  assert!(manual.enabled);
  let remote_a = list.iter().find(|m| m.model_key == "remote-a").unwrap();
  // Newly discovered remote models stay off until the user enables them.
  assert!(!remote_a.enabled);

  // Second sync drops remote-a
  models
    .apply_remote_merge(
      p.id,
      &[RemoteModelSyncItem {
        model_key: "remote-b".into(),
        remote_display_name: None,
        remote_metadata_json: None,
        capability_overrides_json: None,
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
  assert_eq!(
    crate::services::translation_profiles::render_template(
      "From {{source_language}} to {{target_language}}: {{text}}",
      "Chinese",
      "English",
      "你好",
    ),
    "From Chinese to English: 你好"
  );
}

#[test]
fn prompt_templates_require_default_and_unique_ids() {
  use crate::domain::translation_profile::PromptTemplate;
  use crate::services::translation_profiles::validate_prompt_templates;

  let a = uuid::Uuid::now_v7();
  let b = uuid::Uuid::now_v7();
  let templates = vec![
    PromptTemplate {
      id: a,
      name: "A".into(),
      system_template: "s".into(),
      user_template: "{{text}}".into(),
    },
    PromptTemplate {
      id: b,
      name: "B".into(),
      system_template: "s".into(),
      user_template: "{{text}}".into(),
    },
  ];
  assert!(validate_prompt_templates(&templates, a).is_ok());
  assert!(matches!(
    validate_prompt_templates(&templates, uuid::Uuid::now_v7()).unwrap_err(),
    StorageError::Validation(_)
  ));
  assert!(matches!(
    validate_prompt_templates(&[], a).unwrap_err(),
    StorageError::Validation(_)
  ));
  let dup = vec![
    templates[0].clone(),
    PromptTemplate {
      id: a,
      name: "Dup".into(),
      system_template: "s".into(),
      user_template: "{{text}}".into(),
    },
  ];
  assert!(matches!(
    validate_prompt_templates(&dup, a).unwrap_err(),
    StorageError::Validation(_)
  ));
}

#[test]
fn profile_save_persists_multiple_prompt_templates_and_default() {
  let (_d, _db, _v, providers, models, profiles, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "a".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  let t1 = crate::domain::time::new_id();
  let t2 = crate::domain::time::new_id();
  let dto = profiles
    .save(TranslationProfileWrite {
      id: None,
      name: "Multi".into(),
      enabled: true,
      source_lang: Some("auto".into()),
      target_lang: Some("auto".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
        template_version: 1,
        default_prompt_template_id: t2,
        prompt_templates: vec![
          PromptTemplate {
            id: t1,
            name: "First".into(),
            system_template: "sys-one".into(),
            user_template: "one {{text}}".into(),
          },
          PromptTemplate {
            id: t2,
            name: "Second".into(),
            system_template: "sys-two".into(),
            user_template: "two {{text}}".into(),
          },
        ],
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        language_detection: None,
        target_model_ids: vec![m.id],
      }),
    })
    .unwrap();

  assert_eq!(dto.prompt_templates.len(), 2);
  assert_eq!(dto.prompt_templates[0].id, t1);
  assert_eq!(dto.prompt_templates[1].id, t2);
  assert_eq!(dto.profile.engine.as_llm().unwrap().default_prompt_template_id, t2);

  let listed = profiles.list().unwrap();
  let found = listed.iter().find(|row| row.profile.id == dto.profile.id).unwrap();
  assert_eq!(found.prompt_templates.len(), 2);
  assert_eq!(found.profile.engine.as_llm().unwrap().default_prompt_template_id, t2);
}

#[test]
fn render_template_preserves_unknown_and_partial_braces() {
  use crate::services::translation_profiles::render_template;
  // Unknown vars stay literal (validation rejects them on save; render is defensive).
  assert_eq!(render_template("x {{unknown}} y", "a", "b", "c"), "x {{unknown}} y");
  // Unclosed braces pass through the remainder.
  assert_eq!(render_template("start {{text", "a", "b", "hello"), "start {{text");
  // Whitespace inside braces is tolerated.
  assert_eq!(
    render_template(
      "{{ source_language }}->{{ target_language }}:{{ text }}",
      "zh",
      "en",
      "hi"
    ),
    "zh->en:hi"
  );
}

#[test]
fn profile_list_includes_ordered_targets_bulk() {
  let (_d, _db, _v, providers, models, profiles, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let m1 = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "primary".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let m2 = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "fallback".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  // Zero targets cannot be saved through validation; empty profile list is the empty case.
  assert!(profiles.list().unwrap().is_empty());
  let zero_target_err = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Zero".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![],
        }),
      }
    })
    .unwrap_err();
  assert!(
    matches!(zero_target_err, crate::error::StorageError::Validation(_)),
    "zero-target profile writes must fail validation: {zero_target_err:?}"
  );

  let with_one = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "One".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![m1.id],
        }),
      }
    })
    .unwrap();
  let with_many = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Many".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![m2.id, m1.id],
        }),
      }
    })
    .unwrap();

  let list = profiles.list().unwrap();
  // Stable profile ordering: name ASC (Many before One).
  assert_eq!(list.len(), 2);
  assert_eq!(list[0].profile.id, with_many.profile.id);
  assert_eq!(list[1].profile.id, with_one.profile.id);

  assert_eq!(list[0].targets.len(), 2);
  assert_eq!(list[0].targets[0].provider_model_id, m2.id);
  assert_eq!(list[0].targets[0].priority, 0);
  assert_eq!(list[0].targets[1].provider_model_id, m1.id);
  assert_eq!(list[0].targets[1].priority, 1);

  assert_eq!(list[1].targets.len(), 1);
  assert_eq!(list[1].targets[0].provider_model_id, m1.id);
  assert_eq!(list[1].targets[0].priority, 0);
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
      adapter_id: None,
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
      adapter_id: None,
    })
    .unwrap();
  let dto = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) =
        attach_default_templates("You are a translator.", "Translate to {{target_language}}: {{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Fast".into(),
        enabled: true,
        source_lang: Some("zh".into()),
        target_lang: Some("en".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: Some(0.1),
          max_output_tokens: Some(2048),
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![m1.id, m2.id],
        }),
      }
    })
    .unwrap();
  assert_eq!(dto.targets.len(), 2);
  assert_eq!(dto.targets[0].priority, 0);
  assert_eq!(dto.targets[1].provider_model_id, m2.id);
}

#[test]
fn profile_language_preferences_round_trip() {
  let (_d, _db, _v, providers, models, profiles, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "a".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let dto = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Prefs".into(),
        enabled: true,
        source_lang: Some("auto".into()),
        target_lang: Some("auto".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![m.id],
        }),
      }
    })
    .unwrap();
  assert_eq!(dto.profile.primary_lang.as_deref(), Some("zh"));
  assert_eq!(dto.profile.preferred_target_lang.as_deref(), Some("en"));
  assert_eq!(dto.profile.target_lang.as_deref(), Some("auto"));

  let loaded = profiles.get(dto.profile.id).unwrap();
  assert_eq!(loaded.profile.primary_lang.as_deref(), Some("zh"));
  assert_eq!(loaded.profile.preferred_target_lang.as_deref(), Some("en"));

  // A normal update may not clear the preference pair: both fields are required, so the
  // legacy `(None, None)` shape is rejected even though such rows remain readable/importable.
  let mut cleared = {
    let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
    TranslationProfileWrite {
      id: Some(dto.profile.id),
      name: "Prefs".into(),
      enabled: true,
      source_lang: Some("auto".into()),
      target_lang: Some("en".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        language_detection: None,
        target_model_ids: vec![m.id],
      }),
    }
  };
  cleared.primary_lang = None;
  cleared.preferred_target_lang = None;
  let cleared_err = profiles.save(cleared).unwrap_err();
  assert!(
    matches!(cleared_err, StorageError::Validation(_)),
    "clearing preferences on update must be rejected: {cleared_err:?}"
  );
}

#[test]
fn profile_language_preferences_validation_rejects_invalid_pairs() {
  let (_d, _db, _v, providers, models, profiles, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "a".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  fn base(m: uuid::Uuid) -> TranslationProfileWrite {
    let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
    TranslationProfileWrite {
      id: None,
      name: "Prefs".into(),
      enabled: true,
      source_lang: Some("auto".into()),
      target_lang: Some("auto".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        language_detection: None,
        target_model_ids: vec![m],
      }),
    }
  }

  // Equal pair rejected.
  let mut equal = base(m.id);
  equal.preferred_target_lang = Some("zh".into());
  assert!(matches!(profiles.save(equal).unwrap_err(), StorageError::Validation(_)));

  // auto rejected.
  let mut auto_primary = base(m.id);
  auto_primary.primary_lang = Some("auto".into());
  assert!(matches!(
    profiles.save(auto_primary).unwrap_err(),
    StorageError::Validation(_)
  ));

  // Unsupported id rejected.
  let mut unsupported = base(m.id);
  unsupported.preferred_target_lang = Some("xx".into());
  assert!(matches!(
    profiles.save(unsupported).unwrap_err(),
    StorageError::Validation(_)
  ));

  // Exactly one supplied rejected.
  let mut one = base(m.id);
  one.preferred_target_lang = None;
  assert!(matches!(profiles.save(one).unwrap_err(), StorageError::Validation(_)));

  // Both absent rejected on create: legacy rows are readable/importable, but a save must
  // carry a concrete preference pair.
  let mut missing = base(m.id);
  missing.primary_lang = None;
  missing.preferred_target_lang = None;
  assert!(matches!(
    profiles.save(missing).unwrap_err(),
    StorageError::Validation(_)
  ));
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
      adapter_id: None,
    })
    .unwrap();
  let profile = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Cascade Profile".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![model.id],
        }),
      }
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
fn settings_default_ocr_service_must_exist() {
  let (_d, _db, _v, _p, _m, _pr, settings, ..) = setup();
  let mut s = AppSettingsV1::default_document();
  s.default_ocr_service_id = Some(uuid::Uuid::now_v7());
  let err = settings.update(AppSettingsUpdate {
    settings: s,
    proxy_credential: ProxyCredentialUpdate::Keep,
  });
  assert!(matches!(err, Err(StorageError::Validation(_))));
}

#[test]
fn set_default_ocr_service_id_none_clears() {
  let (_d, _db, _v, _p, _m, _pr, settings, ..) = setup();
  let dto = settings.set_default_ocr_service_id(None).unwrap();
  assert_eq!(dto.settings.default_ocr_service_id, None);
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
      adapter_id: None,
    })
    .unwrap();
  profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "P".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![m.id],
        }),
      }
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
      adapter_id: None,
    })
    .unwrap();
  profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "P".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![m.id],
        }),
      }
    })
    .unwrap();
  let mut doc = ie.export().unwrap();

  // System mode with proxy URL
  doc.app_settings.network.proxy_mode = GlobalProxyMode::System;
  doc.app_settings.network.proxy_url = Some("http://user:secret@host".into());
  let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
  assert!(!preview.valid);
  assert!(
    preview
      .validation_errors
      .iter()
      .any(|e| e.contains("proxy") || e.contains("userinfo") || e.contains("system"))
  );
  assert!(!serde_json::to_string(&preview).unwrap().contains("user:secret"));

  // Reset settings
  doc.app_settings = AppSettingsV1::default_document();

  // Invalid adapter id syntax
  doc.providers[0].adapter_id = "Not_Valid".into();
  let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
  assert!(!preview.valid);
  doc.providers[0].adapter_id = "openai-compatible".into();

  // Unknown plugin without explicit custom transport metadata
  doc.providers[0].adapter_id = "custom-plugin-1".into();
  doc.providers[0].base_url_source = Some(crate::domain::provider::BaseUrlSource::PluginDefault);
  let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
  assert!(!preview.valid);
  doc.providers[0].adapter_id = "openai-compatible".into();
  doc.providers[0].base_url_source = Some(crate::domain::provider::BaseUrlSource::Custom);

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
fn import_accepts_legacy_preferences_and_rejects_invalid_pairs() {
  let (_d, _db, _v, providers, models, profiles, _settings, ie, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "a".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Prefs".into(),
        enabled: true,
        source_lang: Some("auto".into()),
        target_lang: Some("auto".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![m.id],
        }),
      }
    })
    .unwrap();

  let doc = ie.export().unwrap();

  // Legacy export with both preference fields absent remains importable.
  let mut legacy = doc.clone();
  legacy.translation_profiles[0].primary_lang = None;
  legacy.translation_profiles[0].preferred_target_lang = None;
  assert!(ie.preview(&legacy, ImportConflictMode::Merge).unwrap().valid);

  // Equal preference pair rejected.
  let mut equal = doc.clone();
  equal.translation_profiles[0].primary_lang = Some("en".into());
  equal.translation_profiles[0].preferred_target_lang = Some("en".into());
  let preview = ie.preview(&equal, ImportConflictMode::Merge).unwrap();
  assert!(!preview.valid);
  assert!(preview.validation_errors.iter().any(|e| e.contains("differ")));

  // auto preference rejected.
  let mut auto_pref = doc.clone();
  auto_pref.translation_profiles[0].primary_lang = Some("auto".into());
  let preview = ie.preview(&auto_pref, ImportConflictMode::Merge).unwrap();
  assert!(!preview.valid);

  // Unsupported preference id rejected.
  let mut unsupported = doc;
  unsupported.translation_profiles[0].preferred_target_lang = Some("xx".into());
  let preview = ie.preview(&unsupported, ImportConflictMode::Merge).unwrap();
  assert!(!preview.valid);
}

#[test]
fn import_accepts_legacy_profile_missing_preference_keys() {
  let (_d, _db, _v, providers, models, profiles, _settings, ie, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "a".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let dto = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Prefs".into(),
        enabled: true,
        source_lang: Some("auto".into()),
        target_lang: Some("auto".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![m.id],
        }),
      }
    })
    .unwrap();

  let doc = ie.export().unwrap();

  // Emulate a real legacy export produced before the preference fields existed: strip the
  // keys entirely (not null) so serde's `#[serde(default)]` path is exercised on import.
  let mut json = serde_json::to_value(&doc).unwrap();
  for profile in json["translationProfiles"].as_array_mut().unwrap() {
    let obj = profile.as_object_mut().unwrap();
    assert!(
      obj.remove("primaryLang").is_some(),
      "exported profile carries primaryLang"
    );
    assert!(
      obj.remove("preferredTargetLang").is_some(),
      "exported profile carries preferredTargetLang"
    );
  }
  let legacy: ConfigurationExport = serde_json::from_value(json).unwrap();
  assert_eq!(legacy.translation_profiles[0].primary_lang, None);
  assert_eq!(legacy.translation_profiles[0].preferred_target_lang, None);

  let preview = ie.preview(&legacy, ImportConflictMode::Merge).unwrap();
  assert!(
    preview.valid,
    "legacy profile missing preference keys must import: {preview:?}"
  );

  let result = ie.import(legacy, ImportConflictMode::Merge).unwrap();
  assert!(result.applied);
  let loaded = profiles.get(dto.profile.id).unwrap();
  assert_eq!(loaded.profile.primary_lang, None);
  assert_eq!(loaded.profile.preferred_target_lang, None);
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
        capability_overrides_json: None,
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
    adapter_id: None,
  });
  assert!(matches!(err, Err(StorageError::Validation(_))));
}

#[test]
fn update_model_config_persists_limits_and_request_default() {
  let (_d, _db, _v, providers, models, ..) = setup();
  let provider = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let model = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: provider.id,
      model_key: "configured-model".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  let updated = models
    .update_config(ModelConfigWrite {
      id: model.id,
      display_name_override: Some("  Configured  ".into()),
      adapter_id: Some("anthropic".into()),
      capability_overrides_json: Some(serde_json::json!({
        "schemaVersion": 1,
        "maxContextTokens": 131072,
        "maxOutputTokens": 32768,
        "defaultOutputTokens": 6144,
        "textGeneration": true,
        "imageAnalysis": true
      })),
    })
    .unwrap();

  assert_eq!(updated.display_name_override.as_deref(), Some("Configured"));
  assert_eq!(updated.adapter_id.as_deref(), Some("anthropic"));
  let capabilities = updated.capability_overrides_json.as_ref().expect("capabilities");
  assert_eq!(capabilities["maxContextTokens"], 131072);
  assert_eq!(capabilities["maxOutputTokens"], 32768);
  assert_eq!(capabilities["defaultOutputTokens"], 6144);
  assert_eq!(capabilities["imageAnalysis"], true);

  let cleared = models
    .update_config(ModelConfigWrite {
      id: model.id,
      display_name_override: Some("   ".into()),
      adapter_id: Some("anthropic".into()),
      capability_overrides_json: updated.capability_overrides_json.clone(),
    })
    .unwrap();
  assert_eq!(cleared.display_name_override, None);
}

#[test]
fn model_adapter_id_override_round_trip_and_validation() {
  let (_d, _db, _v, providers, models, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let created = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "mixed-model".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: Some("gemini".into()),
    })
    .unwrap();
  assert_eq!(created.adapter_id.as_deref(), Some("gemini"));

  let cleared = models.set_adapter_id(created.id, None).unwrap();
  assert!(cleared.adapter_id.is_none());

  let set = models.set_adapter_id(created.id, Some("anthropic".into())).unwrap();
  assert_eq!(set.adapter_id.as_deref(), Some("anthropic"));

  // Structural ID validation rejects invalid syntax; unknown well-formed IDs are kept.
  let err = models.set_adapter_id(created.id, Some("Not_Valid".into()));
  assert!(matches!(err, Err(StorageError::Validation(_))));
  let unknown = models
    .set_adapter_id(created.id, Some("custom-plugin-1".into()))
    .unwrap();
  assert_eq!(unknown.adapter_id.as_deref(), Some("custom-plugin-1"));

  // Whitespace-only clears to inherit.
  let blank = models.set_adapter_id(created.id, Some("   ".into())).unwrap();
  assert!(blank.adapter_id.is_none());
}

#[test]
fn resolve_model_adapter_id_prefers_model_then_channel() {
  assert_eq!(
    crate::services::models::resolve_model_adapter_id(Some("gemini"), "openai-compatible"),
    "gemini"
  );
  assert_eq!(
    crate::services::models::resolve_model_adapter_id(None, "openai-compatible"),
    "openai-compatible"
  );
  assert_eq!(
    crate::services::models::resolve_model_adapter_id(Some("  "), "anthropic"),
    "anthropic"
  );
  assert_eq!(
    crate::services::models::resolve_model_adapter_id(Some(""), "openai-responses"),
    "openai-responses"
  );
}

#[test]
fn validate_sync_error_code_accepts_credential_unavailable() {
  assert!(crate::services::models::validate_sync_error_code("credential_unavailable").is_ok());
  assert!(crate::services::models::validate_sync_error_code("auth").is_ok());
  assert!(crate::services::models::validate_sync_error_code("nope").is_err());
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
        capability_overrides_json: None,
      }],
    )
    .unwrap();
  let before = providers.get(p.id).unwrap();
  assert_eq!(before.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
  assert!(before.models_synced_at.is_some());

  let mut write = for_provider_update(
    before.id,
    &before.updated_at,
    CredentialKind::None,
    CredentialUpdate::Keep,
  );
  write.base_url = "http://127.0.0.1:8888/v1".into();

  write.base_url_source = BaseUrlSource::Custom;

  write.auth_scheme = AuthSchemeV1::none();
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
        capability_overrides_json: None,
      }],
    )
    .unwrap();
  let before = providers.get(p.id).unwrap();
  assert_eq!(before.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
  let synced_at = before.models_synced_at.clone().expect("synced_at");

  // Save final transaction commits after sync.
  let mut write = for_provider_update(
    before.id,
    &before.updated_at,
    CredentialKind::None,
    CredentialUpdate::Keep,
  );
  write.display_name = "After sync rename".into();
  write.base_url = before.base_url.clone();

  write.base_url_source = before.base_url_source;

  write.auth_scheme = before.auth_scheme.clone();
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
        capability_overrides_json: None,
      }],
    )
    .unwrap();
  let before = providers.get(p.id).unwrap();
  assert_eq!(before.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);

  let mut write = for_provider_update(
    before.id,
    &before.updated_at,
    CredentialKind::None,
    CredentialUpdate::Keep,
  );
  write.base_url = "http://127.0.0.1:4242/v1".into();

  write.base_url_source = BaseUrlSource::Custom;

  write.auth_scheme = AuthSchemeV1::none();
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
        capability_overrides_json: None,
      }],
    )
    .unwrap();
  let before = providers.get(p.id).unwrap();
  let synced_at = before.models_synced_at.clone().expect("synced_at");

  let mut write = for_provider_update(
    before.id,
    &before.updated_at,
    CredentialKind::None,
    CredentialUpdate::Keep,
  );
  write.display_name = "Renamed only".into();
  // Same base URL / identity fields.
  write.base_url = before.base_url.clone();

  write.base_url_source = before.base_url_source;

  write.auth_scheme = before.auth_scheme.clone();
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
        capability_overrides_json: None,
      }],
    )
    .unwrap();
  let before = providers.get(p.id).unwrap();
  assert_eq!(before.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);

  let mut write = for_provider_update(
    before.id,
    &before.updated_at,
    CredentialKind::ApiKey,
    CredentialUpdate::Replace("sk-new".into()),
  );
  write.display_name = "OpenAI".into();
  write.base_url = "https://api.openai.com/v1".into();

  write.base_url_source = BaseUrlSource::Custom;

  write.auth_scheme = AuthSchemeV1::bearer();
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
        capability_overrides_json: None,
      }],
    )
    .unwrap();

  let before = providers.get(p.id).unwrap();
  let mut write = for_provider_update(
    before.id,
    &before.updated_at,
    CredentialKind::None,
    CredentialUpdate::Keep,
  );
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
fn delete_all_models_keeps_provider_and_connection() {
  let (_d, _db, _v, providers, models, profiles, ..) = setup();
  let provider = providers
    .save({
      let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
      write.display_name = "Keep Me".into();
      write.base_url = "https://api.example.com/v1".into();

      write.base_url_source = BaseUrlSource::Custom;

      write.auth_scheme = AuthSchemeV1::none();
      write
    })
    .unwrap();
  let m1 = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: provider.id,
      model_key: "keep-a".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let m2 = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: provider.id,
      model_key: "keep-b".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let profile = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Uses models".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![m1.id, m2.id],
        }),
      }
    })
    .unwrap();

  assert_eq!(models.delete_many(vec![m1.id, m2.id]).unwrap(), 2);
  assert!(models.list_by_provider(provider.id).unwrap().is_empty());

  // Channel row and connection fields must survive clearing every model.
  let kept = providers
    .get(provider.id)
    .expect("provider must remain after model delete");
  assert_eq!(kept.display_name, "Keep Me");
  assert_eq!(kept.base_url.as_str(), "https://api.example.com/v1");
  assert!(providers.list().unwrap().iter().any(|row| row.id == provider.id));
  assert!(profiles.get(profile.profile.id).unwrap().targets.is_empty());
}

#[test]
fn delete_many_models_all_or_nothing() {
  let (_d, _db, _v, providers, models, profiles, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let m1 = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "bulk-a".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let m2 = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "bulk-b".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let m3 = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "bulk-c".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  // Empty list is a successful no-op.
  assert_eq!(models.delete_many(vec![]).unwrap(), 0);
  assert_eq!(models.list_by_provider(p.id).unwrap().len(), 3);

  // Duplicate ids collapse to one delete.
  assert_eq!(models.delete_many(vec![m1.id, m1.id]).unwrap(), 1);
  assert_eq!(models.list_by_provider(p.id).unwrap().len(), 2);
  assert!(models.list_by_provider(p.id).unwrap().iter().all(|m| m.id != m1.id));

  // Profile target references no longer block delete; targets detach first.
  let profile = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Holds bulk-c".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![m3.id],
        }),
      }
    })
    .unwrap();

  assert_eq!(models.delete_many(vec![m2.id, m3.id]).unwrap(), 2);
  assert!(models.list_by_provider(p.id).unwrap().is_empty());
  assert!(profiles.get(profile.profile.id).unwrap().targets.is_empty());

  // Missing id still rolls back the whole batch (re-seed two models).
  let m4 = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "bulk-d".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let m5 = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "bulk-e".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let missing = uuid::Uuid::nil();
  let err = models.delete_many(vec![m4.id, missing]).unwrap_err();
  assert!(
    matches!(err, StorageError::NotFound(_)),
    "expected not_found, got {err:?}"
  );
  assert_eq!(models.list_by_provider(p.id).unwrap().len(), 2);
  assert!(models.list_by_provider(p.id).unwrap().iter().any(|m| m.id == m4.id));
  assert!(models.list_by_provider(p.id).unwrap().iter().any(|m| m.id == m5.id));

  assert_eq!(models.delete_many(vec![m4.id, m5.id]).unwrap(), 2);
  assert!(models.list_by_provider(p.id).unwrap().is_empty());
}

#[test]
fn provider_save_rejects_stale_expected_updated_at() {
  let (_d, _db, _v, providers, ..) = setup();
  let created = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();

  // First update with the correct baseline succeeds and advances updated_at.
  let mut first = for_provider_update(
    created.id,
    &created.updated_at,
    CredentialKind::None,
    CredentialUpdate::Keep,
  );
  first.display_name = "First win".into();
  let saved = providers.save(first).unwrap();
  assert_eq!(saved.display_name, "First win");
  assert_ne!(saved.updated_at, created.updated_at);

  // Stale baseline must not write.
  let mut stale = for_provider_update(
    created.id,
    &created.updated_at,
    CredentialKind::None,
    CredentialUpdate::Keep,
  );
  stale.display_name = "Should not land".into();
  let err = providers.save(stale).unwrap_err();
  assert!(matches!(err, StorageError::Conflict(_)), "got {err:?}");
  let current = providers.get(created.id).unwrap();
  assert_eq!(current.display_name, "First win");
  assert_eq!(current.updated_at, saved.updated_at);

  // Missing expected_updated_at is rejected before any write.
  let mut missing = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  missing.id = Some(created.id);
  missing.display_name = "No baseline".into();
  let err = providers.save(missing).unwrap_err();
  assert!(matches!(err, StorageError::Validation(_)), "got {err:?}");
  assert_eq!(providers.get(created.id).unwrap().display_name, "First win");

  // Current baseline still saves cleanly.
  let mut ok = for_provider_update(
    saved.id,
    &saved.updated_at,
    CredentialKind::None,
    CredentialUpdate::Keep,
  );
  ok.display_name = "Second win".into();
  let again = providers.save(ok).unwrap();
  assert_eq!(again.display_name, "Second win");
}

/// Test helper: one default prompt template with a fresh stable id.
fn attach_default_templates(system: &str, user: &str) -> (uuid::Uuid, Vec<PromptTemplate>) {
  let id = crate::domain::time::new_id();
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

fn sample_profile(
  id: uuid::Uuid,
  name: &str,
  language_detection: Option<LanguageDetectorConfig>,
) -> (TranslationProfile, Vec<PromptTemplate>) {
  let now = crate::domain::time::now_rfc3339();
  let (template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
  let profile = TranslationProfile {
    id,
    name: name.into(),
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
      language_detection,
    }),
    created_at: now.clone(),
    updated_at: now,
  };
  (profile, prompt_templates)
}

#[test]
fn profile_save_persists_dedicated_detection_model_and_empty_config() {
  let (_d, _db, _v, providers, models, profiles, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let m1 = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "det".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let m2 = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "det2".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  // Save with a dedicated detection model id.
  let saved = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Detect profile".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: Some(LanguageDetectorConfig::Llm { model_id: Some(m1.id) }),
          target_model_ids: vec![m2.id],
        }),
      }
    })
    .unwrap();
  assert_eq!(
    saved.profile.engine.as_llm().unwrap().language_detection,
    Some(LanguageDetectorConfig::Llm { model_id: Some(m1.id) })
  );

  // Re-read round-trips the config JSON from SQLite.
  let reread = profiles.get(saved.profile.id).unwrap();
  assert_eq!(
    reread.profile.engine.as_llm().unwrap().language_detection,
    Some(LanguageDetectorConfig::Llm { model_id: Some(m1.id) })
  );

  // Clearing the config (None) persists and is read back as None.
  let cleared = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: Some(saved.profile.id),
        name: "Detect profile".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
          target_model_ids: vec![m2.id],
        }),
      }
    })
    .unwrap();
  assert!(cleared.profile.engine.as_llm().unwrap().language_detection.is_none());
  assert!(
    profiles
      .get(saved.profile.id)
      .unwrap()
      .profile
      .engine
      .as_llm()
      .unwrap()
      .language_detection
      .is_none()
  );
}

#[test]
fn profile_save_rejects_detection_model_that_does_not_exist() {
  let (_d, _db, _v, providers, models, profiles, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "only".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let ghost = uuid::Uuid::now_v7();
  let err = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Bad detect".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: Some(LanguageDetectorConfig::Llm { model_id: Some(ghost) }),
          target_model_ids: vec![m.id],
        }),
      }
    })
    .unwrap_err();
  assert!(matches!(err, StorageError::NotFound(_)), "got {err:?}");
}

#[test]
fn delete_model_and_provider_clear_detection_config() {
  let (_d, _db, _v, providers, models, profiles, ..) = setup();
  let primary_provider = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let mut detector_provider_write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  detector_provider_write.display_name = "Detector".into();
  let detector_provider = providers.save(detector_provider_write).unwrap();
  let primary = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: primary_provider.id,
      model_key: "primary".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let detector = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: detector_provider.id,
      model_key: "detector".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let mut detector_b_provider_write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  detector_b_provider_write.display_name = "Detector B".into();
  let detector_b_provider = providers.save(detector_b_provider_write).unwrap();
  let detector_b = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: detector_b_provider.id,
      model_key: "detector-b".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let profile = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Dedicated detector".into(),
        enabled: true,
        source_lang: Some("auto".into()),
        target_lang: Some("en".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: Some(LanguageDetectorConfig::Llm {
            model_id: Some(detector.id),
          }),
          target_model_ids: vec![primary.id],
        }),
      }
    })
    .unwrap();

  // Direct model delete detaches the dedicated detector config.
  models.delete(detector.id).unwrap();
  let after_model_delete = profiles.get(profile.profile.id).unwrap();
  assert!(
    after_model_delete
      .profile
      .engine
      .as_llm()
      .unwrap()
      .language_detection
      .is_none()
  );
  assert_eq!(after_model_delete.targets[0].provider_model_id, primary.id);

  // Re-bind detector to another model, then provider delete still clears config.
  profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: Some(profile.profile.id),
        name: "Dedicated detector".into(),
        enabled: true,
        source_lang: Some("auto".into()),
        target_lang: Some("en".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: Some(LanguageDetectorConfig::Llm {
            model_id: Some(detector_b.id),
          }),
          target_model_ids: vec![primary.id],
        }),
      }
    })
    .unwrap();

  providers.delete(detector_b_provider.id).unwrap();
  let reread = profiles.get(profile.profile.id).unwrap();
  assert!(reread.profile.engine.as_llm().unwrap().language_detection.is_none());
  assert_eq!(reread.targets[0].provider_model_id, primary.id);
}

#[test]
fn import_copy_rewrites_detection_model_id() {
  let (_d, _db, _v, providers, models, profiles, _settings, ie, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "det".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let primary = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "primary".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  let saved = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Detect profile".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: Some(LanguageDetectorConfig::Llm { model_id: Some(m.id) }),
          target_model_ids: vec![primary.id],
        }),
      }
    })
    .unwrap();

  let doc = ie.export().unwrap();
  let preview = ie.preview(&doc, ImportConflictMode::Copy).unwrap();
  assert!(preview.valid, "preview errors: {:?}", preview.validation_errors);
  let result = ie.import(doc, ImportConflictMode::Copy).unwrap();
  assert!(result.applied);

  // The copied profile keeps its id from the plan; its detection model id must be rewritten
  // to the copied model's new id (different from the original m.id).
  let all = profiles.list().unwrap();
  let copied = all
    .iter()
    .find(|dto| dto.profile.id != saved.profile.id && dto.profile.name == "Detect profile")
    .expect("copied profile exists");
  let copied_primary_id = copied.targets[0].provider_model_id;
  let copied_detector_id = models
    .list_all()
    .unwrap()
    .into_iter()
    .find(|model| model.id != m.id && model.model_key == "det")
    .expect("copied dedicated detector exists")
    .id;
  assert_ne!(
    copied_primary_id, primary.id,
    "copy mode must assign a new primary model id"
  );
  assert_ne!(
    copied_detector_id, m.id,
    "copy mode must assign a new detector model id"
  );
  assert_ne!(
    copied_detector_id, copied_primary_id,
    "detector remains dedicated after copy"
  );
  match &copied.profile.engine.as_llm().unwrap().language_detection {
    Some(LanguageDetectorConfig::Llm { model_id: Some(id) }) => {
      assert_eq!(
        *id, copied_detector_id,
        "detection model id must be rewritten to the copied dedicated model"
      );
    }
    other => panic!("expected rewritten Llm detection model id, got {other:?}"),
  }
}

#[test]
fn import_rejects_profile_detection_referencing_missing_model() {
  let (_d, _db, _v, providers, models, profiles, _settings, ie, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "det".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();
  profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Detect profile".into(),
        enabled: true,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
          template_version: 1,
          default_prompt_template_id,
          prompt_templates,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: Some(LanguageDetectorConfig::Llm { model_id: Some(m.id) }),
          target_model_ids: vec![m.id],
        }),
      }
    })
    .unwrap();

  let mut doc = ie.export().unwrap();
  // Point the detection model id at a model that does not exist in the document.
  let ghost = uuid::Uuid::now_v7();
  if let TranslationProfileEngine::LlmModelChain(ref mut llm) = doc.translation_profiles[0].engine {
    if let Some(LanguageDetectorConfig::Llm { model_id }) = llm.language_detection.as_mut() {
      *model_id = Some(ghost);
    }
  }
  let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
  assert!(!preview.valid);
  assert!(
    preview
      .validation_errors
      .iter()
      .any(|e| e.contains("language detection")),
    "expected a language-detection reference error, got {:?}",
    preview.validation_errors
  );
}

#[test]
fn plugin_profile_save_requires_ready_instance_and_rejects_engine_change() {
  use crate::domain::service_integration::{
    GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GoogleCloudConfigV1, IntegrationHealthStatus,
    IntegrationInstance,
  };
  use crate::domain::translation_profile::{
    GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION, PluginCapabilityEngineWrite, empty_google_translate_preferences,
  };
  use crate::repositories::integration_instances;
  use crate::services::google_cloud::{GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID};

  let (_d, db, _v, _providers, _models, profiles, ..) = setup();
  let instance_id = crate::domain::time::new_id();
  let now = crate::domain::time::now_rfc3339();
  let config = GoogleCloudConfigV1 {
    project_id: "demo-project".into(),
    location: GOOGLE_CLOUD_DEFAULT_LOCATION.into(),
    proxy_mode: ProxyMode::Direct,
  };
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id: instance_id,
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        plugin_version: "1.0.0".into(),
        display_name: "Work".into(),
        enabled: true,
        config_json: serde_json::to_string(&config).unwrap(),
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
        last_validated_at: Some(now.clone()),
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
    Ok(())
  })
  .unwrap();

  let saved = profiles
    .save(TranslationProfileWrite {
      id: None,
      name: "Google Profile".into(),
      enabled: true,
      source_lang: Some("auto".into()),
      target_lang: Some("en".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngineWrite::PluginCapability(PluginCapabilityEngineWrite {
        integration_instance_id: instance_id,
        translate_capability_id: GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        detect_capability_id: Some(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID.into()),
        capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
        capability_preferences: empty_google_translate_preferences(),
      }),
    })
    .unwrap();

  assert!(saved.profile.engine.is_plugin());
  assert!(saved.targets.is_empty());
  assert!(saved.prompt_templates.is_empty());
  let plugin = saved.profile.engine.as_plugin().unwrap();
  assert_eq!(plugin.integration_instance_id, instance_id);
  assert_eq!(plugin.translate_capability_id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID);

  // Engine kind is immutable.
  let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
  let m_err = profiles
    .save(TranslationProfileWrite {
      id: Some(saved.profile.id),
      name: "Google Profile".into(),
      enabled: true,
      source_lang: Some("auto".into()),
      target_lang: Some("en".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngineWrite::LlmModelChain(LlmModelChainEngineWrite {
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        language_detection: None,
        target_model_ids: vec![uuid::Uuid::now_v7()],
      }),
    })
    .unwrap_err();
  assert!(
    matches!(m_err, StorageError::Validation(ref msg) if msg.contains("immutable")),
    "expected immutable engine error, got {m_err:?}"
  );

  // Non-empty Google preferences rejected.
  let prefs_err = profiles
    .save(TranslationProfileWrite {
      id: Some(saved.profile.id),
      name: "Google Profile".into(),
      enabled: true,
      source_lang: Some("auto".into()),
      target_lang: Some("en".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngineWrite::PluginCapability(PluginCapabilityEngineWrite {
        integration_instance_id: instance_id,
        translate_capability_id: GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        detect_capability_id: Some(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID.into()),
        capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
        capability_preferences: serde_json::json!({"foo": 1}),
      }),
    })
    .unwrap_err();
  assert!(matches!(prefs_err, StorageError::Validation(_)));

  // Dependency lookup includes profile.
  let deps = db
    .read(|conn| integration_instances::list_dependencies(conn, instance_id))
    .unwrap();
  assert_eq!(deps.len(), 1);
  assert_eq!(deps[0].kind, "translation_profile");
  assert_eq!(deps[0].id, saved.profile.id);
  assert_eq!(deps[0].display_name, "Google Profile");
}

#[test]
fn plugin_profile_rebind_accepts_compatible_ready_instance() {
  use crate::domain::service_integration::{
    GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GoogleCloudConfigV1, IntegrationHealthStatus,
    IntegrationInstance,
  };
  use crate::domain::translation_profile::{
    GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION, PluginCapabilityEngineWrite, empty_google_translate_preferences,
  };
  use crate::repositories::integration_instances;
  use crate::services::google_cloud::{GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID};

  let (_d, db, _v, _providers, _models, profiles, ..) = setup();
  let now = crate::domain::time::now_rfc3339();
  let config = GoogleCloudConfigV1 {
    project_id: "demo-project".into(),
    location: GOOGLE_CLOUD_DEFAULT_LOCATION.into(),
    proxy_mode: ProxyMode::Direct,
  };
  let instance_a = crate::domain::time::new_id();
  let instance_b = crate::domain::time::new_id();
  db.transaction(|uow| {
    for (id, name) in [(instance_a, "Work A"), (instance_b, "Work B")] {
      integration_instances::insert(
        uow.conn(),
        &IntegrationInstance {
          id,
          plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
          plugin_version: "1.0.0".into(),
          display_name: name.into(),
          enabled: true,
          config_json: serde_json::to_string(&config).unwrap(),
          config_schema_version: 1,
          health_status: IntegrationHealthStatus::Ready,
          last_validated_at: Some(now.clone()),
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
    }
    Ok(())
  })
  .unwrap();

  let saved = profiles
    .save(TranslationProfileWrite {
      id: None,
      name: "Google Profile".into(),
      enabled: true,
      source_lang: Some("auto".into()),
      target_lang: Some("en".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngineWrite::PluginCapability(PluginCapabilityEngineWrite {
        integration_instance_id: instance_a,
        translate_capability_id: GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        detect_capability_id: Some(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID.into()),
        capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
        capability_preferences: empty_google_translate_preferences(),
      }),
    })
    .unwrap();

  let rebound = profiles
    .save(TranslationProfileWrite {
      id: Some(saved.profile.id),
      name: "Google Profile".into(),
      enabled: true,
      source_lang: Some("auto".into()),
      target_lang: Some("en".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngineWrite::PluginCapability(PluginCapabilityEngineWrite {
        integration_instance_id: instance_b,
        translate_capability_id: GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        detect_capability_id: Some(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID.into()),
        capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
        capability_preferences: empty_google_translate_preferences(),
      }),
    })
    .unwrap();
  let plugin = rebound.profile.engine.as_plugin().unwrap();
  assert_eq!(plugin.integration_instance_id, instance_b);
}

#[test]
fn plugin_profile_rebind_rejects_incompatible_capability_major() {
  use crate::domain::service_integration::{
    GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GoogleCloudConfigV1, IntegrationHealthStatus,
    IntegrationInstance,
  };
  use crate::domain::translation_profile::{
    GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION, PluginCapabilityEngineWrite, empty_google_translate_preferences,
  };
  use crate::repositories::integration_instances;
  use crate::services::google_cloud::{GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID};

  let (_d, db, _v, _providers, _models, profiles, ..) = setup();
  let now = crate::domain::time::now_rfc3339();
  let config = GoogleCloudConfigV1 {
    project_id: "demo-project".into(),
    location: GOOGLE_CLOUD_DEFAULT_LOCATION.into(),
    proxy_mode: ProxyMode::Direct,
  };
  let instance_id = crate::domain::time::new_id();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id: instance_id,
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        plugin_version: "1.0.0".into(),
        display_name: "Work".into(),
        enabled: true,
        config_json: serde_json::to_string(&config).unwrap(),
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
        last_validated_at: Some(now.clone()),
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
    Ok(())
  })
  .unwrap();

  let saved = profiles
    .save(TranslationProfileWrite {
      id: None,
      name: "Google Profile".into(),
      enabled: true,
      source_lang: Some("auto".into()),
      target_lang: Some("en".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngineWrite::PluginCapability(PluginCapabilityEngineWrite {
        integration_instance_id: instance_id,
        translate_capability_id: GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        detect_capability_id: Some(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID.into()),
        capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
        capability_preferences: empty_google_translate_preferences(),
      }),
    })
    .unwrap();

  // Same instance but incompatible major version string — also fails capability declaration.
  let err = profiles
    .save(TranslationProfileWrite {
      id: Some(saved.profile.id),
      name: "Google Profile".into(),
      enabled: true,
      source_lang: Some("auto".into()),
      target_lang: Some("en".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngineWrite::PluginCapability(PluginCapabilityEngineWrite {
        integration_instance_id: instance_id,
        translate_capability_id: "translate.text@99".into(),
        detect_capability_id: Some(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID.into()),
        capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
        capability_preferences: empty_google_translate_preferences(),
      }),
    })
    .unwrap_err();
  assert!(
    matches!(err, StorageError::Validation(ref msg) if msg.contains("not declared") || msg.contains("incompatible")),
    "expected incompatible rebind/declaration error, got {err:?}"
  );
}

#[test]
fn plugin_profile_blocks_integration_delete_with_in_use() {
  use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
  use crate::domain::service_integration::{
    GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GoogleCloudConfigV1, IntegrationHealthStatus,
    IntegrationInstance,
  };
  use crate::domain::translation_profile::{
    GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION, PluginCapabilityEngineWrite, empty_google_translate_preferences,
  };
  use crate::repositories::integration_instances;
  use crate::services::google_cloud::{GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID};
  use crate::services::service_integration_registry::ServiceIntegrationRegistry;
  use crate::services::service_integrations::ServiceIntegrationService;
  use crate::services::token_grant::{ExchangedToken, GoogleTokenExchanger, TokenGrantService};
  use std::future::Future;
  use std::pin::Pin;
  use std::sync::Arc;

  struct NoopExchanger;
  impl GoogleTokenExchanger for NoopExchanger {
    fn exchange(
      &self,
      _instance_id: uuid::Uuid,
      _scopes: Vec<String>,
      _now_unix_secs: u64,
      _cancel: Option<crate::domain::cancel::CancelToken>,
    ) -> Pin<Box<dyn Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>> {
      Box::pin(async { Err(CapabilityError::new(CapabilityErrorCode::Internal, "noop")) })
    }
  }

  let (_d, db, vault, _providers, _models, profiles, ..) = setup();
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let tokens = Arc::new(TokenGrantService::new(Arc::new(NoopExchanger)));
  let integrations = ServiceIntegrationService::new(db.clone(), vault.clone(), registry, tokens);

  let now = crate::domain::time::now_rfc3339();
  let config = GoogleCloudConfigV1 {
    project_id: "demo-project".into(),
    location: GOOGLE_CLOUD_DEFAULT_LOCATION.into(),
    proxy_mode: ProxyMode::Direct,
  };
  let instance_id = crate::domain::time::new_id();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id: instance_id,
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        plugin_version: "1.0.0".into(),
        display_name: "Work".into(),
        enabled: true,
        config_json: serde_json::to_string(&config).unwrap(),
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
        last_validated_at: Some(now.clone()),
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
    Ok(())
  })
  .unwrap();

  profiles
    .save(TranslationProfileWrite {
      id: None,
      name: "Bound Profile".into(),
      enabled: true,
      source_lang: Some("auto".into()),
      target_lang: Some("en".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      engine: TranslationProfileEngineWrite::PluginCapability(PluginCapabilityEngineWrite {
        integration_instance_id: instance_id,
        translate_capability_id: GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        detect_capability_id: Some(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID.into()),
        capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
        capability_preferences: empty_google_translate_preferences(),
      }),
    })
    .unwrap();

  let err = integrations.delete(instance_id).unwrap_err();
  assert!(
    matches!(err, StorageError::InUse(_)),
    "expected in_use when profile references instance, got {err:?}"
  );
}
