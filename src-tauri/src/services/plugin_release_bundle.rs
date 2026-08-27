// ABOUTME: Read-only verification of a signed official plugin release resource set.
// ABOUTME: Never reads private keys; required packages, public roots, and exact policies must agree.
pub use crate::domain::first_party_plugins::{
  ANTHROPIC_PLUGIN_ID, BAIDU_OCR_PLUGIN_ID, DEEPSEEK_PLUGIN_ID, GEMINI_PLUGIN_ID, OPENAI_COMPATIBLE_PLUGIN_ID,
  OPENAI_RESPONSES_PLUGIN_ID,
};
use crate::domain::first_party_plugins::{
  EDGE_TTS_PLUGIN_ID, GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_TRANSLATE_WEB_PLUGIN_ID, PADDLEOCR_PLUGIN_ID,
};
use crate::domain::plugin_package::{PACKAGE_ARCHIVE_MAX_BYTES, compute_permission_request_digest};
use crate::services::default_package_activation::{
  VendorBootstrapPolicyEntry, build_authority_constraints, generate_vendor_bootstrap_policy_from_verified,
};
use crate::services::plugin_package::{
  PackageVerifyError, VerifiedPackage, inspect_package_bytes, read_file_bounded, verify_package_bytes,
};
use crate::services::vendor_trust::{self, VendorPublicKey};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// One official package that a release bundle must contain at an exact version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfficialReleasePackage {
  pub plugin_id: &'static str,
  pub expected_version: &'static str,
}

/// Official packages required in the current release resource set.
pub const REQUIRED_OFFICIAL_RELEASE_PACKAGES: &[OfficialReleasePackage] = &[
  OfficialReleasePackage {
    plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID,
    expected_version: "1.0.0",
  },
  OfficialReleasePackage {
    plugin_id: EDGE_TTS_PLUGIN_ID,
    expected_version: "1.0.0",
  },
  OfficialReleasePackage {
    plugin_id: GOOGLE_CLOUD_PLUGIN_ID,
    expected_version: "1.2.0",
  },
  OfficialReleasePackage {
    plugin_id: OPENAI_COMPATIBLE_PLUGIN_ID,
    expected_version: "1.0.0",
  },
  OfficialReleasePackage {
    plugin_id: OPENAI_RESPONSES_PLUGIN_ID,
    expected_version: "1.0.0",
  },
  OfficialReleasePackage {
    plugin_id: ANTHROPIC_PLUGIN_ID,
    expected_version: "1.0.0",
  },
  OfficialReleasePackage {
    plugin_id: GEMINI_PLUGIN_ID,
    expected_version: "1.0.0",
  },
  OfficialReleasePackage {
    plugin_id: DEEPSEEK_PLUGIN_ID,
    expected_version: "1.0.0",
  },
  OfficialReleasePackage {
    plugin_id: PADDLEOCR_PLUGIN_ID,
    expected_version: "1.0.0",
  },
  OfficialReleasePackage {
    plugin_id: BAIDU_OCR_PLUGIN_ID,
    expected_version: "1.0.0",
  },
];

const PLUGIN_ARCHIVE_SUFFIX: &str = ".lnplugin";
const DEFAULT_ACTIVATION_POLICIES_FILE: &str = "default-activation-policies.json";

/// Stable release-bundle failure class. Codes are the public seam; messages stay non-secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseBundleErrorCode {
  MissingRoot,
  MissingPackage,
  MissingPolicy,
  StalePolicy,
  DuplicateVersion,
  WrongPublisher,
  WrongDigest,
  WrongVersion,
  PrivateMaterial,
  SignatureInvalid,
  InvalidBundle,
}

impl ReleaseBundleErrorCode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::MissingRoot => "missing_root",
      Self::MissingPackage => "missing_package",
      Self::MissingPolicy => "missing_policy",
      Self::StalePolicy => "stale_policy",
      Self::DuplicateVersion => "duplicate_version",
      Self::WrongPublisher => "wrong_publisher",
      Self::WrongDigest => "wrong_digest",
      Self::WrongVersion => "wrong_version",
      Self::PrivateMaterial => "private_material",
      Self::SignatureInvalid => "signature_invalid",
      Self::InvalidBundle => "invalid_bundle",
    }
  }
}

/// Fail-closed release bundle verification error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseBundleError {
  pub code: ReleaseBundleErrorCode,
  pub message: String,
}

impl ReleaseBundleError {
  pub fn new(code: ReleaseBundleErrorCode, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
    }
  }
}

impl std::fmt::Display for ReleaseBundleError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}: {}", self.code.as_str(), self.message)
  }
}

impl std::error::Error for ReleaseBundleError {}

/// One verified official package in a passing release bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleasePackageStatus {
  pub plugin_id: String,
  pub version: String,
  pub package_digest: String,
  pub status: &'static str,
}

/// Successful release-bundle report. Contains only plugin identity and digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseBundleReport {
  pub packages: Vec<ReleasePackageStatus>,
}

/// Verify a resource directory as a complete signed official release set.
///
/// Expected layout:
/// - `vendor-trust/public-keys.json`
/// - `plugins/*.lnplugin`
/// - `plugins/default-activation-policies.json`
///
/// Never reads private keys or seeds. Missing, duplicate, mismatched, or stale inputs fail closed.
pub fn verify_release_bundle(resource_dir: &Path) -> Result<ReleaseBundleReport, ReleaseBundleError> {
  reject_private_material(resource_dir)?;
  let vendor_roots = load_required_vendor_roots(resource_dir)?;
  let plugins_dir = resource_dir.join("plugins");
  let archives = list_plugin_archives(&plugins_dir)?;
  if archives.is_empty() {
    return Err(ReleaseBundleError::new(
      ReleaseBundleErrorCode::MissingPackage,
      "release bundle contains no signed .lnplugin archives",
    ));
  }

  let mut verified_by_id: HashMap<String, VerifiedPackage> = HashMap::new();
  let mut statuses = Vec::new();
  for archive_path in &archives {
    let bytes = read_file_bounded(archive_path, PACKAGE_ARCHIVE_MAX_BYTES).map_err(map_package_error)?;
    let verified = verify_archive_against_vendor_roots(&bytes, &vendor_roots)?;
    if verified_by_id.contains_key(&verified.manifest.id) {
      return Err(ReleaseBundleError::new(
        ReleaseBundleErrorCode::DuplicateVersion,
        format!(
          "duplicate package {}@{}; exactly one archive per plugin id is required",
          verified.manifest.id, verified.manifest.version
        ),
      ));
    }
    log::info!(
      "release_bundle plugin={} version={} digest={} status=ok",
      verified.manifest.id,
      verified.manifest.version,
      verified.package_digest
    );
    statuses.push(ReleasePackageStatus {
      plugin_id: verified.manifest.id.clone(),
      version: verified.manifest.version.clone(),
      package_digest: verified.package_digest.clone(),
      status: "ok",
    });
    verified_by_id.insert(verified.manifest.id.clone(), verified);
  }

  let required_ids: HashSet<&str> = REQUIRED_OFFICIAL_RELEASE_PACKAGES
    .iter()
    .map(|spec| spec.plugin_id)
    .collect();
  for plugin_id in verified_by_id.keys() {
    if !required_ids.contains(plugin_id.as_str()) {
      return Err(ReleaseBundleError::new(
        ReleaseBundleErrorCode::InvalidBundle,
        format!("unexpected official package id {plugin_id}"),
      ));
    }
  }

  for spec in REQUIRED_OFFICIAL_RELEASE_PACKAGES {
    let package = verified_by_id.get(spec.plugin_id).ok_or_else(|| {
      ReleaseBundleError::new(
        ReleaseBundleErrorCode::MissingPackage,
        format!("missing required package {}", spec.plugin_id),
      )
    })?;
    if package.manifest.version != spec.expected_version {
      return Err(ReleaseBundleError::new(
        ReleaseBundleErrorCode::WrongVersion,
        format!(
          "package {} expected version {}, found {}",
          spec.plugin_id, spec.expected_version, package.manifest.version
        ),
      ));
    }
  }

  let policies = load_bootstrap_policies(&plugins_dir.join(DEFAULT_ACTIVATION_POLICIES_FILE))?;
  verify_policies_match_required_packages(&policies, &verified_by_id)?;

  statuses.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id).then(a.version.cmp(&b.version)));
  Ok(ReleaseBundleReport { packages: statuses })
}

/// Generate one vendor bootstrap policy from an already signed archive and an external public root.
pub fn generate_bootstrap_policy_entry(
  archive_bytes: &[u8],
  public_key_hex: &str,
) -> Result<VendorBootstrapPolicyEntry, ReleaseBundleError> {
  let verified = verify_package_bytes(archive_bytes, public_key_hex).map_err(map_package_error)?;
  Ok(generate_vendor_bootstrap_policy_from_verified(&verified))
}

/// Generate bootstrap policy JSON entries from verified signed archives and one vendor public root.
pub fn generate_bootstrap_policies_from_archives(
  archive_paths: &[PathBuf],
  public_key_hex: &str,
) -> Result<Vec<VendorBootstrapPolicyEntry>, ReleaseBundleError> {
  let mut entries = Vec::with_capacity(archive_paths.len());
  for path in archive_paths {
    let bytes = read_file_bounded(path, PACKAGE_ARCHIVE_MAX_BYTES).map_err(map_package_error)?;
    let entry = generate_bootstrap_policy_entry(&bytes, public_key_hex)?;
    log::info!(
      "bootstrap_policy plugin={} digest={} status=generated",
      entry.plugin_id,
      entry.package_digest
    );
    entries.push(entry);
  }
  Ok(entries)
}

fn verify_archive_against_vendor_roots(
  archive_bytes: &[u8],
  vendor_roots: &[VendorPublicKey],
) -> Result<VerifiedPackage, ReleaseBundleError> {
  let inspected = inspect_package_bytes(archive_bytes).map_err(map_package_error)?;
  let root = vendor_roots
    .iter()
    .find(|root| root.key_id == inspected.manifest.publisher.key_id)
    .ok_or_else(|| {
      ReleaseBundleError::new(
        ReleaseBundleErrorCode::WrongPublisher,
        format!(
          "package {} publisher {} is not a configured vendor root",
          inspected.manifest.id, inspected.manifest.publisher.key_id
        ),
      )
    })?;
  let verified = verify_package_bytes(archive_bytes, &root.public_key_hex).map_err(|err| {
    if err.code == crate::domain::plugin_package::PackageErrorCode::SignatureInvalid {
      ReleaseBundleError::new(
        ReleaseBundleErrorCode::SignatureInvalid,
        format!(
          "package {} signature is invalid for vendor root {}",
          inspected.manifest.id, root.key_id
        ),
      )
    } else {
      map_package_error(err)
    }
  })?;
  if verified.manifest.publisher.key_id != root.key_id
    || verified.publisher_fingerprint != inspected.manifest.publisher.key_fingerprint
  {
    return Err(ReleaseBundleError::new(
      ReleaseBundleErrorCode::WrongPublisher,
      format!(
        "package {} publisher identity does not match vendor root",
        verified.manifest.id
      ),
    ));
  }
  Ok(verified)
}

fn verify_policies_match_required_packages(
  policies: &[VendorBootstrapPolicyEntry],
  verified: &HashMap<String, VerifiedPackage>,
) -> Result<(), ReleaseBundleError> {
  let mut seen_plugin_ids = HashSet::new();
  for policy in policies {
    if !seen_plugin_ids.insert(policy.plugin_id.clone()) {
      return Err(ReleaseBundleError::new(
        ReleaseBundleErrorCode::StalePolicy,
        format!("duplicate bootstrap policy for {}", policy.plugin_id),
      ));
    }
    let spec = REQUIRED_OFFICIAL_RELEASE_PACKAGES
      .iter()
      .find(|spec| spec.plugin_id == policy.plugin_id)
      .ok_or_else(|| {
        ReleaseBundleError::new(
          ReleaseBundleErrorCode::StalePolicy,
          format!("bootstrap policy for unknown plugin {}", policy.plugin_id),
        )
      })?;
    let package = verified.get(&policy.plugin_id).ok_or_else(|| {
      ReleaseBundleError::new(
        ReleaseBundleErrorCode::MissingPackage,
        format!(
          "policy {}@{} has no matching archive",
          policy.plugin_id, spec.expected_version
        ),
      )
    })?;
    if policy.package_digest != package.package_digest {
      return Err(ReleaseBundleError::new(
        ReleaseBundleErrorCode::WrongDigest,
        format!("bootstrap policy digest does not match package {}", policy.plugin_id),
      ));
    }
    if policy.publisher_key_id != package.manifest.publisher.key_id
      || policy.publisher_fingerprint != package.publisher_fingerprint
    {
      return Err(ReleaseBundleError::new(
        ReleaseBundleErrorCode::WrongPublisher,
        format!("bootstrap policy publisher does not match package {}", policy.plugin_id),
      ));
    }
    let expected_permission = compute_permission_request_digest(&package.manifest);
    let expected_constraints = build_authority_constraints(&package.manifest);
    if policy.permission_request_digest != expected_permission
      || policy.approved_authority_constraints != expected_constraints
    {
      return Err(ReleaseBundleError::new(
        ReleaseBundleErrorCode::StalePolicy,
        format!(
          "bootstrap policy for {} is stale relative to the verified package",
          policy.plugin_id
        ),
      ));
    }
  }

  for spec in REQUIRED_OFFICIAL_RELEASE_PACKAGES {
    if !seen_plugin_ids.contains(spec.plugin_id) {
      return Err(ReleaseBundleError::new(
        ReleaseBundleErrorCode::MissingPolicy,
        format!("missing bootstrap policy for {}", spec.plugin_id),
      ));
    }
  }
  Ok(())
}

fn load_required_vendor_roots(resource_dir: &Path) -> Result<Vec<VendorPublicKey>, ReleaseBundleError> {
  let path = resource_dir.join("vendor-trust").join("public-keys.json");
  if !path.is_file() {
    return Err(ReleaseBundleError::new(
      ReleaseBundleErrorCode::MissingRoot,
      "vendor-trust/public-keys.json is missing",
    ));
  }
  let roots = vendor_trust::load_vendor_public_keys_file(&path)
    .map_err(|err| ReleaseBundleError::new(ReleaseBundleErrorCode::InvalidBundle, err))?;
  if roots.is_empty() {
    return Err(ReleaseBundleError::new(
      ReleaseBundleErrorCode::MissingRoot,
      "vendor-trust/public-keys.json contains no production public roots",
    ));
  }
  Ok(roots)
}

fn load_bootstrap_policies(path: &Path) -> Result<Vec<VendorBootstrapPolicyEntry>, ReleaseBundleError> {
  if !path.is_file() {
    return Err(ReleaseBundleError::new(
      ReleaseBundleErrorCode::MissingPolicy,
      "plugins/default-activation-policies.json is missing",
    ));
  }
  let bytes = std::fs::read(path).map_err(|err| {
    ReleaseBundleError::new(
      ReleaseBundleErrorCode::InvalidBundle,
      format!("failed to read default-activation-policies.json: {err}"),
    )
  })?;
  let policies: Vec<VendorBootstrapPolicyEntry> = serde_json::from_slice(&bytes).map_err(|err| {
    ReleaseBundleError::new(
      ReleaseBundleErrorCode::InvalidBundle,
      format!("invalid default-activation-policies.json: {err}"),
    )
  })?;
  if policies.is_empty() {
    return Err(ReleaseBundleError::new(
      ReleaseBundleErrorCode::MissingPolicy,
      "default-activation-policies.json contains no exact default entries",
    ));
  }
  Ok(policies)
}

fn list_plugin_archives(plugins_dir: &Path) -> Result<Vec<PathBuf>, ReleaseBundleError> {
  if !plugins_dir.is_dir() {
    return Err(ReleaseBundleError::new(
      ReleaseBundleErrorCode::MissingPackage,
      "plugins directory is missing",
    ));
  }
  let mut archives = Vec::new();
  let entries = std::fs::read_dir(plugins_dir).map_err(|err| {
    ReleaseBundleError::new(
      ReleaseBundleErrorCode::InvalidBundle,
      format!("failed to read plugins directory: {err}"),
    )
  })?;
  for entry in entries.flatten() {
    let path = entry.path();
    if path.is_file() {
      if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
        if name.ends_with(PLUGIN_ARCHIVE_SUFFIX) {
          archives.push(path);
        }
      }
    }
  }
  archives.sort();
  Ok(archives)
}

fn reject_private_material(resource_dir: &Path) -> Result<(), ReleaseBundleError> {
  let mut stack = vec![resource_dir.to_path_buf()];
  while let Some(current) = stack.pop() {
    let entries = match std::fs::read_dir(&current) {
      Ok(entries) => entries,
      Err(_) => continue,
    };
    for entry in entries.flatten() {
      let path = entry.path();
      if path.is_dir() {
        stack.push(path);
        continue;
      }
      if looks_like_private_material(&path) {
        return Err(ReleaseBundleError::new(
          ReleaseBundleErrorCode::PrivateMaterial,
          "release bundle must not contain private keys or seeds",
        ));
      }
    }
  }
  Ok(())
}

fn looks_like_private_material(path: &Path) -> bool {
  let name = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("")
    .to_ascii_lowercase();
  name.contains("private")
    || name.contains("seed")
    || name.contains("signing-key")
    || name.ends_with(".pem")
    || name.ends_with(".p8")
    || name.ends_with(".p12")
    || name.ends_with(".secret")
}

fn map_package_error(err: PackageVerifyError) -> ReleaseBundleError {
  let code = match err.code {
    crate::domain::plugin_package::PackageErrorCode::SignatureInvalid
    | crate::domain::plugin_package::PackageErrorCode::MissingSignature => ReleaseBundleErrorCode::SignatureInvalid,
    crate::domain::plugin_package::PackageErrorCode::DigestMismatch => ReleaseBundleErrorCode::WrongDigest,
    _ => ReleaseBundleErrorCode::InvalidBundle,
  };
  ReleaseBundleError::new(code, err.message)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::first_party_plugins::{FIRST_PARTY_PLUGIN_IDS, is_first_party_plugin_id};
  use std::collections::HashSet;

  #[test]
  fn required_release_packages_match_canonical_first_party_ids() {
    let canonical: HashSet<&str> = FIRST_PARTY_PLUGIN_IDS.iter().copied().collect();
    let required: HashSet<&str> = REQUIRED_OFFICIAL_RELEASE_PACKAGES
      .iter()
      .map(|spec| spec.plugin_id)
      .collect();
    assert_eq!(canonical, required);
    for spec in REQUIRED_OFFICIAL_RELEASE_PACKAGES {
      assert!(is_first_party_plugin_id(spec.plugin_id));
    }
  }
}
