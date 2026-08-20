// ABOUTME: Read-only Phase 12 retirement inventory over legacy executor slices.
// ABOUTME: Fail-closed readiness from default policy, package-first create, and activation state.
use crate::domain::default_package_activation::DefaultPackageAuthorizationStatus;
use crate::domain::legacy_runtime_inventory::{
  BLOCKER_AMBIGUOUS_DEFAULT, BLOCKER_AUTHORIZED_DEFAULT_MISSING, BLOCKER_DEFAULT_STALE, BLOCKER_DEFAULT_UNAUTHORIZED,
  BLOCKER_DISABLED_DEPENDENT_ROWS, BLOCKER_ENABLED_LEGACY_ROWS, BLOCKER_LEGACY_CREATE_STILL_POSSIBLE,
  BLOCKER_PACKAGE_FIRST_NOT_READY, BLOCKER_PENDING_ACTIVATIONS, BLOCKER_UNAVAILABLE_ACTIVATIONS,
  LegacyRuntimeInventoryDto, LegacyRuntimeInventoryEntryDto, LegacyRuntimeSubjectKind, LegacyRuntimeUnresolvedRowDto,
};
use crate::domain::runtime_provider::{ProviderRuntimeCatalogEntryDto, ProviderRuntimeKind, ProviderRuntimeState};
use crate::domain::service_integration::{EDGE_TTS_PLUGIN_ID, GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_TRANSLATE_WEB_PLUGIN_ID};
use crate::error::StorageError;
use crate::repositories::{
  default_package_activation_policies, installed_plugin_versions, integration_instances, provider_instances,
  provider_models, provider_runtime_bindings,
};
use crate::services::default_package_activation::{DefaultPackageActivationService, PackageFirstCreateResolution};
use crate::services::legacy_runtime_retirement::LegacyRuntimeRetirementGate;
use crate::services::runtime_providers::ProviderRuntimeService;
use crate::storage::Database;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use uuid::Uuid;

/// Known legacy integration executor slices replaced by runtime packages, in release order.
/// PaddleOCR keeps its dual-stack path and is not part of the retirement scope.
const INTEGRATION_EXECUTORS: &[(&str, &str)] = &[
  (GOOGLE_TRANSLATE_WEB_PLUGIN_ID, "bundled-rust"),
  (EDGE_TTS_PLUGIN_ID, "bundled-rust"),
  (GOOGLE_CLOUD_PLUGIN_ID, "bundled-rust"),
];

/// Provider inventory is per adapter; the executor id carries the adapter for release review.
const LEGACY_PROVIDER_EXECUTOR_ID_PREFIX: &str = "legacy-frontend-provider";
const LEGACY_PROVIDER_RUNTIME_KIND: &str = "legacy-frontend-provider";

/// Sanitized unresolved legacy row identity shared by both executor slices.
/// Aggregates and row DTOs derive from the same row snapshot.
#[derive(Debug, Clone)]
struct UnresolvedLegacyRow {
  subject_kind: LegacyRuntimeSubjectKind,
  subject_id: Uuid,
  adapter_id: Option<String>,
  display_name: String,
  enabled: bool,
  dependency_count: u64,
  update_token: String,
  /// Full safe-delete preconditions for the row's subject kind.
  delete_available: bool,
}

impl UnresolvedLegacyRow {
  fn to_dto(
    &self,
    replacement_package_digest: Option<String>,
    authorized_replacement: bool,
  ) -> LegacyRuntimeUnresolvedRowDto {
    LegacyRuntimeUnresolvedRowDto {
      subject_kind: self.subject_kind,
      subject_id: self.subject_id.to_string(),
      adapter_id: self.adapter_id.clone(),
      display_name: self.display_name.clone(),
      enabled: self.enabled,
      dependency_count: self.dependency_count,
      update_token: self.update_token.clone(),
      replacement_package_digest: if authorized_replacement {
        replacement_package_digest
      } else {
        None
      },
      migrate_available: authorized_replacement,
      disable_available: self.enabled,
      delete_available: self.delete_available,
    }
  }
}

/// Inputs for pure retirement readiness evaluation shared by integration and provider inventory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyRuntimeReadinessInput {
  pub authorization_status: DefaultPackageAuthorizationStatus,
  pub package_first_create_ready: bool,
  pub pending_activation_count: u64,
  pub unavailable_activation_count: u64,
  pub enabled_legacy_row_count: u64,
  pub disabled_legacy_row_count: u64,
  pub dependent_row_count: u64,
  pub legacy_create_still_possible: bool,
  /// Provider inventory does not track disabled dependents; integrations do.
  pub include_disabled_dependent_blocker: bool,
  /// More than one authorized compatible replacement package: migration must stay unavailable.
  pub ambiguous_default: bool,
}

/// Pure readiness result: sorted unique blocker codes plus retirement_ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyRuntimeReadiness {
  pub blocker_codes: Vec<String>,
  pub retirement_ready: bool,
}

/// One readiness evaluator for both integration and provider inventory paths.
pub fn evaluate_legacy_runtime_readiness(input: LegacyRuntimeReadinessInput) -> LegacyRuntimeReadiness {
  let mut blocker_codes = Vec::new();
  match input.authorization_status {
    DefaultPackageAuthorizationStatus::Absent => blocker_codes.push(BLOCKER_AUTHORIZED_DEFAULT_MISSING.into()),
    DefaultPackageAuthorizationStatus::Unauthorized => blocker_codes.push(BLOCKER_DEFAULT_UNAUTHORIZED.into()),
    DefaultPackageAuthorizationStatus::Stale => blocker_codes.push(BLOCKER_DEFAULT_STALE.into()),
    DefaultPackageAuthorizationStatus::ConfirmationRequired => {
      blocker_codes.push(BLOCKER_PACKAGE_FIRST_NOT_READY.into());
    }
    DefaultPackageAuthorizationStatus::Authorized => {}
  }
  if !input.package_first_create_ready {
    if !blocker_codes.iter().any(|code| {
      code == BLOCKER_AUTHORIZED_DEFAULT_MISSING
        || code == BLOCKER_DEFAULT_UNAUTHORIZED
        || code == BLOCKER_DEFAULT_STALE
    }) {
      blocker_codes.push(BLOCKER_PACKAGE_FIRST_NOT_READY.into());
    }
  }
  if input.ambiguous_default {
    blocker_codes.push(BLOCKER_AMBIGUOUS_DEFAULT.into());
  }
  if input.pending_activation_count > 0 {
    blocker_codes.push(BLOCKER_PENDING_ACTIVATIONS.into());
  }
  if input.unavailable_activation_count > 0 {
    blocker_codes.push(BLOCKER_UNAVAILABLE_ACTIVATIONS.into());
  }
  if input.enabled_legacy_row_count > 0 {
    blocker_codes.push(BLOCKER_ENABLED_LEGACY_ROWS.into());
  }
  if input.include_disabled_dependent_blocker && input.disabled_legacy_row_count > 0 && input.dependent_row_count > 0 {
    blocker_codes.push(BLOCKER_DISABLED_DEPENDENT_ROWS.into());
  }
  if input.legacy_create_still_possible {
    blocker_codes.push(BLOCKER_LEGACY_CREATE_STILL_POSSIBLE.into());
  }
  blocker_codes.sort();
  blocker_codes.dedup();

  let retirement_ready = blocker_codes.is_empty()
    && input.authorization_status == DefaultPackageAuthorizationStatus::Authorized
    && input.package_first_create_ready
    && input.pending_activation_count == 0
    && input.unavailable_activation_count == 0
    && input.enabled_legacy_row_count == 0
    && !input.ambiguous_default
    && !input.legacy_create_still_possible;

  LegacyRuntimeReadiness {
    blocker_codes,
    retirement_ready,
  }
}

/// Read-only inventory service for Phase 12 retirement gates.
#[derive(Clone)]
pub struct LegacyRuntimeInventoryService {
  db: Database,
  activation: DefaultPackageActivationService,
  retirement_gate: LegacyRuntimeRetirementGate,
  provider_runtime: Option<Arc<ProviderRuntimeService>>,
}

impl LegacyRuntimeInventoryService {
  pub fn create(db: Database, activation: DefaultPackageActivationService) -> Self {
    Self {
      db,
      activation,
      retirement_gate: LegacyRuntimeRetirementGate::disabled(),
      provider_runtime: None,
    }
  }

  /// Override the retirement gate (tests and Phase 12 enablement).
  pub fn with_retirement_gate(mut self, gate: LegacyRuntimeRetirementGate) -> Self {
    self.retirement_gate = gate;
    self
  }

  /// Attach the verified provider-runtime catalog (production wiring). Without it, provider
  /// slices report no replacement candidates and stay fail-closed.
  pub fn with_provider_runtime(mut self, runtime: Arc<ProviderRuntimeService>) -> Self {
    self.provider_runtime = Some(runtime);
    self
  }

  /// Build the sanitized retirement inventory. Never migrates, deletes, or creates rows.
  pub fn list_inventory(&self) -> Result<LegacyRuntimeInventoryDto, StorageError> {
    let mut entries = Vec::new();
    for (plugin_id, runtime_kind) in INTEGRATION_EXECUTORS {
      entries.push(self.inventory_integration_slice(plugin_id, runtime_kind)?);
    }
    entries.extend(self.inventory_legacy_provider_slices()?);
    Ok(LegacyRuntimeInventoryDto { entries })
  }

  fn inventory_integration_slice(
    &self,
    plugin_id: &str,
    runtime_kind: &str,
  ) -> Result<LegacyRuntimeInventoryEntryDto, StorageError> {
    let rows = self.db.read(|conn| {
      let instances = integration_instances::list(conn)?;
      let mut rows = Vec::new();
      for instance in instances {
        if instance.plugin_id != plugin_id || instance.runtime_kind != runtime_kind {
          continue;
        }
        let dependencies = integration_instances::list_dependencies(conn, instance.id)?;
        rows.push(UnresolvedLegacyRow {
          subject_kind: LegacyRuntimeSubjectKind::IntegrationInstance,
          subject_id: instance.id,
          adapter_id: None,
          display_name: instance.display_name.clone(),
          enabled: instance.enabled,
          dependency_count: dependencies.len() as u64,
          update_token: instance.updated_at.clone(),
          delete_available: dependencies.is_empty(),
        });
      }
      Ok::<_, StorageError>(rows)
    })?;
    let enabled_legacy_row_count = rows.iter().filter(|row| row.enabled).count() as u64;
    let disabled_legacy_row_count = rows.iter().filter(|row| !row.enabled).count() as u64;
    let dependent_row_count = rows.iter().map(|row| row.dependency_count).sum();
    let pending_activation_count = self.db.read(|conn| {
      integration_instances::list(conn).map(|instances| {
        instances
          .into_iter()
          .filter(|row| row.plugin_id == plugin_id && row.runtime_state == "pending_activation")
          .count() as u64
      })
    })?;
    let unavailable_activation_count = self.db.read(|conn| {
      integration_instances::list(conn).map(|instances| {
        instances
          .into_iter()
          .filter(|row| row.plugin_id == plugin_id && row.runtime_state == "unavailable")
          .count() as u64
      })
    })?;

    let versions = self.db.read(installed_plugin_versions::list)?;
    let replacement_installed_count = versions
      .iter()
      .filter(|row| row.plugin_id == plugin_id && row.content_available)
      .count() as u64;
    let default = self
      .db
      .read(|conn| installed_plugin_versions::get_default(conn, plugin_id))?;
    let default_package_digest = default.as_ref().map(|row| row.package_digest.clone());
    let status = self
      .db
      .read(|conn| default_package_activation_policies::resolve_authorization_status(conn, plugin_id))?;
    let package_first = self.activation.prepare_package_first_create(plugin_id)?;
    let package_first_create_ready = matches!(package_first, PackageFirstCreateResolution::Ready(_));
    // Dual-stack still permits legacy create when no default exists and the retirement gate is off.
    let legacy_create_still_possible = matches!(package_first, PackageFirstCreateResolution::NoDefault)
      && !self.retirement_gate.is_integration_executor_retired(plugin_id);

    let authorized_replacement = status == DefaultPackageAuthorizationStatus::Authorized
      && default_package_digest.is_some()
      && package_first_create_ready;
    let unresolved_rows = rows
      .iter()
      .map(|row| row.to_dto(default_package_digest.clone(), authorized_replacement))
      .collect();

    let readiness = evaluate_legacy_runtime_readiness(LegacyRuntimeReadinessInput {
      authorization_status: status,
      package_first_create_ready,
      pending_activation_count,
      unavailable_activation_count,
      enabled_legacy_row_count,
      disabled_legacy_row_count,
      dependent_row_count,
      legacy_create_still_possible,
      include_disabled_dependent_blocker: true,
      ambiguous_default: false,
    });

    Ok(LegacyRuntimeInventoryEntryDto {
      executor_id: plugin_id.into(),
      runtime_kind: runtime_kind.into(),
      enabled_legacy_row_count,
      disabled_legacy_row_count,
      dependent_row_count,
      replacement_installed_count,
      default_package_digest,
      default_authorization_status: status.as_str().into(),
      package_first_create_ready,
      pending_activation_count,
      unavailable_activation_count,
      legacy_create_still_possible,
      blocker_codes: readiness.blocker_codes,
      retirement_ready: readiness.retirement_ready,
      unresolved_rows,
    })
  }

  /// One entry per legacy provider adapter: bindings grouped by `adapter_id`, with the exact
  /// authorized replacement digest for that adapter only. Adapters with legacy bindings, a
  /// verified catalog `legacyAliases` entry, or a retired gate entry are reported; zero-row
  /// catalog aliases appear before their retirement gate opens so release review can verify
  /// readiness in release order.
  fn inventory_legacy_provider_slices(&self) -> Result<Vec<LegacyRuntimeInventoryEntryDto>, StorageError> {
    // One coherent binding snapshot: all provider counts and rows derive from this list only.
    let (rows, pending_by_adapter, unavailable_by_adapter) = self.db.read(|conn| {
      let providers = provider_instances::list(conn)?;
      let bindings = provider_runtime_bindings::list(conn)?;
      let models = provider_models::list_all(conn)?;
      let provider_default: HashMap<Uuid, String> = providers
        .iter()
        .map(|provider| (provider.id, provider.adapter_id.clone()))
        .collect();
      let provider_by_id: HashMap<Uuid, &crate::domain::provider::ProviderInstance> =
        providers.iter().map(|provider| (provider.id, provider)).collect();
      let mut binding_counts: HashMap<Uuid, u64> = HashMap::new();
      for binding in &bindings {
        *binding_counts.entry(binding.provider_id).or_default() += 1;
      }
      // Effective model adapter follows the canonical host rule: explicit override wins,
      // then discovery provenance, then the provider default API type.
      let legacy_adapters: std::collections::HashSet<(Uuid, String)> = bindings
        .iter()
        .filter(|binding| binding.runtime_kind == ProviderRuntimeKind::LegacyFrontendProvider)
        .map(|binding| (binding.provider_id, binding.adapter_id.clone()))
        .collect();
      let mut model_counts: HashMap<(Uuid, String), u64> = HashMap::new();
      for model in models {
        let effective = model
          .adapter_id
          .clone()
          .filter(|adapter| !adapter.trim().is_empty())
          .or_else(|| (!model.source_adapter_id.trim().is_empty()).then(|| model.source_adapter_id.clone()))
          .or_else(|| provider_default.get(&model.provider_instance_id).cloned());
        if let Some(effective) = effective {
          if legacy_adapters.contains(&(model.provider_instance_id, effective.clone())) {
            *model_counts.entry((model.provider_instance_id, effective)).or_default() += 1;
          }
        }
      }

      let mut rows = Vec::new();
      for binding in &bindings {
        if binding.runtime_kind != ProviderRuntimeKind::LegacyFrontendProvider {
          continue;
        }
        let Some(provider) = provider_by_id.get(&binding.provider_id) else {
          continue;
        };
        let dependency_count = model_counts
          .get(&(binding.provider_id, binding.adapter_id.clone()))
          .copied()
          .unwrap_or(0);
        rows.push(UnresolvedLegacyRow {
          subject_kind: LegacyRuntimeSubjectKind::ProviderBinding,
          subject_id: binding.provider_id,
          adapter_id: Some(binding.adapter_id.clone()),
          display_name: provider.display_name.clone(),
          enabled: provider.enabled,
          dependency_count,
          update_token: binding.updated_at.clone(),
          // Retirement deletion is safe only for a disabled provider with zero models and
          // exactly the one legacy binding (the backend re-verifies inside one transaction).
          delete_available: dependency_count == 0
            && !provider.enabled
            && binding_counts.get(&binding.provider_id).copied() == Some(1),
        });
      }
      let mut pending_by_adapter: HashMap<String, u64> = HashMap::new();
      let mut unavailable_by_adapter: HashMap<String, u64> = HashMap::new();
      for binding in bindings
        .iter()
        .filter(|row| row.runtime_kind == ProviderRuntimeKind::LegacyFrontendProvider)
      {
        match binding.state {
          ProviderRuntimeState::PendingActivation => {
            *pending_by_adapter.entry(binding.adapter_id.clone()).or_default() += 1;
          }
          ProviderRuntimeState::Unavailable => {
            *unavailable_by_adapter.entry(binding.adapter_id.clone()).or_default() += 1;
          }
          _ => {}
        }
      }
      Ok::<_, StorageError>((rows, pending_by_adapter, unavailable_by_adapter))
    })?;

    // Adapter slices = adapters with legacy bindings, verified catalog legacy aliases, plus
    // retired adapters (release review). One shared catalog snapshot: an unwired or failed
    // catalog contributes no aliases and must not invent readiness, so catalog verification
    // errors propagate and fail the whole inventory request.
    let catalog = match &self.provider_runtime {
      Some(runtime) => runtime.list_catalog()?,
      None => Vec::new(),
    };
    let mut adapter_ids: BTreeSet<String> = rows.iter().filter_map(|row| row.adapter_id.clone()).collect();
    adapter_ids.extend(catalog.iter().flat_map(|entry| entry.legacy_aliases.iter().cloned()));
    adapter_ids.extend(self.retirement_gate.retired_provider_adapters().map(ToOwned::to_owned));

    let mut entries = Vec::new();
    for adapter_id in adapter_ids {
      let adapter_rows: Vec<UnresolvedLegacyRow> = rows
        .iter()
        .filter(|row| row.adapter_id.as_deref() == Some(adapter_id.as_str()))
        .cloned()
        .collect();
      let resolved = self.resolve_provider_adapter_default(&adapter_id, &catalog)?;
      let enabled_legacy_row_count = adapter_rows.iter().filter(|row| row.enabled).count() as u64;
      let disabled_legacy_row_count = adapter_rows.iter().filter(|row| !row.enabled).count() as u64;
      let dependent_row_count = adapter_rows.iter().map(|row| row.dependency_count).sum();
      let pending_activation_count = pending_by_adapter.get(&adapter_id).copied().unwrap_or(0);
      let unavailable_activation_count = unavailable_by_adapter.get(&adapter_id).copied().unwrap_or(0);
      // Provider dual-stack still creates legacy when no applicable authorized default exists and
      // this adapter is not retired.
      let legacy_create_still_possible =
        !resolved.package_first_create_ready && !self.retirement_gate.is_provider_legacy_retired(&adapter_id);

      let authorized_replacement = resolved.package_first_create_ready && resolved.default_package_digest.is_some();
      let unresolved_rows = adapter_rows
        .iter()
        .map(|row| row.to_dto(resolved.default_package_digest.clone(), authorized_replacement))
        .collect();

      let readiness = evaluate_legacy_runtime_readiness(LegacyRuntimeReadinessInput {
        authorization_status: resolved.status,
        package_first_create_ready: resolved.package_first_create_ready,
        pending_activation_count,
        unavailable_activation_count,
        enabled_legacy_row_count,
        disabled_legacy_row_count,
        dependent_row_count,
        legacy_create_still_possible,
        include_disabled_dependent_blocker: false,
        ambiguous_default: resolved.ambiguous_default,
      });

      entries.push(LegacyRuntimeInventoryEntryDto {
        executor_id: format!("{LEGACY_PROVIDER_EXECUTOR_ID_PREFIX}:{adapter_id}"),
        runtime_kind: LEGACY_PROVIDER_RUNTIME_KIND.into(),
        enabled_legacy_row_count,
        disabled_legacy_row_count,
        dependent_row_count,
        replacement_installed_count: resolved.replacement_installed_count,
        default_package_digest: resolved.default_package_digest,
        default_authorization_status: resolved.status.as_str().into(),
        package_first_create_ready: resolved.package_first_create_ready,
        pending_activation_count,
        unavailable_activation_count,
        legacy_create_still_possible,
        blocker_codes: readiness.blocker_codes,
        retirement_ready: readiness.retirement_ready,
        unresolved_rows,
      });
    }
    Ok(entries)
  }

  /// Resolve the exact replacement default for ONE provider adapter from the verified catalog.
  ///
  /// A candidate must be a catalog default with content available, an authorized activation
  /// policy, and the adapter in its `providerRuntime.legacyAliases`. Exactly one authorized
  /// candidate makes migration available; zero or multiple keep it unavailable (fail closed).
  /// The caller supplies one shared catalog snapshot; this function never reloads it.
  fn resolve_provider_adapter_default(
    &self,
    adapter_id: &str,
    catalog: &[ProviderRuntimeCatalogEntryDto],
  ) -> Result<ResolvedProviderDefault, StorageError> {
    let defaults = self.db.read(installed_plugin_versions::list_defaults)?;
    let default_by_plugin: HashMap<&str, &str> = defaults
      .iter()
      .map(|default| (default.plugin_id.as_str(), default.package_digest.as_str()))
      .collect();

    let mut replacement_installed_count = 0u64;
    let mut authorized_digests: Vec<String> = Vec::new();
    let mut any_unauthorized = false;
    let mut any_stale = false;
    let mut any_confirmation_required = false;
    for entry in catalog {
      if !entry.legacy_aliases.iter().any(|alias| alias == adapter_id) {
        continue;
      }
      let version = self
        .db
        .read(|conn| installed_plugin_versions::get_optional(conn, &entry.package_digest))?;
      let Some(version) = version else {
        continue;
      };
      if version.content_available {
        replacement_installed_count = replacement_installed_count.saturating_add(1);
      }
      // Only catalog defaults with content available are replacement candidates.
      if default_by_plugin.get(entry.plugin_id.as_str()) != Some(&entry.package_digest.as_str()) {
        continue;
      }
      if !version.content_available {
        continue;
      }
      let status = self
        .db
        .read(|conn| default_package_activation_policies::resolve_authorization_status(conn, &entry.plugin_id))?;
      match status {
        DefaultPackageAuthorizationStatus::Authorized => authorized_digests.push(entry.package_digest.clone()),
        DefaultPackageAuthorizationStatus::Unauthorized => any_unauthorized = true,
        DefaultPackageAuthorizationStatus::Stale => any_stale = true,
        DefaultPackageAuthorizationStatus::ConfirmationRequired => any_confirmation_required = true,
        DefaultPackageAuthorizationStatus::Absent => {}
      }
    }
    authorized_digests.sort();
    authorized_digests.dedup();

    Ok(match authorized_digests.len() {
      1 => ResolvedProviderDefault {
        package_first_create_ready: true,
        default_package_digest: Some(authorized_digests[0].clone()),
        status: DefaultPackageAuthorizationStatus::Authorized,
        replacement_installed_count,
        ambiguous_default: false,
      },
      0 => ResolvedProviderDefault {
        package_first_create_ready: false,
        default_package_digest: None,
        status: if any_confirmation_required {
          DefaultPackageAuthorizationStatus::ConfirmationRequired
        } else if any_stale {
          DefaultPackageAuthorizationStatus::Stale
        } else if any_unauthorized {
          DefaultPackageAuthorizationStatus::Unauthorized
        } else {
          DefaultPackageAuthorizationStatus::Absent
        },
        replacement_installed_count,
        ambiguous_default: false,
      },
      _ => ResolvedProviderDefault {
        package_first_create_ready: false,
        default_package_digest: None,
        status: DefaultPackageAuthorizationStatus::Absent,
        replacement_installed_count,
        ambiguous_default: true,
      },
    })
  }
}

/// Per-adapter replacement default resolution outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedProviderDefault {
  package_first_create_ready: bool,
  default_package_digest: Option<String>,
  status: DefaultPackageAuthorizationStatus,
  replacement_installed_count: u64,
  ambiguous_default: bool,
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::default_package_activation::AuthorizeDefaultPluginPackageInput;
  use crate::domain::plugin_package::{ApprovePluginPackageInput, ApproveUserPublisherInput};
  use crate::services::plugin_package::test_support::{test_fingerprint, test_public_key_hex, valid_signed_package};
  use crate::services::plugin_store::PluginPackageService;
  use crate::services::vendor_trust::test_vendor_fixture::fixture_vendor_public_key;
  use crate::services::wasm_runtime::WasmRuntime;

  /// Committed dev-signed provider runtime packages used by per-adapter inventory tests.
  const OPENAI_COMPATIBLE_PACKAGE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-plugins/openai-compatible/fixtures/packages/com.langnext.provider.openai-compatible-1.0.0.lnplugin"
  ));
  const ANTHROPIC_PACKAGE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-plugins/anthropic/fixtures/packages/com.langnext.provider.anthropic-1.0.0.lnplugin"
  ));
  /// Conformance package aliasing `openai-compatible` (ambiguity fixture).
  const LLM_PROVIDER_PACKAGE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-plugins/conformance/fixtures/packages/llm-provider-valid.lnplugin"
  ));

  #[test]
  fn legacy_runtime_inventory_subject_kind_serde() {
    let instance = serde_json::to_value(LegacyRuntimeSubjectKind::IntegrationInstance).unwrap();
    assert_eq!(instance, serde_json::json!("integration_instance"));
    let binding = serde_json::to_value(LegacyRuntimeSubjectKind::ProviderBinding).unwrap();
    assert_eq!(binding, serde_json::json!("provider_binding"));
    assert_eq!(
      serde_json::from_value::<LegacyRuntimeSubjectKind>(serde_json::json!("integration_instance")).unwrap(),
      LegacyRuntimeSubjectKind::IntegrationInstance
    );
    assert_eq!(
      serde_json::from_value::<LegacyRuntimeSubjectKind>(serde_json::json!("provider_binding")).unwrap(),
      LegacyRuntimeSubjectKind::ProviderBinding
    );
    let err = serde_json::from_value::<LegacyRuntimeSubjectKind>(serde_json::json!("unknown_subject")).unwrap_err();
    assert!(err.is_data(), "unknown subject token must fail closed");
  }

  #[test]
  fn evaluate_legacy_runtime_readiness_table() {
    let ready = evaluate_legacy_runtime_readiness(LegacyRuntimeReadinessInput {
      authorization_status: DefaultPackageAuthorizationStatus::Authorized,
      package_first_create_ready: true,
      pending_activation_count: 0,
      unavailable_activation_count: 0,
      enabled_legacy_row_count: 0,
      disabled_legacy_row_count: 0,
      dependent_row_count: 0,
      legacy_create_still_possible: false,
      include_disabled_dependent_blocker: true,
      ambiguous_default: false,
    });
    assert!(ready.retirement_ready);
    assert!(ready.blocker_codes.is_empty());

    let blocked = evaluate_legacy_runtime_readiness(LegacyRuntimeReadinessInput {
      authorization_status: DefaultPackageAuthorizationStatus::Unauthorized,
      package_first_create_ready: false,
      pending_activation_count: 1,
      unavailable_activation_count: 1,
      enabled_legacy_row_count: 1,
      disabled_legacy_row_count: 1,
      dependent_row_count: 2,
      legacy_create_still_possible: true,
      include_disabled_dependent_blocker: true,
      ambiguous_default: true,
    });
    assert!(!blocked.retirement_ready);
    assert_eq!(
      blocked.blocker_codes,
      vec![
        BLOCKER_AMBIGUOUS_DEFAULT.to_string(),
        BLOCKER_DEFAULT_UNAUTHORIZED.to_string(),
        BLOCKER_DISABLED_DEPENDENT_ROWS.to_string(),
        BLOCKER_ENABLED_LEGACY_ROWS.to_string(),
        BLOCKER_LEGACY_CREATE_STILL_POSSIBLE.to_string(),
        BLOCKER_PENDING_ACTIVATIONS.to_string(),
        BLOCKER_UNAVAILABLE_ACTIVATIONS.to_string(),
      ]
    );

    // Ambiguity alone (everything else ready) still blocks retirement.
    let ambiguous = evaluate_legacy_runtime_readiness(LegacyRuntimeReadinessInput {
      authorization_status: DefaultPackageAuthorizationStatus::Authorized,
      package_first_create_ready: true,
      pending_activation_count: 0,
      unavailable_activation_count: 0,
      enabled_legacy_row_count: 0,
      disabled_legacy_row_count: 0,
      dependent_row_count: 0,
      legacy_create_still_possible: false,
      include_disabled_dependent_blocker: true,
      ambiguous_default: true,
    });
    assert!(!ambiguous.retirement_ready);
    assert_eq!(ambiguous.blocker_codes, vec![BLOCKER_AMBIGUOUS_DEFAULT.to_string()]);
  }

  #[test]
  fn retirement_gate_rejects_integration_create_without_package_first() {
    use crate::services::default_package_activation::PackageFirstCreateResolution;
    let gate =
      LegacyRuntimeRetirementGate::with_executors([GOOGLE_TRANSLATE_WEB_PLUGIN_ID], std::iter::empty::<&str>());
    let err = gate
      .require_package_first_for_integration(GOOGLE_TRANSLATE_WEB_PLUGIN_ID, &PackageFirstCreateResolution::NoDefault)
      .expect_err("retired executor without package-first must reject");
    assert!(err.to_string().contains("retired"));
    gate
      .require_package_first_for_integration("com.unrelated.plugin", &PackageFirstCreateResolution::NoDefault)
      .expect("unrelated executor remains dual-stack");
  }

  #[test]
  fn legacy_runtime_inventory_service_create_rejects_retired_executor_without_default() {
    use crate::credentials::MemoryCredentialVault;
    use crate::domain::service_integration::IntegrationInstanceWrite;
    use crate::services::service_integration_registry::ServiceIntegrationRegistry;
    use crate::services::service_integrations::ServiceIntegrationService;
    use crate::services::token_grant::TokenGrantService;
    use std::sync::Arc;

    let (_dir, db, _packages, activation, inventory) = setup();
    let gate =
      LegacyRuntimeRetirementGate::with_executors([GOOGLE_TRANSLATE_WEB_PLUGIN_ID], std::iter::empty::<&str>());
    let inventory = inventory.with_retirement_gate(gate.clone());
    let report = inventory.list_inventory().unwrap();
    let entry = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == GOOGLE_TRANSLATE_WEB_PLUGIN_ID)
      .expect("google web inventory entry");
    assert!(!entry.legacy_create_still_possible || !entry.retirement_ready);

    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let vault = Arc::new(MemoryCredentialVault::default());
    let tokens = Arc::new(TokenGrantService::new(Arc::new(
      crate::services::google_service_account::GoogleServiceAccountExchanger::new(db.clone(), vault.clone()),
    )));
    let service = ServiceIntegrationService::new(db, vault, registry, tokens)
      .with_default_package_activation(activation)
      .with_retirement_gate(gate);

    let before = service.list_instances().unwrap().len();
    let err = service
      .save(IntegrationInstanceWrite {
        id: None,
        plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
        display_name: "Retired".into(),
        enabled: true,
        config_json: r#"{"channel":"gtx"}"#.into(),
        credentials: vec![],
        expected_updated_at: None,
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .expect_err("retired executor without authorized default must reject create");
    assert!(err.to_string().contains("retired"), "got {err}");
    assert_eq!(service.list_instances().unwrap().len(), before);
  }

  #[test]
  fn legacy_runtime_inventory_provider_create_rejects_when_adapter_retired() {
    use crate::credentials::MemoryCredentialVault;
    use crate::domain::provider::{
      AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode,
    };
    use crate::services::providers::ProviderService;
    use std::sync::Arc;

    let (_dir, _db, _packages, _activation, inventory) = setup();
    let gate = LegacyRuntimeRetirementGate::with_executors(std::iter::empty::<&str>(), ["openai-compatible"]);
    let inventory = inventory.with_retirement_gate(gate.clone());
    let report = inventory.list_inventory().unwrap();
    let provider = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == "legacy-frontend-provider:openai-compatible")
      .expect("retired adapter inventory entry");
    assert!(!provider.legacy_create_still_possible);

    let vault = Arc::new(MemoryCredentialVault::new());
    // Fresh DB for provider create rejection (inventory setup DB has no provider service wiring).
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let providers = ProviderService::new(db, vault).with_retirement_gate(gate);
    let before = providers.list().unwrap().len();
    let err = providers
      .save(ProviderInstanceWrite {
        id: None,
        adapter_id: "openai-compatible".into(),
        display_name: "Retired provider".into(),
        base_url: "https://api.openai.com/v1".into(),
        base_url_source: BaseUrlSource::PluginDefault,
        auth_scheme: AuthSchemeV1::none(),
        credential_kind: CredentialKind::None,
        credential: CredentialUpdate::Keep,
        enabled: true,
        proxy_mode: ProxyMode::Inherit,
        insecure_http_confirmed_at: None,
        expected_updated_at: None,
      })
      .expect_err("retired provider legacy create must reject");
    assert!(err.to_string().contains("retired"), "got {err}");
    assert_eq!(providers.list().unwrap().len(), before);
  }

  fn setup() -> (
    tempfile::TempDir,
    Database,
    PluginPackageService,
    DefaultPackageActivationService,
    LegacyRuntimeInventoryService,
  ) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let packages =
      PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
    packages
      .approve_user_publisher(ApproveUserPublisherInput {
        key_id: "com.example.keys.1".into(),
        fingerprint: test_fingerprint(),
        public_key_hex: test_public_key_hex(),
      })
      .unwrap();
    let activation = DefaultPackageActivationService::create(db.clone(), packages.clone(), dir.path());
    let inventory = LegacyRuntimeInventoryService::create(db.clone(), activation.clone());
    (dir, db, packages, activation, inventory)
  }

  /// Install a committed vendor-signed provider package and authorize it as the plugin default.
  fn install_and_authorize_provider_default(
    db: &Database,
    packages: &PluginPackageService,
    dir: &std::path::Path,
    bytes: &[u8],
  ) -> String {
    let digest = packages
      .bootstrap_bundled_package(bytes, false)
      .expect("install provider package")
      .package_digest()
      .to_string();
    let activation = DefaultPackageActivationService::create(db.clone(), packages.clone(), dir);
    let preview = activation
      .preview_default_package_activation(&digest)
      .expect("preview authorized default");
    activation
      .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
        preview_id: preview.preview_id,
        acknowledge_future_instance_authority: true,
      })
      .expect("authorize default package");
    digest
  }

  /// Inventory with the verified provider-runtime catalog attached (production wiring shape).
  fn catalog_inventory(
    db: Database,
    activation: DefaultPackageActivationService,
    packages: PluginPackageService,
  ) -> LegacyRuntimeInventoryService {
    let wasm = Arc::new(WasmRuntime::new().unwrap());
    let runtime = Arc::new(ProviderRuntimeService::new(db.clone(), packages, wasm));
    LegacyRuntimeInventoryService::create(db, activation).with_provider_runtime(runtime)
  }

  /// Insert one provider with a legacy frontend binding on the adapter.
  fn seed_legacy_provider(db: &Database, adapter_id: &str, display_name: &str, enabled: bool) -> Uuid {
    use crate::domain::provider::{
      AuthSchemeV1, BaseUrlSource, CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode,
    };
    use crate::domain::runtime_provider::legacy_frontend_binding;
    use crate::domain::time::now_rfc3339;

    let now = now_rfc3339();
    let id = Uuid::now_v7();
    db.transaction(|uow| {
      provider_instances::insert(
        uow.conn(),
        &ProviderInstance {
          id,
          adapter_id: adapter_id.into(),
          display_name: display_name.into(),
          base_url: "https://api.example.com/v1".into(),
          base_url_source: BaseUrlSource::PluginDefault,
          auth_scheme: AuthSchemeV1::none(),
          credential_kind: CredentialKind::None,
          credential_ref: None,
          enabled,
          proxy_mode: ProxyMode::Inherit,
          insecure_http_confirmed_at: None,
          models_synced_at: None,
          models_sync_status: ModelsSyncStatus::Never,
          models_sync_error_code: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      provider_runtime_bindings::insert(uow.conn(), &legacy_frontend_binding(id, adapter_id, &now))?;
      Ok::<_, StorageError>(())
    })
    .expect("seed provider fixture");
    id
  }

  #[test]
  fn legacy_runtime_inventory_blocks_missing_authorized_default() {
    let (dir, _db, packages, _activation, inventory) = setup();
    // Install a replacement package for the sample plugin id without authorizing a default.
    let (pkg, digest) = valid_signed_package();
    let src = dir.path().join("sample.lnplugin");
    std::fs::write(&src, &pkg).unwrap();
    let preview = packages.preview_package(&src).unwrap();
    packages
      .approve_package(ApprovePluginPackageInput {
        preview_id: preview.preview_id,
        approve_publisher: false,
        publisher_public_key_hex: None,
        acknowledge_permissions: true,
      })
      .unwrap();
    packages
      .set_default("com.example.translate", &digest)
      .expect("catalog default without policy");

    let report = inventory.list_inventory().expect("inventory");
    // Sample plugin is not one of the known integration executors; integration slices
    // without authorized defaults must still block.
    assert!(
      report.entries.iter().all(|entry| !entry.retirement_ready),
      "no slice is ready without authorized package-first defaults"
    );
    // No legacy provider bindings and no retired adapters: no provider slices exist.
    assert!(
      report
        .entries
        .iter()
        .all(|entry| !entry.executor_id.starts_with(LEGACY_PROVIDER_EXECUTOR_ID_PREFIX)),
      "provider slices only exist for adapters with legacy bindings or a retired gate entry"
    );
  }

  #[test]
  fn legacy_runtime_inventory_allows_ready_retired_slice() {
    // A ready slice requires authorized default, package-first ready, zero pending/unavailable,
    // zero enabled legacy rows, and legacy create disabled. With dual-stack still active,
    // true readiness is only reachable when package-first create is Ready and NoDefault is gone.
    let (_dir, _db, _packages, activation, inventory) = setup();
    // Without any installed authorized default, readiness is false.
    let report = inventory.list_inventory().unwrap();
    assert!(report.entries.iter().all(|entry| !entry.retirement_ready));
    // prepare_package_first_create for a missing plugin is NoDefault (legacy still possible).
    assert!(matches!(
      activation.prepare_package_first_create("com.example.missing").unwrap(),
      PackageFirstCreateResolution::NoDefault
    ));
  }

  #[test]
  fn inventory_integration_counts_use_real_enabled_state_and_dependencies() {
    use crate::domain::ocr_service::{OcrProviderType, OcrService};
    use crate::domain::service_integration::{IntegrationHealthStatus, IntegrationInstance};
    use crate::domain::speech_service::SpeechService;
    use crate::domain::time::now_rfc3339;
    use crate::repositories::{integration_instances, ocr_services, speech_services};

    let (_dir, db, _packages, _activation, inventory) = setup();
    let now = now_rfc3339();
    let legacy_enabled_deps = Uuid::now_v7();
    let legacy_enabled_none = Uuid::now_v7();
    let legacy_disabled_dep = Uuid::now_v7();
    let wasm_row = Uuid::now_v7();
    db.transaction(|uow| {
      for (id, enabled, name) in [
        (legacy_enabled_deps, true, "Web with deps"),
        (legacy_enabled_none, true, "Web no deps"),
        (legacy_disabled_dep, false, "Web disabled"),
      ] {
        integration_instances::insert(
          uow.conn(),
          &IntegrationInstance {
            id,
            plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
            plugin_version: "legacy".into(),
            display_name: name.into(),
            enabled,
            config_json: r#"{"channel":"gtx"}"#.into(),
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
          },
        )?;
      }
      // Package-backed row for the same plugin must not appear as legacy or its deps count.
      integration_instances::insert(
        uow.conn(),
        &IntegrationInstance {
          id: wasm_row,
          plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
          plugin_version: "1.2.0".into(),
          display_name: "Web package".into(),
          enabled: true,
          config_json: r#"{"channel":"gtx"}"#.into(),
          config_schema_version: 1,
          health_status: IntegrationHealthStatus::Unconfigured,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "wasm-component".into(),
          package_digest: Some("digest-wasm".into()),
          execution_grant_set_revision: Some(1),
          runtime_state: "active".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      ocr_services::insert(
        uow.conn(),
        &OcrService {
          id: Uuid::now_v7(),
          provider_type: OcrProviderType::PluginCapability,
          display_name: "OCR dep".into(),
          enabled: true,
          sort_order: 0,
          baidu_action: None,
          api_key_ref: None,
          secret_key_ref: None,
          provider_model_id: None,
          temperature: None,
          default_prompt_template_id: None,
          integration_instance_id: Some(legacy_enabled_deps),
          ocr_capability_id: Some(crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID.into()),
          capability_preferences_version: Some(1),
          capability_preferences: Some(serde_json::json!({})),
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      speech_services::insert(
        uow.conn(),
        &SpeechService {
          id: Uuid::now_v7(),
          display_name: "Speech dep".into(),
          enabled: true,
          sort_order: 0,
          integration_instance_id: legacy_enabled_deps,
          capability_id: "speech.synthesize@1".into(),
          preferences_schema_version: 1,
          preferences: serde_json::json!({}),
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      speech_services::insert(
        uow.conn(),
        &SpeechService {
          id: Uuid::now_v7(),
          display_name: "Disabled speech dep".into(),
          enabled: true,
          sort_order: 0,
          integration_instance_id: legacy_disabled_dep,
          capability_id: "speech.synthesize@1".into(),
          preferences_schema_version: 1,
          preferences: serde_json::json!({}),
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      // Package-backed row dependencies must not inflate the legacy dependent count.
      speech_services::insert(
        uow.conn(),
        &SpeechService {
          id: Uuid::now_v7(),
          display_name: "Wasm row dep".into(),
          enabled: true,
          sort_order: 0,
          integration_instance_id: wasm_row,
          capability_id: "speech.synthesize@1".into(),
          preferences_schema_version: 1,
          preferences: serde_json::json!({}),
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok::<_, crate::error::StorageError>(())
    })
    .expect("fixture");

    let report = inventory.list_inventory().unwrap();
    let entry = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == GOOGLE_TRANSLATE_WEB_PLUGIN_ID)
      .expect("google web inventory entry");
    assert_eq!(entry.enabled_legacy_row_count, 2);
    assert_eq!(entry.disabled_legacy_row_count, 1);
    assert_eq!(entry.dependent_row_count, 3, "sum of legacy-only dependencies");
    assert_eq!(entry.unresolved_rows.len(), 3);
    let by_name = |name: &str| {
      entry
        .unresolved_rows
        .iter()
        .find(|row| row.display_name == name)
        .unwrap_or_else(|| panic!("row {name}"))
    };
    assert_eq!(by_name("Web with deps").dependency_count, 2);
    assert_eq!(by_name("Web no deps").dependency_count, 0);
    assert_eq!(by_name("Web disabled").dependency_count, 1);
    assert!(by_name("Web with deps").enabled);
    assert!(!by_name("Web disabled").enabled);
    assert_eq!(
      by_name("Web with deps").subject_kind,
      LegacyRuntimeSubjectKind::IntegrationInstance
    );
    assert_eq!(by_name("Web with deps").subject_id, legacy_enabled_deps.to_string());
    assert!(by_name("Web with deps").adapter_id.is_none());
    // No authorized replacement in this fixture: migration unavailable, delete blocked with deps.
    assert!(!by_name("Web with deps").migrate_available);
    assert!(by_name("Web with deps").disable_available);
    assert!(!by_name("Web with deps").delete_available);
    assert!(by_name("Web no deps").delete_available);
    assert!(!by_name("Web disabled").disable_available);
    assert!(
      !by_name("Web disabled").delete_available,
      "disabled row still reports its dependency blocker"
    );
  }

  #[test]
  fn inventory_provider_counts_follow_provider_enabled_state_and_effective_adapter() {
    use crate::domain::model::{Availability, ModelSource, ProviderModel};
    use crate::domain::provider::{AuthSchemeV1, BaseUrlSource, CredentialKind, ModelsSyncStatus, ProxyMode};
    use crate::domain::runtime_provider::{ProviderRuntimeKind, ProviderRuntimeState, legacy_frontend_binding};
    use crate::domain::time::now_rfc3339;
    use crate::repositories::{provider_instances, provider_models, provider_runtime_bindings};

    let (_dir, db, _packages, _activation, inventory) = setup();
    let now = now_rfc3339();
    let enabled_provider = Uuid::now_v7();
    let disabled_provider = Uuid::now_v7();
    db.transaction(|uow| {
      for (id, enabled) in [(enabled_provider, true), (disabled_provider, false)] {
        provider_instances::insert(
          uow.conn(),
          &crate::domain::provider::ProviderInstance {
            id,
            adapter_id: "openai-compatible".into(),
            display_name: format!("provider-{id}"),
            base_url: "https://api.openai.com/v1".into(),
            base_url_source: BaseUrlSource::PluginDefault,
            auth_scheme: AuthSchemeV1::none(),
            credential_kind: CredentialKind::None,
            credential_ref: None,
            enabled,
            proxy_mode: ProxyMode::Inherit,
            insecure_http_confirmed_at: None,
            models_synced_at: None,
            models_sync_status: ModelsSyncStatus::Never,
            models_sync_error_code: None,
            created_at: now.clone(),
            updated_at: now.clone(),
          },
        )?;
        // Legacy binding on the default adapter plus a wasm interface binding on another adapter.
        provider_runtime_bindings::insert(uow.conn(), &legacy_frontend_binding(id, "openai-compatible", &now))?;
        let wasm_binding = crate::domain::runtime_provider::ProviderRuntimeBinding {
          provider_id: id,
          adapter_id: "anthropic".into(),
          runtime_kind: ProviderRuntimeKind::WasmComponent,
          package_digest: Some("digest-wasm".into()),
          grant_set_revision: Some(1),
          state: ProviderRuntimeState::Active,
          error_code: None,
          error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        };
        provider_runtime_bindings::insert(uow.conn(), &wasm_binding)?;
      }
      let model = |provider_id: Uuid, key: &str, adapter_id: Option<&str>, source: &str| ProviderModel {
        id: Uuid::now_v7(),
        provider_instance_id: provider_id,
        model_key: key.into(),
        source: ModelSource::Remote,
        remote_display_name: Some(key.into()),
        display_name_override: None,
        enabled: true,
        availability: Availability::Available,
        remote_metadata_json: None,
        capability_overrides_json: None,
        adapter_id: adapter_id.map(Into::into),
        source_adapter_id: source.into(),
        last_seen_at: None,
        created_at: now.clone(),
        updated_at: now.clone(),
      };
      // Effective adapter resolves through provenance to the legacy default binding.
      provider_models::insert(
        uow.conn(),
        &model(enabled_provider, "legacy-model", None, "openai-compatible"),
      )?;
      // Effective adapter resolves through the explicit override to the wasm interface binding.
      provider_models::insert(
        uow.conn(),
        &model(enabled_provider, "wasm-model", Some("anthropic"), "openai-compatible"),
      )?;
      // Disabled provider: one model still resolves to its legacy default binding.
      provider_models::insert(
        uow.conn(),
        &model(disabled_provider, "disabled-model", None, "openai-compatible"),
      )?;
      Ok::<_, crate::error::StorageError>(())
    })
    .expect("fixture");

    let report = inventory.list_inventory().unwrap();
    let entry = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == "legacy-frontend-provider:openai-compatible")
      .expect("openai-compatible provider inventory entry");
    assert_eq!(
      entry.enabled_legacy_row_count, 1,
      "only the enabled provider's legacy binding"
    );
    assert_eq!(entry.disabled_legacy_row_count, 1);
    assert_eq!(entry.dependent_row_count, 2, "models resolving to legacy bindings only");
    assert_eq!(entry.unresolved_rows.len(), 2, "wasm bindings are not unresolved rows");
    assert!(
      report
        .entries
        .iter()
        .all(|entry| entry.executor_id != "legacy-frontend-provider:anthropic"),
      "no legacy slice for the wasm-only adapter"
    );
    let enabled_row = entry
      .unresolved_rows
      .iter()
      .find(|row| row.subject_id == enabled_provider.to_string())
      .expect("enabled provider row");
    let disabled_row = entry
      .unresolved_rows
      .iter()
      .find(|row| row.subject_id == disabled_provider.to_string())
      .expect("disabled provider row");
    assert!(enabled_row.enabled);
    assert!(!disabled_row.enabled);
    assert_eq!(enabled_row.adapter_id.as_deref(), Some("openai-compatible"));
    assert_eq!(enabled_row.dependency_count, 1);
    assert_eq!(disabled_row.dependency_count, 1);
    assert_eq!(enabled_row.subject_kind, LegacyRuntimeSubjectKind::ProviderBinding);
    assert_eq!(
      enabled_row.update_token,
      db.read(|conn| provider_runtime_bindings::get(conn, enabled_provider, "openai-compatible").map(|b| b.updated_at))
        .unwrap()
    );
    assert!(enabled_row.disable_available);
    assert!(!disabled_row.disable_available);
  }

  #[test]
  fn legacy_runtime_inventory_provider_per_adapter_digest() {
    let (dir, db, packages, activation, _inventory) = setup();
    let openai_digest = install_and_authorize_provider_default(&db, &packages, dir.path(), OPENAI_COMPATIBLE_PACKAGE);
    let anthropic_digest = install_and_authorize_provider_default(&db, &packages, dir.path(), ANTHROPIC_PACKAGE);
    assert_ne!(openai_digest, anthropic_digest);
    seed_legacy_provider(&db, "openai-compatible", "OpenAI provider", true);
    seed_legacy_provider(&db, "anthropic", "Anthropic provider", true);

    let inventory = catalog_inventory(db, activation, packages);
    let report = inventory.list_inventory().unwrap();

    let openai_entry = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == "legacy-frontend-provider:openai-compatible")
      .expect("openai entry");
    let anthropic_entry = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == "legacy-frontend-provider:anthropic")
      .expect("anthropic entry");
    assert_eq!(
      openai_entry.default_package_digest.as_deref(),
      Some(openai_digest.as_str())
    );
    assert_eq!(
      anthropic_entry.default_package_digest.as_deref(),
      Some(anthropic_digest.as_str())
    );
    assert!(openai_entry.package_first_create_ready);
    assert!(anthropic_entry.package_first_create_ready);
    assert_eq!(openai_entry.unresolved_rows.len(), 1);
    assert_eq!(
      openai_entry.unresolved_rows[0].replacement_package_digest.as_deref(),
      Some(openai_digest.as_str())
    );
    assert!(openai_entry.unresolved_rows[0].migrate_available);
    assert_eq!(
      anthropic_entry.unresolved_rows[0].replacement_package_digest.as_deref(),
      Some(anthropic_digest.as_str())
    );
    assert!(anthropic_entry.unresolved_rows[0].migrate_available);
  }

  #[test]
  fn legacy_runtime_inventory_provider_ambiguous_default_blocks_migration() {
    let (dir, db, packages, activation, _inventory) = setup();
    // Two distinct authorized defaults both alias `openai-compatible`: migration must fail closed.
    install_and_authorize_provider_default(&db, &packages, dir.path(), OPENAI_COMPATIBLE_PACKAGE);
    install_and_authorize_provider_default(&db, &packages, dir.path(), LLM_PROVIDER_PACKAGE);
    seed_legacy_provider(&db, "openai-compatible", "OpenAI provider", true);

    let inventory = catalog_inventory(db, activation, packages);
    let report = inventory.list_inventory().unwrap();
    let entry = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == "legacy-frontend-provider:openai-compatible")
      .expect("openai entry");
    assert!(
      entry.default_package_digest.is_none(),
      "ambiguous default must not pick a digest"
    );
    assert!(!entry.package_first_create_ready);
    assert!(entry.legacy_create_still_possible, "gate is off in this fixture");
    assert!(
      entry.blocker_codes.iter().any(|code| code == BLOCKER_AMBIGUOUS_DEFAULT),
      "ambiguous blocker reported: {:?}",
      entry.blocker_codes
    );
    assert!(!entry.retirement_ready);
    let row = &entry.unresolved_rows[0];
    assert!(row.replacement_package_digest.is_none());
    assert!(!row.migrate_available);
  }

  #[test]
  fn legacy_runtime_inventory_reports_zero_row_catalog_aliases_before_retirement_gate() {
    // Both packages are installed, but only the OpenAI-compatible default is authorized.
    // Neither adapter has a provider row or a legacy binding: the verified catalog aliases
    // alone must produce inventory entries so release review can verify readiness before
    // any adapter joins the retirement gate.
    let (dir, db, packages, activation, _inventory) = setup();
    install_and_authorize_provider_default(&db, &packages, dir.path(), OPENAI_COMPATIBLE_PACKAGE);
    packages
      .bootstrap_bundled_package(ANTHROPIC_PACKAGE, false)
      .expect("install anthropic package");

    let inventory = catalog_inventory(db, activation, packages);
    let report = inventory.list_inventory().unwrap();

    let openai_entry = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == "legacy-frontend-provider:openai-compatible")
      .expect("zero-row openai-compatible catalog alias entry");
    assert_eq!(openai_entry.enabled_legacy_row_count, 0);
    assert_eq!(openai_entry.disabled_legacy_row_count, 0);
    assert_eq!(openai_entry.dependent_row_count, 0);
    assert_eq!(openai_entry.pending_activation_count, 0);
    assert_eq!(openai_entry.unavailable_activation_count, 0);
    assert_eq!(openai_entry.default_authorization_status, "authorized");
    assert!(openai_entry.package_first_create_ready);
    assert!(!openai_entry.legacy_create_still_possible);
    assert!(
      openai_entry.blocker_codes.is_empty(),
      "authorized zero-row slice has no blockers: {:?}",
      openai_entry.blocker_codes
    );
    assert!(openai_entry.retirement_ready);
    assert!(openai_entry.unresolved_rows.is_empty());

    let anthropic_entry = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == "legacy-frontend-provider:anthropic")
      .expect("zero-row anthropic catalog alias entry");
    assert_eq!(anthropic_entry.enabled_legacy_row_count, 0);
    assert_eq!(anthropic_entry.pending_activation_count, 0);
    assert_eq!(anthropic_entry.unavailable_activation_count, 0);
    assert!(!anthropic_entry.package_first_create_ready);
    assert!(anthropic_entry.legacy_create_still_possible, "gate is off in this fixture");
    assert!(!anthropic_entry.retirement_ready);
    assert!(
      anthropic_entry
        .blocker_codes
        .iter()
        .any(|code| code == BLOCKER_AUTHORIZED_DEFAULT_MISSING),
      "unauthorized zero-row slice reports the missing default blocker: {:?}",
      anthropic_entry.blocker_codes
    );
    assert!(anthropic_entry.unresolved_rows.is_empty());
  }

  #[test]
  fn legacy_runtime_inventory_provider_zero_match_blocks_migration() {
    let (_dir, db, _packages, activation, _inventory) = setup();
    seed_legacy_provider(&db, "deepseek", "DeepSeek provider", true);

    // Unwired catalog behaves identically to a missing compatible package: zero candidates.
    let inventory = LegacyRuntimeInventoryService::create(db, activation);
    let report = inventory.list_inventory().unwrap();
    let entry = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == "legacy-frontend-provider:deepseek")
      .expect("deepseek entry");
    assert!(entry.default_package_digest.is_none());
    assert!(!entry.package_first_create_ready);
    assert!(
      entry
        .blocker_codes
        .iter()
        .any(|code| code == BLOCKER_AUTHORIZED_DEFAULT_MISSING)
    );
    let row = &entry.unresolved_rows[0];
    assert!(row.replacement_package_digest.is_none());
    assert!(!row.migrate_available);
  }

  #[test]
  fn legacy_runtime_inventory_provider_readiness_is_per_adapter() {
    let (dir, db, packages, activation, _inventory) = setup();
    install_and_authorize_provider_default(&db, &packages, dir.path(), OPENAI_COMPATIBLE_PACKAGE);
    install_and_authorize_provider_default(&db, &packages, dir.path(), ANTHROPIC_PACKAGE);
    seed_legacy_provider(&db, "openai-compatible", "Enabled provider", true);
    seed_legacy_provider(&db, "anthropic", "Disabled provider", false);

    let inventory = catalog_inventory(db, activation, packages);
    let report = inventory.list_inventory().unwrap();

    let openai_entry = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == "legacy-frontend-provider:openai-compatible")
      .expect("openai entry");
    let anthropic_entry = report
      .entries
      .iter()
      .find(|entry| entry.executor_id == "legacy-frontend-provider:anthropic")
      .expect("anthropic entry");
    assert_eq!(
      openai_entry.enabled_legacy_row_count, 1,
      "only adapter A has enabled rows"
    );
    assert_eq!(anthropic_entry.enabled_legacy_row_count, 0);
    assert!(!openai_entry.retirement_ready, "enabled rows block adapter A readiness");
    assert!(
      anthropic_entry.retirement_ready,
      "zero enabled rows, authorized default, and no blockers release adapter B: {:?}",
      anthropic_entry.blocker_codes
    );
  }
}
