// ABOUTME: Shared provider transport preparation for the provider-runtime broker.
// ABOUTME: Callers authorize; this path confines URLs, selects proxy, injects host credentials.
use crate::credentials::CredentialVault;
use crate::domain::provider::{AuthSchemeV1, ProviderInstance};
use crate::domain::provider_http::ProviderHttpMethod;
use crate::error::StorageError;
use crate::repositories::provider_instances;
use crate::services::bounded_http::{
  self, DestinationPolicy, PreparedHttpRequest, PreparedProviderRequest, RequestBody, build_endpoint,
  is_blocked_header, validate_caller_name, validate_relative_path, value_looks_like_secret_key,
};
use crate::storage::Database;
use std::collections::HashMap;
use std::time::Duration;
use uuid::Uuid;

/// Shared binary-safe provider transport preparation used by the provider-runtime broker.
/// The broker authorizes the exact package, provider, adapter, and grant first; this path
/// never re-derives authorization. It confines URLs, selects the persisted proxy, looks up
/// host credentials, and injects auth. Caller header/query name validation stays with the
/// broker wire contract. `max_response_body_bytes`/`timeout` are host-selected bounds from
/// broker resource limits.
pub(crate) fn prepare_provider_transport(
  db: &Database,
  vault: &dyn CredentialVault,
  provider_id: Uuid,
  method: ProviderHttpMethod,
  relative_path: &str,
  query: &[(String, String)],
  headers: &HashMap<String, String>,
  body: RequestBody,
  max_response_body_bytes: Option<usize>,
  timeout: Option<Duration>,
) -> Result<PreparedProviderRequest, StorageError> {
  let provider = db.read(|conn| provider_instances::get(conn, provider_id))?;
  if !provider.enabled {
    return Err(StorageError::Validation("provider is disabled".into()));
  }
  validate_relative_path(relative_path)?;
  for (name, _value) in query {
    validate_caller_name(name, "query")?;
    if value_looks_like_secret_key(name) {
      return Err(StorageError::Validation(format!(
        "caller query name '{name}' is restricted"
      )));
    }
    reject_if_auth_name(name, &provider.auth_scheme, "query")?;
  }
  for (name, _value) in headers {
    validate_caller_name(name, "header")?;
    if is_blocked_header(name) {
      return Err(StorageError::Validation(format!(
        "caller header '{name}' is restricted"
      )));
    }
    reject_if_auth_name(name, &provider.auth_scheme, "header")?;
  }
  let base_url = effective_base_url(&provider)?;
  reject_insecure_http_if_needed(&base_url, provider.insecure_http_confirmed_at.as_deref())?;
  let mut url = build_endpoint(&base_url, relative_path)?;
  bounded_http::append_query_pairs(&mut url, query)?;
  let secret = load_secret_for_scheme(vault, &provider)?;
  let mut headers = headers.clone();
  inject_auth(&mut url, &mut headers, &provider.auth_scheme, secret.as_deref())?;

  Ok(PreparedHttpRequest {
    method,
    url,
    headers,
    body,
    content_type: None,
    proxy_mode: provider.proxy_mode,
    destination_policy: DestinationPolicy::Configured,
    max_response_body_bytes,
    timeout,
  })
}

fn effective_base_url(provider: &ProviderInstance) -> Result<String, StorageError> {
  let url = provider.base_url.trim();
  if url.is_empty() {
    return Err(StorageError::Validation("base URL is required".into()));
  }
  // Transport always uses the persisted effective Base URL (custom or plugin_default).
  Ok(url.to_string())
}

fn reject_if_auth_name(name: &str, auth_scheme: &AuthSchemeV1, kind: &str) -> Result<(), StorageError> {
  let lower = name.to_ascii_lowercase();
  match auth_scheme {
    AuthSchemeV1::Header { name: auth_name, .. } if kind == "header" => {
      if lower == auth_name.to_ascii_lowercase() {
        return Err(StorageError::Validation(format!(
          "caller header '{name}' conflicts with configured auth scheme"
        )));
      }
    }
    AuthSchemeV1::Query { name: auth_name, .. } if kind == "query" => {
      if lower == auth_name.to_ascii_lowercase() {
        return Err(StorageError::Validation(format!(
          "caller query '{name}' conflicts with configured auth scheme"
        )));
      }
    }
    _ => {}
  }
  Ok(())
}

fn reject_insecure_http_if_needed(base_url: &str, confirmed_at: Option<&str>) -> Result<(), StorageError> {
  let url = url::Url::parse(base_url).map_err(|e| StorageError::Validation(format!("invalid base URL: {e}")))?;
  if url.scheme() == "https" {
    return Ok(());
  }
  if url.scheme() != "http" {
    return Err(StorageError::Validation(format!(
      "unsupported base URL scheme: {}",
      url.scheme()
    )));
  }
  let host = url.host_str().unwrap_or("");
  if is_loopback_host(host) {
    return Ok(());
  }
  if confirmed_at.is_none() {
    return Err(StorageError::Validation(
      "non-loopback HTTP requires insecure_http_confirmed_at".into(),
    ));
  }
  Ok(())
}

fn is_loopback_host(host: &str) -> bool {
  host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1" || host == "[::1]"
}

fn load_secret_for_scheme(
  vault: &dyn CredentialVault,
  provider: &ProviderInstance,
) -> Result<Option<String>, StorageError> {
  match &provider.auth_scheme {
    AuthSchemeV1::None { .. } => Ok(None),
    AuthSchemeV1::Bearer { .. } | AuthSchemeV1::Header { .. } | AuthSchemeV1::Query { .. } => {
      let Some(credential_ref) = provider.credential_ref.as_ref() else {
        return Err(StorageError::Validation(
          "credential is required for this auth scheme".into(),
        ));
      };
      match vault.get_for_backend_use(credential_ref) {
        Ok(secret) => {
          if secret.is_empty() {
            return Err(StorageError::Validation("stored credential is empty".into()));
          }
          Ok(Some(secret))
        }
        Err(StorageError::CredentialUnavailable) | Err(StorageError::CredentialAccess) => {
          Err(StorageError::CredentialUnavailable)
        }
        Err(other) => Err(other),
      }
    }
  }
}

fn inject_auth(
  url: &mut url::Url,
  headers: &mut HashMap<String, String>,
  auth_scheme: &AuthSchemeV1,
  secret: Option<&str>,
) -> Result<(), StorageError> {
  inject_auth_headers_only(headers, auth_scheme, secret)?;
  apply_query_auth(url, auth_scheme, secret)?;
  Ok(())
}

fn inject_auth_headers_only(
  headers: &mut HashMap<String, String>,
  auth_scheme: &AuthSchemeV1,
  secret: Option<&str>,
) -> Result<(), StorageError> {
  match auth_scheme {
    AuthSchemeV1::None { .. } => Ok(()),
    AuthSchemeV1::Bearer { .. } => {
      let secret = secret.ok_or_else(|| StorageError::Validation("credential is required".into()))?;
      headers.insert("Authorization".into(), format!("Bearer {secret}"));
      Ok(())
    }
    AuthSchemeV1::Header { name, .. } => {
      let secret = secret.ok_or_else(|| StorageError::Validation("credential is required".into()))?;
      headers.insert(name.clone(), secret.to_string());
      Ok(())
    }
    AuthSchemeV1::Query { .. } => Ok(()),
  }
}

fn apply_query_auth(url: &mut url::Url, auth_scheme: &AuthSchemeV1, secret: Option<&str>) -> Result<(), StorageError> {
  match auth_scheme {
    AuthSchemeV1::Query { name, .. } => {
      let secret = secret.ok_or_else(|| StorageError::Validation("credential is required".into()))?;
      url.query_pairs_mut().append_pair(name, secret);
      Ok(())
    }
    _ => Ok(()),
  }
}
