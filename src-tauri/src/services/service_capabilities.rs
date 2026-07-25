// ABOUTME: Typed capability handler registry and instance-aware capability lookup.
// ABOUTME: Verifies plugin presence, capability major version, enabled state, and handler kind.
use crate::domain::cancel::CancelToken;
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, DetectLanguageRequest, DetectLanguageResponse, ExecutionContext,
  OCR_IMAGE_CAPABILITY_ID, OcrImageRequest, OcrImageResponse, SPEECH_SYNTHESIZE_CAPABILITY_ID, SpeechSynthesizeRequest,
  SpeechSynthesizeResponse, TranslateTextRequest, TranslateTextResponse,
};
use crate::domain::service_integration::IntegrationHealthStatus;
use crate::error::StorageError;
use crate::repositories::integration_instances;
use crate::services::google_cloud::{
  GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID, GoogleCloudCapabilities,
};
use crate::services::google_translate_web::{
  GOOGLE_WEB_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID, GoogleTranslateWebCapabilities,
};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
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

  /// Build the production registry with Google Cloud Translate/Detect/OCR/TTS handlers.
  pub fn with_google_cloud(google: Arc<GoogleCloudCapabilities>) -> Self {
    let mut registry = Self::new();
    registry.register(
      crate::domain::service_integration::GOOGLE_CLOUD_PLUGIN_ID,
      GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID,
      CapabilityHandler::TranslateText(google.clone()),
    );
    registry.register(
      crate::domain::service_integration::GOOGLE_CLOUD_PLUGIN_ID,
      GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID,
      CapabilityHandler::DetectLanguage(google.clone()),
    );
    registry.register(
      crate::domain::service_integration::GOOGLE_CLOUD_PLUGIN_ID,
      OCR_IMAGE_CAPABILITY_ID,
      CapabilityHandler::OcrImage(google.clone()),
    );
    registry.register(
      crate::domain::service_integration::GOOGLE_CLOUD_PLUGIN_ID,
      SPEECH_SYNTHESIZE_CAPABILITY_ID,
      CapabilityHandler::SpeechSynthesize(google),
    );
    registry
  }

  /// Register credential-free Google Web Translate/Detect handlers.
  pub fn with_google_translate_web(mut self, web: Arc<GoogleTranslateWebCapabilities>) -> Self {
    self.register(
      crate::domain::service_integration::GOOGLE_TRANSLATE_WEB_PLUGIN_ID,
      GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID,
      CapabilityHandler::TranslateText(web.clone()),
    );
    self.register(
      crate::domain::service_integration::GOOGLE_TRANSLATE_WEB_PLUGIN_ID,
      GOOGLE_WEB_DETECT_LANGUAGE_CAPABILITY_ID,
      CapabilityHandler::DetectLanguage(web),
    );
    self
  }
}

/// Resolves handlers for configured integration instances.
#[derive(Clone)]
pub struct ServiceCapabilityService {
  db: Database,
  definition_registry: Arc<ServiceIntegrationRegistry>,
  handlers: Arc<ServiceCapabilityRegistry>,
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
    }
  }

  /// Look up a translate handler after verifying instance/plugin/capability state.
  pub fn resolve_translate(
    &self,
    instance_id: Uuid,
    capability_id: &str,
  ) -> Result<Arc<dyn TranslateTextCapability>, CapabilityError> {
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

  /// Look up a detect handler after verifying instance/plugin/capability state.
  pub fn resolve_detect(
    &self,
    instance_id: Uuid,
    capability_id: &str,
  ) -> Result<Arc<dyn DetectLanguageCapability>, CapabilityError> {
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

  /// Look up a speech synthesis handler after verifying instance/plugin/capability state.
  pub fn resolve_speech_synthesize(
    &self,
    instance_id: Uuid,
    capability_id: &str,
  ) -> Result<Arc<dyn SpeechSynthesizeCapability>, CapabilityError> {
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

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::provider::ProxyMode;
  use crate::domain::service_integration::{
    GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GoogleCloudConfigV1, IntegrationHealthStatus,
    IntegrationInstance,
  };
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::services::google_cloud::GoogleCloudCapabilities;
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
    let google = Arc::new(GoogleCloudCapabilities::new(db.clone(), network, tokens));
    let handlers = Arc::new(ServiceCapabilityRegistry::with_google_cloud(google));
    ServiceCapabilityService::new(db, defs, handlers)
  }

  #[test]
  fn service_capability_lookup_rejects_disabled_instance() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_instance(&db, false, IntegrationHealthStatus::Ready);
    let svc = service(db);
    let err = match svc.resolve_translate(id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID) {
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
    let err = match svc.resolve_translate(id, "speech.audio@1") {
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
    let err = match svc.resolve_translate(id, GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID) {
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
    let err = match svc.resolve_translate(id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID) {
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
    assert!(svc.resolve_translate(id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID).is_ok());
    assert!(svc.resolve_detect(id, GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID).is_ok());
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
    let err = match svc.resolve_translate(id, OCR_IMAGE_CAPABILITY_ID) {
      Ok(_) => panic!("expected type mismatch for ocr as translate"),
      Err(e) => e,
    };
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }
}
