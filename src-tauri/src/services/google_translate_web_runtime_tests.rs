// ABOUTME: Phase 5 Google Translate Web runtime dispatch tests through the Wasm runtime router.
// ABOUTME: Install -> activate -> Translate/Detect via Wasm with a capture transport; no live network.
#![cfg(test)]

use crate::domain::cancel::CancelToken;
use crate::domain::plugin_package::ApprovePluginPackageInput;
use crate::domain::plugin_package::{
  InstalledPluginVersion, PublisherSource, compute_permission_request_digest, decode_lowercase_hex,
  encode_lowercase_hex, runtime_kind_storage,
};
use crate::domain::runtime_lifecycle::{ApplyRuntimeUpgradeInput, InstanceRuntimeState};
use crate::domain::runtime_plugin::{
  AuthPolicyId, CapabilityDeclaration, CapabilityId, EndpointId, FileRole, HttpMethod, HttpsOrigin, MANIFEST_FILE_PATH,
  NetworkEndpointRequest, NetworkGrantEntry, NetworkOriginKind, NetworkResourceMode, PermissionRequests,
  PluginFileEntry, PluginManifestV1, PublisherDeclaration, ResourceLimits, RuntimeDescriptor, RuntimeKind,
  SIGNATURE_FILE_PATH,
};
use crate::domain::service_capability::{
  CapabilityErrorCode, DetectLanguageRequest, ExecutionContext, TranslateTextRequest,
};
use crate::domain::service_integration::{
  GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL, GOOGLE_TRANSLATE_WEB_PLUGIN_ID, IntegrationHealthStatus, IntegrationInstance,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{
  GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION, PluginCapabilityEngine, TranslationProfile, TranslationProfileEngine,
};
use crate::error::StorageError;
use crate::repositories::{installed_plugin_versions, integration_instances, plugin_publishers, translation_profiles};
use crate::services::bounded_http::{BoundedHttpResponse, DestinationPolicy, PreparedHttpRequest, RawHttpTransport};
use crate::services::plugin_package::{
  hash_archive_bytes, inspect_package_bytes, public_sha256_hex, set_readonly, verify_package_bytes,
  write_extracted_content,
};
use crate::services::plugin_store::{PluginPackageService, VendorDefaultBindingMode};
use crate::services::runtime_lifecycle::RuntimeLifecycleService;
use crate::services::runtime_router::RuntimeRouter;
use crate::services::service_capabilities::{
  ProfileCapabilityKind, ServiceCapabilityRegistry, ServiceCapabilityService,
};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::service_integrations::ServiceIntegrationService;
use crate::services::token_grant::TokenGrantService;
use crate::services::vendor_trust::test_vendor_fixture::{
  fixture_vendor_fingerprint, fixture_vendor_public_key, fixture_vendor_public_key_hex, fixture_vendor_signing_key,
};
use crate::services::wasm_runtime::WasmRuntime;
use crate::services::wasm_runtime::host::BrokerHandle;
use crate::services::wasm_runtime::network_handle::NetworkBrokerHandle;
use crate::storage::Database;
use ed25519_dalek::{Signer, SigningKey};
use std::collections::HashMap;
use std::future::Future;
use std::io::Write;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use uuid::Uuid;

const TRANSLATE_WASM: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-translate-web/translate/fixtures/langnext-google-translate-web-translate.wasm"
));
const DETECT_WASM: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-translate-web/detect/fixtures/langnext-google-translate-web-detect.wasm"
));
const CONFIG_SCHEMA_GTX: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-translate-web/schemas/config.json"
));
const CONFIG_SCHEMA_PROXY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-translate-web/schemas/config-proxy.json"
));
const PREFS_SCHEMA: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-translate-web/schemas/translate-preferences.json"
));
const LOCALE_EN: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-translate-web/locales/en.json"
));
const LOCALE_ZH: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-translate-web/locales/zh-CN.json"
));

const PLUGIN_ID: &str = GOOGLE_TRANSLATE_WEB_PLUGIN_ID;
const TRANSLATE_CAP: &str = "translate.text@1";
const DETECT_CAP: &str = "translate.detect@1";
const GTX_ORIGIN: &str = "https://translate.google.com";
const TRANSLATE_ARTIFACT_PATH: &str = "translate/fixtures/langnext-google-translate-web-translate.wasm";
const DETECT_ARTIFACT_PATH: &str = "detect/fixtures/langnext-google-translate-web-detect.wasm";
const USER_SIGNED_PACKAGE_VERSION: &str = "1.0.0";
const THIRD_PARTY_STATIC_ENDPOINT_ID: &str = "third-party-static";
const THIRD_PARTY_STATIC_MANIFEST_ORIGIN: &str = "https://third-party.example";
const TAMPERED_PUBLIC_HTTPS_ORIGIN: &str = "https://attacker.example";
const EMPTY_PREFERENCES_JSON: &[u8] = b"{}";
const TEST_PROFILE_NAME: &str = "Static Origin Test";
const TEST_PROFILE_SOURCE_LANGUAGE: &str = "en";
const TEST_PROFILE_TARGET_LANGUAGE: &str = "zh";

/// Capture transport: records the last prepared request and returns a configurable response.
struct CaptureTransport {
  last: Mutex<Option<PreparedHttpRequest>>,
  calls: AtomicUsize,
  response: Mutex<Result<BoundedHttpResponse, String>>,
}

impl CaptureTransport {
  fn call_count(&self) -> usize {
    self.calls.load(Ordering::SeqCst)
  }

  fn reset(&self) {
    self.calls.store(0, Ordering::SeqCst);
    *self.last.lock().unwrap() = None;
  }
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
        Ok(r) => Ok(r.clone()),
        Err(msg) => Err(crate::error::StorageError::Validation(msg.clone())),
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
    self.calls.fetch_add(1, Ordering::SeqCst);
    Box::pin(async { Err(crate::error::StorageError::Validation("stream not supported".into())) })
  }
}

fn text_response(body: &str) -> BoundedHttpResponse {
  BoundedHttpResponse {
    status: 200,
    headers: HashMap::new(),
    body: body.as_bytes().to_vec(),
  }
}

fn build_google_web_package_with(
  version: &str,
  config_schema: &str,
  config_path: &str,
  extra_network: Vec<NetworkEndpointRequest>,
  capabilities: Vec<(&str, &str)>,
) -> (Vec<u8>, String) {
  let translate_path = TRANSLATE_ARTIFACT_PATH;
  let detect_path = DETECT_ARTIFACT_PATH;
  let prefs_path = "schemas/translate-preferences.json";
  let en_path = "locales/en.json";
  let zh_path = "locales/zh-CN.json";

  let schema_bytes = config_schema.as_bytes().to_vec();
  let prefs_bytes = PREFS_SCHEMA.as_bytes().to_vec();
  let en_bytes = LOCALE_EN.as_bytes().to_vec();
  let zh_bytes = LOCALE_ZH.as_bytes().to_vec();

  let files = vec![
    PluginFileEntry {
      path: translate_path.into(),
      role: FileRole::RuntimeArtifact,
      bytes: TRANSLATE_WASM.len() as u64,
      sha256: public_sha256_hex(TRANSLATE_WASM),
    },
    PluginFileEntry {
      path: detect_path.into(),
      role: FileRole::RuntimeArtifact,
      bytes: DETECT_WASM.len() as u64,
      sha256: public_sha256_hex(DETECT_WASM),
    },
    PluginFileEntry {
      path: config_path.into(),
      role: FileRole::ConfigSchema,
      bytes: schema_bytes.len() as u64,
      sha256: public_sha256_hex(&schema_bytes),
    },
    PluginFileEntry {
      path: prefs_path.into(),
      role: FileRole::PreferenceSchema,
      bytes: prefs_bytes.len() as u64,
      sha256: public_sha256_hex(&prefs_bytes),
    },
    PluginFileEntry {
      path: en_path.into(),
      role: FileRole::Locale,
      bytes: en_bytes.len() as u64,
      sha256: public_sha256_hex(&en_bytes),
    },
    PluginFileEntry {
      path: zh_path.into(),
      role: FileRole::Locale,
      bytes: zh_bytes.len() as u64,
      sha256: public_sha256_hex(&zh_bytes),
    },
  ];
  let zip_files: Vec<(&str, &[u8])> = vec![
    (translate_path, TRANSLATE_WASM),
    (detect_path, DETECT_WASM),
    (config_path, &schema_bytes),
    (prefs_path, &prefs_bytes),
    (en_path, &en_bytes),
    (zh_path, &zh_bytes),
  ];
  let manifest = PluginManifestV1 {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: PLUGIN_ID.into(),
    version: version.into(),
    publisher: PublisherDeclaration {
      key_id: crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID.into(),
      key_fingerprint: fixture_vendor_fingerprint(),
    },
    runtime: RuntimeDescriptor {
      kind: RuntimeKind::WasmComponent,
      artifact: Some(translate_path.into()),
    },
    targets: vec![],
    files,
    capabilities: capabilities
      .iter()
      .map(|(id, artifact)| CapabilityDeclaration {
        id: (*id).into(),
        preferences_schema: Some(prefs_path.into()),
        artifact: Some((*artifact).into()),
      })
      .collect(),
    configuration_schema: Some(config_path.into()),
    config_schema_version: Some(1),
    credential_slots: vec![],
    permissions: PermissionRequests {
      network: {
        let mut n = vec![NetworkEndpointRequest {
          id: "gtx".into(),
          origins: vec![GTX_ORIGIN.into()],
          methods: vec![HttpMethod::Get],
          instance_origin_config_field: None,
        }];
        n.extend(extra_network);
        n
      },
      auth_policies: vec!["host.none.v1".into()],
    },
    ui: Default::default(),
  };
  let sk = fixture_vendor_signing_key();
  let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
  let signature = sk.sign(&manifest_bytes).to_bytes().to_vec();
  let mut cursor = std::io::Cursor::new(Vec::new());
  {
    let mut zip = zip::ZipWriter::new(&mut cursor);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file(MANIFEST_FILE_PATH, options).unwrap();
    zip.write_all(&manifest_bytes).unwrap();
    // Self-authenticating publisher public key (32 raw bytes).
    let pub_key_bytes = decode_lowercase_hex::<32>(&fixture_vendor_public_key_hex(), "vendor key").expect("valid hex");
    zip.start_file("publisher.pub", options).unwrap();
    zip.write_all(&pub_key_bytes).unwrap();
    let mut ordered = zip_files.clone();
    ordered.sort_by(|a, b| a.0.cmp(b.0));
    for (path, bytes) in ordered {
      zip.start_file(path, options).unwrap();
      zip.write_all(bytes).unwrap();
    }
    zip.start_file(SIGNATURE_FILE_PATH, options).unwrap();
    zip.write_all(&signature).unwrap();
    zip.finish().unwrap();
  }
  let pkg = cursor.into_inner();
  let digest = hash_archive_bytes(&pkg);
  (pkg, digest)
}

fn build_google_web_package() -> (Vec<u8>, String) {
  build_google_web_package_with(
    "1.0.0",
    CONFIG_SCHEMA_GTX,
    "schemas/config.json",
    vec![],
    vec![
      (TRANSLATE_CAP, TRANSLATE_ARTIFACT_PATH),
      (DETECT_CAP, DETECT_ARTIFACT_PATH),
    ],
  )
}

fn build_google_web_proxy_package() -> (Vec<u8>, String) {
  let proxy_endpoint = NetworkEndpointRequest {
    id: "https-proxy".into(),
    origins: vec![],
    methods: vec![HttpMethod::Post],
    instance_origin_config_field: Some("proxy-url".into()),
  };
  build_google_web_package_with(
    "1.1.0",
    CONFIG_SCHEMA_PROXY,
    "schemas/config-proxy.json",
    vec![proxy_endpoint],
    vec![
      (TRANSLATE_CAP, TRANSLATE_ARTIFACT_PATH),
      (DETECT_CAP, DETECT_ARTIFACT_PATH),
    ],
  )
}

/// Build a Google Web package signed by a non-vendor (user) key so its installed publisher is
/// `UserApproved` rather than `Vendor`. Used to prove the bootstrap default binds the exact
/// **vendor** digest/identity and never a user-approved package sharing the same id/version.
/// Returns (pkg, digest, user_public_key_hex).
fn build_google_web_user_signed_package(version: &str) -> (Vec<u8>, String, String) {
  build_google_web_user_signed_package_with_extra_network(version, vec![])
}

fn build_google_web_user_signed_package_with_extra_network(
  version: &str,
  extra_network: Vec<NetworkEndpointRequest>,
) -> (Vec<u8>, String, String) {
  let user_sk = SigningKey::from_bytes(&[9u8; 32]);
  let user_pub = user_sk.verifying_key();
  let user_pub_bytes = user_pub.to_bytes();
  let user_pub_hex = encode_lowercase_hex(&user_pub_bytes);
  let user_fingerprint = public_sha256_hex(&user_pub_bytes);
  let translate_path = TRANSLATE_ARTIFACT_PATH;
  let detect_path = DETECT_ARTIFACT_PATH;
  let prefs_path = "schemas/translate-preferences.json";
  let en_path = "locales/en.json";
  let zh_path = "locales/zh-CN.json";
  let schema_bytes = CONFIG_SCHEMA_GTX.as_bytes().to_vec();
  let prefs_bytes = PREFS_SCHEMA.as_bytes().to_vec();
  let en_bytes = LOCALE_EN.as_bytes().to_vec();
  let zh_bytes = LOCALE_ZH.as_bytes().to_vec();
  let files = vec![
    PluginFileEntry {
      path: translate_path.into(),
      role: FileRole::RuntimeArtifact,
      bytes: TRANSLATE_WASM.len() as u64,
      sha256: public_sha256_hex(TRANSLATE_WASM),
    },
    PluginFileEntry {
      path: detect_path.into(),
      role: FileRole::RuntimeArtifact,
      bytes: DETECT_WASM.len() as u64,
      sha256: public_sha256_hex(DETECT_WASM),
    },
    PluginFileEntry {
      path: "schemas/config.json".into(),
      role: FileRole::ConfigSchema,
      bytes: schema_bytes.len() as u64,
      sha256: public_sha256_hex(&schema_bytes),
    },
    PluginFileEntry {
      path: prefs_path.into(),
      role: FileRole::PreferenceSchema,
      bytes: prefs_bytes.len() as u64,
      sha256: public_sha256_hex(&prefs_bytes),
    },
    PluginFileEntry {
      path: en_path.into(),
      role: FileRole::Locale,
      bytes: en_bytes.len() as u64,
      sha256: public_sha256_hex(&en_bytes),
    },
    PluginFileEntry {
      path: zh_path.into(),
      role: FileRole::Locale,
      bytes: zh_bytes.len() as u64,
      sha256: public_sha256_hex(&zh_bytes),
    },
  ];
  let zip_files: Vec<(&str, &[u8])> = vec![
    (translate_path, TRANSLATE_WASM),
    (detect_path, DETECT_WASM),
    ("schemas/config.json", &schema_bytes),
    (prefs_path, &prefs_bytes),
    (en_path, &en_bytes),
    (zh_path, &zh_bytes),
  ];
  let manifest = PluginManifestV1 {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: PLUGIN_ID.into(),
    version: version.into(),
    publisher: PublisherDeclaration {
      key_id: "com.test.user.keys.1".into(),
      key_fingerprint: user_fingerprint,
    },
    runtime: RuntimeDescriptor {
      kind: RuntimeKind::WasmComponent,
      artifact: Some(translate_path.into()),
    },
    targets: vec![],
    files,
    capabilities: vec![
      CapabilityDeclaration {
        id: TRANSLATE_CAP.into(),
        preferences_schema: Some(prefs_path.into()),
        artifact: Some(translate_path.into()),
      },
      CapabilityDeclaration {
        id: DETECT_CAP.into(),
        preferences_schema: Some(prefs_path.into()),
        artifact: Some(detect_path.into()),
      },
    ],
    configuration_schema: Some("schemas/config.json".into()),
    config_schema_version: Some(1),
    credential_slots: vec![],
    permissions: PermissionRequests {
      network: {
        let mut network = vec![NetworkEndpointRequest {
          id: "gtx".into(),
          origins: vec![GTX_ORIGIN.into()],
          methods: vec![HttpMethod::Get],
          instance_origin_config_field: None,
        }];
        network.extend(extra_network);
        network
      },
      auth_policies: vec!["host.none.v1".into()],
    },
    ui: Default::default(),
  };
  let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
  let signature = user_sk.sign(&manifest_bytes).to_bytes().to_vec();
  let mut cursor = std::io::Cursor::new(Vec::new());
  {
    let mut zip = zip::ZipWriter::new(&mut cursor);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file(MANIFEST_FILE_PATH, options).unwrap();
    zip.write_all(&manifest_bytes).unwrap();
    zip.start_file("publisher.pub", options).unwrap();
    zip.write_all(&user_pub_bytes).unwrap();
    let mut ordered = zip_files.clone();
    ordered.sort_by(|a, b| a.0.cmp(b.0));
    for (path, bytes) in ordered {
      zip.start_file(path, options).unwrap();
      zip.write_all(bytes).unwrap();
    }
    zip.start_file(SIGNATURE_FILE_PATH, options).unwrap();
    zip.write_all(&signature).unwrap();
    zip.finish().unwrap();
  }
  let pkg = cursor.into_inner();
  let digest = hash_archive_bytes(&pkg);
  (pkg, digest, user_pub_hex)
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
    response: Mutex::new(Ok(text_response(r#"[[["Hi","你好",null,null,1]],null,"zh"]"#))),
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

/// Transport that blocks forever once a request starts. Used to verify cancellation AFTER the
/// call is in flight and that the host drops the in-flight transport future on cancel/deadline
/// (not pre-cancellation or string-matched errors). `started` fires when a request begins;
/// `dropped` is set when the pending request future is dropped by the host's cancel/deadline
/// select. A real host deadline (not a string error) drives the timeout case.
struct BlockingTransport {
  started: Arc<Notify>,
  dropped: Arc<AtomicBool>,
}

impl BlockingTransport {
  fn new() -> Self {
    Self {
      started: Arc::new(Notify::new()),
      dropped: Arc::new(AtomicBool::new(false)),
    }
  }
}

/// Guard stored on the blocking request future's stack; sets `dropped` when the host drops the
/// in-flight transport future (cancel or deadline). Proves the transport actually stopped.
struct DropFlag(Arc<AtomicBool>);
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
    _on_event: Box<
      dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
    >,
  ) -> Pin<Box<dyn Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
    Box::pin(async { Err(crate::error::StorageError::Validation("stream not supported".into())) })
  }
}

fn setup_blocking() -> (
  tempfile::TempDir,
  Database,
  PluginPackageService,
  RuntimeLifecycleService,
  Arc<ServiceCapabilityService>,
  Arc<BlockingTransport>,
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
  let blocking = Arc::new(BlockingTransport::new());
  let handlers = Arc::new(ServiceCapabilityRegistry::new());
  let router = RuntimeRouter::new(
    db.clone(),
    registry.clone(),
    handlers.clone(),
    packages.clone(),
    wasm.clone(),
  );
  let broker_transport: Arc<dyn RawHttpTransport> = blocking.clone();
  let broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync> =
    Arc::new(move || Box::new(NetworkBrokerHandle::new(broker_transport.clone())));
  let caps = Arc::new(
    ServiceCapabilityService::new(db.clone(), registry, handlers)
      .with_router(router, wasm)
      .with_broker_factory(broker_factory),
  );
  (dir, db, packages, lifecycle, caps, blocking)
}

const EXPECTED_CONTROL_WASM_REQUESTS: usize = 1;
const NO_TRANSPORT_REQUESTS: usize = 0;
const TAMPERED_GRANT_PLUGIN_ID: &str = "langnext.google-translate-web.tampered";
const TAMPERED_GRANT_PLUGIN_VERSION: &str = "9.9.9";
const TAMPERED_PERMISSION_REQUEST_DIGEST: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

#[derive(Clone, Copy)]
enum GrantHeaderField {
  PluginId,
  PluginVersion,
  PermissionRequestDigest,
}

impl GrantHeaderField {
  fn column(self) -> &'static str {
    match self {
      Self::PluginId => "plugin_id",
      Self::PluginVersion => "plugin_version",
      Self::PermissionRequestDigest => "permission_request_digest",
    }
  }

  fn label(self) -> &'static str {
    match self {
      Self::PluginId => "plugin_id",
      Self::PluginVersion => "plugin_version",
      Self::PermissionRequestDigest => "permission_request_digest",
    }
  }
}

fn rehash_grant_bundle_authority(bundle: &crate::domain::runtime_lifecycle::ExecutionGrantSetBundle) -> String {
  assert!(bundle.pages.is_empty(), "test fixture must not have page grants");
  let capabilities = bundle
    .capabilities
    .iter()
    .map(|entry| CapabilityId::parse(&entry.capability_id).expect("valid test grant capability"))
    .collect::<Vec<_>>();
  let network = bundle
    .network
    .iter()
    .map(|entry| {
      NetworkGrantEntry::with_mode_and_origin_kind(
        CapabilityId::parse(&entry.capability_id).expect("valid test grant capability"),
        EndpointId::parse(&entry.endpoint_id).expect("valid test grant endpoint"),
        HttpsOrigin::parse(&entry.origin).expect("valid test grant origin"),
        NetworkOriginKind::parse(&entry.origin_kind).expect("valid test grant origin kind"),
        crate::services::runtime_router::parse_http_method(&entry.method).expect("valid test grant method"),
        AuthPolicyId::parse(&entry.auth_policy).expect("valid test grant auth policy"),
        NetworkResourceMode::parse(&entry.resource_mode).expect("valid test grant resource mode"),
        ResourceLimits::new(
          entry.max_request_bytes,
          entry.max_response_bytes,
          entry.max_stream_bytes,
          entry.timeout_ms,
        )
        .expect("valid test grant resource limits"),
      )
    })
    .collect::<Vec<_>>();
  crate::domain::runtime_plugin::compute_authority_digest(&capabilities, &network, &[])
    .as_str()
    .to_string()
}

/// Mutate a persisted canonical header and write an authority digest recomputed from its unchanged children.
/// This models a database attacker who knows the child hashing format but cannot alter the signed archive.
fn tamper_grant_header_and_rehash(
  db: &Database,
  instance_id: Uuid,
  field: GrantHeaderField,
  tampered_value: &str,
) -> String {
  db.transaction(|uow| {
    let instance = integration_instances::get(uow.conn(), instance_id)?;
    let mut bundle = crate::repositories::plugin_permission_grants::get_bundle_for_subject_package_revision(
      uow.conn(),
      crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
      instance_id,
      instance.package_digest.as_deref().expect("activated package digest"),
      instance.execution_grant_set_revision.expect("activated grant revision"),
    )?;
    let original_authority_digest = bundle.header.authority_digest.clone();
    match field {
      GrantHeaderField::PluginId => bundle.header.plugin_id = tampered_value.into(),
      GrantHeaderField::PluginVersion => bundle.header.plugin_version = tampered_value.into(),
      GrantHeaderField::PermissionRequestDigest => bundle.header.permission_request_digest = tampered_value.into(),
    }
    let rehashed_authority_digest = rehash_grant_bundle_authority(&bundle);
    assert_eq!(
      rehashed_authority_digest, original_authority_digest,
      "authority digest authenticates children, not canonical header fields"
    );
    let update = format!(
      "UPDATE execution_grant_sets SET {} = ?1, authority_digest = ?2 WHERE id = ?3",
      field.column()
    );
    uow.conn().execute(
      &update,
      rusqlite::params![tampered_value, &rehashed_authority_digest, bundle.header.id.to_string()],
    )?;
    Ok::<_, StorageError>(rehashed_authority_digest)
  })
  .unwrap()
}

fn install_package(packages: &PluginPackageService, dir: &std::path::Path, bytes: &[u8]) -> String {
  let src = dir.join(format!("{}.lnplugin", new_id()));
  std::fs::write(&src, bytes).unwrap();
  let preview = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      set_as_default: true,
    })
    .unwrap()
    .version
    .package_digest
}

fn seed_instance(db: &Database, config_json: &str) -> Uuid {
  let id = new_id();
  let now = now_rfc3339();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id,
        plugin_id: PLUGIN_ID.into(),
        plugin_version: "1.0.0".into(),
        display_name: "Google Web".into(),
        enabled: true,
        config_json: config_json.into(),
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
        updated_at: now,
      },
    )?;
    Ok(())
  })
  .unwrap();
  id
}

fn seed_translate_profile(db: &Database, integration_instance_id: Uuid) -> Uuid {
  let profile_id = new_id();
  let now = now_rfc3339();
  db.transaction(|uow| {
    translation_profiles::insert_profile(
      uow.conn(),
      &TranslationProfile {
        id: profile_id,
        name: TEST_PROFILE_NAME.into(),
        enabled: true,
        source_lang: Some(TEST_PROFILE_SOURCE_LANGUAGE.into()),
        target_lang: Some(TEST_PROFILE_TARGET_LANGUAGE.into()),
        primary_lang: Some(TEST_PROFILE_SOURCE_LANGUAGE.into()),
        preferred_target_lang: Some(TEST_PROFILE_TARGET_LANGUAGE.into()),
        engine: TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
          integration_instance_id,
          translate_capability_id: TRANSLATE_CAP.into(),
          detect_capability_id: None,
          capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
          capability_preferences: serde_json::json!({}),
        }),
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    Ok(())
  })
  .unwrap();
  profile_id
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

fn block_on<T>(fut: impl std::future::Future<Output = T>) -> T {
  tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .unwrap()
    .block_on(fut)
}

/// Test-level watchdog bounding pending-transport cancel/timeout tests. If the host cancel or
/// deadline select regresses and never surfaces, the test fails fast with a clear message instead
/// of hanging the suite. Well above the 500ms host deadline and the cancel-after-start latency.
const PENDING_TRANSPORT_TEST_WATCHDOG: Duration = Duration::from_secs(10);

fn ctx(id: Uuid, rid: &str, cap: &str) -> ExecutionContext {
  ExecutionContext {
    request_id: rid.into(),
    cancel: CancelToken::new(),
    deadline: None,
    integration_instance_id: id,
    plugin_id: PLUGIN_ID.into(),
    capability_id: cap.into(),
  }
}

#[test]
fn google_translate_web_runtime_gtx_translate_and_detect() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  activate(&lifecycle, id, &digest);

  // Translate via Wasm: capture transport returns the GTX fixture.
  *transport.response.lock().unwrap() = Ok(text_response(
    r#"[[["Hello ","你好",null,null,10],["world 🌍","世界 🌍",null,null,10]],null,"zh"]"#,
  ));
  let translate = caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()).unwrap();
  let resp = block_on(translate.translate(
    id,
    TranslateTextRequest {
      text: "你好 世界".into(),
      source_language_id: "zh".into(),
      target_language_id: "en".into(),
    },
    ctx(id, "req-tr", TRANSLATE_CAP),
  ))
  .expect("translate");
  assert_eq!(resp.translated_text, "Hello world 🌍");
  assert_eq!(resp.detected_source_language_id.as_deref(), Some("zh"));
  let prepared = transport.last.lock().unwrap().take().unwrap();
  assert!(prepared.url.as_str().starts_with(GTX_ORIGIN));
  assert_eq!(prepared.destination_policy, DestinationPolicy::TrustedFixed);
  assert!(prepared.url.as_str().contains("translate_a/single"));
  assert!(prepared.url.as_str().contains("client=gtx"));
  assert!(prepared.url.as_str().contains("sl=zh-CN"));
  assert!(prepared.url.as_str().contains("tl=en"));
  assert!(prepared.url.as_str().contains("q="));
  assert!(!prepared.headers.keys().any(|k| k.eq_ignore_ascii_case("Authorization")));
  assert!(prepared.body.is_none());

  // Detect via Wasm: capture transport returns the GTX detect fixture.
  *transport.response.lock().unwrap() = Ok(text_response(r#"[[["x","y",null,null,1]],null,"en"]"#));
  let detect = caps.resolve_detect(id, DETECT_CAP, b"{}".to_vec()).unwrap();
  let det = block_on(detect.detect(
    id,
    DetectLanguageRequest { text: "hello".into() },
    ctx(id, "req-dt", DETECT_CAP),
  ))
  .expect("detect");
  assert_eq!(det.language_id, "en");
}

#[test]
fn google_translate_web_runtime_gtx_cancellation() {
  let (dir, db, packages, lifecycle, caps, blocking) = setup_blocking();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  activate(&lifecycle, id, &digest);

  // Cancel AFTER the transport is in flight (not pre-cancelled). A spawned task waits for the
  // blocking transport's start signal, then cancels; the host's broker-fetch select must drop
  // the in-flight transport future (transport stop) and surface Cancelled.
  let cancel = CancelToken::new();
  let cancel_for_task = cancel.clone();
  let started = blocking.started.clone();
  let dropped = blocking.dropped.clone();
  let translate = caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()).unwrap();
  let runtime = tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .unwrap();
  let outcome = runtime.block_on(async move {
    tokio::spawn(async move {
      started.notified().await;
      cancel_for_task.cancel();
    });
    // Watchdog bounds this pending-transport test so a regression in the host cancel select
    // fails fast with a clear message instead of hanging the suite forever.
    tokio::time::timeout(
      PENDING_TRANSPORT_TEST_WATCHDOG,
      translate.translate(
        id,
        TranslateTextRequest {
          text: "hi".into(),
          source_language_id: "en".into(),
          target_language_id: "zh".into(),
        },
        ExecutionContext {
          request_id: "req-cancel".into(),
          cancel,
          deadline: None,
          integration_instance_id: id,
          plugin_id: PLUGIN_ID.into(),
          capability_id: TRANSLATE_CAP.into(),
        },
      ),
    )
    .await
  });
  match outcome {
    Ok(Err(err)) => assert_eq!(err.code, CapabilityErrorCode::Cancelled),
    Ok(Ok(_response)) => panic!("expected Cancelled, got a successful response"),
    Err(_elapsed) => panic!(
      "cancellation test watchdog expired after {PENDING_TRANSPORT_TEST_WATCHDOG:?}: host did not surface Cancelled (regression in cancel select / transport drop)"
    ),
  }
  assert!(
    dropped.load(Ordering::SeqCst),
    "in-flight transport future must be dropped after cancellation"
  );
}

#[test]
fn google_translate_web_runtime_gtx_rate_limit_maps_to_rate_limited() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  activate(&lifecycle, id, &digest);
  *transport.response.lock().unwrap() = Ok(BoundedHttpResponse {
    status: 429,
    headers: HashMap::new(),
    body: b"{}".to_vec(),
  });
  let translate = caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()).unwrap();
  let err = block_on(translate.translate(
    id,
    TranslateTextRequest {
      text: "hi".into(),
      source_language_id: "en".into(),
      target_language_id: "zh".into(),
    },
    ctx(id, "req-rl", TRANSLATE_CAP),
  ))
  .unwrap_err();
  assert_eq!(err.code, CapabilityErrorCode::RateLimited);
}

#[test]
fn google_translate_web_runtime_gtx_invalid_response_maps_to_invalid_response() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  activate(&lifecycle, id, &digest);
  *transport.response.lock().unwrap() = Ok(text_response(r#"{"not":"array"}"#));
  let translate = caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()).unwrap();
  let err = block_on(translate.translate(
    id,
    TranslateTextRequest {
      text: "hi".into(),
      source_language_id: "en".into(),
      target_language_id: "zh".into(),
    },
    ctx(id, "req-ir", TRANSLATE_CAP),
  ))
  .unwrap_err();
  assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
}

#[test]
fn google_translate_web_runtime_single_executor_no_fallback() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  activate(&lifecycle, id, &digest);
  // A transport failure surfaces as a network error; the router never falls back to Bundled Rust.
  *transport.response.lock().unwrap() = Err("network unreachable".into());
  let translate = caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()).unwrap();
  let err = block_on(translate.translate(
    id,
    TranslateTextRequest {
      text: "hi".into(),
      source_language_id: "en".into(),
      target_language_id: "zh".into(),
    },
    ctx(id, "req-net", TRANSLATE_CAP),
  ))
  .unwrap_err();
  assert_eq!(err.code, CapabilityErrorCode::Network);
}

#[test]
fn google_translate_web_runtime_timeout_maps_to_timeout() {
  let (dir, db, packages, lifecycle, caps, blocking) = setup_blocking();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  activate(&lifecycle, id, &digest);

  // A real host deadline (not a string-matched transport error) drives the timeout. The blocking
  // transport stays in flight; the host broker-fetch select fires the deadline and drops the
  // in-flight transport future (transport stop).
  let dropped = blocking.dropped.clone();
  let translate = caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()).unwrap();
  // Watchdog bounds this pending-transport test so a regression in the host deadline select
  // fails fast with a clear message instead of hanging the suite forever. The timeout is
  // constructed inside the async block so its timer is created within the block_on runtime.
  let err = match block_on(async {
    tokio::time::timeout(
      PENDING_TRANSPORT_TEST_WATCHDOG,
      translate.translate(
        id,
        TranslateTextRequest {
          text: "hi".into(),
          source_language_id: "en".into(),
          target_language_id: "zh".into(),
        },
        ExecutionContext {
          request_id: "req-deadline".into(),
          cancel: CancelToken::new(),
          deadline: Some(Duration::from_millis(500)),
          integration_instance_id: id,
          plugin_id: PLUGIN_ID.into(),
          capability_id: TRANSLATE_CAP.into(),
        },
      ),
    )
    .await
  }) {
    Ok(Err(err)) => err,
    Ok(Ok(_)) => panic!("expected Timeout, got a successful response"),
    Err(_elapsed) => panic!(
      "timeout test watchdog expired after {PENDING_TRANSPORT_TEST_WATCHDOG:?}: host did not surface Timeout (regression in deadline select / transport drop)"
    ),
  };
  assert_eq!(err.code, CapabilityErrorCode::Timeout);
  assert!(
    dropped.load(Ordering::SeqCst),
    "in-flight transport future must be dropped after host deadline"
  );
}

#[test]
fn vendor_package_bootstrap_is_idempotent_and_sets_default() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  let (pkg, digest) = build_google_web_package();

  // First import: installs and sets default.
  let installed = packages.bootstrap_bundled_package(&pkg, true).unwrap();
  assert_eq!(installed.package_digest(), digest);
  assert_eq!(installed.plugin_id(), PLUGIN_ID);
  assert_eq!(installed.version(), "1.0.0");
  let default = db
    .read(|conn| crate::repositories::installed_plugin_versions::get_default(conn, PLUGIN_ID))
    .unwrap()
    .expect("default should be set");
  assert_eq!(default.package_digest, digest);

  // Second import: idempotent (no error, same digest, still one version).
  let again = packages.bootstrap_bundled_package(&pkg, true).unwrap();
  assert_eq!(again.package_digest(), digest);
  let count = db
    .read(|conn| crate::repositories::installed_plugin_versions::list_by_plugin(conn, PLUGIN_ID).map(|v| v.len()))
    .unwrap();
  assert_eq!(count, 1, "idempotent bootstrap must not duplicate the version");
}

#[test]
fn vendor_bootstrap_imports_proxy_version_without_changing_default() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  let (gtx_pkg, gtx_digest) = build_google_web_package();
  let (proxy_pkg, proxy_digest) = build_google_web_proxy_package();

  // Import GTX 1.0.0 as default, then proxy 1.1.0 without setting default.
  packages.bootstrap_bundled_package(&gtx_pkg, true).unwrap();
  packages.bootstrap_bundled_package(&proxy_pkg, false).unwrap();

  // Both versions are installed; GTX 1.0.0 remains the default (proxy is an available upgrade).
  let versions = db
    .read(|conn| crate::repositories::installed_plugin_versions::list_by_plugin(conn, PLUGIN_ID))
    .unwrap();
  assert_eq!(versions.len(), 2, "both GTX and proxy versions must be installed");
  let default = db
    .read(|conn| crate::repositories::installed_plugin_versions::get_default(conn, PLUGIN_ID))
    .unwrap()
    .expect("default should be set");
  assert_eq!(default.package_digest, gtx_digest);
  assert_ne!(default.package_digest, proxy_digest);
}

#[test]
fn set_vendor_bootstrap_default_binds_exact_vendor_1_0_0_digest() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  let (gtx_pkg, gtx_digest) = build_google_web_package();
  let (proxy_pkg, proxy_digest) = build_google_web_proxy_package();
  // Import both without setting a default (mirrors the state.rs bootstrap import step). The import
  // returns the fully verified vendor identity (key id/fingerprint/public key from Ed25519
  // verification of the exact retained archive).
  let gtx_import = packages.bootstrap_bundled_package(&gtx_pkg, false).unwrap();
  packages.bootstrap_bundled_package(&proxy_pkg, false).unwrap();
  assert_eq!(gtx_import.package_digest(), gtx_digest);
  // Bind the default to the exact vendor 1.0.0 verified import identity.
  let default = packages
    .set_vendor_bootstrap_default(
      PLUGIN_ID,
      "1.0.0",
      Some(&gtx_import),
      VendorDefaultBindingMode::ReplaceExisting,
    )
    .unwrap();
  assert_eq!(default.package_digest, gtx_digest);
  assert_ne!(default.package_digest, proxy_digest);
}

#[test]
fn set_vendor_bootstrap_default_clears_wrong_default_when_vendor_1_0_0_missing() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  let (proxy_pkg, proxy_digest) = build_google_web_proxy_package();
  // Only 1.1.0 imports successfully (simulating a failed/missing 1.0.0 archive); promote it as a
  // stale wrong default to prove the bootstrap clears it.
  packages.bootstrap_bundled_package(&proxy_pkg, true).unwrap();
  let stale = db
    .read(|conn| crate::repositories::installed_plugin_versions::get_default(conn, PLUGIN_ID))
    .unwrap()
    .expect("proxy 1.1.0 default seeded");
  assert_eq!(stale.package_digest, proxy_digest);
  // Vendor 1.0.0 absent: bind fails closed and atomically clears the existing 1.1.0 default.
  let err = packages
    .set_vendor_bootstrap_default(PLUGIN_ID, "1.0.0", None, VendorDefaultBindingMode::ReplaceExisting)
    .unwrap_err();
  assert!(matches!(err, StorageError::NotFound(_)), "{err:?}");
  let default = db
    .read(|conn| crate::repositories::installed_plugin_versions::get_default(conn, PLUGIN_ID))
    .unwrap();
  assert!(
    default.is_none(),
    "stale 1.1.0 default must be cleared when vendor 1.0.0 is missing"
  );
}

#[test]
fn set_vendor_bootstrap_default_rejects_user_approved_same_id_version() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  // Install a user-approved Google Web 1.0.0 (non-vendor key) and promote it as default.
  let (user_pkg, user_digest, user_pub_hex) = build_google_web_user_signed_package("1.0.0");
  let src = dir.path().join("user.lnplugin");
  std::fs::write(&src, &user_pkg).unwrap();
  let preview = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview.preview_id,
      approve_publisher: true,
      publisher_public_key_hex: Some(user_pub_hex.clone()),
      acknowledge_permissions: true,
      set_as_default: true,
    })
    .unwrap();
  let seeded = db
    .read(|conn| crate::repositories::installed_plugin_versions::get_default(conn, PLUGIN_ID))
    .unwrap()
    .expect("user-approved 1.0.0 default seeded");
  assert_eq!(seeded.package_digest, user_digest);
  // VerifiedVendorImport fields are private and only constructible via external vendor-root
  // re-verification. A user-signed package cannot produce a VerifiedVendorImport: bootstrap
  // re-verify fails closed because the publisher key is not a configured vendor root.
  let err = packages.bootstrap_bundled_package(&user_pkg, false).unwrap_err();
  assert!(
    matches!(err, StorageError::NotFound(_)) || matches!(err, StorageError::Capability { .. }),
    "user-signed package must not produce a vendor import: {err:?}"
  );
  // Vendor 1.0.0 absent (None) must clear the user-approved default rather than promote it.
  let err = packages
    .set_vendor_bootstrap_default(PLUGIN_ID, "1.0.0", None, VendorDefaultBindingMode::ReplaceExisting)
    .unwrap_err();
  assert!(matches!(err, StorageError::NotFound(_)), "{err:?}");
  let default = db
    .read(|conn| crate::repositories::installed_plugin_versions::get_default(conn, PLUGIN_ID))
    .unwrap();
  assert!(
    default.is_none(),
    "user-approved same id/version must never remain default when vendor 1.0.0 is unbound"
  );
}

#[test]
fn runtime_router_rejects_rehashed_user_signed_static_origin_tamper() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (package, package_digest, user_public_key_hex) = build_google_web_user_signed_package_with_extra_network(
    USER_SIGNED_PACKAGE_VERSION,
    vec![NetworkEndpointRequest {
      id: THIRD_PARTY_STATIC_ENDPOINT_ID.into(),
      origins: vec![THIRD_PARTY_STATIC_MANIFEST_ORIGIN.into()],
      methods: vec![HttpMethod::Get],
      instance_origin_config_field: None,
    }],
  );
  let source = dir.path().join("user-static-origin.lnplugin");
  std::fs::write(&source, package).unwrap();
  let preview = packages.preview_package(&source).unwrap();
  let approved = packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview.preview_id,
      approve_publisher: true,
      publisher_public_key_hex: Some(user_public_key_hex),
      acknowledge_permissions: true,
      set_as_default: true,
    })
    .unwrap();
  assert_eq!(approved.version.package_digest, package_digest);

  let instance_id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  activate(&lifecycle, instance_id, &package_digest);
  let profile_id = seed_translate_profile(&db, instance_id);
  let control = caps
    .resolve_translate(instance_id, TRANSLATE_CAP, EMPTY_PREFERENCES_JSON.to_vec())
    .expect("verified user-signed static endpoint grant resolves before tampering");
  block_on(control.translate(
    instance_id,
    TranslateTextRequest {
      text: "control".into(),
      source_language_id: TEST_PROFILE_SOURCE_LANGUAGE.into(),
      target_language_id: TEST_PROFILE_TARGET_LANGUAGE.into(),
    },
    ctx(instance_id, "req-static-origin-control", TRANSLATE_CAP),
  ))
  .expect("verified user-signed static endpoint executes before tampering");
  assert_eq!(transport.call_count(), EXPECTED_CONTROL_WASM_REQUESTS);
  transport.reset();
  let control_snapshot = caps
    .load_profile_invocation_snapshot(profile_id, ProfileCapabilityKind::Translate)
    .expect("verified user-signed static endpoint snapshot loads before tampering");
  caps
    .resolve_translate_from_snapshot(&control_snapshot)
    .expect("verified user-signed static endpoint snapshot resolves before tampering");

  let rehashed_authority_digest = db
    .transaction(|uow| {
      let instance = integration_instances::get(uow.conn(), instance_id)?;
      let mut bundle = crate::repositories::plugin_permission_grants::get_bundle_for_subject_package_revision(
        uow.conn(),
        crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
        instance_id,
        instance.package_digest.as_deref().expect("activated package digest"),
        instance.execution_grant_set_revision.expect("activated grant revision"),
      )?;
      let entry = bundle
        .network
        .iter_mut()
        .find(|entry| entry.endpoint_id == THIRD_PARTY_STATIC_ENDPOINT_ID)
        .expect("third-party static grant entry");
      assert_eq!(entry.origin, THIRD_PARTY_STATIC_MANIFEST_ORIGIN);
      assert_eq!(entry.origin_kind, NetworkOriginKind::InstanceConfigured.as_str());
      let entry_id = entry.id;
      entry.origin = TAMPERED_PUBLIC_HTTPS_ORIGIN.into();
      let rehashed = rehash_grant_bundle_authority(&bundle);
      assert_ne!(rehashed, bundle.header.authority_digest);
      uow.conn().execute(
        "UPDATE execution_grant_network_entries SET origin = ?1 WHERE id = ?2",
        rusqlite::params![TAMPERED_PUBLIC_HTTPS_ORIGIN, entry_id.to_string()],
      )?;
      uow.conn().execute(
        "UPDATE execution_grant_sets SET authority_digest = ?1 WHERE id = ?2",
        rusqlite::params![&rehashed, bundle.header.id.to_string()],
      )?;
      Ok::<_, StorageError>(rehashed)
    })
    .unwrap();
  let persisted_authority_digest = db
    .read(|conn| {
      let instance = integration_instances::get(conn, instance_id)?;
      let grant = crate::repositories::plugin_permission_grants::get_bundle_for_subject_package_revision(
        conn,
        crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
        instance_id,
        instance.package_digest.as_deref().expect("activated package digest"),
        instance.execution_grant_set_revision.expect("activated grant revision"),
      )?;
      Ok::<_, StorageError>(grant.header.authority_digest)
    })
    .unwrap();
  assert_eq!(persisted_authority_digest, rehashed_authority_digest);

  let error = match caps.resolve_translate(instance_id, TRANSLATE_CAP, EMPTY_PREFERENCES_JSON.to_vec()) {
    Ok(_) => panic!("rehashed static origin tamper must fail before runtime resolution"),
    Err(error) => error,
  };
  assert_eq!(error.code, CapabilityErrorCode::PermissionDenied);
  let tampered_snapshot = caps
    .load_profile_invocation_snapshot(profile_id, ProfileCapabilityKind::Translate)
    .expect("tampered profile snapshot loads for runtime validation");
  let snapshot_error = match caps.resolve_translate_from_snapshot(&tampered_snapshot) {
    Ok(_) => panic!("rehashed static origin tamper must fail in snapshot runtime resolution"),
    Err(error) => error,
  };
  assert_eq!(snapshot_error.code, CapabilityErrorCode::PermissionDenied);
  assert_eq!(
    transport.call_count(),
    NO_TRANSPORT_REQUESTS,
    "direct and snapshot grant rejection must occur before the Wasm transport handle is invoked"
  );
}

#[test]
fn runtime_router_rejects_rehashed_grant_headers_in_direct_and_snapshot_paths() {
  let header_tampers = [
    (GrantHeaderField::PluginId, TAMPERED_GRANT_PLUGIN_ID),
    (GrantHeaderField::PluginVersion, TAMPERED_GRANT_PLUGIN_VERSION),
    (
      GrantHeaderField::PermissionRequestDigest,
      TAMPERED_PERMISSION_REQUEST_DIGEST,
    ),
  ];

  for (field, tampered_value) in header_tampers {
    let (dir, db, packages, lifecycle, caps, transport) = setup();
    let (package, package_digest) = build_google_web_package();
    install_package(&packages, dir.path(), &package);
    let instance_id = seed_instance(&db, r#"{"channel":"gtx"}"#);
    activate(&lifecycle, instance_id, &package_digest);
    let profile_id = seed_translate_profile(&db, instance_id);

    // First execute real Wasm through the capture transport, proving the negative assertion below
    // is not a vacuous resolver-only test.
    let control = caps
      .resolve_translate(instance_id, TRANSLATE_CAP, EMPTY_PREFERENCES_JSON.to_vec())
      .expect("verified grant resolves before header tampering");
    block_on(control.translate(
      instance_id,
      TranslateTextRequest {
        text: "control".into(),
        source_language_id: TEST_PROFILE_SOURCE_LANGUAGE.into(),
        target_language_id: TEST_PROFILE_TARGET_LANGUAGE.into(),
      },
      ctx(instance_id, "req-header-control", TRANSLATE_CAP),
    ))
    .expect("verified grant executes before header tampering");
    assert_eq!(transport.call_count(), EXPECTED_CONTROL_WASM_REQUESTS);
    transport.reset();

    let rehashed_authority_digest = tamper_grant_header_and_rehash(&db, instance_id, field, tampered_value);
    let persisted_authority_digest = db
      .read(|conn| {
        let instance = integration_instances::get(conn, instance_id)?;
        let grant = crate::repositories::plugin_permission_grants::get_bundle_for_subject_package_revision(
          conn,
          crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
          instance_id,
          instance.package_digest.as_deref().expect("activated package digest"),
          instance.execution_grant_set_revision.expect("activated grant revision"),
        )?;
        Ok::<_, StorageError>(grant.header.authority_digest)
      })
      .unwrap();
    assert_eq!(persisted_authority_digest, rehashed_authority_digest);

    let direct_error = match caps.resolve_translate(instance_id, TRANSLATE_CAP, EMPTY_PREFERENCES_JSON.to_vec()) {
      Ok(_) => panic!("direct runtime resolution must reject rehashed canonical header tampering"),
      Err(error) => error,
    };
    assert_eq!(
      direct_error.code,
      CapabilityErrorCode::PermissionDenied,
      "direct resolver must reject tampered {} before constructing a principal",
      field.label()
    );

    let tampered_snapshot = caps
      .load_profile_invocation_snapshot(profile_id, ProfileCapabilityKind::Translate)
      .expect("tampered profile snapshot loads for runtime validation");
    let snapshot_error = match caps.resolve_translate_from_snapshot(&tampered_snapshot) {
      Ok(_) => panic!("snapshot runtime resolution must reject rehashed canonical header tampering"),
      Err(error) => error,
    };
    assert_eq!(
      snapshot_error.code,
      CapabilityErrorCode::PermissionDenied,
      "snapshot resolver must reject tampered {} before constructing a principal",
      field.label()
    );
    assert_eq!(
      transport.call_count(),
      NO_TRANSPORT_REQUESTS,
      "{} tampering must be rejected before the Wasm transport handle is invoked",
      field.label()
    );
  }
}

#[test]
fn set_vendor_bootstrap_default_rejects_publisher_metadata_mismatch() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  let (gtx_pkg, gtx_digest) = build_google_web_package();
  let gtx_import = packages.bootstrap_bundled_package(&gtx_pkg, false).unwrap();
  // Bind succeeds while the publisher row matches the verified import identity.
  let bound = packages
    .set_vendor_bootstrap_default(
      PLUGIN_ID,
      "1.0.0",
      Some(&gtx_import),
      VendorDefaultBindingMode::ReplaceExisting,
    )
    .unwrap();
  assert_eq!(bound.package_digest, gtx_digest);
  // Tamper the publisher row's public key so it no longer matches the verified import identity
  // (key id/fingerprint unchanged). The reverse-bind must fail closed and clear the bound default.
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE plugin_publishers SET public_key_hex = ?1 WHERE key_id = ?2",
      rusqlite::params!["00".repeat(32), gtx_import.publisher_key_id()],
    )?;
    Ok(())
  })
  .unwrap();
  let err = packages
    .set_vendor_bootstrap_default(
      PLUGIN_ID,
      "1.0.0",
      Some(&gtx_import),
      VendorDefaultBindingMode::ReplaceExisting,
    )
    .unwrap_err();
  assert!(matches!(err, StorageError::NotFound(_)), "{err:?}");
  let default = db
    .read(|conn| crate::repositories::installed_plugin_versions::get_default(conn, PLUGIN_ID))
    .unwrap();
  assert!(
    default.is_none(),
    "publisher metadata mismatch must clear the bound default"
  );
}

#[test]
fn pin_default_auto_pins_google_web_1_0_0_gtx_vendor_default() {
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(after.runtime_kind, "wasm-component");
  assert_eq!(after.package_digest.as_deref(), Some(digest.as_str()));
  assert!(
    after.execution_grant_set_revision.is_some(),
    "vendor default must be auto-acknowledged"
  );
}

#[test]
fn pin_default_skips_google_web_1_1_0_proxy_leaves_bundled_rust() {
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  // 1.1.0 proxy is the catalog default, but it is not the host-allowed GTX vendor default policy
  // (extra https-proxy endpoint + instance-configured origin). Auto-pin must fail closed.
  let (pkg, _digest) = build_google_web_proxy_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(after.runtime_kind, "bundled-rust");
  assert!(after.package_digest.is_none(), "proxy 1.1.0 must not be auto-pinned");
  assert!(after.execution_grant_set_revision.is_none());
}

#[test]
fn pin_default_skips_google_web_1_0_0_with_extra_endpoint_leaves_bundled_rust() {
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  // Google Web 1.0.0 but with an extra static third-party endpoint: permission set is not exactly
  // GTX GET https://translate.google.com + host.none.v1, so auto-pin must fail closed.
  let extra = vec![NetworkEndpointRequest {
    id: "third-party".into(),
    origins: vec!["https://third-party.example".into()],
    methods: vec![HttpMethod::Get],
    instance_origin_config_field: None,
  }];
  let (pkg, _digest) = build_google_web_package_with(
    "1.0.0",
    CONFIG_SCHEMA_GTX,
    "schemas/config.json",
    extra,
    vec![
      (TRANSLATE_CAP, TRANSLATE_ARTIFACT_PATH),
      (DETECT_CAP, DETECT_ARTIFACT_PATH),
    ],
  );
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(after.runtime_kind, "bundled-rust");
  assert!(
    after.package_digest.is_none(),
    "expanded-permission 1.0.0 must not be auto-pinned"
  );
  assert!(after.execution_grant_set_revision.is_none());
}

/// Run one auto-pin metadata-spoof scenario on a freshly seeded catalog. Each scenario gets its
/// own setup + install + default so there is no cross-scenario state leakage. The positive
/// control proves the untampered package auto-pins; after `tamper` the next instance must stay
/// Bundled Rust (the re-verified archive manifest is the source of truth, not the catalog row).
fn run_pin_default_spoof_scenario(label: &str, tamper: impl Fn(&Database, &str)) {
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  // Positive control: the untampered vendor default auto-pins.
  let id_ok = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id_ok).unwrap();
  let after_ok = db.read(|conn| integration_instances::get(conn, id_ok)).unwrap();
  assert_eq!(
    after_ok.runtime_kind, "wasm-component",
    "{label}: untampered default must auto-pin"
  );
  // Tamper the catalog/publisher metadata, then prove the next instance stays Bundled Rust.
  tamper(&db, &digest);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(
    after.runtime_kind, "bundled-rust",
    "{label}: metadata spoof must fail closed"
  );
  assert!(
    after.package_digest.is_none(),
    "{label}: spoofed metadata must not be auto-pinned"
  );
  assert!(
    after.execution_grant_set_revision.is_none(),
    "{label}: spoofed metadata must not be auto-acknowledged"
  );
}

#[test]
fn pin_default_fails_closed_on_metadata_spoof() {
  // Each scenario is independently seeded (fresh setup + install + default) so there is no state
  // leakage between spoofs. The re-verified archive manifest is the source of truth; every
  // catalog/publisher divergence below must fail closed (Bundled Rust).
  run_pin_default_spoof_scenario("version", |db, digest| {
    db.transaction(|uow| {
      uow.conn().execute(
        "UPDATE installed_plugin_versions SET version = ?1 WHERE package_digest = ?2",
        rusqlite::params!["1.1.0", digest],
      )?;
      Ok(())
    })
    .unwrap();
  });
  run_pin_default_spoof_scenario("publisher_key_id", |db, digest| {
    // Insert a fake publisher row so the FK on publisher_key_id allows the spoof, then point the
    // version row at it. The re-verified manifest's publisher key id is the real vendor key, so
    // the cross-bind (and the fake-key signature re-verification) fails closed.
    db.transaction(|uow| {
      let now = crate::domain::time::now_rfc3339();
      uow.conn().execute(
        "INSERT INTO plugin_publishers (key_id, fingerprint, public_key_hex, source, enabled, revoked, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'vendor', 1, 0, ?4, ?4)",
        rusqlite::params!["com.evil.keys.1", "00".repeat(32), "00".repeat(32), now],
      )?;
      uow
        .conn()
        .execute(
          "UPDATE installed_plugin_versions SET publisher_key_id = ?1 WHERE package_digest = ?2",
          rusqlite::params!["com.evil.keys.1", digest],
        )?;
      Ok(())
    })
    .unwrap();
  });
  run_pin_default_spoof_scenario("publisher_revoked", |db, _digest| {
    db.transaction(|uow| {
      uow.conn().execute(
        "UPDATE plugin_publishers SET revoked = 1 WHERE key_id = ?1",
        rusqlite::params![crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID],
      )?;
      Ok(())
    })
    .unwrap();
  });
  run_pin_default_spoof_scenario("publisher_disabled", |db, _digest| {
    db.transaction(|uow| {
      uow.conn().execute(
        "UPDATE plugin_publishers SET enabled = 0 WHERE key_id = ?1",
        rusqlite::params![crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID],
      )?;
      Ok(())
    })
    .unwrap();
  });
  run_pin_default_spoof_scenario("publisher_source", |db, _digest| {
    db.transaction(|uow| {
      uow.conn().execute(
        "UPDATE plugin_publishers SET source = 'user_approved' WHERE key_id = ?1",
        rusqlite::params![crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID],
      )?;
      Ok(())
    })
    .unwrap();
  });
}

#[test]
fn pin_default_fails_closed_on_coordinated_metadata_spoof() {
  // Coordinated spoof: install the vendor-signed PROXY 1.1.0 package, then forge the catalog row
  // (version + manifest_json) to claim it is the GTX 1.0.0 vendor default, copying a real GTX
  // manifest_json so the forged row is internally consistent. The publisher row is the genuine
  // vendor key. The auto-pin must re-verify the actual retained archive: the verified manifest is
  // 1.1.0 + proxy endpoint, which can never be the host-allowed GTX 1.0.0 default. Coordinated
  // catalog/manifest/publisher spoofing cannot auto-grant permissions.
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  // Build the GTX package only to derive a realistic forged manifest_json; do NOT install it (the
  // installed_plugin_versions UNIQUE(plugin_id, version) constraint would otherwise block forging
  // the proxy row's version to 1.0.0).
  let (gtx_pkg, _gtx_digest) = build_google_web_package();
  let gtx_verified = verify_package_bytes(&gtx_pkg, &fixture_vendor_public_key_hex()).unwrap();
  let forged_manifest_json = serde_json::to_string(&gtx_verified.manifest).unwrap();
  let (proxy_pkg, proxy_digest) = build_google_web_proxy_package();
  install_package(&packages, dir.path(), &proxy_pkg);
  // Forge the proxy row to claim GTX 1.0.0 with a real GTX manifest_json.
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE installed_plugin_versions SET version = ?1, manifest_json = ?2 WHERE package_digest = ?3",
      rusqlite::params!["1.0.0", &forged_manifest_json, &proxy_digest],
    )?;
    Ok(())
  })
  .unwrap();
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(
    after.runtime_kind, "bundled-rust",
    "coordinated metadata spoof must fail closed"
  );
  assert!(
    after.package_digest.is_none(),
    "coordinated spoof must not auto-grant a package pin"
  );
  assert!(
    after.execution_grant_set_revision.is_none(),
    "coordinated spoof must not auto-acknowledge permissions"
  );
}

/// Attacker-controlled Ed25519 key signs a GTX-shaped archive whose manifest **declares the
/// vendor key id + vendor fingerprint** (so root resolution succeeds) but the signature is from
/// the attacker key. Returns (pkg, digest, attacker_public_key_hex, attacker_fingerprint).
fn build_attacker_gtx_package_declaring_vendor_key() -> (Vec<u8>, String, String, String) {
  const ATTACKER_SEED: [u8; 32] = [0x42; 32];
  let attacker_sk = SigningKey::from_bytes(&ATTACKER_SEED);
  let attacker_pub = attacker_sk.verifying_key().to_bytes();
  let attacker_pub_hex = encode_lowercase_hex(&attacker_pub);
  let attacker_fp = public_sha256_hex(&attacker_pub);
  let vendor_key_id = crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID;
  let vendor_fp = fixture_vendor_fingerprint();
  let translate_path = TRANSLATE_ARTIFACT_PATH;
  let detect_path = DETECT_ARTIFACT_PATH;
  let prefs_path = "schemas/translate-preferences.json";
  let en_path = "locales/en.json";
  let zh_path = "locales/zh-CN.json";
  let schema_bytes = CONFIG_SCHEMA_GTX.as_bytes().to_vec();
  let prefs_bytes = PREFS_SCHEMA.as_bytes().to_vec();
  let en_bytes = LOCALE_EN.as_bytes().to_vec();
  let zh_bytes = LOCALE_ZH.as_bytes().to_vec();
  let files = vec![
    PluginFileEntry {
      path: translate_path.into(),
      role: FileRole::RuntimeArtifact,
      bytes: TRANSLATE_WASM.len() as u64,
      sha256: public_sha256_hex(TRANSLATE_WASM),
    },
    PluginFileEntry {
      path: detect_path.into(),
      role: FileRole::RuntimeArtifact,
      bytes: DETECT_WASM.len() as u64,
      sha256: public_sha256_hex(DETECT_WASM),
    },
    PluginFileEntry {
      path: "schemas/config.json".into(),
      role: FileRole::ConfigSchema,
      bytes: schema_bytes.len() as u64,
      sha256: public_sha256_hex(&schema_bytes),
    },
    PluginFileEntry {
      path: prefs_path.into(),
      role: FileRole::PreferenceSchema,
      bytes: prefs_bytes.len() as u64,
      sha256: public_sha256_hex(&prefs_bytes),
    },
    PluginFileEntry {
      path: en_path.into(),
      role: FileRole::Locale,
      bytes: en_bytes.len() as u64,
      sha256: public_sha256_hex(&en_bytes),
    },
    PluginFileEntry {
      path: zh_path.into(),
      role: FileRole::Locale,
      bytes: zh_bytes.len() as u64,
      sha256: public_sha256_hex(&zh_bytes),
    },
  ];
  let zip_files: Vec<(&str, &[u8])> = vec![
    (translate_path, TRANSLATE_WASM),
    (detect_path, DETECT_WASM),
    ("schemas/config.json", &schema_bytes),
    (prefs_path, &prefs_bytes),
    (en_path, &en_bytes),
    (zh_path, &zh_bytes),
  ];
  // Manifest declares the **vendor** key id/fingerprint so external root resolution succeeds;
  // signature is attacker-only so vendor-root Ed25519 verify is the sole rejection reason.
  let manifest = PluginManifestV1 {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: PLUGIN_ID.into(),
    version: "1.0.0".into(),
    publisher: PublisherDeclaration {
      key_id: vendor_key_id.into(),
      key_fingerprint: vendor_fp,
    },
    runtime: RuntimeDescriptor {
      kind: RuntimeKind::WasmComponent,
      artifact: Some(translate_path.into()),
    },
    targets: vec![],
    files,
    capabilities: vec![
      CapabilityDeclaration {
        id: TRANSLATE_CAP.into(),
        preferences_schema: Some(prefs_path.into()),
        artifact: Some(translate_path.into()),
      },
      CapabilityDeclaration {
        id: DETECT_CAP.into(),
        preferences_schema: Some(prefs_path.into()),
        artifact: Some(detect_path.into()),
      },
    ],
    configuration_schema: Some("schemas/config.json".into()),
    config_schema_version: Some(1),
    credential_slots: vec![],
    permissions: PermissionRequests {
      network: vec![NetworkEndpointRequest {
        id: "gtx".into(),
        origins: vec![GTX_ORIGIN.into()],
        methods: vec![HttpMethod::Get],
        instance_origin_config_field: None,
      }],
      auth_policies: vec!["host.none.v1".into()],
    },
    ui: Default::default(),
  };
  let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
  let signature = attacker_sk.sign(&manifest_bytes).to_bytes().to_vec();
  let mut cursor = std::io::Cursor::new(Vec::new());
  {
    let mut zip = zip::ZipWriter::new(&mut cursor);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file(MANIFEST_FILE_PATH, options).unwrap();
    zip.write_all(&manifest_bytes).unwrap();
    // No publisher.pub: avoid fingerprint self-auth of attacker bytes against vendor fingerprint.
    let mut ordered = zip_files.clone();
    ordered.sort_by(|a, b| a.0.cmp(b.0));
    for (path, bytes) in ordered {
      zip.start_file(path, options).unwrap();
      zip.write_all(bytes).unwrap();
    }
    zip.start_file(SIGNATURE_FILE_PATH, options).unwrap();
    zip.write_all(&signature).unwrap();
    zip.finish().unwrap();
  }
  let pkg = cursor.into_inner();
  let digest = hash_archive_bytes(&pkg);
  // Sanity: external vendor root must reject (signature mismatch). Manifest declares vendor
  // fingerprint so attacker public key also fails fingerprint reverse-bind — the production path
  // under test uses only the external vendor root, never the attacker key.
  assert!(
    verify_package_bytes(&pkg, &fixture_vendor_public_key_hex()).is_err(),
    "external vendor root must reject attacker-signed manifest"
  );
  (pkg, digest, attacker_pub_hex, attacker_fp)
}

/// Plant attacker archive + content into the immutable store and forge catalog rows so a host that
/// wrongly trusted DB public_key_hex would accept the package. Bypasses approve_package because
/// the archive is not vendor-root-verifiable.
fn plant_attacker_vendor_spoof_package(
  packages: &PluginPackageService,
  db: &Database,
  pkg: &[u8],
  digest: &str,
  attacker_pub_hex: &str,
  attacker_fp: &str,
) {
  let vendor_key_id = crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID;
  let inspected = inspect_package_bytes(pkg).expect("structural inspect of attacker archive");
  assert_eq!(inspected.manifest.publisher.key_id, vendor_key_id);
  assert_eq!(inspected.package_digest, digest);

  let archive_path = packages.package_archive_path(digest);
  if let Some(parent) = archive_path.parent() {
    std::fs::create_dir_all(parent).unwrap();
  }
  std::fs::write(&archive_path, pkg).unwrap();
  set_readonly(&archive_path);
  let content_dir = packages.package_content_path(digest);
  write_extracted_content(&content_dir, &inspected.extracted_files).unwrap();

  // Catalog claims attacker public key/fingerprint while declaring vendor key id + GTX 1.0.0 default.
  let mut forged_manifest = inspected.manifest.clone();
  forged_manifest.publisher.key_id = vendor_key_id.into();
  forged_manifest.publisher.key_fingerprint = attacker_fp.to_string();
  let forged_manifest_json = serde_json::to_string(&forged_manifest).unwrap();
  let permission_digest = compute_permission_request_digest(&forged_manifest);
  let now = now_rfc3339();
  db.transaction(|uow| {
    // Overwrite seeded vendor publisher with attacker material (coordinated DB spoof).
    uow.conn().execute(
      "UPDATE plugin_publishers
       SET fingerprint = ?1, public_key_hex = ?2, source = 'vendor', enabled = 1, revoked = 0, updated_at = ?3
       WHERE key_id = ?4",
      rusqlite::params![attacker_fp, attacker_pub_hex, &now, vendor_key_id],
    )?;
    let publisher = plugin_publishers::get(uow.conn(), vendor_key_id)?;
    assert_eq!(publisher.public_key_hex, attacker_pub_hex);
    assert_eq!(publisher.fingerprint, attacker_fp);
    assert_eq!(publisher.source, PublisherSource::Vendor);

    if installed_plugin_versions::get_optional(uow.conn(), digest)?.is_none() {
      installed_plugin_versions::insert(
        uow.conn(),
        &InstalledPluginVersion {
          package_digest: digest.to_string(),
          plugin_id: PLUGIN_ID.into(),
          version: "1.0.0".into(),
          publisher_key_id: vendor_key_id.into(),
          publisher_fingerprint: attacker_fp.to_string(),
          runtime_kind: runtime_kind_storage(RuntimeKind::WasmComponent).to_string(),
          manifest_json: forged_manifest_json.clone(),
          permission_request_digest: permission_digest,
          content_available: true,
          installed_at: now.clone(),
        },
      )?;
    }
    installed_plugin_versions::set_default(uow.conn(), PLUGIN_ID, digest)?;
    Ok(())
  })
  .unwrap();
}

#[test]
fn pin_default_fails_closed_on_attacker_key_coordinated_db_spoof() {
  // Real attack model: malicious archive declares the vendor key id (and vendor fingerprint so
  // external root resolution succeeds) but is signed by an attacker Ed25519 key. DB
  // publisher/version/default/manifest/public_key/fingerprint rows are coordinated to the
  // attacker values so a host that trusted DB public_key_hex would accept the package.
  // Sole rejection reason must be external vendor-root signature mismatch; no grant / no wasm pin.
  let (_dir, db, packages, lifecycle, _caps, _transport) = setup();
  let (attacker_pkg, attacker_digest, attacker_pub_hex, attacker_fp) =
    build_attacker_gtx_package_declaring_vendor_key();
  plant_attacker_vendor_spoof_package(
    &packages,
    &db,
    &attacker_pkg,
    &attacker_digest,
    &attacker_pub_hex,
    &attacker_fp,
  );

  // Prove the unique rejection path is external-root signature verify (not missing root / not
  // key-id lookup failure): root resolves from archive-declared vendor key id, then Ed25519 fails.
  let verify_err = packages
    .verify_store_with_vendor_root(&attacker_digest)
    .expect_err("attacker-signed archive must fail external vendor-root verify");
  let err_text = format!("{verify_err:?}").to_ascii_lowercase();
  assert!(
    err_text.contains("signature"),
    "unique reject reason must be vendor-root signature mismatch, got: {verify_err:?}"
  );
  assert!(
    !err_text.contains("not a configured vendor root"),
    "must not fail on missing vendor root when archive declares vendor key id: {verify_err:?}"
  );

  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(
    after.runtime_kind, "bundled-rust",
    "attacker-signed GTX declaring vendor key id with coordinated DB spoof must not auto-pin"
  );
  assert!(
    after.package_digest.is_none(),
    "attacker package must not receive a runtime pin"
  );
  assert!(
    after.execution_grant_set_revision.is_none(),
    "attacker package must not receive auto-acknowledged grants"
  );
}

#[test]
fn pin_default_fails_closed_when_content_replaced_between_verify_and_apply() {
  // TOCTOU: after the initial external-root verify succeeds, replace extracted content on disk
  // before the final auto-pin re-verify/apply. Must fail closed (stay Bundled).
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let content_file = packages.package_content_path(&digest).join("locales/en.json");
  assert!(content_file.is_file(), "expected extracted locale for TOCTOU injection");
  let packages_for_hook = packages.clone();
  let digest_for_hook = digest.clone();
  lifecycle.set_auto_pin_between_verify_and_apply_hook(Some(Box::new(move || {
    let path = packages_for_hook
      .package_content_path(&digest_for_hook)
      .join("locales/en.json");
    // Clear readonly if set, then replace content so re-verify fails.
    let _ = std::fs::set_permissions(&path, {
      let mut perms = std::fs::metadata(&path).unwrap().permissions();
      perms.set_readonly(false);
      perms
    });
    std::fs::write(&path, b"{\"tampered\":true}").unwrap();
  })));
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(
    after.runtime_kind, "bundled-rust",
    "content replacement between verify and apply must fail closed"
  );
  assert!(after.package_digest.is_none());
  assert!(after.execution_grant_set_revision.is_none());
}

#[test]
fn pin_default_fails_closed_when_content_replaced_after_final_revalidate() {
  // TOCTOU window the pre-apply hook cannot cover: after final vendor-root re-validation under the
  // package-store generation lock and before grant/pin DB write, replace archive/content on disk.
  // Must fail closed before commit (post-hook re-verify), with no grant and no wasm pin.
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let content_file = packages.package_content_path(&digest).join("locales/en.json");
  assert!(
    content_file.is_file(),
    "expected extracted locale for post-revalidate TOCTOU"
  );
  let hook_ran = Arc::new(AtomicBool::new(false));
  let hook_ran_for_hook = hook_ran.clone();
  let packages_for_hook = packages.clone();
  let digest_for_hook = digest.clone();
  lifecycle.set_auto_pin_after_final_revalidate_hook(Some(Box::new(move || {
    hook_ran_for_hook.store(true, Ordering::SeqCst);
    let path = packages_for_hook
      .package_content_path(&digest_for_hook)
      .join("locales/en.json");
    let _ = std::fs::set_permissions(&path, {
      let mut perms = std::fs::metadata(&path).unwrap().permissions();
      perms.set_readonly(false);
      perms
    });
    std::fs::write(&path, b"{\"tampered-after-final-revalidate\":true}").unwrap();
    // Also attempt archive byte flip (clear readonly first).
    let archive = packages_for_hook.package_archive_path(&digest_for_hook);
    if archive.is_file() {
      let _ = std::fs::set_permissions(&archive, {
        let mut perms = std::fs::metadata(&archive).unwrap().permissions();
        perms.set_readonly(false);
        perms
      });
      if let Ok(mut bytes) = std::fs::read(&archive) {
        if let Some(last) = bytes.last_mut() {
          *last ^= 0xff;
        }
        let _ = std::fs::write(&archive, bytes);
      }
    }
  })));
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  assert!(
    hook_ran.load(Ordering::SeqCst),
    "test hook must run after final revalidation before asserting the post-hook rejection path"
  );
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(
    after.runtime_kind, "bundled-rust",
    "post-hook revalidation must reject content/archive replacement before grant/pin"
  );
  assert!(
    after.package_digest.is_none(),
    "no wasm pin after post-revalidate TOCTOU"
  );
  assert!(
    after.execution_grant_set_revision.is_none(),
    "no grant after post-revalidate TOCTOU"
  );
}

#[test]
fn runtime_rejects_archive_replaced_after_auto_pin_before_execution() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  assert_eq!(
    db.read(|conn| integration_instances::get(conn, id))
      .unwrap()
      .runtime_kind,
    "wasm-component",
    "test requires a completed auto-pin commit"
  );

  // The archive is a valid package that declares the vendor identity but has an attacker
  // signature. Runtime must reject it before it opens any extracted artifact for execution.
  let (attacker_archive, _attacker_digest, _attacker_key, _attacker_fingerprint) =
    build_attacker_gtx_package_declaring_vendor_key();
  let archive_path = packages.package_archive_path(&digest);
  let mut permissions = std::fs::metadata(&archive_path).unwrap().permissions();
  permissions.set_readonly(false);
  std::fs::set_permissions(&archive_path, permissions).unwrap();
  std::fs::write(&archive_path, attacker_archive).unwrap();

  let err = match caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()) {
    Ok(_) => panic!("attacker archive must be rejected before runtime resolution"),
    Err(err) => err,
  };
  assert_eq!(err.code, CapabilityErrorCode::PluginUnavailable);
  assert!(
    err.message.to_ascii_lowercase().contains("signature"),
    "external vendor-root signature verification must reject the replacement: {err:?}"
  );
  assert!(
    transport.last.lock().unwrap().is_none(),
    "rejected archive bytes must never reach guest execution or its network broker"
  );
}

#[test]
fn runtime_rejects_artifact_replaced_after_auto_pin_before_execution() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  assert_eq!(
    db.read(|conn| integration_instances::get(conn, id))
      .unwrap()
      .runtime_kind,
    "wasm-component",
    "test requires a completed auto-pin commit"
  );

  let artifact_path = packages.package_content_path(&digest).join(TRANSLATE_ARTIFACT_PATH);
  let mut permissions = std::fs::metadata(&artifact_path).unwrap().permissions();
  permissions.set_readonly(false);
  std::fs::set_permissions(&artifact_path, permissions).unwrap();
  std::fs::write(&artifact_path, b"malicious-wasm-bytes").unwrap();

  let err = match caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()) {
    Ok(_) => panic!("tampered artifact must be rejected before runtime resolution"),
    Err(err) => err,
  };
  assert_eq!(err.code, CapabilityErrorCode::PluginUnavailable);
  assert!(
    err.message.contains("snapshot verification"),
    "the content comparison against the immutable archive snapshot must reject replacement: {err:?}"
  );
  assert!(
    transport.last.lock().unwrap().is_none(),
    "rejected artifact bytes must never reach guest execution or its network broker"
  );
}

#[test]
fn runtime_snapshot_recheck_rejects_archive_only_replacement_after_archive_verification() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  assert_eq!(
    db.read(|conn| integration_instances::get(conn, id))
      .unwrap()
      .runtime_kind,
    "wasm-component",
    "test requires a completed auto-pin commit"
  );

  let hook_ran = Arc::new(AtomicBool::new(false));
  let hook_ran_for_hook = hook_ran.clone();
  let packages_for_hook = packages.clone();
  let digest_for_hook = digest.clone();
  let (attacker_archive, _attacker_digest, _attacker_key, _attacker_fingerprint) =
    build_attacker_gtx_package_declaring_vendor_key();
  packages.set_runtime_snapshot_after_archive_read_hook(Some(Box::new(move || {
    hook_ran_for_hook.store(true, Ordering::SeqCst);
    let archive_path = packages_for_hook.package_archive_path(&digest_for_hook);
    let mut archive_permissions = std::fs::metadata(&archive_path).unwrap().permissions();
    archive_permissions.set_readonly(false);
    std::fs::set_permissions(&archive_path, archive_permissions).unwrap();
    std::fs::write(&archive_path, attacker_archive).unwrap();
  })));

  let err = match caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()) {
    Ok(_) => panic!("archive-only replacement after snapshot verification must be rejected"),
    Err(err) => err,
  };
  assert!(
    hook_ran.load(Ordering::SeqCst),
    "archive snapshot hook must run before asserting the archive identity recheck"
  );
  assert_eq!(err.code, CapabilityErrorCode::PluginUnavailable);
  assert!(
    err.message.to_ascii_lowercase().contains("signature"),
    "archive identity recheck must surface the attacker signature failure: {err:?}"
  );
  assert!(
    transport.last.lock().unwrap().is_none(),
    "archive-only replacement bytes must never reach guest execution or its network broker"
  );
}

#[test]
fn runtime_snapshot_recheck_rejects_replacement_after_archive_verification() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  assert_eq!(
    db.read(|conn| integration_instances::get(conn, id))
      .unwrap()
      .runtime_kind,
    "wasm-component",
    "test requires a completed auto-pin commit"
  );

  let hook_ran = Arc::new(AtomicBool::new(false));
  let hook_ran_for_hook = hook_ran.clone();
  let packages_for_hook = packages.clone();
  let digest_for_hook = digest.clone();
  let (attacker_archive, _attacker_digest, _attacker_key, _attacker_fingerprint) =
    build_attacker_gtx_package_declaring_vendor_key();
  packages.set_runtime_snapshot_after_archive_read_hook(Some(Box::new(move || {
    hook_ran_for_hook.store(true, Ordering::SeqCst);
    let archive_path = packages_for_hook.package_archive_path(&digest_for_hook);
    let mut archive_permissions = std::fs::metadata(&archive_path).unwrap().permissions();
    archive_permissions.set_readonly(false);
    std::fs::set_permissions(&archive_path, archive_permissions).unwrap();
    std::fs::write(&archive_path, attacker_archive).unwrap();

    let artifact_path = packages_for_hook
      .package_content_path(&digest_for_hook)
      .join(TRANSLATE_ARTIFACT_PATH);
    let mut artifact_permissions = std::fs::metadata(&artifact_path).unwrap().permissions();
    artifact_permissions.set_readonly(false);
    std::fs::set_permissions(&artifact_path, artifact_permissions).unwrap();
    std::fs::write(&artifact_path, b"malicious-wasm-bytes-after-snapshot").unwrap();
  })));

  let err = match caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()) {
    Ok(_) => panic!("post-snapshot replacement must be rejected before runtime resolution"),
    Err(err) => err,
  };
  assert!(
    hook_ran.load(Ordering::SeqCst),
    "archive snapshot hook must run before asserting the post-snapshot recheck path"
  );
  assert_eq!(err.code, CapabilityErrorCode::PluginUnavailable);
  assert!(
    err.message.contains("snapshot verification"),
    "post-snapshot content comparison must reject the replacement: {err:?}"
  );
  assert!(
    transport.last.lock().unwrap().is_none(),
    "post-snapshot replacement bytes must never reach guest execution or its network broker"
  );
}

#[test]
fn pin_default_fails_closed_when_db_publisher_swapped_between_verify_and_apply() {
  // TOCTOU: after initial vendor-root verify, swap the DB publisher public key / source so the
  // reverse-bind no longer matches the external root. Must fail closed.
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  let (pkg, _digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let db_for_hook = db.clone();
  lifecycle.set_auto_pin_between_verify_and_apply_hook(Some(Box::new(move || {
    db_for_hook
      .transaction(|uow| {
        uow.conn().execute(
          "UPDATE plugin_publishers SET public_key_hex = ?1, source = 'user_approved' WHERE key_id = ?2",
          rusqlite::params!["00".repeat(32), crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID],
        )?;
        Ok(())
      })
      .unwrap();
  })));
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(
    after.runtime_kind, "bundled-rust",
    "DB publisher swap between verify and apply must fail closed"
  );
  assert!(after.package_digest.is_none());
  assert!(after.execution_grant_set_revision.is_none());
}

#[test]
fn google_translate_web_runtime_bundled_rollback_remains_available() {
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  // Before activation the instance is Bundled Rust.
  let before = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(before.runtime_kind, "bundled-rust");
  // After activation it is Wasm; rolling back restores Bundled Rust identity.
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

#[test]
fn google_translate_web_proxy_package_keeps_gtx_without_proxy_grant() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (pkg, digest) = build_google_web_proxy_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  activate(&lifecycle, id, &digest);

  let instance = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  let grant = db
    .read(|conn| {
      crate::repositories::plugin_permission_grants::get_bundle_for_subject_package_revision(
        conn,
        crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
        id,
        instance.package_digest.as_deref().unwrap(),
        instance.execution_grant_set_revision.unwrap(),
      )
    })
    .unwrap();
  assert!(!grant.network.iter().any(|entry| entry.endpoint_id == "https-proxy"));

  *transport.response.lock().unwrap() = Ok(text_response(r#"[[["Hello","你好",null,null,1]],null,"zh"]"#));
  let translate = caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()).unwrap();
  let response = block_on(translate.translate(
    id,
    TranslateTextRequest {
      text: "你好".into(),
      source_language_id: "zh".into(),
      target_language_id: "en".into(),
    },
    ctx(id, "req-proxy-package-gtx", TRANSLATE_CAP),
  ))
  .unwrap();
  assert_eq!(response.translated_text, "Hello");
  assert!(
    transport
      .last
      .lock()
      .unwrap()
      .as_ref()
      .unwrap()
      .url
      .as_str()
      .starts_with(GTX_ORIGIN)
  );
}

#[test]
fn google_translate_web_proxy_channel_uses_default_url() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (pkg, digest) = build_google_web_proxy_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"https_proxy"}"#);
  activate(&lifecycle, id, &digest);

  let instance = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  let config: serde_json::Value = serde_json::from_str(&instance.config_json).unwrap();
  assert_eq!(
    config.get("proxy-url").and_then(serde_json::Value::as_str),
    Some(GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL)
  );

  *transport.response.lock().unwrap() = Ok(text_response(r#"{"data":"Hello"}"#));
  let translate = caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()).unwrap();
  let response = block_on(translate.translate(
    id,
    TranslateTextRequest {
      text: "你好".into(),
      source_language_id: "zh".into(),
      target_language_id: "en".into(),
    },
    ctx(id, "req-proxy-default", TRANSLATE_CAP),
  ))
  .unwrap();
  assert_eq!(response.translated_text, "Hello");
  let prepared = transport.last.lock().unwrap();
  assert_eq!(
    prepared.as_ref().unwrap().url.as_str(),
    GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL
  );
  assert_eq!(
    prepared.as_ref().unwrap().destination_policy,
    DestinationPolicy::PublicInternet
  );
}

#[test]
fn google_translate_web_proxy_channel_translates_and_detect_stays_on_gtx() {
  let (dir, db, packages, lifecycle, caps, transport) = setup();
  let (pkg, digest) = build_google_web_proxy_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(
    &db,
    r#"{"channel":"https_proxy","proxy-url":"https://proxy-a.example/v1/custom"}"#,
  );
  activate(&lifecycle, id, &digest);

  // Translate via the HTTPS proxy channel: capture transport returns the proxy `{data}` body.
  *transport.response.lock().unwrap() = Ok(text_response(r#"{"data":"Hello"}"#));
  let translate = caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()).unwrap();
  let resp = block_on(translate.translate(
    id,
    TranslateTextRequest {
      text: "你好".into(),
      source_language_id: "zh".into(),
      target_language_id: "en".into(),
    },
    ctx(id, "req-proxy", TRANSLATE_CAP),
  ))
  .expect("proxy translate");
  assert_eq!(resp.translated_text, "Hello");
  let prepared = transport.last.lock().unwrap().take().unwrap();
  assert_eq!(prepared.url.as_str(), "https://proxy-a.example/v1/custom");
  assert_eq!(prepared.destination_policy, DestinationPolicy::PublicInternet);
  assert_eq!(prepared.method, crate::domain::provider_http::ProviderHttpMethod::Post);
  assert!(prepared.body.as_text().is_some());
  let body: serde_json::Value = serde_json::from_str(prepared.body.as_text().unwrap()).unwrap();
  assert_eq!(body["text"], "你好");
  assert_eq!(body["source_lang"], "zh-CN");
  assert_eq!(body["target_lang"], "en");
  assert!(!prepared.headers.keys().any(|k| k.eq_ignore_ascii_case("Authorization")));

  // Detect stays on pinned GTX even when the instance channel is https_proxy.
  *transport.response.lock().unwrap() = Ok(text_response(r#"[[["x","y",null,null,1]],null,"en"]"#));
  let detect = caps.resolve_detect(id, DETECT_CAP, b"{}".to_vec()).unwrap();
  let det = block_on(detect.detect(
    id,
    DetectLanguageRequest { text: "hello".into() },
    ctx(id, "req-proxy-dt", DETECT_CAP),
  ))
  .expect("detect");
  assert_eq!(det.language_id, "en");
  let prepared = transport.last.lock().unwrap().take().unwrap();
  assert!(
    prepared.url.as_str().starts_with(GTX_ORIGIN),
    "detect must stay on GTX: {}",
    prepared.url
  );
  assert_eq!(prepared.destination_policy, DestinationPolicy::TrustedFixed);
}

#[test]
fn google_translate_web_proxy_url_change_requires_new_grant() {
  let (dir, db, packages, lifecycle, caps, _transport) = setup();
  let (pkg, digest) = build_google_web_proxy_package();
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(
    &db,
    r#"{"channel":"https_proxy","proxy-url":"https://proxy-a.example/translate"}"#,
  );
  activate(&lifecycle, id, &digest);

  // The approved grant persisted the proxy-a origin for the https_proxy endpoint.
  let grant_origin_a = db
    .read(|conn| {
      let inst = integration_instances::get(conn, id)?;
      let digest = inst.package_digest.as_deref().unwrap();
      let rev = inst.execution_grant_set_revision.unwrap();
      let bundle = crate::repositories::plugin_permission_grants::get_bundle_for_subject_package_revision(
        conn,
        crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
        id,
        digest,
        rev,
      )?;
      Ok::<_, crate::error::StorageError>(
        bundle
          .network
          .into_iter()
          .find(|n| n.endpoint_id == "https-proxy")
          .map(|n| n.origin)
          .unwrap_or_default(),
      )
    })
    .unwrap();
  assert_eq!(grant_origin_a, "https://proxy-a.example");

  // Change the proxy URL in config without re-approving. The persisted grant origin is stale:
  // the approved effective origin stays proxy-a (the grant is immutable), proving the URL
  // change is NOT trusted from mutable config and requires a new explicit grant (re-activation).
  let now = crate::domain::time::now_rfc3339();
  db.transaction(|uow| {
    let cur = integration_instances::get(uow.conn(), id)?;
    integration_instances::compare_and_set(
      uow.conn(),
      id,
      &cur.updated_at,
      &cur.display_name,
      cur.enabled,
      r#"{"channel":"https_proxy","proxy-url":"https://proxy-b.example/v1"}"#,
      cur.config_schema_version,
      cur.health_status,
      None,
      None,
      &now,
    )?;
    Ok(())
  })
  .unwrap();

  let grant_origin_after = db
    .read(|conn| {
      let inst = integration_instances::get(conn, id)?;
      let digest = inst.package_digest.as_deref().unwrap();
      let rev = inst.execution_grant_set_revision.unwrap();
      let bundle = crate::repositories::plugin_permission_grants::get_bundle_for_subject_package_revision(
        conn,
        crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
        id,
        digest,
        rev,
      )?;
      Ok::<_, crate::error::StorageError>(
        bundle
          .network
          .into_iter()
          .find(|n| n.endpoint_id == "https-proxy")
          .map(|n| n.origin)
          .unwrap_or_default(),
      )
    })
    .unwrap();
  assert_eq!(
    grant_origin_after, "https://proxy-a.example",
    "approved grant origin must be immutable; URL change requires a new grant"
  );

  let stale_err = caps
    .resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec())
    .err()
    .expect("stale configured origin must not execute");
  assert_eq!(stale_err.code, CapabilityErrorCode::PermissionDenied);

  let preview = lifecycle.preview_upgrade(id, &digest).unwrap();
  assert!(preview.requires_permission_approval);
  assert!(preview.permission_differences.iter().any(|difference| {
    difference.kind == "network_endpoint_added" && difference.origin.as_deref() == Some("https://proxy-b.example")
  }));
  let denied = lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: false,
    })
    .unwrap_err();
  assert!(matches!(denied, crate::error::StorageError::Validation(_)));

  let approved = lifecycle.preview_upgrade(id, &digest).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: approved.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let grant_origin_b = db
    .read(|conn| {
      let inst = integration_instances::get(conn, id)?;
      let bundle = crate::repositories::plugin_permission_grants::get_bundle_for_subject_package_revision(
        conn,
        crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
        id,
        inst.package_digest.as_deref().unwrap(),
        inst.execution_grant_set_revision.unwrap(),
      )?;
      Ok::<_, crate::error::StorageError>(
        bundle
          .network
          .into_iter()
          .find(|entry| entry.endpoint_id == "https-proxy")
          .map(|entry| entry.origin)
          .unwrap_or_default(),
      )
    })
    .unwrap();
  assert_eq!(grant_origin_b, "https://proxy-b.example");
}

#[test]
fn google_web_package_verifies_with_vendor_public_key() {
  let (pkg, digest) = build_google_web_package();
  let public_key = fixture_vendor_public_key_hex();
  let verified = verify_package_bytes(&pkg, &public_key).expect("package must verify");
  assert_eq!(verified.package_digest, digest);
  assert_eq!(verified.manifest.id, PLUGIN_ID);
  assert_eq!(verified.manifest.version, "1.0.0");
  assert_eq!(verified.publisher_fingerprint, fixture_vendor_fingerprint());
  // The package ships two runtime artifacts (translate + detect) and both capabilities.
  assert_eq!(verified.manifest.capabilities.len(), 2);
  let artifact_roles = verified
    .manifest
    .files
    .iter()
    .filter(|f| matches!(f.role, FileRole::RuntimeArtifact))
    .count();
  assert_eq!(
    artifact_roles, 2,
    "package must index both translate and detect artifacts"
  );
}

#[test]
fn google_web_migration_rejects_incompatible_capability_major() {
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  // Standard GTX package (compatible: translate.text@1 + translate.detect@1).
  let (pkg, digest_ok) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);
  // Installable but migration-incompatible package drops translate.detect@1. The host supports
  // translate.text@1 alone, so approval accepts it; migration must still fail closed because the
  // bundled instance exposes translate.detect@1 and dropping it would sever profile bindings.
  let (pkg_bad, digest_bad) = build_google_web_package_with(
    "1.2.0",
    CONFIG_SCHEMA_GTX,
    "schemas/config.json",
    vec![],
    vec![(TRANSLATE_CAP, TRANSLATE_ARTIFACT_PATH)],
  );
  install_package(&packages, dir.path(), &pkg_bad);

  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  // Compatible migration previews successfully (both source majors present in target).
  let preview = lifecycle.preview_upgrade(id, &digest_ok).unwrap();
  assert!(
    preview
      .capability_compatibility
      .iter()
      .any(|c| c.capability_id == TRANSLATE_CAP)
  );

  // Dropping translate.detect@1 fails closed at preview: never offer a migration that would
  // sever the instance/profile binding to a capability major the source exposes.
  let err = lifecycle.preview_upgrade(id, &digest_bad).unwrap_err();
  assert!(
    matches!(&err, StorageError::Validation(msg) if msg.contains("translate.detect@1")),
    "expected fail-closed validation error for missing major, got {err:?}"
  );
}

#[test]
fn google_web_migration_rejects_schema_incompatible_target() {
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  // Target schema requires a `mode` field the bundled GTX config ({"channel":"gtx"}) does not
  // provide. The same schema version (1) means no migration component is required, so the
  // migrated config must validate against the target schema - it does not, so fail closed.
  let incompatible_schema = r#"{"version":1,"fields":[{"id":"mode","control":{"kind":"string","spec":{}},"labelFallback":"Mode","requiredForReady":true}],"groups":[]}"#;
  let (pkg, digest) = build_google_web_package_with(
    "1.3.0",
    incompatible_schema,
    "schemas/config.json",
    vec![],
    vec![
      (TRANSLATE_CAP, TRANSLATE_ARTIFACT_PATH),
      (DETECT_CAP, DETECT_ARTIFACT_PATH),
    ],
  );
  install_package(&packages, dir.path(), &pkg);
  let id = seed_instance(&db, r#"{"channel":"gtx"}"#);
  let err = lifecycle.preview_upgrade(id, &digest).unwrap_err();
  assert!(
    matches!(&err, StorageError::Validation(_)),
    "expected fail-closed validation error for schema-incompatible target, got {err:?}"
  );
}

#[test]
fn google_web_new_instance_pins_default_wasm_package() {
  let (dir, db, packages, lifecycle, _caps, _transport) = setup();
  let (pkg, digest) = build_google_web_package();
  install_package(&packages, dir.path(), &pkg);

  // ServiceIntegrationService wired with runtime_lifecycle, as AppState wires it in production.
  let vault: Arc<dyn crate::credentials::CredentialVault> =
    Arc::new(crate::credentials::MemoryCredentialVault::default());
  let tokens = Arc::new(TokenGrantService::new(Arc::new(
    crate::services::google_service_account::GoogleServiceAccountExchanger::new(db.clone(), vault.clone()),
  )));
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let integrations =
    ServiceIntegrationService::new(db.clone(), vault, registry, tokens).with_runtime_lifecycle(lifecycle);

  let dto = integrations
    .save(crate::domain::service_integration::IntegrationInstanceWrite {
      id: None,
      plugin_id: PLUGIN_ID.into(),
      display_name: "Auto-pin".into(),
      enabled: true,
      config_json: r#"{"channel":"gtx"}"#.into(),
      credentials: vec![],
      expected_updated_at: None,
    })
    .unwrap();

  // New Google Web instance pins the default Wasm package (not Bundled Rust) with an active grant.
  assert_eq!(dto.runtime_kind, "wasm-component");
  assert_eq!(dto.package_digest.as_deref(), Some(digest.as_str()));
  assert_eq!(dto.runtime_state, "active");
  assert!(dto.execution_grant_set_revision.is_some());
}

#[test]
fn google_web_new_instance_falls_back_to_bundled_when_no_default_package() {
  let (_dir, db, _packages, lifecycle, _caps, _transport) = setup();
  // No package installed -> no default -> new instance stays Bundled Rust (safe-fail).
  let vault: Arc<dyn crate::credentials::CredentialVault> =
    Arc::new(crate::credentials::MemoryCredentialVault::default());
  let tokens = Arc::new(TokenGrantService::new(Arc::new(
    crate::services::google_service_account::GoogleServiceAccountExchanger::new(db.clone(), vault.clone()),
  )));
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let integrations =
    ServiceIntegrationService::new(db.clone(), vault, registry, tokens).with_runtime_lifecycle(lifecycle);

  let dto = integrations
    .save(crate::domain::service_integration::IntegrationInstanceWrite {
      id: None,
      plugin_id: PLUGIN_ID.into(),
      display_name: "No default".into(),
      enabled: true,
      config_json: r#"{"channel":"gtx"}"#.into(),
      credentials: vec![],
      expected_updated_at: None,
    })
    .unwrap();

  assert_eq!(dto.runtime_kind, "bundled-rust");
  assert!(dto.package_digest.is_none());
  assert!(dto.execution_grant_set_revision.is_none());
}
