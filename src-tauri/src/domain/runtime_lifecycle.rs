// ABOUTME: Runtime pin, upgrade, rollback, and export-requirement domain types.
// ABOUTME: Snapshots and DTOs exclude secrets, credential refs, and package bytes.
use crate::domain::plugin_package::runtime_kind_storage;
use crate::domain::runtime_plugin::{GrantSetRevision, PackageDigest, RuntimeKind};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Preview session lifetime before an opaque upgrade/rollback preview expires.
pub const RUNTIME_PREVIEW_TTL_SECS: u64 = 10 * 60;
/// Maximum retained non-discarded rollback snapshots per integration instance.
pub const MAX_ROLLBACK_SNAPSHOTS_PER_INSTANCE: usize = 8;

/// Host-owned runtime pin state for an integration instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceRuntimeState {
  Active,
  PendingActivation,
  Unavailable,
}

impl InstanceRuntimeState {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Active => "active",
      Self::PendingActivation => "pending_activation",
      Self::Unavailable => "unavailable",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "active" => Ok(Self::Active),
      "pending_activation" => Ok(Self::PendingActivation),
      "unavailable" => Ok(Self::Unavailable),
      other => Err(format!("invalid runtime_state: {other}")),
    }
  }
}

/// Parse a kebab-case runtime kind stored in SQLite.
pub fn parse_runtime_kind(value: &str) -> Result<RuntimeKind, String> {
  match value {
    "bundled-rust" => Ok(RuntimeKind::BundledRust),
    "wasm-component" => Ok(RuntimeKind::WasmComponent),
    "legacy-frontend-provider" => Ok(RuntimeKind::LegacyFrontendProvider),
    "trusted-native-worker" => Ok(RuntimeKind::TrustedNativeWorker),
    other => Err(format!("invalid runtime_kind: {other}")),
  }
}

/// Stable storage string for a runtime kind.
pub fn runtime_kind_as_str(kind: RuntimeKind) -> &'static str {
  runtime_kind_storage(kind)
}

/// Exact runtime identity resolved from the authoritative instance row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRuntimeIdentity {
  pub runtime_kind: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub package_digest: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub execution_grant_set_revision: Option<u64>,
  pub runtime_state: InstanceRuntimeState,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub runtime_error_code: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub runtime_error_message: Option<String>,
}

impl InstanceRuntimeIdentity {
  pub fn bundled_active() -> Self {
    Self {
      runtime_kind: runtime_kind_as_str(RuntimeKind::BundledRust).to_string(),
      package_digest: None,
      execution_grant_set_revision: None,
      runtime_state: InstanceRuntimeState::Active,
      runtime_error_code: None,
      runtime_error_message: None,
    }
  }

  pub fn wasm_active(package_digest: &str, grant_revision: GrantSetRevision) -> Result<Self, String> {
    let digest = PackageDigest::parse(package_digest)?;
    Ok(Self {
      runtime_kind: runtime_kind_as_str(RuntimeKind::WasmComponent).to_string(),
      package_digest: Some(digest.as_str().to_string()),
      execution_grant_set_revision: Some(grant_revision.as_u64()),
      runtime_state: InstanceRuntimeState::Active,
      runtime_error_code: None,
      runtime_error_message: None,
    })
  }
}

/// Subject kind for an execution grant-set header.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantSubjectKind {
  IntegrationInstance,
  ProviderInstance,
}

impl GrantSubjectKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::IntegrationInstance => "integration_instance",
      Self::ProviderInstance => "provider_instance",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "integration_instance" => Ok(Self::IntegrationInstance),
      "provider_instance" => Ok(Self::ProviderInstance),
      other => Err(format!("invalid grant subject kind: {other}")),
    }
  }
}

/// Persisted execution grant-set header (no child authority entries).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionGrantSetRecord {
  pub id: Uuid,
  pub revision: u64,
  pub subject_kind: GrantSubjectKind,
  pub subject_id: Uuid,
  pub plugin_id: String,
  pub plugin_version: String,
  pub package_digest: String,
  pub permission_request_digest: String,
  pub authority_digest: String,
  pub approved_at: String,
}

/// Capability major entry stored under a grant-set revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityGrantEntryRecord {
  pub id: Uuid,
  pub grant_set_id: Uuid,
  pub capability_id: String,
}

/// Capability network authority entry under a grant-set revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkGrantEntryRecord {
  pub id: Uuid,
  pub grant_set_id: Uuid,
  pub capability_id: String,
  pub endpoint_id: String,
  pub origin: String,
  /// Manifest-bound origin provenance. Missing legacy snapshot fields fail closed as dynamic.
  #[serde(default = "default_network_origin_kind")]
  pub origin_kind: String,
  pub method: String,
  pub auth_policy: String,
  /// Host-reviewed resource mode (`bounded`).
  pub resource_mode: String,
  pub max_request_bytes: u64,
  pub max_response_bytes: u64,
  pub max_stream_bytes: u64,
  pub timeout_ms: u64,
  /// Allowed broker response body modes (`json`, `json,bytes`, …). Default preserves legacy grants.
  #[serde(default = "default_response_body_modes")]
  pub response_body_modes: String,
}

fn default_network_origin_kind() -> String {
  "instance_configured".into()
}

fn default_response_body_modes() -> String {
  crate::domain::plugin_resource::NetworkResponseBodyModes::JSON_ONLY.as_canonical()
}

/// Page authority entry under a grant-set revision (empty until Phase 9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageGrantEntryRecord {
  pub id: Uuid,
  pub grant_set_id: Uuid,
  pub page_id: String,
  pub allowed_actions: Vec<String>,
  pub delegated_capability_majors: Vec<String>,
  pub delegated_endpoint_aliases: Vec<String>,
}

/// Complete persisted grant set with child authority entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionGrantSetBundle {
  pub header: ExecutionGrantSetRecord,
  pub capabilities: Vec<CapabilityGrantEntryRecord>,
  pub network: Vec<NetworkGrantEntryRecord>,
  pub pages: Vec<PageGrantEntryRecord>,
}

/// Non-secret preference snapshot for one dependent domain row.
/// `preferences_json` is the exact SQLite TEXT payload (no re-serialization).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceSnapshotRow {
  pub kind: String,
  pub id: Uuid,
  /// Owning integration instance at snapshot time (CAS ownership check on restore).
  pub integration_instance_id: Uuid,
  /// Bound capability id for this row (exact match against target manifest capabilities).
  #[serde(default)]
  pub capability_id: String,
  pub schema_version: i32,
  pub preferences_json: String,
  pub updated_at: String,
}

/// Host-owned upgrade rollback snapshot (no secrets or credential refs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpgradeSnapshot {
  pub id: Uuid,
  pub integration_instance_id: Uuid,
  pub created_at: String,
  pub discarded_at: Option<String>,
  pub runtime_kind: String,
  pub package_digest: Option<String>,
  pub execution_grant_set_id: Option<Uuid>,
  pub execution_grant_set_revision: Option<u64>,
  pub plugin_version: String,
  pub config_json: String,
  pub config_schema_version: u32,
  pub grant_snapshot_json: Option<String>,
  pub translation_preferences: Vec<PreferenceSnapshotRow>,
  pub ocr_preferences: Vec<PreferenceSnapshotRow>,
  pub speech_preferences: Vec<PreferenceSnapshotRow>,
}

/// Sanitized runtime identity for IPC DTOs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdentityDto {
  pub runtime_kind: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub package_digest: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub execution_grant_set_revision: Option<u64>,
  pub runtime_state: InstanceRuntimeState,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub runtime_error_code: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub runtime_error_message: Option<String>,
}

impl From<&InstanceRuntimeIdentity> for RuntimeIdentityDto {
  fn from(value: &InstanceRuntimeIdentity) -> Self {
    Self {
      runtime_kind: value.runtime_kind.clone(),
      package_digest: value.package_digest.clone(),
      execution_grant_set_revision: value.execution_grant_set_revision,
      runtime_state: value.runtime_state,
      runtime_error_code: value.runtime_error_code.clone(),
      runtime_error_message: value.runtime_error_message.clone(),
    }
  }
}

/// Publisher identity for upgrade approval UI (never includes key material).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherIdentityDto {
  pub key_id: String,
  pub key_fingerprint: String,
}

/// Permission difference surfaced during upgrade preview (structured fields for UI).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDifferenceDto {
  pub kind: String,
  pub summary: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub resource: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub origin: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub method: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub auth_policy: Option<String>,
}

/// Capability compatibility note for upgrade preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityCompatibilityDto {
  pub capability_id: String,
  pub status: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
}

/// Schema migration outcome for config or one preference row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaMigrationDto {
  pub kind: String,
  pub from_version: u32,
  pub to_version: u32,
  pub status: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
}

/// Credential slot compatibility for upgrade preview (no secrets).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSlotCompatibilityDto {
  pub slot_id: String,
  pub status: String,
  pub required: bool,
  /// Target slot kind (`secret_text` / `secret_json`). Never a secret value.
  pub kind: String,
}

/// Upgrade preview returned to the frontend (no secrets, absolute paths, or package bytes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpgradePreviewDto {
  pub preview_id: String,
  pub instance_id: Uuid,
  pub source: RuntimeIdentityDto,
  pub target: RuntimeIdentityDto,
  pub source_plugin_version: String,
  pub target_plugin_version: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub source_publisher: Option<PublisherIdentityDto>,
  pub target_publisher: PublisherIdentityDto,
  pub requires_permission_approval: bool,
  pub requires_publisher_reapproval: bool,
  pub capability_compatibility: Vec<CapabilityCompatibilityDto>,
  pub schema_migrations: Vec<SchemaMigrationDto>,
  pub credential_slots: Vec<CredentialSlotCompatibilityDto>,
  pub permission_differences: Vec<PermissionDifferenceDto>,
  pub expires_at: String,
}

/// Apply input bound to an opaque upgrade preview.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRuntimeUpgradeInput {
  pub preview_id: String,
  #[serde(default)]
  pub acknowledge_permissions: bool,
}

/// Rollback preview showing the stored prior host-owned state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRollbackPreviewDto {
  pub preview_id: String,
  pub instance_id: Uuid,
  pub snapshot_id: Uuid,
  pub current: RuntimeIdentityDto,
  pub target: RuntimeIdentityDto,
  pub target_plugin_version: String,
  pub expires_at: String,
}

/// Apply input bound to an opaque rollback preview.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRuntimeRollbackInput {
  pub preview_id: String,
}

/// Result of apply upgrade/rollback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLifecycleResultDto {
  pub instance_id: Uuid,
  pub runtime: RuntimeIdentityDto,
  pub plugin_version: String,
  pub updated_at: String,
}

/// Generic runtime requirement carried in export format v7 (no package bytes/grants).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRequirementExport {
  pub plugin_id: String,
  pub plugin_version: String,
  pub runtime_kind: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub package_digest: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub publisher_key_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub publisher_key_fingerprint: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub plugin_api_version: Option<String>,
  pub config_schema_version: u32,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub required_capability_majors: Vec<String>,
  /// Reserved for Phase 8/11 provider runtime fields without mutating v7 semantics.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub provider_runtime_kind: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub provider_package_digest: Option<String>,
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bundled_identity_has_no_package_pin() {
    let identity = InstanceRuntimeIdentity::bundled_active();
    assert_eq!(identity.runtime_kind, "bundled-rust");
    assert!(identity.package_digest.is_none());
    assert!(identity.execution_grant_set_revision.is_none());
  }

  #[test]
  fn wasm_identity_requires_digest_and_revision() {
    let digest = "a".repeat(64);
    let identity = InstanceRuntimeIdentity::wasm_active(&digest, GrantSetRevision::INITIAL).unwrap();
    assert_eq!(identity.runtime_kind, "wasm-component");
    assert_eq!(identity.package_digest.as_deref(), Some(digest.as_str()));
    assert_eq!(identity.execution_grant_set_revision, Some(1));
  }
}
