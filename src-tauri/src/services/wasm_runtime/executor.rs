// ABOUTME: Typed Component execution: load (with compiled-artifact cache), instantiate
// ABOUTME: per-request, call Translate/Detect exports asynchronously, validate bounds.
// Never auto-retries through Bundled Rust after guest execution starts.
use crate::domain::cancel::CancelToken;
use crate::domain::runtime_plugin::{ComponentArtifactDigest, ExecutionGrantSet, PackageDigest, PluginPrincipal};
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, DetectLanguageRequest, DetectLanguageResponse, ExecutionContext,
  SPEECH_AUDIO_MAX_BYTES, SpeechSynthesizeRequest, SpeechSynthesizeResponse, TranslateTextRequest,
  TranslateTextResponse, validate_capability_language_id, validate_capability_request_id, validate_capability_text,
  validate_speech_synthesize_text,
};
use crate::services::service_capabilities::{
  DetectLanguageCapability, SpeechSynthesizeCapability, TranslateTextCapability,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use uuid::Uuid;
use wasmtime::component::{Component, HasSelf};

use super::bindings::translate_text;
use super::cache::{CACHE_HOST_API_VERSION, CompiledComponentCache, component_cache_identity};
use super::engine::{WasmEngine, host_target_triple};
use super::errors::{map_instantiate_error, map_wasmtime_error};
use super::host::BrokerHandle;
use super::store::{EPOCH_TICK_INTERVAL, PluginHostState, build_store, new_state};

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
    })
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
    // Authorization at invocation start: package identity + principal↔grant before guest work.
    enforce_package_binding(&principal, verified)?;
    grant
      .grants_capability(&principal)
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::PermissionDenied, "principal not authorized"))?;
    validate_copied_json(&config, CONFIG_MAX_BYTES, "config")?;
    validate_copied_json(&preferences, PREFERENCES_MAX_BYTES, "preferences")?;
    validate_translate_text_request(principal.request_id().as_str(), &request)?;
    let cancel = cancel.clone();
    let state = new_state(principal, grant, cancel.clone(), deadline, broker);
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

    let call_result = run_with_interruption(
      deadline,
      cancel,
      guest.call_text(&mut store, &config, &preferences, &wit_request),
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
    let state = new_state(principal, grant, cancel.clone(), deadline, broker);
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
    let call_result = run_with_interruption(
      deadline,
      cancel,
      guest.call_detect(&mut store, &config, &preferences, &wit_request),
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

    let cancel = cancel.clone();
    let state = new_state(principal, grant, cancel.clone(), deadline, broker);
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

    // Speech uses a longer wall bound than translate when no explicit deadline is set.
    let speech_deadline = deadline.or_else(|| Some(Instant::now() + SPEECH_INVOCATION_TIMEOUT));
    let call_result = run_with_interruption(
      speech_deadline,
      cancel.clone(),
      guest.call_synthesize(&mut store, &config, &wit_request),
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
        .execute_translate_text(
          &verified,
          principal,
          grant,
          cancel,
          deadline,
          broker,
          config,
          preferences,
          request,
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
        .execute_translate_detect(
          &verified,
          principal,
          grant,
          cancel,
          deadline,
          broker,
          config,
          preferences,
          request,
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
        .execute_speech_synthesize(&verified, principal, grant, cancel, deadline, broker, config, request)
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

/// Run a guest future under a wall deadline and cooperative cancellation. The shared engine
/// epoch ticker (owned by [`WasmRuntime`]) advances epoch deadlines for cooperative yielding;
/// fuel is the deterministic backstop. Fuel/epoch cannot preempt blocking host imports, so
/// imports enforce their own timeouts (see [`super::host`]).
pub(crate) async fn run_with_interruption<F, T>(
  deadline: Option<Instant>,
  cancel: CancelToken,
  guest_future: F,
) -> Result<T, CapabilityError>
where
  F: std::future::Future<Output = wasmtime::Result<T>>,
{
  let timeout = deadline_to_duration(deadline);
  tokio::select! {
    biased;
    _ = cancel.cancelled() => Err(CapabilityError::new(CapabilityErrorCode::Cancelled, "request cancelled")),
    _ = tokio::time::sleep(timeout) => Err(CapabilityError::new(CapabilityErrorCode::Timeout, "request deadline exceeded")),
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
  match deadline {
    Some(deadline) => {
      let now = Instant::now();
      let remaining = if deadline <= now {
        Duration::ZERO
      } else {
        deadline.duration_since(now)
      };
      remaining.min(DEFAULT_INVOCATION_TIMEOUT)
    }
    None => DEFAULT_INVOCATION_TIMEOUT,
  }
}

/// Compute the lowercase hex SHA-256 of `bytes`. Used to verify supplied package digests at
/// compile time and by tests to derive digests for synthesized WAT fixtures.
pub(crate) fn compute_sha256_hex(bytes: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}
