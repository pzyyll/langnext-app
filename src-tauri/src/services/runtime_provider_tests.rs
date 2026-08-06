// ABOUTME: Provider runtime fixture package, catalog, and lifecycle integration tests.
// ABOUTME: Real verifier/SQLite/Wasm runtime; fixture trust only; no credentials or network.
#![cfg(test)]

use crate::domain::cancel::CancelToken;
use crate::domain::provider::{
  AuthSchemeV1, BaseUrlSource, CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode,
};
use crate::domain::runtime_plugin::{
  CapabilityDeclaration, FileRole, HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID,
  PROVIDER_RUNTIME_ENDPOINT_FORM_PROVIDER_INSTANCE, PermissionRequests, PluginFileEntry, PluginManifestV1,
  ProviderRuntimeDeclaration, ProviderRuntimeDetectionDecl, ProviderRuntimeEndpointDecl, PublisherDeclaration,
  RuntimeDescriptor, RuntimeKind,
};
use crate::domain::runtime_provider::{
  ApplyProviderRuntimeUpgradeInput, ProviderRuntimeKind, ProviderRuntimeState, legacy_frontend_binding,
};
use crate::repositories::{plugin_permission_grants, provider_instances, provider_runtime_bindings};
use crate::services::bounded_http::{BoundedHttpResponse, PreparedHttpRequest, RawHttpTransport};
use crate::services::plugin_package::test_support;
use crate::services::plugin_store::PluginPackageService;
use crate::services::provider_runtime_router::ProviderRuntimeBrokerContext;
use crate::services::runtime_providers::{ProviderRuntimeCatalog, ProviderRuntimeService};
use crate::services::vendor_trust::test_vendor_fixture;
use crate::services::wasm_runtime::WasmRuntime;
use crate::storage::Database;
use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use uuid::Uuid;

/// Committed dev-signed two-world provider runtime fixture package (Task 2).
const LLM_PROVIDER_PACKAGE: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/fixtures/packages/llm-provider-valid.lnplugin"
));
/// Committed llm-models-world conformance Component artifact.
const LLM_MODELS_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/llm-provider/fixtures/llm-models.wasm"
));
/// Committed llm-chat-world conformance Component artifact.
const LLM_CHAT_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/llm-provider/fixtures/llm-chat.wasm"
));
/// translate-text-world Component used to prove an artifact instantiating the wrong world is rejected.
const TRANSLATE_WORLD_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-component/fixtures/langnext-conformance-wasm.wasm"
));

/// Committed dev-signed OpenAI Compatible provider runtime package fixture (Task 11).
const OPENAI_COMPATIBLE_PACKAGE: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/fixtures/packages/com.langnext.provider.openai-compatible-1.0.0.lnplugin"
));
/// Committed llm-models-world OpenAI Compatible Component artifact.
const OPENAI_COMPATIBLE_MODELS_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/fixtures/llm-models.wasm"
));
/// Committed llm-chat-world OpenAI Compatible Component artifact.
const OPENAI_COMPATIBLE_CHAT_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/fixtures/llm-chat.wasm"
));

/// Committed dev-signed OpenAI Responses provider runtime package fixture (Task 18).
const OPENAI_RESPONSES_PACKAGE: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-responses/fixtures/packages/com.langnext.provider.openai-responses-1.0.0.lnplugin"
));
/// Committed llm-models-world OpenAI Responses Component artifact.
const OPENAI_RESPONSES_MODELS_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-responses/fixtures/llm-models.wasm"
));
/// Committed llm-chat-world OpenAI Responses Component artifact.
const OPENAI_RESPONSES_CHAT_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-responses/fixtures/llm-chat.wasm"
));

/// Committed dev-signed Anthropic provider runtime package fixture (Task 19).
const ANTHROPIC_PACKAGE: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/fixtures/packages/com.langnext.provider.anthropic-1.0.0.lnplugin"
));
/// Committed llm-models-world Anthropic Component artifact.
const ANTHROPIC_MODELS_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/fixtures/llm-models.wasm"
));
/// Committed llm-chat-world Anthropic Component artifact.
const ANTHROPIC_CHAT_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/fixtures/llm-chat.wasm"
));

/// Ported fixed provider fixtures (current TypeScript OpenAI Compatible plugin). The expected
/// request bodies are committed fixture literals; the test never recomputes wire payloads.
const OPENAI_COMPATIBLE_MODELS_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/tests/fixtures/models-list.json"
));
const OPENAI_COMPATIBLE_CHAT_COMPLETE_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/tests/fixtures/chat-complete.json"
));
const OPENAI_COMPATIBLE_CHAT_REQUEST_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/tests/fixtures/chat-request.json"
));
const OPENAI_COMPATIBLE_CHAT_REQUEST_STREAM_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/tests/fixtures/chat-request-stream.json"
));
const OPENAI_COMPATIBLE_CHAT_REQUEST_IMAGE_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/tests/fixtures/chat-request-image.json"
));
const OPENAI_COMPATIBLE_CHAT_STREAM_SSE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/tests/fixtures/chat-stream.sse"
));
const OPENAI_COMPATIBLE_RATE_LIMITED_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/tests/fixtures/error-rate-limited.json"
));
const OPENAI_COMPATIBLE_MALFORMED_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/tests/fixtures/malformed.txt"
));

/// Ported fixed provider fixtures (current TypeScript OpenAI Responses plugin). The expected
/// request bodies are committed fixture literals; the test never recomputes wire payloads.
const OPENAI_RESPONSES_MODELS_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-responses/tests/fixtures/models-list.json"
));
const OPENAI_RESPONSES_CHAT_COMPLETE_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-responses/tests/fixtures/chat-complete.json"
));
const OPENAI_RESPONSES_CHAT_REQUEST_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-responses/tests/fixtures/chat-request.json"
));
const OPENAI_RESPONSES_CHAT_REQUEST_STREAM_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-responses/tests/fixtures/chat-request-stream.json"
));
const OPENAI_RESPONSES_CHAT_REQUEST_IMAGE_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-responses/tests/fixtures/chat-request-image.json"
));
const OPENAI_RESPONSES_CHAT_STREAM_SSE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-responses/tests/fixtures/chat-stream.sse"
));
const OPENAI_RESPONSES_RATE_LIMITED_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-responses/tests/fixtures/error-rate-limited.json"
));
const OPENAI_RESPONSES_MALFORMED_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-responses/tests/fixtures/malformed.txt"
));

/// Ported fixed provider fixtures (current TypeScript Anthropic plugin). Page 1 carries a
/// continuation cursor; page 2 closes the aggregate. The expected request bodies are committed
/// fixture literals; the test never recomputes wire payloads.
const ANTHROPIC_MODELS_PAGE_1_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/tests/fixtures/models-page-1.json"
));
const ANTHROPIC_MODELS_PAGE_2_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/tests/fixtures/models-page-2.json"
));
const ANTHROPIC_CHAT_COMPLETE_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/tests/fixtures/chat-complete.json"
));
const ANTHROPIC_CHAT_REQUEST_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/tests/fixtures/chat-request.json"
));
const ANTHROPIC_CHAT_REQUEST_STREAM_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/tests/fixtures/chat-request-stream.json"
));
const ANTHROPIC_CHAT_REQUEST_IMAGE_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/tests/fixtures/chat-request-image.json"
));
const ANTHROPIC_CHAT_STREAM_SSE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/tests/fixtures/chat-stream.sse"
));
const ANTHROPIC_RATE_LIMITED_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/tests/fixtures/error-rate-limited.json"
));
const ANTHROPIC_MALFORMED_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/anthropic/tests/fixtures/malformed.txt"
));

/// Committed dev-signed Gemini provider runtime package fixture (Task 20).
const GEMINI_PACKAGE: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/fixtures/packages/com.langnext.provider.gemini-1.0.0.lnplugin"
));
/// Committed llm-models-world Gemini Component artifact.
const GEMINI_MODELS_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/fixtures/llm-models.wasm"
));
/// Committed llm-chat-world Gemini Component artifact.
const GEMINI_CHAT_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/fixtures/llm-chat.wasm"
));

/// Ported fixed provider fixtures (current TypeScript Gemini plugin). The expected request
/// bodies are committed fixture literals; the test never recomputes wire payloads. Page 1
/// carries a `nextPageToken` cursor; page 2 closes the aggregate; the repeated-token page
/// returns the SAME cursor as page 1 to prove loop rejection inside the Models guest.
const GEMINI_MODELS_PAGE_1_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/models-page-1.json"
));
const GEMINI_MODELS_PAGE_2_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/models-page-2.json"
));
const GEMINI_MODELS_PAGE_REPEATED_TOKEN_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/models-page-repeated-token.json"
));
const GEMINI_MODELS_PAGE_CURSOR_2_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/models-page-cursor-2.json"
));
const GEMINI_MODELS_PAGE_CURSOR_3_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/models-page-cursor-3.json"
));
const GEMINI_CHAT_COMPLETE_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/chat-complete.json"
));
const GEMINI_CHAT_REQUEST_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/chat-request.json"
));
const GEMINI_CHAT_REQUEST_STREAM_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/chat-request-stream.json"
));
const GEMINI_CHAT_REQUEST_IMAGE_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/chat-request-image.json"
));
const GEMINI_CHAT_STREAM_SSE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/chat-stream.sse"
));
const GEMINI_RATE_LIMITED_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/error-rate-limited.json"
));
const GEMINI_MALFORMED_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/gemini/tests/fixtures/malformed.txt"
));

/// Committed dev-signed DeepSeek provider runtime package fixture (Task 21).
const DEEPSEEK_PACKAGE: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/fixtures/packages/com.langnext.provider.deepseek-1.0.0.lnplugin"
));
/// Committed llm-models-world DeepSeek Component artifact.
const DEEPSEEK_MODELS_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/fixtures/llm-models.wasm"
));
/// Committed llm-chat-world DeepSeek Component artifact.
const DEEPSEEK_CHAT_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/fixtures/llm-chat.wasm"
));

/// Ported fixed provider fixtures (current TypeScript DeepSeek plugin). The expected request
/// bodies are committed fixture literals; the test never recomputes wire payloads. The
/// thinking-enabled fixture proves the guest derives thinking policy from the host envelope.
const DEEPSEEK_MODELS_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/tests/fixtures/models-list.json"
));
const DEEPSEEK_CHAT_COMPLETE_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/tests/fixtures/chat-complete.json"
));
const DEEPSEEK_CHAT_REQUEST_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/tests/fixtures/chat-request.json"
));
const DEEPSEEK_CHAT_REQUEST_STREAM_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/tests/fixtures/chat-request-stream.json"
));
const DEEPSEEK_CHAT_REQUEST_THINKING_ENABLED_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/tests/fixtures/chat-request-thinking-enabled.json"
));
const DEEPSEEK_CHAT_REQUEST_IMAGE_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/tests/fixtures/chat-request-image.json"
));
const DEEPSEEK_CHAT_STREAM_SSE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/tests/fixtures/chat-stream.sse"
));
const DEEPSEEK_RATE_LIMITED_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/tests/fixtures/error-rate-limited.json"
));
const DEEPSEEK_MALFORMED_BODY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/deepseek/tests/fixtures/malformed.txt"
));
/// Static component that imports a non-langnext interface (WASI-like foreign import).
const FOREIGN_IMPORT_WAT: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-component/tests/fixtures/undeclared-import.wat"
));

const MODELS_ARTIFACT: &str = "fixtures/llm-models.wasm";
const CHAT_ARTIFACT: &str = "fixtures/llm-chat.wasm";

fn sha256_hex(bytes: &[u8]) -> String {
  use sha2::{Digest, Sha256};
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Build a vendor-signed provider-runtime package (dev fixture key).
fn vendor_signed_package(manifest: &PluginManifestV1, files: &[(&str, &[u8])]) -> Vec<u8> {
  test_support::build_signed_package_with_key(manifest, files, &test_vendor_fixture::fixture_vendor_signing_key())
}

/// Build a vendor-signed package from raw manifest JSON bytes (unknown-field cases cannot
/// deserialize into `PluginManifestV1`, so the raw signed bytes must reach the verifier).
fn vendor_signed_package_raw(manifest_json: &[u8], files: &[(&str, &[u8])]) -> Vec<u8> {
  use ed25519_dalek::Signer;
  use std::io::Write;
  let signature = test_vendor_fixture::fixture_vendor_signing_key()
    .sign(manifest_json)
    .to_bytes()
    .to_vec();
  let mut cursor = std::io::Cursor::new(Vec::new());
  {
    let mut zip = zip::ZipWriter::new(&mut cursor);
    let options = zip::write::SimpleFileOptions::default()
      .compression_method(zip::CompressionMethod::Deflated)
      .unix_permissions(0o644);
    zip
      .start_file(crate::domain::runtime_plugin::MANIFEST_FILE_PATH, options)
      .unwrap();
    zip.write_all(manifest_json).unwrap();
    let mut ordered: Vec<(&str, &[u8])> = files.to_vec();
    ordered.sort_by(|a, b| a.0.cmp(b.0));
    for (path, bytes) in ordered {
      zip.start_file(path, options).unwrap();
      zip.write_all(bytes).unwrap();
    }
    zip
      .start_file(crate::domain::runtime_plugin::SIGNATURE_FILE_PATH, options)
      .unwrap();
    zip.write_all(&signature).unwrap();
    zip.finish().unwrap();
  }
  cursor.into_inner()
}

/// Compute the signed file index for the two LLM artifact files.
fn llm_file_entries() -> Vec<PluginFileEntry> {
  vec![
    PluginFileEntry {
      path: MODELS_ARTIFACT.into(),
      role: FileRole::RuntimeArtifact,
      bytes: LLM_MODELS_COMPONENT.len() as u64,
      sha256: sha256_hex(LLM_MODELS_COMPONENT),
    },
    PluginFileEntry {
      path: CHAT_ARTIFACT.into(),
      role: FileRole::RuntimeArtifact,
      bytes: LLM_CHAT_COMPONENT.len() as u64,
      sha256: sha256_hex(LLM_CHAT_COMPONENT),
    },
  ]
}

/// File entries computed over arbitrary artifact bytes (table-case packages).
fn file_entries(artifacts: &[(&str, &[u8])]) -> Vec<PluginFileEntry> {
  artifacts
    .iter()
    .map(|(path, bytes)| PluginFileEntry {
      path: (*path).into(),
      role: FileRole::RuntimeArtifact,
      bytes: bytes.len() as u64,
      sha256: sha256_hex(bytes),
    })
    .collect()
}

/// Build a provider-runtime manifest with the given declaration, capability artifact map,
/// and artifacts. Capability declarations mirror the providerRuntime map (fail-closed cross-check).
fn provider_runtime_manifest(
  declaration: ProviderRuntimeDeclaration,
  capability_artifacts: &[(&str, &str)],
  artifacts: &[(&str, &[u8])],
) -> PluginManifestV1 {
  let mut files = file_entries(artifacts);
  files.sort_by(|a, b| a.path.cmp(&b.path));
  let runtime_artifact = capability_artifacts
    .first()
    .map(|(_, path)| (*path).to_string())
    .unwrap_or_else(|| MODELS_ARTIFACT.to_string());
  let capabilities = capability_artifacts
    .iter()
    .map(|(id, path)| CapabilityDeclaration {
      id: (*id).into(),
      preferences_schema: None,
      artifact: Some((*path).into()),
    })
    .collect();
  PluginManifestV1 {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: "langnext.conformance.llm-provider".into(),
    version: "1.0.0".into(),
    publisher: PublisherDeclaration {
      key_id: crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID.into(),
      key_fingerprint: test_vendor_fixture::fixture_vendor_fingerprint(),
    },
    runtime: RuntimeDescriptor {
      kind: RuntimeKind::WasmComponent,
      artifact: Some(runtime_artifact),
      native_protocol_version: None,
      native_dependencies: None,
    },
    targets: vec![],
    files,
    capabilities,
    configuration_schema: None,
    config_schema_version: None,
    credential_slots: vec![],
    permissions: PermissionRequests {
      network: vec![],
      auth_policies: vec![HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID.into()],
    },
    ui: Default::default(),
    provider_runtime: Some(declaration),
    model_resources: None,
  }
}

/// Valid provider runtime declaration used by the fixture and positive table cases.
fn valid_declaration() -> ProviderRuntimeDeclaration {
  ProviderRuntimeDeclaration {
    legacy_aliases: vec!["openai-compatible".into()],
    capabilities: BTreeMap::from([
      ("llm.models.list@1".to_string(), MODELS_ARTIFACT.to_string()),
      ("llm.chat@1".to_string(), CHAT_ARTIFACT.to_string()),
    ]),
    endpoint: ProviderRuntimeEndpointDecl {
      form: PROVIDER_RUNTIME_ENDPOINT_FORM_PROVIDER_INSTANCE.into(),
      auth_policy: HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID.into(),
    },
    detection: Some(ProviderRuntimeDetectionDecl {
      max_tokens: 256,
      thinking: false,
    }),
  }
}

/// OpenAI Compatible package manifest (Task 11/12): the production plugin id/version with the
/// same two-artifact capability map and closed provider-instance declaration.
fn openai_compatible_manifest(artifacts: &[(&str, &[u8])]) -> PluginManifestV1 {
  let mut manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    artifacts,
  );
  manifest.id = "com.langnext.provider.openai-compatible".into();
  manifest.version = "1.0.0".into();
  manifest
}

/// OpenAI Responses package manifest (Task 18): the production plugin id/version with the
/// same two-artifact capability map and closed provider-instance declaration.
fn openai_responses_manifest(artifacts: &[(&str, &[u8])]) -> PluginManifestV1 {
  let mut manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    artifacts,
  );
  manifest.id = "com.langnext.provider.openai-responses".into();
  manifest.version = "1.0.0".into();
  manifest
}

/// Anthropic package manifest (Task 19): the production plugin id/version with the same
/// two-artifact capability map and closed provider-instance declaration.
fn anthropic_manifest(artifacts: &[(&str, &[u8])]) -> PluginManifestV1 {
  let mut manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    artifacts,
  );
  manifest.id = "com.langnext.provider.anthropic".into();
  manifest.version = "1.0.0".into();
  manifest
}

/// Gemini package manifest (Task 20): the production plugin id/version, the gemini legacy
/// alias, and the host-interpreted detection defaults (DEFAULT_DETECT_MAX_TOKENS = 256).
fn gemini_manifest(artifacts: &[(&str, &[u8])]) -> PluginManifestV1 {
  let mut manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    artifacts,
  );
  manifest.id = "com.langnext.provider.gemini".into();
  manifest.version = "1.0.0".into();
  if let Some(declaration) = manifest.provider_runtime.as_mut() {
    declaration.legacy_aliases = vec!["gemini".into()];
  }
  manifest
}

/// DeepSeek package manifest (Task 21): the production plugin id/version, the deepseek legacy
/// alias, and the host-interpreted detection defaults (thinking disabled with the raised
/// 2048-token budget from the current TypeScript plugin).
fn deepseek_manifest(artifacts: &[(&str, &[u8])]) -> PluginManifestV1 {
  let mut manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    artifacts,
  );
  manifest.id = "com.langnext.provider.deepseek".into();
  manifest.version = "1.0.0".into();
  if let Some(declaration) = manifest.provider_runtime.as_mut() {
    declaration.legacy_aliases = vec!["deepseek".into()];
    declaration.detection = Some(ProviderRuntimeDetectionDecl {
      max_tokens: 2048,
      thinking: false,
    });
  }
  manifest
}

/// Fresh plugin store with the vendor fixture root, plus a Wasm runtime.
fn setup() -> (tempfile::TempDir, Database, PluginPackageService, Arc<WasmRuntime>) {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages = PluginPackageService::with_vendor_roots(
    db.clone(),
    dir.path().to_path_buf(),
    vec![test_vendor_fixture::fixture_vendor_public_key()],
  );
  let wasm = Arc::new(WasmRuntime::new().unwrap());
  (dir, db, packages, wasm)
}

/// Install package bytes through the real verifier (vendor root), returning the verified digest.
fn install(packages: &PluginPackageService, bytes: &[u8]) -> String {
  let imported = packages.bootstrap_bundled_package(bytes, false).unwrap();
  imported.package_digest().to_string()
}

/// Extract the underlying message from a bootstrap failure (Capability errors carry the
/// contract message outside `Display`).
fn error_message(err: crate::error::StorageError) -> String {
  match err {
    crate::error::StorageError::Capability { message, .. } => message,
    other => other.to_string(),
  }
}

#[test]
fn provider_runtime_fixture_package_verifies_and_projects_catalog() {
  let (_dir, db, packages, wasm) = setup();
  let digest = install(&packages, LLM_PROVIDER_PACKAGE);
  assert!(!digest.is_empty());

  let catalog = ProviderRuntimeCatalog::new(db, packages, wasm);
  let entries = catalog.list().unwrap();
  assert_eq!(
    entries.len(),
    1,
    "only the one valid provider package projects catalog metadata"
  );
  let entry = &entries[0];
  assert_eq!(entry.plugin_id, "langnext.conformance.llm-provider");
  assert_eq!(entry.version, "1.0.0");
  assert_eq!(entry.package_digest, digest);
  assert_eq!(
    entry.publisher.key_id,
    crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID
  );
  assert_eq!(
    entry.publisher.key_fingerprint,
    test_vendor_fixture::fixture_vendor_fingerprint()
  );
  // Fixed bounded legacy alias projection.
  assert_eq!(entry.legacy_aliases, vec!["openai-compatible".to_string()]);
  // Exact capability/artifact identity with distinct artifact digests.
  assert_eq!(entry.capabilities.len(), 2);
  let models = entry
    .capabilities
    .iter()
    .find(|c| c.capability_id == "llm.models.list@1")
    .expect("models list capability projected");
  let chat = entry
    .capabilities
    .iter()
    .find(|c| c.capability_id == "llm.chat@1")
    .expect("chat capability projected");
  assert_eq!(models.artifact_path, MODELS_ARTIFACT);
  assert_eq!(chat.artifact_path, CHAT_ARTIFACT);
  assert_eq!(models.artifact_digest, sha256_hex(LLM_MODELS_COMPONENT));
  assert_eq!(chat.artifact_digest, sha256_hex(LLM_CHAT_COMPONENT));
  assert_ne!(models.artifact_digest, chat.artifact_digest);
  // Bounded host-owned detection defaults are projected, not guest authority.
  let detection = entry.detection.as_ref().expect("detection defaults projected");
  assert_eq!(detection.max_tokens, 256);
  assert!(!detection.thinking);

  // --- Fail-closed table cases. Every malformed/ambiguous/WASI case must be rejected by the
  // real verifier (install) or the catalog projection (world/import checks). ---
  fn manifest_bytes(m: &PluginManifestV1) -> Vec<u8> {
    serde_json::to_vec(m).unwrap()
  }

  // Case: missing Models List artifact in the providerRuntime declaration.
  {
    let mut decl = valid_declaration();
    decl.capabilities.remove("llm.models.list@1");
    let manifest = provider_runtime_manifest(
      decl,
      &[("llm.chat@1", CHAT_ARTIFACT)],
      &[(CHAT_ARTIFACT, LLM_CHAT_COMPONENT)],
    );
    let package = vendor_signed_package(&manifest, &[(CHAT_ARTIFACT, LLM_CHAT_COMPONENT)]);
    let (_dir, _db, packages, _wasm) = setup();
    let err = error_message(packages.bootstrap_bundled_package(&package, false).unwrap_err());
    let msg = err.to_lowercase();
    assert!(
      msg.contains("providerruntime") || msg.contains("llm.models.list"),
      "missing models case: {msg}"
    );
  }

  // Case: missing Chat artifact in the providerRuntime declaration.
  {
    let mut decl = valid_declaration();
    decl.capabilities.remove("llm.chat@1");
    let manifest = provider_runtime_manifest(
      decl,
      &[("llm.models.list@1", MODELS_ARTIFACT)],
      &[(MODELS_ARTIFACT, LLM_MODELS_COMPONENT)],
    );
    let package = vendor_signed_package(&manifest, &[(MODELS_ARTIFACT, LLM_MODELS_COMPONENT)]);
    let (_dir, _db, packages, _wasm) = setup();
    let err = error_message(packages.bootstrap_bundled_package(&package, false).unwrap_err());
    let msg = err.to_lowercase();
    assert!(
      msg.contains("providerruntime") || msg.contains("llm.chat@1"),
      "missing chat case: {msg}"
    );
  }

  // Case: duplicate legacy alias.
  {
    let mut decl = valid_declaration();
    decl.legacy_aliases = vec!["openai-compatible".into(), "openai-compatible".into()];
    let manifest = provider_runtime_manifest(
      decl,
      &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let package = vendor_signed_package(
      &manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let (_dir, _db, packages, _wasm) = setup();
    let err = error_message(packages.bootstrap_bundled_package(&package, false).unwrap_err());
    let msg = err.to_lowercase();
    assert!(msg.contains("alias"), "duplicate alias case: {msg}");
  }

  // Case: both capabilities target one artifact/digest.
  {
    let mut decl = valid_declaration();
    decl.capabilities.insert("llm.chat@1".into(), MODELS_ARTIFACT.into());
    let manifest = provider_runtime_manifest(
      decl,
      &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", MODELS_ARTIFACT)],
      &[(MODELS_ARTIFACT, LLM_MODELS_COMPONENT)],
    );
    let package = vendor_signed_package(&manifest, &[(MODELS_ARTIFACT, LLM_MODELS_COMPONENT)]);
    let (_dir, _db, packages, _wasm) = setup();
    let err = error_message(packages.bootstrap_bundled_package(&package, false).unwrap_err());
    let msg = err.to_lowercase();
    assert!(
      msg.contains("artifact") || msg.contains("distinct"),
      "shared artifact case: {msg}"
    );
  }

  // Case: unknown providerRuntime field is rejected at parse (deny-unknown).
  {
    let json = serde_json::to_vec(&serde_json::json!({
      "manifestVersion": 1,
      "pluginApiVersion": "1.0",
      "id": "langnext.conformance.llm-provider",
      "version": "1.0.0",
      "publisher": {
        "keyId": crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID,
        "keyFingerprint": test_vendor_fixture::fixture_vendor_fingerprint()
      },
      "runtime": { "kind": "wasm-component", "artifact": MODELS_ARTIFACT },
      "files": file_entries(&[(MODELS_ARTIFACT, LLM_MODELS_COMPONENT), (CHAT_ARTIFACT, LLM_CHAT_COMPONENT)]),
      "capabilities": [
        { "id": "llm.models.list@1", "artifact": MODELS_ARTIFACT },
        { "id": "llm.chat@1", "artifact": CHAT_ARTIFACT }
      ],
      "credentialSlots": [],
      "permissions": { "network": [], "authPolicies": [HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID] },
      "ui": { "mode": "schema", "pages": [] },
      "providerRuntime": {
        "legacyAliases": ["openai-compatible"],
        "capabilities": {
          "llm.models.list@1": MODELS_ARTIFACT,
          "llm.chat@1": CHAT_ARTIFACT
        },
        "endpoint": { "form": "provider-instance", "authPolicy": HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID },
        "bogusField": true
      }
    }))
    .unwrap();
    let package = vendor_signed_package_raw(
      &json,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let (_dir, _db, packages, _wasm) = setup();
    let err = error_message(packages.bootstrap_bundled_package(&package, false).unwrap_err());
    let msg = err.to_lowercase();
    assert!(
      msg.contains("unknown field") || msg.contains("providerruntime"),
      "unknown field case: {msg}"
    );
  }

  // Case: unsupported detection values (zero and over-bound max tokens).
  for bad_max_tokens in [0u32, 1_000_000u32] {
    let mut decl = valid_declaration();
    decl.detection = Some(ProviderRuntimeDetectionDecl {
      max_tokens: bad_max_tokens,
      thinking: false,
    });
    let manifest = provider_runtime_manifest(
      decl,
      &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let package = vendor_signed_package(
      &manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let (_dir, _db, packages, _wasm) = setup();
    let err = error_message(packages.bootstrap_bundled_package(&package, false).unwrap_err());
    let msg = err.to_lowercase();
    assert!(
      msg.contains("detection") || msg.contains("max_tokens"),
      "detection case: {msg}"
    );
  }

  // Case: incorrect provider-instance authority — wrong endpoint form.
  {
    let mut decl = valid_declaration();
    decl.endpoint = ProviderRuntimeEndpointDecl {
      form: "package-selected".into(),
      auth_policy: HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID.into(),
    };
    let manifest = provider_runtime_manifest(
      decl,
      &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let package = vendor_signed_package(
      &manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let (_dir, _db, packages, _wasm) = setup();
    let err = error_message(packages.bootstrap_bundled_package(&package, false).unwrap_err());
    let msg = err.to_lowercase();
    assert!(
      msg.contains("endpoint") || msg.contains("provider-instance"),
      "endpoint form case: {msg}"
    );
  }

  // Case: incorrect provider-instance authority — wrong auth policy.
  {
    let mut decl = valid_declaration();
    decl.endpoint = ProviderRuntimeEndpointDecl {
      form: PROVIDER_RUNTIME_ENDPOINT_FORM_PROVIDER_INSTANCE.into(),
      auth_policy: "host.custom-provider-auth.v1".into(),
    };
    let manifest = provider_runtime_manifest(
      decl,
      &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let package = vendor_signed_package(
      &manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let (_dir, _db, packages, _wasm) = setup();
    let err = error_message(packages.bootstrap_bundled_package(&package, false).unwrap_err());
    let msg = err.to_lowercase();
    assert!(
      msg.contains("auth") || msg.contains("provider-instance-auth"),
      "auth policy case: {msg}"
    );
  }

  // Case: an artifact instantiating the wrong WIT world passes install (shape is valid) but
  // the catalog projection must fail closed.
  {
    let wrong_world = provider_runtime_manifest(
      valid_declaration(),
      &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
      &[
        (MODELS_ARTIFACT, TRANSLATE_WORLD_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let package = vendor_signed_package(
      &wrong_world,
      &[
        (MODELS_ARTIFACT, TRANSLATE_WORLD_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let (_dir, db, packages, wasm) = setup();
    install(&packages, &package);
    let catalog = ProviderRuntimeCatalog::new(db, packages, wasm);
    let err = catalog.list().unwrap_err();
    let msg = err.to_string().to_lowercase();
    assert!(
      msg.contains("llm-models") || msg.contains("world"),
      "wrong world case: {msg}"
    );
  }

  // Case: a guest importing anything other than langnext:runtime-plugin fails catalog projection.
  {
    let foreign_import = wat::parse_str(FOREIGN_IMPORT_WAT).unwrap();
    let foreign_manifest = provider_runtime_manifest(
      valid_declaration(),
      &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
      &[
        (MODELS_ARTIFACT, foreign_import.as_slice()),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let package = vendor_signed_package(
      &foreign_manifest,
      &[
        (MODELS_ARTIFACT, foreign_import.as_slice()),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    let (_dir, db, packages, wasm) = setup();
    install(&packages, &package);
    let catalog = ProviderRuntimeCatalog::new(db, packages, wasm);
    let err = catalog.list().unwrap_err();
    let msg = err.to_string().to_lowercase();
    assert!(
      msg.contains("import") || msg.contains("langnext"),
      "foreign import case: {msg}"
    );
  }

  // Catalog visibility is not execution authority: the fixture's bindings are still legacy
  // and no provider row references the package digest.
  let (_dir, db, packages, wasm) = setup();
  install(&packages, LLM_PROVIDER_PACKAGE);
  let catalog = ProviderRuntimeCatalog::new(db.clone(), packages, wasm);
  let entries = catalog.list().unwrap();
  assert_eq!(entries.len(), 1);
  let bindings = db
    .read(|conn| crate::repositories::provider_runtime_bindings::list(conn))
    .unwrap();
  assert!(
    bindings.is_empty(),
    "catalog visibility must not create provider bindings"
  );
}

/// Phase 8 regression: a regular installed package (no `providerRuntime` declaration) must be
/// skipped by the catalog listing, never fail it. Classification is a typed outcome, so
/// behavior cannot change when error wording changes.
#[test]
fn provider_runtime_catalog_skips_regular_packages_without_declaration() {
  let (_dir, db, packages, wasm) = setup();
  let digest = install(&packages, LLM_PROVIDER_PACKAGE);

  // The same two-artifact shape as the fixture package but WITHOUT the providerRuntime
  // declaration: a regular wasm-component plugin that must install and verify normally.
  let mut regular = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    &[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ],
  );
  regular.provider_runtime = None;
  regular.permissions = PermissionRequests {
    network: vec![],
    auth_policies: vec![],
  };
  regular.id = "langnext.conformance.regular-plugin".into();
  let package = vendor_signed_package(
    &regular,
    &[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ],
  );
  install(&packages, &package);

  let catalog = ProviderRuntimeCatalog::new(db, packages, wasm);
  let entries = catalog.list().unwrap();
  assert_eq!(
    entries.len(),
    1,
    "regular package without a providerRuntime declaration is skipped, not an error"
  );
  assert_eq!(entries[0].plugin_id, "langnext.conformance.llm-provider");
  assert_eq!(entries[0].package_digest, digest);
}

/// Capture transport shared by the Phase 8 provider-runtime tests (Tasks 5-8): records every
/// prepared request and returns one fixed fixture body.
struct RecordingTransport {
  requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
  response: BoundedHttpResponse,
}

impl RawHttpTransport for RecordingTransport {
  fn request(
    &self,
    prepared: PreparedHttpRequest,
  ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
  {
    self.requests.lock().expect("requests poisoned").push(prepared);
    let response = self.response.clone();
    Box::pin(async move { Ok(response) })
  }
  fn stream(
    &self,
    prepared: PreparedHttpRequest,
    _cancel: CancelToken,
    _on_event: Box<
      dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
    >,
  ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
    self.requests.lock().expect("requests poisoned").push(prepared);
    Box::pin(async { Ok(()) })
  }
}

/// Insert one provider row with its active legacy binding; stores `secret` under
/// `credential_ref` when both are supplied.
fn insert_provider_row(
  db: &Database,
  id: Uuid,
  name: &str,
  credential_ref: Option<String>,
  vault: &dyn crate::credentials::CredentialVault,
  secret: Option<&str>,
) {
  insert_provider_row_with(
    db,
    id,
    "openai-compatible",
    name,
    "https://api.openai.com/v1",
    AuthSchemeV1::bearer(),
    credential_ref,
    vault,
    secret,
  );
}

/// Insert a provider row with an explicit adapter/connection/auth shape plus its legacy
/// frontend binding (mirrors the migration backfill for fixture setup).
fn insert_provider_row_with(
  db: &Database,
  id: Uuid,
  adapter_id: &str,
  name: &str,
  base_url: &str,
  auth_scheme: AuthSchemeV1,
  credential_ref: Option<String>,
  vault: &dyn crate::credentials::CredentialVault,
  secret: Option<&str>,
) {
  let now = crate::domain::time::now_rfc3339();
  if let (Some(reference), Some(secret)) = (credential_ref.as_deref(), secret) {
    vault.set(reference, secret).unwrap();
  }
  db.transaction(|uow| {
    provider_instances::insert(
      uow.conn(),
      &ProviderInstance {
        id,
        adapter_id: adapter_id.into(),
        display_name: name.into(),
        base_url: base_url.into(),
        base_url_source: BaseUrlSource::PluginDefault,
        auth_scheme,
        credential_kind: CredentialKind::ApiKey,
        credential_ref,
        enabled: true,
        proxy_mode: ProxyMode::Inherit,
        insecure_http_confirmed_at: None,
        models_synced_at: None,
        models_sync_status: ModelsSyncStatus::Never,
        models_sync_error_code: None,
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    provider_runtime_bindings::insert(
      uow.conn(),
      &legacy_frontend_binding(id, adapter_id, &crate::domain::time::now_rfc3339()),
    )?;
    Ok(())
  })
  .unwrap();
}

/// Insert one manual model row whose effective API type is the Provider default.
fn insert_fixture_model(db: &Database, provider_id: Uuid, model_key: &str) -> Uuid {
  let model_id = crate::domain::time::new_id();
  let now = crate::domain::time::now_rfc3339();
  db.transaction(|uow| {
    crate::repositories::provider_models::insert(
      uow.conn(),
      &crate::domain::model::ProviderModel {
        id: model_id,
        provider_instance_id: provider_id,
        model_key: model_key.into(),
        source: crate::domain::model::ModelSource::Manual,
        remote_display_name: None,
        display_name_override: None,
        enabled: true,
        availability: crate::domain::model::Availability::Available,
        remote_metadata_json: None,
        capability_overrides_json: None,
        adapter_id: None,
        source_adapter_id: String::new(),
        last_seen_at: None,
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    Ok(())
  })
  .unwrap();
  model_id
}

/// Create one provider and activate the committed LLM fixture package on it through the real
/// lifecycle; returns `(provider_id, package_digest)`.
fn activate_fixture_provider(
  db: &Database,
  packages: PluginPackageService,
  wasm: Arc<WasmRuntime>,
  name: &str,
  vault: &dyn crate::credentials::CredentialVault,
) -> (Uuid, String) {
  let package_digest = install(&packages, LLM_PROVIDER_PACKAGE);
  let provider_id = crate::domain::time::new_id();
  insert_provider_row(
    db,
    provider_id,
    name,
    Some(format!("provider/{provider_id}/key")),
    vault,
    Some("sk-test-provider-secret"),
  );
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages, wasm);
  let preview = lifecycle.preview_upgrade(provider_id, &package_digest).unwrap();
  lifecycle
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  (provider_id, package_digest)
}

/// Phase 8 Task 6: bounded Models List execution through a verified Component. The fixture's
/// llm-models-world artifact is routed through a real provider binding/grant/broker: the fixed
/// mode fetches the provider models endpoint through the capture transport and returns the
/// fixed descriptor set; duplicate descriptors and an over-limit aggregate are rejected by the
/// host; the provider binding remains unchanged in every case.
#[tokio::test]
async fn runtime_provider_models_list_executes_verified_component() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
  use crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle;
  use crate::services::provider_runtime_router::ProviderRuntimeRouter;
  use std::collections::HashMap;

  const MODELS_FIXTURE: &str = r#"{"data":[
    {"id":"gpt-4o","label":"GPT-4o"},
    {"id":"gpt-4o-mini","label":"GPT-4o mini"},
    {"id":"gpt-4-turbo","label":"GPT-4 Turbo"}
  ]}"#;

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
  let transport = Arc::new(RecordingTransport {
    requests: requests.clone(),
    response: BoundedHttpResponse {
      status: 200,
      headers: HashMap::from([("content-type".into(), "application/json".into())]),
      body: MODELS_FIXTURE.as_bytes().to_vec(),
    },
  });

  let (provider_id, package_digest) =
    activate_fixture_provider(&db, packages.clone(), wasm.clone(), "Models Provider", vault.as_ref());

  let broker_factory: Arc<
    dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn crate::services::wasm_runtime::host::BrokerHandle> + Send + Sync,
  > = Arc::new({
    let db = db.clone();
    let vault = vault.clone();
    let transport = transport.clone();
    move |context| {
      Box::new(ProviderRuntimeBrokerHandle::new(
        db.clone(),
        vault.clone(),
        transport.clone(),
        context,
      ))
    }
  });
  let router = ProviderRuntimeRouter::new(db.clone(), packages, wasm, broker_factory);

  // Fixed model IDs/labels through the real binding/grant/broker path.
  let result = router
    .list_models(
      provider_id,
      "openai-compatible",
      "models-req-fixed",
      b"{}".to_vec(),
      CancelToken::new(),
      None,
    )
    .await
    .unwrap();
  let ids: Vec<(&str, Option<&str>)> = result
    .models
    .iter()
    .map(|model| (model.id.as_str(), model.label.as_deref()))
    .collect();
  assert_eq!(
    ids,
    vec![
      ("gpt-4o", Some("GPT-4o")),
      ("gpt-4o-mini", Some("GPT-4o mini")),
      ("gpt-4-turbo", Some("GPT-4 Turbo")),
    ]
  );
  assert_eq!(
    requests.lock().expect("requests poisoned").len(),
    1,
    "fixed mode fetches once"
  );

  // Duplicate descriptors are rejected by the host (the guest synthesizes [A, A]).
  let err = router
    .list_models(
      provider_id,
      "openai-compatible",
      "models-req-dupes",
      br#"{"mode":"duplicates"}"#.to_vec(),
      CancelToken::new(),
      None,
    )
    .await
    .unwrap_err();
  assert!(
    matches!(
      &err,
      CapabilityError {
        code: CapabilityErrorCode::InvalidResponse,
        ..
      }
    ),
    "duplicates: {err:?}"
  );

  // An over-limit aggregate is rejected by the host (the guest returns more than the named
  // host maximum model count).
  let err = router
    .list_models(
      provider_id,
      "openai-compatible",
      "models-req-overlimit",
      br#"{"mode":"over-limit"}"#.to_vec(),
      CancelToken::new(),
      None,
    )
    .await
    .unwrap_err();
  assert!(
    matches!(
      &err,
      CapabilityError {
        code: CapabilityErrorCode::InvalidResponse,
        ..
      }
    ),
    "over-limit: {err:?}"
  );

  // No extra transport request was made by the rejection modes.
  assert_eq!(requests.lock().expect("requests poisoned").len(), 1);

  // The binding is unchanged in every case.
  let binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  assert_eq!(binding.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(binding.state, ProviderRuntimeState::Active);
  assert_eq!(binding.package_digest.as_deref(), Some(package_digest.as_str()));
  assert_eq!(binding.grant_set_revision, Some(1));
}

/// Phase 8 Task 5: host-authorized provider egress. A permitted provider-runtime broker request
/// Phase 8 Task 5: host-authorized provider egress. A permitted provider-runtime broker request
/// uses ONLY the bound provider instance's persisted Base URL, proxy mode, and host-injected
/// auth header (secret from a memory vault); a provider B grant, an absolute/traversal path, a
/// sensitive caller header, or an undeclared provider-auth policy is denied before vault lookup
/// or transport. The broker is reached through the real host broker-fetch authorization path
/// (a real `PluginHostState`) for the end-to-end cases, plus the public `BrokerHandle::fetch`
/// seam for the undeclared-policy defense.
#[tokio::test]
async fn runtime_provider_broker_uses_only_bound_provider_connection() {
  use crate::credentials::{CredentialVault, MemoryCredentialVault};
  use crate::domain::cancel::CancelToken;
  use crate::domain::plugin_resource::{NetworkResponseBodyMode, NetworkResponseBodyModes};
  use crate::domain::provider::{
    AuthSchemeV1, BaseUrlSource, CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode,
  };
  use crate::domain::runtime_plugin::{AuthPolicyId, EndpointId, HttpsOrigin, NetworkOriginKind, ResourceLimits};
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeUpgradeInput, ProviderRuntimeKind, ProviderRuntimeState, legacy_frontend_binding,
  };
  use crate::repositories::{plugin_permission_grants, provider_instances, provider_runtime_bindings};
  use crate::services::bounded_http::{BoundedHttpResponse, PreparedHttpRequest, RawHttpTransport};
  use crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle;
  use crate::services::runtime_providers::ProviderRuntimeService;
  use crate::services::runtime_router::bundle_to_execution_grant_set;
  use crate::services::wasm_runtime::host::{
    BrokerAuthorization, BrokerFetchError, BrokerFetchRequest, BrokerFetchResponse, BrokerHandle, BrokerRequestBody,
    BrokerResponseBody,
  };
  use crate::services::wasm_runtime::store::new_state;
  use std::collections::HashMap;
  use std::pin::Pin;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::sync::{Arc, Mutex};
  use uuid::Uuid;

  const REQUEST_ID_PERMITTED: &str = "provider-broker-permitted";
  const SECRET_A: &str = "sk-test-provider-a-secret";

  /// Vault wrapper that counts backend reads so the test can prove denial happens BEFORE
  /// any credential lookup (secrets never leave the vault on a denied path).
  struct CountingVault {
    inner: MemoryCredentialVault,
    reads: Arc<AtomicUsize>,
  }
  impl CredentialVault for CountingVault {
    fn set(&self, account: &str, secret: &str) -> Result<(), crate::error::StorageError> {
      self.inner.set(account, secret)
    }
    fn get_for_backend_use(&self, account: &str) -> Result<String, crate::error::StorageError> {
      self.reads.fetch_add(1, Ordering::SeqCst);
      self.inner.get_for_backend_use(account)
    }
    fn delete(&self, account: &str) -> Result<(), crate::error::StorageError> {
      self.inner.delete(account)
    }
    fn exists(&self, account: &str) -> Result<bool, crate::error::StorageError> {
      self.inner.exists(account)
    }
  }

  /// Capture transport: records every prepared request and returns one fixed fixture body.
  struct RecordingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    response: BoundedHttpResponse,
  }
  impl RawHttpTransport for RecordingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let response = self.response.clone();
      Box::pin(async move { Ok(response) })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  fn insert_provider(
    db: &Database,
    id: Uuid,
    name: &str,
    credential_ref: Option<String>,
    vault: &Arc<CountingVault>,
    secret: Option<&str>,
  ) {
    let now = crate::domain::time::now_rfc3339();
    if let (Some(reference), Some(secret)) = (credential_ref.as_deref(), secret) {
      vault.set(reference, secret).unwrap();
    }
    db.transaction(|uow| {
      provider_instances::insert(
        uow.conn(),
        &ProviderInstance {
          id,
          adapter_id: "openai-compatible".into(),
          display_name: name.into(),
          base_url: "https://api.openai.com/v1".into(),
          base_url_source: BaseUrlSource::PluginDefault,
          auth_scheme: AuthSchemeV1::bearer(),
          credential_kind: CredentialKind::ApiKey,
          credential_ref,
          enabled: true,
          proxy_mode: ProxyMode::Inherit,
          insecure_http_confirmed_at: None,
          models_synced_at: None,
          models_sync_status: ModelsSyncStatus::Never,
          models_sync_error_code: None,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      provider_runtime_bindings::insert(
        uow.conn(),
        &legacy_frontend_binding(id, "openai-compatible", &crate::domain::time::now_rfc3339()),
      )?;
      Ok(())
    })
    .unwrap();
  }

  let (_dir, db, packages, wasm) = setup();
  let package_digest = install(&packages, LLM_PROVIDER_PACKAGE);

  let reads = Arc::new(AtomicUsize::new(0));
  let vault = Arc::new(CountingVault {
    inner: MemoryCredentialVault::new(),
    reads: reads.clone(),
  });
  let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
  let transport = Arc::new(RecordingTransport {
    requests: requests.clone(),
    response: BoundedHttpResponse {
      status: 200,
      headers: HashMap::from([("content-type".into(), "application/json".into())]),
      body: br#"{"data":[{"id":"gpt-4o","label":"GPT-4o"}]}"#.to_vec(),
    },
  });

  // Two real provider rows. Provider A receives the active package binding + ProviderInstance
  // grant through the real lifecycle; provider B stays legacy (no package/grant identity).
  let provider_a = crate::domain::time::new_id();
  let provider_b = crate::domain::time::new_id();
  let ref_a = format!("provider/{provider_a}/key");
  insert_provider(
    &db,
    provider_a,
    "Provider A",
    Some(ref_a.clone()),
    &vault,
    Some(SECRET_A),
  );
  insert_provider(&db, provider_b, "Provider B", None, &vault, None);
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages, wasm);
  let preview = lifecycle.preview_upgrade(provider_a, &package_digest).unwrap();
  lifecycle
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();

  let binding_a = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_a, "openai-compatible"))
    .unwrap();
  let broker = ProviderRuntimeBrokerHandle::new(
    db.clone(),
    vault.clone(),
    transport.clone(),
    ProviderRuntimeBrokerContext {
      provider_id: provider_a,
      adapter_id: "openai-compatible".into(),
      package_digest: binding_a.package_digest.clone().expect("active binding digest"),
      grant_revision: binding_a.grant_set_revision.expect("active binding revision"),
    },
  );

  // Real package/grant principal for provider A through the stored grant bundle.
  let bundle_a = db
    .read(|conn| {
      plugin_permission_grants::get_bundle_for_subject_package_revision(
        conn,
        crate::domain::runtime_lifecycle::GrantSubjectKind::ProviderInstance,
        provider_a,
        &package_digest,
        1,
      )
    })
    .unwrap();
  let grant_a = bundle_to_execution_grant_set(&bundle_a).unwrap();
  let principal_a = grant_a
    .principal_for_request("llm.models.list@1", REQUEST_ID_PERMITTED)
    .unwrap();

  fn broker_request(relative_path: &str, headers: Vec<(&str, &str)>) -> BrokerFetchRequest {
    BrokerFetchRequest {
      endpoint_id: crate::domain::runtime_plugin::PROVIDER_RUNTIME_ENDPOINT_ID.into(),
      relative_path: relative_path.into(),
      method: "GET".into(),
      headers: headers
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect(),
      body: BrokerRequestBody::Empty,
    }
  }

  // 1) Permitted: only provider A's connection reaches the capture transport.
  let mut host_state = new_state(
    principal_a.clone(),
    grant_a.clone(),
    CancelToken::new(),
    None,
    Box::new(broker.clone()),
  );
  let outcome = host_state
    .do_broker_fetch(broker_request("models", vec![("Accept", "application/json")]))
    .await;
  let response: BrokerFetchResponse = outcome.expect("permitted request succeeds");
  assert_eq!(response.status, 200);
  assert!(matches!(response.body, BrokerResponseBody::Json(_)));
  let captured = requests.lock().expect("requests poisoned");
  assert_eq!(
    captured.len(),
    1,
    "exactly one approved provider request reaches transport"
  );
  assert_eq!(
    captured[0].url.as_str(),
    "https://api.openai.com/v1/models",
    "broker joins the bound provider's persisted Base URL"
  );
  assert_eq!(
    captured[0].headers.get("Authorization").map(String::as_str),
    Some("Bearer sk-test-provider-a-secret"),
    "host injects the provider's stored credential after authorization"
  );
  assert_eq!(
    captured[0].proxy_mode,
    ProxyMode::Inherit,
    "persisted proxy mode is used"
  );
  drop(captured);

  // 2) A provider B grant (same package, different subject) is denied before vault or transport.
  let mut bundle_b = bundle_a.clone();
  bundle_b.header.subject_id = provider_b;
  let grant_b = bundle_to_execution_grant_set(&bundle_b).unwrap();
  let principal_b = grant_b
    .principal_for_request("llm.models.list@1", "provider-broker-denied-b")
    .unwrap();
  let mut host_state_b = new_state(principal_b, grant_b, CancelToken::new(), None, Box::new(broker.clone()));
  let outcome_b = host_state_b
    .do_broker_fetch(broker_request("models", vec![("Accept", "application/json")]))
    .await;
  assert!(
    matches!(outcome_b, Err(BrokerFetchError::NotApproved)),
    "provider B grant: {outcome_b:?}"
  );

  // 3) Absolute / traversal / scheme paths are denied before vault lookup or transport.
  for bad_path in ["/models", "../secret", "https://evil.example/models", "models#frag"] {
    let mut host_state_path = new_state(
      principal_a.clone(),
      grant_a.clone(),
      CancelToken::new(),
      None,
      Box::new(broker.clone()),
    );
    let outcome_path = host_state_path
      .do_broker_fetch(broker_request(bad_path, vec![("Accept", "application/json")]))
      .await;
    assert!(
      matches!(outcome_path, Err(BrokerFetchError::PathConfined)),
      "path {bad_path:?}: {outcome_path:?}"
    );
  }

  // 4) A sensitive caller header is denied before vault lookup or transport.
  let mut host_state_header = new_state(
    principal_a.clone(),
    grant_a.clone(),
    CancelToken::new(),
    None,
    Box::new(broker.clone()),
  );
  let outcome_header = host_state_header
    .do_broker_fetch(broker_request("models", vec![("Authorization", "Bearer attacker")]))
    .await;
  assert!(
    matches!(outcome_header, Err(BrokerFetchError::HeaderBlocked)),
    "sensitive caller header: {outcome_header:?}"
  );

  // 5) An undeclared provider-auth policy is denied by the broker handle itself (defense in
  // depth: the authorization is host-built, but a broker must never honor a different policy).
  let forged_authorization = BrokerAuthorization {
    endpoint_id: EndpointId::parse(crate::domain::runtime_plugin::PROVIDER_RUNTIME_ENDPOINT_ID).unwrap(),
    origin: HttpsOrigin::parse("https://provider.invalid").unwrap(),
    base_url: String::new(),
    origin_kind: NetworkOriginKind::InstanceConfigured,
    auth_policy: AuthPolicyId::parse("host.none.v1").unwrap(),
    resource_limits: ResourceLimits::default(),
    response_body_modes: NetworkResponseBodyModes::ALL,
    selected_response_mode: NetworkResponseBodyMode::Json,
  };
  let outcome_policy = broker
    .fetch(
      &principal_a,
      &grant_a,
      broker_request("models", vec![("Accept", "application/json")]),
      forged_authorization,
      &CancelToken::new(),
      None,
    )
    .await;
  assert!(
    matches!(outcome_policy, Err(BrokerFetchError::NotApproved)),
    "undeclared auth policy: {outcome_policy:?}"
  );

  // No denied path reached the vault or the transport; only the one permitted request did.
  assert_eq!(
    reads.load(Ordering::SeqCst),
    1,
    "exactly one vault read (the permitted request); every denial happened before vault lookup"
  );
  assert_eq!(
    requests.lock().expect("requests poisoned").len(),
    1,
    "no denied request reaches the transport"
  );

  // The binding is unchanged: provider A still has the exact package/grant identity.
  let binding_a = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_a, "openai-compatible"))
    .unwrap();
  assert_eq!(binding_a.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(binding_a.state, ProviderRuntimeState::Active);
  assert_eq!(binding_a.package_digest.as_deref(), Some(package_digest.as_str()));
}

/// Phase 8 provider runtime lifecycle: preview/apply/rollback through the public runtime-provider
/// command contracts (the five methods the Tauri commands wrap) backed by a real AppState,
/// SQLite database, package verifier, and fixture archive. One provider moves atomically to the
/// exact signed package + ProviderInstance grant; reuse by a second provider, a mismatched
/// per-model API Type override, and stale applies fail closed; rollback restores the legacy
/// binding and the second provider stays legacy.
#[test]
fn runtime_provider_lifecycle_binds_exact_package_and_provider_grant() {
  use crate::domain::provider::{AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ProxyMode};
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeRollbackInput, ApplyProviderRuntimeUpgradeInput, ProviderRuntimeKind,
  };
  use crate::state::AppState;

  let dir = tempfile::tempdir().unwrap();
  let state = AppState::initialize_for_tests(dir.path().to_path_buf()).unwrap();

  // Install the two-world fixture through the real package verifier (vendor root).
  let package_digest = state
    .plugin_packages
    .bootstrap_bundled_package(LLM_PROVIDER_PACKAGE, false)
    .unwrap()
    .package_digest()
    .to_string();

  fn create_provider(state: &AppState, name: &str) -> uuid::Uuid {
    state
      .providers
      .save(crate::domain::provider::ProviderInstanceWrite {
        id: None,
        adapter_id: "openai-compatible".into(),
        display_name: name.into(),
        base_url: "https://api.openai.com/v1".into(),
        base_url_source: BaseUrlSource::PluginDefault,
        auth_scheme: AuthSchemeV1::bearer(),
        credential_kind: CredentialKind::ApiKey,
        credential: CredentialUpdate::Keep,
        enabled: true,
        proxy_mode: ProxyMode::Inherit,
        insecure_http_confirmed_at: None,
        expected_updated_at: None,
      })
      .unwrap()
      .id
  }

  let provider_a = create_provider(&state, "Provider A");
  let provider_b = create_provider(&state, "Provider B");
  let provider_c = create_provider(&state, "Provider C");

  // Provider C carries a per-model API Type override that mismatches the package's declared
  // legacy alias (openai-compatible): a custom-relay override must fail closed.
  let now = crate::domain::time::now_rfc3339();
  state
    .db
    .transaction(|uow| {
      crate::repositories::provider_models::insert(
        uow.conn(),
        &crate::domain::model::ProviderModel {
          id: crate::domain::time::new_id(),
          provider_instance_id: provider_c,
          model_key: "custom-model".into(),
          source: crate::domain::model::ModelSource::Manual,
          remote_display_name: None,
          display_name_override: None,
          enabled: true,
          availability: crate::domain::model::Availability::Available,
          remote_metadata_json: None,
          capability_overrides_json: None,
          adapter_id: Some("custom-relay".into()),
          source_adapter_id: String::new(),
          last_seen_at: None,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();

  // Catalog lists the verified fixture through the public command contract.
  let entries = state.runtime_providers.list_catalog().unwrap();
  assert_eq!(entries.len(), 1);
  assert_eq!(entries[0].package_digest, package_digest);

  // Preview + apply only the first provider.
  let preview = state
    .runtime_providers
    .preview_upgrade(provider_a, &package_digest)
    .unwrap();
  assert_eq!(preview.provider_id, provider_a);
  assert!(preview.requires_permission_approval);
  assert_eq!(preview.source.runtime_kind, ProviderRuntimeKind::LegacyFrontendProvider);
  assert_eq!(preview.target.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(preview.target.package_digest.as_deref(), Some(package_digest.as_str()));
  assert_eq!(preview.legacy_aliases, vec!["openai-compatible".to_string()]);

  let applied = state
    .runtime_providers
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview.preview_id.clone(),
      acknowledge_permissions: true,
    })
    .unwrap();
  assert_eq!(applied.provider_id, provider_a);
  assert_eq!(applied.runtime.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(applied.runtime.package_digest.as_deref(), Some(package_digest.as_str()));
  assert_eq!(applied.runtime.grant_set_revision, Some(1));

  // The grant subject is exactly the first provider, at revision 1, for the exact digest.
  let (grant_count, grant_subject, grant_revision) = state
    .db
    .read(|conn| {
      let count: i64 = conn
        .query_row(
          "SELECT COUNT(*) FROM execution_grant_sets WHERE package_digest = ?1",
          rusqlite::params![package_digest],
          |row| row.get(0),
        )
        .unwrap();
      let subject: String = conn
        .query_row(
          "SELECT subject_id FROM execution_grant_sets
            WHERE subject_kind = 'provider_instance' AND package_digest = ?1",
          rusqlite::params![package_digest],
          |row| row.get(0),
        )
        .unwrap();
      let revision: i64 = conn
        .query_row(
          "SELECT revision FROM execution_grant_sets
            WHERE subject_kind = 'provider_instance' AND package_digest = ?1",
          rusqlite::params![package_digest],
          |row| row.get(0),
        )
        .unwrap();
      Ok((count, subject, revision))
    })
    .unwrap();
  assert_eq!(grant_count, 1, "one grant set exists for the package");
  assert_eq!(
    grant_subject,
    provider_a.to_string(),
    "grant subject is only provider A"
  );
  assert_eq!(grant_revision, 1);

  // Reuse of the SAME verified package by a second provider is safe: grants are scoped to
  // (provider_instance, package_digest, revision), so provider B attaches independently.
  let preview_b = state
    .runtime_providers
    .preview_upgrade(provider_b, &package_digest)
    .expect("second provider attaches the same verified package");
  let applied_b = state
    .runtime_providers
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview_b.preview_id,
      acknowledge_permissions: true,
    })
    .expect("second provider apply succeeds");
  assert_eq!(applied_b.provider_id, provider_b);
  assert_eq!(
    applied_b.runtime.grant_set_revision,
    Some(1),
    "per-provider grant revision"
  );

  // A per-model API Type override that is not attached (custom-relay) no longer blocks the
  // attach: unbound API types keep the legacy executor, so provider C attaches too.
  let preview_c = state
    .runtime_providers
    .preview_upgrade(provider_c, &package_digest)
    .expect("mismatched override does not block attach");
  state
    .runtime_providers
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview_c.preview_id,
      acknowledge_permissions: true,
    })
    .expect("provider C apply succeeds");

  let grant_counts: i64 = state
    .db
    .read(|conn| {
      Ok(
        conn
          .query_row(
            "SELECT COUNT(*) FROM execution_grant_sets WHERE subject_kind = 'provider_instance' AND package_digest = ?1",
            rusqlite::params![package_digest],
            |row| row.get(0),
          )
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(grant_counts, 3, "one exact grant per attached provider");

  // A stale apply changes nothing: the preview is one-shot, so re-applying conflicts and the
  // binding keeps the exact package/grant identity.
  let err = state
    .runtime_providers
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap_err();
  assert!(
    matches!(err, crate::error::StorageError::Conflict(_)),
    "stale apply: {err:?}"
  );
  let binding = state
    .db
    .read(|conn| crate::repositories::provider_runtime_bindings::get(conn, provider_a, "openai-compatible"))
    .unwrap();
  assert_eq!(binding.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(binding.package_digest.as_deref(), Some(package_digest.as_str()));
  assert_eq!(binding.grant_set_revision, Some(1));

  // Rollback restores the exact legacy binding for provider A.
  let rollback_preview = state.runtime_providers.preview_rollback(provider_a).unwrap();
  assert_eq!(rollback_preview.provider_id, provider_a);
  assert_eq!(
    rollback_preview.current.runtime_kind,
    ProviderRuntimeKind::WasmComponent
  );
  assert_eq!(
    rollback_preview.target.runtime_kind,
    ProviderRuntimeKind::LegacyFrontendProvider
  );
  let rolled_back = state
    .runtime_providers
    .apply_rollback(ApplyProviderRuntimeRollbackInput {
      preview_id: rollback_preview.preview_id,
    })
    .unwrap();
  assert_eq!(
    rolled_back.runtime.runtime_kind,
    ProviderRuntimeKind::LegacyFrontendProvider
  );
  assert!(rolled_back.runtime.package_digest.is_none());
  assert!(rolled_back.runtime.grant_set_revision.is_none());

  // The other providers keep their independent active bindings after A's rollback.
  let binding_b = state
    .db
    .read(|conn| crate::repositories::provider_runtime_bindings::get(conn, provider_b, "openai-compatible"))
    .unwrap();
  assert_eq!(binding_b.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(binding_b.package_digest.as_deref(), Some(package_digest.as_str()));
  let binding_c = state
    .db
    .read(|conn| crate::repositories::provider_runtime_bindings::get(conn, provider_c, "openai-compatible"))
    .unwrap();
  assert_eq!(binding_c.runtime_kind, ProviderRuntimeKind::WasmComponent);

  // Provider rows/models are untouched: all three providers still exist.
  let provider_count: i64 = state
    .db
    .read(|conn| {
      Ok(
        conn
          .query_row("SELECT COUNT(*) FROM provider_instances", [], |row| row.get(0))
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(provider_count, 3);
}

/// Phase 8 multi-interface: per-model API Type overrides are no longer globally rejected.
/// An override names the effective route; the additive executor resolver routes attached
/// types through the runtime executor and unbound types through the legacy executor. Save,
/// update, and clear keep working regardless of the provider's attached interfaces.
#[test]
fn model_api_type_override_is_additive_while_provider_runtime_active() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::model::{ManualModelWrite, ModelConfigWrite};
  use crate::services::ModelService;

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let (provider_id, _package_digest) =
    activate_fixture_provider(&db, packages, wasm, "Override Provider", vault.as_ref());
  let models = ModelService::new(db.clone(), vault.clone(), std::env::temp_dir());

  // Create a manual model while the provider runtime binding is active.
  let model = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: provider_id,
      model_key: "gpt-4o-mini".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: None,
    })
    .unwrap();

  // An unbound custom-relay override persists: routing is decided by the executor resolver
  // (unbound API types stay legacy), not by a save-time global rejection.
  models.set_adapter_id(model.id, Some("gemini".into())).unwrap();
  assert_eq!(
    models.list_by_provider(provider_id).unwrap()[0].adapter_id.as_deref(),
    Some("gemini")
  );

  // A matching declared legacy alias is allowed.
  models
    .set_adapter_id(model.id, Some("openai-compatible".into()))
    .unwrap();
  assert_eq!(
    models.list_by_provider(provider_id).unwrap()[0].adapter_id.as_deref(),
    Some("openai-compatible")
  );

  // Clearing back to inherit is allowed.
  models.set_adapter_id(model.id, None).unwrap();
  assert_eq!(models.list_by_provider(provider_id).unwrap()[0].adapter_id, None);

  // update_config keeps any well-formed override.
  models
    .update_config(ModelConfigWrite {
      id: model.id,
      display_name_override: None,
      adapter_id: Some("custom-relay".into()),
      capability_overrides_json: None,
    })
    .unwrap();
  assert_eq!(
    models.list_by_provider(provider_id).unwrap()[0].adapter_id.as_deref(),
    Some("custom-relay")
  );

  // save_manual create path accepts an unbound override too.
  let created = models
    .save_manual(ManualModelWrite {
      id: None,
      provider_instance_id: provider_id,
      model_key: "other-model".into(),
      display_name_override: None,
      enabled: true,
      capability_overrides_json: None,
      adapter_id: Some("anthropic".into()),
    })
    .unwrap();
  assert_eq!(created.adapter_id.as_deref(), Some("anthropic"));
}

/// Phase 8 provider runtime recovery: an active package binding round-trips through the public
/// configuration document as an exact but unavailable requirement — no package bytes, grants,
/// credential references, or activation authority survive the export/import boundary. Legacy
/// providers normalize to legacy-frontend-provider; older formats keep normalizing.
#[test]
fn runtime_provider_export_import_preserves_exact_requirement_without_activation() {
  use crate::domain::import_export::ImportConflictMode;
  use crate::domain::provider::{AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ProxyMode};
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeUpgradeInput, ProviderRuntimeKind, ProviderRuntimeRequirementExport, ProviderRuntimeState,
  };
  use crate::repositories::provider_runtime_bindings;
  use crate::state::AppState;

  fn create_provider(state: &AppState, name: &str) -> uuid::Uuid {
    state
      .providers
      .save(crate::domain::provider::ProviderInstanceWrite {
        id: None,
        adapter_id: "openai-compatible".into(),
        display_name: name.into(),
        base_url: "https://api.openai.com/v1".into(),
        base_url_source: BaseUrlSource::PluginDefault,
        auth_scheme: AuthSchemeV1::bearer(),
        credential_kind: CredentialKind::ApiKey,
        credential: CredentialUpdate::Keep,
        enabled: true,
        proxy_mode: ProxyMode::Inherit,
        insecure_http_confirmed_at: None,
        expected_updated_at: None,
      })
      .unwrap()
      .id
  }

  // --- Source database: one active package binding + one legacy provider. ---
  let source_dir = tempfile::tempdir().unwrap();
  let source = AppState::initialize_for_tests(source_dir.path().to_path_buf()).unwrap();
  let package_digest = source
    .plugin_packages
    .bootstrap_bundled_package(LLM_PROVIDER_PACKAGE, false)
    .unwrap()
    .package_digest()
    .to_string();
  let provider_a = create_provider(&source, "Active Provider");
  let provider_b = create_provider(&source, "Legacy Provider");
  let preview = source
    .runtime_providers
    .preview_upgrade(provider_a, &package_digest)
    .unwrap();
  source
    .runtime_providers
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();

  // --- Export through the public service. ---
  let document = source.import_export.export().unwrap();
  let json = serde_json::to_string(&document).unwrap();
  let export_a = document
    .providers
    .iter()
    .find(|p| p.id == provider_a)
    .expect("provider A exported");
  let export_b = document
    .providers
    .iter()
    .find(|p| p.id == provider_b)
    .expect("provider B exported");

  // Exact non-secret adapter-keyed runtime requirement (v8 runtimeBindings): digest,
  // publisher identity/fingerprint, plugin API version, legacy aliases, and capability ids.
  let requirements = export_a.runtime_bindings.as_slice();
  assert_eq!(
    requirements.len(),
    1,
    "one adapter-keyed requirement for the active provider"
  );
  let requirement = &requirements[0];
  assert_eq!(requirement.adapter_id.as_deref(), Some("openai-compatible"));
  assert_eq!(requirement.runtime_kind, "wasm-component");
  assert_eq!(requirement.package_digest.as_deref(), Some(package_digest.as_str()));
  assert_eq!(
    requirement.plugin_id.as_deref(),
    Some("langnext.conformance.llm-provider")
  );
  assert_eq!(requirement.plugin_version.as_deref(), Some("1.0.0"));
  assert_eq!(
    requirement.publisher_key_id.as_deref(),
    Some(crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID)
  );
  assert_eq!(
    requirement.publisher_key_fingerprint.as_deref(),
    Some(test_vendor_fixture::fixture_vendor_fingerprint()).as_deref()
  );
  assert_eq!(requirement.plugin_api_version.as_deref(), Some("1.0"));
  assert_eq!(requirement.legacy_aliases, vec!["openai-compatible".to_string()]);
  assert_eq!(
    requirement.capabilities,
    vec!["llm.chat@1".to_string(), "llm.models.list@1".to_string()]
  );
  assert!(
    export_a.runtime.is_none(),
    "v8 exports never write the singular runtime field"
  );

  // Legacy providers normalize to one legacy-frontend-provider requirement with no identity.
  let legacy_requirements = export_b.runtime_bindings.as_slice();
  assert_eq!(legacy_requirements.len(), 1);
  let legacy_requirement = &legacy_requirements[0];
  assert_eq!(legacy_requirement.adapter_id.as_deref(), Some("openai-compatible"));
  assert_eq!(legacy_requirement.runtime_kind, "legacy-frontend-provider");
  assert!(legacy_requirement.package_digest.is_none());
  assert!(legacy_requirement.plugin_api_version.is_none());

  // No executable authority, grant revision, package bytes, or secret material is exported.
  assert!(!json.contains("grantSetRevision"), "no grant revision in export");
  assert!(!json.contains("executionGrant"), "no grant content in export");
  assert!(!json.contains("credentialRef"), "no credential reference in export");
  assert!(!json.contains("provider/"), "no credential reference path in export");

  // --- Import into a clean database through public preview/import APIs. ---
  let target_dir = tempfile::tempdir().unwrap();
  let target = AppState::initialize_for_tests(target_dir.path().to_path_buf()).unwrap();
  let value = serde_json::to_value(&document).unwrap();
  let preview = target
    .import_export
    .preview_raw(value.clone(), ImportConflictMode::Merge)
    .unwrap();
  assert!(preview.valid, "import preview valid: {:?}", preview.validation_errors);
  let result = target
    .import_export
    .import_raw(value, ImportConflictMode::Merge)
    .unwrap();
  assert!(result.applied);

  // The exact package requirement is preserved as an unavailable binding: no code was
  // downloaded, no grant created, no default bind, no activation.
  let binding_a = target
    .db
    .read(|conn| provider_runtime_bindings::get(conn, provider_a, "openai-compatible"))
    .unwrap();
  assert_eq!(binding_a.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(binding_a.package_digest.as_deref(), Some(package_digest.as_str()));
  assert_eq!(binding_a.state, ProviderRuntimeState::Unavailable);
  assert!(binding_a.grant_set_revision.is_none(), "no grant revision restored");
  assert_eq!(binding_a.error_code.as_deref(), Some("plugin_unavailable"));
  let restored: ProviderRuntimeRequirementExport = serde_json::from_str(
    binding_a
      .runtime_requirement_json
      .as_deref()
      .expect("requirement persisted"),
  )
  .unwrap();
  assert_eq!(restored.package_digest.as_deref(), Some(package_digest.as_str()));
  assert_eq!(restored.plugin_api_version.as_deref(), Some("1.0"));
  assert_eq!(restored.legacy_aliases, vec!["openai-compatible".to_string()]);
  assert_eq!(restored.capabilities.len(), 2);

  // The legacy provider stayed legacy and active.
  let binding_b = target
    .db
    .read(|conn| provider_runtime_bindings::get(conn, provider_b, "openai-compatible"))
    .unwrap();
  assert_eq!(binding_b.runtime_kind, ProviderRuntimeKind::LegacyFrontendProvider);
  assert_eq!(binding_b.state, ProviderRuntimeState::Active);

  // No execution grant set and no credential reference were restored anywhere.
  let grant_count: i64 = target
    .db
    .read(|conn| {
      Ok(
        conn
          .query_row("SELECT COUNT(*) FROM execution_grant_sets", [], |row| row.get(0))
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(grant_count, 0, "import must not restore execution grants");
  let provider_row = target
    .db
    .read(|conn| crate::repositories::provider_instances::get(conn, provider_a))
    .unwrap();
  assert!(
    provider_row.credential_ref.is_none(),
    "import must not restore credential refs"
  );

  // Re-exporting the imported database preserves the exact requirement again.
  let round_trip = target.import_export.export().unwrap();
  let round_trip_requirement = round_trip
    .providers
    .iter()
    .find(|p| p.id == provider_a)
    .and_then(|p| p.runtime_bindings.first())
    .expect("round-trip requirement");
  assert_eq!(
    round_trip_requirement.package_digest.as_deref(),
    Some(package_digest.as_str())
  );
  assert_eq!(round_trip_requirement.runtime_kind, "wasm-component");
}

/// Phase 8 Task 7: complete Chat execution through a verified Component with host-owned image
/// Blobs. The fixture's llm-chat-world artifact receives the host-serialized non-stream
/// preference envelope, fetches the fixed provider chat fixture through the capture broker,
/// and returns one bounded complete message. Table cases cover fixed complete text, oversized
/// complete text, a guest error, a malformed provider body, and an unexpected streaming
/// result under `stream = false`; every case must release the input Blob and the retained
/// writer/reader endpoints (cleanup probes) and never place image bytes in WIT fields, logs,
/// DTOs, or errors.
#[tokio::test]
async fn runtime_provider_chat_complete_uses_host_mode_and_releases_all_resources() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::provider_http::ProviderHttpMethod;
  use crate::domain::runtime_provider::{LlmChatCompleteResult, LlmChatMessage, LlmChatPreferencesV1, LlmChatRequest};
  use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
  use crate::services::bounded_http::RequestBody;
  use crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle;
  use crate::services::provider_runtime_router::ProviderRuntimeRouter;
  use crate::services::wasm_runtime::host::BrokerHandle;
  use std::collections::HashMap;
  use std::sync::atomic::{AtomicBool, Ordering};

  // Fixed 1x1 transparent PNG (67 bytes). Its byte count is part of the expected wire
  // fixture below; the image bytes themselves never cross WIT semantic fields.
  const FIXED_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ];
  assert_eq!(
    FIXED_PNG.len(),
    67,
    "the fixed PNG byte count is part of the expected fixture"
  );

  // Expected provider request body (committed conformance fixture): the guest reports the
  // host preference envelope's stream flag and ONLY the image byte count — never image bytes.
  const CHAT_FIXTURE_BODY: &str = concat!(
    r#"{"image_bytes":67,"messages":[{"content":"What is the capital of France?","#,
    r#""role":"user"}],"model":"gpt-4o","preference_stream":false}"#
  );
  // Fixed provider chat completion fixture returned by the capture transport.
  const CHAT_FIXTURE_RESPONSE: &str = r#"{"message":{"role":"assistant","content":"The capital of France is Paris."}}"#;

  /// Capture transport: records every prepared request and returns one fixed fixture body.
  struct RecordingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    response: BoundedHttpResponse,
  }
  impl RawHttpTransport for RecordingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let response = self.response.clone();
      Box::pin(async move { Ok(response) })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  fn recording_transport(
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    body: &'static str,
  ) -> Arc<RecordingTransport> {
    Arc::new(RecordingTransport {
      requests,
      response: BoundedHttpResponse {
        status: 200,
        headers: HashMap::from([("content-type".into(), "application/json".into())]),
        body: body.as_bytes().to_vec(),
      },
    })
  }

  async fn run_chat_case(
    db: &Database,
    packages: PluginPackageService,
    wasm: Arc<WasmRuntime>,
    provider_model_id: uuid::Uuid,
    vault: Arc<MemoryCredentialVault>,
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    transport: Arc<RecordingTransport>,
    mode: &str,
    expected_error: Option<CapabilityErrorCode>,
  ) -> Result<LlmChatCompleteResult, CapabilityError> {
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages, wasm, broker_factory);
    let request = LlmChatRequest {
      model: "gpt-4o".into(),
      messages: vec![LlmChatMessage {
        role: "user".into(),
        content: "What is the capital of France?".into(),
      }],
      images: vec![FIXED_PNG.to_vec()],
      preferences: LlmChatPreferencesV1 {
        stream: false,
        temperature: Some(0.2),
        max_tokens: Some(64),
        thinking: false,
      },
    };
    let config = format!(r#"{{"mode":"{mode}"}}"#).into_bytes();
    let outcome = router
      .chat(
        provider_model_id,
        config,
        request,
        &format!("chat-req-{mode}"),
        CancelToken::new(),
        None,
      )
      .await;
    match expected_error {
      Some(expected) => {
        assert!(
          matches!(&outcome, Err(CapabilityError { code, .. }) if *code == expected),
          "mode {mode}: unexpected outcome {outcome:?}"
        );
        if let Err(CapabilityError { message, .. }) = &outcome {
          assert!(
            !message
              .as_bytes()
              .windows(FIXED_PNG.len())
              .any(|window| window == FIXED_PNG),
            "mode {mode}: error leaks image content: {message}"
          );
        }
      }
      None => {
        assert!(outcome.is_ok(), "mode {mode}: unexpected outcome {outcome:?}");
      }
    }
    drop(requests.lock().expect("requests poisoned"));
    outcome
  }

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let (provider_id, _package_digest) =
    activate_fixture_provider(&db, packages.clone(), wasm.clone(), "Chat Provider", vault.as_ref());
  let model_id = insert_fixture_model(&db, provider_id, "gpt-4o");

  // Cleanup probes: every complete/error path must release the input Blob and both retained
  // stream endpoints before the request store drops.
  let cleanup_probe = Arc::new(AtomicBool::new(false));
  let streams_probe = Arc::new(AtomicBool::new(false));
  wasm.set_cleanup_probe(cleanup_probe.clone());
  wasm.set_streams_cleanup_probe(streams_probe.clone());

  // 1) Fixed mode: fixed complete text + the capture broker request matches the expected
  // non-stream provider fixture; image bytes stay out of the wire body.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), CHAT_FIXTURE_RESPONSE);
    cleanup_probe.store(false, Ordering::SeqCst);
    streams_probe.store(false, Ordering::SeqCst);
    let complete = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      "fixed",
      None,
    )
    .await
    .expect("fixed mode returns a complete message");
    assert_eq!(complete.role, "assistant");
    assert_eq!(complete.content, "The capital of France is Paris.");
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1, "fixed mode fetches the provider chat endpoint once");
    assert_eq!(captured[0].method, ProviderHttpMethod::Post);
    assert_eq!(captured[0].url.as_str(), "https://api.openai.com/v1/chat");
    assert_eq!(
      captured[0].headers.get("Accept").map(String::as_str),
      Some("application/json")
    );
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, CHAT_FIXTURE_BODY,
          "capture broker request matches the fixed fixture"
        );
        assert!(
          !body
            .as_bytes()
            .windows(FIXED_PNG.len())
            .any(|window| window == FIXED_PNG),
          "image bytes must never cross as WIT fields or wire base64"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
    assert!(cleanup_probe.load(Ordering::SeqCst), "fixed mode: input Blob cleaned");
    assert!(
      streams_probe.load(Ordering::SeqCst),
      "fixed mode: writer/reader endpoints released"
    );
  }

  // 2) Oversized complete text: the host rejects the unbounded message.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), CHAT_FIXTURE_RESPONSE);
    cleanup_probe.store(false, Ordering::SeqCst);
    streams_probe.store(false, Ordering::SeqCst);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      "complete-oversize",
      Some(CapabilityErrorCode::InvalidResponse),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 0);
    assert!(cleanup_probe.load(Ordering::SeqCst), "oversize: input Blob cleaned");
    assert!(
      streams_probe.load(Ordering::SeqCst),
      "oversize: writer/reader endpoints released"
    );
  }

  // 3) Guest error: the fixture guest returns a stable plugin error; no transport request.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), CHAT_FIXTURE_RESPONSE);
    cleanup_probe.store(false, Ordering::SeqCst);
    streams_probe.store(false, Ordering::SeqCst);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      "guest-error",
      Some(CapabilityErrorCode::InvalidResponse),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 0);
    assert!(cleanup_probe.load(Ordering::SeqCst), "guest error: input Blob cleaned");
    assert!(
      streams_probe.load(Ordering::SeqCst),
      "guest error: writer/reader endpoints released"
    );
  }

  // 4) Malformed provider body: the host broker boundary rejects malformed JSON responses
  // before the guest (fail-closed), and the guest maps the denial to a stable error.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), "not-json");
    cleanup_probe.store(false, Ordering::SeqCst);
    streams_probe.store(false, Ordering::SeqCst);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      "malformed",
      Some(CapabilityErrorCode::InvalidRequest),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
    assert!(cleanup_probe.load(Ordering::SeqCst), "malformed: input Blob cleaned");
    assert!(
      streams_probe.load(Ordering::SeqCst),
      "malformed: writer/reader endpoints released"
    );
  }

  // 5) Unexpected streaming result under a non-stream preference: a stable invalid response,
  // no legacy executor, no transport request.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), CHAT_FIXTURE_RESPONSE);
    cleanup_probe.store(false, Ordering::SeqCst);
    streams_probe.store(false, Ordering::SeqCst);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      "unexpected-stream",
      Some(CapabilityErrorCode::InvalidResponse),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 0);
    assert!(
      cleanup_probe.load(Ordering::SeqCst),
      "unexpected stream: input Blob cleaned"
    );
    assert!(
      streams_probe.load(Ordering::SeqCst),
      "unexpected stream: writer/reader endpoints released"
    );
  }
}

/// Phase 8 Task 8: streaming Chat through the paired typed writer/reader bridge. The fixture's
/// llm-chat-world artifact receives `LlmChatPreferencesV1.stream = true` and writes ordered
/// typed deltas to the host-created writer; the host drains the paired reader and forwards
/// sanitized `ProviderRuntimeChatEvent` values through the public runtime Chat command
/// contract. Table cases cover ordered text/reasoning/tool/complete frames with exactly one
/// terminal transition, an oversized single delta, oversized cumulative output, and
/// cancellation through the public runtime cancellation command contract. Every path cleans
/// both stream endpoints and the request store, makes no second provider request, and never
/// calls the legacy frontend executor.
#[tokio::test]
async fn runtime_provider_streamed_chat_orders_deltas_and_cleans_on_cancel() {
  use crate::cmds::runtime_providers::{cancel_runtime_request, run_provider_runtime_chat};
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::cancel::RequestSessionRegistry;
  use crate::domain::runtime_provider::{
    LlmChatMessage, LlmChatPreferencesV1, LlmChatRequest, LlmChatResult, ProviderRuntimeChatCommandInput,
    ProviderRuntimeChatEvent,
  };
  use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
  use crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle;
  use crate::services::provider_runtime_router::ProviderRuntimeRouter;
  use crate::services::wasm_runtime::host::BrokerHandle;
  use std::collections::HashMap;
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::time::Duration;

  // Fixed provider body returned by the capture transport in streaming modes (the guest does
  // not parse it; ordering comes from typed deltas, never opaque bytes).
  const STREAM_FIXTURE_RESPONSE: &str = r#"{"message":{"role":"assistant","content":"ignored for streaming"}}"#;

  /// Capture transport: records every prepared request and returns one fixed fixture body.
  struct RecordingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    response: BoundedHttpResponse,
  }
  impl RawHttpTransport for RecordingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let response = self.response.clone();
      Box::pin(async move { Ok(response) })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  /// Parking transport: records the request, then blocks forever (until the host cancels the
  /// broker call). Proves a mid-broker-call stream stops cleanly on cancellation.
  struct ParkingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
  }
  impl RawHttpTransport for ParkingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { std::future::pending().await })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { std::future::pending().await })
    }
  }

  fn stream_request() -> LlmChatRequest {
    LlmChatRequest {
      model: "gpt-4o".into(),
      messages: vec![LlmChatMessage {
        role: "user".into(),
        content: "What is the capital of France?".into(),
      }],
      images: Vec::new(),
      preferences: LlmChatPreferencesV1 {
        stream: true,
        temperature: Some(0.2),
        max_tokens: Some(64),
        thinking: false,
      },
    }
  }

  fn recording_transport(requests: Arc<Mutex<Vec<PreparedHttpRequest>>>) -> Arc<RecordingTransport> {
    Arc::new(RecordingTransport {
      requests,
      response: BoundedHttpResponse {
        status: 200,
        headers: HashMap::from([("content-type".into(), "application/json".into())]),
        body: STREAM_FIXTURE_RESPONSE.as_bytes().to_vec(),
      },
    })
  }

  async fn run_stream_case(
    db: &Database,
    packages: PluginPackageService,
    wasm: Arc<WasmRuntime>,
    provider_model_id: uuid::Uuid,
    vault: Arc<MemoryCredentialVault>,
    _requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    transport: Arc<dyn RawHttpTransport>,
    mode: &str,
    events: Arc<Mutex<Vec<ProviderRuntimeChatEvent>>>,
  ) -> Result<LlmChatResult, CapabilityError> {
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages, wasm, broker_factory);
    let sessions = RequestSessionRegistry::new();
    let input = ProviderRuntimeChatCommandInput {
      request_id: format!("chat-stream-req-{mode}"),
      provider_model_id,
      config: format!(r#"{{"mode":"{mode}"}}"#).into_bytes(),
      request: stream_request(),
    };
    let sink = events.clone();
    run_provider_runtime_chat(
      &router,
      &sessions,
      input,
      Box::new(move |event| {
        sink.lock().expect("events poisoned").push(event);
        Ok(())
      }),
    )
    .await
    .map(|_| LlmChatResult::Streaming)
  }

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let (provider_id, _package_digest) = activate_fixture_provider(
    &db,
    packages.clone(),
    wasm.clone(),
    "Streaming Chat Provider",
    vault.as_ref(),
  );
  let model_id = insert_fixture_model(&db, provider_id, "gpt-4o");

  let cleanup_probe = Arc::new(AtomicBool::new(false));
  let streams_probe = Arc::new(AtomicBool::new(false));
  wasm.set_cleanup_probe(cleanup_probe.clone());
  wasm.set_streams_cleanup_probe(streams_probe.clone());

  // 1) Ordered typed deltas: text/reasoning/tool/text/complete with exactly one terminal
  // transition; the guest returns a streaming result and the pair is cleaned.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone());
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    cleanup_probe.store(false, Ordering::SeqCst);
    streams_probe.store(false, Ordering::SeqCst);
    let result = run_stream_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      "stream-fixed",
      events.clone(),
    )
    .await
    .expect("stream-fixed completes");
    assert_eq!(result, LlmChatResult::Streaming);
    let expected: Vec<ProviderRuntimeChatEvent> = vec![
      ProviderRuntimeChatEvent::Text { text: "Hello".into() },
      ProviderRuntimeChatEvent::Reasoning {
        text: "step one".into(),
      },
      ProviderRuntimeChatEvent::ToolCall {
        id: "call-1".into(),
        name: "search".into(),
        arguments_json: r#"{"q":"rust"}"#.into(),
      },
      ProviderRuntimeChatEvent::Text { text: " world".into() },
      ProviderRuntimeChatEvent::Complete { status: "stop".into() },
    ];
    let received = events.lock().expect("events poisoned").clone();
    assert_eq!(
      received, expected,
      "ordered typed deltas with exactly one terminal transition"
    );
    assert_eq!(
      received
        .iter()
        .filter(|e| matches!(e, ProviderRuntimeChatEvent::Complete { .. }))
        .count(),
      1,
      "exactly one terminal complete event"
    );
    assert!(
      matches!(received.last(), Some(ProviderRuntimeChatEvent::Complete { .. })),
      "the complete event is the last frame"
    );
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
    assert!(cleanup_probe.load(Ordering::SeqCst), "stream-fixed: store cleaned");
    assert!(
      streams_probe.load(Ordering::SeqCst),
      "stream-fixed: writer/reader endpoints released"
    );
  }

  // 2) Oversized single delta: the host rejects the delta before forwarding and cleans both
  // endpoints; no second provider request.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone());
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    cleanup_probe.store(false, Ordering::SeqCst);
    streams_probe.store(false, Ordering::SeqCst);
    let outcome = run_stream_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      "stream-oversize-delta",
      events.clone(),
    )
    .await;
    assert!(
      matches!(
        &outcome,
        Err(CapabilityError {
          code: CapabilityErrorCode::InvalidResponse,
          ..
        })
      ),
      "oversize delta: {outcome:?}"
    );
    assert!(
      events.lock().expect("events poisoned").is_empty(),
      "no delta is forwarded"
    );
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
    assert!(cleanup_probe.load(Ordering::SeqCst), "oversize delta: store cleaned");
    assert!(
      streams_probe.load(Ordering::SeqCst),
      "oversize delta: endpoints released"
    );
  }

  // 3) Oversized cumulative output: the host fails the stream at its total-output bound and
  // cleans both endpoints; no second provider request.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone());
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    cleanup_probe.store(false, Ordering::SeqCst);
    streams_probe.store(false, Ordering::SeqCst);
    let outcome = run_stream_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      "stream-oversize-total",
      events.clone(),
    )
    .await;
    assert!(
      matches!(
        &outcome,
        Err(CapabilityError {
          code: CapabilityErrorCode::InvalidResponse,
          ..
        })
      ),
      "oversize total: {outcome:?}"
    );
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
    assert!(cleanup_probe.load(Ordering::SeqCst), "oversize total: store cleaned");
    assert!(
      streams_probe.load(Ordering::SeqCst),
      "oversize total: endpoints released"
    );
  }

  // 4) Cancellation through the public runtime cancellation command contract: the guest is
  // blocked in its broker call when the session cancels; the stream stops, both endpoints and
  // the request store are cleaned, no second provider request is made, and the legacy
  // frontend executor is never invoked.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(ParkingTransport {
      requests: requests.clone(),
    });
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let sessions = Arc::new(RequestSessionRegistry::new());
    let request_id = "chat-stream-req-block";
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    let sink = events.clone();
    let input = ProviderRuntimeChatCommandInput {
      request_id: request_id.to_string(),
      provider_model_id: model_id,
      config: br#"{"mode":"stream-block"}"#.to_vec(),
      request: stream_request(),
    };
    let sessions_for_task = sessions.clone();
    let handle = tokio::spawn(async move {
      run_provider_runtime_chat(
        &router,
        &sessions_for_task,
        input,
        Box::new(move |event| {
          sink.lock().expect("events poisoned").push(event);
          Ok(())
        }),
      )
      .await
    });

    // Wait until the guest is blocked inside its broker call (one parked provider request).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
      if !requests.lock().expect("requests poisoned").is_empty() {
        break;
      }
      assert!(
        tokio::time::Instant::now() < deadline,
        "guest never reached the parked broker call"
      );
      tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
      requests.lock().expect("requests poisoned").len(),
      1,
      "one provider request in flight"
    );
    assert!(
      cancel_runtime_request(&sessions, request_id),
      "the public cancellation command contract cancels the session"
    );
    let outcome = tokio::time::timeout(Duration::from_secs(30), handle)
      .await
      .expect("chat stream task finishes")
      .expect("chat stream task joins");
    assert!(
      matches!(
        &outcome,
        Err(CapabilityError {
          code: CapabilityErrorCode::Cancelled,
          ..
        })
      ),
      "cancellation: {outcome:?}"
    );
    assert_eq!(
      requests.lock().expect("requests poisoned").len(),
      1,
      "no second provider request and no legacy replay after cancellation"
    );
    assert!(
      events.lock().expect("events poisoned").is_empty(),
      "no terminal callback for abandoned work"
    );
    assert!(cleanup_probe.load(Ordering::SeqCst), "cancellation: store cleaned");
    assert!(
      streams_probe.load(Ordering::SeqCst),
      "cancellation: writer/reader endpoints released"
    );
  }
}

/// Phase 8 Task 11: the OpenAI Compatible runtime package reproduces the current TypeScript
/// provider fixtures through the generic runtime host. A dev-signed two-world package executes
/// through a real provider binding/router/broker path: fixed Models List request/result, unary
/// Chat request/result, split streaming text deltas, image Blob usage (base64 data URL only in
/// the provider wire body), and sanitized malformed/provider-error cases. The expected request
/// bodies are committed fixture literals ported from `openaiCompatible.test.ts`; the test never
/// recomputes wire payloads.
#[tokio::test]
async fn openai_compatible_runtime_component_matches_current_provider_fixtures() {
  use crate::cmds::runtime_providers::run_provider_runtime_chat;
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::cancel::RequestSessionRegistry;
  use crate::domain::provider_http::ProviderHttpMethod;
  use crate::domain::runtime_provider::{
    LlmChatMessage, LlmChatPreferencesV1, LlmChatRequest, ProviderRuntimeChatCommandInput, ProviderRuntimeChatEvent,
  };
  use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
  use crate::services::bounded_http::RequestBody;
  use crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle;
  use crate::services::provider_runtime_router::ProviderRuntimeRouter;
  use crate::services::wasm_runtime::host::BrokerHandle;
  use std::collections::HashMap;

  // Fixed 1x1 transparent PNG (67 bytes). Its base64 data URL appears ONLY in the expected
  // provider wire fixture below; the bytes never cross WIT semantic fields, logs, or DTOs.
  const FIXED_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ];
  assert_eq!(
    FIXED_PNG.len(),
    67,
    "the fixed PNG byte count is part of the expected fixture"
  );
  assert!(
    OPENAI_COMPATIBLE_CHAT_REQUEST_IMAGE_BODY.contains("iVBORw0KGgo"),
    "the expected image wire fixture embeds the fixed PNG base64 data URL"
  );

  fn unary_request() -> LlmChatRequest {
    LlmChatRequest {
      model: "gpt-4o-mini".into(),
      messages: vec![
        LlmChatMessage {
          role: "system".into(),
          content: "sys".into(),
        },
        LlmChatMessage {
          role: "user".into(),
          content: "hello".into(),
        },
      ],
      images: Vec::new(),
      preferences: LlmChatPreferencesV1 {
        stream: false,
        temperature: Some(0.2),
        max_tokens: Some(128),
        thinking: false,
      },
    }
  }

  fn stream_request() -> LlmChatRequest {
    let mut request = unary_request();
    request.preferences.stream = true;
    request
  }

  /// Capture transport: records every prepared request and returns one fixed fixture body.
  struct RecordingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    response: BoundedHttpResponse,
  }
  impl RawHttpTransport for RecordingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let response = self.response.clone();
      Box::pin(async move { Ok(response) })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  /// SSE transport for the runtime streaming path: emits Started + the committed SSE fixture
  /// as one chunk + Finished through the transport stream contract.
  struct SseTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    sse: &'static str,
  }
  impl RawHttpTransport for SseTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        Ok(BoundedHttpResponse {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
          body: sse.into_bytes(),
        })
      })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Chunk {
          bytes: sse.into_bytes(),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Finished)?;
        Ok(())
      })
    }
  }

  fn recording_transport(
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    status: u16,
    content_type: &str,
    body: &'static str,
  ) -> Arc<RecordingTransport> {
    Arc::new(RecordingTransport {
      requests,
      response: BoundedHttpResponse {
        status,
        headers: HashMap::from([("content-type".into(), content_type.to_string())]),
        body: body.as_bytes().to_vec(),
      },
    })
  }

  async fn run_chat_case(
    db: &Database,
    packages: PluginPackageService,
    wasm: Arc<WasmRuntime>,
    provider_model_id: uuid::Uuid,
    vault: Arc<MemoryCredentialVault>,
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    transport: Arc<RecordingTransport>,
    request: LlmChatRequest,
    expected_error: Option<CapabilityErrorCode>,
  ) -> Result<crate::domain::runtime_provider::LlmChatCompleteResult, CapabilityError> {
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages, wasm, broker_factory);
    let outcome = router
      .chat(
        provider_model_id,
        b"{}".to_vec(),
        request,
        "openai-chat-req",
        CancelToken::new(),
        None,
      )
      .await;
    match expected_error {
      Some(expected) => {
        assert!(
          matches!(&outcome, Err(CapabilityError { code, .. }) if *code == expected),
          "unexpected outcome {outcome:?}"
        );
        if let Err(CapabilityError { message, .. }) = &outcome {
          assert!(
            !message
              .as_bytes()
              .windows(FIXED_PNG.len())
              .any(|window| window == FIXED_PNG),
            "error leaks image content: {message}"
          );
        }
      }
      None => {
        assert!(outcome.is_ok(), "unexpected outcome {outcome:?}");
      }
    }
    drop(requests.lock().expect("requests poisoned"));
    outcome
  }

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let package_digest = install(&packages, OPENAI_COMPATIBLE_PACKAGE);
  let provider_id = crate::domain::time::new_id();
  insert_provider_row(
    &db,
    provider_id,
    "OpenAI Compatible Provider",
    Some(format!("provider/{provider_id}/key")),
    vault.as_ref(),
    Some("sk-test-provider-secret"),
  );
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm.clone());
  let preview = lifecycle
    .preview_upgrade(provider_id, &package_digest)
    .expect("openai-compatible package previews");
  lifecycle
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .expect("openai-compatible package applies");
  let model_id = insert_fixture_model(&db, provider_id, "gpt-4o-mini");

  // 1) Fixed Models List: GET /models through the broker; the result matches the current
  // provider fixture (ids only, no remote display names).
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_COMPATIBLE_MODELS_FIXTURE,
    );
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let result = router
      .list_models(
        provider_id,
        "openai-compatible",
        "openai-models-req-fixed",
        b"{}".to_vec(),
        CancelToken::new(),
        None,
      )
      .await
      .expect("models list succeeds");
    let ids: Vec<(&str, Option<&str>)> = result
      .models
      .iter()
      .map(|model| (model.id.as_str(), model.label.as_deref()))
      .collect();
    assert_eq!(
      ids,
      vec![("gpt-4o-mini", None), ("gpt-4o", None)],
      "current OpenAI Compatible model fixtures"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, ProviderHttpMethod::Get);
    assert_eq!(captured[0].url.as_str(), "https://api.openai.com/v1/models");
    assert_eq!(
      captured[0].headers.get("Authorization").map(String::as_str),
      Some("Bearer sk-test-provider-secret"),
      "host injects the stored credential after authorization"
    );
    drop(captured);
  }

  // 2) Bounded aggregate Models List: the production guest synthesizes an over-limit list and
  // the host rejects it; no provider request is made.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_COMPATIBLE_MODELS_FIXTURE,
    );
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let err = router
      .list_models(
        provider_id,
        "openai-compatible",
        "openai-models-req-overlimit",
        br#"{"mode":"over-limit"}"#.to_vec(),
        CancelToken::new(),
        None,
      )
      .await
      .unwrap_err();
    assert!(
      matches!(
        &err,
        CapabilityError {
          code: CapabilityErrorCode::InvalidResponse,
          ..
        }
      ),
      "over-limit aggregate: {err:?}"
    );
    assert_eq!(requests.lock().expect("requests poisoned").len(), 0);
  }

  // 3) Fixed unary Chat: the captured request body byte-matches the committed fixture
  // (model, system+user messages, stream:false, temperature, max_tokens) and the response
  // content is trimmed like the current provider.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_COMPATIBLE_CHAT_COMPLETE_FIXTURE,
    );
    let complete = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      None,
    )
    .await
    .expect("fixed unary chat completes");
    assert_eq!(complete.role, "assistant");
    assert_eq!(
      complete.content, "hi",
      "chat content is trimmed like the current provider"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, ProviderHttpMethod::Post);
    assert_eq!(captured[0].url.as_str(), "https://api.openai.com/v1/chat/completions");
    assert_eq!(
      captured[0].headers.get("Content-Type").map(String::as_str),
      Some("application/json")
    );
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, OPENAI_COMPATIBLE_CHAT_REQUEST_BODY,
          "captured unary body matches the committed current-provider fixture"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 4) Image Blob usage: the guest reads the host-owned Blob and emits the base64 data URL
  // in the provider wire body only; image bytes never cross WIT semantic fields or errors.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_COMPATIBLE_CHAT_COMPLETE_FIXTURE,
    );
    let mut request = unary_request();
    request.messages[1].content = "What is in this image?".into();
    request.images = vec![FIXED_PNG.to_vec()];
    let complete = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      request,
      None,
    )
    .await
    .expect("image chat completes");
    assert_eq!(complete.content, "hi");
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, OPENAI_COMPATIBLE_CHAT_REQUEST_IMAGE_BODY,
          "captured image body matches the committed image wire fixture"
        );
        assert!(
          !body
            .as_bytes()
            .windows(FIXED_PNG.len())
            .any(|window| window == FIXED_PNG),
          "raw image bytes never appear in the wire body (base64 data URL only)"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 5) Split streaming text deltas: the committed SSE fixture produces ordered Text deltas
  // and one terminal Complete through the public runtime chat command contract; the captured
  // request body carries the host-selected stream flag.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SseTransport {
      requests: requests.clone(),
      sse: OPENAI_COMPATIBLE_CHAT_STREAM_SSE,
    });
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let sessions = RequestSessionRegistry::new();
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    let sink = events.clone();
    let input = ProviderRuntimeChatCommandInput {
      request_id: "openai-chat-stream-req".into(),
      provider_model_id: model_id,
      config: b"{}".to_vec(),
      request: stream_request(),
    };
    let result = run_provider_runtime_chat(
      &router,
      &sessions,
      input,
      Box::new(move |event| {
        sink.lock().expect("events poisoned").push(event);
        Ok(())
      }),
    )
    .await
    .expect("streaming chat completes");
    assert_eq!(result, None, "streaming chat returns no complete message");
    let expected: Vec<ProviderRuntimeChatEvent> = vec![
      ProviderRuntimeChatEvent::Text { text: "wo".into() },
      ProviderRuntimeChatEvent::Text { text: "rld".into() },
      ProviderRuntimeChatEvent::Complete { status: "stop".into() },
    ];
    assert_eq!(
      events.lock().expect("events poisoned").clone(),
      expected,
      "split streaming text deltas with one terminal complete"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].url.as_str(), "https://api.openai.com/v1/chat/completions");
    assert_eq!(
      captured[0].headers.get("Accept").map(String::as_str),
      Some("text/event-stream"),
      "the guest selects the host stream response mode"
    );
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, OPENAI_COMPATIBLE_CHAT_REQUEST_STREAM_BODY,
          "captured streaming body matches the committed stream fixture"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 6) Malformed provider body: the host broker boundary rejects malformed JSON before the
  // guest (fail-closed); the denial maps to a stable invalid request.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_COMPATIBLE_MALFORMED_BODY,
    );
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::InvalidRequest),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
  }

  // 7) Provider error mapping: a 429 fixture maps to rate_limited; a response missing
  // choices maps to invalid_response; a response missing content maps to invalid_response.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      429,
      "application/json",
      OPENAI_COMPATIBLE_RATE_LIMITED_BODY,
    );
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::RateLimited),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
  }
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 200, "application/json", r#"{"choices":[]}"#);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::InvalidResponse),
    )
    .await;
  }
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      r#"{"choices":[{"message":{}}]}"#,
    );
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::InvalidResponse),
    )
    .await;
  }

  // 8) Malformed SSE event: a non-JSON `data:` line is a stable invalid response and no
  // delta is forwarded.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SseTransport {
      requests: requests.clone(),
      sse: "data: not-json\n\ndata: [DONE]\n\n",
    });
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let sessions = RequestSessionRegistry::new();
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    let sink = events.clone();
    let input = ProviderRuntimeChatCommandInput {
      request_id: "openai-chat-stream-req-malformed".into(),
      provider_model_id: model_id,
      config: b"{}".to_vec(),
      request: stream_request(),
    };
    let outcome = run_provider_runtime_chat(
      &router,
      &sessions,
      input,
      Box::new(move |event| {
        sink.lock().expect("events poisoned").push(event);
        Ok(())
      }),
    )
    .await;
    assert!(
      matches!(
        &outcome,
        Err(CapabilityError {
          code: CapabilityErrorCode::InvalidResponse,
          ..
        })
      ),
      "malformed SSE event: {outcome:?}"
    );
    assert!(
      events.lock().expect("events poisoned").is_empty(),
      "no delta is forwarded for a malformed SSE event"
    );
  }

  // The binding is unchanged after every case.
  let binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  assert_eq!(binding.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(binding.state, ProviderRuntimeState::Active);
  assert_eq!(binding.package_digest.as_deref(), Some(package_digest.as_str()));
  assert_eq!(binding.grant_set_revision, Some(1));
}

/// Phase 8 Task 18: the OpenAI Responses runtime package reproduces the current TypeScript
/// Responses API fixtures through the generic runtime host. A dev-signed two-world package
/// executes through a real provider binding/router/broker path: fixed Models List
/// request/result, unary /responses request/result, typed event-stream deltas (with lifecycle
/// ignore and truncated-payload tolerance), image Blob usage (base64 data URL only in the
/// provider wire body), and sanitized malformed/provider-error cases. The expected request
/// bodies are committed fixture literals ported from `openaiResponses.test.ts`; the test
/// never recomputes wire payloads.
#[tokio::test]
async fn openai_responses_runtime_component_matches_current_provider_fixtures() {
  use crate::cmds::runtime_providers::run_provider_runtime_chat;
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::cancel::RequestSessionRegistry;
  use crate::domain::provider_http::ProviderHttpMethod;
  use crate::domain::runtime_provider::{
    LlmChatMessage, LlmChatPreferencesV1, LlmChatRequest, ProviderRuntimeChatCommandInput, ProviderRuntimeChatEvent,
  };
  use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
  use crate::services::bounded_http::RequestBody;
  use crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle;
  use crate::services::provider_runtime_router::ProviderRuntimeRouter;
  use crate::services::wasm_runtime::host::BrokerHandle;
  use std::collections::HashMap;

  // Fixed 1x1 transparent PNG (67 bytes). Its base64 data URL appears ONLY in the expected
  // provider wire fixture below; the bytes never cross WIT semantic fields, logs, or DTOs.
  const FIXED_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ];
  assert_eq!(
    FIXED_PNG.len(),
    67,
    "the fixed PNG byte count is part of the expected fixture"
  );
  assert!(
    OPENAI_RESPONSES_CHAT_REQUEST_IMAGE_BODY.contains("iVBORw0KGgo"),
    "the expected image wire fixture embeds the fixed PNG base64 data URL"
  );

  fn unary_request() -> LlmChatRequest {
    LlmChatRequest {
      model: "gpt-5.4-mini".into(),
      messages: vec![
        LlmChatMessage {
          role: "system".into(),
          content: "sys".into(),
        },
        LlmChatMessage {
          role: "user".into(),
          content: "hello".into(),
        },
      ],
      images: Vec::new(),
      preferences: LlmChatPreferencesV1 {
        stream: false,
        temperature: Some(0.2),
        max_tokens: Some(128),
        thinking: false,
      },
    }
  }

  fn stream_request() -> LlmChatRequest {
    let mut request = unary_request();
    request.preferences.stream = true;
    request
  }

  /// Capture transport: records every prepared request and returns one fixed fixture body.
  struct RecordingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    response: BoundedHttpResponse,
  }
  impl RawHttpTransport for RecordingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let response = self.response.clone();
      Box::pin(async move { Ok(response) })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  /// SSE transport for the runtime streaming path: emits Started + the committed SSE fixture
  /// as one chunk + Finished through the transport stream contract.
  struct SseTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    sse: &'static str,
  }
  impl RawHttpTransport for SseTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        Ok(BoundedHttpResponse {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
          body: sse.into_bytes(),
        })
      })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Chunk {
          bytes: sse.into_bytes(),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Finished)?;
        Ok(())
      })
    }
  }

  fn recording_transport(
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    status: u16,
    content_type: &str,
    body: &'static str,
  ) -> Arc<RecordingTransport> {
    Arc::new(RecordingTransport {
      requests,
      response: BoundedHttpResponse {
        status,
        headers: HashMap::from([("content-type".into(), content_type.to_string())]),
        body: body.as_bytes().to_vec(),
      },
    })
  }

  async fn run_chat_case(
    db: &Database,
    packages: PluginPackageService,
    wasm: Arc<WasmRuntime>,
    provider_model_id: uuid::Uuid,
    vault: Arc<MemoryCredentialVault>,
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    transport: Arc<RecordingTransport>,
    request: LlmChatRequest,
    expected_error: Option<CapabilityErrorCode>,
  ) -> Result<crate::domain::runtime_provider::LlmChatCompleteResult, CapabilityError> {
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages, wasm, broker_factory);
    let outcome = router
      .chat(
        provider_model_id,
        b"{}".to_vec(),
        request,
        "openai-responses-chat-req",
        CancelToken::new(),
        None,
      )
      .await;
    match expected_error {
      Some(expected) => {
        assert!(
          matches!(&outcome, Err(CapabilityError { code, .. }) if *code == expected),
          "unexpected outcome {outcome:?}"
        );
        if let Err(CapabilityError { message, .. }) = &outcome {
          assert!(
            !message
              .as_bytes()
              .windows(FIXED_PNG.len())
              .any(|window| window == FIXED_PNG),
            "error leaks image content: {message}"
          );
        }
      }
      None => {
        assert!(outcome.is_ok(), "unexpected outcome {outcome:?}");
      }
    }
    drop(requests.lock().expect("requests poisoned"));
    outcome
  }

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let package_digest = install(&packages, OPENAI_RESPONSES_PACKAGE);
  let provider_id = crate::domain::time::new_id();
  insert_provider_row_with(
    &db,
    provider_id,
    "openai-responses",
    "OpenAI Responses Provider",
    "https://api.openai.com/v1",
    AuthSchemeV1::bearer(),
    Some(format!("provider/{provider_id}/key")),
    vault.as_ref(),
    Some("sk-test-provider-secret"),
  );
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm.clone());
  let preview = lifecycle
    .preview_upgrade(provider_id, &package_digest)
    .expect("openai-responses package previews");
  lifecycle
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .expect("openai-responses package applies");
  let model_id = insert_fixture_model(&db, provider_id, "gpt-5.4-mini");

  // 1) Fixed Models List: GET /models through the broker; the result matches the current
  // provider fixture (ids only, no remote display names).
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_RESPONSES_MODELS_FIXTURE,
    );
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let result = router
      .list_models(
        provider_id,
        "openai-responses",
        "openai-responses-models-req-fixed",
        b"{}".to_vec(),
        CancelToken::new(),
        None,
      )
      .await
      .expect("models list succeeds");
    let ids: Vec<(&str, Option<&str>)> = result
      .models
      .iter()
      .map(|model| (model.id.as_str(), model.label.as_deref()))
      .collect();
    assert_eq!(
      ids,
      vec![("gpt-5.4-mini", None), ("gpt-4o", None)],
      "current OpenAI Responses model fixtures"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, ProviderHttpMethod::Get);
    assert_eq!(captured[0].url.as_str(), "https://api.openai.com/v1/models");
    assert_eq!(
      captured[0].headers.get("Authorization").map(String::as_str),
      Some("Bearer sk-test-provider-secret"),
      "host injects the stored credential after authorization"
    );
    drop(captured);
  }

  // 2) Bounded aggregate Models List: the production guest synthesizes an over-limit list and
  // the host rejects it; no provider request is made.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_RESPONSES_MODELS_FIXTURE,
    );
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let err = router
      .list_models(
        provider_id,
        "openai-responses",
        "openai-responses-models-req-overlimit",
        br#"{"mode":"over-limit"}"#.to_vec(),
        CancelToken::new(),
        None,
      )
      .await
      .unwrap_err();
    assert!(
      matches!(
        &err,
        CapabilityError {
          code: CapabilityErrorCode::InvalidResponse,
          ..
        }
      ),
      "over-limit aggregate: {err:?}"
    );
    assert_eq!(requests.lock().expect("requests poisoned").len(), 0);
  }

  // 3) Fixed unary Chat: the captured request body byte-matches the committed fixture
  // (model, instructions, string input, stream:false, temperature, max_output_tokens) and
  // the response is trimmed like the current provider.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_RESPONSES_CHAT_COMPLETE_FIXTURE,
    );
    let complete = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      None,
    )
    .await
    .expect("fixed unary chat completes");
    assert_eq!(complete.role, "assistant");
    assert_eq!(
      complete.content, "hi",
      "chat content is trimmed like the current provider"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, ProviderHttpMethod::Post);
    assert_eq!(captured[0].url.as_str(), "https://api.openai.com/v1/responses");
    assert_eq!(
      captured[0].headers.get("Content-Type").map(String::as_str),
      Some("application/json")
    );
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, OPENAI_RESPONSES_CHAT_REQUEST_BODY,
          "captured unary body matches the committed current-provider fixture"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 4) Image Blob usage: the guest reads the host-owned Blob and emits the base64 data URL
  // in the provider wire body only; image bytes never cross WIT semantic fields or errors.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_RESPONSES_CHAT_COMPLETE_FIXTURE,
    );
    let mut request = unary_request();
    request.messages[1].content = "What is in this image?".into();
    request.images = vec![FIXED_PNG.to_vec()];
    let complete = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      request,
      None,
    )
    .await
    .expect("image chat completes");
    assert_eq!(complete.content, "hi");
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, OPENAI_RESPONSES_CHAT_REQUEST_IMAGE_BODY,
          "captured image body matches the committed image wire fixture"
        );
        assert!(
          !body
            .as_bytes()
            .windows(FIXED_PNG.len())
            .any(|window| window == FIXED_PNG),
          "raw image bytes never appear in the wire body (base64 data URL only)"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 5) Typed event-stream deltas: the committed SSE fixture produces ordered Text deltas,
  // ignores lifecycle events (including a truncated completed payload), and ends with one
  // terminal Complete through the public runtime chat command contract; the captured request
  // body carries the host-selected stream flag.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SseTransport {
      requests: requests.clone(),
      sse: OPENAI_RESPONSES_CHAT_STREAM_SSE,
    });
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let sessions = RequestSessionRegistry::new();
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    let sink = events.clone();
    let input = ProviderRuntimeChatCommandInput {
      request_id: "openai-responses-chat-stream-req".into(),
      provider_model_id: model_id,
      config: b"{}".to_vec(),
      request: stream_request(),
    };
    let result = run_provider_runtime_chat(
      &router,
      &sessions,
      input,
      Box::new(move |event| {
        sink.lock().expect("events poisoned").push(event);
        Ok(())
      }),
    )
    .await
    .expect("streaming chat completes");
    assert_eq!(result, None, "streaming chat returns no complete message");
    let expected: Vec<ProviderRuntimeChatEvent> = vec![
      ProviderRuntimeChatEvent::Text { text: "wo".into() },
      ProviderRuntimeChatEvent::Text { text: "rld".into() },
      ProviderRuntimeChatEvent::Complete { status: "stop".into() },
    ];
    assert_eq!(
      events.lock().expect("events poisoned").clone(),
      expected,
      "typed event-stream deltas with one terminal complete"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].url.as_str(), "https://api.openai.com/v1/responses");
    assert_eq!(
      captured[0].headers.get("Accept").map(String::as_str),
      Some("text/event-stream"),
      "the guest selects the host stream response mode"
    );
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, OPENAI_RESPONSES_CHAT_REQUEST_STREAM_BODY,
          "captured streaming body matches the committed stream fixture"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 6) Malformed provider body: the host broker boundary rejects malformed JSON before the
  // guest (fail-closed); the denial maps to a stable invalid request.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_RESPONSES_MALFORMED_BODY,
    );
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::InvalidRequest),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
  }

  // 7) Provider error mapping: a 429 fixture maps to rate_limited; a missing output array
  // maps to invalid_response; an all-empty output maps to invalid_response.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      429,
      "application/json",
      OPENAI_RESPONSES_RATE_LIMITED_BODY,
    );
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::RateLimited),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
  }
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 200, "application/json", r#"{"output":"nope"}"#);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::InvalidResponse),
    )
    .await;
  }
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      r#"{"output":[{"content":[{"type":"output_text","text":""}]}]}"#,
    );
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::InvalidResponse),
    )
    .await;
  }

  // 8) Malformed SSE event: a non-JSON `data:` payload under a delta event name is a stable
  // invalid response and no delta is forwarded.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SseTransport {
      requests: requests.clone(),
      sse: "event: response.output_text.delta\ndata: {broken\n\ndata: [DONE]\n\n",
    });
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let sessions = RequestSessionRegistry::new();
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    let sink = events.clone();
    let input = ProviderRuntimeChatCommandInput {
      request_id: "openai-responses-chat-stream-req-malformed".into(),
      provider_model_id: model_id,
      config: b"{}".to_vec(),
      request: stream_request(),
    };
    let outcome = run_provider_runtime_chat(
      &router,
      &sessions,
      input,
      Box::new(move |event| {
        sink.lock().expect("events poisoned").push(event);
        Ok(())
      }),
    )
    .await;
    assert!(
      matches!(
        &outcome,
        Err(CapabilityError {
          code: CapabilityErrorCode::InvalidResponse,
          ..
        })
      ),
      "malformed SSE event: {outcome:?}"
    );
    assert!(
      events.lock().expect("events poisoned").is_empty(),
      "no delta is forwarded for a malformed SSE event"
    );
  }

  // The binding is unchanged after every case.
  let binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-responses"))
    .unwrap();
  assert_eq!(binding.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(binding.state, ProviderRuntimeState::Active);
  assert_eq!(binding.package_digest.as_deref(), Some(package_digest.as_str()));
  assert_eq!(binding.grant_set_revision, Some(1));
}

/// Phase 8 Task 19: the Anthropic runtime package reproduces the current TypeScript Messages
/// API fixtures through the generic runtime host. A dev-signed two-world package executes
/// through a real provider binding/router/broker path: fixed two-page Models List aggregation
/// (bounded internal page traversal with no partial result on failure), unary /v1/messages
/// request/result, typed stream deltas, image Blob usage, and sanitized malformed/provider
/// errors. The guest requests only its non-secret `anthropic-version` header; the host
/// injects the stored `x-api-key` credential, and neither the key nor its reference ever
/// enters guest data, fixture literals, package bytes, error messages, or DTOs.
#[tokio::test]
async fn anthropic_runtime_component_matches_current_provider_fixtures() {
  use crate::cmds::runtime_providers::run_provider_runtime_chat;
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::cancel::RequestSessionRegistry;
  use crate::domain::provider_http::ProviderHttpMethod;
  use crate::domain::runtime_provider::{
    LlmChatMessage, LlmChatPreferencesV1, LlmChatRequest, ProviderRuntimeChatCommandInput, ProviderRuntimeChatEvent,
  };
  use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
  use crate::services::bounded_http::RequestBody;
  use crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle;
  use crate::services::provider_runtime_router::ProviderRuntimeRouter;
  use crate::services::wasm_runtime::host::BrokerHandle;
  use std::collections::HashMap;

  // Host-injected credential used by every request; it must never appear in guest-visible
  // data. The committed fixtures and the compiled guests are scanned below.
  const ANTHROPIC_TEST_SECRET: &str = "sk-ant-test-provider-secret";

  // Fixed 1x1 transparent PNG (67 bytes). Its base64 data URL appears ONLY in the expected
  // provider wire fixture below; the bytes never cross WIT semantic fields, logs, or DTOs.
  const FIXED_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ];
  assert_eq!(
    FIXED_PNG.len(),
    67,
    "the fixed PNG byte count is part of the expected fixture"
  );
  assert!(
    ANTHROPIC_CHAT_REQUEST_IMAGE_BODY.contains("iVBORw0KGgo"),
    "the expected image wire fixture embeds the fixed PNG base64 data URL"
  );

  // The API key and its credential reference must never enter guest data: the committed
  // fixture literals, the signed package bytes, and the compiled guest artifacts are scanned.
  for fixture in [
    ANTHROPIC_MODELS_PAGE_1_FIXTURE,
    ANTHROPIC_MODELS_PAGE_2_FIXTURE,
    ANTHROPIC_CHAT_COMPLETE_FIXTURE,
    ANTHROPIC_CHAT_REQUEST_BODY,
    ANTHROPIC_CHAT_REQUEST_STREAM_BODY,
    ANTHROPIC_CHAT_REQUEST_IMAGE_BODY,
    ANTHROPIC_CHAT_STREAM_SSE,
    ANTHROPIC_RATE_LIMITED_BODY,
    ANTHROPIC_MALFORMED_BODY,
  ] {
    assert!(
      !fixture.contains(ANTHROPIC_TEST_SECRET) && !fixture.contains("provider/"),
      "fixture literals must never carry the API key or a credential reference"
    );
  }
  for guest_bytes in [ANTHROPIC_MODELS_COMPONENT, ANTHROPIC_CHAT_COMPONENT, ANTHROPIC_PACKAGE] {
    assert!(
      !guest_bytes
        .windows(ANTHROPIC_TEST_SECRET.len())
        .any(|window| window == ANTHROPIC_TEST_SECRET.as_bytes()),
      "compiled guest/package bytes must never contain the API key"
    );
  }

  fn unary_request() -> LlmChatRequest {
    LlmChatRequest {
      model: "claude-3-5-haiku".into(),
      messages: vec![
        LlmChatMessage {
          role: "system".into(),
          content: "sys".into(),
        },
        LlmChatMessage {
          role: "user".into(),
          content: "hi".into(),
        },
      ],
      images: Vec::new(),
      preferences: LlmChatPreferencesV1 {
        stream: false,
        temperature: Some(0.1),
        // No host max-token value: the guest must apply the provider default (32768), which
        // is part of the current TypeScript plugin's fixed wire behavior.
        max_tokens: None,
        thinking: false,
      },
    }
  }

  fn stream_request() -> LlmChatRequest {
    let mut request = unary_request();
    request.preferences.stream = true;
    request
  }

  /// Capture transport: records every prepared request and returns one fixed fixture body.
  struct RecordingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    response: BoundedHttpResponse,
  }
  impl RawHttpTransport for RecordingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let response = self.response.clone();
      Box::pin(async move { Ok(response) })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  /// Sequence transport for the bounded two-page Models List traversal: returns one fixed
  /// body per request in order, recording every prepared request.
  struct SequenceTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    bodies: Vec<&'static str>,
    next: std::sync::atomic::AtomicUsize,
  }
  impl RawHttpTransport for SequenceTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let index = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
      let body = self.bodies[index.min(self.bodies.len() - 1)].to_string();
      Box::pin(async move {
        Ok(BoundedHttpResponse {
          status: 200,
          headers: HashMap::from([("content-type".into(), "application/json".into())]),
          body: body.into_bytes(),
        })
      })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  /// SSE transport for the runtime streaming path: emits Started + the committed SSE fixture
  /// as one chunk + Finished through the transport stream contract.
  struct SseTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    sse: &'static str,
  }
  impl RawHttpTransport for SseTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        Ok(BoundedHttpResponse {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
          body: sse.into_bytes(),
        })
      })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Chunk {
          bytes: sse.into_bytes(),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Finished)?;
        Ok(())
      })
    }
  }

  fn recording_transport(
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    status: u16,
    content_type: &str,
    body: &'static str,
  ) -> Arc<RecordingTransport> {
    Arc::new(RecordingTransport {
      requests,
      response: BoundedHttpResponse {
        status,
        headers: HashMap::from([("content-type".into(), content_type.to_string())]),
        body: body.as_bytes().to_vec(),
      },
    })
  }

  async fn run_chat_case(
    db: &Database,
    packages: PluginPackageService,
    wasm: Arc<WasmRuntime>,
    provider_model_id: uuid::Uuid,
    vault: Arc<MemoryCredentialVault>,
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    transport: Arc<RecordingTransport>,
    request: LlmChatRequest,
    expected_error: Option<CapabilityErrorCode>,
  ) -> Result<crate::domain::runtime_provider::LlmChatCompleteResult, CapabilityError> {
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages, wasm, broker_factory);
    let outcome = router
      .chat(
        provider_model_id,
        b"{}".to_vec(),
        request,
        "anthropic-chat-req",
        CancelToken::new(),
        None,
      )
      .await;
    match expected_error {
      Some(expected) => {
        assert!(
          matches!(&outcome, Err(CapabilityError { code, .. }) if *code == expected),
          "unexpected outcome {outcome:?}"
        );
        if let Err(CapabilityError { message, .. }) = &outcome {
          assert!(
            !message.contains(ANTHROPIC_TEST_SECRET),
            "error message leaks the API key: {message}"
          );
          assert!(
            !message
              .as_bytes()
              .windows(FIXED_PNG.len())
              .any(|window| window == FIXED_PNG),
            "error leaks image content: {message}"
          );
        }
      }
      None => {
        assert!(outcome.is_ok(), "unexpected outcome {outcome:?}");
      }
    }
    drop(requests.lock().expect("requests poisoned"));
    outcome
  }

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let package_digest = install(&packages, ANTHROPIC_PACKAGE);
  let provider_id = crate::domain::time::new_id();
  insert_provider_row_with(
    &db,
    provider_id,
    "anthropic",
    "Anthropic Provider",
    "https://api.anthropic.com",
    crate::domain::provider::AuthSchemeV1::header("x-api-key"),
    Some(format!("provider/{provider_id}/key")),
    vault.as_ref(),
    Some(ANTHROPIC_TEST_SECRET),
  );
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm.clone());
  let preview = lifecycle
    .preview_upgrade(provider_id, &package_digest)
    .expect("anthropic package previews");
  lifecycle
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .expect("anthropic package applies");
  let model_id = insert_fixture_model(&db, provider_id, "claude-3-5-haiku");

  // 1) Fixed two-page Models List aggregate: the guest traverses the bounded page sequence
  // internally (after_id cursor on page 2) and returns one complete set with display names.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SequenceTransport {
      requests: requests.clone(),
      bodies: vec![ANTHROPIC_MODELS_PAGE_1_FIXTURE, ANTHROPIC_MODELS_PAGE_2_FIXTURE],
      next: std::sync::atomic::AtomicUsize::new(0),
    });
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let result = router
      .list_models(
        provider_id,
        "anthropic",
        "anthropic-models-req-two-pages",
        b"{}".to_vec(),
        CancelToken::new(),
        None,
      )
      .await
      .expect("models list succeeds");
    let ids: Vec<(&str, Option<&str>)> = result
      .models
      .iter()
      .map(|model| (model.id.as_str(), model.label.as_deref()))
      .collect();
    assert_eq!(
      ids,
      vec![("claude-3-5-haiku", Some("Haiku")), ("claude-3-opus", Some("Opus")),],
      "current Anthropic model fixtures (two bounded pages aggregated inside the guest)"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 2, "one request per bounded page");
    assert_eq!(captured[0].method, ProviderHttpMethod::Get);
    assert_eq!(captured[0].url.as_str(), "https://api.anthropic.com/v1/models");
    assert_eq!(
      captured[0].headers.get("anthropic-version").map(String::as_str),
      Some("2023-06-01"),
      "the guest requests only its non-secret version header"
    );
    assert_eq!(
      captured[0].headers.get("x-api-key").map(String::as_str),
      Some(ANTHROPIC_TEST_SECRET),
      "host injects the stored x-api-key after authorization"
    );
    assert_eq!(
      captured[1].url.as_str(),
      "https://api.anthropic.com/v1/models?after_id=cursor-1",
      "page 2 continues from the fixed last_id cursor"
    );
    assert_eq!(
      captured[1].headers.get("x-api-key").map(String::as_str),
      Some(ANTHROPIC_TEST_SECRET),
      "every page carries the host-injected credential"
    );
    drop(captured);
  }

  // 2) Bounded page traversal fails closed: a transport that always reports has_more never
  // produces a partial list; the guest stops at its named page cap with a stable error.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SequenceTransport {
      requests: requests.clone(),
      bodies: vec![ANTHROPIC_MODELS_PAGE_1_FIXTURE],
      next: std::sync::atomic::AtomicUsize::new(0),
    });
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let err = router
      .list_models(
        provider_id,
        "anthropic",
        "anthropic-models-req-page-limit",
        b"{}".to_vec(),
        CancelToken::new(),
        None,
      )
      .await
      .unwrap_err();
    assert!(
      matches!(
        &err,
        CapabilityError {
          code: CapabilityErrorCode::InvalidResponse,
          ..
        }
      ),
      "page cap: {err:?}"
    );
    assert_eq!(
      requests.lock().expect("requests poisoned").len(),
      5,
      "the guest stops at its named maximum page count without a partial list"
    );
  }

  // 3) Fixed unary Chat: the captured request body byte-matches the committed fixture
  // (model, system, user message, default max_tokens 32768, stream:false, temperature) and
  // the response content matches the current provider.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      ANTHROPIC_CHAT_COMPLETE_FIXTURE,
    );
    let complete = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      None,
    )
    .await
    .expect("fixed unary chat completes");
    assert_eq!(complete.role, "assistant");
    assert_eq!(complete.content, "hello", "chat content matches the current provider");
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, ProviderHttpMethod::Post);
    assert_eq!(captured[0].url.as_str(), "https://api.anthropic.com/v1/messages");
    assert_eq!(
      captured[0].headers.get("Content-Type").map(String::as_str),
      Some("application/json")
    );
    assert_eq!(
      captured[0].headers.get("anthropic-version").map(String::as_str),
      Some("2023-06-01"),
      "the guest requests its non-secret version header"
    );
    assert_eq!(
      captured[0].headers.get("x-api-key").map(String::as_str),
      Some(ANTHROPIC_TEST_SECRET),
      "the host injects x-api-key; the guest never supplies it"
    );
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, ANTHROPIC_CHAT_REQUEST_BODY,
          "captured unary body matches the committed current-provider fixture"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 4) Image Blob usage: the guest reads the host-owned Blob and emits the base64 data URL
  // in the provider wire body only; image bytes never cross WIT semantic fields or errors.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      ANTHROPIC_CHAT_COMPLETE_FIXTURE,
    );
    let mut request = unary_request();
    request.messages[1].content = "What is in this image?".into();
    request.images = vec![FIXED_PNG.to_vec()];
    let complete = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      request,
      None,
    )
    .await
    .expect("image chat completes");
    assert_eq!(complete.content, "hello");
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, ANTHROPIC_CHAT_REQUEST_IMAGE_BODY,
          "captured image body matches the committed image wire fixture"
        );
        assert!(
          !body
            .as_bytes()
            .windows(FIXED_PNG.len())
            .any(|window| window == FIXED_PNG),
          "raw image bytes never appear in the wire body (base64 data URL only)"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 5) Typed stream deltas: the committed SSE fixture produces ordered Text deltas and one
  // terminal Complete through the public runtime chat command contract; the captured request
  // body carries the host-selected stream flag.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SseTransport {
      requests: requests.clone(),
      sse: ANTHROPIC_CHAT_STREAM_SSE,
    });
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let sessions = RequestSessionRegistry::new();
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    let sink = events.clone();
    let input = ProviderRuntimeChatCommandInput {
      request_id: "anthropic-chat-stream-req".into(),
      provider_model_id: model_id,
      config: b"{}".to_vec(),
      request: stream_request(),
    };
    let result = run_provider_runtime_chat(
      &router,
      &sessions,
      input,
      Box::new(move |event| {
        sink.lock().expect("events poisoned").push(event);
        Ok(())
      }),
    )
    .await
    .expect("streaming chat completes");
    assert_eq!(result, None, "streaming chat returns no complete message");
    let expected: Vec<ProviderRuntimeChatEvent> = vec![
      ProviderRuntimeChatEvent::Text { text: "wo".into() },
      ProviderRuntimeChatEvent::Text { text: "rld".into() },
      ProviderRuntimeChatEvent::Complete { status: "stop".into() },
    ];
    assert_eq!(
      events.lock().expect("events poisoned").clone(),
      expected,
      "split text deltas with one terminal complete"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].url.as_str(), "https://api.anthropic.com/v1/messages");
    assert_eq!(
      captured[0].headers.get("Accept").map(String::as_str),
      Some("text/event-stream"),
      "the guest selects the host stream response mode"
    );
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, ANTHROPIC_CHAT_REQUEST_STREAM_BODY,
          "captured streaming body matches the committed stream fixture"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 6) Malformed provider body: the host broker boundary rejects malformed JSON before the
  // guest (fail-closed); the denial maps to a stable invalid request.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 200, "application/json", ANTHROPIC_MALFORMED_BODY);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::InvalidRequest),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
  }

  // 7) Provider error mapping: a 429 fixture maps to rate_limited; a missing content array
  // maps to invalid_response; an all-empty content array maps to invalid_response.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 429, "application/json", ANTHROPIC_RATE_LIMITED_BODY);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::RateLimited),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
  }
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 200, "application/json", r#"{"content":"nope"}"#);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::InvalidResponse),
    )
    .await;
  }
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      r#"{"content":[{"type":"text","text":""}]}"#,
    );
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::InvalidResponse),
    )
    .await;
  }

  // 8) Malformed SSE event: a non-JSON `data:` payload is a stable invalid response and no
  // delta is forwarded.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SseTransport {
      requests: requests.clone(),
      sse: "event: content_block_delta\ndata: {broken\n\n",
    });
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);
    let sessions = RequestSessionRegistry::new();
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    let sink = events.clone();
    let input = ProviderRuntimeChatCommandInput {
      request_id: "anthropic-chat-stream-req-malformed".into(),
      provider_model_id: model_id,
      config: b"{}".to_vec(),
      request: stream_request(),
    };
    let outcome = run_provider_runtime_chat(
      &router,
      &sessions,
      input,
      Box::new(move |event| {
        sink.lock().expect("events poisoned").push(event);
        Ok(())
      }),
    )
    .await;
    assert!(
      matches!(
        &outcome,
        Err(CapabilityError {
          code: CapabilityErrorCode::InvalidResponse,
          ..
        })
      ),
      "malformed SSE event: {outcome:?}"
    );
    assert!(
      events.lock().expect("events poisoned").is_empty(),
      "no delta is forwarded for a malformed SSE event"
    );
  }

  // The binding is unchanged after every case, and the sanitized binding DTO exposes no
  // credential reference or secret material.
  let binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "anthropic"))
    .unwrap();
  assert_eq!(binding.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(binding.state, ProviderRuntimeState::Active);
  assert_eq!(binding.package_digest.as_deref(), Some(package_digest.as_str()));
  assert_eq!(binding.grant_set_revision, Some(1));
  // The sanitized provider DTO (the public IPC shape) exposes no credential reference or
  // secret material; the raw row keeps the reference only inside the repository.
  let provider_dto = crate::services::providers::ProviderService::new(db.clone(), vault.clone())
    .get(provider_id)
    .expect("provider DTO");
  let provider_json = serde_json::to_string(&provider_dto).unwrap();
  assert!(
    !provider_json.contains(ANTHROPIC_TEST_SECRET) && !provider_json.contains("provider/"),
    "provider DTO must not leak the API key or its credential reference"
  );
}

/// Phase 8 Task 12: a reviewed vendor OpenAI Compatible package becomes the default only for
/// newly created matching Providers. The default is resolved once from the verified vendor
/// archive (exact digest, publisher identity, version, legacy alias); the Provider create
/// path binds it only when the new Provider's adapter alias and persisted connection
/// requirements match. Pre-existing, mismatching, untrusted, revoked, alias-ambiguous, and
/// missing packages stay safely legacy; no startup/install/edit/sync/failure path
/// auto-upgrades anything.
#[test]
fn runtime_provider_vendor_default_applies_only_to_new_matching_provider() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::provider::{
    AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode,
  };
  use crate::domain::runtime_lifecycle::GrantSubjectKind;
  use crate::domain::runtime_provider::{ProviderRuntimeKind, ProviderRuntimeState};
  use crate::services::providers::ProviderService;
  use std::sync::Arc;

  fn provider_write(adapter_id: &str, base_url_source: BaseUrlSource, base_url: &str) -> ProviderInstanceWrite {
    ProviderInstanceWrite {
      id: None,
      adapter_id: adapter_id.into(),
      display_name: format!("{adapter_id} provider"),
      base_url: base_url.into(),
      base_url_source,
      auth_scheme: AuthSchemeV1::bearer(),
      credential_kind: CredentialKind::ApiKey,
      credential: CredentialUpdate::Keep,
      enabled: true,
      proxy_mode: ProxyMode::Inherit,
      insecure_http_confirmed_at: None,
      expected_updated_at: None,
    }
  }

  fn openai_write() -> ProviderInstanceWrite {
    provider_write(
      "openai-compatible",
      BaseUrlSource::PluginDefault,
      "https://api.openai.com/v1",
    )
  }

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let runtime = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm.clone());
  let providers = ProviderService::new(db.clone(), vault.clone()).with_runtime_defaults(Arc::new(runtime.clone()));

  // 1) Missing package: no default is configured, so a new matching Provider stays legacy.
  let missing = providers.save(openai_write()).expect("provider create succeeds");
  assert_eq!(
    missing.runtime.runtime_kind,
    ProviderRuntimeKind::LegacyFrontendProvider,
    "no default package: new matching provider stays legacy"
  );

  // A pre-existing Provider created before the default is set must remain legacy later.
  let preexisting = providers.save(openai_write()).expect("pre-existing provider create");
  assert_eq!(
    preexisting.runtime.runtime_kind,
    ProviderRuntimeKind::LegacyFrontendProvider
  );

  // 2) Install the verified vendor fixture and resolve the reviewed default (exact identity).
  let import = packages
    .bootstrap_bundled_package(OPENAI_COMPATIBLE_PACKAGE, false)
    .expect("vendor package bootstraps");
  let digest = import.package_digest().to_string();
  runtime
    .set_vendor_default(Some(&import))
    .expect("vendor default resolves");

  // 3) A new matching Provider receives the exact default package/grant in the create path.
  let matching = providers.save(openai_write()).expect("matching provider create");
  assert_eq!(matching.runtime.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(matching.runtime.state, ProviderRuntimeState::Active);
  assert_eq!(
    matching.runtime.package_digest.as_deref(),
    Some(digest.as_str()),
    "exact vendor package digest"
  );
  let grant_revision = matching.runtime.grant_set_revision.expect("grant revision");
  assert_eq!(grant_revision, 1, "first grant revision for a brand-new provider");
  let grant = db
    .read(|conn| {
      plugin_permission_grants::get_for_subject_package_revision(
        conn,
        GrantSubjectKind::ProviderInstance,
        matching.id,
        &digest,
        grant_revision,
      )
    })
    .expect("grant row exists");
  assert_eq!(
    grant.subject_id, matching.id,
    "grant subject is exactly the new provider"
  );

  // 4) A nonmatching adapter never receives the default.
  let nonmatching = providers
    .save(provider_write(
      "deepseek",
      BaseUrlSource::PluginDefault,
      "https://api.deepseek.com",
    ))
    .expect("nonmatching provider create");
  assert_eq!(
    nonmatching.runtime.runtime_kind,
    ProviderRuntimeKind::LegacyFrontendProvider
  );

  // 5) A matching adapter with a custom persisted connection stays legacy.
  let custom = providers
    .save(provider_write(
      "openai-compatible",
      BaseUrlSource::Custom,
      "https://relay.example.com/v1",
    ))
    .expect("custom connection provider create");
  assert_eq!(custom.runtime.runtime_kind, ProviderRuntimeKind::LegacyFrontendProvider);

  // 6) The pre-existing Provider is untouched by the default.
  let preexisting_after = providers.get(preexisting.id).expect("pre-existing provider");
  assert_eq!(
    preexisting_after.runtime.runtime_kind,
    ProviderRuntimeKind::LegacyFrontendProvider,
    "pre-existing provider stays legacy"
  );

  // 7) A revoked vendor publisher never yields a default: the create stays legacy.
  packages
    .revoke_publisher("com.langnext.vendor.keys.1")
    .expect("publisher revokes");
  let revoked = providers.save(openai_write()).expect("provider create after revoke");
  assert_eq!(
    revoked.runtime.runtime_kind,
    ProviderRuntimeKind::LegacyFrontendProvider
  );

  // 8) An untrusted package (signed by a non-vendor key) cannot produce a vendor import, so
  // it can never become a default; the create stays legacy.
  {
    let dir = tempfile::tempdir().unwrap();
    let db_untrusted = Database::new(dir.path()).unwrap();
    db_untrusted.initialize().unwrap();
    let packages_untrusted = PluginPackageService::with_vendor_roots(
      db_untrusted.clone(),
      dir.path().to_path_buf(),
      vec![test_vendor_fixture::fixture_vendor_public_key()],
    );
    let user_sk = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
    let user_manifest = openai_compatible_manifest(&[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ]);
    let user_pkg = test_support::build_signed_package_with_key(
      &user_manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
      &user_sk,
    );
    assert!(
      packages_untrusted.bootstrap_bundled_package(&user_pkg, false).is_err(),
      "a non-vendor signed package cannot produce a vendor import"
    );
    let runtime_untrusted = ProviderRuntimeService::new(db_untrusted.clone(), packages_untrusted.clone(), wasm.clone());
    let providers_untrusted = ProviderService::new(db_untrusted.clone(), Arc::new(MemoryCredentialVault::new()))
      .with_runtime_defaults(Arc::new(runtime_untrusted));
    let created = providers_untrusted.save(openai_write()).expect("provider create");
    assert_eq!(
      created.runtime.runtime_kind,
      ProviderRuntimeKind::LegacyFrontendProvider
    );
  }

  // 9) Alias-ambiguous vendor packages (same plugin id/version, different digest) are
  // rejected by the install path itself, so an ambiguous default can never exist; the single
  // verified vendor package remains the exact default and the create binds it.
  {
    let dir = tempfile::tempdir().unwrap();
    let db_ambiguous = Database::new(dir.path()).unwrap();
    db_ambiguous.initialize().unwrap();
    let packages_ambiguous = PluginPackageService::with_vendor_roots(
      db_ambiguous.clone(),
      dir.path().to_path_buf(),
      vec![test_vendor_fixture::fixture_vendor_public_key()],
    );
    let first = packages_ambiguous
      .bootstrap_bundled_package(OPENAI_COMPATIBLE_PACKAGE, false)
      .expect("first vendor package bootstraps");
    // A second fully vendor-signed package with the SAME plugin id/version but different
    // artifact bytes (the conformance LLM components are valid worlds for both capabilities).
    let second_manifest = openai_compatible_manifest(&[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ]);
    let second_bytes = vendor_signed_package(
      &second_manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    );
    assert!(
      packages_ambiguous
        .bootstrap_bundled_package(&second_bytes, false)
        .is_err(),
      "a second vendor digest claiming the same plugin id/version is rejected at install, so no ambiguous default can exist"
    );
    let runtime_ambiguous = ProviderRuntimeService::new(db_ambiguous.clone(), packages_ambiguous.clone(), wasm.clone());
    runtime_ambiguous
      .set_vendor_default(Some(&first))
      .expect("the single verified vendor package resolves exactly");
    let providers_ambiguous = ProviderService::new(db_ambiguous.clone(), Arc::new(MemoryCredentialVault::new()))
      .with_runtime_defaults(Arc::new(runtime_ambiguous));
    let created = providers_ambiguous.save(openai_write()).expect("provider create");
    assert_eq!(created.runtime.runtime_kind, ProviderRuntimeKind::WasmComponent);
    assert_eq!(
      created.runtime.package_digest.as_deref(),
      Some(first.package_digest()),
      "the exact vendor digest is bound"
    );
  }

  // The matching provider's binding is the only non-legacy binding in the database.
  let bindings = db.read(|conn| provider_runtime_bindings::list(conn)).unwrap();
  let wasm_bindings: Vec<_> = bindings
    .iter()
    .filter(|binding| binding.runtime_kind == ProviderRuntimeKind::WasmComponent)
    .collect();
  assert_eq!(
    wasm_bindings.len(),
    1,
    "exactly one active package binding (the new matching provider)"
  );
  assert_eq!(wasm_bindings[0].provider_id, matching.id);
}

/// Phase 8 Task 20: the Gemini runtime package reproduces the current TypeScript provider
/// fixtures through the generic runtime host. The Models guest keeps bounded page traversal
/// (pageToken) entirely inside itself with named maximum page/item/total and repeated-token
/// limits, and returns one `llm.models.list@1` aggregate only after every page succeeds —
/// never a partial list. Query-key authentication stays host-only: the guest requests a bare
/// relative path and the host injects `key=<secret>` after authorization. Chat unary/stream
/// bodies, alt=sse, image inline_data, and sanitized errors match the committed fixtures.
#[tokio::test]
async fn gemini_runtime_component_aggregates_bounded_pages_and_matches_current_fixtures() {
  use crate::cmds::runtime_providers::run_provider_runtime_chat;
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::cancel::RequestSessionRegistry;
  use crate::domain::provider_http::ProviderHttpMethod;
  use crate::domain::runtime_provider::{
    LlmChatMessage, LlmChatPreferencesV1, LlmChatRequest, ProviderRuntimeChatCommandInput, ProviderRuntimeChatEvent,
  };
  use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
  use crate::services::bounded_http::RequestBody;
  use crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle;
  use crate::services::provider_runtime_router::ProviderRuntimeRouter;
  use crate::services::wasm_runtime::host::BrokerHandle;
  use std::collections::HashMap;

  // Host-injected query-key credential; it must never appear in guest-visible data. The
  // committed fixtures and the compiled guests are scanned below.
  const GEMINI_TEST_SECRET: &str = "gemini-test-provider-secret";

  // Fixed 1x1 transparent PNG (67 bytes). Its base64 inline_data appears ONLY in the expected
  // provider wire fixture below; the bytes never cross WIT semantic fields, logs, or DTOs.
  const FIXED_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ];
  assert_eq!(
    FIXED_PNG.len(),
    67,
    "the fixed PNG byte count is part of the expected fixture"
  );
  assert!(
    GEMINI_CHAT_REQUEST_IMAGE_BODY.contains("iVBORw0KGgo"),
    "the expected image wire fixture embeds the fixed PNG base64 inline_data"
  );

  // The query key and its credential reference must never enter guest data: the committed
  // fixture literals, the signed package bytes, and the compiled guest artifacts are scanned.
  for fixture in [
    GEMINI_MODELS_PAGE_1_FIXTURE,
    GEMINI_MODELS_PAGE_2_FIXTURE,
    GEMINI_MODELS_PAGE_REPEATED_TOKEN_FIXTURE,
    GEMINI_MODELS_PAGE_CURSOR_2_FIXTURE,
    GEMINI_MODELS_PAGE_CURSOR_3_FIXTURE,
    GEMINI_CHAT_COMPLETE_FIXTURE,
    GEMINI_CHAT_REQUEST_BODY,
    GEMINI_CHAT_REQUEST_STREAM_BODY,
    GEMINI_CHAT_REQUEST_IMAGE_BODY,
    GEMINI_CHAT_STREAM_SSE,
    GEMINI_RATE_LIMITED_BODY,
    GEMINI_MALFORMED_BODY,
  ] {
    assert!(
      !fixture.contains(GEMINI_TEST_SECRET) && !fixture.contains("provider/"),
      "fixture literals must never carry the query key or a credential reference"
    );
  }
  for guest_bytes in [GEMINI_MODELS_COMPONENT, GEMINI_CHAT_COMPONENT, GEMINI_PACKAGE] {
    assert!(
      !guest_bytes
        .windows(GEMINI_TEST_SECRET.len())
        .any(|window| window == GEMINI_TEST_SECRET.as_bytes()),
      "compiled guest/package bytes must never contain the query key"
    );
  }

  fn unary_request() -> LlmChatRequest {
    LlmChatRequest {
      model: "gemini-2.0-flash".into(),
      messages: vec![
        LlmChatMessage {
          role: "system".into(),
          content: "sys".into(),
        },
        LlmChatMessage {
          role: "user".into(),
          content: "hi".into(),
        },
      ],
      images: Vec::new(),
      preferences: LlmChatPreferencesV1 {
        stream: false,
        temperature: None,
        max_tokens: Some(256),
        thinking: false,
      },
    }
  }

  fn stream_request() -> LlmChatRequest {
    let mut request = unary_request();
    request.preferences.stream = true;
    request.preferences.temperature = Some(0.2);
    request.preferences.max_tokens = None;
    request
  }

  /// Capture transport: records every prepared request and returns one fixed fixture body.
  struct RecordingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    response: BoundedHttpResponse,
  }
  impl RawHttpTransport for RecordingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let response = self.response.clone();
      Box::pin(async move { Ok(response) })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  /// Sequence transport for the bounded multi-page Models List traversal: returns one fixed
  /// body per request in order, recording every prepared request.
  struct SequenceTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    bodies: Vec<&'static str>,
    next: std::sync::atomic::AtomicUsize,
  }
  impl RawHttpTransport for SequenceTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let index = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
      let body = self.bodies[index.min(self.bodies.len() - 1)].to_string();
      Box::pin(async move {
        Ok(BoundedHttpResponse {
          status: 200,
          headers: HashMap::from([("content-type".into(), "application/json".into())]),
          body: body.into_bytes(),
        })
      })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  /// SSE transport for the runtime streaming path: emits Started + the committed SSE fixture
  /// as one chunk + Finished through the transport stream contract.
  struct SseTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    sse: &'static str,
  }
  impl RawHttpTransport for SseTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        Ok(BoundedHttpResponse {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
          body: sse.into_bytes(),
        })
      })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Chunk {
          bytes: sse.into_bytes(),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Finished)?;
        Ok(())
      })
    }
  }

  fn recording_transport(
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    status: u16,
    content_type: &str,
    body: &'static str,
  ) -> Arc<RecordingTransport> {
    Arc::new(RecordingTransport {
      requests,
      response: BoundedHttpResponse {
        status,
        headers: HashMap::from([("content-type".into(), content_type.to_string())]),
        body: body.as_bytes().to_vec(),
      },
    })
  }

  fn broker_factory_for(
    db: &Database,
    vault: Arc<MemoryCredentialVault>,
    transport: Arc<dyn RawHttpTransport + Send + Sync>,
  ) -> Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> {
    Arc::new({
      let db = db.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    })
  }

  async fn run_chat_case(
    db: &Database,
    packages: PluginPackageService,
    wasm: Arc<WasmRuntime>,
    provider_model_id: uuid::Uuid,
    vault: Arc<MemoryCredentialVault>,
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    transport: Arc<RecordingTransport>,
    request: LlmChatRequest,
    expected_error: Option<CapabilityErrorCode>,
  ) -> Result<crate::domain::runtime_provider::LlmChatCompleteResult, CapabilityError> {
    let router = ProviderRuntimeRouter::new(db.clone(), packages, wasm, broker_factory_for(db, vault, transport));
    let outcome = router
      .chat(
        provider_model_id,
        b"{}".to_vec(),
        request,
        "gemini-chat-req",
        CancelToken::new(),
        None,
      )
      .await;
    match expected_error {
      Some(expected) => {
        assert!(
          matches!(&outcome, Err(CapabilityError { code, .. }) if *code == expected),
          "unexpected outcome {outcome:?}"
        );
        if let Err(CapabilityError { message, .. }) = &outcome {
          assert!(
            !message.contains(GEMINI_TEST_SECRET),
            "error message leaks the query key: {message}"
          );
          assert!(
            !message
              .as_bytes()
              .windows(FIXED_PNG.len())
              .any(|window| window == FIXED_PNG),
            "error leaks image content: {message}"
          );
        }
      }
      None => {
        assert!(outcome.is_ok(), "unexpected outcome {outcome:?}");
      }
    }
    drop(requests.lock().expect("requests poisoned"));
    outcome
  }

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let package_digest = install(&packages, GEMINI_PACKAGE);
  let provider_id = crate::domain::time::new_id();
  insert_provider_row_with(
    &db,
    provider_id,
    "gemini",
    "Gemini Provider",
    "https://generativelanguage.googleapis.com",
    AuthSchemeV1::query("key"),
    Some(format!("provider/{provider_id}/key")),
    vault.as_ref(),
    Some(GEMINI_TEST_SECRET),
  );
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm.clone());
  let preview = lifecycle
    .preview_upgrade(provider_id, &package_digest)
    .expect("gemini package previews");
  lifecycle
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .expect("gemini package applies");
  let model_id = insert_fixture_model(&db, provider_id, "gemini-2.0-flash");

  // 1) Fixed two-page Models List aggregate: the guest traverses the bounded page sequence
  // internally (pageToken on page 2) and returns one complete set with display-name labels.
  // The frozen WIT models-list ABI has no continuation field; all pagination stays in-guest.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SequenceTransport {
      requests: requests.clone(),
      bodies: vec![GEMINI_MODELS_PAGE_1_FIXTURE, GEMINI_MODELS_PAGE_2_FIXTURE],
      next: std::sync::atomic::AtomicUsize::new(0),
    });
    let router = ProviderRuntimeRouter::new(
      db.clone(),
      packages.clone(),
      wasm.clone(),
      broker_factory_for(&db, vault.clone(), transport),
    );
    let result = router
      .list_models(
        provider_id,
        "gemini",
        "gemini-models-req-two-pages",
        b"{}".to_vec(),
        CancelToken::new(),
        None,
      )
      .await
      .expect("models list succeeds");
    let ids: Vec<(&str, Option<&str>)> = result
      .models
      .iter()
      .map(|model| (model.id.as_str(), model.label.as_deref()))
      .collect();
    assert_eq!(
      ids,
      vec![("gemini-2.0-flash", Some("Flash")), ("gemini-2.0-pro", Some("Pro"))],
      "current Gemini model fixtures (two bounded pages aggregated inside the guest)"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 2, "one request per bounded page");
    assert_eq!(captured[0].method, ProviderHttpMethod::Get);
    assert_eq!(
      captured[0].url.as_str(),
      "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-test-provider-secret",
      "the guest requests the bare v1beta/models path; the host injects the query key"
    );
    assert_eq!(
      captured[0].url.path(),
      "/v1beta/models",
      "the secret never appears in the guest-visible path"
    );
    assert_eq!(
      captured[1].url.as_str(),
      "https://generativelanguage.googleapis.com/v1beta/models?pageToken=tok-2&key=gemini-test-provider-secret",
      "page 2 continues from the fixed nextPageToken with host-injected query auth"
    );
    drop(captured);
  }

  // 2) Repeated-token rejection: a page returning the SAME nextPageToken as the previous
  // page is a bounded failure; no partial list is ever returned.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SequenceTransport {
      requests: requests.clone(),
      bodies: vec![GEMINI_MODELS_PAGE_1_FIXTURE, GEMINI_MODELS_PAGE_REPEATED_TOKEN_FIXTURE],
      next: std::sync::atomic::AtomicUsize::new(0),
    });
    let router = ProviderRuntimeRouter::new(
      db.clone(),
      packages.clone(),
      wasm.clone(),
      broker_factory_for(&db, vault.clone(), transport),
    );
    let err = router
      .list_models(
        provider_id,
        "gemini",
        "gemini-models-req-repeated-token",
        b"{}".to_vec(),
        CancelToken::new(),
        None,
      )
      .await
      .unwrap_err();
    assert!(
      matches!(
        &err,
        CapabilityError {
          code: CapabilityErrorCode::InvalidResponse,
          ..
        }
      ),
      "repeated page token: {err:?}"
    );
    assert_eq!(
      requests.lock().expect("requests poisoned").len(),
      2,
      "the guest stops at the repeated token without a partial list"
    );
  }

  // 3) Bounded page traversal fails closed: a transport that always yields a fresh cursor
  // never produces a partial list; the guest stops at its named page cap with a stable error.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SequenceTransport {
      requests: requests.clone(),
      bodies: vec![
        GEMINI_MODELS_PAGE_1_FIXTURE,
        GEMINI_MODELS_PAGE_CURSOR_2_FIXTURE,
        GEMINI_MODELS_PAGE_CURSOR_3_FIXTURE,
        GEMINI_MODELS_PAGE_1_FIXTURE,
        GEMINI_MODELS_PAGE_CURSOR_2_FIXTURE,
      ],
      next: std::sync::atomic::AtomicUsize::new(0),
    });
    let router = ProviderRuntimeRouter::new(
      db.clone(),
      packages.clone(),
      wasm.clone(),
      broker_factory_for(&db, vault.clone(), transport),
    );
    let err = router
      .list_models(
        provider_id,
        "gemini",
        "gemini-models-req-page-limit",
        b"{}".to_vec(),
        CancelToken::new(),
        None,
      )
      .await
      .unwrap_err();
    assert!(
      matches!(
        &err,
        CapabilityError {
          code: CapabilityErrorCode::InvalidResponse,
          ..
        }
      ),
      "page cap: {err:?}"
    );
    assert_eq!(
      requests.lock().expect("requests poisoned").len(),
      5,
      "the guest stops at its named maximum page count without a partial list"
    );
  }

  // 4) Fixed unary Chat: the captured request body byte-matches the committed fixture
  // (systemInstruction, contents, generationConfig.maxOutputTokens) and the response content
  // matches the current provider (joined parts, trimmed).
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 200, "application/json", GEMINI_CHAT_COMPLETE_FIXTURE);
    let complete = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      None,
    )
    .await
    .expect("fixed unary chat completes");
    assert_eq!(complete.role, "assistant");
    assert_eq!(
      complete.content, "hello world",
      "joined parts match the current provider"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, ProviderHttpMethod::Post);
    assert_eq!(
      captured[0].url.as_str(),
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=gemini-test-provider-secret",
      "the generateContent resource path carries the host-injected query key only"
    );
    assert_eq!(
      captured[0].headers.get("Content-Type").map(String::as_str),
      Some("application/json")
    );
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, GEMINI_CHAT_REQUEST_BODY,
          "captured unary body matches the committed current-provider fixture"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 5) Image inline_data: the guest reads the host-owned Blob and emits the base64 inline_data
  // in the provider wire body only; image bytes never cross WIT semantic fields or errors.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 200, "application/json", GEMINI_CHAT_COMPLETE_FIXTURE);
    let mut request = unary_request();
    request.messages[1].content = "What is in this image?".into();
    request.images = vec![FIXED_PNG.to_vec()];
    let complete = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      request,
      None,
    )
    .await
    .expect("image chat completes");
    assert_eq!(complete.content, "hello world");
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, GEMINI_CHAT_REQUEST_IMAGE_BODY,
          "captured image body matches the committed image wire fixture"
        );
        assert!(
          !body
            .as_bytes()
            .windows(FIXED_PNG.len())
            .any(|window| window == FIXED_PNG),
          "raw image bytes never appear in the wire body (base64 inline_data only)"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 6) Typed stream deltas: the committed SSE fixture produces ordered Text deltas and one
  // terminal Complete; the captured request carries alt=sse on the streamGenerateContent
  // resource path plus the host-injected query key and the stream Accept header.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SseTransport {
      requests: requests.clone(),
      sse: GEMINI_CHAT_STREAM_SSE,
    });
    let router = ProviderRuntimeRouter::new(
      db.clone(),
      packages.clone(),
      wasm.clone(),
      broker_factory_for(&db, vault.clone(), transport),
    );
    let sessions = RequestSessionRegistry::new();
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    let sink = events.clone();
    let input = ProviderRuntimeChatCommandInput {
      request_id: "gemini-chat-stream-req".into(),
      provider_model_id: model_id,
      config: b"{}".to_vec(),
      request: stream_request(),
    };
    let result = run_provider_runtime_chat(
      &router,
      &sessions,
      input,
      Box::new(move |event| {
        sink.lock().expect("events poisoned").push(event);
        Ok(())
      }),
    )
    .await
    .expect("streaming chat completes");
    assert_eq!(result, None, "streaming chat returns no complete message");
    let expected: Vec<ProviderRuntimeChatEvent> = vec![
      ProviderRuntimeChatEvent::Text { text: "wo".into() },
      ProviderRuntimeChatEvent::Text { text: "rld".into() },
      ProviderRuntimeChatEvent::Complete { status: "stop".into() },
    ];
    assert_eq!(
      events.lock().expect("events poisoned").clone(),
      expected,
      "split text deltas (the empty-parts event is ignored) with one terminal complete"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(
      captured[0].url.as_str(),
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=gemini-test-provider-secret",
      "alt=sse selects the host stream response mode; the query key stays host-injected"
    );
    assert_eq!(
      captured[0].headers.get("Accept").map(String::as_str),
      Some("text/event-stream"),
      "the guest selects the host stream response mode"
    );
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, GEMINI_CHAT_REQUEST_STREAM_BODY,
          "captured streaming body matches the committed stream fixture"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 7) Malformed provider body: the host broker boundary rejects malformed JSON before the
  // guest (fail-closed); the denial maps to a stable invalid request.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 200, "application/json", GEMINI_MALFORMED_BODY);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::InvalidRequest),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
  }

  // 8) Provider error mapping: a 429 fixture maps to rate_limited; a body with no text parts
  // maps to invalid_response; a malformed SSE payload maps to invalid_response with no delta.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 429, "application/json", GEMINI_RATE_LIMITED_BODY);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::RateLimited),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
  }
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 200, "application/json", r#"{"candidates":[]}"#);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      unary_request(),
      Some(CapabilityErrorCode::InvalidResponse),
    )
    .await;
  }
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SseTransport {
      requests: requests.clone(),
      sse: "data: {broken\n\n",
    });
    let router = ProviderRuntimeRouter::new(
      db.clone(),
      packages.clone(),
      wasm.clone(),
      broker_factory_for(&db, vault.clone(), transport),
    );
    let sessions = RequestSessionRegistry::new();
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    let sink = events.clone();
    let input = ProviderRuntimeChatCommandInput {
      request_id: "gemini-chat-stream-req-malformed".into(),
      provider_model_id: model_id,
      config: b"{}".to_vec(),
      request: stream_request(),
    };
    let outcome = run_provider_runtime_chat(
      &router,
      &sessions,
      input,
      Box::new(move |event| {
        sink.lock().expect("events poisoned").push(event);
        Ok(())
      }),
    )
    .await;
    assert!(
      matches!(
        &outcome,
        Err(CapabilityError {
          code: CapabilityErrorCode::InvalidResponse,
          ..
        })
      ),
      "malformed SSE event: {outcome:?}"
    );
    assert!(
      events.lock().expect("events poisoned").is_empty(),
      "no delta is forwarded for a malformed SSE event"
    );
  }

  // The binding is unchanged after every case, and the sanitized binding DTO exposes no
  // credential reference or secret material.
  let binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "gemini"))
    .unwrap();
  assert_eq!(binding.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(binding.state, ProviderRuntimeState::Active);
  assert_eq!(binding.package_digest.as_deref(), Some(package_digest.as_str()));
  assert_eq!(binding.grant_set_revision, Some(1));
  // The sanitized provider DTO (the public IPC shape) exposes no credential reference or
  // secret material; the raw row keeps the reference only inside the repository.
  let provider_dto = crate::services::providers::ProviderService::new(db.clone(), vault.clone())
    .get(provider_id)
    .expect("provider DTO");
  let provider_json = serde_json::to_string(&provider_dto).unwrap();
  assert!(
    !provider_json.contains(GEMINI_TEST_SECRET) && !provider_json.contains("provider/"),
    "provider DTO must not leak the query key or its credential reference"
  );
}

/// Phase 8 Task 21: the DeepSeek runtime package reproduces the current TypeScript provider
/// through the generic runtime host, and the host-projected DeepSeek detection metadata
/// (thinking disabled, 2048-token budget) reaches the semantic runtime request without
/// granting workflow-policy control to the guest. The catalog projects the bounded detection
/// defaults; the guest derives the thinking payload ONLY from the host preference envelope.
/// The explicit lifecycle migration/rollback path is exercised for this built-in.
#[tokio::test]
async fn deepseek_runtime_component_matches_current_provider_and_detection_policy_fixtures() {
  use crate::cmds::runtime_providers::run_provider_runtime_chat;
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::cancel::RequestSessionRegistry;
  use crate::domain::provider_http::ProviderHttpMethod;
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeRollbackInput, LlmChatMessage, LlmChatPreferencesV1, LlmChatRequest,
    ProviderRuntimeChatCommandInput, ProviderRuntimeChatEvent,
  };
  use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
  use crate::services::bounded_http::RequestBody;
  use crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle;
  use crate::services::provider_runtime_router::ProviderRuntimeRouter;
  use crate::services::wasm_runtime::host::BrokerHandle;
  use std::collections::HashMap;

  // Host-injected bearer credential; it must never appear in guest-visible data. The
  // committed fixtures and the compiled guests are scanned below.
  const DEEPSEEK_TEST_SECRET: &str = "sk-deepseek-test-provider-secret";

  // Fixed 1x1 transparent PNG (67 bytes). Its base64 data URL appears ONLY in the expected
  // provider wire fixture below; the bytes never cross WIT semantic fields, logs, or DTOs.
  const FIXED_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ];
  assert_eq!(
    FIXED_PNG.len(),
    67,
    "the fixed PNG byte count is part of the expected fixture"
  );
  assert!(
    DEEPSEEK_CHAT_REQUEST_IMAGE_BODY.contains("iVBORw0KGgo"),
    "the expected image wire fixture embeds the fixed PNG base64 data URL"
  );

  // The bearer secret and its credential reference must never enter guest data: the
  // committed fixture literals, the signed package bytes, and the compiled guests are scanned.
  for fixture in [
    DEEPSEEK_MODELS_FIXTURE,
    DEEPSEEK_CHAT_COMPLETE_FIXTURE,
    DEEPSEEK_CHAT_REQUEST_BODY,
    DEEPSEEK_CHAT_REQUEST_STREAM_BODY,
    DEEPSEEK_CHAT_REQUEST_THINKING_ENABLED_BODY,
    DEEPSEEK_CHAT_REQUEST_IMAGE_BODY,
    DEEPSEEK_CHAT_STREAM_SSE,
    DEEPSEEK_RATE_LIMITED_BODY,
    DEEPSEEK_MALFORMED_BODY,
  ] {
    assert!(
      !fixture.contains(DEEPSEEK_TEST_SECRET) && !fixture.contains("provider/"),
      "fixture literals must never carry the API key or a credential reference"
    );
  }
  for guest_bytes in [DEEPSEEK_MODELS_COMPONENT, DEEPSEEK_CHAT_COMPONENT, DEEPSEEK_PACKAGE] {
    assert!(
      !guest_bytes
        .windows(DEEPSEEK_TEST_SECRET.len())
        .any(|window| window == DEEPSEEK_TEST_SECRET.as_bytes()),
      "compiled guest/package bytes must never contain the API key"
    );
  }

  fn detection_request() -> LlmChatRequest {
    // The host-owned detection policy projected from the catalog metadata: thinking disabled
    // with the raised 2048-token budget (DETECT_MAX_TOKENS_THINKING in the current plugin).
    LlmChatRequest {
      model: "deepseek-chat".into(),
      messages: vec![
        LlmChatMessage {
          role: "system".into(),
          content: "sys".into(),
        },
        LlmChatMessage {
          role: "user".into(),
          content: "hi".into(),
        },
      ],
      images: Vec::new(),
      preferences: LlmChatPreferencesV1 {
        stream: false,
        temperature: Some(0.0),
        max_tokens: Some(2048),
        thinking: false,
      },
    }
  }

  fn stream_request() -> LlmChatRequest {
    let mut request = detection_request();
    request.preferences.stream = true;
    request
  }

  /// Capture transport: records every prepared request and returns one fixed fixture body.
  struct RecordingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    response: BoundedHttpResponse,
  }
  impl RawHttpTransport for RecordingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let response = self.response.clone();
      Box::pin(async move { Ok(response) })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  /// SSE transport for the runtime streaming path: emits Started + the committed SSE fixture
  /// as one chunk + Finished through the transport stream contract.
  struct SseTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    sse: &'static str,
  }
  impl RawHttpTransport for SseTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        Ok(BoundedHttpResponse {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
          body: sse.into_bytes(),
        })
      })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Chunk {
          bytes: sse.into_bytes(),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Finished)?;
        Ok(())
      })
    }
  }

  fn recording_transport(
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    status: u16,
    content_type: &str,
    body: &'static str,
  ) -> Arc<RecordingTransport> {
    Arc::new(RecordingTransport {
      requests,
      response: BoundedHttpResponse {
        status,
        headers: HashMap::from([("content-type".into(), content_type.to_string())]),
        body: body.as_bytes().to_vec(),
      },
    })
  }

  fn broker_factory_for(
    db: &Database,
    vault: Arc<MemoryCredentialVault>,
    transport: Arc<dyn RawHttpTransport + Send + Sync>,
  ) -> Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> {
    Arc::new({
      let db = db.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    })
  }

  async fn run_chat_case(
    db: &Database,
    packages: PluginPackageService,
    wasm: Arc<WasmRuntime>,
    provider_model_id: uuid::Uuid,
    vault: Arc<MemoryCredentialVault>,
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    transport: Arc<RecordingTransport>,
    request: LlmChatRequest,
    expected_error: Option<CapabilityErrorCode>,
  ) -> Result<crate::domain::runtime_provider::LlmChatCompleteResult, CapabilityError> {
    let router = ProviderRuntimeRouter::new(db.clone(), packages, wasm, broker_factory_for(db, vault, transport));
    let outcome = router
      .chat(
        provider_model_id,
        b"{}".to_vec(),
        request,
        "deepseek-chat-req",
        CancelToken::new(),
        None,
      )
      .await;
    match expected_error {
      Some(expected) => {
        assert!(
          matches!(&outcome, Err(CapabilityError { code, .. }) if *code == expected),
          "unexpected outcome {outcome:?}"
        );
        if let Err(CapabilityError { message, .. }) = &outcome {
          assert!(
            !message.contains(DEEPSEEK_TEST_SECRET),
            "error message leaks the API key: {message}"
          );
          assert!(
            !message
              .as_bytes()
              .windows(FIXED_PNG.len())
              .any(|window| window == FIXED_PNG),
            "error leaks image content: {message}"
          );
        }
      }
      None => {
        assert!(outcome.is_ok(), "unexpected outcome {outcome:?}");
      }
    }
    drop(requests.lock().expect("requests poisoned"));
    outcome
  }

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let package_digest = install(&packages, DEEPSEEK_PACKAGE);
  let provider_id = crate::domain::time::new_id();
  insert_provider_row_with(
    &db,
    provider_id,
    "deepseek",
    "DeepSeek Provider",
    "https://api.deepseek.com",
    AuthSchemeV1::bearer(),
    Some(format!("provider/{provider_id}/key")),
    vault.as_ref(),
    Some(DEEPSEEK_TEST_SECRET),
  );
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm.clone());
  let preview = lifecycle
    .preview_upgrade(provider_id, &package_digest)
    .expect("deepseek package previews");
  lifecycle
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .expect("deepseek package applies");
  let model_id = insert_fixture_model(&db, provider_id, "deepseek-chat");

  // 0) The catalog projects the bounded host-interpreted DeepSeek detection metadata
  // (thinking disabled with the raised 2048-token budget) — never guest workflow authority.
  {
    let catalog = ProviderRuntimeCatalog::new(db.clone(), packages.clone(), wasm.clone());
    let entries = catalog.list().unwrap();
    let entry = entries
      .iter()
      .find(|entry| entry.plugin_id == "com.langnext.provider.deepseek")
      .expect("deepseek catalog entry");
    let detection = entry.detection.expect("deepseek detection metadata projected");
    assert_eq!(detection.max_tokens, 2048);
    assert!(!detection.thinking);
  }

  // 1) Fixed Models List: GET /models through the broker; the result matches the current
  // provider fixture (ids only, no remote display names).
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 200, "application/json", DEEPSEEK_MODELS_FIXTURE);
    let router = ProviderRuntimeRouter::new(
      db.clone(),
      packages.clone(),
      wasm.clone(),
      broker_factory_for(&db, vault.clone(), transport),
    );
    let result = router
      .list_models(
        provider_id,
        "deepseek",
        "deepseek-models-req-fixed",
        b"{}".to_vec(),
        CancelToken::new(),
        None,
      )
      .await
      .expect("models list succeeds");
    let ids: Vec<(&str, Option<&str>)> = result
      .models
      .iter()
      .map(|model| (model.id.as_str(), model.label.as_deref()))
      .collect();
    assert_eq!(
      ids,
      vec![("deepseek-chat", None), ("deepseek-reasoner", None)],
      "current DeepSeek model fixtures"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, ProviderHttpMethod::Get);
    assert_eq!(captured[0].url.as_str(), "https://api.deepseek.com/models");
    assert_eq!(
      captured[0].headers.get("Authorization").map(String::as_str),
      Some(format!("Bearer {DEEPSEEK_TEST_SECRET}").as_str()),
      "host injects the stored credential after authorization"
    );
    drop(captured);
  }

  // 2) Unary Chat with the host-projected detection policy: the semantic request carries
  // thinking=false and maxTokens=2048 (from the catalog metadata), and the captured wire body
  // matches the committed fixture with `thinking:{type:"disabled"}` and max_tokens.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      DEEPSEEK_CHAT_COMPLETE_FIXTURE,
    );
    let complete = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      detection_request(),
      None,
    )
    .await
    .expect("fixed unary chat completes");
    assert_eq!(complete.role, "assistant");
    assert_eq!(complete.content, "hello", "chat content matches the current provider");
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, ProviderHttpMethod::Post);
    assert_eq!(captured[0].url.as_str(), "https://api.deepseek.com/chat/completions");
    assert_eq!(
      captured[0].headers.get("Content-Type").map(String::as_str),
      Some("application/json")
    );
    assert_eq!(
      captured[0].headers.get("Authorization").map(String::as_str),
      Some(format!("Bearer {DEEPSEEK_TEST_SECRET}").as_str()),
      "the host injects the bearer credential; the guest never supplies it"
    );
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, DEEPSEEK_CHAT_REQUEST_BODY,
          "captured unary body matches the committed detection-policy fixture"
        );
        assert!(
          body.contains("\"thinking\":{\"type\":\"disabled\"}") && body.contains("\"max_tokens\":2048"),
          "the host-projected detection policy reaches the wire body"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 3) Host-owned policy proof: the SAME guest config cannot alter the thinking policy; only
  // the host envelope does. With thinking=true in the envelope, the wire body carries
  // `{"type":"enabled"}` and no temperature/max_tokens.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      DEEPSEEK_CHAT_COMPLETE_FIXTURE,
    );
    let mut request = detection_request();
    request.preferences.thinking = true;
    request.preferences.temperature = None;
    request.preferences.max_tokens = None;
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      request,
      None,
    )
    .await
    .expect("thinking-enabled chat completes");
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, DEEPSEEK_CHAT_REQUEST_THINKING_ENABLED_BODY,
          "the guest derives thinking policy from the host envelope only"
        );
        assert!(
          body.contains("\"thinking\":{\"type\":\"enabled\"}"),
          "host-enabled thinking reaches the wire body"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 4) Split streaming text deltas: the committed SSE fixture produces ordered Text deltas
  // and one terminal Complete; the captured request body carries the host-selected stream flag.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SseTransport {
      requests: requests.clone(),
      sse: DEEPSEEK_CHAT_STREAM_SSE,
    });
    let router = ProviderRuntimeRouter::new(
      db.clone(),
      packages.clone(),
      wasm.clone(),
      broker_factory_for(&db, vault.clone(), transport),
    );
    let sessions = RequestSessionRegistry::new();
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    let sink = events.clone();
    let input = ProviderRuntimeChatCommandInput {
      request_id: "deepseek-chat-stream-req".into(),
      provider_model_id: model_id,
      config: b"{}".to_vec(),
      request: stream_request(),
    };
    let result = run_provider_runtime_chat(
      &router,
      &sessions,
      input,
      Box::new(move |event| {
        sink.lock().expect("events poisoned").push(event);
        Ok(())
      }),
    )
    .await
    .expect("streaming chat completes");
    assert_eq!(result, None, "streaming chat returns no complete message");
    let expected: Vec<ProviderRuntimeChatEvent> = vec![
      ProviderRuntimeChatEvent::Text { text: "wo".into() },
      ProviderRuntimeChatEvent::Text { text: "rld".into() },
      ProviderRuntimeChatEvent::Complete { status: "stop".into() },
    ];
    assert_eq!(
      events.lock().expect("events poisoned").clone(),
      expected,
      "split streaming text deltas with one terminal complete"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].url.as_str(), "https://api.deepseek.com/chat/completions");
    assert_eq!(
      captured[0].headers.get("Accept").map(String::as_str),
      Some("text/event-stream"),
      "the guest selects the host stream response mode"
    );
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, DEEPSEEK_CHAT_REQUEST_STREAM_BODY,
          "captured streaming body matches the committed stream fixture"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 5) Image Blob usage: the guest reads the host-owned Blob and emits the base64 data URL
  // in the provider wire body only; image bytes never cross WIT semantic fields or errors.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      DEEPSEEK_CHAT_COMPLETE_FIXTURE,
    );
    let mut request = detection_request();
    request.messages[1].content = "What is in this image?".into();
    request.images = vec![FIXED_PNG.to_vec()];
    let complete = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      request,
      None,
    )
    .await
    .expect("image chat completes");
    assert_eq!(complete.content, "hello");
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert_eq!(
          body, DEEPSEEK_CHAT_REQUEST_IMAGE_BODY,
          "captured image body matches the committed image wire fixture"
        );
        assert!(
          !body
            .as_bytes()
            .windows(FIXED_PNG.len())
            .any(|window| window == FIXED_PNG),
          "raw image bytes never appear in the wire body (base64 data URL only)"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
  }

  // 6) Malformed provider body: the host broker boundary rejects malformed JSON before the
  // guest (fail-closed); the denial maps to a stable invalid request.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 200, "application/json", DEEPSEEK_MALFORMED_BODY);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      detection_request(),
      Some(CapabilityErrorCode::InvalidRequest),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
  }

  // 7) Provider error mapping: a 429 fixture maps to rate_limited; a response missing
  // choices maps to invalid_response.
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 429, "application/json", DEEPSEEK_RATE_LIMITED_BODY);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      detection_request(),
      Some(CapabilityErrorCode::RateLimited),
    )
    .await;
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
  }
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(requests.clone(), 200, "application/json", r#"{"choices":[]}"#);
    let _ = run_chat_case(
      &db,
      packages.clone(),
      wasm.clone(),
      model_id,
      vault.clone(),
      requests.clone(),
      transport,
      detection_request(),
      Some(CapabilityErrorCode::InvalidResponse),
    )
    .await;
  }

  // 8) Explicit lifecycle rollback restores the exact legacy binding; the provider rows are
  // untouched and the legacy executor remains the active path for this built-in.
  {
    let rollback_preview = lifecycle
      .preview_rollback(provider_id)
      .expect("deepseek rollback previews");
    lifecycle
      .apply_rollback(ApplyProviderRuntimeRollbackInput {
        preview_id: rollback_preview.preview_id,
      })
      .expect("deepseek rollback applies");
    let binding = db
      .read(|conn| provider_runtime_bindings::get(conn, provider_id, "deepseek"))
      .unwrap();
    assert_eq!(binding.runtime_kind, ProviderRuntimeKind::LegacyFrontendProvider);
    assert_eq!(binding.state, ProviderRuntimeState::Active);
    assert!(binding.package_digest.is_none());
    assert!(binding.grant_set_revision.is_none());
  }

  // The sanitized provider DTO exposes no credential reference or secret material.
  let provider_dto = crate::services::providers::ProviderService::new(db.clone(), vault.clone())
    .get(provider_id)
    .expect("provider DTO");
  let provider_json = serde_json::to_string(&provider_dto).unwrap();
  assert!(
    !provider_json.contains(DEEPSEEK_TEST_SECRET) && !provider_json.contains("provider/"),
    "provider DTO must not leak the API key or its credential reference"
  );
}

/// Phase 8 headless smoke: one end-to-end pass over the manual-validation checklist using the
/// real dev-signed OpenAI Compatible product package and a capture transport. Gated by
/// `RUN_RUNTIME_PROVIDER_SMOKE=1` (see `.mise/tasks/smoke/runtime-providers`). Live
/// provider-account steps (real network, UI fallback reset, manual log inspection) are never
/// replaced by fixtures; this test proves every fixture-backed path in one sequence.
#[tokio::test]
async fn runtime_provider_smoke_end_to_end() {
  if std::env::var("RUN_RUNTIME_PROVIDER_SMOKE").is_err() {
    return;
  }
  use crate::cmds::runtime_providers::{cancel_runtime_request, run_provider_runtime_chat};
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::cancel::RequestSessionRegistry;
  use crate::domain::provider::{BaseUrlSource, CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode};
  use crate::domain::provider_http::ProviderHttpMethod;
  use crate::domain::runtime_lifecycle::GrantSubjectKind;
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeRollbackInput, ApplyProviderRuntimeUpgradeInput, LlmChatMessage, LlmChatPreferencesV1,
    LlmChatRequest, ProviderRuntimeChatCommandInput, ProviderRuntimeChatEvent, ProviderRuntimeKind,
    ProviderRuntimeState,
  };
  use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
  use crate::services::bounded_http::RequestBody;
  use crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle;
  use crate::services::provider_runtime_router::ProviderRuntimeRouter;
  use crate::services::providers::ProviderService;
  use crate::services::wasm_runtime::host::BrokerHandle;
  use std::collections::HashMap;
  use std::time::Duration;

  // Fixed 1x1 transparent PNG (67 bytes): the base64 data URL appears only in provider wire
  // fixtures; raw bytes never cross WIT semantic fields, logs, DTOs, or errors.
  const FIXED_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ];
  const SMOKE_SECRET: &str = "sk-smoke-provider-secret";
  const SMOKE_PROMPT: &str = "smoke fixture prompt must never leak";

  fn provider_write() -> ProviderInstanceWrite {
    ProviderInstanceWrite {
      id: None,
      adapter_id: "openai-compatible".into(),
      display_name: "Smoke OpenAI Compatible".into(),
      base_url: "https://api.openai.com/v1".into(),
      base_url_source: BaseUrlSource::PluginDefault,
      auth_scheme: AuthSchemeV1::bearer(),
      credential_kind: CredentialKind::ApiKey,
      credential: CredentialUpdate::Keep,
      enabled: true,
      proxy_mode: ProxyMode::Inherit,
      insecure_http_confirmed_at: None,
      expected_updated_at: None,
    }
  }

  fn unary_request() -> LlmChatRequest {
    LlmChatRequest {
      model: "gpt-4o-mini".into(),
      messages: vec![
        LlmChatMessage {
          role: "system".into(),
          content: "sys".into(),
        },
        LlmChatMessage {
          role: "user".into(),
          content: "hello".into(),
        },
      ],
      images: Vec::new(),
      preferences: LlmChatPreferencesV1 {
        stream: false,
        temperature: Some(0.2),
        max_tokens: Some(128),
        thinking: false,
      },
    }
  }

  fn stream_request() -> LlmChatRequest {
    let mut request = unary_request();
    request.preferences.stream = true;
    request
  }

  /// Capture transport: records every prepared request and returns one fixed fixture body.
  struct RecordingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    response: BoundedHttpResponse,
  }
  impl RawHttpTransport for RecordingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let response = self.response.clone();
      Box::pin(async move { Ok(response) })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  /// SSE transport for the streaming path: emits Started + the committed SSE fixture as one
  /// chunk + Finished through the transport stream contract.
  struct SseTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    sse: &'static str,
  }
  impl RawHttpTransport for SseTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        Ok(BoundedHttpResponse {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
          body: sse.into_bytes(),
        })
      })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      let sse = self.sse.to_string();
      Box::pin(async move {
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Started {
          status: 200,
          headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Chunk {
          bytes: sse.into_bytes(),
        })?;
        on_event(crate::domain::provider_http::ProviderHttpStreamEvent::Finished)?;
        Ok(())
      })
    }
  }

  /// Parking transport: records the request, then blocks until the host cancels the broker call.
  struct ParkingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
  }
  impl RawHttpTransport for ParkingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { std::future::pending().await })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests poisoned").push(prepared);
      Box::pin(async { std::future::pending().await })
    }
  }

  fn recording_transport(
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
    status: u16,
    content_type: &str,
    body: &'static str,
  ) -> Arc<RecordingTransport> {
    Arc::new(RecordingTransport {
      requests,
      response: BoundedHttpResponse {
        status,
        headers: HashMap::from([("content-type".into(), content_type.to_string())]),
        body: body.as_bytes().to_vec(),
      },
    })
  }

  fn make_router(
    db: &Database,
    packages: PluginPackageService,
    wasm: Arc<WasmRuntime>,
    vault: Arc<MemoryCredentialVault>,
    transport: Arc<dyn RawHttpTransport>,
  ) -> ProviderRuntimeRouter {
    let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
      let db = db.clone();
      let vault = vault.clone();
      let transport = transport.clone();
      move |context| {
        Box::new(ProviderRuntimeBrokerHandle::new(
          db.clone(),
          vault.clone(),
          transport.clone(),
          context,
        ))
      }
    });
    ProviderRuntimeRouter::new(db.clone(), packages, wasm, broker_factory)
  }

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let runtime = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm.clone());
  let providers = ProviderService::new(db.clone(), vault.clone()).with_runtime_defaults(Arc::new(runtime.clone()));

  // [1] Manual item 1: a matching Provider created before the reviewed default resolves stays
  // legacy; a new matching Provider receives the exact default package/grant.
  let preexisting = providers.save(provider_write()).expect("pre-existing provider create");
  assert_eq!(
    preexisting.runtime.runtime_kind,
    ProviderRuntimeKind::LegacyFrontendProvider,
    "pre-existing provider stays legacy"
  );
  let import = packages
    .bootstrap_bundled_package(OPENAI_COMPATIBLE_PACKAGE, false)
    .expect("vendor fixture bootstraps");
  let product_digest = import.package_digest().to_string();
  runtime
    .set_vendor_default(Some(&import))
    .expect("vendor default resolves");
  let matching = providers.save(provider_write()).expect("new matching provider create");
  assert_eq!(matching.runtime.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(matching.runtime.state, ProviderRuntimeState::Active);
  assert_eq!(
    matching.runtime.package_digest.as_deref(),
    Some(product_digest.as_str())
  );
  let grant = db
    .read(|conn| {
      plugin_permission_grants::get_for_subject_package_revision(
        conn,
        GrantSubjectKind::ProviderInstance,
        matching.id,
        &product_digest,
        1,
      )
    })
    .expect("new provider grant");
  assert_eq!(
    grant.subject_id, matching.id,
    "grant subject is exactly the new provider"
  );
  println!("SMOKE ok: vendor default applies only to the new matching provider; pre-existing stays legacy");

  // The host-owned credential is stored through the real Provider save path (create → enter
  // API key), exactly like the manual walkthrough; the runtime binding is untouched.
  let saved = providers
    .save(ProviderInstanceWrite {
      id: Some(matching.id),
      adapter_id: "openai-compatible".into(),
      display_name: "Smoke OpenAI Compatible".into(),
      base_url: "https://api.openai.com/v1".into(),
      base_url_source: BaseUrlSource::PluginDefault,
      auth_scheme: AuthSchemeV1::bearer(),
      credential_kind: CredentialKind::ApiKey,
      credential: CredentialUpdate::Replace(SMOKE_SECRET.into()),
      enabled: true,
      proxy_mode: ProxyMode::Inherit,
      insecure_http_confirmed_at: None,
      expected_updated_at: Some(matching.updated_at.clone()),
    })
    .expect("credential save succeeds");
  assert_eq!(saved.runtime.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert!(saved.has_credential, "host vault holds the API key");
  let model_id = insert_fixture_model(&db, matching.id, "gpt-4o-mini");

  // A fixed model row on the default-bound Provider must survive the full lifecycle.
  let fixed_model_id = crate::domain::time::new_id();
  let now = crate::domain::time::now_rfc3339();
  db.transaction(|uow| {
    crate::repositories::provider_models::insert(
      uow.conn(),
      &crate::domain::model::ProviderModel {
        id: fixed_model_id,
        provider_instance_id: preexisting.id,
        model_key: "smoke-model".into(),
        source: crate::domain::model::ModelSource::Manual,
        remote_display_name: None,
        display_name_override: None,
        enabled: true,
        availability: crate::domain::model::Availability::Available,
        remote_metadata_json: None,
        capability_overrides_json: None,
        adapter_id: None,
        source_adapter_id: String::new(),
        last_seen_at: None,
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    Ok(())
  })
  .unwrap();

  // [2] Manual item 2: explicit preview + acknowledged apply on an existing Provider. The
  // product package is already active on `matching` (one package binds one provider), so the
  // explicit lifecycle is exercised with the committed conformance package (same legacy alias,
  // distinct digest) on the pre-existing Provider.
  let conformance_digest = install(&packages, LLM_PROVIDER_PACKAGE);
  let preview = runtime
    .preview_upgrade(preexisting.id, &conformance_digest)
    .expect("preview succeeds");
  assert!(preview.requires_permission_approval);
  let applied = runtime
    .apply_upgrade(ApplyProviderRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .expect("apply succeeds");
  assert_eq!(applied.runtime.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(
    applied.runtime.package_digest.as_deref(),
    Some(conformance_digest.as_str())
  );
  assert_eq!(applied.runtime.grant_set_revision, Some(1));
  println!("SMOKE ok: explicit preview/apply binds the exact package and provider grant");

  // [3] Runtime Models List through the real Component and broker (item 2 sync proxy).
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_COMPATIBLE_MODELS_FIXTURE,
    );
    let router = make_router(&db, packages.clone(), wasm.clone(), vault.clone(), transport);
    let result = router
      .list_models(
        matching.id,
        "openai-compatible",
        "smoke-models-req",
        b"{}".to_vec(),
        CancelToken::new(),
        None,
      )
      .await
      .expect("models list succeeds");
    let ids: Vec<&str> = result.models.iter().map(|model| model.id.as_str()).collect();
    assert_eq!(
      ids,
      vec!["gpt-4o-mini", "gpt-4o"],
      "fixed current-provider model fixture"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, ProviderHttpMethod::Get);
    assert_eq!(captured[0].url.as_str(), "https://api.openai.com/v1/models");
    assert_eq!(
      captured[0].headers.get("Authorization").map(String::as_str),
      Some("Bearer sk-smoke-provider-secret"),
      "host injects the stored credential only after authorization"
    );
    drop(captured);
    println!("SMOKE ok: bounded Models List executes the verified component through the broker");
  }

  // [4] Unary Chat with a host-owned image Blob (items 3/6 proxies).
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_COMPATIBLE_CHAT_COMPLETE_FIXTURE,
    );
    let mut request = unary_request();
    request.messages[1].content = SMOKE_PROMPT.into();
    request.images = vec![FIXED_PNG.to_vec()];
    let router = make_router(&db, packages.clone(), wasm.clone(), vault.clone(), transport);
    let complete = router
      .chat(
        model_id,
        b"{}".to_vec(),
        request,
        "smoke-chat-req",
        CancelToken::new(),
        None,
      )
      .await
      .expect("unary chat completes");
    assert_eq!(
      complete.content, "hi",
      "fixed complete text from the current-provider fixture"
    );
    assert!(
      !complete
        .content
        .as_bytes()
        .windows(FIXED_PNG.len())
        .any(|window| window == FIXED_PNG),
      "complete text never contains raw image bytes"
    );
    let captured = requests.lock().expect("requests poisoned");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, ProviderHttpMethod::Post);
    match &captured[0].body {
      RequestBody::Text(body) => {
        assert!(
          body.contains("iVBORw0KGgo"),
          "image wire body embeds the base64 data URL"
        );
        assert!(!body.contains(SMOKE_SECRET), "wire body never carries the credential");
        assert!(
          !body
            .as_bytes()
            .windows(FIXED_PNG.len())
            .any(|window| window == FIXED_PNG),
          "raw image bytes never appear in the wire body (base64 data URL only)"
        );
      }
      other => panic!("expected a JSON text body, got {other:?}"),
    }
    drop(captured);
    println!("SMOKE ok: unary Chat executes through the host Blob path with the image fixture");
  }

  // [5] Streaming Chat: ordered typed deltas and exactly one terminal frame (item 3 proxy).
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(SseTransport {
      requests: requests.clone(),
      sse: OPENAI_COMPATIBLE_CHAT_STREAM_SSE,
    });
    let router = make_router(&db, packages.clone(), wasm.clone(), vault.clone(), transport);
    let sessions = Arc::new(RequestSessionRegistry::new());
    let events = Arc::new(Mutex::new(Vec::<ProviderRuntimeChatEvent>::new()));
    let sink = events.clone();
    let result = run_provider_runtime_chat(
      &router,
      &sessions,
      ProviderRuntimeChatCommandInput {
        request_id: "smoke-chat-stream-req".into(),
        provider_model_id: model_id,
        config: b"{}".to_vec(),
        request: stream_request(),
      },
      Box::new(move |event| {
        sink.lock().expect("events poisoned").push(event);
        Ok(())
      }),
    )
    .await
    .expect("streaming chat completes");
    assert_eq!(result, None, "streaming chat returns no complete message");
    let expected: Vec<ProviderRuntimeChatEvent> = vec![
      ProviderRuntimeChatEvent::Text { text: "wo".into() },
      ProviderRuntimeChatEvent::Text { text: "rld".into() },
      ProviderRuntimeChatEvent::Complete { status: "stop".into() },
    ];
    assert_eq!(
      events.lock().expect("events poisoned").clone(),
      expected,
      "split streaming text deltas with one terminal complete"
    );
    assert_eq!(requests.lock().expect("requests poisoned").len(), 1);
    println!("SMOKE ok: streaming Chat orders typed deltas and terminates exactly once");
  }

  // [6] Cancellation through the public runtime cancellation contract (item 3 proxy).
  {
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = Arc::new(ParkingTransport {
      requests: requests.clone(),
    });
    let router = make_router(&db, packages.clone(), wasm.clone(), vault.clone(), transport);
    let sessions = Arc::new(RequestSessionRegistry::new());
    let request_id = "smoke-chat-stream-block";
    let sessions_for_task = sessions.clone();
    let handle = tokio::spawn(async move {
      run_provider_runtime_chat(
        &router,
        &sessions_for_task,
        ProviderRuntimeChatCommandInput {
          request_id: request_id.to_string(),
          provider_model_id: model_id,
          config: b"{}".to_vec(),
          request: stream_request(),
        },
        Box::new(|_event| Ok(())),
      )
      .await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
      if !requests.lock().expect("requests poisoned").is_empty() {
        break;
      }
      assert!(
        tokio::time::Instant::now() < deadline,
        "guest never reached the parked broker call"
      );
      tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
      requests.lock().expect("requests poisoned").len(),
      1,
      "one provider request in flight"
    );
    assert!(
      cancel_runtime_request(&sessions, request_id),
      "the public cancellation command contract cancels the session"
    );
    let outcome = tokio::time::timeout(Duration::from_secs(30), handle)
      .await
      .expect("chat stream task finishes")
      .expect("chat stream task joins");
    assert!(
      matches!(
        &outcome,
        Err(CapabilityError {
          code: CapabilityErrorCode::Cancelled,
          ..
        })
      ),
      "cancelled outcome: {outcome:?}"
    );
    assert_eq!(
      requests.lock().expect("requests poisoned").len(),
      1,
      "no second provider request after cancellation"
    );
    println!("SMOKE ok: cancellation stops guest/broker work with no second request");
  }

  // [7] Manual item 5: rollback restores the exact legacy binding; provider/model IDs unchanged.
  // A default-bound Provider has no explicit lifecycle snapshot (the reviewed default is not a
  // user action), so rollback is not offered there; the explicitly migrated Provider rolls back
  // atomically to legacy.
  assert!(
    runtime.preview_rollback(matching.id).is_err(),
    "default-bound provider has no rollback snapshot"
  );
  let rollback_preview = runtime.preview_rollback(preexisting.id).expect("rollback preview");
  let rolled_back = runtime
    .apply_rollback(ApplyProviderRuntimeRollbackInput {
      preview_id: rollback_preview.preview_id,
    })
    .expect("rollback applies");
  assert_eq!(
    rolled_back.runtime.runtime_kind,
    ProviderRuntimeKind::LegacyFrontendProvider
  );
  assert!(rolled_back.runtime.package_digest.is_none());
  let binding = db
    .read(|conn| provider_runtime_bindings::get(conn, preexisting.id, "openai-compatible"))
    .unwrap();
  assert_eq!(binding.runtime_kind, ProviderRuntimeKind::LegacyFrontendProvider);
  assert_eq!(binding.state, ProviderRuntimeState::Active);
  let provider_after = providers.get(preexisting.id).expect("provider survives rollback");
  assert_eq!(provider_after.id, preexisting.id, "provider UUID unchanged");
  let model_after = db
    .read(|conn| crate::repositories::provider_models::get(conn, fixed_model_id))
    .unwrap();
  assert_eq!(model_after.id, fixed_model_id, "model UUID unchanged");
  assert_eq!(model_after.provider_instance_id, preexisting.id);
  println!("SMOKE ok: rollback restores legacy identity without changing provider/model UUIDs");

  // [8] Manual item 6: privacy scan across export, DTO, and error surfaces.
  {
    let export = crate::services::ImportExportService::new(db.clone(), vault.clone())
      .export()
      .expect("configuration export");
    let json = serde_json::to_string(&export).unwrap();
    for forbidden in [
      "credentialRef",
      "grantSetRevision",
      "executionGrant",
      "provider/",
      SMOKE_SECRET,
      SMOKE_PROMPT,
    ] {
      assert!(!json.contains(forbidden), "export leaks {forbidden:?}");
    }
    let provider_json = serde_json::to_string(&provider_after).unwrap();
    for forbidden in ["credentialRef", "provider/", SMOKE_SECRET, SMOKE_PROMPT] {
      assert!(!provider_json.contains(forbidden), "provider DTO leaks {forbidden:?}");
    }
    // A malformed provider body must fail closed with a sanitized error surface.
    let requests = Arc::new(Mutex::new(Vec::<PreparedHttpRequest>::new()));
    let transport = recording_transport(
      requests.clone(),
      200,
      "application/json",
      OPENAI_COMPATIBLE_MALFORMED_BODY,
    );
    let router = make_router(&db, packages.clone(), wasm.clone(), vault.clone(), transport);
    let mut request = stream_request();
    request.messages[1].content = SMOKE_PROMPT.into();
    let outcome = router
      .chat(
        model_id,
        b"{}".to_vec(),
        request,
        "smoke-malformed-req",
        CancelToken::new(),
        None,
      )
      .await;
    assert!(outcome.is_err(), "malformed provider body must fail closed");
    if let Err(CapabilityError { message, .. }) = &outcome {
      assert!(
        !message.contains(SMOKE_SECRET) && !message.contains(SMOKE_PROMPT),
        "error surface leaks secret or prompt: {message}"
      );
      assert!(
        !message
          .as_bytes()
          .windows(FIXED_PNG.len())
          .any(|window| window == FIXED_PNG),
        "error surface leaks image content"
      );
    }
    println!("SMOKE ok: export, DTO, and error surfaces expose no credential, reference, prompt, or image");
  }

  println!(
    "SMOKE PASS: runtime-provider headless walkthrough completed (default/lifecycle/models/chat/stream/cancel/rollback/privacy)"
  );
}

/// Phase 8 multi-interface: one Provider approves TWO distinct API types from TWO signed
/// packages, plus a second declared alias of the first package. Each binding is an
/// independent adapter-keyed row; aliases of the same Provider/package share the exact grant
/// revision while different packages hold separate grants. Rejection cases (undeclared
/// adapter, already-attached API type, missing acknowledgement, stale preview CAS) are
/// atomic. Detach keeps a shared grant while another alias is active and releases it only
/// after the final reference (active row or undiscarded snapshot) disappears; package
/// uninstall stays denied while any active binding or undiscarded snapshot references it.
#[test]
fn runtime_provider_can_attach_two_interface_packages() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeInterfaceAttachInput, ApplyProviderRuntimeInterfaceRollbackInput,
    PreviewProviderRuntimeInterfaceAttachInput, PreviewProviderRuntimeInterfaceRollbackInput,
    ProviderRuntimeInterfaceDetachInput, ProviderRuntimeInterfaceDiscardSnapshotInput, ProviderRuntimeKind,
    ProviderRuntimeState,
  };

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());

  // Package P1 declares two aliases (openai-compatible + openai-responses); package P2 is
  // the gemini vendor package. Both are installed through the real verifier.
  let mut p1_manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    &[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ],
  );
  p1_manifest.id = "com.langnext.provider.openai-compatible".into();
  p1_manifest.version = "1.0.0".into();
  if let Some(declaration) = p1_manifest.provider_runtime.as_mut() {
    declaration.legacy_aliases = vec!["openai-compatible".into(), "openai-responses".into()];
  }
  let p1_digest = install(
    &packages,
    &vendor_signed_package(
      &p1_manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );

  let gemini = gemini_manifest(&[
    (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
    (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
  ]);
  let p2_digest = install(
    &packages,
    &vendor_signed_package(
      &gemini,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );
  assert_ne!(p1_digest, p2_digest);

  let provider_a = crate::domain::time::new_id();
  let provider_b = crate::domain::time::new_id();
  for (id, name) in [(provider_a, "Provider A"), (provider_b, "Provider B")] {
    insert_provider_row(&db, id, name, None, vault.as_ref(), None);
  }
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm);

  // --- Attach both interfaces to provider A. ---
  let attach = |provider_id: Uuid, adapter_id: &str, digest: &str| {
    let preview = lifecycle
      .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
        provider_id,
        adapter_id: adapter_id.into(),
        package_digest: digest.to_string(),
      })
      .unwrap_or_else(|e| panic!("preview {adapter_id}: {e}"));
    lifecycle
      .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
        preview_id: preview.preview_id,
        acknowledge_permissions: true,
      })
      .unwrap_or_else(|e| panic!("apply {adapter_id}: {e}"))
  };

  let attached_a = attach(provider_a, "openai-compatible", &p1_digest);
  assert_eq!(attached_a.adapter_id, "openai-compatible");
  assert_eq!(attached_a.binding.grant_set_revision, Some(1));

  // Second declared alias of the SAME package reuses the exact Provider/package grant.
  let attached_responses = attach(provider_a, "openai-responses", &p1_digest);
  assert_eq!(attached_responses.adapter_id, "openai-responses");
  assert_eq!(
    attached_responses.binding.grant_set_revision,
    Some(1),
    "aliases of one Provider/package share the exact grant revision"
  );

  // Distinct package (gemini) on the same Provider holds its own grant.
  let attached_gemini = attach(provider_a, "gemini", &p2_digest);
  assert_eq!(
    attached_gemini.binding.package_digest.as_deref(),
    Some(p2_digest.as_str())
  );
  assert_eq!(attached_gemini.binding.grant_set_revision, Some(1));

  let bindings = db
    .read(|conn| provider_runtime_bindings::list_by_provider(conn, provider_a))
    .unwrap();
  assert_eq!(bindings.len(), 3);
  assert!(bindings.iter().all(|b| b.state == ProviderRuntimeState::Active));

  // Exactly one grant per (provider, package): two for provider A.
  let grant_count: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row(
            "SELECT COUNT(*) FROM execution_grant_sets
              WHERE subject_kind = 'provider_instance' AND subject_id = ?1",
            rusqlite::params![provider_a.to_string()],
            |row| row.get(0),
          )
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(grant_count, 2, "one exact grant per active Provider/package");

  // --- The same two packages attach to a second Provider with separate grants. ---
  let attached_b = attach(provider_b, "gemini", &p2_digest);
  assert_eq!(attached_b.binding.grant_set_revision, Some(1));
  let b_grant_subjects: Vec<String> = db
    .read(|conn| {
      let mut stmt = conn
        .prepare(
          "SELECT subject_id FROM execution_grant_sets
            WHERE subject_kind = 'provider_instance' AND package_digest = ?1",
        )
        .unwrap();
      let rows = stmt
        .query_map(rusqlite::params![p2_digest], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
      Ok(rows)
    })
    .unwrap();
  assert_eq!(
    b_grant_subjects.len(),
    2,
    "each provider owns an independent grant for P2"
  );
  assert!(
    b_grant_subjects
      .iter()
      .all(|s| s == &provider_a.to_string() || s == &provider_b.to_string())
  );

  // --- Rejection cases are atomic: no grant/binding/snapshot changes. ---
  let before_count: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row("SELECT COUNT(*) FROM provider_runtime_snapshot_sets", [], |row| {
            row.get(0)
          })
          .unwrap(),
      )
    })
    .unwrap();

  // Undeclared adapter.
  let err = lifecycle
    .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
      provider_id: provider_a,
      adapter_id: "anthropic".into(),
      package_digest: p1_digest.clone(),
    })
    .unwrap_err();
  assert!(
    matches!(err, crate::error::StorageError::Validation(_)),
    "undeclared adapter: {err:?}"
  );

  // Already-attached API type (same package).
  let err = lifecycle
    .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
      provider_id: provider_a,
      adapter_id: "openai-compatible".into(),
      package_digest: p1_digest.clone(),
    })
    .unwrap_err();
  assert!(
    matches!(err, crate::error::StorageError::Conflict(_)),
    "already attached: {err:?}"
  );

  // Missing acknowledgement.
  let preview_no_ack = lifecycle
    .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
      provider_id: provider_b,
      adapter_id: "openai-compatible".into(),
      package_digest: p1_digest.clone(),
    })
    .unwrap();
  let stale_preview_id = preview_no_ack.preview_id.clone();
  let err = lifecycle
    .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
      preview_id: preview_no_ack.preview_id,
      acknowledge_permissions: false,
    })
    .unwrap_err();
  assert!(
    matches!(err, crate::error::StorageError::Validation(_)),
    "no ack: {err:?}"
  );

  // Stale preview CAS: applying the same preview twice fails; the first apply consumed it.
  let err = lifecycle
    .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
      preview_id: stale_preview_id,
      acknowledge_permissions: true,
    })
    .unwrap_err();
  assert!(
    matches!(err, crate::error::StorageError::Conflict(_)),
    "stale apply: {err:?}"
  );

  let after_count: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row("SELECT COUNT(*) FROM provider_runtime_snapshot_sets", [], |row| {
            row.get(0)
          })
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(after_count, before_count, "rejected previews never write snapshots");

  // --- Detach keeps a shared grant while another alias is active. ---
  let provider_a_row = db.read(|conn| provider_instances::get(conn, provider_a)).unwrap();
  let responses_binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_a, "openai-responses"))
    .unwrap();
  lifecycle
    .detach_interface(&ProviderRuntimeInterfaceDetachInput {
      provider_id: provider_a,
      adapter_id: "openai-responses".into(),
      expected_updated_at: provider_a_row.updated_at.clone(),
      expected_binding_updated_at: responses_binding.updated_at.clone(),
    })
    .unwrap();
  assert!(
    db.read(|conn| provider_runtime_bindings::get_optional(conn, provider_a, "openai-responses"))
      .unwrap()
      .is_none(),
    "detached alias route is removed"
  );
  let p1_grant_count: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row(
            "SELECT COUNT(*) FROM execution_grant_sets
              WHERE subject_id = ?1 AND package_digest = ?2",
            rusqlite::params![provider_a.to_string(), p1_digest],
            |row| row.get(0),
          )
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(
    p1_grant_count, 1,
    "shared P1 grant survives while the openai-compatible alias stays active"
  );

  // Package uninstall is denied while any active binding or undiscarded snapshot references it.
  let err = packages.uninstall_version(&p1_digest).unwrap_err();
  assert!(
    matches!(err, crate::error::StorageError::InUse(_)),
    "uninstall while bound: {err:?}"
  );

  // --- Detach the final alias: the grant is retained by the undiscarded snapshot. ---
  let provider_a_row = db.read(|conn| provider_instances::get(conn, provider_a)).unwrap();
  let compatible_binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_a, "openai-compatible"))
    .unwrap();
  lifecycle
    .detach_interface(&ProviderRuntimeInterfaceDetachInput {
      provider_id: provider_a,
      adapter_id: "openai-compatible".into(),
      expected_updated_at: provider_a_row.updated_at.clone(),
      expected_binding_updated_at: compatible_binding.updated_at.clone(),
    })
    .unwrap();
  let p1_grant_count: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row(
            "SELECT COUNT(*) FROM execution_grant_sets
              WHERE subject_id = ?1 AND package_digest = ?2",
            rusqlite::params![provider_a.to_string(), p1_digest],
            |row| row.get(0),
          )
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(p1_grant_count, 1, "undiscarded detach snapshot retains the grant");

  // Discarding the final snapshot releases the retained grant. Both detach snapshots must
  // be discarded because each one references the shared P1 grant.
  let sets = db
    .read(|conn| provider_runtime_bindings::list_snapshot_sets(conn, provider_a))
    .unwrap();
  let p1_sets: Vec<_> = sets
    .iter()
    .filter(|set| set.package_digest.as_deref() == Some(p1_digest.as_str()))
    .collect();
  assert_eq!(p1_sets.len(), 2, "one detach snapshot per detached alias");
  for set in p1_sets {
    let provider_a_row = db.read(|conn| provider_instances::get(conn, provider_a)).unwrap();
    lifecycle
      .discard_interface_snapshot(&ProviderRuntimeInterfaceDiscardSnapshotInput {
        provider_id: provider_a,
        snapshot_id: set.id,
        expected_updated_at: provider_a_row.updated_at.clone(),
      })
      .unwrap();
  }
  let p1_grant_count: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row(
            "SELECT COUNT(*) FROM execution_grant_sets
              WHERE subject_id = ?1 AND package_digest = ?2",
            rusqlite::params![provider_a.to_string(), p1_digest],
            |row| row.get(0),
          )
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(p1_grant_count, 0, "final discarded reference releases the grant");

  // --- Adapter-scoped rollback restores the pre-attach identity and releases grants. ---
  let preview = lifecycle
    .preview_interface_rollback(&PreviewProviderRuntimeInterfaceRollbackInput {
      provider_id: provider_b,
      adapter_id: "gemini".into(),
    })
    .unwrap();
  assert_eq!(preview.snapshot_scope, "adapter");
  assert_eq!(preview.target.runtime_kind, ProviderRuntimeKind::LegacyFrontendProvider);
  let rolled = lifecycle
    .apply_interface_rollback(ApplyProviderRuntimeInterfaceRollbackInput {
      preview_id: preview.preview_id,
    })
    .unwrap();
  assert_eq!(rolled.binding.runtime_kind, ProviderRuntimeKind::LegacyFrontendProvider);
  let p2_grant_count: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row(
            "SELECT COUNT(*) FROM execution_grant_sets
              WHERE subject_id = ?1 AND package_digest = ?2",
            rusqlite::params![provider_b.to_string(), p2_digest],
            |row| row.get(0),
          )
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(p2_grant_count, 0, "rollback releases the consumed grant");
  // Provider A's gemini binding is untouched.
  let gemini_a = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_a, "gemini"))
    .unwrap();
  assert_eq!(gemini_a.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(gemini_a.state, ProviderRuntimeState::Active);
}

/// Phase 8 routing: the backend derives the target interface binding from persisted data.
/// `provider_runtime_models_list` resolves exactly one active binding per selected API type;
/// `provider_runtime_chat` resolves the effective API type from the persisted model row
/// (override → source type → Provider default) and never accepts a caller-selected package.
/// A model from another Provider or an unbound adapter is rejected before vault/transport.
#[tokio::test]
async fn runtime_provider_routes_by_persisted_model_interface() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::provider_http::ProviderHttpMethod;
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeInterfaceAttachInput, LlmChatCompleteResult, LlmChatMessage, LlmChatPreferencesV1,
    LlmChatRequest, PreviewProviderRuntimeInterfaceAttachInput,
  };
  use crate::services::bounded_http::RawHttpTransport;
  use crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle;
  use crate::services::provider_runtime_router::{ProviderRuntimeBrokerContext, ProviderRuntimeRouter};
  use crate::services::wasm_runtime::host::BrokerHandle;
  use std::collections::HashMap;
  use std::pin::Pin;

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());

  let mut p1_manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    &[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ],
  );
  p1_manifest.id = "com.langnext.provider.openai-compatible".into();
  let p1_digest = install(
    &packages,
    &vendor_signed_package(
      &p1_manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );
  let gemini = gemini_manifest(&[
    (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
    (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
  ]);
  let p2_digest = install(
    &packages,
    &vendor_signed_package(
      &gemini,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );

  let provider_a = crate::domain::time::new_id();
  let provider_b = crate::domain::time::new_id();
  insert_provider_row(
    &db,
    provider_a,
    "Provider A",
    Some(format!("provider/{provider_a}/key")),
    vault.as_ref(),
    Some("sk-test-provider-secret"),
  );
  insert_provider_row(&db, provider_b, "Provider B", None, vault.as_ref(), None);
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm.clone());
  for (provider_id, adapter_id, digest) in [
    (provider_a, "openai-compatible", p1_digest.clone()),
    (provider_a, "gemini", p2_digest.clone()),
  ] {
    let preview = lifecycle
      .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
        provider_id,
        adapter_id: adapter_id.into(),
        package_digest: digest,
      })
      .unwrap();
    lifecycle
      .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
        preview_id: preview.preview_id,
        acknowledge_permissions: true,
      })
      .unwrap();
  }

  // Models: one manual (effective = Provider default openai-compatible) and one remote
  // discovered under gemini (source type gemini).
  let model_default = insert_fixture_model(&db, provider_a, "gpt-4o");
  let model_gemini = {
    let model_id = crate::domain::time::new_id();
    let now = crate::domain::time::now_rfc3339();
    db.transaction(|uow| {
      crate::repositories::provider_models::insert(
        uow.conn(),
        &crate::domain::model::ProviderModel {
          id: model_id,
          provider_instance_id: provider_a,
          model_key: "gemini-2.0-flash".into(),
          source: crate::domain::model::ModelSource::Remote,
          remote_display_name: None,
          display_name_override: None,
          enabled: true,
          availability: crate::domain::model::Availability::Available,
          remote_metadata_json: None,
          capability_overrides_json: None,
          adapter_id: None,
          source_adapter_id: "gemini".into(),
          last_seen_at: None,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();
    model_id
  };

  // Method-aware capture transport: models list (GET) returns the models fixture; chat
  // (POST) returns the chat-complete fixture, like the production guest expectations.
  struct MethodRoutingTransport {
    requests: Arc<Mutex<Vec<PreparedHttpRequest>>>,
  }
  impl RawHttpTransport for MethodRoutingTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundedHttpResponse, crate::error::StorageError>> + Send + '_>>
    {
      let method = prepared.method;
      self.requests.lock().expect("requests").push(prepared);
      let body = if method == ProviderHttpMethod::Get {
        OPENAI_COMPATIBLE_MODELS_FIXTURE.as_bytes().to_vec()
      } else {
        // Conformance chat guest shape: `{"message":{"role":...,"content":...}}`.
        br#"{"message":{"role":"assistant","content":"hello from interface chat"}}"#.to_vec()
      };
      Box::pin(async move {
        Ok(BoundedHttpResponse {
          status: 200,
          headers: HashMap::from([("content-type".into(), "application/json".into())]),
          body,
        })
      })
    }
    fn stream(
      &self,
      prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<
        dyn Fn(crate::domain::provider_http::ProviderHttpStreamEvent) -> Result<(), crate::error::StorageError> + Send,
      >,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), crate::error::StorageError>> + Send + '_>> {
      self.requests.lock().expect("requests").push(prepared);
      Box::pin(async { Ok(()) })
    }
  }

  // Context-recording broker: each execution must receive the exact host-only context.
  let contexts = Arc::new(Mutex::new(Vec::<ProviderRuntimeBrokerContext>::new()));
  let transport = Arc::new(MethodRoutingTransport {
    requests: Arc::new(Mutex::new(Vec::new())),
  });
  let broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync> = Arc::new({
    let db = db.clone();
    let vault = vault.clone();
    let transport = transport.clone();
    let contexts = contexts.clone();
    move |context| {
      contexts.lock().expect("contexts").push(context.clone());
      Box::new(ProviderRuntimeBrokerHandle::new(
        db.clone(),
        vault.clone(),
        transport.clone(),
        context,
      ))
    }
  });
  let router = ProviderRuntimeRouter::new(db.clone(), packages.clone(), wasm.clone(), broker_factory);

  // Models List per API type resolves the matching binding.
  router
    .list_models(
      provider_a,
      "openai-compatible",
      "req-models-a",
      b"{}".to_vec(),
      CancelToken::new(),
      None,
    )
    .await
    .unwrap();
  router
    .list_models(
      provider_a,
      "gemini",
      "req-models-b",
      b"{}".to_vec(),
      CancelToken::new(),
      None,
    )
    .await
    .unwrap_or_else(|e| panic!("gemini models list: {e:?}"));
  let recorded = contexts.lock().expect("contexts");
  assert_eq!(recorded.len(), 2);
  assert_eq!(recorded[0].provider_id, provider_a);
  assert_eq!(recorded[0].adapter_id, "openai-compatible");
  assert_eq!(recorded[0].package_digest, p1_digest);
  assert_eq!(recorded[0].grant_revision, 1);
  assert_eq!(recorded[1].adapter_id, "gemini");
  assert_eq!(recorded[1].package_digest, p2_digest);
  drop(recorded);

  // Chat by persisted model id: the host derives the interface from the model row.
  let unary_request = |model_key: &str| LlmChatRequest {
    model: model_key.into(),
    messages: vec![LlmChatMessage {
      role: "user".into(),
      content: "Hi".into(),
    }],
    images: vec![],
    preferences: LlmChatPreferencesV1 {
      stream: false,
      temperature: None,
      max_tokens: None,
      thinking: false,
    },
  };
  let complete: LlmChatCompleteResult = router
    .chat(
      model_default,
      b"{}".to_vec(),
      unary_request("gpt-4o"),
      "req-chat-default",
      CancelToken::new(),
      None,
    )
    .await
    .expect("default-interface chat resolves");
  assert!(!complete.content.is_empty());
  router
    .chat(
      model_gemini,
      b"{}".to_vec(),
      unary_request("gemini-2.0-flash"),
      "req-chat-gemini",
      CancelToken::new(),
      None,
    )
    .await
    .expect("gemini-interface chat resolves");
  let recorded = contexts.lock().expect("contexts");
  assert_eq!(recorded.len(), 4);
  assert_eq!(recorded[2].adapter_id, "openai-compatible");
  assert_eq!(recorded[2].package_digest, p1_digest);
  assert_eq!(recorded[3].adapter_id, "gemini");
  assert_eq!(recorded[3].package_digest, p2_digest);
  drop(recorded);

  // Unbound adapter: rejected before any transport request.
  let requests_before = transport.requests.lock().expect("requests").len();
  let err = router
    .list_models(
      provider_a,
      "anthropic",
      "req-bad",
      b"{}".to_vec(),
      CancelToken::new(),
      None,
    )
    .await
    .unwrap_err();
  assert!(
    matches!(
      &err,
      crate::domain::service_capability::CapabilityError { code, .. }
        if *code == crate::domain::service_capability::CapabilityErrorCode::PluginUnavailable
    ),
    "unbound adapter: {err:?}"
  );
  assert_eq!(
    transport.requests.lock().expect("requests").len(),
    requests_before,
    "no transport request for an unbound adapter"
  );

  // A model from another Provider (provider B has no binding) fails before transport.
  let model_foreign = insert_fixture_model(&db, provider_b, "foreign-model");
  let err = router
    .chat(
      model_foreign,
      b"{}".to_vec(),
      unary_request("foreign-model"),
      "req-foreign",
      CancelToken::new(),
      None,
    )
    .await
    .unwrap_err();
  assert!(
    matches!(
      &err,
      crate::domain::service_capability::CapabilityError { code, .. }
        if *code == crate::domain::service_capability::CapabilityErrorCode::PluginUnavailable
    ),
    "foreign model: {err:?}"
  );
  assert_eq!(
    transport.requests.lock().expect("requests").len(),
    requests_before,
    "no transport request for a foreign model"
  );
}

/// Phase 8 per-interface sync: interfaces A and B each return an identically named model and
/// a distinct model. Each sync persists independent source records and never marks the other
/// interface's remote models missing; the missing transition is limited to the completed
/// sync type. A non-attached API type fails closed before any model row changes.
#[test]
fn runtime_provider_multi_interface_model_sync() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::model::{ModelSource, RemoteModelSyncItem};
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeInterfaceAttachInput, PreviewProviderRuntimeInterfaceAttachInput,
  };
  use crate::services::ModelService;

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let (provider_id, _) =
    activate_fixture_provider(&db, packages.clone(), wasm.clone(), "Sync Provider", vault.as_ref());
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm.clone());

  // Attach a second interface (gemini) so the Provider owns two active API types.
  let gemini = gemini_manifest(&[
    (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
    (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
  ]);
  let p2_digest = install(
    &packages,
    &vendor_signed_package(
      &gemini,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );
  let preview = lifecycle
    .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
      provider_id,
      adapter_id: "gemini".into(),
      package_digest: p2_digest,
    })
    .unwrap();
  lifecycle
    .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();

  let models = ModelService::new(db.clone(), vault.clone(), std::env::temp_dir());
  let provider = db.read(|conn| provider_instances::get(conn, provider_id)).unwrap();
  let mut expected_updated_at = provider.updated_at.clone();

  // Sync interface A (openai-compatible): shared + a-only.
  let result_a = models
    .apply_provider_model_sync(
      provider_id,
      "openai-compatible",
      &expected_updated_at,
      &[
        RemoteModelSyncItem {
          model_key: "shared-model".into(),
          remote_display_name: Some("Shared A".into()),
          remote_metadata_json: None,
          capability_overrides_json: None,
        },
        RemoteModelSyncItem {
          model_key: "a-only".into(),
          remote_display_name: None,
          remote_metadata_json: None,
          capability_overrides_json: None,
        },
      ],
    )
    .unwrap();
  assert!(result_a.ok);

  // Sync interface B (gemini): shared + b-only. Neither sync touches the other's rows.
  // The provider version advances with each sync, so re-read it (mirrors the frontend flow).
  expected_updated_at = db
    .read(|conn| provider_instances::get(conn, provider_id))
    .unwrap()
    .updated_at;
  let result_b = models
    .apply_provider_model_sync(
      provider_id,
      "gemini",
      &expected_updated_at,
      &[
        RemoteModelSyncItem {
          model_key: "shared-model".into(),
          remote_display_name: Some("Shared B".into()),
          remote_metadata_json: None,
          capability_overrides_json: None,
        },
        RemoteModelSyncItem {
          model_key: "b-only".into(),
          remote_display_name: None,
          remote_metadata_json: None,
          capability_overrides_json: None,
        },
      ],
    )
    .unwrap();
  assert!(result_b.ok);

  let rows = models.list_by_provider(provider_id).unwrap();
  let remote: Vec<_> = rows.iter().filter(|m| m.source == ModelSource::Remote).collect();
  assert_eq!(remote.len(), 4, "separate source records per interface");
  let shared_a = remote
    .iter()
    .find(|m| m.model_key == "shared-model" && m.source_adapter_id == "openai-compatible")
    .expect("shared row under interface A");
  let shared_b = remote
    .iter()
    .find(|m| m.model_key == "shared-model" && m.source_adapter_id == "gemini")
    .expect("shared row under interface B");
  assert_eq!(shared_a.remote_display_name.as_deref(), Some("Shared A"));
  assert_eq!(shared_b.remote_display_name.as_deref(), Some("Shared B"));
  assert_eq!(
    shared_a.availability,
    crate::domain::model::Availability::Available,
    "interface B sync never marks interface A models missing"
  );

  // Sync A again without shared-model: only the A-source row goes missing.
  expected_updated_at = db
    .read(|conn| provider_instances::get(conn, provider_id))
    .unwrap()
    .updated_at;
  let result = models
    .apply_provider_model_sync(
      provider_id,
      "openai-compatible",
      &expected_updated_at,
      &[RemoteModelSyncItem {
        model_key: "a-only".into(),
        remote_display_name: None,
        remote_metadata_json: None,
        capability_overrides_json: None,
      }],
    )
    .unwrap();
  assert!(result.ok);
  let rows = models.list_by_provider(provider_id).unwrap();
  let shared_a = rows
    .iter()
    .find(|m| m.model_key == "shared-model" && m.source_adapter_id == "openai-compatible")
    .unwrap();
  let shared_b = rows
    .iter()
    .find(|m| m.model_key == "shared-model" && m.source_adapter_id == "gemini")
    .unwrap();
  let b_only = rows.iter().find(|m| m.model_key == "b-only").unwrap();
  assert_eq!(
    shared_a.availability,
    crate::domain::model::Availability::Missing,
    "missing transition limited to the completed sync type"
  );
  assert_eq!(shared_b.availability, crate::domain::model::Availability::Available);
  assert_eq!(b_only.availability, crate::domain::model::Availability::Available);

  // A non-attached API type fails closed before any model row changes.
  expected_updated_at = db
    .read(|conn| provider_instances::get(conn, provider_id))
    .unwrap()
    .updated_at;
  let before: Vec<_> = models
    .list_by_provider(provider_id)
    .unwrap()
    .into_iter()
    .map(|m| (m.id, m.updated_at))
    .collect();
  let err = models
    .apply_provider_model_sync(
      provider_id,
      "anthropic",
      &expected_updated_at,
      &[RemoteModelSyncItem {
        model_key: "x".into(),
        remote_display_name: None,
        remote_metadata_json: None,
        capability_overrides_json: None,
      }],
    )
    .unwrap_err();
  assert!(
    matches!(err, crate::error::StorageError::Validation(_)),
    "unattached sync: {err:?}"
  );
  let after: Vec<_> = models
    .list_by_provider(provider_id)
    .unwrap()
    .into_iter()
    .map(|m| (m.id, m.updated_at))
    .collect();
  assert_eq!(before, after, "rejected sync changes nothing");
}

/// Phase 8 multi-interface configuration: a v7 singular requirement normalizes to adapter-keyed
/// v8 requirements (Provider default + model overrides) and imports as unavailable identities;
/// v8 documents with two runtime interface requirements preserve both API types; exported
/// documents never carry packages, grants, snapshots, paths, or secrets.
#[test]
fn import_export_runtime_provider_multi_interface() {
  use crate::domain::import_export::{ImportConflictMode, parse_and_normalize_export_document};
  use crate::domain::runtime_provider::ProviderRuntimeRequirementExport;

  // v7 document with one singular wasm requirement, a Provider default type A, and a model
  // override type B.
  let v7 = serde_json::json!({
    "formatVersion": 7,
    "exportedAt": "t",
    "providers": [{
      "id": "00000000-0000-7000-8000-000000000001",
      "adapterId": "openai-compatible",
      "displayName": "P",
      "credentialKind": "api_key",
      "enabled": true,
      "proxyMode": "inherit",
      "insecureHttpConfirmedAt": null,
      "runtime": {
        "runtimeKind": "wasm-component",
        "packageDigest": "ab".repeat(32),
        "pluginId": "com.langnext.provider.openai-compatible",
        "pluginVersion": "1.0.0",
        "publisherKeyId": "com.langnext.vendor.keys.1",
        "publisherKeyFingerprint": "f".repeat(64),
        "pluginApiVersion": "1.0",
        "legacyAliases": ["openai-compatible"],
        "capabilities": ["llm.chat@1", "llm.models.list@1"]
      },
      "createdAt": "t",
      "updatedAt": "t"
    }],
    "models": [{
      "id": "00000000-0000-7000-8000-000000000002",
      "providerInstanceId": "00000000-0000-7000-8000-000000000001",
      "modelKey": "gpt-4o",
      "source": "manual",
      "remoteDisplayName": null,
      "displayNameOverride": null,
      "enabled": true,
      "availability": "available",
      "remoteMetadataJson": null,
      "capabilityOverridesJson": null,
      "adapterId": "openai-responses",
      "lastSeenAt": null,
      "createdAt": "t",
      "updatedAt": "t"
    }],
    "translationProfiles": [],
    "profileModels": [],
    "profilePromptTemplates": [],
    "integrationInstances": [],
    "ocrServices": [],
    "ocrPromptTemplates": [],
    "speechServices": [],
    "appSettings": {
      "schemaVersion": 1,
      "uiLanguage": "en",
      "theme": "dark",
      "defaultProfileId": null,
      "defaultOcrServiceId": null,
      "defaultSpeechServiceId": null,
      "translation": { "autoDetectSource": true, "preserveFormatting": true },
      "shortcuts": [],
      "network": { "proxyMode": "system", "proxyUrl": null }
    }
  });

  let normalized = parse_and_normalize_export_document(v7.clone()).unwrap();
  assert_eq!(
    normalized.format_version,
    crate::domain::import_export::EXPORT_FORMAT_VERSION
  );
  let provider = &normalized.providers[0];
  assert!(provider.runtime.is_none(), "v8 never keeps the singular runtime field");
  let requirements: Vec<&ProviderRuntimeRequirementExport> = provider.runtime_bindings.iter().collect();
  let adapters: Vec<Option<&String>> = requirements.iter().map(|r| r.adapter_id.as_ref()).collect();
  assert_eq!(
    adapters,
    vec![
      Some(&"openai-compatible".to_string()),
      Some(&"openai-responses".to_string())
    ],
    "v7 normalization enumerates the default plus model override types"
  );
  assert!(requirements.iter().all(|r| r.runtime_kind == "wasm-component"));

  // v8 document with TWO runtime interface requirements round-trips both identities.
  let mut v8 = normalized.clone();
  v8.format_version = crate::domain::import_export::EXPORT_FORMAT_VERSION;
  let reparsed = parse_and_normalize_export_document(serde_json::to_value(&v8).unwrap()).unwrap();
  assert_eq!(reparsed.providers[0].runtime_bindings.len(), 2);
  assert_eq!(
    reparsed.providers[0].runtime_bindings[1].adapter_id.as_deref(),
    Some("openai-responses")
  );

  // Import into a clean database: every runtime interface restores as unavailable identity.
  let dir = tempfile::tempdir().unwrap();
  let state = crate::state::AppState::initialize_for_tests(dir.path().to_path_buf()).unwrap();
  let value = serde_json::to_value(&normalized).unwrap();
  let preview = state
    .import_export
    .preview_raw(value.clone(), ImportConflictMode::Merge)
    .unwrap();
  assert!(preview.valid, "preview: {:?}", preview.validation_errors);
  state
    .import_export
    .import_raw(value, ImportConflictMode::Merge)
    .unwrap();
  let provider_id = normalized.providers[0].id;
  let binding_a = state
    .db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  assert_eq!(binding_a.state, ProviderRuntimeState::Unavailable);
  assert_eq!(binding_a.error_code.as_deref(), Some("plugin_unavailable"));
  let binding_b = state
    .db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-responses"))
    .unwrap();
  assert_eq!(binding_b.state, ProviderRuntimeState::Unavailable);
  assert!(binding_b.grant_set_revision.is_none());

  // Re-export preserves both adapter-keyed identities.
  let round_trip = state.import_export.export().unwrap();
  let exported = round_trip.providers.iter().find(|p| p.id == provider_id).unwrap();
  assert_eq!(exported.runtime_bindings.len(), 2);
  assert_eq!(
    exported.runtime_bindings[0].adapter_id.as_deref(),
    Some("openai-compatible")
  );
  assert_eq!(
    exported.runtime_bindings[1].adapter_id.as_deref(),
    Some("openai-responses")
  );
}

/// Detach CAS must pin the target binding identity, not only the provider version:
/// attach/replace/rollback bump the binding `updated_at` and never touch the provider row,
/// so a stale page that loaded the old binding must be rejected before it detaches the
/// replacement package.
#[test]
fn detach_rejects_stale_binding_after_replace() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeInterfaceAttachInput, PreviewProviderRuntimeInterfaceAttachInput,
    ProviderRuntimeInterfaceDetachInput,
  };

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let provider_id = crate::domain::time::new_id();
  insert_provider_row(&db, provider_id, "P", None, vault.as_ref(), None);
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm);

  // Two distinct signed packages that BOTH declare the openai-compatible alias.
  let mut p1_manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    &[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ],
  );
  p1_manifest.id = "com.langnext.provider.openai-compatible".into();
  p1_manifest.version = "1.0.0".into();
  let p1_digest = install(
    &packages,
    &vendor_signed_package(
      &p1_manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );
  let mut p2_manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    &[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ],
  );
  p2_manifest.id = "com.langnext.provider.openai-v2".into();
  p2_manifest.version = "1.0.0".into();
  let p2_digest = install(
    &packages,
    &vendor_signed_package(
      &p2_manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );
  assert_ne!(p1_digest, p2_digest);

  let attach = |digest: &str| {
    let preview = lifecycle
      .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
        provider_id,
        adapter_id: "openai-compatible".into(),
        package_digest: digest.to_string(),
      })
      .unwrap();
    lifecycle
      .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
        preview_id: preview.preview_id,
        acknowledge_permissions: true,
      })
      .unwrap()
  };

  attach(&p1_digest);
  let before = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  attach(&p2_digest);
  let after = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  assert_ne!(before.updated_at, after.updated_at);

  // The replace never bumped the provider row: the provider CAS alone cannot detect a stale
  // page; only the binding identity can.
  let provider_row = db.read(|conn| provider_instances::get(conn, provider_id)).unwrap();
  let err = lifecycle
    .detach_interface(&ProviderRuntimeInterfaceDetachInput {
      provider_id,
      adapter_id: "openai-compatible".into(),
      expected_updated_at: provider_row.updated_at.clone(),
      expected_binding_updated_at: before.updated_at.clone(),
    })
    .unwrap_err();
  assert!(
    matches!(err, crate::error::StorageError::Conflict(_)),
    "stale binding detach must conflict, got {err:?}"
  );

  // The replacement package is still attached after the rejected detach.
  let current = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  assert_eq!(current.package_digest.as_deref(), Some(p2_digest.as_str()));

  // A page that loaded the fresh binding detaches normally.
  lifecycle
    .detach_interface(&ProviderRuntimeInterfaceDetachInput {
      provider_id,
      adapter_id: "openai-compatible".into(),
      expected_updated_at: provider_row.updated_at.clone(),
      expected_binding_updated_at: after.updated_at.clone(),
    })
    .unwrap();
}

/// Provider-scoped rollback (migrated v24 snapshot set) atomically replaces EVERY binding of
/// the Provider. Every replaced binding's package/revision grant must be released when no
/// restored binding or undiscarded snapshot still references it — an orphan grant would block
/// package uninstall forever.
#[test]
fn provider_scoped_rollback_releases_grants_of_all_replaced_bindings() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeInterfaceAttachInput, ApplyProviderRuntimeInterfaceRollbackInput,
    PreviewProviderRuntimeInterfaceAttachInput, PreviewProviderRuntimeInterfaceRollbackInput,
    ProviderRuntimeInterfaceDiscardSnapshotInput, ProviderRuntimeKind, ProviderRuntimeState,
  };
  use crate::repositories::provider_runtime_bindings::{
    ProviderRuntimeSnapshotBinding, ProviderRuntimeSnapshotScope, ProviderRuntimeSnapshotSet,
  };

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let provider_id = crate::domain::time::new_id();
  insert_provider_row(&db, provider_id, "P", None, vault.as_ref(), None);
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm);

  let mut p1_manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    &[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ],
  );
  p1_manifest.id = "com.langnext.provider.openai-compatible".into();
  p1_manifest.version = "1.0.0".into();
  let p1_digest = install(
    &packages,
    &vendor_signed_package(
      &p1_manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );
  let gemini = gemini_manifest(&[
    (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
    (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
  ]);
  let p2_digest = install(
    &packages,
    &vendor_signed_package(
      &gemini,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );

  let attach = |adapter_id: &str, digest: &str| {
    let preview = lifecycle
      .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
        provider_id,
        adapter_id: adapter_id.into(),
        package_digest: digest.to_string(),
      })
      .unwrap();
    lifecycle
      .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
        preview_id: preview.preview_id,
        acknowledge_permissions: true,
      })
      .unwrap()
  };
  attach("openai-compatible", &p1_digest);
  attach("gemini", &p2_digest);

  // Discard the adapter-scoped attach snapshots (the active bindings keep their grants) so
  // the migrated Provider-scoped set below is the only rollback candidate for the default
  // API type — the exact v24 snapshot-set restore path.
  let provider_row = db.read(|conn| provider_instances::get(conn, provider_id)).unwrap();
  for set in db
    .read(|conn| provider_runtime_bindings::list_snapshot_sets(conn, provider_id))
    .unwrap()
  {
    lifecycle
      .discard_interface_snapshot(&ProviderRuntimeInterfaceDiscardSnapshotInput {
        provider_id,
        snapshot_id: set.id,
        expected_updated_at: provider_row.updated_at.clone(),
      })
      .unwrap();
  }

  // Simulate a migrated v24 Provider-scoped snapshot that restores ONLY the default
  // interface to package P1; the gemini route (P2) is not part of the historic snapshot.
  let now = crate::domain::time::now_rfc3339();
  let set_id = crate::domain::time::new_id();
  let default_binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  db.transaction(|uow| {
    let conn = uow.conn();
    provider_runtime_bindings::insert_snapshot_set(
      conn,
      &ProviderRuntimeSnapshotSet {
        id: set_id,
        provider_id,
        scope: ProviderRuntimeSnapshotScope::Provider,
        created_at: now.clone(),
        discarded_at: None,
        runtime_kind: default_binding.runtime_kind,
        package_digest: default_binding.package_digest.clone(),
        grant_set_revision: default_binding.grant_set_revision,
        grant_set_id: None,
        plugin_id: p1_manifest.id.clone(),
        plugin_version: p1_manifest.version.clone(),
        publisher_key_id: Some(crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID.into()),
        publisher_fingerprint: Some(test_vendor_fixture::fixture_vendor_fingerprint()),
        plugin_api_version: Some(p1_manifest.plugin_api_version.clone()),
        capability_ids_json: "[]".into(),
        updated_at: now.clone(),
      },
    )?;
    provider_runtime_bindings::insert_snapshot_binding(
      conn,
      &ProviderRuntimeSnapshotBinding {
        id: crate::domain::time::new_id(),
        snapshot_set_id: set_id,
        provider_id,
        adapter_id: "openai-compatible".into(),
        runtime_kind: default_binding.runtime_kind,
        package_digest: default_binding.package_digest.clone(),
        grant_set_revision: default_binding.grant_set_revision,
        state: default_binding.state,
        error_code: None,
        error_message: None,
        runtime_requirement_json: None,
        created_at: default_binding.created_at.clone(),
        updated_at: now.clone(),
      },
    )?;
    Ok(())
  })
  .unwrap();

  // Provider-scoped rollback of the default interface restores the whole Provider.
  let preview = lifecycle
    .preview_interface_rollback(&PreviewProviderRuntimeInterfaceRollbackInput {
      provider_id,
      adapter_id: "openai-compatible".into(),
    })
    .unwrap();
  assert_eq!(preview.snapshot_scope, "provider");
  lifecycle
    .apply_interface_rollback(ApplyProviderRuntimeInterfaceRollbackInput {
      preview_id: preview.preview_id,
    })
    .unwrap();

  // The gemini binding is gone and its exact grant must be released with it.
  assert!(
    db.read(|conn| provider_runtime_bindings::get_optional(conn, provider_id, "gemini"))
      .unwrap()
      .is_none(),
    "provider-scoped rollback removed the gemini binding"
  );
  let p2_grant_count: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row(
            "SELECT COUNT(*) FROM execution_grant_sets
              WHERE subject_kind = 'provider_instance' AND subject_id = ?1 AND package_digest = ?2",
            rusqlite::params![provider_id.to_string(), p2_digest],
            |row| row.get(0),
          )
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(
    p2_grant_count, 0,
    "replaced gemini binding must not leave an orphan grant behind"
  );

  // No orphan grant means the replaced package can be uninstalled immediately.
  packages
    .uninstall_version(&p2_digest)
    .unwrap_or_else(|e| panic!("uninstall of replaced package must succeed, got {e:?}"));

  // The restored default binding keeps its package and grant.
  let restored = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  assert_eq!(restored.runtime_kind, ProviderRuntimeKind::WasmComponent);
  assert_eq!(restored.state, ProviderRuntimeState::Active);
  assert_eq!(restored.package_digest.as_deref(), Some(p1_digest.as_str()));
}

/// A migrated Provider-scoped snapshot that predates an attached API type cannot roll that
/// adapter back: preview must fail closed with an understandable error and keep the current
/// binding untouched (never delete-then-NotFound on apply).
#[test]
fn provider_scoped_rollback_rejects_adapter_missing_from_snapshot() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeInterfaceAttachInput, PreviewProviderRuntimeInterfaceAttachInput,
    PreviewProviderRuntimeInterfaceRollbackInput, ProviderRuntimeInterfaceDiscardSnapshotInput,
  };
  use crate::repositories::provider_runtime_bindings::{
    ProviderRuntimeSnapshotBinding, ProviderRuntimeSnapshotScope, ProviderRuntimeSnapshotSet,
  };

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let provider_id = crate::domain::time::new_id();
  insert_provider_row(&db, provider_id, "P", None, vault.as_ref(), None);
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm);

  let mut p1_manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    &[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ],
  );
  p1_manifest.id = "com.langnext.provider.openai-compatible".into();
  p1_manifest.version = "1.0.0".into();
  let p1_digest = install(
    &packages,
    &vendor_signed_package(
      &p1_manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );
  let p2_digest = install(
    &packages,
    &vendor_signed_package(
      &gemini_manifest(&[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ]),
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );

  let attach = |adapter_id: &str, digest: &str| {
    let preview = lifecycle
      .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
        provider_id,
        adapter_id: adapter_id.into(),
        package_digest: digest.to_string(),
      })
      .unwrap();
    lifecycle
      .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
        preview_id: preview.preview_id,
        acknowledge_permissions: true,
      })
      .unwrap()
  };
  attach("openai-compatible", &p1_digest);
  attach("gemini", &p2_digest);

  // Keep only the migrated Provider-scoped snapshot (restores ONLY the default interface;
  // the gemini route was attached after that historic snapshot).
  let provider_row = db.read(|conn| provider_instances::get(conn, provider_id)).unwrap();
  for set in db
    .read(|conn| provider_runtime_bindings::list_snapshot_sets(conn, provider_id))
    .unwrap()
  {
    lifecycle
      .discard_interface_snapshot(&ProviderRuntimeInterfaceDiscardSnapshotInput {
        provider_id,
        snapshot_id: set.id,
        expected_updated_at: provider_row.updated_at.clone(),
      })
      .unwrap();
  }
  let now = crate::domain::time::now_rfc3339();
  let set_id = crate::domain::time::new_id();
  let default_binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  db.transaction(|uow| {
    let conn = uow.conn();
    provider_runtime_bindings::insert_snapshot_set(
      conn,
      &ProviderRuntimeSnapshotSet {
        id: set_id,
        provider_id,
        scope: ProviderRuntimeSnapshotScope::Provider,
        created_at: now.clone(),
        discarded_at: None,
        runtime_kind: default_binding.runtime_kind,
        package_digest: default_binding.package_digest.clone(),
        grant_set_revision: default_binding.grant_set_revision,
        grant_set_id: None,
        plugin_id: p1_manifest.id.clone(),
        plugin_version: p1_manifest.version.clone(),
        publisher_key_id: Some(crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID.into()),
        publisher_fingerprint: Some(test_vendor_fixture::fixture_vendor_fingerprint()),
        plugin_api_version: Some(p1_manifest.plugin_api_version.clone()),
        capability_ids_json: "[]".into(),
        updated_at: now.clone(),
      },
    )?;
    provider_runtime_bindings::insert_snapshot_binding(
      conn,
      &ProviderRuntimeSnapshotBinding {
        id: crate::domain::time::new_id(),
        snapshot_set_id: set_id,
        provider_id,
        adapter_id: "openai-compatible".into(),
        runtime_kind: default_binding.runtime_kind,
        package_digest: default_binding.package_digest.clone(),
        grant_set_revision: default_binding.grant_set_revision,
        state: default_binding.state,
        error_code: None,
        error_message: None,
        runtime_requirement_json: None,
        created_at: default_binding.created_at.clone(),
        updated_at: now.clone(),
      },
    )?;
    Ok(())
  })
  .unwrap();

  // Preview for the gemini adapter must fail closed; the current binding stays intact.
  let before = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "gemini"))
    .unwrap();
  let err = lifecycle
    .preview_interface_rollback(&PreviewProviderRuntimeInterfaceRollbackInput {
      provider_id,
      adapter_id: "gemini".into(),
    })
    .unwrap_err();
  assert!(
    matches!(err, crate::error::StorageError::Validation(_)),
    "missing adapter must be a validation error, got {err:?}"
  );
  let message = err.to_string();
  assert!(
    message.contains("gemini") && message.contains("snapshot"),
    "error must name the adapter and snapshot, got: {message}"
  );
  let after = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "gemini"))
    .unwrap();
  assert_eq!(
    before, after,
    "rejected preview must keep the current binding untouched"
  );
  assert_eq!(after.package_digest.as_deref(), Some(p2_digest.as_str()));
}

/// Rollback snapshot identity is the SOURCE binding's exact package identity. An attach onto
/// a never-attached legacy adapter must record the explicit legacy sentinel identity, never
/// the target package's identity.
#[test]
fn attach_snapshot_of_legacy_source_records_explicit_legacy_identity() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeInterfaceAttachInput, PreviewProviderRuntimeInterfaceAttachInput,
  };

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let provider_id = crate::domain::time::new_id();
  insert_provider_row(&db, provider_id, "P", None, vault.as_ref(), None);
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm);

  let openai = openai_compatible_manifest(&[
    (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
    (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
  ]);
  let digest = install(
    &packages,
    &vendor_signed_package(
      &openai,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );

  let preview = lifecycle
    .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
      provider_id,
      adapter_id: "openai-compatible".into(),
      package_digest: digest.clone(),
    })
    .unwrap();
  lifecycle
    .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();

  let sets = db
    .read(|conn| provider_runtime_bindings::list_snapshot_sets(conn, provider_id))
    .unwrap();
  assert_eq!(sets.len(), 1);
  let snapshot = &sets[0];
  assert_eq!(snapshot.package_digest, None, "legacy source carries no package");
  assert_eq!(
    snapshot.plugin_id, "legacy-frontend-provider",
    "legacy snapshot must carry the explicit legacy sentinel, got '{}'",
    snapshot.plugin_id
  );
  assert!(
    snapshot.plugin_version.is_empty(),
    "legacy snapshot must carry an empty plugin version"
  );
  assert!(snapshot.publisher_key_id.is_none());
  assert!(snapshot.publisher_fingerprint.is_none());
  assert!(snapshot.plugin_api_version.is_none());
}

/// A replace attach snapshots the SOURCE binding; the snapshot identity must resolve from the
/// source package digest (plugin/version/publisher/API), never from the target package.
#[test]
fn replace_attach_snapshot_resolves_source_package_identity() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeInterfaceAttachInput, PreviewProviderRuntimeInterfaceAttachInput,
  };

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let provider_id = crate::domain::time::new_id();
  insert_provider_row(&db, provider_id, "P", None, vault.as_ref(), None);
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm);

  let mut p1_manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    &[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ],
  );
  p1_manifest.id = "com.langnext.provider.openai-compatible".into();
  p1_manifest.version = "1.0.0".into();
  let p1_digest = install(
    &packages,
    &vendor_signed_package(
      &p1_manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );
  let mut p2_manifest = provider_runtime_manifest(
    valid_declaration(),
    &[("llm.models.list@1", MODELS_ARTIFACT), ("llm.chat@1", CHAT_ARTIFACT)],
    &[
      (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
      (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
    ],
  );
  p2_manifest.id = "com.langnext.provider.openai-v2".into();
  p2_manifest.version = "2.0.0".into();
  let p2_digest = install(
    &packages,
    &vendor_signed_package(
      &p2_manifest,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );

  let attach = |digest: &str| {
    let preview = lifecycle
      .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
        provider_id,
        adapter_id: "openai-compatible".into(),
        package_digest: digest.to_string(),
      })
      .unwrap();
    lifecycle
      .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
        preview_id: preview.preview_id,
        acknowledge_permissions: true,
      })
      .unwrap()
  };
  attach(&p1_digest);
  attach(&p2_digest);

  // Newest set = the replace snapshot of the SOURCE (P1) binding.
  let sets = db
    .read(|conn| provider_runtime_bindings::list_snapshot_sets(conn, provider_id))
    .unwrap();
  assert_eq!(sets.len(), 2);
  let replace_snapshot = &sets[0];
  assert_eq!(replace_snapshot.package_digest.as_deref(), Some(p1_digest.as_str()));
  assert_eq!(
    replace_snapshot.plugin_id, p1_manifest.id,
    "replace snapshot must record the source plugin, got '{}'",
    replace_snapshot.plugin_id
  );
  assert_eq!(replace_snapshot.plugin_version, p1_manifest.version);
  assert_eq!(
    replace_snapshot.publisher_key_id.as_deref(),
    Some(crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID)
  );
  assert_eq!(
    replace_snapshot.publisher_fingerprint.as_deref(),
    Some(test_vendor_fixture::fixture_vendor_fingerprint().as_str())
  );
  assert_eq!(replace_snapshot.plugin_api_version.as_deref(), Some("1.0"));
  assert_ne!(replace_snapshot.plugin_id, p2_manifest.id, "never the target identity");
}

/// A detach snapshot resolves the removed binding's exact package identity from its digest;
/// the digest must never be stored as `plugin_id`.
#[test]
fn detach_snapshot_records_exact_package_identity_not_digest() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeInterfaceAttachInput, PreviewProviderRuntimeInterfaceAttachInput,
    ProviderRuntimeInterfaceDetachInput,
  };

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let provider_id = crate::domain::time::new_id();
  insert_provider_row(&db, provider_id, "P", None, vault.as_ref(), None);
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm);

  let openai = openai_compatible_manifest(&[
    (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
    (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
  ]);
  let digest = install(
    &packages,
    &vendor_signed_package(
      &openai,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );

  let preview = lifecycle
    .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
      provider_id,
      adapter_id: "openai-compatible".into(),
      package_digest: digest.clone(),
    })
    .unwrap();
  lifecycle
    .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();

  let provider_row = db.read(|conn| provider_instances::get(conn, provider_id)).unwrap();
  let binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  lifecycle
    .detach_interface(&ProviderRuntimeInterfaceDetachInput {
      provider_id,
      adapter_id: "openai-compatible".into(),
      expected_updated_at: provider_row.updated_at.clone(),
      expected_binding_updated_at: binding.updated_at.clone(),
    })
    .unwrap();

  let sets = db
    .read(|conn| provider_runtime_bindings::list_snapshot_sets(conn, provider_id))
    .unwrap();
  assert_eq!(sets.len(), 2);
  let detach_snapshot = &sets[0];
  assert_eq!(detach_snapshot.package_digest.as_deref(), Some(digest.as_str()));
  assert_eq!(
    detach_snapshot.plugin_id, openai.id,
    "detach snapshot must resolve the plugin id from the digest, got '{}'",
    detach_snapshot.plugin_id
  );
  assert!(
    detach_snapshot.plugin_id != digest,
    "the digest must never be stored as plugin_id"
  );
  assert_eq!(detach_snapshot.plugin_version, openai.version);
  assert_eq!(
    detach_snapshot.publisher_key_id.as_deref(),
    Some(crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID)
  );
  assert_eq!(detach_snapshot.plugin_api_version.as_deref(), Some("1.0"));
}

/// Detach snapshots must have a frontend-reachable cleanup seam: the provider snapshot list
/// exposes the detach snapshot as a sanitized DTO, and discarding it releases the retained
/// grant so the package can be uninstalled. Rollback stays possible until the discard.
#[test]
fn detach_snapshot_is_listable_and_discard_releases_grant_for_uninstall() {
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::runtime_provider::{
    ApplyProviderRuntimeInterfaceAttachInput, PreviewProviderRuntimeInterfaceAttachInput,
    ProviderRuntimeInterfaceDetachInput, ProviderRuntimeInterfaceDiscardSnapshotInput,
  };

  let (_dir, db, packages, wasm) = setup();
  let vault = Arc::new(MemoryCredentialVault::new());
  let provider_id = crate::domain::time::new_id();
  insert_provider_row(&db, provider_id, "P", None, vault.as_ref(), None);
  let lifecycle = ProviderRuntimeService::new(db.clone(), packages.clone(), wasm);

  let openai = openai_compatible_manifest(&[
    (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
    (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
  ]);
  let digest = install(
    &packages,
    &vendor_signed_package(
      &openai,
      &[
        (MODELS_ARTIFACT, LLM_MODELS_COMPONENT),
        (CHAT_ARTIFACT, LLM_CHAT_COMPONENT),
      ],
    ),
  );

  let preview = lifecycle
    .preview_interface_attach(&PreviewProviderRuntimeInterfaceAttachInput {
      provider_id,
      adapter_id: "openai-compatible".into(),
      package_digest: digest.clone(),
    })
    .unwrap();
  lifecycle
    .apply_interface_attach(ApplyProviderRuntimeInterfaceAttachInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let provider_row = db.read(|conn| provider_instances::get(conn, provider_id)).unwrap();
  let binding = db
    .read(|conn| provider_runtime_bindings::get(conn, provider_id, "openai-compatible"))
    .unwrap();
  lifecycle
    .detach_interface(&ProviderRuntimeInterfaceDetachInput {
      provider_id,
      adapter_id: "openai-compatible".into(),
      expected_updated_at: provider_row.updated_at.clone(),
      expected_binding_updated_at: binding.updated_at.clone(),
    })
    .unwrap();

  // The frontend-reachable list exposes the undiscarded detach snapshot with its exact
  // source package identity and the adapter it owns.
  let snapshots = lifecycle.list_interface_snapshots(provider_id).unwrap();
  assert_eq!(snapshots.len(), 2, "attach + detach snapshots remain until discarded");
  let detach_snapshot = snapshots
    .iter()
    .find(|s| s.scope == "adapter" && s.package_digest.as_deref() == Some(digest.as_str()))
    .unwrap_or_else(|| panic!("detach snapshot missing from list: {snapshots:?}"));
  assert_eq!(detach_snapshot.provider_id, provider_id);
  assert_eq!(detach_snapshot.plugin_id, openai.id);
  assert_eq!(detach_snapshot.plugin_version, openai.version);
  assert_eq!(detach_snapshot.adapter_ids, vec!["openai-compatible".to_string()]);

  // Discarding every snapshot releases the retained grant; the package uninstalls.
  for snapshot in &snapshots {
    lifecycle
      .discard_interface_snapshot(&ProviderRuntimeInterfaceDiscardSnapshotInput {
        provider_id,
        snapshot_id: snapshot.id,
        expected_updated_at: provider_row.updated_at.clone(),
      })
      .unwrap();
  }
  assert!(lifecycle.list_interface_snapshots(provider_id).unwrap().is_empty());
  let grant_count: i64 = db
    .read(|conn| {
      Ok(
        conn
          .query_row(
            "SELECT COUNT(*) FROM execution_grant_sets
              WHERE subject_kind = 'provider_instance' AND subject_id = ?1 AND package_digest = ?2",
            rusqlite::params![provider_id.to_string(), digest],
            |row| row.get(0),
          )
          .unwrap(),
      )
    })
    .unwrap();
  assert_eq!(grant_count, 0, "final discard must release the retained grant");
  packages
    .uninstall_version(&digest)
    .unwrap_or_else(|e| panic!("uninstall after discard must succeed, got {e:?}"));
}
