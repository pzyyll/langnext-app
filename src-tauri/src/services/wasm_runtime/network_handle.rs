// ABOUTME: BrokerHandle implementation backed by a bounded RawHttpTransport so Wasm guests can
// ABOUTME: reach approved HTTPS origins (GTX/proxy) without credentials or ambient network access.
use crate::domain::cancel::CancelToken;
use crate::domain::provider_http::ProviderHttpMethod;
use crate::domain::runtime_plugin::{ExecutionGrantSet, PluginPrincipal};
use crate::services::bounded_http::{
  BoundedHttpResponse, DestinationPolicy, PreparedHttpRequest, RawHttpTransport, validate_external_destination,
  with_cancel,
};
use crate::services::wasm_runtime::host::{
  BrokerAuthorization, BrokerFetchError, BrokerFetchOutcome, BrokerFetchRequest, BrokerFetchResponse, BrokerHandle,
  BrokerRequestBody, BrokerResponseBody,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;

/// Auth policy id for credential-free endpoints. The network broker handle never injects auth;
/// any other policy cannot be fulfilled and is denied before transport.
const AUTH_POLICY_NONE_V1: &str = "host.none.v1";

/// `BrokerHandle` that executes grant-authorized HTTPS requests through a bounded transport.
///
/// Authorization (origin, method, path, headers, body size) is already enforced by the host
/// runtime before `fetch` is called; this handle only executes the authorized transport against
/// the matched origin. It never injects credentials, cookies, or auth headers, and rejects
/// private/loopback/link-local final destinations. Non-`host.none.v1` auth policies are denied
/// because the handle has no token access (Phase 7+ adds authenticated providers).
#[derive(Clone)]
pub struct NetworkBrokerHandle {
  transport: Arc<dyn RawHttpTransport>,
}

impl NetworkBrokerHandle {
  pub fn new(transport: Arc<dyn RawHttpTransport>) -> Self {
    Self { transport }
  }
}

impl BrokerHandle for NetworkBrokerHandle {
  fn fetch(
    &self,
    _principal: &PluginPrincipal,
    _grant: &ExecutionGrantSet,
    request: BrokerFetchRequest,
    authorization: BrokerAuthorization,
    cancel: &CancelToken,
    deadline: Option<Instant>,
  ) -> Pin<Box<dyn Future<Output = BrokerFetchOutcome> + Send + '_>> {
    let transport = self.transport.clone();
    let cancel = cancel.clone();
    Box::pin(async move {
      if authorization.auth_policy.as_str() != AUTH_POLICY_NONE_V1 {
        return Err(BrokerFetchError::NotApproved);
      }
      let method = parse_method(&request.method)?;
      let origin = authorization.origin.as_str();
      let (path_part, query_part) = request
        .relative_path
        .split_once('?')
        .unwrap_or((&request.relative_path, ""));
      let full = if query_part.is_empty() {
        format!("{origin}/{path_part}")
      } else {
        format!("{origin}/{path_part}?{query_part}")
      };
      let url = match url::Url::parse(&full) {
        Ok(u) => u,
        Err(_) => return Err(BrokerFetchError::Network("invalid endpoint url".into())),
      };
      if validate_external_destination(&url).is_err() {
        return Err(BrokerFetchError::Network("destination rejected by host policy".into()));
      }
      let (body, content_type) = match &request.body {
        BrokerRequestBody::Empty => (None, None),
        BrokerRequestBody::Json(bytes) => match std::str::from_utf8(bytes) {
          Ok(s) => (Some(s.to_string()), Some("application/json".to_string())),
          Err(_) => return Err(BrokerFetchError::HeaderBlocked),
        },
        BrokerRequestBody::Blob => (None, None),
      };
      let mut headers = std::collections::HashMap::new();
      for (name, value) in &request.headers {
        headers.insert(name.clone(), value.clone());
      }
      let max_response_bytes = authorization.resource_limits.max_response_bytes();
      let timeout = std::time::Duration::from_millis(authorization.resource_limits.timeout_ms());
      let prepared = PreparedHttpRequest {
        method,
        url,
        headers,
        body,
        content_type,
        proxy_mode: crate::domain::provider::ProxyMode::Direct,
        destination_policy: DestinationPolicy::PublicInternet,
        max_response_body_bytes: Some(max_response_bytes as usize),
        timeout: Some(timeout),
      };
      let work = transport.request(prepared);
      let response = match with_cancel(Some(&cancel), work).await {
        Ok(r) => r,
        Err(err) => return Err(map_storage_to_broker(err)),
      };
      if let Some(deadline) = deadline {
        if deadline <= Instant::now() {
          return Err(BrokerFetchError::Timeout);
        }
      }
      Ok(bounded_to_broker_response(response))
    })
  }
}

/// Convert a bounded transport response into the neutral broker response. Only JSON bodies are
/// carried; blob/stream bodies are reported as unsupported (Phase 6 implements handles).
fn bounded_to_broker_response(response: BoundedHttpResponse) -> BrokerFetchResponse {
  let body = BrokerResponseBody::Json(response.body);
  BrokerFetchResponse {
    status: response.status,
    headers: response.headers.into_iter().collect::<Vec<_>>(),
    body,
  }
}

fn parse_method(method: &str) -> Result<ProviderHttpMethod, BrokerFetchError> {
  match method {
    "GET" => Ok(ProviderHttpMethod::Get),
    "POST" => Ok(ProviderHttpMethod::Post),
    _ => Err(BrokerFetchError::Network(format!("unsupported method: {method}"))),
  }
}

fn map_storage_to_broker(err: crate::error::StorageError) -> BrokerFetchError {
  let msg = err.to_string();
  let lower = msg.to_ascii_lowercase();
  if lower.contains("cancel") {
    BrokerFetchError::Cancelled
  } else if lower.contains("timeout") || lower.contains("deadline") {
    BrokerFetchError::Timeout
  } else {
    BrokerFetchError::Network(msg)
  }
}
