// ABOUTME: Canonical subject authority resolution shared by preview and grant construction.
// ABOUTME: Digests and ceiling checks bind origin, method, auth, response modes, and limits.
use crate::domain::default_package_activation::DefaultAuthorityNetworkEntryDto;
use crate::domain::plugin_package::sha256_hex;
use crate::domain::plugin_resource::NetworkResponseBodyModes;
use crate::domain::runtime_plugin::{
  HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID, HttpMethod, PROVIDER_RUNTIME_ENDPOINT_ID, PluginManifestV1,
  RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES, RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES,
  RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES, RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS, ResourceLimits,
};
use crate::error::StorageError;
use crate::services::default_package_activation::{
  ApprovedAuthorityConstraints, ApprovedFixedNetworkConstraint, ApprovedResourceLimits,
};
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

/// Origin kind for host-fixed package defaults reviewed at authorize-default time.
pub const HOST_FIXED_ORIGIN_KIND: &str = "host_fixed";

/// Project fixed-network default policy ceilings into preview DTOs through the shared
/// canonical authority shape (origin, base URL, method, auth, response modes, limits).
pub fn policy_fixed_network_to_preview_entries(
  constraints: &ApprovedAuthorityConstraints,
) -> Vec<DefaultAuthorityNetworkEntryDto> {
  let default_auth = constraints
    .auth_policies
    .first()
    .cloned()
    .unwrap_or_else(|| "host.none.v1".into());
  let mut network = Vec::new();
  for entry in &constraints.fixed_network {
    for capability_id in &entry.capability_ids {
      network.push(CanonicalNetworkAuthority {
        capability_id: capability_id.clone(),
        endpoint_id: entry.endpoint_id.clone(),
        origin: entry.origin.clone(),
        // Fixed-host defaults use the reviewed origin as the normalized base URL.
        base_url: entry.origin.clone(),
        method: entry.method.clone(),
        auth_policy: default_auth.clone(),
        origin_kind: HOST_FIXED_ORIGIN_KIND.into(),
        response_body_modes: NetworkResponseBodyModes::ALL.as_canonical(),
        max_request_bytes: entry.resource_limits.max_request_bytes,
        max_response_bytes: entry.resource_limits.max_response_bytes,
        max_stream_bytes: entry.resource_limits.max_stream_bytes,
        timeout_ms: entry.resource_limits.timeout_ms,
      });
    }
  }
  CanonicalSubjectAuthority {
    network,
    auth_policies: constraints.auth_policies.clone(),
  }
  .to_preview_entries()
}

impl CanonicalSubjectAuthority {
  pub fn digest(&self) -> Result<String, StorageError> {
    let json =
      serde_json::to_string(self).map_err(|e| StorageError::Internal(format!("serialize canonical authority: {e}")))?;
    Ok(sha256_hex(json.as_bytes()))
  }

  pub fn to_preview_entries(&self) -> Vec<DefaultAuthorityNetworkEntryDto> {
    self
      .network
      .iter()
      .map(|entry| DefaultAuthorityNetworkEntryDto {
        capability_id: entry.capability_id.clone(),
        endpoint_id: entry.endpoint_id.clone(),
        origin: entry.origin.clone(),
        base_url: entry.base_url.clone(),
        method: entry.method.clone(),
        auth_policy: entry.auth_policy.clone(),
        origin_kind: entry.origin_kind.clone(),
        response_body_modes: entry.response_body_modes.clone(),
        resource_limits: Some(
          crate::domain::default_package_activation::DefaultAuthorityResourceLimitsDto {
            max_request_bytes: entry.max_request_bytes,
            max_response_bytes: entry.max_response_bytes,
            max_stream_bytes: entry.max_stream_bytes,
            timeout_ms: entry.timeout_ms,
          },
        ),
      })
      .collect()
  }

  pub fn summary_resource_limits(&self) -> Option<ApprovedResourceLimits> {
    let first = self.network.first()?;
    let mut summary = ApprovedResourceLimits {
      max_request_bytes: first.max_request_bytes,
      max_response_bytes: first.max_response_bytes,
      max_stream_bytes: first.max_stream_bytes,
      timeout_ms: first.timeout_ms,
    };
    for entry in self.network.iter().skip(1) {
      summary.max_request_bytes = summary.max_request_bytes.max(entry.max_request_bytes);
      summary.max_response_bytes = summary.max_response_bytes.max(entry.max_response_bytes);
      summary.max_stream_bytes = summary.max_stream_bytes.max(entry.max_stream_bytes);
      summary.timeout_ms = summary.timeout_ms.max(entry.timeout_ms);
    }
    Some(summary)
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

fn limits_within(actual: &ApprovedResourceLimits, ceiling: &ApprovedResourceLimits) -> bool {
  actual.max_request_bytes <= ceiling.max_request_bytes
    && actual.max_response_bytes <= ceiling.max_response_bytes
    && actual.max_stream_bytes <= ceiling.max_stream_bytes
    && actual.timeout_ms <= ceiling.timeout_ms
}

fn entry_limits(entry: &CanonicalNetworkAuthority) -> ApprovedResourceLimits {
  ApprovedResourceLimits {
    max_request_bytes: entry.max_request_bytes,
    max_response_bytes: entry.max_response_bytes,
    max_stream_bytes: entry.max_stream_bytes,
    timeout_ms: entry.timeout_ms,
  }
}

fn entry_covered_by_fixed(entry: &CanonicalNetworkAuthority, ceiling: &ApprovedFixedNetworkConstraint) -> bool {
  ceiling.endpoint_id == entry.endpoint_id
    && ceiling.origin == entry.origin
    && ceiling.method == entry.method
    && ceiling.capability_ids.iter().any(|id| id == &entry.capability_id)
    && limits_within(&entry_limits(entry), &ceiling.resource_limits)
}

/// True when every effective authority entry is covered by the policy ceiling or exact approval.
pub fn authority_covered_by_policy_or_approval(
  effective: &CanonicalSubjectAuthority,
  policy: &ApprovedAuthorityConstraints,
  approval: Option<&CanonicalSubjectAuthority>,
) -> bool {
  for auth in &effective.auth_policies {
    let in_policy = policy.auth_policies.iter().any(|p| p == auth);
    let in_approval = approval.is_some_and(|a| a.auth_policies.iter().any(|p| p == auth));
    if !in_policy && !in_approval {
      return false;
    }
  }
  for entry in &effective.network {
    let covered_by_policy = policy
      .fixed_network
      .iter()
      .any(|ceiling| entry_covered_by_fixed(entry, ceiling));
    if covered_by_policy {
      continue;
    }
    let covered_by_approval = approval.is_some_and(|approved| {
      approved.network.iter().any(|approved_entry| {
        approved_entry.capability_id == entry.capability_id
          && approved_entry.endpoint_id == entry.endpoint_id
          && approved_entry.origin == entry.origin
          && approved_entry.base_url == entry.base_url
          && approved_entry.method == entry.method
          && approved_entry.auth_policy == entry.auth_policy
          && approved_entry.response_body_modes == entry.response_body_modes
          && limits_within(&entry_limits(entry), &entry_limits(approved_entry))
      })
    });
    if !covered_by_approval {
      return false;
    }
  }
  true
}

/// Authority beyond the policy ceiling that requires instance confirmation.
///
/// Includes network entries not covered by fixed policy ceilings, and auth policies not present
/// in the default policy (auth-only expansion is still confirmation-required).
pub fn additional_authority_beyond_policy(
  effective: &CanonicalSubjectAuthority,
  policy: &ApprovedAuthorityConstraints,
) -> CanonicalSubjectAuthority {
  let network = effective
    .network
    .iter()
    .filter(|entry| {
      !policy
        .fixed_network
        .iter()
        .any(|ceiling| entry_covered_by_fixed(entry, ceiling))
    })
    .cloned()
    .collect::<Vec<_>>();
  let mut auth_policies: Vec<String> = effective
    .auth_policies
    .iter()
    .filter(|auth| !policy.auth_policies.iter().any(|p| p == *auth))
    .cloned()
    .collect();
  // When network expands, surface the full effective auth set for the reviewed revision.
  if !network.is_empty() {
    auth_policies = effective.auth_policies.clone();
  }
  auth_policies.sort();
  auth_policies.dedup();
  CanonicalSubjectAuthority { network, auth_policies }
}

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

/// Resolve integration effective authority from normalized config and verified manifest.
///
/// Uses the same origin/base-URL normalization and capability/endpoint mapping as grant builders.
pub fn resolve_integration_effective_authority(
  packages: &crate::services::plugin_store::PluginPackageService,
  package_digest: &str,
  manifest: &PluginManifestV1,
  config_json: &str,
) -> Result<CanonicalSubjectAuthority, StorageError> {
  use crate::services::runtime_lifecycle::load_and_validate_schema_file;

  let config_value: serde_json::Value = serde_json::from_str(config_json)
    .map_err(|e| StorageError::Validation(format!("config is not valid JSON: {e}")))?;
  let auth_policies = if manifest.permissions.auth_policies.is_empty() {
    vec!["host.none.v1".to_string()]
  } else {
    let mut policies = manifest.permissions.auth_policies.clone();
    policies.sort();
    policies.dedup();
    policies
  };
  let needs_schema = manifest
    .permissions
    .network
    .iter()
    .any(|endpoint| endpoint.instance_origin_config_field.is_some());
  let config_schema = if needs_schema {
    let schema_path = manifest.configuration_schema.as_deref().ok_or_else(|| {
      StorageError::Validation("instance-configured network origin requires a configuration schema".into())
    })?;
    Some(load_and_validate_schema_file(
      packages,
      package_digest,
      schema_path,
      manifest,
    )?)
  } else {
    None
  };

  let mut network = Vec::new();
  for cap in &manifest.capabilities {
    let limits = effective_resource_limits_for_capability(&cap.id);
    let response_modes = if cap.id == "speech.synthesize@1" {
      NetworkResponseBodyModes::JSON_AND_BYTES
    } else {
      NetworkResponseBodyModes::JSON_ONLY
    };
    for endpoint in &manifest.permissions.network {
      if !crate::services::runtime_lifecycle::google_cloud_capability_uses_endpoint(&manifest.id, &cap.id, &endpoint.id)
      {
        continue;
      }
      let effective_origins: Vec<(String, String)> = if let Some(field) = &endpoint.instance_origin_config_field {
        let schema_field = config_schema
          .as_ref()
          .and_then(|schema| schema.fields.iter().find(|candidate| candidate.id == *field))
          .ok_or_else(|| {
            StorageError::Validation(format!(
              "network endpoint {} references unknown config field {field}",
              endpoint.id
            ))
          })?;
        if schema_field
          .visible_when
          .as_ref()
          .is_some_and(|condition| config_value.get(&condition.field) != Some(&condition.equals))
        {
          continue;
        }
        let raw = config_value
          .get(field)
          .and_then(serde_json::Value::as_str)
          .unwrap_or("");
        if raw.trim().is_empty() {
          return Err(StorageError::Validation(format!(
            "network endpoint {} requires config field {field}",
            endpoint.id
          )));
        }
        let (origin, base_url) = if field == "base-url" {
          let normalized =
            crate::services::edge_tts::normalize_edge_tts_base_url(raw).map_err(StorageError::Validation)?;
          let origin = url::Url::parse(&normalized.canonical_url)
            .map_err(|e| StorageError::Validation(format!("invalid edge tts base URL: {e}")))?
            .origin()
            .ascii_serialization();
          (origin, normalized.canonical_url)
        } else {
          let normalized =
            crate::services::google_translate_web::normalize_proxy_url(raw).map_err(StorageError::Validation)?;
          (normalized.origin.clone(), normalized.origin)
        };
        vec![(origin, base_url)]
      } else {
        endpoint
          .origins
          .iter()
          .cloned()
          .map(|origin| (origin.clone(), origin))
          .collect()
      };
      for (origin, base_url) in effective_origins {
        for method in &endpoint.methods {
          for policy in &auth_policies {
            network.push(CanonicalNetworkAuthority {
              capability_id: cap.id.clone(),
              endpoint_id: endpoint.id.clone(),
              origin: origin.clone(),
              base_url: base_url.clone(),
              method: http_method_token(method),
              auth_policy: policy.clone(),
              origin_kind: if endpoint.instance_origin_config_field.is_some() {
                "instance_configured".into()
              } else {
                "host_fixed".into()
              },
              response_body_modes: response_modes.as_canonical(),
              max_request_bytes: limits.max_request_bytes(),
              max_response_bytes: limits.max_response_bytes(),
              max_stream_bytes: limits.max_stream_bytes(),
              timeout_ms: limits.timeout_ms(),
            });
          }
        }
      }
    }
  }
  network.sort_by(|a, b| {
    (
      a.capability_id.as_str(),
      a.endpoint_id.as_str(),
      a.origin.as_str(),
      a.method.as_str(),
      a.auth_policy.as_str(),
    )
      .cmp(&(
        b.capability_id.as_str(),
        b.endpoint_id.as_str(),
        b.origin.as_str(),
        b.method.as_str(),
        b.auth_policy.as_str(),
      ))
  });
  Ok(CanonicalSubjectAuthority { network, auth_policies })
}
