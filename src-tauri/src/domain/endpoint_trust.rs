// ABOUTME: Exact-origin endpoint approval types, fingerprints, and shared egress classification.
// ABOUTME: Trust metadata never contains credentials, speech text, DNS answers, or provider data.
use crate::domain::runtime_plugin::NetworkOriginKind;
use crate::domain::service_integration::{EDGE_TTS_DEFAULT_BASE_URL, EDGE_TTS_PLUGIN_ID};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Fixed endpoint alias authorized by the bundled Edge TTS definition.
pub const EDGE_TTS_TRUST_ENDPOINT_ALIAS: &str = "tts-api";
/// Fixed method shown in the endpoint acknowledgement dialog.
pub const ENDPOINT_TRUST_METHOD: &str = "POST";
/// Fixed relative path shown in the endpoint acknowledgement dialog.
pub const ENDPOINT_TRUST_RELATIVE_PATH: &str = "v1/audio/speech";
/// Lifetime of an opaque endpoint review preview.
pub const ENDPOINT_TRUST_PREVIEW_TTL_SECS: u64 = 5 * 60;
/// Maximum opaque preview id length accepted by the host.
pub const ENDPOINT_TRUST_PREVIEW_ID_MAX_LEN: usize = 128;
/// Internal broker marker converted to the stable endpoint-trust capability code.
pub const ENDPOINT_TRUST_REQUIRED_MARKER: &str = "endpoint_trust_required";

/// Frontend input for a host-owned endpoint review preview.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointTrustPreviewInput {
  pub plugin_id: String,
  #[serde(default)]
  pub instance_id: Option<Uuid>,
  pub config_json: String,
  #[serde(default)]
  pub expected_updated_at: Option<String>,
}

/// Sanitized endpoint review preview. Fingerprints and session internals stay host-owned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointTrustPreviewDto {
  pub preview_id: String,
  pub instance_id: Option<Uuid>,
  pub plugin_id: String,
  pub endpoint_alias: String,
  pub origin: String,
  pub method: String,
  pub relative_path: String,
  pub expires_at: String,
}

/// Persisted exact-base-URL approval binding. No credential or request payload is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationEndpointTrust {
  pub id: Uuid,
  pub integration_instance_id: Uuid,
  pub plugin_id: String,
  pub plugin_version: String,
  pub endpoint_alias: String,
  /// Complete canonical Edge TTS base URL, including any path prefix.
  pub normalized_origin: String,
  pub configuration_fingerprint: String,
  pub runtime_identity_fingerprint: String,
  pub approved_at: String,
}

/// Sanitized endpoint trust status returned alongside an integration instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointTrustStatus {
  Official,
  TrustedCustom,
  ReviewRequired,
  NotApplicable,
}

impl Default for EndpointTrustStatus {
  fn default() -> Self {
    Self::NotApplicable
  }
}

impl EndpointTrustStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Official => "official",
      Self::TrustedCustom => "trusted_custom",
      Self::ReviewRequired => "review_required",
      Self::NotApplicable => "not_applicable",
    }
  }
}

/// Transport policy selected only after host-owned endpoint and approval checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointEgressPolicy {
  TrustedFixed,
  PublicInternet,
  UserApprovedCustom,
  ReviewRequired,
}

/// Host-owned runtime identity fields bound to an endpoint approval.
#[derive(Debug, Clone, Copy)]
pub struct RuntimeIdentityFingerprintInput<'a> {
  pub plugin_id: &'a str,
  pub plugin_version: &'a str,
  pub runtime_kind: &'a str,
  pub package_digest: Option<&'a str>,
}

/// Compute a canonical non-secret fingerprint for an already normalized config JSON string.
pub fn configuration_fingerprint(config_json: &str) -> Result<String, String> {
  let value: serde_json::Value =
    serde_json::from_str(config_json).map_err(|_| "endpoint configuration must be valid JSON".to_string())?;
  let canonical =
    serde_json::to_string(&value).map_err(|_| "endpoint configuration cannot be serialized".to_string())?;
  Ok(hash_fields(["endpoint-config-v1", canonical.as_str()]))
}

/// Compute the exact runtime identity binding used by endpoint approvals.
pub fn runtime_identity_fingerprint(input: RuntimeIdentityFingerprintInput<'_>) -> String {
  hash_fields([
    "endpoint-runtime-v1",
    input.plugin_id,
    input.plugin_version,
    input.runtime_kind,
    input.package_digest.unwrap_or(""),
  ])
}

/// Classify a broker destination from host-owned identity, sealed provenance, and current approval.
/// For instance-configured Edge TTS, `normalized_origin` is the complete canonical base URL,
/// including any path prefix, not merely its tuple origin.
pub fn classify_endpoint_egress(
  plugin_id: &str,
  endpoint_alias: &str,
  normalized_origin: &str,
  origin_kind: Option<NetworkOriginKind>,
  current_approval: bool,
) -> EndpointEgressPolicy {
  let is_edge_tts = plugin_id == EDGE_TTS_PLUGIN_ID && endpoint_alias == EDGE_TTS_TRUST_ENDPOINT_ALIAS;
  if is_edge_tts && normalized_origin == EDGE_TTS_DEFAULT_BASE_URL {
    return EndpointEgressPolicy::TrustedFixed;
  }

  let is_google_web_gtx = plugin_id == crate::domain::service_integration::GOOGLE_TRANSLATE_WEB_PLUGIN_ID
    && endpoint_alias == "gtx"
    && normalized_origin == crate::domain::service_integration::GOOGLE_TRANSLATE_WEB_GTX_ORIGIN;
  if is_google_web_gtx && origin_kind == Some(NetworkOriginKind::HostFixed) {
    return EndpointEgressPolicy::TrustedFixed;
  }

  let is_google_cloud_fixed = plugin_id == crate::domain::service_integration::GOOGLE_CLOUD_PLUGIN_ID
    && matches!(
      (endpoint_alias, normalized_origin),
      ("translate", "https://translation.googleapis.com")
        | ("vision", "https://vision.googleapis.com")
        | ("text-to-speech", "https://texttospeech.googleapis.com")
        | ("text_to_speech", "https://texttospeech.googleapis.com")
    );
  if is_google_cloud_fixed && origin_kind == Some(NetworkOriginKind::HostFixed) {
    return EndpointEgressPolicy::TrustedFixed;
  }

  if is_edge_tts {
    if current_approval && (origin_kind.is_none() || origin_kind == Some(NetworkOriginKind::UserApprovedInstance)) {
      return EndpointEgressPolicy::UserApprovedCustom;
    }
    return EndpointEgressPolicy::ReviewRequired;
  }

  if origin_kind == Some(NetworkOriginKind::InstanceConfigured) {
    return EndpointEgressPolicy::PublicInternet;
  }

  EndpointEgressPolicy::ReviewRequired
}

fn hash_fields<const N: usize>(fields: [&str; N]) -> String {
  let mut hasher = Sha256::new();
  for (index, field) in fields.iter().enumerate() {
    if index > 0 {
      hasher.update([0x1f]);
    }
    hasher.update(field.as_bytes());
  }
  hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn configuration_fingerprint_is_key_order_stable() {
    let first = configuration_fingerprint(r#"{"base-url":"https://a.example","enabled":true}"#).unwrap();
    let second = configuration_fingerprint(r#"{"enabled":true,"base-url":"https://a.example"}"#).unwrap();
    assert_eq!(first, second);
    assert_ne!(
      first,
      configuration_fingerprint(r#"{"base-url":"https://b.example","enabled":true}"#).unwrap()
    );
  }

  #[test]
  fn classifier_requires_exact_custom_approval() {
    assert_eq!(
      classify_endpoint_egress(
        EDGE_TTS_PLUGIN_ID,
        EDGE_TTS_TRUST_ENDPOINT_ALIAS,
        EDGE_TTS_DEFAULT_BASE_URL,
        None,
        false,
      ),
      EndpointEgressPolicy::TrustedFixed
    );
    assert_eq!(
      classify_endpoint_egress(
        EDGE_TTS_PLUGIN_ID,
        EDGE_TTS_TRUST_ENDPOINT_ALIAS,
        "https://custom.example",
        None,
        false,
      ),
      EndpointEgressPolicy::ReviewRequired
    );
    assert_eq!(
      classify_endpoint_egress(
        EDGE_TTS_PLUGIN_ID,
        EDGE_TTS_TRUST_ENDPOINT_ALIAS,
        "https://custom.example",
        Some(NetworkOriginKind::UserApprovedInstance),
        true,
      ),
      EndpointEgressPolicy::UserApprovedCustom
    );
    assert_eq!(
      classify_endpoint_egress(
        EDGE_TTS_PLUGIN_ID,
        EDGE_TTS_TRUST_ENDPOINT_ALIAS,
        "https://tts.wangwangit.com/api",
        None,
        false,
      ),
      EndpointEgressPolicy::ReviewRequired
    );
    assert_eq!(
      classify_endpoint_egress(
        EDGE_TTS_PLUGIN_ID,
        EDGE_TTS_TRUST_ENDPOINT_ALIAS,
        "https://tts.wangwangit.com/api",
        Some(NetworkOriginKind::UserApprovedInstance),
        true,
      ),
      EndpointEgressPolicy::UserApprovedCustom
    );
  }
}
