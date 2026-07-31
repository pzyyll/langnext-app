// ABOUTME: Phase 2 runtime adversarial and conformance tests split into wasm_bindings,
// ABOUTME: wasm_limits, wasm_host_imports, and wasm_executor modules.
// Each module maps to a `mise run test wasm_*` command and runs substantive tests.
#![cfg(test)]

use crate::domain::cancel::CancelToken;
use crate::domain::runtime_plugin::{
  AuthPolicyId, CAPABILITY_MAJOR_V1, CAPABILITY_SPECS, CAPABILITY_V1_COUNT, CapabilityId, ComponentArtifactDigest,
  EndpointId, ExecutionGrantSet, FileRole, HOST_PLUGIN_API_VERSION_MAJOR, HttpMethod, HttpsOrigin, NetworkGrantEntry,
  PackageDigest, PackageIdentity, PluginId, PluginPrincipal, ResourceLimits, RuntimeIdentity, SemVerVersion,
};
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, DetectLanguageRequest, ExecutionContext, TranslateTextRequest,
};
use crate::services::runtime_plugin_contracts::{parse_manifest, validate_manifest};
use crate::services::service_capabilities::{DetectLanguageCapability, TranslateTextCapability};
use crate::services::wasm_runtime::errors::{map_instantiate_error, map_wasmtime_error};
use crate::services::wasm_runtime::executor::{
  WasmDetectLanguageAdapter, WasmTranslateTextAdapter, compute_sha256_hex, principal_from_context,
};
use crate::services::wasm_runtime::host::{
  BrokerAuthorization, BrokerFetchError, BrokerFetchOutcome, BrokerFetchRequest, BrokerFetchResponse, BrokerHandle,
  BrokerResponseBody, NeutralLogLevel,
};
use crate::services::wasm_runtime::store::{build_store, new_state, new_state_with_fuel};
use crate::services::wasm_runtime::{WasmRuntime, bindings};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;
use wasmtime::component::HasSelf;

use crate::services::wasm_runtime::store::PluginHostState;

const CONFORMANCE_WASM: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-component/fixtures/langnext-conformance-wasm.wasm"
));

const CONFORMANCE_DETECT_WASM: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-detect-component/fixtures/langnext-conformance-detect-wasm.wasm"
));

/// Synthetic package-archive digest for the translate conformance package. Distinct from the
/// Component artifact digest: package digest is the signed `.lnplugin` archive identity.
const CONFORMANCE_PACKAGE_DIGEST_HEX: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/// Synthetic package-archive digest for the detect conformance package.
const CONFORMANCE_DETECT_PACKAGE_DIGEST_HEX: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/// Committed Component artifact digest for the translate fixture (file-index sha256).
const CONFORMANCE_ARTIFACT_DIGEST_HEX: &str = "0552022658d9cdd88cfd277cca46344a086e6f48da648cae16571a3d7e45a892";
/// Committed Component artifact digest for the detect fixture (file-index sha256).
const CONFORMANCE_DETECT_ARTIFACT_DIGEST_HEX: &str = "11f70810a2e25add888be750ee019d9f98311b4bcb682a780b3419d130ed37d0";
/// Conformance plugin ids declared in committed plugin.json manifests.
const CONFORMANCE_PLUGIN_ID: &str = "langnext.conformance";
const CONFORMANCE_DETECT_PLUGIN_ID: &str = "langnext.conformance.detect";
const CONFORMANCE_PLUGIN_VERSION: &str = "0.1.0";
const CONFORMANCE_ORIGIN: &str = "https://conformance.example";
const CONFORMANCE_AUTH_POLICY: &str = "host.none.v1";
const CONFORMANCE_CAPABILITY_TEXT: &str = "translate.text@1";
const CONFORMANCE_CAPABILITY_DETECT: &str = "translate.detect@1";
/// Oversized table element count used by the oversized-table rejection fixture.
const OVERSIZED_TABLE_ELEMENTS: u32 = 20_000;
/// Minimum linear-memory pages used by the oversized-memory rejection fixture (257 * 64KiB > 16MiB).
const OVERSIZED_MEMORY_MIN_PAGES: u32 = 257;

const CONFORMANCE_PLUGIN_JSON: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-component/plugin.json"
));
const CONFORMANCE_DETECT_PLUGIN_JSON: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-detect-component/plugin.json"
));

/// Committed conformance mode manifest: mode -> expected text/error. Read by the fixture-driven
/// executor test so coverage is auditable from a committed file.
const CONFORMANCE_MODES_JSON: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-component/tests/fixtures/conformance-modes.json"
));

const CONFORMANCE_DETECT_MODES_JSON: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-detect-component/tests/fixtures/conformance-modes.json"
));

/// Committed static WAT fixture for the undeclared-import conformance test.
const UNDECLARED_IMPORT_WAT: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-component/tests/fixtures/undeclared-import.wat"
));

fn conformance_package_digest() -> PackageDigest {
  PackageDigest::parse(CONFORMANCE_PACKAGE_DIGEST_HEX).unwrap()
}

fn conformance_detect_package_digest() -> PackageDigest {
  PackageDigest::parse(CONFORMANCE_DETECT_PACKAGE_DIGEST_HEX).unwrap()
}

fn conformance_artifact_digest() -> ComponentArtifactDigest {
  ComponentArtifactDigest::parse(CONFORMANCE_ARTIFACT_DIGEST_HEX).unwrap()
}

fn conformance_detect_artifact_digest() -> ComponentArtifactDigest {
  ComponentArtifactDigest::parse(CONFORMANCE_DETECT_ARTIFACT_DIGEST_HEX).unwrap()
}

fn package_identity(digest: PackageDigest) -> RuntimeIdentity {
  RuntimeIdentity::Package(PackageIdentity { package_digest: digest })
}

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/// Build a principal + grant set that grants `translate.text@1` and network entries for the
/// conformance endpoints. `approved`, `slow`, and `wait-cancel` are granted; `denied` is absent.
/// Identity is `RuntimeIdentity::Package` with the translate package digest.
fn conformance_principal_grant() -> (PluginPrincipal, ExecutionGrantSet) {
  conformance_principal_grant_for(
    CONFORMANCE_CAPABILITY_TEXT,
    CONFORMANCE_PLUGIN_ID,
    conformance_package_digest(),
    true,
  )
}

/// Build a principal + grant set for a specific capability. Detect uses its own package digest
/// and plugin id; text uses the translate package. Network endpoints are included only for the
/// translate capability (declared in plugin.json).
fn conformance_principal_grant_for_capability(capability_id: &str) -> (PluginPrincipal, ExecutionGrantSet) {
  if capability_id == CONFORMANCE_CAPABILITY_DETECT {
    conformance_principal_grant_for(
      CONFORMANCE_CAPABILITY_DETECT,
      CONFORMANCE_DETECT_PLUGIN_ID,
      conformance_detect_package_digest(),
      false,
    )
  } else {
    conformance_principal_grant_for(capability_id, CONFORMANCE_PLUGIN_ID, conformance_package_digest(), true)
  }
}

fn conformance_principal_grant_for(
  capability_id: &str,
  plugin_id: &str,
  package_digest: PackageDigest,
  with_network: bool,
) -> (PluginPrincipal, ExecutionGrantSet) {
  let cap = CapabilityId::parse(capability_id).unwrap();
  let network = if with_network {
    vec![
      NetworkGrantEntry::new(
        cap.clone(),
        EndpointId::parse("approved").unwrap(),
        HttpsOrigin::parse(CONFORMANCE_ORIGIN).unwrap(),
        HttpMethod::Get,
        AuthPolicyId::parse(CONFORMANCE_AUTH_POLICY).unwrap(),
        ResourceLimits::default(),
      ),
      NetworkGrantEntry::new(
        cap.clone(),
        EndpointId::parse("slow").unwrap(),
        HttpsOrigin::parse(CONFORMANCE_ORIGIN).unwrap(),
        HttpMethod::Get,
        AuthPolicyId::parse(CONFORMANCE_AUTH_POLICY).unwrap(),
        ResourceLimits::default(),
      ),
      NetworkGrantEntry::new(
        cap.clone(),
        EndpointId::parse("wait-cancel").unwrap(),
        HttpsOrigin::parse(CONFORMANCE_ORIGIN).unwrap(),
        HttpMethod::Get,
        AuthPolicyId::parse(CONFORMANCE_AUTH_POLICY).unwrap(),
        ResourceLimits::default(),
      ),
    ]
  } else {
    vec![]
  };
  let grant = ExecutionGrantSet::initial(
    Uuid::nil(),
    package_identity(package_digest),
    PluginId::parse(plugin_id).unwrap(),
    SemVerVersion::parse(CONFORMANCE_PLUGIN_VERSION).unwrap(),
    vec![cap],
    network,
    vec![],
  )
  .unwrap();
  let principal = grant.principal_for_request(capability_id, "req-conformance").unwrap();
  (principal, grant)
}

/// Formal manifest→grant closed loop: parse + validate the committed plugin.json, then build a
/// grant from the validated capability/network declarations. Synthetic package digest is the
/// Phase 2 stand-in for the signed archive digest (Phase 3 computes the real archive digest).
fn grant_from_validated_translate_manifest() -> ExecutionGrantSet {
  let parsed = parse_manifest(CONFORMANCE_PLUGIN_JSON).expect("translate plugin.json parses");
  let validated = validate_manifest(&parsed).expect("translate plugin.json validates");
  assert_eq!(validated.id(), CONFORMANCE_PLUGIN_ID);
  assert_eq!(validated.version(), CONFORMANCE_PLUGIN_VERSION);
  let caps: Vec<CapabilityId> = validated
    .capabilities()
    .iter()
    .map(|c| CapabilityId::parse(&c.id).expect("capability id"))
    .collect();
  assert_eq!(caps.len(), 1);
  assert_eq!(caps[0].as_str(), CONFORMANCE_CAPABILITY_TEXT);
  let runtime_artifact = validated
    .files()
    .iter()
    .find(|f| f.role == FileRole::RuntimeArtifact)
    .expect("runtime-artifact file entry");
  assert_eq!(runtime_artifact.sha256, CONFORMANCE_ARTIFACT_DIGEST_HEX);
  assert_eq!(
    validated.runtime().artifact.as_deref(),
    Some(runtime_artifact.path.as_str())
  );
  let network: Vec<NetworkGrantEntry> = validated
    .permissions()
    .network
    .iter()
    .map(|endpoint| {
      let origin = endpoint.origins.first().expect("origin");
      let method = *endpoint.methods.first().expect("method");
      NetworkGrantEntry::new(
        caps[0].clone(),
        EndpointId::parse(&endpoint.id).expect("endpoint id"),
        HttpsOrigin::parse(origin).expect("origin"),
        method,
        AuthPolicyId::parse(CONFORMANCE_AUTH_POLICY).expect("auth policy"),
        ResourceLimits::default(),
      )
    })
    .collect();
  assert_eq!(
    network.len(),
    3,
    "translate manifest must declare approved/slow/wait-cancel"
  );
  ExecutionGrantSet::initial(
    Uuid::nil(),
    package_identity(conformance_package_digest()),
    PluginId::parse(validated.id()).unwrap(),
    SemVerVersion::parse(validated.version()).unwrap(),
    caps,
    network,
    vec![],
  )
  .expect("grant from validated manifest")
}

fn grant_from_validated_detect_manifest() -> ExecutionGrantSet {
  let parsed = parse_manifest(CONFORMANCE_DETECT_PLUGIN_JSON).expect("detect plugin.json parses");
  let validated = validate_manifest(&parsed).expect("detect plugin.json validates");
  assert_eq!(validated.id(), CONFORMANCE_DETECT_PLUGIN_ID);
  let caps: Vec<CapabilityId> = validated
    .capabilities()
    .iter()
    .map(|c| CapabilityId::parse(&c.id).expect("capability id"))
    .collect();
  assert_eq!(caps[0].as_str(), CONFORMANCE_CAPABILITY_DETECT);
  let runtime_artifact = validated
    .files()
    .iter()
    .find(|f| f.role == FileRole::RuntimeArtifact)
    .expect("runtime-artifact file entry");
  assert_eq!(runtime_artifact.sha256, CONFORMANCE_DETECT_ARTIFACT_DIGEST_HEX);
  ExecutionGrantSet::initial(
    Uuid::nil(),
    package_identity(conformance_detect_package_digest()),
    PluginId::parse(validated.id()).unwrap(),
    SemVerVersion::parse(validated.version()).unwrap(),
    caps,
    vec![],
    vec![],
  )
  .expect("grant from validated detect manifest")
}

/// Conformance broker: dispatches by endpoint id. No live network; deterministic outcomes.
/// Captures every principal request id it sees so adapter tests can verify the guest received
/// the context request id (the executor sets the WIT request id from principal.request_id()).
struct ConformanceBroker {
  cancel: CancelToken,
  captured: Arc<Mutex<Vec<String>>>,
}

impl BrokerHandle for ConformanceBroker {
  #[allow(clippy::too_many_arguments)]
  fn fetch(
    &self,
    principal: &PluginPrincipal,
    _grant: &ExecutionGrantSet,
    request: BrokerFetchRequest,
    _authorization: BrokerAuthorization,
    cancel: &CancelToken,
    _deadline: Option<Instant>,
  ) -> Pin<Box<dyn Future<Output = BrokerFetchOutcome> + Send + '_>> {
    let endpoint = request.endpoint_id.clone();
    let cancel = cancel.clone();
    // Capture the principal's request id: this is the id the guest received. Adapter tests
    // assert it equals the ExecutionContext.request_id (proving per-request principal derivation).
    self
      .captured
      .lock()
      .unwrap()
      .push(principal.request_id().as_str().to_string());
    Box::pin(async move {
      match endpoint.as_str() {
        "approved" => Ok(BrokerFetchResponse {
          status: 200,
          headers: vec![],
          // Valid JSON string so the host's response JSON validation passes. The synthetic guest
          // echoes the raw body bytes as translated_text, so the value includes the JSON quotes.
          body: BrokerResponseBody::Json(b"\"translated\"".to_vec()),
        }),
        "denied" => Err(BrokerFetchError::NotApproved),
        "slow" => {
          tokio::time::sleep(Duration::from_secs(60)).await;
          Ok(BrokerFetchResponse {
            status: 200,
            headers: vec![],
            body: BrokerResponseBody::Json(b"slow".to_vec()),
          })
        }
        "wait-cancel" => {
          cancel.cancelled().await;
          Err(BrokerFetchError::Cancelled)
        }
        _ => Err(BrokerFetchError::NotApproved),
      }
    })
  }
}

/// Broker that always returns a fixed response regardless of the request. Used by broker
/// response-validation tests (authorization is host-enforced separately; this broker simulates
/// an upstream returning oversized/malformed content).
struct StaticResponseBroker {
  response: Result<BrokerFetchResponse, BrokerFetchError>,
}

impl BrokerHandle for StaticResponseBroker {
  #[allow(clippy::too_many_arguments)]
  fn fetch(
    &self,
    _principal: &PluginPrincipal,
    _grant: &ExecutionGrantSet,
    _request: BrokerFetchRequest,
    _authorization: BrokerAuthorization,
    _cancel: &CancelToken,
    _deadline: Option<Instant>,
  ) -> Pin<Box<dyn Future<Output = BrokerFetchOutcome> + Send + '_>> {
    let response = self.response.clone();
    Box::pin(async move { response })
  }
}

fn broker(cancel: &CancelToken) -> Box<dyn BrokerHandle> {
  Box::new(ConformanceBroker {
    cancel: cancel.clone(),
    captured: Arc::new(Mutex::new(Vec::new())),
  })
}

fn translate_request() -> TranslateTextRequest {
  TranslateTextRequest {
    text: "hello".into(),
    source_language_id: "auto".into(),
    target_language_id: "zh".into(),
  }
}

/// Derive a validated artifact digest from Component bytes. WAT/synthesized fixture tests use a
/// synthetic package digest plus this artifact digest so package and file digests stay distinct.
fn artifact_digest_of(bytes: &[u8]) -> ComponentArtifactDigest {
  ComponentArtifactDigest::parse(&compute_sha256_hex(bytes)).unwrap()
}

/// Synthetic package digest for WAT/synthesized fixtures (not equal to the artifact digest).
fn synthetic_package_digest(tag: u8) -> PackageDigest {
  let mut hex = format!("{tag:02x}");
  while hex.len() < 64 {
    hex.push('0');
  }
  PackageDigest::parse(&hex).unwrap()
}

fn compile_conformance(runtime: &WasmRuntime) -> crate::services::wasm_runtime::VerifiedComponent {
  runtime
    .compile_component(
      &conformance_package_digest(),
      &conformance_artifact_digest(),
      CONFORMANCE_WASM,
    )
    .expect("translate conformance component compiles")
}

fn compile_detect(runtime: &WasmRuntime) -> crate::services::wasm_runtime::VerifiedComponent {
  runtime
    .compile_component(
      &conformance_detect_package_digest(),
      &conformance_detect_artifact_digest(),
      CONFORMANCE_DETECT_WASM,
    )
    .expect("detect conformance component compiles")
}

/// Run `translate.text@1` against the conformance component with the given mode config.
async fn run_conformance(
  mode: &str,
  deadline: Option<Instant>,
  cancel: CancelToken,
) -> Result<String, CapabilityError> {
  let runtime = WasmRuntime::new().unwrap();
  let verified = compile_conformance(&runtime);
  let (principal, grant) = conformance_principal_grant();
  let config = format!("{{\"mode\":\"{mode}\"}}").into_bytes();
  let response = runtime
    .execute_translate_text(
      &verified,
      principal,
      grant,
      cancel.clone(),
      deadline,
      broker(&cancel),
      config,
      vec![],
      translate_request(),
    )
    .await?;
  Ok(response.translated_text)
}

/// Run the conformance `infinite-loop` mode with an explicit fuel grant, bypassing the executor's
/// default fuel. Used to isolate epoch-yield behavior: with ample fuel, only the epoch ticker +
/// deadline can interrupt the guest.
async fn run_infinite_loop_with_fuel(
  fuel: u64,
  deadline: Option<Instant>,
  cancel: CancelToken,
) -> Result<String, CapabilityError> {
  let runtime = WasmRuntime::new().unwrap();
  let verified = compile_conformance(&runtime);
  let (principal, grant) = conformance_principal_grant();
  let config = b"{\"mode\":\"infinite-loop\"}".to_vec();
  let cancel_for_state = cancel.clone();
  let state = new_state_with_fuel(
    principal,
    grant,
    cancel.clone(),
    deadline,
    broker(&cancel_for_state),
    fuel,
  );
  let mut store = build_store(runtime.engine().engine(), state);
  let mut linker = wasmtime::component::Linker::new(runtime.engine().engine());
  bindings::translate_text::TranslateTextWorld::add_to_linker::<_, HasSelf<PluginHostState>>(&mut linker, |state| {
    state
  })
  .map_err(map_instantiate_error)?;
  let world =
    bindings::translate_text::TranslateTextWorld::instantiate_async(&mut store, verified.component(), &linker)
      .await
      .map_err(map_instantiate_error)?;
  let guest = world.langnext_runtime_plugin_translate_text();
  use bindings::translate_text::exports::langnext::runtime_plugin::translate_text as tt_export;
  let wit_request = tt_export::TextRequest {
    request_id: store.data().principal.request_id().as_str().to_string(),
    text: "hello".into(),
    source_language_id: "auto".into(),
    target_language_id: "zh".into(),
  };
  let call_result = crate::services::wasm_runtime::executor::run_with_interruption(
    deadline,
    cancel,
    guest.call_text(&mut store, &config, &vec![], &wit_request),
  )
  .await;
  match call_result {
    Ok(Ok(response)) => Ok(response.translated_text),
    Ok(Err(plugin_error)) => {
      Err(crate::services::wasm_runtime::executor::map_translate_text_plugin_error(plugin_error))
    }
    Err(capability_error) => Err(capability_error),
  }
}

// ---------------------------------------------------------------------------
// Capturing log backend (for sanitized-log assertions)
// ---------------------------------------------------------------------------

static CAPTURED_LOGS: OnceLock<Mutex<Vec<(log::Level, String)>>> = OnceLock::new();
static INSTALL_LOGGER: std::sync::Once = std::sync::Once::new();

fn captured_logs() -> &'static Mutex<Vec<(log::Level, String)>> {
  CAPTURED_LOGS.get_or_init(|| Mutex::new(Vec::new()))
}

struct CapturingLogger;
impl log::Log for CapturingLogger {
  fn enabled(&self, _: &log::Metadata) -> bool {
    true
  }
  fn log(&self, record: &log::Record) {
    captured_logs()
      .lock()
      .unwrap()
      .push((record.level(), record.args().to_string()));
  }
  fn flush(&self) {}
}

fn install_capturing_logger() {
  INSTALL_LOGGER.call_once(|| {
    let _ = log::set_boxed_logger(Box::new(CapturingLogger));
    log::set_max_level(log::LevelFilter::Trace);
  });
}

// ---------------------------------------------------------------------------
// wasm_bindings: generated bindings and Phase 0 constant conformance
// ---------------------------------------------------------------------------

mod wasm_bindings {
  use super::*;

  #[test]
  fn worlds_match_phase0_constants() {
    assert_eq!(CAPABILITY_SPECS.len(), CAPABILITY_V1_COUNT);
    assert_eq!(CAPABILITY_MAJOR_V1, 1);
    assert_eq!(HOST_PLUGIN_API_VERSION_MAJOR, 1);
    let world_names: Vec<&str> = CAPABILITY_SPECS.iter().map(|spec| spec.world).collect();
    assert_eq!(
      world_names,
      [
        "translate-text-world",
        "translate-detect-world",
        "ocr-image-world",
        "speech-synthesize-world",
        "speech-recognize-world",
        "llm-models-world",
        "llm-chat-world",
      ]
    );
    let _ = std::marker::PhantomData::<bindings::translate_text::TranslateTextWorld>;
    let _ = std::marker::PhantomData::<bindings::translate_detect::TranslateDetectWorld>;
    let _ = std::marker::PhantomData::<bindings::ocr_image::OcrImageWorld>;
    let _ = std::marker::PhantomData::<bindings::speech_synthesize::SpeechSynthesizeWorld>;
    let _ = std::marker::PhantomData::<bindings::speech_recognize::SpeechRecognizeWorld>;
    let _ = std::marker::PhantomData::<bindings::llm_models::LlmModelsWorld>;
    let _ = std::marker::PhantomData::<bindings::llm_chat::LlmChatWorld>;
    let _ = std::marker::PhantomData::<bindings::migration::MigrationWorld>;
  }

  #[test]
  fn translate_text_and_detect_bindings_compile() {
    let _ = std::marker::PhantomData::<bindings::translate_text::TranslateTextWorld>;
    let _ = std::marker::PhantomData::<bindings::translate_detect::TranslateDetectWorld>;
  }
}

// ---------------------------------------------------------------------------
// wasm_executor: conformance mode execution against the committed fixture
// ---------------------------------------------------------------------------

mod wasm_executor {
  use super::*;

  /// Required plan modes that must appear in the committed fixture JSON (fail-closed gate).
  const REQUIRED_TRANSLATE_MODES: &[&str] = &[
    "success",
    "broker-call",
    "denied-endpoint",
    "trap",
    "infinite-loop",
    "memory-growth",
    "oversized-output",
    "slow-host-call",
    "cancellation",
  ];

  /// Read the committed conformance-modes fixture manifest and assert each mode's expected
  /// outcome. Honors optional `deadline_ms` / `cancel_after_ms` fixture fields so infinite-loop,
  /// slow-host-call, and cancellation modes execute under their plan conditions.
  #[tokio::test]
  async fn conformance_modes_fixture_manifest_matches_runtime() {
    let manifest: serde_json::Value = serde_json::from_str(CONFORMANCE_MODES_JSON).unwrap();
    let modes = manifest["modes"].as_array().unwrap();
    assert!(!modes.is_empty(), "fixture manifest must declare modes");
    let declared: Vec<&str> = modes.iter().map(|e| e["mode"].as_str().unwrap()).collect();
    for required in REQUIRED_TRANSLATE_MODES {
      assert!(
        declared.contains(required),
        "conformance modes fixture missing required mode {required}; declared={declared:?}"
      );
    }
    for entry in modes {
      let mode = entry["mode"].as_str().unwrap();
      let config = serde_json::to_vec(&entry["config"]).unwrap();
      let runtime = WasmRuntime::new().unwrap();
      let verified = compile_conformance(&runtime);
      let (principal, grant) = conformance_principal_grant();
      let cancel = CancelToken::new();
      if let Some(ms) = entry["cancel_after_ms"].as_u64() {
        let cancel_clone = cancel.clone();
        tokio::spawn(async move {
          tokio::time::sleep(Duration::from_millis(ms)).await;
          cancel_clone.cancel();
        });
      }
      let deadline = entry["deadline_ms"]
        .as_u64()
        .map(|ms| Instant::now() + Duration::from_millis(ms));
      let outcome = runtime
        .execute_translate_text(
          &verified,
          principal,
          grant,
          cancel.clone(),
          deadline,
          broker(&cancel),
          config,
          vec![],
          translate_request(),
        )
        .await;
      if let Some(expected_text) = entry["expected_text"].as_str() {
        let response = outcome.unwrap();
        assert_eq!(response.translated_text, expected_text, "mode {mode}");
      } else if let Some(expected_error) = entry["expected_error"].as_str() {
        let err = outcome.unwrap_err();
        assert_eq!(err.code.as_str(), expected_error, "mode {mode}: {:?}", err.code);
      } else {
        panic!("fixture entry for mode {mode} has neither expected_text nor expected_error");
      }
    }
  }

  #[test]
  fn translate_and_detect_manifest_grant_closed_loop() {
    let grant = grant_from_validated_translate_manifest();
    assert_eq!(grant.plugin_id().as_str(), CONFORMANCE_PLUGIN_ID);
    let endpoints: Vec<&str> = grant.network_entries().map(|e| e.endpoint_id().as_str()).collect();
    assert!(endpoints.contains(&"approved"));
    assert!(endpoints.contains(&"slow"));
    assert!(endpoints.contains(&"wait-cancel"));
    assert!(!endpoints.contains(&"denied"));
    let principal = grant
      .principal_for_request(CONFORMANCE_CAPABILITY_TEXT, "req-manifest")
      .unwrap();
    assert_eq!(
      principal.package_digest().unwrap().as_str(),
      conformance_package_digest().as_str()
    );
    let detect_grant = grant_from_validated_detect_manifest();
    assert_eq!(detect_grant.plugin_id().as_str(), CONFORMANCE_DETECT_PLUGIN_ID);
    assert_eq!(detect_grant.network_entries().count(), 0);
  }

  /// Read the committed detect conformance-modes fixture manifest and assert each mode's
  /// expected outcome, so detect coverage is also auditable from a committed file (Issue 8).
  #[tokio::test]
  async fn detect_conformance_modes_fixture_manifest_matches_runtime() {
    let manifest: serde_json::Value = serde_json::from_str(CONFORMANCE_DETECT_MODES_JSON).unwrap();
    let modes = manifest["modes"].as_array().unwrap();
    assert!(!modes.is_empty(), "detect fixture manifest must declare modes");
    for entry in modes {
      let mode = entry["mode"].as_str().unwrap();
      let config = serde_json::to_vec(&entry["config"]).unwrap();
      let runtime = WasmRuntime::new().unwrap();
      let verified = compile_detect(&runtime);
      let (principal, grant) = conformance_principal_grant_for_capability(CONFORMANCE_CAPABILITY_DETECT);
      let cancel = CancelToken::new();
      let outcome = runtime
        .execute_translate_detect(
          &verified,
          principal,
          grant,
          cancel.clone(),
          None,
          broker(&cancel),
          config,
          vec![],
          DetectLanguageRequest { text: "hello".into() },
        )
        .await;
      if let Some(expected_error) = entry["expected_error"].as_str() {
        let err = outcome.unwrap_err();
        assert_eq!(err.code.as_str(), expected_error, "detect mode {mode}: {:?}", err.code);
      } else {
        let response = outcome.expect("detect mode without expected_error must succeed");
        if let Some(lang) = entry["expected_language_id"].as_str() {
          assert_eq!(response.language_id, lang, "detect mode {mode} language_id");
        }
        if let Some(conf) = entry["expected_confidence"].as_f64() {
          let actual = response.confidence.map(|c| c as f64).unwrap_or(f64::NAN);
          assert!(
            (actual - conf).abs() < 1e-6,
            "detect mode {mode} confidence: got {actual}, expected {conf}"
          );
        }
      }
    }
  }

  #[tokio::test]
  async fn success_mode() {
    let cancel = CancelToken::new();
    let translated = run_conformance("success", None, cancel).await.unwrap();
    assert_eq!(translated, "[hello]");
  }

  #[tokio::test]
  async fn broker_call_mode() {
    let cancel = CancelToken::new();
    let translated = run_conformance("broker-call", None, cancel).await.unwrap();
    // The broker returns a JSON string `"translated"`; the synthetic guest echoes the raw body
    // bytes, so translated_text is the JSON-string form (with quotes).
    assert_eq!(translated, "\"translated\"");
  }

  #[tokio::test]
  async fn denied_endpoint_mode() {
    let cancel = CancelToken::new();
    let err = run_conformance("denied-endpoint", None, cancel).await.unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[tokio::test]
  async fn trap_mode_maps_to_plugin_unavailable() {
    let cancel = CancelToken::new();
    let err = run_conformance("trap", None, cancel).await.unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PluginUnavailable);
  }

  #[tokio::test]
  async fn oversized_output_rejected() {
    let cancel = CancelToken::new();
    let err = run_conformance("oversized-output", None, cancel).await.unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }

  #[tokio::test]
  async fn memory_growth_rejected() {
    let cancel = CancelToken::new();
    let err = run_conformance("memory-growth", None, cancel).await.unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::QuotaExceeded);
  }

  #[tokio::test]
  async fn slow_host_call_times_out() {
    let cancel = CancelToken::new();
    let deadline = Some(Instant::now() + Duration::from_millis(200));
    let err = run_conformance("slow-host-call", deadline, cancel).await.unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::Timeout);
  }

  #[tokio::test]
  async fn cancellation_propagates() {
    let cancel = CancelToken::new();
    let cancel_clone = cancel.clone();
    tokio::spawn(async move {
      tokio::time::sleep(Duration::from_millis(100)).await;
      cancel_clone.cancel();
    });
    let err = run_conformance("cancellation", None, cancel).await.unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::Cancelled);
  }

  #[tokio::test]
  async fn execute_through_translate_text_capability_trait() {
    // The adapter implements TranslateTextCapability and derives a fresh per-request principal
    // from the context (Phase 0: principal binds one request). Verify the call succeeds through
    // the trait and the guest received the context request id (captured by the broker).
    let runtime = Arc::new(WasmRuntime::new().unwrap());
    let verified = Arc::new(compile_conformance(&runtime));
    let (_principal, grant) = conformance_principal_grant();
    let config = b"{\"mode\":\"broker-call\"}".to_vec();
    let captured = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured_clone = captured.clone();
    let broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new(move || {
      Box::new(ConformanceBroker {
        cancel: CancelToken::new(),
        captured: captured_clone.clone(),
      })
    });
    let adapter = WasmTranslateTextAdapter::new(
      runtime.clone(),
      verified,
      grant,
      CONFORMANCE_CAPABILITY_TEXT,
      config,
      vec![],
      broker_factory,
    );
    let context = ExecutionContext {
      request_id: "req-trait-context".into(),
      cancel: CancelToken::new(),
      deadline: None,
      integration_instance_id: Uuid::nil(),
      plugin_id: CONFORMANCE_PLUGIN_ID.into(),
      capability_id: CONFORMANCE_CAPABILITY_TEXT.into(),
    };
    let request = translate_request();
    let response = TranslateTextCapability::translate(&adapter, Uuid::nil(), request, context)
      .await
      .unwrap();
    // Broker returns JSON string `"translated"`; guest echoes raw body bytes (with quotes).
    assert_eq!(response.translated_text, "\"translated\"");
    // The broker captured the principal request id, which the executor set from the context.
    let captured_ids = captured.lock().unwrap().clone();
    assert!(
      captured_ids.contains(&"req-trait-context".to_string()),
      "guest must receive context request id: {captured_ids:?}"
    );
  }

  #[tokio::test]
  async fn adapter_rejects_wrong_instance() {
    let runtime = Arc::new(WasmRuntime::new().unwrap());
    let verified = Arc::new(compile_conformance(&runtime));
    let (_principal, grant) = conformance_principal_grant();
    let broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new(|| {
      Box::new(ConformanceBroker {
        cancel: CancelToken::new(),
        captured: Arc::new(Mutex::new(Vec::new())),
      })
    });
    let adapter = WasmTranslateTextAdapter::new(
      runtime,
      verified,
      grant,
      CONFORMANCE_CAPABILITY_TEXT,
      b"{}".to_vec(),
      vec![],
      broker_factory,
    );
    // trait instance_id != context.integration_instance_id (nil vs a random uuid).
    let context = ExecutionContext {
      request_id: "req-x".into(),
      cancel: CancelToken::new(),
      deadline: None,
      integration_instance_id: Uuid::nil(),
      plugin_id: CONFORMANCE_PLUGIN_ID.into(),
      capability_id: CONFORMANCE_CAPABILITY_TEXT.into(),
    };
    let err = TranslateTextCapability::translate(&adapter, Uuid::now_v7(), translate_request(), context)
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[tokio::test]
  async fn adapter_rejects_wrong_plugin() {
    let runtime = Arc::new(WasmRuntime::new().unwrap());
    let verified = Arc::new(compile_conformance(&runtime));
    let (_principal, grant) = conformance_principal_grant();
    let broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new(|| {
      Box::new(ConformanceBroker {
        cancel: CancelToken::new(),
        captured: Arc::new(Mutex::new(Vec::new())),
      })
    });
    let adapter = WasmTranslateTextAdapter::new(
      runtime,
      verified,
      grant,
      CONFORMANCE_CAPABILITY_TEXT,
      b"{}".to_vec(),
      vec![],
      broker_factory,
    );
    let context = ExecutionContext {
      request_id: "req-x".into(),
      cancel: CancelToken::new(),
      deadline: None,
      integration_instance_id: Uuid::nil(),
      plugin_id: "other.plugin".into(),
      capability_id: CONFORMANCE_CAPABILITY_TEXT.into(),
    };
    let err = TranslateTextCapability::translate(&adapter, Uuid::nil(), translate_request(), context)
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[tokio::test]
  async fn adapter_rejects_wrong_capability() {
    let runtime = Arc::new(WasmRuntime::new().unwrap());
    let verified = Arc::new(compile_conformance(&runtime));
    let (_principal, grant) = conformance_principal_grant();
    let broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new(|| {
      Box::new(ConformanceBroker {
        cancel: CancelToken::new(),
        captured: Arc::new(Mutex::new(Vec::new())),
      })
    });
    let adapter = WasmTranslateTextAdapter::new(
      runtime,
      verified,
      grant,
      CONFORMANCE_CAPABILITY_TEXT,
      b"{}".to_vec(),
      vec![],
      broker_factory,
    );
    let context = ExecutionContext {
      request_id: "req-x".into(),
      cancel: CancelToken::new(),
      deadline: None,
      integration_instance_id: Uuid::nil(),
      plugin_id: CONFORMANCE_PLUGIN_ID.into(),
      capability_id: CONFORMANCE_CAPABILITY_DETECT.into(),
    };
    let err = TranslateTextCapability::translate(&adapter, Uuid::nil(), translate_request(), context)
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[tokio::test]
  async fn detect_world_success() {
    let runtime = WasmRuntime::new().unwrap();
    let verified = compile_detect(&runtime);
    let (principal, grant) = conformance_principal_grant_for_capability(CONFORMANCE_CAPABILITY_DETECT);
    let cancel = CancelToken::new();
    let config = b"{\"mode\":\"success\"}".to_vec();
    let request = DetectLanguageRequest { text: "hello".into() };
    let response = runtime
      .execute_translate_detect(
        &verified,
        principal,
        grant,
        cancel.clone(),
        None,
        broker(&cancel),
        config,
        vec![],
        request,
      )
      .await
      .unwrap();
    assert_eq!(response.language_id, "en");
    assert_eq!(response.confidence, Some(0.95));
  }

  #[tokio::test]
  async fn detect_world_failure_mode() {
    let runtime = WasmRuntime::new().unwrap();
    let verified = compile_detect(&runtime);
    let (principal, grant) = conformance_principal_grant_for_capability(CONFORMANCE_CAPABILITY_DETECT);
    let cancel = CancelToken::new();
    let config = b"{\"mode\":\"failure\"}".to_vec();
    let request = DetectLanguageRequest { text: "hello".into() };
    let err = runtime
      .execute_translate_detect(
        &verified,
        principal,
        grant,
        cancel.clone(),
        None,
        broker(&cancel),
        config,
        vec![],
        request,
      )
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedLanguage);
  }

  #[tokio::test]
  async fn detect_world_invalid_confidence_rejected() {
    let runtime = WasmRuntime::new().unwrap();
    let verified = compile_detect(&runtime);
    let (principal, grant) = conformance_principal_grant_for_capability(CONFORMANCE_CAPABILITY_DETECT);
    let cancel = CancelToken::new();
    let config = b"{\"mode\":\"invalid-confidence\"}".to_vec();
    let request = DetectLanguageRequest { text: "hello".into() };
    let err = runtime
      .execute_translate_detect(
        &verified,
        principal,
        grant,
        cancel.clone(),
        None,
        broker(&cancel),
        config,
        vec![],
        request,
      )
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }

  #[tokio::test]
  async fn detect_through_capability_trait_and_context_request_id() {
    let runtime = Arc::new(WasmRuntime::new().unwrap());
    let verified = Arc::new(compile_detect(&runtime));
    let (_principal, grant) = conformance_principal_grant_for_capability(CONFORMANCE_CAPABILITY_DETECT);
    let captured = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured_clone = captured.clone();
    let broker_factory: Arc<dyn Fn() -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new(move || {
      Box::new(ConformanceBroker {
        cancel: CancelToken::new(),
        captured: captured_clone.clone(),
      })
    });
    let adapter = WasmDetectLanguageAdapter::new(
      runtime,
      verified,
      grant.clone(),
      CONFORMANCE_CAPABILITY_DETECT,
      b"{\"mode\":\"success\"}".to_vec(),
      vec![],
      broker_factory,
    );
    let context_request_id = "req-detect-context";
    let context = ExecutionContext {
      request_id: context_request_id.into(),
      cancel: CancelToken::new(),
      deadline: None,
      integration_instance_id: Uuid::nil(),
      plugin_id: CONFORMANCE_DETECT_PLUGIN_ID.into(),
      capability_id: CONFORMANCE_CAPABILITY_DETECT.into(),
    };
    // Direct principal-factory proof: context request_id enters a fresh principal (not inferred
    // from a successful detect call alone).
    let principal = principal_from_context(&grant, CONFORMANCE_CAPABILITY_DETECT, Uuid::nil(), &context)
      .expect("principal_from_context must accept matching detect context");
    assert_eq!(principal.request_id().as_str(), context_request_id);
    assert_eq!(
      principal.package_digest().unwrap().as_str(),
      conformance_detect_package_digest().as_str()
    );
    let response = DetectLanguageCapability::detect(
      &adapter,
      Uuid::nil(),
      DetectLanguageRequest { text: "hello".into() },
      context,
    )
    .await
    .unwrap();
    assert_eq!(response.language_id, "en");
    assert_eq!(response.confidence, Some(0.95));
  }
}

// ---------------------------------------------------------------------------
// wasm_host_imports: authorization, timeout, cancel, response validation, logs
// ---------------------------------------------------------------------------

mod wasm_host_imports {
  use super::*;
  use crate::services::wasm_runtime::host::BrokerRequestBody;

  fn host_state(principal: PluginPrincipal, grant: ExecutionGrantSet, cancel: CancelToken) -> PluginHostState {
    new_state(
      principal,
      grant,
      cancel,
      None,
      Box::new(ConformanceBroker {
        cancel: CancelToken::new(),
        captured: Arc::new(Mutex::new(Vec::new())),
      }),
    )
  }

  fn approved_request() -> BrokerFetchRequest {
    BrokerFetchRequest {
      endpoint_id: "approved".into(),
      relative_path: "v1/test".into(),
      method: "GET".into(),
      headers: vec![],
      body: BrokerRequestBody::Empty,
    }
  }

  #[tokio::test]
  async fn authorized_broker_fetch_succeeds() {
    let cancel = CancelToken::new();
    let (principal, grant) = conformance_principal_grant();
    let mut state = host_state(principal, grant, cancel);
    let outcome = state.do_broker_fetch(approved_request()).await;
    assert!(outcome.is_ok(), "authorized fetch should succeed: {:?}", outcome);
  }

  #[tokio::test]
  async fn wrong_endpoint_denied() {
    let cancel = CancelToken::new();
    let (principal, grant) = conformance_principal_grant();
    let mut state = host_state(principal, grant, cancel);
    let mut request = approved_request();
    request.endpoint_id = "unknown-endpoint".into();
    let outcome = state.do_broker_fetch(request).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::NotApproved));
  }

  #[tokio::test]
  async fn wrong_method_denied() {
    let cancel = CancelToken::new();
    let (principal, grant) = conformance_principal_grant();
    let mut state = host_state(principal, grant, cancel);
    let mut request = approved_request();
    request.method = "POST".into();
    let outcome = state.do_broker_fetch(request).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::MethodNotAllowed));
  }

  #[tokio::test]
  async fn wrong_capability_denied() {
    let cancel = CancelToken::new();
    let (detect_principal, _detect_grant) = conformance_principal_grant_for_capability(CONFORMANCE_CAPABILITY_DETECT);
    let (_text_principal, text_grant) = conformance_principal_grant();
    let mut state = host_state(detect_principal, text_grant, cancel);
    let outcome = state.do_broker_fetch(approved_request()).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::NotApproved));
  }

  #[tokio::test]
  async fn wrong_grant_revision_denied() {
    let cancel = CancelToken::new();
    let (principal, _grant) = conformance_principal_grant();
    let other_grant = ExecutionGrantSet::initial(
      Uuid::now_v7(),
      package_identity(conformance_package_digest()),
      PluginId::parse(CONFORMANCE_PLUGIN_ID).unwrap(),
      SemVerVersion::parse(CONFORMANCE_PLUGIN_VERSION).unwrap(),
      vec![CapabilityId::parse(CONFORMANCE_CAPABILITY_TEXT).unwrap()],
      vec![NetworkGrantEntry::new(
        CapabilityId::parse(CONFORMANCE_CAPABILITY_TEXT).unwrap(),
        EndpointId::parse("approved").unwrap(),
        HttpsOrigin::parse(CONFORMANCE_ORIGIN).unwrap(),
        HttpMethod::Get,
        AuthPolicyId::parse(CONFORMANCE_AUTH_POLICY).unwrap(),
        ResourceLimits::default(),
      )],
      vec![],
    )
    .unwrap();
    let mut state = host_state(principal, other_grant, cancel);
    let outcome = state.do_broker_fetch(approved_request()).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::NotApproved));
  }

  #[tokio::test]
  async fn import_timeout_does_not_rely_on_executor_select() {
    let cancel = CancelToken::new();
    let (principal, grant) = conformance_principal_grant();
    let mut state = host_state(principal, grant, cancel.clone());
    let request = BrokerFetchRequest {
      endpoint_id: "slow".into(),
      relative_path: "v1/test".into(),
      method: "GET".into(),
      headers: vec![],
      body: BrokerRequestBody::Empty,
    };
    let deadline = Some(Instant::now() + Duration::from_millis(200));
    state.deadline = deadline;
    let start = Instant::now();
    let outcome = state.do_broker_fetch(request).await;
    let elapsed = start.elapsed();
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::Timeout));
    assert!(elapsed < Duration::from_secs(5), "import took too long: {:?}", elapsed);
  }

  #[tokio::test]
  async fn import_cancellation_propagates() {
    let cancel = CancelToken::new();
    let (principal, grant) = conformance_principal_grant();
    let mut state = host_state(principal, grant, cancel.clone());
    let request = BrokerFetchRequest {
      endpoint_id: "wait-cancel".into(),
      relative_path: "v1/test".into(),
      method: "GET".into(),
      headers: vec![],
      body: BrokerRequestBody::Empty,
    };
    let cancel_clone = cancel.clone();
    tokio::spawn(async move {
      tokio::time::sleep(Duration::from_millis(50)).await;
      cancel_clone.cancel();
    });
    let outcome = state.do_broker_fetch(request).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::Cancelled));
  }

  #[tokio::test]
  async fn unlinked_import_fails_instantiation() {
    let runtime = WasmRuntime::new().unwrap();
    let verified = compile_conformance(&runtime);
    let (principal, grant) = conformance_principal_grant();
    let cancel = CancelToken::new();
    let state = new_state(principal, grant, cancel, None, broker(&CancelToken::new()));
    let mut store = build_store(runtime.engine().engine(), state);
    let linker = wasmtime::component::Linker::new(runtime.engine().engine());
    let result =
      bindings::translate_text::TranslateTextWorld::instantiate_async(&mut store, verified.component(), &linker).await;
    assert!(result.is_err(), "instantiation with unlinked imports must fail");
    let mapped = crate::services::wasm_runtime::errors::map_instantiate_error(result.err().unwrap());
    assert_eq!(mapped.code, CapabilityErrorCode::PluginUnavailable);
  }

  #[tokio::test]
  async fn undeclared_import_component_fails_instantiation() {
    // Uses the committed static WAT fixture (Issue 8) rather than an inline string.
    let wasm = wat::parse_str(UNDECLARED_IMPORT_WAT).unwrap();
    let runtime = WasmRuntime::new().unwrap();
    let verified = runtime
      .compile_component(&synthetic_package_digest(0xcd), &artifact_digest_of(&wasm), &wasm)
      .expect("component with undeclared import should compile");
    let (principal, grant) = conformance_principal_grant();
    let cancel = CancelToken::new();
    let state = new_state(principal, grant, cancel, None, broker(&CancelToken::new()));
    let mut store = build_store(runtime.engine().engine(), state);
    let mut linker = wasmtime::component::Linker::new(runtime.engine().engine());
    bindings::translate_text::TranslateTextWorld::add_to_linker::<_, HasSelf<PluginHostState>>(&mut linker, |state| {
      state
    })
    .unwrap();
    let result =
      bindings::translate_text::TranslateTextWorld::instantiate_async(&mut store, verified.component(), &linker).await;
    assert!(result.is_err(), "undeclared import must fail instantiation");
    let mapped = map_instantiate_error(result.err().unwrap());
    assert_eq!(
      mapped.code,
      CapabilityErrorCode::PluginUnavailable,
      "undeclared import must map to PluginUnavailable, got {:?}",
      mapped.code
    );
  }

  // --- Broker response validation (Issue 3) ---

  fn host_state_with_broker(
    principal: PluginPrincipal,
    grant: ExecutionGrantSet,
    broker: Box<dyn BrokerHandle>,
  ) -> PluginHostState {
    new_state(principal, grant, CancelToken::new(), None, broker)
  }

  #[tokio::test]
  async fn response_oversized_body_rejected() {
    let (principal, grant) = conformance_principal_grant();
    // max_response_bytes default is 8 MiB; return 9 MiB to exceed it.
    let huge = vec![b'a'; 9 * 1024 * 1024];
    let broker = Box::new(StaticResponseBroker {
      response: Ok(BrokerFetchResponse {
        status: 200,
        headers: vec![],
        body: BrokerResponseBody::Json(huge),
      }),
    });
    let mut state = host_state_with_broker(principal, grant, broker);
    let outcome = state.do_broker_fetch(approved_request()).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::LimitExceeded));
  }

  #[tokio::test]
  async fn response_too_many_headers_rejected() {
    let (principal, grant) = conformance_principal_grant();
    let headers = (0..33).map(|i| (format!("h{i}"), "v".into())).collect();
    let broker = Box::new(StaticResponseBroker {
      response: Ok(BrokerFetchResponse {
        status: 200,
        headers,
        body: BrokerResponseBody::Json(b"{}".to_vec()),
      }),
    });
    let mut state = host_state_with_broker(principal, grant, broker);
    let outcome = state.do_broker_fetch(approved_request()).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::HeaderBlocked));
  }

  #[tokio::test]
  async fn response_oversized_header_value_rejected() {
    let (principal, grant) = conformance_principal_grant();
    let big_value = "x".repeat(8193);
    let broker = Box::new(StaticResponseBroker {
      response: Ok(BrokerFetchResponse {
        status: 200,
        headers: vec![("x-huge".into(), big_value)],
        body: BrokerResponseBody::Json(b"{}".to_vec()),
      }),
    });
    let mut state = host_state_with_broker(principal, grant, broker);
    let outcome = state.do_broker_fetch(approved_request()).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::HeaderBlocked));
  }

  #[tokio::test]
  async fn response_invalid_json_body_rejected() {
    let (principal, grant) = conformance_principal_grant();
    let broker = Box::new(StaticResponseBroker {
      response: Ok(BrokerFetchResponse {
        status: 200,
        headers: vec![],
        body: BrokerResponseBody::Json(b"not valid json".to_vec()),
      }),
    });
    let mut state = host_state_with_broker(principal, grant, broker);
    let outcome = state.do_broker_fetch(approved_request()).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::HeaderBlocked));
  }

  #[tokio::test]
  async fn response_non_utf8_json_body_rejected() {
    let (principal, grant) = conformance_principal_grant();
    let broker = Box::new(StaticResponseBroker {
      response: Ok(BrokerFetchResponse {
        status: 200,
        headers: vec![],
        body: BrokerResponseBody::Json(vec![0xff, 0xfe, 0xfd]),
      }),
    });
    let mut state = host_state_with_broker(principal, grant, broker);
    let outcome = state.do_broker_fetch(approved_request()).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::HeaderBlocked));
  }

  #[tokio::test]
  async fn request_invalid_json_body_rejected() {
    let (principal, grant) = conformance_principal_grant();
    let mut state = host_state(principal, grant, CancelToken::new());
    let mut request = approved_request();
    request.body = BrokerRequestBody::Json(b"not valid json".to_vec());
    let outcome = state.do_broker_fetch(request).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::HeaderBlocked));
  }

  #[tokio::test]
  async fn request_valid_json_body_accepted() {
    let (principal, grant) = conformance_principal_grant();
    let mut state = host_state(principal, grant, CancelToken::new());
    let mut request = approved_request();
    request.body = BrokerRequestBody::Json(br#"{"k":"v"}"#.to_vec());
    let outcome = state.do_broker_fetch(request).await;
    assert!(outcome.is_ok(), "valid JSON request body should pass: {:?}", outcome);
  }

  #[tokio::test]
  async fn relative_path_confinement_rejects_absolute_and_traversal() {
    let (principal, grant) = conformance_principal_grant();
    let mut state = host_state(principal, grant, CancelToken::new());
    for path in [
      "/abs",
      "//evil",
      "../x",
      "a/./b",
      "https://evil.example/x",
      "a#f",
      "a\\b",
      "a?b#c",
      "a?api_key=secret",
      "a?token=x",
    ] {
      let mut request = approved_request();
      request.relative_path = path.into();
      let outcome = state.do_broker_fetch(request).await;
      assert!(outcome.is_err(), "path {path:?} must be rejected");
    }
    // A confined path with a query suffix is accepted (GTX query pairs).
    let mut request = approved_request();
    request.relative_path = "translate_a/single?client=gtx&sl=auto&tl=en&q=Hi".into();
    let outcome = state.do_broker_fetch(request).await;
    assert!(outcome.is_ok(), "confined query path should pass: {outcome:?}");
  }

  #[tokio::test]
  async fn blocked_request_headers_rejected() {
    let (principal, grant) = conformance_principal_grant();
    let mut state = host_state(principal, grant, CancelToken::new());
    for name in ["Authorization", "Cookie", "Host", "Set-Cookie", "Proxy-Authorization"] {
      let mut request = approved_request();
      request.headers = vec![(name.into(), "x".into())];
      let outcome = state.do_broker_fetch(request).await;
      assert!(
        matches!(outcome.unwrap_err(), BrokerFetchError::HeaderBlocked),
        "header {name} must be HeaderBlocked"
      );
    }
  }

  #[tokio::test]
  async fn max_request_bytes_over_limit_rejected() {
    let cap = CapabilityId::parse(CONFORMANCE_CAPABILITY_TEXT).unwrap();
    let tiny_limits = ResourceLimits::new(8, 1024, 1024, 1000).unwrap();
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      package_identity(conformance_package_digest()),
      PluginId::parse(CONFORMANCE_PLUGIN_ID).unwrap(),
      SemVerVersion::parse(CONFORMANCE_PLUGIN_VERSION).unwrap(),
      vec![cap.clone()],
      vec![NetworkGrantEntry::new(
        cap,
        EndpointId::parse("approved").unwrap(),
        HttpsOrigin::parse(CONFORMANCE_ORIGIN).unwrap(),
        HttpMethod::Get,
        AuthPolicyId::parse(CONFORMANCE_AUTH_POLICY).unwrap(),
        tiny_limits,
      )],
      vec![],
    )
    .unwrap();
    let principal = grant
      .principal_for_request(CONFORMANCE_CAPABILITY_TEXT, "req-limit")
      .unwrap();
    let mut state = host_state(principal, grant, CancelToken::new());
    let mut request = approved_request();
    // 9 JSON bytes exceeds max_request_bytes=8.
    request.body = BrokerRequestBody::Json(br#"{"a":123}"#.to_vec());
    let outcome = state.do_broker_fetch(request).await;
    assert!(matches!(outcome.unwrap_err(), BrokerFetchError::LimitExceeded));
  }

  #[tokio::test]
  async fn broker_bytes_response_mode_requires_accept_and_grant() {
    use crate::domain::plugin_resource::NetworkResponseBodyModes;
    use crate::domain::runtime_plugin::{
      AuthPolicyId, CapabilityId, EndpointId, ExecutionGrantSet, HttpMethod, HttpsOrigin, NetworkGrantEntry,
      PackageDigest, PackageIdentity, PluginId, ResourceLimits, RuntimeIdentity, SemVerVersion,
    };
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Package(PackageIdentity {
        package_digest: PackageDigest::parse(CONFORMANCE_PACKAGE_DIGEST_HEX).unwrap(),
      }),
      PluginId::parse(CONFORMANCE_PLUGIN_ID).unwrap(),
      SemVerVersion::parse(CONFORMANCE_PLUGIN_VERSION).unwrap(),
      vec![CapabilityId::parse(CONFORMANCE_CAPABILITY_TEXT).unwrap()],
      vec![NetworkGrantEntry::with_mode_origin_and_response_modes(
        CapabilityId::parse(CONFORMANCE_CAPABILITY_TEXT).unwrap(),
        EndpointId::parse("approved").unwrap(),
        HttpsOrigin::parse(CONFORMANCE_ORIGIN).unwrap(),
        crate::domain::runtime_plugin::NetworkOriginKind::InstanceConfigured,
        HttpMethod::Get,
        AuthPolicyId::parse(CONFORMANCE_AUTH_POLICY).unwrap(),
        crate::domain::runtime_plugin::NetworkResourceMode::Bounded,
        ResourceLimits::default(),
        NetworkResponseBodyModes::JSON_AND_BYTES,
      )],
      vec![],
    )
    .unwrap();
    let principal = grant
      .principal_for_request(CONFORMANCE_CAPABILITY_TEXT, "req-bytes")
      .unwrap();
    let broker = Box::new(StaticResponseBroker {
      response: Ok(BrokerFetchResponse {
        status: 200,
        headers: vec![("content-type".into(), "audio/mpeg".into())],
        body: BrokerResponseBody::Bytes {
          content_type: Some("audio/mpeg".into()),
          bytes: vec![1, 2, 3, 4],
        },
      }),
    });
    let mut state = host_state_with_broker(principal, grant, broker);
    let mut request = approved_request();
    request.headers = vec![("Accept".into(), "audio/mpeg".into())];
    let response = state.do_broker_fetch(request).await.expect("bytes mode ok");
    match response.body {
      BrokerResponseBody::Bytes { bytes, .. } => assert_eq!(bytes, vec![1, 2, 3, 4]),
      other => panic!("expected bytes body, got {other:?}"),
    }
  }

  #[tokio::test]
  async fn blob_and_stream_resource_ops_work() {
    use bindings::translate_text::langnext::runtime_plugin::host::{BlobDirection, Host as HostImports, StreamKind};
    let (principal, grant) = conformance_principal_grant();
    let mut state = host_state(principal, grant, CancelToken::new());
    let handle = state
      .blob_create(BlobDirection::Output, Some("application/octet-stream".into()), 64)
      .await
      .expect("host call must not trap")
      .expect("blob_create must succeed");
    // Resource handles are moved into each host call; exercise write then close on the same handle.
    let written = state
      .blob_write(handle, 0, b"hello".to_vec())
      .await
      .expect("host call must not trap")
      .expect("blob_write must succeed");
    assert_eq!(written, 5);
    // length/close use a freshly created handle after write verification via table.
    let handle2 = state
      .blob_create(BlobDirection::Output, None, 16)
      .await
      .expect("host call must not trap")
      .expect("blob_create must succeed");
    state
      .blob_close(handle2)
      .await
      .expect("host call must not trap")
      .expect("blob_close must succeed");

    let (_writer, _reader) = state
      .stream_create(StreamKind::NetworkBinary, None, 64)
      .await
      .expect("host call must not trap")
      .expect("stream_create must succeed");
  }

  /// Broker request body passed as a Blob handle is atomically consumed: the host takes the
  /// bytes out of the BlobResourceTable, removes the entry (no inaccessible leak), and forwards
  /// the exact arbitrary binary to the broker. Repeat access via the same handle fails because
  /// the wasmtime resource is deleted after consume.
  #[tokio::test]
  async fn broker_fetch_blob_body_consumed_not_leaked() {
    use crate::domain::plugin_resource::{ResourceCreateParams, ResourceDirection, ResourceOwner};
    use crate::services::wasm_runtime::host::{BlobResource, BrokerRequestBody};
    use bindings::translate_text::langnext::runtime_plugin::host::{
      BrokerBodyRequest, BrokerRequest, Host as HostImports,
    };

    struct BodyCapturingBroker {
      captured: Arc<Mutex<Option<BrokerRequestBody>>>,
    }
    impl BrokerHandle for BodyCapturingBroker {
      #[allow(clippy::too_many_arguments)]
      fn fetch(
        &self,
        _principal: &PluginPrincipal,
        _grant: &ExecutionGrantSet,
        request: BrokerFetchRequest,
        _authorization: BrokerAuthorization,
        _cancel: &CancelToken,
        _deadline: Option<Instant>,
      ) -> Pin<Box<dyn Future<Output = BrokerFetchOutcome> + Send + '_>> {
        let captured = self.captured.clone();
        Box::pin(async move {
          *captured.lock().unwrap() = Some(request.body);
          Ok(BrokerFetchResponse {
            status: 200,
            headers: vec![],
            body: BrokerResponseBody::Json(b"\"ok\"".to_vec()),
          })
        })
      }
    }

    let (principal, grant) = conformance_principal_grant();
    let captured: Arc<Mutex<Option<BrokerRequestBody>>> = Arc::new(Mutex::new(None));
    let broker = Box::new(BodyCapturingBroker {
      captured: captured.clone(),
    });
    let mut state = host_state_with_broker(principal, grant, broker);

    // Create an output blob and write arbitrary binary (incl. non-UTF-8) directly into the table,
    // then push a fresh host resource handle so the broker request can carry it.
    let owner = ResourceOwner::from_principal(&state.principal);
    let id = state
      .blobs
      .create(ResourceCreateParams {
        owner,
        direction: ResourceDirection::Output,
        content_type: Some("application/octet-stream".into()),
        max_bytes: 64,
        expires_at: None,
        cancel: state.cancel.clone(),
      })
      .expect("blob create");
    let binary = vec![0xFFu8, 0xFE, 0x00, 0x01, 0x80, 0x7F];
    state.blobs.write(id, &state.principal, 0, &binary).expect("blob write");
    assert_eq!(state.blobs.len(), 1);
    let handle = state.table.push(BlobResource { id }).expect("table push");

    // Build a broker request carrying the blob handle as the body and execute through the host
    // import (the generated binding that performs the consume).
    let request = BrokerRequest {
      endpoint_id: "approved".into(),
      relative_path: "v1/test".into(),
      method: "GET".into(),
      headers: vec![],
      body: BrokerBodyRequest::Blob(handle),
    };
    let result = state.broker_fetch(request).await.expect("host call must not trap");
    assert!(result.is_ok(), "broker_fetch should succeed: {:?}", result.err());

    // The BlobResourceTable entry is consumed (no leak): the table is empty after the transfer.
    assert!(
      state.blobs.is_empty(),
      "blob entry must be removed after consume, got len={}",
      state.blobs.len()
    );
    // The broker received the exact arbitrary binary bytes (no lossy UTF-8 conversion).
    let body = captured.lock().unwrap().take().expect("broker received body");
    match body {
      BrokerRequestBody::Blob { bytes, byte_len } => {
        assert_eq!(bytes, binary);
        assert_eq!(byte_len, binary.len());
      }
      other => panic!("expected Blob body, got {other:?}"),
    }
  }

  // --- Sanitized logging (Issue 3): no guest raw value in logs ---

  #[test]
  fn log_does_not_output_guest_raw_field_values() {
    install_capturing_logger();
    captured_logs().lock().unwrap().clear();
    let (principal, grant) = conformance_principal_grant();
    let state = new_state(
      principal,
      grant,
      CancelToken::new(),
      None,
      Box::new(StaticResponseBroker {
        response: Ok(BrokerFetchResponse {
          status: 200,
          headers: vec![],
          body: BrokerResponseBody::Json(b"{}".to_vec()),
        }),
      }),
    );
    // Guest attempts to exfiltrate user content via an allowlisted field name and the message.
    state.do_log(
      NeutralLogLevel::Info,
      "user-secret-message",
      &[("stage".into(), "user-secret-content".into())],
    );
    let logs = captured_logs().lock().unwrap();
    let line = logs
      .iter()
      .find(|(lvl, _)| *lvl == log::Level::Info)
      .map(|(_, m)| m.as_str())
      .expect("an Info log line must have been emitted");
    assert!(
      !line.contains("user-secret-content"),
      "raw field value must not be logged: {line}"
    );
    assert!(
      !line.contains("user-secret-message"),
      "raw message must not be logged: {line}"
    );
    // The field is summarized as (name, byte_length), proving the value was reduced to a length.
    assert!(
      line.contains("\"stage\", 19"),
      "fields must record name + value byte length: {line}"
    );
  }

  #[test]
  fn log_drops_disallowed_field_names() {
    install_capturing_logger();
    captured_logs().lock().unwrap().clear();
    let (principal, grant) = conformance_principal_grant();
    let state = new_state(
      principal,
      grant,
      CancelToken::new(),
      None,
      Box::new(StaticResponseBroker {
        response: Ok(BrokerFetchResponse {
          status: 200,
          headers: vec![],
          body: BrokerResponseBody::Json(b"{}".to_vec()),
        }),
      }),
    );
    state.do_log(NeutralLogLevel::Warn, "msg", &[("secret_field".into(), "leak".into())]);
    let logs = captured_logs().lock().unwrap();
    let line = logs
      .iter()
      .find(|(lvl, _)| *lvl == log::Level::Warn)
      .map(|(_, m)| m.as_str())
      .expect("a Warn log line must have been emitted");
    assert!(
      !line.contains("secret_field"),
      "disallowed field name must be dropped: {line}"
    );
    assert!(!line.contains("leak"), "disallowed field value must be dropped: {line}");
  }
}

// ---------------------------------------------------------------------------
// wasm_limits: oversized memory, table, memory.grow, fuel, epoch, output bounds
// ---------------------------------------------------------------------------

mod wasm_limits {
  use super::*;
  use crate::services::wasm_runtime::executor::deadline_to_duration;

  #[tokio::test]
  async fn oversized_minimum_memory_rejected() {
    let wasm_big = wat::parse_str(
      r#"
        (component
          (core module $m
            (memory 257)
          )
          (core instance $i (instantiate $m))
        )
      "#,
    )
    .unwrap();
    let runtime = WasmRuntime::new().unwrap();
    let result = runtime.compile_component(
      &synthetic_package_digest(0x11),
      &artifact_digest_of(&wasm_big),
      &wasm_big,
    );
    assert!(result.is_err(), "oversized minimum memory must be rejected");
    let mapped = map_instantiate_error(result.err().unwrap());
    assert_eq!(
      mapped.code,
      CapabilityErrorCode::InvalidConfiguration,
      "oversized memory must map to InvalidConfiguration, got {:?}",
      mapped.code
    );
    let _ = OVERSIZED_MEMORY_MIN_PAGES;
  }

  #[tokio::test]
  async fn oversized_table_rejected() {
    let wasm = wat::parse_str(format!(
      r#"
        (component
          (core module $m
            (table {OVERSIZED_TABLE_ELEMENTS} funcref)
          )
          (core instance $i (instantiate $m))
        )
      "#
    ))
    .unwrap();
    let runtime = WasmRuntime::new().unwrap();
    let result = runtime.compile_component(&synthetic_package_digest(0x22), &artifact_digest_of(&wasm), &wasm);
    assert!(result.is_err(), "oversized table must be rejected");
    let mapped = map_instantiate_error(result.err().unwrap());
    assert_eq!(
      mapped.code,
      CapabilityErrorCode::InvalidConfiguration,
      "oversized table must map to InvalidConfiguration, got {:?}",
      mapped.code
    );
  }

  #[tokio::test]
  async fn memory_grow_hits_store_limits_directly() {
    let wasm = wat::parse_str(
      r#"
        (module
          (memory (export "memory") 1)
          (func (export "grow") (result i32)
            (i32.const 65536)
            (memory.grow)
          )
        )
      "#,
    )
    .unwrap();
    let runtime = WasmRuntime::new().unwrap();
    let module = wasmtime::Module::new(runtime.engine().engine(), &wasm).unwrap();
    let (principal, grant) = conformance_principal_grant();
    let cancel = CancelToken::new();
    let state = new_state(principal, grant, cancel, None, broker(&CancelToken::new()));
    let mut store = build_store(runtime.engine().engine(), state);
    let linker = wasmtime::Linker::new(runtime.engine().engine());
    let instance = linker.instantiate_async(&mut store, &module).await.unwrap();
    let grow = instance.get_typed_func::<(), i32>(&mut store, "grow").unwrap();
    let result = grow.call_async(&mut store, ()).await;
    assert!(result.is_err(), "memory.grow exceeding limit must trap");
    let mapped = map_wasmtime_error(result.unwrap_err());
    assert_eq!(mapped.code, CapabilityErrorCode::QuotaExceeded);
  }

  #[tokio::test]
  async fn memory_growth_hits_store_limits() {
    let cancel = CancelToken::new();
    let err = run_conformance("memory-growth", None, cancel).await.unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::QuotaExceeded);
  }

  /// Deterministic fuel exhaustion: a long deadline (capped to DEFAULT_INVOCATION_TIMEOUT) lets
  /// fuel (10M) exhaust first. Assert ONLY QuotaExceeded - no either/or with Timeout (Issue 4).
  #[tokio::test]
  async fn infinite_loop_exhausts_fuel() {
    let cancel = CancelToken::new();
    // A far-future deadline is capped to DEFAULT_INVOCATION_TIMEOUT (20s) by deadline_to_duration.
    // Default fuel (10M) exhausts well within 20s for a tight loop, so fuel is the binding constraint.
    let deadline = Some(Instant::now() + Duration::from_secs(600));
    let err = run_conformance("infinite-loop", deadline, cancel).await.unwrap_err();
    assert_eq!(
      err.code,
      CapabilityErrorCode::QuotaExceeded,
      "infinite loop must exhaust fuel (QuotaExceeded), got {:?}",
      err.code
    );
  }

  /// Separate epoch-yield/deadline test: ample fuel (1B, won't exhaust) + a short deadline.
  /// The shared epoch ticker makes the infinite guest yield to the async executor at each epoch,
  /// letting the deadline sleep fire. A Timeout proves the ticker is running and the deadline is
  /// schedulable (Issue 4 + Issue 5). Without epoch yielding the guest would never yield and fuel
  /// would be the only interrupter.
  #[tokio::test]
  async fn infinite_loop_epoch_yields_to_deadline() {
    let cancel = CancelToken::new();
    let deadline = Some(Instant::now() + Duration::from_millis(300));
    let err = run_infinite_loop_with_fuel(1_000_000_000, deadline, cancel)
      .await
      .unwrap_err();
    assert_eq!(
      err.code,
      CapabilityErrorCode::Timeout,
      "with ample fuel the epoch ticker must yield the guest so the deadline fires (Timeout), got {:?}",
      err.code
    );
  }

  #[tokio::test]
  async fn oversized_output_rejected() {
    let cancel = CancelToken::new();
    let err = run_conformance("oversized-output", None, cancel).await.unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }

  #[tokio::test]
  async fn invalid_config_json_rejected() {
    let cancel = CancelToken::new();
    let runtime = WasmRuntime::new().unwrap();
    let verified = compile_conformance(&runtime);
    let (principal, grant) = conformance_principal_grant();
    let err = runtime
      .execute_translate_text(
        &verified,
        principal,
        grant,
        cancel.clone(),
        None,
        broker(&cancel),
        b"not valid json{{".to_vec(),
        vec![],
        translate_request(),
      )
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidConfiguration);
  }

  #[tokio::test]
  async fn oversized_config_rejected() {
    let cancel = CancelToken::new();
    let runtime = WasmRuntime::new().unwrap();
    let verified = compile_conformance(&runtime);
    let (principal, grant) = conformance_principal_grant();
    let oversized = vec![b' '; crate::services::wasm_runtime::executor::CONFIG_MAX_BYTES + 1];
    let err = runtime
      .execute_translate_text(
        &verified,
        principal,
        grant,
        cancel.clone(),
        None,
        broker(&cancel),
        oversized,
        vec![],
        translate_request(),
      )
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidConfiguration);
  }

  /// Far-future deadline is capped to DEFAULT_INVOCATION_TIMEOUT (Issue 11).
  #[test]
  fn far_future_deadline_capped_to_default() {
    let far = Some(Instant::now() + Duration::from_secs(3600));
    let duration = deadline_to_duration(far);
    assert!(
      duration <= crate::services::wasm_runtime::executor::DEFAULT_INVOCATION_TIMEOUT,
      "far-future deadline must be capped to DEFAULT_INVOCATION_TIMEOUT, got {duration:?}"
    );
  }

  #[test]
  fn no_deadline_uses_default_timeout() {
    let duration = deadline_to_duration(None);
    assert_eq!(
      duration,
      crate::services::wasm_runtime::executor::DEFAULT_INVOCATION_TIMEOUT
    );
  }

  // --- Digest verification (Issue 7) ---

  #[test]
  fn conformance_fixture_artifact_digest_matches_bytes() {
    // Artifact digest (not package digest) must equal the SHA-256 of the Component file bytes.
    assert_eq!(
      compute_sha256_hex(CONFORMANCE_WASM),
      conformance_artifact_digest().as_str()
    );
    assert_ne!(
      conformance_package_digest().as_str(),
      conformance_artifact_digest().as_str(),
      "package archive digest must stay distinct from component artifact digest"
    );
  }

  #[test]
  fn conformance_detect_fixture_artifact_digest_matches_bytes() {
    assert_eq!(
      compute_sha256_hex(CONFORMANCE_DETECT_WASM),
      conformance_detect_artifact_digest().as_str()
    );
    assert_ne!(
      conformance_detect_package_digest().as_str(),
      conformance_detect_artifact_digest().as_str()
    );
  }

  #[tokio::test]
  async fn compile_rejects_artifact_digest_mismatch() {
    let runtime = WasmRuntime::new().unwrap();
    let wrong_artifact = ComponentArtifactDigest::parse(&"f".repeat(64)).unwrap();
    let result = runtime.compile_component(&conformance_package_digest(), &wrong_artifact, CONFORMANCE_WASM);
    assert!(
      result.is_err(),
      "artifact digest mismatch must be rejected before compilation"
    );
  }

  #[tokio::test]
  async fn cache_hit_does_not_bypass_bytes_verification() {
    let runtime = WasmRuntime::new().unwrap();
    let _ = compile_conformance(&runtime);
    let tampered = {
      let mut bytes = CONFORMANCE_WASM.to_vec();
      let mid = bytes.len() / 2;
      bytes[mid] ^= 0xff;
      bytes
    };
    let result = runtime.compile_component(&conformance_package_digest(), &conformance_artifact_digest(), &tampered);
    assert!(
      result.is_err(),
      "same artifact digest + different bytes must be rejected despite cache hit"
    );
  }

  #[tokio::test]
  async fn package_a_component_rejected_under_package_b_grant() {
    let runtime = WasmRuntime::new().unwrap();
    let verified = compile_conformance(&runtime);
    let (principal, grant) = conformance_principal_grant_for(
      CONFORMANCE_CAPABILITY_TEXT,
      CONFORMANCE_PLUGIN_ID,
      PackageDigest::parse(&"c".repeat(64)).unwrap(),
      true,
    );
    let cancel = CancelToken::new();
    let err = runtime
      .execute_translate_text(
        &verified,
        principal,
        grant,
        cancel.clone(),
        None,
        broker(&cancel),
        b"{\"mode\":\"success\"}".to_vec(),
        vec![],
        translate_request(),
      )
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[tokio::test]
  async fn same_package_different_artifact_cache_isolation() {
    let runtime = WasmRuntime::new().unwrap();
    let package = conformance_package_digest();
    let a = compile_conformance(&runtime);
    let other_wasm = wat::parse_str(
      r#"
        (component
          (core module $m (func (export "f") (nop)))
          (core instance $i (instantiate $m))
        )
      "#,
    )
    .unwrap();
    let other_artifact = artifact_digest_of(&other_wasm);
    assert_ne!(other_artifact.as_str(), a.artifact_digest().as_str());
    let b = runtime
      .compile_component(&package, &other_artifact, &other_wasm)
      .expect("second artifact under same package must compile independently");
    assert_eq!(a.package_digest().as_str(), b.package_digest().as_str());
    assert_ne!(a.artifact_digest().as_str(), b.artifact_digest().as_str());
    let a2 = compile_conformance(&runtime);
    assert_eq!(a.artifact_digest().as_str(), a2.artifact_digest().as_str());
  }

  #[tokio::test]
  async fn bundled_principal_without_package_digest_rejected() {
    let runtime = WasmRuntime::new().unwrap();
    let verified = compile_conformance(&runtime);
    let cap = CapabilityId::parse(CONFORMANCE_CAPABILITY_TEXT).unwrap();
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Bundled,
      PluginId::parse(CONFORMANCE_PLUGIN_ID).unwrap(),
      SemVerVersion::parse(CONFORMANCE_PLUGIN_VERSION).unwrap(),
      vec![cap],
      vec![],
      vec![],
    )
    .unwrap();
    let principal = grant
      .principal_for_request(CONFORMANCE_CAPABILITY_TEXT, "req-bundled")
      .unwrap();
    assert!(principal.package_digest().is_none());
    let cancel = CancelToken::new();
    let err = runtime
      .execute_translate_text(
        &verified,
        principal,
        grant,
        cancel.clone(),
        None,
        broker(&cancel),
        b"{\"mode\":\"success\"}".to_vec(),
        vec![],
        translate_request(),
      )
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }
}

// ---------------------------------------------------------------------------
// wasm_epoch_ticker: lifecycle and reliability of the shared epoch ticker (Issue 5)
// ---------------------------------------------------------------------------

mod wasm_epoch_ticker {
  use super::*;

  /// The ticker must start even outside a Tokio runtime (AppState is sync-initialized). The old
  /// implementation silently returned None; this asserts `new()` succeeds in a plain OS thread.
  #[test]
  fn ticker_starts_outside_tokio_runtime() {
    let handle = std::thread::spawn(|| WasmRuntime::new());
    let runtime = handle
      .join()
      .expect("thread must not panic")
      .expect("new() must succeed without a Tokio runtime");
    // The ticker thread is alive; dropping the runtime stops and joins it.
    drop(runtime);
  }

  /// Dropping the runtime must stop and join the ticker thread (reclaimable, no leak). A fresh
  /// runtime can be constructed afterwards.
  #[test]
  fn ticker_stops_and_reclaims_on_drop() {
    let runtime = WasmRuntime::new().unwrap();
    drop(runtime);
    // Constructing a second runtime must succeed immediately (the first ticker thread joined).
    let runtime2 = WasmRuntime::new().unwrap();
    drop(runtime2);
  }

  /// The ticker is shared across all stores on the engine: the epoch-yield test in wasm_limits
  /// proves a store observes epoch advances (an infinite guest yields and a deadline fires). This
  /// test additionally asserts the engine exposes epoch interruption config.
  #[test]
  fn engine_has_epoch_interruption_enabled() {
    let runtime = WasmRuntime::new().unwrap();
    // increment_epoch must be callable (the ticker calls it every EPOCH_TICK_INTERVAL).
    runtime.engine().increment_epoch();
    runtime.engine().increment_epoch();
  }
}

// ---------------------------------------------------------------------------
// wasm_guest_imports: assert conformance components import only LangNext (Issue 10)
// ---------------------------------------------------------------------------

mod wasm_guest_imports {
  use super::*;

  /// Inspect the compiled conformance component's actual imports and assert none is a WASI
  /// interface. This is a real component-import inspection, not a source grep (Issue 10).
  #[test]
  fn translate_conformance_guest_imports_only_langnext() {
    let runtime = WasmRuntime::new().unwrap();
    let verified = compile_conformance(&runtime);
    let engine = runtime.engine().engine();
    let mut has_common = false;
    let mut has_host = false;
    for (name, _extern) in verified.component().component_type().imports(engine) {
      assert!(
        !name.starts_with("wasi:"),
        "translate guest must not import WASI, found: {name}"
      );
      if name.starts_with("langnext:runtime-plugin/common") {
        has_common = true;
      }
      if name.starts_with("langnext:runtime-plugin/host") {
        has_host = true;
      }
    }
    assert!(has_common, "translate guest must import common");
    assert!(has_host, "translate guest must import host");
  }

  #[test]
  fn detect_conformance_guest_imports_only_langnext() {
    let runtime = WasmRuntime::new().unwrap();
    let verified = compile_detect(&runtime);
    let engine = runtime.engine().engine();
    for (name, _extern) in verified.component().component_type().imports(engine) {
      assert!(
        !name.starts_with("wasi:"),
        "detect guest must not import WASI, found: {name}"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// wasm_runtime_cold_start: baseline cold-start measurement (ignored by default)
// ---------------------------------------------------------------------------

mod wasm_runtime_cold_start {
  use super::*;
  use std::time::Instant;

  /// Measure engine creation, component compilation (cache miss + hit), and first invocation.
  /// Ignored by default; run with `--ignored` for baseline measurement.
  #[tokio::test]
  #[ignore]
  async fn cold_start_baseline() {
    let t0 = Instant::now();
    let runtime = WasmRuntime::new().unwrap();
    let engine_create = t0.elapsed();

    let t1 = Instant::now();
    let verified = compile_conformance(&runtime);
    let compile_miss = t1.elapsed();

    let t2 = Instant::now();
    let _verified2 = compile_conformance(&runtime);
    let compile_hit = t2.elapsed();

    let cancel = CancelToken::new();
    let (principal, grant) = conformance_principal_grant();
    let config = b"{\"mode\":\"success\"}".to_vec();
    let t3 = Instant::now();
    let response = runtime
      .execute_translate_text(
        &verified,
        principal,
        grant,
        cancel.clone(),
        None,
        broker(&cancel),
        config,
        vec![],
        translate_request(),
      )
      .await
      .unwrap();
    let invoke = t3.elapsed();

    eprintln!(
      "cold-start baseline: engine_create={:?} compile_miss={:?} compile_hit={:?} invoke={:?} total={:?}",
      engine_create,
      compile_miss,
      compile_hit,
      invoke,
      engine_create + compile_miss + invoke
    );
    assert_eq!(response.translated_text, "[hello]");
  }
}
