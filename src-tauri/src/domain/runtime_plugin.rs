// ABOUTME: Runtime plugin identity, manifest, principal, grant-set, and permission contracts.
// ABOUTME: Pure domain types plus validated newtypes; no signature crypto or execution logic.
use crate::domain::service_integration::validate_slot_id;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Manifest schema version produced and consumed by Phase 0.
pub const MANIFEST_VERSION_V1: u32 = 1;
/// Host plugin API major version. Manifests must declare a compatible major.
pub const HOST_PLUGIN_API_VERSION_MAJOR: u32 = 1;
/// Host plugin API minor version. A manifest may not require a newer minor.
pub const HOST_PLUGIN_API_VERSION_MINOR: u32 = 0;
/// Capability major locked by every Phase 0 v1 capability contract.
pub const CAPABILITY_MAJOR_V1: u32 = 1;
/// First valid execution grant-set revision.
pub const INITIAL_GRANT_SET_REVISION: u64 = 1;
/// Number of closed v1 capability contracts represented by `CAPABILITY_SPECS`.
pub const CAPABILITY_V1_COUNT: usize = 7;
/// Current host plugin API version string.
pub const HOST_PLUGIN_API_VERSION_CURRENT: &str = "1.0";
/// Canonical manifest entry path inside a `.lnplugin` archive.
pub const MANIFEST_FILE_PATH: &str = "plugin.json";
/// Canonical signature entry path; the only unsigned archive entry.
pub const SIGNATURE_FILE_PATH: &str = "signatures/manifest.sig";
/// Optional self-authenticating publisher public key (32 bytes raw Ed25519).
/// When present, the host auto-resolves the key by verifying sha256(pub) matches the signed
/// manifest's publisher key fingerprint. Not a member of the signed file index.
pub const PUBLISHER_PUBLIC_KEY_PATH: &str = "publisher.pub";

/// Byte size used to express binary resource limits.
pub const MEBIBYTE_BYTES: u64 = 1024 * 1024;
/// SHA-256 digest length in lowercase hex characters (32 bytes).
pub const SHA256_HEX_LEN: usize = 64;
pub const PUBLISHER_KEY_ID_MAX_LEN: usize = 64;
pub const REQUEST_ID_MAX_LEN: usize = 128;
pub const PLUGIN_ID_MAX_LEN: usize = 128;
pub const FILE_PATH_MAX_LEN: usize = 512;
pub const FILES_MAX_COUNT: usize = 1024;
pub const CAPABILITIES_MAX_COUNT: usize = 16;
pub const CREDENTIAL_SLOTS_MAX_COUNT: usize = 16;
pub const NETWORK_ENDPOINTS_MAX_COUNT: usize = 32;
pub const NETWORK_ENDPOINT_ID_MAX_LEN: usize = 64;
pub const AUTH_POLICIES_MAX_COUNT: usize = 16;
pub const AUTH_POLICY_ID_MAX_LEN: usize = 64;
pub const PAGES_MAX_COUNT: usize = 8;
pub const PAGE_ID_MAX_LEN: usize = 64;
pub const PAGE_ACTION_ID_MAX_LEN: usize = 64;
pub const GRANT_NETWORK_MAX_ENTRIES: usize = 64;
pub const GRANT_PAGE_MAX_ENTRIES: usize = 16;
pub const GRANT_PAGE_MAX_ACTIONS: usize = 16;
pub const ORIGINS_MAX_COUNT: usize = 8;
pub const METHODS_MAX_COUNT: usize = 8;
/// Maximum number of platform/architecture target constraints on a package manifest.
pub const PACKAGE_TARGETS_MAX_COUNT: usize = 16;
/// Closed-set package platform tokens accepted by the host.
pub const PACKAGE_TARGET_PLATFORMS: &[&str] = &["any", "windows", "macos", "linux"];
/// Closed-set package architecture tokens accepted by the host.
pub const PACKAGE_TARGET_ARCHITECTURES: &[&str] = &["any", "x86_64", "aarch64"];
/// Upper bound on a single indexed file's byte length (256 MiB).
pub const FILE_MAX_BYTES: u64 = 256 * MEBIBYTE_BYTES;
/// Default resource limits seed for grant entries (host may tighten per grant).
pub const RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES: u64 = MEBIBYTE_BYTES;
pub const RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES: u64 = 8 * MEBIBYTE_BYTES;
pub const RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES: u64 = 16 * MEBIBYTE_BYTES;
pub const RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS: u64 = 20_000;

/// Single source of truth for v1 capabilities: id, name, WIT world, and supported major.
/// All capability lookups (id validation, name recognition, world mapping, major compat)
/// derive from this table to prevent three-place drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilitySpec {
  pub id: &'static str,
  pub name: &'static str,
  pub world: &'static str,
  pub interface: &'static str,
  pub major: u32,
}

pub const CAPABILITY_SPECS: &[CapabilitySpec] = &[
  CapabilitySpec {
    id: "translate.text@1",
    name: "translate.text",
    world: "translate-text-world",
    interface: "translate-text",
    major: CAPABILITY_MAJOR_V1,
  },
  CapabilitySpec {
    id: "translate.detect@1",
    name: "translate.detect",
    world: "translate-detect-world",
    interface: "translate-detect",
    major: CAPABILITY_MAJOR_V1,
  },
  CapabilitySpec {
    id: "ocr.image@1",
    name: "ocr.image",
    world: "ocr-image-world",
    interface: "ocr-image",
    major: CAPABILITY_MAJOR_V1,
  },
  CapabilitySpec {
    id: "speech.synthesize@1",
    name: "speech.synthesize",
    world: "speech-synthesize-world",
    interface: "speech-synthesize",
    major: CAPABILITY_MAJOR_V1,
  },
  CapabilitySpec {
    id: "speech.recognize@1",
    name: "speech.recognize",
    world: "speech-recognize-world",
    interface: "speech-recognize",
    major: CAPABILITY_MAJOR_V1,
  },
  CapabilitySpec {
    id: "llm.models.list@1",
    name: "llm.models.list",
    world: "llm-models-world",
    interface: "llm-models",
    major: CAPABILITY_MAJOR_V1,
  },
  CapabilitySpec {
    id: "llm.chat@1",
    name: "llm.chat",
    world: "llm-chat-world",
    interface: "llm-chat",
    major: CAPABILITY_MAJOR_V1,
  },
];

/// Look up the capability spec for a full `name@major` id.
pub fn capability_spec(capability_id: &str) -> Option<&'static CapabilitySpec> {
  CAPABILITY_SPECS.iter().find(|s| s.id == capability_id)
}

/// Map a v1 capability id to its WIT world name (derived from the single table).
pub fn capability_world(capability_id: &str) -> Option<&'static str> {
  capability_spec(capability_id).map(|s| s.world)
}

/// Runtime executor kind bound to a plugin package/instance.
///
/// `BundledRust` covers the current compiled-in handlers during the migration;
/// `WasmComponent` is the default for external service plugins; `LegacyFrontendProvider`
/// covers TypeScript LLM provider adapters pending runtime migration; `TrustedNativeWorker`
/// is first-party only until OS-level containment exists (Phase 10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeKind {
  BundledRust,
  WasmComponent,
  LegacyFrontendProvider,
  TrustedNativeWorker,
}

impl RuntimeKind {
  /// True when this kind is backed by an installable archive artifact that must be
  /// declared in the signed file index.
  pub fn requires_archive_artifact(self) -> bool {
    matches!(self, Self::WasmComponent | Self::TrustedNativeWorker)
  }
}

/// Lowercase hex SHA-256 digest of the exact final signed `.lnplugin` archive bytes.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PackageDigest(String);

impl PackageDigest {
  pub fn parse(value: &str) -> Result<Self, String> {
    if value.is_empty() {
      return Err("package digest is required".into());
    }
    if value.len() != SHA256_HEX_LEN {
      return Err(format!("package digest must be {SHA256_HEX_LEN} hex characters"));
    }
    if value != value.trim() {
      return Err("package digest must not have surrounding whitespace".into());
    }
    if !is_lowercase_hex(value) {
      return Err("package digest must be lowercase hex (0-9a-f)".into());
    }
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Lowercase hex SHA-256 digest of a runtime Component artifact file (the package file-index
/// entry with role `runtime-artifact`). Distinct from [`PackageDigest`]: the package digest
/// covers the final signed `.lnplugin` archive bytes, while this digest covers only the
/// Component file bytes that the host compiles and executes. Never use one as the other.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ComponentArtifactDigest(String);

impl ComponentArtifactDigest {
  pub fn parse(value: &str) -> Result<Self, String> {
    if value.is_empty() {
      return Err("component artifact digest is required".into());
    }
    if value.len() != SHA256_HEX_LEN {
      return Err(format!(
        "component artifact digest must be {SHA256_HEX_LEN} hex characters"
      ));
    }
    if value != value.trim() {
      return Err("component artifact digest must not have surrounding whitespace".into());
    }
    if !is_lowercase_hex(value) {
      return Err("component artifact digest must be lowercase hex (0-9a-f)".into());
    }
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Publisher verification key identifier (bounded reverse-domain ASCII, not key material).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PublisherKeyId(String);

impl PublisherKeyId {
  pub fn parse(value: &str) -> Result<Self, String> {
    validate_reverse_domain_strict(value, PUBLISHER_KEY_ID_MAX_LEN, "publisher key id")?;
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Lowercase hex SHA-256 fingerprint of a publisher verification key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PublisherKeyFingerprint(String);

impl PublisherKeyFingerprint {
  pub fn parse(value: &str) -> Result<Self, String> {
    if value.is_empty() {
      return Err("publisher key fingerprint is required".into());
    }
    if value.len() != SHA256_HEX_LEN {
      return Err(format!(
        "publisher key fingerprint must be {SHA256_HEX_LEN} hex characters"
      ));
    }
    if value != value.trim() {
      return Err("publisher key fingerprint must not have surrounding whitespace".into());
    }
    if !is_lowercase_hex(value) {
      return Err("publisher key fingerprint must be lowercase hex (0-9a-f)".into());
    }
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Monotonic execution grant-set revision bound to one instance/package pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct GrantSetRevision(u64);

impl GrantSetRevision {
  pub const INITIAL: Self = Self(INITIAL_GRANT_SET_REVISION);

  pub fn new(value: u64) -> Result<Self, String> {
    if value == 0 {
      return Err("grant-set revision must be >= 1".into());
    }
    Ok(Self(value))
  }

  pub fn as_u64(self) -> u64 {
    self.0
  }
}

/// Canonical lowercase-hex SHA-256 digest of a grant set's authority content (capabilities,
/// network entries, page entries). Bound to both `ExecutionGrantSet` and `PluginPrincipal` so
/// an old principal cannot authorize a same-revision grant set with different authority.
/// Only canonical lowercase hex; compared exactly.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AuthorityDigest(String);

impl AuthorityDigest {
  /// Build a digest from raw SHA-256 bytes, encoded as canonical lowercase hex.
  fn from_sha256(bytes: [u8; 32]) -> Self {
    Self(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
  }

  /// Parse a persisted lowercase-hex authority digest.
  pub fn parse(value: &str) -> Result<Self, String> {
    if value.len() != SHA256_HEX_LEN {
      return Err(format!("authority digest must be {SHA256_HEX_LEN} hex characters"));
    }
    if value != value.trim() {
      return Err("authority digest must not have surrounding whitespace".into());
    }
    if !is_lowercase_hex(value) {
      return Err("authority digest must be lowercase hex (0-9a-f)".into());
    }
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Unit-separator byte used to delimit canonical authority-digest fields without ambiguity.
const AUTHORITY_DIGEST_SEP: u8 = 0x1f;

/// Compute the canonical authority digest over a grant set's authority content. The content is
/// sorted deterministically (capabilities by id, network entries by their full key, pages by id
/// with sorted actions) so the same authority always yields the same digest regardless of input
/// order. Resource limits are part of each network entry's authority and are included. The
/// default strict provenance preserves the legacy encoding; privileged host-fixed and
/// user-approved markers are added so changing a dynamic grant broadens authority only with a
/// new digest.
pub(crate) fn compute_authority_digest(
  capabilities: &[CapabilityId],
  network: &[NetworkGrantEntry],
  pages: &[PageGrantEntry],
) -> AuthorityDigest {
  let mut hasher = Sha256::new();
  hasher.update(b"caps");
  let mut caps: Vec<&str> = capabilities.iter().map(|cap| cap.as_str()).collect();
  caps.sort_unstable();
  for cap in &caps {
    hasher.update([AUTHORITY_DIGEST_SEP]);
    hasher.update(cap.as_bytes());
  }
  hasher.update(b"\x1enet");
  let mut net: Vec<String> = network
    .iter()
    .map(|entry| {
      let limits = entry.resource_limits();
      let origin_kind_marker = match entry.origin_kind() {
        NetworkOriginKind::InstanceConfigured => String::new(),
        NetworkOriginKind::HostFixed | NetworkOriginKind::UserApprovedInstance => {
          format!("\u{1f}{}", entry.origin_kind().as_str())
        }
      };
      let base_url_marker = if entry.base_url() == entry.origin().as_str() {
        String::new()
      } else {
        format!("\u{1f}{}", entry.base_url())
      };
      let response_modes_marker = if entry.response_body_modes().is_default() {
        String::new()
      } else {
        format!("\u{1f}{}", entry.response_body_modes().as_canonical())
      };
      format!(
        "{}\u{1f}{}\u{1f}{}{}{}\u{1f}{:?}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}{}",
        entry.capability_id().as_str(),
        entry.endpoint_id().as_str(),
        entry.origin().as_str(),
        base_url_marker,
        origin_kind_marker,
        entry.method(),
        entry.auth_policy().as_str(),
        entry.resource_mode().as_str(),
        limits.max_request_bytes(),
        limits.max_response_bytes(),
        limits.max_stream_bytes(),
        limits.timeout_ms(),
        response_modes_marker
      )
    })
    .collect();
  net.sort_unstable();
  for entry in &net {
    hasher.update([AUTHORITY_DIGEST_SEP]);
    hasher.update(entry.as_bytes());
  }
  hasher.update(b"\x1epages");
  let mut page_reps: Vec<String> = pages
    .iter()
    .map(|entry| {
      let mut actions: Vec<&str> = entry.actions().map(|action| action.as_str()).collect();
      actions.sort_unstable();
      let mut majors: Vec<&str> = entry.delegated_capability_majors().map(|cap| cap.as_str()).collect();
      majors.sort_unstable();
      let mut aliases: Vec<&str> = entry.delegated_endpoint_aliases().map(|alias| alias.as_str()).collect();
      aliases.sort_unstable();
      format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        entry.page_id().as_str(),
        actions.join(","),
        majors.join(","),
        aliases.join(",")
      )
    })
    .collect();
  page_reps.sort_unstable();
  for entry in &page_reps {
    hasher.update([AUTHORITY_DIGEST_SEP]);
    hasher.update(entry.as_bytes());
  }
  let digest = hasher.finalize();
  let mut bytes = [0u8; 32];
  bytes.copy_from_slice(&digest);
  AuthorityDigest::from_sha256(bytes)
}

/// Parsed `pluginApiVersion` (major.minor) declared by a manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PluginApiVersion {
  pub major: u32,
  pub minor: u32,
}

impl PluginApiVersion {
  pub fn parse(value: &str) -> Result<Self, String> {
    if value != value.trim() {
      return Err("plugin api version must not have surrounding whitespace".into());
    }
    let (major, minor) = value
      .split_once('.')
      .ok_or_else(|| "plugin api version must be major.minor".to_string())?;
    let major = parse_canonical_version_component(major, "plugin api version major")?;
    let minor = parse_canonical_version_component(minor, "plugin api version minor")?;
    if major == 0 {
      return Err("plugin api version major must be >= 1".into());
    }
    Ok(Self { major, minor })
  }

  /// Whether the declared API is implemented by this host's locked major/minor version.
  pub fn is_host_compatible(self) -> bool {
    self.major == HOST_PLUGIN_API_VERSION_MAJOR && self.minor <= HOST_PLUGIN_API_VERSION_MINOR
  }
}

fn parse_canonical_version_component(value: &str, field: &str) -> Result<u32, String> {
  if value.is_empty() || !value.chars().all(|character| character.is_ascii_digit()) {
    return Err(format!("{field} must be a non-negative integer"));
  }
  if value.len() > 1 && value.starts_with('0') {
    return Err(format!("{field} must not have leading zeros"));
  }
  value.parse().map_err(|_| format!("{field} overflows u32"))
}

/// Capability major version parsed from a `capability@major` identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CapabilityMajor(u32);

impl CapabilityMajor {
  pub fn new(value: u32) -> Result<Self, String> {
    if value == 0 {
      return Err("capability major must be >= 1".into());
    }
    Ok(Self(value))
  }

  pub fn as_u32(self) -> u32 {
    self.0
  }
}

/// Validated reverse-domain plugin id (canonical, no surrounding whitespace).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PluginId(String);

impl PluginId {
  pub fn parse(value: &str) -> Result<Self, String> {
    validate_reverse_domain_strict(value, PLUGIN_ID_MAX_LEN, "plugin id")?;
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Validated semantic version (major.minor.patch with optional prerelease/build).
/// Uses the `semver` crate: rejects leading zeros, supports prerelease/build metadata.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SemVerVersion(semver::Version);

impl SemVerVersion {
  pub fn parse(value: &str) -> Result<Self, String> {
    if value.is_empty() {
      return Err("version is required".into());
    }
    if value != value.trim() {
      return Err("version must not have surrounding whitespace".into());
    }
    let v = semver::Version::parse(value).map_err(|e| format!("invalid semantic version: {e}"))?;
    Ok(Self(v))
  }

  pub fn as_str(&self) -> String {
    self.0.to_string()
  }

  pub fn as_semver(&self) -> &semver::Version {
    &self.0
  }
}

/// Error classifying why a capability id was rejected by `CapabilityId::parse`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityIdError {
  InvalidSyntax(String),
  UnknownCapability,
  UnsupportedMajor { declared: u32, supported: u32 },
}

/// Validated v1 capability id from the closed set of seven (single-table derived).
/// Maps to a WIT world. A known name with an unsupported major is `UnsupportedMajor`
/// (staging-only); an unknown name is `UnknownCapability` (hard reject).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CapabilityId(String);

impl CapabilityId {
  pub fn parse(value: &str) -> Result<Self, CapabilityIdError> {
    if value.is_empty() {
      return Err(CapabilityIdError::InvalidSyntax("capability id is required".into()));
    }
    if value != value.trim() {
      return Err(CapabilityIdError::InvalidSyntax(
        "capability id must not have surrounding whitespace".into(),
      ));
    }
    let (name, major_str) = value
      .rsplit_once('@')
      .ok_or_else(|| CapabilityIdError::InvalidSyntax("capability id must end with @<major>".into()))?;
    if name.is_empty() {
      return Err(CapabilityIdError::InvalidSyntax(
        "capability id name is required".into(),
      ));
    }
    if !name
      .chars()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-')
    {
      return Err(CapabilityIdError::InvalidSyntax(
        "capability id name has invalid characters".into(),
      ));
    }
    if major_str.is_empty() || !major_str.chars().all(|c| c.is_ascii_digit()) {
      return Err(CapabilityIdError::InvalidSyntax(
        "capability major must be a positive integer".into(),
      ));
    }
    if major_str.starts_with('0') && major_str != "0" {
      return Err(CapabilityIdError::InvalidSyntax(
        "capability major must not have leading zeros".into(),
      ));
    }
    let major: u32 = major_str
      .parse()
      .map_err(|_| CapabilityIdError::InvalidSyntax("capability major overflow".into()))?;
    if major == 0 {
      return Err(CapabilityIdError::InvalidSyntax("capability major must be >= 1".into()));
    }
    let spec = CAPABILITY_SPECS
      .iter()
      .find(|s| s.name == name)
      .ok_or(CapabilityIdError::UnknownCapability)?;
    if major != spec.major {
      return Err(CapabilityIdError::UnsupportedMajor {
        declared: major,
        supported: spec.major,
      });
    }
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }

  pub fn world(&self) -> &'static str {
    capability_world(&self.0).expect("closed-set capability maps to a world")
  }

  pub fn major(&self) -> CapabilityMajor {
    let (_, version) = self.0.rsplit_once('@').expect("closed-set capability has @major");
    CapabilityMajor::new(version.parse().expect("major parses")).expect("major >= 1")
  }
}

/// Bounded request identifier carried through host imports and capability calls.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RequestId(String);

impl RequestId {
  pub fn parse(value: &str) -> Result<Self, String> {
    if value.is_empty() {
      return Err("request id is required".into());
    }
    if value != value.trim() {
      return Err("request id must not have leading or trailing whitespace".into());
    }
    if value.len() > REQUEST_ID_MAX_LEN {
      return Err(format!("request id exceeds {REQUEST_ID_MAX_LEN} characters"));
    }
    if !value
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
      return Err("request id must be ASCII alphanumeric, hyphen, underscore, or dot".into());
    }
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Validated canonical network endpoint alias (manifest-declared, referenced by grants).
/// Endpoint aliases such as `gtx` and `translate-api` are host-resolved identifiers, not
/// publisher namespaces; auth policy IDs remain reverse-domain identifiers.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EndpointId(String);

impl EndpointId {
  pub fn parse(value: &str) -> Result<Self, String> {
    validate_kebab_strict(value, NETWORK_ENDPOINT_ID_MAX_LEN, "network endpoint id")?;
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Validated reverse-domain auth policy id (e.g. `host.api-key.header.v1`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AuthPolicyId(String);

impl AuthPolicyId {
  pub fn parse(value: &str) -> Result<Self, String> {
    validate_reverse_domain_strict(value, AUTH_POLICY_ID_MAX_LEN, "auth policy id")?;
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Validated kebab-case page id (manifest-declared, referenced by grants).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PageId(String);

impl PageId {
  pub fn parse(value: &str) -> Result<Self, String> {
    validate_kebab_strict(value, PAGE_ID_MAX_LEN, "page id")?;
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Validated kebab-case page action id.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PageActionId(String);

impl PageActionId {
  pub fn parse(value: &str) -> Result<Self, String> {
    validate_kebab_strict(value, PAGE_ACTION_ID_MAX_LEN, "page action id")?;
    Ok(Self(value.to_string()))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Canonical https origin (`https://host` or `https://host:port`). Rejects userinfo,
/// query, fragment, path, trailing slash, default port 443, and non-lowercase host.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HttpsOrigin(String);

impl HttpsOrigin {
  pub fn parse(value: &str) -> Result<Self, String> {
    if value.is_empty() {
      return Err("origin is required".into());
    }
    if value != value.trim() {
      return Err("origin must not have surrounding whitespace".into());
    }
    let parsed = url::Url::parse(value).map_err(|e| format!("origin {value}: {e}"))?;
    if parsed.scheme() != "https" {
      return Err(format!("origin {value} must use https"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
      return Err(format!("origin {value} must not include userinfo"));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
      return Err(format!("origin {value} must not include a query or fragment"));
    }
    if parsed.host_str().is_none() {
      return Err(format!("origin {value} must have a host"));
    }
    let origin = parsed.origin();
    if !origin.is_tuple() {
      return Err(format!("origin {value} is not a valid tuple origin"));
    }
    let canonical = origin.ascii_serialization();
    if canonical != value {
      return Err(format!("origin {value} is not canonical (expected {canonical})"));
    }
    Ok(Self(canonical))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

/// Runtime identity: either a compiled-in bundled handler (no package digest) or a signed
/// installable package pinned to an exact SHA-256 digest. Bundled identities are not
/// constrained by archive artifact rules; package identities are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeIdentity {
  Bundled,
  Package(PackageIdentity),
}

/// Signed installable package identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageIdentity {
  pub package_digest: PackageDigest,
}

/// Immutable execution principal bound to one request. Every host import is evaluated
/// against this identity; it is never persisted or reused across requests. The
/// `authority_digest` binds the principal to the exact grant-set authority it was issued for,
/// so an old principal cannot authorize a same-revision grant set with different authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginPrincipal {
  identity: RuntimeIdentity,
  plugin_id: PluginId,
  plugin_version: SemVerVersion,
  instance_id: Uuid,
  capability_id: CapabilityId,
  request_id: RequestId,
  grant_set_revision: GrantSetRevision,
  authority_digest: AuthorityDigest,
}

impl PluginPrincipal {
  /// Construct a principal for one request against a specific grant set. The identity, plugin,
  /// instance, revision, and authority digest all come from the issuing grant set, so a
  /// principal is always bound to one exact (revision, authority) pair. Private: only
  /// `ExecutionGrantSet::principal_for_request` constructs principals.
  fn for_request(
    identity: RuntimeIdentity,
    plugin_id: PluginId,
    plugin_version: SemVerVersion,
    instance_id: Uuid,
    capability_id: &str,
    request_id: &str,
    grant_set_revision: GrantSetRevision,
    authority_digest: AuthorityDigest,
  ) -> Result<Self, String> {
    Ok(Self {
      identity,
      plugin_id,
      plugin_version,
      instance_id,
      capability_id: CapabilityId::parse(capability_id).map_err(|e| format!("capability id: {e:?}"))?,
      request_id: RequestId::parse(request_id)?,
      grant_set_revision,
      authority_digest,
    })
  }

  pub fn has_package_digest(&self) -> bool {
    matches!(self.identity, RuntimeIdentity::Package(_))
  }

  pub fn package_digest(&self) -> Option<&PackageDigest> {
    match &self.identity {
      RuntimeIdentity::Package(p) => Some(&p.package_digest),
      RuntimeIdentity::Bundled => None,
    }
  }

  pub fn identity(&self) -> &RuntimeIdentity {
    &self.identity
  }

  pub fn plugin_id(&self) -> &PluginId {
    &self.plugin_id
  }

  pub fn plugin_version(&self) -> &SemVerVersion {
    &self.plugin_version
  }

  pub fn instance_id(&self) -> Uuid {
    self.instance_id
  }

  pub fn capability_id(&self) -> &CapabilityId {
    &self.capability_id
  }

  pub fn request_id(&self) -> &RequestId {
    &self.request_id
  }

  pub fn grant_set_revision(&self) -> GrantSetRevision {
    self.grant_set_revision
  }

  pub fn authority_digest(&self) -> &AuthorityDigest {
    &self.authority_digest
  }
}

/// Host-owned resource limits bound to a network grant entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceLimits {
  max_request_bytes: u64,
  max_response_bytes: u64,
  max_stream_bytes: u64,
  timeout_ms: u64,
}

impl ResourceLimits {
  /// Construct host-reviewed resource limits. Zero values are never valid authority.
  pub fn new(
    max_request_bytes: u64,
    max_response_bytes: u64,
    max_stream_bytes: u64,
    timeout_ms: u64,
  ) -> Result<Self, GrantError> {
    if [max_request_bytes, max_response_bytes, max_stream_bytes, timeout_ms]
      .into_iter()
      .any(|limit| limit == 0)
    {
      return Err(GrantError::InvalidEntry(
        "resource limits must all be greater than zero".into(),
      ));
    }
    Ok(Self {
      max_request_bytes,
      max_response_bytes,
      max_stream_bytes,
      timeout_ms,
    })
  }

  pub fn max_request_bytes(&self) -> u64 {
    self.max_request_bytes
  }

  pub fn max_response_bytes(&self) -> u64 {
    self.max_response_bytes
  }

  pub fn max_stream_bytes(&self) -> u64 {
    self.max_stream_bytes
  }

  pub fn timeout_ms(&self) -> u64 {
    self.timeout_ms
  }
}

impl Default for ResourceLimits {
  fn default() -> Self {
    Self::new(
      RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES,
      RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES,
      RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES,
      RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS,
    )
    .expect("named default resource limits are valid")
  }
}

/// Host-reviewed network resource mode bound into grant authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkResourceMode {
  /// Only mode in Phase 4: fixed host limits, no unlimited fetch.
  Bounded,
}

impl NetworkResourceMode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Bounded => "bounded",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "bounded" => Ok(Self::Bounded),
      other => Err(format!("invalid network resource mode: {other}")),
    }
  }
}

/// Origin provenance sealed into network authority. `HostFixed` is host-maintained trust;
/// `UserApprovedInstance` is an exact user acknowledgement bound to one instance/config/runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkOriginKind {
  HostFixed,
  InstanceConfigured,
  UserApprovedInstance,
}

impl NetworkOriginKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::HostFixed => "host_fixed",
      Self::InstanceConfigured => "instance_configured",
      Self::UserApprovedInstance => "user_approved_instance",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "host_fixed" => Ok(Self::HostFixed),
      "instance_configured" => Ok(Self::InstanceConfigured),
      "user_approved_instance" => Ok(Self::UserApprovedInstance),
      other => Err(format!("invalid network origin kind: {other}")),
    }
  }
}

/// One reviewed network authority entry: binds capability, endpoint, complete base URL,
/// origin provenance, method, auth policy, resource mode, response body modes, and resource
/// limits. Endpoint/auth policy remain host-resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkGrantEntry {
  capability_id: CapabilityId,
  endpoint_id: EndpointId,
  origin: HttpsOrigin,
  /// Complete canonical endpoint base URL used to join the fixed relative request scope.
  base_url: String,
  origin_kind: NetworkOriginKind,
  method: HttpMethod,
  auth_policy: AuthPolicyId,
  resource_mode: NetworkResourceMode,
  resource_limits: ResourceLimits,
  /// Allowed broker response body variants (json/bytes/stream). Default JSON-only preserves digests.
  response_body_modes: crate::domain::plugin_resource::NetworkResponseBodyModes,
}

impl NetworkGrantEntry {
  /// Construct one complete reviewed network authority entry before it is sealed into a grant.
  pub fn new(
    capability_id: CapabilityId,
    endpoint_id: EndpointId,
    origin: HttpsOrigin,
    method: HttpMethod,
    auth_policy: AuthPolicyId,
    resource_limits: ResourceLimits,
  ) -> Self {
    Self::with_mode(
      capability_id,
      endpoint_id,
      origin,
      method,
      auth_policy,
      NetworkResourceMode::Bounded,
      resource_limits,
    )
  }

  /// Construct a strict-by-default network grant with an explicit resource mode. Callers must
  /// use [`Self::with_mode_and_origin_kind`] after verifying a host-owned fixed-origin allowlist.
  pub fn with_mode(
    capability_id: CapabilityId,
    endpoint_id: EndpointId,
    origin: HttpsOrigin,
    method: HttpMethod,
    auth_policy: AuthPolicyId,
    resource_mode: NetworkResourceMode,
    resource_limits: ResourceLimits,
  ) -> Self {
    Self::with_mode_and_origin_kind(
      capability_id,
      endpoint_id,
      origin,
      NetworkOriginKind::InstanceConfigured,
      method,
      auth_policy,
      resource_mode,
      resource_limits,
    )
  }

  /// Construct a network grant with host-verified origin provenance (authority content).
  pub fn with_mode_and_origin_kind(
    capability_id: CapabilityId,
    endpoint_id: EndpointId,
    origin: HttpsOrigin,
    origin_kind: NetworkOriginKind,
    method: HttpMethod,
    auth_policy: AuthPolicyId,
    resource_mode: NetworkResourceMode,
    resource_limits: ResourceLimits,
  ) -> Self {
    let base_url = origin.as_str().to_string();
    Self {
      capability_id,
      endpoint_id,
      origin,
      base_url,
      origin_kind,
      method,
      auth_policy,
      resource_mode,
      resource_limits,
      response_body_modes: crate::domain::plugin_resource::NetworkResponseBodyModes::JSON_ONLY,
    }
  }

  /// Construct a network grant with explicit response body modes (json/bytes/stream).
  pub fn with_mode_origin_and_response_modes(
    capability_id: CapabilityId,
    endpoint_id: EndpointId,
    origin: HttpsOrigin,
    origin_kind: NetworkOriginKind,
    method: HttpMethod,
    auth_policy: AuthPolicyId,
    resource_mode: NetworkResourceMode,
    resource_limits: ResourceLimits,
    response_body_modes: crate::domain::plugin_resource::NetworkResponseBodyModes,
  ) -> Self {
    let base_url = origin.as_str().to_string();
    Self::with_mode_origin_and_response_modes_and_base_url(
      capability_id,
      endpoint_id,
      origin,
      origin_kind,
      base_url,
      method,
      auth_policy,
      resource_mode,
      resource_limits,
      response_body_modes,
    )
  }

  /// Construct a network grant with a complete canonical base URL. The host validates the URL
  /// against the instance configuration before this authority is persisted or executed.
  pub fn with_mode_origin_and_response_modes_and_base_url(
    capability_id: CapabilityId,
    endpoint_id: EndpointId,
    origin: HttpsOrigin,
    origin_kind: NetworkOriginKind,
    base_url: String,
    method: HttpMethod,
    auth_policy: AuthPolicyId,
    resource_mode: NetworkResourceMode,
    resource_limits: ResourceLimits,
    response_body_modes: crate::domain::plugin_resource::NetworkResponseBodyModes,
  ) -> Self {
    Self {
      capability_id,
      endpoint_id,
      origin,
      base_url,
      origin_kind,
      method,
      auth_policy,
      resource_mode,
      resource_limits,
      response_body_modes,
    }
  }

  pub fn capability_id(&self) -> &CapabilityId {
    &self.capability_id
  }

  pub fn endpoint_id(&self) -> &EndpointId {
    &self.endpoint_id
  }

  pub fn origin(&self) -> &HttpsOrigin {
    &self.origin
  }

  pub fn origin_kind(&self) -> NetworkOriginKind {
    self.origin_kind
  }

  pub fn base_url(&self) -> &str {
    &self.base_url
  }

  pub fn method(&self) -> HttpMethod {
    self.method
  }

  pub fn auth_policy(&self) -> &AuthPolicyId {
    &self.auth_policy
  }

  pub fn resource_mode(&self) -> NetworkResourceMode {
    self.resource_mode
  }

  pub fn resource_limits(&self) -> &ResourceLimits {
    &self.resource_limits
  }

  pub fn response_body_modes(&self) -> crate::domain::plugin_resource::NetworkResponseBodyModes {
    self.response_body_modes
  }
}

/// One reviewed page authority entry: page id, allowed actions, and delegated majors/aliases.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageGrantEntry {
  page_id: PageId,
  actions: Vec<PageActionId>,
  delegated_capability_majors: Vec<CapabilityId>,
  delegated_endpoint_aliases: Vec<EndpointId>,
}

impl PageGrantEntry {
  pub fn page_id(&self) -> &PageId {
    &self.page_id
  }

  pub fn actions(&self) -> impl ExactSizeIterator<Item = &PageActionId> {
    self.actions.iter()
  }

  pub fn delegated_capability_majors(&self) -> impl ExactSizeIterator<Item = &CapabilityId> {
    self.delegated_capability_majors.iter()
  }

  pub fn delegated_endpoint_aliases(&self) -> impl ExactSizeIterator<Item = &EndpointId> {
    self.delegated_endpoint_aliases.iter()
  }
}

/// Host-owned approved execution grant set: one atomic instance/package revision binding
/// capability, network, and page authority entries. Package approval never satisfies this;
/// the broker checks each network request against these entries. The `authority_digest` is a
/// canonical SHA-256 over the authority content; it is bound to issued principals so an old
/// principal cannot authorize a same-revision grant set with different authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionGrantSet {
  instance_id: Uuid,
  identity: RuntimeIdentity,
  plugin_id: PluginId,
  plugin_version: SemVerVersion,
  revision: GrantSetRevision,
  authority_digest: AuthorityDigest,
  capabilities: Vec<CapabilityId>,
  network: Vec<NetworkGrantEntry>,
  pages: Vec<PageGrantEntry>,
}

/// Error raised when constructing or checking an `ExecutionGrantSet`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantError {
  InvalidEntry(String),
  DuplicateEntry(String),
  LimitExceeded(String),
  NotGranted(String),
}

impl std::fmt::Display for GrantError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::InvalidEntry(m) | Self::DuplicateEntry(m) | Self::LimitExceeded(m) | Self::NotGranted(m) => {
        write!(f, "{self:?}: {m}")
      }
    }
  }
}

impl std::error::Error for GrantError {}

impl ExecutionGrantSet {
  /// Validate a complete grant set. Kept private so callers cannot construct a second
  /// authority snapshot for an existing revision.
  fn new(
    instance_id: Uuid,
    identity: RuntimeIdentity,
    plugin_id: PluginId,
    plugin_version: SemVerVersion,
    revision: GrantSetRevision,
    capabilities: Vec<CapabilityId>,
    network: Vec<NetworkGrantEntry>,
    pages: Vec<PageGrantEntry>,
  ) -> Result<Self, GrantError> {
    if network.len() > GRANT_NETWORK_MAX_ENTRIES {
      return Err(GrantError::LimitExceeded(format!(
        "network entries exceed {GRANT_NETWORK_MAX_ENTRIES}"
      )));
    }
    if pages.len() > GRANT_PAGE_MAX_ENTRIES {
      return Err(GrantError::LimitExceeded(format!(
        "page entries exceed {GRANT_PAGE_MAX_ENTRIES}"
      )));
    }
    let mut seen_caps = std::collections::HashSet::new();
    for cap in &capabilities {
      if !seen_caps.insert(cap.as_str().to_string()) {
        return Err(GrantError::DuplicateEntry(format!(
          "duplicate capability {}",
          cap.as_str()
        )));
      }
    }
    let mut seen_net = std::collections::HashSet::new();
    for entry in &network {
      if !capabilities.iter().any(|c| c == &entry.capability_id) {
        return Err(GrantError::InvalidEntry(format!(
          "network entry references ungranted capability {}",
          entry.capability_id.as_str()
        )));
      }
      let key = (
        entry.capability_id.as_str(),
        entry.endpoint_id.as_str(),
        entry.origin.as_str(),
        entry.method,
        entry.auth_policy.as_str(),
      );
      if !seen_net.insert(key) {
        return Err(GrantError::DuplicateEntry("duplicate network entry".into()));
      }
    }
    let mut seen_pages = std::collections::HashSet::new();
    for entry in &pages {
      if !seen_pages.insert(entry.page_id.as_str().to_string()) {
        return Err(GrantError::DuplicateEntry(format!(
          "duplicate page entry {}",
          entry.page_id.as_str()
        )));
      }
      if entry.actions.len() > GRANT_PAGE_MAX_ACTIONS {
        return Err(GrantError::LimitExceeded(format!(
          "page {} exceeds {GRANT_PAGE_MAX_ACTIONS} actions",
          entry.page_id.as_str()
        )));
      }
      let mut seen_actions = std::collections::HashSet::new();
      for action in &entry.actions {
        if !seen_actions.insert(action.as_str().to_string()) {
          return Err(GrantError::DuplicateEntry(format!(
            "duplicate action {} on page {}",
            action.as_str(),
            entry.page_id.as_str()
          )));
        }
      }
    }
    Ok(Self {
      instance_id,
      identity,
      plugin_id,
      plugin_version,
      revision,
      authority_digest: compute_authority_digest(&capabilities, &network, &pages),
      capabilities,
      network,
      pages,
    })
  }

  /// Create the unique initial authority snapshot for an instance/package subject.
  /// The lifecycle store is the sole issuer of initial grant authority snapshots.
  pub(crate) fn initial(
    instance_id: Uuid,
    identity: RuntimeIdentity,
    plugin_id: PluginId,
    plugin_version: SemVerVersion,
    capabilities: Vec<CapabilityId>,
    network: Vec<NetworkGrantEntry>,
    pages: Vec<PageGrantEntry>,
  ) -> Result<Self, GrantError> {
    Self::new(
      instance_id,
      identity,
      plugin_id,
      plugin_version,
      GrantSetRevision::INITIAL,
      capabilities,
      network,
      pages,
    )
  }

  /// Restore a previously validated immutable persistence snapshot. Crate-private; untrusted
  /// DTOs must first be validated by the Phase 4 lifecycle store. The `canonical_digest` is the
  /// persisted digest; it is recomputed from the restored authority content and must match
  /// exactly, so a snapshot tampered to a different authority at the same revision is rejected.
  pub(crate) fn restore_validated(
    instance_id: Uuid,
    identity: RuntimeIdentity,
    plugin_id: PluginId,
    plugin_version: SemVerVersion,
    revision: GrantSetRevision,
    capabilities: Vec<CapabilityId>,
    network: Vec<NetworkGrantEntry>,
    pages: Vec<PageGrantEntry>,
    canonical_digest: AuthorityDigest,
  ) -> Result<Self, GrantError> {
    let computed = compute_authority_digest(&capabilities, &network, &pages);
    if computed != canonical_digest {
      return Err(GrantError::InvalidEntry(
        "canonical authority digest does not match the restored authority content".into(),
      ));
    }
    Self::new(
      instance_id,
      identity,
      plugin_id,
      plugin_version,
      revision,
      capabilities,
      network,
      pages,
    )
  }

  /// Issue a `PluginPrincipal` bound to this exact grant set (revision + authority digest) for
  /// one request. The principal's identity, plugin, instance, revision, and authority digest
  /// all derive from this grant set, so it can only authorize against this exact authority.
  pub(crate) fn principal_for_request(
    &self,
    capability_id: &str,
    request_id: &str,
  ) -> Result<PluginPrincipal, GrantError> {
    if !self.capabilities.iter().any(|cap| cap.as_str() == capability_id) {
      return Err(GrantError::NotGranted(format!(
        "capability {capability_id} is not granted by this grant set"
      )));
    }
    PluginPrincipal::for_request(
      self.identity.clone(),
      self.plugin_id.clone(),
      self.plugin_version.clone(),
      self.instance_id,
      capability_id,
      request_id,
      self.revision,
      self.authority_digest.clone(),
    )
    .map_err(|message| GrantError::InvalidEntry(message))
  }

  /// Create a complete successor grant set. Authority can change only through a strictly
  /// newer revision; the previous immutable grant remains available for verification/rollback.
  /// The lifecycle store must allocate this revision atomically before issuing a successor.
  pub(crate) fn revised(
    &self,
    revision: GrantSetRevision,
    capabilities: Vec<CapabilityId>,
    network: Vec<NetworkGrantEntry>,
    pages: Vec<PageGrantEntry>,
  ) -> Result<Self, GrantError> {
    if revision <= self.revision {
      return Err(GrantError::InvalidEntry(
        "revised grant-set revision must be greater than the current revision".into(),
      ));
    }
    Self::new(
      self.instance_id,
      self.identity.clone(),
      self.plugin_id.clone(),
      self.plugin_version.clone(),
      revision,
      capabilities,
      network,
      pages,
    )
  }

  pub fn instance_id(&self) -> Uuid {
    self.instance_id
  }

  pub fn identity(&self) -> &RuntimeIdentity {
    &self.identity
  }

  pub fn plugin_id(&self) -> &PluginId {
    &self.plugin_id
  }

  pub fn plugin_version(&self) -> &SemVerVersion {
    &self.plugin_version
  }

  pub fn revision(&self) -> GrantSetRevision {
    self.revision
  }

  /// Canonical authority digest bound to this grant set's authority content.
  pub fn authority_digest(&self) -> &AuthorityDigest {
    &self.authority_digest
  }

  pub fn capabilities(&self) -> impl ExactSizeIterator<Item = &CapabilityId> {
    self.capabilities.iter()
  }

  pub fn network_entries(&self) -> impl ExactSizeIterator<Item = &NetworkGrantEntry> {
    self.network.iter()
  }

  pub fn page_entries(&self) -> impl ExactSizeIterator<Item = &PageGrantEntry> {
    self.pages.iter()
  }

  /// Validate that an execution principal is bound to this exact grant-set revision.
  /// Every authority decision must use this check so a valid grant cannot be replayed by
  /// another package, plugin version, instance, capability, or revision.
  fn validate_principal(&self, principal: &PluginPrincipal) -> Result<(), GrantError> {
    if self.instance_id != principal.instance_id {
      return Err(GrantError::NotGranted(
        "grant set is bound to a different instance".into(),
      ));
    }
    if self.identity != principal.identity {
      return Err(GrantError::NotGranted(
        "grant set is bound to a different runtime identity".into(),
      ));
    }
    if self.plugin_id != principal.plugin_id || self.plugin_version != principal.plugin_version {
      return Err(GrantError::NotGranted(
        "grant set is bound to a different plugin identity".into(),
      ));
    }
    if self.revision != principal.grant_set_revision {
      return Err(GrantError::NotGranted(
        "grant-set revision does not match the principal".into(),
      ));
    }
    if self.authority_digest != principal.authority_digest {
      return Err(GrantError::NotGranted(
        "grant-set authority digest does not match the principal".into(),
      ));
    }
    if !self
      .capabilities
      .iter()
      .any(|capability| capability == &principal.capability_id)
    {
      return Err(GrantError::NotGranted(format!(
        "capability {} is not granted",
        principal.capability_id.as_str()
      )));
    }
    Ok(())
  }

  /// Authorize this exact principal or return a stable denial.
  pub fn grants_capability(&self, principal: &PluginPrincipal) -> Result<(), GrantError> {
    self.validate_principal(principal)
  }

  /// Authorize the exact principal for a network request or return a stable denial. This also verifies
  /// the principal's package/plugin/instance/capability/revision binding before matching the
  /// endpoint, origin, method, and auth policy.
  pub fn grants_network(
    &self,
    principal: &PluginPrincipal,
    endpoint: &EndpointId,
    origin: &HttpsOrigin,
    method: HttpMethod,
    auth_policy: &AuthPolicyId,
  ) -> Result<(), GrantError> {
    self.validate_principal(principal)?;
    let found = self.network.iter().any(|entry| {
      entry.capability_id == principal.capability_id
        && &entry.endpoint_id == endpoint
        && &entry.origin == origin
        && entry.method == method
        && &entry.auth_policy == auth_policy
    });
    if !found {
      return Err(GrantError::NotGranted("network request not granted".into()));
    }
    Ok(())
  }

  /// Authorize the exact principal to invoke `action` on `page` or return a stable denial.
  pub fn grants_page(
    &self,
    principal: &PluginPrincipal,
    page: &PageId,
    action: &PageActionId,
  ) -> Result<(), GrantError> {
    self.validate_principal(principal)?;
    let found = self
      .pages
      .iter()
      .any(|entry| &entry.page_id == page && entry.actions.iter().any(|candidate| candidate == action));
    if !found {
      return Err(GrantError::NotGranted(format!(
        "page action {}/{} not granted",
        page.as_str(),
        action.as_str()
      )));
    }
    Ok(())
  }
}

impl PageGrantEntry {
  /// Construct a page grant entry, validating the page id and each action id.
  pub fn parse(page_id: &str, actions: &[&str]) -> Result<Self, String> {
    Self::parse_with_delegation(page_id, actions, &[], &[])
  }

  /// Construct a page grant with delegated capability majors and endpoint aliases.
  pub fn parse_with_delegation(
    page_id: &str,
    actions: &[&str],
    delegated_capability_majors: &[&str],
    delegated_endpoint_aliases: &[&str],
  ) -> Result<Self, String> {
    let page_id = PageId::parse(page_id)?;
    let mut parsed_actions = Vec::with_capacity(actions.len());
    for a in actions {
      parsed_actions.push(PageActionId::parse(a)?);
    }
    let mut majors = Vec::with_capacity(delegated_capability_majors.len());
    for major in delegated_capability_majors {
      majors.push(CapabilityId::parse(major).map_err(|e| format!("{e:?}"))?);
    }
    let mut aliases = Vec::with_capacity(delegated_endpoint_aliases.len());
    for alias in delegated_endpoint_aliases {
      aliases.push(EndpointId::parse(alias)?);
    }
    Ok(Self {
      page_id,
      actions: parsed_actions,
      delegated_capability_majors: majors,
      delegated_endpoint_aliases: aliases,
    })
  }
}

/// Role of an indexed archive file. The signature covers `plugin.json` whose file index
/// transitively authenticates every entry except `signatures/manifest.sig`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileRole {
  RuntimeArtifact,
  ConfigSchema,
  PreferenceSchema,
  Locale,
  License,
  Icon,
  PageAsset,
  Other,
}

/// Indexed archive file record: canonical path, role, byte length, and SHA-256 digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginFileEntry {
  pub path: String,
  pub role: FileRole,
  pub bytes: u64,
  pub sha256: String,
}

/// Runtime artifact descriptor. `artifact` is required only for runtimes backed by an
/// archive artifact (`WasmComponent`, `TrustedNativeWorker`); bundled/frontend runtimes
/// carry no archive artifact.
///
/// Native-worker-only fields (`native_protocol_version`, `native_dependencies`) are optional
/// for v1 serde compatibility; validators require them when `kind` is `TrustedNativeWorker`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDescriptor {
  pub kind: RuntimeKind,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub artifact: Option<String>,
  /// Native framed-protocol version. Required for `TrustedNativeWorker`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub native_protocol_version: Option<u32>,
  /// Exact packaged DLL paths (`runtime/*.dll`), unique and sorted. Required for native workers.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub native_dependencies: Option<Vec<String>>,
}

/// Publisher identity (key id + fingerprint); never the key material itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublisherDeclaration {
  pub key_id: String,
  pub key_fingerprint: String,
}

/// Capability declaration: a closed-set `capability@major` id and optional preferences
/// schema reference. `artifact` optionally pins a per-capability runtime artifact (path into
/// the signed file index) so one package can ship multiple Wasm components, one per world.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityDeclaration {
  pub id: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub preferences_schema: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub artifact: Option<String>,
}

/// Credential slot declared by a manifest. Secrets remain outside config JSON and are
/// referenced by slot id only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialSlotDecl {
  pub id: String,
  pub kind: CredentialSlotKindV1,
  #[serde(default)]
  pub required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialSlotKindV1 {
  SecretText,
  SecretJson,
}

/// HTTP method allowed for a declared network endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Head,
  Options,
}

/// Network endpoint permission request. Endpoints are host-resolved aliases; a manifest
/// never carries executable auth logic or secret-bearing URLs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkEndpointRequest {
  pub id: String,
  pub origins: Vec<String>,
  pub methods: Vec<HttpMethod>,
  /// Optional config field whose normalized HTTPS origin is the approved grant origin at
  /// upgrade time (e.g. `proxy-url` for a third-party HTTPS proxy). When set, `origins` may be
  /// empty; the effective origin is resolved from instance config and persisted in the grant
  /// so a later URL change invalidates the grant and requires a new explicit approval.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub instance_origin_config_field: Option<String>,
}

/// Optional custom page declaration. The host grants page/action authority separately
/// through an instance-scoped execution grant-set entry (Phase 4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageDeclaration {
  pub id: String,
  pub entry: String,
}
/// Permission requests grouped by surface. Requests are not grants.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionRequests {
  #[serde(default)]
  pub network: Vec<NetworkEndpointRequest>,
  #[serde(default)]
  pub auth_policies: Vec<String>,
}

/// UI mode: host-rendered schema form by default, optional isolated custom pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UiMode {
  Schema,
  CustomPage,
}

impl Default for UiMode {
  fn default() -> Self {
    Self::Schema
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiDeclaration {
  #[serde(default)]
  pub mode: UiMode,
  #[serde(default)]
  pub pages: Vec<PageDeclaration>,
}

impl Default for UiDeclaration {
  fn default() -> Self {
    Self {
      mode: UiMode::Schema,
      pages: Vec::new(),
    }
  }
}

/// Platform/architecture install constraint carried in the signed package manifest.
///
/// Empty `targets` (default) means the package is accepted on any host. Non-empty lists require
/// the host to match at least one constraint (`platform`/`architecture` may be `any`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageTargetConstraint {
  pub platform: String,
  pub architecture: String,
}

/// Closed provider-instance endpoint form: the host resolves the bound provider instance's
/// persisted connection. A manifest can never select a package-owned origin.
pub const PROVIDER_RUNTIME_ENDPOINT_FORM_PROVIDER_INSTANCE: &str = "provider-instance";
/// Fixed reserved broker endpoint id used by provider-runtime guests (`host.broker-fetch`).
/// The host resolves the current provider instance; a different endpoint id is never a
/// provider-runtime request.
pub const PROVIDER_RUNTIME_ENDPOINT_ID: &str = "provider-instance";
/// Closed host auth policy bound to a provider-runtime manifest plus a `ProviderInstance`
/// grant subject (implemented in Phase 8 Task 5).
pub const HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID: &str = "host.provider-instance-auth.v1";
/// Maximum number of bounded legacy aliases a provider runtime may declare.
pub const PROVIDER_RUNTIME_LEGACY_ALIASES_MAX_COUNT: usize = 8;
/// Maximum legacy alias length (same bound as adapter ids).
pub const PROVIDER_RUNTIME_ALIAS_MAX_LEN: usize = 128;
/// Upper bound for host-interpreted detection max-token defaults.
pub const PROVIDER_DETECTION_MAX_TOKENS_MAX: u32 = 4096;

/// Fixed provider-instance endpoint/auth form declared by a provider runtime package.
/// Requests capability/transport shape only; it never grants execution authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRuntimeEndpointDecl {
  pub form: String,
  pub auth_policy: String,
}

/// Bounded host-interpreted language-detection defaults. The host validates and projects
/// these; the guest never receives workflow-policy authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRuntimeDetectionDecl {
  pub max_tokens: u32,
  pub thinking: bool,
}

/// Optional signed `providerRuntime` manifest declaration (deny-unknown). Declares bounded
/// legacy aliases, exactly the two frozen LLM capabilities with distinct indexed artifact
/// paths, the closed provider-instance endpoint/auth form, and optional detection defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRuntimeDeclaration {
  pub legacy_aliases: Vec<String>,
  /// Capability id (`llm.models.list@1` / `llm.chat@1`) to its own indexed artifact path.
  pub capabilities: std::collections::BTreeMap<String, String>,
  pub endpoint: ProviderRuntimeEndpointDecl,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detection: Option<ProviderRuntimeDetectionDecl>,
}

/// Plugin manifest v1: the signed payload shape (signature verification is Phase 3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifestV1 {
  pub manifest_version: u32,
  pub plugin_api_version: String,
  pub id: String,
  pub version: String,
  pub publisher: PublisherDeclaration,
  pub runtime: RuntimeDescriptor,
  /// Optional host target constraints. Empty preserves backward compatibility (any host).
  #[serde(default)]
  pub targets: Vec<PackageTargetConstraint>,
  #[serde(default)]
  pub files: Vec<PluginFileEntry>,
  #[serde(default)]
  pub capabilities: Vec<CapabilityDeclaration>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub configuration_schema: Option<String>,
  /// Host-tracked config schema revision for migration (distinct from PluginSchemaV1 dialect version).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub config_schema_version: Option<u32>,
  #[serde(default)]
  pub credential_slots: Vec<CredentialSlotDecl>,
  #[serde(default)]
  pub permissions: PermissionRequests,
  #[serde(default)]
  pub ui: UiDeclaration,
  /// Optional provider runtime declaration (Phase 8). Requests capability/transport shape;
  /// it never grants execution authority.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub provider_runtime: Option<ProviderRuntimeDeclaration>,
  /// Optional signed model-resource descriptors (Phase 10). Metadata only; never model bytes.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub model_resources: Option<Vec<crate::domain::plugin_model::ModelResourceDescriptor>>,
}

/// Normalize `std::env::consts::OS` into a package platform token.
pub fn host_package_platform() -> &'static str {
  match std::env::consts::OS {
    "windows" => "windows",
    "macos" => "macos",
    "linux" => "linux",
    other => other,
  }
}

/// Normalize `std::env::consts::ARCH` into a package architecture token.
pub fn host_package_architecture() -> &'static str {
  match std::env::consts::ARCH {
    "x86_64" => "x86_64",
    "aarch64" => "aarch64",
    other => other,
  }
}

/// Current host target used for package compatibility checks.
pub fn host_package_target() -> PackageTargetConstraint {
  PackageTargetConstraint {
    platform: host_package_platform().to_string(),
    architecture: host_package_architecture().to_string(),
  }
}

/// Return true when `targets` is empty (universal) or the host matches at least one entry.
pub fn package_targets_compatible(targets: &[PackageTargetConstraint], host: &PackageTargetConstraint) -> bool {
  if targets.is_empty() {
    return true;
  }
  targets.iter().any(|target| {
    let platform_ok = target.platform == "any" || target.platform == host.platform;
    let arch_ok = target.architecture == "any" || target.architecture == host.architecture;
    platform_ok && arch_ok
  })
}

/// Validate a single target constraint against the closed platform/architecture sets.
pub fn validate_package_target_constraint(target: &PackageTargetConstraint) -> Result<(), String> {
  if !PACKAGE_TARGET_PLATFORMS.contains(&target.platform.as_str()) {
    return Err(format!(
      "unsupported package target platform '{}' (allowed: {})",
      target.platform,
      PACKAGE_TARGET_PLATFORMS.join(", ")
    ));
  }
  if !PACKAGE_TARGET_ARCHITECTURES.contains(&target.architecture.as_str()) {
    return Err(format!(
      "unsupported package target architecture '{}' (allowed: {})",
      target.architecture,
      PACKAGE_TARGET_ARCHITECTURES.join(", ")
    ));
  }
  Ok(())
}

/// Returns true when every character is a lowercase hex digit (0-9a-f).
fn is_lowercase_hex(value: &str) -> bool {
  value.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// Validate a bounded reverse-domain identifier without trimming. Rejects surrounding
/// whitespace, control characters, and non-ASCII.
pub fn validate_reverse_domain_strict(value: &str, max_len: usize, field: &str) -> Result<(), String> {
  if value.is_empty() {
    return Err(format!("{field} is required"));
  }
  if value != value.trim() {
    return Err(format!("{field} must not have surrounding whitespace"));
  }
  if value.len() > max_len {
    return Err(format!("{field} exceeds {max_len} characters"));
  }
  if value.chars().any(|c| c.is_control()) {
    return Err(format!("{field} must not contain control characters"));
  }
  if !value.is_ascii() {
    return Err(format!("{field} must be ASCII"));
  }
  let mut count = 0;
  for part in value.split('.') {
    count += 1;
    if part.is_empty() {
      return Err(format!("{field} segments must be non-empty"));
    }
    if !part
      .chars()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
      return Err(format!("{field} segments must be lowercase alphanumeric or hyphen"));
    }
    if part.starts_with('-') || part.ends_with('-') {
      return Err(format!("{field} segments must not start or end with hyphen"));
    }
  }
  if count < 2 {
    return Err(format!("{field} must be a reverse-domain identifier"));
  }
  Ok(())
}

/// Validate a bounded kebab-case identifier (lowercase alphanumeric + hyphen) without
/// trimming. Rejects surrounding whitespace.
pub fn validate_kebab_strict(value: &str, max_len: usize, field: &str) -> Result<(), String> {
  if value.is_empty() {
    return Err(format!("{field} is required"));
  }
  if value != value.trim() {
    return Err(format!("{field} must not have surrounding whitespace"));
  }
  if value.len() > max_len {
    return Err(format!("{field} exceeds {max_len} characters"));
  }
  if !value
    .chars()
    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
  {
    return Err(format!("{field} must be lowercase alphanumeric or hyphen"));
  }
  if value.starts_with('-') || value.ends_with('-') || value.contains("--") {
    return Err(format!("{field} must use single hyphens between alphanumeric segments"));
  }
  Ok(())
}

/// Validate a kebab-case slot id without trimming. Delegates to the shared slot id rules
/// but rejects surrounding whitespace first.
pub fn validate_slot_id_strict(value: &str, field: &str) -> Result<(), String> {
  if value.is_empty() {
    return Err(format!("{field} is required"));
  }
  if value != value.trim() {
    return Err(format!("{field} must not have surrounding whitespace"));
  }
  validate_slot_id(value).map_err(|e| format!("{field}: {e}"))
}

/// Windows reserved device names that must never appear as an archive path segment.
const WINDOWS_DEVICE_NAMES: &[&str] = &[
  "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2",
  "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Validate an archive file path strictly. Rejects surrounding whitespace, control
/// characters, backslashes, `:` (Windows drive), absolute paths, traversal/empty segments,
/// Windows trailing dot/space/device-name segments, and the reserved archive entries
/// (`plugin.json`, `signatures/manifest.sig`) plus their case-folded forms and directory
/// prefixes. Returns the canonical path unchanged. Used for the signed file INDEX.
pub fn validate_archive_path(value: &str) -> Result<String, String> {
  validate_archive_path_impl(value, false)
}

/// Validate an archive ENTRY path. Same as `validate_archive_path` but permits the reserved
/// archive entries because they are required members of the archive payload.
pub fn validate_archive_entry_path(value: &str) -> Result<String, String> {
  validate_archive_path_impl(value, true)
}

fn validate_archive_path_impl(value: &str, allow_reserved: bool) -> Result<String, String> {
  if value.is_empty() {
    return Err("file path is required".into());
  }
  if value != value.trim() {
    return Err("file path must not have surrounding whitespace".into());
  }
  if value.len() > FILE_PATH_MAX_LEN {
    return Err(format!("file path exceeds {FILE_PATH_MAX_LEN} characters"));
  }
  if value.chars().any(|c| c.is_control()) {
    return Err("file path must not contain control characters".into());
  }
  if !value.is_ascii() {
    return Err("file path must be ASCII for cross-platform archive portability".into());
  }
  if value.contains('\\') {
    return Err("file path must use forward slashes".into());
  }
  if value.contains(['<', '>', '"', '|', '?', '*']) {
    return Err("file path contains a Windows-reserved character".into());
  }
  if value.contains(':') {
    return Err("file path must not contain ':' (Windows drive or invalid segment)".into());
  }
  if value.starts_with('/') {
    return Err("file path must be relative".into());
  }
  let lower = value.to_ascii_lowercase();
  let has_reserved_prefix = lower.starts_with(&format!("{MANIFEST_FILE_PATH}/"))
    || lower.starts_with(&format!("{SIGNATURE_FILE_PATH}/"))
    || lower.starts_with(&format!("{PUBLISHER_PUBLIC_KEY_PATH}/"));
  if has_reserved_prefix {
    return Err(format!(
      "file path {value} uses a reserved archive entry as a directory prefix"
    ));
  }
  if lower == MANIFEST_FILE_PATH || lower == SIGNATURE_FILE_PATH || lower == PUBLISHER_PUBLIC_KEY_PATH {
    if !allow_reserved {
      return Err(format!(
        "file path {value} is a reserved archive entry (case-insensitive) and cannot be indexed"
      ));
    }
    let canonical = if lower == MANIFEST_FILE_PATH {
      MANIFEST_FILE_PATH
    } else if lower == SIGNATURE_FILE_PATH {
      SIGNATURE_FILE_PATH
    } else {
      PUBLISHER_PUBLIC_KEY_PATH
    };
    if value != canonical {
      return Err(format!(
        "reserved archive entry must use canonical spelling {canonical}"
      ));
    }
  }
  for segment in value.split('/') {
    if segment.is_empty() {
      return Err("file path must not contain empty segments".into());
    }
    if segment == "." || segment == ".." {
      return Err("file path must not contain traversal segments".into());
    }
    if segment != segment.trim() {
      return Err("file path segments must not have surrounding whitespace".into());
    }
    if segment.ends_with('.') || segment.ends_with(' ') {
      return Err(format!(
        "file path segment {segment} must not end with '.' or space (Windows)"
      ));
    }
    let device_base = segment.split('.').next().unwrap_or(segment).to_ascii_uppercase();
    if WINDOWS_DEVICE_NAMES.contains(&device_base.as_str()) {
      return Err(format!("file path segment {segment} is a Windows device name"));
    }
  }
  Ok(value.to_string())
}

/// Check a set of indexed file paths for cross-file collisions: directory-vs-file
/// collisions (one path is a parent directory of another) and case-fold duplicates.
pub fn check_file_index_collisions(paths: &[String]) -> Result<(), String> {
  let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
  for path in paths {
    let lower = path.to_ascii_lowercase();
    if let Some(existing) = seen.get(&lower) {
      return Err(format!("case-fold collision: {existing} vs {path}"));
    }
    seen.insert(lower, path.clone());
  }
  let normalized: Vec<String> = paths.iter().map(|path| path.to_ascii_lowercase()).collect();
  for (index, parent) in normalized.iter().enumerate() {
    for (candidate_index, candidate) in normalized.iter().enumerate() {
      if index != candidate_index && candidate.starts_with(&format!("{parent}/")) {
        return Err(format!(
          "file-vs-directory collision: {} is a parent of {}",
          paths[index], paths[candidate_index]
        ));
      }
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn capability_single_table_derives_id_name_world_major() {
    assert_eq!(CAPABILITY_SPECS.len(), CAPABILITY_V1_COUNT);
    for spec in CAPABILITY_SPECS {
      assert_eq!(spec.major, CAPABILITY_MAJOR_V1);
      assert_eq!(capability_world(spec.id), Some(spec.world));
      assert!(capability_spec(spec.id).is_some());
    }
    // The id, name, and world are all derived from one table; no parallel constant drift.
    assert_eq!(capability_world("translate.text@1"), Some("translate-text-world"));
    assert_eq!(capability_world("llm.chat@1"), Some("llm-chat-world"));
    assert!(capability_world("unknown@1").is_none());
  }

  #[test]
  fn capability_id_parse_classifies_errors() {
    assert!(CapabilityId::parse("translate.text@1").is_ok());
    assert_eq!(
      CapabilityId::parse("translate.text@2").unwrap_err(),
      CapabilityIdError::UnsupportedMajor {
        declared: 2,
        supported: 1
      }
    );
    assert_eq!(
      CapabilityId::parse("unknown.cap@1").unwrap_err(),
      CapabilityIdError::UnknownCapability
    );
    assert!(matches!(
      CapabilityId::parse("translate.text").unwrap_err(),
      CapabilityIdError::InvalidSyntax(_)
    ));
    assert!(matches!(
      CapabilityId::parse(" translate.text@1").unwrap_err(),
      CapabilityIdError::InvalidSyntax(_)
    ));
  }

  #[test]
  fn plugin_api_version_requires_supported_canonical_minor() {
    assert!(
      PluginApiVersion::parse(HOST_PLUGIN_API_VERSION_CURRENT)
        .unwrap()
        .is_host_compatible()
    );
    assert!(!PluginApiVersion::parse("1.1").unwrap().is_host_compatible());
    assert!(PluginApiVersion::parse("1.00").is_err());
  }

  #[test]
  fn principal_identity_inherits_from_grant_set() {
    // Principals are issued from a grant set, inheriting its identity/revision/authority digest.
    let bundled_grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.example.b").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![CapabilityId::parse("translate.text@1").unwrap()],
      vec![],
      vec![],
    )
    .unwrap();
    let bundled_principal = bundled_grant.principal_for_request("translate.text@1", "r").unwrap();
    assert!(!bundled_principal.has_package_digest());

    let identity = RuntimeIdentity::Package(PackageIdentity {
      package_digest: PackageDigest::parse(&"a".repeat(SHA256_HEX_LEN)).unwrap(),
    });
    let pkg_grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      identity,
      PluginId::parse("com.example.t").unwrap(),
      SemVerVersion::parse("1.2.0").unwrap(),
      vec![CapabilityId::parse("ocr.image@1").unwrap()],
      vec![],
      vec![],
    )
    .unwrap();
    let pkg_principal = pkg_grant.principal_for_request("ocr.image@1", "r2").unwrap();
    assert!(pkg_principal.has_package_digest());
    assert_eq!(pkg_principal.capability_id().world(), "ocr-image-world");
    // A principal cannot be issued for a capability the grant set does not authorize.
    assert!(bundled_grant.principal_for_request("ocr.image@1", "r3").is_err());
  }

  #[test]
  fn endpoint_aliases_are_canonical_kebab_identifiers() {
    assert!(EndpointId::parse("gtx").is_ok());
    assert!(EndpointId::parse("translate-api").is_ok());
    assert!(EndpointId::parse("com.example.endpoint").is_err());
  }

  #[test]
  fn https_origin_canonical_rejects_userinfo_query_fragment_default_port() {
    assert!(HttpsOrigin::parse("https://api.example.com").is_ok());
    assert!(HttpsOrigin::parse("https://api.example.com:8443").is_ok());
    for bad in [
      "https://user:pass@api.example.com",
      "https://api.example.com?q=1",
      "https://api.example.com#f",
      "https://api.example.com/",
      "https://api.example.com:443",
      "https://API.Example.COM",
      "http://api.example.com",
    ] {
      assert!(HttpsOrigin::parse(bad).is_err(), "should reject {bad}");
    }
  }

  #[test]
  fn grant_set_authority_and_cross_rejection() {
    let cap = CapabilityId::parse("translate.text@1").unwrap();
    let endpoint = EndpointId::parse("translate-api").unwrap();
    let origin = HttpsOrigin::parse("https://api.example.com").unwrap();
    let auth = AuthPolicyId::parse("host.api-key.header.v1").unwrap();
    let net = NetworkGrantEntry::new(
      cap.clone(),
      endpoint.clone(),
      origin.clone(),
      HttpMethod::Post,
      auth.clone(),
      ResourceLimits::default(),
    );
    let page = PageGrantEntry::parse("auth-page", &["open", "close"]).unwrap();
    let identity = RuntimeIdentity::Package(PackageIdentity {
      package_digest: PackageDigest::parse(&"a".repeat(SHA256_HEX_LEN)).unwrap(),
    });
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      identity.clone(),
      PluginId::parse("com.example.t").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![cap.clone()],
      vec![net.clone()],
      vec![page.clone()],
    )
    .unwrap();

    let principal = grant.principal_for_request("translate.text@1", "request-1").unwrap();
    // Granted for the exact bound principal and authority digest.
    grant.grants_capability(&principal).unwrap();
    grant
      .grants_network(&principal, &endpoint, &origin, HttpMethod::Post, &auth)
      .unwrap();
    grant
      .grants_page(&principal, page.page_id(), page.actions().next().unwrap())
      .unwrap();

    // Cross-instance rejection: a principal from a different instance's grant cannot authorize.
    let other_instance_grant = ExecutionGrantSet::initial(
      Uuid::max(),
      identity.clone(),
      PluginId::parse("com.example.t").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![cap.clone()],
      vec![net.clone()],
      vec![page.clone()],
    )
    .unwrap();
    let other_instance = other_instance_grant
      .principal_for_request("translate.text@1", "request-1")
      .unwrap();
    assert!(grant.grants_capability(&other_instance).is_err());

    // Cross-identity rejection: a bundled grant's principal cannot authorize a package grant.
    let bundled_grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.example.t").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![cap.clone()],
      vec![net.clone()],
      vec![page.clone()],
    )
    .unwrap();
    let other_package = bundled_grant
      .principal_for_request("translate.text@1", "request-1")
      .unwrap();
    assert!(grant.grants_capability(&other_package).is_err());

    // Cross-revision rejection: a principal from a revised grant cannot authorize the original.
    let next = GrantSetRevision::new(GrantSetRevision::INITIAL.as_u64() + 1).unwrap();
    let revised_grant = grant
      .revised(next, vec![cap.clone()], vec![net.clone()], vec![page.clone()])
      .unwrap();
    let other_revision = revised_grant
      .principal_for_request("translate.text@1", "request-1")
      .unwrap();
    assert!(grant.grants_capability(&other_revision).is_err());

    // Network method mismatch and page action rejection.
    assert!(
      grant
        .grants_network(&principal, &endpoint, &origin, HttpMethod::Get, &auth)
        .is_err()
    );
    let unknown_action = PageActionId::parse("delete").unwrap();
    assert!(grant.grants_page(&principal, page.page_id(), &unknown_action).is_err());
  }

  #[test]
  fn grant_set_same_revision_different_authority_rejected_via_digest() {
    // An old principal (issued for authority {translate}) cannot authorize a same-revision grant
    // set with different authority {translate, ocr}, even though instance/identity/plugin/revision
    // match: the canonical authority digest differs. This closes the same-revision expansion gap
    // that a future repository invariant alone cannot guarantee.
    let translate = CapabilityId::parse("translate.text@1").unwrap();
    let ocr = CapabilityId::parse("ocr.image@1").unwrap();
    let grant_a = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.example.t").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![translate.clone()],
      vec![],
      vec![],
    )
    .unwrap();
    let principal_a = grant_a.principal_for_request("translate.text@1", "r").unwrap();

    // grant_b: same subject/revision, expanded authority, restored via the canonical digest.
    let expanded = vec![translate.clone(), ocr];
    let digest_b = compute_authority_digest(&expanded, &[], &[]);
    let grant_b = ExecutionGrantSet::restore_validated(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.example.t").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      GrantSetRevision::INITIAL,
      expanded,
      vec![],
      vec![],
      digest_b,
    )
    .unwrap();
    assert_ne!(grant_a.authority_digest(), grant_b.authority_digest());
    // principal_a (digest for {translate}) cannot authorize grant_b (digest for {translate, ocr}).
    assert!(grant_b.grants_capability(&principal_a).is_err());
    // A principal issued from grant_b authorizes grant_b but not grant_a.
    let principal_b = grant_b.principal_for_request("translate.text@1", "r2").unwrap();
    assert!(grant_b.grants_capability(&principal_b).is_ok());
    assert!(grant_a.grants_capability(&principal_b).is_err());
  }

  #[test]
  fn restore_validated_rejects_mismatched_canonical_digest() {
    let translate = CapabilityId::parse("translate.text@1").unwrap();
    let ocr = CapabilityId::parse("ocr.image@1").unwrap();
    // Digest for {translate} passed with {translate, ocr} authority -> mismatch -> rejected.
    let wrong_digest = compute_authority_digest(&[translate.clone()], &[], &[]);
    let err = ExecutionGrantSet::restore_validated(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.example.t").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      GrantSetRevision::INITIAL,
      vec![translate, ocr],
      vec![],
      vec![],
      wrong_digest,
    )
    .unwrap_err();
    assert!(matches!(err, GrantError::InvalidEntry(_)));
  }

  #[test]
  fn grant_set_requires_a_new_revision_for_any_authority_change() {
    let capability = CapabilityId::parse("translate.text@1").unwrap();
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.example.t").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![capability.clone()],
      vec![],
      vec![],
    )
    .unwrap();
    assert_eq!(grant.capabilities().count(), 1);
    assert!(
      grant
        .revised(GrantSetRevision::INITIAL, vec![capability.clone()], vec![], vec![])
        .is_err()
    );
    let next_revision = GrantSetRevision::new(GrantSetRevision::INITIAL.as_u64() + 1).unwrap();
    let successor = grant.revised(next_revision, vec![capability], vec![], vec![]).unwrap();
    assert_eq!(grant.revision(), GrantSetRevision::INITIAL);
    assert_eq!(successor.revision(), next_revision);
  }

  #[test]
  fn grant_set_same_revision_cannot_expand_authority() {
    // Grant fields are private and immutable; the only authority-change path is a strictly
    // newer revision. Expanding capabilities at the same revision is rejected, and the
    // original immutable grant is unchanged after a successor is issued.
    let translate = CapabilityId::parse("translate.text@1").unwrap();
    let ocr = CapabilityId::parse("ocr.image@1").unwrap();
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.example.t").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![translate.clone()],
      vec![],
      vec![],
    )
    .unwrap();
    assert_eq!(grant.capabilities().count(), 1);

    // Same revision cannot expand to add the OCR capability.
    let same_revision = GrantSetRevision::INITIAL;
    assert!(
      grant
        .revised(same_revision, vec![translate.clone(), ocr.clone()], vec![], vec![])
        .is_err(),
      "same-revision authority expansion must be rejected"
    );
    // The original immutable grant still has exactly one capability.
    assert_eq!(grant.capabilities().count(), 1);
    assert_eq!(grant.revision(), GrantSetRevision::INITIAL);

    // A newer revision is the only path to expand authority.
    let next_revision = GrantSetRevision::new(GrantSetRevision::INITIAL.as_u64() + 1).unwrap();
    let expanded = grant
      .revised(next_revision, vec![translate, ocr], vec![], vec![])
      .unwrap();
    assert_eq!(expanded.capabilities().count(), 2);
    assert_eq!(expanded.revision(), next_revision);
    // The original grant remains unchanged and at the original revision.
    assert_eq!(grant.capabilities().count(), 1);
    assert_eq!(grant.revision(), GrantSetRevision::INITIAL);
  }

  #[test]
  fn grant_set_rejects_duplicate_and_ungranted_entries() {
    let cap = CapabilityId::parse("translate.text@1").unwrap();
    let endpoint = EndpointId::parse("translate-api").unwrap();
    let origin = HttpsOrigin::parse("https://api.example.com").unwrap();
    let auth = AuthPolicyId::parse("host.api-key.header.v1").unwrap();
    let net = NetworkGrantEntry::new(
      cap.clone(),
      endpoint.clone(),
      origin.clone(),
      HttpMethod::Post,
      auth.clone(),
      ResourceLimits::default(),
    );
    // Duplicate network entry.
    let err = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.example.t").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![cap.clone()],
      vec![net.clone(), net.clone()],
      vec![],
    )
    .unwrap_err();
    assert!(matches!(err, GrantError::DuplicateEntry(_)));

    // Network entry references ungranted capability.
    let ungranted_cap = CapabilityId::parse("ocr.image@1").unwrap();
    let bad_net = NetworkGrantEntry::new(
      ungranted_cap,
      endpoint,
      origin,
      HttpMethod::Post,
      auth,
      ResourceLimits::default(),
    );
    let err = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.example.t").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![cap],
      vec![bad_net],
      vec![],
    )
    .unwrap_err();
    assert!(matches!(err, GrantError::InvalidEntry(_)));
  }

  #[test]
  fn archive_path_strict_rejects_reserved_casefold_prefix_devicename_trailing() {
    assert_eq!(
      validate_archive_path("artifacts/plugin.wasm").unwrap(),
      "artifacts/plugin.wasm"
    );
    for bad in [
      "plugin.json",
      "PLUGIN.JSON",
      "signatures/manifest.sig",
      "plugin.json/inner",
      "artifacts/\twasm",
      " artifacts/x",
      "C:/foo",
      "a\\b",
      "a//b",
      "a/./b",
      "foo.", // trailing dot
      "foo ", // trailing space
      "CON",  // device name
      "com1",
      "artifacts/café.wasm",
      "artifacts/a<b",
      "artifacts/a>b",
      "artifacts/a\"b",
      "artifacts/a|b",
      "artifacts/a?b",
      "artifacts/a*b",
      "assets/CON.txt",
    ] {
      assert!(validate_archive_path(bad).is_err(), "should reject {bad}");
    }
    // Reserved entries are allowed for archive entries.
    assert!(validate_archive_entry_path("plugin.json").is_ok());
    assert!(validate_archive_entry_path("signatures/manifest.sig").is_ok());
  }

  #[test]
  fn page_and_action_ids_are_strict_kebab_case() {
    assert!(PageId::parse("account-page").is_ok());
    assert!(PageActionId::parse("open-login").is_ok());
    for invalid in ["account--page", "-account", "account-", "Account"] {
      assert!(PageId::parse(invalid).is_err(), "invalid page id {invalid}");
      assert!(PageActionId::parse(invalid).is_err(), "invalid action id {invalid}");
    }
  }

  #[test]
  fn file_index_collisions_directory_and_casefold() {
    assert!(check_file_index_collisions(&["a/b".into(), "a/c".into()]).is_ok());
    assert!(check_file_index_collisions(&["artifacts".into(), "artifacts/x".into()]).is_err());
    assert!(check_file_index_collisions(&["Assets".into(), "assets/icon.png".into()]).is_err());
    assert!(check_file_index_collisions(&["Foo.txt".into(), "foo.txt".into()]).is_err());
    assert!(validate_archive_path("assets/CON.txt").is_err());
  }

  #[test]
  fn semver_supports_prerelease_rejects_leading_zero() {
    assert!(SemVerVersion::parse("1.0.0-beta.1+build.5").is_ok());
    assert!(SemVerVersion::parse("1.02.3").is_err());
  }
}
