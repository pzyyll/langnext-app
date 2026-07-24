// ABOUTME: Normalizes and validates complete configuration import graphs.
// ABOUTME: Preview and apply share one plan; apply revalidates inside the write transaction.
use crate::domain::import_export::{
  ConfigurationExport, EXPORT_FORMAT_VERSION, ImportConflictMode, ImportPreview, ImportPreviewCounts,
  IntegrationInstanceExport,
};
use crate::domain::language_detection::LanguageDetectorConfig;
use crate::domain::model::{CapabilityOverridesV1, ProviderModel};
use crate::domain::provider::{
  CredentialKind, ModelsSyncStatus, ProviderExport, ProviderInstance, validate_adapter_id,
};
use crate::domain::service_integration::{IntegrationHealthStatus, IntegrationInstance};
use crate::domain::settings::{AppSettingsV1, GlobalProxyMode};
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{
  PromptTemplate, TranslationProfile, TranslationProfileEngine, TranslationProfilePromptTemplate,
  TranslationProfileTarget,
};
use crate::error::StorageError;
use crate::repositories::{
  integration_instances, ocr_services, provider_instances, provider_models, translation_profiles,
};
use crate::services::providers::validate_provider_url;
use crate::services::settings::{validate_default_ocr_service, validate_default_profile, validate_settings_document};
use crate::services::translation_profiles::{validate_profile_language_preferences, validate_prompt_templates};
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
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
  pub settings: AppSettingsV1,
  /// Providers that need credential cleanup when merging over existing rows.
  pub provider_cleanup_ids: Vec<Uuid>,
  /// Whether imported settings require clearing the global proxy binding.
  pub clear_global_proxy: bool,
  /// Expected local credential refs for merge ownership CAS (provider_id -> ref).
  pub expected_provider_refs: HashMap<Uuid, Option<String>>,
  pub expected_proxy_ref: Option<String>,
}

/// Build a validated plan using local rows visible on `conn`.
pub fn build_validated_plan(
  conn: &Connection,
  document: &ConfigurationExport,
  mode: ImportConflictMode,
) -> Result<ValidatedImportPlan, StorageError> {
  let mut errors = Vec::new();

  // Documents reaching this path are already normalized to v4.
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
  let local_proxy_ref = crate::repositories::app_credentials::get_global_proxy_ref(conn)?;

  let doc_provider_ids: HashSet<Uuid> = document.providers.iter().map(|p| p.id).collect();
  let doc_model_ids: HashSet<Uuid> = document.models.iter().map(|m| m.id).collect();
  let doc_profile_ids: HashSet<Uuid> = document.translation_profiles.iter().map(|p| p.id).collect();
  let doc_integration_ids: HashSet<Uuid> = document.integration_instances.iter().map(|i| i.id).collect();

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

  // Counts and ID rewriting for copy mode.
  let mut counts = ImportPreviewCounts::default();
  let mut requires_authentication = Vec::new();
  let mut integration_requires_authentication = Vec::new();

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
        // Import never carries credentials; every instance requires re-auth.
        integration_requires_authentication.push(i.id);
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
    }
    ImportConflictMode::Copy => {
      counts.providers_copy = document.providers.len() as u32;
      counts.models_copy = document.models.len() as u32;
      counts.profiles_copy = document.translation_profiles.len() as u32;
      counts.integrations_copy = document.integration_instances.len() as u32;
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
        integration_requires_authentication.push(new_integration_id);
      }
      if let Some(old_default) = settings.default_profile_id {
        if let Some(new_id) = profile_id_map.get(&old_default) {
          settings.default_profile_id = Some(*new_id);
        } else {
          settings.default_profile_id = None;
          default_profile_cleared = true;
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
      settings,
      provider_cleanup_ids: vec![],
      clear_global_proxy: false,
      expected_provider_refs: HashMap::new(),
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

  // OCR services are not part of configuration export; keep only if still local.
  if let Some(oid) = settings.default_ocr_service_id {
    if ocr_services::get(conn, oid).is_err() {
      settings.default_ocr_service_id = None;
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
    integrations.push(integration_from_export(exported, id, created_at, now.clone()));
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
    settings,
    provider_cleanup_ids,
    clear_global_proxy,
    expected_provider_refs,
    expected_proxy_ref: local_proxy_ref,
  })
}

fn integration_from_export(
  exported: &IntegrationInstanceExport,
  id: Uuid,
  created_at: String,
  updated_at: String,
) -> IntegrationInstance {
  // Imported instances always require re-auth: force unconfigured and clear validation stamps.
  IntegrationInstance {
    id,
    plugin_id: exported.plugin_id.clone(),
    plugin_version: exported.plugin_version.clone(),
    display_name: exported.display_name.clone(),
    enabled: exported.enabled,
    config_json: exported.config_json.clone(),
    config_schema_version: exported.config_schema_version,
    health_status: IntegrationHealthStatus::Unconfigured,
    last_validated_at: None,
    last_error_code: None,
    created_at,
    updated_at,
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

/// Ensure default profile exists after entities are written (connection-scoped).
pub fn validate_plan_default_profile(conn: &Connection, settings: &AppSettingsV1) -> Result<(), StorageError> {
  validate_default_profile(conn, settings.default_profile_id)?;
  validate_default_ocr_service(conn, settings.default_ocr_service_id)
}
