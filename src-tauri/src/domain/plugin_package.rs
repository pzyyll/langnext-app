// ABOUTME: Structural plugin content limits, error codes, and hex/digest helpers.
// ABOUTME: No publisher, signature, approval, or install-journal types exist.
use crate::domain::runtime_plugin::{MEBIBYTE_BYTES, PackageDigest, RuntimeKind};
use serde::{Deserialize, Serialize};

/// Upper bound on a complete `.lnplugin` archive.
///
/// Raised 2026-08-07 after measuring the Windows x64 PaddleOCR production inventory:
/// total runtime directory = 348_200_192 bytes (plus manifest/schema/license).
pub const PACKAGE_ARCHIVE_MAX_BYTES: u64 = 400 * MEBIBYTE_BYTES;
/// Maximum number of ZIP entries (including directories).
pub const PACKAGE_ENTRY_MAX_COUNT: usize = 1024;
/// Maximum decompressed size of a single archive entry.
///
/// Raised 2026-08-07: largest measured runtime entry is `paddle_inference.dll`
/// at 93_563_904 bytes on the Windows x64 CPU inventory.
pub const PACKAGE_ENTRY_MAX_BYTES: u64 = 100 * MEBIBYTE_BYTES;
/// Maximum total decompressed payload across all file entries.
///
/// Raised 2026-08-07 from the measured PaddleOCR runtime total of 348_200_192 bytes.
pub const PACKAGE_TOTAL_DECOMPRESSED_MAX_BYTES: u64 = 400 * MEBIBYTE_BYTES;
/// Maximum path depth (slash-separated segments) for archive entries.
pub const PACKAGE_PATH_MAX_DEPTH: usize = 16;
/// Maximum size of the exact `plugin.json` bytes.
pub const PACKAGE_MANIFEST_MAX_BYTES: u64 = 256 * 1024;
/// Maximum size of any schema file entry.
pub const PACKAGE_SCHEMA_MAX_BYTES: u64 = 256 * 1024;
/// Maximum size of any page/UI asset entry.
pub const PACKAGE_UI_ASSET_MAX_BYTES: u64 = 4 * MEBIBYTE_BYTES;
/// Reject archives whose total decompressed / compressed ratio exceeds this.
pub const PACKAGE_DECOMPRESSION_RATIO_MAX: u64 = 100;
/// Preview session lifetime before the opaque preview ID expires.
pub const PACKAGE_PREVIEW_TTL_SECS: u64 = 10 * 60;

/// Stable structural plugin content error codes.
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
  ManifestTooLarge,
  InvalidManifest,
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
      Self::ManifestTooLarge => "manifest_too_large",
      Self::InvalidManifest => "invalid_manifest",
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

/// Encode bytes as lowercase hex.
pub fn encode_lowercase_hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
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

/// Compute SHA-256 of bytes as lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
  use sha2::{Digest, Sha256};
  encode_lowercase_hex(&Sha256::digest(bytes))
}

/// Runtime kind as a stable kebab-case string for SQLite storage.
/// Package-only: legacy kinds are not representable.
pub fn runtime_kind_storage(kind: RuntimeKind) -> &'static str {
  match kind {
    RuntimeKind::WasmComponent => "wasm-component",
    RuntimeKind::TrustedNativeWorker => "trusted-native-worker",
  }
}

/// Validate a package content digest string.
pub fn validate_package_digest(value: &str) -> Result<PackageDigest, String> {
  PackageDigest::parse(value)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn hex_helpers_round_trip() {
    let bytes = [0u8, 15, 255];
    let encoded = encode_lowercase_hex(&bytes);
    assert_eq!(encoded, "000fff");
    assert_eq!(decode_lowercase_hex::<3>(&encoded, "bytes").unwrap(), bytes);
    assert!(decode_lowercase_hex::<2>(&encoded, "bytes").is_err());
  }

  #[test]
  fn structural_error_codes_have_stable_strings() {
    assert_eq!(PackageErrorCode::MissingManifest.as_str(), "missing_manifest");
    assert_eq!(PackageErrorCode::ZipBomb.as_str(), "zip_bomb");
    assert_eq!(PackageErrorCode::MissingIndexedFile.as_str(), "missing_indexed_file");
  }

  #[test]
  fn runtime_kind_storage_is_package_only() {
    assert_eq!(runtime_kind_storage(RuntimeKind::WasmComponent), "wasm-component");
    assert_eq!(
      runtime_kind_storage(RuntimeKind::TrustedNativeWorker),
      "trusted-native-worker"
    );
  }
}
