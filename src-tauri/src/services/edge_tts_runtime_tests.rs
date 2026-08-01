// ABOUTME: Phase 6 Edge TTS runtime dispatch tests through Wasm + broker + BlobHandle.
// ABOUTME: Install -> activate -> synthesize via capture transport; bundled rollback remains available.
#![cfg(test)]

use crate::domain::cancel::CancelToken;
use crate::domain::endpoint_trust::{
  EDGE_TTS_TRUST_ENDPOINT_ALIAS, EndpointTrustPreviewInput, IntegrationEndpointTrust, RuntimeIdentityFingerprintInput,
  configuration_fingerprint, runtime_identity_fingerprint,
};
use crate::domain::runtime_lifecycle::{ApplyRuntimeUpgradeInput, InstanceRuntimeState};
use crate::domain::service_capability::{
  EDGE_TTS_VOICE_DEFAULT, ExecutionContext, SPEECH_SYNTHESIZE_CAPABILITY_ID, SpeechSynthesizeRequest,
};
use crate::domain::service_integration::{
  EDGE_TTS_PLUGIN_ID, IntegrationHealthStatus, IntegrationInstance, IntegrationInstanceWrite,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::repositories::{integration_endpoint_trusts, integration_instances, plugin_permission_grants};
use crate::services::bounded_http::{BoundedHttpResponse, PreparedHttpRequest, RawHttpTransport};
use crate::services::edge_tts::{EDGE_TTS_SYNTHESIZE_PATH, normalize_edge_tts_base_url, serialize_edge_tts_config};
use crate::services::plugin_store::PluginPackageService;
use crate::services::runtime_lifecycle::RuntimeLifecycleService;
use crate::services::runtime_router::RuntimeRouter;
use crate::services::service_capabilities::{ServiceCapabilityRegistry, ServiceCapabilityService};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::service_integrations::ServiceIntegrationService;
use crate::services::token_grant::TokenGrantService;
use crate::services::vendor_trust::test_vendor_fixture::fixture_vendor_public_key;
use crate::services::wasm_runtime::WasmRuntime;
use crate::services::wasm_runtime::host::BrokerHandle;
use crate::services::wasm_runtime::network_handle::NetworkBrokerHandle;
use crate::storage::Database;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const EDGE_TTS_LNPLUGIN: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/edge-tts/fixtures/com.langnext.edge-tts-1.0.0.lnplugin"
));

struct CaptureTransport {
  last: Mutex<Option<PreparedHttpRequest>>,
  calls: AtomicUsize,
  response: Mutex<Result<BoundedHttpResponse, String>>,
}

impl RawHttpTransport for CaptureTransport {
  fn request(
    &self,
    prepared: PreparedHttpRequest,
  ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>> {
    self.calls.fetch_add(1, Ordering::SeqCst);
    *self.last.lock().unwrap() = Some(prepared);
    Box::pin(async move {
      match &*self.response.lock().unwrap() {
        Ok(response) => Ok(response.clone()),
        Err(error) => Err(crate::error::StorageError::Validation(error.clone())),
      }
    })
  }

  fn stream(
    &self,
    _prepared: PreparedHttpRequest,
    _cancel: CancelToken,
    _on_event: Box<
      dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
    >,
  ) -> Pin<Box<dyn Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
    Box::pin(async { Err(crate::error::StorageError::Validation("stream not supported".into())) })
  }
}

fn setup() -> (
  tempfile::TempDir,
  Database,
  PluginPackageService,
  RuntimeLifecycleService,
  Arc<ServiceCapabilityService>,
  Arc<CaptureTransport>,
) {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let wasm = Arc::new(WasmRuntime::new().unwrap());
  let tokens = Arc::new(TokenGrantService::new(Arc::new(
    crate::services::google_service_account::GoogleServiceAccountExchanger::new(
      db.clone(),
      Arc::new(crate::credentials::MemoryCredentialVault::default()),
    ),
  )));
  let lifecycle =
    RuntimeLifecycleService::new(db.clone(), packages.clone(), registry.clone()).with_runtime(wasm.clone(), tokens);
  let handlers = Arc::new(ServiceCapabilityRegistry::new());
  let router = RuntimeRouter::new(
    db.clone(),
    registry.clone(),
    handlers.clone(),
    packages.clone(),
    wasm.clone(),
  );
  let transport = Arc::new(CaptureTransport {
    last: Mutex::new(None),
    calls: AtomicUsize::new(0),
    response: Mutex::new(Ok(BoundedHttpResponse {
      status: 200,
      headers: HashMap::from([("content-type".into(), "audio/mpeg".into())]),
      body: vec![0xFF, 0xFB, 0x90, 0x64],
    })),
  });
  let broker_transport = transport.clone();
  let broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync> =
    Arc::new(move || Box::new(NetworkBrokerHandle::new(broker_transport.clone())));
  let caps = Arc::new(
    ServiceCapabilityService::new(db.clone(), registry, handlers)
      .with_router(router, wasm)
      .with_broker_factory(broker_factory),
  );
  (dir, db, packages, lifecycle, caps, transport)
}

fn integration_service_without_lifecycle(db: &Database) -> ServiceIntegrationService {
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let vault = Arc::new(crate::credentials::MemoryCredentialVault::default());
  let tokens = Arc::new(TokenGrantService::new(Arc::new(
    crate::services::google_service_account::GoogleServiceAccountExchanger::new(db.clone(), vault.clone()),
  )));
  ServiceIntegrationService::new(db.clone(), vault, registry, tokens)
}

fn integration_service(db: &Database, lifecycle: &RuntimeLifecycleService) -> ServiceIntegrationService {
  integration_service_without_lifecycle(db).with_runtime_lifecycle(lifecycle.clone())
}

fn seed_instance(db: &Database, base_url: &str) -> Uuid {
  let id = new_id();
  let now = now_rfc3339();
  let config_json = serialize_edge_tts_config(&crate::domain::service_integration::EdgeTtsConfigV1 {
    base_url: base_url.into(),
  })
  .unwrap();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id,
        plugin_id: EDGE_TTS_PLUGIN_ID.into(),
        plugin_version: "1.0.0".into(),
        display_name: "Edge TTS".into(),
        enabled: true,
        config_json,
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
        last_validated_at: None,
        last_error_code: None,
        runtime_kind: "bundled-rust".into(),
        package_digest: None,
        execution_grant_set_revision: None,
        runtime_state: InstanceRuntimeState::Active.as_str().into(),
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

fn approve_target_custom_endpoint(db: &Database, instance_id: Uuid, digest: &str) {
  let instance = db.read(|conn| integration_instances::get(conn, instance_id)).unwrap();
  let config_fingerprint = configuration_fingerprint(&instance.config_json).unwrap();
  let config_value = serde_json::from_str::<serde_json::Value>(&instance.config_json).unwrap();
  let base_url = config_value
    .get("base-url")
    .and_then(serde_json::Value::as_str)
    .unwrap();
  let normalized_base_url = normalize_edge_tts_base_url(base_url).unwrap().canonical_url;
  let runtime_identity_fingerprint = runtime_identity_fingerprint(RuntimeIdentityFingerprintInput {
    plugin_id: EDGE_TTS_PLUGIN_ID,
    plugin_version: "1.0.0",
    runtime_kind: "wasm-component",
    package_digest: Some(digest),
  });
  db.transaction(|uow| {
    integration_endpoint_trusts::upsert(
      uow.conn(),
      &IntegrationEndpointTrust {
        id: new_id(),
        integration_instance_id: instance_id,
        plugin_id: EDGE_TTS_PLUGIN_ID.into(),
        plugin_version: "1.0.0".into(),
        endpoint_alias: EDGE_TTS_TRUST_ENDPOINT_ALIAS.into(),
        normalized_origin: normalized_base_url,
        configuration_fingerprint: config_fingerprint,
        runtime_identity_fingerprint,
        approved_at: now_rfc3339(),
      },
    )
  })
  .unwrap();
}

fn activate(lifecycle: &RuntimeLifecycleService, instance_id: Uuid, digest: &str) {
  let preview = lifecycle.preview_upgrade(instance_id, digest).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
}

fn run_approved_wasm_synthesis(base_url: &str, request_id: &str) -> PreparedHttpRequest {
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, base_url);
  approve_target_custom_endpoint(&db, id, &digest);
  activate(&lifecycle, id, &digest);

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  let response = block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: "approved DNS result".into(),
      language_id: "en".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(id, request_id),
  ))
  .expect("approved custom endpoint should execute through Wasm and BrokerHandle");
  assert!(!response.mp3_bytes.is_empty());
  transport.last.lock().unwrap().take().expect("transport called")
}

fn block_on<T>(fut: impl std::future::Future<Output = T>) -> T {
  tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .unwrap()
    .block_on(fut)
}

fn ctx(id: Uuid, rid: &str) -> ExecutionContext {
  ExecutionContext {
    request_id: rid.into(),
    cancel: CancelToken::new(),
    deadline: None,
    integration_instance_id: id,
    plugin_id: EDGE_TTS_PLUGIN_ID.into(),
    capability_id: SPEECH_SYNTHESIZE_CAPABILITY_ID.into(),
    provider_attempt: crate::domain::service_capability::ProviderAttemptTracker::new(),
  }
}

#[test]
fn edge_tts_runtime_synthesize_returns_binary_audio_via_blob() {
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://tts.wangwangit.com");
  activate(&lifecycle, id, &digest);

  let mp3 = vec![0xFF, 0xFB, 0x90, 0x64, 0x00, 0x01];
  *transport.response.lock().unwrap() = Ok(BoundedHttpResponse {
    status: 200,
    headers: HashMap::from([("content-type".into(), "audio/mpeg".into())]),
    body: mp3.clone(),
  });

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  let response = block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: "你好".into(),
      language_id: "zh".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(id, "edge-wasm-1"),
  ))
  .expect("synthesize");

  assert_eq!(response.mp3_bytes, mp3);
  let prepared = transport.last.lock().unwrap().take().expect("transport called");
  assert!(
    prepared.url.as_str().contains(EDGE_TTS_SYNTHESIZE_PATH),
    "url={}",
    prepared.url
  );
  assert_eq!(prepared.headers.get("Accept").map(String::as_str), Some("audio/mpeg"));
  assert_eq!(prepared.content_type.as_deref(), Some("application/json"));
}

#[test]
fn edge_tts_runtime_approved_custom_origin_uses_user_approved_policy() {
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://edge.example/api");
  approve_target_custom_endpoint(&db, id, &digest);
  activate(&lifecycle, id, &digest);

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  let response = block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: "approved".into(),
      language_id: "en".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(id, "edge-wasm-approved-custom"),
  ))
  .expect("approved custom endpoint should execute");
  assert!(!response.mp3_bytes.is_empty());
  let prepared = transport.last.lock().unwrap().take().expect("transport called");
  assert_eq!(
    prepared.destination_policy,
    crate::services::bounded_http::DestinationPolicy::UserApprovedCustom
  );
  assert_eq!(prepared.proxy_mode, crate::domain::provider::ProxyMode::Inherit);
  assert_eq!(prepared.url.path(), "/api/v1/audio/speech");
}

/// The bounded HTTP synthetic-resolver test proves that this policy preserves a fake-IP DNS
/// answer. This runtime test proves the approved decision reaches the Wasm BrokerHandle instead
/// of being downgraded to PublicInternet or rejected before the transport seam.
#[test]
fn edge_tts_runtime_approved_fake_ip_dns_result_uses_user_approved_policy() {
  let prepared = run_approved_wasm_synthesis("https://approved-fake-ip.test", "edge-wasm-approved-fake-ip");
  assert_eq!(
    prepared.destination_policy,
    crate::services::bounded_http::DestinationPolicy::UserApprovedCustom
  );
  assert_eq!(prepared.proxy_mode, crate::domain::provider::ProxyMode::Inherit);
  assert_eq!(prepared.url.host_str(), Some("approved-fake-ip.test"));
}

/// The bounded HTTP synthetic-resolver test proves that this policy preserves a private DNS
/// answer. This runtime test proves the approved decision reaches the Wasm BrokerHandle without
/// exposing a DNS-result class to the guest or changing the host-selected policy.
#[test]
fn edge_tts_runtime_approved_private_dns_result_uses_user_approved_policy() {
  let prepared = run_approved_wasm_synthesis("https://approved-private.test", "edge-wasm-approved-private");
  assert_eq!(
    prepared.destination_policy,
    crate::services::bounded_http::DestinationPolicy::UserApprovedCustom
  );
  assert_eq!(prepared.proxy_mode, crate::domain::provider::ProxyMode::Inherit);
  assert_eq!(prepared.url.host_str(), Some("approved-private.test"));
}

#[test]
fn edge_tts_runtime_reconfirmation_resigns_user_approved_provenance_after_lifecycle_change() {
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let service = integration_service(&db, &lifecycle);
  let custom_config = r#"{"base-url":"https://edge.example/api"}"#;
  let create = IntegrationInstanceWrite {
    id: None,
    plugin_id: EDGE_TTS_PLUGIN_ID.into(),
    display_name: "Edge TTS".into(),
    enabled: true,
    config_json: custom_config.into(),
    credentials: vec![],
    expected_updated_at: None,
    endpoint_trust_preview_id: None,
    acknowledge_endpoint_trust: false,
  };
  let preview = service
    .preview_endpoint_trust(EndpointTrustPreviewInput {
      plugin_id: EDGE_TTS_PLUGIN_ID.into(),
      instance_id: None,
      config_json: custom_config.into(),
      expected_updated_at: None,
    })
    .expect("custom create preview");
  let created = service
    .save(IntegrationInstanceWrite {
      endpoint_trust_preview_id: Some(preview.preview_id),
      acknowledge_endpoint_trust: true,
      ..create
    })
    .expect("custom create");
  assert_eq!(
    created.endpoint_trust_status,
    crate::domain::endpoint_trust::EndpointTrustStatus::TrustedCustom
  );

  // The public integration save created a bundled-runtime approval. Exercise that real Bundled
  // Rust handler through NetworkBroker before changing the runtime identity.
  let bundled_registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let bundled_network = Arc::new(crate::services::network_broker::NetworkBroker::with_transport(
    db.clone(),
    bundled_registry,
    transport.clone(),
  ));
  let bundled_handler = crate::services::edge_tts::EdgeTtsCapabilities::new(bundled_network);
  let bundled_response = block_on(bundled_handler.synthesize_speech(
    created.id,
    SpeechSynthesizeRequest {
      text: "bundled approved".into(),
      language_id: "en".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(created.id, "edge-bundled-approved"),
  ))
  .expect("approved custom endpoint should execute through Bundled Rust and NetworkBroker");
  assert!(!bundled_response.mp3_bytes.is_empty());
  let bundled_prepared = transport.last.lock().unwrap().take().expect("bundled transport called");
  assert_eq!(
    bundled_prepared.destination_policy,
    crate::services::bounded_http::DestinationPolicy::UserApprovedCustom
  );
  let calls_after_bundled = transport.calls.load(Ordering::SeqCst);

  // The lifecycle identity change revokes the bundled-runtime approval and leaves the active Wasm
  // grant fail-closed until the user reviews the same base URL again.
  activate(&lifecycle, created.id, &digest);
  let activated = service.get_instance(created.id).expect("activated instance");
  assert_eq!(
    activated.endpoint_trust_status,
    crate::domain::endpoint_trust::EndpointTrustStatus::ReviewRequired
  );
  let wasm_handler = caps
    .resolve_speech_synthesize(created.id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve active Wasm speech");
  let stale_error = block_on(wasm_handler.synthesize(
    created.id,
    SpeechSynthesizeRequest {
      text: "stale approval".into(),
      language_id: "en".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(created.id, "edge-wasm-stale-approval"),
  ))
  .unwrap_err();
  assert_eq!(
    stale_error.code,
    crate::domain::service_capability::CapabilityErrorCode::EndpointTrustRequired
  );
  assert_eq!(transport.calls.load(Ordering::SeqCst), calls_after_bundled);

  let reconfirm_preview = service
    .preview_endpoint_trust(EndpointTrustPreviewInput {
      plugin_id: EDGE_TTS_PLUGIN_ID.into(),
      instance_id: Some(created.id),
      config_json: activated.config_json.clone(),
      expected_updated_at: Some(activated.updated_at.clone()),
    })
    .expect("reconfirmation preview");
  let resigned = service
    .save(IntegrationInstanceWrite {
      id: Some(created.id),
      plugin_id: EDGE_TTS_PLUGIN_ID.into(),
      display_name: activated.display_name.clone(),
      enabled: activated.enabled,
      config_json: activated.config_json.clone(),
      credentials: vec![],
      expected_updated_at: Some(activated.updated_at.clone()),
      endpoint_trust_preview_id: Some(reconfirm_preview.preview_id),
      acknowledge_endpoint_trust: true,
    })
    .expect("reconfirmation must save and re-sign atomically");
  assert_eq!(
    resigned.endpoint_trust_status,
    crate::domain::endpoint_trust::EndpointTrustStatus::TrustedCustom
  );
  assert!(resigned.execution_grant_set_revision.unwrap() > activated.execution_grant_set_revision.unwrap());

  let bundle = db
    .read(|conn| {
      plugin_permission_grants::get_bundle_for_subject_package_revision(
        conn,
        crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
        created.id,
        &digest,
        resigned.execution_grant_set_revision.unwrap(),
      )
    })
    .expect("re-signed grant");
  let entry = bundle
    .network
    .iter()
    .find(|entry| entry.endpoint_id == EDGE_TTS_TRUST_ENDPOINT_ALIAS)
    .expect("Edge TTS network grant");
  assert_eq!(entry.origin_kind, "user_approved_instance");
  assert_eq!(entry.base_url, "https://edge.example/api");
  assert_eq!(entry.origin, "https://edge.example");

  let reconfirmed_handler = caps
    .resolve_speech_synthesize(created.id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve re-signed Wasm speech");
  let wasm_response = block_on(reconfirmed_handler.synthesize(
    created.id,
    SpeechSynthesizeRequest {
      text: "reconfirmed".into(),
      language_id: "en".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(created.id, "edge-wasm-reconfirmed"),
  ))
  .expect("reconfirmed custom endpoint should execute through Wasm and BrokerHandle");
  assert!(!wasm_response.mp3_bytes.is_empty());
  let wasm_prepared = transport
    .last
    .lock()
    .unwrap()
    .take()
    .expect("reconfirmed transport called");
  assert_eq!(
    wasm_prepared.destination_policy,
    crate::services::bounded_http::DestinationPolicy::UserApprovedCustom
  );
  assert_eq!(wasm_prepared.proxy_mode, crate::domain::provider::ProxyMode::Inherit);
}

#[test]
fn edge_tts_runtime_reconfirmation_failure_does_not_report_trusted() {
  let (_dir, db, packages, lifecycle, _caps, _transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://edge.example/api");
  activate(&lifecycle, id, &digest);
  let service = integration_service_without_lifecycle(&db);
  let current = service.get_instance(id).expect("active instance");
  let preview = service
    .preview_endpoint_trust(EndpointTrustPreviewInput {
      plugin_id: EDGE_TTS_PLUGIN_ID.into(),
      instance_id: Some(id),
      config_json: current.config_json.clone(),
      expected_updated_at: Some(current.updated_at.clone()),
    })
    .expect("reconfirmation preview");
  let error = service
    .save(IntegrationInstanceWrite {
      id: Some(id),
      plugin_id: EDGE_TTS_PLUGIN_ID.into(),
      display_name: current.display_name,
      enabled: current.enabled,
      config_json: current.config_json,
      credentials: vec![],
      expected_updated_at: Some(current.updated_at),
      endpoint_trust_preview_id: Some(preview.preview_id),
      acknowledge_endpoint_trust: true,
    })
    .unwrap_err();
  assert!(matches!(error, crate::error::StorageError::Internal(_)));
  let unchanged = service.get_instance(id).expect("rolled back instance");
  assert_eq!(
    unchanged.endpoint_trust_status,
    crate::domain::endpoint_trust::EndpointTrustStatus::ReviewRequired
  );
  assert_eq!(
    unchanged.execution_grant_set_revision,
    current.execution_grant_set_revision
  );
}

#[test]
fn edge_tts_runtime_unapproved_custom_origin_returns_endpoint_trust_required() {
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://edge.example/api");
  activate(&lifecycle, id, &digest);

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  let error = block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: "blocked".into(),
      language_id: "en".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(id, "edge-wasm-unapproved-custom"),
  ))
  .unwrap_err();
  assert_eq!(
    error.code,
    crate::domain::service_capability::CapabilityErrorCode::EndpointTrustRequired
  );
  assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn edge_tts_runtime_bundled_rollback_remains_available() {
  let (_dir, db, packages, lifecycle, _caps, _transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://edge.example");
  let before = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(before.runtime_kind, "bundled-rust");

  activate(&lifecycle, id, &digest);
  let activated = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(activated.runtime_kind, "wasm-component");
  assert_eq!(activated.runtime_state, InstanceRuntimeState::Active.as_str());

  let rb = lifecycle.preview_rollback(id).unwrap();
  lifecycle
    .apply_rollback(crate::domain::runtime_lifecycle::ApplyRuntimeRollbackInput {
      preview_id: rb.preview_id,
    })
    .unwrap();
  let restored = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(restored.runtime_kind, "bundled-rust");
  assert_eq!(restored.package_digest, None);
}

/// Provider contract validation: a 200 response with a non-audio content type (e.g. JSON error
/// body) must not be accepted as MP3. The host executor enforces audio/mpeg after the guest
/// returns the output blob.
#[test]
fn edge_tts_runtime_rejects_wrong_content_type() {
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://tts.wangwangit.com");
  activate(&lifecycle, id, &digest);

  // 200 OK but content-type is application/json (e.g. an error body smuggled as audio).
  *transport.response.lock().unwrap() = Ok(BoundedHttpResponse {
    status: 200,
    headers: std::collections::HashMap::from([("content-type".into(), "application/json".into())]),
    body: br#"{"error":"not audio"}"#.to_vec(),
  });

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  let result = block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: "你好".into(),
      language_id: "zh".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(id, "edge-wasm-mime"),
  ));
  assert!(result.is_err(), "wrong content type must be rejected");
  let err = result.unwrap_err();
  assert_eq!(
    err.code,
    crate::domain::service_capability::CapabilityErrorCode::InvalidResponse,
    "expected InvalidResponse, got {:?}",
    err.code
  );
}

/// A 200 response with audio/mpeg and valid parameters (e.g. `audio/mpeg; charset=binary`)
/// must be accepted.
#[test]
fn edge_tts_runtime_accepts_audio_mpeg_with_parameters() {
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://tts.wangwangit.com");
  activate(&lifecycle, id, &digest);

  let mp3 = vec![0xFF, 0xFB, 0x90, 0x64];
  *transport.response.lock().unwrap() = Ok(BoundedHttpResponse {
    status: 200,
    headers: std::collections::HashMap::from([("content-type".into(), "audio/mpeg; charset=binary".into())]),
    body: mp3.clone(),
  });

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  let response = block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: "你好".into(),
      language_id: "zh".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(id, "edge-wasm-mime-ok"),
  ))
  .expect("audio/mpeg with parameters must be accepted");
  assert_eq!(response.mp3_bytes, mp3);
}

/// A 200 response with NO content-type header must be rejected as InvalidResponse: the provider
/// contract requires an audio/mpeg content type, and a missing header cannot be accepted as MP3.
#[test]
fn edge_tts_runtime_rejects_missing_content_type() {
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://tts.wangwangit.com");
  activate(&lifecycle, id, &digest);

  // 200 OK but no content-type header at all.
  *transport.response.lock().unwrap() = Ok(BoundedHttpResponse {
    status: 200,
    headers: std::collections::HashMap::new(),
    body: vec![0xFF, 0xFB, 0x90, 0x64],
  });

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  let result = block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: "你好".into(),
      language_id: "zh".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(id, "edge-wasm-mime-missing"),
  ));
  assert!(result.is_err(), "missing content type must be rejected");
  assert_eq!(
    result.unwrap_err().code,
    crate::domain::service_capability::CapabilityErrorCode::InvalidResponse,
  );
}

/// A 200 response with a near-miss MIME (`audio/mp3`) must be rejected as InvalidResponse. Only
/// the exact `audio/mpeg` type/subtype (with allowed parameters) is accepted.
#[test]
fn edge_tts_runtime_rejects_near_miss_mime() {
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://tts.wangwangit.com");
  activate(&lifecycle, id, &digest);

  // 200 OK but content-type is audio/mp3 (near-miss, not audio/mpeg).
  *transport.response.lock().unwrap() = Ok(BoundedHttpResponse {
    status: 200,
    headers: std::collections::HashMap::from([("content-type".into(), "audio/mp3".into())]),
    body: vec![0xFF, 0xFB, 0x90, 0x64],
  });

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  let result = block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: "你好".into(),
      language_id: "zh".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(id, "edge-wasm-mime-nearmiss"),
  ));
  assert!(result.is_err(), "near-miss MIME must be rejected");
  assert_eq!(
    result.unwrap_err().code,
    crate::domain::service_capability::CapabilityErrorCode::InvalidResponse,
  );
}

// --- Phase 6 conformance: load and assert the committed Edge TTS guest fixtures ---

const SYNTHESIZE_REQUEST_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/edge-tts/tests/fixtures/synthesize-request.json"
));
const ERROR_RESPONSE_400_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/edge-tts/tests/fixtures/error-response-400.json"
));
const ERROR_RESPONSE_429_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/edge-tts/tests/fixtures/error-response-429.json"
));

/// Execute the installed guest through the runtime router, executor, broker, and real capture
/// transport. The exact outgoing body is compared semantically with the committed fixture, so
/// guest field names/casing, voice/speed/pitch/style encoding, endpoint, and media headers cannot
/// drift while a fixture-only assertion still passes.
#[test]
fn edge_tts_runtime_request_fixture_matches_guest_contract() {
  const FIXTURE_BASE_URL: &str = "https://tts.wangwangit.com";
  const FIXTURE_SYNTHESIZE_URL: &str = "https://tts.wangwangit.com/v1/audio/speech";
  const FIXTURE_REQUEST_ID: &str = "edge-wasm-request-fixture";

  let expected_body: serde_json::Value =
    serde_json::from_str(SYNTHESIZE_REQUEST_FIXTURE).expect("request fixture must be valid JSON");
  let expected = expected_body.as_object().expect("request fixture must be an object");
  let input = expected["input"].as_str().expect("fixture input string");
  let voice = expected["voice"].as_str().expect("fixture voice string");
  let speed = expected["speed"].as_f64().expect("fixture speed number");
  let pitch = expected["pitch"].as_str().expect("fixture pitch string");
  let style = expected["style"].as_str().expect("fixture style string");
  let host_pitch: f64 = pitch.parse().expect("fixture pitch must convert to host preference");

  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let id = seed_instance(&db, FIXTURE_BASE_URL);
  activate(&lifecycle, id, &import.package_digest().to_string());

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: input.into(),
      language_id: "zh".into(),
      preferences: serde_json::json!({
        "voice": voice,
        "speed": speed,
        "pitch": host_pitch,
        "style": style,
      }),
    },
    ctx(id, FIXTURE_REQUEST_ID),
  ))
  .expect("synthesize through Wasm runtime");

  assert_eq!(
    transport.calls.load(Ordering::SeqCst),
    1,
    "fixture conformance must issue exactly one broker transport request"
  );
  let prepared = transport
    .last
    .lock()
    .unwrap()
    .take()
    .expect("broker transport received request");
  assert_eq!(prepared.url.as_str(), FIXTURE_SYNTHESIZE_URL);
  assert_eq!(prepared.headers.get("Accept").map(String::as_str), Some("audio/mpeg"));
  assert_eq!(prepared.content_type.as_deref(), Some("application/json"));
  let actual_body = match prepared.body {
    crate::services::bounded_http::RequestBody::Text(body) => {
      serde_json::from_str::<serde_json::Value>(&body).expect("guest request body must be JSON")
    }
    crate::services::bounded_http::RequestBody::Bytes(body) => {
      serde_json::from_slice::<serde_json::Value>(&body).expect("guest request body must be JSON")
    }
    crate::services::bounded_http::RequestBody::None => panic!("guest request body must not be empty"),
  };
  assert_eq!(actual_body, expected_body);
}

/// The committed `error-response-400.json` fixture is an OpenAI-shaped 400 body. A 400 response
/// carrying it must map to `InvalidRequest` (the guest maps HTTP 400 to invalid-request).
#[test]
fn edge_tts_runtime_error_400_fixture_maps_to_invalid_request() {
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://tts.wangwangit.com");
  activate(&lifecycle, id, &digest);

  // The fixture must be valid JSON and carry the OpenAI error envelope.
  let fixture: serde_json::Value =
    serde_json::from_str(ERROR_RESPONSE_400_FIXTURE).expect("400 fixture must be valid JSON");
  assert_eq!(fixture["error"]["code"], "voice_not_found");

  *transport.response.lock().unwrap() = Ok(BoundedHttpResponse {
    status: 400,
    headers: std::collections::HashMap::from([("content-type".into(), "application/json".into())]),
    body: ERROR_RESPONSE_400_FIXTURE.as_bytes().to_vec(),
  });

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  let result = block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: "你好".into(),
      language_id: "zh".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(id, "edge-wasm-err-400"),
  ));
  assert!(result.is_err(), "400 response must be an error");
  assert_eq!(
    result.unwrap_err().code,
    crate::domain::service_capability::CapabilityErrorCode::InvalidRequest,
    "400 must map to InvalidRequest",
  );
}

/// The committed `error-response-429.json` fixture is an OpenAI-shaped 429 body. A 429 response
/// carrying it must map to `RateLimited`.
#[test]
fn edge_tts_runtime_error_429_fixture_maps_to_rate_limited() {
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://tts.wangwangit.com");
  activate(&lifecycle, id, &digest);

  let fixture: serde_json::Value =
    serde_json::from_str(ERROR_RESPONSE_429_FIXTURE).expect("429 fixture must be valid JSON");
  assert_eq!(fixture["error"]["code"], "rate_limit_exceeded");

  *transport.response.lock().unwrap() = Ok(BoundedHttpResponse {
    status: 429,
    headers: std::collections::HashMap::from([("content-type".into(), "application/json".into())]),
    body: ERROR_RESPONSE_429_FIXTURE.as_bytes().to_vec(),
  });

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  let result = block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: "你好".into(),
      language_id: "zh".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(id, "edge-wasm-err-429"),
  ));
  assert!(result.is_err(), "429 response must be an error");
  assert_eq!(
    result.unwrap_err().code,
    crate::domain::service_capability::CapabilityErrorCode::RateLimited,
    "429 must map to RateLimited",
  );
}

/// Size cap: a 200 audio/mpeg response larger than the host audio cap
/// (`SPEECH_AUDIO_MAX_BYTES`) must be rejected as InvalidResponse. The broker enforces the
/// grant's `max_response_bytes` (12 MiB for speech) before the body reaches the guest.
#[test]
fn edge_tts_runtime_rejects_oversized_audio() {
  use crate::domain::service_capability::SPEECH_AUDIO_MAX_BYTES;
  let (_dir, db, packages, lifecycle, caps, transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://tts.wangwangit.com");
  activate(&lifecycle, id, &digest);

  // One byte over the host audio cap.
  let oversized = vec![0xFFu8; SPEECH_AUDIO_MAX_BYTES + 1];
  *transport.response.lock().unwrap() = Ok(BoundedHttpResponse {
    status: 200,
    headers: std::collections::HashMap::from([("content-type".into(), "audio/mpeg".into())]),
    body: oversized,
  });

  let handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("resolve speech");
  let result = block_on(handler.synthesize(
    id,
    SpeechSynthesizeRequest {
      text: "你好".into(),
      language_id: "zh".into(),
      preferences: serde_json::json!({
        "voice": EDGE_TTS_VOICE_DEFAULT,
        "speed": 1.0,
        "pitch": 0.0,
        "style": "general",
      }),
    },
    ctx(id, "edge-wasm-oversized"),
  ));
  assert!(result.is_err(), "oversized audio must be rejected");
  assert_eq!(
    result.unwrap_err().code,
    crate::domain::service_capability::CapabilityErrorCode::InvalidResponse,
    "oversized audio must map to InvalidResponse",
  );
}

/// New Edge TTS instances auto-pin the verified vendor-default Wasm package (mirrors Google Web
/// GTX auto-pin but with Edge constraints: instance-configured origin resolved to the
/// vendor-default base URL).
#[test]
fn edge_tts_runtime_new_instance_auto_pins_default_package() {
  let (_dir, db, packages, lifecycle, _caps, _transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://tts.wangwangit.com");

  // Before auto-pin: bundled-rust, no package digest.
  let before = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(before.runtime_kind, "bundled-rust");
  assert!(before.package_digest.is_none());

  lifecycle.pin_default_package_for_new_instance(id).unwrap();

  // After auto-pin: wasm-component, active, pinned to the vendor package.
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(after.runtime_kind, "wasm-component");
  assert_eq!(after.runtime_state, InstanceRuntimeState::Active.as_str());
  assert_eq!(after.package_digest.as_deref(), Some(digest.as_str()));
  assert!(after.execution_grant_set_revision.is_some());
}

/// Migration/upgrade preserves the Speech service capability binding and default references.
/// The lifecycle snapshots pre-migration state and restores it on rollback. This test seeds a
/// real Speech service bound to the Edge TTS instance plus a default selection and preferences,
/// then asserts the service ID, instance reference, default selection, and preferences survive
/// upgrade/migration and rollback.
#[test]
fn edge_tts_runtime_migration_preserves_speech_default_references() {
  use crate::domain::speech_service::{EDGE_TTS_PREFERENCES_SCHEMA_VERSION, SpeechService};
  use crate::repositories::{app_settings, speech_services};

  let (_dir, db, packages, lifecycle, caps, _transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://tts.wangwangit.com");

  // Seed a real Speech service bound to this Edge TTS instance with concrete preferences.
  let service_id = new_id();
  let now = now_rfc3339();
  let preferences = serde_json::json!({
    "voice": EDGE_TTS_VOICE_DEFAULT,
    "speed": 1.0,
    "pitch": 0.0,
    "style": "general",
  });
  db.transaction(|uow| {
    speech_services::insert(
      uow.conn(),
      &SpeechService {
        id: service_id,
        display_name: "Edge TTS default".into(),
        enabled: true,
        sort_order: 0,
        integration_instance_id: id,
        capability_id: SPEECH_SYNTHESIZE_CAPABILITY_ID.into(),
        preferences_schema_version: EDGE_TTS_PREFERENCES_SCHEMA_VERSION,
        preferences: preferences.clone(),
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    Ok(())
  })
  .unwrap();

  // Set the default Speech service selection to this service.
  db.transaction(|uow| {
    let mut settings = app_settings::get(uow.conn())?;
    settings.default_speech_service_id = Some(service_id);
    app_settings::update(uow.conn(), &settings)?;
    Ok(())
  })
  .unwrap();

  // Activate (upgrade) to the Wasm package.
  activate(&lifecycle, id, &digest);
  let activated = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(activated.runtime_kind, "wasm-component");
  assert_eq!(activated.plugin_id, EDGE_TTS_PLUGIN_ID);

  // The Speech service row survives migration: same ID, same instance reference, same preferences.
  let after_migrate = db.read(|conn| speech_services::get(conn, service_id)).unwrap();
  assert_eq!(after_migrate.id, service_id);
  assert_eq!(after_migrate.integration_instance_id, id);
  assert_eq!(after_migrate.capability_id, SPEECH_SYNTHESIZE_CAPABILITY_ID);
  assert_eq!(after_migrate.preferences, preferences);
  // The default selection still references the same service ID.
  let settings_after = db.read(|conn| app_settings::get(conn)).unwrap();
  assert_eq!(settings_after.default_speech_service_id, Some(service_id));
  // The capability is still resolvable after migration.
  let _handler = caps
    .resolve_speech_synthesize(id, SPEECH_SYNTHESIZE_CAPABILITY_ID)
    .expect("speech capability must remain resolvable after migration");

  // Rollback restores the bundled-rust pin; references and preferences must survive.
  let rb = lifecycle.preview_rollback(id).unwrap();
  lifecycle
    .apply_rollback(crate::domain::runtime_lifecycle::ApplyRuntimeRollbackInput {
      preview_id: rb.preview_id,
    })
    .unwrap();
  let restored = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(restored.runtime_kind, "bundled-rust");
  assert_eq!(restored.package_digest, None);
  assert_eq!(restored.plugin_id, EDGE_TTS_PLUGIN_ID);
  assert!(restored.config_json.contains("tts.wangwangit.com"));
  // The Speech service row survives rollback: same ID, instance reference, and preferences.
  let after_rollback = db.read(|conn| speech_services::get(conn, service_id)).unwrap();
  assert_eq!(after_rollback.id, service_id);
  assert_eq!(after_rollback.integration_instance_id, id);
  assert_eq!(after_rollback.preferences, preferences);
  // The default selection still references the same service ID after rollback.
  let settings_rolled = db.read(|conn| app_settings::get(conn)).unwrap();
  assert_eq!(settings_rolled.default_speech_service_id, Some(service_id));
}

/// Edge TTS vendor-default qualification rejects a package with a non-default plugin id, proving
/// the auto-pin cross-bind is real (not a blanket accept).
#[test]
fn edge_tts_runtime_auto_pin_rejects_non_vendor_package() {
  let (_dir, db, packages, lifecycle, _caps, _transport) = setup();
  // Install the real Edge TTS package but do NOT set it as default for a different plugin id.
  let _import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  // Create an instance with a different plugin id (not Edge TTS) -> auto-pin must skip it.
  let id = new_id();
  let now = now_rfc3339();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id,
        plugin_id: "com.langnext.other-tts".into(),
        plugin_version: "1.0.0".into(),
        display_name: "Other TTS".into(),
        enabled: true,
        config_json: "{}".into(),
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
        last_validated_at: None,
        last_error_code: None,
        runtime_kind: "bundled-rust".into(),
        package_digest: None,
        execution_grant_set_revision: None,
        runtime_state: InstanceRuntimeState::Active.as_str().into(),
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

  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  // Auto-pin must skip: the instance has no default package for its plugin id.
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(after.runtime_kind, "bundled-rust");
  assert!(after.package_digest.is_none());
}

/// Auto-pin consent gate: a custom HTTPS base URL must NOT be host-auto-approved. The manifest
/// matches the real Edge TTS vendor package, but the EFFECTIVE origin (`https://evil.example`)
/// differs from the vendor default, so auto-pin fails closed and the instance stays Bundled Rust
/// with no grant. The user must go through explicit permission preview/approval instead.
#[test]
fn edge_tts_runtime_auto_pin_rejects_custom_origin() {
  let (_dir, db, packages, lifecycle, _caps, _transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  let id = seed_instance(&db, "https://evil.example/api");

  lifecycle.pin_default_package_for_new_instance(id).unwrap();

  // Auto-pin must fail closed: custom origin is not the vendor default.
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(after.runtime_kind, "bundled-rust", "custom origin must not auto-pin");
  assert!(after.package_digest.is_none(), "no grant for custom origin");
  assert!(after.execution_grant_set_revision.is_none());
  let _ = digest; // vendor package exists but must not be auto-pinned for a custom origin.

  let official_origin_custom_path = seed_instance(&db, "https://tts.wangwangit.com/api");
  lifecycle
    .pin_default_package_for_new_instance(official_origin_custom_path)
    .unwrap();
  let path_variant = db
    .read(|conn| integration_instances::get(conn, official_origin_custom_path))
    .unwrap();
  assert_eq!(path_variant.runtime_kind, "bundled-rust");
  assert!(path_variant.package_digest.is_none());
}

/// Equivalent normalized default origin auto-pins: a trailing slash on the vendor-default URL
/// normalizes to the same HTTPS origin, so auto-pin succeeds (consent not required).
#[test]
fn edge_tts_runtime_auto_pin_accepts_equivalent_normalized_default() {
  let (_dir, db, packages, lifecycle, _caps, _transport) = setup();
  let import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  let digest = import.package_digest().to_string();
  // Trailing slash normalizes to the vendor-default origin.
  let id = seed_instance(&db, "https://tts.wangwangit.com/");

  lifecycle.pin_default_package_for_new_instance(id).unwrap();

  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(
    after.runtime_kind, "wasm-component",
    "equivalent default origin must auto-pin"
  );
  assert_eq!(after.runtime_state, InstanceRuntimeState::Active.as_str());
  assert_eq!(after.package_digest.as_deref(), Some(digest.as_str()));
  assert!(after.execution_grant_set_revision.is_some());
}

/// Auto-pin consent gate: a malformed/non-HTTPS base URL must not auto-pin. The effective
/// origin cannot be normalized to HTTPS, so auto-pin fails closed.
#[test]
fn edge_tts_runtime_auto_pin_rejects_non_https_origin() {
  let (_dir, db, packages, lifecycle, _caps, _transport) = setup();
  let _import = packages
    .bootstrap_bundled_package(EDGE_TTS_LNPLUGIN, true)
    .expect("bootstrap edge-tts package");
  // Non-HTTPS base URL: normalize_edge_tts_base_url rejects it, so the effective origin check
  // fails closed. seed_instance stores the raw value; the auto-pin gate normalizes at apply time.
  let id = seed_instance(&db, "http://tts.wangwangit.com");

  lifecycle.pin_default_package_for_new_instance(id).unwrap();

  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(after.runtime_kind, "bundled-rust", "non-https origin must not auto-pin");
  assert!(after.package_digest.is_none());
  assert!(after.execution_grant_set_revision.is_none());
}
