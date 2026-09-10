// ABOUTME: Canonical subject authority resolution shared by preview and grant construction.
// ABOUTME: Digests and ceiling checks bind origin, method, auth, response modes, and limits.

use crate::domain::plugin_package::sha256_hex;
use crate::domain::plugin_resource::NetworkResponseBodyModes;
use crate::domain::runtime_plugin::{
  HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID, HttpMethod, PROVIDER_RUNTIME_ENDPOINT_ID,
  RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES, RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES,
  RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES, RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS, ResourceLimits,
};
use crate::error::StorageError;
use serde::{Deserialize, Serialize};

/// Canonical one network authority entry used for preview digests and grant ceilings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalNetworkAuthority {
  pub capability_id: String,
  pub endpoint_id: String,
  pub origin: String,
  pub base_url: String,
  pub method: String,
  pub auth_policy: String,
  pub origin_kind: String,
  pub response_body_modes: String,
  pub max_request_bytes: u64,
  pub max_response_bytes: u64,
  pub max_stream_bytes: u64,
  pub timeout_ms: u64,
}

/// Canonical resolved authority for one subject at one config identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSubjectAuthority {
  pub network: Vec<CanonicalNetworkAuthority>,
  pub auth_policies: Vec<String>,
}

/// Project fixed-network default policy ceilings into preview DTOs through the shared
/// canonical authority shape (origin, base URL, method, auth, response modes, limits).

impl CanonicalSubjectAuthority {
  pub fn digest(&self) -> Result<String, StorageError> {
    let json =
      serde_json::to_string(self).map_err(|e| StorageError::Internal(format!("serialize canonical authority: {e}")))?;
    Ok(sha256_hex(json.as_bytes()))
  }
}

/// Effective limits for a capability major, matching runtime grant builders.
pub fn effective_resource_limits_for_capability(capability_id: &str) -> ResourceLimits {
  const SPEECH_SYNTHESIZE_TIMEOUT_MS: u64 = 60_000;
  if capability_id == "speech.synthesize@1" {
    return ResourceLimits::new(
      RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES,
      crate::domain::service_capability::SPEECH_PROVIDER_RESPONSE_MAX_BYTES as u64,
      RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES,
      SPEECH_SYNTHESIZE_TIMEOUT_MS,
    )
    .expect("speech synthesize resource limits are valid");
  }
  if capability_id == crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID {
    return ResourceLimits::new(
      crate::services::network_broker::BROKER_OCR_REQUEST_BODY_MAX_BYTES as u64,
      RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES,
      RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES,
      RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS,
    )
    .expect("ocr resource limits are valid");
  }
  ResourceLimits::default()
}

fn http_method_token(method: &HttpMethod) -> String {
  serde_json::to_string(method)
    .unwrap_or_else(|_| "\"?\"".into())
    .trim_matches('"')
    .to_string()
}

/// True when every effective authority entry is covered by the policy ceiling or exact approval.

/// Authority beyond the policy ceiling that requires instance confirmation.
///
/// Includes network entries not covered by fixed policy ceilings, and auth policies not present
/// in the default policy (auth-only expansion is still confirmation-required).

/// Resolve provider-instance effective authority from the persisted base URL and declaration.
pub fn resolve_provider_effective_authority(
  provider_base_url: &str,
  capability_ids: &[String],
) -> Result<CanonicalSubjectAuthority, StorageError> {
  let trimmed = provider_base_url.trim();
  if trimmed.is_empty() {
    return Err(StorageError::Validation("provider base URL is required".into()));
  }
  let parsed =
    url::Url::parse(trimmed).map_err(|e| StorageError::Validation(format!("invalid provider base URL: {e}")))?;
  if parsed.scheme() != "https" {
    return Err(StorageError::Validation("provider base URL must use https".into()));
  }
  let origin = parsed.origin().ascii_serialization();
  let base_url = trimmed.trim_end_matches('/').to_string();
  let methods = [HttpMethod::Get, HttpMethod::Post];
  let limits = ResourceLimits::default();
  let mut network = Vec::new();
  for capability_id in capability_ids {
    for method in &methods {
      network.push(CanonicalNetworkAuthority {
        capability_id: capability_id.clone(),
        endpoint_id: PROVIDER_RUNTIME_ENDPOINT_ID.into(),
        origin: origin.clone(),
        base_url: base_url.clone(),
        method: http_method_token(method),
        auth_policy: HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID.into(),
        origin_kind: "instance_configured".into(),
        response_body_modes: NetworkResponseBodyModes::ALL.as_canonical(),
        max_request_bytes: limits.max_request_bytes(),
        max_response_bytes: limits.max_response_bytes(),
        max_stream_bytes: limits.max_stream_bytes(),
        timeout_ms: limits.timeout_ms(),
      });
    }
  }
  network.sort_by(|a, b| {
    (
      a.capability_id.as_str(),
      a.endpoint_id.as_str(),
      a.origin.as_str(),
      a.method.as_str(),
    )
      .cmp(&(
        b.capability_id.as_str(),
        b.endpoint_id.as_str(),
        b.origin.as_str(),
        b.method.as_str(),
      ))
  });
  Ok(CanonicalSubjectAuthority {
    network,
    auth_policies: vec![HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID.into()],
  })
}
