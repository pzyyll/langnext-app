// ABOUTME: Phase 5 Google Translate Web runtime dispatch tests through the Wasm runtime router.
// ABOUTME: Catalog snapshots are the only content source; activate -> Translate/Detect via Wasm.
#![cfg(test)]

use crate::domain::cancel::CancelToken;
use crate::domain::plugin_catalog::sha256_hex;
use crate::domain::runtime_lifecycle::{ApplyRuntimeUpgradeInput, ExecutionGrantSetBundle, InstanceRuntimeState};
use crate::domain::runtime_plugin::{
  AuthPolicyId, CapabilityId, CapabilityPathAuthorityDecl, DeclaredPathAuthority, EndpointId, FileRole, HttpMethod,
  HttpsOrigin, NetworkEndpointRequest, NetworkGrantEntry, NetworkOriginKind, NetworkResourceMode, PluginFileEntry,
  PluginManifestV1, ResourceLimits,
};
use crate::domain::service_capability::{
  CapabilityErrorCode, DetectLanguageRequest, ExecutionContext, TranslateTextRequest,
};
use crate::domain::service_integration::{
  GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL, GOOGLE_TRANSLATE_WEB_PLUGIN_ID, IntegrationHealthStatus, IntegrationInstance,
  IntegrationInstanceWrite,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{
  GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION, PluginCapabilityEngine, TranslationProfile, TranslationProfileEngine,
};
use crate::error::StorageError;
use crate::repositories::{integration_instances, plugin_permission_grants, translation_profiles};
use crate::services::bounded_http::{BoundedHttpResponse, DestinationPolicy, PreparedHttpRequest, RawHttpTransport};
use crate::services::plugin_catalog::PluginCatalog;
use crate::services::plugin_loader::pack_directory_to_archive;
use crate::services::runtime_lifecycle::RuntimeLifecycleService;
use crate::services::runtime_router::RuntimeRouter;
use crate::services::service_capabilities::{ProfileCapabilityKind, ServiceCapabilityService};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::service_integrations::ServiceIntegrationService;
use crate::services::test_support::{
  GOOGLE_TRANSLATE_WEB_ARCHIVE, add_builtin_fixture, catalog_with_builtins, fixture_digest, registry_for,
  registry_from_catalog, token_service, wasm_runtime, write_manifest_fixture_dir,
};
use crate::services::wasm_runtime::host::BrokerHandle;
use crate::services::wasm_runtime::network_handle::NetworkBrokerHandle;
use crate::storage::Database;
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use uuid::Uuid;

const PLUGIN_ID: &str = GOOGLE_TRANSLATE_WEB_PLUGIN_ID;
const TRANSLATE_CAP: &str = "translate.text@1";
const DETECT_CAP: &str = "translate.detect@1";
const GTX_ORIGIN: &str = "https://translate.google.com";
const HOST_NONE_AUTH_POLICY: &str = "host.none.v1";
const TRANSLATE_ARTIFACT_PATH: &str = "translate/fixtures/langnext-google-translate-web-translate.wasm";

/// Instance-configured HTTPS proxy endpoint declared by the proxy content fixture.
const PROXY_ENDPOINT_ID: &str = "https-proxy";
/// Config field that carries the proxy URL and the authorized relative path.
const PROXY_CONFIG_FIELD: &str = "proxy-url";
/// Indexed path that holds the config schema in every content variant.
const CONFIG_SCHEMA_PATH: &str = "schemas/config.json";
/// Committed proxy config schema (channel `gtx` | `https_proxy` plus `proxy-url`).
const CONFIG_SCHEMA_PROXY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/google-translate-web/schemas/config-proxy.json"
));

/// Version of the cloned proxy content fixture added to a catalog.
const PROXY_FIXTURE_VERSION: &str = "1.1.0";
/// Version of the migration fixture that drops `translate.detect@1`.
const MIGRATION_DROP_DETECT_VERSION: &str = "1.2.0";
/// Version of the migration fixture whose config schema rejects the bundled GTX config.
const MIGRATION_INCOMPATIBLE_SCHEMA_VERSION: &str = "1.3.0";
/// Version of the content fixture that adds one static third-party endpoint.
const STATIC_ENDPOINT_FIXTURE_VERSION: &str = "1.4.0";

/// Config schema that only accepts the proxy channel, so a GTX instance cannot migrate to it.
const INCOMPATIBLE_CONFIG_SCHEMA: &str = r#"{"version":1,"fields":[{"id":"channel","control":{"kind":"enum","spec":{"source":{"type":"fixed","options":[{"value":"https_proxy","labelFallback":"HTTPS Proxy"}]},"default":"https_proxy"}},"labelFallback":"Channel","requiredForReady":true}],"groups":[]}"#;

const THIRD_PARTY_STATIC_ENDPOINT_ID: &str = "third-party-static";
const THIRD_PARTY_STATIC_MANIFEST_ORIGIN: &str = "https://third-party.example";
const TAMPERED_PUBLIC_HTTPS_ORIGIN: &str = "https://attacker.example";
const EMPTY_PREFERENCES_JSON: &[u8] = b"{}";
const TEST_PROFILE_NAME: &str = "Static Origin Test";
const TEST_PROFILE_SOURCE_LANGUAGE: &str = "en";
const TEST_PROFILE_TARGET_LANGUAGE: &str = "zh";

const EXPECTED_CONTROL_WASM_REQUESTS: usize = 1;
const NO_TRANSPORT_REQUESTS: usize = 0;
const TAMPERED_GRANT_PLUGIN_ID: &str = "langnext.google-translate-web.tampered";
const TAMPERED_GRANT_PLUGIN_VERSION: &str = "9.9.9";
const TAMPERED_PERMISSION_REQUEST_DIGEST: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

/// Payload used to build a valid replacement package with different content identity.
const REPLACED_LOCALE_PATH: &str = "locales/en.json";
const REPLACED_LOCALE_BYTES: &[u8] = br#"{"replaced":true}"#;

/// Test-level watchdog bounding pending-transport cancel/timeout tests. If the host cancel or
/// deadline select regresses and never surfaces, the test fails fast with a clear message instead
/// of hanging the suite. Well above the 500ms host deadline and the cancel-after-start latency.
const PENDING_TRANSPORT_TEST_WATCHDOG: Duration = Duration::from_secs(10);

/// Capture transport: records the last prepared request and returns a configurable response.
struct CaptureTransport {
  last: Mutex<Option<PreparedHttpRequest>>,
  calls: AtomicUsize,
  response: Mutex<Result<BoundedHttpResponse, String>>,
}

impl CaptureTransport {
  fn new(response: BoundedHttpResponse) -> Self {
    Self {
      last: Mutex::new(None),
      calls: AtomicUsize::new(0),
      response: Mutex::new(Ok(response)),
    }
  }

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

/// Catalog-first runtime stack: one app data directory, the catalog over it, the projected
/// definition registry, the lifecycle service, and the capability service with a broker factory.
struct Fixture {
  /// Owns the temp app data directory the catalog snapshots live under.
  _dir: tempfile::TempDir,
  db: Database,
  catalog: Arc<PluginCatalog>,
  registry: Arc<ServiceIntegrationRegistry>,
  lifecycle: RuntimeLifecycleService,
  caps: Arc<ServiceCapabilityService>,
}

impl Fixture {
  /// Fixture over the committed google-translate-web archive (GTX-only content).
  fn capture() -> (Self, Arc<CaptureTransport>) {
    let (dir, db, catalog) = base_catalog();
    let transport = Arc::new(CaptureTransport::new(text_response(
      r#"[[["Hi","你好",null,null,1]],null,"zh"]"#,
    )));
    let registry = registry_from_catalog(&catalog);
    let fixture = Self::assemble(dir, db, catalog, registry, transport.clone());
    (fixture, transport)
  }

  /// Fixture over the committed archive plus cloned proxy content that is the catalog default.
  fn capture_with_proxy() -> (Self, Arc<CaptureTransport>) {
    let (dir, db, catalog) = base_catalog();
    let proxy = ContentVariant::from_catalog(&catalog, PROXY_FIXTURE_VERSION)
      .set_config_schema(CONFIG_SCHEMA_PATH, CONFIG_SCHEMA_PROXY)
      .with_network_endpoint(NetworkEndpointRequest {
        id: PROXY_ENDPOINT_ID.into(),
        origins: Vec::new(),
        methods: vec![HttpMethod::Post],
        instance_origin_config_field: Some(PROXY_CONFIG_FIELD.into()),
      })
      .with_path_authority(proxy_path_authority());
    add_builtin_fixture(&catalog, &proxy.manifest, &proxy.payloads);
    // Two versions of one plugin id exist, so project only the resolved default definition.
    let registry = registry_for(&catalog, &[PLUGIN_ID]);
    let transport = Arc::new(CaptureTransport::new(text_response(
      r#"[[["Hi","你好",null,null,1]],null,"zh"]"#,
    )));
    let fixture = Self::assemble(dir, db, catalog, registry, transport.clone());
    (fixture, transport)
  }

  /// Fixture whose broker transport never answers (cancel/deadline tests).
  fn blocking() -> (Self, Arc<BlockingTransport>) {
    let (dir, db, catalog) = base_catalog();
    let transport = Arc::new(BlockingTransport::new());
    let registry = registry_from_catalog(&catalog);
    let fixture = Self::assemble(dir, db, catalog, registry, transport.clone());
    (fixture, transport)
  }

  fn assemble(
    dir: tempfile::TempDir,
    db: Database,
    catalog: Arc<PluginCatalog>,
    registry: Arc<ServiceIntegrationRegistry>,
    transport: Arc<dyn RawHttpTransport>,
  ) -> Self {
    let wasm = wasm_runtime();
    let tokens = token_service(&db, Arc::new(crate::credentials::MemoryCredentialVault::default()));
    let lifecycle =
      RuntimeLifecycleService::new(db.clone(), catalog.clone(), registry.clone()).with_runtime(wasm.clone(), tokens);
    let router = RuntimeRouter::new(db.clone(), registry.clone(), catalog.clone(), wasm.clone());
    let broker_transport = transport.clone();
    let broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync> =
      Arc::new(move || Box::new(NetworkBrokerHandle::new(broker_transport.clone())));
    let caps = Arc::new(
      ServiceCapabilityService::new(db.clone(), registry.clone())
        .with_catalog(catalog.clone())
        .with_router(router, wasm)
        .with_broker_factory(broker_factory),
    );
    Self {
      _dir: dir,
      db,
      catalog,
      registry,
      lifecycle,
      caps,
    }
  }

  /// Resolved catalog default digest for the google-translate-web plugin.
  fn digest(&self) -> String {
    fixture_digest(&self.catalog, PLUGIN_ID)
  }
}

/// Temp app data directory, initialized database, and catalog over the committed archive.
fn base_catalog() -> (tempfile::TempDir, Database, Arc<PluginCatalog>) {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let catalog = catalog_with_builtins(db.clone(), dir.path(), &[GOOGLE_TRANSLATE_WEB_ARCHIVE]);
  (dir, db, catalog)
}

/// One mutable copy of catalog content used to build variant packages for lifecycle tests.
struct ContentVariant {
  manifest: PluginManifestV1,
  payloads: Vec<(String, Vec<u8>)>,
}

impl ContentVariant {
  /// Clone the resolved catalog default content under a new version.
  fn from_catalog(catalog: &PluginCatalog, version: &str) -> Self {
    let loaded = catalog
      .resolve_default(PLUGIN_ID)
      .unwrap_or_else(|| panic!("fixture plugin {PLUGIN_ID} is not in the catalog"));
    let payloads = loaded
      .manifest
      .files
      .iter()
      .map(|file| {
        (
          file.path.clone(),
          loaded
            .read_snapshot_file(&file.path)
            .unwrap_or_else(|error| panic!("read snapshot file {}: {error}", file.path)),
        )
      })
      .collect();
    let mut manifest = loaded.manifest.clone();
    manifest.version = version.into();
    Self { manifest, payloads }
  }

  /// Replace or add one indexed payload file.
  fn set_file(mut self, path: &str, role: FileRole, bytes: &[u8]) -> Self {
    self.manifest.files.retain(|file| file.path != path);
    self.payloads.retain(|(payload_path, _)| payload_path != path);
    self.manifest.files.push(indexed_file(path, role, bytes));
    self.payloads.push((path.into(), bytes.to_vec()));
    self
  }

  /// Replace the config schema payload and point the manifest at it.
  fn set_config_schema(self, path: &str, schema: &str) -> Self {
    let mut variant = self.set_file(path, FileRole::ConfigSchema, schema.as_bytes());
    variant.manifest.configuration_schema = Some(path.into());
    variant
  }

  fn with_network_endpoint(mut self, endpoint: NetworkEndpointRequest) -> Self {
    self.manifest.permissions.network.push(endpoint);
    self
  }

  fn with_path_authority(mut self, declaration: CapabilityPathAuthorityDecl) -> Self {
    self.manifest.path_authority.push(declaration);
    self
  }

  /// Drop one capability and every path authority that referenced it.
  fn without_capability(mut self, capability_id: &str) -> Self {
    self
      .manifest
      .capabilities
      .retain(|capability| capability.id != capability_id);
    self
      .manifest
      .path_authority
      .retain(|declaration| declaration.capability_id != capability_id);
    self
  }

  /// Add this variant as built-in content and return its content digest.
  fn add_to(self, catalog: &PluginCatalog) -> String {
    add_builtin_fixture(catalog, &self.manifest, &self.payloads)
  }

  /// Pack this variant over the committed built-in archive path and refresh the catalog.
  ///
  /// Returns the replacement content digest. The package stays structurally valid, so the only
  /// observable effect is a new content identity for the same plugin id and version.
  fn replace_builtin_archive(self, catalog: &PluginCatalog) -> String {
    let built_in_dir = catalog
      .config()
      .built_in_dir
      .clone()
      .expect("fixture catalog has a built-in directory");
    let staging = catalog.app_data_dir().join("archive-replacement-staging");
    let staged_dir = write_manifest_fixture_dir(&staging, &self.manifest, &self.payloads);
    let archive_path = built_in_dir.join(format!("{GOOGLE_TRANSLATE_WEB_ARCHIVE}.lnplugin"));
    let digest = pack_directory_to_archive(&staged_dir, &archive_path).expect("replacement archive packs");
    std::fs::remove_dir_all(&staging).ok();
    catalog
      .refresh()
      .expect("catalog refreshes after the source archive is replaced");
    digest
  }
}

fn indexed_file(path: &str, role: FileRole, bytes: &[u8]) -> PluginFileEntry {
  PluginFileEntry {
    path: path.into(),
    role,
    bytes: bytes.len() as u64,
    sha256: sha256_hex(bytes),
  }
}

/// Path authority for the instance-configured proxy endpoint.
fn proxy_path_authority() -> CapabilityPathAuthorityDecl {
  CapabilityPathAuthorityDecl {
    capability_id: TRANSLATE_CAP.into(),
    endpoint_id: PROXY_ENDPOINT_ID.into(),
    method: HttpMethod::Post,
    path: DeclaredPathAuthority::InstanceConfiguredRelativePath {
      config_field: PROXY_CONFIG_FIELD.into(),
    },
    allowed_query_names: Vec::new(),
    allowed_header_names: Vec::new(),
    auth_policy_id: Some(HOST_NONE_AUTH_POLICY.into()),
  }
}

fn seed_instance(db: &Database, catalog: &PluginCatalog, config_json: &str, package_digest: &str) -> Uuid {
  let loaded = catalog
    .snapshot(package_digest)
    .expect("seeded instance requires catalog content");
  let id = new_id();
  let now = now_rfc3339();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id,
        plugin_id: PLUGIN_ID.into(),
        plugin_version: loaded.descriptor.version.clone(),
        display_name: "Google Web".into(),
        enabled: true,
        config_json: config_json.into(),
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
        last_validated_at: None,
        last_error_code: None,
        runtime_kind: "wasm-component".into(),
        package_digest: Some(package_digest.into()),
        execution_grant_set_revision: None,
        runtime_state: InstanceRuntimeState::PendingActivation.as_str().into(),
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

/// Preview and apply one exact content digest, exactly like the user-approved upgrade path.
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

fn ctx(id: Uuid, rid: &str, cap: &str) -> ExecutionContext {
  ExecutionContext {
    request_id: rid.into(),
    cancel: CancelToken::new(),
    deadline: None,
    integration_instance_id: id,
    plugin_id: PLUGIN_ID.into(),
    capability_id: cap.into(),
    provider_attempt: crate::domain::service_capability::ProviderAttemptTracker::new(),
  }
}

fn integration_write(config_json: &str, instance_id: Option<Uuid>) -> IntegrationInstanceWrite {
  IntegrationInstanceWrite {
    id: instance_id,
    plugin_id: PLUGIN_ID.into(),
    display_name: "Google Web".into(),
    enabled: true,
    config_json: config_json.into(),
    credentials: vec![],
    expected_updated_at: None,
    endpoint_trust_preview_id: None,
    acknowledge_endpoint_trust: false,
  }
}

fn instance_grant(db: &Database, instance_id: Uuid) -> ExecutionGrantSetBundle {
  db.read(|conn| {
    let instance = integration_instances::get(conn, instance_id)?;
    plugin_permission_grants::get_bundle_for_subject_package_revision(
      conn,
      crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
      instance_id,
      instance.package_digest.as_deref().expect("activated package digest"),
      instance.execution_grant_set_revision.expect("activated grant revision"),
    )
  })
  .unwrap()
}

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

/// Recompute the canonical authority digest of one persisted grant bundle.
fn rehash_grant_bundle_authority(bundle: &ExecutionGrantSetBundle) -> String {
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
      NetworkGrantEntry::with_mode_origin_and_response_modes_and_base_url(
        CapabilityId::parse(&entry.capability_id).expect("valid test grant capability"),
        EndpointId::parse(&entry.endpoint_id).expect("valid test grant endpoint"),
        HttpsOrigin::parse(&entry.origin).expect("valid test grant origin"),
        NetworkOriginKind::parse(&entry.origin_kind).expect("valid test grant origin kind"),
        entry.base_url.clone(),
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
        crate::domain::plugin_resource::NetworkResponseBodyModes::parse(&entry.response_body_modes)
          .expect("valid test grant response body modes"),
      )
    })
    .collect::<Vec<_>>();
  crate::domain::runtime_plugin::compute_authority_digest(&capabilities, &network, &[])
    .as_str()
    .to_string()
}

/// Mutate a persisted canonical header and write an authority digest recomputed from its unchanged
/// children. This models a database attacker who knows the child hashing format but cannot alter
/// the catalog content the pin resolves to.
fn tamper_grant_header_and_rehash(
  db: &Database,
  instance_id: Uuid,
  field: GrantHeaderField,
  tampered_value: &str,
) -> String {
  db.transaction(|uow| {
    let instance = integration_instances::get(uow.conn(), instance_id)?;
    let mut bundle = plugin_permission_grants::get_bundle_for_subject_package_revision(
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

/// Mutate one persisted network grant origin and write an authority digest recomputed from the
/// mutated children. Models a database attacker who can rehash but cannot change the catalog.
fn tamper_grant_network_origin_and_rehash(
  db: &Database,
  instance_id: Uuid,
  endpoint_id: &str,
  tampered_origin: &str,
) -> String {
  db.transaction(|uow| {
    let instance = integration_instances::get(uow.conn(), instance_id)?;
    let mut bundle = plugin_permission_grants::get_bundle_for_subject_package_revision(
      uow.conn(),
      crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
      instance_id,
      instance.package_digest.as_deref().expect("activated package digest"),
      instance.execution_grant_set_revision.expect("activated grant revision"),
    )?;
    let entry = bundle
      .network
      .iter_mut()
      .find(|entry| entry.endpoint_id == endpoint_id)
      .expect("target network grant entry");
    let entry_id = entry.id;
    entry.origin = tampered_origin.into();
    let rehashed = rehash_grant_bundle_authority(&bundle);
    assert_ne!(
      rehashed, bundle.header.authority_digest,
      "mutated origin must change the authority digest"
    );
    uow.conn().execute(
      "UPDATE execution_grant_network_entries SET origin = ?1 WHERE id = ?2",
      rusqlite::params![tampered_origin, entry_id.to_string()],
    )?;
    uow.conn().execute(
      "UPDATE execution_grant_sets SET authority_digest = ?1 WHERE id = ?2",
      rusqlite::params![&rehashed, bundle.header.id.to_string()],
    )?;
    Ok::<_, StorageError>(rehashed)
  })
  .unwrap()
}

/// Overwrite one immutable snapshot file with same-length tampered bytes.
fn tamper_snapshot_file(snapshot_dir: &Path, relative: &str) {
  let path = snapshot_dir.join(relative);
  let original = std::fs::read(&path).unwrap_or_else(|error| panic!("read snapshot {}: {error}", path.display()));
  let mut tampered = original.clone();
  let last = tampered.len() - 1;
  tampered[last] ^= 0xFF;
  let mut permissions = std::fs::metadata(&path).unwrap().permissions();
  permissions.set_readonly(false);
  std::fs::set_permissions(&path, permissions).unwrap();
  std::fs::write(&path, &tampered).unwrap();
  assert_eq!(
    tampered.len(),
    original.len(),
    "tampered artifact must keep the indexed length so the digest check is the rejection reason"
  );
}

#[test]
fn google_translate_web_runtime_gtx_translate_and_detect() {
  let (fixture, transport) = Fixture::capture();
  let digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  activate(&fixture.lifecycle, id, &digest);

  // Translate via Wasm: capture transport returns the GTX fixture.
  *transport.response.lock().unwrap() = Ok(text_response(
    r#"[[["Hello ","你好",null,null,10],["world 🌍","世界 🌍",null,null,10]],null,"zh"]"#,
  ));
  let translate = fixture
    .caps
    .resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec())
    .unwrap();
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
  let detect = fixture.caps.resolve_detect(id, DETECT_CAP, b"{}".to_vec()).unwrap();
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
  let (fixture, blocking) = Fixture::blocking();
  let digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  activate(&fixture.lifecycle, id, &digest);

  // Cancel AFTER the transport is in flight (not pre-cancelled). A spawned task waits for the
  // blocking transport's start signal, then cancels; the host's broker-fetch select must drop
  // the in-flight transport future (transport stop) and surface Cancelled.
  let cancel = CancelToken::new();
  let cancel_for_task = cancel.clone();
  let started = blocking.started.clone();
  let dropped = blocking.dropped.clone();
  let translate = fixture
    .caps
    .resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec())
    .unwrap();
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
          provider_attempt: crate::domain::service_capability::ProviderAttemptTracker::new(),
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
  let (fixture, transport) = Fixture::capture();
  let digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  activate(&fixture.lifecycle, id, &digest);
  *transport.response.lock().unwrap() = Ok(BoundedHttpResponse {
    status: 429,
    headers: HashMap::new(),
    body: b"{}".to_vec(),
  });
  let translate = fixture
    .caps
    .resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec())
    .unwrap();
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
  let (fixture, transport) = Fixture::capture();
  let digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  activate(&fixture.lifecycle, id, &digest);
  *transport.response.lock().unwrap() = Ok(text_response(r#"{"not":"array"}"#));
  let translate = fixture
    .caps
    .resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec())
    .unwrap();
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
  let (fixture, transport) = Fixture::capture();
  let digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  activate(&fixture.lifecycle, id, &digest);
  // A transport failure surfaces as a network error; the router never falls back to Bundled Rust.
  *transport.response.lock().unwrap() = Err("network unreachable".into());
  let translate = fixture
    .caps
    .resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec())
    .unwrap();
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
  let (fixture, blocking) = Fixture::blocking();
  let digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  activate(&fixture.lifecycle, id, &digest);

  // A real host deadline (not a string-matched transport error) drives the timeout. The blocking
  // transport stays in flight; the host broker-fetch select fires the deadline and drops the
  // in-flight transport future (transport stop).
  let dropped = blocking.dropped.clone();
  let translate = fixture
    .caps
    .resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec())
    .unwrap();
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
          provider_attempt: crate::domain::service_capability::ProviderAttemptTracker::new(),
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

/// A rehashed grant-origin tamper must fail closed: the catalog manifest is the authority for
/// static origins, so a database attacker cannot widen egress authority. The fixture adds one
/// static third-party endpoint to prove the manifest-bound check, not just the host GTX tuple.
#[test]
fn runtime_router_rejects_rehashed_user_signed_static_origin_tamper() {
  let (fixture, transport) = Fixture::capture();
  let variant = ContentVariant::from_catalog(&fixture.catalog, STATIC_ENDPOINT_FIXTURE_VERSION)
    .with_network_endpoint(NetworkEndpointRequest {
      id: THIRD_PARTY_STATIC_ENDPOINT_ID.into(),
      origins: vec![THIRD_PARTY_STATIC_MANIFEST_ORIGIN.into()],
      methods: vec![HttpMethod::Get],
      instance_origin_config_field: None,
    })
    .with_path_authority(CapabilityPathAuthorityDecl {
      capability_id: TRANSLATE_CAP.into(),
      endpoint_id: THIRD_PARTY_STATIC_ENDPOINT_ID.into(),
      method: HttpMethod::Get,
      path: DeclaredPathAuthority::Exact {
        value: "translate_a/single".into(),
      },
      allowed_query_names: Vec::new(),
      allowed_header_names: Vec::new(),
      auth_policy_id: Some(HOST_NONE_AUTH_POLICY.into()),
    });
  let digest = variant.add_to(&fixture.catalog);

  let instance_id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  activate(&fixture.lifecycle, instance_id, &digest);
  let profile_id = seed_translate_profile(&fixture.db, instance_id);
  let control = fixture
    .caps
    .resolve_translate(instance_id, TRANSLATE_CAP, EMPTY_PREFERENCES_JSON.to_vec())
    .expect("verified static endpoint grant resolves before tampering");
  block_on(control.translate(
    instance_id,
    TranslateTextRequest {
      text: "control".into(),
      source_language_id: TEST_PROFILE_SOURCE_LANGUAGE.into(),
      target_language_id: TEST_PROFILE_TARGET_LANGUAGE.into(),
    },
    ctx(instance_id, "req-static-origin-control", TRANSLATE_CAP),
  ))
  .expect("verified static endpoint executes before tampering");
  assert_eq!(transport.call_count(), EXPECTED_CONTROL_WASM_REQUESTS);
  transport.reset();
  let control_snapshot = fixture
    .caps
    .load_profile_invocation_snapshot(profile_id, ProfileCapabilityKind::Translate)
    .expect("verified static endpoint snapshot loads before tampering");
  fixture
    .caps
    .resolve_translate_from_snapshot(&control_snapshot)
    .expect("verified static endpoint snapshot resolves before tampering");

  let grant = instance_grant(&fixture.db, instance_id);
  let entry = grant
    .network
    .iter()
    .find(|entry| entry.endpoint_id == THIRD_PARTY_STATIC_ENDPOINT_ID)
    .expect("third-party static grant entry");
  assert_eq!(entry.origin, THIRD_PARTY_STATIC_MANIFEST_ORIGIN);
  assert_eq!(entry.origin_kind, NetworkOriginKind::InstanceConfigured.as_str());
  let rehashed_authority_digest = tamper_grant_network_origin_and_rehash(
    &fixture.db,
    instance_id,
    THIRD_PARTY_STATIC_ENDPOINT_ID,
    TAMPERED_PUBLIC_HTTPS_ORIGIN,
  );
  let persisted_authority_digest = instance_grant(&fixture.db, instance_id).header.authority_digest;
  assert_eq!(persisted_authority_digest, rehashed_authority_digest);

  let error = match fixture
    .caps
    .resolve_translate(instance_id, TRANSLATE_CAP, EMPTY_PREFERENCES_JSON.to_vec())
  {
    Ok(_) => panic!("rehashed static origin tamper must fail before runtime resolution"),
    Err(error) => error,
  };
  assert_eq!(error.code, CapabilityErrorCode::PermissionDenied);
  let tampered_snapshot = fixture
    .caps
    .load_profile_invocation_snapshot(profile_id, ProfileCapabilityKind::Translate)
    .expect("tampered profile snapshot loads for runtime validation");
  let snapshot_error = match fixture.caps.resolve_translate_from_snapshot(&tampered_snapshot) {
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
    let (fixture, transport) = Fixture::capture();
    let package_digest = fixture.digest();
    let instance_id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &package_digest);
    activate(&fixture.lifecycle, instance_id, &package_digest);
    let profile_id = seed_translate_profile(&fixture.db, instance_id);

    // First execute real Wasm through the capture transport, proving the negative assertion below
    // is not a vacuous resolver-only test.
    let control = fixture
      .caps
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

    let rehashed_authority_digest = tamper_grant_header_and_rehash(&fixture.db, instance_id, field, tampered_value);
    let persisted_authority_digest = instance_grant(&fixture.db, instance_id).header.authority_digest;
    assert_eq!(persisted_authority_digest, rehashed_authority_digest);

    let direct_error = match fixture
      .caps
      .resolve_translate(instance_id, TRANSLATE_CAP, EMPTY_PREFERENCES_JSON.to_vec())
    {
      Ok(_) => panic!("direct runtime resolution must reject rehashed canonical header tampering"),
      Err(error) => error,
    };
    assert_eq!(
      direct_error.code,
      CapabilityErrorCode::PermissionDenied,
      "direct resolver must reject tampered {} before constructing a principal",
      field.label()
    );

    let tampered_snapshot = fixture
      .caps
      .load_profile_invocation_snapshot(profile_id, ProfileCapabilityKind::Translate)
      .expect("tampered profile snapshot loads for runtime validation");
    let snapshot_error = match fixture.caps.resolve_translate_from_snapshot(&tampered_snapshot) {
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

/// Replacing the source archive after approval must never change what the approved pin resolves
/// to. The replacement package is structurally valid with the same plugin id and version, so the
/// only defense is digest-addressed content identity: the pinned digest disappears and the
/// runtime fails closed instead of executing the new bytes.
#[test]
fn runtime_rejects_archive_replaced_after_activation_before_execution() {
  let (fixture, transport) = Fixture::capture();
  let pinned_digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &pinned_digest);
  activate(&fixture.lifecycle, id, &pinned_digest);

  let replacement_digest = ContentVariant::from_catalog(&fixture.catalog, "1.0.0")
    .set_file(REPLACED_LOCALE_PATH, FileRole::Locale, REPLACED_LOCALE_BYTES)
    .replace_builtin_archive(&fixture.catalog);
  assert_ne!(
    replacement_digest, pinned_digest,
    "replacement content must have a different content identity"
  );
  assert!(
    fixture.catalog.snapshot_optional(&replacement_digest).is_some(),
    "the replacement archive must load as catalog content"
  );
  assert!(
    fixture.catalog.snapshot_optional(&pinned_digest).is_none(),
    "the approved digest must no longer resolve after the source archive is replaced"
  );

  let err = match fixture.caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()) {
    Ok(_) => panic!("replaced archive must be rejected before runtime resolution"),
    Err(err) => err,
  };
  assert_eq!(err.code, CapabilityErrorCode::PluginUnavailable);
  assert!(
    transport.last.lock().unwrap().is_none(),
    "replacement bytes must never reach guest execution or its network broker"
  );
}

/// Replacing a materialized snapshot artifact after approval must fail the runtime's artifact
/// digest check. The tampered bytes keep the indexed length, so the rejection reason is the
/// content hash, not a size mismatch.
#[test]
fn runtime_rejects_artifact_replaced_after_activation_before_execution() {
  let (fixture, transport) = Fixture::capture();
  let digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  activate(&fixture.lifecycle, id, &digest);

  let snapshot = fixture
    .catalog
    .snapshot(&digest)
    .expect("pinned content resolves before tampering");
  tamper_snapshot_file(&snapshot.snapshot_dir, TRANSLATE_ARTIFACT_PATH);
  assert!(
    fixture.catalog.snapshot_optional(&digest).is_some(),
    "catalog identity is unchanged; only the runtime artifact digest check can reject"
  );

  let err = match fixture.caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()) {
    Ok(_) => panic!("tampered artifact must be rejected before runtime resolution"),
    Err(err) => err,
  };
  assert_eq!(err.code, CapabilityErrorCode::PluginUnavailable);
  assert!(
    err.message.contains("component compile failed") && err.message.contains("digest mismatch"),
    "the artifact digest check must reject the replacement: {err:?}"
  );
  assert!(
    transport.last.lock().unwrap().is_none(),
    "rejected artifact bytes must never reach guest execution or its network broker"
  );
}

/// An archive-only replacement after the profile snapshot was loaded must fail closed in both the
/// snapshot reload and the snapshot resolve paths: the pinned digest is gone from the catalog.
#[test]
fn runtime_snapshot_recheck_rejects_archive_only_replacement_after_archive_verification() {
  let (fixture, transport) = Fixture::capture();
  let pinned_digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &pinned_digest);
  activate(&fixture.lifecycle, id, &pinned_digest);
  let profile_id = seed_translate_profile(&fixture.db, id);
  let snapshot = fixture
    .caps
    .load_profile_invocation_snapshot(profile_id, ProfileCapabilityKind::Translate)
    .expect("profile snapshot loads before replacement");
  fixture
    .caps
    .resolve_translate_from_snapshot(&snapshot)
    .expect("snapshot resolves before replacement");

  let replacement_digest = ContentVariant::from_catalog(&fixture.catalog, "1.0.0")
    .set_file(REPLACED_LOCALE_PATH, FileRole::Locale, REPLACED_LOCALE_BYTES)
    .replace_builtin_archive(&fixture.catalog);
  assert_ne!(replacement_digest, pinned_digest);
  assert!(
    fixture.catalog.snapshot_optional(&pinned_digest).is_none(),
    "archive-only replacement must retire the approved digest"
  );

  let reload_error = match fixture
    .caps
    .load_profile_invocation_snapshot(profile_id, ProfileCapabilityKind::Translate)
  {
    Ok(_) => panic!("snapshot reload must fail closed when the pinned digest is gone"),
    Err(error) => error,
  };
  assert!(
    matches!(
      reload_error,
      crate::services::service_capabilities::ProfileSnapshotLoadError::PluginUnavailable(_)
    ),
    "reload must report the pin as unavailable: {reload_error:?}"
  );
  let resolve_error = match fixture.caps.resolve_translate_from_snapshot(&snapshot) {
    Ok(_) => panic!("snapshot resolve must fail closed when the pinned digest is gone"),
    Err(error) => error,
  };
  assert_eq!(resolve_error.code, CapabilityErrorCode::PluginUnavailable);
  assert_eq!(
    transport.call_count(),
    NO_TRANSPORT_REQUESTS,
    "archive-only replacement bytes must never reach guest execution or its network broker"
  );
}

/// Replacing materialized content after the profile snapshot was verified must fail closed in the
/// snapshot resolve path even though the catalog identity is unchanged.
#[test]
fn runtime_snapshot_recheck_rejects_replacement_after_archive_verification() {
  let (fixture, transport) = Fixture::capture();
  let digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  activate(&fixture.lifecycle, id, &digest);
  let profile_id = seed_translate_profile(&fixture.db, id);
  let snapshot = fixture
    .caps
    .load_profile_invocation_snapshot(profile_id, ProfileCapabilityKind::Translate)
    .expect("profile snapshot loads before replacement");
  fixture
    .caps
    .resolve_translate_from_snapshot(&snapshot)
    .expect("snapshot resolves before replacement");

  let loaded = fixture
    .catalog
    .snapshot(&digest)
    .expect("pinned content resolves before tampering");
  tamper_snapshot_file(&loaded.snapshot_dir, TRANSLATE_ARTIFACT_PATH);
  assert!(
    fixture.catalog.snapshot_optional(&digest).is_some(),
    "catalog identity is unchanged; the runtime artifact digest check is the guard"
  );

  let err = match fixture.caps.resolve_translate_from_snapshot(&snapshot) {
    Ok(_) => panic!("post-snapshot replacement must be rejected before runtime resolution"),
    Err(err) => err,
  };
  assert_eq!(err.code, CapabilityErrorCode::PluginUnavailable);
  assert!(
    err.message.contains("component compile failed") && err.message.contains("digest mismatch"),
    "post-snapshot artifact digest check must reject the replacement: {err:?}"
  );
  assert_eq!(
    transport.call_count(),
    NO_TRANSPORT_REQUESTS,
    "post-snapshot replacement bytes must never reach guest execution or its network broker"
  );
}

#[test]
fn google_translate_web_runtime_bundled_rollback_remains_available() {
  let (fixture, _transport) = Fixture::capture();
  let digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  // Before activation the instance is pinned but not active.
  let before = fixture.db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(before.runtime_kind, "wasm-component");
  assert_eq!(before.runtime_state, InstanceRuntimeState::PendingActivation.as_str());
  // After activation it is Wasm; rolling back restores the pre-activation identity.
  activate(&fixture.lifecycle, id, &digest);
  let activated = fixture.db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(activated.runtime_kind, "wasm-component");
  assert_eq!(activated.runtime_state, InstanceRuntimeState::Active.as_str());
  let rb = fixture.lifecycle.preview_rollback(id).unwrap();
  fixture
    .lifecycle
    .apply_rollback(crate::domain::runtime_lifecycle::ApplyRuntimeRollbackInput {
      preview_id: rb.preview_id,
    })
    .unwrap();
  let restored = fixture.db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(restored.runtime_kind, "wasm-component");
  assert_eq!(restored.package_digest.as_deref(), Some(digest.as_str()));
  assert!(restored.execution_grant_set_revision.is_none());
}

#[test]
fn google_translate_web_proxy_package_keeps_gtx_without_proxy_grant() {
  let (fixture, transport) = Fixture::capture_with_proxy();
  let digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  activate(&fixture.lifecycle, id, &digest);

  let grant = instance_grant(&fixture.db, id);
  assert!(
    !grant.network.iter().any(|entry| entry.endpoint_id == PROXY_ENDPOINT_ID),
    "a gtx-channel instance must not be granted the hidden proxy endpoint"
  );

  *transport.response.lock().unwrap() = Ok(text_response(r#"[[["Hello","你好",null,null,1]],null,"zh"]"#));
  let translate = fixture
    .caps
    .resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec())
    .unwrap();
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
  let (fixture, transport) = Fixture::capture_with_proxy();
  let digest = fixture.digest();
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"https_proxy"}"#, &digest);
  activate(&fixture.lifecycle, id, &digest);

  let instance = fixture.db.read(|conn| integration_instances::get(conn, id)).unwrap();
  let config: serde_json::Value = serde_json::from_str(&instance.config_json).unwrap();
  assert_eq!(
    config.get(PROXY_CONFIG_FIELD).and_then(serde_json::Value::as_str),
    Some(GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL)
  );

  *transport.response.lock().unwrap() = Ok(text_response(r#"{"data":"Hello"}"#));
  let translate = fixture
    .caps
    .resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec())
    .unwrap();
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
  let prepared = prepared.as_ref().unwrap();
  // The host resolves the instance-configured endpoint from the normalized default URL, never
  // from GTX, and classifies it as public internet egress. The configured path appears exactly
  // once: the guest supplies it as the request path and the resolved base is the origin only.
  assert_eq!(
    prepared.url.as_str(),
    GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL,
    "the configured proxy path must not be appended twice"
  );
  assert!(!prepared.url.as_str().starts_with(GTX_ORIGIN));
  assert_eq!(prepared.destination_policy, DestinationPolicy::PublicInternet);
}

#[test]
fn google_translate_web_proxy_channel_translates_and_detect_stays_on_gtx() {
  let (fixture, transport) = Fixture::capture_with_proxy();
  let digest = fixture.digest();
  let id = seed_instance(
    &fixture.db,
    &fixture.catalog,
    r#"{"channel":"https_proxy","proxy-url":"https://proxy-a.example/v1/custom"}"#,
    &digest,
  );
  activate(&fixture.lifecycle, id, &digest);

  // Translate via the HTTPS proxy channel: capture transport returns the proxy `{data}` body.
  *transport.response.lock().unwrap() = Ok(text_response(r#"{"data":"Hello"}"#));
  let translate = fixture
    .caps
    .resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec())
    .unwrap();
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
  assert_eq!(
    prepared.url.as_str(),
    "https://proxy-a.example/v1/custom",
    "the proxy request must use the approved configured URL exactly once: {}",
    prepared.url
  );
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
  let detect = fixture.caps.resolve_detect(id, DETECT_CAP, b"{}".to_vec()).unwrap();
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
  let (fixture, _transport) = Fixture::capture_with_proxy();
  let digest = fixture.digest();
  let id = seed_instance(
    &fixture.db,
    &fixture.catalog,
    r#"{"channel":"https_proxy","proxy-url":"https://proxy-a.example/translate"}"#,
    &digest,
  );
  activate(&fixture.lifecycle, id, &digest);

  // The approved grant persisted the proxy-a origin for the https-proxy endpoint.
  let grant_origin_a = instance_grant(&fixture.db, id)
    .network
    .into_iter()
    .find(|entry| entry.endpoint_id == PROXY_ENDPOINT_ID)
    .map(|entry| entry.origin)
    .unwrap_or_default();
  assert_eq!(grant_origin_a, "https://proxy-a.example");

  // Change the proxy URL in config without re-approving. The persisted grant origin is stale:
  // the approved effective origin stays proxy-a (the grant is immutable), proving the URL
  // change is NOT trusted from mutable config and requires a new explicit grant (re-activation).
  let now = crate::domain::time::now_rfc3339();
  fixture
    .db
    .transaction(|uow| {
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

  let grant_origin_after = instance_grant(&fixture.db, id)
    .network
    .into_iter()
    .find(|entry| entry.endpoint_id == PROXY_ENDPOINT_ID)
    .map(|entry| entry.origin)
    .unwrap_or_default();
  assert_eq!(
    grant_origin_after, "https://proxy-a.example",
    "approved grant origin must be immutable; URL change requires a new grant"
  );

  let stale_err = fixture
    .caps
    .resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec())
    .err()
    .expect("stale configured origin must not execute");
  assert_eq!(stale_err.code, CapabilityErrorCode::PermissionDenied);

  let preview = fixture.lifecycle.preview_upgrade(id, &digest).unwrap();
  assert!(preview.requires_permission_approval);
  assert!(preview.permission_differences.iter().any(|difference| {
    difference.kind == "network_endpoint_added" && difference.origin.as_deref() == Some("https://proxy-b.example")
  }));
  let denied = fixture
    .lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: false,
    })
    .unwrap_err();
  assert!(matches!(denied, crate::error::StorageError::Validation(_)));

  let approved = fixture.lifecycle.preview_upgrade(id, &digest).unwrap();
  fixture
    .lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: approved.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let grant_origin_b = instance_grant(&fixture.db, id)
    .network
    .into_iter()
    .find(|entry| entry.endpoint_id == PROXY_ENDPOINT_ID)
    .map(|entry| entry.origin)
    .unwrap_or_default();
  assert_eq!(grant_origin_b, "https://proxy-b.example");
}

#[test]
fn google_web_migration_rejects_incompatible_capability_major() {
  let (fixture, _transport) = Fixture::capture();
  // Standard GTX content (compatible: translate.text@1 + translate.detect@1).
  let digest_ok = fixture.digest();
  // Migration-incompatible content drops translate.detect@1. The host supports translate.text@1
  // alone, so the package is loadable; migration must still fail closed because the instance
  // exposes translate.detect@1 and dropping it would sever profile bindings.
  let digest_bad = ContentVariant::from_catalog(&fixture.catalog, MIGRATION_DROP_DETECT_VERSION)
    .without_capability(DETECT_CAP)
    .add_to(&fixture.catalog);
  assert_ne!(digest_ok, digest_bad);

  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest_ok);
  activate(&fixture.lifecycle, id, &digest_ok);
  // Compatible migration previews successfully (both source majors present in target).
  let preview = fixture.lifecycle.preview_upgrade(id, &digest_ok).unwrap();
  assert!(
    preview
      .capability_compatibility
      .iter()
      .any(|c| c.capability_id == TRANSLATE_CAP)
  );

  // Dropping translate.detect@1 fails closed at preview: never offer a migration that would
  // sever the instance/profile binding to a capability major the source exposes.
  let err = fixture.lifecycle.preview_upgrade(id, &digest_bad).unwrap_err();
  assert!(
    matches!(&err, StorageError::Validation(msg) if msg.contains(DETECT_CAP)),
    "expected fail-closed validation error for missing major, got {err:?}"
  );
}

#[test]
fn google_web_migration_rejects_schema_incompatible_target() {
  let (fixture, _transport) = Fixture::capture();
  // Target schema only accepts the https_proxy channel, so the bundled GTX config cannot be
  // migrated. The same schema version (1) means no migration component is required, so the
  // migrated config must validate against the target schema - it does not, so fail closed.
  let digest = ContentVariant::from_catalog(&fixture.catalog, MIGRATION_INCOMPATIBLE_SCHEMA_VERSION)
    .set_config_schema(CONFIG_SCHEMA_PATH, INCOMPATIBLE_CONFIG_SCHEMA)
    .add_to(&fixture.catalog);
  let id = seed_instance(&fixture.db, &fixture.catalog, r#"{"channel":"gtx"}"#, &digest);
  let err = fixture.lifecycle.preview_upgrade(id, &digest).unwrap_err();
  assert!(
    matches!(&err, StorageError::Validation(message) if message.contains("channel")),
    "expected fail-closed validation error for schema-incompatible target, got {err:?}"
  );
}

/// Package-only semantics: with no catalog default content wired, a new instance FAILS CLOSED
/// instead of falling back to a bundled executor, and no row is written.
#[test]
fn google_web_new_instance_rejects_create_when_no_default_package() {
  let (fixture, _transport) = Fixture::capture();
  let vault: Arc<dyn crate::credentials::CredentialVault> =
    Arc::new(crate::credentials::MemoryCredentialVault::default());
  let tokens = token_service(&fixture.db, vault.clone());
  let integrations = ServiceIntegrationService::new(fixture.db.clone(), vault, fixture.registry.clone(), tokens)
    .with_runtime_lifecycle(fixture.lifecycle.clone());

  let before = fixture
    .db
    .read(|conn| Ok::<usize, crate::error::StorageError>(integration_instances::list(conn)?.len()))
    .unwrap();
  let error = integrations
    .save(integration_write(r#"{"channel":"gtx"}"#, None))
    .expect_err("create without catalog default content must fail closed");
  assert!(
    matches!(&error, StorageError::Validation(message) if message.contains("installed plugin package")),
    "got {error}"
  );
  let after = fixture
    .db
    .read(|conn| Ok::<usize, crate::error::StorageError>(integration_instances::list(conn)?.len()))
    .unwrap();
  assert_eq!(after, before, "no row may be written by a failed package-first create");
}
