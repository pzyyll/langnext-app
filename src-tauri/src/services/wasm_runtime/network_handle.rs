// ABOUTME: BrokerHandle implementation backed by a bounded RawHttpTransport so Wasm guests can
// ABOUTME: reach approved HTTPS origins (GTX/proxy) without credentials or ambient network access.
use crate::domain::cancel::CancelToken;
use crate::domain::endpoint_trust::{ENDPOINT_TRUST_REQUIRED_MARKER, EndpointEgressPolicy, classify_endpoint_egress};
use crate::domain::plugin_resource::{
  NetworkResponseBodyMode, RESOURCE_MAX_CHUNK_BYTES, ResourceCreateParams, ResourceDirection, ResourceOwner,
};
use crate::domain::provider_http::{ProviderHttpMethod, ProviderHttpStreamEvent};
use crate::domain::runtime_plugin::{ExecutionGrantSet, NetworkOriginKind, PluginPrincipal};
use crate::services::auth_policies::GOOGLE_SERVICE_ACCOUNT_AUTH_POLICY_ID;
use crate::services::bounded_http::{
  BoundedHttpResponse, DestinationPolicy, PreparedHttpRequest, RawHttpTransport, RequestBody, build_endpoint,
  validate_external_destination, with_cancel,
};
use crate::services::stream_resources::{
  STREAM_PUMP_SHUTDOWN_TIMEOUT, StreamFrame, StreamResourceTable, sleep_until_deadline,
};
use crate::services::token_grant::TokenGrantService;
use crate::services::wasm_runtime::host::{
  BrokerAuthorization, BrokerFetchError, BrokerFetchOutcome, BrokerFetchRequest, BrokerFetchResponse, BrokerHandle,
  BrokerRequestBody, BrokerResponseBody,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Auth policy id for credential-free endpoints.
const AUTH_POLICY_NONE_V1: &str = "host.none.v1";
/// Fixed broker marker used to preserve token-exchange auth classification across frozen WIT.
pub(crate) const TOKEN_GRANT_AUTH_FAILURE_MARKER: &str = "token-grant-auth-failed";

/// Bounded event channel capacity between the transport stream driver and the stream-writer pump.
/// The writer's own frame buffer provides the primary backpressure bound; this channel absorbs
/// burst latency so a momentarily-slow consumer does not abort an otherwise healthy stream.
const STREAM_EVENT_CHANNEL_CAPACITY: usize = 64;

/// Maximum bytes pumped as a single network-binary frame. Mirrors the host chunk cap so a
/// provider chunk never exceeds the stream's per-frame bound.
const STREAM_FRAME_MAX_BYTES: u64 = RESOURCE_MAX_CHUNK_BYTES;

/// `BrokerHandle` that executes grant-authorized HTTPS requests through a bounded transport.
///
/// Authorization (origin, method, path, headers, body size) is already enforced by the host
/// runtime before `fetch` is called. Credential-free calls never inject auth; the Google policy
/// acquires an opaque host token and injects Bearer only inside this handle.
#[derive(Clone)]
pub struct NetworkBrokerHandle {
  transport: Arc<dyn RawHttpTransport>,
  token_grants: Option<Arc<TokenGrantService>>,
}

impl NetworkBrokerHandle {
  pub fn new(transport: Arc<dyn RawHttpTransport>) -> Self {
    Self {
      transport,
      token_grants: None,
    }
  }

  pub fn with_token_grants(mut self, token_grants: Arc<TokenGrantService>) -> Self {
    self.token_grants = Some(token_grants);
    self
  }

  pub fn new_with_token_grants(transport: Arc<dyn RawHttpTransport>, token_grants: Arc<TokenGrantService>) -> Self {
    Self::new(transport).with_token_grants(token_grants)
  }
}

impl BrokerHandle for NetworkBrokerHandle {
  fn fetch(
    &self,
    principal: &PluginPrincipal,
    _grant: &ExecutionGrantSet,
    request: BrokerFetchRequest,
    authorization: BrokerAuthorization,
    cancel: &CancelToken,
    deadline: Option<Instant>,
  ) -> Pin<Box<dyn Future<Output = BrokerFetchOutcome> + Send + '_>> {
    let transport = self.transport.clone();
    let token_grants = self.token_grants.clone();
    let principal = principal.clone();
    let cancel = cancel.clone();
    Box::pin(async move {
      if authorization.auth_policy.as_str() != AUTH_POLICY_NONE_V1
        && authorization.auth_policy.as_str() != GOOGLE_SERVICE_ACCOUNT_AUTH_POLICY_ID
      {
        return Err(BrokerFetchError::NotApproved);
      }
      let destination_policy = destination_policy_for_authorization(&principal, &authorization)?;
      let method = parse_method(&request.method)?;
      let (path_part, query_part) = request
        .relative_path
        .split_once('?')
        .unwrap_or((&request.relative_path, ""));
      let mut url = match build_endpoint(&authorization.base_url, path_part) {
        Ok(url) => url,
        Err(_) => return Err(BrokerFetchError::Network("invalid endpoint url".into())),
      };
      if !query_part.is_empty() {
        url.set_query(Some(query_part));
      }
      if validate_external_destination(&url).is_err() {
        return Err(BrokerFetchError::Network("destination rejected by host policy".into()));
      }
      let (body, content_type) = request_body_into_transport(&request.body);
      let mut headers = std::collections::HashMap::new();
      for (name, value) in &request.headers {
        headers.insert(name.clone(), value.clone());
      }
      if authorization.auth_policy.as_str() == GOOGLE_SERVICE_ACCOUNT_AUTH_POLICY_ID {
        let token_grants = token_grants.ok_or(BrokerFetchError::NotApproved)?;
        let grant_request = crate::services::auth_policies::token_grant_request_for_capability(
          principal.instance_id(),
          authorization.auth_policy.as_str(),
          principal.capability_id().as_str(),
        )
        .map_err(map_token_grant_error)?;
        let grant = token_grants
          .acquire(grant_request, Some(&cancel))
          .await
          .map_err(map_token_grant_error)?;
        grant.apply_bearer_auth(&mut headers);
      }
      let max_response_bytes = authorization.resource_limits.max_response_bytes();
      let timeout = std::time::Duration::from_millis(authorization.resource_limits.timeout_ms());
      let prepared = PreparedHttpRequest {
        method,
        url,
        headers,
        body,
        content_type,
        // Host-fixed Google origins intentionally use the trusted-fixed transport, which
        // bypasses ambient proxies; the configured proxy mode remains host-owned for OAuth
        // token exchange. User-approved custom origins retain their explicit inherit policy.
        proxy_mode: if destination_policy == DestinationPolicy::UserApprovedCustom {
          crate::domain::provider::ProxyMode::Inherit
        } else {
          crate::domain::provider::ProxyMode::Direct
        },
        destination_policy,
        max_response_body_bytes: Some(max_response_bytes as usize),
        timeout: Some(timeout),
      };
      let mode = authorization.selected_response_mode;
      if mode == NetworkResponseBodyMode::Stream {
        return pump_stream_response(transport, principal, prepared, authorization, cancel, deadline).await;
      }
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
      bounded_to_broker_response(response, mode)
    })
  }
}

fn map_token_grant_error(error: crate::domain::service_capability::CapabilityError) -> BrokerFetchError {
  use crate::domain::service_capability::CapabilityErrorCode;
  match error.code {
    CapabilityErrorCode::Cancelled => BrokerFetchError::Cancelled,
    CapabilityErrorCode::Timeout => BrokerFetchError::Timeout,
    CapabilityErrorCode::Auth => BrokerFetchError::Network(TOKEN_GRANT_AUTH_FAILURE_MARKER.into()),
    CapabilityErrorCode::PermissionDenied | CapabilityErrorCode::InvalidConfiguration => BrokerFetchError::NotApproved,
    _ => BrokerFetchError::Network("token grant failed".into()),
  }
}

/// Convert a broker request body into the transport's binary-safe [`RequestBody`] without lossy
/// UTF-8 conversion. JSON bodies are already UTF-8-validated by the host authorization layer;
/// Blob bodies preserve arbitrary octets so binary request payloads (e.g. multipart audio) reach
/// the transport intact.
pub(crate) fn request_body_into_transport(body: &BrokerRequestBody) -> (RequestBody, Option<String>) {
  match body {
    BrokerRequestBody::Empty => (RequestBody::None, None),
    BrokerRequestBody::Json(bytes) => {
      // The host authorization layer already validated UTF-8 + JSON for Json bodies. Convert to
      // text here only after that validation; a non-UTF-8 Json body is a host invariant violation.
      match std::str::from_utf8(bytes) {
        Ok(s) => (RequestBody::text(s), Some("application/json".to_string())),
        Err(_) => (RequestBody::bytes(bytes.clone()), Some("application/json".to_string())),
      }
    }
    BrokerRequestBody::Blob { bytes, .. } => {
      // Binary request body: preserve raw octets without UTF-8 conversion.
      (
        RequestBody::bytes(bytes.clone()),
        Some("application/octet-stream".to_string()),
      )
    }
  }
}

/// Bounded idle wait between stream events in the pump. Mirrors the transport's own idle timeout
/// but is shorter than the stream backpressure wait so a stalled upstream is failed
/// (and the reader notified) before the consumer's backpressure fallback elapses.
const STREAM_PUMP_IDLE_TIMEOUT: Duration = Duration::from_secs(20);

/// Stable terminal codes exposed through host stream resources. Raw transport details can include
/// provider-internal information, so they are deliberately never copied into a guest-visible code.
const STREAM_TRANSPORT_FAILURE_CODE: &str = "transport-failure";
const STREAM_TRANSPORT_CLOSED_CODE: &str = "transport-closed";
const STREAM_TRANSPORT_MISSING_FINISHED_CODE: &str = "transport-missing-finished";
const STREAM_TRANSPORT_TASK_LOST_CODE: &str = "transport-task-lost";
const STREAM_PROTOCOL_FAILURE_CODE: &str = "protocol-error";
const STREAM_BYTE_LIMIT_CODE: &str = "byte-limit";
const STREAM_DEADLINE_CODE: &str = "deadline";
const STREAM_CHUNK_TOO_LARGE_CODE: &str = "chunk-too-large";
const STREAM_SEND_FAILED_CODE: &str = "send-failed";
const STREAM_HTTP_ERROR_CODE: &str = "http-error";
const STREAM_IDLE_TIMEOUT_CODE: &str = "idle-timeout";

/// Cancels and aborts a transport task when the pre-header broker future is dropped before it can
/// hand its task handles to the reader-owned supervisor. This prevents a dropped import future
/// from detaching an in-flight transport.
struct PreHeaderTransportGuard {
  cancel: CancelToken,
  abort_handle: tokio::task::AbortHandle,
  armed: bool,
}

impl PreHeaderTransportGuard {
  fn new(cancel: CancelToken, abort_handle: tokio::task::AbortHandle) -> Self {
    Self {
      cancel,
      abort_handle,
      armed: true,
    }
  }

  fn disarm(&mut self) {
    self.armed = false;
  }
}

impl Drop for PreHeaderTransportGuard {
  fn drop(&mut self) {
    if self.armed {
      self.cancel.cancel();
      self.abort_handle.abort();
    }
  }
}

/// Cancel a pre-header transport, await bounded termination, then abort and await it when the
/// implementation ignores cooperative cancellation. The task result itself is delivered through
/// a oneshot to the header wait/pump; this join only supervises task lifetime.
async fn shutdown_preheader_transport(stream_task: &mut tokio::task::JoinHandle<()>) {
  match tokio::time::timeout(STREAM_PUMP_SHUTDOWN_TIMEOUT, &mut *stream_task).await {
    Ok(Ok(())) => {}
    Ok(Err(error)) if !error.is_cancelled() => {
      log::warn!("stream transport task ended unexpectedly during pre-header shutdown");
    }
    Ok(Err(_)) => {}
    Err(_) => {
      stream_task.abort();
      if let Err(error) = stream_task.await {
        if !error.is_cancelled() {
          log::warn!("stream transport task ended unexpectedly after pre-header abort");
        }
      }
    }
  }
}

/// Convert an internal transport result into a stable, non-sensitive stream terminal code.
fn stream_transport_failure_code(error: &crate::error::StorageError) -> &'static str {
  let description = error.to_string().to_ascii_lowercase();
  if description.contains("byte cap") || description.contains("size limit") {
    STREAM_BYTE_LIMIT_CODE
  } else if description.contains("timeout") || description.contains("deadline") {
    "transport-timeout"
  } else {
    STREAM_TRANSPORT_FAILURE_CODE
  }
}

/// Pump a streaming HTTP response into a host-owned stream pair, returning a reader handle the
/// guest consumes concurrently. The transport drives chunk delivery through `on_event`; a bounded
/// channel decouples the sync callback from the async writer pump so backpressure, cancellation,
/// and total/idle/deadline limits are enforced.
///
/// The transport and pump tasks are supervised, not detached: the reader handle carries a
/// [`StreamPumpSupervisor`] whose cancel token is stored in the stream state, so reader
/// close/cancel/expiry stops the upstream transport, and `reader_close` joins both tasks.
pub(crate) async fn pump_stream_response(
  transport: Arc<dyn RawHttpTransport>,
  principal: PluginPrincipal,
  mut prepared: PreparedHttpRequest,
  authorization: BrokerAuthorization,
  cancel: CancelToken,
  deadline: Option<Instant>,
) -> BrokerFetchOutcome {
  let max_stream_bytes = authorization.resource_limits.max_stream_bytes().max(1);
  let params = ResourceCreateParams {
    owner: ResourceOwner::from_principal(&principal),
    direction: ResourceDirection::Output,
    content_type: None,
    max_bytes: max_stream_bytes,
    expires_at: None,
    cancel: cancel.clone(),
  };
  let (mut writer, mut reader) = StreamResourceTable::create_network_binary_pair(params)
    .map_err(|e| BrokerFetchError::Internal(format!("stream create failed: {e}")))?;
  // Thread grant stream limits through the prepared request so `execute_stream` does not rely on
  // fixed defaults: the stream byte cap and total timeout come from the grant.
  prepared.max_response_body_bytes = Some(max_stream_bytes as usize);
  // Transport-specific cancel token: terminal transitions (reader close/cancel/expiry) fire it so
  // the upstream transport stops promptly. Falls back to the request token when no supervisor.
  let transport_cancel = reader.transport_cancel().unwrap_or_else(|| cancel.clone());

  let (started_tx, mut started_rx) = tokio::sync::oneshot::channel::<(u16, Vec<(String, String)>)>();
  // Keep one sender alive until the pre-header select exits so a transport result, not incidental
  // callback destruction, determines whether a no-Started attempt failed or merely completed.
  let _started_tx_keepalive = Arc::new(std::sync::Mutex::new(Some(started_tx)));
  let (transport_result_tx, mut transport_result_rx) =
    tokio::sync::oneshot::channel::<Result<(), crate::error::StorageError>>();
  let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<StreamEvent>(STREAM_EVENT_CHANNEL_CAPACITY);

  // Drive the transport stream in a supervised task. The raw result travels unchanged through a
  // oneshot to the header waiter/pump; the guest only receives a stable terminal code derived
  // from it. This prevents post-header transport failures from becoming successful truncation.
  let transport_for_stream = transport.clone();
  let cancel_for_stream = transport_cancel.clone();
  let started_tx_clone = _started_tx_keepalive.clone();
  let event_tx_clone = event_tx.clone();
  let mut stream_task = tokio::spawn(async move {
    let on_event = move |event: ProviderHttpStreamEvent| -> Result<(), crate::error::StorageError> {
      if let ProviderHttpStreamEvent::Started { status, headers } = &event {
        if let Some(tx) = started_tx_clone.lock().ok().and_then(|mut guard| guard.take()) {
          let header_pairs: Vec<(String, String)> = headers
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
          if tx.send((*status, header_pairs)).is_err() {
            log::debug!("stream header receiver closed before transport started");
          }
        }
      }
      match event_tx_clone.try_send(StreamEvent::Transport(event)) {
        Ok(()) => Ok(()),
        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => Err(crate::error::StorageError::Validation(
          "stream event buffer full; consumer too slow".into(),
        )),
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => Err(crate::error::StorageError::Validation(
          "stream event channel closed".into(),
        )),
      }
    };
    let result = transport_for_stream
      .stream(prepared, cancel_for_stream, Box::new(on_event))
      .await;
    if transport_result_tx.send(result).is_err() {
      log::debug!("stream transport result receiver closed before completion");
    }
  });
  let mut preheader_guard = PreHeaderTransportGuard::new(transport_cancel.clone(), stream_task.abort_handle());
  // Pre-header precedence is deterministic: request cancellation, request deadline, a Started
  // header, then transport completion. Every non-Started exit cancels and joins (or aborts) the
  // transport before this function returns, so a cancelled invocation cannot leave it running.
  let started = tokio::select! {
    biased;
    _ = cancel.cancelled() => Err(BrokerFetchError::Cancelled),
    _ = sleep_until_deadline(deadline) => Err(BrokerFetchError::Timeout),
    started = &mut started_rx => match started {
      Ok(headers) => Ok(headers),
      // The callback/transport task vanished before delivering Started. Treat that as a
      // pre-header transport failure and supervise shutdown below; never wait unboundedly for a
      // result after the header signal is gone.
      Err(_) => Err(BrokerFetchError::Network("stream header channel closed before response headers".into())),
    },
    transport_result = &mut transport_result_rx => match transport_result {
      Ok(Ok(())) => Err(BrokerFetchError::Network("stream completed before response headers".into())),
      Ok(Err(_)) => Err(BrokerFetchError::Network("stream transport failed before response headers".into())),
      Err(_) => Err(BrokerFetchError::Network("stream transport task ended before response headers".into())),
    },
  };
  let (status, headers) = match started {
    Ok(headers) => headers,
    Err(error) => {
      transport_cancel.cancel();
      writer.cancel().await;
      shutdown_preheader_transport(&mut stream_task).await;
      return Err(error);
    }
  };

  // Non-2xx stream responses are surfaced before creating a guest reader. Stop and supervise the
  // transport rather than awaiting it indefinitely after headers.
  if !(200..300).contains(&status) {
    transport_cancel.cancel();
    if let Err(error) = writer.fail(&principal, STREAM_HTTP_ERROR_CODE).await {
      if !matches!(error, crate::domain::plugin_resource::ResourceError::Closed) {
        log::warn!("stream writer rejected non-success response terminal");
      }
    }
    shutdown_preheader_transport(&mut stream_task).await;
    return Err(BrokerFetchError::Network(format!("stream response status {status}")));
  }

  // Spawn the consumer pump. Terminal precedence after headers is deterministic: a previously
  // processed explicit Finished wins permanently; otherwise request/reader cancellation produces
  // Cancelled, request deadline produces Failed(deadline), and every transport result or channel
  // close produces Failed. Raw provider text is never copied into the terminal error.
  let principal_for_pump = principal.clone();
  let cancel_for_pump = cancel.clone();
  let transport_cancel_for_pump = transport_cancel.clone();
  let mut writer_for_pump = writer;
  let pump_task = tokio::spawn(async move {
    let mut initial_started_event_pending = true;
    loop {
      let idle_deadline = tokio::time::Instant::now() + STREAM_PUMP_IDLE_TIMEOUT;
      let recv = tokio::time::timeout_at(idle_deadline, event_rx.recv());
      tokio::select! {
        biased;
        _ = cancel_for_pump.cancelled() => {
          writer_for_pump.cancel().await;
          break;
        }
        _ = transport_cancel_for_pump.cancelled() => {
          writer_for_pump.cancel().await;
          break;
        }
        _ = sleep_until_deadline(deadline) => {
          if let Err(error) = writer_for_pump.fail(&principal_for_pump, STREAM_DEADLINE_CODE).await {
            if !matches!(error, crate::domain::plugin_resource::ResourceError::Closed) {
              log::warn!("stream writer rejected deadline terminal");
            }
          }
          break;
        }
        event = recv => {
          match event {
            Ok(Some(StreamEvent::Transport(ProviderHttpStreamEvent::Chunk { bytes }))) => {
              if bytes.len() as u64 > STREAM_FRAME_MAX_BYTES {
                if let Err(error) = writer_for_pump
                  .fail(&principal_for_pump, STREAM_CHUNK_TOO_LARGE_CODE).await {
                  if !matches!(error, crate::domain::plugin_resource::ResourceError::Closed) {
                    log::warn!("stream writer rejected oversized chunk terminal");
                  }
                }
                break;
              }
              let frame = StreamFrame::NetworkBinary(bytes);
              // Keep the deadline outside `send`: when backpressure blocks the writer, this
              // select gives request deadline precedence over the generic send failure path.
              let send_result = {
                let send = writer_for_pump.send(&principal_for_pump, frame, None, Some(&cancel_for_pump));
                tokio::pin!(send);
                tokio::select! {
                  biased;
                  _ = sleep_until_deadline(deadline) => None,
                  result = &mut send => Some(result),
                }
              };
              match send_result {
                None => {
                  if writer_for_pump.fail(&principal_for_pump, STREAM_DEADLINE_CODE).await.is_err() {
                    log::debug!("stream deadline terminal was already set");
                  }
                  break;
                }
                Some(Ok(())) => {}
                Some(Err(error)) => {
                  match error {
                    crate::domain::plugin_resource::ResourceError::Cancelled => writer_for_pump.cancel().await,
                    crate::domain::plugin_resource::ResourceError::Exhausted
                    | crate::domain::plugin_resource::ResourceError::OutOfBounds => {
                      if writer_for_pump.fail(&principal_for_pump, STREAM_BYTE_LIMIT_CODE).await.is_err() {
                        log::debug!("stream byte limit terminal was already set");
                      }
                    }
                    _ => {
                      if writer_for_pump.fail(&principal_for_pump, STREAM_SEND_FAILED_CODE).await.is_err() {
                        log::debug!("stream send failure terminal was already set");
                      }
                    }
                  }
                  break;
                }
              }
            }
            Ok(Some(StreamEvent::Transport(ProviderHttpStreamEvent::Finished))) => {
              if writer_for_pump.finish(&principal_for_pump).await.is_err() {
                log::debug!("stream finished terminal was already set");
              }
              break;
            }
            Ok(Some(StreamEvent::Transport(ProviderHttpStreamEvent::Started { .. }))) => {
              if initial_started_event_pending {
                initial_started_event_pending = false;
              } else {
                if writer_for_pump
                  .fail(&principal_for_pump, STREAM_PROTOCOL_FAILURE_CODE)
                  .await
                  .is_err()
                {
                  log::debug!("stream protocol terminal was already set");
                }
                break;
              }
            }
            Ok(None) => {
              // A closed event channel is never success: await the retained transport result when
              // available, otherwise report a stable closure failure.
              let code = match transport_result_rx.await {
                Ok(Ok(())) => STREAM_TRANSPORT_MISSING_FINISHED_CODE,
                Ok(Err(error)) => stream_transport_failure_code(&error),
                Err(_) => STREAM_TRANSPORT_CLOSED_CODE,
              };
              if writer_for_pump.fail(&principal_for_pump, code).await.is_err() {
                log::debug!("stream channel-closure terminal was already set");
              }
              break;
            }
            Err(_) => {
              if writer_for_pump.fail(&principal_for_pump, STREAM_IDLE_TIMEOUT_CODE).await.is_err() {
                log::debug!("stream idle timeout terminal was already set");
              }
              break;
            }
          }
        }
        transport_result = &mut transport_result_rx => {
          let code = match transport_result {
            Ok(Ok(())) => STREAM_TRANSPORT_MISSING_FINISHED_CODE,
            Ok(Err(error)) => stream_transport_failure_code(&error),
            Err(_) => STREAM_TRANSPORT_TASK_LOST_CODE,
          };
          if let Err(error) = writer_for_pump.fail(&principal_for_pump, code).await {
            if !matches!(error, crate::domain::plugin_resource::ResourceError::Closed) {
              log::warn!("stream writer rejected transport terminal");
            }
          }
          break;
        }
      }
    }
  });

  // Ownership of both task handles transfers to the reader supervisor. From this point reader
  // close/request cleanup/store drop own cancellation and joining; do not fire the pre-header
  // guard on the successful return path.
  reader.install_pump_handles(stream_task, pump_task);
  preheader_guard.disarm();

  Ok(BrokerFetchResponse {
    status,
    headers,
    body: BrokerResponseBody::Stream { reader },
  })
}

/// Internal event wrapper for the pump channel.
enum StreamEvent {
  Transport(ProviderHttpStreamEvent),
}

/// Select trusted transport only from sealed grant provenance plus the host's exact origin
/// allowlist. The guest supplies neither this marker nor a policy selector.
fn destination_policy_for_authorization(
  principal: &PluginPrincipal,
  authorization: &BrokerAuthorization,
) -> Result<DestinationPolicy, BrokerFetchError> {
  let current_approval = authorization.origin_kind == NetworkOriginKind::UserApprovedInstance;
  match classify_endpoint_egress(
    principal.plugin_id().as_str(),
    authorization.endpoint_id.as_str(),
    authorization.base_url.as_str(),
    Some(authorization.origin_kind),
    current_approval,
  ) {
    EndpointEgressPolicy::TrustedFixed => Ok(DestinationPolicy::TrustedFixed),
    EndpointEgressPolicy::PublicInternet => Ok(DestinationPolicy::PublicInternet),
    EndpointEgressPolicy::UserApprovedCustom => Ok(DestinationPolicy::UserApprovedCustom),
    EndpointEgressPolicy::ReviewRequired => Err(BrokerFetchError::Network(ENDPOINT_TRUST_REQUIRED_MARKER.into())),
  }
}

/// Convert a bounded transport response into the neutral broker response using the grant-selected
/// response mode. JSON validates UTF-8; bytes mode returns raw payload for host Blob wrapping.
pub(crate) fn bounded_to_broker_response(
  response: BoundedHttpResponse,
  mode: NetworkResponseBodyMode,
) -> Result<BrokerFetchResponse, BrokerFetchError> {
  let headers: Vec<(String, String)> = response.headers.into_iter().collect();
  let content_type = headers
    .iter()
    .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
    .map(|(_, value)| value.clone());
  let body = match mode {
    NetworkResponseBodyMode::Json => {
      // Reject non-UTF-8 for JSON mode so binary payloads cannot smuggle through as JSON.
      if std::str::from_utf8(&response.body).is_err() {
        return Err(BrokerFetchError::Network("non-utf8 json body".into()));
      }
      BrokerResponseBody::Json(response.body)
    }
    NetworkResponseBodyMode::Bytes => BrokerResponseBody::Bytes {
      content_type,
      bytes: response.body,
    },
    NetworkResponseBodyMode::Stream => {
      // Stream mode is handled by pump_stream_response before reaching this path.
      return Err(BrokerFetchError::Internal(
        "stream mode requires host stream pump".into(),
      ));
    }
  };
  Ok(BrokerFetchResponse {
    status: response.status,
    headers,
    body,
  })
}

pub(crate) fn parse_method(method: &str) -> Result<ProviderHttpMethod, BrokerFetchError> {
  match method {
    "GET" => Ok(ProviderHttpMethod::Get),
    "POST" => Ok(ProviderHttpMethod::Post),
    _ => Err(BrokerFetchError::Network(format!("unsupported method: {method}"))),
  }
}

pub(crate) fn map_storage_to_broker(err: crate::error::StorageError) -> BrokerFetchError {
  // Classify for stable guest behavior without reflecting provider/transport text. A raw error
  // can contain an endpoint, proxy response, or provider diagnostic and must not cross the ABI.
  let description = err.to_string().to_ascii_lowercase();
  if description.contains("cancel") {
    BrokerFetchError::Cancelled
  } else if description.contains("timeout") || description.contains("deadline") {
    BrokerFetchError::Timeout
  } else {
    BrokerFetchError::Network("network request failed".into())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::plugin_resource::{NetworkResponseBodyModes, ResourceId, STREAM_DEFAULT_BUFFER_FRAMES};
  use crate::domain::runtime_plugin::{
    AuthPolicyId, CapabilityId, EndpointId, ExecutionGrantSet, HttpsOrigin, NetworkOriginKind, PackageDigest,
    PackageIdentity, PluginId, ResourceLimits, RuntimeIdentity, SemVerVersion,
  };
  use crate::services::bounded_http::{BoundedHttpResponse, ResolverBackedTestTransport, TestDnsLookupFn};
  use std::collections::HashMap;
  use std::net::SocketAddr;
  use std::sync::{Arc, Mutex};
  use std::time::Duration;
  use uuid::Uuid;

  fn principal() -> PluginPrincipal {
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Package(PackageIdentity {
        package_digest: PackageDigest::parse("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
          .unwrap(),
      }),
      PluginId::parse("com.langnext.stream-net-test").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![CapabilityId::parse("translate.text@1").unwrap()],
      vec![],
      vec![],
    )
    .unwrap();
    grant.principal_for_request("translate.text@1", "req-net-1").unwrap()
  }

  /// Synthetic transport that records the prepared request and returns a fixed bounded response.
  struct FixedTransport {
    response: BoundedHttpResponse,
    last: std::sync::Mutex<Option<PreparedHttpRequest>>,
  }

  impl RawHttpTransport for FixedTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>> {
      *self.last.lock().unwrap() = Some(prepared);
      let response = self.response.clone();
      Box::pin(async move { Ok(response) })
    }

    fn stream(
      &self,
      _prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send>,
    ) -> Pin<Box<dyn Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      Box::pin(async { Err(crate::error::StorageError::Validation("stream not supported".into())) })
    }
  }

  fn authorization(mode: NetworkResponseBodyMode) -> BrokerAuthorization {
    BrokerAuthorization {
      endpoint_id: EndpointId::parse("ep").unwrap(),
      origin: HttpsOrigin::parse("https://example.com").unwrap(),
      base_url: "https://example.com".into(),
      origin_kind: NetworkOriginKind::InstanceConfigured,
      auth_policy: AuthPolicyId::parse("host.none.v1").unwrap(),
      resource_limits: ResourceLimits::default(),
      response_body_modes: NetworkResponseBodyModes::ALL,
      selected_response_mode: mode,
    }
  }

  fn edge_principal() -> PluginPrincipal {
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Package(PackageIdentity {
        package_digest: PackageDigest::parse("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd")
          .unwrap(),
      }),
      PluginId::parse(crate::domain::service_integration::EDGE_TTS_PLUGIN_ID).unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![CapabilityId::parse("speech.synthesize@1").unwrap()],
      vec![],
      vec![],
    )
    .unwrap();
    grant
      .principal_for_request("speech.synthesize@1", "edge-policy-request")
      .unwrap()
  }

  fn edge_authorization(origin: &str, origin_kind: NetworkOriginKind) -> BrokerAuthorization {
    BrokerAuthorization {
      endpoint_id: EndpointId::parse(crate::domain::endpoint_trust::EDGE_TTS_TRUST_ENDPOINT_ALIAS).unwrap(),
      origin: HttpsOrigin::parse(origin).unwrap(),
      base_url: origin.into(),
      origin_kind,
      auth_policy: AuthPolicyId::parse("host.none.v1").unwrap(),
      resource_limits: ResourceLimits::default(),
      response_body_modes: NetworkResponseBodyModes::JSON_ONLY,
      selected_response_mode: NetworkResponseBodyMode::Json,
    }
  }

  async fn assert_approved_custom_dns_answer_reaches_unfiltered_handle(hostname: &'static str, synthetic_ip: [u8; 4]) {
    const LOOPBACK_IP: [u8; 4] = [127, 0, 0, 1];
    const DNS_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

    let listener = tokio::net::TcpListener::bind(SocketAddr::from((LOOPBACK_IP, 0)))
      .await
      .unwrap();
    let port = listener.local_addr().unwrap().port();
    let expected_answers = vec![SocketAddr::from((LOOPBACK_IP, 0)), SocketAddr::from((synthetic_ip, 0))];
    let observed = Arc::new(Mutex::new(Vec::<(String, Vec<SocketAddr>)>::new()));
    let observed_for_lookup = observed.clone();
    let expected_answers_for_lookup = expected_answers.clone();
    let lookup: TestDnsLookupFn = Arc::new(move |requested_host| {
      let observed = observed_for_lookup.clone();
      let requested_host = requested_host.to_owned();
      let answers = expected_answers_for_lookup.clone();
      Box::pin(async move {
        observed.lock().unwrap().push((requested_host, answers.clone()));
        Ok(answers)
      })
    });

    let transport = Arc::new(ResolverBackedTestTransport::new(lookup));
    let handle = NetworkBrokerHandle::new(transport);
    let principal = edge_principal();
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse(crate::domain::service_integration::EDGE_TTS_PLUGIN_ID).unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![],
      vec![],
      vec![],
    )
    .unwrap();
    let authorization = edge_authorization(
      &format!("https://{hostname}:{port}"),
      NetworkOriginKind::UserApprovedInstance,
    );
    const TLS_FATAL_ALERT: [u8; 7] = [0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28];
    let accept_probe = async {
      let stream = listener.accept().await.unwrap().0;
      let _ = stream.try_write(&TLS_FATAL_ALERT);
    };
    let (outcome, accepted) = tokio::join!(
      handle.fetch(
        &principal,
        &grant,
        BrokerFetchRequest {
          endpoint_id: crate::domain::endpoint_trust::EDGE_TTS_TRUST_ENDPOINT_ALIAS.into(),
          relative_path: "v1/audio/speech".into(),
          method: "POST".into(),
          headers: vec![("Accept".into(), "audio/mpeg".into())],
          body: BrokerRequestBody::Json(br#"{}"#.to_vec()),
        },
        authorization,
        &CancelToken::new(),
        None,
      ),
      tokio::time::timeout(DNS_PROBE_TIMEOUT, accept_probe),
    );
    accepted.expect("approved custom DNS transport must reach the local probe");
    assert!(
      matches!(outcome, Err(BrokerFetchError::Network(_))),
      "the plaintext probe is intentionally not a TLS server: {outcome:?}"
    );

    let observed = observed.lock().unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].0, hostname);
    assert_eq!(observed[0].1, expected_answers);
  }

  #[tokio::test]
  async fn edge_approved_fake_ip_dns_answer_reaches_unfiltered_transport() {
    assert_approved_custom_dns_answer_reaches_unfiltered_handle("approved-fake-ip.test", [198, 18, 0, 1]).await;
  }

  #[tokio::test]
  async fn edge_approved_private_dns_answer_reaches_unfiltered_transport() {
    assert_approved_custom_dns_answer_reaches_unfiltered_handle("approved-private-dns.test", [10, 0, 0, 7]).await;
  }

  #[tokio::test]
  async fn edge_unapproved_custom_origin_is_rejected_before_transport() {
    let transport = Arc::new(FixedTransport {
      response: BoundedHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: br#"{}"#.to_vec(),
      },
      last: std::sync::Mutex::new(None),
    });
    let handle = NetworkBrokerHandle::new(transport.clone());
    let principal = edge_principal();
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse(crate::domain::service_integration::EDGE_TTS_PLUGIN_ID).unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![],
      vec![],
      vec![],
    )
    .unwrap();
    let outcome = handle
      .fetch(
        &principal,
        &grant,
        BrokerFetchRequest {
          endpoint_id: crate::domain::endpoint_trust::EDGE_TTS_TRUST_ENDPOINT_ALIAS.into(),
          relative_path: "v1/audio/speech".into(),
          method: "POST".into(),
          headers: vec![("Accept".into(), "application/json".into())],
          body: BrokerRequestBody::Json(br#"{}"#.to_vec()),
        },
        edge_authorization("https://custom.example", NetworkOriginKind::InstanceConfigured),
        &CancelToken::new(),
        None,
      )
      .await;
    assert!(matches!(
      outcome,
      Err(BrokerFetchError::Network(message)) if message == ENDPOINT_TRUST_REQUIRED_MARKER
    ));
    assert!(transport.last.lock().unwrap().is_none());
  }

  #[tokio::test]
  async fn edge_approved_custom_origin_uses_user_approved_transport_policy() {
    let transport = Arc::new(FixedTransport {
      response: BoundedHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: br#"{}"#.to_vec(),
      },
      last: std::sync::Mutex::new(None),
    });
    let handle = NetworkBrokerHandle::new(transport.clone());
    let principal = edge_principal();
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse(crate::domain::service_integration::EDGE_TTS_PLUGIN_ID).unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![],
      vec![],
      vec![],
    )
    .unwrap();
    let outcome = handle
      .fetch(
        &principal,
        &grant,
        BrokerFetchRequest {
          endpoint_id: crate::domain::endpoint_trust::EDGE_TTS_TRUST_ENDPOINT_ALIAS.into(),
          relative_path: "v1/audio/speech".into(),
          method: "POST".into(),
          headers: vec![("Accept".into(), "application/json".into())],
          body: BrokerRequestBody::Json(br#"{}"#.to_vec()),
        },
        edge_authorization("https://custom.example", NetworkOriginKind::UserApprovedInstance),
        &CancelToken::new(),
        None,
      )
      .await;
    assert!(outcome.is_ok(), "approved custom endpoint should execute: {outcome:?}");
    let prepared = transport.last.lock().unwrap().take().unwrap();
    assert_eq!(prepared.destination_policy, DestinationPolicy::UserApprovedCustom);
    assert_eq!(prepared.proxy_mode, crate::domain::provider::ProxyMode::Inherit);
  }

  #[tokio::test]
  async fn blob_request_body_preserves_non_utf8_bytes() {
    let transport = Arc::new(FixedTransport {
      response: BoundedHttpResponse {
        status: 200,
        headers: HashMap::from([("content-type".into(), "application/json".into())]),
        body: br#"{"ok":true}"#.to_vec(),
      },
      last: std::sync::Mutex::new(None),
    });
    let handle = NetworkBrokerHandle::new(transport.clone());
    let principal = principal();
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.langnext.stream-net-test").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![],
      vec![],
      vec![],
    )
    .unwrap();
    let binary_bytes = vec![0xFF, 0xFE, 0xFD, 0x00, 0x01];
    let request = BrokerFetchRequest {
      endpoint_id: "ep".into(),
      relative_path: "upload".into(),
      method: "POST".into(),
      headers: vec![("Accept".into(), "application/octet-stream".into())],
      body: BrokerRequestBody::Blob {
        bytes: binary_bytes.clone(),
        byte_len: binary_bytes.len(),
      },
    };
    let cancel = CancelToken::new();
    let outcome = handle
      .fetch(
        &principal,
        &grant,
        request,
        authorization(NetworkResponseBodyMode::Bytes),
        &cancel,
        None,
      )
      .await;
    assert!(outcome.is_ok(), "fetch should succeed: {:?}", outcome.err());
    let prepared = transport.last.lock().unwrap().take().expect("transport called");
    match prepared.body {
      RequestBody::Bytes(b) => assert_eq!(b, binary_bytes),
      other => panic!("expected Bytes body, got {other:?}"),
    }
    assert_eq!(prepared.content_type.as_deref(), Some("application/octet-stream"));
  }

  #[tokio::test]
  async fn stream_mode_returns_real_reader_not_internal_error() {
    let transport = Arc::new(FixedTransport {
      response: BoundedHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: vec![],
      },
      last: std::sync::Mutex::new(None),
    });
    let handle = NetworkBrokerHandle::new(transport);
    let principal = principal();
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.langnext.stream-net-test").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![],
      vec![],
      vec![],
    )
    .unwrap();
    let request = BrokerFetchRequest {
      endpoint_id: "ep".into(),
      relative_path: "stream".into(),
      method: "GET".into(),
      headers: vec![("Accept".into(), "text/event-stream".into())],
      body: BrokerRequestBody::Empty,
    };
    let cancel = CancelToken::new();
    let outcome = handle
      .fetch(
        &principal,
        &grant,
        request,
        authorization(NetworkResponseBodyMode::Stream),
        &cancel,
        None,
      )
      .await;
    // The FixedTransport does not support streaming, so the pump fails before Started. The key
    // assertion is that the error is NOT the old stub "stream mode requires host stream pump".
    match outcome {
      Err(BrokerFetchError::Network(msg)) => {
        assert!(
          !msg.contains("stream mode requires host stream pump"),
          "must not return the stub error: {msg}"
        );
      }
      Ok(response) => match response.body {
        BrokerResponseBody::Stream { .. } => {}
        other => panic!("expected Stream body, got {other:?}"),
      },
      Err(e) => panic!("unexpected error variant: {e:?}"),
    }
  }

  /// Pre-header request cancellation must fire the transport-specific token and await the raw
  /// transport's termination before the broker returns Cancelled.
  #[tokio::test]
  async fn stream_preheader_request_cancellation_stops_transport() {
    let entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let transport = Arc::new(PreHeaderBlockingTransport {
      entered: entered.clone(),
      cancelled: stopped.clone(),
    });
    let handle = NetworkBrokerHandle::new(transport);
    let principal = principal();
    let grant = bundled_grant();
    let cancel = CancelToken::new();
    let cancel_for_task = cancel.clone();
    let entered_for_task = entered.clone();
    let cancellation_task = tokio::spawn(async move {
      wait_for_flag(entered_for_task.as_ref(), "transport entry").await;
      cancel_for_task.cancel();
    });

    let outcome = handle
      .fetch(
        &principal,
        &grant,
        stream_fetch_request(),
        authorization(NetworkResponseBodyMode::Stream),
        &cancel,
        None,
      )
      .await;
    cancellation_task.await.expect("cancellation task joined");

    assert!(matches!(outcome, Err(BrokerFetchError::Cancelled)));
    wait_for_flag(stopped.as_ref(), "transport cancellation").await;
  }

  /// A deadline while waiting for Started uses the same transport-specific token and leaves no
  /// pre-header raw transport running.
  #[tokio::test]
  async fn stream_preheader_deadline_stops_transport() {
    const PREHEADER_DEADLINE_WAIT: Duration = Duration::from_millis(50);
    let entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let transport = Arc::new(PreHeaderBlockingTransport {
      entered: entered.clone(),
      cancelled: stopped.clone(),
    });
    let handle = NetworkBrokerHandle::new(transport);
    let principal = principal();
    let grant = bundled_grant();
    let outcome = handle
      .fetch(
        &principal,
        &grant,
        stream_fetch_request(),
        authorization(NetworkResponseBodyMode::Stream),
        &CancelToken::new(),
        Some(Instant::now() + PREHEADER_DEADLINE_WAIT),
      )
      .await;

    assert!(matches!(outcome, Err(BrokerFetchError::Timeout)));
    wait_for_flag(entered.as_ref(), "transport entry").await;
    wait_for_flag(stopped.as_ref(), "transport cancellation").await;
  }

  /// A raw transport error before Started maps to a stable broker failure, never its raw text.
  #[tokio::test]
  async fn stream_preheader_transport_error_is_sanitized() {
    let transport = Arc::new(FixedTransport {
      response: BoundedHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: vec![],
      },
      last: std::sync::Mutex::new(None),
    });
    let handle = NetworkBrokerHandle::new(transport);
    let principal = principal();
    let grant = bundled_grant();
    let outcome = handle
      .fetch(
        &principal,
        &grant,
        stream_fetch_request(),
        authorization(NetworkResponseBodyMode::Stream),
        &CancelToken::new(),
        None,
      )
      .await;

    assert!(matches!(
      outcome,
      Err(BrokerFetchError::Network(message)) if message == "stream transport failed before response headers"
    ));
  }

  /// Scripted streaming transport for end-to-end pump lifecycle tests. Emits a fixed event
  /// sequence with an optional per-event delay, then either completes or stalls (never sends
  /// more data) to simulate a stalled upstream. Cancel-aware so the supervisor join is prompt.
  struct StreamingTransport {
    events: Vec<ProviderHttpStreamEvent>,
    chunk_delay: Duration,
    stall_after_events: bool,
  }

  impl RawHttpTransport for StreamingTransport {
    fn request(
      &self,
      _prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>> {
      Box::pin(async { Err(crate::error::StorageError::Validation("request not supported".into())) })
    }

    fn stream(
      &self,
      _prepared: PreparedHttpRequest,
      cancel: CancelToken,
      on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send>,
    ) -> Pin<Box<dyn Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      let events = self.events.clone();
      let delay = self.chunk_delay;
      let stall = self.stall_after_events;
      Box::pin(async move {
        for event in events {
          if cancel.is_cancelled() {
            return Err(crate::error::StorageError::Validation("cancelled".into()));
          }
          if !delay.is_zero() {
            tokio::time::sleep(delay).await;
          }
          if cancel.is_cancelled() {
            return Err(crate::error::StorageError::Validation("cancelled".into()));
          }
          on_event(event)?;
        }
        if stall {
          // Stalled upstream: never sends more data. Exit promptly on cancel so the supervisor
          // join does not hang.
          let _ = cancel.cancelled().await;
          return Err(crate::error::StorageError::Validation("cancelled".into()));
        }
        Ok(())
      })
    }
  }

  /// Scripted transport that completes with an explicit raw result after delivering events. It
  /// drives post-header errors and clean EOF-without-Finished cases through the real pump.
  struct ResultStreamingTransport {
    events: Vec<ProviderHttpStreamEvent>,
    result: Result<(), crate::error::StorageError>,
  }

  impl RawHttpTransport for ResultStreamingTransport {
    fn request(
      &self,
      _prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>> {
      Box::pin(async { Err(crate::error::StorageError::Validation("request not supported".into())) })
    }

    fn stream(
      &self,
      _prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send>,
    ) -> Pin<Box<dyn Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      let events = self.events.clone();
      let result = match &self.result {
        Ok(()) => Ok(()),
        Err(error) => Err(crate::error::StorageError::Validation(error.to_string())),
      };
      Box::pin(async move {
        for event in events {
          on_event(event)?;
        }
        result
      })
    }
  }

  /// Transport that blocks before headers until its transport-specific token is cancelled. Its
  /// observable flags make pre-header cancellation/deadline cleanup deterministic in tests.
  struct PreHeaderBlockingTransport {
    entered: Arc<std::sync::atomic::AtomicBool>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
  }

  impl RawHttpTransport for PreHeaderBlockingTransport {
    fn request(
      &self,
      _prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>> {
      Box::pin(async { Err(crate::error::StorageError::Validation("request not supported".into())) })
    }

    fn stream(
      &self,
      _prepared: PreparedHttpRequest,
      cancel: CancelToken,
      _on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send>,
    ) -> Pin<Box<dyn Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      let entered = self.entered.clone();
      let cancelled = self.cancelled.clone();
      let keep_callback = _on_event;
      Box::pin(async move {
        let _keep_callback = keep_callback;
        entered.store(true, std::sync::atomic::Ordering::SeqCst);
        cancel.cancelled().await;
        cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        Err(crate::error::StorageError::Validation("transport cancelled".into()))
      })
    }
  }

  async fn wait_for_flag(flag: &std::sync::atomic::AtomicBool, description: &str) {
    const FLAG_WAIT_TIMEOUT: Duration = Duration::from_secs(1);
    tokio::time::timeout(FLAG_WAIT_TIMEOUT, async {
      while !flag.load(std::sync::atomic::Ordering::SeqCst) {
        tokio::task::yield_now().await;
      }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {description}"));
  }

  fn bundled_grant() -> ExecutionGrantSet {
    ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("com.langnext.stream-net-test").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![],
      vec![],
      vec![],
    )
    .unwrap()
  }

  fn authorization_with_stream_bytes(mode: NetworkResponseBodyMode, max_stream_bytes: u64) -> BrokerAuthorization {
    BrokerAuthorization {
      endpoint_id: EndpointId::parse("ep").unwrap(),
      origin: HttpsOrigin::parse("https://example.com").unwrap(),
      base_url: "https://example.com".into(),
      origin_kind: NetworkOriginKind::InstanceConfigured,
      auth_policy: AuthPolicyId::parse("host.none.v1").unwrap(),
      resource_limits: ResourceLimits::new(1024, 1024, max_stream_bytes, 60_000).unwrap(),
      response_body_modes: NetworkResponseBodyModes::ALL,
      selected_response_mode: mode,
    }
  }

  fn stream_fetch_request() -> BrokerFetchRequest {
    BrokerFetchRequest {
      endpoint_id: "ep".into(),
      relative_path: "stream".into(),
      method: "GET".into(),
      headers: vec![("Accept".into(), "text/event-stream".into())],
      body: BrokerRequestBody::Empty,
    }
  }

  /// Fetch a stream reader through the real broker binding and adopt it into a fresh table.
  async fn fetch_and_adopt_stream(
    transport: Arc<dyn RawHttpTransport>,
    auth: BrokerAuthorization,
    cancel: CancelToken,
    deadline: Option<Instant>,
  ) -> (PluginPrincipal, StreamResourceTable, ResourceId) {
    use crate::services::stream_resources::StreamResourceTable;
    let handle = NetworkBrokerHandle::new(transport);
    let principal = principal();
    let grant = bundled_grant();
    let response = handle
      .fetch(&principal, &grant, stream_fetch_request(), auth, &cancel, deadline)
      .await
      .expect("stream fetch should succeed");
    let reader = match response.body {
      BrokerResponseBody::Stream { reader } => reader,
      other => panic!("expected Stream body, got {other:?}"),
    };
    let mut table = StreamResourceTable::new();
    let reader_id = table.adopt_reader(reader).expect("adopt reader");
    (principal, table, reader_id)
  }

  /// End-to-end: transport emits Started/Chunk/Finished; broker_fetch returns a stream reader;
  /// the host binding receives chunks in order and the terminal state without panic.
  #[tokio::test]
  async fn stream_e2e_started_chunk_finished_in_order() {
    use crate::domain::plugin_resource::StreamTerminalState;
    use crate::services::stream_resources::StreamFrame;
    let transport = Arc::new(StreamingTransport {
      events: vec![
        ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::from([("content-type".into(), "audio/mpeg".into())]),
        },
        ProviderHttpStreamEvent::Chunk { bytes: b"a".to_vec() },
        ProviderHttpStreamEvent::Chunk { bytes: b"b".to_vec() },
        ProviderHttpStreamEvent::Finished,
      ],
      chunk_delay: Duration::ZERO,
      stall_after_events: false,
    });
    let (principal, mut table, reader_id) = fetch_and_adopt_stream(
      transport,
      authorization(NetworkResponseBodyMode::Stream),
      CancelToken::new(),
      None,
    )
    .await;

    let f1 = table
      .receive(reader_id, &principal, None, None)
      .await
      .expect("recv1")
      .expect("frame1");
    assert_eq!(f1, StreamFrame::NetworkBinary(b"a".to_vec()));
    let f2 = table
      .receive(reader_id, &principal, None, None)
      .await
      .expect("recv2")
      .expect("frame2");
    assert_eq!(f2, StreamFrame::NetworkBinary(b"b".to_vec()));
    let f3 = table
      .receive(reader_id, &principal, None, None)
      .await
      .expect("recv3")
      .expect("frame3");
    assert_eq!(f3, StreamFrame::Terminal(StreamTerminalState::Finished));
    // Reader close joins the pump; must not panic or hang.
    table.reader_close(reader_id, &principal).await.expect("close");
  }

  /// A raw transport failure after headers and a data chunk must become a stable Failed terminal;
  /// provider details are never copied into the guest-visible stream code.
  #[tokio::test]
  async fn stream_transport_error_after_started_chunk_fails_writer() {
    use crate::domain::plugin_resource::StreamTerminalState;
    let transport = Arc::new(ResultStreamingTransport {
      events: vec![
        ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::new(),
        },
        ProviderHttpStreamEvent::Chunk {
          bytes: b"audio".to_vec(),
        },
      ],
      result: Err(crate::error::StorageError::Validation(
        "provider-secret-do-not-expose".into(),
      )),
    });
    let (principal, mut table, reader_id) = fetch_and_adopt_stream(
      transport,
      authorization(NetworkResponseBodyMode::Stream),
      CancelToken::new(),
      None,
    )
    .await;

    let chunk = table.receive(reader_id, &principal, None, None).await.unwrap().unwrap();
    assert_eq!(chunk, StreamFrame::NetworkBinary(b"audio".to_vec()));
    let terminal = table.receive(reader_id, &principal, None, None).await.unwrap().unwrap();
    assert_eq!(
      terminal,
      StreamFrame::Terminal(StreamTerminalState::Failed(STREAM_TRANSPORT_FAILURE_CODE.into()))
    );
    assert!(!format!("{terminal:?}").contains("provider-secret-do-not-expose"));
    table.reader_close(reader_id, &principal).await.unwrap();
  }

  /// EOF/channel closure is not a successful stream unless the transport explicitly emitted the
  /// protocol Finished event first.
  #[tokio::test]
  async fn stream_channel_close_without_finished_fails_writer() {
    use crate::domain::plugin_resource::StreamTerminalState;
    let transport = Arc::new(ResultStreamingTransport {
      events: vec![
        ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::new(),
        },
        ProviderHttpStreamEvent::Chunk {
          bytes: b"partial".to_vec(),
        },
      ],
      result: Ok(()),
    });
    let (principal, mut table, reader_id) = fetch_and_adopt_stream(
      transport,
      authorization(NetworkResponseBodyMode::Stream),
      CancelToken::new(),
      None,
    )
    .await;

    let chunk = table.receive(reader_id, &principal, None, None).await.unwrap().unwrap();
    assert_eq!(chunk, StreamFrame::NetworkBinary(b"partial".to_vec()));
    let terminal = table.receive(reader_id, &principal, None, None).await.unwrap().unwrap();
    assert_eq!(
      terminal,
      StreamFrame::Terminal(StreamTerminalState::Failed(
        STREAM_TRANSPORT_MISSING_FINISHED_CODE.into()
      ))
    );
    table.reader_close(reader_id, &principal).await.unwrap();
  }

  /// Reader close mid-stream cancels the transport-specific token and joins pump cleanup.
  #[tokio::test]
  async fn stream_reader_close_stops_transport_and_joins() {
    use crate::domain::plugin_resource::ResourceError;
    let transport = Arc::new(StreamingTransport {
      events: vec![
        ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::new(),
        },
        ProviderHttpStreamEvent::Chunk { bytes: b"a".to_vec() },
        ProviderHttpStreamEvent::Chunk { bytes: b"b".to_vec() },
        ProviderHttpStreamEvent::Chunk { bytes: b"c".to_vec() },
        ProviderHttpStreamEvent::Finished,
      ],
      chunk_delay: Duration::from_millis(50),
      stall_after_events: false,
    });
    let (principal, mut table, reader_id) = fetch_and_adopt_stream(
      transport,
      authorization(NetworkResponseBodyMode::Stream),
      CancelToken::new(),
      None,
    )
    .await;
    // Receive at least one chunk so the pump is actively driving the transport.
    let _ = table
      .receive(reader_id, &principal, None, None)
      .await
      .expect("recv")
      .expect("frame");
    let start = Instant::now();
    table.reader_close(reader_id, &principal).await.expect("close");
    // Join must be prompt (transport is cancel-aware), well under the shutdown timeout.
    assert!(
      start.elapsed() < Duration::from_secs(2),
      "close took {:?}",
      start.elapsed()
    );
    // Reader is removed; further receives are NotOwned.
    assert!(matches!(
      table.receive(reader_id, &principal, None, None).await,
      Err(ResourceError::NotOwned)
    ));
  }

  /// Request cancellation stops the pump and surfaces a cancellation terminal to the reader.
  #[tokio::test]
  async fn stream_request_cancellation_fails_writer() {
    use crate::domain::plugin_resource::StreamTerminalState;
    use crate::services::stream_resources::StreamFrame;
    let transport = Arc::new(StreamingTransport {
      events: vec![
        ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::new(),
        },
        ProviderHttpStreamEvent::Chunk { bytes: b"a".to_vec() },
        ProviderHttpStreamEvent::Chunk { bytes: b"b".to_vec() },
        ProviderHttpStreamEvent::Chunk { bytes: b"c".to_vec() },
        ProviderHttpStreamEvent::Finished,
      ],
      chunk_delay: Duration::from_millis(50),
      stall_after_events: false,
    });
    let cancel = CancelToken::new();
    let (principal, mut table, reader_id) = fetch_and_adopt_stream(
      transport,
      authorization(NetworkResponseBodyMode::Stream),
      cancel.clone(),
      None,
    )
    .await;
    let _ = table
      .receive(reader_id, &principal, None, None)
      .await
      .expect("recv")
      .expect("frame");
    cancel.cancel();
    // Cancellation is a terminal Cancelled state, never a Failed("cancelled") transport error.
    let frame = tokio::time::timeout(
      Duration::from_secs(5),
      table.receive(reader_id, &principal, None, Some(&cancel)),
    )
    .await
    .expect("receive must not hang")
    .expect("recv ok")
    .expect("terminal frame");
    assert_eq!(frame, StreamFrame::Terminal(StreamTerminalState::Cancelled));
    table.reader_close(reader_id, &principal).await.ok();
  }

  /// Stream byte cap (grant max_stream_bytes) is enforced even with continuously active traffic.
  #[tokio::test]
  async fn stream_size_overflow_fails_writer() {
    use crate::domain::plugin_resource::StreamTerminalState;
    use crate::services::stream_resources::StreamFrame;
    let transport = Arc::new(StreamingTransport {
      events: vec![
        ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::new(),
        },
        ProviderHttpStreamEvent::Chunk {
          bytes: b"abcd".to_vec(),
        },
        ProviderHttpStreamEvent::Chunk { bytes: b"e".to_vec() },
        ProviderHttpStreamEvent::Finished,
      ],
      chunk_delay: Duration::ZERO,
      stall_after_events: false,
    });
    // max_stream_bytes = 4: the second chunk (total 5) exceeds the cap.
    let (principal, mut table, reader_id) = fetch_and_adopt_stream(
      transport,
      authorization_with_stream_bytes(NetworkResponseBodyMode::Stream, 4),
      CancelToken::new(),
      None,
    )
    .await;
    let f1 = table
      .receive(reader_id, &principal, None, None)
      .await
      .expect("recv1")
      .expect("frame1");
    assert_eq!(f1, StreamFrame::NetworkBinary(b"abcd".to_vec()));
    let f2 = table
      .receive(reader_id, &principal, None, None)
      .await
      .expect("recv2")
      .expect("frame2");
    assert_eq!(
      f2,
      StreamFrame::Terminal(StreamTerminalState::Failed(STREAM_BYTE_LIMIT_CODE.into()))
    );
    table.reader_close(reader_id, &principal).await.ok();
  }

  /// A full reader buffer must preserve deadline precedence: the blocked pump reports deadline,
  /// not the generic send failure produced by backpressure.
  #[tokio::test]
  async fn stream_backpressure_deadline_fails_writer() {
    use crate::domain::plugin_resource::StreamTerminalState;
    const BACKPRESSURE_DEADLINE: Duration = Duration::from_millis(100);
    const BACKPRESSURE_TERMINAL_WAIT: Duration = Duration::from_millis(200);
    const BACKPRESSURE_OVERFLOW_FRAMES: usize = 1;
    let mut events = Vec::with_capacity(STREAM_DEFAULT_BUFFER_FRAMES + BACKPRESSURE_OVERFLOW_FRAMES + 1);
    events.push(ProviderHttpStreamEvent::Started {
      status: 200,
      headers: HashMap::new(),
    });
    for _ in 0..(STREAM_DEFAULT_BUFFER_FRAMES + BACKPRESSURE_OVERFLOW_FRAMES) {
      events.push(ProviderHttpStreamEvent::Chunk { bytes: vec![0] });
    }
    let transport = Arc::new(StreamingTransport {
      events,
      chunk_delay: Duration::ZERO,
      stall_after_events: true,
    });
    let deadline = Some(Instant::now() + BACKPRESSURE_DEADLINE);
    let (principal, mut table, reader_id) = fetch_and_adopt_stream(
      transport,
      authorization(NetworkResponseBodyMode::Stream),
      CancelToken::new(),
      deadline,
    )
    .await;

    tokio::time::sleep(BACKPRESSURE_TERMINAL_WAIT).await;
    for _ in 0..STREAM_DEFAULT_BUFFER_FRAMES {
      let frame = table.receive(reader_id, &principal, None, None).await.unwrap().unwrap();
      assert_eq!(frame, StreamFrame::NetworkBinary(vec![0]));
    }
    let terminal = table.receive(reader_id, &principal, None, None).await.unwrap().unwrap();
    assert_eq!(
      terminal,
      StreamFrame::Terminal(StreamTerminalState::Failed(STREAM_DEADLINE_CODE.into()))
    );
    table.reader_close(reader_id, &principal).await.unwrap();
  }

  /// Total request deadline is enforced after headers even while the transport remains open.
  #[tokio::test]
  async fn stream_total_deadline_fails_writer() {
    use crate::domain::plugin_resource::StreamTerminalState;
    use crate::services::stream_resources::StreamFrame;
    const POST_HEADER_DEADLINE_WAIT: Duration = Duration::from_millis(50);
    let transport = Arc::new(StreamingTransport {
      events: vec![ProviderHttpStreamEvent::Started {
        status: 200,
        headers: HashMap::new(),
      }],
      chunk_delay: Duration::ZERO,
      stall_after_events: true,
    });
    let deadline = Some(Instant::now() + POST_HEADER_DEADLINE_WAIT);
    let (principal, mut table, reader_id) = fetch_and_adopt_stream(
      transport,
      authorization(NetworkResponseBodyMode::Stream),
      CancelToken::new(),
      deadline,
    )
    .await;
    let frame = tokio::time::timeout(Duration::from_secs(5), table.receive(reader_id, &principal, None, None))
      .await
      .expect("receive must not hang")
      .expect("recv ok")
      .expect("terminal frame");
    match frame {
      StreamFrame::Terminal(StreamTerminalState::Failed(code)) => {
        assert!(code.contains("deadline"), "expected deadline failure, got {code}");
      }
      other => panic!("expected deadline terminal, got {other:?}"),
    }
    table.reader_close(reader_id, &principal).await.ok();
  }

  /// Idle timeout: a stalled upstream (no chunks after Started) is failed by the pump's idle
  /// timer. Uses paused time so the 30s idle bound does not delay the test.
  #[tokio::test(start_paused = true)]
  async fn stream_idle_timeout_fails_writer() {
    use crate::domain::plugin_resource::StreamTerminalState;
    use crate::services::stream_resources::StreamFrame;
    let transport = Arc::new(StreamingTransport {
      events: vec![ProviderHttpStreamEvent::Started {
        status: 200,
        headers: HashMap::new(),
      }],
      chunk_delay: Duration::ZERO,
      stall_after_events: true,
    });
    let (principal, mut table, reader_id) = fetch_and_adopt_stream(
      transport,
      authorization(NetworkResponseBodyMode::Stream),
      CancelToken::new(),
      None,
    )
    .await;
    // Under paused time, the runtime auto-advances to the pump's idle deadline (mock 30s) when
    // the upstream stalls, so the receive completes in real time without a real 30s wait.
    let frame = table
      .receive(reader_id, &principal, None, None)
      .await
      .expect("receive must complete")
      .expect("terminal frame");
    match frame {
      StreamFrame::Terminal(StreamTerminalState::Failed(code)) => {
        assert!(code.contains("idle"), "expected idle-timeout failure, got {code}");
      }
      other => panic!("expected idle-timeout terminal, got {other:?}"),
    }
    table.reader_close(reader_id, &principal).await.ok();
  }
}
