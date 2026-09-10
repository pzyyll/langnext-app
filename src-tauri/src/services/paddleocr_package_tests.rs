// ABOUTME: Catalog loader contract tests for the PaddleOCR trusted native worker package.
// ABOUTME: Covers built-in runtime-directory acceptance and adversarial model/runtime rejections.
#![cfg(test)]

use crate::domain::native_worker::{
  NATIVE_PROTOCOL_VERSION_V1, NATIVE_WORKER_ARTIFACT_PATH, PADDLEOCR_PLUGIN_ID, PADDLEOCR_PLUGIN_VERSION,
  is_allowlisted_native_worker,
};
use crate::domain::plugin_catalog::{PluginLoadErrorCode, PluginSource};
use crate::domain::plugin_model::paddleocr_medium_model_resource;
use crate::domain::plugin_package::sha256_hex;
use crate::domain::runtime_plugin::{FileRole, PluginFileEntry, PluginManifestV1, RuntimeKind};
use crate::services::plugin_loader::{LoadedPlugin, PluginLoadError, PluginLoader};
use crate::services::runtime_plugin_contracts::parse_manifest;
use std::path::{Path, PathBuf};

const LICENSE_NOTICE: &str = "licenses/NOTICE.txt";
const LICENSE_TEXT: &[u8] = b"PaddleOCR Apache-2.0 notice placeholder for package contract tests.\n";
const WORKER_BYTES: &[u8] = b"MZ-fake-worker-exe-for-package-contract";
const DLL_A_BYTES: &[u8] = b"fake-paddle-dll-a";
const DLL_B_BYTES: &[u8] = b"fake-opencv-dll-b";
const DLL_A_PATH: &str = "runtime/paddle_inference.dll";
const DLL_B_PATH: &str = "runtime/opencv_world.dll";

fn file_entry(path: &str, role: FileRole, bytes: &[u8]) -> PluginFileEntry {
  PluginFileEntry {
    path: path.into(),
    role,
    bytes: bytes.len() as u64,
    sha256: sha256_hex(bytes),
  }
}

/// Valid PaddleOCR manifest JSON with native protocol + modelResources, as shipped content.
fn paddleocr_manifest_json() -> String {
  let model = paddleocr_medium_model_resource(LICENSE_NOTICE);
  let model_json = serde_json::to_string(&model).expect("model resource json");
  let worker_sha = sha256_hex(WORKER_BYTES);
  let dll_a_sha = sha256_hex(DLL_A_BYTES);
  let dll_b_sha = sha256_hex(DLL_B_BYTES);
  let license_sha = sha256_hex(LICENSE_TEXT);
  format!(
    r#"{{
      "manifestVersion": 1,
      "pluginApiVersion": "1.0",
      "id": "{PADDLEOCR_PLUGIN_ID}",
      "version": "{PADDLEOCR_PLUGIN_VERSION}",
      "runtime": {{
        "kind": "trusted-native-worker",
        "artifact": "{NATIVE_WORKER_ARTIFACT_PATH}",
        "nativeProtocolVersion": {NATIVE_PROTOCOL_VERSION_V1},
        "nativeDependencies": ["{DLL_B_PATH}", "{DLL_A_PATH}"]
      }},
      "targets": [{{ "platform": "windows", "architecture": "x86_64" }}],
      "files": [
        {{
          "path": "{NATIVE_WORKER_ARTIFACT_PATH}",
          "role": "runtime-artifact",
          "bytes": {worker_bytes},
          "sha256": "{worker_sha}"
        }},
        {{
          "path": "{DLL_A_PATH}",
          "role": "runtime-artifact",
          "bytes": {dll_a_bytes},
          "sha256": "{dll_a_sha}"
        }},
        {{
          "path": "{DLL_B_PATH}",
          "role": "runtime-artifact",
          "bytes": {dll_b_bytes},
          "sha256": "{dll_b_sha}"
        }},
        {{
          "path": "{LICENSE_NOTICE}",
          "role": "license",
          "bytes": {license_bytes},
          "sha256": "{license_sha}"
        }}
      ],
      "capabilities": [
        {{ "id": "ocr.image@1" }}
      ],
      "permissions": {{ "network": [], "authPolicies": [] }},
      "ui": {{ "mode": "schema", "pages": [] }},
      "modelResources": [{model_json}]
    }}"#,
    worker_bytes = WORKER_BYTES.len(),
    dll_a_bytes = DLL_A_BYTES.len(),
    dll_b_bytes = DLL_B_BYTES.len(),
    license_bytes = LICENSE_TEXT.len(),
  )
}

fn paddleocr_package_files() -> Vec<(&'static str, &'static [u8])> {
  vec![
    (NATIVE_WORKER_ARTIFACT_PATH, WORKER_BYTES),
    (DLL_A_PATH, DLL_A_BYTES),
    (DLL_B_PATH, DLL_B_BYTES),
    (LICENSE_NOTICE, LICENSE_TEXT),
  ]
}

/// Materialize one manifest plus payloads as a built-in plugin directory.
fn write_plugin_dir(root: &Path, manifest: &PluginManifestV1, payloads: &[(&str, &[u8])]) -> PathBuf {
  let dir = root.join("plugin");
  std::fs::create_dir_all(&dir).unwrap();
  std::fs::write(
    dir.join("plugin.json"),
    serde_json::to_vec(manifest).expect("manifest serializes"),
  )
  .unwrap();
  for (path, bytes) in payloads {
    let target = dir.join(path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, bytes).unwrap();
  }
  dir
}

/// Loaded fixture that keeps its app data directory alive (snapshots live there).
#[derive(Debug)]
struct LoadedFixture {
  _root: tempfile::TempDir,
  loaded: LoadedPlugin,
}

/// Load one manifest through the real built-in catalog loader (production ingestion path).
fn load_builtin(manifest: &PluginManifestV1, payloads: &[(&str, &[u8])]) -> Result<LoadedFixture, PluginLoadError> {
  let root = tempfile::tempdir().unwrap();
  let dir = write_plugin_dir(root.path(), manifest, payloads);
  let loader = PluginLoader::new(root.path().join("cache"));
  let loaded = loader.load_directory(PluginSource::BuiltIn, &dir)?;
  Ok(LoadedFixture { _root: root, loaded })
}

fn parse_valid_paddleocr_manifest() -> PluginManifestV1 {
  parse_manifest(&paddleocr_manifest_json()).expect("valid paddleocr manifest")
}

/// First contract scenario: valid built-in PaddleOCR runtime directory with modelResources loads.
#[test]
fn paddleocr_package_runtime_directory_is_accepted() {
  let manifest = parse_valid_paddleocr_manifest();
  assert!(is_allowlisted_native_worker(&manifest.id, &manifest.version));
  let fixture = load_builtin(&manifest, &paddleocr_package_files())
    .unwrap_or_else(|err| panic!("built-in paddleocr package must load; got {err:?}"));
  let loaded = &fixture.loaded;
  assert_eq!(loaded.descriptor.plugin_id, PADDLEOCR_PLUGIN_ID);
  assert_eq!(loaded.descriptor.runtime_kind, RuntimeKind::TrustedNativeWorker);
  assert_eq!(loaded.descriptor.source, PluginSource::BuiltIn);
  assert!(loaded.descriptor.native_allowed());
  assert_eq!(loaded.descriptor.content_digest.len(), 64);
  assert!(
    loaded.snapshot_dir.is_dir(),
    "content is published as an immutable snapshot"
  );

  let round_trip = serde_json::to_value(&loaded.manifest).expect("manifest serialize");
  let runtime = round_trip.get("runtime").expect("runtime");
  assert_eq!(
    runtime.get("nativeProtocolVersion").and_then(|v| v.as_u64()),
    Some(NATIVE_PROTOCOL_VERSION_V1 as u64),
    "nativeProtocolVersion must round-trip on the loaded manifest"
  );
  let deps = runtime
    .get("nativeDependencies")
    .and_then(|v| v.as_array())
    .expect("nativeDependencies");
  assert_eq!(deps.len(), 2);
  // Sorted unique runtime/*.dll paths (opencv before paddle).
  assert_eq!(deps[0].as_str(), Some(DLL_B_PATH));
  assert_eq!(deps[1].as_str(), Some(DLL_A_PATH));

  let models = round_trip
    .get("modelResources")
    .and_then(|v| v.as_array())
    .expect("modelResources required for paddleocr");
  assert_eq!(models.len(), 1);
  assert_eq!(models[0].get("id").and_then(|v| v.as_str()), Some("pp-ocrv6-medium"));
  assert_eq!(
    models[0].get("artifacts").and_then(|v| v.as_array()).map(|a| a.len()),
    Some(2)
  );
  assert_eq!(
    models[0].get("files").and_then(|v| v.as_array()).map(|a| a.len()),
    Some(6)
  );
  let _ = file_entry;
}

#[test]
fn paddleocr_package_rejects_model_bytes_payload() {
  let mut manifest = parse_valid_paddleocr_manifest();
  let model_path = "runtime/PP-OCRv6_medium_det_infer/inference.pdiparams";
  let model_bytes = b"fake-model-weights";
  manifest
    .files
    .push(file_entry(model_path, FileRole::Other, model_bytes));
  let mut files = paddleocr_package_files();
  files.push((model_path, model_bytes.as_slice()));
  let err = load_builtin(&manifest, &files).expect_err("model bytes must be rejected");
  assert!(
    err.message.contains("prohibited")
      || err.message.contains("model")
      || err.message.contains("closed allowlist")
      || err.message.contains("pdiparams"),
    "unexpected error: {}",
    err.message
  );
}

#[test]
fn paddleocr_package_rejects_undeclared_runtime_dll() {
  let mut manifest = parse_valid_paddleocr_manifest();
  let extra = "runtime/extra.dll";
  let extra_bytes = b"extra-dll";
  manifest
    .files
    .push(file_entry(extra, FileRole::RuntimeArtifact, extra_bytes));
  // nativeDependencies intentionally omits extra.dll
  let mut files = paddleocr_package_files();
  files.push((extra, extra_bytes.as_slice()));
  let err = load_builtin(&manifest, &files).expect_err("undeclared DLL must fail validation");
  assert!(
    err.message.contains("nativeDependencies") || err.message.contains("exactly match"),
    "unexpected: {}",
    err.message
  );
}

#[test]
fn paddleocr_package_rejects_declared_dependency_missing_from_index() {
  let mut manifest = parse_valid_paddleocr_manifest();
  // Declare a third DLL in nativeDependencies without indexing it.
  let deps = manifest.runtime.native_dependencies.as_mut().unwrap();
  deps.push("runtime/missing.dll".into());
  deps.sort();
  let err = load_builtin(&manifest, &paddleocr_package_files()).expect_err("missing declared dependency must fail");
  assert!(
    err.message.contains("not in the file index") || err.message.contains("missing"),
    "unexpected: {}",
    err.message
  );
}

#[test]
fn paddleocr_package_rejects_second_executable() {
  let mut manifest = parse_valid_paddleocr_manifest();
  let extra_exe = "runtime/helper.exe";
  let extra_bytes = b"MZ-helper";
  manifest
    .files
    .push(file_entry(extra_exe, FileRole::RuntimeArtifact, extra_bytes));
  let mut files = paddleocr_package_files();
  files.push((extra_exe, extra_bytes.as_slice()));
  let err = load_builtin(&manifest, &files).expect_err("second executable must fail");
  assert!(
    err.message.contains("one executable") || err.message.contains("executable"),
    "unexpected: {}",
    err.message
  );
}

#[test]
fn paddleocr_package_rejects_http_model_url() {
  let mut manifest = parse_valid_paddleocr_manifest();
  let resource = manifest.model_resources.as_mut().unwrap().first_mut().unwrap();
  resource.artifacts[0].url = resource.artifacts[0].url.replacen("https://", "http://", 1);
  let err = load_builtin(&manifest, &paddleocr_package_files()).expect_err("http model URL must fail");
  assert!(err.message.contains("https"), "unexpected: {}", err.message);
}

#[test]
fn paddleocr_package_rejects_non_allowlisted_native_plugin_id() {
  let mut manifest = parse_valid_paddleocr_manifest();
  manifest.id = "com.example.native-ocr".into();
  let err = load_builtin(&manifest, &paddleocr_package_files()).expect_err("non-allowlisted native plugin must fail");
  assert_eq!(err.code, PluginLoadErrorCode::NativeNotAllowlisted);
  assert!(
    err.message.contains("allowlist") || err.message.contains("native worker"),
    "unexpected: {}",
    err.message
  );
}

#[test]
fn paddleocr_package_rejects_non_allowlisted_native_version() {
  let mut manifest = parse_valid_paddleocr_manifest();
  manifest.version = "9.9.9".into();
  let err = load_builtin(&manifest, &paddleocr_package_files()).expect_err("non-allowlisted native version must fail");
  assert_eq!(err.code, PluginLoadErrorCode::NativeNotAllowlisted);
}

#[test]
fn paddleocr_package_rejects_python_script_payload() {
  let mut manifest = parse_valid_paddleocr_manifest();
  let script = "runtime/setup.py";
  let script_bytes = b"print('no')";
  manifest.files.push(file_entry(script, FileRole::Other, script_bytes));
  let mut files = paddleocr_package_files();
  files.push((script, script_bytes.as_slice()));
  let err = load_builtin(&manifest, &files).expect_err("python payload must fail");
  assert!(
    err.message.contains("prohibited") || err.message.contains("closed allowlist") || err.message.contains("Other"),
    "unexpected: {}",
    err.message
  );
}

#[test]
fn paddleocr_package_rejects_disguised_exe_under_license_role() {
  let mut manifest = parse_valid_paddleocr_manifest();
  let helper = "licenses/notice.exe";
  let helper_bytes = b"MZ-helper";
  manifest.files.push(file_entry(helper, FileRole::License, helper_bytes));
  let mut files = paddleocr_package_files();
  files.push((helper, helper_bytes.as_slice()));
  let err = load_builtin(&manifest, &files).expect_err("disguised exe under license must fail");
  assert!(
    err.message.contains("disguised payload") || err.message.contains("prohibited"),
    "unexpected: {}",
    err.message
  );
}

#[test]
fn paddleocr_package_rejects_disguised_dll_under_schema_role() {
  let mut manifest = parse_valid_paddleocr_manifest();
  let helper = "schemas/config.dll";
  let helper_bytes = b"MZ-dll";
  manifest
    .files
    .push(file_entry(helper, FileRole::ConfigSchema, helper_bytes));
  let mut files = paddleocr_package_files();
  files.push((helper, helper_bytes.as_slice()));
  let err = load_builtin(&manifest, &files).expect_err("disguised dll under schema must fail");
  assert!(
    err.message.contains("disguised payload") || err.message.contains("ancillary") || err.message.contains(".json"),
    "unexpected: {}",
    err.message
  );
}

#[test]
fn paddleocr_package_rejects_non_closed_role_and_empty_targets() {
  let mut manifest = parse_valid_paddleocr_manifest();
  let helper = "assets/helper.exe";
  let helper_bytes = b"MZ-helper";
  manifest.files.push(file_entry(helper, FileRole::Other, helper_bytes));
  let mut files = paddleocr_package_files();
  files.push((helper, helper_bytes.as_slice()));
  let err = load_builtin(&manifest, &files).expect_err("FileRole::Other must fail closed-set");
  assert!(
    err.message.contains("closed allowlist") || err.message.contains("not on the closed"),
    "unexpected: {}",
    err.message
  );

  let mut empty_targets = parse_valid_paddleocr_manifest();
  empty_targets.targets.clear();
  let err = load_builtin(&empty_targets, &paddleocr_package_files()).expect_err("empty targets must fail");
  assert!(
    err.message.contains("exactly one windows/x86_64") || err.message.contains("windows/x86_64"),
    "unexpected: {}",
    err.message
  );
}
