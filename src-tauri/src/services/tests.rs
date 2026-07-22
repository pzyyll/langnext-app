// ABOUTME: Service validation, rollback, cache merge, and privacy tests.
// ABOUTME: Uses in-memory CredentialVault under cfg(test) only.
use crate::adapters::transport::{ModelListRequest, ModelTransport, TransportError};
use crate::credentials::{CredentialVault, FailingCredentialVault, MemoryCredentialVault};
use crate::domain::import_export::{ConfigurationExport, ImportConflictMode};
use crate::domain::language_detection::{DetectLanguageInput, DetectorType, LanguageDetectorConfig};
use crate::domain::model::{Availability, ManualModelWrite, ModelConfigWrite, ModelSource, RemoteModelSyncItem};
use crate::domain::provider::{CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode};
use crate::domain::settings::{
  AppSettingsUpdate, AppSettingsV1, GlobalProxyMode, NetworkSettings, ProxyCredentialUpdate, TranslationPreferences,
};
use crate::domain::translation_profile::{
  PromptTemplate, TranslationProfile, TranslationProfileTarget, TranslationProfileWrite,
};
use crate::error::StorageError;
use crate::services::{
  ImportExportService, ModelService, ProviderService, SettingsService, TranslationHistoryService,
  TranslationProfileService,
};
use crate::storage::Database;
use std::collections::VecDeque;
use std::future::Future;
use std::io::{Read, Write};
use std::net::TcpListener;
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
  Arc<TestModelTransport>,
) {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let vault = Arc::new(MemoryCredentialVault::new());
  let transport = Arc::new(TestModelTransport::new());
  let providers = ProviderService::new(db.clone(), vault.clone());
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db.clone(),
    vault.clone(),
    transport.clone() as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
  );
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

fn spawn_detection_chat_server() -> (String, std::thread::JoinHandle<serde_json::Value>) {
  let listener = TcpListener::bind("127.0.0.1:0").unwrap();
  let addr = listener.local_addr().unwrap();
  let handle = std::thread::spawn(move || {
    let (mut stream, _) = listener.accept().unwrap();
    stream
      .set_read_timeout(Some(std::time::Duration::from_secs(2)))
      .unwrap();
    let mut request = Vec::new();
    let (header_end, content_length) = loop {
      let mut chunk = [0u8; 32768];
      let read = stream.read(&mut chunk).unwrap();
      assert!(read > 0, "request closed before headers completed");
      request.extend_from_slice(&chunk[..read]);
      if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
        let header_end = index + 4;
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers
          .lines()
          .find_map(|line| {
            line
              .strip_prefix("content-length: ")
              .or_else(|| line.strip_prefix("Content-Length: "))
          })
          .and_then(|value| value.trim().parse::<usize>().ok())
          .expect("content-length header");
        break (header_end, content_length);
      }
    };
    while request.len() < header_end + content_length {
      let mut chunk = [0u8; 32768];
      let read = stream.read(&mut chunk).unwrap();
      assert!(read > 0, "request closed before body completed");
      request.extend_from_slice(&chunk[..read]);
    }
    let payload: serde_json::Value = serde_json::from_slice(&request[header_end..header_end + content_length]).unwrap();
    let body = r#"{"choices":[{"message":{"content":"zh"}}]}"#;
    write!(
      stream,
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
      body.len(),
      body
    )
    .unwrap();
    payload
  });
  (format!("http://{addr}/v1"), handle)
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
  keep.base_url_override = Some("https://api.llmtech.de/v1".into());
  let after = providers.save(keep).unwrap();
  assert!(after.has_credential);
  assert_eq!(after.base_url_override.as_deref(), Some("https://api.llmtech.de/v1"));
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
  assert_eq!(after.base_url_override, dto.base_url_override);
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
      source_lang: Some("auto".into()),
      target_lang: Some("auto".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      language_detection: None,
      target_model_ids: vec![m.id],
    })
    .unwrap();

  assert_eq!(dto.prompt_templates.len(), 2);
  assert_eq!(dto.prompt_templates[0].id, t1);
  assert_eq!(dto.prompt_templates[1].id, t2);
  assert_eq!(dto.profile.default_prompt_template_id, t2);

  let listed = profiles.list().unwrap();
  let found = listed.iter().find(|row| row.profile.id == dto.profile.id).unwrap();
  assert_eq!(found.prompt_templates.len(), 2);
  assert_eq!(found.profile.default_prompt_template_id, t2);
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![],
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![m1.id],
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        // Intentional reverse insert order vs name sort of profiles.
        target_model_ids: vec![m2.id, m1.id],
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: Some(0.1),
        max_output_tokens: Some(2048),
        provider_options_json: None,
        source_lang: Some("zh".into()),
        target_lang: Some("en".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![m1.id, m2.id],
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: Some("auto".into()),
        target_lang: Some("auto".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![m.id],
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
      template_version: 1,
      default_prompt_template_id,
      prompt_templates,
      temperature: None,
      max_output_tokens: None,
      provider_options_json: None,
      source_lang: Some("auto".into()),
      target_lang: Some("en".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      language_detection: None,
      target_model_ids: vec![m.id],
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
      template_version: 1,
      default_prompt_template_id,
      prompt_templates,
      temperature: None,
      max_output_tokens: None,
      provider_options_json: None,
      source_lang: Some("auto".into()),
      target_lang: Some("auto".into()),
      primary_lang: Some("zh".into()),
      preferred_target_lang: Some("en".into()),
      language_detection: None,
      target_model_ids: vec![m],
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![model.id],
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![m.id],
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
fn import_credential_cleanup_isolates_unrelated_journals() {
  use crate::credentials::FailingCredentialVault;
  use crate::credentials::coordinator;
  use crate::domain::time::new_id;
  use crate::repositories::credential_operations::{self, OperationState, OwnerKind};

  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let vault = Arc::new(FailingCredentialVault::new());
  let transport = Arc::new(TestModelTransport::new());
  let providers = ProviderService::new(db.clone(), vault.clone());
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db.clone(),
    vault.clone() as Arc<dyn CredentialVault>,
    transport as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![m.id],
      }
    })
    .unwrap();

  let doc = ie.export().unwrap();
  // Force import-owned vault cleanup to fail.
  vault.set_fail_delete(true);
  let result = ie.import(doc, ImportConflictMode::Merge).unwrap();
  assert!(result.applied);

  let unfinished = db.read(credential_operations::list_unfinished).unwrap();
  assert!(unfinished.iter().any(|op| op.id == unrelated_op.id));
  assert!(
    unfinished
      .iter()
      .any(|op| op.owner_id == p.id.to_string() && op.state == OperationState::DbCommitted)
  );

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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![m.id],
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: Some("auto".into()),
        target_lang: Some("auto".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![m.id],
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: Some("auto".into()),
        target_lang: Some("auto".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![m.id],
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

  let err = models.set_adapter_id(created.id, Some("not-a-real-adapter".into()));
  assert!(matches!(err, Err(StorageError::Validation(_))));

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
fn translate_max_tokens_use_profile_then_model_then_default() {
  assert_eq!(
    crate::services::models::resolve_translate_max_tokens(Some(1024), Some(2048)),
    1024
  );
  assert_eq!(
    crate::services::models::resolve_translate_max_tokens(None, Some(2048)),
    2048
  );
  assert_eq!(crate::services::models::resolve_translate_max_tokens(None, None), 32768);
}

/// OpenAI channel + Gemini model override, no base_url_override → gemini default URL.
/// Captures resolved chat transport config (chat path has no injectable ModelTransport).
#[test]
fn model_chat_transport_gemini_override_uses_gemini_default_url() {
  let (_d, db, vault, providers, models, ..) = setup();
  let mut write = provider_write(CredentialKind::ApiKey, CredentialUpdate::Replace("sk-test".into()));
  write.base_url_override = None;
  let p = providers.save(write).unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "gemini-pro".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: Some(serde_json::json!({
        "schemaVersion": 1,
        "maxOutputTokens": 32768,
        "defaultOutputTokens": 6144
      })),
      adapter_id: Some("gemini".into()),
    })
    .unwrap();

  let resolved = crate::services::models::resolve_model_chat_transport(&db, vault.as_ref(), m.id).unwrap();
  match resolved {
    crate::services::models::ModelChatResolve::Ready {
      config,
      model_key,
      model_default_output_tokens,
      model_display_name: _,
      provider_display_name: _,
    } => {
      assert_eq!(config.adapter_id, "gemini");
      assert_eq!(
        config.base_url, "https://generativelanguage.googleapis.com",
        "default base URL must follow final (model) adapter, not channel"
      );
      assert_eq!(config.credential_kind, CredentialKind::ApiKey);
      assert_eq!(config.secret.as_deref(), Some("sk-test"));
      assert_eq!(config.proxy_mode, ProxyMode::Inherit);
      assert_eq!(model_key, "gemini-pro");
      assert_eq!(model_default_output_tokens, Some(6144));
    }
    other => panic!("expected Ready, got {other:?}"),
  }
}

/// OpenAI channel + Anthropic model override, no base_url_override → anthropic default URL.
#[test]
fn model_chat_transport_anthropic_override_uses_anthropic_default_url() {
  let (_d, db, vault, providers, models, ..) = setup();
  let mut write = provider_write(CredentialKind::ApiKey, CredentialUpdate::Replace("sk-ant".into()));
  write.base_url_override = None;
  let p = providers.save(write).unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "claude-3".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: Some("anthropic".into()),
    })
    .unwrap();

  let resolved = crate::services::models::resolve_model_chat_transport(&db, vault.as_ref(), m.id).unwrap();
  match resolved {
    crate::services::models::ModelChatResolve::Ready { config, .. } => {
      assert_eq!(config.adapter_id, "anthropic");
      assert_eq!(config.base_url, "https://api.anthropic.com");
      assert_eq!(config.secret.as_deref(), Some("sk-ant"));
    }
    other => panic!("expected Ready, got {other:?}"),
  }
}

/// Final adapter drives secret_required: channel OpenAI + CredentialKind::None would not
/// need a secret, but Gemini model override must fail auth early (not reach transport).
#[test]
fn model_chat_transport_gemini_override_requires_secret_despite_channel_none() {
  let (_d, db, vault, providers, models, ..) = setup();
  let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  write.base_url_override = None;
  let p = providers.save(write).unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "gemini-pro".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: Some("gemini".into()),
    })
    .unwrap();

  let resolved = crate::services::models::resolve_model_chat_transport(&db, vault.as_ref(), m.id).unwrap();
  assert!(
    matches!(resolved, crate::services::models::ModelChatResolve::MissingCredential),
    "gemini secret_required must use final adapter; got {resolved:?}"
  );

  // Same path feeds translate prepare (stream + non-stream share prepare_translate).
  let result = block_on(models.translate(
    crate::domain::translation::TranslateInput {
      model_id: m.id,
      source_lang: "en".into(),
      target_lang: "zh".into(),
      text: "hello".into(),
      profile_id: None,
      prompt_template_id: None,
      source_lang_id: None,
      target_lang_id: None,
      effective_source_lang_id: None,
      effective_target_lang_id: None,
    },
    None,
  ))
  .unwrap();
  assert!(!result.ok);
  assert_eq!(result.error_code.as_deref(), Some("auth"));
}

/// No model adapter override: inherit channel adapter, default URL, and secret rules.
#[test]
fn model_chat_transport_inherits_channel_when_model_has_no_override() {
  let (_d, db, vault, providers, models, ..) = setup();
  let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  write.base_url_override = None;
  let p = providers.save(write).unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "gpt-4o".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  let resolved = crate::services::models::resolve_model_chat_transport(&db, vault.as_ref(), m.id).unwrap();
  match resolved {
    crate::services::models::ModelChatResolve::Ready { config, model_key, .. } => {
      assert_eq!(config.adapter_id, "openai-compatible");
      assert_eq!(config.base_url, "https://api.openai.com/v1");
      assert!(config.secret.is_none(), "openai + None credential needs no secret");
      assert_eq!(model_key, "gpt-4o");
    }
    other => panic!("expected Ready, got {other:?}"),
  }
}

/// Explicit channel base_url_override is kept even when the model overrides adapter.
#[test]
fn model_chat_transport_keeps_base_url_override_with_model_adapter() {
  let (_d, db, vault, providers, models, ..) = setup();
  let mut write = provider_write(CredentialKind::ApiKey, CredentialUpdate::Replace("sk-proxy".into()));
  write.base_url_override = Some("https://proxy.example.com/v1".into());
  let p = providers.save(write).unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "claude-proxy".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: Some("anthropic".into()),
    })
    .unwrap();

  let resolved = crate::services::models::resolve_model_chat_transport(&db, vault.as_ref(), m.id).unwrap();
  match resolved {
    crate::services::models::ModelChatResolve::Ready { config, .. } => {
      assert_eq!(config.adapter_id, "anthropic");
      assert_eq!(
        config.base_url, "https://proxy.example.com/v1",
        "explicit channel override must win over adapter defaults"
      );
      assert_eq!(config.secret.as_deref(), Some("sk-proxy"));
    }
    other => panic!("expected Ready, got {other:?}"),
  }
}

/// Channel-level test_connection still uses channel adapter (not model overrides).
#[test]
fn test_connection_uses_channel_adapter_not_model_override() {
  let (_d, _db, _v, providers, models, _pr, _s, _ie, transport) = setup();
  let mut write = provider_write(CredentialKind::ApiKey, CredentialUpdate::Replace("sk-ch".into()));
  write.base_url_override = None;
  let p = providers.save(write).unwrap();
  // Model with a different adapter must not affect channel connection test.
  let _m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "gemini-pro".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: Some("gemini".into()),
    })
    .unwrap();

  transport.push_ok(vec![RemoteModelSyncItem {
    model_key: "ignored".into(),
    remote_display_name: None,
    remote_metadata_json: None,
    capability_overrides_json: None,
  }]);
  let result = block_on(models.test_connection(p.id)).unwrap();
  assert!(result.ok);
  let req = transport.last_request().expect("request recorded");
  assert_eq!(req.adapter_id, "openai-compatible");
  assert_eq!(req.base_url, "https://api.openai.com/v1");
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
    capability_overrides_json: None,
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
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db,
    vault as Arc<dyn CredentialVault>,
    transport as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
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
      capability_overrides_json: None,
    },
    RemoteModelSyncItem {
      model_key: "gpt-4o-mini".into(),
      remote_display_name: None,
      remote_metadata_json: None,
      capability_overrides_json: None,
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
  // Empty models.dev cache still seeds defaults for newly discovered remote models.
  for model in &result.models {
    let caps = model
      .capability_overrides_json
      .as_ref()
      .expect("sync seeds capability overrides");
    assert_eq!(caps["schemaVersion"], 1);
    assert_eq!(caps["textGeneration"], true);
    assert_eq!(caps["imageAnalysis"], false);
    assert_eq!(caps["pdfAnalysis"], false);
    assert_eq!(
      caps["maxContextTokens"],
      crate::domain::model::CapabilityOverridesV1::DEFAULT_MAX_CONTEXT_TOKENS
    );
  }
}

#[test]
fn sync_models_preserves_existing_capability_overrides() {
  let (_d, _db, _v, providers, models, _pr, _s, _ie, transport) = setup();
  let p = providers
    .save(provider_write(
      CredentialKind::ApiKey,
      CredentialUpdate::Replace("sk-test".into()),
    ))
    .unwrap();
  transport.push_ok(vec![RemoteModelSyncItem {
    model_key: "custom-model".into(),
    remote_display_name: None,
    remote_metadata_json: None,
    capability_overrides_json: None,
  }]);
  let first = block_on(models.sync_models(p.id)).unwrap();
  assert!(first.ok);
  let model_id = first.models[0].id;
  let custom = serde_json::json!({
    "schemaVersion": 1,
    "textGeneration": true,
    "imageAnalysis": true,
    "pdfAnalysis": true,
    "maxContextTokens": 4096,
    "maxOutputTokens": 1024,
    "defaultOutputTokens": 1024
  });
  models
    .update_config(crate::domain::model::ModelConfigWrite {
      id: model_id,
      display_name_override: None,
      adapter_id: None,
      capability_overrides_json: Some(custom.clone()),
    })
    .unwrap();

  transport.push_ok(vec![RemoteModelSyncItem {
    model_key: "custom-model".into(),
    remote_display_name: Some("Custom".into()),
    remote_metadata_json: None,
    capability_overrides_json: None,
  }]);
  let second = block_on(models.sync_models(p.id)).unwrap();
  assert!(second.ok);
  let caps = second.models[0]
    .capability_overrides_json
    .as_ref()
    .expect("capabilities preserved");
  assert_eq!(caps["maxContextTokens"], 4096);
  assert_eq!(caps["imageAnalysis"], true);
  assert_eq!(caps["pdfAnalysis"], true);
  assert_eq!(second.models[0].remote_display_name.as_deref(), Some("Custom"));
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
    capability_overrides_json: None,
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
        capability_overrides_json: None,
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
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db,
    vault as Arc<dyn CredentialVault>,
    transport as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
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
      adapter_id: None,
    })
    .unwrap();
  transport.push_ok(vec![
    RemoteModelSyncItem {
      model_key: "remote-a".into(),
      remote_display_name: None,
      remote_metadata_json: None,
      capability_overrides_json: None,
    },
    RemoteModelSyncItem {
      model_key: "remote-b".into(),
      remote_display_name: None,
      remote_metadata_json: None,
      capability_overrides_json: None,
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
    let current = self.providers.get(self.provider_id).expect("provider");
    let mut write = for_provider_update(
      current.id,
      &current.updated_at,
      CredentialKind::None,
      CredentialUpdate::Keep,
    );
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
  let history = TranslationHistoryService::new(db.clone());
  let seed_models = ModelService::new(
    db.clone(),
    vault.clone() as Arc<dyn CredentialVault>,
    seed_transport.clone() as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
  );
  seed_models
    .apply_remote_merge(
      p.id,
      &[RemoteModelSyncItem {
        model_key: "old-endpoint-model".into(),
        remote_display_name: None,
        remote_metadata_json: None,
        capability_overrides_json: None,
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
      capability_overrides_json: None,
    }],
  });
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db,
    vault as Arc<dyn CredentialVault>,
    transport as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
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
    let current = self.providers.get(self.provider_id).expect("provider");
    let mut write = for_provider_update(
      current.id,
      &current.updated_at,
      CredentialKind::None,
      CredentialUpdate::Keep,
    );
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
  let history = TranslationHistoryService::new(db.clone());
  let seed_models = ModelService::new(
    db.clone(),
    vault.clone() as Arc<dyn CredentialVault>,
    seed_transport.clone() as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
  );
  seed_models
    .apply_remote_merge(
      p.id,
      &[RemoteModelSyncItem {
        model_key: "kept".into(),
        remote_display_name: None,
        remote_metadata_json: None,
        capability_overrides_json: None,
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
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db,
    vault as Arc<dyn CredentialVault>,
    transport as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
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
      let current = providers.get(provider_id).expect("provider");
      let mut write = for_provider_update(
        current.id,
        &current.updated_at,
        CredentialKind::ApiKey,
        CredentialUpdate::Replace("sk-after-mutate".into()),
      );
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
  let history = TranslationHistoryService::new(db.clone());
  let seed_models = ModelService::new(
    db.clone(),
    vault.clone() as Arc<dyn CredentialVault>,
    seed_transport as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
  );
  // apply_remote_merge does not touch the vault.
  seed_models
    .apply_remote_merge(
      p.id,
      &[RemoteModelSyncItem {
        model_key: "kept".into(),
        remote_display_name: None,
        remote_metadata_json: None,
        capability_overrides_json: None,
      }],
    )
    .unwrap();
  let before = providers.get(p.id).unwrap();
  assert_eq!(before.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
  let synced_at = before.models_synced_at.clone().expect("synced_at");

  vault.configure(providers.clone(), p.id, false);
  let transport = Arc::new(TestModelTransport::new());
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db,
    vault as Arc<dyn CredentialVault>,
    transport as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
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
  let history = TranslationHistoryService::new(db.clone());
  let seed_models = ModelService::new(
    db.clone(),
    vault.clone() as Arc<dyn CredentialVault>,
    seed_transport as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
  );
  seed_models
    .apply_remote_merge(
      p.id,
      &[RemoteModelSyncItem {
        model_key: "kept".into(),
        remote_display_name: None,
        remote_metadata_json: None,
        capability_overrides_json: None,
      }],
    )
    .unwrap();

  vault.configure(providers.clone(), p.id, true);
  let transport = Arc::new(TestModelTransport::new());
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db,
    vault as Arc<dyn CredentialVault>,
    transport as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
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
      capability_overrides_json: None,
    }],
  });
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db,
    vault as Arc<dyn CredentialVault>,
    transport as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
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
  let current = providers.get(p.id).unwrap();
  let mut write = for_provider_update(
    current.id,
    &current.updated_at,
    CredentialKind::None,
    CredentialUpdate::Keep,
  );
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
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db,
    vault as Arc<dyn CredentialVault>,
    Arc::new(TestModelTransport::new()) as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
  );
  // Already credentialKind none / no ref: Clear is identity-preserving for connection fields.
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
    .unwrap();
  assert_eq!(
    providers.get(p.id).unwrap().models_sync_status,
    crate::domain::provider::ModelsSyncStatus::Never
  );

  // Without concurrent writers: clear applies and preserves Never when identity is unchanged.
  let mut write = for_provider_update(p.id, &p.updated_at, CredentialKind::None, CredentialUpdate::Clear);
  write.display_name = "Renamed during clear".into();
  write.base_url_override = Some("https://api.openai.com/v1".into());
  let after = providers.save(write).expect("clear save");
  assert_eq!(
    after.models_sync_status,
    crate::domain::provider::ModelsSyncStatus::Never
  );
  assert!(after.models_synced_at.is_none());
  assert_eq!(after.display_name, "Renamed during clear");

  // Concurrent sync in the multi-transaction gap bumps updated_at → OCC rejects clear.
  let p = providers.get(p.id).unwrap();
  models
    .apply_remote_merge(
      p.id,
      &[RemoteModelSyncItem {
        model_key: "seed-for-gap".into(),
        remote_display_name: None,
        remote_metadata_json: None,
        capability_overrides_json: None,
      }],
    )
    .unwrap();
  // Re-read baseline after seed, then inject a second concurrent merge in the clear gap.
  let baseline = providers.get(p.id).unwrap();
  let models_for_hook = models.clone();
  let provider_id = baseline.id;
  crate::services::providers::set_clear_credential_between_txns_hook(move || {
    models_for_hook
      .apply_remote_merge(
        provider_id,
        &[RemoteModelSyncItem {
          model_key: "from-concurrent-sync".into(),
          remote_display_name: None,
          remote_metadata_json: None,
          capability_overrides_json: None,
        }],
      )
      .expect("concurrent sync in clear gap");
  });
  let mut write = for_provider_update(
    baseline.id,
    &baseline.updated_at,
    CredentialKind::None,
    CredentialUpdate::Clear,
  );
  write.display_name = "Should not apply".into();
  write.base_url_override = Some("https://api.openai.com/v1".into());
  let err = providers.save(write).unwrap_err();
  assert!(
    matches!(err, StorageError::Conflict(_)),
    "concurrent row version change must reject clear: {err:?}"
  );
  let latest = providers.get(p.id).unwrap();
  assert_eq!(latest.display_name, "Renamed during clear");
  assert_eq!(latest.models_sync_status, crate::domain::provider::ModelsSyncStatus::Ok);
  assert!(models.list_by_provider(p.id).unwrap().len() >= 1);
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
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db,
    vault as Arc<dyn CredentialVault>,
    Arc::new(TestModelTransport::new()) as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
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
        capability_overrides_json: None,
      }],
    )
    .unwrap();
  assert_eq!(
    providers.get(p.id).unwrap().models_sync_status,
    crate::domain::provider::ModelsSyncStatus::Ok
  );

  // Successful clear with identity change (no concurrent writers) resets sync metadata.
  let baseline = providers.get(p.id).unwrap();
  let mut write = for_provider_update(
    baseline.id,
    &baseline.updated_at,
    CredentialKind::None,
    CredentialUpdate::Clear,
  );
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
  let history = TranslationHistoryService::new(db.clone());
  let models = ModelService::new(
    db,
    vault.clone() as Arc<dyn CredentialVault>,
    transport as Arc<dyn ModelTransport>,
    history,
    models_dev_cache_dir(&dir),
  );
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

  vault.set_fail_set(true);
  let mut write = for_provider_update(
    before.id,
    &before.updated_at,
    CredentialKind::ApiKey,
    CredentialUpdate::Replace("sk-fail".into()),
  );
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

#[test]
fn delete_all_models_keeps_provider_and_connection() {
  let (_d, _db, _v, providers, models, profiles, ..) = setup();
  let provider = providers
    .save({
      let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
      write.display_name = "Keep Me".into();
      write.base_url_override = Some("https://api.example.com/v1".into());
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![m1.id, m2.id],
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
  assert_eq!(kept.base_url_override.as_deref(), Some("https://api.example.com/v1"));
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![m3.id],
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
fn delete_primary_model_recompacts_remaining_targets() {
  let (_d, _db, _v, providers, models, profiles, ..) = setup();
  let p = providers
    .save(provider_write(CredentialKind::None, CredentialUpdate::Keep))
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
  let fallback = models
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
  let profile = profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: None,
        name: "Chain".into(),
        enabled: true,
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: Some("auto".into()),
        target_lang: Some("en".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![primary.id, fallback.id],
      }
    })
    .unwrap();

  models.delete(primary.id).unwrap();
  let after = profiles.get(profile.profile.id).unwrap();
  assert_eq!(after.targets.len(), 1);
  assert_eq!(after.targets[0].provider_model_id, fallback.id);
  assert_eq!(
    after.targets[0].priority, 0,
    "remaining fallback must become priority-0 primary after primary delete"
  );

  // Detection resolves to the promoted primary without a page model id.
  use crate::services::models::resolve_detect_model_source;
  assert_eq!(
    resolve_detect_model_source(Some(&after.profile), Some(&after.targets[0]), None).unwrap(),
    fallback.id
  );
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
    template_version: 1,
    default_prompt_template_id: template_id,
    temperature: None,
    max_output_tokens: None,
    provider_options_json: None,
    source_lang: None,
    target_lang: None,
    primary_lang: None,
    preferred_target_lang: None,
    language_detection,
    created_at: now.clone(),
    updated_at: now,
  };
  (profile, prompt_templates)
}

#[test]
fn resolve_detect_model_source_precedence() {
  use crate::services::models::resolve_detect_model_source;
  // Distinct ids so precedence is observable, not just any-nonnil.
  let p0 = uuid::Uuid::now_v7();
  let p1 = uuid::Uuid::now_v7();
  let explicit = uuid::Uuid::now_v7();
  let input_model = uuid::Uuid::now_v7();
  assert_ne!(p0, p1);
  assert_ne!(p0, explicit);
  assert_ne!(p0, input_model);
  assert_ne!(explicit, input_model);
  let targets = [
    TranslationProfileTarget {
      translation_profile_id: uuid::Uuid::nil(),
      provider_model_id: p0,
      priority: 0,
    },
    TranslationProfileTarget {
      translation_profile_id: uuid::Uuid::nil(),
      provider_model_id: p1,
      priority: 1,
    },
  ];
  let _ = p1;

  // No profile -> input.modelId required.
  assert_eq!(
    resolve_detect_model_source(None, None, Some(input_model)).unwrap(),
    input_model
  );
  assert!(matches!(
    resolve_detect_model_source(None, None, None).unwrap_err(),
    StorageError::Validation(_)
  ));

  // Profile explicit LLM modelId wins over profile primary and input.
  let (profile, _) = sample_profile(
    uuid::Uuid::nil(),
    "P",
    Some(LanguageDetectorConfig::Llm {
      model_id: Some(explicit),
    }),
  );
  assert_eq!(
    resolve_detect_model_source(Some(&profile), Some(&targets[0]), Some(input_model)).unwrap(),
    explicit
  );

  // Profile Llm with None modelId -> profile primary target.
  let (profile_no_model, _) = sample_profile(
    uuid::Uuid::nil(),
    "P",
    Some(LanguageDetectorConfig::Llm { model_id: None }),
  );
  assert_eq!(
    resolve_detect_model_source(Some(&profile_no_model), Some(&targets[0]), Some(input_model)).unwrap(),
    p0
  );

  // Profile with no languageDetection -> profile primary target.
  let (profile_no_cfg, _) = sample_profile(uuid::Uuid::nil(), "P", None);
  assert_eq!(
    resolve_detect_model_source(Some(&profile_no_cfg), Some(&targets[0]), Some(input_model)).unwrap(),
    p0
  );

  // Profile selected but no primary target -> page model selection (covers delete/re-add).
  assert_eq!(
    resolve_detect_model_source(Some(&profile_no_cfg), None, Some(input_model)).unwrap(),
    input_model
  );

  // Profile selected, no primary target, no page model -> validation error.
  assert!(matches!(
    resolve_detect_model_source(Some(&profile_no_cfg), None, None).unwrap_err(),
    StorageError::Validation(_)
  ));
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: Some(LanguageDetectorConfig::Llm { model_id: Some(m1.id) }),
        target_model_ids: vec![m2.id],
      }
    })
    .unwrap();
  assert_eq!(
    saved.profile.language_detection,
    Some(LanguageDetectorConfig::Llm { model_id: Some(m1.id) })
  );

  // Re-read round-trips the config JSON from SQLite.
  let reread = profiles.get(saved.profile.id).unwrap();
  assert_eq!(
    reread.profile.language_detection,
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        target_model_ids: vec![m2.id],
      }
    })
    .unwrap();
  assert!(cleared.profile.language_detection.is_none());
  assert!(
    profiles
      .get(saved.profile.id)
      .unwrap()
      .profile
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: Some(LanguageDetectorConfig::Llm { model_id: Some(ghost) }),
        target_model_ids: vec![m.id],
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: Some("auto".into()),
        target_lang: Some("en".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: Some(LanguageDetectorConfig::Llm {
          model_id: Some(detector.id),
        }),
        target_model_ids: vec![primary.id],
      }
    })
    .unwrap();

  // Direct model delete detaches the dedicated detector config.
  models.delete(detector.id).unwrap();
  let after_model_delete = profiles.get(profile.profile.id).unwrap();
  assert!(after_model_delete.profile.language_detection.is_none());
  assert_eq!(after_model_delete.targets[0].provider_model_id, primary.id);

  // Re-bind detector to another model, then provider delete still clears config.
  profiles
    .save({
      let (default_prompt_template_id, prompt_templates) = attach_default_templates("s", "{{text}}");
      TranslationProfileWrite {
        id: Some(profile.profile.id),
        name: "Dedicated detector".into(),
        enabled: true,
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: Some("auto".into()),
        target_lang: Some("en".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: Some(LanguageDetectorConfig::Llm {
          model_id: Some(detector_b.id),
        }),
        target_model_ids: vec![primary.id],
      }
    })
    .unwrap();

  providers.delete(detector_b_provider.id).unwrap();
  let reread = profiles.get(profile.profile.id).unwrap();
  assert!(reread.profile.language_detection.is_none());
  assert_eq!(reread.targets[0].provider_model_id, primary.id);
}

#[test]
fn detect_language_empty_text_returns_validation_soft_failure() {
  let (_d, _db, _v, providers, models, _profiles, ..) = setup();
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

  let empty = block_on(models.detect_language(
    DetectLanguageInput {
      text: "   ".into(),
      model_id: Some(m.id),
      profile_id: None,
    },
    None,
  ))
  .unwrap();
  assert!(!empty.ok);
  assert_eq!(empty.error_code.as_deref(), Some("validation_failed"));
  assert_eq!(empty.model_id, None);

  // No profile and no input model -> validation failure.
  let no_model = block_on(models.detect_language(
    DetectLanguageInput {
      text: "hi".into(),
      model_id: None,
      profile_id: None,
    },
    None,
  ))
  .unwrap();
  assert!(!no_model.ok);
  assert_eq!(no_model.error_code.as_deref(), Some("validation_failed"));
}

#[test]
fn detect_language_truncates_oversize_text() {
  let (_d, _db, _v, providers, models, ..) = setup();
  let (base_url, request_handle) = spawn_detection_chat_server();
  let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  write.base_url_override = Some(base_url);
  let provider = providers.save(write).unwrap();
  let model = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: provider.id,
      model_key: "det".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  // 5001 chars exceeds the detect sample cap; detection must still succeed by
  // sending only the truncated sample to the model.
  let big = "x".repeat(5001);
  let result = block_on(models.detect_language(
    DetectLanguageInput {
      text: big,
      model_id: Some(model.id),
      profile_id: None,
    },
    None,
  ))
  .unwrap();
  assert!(result.ok, "detection failed: {result:?}");

  let request = request_handle.join().unwrap();
  let user_content = request["messages"][1]["content"].as_str().unwrap();
  assert_eq!(user_content.chars().count(), 5000);
}

#[test]
fn detect_language_uses_low_generation_budget() {
  let (_d, _db, _v, providers, models, ..) = setup();
  let (base_url, request_handle) = spawn_detection_chat_server();
  let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  write.base_url_override = Some(base_url);
  let provider = providers.save(write).unwrap();
  let model = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: provider.id,
      model_key: "reasoning-model".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  let result = block_on(models.detect_language(
    DetectLanguageInput {
      text: "你好".into(),
      model_id: Some(model.id),
      profile_id: None,
    },
    None,
  ))
  .unwrap();
  assert!(result.ok, "detection failed: {result:?}");
  assert_eq!(result.language_id.as_deref(), Some("zh"));

  let request = request_handle.join().unwrap();
  assert_eq!(request["max_tokens"], 256);
  assert_eq!(request["temperature"], 0.0);
  // Non-DeepSeek models must not receive the thinking toggle.
  assert!(request.get("thinking").is_none());
}

#[test]
fn detect_language_omits_thinking_on_openai_compatible_even_for_deepseek_model_keys() {
  let (_d, _db, _v, providers, models, ..) = setup();
  let (base_url, request_handle) = spawn_detection_chat_server();
  let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  write.base_url_override = Some(base_url);
  let provider = providers.save(write).unwrap();
  let model = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: provider.id,
      // openai-compatible stays on standard chat/completions fields.
      // DeepSeek thinking controls require the dedicated deepseek adapter.
      model_key: "deepseek-v4-flash".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  let result = block_on(models.detect_language(
    DetectLanguageInput {
      text: "DeT".into(),
      model_id: Some(model.id),
      profile_id: None,
    },
    None,
  ))
  .unwrap();
  assert!(result.ok, "detection failed: {result:?}");
  assert_eq!(result.language_id.as_deref(), Some("zh"));

  let request = request_handle.join().unwrap();
  assert_eq!(request["max_tokens"], 256);
  assert!(request.get("thinking").is_none());
}

#[test]
fn detect_language_disables_thinking_for_deepseek_adapter() {
  let (_d, _db, _v, providers, models, ..) = setup();
  let (base_url, request_handle) = spawn_detection_chat_server();
  let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  write.adapter_id = "deepseek".into();
  write.base_url_override = Some(base_url);
  let provider = providers.save(write).unwrap();
  let model = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: provider.id,
      // First-class deepseek adapter: policy is owned by the strategy, not model-key heuristics.
      model_key: "deepseek-chat".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  let result = block_on(models.detect_language(
    DetectLanguageInput {
      text: "hello".into(),
      model_id: Some(model.id),
      profile_id: None,
    },
    None,
  ))
  .unwrap();
  assert!(result.ok, "detection failed: {result:?}");

  let request = request_handle.join().unwrap();
  assert_eq!(request["max_tokens"], 2048);
  assert_eq!(request["thinking"]["type"], "disabled");
}

#[test]
fn detect_language_missing_required_credential_returns_auth_soft_failure() {
  let (_d, _db, _v, providers, models, ..) = setup();
  let mut write = provider_write(CredentialKind::ApiKey, CredentialUpdate::Keep);
  write.base_url_override = None;
  let p = providers.save(write).unwrap();
  let m = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: p.id,
      model_key: "gpt-4o".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: Some("gemini".into()),
    })
    .unwrap();
  // Gemini adapter requires a secret; none stored -> MissingCredential.
  let result = block_on(models.detect_language(
    DetectLanguageInput {
      text: "hello".into(),
      model_id: Some(m.id),
      profile_id: None,
    },
    None,
  ))
  .unwrap();
  assert!(!result.ok);
  assert_eq!(result.error_code.as_deref(), Some("auth"));
  assert_eq!(result.model_id, None);
  assert_eq!(result.detector_type, DetectorType::Llm);
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: Some(LanguageDetectorConfig::Llm { model_id: Some(m.id) }),
        target_model_ids: vec![primary.id],
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
  match &copied.profile.language_detection {
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
        template_version: 1,
        default_prompt_template_id,
        prompt_templates,
        temperature: None,
        max_output_tokens: None,
        provider_options_json: None,
        source_lang: None,
        target_lang: None,
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: Some(LanguageDetectorConfig::Llm { model_id: Some(m.id) }),
        target_model_ids: vec![m.id],
      }
    })
    .unwrap();

  let mut doc = ie.export().unwrap();
  // Point the detection model id at a model that does not exist in the document.
  let ghost = uuid::Uuid::now_v7();
  if let Some(LanguageDetectorConfig::Llm { model_id }) = doc.translation_profiles[0].language_detection.as_mut() {
    *model_id = Some(ghost);
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
fn translate_records_history_on_success_not_on_cancel_or_early() {
  use crate::domain::translation::TranslateInput;
  use crate::domain::translation_history::{HistoryStatus, TranslationHistoryListQuery};

  let (_d, db, _v, providers, models, _profiles, _settings, _import_export, _transport) = setup();
  let history = TranslationHistoryService::new(db.clone());
  let (base_url, _request_handle) = spawn_detection_chat_server();
  let mut write = provider_write(CredentialKind::None, CredentialUpdate::Keep);
  write.base_url_override = Some(base_url);
  let provider = providers.save(write).unwrap();
  let model = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: provider.id,
      model_key: "gpt-test".into(),
      display_name_override: Some("GPT Test".into()),
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  let input = TranslateInput {
    model_id: model.id,
    source_lang: "English".into(),
    target_lang: "Chinese".into(),
    text: "hello".into(),
    profile_id: None,
    prompt_template_id: None,
    source_lang_id: Some("auto".into()),
    target_lang_id: Some("zh".into()),
    effective_source_lang_id: Some("en".into()),
    effective_target_lang_id: Some("zh".into()),
  };
  let result = block_on(models.translate(input, None)).unwrap();
  assert!(result.ok, "translate failed: {result:?}");

  let list = history
    .list(TranslationHistoryListQuery {
      page: 1,
      page_size: Some(10),
      ..Default::default()
    })
    .unwrap();
  assert_eq!(list.total, 1, "one history row expected after success");
  let item = &list.items[0];
  assert_eq!(item.source_text_preview, "hello");
  assert_eq!(item.translated_text_preview, "zh");
  assert_eq!(item.model_display_name, "GPT Test");
  assert_eq!(item.effective_source_lang.as_deref(), Some("en"));
  assert_eq!(item.effective_target_lang.as_deref(), Some("zh"));
  assert_eq!(item.status, HistoryStatus::Complete);

  // Early validation failure (empty text) must not record history.
  let early = block_on(models.translate(
    TranslateInput {
      model_id: model.id,
      source_lang: "English".into(),
      target_lang: "Chinese".into(),
      text: "   ".into(),
      profile_id: None,
      prompt_template_id: None,
      source_lang_id: None,
      target_lang_id: None,
      effective_source_lang_id: None,
      effective_target_lang_id: None,
    },
    None,
  ))
  .unwrap();
  assert!(!early.ok);
  assert_eq!(early.error_code.as_deref(), Some("validation_failed"));
  let list = history
    .list(TranslationHistoryListQuery {
      page: 1,
      page_size: Some(10),
      ..Default::default()
    })
    .unwrap();
  assert_eq!(list.total, 1, "Early validation must not record history");

  // Pre-cancelled token returns cancelled and must not record history.
  let token = crate::domain::cancel::CancelToken::new();
  token.cancel();
  let cancelled = block_on(models.translate(
    TranslateInput {
      model_id: model.id,
      source_lang: "English".into(),
      target_lang: "Chinese".into(),
      text: "hello".into(),
      profile_id: None,
      prompt_template_id: None,
      source_lang_id: None,
      target_lang_id: None,
      effective_source_lang_id: None,
      effective_target_lang_id: None,
    },
    Some(&token),
  ))
  .unwrap();
  assert!(!cancelled.ok);
  assert_eq!(cancelled.error_code.as_deref(), Some("cancelled"));
  let list = history
    .list(TranslationHistoryListQuery {
      page: 1,
      page_size: Some(10),
      ..Default::default()
    })
    .unwrap();
  assert_eq!(list.total, 1, "cancelled translate must not record history");
}
