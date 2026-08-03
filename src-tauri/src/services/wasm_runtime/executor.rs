// ABOUTME: Typed Component execution: load (with compiled-artifact cache), instantiate
// ABOUTME: per-request, call Translate/Detect exports asynchronously, validate bounds.
// Never auto-retries through Bundled Rust after guest execution starts.
use crate::domain::cancel::CancelToken;
use crate::domain::runtime_plugin::{ComponentArtifactDigest, ExecutionGrantSet, PackageDigest, PluginPrincipal};
use crate::domain::runtime_provider::{
  LLM_CHAT_COMPLETE_MESSAGE_MAX_BYTES, LLM_CHAT_DELTA_REASONING_MAX_BYTES, LLM_CHAT_DELTA_TEXT_MAX_BYTES,
  LLM_CHAT_IMAGE_MAX_BYTES, LLM_CHAT_IMAGES_MAX_COUNT, LLM_CHAT_MAX_FRAMES, LLM_CHAT_MESSAGE_CONTENT_MAX_BYTES,
  LLM_CHAT_MESSAGES_MAX_COUNT, LLM_CHAT_MODEL_MAX_BYTES, LLM_CHAT_ROLE_MAX_BYTES, LLM_CHAT_TOOL_ARGUMENTS_MAX_BYTES,
  LLM_CHAT_TOOL_ID_MAX_BYTES, LLM_CHAT_TOOL_NAME_MAX_BYTES, LLM_CHAT_TOTAL_OUTPUT_MAX_BYTES, LlmChatCompleteResult,
  LlmChatRequest, LlmChatResult, LlmModelDescriptor, LlmModelsListResult, ProviderRuntimeChatEvent,
};
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, DetectLanguageRequest, DetectLanguageResponse, ExecutionContext,
  OcrImageRequest, OcrImageResponse, ProviderAttemptTracker, SPEECH_AUDIO_MAX_BYTES, SpeechSynthesizeRequest,
  SpeechSynthesizeResponse, TranslateTextRequest, TranslateTextResponse, validate_capability_language_id,
  validate_capability_request_id, validate_capability_text, validate_ocr_png_bounds, validate_speech_synthesize_text,
};
use crate::services::service_capabilities::{
  DetectLanguageCapability, OcrImageCapability, SpeechSynthesizeCapability, TranslateTextCapability,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use uuid::Uuid;
use wasmtime::component::{Component, HasSelf};

use super::bindings::llm_models;
use super::bindings::translate_text;
use super::cache::{CACHE_HOST_API_VERSION, CompiledComponentCache, component_cache_identity};
use super::engine::{WasmEngine, host_target_triple};
use super::errors::{map_instantiate_error, map_wasmtime_error};
use super::host::BlobResource;
use super::host::BrokerHandle;
use super::host::StreamWriterResource;
use super::store::{
  EPOCH_TICK_INTERVAL, PluginHostState, build_store, new_state, new_state_with_fuel_and_provider_attempt,
  new_state_with_provider_attempt,
};
use crate::domain::plugin_resource::{
  LlmDelta, ResourceCreateParams, ResourceDirection, ResourceError, ResourceId, ResourceOwner,
};
use crate::services::stream_resources::{LlmReaderBridge, StreamFrame};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::ImageReader;
use std::io::Cursor;

/// Re-export of the generated translate-text export-interface module for request/response types.
use translate_text::exports::langnext::runtime_plugin::translate_text as tt_export;

/// Bounded wall-clock time for a single guest invocation when no explicit deadline is supplied.
/// Host imports enforce their own per-call timeouts; this bounds the whole call.
pub const DEFAULT_INVOCATION_TIMEOUT: Duration = Duration::from_secs(20);
/// Speech synthesis may wait on provider audio generation longer than the default translate path.
pub const SPEECH_INVOCATION_TIMEOUT: Duration = Duration::from_secs(60);
/// Maximum UTF-8 bytes accepted in copied config JSON.
pub const CONFIG_MAX_BYTES: usize = 64 * 1024;
/// Maximum UTF-8 bytes accepted in copied preferences JSON.
pub const PREFERENCES_MAX_BYTES: usize = 64 * 1024;
/// Fuel for bounded binary payload guests whose base64/JSON work is larger than text calls.
pub const PAYLOAD_INVOCATION_FUEL: u64 = 100_000_000;

/// A Component that has passed package+artifact digest verification at compile time. Fields are
/// private so callers cannot construct one from a raw `Component` or mix digests. Execution APIs
/// accept only this type and re-check that the principal's package digest matches before guest
/// work. The bare `Component` is never exposed to adapters or execution entry points.
#[derive(Clone)]
pub struct VerifiedComponent {
  package_digest: PackageDigest,
  artifact_digest: ComponentArtifactDigest,
  component: Component,
}

impl VerifiedComponent {
  /// Package archive digest this Component was verified under.
  pub fn package_digest(&self) -> &PackageDigest {
    &self.package_digest
  }

  /// Component file (runtime-artifact) digest this Component was verified under.
  pub fn artifact_digest(&self) -> &ComponentArtifactDigest {
    &self.artifact_digest
  }

  /// Borrow the verified Wasmtime Component for instantiation. Crate-private so external code
  /// cannot extract a bare Component for execution outside the verified path.
  pub(crate) fn component(&self) -> &Component {
    &self.component
  }
}

/// Shared Wasm runtime service. Owns the shared [`WasmEngine`], the compiled Component cache,
/// and a single shared epoch ticker. Each invocation creates a fresh `Store<PluginHostState>`;
/// the runtime is unreachable from production plugin instances until Phase 4 activation.
pub struct WasmRuntime {
  engine: WasmEngine,
  cache: CompiledComponentCache,
  epoch_ticker: EpochTicker,
  /// Test-only side effect invoked at the start of `compile_component` (simulates mid-compile races).
  #[cfg(test)]
  compile_side_effect: std::sync::Mutex<Option<Box<dyn FnMut() + Send>>>,
  /// Test-only request cleanup observer; production execution has no observer state.
  #[cfg(test)]
  cleanup_probe: Mutex<Option<Arc<AtomicBool>>>,
  /// Test-only stream-endpoint cleanup observer (set before the store-drop table clear).
  #[cfg(test)]
  streams_cleanup_probe: Mutex<Option<Arc<AtomicBool>>>,
}

impl WasmRuntime {
  /// Build the runtime with the Phase 2 engine configuration, a bounded compiled Component
  /// cache, and a single shared epoch ticker. The ticker runs on a dedicated OS thread so it
  /// is reliable in any construction path (sync `AppState` init or async Tokio context); it
  /// never silently degrades to "no ticker". Dropping the runtime stops and joins the ticker.
  pub fn new() -> wasmtime::Result<Self> {
    let engine = WasmEngine::new()?;
    let epoch_ticker = EpochTicker::spawn(engine.engine().clone())
      .map_err(|e| wasmtime::Error::msg(format!("epoch ticker thread spawn failed: {e}")))?;
    Ok(Self {
      engine,
      cache: CompiledComponentCache::default(),
      epoch_ticker,
      #[cfg(test)]
      compile_side_effect: std::sync::Mutex::new(None),
      #[cfg(test)]
      cleanup_probe: Mutex::new(None),
      #[cfg(test)]
      streams_cleanup_probe: Mutex::new(None),
    })
  }

  /// Install a request cleanup observer for host-resource lifecycle assertions.
  #[cfg(test)]
  pub fn set_cleanup_probe(&self, probe: Arc<AtomicBool>) {
    *self.cleanup_probe.lock().unwrap_or_else(|error| error.into_inner()) = Some(probe);
  }

  /// Install a stream-endpoint cleanup observer for host-resource lifecycle assertions.
  #[cfg(test)]
  pub fn set_streams_cleanup_probe(&self, probe: Arc<AtomicBool>) {
    *self
      .streams_cleanup_probe
      .lock()
      .unwrap_or_else(|error| error.into_inner()) = Some(probe);
  }

  #[cfg(test)]
  fn attach_cleanup_probe(&self, mut state: PluginHostState) -> PluginHostState {
    state.cleanup_probe = self
      .cleanup_probe
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .clone();
    state.streams_cleanup_probe = self
      .streams_cleanup_probe
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .clone();
    state
  }

  /// Install a one-shot side effect that runs at the start of the next `compile_component` call.
  #[cfg(test)]
  pub fn set_compile_side_effect(&self, hook: impl FnMut() + Send + 'static) {
    *self.compile_side_effect.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(hook));
  }

  pub fn engine(&self) -> &WasmEngine {
    &self.engine
  }

  /// Host target triple, exposed for cache identity callers.
  pub fn host_target_triple(&self) -> String {
    host_target_triple()
  }

  /// The engine configuration revision, exposed for cache identity callers.
  pub fn config_revision(&self) -> u64 {
    self.engine.config_revision()
  }

  /// Invalidate compiled Component cache entries after a runtime pin change.
  /// Package digests participate in cache identity; clearing is the safe CAS post-commit action.
  pub fn invalidate_package_digests(&self, _package_digests: Vec<&str>) {
    self.cache.clear();
  }

  /// Compile a Component from raw bytes under a package archive digest and a Component artifact
  /// digest. **Bytes are verified only against the artifact digest** ([`ComponentArtifactDigest`]):
  /// [`PackageDigest`] identifies the signed `.lnplugin` archive and must never be used as a
  /// Component file hash. Both digests participate in the cache key so same-package different
  /// artifacts never collide. Returns a [`VerifiedComponent`] whose private digests are re-checked
  /// against the principal at execution time. Compilation failures are not cached.
  pub fn compile_component(
    &self,
    package_digest: &PackageDigest,
    artifact_digest: &ComponentArtifactDigest,
    bytes: &[u8],
  ) -> wasmtime::Result<VerifiedComponent> {
    #[cfg(test)]
    if let Some(mut hook) = self
      .compile_side_effect
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take()
    {
      hook();
    }
    // Security chokepoint: verify the Component file bytes hash to the artifact digest before
    // any cache use. Package digest is archive identity only and is never compared to bytes.
    let computed = compute_sha256_hex(bytes);
    if computed != artifact_digest.as_str() {
      return Err(wasmtime::Error::msg(format!(
        "component artifact digest mismatch: supplied {} but bytes hash to {computed}",
        artifact_digest.as_str()
      )));
    }
    let identity = component_cache_identity(
      package_digest,
      artifact_digest,
      CACHE_HOST_API_VERSION,
      super::engine::WASMTIME_VERSION,
      self.engine.config_revision(),
      &host_target_triple(),
    );
    if let Some(serialized) = self.cache.lookup(&identity) {
      // Safety: the serialized artifact was produced by `Component::serialize` on an engine
      // with the same configuration (the identity keys on Wasmtime version, config revision,
      // and target triple). We only insert our own compiled output, so the bytes are trusted.
      let component = unsafe { Component::deserialize(self.engine.engine(), &serialized)? };
      return Ok(VerifiedComponent {
        package_digest: package_digest.clone(),
        artifact_digest: artifact_digest.clone(),
        component,
      });
    }
    let component = Component::new(self.engine.engine(), bytes)?;
    match component.serialize() {
      Ok(serialized) => self.cache.insert(identity, serialized),
      Err(_) => {
        // Serialization failure is non-fatal: the component is usable, just not cached.
      }
    }
    Ok(VerifiedComponent {
      package_digest: package_digest.clone(),
      artifact_digest: artifact_digest.clone(),
      component,
    })
  }

  /// Verify a compiled artifact's WIT world shape without executing it: the component must
  /// import only `langnext:runtime-plugin/*` interfaces and export exactly the declared LLM
  /// world interface (never the other LLM world). Used by the provider runtime catalog before
  /// any lifecycle action; execution remains a separate authorization step.
  pub fn verify_artifact_world(
    &self,
    package_digest: &PackageDigest,
    artifact_digest: &ComponentArtifactDigest,
    bytes: &[u8],
    world: &str,
  ) -> wasmtime::Result<()> {
    const LLM_MODELS_INTERFACE: &str = "langnext:runtime-plugin/llm-models";
    const LLM_CHAT_INTERFACE: &str = "langnext:runtime-plugin/llm-chat";
    let (expected_interface, forbidden_interface) = match world {
      "llm-models-world" => (LLM_MODELS_INTERFACE, LLM_CHAT_INTERFACE),
      "llm-chat-world" => (LLM_CHAT_INTERFACE, LLM_MODELS_INTERFACE),
      other => return Err(wasmtime::Error::msg(format!("unsupported LLM world {other}"))),
    };
    let verified = self.compile_component(package_digest, artifact_digest, bytes)?;
    let component_type = verified.component().component_type();
    let engine = self.engine().engine();
    for (name, _) in component_type.imports(engine) {
      if !name.starts_with("langnext:runtime-plugin/") {
        return Err(wasmtime::Error::msg(format!(
          "{world} artifact imports non-langnext interface {name}"
        )));
      }
    }
    let mut found_expected = false;
    for (name, _) in component_type.exports(engine) {
      if name.starts_with(forbidden_interface) {
        return Err(wasmtime::Error::msg(format!(
          "{world} artifact exports {name}; one artifact must instantiate exactly one LLM world"
        )));
      }
      if name.starts_with(expected_interface) {
        found_expected = true;
      }
    }
    if !found_expected {
      return Err(wasmtime::Error::msg(format!(
        "artifact does not instantiate the declared {world} (missing {expected_interface} export)"
      )));
    }
    Ok(())
  }

  /// Execute `llm.models.list@1` against a [`VerifiedComponent`]. A verified package/artifact
  /// binding and a `ProviderInstance` grant subject are enforced before guest work; the ABI
  /// response is treated as ONE bounded aggregate list (no host pagination protocol). The
  /// host rejects over-limit counts, empty/oversized ids, oversized labels, and duplicate ids.
  pub async fn execute_llm_models_list(
    &self,
    verified: &VerifiedComponent,
    principal: PluginPrincipal,
    grant: ExecutionGrantSet,
    cancel: CancelToken,
    deadline: Option<Instant>,
    broker: Box<dyn BrokerHandle>,
    config: Vec<u8>,
  ) -> Result<LlmModelsListResult, CapabilityError> {
    use llm_models::exports::langnext::runtime_plugin::llm_models as lm_export;

    // Authorization at invocation start: package identity + principal↔grant before guest work.
    enforce_package_binding(&principal, verified)?;
    grant
      .grants_capability(&principal)
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::PermissionDenied, "principal not authorized"))?;
    validate_copied_json(&config, CONFIG_MAX_BYTES, "config")?;
    validate_capability_request_id(principal.request_id().as_str())?;
    let cancel = cancel.clone();
    let state = new_state(principal, grant, cancel.clone(), deadline, broker);
    let mut store = build_store(self.engine.engine(), state);
    let mut linker = wasmtime::component::Linker::new(self.engine.engine());
    llm_models::LlmModelsWorld::add_to_linker::<_, HasSelf<PluginHostState>>(&mut linker, |state| state)
      .map_err(map_instantiate_error)?;
    let world = llm_models::LlmModelsWorld::instantiate_async(&mut store, verified.component(), &linker)
      .await
      .map_err(map_instantiate_error)?;
    let guest = world.langnext_runtime_plugin_llm_models();
    let wit_request = lm_export::ModelsListRequest {
      request_id: store.data().principal.request_id().as_str().to_string(),
    };
    let call_result = run_with_interruption(
      deadline,
      cancel,
      guest.call_models_list(&mut store, &config, &wit_request),
      None,
      DEFAULT_INVOCATION_TIMEOUT,
    )
    .await;
    match call_result {
      Ok(Ok(response)) => {
        validate_llm_model_descriptors(&response.models)?;
        Ok(LlmModelsListResult {
          models: response
            .models
            .into_iter()
            .map(|model| LlmModelDescriptor {
              id: model.id,
              label: model.label,
            })
            .collect(),
        })
      }
      Ok(Err(plugin_error)) => Err(map_llm_models_plugin_error(plugin_error)),
      Err(capability_error) => Err(capability_error),
    }
  }

  /// Execute `llm.chat@1` against a [`VerifiedComponent`]. The host always creates the required
  /// `llm-delta` writer/reader pair before the WIT call and transfers only the writer to the
  /// guest. For `stream = false` the guest deterministically returns a complete message and the
  /// host retains/discards the reader; for `stream = true` the host drains the paired reader
  /// concurrently (typed delta bridge) and requires a streaming result. Input images become
  /// host-owned Blobs; image bytes never cross WIT semantic fields, logs, DTOs, or errors.
  #[allow(clippy::too_many_arguments)]
  pub async fn execute_llm_chat(
    &self,
    verified: &VerifiedComponent,
    principal: PluginPrincipal,
    grant: ExecutionGrantSet,
    cancel: CancelToken,
    deadline: Option<Instant>,
    broker: Box<dyn BrokerHandle>,
    config: Vec<u8>,
    request: LlmChatRequest,
    on_event: Option<Box<dyn Fn(ProviderRuntimeChatEvent) -> Result<(), CapabilityError> + Send>>,
  ) -> Result<LlmChatResult, CapabilityError> {
    use super::bindings::llm_chat;
    use llm_chat::exports::langnext::runtime_plugin::llm_chat as lc_export;

    // Authorization at invocation start: package identity + principal↔grant before guest work.
    enforce_package_binding(&principal, verified)?;
    grant
      .grants_capability(&principal)
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::PermissionDenied, "principal not authorized"))?;
    validate_copied_json(&config, CONFIG_MAX_BYTES, "config")?;
    validate_llm_chat_request(&request)?;
    let preferences = serde_json::to_vec(&request.preferences)
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::InvalidRequest, "preferences must be valid JSON"))?;
    validate_copied_json(&preferences, PREFERENCES_MAX_BYTES, "preferences")?;
    // Re-parse the copied envelope so a tampered/unknown field is rejected fail-closed.
    let parsed: crate::domain::runtime_provider::LlmChatPreferencesV1 = serde_json::from_slice(&preferences)
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::InvalidRequest, "preferences envelope is invalid"))?;
    if parsed.stream != request.preferences.stream {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        "preferences envelope changed during serialization",
      ));
    }
    if request.preferences.stream && on_event.is_none() {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        "streaming chat requires an event sink",
      ));
    }

    let cancel = cancel.clone();
    let state = new_state_with_fuel_and_provider_attempt(
      principal,
      grant,
      cancel.clone(),
      deadline,
      broker,
      PAYLOAD_INVOCATION_FUEL,
      None,
    );
    #[cfg(test)]
    let state = self.attach_cleanup_probe(state);
    let mut store = build_store(self.engine.engine(), state);
    let request_principal = store.data().principal.clone();

    // Host-owned llm-delta pair created BEFORE the WIT call; only the writer crosses to the guest.
    // The writer-side total cap mirrors the host's total-output bound; per-delta/frame-count
    // bounds are enforced by the reader-side bridge before a delta is forwarded.
    let (writer_id, reader_id) = store
      .data_mut()
      .streams
      .create(
        ResourceCreateParams {
          owner: ResourceOwner::from_principal(&request_principal),
          direction: ResourceDirection::Output,
          content_type: None,
          max_bytes: LLM_CHAT_TOTAL_OUTPUT_MAX_BYTES as u64,
          expires_at: None,
          cancel: cancel.clone(),
        },
        crate::domain::plugin_resource::StreamKind::LlmDelta,
        None,
      )
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to create chat stream pair"))?;

    // Convert input PNGs to host-owned Blobs; WIT receives only borrowed blob handles.
    let mut image_handles = Vec::with_capacity(request.images.len());
    for image_bytes in &request.images {
      let blob_id = store
        .data_mut()
        .blobs
        .create_with_bytes(
          ResourceCreateParams {
            owner: ResourceOwner::from_principal(&request_principal),
            direction: ResourceDirection::Input,
            content_type: Some("image/png".into()),
            max_bytes: image_bytes.len().max(1) as u64,
            expires_at: None,
            cancel: cancel.clone(),
          },
          image_bytes.clone(),
        )
        .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to create chat image blob"))?;
      image_handles.push(
        store
          .data_mut()
          .table
          .push(BlobResource { id: blob_id })
          .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to bind chat image blob"))?,
      );
    }
    let writer_handle = store
      .data_mut()
      .table
      .push(StreamWriterResource { id: writer_id })
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to bind chat stream writer"))?;

    // Streaming: detach the reader into a bridge and drain it concurrently with the guest call.
    let reader_bridge = if request.preferences.stream {
      Some(
        store
          .data_mut()
          .streams
          .detach_reader(reader_id)
          .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to detach chat stream reader"))?,
      )
    } else {
      None
    };
    let reader_task = match &reader_bridge {
      Some(bridge) => {
        let bridge = bridge.clone();
        let task_principal = request_principal.clone();
        let task_cancel = cancel.clone();
        let task_deadline = deadline;
        let on_event = on_event.expect("streaming chat requires an event sink");
        Some(tokio::spawn(async move {
          let mut total_bytes: usize = 0;
          let mut frame_count: usize = 0;
          let result: Result<(), CapabilityError> = loop {
            match bridge.receive(&task_principal, task_deadline, Some(&task_cancel)).await {
              Ok(Some(StreamFrame::LlmDelta(delta))) => {
                frame_count += 1;
                if frame_count > LLM_CHAT_MAX_FRAMES {
                  break Err(CapabilityError::new(
                    CapabilityErrorCode::InvalidResponse,
                    format!("chat stream exceeds {LLM_CHAT_MAX_FRAMES} frames"),
                  ));
                }
                let (event, event_bytes) = llm_delta_to_event(delta)?;
                total_bytes = total_bytes.saturating_add(event_bytes);
                if total_bytes > LLM_CHAT_TOTAL_OUTPUT_MAX_BYTES {
                  break Err(CapabilityError::new(
                    CapabilityErrorCode::InvalidResponse,
                    format!("chat stream exceeds {LLM_CHAT_TOTAL_OUTPUT_MAX_BYTES} total output bytes"),
                  ));
                }
                if let Err(error) = on_event(event) {
                  break Err(error);
                }
              }
              Ok(Some(StreamFrame::Terminal(_))) => break Ok(()),
              // A table kind mismatch is impossible for an llm-delta pair; fail closed anyway.
              Ok(Some(StreamFrame::NetworkBinary(_))) => {
                break Err(CapabilityError::new(
                  CapabilityErrorCode::InvalidResponse,
                  "chat stream carried a binary frame",
                ));
              }
              Ok(None) => {
                break Err(CapabilityError::new(
                  CapabilityErrorCode::Internal,
                  "chat stream reader closed without a terminal frame",
                ));
              }
              Err(ResourceError::Cancelled) | Err(ResourceError::Closed) => break Ok(()),
              Err(other) => {
                break Err(CapabilityError::new(
                  CapabilityErrorCode::Internal,
                  format!("chat stream read failed: {other:?}"),
                ));
              }
            }
          };
          // A bridge failure (bounds breach, terminal read error) must wake a blocked guest
          // writer instead of leaving it parked under backpressure until the invocation
          // timeout: force-cancel the pair so the writer observes `Cancelled` and returns a
          // stable plugin error. Idempotent when the guest already finished/discarded.
          if result.is_err() {
            bridge.discard().await;
          }
          result
        }))
      }
      None => None,
    };

    let mut linker = wasmtime::component::Linker::new(self.engine.engine());
    llm_chat::LlmChatWorld::add_to_linker::<_, HasSelf<PluginHostState>>(&mut linker, |state| state)
      .map_err(map_instantiate_error)?;
    let world = llm_chat::LlmChatWorld::instantiate_async(&mut store, verified.component(), &linker)
      .await
      .map_err(map_instantiate_error)?;
    let guest = world.langnext_runtime_plugin_llm_chat();
    let wit_request = lc_export::ChatRequest {
      request_id: store.data().principal.request_id().as_str().to_string(),
      model: request.model,
      messages: request
        .messages
        .into_iter()
        .map(|message| lc_export::ChatMessage {
          role: message.role,
          content: message.content,
        })
        .collect(),
      images: image_handles,
      preferences: preferences.clone(),
    };
    let call_result = run_with_interruption(
      deadline,
      cancel.clone(),
      guest.call_chat(&mut store, &config, &wit_request, writer_handle),
      None,
      DEFAULT_INVOCATION_TIMEOUT,
    )
    .await;

    let outcome = match call_result {
      Ok(Ok(lc_export::ChatResult::Complete(response))) => {
        if request.preferences.stream {
          return finish_chat_with_cleanup(
            store,
            reader_bridge,
            reader_task,
            reader_id,
            writer_id,
            Err(CapabilityError::new(
              CapabilityErrorCode::InvalidResponse,
              "guest returned a complete result under a streaming preference",
            )),
          )
          .await;
        }
        let content_len = response.message.content.len();
        let role_len = response.message.role.len();
        if content_len > LLM_CHAT_COMPLETE_MESSAGE_MAX_BYTES || role_len > LLM_CHAT_ROLE_MAX_BYTES {
          return finish_chat_with_cleanup(
            store,
            reader_bridge,
            reader_task,
            reader_id,
            writer_id,
            Err(CapabilityError::new(
              CapabilityErrorCode::InvalidResponse,
              "chat complete message exceeds host response bound",
            )),
          )
          .await;
        }
        finish_chat_with_cleanup(
          store,
          reader_bridge,
          reader_task,
          reader_id,
          writer_id,
          Ok(LlmChatResult::Complete(LlmChatCompleteResult {
            role: response.message.role,
            content: response.message.content,
          })),
        )
        .await
      }
      Ok(Ok(lc_export::ChatResult::Streaming)) => {
        if !request.preferences.stream {
          return finish_chat_with_cleanup(
            store,
            reader_bridge,
            reader_task,
            reader_id,
            writer_id,
            Err(CapabilityError::new(
              CapabilityErrorCode::InvalidResponse,
              "guest streamed under a non-stream preference",
            )),
          )
          .await;
        }
        finish_chat_with_cleanup(
          store,
          reader_bridge,
          reader_task,
          reader_id,
          writer_id,
          Ok(LlmChatResult::Streaming),
        )
        .await
      }
      Ok(Err(plugin_error)) => {
        finish_chat_with_cleanup(
          store,
          reader_bridge,
          reader_task,
          reader_id,
          writer_id,
          Err(map_llm_chat_plugin_error(plugin_error)),
        )
        .await
      }
      Err(capability_error) => {
        finish_chat_with_cleanup(
          store,
          reader_bridge,
          reader_task,
          reader_id,
          writer_id,
          Err(capability_error),
        )
        .await
      }
    };
    outcome
  }

  /// Execute `translate.text@1` against a [`VerifiedComponent`]. A fresh store is created for this
  /// request; the guest never receives credentials or unrestricted network access. Guest failures
  /// map to stable `CapabilityError` codes without leaking stack traces, user content, or paths.
  /// Enforces `principal.package_digest == verified.package_digest` and rejects Wasm package
  /// principals that lack a package digest.
  pub async fn execute_translate_text(
    &self,
    verified: &VerifiedComponent,
    principal: PluginPrincipal,
    grant: ExecutionGrantSet,
    cancel: CancelToken,
    deadline: Option<Instant>,
    broker: Box<dyn BrokerHandle>,
    config: Vec<u8>,
    preferences: Vec<u8>,
    request: TranslateTextRequest,
  ) -> Result<TranslateTextResponse, CapabilityError> {
    self
      .execute_translate_text_with_attempt(
        verified,
        principal,
        grant,
        cancel,
        deadline,
        broker,
        config,
        preferences,
        request,
        None,
      )
      .await
  }

  pub async fn execute_translate_text_with_attempt(
    &self,
    verified: &VerifiedComponent,
    principal: PluginPrincipal,
    grant: ExecutionGrantSet,
    cancel: CancelToken,
    deadline: Option<Instant>,
    broker: Box<dyn BrokerHandle>,
    config: Vec<u8>,
    preferences: Vec<u8>,
    request: TranslateTextRequest,
    provider_attempt: Option<ProviderAttemptTracker>,
  ) -> Result<TranslateTextResponse, CapabilityError> {
    // Authorization at invocation start: package identity + principal↔grant before guest work.
    enforce_package_binding(&principal, verified)?;
    grant
      .grants_capability(&principal)
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::PermissionDenied, "principal not authorized"))?;
    validate_copied_json(&config, CONFIG_MAX_BYTES, "config")?;
    validate_copied_json(&preferences, PREFERENCES_MAX_BYTES, "preferences")?;
    validate_translate_text_request(principal.request_id().as_str(), &request)?;
    let cancel = cancel.clone();
    let state = new_state_with_provider_attempt(principal, grant, cancel.clone(), deadline, broker, provider_attempt);
    let mut store = build_store(self.engine.engine(), state);
    let mut linker = wasmtime::component::Linker::new(self.engine.engine());
    translate_text::TranslateTextWorld::add_to_linker::<_, HasSelf<PluginHostState>>(&mut linker, |state| state)
      .map_err(map_instantiate_error)?;

    let world = translate_text::TranslateTextWorld::instantiate_async(&mut store, verified.component(), &linker)
      .await
      .map_err(map_instantiate_error)?;
    let guest = world.langnext_runtime_plugin_translate_text();

    let wit_request = tt_export::TextRequest {
      request_id: store.data().principal.request_id().as_str().to_string(),
      text: request.text,
      source_language_id: request.source_language_id,
      target_language_id: request.target_language_id,
    };

    let provider_attempt = store.data().provider_attempt.clone();
    let call_result = run_with_interruption(
      deadline,
      cancel,
      guest.call_text(&mut store, &config, &preferences, &wit_request),
      provider_attempt,
      DEFAULT_INVOCATION_TIMEOUT,
    )
    .await;

    match call_result {
      Ok(Ok(response)) => {
        let detected = response.detected_source_language_id;
        if let Some(lang) = detected.as_deref() {
          validate_capability_language_id(lang, "detected_source_language_id")?;
        }
        if response.translated_text.len() > crate::domain::service_capability::CAPABILITY_TEXT_MAX_BYTES {
          return Err(CapabilityError::new(
            CapabilityErrorCode::InvalidResponse,
            "translated text exceeds host response bound",
          ));
        }
        Ok(TranslateTextResponse {
          translated_text: response.translated_text,
          detected_source_language_id: detected,
        })
      }
      Ok(Err(plugin_error)) => Err(map_translate_text_plugin_error(plugin_error)),
      Err(capability_error) => Err(capability_error),
    }
  }

  /// Execute `translate.detect@1` against a [`VerifiedComponent`]. Mirrors `execute_translate_text`
  /// for the detect capability: package binding, fresh store, grant-authorized broker, sanitized
  /// error mapping.
  pub async fn execute_translate_detect(
    &self,
    verified: &VerifiedComponent,
    principal: PluginPrincipal,
    grant: ExecutionGrantSet,
    cancel: CancelToken,
    deadline: Option<Instant>,
    broker: Box<dyn BrokerHandle>,
    config: Vec<u8>,
    preferences: Vec<u8>,
    request: DetectLanguageRequest,
  ) -> Result<DetectLanguageResponse, CapabilityError> {
    self
      .execute_translate_detect_with_attempt(
        verified,
        principal,
        grant,
        cancel,
        deadline,
        broker,
        config,
        preferences,
        request,
        None,
      )
      .await
  }

  pub async fn execute_translate_detect_with_attempt(
    &self,
    verified: &VerifiedComponent,
    principal: PluginPrincipal,
    grant: ExecutionGrantSet,
    cancel: CancelToken,
    deadline: Option<Instant>,
    broker: Box<dyn BrokerHandle>,
    config: Vec<u8>,
    preferences: Vec<u8>,
    request: DetectLanguageRequest,
    provider_attempt: Option<ProviderAttemptTracker>,
  ) -> Result<DetectLanguageResponse, CapabilityError> {
    use super::bindings::translate_detect;
    use translate_detect::exports::langnext::runtime_plugin::translate_detect as td_export;
    // Authorization at invocation start: package identity + principal↔grant.
    enforce_package_binding(&principal, verified)?;
    grant
      .grants_capability(&principal)
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::PermissionDenied, "principal not authorized"))?;
    validate_copied_json(&config, CONFIG_MAX_BYTES, "config")?;
    validate_copied_json(&preferences, PREFERENCES_MAX_BYTES, "preferences")?;
    validate_capability_request_id(principal.request_id().as_str())?;
    validate_capability_text(&request.text)?;
    let cancel = cancel.clone();
    let state = new_state_with_provider_attempt(principal, grant, cancel.clone(), deadline, broker, provider_attempt);
    let mut store = build_store(self.engine.engine(), state);
    let mut linker = wasmtime::component::Linker::new(self.engine.engine());
    translate_detect::TranslateDetectWorld::add_to_linker::<_, HasSelf<PluginHostState>>(&mut linker, |state| state)
      .map_err(map_instantiate_error)?;
    let world = translate_detect::TranslateDetectWorld::instantiate_async(&mut store, verified.component(), &linker)
      .await
      .map_err(map_instantiate_error)?;
    let guest = world.langnext_runtime_plugin_translate_detect();
    let wit_request = td_export::DetectRequest {
      request_id: store.data().principal.request_id().as_str().to_string(),
      text: request.text,
    };
    let provider_attempt = store.data().provider_attempt.clone();
    let call_result = run_with_interruption(
      deadline,
      cancel,
      guest.call_detect(&mut store, &config, &preferences, &wit_request),
      provider_attempt,
      DEFAULT_INVOCATION_TIMEOUT,
    )
    .await;
    match call_result {
      Ok(Ok(response)) => {
        validate_capability_language_id(&response.language_id, "language_id")?;
        // Confidence must be finite and in 0..=1 when present.
        if let Some(confidence) = response.confidence {
          if !confidence.is_finite() || confidence < 0.0 || confidence > 1.0 {
            return Err(CapabilityError::new(
              CapabilityErrorCode::InvalidResponse,
              "detect confidence must be finite and in [0.0, 1.0]",
            ));
          }
        }
        Ok(DetectLanguageResponse {
          language_id: response.language_id,
          confidence: response.confidence,
        })
      }
      Ok(Err(plugin_error)) => Err(map_translate_detect_plugin_error(plugin_error)),
      Err(capability_error) => Err(capability_error),
    }
  }

  /// Execute `ocr.image@1` against a [`VerifiedComponent`]. The host decodes and validates the
  /// frontend base64 input, then transfers only an owned input BlobHandle into the guest.
  pub async fn execute_ocr_image(
    &self,
    verified: &VerifiedComponent,
    principal: PluginPrincipal,
    grant: ExecutionGrantSet,
    cancel: CancelToken,
    deadline: Option<Instant>,
    broker: Box<dyn BrokerHandle>,
    config: Vec<u8>,
    request: OcrImageRequest,
  ) -> Result<OcrImageResponse, CapabilityError> {
    self
      .execute_ocr_image_with_attempt(
        verified, principal, grant, cancel, deadline, broker, config, request, None,
      )
      .await
  }

  pub async fn execute_ocr_image_with_attempt(
    &self,
    verified: &VerifiedComponent,
    principal: PluginPrincipal,
    grant: ExecutionGrantSet,
    cancel: CancelToken,
    deadline: Option<Instant>,
    broker: Box<dyn BrokerHandle>,
    config: Vec<u8>,
    request: OcrImageRequest,
    provider_attempt: Option<ProviderAttemptTracker>,
  ) -> Result<OcrImageResponse, CapabilityError> {
    use super::bindings::ocr_image;
    use ocr_image::exports::langnext::runtime_plugin::ocr_image as oi_export;

    enforce_package_binding(&principal, verified)?;
    grant
      .grants_capability(&principal)
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::PermissionDenied, "principal not authorized"))?;
    validate_copied_json(&config, CONFIG_MAX_BYTES, "config")?;
    validate_capability_request_id(principal.request_id().as_str())?;
    crate::domain::service_capability::validate_ocr_image_preferences(&request.preferences)?;
    let input_bytes = decode_and_validate_ocr_png_bytes(&request.png_base64)?;

    let cancel = cancel.clone();
    let state = new_state_with_fuel_and_provider_attempt(
      principal,
      grant,
      cancel.clone(),
      deadline,
      broker,
      PAYLOAD_INVOCATION_FUEL,
      provider_attempt,
    );
    #[cfg(test)]
    let state = self.attach_cleanup_probe(state);
    let mut state = state;
    let input_id = state
      .blobs
      .create_with_bytes(
        ResourceCreateParams {
          owner: ResourceOwner::from_principal(&state.principal),
          direction: ResourceDirection::Input,
          content_type: Some("image/png".into()),
          max_bytes: input_bytes.len().max(1) as u64,
          expires_at: None,
          cancel: cancel.clone(),
        },
        input_bytes,
      )
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to create OCR input blob"))?;
    let mut store = build_store(self.engine.engine(), state);
    let input_handle = store
      .data_mut()
      .table
      .push(BlobResource { id: input_id })
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to bind OCR input blob"))?;
    let mut linker = wasmtime::component::Linker::new(self.engine.engine());
    ocr_image::OcrImageWorld::add_to_linker::<_, HasSelf<PluginHostState>>(&mut linker, |state| state)
      .map_err(map_instantiate_error)?;
    let world = ocr_image::OcrImageWorld::instantiate_async(&mut store, verified.component(), &linker)
      .await
      .map_err(map_instantiate_error)?;
    let guest = world.langnext_runtime_plugin_ocr_image();
    let wit_request = oi_export::ImageRequest {
      request_id: store.data().principal.request_id().as_str().to_string(),
      input: input_handle,
      preferences: oi_export::OcrPreferences {
        operation: Some(request.preferences.operation.as_str().to_string()),
        language_hints: request.preferences.language_hints,
      },
    };
    let provider_attempt = store.data().provider_attempt.clone();
    let call_result = run_with_interruption(
      deadline,
      cancel,
      guest.call_image(&mut store, &config, &wit_request),
      provider_attempt,
      DEFAULT_INVOCATION_TIMEOUT,
    )
    .await;
    // Dropping the request store releases the input blob on every success, guest error, trap,
    // cancellation, and limit path before the host returns to the workflow.
    drop(store);
    match call_result {
      Ok(Ok(response)) => {
        if response.text.len() > crate::domain::service_capability::CAPABILITY_TEXT_MAX_BYTES {
          return Err(CapabilityError::new(
            CapabilityErrorCode::InvalidResponse,
            "OCR response exceeds host response bound",
          ));
        }
        Ok(OcrImageResponse { text: response.text })
      }
      Ok(Err(plugin_error)) => Err(map_ocr_image_plugin_error(plugin_error)),
      Err(capability_error) => Err(capability_error),
    }
  }

  /// Execute `speech.synthesize@1` against a [`VerifiedComponent`]. Returns bounded MP3 bytes
  /// taken from the host-owned output blob; binary never crosses as base64.
  pub async fn execute_speech_synthesize(
    &self,
    verified: &VerifiedComponent,
    principal: PluginPrincipal,
    grant: ExecutionGrantSet,
    cancel: CancelToken,
    deadline: Option<Instant>,
    broker: Box<dyn BrokerHandle>,
    config: Vec<u8>,
    request: SpeechSynthesizeRequest,
  ) -> Result<SpeechSynthesizeResponse, CapabilityError> {
    self
      .execute_speech_synthesize_with_attempt(
        verified, principal, grant, cancel, deadline, broker, config, request, None,
      )
      .await
  }

  pub async fn execute_speech_synthesize_with_attempt(
    &self,
    verified: &VerifiedComponent,
    principal: PluginPrincipal,
    grant: ExecutionGrantSet,
    cancel: CancelToken,
    deadline: Option<Instant>,
    broker: Box<dyn BrokerHandle>,
    config: Vec<u8>,
    request: SpeechSynthesizeRequest,
    provider_attempt: Option<ProviderAttemptTracker>,
  ) -> Result<SpeechSynthesizeResponse, CapabilityError> {
    use super::bindings::speech_synthesize;
    use speech_synthesize::exports::langnext::runtime_plugin::speech_synthesize as ss_export;

    enforce_package_binding(&principal, verified)?;
    grant
      .grants_capability(&principal)
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::PermissionDenied, "principal not authorized"))?;
    validate_copied_json(&config, CONFIG_MAX_BYTES, "config")?;
    let preferences = serde_json::to_vec(&request.preferences)
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::InvalidRequest, "preferences must be valid JSON"))?;
    validate_copied_json(&preferences, PREFERENCES_MAX_BYTES, "preferences")?;
    validate_capability_request_id(principal.request_id().as_str())?;
    validate_speech_synthesize_text(&request.text)?;
    validate_capability_language_id(&request.language_id, "language_id")?;

    // Speech uses a longer wall bound than translate when no explicit deadline is set. The same
    // effective deadline must reach the host store so broker imports honor the 60-second grant.
    let speech_deadline = deadline.or_else(|| Some(Instant::now() + SPEECH_INVOCATION_TIMEOUT));
    let cancel = cancel.clone();
    let state = new_state_with_fuel_and_provider_attempt(
      principal,
      grant,
      cancel.clone(),
      speech_deadline,
      broker,
      PAYLOAD_INVOCATION_FUEL,
      provider_attempt,
    );
    #[cfg(test)]
    let state = self.attach_cleanup_probe(state);
    let mut store = build_store(self.engine.engine(), state);
    let mut linker = wasmtime::component::Linker::new(self.engine.engine());
    speech_synthesize::SpeechSynthesizeWorld::add_to_linker::<_, HasSelf<PluginHostState>>(&mut linker, |s| s)
      .map_err(map_instantiate_error)?;
    let world = speech_synthesize::SpeechSynthesizeWorld::instantiate_async(&mut store, verified.component(), &linker)
      .await
      .map_err(map_instantiate_error)?;
    let guest = world.langnext_runtime_plugin_speech_synthesize();
    let wit_request = ss_export::SynthesizeRequest {
      request_id: store.data().principal.request_id().as_str().to_string(),
      text: request.text,
      language_id: request.language_id,
      preferences,
    };

    let provider_attempt = store.data().provider_attempt.clone();
    let call_result = run_with_interruption(
      speech_deadline,
      cancel.clone(),
      guest.call_synthesize(&mut store, &config, &wit_request),
      provider_attempt,
      SPEECH_INVOCATION_TIMEOUT,
    )
    .await;

    match call_result {
      Ok(Ok(response)) => {
        // Take the owned blob handle from the guest response and drain bytes.
        let blob_resource = response.output;
        // Convert the component Resource to our host BlobResource via the table.
        // The generated type is Resource<BlobResource> owned by the guest return.
        let host_blob = store
          .data_mut()
          .table
          .get(&blob_resource)
          .map_err(|_| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "invalid output blob"))?
          .id;
        let principal = store.data().principal.clone();
        let mp3_bytes = store
          .data_mut()
          .blobs
          .take_bytes(host_blob, &principal)
          .map_err(|_| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "output blob unavailable"))?;
        // Drop the wasmtime resource entry.
        let _ = store.data_mut().table.delete(blob_resource);

        if mp3_bytes.is_empty() {
          return Err(CapabilityError::new(
            CapabilityErrorCode::InvalidResponse,
            "speech synthesis returned empty audio",
          ));
        }
        if mp3_bytes.len() > SPEECH_AUDIO_MAX_BYTES {
          return Err(CapabilityError::new(
            CapabilityErrorCode::InvalidResponse,
            "speech synthesis audio exceeds size limit",
          ));
        }
        // Provider contract validation: the response MUST carry a content type and it MUST be
        // `audio/mpeg` (with allowed parameters). MIME is metadata, but a missing header, a 200
        // JSON/text error body, or a near-miss MIME must not be accepted as MP3.
        let content_type = response.media.content_type.as_deref().ok_or_else(|| {
          CapabilityError::new(
            CapabilityErrorCode::InvalidResponse,
            "speech synthesis response is missing a content type",
          )
        })?;
        if !crate::domain::service_capability::is_valid_speech_audio_content_type(content_type) {
          return Err(CapabilityError::new(
            CapabilityErrorCode::InvalidResponse,
            "speech synthesis returned a non-audio/mpeg content type",
          ));
        }
        Ok(SpeechSynthesizeResponse { mp3_bytes })
      }
      Ok(Err(plugin_error)) => Err(map_speech_synthesize_plugin_error(plugin_error)),
      Err(capability_error) => Err(capability_error),
    }
  }

  /// Run pure migration-world `migrate-config` against copied JSON bytes only.
  pub async fn execute_migrate_config(
    &self,
    migration_component_bytes: &[u8],
    from_version: u32,
    to_version: u32,
    config: Vec<u8>,
  ) -> Result<Vec<u8>, CapabilityError> {
    validate_copied_json(&config, CONFIG_MAX_BYTES, "config")?;
    self
      .run_migration_export(migration_component_bytes, from_version, to_version, None, config)
      .await
  }

  /// Run pure migration-world `migrate-preferences` against copied preference JSON.
  pub async fn execute_migrate_preferences(
    &self,
    migration_component_bytes: &[u8],
    capability: &str,
    from_version: u32,
    to_version: u32,
    preferences: Vec<u8>,
  ) -> Result<Vec<u8>, CapabilityError> {
    validate_copied_json(&preferences, PREFERENCES_MAX_BYTES, "preferences")?;
    self
      .run_migration_export(
        migration_component_bytes,
        from_version,
        to_version,
        Some(capability),
        preferences,
      )
      .await
  }

  async fn run_migration_export(
    &self,
    migration_component_bytes: &[u8],
    from_version: u32,
    to_version: u32,
    capability: Option<&str>,
    payload: Vec<u8>,
  ) -> Result<Vec<u8>, CapabilityError> {
    use super::bindings::migration;
    use crate::domain::cancel::CancelToken;
    use crate::domain::runtime_plugin::{CapabilityId, ExecutionGrantSet, PluginId, RuntimeIdentity, SemVerVersion};
    use uuid::Uuid;
    use wasmtime::component::Component;

    let component = Component::new(self.engine.engine(), migration_component_bytes).map_err(map_instantiate_error)?;
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse("langnext.migration.dummy")
        .map_err(|e| CapabilityError::new(CapabilityErrorCode::Internal, e))?,
      SemVerVersion::parse("1.0.0").map_err(|e| CapabilityError::new(CapabilityErrorCode::Internal, e))?,
      vec![
        CapabilityId::parse("translate.text@1")
          .map_err(|e| CapabilityError::new(CapabilityErrorCode::Internal, format!("{e:?}")))?,
      ],
      vec![],
      vec![],
    )
    .map_err(|e| CapabilityError::new(CapabilityErrorCode::Internal, e.to_string()))?;
    let principal = grant
      .principal_for_request("translate.text@1", "migration-request")
      .map_err(|e| CapabilityError::new(CapabilityErrorCode::Internal, e.to_string()))?;
    let state = new_state(
      principal,
      grant,
      CancelToken::new(),
      None,
      Box::new(MigrationDeniedBroker),
    );
    let mut store = build_store(self.engine.engine(), state);
    let mut linker = wasmtime::component::Linker::new(self.engine.engine());
    migration::MigrationWorld::add_to_linker::<_, HasSelf<super::store::PluginHostState>>(&mut linker, |s| s)
      .map_err(map_instantiate_error)?;
    let world = migration::MigrationWorld::instantiate_async(&mut store, &component, &linker)
      .await
      .map_err(map_instantiate_error)?;
    let guest = world.langnext_runtime_plugin_migration();
    let call_result = if let Some(capability) = capability {
      guest
        .call_migrate_preferences(&mut store, capability, from_version, to_version, &payload)
        .await
    } else {
      guest
        .call_migrate_config(&mut store, from_version, to_version, &payload)
        .await
    };
    match call_result {
      Ok(Ok(bytes)) => {
        validate_copied_json(&bytes, CONFIG_MAX_BYTES, "migrated json")?;
        Ok(bytes)
      }
      Ok(Err(_plugin_error)) => Err(CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "migration component rejected the copied JSON",
      )),
      Err(err) => Err(map_instantiate_error(err)),
    }
  }
}

/// Maximum wall-clock wait for the LLM stream drain task to observe terminal/cancellation
/// before the host aborts it. Shorter than the stream backpressure wait so a stalled reader
/// never delays request cleanup beyond a bounded grace.
pub const LLM_CHAT_STREAM_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Release every request resource on every chat terminal path: stop the drain task (bounded),
/// discard the retained reader (unary) or bridge (streaming), drop the writer entry, and drop
/// the store. A reader/drain failure replaces a success outcome; the primary guest error is
/// kept when both failed. Never calls the legacy executor and never retries the request.
async fn finish_chat_with_cleanup(
  mut store: wasmtime::Store<PluginHostState>,
  reader_bridge: Option<LlmReaderBridge>,
  reader_task: Option<tokio::task::JoinHandle<Result<(), CapabilityError>>>,
  reader_id: ResourceId,
  writer_id: ResourceId,
  outcome: Result<LlmChatResult, CapabilityError>,
) -> Result<LlmChatResult, CapabilityError> {
  // 1. Wake a possibly-blocked drain task by force-terminating the pair, then join it bounded.
  let reader_error = if let Some(task) = reader_task {
    if let Some(bridge) = &reader_bridge {
      bridge.discard().await;
    }
    match tokio::time::timeout(LLM_CHAT_STREAM_DRAIN_TIMEOUT, task).await {
      Ok(Ok(Ok(()))) => None,
      Ok(Ok(Err(error))) => Some(error),
      Ok(Err(join_error)) => {
        log::warn!("chat stream drain task join failed: {join_error}");
        None
      }
      Err(_) => {
        log::warn!("chat stream drain task exceeded its shutdown timeout");
        None
      }
    }
  } else {
    None
  };
  // 2. Release the retained endpoints: the reader stays table-owned for unary chat, and the
  // writer entry is removed on every path (stream-finish may already have removed it).
  let principal = store.data().principal.clone();
  if reader_bridge.is_none() {
    store.data_mut().streams.reader_discard(reader_id, &principal).await;
  }
  store.data_mut().streams.writer_drop(writer_id).await;
  drop(store);
  match (outcome, reader_error) {
    (Ok(value), None) => Ok(value),
    (Ok(_), Some(error)) => Err(error),
    (Err(error), _) => Err(error),
  }
}

/// Map one typed LLM delta to a sanitized runtime event with per-delta bounds. Tool arguments
/// are copied JSON bytes and must be valid UTF-8; reasoning/tool deltas are never reparsed as
/// opaque text. Returns the event plus its counted output bytes.
fn llm_delta_to_event(delta: LlmDelta) -> Result<(ProviderRuntimeChatEvent, usize), CapabilityError> {
  match delta {
    LlmDelta::Text(text) => {
      if text.len() > LLM_CHAT_DELTA_TEXT_MAX_BYTES {
        return Err(CapabilityError::new(
          CapabilityErrorCode::InvalidResponse,
          format!("chat text delta exceeds {LLM_CHAT_DELTA_TEXT_MAX_BYTES} bytes"),
        ));
      }
      let bytes = text.len();
      Ok((ProviderRuntimeChatEvent::Text { text }, bytes))
    }
    LlmDelta::Reasoning(text) => {
      if text.len() > LLM_CHAT_DELTA_REASONING_MAX_BYTES {
        return Err(CapabilityError::new(
          CapabilityErrorCode::InvalidResponse,
          format!("chat reasoning delta exceeds {LLM_CHAT_DELTA_REASONING_MAX_BYTES} bytes"),
        ));
      }
      let bytes = text.len();
      Ok((ProviderRuntimeChatEvent::Reasoning { text }, bytes))
    }
    LlmDelta::ToolCall(tool) => {
      if tool.id.len() > LLM_CHAT_TOOL_ID_MAX_BYTES || tool.name.len() > LLM_CHAT_TOOL_NAME_MAX_BYTES {
        return Err(CapabilityError::new(
          CapabilityErrorCode::InvalidResponse,
          "chat tool-call id/name exceeds host bound",
        ));
      }
      let arguments = String::from_utf8(tool.arguments_json).map_err(|_| {
        CapabilityError::new(
          CapabilityErrorCode::InvalidResponse,
          "chat tool-call arguments are not valid UTF-8",
        )
      })?;
      if arguments.len() > LLM_CHAT_TOOL_ARGUMENTS_MAX_BYTES {
        return Err(CapabilityError::new(
          CapabilityErrorCode::InvalidResponse,
          format!("chat tool-call arguments exceed {LLM_CHAT_TOOL_ARGUMENTS_MAX_BYTES} bytes"),
        ));
      }
      let bytes = arguments
        .len()
        .saturating_add(tool.id.len())
        .saturating_add(tool.name.len());
      Ok((
        ProviderRuntimeChatEvent::ToolCall {
          id: tool.id,
          name: tool.name,
          arguments_json: arguments,
        },
        bytes,
      ))
    }
    LlmDelta::Complete(status) => Ok((
      ProviderRuntimeChatEvent::Complete {
        status: status.as_str().to_string(),
      },
      0,
    )),
  }
}

/// Validate bounded semantic chat inputs before guest execution. Image bytes are validated
/// only for count/size bounds; decoding stays with the provider protocol (host-owned Blob).
fn validate_llm_chat_request(request: &LlmChatRequest) -> Result<(), CapabilityError> {
  if request.model.is_empty() || request.model.len() > LLM_CHAT_MODEL_MAX_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("model id must be non-empty and at most {LLM_CHAT_MODEL_MAX_BYTES} bytes"),
    ));
  }
  if request.messages.is_empty() || request.messages.len() > LLM_CHAT_MESSAGES_MAX_COUNT {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("messages must be 1..={LLM_CHAT_MESSAGES_MAX_COUNT}"),
    ));
  }
  for message in &request.messages {
    if message.role.is_empty() || message.role.len() > LLM_CHAT_ROLE_MAX_BYTES {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        "message role is empty or exceeds host bound",
      ));
    }
    if message.content.len() > LLM_CHAT_MESSAGE_CONTENT_MAX_BYTES {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        format!("message content exceeds {LLM_CHAT_MESSAGE_CONTENT_MAX_BYTES} bytes"),
      ));
    }
  }
  if request.images.len() > LLM_CHAT_IMAGES_MAX_COUNT {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("images exceed {LLM_CHAT_IMAGES_MAX_COUNT}"),
    ));
  }
  for image in &request.images {
    if image.is_empty() || image.len() > LLM_CHAT_IMAGE_MAX_BYTES {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        "image is empty or exceeds host bound",
      ));
    }
  }
  request
    .preferences
    .validate()
    .map_err(|message| CapabilityError::new(CapabilityErrorCode::InvalidRequest, message))
}

/// Broker handle that always denies; migration world never calls host.broker.
struct MigrationDeniedBroker;

impl BrokerHandle for MigrationDeniedBroker {
  fn fetch(
    &self,
    _principal: &crate::domain::runtime_plugin::PluginPrincipal,
    _grant: &crate::domain::runtime_plugin::ExecutionGrantSet,
    _request: super::host::BrokerFetchRequest,
    _authorization: super::host::BrokerAuthorization,
    _cancel: &CancelToken,
    _deadline: Option<Instant>,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = super::host::BrokerFetchOutcome> + Send + '_>> {
    Box::pin(async { Err(super::host::BrokerFetchError::NotApproved) })
  }
}

impl Drop for WasmRuntime {
  fn drop(&mut self) {
    // `EpochTicker::drop` stops and joins the ticker thread; no manual abort needed.
  }
}

/// Adapter wrapping [`WasmRuntime`] to implement the [`TranslateTextCapability`] trait. Phase 2
/// uses this for conformance tests; Phase 4 registers production instances with a real grant/
/// broker factory. The adapter stores a [`VerifiedComponent`], grant (authority), and bound
/// capability id - NOT a principal. Each trait call derives a fresh per-request principal from
/// the `ExecutionContext` (Phase 0: a principal binds one request and is never reused). Every
/// context field (instance/plugin/capability/request) is validated against the grant; a mismatch
/// is `PermissionDenied`. The bare Component is never held.
pub struct WasmTranslateTextAdapter {
  runtime: Arc<WasmRuntime>,
  verified: Arc<VerifiedComponent>,
  grant: ExecutionGrantSet,
  capability_id: String,
  config: Vec<u8>,
  preferences: Vec<u8>,
  broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync>,
}

impl WasmTranslateTextAdapter {
  /// Construct an adapter bound to one verified component, grant, and broker factory. The
  /// `capability_id` must match the capability the component exports (e.g. `translate.text@1`)
  /// and must be granted by `grant`; each call re-derives a principal from the context.
  pub fn new(
    runtime: Arc<WasmRuntime>,
    verified: Arc<VerifiedComponent>,
    grant: ExecutionGrantSet,
    capability_id: impl Into<String>,
    config: Vec<u8>,
    preferences: Vec<u8>,
    broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync>,
  ) -> Self {
    Self {
      runtime,
      verified,
      grant,
      capability_id: capability_id.into(),
      config,
      preferences,
      broker_factory,
    }
  }
}

impl TranslateTextCapability for WasmTranslateTextAdapter {
  fn translate(
    &self,
    instance_id: Uuid,
    request: TranslateTextRequest,
    context: ExecutionContext,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<TranslateTextResponse, CapabilityError>> + Send + '_>>
  {
    let runtime = self.runtime.clone();
    let verified = self.verified.clone();
    let grant = self.grant.clone();
    let capability_id = self.capability_id.clone();
    let config = self.config.clone();
    let preferences = self.preferences.clone();
    let broker = (self.broker_factory)();
    Box::pin(async move {
      // Derive a fresh per-request principal from the context; validate every context field
      // against the bound grant. Wrong instance/plugin/capability/request -> PermissionDenied.
      let principal = principal_from_context(&grant, &capability_id, instance_id, &context)?;
      let cancel = context.cancel.clone();
      let deadline = context.deadline.map(|d| Instant::now() + d);
      runtime
        .execute_translate_text_with_attempt(
          &verified,
          principal,
          grant,
          cancel,
          deadline,
          broker,
          config,
          preferences,
          request,
          Some(context.provider_attempt.clone()),
        )
        .await
    })
  }
}

/// Adapter wrapping [`WasmRuntime`] to implement the [`DetectLanguageCapability`] trait. Mirrors
/// [`WasmTranslateTextAdapter`]: stores [`VerifiedComponent`] + grant + bound capability id,
/// derives a fresh principal per call, and denies wrong-context calls.
pub struct WasmDetectLanguageAdapter {
  runtime: Arc<WasmRuntime>,
  verified: Arc<VerifiedComponent>,
  grant: ExecutionGrantSet,
  capability_id: String,
  config: Vec<u8>,
  preferences: Vec<u8>,
  broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync>,
}

impl WasmDetectLanguageAdapter {
  /// Construct an adapter bound to one verified component, grant, and broker factory.
  pub fn new(
    runtime: Arc<WasmRuntime>,
    verified: Arc<VerifiedComponent>,
    grant: ExecutionGrantSet,
    capability_id: impl Into<String>,
    config: Vec<u8>,
    preferences: Vec<u8>,
    broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync>,
  ) -> Self {
    Self {
      runtime,
      verified,
      grant,
      capability_id: capability_id.into(),
      config,
      preferences,
      broker_factory,
    }
  }
}

impl DetectLanguageCapability for WasmDetectLanguageAdapter {
  fn detect(
    &self,
    instance_id: Uuid,
    request: DetectLanguageRequest,
    context: ExecutionContext,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<DetectLanguageResponse, CapabilityError>> + Send + '_>>
  {
    let runtime = self.runtime.clone();
    let verified = self.verified.clone();
    let grant = self.grant.clone();
    let capability_id = self.capability_id.clone();
    let config = self.config.clone();
    let preferences = self.preferences.clone();
    let broker = (self.broker_factory)();
    Box::pin(async move {
      let principal = principal_from_context(&grant, &capability_id, instance_id, &context)?;
      let cancel = context.cancel.clone();
      let deadline = context.deadline.map(|d| Instant::now() + d);
      runtime
        .execute_translate_detect_with_attempt(
          &verified,
          principal,
          grant,
          cancel,
          deadline,
          broker,
          config,
          preferences,
          request,
          Some(context.provider_attempt.clone()),
        )
        .await
    })
  }
}

/// Adapter wrapping [`WasmRuntime`] for `ocr.image@1`. The request's base64 is decoded only by
/// the host before it becomes an input BlobHandle.
pub struct WasmOcrImageAdapter {
  runtime: Arc<WasmRuntime>,
  verified: Arc<VerifiedComponent>,
  grant: ExecutionGrantSet,
  capability_id: String,
  config: Vec<u8>,
  broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync>,
}

impl WasmOcrImageAdapter {
  pub fn new(
    runtime: Arc<WasmRuntime>,
    verified: Arc<VerifiedComponent>,
    grant: ExecutionGrantSet,
    capability_id: impl Into<String>,
    config: Vec<u8>,
    broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync>,
  ) -> Self {
    Self {
      runtime,
      verified,
      grant,
      capability_id: capability_id.into(),
      config,
      broker_factory,
    }
  }
}

impl OcrImageCapability for WasmOcrImageAdapter {
  fn recognize(
    &self,
    instance_id: Uuid,
    request: OcrImageRequest,
    context: ExecutionContext,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<OcrImageResponse, CapabilityError>> + Send + '_>> {
    let runtime = self.runtime.clone();
    let verified = self.verified.clone();
    let grant = self.grant.clone();
    let capability_id = self.capability_id.clone();
    let config = self.config.clone();
    let broker = (self.broker_factory)();
    Box::pin(async move {
      let principal = principal_from_context(&grant, &capability_id, instance_id, &context)?;
      let cancel = context.cancel.clone();
      let deadline = context.deadline.map(|d| Instant::now() + d);
      runtime
        .execute_ocr_image_with_attempt(
          &verified,
          principal,
          grant,
          cancel,
          deadline,
          broker,
          config,
          request,
          Some(context.provider_attempt.clone()),
        )
        .await
    })
  }
}

/// Adapter wrapping [`WasmRuntime`] for `speech.synthesize@1`. Preferences ride on each request
/// (Speech service binding); config is the instance config JSON snapshot.
pub struct WasmSpeechSynthesizeAdapter {
  runtime: Arc<WasmRuntime>,
  verified: Arc<VerifiedComponent>,
  grant: ExecutionGrantSet,
  capability_id: String,
  config: Vec<u8>,
  broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync>,
}

impl WasmSpeechSynthesizeAdapter {
  pub fn new(
    runtime: Arc<WasmRuntime>,
    verified: Arc<VerifiedComponent>,
    grant: ExecutionGrantSet,
    capability_id: impl Into<String>,
    config: Vec<u8>,
    broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync>,
  ) -> Self {
    Self {
      runtime,
      verified,
      grant,
      capability_id: capability_id.into(),
      config,
      broker_factory,
    }
  }
}

impl SpeechSynthesizeCapability for WasmSpeechSynthesizeAdapter {
  fn synthesize(
    &self,
    instance_id: Uuid,
    request: SpeechSynthesizeRequest,
    context: ExecutionContext,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<SpeechSynthesizeResponse, CapabilityError>> + Send + '_>>
  {
    let runtime = self.runtime.clone();
    let verified = self.verified.clone();
    let grant = self.grant.clone();
    let capability_id = self.capability_id.clone();
    let config = self.config.clone();
    let broker = (self.broker_factory)();
    Box::pin(async move {
      let principal = principal_from_context(&grant, &capability_id, instance_id, &context)?;
      let cancel = context.cancel.clone();
      // Prefer an explicit context deadline; otherwise allow the speech wall bound.
      let deadline = context
        .deadline
        .map(|d| Instant::now() + d)
        .or_else(|| Some(Instant::now() + SPEECH_INVOCATION_TIMEOUT));
      runtime
        .execute_speech_synthesize_with_attempt(
          &verified,
          principal,
          grant,
          cancel,
          deadline,
          broker,
          config,
          request,
          Some(context.provider_attempt.clone()),
        )
        .await
    })
  }
}

/// Enforce that the principal is a package principal whose package digest matches the verified
/// Component. Wasm package execution requires a package digest: a Bundled principal (or any
/// principal without a package digest) is rejected, and a digest mismatch is denied. This is the
/// package-identity chokepoint so a package-A Component cannot execute under a package-B grant.
pub(crate) fn enforce_package_binding(
  principal: &PluginPrincipal,
  verified: &VerifiedComponent,
) -> Result<(), CapabilityError> {
  match principal.package_digest() {
    Some(digest) if digest == verified.package_digest() => Ok(()),
    Some(_) => Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "principal package digest does not match verified component",
    )),
    None => Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "wasm package principal requires a package digest",
    )),
  }
}

/// Derive a fresh per-request principal from the `ExecutionContext`, validating every field
/// against the bound grant. Phase 0 invariants: a principal binds a single request and is never
/// reused; the adapter stores only the grant (authority). Mismatches are `PermissionDenied`.
///
/// Validates: trait `instance_id` == `context.integration_instance_id`; context instance ==
/// grant instance; context plugin == grant plugin; context capability == bound capability;
/// capability is granted by the grant; request id parses. The executor re-checks the
/// principal↔grant binding before guest work (defense-in-depth).
pub(crate) fn principal_from_context(
  grant: &ExecutionGrantSet,
  bound_capability_id: &str,
  instance_id: Uuid,
  context: &ExecutionContext,
) -> Result<PluginPrincipal, CapabilityError> {
  if instance_id != context.integration_instance_id {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "instance id does not match execution context",
    ));
  }
  if context.integration_instance_id != grant.instance_id() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "execution context instance is not authorized by this grant",
    ));
  }
  if context.plugin_id != grant.plugin_id().as_str() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "execution context plugin is not authorized by this grant",
    ));
  }
  if context.capability_id != bound_capability_id {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "capability is not bound to this component",
    ));
  }
  grant
    .principal_for_request(&context.capability_id, &context.request_id)
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::PermissionDenied, "capability not granted"))
}

/// Validate copied config/preferences JSON: bounded UTF-8 bytes and valid JSON.
fn validate_copied_json(bytes: &[u8], max_bytes: usize, field: &str) -> Result<(), CapabilityError> {
  if bytes.len() > max_bytes {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      format!("{field} exceeds {max_bytes} bytes"),
    ));
  }
  if bytes.is_empty() {
    return Ok(());
  }
  let s = std::str::from_utf8(bytes).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      format!("{field} must be valid UTF-8"),
    )
  })?;
  serde_json::from_str::<serde_json::Value>(s).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      format!("{field} must be valid JSON"),
    )
  })?;
  Ok(())
}

/// Named host maximum model count in one aggregate `llm.models.list@1` response. Guests that
/// need remote cursor pagination must enforce their own page/item/total limits internally and
/// return only this bounded aggregate; the host never pages a second time.
pub const LLM_MODELS_LIST_MAX_MODELS: usize = 512;
/// Maximum UTF-8 bytes in a model descriptor id.
pub const LLM_MODEL_ID_MAX_BYTES: usize = 256;
/// Maximum UTF-8 bytes in a model descriptor label.
pub const LLM_MODEL_LABEL_MAX_BYTES: usize = 512;

/// Validate a typed models-list response as one bounded aggregate: count, descriptor id/label
/// bounds, and duplicate rejection. Any violation is a stable `InvalidResponse` so a guest can
/// never push an unbounded or ambiguous model set into host state.
fn validate_llm_model_descriptors(
  models: &[llm_models::exports::langnext::runtime_plugin::llm_models::ModelDescriptor],
) -> Result<(), CapabilityError> {
  if models.len() > LLM_MODELS_LIST_MAX_MODELS {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      format!("models list exceeds host maximum of {LLM_MODELS_LIST_MAX_MODELS}"),
    ));
  }
  let mut seen = std::collections::HashSet::with_capacity(models.len().min(64));
  for model in models {
    if model.id.is_empty() {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidResponse,
        "model descriptor id must not be empty",
      ));
    }
    if model.id.len() > LLM_MODEL_ID_MAX_BYTES {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidResponse,
        format!("model descriptor id exceeds {LLM_MODEL_ID_MAX_BYTES} bytes"),
      ));
    }
    if let Some(label) = model.label.as_deref() {
      if label.len() > LLM_MODEL_LABEL_MAX_BYTES {
        return Err(CapabilityError::new(
          CapabilityErrorCode::InvalidResponse,
          format!("model descriptor label exceeds {LLM_MODEL_LABEL_MAX_BYTES} bytes"),
        ));
      }
    }
    if !seen.insert(model.id.as_str()) {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidResponse,
        format!("duplicate model id '{}'", model.id),
      ));
    }
  }
  Ok(())
}

/// Validate a translate.text request against host bounds before guest execution.
fn validate_translate_text_request(request_id: &str, request: &TranslateTextRequest) -> Result<(), CapabilityError> {
  validate_capability_request_id(request_id)?;
  validate_capability_text(&request.text)?;
  // Source language: "auto" and empty are allowed (provider detection); otherwise validate.
  if !request.source_language_id.is_empty() && request.source_language_id != "auto" {
    validate_capability_language_id(&request.source_language_id, "source_language_id")?;
  }
  validate_capability_language_id(&request.target_language_id, "target_language_id")?;
  Ok(())
}

fn decode_and_validate_ocr_png_bytes(png_base64: &str) -> Result<Vec<u8>, CapabilityError> {
  let trimmed = png_base64.trim();
  if trimmed.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "png_base64 must not be empty",
    ));
  }
  let max_base64_chars = ((crate::domain::service_capability::OCR_IMAGE_MAX_DECODED_BYTES + 2) / 3) * 4;
  if trimmed.len() > max_base64_chars {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      "PNG exceeds size limit",
    ));
  }
  let decoded = BASE64.decode(trimmed.as_bytes()).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      "png_base64 is not valid standard base64",
    )
  })?;
  if decoded.len() > crate::domain::service_capability::OCR_IMAGE_MAX_DECODED_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      "PNG exceeds size limit",
    ));
  }
  let reader = ImageReader::new(Cursor::new(&decoded))
    .with_guessed_format()
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::UnsupportedInput, "PNG image could not be read"))?;
  if reader.format() != Some(image::ImageFormat::Png) {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      "image must be PNG",
    ));
  }
  let (width, height) = reader
    .into_dimensions()
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::UnsupportedInput, "PNG dimensions are invalid"))?;
  validate_ocr_png_bounds(width, height, decoded.len())?;
  // Decode only after cheap header dimensions pass the edge/pixel limits. This prevents a small
  // compressed bomb from allocating an unbounded pixel buffer before rejection.
  ImageReader::new(Cursor::new(&decoded))
    .with_guessed_format()
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::UnsupportedInput, "PNG image could not be read"))?
    .decode()
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::UnsupportedInput, "PNG image is invalid"))?;
  Ok(decoded)
}

fn map_ocr_image_plugin_error(
  error: super::bindings::ocr_image::langnext::runtime_plugin::common::PluginError,
) -> CapabilityError {
  use super::bindings::ocr_image::langnext::runtime_plugin::common::PluginError;
  let (code, label) = match error {
    PluginError::InvalidRequest(_) => (CapabilityErrorCode::InvalidRequest, "invalid request"),
    PluginError::InvalidConfiguration => (CapabilityErrorCode::InvalidConfiguration, "invalid configuration"),
    PluginError::InvalidInput(_) => (CapabilityErrorCode::InvalidRequest, "invalid input"),
    PluginError::Auth => (CapabilityErrorCode::Auth, "auth failed"),
    PluginError::PermissionDenied => (CapabilityErrorCode::PermissionDenied, "permission denied"),
    PluginError::QuotaExceeded => (CapabilityErrorCode::QuotaExceeded, "quota exceeded"),
    PluginError::RateLimited => (CapabilityErrorCode::RateLimited, "rate limited"),
    PluginError::UnsupportedInput(_) => (CapabilityErrorCode::UnsupportedInput, "unsupported input"),
    PluginError::UnsupportedLanguage(_) => (CapabilityErrorCode::UnsupportedLanguage, "unsupported language"),
    PluginError::Network(_) => (CapabilityErrorCode::Network, "network error"),
    PluginError::Timeout => (CapabilityErrorCode::Timeout, "timeout"),
    PluginError::InvalidResponse(_) => (CapabilityErrorCode::InvalidResponse, "invalid response"),
    PluginError::ProviderUnavailable => (CapabilityErrorCode::ProviderUnavailable, "provider unavailable"),
    PluginError::PluginUnavailable => (CapabilityErrorCode::PluginUnavailable, "plugin unavailable"),
    PluginError::Cancelled => (CapabilityErrorCode::Cancelled, "cancelled"),
    PluginError::Internal(_) => (CapabilityErrorCode::Internal, "internal error"),
  };
  CapabilityError::new(code, label)
}

/// Map a guest-returned `plugin-error` to a stable `CapabilityError` without leaking detail.
/// Works for any generated `PluginError` enum (translate-text/translate-detect share the v1 ABI).
macro_rules! impl_plugin_error_mapper {
  ($fn_name:ident, $pe:path) => {
    pub(crate) fn $fn_name(error: $pe) -> CapabilityError {
      use $pe as PluginError;
      let (code, label) = match error {
        PluginError::InvalidRequest(_) => (CapabilityErrorCode::InvalidRequest, "invalid request"),
        PluginError::InvalidConfiguration => (CapabilityErrorCode::InvalidConfiguration, "invalid configuration"),
        // Basis: `CapabilityErrorCode` has no `InvalidInput` variant. `invalid-input` is a
        // client-side input-validation failure, which is the semantic of `InvalidRequest`; it is
        // NOT merged into `invalid-request`'s message (kept distinct: "invalid input") and is NOT
        // mapped to `UnsupportedInput` (that code is for well-formed but unsupported inputs).
        PluginError::InvalidInput(_) => (CapabilityErrorCode::InvalidRequest, "invalid input"),
        PluginError::Auth => (CapabilityErrorCode::Auth, "auth failed"),
        PluginError::PermissionDenied => (CapabilityErrorCode::PermissionDenied, "permission denied"),
        PluginError::QuotaExceeded => (CapabilityErrorCode::QuotaExceeded, "quota exceeded"),
        PluginError::RateLimited => (CapabilityErrorCode::RateLimited, "rate limited"),
        PluginError::UnsupportedInput(_) => (CapabilityErrorCode::UnsupportedInput, "unsupported input"),
        PluginError::UnsupportedLanguage(_) => (CapabilityErrorCode::UnsupportedLanguage, "unsupported language"),
        PluginError::Network(message) if message == crate::domain::endpoint_trust::ENDPOINT_TRUST_REQUIRED_MARKER => (
          CapabilityErrorCode::EndpointTrustRequired,
          "custom endpoint requires review",
        ),
        PluginError::Network(_) => (CapabilityErrorCode::Network, "network error"),
        PluginError::Timeout => (CapabilityErrorCode::Timeout, "timeout"),
        PluginError::InvalidResponse(_) => (CapabilityErrorCode::InvalidResponse, "invalid response"),
        PluginError::ProviderUnavailable => (CapabilityErrorCode::ProviderUnavailable, "provider unavailable"),
        PluginError::PluginUnavailable => (CapabilityErrorCode::PluginUnavailable, "plugin unavailable"),
        PluginError::Cancelled => (CapabilityErrorCode::Cancelled, "cancelled"),
        PluginError::Internal(_) => (CapabilityErrorCode::Internal, "internal error"),
      };
      CapabilityError::new(code, label)
    }
  };
}

impl_plugin_error_mapper!(
  map_translate_text_plugin_error,
  translate_text::langnext::runtime_plugin::common::PluginError
);
impl_plugin_error_mapper!(
  map_translate_detect_plugin_error,
  super::bindings::translate_detect::langnext::runtime_plugin::common::PluginError
);
impl_plugin_error_mapper!(
  map_speech_synthesize_plugin_error,
  super::bindings::speech_synthesize::langnext::runtime_plugin::common::PluginError
);
impl_plugin_error_mapper!(
  map_llm_models_plugin_error,
  super::bindings::llm_models::langnext::runtime_plugin::common::PluginError
);
impl_plugin_error_mapper!(
  map_llm_chat_plugin_error,
  super::bindings::llm_chat::langnext::runtime_plugin::common::PluginError
);

/// Run a guest future under a wall deadline and cooperative cancellation. The shared engine
/// epoch ticker (owned by [`WasmRuntime`]) advances epoch deadlines for cooperative yielding;
/// fuel is the deterministic backstop. Fuel/epoch cannot preempt blocking host imports, so
/// imports enforce their own timeouts (see [`super::host`]).
pub(crate) async fn run_with_interruption<F, T>(
  deadline: Option<Instant>,
  cancel: CancelToken,
  guest_future: F,
  provider_attempt: Option<ProviderAttemptTracker>,
  max_duration: Duration,
) -> Result<T, CapabilityError>
where
  F: std::future::Future<Output = wasmtime::Result<T>>,
{
  let timeout = deadline_to_duration_with_cap(deadline, max_duration);
  tokio::select! {
    biased;
    _ = cancel.cancelled() => {
      if let Some(tracker) = &provider_attempt {
        tracker.mark_cancelled();
      }
      Err(CapabilityError::new(CapabilityErrorCode::Cancelled, "request cancelled"))
    }
    _ = tokio::time::sleep(timeout) => {
      if let Some(tracker) = &provider_attempt {
        if cancel.is_cancelled() {
          tracker.mark_cancelled();
        } else {
          tracker.mark_completed();
        }
      }
      Err(CapabilityError::new(CapabilityErrorCode::Timeout, "request deadline exceeded"))
    }
    outcome = guest_future => outcome.map_err(map_wasmtime_error),
  }
}

/// Single shared epoch ticker running on a dedicated OS thread. Reliable in any construction
/// path (sync `AppState` init or async Tokio context): it does NOT depend on a Tokio runtime, so
/// it never silently degrades to "no ticker". All stores on the shared engine observe its epoch
/// advances; `epoch_deadline_async_yield_and_update` makes infinite guests yield to the async
/// executor at each deadline. `Drop` sets a stop flag and joins the thread, so the ticker is
/// fully reclaimable. One ticker per [`WasmRuntime`].
struct EpochTicker {
  stop: Arc<AtomicBool>,
  handle: Option<std::thread::JoinHandle<()>>,
}

impl EpochTicker {
  /// Spawn the dedicated ticker thread. Returns an error only if the OS thread cannot be
  /// spawned (a hard failure; callers surface it rather than silently running without a ticker).
  fn spawn(engine: wasmtime::Engine) -> std::io::Result<Self> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();
    let handle = std::thread::Builder::new()
      .name("wasmtime-epoch-ticker".into())
      .spawn(move || {
        while !stop_clone.load(Ordering::Relaxed) {
          std::thread::sleep(EPOCH_TICK_INTERVAL);
          if stop_clone.load(Ordering::Relaxed) {
            break;
          }
          engine.increment_epoch();
        }
      })?;
    Ok(Self {
      stop,
      handle: Some(handle),
    })
  }
}

impl Drop for EpochTicker {
  fn drop(&mut self) {
    self.stop.store(true, Ordering::Relaxed);
    if let Some(handle) = self.handle.take() {
      // The thread sleeps up to EPOCH_TICK_INTERVAL before re-checking stop; join waits for it.
      let _ = handle.join();
    }
  }
}

/// Convert an optional wall deadline into a `sleep` duration, capped by the default invocation
/// timeout. A far-future deadline is capped to [`DEFAULT_INVOCATION_TIMEOUT`] so a caller can
/// never request an unbounded invocation; the host always bounds execution time.
pub(crate) fn deadline_to_duration(deadline: Option<Instant>) -> Duration {
  deadline_to_duration_with_cap(deadline, DEFAULT_INVOCATION_TIMEOUT)
}

pub(crate) fn deadline_to_duration_with_cap(deadline: Option<Instant>, max_duration: Duration) -> Duration {
  match deadline {
    Some(deadline) => {
      let now = Instant::now();
      let remaining = if deadline <= now {
        Duration::ZERO
      } else {
        deadline.duration_since(now)
      };
      remaining.min(max_duration)
    }
    None => max_duration,
  }
}

/// Compute the lowercase hex SHA-256 of `bytes`. Used to verify supplied package digests at
/// compile time and by tests to derive digests for synthesized WAT fixtures.
pub(crate) fn compute_sha256_hex(bytes: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}
