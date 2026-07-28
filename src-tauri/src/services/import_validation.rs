// ABOUTME: Normalizes and validates complete configuration import graphs.
// ABOUTME: Preview and apply share one plan; apply revalidates inside the write transaction.
use crate::domain::import_export::{
  ConfigurationExport, EXPORT_FORMAT_VERSION, ImportConflictMode, ImportPreview, ImportPreviewCounts,
  IntegrationInstanceExport, OcrPromptTemplateExport, OcrServiceExport, SpeechServiceExport,
};
use crate::domain::language_detection::LanguageDetectorConfig;
use crate::domain::model::{CapabilityOverridesV1, ProviderModel};
use crate::domain::ocr_service::{
  GOOGLE_VISION_PREFERENCES_SCHEMA_VERSION, OcrProviderType, OcrService, parse_ocr_image_preferences,
};
use crate::domain::provider::{
  CredentialKind, ModelsSyncStatus, ProviderExport, ProviderInstance, validate_adapter_id,
};
use crate::domain::service_capability::{validate_ocr_image_preferences, validate_speech_synthesize_preferences};
use crate::domain::service_integration::{IntegrationHealthStatus, IntegrationInstance};
use crate::domain::settings::{AppSettingsV1, GlobalProxyMode};
use crate::domain::speech_service::{
  GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION, SPEECH_DISPLAY_NAME_MAX_LEN, SpeechService,
  parse_speech_synthesize_preferences,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{
  PromptTemplate, TranslationProfile, TranslationProfileEngine, TranslationProfilePromptTemplate,
  TranslationProfileTarget,
};
use crate::error::StorageError;
use crate::repositories::{
  integration_instances, ocr_services, provider_instances, provider_models, speech_services, translation_profiles,
};
use crate::services::providers::validate_provider_url;
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::settings::{
  validate_default_ocr_service, validate_default_profile, validate_default_speech_service, validate_settings_document,
};
use crate::services::translation_profiles::{validate_profile_language_preferences, validate_prompt_templates};
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use uuid::Uuid;

/// Normalized, self-contained import plan ready for transactional apply.
#[derive(Debug, Clone)]
pub struct ValidatedImportPlan {
  pub mode: ImportConflictMode,
  pub preview: ImportPreview,
  pub providers: Vec<ProviderInstance>,
  pub models: Vec<ProviderModel>,
  pub profiles: Vec<TranslationProfile>,
  pub targets: Vec<TranslationProfileTarget>,
  pub prompt_templates: Vec<TranslationProfilePromptTemplate>,
  pub integrations: Vec<IntegrationInstance>,
  pub ocr_services: Vec<OcrService>,
  pub ocr_prompt_templates: Vec<OcrPromptTemplateExport>,
  pub speech_services: Vec<SpeechService>,
  pub settings: AppSettingsV1,
  /// Providers that need credential cleanup when merging over existing rows.
  pub provider_cleanup_ids: Vec<Uuid>,
  /// Whether imported settings require clearing the global proxy binding.
  pub clear_global_proxy: bool,
  /// Expected local credential refs for merge ownership CAS (provider_id -> ref).
  pub expected_provider_refs: HashMap<Uuid, Option<String>>,
  /// Expected local Baidu OCR api key refs for merge CAS (service_id -> ref).
  pub expected_ocr_api_key_refs: HashMap<Uuid, Option<String>>,
  /// Expected local Baidu OCR secret key refs for merge CAS (service_id -> ref).
  pub expected_ocr_secret_key_refs: HashMap<Uuid, Option<String>>,
  pub expected_proxy_ref: Option<String>,
}

/// Build a validated plan using local rows visible on `conn`.
pub fn build_validated_plan(
  conn: &Connection,
  document: &ConfigurationExport,
  mode: ImportConflictMode,
) -> Result<ValidatedImportPlan, StorageError> {
  let mut errors = Vec::new();

  // Documents reaching this path are already normalized to the current format version.
  if document.format_version != EXPORT_FORMAT_VERSION {
    errors.push(format!("unsupported formatVersion {}", document.format_version));
  }

  // Reject duplicate identities before maps silently overwrite.
  reject_duplicate_ids(document.providers.iter().map(|p| p.id), "provider", &mut errors);
  reject_duplicate_ids(document.models.iter().map(|m| m.id), "model", &mut errors);
  reject_duplicate_ids(
    document.translation_profiles.iter().map(|p| p.id),
    "profile",
    &mut errors,
  );
  reject_duplicate_ids(
    document.integration_instances.iter().map(|i| i.id),
    "integration",
    &mut errors,
  );
  reject_duplicate_ids(document.ocr_services.iter().map(|s| s.id), "ocr service", &mut errors);
  reject_duplicate_ids(
    document.ocr_prompt_templates.iter().map(|t| t.id),
    "ocr prompt template",
    &mut errors,
  );
  reject_duplicate_ids(
    document.speech_services.iter().map(|s| s.id),
    "speech service",
    &mut errors,
  );

  let mut target_keys = HashSet::new();
  for t in &document.profile_models {
    let key = (t.translation_profile_id, t.provider_model_id);
    if !target_keys.insert(key) {
      errors.push(format!(
        "duplicate profile target {} -> {}",
        t.translation_profile_id, t.provider_model_id
      ));
    }
  }

  let mut template_ids = HashSet::new();
  for t in &document.profile_prompt_templates {
    if !template_ids.insert(t.id) {
      errors.push(format!("duplicate prompt template id {}", t.id));
    }
  }

  let local_providers: HashMap<Uuid, ProviderInstance> =
    provider_instances::list(conn)?.into_iter().map(|p| (p.id, p)).collect();
  let local_models: HashMap<Uuid, ProviderModel> = provider_models::list_all(conn)?
    .into_iter()
    .map(|m| (m.id, m))
    .collect();
  let local_profiles: HashMap<Uuid, _> = translation_profiles::list(conn)?
    .into_iter()
    .map(|p| (p.id, p))
    .collect();
  let local_integrations: HashMap<Uuid, _> = integration_instances::list(conn)?
    .into_iter()
    .map(|i| (i.id, i))
    .collect();
  let local_ocr_services: HashMap<Uuid, OcrService> =
    ocr_services::list(conn)?.into_iter().map(|s| (s.id, s)).collect();
  let local_speech_services: HashMap<Uuid, SpeechService> =
    speech_services::list(conn)?.into_iter().map(|s| (s.id, s)).collect();
  let local_proxy_ref = crate::repositories::app_credentials::get_global_proxy_ref(conn)?;

  let doc_provider_ids: HashSet<Uuid> = document.providers.iter().map(|p| p.id).collect();
  let doc_model_ids: HashSet<Uuid> = document.models.iter().map(|m| m.id).collect();
  let doc_profile_ids: HashSet<Uuid> = document.translation_profiles.iter().map(|p| p.id).collect();
  let doc_integration_ids: HashSet<Uuid> = document.integration_instances.iter().map(|i| i.id).collect();
  let doc_ocr_service_ids: HashSet<Uuid> = document.ocr_services.iter().map(|s| s.id).collect();
  let doc_speech_service_ids: HashSet<Uuid> = document.speech_services.iter().map(|s| s.id).collect();

  // Providers
  for p in &document.providers {
    if let Err(e) = validate_import_provider(p) {
      errors.push(format!("provider {}: {e}", p.id));
    }
  }

  // Models
  for m in &document.models {
    if let Err(e) = validate_import_model(m, &doc_provider_ids) {
      errors.push(format!("model {}: {e}", m.id));
    }
    if mode == ImportConflictMode::Merge {
      if let Some(local) = local_models.get(&m.id) {
        if local.provider_instance_id != m.provider_instance_id {
          errors.push(format!("model {} already belongs to a different provider", m.id));
        }
      }
    }
  }

  // Integrations: plugin-aware config validation/normalization before plan materialization.
  let mut normalized_integration_configs: HashMap<Uuid, String> = HashMap::new();
  for i in &document.integration_instances {
    if i.display_name.trim().is_empty() {
      errors.push(format!("integration {}: display_name must not be empty", i.id));
    }
    match normalize_imported_integration_config(&i.plugin_id, &i.config_json) {
      Ok(config_json) => {
        normalized_integration_configs.insert(i.id, config_json);
      }
      Err(StorageError::Validation(msg)) => {
        errors.push(format!("integration {}: {msg}", i.id));
      }
      Err(e) => {
        errors.push(format!("integration {}: {e}", i.id));
      }
    }
  }

  // Profiles, targets, and prompt templates
  let mut targets_by_profile: HashMap<Uuid, Vec<&TranslationProfileTarget>> = HashMap::new();
  for t in &document.profile_models {
    if !doc_profile_ids.contains(&t.translation_profile_id) {
      errors.push(format!(
        "profile target references missing profile {}",
        t.translation_profile_id
      ));
    }
    if !doc_model_ids.contains(&t.provider_model_id) {
      errors.push(format!(
        "profile target references missing model {}",
        t.provider_model_id
      ));
    }
    targets_by_profile.entry(t.translation_profile_id).or_default().push(t);
  }

  let mut templates_by_profile: HashMap<Uuid, Vec<&TranslationProfilePromptTemplate>> = HashMap::new();
  for t in &document.profile_prompt_templates {
    if !doc_profile_ids.contains(&t.translation_profile_id) {
      errors.push(format!(
        "prompt template references missing profile {}",
        t.translation_profile_id
      ));
    }
    templates_by_profile
      .entry(t.translation_profile_id)
      .or_default()
      .push(t);
  }

  for profile in &document.translation_profiles {
    if let Err(e) = validate_import_profile(
      profile,
      targets_by_profile.get(&profile.id).map(|v| v.as_slice()).unwrap_or(&[]),
      templates_by_profile
        .get(&profile.id)
        .map(|v| v.as_slice())
        .unwrap_or(&[]),
      &doc_model_ids,
    ) {
      errors.push(format!("profile {}: {e}", profile.id));
    }
  }

  // OCR services + templates
  let mut ocr_templates_by_service: HashMap<Uuid, Vec<&OcrPromptTemplateExport>> = HashMap::new();
  for template in &document.ocr_prompt_templates {
    if !doc_ocr_service_ids.contains(&template.ocr_service_id) {
      errors.push(format!(
        "ocr prompt template references missing service {}",
        template.ocr_service_id
      ));
    }
    ocr_templates_by_service
      .entry(template.ocr_service_id)
      .or_default()
      .push(template);
  }
  for service in &document.ocr_services {
    if let Err(e) = validate_import_ocr_service(
      service,
      ocr_templates_by_service
        .get(&service.id)
        .map(|v| v.as_slice())
        .unwrap_or(&[]),
      &doc_model_ids,
      &doc_integration_ids,
      mode,
      &local_integrations,
    ) {
      errors.push(format!("ocr service {}: {e}", service.id));
    }
    if mode == ImportConflictMode::Merge {
      if let Some(local) = local_ocr_services.get(&service.id) {
        if local.provider_type != service.provider_type {
          errors.push(format!(
            "ocr service {} provider_type is immutable (local {:?}, import {:?})",
            service.id, local.provider_type, service.provider_type
          ));
        }
      }
    }
  }

  // Speech services (capability-backed; secrets never present).
  for service in &document.speech_services {
    if let Err(e) = validate_import_speech_service(service, &doc_integration_ids, mode, &local_integrations) {
      errors.push(format!("speech service {}: {e}", service.id));
    }
  }

  // Settings (pure document rules)
  if let Err(e) = validate_settings_document(&document.app_settings) {
    errors.push(format!("appSettings: {e}"));
  }

  // Resolve default profile for self-contained document.
  let mut settings = document.app_settings.clone();
  let mut default_profile_cleared = false;
  let mut provider_id_map: HashMap<Uuid, Uuid> = HashMap::new();
  let mut model_id_map: HashMap<Uuid, Uuid> = HashMap::new();
  let mut profile_id_map: HashMap<Uuid, Uuid> = HashMap::new();
  let mut integration_id_map: HashMap<Uuid, Uuid> = HashMap::new();
  let mut ocr_service_id_map: HashMap<Uuid, Uuid> = HashMap::new();
  let mut speech_service_id_map: HashMap<Uuid, Uuid> = HashMap::new();

  // Counts and ID rewriting for copy mode.
  let mut counts = ImportPreviewCounts::default();
  let mut requires_authentication = Vec::new();
  let mut integration_requires_authentication = Vec::new();
  let mut ocr_requires_authentication = Vec::new();

  match mode {
    ImportConflictMode::Merge => {
      for p in &document.providers {
        if local_providers.contains_key(&p.id) {
          counts.providers_update += 1;
        } else {
          counts.providers_create += 1;
        }
        if p.credential_kind != CredentialKind::None {
          requires_authentication.push(p.id);
        }
      }
      for m in &document.models {
        if local_models.contains_key(&m.id) {
          counts.models_update += 1;
        } else {
          counts.models_create += 1;
        }
      }
      for p in &document.translation_profiles {
        if local_profiles.contains_key(&p.id) {
          counts.profiles_update += 1;
        } else {
          counts.profiles_create += 1;
        }
      }
      for i in &document.integration_instances {
        if local_integrations.contains_key(&i.id) {
          counts.integrations_update += 1;
        } else {
          counts.integrations_create += 1;
        }
        // Only credential-bearing plugins require re-auth after secret-free import.
        if integration_plugin_requires_authentication(&i.plugin_id) {
          integration_requires_authentication.push(i.id);
        }
      }
      for service in &document.ocr_services {
        if local_ocr_services.contains_key(&service.id) {
          counts.ocr_services_update += 1;
        } else {
          counts.ocr_services_create += 1;
        }
        if matches!(service.provider_type, OcrProviderType::Baidu) {
          ocr_requires_authentication.push(service.id);
        }
      }
      for service in &document.speech_services {
        if local_speech_services.contains_key(&service.id) {
          counts.speech_services_update += 1;
        } else {
          counts.speech_services_create += 1;
        }
      }
      if let Some(pid) = settings.default_profile_id {
        if !doc_profile_ids.contains(&pid) && !local_profiles.contains_key(&pid) {
          // Self-contained rule: non-null default must resolve in document.
          // Local-only defaults are not allowed by the import plan.
          errors.push(format!(
            "default_profile_id {pid} is not present in the import document"
          ));
        } else if !doc_profile_ids.contains(&pid) {
          // Prefer document profiles; if only local, clear with report.
          settings.default_profile_id = None;
          default_profile_cleared = true;
        }
      }
      if let Some(oid) = settings.default_ocr_service_id {
        if !doc_ocr_service_ids.contains(&oid) && !local_ocr_services.contains_key(&oid) {
          errors.push(format!(
            "default_ocr_service_id {oid} is not present in the import document"
          ));
        } else if !doc_ocr_service_ids.contains(&oid) {
          settings.default_ocr_service_id = None;
        }
      }
      if let Some(sid) = settings.default_speech_service_id {
        if !doc_speech_service_ids.contains(&sid) && !local_speech_services.contains_key(&sid) {
          errors.push(format!(
            "default_speech_service_id {sid} is not present in the import document"
          ));
        } else if !doc_speech_service_ids.contains(&sid) {
          settings.default_speech_service_id = None;
        }
      }
    }
    ImportConflictMode::Copy => {
      counts.providers_copy = document.providers.len() as u32;
      counts.models_copy = document.models.len() as u32;
      counts.profiles_copy = document.translation_profiles.len() as u32;
      counts.integrations_copy = document.integration_instances.len() as u32;
      counts.ocr_services_copy = document.ocr_services.len() as u32;
      counts.speech_services_copy = document.speech_services.len() as u32;
      for p in &document.providers {
        provider_id_map.insert(p.id, new_id());
        if p.credential_kind != CredentialKind::None {
          requires_authentication.push(p.id);
        }
      }
      for m in &document.models {
        model_id_map.insert(m.id, new_id());
      }
      for p in &document.translation_profiles {
        profile_id_map.insert(p.id, new_id());
      }
      for i in &document.integration_instances {
        let new_integration_id = new_id();
        integration_id_map.insert(i.id, new_integration_id);
        if integration_plugin_requires_authentication(&i.plugin_id) {
          integration_requires_authentication.push(new_integration_id);
        }
      }
      for service in &document.ocr_services {
        let new_ocr_id = new_id();
        ocr_service_id_map.insert(service.id, new_ocr_id);
        if matches!(service.provider_type, OcrProviderType::Baidu) {
          ocr_requires_authentication.push(new_ocr_id);
        }
      }
      for service in &document.speech_services {
        speech_service_id_map.insert(service.id, new_id());
      }
      if let Some(old_default) = settings.default_profile_id {
        if let Some(new_id) = profile_id_map.get(&old_default) {
          settings.default_profile_id = Some(*new_id);
        } else {
          settings.default_profile_id = None;
          default_profile_cleared = true;
        }
      }
      if let Some(old_default) = settings.default_ocr_service_id {
        if let Some(new_id) = ocr_service_id_map.get(&old_default) {
          settings.default_ocr_service_id = Some(*new_id);
        } else {
          settings.default_ocr_service_id = None;
        }
      }
      if let Some(old_default) = settings.default_speech_service_id {
        if let Some(new_id) = speech_service_id_map.get(&old_default) {
          settings.default_speech_service_id = Some(*new_id);
        } else {
          settings.default_speech_service_id = None;
        }
      }
    }
  }

  let proxy_requires_authentication =
    settings.network.proxy_mode == GlobalProxyMode::Custom || settings.network.proxy_url.is_some();

  // Plugin profiles must reference an integration present in the document (or surviving local merge).
  for profile in &document.translation_profiles {
    if let Some(plugin) = profile.engine.as_plugin() {
      if !doc_integration_ids.contains(&plugin.integration_instance_id)
        && !(mode == ImportConflictMode::Merge && local_integrations.contains_key(&plugin.integration_instance_id))
      {
        errors.push(format!(
          "profile {} references missing integration {}",
          profile.id, plugin.integration_instance_id
        ));
      }
    }
  }

  let preview = ImportPreview {
    valid: errors.is_empty(),
    counts,
    validation_errors: errors.clone(),
    requires_authentication,
    integration_requires_authentication,
    ocr_requires_authentication,
    proxy_requires_authentication,
    default_profile_cleared,
  };

  if !preview.valid {
    return Ok(ValidatedImportPlan {
      mode,
      preview,
      providers: vec![],
      models: vec![],
      profiles: vec![],
      targets: vec![],
      prompt_templates: vec![],
      integrations: vec![],
      ocr_services: vec![],
      ocr_prompt_templates: vec![],
      speech_services: vec![],
      settings,
      provider_cleanup_ids: vec![],
      clear_global_proxy: false,
      expected_provider_refs: HashMap::new(),
      expected_ocr_api_key_refs: HashMap::new(),
      expected_ocr_secret_key_refs: HashMap::new(),
      expected_proxy_ref: local_proxy_ref,
    });
  }

  // Build normalized entities.
  let now = now_rfc3339();
  let mut providers = Vec::new();
  let mut provider_cleanup_ids = Vec::new();
  let mut expected_provider_refs = HashMap::new();

  for p in &document.providers {
    let (id, created_at) = match mode {
      ImportConflictMode::Merge => {
        if let Some(existing) = local_providers.get(&p.id) {
          expected_provider_refs.insert(p.id, existing.credential_ref.clone());
          if existing.credential_ref.is_some() {
            provider_cleanup_ids.push(p.id);
          }
          (p.id, existing.created_at.clone())
        } else {
          expected_provider_refs.insert(p.id, None);
          (p.id, p.created_at.clone())
        }
      }
      ImportConflictMode::Copy => {
        let new_id = *provider_id_map.get(&p.id).expect("provider map");
        (new_id, now.clone())
      }
    };
    let transport = p
      .normalize_transport()
      .map_err(|e| StorageError::Validation(format!("provider {}: {e}", p.id)))?;
    providers.push(ProviderInstance {
      id,
      adapter_id: p.adapter_id.clone(),
      display_name: p.display_name.clone(),
      base_url: transport.base_url,
      base_url_source: transport.base_url_source,
      auth_scheme: transport.auth_scheme,
      credential_kind: p.credential_kind,
      credential_ref: None,
      enabled: p.enabled,
      proxy_mode: p.proxy_mode,
      insecure_http_confirmed_at: p.insecure_http_confirmed_at.clone(),
      models_synced_at: None,
      models_sync_status: ModelsSyncStatus::Never,
      models_sync_error_code: None,
      created_at,
      updated_at: now.clone(),
    });
  }

  let mut models = Vec::new();
  for m in &document.models {
    let (id, provider_instance_id, created_at) = match mode {
      ImportConflictMode::Merge => (m.id, m.provider_instance_id, m.created_at.clone()),
      ImportConflictMode::Copy => {
        let new_id = *model_id_map.get(&m.id).expect("model map");
        let provider_id = *provider_id_map
          .get(&m.provider_instance_id)
          .expect("provider map for model");
        (new_id, provider_id, now.clone())
      }
    };
    let mut model = m.clone();
    model.id = id;
    model.provider_instance_id = provider_instance_id;
    model.created_at = created_at;
    model.updated_at = now.clone();
    // Normalize capability overrides to validated JSON.
    if let Some(validated) = CapabilityOverridesV1::from_json(&model.capability_overrides_json)? {
      model.capability_overrides_json = Some(serde_json::to_value(validated).expect("serialize"));
    } else {
      model.capability_overrides_json = None;
    }
    // Empty/whitespace adapter_id means inherit channel default.
    model.adapter_id = model
      .adapter_id
      .as_ref()
      .map(|s| s.trim().to_string())
      .filter(|s| !s.is_empty());
    models.push(model);
  }

  let mut profiles = Vec::new();
  let mut targets = Vec::new();
  let mut prompt_templates = Vec::new();
  // Copy mode assigns new template ids while preserving default selection.
  let mut template_id_map: HashMap<Uuid, Uuid> = HashMap::new();
  if matches!(mode, ImportConflictMode::Copy) {
    for t in &document.profile_prompt_templates {
      template_id_map.insert(t.id, new_id());
    }
  }

  for profile in &document.translation_profiles {
    let (id, created_at) = match mode {
      ImportConflictMode::Merge => {
        if let Some(existing) = local_profiles.get(&profile.id) {
          (profile.id, existing.created_at.clone())
        } else {
          (profile.id, profile.created_at.clone())
        }
      }
      ImportConflictMode::Copy => {
        let new_id = *profile_id_map.get(&profile.id).expect("profile map");
        (new_id, now.clone())
      }
    };
    let mut p = profile.clone();
    p.id = id;
    p.created_at = created_at;
    p.updated_at = now.clone();
    // Copy mode rewrites LLM detection/template ids and plugin integration bindings.
    if matches!(mode, ImportConflictMode::Copy) {
      match &mut p.engine {
        TranslationProfileEngine::LlmModelChain(llm) => {
          if let Some(LanguageDetectorConfig::Llm {
            model_id: Some(old_model),
          }) = llm.language_detection
          {
            let new_model = *model_id_map.get(&old_model).expect("detection model map");
            llm.language_detection = Some(LanguageDetectorConfig::Llm {
              model_id: Some(new_model),
            });
          }
          llm.default_prompt_template_id = *template_id_map
            .get(&llm.default_prompt_template_id)
            .expect("default template map");
        }
        TranslationProfileEngine::PluginCapability(plugin) => {
          plugin.integration_instance_id = *integration_id_map
            .get(&plugin.integration_instance_id)
            .expect("integration map");
        }
      }
    }
    profiles.push(p);

    let mut profile_targets: Vec<_> = document
      .profile_models
      .iter()
      .filter(|t| t.translation_profile_id == profile.id)
      .cloned()
      .collect();
    profile_targets.sort_by_key(|t| t.priority);
    for t in profile_targets {
      let model_id = match mode {
        ImportConflictMode::Merge => t.provider_model_id,
        ImportConflictMode::Copy => *model_id_map.get(&t.provider_model_id).expect("model map"),
      };
      targets.push(TranslationProfileTarget {
        translation_profile_id: id,
        provider_model_id: model_id,
        priority: t.priority,
      });
    }

    let mut profile_templates: Vec<_> = document
      .profile_prompt_templates
      .iter()
      .filter(|t| t.translation_profile_id == profile.id)
      .cloned()
      .collect();
    profile_templates.sort_by_key(|t| t.sort_order);
    for t in profile_templates {
      let template_id = match mode {
        ImportConflictMode::Merge => t.id,
        ImportConflictMode::Copy => *template_id_map.get(&t.id).expect("template map"),
      };
      prompt_templates.push(TranslationProfilePromptTemplate {
        id: template_id,
        translation_profile_id: id,
        name: t.name,
        system_template: t.system_template,
        user_template: t.user_template,
        sort_order: t.sort_order,
      });
    }
  }

  // Default profile must exist after apply when non-null.
  if let Some(pid) = settings.default_profile_id {
    let in_plan = profiles.iter().any(|p| p.id == pid);
    if !in_plan {
      // Already handled for copy; for merge, re-check local after apply of profiles.
      if translation_profiles::get(conn, pid).is_err() && !local_profiles.contains_key(&pid) {
        // Will fail validation below if still missing.
      }
    }
  }

  let clear_global_proxy = local_proxy_ref.is_some()
    && (settings.network.proxy_mode == GlobalProxyMode::Custom || settings.network.proxy_url.is_some());

  // Re-check default profile against plan+local for merge.
  if let Some(pid) = settings.default_profile_id {
    let exists_in_plan = profiles.iter().any(|p| p.id == pid);
    let exists_local = local_profiles.contains_key(&pid);
    if !exists_in_plan && !exists_local {
      return Err(StorageError::Validation(format!(
        "default_profile_id {pid} does not exist"
      )));
    }
  }

  // Integrations: structural config only; credentials always empty after import.
  let mut integrations = Vec::new();
  for exported in &document.integration_instances {
    let (id, created_at) = match mode {
      ImportConflictMode::Merge => {
        if let Some(local) = local_integrations.get(&exported.id) {
          (exported.id, local.created_at.clone())
        } else {
          (exported.id, now.clone())
        }
      }
      ImportConflictMode::Copy => {
        let new_id = *integration_id_map.get(&exported.id).expect("integration map");
        (new_id, now.clone())
      }
    };
    let config_json = normalized_integration_configs
      .get(&exported.id)
      .cloned()
      .unwrap_or_else(|| exported.config_json.clone());
    integrations.push(integration_from_export(
      exported,
      id,
      created_at,
      now.clone(),
      config_json,
    ));
  }

  // OCR services + templates (secrets always empty after import).
  let mut ocr_template_id_map: HashMap<Uuid, Uuid> = HashMap::new();
  if matches!(mode, ImportConflictMode::Copy) {
    for template in &document.ocr_prompt_templates {
      ocr_template_id_map.insert(template.id, new_id());
    }
  }

  let mut planned_ocr_services = Vec::new();
  let mut planned_ocr_templates = Vec::new();
  let mut expected_ocr_api_key_refs = HashMap::new();
  let mut expected_ocr_secret_key_refs = HashMap::new();

  for exported in &document.ocr_services {
    let (id, created_at) = match mode {
      ImportConflictMode::Merge => {
        if let Some(local) = local_ocr_services.get(&exported.id) {
          expected_ocr_api_key_refs.insert(exported.id, local.api_key_ref.clone());
          expected_ocr_secret_key_refs.insert(exported.id, local.secret_key_ref.clone());
          (exported.id, local.created_at.clone())
        } else {
          expected_ocr_api_key_refs.insert(exported.id, None);
          expected_ocr_secret_key_refs.insert(exported.id, None);
          (exported.id, exported.created_at.clone())
        }
      }
      ImportConflictMode::Copy => {
        let new_id = *ocr_service_id_map.get(&exported.id).expect("ocr service map");
        (new_id, now.clone())
      }
    };

    let mut provider_model_id = exported.provider_model_id;
    let mut default_prompt_template_id = exported.default_prompt_template_id;
    let mut integration_instance_id = exported.integration_instance_id;
    if matches!(mode, ImportConflictMode::Copy) {
      if let Some(old_model) = provider_model_id {
        provider_model_id = Some(*model_id_map.get(&old_model).expect("ocr model map"));
      }
      if let Some(old_template) = default_prompt_template_id {
        default_prompt_template_id = Some(*ocr_template_id_map.get(&old_template).expect("ocr template map"));
      }
      if let Some(old_integration) = integration_instance_id {
        integration_instance_id = Some(*integration_id_map.get(&old_integration).expect("ocr integration map"));
      }
    }

    planned_ocr_services.push(OcrService {
      id,
      provider_type: exported.provider_type,
      display_name: exported.display_name.clone(),
      enabled: exported.enabled,
      sort_order: exported.sort_order,
      baidu_action: exported.baidu_action,
      api_key_ref: None,
      secret_key_ref: None,
      provider_model_id,
      temperature: exported.temperature,
      default_prompt_template_id,
      integration_instance_id,
      ocr_capability_id: exported.ocr_capability_id.clone(),
      capability_preferences_version: exported.capability_preferences_version,
      capability_preferences: exported.capability_preferences.clone(),
      created_at,
      updated_at: now.clone(),
    });
  }

  for template in &document.ocr_prompt_templates {
    let (id, ocr_service_id) = match mode {
      ImportConflictMode::Merge => (template.id, template.ocr_service_id),
      ImportConflictMode::Copy => (
        *ocr_template_id_map.get(&template.id).expect("ocr template map"),
        *ocr_service_id_map
          .get(&template.ocr_service_id)
          .expect("ocr service map for template"),
      ),
    };
    planned_ocr_templates.push(OcrPromptTemplateExport {
      id,
      ocr_service_id,
      name: template.name.clone(),
      system_template: template.system_template.clone(),
      user_template: template.user_template.clone(),
      sort_order: template.sort_order,
    });
  }

  // Default OCR must resolve after plan apply when non-null.
  if let Some(oid) = settings.default_ocr_service_id {
    let exists_in_plan = planned_ocr_services.iter().any(|s| s.id == oid);
    let exists_local = local_ocr_services.contains_key(&oid);
    if !exists_in_plan && !exists_local {
      return Err(StorageError::Validation(format!(
        "default_ocr_service_id {oid} does not exist"
      )));
    }
  }

  // Speech services (after integrations so FKs resolve; secrets never present).
  let mut planned_speech_services = Vec::new();
  for exported in &document.speech_services {
    let (id, created_at) = match mode {
      ImportConflictMode::Merge => {
        if let Some(local) = local_speech_services.get(&exported.id) {
          (exported.id, local.created_at.clone())
        } else {
          (exported.id, exported.created_at.clone())
        }
      }
      ImportConflictMode::Copy => {
        let new_id = *speech_service_id_map.get(&exported.id).expect("speech service map");
        (new_id, now.clone())
      }
    };

    let mut integration_instance_id = exported.integration_instance_id;
    if matches!(mode, ImportConflictMode::Copy) {
      integration_instance_id = *integration_id_map
        .get(&exported.integration_instance_id)
        .expect("speech integration map");
    }

    planned_speech_services.push(SpeechService {
      id,
      display_name: exported.display_name.clone(),
      enabled: exported.enabled,
      sort_order: exported.sort_order,
      integration_instance_id,
      capability_id: exported.capability_id.clone(),
      preferences_schema_version: exported.preferences_schema_version,
      preferences: exported.preferences.clone(),
      created_at,
      updated_at: now.clone(),
    });
  }

  // Default Speech must resolve after plan apply when non-null.
  if let Some(sid) = settings.default_speech_service_id {
    let exists_in_plan = planned_speech_services.iter().any(|s| s.id == sid);
    let exists_local = local_speech_services.contains_key(&sid);
    if !exists_in_plan && !exists_local {
      return Err(StorageError::Validation(format!(
        "default_speech_service_id {sid} does not exist"
      )));
    }
  }

  Ok(ValidatedImportPlan {
    mode,
    preview,
    providers,
    models,
    profiles,
    targets,
    prompt_templates,
    integrations,
    ocr_services: planned_ocr_services,
    ocr_prompt_templates: planned_ocr_templates,
    speech_services: planned_speech_services,
    settings,
    provider_cleanup_ids,
    clear_global_proxy,
    expected_provider_refs,
    expected_ocr_api_key_refs,
    expected_ocr_secret_key_refs,
    expected_proxy_ref: local_proxy_ref,
  })
}

fn integration_from_export(
  exported: &IntegrationInstanceExport,
  id: Uuid,
  created_at: String,
  updated_at: String,
  config_json: String,
) -> IntegrationInstance {
  // Credential-bearing plugins stay unconfigured until re-auth.
  // Zero-secret Web instances with complete validated config are Ready and executable.
  let health_status = imported_integration_health(&exported.plugin_id, &config_json, exported.config_schema_version);
  // Preserve exact runtime requirements. Never invent digests, never download packages, never
  // issue grants or activate. Package-backed imports stay unresolved until local install +
  // trust + permission approval + explicit activation.
  // v7 requires an explicit runtime record. Missing runtime is only legal on pre-v7 documents
  // after sequential normalization (which synthesizes bundled-rust). Never activate missing
  // package-backed pins as bundled.
  let Some(req) = exported.runtime.as_ref() else {
    // Fail closed: a normalized plan must always carry runtime after v6→v7.
    return IntegrationInstance {
      id,
      plugin_id: exported.plugin_id.clone(),
      plugin_version: exported.plugin_version.clone(),
      display_name: exported.display_name.clone(),
      enabled: false,
      config_json,
      config_schema_version: exported.config_schema_version,
      health_status: IntegrationHealthStatus::Unconfigured,
      last_validated_at: None,
      last_error_code: Some("invalid_runtime".into()),
      runtime_kind: "bundled-rust".into(),
      package_digest: None,
      execution_grant_set_revision: None,
      runtime_state: "unavailable".into(),
      runtime_error_code: Some("invalid_runtime".into()),
      runtime_error_message: Some("import is missing runtime requirement".into()),
      runtime_requirement_json: None,
      created_at,
      updated_at,
    };
  };
  if req.plugin_id != exported.plugin_id || req.plugin_version != exported.plugin_version {
    return IntegrationInstance {
      id,
      plugin_id: exported.plugin_id.clone(),
      plugin_version: exported.plugin_version.clone(),
      display_name: exported.display_name.clone(),
      enabled: false,
      config_json,
      config_schema_version: exported.config_schema_version,
      health_status: IntegrationHealthStatus::Unconfigured,
      last_validated_at: None,
      last_error_code: Some("invalid_runtime".into()),
      runtime_kind: "bundled-rust".into(),
      package_digest: None,
      execution_grant_set_revision: None,
      runtime_state: "unavailable".into(),
      runtime_error_code: Some("invalid_runtime".into()),
      runtime_error_message: Some("runtime identity does not match outer instance fields".into()),
      runtime_requirement_json: None,
      created_at,
      updated_at,
    };
  }
  let requirement_json = match serde_json::to_string(req) {
    Ok(v) => Some(v),
    Err(_) => None,
  };
  let parsed_kind = crate::domain::runtime_lifecycle::parse_runtime_kind(&req.runtime_kind);
  let (
    runtime_kind,
    package_digest,
    execution_grant_set_revision,
    runtime_state,
    runtime_error_code,
    runtime_error_message,
    runtime_requirement_json,
  ) = match parsed_kind {
    Ok(crate::domain::runtime_plugin::RuntimeKind::WasmComponent)
    | Ok(crate::domain::runtime_plugin::RuntimeKind::TrustedNativeWorker) => {
      use crate::domain::runtime_plugin::{PackageDigest, PluginApiVersion, PublisherKeyFingerprint, PublisherKeyId};
      // Empty-only trim; parsers get the raw wire string so whitespace fails closed.
      let digest_ok = req.package_digest.as_deref().and_then(|d| {
        if d.trim().is_empty() {
          None
        } else {
          PackageDigest::parse(d).ok()
        }
      });
      let key_ok = req.publisher_key_id.as_deref().and_then(|k| {
        if k.trim().is_empty() {
          None
        } else {
          PublisherKeyId::parse(k).ok()
        }
      });
      let fp_ok = req.publisher_key_fingerprint.as_deref().and_then(|f| {
        if f.trim().is_empty() {
          None
        } else {
          PublisherKeyFingerprint::parse(f).ok()
        }
      });
      let api_ok = req.plugin_api_version.as_deref().and_then(|a| {
        if a.trim().is_empty() {
          None
        } else {
          PluginApiVersion::parse(a).ok()
        }
      });
      if digest_ok.is_none() || key_ok.is_none() || fp_ok.is_none() || api_ok.is_none() {
        (
          req.runtime_kind.clone(),
          None,
          None,
          "unavailable".to_string(),
          Some("invalid_runtime".to_string()),
          Some("package-backed runtime requirement is incomplete or invalid".to_string()),
          requirement_json,
        )
      } else {
        (
          req.runtime_kind.clone(),
          digest_ok.map(|d| d.as_str().to_string()),
          None, // grant issued only on explicit activation
          "unavailable".to_string(),
          Some("plugin_missing".to_string()),
          Some("required package is not installed or not activated".to_string()),
          requirement_json,
        )
      }
    }
    Ok(crate::domain::runtime_plugin::RuntimeKind::LegacyFrontendProvider) => (
      req.runtime_kind.clone(),
      None,
      None,
      "pending_activation".to_string(),
      None,
      None,
      requirement_json,
    ),
    Ok(crate::domain::runtime_plugin::RuntimeKind::BundledRust) => (
      req.runtime_kind.clone(),
      None,
      None,
      "active".to_string(),
      None,
      None,
      requirement_json,
    ),
    Err(_) => (
      // Unknown runtimeKind must never import as active.
      req.runtime_kind.clone(),
      None,
      None,
      "unavailable".to_string(),
      Some("invalid_runtime".to_string()),
      Some("unknown runtimeKind".to_string()),
      requirement_json,
    ),
  };

  IntegrationInstance {
    id,
    plugin_id: exported.plugin_id.clone(),
    plugin_version: exported.plugin_version.clone(),
    display_name: exported.display_name.clone(),
    enabled: exported.enabled,
    config_json,
    config_schema_version: exported.config_schema_version,
    health_status,
    last_validated_at: None,
    last_error_code: None,
    runtime_kind,
    package_digest,
    execution_grant_set_revision,
    runtime_state,
    runtime_error_code,
    runtime_error_message,
    runtime_requirement_json,
    created_at,
    updated_at,
  }
}

fn bundled_registry() -> Option<&'static ServiceIntegrationRegistry> {
  static REGISTRY: OnceLock<Option<ServiceIntegrationRegistry>> = OnceLock::new();
  REGISTRY
    .get_or_init(|| ServiceIntegrationRegistry::bundled().ok())
    .as_ref()
}

/// True when the plugin requires remote auth (token grant) before becoming Ready.
fn integration_plugin_requires_authentication(plugin_id: &str) -> bool {
  match bundled_registry().and_then(|reg| reg.get_registration(plugin_id)) {
    Some(registration) => registration.requires_remote_auth(),
    // Unknown plugins: fail closed and require re-auth rather than claiming zero-secret readiness.
    None => true,
  }
}

/// Normalize/validate plugin config for import via the registration's config adapter.
fn normalize_imported_integration_config(plugin_id: &str, config_json: &str) -> Result<String, StorageError> {
  match bundled_registry().and_then(|reg| reg.get_registration(plugin_id)) {
    Some(registration) => registration.config_adapter.normalize_config(config_json),
    None => {
      // Unknown plugins: accept JSON objects as structural config.
      let value: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|_| StorageError::Validation("config_json must be valid JSON".into()))?;
      if !value.is_object() {
        return Err(StorageError::Validation("config_json must be an object".into()));
      }
      Ok(config_json.to_string())
    }
  }
}

fn imported_integration_health(
  plugin_id: &str,
  config_json: &str,
  config_schema_version: u32,
) -> IntegrationHealthStatus {
  match bundled_registry().and_then(|reg| reg.get_registration(plugin_id)) {
    Some(registration) => {
      // Unsupported schema version: retain data but mark unconfigured (read-only unresolved).
      if registration.config_schema.version != config_schema_version {
        return IntegrationHealthStatus::Unconfigured;
      }
      if registration.requires_remote_auth() {
        // Auth-bearing integrations need re-configuration/re-auth after import.
        IntegrationHealthStatus::Unconfigured
      } else if registration.config_adapter.config_ready(config_json) {
        IntegrationHealthStatus::Ready
      } else {
        IntegrationHealthStatus::Unconfigured
      }
    }
    None => IntegrationHealthStatus::Unconfigured,
  }
}

fn reject_duplicate_ids<I>(ids: I, label: &str, errors: &mut Vec<String>)
where
  I: IntoIterator<Item = Uuid>,
{
  let mut seen = HashSet::new();
  for id in ids {
    if !seen.insert(id) {
      errors.push(format!("duplicate {label} id {id}"));
    }
  }
}

fn validate_import_provider(p: &ProviderExport) -> Result<(), StorageError> {
  validate_adapter_id(&p.adapter_id).map_err(StorageError::Validation)?;
  if p.display_name.trim().is_empty() {
    return Err(StorageError::Validation("display_name must not be empty".into()));
  }
  if p.display_name.len() > 200 {
    return Err(StorageError::Validation(
      "display_name must be at most 200 characters".into(),
    ));
  }
  let transport = p.normalize_transport().map_err(StorageError::Validation)?;
  validate_provider_url(&transport.base_url, p.insecure_http_confirmed_at.as_deref())?;
  if !transport.auth_scheme.compatible_with(p.credential_kind) {
    return Err(StorageError::Validation(
      "auth_scheme is incompatible with credential_kind".into(),
    ));
  }
  // Unknown plugin IDs require explicit custom Base URL + auth scheme (current format).
  if crate::domain::provider::builtin_default_base_url(&p.adapter_id).is_none() {
    let has_explicit = p.base_url.is_some()
      && p.base_url_source == Some(crate::domain::provider::BaseUrlSource::Custom)
      && p.auth_scheme.is_some();
    if !has_explicit {
      return Err(StorageError::Validation(
        "unknown plugin requires explicit baseUrl, baseUrlSource=custom, and authScheme".into(),
      ));
    }
  }
  // credential_kind / ref invariant: exports never carry refs; kind may require re-auth.
  Ok(())
}

fn validate_import_model(m: &ProviderModel, doc_providers: &HashSet<Uuid>) -> Result<(), StorageError> {
  let key = m.model_key.trim();
  if key.is_empty() {
    return Err(StorageError::Validation("model_key must not be empty".into()));
  }
  if key.len() > 256 {
    return Err(StorageError::Validation(
      "model_key must be at most 256 characters".into(),
    ));
  }
  if !doc_providers.contains(&m.provider_instance_id) {
    return Err(StorageError::Validation(format!(
      "references missing provider {}",
      m.provider_instance_id
    )));
  }
  if let Some(adapter_id) = m.adapter_id.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
    validate_adapter_id(adapter_id).map_err(StorageError::Validation)?;
  }
  CapabilityOverridesV1::from_json(&m.capability_overrides_json)?;
  Ok(())
}

fn validate_import_profile(
  profile: &TranslationProfile,
  targets: &[&TranslationProfileTarget],
  templates: &[&TranslationProfilePromptTemplate],
  doc_model_ids: &HashSet<Uuid>,
) -> Result<(), StorageError> {
  if profile.name.trim().is_empty() {
    return Err(StorageError::Validation("profile name must not be empty".into()));
  }
  validate_profile_language_preferences(&profile.primary_lang, &profile.preferred_target_lang)?;

  match &profile.engine {
    TranslationProfileEngine::LlmModelChain(llm) => {
      if targets.is_empty() {
        return Err(StorageError::Validation(
          "profile requires at least one target model".into(),
        ));
      }
      let mut seen_models = HashSet::new();
      let mut priorities: Vec<i32> = targets.iter().map(|t| t.priority).collect();
      priorities.sort_unstable();
      for (i, prio) in priorities.iter().enumerate() {
        if *prio != i as i32 {
          return Err(StorageError::Validation(
            "profile target priorities must be contiguous starting at 0".into(),
          ));
        }
      }
      for t in targets {
        if !seen_models.insert(t.provider_model_id) {
          return Err(StorageError::Validation("profile targets must be unique models".into()));
        }
      }
      if let Some(temp) = llm.temperature {
        if temp < 0.0 {
          return Err(StorageError::Validation("temperature must be >= 0".into()));
        }
      }
      if let Some(tokens) = llm.max_output_tokens {
        if tokens <= 0 {
          return Err(StorageError::Validation("max_output_tokens must be > 0".into()));
        }
      }

      let mut sort_orders: Vec<i32> = templates.iter().map(|t| t.sort_order).collect();
      sort_orders.sort_unstable();
      for (i, order) in sort_orders.iter().enumerate() {
        if *order != i as i32 {
          return Err(StorageError::Validation(
            "prompt template sort_order must be contiguous starting at 0".into(),
          ));
        }
      }
      let prompt_templates: Vec<PromptTemplate> = templates
        .iter()
        .map(|t| PromptTemplate {
          id: t.id,
          name: t.name.clone(),
          system_template: t.system_template.clone(),
          user_template: t.user_template.clone(),
        })
        .collect();
      validate_prompt_templates(&prompt_templates, llm.default_prompt_template_id)?;

      // Provider-specific profile options are not used; only empty/null objects are accepted.
      if let Some(options) = &llm.provider_options_json {
        if !options.is_null() && options.as_object().map(|o| !o.is_empty()).unwrap_or(true) {
          return Err(StorageError::Validation("provider_options_json must be empty".into()));
        }
      }
      // A configured LLM detector must reference a model present in the import document.
      if let Some(LanguageDetectorConfig::Llm {
        model_id: Some(model_id),
      }) = llm.language_detection
      {
        if !doc_model_ids.contains(&model_id) {
          return Err(StorageError::Validation(format!(
            "language detection references missing model {model_id}"
          )));
        }
      }
    }
    TranslationProfileEngine::PluginCapability(plugin) => {
      if !targets.is_empty() {
        return Err(StorageError::Validation(
          "plugin profile must not include model targets".into(),
        ));
      }
      if !templates.is_empty() {
        return Err(StorageError::Validation(
          "plugin profile must not include prompt templates".into(),
        ));
      }
      if plugin.translate_capability_id.trim().is_empty() {
        return Err(StorageError::Validation("translate_capability_id is required".into()));
      }
      // Integration existence is revalidated when applying v4 documents that include instances.
      let _ = plugin.integration_instance_id;
    }
  }
  Ok(())
}

fn validate_import_ocr_service(
  service: &OcrServiceExport,
  templates: &[&OcrPromptTemplateExport],
  doc_model_ids: &HashSet<Uuid>,
  doc_integration_ids: &HashSet<Uuid>,
  mode: ImportConflictMode,
  local_integrations: &HashMap<Uuid, IntegrationInstance>,
) -> Result<(), StorageError> {
  if service.display_name.trim().is_empty() {
    return Err(StorageError::Validation("display_name must not be empty".into()));
  }
  match service.provider_type {
    OcrProviderType::Baidu => {
      if service.baidu_action.is_none() {
        return Err(StorageError::Validation(
          "baidu_action is required for baidu OCR".into(),
        ));
      }
      if service.provider_model_id.is_some()
        || service.default_prompt_template_id.is_some()
        || service.integration_instance_id.is_some()
        || service.ocr_capability_id.is_some()
        || service.capability_preferences_version.is_some()
        || service.capability_preferences.is_some()
      {
        return Err(StorageError::Validation(
          "baidu OCR must not include ai/plugin fields".into(),
        ));
      }
      if !templates.is_empty() {
        return Err(StorageError::Validation(
          "baidu OCR must not include prompt templates".into(),
        ));
      }
    }
    OcrProviderType::Ai => {
      let model_id = service
        .provider_model_id
        .ok_or_else(|| StorageError::Validation("provider_model_id is required for ai OCR".into()))?;
      if !doc_model_ids.contains(&model_id) {
        return Err(StorageError::Validation(format!(
          "ai OCR references missing model {model_id}"
        )));
      }
      if templates.is_empty() {
        return Err(StorageError::Validation(
          "ai OCR requires at least one prompt template".into(),
        ));
      }
      let default_id = service
        .default_prompt_template_id
        .ok_or_else(|| StorageError::Validation("default_prompt_template_id is required for ai OCR".into()))?;
      if !templates.iter().any(|t| t.id == default_id) {
        return Err(StorageError::Validation(
          "default_prompt_template_id must reference an OCR prompt template".into(),
        ));
      }
      if service.baidu_action.is_some()
        || service.integration_instance_id.is_some()
        || service.ocr_capability_id.is_some()
        || service.capability_preferences_version.is_some()
        || service.capability_preferences.is_some()
      {
        return Err(StorageError::Validation(
          "ai OCR must not include baidu/plugin fields".into(),
        ));
      }
    }
    OcrProviderType::PluginCapability => {
      let integration_id = service
        .integration_instance_id
        .ok_or_else(|| StorageError::Validation("integration_instance_id is required for plugin OCR".into()))?;
      // Fail closed when the bound integration is absent from the document (and not a surviving local merge).
      if !doc_integration_ids.contains(&integration_id)
        && !(mode == ImportConflictMode::Merge && local_integrations.contains_key(&integration_id))
      {
        return Err(StorageError::Validation(format!(
          "plugin OCR references missing integration {integration_id}"
        )));
      }
      let capability_id = service
        .ocr_capability_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| StorageError::Validation("ocr_capability_id is required for plugin OCR".into()))?;
      if !capability_id.starts_with("ocr.image@") {
        return Err(StorageError::Validation(
          "ocr_capability_id must be an ocr.image@N capability".into(),
        ));
      }
      let prefs_version = service
        .capability_preferences_version
        .ok_or_else(|| StorageError::Validation("capability_preferences_version is required for plugin OCR".into()))?;
      if prefs_version != GOOGLE_VISION_PREFERENCES_SCHEMA_VERSION {
        return Err(StorageError::Validation(format!(
          "unsupported OCR preferences schema version {prefs_version}"
        )));
      }
      let prefs = service
        .capability_preferences
        .as_ref()
        .ok_or_else(|| StorageError::Validation("capability_preferences is required for plugin OCR".into()))?;
      // Reuse the save-path validator: known keys via typed parse, operation enum, hint bounds.
      let typed = parse_ocr_image_preferences(prefs).map_err(StorageError::Validation)?;
      validate_ocr_image_preferences(&typed).map_err(|e| StorageError::Validation(e.message))?;
      if service.baidu_action.is_some()
        || service.provider_model_id.is_some()
        || service.default_prompt_template_id.is_some()
      {
        return Err(StorageError::Validation(
          "plugin OCR must not include baidu/ai fields".into(),
        ));
      }
      if !templates.is_empty() {
        return Err(StorageError::Validation(
          "plugin OCR must not include prompt templates".into(),
        ));
      }
    }
  }
  Ok(())
}

fn validate_import_speech_service(
  service: &SpeechServiceExport,
  doc_integration_ids: &HashSet<Uuid>,
  mode: ImportConflictMode,
  local_integrations: &HashMap<Uuid, IntegrationInstance>,
) -> Result<(), StorageError> {
  let name = service.display_name.trim();
  if name.is_empty() {
    return Err(StorageError::Validation("display_name must not be empty".into()));
  }
  if name.chars().count() > SPEECH_DISPLAY_NAME_MAX_LEN {
    return Err(StorageError::Validation(format!(
      "display_name exceeds {SPEECH_DISPLAY_NAME_MAX_LEN} characters"
    )));
  }
  // Fail closed when the bound integration is absent from the document (and not a surviving local merge).
  if !doc_integration_ids.contains(&service.integration_instance_id)
    && !(mode == ImportConflictMode::Merge && local_integrations.contains_key(&service.integration_instance_id))
  {
    return Err(StorageError::Validation(format!(
      "speech service references missing integration {}",
      service.integration_instance_id
    )));
  }
  let capability_id = service.capability_id.trim();
  if capability_id.is_empty() {
    return Err(StorageError::Validation("capability_id is required".into()));
  }
  if !capability_id.starts_with("speech.synthesize@") {
    return Err(StorageError::Validation(
      "capability_id must be a speech.synthesize@N capability".into(),
    ));
  }
  if service.preferences_schema_version != GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION {
    return Err(StorageError::Validation(format!(
      "unsupported Speech preferences schema version {}",
      service.preferences_schema_version
    )));
  }
  if service.preferences.is_null() {
    return Err(StorageError::Validation("preferences are required".into()));
  }
  // Reuse the save-path validator: known keys via typed parse + host bounds.
  let typed = parse_speech_synthesize_preferences(&service.preferences).map_err(StorageError::Validation)?;
  validate_speech_synthesize_preferences(&typed).map_err(|e| StorageError::Validation(e.message))?;
  Ok(())
}

/// Ensure default profile/OCR/Speech exist after entities are written (connection-scoped).
pub fn validate_plan_default_profile(conn: &Connection, settings: &AppSettingsV1) -> Result<(), StorageError> {
  validate_default_profile(conn, settings.default_profile_id)?;
  validate_default_ocr_service(conn, settings.default_ocr_service_id)?;
  validate_default_speech_service(conn, settings.default_speech_service_id)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::import_export::EXPORT_FORMAT_VERSION;
  use crate::domain::service_integration::{GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_TRANSLATE_WEB_PLUGIN_ID};
  use crate::domain::time::now_rfc3339;
  use crate::storage::Database;

  fn empty_doc() -> ConfigurationExport {
    ConfigurationExport {
      format_version: EXPORT_FORMAT_VERSION,
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
      plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
      plugin_version: "1.0.0".into(),
      display_name: "Web".into(),
      enabled: true,
      config_json: config_json.into(),
      config_schema_version: 1,
      health_status: "ready".into(),
      runtime: None,
      created_at: now_rfc3339(),
      updated_at: now_rfc3339(),
    }
  }

  fn cloud_export(id: Uuid) -> IntegrationInstanceExport {
    IntegrationInstanceExport {
      id,
      plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
      plugin_version: "1.0.0".into(),
      display_name: "Cloud".into(),
      enabled: true,
      config_json: r#"{"project-id":"demo","location":"global","proxy-mode":"inherit"}"#.into(),
      config_schema_version: 1,
      health_status: "ready".into(),
      runtime: None,
      created_at: now_rfc3339(),
      updated_at: now_rfc3339(),
    }
  }

  #[test]
  fn import_web_gtx_requires_no_auth_and_is_ready() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let web_id = new_id();
    let mut doc = empty_doc();
    doc.integration_instances = vec![web_export(web_id, r#"{"channel":"gtx"}"#)];

    let plan = db
      .read(|conn| build_validated_plan(conn, &doc, ImportConflictMode::Merge))
      .unwrap();
    assert!(plan.preview.valid, "errors: {:?}", plan.preview.validation_errors);
    assert!(plan.preview.integration_requires_authentication.is_empty());
    assert_eq!(plan.integrations.len(), 1);
    assert_eq!(plan.integrations[0].health_status, IntegrationHealthStatus::Ready);
    assert_eq!(plan.integrations[0].plugin_id, GOOGLE_TRANSLATE_WEB_PLUGIN_ID);
    assert!(!plan.integrations[0].config_json.contains("projectId"));
  }

  #[test]
  fn import_web_rejects_unsafe_proxy_url() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let web_id = new_id();
    let mut doc = empty_doc();
    doc.integration_instances = vec![web_export(
      web_id,
      r#"{"channel":"https_proxy","proxy-url":"http://insecure.example/t"}"#,
    )];

    let plan = db
      .read(|conn| build_validated_plan(conn, &doc, ImportConflictMode::Merge))
      .unwrap();
    assert!(!plan.preview.valid);
    assert!(plan.preview.validation_errors.iter().any(|e| e.contains("https")));
    assert!(plan.integrations.is_empty());
  }

  #[test]
  fn import_cloud_requires_auth_and_stays_unconfigured() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let cloud_id = new_id();
    let mut doc = empty_doc();
    doc.integration_instances = vec![cloud_export(cloud_id)];

    let plan = db
      .read(|conn| build_validated_plan(conn, &doc, ImportConflictMode::Merge))
      .unwrap();
    assert!(plan.preview.valid, "errors: {:?}", plan.preview.validation_errors);
    assert_eq!(plan.preview.integration_requires_authentication, vec![cloud_id]);
    assert_eq!(
      plan.integrations[0].health_status,
      IntegrationHealthStatus::Unconfigured
    );
    assert_eq!(plan.integrations[0].plugin_id, GOOGLE_CLOUD_PLUGIN_ID);
  }

  #[test]
  fn import_rejects_mixed_cloud_web_credential_fields() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let web_id = new_id();
    let cloud_id = new_id();
    let mut doc = empty_doc();
    doc.integration_instances = vec![
      web_export(web_id, r#"{"channel":"gtx","projectId":"x"}"#),
      IntegrationInstanceExport {
        id: cloud_id,
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        plugin_version: "1.0.0".into(),
        display_name: "Cloud".into(),
        enabled: true,
        config_json: r#"{"projectId":"demo","location":"global","proxyMode":"inherit","channel":"gtx"}"#.into(),
        config_schema_version: 1,
        health_status: "ready".into(),
        runtime: None,
        created_at: now_rfc3339(),
        updated_at: now_rfc3339(),
      },
    ];

    let plan = db
      .read(|conn| build_validated_plan(conn, &doc, ImportConflictMode::Merge))
      .unwrap();
    assert!(!plan.preview.valid);
    assert!(plan.preview.validation_errors.iter().any(|e| e.contains("projectId")));
    assert!(
      plan
        .preview
        .validation_errors
        .iter()
        .any(|e| e.contains("channel") || e.contains("proxyUrl"))
    );
  }

  #[test]
  fn import_web_proxy_normalizes_url_and_stays_executable() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let web_id = new_id();
    let mut doc = empty_doc();
    doc.integration_instances = vec![web_export(
      web_id,
      r#"{"channel":"https_proxy","proxy-url":"https://googlet.deno.dev/translate?foo=1"}"#,
    )];

    let plan = db
      .read(|conn| build_validated_plan(conn, &doc, ImportConflictMode::Merge))
      .unwrap();
    assert!(plan.preview.valid, "errors: {:?}", plan.preview.validation_errors);
    assert!(plan.preview.integration_requires_authentication.is_empty());
    assert_eq!(plan.integrations[0].health_status, IntegrationHealthStatus::Ready);
    assert!(
      plan.integrations[0]
        .config_json
        .contains("https://googlet.deno.dev/translate")
    );
    assert!(!plan.integrations[0].config_json.contains("foo=1"));
  }

  #[test]
  fn auth_requirement_is_registry_aware() {
    assert!(!integration_plugin_requires_authentication(
      GOOGLE_TRANSLATE_WEB_PLUGIN_ID
    ));
    assert!(integration_plugin_requires_authentication(GOOGLE_CLOUD_PLUGIN_ID));
    assert!(integration_plugin_requires_authentication(
      "com.langnext.unknown-plugin"
    ));
  }

  fn speech_export(id: Uuid, integration_instance_id: Uuid) -> SpeechServiceExport {
    SpeechServiceExport {
      id,
      display_name: "Google Cloud TTS".into(),
      enabled: true,
      sort_order: 0,
      integration_instance_id,
      capability_id: "speech.synthesize@1".into(),
      preferences_schema_version: GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION,
      preferences: crate::domain::speech_service::default_google_tts_preferences(),
      created_at: now_rfc3339(),
      updated_at: now_rfc3339(),
    }
  }

  #[test]
  fn import_speech_service_merge_and_copy_remap_default() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let cloud_id = new_id();
    let speech_id = new_id();
    let mut doc = empty_doc();
    doc.integration_instances = vec![cloud_export(cloud_id)];
    doc.speech_services = vec![speech_export(speech_id, cloud_id)];
    doc.app_settings.default_speech_service_id = Some(speech_id);

    let merge = db
      .read(|conn| build_validated_plan(conn, &doc, ImportConflictMode::Merge))
      .unwrap();
    assert!(merge.preview.valid, "errors: {:?}", merge.preview.validation_errors);
    assert_eq!(merge.preview.counts.speech_services_create, 1);
    assert_eq!(merge.speech_services.len(), 1);
    assert_eq!(merge.speech_services[0].id, speech_id);
    assert_eq!(merge.speech_services[0].integration_instance_id, cloud_id);
    assert_eq!(merge.settings.default_speech_service_id, Some(speech_id));

    let copy = db
      .read(|conn| build_validated_plan(conn, &doc, ImportConflictMode::Copy))
      .unwrap();
    assert!(copy.preview.valid, "errors: {:?}", copy.preview.validation_errors);
    assert_eq!(copy.preview.counts.speech_services_copy, 1);
    assert_eq!(copy.speech_services.len(), 1);
    assert_ne!(copy.speech_services[0].id, speech_id);
    assert_ne!(copy.speech_services[0].integration_instance_id, cloud_id);
    assert_eq!(
      copy.settings.default_speech_service_id,
      Some(copy.speech_services[0].id)
    );
  }

  #[test]
  fn import_speech_rejects_invalid_preferences_and_missing_integration() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let cloud_id = new_id();
    let speech_id = new_id();
    let mut doc = empty_doc();
    doc.integration_instances = vec![cloud_export(cloud_id)];
    let mut service = speech_export(speech_id, cloud_id);
    service.preferences = serde_json::json!({"speakingRate": 99.0, "pitch": 0.0});
    doc.speech_services = vec![service];

    let plan = db
      .read(|conn| build_validated_plan(conn, &doc, ImportConflictMode::Merge))
      .unwrap();
    assert!(!plan.preview.valid);
    assert!(
      plan
        .preview
        .validation_errors
        .iter()
        .any(|e| e.contains("speech service") || e.contains("speaking"))
    );

    let mut missing = empty_doc();
    missing.speech_services = vec![speech_export(new_id(), new_id())];
    let plan = db
      .read(|conn| build_validated_plan(conn, &missing, ImportConflictMode::Merge))
      .unwrap();
    assert!(!plan.preview.valid);
    assert!(
      plan
        .preview
        .validation_errors
        .iter()
        .any(|e| e.contains("missing integration"))
    );
  }

  #[test]
  fn import_speech_rejects_unknown_default_speech_service_id() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let mut doc = empty_doc();
    doc.app_settings.default_speech_service_id = Some(new_id());
    let plan = db
      .read(|conn| build_validated_plan(conn, &doc, ImportConflictMode::Merge))
      .unwrap();
    assert!(!plan.preview.valid);
    assert!(
      plan
        .preview
        .validation_errors
        .iter()
        .any(|e| e.contains("default_speech_service_id"))
    );
  }
}
