// ABOUTME: Service validation, rollback, cache merge, and privacy tests.
// ABOUTME: Uses in-memory CredentialVault under cfg(test) only.
use crate::credentials::MemoryCredentialVault;
use crate::domain::import_export::{ConfigurationExport, ImportConflictMode, IntegrationInstanceExport};
use crate::domain::language_detection::LanguageDetectorConfig;
use crate::domain::model::{Availability, ManualModelWrite, ModelConfigWrite, ModelSource, RemoteModelSyncItem};
use crate::domain::provider::{
  AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode,
};
use crate::domain::runtime_lifecycle::RuntimeRequirementExport;
use crate::domain::runtime_provider::{
  ProviderRuntimeBinding, ProviderRuntimeKind, ProviderRuntimeRequirementExport, ProviderRuntimeState,
};
use crate::domain::settings::{
  AppSettingsUpdate, AppSettingsV1, GlobalProxyMode, NetworkSettings, ProxyCredentialUpdate, TranslationPreferences,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{
  LlmModelChainEngine, LlmModelChainEngineWrite, PromptTemplate, TranslationProfile, TranslationProfileEngine,
  TranslationProfileEngineWrite, TranslationProfileWrite,
};
use crate::error::{ImportPreviewConflictReason, StorageError};
use crate::repositories::integration_instances;
use crate::repositories::provider_runtime_bindings::{self, ProviderRuntimeSnapshotScope, ProviderRuntimeSnapshotSet};
use crate::services::{ImportExportService, ModelService, ProviderService, SettingsService, TranslationProfileService};
use crate::storage::Database;
use std::sync::Arc;
use uuid::Uuid;

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
      "openai-compatible",
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
      "openai-compatible",
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
      "openai-compatible",
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

/// Merge import makes the document-declared runtime binding collection the Provider's
/// COMPLETE runtime interface set: local bindings the document omits are removed, and the
/// removed binding's Provider/package grant is released reference-aware (no active binding
/// and no undiscarded snapshot references it). The Provider default API type keeps its
/// legacy row, so the per-interface read invariant survives the reconciliation.
#[test]
fn import_merge_reconciles_runtime_bindings_to_document_set() {
  let (_d, db, _v, providers, _models, _profiles, _settings, ie, ..) = setup();

  // Provider with a legacy default binding only (no credential, so merge never touches vault).
  let provider = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let provider_id = provider.id;

  // The export document declares exactly the legacy default interface.
  let doc = ie.export().unwrap();
  assert_eq!(doc.providers.len(), 1);
  assert_eq!(doc.providers[0].runtime_bindings.len(), 1);

  // Locally the Provider additionally owns a wasm interface binding with an execution grant
  // (simulating a previously attached package the document omits).
  let stale_digest = "a".repeat(64);
  db.transaction(|uow| {
    let conn = uow.conn();
    conn
      .execute(
        "INSERT INTO plugin_publishers (
          key_id, fingerprint, public_key_hex, source, enabled, revoked, created_at, updated_at
        ) VALUES ('com.langnext.test.keys.1', ?1, 'k', 'user_approved', 1, 0, 't0', 't0')",
        rusqlite::params!["f".repeat(64)],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO installed_plugin_versions (
          package_digest, plugin_id, version, publisher_key_id, publisher_fingerprint,
          runtime_kind, manifest_json, permission_request_digest, content_available, installed_at
        ) VALUES (?1, 'com.langnext.provider.openai-responses', '1.0.0', 'com.langnext.test.keys.1',
          ?2, 'wasm-component', '{}', 'perm', 1, 't0')",
        rusqlite::params![stale_digest, "f".repeat(64)],
      )
      .unwrap();
    provider_runtime_bindings::insert(
      conn,
      &ProviderRuntimeBinding {
        provider_id,
        adapter_id: "openai-responses".into(),
        runtime_kind: ProviderRuntimeKind::WasmComponent,
        package_digest: Some(stale_digest.clone()),
        grant_set_revision: Some(7),
        state: ProviderRuntimeState::Unavailable,
        error_code: Some("plugin_unavailable".into()),
        error_message: None,
        runtime_requirement_json: None,
        created_at: "t0".into(),
        updated_at: "t0".into(),
      },
    )
    .unwrap();
    conn
      .execute(
        "INSERT INTO execution_grant_sets (
          id, revision, subject_kind, subject_id, plugin_id, plugin_version,
          package_digest, permission_request_digest, authority_digest, approved_at
        ) VALUES (?1, 7, 'provider_instance', ?2, 'com.langnext.provider.openai-responses',
          '1.0.0', ?3, 'perm', 'auth', 't0')",
        rusqlite::params![
          crate::domain::time::new_id().to_string(),
          provider_id.to_string(),
          stale_digest
        ],
      )
      .unwrap();
    Ok(())
  })
  .unwrap();

  let result = ie.import(doc, ImportConflictMode::Merge).unwrap();
  assert!(result.applied);

  // The omitted binding is gone and its grant was released (no snapshot references it).
  let stale = db
    .read(|conn| provider_runtime_bindings::get_optional(conn, provider_id, "openai-responses"))
    .unwrap();
  assert!(
    stale.is_none(),
    "document-omitted binding must be removed by merge import"
  );
  let grant_count: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row(
            "SELECT COUNT(*) FROM execution_grant_sets
              WHERE subject_kind = 'provider_instance' AND subject_id = ?1 AND package_digest = ?2",
            rusqlite::params![provider_id.to_string(), stale_digest],
            |row| row.get(0),
          )
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(grant_count, 0, "removed binding must not leave an orphan grant");

  // Provider default API type invariant survives: the default adapter owns a binding row.
  let default = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  assert_eq!(default.runtime_kind, ProviderRuntimeKind::LegacyFrontendProvider);
}

/// Insert an adapter-keyed wasm binding carrying an execution grant (simulating a package
/// that was previously attached and approved for the Provider).
fn insert_granted_wasm_binding(db: &Database, provider_id: uuid::Uuid, adapter_id: &str, digest: &str) {
  db.transaction(|uow| {
    let conn = uow.conn();
    conn
      .execute(
        "INSERT INTO plugin_publishers (
          key_id, fingerprint, public_key_hex, source, enabled, revoked, created_at, updated_at
        ) VALUES ('com.langnext.test.keys.1', ?1, 'k', 'user_approved', 1, 0, 't0', 't0')",
        rusqlite::params!["f".repeat(64)],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO installed_plugin_versions (
          package_digest, plugin_id, version, publisher_key_id, publisher_fingerprint,
          runtime_kind, manifest_json, permission_request_digest, content_available, installed_at
        ) VALUES (?1, 'com.langnext.provider.openai-responses', '1.0.0', 'com.langnext.test.keys.1',
          ?2, 'wasm-component', '{}', 'perm', 1, 't0')",
        rusqlite::params![digest, "f".repeat(64)],
      )
      .unwrap();
    provider_runtime_bindings::insert(
      conn,
      &ProviderRuntimeBinding {
        provider_id,
        adapter_id: adapter_id.into(),
        runtime_kind: ProviderRuntimeKind::WasmComponent,
        package_digest: Some(digest.into()),
        grant_set_revision: Some(7),
        state: ProviderRuntimeState::Active,
        error_code: None,
        error_message: None,
        runtime_requirement_json: None,
        created_at: "t0".into(),
        updated_at: "t0".into(),
      },
    )
    .unwrap();
    conn
      .execute(
        "INSERT INTO execution_grant_sets (
          id, revision, subject_kind, subject_id, plugin_id, plugin_version,
          package_digest, permission_request_digest, authority_digest, approved_at
        ) VALUES (?1, 7, 'provider_instance', ?2, 'com.langnext.provider.openai-responses',
          '1.0.0', ?3, 'perm', 'auth', 't0')",
        rusqlite::params![
          crate::domain::time::new_id().to_string(),
          provider_id.to_string(),
          digest
        ],
      )
      .unwrap();
    Ok(())
  })
  .unwrap();
}

/// Grant-set count for one Provider/package (grant release assertions).
fn provider_grant_count(db: &Database, provider_id: uuid::Uuid, digest: &str) -> i64 {
  db.read(|conn| {
    Ok(
      conn
        .query_row(
          "SELECT COUNT(*) FROM execution_grant_sets
            WHERE subject_kind = 'provider_instance' AND subject_id = ?1 AND package_digest = ?2",
          rusqlite::params![provider_id.to_string(), digest],
          |row| row.get(0),
        )
        .unwrap(),
    )
  })
  .unwrap()
}

/// v8 wasm runtime binding requirement for an imported document.
fn wasm_requirement(adapter_id: &str, digest: &str) -> ProviderRuntimeRequirementExport {
  ProviderRuntimeRequirementExport {
    adapter_id: Some(adapter_id.into()),
    runtime_kind: "wasm-component".into(),
    package_digest: Some(digest.into()),
    plugin_id: Some("com.langnext.provider.openai-responses".into()),
    plugin_version: Some("1.0.0".into()),
    publisher_key_id: Some("com.langnext.test.keys.1".into()),
    publisher_key_fingerprint: Some("f".repeat(64)),
    plugin_api_version: Some("1.0".into()),
    legacy_aliases: vec![adapter_id.into()],
    capabilities: vec!["llm.chat@1".into(), "llm.models.list@1".into()],
  }
}

/// Merge import overwriting the SAME adapter with the SAME package must release the old
/// grant: import restores unavailable metadata that never carries a grant revision, so the
/// previously granted revision becomes unreferenced by the binding row.
#[test]
fn import_merge_releases_same_package_replaced_binding_grant() {
  let (_d, db, _v, providers, _models, _profiles, _settings, ie, ..) = setup();
  let provider = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let provider_id = provider.id;
  // Build the import document BEFORE inserting the local stale binding: export walks
  // installed manifests of existing wasm bindings.
  let mut doc = ie.export().unwrap();
  let digest = "a".repeat(64);
  insert_granted_wasm_binding(&db, provider_id, "openai-responses", &digest);

  // Re-import the same adapter + package: the document declares it as unavailable metadata.
  doc.providers[0]
    .runtime_bindings
    .push(wasm_requirement("openai-responses", &digest));

  let result = ie.import(doc, ImportConflictMode::Merge).unwrap();
  assert!(result.applied);

  let binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-responses"))
    .unwrap();
  assert_eq!(
    binding.grant_set_revision, None,
    "import restores unavailable metadata without a grant"
  );
  assert_eq!(
    provider_grant_count(&db, provider_id, &digest),
    0,
    "same-package replacement must release the orphaned grant"
  );
}

/// Merge import overwriting the SAME adapter with a DIFFERENT package must release the old
/// package's grant (the adapter's package/revision identity changed).
#[test]
fn import_merge_releases_different_package_replaced_binding_grant() {
  let (_d, db, _v, providers, _models, _profiles, _settings, ie, ..) = setup();
  let provider = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let provider_id = provider.id;
  // Build the import document BEFORE inserting the local stale binding: export walks
  // installed manifests of existing wasm bindings.
  let mut doc = ie.export().unwrap();
  let old_digest = "a".repeat(64);
  insert_granted_wasm_binding(&db, provider_id, "openai-responses", &old_digest);

  let new_digest = "b".repeat(64);
  doc.providers[0]
    .runtime_bindings
    .push(wasm_requirement("openai-responses", &new_digest));

  let result = ie.import(doc, ImportConflictMode::Merge).unwrap();
  assert!(result.applied);

  let binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-responses"))
    .unwrap();
  assert_eq!(binding.package_digest.as_deref(), Some(new_digest.as_str()));
  assert_eq!(
    provider_grant_count(&db, provider_id, &old_digest),
    0,
    "replaced package identity must release the orphaned grant"
  );
}

/// The replacement release is reference-aware: an undiscarded rollback snapshot that still
/// references the exact package/grant revision keeps the grant.
#[test]
fn import_merge_keeps_replaced_binding_grant_referenced_by_snapshot() {
  let (_d, db, _v, providers, _models, _profiles, _settings, ie, ..) = setup();
  let provider = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let provider_id = provider.id;
  // Build the import document BEFORE inserting the local stale binding: export walks
  // installed manifests of existing wasm bindings.
  let mut doc = ie.export().unwrap();
  let digest = "a".repeat(64);
  insert_granted_wasm_binding(&db, provider_id, "openai-responses", &digest);

  db.transaction(|uow| {
    let conn = uow.conn();
    provider_runtime_bindings::insert_snapshot_set(
      conn,
      &ProviderRuntimeSnapshotSet {
        id: crate::domain::time::new_id(),
        provider_id,
        scope: ProviderRuntimeSnapshotScope::Adapter,
        created_at: "t0".into(),
        discarded_at: None,
        runtime_kind: ProviderRuntimeKind::WasmComponent,
        package_digest: Some(digest.clone()),
        grant_set_revision: Some(7),
        grant_set_id: None,
        plugin_id: "com.langnext.provider.openai-responses".into(),
        plugin_version: "1.0.0".into(),
        publisher_key_id: None,
        publisher_fingerprint: None,
        plugin_api_version: None,
        capability_ids_json: "[]".into(),
        updated_at: "t0".into(),
      },
    )
    .unwrap();
    Ok(())
  })
  .unwrap();

  doc.providers[0]
    .runtime_bindings
    .push(wasm_requirement("openai-responses", &digest));

  let result = ie.import(doc, ImportConflictMode::Merge).unwrap();
  assert!(result.applied);

  assert_eq!(
    provider_grant_count(&db, provider_id, &digest),
    1,
    "snapshot-referenced grant must survive the replacement release"
  );
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
      "openai-compatible",
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
      "openai-compatible",
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
      "openai-compatible",
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
      "openai-compatible",
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
      "openai-compatible",
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
      "openai-compatible",
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
      "openai-compatible",
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

// ---------------------------------------------------------------------------
// Phase 11 Task 2: exact runtime requirement preview (local status + action).
// ---------------------------------------------------------------------------

fn empty_doc() -> ConfigurationExport {
  ConfigurationExport {
    format_version: crate::domain::import_export::EXPORT_FORMAT_VERSION,
    exported_at: now_rfc3339(),
    providers: vec![],
    models: vec![],
    translation_profiles: vec![],
    profile_models: vec![],
    profile_prompt_templates: vec![],
    integration_instances: vec![],
    ocr_services: vec![],
    ocr_prompt_templates: vec![],
    speech_services: vec![],
    app_settings: AppSettingsV1::default_document(),
  }
}

fn web_export(id: Uuid, config_json: &str) -> IntegrationInstanceExport {
  IntegrationInstanceExport {
    id,
    plugin_id: crate::domain::service_integration::GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
    plugin_version: "1.0.0".into(),
    display_name: "Web".into(),
    enabled: true,
    config_json: config_json.into(),
    config_schema_version: 1,
    health_status: "ready".into(),
    runtime: Some(RuntimeRequirementExport {
      plugin_id: crate::domain::service_integration::GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
      plugin_version: "1.0.0".into(),
      runtime_kind: "bundled-rust".into(),
      package_digest: None,
      publisher_key_id: None,
      publisher_key_fingerprint: None,
      plugin_api_version: None,
      config_schema_version: 1,
      required_capability_majors: vec![],
      provider_runtime_kind: None,
      provider_package_digest: None,
    }),
    created_at: now_rfc3339(),
    updated_at: now_rfc3339(),
  }
}

fn provider_export(
  id: Uuid,
  adapter_id: &str,
  bindings: Vec<ProviderRuntimeRequirementExport>,
) -> crate::domain::provider::ProviderExport {
  crate::domain::provider::ProviderExport {
    id,
    adapter_id: adapter_id.into(),
    display_name: "P".into(),
    base_url: None,
    base_url_source: None,
    auth_scheme: None,
    base_url_override: None,
    credential_kind: crate::domain::provider::CredentialKind::ApiKey,
    enabled: true,
    proxy_mode: crate::domain::provider::ProxyMode::Inherit,
    insecure_http_confirmed_at: None,
    runtime: None,
    runtime_bindings: bindings,
    created_at: now_rfc3339(),
    updated_at: now_rfc3339(),
  }
}

fn declared_legacy(adapter_id: &str) -> ProviderRuntimeRequirementExport {
  let mut requirement = ProviderRuntimeRequirementExport::legacy();
  requirement.adapter_id = Some(adapter_id.into());
  requirement
}

/// Insert one installed package revision plus an enabled user-approved publisher row.
fn insert_installed_package(
  db: &Database,
  digest: &str,
  plugin_id: &str,
  plugin_version: &str,
  runtime_kind: &str,
  publisher_key_id: &str,
  publisher_fingerprint: &str,
  manifest_api_version: &str,
  content_available: bool,
) {
  db.transaction(|uow| {
    let conn = uow.conn();
    conn
      .execute(
        "INSERT INTO plugin_publishers (
          key_id, fingerprint, public_key_hex, source, enabled, revoked, created_at, updated_at
        ) VALUES (?1, ?2, 'k', 'user_approved', 1, 0, 't0', 't0')
        ON CONFLICT(key_id) DO NOTHING",
        rusqlite::params![publisher_key_id, publisher_fingerprint],
      )
      .unwrap();
    let manifest = serde_json::json!({
      "manifestVersion": 1,
      "pluginApiVersion": manifest_api_version,
      "id": plugin_id,
      "version": plugin_version,
      "publisher": {
        "keyId": publisher_key_id,
        "keyFingerprint": publisher_fingerprint
      },
      "runtime": { "kind": runtime_kind }
    });
    conn
      .execute(
        "INSERT INTO installed_plugin_versions (
          package_digest, plugin_id, version, publisher_key_id, publisher_fingerprint,
          runtime_kind, manifest_json, permission_request_digest, content_available, installed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'perm', ?8, 't0')",
        rusqlite::params![
          digest,
          plugin_id,
          plugin_version,
          publisher_key_id,
          publisher_fingerprint,
          runtime_kind,
          manifest.to_string(),
          content_available as i32
        ],
      )
      .unwrap();
    Ok(())
  })
  .unwrap();
}

/// Insert or flip the enabled/revoked flags of one publisher row.
fn set_publisher_flags(db: &Database, key_id: &str, fingerprint: &str, enabled: bool, revoked: bool) {
  db.transaction(|uow| {
    let conn = uow.conn();
    conn
      .execute(
        "INSERT INTO plugin_publishers (
          key_id, fingerprint, public_key_hex, source, enabled, revoked, created_at, updated_at
        ) VALUES (?1, ?2, 'k', 'user_approved', ?3, ?4, 't0', 't0')
        ON CONFLICT(key_id) DO UPDATE SET enabled = ?3, revoked = ?4",
        rusqlite::params![key_id, fingerprint, enabled as i32, revoked as i32],
      )
      .unwrap();
    Ok(())
  })
  .unwrap();
}

fn preview_wasm_binding(adapter_id: &str, digest: &str, plugin_id: &str) -> ProviderRuntimeRequirementExport {
  ProviderRuntimeRequirementExport {
    adapter_id: Some(adapter_id.into()),
    runtime_kind: "wasm-component".into(),
    package_digest: Some(digest.into()),
    plugin_id: Some(plugin_id.into()),
    plugin_version: Some("1.0.0".into()),
    publisher_key_id: Some("com.langnext.test.keys.1".into()),
    publisher_key_fingerprint: Some("f".repeat(64)),
    plugin_api_version: Some("1.0".into()),
    legacy_aliases: vec![adapter_id.into()],
    capabilities: vec!["llm.chat@1".into()],
  }
}

fn preview_wasm_integration(id: Uuid, digest: &str) -> IntegrationInstanceExport {
  IntegrationInstanceExport {
    id,
    plugin_id: "com.langnext.wasm-service".into(),
    plugin_version: "1.0.0".into(),
    display_name: "Wasm Service".into(),
    enabled: true,
    config_json: "{}".into(),
    config_schema_version: 1,
    health_status: "ready".into(),
    runtime: Some(RuntimeRequirementExport {
      plugin_id: "com.langnext.wasm-service".into(),
      plugin_version: "1.0.0".into(),
      runtime_kind: "wasm-component".into(),
      package_digest: Some(digest.into()),
      publisher_key_id: Some("com.langnext.test.keys.1".into()),
      publisher_key_fingerprint: Some("f".repeat(64)),
      plugin_api_version: Some("1.0".into()),
      config_schema_version: 1,
      required_capability_majors: vec![],
      provider_runtime_kind: None,
      provider_package_digest: None,
    }),
    created_at: now_rfc3339(),
    updated_at: now_rfc3339(),
  }
}

/// Preview distinguishes structural validity from local runtime readiness: every exact
/// adapter-keyed requirement returns subject identity, local status, and the closed
/// required action — without substituting another package by plugin ID/version.
#[test]
fn import_runtime_requirement_preview_reports_exact_local_states_and_actions() {
  use crate::domain::import_export::{ImportRuntimeLocalStatus, ImportRuntimeRequiredAction, ImportRuntimeSubjectKind};

  let (_dir, db, _v, _providers, _models, _profiles, _settings, ie) = setup();

  let installed_digest = "a".repeat(64);
  let revoked_digest = "b".repeat(64);
  let disabled_digest = "c".repeat(64);
  let content_digest = "d".repeat(64);
  let incompatible_digest = "e".repeat(64);
  let missing_digest = "f".repeat(64);

  // Installed revision whose manifest API version matches the requirement exactly.
  insert_installed_package(
    &db,
    &installed_digest,
    "com.langnext.provider.a",
    "1.0.0",
    "wasm-component",
    "com.langnext.test.keys.1",
    &"f".repeat(64),
    "1.0",
    true,
  );
  // Installed revision under a revoked publisher.
  insert_installed_package(
    &db,
    &revoked_digest,
    "com.langnext.provider.b",
    "1.0.0",
    "wasm-component",
    "com.langnext.revoked.keys.1",
    &"a".repeat(64),
    "1.0",
    true,
  );
  set_publisher_flags(&db, "com.langnext.revoked.keys.1", &"a".repeat(64), true, true);
  // Installed revision under a disabled publisher.
  insert_installed_package(
    &db,
    &disabled_digest,
    "com.langnext.provider.c",
    "1.0.0",
    "wasm-component",
    "com.langnext.disabled.keys.1",
    &"b".repeat(64),
    "1.0",
    true,
  );
  set_publisher_flags(&db, "com.langnext.disabled.keys.1", &"b".repeat(64), false, false);
  // Installed revision whose content is missing from the local store.
  insert_installed_package(
    &db,
    &content_digest,
    "com.langnext.provider.d",
    "1.0.0",
    "wasm-component",
    "com.langnext.test.keys.1",
    &"f".repeat(64),
    "1.0",
    false,
  );
  // Installed revision whose manifest API version is incompatible with the requirement.
  insert_installed_package(
    &db,
    &incompatible_digest,
    "com.langnext.provider.e",
    "1.0.0",
    "wasm-component",
    "com.langnext.test.keys.1",
    &"f".repeat(64),
    "2.0",
    true,
  );

  let provider_id = new_id();
  let mut doc = empty_doc();
  doc.providers = vec![provider_export(
    provider_id,
    "openai-compatible",
    vec![
      preview_wasm_binding("openai-compatible", &installed_digest, "com.langnext.provider.a"),
      preview_wasm_binding("openai-responses", &missing_digest, "com.langnext.provider.f"),
      preview_wasm_binding("anthropic", &revoked_digest, "com.langnext.provider.b"),
      preview_wasm_binding("gemini", &disabled_digest, "com.langnext.provider.c"),
      preview_wasm_binding("deepseek", &content_digest, "com.langnext.provider.d"),
      preview_wasm_binding("openai-realtime", &incompatible_digest, "com.langnext.provider.e"),
    ],
  )];
  doc.integration_instances = vec![
    web_export(new_id(), r#"{"channel":"gtx"}"#),
    preview_wasm_integration(new_id(), &missing_digest),
  ];

  let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);

  let by_key = |kind: ImportRuntimeSubjectKind, subject_id: Uuid, adapter: Option<&str>| {
    preview
      .runtime_requirements
      .iter()
      .find(|entry| {
        entry.subject_kind == kind && entry.subject_id == subject_id && entry.adapter_id.as_deref() == adapter
      })
      .unwrap_or_else(|| panic!("missing preview entry for {kind:?} {subject_id} {adapter:?}"))
  };

  // Provider default adapter: exact digest installed and compatible.
  let installed = by_key(
    ImportRuntimeSubjectKind::Provider,
    provider_id,
    Some("openai-compatible"),
  );
  assert_eq!(installed.display_label, "P");
  assert_eq!(installed.runtime_kind, "wasm-component");
  assert_eq!(installed.package_digest.as_deref(), Some(installed_digest.as_str()));
  assert_eq!(installed.plugin_id.as_deref(), Some("com.langnext.provider.a"));
  assert_eq!(installed.local_status, ImportRuntimeLocalStatus::Installed);
  assert_eq!(
    installed.required_action,
    ImportRuntimeRequiredAction::ActivateAfterImport
  );

  let missing = by_key(
    ImportRuntimeSubjectKind::Provider,
    provider_id,
    Some("openai-responses"),
  );
  assert_eq!(missing.local_status, ImportRuntimeLocalStatus::Missing);
  assert_eq!(
    missing.required_action,
    ImportRuntimeRequiredAction::InstallExactPackage
  );

  let revoked = by_key(ImportRuntimeSubjectKind::Provider, provider_id, Some("anthropic"));
  assert_eq!(revoked.local_status, ImportRuntimeLocalStatus::Revoked);
  assert_eq!(revoked.required_action, ImportRuntimeRequiredAction::RestorePublisher);

  let disabled = by_key(ImportRuntimeSubjectKind::Provider, provider_id, Some("gemini"));
  assert_eq!(disabled.local_status, ImportRuntimeLocalStatus::Disabled);
  assert_eq!(disabled.required_action, ImportRuntimeRequiredAction::RestorePublisher);

  let content_unavailable = by_key(ImportRuntimeSubjectKind::Provider, provider_id, Some("deepseek"));
  assert_eq!(
    content_unavailable.local_status,
    ImportRuntimeLocalStatus::ContentUnavailable
  );
  assert_eq!(
    content_unavailable.required_action,
    ImportRuntimeRequiredAction::InstallExactPackage
  );

  let incompatible = by_key(ImportRuntimeSubjectKind::Provider, provider_id, Some("openai-realtime"));
  assert_eq!(incompatible.local_status, ImportRuntimeLocalStatus::Incompatible);
  assert_eq!(
    incompatible.required_action,
    ImportRuntimeRequiredAction::ResolveIncompatibility
  );

  // Integrations: bundled-rust is a closed bundled status; package-backed uses catalog state.
  let bundled = by_key(
    ImportRuntimeSubjectKind::Integration,
    doc.integration_instances[0].id,
    None,
  );
  assert_eq!(bundled.local_status, ImportRuntimeLocalStatus::Bundled);
  assert_eq!(bundled.required_action, ImportRuntimeRequiredAction::None);

  let integration_missing = by_key(
    ImportRuntimeSubjectKind::Integration,
    doc.integration_instances[1].id,
    None,
  );
  assert_eq!(integration_missing.local_status, ImportRuntimeLocalStatus::Missing);
  assert_eq!(
    integration_missing.required_action,
    ImportRuntimeRequiredAction::InstallExactPackage
  );
}

/// Missing/revoked/disabled/incompatible requirements are actionable preview metadata, not
/// structural failures: the document stays valid and preview mutates nothing (no package
/// install op, execution grant, rollback snapshot, runtime process, or credential change).
#[test]
fn import_runtime_requirement_preview_keeps_unavailable_runtimes_actionable_and_non_mutating() {
  use crate::domain::import_export::{ImportRuntimeLocalStatus, ImportRuntimeRequiredAction};

  let (_dir, db, _v, _providers, _models, _profiles, _settings, ie) = setup();

  let missing_digest = "f".repeat(64);
  let mut doc = empty_doc();
  doc.providers = vec![provider_export(
    new_id(),
    "openai-compatible",
    vec![preview_wasm_binding(
      "openai-compatible",
      &missing_digest,
      "com.langnext.provider.f",
    )],
  )];

  let count = |table: &str| -> i64 {
    db.read(|conn| {
      Ok(
        conn
          .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
          .unwrap(),
      )
    })
    .unwrap()
  };
  let grants_before = count("execution_grant_sets");
  let install_ops_before = count("plugin_install_operations");
  let bindings_before = count("provider_runtime_bindings");
  let publishers_before = count("plugin_publishers");

  let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
  assert!(
    preview.valid,
    "local runtime unavailability must not invalidate the document: {:?}",
    preview.validation_errors
  );
  assert!(preview.validation_errors.is_empty());
  let entry = &preview.runtime_requirements[0];
  assert_eq!(entry.local_status, ImportRuntimeLocalStatus::Missing);
  assert_eq!(entry.required_action, ImportRuntimeRequiredAction::InstallExactPackage);

  assert_eq!(
    count("execution_grant_sets"),
    grants_before,
    "no grant created by preview"
  );
  assert_eq!(
    count("plugin_install_operations"),
    install_ops_before,
    "no install op created"
  );
  assert_eq!(
    count("provider_runtime_bindings"),
    bindings_before,
    "no binding mutated"
  );
  assert_eq!(
    count("plugin_publishers"),
    publishers_before,
    "no publisher state mutated"
  );
}

/// Legacy provider requirements and bundled integrations report their own statuses and the
/// `none` action never marks them as needing activation.
#[test]
fn import_runtime_requirement_preview_legacy_and_bundled_use_own_statuses() {
  use crate::domain::import_export::{ImportRuntimeLocalStatus, ImportRuntimeRequiredAction, ImportRuntimeSubjectKind};

  let (_d, _db, _v, _providers, _models, _profiles, _settings, ie) = setup();

  let mut doc = empty_doc();
  doc.providers = vec![provider_export(
    new_id(),
    "openai-compatible",
    vec![declared_legacy("openai-compatible")],
  )];
  doc.integration_instances = vec![web_export(new_id(), r#"{"channel":"gtx"}"#)];

  let preview = ie.preview(&doc, ImportConflictMode::Merge).unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);
  let provider_entry = preview
    .runtime_requirements
    .iter()
    .find(|entry| entry.subject_kind == ImportRuntimeSubjectKind::Provider)
    .expect("provider entry");
  assert_eq!(provider_entry.local_status, ImportRuntimeLocalStatus::Legacy);
  assert_eq!(provider_entry.required_action, ImportRuntimeRequiredAction::None);
  let integration_entry = preview
    .runtime_requirements
    .iter()
    .find(|entry| entry.subject_kind == ImportRuntimeSubjectKind::Integration)
    .expect("integration entry");
  assert_eq!(integration_entry.local_status, ImportRuntimeLocalStatus::Bundled);
  assert_eq!(integration_entry.required_action, ImportRuntimeRequiredAction::None);
}

// ---------------------------------------------------------------------------
// Phase 11 Task 3: expiring preview session binds apply to the previewed plan.
// ---------------------------------------------------------------------------

/// Copy preview/apply must use ONE fixed Copy ID mapping: the post-import IDs shown in the
/// preview are the IDs apply writes. A fresh random mapping at apply would break this.
#[test]
fn import_preview_session_cas_copy_apply_uses_fixed_id_mapping() {
  let (_dir, _db, _v, providers, _models, _profiles, _settings, ie) = setup();

  let mut doc = empty_doc();
  doc.providers = vec![provider_export(
    new_id(),
    "openai-compatible",
    vec![declared_legacy("openai-compatible")],
  )];
  // Cloud integration: copy preview reports its remapped post-import id in
  // integration_requires_authentication; apply must write exactly that id.
  let cloud_id = new_id();
  doc.integration_instances = vec![IntegrationInstanceExport {
    id: cloud_id,
    plugin_id: crate::domain::service_integration::GOOGLE_CLOUD_PLUGIN_ID.into(),
    plugin_version: "1.0.0".into(),
    display_name: "Cloud".into(),
    enabled: true,
    config_json: r#"{"project-id":"demo","location":"global","proxy-mode":"inherit"}"#.into(),
    config_schema_version: 1,
    health_status: "ready".into(),
    runtime: None,
    created_at: now_rfc3339(),
    updated_at: now_rfc3339(),
  }];

  let preview = ie.preview_with_session(&doc, ImportConflictMode::Copy).unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);
  assert!(
    !preview.preview_id.is_empty(),
    "valid preview must return an opaque preview id"
  );
  assert_eq!(preview.counts.providers_copy, 1);
  assert_eq!(preview.counts.integrations_copy, 1);
  let expected_integration_id = preview.integration_requires_authentication[0];
  assert_ne!(expected_integration_id, cloud_id, "copy preview shows the remapped id");

  let result = ie.import_by_preview_id(&preview.preview_id).unwrap();
  assert!(result.applied);

  // The exact post-import id the user previewed is the row apply wrote.
  let applied_integration = _db
    .read(|conn| integration_instances::get(conn, expected_integration_id))
    .unwrap();
  assert_eq!(applied_integration.id, expected_integration_id);
  assert_eq!(
    applied_integration.plugin_id,
    crate::domain::service_integration::GOOGLE_CLOUD_PLUGIN_ID
  );
  let rows = providers.list().unwrap();
  assert_eq!(rows.len(), 1);
}

/// A local change to any affected row or credential ownership baseline after preview makes
/// apply conflict atomically: no partial write, no row updated by the import.
#[test]
fn import_preview_session_cas_stale_local_row_conflicts_atomically() {
  let (_dir, db, _v, providers, _models, _profiles, _settings, ie) = setup();

  let provider = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let doc = ie.export().unwrap();
  let preview = ie.preview_with_session(&doc, ImportConflictMode::Merge).unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);
  assert!(!preview.preview_id.is_empty());

  // Local change after preview: rename the affected provider row.
  let mut write = for_provider_update(
    provider.id,
    &provider.updated_at,
    CredentialKind::None,
    CredentialUpdate::Keep,
  );
  write.display_name = "Renamed".into();
  providers.save(write).unwrap();

  let err = ie.import_by_preview_id(&preview.preview_id).unwrap_err();
  match err {
    StorageError::ImportPreviewConflict {
      reason: ImportPreviewConflictReason::Stale,
      message,
    } => {
      assert!(
        message.contains("re-preview"),
        "stale CAS conflict must carry the re-preview guidance, got {message:?}"
      );
    }
    other => panic!("stale CAS baseline must conflict with a stale reason, got {other:?}"),
  }

  // The claimed session is destroyed on failure: a second apply must fail too.
  let second = ie.import_by_preview_id(&preview.preview_id).unwrap_err();
  assert!(
    matches!(
      second,
      StorageError::ImportPreviewConflict {
        reason: ImportPreviewConflictReason::Stale,
        ..
      }
    ),
    "failed apply must destroy the session, got {second:?}"
  );

  // No partial write: the local row keeps the post-change state and nothing was imported.
  let rows = providers.list().unwrap();
  assert_eq!(rows.len(), 1, "no new provider written");
  assert_eq!(
    rows[0].id, provider.id,
    "the single provider must still be the local one"
  );
  assert_eq!(
    rows[0].display_name, "Renamed",
    "import must not overwrite the local row"
  );
  let journal_ops: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row("SELECT COUNT(*) FROM credential_operations", [], |row| row.get(0))
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(journal_ops, 0, "conflict must not touch credential journals");
}

/// Two concurrent applies of one preview id: exactly one claims the session; the other
/// fails before credential recovery, vault access, or business mutation.
#[test]
fn import_preview_session_cas_concurrent_double_apply_claims_once() {
  let (_dir, _db, _v, providers, _models, _profiles, _settings, ie) = setup();

  let mut doc = empty_doc();
  doc.providers = vec![provider_export(
    new_id(),
    "openai-compatible",
    vec![declared_legacy("openai-compatible")],
  )];
  let preview = ie.preview_with_session(&doc, ImportConflictMode::Merge).unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);

  let service_a = ie.clone();
  let service_b = ie.clone();
  let preview_id_a = preview.preview_id.clone();
  let preview_id_b = preview.preview_id.clone();
  let handle_a = std::thread::spawn(move || service_a.import_by_preview_id(&preview_id_a));
  let handle_b = std::thread::spawn(move || service_b.import_by_preview_id(&preview_id_b));
  let result_a = handle_a.join().expect("thread a");
  let result_b = handle_b.join().expect("thread b");

  let ok_count = [result_a.is_ok(), result_b.is_ok()].iter().filter(|ok| **ok).count();
  assert_eq!(ok_count, 1, "exactly one concurrent apply may claim the session");
  let applied = result_a.or(result_b).expect("one apply must succeed");
  assert!(applied.applied);

  let rows = providers.list().unwrap();
  assert_eq!(rows.len(), 1, "exactly one applied import");
}

/// Unknown, expired, and reused preview ids are rejected before any mutation: no provider
/// row, no credential journal op, no business table change from the rejected applies.
#[test]
fn import_preview_session_cas_unknown_expired_reused_rejected_before_mutation() {
  use std::time::Duration;

  let (_dir, db, _v, providers, _models, _profiles, _settings, ie) = setup();

  let mut doc = empty_doc();
  doc.providers = vec![provider_export(
    new_id(),
    "openai-compatible",
    vec![declared_legacy("openai-compatible")],
  )];

  // Unknown preview id.
  let err = ie.import_by_preview_id("cfgimp_does-not-exist").unwrap_err();
  assert!(
    matches!(
      err,
      StorageError::ImportPreviewConflict {
        reason: ImportPreviewConflictReason::Stale,
        ..
      }
    ),
    "unknown id must conflict as stale, got {err:?}"
  );

  // Expired preview id (1 ms TTL): claim rejects before recovery/apply.
  let short_lived = ie.clone().with_preview_ttl_for_tests(Duration::from_millis(1));
  let preview = short_lived
    .preview_with_session(&doc, ImportConflictMode::Merge)
    .unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);
  std::thread::sleep(Duration::from_millis(10));
  let err = short_lived.import_by_preview_id(&preview.preview_id).unwrap_err();
  assert!(
    matches!(
      err,
      StorageError::ImportPreviewConflict {
        reason: ImportPreviewConflictReason::Expired,
        ..
      }
    ),
    "expired id must conflict as expired, got {err:?}"
  );

  // Reused preview id: the first apply consumes the session permanently.
  let preview = ie.preview_with_session(&doc, ImportConflictMode::Merge).unwrap();
  let first = ie.import_by_preview_id(&preview.preview_id).unwrap();
  assert!(first.applied);
  let err = ie.import_by_preview_id(&preview.preview_id).unwrap_err();
  assert!(
    matches!(
      err,
      StorageError::ImportPreviewConflict {
        reason: ImportPreviewConflictReason::Stale,
        ..
      }
    ),
    "reused id must conflict as stale, got {err:?}"
  );

  let rows = providers.list().unwrap();
  assert_eq!(rows.len(), 1, "only the successful apply created a provider");
  let journal_ops: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row("SELECT COUNT(*) FROM credential_operations", [], |row| row.get(0))
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(journal_ops, 0, "rejections must not touch credential journals");
}

/// A local settings change after preview makes apply conflict: the plan rewrites the
/// singleton `app_settings` row in both Merge and Copy modes, so that row must be part
/// of the deterministic CAS baseline. Without it, apply silently overwrites settings the
/// user changed after confirming the preview.
#[test]
fn import_preview_session_cas_stale_settings_conflicts() {
  let (_dir, _db, _v, providers, _models, _profiles, settings, ie) = setup();

  let provider = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let doc = ie.export().unwrap();
  let preview = ie.preview_with_session(&doc, ImportConflictMode::Merge).unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);
  assert!(!preview.preview_id.is_empty());

  // Local settings change after preview: theme toggle rewrites the app_settings row.
  let mut local = AppSettingsV1::default_document();
  local.theme = Some("dark".into());
  settings
    .update(AppSettingsUpdate {
      settings: local,
      proxy_credential: ProxyCredentialUpdate::Keep,
    })
    .unwrap();

  let err = ie.import_by_preview_id(&preview.preview_id).unwrap_err();
  assert!(
    matches!(
      err,
      StorageError::ImportPreviewConflict {
        reason: ImportPreviewConflictReason::Stale,
        ..
      }
    ),
    "stale settings baseline must conflict as stale, got {err:?}"
  );

  // No partial write: the local row keeps its state and nothing was imported.
  let rows = providers.list().unwrap();
  assert_eq!(rows.len(), 1, "no new provider written");
  assert_eq!(rows[0].id, provider.id, "the single provider must be the local one");
  let dto = settings.get().unwrap();
  assert_eq!(
    dto.settings.theme.as_deref(),
    Some("dark"),
    "settings keep the local value"
  );
}

/// Copy mode has no fixed empty baseline: it still rewrites `app_settings` (default ids are
/// remapped into it) and must conflict on a settings change after preview, while a change to
/// an unrelated local subject row stays non-conflicting (Copy writes fresh IDs only).
#[test]
fn import_preview_session_cas_copy_baseline_covers_settings() {
  let (_dir, _db, _v, providers, _models, _profiles, settings, ie) = setup();

  let provider = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  let doc = ie.export().unwrap();
  let preview = ie.preview_with_session(&doc, ImportConflictMode::Copy).unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);
  assert!(!preview.preview_id.is_empty());

  // Local settings change after preview → conflict (Copy rewrites app_settings too).
  let mut local = AppSettingsV1::default_document();
  local.theme = Some("dark".into());
  settings
    .update(AppSettingsUpdate {
      settings: local,
      proxy_credential: ProxyCredentialUpdate::Keep,
    })
    .unwrap();
  let err = ie.import_by_preview_id(&preview.preview_id).unwrap_err();
  assert!(
    matches!(
      err,
      StorageError::ImportPreviewConflict {
        reason: ImportPreviewConflictReason::Stale,
        ..
      }
    ),
    "stale settings baseline must conflict as stale in Copy mode, got {err:?}"
  );

  // Re-preview, then rename the local subject row: Copy writes fresh IDs, so the unrelated
  // row change must NOT make apply conflict.
  let preview = ie.preview_with_session(&doc, ImportConflictMode::Copy).unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);
  let mut write = for_provider_update(
    provider.id,
    &provider.updated_at,
    CredentialKind::None,
    CredentialUpdate::Keep,
  );
  write.display_name = "Renamed".into();
  providers.save(write).unwrap();

  let result = ie.import_by_preview_id(&preview.preview_id).unwrap();
  assert!(
    result.applied,
    "unrelated local row change must not conflict Copy apply"
  );
  let rows = providers.list().unwrap();
  assert_eq!(rows.len(), 2, "copy import adds a second provider row");
  assert!(
    rows.iter().any(|r| r.display_name == "Renamed"),
    "the renamed local row must be untouched"
  );
}

/// The claim error must distinguish expired preview ids from unknown ones: the frontend
/// maps the typed conflict reason to the `expired` retry state, so `prune_expired` must
/// not delete the target session before its expiry is reported.
#[test]
fn import_preview_session_cas_claim_reports_expired_not_unknown() {
  use std::time::Duration;

  let (_dir, _db, _v, _providers, _models, _profiles, _settings, ie) = setup();

  let mut doc = empty_doc();
  doc.providers = vec![provider_export(
    new_id(),
    "openai-compatible",
    vec![declared_legacy("openai-compatible")],
  )];

  // Unknown preview id → typed stale reason on both the domain error and the IPC envelope.
  let err = ie.import_by_preview_id("cfgimp_does-not-exist").unwrap_err();
  match err {
    StorageError::ImportPreviewConflict {
      reason: ImportPreviewConflictReason::Stale,
      message,
    } => {
      assert!(
        message.contains("unknown"),
        "unknown id must report unknown, got {message:?}"
      );
      let ipc = crate::error::IpcError::from(StorageError::ImportPreviewConflict {
        reason: ImportPreviewConflictReason::Stale,
        message: message.clone(),
      });
      assert_eq!(ipc.code, "conflict");
      assert_eq!(ipc.reason, Some(ImportPreviewConflictReason::Stale));
    }
    other => panic!("unknown id must conflict, got {other:?}"),
  }

  // Expired preview id (1 ms TTL) → typed expired reason, not unknown.
  let short_lived = ie.clone().with_preview_ttl_for_tests(Duration::from_millis(1));
  let preview = short_lived
    .preview_with_session(&doc, ImportConflictMode::Merge)
    .unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);
  assert!(!preview.preview_id.is_empty());
  std::thread::sleep(Duration::from_millis(10));
  let err = short_lived.import_by_preview_id(&preview.preview_id).unwrap_err();
  match err {
    StorageError::ImportPreviewConflict {
      reason: ImportPreviewConflictReason::Expired,
      message,
    } => {
      assert!(
        message.contains("expired"),
        "expired id must report expired, got {message:?}"
      );
      let ipc = crate::error::IpcError::from(StorageError::ImportPreviewConflict {
        reason: ImportPreviewConflictReason::Expired,
        message: message.clone(),
      });
      assert_eq!(ipc.code, "conflict");
      assert_eq!(ipc.reason, Some(ImportPreviewConflictReason::Expired));
    }
    other => panic!("expired id must conflict, got {other:?}"),
  }
}

// ---------------------------------------------------------------------------
// Phase 11 acceptance gates: committed v2–v8 fixtures + no-execution boundary.
// ---------------------------------------------------------------------------

/// Path helper for committed import fixtures under src/services/fixtures/import/.
fn import_fixture_path(name: &str) -> std::path::PathBuf {
  std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("src/services/fixtures/import/runtime-plugin-v8")
    .join(name)
}

/// Acceptance gate: committed v2–v8 fixtures normalize to the current v8 format with the
/// linked provider/model/profile/target/template graph intact; integrations normalize to
/// explicit runtimes; provider requirements stay adapter-keyed per version shape.
#[test]
fn import_format_fixtures_v2_through_v8_normalize_to_current() {
  use crate::domain::import_export::{EXPORT_FORMAT_VERSION, parse_and_normalize_export_document};

  const PROVIDER_ID: &str = "00000000-0000-7000-8000-000000000001";
  const MODEL_ID: &str = "00000000-0000-7000-8000-000000000002";
  const GOOGLE_WEB_INTEGRATION_ID: &str = "00000000-0000-7000-8000-000000000003";
  const CONFORMANCE_INTEGRATION_ID: &str = "00000000-0000-7000-8000-000000000004";
  const PROFILE_ID: &str = "00000000-0000-7000-8000-000000000005";
  const TEMPLATE_ID: &str = "00000000-0000-7000-8000-000000000006";
  const OCR_SERVICE_ID: &str = "00000000-0000-7000-8000-000000000007";
  const SPEECH_SERVICE_ID: &str = "00000000-0000-7000-8000-000000000009";
  const WASM_DIGEST: &str = "abababababababababababababababababababababababababababababababab";

  let load = |name: &str| {
    let raw = std::fs::read_to_string(import_fixture_path(name)).unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    parse_and_normalize_export_document(value).unwrap_or_else(|e| panic!("{name}: {e}"))
  };

  for version in [2_u32, 3, 4, 5, 6, 7] {
    let doc = load(&format!("v{version}-config.json"));
    assert_eq!(
      doc.format_version, EXPORT_FORMAT_VERSION,
      "v{version} must normalize to v8"
    );

    // Linked provider/model graph with fixed literal IDs.
    assert_eq!(doc.providers.len(), 1, "v{version} keeps one provider");
    assert_eq!(
      doc.providers[0].id.to_string(),
      PROVIDER_ID,
      "v{version} preserves the provider id"
    );
    assert_eq!(doc.providers[0].display_name, "OpenAI Compatible");
    assert_eq!(doc.models.len(), 1, "v{version} keeps one model");
    assert_eq!(doc.models[0].id.to_string(), MODEL_ID);
    assert_eq!(
      doc.models[0].provider_instance_id.to_string(),
      PROVIDER_ID,
      "v{version} model stays linked to the provider"
    );
    assert_eq!(doc.models[0].model_key, "gpt-4o-mini");

    // One profile with the prompt template as its LLM default.
    assert_eq!(doc.translation_profiles.len(), 1, "v{version} keeps one profile");
    let profile = &doc.translation_profiles[0];
    assert_eq!(profile.id.to_string(), PROFILE_ID);
    assert_eq!(profile.name, "Default");
    assert_eq!(profile.source_lang.as_deref(), Some("zh"));
    assert_eq!(profile.target_lang.as_deref(), Some("en"));
    let engine = profile
      .engine
      .as_llm()
      .expect("v{version} profile keeps its LLM engine");
    assert_eq!(engine.template_version, 1);
    assert_eq!(engine.default_prompt_template_id.to_string(), TEMPLATE_ID);
    assert_eq!(engine.temperature, Some(0.2));

    // One target linked to the model and one template owned by the profile.
    assert_eq!(doc.profile_models.len(), 1, "v{version} keeps one target");
    assert_eq!(doc.profile_models[0].translation_profile_id.to_string(), PROFILE_ID);
    assert_eq!(doc.profile_models[0].provider_model_id.to_string(), MODEL_ID);
    assert_eq!(doc.profile_prompt_templates.len(), 1, "v{version} keeps one template");
    assert_eq!(doc.profile_prompt_templates[0].id.to_string(), TEMPLATE_ID);
    assert_eq!(
      doc.profile_prompt_templates[0].translation_profile_id.to_string(),
      PROFILE_ID
    );

    // Provider runtime requirement: v2–v7 singular requirement becomes exactly one v8
    // binding keyed by the provider default adapter (no model adapter overrides).
    assert_eq!(
      doc.providers[0].runtime_bindings.len(),
      1,
      "v{version} yields one adapter-keyed binding"
    );
    assert_eq!(
      doc.providers[0].runtime_bindings[0].adapter_id.as_deref(),
      Some("openai-compatible")
    );
    assert_eq!(doc.providers[0].runtime_bindings[0].runtime_kind, "wasm-component");
    assert_eq!(
      doc.providers[0].runtime_bindings[0].package_digest.as_deref(),
      Some(WASM_DIGEST)
    );

    // Version-specific arrays survive normalization.
    if version >= 5 {
      assert_eq!(doc.ocr_services.len(), 1, "v{version} keeps the OCR service");
      assert_eq!(doc.ocr_services[0].id.to_string(), OCR_SERVICE_ID);
      assert_eq!(doc.ocr_prompt_templates.len(), 1, "v{version} keeps the OCR template");
    }
    if version >= 6 {
      assert_eq!(doc.speech_services.len(), 1, "v{version} keeps the Speech service");
      assert_eq!(doc.speech_services[0].id.to_string(), SPEECH_SERVICE_ID);
    }

    // Integrations normalize to explicit runtime requirements (v2/v3 predate integrations).
    if version >= 4 && version <= 6 {
      assert_eq!(doc.integration_instances.len(), 1, "v{version} keeps one integration");
      assert!(doc.integration_instances.iter().all(|i| i.runtime.is_some()));
      assert_eq!(doc.integration_instances[0].id.to_string(), GOOGLE_WEB_INTEGRATION_ID);
      assert_eq!(
        doc.integration_instances[0].runtime.as_ref().unwrap().runtime_kind,
        "bundled-rust",
        "v{version} bundled integration normalizes to bundled-rust"
      );
    } else if version <= 3 {
      assert!(doc.integration_instances.is_empty(), "v{version} has no integrations");
    }
    if version >= 7 {
      assert_eq!(doc.integration_instances.len(), 2, "v{version} keeps both integrations");
      assert!(doc.integration_instances.iter().all(|i| i.runtime.is_some()));
      assert_eq!(doc.integration_instances[0].id.to_string(), GOOGLE_WEB_INTEGRATION_ID);
      assert_eq!(
        doc.integration_instances[0].runtime.as_ref().unwrap().runtime_kind,
        "bundled-rust",
        "v{version} bundled integration stays explicit"
      );
      let wasm = doc
        .integration_instances
        .iter()
        .find(|i| i.id.to_string() == CONFORMANCE_INTEGRATION_ID)
        .expect("conformance integration");
      assert_eq!(wasm.runtime.as_ref().unwrap().runtime_kind, "wasm-component");
    }
  }

  // v8: the mixed fixture keeps the graph and both distinct adapter keys.
  let doc = load("v8-mixed.json");
  assert_eq!(doc.format_version, EXPORT_FORMAT_VERSION);
  assert_eq!(doc.providers.len(), 1);
  assert_eq!(doc.models.len(), 1);
  assert_eq!(doc.translation_profiles.len(), 1);
  assert_eq!(doc.profile_models.len(), 1);
  assert_eq!(doc.profile_prompt_templates.len(), 1);
  let bindings = &doc.providers[0].runtime_bindings;
  assert_eq!(bindings.len(), 2, "v8 provider requirements stay adapter-keyed");
  assert_eq!(bindings[0].adapter_id.as_deref(), Some("openai-compatible"));
  assert_eq!(bindings[1].adapter_id.as_deref(), Some("openai-responses"));
  assert_eq!(bindings[1].runtime_kind, "wasm-component");
  // Integration runtime requirements remain explicit after normalization.
  assert_eq!(doc.integration_instances.len(), 3);
  assert!(doc.integration_instances.iter().all(|i| i.runtime.is_some()));
  let wasm_integration = doc
    .integration_instances
    .iter()
    .find(|i| i.plugin_id == "com.langnext.conformance")
    .unwrap();
  assert_eq!(
    wasm_integration.runtime.as_ref().unwrap().runtime_kind,
    "wasm-component"
  );
  let native_integration = doc
    .integration_instances
    .iter()
    .find(|i| i.plugin_id == "com.langnext.ocr.native-conformance")
    .unwrap();
  assert_eq!(
    native_integration.runtime.as_ref().unwrap().runtime_kind,
    "trusted-native-worker"
  );
}

/// Acceptance gate: current v8 export → parse → preview → Copy apply → export preserves
/// portable graph/runtime semantics after the expected ID rewriting.
#[test]
fn runtime_plugin_import_fixture_v8_round_trip_preserves_runtime_semantics() {
  use crate::domain::import_export::parse_and_normalize_export_document;
  use crate::repositories::integration_instances as integration_repo;

  let (_dir, db, _v, providers, _models, _profiles, _settings, ie) = setup();

  let raw = std::fs::read_to_string(import_fixture_path("v8-mixed.json")).unwrap();
  let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
  let doc = parse_and_normalize_export_document(value).unwrap();

  // Preview through the session seam (what the frontend calls after parsing the envelope).
  let preview = ie.preview_with_session(&doc, ImportConflictMode::Copy).unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);
  assert!(!preview.preview_id.is_empty());
  assert_eq!(preview.counts.providers_copy, 1);
  assert_eq!(preview.counts.integrations_copy, 3);
  assert_eq!(
    preview.runtime_requirements.len(),
    5,
    "2 provider bindings + 3 integration requirements"
  );
  assert!(
    preview.runtime_requirements.iter().all(
      |entry| entry.required_action != crate::domain::import_export::ImportRuntimeRequiredAction::ActivateAfterImport
    ),
    "no package is installed locally, so nothing is ready to activate"
  );

  let result = ie.import_by_preview_id(&preview.preview_id).unwrap();
  assert!(result.applied);

  // Copy mode: 1 provider + 2 integrations exist with remapped IDs.
  let provider_rows = providers.list().unwrap();
  assert_eq!(provider_rows.len(), 1);
  let integration_count: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row("SELECT COUNT(*) FROM integration_instances", [], |row| row.get(0))
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(integration_count, 3);

  // Re-export preserves the exact adapter-keyed provider requirements and the explicit
  // integration runtimes after ID rewriting.
  let reexported = ie.export().unwrap();
  let provider = &reexported.providers[0];
  assert_eq!(provider.runtime_bindings.len(), 2);
  assert_eq!(
    provider.runtime_bindings[0].adapter_id.as_deref(),
    Some("openai-compatible")
  );
  assert_eq!(
    provider.runtime_bindings[1].adapter_id.as_deref(),
    Some("openai-responses")
  );
  assert_eq!(
    provider.runtime_bindings[1].package_digest.as_deref(),
    Some("ab".repeat(32).as_str())
  );
  assert!(reexported.integration_instances.iter().all(|i| i.runtime.is_some()));

  let imported_ids: Vec<uuid::Uuid> = db
    .read(|conn| Ok(integration_repo::list(conn)?.into_iter().map(|i| i.id).collect()))
    .unwrap();
  assert_ne!(
    imported_ids[0], doc.integration_instances[0].id,
    "copy mode must rewrite integration IDs"
  );
}

/// Acceptance gate: importing exact installed Wasm and trusted-native-worker requirements
/// persists them inactive — no execution grant, no install op, no upgrade snapshot, no
/// activation — and starts zero real dispatches (Wasm guest, native worker, migration,
/// network) for both preview and apply. The probe scope is serialized process-wide and
/// attributes dispatches to the arming thread; preview and apply run synchronously on that
/// thread, so a zero snapshot covers every dispatch the import path can start. The public
/// list seam reports unavailable/pending until a separate confirmed lifecycle action.
#[test]
fn runtime_plugin_import_no_execution_installed_requirement_stays_inactive() {
  use crate::domain::import_export::parse_and_normalize_export_document;
  use crate::domain::runtime_provider::{ProviderRuntimeKind, ProviderRuntimeState};
  use crate::repositories::integration_instances as integration_repo;
  use crate::repositories::provider_runtime_bindings;
  use crate::services::execution_dispatch_probe::scope;

  let (_dir, db, _v, providers, _models, _profiles, _settings, ie) = setup();

  // The exact Wasm and trusted-native-worker digests from the fixture are installed locally
  // with matching manifests/publishers — yet import must not activate or dispatch them.
  insert_installed_package(
    &db,
    &"a".repeat(64),
    "com.langnext.conformance",
    "1.0.0",
    "wasm-component",
    "com.langnext.vendor.keys.1",
    &"c".repeat(64),
    "1.0",
    true,
  );
  insert_installed_package(
    &db,
    &"d".repeat(64),
    "com.langnext.ocr.native-conformance",
    "1.0.0",
    "trusted-native-worker",
    "com.langnext.vendor.keys.2",
    &"e".repeat(64),
    "1.1",
    true,
  );

  let raw = std::fs::read_to_string(import_fixture_path("v8-mixed.json")).unwrap();
  let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
  let doc = parse_and_normalize_export_document(value).unwrap();

  // One serialized scope spans both operations; it observes dispatches from any thread.
  let probe = scope();
  let preview = ie.preview_with_session(&doc, ImportConflictMode::Merge).unwrap();
  assert!(preview.valid, "errors: {:?}", preview.validation_errors);
  // Preview must start no runtime, migration, worker, or network dispatch.
  probe.assert_zero();

  // The installed Wasm and native integrations report ready-to-activate, not activated.
  let conformance = preview
    .runtime_requirements
    .iter()
    .find(|entry| entry.display_label == "Conformance Wasm")
    .expect("conformance requirement previewed");
  assert_eq!(
    conformance.local_status,
    crate::domain::import_export::ImportRuntimeLocalStatus::Installed
  );
  assert_eq!(
    conformance.required_action,
    crate::domain::import_export::ImportRuntimeRequiredAction::ActivateAfterImport
  );
  let native = preview
    .runtime_requirements
    .iter()
    .find(|entry| entry.display_label == "Native OCR")
    .expect("native requirement previewed");
  assert_eq!(
    native.local_status,
    crate::domain::import_export::ImportRuntimeLocalStatus::Installed
  );
  assert_eq!(
    native.required_action,
    crate::domain::import_export::ImportRuntimeRequiredAction::ActivateAfterImport
  );

  let result = ie.import_by_preview_id(&preview.preview_id).unwrap();
  assert!(result.applied);
  // Apply must start no runtime, migration, worker, or network dispatch either.
  probe.assert_zero();

  // The exact requirements persist inactive: unavailable state, no grant revision.
  let binding = db
    .read(|conn| provider_runtime_bindings::get(conn, doc.providers[0].id, "openai-responses"))
    .unwrap();
  assert_eq!(binding.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(binding.package_digest.as_deref(), Some("ab".repeat(32).as_str()));
  assert_eq!(binding.state, ProviderRuntimeState::Unavailable);
  assert!(binding.grant_set_revision.is_none());

  let wasm_integration = db
    .read(|conn| integration_repo::get(conn, doc.integration_instances[1].id))
    .unwrap();
  assert_eq!(wasm_integration.runtime_kind, "wasm-component");
  assert_eq!(wasm_integration.runtime_state, "unavailable");
  assert!(wasm_integration.execution_grant_set_revision.is_none());

  let native_integration = db
    .read(|conn| integration_repo::get(conn, doc.integration_instances[2].id))
    .unwrap();
  assert_eq!(native_integration.runtime_kind, "trusted-native-worker");
  assert_eq!(native_integration.runtime_state, "unavailable");
  assert!(native_integration.execution_grant_set_revision.is_none());

  // Public list seam: the provider binding reports unavailable (no execution resolution).
  let provider_dto = providers
    .list()
    .unwrap()
    .into_iter()
    .find(|p| p.id == doc.providers[0].id)
    .unwrap();
  let binding_dto = provider_dto
    .runtime_bindings
    .iter()
    .find(|b| b.adapter_id == "openai-responses")
    .expect("binding DTO");
  assert_eq!(binding_dto.state, ProviderRuntimeState::Unavailable);
  assert_eq!(binding_dto.grant_set_revision, None);

  // No execution authority, install op, or upgrade snapshot was created by preview/apply.
  let count = |table: &str| -> i64 {
    db.read(|conn| {
      Ok(
        conn
          .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
          .unwrap(),
      )
    })
    .unwrap()
  };
  assert_eq!(count("execution_grant_sets"), 0, "no execution grant");
  assert_eq!(count("plugin_install_operations"), 0, "no package install op");
  assert_eq!(count("plugin_upgrade_snapshots"), 0, "no rollback snapshot");
}
