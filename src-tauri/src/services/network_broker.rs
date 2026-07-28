// ABOUTME: Service-integration network broker resolving manifest endpoint aliases only.
// ABOUTME: Injects opaque token grants and enforces path/header/size/cancel policy before transport.
use crate::domain::cancel::CancelToken;
use crate::domain::provider_http::{ProviderHttpMethod, ProviderHttpResponse};
use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode, CapabilityExecutionPrincipal};
use crate::domain::service_integration::{IntegrationInstance, ServiceIntegrationManifest};
use crate::error::StorageError;
use crate::repositories::{integration_credential_bindings, integration_instances};
use crate::services::bounded_http::{
  BoundedHttpResponse, DestinationPolicy, MAX_RESPONSE_BODY_BYTES, PreparedHttpRequest, REQUEST_TIMEOUT,
  RawHttpTransport, ReqwestRawHttpTransport, append_query_pairs, build_endpoint, is_blocked_header,
  validate_caller_name, validate_external_destination, validate_relative_path, validate_request_id,
  value_looks_like_secret_key, with_cancel,
};
use crate::services::bundled_plugins::{
  BundledPluginRegistration, CapabilityEndpointAuthority, CapabilityPathAuthority,
};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::token_grant::TokenGrant;
use crate::storage::Database;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
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
/// Hard upper limit across all capability authority request body limits.
pub const BROKER_ABSOLUTE_REQUEST_BODY_MAX_BYTES: usize = BROKER_OCR_REQUEST_BODY_MAX_BYTES;
/// Maximum caller-provided query pairs accepted before authority matching.
pub const BROKER_MAX_QUERY_PAIRS: usize = 32;
/// Maximum caller-provided headers accepted before authority matching.
pub const BROKER_MAX_HEADERS: usize = 16;
/// Maximum UTF-8 bytes in one caller-provided query value or header value.
pub const BROKER_CALLER_VALUE_MAX_BYTES: usize = 8 * 1024;
/// Maximum content-type bytes supplied by a capability handler.
pub const BROKER_CONTENT_TYPE_MAX_BYTES: usize = 128;

/// Capability-scoped network request using a manifest endpoint alias.
pub struct BrokerRequest {
  pub integration_instance_id: Uuid,
  pub capability_id: String,
  /// Immutable caller identity issued by the resolved capability invocation.
  pub execution_principal: CapabilityExecutionPrincipal,
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
      .field("execution_principal", &self.execution_principal)
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

  /// Execute a brokered request whose response body must be valid UTF-8.
  /// Existing JSON-based providers use this compatibility adapter.
  pub async fn execute(&self, request: BrokerRequest) -> Result<ProviderHttpResponse, CapabilityError> {
    self
      .execute_bytes(request)
      .await?
      .into_provider_http_response()
      .map_err(map_transport_error)
  }

  /// Execute a brokered request and retain the bounded response body as raw bytes.
  /// Binary capabilities such as Edge TTS use this path; it never attempts UTF-8 decoding.
  pub async fn execute_bytes(&self, request: BrokerRequest) -> Result<BoundedHttpResponse, CapabilityError> {
    let (cancel, work) = self.prepare(request)?;
    with_cancel(cancel.as_ref(), self.transport.request(work))
      .await
      .map_err(map_transport_error)
  }

  /// Validate execution principal, instance eligibility, and exact capability authority
  /// (endpoint alias, method, path) before a handler acquires a token grant or accesses the
  /// credential vault. Required by Phase 1 Task 3: the broker must authorize the principal
  /// and capability authority entry before credential/token access. Grant-set revision and
  /// grant binding are validated later in [`execute`]/[`execute_bytes`] when the grant is
  /// presented.
  pub fn pre_authorize(
    &self,
    integration_instance_id: Uuid,
    execution_principal: &CapabilityExecutionPrincipal,
    capability_id: &str,
    endpoint_alias: &str,
    method: ProviderHttpMethod,
    relative_path: &str,
    request_id: &str,
  ) -> Result<(), CapabilityError> {
    validate_request_id(request_id).map_err(map_validation)?;
    validate_relative_path(relative_path).map_err(map_validation)?;

    let instance = self
      .db
      .read(|conn| integration_instances::get(conn, integration_instance_id))
      .map_err(map_storage)?;
    if !instance.enabled {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "integration instance is disabled",
      ));
    }
    validate_execution_principal(
      execution_principal,
      request_id,
      integration_instance_id,
      &instance.plugin_id,
      capability_id,
    )?;

    let registration = self
      .registry
      .get_registration(&instance.plugin_id)
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::PluginUnavailable, "plugin definition is missing"))?;
    let capability = registration.capability(capability_id).ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "capability is not declared on this plugin",
      )
    })?;
    resolve_capability_authority(
      registration,
      capability.endpoint_authorities.as_slice(),
      &instance.config_json,
      endpoint_alias,
      method,
      relative_path,
    )?;
    Ok(())
  }

  /// Verify that an opaque grant belongs to this instance and still matches every required
  /// credential slot revision before it can be injected into a brokered request.
  fn validate_current_grant_set(
    &self,
    instance_id: Uuid,
    registration: &crate::services::bundled_plugins::BundledPluginRegistration,
    grant: &TokenGrant,
  ) -> Result<(), CapabilityError> {
    if grant.instance_id() != instance_id {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "token grant instance mismatch",
      ));
    }
    let bindings = self
      .db
      .read(|conn| integration_credential_bindings::list_for_instance(conn, instance_id))
      .map_err(map_storage)?;
    let binding_by_slot: HashMap<&str, _> = bindings
      .iter()
      .map(|binding| (binding.slot_id.as_str(), binding))
      .collect();
    let grant_revision = grant.credential_revision();
    for slot in registration
      .manifest
      .credential_slots
      .iter()
      .filter(|slot| slot.required)
    {
      let binding = binding_by_slot.get(slot.id.as_str()).copied();
      let current = binding
        .filter(|binding| binding.credential_ref.is_some())
        .map(|binding| binding.credential_revision);
      if current != Some(grant_revision) {
        return Err(CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "token grant credential revision is stale",
        ));
      }
    }
    Ok(())
  }

  fn prepare(&self, request: BrokerRequest) -> Result<(Option<CancelToken>, PreparedHttpRequest), CapabilityError> {
    validate_request_id(&request.request_id).map_err(map_validation)?;
    if request.relative_path.len() > BROKER_RELATIVE_PATH_MAX_LEN {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        "relative path exceeds limit",
      ));
    }
    validate_relative_path(&request.relative_path).map_err(map_validation)?;
    if request.query.len() > BROKER_MAX_QUERY_PAIRS {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        "query pair count exceeds limit",
      ));
    }
    if request.headers.len() > BROKER_MAX_HEADERS {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        "header count exceeds limit",
      ));
    }
    if let Some(body) = &request.body {
      if body.len() > BROKER_ABSOLUTE_REQUEST_BODY_MAX_BYTES {
        return Err(CapabilityError::new(
          CapabilityErrorCode::UnsupportedInput,
          "request body exceeds absolute limit",
        ));
      }
    }

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
    validate_execution_principal(
      &request.execution_principal,
      &request.request_id,
      request.integration_instance_id,
      &instance.plugin_id,
      &request.capability_id,
    )?;

    let registration = self
      .registry
      .get_registration(&instance.plugin_id)
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::PluginUnavailable, "plugin definition is missing"))?;
    let capability = registration.capability(&request.capability_id).ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "capability is not declared on this plugin",
      )
    })?;
    let authority = resolve_capability_authority(
      registration,
      capability.endpoint_authorities.as_slice(),
      &instance.config_json,
      &request.endpoint_alias,
      request.method,
      &request.relative_path,
    )?;

    let requested_request_limit = request
      .max_request_body_bytes
      .unwrap_or(authority.max_request_body_bytes);
    if requested_request_limit > authority.max_request_body_bytes {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "request body limit exceeds capability authority",
      ));
    }
    if let Some(body) = &request.body {
      if body.len() > requested_request_limit {
        return Err(CapabilityError::new(
          CapabilityErrorCode::UnsupportedInput,
          "request body exceeds capability limit",
        ));
      }
    }
    let requested_response_limit = request
      .max_response_body_bytes
      .unwrap_or(authority.max_response_body_bytes);
    if requested_response_limit > authority.max_response_body_bytes {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "response body limit exceeds capability authority",
      ));
    }
    let timeout = request.timeout.unwrap_or(REQUEST_TIMEOUT);
    if timeout > authority.max_timeout {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "timeout exceeds capability authority",
      ));
    }
    if let Some(content_type) = request.content_type.as_deref() {
      if content_type.len() > BROKER_CONTENT_TYPE_MAX_BYTES || content_type != "application/json" {
        return Err(CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "content type is not authorized for this broker request",
        ));
      }
    }

    let base_url = resolve_endpoint_base(registration, &registration.manifest, &instance, &request.endpoint_alias)?;
    // Origins come from pinned manifest grants or instance-validated HTTPS proxy config only.
    let mut url = build_endpoint(&base_url, &request.relative_path).map_err(map_validation)?;

    for (name, value) in &request.query {
      validate_caller_name(name, "query").map_err(map_validation)?;
      if value.len() > BROKER_CALLER_VALUE_MAX_BYTES {
        return Err(CapabilityError::new(
          CapabilityErrorCode::InvalidRequest,
          "query value exceeds limit",
        ));
      }
      if value_looks_like_secret_key(name) || !authority_allows_name(&authority.allowed_query_names, name) {
        return Err(CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          format!("caller query name '{name}' is not authorized"),
        ));
      }
    }
    append_query_pairs(&mut url, &request.query).map_err(map_validation)?;
    validate_external_destination(&url).map_err(map_validation)?;

    let mut headers = HashMap::new();
    for (name, value) in &request.headers {
      validate_caller_name(name, "header").map_err(map_validation)?;
      if value.len() > BROKER_CALLER_VALUE_MAX_BYTES {
        return Err(CapabilityError::new(
          CapabilityErrorCode::InvalidRequest,
          "header value exceeds limit",
        ));
      }
      if is_blocked_header(name)
        || value_looks_like_secret_key(name)
        || !authority_allows_name(&authority.allowed_header_names, name)
      {
        return Err(CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          format!("caller header '{name}' is not authorized"),
        ));
      }
      headers.insert(name.clone(), value.clone());
    }

    match (&authority.auth_policy_id, request.auth.as_ref()) {
      (None, Some(_)) => {
        return Err(CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "credential-free capability cannot use token grants",
        ));
      }
      (None, None) => {}
      (Some(policy_id), Some(grant)) => {
        let binding = registration
          .auth_policy
          .as_ref()
          .filter(|binding| &binding.auth_policy_id == policy_id)
          .ok_or_else(|| {
            CapabilityError::new(
              CapabilityErrorCode::PermissionDenied,
              "capability auth policy is unavailable",
            )
          })?;
        self.validate_current_grant_set(request.integration_instance_id, registration, grant)?;
        if grant.is_expired(Instant::now()) {
          return Err(CapabilityError::new(
            CapabilityErrorCode::PermissionDenied,
            "token grant has expired",
          ));
        }
        if grant.capability_id() != request.capability_id
          || grant.auth_driver_id() != binding.auth_driver_id
          || grant.audience_policy_id() != binding.audience_policy_id
        {
          return Err(CapabilityError::new(
            CapabilityErrorCode::PermissionDenied,
            "token grant authority does not match capability",
          ));
        }
        grant.apply_bearer_auth(&mut headers);
      }
      (Some(_), None) => {
        return Err(CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability requires a token grant",
        ));
      }
    }

    let proxy_mode = registration.config_adapter.proxy_mode(&instance.config_json);

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
        destination_policy: DestinationPolicy::PublicInternet,
        max_response_body_bytes: Some(requested_response_limit),
        timeout: Some(timeout),
      },
    ))
  }
}

fn validate_execution_principal(
  principal: &CapabilityExecutionPrincipal,
  request_id: &str,
  integration_instance_id: Uuid,
  instance_plugin_id: &str,
  capability_id: &str,
) -> Result<(), CapabilityError> {
  if principal.request_id != request_id
    || principal.integration_instance_id != integration_instance_id
    || principal.plugin_id != instance_plugin_id
    || principal.capability_id != capability_id
  {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "execution principal does not match broker request",
    ));
  }
  Ok(())
}

fn resolve_capability_authority<'a>(
  registration: &BundledPluginRegistration,
  authorities: &'a [CapabilityEndpointAuthority],
  config_json: &str,
  endpoint_alias: &str,
  method: ProviderHttpMethod,
  relative_path: &str,
) -> Result<&'a CapabilityEndpointAuthority, CapabilityError> {
  for authority in authorities {
    if authority.endpoint_alias != endpoint_alias || authority.method != method {
      continue;
    }
    let path_matches = match &authority.path {
      CapabilityPathAuthority::InstanceConfigured => {
        registration
          .config_adapter
          .instance_endpoint_relative_path(config_json, endpoint_alias)
          .map_err(map_validation)?
          .as_deref()
          == Some(relative_path)
      }
      path => path.matches_static(relative_path),
    };
    if path_matches {
      return Ok(authority);
    }
  }
  Err(CapabilityError::new(
    CapabilityErrorCode::PermissionDenied,
    "capability authority does not allow this endpoint, method, or path",
  ))
}

fn authority_allows_name(allowed: &[String], candidate: &str) -> bool {
  allowed.iter().any(|name| name.eq_ignore_ascii_case(candidate))
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

/// Resolve endpoint base URL from pinned manifest grants or instance-sourced origins.
fn resolve_endpoint_base(
  registration: &crate::services::bundled_plugins::BundledPluginRegistration,
  manifest: &ServiceIntegrationManifest,
  instance: &IntegrationInstance,
  alias: &str,
) -> Result<String, CapabilityError> {
  // Capability already authorized the alias; still require it on the manifest.
  let pinned = resolve_endpoint_alias(manifest, alias)?;
  if registration.endpoint_policy.allow_instance_endpoints {
    if let Some(origin) = registration
      .config_adapter
      .instance_endpoint_origin(&instance.config_json, alias)
      .map_err(map_validation)?
    {
      return Ok(origin);
    }
  }
  Ok(pinned)
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
    StorageError::Validation(msg) if msg.contains("network") => CapabilityError::new(CapabilityErrorCode::Network, msg),
    StorageError::Validation(msg) => CapabilityError::new(CapabilityErrorCode::Network, msg),
    other => map_storage(other),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::provider::ProxyMode;
  use crate::domain::provider_http::ProviderHttpStreamEvent;
  use crate::domain::service_integration::{
    GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT, GoogleCloudConfigV1,
    IntegrationCredentialBinding, IntegrationHealthStatus, IntegrationInstance,
  };
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::repositories::integration_credential_bindings;
  use crate::services::token_grant::TokenGrant;
  use std::future::Future;
  use std::pin::Pin;
  use std::sync::Mutex;

  struct CaptureTransport {
    last: Mutex<Option<PreparedHttpRequest>>,
    response: Mutex<Result<BoundedHttpResponse, StorageError>>,
  }

  impl RawHttpTransport for CaptureTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, StorageError>> + Send + '_>> {
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

  fn text_response(body: &str) -> BoundedHttpResponse {
    BoundedHttpResponse {
      status: 200,
      headers: HashMap::new(),
      body: body.as_bytes().to_vec(),
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
          runtime_kind: "bundled-rust".into(),
          package_digest: None,
          execution_grant_set_revision: None,
          runtime_state: "active".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      integration_credential_bindings::insert(
        uow.conn(),
        &IntegrationCredentialBinding {
          id: new_id(),
          integration_instance_id: id,
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential_ref: Some("test-credential-ref".into()),
          credential_revision: 1,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();
    id
  }

  fn principal(instance_id: Uuid, capability_id: &str, request_id: &str) -> CapabilityExecutionPrincipal {
    CapabilityExecutionPrincipal {
      request_id: request_id.into(),
      integration_instance_id: instance_id,
      plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
      capability_id: capability_id.into(),
    }
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
      response: Mutex::new(Ok(text_response("{}"))),
    });
    let broker = broker_with(db, transport.clone());
    let grant = make_grant(id).await;
    let response = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        execution_principal: principal(id, "translate.text@1", "req-1"),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v3beta1/projects/demo/locations/global:translateText".into(),
        query: vec![],
        headers: HashMap::new(),
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
      response: Mutex::new(Ok(text_response("{}"))),
    });
    let broker = broker_with(db, transport);
    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        execution_principal: principal(id, "translate.text@1", "req-2"),
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
      response: Mutex::new(Ok(text_response("{}"))),
    });
    let broker = broker_with(db, transport);

    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        execution_principal: principal(id, "translate.text@1", "req-3"),
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
        execution_principal: principal(id, "translate.text@1", "req-4"),
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
        execution_principal: principal(id, "translate.text@1", "req-5"),
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
  async fn network_broker_rejects_stale_grant_before_transport() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_google_instance(&db);
    let grant = make_grant(id).await;
    db.transaction(|uow| {
      integration_credential_bindings::compare_and_set_ref(
        uow.conn(),
        id,
        GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
        Some("test-credential-ref"),
        Some("rotated-credential-ref"),
        &now_rfc3339(),
      )?;
      Ok(())
    })
    .unwrap();

    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(text_response("{}"))),
    });
    let broker = broker_with(db, transport.clone());
    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        execution_principal: principal(id, "translate.text@1", "req-stale-grant"),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v3beta1/projects/demo/locations/global:translateText".into(),
        query: vec![],
        headers: HashMap::new(),
        body: Some("{}".into()),
        content_type: Some("application/json".into()),
        auth: Some(grant),
        request_id: "req-stale-grant".into(),
        cancel: None,
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .unwrap_err();

    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
    assert!(transport.last.lock().unwrap().is_none());
  }

  #[tokio::test]
  async fn network_broker_rejects_cross_capability_grants_before_transport() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_google_instance(&db);
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(text_response("{}"))),
    });
    let broker = broker_with(db, transport.clone());
    let text_grant = make_grant(id).await;

    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.detect@1".into(),
        execution_principal: principal(id, "translate.detect@1", "req-cross-grant"),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v3beta1/projects/demo/locations/global:detectLanguage".into(),
        query: vec![],
        headers: HashMap::new(),
        body: Some("{}".into()),
        content_type: Some("application/json".into()),
        auth: Some(text_grant),
        request_id: "req-cross-grant".into(),
        cancel: None,
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .unwrap_err();

    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
    assert!(transport.last.lock().unwrap().is_none());
  }

  #[tokio::test]
  async fn network_broker_rejects_mismatched_principal_and_unapproved_headers_before_transport() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_google_instance(&db);
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(text_response("{}"))),
    });
    let broker = broker_with(db.clone(), transport.clone());

    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        execution_principal: principal(id, "translate.text@1", "wrong-request-id"),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v3beta1/projects/demo/locations/global:translateText".into(),
        query: vec![],
        headers: HashMap::new(),
        body: Some("{}".into()),
        content_type: Some("application/json".into()),
        auth: Some(make_grant(id).await),
        request_id: "req-principal".into(),
        cancel: None,
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
    assert!(transport.last.lock().unwrap().is_none());

    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        execution_principal: principal(id, "translate.text@1", "req-header"),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v3beta1/projects/demo/locations/global:translateText".into(),
        query: vec![],
        headers: HashMap::from([("X-Unapproved".into(), "value".into())]),
        body: Some("{}".into()),
        content_type: Some("application/json".into()),
        auth: Some(make_grant(id).await),
        request_id: "req-header".into(),
        cancel: None,
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
    assert!(transport.last.lock().unwrap().is_none());
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
      response: Mutex::new(Ok(text_response("{}"))),
    });
    let broker = broker_with(db.clone(), transport);
    let grant = make_grant(id).await;
    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        execution_principal: principal(id, "translate.text@1", "req-6"),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v3beta1/projects/demo/locations/global:translateText".into(),
        query: vec![],
        headers: HashMap::new(),
        body: None,
        content_type: None,
        auth: Some(grant),
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
    let grant = make_grant(id).await;
    let err = broker
      .execute(BrokerRequest {
        integration_instance_id: id,
        capability_id: "translate.text@1".into(),
        execution_principal: principal(id, "translate.text@1", "req-7"),
        endpoint_alias: "translate".into(),
        method: ProviderHttpMethod::Post,
        relative_path: "v3beta1/projects/demo/locations/global:translateText".into(),
        query: vec![],
        headers: HashMap::new(),
        body: None,
        content_type: None,
        auth: Some(grant),
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

  #[test]
  fn pre_authorize_allows_approved_capability_authority() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_google_instance(&db);
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(text_response("{}"))),
    });
    let broker = broker_with(db, transport);
    broker
      .pre_authorize(
        id,
        &principal(id, "translate.text@1", "req-pre-1"),
        "translate.text@1",
        "translate",
        ProviderHttpMethod::Post,
        "v3beta1/projects/demo/locations/global:translateText",
        "req-pre-1",
      )
      .expect("approved authority should pre-authorize");
  }

  #[test]
  fn pre_authorize_rejects_wrong_endpoint_before_token_access() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_google_instance(&db);
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(text_response("{}"))),
    });
    let broker = broker_with(db, transport);
    let err = broker
      .pre_authorize(
        id,
        &principal(id, "translate.text@1", "req-pre-2"),
        "translate.text@1",
        "vision",
        ProviderHttpMethod::Post,
        "v1/images:annotate",
        "req-pre-2",
      )
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[test]
  fn pre_authorize_rejects_wrong_method_before_token_access() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_google_instance(&db);
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(text_response("{}"))),
    });
    let broker = broker_with(db, transport);
    let err = broker
      .pre_authorize(
        id,
        &principal(id, "translate.text@1", "req-pre-3"),
        "translate.text@1",
        "translate",
        ProviderHttpMethod::Get,
        "v3beta1/projects/demo/locations/global:translateText",
        "req-pre-3",
      )
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[test]
  fn pre_authorize_rejects_mismatched_principal_before_token_access() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_google_instance(&db);
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(text_response("{}"))),
    });
    let broker = broker_with(db, transport);
    let err = broker
      .pre_authorize(
        id,
        &principal(id, "translate.text@1", "tampered-request-id"),
        "translate.text@1",
        "translate",
        ProviderHttpMethod::Post,
        "v3beta1/projects/demo/locations/global:translateText",
        "req-pre-4",
      )
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }
}
