// ABOUTME: Normalizes and validates complete configuration import graphs.
// ABOUTME: Preview and apply share one plan; apply revalidates inside the write transaction.
use crate::adapters::catalog;
use crate::domain::import_export::{
  ConfigurationExport, ImportConflictMode, ImportPreview, ImportPreviewCounts, EXPORT_FORMAT_VERSION,
};
use crate::domain::language_detection::LanguageDetectorConfig;
use crate::domain::model::{CapabilityOverridesV1, ProviderModel};
use crate::domain::provider::{CredentialKind, ModelsSyncStatus, ProviderExport, ProviderInstance};
use crate::domain::settings::{AppSettingsV1, GlobalProxyMode};
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{TranslationProfile, TranslationProfileTarget};
use crate::error::StorageError;
use crate::repositories::{provider_instances, provider_models, translation_profiles};
use crate::services::providers::validate_provider_url;
use crate::services::settings::{validate_default_profile, validate_settings_document};
use crate::services::translation_profiles::{validate_profile_language_preferences, validate_template};
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
  let local_proxy_ref = crate::repositories::app_credentials::get_global_proxy_ref(conn)?;

  let doc_provider_ids: HashSet<Uuid> = document.providers.iter().map(|p| p.id).collect();
  let doc_model_ids: HashSet<Uuid> = document.models.iter().map(|m| m.id).collect();
  let doc_profile_ids: HashSet<Uuid> = document.translation_profiles.iter().map(|p| p.id).collect();

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

  // Profiles and targets
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

  for profile in &document.translation_profiles {
    if let Err(e) = validate_import_profile(
      profile,
      targets_by_profile.get(&profile.id).map(|v| v.as_slice()).unwrap_or(&[]),
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

  // Counts and ID rewriting for copy mode.
  let mut counts = ImportPreviewCounts::default();
  let mut requires_authentication = Vec::new();

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

  let preview = ImportPreview {
    valid: errors.is_empty(),
    counts,
    validation_errors: errors.clone(),
    requires_authentication,
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
    providers.push(ProviderInstance {
      id,
      adapter_id: p.adapter_id.clone(),
      display_name: p.display_name.clone(),
      base_url_override: p.base_url_override.clone(),
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
    // Copy mode rewrites the detection LLM model id to the copied model's new id.
    if matches!(mode, ImportConflictMode::Copy) {
      if let Some(LanguageDetectorConfig::Llm {
        model_id: Some(old_model),
      }) = p.language_detection
      {
        let new_model = *model_id_map.get(&old_model).expect("detection model map");
        p.language_detection = Some(LanguageDetectorConfig::Llm {
          model_id: Some(new_model),
        });
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

  Ok(ValidatedImportPlan {
    mode,
    preview,
    providers,
    models,
    profiles,
    targets,
    settings,
    provider_cleanup_ids,
    clear_global_proxy,
    expected_provider_refs,
    expected_proxy_ref: local_proxy_ref,
  })
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
  catalog::get(&p.adapter_id)?;
  if p.display_name.trim().is_empty() {
    return Err(StorageError::Validation("display_name must not be empty".into()));
  }
  if p.display_name.len() > 200 {
    return Err(StorageError::Validation(
      "display_name must be at most 200 characters".into(),
    ));
  }
  if let Some(url) = &p.base_url_override {
    validate_provider_url(url, p.insecure_http_confirmed_at.as_deref())?;
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
    catalog::get(adapter_id)?;
  }
  CapabilityOverridesV1::from_json(&m.capability_overrides_json)?;
  Ok(())
}

fn validate_import_profile(
  profile: &TranslationProfile,
  targets: &[&TranslationProfileTarget],
  doc_model_ids: &HashSet<Uuid>,
) -> Result<(), StorageError> {
  if profile.name.trim().is_empty() {
    return Err(StorageError::Validation("profile name must not be empty".into()));
  }
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
  if let Some(temp) = profile.temperature {
    if temp < 0.0 {
      return Err(StorageError::Validation("temperature must be >= 0".into()));
    }
  }
  if let Some(tokens) = profile.max_output_tokens {
    if tokens <= 0 {
      return Err(StorageError::Validation("max_output_tokens must be > 0".into()));
    }
  }
  validate_template(&profile.system_template, false)?;
  validate_template(&profile.user_template, true)?;
  catalog::validate_profile_options("openai-compatible", &profile.provider_options_json)?;
  validate_profile_language_preferences(&profile.primary_lang, &profile.preferred_target_lang)?;
  // A configured LLM detector must reference a model present in the import document.
  if let Some(LanguageDetectorConfig::Llm {
    model_id: Some(model_id),
  }) = profile.language_detection
  {
    if !doc_model_ids.contains(&model_id) {
      return Err(StorageError::Validation(format!(
        "language detection references missing model {model_id}"
      )));
    }
  }
  Ok(())
}

/// Ensure default profile exists after entities are written (connection-scoped).
pub fn validate_plan_default_profile(conn: &Connection, settings: &AppSettingsV1) -> Result<(), StorageError> {
  validate_default_profile(conn, settings.default_profile_id)
}
