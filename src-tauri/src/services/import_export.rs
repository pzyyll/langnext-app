// ABOUTME: Versioned secret-free JSON import/export with preview, merge, and copy modes.
// ABOUTME: Imports run in one SQLite transaction; credentials are cleared and re-auth is required.
use crate::credentials::CredentialVault;
use crate::credentials::coordinator;
use crate::domain::import_export::{
  ConfigurationExport, EXPORT_FORMAT_VERSION, ImportConflictMode, ImportPreview, ImportResult,
  IntegrationInstanceExport, OcrPromptTemplateExport, OcrServiceExport, SpeechServiceExport,
  export_json_contains_forbidden_secret_keys, parse_and_normalize_export_document,
};
// EXPORT_FORMAT_VERSION is also used by validate_v7_runtime_records.
use crate::domain::ocr_service::{OcrPromptTemplate, OcrProviderType, OcrService};
use crate::domain::provider::ProviderExport;
use crate::domain::runtime_plugin::PluginManifestV1;
use crate::domain::runtime_provider::{
  ProviderRuntimeBinding, ProviderRuntimeKind, ProviderRuntimeRequirementExport, ProviderRuntimeState,
  legacy_frontend_binding,
};
use crate::domain::speech_service::SpeechService;
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::credential_operations::{self, CredentialOperation, OwnerKind};
use crate::repositories::{
  app_credentials, app_settings, installed_plugin_versions, integration_instances, ocr_prompt_templates, ocr_services,
  provider_instances, provider_models, provider_runtime_bindings, speech_services, translation_profiles,
};
use crate::services::import_validation::{self, ValidatedImportPlan};
use crate::services::runtime_plugin_contracts::parse_manifest;
use crate::services::runtime_providers::release_grant_after_removal;
use crate::storage::Database;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct ImportExportService {
  db: Database,
  vault: Arc<dyn CredentialVault>,
}

impl ImportExportService {
  pub fn new(db: Database, vault: Arc<dyn CredentialVault>) -> Self {
    Self { db, vault }
  }

  pub fn export(&self) -> Result<ConfigurationExport, StorageError> {
    self.db.read_snapshot(|conn| {
      let models = provider_models::list_all(conn)?;
      let translation_profiles = translation_profiles::list(conn)?;
      let profile_models = translation_profiles::list_all_targets(conn)?;
      let profile_prompt_templates = translation_profiles::list_all_prompt_templates(conn)?;
      let integrations = integration_instances::list(conn)?;
      let ocr_service_rows = ocr_services::list(conn)?;
      let ocr_template_rows = ocr_prompt_templates::list_all(conn)?;
      let speech_service_rows = speech_services::list(conn)?;
      let app_settings = app_settings::get(conn)?;

      let provider_rows = provider_instances::list_with_runtime(conn)?;
      let mut provider_exports: Vec<ProviderExport> = provider_rows
        .iter()
        .map(|(provider, bindings)| {
          let mut export = ProviderExport::from(provider);
          let mut requirements = bindings
            .iter()
            .map(|binding| provider_runtime_requirement(conn, binding))
            .collect::<Result<Vec<_>, StorageError>>()?;
          requirements.sort_by(|a, b| {
            a.adapter_id
              .as_deref()
              .cmp(&b.adapter_id.as_deref())
              .then_with(|| a.runtime_kind.cmp(&b.runtime_kind))
          });
          export.runtime_bindings = requirements;
          Ok(export)
        })
        .collect::<Result<Vec<_>, StorageError>>()?;
      provider_exports.sort_by_key(|p| p.id);

      let mut models = models;
      models.sort_by_key(|m| (m.provider_instance_id, m.model_key.clone(), m.id));

      let mut profiles = translation_profiles;
      profiles.sort_by_key(|p| p.id);

      let mut targets = profile_models;
      targets.sort_by_key(|t| (t.translation_profile_id, t.priority, t.provider_model_id));

      let mut templates = profile_prompt_templates;
      templates.sort_by_key(|t| (t.translation_profile_id, t.sort_order, t.id));

      let mut integration_exports = Vec::with_capacity(integrations.len());
      for i in integrations {
        // v7 requires an explicit runtime record per integration. Never silently drop fields.
        let runtime = match i.runtime_requirement_json.as_deref() {
          Some(raw) => {
            let parsed: crate::domain::runtime_lifecycle::RuntimeRequirementExport = serde_json::from_str(raw)
              .map_err(|e| {
                StorageError::Validation(format!(
                  "integration {} has invalid runtime_requirement_json: {e}",
                  i.id
                ))
              })?;
            validate_export_requirement_for_instance(&i, parsed)?
          }
          None => rebuild_export_requirement_from_pin(conn, &i)?,
        };
        let runtime = validate_export_requirement_for_instance(&i, runtime)?;
        integration_exports.push(IntegrationInstanceExport {
          id: i.id,
          plugin_id: i.plugin_id,
          plugin_version: i.plugin_version,
          display_name: i.display_name,
          enabled: i.enabled,
          config_json: i.config_json,
          config_schema_version: i.config_schema_version,
          health_status: i.health_status.as_str().to_string(),
          runtime: Some(runtime),
          created_at: i.created_at,
          updated_at: i.updated_at,
        });
      }
      integration_exports.sort_by_key(|i| i.id);

      let mut ocr_exports: Vec<OcrServiceExport> = ocr_service_rows.into_iter().map(ocr_service_to_export).collect();
      ocr_exports.sort_by_key(|s| (s.sort_order, s.id));

      let mut ocr_prompt_exports: Vec<OcrPromptTemplateExport> = ocr_template_rows
        .into_iter()
        .map(|row| OcrPromptTemplateExport {
          id: row.id,
          ocr_service_id: row.ocr_service_id,
          name: row.name,
          system_template: row.system_template,
          user_template: row.user_template,
          sort_order: row.sort_order,
        })
        .collect();
      ocr_prompt_exports.sort_by_key(|t| (t.ocr_service_id, t.sort_order, t.id));

      let mut speech_exports: Vec<SpeechServiceExport> =
        speech_service_rows.into_iter().map(speech_service_to_export).collect();
      speech_exports.sort_by_key(|s| (s.sort_order, s.id));

      let doc = ConfigurationExport {
        format_version: EXPORT_FORMAT_VERSION,
        exported_at: now_rfc3339(),
        providers: provider_exports,
        models,
        translation_profiles: profiles,
        profile_models: targets,
        profile_prompt_templates: templates,
        integration_instances: integration_exports,
        ocr_services: ocr_exports,
        ocr_prompt_templates: ocr_prompt_exports,
        speech_services: speech_exports,
        app_settings,
      };

      // Fail closed if serialization ever includes secret/ref field names.
      let json = serde_json::to_string(&doc)?;
      let forbidden = export_json_contains_forbidden_secret_keys(&json);
      if !forbidden.is_empty() {
        return Err(StorageError::Validation(format!(
          "export document contains forbidden secret keys: {}",
          forbidden.join(", ")
        )));
      }

      Ok(doc)
    })
  }

  /// Preview import from an untrusted JSON value (formatVersion parsed first, then normalized).
  pub fn preview_raw(
    &self,
    document: serde_json::Value,
    mode: ImportConflictMode,
  ) -> Result<ImportPreview, StorageError> {
    let normalized = parse_and_normalize_export_document(document).map_err(StorageError::Validation)?;
    self.preview(&normalized, mode)
  }

  pub fn preview(
    &self,
    document: &ConfigurationExport,
    mode: ImportConflictMode,
  ) -> Result<ImportPreview, StorageError> {
    self.db.read_snapshot(|conn| {
      let plan = import_validation::build_validated_plan(conn, document, mode)?;
      Ok(plan.preview)
    })
  }

  /// Import from an untrusted JSON value (formatVersion parsed first, then normalized).
  pub fn import_raw(
    &self,
    document: serde_json::Value,
    mode: ImportConflictMode,
  ) -> Result<ImportResult, StorageError> {
    let normalized = parse_and_normalize_export_document(document).map_err(StorageError::Validation)?;
    self.import(normalized, mode)
  }

  pub fn import(&self, document: ConfigurationExport, mode: ImportConflictMode) -> Result<ImportResult, StorageError> {
    // Recover affected owners before busy checks.
    self.recover_affected_owners(&document, mode)?;

    let (preview, applied, cleanup_ops) = self.db.transaction(|uow| {
      let conn = uow.conn();
      let plan = import_validation::build_validated_plan(conn, &document, mode)?;
      if !plan.preview.valid {
        return Ok((plan.preview, false, Vec::new()));
      }

      // Busy check inside the write transaction against current journals.
      self.ensure_no_credential_busy_on_conn(conn, &plan)?;

      let cleanup_ops = self.apply_plan(conn, &plan)?;
      Ok((plan.preview.clone(), true, cleanup_ops))
    })?;

    if applied {
      for op in cleanup_ops {
        // Failed cleanup retains the exact import-owned journal.
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
      }
    }

    Ok(ImportResult { preview, applied })
  }

  fn recover_affected_owners(
    &self,
    document: &ConfigurationExport,
    mode: ImportConflictMode,
  ) -> Result<(), StorageError> {
    coordinator::preflight_owner(&self.db, self.vault.as_ref(), OwnerKind::GlobalProxy, "global")?;
    if mode == ImportConflictMode::Merge {
      for p in &document.providers {
        coordinator::preflight_owner(&self.db, self.vault.as_ref(), OwnerKind::Provider, &p.id.to_string())?;
      }
      for service in &document.ocr_services {
        if service.provider_type == OcrProviderType::Baidu {
          coordinator::preflight_owner(
            &self.db,
            self.vault.as_ref(),
            OwnerKind::OcrApiKey,
            &service.id.to_string(),
          )?;
          coordinator::preflight_owner(
            &self.db,
            self.vault.as_ref(),
            OwnerKind::OcrSecretKey,
            &service.id.to_string(),
          )?;
        }
      }
    }
    Ok(())
  }

  fn ensure_no_credential_busy_on_conn(
    &self,
    conn: &rusqlite::Connection,
    plan: &ValidatedImportPlan,
  ) -> Result<(), StorageError> {
    if credential_operations::get_for_owner(conn, OwnerKind::GlobalProxy, "global")?.is_some() {
      return Err(StorageError::CredentialBusy);
    }
    if plan.mode == ImportConflictMode::Merge {
      for p in &plan.providers {
        if credential_operations::get_for_owner(conn, OwnerKind::Provider, &p.id.to_string())?.is_some() {
          return Err(StorageError::CredentialBusy);
        }
      }
      for service in &plan.ocr_services {
        if service.provider_type == OcrProviderType::Baidu {
          if credential_operations::get_for_owner(conn, OwnerKind::OcrApiKey, &service.id.to_string())?.is_some()
            || credential_operations::get_for_owner(conn, OwnerKind::OcrSecretKey, &service.id.to_string())?.is_some()
          {
            return Err(StorageError::CredentialBusy);
          }
        }
      }
    }
    Ok(())
  }

  fn apply_plan(
    &self,
    conn: &rusqlite::Connection,
    plan: &ValidatedImportPlan,
  ) -> Result<Vec<CredentialOperation>, StorageError> {
    let mut cleanup_ops = Vec::new();

    // Integrations first so plugin profiles/OCR can bind via FK.
    for instance in &plan.integrations {
      if integration_instances::get(conn, instance.id).is_ok() {
        // Merge: update structural config; leave credential bindings empty/unchanged (never imported).
        integration_instances::compare_and_set(
          conn,
          instance.id,
          // Use current updated_at if present; fall back to imported stamp.
          &integration_instances::get(conn, instance.id)?.updated_at,
          &instance.display_name,
          instance.enabled,
          &instance.config_json,
          instance.config_schema_version,
          instance.health_status,
          instance.last_validated_at.as_deref(),
          instance.last_error_code.as_deref(),
          &instance.updated_at,
        )?;
      } else {
        integration_instances::insert(conn, instance)?;
      }
    }

    // Providers
    for p in &plan.providers {
      if provider_instances::get(conn, p.id).is_ok() {
        // Merge overwrite: clear credential via CAS against expected ref.
        let expected = plan.expected_provider_refs.get(&p.id).cloned().unwrap_or(None);
        if let Some(old_ref) = expected.clone() {
          let op = credential_operations::insert_db_committed(
            conn,
            new_id(),
            OwnerKind::Provider,
            &p.id.to_string(),
            Some(&old_ref),
            None,
          )?;
          provider_instances::compare_and_set_credential_ref(conn, p.id, Some(&old_ref), None, &p.updated_at)?;
          cleanup_ops.push(op);
        }
        provider_instances::update_configuration(conn, p)?;
      } else {
        provider_instances::insert(conn, p)?;
      }
    }

    // Provider runtime bindings: restore exact requirements as unavailable metadata without
    // downloading, instantiating, granting, default-binding, or activating any package. The
    // imported document is the Provider's COMPLETE runtime interface collection: local
    // bindings the document omits are removed, and every replaced or removed binding's grant
    // is released reference-aware (kept while an active alias row or an undiscarded rollback
    // snapshot still references it). The document always declares the Provider default API
    // type, so the per-interface read invariant survives the reconciliation.
    let now = now_rfc3339();
    for (provider_id, requirements) in &plan.provider_runtime_requirements {
      let default_adapter = plan
        .providers
        .iter()
        .find(|provider| provider.id == *provider_id)
        .map(|provider| provider.adapter_id.clone())
        .ok_or_else(|| {
          StorageError::Validation(format!(
            "provider {provider_id} runtime requirements have no provider row"
          ))
        })?;
      // Capture the pre-import binding identities BEFORE the upserts so replaced rows can
      // release their exact Provider/package grant once the collection is reconciled.
      let preexisting = provider_runtime_bindings::list_by_provider(conn, *provider_id)?;
      let mut declared_adapters = HashSet::new();
      for requirement in requirements {
        let adapter_id = requirement
          .adapter_id
          .as_deref()
          .map(str::trim)
          .filter(|s| !s.is_empty())
          .unwrap_or(&default_adapter)
          .to_string();
        declared_adapters.insert(adapter_id.clone());
        upsert_provider_runtime_binding(conn, *provider_id, &adapter_id, requirement, &now)?;
      }
      // Collection reconciliation: removed adapters are deleted, and any pre-existing
      // identity the same adapter no longer carries (replaced package/revision) has its
      // grant released. Import always restores unavailable metadata without a grant, so a
      // previously granted revision is unreferenced by the binding row after an upsert;
      // reference-aware release keeps it while an active alias row or an undiscarded
      // rollback snapshot still references the exact package/revision.
      let current = provider_runtime_bindings::list_by_provider(conn, *provider_id)?;
      for binding in &preexisting {
        if !declared_adapters.contains(&binding.adapter_id) {
          provider_runtime_bindings::delete(conn, *provider_id, &binding.adapter_id)?;
          release_grant_after_removal(conn, *provider_id, binding)?;
        } else if let Some(replacement) = current.iter().find(|b| b.adapter_id == binding.adapter_id) {
          if binding_identity_changed(binding, replacement) {
            release_grant_after_removal(conn, *provider_id, binding)?;
          }
        }
      }
    }

    // Models
    for m in &plan.models {
      if provider_models::get(conn, m.id).is_ok() {
        provider_models::update(conn, m)?;
      } else {
        provider_models::insert(conn, m)?;
      }
    }

    // Profiles with targets + prompt templates grouped
    let mut targets_by_profile: HashMap<Uuid, Vec<_>> = HashMap::new();
    for t in &plan.targets {
      targets_by_profile
        .entry(t.translation_profile_id)
        .or_default()
        .push(t.clone());
    }
    let mut templates_by_profile: HashMap<Uuid, Vec<_>> = HashMap::new();
    for t in &plan.prompt_templates {
      templates_by_profile.entry(t.translation_profile_id).or_default().push(
        crate::domain::translation_profile::PromptTemplate {
          id: t.id,
          name: t.name.clone(),
          system_template: t.system_template.clone(),
          user_template: t.user_template.clone(),
        },
      );
    }
    for profile in &plan.profiles {
      let targets = targets_by_profile.remove(&profile.id).unwrap_or_default();
      let prompt_templates = templates_by_profile.remove(&profile.id).unwrap_or_default();
      let is_new = translation_profiles::get(conn, profile.id).is_err();
      translation_profiles::save_with_targets(conn, profile, &targets, &prompt_templates, is_new)?;
    }

    // OCR services + templates (after models/integrations so FKs resolve).
    let mut ocr_templates_by_service: HashMap<Uuid, Vec<(i32, OcrPromptTemplate)>> = HashMap::new();
    for template in &plan.ocr_prompt_templates {
      ocr_templates_by_service
        .entry(template.ocr_service_id)
        .or_default()
        .push((
          template.sort_order,
          OcrPromptTemplate {
            id: template.id,
            name: template.name.clone(),
            system_template: template.system_template.clone(),
            user_template: template.user_template.clone(),
          },
        ));
    }
    for templates in ocr_templates_by_service.values_mut() {
      templates.sort_by_key(|(sort_order, template)| (*sort_order, template.id));
    }
    for service in &plan.ocr_services {
      let templates: Vec<OcrPromptTemplate> = ocr_templates_by_service
        .remove(&service.id)
        .unwrap_or_default()
        .into_iter()
        .map(|(_, template)| template)
        .collect();
      if ocr_services::get(conn, service.id).is_ok() {
        // Merge: clear Baidu credentials, then rewrite configuration fields.
        let expected_api = plan.expected_ocr_api_key_refs.get(&service.id).cloned().unwrap_or(None);
        let expected_secret = plan
          .expected_ocr_secret_key_refs
          .get(&service.id)
          .cloned()
          .unwrap_or(None);
        if let Some(old_ref) = expected_api.clone() {
          let op = credential_operations::insert_db_committed(
            conn,
            new_id(),
            OwnerKind::OcrApiKey,
            &service.id.to_string(),
            Some(&old_ref),
            None,
          )?;
          ocr_services::compare_and_set_api_key_ref(conn, service.id, Some(&old_ref), None, &service.updated_at)?;
          cleanup_ops.push(op);
        }
        if let Some(old_ref) = expected_secret.clone() {
          let op = credential_operations::insert_db_committed(
            conn,
            new_id(),
            OwnerKind::OcrSecretKey,
            &service.id.to_string(),
            Some(&old_ref),
            None,
          )?;
          ocr_services::compare_and_set_secret_key_ref(conn, service.id, Some(&old_ref), None, &service.updated_at)?;
          cleanup_ops.push(op);
        }
        match service.provider_type {
          OcrProviderType::Baidu | OcrProviderType::Ai => {
            ocr_services::update_configuration_keep_credentials(
              conn,
              service.id,
              &service.display_name,
              service.enabled,
              service.baidu_action,
              service.provider_model_id,
              service.temperature,
              service.default_prompt_template_id,
              &service.updated_at,
            )?;
          }
          OcrProviderType::PluginCapability => {
            let integration_instance_id = service.integration_instance_id.ok_or_else(|| {
              StorageError::Validation(format!("ocr service {} missing integration_instance_id", service.id))
            })?;
            let ocr_capability_id = service.ocr_capability_id.as_deref().ok_or_else(|| {
              StorageError::Validation(format!("ocr service {} missing ocr_capability_id", service.id))
            })?;
            let prefs_version = service.capability_preferences_version.ok_or_else(|| {
              StorageError::Validation(format!(
                "ocr service {} missing capability_preferences_version",
                service.id
              ))
            })?;
            let prefs = service.capability_preferences.as_ref().ok_or_else(|| {
              StorageError::Validation(format!("ocr service {} missing capability_preferences", service.id))
            })?;
            ocr_services::update_plugin_configuration(
              conn,
              service.id,
              &service.display_name,
              service.enabled,
              integration_instance_id,
              ocr_capability_id,
              prefs_version,
              prefs,
              &service.updated_at,
            )?;
          }
        }
        if service.provider_type == OcrProviderType::Ai {
          ocr_prompt_templates::replace_for_service(conn, service.id, &templates)?;
        } else {
          ocr_prompt_templates::replace_for_service(conn, service.id, &[])?;
        }
      } else {
        ocr_services::insert(conn, service)?;
        if service.provider_type == OcrProviderType::Ai {
          ocr_prompt_templates::replace_for_service(conn, service.id, &templates)?;
        }
      }
    }

    // Speech services (after integrations so FKs resolve; no secrets to clear).
    for service in &plan.speech_services {
      if speech_services::get(conn, service.id).is_ok() {
        speech_services::update_configuration(
          conn,
          service.id,
          &service.display_name,
          service.enabled,
          service.integration_instance_id,
          &service.capability_id,
          service.preferences_schema_version,
          &service.preferences,
          &service.updated_at,
        )?;
      } else {
        speech_services::insert(conn, service)?;
      }
    }

    // Settings + optional global proxy clear
    if plan.clear_global_proxy {
      if let Some(old_ref) = plan.expected_proxy_ref.clone() {
        let op = credential_operations::insert_db_committed(
          conn,
          new_id(),
          OwnerKind::GlobalProxy,
          "global",
          Some(&old_ref),
          None,
        )?;
        app_credentials::compare_and_set_global_proxy_ref(conn, Some(&old_ref), None)?;
        cleanup_ops.push(op);
      }
    }

    import_validation::validate_plan_default_profile(conn, &plan.settings)?;
    app_settings::update(conn, &plan.settings)?;
    Ok(cleanup_ops)
  }
}

/// Build the exact non-secret provider runtime requirement for export. Legacy bindings
/// normalize to `legacy-frontend-provider`; package bindings preserve exact identity from the
/// installed manifest (or from the persisted unresolved requirement when the package is absent).
fn provider_runtime_requirement(
  conn: &rusqlite::Connection,
  binding: &ProviderRuntimeBinding,
) -> Result<ProviderRuntimeRequirementExport, StorageError> {
  let mut requirement = provider_runtime_requirement_identity(conn, binding)?;
  requirement.adapter_id = Some(binding.adapter_id.clone());
  Ok(requirement)
}

/// Build the exact non-secret provider runtime requirement identity for export from one
/// adapter-keyed binding. Legacy bindings normalize to `legacy-frontend-provider`; package
/// bindings preserve exact identity from the installed manifest (or from the persisted
/// unresolved requirement when the package is absent).
fn provider_runtime_requirement_identity(
  conn: &rusqlite::Connection,
  binding: &ProviderRuntimeBinding,
) -> Result<ProviderRuntimeRequirementExport, StorageError> {
  match binding.runtime_kind {
    ProviderRuntimeKind::LegacyFrontendProvider => Ok(ProviderRuntimeRequirementExport::legacy()),
    ProviderRuntimeKind::WasmComponent => {
      // Preserve the exact previously imported/restored requirement when the package is absent.
      if let Some(raw) = binding.runtime_requirement_json.as_deref() {
        let parsed: ProviderRuntimeRequirementExport = serde_json::from_str(raw).map_err(|e| {
          StorageError::Validation(format!(
            "provider {} has invalid runtime_requirement_json: {e}",
            binding.provider_id
          ))
        })?;
        if !parsed.is_legacy() && parsed.package_digest.as_deref() == binding.package_digest.as_deref() {
          return Ok(parsed);
        }
      }
      let digest = binding.package_digest.as_deref().ok_or_else(|| {
        StorageError::Validation(format!(
          "provider {} wasm binding is missing its package digest",
          binding.provider_id
        ))
      })?;
      let version = installed_plugin_versions::get(conn, digest)?;
      let manifest: PluginManifestV1 = parse_manifest(&version.manifest_json).map_err(|e| {
        StorageError::Validation(format!("provider runtime package {} manifest: {e}", version.plugin_id))
      })?;
      let declaration = manifest.provider_runtime.as_ref().ok_or_else(|| {
        StorageError::Validation(format!(
          "provider runtime package {} has no providerRuntime declaration",
          manifest.id
        ))
      })?;
      let mut capabilities: Vec<String> = declaration.capabilities.keys().cloned().collect();
      capabilities.sort();
      Ok(ProviderRuntimeRequirementExport {
        adapter_id: None,
        runtime_kind: "wasm-component".into(),
        package_digest: Some(digest.to_string()),
        plugin_id: Some(version.plugin_id),
        plugin_version: Some(version.version),
        publisher_key_id: Some(version.publisher_key_id),
        publisher_key_fingerprint: Some(version.publisher_fingerprint),
        plugin_api_version: Some(manifest.plugin_api_version),
        legacy_aliases: declaration.legacy_aliases.clone(),
        capabilities,
      })
    }
  }
}

/// Upsert the adapter-keyed provider runtime binding from an imported requirement. Package
/// requirements are restored as `unavailable` metadata: no download, instantiation, migration,
/// grant, default bind, or activation happens during import (recovery is an explicit lifecycle
/// action). A missing `adapter_id` falls back to the Provider default API type (resolved by
/// the caller).
fn upsert_provider_runtime_binding(
  conn: &rusqlite::Connection,
  provider_id: Uuid,
  adapter_id: &str,
  requirement: &ProviderRuntimeRequirementExport,
  now: &str,
) -> Result<(), StorageError> {
  let existing = provider_runtime_bindings::get_optional(conn, provider_id, adapter_id)?;
  let created_at = existing
    .as_ref()
    .map(|binding| binding.created_at.clone())
    .unwrap_or_else(|| now.to_string());
  let mut binding = if requirement.is_legacy() {
    legacy_frontend_binding(provider_id, adapter_id, now)
  } else {
    ProviderRuntimeBinding {
      provider_id,
      adapter_id: adapter_id.to_string(),
      runtime_kind: ProviderRuntimeKind::WasmComponent,
      package_digest: requirement.package_digest.clone(),
      grant_set_revision: None,
      state: ProviderRuntimeState::Unavailable,
      error_code: Some("plugin_unavailable".into()),
      error_message: Some("provider runtime package is not installed or approved".into()),
      runtime_requirement_json: Some(serde_json::to_string(requirement).map_err(StorageError::from)?),
      created_at: created_at.clone(),
      updated_at: now.to_string(),
    }
  };
  binding.created_at = created_at;
  match existing {
    Some(_) => provider_runtime_bindings::update(conn, &binding),
    None => provider_runtime_bindings::insert(conn, &binding),
  }
}

/// True when an imported upsert replaced the binding's package/revision identity: the old
/// identity's Provider/package grant, if any, is no longer carried by the adapter's row and
/// must be released reference-aware after the collection reconciliation.
fn binding_identity_changed(old: &ProviderRuntimeBinding, current: &ProviderRuntimeBinding) -> bool {
  old.package_digest != current.package_digest || old.grant_set_revision != current.grant_set_revision
}

fn non_empty(value: Option<&str>) -> bool {
  value.map(str::trim).filter(|v| !v.is_empty()).is_some()
}

fn validate_export_requirement_for_instance(
  instance: &crate::domain::service_integration::IntegrationInstance,
  req: crate::domain::runtime_lifecycle::RuntimeRequirementExport,
) -> Result<crate::domain::runtime_lifecycle::RuntimeRequirementExport, StorageError> {
  if req.plugin_id != instance.plugin_id {
    return Err(StorageError::Validation(format!(
      "runtime requirement plugin_id does not match instance {}",
      instance.id
    )));
  }
  if req.plugin_version != instance.plugin_version {
    return Err(StorageError::Validation(format!(
      "runtime requirement plugin_version does not match instance {}",
      instance.id
    )));
  }
  if req.runtime_kind != instance.runtime_kind {
    return Err(StorageError::Validation(format!(
      "runtime requirement runtime_kind does not match instance {}",
      instance.id
    )));
  }
  if req.config_schema_version != instance.config_schema_version {
    return Err(StorageError::Validation(format!(
      "runtime requirement config_schema_version does not match instance {}",
      instance.id
    )));
  }
  match req.runtime_kind.as_str() {
    "wasm-component" | "trusted-native-worker" => {
      if !non_empty(req.package_digest.as_deref()) {
        return Err(StorageError::Validation(
          "package-backed runtime requirement missing package digest".into(),
        ));
      }
      if req.package_digest.as_deref() != instance.package_digest.as_deref() {
        return Err(StorageError::Validation(
          "runtime requirement package digest does not match instance pin".into(),
        ));
      }
      if !non_empty(req.publisher_key_id.as_deref()) {
        return Err(StorageError::Validation(
          "package-backed runtime requirement missing publisher key id".into(),
        ));
      }
      if !non_empty(req.publisher_key_fingerprint.as_deref()) {
        return Err(StorageError::Validation(
          "package-backed runtime requirement missing publisher fingerprint".into(),
        ));
      }
      if !non_empty(req.plugin_api_version.as_deref()) {
        return Err(StorageError::Validation(
          "package-backed runtime requirement missing plugin api version".into(),
        ));
      }
    }
    "bundled-rust" => {
      if req.package_digest.is_some() {
        return Err(StorageError::Validation(
          "bundled-rust runtime requirement must not carry a package digest".into(),
        ));
      }
    }
    _ => {}
  }
  Ok(req)
}

/// Strict current-format (v8) document validation used on import parse (after sequential
/// normalization): integration runtime records plus adapter-keyed provider runtime bindings.
pub fn validate_v7_runtime_records(doc: &ConfigurationExport) -> Result<(), StorageError> {
  if doc.format_version != EXPORT_FORMAT_VERSION {
    return Err(StorageError::Validation(format!(
      "validate_v7_runtime_records expects formatVersion {EXPORT_FORMAT_VERSION}"
    )));
  }
  crate::domain::import_export::validate_current_format_runtime_records(doc).map_err(StorageError::Validation)
}

fn rebuild_export_requirement_from_pin(
  conn: &rusqlite::Connection,
  instance: &crate::domain::service_integration::IntegrationInstance,
) -> Result<crate::domain::runtime_lifecycle::RuntimeRequirementExport, StorageError> {
  if instance.runtime_kind == "bundled-rust" || instance.package_digest.is_none() {
    return Ok(crate::domain::runtime_lifecycle::RuntimeRequirementExport {
      plugin_id: instance.plugin_id.clone(),
      plugin_version: instance.plugin_version.clone(),
      runtime_kind: instance.runtime_kind.clone(),
      package_digest: None,
      publisher_key_id: None,
      publisher_key_fingerprint: None,
      plugin_api_version: None,
      config_schema_version: instance.config_schema_version,
      required_capability_majors: Vec::new(),
      provider_runtime_kind: None,
      provider_package_digest: None,
    });
  }
  let digest = instance
    .package_digest
    .as_deref()
    .ok_or_else(|| StorageError::Validation("package-backed pin missing digest".into()))?;
  let version = crate::repositories::installed_plugin_versions::get_optional(conn, digest)?.ok_or_else(|| {
    StorageError::PluginUnavailable(format!(
      "cannot rebuild export requirement; package {digest} is not installed"
    ))
  })?;
  let manifest: crate::domain::runtime_plugin::PluginManifestV1 = serde_json::from_str(&version.manifest_json)
    .map_err(|e| StorageError::Validation(format!("invalid installed package manifest: {e}")))?;
  if version.publisher_key_id.trim().is_empty() || version.publisher_fingerprint.trim().is_empty() {
    return Err(StorageError::Validation(
      "installed package missing publisher identity for export".into(),
    ));
  }
  Ok(crate::domain::runtime_lifecycle::RuntimeRequirementExport {
    plugin_id: version.plugin_id,
    plugin_version: version.version,
    runtime_kind: version.runtime_kind,
    package_digest: Some(version.package_digest),
    publisher_key_id: Some(version.publisher_key_id),
    publisher_key_fingerprint: Some(version.publisher_fingerprint),
    plugin_api_version: Some(manifest.plugin_api_version),
    config_schema_version: instance.config_schema_version,
    required_capability_majors: manifest.capabilities.into_iter().map(|c| c.id).collect(),
    provider_runtime_kind: None,
    provider_package_digest: None,
  })
}

fn ocr_service_to_export(service: OcrService) -> OcrServiceExport {
  OcrServiceExport {
    id: service.id,
    provider_type: service.provider_type,
    display_name: service.display_name,
    enabled: service.enabled,
    sort_order: service.sort_order,
    baidu_action: service.baidu_action,
    provider_model_id: service.provider_model_id,
    temperature: service.temperature,
    default_prompt_template_id: service.default_prompt_template_id,
    integration_instance_id: service.integration_instance_id,
    ocr_capability_id: service.ocr_capability_id,
    capability_preferences_version: service.capability_preferences_version,
    capability_preferences: service.capability_preferences,
    created_at: service.created_at,
    updated_at: service.updated_at,
  }
}

fn speech_service_to_export(service: SpeechService) -> SpeechServiceExport {
  SpeechServiceExport {
    id: service.id,
    display_name: service.display_name,
    enabled: service.enabled,
    sort_order: service.sort_order,
    integration_instance_id: service.integration_instance_id,
    capability_id: service.capability_id,
    preferences_schema_version: service.preferences_schema_version,
    preferences: service.preferences,
    created_at: service.created_at,
    updated_at: service.updated_at,
  }
}
