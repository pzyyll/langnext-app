// ABOUTME: Service integration domain entities, manifests, and sanitized IPC DTOs.
// ABOUTME: Credential refs and secret values never appear on serializable DTOs.
use crate::domain::provider::{CredentialUpdate, ProxyMode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Maximum display name length for integration instances.
pub const INTEGRATION_DISPLAY_NAME_MAX_LEN: usize = 128;
/// Maximum non-secret config_json size (bytes).
pub const INTEGRATION_CONFIG_JSON_MAX_LEN: usize = 8 * 1024;
/// Maximum service-account JSON size accepted on write (bytes).
pub const SERVICE_ACCOUNT_JSON_MAX_LEN: usize = 64 * 1024;
/// Maximum plugin id length.
pub const PLUGIN_ID_MAX_LEN: usize = 128;
/// Maximum capability id length.
pub const CAPABILITY_ID_MAX_LEN: usize = 128;
/// Maximum credential slot id length.
pub const SLOT_ID_MAX_LEN: usize = 64;
/// Google Cloud bundled plugin id.
pub const GOOGLE_CLOUD_PLUGIN_ID: &str = "com.langnext.google-cloud";
/// Google Cloud service-account credential slot.
pub const GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT: &str = "service-account-json";
/// Pinned Google OAuth token URI required in service-account JSON.
pub const GOOGLE_OAUTH_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
/// Default Cloud Translation location.
pub const GOOGLE_CLOUD_DEFAULT_LOCATION: &str = "global";

/// Persisted health values only (never disabled/plugin_missing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationHealthStatus {
  Unconfigured,
  Unvalidated,
  Ready,
  Degraded,
}

impl IntegrationHealthStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Unconfigured => "unconfigured",
      Self::Unvalidated => "unvalidated",
      Self::Ready => "ready",
      Self::Degraded => "degraded",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "unconfigured" => Ok(Self::Unconfigured),
      "unvalidated" => Ok(Self::Unvalidated),
      "ready" => Ok(Self::Ready),
      "degraded" => Ok(Self::Degraded),
      other => Err(format!("invalid health_status: {other}")),
    }
  }
}

/// DTO effective status: persisted health plus derived disabled/plugin_missing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationEffectiveStatus {
  Unconfigured,
  Unvalidated,
  Ready,
  Degraded,
  Disabled,
  PluginMissing,
}

impl IntegrationEffectiveStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Unconfigured => "unconfigured",
      Self::Unvalidated => "unvalidated",
      Self::Ready => "ready",
      Self::Degraded => "degraded",
      Self::Disabled => "disabled",
      Self::PluginMissing => "plugin_missing",
    }
  }
}

/// Credential slot kind declared by a bundled definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialSlotKind {
  SecretJson,
}

impl CredentialSlotKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::SecretJson => "secret_json",
    }
  }
}

/// Host-owned credential slot descriptor on a definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSlotDescriptor {
  pub id: String,
  pub kind: CredentialSlotKind,
  pub required: bool,
}

/// Capability descriptor exposed by a definition (metadata only in Phase 1A).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCapabilityDescriptor {
  pub id: String,
  pub preferences_schema_version: u32,
  /// Endpoint aliases this capability may use (must be declared on the manifest).
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub endpoint_aliases: Vec<String>,
}

/// Pinned endpoint grant alias → base URL (policy metadata only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointGrant {
  pub alias: String,
  pub base_url: String,
}

/// Bundled service integration definition (internal + sanitized DTO shape).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceIntegrationManifest {
  pub manifest_version: u32,
  pub plugin_api_version: String,
  pub id: String,
  pub version: String,
  pub display_name_key: String,
  pub min_host_version: String,
  pub config_schema_version: u32,
  pub credential_slots: Vec<CredentialSlotDescriptor>,
  pub endpoints: Vec<EndpointGrant>,
  pub capabilities: Vec<IntegrationCapabilityDescriptor>,
}

/// Internal integration instance row (no secret values).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationInstance {
  pub id: Uuid,
  pub plugin_id: String,
  pub plugin_version: String,
  pub display_name: String,
  pub enabled: bool,
  pub config_json: String,
  pub config_schema_version: u32,
  pub health_status: IntegrationHealthStatus,
  pub last_validated_at: Option<String>,
  pub last_error_code: Option<String>,
  pub created_at: String,
  pub updated_at: String,
}

/// Internal credential binding row (opaque vault ref stays internal).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationCredentialBinding {
  pub id: Uuid,
  pub integration_instance_id: Uuid,
  pub slot_id: String,
  pub credential_ref: Option<String>,
  pub credential_revision: i64,
  pub created_at: String,
  pub updated_at: String,
}

/// Sanitized slot status for IPC (no refs/secrets).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSlotStatusDto {
  pub slot_id: String,
  pub has_credential: bool,
  pub credential_revision: i64,
}

/// Sanitized integration instance DTO for IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationInstanceDto {
  pub id: Uuid,
  pub plugin_id: String,
  pub plugin_version: String,
  pub display_name: String,
  pub enabled: bool,
  /// Non-secret common config JSON string.
  pub config_json: String,
  pub config_schema_version: u32,
  pub health_status: IntegrationHealthStatus,
  pub effective_status: IntegrationEffectiveStatus,
  pub last_validated_at: Option<String>,
  pub last_error_code: Option<String>,
  pub credential_slots: Vec<CredentialSlotStatusDto>,
  pub created_at: String,
  pub updated_at: String,
}

/// Per-slot credential mutation on save.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationSlotCredentialWrite {
  pub slot_id: String,
  #[serde(default)]
  pub credential: CredentialUpdate,
}

/// Input for creating or updating an integration instance.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationInstanceWrite {
  pub id: Option<Uuid>,
  pub plugin_id: String,
  pub display_name: String,
  pub enabled: bool,
  /// Non-secret common config JSON string.
  pub config_json: String,
  #[serde(default)]
  pub credentials: Vec<IntegrationSlotCredentialWrite>,
  /// Required on update.
  #[serde(default)]
  pub expected_updated_at: Option<String>,
}

/// Domain resource depending on an integration instance (empty until Phase 1C/3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationDependencyDto {
  pub kind: String,
  pub id: Uuid,
  pub display_name: String,
}

/// Local-only validation result (Phase 1A never claims remote/IAM health).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationValidationResult {
  pub instance_id: Uuid,
  pub health_status: IntegrationHealthStatus,
  pub effective_status: IntegrationEffectiveStatus,
  pub remote_checked: bool,
  pub message: Option<String>,
}

/// Google Cloud non-secret config (schema v1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCloudConfigV1 {
  pub project_id: String,
  #[serde(default = "default_google_location")]
  pub location: String,
  pub proxy_mode: ProxyMode,
}

fn default_google_location() -> String {
  GOOGLE_CLOUD_DEFAULT_LOCATION.to_string()
}

/// Validate reverse-domain plugin ids (ASCII, bounded).
pub fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
  let trimmed = plugin_id.trim();
  if trimmed.is_empty() {
    return Err("plugin_id is required".into());
  }
  if trimmed.len() > PLUGIN_ID_MAX_LEN {
    return Err(format!("plugin_id exceeds {PLUGIN_ID_MAX_LEN} characters"));
  }
  if !trimmed.is_ascii() {
    return Err("plugin_id must be ASCII".into());
  }
  let mut parts = trimmed.split('.');
  let mut count = 0;
  for part in parts.by_ref() {
    count += 1;
    if part.is_empty() {
      return Err("plugin_id segments must be non-empty".into());
    }
    if !part
      .chars()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
      return Err("plugin_id segments must be lowercase alphanumeric or hyphen".into());
    }
    if part.starts_with('-') || part.ends_with('-') {
      return Err("plugin_id segments must not start or end with hyphen".into());
    }
  }
  if count < 2 {
    return Err("plugin_id must be a reverse-domain identifier".into());
  }
  Ok(())
}

/// Validate versioned capability ids like `translate.text@1`.
pub fn validate_capability_id(capability_id: &str) -> Result<(), String> {
  let trimmed = capability_id.trim();
  if trimmed.is_empty() {
    return Err("capability_id is required".into());
  }
  if trimmed.len() > CAPABILITY_ID_MAX_LEN {
    return Err(format!("capability_id exceeds {CAPABILITY_ID_MAX_LEN} characters"));
  }
  if !trimmed.is_ascii() {
    return Err("capability_id must be ASCII".into());
  }
  let (name, version) = trimmed
    .rsplit_once('@')
    .ok_or_else(|| "capability_id must end with @<major>".to_string())?;
  if name.is_empty() {
    return Err("capability_id name is required".into());
  }
  if !name
    .chars()
    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-')
  {
    return Err("capability_id name has invalid characters".into());
  }
  if version.is_empty() || !version.chars().all(|c| c.is_ascii_digit()) {
    return Err("capability_id version must be a positive integer".into());
  }
  if version.starts_with('0') && version != "0" {
    return Err("capability_id version must not have leading zeros".into());
  }
  if version == "0" {
    return Err("capability_id version must be >= 1".into());
  }
  Ok(())
}

/// Validate credential slot ids (ASCII kebab-case, bounded).
pub fn validate_slot_id(slot_id: &str) -> Result<(), String> {
  let trimmed = slot_id.trim();
  if trimmed.is_empty() {
    return Err("slot_id is required".into());
  }
  if trimmed.len() > SLOT_ID_MAX_LEN {
    return Err(format!("slot_id exceeds {SLOT_ID_MAX_LEN} characters"));
  }
  if !trimmed.is_ascii() {
    return Err("slot_id must be ASCII".into());
  }
  if !trimmed
    .chars()
    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
  {
    return Err("slot_id must be lowercase alphanumeric or hyphen".into());
  }
  if trimmed.starts_with('-') || trimmed.ends_with('-') {
    return Err("slot_id must not start or end with hyphen".into());
  }
  Ok(())
}

/// Derive DTO effective status from enabled flag + registry presence + health.
pub fn derive_effective_status(
  enabled: bool,
  plugin_present: bool,
  health: IntegrationHealthStatus,
) -> IntegrationEffectiveStatus {
  if !plugin_present {
    return IntegrationEffectiveStatus::PluginMissing;
  }
  if !enabled {
    return IntegrationEffectiveStatus::Disabled;
  }
  match health {
    IntegrationHealthStatus::Unconfigured => IntegrationEffectiveStatus::Unconfigured,
    IntegrationHealthStatus::Unvalidated => IntegrationEffectiveStatus::Unvalidated,
    IntegrationHealthStatus::Ready => IntegrationEffectiveStatus::Ready,
    IntegrationHealthStatus::Degraded => IntegrationEffectiveStatus::Degraded,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn plugin_id_accepts_reverse_domain() {
    assert!(validate_plugin_id(GOOGLE_CLOUD_PLUGIN_ID).is_ok());
  }

  #[test]
  fn plugin_id_rejects_invalid() {
    assert!(validate_plugin_id("").is_err());
    assert!(validate_plugin_id("single").is_err());
    assert!(validate_plugin_id("Bad.Case").is_err());
    assert!(validate_plugin_id(".leading.dot").is_err());
  }

  #[test]
  fn capability_id_requires_major_version() {
    assert!(validate_capability_id("translate.text@1").is_ok());
    assert!(validate_capability_id("translate.text").is_err());
    assert!(validate_capability_id("translate.text@0").is_err());
    assert!(validate_capability_id("translate.text@01").is_err());
  }

  #[test]
  fn slot_id_is_kebab_case() {
    assert!(validate_slot_id(GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT).is_ok());
    assert!(validate_slot_id("Primary").is_err());
    assert!(validate_slot_id("-bad").is_err());
  }

  #[test]
  fn effective_status_derives_disabled_and_missing() {
    assert_eq!(
      derive_effective_status(false, true, IntegrationHealthStatus::Unvalidated),
      IntegrationEffectiveStatus::Disabled
    );
    assert_eq!(
      derive_effective_status(true, false, IntegrationHealthStatus::Ready),
      IntegrationEffectiveStatus::PluginMissing
    );
    assert_eq!(
      derive_effective_status(true, true, IntegrationHealthStatus::Unconfigured),
      IntegrationEffectiveStatus::Unconfigured
    );
  }

  #[test]
  fn credential_update_debug_redacts_secret() {
    let update = CredentialUpdate::Replace("super-secret".into());
    let rendered = format!("{update:?}");
    assert!(!rendered.contains("super-secret"));
    assert!(rendered.contains("redacted"));
  }
}
