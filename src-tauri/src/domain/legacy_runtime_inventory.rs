// ABOUTME: Sanitized DTOs for Phase 12 legacy executor retirement inventory.
// ABOUTME: Read-only readiness report; never secrets, grants, or package bytes.
use serde::{Deserialize, Serialize};

/// Stable blocker codes for fail-closed retirement readiness.
pub const BLOCKER_AUTHORIZED_DEFAULT_MISSING: &str = "authorized_default_missing";
pub const BLOCKER_DEFAULT_UNAUTHORIZED: &str = "default_unauthorized";
pub const BLOCKER_DEFAULT_STALE: &str = "default_stale";
pub const BLOCKER_PACKAGE_FIRST_NOT_READY: &str = "package_first_not_ready";
pub const BLOCKER_PENDING_ACTIVATIONS: &str = "pending_activations";
pub const BLOCKER_UNAVAILABLE_ACTIVATIONS: &str = "unavailable_activations";
pub const BLOCKER_ENABLED_LEGACY_ROWS: &str = "enabled_legacy_rows";
pub const BLOCKER_LEGACY_CREATE_STILL_POSSIBLE: &str = "legacy_create_still_possible";
pub const BLOCKER_DISABLED_DEPENDENT_ROWS: &str = "disabled_dependent_rows";
pub const BLOCKER_AMBIGUOUS_DEFAULT: &str = "ambiguous_default";

/// One legacy executor slice and its package-first retirement readiness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRuntimeInventoryEntryDto {
  pub executor_id: String,
  pub runtime_kind: String,
  pub enabled_legacy_row_count: u64,
  pub disabled_legacy_row_count: u64,
  pub dependent_row_count: u64,
  pub replacement_installed_count: u64,
  pub default_package_digest: Option<String>,
  pub default_authorization_status: String,
  pub package_first_create_ready: bool,
  pub pending_activation_count: u64,
  pub unavailable_activation_count: u64,
  pub legacy_create_still_possible: bool,
  pub blocker_codes: Vec<String>,
  pub retirement_ready: bool,
  /// Row-level unresolved legacy identities and remediation action readiness.
  #[serde(default)]
  pub unresolved_rows: Vec<LegacyRuntimeUnresolvedRowDto>,
}

/// Closed subject kind tokens for unresolved legacy rows.
///
/// Serializes to the existing snake-case tokens so the JSON contract stays stable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyRuntimeSubjectKind {
  IntegrationInstance,
  ProviderBinding,
}

impl LegacyRuntimeSubjectKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::IntegrationInstance => "integration_instance",
      Self::ProviderBinding => "provider_binding",
    }
  }
}

/// One unresolved legacy row with sanitized identity and action readiness.
///
/// Never includes config JSON, credentials, grants, package bytes, paths, or publisher keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRuntimeUnresolvedRowDto {
  pub subject_kind: LegacyRuntimeSubjectKind,
  pub subject_id: String,
  /// Provider rows carry the binding adapter id; integration rows omit it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub adapter_id: Option<String>,
  pub display_name: String,
  pub enabled: bool,
  /// Live dependent resources (profiles/OCR/speech for integrations; models for providers).
  pub dependency_count: u64,
  /// CAS update token for enabled/disabled transitions; never a secret.
  pub update_token: String,
  /// Exact authorized replacement package digest when migration is possible.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub replacement_package_digest: Option<String>,
  /// Migration requires an exact authorized replacement package for the executor.
  pub migrate_available: bool,
  /// Disable is meaningful only for currently enabled rows.
  pub disable_available: bool,
  /// Delete stays visible with dependencies; blocked rows report `dependency_count`.
  pub delete_available: bool,
}

/// Retirement-only provider deletion input with CAS authority.
///
/// The inventory binding `update_token` is the row-level CAS; a stale token aborts before
/// any credential or database change. Never carries secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetirementDeleteProviderInput {
  pub provider_id: String,
  pub adapter_id: String,
  pub update_token: String,
}

/// Full inventory returned by the trusted-app IPC command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRuntimeInventoryDto {
  pub entries: Vec<LegacyRuntimeInventoryEntryDto>,
}
