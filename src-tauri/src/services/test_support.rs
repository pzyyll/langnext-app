// ABOUTME: Shared package-first test fixtures: install committed vendor packages, project
// ABOUTME: definitions, authorize defaults, and wire provider runtimes for service tests.
#![cfg(test)]

use crate::credentials::CredentialVault;
use crate::domain::default_package_activation::AuthorizeDefaultPluginPackageInput;
use crate::services::default_package_activation::DefaultPackageActivationService;
use crate::services::plugin_store::PluginPackageService;
use crate::services::providers::ProviderService;
use crate::services::runtime_providers::ProviderRuntimeService;
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::vendor_trust::test_vendor_fixture::fixture_vendor_public_key;
use crate::services::wasm_runtime::WasmRuntime;
use crate::storage::Database;
use std::path::Path;
use std::sync::Arc;

/// Package store rooted at the committed dev fixture vendor key so signed fixture
/// packages verify through the genuine package store (no mocked verification paths).
pub(crate) fn vendor_packages(db: Database, dir: &Path) -> PluginPackageService {
  PluginPackageService::with_vendor_roots(db, dir.to_path_buf(), vec![fixture_vendor_public_key()])
}

/// Verified identity of an installed package, derived only from store output.
#[derive(Debug, Clone)]
pub(crate) struct InstalledPackageFixtureIdentity {
  pub package_digest: String,
  pub plugin_id: String,
  pub plugin_version: String,
  pub publisher_key_id: String,
  pub publisher_fingerprint: String,
  pub runtime_kind: String,
  pub capabilities: Vec<String>,
}

/// Idempotently import a committed vendor-signed archive; returns its package digest.
pub(crate) fn bootstrap_package(packages: &PluginPackageService, bytes: &[u8]) -> String {
  packages
    .bootstrap_bundled_package(bytes, false)
    .expect("vendor package bootstraps")
    .package_digest()
    .to_string()
}

/// Bootstrap a committed archive and return the verified installed identity.
pub(crate) fn bootstrap_identity(packages: &PluginPackageService, bytes: &[u8]) -> InstalledPackageFixtureIdentity {
  let digest = bootstrap_package(packages, bytes);
  let version = packages
    .list_versions()
    .expect("list versions")
    .into_iter()
    .find(|row| row.package_digest == digest)
    .expect("bootstrapped package is listed");
  InstalledPackageFixtureIdentity {
    package_digest: version.package_digest,
    plugin_id: version.plugin_id,
    plugin_version: version.version,
    publisher_key_id: version.publisher_key_id,
    publisher_fingerprint: version.publisher_fingerprint,
    runtime_kind: version.runtime_kind,
    capabilities: version.capabilities,
  }
}

/// Project package definitions from installed packages into a fresh registry, exactly like
/// production startup: installed signed packages are the only source of service definitions.
pub(crate) fn registry_from_installed_packages(packages: &PluginPackageService) -> Arc<ServiceIntegrationRegistry> {
  let mut registry = ServiceIntegrationRegistry::empty();
  for definition in packages
    .project_installed_service_definitions()
    .expect("project installed service definitions")
  {
    let plugin_id = definition.manifest.id.clone();
    registry
      .upsert_package_definition(definition)
      .unwrap_or_else(|e| panic!("upsert package definition {plugin_id}: {e}"));
  }
  Arc::new(registry)
}

/// Authorize an installed digest as the default package for new instances. Tests may use
/// explicit fixture keys; production trust/defaults are never touched by test fixtures.
pub(crate) fn authorize_default(activation: &DefaultPackageActivationService, digest: &str) {
  let preview = activation
    .preview_default_package_activation(digest)
    .expect("preview default activation");
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .expect("authorize default package");
}

/// Install + authorize a committed vendor archive as the default package for the store.
pub(crate) fn install_and_authorize_default(
  packages: &PluginPackageService,
  activation: &DefaultPackageActivationService,
  bytes: &[u8],
) -> String {
  let digest = bootstrap_package(packages, bytes);
  authorize_default(activation, &digest);
  digest
}

/// ProviderService whose create is package-gated on the authorized openai-compatible
/// default package, with the real Wasm provider runtime wired for execution.
pub(crate) fn package_first_providers(db: Database, vault: Arc<dyn CredentialVault>, dir: &Path) -> ProviderService {
  let packages = vendor_packages(db.clone(), dir);
  let activation = DefaultPackageActivationService::create(db.clone(), packages.clone(), dir);
  install_and_authorize_default(&packages, &activation, OPENAI_COMPATIBLE_PACKAGE);
  let runtime = ProviderRuntimeService::new(db.clone(), packages, Arc::new(WasmRuntime::new().unwrap()));
  ProviderService::new(db, vault).with_runtime_defaults(Arc::new(runtime))
}

const OPENAI_COMPATIBLE_PACKAGE: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/openai-compatible/fixtures/packages/com.langnext.provider.openai-compatible-1.0.0.lnplugin"
));

/// Vendor-signed google-translate-web package built from the committed guest artifacts and
/// schemas, declaring the https_proxy instance origin field the import/broker fixtures need.
/// The production google-translate-web archive is not committed as a .lnplugin fixture, so
/// the synthetic archive is the package-derived source for tests that normalize its config.
pub(crate) fn google_translate_web_package() -> (Vec<u8>, String) {
  use crate::domain::runtime_plugin::{
    CapabilityDeclaration, FileRole, HttpMethod, NetworkEndpointRequest, PermissionRequests, PluginFileEntry,
    PluginManifestV1, PublisherDeclaration, RuntimeDescriptor, RuntimeKind,
  };
  use crate::domain::service_integration::{GOOGLE_TRANSLATE_WEB_GTX_ORIGIN, GOOGLE_TRANSLATE_WEB_PLUGIN_ID};
  use crate::services::plugin_package::test_support::build_signed_package_with_key;
  use crate::services::plugin_package::{hash_archive_bytes, public_sha256_hex};
  use crate::services::vendor_trust::test_vendor_fixture::{fixture_vendor_fingerprint, fixture_vendor_signing_key};

  const TRANSLATE_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-plugins/google-translate-web/translate/fixtures/langnext-google-translate-web-translate.wasm"
  ));
  const DETECT_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-plugins/google-translate-web/detect/fixtures/langnext-google-translate-web-detect.wasm"
  ));
  const CONFIG_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-plugins/google-translate-web/schemas/config-proxy.json"
  ));
  const PREFS_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-plugins/google-translate-web/schemas/translate-preferences.json"
  ));

  let schema_bytes = CONFIG_SCHEMA.as_bytes().to_vec();
  let prefs_bytes = PREFS_SCHEMA.as_bytes().to_vec();
  let files = vec![
    PluginFileEntry {
      path: "translate/fixtures/langnext-google-translate-web-translate.wasm".into(),
      role: FileRole::RuntimeArtifact,
      bytes: TRANSLATE_WASM.len() as u64,
      sha256: public_sha256_hex(TRANSLATE_WASM),
    },
    PluginFileEntry {
      path: "detect/fixtures/langnext-google-translate-web-detect.wasm".into(),
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
      path: "schemas/translate-preferences.json".into(),
      role: FileRole::PreferenceSchema,
      bytes: prefs_bytes.len() as u64,
      sha256: public_sha256_hex(&prefs_bytes),
    },
  ];
  let manifest = PluginManifestV1 {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
    version: "1.0.0".into(),
    publisher: PublisherDeclaration {
      key_id: crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID.into(),
      key_fingerprint: fixture_vendor_fingerprint(),
    },
    runtime: RuntimeDescriptor {
      kind: RuntimeKind::WasmComponent,
      artifact: Some("translate/fixtures/langnext-google-translate-web-translate.wasm".into()),
      native_protocol_version: None,
      native_dependencies: None,
    },
    targets: vec![],
    files,
    capabilities: vec![
      CapabilityDeclaration {
        id: "translate.text@1".into(),
        preferences_schema: Some("schemas/translate-preferences.json".into()),
        artifact: Some("translate/fixtures/langnext-google-translate-web-translate.wasm".into()),
      },
      CapabilityDeclaration {
        id: "translate.detect@1".into(),
        preferences_schema: Some("schemas/translate-preferences.json".into()),
        artifact: Some("detect/fixtures/langnext-google-translate-web-detect.wasm".into()),
      },
    ],
    configuration_schema: Some("schemas/config.json".into()),
    config_schema_version: Some(1),
    credential_slots: vec![],
    permissions: PermissionRequests {
      network: vec![
        NetworkEndpointRequest {
          id: "gtx".into(),
          origins: vec![GOOGLE_TRANSLATE_WEB_GTX_ORIGIN.into()],
          methods: vec![HttpMethod::Get],
          instance_origin_config_field: None,
        },
        NetworkEndpointRequest {
          id: "https-proxy".into(),
          // Host-fixed origins must be canonical (origin only); the default proxy URL with
          // path lives in the config schema default, not in the network grant.
          origins: vec!["https://googlet.deno.dev".into()],
          methods: vec![HttpMethod::Get],
          instance_origin_config_field: Some("proxy-url".into()),
        },
      ],
      auth_policies: vec!["host.none.v1".into()],
    },
    ui: Default::default(),
    path_authority: vec![],
    provider_runtime: None,
    model_resources: None,
  };
  let payloads: Vec<(&str, &[u8])> = vec![
    (
      "translate/fixtures/langnext-google-translate-web-translate.wasm",
      TRANSLATE_WASM,
    ),
    ("detect/fixtures/langnext-google-translate-web-detect.wasm", DETECT_WASM),
    ("schemas/config.json", &schema_bytes),
    ("schemas/translate-preferences.json", &prefs_bytes),
  ];
  let package = build_signed_package_with_key(&manifest, &payloads, &fixture_vendor_signing_key());
  let digest = hash_archive_bytes(&package);
  (package, digest)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::storage::Database;

  #[test]
  fn bootstrap_identity_comes_from_verified_archive_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let packages = vendor_packages(db, dir.path());
    let identity = bootstrap_identity(&packages, OPENAI_COMPATIBLE_PACKAGE);
    assert_eq!(identity.plugin_id, "com.langnext.provider.openai-compatible");
    assert_eq!(identity.plugin_version, "1.0.0");
    assert_eq!(identity.runtime_kind, "wasm-component");
    assert_eq!(identity.package_digest.len(), 64);
    assert!(!identity.capabilities.is_empty());
  }
}

/// Vendor-signed baidu-ocr package built from the committed guest artifacts and schemas,
/// mirroring the committed `runtime-plugins/baidu-ocr/plugin.json` manifest: `api-key` /
/// `secret-key` credential slots, `ocr.image@1`, the fixed aip.baidubce.com endpoints, the
/// exact path authority, and the host Baidu client-credentials auth policy.
pub(crate) fn baidu_ocr_package() -> (Vec<u8>, String) {
  use crate::domain::runtime_plugin::{
    CapabilityDeclaration, CapabilityPathAuthorityDecl, CredentialSlotDecl, CredentialSlotKindV1,
    DeclaredPathAuthority, FileRole, HttpMethod, NetworkEndpointRequest, PermissionRequests, PluginFileEntry,
    PluginManifestV1, PublisherDeclaration, RuntimeDescriptor, RuntimeKind,
  };
  use crate::services::auth_policies::BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID;
  use crate::services::plugin_package::test_support::build_signed_package_with_key;
  use crate::services::plugin_package::{hash_archive_bytes, public_sha256_hex};
  use crate::services::vendor_trust::test_vendor_fixture::{fixture_vendor_fingerprint, fixture_vendor_signing_key};

  const BAIDU_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-plugins/baidu-ocr/ocr/fixtures/langnext-baidu-ocr.wasm"
  ));
  const CONFIG_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-plugins/baidu-ocr/schemas/config.json"
  ));
  const PREFS_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-plugins/baidu-ocr/schemas/ocr-preferences.json"
  ));

  let schema_bytes = CONFIG_SCHEMA.as_bytes().to_vec();
  let prefs_bytes = PREFS_SCHEMA.as_bytes().to_vec();
  let files = vec![
    PluginFileEntry {
      path: "ocr/fixtures/langnext-baidu-ocr.wasm".into(),
      role: FileRole::RuntimeArtifact,
      bytes: BAIDU_WASM.len() as u64,
      sha256: public_sha256_hex(BAIDU_WASM),
    },
    PluginFileEntry {
      path: "schemas/config.json".into(),
      role: FileRole::ConfigSchema,
      bytes: schema_bytes.len() as u64,
      sha256: public_sha256_hex(&schema_bytes),
    },
    PluginFileEntry {
      path: "schemas/ocr-preferences.json".into(),
      role: FileRole::PreferenceSchema,
      bytes: prefs_bytes.len() as u64,
      sha256: public_sha256_hex(&prefs_bytes),
    },
  ];
  let baidu_endpoints = [
    ("baidu-general-basic", "rest/2.0/ocr/v1/general_basic"),
    ("baidu-accurate-basic", "rest/2.0/ocr/v1/accurate_basic"),
    ("baidu-general", "rest/2.0/ocr/v1/general"),
    ("baidu-accurate", "rest/2.0/ocr/v1/accurate"),
  ];
  let manifest = PluginManifestV1 {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: crate::domain::service_integration::BAIDU_OCR_PLUGIN_ID.into(),
    version: "1.0.0".into(),
    publisher: PublisherDeclaration {
      key_id: crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID.into(),
      key_fingerprint: fixture_vendor_fingerprint(),
    },
    runtime: RuntimeDescriptor {
      kind: RuntimeKind::WasmComponent,
      artifact: Some("ocr/fixtures/langnext-baidu-ocr.wasm".into()),
      native_protocol_version: None,
      native_dependencies: None,
    },
    targets: vec![],
    files,
    capabilities: vec![CapabilityDeclaration {
      id: crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID.into(),
      preferences_schema: Some("schemas/ocr-preferences.json".into()),
      artifact: Some("ocr/fixtures/langnext-baidu-ocr.wasm".into()),
    }],
    configuration_schema: Some("schemas/config.json".into()),
    config_schema_version: Some(1),
    credential_slots: vec![
      CredentialSlotDecl {
        id: "api-key".into(),
        kind: CredentialSlotKindV1::SecretText,
        required: true,
      },
      CredentialSlotDecl {
        id: "secret-key".into(),
        kind: CredentialSlotKindV1::SecretText,
        required: true,
      },
    ],
    permissions: PermissionRequests {
      network: baidu_endpoints
        .iter()
        .map(|(alias, _)| NetworkEndpointRequest {
          id: (*alias).into(),
          origins: vec![crate::domain::service_integration::BAIDU_OCR_ORIGIN.into()],
          methods: vec![HttpMethod::Post],
          instance_origin_config_field: None,
        })
        .collect(),
      auth_policies: vec![BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID.into()],
    },
    ui: Default::default(),
    path_authority: baidu_endpoints
      .iter()
      .map(|(alias, path)| CapabilityPathAuthorityDecl {
        capability_id: crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID.into(),
        endpoint_id: (*alias).into(),
        method: HttpMethod::Post,
        path: DeclaredPathAuthority::Exact { value: (*path).into() },
        allowed_query_names: vec![],
        allowed_header_names: vec![],
        auth_policy_id: Some(BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID.into()),
      })
      .collect(),
    provider_runtime: None,
    model_resources: None,
  };
  let mut payloads: Vec<(&str, &[u8])> = vec![
    ("ocr/fixtures/langnext-baidu-ocr.wasm", BAIDU_WASM),
    ("schemas/config.json", &schema_bytes),
    ("schemas/ocr-preferences.json", &prefs_bytes),
  ];
  payloads.sort_by(|a, b| a.0.cmp(b.0));
  let package = build_signed_package_with_key(&manifest, &payloads, &fixture_vendor_signing_key());
  let digest = hash_archive_bytes(&package);
  (package, digest)
}
