// ABOUTME: Installed Google Cloud package conformance through verifier, Wasm, broker, and Blob resources.
// ABOUTME: Uses fixture OAuth/transport boundaries only; guest code never receives credentials or tokens.
#![cfg(test)]

use crate::credentials::{CredentialVault, MemoryCredentialVault};
use crate::domain::cancel::CancelToken;
use crate::domain::import_export::ImportConflictMode;
use crate::domain::integration_capability_health::{CapabilityHealthRecord, CapabilityHealthStatus};
use crate::domain::ocr_service::{OcrProviderType, OcrRecognizeInput, OcrService};
use crate::domain::plugin_resource::NetworkResponseBodyModes;
use crate::domain::provider_http::ProviderHttpStreamEvent;
use crate::domain::runtime_lifecycle::{ExecutionGrantSetBundle, GrantSubjectKind};
use crate::domain::runtime_plugin::{
  AuthPolicyId, CapabilityId, ComponentArtifactDigest, ExecutionGrantSet, HttpMethod, HttpsOrigin, NetworkGrantEntry,
  NetworkOriginKind, NetworkResourceMode, PackageDigest, PackageIdentity, PluginId,
  ResourceLimits as RuntimeResourceLimits, RuntimeIdentity, SemVerVersion,
};
use crate::domain::service_capability::{
  CapabilityErrorCode, DetectLanguageRequest, ExecutionContext, OCR_IMAGE_CAPABILITY_ID, OcrImageOperation,
  OcrImagePreferences, OcrImageRequest, ProviderAttemptTracker, SpeechSynthesizeRequest, TranslateTextRequest,
};
use crate::domain::service_integration::{
  GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT, IntegrationCredentialBinding, IntegrationHealthStatus,
  IntegrationInstance, IntegrationInstanceWrite,
};
use crate::domain::speech_service::{SpeechService, SpeechSynthesizeInput};
use crate::domain::time::now_rfc3339;
use crate::domain::translation_profile::{
  GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION, PluginCapabilityEngine, TranslationProfile, TranslationProfileDto,
  TranslationProfileEngine,
};
use crate::repositories::{
  integration_capability_health, integration_credential_bindings, integration_instances, ocr_services,
  plugin_permission_grants, speech_services, translation_profiles,
};
use crate::services::auth_policies::{
  GOOGLE_CLOUD_TEXT_TO_SPEECH_SCOPE, GOOGLE_CLOUD_TRANSLATION_SCOPE, GOOGLE_CLOUD_VISION_SCOPE,
};
use crate::services::bounded_http::{BoundedHttpResponse, PreparedHttpRequest, RawHttpTransport};
use crate::services::bundled_plugins::{HandlerDeps, build_capability_registry};
use crate::services::import_export::ImportExportService;
use crate::services::ocr_services::OcrServiceService;
use crate::services::plugin_package::{public_sha256_hex, verify_package_bytes};
use crate::services::plugin_store::PluginPackageService;
use crate::services::runtime_lifecycle::{RuntimeLifecycleService, UpgradeApplyFault};
use crate::services::runtime_router::RuntimeRouter;
use crate::services::service_capabilities::{CapabilityHandler, ServiceCapabilityRegistry, ServiceCapabilityService};
use crate::services::service_capabilities::{
  DetectLanguageCapability, OcrImageCapability, SpeechSynthesizeCapability, TranslateTextCapability,
};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::service_integrations::ServiceIntegrationService;
use crate::services::speech_services::SpeechServiceService;
use crate::services::token_grant::{ExchangedToken, GoogleTokenExchanger, TokenGrantService};
use crate::services::wasm_runtime::host::BrokerHandle;
use crate::services::wasm_runtime::network_handle::NetworkBrokerHandle;
use crate::services::wasm_runtime::{
  WasmDetectLanguageAdapter, WasmOcrImageAdapter, WasmRuntime, WasmSpeechSynthesizeAdapter, WasmTranslateTextAdapter,
};
use crate::storage::Database;
use ed25519_dalek::Signer;
use std::collections::HashMap;
use std::future::Future;
use std::io::Write;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
use uuid::Uuid;

const PACKAGE_BYTES: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/fixtures/com.langnext.google-cloud-1.2.0.lnplugin"
));
const VENDOR_PUBLIC_KEY_HEX: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/fixtures/packages/keys/vendor-public-key.hex"
));
const TRANSLATE_REQUEST_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/translate/request.json"
));
const TRANSLATE_SUCCESS_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/translate/success.json"
));
const DETECT_REQUEST_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/detect/request.json"
));
const DETECT_SUCCESS_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/detect/success.json"
));
const VISION_REQUEST_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/vision/request.json"
));
const VISION_SUCCESS_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/vision/success.json"
));
const TTS_REQUEST_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/tts/request.json"
));
const TTS_SUCCESS_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/tts/success.json"
));
const INPUT_PNG: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/vision/input.png"
));
const INVALID_PNG: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/vision/invalid.png"
));
const OVERSIZED_PNG: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/vision/oversized.png"
));
const EXPECTED_MP3: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-cloud/tests/fixtures/tts/expected.mp3"
));
const OCR_TRAP_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-ocr-trap-component/fixtures/langnext-conformance-ocr-trap.wasm"
));
const OCR_OVERSIZED_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-ocr-oversized-component/fixtures/langnext-conformance-ocr-oversized.wasm"
));

struct CaptureTransport {
  calls: AtomicUsize,
  last: Mutex<Option<PreparedHttpRequest>>,
  response: Mutex<BoundedHttpResponse>,
}

impl RawHttpTransport for CaptureTransport {
  fn request(
    &self,
    prepared: PreparedHttpRequest,
  ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>> {
    self.calls.fetch_add(1, Ordering::SeqCst);
    *self.last.lock().unwrap() = Some(prepared);
    let response = self.response.lock().unwrap().clone();
    Box::pin(async move { Ok(response) })
  }

  fn stream(
    &self,
    _prepared: PreparedHttpRequest,
    _cancel: CancelToken,
    _on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send>,
  ) -> Pin<Box<dyn Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
    Box::pin(async { Err(crate::error::StorageError::Validation("stream unsupported".into())) })
  }
}

struct FixtureExchanger {
  calls: AtomicUsize,
  recorded_scopes: Mutex<Vec<Vec<String>>>,
}

impl FixtureExchanger {
  fn recording() -> Self {
    FixtureExchanger {
      calls: AtomicUsize::new(0),
      recorded_scopes: Mutex::new(Vec::new()),
    }
  }
}

impl GoogleTokenExchanger for FixtureExchanger {
  fn exchange(
    &self,
    _instance_id: Uuid,
    scopes: Vec<String>,
    _now_unix_secs: u64,
    cancel: Option<CancelToken>,
  ) -> Pin<
    Box<dyn Future<Output = Result<ExchangedToken, crate::domain::service_capability::CapabilityError>> + Send + '_>,
  > {
    Box::pin(async move {
      if cancel.as_ref().is_some_and(CancelToken::is_cancelled) {
        return Err(crate::domain::service_capability::CapabilityError::new(
          CapabilityErrorCode::Cancelled,
          "cancelled",
        ));
      }
      self.calls.fetch_add(1, Ordering::SeqCst);
      self.recorded_scopes.lock().unwrap().push(scopes);
      Ok(ExchangedToken {
        access_token: "fixture-token".into(),
        expires_in: 3600,
        credential_revision: 1,
      })
    })
  }
}

struct FailingExchanger;

impl GoogleTokenExchanger for FailingExchanger {
  fn exchange(
    &self,
    _instance_id: Uuid,
    _scopes: Vec<String>,
    _now_unix_secs: u64,
    _cancel: Option<CancelToken>,
  ) -> Pin<
    Box<dyn Future<Output = Result<ExchangedToken, crate::domain::service_capability::CapabilityError>> + Send + '_>,
  > {
    Box::pin(async {
      Err(crate::domain::service_capability::CapabilityError::new(
        CapabilityErrorCode::Auth,
        "fixture token exchange failed",
      ))
    })
  }
}

struct DeadlineCaptureBroker {
  deadline: Arc<Mutex<Option<std::time::Instant>>>,
}

impl BrokerHandle for DeadlineCaptureBroker {
  fn fetch(
    &self,
    _principal: &crate::domain::runtime_plugin::PluginPrincipal,
    _grant: &ExecutionGrantSet,
    _request: crate::services::wasm_runtime::host::BrokerFetchRequest,
    _authorization: crate::services::wasm_runtime::host::BrokerAuthorization,
    _cancel: &CancelToken,
    deadline: Option<std::time::Instant>,
  ) -> Pin<Box<dyn Future<Output = crate::services::wasm_runtime::host::BrokerFetchOutcome> + Send + '_>> {
    *self.deadline.lock().unwrap() = deadline;
    Box::pin(async {
      Ok(crate::services::wasm_runtime::host::BrokerFetchResponse {
        status: 200,
        headers: vec![(String::from("content-type"), String::from("application/json"))],
        body: crate::services::wasm_runtime::host::BrokerResponseBody::Json(TTS_SUCCESS_FIXTURE.as_bytes().to_vec()),
      })
    })
  }
}

struct FailingTransport;

impl RawHttpTransport for FailingTransport {
  fn request(
    &self,
    _prepared: PreparedHttpRequest,
  ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>> {
    Box::pin(async {
      Err(crate::error::StorageError::Validation(
        "fixture transport failed".into(),
      ))
    })
  }

  fn stream(
    &self,
    _prepared: PreparedHttpRequest,
    _cancel: CancelToken,
    _on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send>,
  ) -> Pin<Box<dyn Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
    Box::pin(async { Err(crate::error::StorageError::Validation("fixture stream failed".into())) })
  }
}

struct InstalledFixture {
  package_digest: PackageDigest,
  runtime: Arc<WasmRuntime>,
  tokens: Arc<TokenGrantService>,
  exchanger: Arc<FixtureExchanger>,
  transport: Arc<CaptureTransport>,
  package: crate::services::plugin_package::VerifiedPackage,
}

fn installed_fixture() -> InstalledFixture {
  let package = verify_package_bytes(PACKAGE_BYTES, VENDOR_PUBLIC_KEY_HEX.trim()).expect("fixture package verifies");
  let runtime = Arc::new(WasmRuntime::new().expect("Wasmtime runtime"));
  let exchanger = Arc::new(FixtureExchanger::recording());
  let tokens = Arc::new(TokenGrantService::new(exchanger.clone()));
  let transport = Arc::new(CaptureTransport {
    calls: AtomicUsize::new(0),
    last: Mutex::new(None),
    response: Mutex::new(json_response(200, r#"{}"#)),
  });
  InstalledFixture {
    package_digest: PackageDigest::parse(&package.package_digest).unwrap(),
    runtime,
    tokens,
    exchanger,
    transport,
    package,
  }
}

fn json_response(status: u16, body: &str) -> BoundedHttpResponse {
  BoundedHttpResponse {
    status,
    headers: HashMap::from([(String::from("content-type"), String::from("application/json"))]),
    body: body.as_bytes().to_vec(),
  }
}

fn config() -> Vec<u8> {
  br#"{"project-id":"demo-project","location":"global","proxy-mode":"direct"}"#.to_vec()
}

fn artifact(
  fixture: &InstalledFixture,
  path: &str,
) -> (Arc<crate::services::wasm_runtime::executor::VerifiedComponent>, String) {
  let entry = fixture
    .package
    .manifest
    .files
    .iter()
    .find(|entry| entry.path == path)
    .expect("artifact in signed index");
  let bytes = fixture.package.extracted_files.get(path).expect("artifact bytes");
  let artifact_digest = ComponentArtifactDigest::parse(&entry.sha256).unwrap();
  let verified = fixture
    .runtime
    .compile_component(&fixture.package_digest, &artifact_digest, bytes)
    .expect("compile verified artifact");
  (Arc::new(verified), entry.sha256.clone())
}

fn grant_for(fixture: &InstalledFixture, instance_id: Uuid, capability_id: &str) -> ExecutionGrantSet {
  let (endpoint, origin) = match capability_id {
    "translate.text@1" | "translate.detect@1" => ("translate", "https://translation.googleapis.com"),
    OCR_IMAGE_CAPABILITY_ID => ("vision", "https://vision.googleapis.com"),
    "speech.synthesize@1" => ("text-to-speech", "https://texttospeech.googleapis.com"),
    _ => panic!("unsupported fixture capability"),
  };
  let response_modes = if capability_id == "speech.synthesize@1" {
    NetworkResponseBodyModes::JSON_AND_BYTES
  } else {
    NetworkResponseBodyModes::JSON_ONLY
  };
  let response_limit = if capability_id == "speech.synthesize@1" {
    crate::domain::service_capability::SPEECH_PROVIDER_RESPONSE_MAX_BYTES as u64
  } else {
    crate::domain::runtime_plugin::RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES
  };
  let timeout = if capability_id == "speech.synthesize@1" {
    60_000
  } else {
    20_000
  };
  let limits = RuntimeResourceLimits::new(
    crate::domain::runtime_plugin::RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES,
    response_limit,
    crate::domain::runtime_plugin::RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES,
    timeout,
  )
  .unwrap();
  let capability = CapabilityId::parse(capability_id).unwrap();
  let network = NetworkGrantEntry::with_mode_origin_and_response_modes(
    capability.clone(),
    crate::domain::runtime_plugin::EndpointId::parse(endpoint).unwrap(),
    HttpsOrigin::parse(origin).unwrap(),
    NetworkOriginKind::HostFixed,
    HttpMethod::Post,
    AuthPolicyId::parse("com.langnext.auth.google-service-account").unwrap(),
    NetworkResourceMode::Bounded,
    limits,
    response_modes,
  );
  ExecutionGrantSet::initial(
    instance_id,
    RuntimeIdentity::Package(PackageIdentity {
      package_digest: fixture.package_digest.clone(),
    }),
    PluginId::parse(GOOGLE_CLOUD_PLUGIN_ID).unwrap(),
    SemVerVersion::parse("1.2.0").unwrap(),
    vec![capability],
    vec![network],
    vec![],
  )
  .unwrap()
}

fn context(instance_id: Uuid, capability_id: &str, request_id: &str) -> ExecutionContext {
  ExecutionContext {
    request_id: request_id.into(),
    cancel: CancelToken::new(),
    deadline: None,
    integration_instance_id: instance_id,
    plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
    capability_id: capability_id.into(),
    provider_attempt: ProviderAttemptTracker::new(),
  }
}

struct BlockingTransport {
  calls: AtomicUsize,
  started: Arc<Notify>,
  dropped: Arc<std::sync::atomic::AtomicBool>,
}

struct DropFlag(Arc<std::sync::atomic::AtomicBool>);

impl Drop for DropFlag {
  fn drop(&mut self) {
    self.0.store(true, Ordering::SeqCst);
  }
}

impl RawHttpTransport for BlockingTransport {
  fn request(
    &self,
    _prepared: PreparedHttpRequest,
  ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>> {
    self.calls.fetch_add(1, Ordering::SeqCst);
    let started = self.started.clone();
    let dropped = self.dropped.clone();
    Box::pin(async move {
      started.notify_one();
      let _guard = DropFlag(dropped);
      std::future::pending::<()>().await;
      unreachable!()
    })
  }

  fn stream(
    &self,
    _prepared: PreparedHttpRequest,
    _cancel: CancelToken,
    _on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send>,
  ) -> Pin<Box<dyn Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
    Box::pin(async { Err(crate::error::StorageError::Validation("stream unsupported".into())) })
  }
}

fn broker_factory(
  transport: Arc<dyn RawHttpTransport>,
  tokens: Arc<TokenGrantService>,
) -> Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync> {
  Arc::new(move || {
    Box::new(NetworkBrokerHandle::new_with_token_grants(
      transport.clone(),
      tokens.clone(),
    ))
  })
}

struct LifecycleFixture {
  _dir: tempfile::TempDir,
  db: Database,
  packages: PluginPackageService,
  lifecycle: RuntimeLifecycleService,
  capabilities: ServiceCapabilityService,
  registry: Arc<ServiceIntegrationRegistry>,
  wasm: Arc<WasmRuntime>,
  tokens: Arc<TokenGrantService>,
  transport: Arc<CaptureTransport>,
  vault: Arc<dyn CredentialVault>,
  instance_id: Uuid,
  package_digest: String,
}

fn lifecycle_fixture() -> LifecycleFixture {
  lifecycle_fixture_from_package(PACKAGE_BYTES)
}

fn lifecycle_fixture_from_package(package_bytes: &[u8]) -> LifecycleFixture {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages = PluginPackageService::with_vendor_roots(
    db.clone(),
    dir.path().to_path_buf(),
    vec![crate::services::vendor_trust::test_vendor_fixture::fixture_vendor_public_key()],
  );
  let imported = packages.bootstrap_bundled_package(package_bytes, false).unwrap();
  let package_digest = imported.package_digest().to_string();
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let wasm = Arc::new(WasmRuntime::new().unwrap());
  let exchanger = Arc::new(FixtureExchanger::recording());
  let tokens = Arc::new(TokenGrantService::new(exchanger));
  let network = Arc::new(crate::services::network_broker::NetworkBroker::new(
    db.clone(),
    registry.clone(),
  ));
  let handlers = Arc::new(
    build_capability_registry(
      HandlerDeps {
        db: db.clone(),
        broker: network,
        tokens: tokens.clone(),
      },
      &registry,
    )
    .unwrap(),
  );
  let router = RuntimeRouter::new(
    db.clone(),
    registry.clone(),
    handlers.clone(),
    packages.clone(),
    wasm.clone(),
  );
  let transport = Arc::new(CaptureTransport {
    calls: AtomicUsize::new(0),
    last: Mutex::new(None),
    response: Mutex::new(json_response(200, TRANSLATE_SUCCESS_FIXTURE)),
  });
  let broker = broker_factory(transport.clone(), tokens.clone());
  let capabilities = ServiceCapabilityService::new(db.clone(), registry.clone(), handlers)
    .with_router(router, wasm.clone())
    .with_broker_factory(broker);
  let vault: Arc<dyn CredentialVault> = Arc::new(MemoryCredentialVault::default());
  vault.set("fixture-service-account", "fixture-secret").unwrap();
  let instance_id = Uuid::now_v7();
  let now = now_rfc3339();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id: instance_id,
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        plugin_version: "1.2.0".into(),
        display_name: "Google Cloud Fixture".into(),
        enabled: true,
        config_json: String::from_utf8(config()).unwrap(),
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
        last_validated_at: Some(now.clone()),
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
        id: Uuid::now_v7(),
        integration_instance_id: instance_id,
        slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
        credential_ref: Some("fixture-service-account".into()),
        credential_revision: 1,
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    Ok::<_, crate::error::StorageError>(())
  })
  .unwrap();
  let lifecycle = RuntimeLifecycleService::new(db.clone(), packages.clone(), registry.clone())
    .with_runtime(wasm.clone(), tokens.clone())
    .with_vault(vault.clone());
  LifecycleFixture {
    _dir: dir,
    db,
    packages,
    lifecycle,
    capabilities,
    registry,
    wasm,
    tokens,
    transport,
    vault,
    instance_id,
    package_digest,
  }
}

fn public_capabilities_with_transport(
  fixture: &LifecycleFixture,
  transport: Arc<dyn RawHttpTransport>,
) -> ServiceCapabilityService {
  let handlers = Arc::new(
    build_capability_registry(
      HandlerDeps {
        db: fixture.db.clone(),
        broker: Arc::new(crate::services::network_broker::NetworkBroker::new(
          fixture.db.clone(),
          fixture.registry.clone(),
        )),
        tokens: fixture.tokens.clone(),
      },
      &fixture.registry,
    )
    .unwrap(),
  );
  let router = RuntimeRouter::new(
    fixture.db.clone(),
    fixture.registry.clone(),
    handlers.clone(),
    fixture.packages.clone(),
    fixture.wasm.clone(),
  );
  ServiceCapabilityService::new(fixture.db.clone(), fixture.registry.clone(), handlers)
    .with_router(router, fixture.wasm.clone())
    .with_broker_factory(broker_factory(transport, fixture.tokens.clone()))
}

fn seed_public_workflow_bindings(fixture: &LifecycleFixture) -> (Uuid, Uuid, Uuid) {
  let preview = fixture
    .lifecycle
    .preview_upgrade(fixture.instance_id, &fixture.package_digest)
    .expect("public workflow package preview");
  fixture
    .lifecycle
    .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .expect("public workflow package activation");
  insert_public_workflow_bindings(fixture)
}

fn insert_public_workflow_bindings(fixture: &LifecycleFixture) -> (Uuid, Uuid, Uuid) {
  let profile_id = Uuid::now_v7();
  let ocr_id = Uuid::now_v7();
  let speech_id = Uuid::now_v7();
  let now = now_rfc3339();
  fixture
    .db
    .transaction(|uow| {
      translation_profiles::insert_profile(
        uow.conn(),
        &TranslationProfile {
          id: profile_id,
          name: "Google Cloud public workflow profile".into(),
          enabled: true,
          source_lang: Some("en".into()),
          target_lang: Some("zh".into()),
          primary_lang: Some("en".into()),
          preferred_target_lang: Some("zh".into()),
          engine: TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
            integration_instance_id: fixture.instance_id,
            translate_capability_id: "translate.text@1".into(),
            detect_capability_id: Some("translate.detect@1".into()),
            capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
            capability_preferences: serde_json::json!({}),
          }),
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      ocr_services::insert(
        uow.conn(),
        &OcrService {
          id: ocr_id,
          provider_type: OcrProviderType::PluginCapability,
          display_name: "Google Cloud public workflow OCR".into(),
          enabled: true,
          sort_order: 0,
          baidu_action: None,
          api_key_ref: None,
          secret_key_ref: None,
          provider_model_id: None,
          temperature: None,
          default_prompt_template_id: None,
          integration_instance_id: Some(fixture.instance_id),
          ocr_capability_id: Some(OCR_IMAGE_CAPABILITY_ID.into()),
          capability_preferences_version: Some(1),
          capability_preferences: Some(serde_json::json!({})),
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      speech_services::insert(
        uow.conn(),
        &SpeechService {
          id: speech_id,
          display_name: "Google Cloud public workflow speech".into(),
          enabled: true,
          sort_order: 0,
          integration_instance_id: fixture.instance_id,
          capability_id: "speech.synthesize@1".into(),
          preferences_schema_version: 1,
          preferences: serde_json::json!({ "speaking-rate": 1.0, "pitch": 0.0 }),
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok::<_, crate::error::StorageError>(())
    })
    .expect("public workflow bindings");
  (profile_id, ocr_id, speech_id)
}

fn signed_google_cloud_ocr_failure_package(base: &InstalledFixture, component_bytes: &[u8]) -> Vec<u8> {
  let artifact_path = "ocr/fixtures/langnext-google-cloud-ocr.wasm";
  let mut manifest = base.package.manifest.clone();
  let artifact_entry = manifest
    .files
    .iter_mut()
    .find(|entry| entry.path == artifact_path)
    .expect("OCR artifact manifest entry");
  artifact_entry.bytes = component_bytes.len() as u64;
  artifact_entry.sha256 = public_sha256_hex(component_bytes);

  let mut payloads: Vec<(String, Vec<u8>)> = manifest
    .files
    .iter()
    .map(|entry| {
      (
        entry.path.clone(),
        base
          .package
          .extracted_files
          .get(&entry.path)
          .expect("indexed Google Cloud payload")
          .clone(),
      )
    })
    .collect();
  let ocr_payload = payloads
    .iter_mut()
    .find(|(path, _)| path == artifact_path)
    .expect("OCR artifact payload");
  ocr_payload.1 = component_bytes.to_vec();
  payloads.sort_by(|left, right| left.0.cmp(&right.0));

  let manifest_bytes = serde_json::to_vec(&manifest).expect("failure package manifest JSON");
  let signature = crate::services::vendor_trust::test_vendor_fixture::fixture_vendor_signing_key()
    .sign(&manifest_bytes)
    .to_bytes();
  let publisher_bytes = crate::domain::plugin_package::decode_lowercase_hex::<32>(
    VENDOR_PUBLIC_KEY_HEX.trim(),
    "fixture vendor public key",
  )
  .expect("fixture vendor key");
  let mut cursor = std::io::Cursor::new(Vec::new());
  {
    let mut zip = zip::ZipWriter::new(&mut cursor);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip
      .start_file(crate::domain::runtime_plugin::MANIFEST_FILE_PATH, options)
      .expect("failure package manifest entry");
    zip.write_all(&manifest_bytes).expect("failure package manifest");
    zip
      .start_file(crate::domain::runtime_plugin::PUBLISHER_PUBLIC_KEY_PATH, options)
      .expect("failure package publisher entry");
    zip.write_all(&publisher_bytes).expect("failure package publisher");
    for (path, bytes) in payloads {
      zip.start_file(path, options).expect("failure package payload entry");
      zip.write_all(&bytes).expect("failure package payload");
    }
    zip
      .start_file(crate::domain::runtime_plugin::SIGNATURE_FILE_PATH, options)
      .expect("failure package signature entry");
    zip.write_all(&signature).expect("failure package signature");
    zip.finish().expect("failure package archive");
  }
  cursor.into_inner()
}

fn assert_public_ocr_failure(component_bytes: &[u8], expected_code: &str) {
  let fixture = installed_fixture();
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let instance_id = Uuid::now_v7();
  let now = now_rfc3339();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id: instance_id,
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        plugin_version: "1.2.0".into(),
        display_name: "OCR failure fixture".into(),
        enabled: true,
        config_json: String::from_utf8(config()).unwrap(),
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
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
    let service_id = Uuid::now_v7();
    ocr_services::insert(
      uow.conn(),
      &OcrService {
        id: service_id,
        provider_type: OcrProviderType::PluginCapability,
        display_name: "OCR failure fixture".into(),
        enabled: true,
        sort_order: 0,
        baidu_action: None,
        api_key_ref: None,
        secret_key_ref: None,
        provider_model_id: None,
        temperature: None,
        default_prompt_template_id: None,
        integration_instance_id: Some(instance_id),
        ocr_capability_id: Some(OCR_IMAGE_CAPABILITY_ID.into()),
        capability_preferences_version: Some(1),
        capability_preferences: Some(serde_json::json!({})),
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    Ok::<_, crate::error::StorageError>(())
  })
  .unwrap();
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let mut handlers = ServiceCapabilityRegistry::new();
  let digest = ComponentArtifactDigest::parse(&public_sha256_hex(component_bytes)).unwrap();
  let verified = Arc::new(
    fixture
      .runtime
      .compile_component(&fixture.package_digest, &digest, component_bytes)
      .unwrap(),
  );
  let adapter = WasmOcrImageAdapter::new(
    fixture.runtime.clone(),
    verified,
    grant_for(&fixture, instance_id, OCR_IMAGE_CAPABILITY_ID),
    OCR_IMAGE_CAPABILITY_ID,
    config(),
    broker_factory(fixture.transport.clone(), fixture.tokens.clone()),
  );
  handlers.register(
    GOOGLE_CLOUD_PLUGIN_ID,
    OCR_IMAGE_CAPABILITY_ID,
    CapabilityHandler::OcrImage(Arc::new(adapter)),
  );
  let capabilities = ServiceCapabilityService::new(db.clone(), registry.clone(), Arc::new(handlers));
  let vault: Arc<dyn CredentialVault> = Arc::new(MemoryCredentialVault::default());
  let services = OcrServiceService::new(db.clone(), vault, registry, capabilities);
  let service_id = db
    .read(|conn| ocr_services::list_by_integration_instance(conn, instance_id))
    .unwrap()
    .first()
    .map(|service| service.id)
    .unwrap();
  let result = tauri::async_runtime::block_on(services.recognize(
    OcrRecognizeInput {
      png_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, INPUT_PNG),
      ocr_service_id: Some(service_id),
      request_id: None,
    },
    CancelToken::new(),
  ));
  match (expected_code, result) {
    ("plugin_unavailable", Err(crate::error::StorageError::PluginUnavailable(_))) => {}
    ("invalid_response", Err(crate::error::StorageError::Capability { code, .. })) if code == "invalid_response" => {}
    ("invalid_response", Err(crate::error::StorageError::Validation(message)))
      if message.starts_with("invalid_response:") => {}
    (expected, actual) => panic!("expected {expected}, got {actual:?}"),
  }
  let instance = db.read(|conn| integration_instances::get(conn, instance_id)).unwrap();
  assert_eq!(instance.runtime_kind, "bundled-rust");
  assert!(instance.package_digest.is_none());
}

fn assert_installed_ocr_failure(component_bytes: &[u8], expected_code: &str) {
  let base = installed_fixture();
  let package = signed_google_cloud_ocr_failure_package(&base, component_bytes);
  let fixture = lifecycle_fixture_from_package(&package);
  let cleanup_probe = Arc::new(std::sync::atomic::AtomicBool::new(false));
  fixture.wasm.set_cleanup_probe(cleanup_probe.clone());
  let (_profile_id, ocr_service_id, _speech_service_id) = insert_public_workflow_bindings(&fixture);
  let preview = fixture
    .lifecycle
    .preview_upgrade(fixture.instance_id, &fixture.package_digest)
    .expect("failure package preview");
  fixture
    .lifecycle
    .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .expect("failure package activation");

  let services = OcrServiceService::new(
    fixture.db.clone(),
    fixture.vault.clone(),
    fixture.registry.clone(),
    fixture.capabilities.clone(),
  );
  let result = tauri::async_runtime::block_on(services.recognize(
    OcrRecognizeInput {
      png_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, INPUT_PNG),
      ocr_service_id: Some(ocr_service_id),
      request_id: Some("google-cloud-installed-ocr-failure".into()),
    },
    CancelToken::new(),
  ));
  match (expected_code, result) {
    ("plugin_unavailable", Err(crate::error::StorageError::PluginUnavailable(_))) => {}
    ("invalid_response", Err(crate::error::StorageError::Capability { code, .. })) if code == "invalid_response" => {}
    ("invalid_response", Err(crate::error::StorageError::Validation(message)))
      if message.starts_with("invalid_response:") => {}
    (expected, actual) => panic!("expected {expected}, got {actual:?}"),
  }
  assert_eq!(fixture.transport.calls.load(Ordering::SeqCst), 0);
  assert!(cleanup_probe.load(Ordering::SeqCst));
  let active = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(active.runtime_kind, "wasm-component");
  assert_eq!(active.package_digest.as_deref(), Some(fixture.package_digest.as_str()));

  let rollback = fixture
    .lifecycle
    .preview_rollback(fixture.instance_id)
    .expect("failure package rollback preview");
  fixture
    .lifecycle
    .apply_rollback(crate::domain::runtime_lifecycle::ApplyRuntimeRollbackInput {
      preview_id: rollback.preview_id,
    })
    .expect("failure package rollback");
  let restored = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(restored.runtime_kind, "bundled-rust");
  assert!(restored.package_digest.is_none());
  assert_eq!(
    fixture
      .db
      .read(|conn| ocr_services::get(conn, ocr_service_id))
      .unwrap()
      .integration_instance_id,
    Some(fixture.instance_id)
  );
}

fn request_body(request: PreparedHttpRequest) -> serde_json::Value {
  serde_json::from_str(request.body.as_text().expect("JSON request body")).expect("valid JSON request")
}

#[test]
fn google_cloud_runtime_translate_matches_golden_contract() {
  let fixture = installed_fixture();
  let instance_id = Uuid::now_v7();
  let grant = grant_for(&fixture, instance_id, "translate.text@1");
  let (verified, _) = artifact(&fixture, "translate/fixtures/langnext-google-cloud-translate.wasm");
  *fixture.transport.response.lock().unwrap() = json_response(200, TRANSLATE_SUCCESS_FIXTURE);
  let handler = WasmTranslateTextAdapter::new(
    fixture.runtime.clone(),
    verified,
    grant,
    "translate.text@1",
    config(),
    b"{}".to_vec(),
    broker_factory(fixture.transport.clone(), fixture.tokens.clone()),
  );
  let context = context(instance_id, "translate.text@1", "google-cloud-translate-fixture");
  let result = tauri::async_runtime::block_on(handler.translate(
    instance_id,
    TranslateTextRequest {
      text: "Hello".into(),
      source_language_id: "auto".into(),
      target_language_id: "zh".into(),
    },
    context,
  ))
  .expect("translate fixture call");
  assert_eq!(result.translated_text, "你好");
  assert_eq!(result.detected_source_language_id.as_deref(), Some("en"));
  let prepared = fixture.transport.last.lock().unwrap().take().expect("transport call");
  assert_eq!(
    prepared.headers.get("Authorization").map(String::as_str),
    Some("Bearer fixture-token")
  );
  assert_eq!(
    request_body(prepared),
    serde_json::from_str::<serde_json::Value>(TRANSLATE_REQUEST_FIXTURE).unwrap()
  );
  assert_eq!(fixture.transport.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn google_cloud_runtime_detect_uses_translation_scope_and_maps_language() {
  let fixture = installed_fixture();
  let instance_id = Uuid::now_v7();
  let grant = grant_for(&fixture, instance_id, "translate.detect@1");
  let (verified, _) = artifact(&fixture, "detect/fixtures/langnext-google-cloud-detect.wasm");
  *fixture.transport.response.lock().unwrap() = json_response(200, DETECT_SUCCESS_FIXTURE);
  let handler = WasmDetectLanguageAdapter::new(
    fixture.runtime.clone(),
    verified,
    grant,
    "translate.detect@1",
    config(),
    b"{}".to_vec(),
    broker_factory(fixture.transport.clone(), fixture.tokens.clone()),
  );
  let result = tauri::async_runtime::block_on(handler.detect(
    instance_id,
    DetectLanguageRequest { text: "Hello".into() },
    context(instance_id, "translate.detect@1", "google-cloud-detect-fixture"),
  ))
  .expect("detect fixture call");
  assert_eq!(result.language_id, "en");
  assert_eq!(
    request_body(fixture.transport.last.lock().unwrap().take().unwrap()),
    serde_json::from_str::<serde_json::Value>(DETECT_REQUEST_FIXTURE).unwrap()
  );
  let exchanged = fixture.exchanger.recorded_scopes.lock().unwrap();
  assert_eq!(exchanged.len(), 1, "Detect performs exactly one token exchange");
  assert_eq!(
    exchanged[0],
    vec![GOOGLE_CLOUD_TRANSLATION_SCOPE.to_string()],
    "Detect must exchange exactly the Translation scope"
  );
  assert!(
    exchanged[0]
      .iter()
      .all(|scope| scope != GOOGLE_CLOUD_VISION_SCOPE && scope != GOOGLE_CLOUD_TEXT_TO_SPEECH_SCOPE),
    "Detect must not exchange Vision or TTS scopes"
  );
}

#[test]
fn google_cloud_runtime_ocr_uses_blob_and_returns_golden_text() {
  let fixture = installed_fixture();
  let cleanup_probe = Arc::new(std::sync::atomic::AtomicBool::new(false));
  fixture.runtime.set_cleanup_probe(cleanup_probe.clone());
  let instance_id = Uuid::now_v7();
  let grant = grant_for(&fixture, instance_id, OCR_IMAGE_CAPABILITY_ID);
  let (verified, _) = artifact(&fixture, "ocr/fixtures/langnext-google-cloud-ocr.wasm");
  *fixture.transport.response.lock().unwrap() = json_response(200, VISION_SUCCESS_FIXTURE);
  let handler = WasmOcrImageAdapter::new(
    fixture.runtime.clone(),
    verified,
    grant,
    OCR_IMAGE_CAPABILITY_ID,
    config(),
    broker_factory(fixture.transport.clone(), fixture.tokens.clone()),
  );
  let response = tauri::async_runtime::block_on(handler.recognize(
    instance_id,
    OcrImageRequest {
      png_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, INPUT_PNG),
      preferences: OcrImagePreferences {
        operation: OcrImageOperation::DocumentTextDetection,
        language_hints: vec![],
      },
    },
    context(instance_id, OCR_IMAGE_CAPABILITY_ID, "google-cloud-ocr-fixture"),
  ))
  .expect("OCR fixture call");
  assert_eq!(response.text, "Recognized text");
  assert_eq!(
    request_body(fixture.transport.last.lock().unwrap().take().unwrap()),
    serde_json::from_str::<serde_json::Value>(VISION_REQUEST_FIXTURE).unwrap()
  );
  assert!(cleanup_probe.load(Ordering::SeqCst));
}

#[test]
fn google_cloud_runtime_tts_returns_golden_audio_via_blob() {
  let fixture = installed_fixture();
  let cleanup_probe = Arc::new(std::sync::atomic::AtomicBool::new(false));
  fixture.runtime.set_cleanup_probe(cleanup_probe.clone());
  let instance_id = Uuid::now_v7();
  let grant = grant_for(&fixture, instance_id, "speech.synthesize@1");
  let (verified, _) = artifact(&fixture, "tts/fixtures/langnext-google-cloud-tts.wasm");
  *fixture.transport.response.lock().unwrap() = json_response(200, TTS_SUCCESS_FIXTURE);
  let handler = WasmSpeechSynthesizeAdapter::new(
    fixture.runtime.clone(),
    verified,
    grant,
    "speech.synthesize@1",
    config(),
    broker_factory(fixture.transport.clone(), fixture.tokens.clone()),
  );
  let response = tauri::async_runtime::block_on(handler.synthesize(
    instance_id,
    SpeechSynthesizeRequest {
      text: "Hello".into(),
      language_id: "en".into(),
      preferences: serde_json::json!({ "speaking-rate": 1.0, "pitch": 0.0 }),
    },
    context(instance_id, "speech.synthesize@1", "google-cloud-tts-fixture"),
  ))
  .expect("TTS fixture call");
  assert_eq!(response.mp3_bytes, EXPECTED_MP3);
  assert_eq!(
    request_body(fixture.transport.last.lock().unwrap().take().unwrap()),
    serde_json::from_str::<serde_json::Value>(TTS_REQUEST_FIXTURE).unwrap()
  );
  assert!(cleanup_probe.load(Ordering::SeqCst));
}

#[test]
fn google_cloud_runtime_tts_propagates_sixty_second_deadline() {
  let fixture = installed_fixture();
  let cleanup_probe = Arc::new(std::sync::atomic::AtomicBool::new(false));
  fixture.runtime.set_cleanup_probe(cleanup_probe.clone());
  let instance_id = Uuid::now_v7();
  let deadline = Arc::new(Mutex::new(None));
  let deadline_for_factory = deadline.clone();
  let broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new(move || {
    Box::new(DeadlineCaptureBroker {
      deadline: deadline_for_factory.clone(),
    })
  });
  let (verified, _) = artifact(&fixture, "tts/fixtures/langnext-google-cloud-tts.wasm");
  let handler = WasmSpeechSynthesizeAdapter::new(
    fixture.runtime.clone(),
    verified,
    grant_for(&fixture, instance_id, "speech.synthesize@1"),
    "speech.synthesize@1",
    config(),
    broker_factory,
  );
  let response = tauri::async_runtime::block_on(handler.synthesize(
    instance_id,
    SpeechSynthesizeRequest {
      text: "Hello".into(),
      language_id: "en".into(),
      preferences: serde_json::json!({ "speaking-rate": 1.0, "pitch": 0.0 }),
    },
    context(instance_id, "speech.synthesize@1", "google-cloud-tts-deadline"),
  ))
  .expect("TTS deadline fixture call");
  assert_eq!(response.mp3_bytes, EXPECTED_MP3);
  let remaining = deadline
    .lock()
    .unwrap()
    .expect("effective broker deadline")
    .saturating_duration_since(std::time::Instant::now());
  assert!(remaining > std::time::Duration::from_secs(55));
  assert!(remaining <= std::time::Duration::from_secs(60));
  assert!(cleanup_probe.load(Ordering::SeqCst));
}

#[test]
fn google_cloud_runtime_ocr_rejects_invalid_and_provider_error_content() {
  let fixture = installed_fixture();
  let cleanup_probe = Arc::new(std::sync::atomic::AtomicBool::new(false));
  fixture.runtime.set_cleanup_probe(cleanup_probe.clone());
  let instance_id = Uuid::now_v7();
  let grant = grant_for(&fixture, instance_id, OCR_IMAGE_CAPABILITY_ID);
  let (verified, _) = artifact(&fixture, "ocr/fixtures/langnext-google-cloud-ocr.wasm");
  let handler = WasmOcrImageAdapter::new(
    fixture.runtime.clone(),
    verified,
    grant,
    OCR_IMAGE_CAPABILITY_ID,
    config(),
    broker_factory(fixture.transport.clone(), fixture.tokens.clone()),
  );
  let invalid = tauri::async_runtime::block_on(handler.recognize(
    instance_id,
    OcrImageRequest {
      png_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, INVALID_PNG),
      preferences: OcrImagePreferences {
        operation: OcrImageOperation::DocumentTextDetection,
        language_hints: vec![],
      },
    },
    context(instance_id, OCR_IMAGE_CAPABILITY_ID, "google-cloud-ocr-invalid"),
  ))
  .unwrap_err();
  assert_eq!(invalid.code, CapabilityErrorCode::UnsupportedInput);
  let oversized = tauri::async_runtime::block_on(handler.recognize(
    instance_id,
    OcrImageRequest {
      png_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, OVERSIZED_PNG),
      preferences: OcrImagePreferences {
        operation: OcrImageOperation::DocumentTextDetection,
        language_hints: vec![],
      },
    },
    context(instance_id, OCR_IMAGE_CAPABILITY_ID, "google-cloud-ocr-oversized-input"),
  ))
  .unwrap_err();
  assert_eq!(oversized.code, CapabilityErrorCode::UnsupportedInput);
  assert_eq!(fixture.transport.calls.load(Ordering::SeqCst), 0);
  assert_eq!(
    fixture.exchanger.calls.load(Ordering::SeqCst),
    0,
    "malformed PNG must not trigger an OAuth token exchange"
  );

  *fixture.transport.response.lock().unwrap() = json_response(
    200,
    include_str!(concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/../runtime-plugins/google-cloud/tests/fixtures/vision/error-per-image.json"
    )),
  );
  let provider = tauri::async_runtime::block_on(handler.recognize(
    instance_id,
    OcrImageRequest {
      png_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, INPUT_PNG),
      preferences: OcrImagePreferences {
        operation: OcrImageOperation::DocumentTextDetection,
        language_hints: vec![],
      },
    },
    context(instance_id, OCR_IMAGE_CAPABILITY_ID, "google-cloud-ocr-provider-error"),
  ))
  .unwrap_err();
  assert_eq!(provider.code, CapabilityErrorCode::PermissionDenied);
  assert!(!provider.message.contains("secret"));
  assert!(cleanup_probe.load(Ordering::SeqCst));
}

#[test]
fn google_cloud_runtime_tts_failure_does_not_return_partial_audio() {
  let cases = [
    (
      403,
      include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/google-cloud/tests/fixtures/tts/error-403.json"
      )),
      CapabilityErrorCode::PermissionDenied,
    ),
    (
      429,
      include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/google-cloud/tests/fixtures/tts/error-429.json"
      )),
      CapabilityErrorCode::QuotaExceeded,
    ),
    (
      200,
      include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/google-cloud/tests/fixtures/tts/malformed-base64.json"
      )),
      CapabilityErrorCode::InvalidResponse,
    ),
    (
      200,
      include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/google-cloud/tests/fixtures/tts/oversized-audio.json"
      )),
      CapabilityErrorCode::InvalidResponse,
    ),
  ];
  for (status, body, expected) in cases {
    let fixture = installed_fixture();
    let instance_id = Uuid::now_v7();
    let grant = grant_for(&fixture, instance_id, "speech.synthesize@1");
    let (verified, _) = artifact(&fixture, "tts/fixtures/langnext-google-cloud-tts.wasm");
    *fixture.transport.response.lock().unwrap() = json_response(status, body);
    let handler = WasmSpeechSynthesizeAdapter::new(
      fixture.runtime.clone(),
      verified,
      grant,
      "speech.synthesize@1",
      config(),
      broker_factory(fixture.transport.clone(), fixture.tokens.clone()),
    );
    let result = tauri::async_runtime::block_on(handler.synthesize(
      instance_id,
      SpeechSynthesizeRequest {
        text: "Hello".into(),
        language_id: "en".into(),
        preferences: serde_json::json!({ "speaking-rate": 1.0, "pitch": 0.0 }),
      },
      context(instance_id, "speech.synthesize@1", "google-cloud-tts-failure"),
    ))
    .unwrap_err();
    assert_eq!(
      result.code,
      expected,
      "status={status} body_len={} body_prefix={:?}",
      body.len(),
      &body.as_bytes()[..body.len().min(32)]
    );
  }
}

async fn cancel_public_request<T, F>(
  started: Arc<Notify>,
  sessions: Arc<crate::domain::cancel::RequestSessionRegistry>,
  request_id: &str,
  future: F,
) -> T
where
  F: Future<Output = T>,
{
  let request_id = request_id.to_string();
  let cancellation = tokio::spawn(async move {
    started.notified().await;
    assert!(sessions.cancel(&request_id));
  });
  let result = tokio::time::timeout(std::time::Duration::from_secs(10), future)
    .await
    .expect("public cancellation watchdog");
  cancellation.await.expect("public cancellation task");
  result
}

#[test]
fn google_cloud_runtime_cancellation_stops_active_capability_without_fallback() {
  let fixture = lifecycle_fixture();
  let cleanup_probe = Arc::new(std::sync::atomic::AtomicBool::new(false));
  fixture.wasm.set_cleanup_probe(cleanup_probe.clone());
  let (profile_id, ocr_service_id, speech_service_id) = seed_public_workflow_bindings(&fixture);
  let blocking = Arc::new(BlockingTransport {
    calls: AtomicUsize::new(0),
    started: Arc::new(Notify::new()),
    dropped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
  });
  let capabilities = public_capabilities_with_transport(&fixture, blocking.clone());
  let ocr_services = OcrServiceService::new(
    fixture.db.clone(),
    fixture.vault.clone(),
    fixture.registry.clone(),
    capabilities.clone(),
  );
  let speech_services = SpeechServiceService::new(fixture.db.clone(), fixture.registry.clone(), capabilities.clone());
  let input = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, INPUT_PNG);
  let runtime = tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .unwrap();
  runtime.block_on(async {
    let sessions = Arc::new(crate::domain::cancel::RequestSessionRegistry::new());

    let translate_request_id = "google-cloud-public-translate";
    let translate = cancel_public_request(
      blocking.started.clone(),
      sessions.clone(),
      translate_request_id,
      crate::cmds::service_translation::run_translate_service_profile(
        &capabilities,
        sessions.as_ref(),
        crate::cmds::service_translation::ServiceProfileTranslateInput {
          request_id: translate_request_id.into(),
          profile_id,
          text: "Hello".into(),
          source_lang: "en".into(),
          target_lang: "zh".into(),
        },
      ),
    )
    .await;
    assert!(!translate.ok);
    assert_eq!(translate.error_code.as_deref(), Some("cancelled"));
    assert!(!sessions.cancel(translate_request_id));

    let detect_request_id = "google-cloud-public-detect";
    let detect = cancel_public_request(
      blocking.started.clone(),
      sessions.clone(),
      detect_request_id,
      crate::cmds::service_translation::run_detect_service_profile_language(
        &capabilities,
        sessions.as_ref(),
        crate::cmds::service_translation::ServiceProfileDetectInput {
          request_id: detect_request_id.into(),
          profile_id,
          text: "Hello".into(),
        },
      ),
    )
    .await;
    assert!(!detect.ok);
    assert_eq!(detect.error_code.as_deref(), Some("cancelled"));
    assert!(!sessions.cancel(detect_request_id));

    let ocr_request_id = "google-cloud-public-ocr";
    let ocr_token = sessions.begin(ocr_request_id);
    let ocr = cancel_public_request(
      blocking.started.clone(),
      sessions.clone(),
      ocr_request_id,
      ocr_services.recognize(
        crate::domain::ocr_service::OcrRecognizeInput {
          png_base64: input.clone(),
          ocr_service_id: Some(ocr_service_id),
          request_id: Some(ocr_request_id.into()),
        },
        ocr_token,
      ),
    )
    .await;
    sessions.end(ocr_request_id);
    assert!(ocr.is_err());

    let speech_request_id = "google-cloud-public-tts";
    let speech_token = sessions.begin(speech_request_id);
    let speech = cancel_public_request(
      blocking.started.clone(),
      sessions.clone(),
      speech_request_id,
      speech_services.synthesize(
        SpeechSynthesizeInput {
          text: "Hello".into(),
          language_id: "en".into(),
          speech_service_id: Some(speech_service_id),
          request_id: Some(speech_request_id.into()),
        },
        speech_token,
      ),
    )
    .await;
    sessions.end(speech_request_id);
    assert!(speech.is_err());
  });
  assert_eq!(blocking.calls.load(Ordering::SeqCst), 4);
  assert!(blocking.dropped.load(Ordering::SeqCst));
  assert!(cleanup_probe.load(Ordering::SeqCst));
}

#[test]
fn google_cloud_runtime_tts_pre_dispatch_cancellation_is_stable() {
  let fixture = lifecycle_fixture();
  let (_profile_id, _ocr_service_id, speech_service_id) = seed_public_workflow_bindings(&fixture);
  let services = SpeechServiceService::new(
    fixture.db.clone(),
    fixture.registry.clone(),
    fixture.capabilities.clone(),
  );
  let cancel = CancelToken::new();
  cancel.cancel();
  let result = tauri::async_runtime::block_on(services.synthesize(
    SpeechSynthesizeInput {
      text: "Hello".into(),
      language_id: "en".into(),
      speech_service_id: Some(speech_service_id),
      request_id: Some("google-cloud-pre-dispatch-cancel".into()),
    },
    cancel,
  ));
  assert!(matches!(
    result,
    Err(crate::error::StorageError::Capability { code, .. }) if code == "cancelled"
  ));
  assert!(
    fixture
      .db
      .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
      .unwrap()
      .is_empty()
  );
}

#[test]
fn google_cloud_runtime_timeout_completes_provider_attempt() {
  let fixture = installed_fixture();
  let instance_id = Uuid::now_v7();
  let blocking = Arc::new(BlockingTransport {
    calls: AtomicUsize::new(0),
    started: Arc::new(Notify::new()),
    dropped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
  });
  let dropped = blocking.dropped.clone();
  let (component, _) = artifact(&fixture, "translate/fixtures/langnext-google-cloud-translate.wasm");
  let handler = WasmTranslateTextAdapter::new(
    fixture.runtime.clone(),
    component,
    grant_for(&fixture, instance_id, "translate.text@1"),
    "translate.text@1",
    config(),
    b"{}".to_vec(),
    broker_factory(blocking.clone(), fixture.tokens.clone()),
  );
  let tracker = ProviderAttemptTracker::new();
  let mut execution = context(instance_id, "translate.text@1", "google-cloud-timeout");
  execution.deadline = Some(std::time::Duration::from_millis(50));
  execution.provider_attempt = tracker.clone();
  let error = tauri::async_runtime::block_on(async {
    tokio::time::timeout(
      std::time::Duration::from_secs(5),
      handler.translate(
        instance_id,
        TranslateTextRequest {
          text: "Hello".into(),
          source_language_id: "auto".into(),
          target_language_id: "zh".into(),
        },
        execution,
      ),
    )
    .await
    .expect("timeout capability watchdog")
    .expect_err("blocking provider must time out")
  });
  assert_eq!(error.code, CapabilityErrorCode::Timeout);
  assert_eq!(
    tracker.state(),
    crate::domain::service_capability::ProviderAttemptState::Completed
  );
  assert!(dropped.load(Ordering::SeqCst));
}

#[test]
fn google_cloud_runtime_complete_package_routes_all_capabilities_from_one_pin() {
  let fixture = lifecycle_fixture();
  let before = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(before.runtime_kind, "bundled-rust");
  assert!(before.package_digest.is_none());
  let preview = fixture
    .lifecycle
    .preview_upgrade(fixture.instance_id, &fixture.package_digest)
    .expect("complete package preview");
  assert_eq!(preview.capability_compatibility.len(), 4);
  fixture
    .lifecycle
    .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .expect("complete package activation");
  let active = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(active.runtime_kind, "wasm-component");
  assert_eq!(active.package_digest.as_deref(), Some(fixture.package_digest.as_str()));
  let revision = active.execution_grant_set_revision.expect("grant revision");

  *fixture.transport.response.lock().unwrap() = json_response(200, TRANSLATE_SUCCESS_FIXTURE);
  let translate = fixture
    .capabilities
    .resolve_translate(fixture.instance_id, "translate.text@1", b"{}".to_vec())
    .expect("translate route");
  let translated = tauri::async_runtime::block_on(translate.translate(
    fixture.instance_id,
    TranslateTextRequest {
      text: "Hello".into(),
      source_language_id: "auto".into(),
      target_language_id: "zh".into(),
    },
    context(fixture.instance_id, "translate.text@1", "google-cloud-pinned-translate"),
  ))
  .expect("translate call");
  assert_eq!(translated.translated_text, "你好");

  *fixture.transport.response.lock().unwrap() = json_response(200, DETECT_SUCCESS_FIXTURE);
  let detect = fixture
    .capabilities
    .resolve_detect(fixture.instance_id, "translate.detect@1", b"{}".to_vec())
    .expect("detect route");
  let detected = tauri::async_runtime::block_on(detect.detect(
    fixture.instance_id,
    DetectLanguageRequest { text: "Hello".into() },
    context(fixture.instance_id, "translate.detect@1", "google-cloud-pinned-detect"),
  ))
  .expect("detect call");
  assert_eq!(detected.language_id, "en");

  *fixture.transport.response.lock().unwrap() = json_response(200, VISION_SUCCESS_FIXTURE);
  let ocr = fixture
    .capabilities
    .resolve_ocr(fixture.instance_id, OCR_IMAGE_CAPABILITY_ID)
    .expect("OCR route");
  let recognized = tauri::async_runtime::block_on(ocr.recognize(
    fixture.instance_id,
    OcrImageRequest {
      png_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, INPUT_PNG),
      preferences: OcrImagePreferences {
        operation: OcrImageOperation::DocumentTextDetection,
        language_hints: vec![],
      },
    },
    context(fixture.instance_id, OCR_IMAGE_CAPABILITY_ID, "google-cloud-pinned-ocr"),
  ))
  .expect("OCR call");
  assert_eq!(recognized.text, "Recognized text");

  *fixture.transport.response.lock().unwrap() = json_response(200, TTS_SUCCESS_FIXTURE);
  let speech = fixture
    .capabilities
    .resolve_speech_synthesize(fixture.instance_id, "speech.synthesize@1")
    .expect("TTS route");
  let audio = tauri::async_runtime::block_on(speech.synthesize(
    fixture.instance_id,
    SpeechSynthesizeRequest {
      text: "Hello".into(),
      language_id: "en".into(),
      preferences: serde_json::json!({ "speaking-rate": 1.0, "pitch": 0.0 }),
    },
    context(fixture.instance_id, "speech.synthesize@1", "google-cloud-pinned-tts"),
  ))
  .expect("TTS call");
  assert_eq!(audio.mp3_bytes, EXPECTED_MP3);

  let after = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(after.package_digest.as_deref(), Some(fixture.package_digest.as_str()));
  assert_eq!(after.execution_grant_set_revision, Some(revision));
}

#[test]
fn google_cloud_export_import_round_trip_preserves_exact_runtime_requirement() {
  let fixture = lifecycle_fixture();
  let preview = fixture
    .lifecycle
    .preview_upgrade(fixture.instance_id, &fixture.package_digest)
    .unwrap();
  fixture
    .lifecycle
    .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let exporter = ImportExportService::new(fixture.db.clone(), fixture.vault.clone());
  let document = exporter.export().expect("export active Google Cloud runtime");
  let integration = document
    .integration_instances
    .iter()
    .find(|instance| instance.id == fixture.instance_id)
    .expect("Google Cloud export");
  let runtime = integration.runtime.as_ref().expect("runtime requirement");
  let expected_runtime_json = serde_json::to_string(runtime).unwrap();
  let expected_capability_majors = vec![
    "translate.text@1".to_string(),
    "translate.detect@1".to_string(),
    "ocr.image@1".to_string(),
    "speech.synthesize@1".to_string(),
  ];
  assert_eq!(runtime.plugin_id, GOOGLE_CLOUD_PLUGIN_ID);
  assert_eq!(runtime.plugin_version, "1.2.0");
  assert_eq!(runtime.runtime_kind, "wasm-component");
  assert_eq!(runtime.package_digest.as_deref(), Some(fixture.package_digest.as_str()));
  assert_eq!(runtime.publisher_key_id.as_deref(), Some("com.langnext.vendor.keys.1"));
  assert_eq!(
    runtime.publisher_key_fingerprint.as_deref(),
    Some(crate::services::vendor_trust::test_vendor_fixture::fixture_vendor_fingerprint().as_str())
  );
  assert_eq!(runtime.plugin_api_version.as_deref(), Some("1.0"));
  assert_eq!(runtime.config_schema_version, 1);
  assert_eq!(runtime.required_capability_majors, expected_capability_majors);
  let serialized_document = serde_json::to_string(&document).unwrap();
  assert!(!serialized_document.contains("fixture-secret"));
  assert!(!serialized_document.contains("fixture-service-account"));
  let clean_dir = tempfile::tempdir().unwrap();
  let clean_db = Database::new(clean_dir.path()).unwrap();
  clean_db.initialize().unwrap();
  let clean_vault: Arc<dyn CredentialVault> = Arc::new(MemoryCredentialVault::default());
  let importer = ImportExportService::new(clean_db.clone(), clean_vault.clone());
  let preview = importer
    .preview(&document, ImportConflictMode::Merge)
    .expect("preview exact runtime requirement");
  assert!(preview.valid, "{preview:?}");
  importer
    .import(document, ImportConflictMode::Merge)
    .expect("import exact runtime requirement");
  let restored = clean_db
    .read(|conn| integration_instances::list(conn))
    .unwrap()
    .into_iter()
    .find(|instance| instance.plugin_id == GOOGLE_CLOUD_PLUGIN_ID)
    .expect("restored Google Cloud instance");
  assert_eq!(
    restored.runtime_requirement_json.as_deref(),
    Some(expected_runtime_json.as_str())
  );
  assert_eq!(restored.runtime_kind, "wasm-component");
  assert_eq!(
    restored.package_digest.as_deref(),
    Some(fixture.package_digest.as_str())
  );
  assert!(restored.execution_grant_set_revision.is_none());
  assert_eq!(restored.runtime_state, "unavailable");
  assert!(!clean_vault.exists("fixture-service-account").unwrap());
}

#[test]
fn google_cloud_dependency_protected_delete_preserves_instance_and_credentials() {
  let fixture = lifecycle_fixture();
  let profile_id = Uuid::now_v7();
  let ocr_id = Uuid::now_v7();
  let speech_id = Uuid::now_v7();
  let now = now_rfc3339();
  fixture
    .db
    .transaction(|uow| {
      translation_profiles::insert_profile(
        uow.conn(),
        &TranslationProfile {
          id: profile_id,
          name: "Google Cloud profile".into(),
          enabled: true,
          source_lang: Some("en".into()),
          target_lang: Some("zh".into()),
          primary_lang: Some("en".into()),
          preferred_target_lang: Some("zh".into()),
          engine: TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
            integration_instance_id: fixture.instance_id,
            translate_capability_id: "translate.text@1".into(),
            detect_capability_id: Some("translate.detect@1".into()),
            capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
            capability_preferences: serde_json::json!({}),
          }),
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      ocr_services::insert(
        uow.conn(),
        &OcrService {
          id: ocr_id,
          provider_type: OcrProviderType::PluginCapability,
          display_name: "Google OCR".into(),
          enabled: true,
          sort_order: 0,
          baidu_action: None,
          api_key_ref: None,
          secret_key_ref: None,
          provider_model_id: None,
          temperature: None,
          default_prompt_template_id: None,
          integration_instance_id: Some(fixture.instance_id),
          ocr_capability_id: Some(OCR_IMAGE_CAPABILITY_ID.into()),
          capability_preferences_version: Some(1),
          capability_preferences: Some(serde_json::json!({})),
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      speech_services::insert(
        uow.conn(),
        &SpeechService {
          id: speech_id,
          display_name: "Google TTS".into(),
          enabled: true,
          sort_order: 0,
          integration_instance_id: fixture.instance_id,
          capability_id: "speech.synthesize@1".into(),
          preferences_schema_version: 1,
          preferences: serde_json::json!({ "speaking-rate": 1.0, "pitch": 0.0 }),
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok::<_, crate::error::StorageError>(())
    })
    .unwrap();
  let binding_before = fixture
    .db
    .read(|conn| integration_credential_bindings::get(conn, fixture.instance_id, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT))
    .unwrap();
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let tokens = Arc::new(TokenGrantService::new(Arc::new(FixtureExchanger::recording())));
  let service = ServiceIntegrationService::new(fixture.db.clone(), fixture.vault.clone(), registry, tokens);
  let error = service.delete(fixture.instance_id).unwrap_err();
  assert!(matches!(error, crate::error::StorageError::InUse(_)));
  assert!(
    fixture
      .db
      .read(|conn| integration_instances::get(conn, fixture.instance_id))
      .is_ok()
  );
  assert!(
    fixture
      .db
      .read(|conn| translation_profiles::get(conn, profile_id))
      .is_ok()
  );
  assert!(fixture.db.read(|conn| ocr_services::get(conn, ocr_id)).is_ok());
  assert!(fixture.db.read(|conn| speech_services::get(conn, speech_id)).is_ok());
  let binding_after = fixture
    .db
    .read(|conn| integration_credential_bindings::get(conn, fixture.instance_id, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT))
    .unwrap();
  assert_eq!(binding_after, binding_before);
  assert_eq!(binding_after.credential_revision, 1);
  assert!(fixture.vault.exists("fixture-service-account").unwrap());
}

#[test]
fn google_cloud_runtime_ocr_trap_and_limit_cleanup_preserve_rollback() {
  let fixture = installed_fixture();
  let instance_id = Uuid::now_v7();
  let input = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, INPUT_PNG);
  let make_handler = |component_bytes: &[u8]| {
    let digest = ComponentArtifactDigest::parse(&public_sha256_hex(component_bytes)).unwrap();
    let verified = Arc::new(
      fixture
        .runtime
        .compile_component(&fixture.package_digest, &digest, component_bytes)
        .unwrap(),
    );
    WasmOcrImageAdapter::new(
      fixture.runtime.clone(),
      verified,
      grant_for(&fixture, instance_id, OCR_IMAGE_CAPABILITY_ID),
      OCR_IMAGE_CAPABILITY_ID,
      config(),
      broker_factory(fixture.transport.clone(), fixture.tokens.clone()),
    )
  };
  let trap = make_handler(OCR_TRAP_COMPONENT);
  let trap_error = tauri::async_runtime::block_on(trap.recognize(
    instance_id,
    OcrImageRequest {
      png_base64: input.clone(),
      preferences: OcrImagePreferences {
        operation: OcrImageOperation::DocumentTextDetection,
        language_hints: vec![],
      },
    },
    context(instance_id, OCR_IMAGE_CAPABILITY_ID, "google-cloud-ocr-trap"),
  ))
  .unwrap_err();
  assert_eq!(trap_error.code, CapabilityErrorCode::PluginUnavailable);

  let oversized = make_handler(OCR_OVERSIZED_COMPONENT);
  let oversized_error = tauri::async_runtime::block_on(oversized.recognize(
    instance_id,
    OcrImageRequest {
      png_base64: input,
      preferences: OcrImagePreferences {
        operation: OcrImageOperation::DocumentTextDetection,
        language_hints: vec![],
      },
    },
    context(instance_id, OCR_IMAGE_CAPABILITY_ID, "google-cloud-ocr-oversized"),
  ))
  .unwrap_err();
  assert_eq!(oversized_error.code, CapabilityErrorCode::InvalidResponse);
  assert_eq!(fixture.transport.calls.load(Ordering::SeqCst), 0);

  let lifecycle = lifecycle_fixture();
  let preview = lifecycle
    .lifecycle
    .preview_upgrade(lifecycle.instance_id, &lifecycle.package_digest)
    .unwrap();
  lifecycle
    .lifecycle
    .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let rollback = lifecycle
    .lifecycle
    .preview_rollback(lifecycle.instance_id)
    .expect("rollback remains available after guest failure");
  lifecycle
    .lifecycle
    .apply_rollback(crate::domain::runtime_lifecycle::ApplyRuntimeRollbackInput {
      preview_id: rollback.preview_id,
    })
    .unwrap();
  let restored = lifecycle
    .db
    .read(|conn| integration_instances::get(conn, lifecycle.instance_id))
    .unwrap();
  assert_eq!(restored.runtime_kind, "bundled-rust");
  assert_installed_ocr_failure(OCR_TRAP_COMPONENT, "plugin_unavailable");
  assert_installed_ocr_failure(OCR_OVERSIZED_COMPONENT, "invalid_response");
}

#[test]
fn google_cloud_runtime_provider_attempt_provenance_distinguishes_no_attempt_cancel_and_completed() {
  let fixture = installed_fixture();
  let instance_id = Uuid::now_v7();
  let grant = grant_for(&fixture, instance_id, "translate.text@1");
  let (verified, _) = artifact(&fixture, "translate/fixtures/langnext-google-cloud-translate.wasm");
  let handler = WasmTranslateTextAdapter::new(
    fixture.runtime.clone(),
    verified,
    grant,
    "translate.text@1",
    config(),
    b"{}".to_vec(),
    broker_factory(fixture.transport.clone(), fixture.tokens.clone()),
  );
  let local_tracker = ProviderAttemptTracker::new();
  let local = tauri::async_runtime::block_on(handler.translate(
    instance_id,
    TranslateTextRequest {
      text: String::new(),
      source_language_id: "auto".into(),
      target_language_id: "zh".into(),
    },
    ExecutionContext {
      provider_attempt: local_tracker.clone(),
      ..context(instance_id, "translate.text@1", "google-cloud-local-validation")
    },
  ))
  .unwrap_err();
  assert_eq!(local.code, CapabilityErrorCode::InvalidRequest);
  assert_eq!(
    local_tracker.state(),
    crate::domain::service_capability::ProviderAttemptState::NotStarted
  );

  let token_fixture = installed_fixture();
  let token_instance_id = Uuid::now_v7();
  let token = Arc::new(TokenGrantService::new(Arc::new(FailingExchanger)));
  let (token_component, _) = artifact(
    &token_fixture,
    "translate/fixtures/langnext-google-cloud-translate.wasm",
  );
  let token_handler = WasmTranslateTextAdapter::new(
    token_fixture.runtime.clone(),
    token_component,
    grant_for(&token_fixture, token_instance_id, "translate.text@1"),
    "translate.text@1",
    config(),
    b"{}".to_vec(),
    broker_factory(token_fixture.transport.clone(), token),
  );
  let token_tracker = ProviderAttemptTracker::new();
  let token_error = tauri::async_runtime::block_on(token_handler.translate(
    token_instance_id,
    TranslateTextRequest {
      text: "Hello".into(),
      source_language_id: "auto".into(),
      target_language_id: "zh".into(),
    },
    ExecutionContext {
      provider_attempt: token_tracker.clone(),
      ..context(token_instance_id, "translate.text@1", "google-cloud-token-failure")
    },
  ))
  .unwrap_err();
  assert_eq!(token_error.code, CapabilityErrorCode::Auth);
  assert_eq!(
    token_tracker.state(),
    crate::domain::service_capability::ProviderAttemptState::Completed
  );

  let transport_fixture = installed_fixture();
  let transport_instance_id = Uuid::now_v7();
  let (transport_component, _) = artifact(
    &transport_fixture,
    "translate/fixtures/langnext-google-cloud-translate.wasm",
  );
  let transport_handler = WasmTranslateTextAdapter::new(
    transport_fixture.runtime.clone(),
    transport_component,
    grant_for(&transport_fixture, transport_instance_id, "translate.text@1"),
    "translate.text@1",
    config(),
    b"{}".to_vec(),
    broker_factory(Arc::new(FailingTransport), transport_fixture.tokens.clone()),
  );
  let transport_tracker = ProviderAttemptTracker::new();
  let transport_error = tauri::async_runtime::block_on(transport_handler.translate(
    transport_instance_id,
    TranslateTextRequest {
      text: "Hello".into(),
      source_language_id: "auto".into(),
      target_language_id: "zh".into(),
    },
    ExecutionContext {
      provider_attempt: transport_tracker.clone(),
      ..context(
        transport_instance_id,
        "translate.text@1",
        "google-cloud-transport-failure",
      )
    },
  ))
  .unwrap_err();
  assert_eq!(transport_error.code, CapabilityErrorCode::Network);
  assert_eq!(
    transport_tracker.state(),
    crate::domain::service_capability::ProviderAttemptState::Completed
  );

  let provider_fixture = installed_fixture();
  let provider_instance_id = Uuid::now_v7();
  *provider_fixture.transport.response.lock().unwrap() = json_response(
    403,
    include_str!(concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/../runtime-plugins/google-cloud/tests/fixtures/translate/error-403.json"
    )),
  );
  let (provider_component, _) = artifact(
    &provider_fixture,
    "translate/fixtures/langnext-google-cloud-translate.wasm",
  );
  let provider_handler = WasmTranslateTextAdapter::new(
    provider_fixture.runtime.clone(),
    provider_component,
    grant_for(&provider_fixture, provider_instance_id, "translate.text@1"),
    "translate.text@1",
    config(),
    b"{}".to_vec(),
    broker_factory(provider_fixture.transport.clone(), provider_fixture.tokens.clone()),
  );
  let provider_tracker = ProviderAttemptTracker::new();
  let provider_error = tauri::async_runtime::block_on(provider_handler.translate(
    provider_instance_id,
    TranslateTextRequest {
      text: "Hello".into(),
      source_language_id: "auto".into(),
      target_language_id: "zh".into(),
    },
    ExecutionContext {
      provider_attempt: provider_tracker.clone(),
      ..context(
        provider_instance_id,
        "translate.text@1",
        "google-cloud-provider-failure",
      )
    },
  ))
  .unwrap_err();
  assert_eq!(provider_error.code, CapabilityErrorCode::PermissionDenied);
  assert_eq!(
    provider_tracker.state(),
    crate::domain::service_capability::ProviderAttemptState::Completed
  );

  let cancel_fixture = installed_fixture();
  let cancel_instance_id = Uuid::now_v7();
  let blocking = Arc::new(BlockingTransport {
    calls: AtomicUsize::new(0),
    started: Arc::new(Notify::new()),
    dropped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
  });
  let (cancel_component, _) = artifact(
    &cancel_fixture,
    "translate/fixtures/langnext-google-cloud-translate.wasm",
  );
  let cancel_handler = WasmTranslateTextAdapter::new(
    cancel_fixture.runtime.clone(),
    cancel_component,
    grant_for(&cancel_fixture, cancel_instance_id, "translate.text@1"),
    "translate.text@1",
    config(),
    b"{}".to_vec(),
    broker_factory(blocking.clone(), cancel_fixture.tokens.clone()),
  );
  let cancel_token = CancelToken::new();
  let cancel_tracker = ProviderAttemptTracker::new();
  let cancel_for_task = cancel_token.clone();
  let blocking_started = blocking.started.clone();
  let cancel_error = tauri::async_runtime::block_on(async {
    let cancellation = tokio::spawn(async move {
      blocking_started.notified().await;
      cancel_for_task.cancel();
    });
    let result = tokio::time::timeout(
      std::time::Duration::from_secs(10),
      cancel_handler.translate(
        cancel_instance_id,
        TranslateTextRequest {
          text: "Hello".into(),
          source_language_id: "auto".into(),
          target_language_id: "zh".into(),
        },
        ExecutionContext {
          provider_attempt: cancel_tracker.clone(),
          cancel: cancel_token,
          ..context(cancel_instance_id, "translate.text@1", "google-cloud-cancelled")
        },
      ),
    )
    .await
    .expect("provider cancellation watchdog")
    .unwrap_err();
    cancellation.await.expect("provider cancellation task");
    result
  });
  assert_eq!(cancel_error.code, CapabilityErrorCode::Cancelled);
  assert_eq!(
    cancel_tracker.state(),
    crate::domain::service_capability::ProviderAttemptState::Cancelled
  );
  assert_eq!(cancel_fixture.transport.calls.load(Ordering::SeqCst), 0);
  assert!(blocking.dropped.load(Ordering::SeqCst));

  *fixture.transport.response.lock().unwrap() = json_response(200, TRANSLATE_SUCCESS_FIXTURE);
  let completed_tracker = ProviderAttemptTracker::new();
  tauri::async_runtime::block_on(handler.translate(
    instance_id,
    TranslateTextRequest {
      text: "Hello".into(),
      source_language_id: "auto".into(),
      target_language_id: "zh".into(),
    },
    ExecutionContext {
      provider_attempt: completed_tracker.clone(),
      ..context(instance_id, "translate.text@1", "google-cloud-completed")
    },
  ))
  .unwrap();
  assert_eq!(
    completed_tracker.state(),
    crate::domain::service_capability::ProviderAttemptState::Completed
  );
}

#[test]
fn integration_capability_health_round_trip_is_scoped_by_instance_and_capability() {
  let fixture = lifecycle_fixture();
  fixture
    .db
    .transaction(|uow| {
      integration_capability_health::upsert_result(
        uow.conn(),
        fixture.instance_id,
        "translate.text@1",
        CapabilityHealthStatus::Degraded,
        Some("permission_denied"),
        "t1",
      )?;
      integration_capability_health::upsert_result(
        uow.conn(),
        fixture.instance_id,
        OCR_IMAGE_CAPABILITY_ID,
        CapabilityHealthStatus::Ready,
        None,
        "t2",
      )?;
      Ok::<_, crate::error::StorageError>(())
    })
    .unwrap();
  let before = fixture
    .db
    .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
    .unwrap();
  fixture
    .db
    .transaction(|uow| {
      integration_capability_health::upsert_result(
        uow.conn(),
        fixture.instance_id,
        "translate.text@1",
        CapabilityHealthStatus::Ready,
        None,
        "t3",
      )
    })
    .unwrap();
  let after = fixture
    .db
    .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(before[0], after[0]);
  assert_eq!(after[1].status, CapabilityHealthStatus::Ready);
}

#[test]
fn google_cloud_runtime_stale_completed_call_cannot_restore_invalidated_health() {
  let fixture = lifecycle_fixture();
  let expected_updated_at = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap()
    .updated_at;
  fixture
    .db
    .transaction(|uow| {
      integration_instances::set_enabled(uow.conn(), fixture.instance_id, false, "authority-transition")
    })
    .unwrap();
  let tracker = ProviderAttemptTracker::new();
  tracker.mark_started();
  tracker.mark_completed();
  fixture
    .capabilities
    .record_provider_result_if_current(
      fixture.instance_id,
      "translate.text@1",
      &tracker,
      true,
      None,
      Some(&expected_updated_at),
    )
    .unwrap();
  assert!(
    fixture
      .db
      .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
      .unwrap()
      .is_empty()
  );
}

#[test]
fn google_cloud_runtime_text_capability_health_is_independent() {
  let fixture = lifecycle_fixture();
  let (profile_id, _, _) = seed_public_workflow_bindings(&fixture);
  let sessions = crate::domain::cancel::RequestSessionRegistry::new();

  let local = tauri::async_runtime::block_on(crate::cmds::service_translation::run_translate_service_profile(
    &fixture.capabilities,
    &sessions,
    crate::cmds::service_translation::ServiceProfileTranslateInput {
      request_id: "google-cloud-health-local".into(),
      profile_id,
      text: String::new(),
      source_lang: "en".into(),
      target_lang: "zh".into(),
    },
  ));
  assert!(!local.ok);
  assert!(
    fixture
      .db
      .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
      .unwrap()
      .is_empty()
  );

  let unresolved = tauri::async_runtime::block_on(crate::cmds::service_translation::run_translate_service_profile(
    &fixture.capabilities,
    &sessions,
    crate::cmds::service_translation::ServiceProfileTranslateInput {
      request_id: "google-cloud-health-resolution".into(),
      profile_id: Uuid::now_v7(),
      text: "Hello".into(),
      source_lang: "en".into(),
      target_lang: "zh".into(),
    },
  ));
  assert!(!unresolved.ok);
  assert!(
    fixture
      .db
      .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
      .unwrap()
      .is_empty()
  );

  let blocking = Arc::new(BlockingTransport {
    calls: AtomicUsize::new(0),
    started: Arc::new(Notify::new()),
    dropped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
  });
  let blocking_caps = public_capabilities_with_transport(&fixture, blocking.clone());
  let cancellation_sessions = Arc::new(crate::domain::cancel::RequestSessionRegistry::new());
  let cancelled = tauri::async_runtime::block_on(cancel_public_request(
    blocking.started.clone(),
    cancellation_sessions.clone(),
    "google-cloud-health-cancelled",
    crate::cmds::service_translation::run_translate_service_profile(
      &blocking_caps,
      cancellation_sessions.as_ref(),
      crate::cmds::service_translation::ServiceProfileTranslateInput {
        request_id: "google-cloud-health-cancelled".into(),
        profile_id,
        text: "Hello".into(),
        source_lang: "en".into(),
        target_lang: "zh".into(),
      },
    ),
  ));
  assert!(!cancelled.ok);
  assert_eq!(cancelled.error_code.as_deref(), Some("cancelled"));
  assert!(
    fixture
      .db
      .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
      .unwrap()
      .is_empty()
  );

  *fixture.transport.response.lock().unwrap() = json_response(
    403,
    include_str!(concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/../runtime-plugins/google-cloud/tests/fixtures/translate/error-403.json"
    )),
  );
  let failed = tauri::async_runtime::block_on(crate::cmds::service_translation::run_translate_service_profile(
    &fixture.capabilities,
    &sessions,
    crate::cmds::service_translation::ServiceProfileTranslateInput {
      request_id: "google-cloud-health-failed".into(),
      profile_id,
      text: "Hello".into(),
      source_lang: "en".into(),
      target_lang: "zh".into(),
    },
  ));
  assert!(!failed.ok);
  assert_eq!(failed.error_code.as_deref(), Some("permission_denied"));

  *fixture.transport.response.lock().unwrap() = json_response(200, DETECT_SUCCESS_FIXTURE);
  let detected = tauri::async_runtime::block_on(crate::cmds::service_translation::run_detect_service_profile_language(
    &fixture.capabilities,
    &sessions,
    crate::cmds::service_translation::ServiceProfileDetectInput {
      request_id: "google-cloud-health-detected".into(),
      profile_id,
      text: "Hello".into(),
    },
  ));
  assert!(detected.ok);
  let rows = fixture
    .db
    .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(rows.len(), 2);
  assert_eq!(rows[0].capability_id, "translate.detect@1");
  assert_eq!(rows[0].status, CapabilityHealthStatus::Ready);
  assert_eq!(rows[1].capability_id, "translate.text@1");
  assert_eq!(rows[1].error_code.as_deref(), Some("permission_denied"));
}

#[test]
fn google_cloud_runtime_ocr_health_does_not_change_text_or_tts() {
  let fixture = lifecycle_fixture();
  let (profile_id, ocr_service_id, speech_service_id) = seed_public_workflow_bindings(&fixture);
  let speech_services = SpeechServiceService::new(
    fixture.db.clone(),
    fixture.registry.clone(),
    fixture.capabilities.clone(),
  );
  let sessions = crate::domain::cancel::RequestSessionRegistry::new();
  *fixture.transport.response.lock().unwrap() = json_response(200, TRANSLATE_SUCCESS_FIXTURE);
  let translated = tauri::async_runtime::block_on(crate::cmds::service_translation::run_translate_service_profile(
    &fixture.capabilities,
    &sessions,
    crate::cmds::service_translation::ServiceProfileTranslateInput {
      request_id: "google-cloud-ocr-health-translate".into(),
      profile_id,
      text: "Hello".into(),
      source_lang: "en".into(),
      target_lang: "zh".into(),
    },
  ));
  assert!(translated.ok);

  *fixture.transport.response.lock().unwrap() = json_response(200, TTS_SUCCESS_FIXTURE);
  let speech = tauri::async_runtime::block_on(speech_services.synthesize(
    SpeechSynthesizeInput {
      text: "Hello".into(),
      language_id: "en".into(),
      speech_service_id: Some(speech_service_id),
      request_id: Some("google-cloud-ocr-health-tts".into()),
    },
    CancelToken::new(),
  ));
  assert!(speech.is_ok());

  *fixture.transport.response.lock().unwrap() = json_response(
    200,
    include_str!(concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/../runtime-plugins/google-cloud/tests/fixtures/vision/error-per-image.json"
    )),
  );
  let ocr_services = OcrServiceService::new(
    fixture.db.clone(),
    fixture.vault.clone(),
    fixture.registry.clone(),
    fixture.capabilities.clone(),
  );
  let ocr = tauri::async_runtime::block_on(ocr_services.recognize(
    OcrRecognizeInput {
      png_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, INPUT_PNG),
      ocr_service_id: Some(ocr_service_id),
      request_id: Some("google-cloud-ocr-health-ocr".into()),
    },
    CancelToken::new(),
  ));
  assert!(ocr.is_err());
  let rows = fixture
    .db
    .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(rows.len(), 3);
  assert!(
    rows
      .iter()
      .any(|row| { row.capability_id == OCR_IMAGE_CAPABILITY_ID && row.status == CapabilityHealthStatus::Degraded })
  );
  assert!(
    rows
      .iter()
      .any(|row| { row.capability_id == "translate.text@1" && row.status == CapabilityHealthStatus::Ready })
  );
  assert!(
    rows
      .iter()
      .any(|row| { row.capability_id == "speech.synthesize@1" && row.status == CapabilityHealthStatus::Ready })
  );
}

#[test]
fn google_cloud_runtime_tts_health_does_not_change_translate_detect_or_ocr() {
  let fixture = lifecycle_fixture();
  let (profile_id, ocr_service_id, speech_service_id) = seed_public_workflow_bindings(&fixture);
  let sessions = crate::domain::cancel::RequestSessionRegistry::new();
  *fixture.transport.response.lock().unwrap() = json_response(200, TRANSLATE_SUCCESS_FIXTURE);
  assert!(
    tauri::async_runtime::block_on(crate::cmds::service_translation::run_translate_service_profile(
      &fixture.capabilities,
      &sessions,
      crate::cmds::service_translation::ServiceProfileTranslateInput {
        request_id: "google-cloud-tts-health-translate".into(),
        profile_id,
        text: "Hello".into(),
        source_lang: "en".into(),
        target_lang: "zh".into(),
      },
    ),)
    .ok
  );
  *fixture.transport.response.lock().unwrap() = json_response(200, DETECT_SUCCESS_FIXTURE);
  assert!(
    tauri::async_runtime::block_on(crate::cmds::service_translation::run_detect_service_profile_language(
      &fixture.capabilities,
      &sessions,
      crate::cmds::service_translation::ServiceProfileDetectInput {
        request_id: "google-cloud-tts-health-detect".into(),
        profile_id,
        text: "Hello".into(),
      },
    ),)
    .ok
  );
  *fixture.transport.response.lock().unwrap() = json_response(200, VISION_SUCCESS_FIXTURE);
  let ocr_services = OcrServiceService::new(
    fixture.db.clone(),
    fixture.vault.clone(),
    fixture.registry.clone(),
    fixture.capabilities.clone(),
  );
  assert!(
    tauri::async_runtime::block_on(ocr_services.recognize(
      OcrRecognizeInput {
        png_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, INPUT_PNG),
        ocr_service_id: Some(ocr_service_id),
        request_id: Some("google-cloud-tts-health-ocr".into()),
      },
      CancelToken::new(),
    ))
    .is_ok()
  );

  *fixture.transport.response.lock().unwrap() = json_response(200, TTS_SUCCESS_FIXTURE);
  let speech_services = SpeechServiceService::new(
    fixture.db.clone(),
    fixture.registry.clone(),
    fixture.capabilities.clone(),
  );
  assert!(
    tauri::async_runtime::block_on(speech_services.synthesize(
      SpeechSynthesizeInput {
        text: "Hello".into(),
        language_id: "en".into(),
        speech_service_id: Some(speech_service_id),
        request_id: Some("google-cloud-tts-health-tts".into()),
      },
      CancelToken::new(),
    ))
    .is_ok()
  );
  let rows = fixture
    .db
    .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(rows.len(), 4);
  assert!(rows.iter().all(|row| row.status == CapabilityHealthStatus::Ready));
  assert!(rows.iter().any(|row| row.capability_id == "translate.text@1"));
  assert!(rows.iter().any(|row| row.capability_id == "translate.detect@1"));
  assert!(rows.iter().any(|row| row.capability_id == OCR_IMAGE_CAPABILITY_ID));
  assert!(rows.iter().any(|row| row.capability_id == "speech.synthesize@1"));
}

#[test]
fn service_integration_remote_mutation_invalidates_capability_health() {
  let fixture = lifecycle_fixture();
  let completed = ProviderAttemptTracker::new();
  completed.mark_started();
  completed.mark_completed();
  for capability in [
    "translate.text@1",
    "translate.detect@1",
    OCR_IMAGE_CAPABILITY_ID,
    "speech.synthesize@1",
  ] {
    fixture
      .capabilities
      .record_provider_result(fixture.instance_id, capability, &completed, true, None)
      .unwrap();
  }
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let tokens = Arc::new(TokenGrantService::new(Arc::new(FixtureExchanger::recording())));
  let service = ServiceIntegrationService::new(fixture.db.clone(), fixture.vault.clone(), registry, tokens);
  let current = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  service
    .save(IntegrationInstanceWrite {
      id: Some(fixture.instance_id),
      plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
      display_name: "Renamed Google Cloud".into(),
      enabled: true,
      config_json: current.config_json.clone(),
      credentials: vec![],
      expected_updated_at: Some(current.updated_at.clone()),
      endpoint_trust_preview_id: None,
      acknowledge_endpoint_trust: false,
    })
    .unwrap();
  assert_eq!(
    fixture
      .db
      .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
      .unwrap()
      .len(),
    4
  );

  let current = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  service
    .save(IntegrationInstanceWrite {
      id: Some(fixture.instance_id),
      plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
      display_name: current.display_name,
      enabled: true,
      config_json: String::from(r#"{"project-id":"changed-project","location":"global","proxy-mode":"direct"}"#),
      credentials: vec![],
      expected_updated_at: Some(current.updated_at),
      endpoint_trust_preview_id: None,
      acknowledge_endpoint_trust: false,
    })
    .unwrap();
  assert!(
    fixture
      .db
      .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
      .unwrap()
      .is_empty()
  );
}

/// Complete source-authority records captured before a failing transition: the runtime pin,
/// every execution grant-set row for the instance, workflow/credential bindings, and all
/// capability-health rows.
struct SourceAuthoritySnapshot {
  instance: IntegrationInstance,
  grants: Vec<ExecutionGrantSetBundle>,
  profile: TranslationProfileDto,
  ocr_service: OcrService,
  speech_service: SpeechService,
  credential_binding: IntegrationCredentialBinding,
  health: Vec<CapabilityHealthRecord>,
}

fn snapshot_source_authority(
  fixture: &LifecycleFixture,
  profile_id: Uuid,
  ocr_id: Uuid,
  speech_id: Uuid,
) -> SourceAuthoritySnapshot {
  let instance = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  let grants = fixture
    .db
    .read(|conn| {
      let mut statement = conn.prepare(
        "SELECT id FROM execution_grant_sets
         WHERE subject_kind = ?1 AND subject_id = ?2
         ORDER BY revision ASC, id ASC",
      )?;
      let ids = statement
        .query_map(
          rusqlite::params![
            GrantSubjectKind::IntegrationInstance.as_str(),
            fixture.instance_id.to_string()
          ],
          |row| {
            let id: String = row.get(0)?;
            Uuid::parse_str(&id)
              .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
          },
        )?
        .collect::<Result<Vec<_>, _>>()?;
      ids
        .into_iter()
        .map(|id| plugin_permission_grants::get_bundle(conn, id))
        .collect::<Result<Vec<_>, _>>()
    })
    .unwrap();
  let profile = fixture
    .db
    .read(|conn| translation_profiles::get(conn, profile_id))
    .unwrap();
  let ocr_service = fixture.db.read(|conn| ocr_services::get(conn, ocr_id)).unwrap();
  let speech_service = fixture.db.read(|conn| speech_services::get(conn, speech_id)).unwrap();
  let credential_binding = fixture
    .db
    .read(|conn| integration_credential_bindings::get(conn, fixture.instance_id, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT))
    .unwrap();
  let health = fixture
    .db
    .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
    .unwrap();
  SourceAuthoritySnapshot {
    instance,
    grants,
    profile,
    ocr_service,
    speech_service,
    credential_binding,
    health,
  }
}

fn assert_source_authority_preserved(fixture: &LifecycleFixture, before: &SourceAuthoritySnapshot) {
  let after = snapshot_source_authority(
    fixture,
    before.profile.profile.id,
    before.ocr_service.id,
    before.speech_service.id,
  );
  assert_eq!(
    after.instance, before.instance,
    "failed transition must preserve the runtime pin"
  );
  assert_eq!(
    after.grants, before.grants,
    "failed transition must preserve execution grant rows"
  );
  assert_eq!(
    after.profile, before.profile,
    "failed transition must preserve the translation profile binding"
  );
  assert_eq!(
    after.ocr_service, before.ocr_service,
    "failed transition must preserve the OCR service binding"
  );
  assert_eq!(
    after.speech_service, before.speech_service,
    "failed transition must preserve the speech service binding"
  );
  assert_eq!(
    after.credential_binding, before.credential_binding,
    "failed transition must preserve the credential binding"
  );
  assert_eq!(
    after.health, before.health,
    "failed transition must preserve capability-health rows"
  );
}

#[test]
fn google_cloud_runtime_authority_change_invalidates_capability_health_atomically() {
  let fixture = lifecycle_fixture();
  let (profile_id, ocr_id, speech_id) = insert_public_workflow_bindings(&fixture);
  let seed_health = || {
    let completed = ProviderAttemptTracker::new();
    completed.mark_started();
    completed.mark_completed();
    for capability in [
      "translate.text@1",
      "translate.detect@1",
      OCR_IMAGE_CAPABILITY_ID,
      "speech.synthesize@1",
    ] {
      fixture
        .capabilities
        .record_provider_result(fixture.instance_id, capability, &completed, true, None)
        .unwrap();
    }
  };
  // Every failed transition must leave the source pin, grant rows, workflow/credential
  // bindings, and all four capability-health rows exactly as they were.
  seed_health();
  let before = snapshot_source_authority(&fixture, profile_id, ocr_id, speech_id);

  // Rejected permission acknowledgement: the preview is consumed but nothing is written.
  let preview = fixture
    .lifecycle
    .preview_upgrade(fixture.instance_id, &fixture.package_digest)
    .unwrap();
  let rejected = fixture
    .lifecycle
    .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: false,
    })
    .unwrap_err();
  assert!(
    matches!(rejected, crate::error::StorageError::Validation(_)),
    "{rejected:?}"
  );
  assert_source_authority_preserved(&fixture, &before);

  // Stale CAS: a public rename between preview and apply moves the instance updated_at.
  let preview = fixture
    .lifecycle
    .preview_upgrade(fixture.instance_id, &fixture.package_digest)
    .unwrap();
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let service = ServiceIntegrationService::new(
    fixture.db.clone(),
    fixture.vault.clone(),
    registry,
    Arc::new(TokenGrantService::new(Arc::new(FixtureExchanger::recording()))),
  );
  let current = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  service
    .save(IntegrationInstanceWrite {
      id: Some(fixture.instance_id),
      plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
      display_name: "Renamed during preview".into(),
      enabled: true,
      config_json: current.config_json.clone(),
      credentials: vec![],
      expected_updated_at: Some(current.updated_at.clone()),
      endpoint_trust_preview_id: None,
      acknowledge_endpoint_trust: false,
    })
    .unwrap();
  let before = snapshot_source_authority(&fixture, profile_id, ocr_id, speech_id);
  let stale = fixture
    .lifecycle
    .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap_err();
  assert!(matches!(stale, crate::error::StorageError::Conflict(_)), "{stale:?}");
  assert_source_authority_preserved(&fixture, &before);

  // Preview failure: a well-formed but uninstalled package digest is rejected before any session.
  let preview_error = fixture
    .lifecycle
    .preview_upgrade(fixture.instance_id, &"0".repeat(64))
    .unwrap_err();
  assert!(
    matches!(preview_error, crate::error::StorageError::NotFound(_)),
    "{preview_error:?}"
  );
  assert_source_authority_preserved(&fixture, &before);

  // Injected apply failure: the transaction aborts and rolls back the grant rows it already wrote.
  let preview = fixture
    .lifecycle
    .preview_upgrade(fixture.instance_id, &fixture.package_digest)
    .unwrap();
  fixture
    .lifecycle
    .set_apply_fault(Some(UpgradeApplyFault::AfterGrantBeforePin));
  let faulted = fixture
    .lifecycle
    .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap_err();
  assert!(
    matches!(faulted, crate::error::StorageError::Internal(_)),
    "{faulted:?}"
  );
  assert_source_authority_preserved(&fixture, &before);

  // Injected apply failure after every in-transaction mutation (pin, health delete, and
  // migrated preference rows): the transaction aborts and rolls the complete source authority
  // back, including the health/preference writes made after the last existing fault point.
  let preview = fixture
    .lifecycle
    .preview_upgrade(fixture.instance_id, &fixture.package_digest)
    .unwrap();
  fixture
    .lifecycle
    .set_apply_fault(Some(UpgradeApplyFault::AfterPreferencesBeforeCommit));
  let faulted = fixture
    .lifecycle
    .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap_err();
  assert!(
    matches!(faulted, crate::error::StorageError::Internal(_)),
    "{faulted:?}"
  );
  assert_source_authority_preserved(&fixture, &before);

  let preview = fixture
    .lifecycle
    .preview_upgrade(fixture.instance_id, &fixture.package_digest)
    .unwrap();
  fixture
    .lifecycle
    .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  assert!(
    fixture
      .db
      .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
      .unwrap()
      .is_empty()
  );
  seed_health();
  assert_eq!(
    fixture
      .db
      .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
      .unwrap()
      .len(),
    4
  );
  let rollback = fixture.lifecycle.preview_rollback(fixture.instance_id).unwrap();
  fixture
    .lifecycle
    .apply_rollback(crate::domain::runtime_lifecycle::ApplyRuntimeRollbackInput {
      preview_id: rollback.preview_id,
    })
    .unwrap();
  assert!(
    fixture
      .db
      .read(|conn| integration_capability_health::list_for_instance(conn, fixture.instance_id))
      .unwrap()
      .is_empty()
  );
}

#[test]
fn google_cloud_runtime_bundled_package_requires_explicit_atomic_transition_and_rolls_back_all_bindings() {
  let fixture = lifecycle_fixture();
  let (profile_id, ocr_id, speech_id) = insert_public_workflow_bindings(&fixture);
  let before = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(before.runtime_kind, "bundled-rust");
  let preview = fixture
    .lifecycle
    .preview_upgrade(fixture.instance_id, &fixture.package_digest)
    .unwrap();
  fixture
    .lifecycle
    .apply_upgrade(crate::domain::runtime_lifecycle::ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let active = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(active.runtime_kind, "wasm-component");
  let rollback = fixture.lifecycle.preview_rollback(fixture.instance_id).unwrap();
  fixture
    .lifecycle
    .apply_rollback(crate::domain::runtime_lifecycle::ApplyRuntimeRollbackInput {
      preview_id: rollback.preview_id,
    })
    .unwrap();
  let restored = fixture
    .db
    .read(|conn| integration_instances::get(conn, fixture.instance_id))
    .unwrap();
  assert_eq!(restored.runtime_kind, "bundled-rust");
  assert!(restored.package_digest.is_none());
  assert!(restored.execution_grant_set_revision.is_none());
  let profile = fixture
    .db
    .read(|conn| translation_profiles::get(conn, profile_id))
    .unwrap();
  assert_eq!(
    profile
      .profile
      .engine
      .as_plugin()
      .expect("plugin profile binding")
      .integration_instance_id,
    fixture.instance_id
  );
  assert_eq!(
    fixture
      .db
      .read(|conn| ocr_services::get(conn, ocr_id))
      .unwrap()
      .integration_instance_id,
    Some(fixture.instance_id)
  );
  assert_eq!(
    fixture
      .db
      .read(|conn| speech_services::get(conn, speech_id))
      .unwrap()
      .integration_instance_id,
    fixture.instance_id
  );
}

#[test]
fn google_cloud_runtime_translate_maps_provider_errors() {
  let cases = [
    ("error-400.json", CapabilityErrorCode::InvalidRequest),
    ("error-401.json", CapabilityErrorCode::Auth),
    ("error-403.json", CapabilityErrorCode::PermissionDenied),
    ("error-429.json", CapabilityErrorCode::QuotaExceeded),
    ("malformed-success.json", CapabilityErrorCode::InvalidResponse),
  ];
  for (fixture_name, expected) in cases {
    let fixture = installed_fixture();
    let instance_id = Uuid::now_v7();
    let grant = grant_for(&fixture, instance_id, "translate.text@1");
    let (verified, _) = artifact(&fixture, "translate/fixtures/langnext-google-cloud-translate.wasm");
    let body = match fixture_name {
      "error-400.json" => include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/google-cloud/tests/fixtures/translate/error-400.json"
      )),
      "error-401.json" => include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/google-cloud/tests/fixtures/translate/error-401.json"
      )),
      "error-403.json" => include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/google-cloud/tests/fixtures/translate/error-403.json"
      )),
      "error-429.json" => include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/google-cloud/tests/fixtures/translate/error-429.json"
      )),
      _ => include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/google-cloud/tests/fixtures/translate/malformed-success.json"
      )),
    };
    let status = match expected {
      CapabilityErrorCode::InvalidRequest => 400,
      CapabilityErrorCode::Auth => 401,
      CapabilityErrorCode::PermissionDenied => 403,
      CapabilityErrorCode::QuotaExceeded => 429,
      CapabilityErrorCode::InvalidResponse => 200,
      _ => 500,
    };
    *fixture.transport.response.lock().unwrap() = json_response(status, body);
    let handler = WasmTranslateTextAdapter::new(
      fixture.runtime.clone(),
      verified,
      grant,
      "translate.text@1",
      config(),
      b"{}".to_vec(),
      broker_factory(fixture.transport.clone(), fixture.tokens.clone()),
    );
    let error = tauri::async_runtime::block_on(handler.translate(
      instance_id,
      TranslateTextRequest {
        text: "Hello".into(),
        source_language_id: "auto".into(),
        target_language_id: "zh".into(),
      },
      context(instance_id, "translate.text@1", "google-cloud-error-fixture"),
    ))
    .unwrap_err();
    assert_eq!(error.code, expected, "fixture {fixture_name}");
    assert!(!error.message.contains("secret"));
  }
}

#[test]
fn google_cloud_wasm_broker_injects_host_bearer_for_approved_translate_grant() {
  google_cloud_runtime_host_injects_bearer_only_for_approved_google_policy();
}

#[test]
fn google_cloud_runtime_host_injects_bearer_only_for_approved_google_policy() {
  let fixture = installed_fixture();
  let instance_id = Uuid::now_v7();
  let grant = grant_for(&fixture, instance_id, "translate.text@1");
  let principal = grant
    .principal_for_request("translate.text@1", "google-cloud-auth-fixture")
    .unwrap();
  let handle = NetworkBrokerHandle::new_with_token_grants(fixture.transport.clone(), fixture.tokens.clone());
  let authorization = crate::services::wasm_runtime::host::BrokerAuthorization {
    endpoint_id: crate::domain::runtime_plugin::EndpointId::parse("translate").unwrap(),
    origin: HttpsOrigin::parse("https://translation.googleapis.com").unwrap(),
    base_url: "https://translation.googleapis.com".into(),
    origin_kind: NetworkOriginKind::HostFixed,
    auth_policy: AuthPolicyId::parse("com.langnext.auth.google-service-account").unwrap(),
    resource_limits: RuntimeResourceLimits::default(),
    response_body_modes: NetworkResponseBodyModes::JSON_ONLY,
    selected_response_mode: crate::domain::plugin_resource::NetworkResponseBodyMode::Json,
  };
  let outcome = tauri::async_runtime::block_on(handle.fetch(
    &principal,
    &grant,
    crate::services::wasm_runtime::host::BrokerFetchRequest {
      endpoint_id: "translate".into(),
      relative_path: "v3beta1/projects/demo/locations/global:translateText".into(),
      method: "POST".into(),
      headers: vec![],
      body: crate::services::wasm_runtime::host::BrokerRequestBody::Json(br#"{}"#.to_vec()),
    },
    authorization,
    &CancelToken::new(),
    None,
  ));
  assert!(outcome.is_ok());
  let prepared = fixture.transport.last.lock().unwrap().take().unwrap();
  assert_eq!(
    prepared.headers.get("Authorization").map(String::as_str),
    Some("Bearer fixture-token")
  );
}

#[test]
fn google_cloud_runtime_package_digest_is_stable_and_contains_all_capabilities() {
  let fixture = installed_fixture();
  let capability_ids: Vec<_> = fixture
    .package
    .manifest
    .capabilities
    .iter()
    .map(|cap| cap.id.as_str())
    .collect();
  assert_eq!(
    capability_ids,
    vec![
      "translate.text@1",
      "translate.detect@1",
      "ocr.image@1",
      "speech.synthesize@1"
    ]
  );
  assert_eq!(fixture.package.package_digest, public_sha256_hex(PACKAGE_BYTES));
}
