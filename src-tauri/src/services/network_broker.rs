// ABOUTME: Service-integration network broker resolving manifest endpoint aliases only.
// ABOUTME: Injects opaque token grants and enforces path/header/size/cancel policy before transport.
use crate::domain::cancel::CancelToken;
use crate::domain::provider::ProxyMode;
use crate::domain::provider_http::{ProviderHttpMethod, ProviderHttpResponse};
use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
use crate::domain::service_integration::{GoogleCloudConfigV1, ServiceIntegrationManifest};
use crate::error::StorageError;
use crate::repositories::integration_instances;
use crate::services::bounded_http::{
  MAX_RESPONSE_BODY_BYTES, PreparedHttpRequest, RawHttpTransport, ReqwestRawHttpTransport, append_query_pairs,
  build_endpoint, is_blocked_header, validate_caller_name, validate_relative_path, validate_request_id,
  value_looks_like_secret_key, with_cancel,
};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::token_grant::TokenGrant;
use crate::storage::Database;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

/// Default max response body for service-integration broker calls.
pub const BROKER_MAX_RESPONSE_BODY_BYTES: usize = MAX_RESPONSE_BODY_BYTES;
/// Max relative path length accepted by the broker.
pub const BROKER_RELATIVE_PATH_MAX_LEN: usize = 512;
/// Max request body size accepted by the broker.
pub const BROKER_REQUEST_BODY_MAX_BYTES: usize = 64 * 1024;
/// Max request body for Vision annotate: base64(8 MiB PNG) ≈ 4/3 expansion + JSON envelope.
/// Named from OCR_IMAGE_MAX_DECODED_BYTES so the broker contract matches the product gate.
pub const BROKER_OCR_REQUEST_BODY_MAX_BYTES: usize =
  (crate::domain::service_capability::OCR_IMAGE_MAX_DECODED_BYTES * 4 / 3) + (64 * 1024);

/// Capability-scoped network request using a manifest endpoint alias.
pub struct BrokerRequest {
  pub integration_instance_id: Uuid,
  pub capability_id: String,
  pub endpoint_alias: String,
  pub method: ProviderHttpMethod,
  pub relative_path: String,
  pub query: Vec<(String, String)>,
  pub headers: HashMap<String, String>,
  pub body: Option<String>,
  pub content_type: Option<String>,
  pub auth: Option<TokenGrant>,
  pub request_id: String,
  pub cancel: Option<CancelToken>,
  pub max_response_body_bytes: Option<usize>,
  /// Optional per-request body cap; defaults to [`BROKER_REQUEST_BODY_MAX_BYTES`].
  pub max_request_body_bytes: Option<usize>,
  /// Optional per-request total timeout override for the underlying HTTP call.
  pub timeout: Option<Duration>,
}

impl std::fmt::Debug for BrokerRequest {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("BrokerRequest")
      .field("integration_instance_id", &self.integration_instance_id)
      .field("capability_id", &self.capability_id)
      .field("endpoint_alias", &self.endpoint_alias)
      .field("method", &self.method)
      .field("relative_path_len", &self.relative_path.len())
      .field("query_len", &self.query.len())
      .field("header_names", &self.headers.keys().collect::<Vec<_>>())
      .field("body_len", &self.body.as_ref().map(|b| b.len()))
      .field("content_type", &self.content_type)
      .field("has_auth", &self.auth.is_some())
      .field("request_id", &self.request_id)
      .field("max_response_body_bytes", &self.max_response_body_bytes)
      .field("max_request_body_bytes", &self.max_request_body_bytes)
      .field("timeout", &self.timeout)
      .finish_non_exhaustive()
  }
}

#[derive(Clone)]
pub struct NetworkBroker {
  db: Database,
  registry: Arc<ServiceIntegrationRegistry>,
  transport: Arc<dyn RawHttpTransport>,
}

impl NetworkBroker {
  pub fn new(db: Database, registry: Arc<ServiceIntegrationRegistry>) -> Self {
    Self {
      db,
      registry,
      transport: Arc::new(ReqwestRawHttpTransport),
    }
  }

  pub fn with_transport(
    db: Database,
    registry: Arc<ServiceIntegrationRegistry>,
    transport: Arc<dyn RawHttpTransport>,
  ) -> Self {
    Self {
      db,
      registry,
      transport,
    }
  }

  pub async fn execute(&self, request: BrokerRequest) -> Result<ProviderHttpResponse, CapabilityError> {
    let prepared = self.prepare(request)?;
    let (cancel, work) = prepared;
    with_cancel(cancel.as_ref(), self.transport.request(work))
      .await
      .map_err(map_transport_error)
  }

  fn prepare(&self, request: BrokerRequest) -> Result<(Option<CancelToken>, PreparedHttpRequest), CapabilityError> {
    validate_request_id(&request.request_id).map_err(map_validation)?;
    if request.relative_path.len() > BROKER_RELATIVE_PATH_MAX_LEN {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        "relative path exceeds limit",
      ));
    }
    let max_request_body = request.max_request_body_bytes.unwrap_or(BROKER_REQUEST_BODY_MAX_BYTES);
    if let Some(body) = &request.body {
      if body.len() > max_request_body {
        return Err(CapabilityError::new(
          CapabilityErrorCode::UnsupportedInput,
          "request body exceeds limit",
        ));
      }
    }
    validate_relative_path(&request.relative_path).map_err(map_validation)?;

    let instance = self
      .db
      .read(|conn| integration_instances::get(conn, request.integration_instance_id))
      .map_err(map_storage)?;
    if !instance.enabled {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "integration instance is disabled",
      ));
    }

    let manifest = self
      .registry
      .get(&instance.plugin_id)
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::PluginUnavailable, "plugin definition is missing"))?;

    let capability = manifest
      .capabilities
      .iter()
      .find(|c| c.id == request.capability_id)
      .ok_or_else(|| {
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability is not declared on this plugin",
        )
      })?;

    if !capability.endpoint_aliases.iter().any(|a| a == &request.endpoint_alias) {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "capability is not allowed to use this endpoint alias",
      ));
    }

    let base_url = resolve_endpoint_alias(manifest, &request.endpoint_alias)?;
    // Official Google origins are pinned by the manifest; never accept caller origins.
    let mut url = build_endpoint(&base_url, &request.relative_path).map_err(map_validation)?;

    for (name, value) in &request.query {
      validate_caller_name(name, "query").map_err(map_validation)?;
      if value_looks_like_secret_key(name) {
        return Err(CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          format!("caller query name '{name}' is restricted"),
        ));
      }
      let _ = value;
    }
    append_query_pairs(&mut url, &request.query).map_err(map_validation)?;

    let mut headers = HashMap::new();
    for (name, value) in &request.headers {
      validate_caller_name(name, "header").map_err(map_validation)?;
      if is_blocked_header(name) || value_looks_like_secret_key(name) {
        return Err(CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          format!("caller header '{name}' is restricted"),
        ));
      }
      headers.insert(name.clone(), value.clone());
    }

    if let Some(grant) = &request.auth {
      if grant.instance_id() != request.integration_instance_id {
        return Err(CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "token grant instance mismatch",
        ));
      }
      grant.apply_bearer_auth(&mut headers);
    }

    let proxy_mode = resolve_proxy_mode(&instance.config_json);
    let max_body = request
      .max_response_body_bytes
      .unwrap_or(BROKER_MAX_RESPONSE_BODY_BYTES);

    log::debug!(
      "network_broker origin={} method={:?} path_len={} header_names={:?} body_len={} request_id={} capability={} instance={}",
      url.origin().ascii_serialization(),
      request.method,
      request.relative_path.len(),
      headers.keys().collect::<Vec<_>>(),
      request.body.as_ref().map(|b| b.len()).unwrap_or(0),
      request.request_id,
      request.capability_id,
      request.integration_instance_id
    );

    Ok((
      request.cancel,
      PreparedHttpRequest {
        method: request.method,
        url,
        headers,
        body: request.body,
        content_type: request.content_type,
        proxy_mode,
        max_response_body_bytes: Some(max_body),
        timeout: request.timeout,
      },
    ))
  }
}

fn resolve_endpoint_alias(manifest: &ServiceIntegrationManifest, alias: &str) -> Result<String, CapabilityError> {
  manifest
    .endpoints
    .iter()
    .find(|e| e.alias == alias)
    .map(|e| e.base_url.clone())
    .ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        format!("unknown endpoint alias '{alias}'"),
      )
    })
}

fn resolve_proxy_mode(config_json: &str) -> ProxyMode {
  serde_json::from_str::<GoogleCloudConfigV1>(config_json)
    .map(|c| c.proxy_mode)
    .unwrap_or(ProxyMode::Inherit)
}

fn map_validation(err: StorageError) -> CapabilityError {
  match err {
    StorageError::Validation(msg) => CapabilityError::new(CapabilityErrorCode::InvalidRequest, msg),
    other => map_storage(other),
  }
}

fn map_storage(err: StorageError) -> CapabilityError {
  match err {
    StorageError::NotFound(msg) => CapabilityError::new(CapabilityErrorCode::InvalidConfiguration, msg),
    StorageError::PluginUnavailable(msg) => CapabilityError::new(CapabilityErrorCode::PluginUnavailable, msg),
    StorageError::Validation(msg) => CapabilityError::new(CapabilityErrorCode::InvalidRequest, msg),
    _ => CapabilityError::new(CapabilityErrorCode::Internal, "internal storage error"),
  }
}

fn map_transport_error(err: StorageError) -> CapabilityError {
  match err {
    StorageError::Validation(msg) if msg.contains("cancelled") => {
      CapabilityError::new(CapabilityErrorCode::Cancelled, "request cancelled")
    }
    StorageError::Validation(msg) if msg.contains("timed out") || msg.contains("idle timeout") => {
      CapabilityError::new(CapabilityErrorCode::Timeout, "request timed out")
    }
    StorageError::Validation(msg) if msg.contains("exceeds size limit") || msg.contains("byte cap") => {
      CapabilityError::new(CapabilityErrorCode::InvalidResponse, "response body exceeds size limit")
    }
    StorageError::Validation(msg) if msg.contains("network") => {
      CapabilityError::new(CapabilityErrorCode::Network, "network request failed")
    }
    StorageError::Validation(msg) => CapabilityError::new(CapabilityErrorCode::Network, msg),
    other => map_storage(other),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::provider_http::ProviderHttpStreamEvent;
  use crate::domain::service_integration::{
    GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, IntegrationHealthStatus, IntegrationInstance,
  };
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::services::token_grant::TokenGrant;
  use std::future::Future;
  use std::pin::Pin;
  use std::sync::Mutex;

  struct CaptureTransport {
    last: Mutex<Option<PreparedHttpRequest>>,
    response: Mutex<Result<ProviderHttpResponse, StorageError>>,
  }

  impl RawHttpTransport for CaptureTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderHttpResponse, StorageError>> + Send + '_>> {
      Box::pin(async move {
        *self.last.lock().unwrap() = Some(prepared);
        match &*self.response.lock().unwrap() {
          Ok(r) => Ok(r.clone()),
          Err(e) => Err(StorageError::Validation(e.to_string())),
        }
      })
    }

    fn stream(
      &self,
      _prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
    ) -> Pin<Box<dyn Future<Output = Result<(), StorageError>> + Send + '_>> {
      Box::pin(async { Err(StorageError::Validation("stream not supported".into())) })
    }
  }

  fn seed_google_instance(db: &Database) -> Uuid {
    let id = new_id();
    let now = now_rfc3339();
    let config = GoogleCloudConfigV1 {
      project_id: "demo".into(),
      location: GOOGLE_CLOUD_DEFAULT_LOCATION.into(),
      proxy_mode: ProxyMode::Direct,
    };
    db.transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &IntegrationInstance {
          id,
          plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
          plugin_version: "1.0.0".into(),
          display_name: "Test".into(),
          enabled: true,
          config_json: serde_json::to_string(&config).unwrap(),
          config_schema_version: 1,
          health_status: IntegrationHealthStatus::Unvalidated,
          last_validated_at: None,
          last_error_code: None,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();
    id
  }

  async fn make_grant(instance_id: Uuid) -> TokenGrant {
    use crate::services::token_grant::{
      ExchangedToken, GOOGLE_OAUTH_AUDIENCE_POLICY_ID, GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID, GoogleTokenExchanger,
      TokenGrantRequest, TokenGrantService,
    };
    struct ImmediateExchanger;
    impl GoogleTokenExchanger for ImmediateExchanger {
      fn exchange(
        &self,
        _instance_id: Uuid,
        _scopes: Vec<String>,
        _now_unix_secs: u64,
        _cancel: Option<CancelToken>,
      ) -> Pin<Box<dyn Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>> {
        Box::pin(async {
          Ok(ExchangedToken {
            access_token: "test-token".into(),
            expires_in: 3600,
            credential_revision: 1,
          })
        })
      }
    }
    let service = TokenGrantService::new(Arc::new(ImmediateExchanger));
    service
      .acquire(
        TokenGrantRequest {
          instance_id,
          capability_id: "translate.text@1".into(),
          auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
          scopes: vec!["https://www.googleapis.com/auth/cloud-translation".into()],
          audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        },
        None,
      )
      .await
      .unwrap()
  }

  fn broker_with(db: Database, transport: Arc<dyn RawHttpTransport>) -> NetworkBroker {
    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    NetworkBroker::with_transport(db, registry, transport)
  }

  #[tokio::test]
  async fn network_broker_allows_approved_relative_request() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_google_instance(&db);
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: "{}".into(),
      })),
    });
    let broker = broker_with(db, transport.clone());
    let grant = make_grant(id).await;
    let response = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v3beta1/projects/demo/locations/global:translateText".into(),
        query: vec![],
        headers: HashMap::from([("X-Client".into(), "test".into())]),
        body: Some("{}".into()),
        content_type: Some("application/json".into()),
        auth: Some(grant),
        request_id: "req-1".into(),
        cancel: None,
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .unwrap();
    assert_eq!(response.status, 200);
    let prepared = transport.last.lock().unwrap().take().unwrap();
    assert!(prepared.url.as_str().starts_with("https://translation.googleapis.com/"));
    assert!(prepared.headers.contains_key("Authorization"));
  }

  #[tokio::test]
  async fn network_broker_rejects_unknown_alias_and_cross_capability() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_google_instance(&db);
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: "{}".into(),
      })),
    });
    let broker = broker_with(db, transport);
    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        endpoint_alias: "vision".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v1/images:annotate".into(),
        query: vec![],
        headers: HashMap::new(),
        body: None,
        content_type: None,
        auth: None,
        request_id: "req-2".into(),
        cancel: None,
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[tokio::test]
  async fn network_broker_rejects_absolute_url_traversal_and_auth_headers() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_google_instance(&db);
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: "{}".into(),
      })),
    });
    let broker = broker_with(db, transport);

    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "https://evil.example/x".into(),
        query: vec![],
        headers: HashMap::new(),
        body: None,
        content_type: None,
        auth: None,
        request_id: "req-3".into(),
        cancel: None,
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidRequest);

    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "../secret".into(),
        query: vec![],
        headers: HashMap::new(),
        body: None,
        content_type: None,
        auth: None,
        request_id: "req-4".into(),
        cancel: None,
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidRequest);

    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v3beta1/ok".into(),
        query: vec![],
        headers: HashMap::from([("Authorization".into(), "Bearer stolen".into())]),
        body: None,
        content_type: None,
        auth: None,
        request_id: "req-5".into(),
        cancel: None,
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[tokio::test]
  async fn network_broker_cancellation_and_overflow() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_google_instance(&db);

    let cancel = CancelToken::new();
    cancel.cancel();
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: "{}".into(),
      })),
    });
    let broker = broker_with(db.clone(), transport);
    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v3beta1/ok".into(),
        query: vec![],
        headers: HashMap::new(),
        body: None,
        content_type: None,
        auth: None,
        request_id: "req-6".into(),
        cancel: Some(cancel),
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::Cancelled);

    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Err(StorageError::Validation("response body exceeds size limit".into()))),
    });
    let broker = broker_with(db, transport);
    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v3beta1/ok".into(),
        query: vec![],
        headers: HashMap::new(),
        body: None,
        content_type: None,
        auth: None,
        request_id: "req-7".into(),
        cancel: None,
        max_response_body_bytes: Some(8),
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }
}
