// ABOUTME: Typed capability handler registry and instance-aware capability lookup.
// ABOUTME: Routes through RuntimeRouter so SQLite pins select one executor without fallback.
use crate::domain::cancel::CancelToken;
use crate::domain::runtime_lifecycle::{ExecutionGrantSetBundle, GrantSubjectKind};
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, DetectLanguageRequest, DetectLanguageResponse, ExecutionContext,
  OcrImageRequest, OcrImageResponse, SpeechSynthesizeRequest, SpeechSynthesizeResponse, TranslateTextRequest,
  TranslateTextResponse,
};
use crate::domain::service_integration::IntegrationHealthStatus;
use crate::error::StorageError;
use crate::repositories::integration_instances;
use crate::repositories::{installed_plugin_versions, plugin_permission_grants, plugin_publishers};
use crate::services::edge_tts::EdgeTtsCapabilities;
use crate::services::google_cloud::GoogleCloudCapabilities;
use crate::services::google_translate_web::GoogleTranslateWebCapabilities;
use crate::services::runtime_router::{ResolvedDetect, ResolvedTranslate, RuntimeRouter, SnapshotRuntimeResolution};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::wasm_runtime::host::{BrokerFetchError, BrokerFetchOutcome, BrokerFetchRequest, BrokerHandle};
use crate::services::wasm_runtime::{
  WasmDetectLanguageAdapter, WasmRuntime, WasmSpeechSynthesizeAdapter, WasmTranslateTextAdapter,
};
use crate::storage::Database;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use uuid::Uuid;

/// Tagged capability handler kinds (closed set of host-recognized contracts).
#[derive(Clone)]
pub enum CapabilityHandler {
  TranslateText(Arc<dyn TranslateTextCapability>),
  DetectLanguage(Arc<dyn DetectLanguageCapability>),
  OcrImage(Arc<dyn OcrImageCapability>),
  SpeechSynthesize(Arc<dyn SpeechSynthesizeCapability>),
}

/// Typed translate-text capability contract.
pub trait TranslateTextCapability: Send + Sync + 'static {
  fn translate(
    &self,
    instance_id: Uuid,
    request: TranslateTextRequest,
    context: ExecutionContext,
  ) -> Pin<Box<dyn Future<Output = Result<TranslateTextResponse, CapabilityError>> + Send + '_>>;
}

/// Typed detect-language capability contract.
pub trait DetectLanguageCapability: Send + Sync + 'static {
  fn detect(
    &self,
    instance_id: Uuid,
    request: DetectLanguageRequest,
    context: ExecutionContext,
  ) -> Pin<Box<dyn Future<Output = Result<DetectLanguageResponse, CapabilityError>> + Send + '_>>;
}

/// Typed image OCR capability contract.
pub trait OcrImageCapability: Send + Sync + 'static {
  fn recognize(
    &self,
    instance_id: Uuid,
    request: OcrImageRequest,
    context: ExecutionContext,
  ) -> Pin<Box<dyn Future<Output = Result<OcrImageResponse, CapabilityError>> + Send + '_>>;
}

/// Typed text-to-speech capability contract.
pub trait SpeechSynthesizeCapability: Send + Sync + 'static {
  fn synthesize(
    &self,
    instance_id: Uuid,
    request: SpeechSynthesizeRequest,
    context: ExecutionContext,
  ) -> Pin<Box<dyn Future<Output = Result<SpeechSynthesizeResponse, CapabilityError>> + Send + '_>>;
}

impl TranslateTextCapability for GoogleCloudCapabilities {
  fn translate(
    &self,
    instance_id: Uuid,
    request: TranslateTextRequest,
    context: ExecutionContext,
  ) -> Pin<Box<dyn Future<Output = Result<TranslateTextResponse, CapabilityError>> + Send + '_>> {
    Box::pin(async move { self.translate_text(instance_id, request, context).await })
  }
}

impl DetectLanguageCapability for GoogleCloudCapabilities {
  fn detect(
    &self,
    instance_id: Uuid,
    request: DetectLanguageRequest,
    context: ExecutionContext,
  ) -> Pin<Box<dyn Future<Output = Result<DetectLanguageResponse, CapabilityError>> + Send + '_>> {
    Box::pin(async move { self.detect_language(instance_id, request, context).await })
  }
}

impl OcrImageCapability for GoogleCloudCapabilities {
  fn recognize(
    &self,
    instance_id: Uuid,
    request: OcrImageRequest,
    context: ExecutionContext,
  ) -> Pin<Box<dyn Future<Output = Result<OcrImageResponse, CapabilityError>> + Send + '_>> {
    Box::pin(async move { self.ocr_image(instance_id, request, context).await })
  }
}

impl SpeechSynthesizeCapability for GoogleCloudCapabilities {
  fn synthesize(
    &self,
    instance_id: Uuid,
    request: SpeechSynthesizeRequest,
    context: ExecutionContext,
  ) -> Pin<Box<dyn Future<Output = Result<SpeechSynthesizeResponse, CapabilityError>> + Send + '_>> {
    Box::pin(async move { self.synthesize_speech(instance_id, request, context).await })
  }
}

impl SpeechSynthesizeCapability for EdgeTtsCapabilities {
  fn synthesize(
    &self,
    instance_id: Uuid,
    request: SpeechSynthesizeRequest,
    context: ExecutionContext,
  ) -> Pin<Box<dyn Future<Output = Result<SpeechSynthesizeResponse, CapabilityError>> + Send + '_>> {
    Box::pin(async move { self.synthesize_speech(instance_id, request, context).await })
  }
}

impl TranslateTextCapability for GoogleTranslateWebCapabilities {
  fn translate(
    &self,
    instance_id: Uuid,
    request: TranslateTextRequest,
    context: ExecutionContext,
  ) -> Pin<Box<dyn Future<Output = Result<TranslateTextResponse, CapabilityError>> + Send + '_>> {
    Box::pin(async move { self.translate_text(instance_id, request, context).await })
  }
}

impl DetectLanguageCapability for GoogleTranslateWebCapabilities {
  fn detect(
    &self,
    instance_id: Uuid,
    request: DetectLanguageRequest,
    context: ExecutionContext,
  ) -> Pin<Box<dyn Future<Output = Result<DetectLanguageResponse, CapabilityError>> + Send + '_>> {
    Box::pin(async move { self.detect_language(instance_id, request, context).await })
  }
}

/// Registry of capability handlers keyed by plugin_id + capability_id.
#[derive(Clone, Default)]
pub struct ServiceCapabilityRegistry {
  handlers: HashMap<(String, String), CapabilityHandler>,
}

impl ServiceCapabilityRegistry {
  pub fn new() -> Self {
    Self {
      handlers: HashMap::new(),
    }
  }

  pub fn register(
    &mut self,
    plugin_id: impl Into<String>,
    capability_id: impl Into<String>,
    handler: CapabilityHandler,
  ) {
    self.handlers.insert((plugin_id.into(), capability_id.into()), handler);
  }

  pub fn get(&self, plugin_id: &str, capability_id: &str) -> Option<&CapabilityHandler> {
    self.handlers.get(&(plugin_id.to_string(), capability_id.to_string()))
  }
}

/// Resolves handlers for configured integration instances via the authoritative runtime router.
#[derive(Clone)]
pub struct ServiceCapabilityService {
  db: Database,
  definition_registry: Arc<ServiceIntegrationRegistry>,
  handlers: Arc<ServiceCapabilityRegistry>,
  /// Authoritative adapter selection. Always set in production; tests may use `with_router`.
  router: Option<RuntimeRouter>,
  wasm_runtime: Option<Arc<WasmRuntime>>,
  /// Factory for Wasm guest broker handles. Production wires `NetworkBrokerHandle` over the
  /// bounded HTTP transport; defaults to `DeniedBroker` so legacy tests that never call the
  /// broker are unaffected. Phase 5 google-web Wasm execution requires a real transport.
  broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync>,
}

impl ServiceCapabilityService {
  pub fn new(
    db: Database,
    definition_registry: Arc<ServiceIntegrationRegistry>,
    handlers: Arc<ServiceCapabilityRegistry>,
  ) -> Self {
    Self {
      db,
      definition_registry,
      handlers,
      router: None,
      wasm_runtime: None,
      broker_factory: Arc::new(|| Box::new(DeniedBroker) as Box<dyn BrokerHandle>),
    }
  }

  /// Attach the runtime router and shared Wasm runtime (Phase 4 production wiring).
  pub fn with_router(mut self, router: RuntimeRouter, wasm_runtime: Arc<WasmRuntime>) -> Self {
    self.router = Some(router);
    self.wasm_runtime = Some(wasm_runtime);
    self
  }

  /// Attach the Wasm guest broker handle factory (Phase 5 production wiring). Without this,
  /// Wasm guests that call `host.broker-fetch` are denied; google-web Wasm execution requires a
  /// transport-backed handle.
  pub fn with_broker_factory(mut self, factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync>) -> Self {
    self.broker_factory = factory;
    self
  }

  /// One SQLite-authoritative snapshot for a profile capability invocation.
  /// Uses `read_snapshot` so pin/grant/package/publisher/config/prefs share one committed view.
  pub fn load_profile_invocation_snapshot(
    &self,
    profile_id: Uuid,
    capability_kind: ProfileCapabilityKind,
  ) -> Result<ProfileInvocationSnapshot, ProfileSnapshotLoadError> {
    self
      .db
      .read_snapshot(|conn| load_profile_invocation_snapshot_conn(conn, profile_id, capability_kind))
      .map_err(ProfileSnapshotLoadError::from_storage)
  }

  /// Capability-facing wrapper that maps typed snapshot errors into CapabilityError codes.
  pub fn load_profile_invocation_snapshot_capability(
    &self,
    profile_id: Uuid,
    capability_kind: ProfileCapabilityKind,
  ) -> Result<ProfileInvocationSnapshot, CapabilityError> {
    self
      .load_profile_invocation_snapshot(profile_id, capability_kind)
      .map_err(ProfileSnapshotLoadError::into_capability)
  }

  /// Look up a translate handler after authoritative runtime resolution (legacy/test path).
  pub fn resolve_translate(
    &self,
    instance_id: Uuid,
    capability_id: &str,
    preferences_json: Vec<u8>,
  ) -> Result<Arc<dyn TranslateTextCapability>, CapabilityError> {
    let config_json = self
      .db
      .read(|conn| integration_instances::get(conn, instance_id))
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to load instance"))?
      .config_json
      .into_bytes();
    self.resolve_translate_with_config(instance_id, capability_id, preferences_json, config_json)
  }

  /// Full authoritative recheck after external FS rehash: profile + pin + package + publisher + grant + prefs.
  pub fn recheck_invocation_snapshot(
    &self,
    snapshot: &ProfileInvocationSnapshot,
    capability_kind: ProfileCapabilityKind,
  ) -> Result<(), CapabilityError> {
    let live = self.load_profile_invocation_snapshot_capability(snapshot.profile_id, capability_kind)?;
    if live.profile_id != snapshot.profile_id
      || live.profile_updated_at != snapshot.profile_updated_at
      || live.profile_enabled != snapshot.profile_enabled
      || live.profile_integration_instance_id != snapshot.profile_integration_instance_id
      || live.instance_id != snapshot.instance_id
      || live.plugin_id != snapshot.plugin_id
      || live.capability_id != snapshot.capability_id
      || live.health_status != snapshot.health_status
      || live.config_json != snapshot.config_json
      || live.config_schema_version != snapshot.config_schema_version
      || live.preferences_json != snapshot.preferences_json
      || live.preferences_schema_version != snapshot.preferences_schema_version
    {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "profile binding, config, or preferences changed concurrently during invocation",
      ));
    }
    let router = self
      .router
      .as_ref()
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::Internal, "runtime router is not configured"))?;
    router.recheck_pin_matches(&snapshot.runtime_pin)?;
    // Also compare package-side fields from the freshly loaded snapshot.
    let a = &live.runtime_pin;
    let b = &snapshot.runtime_pin;
    if a.package_digest != b.package_digest
      || a.execution_grant_set_revision != b.execution_grant_set_revision
      || a.package_content_available != b.package_content_available
      || a.package_permission_request_digest != b.package_permission_request_digest
      || a.package_manifest_json != b.package_manifest_json
      || a.publisher_key_id != b.publisher_key_id
      || a.publisher_fingerprint != b.publisher_fingerprint
      || a.publisher_public_key_hex != b.publisher_public_key_hex
      || a.publisher_source != b.publisher_source
      || a.publisher_enabled != b.publisher_enabled
      || a.publisher_revoked != b.publisher_revoked
    {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "package or publisher authority changed concurrently during invocation",
      ));
    }
    Ok(())
  }

  /// Resolve translate from a single immutable profile/runtime snapshot (formal command path).
  pub fn resolve_translate_from_snapshot(
    &self,
    snapshot: &ProfileInvocationSnapshot,
  ) -> Result<Arc<dyn TranslateTextCapability>, CapabilityError> {
    let router = self
      .router
      .as_ref()
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::Internal, "runtime router is not configured"))?;
    let adapter = router.resolve_from_snapshot(&snapshot.runtime_pin, &snapshot.capability_id)?;
    // External archive/artifact rehash finished; full authoritative recheck before use.
    self.recheck_invocation_snapshot(snapshot, ProfileCapabilityKind::Translate)?;
    match adapter {
      crate::services::runtime_router::RuntimeAdapter::BundledRust {
        handler: CapabilityHandler::TranslateText(h),
      } => {
        if snapshot.health_status != IntegrationHealthStatus::Ready.as_str() {
          return Err(CapabilityError::new(
            CapabilityErrorCode::InvalidConfiguration,
            "integration instance is not ready",
          ));
        }
        Ok(h)
      }
      crate::services::runtime_router::RuntimeAdapter::BundledRust { .. } => Err(
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability handler type mismatch",
        )
        .with_capability_id(&snapshot.capability_id),
      ),
      crate::services::runtime_router::RuntimeAdapter::WasmComponent {
        package_digest,
        artifact_digest,
        artifact_bytes,
        grant,
        principal_factory: _,
      } => {
        let runtime = self
          .wasm_runtime
          .as_ref()
          .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::Internal, "wasm runtime is not configured"))?;
        let verified = runtime
          .compile_component(&package_digest, &artifact_digest, artifact_bytes.as_slice())
          .map_err(|e| {
            CapabilityError::new(
              CapabilityErrorCode::PluginUnavailable,
              format!("component compile failed: {e}"),
            )
          })?;
        // Full authoritative recheck AFTER compile; discard compiled handler on concurrent change.
        self.recheck_invocation_snapshot(snapshot, ProfileCapabilityKind::Translate)?;
        let preferences = if snapshot.preferences_json.is_empty() {
          b"{}".to_vec()
        } else {
          snapshot.preferences_json.clone()
        };
        Ok(Arc::new(WasmTranslateTextAdapter::new(
          runtime.clone(),
          Arc::new(verified),
          grant,
          snapshot.capability_id.clone(),
          snapshot.config_json.clone(),
          preferences,
          self.broker_factory.clone(),
        )))
      }
    }
  }

  fn resolve_translate_with_config(
    &self,
    instance_id: Uuid,
    capability_id: &str,
    preferences_json: Vec<u8>,
    config_json: Vec<u8>,
  ) -> Result<Arc<dyn TranslateTextCapability>, CapabilityError> {
    if let Some(router) = &self.router {
      return match router.resolve_translate(instance_id, capability_id)? {
        ResolvedTranslate::Bundled(h) => {
          self.ensure_bundled_ready(instance_id)?;
          Ok(h)
        }
        ResolvedTranslate::Wasm {
          package_digest,
          artifact_digest,
          artifact_bytes,
          grant,
          principal_factory: _,
        } => {
          let runtime = self
            .wasm_runtime
            .as_ref()
            .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::Internal, "wasm runtime is not configured"))?;
          let verified = runtime
            .compile_component(&package_digest, &artifact_digest, artifact_bytes.as_slice())
            .map_err(|e| {
              CapabilityError::new(
                CapabilityErrorCode::PluginUnavailable,
                format!("component compile failed: {e}"),
              )
            })?;
          let preferences = if preferences_json.is_empty() {
            b"{}".to_vec()
          } else {
            preferences_json
          };
          let adapter = WasmTranslateTextAdapter::new(
            runtime.clone(),
            Arc::new(verified),
            grant,
            capability_id.to_string(),
            config_json,
            preferences,
            self.broker_factory.clone(),
          );
          Ok(Arc::new(adapter))
        }
      };
    }
    let handler = self.resolve_handler(instance_id, capability_id)?;
    match handler {
      CapabilityHandler::TranslateText(h) => Ok(h),
      _ => Err(
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability handler type mismatch",
        )
        .with_capability_id(capability_id),
      ),
    }
  }

  /// Look up a detect handler after authoritative runtime resolution.
  pub fn resolve_detect(
    &self,
    instance_id: Uuid,
    capability_id: &str,
    preferences_json: Vec<u8>,
  ) -> Result<Arc<dyn DetectLanguageCapability>, CapabilityError> {
    let config_json = self
      .db
      .read(|conn| integration_instances::get(conn, instance_id))
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to load instance"))?
      .config_json
      .into_bytes();
    self.resolve_detect_with_config(instance_id, capability_id, preferences_json, config_json)
  }

  /// Resolve detect from a single immutable profile/runtime snapshot (formal command path).
  pub fn resolve_detect_from_snapshot(
    &self,
    snapshot: &ProfileInvocationSnapshot,
  ) -> Result<Arc<dyn DetectLanguageCapability>, CapabilityError> {
    let router = self
      .router
      .as_ref()
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::Internal, "runtime router is not configured"))?;
    let adapter = router.resolve_from_snapshot(&snapshot.runtime_pin, &snapshot.capability_id)?;
    match adapter {
      crate::services::runtime_router::RuntimeAdapter::BundledRust {
        handler: CapabilityHandler::DetectLanguage(h),
      } => {
        self.recheck_invocation_snapshot(snapshot, ProfileCapabilityKind::Detect)?;
        if snapshot.health_status != IntegrationHealthStatus::Ready.as_str() {
          return Err(CapabilityError::new(
            CapabilityErrorCode::InvalidConfiguration,
            "integration instance is not ready",
          ));
        }
        Ok(h)
      }
      crate::services::runtime_router::RuntimeAdapter::BundledRust { .. } => Err(
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability handler type mismatch",
        )
        .with_capability_id(&snapshot.capability_id),
      ),
      crate::services::runtime_router::RuntimeAdapter::WasmComponent {
        package_digest,
        artifact_digest,
        artifact_bytes,
        grant,
        principal_factory: _,
      } => {
        let runtime = self
          .wasm_runtime
          .as_ref()
          .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::Internal, "wasm runtime is not configured"))?;
        let verified = runtime
          .compile_component(&package_digest, &artifact_digest, artifact_bytes.as_slice())
          .map_err(|e| {
            CapabilityError::new(
              CapabilityErrorCode::PluginUnavailable,
              format!("component compile failed: {e}"),
            )
          })?;
        // Full authoritative recheck AFTER compile; discard compiled handler on concurrent change.
        self.recheck_invocation_snapshot(snapshot, ProfileCapabilityKind::Detect)?;
        let preferences = if snapshot.preferences_json.is_empty() {
          b"{}".to_vec()
        } else {
          snapshot.preferences_json.clone()
        };
        Ok(Arc::new(WasmDetectLanguageAdapter::new(
          runtime.clone(),
          Arc::new(verified),
          grant,
          snapshot.capability_id.clone(),
          snapshot.config_json.clone(),
          preferences,
          self.broker_factory.clone(),
        )))
      }
    }
  }

  fn resolve_detect_with_config(
    &self,
    instance_id: Uuid,
    capability_id: &str,
    preferences_json: Vec<u8>,
    config_json: Vec<u8>,
  ) -> Result<Arc<dyn DetectLanguageCapability>, CapabilityError> {
    if let Some(router) = &self.router {
      return match router.resolve_detect(instance_id, capability_id)? {
        ResolvedDetect::Bundled(h) => {
          self.ensure_bundled_ready(instance_id)?;
          Ok(h)
        }
        ResolvedDetect::Wasm {
          package_digest,
          artifact_digest,
          artifact_bytes,
          grant,
          principal_factory: _,
        } => {
          let runtime = self
            .wasm_runtime
            .as_ref()
            .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::Internal, "wasm runtime is not configured"))?;
          let verified = runtime
            .compile_component(&package_digest, &artifact_digest, artifact_bytes.as_slice())
            .map_err(|e| {
              CapabilityError::new(
                CapabilityErrorCode::PluginUnavailable,
                format!("component compile failed: {e}"),
              )
            })?;
          let preferences = if preferences_json.is_empty() {
            b"{}".to_vec()
          } else {
            preferences_json
          };
          let adapter = WasmDetectLanguageAdapter::new(
            runtime.clone(),
            Arc::new(verified),
            grant,
            capability_id.to_string(),
            config_json,
            preferences,
            self.broker_factory.clone(),
          );
          Ok(Arc::new(adapter))
        }
      };
    }
    let handler = self.resolve_handler(instance_id, capability_id)?;
    match handler {
      CapabilityHandler::DetectLanguage(h) => Ok(h),
      _ => Err(
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability handler type mismatch",
        )
        .with_capability_id(capability_id),
      ),
    }
  }

  fn ensure_bundled_ready(&self, instance_id: Uuid) -> Result<(), CapabilityError> {
    let instance = self
      .db
      .read(|conn| integration_instances::get(conn, instance_id))
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to reload instance"))?;
    match instance.health_status {
      IntegrationHealthStatus::Ready => Ok(()),
      IntegrationHealthStatus::Unconfigured => Err(CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "integration instance is unconfigured",
      )),
      IntegrationHealthStatus::Unvalidated => Err(CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "integration instance is not validated",
      )),
      IntegrationHealthStatus::Degraded => Err(CapabilityError::new(
        CapabilityErrorCode::ProviderUnavailable,
        "integration instance is degraded",
      )),
    }
  }

  /// Look up an OCR image handler after verifying instance/plugin/capability state.
  pub fn resolve_ocr(
    &self,
    instance_id: Uuid,
    capability_id: &str,
  ) -> Result<Arc<dyn OcrImageCapability>, CapabilityError> {
    let handler = self.resolve_handler(instance_id, capability_id)?;
    match handler {
      CapabilityHandler::OcrImage(h) => Ok(h),
      _ => Err(
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability handler type mismatch",
        )
        .with_capability_id(capability_id),
      ),
    }
  }

  /// Look up a speech synthesis handler after authoritative runtime resolution.
  pub fn resolve_speech_synthesize(
    &self,
    instance_id: Uuid,
    capability_id: &str,
  ) -> Result<Arc<dyn SpeechSynthesizeCapability>, CapabilityError> {
    if let Some(router) = &self.router {
      return match router.resolve(instance_id, capability_id)? {
        crate::services::runtime_router::RuntimeAdapter::BundledRust {
          handler: CapabilityHandler::SpeechSynthesize(h),
        } => {
          self.ensure_bundled_ready(instance_id)?;
          Ok(h)
        }
        crate::services::runtime_router::RuntimeAdapter::BundledRust { .. } => Err(
          CapabilityError::new(
            CapabilityErrorCode::PermissionDenied,
            "capability handler type mismatch",
          )
          .with_capability_id(capability_id),
        ),
        crate::services::runtime_router::RuntimeAdapter::WasmComponent {
          package_digest,
          artifact_digest,
          artifact_bytes,
          grant,
          principal_factory: _,
        } => {
          let runtime = self
            .wasm_runtime
            .as_ref()
            .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::Internal, "wasm runtime is not configured"))?;
          let verified = runtime
            .compile_component(&package_digest, &artifact_digest, artifact_bytes.as_slice())
            .map_err(|e| {
              CapabilityError::new(
                CapabilityErrorCode::PluginUnavailable,
                format!("component compile failed: {e}"),
              )
            })?;
          let config_json = self
            .db
            .read(|conn| integration_instances::get(conn, instance_id))
            .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to load instance"))?
            .config_json
            .into_bytes();
          Ok(Arc::new(WasmSpeechSynthesizeAdapter::new(
            runtime.clone(),
            Arc::new(verified),
            grant,
            capability_id.to_string(),
            config_json,
            self.broker_factory.clone(),
          )))
        }
      };
    }
    let handler = self.resolve_handler(instance_id, capability_id)?;
    match handler {
      CapabilityHandler::SpeechSynthesize(h) => Ok(h),
      _ => Err(
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability handler type mismatch",
        )
        .with_capability_id(capability_id),
      ),
    }
  }

  fn resolve_handler(&self, instance_id: Uuid, capability_id: &str) -> Result<CapabilityHandler, CapabilityError> {
    let instance = self
      .db
      .read(|conn| integration_instances::get(conn, instance_id))
      .map_err(|e| match e {
        StorageError::NotFound(_) => CapabilityError::new(
          CapabilityErrorCode::InvalidConfiguration,
          "integration instance not found",
        ),
        _ => CapabilityError::new(CapabilityErrorCode::Internal, "failed to load integration instance"),
      })?;

    if !instance.enabled {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "integration instance is disabled",
      ));
    }

    if !self.definition_registry.contains(&instance.plugin_id) {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "plugin definition is missing",
      ));
    }

    let manifest = self
      .definition_registry
      .get(&instance.plugin_id)
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::PluginUnavailable, "plugin definition is missing"))?;

    if !manifest.capabilities.iter().any(|c| c.id == capability_id) {
      return Err(
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability is not declared on this plugin",
        )
        .with_capability_id(capability_id),
      );
    }

    // Execution requires a ready instance (unconfigured/unvalidated/degraded fail closed).
    // Capability-specific IAM failures still surface as permission_denied from the provider call.
    match instance.health_status {
      IntegrationHealthStatus::Ready => {}
      IntegrationHealthStatus::Unconfigured => {
        return Err(CapabilityError::new(
          CapabilityErrorCode::InvalidConfiguration,
          "integration instance is unconfigured",
        ));
      }
      IntegrationHealthStatus::Unvalidated => {
        return Err(CapabilityError::new(
          CapabilityErrorCode::InvalidConfiguration,
          "integration instance is not validated",
        ));
      }
      IntegrationHealthStatus::Degraded => {
        return Err(CapabilityError::new(
          CapabilityErrorCode::ProviderUnavailable,
          "integration instance is degraded",
        ));
      }
    }

    self
      .handlers
      .get(&instance.plugin_id, capability_id)
      .cloned()
      .ok_or_else(|| {
        CapabilityError::new(
          CapabilityErrorCode::PluginUnavailable,
          "capability handler is not registered",
        )
        .with_capability_id(capability_id)
      })
  }
}

/// Broker that denies every guest network call. Wasm adapters bind this factory at resolve time;
/// a later phase can inject NetworkBroker-backed handles without changing adapter selection.
struct DeniedBroker;

impl BrokerHandle for DeniedBroker {
  fn fetch(
    &self,
    _principal: &crate::domain::runtime_plugin::PluginPrincipal,
    _grant: &crate::domain::runtime_plugin::ExecutionGrantSet,
    _request: BrokerFetchRequest,
    _authorization: crate::services::wasm_runtime::host::BrokerAuthorization,
    _cancel: &CancelToken,
    _deadline: Option<std::time::Instant>,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = BrokerFetchOutcome> + Send + '_>> {
    Box::pin(async { Err(BrokerFetchError::NotApproved) })
  }
}

/// Build an execution context for a capability invocation.
pub fn execution_context(
  request_id: impl Into<String>,
  cancel: CancelToken,
  instance_id: Uuid,
  plugin_id: impl Into<String>,
  capability_id: impl Into<String>,
) -> ExecutionContext {
  ExecutionContext {
    request_id: request_id.into(),
    cancel,
    deadline: None,
    integration_instance_id: instance_id,
    plugin_id: plugin_id.into(),
    capability_id: capability_id.into(),
  }
}

/// Typed snapshot-load failure so formal commands can keep profile NotFound distinct from package/grant issues.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileSnapshotLoadError {
  NotFound(String),
  PluginUnavailable(String),
  InvalidConfiguration(String),
  Internal(String),
}

impl ProfileSnapshotLoadError {
  pub fn from_storage(err: StorageError) -> Self {
    match err {
      StorageError::NotFound(msg) => Self::NotFound(msg),
      StorageError::PluginUnavailable(msg) => Self::PluginUnavailable(msg),
      StorageError::Validation(msg) => Self::InvalidConfiguration(msg),
      other => Self::Internal(other.to_string()),
    }
  }

  pub fn into_capability(self) -> CapabilityError {
    match self {
      Self::NotFound(msg) => CapabilityError::new(CapabilityErrorCode::PluginUnavailable, msg),
      Self::PluginUnavailable(msg) => CapabilityError::new(CapabilityErrorCode::PluginUnavailable, msg),
      Self::InvalidConfiguration(msg) => CapabilityError::new(CapabilityErrorCode::InvalidConfiguration, msg),
      Self::Internal(msg) => CapabilityError::new(CapabilityErrorCode::Internal, msg),
    }
  }

  /// Formal command mapping: profile absence stays not_found; package/grant issues stay plugin_unavailable.
  pub fn into_resolve_storage(self) -> StorageError {
    match self {
      Self::NotFound(msg) => StorageError::NotFound(msg),
      Self::PluginUnavailable(msg) => StorageError::PluginUnavailable(msg),
      Self::InvalidConfiguration(msg) => StorageError::Validation(msg),
      Self::Internal(msg) => StorageError::Internal(msg),
    }
  }

  /// Map a post-snapshot capability failure (resolve/rehash/grant) into the formal load error channel.
  pub fn from_capability(err: CapabilityError) -> Self {
    match err.code {
      CapabilityErrorCode::PluginUnavailable | CapabilityErrorCode::PermissionDenied => {
        Self::PluginUnavailable(err.message)
      }
      CapabilityErrorCode::InvalidConfiguration | CapabilityErrorCode::InvalidRequest => {
        Self::InvalidConfiguration(err.message)
      }
      _ => Self::Internal(err.message),
    }
  }
}

/// Which capability binding to load from a translation profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileCapabilityKind {
  Translate,
  Detect,
}

/// Immutable invocation inputs loaded in one SQLite snapshot transaction.
#[derive(Debug, Clone)]
pub struct ProfileInvocationSnapshot {
  pub profile_id: Uuid,
  pub profile_updated_at: String,
  pub profile_enabled: bool,
  pub profile_integration_instance_id: Uuid,
  pub instance_id: Uuid,
  pub plugin_id: String,
  pub capability_id: String,
  pub health_status: String,
  pub config_json: Vec<u8>,
  pub config_schema_version: u32,
  pub preferences_json: Vec<u8>,
  pub preferences_schema_version: i32,
  pub runtime_pin: SnapshotRuntimeResolution,
}

fn load_profile_invocation_snapshot_conn(
  conn: &rusqlite::Connection,
  profile_id: Uuid,
  capability_kind: ProfileCapabilityKind,
) -> Result<ProfileInvocationSnapshot, StorageError> {
  use crate::repositories::translation_profiles;
  let dto = translation_profiles::get(conn, profile_id)?;
  if !dto.profile.enabled {
    return Err(StorageError::Validation("profile is disabled".into()));
  }
  let plugin = dto
    .profile
    .engine
    .as_plugin()
    .ok_or_else(|| StorageError::Validation("profile is not a plugin capability engine".into()))?;
  let capability_id = match capability_kind {
    ProfileCapabilityKind::Translate => plugin.translate_capability_id.clone(),
    ProfileCapabilityKind::Detect => plugin
      .detect_capability_id
      .clone()
      .ok_or_else(|| StorageError::Validation("profile has no detect capability".into()))?,
  };
  let preferences_schema_version = plugin.capability_preferences_version;
  let preferences_json: String = conn.query_row(
    "SELECT capability_preferences_json FROM translation_profiles WHERE id = ?1",
    rusqlite::params![profile_id.to_string()],
    |row| row.get(0),
  )?;
  let instance = integration_instances::get(conn, plugin.integration_instance_id)?;
  if !instance.enabled {
    return Err(StorageError::Validation("integration instance is disabled".into()));
  }
  if !matches!(instance.health_status, IntegrationHealthStatus::Ready) {
    return Err(StorageError::Validation("integration instance is not ready".into()));
  }

  // Capture package + publisher + grant authority in the same snapshot transaction.
  // Package-backed pins fail closed on missing package/publisher/fingerprint mismatch.
  let mut package_manifest_json = None;
  let mut package_content_available = false;
  let mut package_permission_request_digest = None;
  let mut package_plugin_id = None;
  let mut package_plugin_version = None;
  let mut publisher_key_id = None;
  let mut publisher_fingerprint = None;
  let mut publisher_public_key_hex = None;
  let mut publisher_source = None;
  let mut publisher_enabled = false;
  let mut publisher_revoked = true;
  let mut grant_bundle: Option<ExecutionGrantSetBundle> = None;
  if let (Some(digest), Some(rev)) = (
    instance.package_digest.as_deref(),
    instance.execution_grant_set_revision,
  ) {
    let version = installed_plugin_versions::get_optional(conn, digest)?.ok_or_else(|| {
      StorageError::PluginUnavailable(format!("installed package {digest} is missing for active pin"))
    })?;
    if version.plugin_id != instance.plugin_id {
      return Err(StorageError::PluginUnavailable(
        "package plugin id does not match instance pin".into(),
      ));
    }
    package_manifest_json = Some(version.manifest_json.clone());
    package_content_available = version.content_available;
    package_permission_request_digest = Some(version.permission_request_digest.clone());
    package_plugin_id = Some(version.plugin_id.clone());
    package_plugin_version = Some(version.version.clone());
    publisher_key_id = Some(version.publisher_key_id.clone());
    // Publisher lookup must succeed for package-backed pins; never default enabled=true.
    let publisher = plugin_publishers::get(conn, &version.publisher_key_id).map_err(|e| match e {
      StorageError::NotFound(_) => StorageError::PluginUnavailable(format!(
        "publisher {} is missing for package {digest}",
        version.publisher_key_id
      )),
      other => StorageError::PluginUnavailable(format!("publisher lookup failed for package {digest}: {other}")),
    })?;
    if publisher.fingerprint != version.publisher_fingerprint {
      return Err(StorageError::PluginUnavailable(
        "publisher fingerprint does not match installed package record".into(),
      ));
    }
    if publisher.key_id != version.publisher_key_id {
      return Err(StorageError::PluginUnavailable(
        "publisher key id does not match installed package record".into(),
      ));
    }
    publisher_fingerprint = Some(publisher.fingerprint);
    publisher_public_key_hex = Some(publisher.public_key_hex);
    publisher_source = Some(publisher.source);
    publisher_enabled = publisher.enabled;
    publisher_revoked = publisher.revoked;
    if publisher.revoked || !publisher.enabled {
      return Err(StorageError::PluginUnavailable(
        "publisher trust is revoked or disabled".into(),
      ));
    }
    // Missing grant is package/authority failure, never profile NotFound.
    grant_bundle = Some(
      plugin_permission_grants::get_bundle_for_subject_package_revision(
        conn,
        GrantSubjectKind::IntegrationInstance,
        instance.id,
        digest,
        rev,
      )
      .map_err(|e| match e {
        StorageError::NotFound(msg) => StorageError::PluginUnavailable(msg),
        other => other,
      })?,
    );
  }

  let runtime_pin = SnapshotRuntimeResolution {
    instance_id: instance.id,
    plugin_id: instance.plugin_id.clone(),
    runtime_kind: instance.runtime_kind.clone(),
    runtime_state: instance.runtime_state.clone(),
    instance_updated_at: instance.updated_at.clone(),
    instance_config_json: instance.config_json.clone(),
    package_digest: instance.package_digest.clone(),
    execution_grant_set_revision: instance.execution_grant_set_revision,
    package_manifest_json,
    package_content_available,
    package_permission_request_digest,
    package_plugin_id,
    package_plugin_version,
    publisher_key_id,
    publisher_fingerprint,
    publisher_public_key_hex,
    publisher_source,
    publisher_enabled,
    publisher_revoked,
    grant_bundle,
  };

  Ok(ProfileInvocationSnapshot {
    profile_id,
    profile_updated_at: dto.profile.updated_at,
    profile_enabled: dto.profile.enabled,
    profile_integration_instance_id: plugin.integration_instance_id,
    instance_id: instance.id,
    plugin_id: instance.plugin_id,
    capability_id,
    health_status: instance.health_status.as_str().to_string(),
    config_json: instance.config_json.into_bytes(),
    config_schema_version: instance.config_schema_version,
    preferences_json: preferences_json.into_bytes(),
    preferences_schema_version,
    runtime_pin,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::provider::ProxyMode;
  use crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID;
  use crate::domain::service_integration::{
    GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GoogleCloudConfigV1, IntegrationHealthStatus,
    IntegrationInstance,
  };
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::services::google_cloud::{GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID};
  use crate::services::network_broker::NetworkBroker;
  use crate::services::token_grant::{ExchangedToken, GoogleTokenExchanger, TokenGrantService};

  struct StubExchanger;
  impl GoogleTokenExchanger for StubExchanger {
    fn exchange(
      &self,
      _instance_id: Uuid,
      _scopes: Vec<String>,
      _now_unix_secs: u64,
      _cancel: Option<CancelToken>,
    ) -> Pin<Box<dyn Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>> {
      Box::pin(async {
        Ok(ExchangedToken {
          access_token: "t".into(),
          expires_in: 3600,
          credential_revision: 1,
        })
      })
    }
  }

  fn seed_instance(db: &Database, enabled: bool, health: IntegrationHealthStatus) -> Uuid {
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
          plugin_version: "1.1.0".into(),
          display_name: "Test".into(),
          enabled,
          config_json: serde_json::to_string(&config).unwrap(),
          config_schema_version: 1,
          health_status: health,
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
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();
    id
  }

  fn service(db: Database) -> ServiceCapabilityService {
    let defs = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let network = Arc::new(NetworkBroker::new(db.clone(), defs.clone()));
    let tokens = Arc::new(TokenGrantService::new(Arc::new(StubExchanger)));
    let handlers = Arc::new(
      crate::services::bundled_plugins::build_capability_registry(
        crate::services::bundled_plugins::HandlerDeps {
          db: db.clone(),
          broker: network,
          tokens,
        },
        &defs,
      )
      .unwrap(),
    );
    ServiceCapabilityService::new(db, defs, handlers)
  }

  #[test]
  fn service_capability_lookup_rejects_disabled_instance() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_instance(&db, false, IntegrationHealthStatus::Ready);
    let svc = service(db);
    let err = match svc.resolve_translate(id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID, b"{}".to_vec()) {
      Ok(_) => panic!("expected disabled rejection"),
      Err(e) => e,
    };
    assert_eq!(err.code, CapabilityErrorCode::PluginUnavailable);
  }

  #[test]
  fn service_capability_lookup_rejects_missing_capability() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_instance(&db, true, IntegrationHealthStatus::Ready);
    let svc = service(db);
    let err = match svc.resolve_translate(id, "speech.audio@1", b"{}".to_vec()) {
      Ok(_) => panic!("expected missing capability rejection"),
      Err(e) => e,
    };
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[test]
  fn service_capability_lookup_rejects_type_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_instance(&db, true, IntegrationHealthStatus::Ready);
    let svc = service(db);
    // detect capability registered as DetectLanguage; resolve_translate must fail closed.
    let err = match svc.resolve_translate(id, GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, b"{}".to_vec()) {
      Ok(_) => panic!("expected type mismatch"),
      Err(e) => e,
    };
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[test]
  fn service_capability_lookup_rejects_unconfigured() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_instance(&db, true, IntegrationHealthStatus::Unconfigured);
    let svc = service(db);
    let err = match svc.resolve_translate(id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID, b"{}".to_vec()) {
      Ok(_) => panic!("expected unconfigured rejection"),
      Err(e) => e,
    };
    assert_eq!(err.code, CapabilityErrorCode::InvalidConfiguration);
  }

  #[test]
  fn service_capability_lookup_rejects_unvalidated_and_degraded() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let unvalidated = seed_instance(&db, true, IntegrationHealthStatus::Unvalidated);
    let degraded = seed_instance(&db, true, IntegrationHealthStatus::Degraded);
    let svc = service(db);
    let err = svc
      .resolve_ocr(unvalidated, OCR_IMAGE_CAPABILITY_ID)
      .err()
      .expect("unvalidated must fail");
    assert_eq!(err.code, CapabilityErrorCode::InvalidConfiguration);
    let err = svc
      .resolve_ocr(degraded, OCR_IMAGE_CAPABILITY_ID)
      .err()
      .expect("degraded must fail");
    assert_eq!(err.code, CapabilityErrorCode::ProviderUnavailable);
  }

  #[test]
  fn service_capability_lookup_returns_translate_handler() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_instance(&db, true, IntegrationHealthStatus::Ready);
    let svc = service(db);
    assert!(
      svc
        .resolve_translate(id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID, b"{}".to_vec())
        .is_ok()
    );
    assert!(
      svc
        .resolve_detect(id, GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, b"{}".to_vec())
        .is_ok()
    );
  }

  #[test]
  fn service_capability_lookup_returns_ocr_handler() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_instance(&db, true, IntegrationHealthStatus::Ready);
    let svc = service(db);
    assert!(svc.resolve_ocr(id, OCR_IMAGE_CAPABILITY_ID).is_ok());
    // OCR handler must not resolve as translate.
    let err = match svc.resolve_translate(id, OCR_IMAGE_CAPABILITY_ID, b"{}".to_vec()) {
      Ok(_) => panic!("expected type mismatch for ocr as translate"),
      Err(e) => e,
    };
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }
}
