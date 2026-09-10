// ABOUTME: Source-based plugin catalog identity: source, content kind, descriptors, defaults, errors.
// ABOUTME: No publisher, signature, or activation types; identity is a content digest plus source.
use crate::domain::runtime_plugin::{RuntimeKind, SHA256_HEX_LEN};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Cache directory (under the app data dir) holding immutable digest-addressed snapshots.
pub const PLUGIN_CACHE_DIR_NAME: &str = "plugin-cache";
/// User archive directory (under the app data dir).
pub const USER_PLUGIN_DIR_NAME: &str = "plugins";
/// Environment variable naming the development plugin directory. Debug builds only.
pub const DEVELOPMENT_PLUGIN_DIR_ENV: &str = "LANGNEXT_PLUGIN_DEV_DIR";
/// Domain separator so a content digest can never collide with another host digest scheme.
pub const CONTENT_DIGEST_DOMAIN_TAG: &[u8] = b"lnplugin-content-v1";
/// Separator byte used inside the canonical content-digest preimage.
const DIGEST_FIELD_SEPARATOR: u8 = 0x1f;
/// Record separator byte used inside the canonical content-digest preimage.
const DIGEST_RECORD_SEPARATOR: u8 = 0x1e;
/// Canonical manifest entry path inside a plugin directory or archive.
pub const CATALOG_MANIFEST_FILE_PATH: &str = "plugin.json";

/// Where a catalog entry came from. Determines Native and privileged Host auth eligibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginSource {
  /// Application resource content. Trusted by the signed installer/update channel.
  BuiltIn,
  /// Explicit developer directory. Debug builds only; never shipped.
  Development,
  /// User-installed Wasm archive. Publisher identity is unknown.
  User,
}

impl PluginSource {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::BuiltIn => "built-in",
      Self::Development => "development",
      Self::User => "user",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "built-in" => Ok(Self::BuiltIn),
      "development" => Ok(Self::Development),
      "user" => Ok(Self::User),
      other => Err(format!("unknown plugin source: {other}")),
    }
  }

  /// Only built-in content may run a trusted Native worker.
  pub fn allows_native(self) -> bool {
    matches!(self, Self::BuiltIn)
  }

  /// Only built-in content may bind a privileged Host auth driver (OAuth / client credentials).
  pub fn allows_privileged_host_auth(self) -> bool {
    matches!(self, Self::BuiltIn)
  }

  /// User content is never removable-from by reload; development content is never removable.
  pub fn is_user_removable(self) -> bool {
    matches!(self, Self::User)
  }

  /// Only development content is reloaded from a mutable source directory.
  pub fn is_reloadable(self) -> bool {
    matches!(self, Self::Development)
  }
}

/// How the catalog obtained the plugin content. Both kinds produce the same digest identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginContentKind {
  Directory,
  Archive,
}

impl PluginContentKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Directory => "directory",
      Self::Archive => "archive",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "directory" => Ok(Self::Directory),
      "archive" => Ok(Self::Archive),
      other => Err(format!("unknown plugin content kind: {other}")),
    }
  }
}

/// Sanitized network permission summary. Never carries resolved origins or credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogNetworkPermission {
  pub id: String,
  pub origins: Vec<String>,
  pub methods: Vec<String>,
}

/// Immutable, sanitized identity of one catalog entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
  pub plugin_id: String,
  pub version: String,
  pub source: PluginSource,
  pub content_kind: PluginContentKind,
  pub content_digest: String,
  pub runtime_kind: RuntimeKind,
  pub plugin_api_version: String,
  pub capabilities: Vec<String>,
  pub configuration_schema: Option<String>,
  pub network: Vec<CatalogNetworkPermission>,
  pub auth_policies: Vec<String>,
  pub credential_slots: Vec<String>,
  pub file_count: usize,
  pub total_bytes: u64,
}

impl PluginDescriptor {
  /// True when this descriptor may run a trusted Native worker.
  pub fn native_allowed(&self) -> bool {
    self.source.allows_native()
  }
}

/// A user catalog default override. Built-ins never need a row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDefault {
  pub plugin_id: String,
  pub content_digest: String,
  pub updated_at: String,
}

/// A user-installed archive record. `file_name` is a store-relative archive name, never a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPluginArchive {
  pub content_digest: String,
  pub plugin_id: String,
  pub version: String,
  pub runtime_kind: RuntimeKind,
  pub manifest_json: String,
  pub permission_request_digest: String,
  pub file_name: String,
  pub installed_at: String,
}

/// Stable catalog load/validation error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginLoadErrorCode {
  ContentTooLarge,
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
  ManifestTooLarge,
  InvalidManifest,
  UndeclaredFile,
  MissingIndexedFile,
  SourceMutated,
  CompatibilityRejected,
  NativeSourceRejected,
  NativeNotAllowlisted,
  PrivilegedAuthRejected,
  FirstPartyIdRejected,
  PreviewExpired,
  PreviewNotFound,
  DigestMismatch,
  VersionConflict,
  ContentMissing,
  InUse,
  NotRemovable,
  PermissionNotAcknowledged,
  Internal,
}

impl PluginLoadErrorCode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::ContentTooLarge => "content_too_large",
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
      Self::ManifestTooLarge => "manifest_too_large",
      Self::InvalidManifest => "invalid_manifest",
      Self::UndeclaredFile => "undeclared_file",
      Self::MissingIndexedFile => "missing_indexed_file",
      Self::SourceMutated => "source_mutated",
      Self::CompatibilityRejected => "compatibility_rejected",
      Self::NativeSourceRejected => "native_source_rejected",
      Self::NativeNotAllowlisted => "native_not_allowlisted",
      Self::PrivilegedAuthRejected => "privileged_auth_rejected",
      Self::FirstPartyIdRejected => "first_party_id_rejected",
      Self::PreviewExpired => "preview_expired",
      Self::PreviewNotFound => "preview_not_found",
      Self::DigestMismatch => "digest_mismatch",
      Self::VersionConflict => "version_conflict",
      Self::ContentMissing => "content_missing",
      Self::InUse => "in_use",
      Self::NotRemovable => "not_removable",
      Self::PermissionNotAcknowledged => "permission_not_acknowledged",
      Self::Internal => "internal",
    }
  }
}

/// Sanitized catalog error. Never carries absolute paths or content bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntryError {
  pub code: PluginLoadErrorCode,
  /// Source that produced the failure. A built-in failure fails startup readiness.
  pub source: PluginSource,
  /// Plugin id when it could be parsed before failure; empty otherwise.
  pub plugin_id: String,
  /// Path relative to the plugin root, or empty when not applicable.
  pub relative_path: String,
  pub message: String,
}

impl CatalogEntryError {
  pub fn new(
    code: PluginLoadErrorCode,
    source: PluginSource,
    plugin_id: impl Into<String>,
    message: impl Into<String>,
  ) -> Self {
    Self {
      code,
      source,
      plugin_id: plugin_id.into(),
      relative_path: String::new(),
      message: message.into(),
    }
  }

  pub fn with_path(mut self, relative_path: impl Into<String>) -> Self {
    self.relative_path = relative_path.into();
    self
  }
}

/// Sanitized catalog entry returned over IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogEntryDto {
  #[serde(flatten)]
  pub descriptor: PluginDescriptor,
  pub is_default: bool,
  pub in_use: bool,
  pub removable: bool,
  pub reloadable: bool,
}

/// One catalog snapshot: entries, isolated errors, and defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogSnapshotDto {
  pub entries: Vec<PluginCatalogEntryDto>,
  pub errors: Vec<CatalogEntryError>,
}

/// Catalog refresh counters for the startup log. No paths or content.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CatalogRefreshSummary {
  pub built_in: usize,
  pub development: usize,
  pub user: usize,
  pub invalid: usize,
  pub defaults: usize,
}

/// User archive preview returned before install. Opaque ID plus sanitized descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPackagePreviewDto {
  pub preview_id: String,
  pub content_digest: String,
  pub plugin_id: String,
  pub version: String,
  pub runtime_kind: RuntimeKind,
  pub capabilities: Vec<String>,
  pub configuration_schema: Option<String>,
  pub network: Vec<CatalogNetworkPermission>,
  pub auth_policies: Vec<String>,
  pub credential_slots: Vec<String>,
  pub file_count: usize,
  pub total_bytes: u64,
  pub permission_differences: Vec<String>,
  pub warnings: Vec<String>,
  pub expires_at: String,
}

/// Input for confirming a previewed user archive install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallUserPackageInput {
  pub preview_id: String,
  /// Exact content digest echoed back from the preview. Install fails closed on drift.
  pub content_digest: String,
  /// Required acknowledgement of the requested permissions.
  pub acknowledge_permissions: bool,
}

/// Result of a successful user archive install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallUserPackageResult {
  pub entry: PluginCatalogEntryDto,
}

/// Incremental canonical content digest over sorted relative paths and file bytes.
///
/// The preimage is `tag || (RS path FS length FS bytes)…` so two different path/byte
/// partitions can never hash to the same value.
pub struct ContentDigestBuilder {
  hasher: Sha256,
  entries: usize,
}

impl Default for ContentDigestBuilder {
  fn default() -> Self {
    Self::new()
  }
}

impl ContentDigestBuilder {
  pub fn new() -> Self {
    let mut hasher = Sha256::new();
    hasher.update(CONTENT_DIGEST_DOMAIN_TAG);
    Self { hasher, entries: 0 }
  }

  /// Add one file. Callers must add entries in ascending path order.
  pub fn add_file(&mut self, path: &str, bytes: &[u8]) {
    self.hasher.update([DIGEST_RECORD_SEPARATOR]);
    self.hasher.update(path.as_bytes());
    self.hasher.update([DIGEST_FIELD_SEPARATOR]);
    self.hasher.update((bytes.len() as u64).to_be_bytes());
    self.hasher.update([DIGEST_FIELD_SEPARATOR]);
    self.hasher.update(bytes);
    self.entries += 1;
  }

  pub fn entry_count(&self) -> usize {
    self.entries
  }

  pub fn finish(self) -> String {
    encode_lowercase_hex(&self.hasher.finalize())
  }
}

/// Validate a content digest string.
pub fn validate_content_digest(value: &str) -> Result<(), String> {
  if value.len() != SHA256_HEX_LEN {
    return Err(format!("content digest must be {SHA256_HEX_LEN} hex characters"));
  }
  if value != value.trim() {
    return Err("content digest must not have surrounding whitespace".into());
  }
  if !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
    return Err("content digest must be lowercase hex (0-9a-f)".into());
  }
  Ok(())
}

/// Encode bytes as lowercase hex.
pub fn encode_lowercase_hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compute SHA-256 of bytes as lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
  encode_lowercase_hex(&Sha256::digest(bytes))
}

/// Compute the SHA-256 of one file as lowercase hex. Fails when the file is unreadable.
pub fn hash_file(path: &std::path::Path) -> Result<String, String> {
  let bytes = std::fs::read(path).map_err(|error| format!("file is unreadable: {error}"))?;
  Ok(sha256_hex(&bytes))
}

/// Read a file with a hard byte ceiling. Rejects oversized content before allocating.
pub fn read_file_bounded(path: &std::path::Path, max_bytes: u64) -> Result<Vec<u8>, String> {
  let metadata = std::fs::metadata(path).map_err(|error| format!("file is unreadable: {error}"))?;
  if metadata.len() > max_bytes {
    return Err(format!("file exceeds {max_bytes} bytes"));
  }
  std::fs::read(path).map_err(|error| format!("file is unreadable: {error}"))
}

/// Canonical permission-request digest bound to a catalog content digest.
///
/// Covers sorted network endpoints (id, origins, methods) and auth policy ids so a
/// permission expansion changes the digest a user approved.
pub fn compute_permission_request_digest(manifest: &crate::domain::runtime_plugin::PluginManifestV1) -> String {
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
    hasher.update([DIGEST_FIELD_SEPARATOR]);
    hasher.update(entry.as_bytes());
  }
  hasher.update(b"\x1eauth");
  let mut policies = manifest.permissions.auth_policies.clone();
  policies.sort();
  for policy in &policies {
    hasher.update([DIGEST_FIELD_SEPARATOR]);
    hasher.update(policy.as_bytes());
  }
  encode_lowercase_hex(&hasher.finalize())
}

/// Project a manifest into a sanitized catalog descriptor.
pub fn descriptor_from_manifest(
  manifest: &crate::domain::runtime_plugin::PluginManifestV1,
  source: PluginSource,
  content_kind: PluginContentKind,
  content_digest: String,
  file_count: usize,
  total_bytes: u64,
) -> PluginDescriptor {
  PluginDescriptor {
    plugin_id: manifest.id.clone(),
    version: manifest.version.clone(),
    source,
    content_kind,
    content_digest,
    runtime_kind: manifest.runtime.kind,
    plugin_api_version: manifest.plugin_api_version.clone(),
    capabilities: manifest.capabilities.iter().map(|c| c.id.clone()).collect(),
    configuration_schema: manifest.configuration_schema.clone(),
    network: manifest
      .permissions
      .network
      .iter()
      .map(|endpoint| CatalogNetworkPermission {
        id: endpoint.id.clone(),
        origins: endpoint.origins.clone(),
        methods: endpoint
          .methods
          .iter()
          .map(|method| {
            serde_json::to_string(method)
              .unwrap_or_else(|_| "\"?\"".into())
              .trim_matches('"')
              .to_string()
          })
          .collect(),
      })
      .collect(),
    auth_policies: manifest.permissions.auth_policies.clone(),
    credential_slots: manifest.credential_slots.iter().map(|slot| slot.id.clone()).collect(),
    file_count,
    total_bytes,
  }
}

/// Ordering used for deterministic catalog publication.
pub fn catalog_entry_order(left: &PluginDescriptor, right: &PluginDescriptor) -> std::cmp::Ordering {
  left
    .plugin_id
    .cmp(&right.plugin_id)
    .then_with(|| left.version.cmp(&right.version))
    .then_with(|| left.content_digest.cmp(&right.content_digest))
    .then_with(|| left.source.as_str().cmp(right.source.as_str()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::runtime_plugin::PluginManifestV1;

  fn manifest_with(auth: &[&str], origins: &[&str]) -> PluginManifestV1 {
    let artifact_sha = "b".repeat(SHA256_HEX_LEN);
    let origin_list = origins
      .iter()
      .map(|origin| format!("\"{origin}\""))
      .collect::<Vec<_>>()
      .join(",");
    let auth_list = auth
      .iter()
      .map(|policy| format!("\"{policy}\""))
      .collect::<Vec<_>>()
      .join(",");
    let json = format!(
      r#"{{
        "manifestVersion": 1,
        "pluginApiVersion": "1.0",
        "id": "com.example.translate",
        "version": "1.0.0",
        "runtime": {{ "kind": "wasm-component", "artifact": "artifacts/plugin.wasm" }},
        "files": [{{ "path": "artifacts/plugin.wasm", "role": "runtime-artifact", "bytes": 4, "sha256": "{artifact_sha}" }}],
        "capabilities": [{{ "id": "translate.text@1" }}],
        "permissions": {{
          "network": [{{ "id": "translate", "origins": [{origin_list}], "methods": ["POST"] }}],
          "authPolicies": [{auth_list}]
        }}
      }}"#
    );
    serde_json::from_str(&json).expect("manifest parses")
  }

  #[test]
  fn content_digest_is_order_insensitive_only_when_sorted() {
    let mut a = ContentDigestBuilder::new();
    a.add_file("a.txt", b"one");
    a.add_file("b.txt", b"two");
    let mut b = ContentDigestBuilder::new();
    b.add_file("a.txt", b"one");
    b.add_file("b.txt", b"two");
    assert_eq!(a.finish(), b.finish());
  }

  #[test]
  fn content_digest_distinguishes_path_byte_partitions() {
    let mut a = ContentDigestBuilder::new();
    a.add_file("ab", b"");
    a.add_file("c", b"");
    let mut b = ContentDigestBuilder::new();
    b.add_file("a", b"");
    b.add_file("bc", b"");
    assert_ne!(a.finish(), b.finish());
  }

  #[test]
  fn permission_digest_is_stable_and_sensitive_to_order_and_content() {
    let a = manifest_with(&["host.api-key.header.v1", "host.none.v1"], &["https://a.example"]);
    let b = manifest_with(&["host.none.v1", "host.api-key.header.v1"], &["https://a.example"]);
    assert_eq!(
      compute_permission_request_digest(&a),
      compute_permission_request_digest(&b)
    );
    let c = manifest_with(
      &["host.none.v1", "host.api-key.header.v1", "host.extra.v1"],
      &["https://a.example"],
    );
    assert_ne!(
      compute_permission_request_digest(&a),
      compute_permission_request_digest(&c)
    );
    let d = manifest_with(&["host.none.v1", "host.api-key.header.v1"], &["https://b.example"]);
    assert_ne!(
      compute_permission_request_digest(&a),
      compute_permission_request_digest(&d)
    );
  }

  #[test]
  fn source_rules_restrict_native_and_privileged_auth_to_builtin() {
    assert!(PluginSource::BuiltIn.allows_native());
    assert!(!PluginSource::Development.allows_native());
    assert!(!PluginSource::User.allows_native());
    assert!(PluginSource::BuiltIn.allows_privileged_host_auth());
    assert!(!PluginSource::User.allows_privileged_host_auth());
    assert!(PluginSource::User.is_user_removable());
    assert!(!PluginSource::BuiltIn.is_user_removable());
    assert!(PluginSource::Development.is_reloadable());
    assert!(!PluginSource::BuiltIn.is_reloadable());
  }

  #[test]
  fn descriptor_carries_no_publisher_or_signature_field() {
    let manifest = manifest_with(&[], &[]);
    let descriptor = descriptor_from_manifest(
      &manifest,
      PluginSource::User,
      PluginContentKind::Archive,
      "a".repeat(SHA256_HEX_LEN),
      1,
      4,
    );
    let encoded = serde_json::to_string(&descriptor).unwrap();
    assert!(!encoded.contains("publisher"));
    assert!(!encoded.contains("signature"));
    assert_eq!(descriptor.source, PluginSource::User);
    assert_eq!(descriptor.content_kind, PluginContentKind::Archive);
  }

  #[test]
  fn content_digest_validation_rejects_uppercase_and_short_values() {
    validate_content_digest(&"a".repeat(SHA256_HEX_LEN)).unwrap();
    assert!(validate_content_digest(&"A".repeat(SHA256_HEX_LEN)).is_err());
    assert!(validate_content_digest("abc").is_err());
  }
}
