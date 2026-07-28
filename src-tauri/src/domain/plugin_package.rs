// ABOUTME: Domain types for signed plugin package install, approval, and publisher trust.
// ABOUTME: Package approval is catalog-only; execution grant sets are reserved for Phase 4.
use crate::domain::runtime_plugin::{
  MEBIBYTE_BYTES, PackageDigest, PluginManifestV1, PublisherKeyFingerprint, PublisherKeyId, RuntimeKind,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Upper bound on a complete `.lnplugin` archive (64 MiB).
pub const PACKAGE_ARCHIVE_MAX_BYTES: u64 = 64 * MEBIBYTE_BYTES;
/// Maximum number of ZIP entries (including directories).
pub const PACKAGE_ENTRY_MAX_COUNT: usize = 1024;
/// Maximum decompressed size of a single archive entry.
pub const PACKAGE_ENTRY_MAX_BYTES: u64 = 32 * MEBIBYTE_BYTES;
/// Maximum total decompressed payload across all file entries.
pub const PACKAGE_TOTAL_DECOMPRESSED_MAX_BYTES: u64 = 128 * MEBIBYTE_BYTES;
/// Maximum path depth (slash-separated segments) for archive entries.
pub const PACKAGE_PATH_MAX_DEPTH: usize = 16;
/// Maximum size of the exact `plugin.json` bytes.
pub const PACKAGE_MANIFEST_MAX_BYTES: u64 = 256 * 1024;
/// Maximum size of any schema file entry.
pub const PACKAGE_SCHEMA_MAX_BYTES: u64 = 256 * 1024;
/// Maximum size of any page/UI asset entry.
pub const PACKAGE_UI_ASSET_MAX_BYTES: u64 = 4 * MEBIBYTE_BYTES;
/// Maximum size of the signature file.
pub const PACKAGE_SIGNATURE_MAX_BYTES: u64 = 512;
/// Reject archives whose total decompressed / compressed ratio exceeds this.
pub const PACKAGE_DECOMPRESSION_RATIO_MAX: u64 = 100;
/// Preview session lifetime before the opaque preview ID expires.
pub const PACKAGE_PREVIEW_TTL_SECS: u64 = 10 * 60;
/// Ed25519 public key length in bytes.
pub const ED25519_PUBLIC_KEY_LEN: usize = 32;
/// Ed25519 signature length in bytes.
pub const ED25519_SIGNATURE_LEN: usize = 64;
/// Lowercase hex length of an Ed25519 public key.
pub const ED25519_PUBLIC_KEY_HEX_LEN: usize = ED25519_PUBLIC_KEY_LEN * 2;

/// How a publisher key entered the trust store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublisherSource {
  Vendor,
  UserApproved,
}

impl PublisherSource {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Vendor => "vendor",
      Self::UserApproved => "user_approved",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "vendor" => Ok(Self::Vendor),
      "user_approved" => Ok(Self::UserApproved),
      other => Err(format!("unknown publisher source: {other}")),
    }
  }
}

/// Trusted (or revoked) publisher verification key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPublisher {
  pub key_id: String,
  pub fingerprint: String,
  pub public_key_hex: String,
  pub source: PublisherSource,
  pub enabled: bool,
  pub revoked: bool,
  pub created_at: String,
  pub updated_at: String,
}

/// Sanitized publisher DTO returned over IPC (no raw trust-store mutation fields beyond state).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPublisherDto {
  pub key_id: String,
  pub fingerprint: String,
  pub source: PublisherSource,
  pub enabled: bool,
  pub revoked: bool,
  pub created_at: String,
  pub updated_at: String,
}

impl From<&PluginPublisher> for PluginPublisherDto {
  fn from(value: &PluginPublisher) -> Self {
    Self {
      key_id: value.key_id.clone(),
      fingerprint: value.fingerprint.clone(),
      source: value.source,
      enabled: value.enabled,
      revoked: value.revoked,
      created_at: value.created_at.clone(),
      updated_at: value.updated_at.clone(),
    }
  }
}

/// Immutable installed package identity and catalog metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginVersion {
  pub package_digest: String,
  pub plugin_id: String,
  pub version: String,
  pub publisher_key_id: String,
  pub publisher_fingerprint: String,
  pub runtime_kind: String,
  pub manifest_json: String,
  pub permission_request_digest: String,
  pub content_available: bool,
  pub installed_at: String,
}

/// IPC DTO for an installed package version (no absolute paths or raw archive bytes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginVersionDto {
  pub package_digest: String,
  pub plugin_id: String,
  pub version: String,
  pub publisher_key_id: String,
  pub publisher_fingerprint: String,
  pub runtime_kind: String,
  pub permission_request_digest: String,
  pub content_available: bool,
  pub is_default: bool,
  pub in_use: bool,
  pub installed_at: String,
  pub capabilities: Vec<String>,
}

/// How the host decided publisher trust for a package approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublisherDecision {
  TrustedVendor,
  UserApproved,
  AlreadyTrusted,
}

impl PublisherDecision {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::TrustedVendor => "trusted_vendor",
      Self::UserApproved => "user_approved",
      Self::AlreadyTrusted => "already_trusted",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "trusted_vendor" => Ok(Self::TrustedVendor),
      "user_approved" => Ok(Self::UserApproved),
      "already_trusted" => Ok(Self::AlreadyTrusted),
      other => Err(format!("unknown publisher decision: {other}")),
    }
  }
}

/// Non-executable package installation approval. Never authorizes runtime execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackageApproval {
  pub id: Uuid,
  pub package_digest: String,
  pub revision: u64,
  pub publisher_key_id: String,
  pub publisher_decision: PublisherDecision,
  pub permission_request_digest: String,
  pub approved_at: String,
}

/// Crash-recovery journal states for a package install operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallOperationState {
  Prepared,
  Verified,
  DbCommitted,
  Finalized,
  Failed,
}

impl InstallOperationState {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Prepared => "prepared",
      Self::Verified => "verified",
      Self::DbCommitted => "db_committed",
      Self::Finalized => "finalized",
      Self::Failed => "failed",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "prepared" => Ok(Self::Prepared),
      "verified" => Ok(Self::Verified),
      "db_committed" => Ok(Self::DbCommitted),
      "finalized" => Ok(Self::Finalized),
      "failed" => Ok(Self::Failed),
      other => Err(format!("unknown install operation state: {other}")),
    }
  }
}

/// Install-operation journal row for crash-safe package installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginInstallOperation {
  pub id: Uuid,
  pub package_digest: Option<String>,
  pub staging_path: String,
  pub state: InstallOperationState,
  pub error_code: Option<String>,
  pub created_at: String,
  pub updated_at: String,
}

/// Crash-recovery journal states for package uninstall.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UninstallOperationState {
  Prepared,
  ContentQuarantined,
  CatalogDeleted,
  Finalized,
  Failed,
  /// Terminal: content verified in store and availability reopened (uninstall aborted).
  Restored,
  /// Terminal: content restored from quarantine and availability reopened.
  RolledBack,
}

impl UninstallOperationState {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Prepared => "prepared",
      Self::ContentQuarantined => "content_quarantined",
      Self::CatalogDeleted => "catalog_deleted",
      Self::Finalized => "finalized",
      Self::Failed => "failed",
      Self::Restored => "restored",
      Self::RolledBack => "rolled_back",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "prepared" => Ok(Self::Prepared),
      "content_quarantined" => Ok(Self::ContentQuarantined),
      "catalog_deleted" => Ok(Self::CatalogDeleted),
      "finalized" => Ok(Self::Finalized),
      "failed" => Ok(Self::Failed),
      "restored" => Ok(Self::Restored),
      "rolled_back" => Ok(Self::RolledBack),
      other => Err(format!("unknown uninstall operation state: {other}")),
    }
  }

  /// States that still need startup recovery work.
  pub fn is_unfinished(self) -> bool {
    matches!(self, Self::Prepared | Self::ContentQuarantined | Self::CatalogDeleted)
  }
}

/// Uninstall-operation journal row for crash-safe package removal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginUninstallOperation {
  pub id: Uuid,
  pub package_digest: String,
  pub quarantine_path: Option<String>,
  pub state: UninstallOperationState,
  pub error_code: Option<String>,
  pub created_at: String,
  pub updated_at: String,
}

/// Per-plugin default package used only when creating new instances.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDefaultVersion {
  pub plugin_id: String,
  pub package_digest: String,
  pub updated_at: String,
}

/// Publisher trust state surfaced in a package preview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublisherTrustState {
  TrustedVendor,
  TrustedUser,
  Unknown,
  Revoked,
  Disabled,
}

/// Stable package verification / install error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageErrorCode {
  ArchiveTooLarge,
  EntryCountExceeded,
  EntryTooLarge,
  TotalSizeExceeded,
  PathInvalid,
  PathTooDeep,
  DuplicatePath,
  SymlinkRejected,
  ZipBomb,
  InvalidUtf8Path,
  MissingManifest,
  MissingSignature,
  ManifestTooLarge,
  InvalidManifest,
  SignatureInvalid,
  PublisherUnknown,
  PublisherRevoked,
  PublisherDisabled,
  DigestMismatch,
  VersionConflict,
  CompatibilityRejected,
  UndeclaredFile,
  MissingIndexedFile,
  LimitExceeded,
  PreviewExpired,
  PreviewNotFound,
  InUse,
  ContentMissing,
  Internal,
}

impl PackageErrorCode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::ArchiveTooLarge => "archive_too_large",
      Self::EntryCountExceeded => "entry_count_exceeded",
      Self::EntryTooLarge => "entry_too_large",
      Self::TotalSizeExceeded => "total_size_exceeded",
      Self::PathInvalid => "path_invalid",
      Self::PathTooDeep => "path_too_deep",
      Self::DuplicatePath => "duplicate_path",
      Self::SymlinkRejected => "symlink_rejected",
      Self::ZipBomb => "zip_bomb",
      Self::InvalidUtf8Path => "invalid_utf8_path",
      Self::MissingManifest => "missing_manifest",
      Self::MissingSignature => "missing_signature",
      Self::ManifestTooLarge => "manifest_too_large",
      Self::InvalidManifest => "invalid_manifest",
      Self::SignatureInvalid => "signature_invalid",
      Self::PublisherUnknown => "publisher_unknown",
      Self::PublisherRevoked => "publisher_revoked",
      Self::PublisherDisabled => "publisher_disabled",
      Self::DigestMismatch => "digest_mismatch",
      Self::VersionConflict => "version_conflict",
      Self::CompatibilityRejected => "compatibility_rejected",
      Self::UndeclaredFile => "undeclared_file",
      Self::MissingIndexedFile => "missing_indexed_file",
      Self::LimitExceeded => "limit_exceeded",
      Self::PreviewExpired => "preview_expired",
      Self::PreviewNotFound => "preview_not_found",
      Self::InUse => "in_use",
      Self::ContentMissing => "content_missing",
      Self::Internal => "internal",
    }
  }
}

/// Sanitized network permission summary for package preview/install UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageNetworkPermissionDto {
  pub id: String,
  pub origins: Vec<String>,
  pub methods: Vec<String>,
}

/// Package preview returned to the frontend. Opaque ID only; no absolute paths or bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackagePreviewDto {
  pub preview_id: String,
  pub package_digest: String,
  pub plugin_id: String,
  pub version: String,
  pub publisher_key_id: String,
  pub publisher_fingerprint: String,
  pub publisher_trust: PublisherTrustState,
  pub requires_publisher_approval: bool,
  pub runtime_kind: String,
  pub capabilities: Vec<String>,
  pub configuration_schema: Option<String>,
  pub network: Vec<PackageNetworkPermissionDto>,
  pub auth_policies: Vec<String>,
  pub permission_request_digest: String,
  /// Human-readable permission deltas vs the currently installed version of the same plugin (if any).
  pub permission_differences: Vec<String>,
  pub warnings: Vec<String>,
  pub expires_at: String,
}

/// Input for approving a previously previewed package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovePluginPackageInput {
  pub preview_id: String,
  /// Required when the preview's publisher is unknown.
  #[serde(default)]
  pub approve_publisher: bool,
  /// Public key for a new user publisher (required with `approve_publisher` when unknown).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub publisher_public_key_hex: Option<String>,
  /// Required acknowledgement of requested network/auth permissions.
  pub acknowledge_permissions: bool,
  /// Mark this version as the default for new instances of the plugin.
  #[serde(default)]
  pub set_as_default: bool,
}

/// Result of a successful package install approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovePluginPackageResult {
  pub version: InstalledPluginVersionDto,
  pub approval_id: String,
  pub approval_revision: u64,
}

/// Input for approving a user publisher key outside of install (advanced).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveUserPublisherInput {
  pub key_id: String,
  pub fingerprint: String,
  pub public_key_hex: String,
}

/// Dependencies that block uninstall of an installed package version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginVersionDependenciesDto {
  pub package_digest: String,
  pub integration_instance_ids: Vec<String>,
  pub is_default: bool,
}

/// Validate and parse a lowercase-hex Ed25519 public key.
pub fn parse_public_key_hex(value: &str) -> Result<String, String> {
  if value.len() != ED25519_PUBLIC_KEY_HEX_LEN {
    return Err(format!(
      "public key must be {ED25519_PUBLIC_KEY_HEX_LEN} lowercase hex characters"
    ));
  }
  if value != value.trim() {
    return Err("public key must not have surrounding whitespace".into());
  }
  if !value.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
    return Err("public key must be lowercase hex (0-9a-f)".into());
  }
  Ok(value.to_string())
}

/// Decode a lowercase-hex string into fixed-length bytes.
pub fn decode_lowercase_hex<const N: usize>(value: &str, field: &str) -> Result<[u8; N], String> {
  if value.len() != N * 2 {
    return Err(format!("{field} must be {} hex characters", N * 2));
  }
  let mut out = [0u8; N];
  for (index, chunk) in value.as_bytes().chunks(2).enumerate() {
    let hi = hex_nibble(chunk[0]).ok_or_else(|| format!("{field} must be lowercase hex"))?;
    let lo = hex_nibble(chunk[1]).ok_or_else(|| format!("{field} must be lowercase hex"))?;
    out[index] = (hi << 4) | lo;
  }
  Ok(out)
}

fn hex_nibble(byte: u8) -> Option<u8> {
  match byte {
    b'0'..=b'9' => Some(byte - b'0'),
    b'a'..=b'f' => Some(byte - b'a' + 10),
    _ => None,
  }
}

/// Encode bytes as lowercase hex.
pub fn encode_lowercase_hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compute SHA-256 of bytes as lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
  use sha2::{Digest, Sha256};
  encode_lowercase_hex(&Sha256::digest(bytes))
}

/// Canonical permission-request digest bound into package approvals.
///
/// The digest covers sorted network endpoints (id, origins, methods) and auth policy ids so
/// an approval cannot be reused after a permission expansion.
pub fn compute_permission_request_digest(manifest: &PluginManifestV1) -> String {
  use sha2::{Digest, Sha256};
  const SEP: u8 = 0x1f;
  let mut hasher = Sha256::new();
  hasher.update(b"perm-v1");
  hasher.update(b"\x1enet");
  let mut nets: Vec<String> = manifest
    .permissions
    .network
    .iter()
    .map(|endpoint| {
      let mut origins = endpoint.origins.clone();
      origins.sort();
      // Use serde wire form (UPPERCASE) for stable method tokens.
      let mut methods: Vec<String> = endpoint
        .methods
        .iter()
        .map(|method| serde_json::to_string(method).unwrap_or_else(|_| "\"?\"".into()))
        .map(|s| s.trim_matches('"').to_string())
        .collect();
      methods.sort();
      format!("{}\u{1f}{}\u{1f}{}", endpoint.id, origins.join(","), methods.join(","))
    })
    .collect();
  nets.sort();
  for entry in &nets {
    hasher.update([SEP]);
    hasher.update(entry.as_bytes());
  }
  hasher.update(b"\x1eauth");
  let mut policies = manifest.permissions.auth_policies.clone();
  policies.sort();
  for policy in &policies {
    hasher.update([SEP]);
    hasher.update(policy.as_bytes());
  }
  encode_lowercase_hex(&hasher.finalize())
}

/// Runtime kind as a stable kebab-case string for SQLite storage.
pub fn runtime_kind_storage(kind: RuntimeKind) -> &'static str {
  match kind {
    RuntimeKind::BundledRust => "bundled-rust",
    RuntimeKind::WasmComponent => "wasm-component",
    RuntimeKind::LegacyFrontendProvider => "legacy-frontend-provider",
    RuntimeKind::TrustedNativeWorker => "trusted-native-worker",
  }
}

/// Validate publisher key identity fields together.
pub fn validate_publisher_identity(
  key_id: &str,
  fingerprint: &str,
  public_key_hex: &str,
) -> Result<(PublisherKeyId, PublisherKeyFingerprint, String), String> {
  let key_id = PublisherKeyId::parse(key_id)?;
  let fingerprint = PublisherKeyFingerprint::parse(fingerprint)?;
  let public_key_hex = parse_public_key_hex(public_key_hex)?;
  let computed = sha256_hex(&decode_lowercase_hex::<ED25519_PUBLIC_KEY_LEN>(
    &public_key_hex,
    "public key",
  )?);
  if computed != fingerprint.as_str() {
    return Err("publisher fingerprint does not match public key".into());
  }
  Ok((key_id, fingerprint, public_key_hex))
}

/// Validate a package digest string.
pub fn validate_package_digest(value: &str) -> Result<PackageDigest, String> {
  PackageDigest::parse(value)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::runtime_plugin::{
    CapabilityDeclaration, PermissionRequests, PluginFileEntry, PublisherDeclaration, RuntimeDescriptor, SHA256_HEX_LEN,
  };

  fn sample_manifest() -> PluginManifestV1 {
    PluginManifestV1 {
      manifest_version: 1,
      plugin_api_version: "1.0".into(),
      id: "com.example.translate".into(),
      version: "1.0.0".into(),
      publisher: PublisherDeclaration {
        key_id: "com.example.keys.1".into(),
        key_fingerprint: "a".repeat(SHA256_HEX_LEN),
      },
      runtime: RuntimeDescriptor {
        kind: RuntimeKind::WasmComponent,
        artifact: Some("artifacts/plugin.wasm".into()),
      },
      targets: vec![],
      files: vec![PluginFileEntry {
        path: "artifacts/plugin.wasm".into(),
        role: crate::domain::runtime_plugin::FileRole::RuntimeArtifact,
        bytes: 4,
        sha256: "b".repeat(SHA256_HEX_LEN),
      }],
      capabilities: vec![CapabilityDeclaration {
        id: "translate.text@1".into(),
        preferences_schema: None,
      }],
      configuration_schema: None,
      config_schema_version: None,
      credential_slots: vec![],
      permissions: PermissionRequests {
        network: vec![],
        auth_policies: vec![],
      },
      ui: Default::default(),
    }
  }

  #[test]
  fn permission_digest_is_stable_and_sensitive_to_order_and_content() {
    let mut a = sample_manifest();
    a.permissions.auth_policies = vec!["host.api-key.header.v1".into(), "host.none.v1".into()];
    let mut b = a.clone();
    b.permissions.auth_policies = vec!["host.none.v1".into(), "host.api-key.header.v1".into()];
    assert_eq!(
      compute_permission_request_digest(&a),
      compute_permission_request_digest(&b)
    );
    b.permissions.auth_policies.push("host.extra.v1".into());
    assert_ne!(
      compute_permission_request_digest(&a),
      compute_permission_request_digest(&b)
    );
  }

  #[test]
  fn public_key_hex_and_fingerprint_must_match() {
    let secret = [7u8; 32];
    let signing = ed25519_dalek::SigningKey::from_bytes(&secret);
    let public = signing.verifying_key().to_bytes();
    let public_hex = encode_lowercase_hex(&public);
    let fingerprint = sha256_hex(&public);
    validate_publisher_identity("com.example.keys.1", &fingerprint, &public_hex).unwrap();
    let err = validate_publisher_identity("com.example.keys.1", &("c".repeat(64)), &public_hex).unwrap_err();
    assert!(err.contains("fingerprint"));
  }
}
