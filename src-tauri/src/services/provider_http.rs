// ABOUTME: Generic native provider HTTP transport with vault auth injection.
// ABOUTME: Accepts only relative paths; never parses provider JSON or returns secrets.
use crate::credentials::CredentialVault;
use crate::domain::cancel::CancelToken;
use crate::domain::provider::{AuthSchemeV1, ProviderInstance};
use crate::domain::provider_http::{
  ProviderHttpRequest, ProviderHttpResponse, ProviderHttpStreamEvent, ProviderWireRequest,
};
use crate::error::StorageError;
use crate::repositories::provider_instances;
use crate::services::bounded_http::{
  self, DestinationPolicy, PreparedHttpRequest, ReqwestRawHttpTransport, is_blocked_header, validate_caller_name,
  validate_relative_path, validate_request_id, value_looks_like_secret_key, with_cancel,
};
use crate::storage::Database;
use std::collections::HashMap;
use std::sync::Arc;

// Re-export shared transport types for existing call sites/tests.
pub use bounded_http::{PreparedProviderRequest, RawHttpTransport, build_endpoint};

#[derive(Clone)]
pub struct ProviderHttpService {
  db: Database,
  vault: Arc<dyn CredentialVault>,
  transport: Arc<dyn RawHttpTransport>,
}

impl ProviderHttpService {
  pub fn new(db: Database, vault: Arc<dyn CredentialVault>) -> Self {
    Self {
      db,
      vault,
      transport: Arc::new(ReqwestRawHttpTransport),
    }
  }

  pub fn with_transport(db: Database, vault: Arc<dyn CredentialVault>, transport: Arc<dyn RawHttpTransport>) -> Self {
    Self { db, vault, transport }
  }

  pub async fn request(
    &self,
    input: ProviderHttpRequest,
    cancel: Option<&CancelToken>,
  ) -> Result<ProviderHttpResponse, StorageError> {
    validate_request_id(&input.request_id)?;
    let prepared = self.prepare(input)?;
    let work = self.transport.request(prepared);
    with_cancel(cancel, work).await?.into_provider_http_response()
  }

  pub async fn stream(
    &self,
    input: ProviderHttpRequest,
    cancel: CancelToken,
    on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
  ) -> Result<(), StorageError> {
    validate_request_id(&input.request_id)?;
    let prepared = self.prepare(input)?;
    self.transport.stream(prepared, cancel, on_event).await
  }

  fn prepare(&self, input: ProviderHttpRequest) -> Result<PreparedProviderRequest, StorageError> {
    let provider = self
      .db
      .read(|conn| provider_instances::get(conn, input.provider_instance_id))?;
    if !provider.enabled {
      return Err(StorageError::Validation("provider is disabled".into()));
    }
    validate_wire(&input.wire, &provider.auth_scheme)?;
    let base_url = effective_base_url(&provider)?;
    reject_insecure_http_if_needed(&base_url, provider.insecure_http_confirmed_at.as_deref())?;
    let mut url = build_endpoint(&base_url, &input.wire.relative_path)?;
    bounded_http::append_query_pairs(&mut url, &input.wire.query)?;
    let secret = load_secret_for_scheme(self.vault.as_ref(), &provider)?;
    let mut headers = input.wire.headers.clone();
    inject_auth(&mut url, &mut headers, &provider.auth_scheme, secret.as_deref())?;

    Ok(PreparedHttpRequest {
      method: input.wire.method,
      url,
      headers,
      body: input.wire.body,
      content_type: None,
      proxy_mode: provider.proxy_mode,
      destination_policy: DestinationPolicy::Configured,
      max_response_body_bytes: None,
      timeout: None,
    })
  }
}

fn effective_base_url(provider: &ProviderInstance) -> Result<String, StorageError> {
  let url = provider.base_url.trim();
  if url.is_empty() {
    return Err(StorageError::Validation("base URL is required".into()));
  }
  // Transport always uses the persisted effective Base URL (custom or plugin_default).
  Ok(url.to_string())
}

fn validate_wire(wire: &ProviderWireRequest, auth_scheme: &AuthSchemeV1) -> Result<(), StorageError> {
  validate_relative_path(&wire.relative_path)?;
  for (name, value) in &wire.query {
    validate_caller_name(name, "query")?;
    if value_looks_like_secret_key(name) {
      return Err(StorageError::Validation(format!(
        "caller query name '{name}' is restricted"
      )));
    }
    reject_if_auth_name(name, auth_scheme, "query")?;
    let _ = value; // values may contain user text; secrets must not be sent by plugins
  }
  for (name, value) in &wire.headers {
    validate_caller_name(name, "header")?;
    if is_blocked_header(name) {
      return Err(StorageError::Validation(format!(
        "caller header '{name}' is restricted"
      )));
    }
    reject_if_auth_name(name, auth_scheme, "header")?;
    let _ = value;
  }
  Ok(())
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

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::provider::AuthSchemeV1;
  use crate::domain::provider_http::ProviderHttpMethod;
  use crate::services::bounded_http::validate_relative_path;

  #[test]
  fn provider_http_request_rejects_absolute_and_traversal_paths() {
    assert!(validate_relative_path("models").is_ok());
    assert!(validate_relative_path("/models").is_err());
    assert!(validate_relative_path("../secret").is_err());
    assert!(validate_relative_path("https://evil.example/models").is_err());
    assert!(validate_relative_path("models#frag").is_err());
  }

  #[test]
  fn provider_http_request_build_endpoint_preserves_prefix() {
    let url = build_endpoint("https://api.example.com/v1", "models").unwrap();
    assert_eq!(url.as_str(), "https://api.example.com/v1/models");
  }

  #[test]
  fn provider_http_request_blocks_sensitive_headers() {
    let auth = AuthSchemeV1::bearer();
    let mut wire = ProviderWireRequest {
      method: ProviderHttpMethod::Get,
      relative_path: "models".into(),
      query: vec![],
      headers: HashMap::from([("Authorization".into(), "Bearer x".into())]),
      body: None,
    };
    assert!(validate_wire(&wire, &auth).is_err());
    wire.headers.clear();
    wire.headers.insert("X-Custom".into(), "1".into());
    assert!(validate_wire(&wire, &auth).is_ok());
  }
}
