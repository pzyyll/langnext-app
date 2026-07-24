// ABOUTME: Versioned secret-free JSON import/export with preview, merge, and copy modes.
// ABOUTME: Imports run in one SQLite transaction; credentials are cleared and re-auth is required.
use crate::credentials::CredentialVault;
use crate::credentials::coordinator;
use crate::domain::import_export::{
  ConfigurationExport, EXPORT_FORMAT_VERSION, ImportConflictMode, ImportPreview, ImportResult,
  IntegrationInstanceExport, export_json_contains_forbidden_secret_keys, parse_and_normalize_export_document,
};
use crate::domain::provider::ProviderExport;
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::credential_operations::{self, CredentialOperation, OwnerKind};
use crate::repositories::{
  app_credentials, app_settings, integration_instances, provider_instances, provider_models, translation_profiles,
};
use crate::services::import_validation::{self, ValidatedImportPlan};
use crate::storage::Database;
use std::collections::HashMap;
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
      let providers = provider_instances::list(conn)?;
      let models = provider_models::list_all(conn)?;
      let translation_profiles = translation_profiles::list(conn)?;
      let profile_models = translation_profiles::list_all_targets(conn)?;
      let profile_prompt_templates = translation_profiles::list_all_prompt_templates(conn)?;
      let integrations = integration_instances::list(conn)?;
      let app_settings = app_settings::get(conn)?;

      let mut provider_exports: Vec<ProviderExport> = providers.iter().map(ProviderExport::from).collect();
      provider_exports.sort_by_key(|p| p.id);

      let mut models = models;
      models.sort_by_key(|m| (m.provider_instance_id, m.model_key.clone(), m.id));

      let mut profiles = translation_profiles;
      profiles.sort_by_key(|p| p.id);

      let mut targets = profile_models;
      targets.sort_by_key(|t| (t.translation_profile_id, t.priority, t.provider_model_id));

      let mut templates = profile_prompt_templates;
      templates.sort_by_key(|t| (t.translation_profile_id, t.sort_order, t.id));

      let mut integration_exports: Vec<IntegrationInstanceExport> = integrations
        .into_iter()
        .map(|i| IntegrationInstanceExport {
          id: i.id,
          plugin_id: i.plugin_id,
          plugin_version: i.plugin_version,
          display_name: i.display_name,
          enabled: i.enabled,
          config_json: i.config_json,
          config_schema_version: i.config_schema_version,
          health_status: i.health_status.as_str().to_string(),
          created_at: i.created_at,
          updated_at: i.updated_at,
        })
        .collect();
      integration_exports.sort_by_key(|i| i.id);

      let doc = ConfigurationExport {
        format_version: EXPORT_FORMAT_VERSION,
        exported_at: now_rfc3339(),
        providers: provider_exports,
        models,
        translation_profiles: profiles,
        profile_models: targets,
        profile_prompt_templates: templates,
        integration_instances: integration_exports,
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

  /// Preview import from an untrusted JSON value (formatVersion parsed first, then normalized to v4).
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

  /// Import from an untrusted JSON value (formatVersion parsed first, then normalized to v4).
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
    }
    Ok(())
  }

  fn apply_plan(
    &self,
    conn: &rusqlite::Connection,
    plan: &ValidatedImportPlan,
  ) -> Result<Vec<CredentialOperation>, StorageError> {
    let mut cleanup_ops = Vec::new();

    // Integrations first so plugin profiles can bind via FK.
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
