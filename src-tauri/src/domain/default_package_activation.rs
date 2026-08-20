// ABOUTME: Domain types for default package authorization policies and activation intents.
// ABOUTME: Policy is a future-instance template; execution grants remain instance-scoped.
use crate::domain::runtime_lifecycle::GrantSubjectKind;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// How a default activation policy was established.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefaultActivationPolicySource {
  UserConfirmed,
  VendorBootstrap,
}

impl DefaultActivationPolicySource {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::UserConfirmed => "user_confirmed",
      Self::VendorBootstrap => "vendor_bootstrap",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "user_confirmed" => Ok(Self::UserConfirmed),
      "vendor_bootstrap" => Ok(Self::VendorBootstrap),
      other => Err(format!("unknown default activation policy source: {other}")),
    }
  }
}

/// Whether a catalog default is authorized for package-first creation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefaultPackageAuthorizationStatus {
  /// No catalog default for this plugin.
  Absent,
  /// Catalog default exists but has no authorization policy.
  Unauthorized,
  /// Exact policy matches the current installed package identity.
  Authorized,
  /// Policy exists but digest, publisher, permission, or content no longer match.
  Stale,
  /// Instance-level authority confirmation is required before activation.
  ConfirmationRequired,
}

impl DefaultPackageAuthorizationStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Absent => "absent",
      Self::Unauthorized => "unauthorized",
      Self::Authorized => "authorized",
      Self::Stale => "stale",
      Self::ConfirmationRequired => "confirmation_required",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "absent" => Ok(Self::Absent),
      "unauthorized" => Ok(Self::Unauthorized),
      "authorized" => Ok(Self::Authorized),
      "stale" => Ok(Self::Stale),
      "confirmation_required" => Ok(Self::ConfirmationRequired),
      other => Err(format!("unknown default package authorization status: {other}")),
    }
  }
}

/// Provenance of a subject activation intent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefaultRuntimeActivationSource {
  LocalCreation,
  ImportRequiresConfirmation,
}

impl DefaultRuntimeActivationSource {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::LocalCreation => "local_creation",
      Self::ImportRequiresConfirmation => "import_requires_confirmation",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "local_creation" => Ok(Self::LocalCreation),
      "import_requires_confirmation" => Ok(Self::ImportRequiresConfirmation),
      other => Err(format!("unknown default runtime activation source: {other}")),
    }
  }

  /// Only local creation intents are eligible for automatic recovery.
  pub fn is_recovery_eligible(self) -> bool {
    matches!(self, Self::LocalCreation)
  }
}

/// Durable activation intent state for a subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefaultRuntimeActivationState {
  Pending,
  ConfirmationRequired,
  Activating,
  Completed,
  Failed,
  Cancelled,
}

impl DefaultRuntimeActivationState {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Pending => "pending",
      Self::ConfirmationRequired => "confirmation_required",
      Self::Activating => "activating",
      Self::Completed => "completed",
      Self::Failed => "failed",
      Self::Cancelled => "cancelled",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "pending" => Ok(Self::Pending),
      "confirmation_required" => Ok(Self::ConfirmationRequired),
      "activating" => Ok(Self::Activating),
      "completed" => Ok(Self::Completed),
      "failed" => Ok(Self::Failed),
      "cancelled" => Ok(Self::Cancelled),
      other => Err(format!("unknown default runtime activation state: {other}")),
    }
  }

  /// States that may still need work after restart for eligible sources.
  pub fn is_recoverable(self) -> bool {
    matches!(self, Self::Pending | Self::Activating)
  }
}

/// Exact future-instance authorization policy for a plugin default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultPackageActivationPolicy {
  pub plugin_id: String,
  pub package_digest: String,
  pub publisher_key_id: String,
  pub publisher_fingerprint: String,
  pub permission_request_digest: String,
  pub approved_authority_constraints_json: String,
  pub approved_authority_constraints_digest: String,
  pub policy_source: DefaultActivationPolicySource,
  pub created_at: String,
  pub updated_at: String,
}

/// Subject activation intent with provenance; never holds secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultRuntimeActivationIntent {
  pub id: Uuid,
  pub subject_kind: GrantSubjectKind,
  pub subject_id: Uuid,
  pub package_digest: String,
  pub source: DefaultRuntimeActivationSource,
  pub state: DefaultRuntimeActivationState,
  pub expected_config_digest: Option<String>,
  pub expected_update_token: Option<String>,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
  pub created_at: String,
  pub updated_at: String,
  /// Opaque recovery lease token; never exported over IPC.
  #[serde(default, skip_serializing)]
  pub claim_token: Option<String>,
  /// RFC3339 expiry for the recovery lease; never exported over IPC.
  #[serde(default, skip_serializing)]
  pub claim_expires_at: Option<String>,
}

/// Sanitized policy status returned on installed package DTOs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultPackagePolicyStatusDto {
  pub status: DefaultPackageAuthorizationStatus,
  pub policy_source: Option<DefaultActivationPolicySource>,
  pub package_digest: Option<String>,
}

/// Preview of a package that may become the authorized default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultPackageActivationPreviewDto {
  pub preview_id: String,
  pub plugin_id: String,
  pub package_digest: String,
  pub version: String,
  pub publisher_key_id: String,
  pub publisher_fingerprint: String,
  pub runtime_kind: String,
  pub permission_request_digest: String,
  pub capabilities: Vec<String>,
  pub fixed_network_authority: Vec<DefaultAuthorityNetworkEntryDto>,
  pub dynamic_authority_warnings: Vec<String>,
  pub auth_policies: Vec<String>,
  pub resource_limits: Option<DefaultAuthorityResourceLimitsDto>,
  pub requires_instance_confirmation_for_dynamic_origins: bool,
  pub expires_at: String,
}

/// One reviewed fixed network authority entry shown in a default preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAuthorityNetworkEntryDto {
  pub capability_id: String,
  pub endpoint_id: String,
  pub origin: String,
  /// Normalized base URL bound into the authority digest; never raw config secrets.
  pub base_url: String,
  pub method: String,
  pub auth_policy: String,
  pub origin_kind: String,
  /// Canonical response-body modes bound into the authority digest.
  pub response_body_modes: String,
  /// Effective resource limits bound for this authority entry.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub resource_limits: Option<DefaultAuthorityResourceLimitsDto>,
}

/// Resource limits summarized for default authorization preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAuthorityResourceLimitsDto {
  pub max_request_bytes: u64,
  pub max_response_bytes: u64,
  pub max_stream_bytes: u64,
  pub timeout_ms: u64,
}

/// Input confirming a default package authorization preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeDefaultPluginPackageInput {
  pub preview_id: String,
  pub acknowledge_future_instance_authority: bool,
}

/// Input to preview additional subject authority beyond the default policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDefaultRuntimeAuthorityInput {
  pub subject_kind: GrantSubjectKind,
  pub subject_id: Uuid,
}

/// Input for instance-level authority confirmation outside the default policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmDefaultRuntimeAuthorityInput {
  pub preview_id: String,
  pub acknowledge_additional_authority: bool,
}

/// Subject/config-bound authority preview for authority beyond the default policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultRuntimeAuthorityPreviewDto {
  pub preview_id: String,
  pub subject_kind: GrantSubjectKind,
  pub subject_id: Uuid,
  pub package_digest: String,
  pub expected_update_token: String,
  pub config_digest: String,
  pub additional_network_authority: Vec<DefaultAuthorityNetworkEntryDto>,
  pub auth_policies: Vec<String>,
  pub resource_limits: Option<DefaultAuthorityResourceLimitsDto>,
  pub expires_at: String,
}

/// Input to retry activation of a retained exact package requirement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryDefaultRuntimeActivationInput {
  pub subject_kind: GrantSubjectKind,
  pub subject_id: Uuid,
}

/// Exact additive subject authority approval. Local trust only; never holds secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultRuntimeAuthorityApproval {
  pub id: Uuid,
  pub subject_kind: GrantSubjectKind,
  pub subject_id: Uuid,
  pub package_digest: String,
  pub config_digest: String,
  pub subject_update_token: String,
  pub policy_constraints_digest: String,
  pub approved_authority_json: String,
  pub approved_authority_digest: String,
  pub created_at: String,
  pub updated_at: String,
}
