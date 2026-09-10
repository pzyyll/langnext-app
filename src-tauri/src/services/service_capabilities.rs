// ABOUTME: Typed capability handler registry and instance-aware capability lookup.
// ABOUTME: Routes through RuntimeRouter so SQLite pins select one executor without fallback.
use crate::domain::cancel::CancelToken;
use crate::domain::integration_capability_health::CapabilityHealthStatus;
use crate::domain::runtime_lifecycle::{ExecutionGrantSetBundle, GrantSubjectKind};
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, DetectLanguageRequest, DetectLanguageResponse, ExecutionContext,
  OcrImageRequest, OcrImageResponse, ProviderAttemptTracker, SpeechSynthesizeRequest, SpeechSynthesizeResponse,
  TranslateTextRequest, TranslateTextResponse,
};
use crate::domain::service_integration::IntegrationHealthStatus;
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use crate::repositories::integration_capability_health;
use crate::repositories::integration_instances;
use crate::repositories::plugin_permission_grants;
use crate::services::plugin_catalog::{PluginCatalog, resolve_pinned_content};
use crate::services::runtime_router::{
  ResolvedDetect, ResolvedOcr, ResolvedTranslate, RuntimeRouter, SnapshotRuntimeResolution,
};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::wasm_runtime::host::{BrokerFetchError, BrokerFetchOutcome, BrokerFetchRequest, BrokerHandle};
use crate::services::wasm_runtime::{
  WasmDetectLanguageAdapter, WasmOcrImageAdapter, WasmRuntime, WasmSpeechSynthesizeAdapter, WasmTranslateTextAdapter,
};
use crate::storage::Database;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use uuid::Uuid;

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

/// Resolves capability adapters for configured integration instances via the runtime router.
#[derive(Clone)]
pub struct ServiceCapabilityService {
  db: Database,
  definition_registry: Arc<ServiceIntegrationRegistry>,
  /// Authoritative adapter selection. Always set in production; tests may use `with_router`.
  router: Option<RuntimeRouter>,
  wasm_runtime: Option<Arc<WasmRuntime>>,
  /// Factory for Wasm guest broker handles. Production wires `NetworkBrokerHandle` over the
  /// bounded HTTP transport; defaults to `DeniedBroker`. Phase 5 google-web Wasm execution
  /// requires a real transport.
  broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync>,
  /// Immutable plugin content catalog. Pins resolve through it; never through mutable files.
  catalog: Option<Arc<PluginCatalog>>,
}

/// Deny-everything broker used as the default before `with_broker_factory` wires a transport.
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

/// Default broker handle factory that denies every guest fetch; production replaces it via
/// `with_broker_factory`.
fn denied_broker_factory() -> Box<dyn BrokerHandle> {
  Box::new(DeniedBroker) as Box<dyn BrokerHandle>
}

impl ServiceCapabilityService {
  pub fn new(db: Database, definition_registry: Arc<ServiceIntegrationRegistry>) -> Self {
    Self {
      db,
      definition_registry,
      router: None,
      wasm_runtime: None,
      broker_factory: Arc::new(denied_broker_factory),
      catalog: None,
    }
  }

  /// Attach the runtime router and shared Wasm runtime (Phase 4 production wiring).
  /// Wire the immutable plugin content catalog for pinned content resolution.
  pub fn with_catalog(mut self, catalog: Arc<PluginCatalog>) -> Self {
    self.catalog = Some(catalog);
    self
  }

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

  /// Persist a sanitized capability result only after host provenance confirms a completed
  /// provider attempt. Preflight, resolution, and cancellation are deliberate no-ops.
  pub fn record_provider_result(
    &self,
    instance_id: Uuid,
    capability_id: &str,
    provider_attempt: &ProviderAttemptTracker,
    success: bool,
    error_code: Option<CapabilityErrorCode>,
  ) -> Result<(), StorageError> {
    self.record_provider_result_if_current(instance_id, capability_id, provider_attempt, success, error_code, None)
  }

  /// Persist health only when the authority revision captured before dispatch is still current.
  /// This prevents an older in-flight call from recreating a row after config, credentials, or
  /// runtime authority has been invalidated.
  pub fn record_provider_result_if_current(
    &self,
    instance_id: Uuid,
    capability_id: &str,
    provider_attempt: &ProviderAttemptTracker,
    success: bool,
    error_code: Option<CapabilityErrorCode>,
    expected_updated_at: Option<&str>,
  ) -> Result<(), StorageError> {
    if provider_attempt.state() != crate::domain::service_capability::ProviderAttemptState::Completed {
      return Ok(());
    }
    let status = if success {
      CapabilityHealthStatus::Ready
    } else {
      CapabilityHealthStatus::Degraded
    };
    let sanitized_code = if success {
      None
    } else {
      error_code.map(CapabilityErrorCode::as_str)
    };
    let checked_at = now_rfc3339();
    self.db.transaction(|uow| {
      if let Some(expected_updated_at) = expected_updated_at {
        let current = integration_instances::get(uow.conn(), instance_id)?;
        if current.updated_at != expected_updated_at {
          return Ok(());
        }
      }
      integration_capability_health::upsert_result(
        uow.conn(),
        instance_id,
        capability_id,
        status,
        sanitized_code,
        &checked_at,
      )
    })
  }

  /// One SQLite-authoritative snapshot for a profile capability invocation.
  /// Uses `read_snapshot` so pin/grant/package/config/prefs share one committed view.
  pub fn load_profile_invocation_snapshot(
    &self,
    profile_id: Uuid,
    capability_kind: ProfileCapabilityKind,
  ) -> Result<ProfileInvocationSnapshot, ProfileSnapshotLoadError> {
    self
      .db
      .read_snapshot(|conn| {
        load_profile_invocation_snapshot_conn(conn, profile_id, capability_kind, self.catalog.as_deref())
      })
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

  /// Full authoritative recheck after external FS rehash: profile + pin + package + grant + prefs.
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
      || a.plugin_source != b.plugin_source
    {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "package authority changed concurrently during invocation",
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
      crate::services::runtime_router::RuntimeAdapter::TrustedNativeWorker { .. } => Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "trusted native worker is not supported for this capability path",
      )),
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
    Err(CapabilityError::new(
      CapabilityErrorCode::PluginUnavailable,
      "runtime router is not configured; package-only builds require router-based resolution",
    ))
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
      crate::services::runtime_router::RuntimeAdapter::TrustedNativeWorker { .. } => Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "trusted native worker is not supported for this capability path",
      )),
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
    Err(CapabilityError::new(
      CapabilityErrorCode::PluginUnavailable,
      "runtime router is not configured; package-only builds require router-based resolution",
    ))
  }

  pub fn resolve_ocr(
    &self,
    instance_id: Uuid,
    capability_id: &str,
  ) -> Result<Arc<dyn OcrImageCapability>, CapabilityError> {
    if let Some(router) = &self.router {
      let resolved = router.resolve_ocr(instance_id, capability_id)?;
      return match resolved {
        ResolvedOcr::Wasm {
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
            .map_err(|_| CapabilityError::new(CapabilityErrorCode::PluginUnavailable, "component compile failed"))?;
          // Resolve the authoritative pin again after external archive verification; a changed
          // package/grant identity discards the compiled adapter instead of mixing executor state.
          let rechecked = router.resolve_ocr(instance_id, capability_id)?;
          let (rechecked_digest, rechecked_revision) = match rechecked {
            ResolvedOcr::Wasm {
              package_digest, grant, ..
            } => (package_digest, grant.revision().as_u64()),
            ResolvedOcr::Native { .. } => {
              return Err(CapabilityError::new(
                CapabilityErrorCode::PluginUnavailable,
                "runtime changed during OCR resolution",
              ));
            }
          };
          if rechecked_digest != package_digest || rechecked_revision != grant.revision().as_u64() {
            return Err(CapabilityError::new(
              CapabilityErrorCode::PluginUnavailable,
              "runtime pin changed during OCR resolution",
            ));
          }
          let config_json = self
            .db
            .read(|conn| integration_instances::get(conn, instance_id))
            .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to load instance"))?
            .config_json
            .into_bytes();
          Ok(Arc::new(WasmOcrImageAdapter::new(
            runtime.clone(),
            Arc::new(verified),
            grant,
            capability_id.to_string(),
            config_json,
            self.broker_factory.clone(),
          )))
        }
        ResolvedOcr::Native {
          package_digest,
          content_dir,
          worker_exe,
          worker_sha256,
          model_root,
          model_set_digest,
          model_files,
          runtime_set_digest,
          model_api_version,
          runtime_dependencies,
          grant: _,
        } => Ok(Arc::new(crate::services::native_workers::NativeOcrImageAdapter::new(
          package_digest,
          content_dir,
          worker_exe,
          worker_sha256,
          model_root,
          model_set_digest,
          model_files,
          runtime_set_digest,
          model_api_version,
          runtime_dependencies,
        ))),
      };
    }
    Err(CapabilityError::new(
      CapabilityErrorCode::PluginUnavailable,
      "runtime router is not configured; package-only builds require router-based resolution",
    ))
  }

  /// Look up a speech synthesis handler after authoritative runtime resolution.
  pub fn resolve_speech_synthesize(
    &self,
    instance_id: Uuid,
    capability_id: &str,
  ) -> Result<Arc<dyn SpeechSynthesizeCapability>, CapabilityError> {
    if let Some(router) = &self.router {
      return match router.resolve(instance_id, capability_id)? {
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
          // Re-resolve after external archive verification so a concurrent package/grant change
          // cannot return an adapter backed by stale runtime authority.
          let rechecked = router.resolve(instance_id, capability_id)?;
          let (rechecked_digest, rechecked_artifact, rechecked_grant) = match rechecked {
            crate::services::runtime_router::RuntimeAdapter::WasmComponent {
              package_digest,
              artifact_digest,
              grant,
              ..
            } => (package_digest, artifact_digest, grant),
            crate::services::runtime_router::RuntimeAdapter::TrustedNativeWorker { .. } => {
              return Err(CapabilityError::new(
                CapabilityErrorCode::PluginUnavailable,
                "runtime changed during speech resolution",
              ));
            }
          };
          if rechecked_digest != package_digest
            || rechecked_artifact != artifact_digest
            || rechecked_grant.revision() != grant.revision()
            || rechecked_grant.authority_digest() != grant.authority_digest()
          {
            return Err(CapabilityError::new(
              CapabilityErrorCode::PluginUnavailable,
              "runtime authority changed during speech resolution",
            ));
          }
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
        crate::services::runtime_router::RuntimeAdapter::TrustedNativeWorker { .. } => Err(CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "trusted native worker is not supported for this capability path",
        )),
      };
    }
    Err(CapabilityError::new(
      CapabilityErrorCode::PluginUnavailable,
      "runtime router is not configured; package-only builds require router-based resolution",
    ))
  }

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
  execution_context_with_tracker(
    request_id,
    cancel,
    instance_id,
    plugin_id,
    capability_id,
    ProviderAttemptTracker::new(),
  )
}

pub fn execution_context_with_tracker(
  request_id: impl Into<String>,
  cancel: CancelToken,
  instance_id: Uuid,
  plugin_id: impl Into<String>,
  capability_id: impl Into<String>,
  provider_attempt: ProviderAttemptTracker,
) -> ExecutionContext {
  ExecutionContext {
    request_id: request_id.into(),
    cancel,
    deadline: None,
    integration_instance_id: instance_id,
    plugin_id: plugin_id.into(),
    capability_id: capability_id.into(),
    provider_attempt,
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
  catalog: Option<&PluginCatalog>,
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

  // Capture content identity and grant authority in the same snapshot transaction.
  // Package-backed pins fail closed when the exact digest is absent from the catalog.
  let mut package_manifest_json = None;
  let mut package_content_available = false;
  let mut package_permission_request_digest = None;
  let mut package_plugin_id = None;
  let mut package_plugin_version = None;
  let mut plugin_source = None;
  let mut grant_bundle: Option<ExecutionGrantSetBundle> = None;
  if let (Some(digest), Some(rev)) = (
    instance.package_digest.as_deref(),
    instance.execution_grant_set_revision,
  ) {
    let content = resolve_pinned_content(catalog, conn, digest)?.ok_or_else(|| {
      StorageError::PluginUnavailable(format!("installed package {digest} is missing for active pin"))
    })?;
    if content.plugin_id != instance.plugin_id {
      return Err(StorageError::PluginUnavailable(
        "package plugin id does not match instance pin".into(),
      ));
    }
    package_permission_request_digest = Some(crate::domain::plugin_catalog::compute_permission_request_digest(
      &content.manifest,
    ));
    package_manifest_json = Some(content.manifest_json.clone());
    package_content_available = true;
    package_plugin_id = Some(content.plugin_id.clone());
    package_plugin_version = Some(content.version.clone());
    plugin_source = Some(content.source);
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
    plugin_source,
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
  use crate::services::runtime_lifecycle::RuntimeLifecycleService;
  use crate::services::runtime_router::RuntimeRouter;
  use crate::services::token_grant::TokenGrantService;
  use crate::services::wasm_runtime::WasmRuntime;
  use std::path::Path;

  use crate::services::token_grant::{
    ExchangedToken, GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID, TokenExchanger, TokenInjectionKind,
  };

  struct StubExchanger;
  impl TokenExchanger for StubExchanger {
    fn driver_id(&self) -> &'static str {
      GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID
    }

    fn injection_kind(&self) -> TokenInjectionKind {
      TokenInjectionKind::BearerHeader
    }

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
          runtime_kind: "wasm-component".into(),
          package_digest: Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()),
          execution_grant_set_revision: None,
          runtime_state: "pending_activation".into(),
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

  struct Fixture {
    _dir: tempfile::TempDir,
    db: Database,
    catalog: Arc<crate::services::plugin_catalog::PluginCatalog>,
    lifecycle: crate::services::runtime_lifecycle::RuntimeLifecycleService,
    vault: Arc<dyn crate::credentials::CredentialVault>,
    caps: ServiceCapabilityService,
    package_digest: String,
    instance_id: Uuid,
  }

  impl Fixture {
    /// Pin the seeded instance to the installed google-cloud package through the public
    /// upgrade seam (preview + apply), writing the exact grant the router verifies.
    fn activate_package(&self, instance_id: Uuid) {
      let preview = self
        .lifecycle
        .preview_upgrade(instance_id, &self.package_digest)
        .expect("upgrade preview");
      self
        .lifecycle
        .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
          preview_id: preview.preview_id,
          acknowledge_permissions: true,
        })
        .expect("apply upgrade");
    }
  }

  /// Real catalog fixture: the committed google-cloud archive loads through the genuine
  /// catalog and its definition is projected from the immutable snapshot; dispatch resolves
  /// through the Wasm runtime router.
  fn fixture(db: Database, dir: &Path) -> Fixture {
    let catalog = crate::services::test_support::catalog_with_builtins(
      db.clone(),
      dir,
      &[crate::services::test_support::GOOGLE_CLOUD_ARCHIVE],
    );
    let package_digest = crate::services::test_support::fixture_digest(&catalog, GOOGLE_CLOUD_PLUGIN_ID);
    let registry = crate::services::test_support::registry_from_catalog(&catalog);
    let wasm = Arc::new(WasmRuntime::new().unwrap());
    let tokens = Arc::new(TokenGrantService::new(vec![Arc::new(StubExchanger)]).unwrap());
    let vault: Arc<dyn crate::credentials::CredentialVault> =
      Arc::new(crate::credentials::MemoryCredentialVault::default());
    let lifecycle = RuntimeLifecycleService::new(db.clone(), catalog.clone(), registry.clone())
      .with_runtime(wasm.clone(), tokens)
      .with_vault(vault.clone());
    let router = RuntimeRouter::new(db.clone(), registry.clone(), catalog.clone(), wasm.clone());
    let caps = ServiceCapabilityService::new(db.clone(), registry)
      .with_catalog(catalog.clone())
      .with_router(router, wasm);
    Fixture {
      _dir: tempfile::tempdir().unwrap(),
      db: db.clone(),
      catalog,
      lifecycle,
      vault,
      caps,
      package_digest,
      instance_id: new_id(),
    }
  }

  fn seed_fixture(fixture: &Fixture, enabled: bool, health: IntegrationHealthStatus) -> Uuid {
    let id = new_id();
    let now = now_rfc3339();
    let config = GoogleCloudConfigV1 {
      project_id: "demo".into(),
      location: GOOGLE_CLOUD_DEFAULT_LOCATION.into(),
      proxy_mode: ProxyMode::Direct,
    };
    // The google-cloud package requires a service-account credential; bind one so the upgrade
    // seam verifies slot compatibility against the target package.
    let vault = fixture.vault.clone();
    let credential_ref = format!("integration/{id}/service-account-json");
    vault
      .set(&credential_ref, r#"{"client_email":"x","private_key":"y"}"#)
      .unwrap();
    fixture
      .db
      .transaction(|uow| {
        integration_instances::insert(
          uow.conn(),
          &IntegrationInstance {
            id,
            plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
            plugin_version: "1.2.0".into(),
            display_name: "Test".into(),
            enabled,
            config_json: serde_json::to_string(&config).unwrap(),
            config_schema_version: 1,
            health_status: health,
            last_validated_at: None,
            last_error_code: None,
            runtime_kind: "wasm-component".into(),
            package_digest: Some("a".repeat(64)),
            execution_grant_set_revision: None,
            runtime_state: "pending_activation".into(),
            runtime_error_code: None,
            runtime_error_message: None,
            runtime_requirement_json: None,
            created_at: now.clone(),
            updated_at: now.clone(),
          },
        )?;
        crate::repositories::integration_credential_bindings::insert(
          uow.conn(),
          &crate::domain::service_integration::IntegrationCredentialBinding {
            id: new_id(),
            integration_instance_id: id,
            slot_id: "service-account-json".into(),
            credential_ref: Some(credential_ref),
            credential_revision: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
          },
        )?;
        Ok::<_, crate::error::StorageError>(())
      })
      .unwrap();
    id
  }

  #[test]
  fn service_capability_lookup_rejects_disabled_instance() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let fixture = fixture(db, dir.path());
    let id = seed_fixture(&fixture, false, IntegrationHealthStatus::Ready);
    let err = match fixture
      .caps
      .resolve_translate(id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID, b"{}".to_vec())
    {
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
    let fixture = fixture(db, dir.path());
    let id = seed_fixture(&fixture, true, IntegrationHealthStatus::Ready);
    fixture.activate_package(id);
    // The activated grant covers only manifest-declared capabilities; an undeclared id fails
    // closed with PermissionDenied at the grant check.
    let err = match fixture.caps.resolve_translate(id, "speech.audio@1", b"{}".to_vec()) {
      Ok(_) => panic!("expected missing capability rejection"),
      Err(e) => e,
    };
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
    let err = match fixture.caps.resolve_translate(id, "translate.text@2", b"{}".to_vec()) {
      Ok(_) => panic!("expected wrong-major rejection"),
      Err(e) => e,
    };
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[test]
  fn service_capability_lookup_rejects_type_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let fixture = fixture(db, dir.path());
    let id = seed_fixture(&fixture, true, IntegrationHealthStatus::Ready);
    fixture.activate_package(id);
    // Capability dispatch type is owned by the caller; a capability outside the granted set
    // resolving through the translate surface fails closed at the grant check.
    let err = match fixture
      .caps
      .resolve_translate(id, "speech.synthesize@2", b"{}".to_vec())
    {
      Ok(_) => panic!("expected ungranted rejection"),
      Err(e) => e,
    };
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[test]
  fn service_capability_lookup_rejects_unconfigured() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let fixture = fixture(db, dir.path());
    let id = seed_fixture(&fixture, true, IntegrationHealthStatus::Unconfigured);
    let err = match fixture
      .caps
      .resolve_translate(id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID, b"{}".to_vec())
    {
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
    let fixture = fixture(db, dir.path());
    let unvalidated = seed_fixture(&fixture, true, IntegrationHealthStatus::Unvalidated);
    let degraded = seed_fixture(&fixture, true, IntegrationHealthStatus::Degraded);
    let err = fixture
      .caps
      .resolve_ocr(unvalidated, OCR_IMAGE_CAPABILITY_ID)
      .err()
      .expect("unvalidated must fail");
    assert_eq!(err.code, CapabilityErrorCode::InvalidConfiguration);
    let err = fixture
      .caps
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
    let fixture = fixture(db, dir.path());
    let id = seed_fixture(&fixture, true, IntegrationHealthStatus::Ready);
    fixture.activate_package(id);
    assert!(
      fixture
        .caps
        .resolve_translate(id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID, b"{}".to_vec())
        .is_ok()
    );
    assert!(
      fixture
        .caps
        .resolve_detect(id, GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, b"{}".to_vec())
        .is_ok()
    );
  }

  #[test]
  fn service_capability_lookup_returns_ocr_handler() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let fixture = fixture(db, dir.path());
    let id = seed_fixture(&fixture, true, IntegrationHealthStatus::Ready);
    fixture.activate_package(id);
    assert!(fixture.caps.resolve_ocr(id, OCR_IMAGE_CAPABILITY_ID).is_ok());
    // A capability outside the granted package set must not resolve as translate.
    let err = match fixture.caps.resolve_translate(id, "ocr.image@2", b"{}".to_vec()) {
      Ok(_) => panic!("expected ungranted capability rejection"),
      Err(e) => e,
    };
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }
}
