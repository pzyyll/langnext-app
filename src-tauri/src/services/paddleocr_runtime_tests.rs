// ABOUTME: Host OCR routing tests for PaddleOCR built-in native workers (model readiness + golden text).
// ABOUTME: Uses a protocol fixture worker and catalog snapshots; no publisher or activation state.
#![cfg(test)]

use crate::credentials::MemoryCredentialVault;
use crate::domain::native_worker::{
  NATIVE_PROTOCOL_VERSION_V1, NATIVE_WORKER_ARTIFACT_PATH, PADDLEOCR_OCR_GOLDEN_TEXT, PADDLEOCR_PLUGIN_ID,
};
use crate::domain::plugin_catalog::PluginSource;
use crate::domain::plugin_model::{PluginModelResourceStatus, paddleocr_medium_model_resource};
use crate::domain::runtime_plugin::{FileRole, PackageTargetConstraint, RuntimeDescriptor, RuntimeKind};
use crate::domain::service_capability::{
  CapabilityErrorCode, OCR_IMAGE_CAPABILITY_ID, OcrImageOperation, OcrImagePreferences, OcrImageRequest,
};
use crate::domain::service_integration::{IntegrationHealthStatus, IntegrationInstance};
use crate::domain::time::now_rfc3339;
use crate::repositories::{integration_instances, plugin_model_resources};
use crate::services::native_workers::{NativeWorkerExecuteRequest, NativeWorkerManager};
use crate::services::plugin_catalog::PluginCatalog;
use crate::services::runtime_router::RuntimeRouter;
use crate::services::service_integrations::ServiceIntegrationService;
use crate::services::test_support::{
  SyntheticPlugin, catalog_with_synthetic, fixture_digest, registry_from_catalog, token_service, wasm_runtime,
};
use crate::storage::Database;
use base64::Engine;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tempfile::TempDir;
use uuid::Uuid;

const LICENSE_NOTICE: &str = "licenses/NOTICE.txt";
const WORKER_BYTES: &[u8] = b"MZ-worker-placeholder";
const DLL_A: &str = "runtime/opencv_world.dll";
const DLL_B: &str = "runtime/paddle_inference.dll";
const PLUGIN_VERSION: &str = "1.0.0";

/// Committed golden PNG fixture (host routing only; not a Paddle accuracy claim).
const GOLDEN_PNG: &[u8] = include_bytes!("../../../runtime-plugins/paddleocr/fixtures/ocr-golden/image.png");
const GOLDEN_EXPECTED: &str = include_str!("../../../runtime-plugins/paddleocr/fixtures/ocr-golden/expected-text.txt");

fn test_db(dir: &Path) -> Database {
  let db = Database::new(dir).unwrap();
  db.initialize().unwrap();
  db
}

fn golden_text() -> &'static str {
  GOLDEN_EXPECTED.trim()
}

fn build_golden_helper(dir: &Path) -> PathBuf {
  let src = dir.join("golden_helper.rs");
  let exe = dir.join(if cfg!(windows) {
    "golden_helper.exe"
  } else {
    "golden_helper"
  });
  let text = PADDLEOCR_OCR_GOLDEN_TEXT;
  // Escape carefully: outer format! only interpolates `{text}`.
  let source = format!(
    r##"
use std::io::{{Read, Write}};
fn main() {{
  let mut stdin = std::io::stdin();
  let mut stdout = std::io::stdout();
  let mut header = [0u8; 10];
  stdin.read_exact(&mut header).unwrap();
  let len = u32::from_be_bytes([header[6], header[7], header[8], header[9]]) as usize;
  let mut payload = vec![0u8; len];
  if len > 0 {{ stdin.read_exact(&mut payload).unwrap(); }}
  let mut out = Vec::new();
  out.extend_from_slice(&0x4C4E_5750u32.to_be_bytes());
  out.extend_from_slice(&2u16.to_be_bytes());
  out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
  out.extend_from_slice(&payload);
  stdout.write_all(&out).unwrap();
  stdout.flush().unwrap();
  let mut header2 = [0u8; 10];
  stdin.read_exact(&mut header2).unwrap();
  let len2 = u32::from_be_bytes([header2[6], header2[7], header2[8], header2[9]]) as usize;
  let mut payload2 = vec![0u8; len2];
  if len2 > 0 {{ stdin.read_exact(&mut payload2).unwrap(); }}
  let body = String::from_utf8_lossy(&payload2);
  let rid = body
    .split("\"requestId\":\"")
    .nth(1)
    .and_then(|s| s.split('"').next())
    .unwrap_or("r");
  // Outer format! interpolates only `{text}`; emit `{{`/`}}` so the helper's format!
  // receives a valid JSON template with named `{{rid}}` capture.
  let resp = format!("{{{{\"requestId\":\"{{rid}}\",\"text\":\"{text}\"}}}}");
  let mut out2 = Vec::new();
  out2.extend_from_slice(&0x4C4E_5750u32.to_be_bytes());
  out2.extend_from_slice(&4u16.to_be_bytes());
  out2.extend_from_slice(&(resp.len() as u32).to_be_bytes());
  out2.extend_from_slice(resp.as_bytes());
  stdout.write_all(&out2).unwrap();
  stdout.flush().unwrap();
  let mut header3 = [0u8; 10];
  let _ = stdin.read_exact(&mut header3);
}}
"##
  );
  std::fs::write(&src, source).unwrap();
  let status = Command::new("rustc")
    .arg(&src)
    .arg("-O")
    .arg("-o")
    .arg(&exe)
    .status()
    .expect("rustc");
  assert!(status.success(), "golden helper compile failed");
  exe
}

/// Host manager returns the independently authored protocol golden text via a fixture worker.
/// This is not production PaddleOCR accuracy (blocked without measured SDK/DLL inventory).
#[test]
fn paddleocr_runtime_ocr_returns_expected_text() {
  assert_eq!(golden_text(), PADDLEOCR_OCR_GOLDEN_TEXT);
  let dir = TempDir::new().unwrap();
  let model_root = dir.path().join("model");
  std::fs::create_dir_all(&model_root).unwrap();
  // Content-address style model tree presence (host does not open Paddle APIs here).
  let marker = b"ready";
  std::fs::write(model_root.join("marker"), marker).unwrap();
  let exe = build_golden_helper(dir.path());
  let worker_sha256 = crate::domain::plugin_catalog::sha256_hex(&std::fs::read(&exe).unwrap());
  let model_files = vec![("marker".to_string(), crate::domain::plugin_catalog::sha256_hex(marker))];
  let png_b64 = base64::engine::general_purpose::STANDARD.encode(GOLDEN_PNG);
  let manager = NativeWorkerManager::new();
  let response = manager
    .execute(NativeWorkerExecuteRequest {
      worker_exe: exe,
      worker_sha256,
      runtime_dir: dir.path().to_path_buf(),
      model_root,
      model_files,
      package_digest: "a".repeat(64),
      runtime_set_digest: "b".repeat(64),
      model_set_digest: "c".repeat(64),
      model_api_version: 1,
      runtime_dependencies: vec![],
      ocr: OcrImageRequest {
        png_base64: png_b64,
        preferences: OcrImagePreferences {
          operation: OcrImageOperation::DocumentTextDetection,
          language_hints: vec![],
        },
      },
      cancel: None,
      startup_phase_cap: None,
      session_timeout: None,
    })
    .expect("golden OCR via protocol fixture");
  assert_eq!(response.text, PADDLEOCR_OCR_GOLDEN_TEXT);
}

/// Synthetic built-in PaddleOCR native package plus one active instance pinned to its digest.
struct NativeFixture {
  _dir: TempDir,
  db: Database,
  catalog: Arc<PluginCatalog>,
  digest: String,
  instance_id: Uuid,
}

impl NativeFixture {
  fn router(&self) -> RuntimeRouter {
    RuntimeRouter::new(
      self.db.clone(),
      registry_from_catalog(&self.catalog),
      self.catalog.clone(),
      wasm_runtime(),
    )
  }

  fn integration_service(&self) -> ServiceIntegrationService {
    let registry = registry_from_catalog(&self.catalog);
    let vault = Arc::new(MemoryCredentialVault::default());
    let tokens = token_service(&self.db, vault.clone());
    ServiceIntegrationService::new(self.db.clone(), vault, registry, tokens).with_catalog(self.catalog.clone())
  }

  fn validate(&self) -> crate::domain::service_integration::IntegrationValidationResult {
    crate::services::test_support::block_on(self.integration_service().validate_instance(self.instance_id))
      .expect("validate")
  }
}

fn native_fixture(model_ready: bool, health: IntegrationHealthStatus) -> NativeFixture {
  let dir = TempDir::new().unwrap();
  let db = test_db(dir.path());
  let plugin = SyntheticPlugin::native(
    PADDLEOCR_PLUGIN_ID,
    PLUGIN_VERSION,
    NATIVE_WORKER_ARTIFACT_PATH,
    WORKER_BYTES,
  )
  .add_file(DLL_A, FileRole::RuntimeArtifact, b"a")
  .add_file(DLL_B, FileRole::RuntimeArtifact, b"b")
  .add_file(LICENSE_NOTICE, FileRole::License, b"n")
  .with_capability(OCR_IMAGE_CAPABILITY_ID)
  .with_model_resources(vec![paddleocr_medium_model_resource(LICENSE_NOTICE)]);
  let mut plugin = plugin;
  plugin.manifest.runtime = RuntimeDescriptor {
    kind: RuntimeKind::TrustedNativeWorker,
    artifact: Some(NATIVE_WORKER_ARTIFACT_PATH.into()),
    native_protocol_version: Some(NATIVE_PROTOCOL_VERSION_V1),
    native_dependencies: Some(vec![DLL_A.into(), DLL_B.into()]),
  };
  plugin.manifest.targets = vec![PackageTargetConstraint {
    platform: "windows".into(),
    architecture: "x86_64".into(),
  }];

  let catalog = catalog_with_synthetic(db.clone(), dir.path(), &[], std::slice::from_ref(&plugin));
  let loaded = catalog
    .resolve_default(PADDLEOCR_PLUGIN_ID)
    .expect("paddleocr fixture content is in the catalog");
  assert_eq!(loaded.descriptor.source, PluginSource::BuiltIn);
  assert_eq!(loaded.descriptor.runtime_kind, RuntimeKind::TrustedNativeWorker);
  let digest = fixture_digest(&catalog, PADDLEOCR_PLUGIN_ID);
  let instance_id = seed_native_instance(&db, &digest, model_ready, health);
  NativeFixture {
    _dir: dir,
    db,
    catalog,
    digest,
    instance_id,
  }
}

fn seed_native_instance(
  db: &Database,
  package_digest: &str,
  model_ready: bool,
  health: IntegrationHealthStatus,
) -> Uuid {
  let now = now_rfc3339();
  let model = paddleocr_medium_model_resource(LICENSE_NOTICE);
  let id = Uuid::now_v7();
  db.write(|conn| {
    integration_instances::insert(
      conn,
      &IntegrationInstance {
        id,
        plugin_id: PADDLEOCR_PLUGIN_ID.into(),
        plugin_version: PLUGIN_VERSION.into(),
        display_name: "PaddleOCR".into(),
        enabled: true,
        config_json: "{}".into(),
        config_schema_version: 1,
        health_status: health,
        last_validated_at: None,
        last_error_code: None,
        runtime_kind: "trusted-native-worker".into(),
        package_digest: Some(package_digest.into()),
        execution_grant_set_revision: Some(1),
        runtime_state: "active".into(),
        runtime_error_code: None,
        runtime_error_message: None,
        runtime_requirement_json: None,
        created_at: now.clone(),
        updated_at: now.clone(),
      },
    )?;
    if model_ready {
      let model_set = "f".repeat(64);
      plugin_model_resources::upsert_resource(
        conn,
        &plugin_model_resources::PluginModelResourceRecord {
          model_resource_key: format!("{package_digest}:{}", model.id),
          package_digest: package_digest.into(),
          model_id: model.id.clone(),
          model_version: model.version.clone(),
          model_api_version: model.model_api_version,
          model_set_digest: model_set.clone(),
          status: PluginModelResourceStatus::Ready,
          installed_bytes: Some(model.expanded_bytes),
          content_address: Some(model_set),
          error_code: None,
          updated_at: now,
        },
      )?;
    }
    Ok(())
  })
  .unwrap();
  id
}

fn upsert_model(
  db: &Database,
  package_digest: &str,
  model_id: &str,
  model_version: &str,
  model_api_version: u32,
  status: PluginModelResourceStatus,
) {
  let now = now_rfc3339();
  db.write(|conn| {
    plugin_model_resources::upsert_resource(
      conn,
      &plugin_model_resources::PluginModelResourceRecord {
        model_resource_key: format!("{package_digest}:{model_id}"),
        package_digest: package_digest.into(),
        model_id: model_id.into(),
        model_version: model_version.into(),
        model_api_version,
        model_set_digest: "f".repeat(64),
        status,
        installed_bytes: Some(1),
        content_address: Some("f".repeat(64)),
        error_code: None,
        updated_at: now,
      },
    )
  })
  .unwrap();
}

/// Missing model fails closed at the router before any worker process is created.
#[test]
fn paddleocr_runtime_missing_model_does_not_spawn_worker() {
  let fixture = native_fixture(false, IntegrationHealthStatus::Ready);
  let model_status = fixture
    .db
    .read(|conn| plugin_model_resources::get_by_package_and_model(conn, &fixture.digest, "pp-ocrv6-medium"))
    .unwrap();
  assert!(model_status.is_none(), "model must be missing");

  let err = match fixture
    .router()
    .resolve_ocr(fixture.instance_id, OCR_IMAGE_CAPABILITY_ID)
  {
    Ok(_) => panic!("missing model must fail closed before spawn"),
    Err(err) => err,
  };
  assert_eq!(err.code, CapabilityErrorCode::ModelMissing);
  assert!(err.message.contains("model_missing"), "got {}", err.message);
}

/// Router-level rejection when the pinned snapshot is absent from the catalog.
#[test]
fn paddleocr_runtime_resolve_ocr_missing_content_fails_closed() {
  let dir = TempDir::new().unwrap();
  let db = test_db(dir.path());
  let catalog = crate::services::test_support::catalog_with_builtins(db.clone(), dir.path(), &[]);
  let instance_id = seed_native_instance(&db, &"2".repeat(64), false, IntegrationHealthStatus::Ready);
  let router = RuntimeRouter::new(db.clone(), registry_from_catalog(&catalog), catalog, wasm_runtime());
  let err = match router.resolve_ocr(instance_id, OCR_IMAGE_CAPABILITY_ID) {
    Ok(_) => panic!("missing catalog content must fail closed"),
    Err(err) => err,
  };
  assert_eq!(err.code, CapabilityErrorCode::PluginUnavailable);
}

/// A pin whose digest is absent from the catalog never validates to Ready.
#[test]
fn paddleocr_health_validate_missing_definition_is_not_ready() {
  let dir = TempDir::new().unwrap();
  let db = test_db(dir.path());
  let catalog = crate::services::test_support::catalog_with_builtins(db.clone(), dir.path(), &[]);
  let instance_id = seed_native_instance(&db, &"a".repeat(64), false, IntegrationHealthStatus::Unvalidated);
  let registry = registry_from_catalog(&catalog);
  let vault = Arc::new(MemoryCredentialVault::default());
  let tokens = token_service(&db, vault.clone());
  let service = ServiceIntegrationService::new(db.clone(), vault, registry, tokens).with_catalog(catalog.clone());
  let result = crate::services::test_support::block_on(service.validate_instance(instance_id)).expect("validate");
  // Without catalog content there is no definition to validate against: the instance never
  // reaches Ready and the result names the missing definition.
  assert_ne!(result.health_status, IntegrationHealthStatus::Ready);
  assert_eq!(result.health_status, IntegrationHealthStatus::Unvalidated);
  assert!(
    result
      .message
      .as_deref()
      .is_some_and(|message| message.contains("plugin definition is missing")),
    "{result:?}"
  );
}

/// validate_instance: missing model → Degraded + model_missing (not unconditional Ready).
#[test]
fn paddleocr_health_validate_missing_model_is_degraded() {
  let fixture = native_fixture(false, IntegrationHealthStatus::Ready);
  let result = fixture.validate();
  assert_eq!(result.health_status, IntegrationHealthStatus::Degraded);
  let refreshed = fixture.integration_service().get_instance(fixture.instance_id).unwrap();
  assert_eq!(refreshed.health_status, IntegrationHealthStatus::Degraded);
  assert_eq!(
    refreshed.last_error_code.as_deref(),
    Some(crate::domain::plugin_model::PluginModelErrorCode::ModelMissing.as_str())
  );
}

/// A Ready row for a different model id must not satisfy the first-model health gate.
#[test]
fn paddleocr_health_validate_ready_for_wrong_model_id_is_degraded() {
  let fixture = native_fixture(false, IntegrationHealthStatus::Ready);
  upsert_model(
    &fixture.db,
    &fixture.digest,
    "other-model",
    "1.0.0",
    1,
    PluginModelResourceStatus::Ready,
  );
  let result = fixture.validate();
  assert_eq!(result.health_status, IntegrationHealthStatus::Degraded);
  let refreshed = fixture.integration_service().get_instance(fixture.instance_id).unwrap();
  assert_eq!(refreshed.health_status, IntegrationHealthStatus::Degraded);
  assert_eq!(
    refreshed.last_error_code.as_deref(),
    Some(crate::domain::plugin_model::PluginModelErrorCode::ModelMissing.as_str())
  );
}

/// Ready with mismatched version/api against the authoritative first model is Degraded.
#[test]
fn paddleocr_health_validate_ready_with_version_mismatch_is_degraded() {
  let fixture = native_fixture(false, IntegrationHealthStatus::Ready);
  // Manifest first model pins version 1.0.0 / api 1; mismatch must fail closed.
  upsert_model(
    &fixture.db,
    &fixture.digest,
    "pp-ocrv6-medium",
    "9.9.9",
    99,
    PluginModelResourceStatus::Ready,
  );
  let result = fixture.validate();
  assert_eq!(result.health_status, IntegrationHealthStatus::Degraded);
  let refreshed = fixture.integration_service().get_instance(fixture.instance_id).unwrap();
  assert_eq!(refreshed.health_status, IntegrationHealthStatus::Degraded);
  assert_eq!(
    refreshed.last_error_code.as_deref(),
    Some(crate::domain::plugin_model::PluginModelErrorCode::ModelMissing.as_str())
  );
}

/// validate_instance: ready model → Ready.
#[test]
fn paddleocr_health_validate_ready_model_is_ready() {
  let fixture = native_fixture(true, IntegrationHealthStatus::Unvalidated);
  let result = fixture.validate();
  assert_eq!(result.health_status, IntegrationHealthStatus::Ready);
  let refreshed = fixture.integration_service().get_instance(fixture.instance_id).unwrap();
  assert_eq!(refreshed.health_status, IntegrationHealthStatus::Ready);
  assert!(refreshed.last_error_code.is_none());
}

/// A downloaded-but-failed model row stays Degraded.
#[test]
fn paddleocr_health_validate_failed_model_is_degraded() {
  let fixture = native_fixture(false, IntegrationHealthStatus::Ready);
  upsert_model(
    &fixture.db,
    &fixture.digest,
    "pp-ocrv6-medium",
    "1.0.0",
    1,
    PluginModelResourceStatus::Failed,
  );
  let result = fixture.validate();
  assert_eq!(result.health_status, IntegrationHealthStatus::Degraded);
  let refreshed = fixture.integration_service().get_instance(fixture.instance_id).unwrap();
  assert_eq!(
    refreshed.last_error_code.as_deref(),
    Some(crate::domain::plugin_model::PluginModelErrorCode::ModelMissing.as_str())
  );
}
