// ABOUTME: Fail-closed loader for first-party vendor publisher public keys only.
// ABOUTME: Never embeds fabricated/test private-key-derived roots; release supplies real offline public keys.
use crate::domain::plugin_package::{ED25519_PUBLIC_KEY_HEX_LEN, ED25519_PUBLIC_KEY_LEN, decode_lowercase_hex};
use crate::domain::runtime_plugin::{PUBLISHER_KEY_ID_MAX_LEN, PublisherKeyId, validate_reverse_domain_strict};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Canonical first-party vendor key id used by release packaging (public material only).
pub const VENDOR_PUBLISHER_KEY_ID: &str = "com.langnext.vendor.keys.1";

/// Environment variable pointing at a JSON file of vendor public keys (release/CI override).
pub const VENDOR_TRUST_JSON_ENV: &str = "LANGNEXT_VENDOR_TRUST_JSON";

/// Bundled resource path relative to the app resource root / cargo manifest resources.
pub const VENDOR_TRUST_RELATIVE_PATH: &str = "vendor-trust/public-keys.json";

/// One vendor public key root (never private key material).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorPublicKey {
  pub key_id: String,
  pub public_key_hex: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VendorPublicKeyFileEntry {
  key_id: String,
  public_key_hex: String,
}

/// Compile-time bundled vendor trust JSON. Ships empty so production never auto-trusts a test key.
///
/// Release process: replace `src-tauri/resources/vendor-trust/public-keys.json` with real public
/// keys corresponding to offline-held vendor private keys before packaging. Private keys must
/// never enter this repository, app resources, or CI artifacts.
const BUNDLED_VENDOR_TRUST_JSON: &str = include_str!("../../resources/vendor-trust/public-keys.json");

/// Load production vendor public keys from (in order):
/// 1. `LANGNEXT_VENDOR_TRUST_JSON` env path when set
/// 2. optional filesystem search paths (app resource dir, cargo resources)
/// 3. compile-time bundled JSON (empty by default)
///
/// Invalid files fail closed (error). Empty valid files yield no trusted vendor roots.
pub fn load_production_vendor_public_keys(search_roots: &[PathBuf]) -> Result<Vec<VendorPublicKey>, String> {
  if let Ok(path) = std::env::var(VENDOR_TRUST_JSON_ENV) {
    let path = PathBuf::from(path);
    return load_vendor_public_keys_file(&path);
  }

  for root in search_roots {
    let candidate = root.join(VENDOR_TRUST_RELATIVE_PATH);
    if candidate.is_file() {
      return load_vendor_public_keys_file(&candidate);
    }
  }

  parse_vendor_public_keys_json(BUNDLED_VENDOR_TRUST_JSON, "bundled vendor-trust/public-keys.json")
}

/// Parse a vendor trust JSON file. Missing file is an error when called directly.
pub fn load_vendor_public_keys_file(path: &Path) -> Result<Vec<VendorPublicKey>, String> {
  let text = std::fs::read_to_string(path)
    .map_err(|err| format!("failed to read vendor trust file {}: {err}", path.display()))?;
  parse_vendor_public_keys_json(&text, &path.display().to_string())
}

/// Parse vendor public key JSON: `[{ "keyId": "...", "publicKeyHex": "..." }, ...]`.
pub fn parse_vendor_public_keys_json(text: &str, source: &str) -> Result<Vec<VendorPublicKey>, String> {
  let entries: Vec<VendorPublicKeyFileEntry> =
    serde_json::from_str(text.trim()).map_err(|err| format!("invalid vendor trust JSON ({source}): {err}"))?;
  let mut out = Vec::with_capacity(entries.len());
  let mut seen_ids = std::collections::HashSet::new();
  for entry in entries {
    let key = validate_vendor_public_key_entry(&entry.key_id, &entry.public_key_hex)?;
    if !seen_ids.insert(key.key_id.clone()) {
      return Err(format!("duplicate vendor key id {} in {source}", key.key_id));
    }
    out.push(key);
  }
  Ok(out)
}

fn validate_vendor_public_key_entry(key_id: &str, public_key_hex: &str) -> Result<VendorPublicKey, String> {
  validate_reverse_domain_strict(key_id, PUBLISHER_KEY_ID_MAX_LEN, "vendor key id")?;
  let _ = PublisherKeyId::parse(key_id)?;
  let hex = public_key_hex.trim();
  if hex.len() != ED25519_PUBLIC_KEY_HEX_LEN {
    return Err(format!(
      "vendor public key for {key_id} must be {ED25519_PUBLIC_KEY_HEX_LEN} lowercase hex chars"
    ));
  }
  let _ = decode_lowercase_hex::<ED25519_PUBLIC_KEY_LEN>(hex, "vendor public key")?;
  Ok(VendorPublicKey {
    key_id: key_id.to_string(),
    public_key_hex: hex.to_string(),
  })
}

/// Cargo-manifest resources directory used as a development search root.
pub fn cargo_resources_root() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
}

#[cfg(test)]
pub mod test_vendor_fixture {
  //! Test-only vendor fixture material. Not a production trust root.
  use super::*;
  use crate::domain::plugin_package::{encode_lowercase_hex, sha256_hex};
  use ed25519_dalek::SigningKey;

  /// Fixture seed used only under tests/fixtures. Distinct from the unit-test user key `[0x09;32]`.
  /// Must never be seeded into production trust roots.
  pub const FIXTURE_VENDOR_SEED: [u8; 32] = [0x0a; 32];

  pub fn fixture_vendor_signing_key() -> SigningKey {
    SigningKey::from_bytes(&FIXTURE_VENDOR_SEED)
  }

  pub fn fixture_vendor_public_key_hex() -> String {
    encode_lowercase_hex(&fixture_vendor_signing_key().verifying_key().to_bytes())
  }

  pub fn fixture_vendor_fingerprint() -> String {
    sha256_hex(&fixture_vendor_signing_key().verifying_key().to_bytes())
  }

  pub fn fixture_vendor_public_key() -> VendorPublicKey {
    VendorPublicKey {
      key_id: VENDOR_PUBLISHER_KEY_ID.to_string(),
      public_key_hex: fixture_vendor_public_key_hex(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bundled_vendor_trust_is_empty_by_default() {
    let keys = parse_vendor_public_keys_json(BUNDLED_VENDOR_TRUST_JSON, "bundled").unwrap();
    assert!(
      keys.is_empty(),
      "production bundle must not ship fabricated vendor roots; got {keys:?}"
    );
  }

  #[test]
  fn rejects_invalid_hex_and_duplicate_ids() {
    let err = parse_vendor_public_keys_json(r#"[{"keyId":"com.langnext.vendor.keys.1","publicKeyHex":"zz"}]"#, "t")
      .unwrap_err();
    assert!(
      err.contains("public key") || err.contains("hex") || err.contains("invalid"),
      "{err}"
    );

    let good = test_vendor_fixture::fixture_vendor_public_key_hex();
    let dup = format!(
      r#"[{{"keyId":"com.langnext.vendor.keys.1","publicKeyHex":"{good}"}},{{"keyId":"com.langnext.vendor.keys.1","publicKeyHex":"{good}"}}]"#
    );
    let err = parse_vendor_public_keys_json(&dup, "t").unwrap_err();
    assert!(err.contains("duplicate"), "{err}");
  }

  #[test]
  fn fixture_vendor_key_is_not_in_bundled_production_json() {
    let fixture = test_vendor_fixture::fixture_vendor_public_key_hex();
    assert!(
      !BUNDLED_VENDOR_TRUST_JSON.contains(&fixture),
      "fixture vendor public key must not appear in production bundled trust JSON"
    );
  }
}
