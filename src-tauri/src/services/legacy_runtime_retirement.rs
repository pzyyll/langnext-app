// ABOUTME: Explicit per-executor retirement gates for package-first create paths.
// ABOUTME: Defaults empty/disabled until Phase 12 enables a specific legacy executor slice.
use crate::error::StorageError;
use crate::services::default_package_activation::PackageFirstCreateResolution;
use std::collections::BTreeSet;

/// Explicit closed set of retired integration executor IDs plus retired provider adapter IDs.
///
/// Production wiring defaults to empty. Tests and Phase 12 releases construct a non-empty
/// gate only when a stable-release retirement slice is intentionally enabled.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyRuntimeRetirementGate {
  /// Integration plugin/executor IDs for which legacy create is retired.
  retired_integration_executor_ids: BTreeSet<String>,
  /// Provider adapter IDs for which legacy-frontend create is retired without package-first.
  retired_provider_adapter_ids: BTreeSet<String>,
}

impl LegacyRuntimeRetirementGate {
  /// Production default: no executor is retired.
  pub fn disabled() -> Self {
    Self::default()
  }

  /// Build a gate with explicit retired integration executors and provider adapter IDs.
  pub fn with_executors(
    retired_integration_executor_ids: impl IntoIterator<Item = impl Into<String>>,
    retired_provider_adapter_ids: impl IntoIterator<Item = impl Into<String>>,
  ) -> Self {
    Self {
      retired_integration_executor_ids: retired_integration_executor_ids.into_iter().map(Into::into).collect(),
      retired_provider_adapter_ids: retired_provider_adapter_ids.into_iter().map(Into::into).collect(),
    }
  }

  /// True when legacy create for this integration executor is retired.
  pub fn is_integration_executor_retired(&self, executor_id: &str) -> bool {
    self.retired_integration_executor_ids.contains(executor_id)
  }

  /// True when legacy create for this provider adapter is retired.
  pub fn is_provider_legacy_retired(&self, adapter_id: &str) -> bool {
    self.retired_provider_adapter_ids.contains(adapter_id)
  }

  /// Retired provider adapter IDs. Inventory reports a slice for each so release review
  /// still sees blockers and readiness while the adapter has zero legacy bindings.
  pub fn retired_provider_adapters(&self) -> impl Iterator<Item = &str> + '_ {
    self.retired_provider_adapter_ids.iter().map(String::as_str)
  }

  /// Reject create when the executor is retired and no authorized package-first path is ready.
  pub fn require_package_first_for_integration(
    &self,
    executor_id: &str,
    package_first: &PackageFirstCreateResolution,
  ) -> Result<(), StorageError> {
    if !self.is_integration_executor_retired(executor_id) {
      return Ok(());
    }
    match package_first {
      PackageFirstCreateResolution::Ready(_) => Ok(()),
      PackageFirstCreateResolution::NoDefault => Err(StorageError::Validation(format!(
        "legacy executor {executor_id} is retired; install and authorize a default package first"
      ))),
      PackageFirstCreateResolution::Blocked(blocked) => Err(StorageError::Validation(format!(
        "legacy executor {executor_id} is retired; package-first create is blocked: {}",
        blocked.reason.as_error_code()
      ))),
    }
  }

  /// Reject provider create when this adapter's provider-legacy gate is enabled without
  /// package-first readiness.
  pub fn require_package_first_for_provider(
    &self,
    adapter_id: &str,
    package_first: &PackageFirstCreateResolution,
  ) -> Result<(), StorageError> {
    if !self.is_provider_legacy_retired(adapter_id) {
      return Ok(());
    }
    match package_first {
      PackageFirstCreateResolution::Ready(_) => Ok(()),
      PackageFirstCreateResolution::NoDefault => Err(StorageError::Validation(format!(
        "provider legacy create for adapter {adapter_id} is retired; install and authorize a default package first"
      ))),
      PackageFirstCreateResolution::Blocked(blocked) => Err(StorageError::Validation(format!(
        "provider legacy create for adapter {adapter_id} is retired; package-first create is blocked: {}",
        blocked.reason.as_error_code()
      ))),
    }
  }
}

/// The three integration executors in the Phase 12 production retirement slice, in release
/// order: Google Translate Web, Edge TTS, then Google Cloud. PaddleOCR is not in scope.
pub const PRODUCTION_RETIRED_INTEGRATION_EXECUTORS: &[&str] = &[
  crate::domain::service_integration::GOOGLE_TRANSLATE_WEB_PLUGIN_ID,
  crate::domain::service_integration::EDGE_TTS_PLUGIN_ID,
  crate::domain::service_integration::GOOGLE_CLOUD_PLUGIN_ID,
];

/// Provider adapters with production retirement evidence. Empty until a release record
/// identifies an eligible adapter: an installed package version and the prior stable
/// application release that carried it. Inventory still reports per-adapter readiness.
pub const PRODUCTION_RETIRED_PROVIDER_ADAPTERS: &[&str] = &[];

impl LegacyRuntimeRetirementGate {
  /// The production Phase 12 retirement gate: the ordered three-executor integration slice and
  /// the empty provider-adapter allowlist. Wiring this gate into `state.rs` flips production
  /// retirement on; the release blocker requires packaged replacement packages and an authorized
  /// default policy per executor before that flip ships (see the Phase 12 plan).
  pub fn production() -> Self {
    Self::with_executors(
      PRODUCTION_RETIRED_INTEGRATION_EXECUTORS.iter().copied(),
      PRODUCTION_RETIRED_PROVIDER_ADAPTERS.iter().copied(),
    )
  }
}

/// Execution release gate: executor ids whose inventory slice is fully retirement-ready.
///
/// Derived from the inventory (`retirement_ready` per entry), never from the creation policy
/// directly. A released executor may deny bundled resolution; slices with enabled legacy rows
/// or any blocker stay available until the user remediates.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyRuntimeReleaseGate {
  released_executor_ids: BTreeSet<String>,
}

impl LegacyRuntimeReleaseGate {
  /// No executor is released for execution removal.
  pub fn empty() -> Self {
    Self::default()
  }

  /// Build a release gate from explicit executor ids (inventory-derived in production).
  pub fn with_released(executor_ids: impl IntoIterator<Item = impl Into<String>>) -> Self {
    Self {
      released_executor_ids: executor_ids.into_iter().map(Into::into).collect(),
    }
  }

  /// True when this executor's inventory slice is fully ready and may stop serving.
  pub fn is_executor_released(&self, executor_id: &str) -> bool {
    self.released_executor_ids.contains(executor_id)
  }
}
