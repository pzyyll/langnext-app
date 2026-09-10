// ABOUTME: Shared catalog-first test fixtures: built-in archives, synthetic content, and stacks.
// ABOUTME: No publisher keys, signatures, approval, or default-activation fixtures exist.
#![cfg(test)]

use crate::credentials::CredentialVault;
use crate::domain::plugin_catalog::PluginSource;
use crate::domain::runtime_plugin::{
  CapabilityDeclaration, CredentialSlotDecl, FileRole, HttpMethod, NetworkEndpointRequest, PackageTargetConstraint,
  PermissionRequests, PluginFileEntry, PluginManifestV1, ProviderRuntimeDeclaration, RuntimeDescriptor, RuntimeKind,
  UiDeclaration,
};
use crate::services::package_definition::project_loaded_plugin;
use crate::services::plugin_catalog::{PluginCatalog, PluginCatalogConfig};
use crate::services::plugin_loader::{LoadedPlugin, PluginLoader};
use crate::services::plugin_store::UserPluginStore;
use crate::services::providers::ProviderService;
use crate::services::runtime_lifecycle::RuntimeLifecycleService;
use crate::services::runtime_providers::ProviderRuntimeService;
use crate::services::runtime_router::RuntimeRouter;
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::token_grant::TokenGrantService;
use crate::services::wasm_runtime::WasmRuntime;
use crate::storage::Database;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Committed built-in archive directory shipped with the application resources.
pub(crate) fn builtin_plugins_dir() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("resources")
    .join("plugins")
}

/// Read one committed built-in archive by file name (without the `.lnplugin` suffix).
pub(crate) fn builtin_archive_bytes(archive_name: &str) -> Vec<u8> {
  let path = builtin_plugins_dir().join(format!("{archive_name}.lnplugin"));
  std::fs::read(&path).unwrap_or_else(|error| panic!("read built-in archive {}: {error}", path.display()))
}

/// Copy the named built-in archives into a private resource directory and return its path.
pub(crate) fn builtin_dir_with_archives(dir: &Path, archive_names: &[&str]) -> PathBuf {
  let plugins_dir = dir.join("resources").join("plugins");
  std::fs::create_dir_all(&plugins_dir).unwrap();
  for name in archive_names {
    std::fs::write(
      plugins_dir.join(format!("{name}.lnplugin")),
      builtin_archive_bytes(name),
    )
    .unwrap();
  }
  plugins_dir
}

/// Catalog over the named built-in archives, rooted at one app data directory.
pub(crate) fn catalog_with_builtins(db: Database, app_data_dir: &Path, archive_names: &[&str]) -> Arc<PluginCatalog> {
  let plugins_dir = builtin_dir_with_archives(app_data_dir, archive_names);
  catalog_over(db, app_data_dir, plugins_dir)
}

/// Catalog over every committed built-in archive.
pub(crate) fn catalog_all_builtins(db: Database, app_data_dir: &Path) -> Arc<PluginCatalog> {
  catalog_with_builtins(db, app_data_dir, ALL_BUILTIN_ARCHIVES)
}

/// Catalog over an explicit built-in directory (already materialized content).
pub(crate) fn catalog_over(db: Database, app_data_dir: &Path, plugins_dir: PathBuf) -> Arc<PluginCatalog> {
  let catalog = Arc::new(PluginCatalog::new(
    db,
    PluginCatalogConfig {
      app_data_dir: app_data_dir.to_path_buf(),
      built_in_dir: Some(plugins_dir),
      development_dir: None,
      user_dir: app_data_dir.join(crate::domain::plugin_catalog::USER_PLUGIN_DIR_NAME),
      cache_dir: app_data_dir.join(crate::domain::plugin_catalog::PLUGIN_CACHE_DIR_NAME),
      allow_development: false,
    },
  ));
  catalog.refresh().expect("fixture catalog refreshes");
  assert!(
    !catalog.has_builtin_errors(),
    "fixture built-ins must load: {:?}",
    catalog.errors()
  );
  catalog
}

/// User archive store over the standard layout of one app data directory.
pub(crate) fn user_store(db: Database, app_data_dir: &Path) -> UserPluginStore {
  UserPluginStore::new(
    db,
    app_data_dir.to_path_buf(),
    PluginLoader::new(app_data_dir.join(crate::domain::plugin_catalog::PLUGIN_CACHE_DIR_NAME)),
  )
}

/// Install one archive as user content through the public store path. Returns its digest.
pub(crate) fn install_user_archive(store: &UserPluginStore, archive_path: &Path) -> String {
  let preview = store.preview_archive(archive_path).expect("user archive previews");
  let result = store
    .install_previewed(crate::domain::plugin_catalog::InstallUserPackageInput {
      preview_id: preview.preview_id,
      content_digest: preview.content_digest,
      acknowledge_permissions: true,
    })
    .expect("user archive installs");
  result.entry.descriptor.content_digest
}

/// Verified identity of one catalog entry, derived only from catalog output.
#[derive(Debug, Clone)]
pub(crate) struct InstalledPackageFixtureIdentity {
  pub package_digest: String,
  pub plugin_id: String,
  pub plugin_version: String,
  pub runtime_kind: String,
  pub capabilities: Vec<String>,
}

/// Resolve the fixture identity for one plugin id from the catalog.
pub(crate) fn fixture_identity(catalog: &PluginCatalog, plugin_id: &str) -> InstalledPackageFixtureIdentity {
  let loaded = catalog
    .resolve_default(plugin_id)
    .unwrap_or_else(|| panic!("fixture plugin {plugin_id} is not in the catalog"));
  InstalledPackageFixtureIdentity {
    package_digest: loaded.descriptor.content_digest.clone(),
    plugin_id: loaded.descriptor.plugin_id.clone(),
    plugin_version: loaded.descriptor.version.clone(),
    runtime_kind: crate::domain::runtime_lifecycle::runtime_kind_as_str(loaded.descriptor.runtime_kind).to_string(),
    capabilities: loaded.descriptor.capabilities.clone(),
  }
}

/// Content digest of one catalog entry.
pub(crate) fn fixture_digest(catalog: &PluginCatalog, plugin_id: &str) -> String {
  fixture_identity(catalog, plugin_id).package_digest
}

/// Project every catalog snapshot into a fresh registry, exactly like production startup.
pub(crate) fn registry_from_catalog(catalog: &PluginCatalog) -> Arc<ServiceIntegrationRegistry> {
  let mut registry = ServiceIntegrationRegistry::empty();
  for loaded in catalog.loaded_plugins() {
    let plugin_id = loaded.descriptor.plugin_id.clone();
    let definition = project_loaded_plugin(&loaded).unwrap_or_else(|e| panic!("project {plugin_id}: {e}"));
    registry
      .upsert_package_definition(definition)
      .unwrap_or_else(|e| panic!("upsert package definition {plugin_id}: {e}"));
  }
  Arc::new(registry)
}

/// Project only the named plugin ids into a registry.
pub(crate) fn registry_for(catalog: &PluginCatalog, plugin_ids: &[&str]) -> Arc<ServiceIntegrationRegistry> {
  let mut registry = ServiceIntegrationRegistry::empty();
  for plugin_id in plugin_ids {
    let loaded = catalog
      .resolve_default(plugin_id)
      .unwrap_or_else(|| panic!("fixture plugin {plugin_id} is not in the catalog"));
    let definition = project_loaded_plugin(&loaded).unwrap_or_else(|e| panic!("project {plugin_id}: {e}"));
    registry
      .upsert_package_definition(definition)
      .unwrap_or_else(|e| panic!("upsert package definition {plugin_id}: {e}"));
  }
  Arc::new(registry)
}

/// ProviderService whose create resolves the catalog default for the openai-compatible
/// provider package, with the real Wasm provider runtime wired for execution.
pub(crate) fn package_first_providers(
  db: Database,
  vault: Arc<dyn CredentialVault>,
  app_data_dir: &Path,
) -> ProviderService {
  let catalog = catalog_with_builtins(db.clone(), app_data_dir, &[OPENAI_COMPATIBLE_ARCHIVE]);
  let runtime = ProviderRuntimeService::new(db.clone(), catalog, Arc::new(WasmRuntime::new().unwrap()));
  ProviderService::new(db, vault).with_runtime_defaults(Arc::new(runtime))
}

/// Real Wasm runtime for fixture execution.
pub(crate) fn wasm_runtime() -> Arc<WasmRuntime> {
  Arc::new(WasmRuntime::new().unwrap())
}

/// Token grant service with the real Google exchanger and an in-memory vault.
pub(crate) fn token_service(db: &Database, vault: Arc<dyn CredentialVault>) -> Arc<TokenGrantService> {
  Arc::new(
    TokenGrantService::new(vec![Arc::new(
      crate::services::google_service_account::GoogleServiceAccountExchanger::new(db.clone(), vault),
    )])
    .unwrap(),
  )
}

/// Lifecycle service over one catalog/registry with the real Wasm runtime and token grants.
pub(crate) fn lifecycle_with_runtime(
  db: Database,
  catalog: Arc<PluginCatalog>,
  registry: Arc<ServiceIntegrationRegistry>,
) -> RuntimeLifecycleService {
  let tokens = token_service(&db, Arc::new(crate::credentials::MemoryCredentialVault::default()));
  RuntimeLifecycleService::new(db, catalog, registry).with_runtime(wasm_runtime(), tokens)
}

/// Router over one catalog/registry with the real Wasm runtime.
pub(crate) fn router_with_runtime(
  db: Database,
  catalog: Arc<PluginCatalog>,
  registry: Arc<ServiceIntegrationRegistry>,
) -> RuntimeRouter {
  RuntimeRouter::new(db, registry, catalog, wasm_runtime())
}

/// Run one future to completion on a current-thread runtime.
pub(crate) fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
  tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .unwrap()
    .block_on(future)
}

/// Plugin id of the openai-compatible provider package.
pub(crate) const OPENAI_COMPATIBLE_PLUGIN_ID: &str = "com.langnext.provider.openai-compatible";
/// Committed archive file stem for the openai-compatible provider package.
pub(crate) const OPENAI_COMPATIBLE_ARCHIVE: &str = "com.langnext.provider.openai-compatible-1.0.0";
/// Plugin id of the google-translate-web package.
pub(crate) const GOOGLE_TRANSLATE_WEB_PLUGIN_ID: &str = "com.langnext.google-translate-web";
/// Committed archive file stem for the google-translate-web package.
pub(crate) const GOOGLE_TRANSLATE_WEB_ARCHIVE: &str = "com.langnext.google-translate-web-1.0.0";
/// Plugin id of the baidu-ocr package.
pub(crate) const BAIDU_OCR_PLUGIN_ID: &str = "com.langnext.baidu-ocr";
/// Committed archive file stem for the baidu-ocr package.
pub(crate) const BAIDU_OCR_ARCHIVE: &str = "com.langnext.baidu-ocr-1.0.0";
/// Plugin id of the google-cloud package.
pub(crate) const GOOGLE_CLOUD_PLUGIN_ID: &str = "com.langnext.google-cloud";
/// Committed archive file stem for the google-cloud package.
pub(crate) const GOOGLE_CLOUD_ARCHIVE: &str = "com.langnext.google-cloud-1.2.0";
/// Plugin id of the paddleocr package.
pub(crate) const PADDLEOCR_PLUGIN_ID: &str = "com.langnext.paddleocr";
/// Committed archive file stem for the paddleocr package.
pub(crate) const PADDLEOCR_ARCHIVE: &str = "com.langnext.paddleocr-1.0.0";
/// Plugin id of the edge-tts package.
pub(crate) const EDGE_TTS_PLUGIN_ID: &str = "com.langnext.edge-tts";
/// Committed archive file stem for the edge-tts package.
pub(crate) const EDGE_TTS_ARCHIVE: &str = "com.langnext.edge-tts-1.0.0";

/// Every committed built-in archive stem, in deterministic order.
pub(crate) const ALL_BUILTIN_ARCHIVES: &[&str] = &[
  "com.langnext.baidu-ocr-1.0.0",
  "com.langnext.edge-tts-1.0.0",
  "com.langnext.google-cloud-1.2.0",
  "com.langnext.google-translate-web-1.0.0",
  "com.langnext.paddleocr-1.0.0",
  "com.langnext.provider.anthropic-1.0.0",
  "com.langnext.provider.deepseek-1.0.0",
  "com.langnext.provider.gemini-1.0.0",
  "com.langnext.provider.openai-compatible-1.0.0",
  "com.langnext.provider.openai-responses-1.0.0",
];

/// Every committed built-in plugin id, in deterministic order.
pub(crate) const ALL_BUILTIN_PLUGIN_IDS: &[&str] = &[
  "com.langnext.baidu-ocr",
  "com.langnext.edge-tts",
  "com.langnext.google-cloud",
  "com.langnext.google-translate-web",
  "com.langnext.paddleocr",
  "com.langnext.provider.anthropic",
  "com.langnext.provider.deepseek",
  "com.langnext.provider.gemini",
  "com.langnext.provider.openai-compatible",
  "com.langnext.provider.openai-responses",
];

/// Assert that one catalog entry is built-in content (never user or development content).
pub(crate) fn assert_builtin(catalog: &PluginCatalog, plugin_id: &str) {
  let loaded = catalog
    .resolve_default(plugin_id)
    .unwrap_or_else(|| panic!("fixture plugin {plugin_id} is not in the catalog"));
  assert_eq!(loaded.descriptor.source, PluginSource::BuiltIn);
}

/// Synthetic unsigned plugin content for tests that need a manifest the catalog does not ship.
///
/// The fixture builds a real manifest plus a real file index, so the loader applies every
/// production rule (index, roles, sizes, capability contracts, permissions) to it.
pub(crate) struct SyntheticPlugin {
  pub manifest: PluginManifestV1,
  files: Vec<(String, Vec<u8>)>,
}

impl SyntheticPlugin {
  /// Wasm plugin with one runtime artifact and no declared capability yet.
  pub fn new(plugin_id: &str, version: &str, artifact_path: &str, artifact: &[u8]) -> Self {
    let manifest = PluginManifestV1 {
      manifest_version: 1,
      plugin_api_version: "1.0".into(),
      id: plugin_id.into(),
      version: version.into(),
      runtime: RuntimeDescriptor {
        kind: RuntimeKind::WasmComponent,
        artifact: Some(artifact_path.into()),
        native_protocol_version: None,
        native_dependencies: None,
      },
      targets: Vec::new(),
      files: vec![indexed(artifact_path, FileRole::RuntimeArtifact, artifact)],
      capabilities: Vec::new(),
      configuration_schema: None,
      config_schema_version: None,
      credential_slots: Vec::new(),
      permissions: PermissionRequests::default(),
      path_authority: Vec::new(),
      ui: UiDeclaration::default(),
      provider_runtime: None,
      model_resources: None,
    };
    Self {
      manifest,
      files: vec![(artifact_path.into(), artifact.to_vec())],
    }
  }

  /// Native trusted worker fixture (rejected for user/development sources).
  pub fn native(plugin_id: &str, version: &str, artifact_path: &str, artifact: &[u8]) -> Self {
    let mut fixture = Self::new(plugin_id, version, artifact_path, artifact);
    fixture.manifest.runtime = RuntimeDescriptor {
      kind: RuntimeKind::TrustedNativeWorker,
      artifact: Some(artifact_path.into()),
      native_protocol_version: Some(1),
      native_dependencies: Some(Vec::new()),
    };
    fixture.manifest.targets = vec![PackageTargetConstraint {
      platform: crate::domain::runtime_plugin::host_package_platform().into(),
      architecture: std::env::consts::ARCH.into(),
    }];
    fixture
  }

  /// Set the config schema (JSON text) and index it as `schemas/config.json`.
  pub fn with_config_schema(mut self, schema_json: &str, schema_version: u32) -> Self {
    self = self.add_file("schemas/config.json", FileRole::ConfigSchema, schema_json.as_bytes());
    self.manifest.configuration_schema = Some("schemas/config.json".into());
    self.manifest.config_schema_version = Some(schema_version);
    self
  }

  /// Declare one capability with an optional preferences schema.
  pub fn with_capability(mut self, capability_id: &str) -> Self {
    self.manifest.capabilities.push(CapabilityDeclaration {
      id: capability_id.into(),
      preferences_schema: None,
      artifact: None,
    });
    self
  }

  /// Declare one capability with its own preferences schema.
  pub fn with_capability_and_preferences(mut self, capability_id: &str, preferences_json: &str) -> Self {
    self = self.add_file(
      "schemas/preferences.json",
      FileRole::PreferenceSchema,
      preferences_json.as_bytes(),
    );
    self.manifest.capabilities.push(CapabilityDeclaration {
      id: capability_id.into(),
      preferences_schema: Some("schemas/preferences.json".into()),
      artifact: None,
    });
    self
  }

  /// Declare several capabilities that share one preferences schema.
  pub fn with_capabilities_and_preferences(mut self, capability_ids: &[&str], preferences_json: &str) -> Self {
    self = self.add_file(
      "schemas/preferences.json",
      FileRole::PreferenceSchema,
      preferences_json.as_bytes(),
    );
    for capability_id in capability_ids {
      self.manifest.capabilities.push(CapabilityDeclaration {
        id: (*capability_id).into(),
        preferences_schema: Some("schemas/preferences.json".into()),
        artifact: None,
      });
    }
    self
  }

  /// Declare one capability whose runtime artifact is a separate indexed component.
  pub fn with_capability_artifact(
    mut self,
    capability_id: &str,
    artifact_path: &str,
    preferences_json: &str,
    artifact: &[u8],
  ) -> Self {
    self = self.add_file(artifact_path, FileRole::RuntimeArtifact, artifact);
    self = self.add_file(
      "schemas/preferences.json",
      FileRole::PreferenceSchema,
      preferences_json.as_bytes(),
    );
    self.manifest.capabilities.push(CapabilityDeclaration {
      id: capability_id.into(),
      preferences_schema: Some("schemas/preferences.json".into()),
      artifact: Some(artifact_path.into()),
    });
    self
  }

  /// Declare one network endpoint request.
  pub fn with_network_endpoint(mut self, id: &str, origins: &[&str], methods: &[HttpMethod]) -> Self {
    self.manifest.permissions.network.push(NetworkEndpointRequest {
      id: id.into(),
      origins: origins.iter().map(|origin| (*origin).to_string()).collect(),
      methods: methods.to_vec(),
      instance_origin_config_field: None,
    });
    self
  }

  /// Declare one network endpoint whose origin comes from instance config.
  pub fn with_instance_origin_endpoint(mut self, id: &str, config_field: &str, methods: &[HttpMethod]) -> Self {
    self.manifest.permissions.network.push(NetworkEndpointRequest {
      id: id.into(),
      origins: Vec::new(),
      methods: methods.to_vec(),
      instance_origin_config_field: Some(config_field.into()),
    });
    self
  }

  /// Add one auth policy id to the manifest request list.
  pub fn with_auth_policy(mut self, policy_id: &str) -> Self {
    self.manifest.permissions.auth_policies.push(policy_id.into());
    self
  }

  /// Declare one credential slot.
  pub fn with_credential_slot(mut self, id: &str, kind: crate::domain::runtime_plugin::CredentialSlotKindV1) -> Self {
    self.manifest.credential_slots.push(CredentialSlotDecl {
      id: id.into(),
      kind,
      required: false,
    });
    self
  }

  /// Add one closed path authority declaration.
  pub fn with_path_authority(mut self, authority: crate::domain::runtime_plugin::CapabilityPathAuthorityDecl) -> Self {
    self.manifest.path_authority.push(authority);
    self
  }

  /// Add one indexed file with the given role.
  pub fn add_file(mut self, path: &str, role: FileRole, bytes: &[u8]) -> Self {
    self.manifest.files.push(indexed(path, role, bytes));
    self.files.push((path.into(), bytes.to_vec()));
    self
  }

  /// Set the provider runtime declaration.
  pub fn with_provider_runtime(mut self, declaration: ProviderRuntimeDeclaration) -> Self {
    self.manifest.provider_runtime = Some(declaration);
    self
  }

  /// Set signed model resource descriptors.
  pub fn with_model_resources(mut self, resources: Vec<crate::domain::plugin_model::ModelResourceDescriptor>) -> Self {
    self.manifest.model_resources = Some(resources);
    self
  }

  /// Set host target constraints.
  pub fn with_targets(mut self, targets: Vec<PackageTargetConstraint>) -> Self {
    self.manifest.targets = targets;
    self
  }

  /// Exact `plugin.json` bytes for this fixture.
  pub fn manifest_bytes(&self) -> Vec<u8> {
    serde_json::to_vec(&self.manifest).expect("fixture manifest serializes")
  }

  /// Materialize this fixture as a plugin directory.
  pub fn write_directory(&self, dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("plugin.json"), self.manifest_bytes()).unwrap();
    for (path, bytes) in &self.files {
      let target = dir.join(path);
      std::fs::create_dir_all(target.parent().unwrap()).unwrap();
      std::fs::write(target, bytes).unwrap();
    }
  }

  /// Materialize this fixture as an unsigned `.lnplugin` archive. Returns the written path.
  ///
  /// Bytes are written directly so adversarial fixtures (invalid manifests, native content)
  /// reach the loader/store as an archive instead of failing during packing.
  pub fn write_archive(&self, path: &Path) -> PathBuf {
    use std::io::Write;
    let file = std::fs::File::create(path).expect("create fixture archive");
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
    writer
      .start_file("plugin.json", options)
      .expect("archive manifest entry");
    writer.write_all(&self.manifest_bytes()).expect("archive manifest");
    for (relative, bytes) in &self.files {
      writer.start_file(relative.as_str(), options).expect("archive entry");
      writer.write_all(bytes).expect("archive payload");
    }
    writer.finish().expect("finish fixture archive");
    path.to_path_buf()
  }

  /// Materialize this fixture as an unsigned archive in a temporary staging directory.
  pub fn archive_in(&self, dir: &Path, file_name: &str) -> PathBuf {
    self.write_archive(&dir.join(format!("{file_name}.lnplugin")))
  }

  /// Publish this fixture as built-in catalog content and return its content digest.
  /// The same plugin id/version directory is replaced, so the catalog keeps one entry.
  pub fn publish(&self, catalog: &PluginCatalog) -> String {
    add_builtin_fixture(catalog, &self.manifest, &self.files)
  }
}

fn indexed(path: &str, role: FileRole, bytes: &[u8]) -> PluginFileEntry {
  PluginFileEntry {
    path: path.into(),
    role,
    bytes: bytes.len() as u64,
    sha256: crate::domain::plugin_catalog::sha256_hex(bytes),
  }
}

/// Load one synthetic fixture as built-in content and return the loaded plugin.
pub(crate) fn load_synthetic(catalog: &PluginCatalog, plugin: &SyntheticPlugin) -> LoadedPlugin {
  let plugin_id = plugin.manifest.id.clone();
  catalog
    .resolve_default(&plugin_id)
    .unwrap_or_else(|| panic!("synthetic plugin {plugin_id} is not in the catalog"))
}

/// Write a hand-built manifest plus payloads as one plugin directory.
pub(crate) fn write_manifest_fixture_dir(
  root: &Path,
  manifest: &PluginManifestV1,
  payloads: &[(String, Vec<u8>)],
) -> PathBuf {
  let dir = root.join(format!("{}-{}", manifest.id.replace('.', "_"), manifest.version));
  std::fs::create_dir_all(&dir).unwrap();
  std::fs::write(
    dir.join("plugin.json"),
    serde_json::to_vec(manifest).expect("fixture manifest serializes"),
  )
  .unwrap();
  for (path, bytes) in payloads {
    let target = dir.join(path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, bytes).unwrap();
  }
  dir
}

/// Catalog over committed archives plus hand-built manifest fixtures materialized as built-ins.
pub(crate) fn catalog_with_manifest_fixtures(
  db: Database,
  app_data_dir: &Path,
  archive_names: &[&str],
  fixtures: &[(PluginManifestV1, Vec<(String, Vec<u8>)>)],
) -> Arc<PluginCatalog> {
  let plugins_dir = builtin_dir_with_archives(app_data_dir, archive_names);
  for (manifest, payloads) in fixtures {
    write_manifest_fixture_dir(&plugins_dir, manifest, payloads);
  }
  catalog_over(db, app_data_dir, plugins_dir)
}

/// Catalog containing the named committed archives plus synthetic built-in directories.
pub(crate) fn catalog_with_synthetic(
  db: Database,
  app_data_dir: &Path,
  archive_names: &[&str],
  synthetic: &[SyntheticPlugin],
) -> Arc<PluginCatalog> {
  let plugins_dir = builtin_dir_with_archives(app_data_dir, archive_names);
  for plugin in synthetic {
    let dir = plugins_dir.join(format!(
      "{}-{}",
      plugin.manifest.id.replace('.', "_"),
      plugin.manifest.version
    ));
    plugin.write_directory(&dir);
  }
  catalog_over(db, app_data_dir, plugins_dir)
}

/// Synthetic google-translate-web manifest fixture built from the committed guest artifacts and
/// schemas, declaring the `https_proxy` instance origin field that import/broker fixtures need.
///
/// The production google-translate-web archive is not committed as a `.lnplugin` fixture, so
/// this hand-built manifest is the package-derived source for tests that normalize its config.
pub(crate) fn google_translate_web_fixture() -> (PluginManifestV1, Vec<(String, Vec<u8>)>) {
  use crate::domain::runtime_plugin::{CapabilityDeclaration, CapabilityPathAuthorityDecl};
  use crate::domain::service_integration::{GOOGLE_TRANSLATE_WEB_GTX_ORIGIN, GOOGLE_TRANSLATE_WEB_PLUGIN_ID};

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

  const TRANSLATE_PATH: &str = "translate/fixtures/langnext-google-translate-web-translate.wasm";
  const DETECT_PATH: &str = "detect/fixtures/langnext-google-translate-web-detect.wasm";
  const CONFIG_PATH: &str = "schemas/config.json";
  const PREFS_PATH: &str = "schemas/translate-preferences.json";

  let manifest = PluginManifestV1 {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
    version: "1.0.0".into(),
    runtime: RuntimeDescriptor {
      kind: RuntimeKind::WasmComponent,
      artifact: Some(TRANSLATE_PATH.into()),
      native_protocol_version: None,
      native_dependencies: None,
    },
    targets: Vec::new(),
    files: vec![
      indexed(TRANSLATE_PATH, FileRole::RuntimeArtifact, TRANSLATE_WASM),
      indexed(DETECT_PATH, FileRole::RuntimeArtifact, DETECT_WASM),
      indexed(CONFIG_PATH, FileRole::ConfigSchema, CONFIG_SCHEMA.as_bytes()),
      indexed(PREFS_PATH, FileRole::PreferenceSchema, PREFS_SCHEMA.as_bytes()),
    ],
    capabilities: vec![
      CapabilityDeclaration {
        id: "translate.text@1".into(),
        preferences_schema: Some(PREFS_PATH.into()),
        artifact: Some(TRANSLATE_PATH.into()),
      },
      CapabilityDeclaration {
        id: "translate.detect@1".into(),
        preferences_schema: Some(PREFS_PATH.into()),
        artifact: Some(DETECT_PATH.into()),
      },
    ],
    configuration_schema: Some(CONFIG_PATH.into()),
    config_schema_version: Some(1),
    credential_slots: Vec::new(),
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
    path_authority: Vec::<CapabilityPathAuthorityDecl>::new(),
    ui: UiDeclaration::default(),
    provider_runtime: None,
    model_resources: None,
  };
  let payloads = vec![
    (TRANSLATE_PATH.to_string(), TRANSLATE_WASM.to_vec()),
    (DETECT_PATH.to_string(), DETECT_WASM.to_vec()),
    (CONFIG_PATH.to_string(), CONFIG_SCHEMA.as_bytes().to_vec()),
    (PREFS_PATH.to_string(), PREFS_SCHEMA.as_bytes().to_vec()),
  ];
  (manifest, payloads)
}

/// Add one hand-built manifest fixture to a catalog's built-in directory and refresh.
///
/// Returns the new entry's content digest. The catalog default may move to the new version;
/// callers that need an earlier digest must capture it before adding content.
pub(crate) fn add_builtin_fixture(
  catalog: &PluginCatalog,
  manifest: &PluginManifestV1,
  payloads: &[(String, Vec<u8>)],
) -> String {
  let built_in_dir = catalog
    .config()
    .built_in_dir
    .clone()
    .expect("fixture catalog has a built-in directory");
  std::fs::create_dir_all(&built_in_dir).unwrap();
  write_manifest_fixture_dir(&built_in_dir, manifest, payloads);
  catalog.refresh().expect("catalog refreshes after fixture add");
  catalog
    .find_plugin_version(&manifest.id, &manifest.version)
    .unwrap_or_else(|| {
      panic!(
        "added fixture {}-{} is in the catalog; errors: {:?}",
        manifest.id,
        manifest.version,
        catalog.errors()
      )
    })
    .descriptor
    .content_digest
}

/// Remove one hand-built built-in fixture directory and refresh the catalog.
pub(crate) fn remove_builtin_fixture(catalog: &PluginCatalog, manifest: &PluginManifestV1) -> bool {
  let built_in_dir = catalog
    .config()
    .built_in_dir
    .clone()
    .expect("fixture catalog has a built-in directory");
  let dir = built_in_dir.join(format!("{}-{}", manifest.id.replace('.', "_"), manifest.version));
  let existed = dir.is_dir();
  if existed {
    std::fs::remove_dir_all(&dir).unwrap();
  }
  catalog.refresh().expect("catalog refreshes after fixture removal");
  existed
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fixture_catalog_loads_every_committed_builtin() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let catalog = catalog_with_builtins(db, dir.path(), ALL_BUILTIN_ARCHIVES);
    let mut ids: Vec<String> = catalog
      .descriptors()
      .into_iter()
      .map(|descriptor| descriptor.plugin_id)
      .collect();
    ids.sort();
    let mut expected: Vec<String> = ALL_BUILTIN_PLUGIN_IDS.iter().map(|id| id.to_string()).collect();
    expected.sort();
    assert_eq!(ids, expected);
    for plugin_id in ALL_BUILTIN_PLUGIN_IDS {
      assert_builtin(&catalog, plugin_id);
      assert_eq!(fixture_digest(&catalog, plugin_id).len(), 64);
    }
  }

  #[test]
  fn synthetic_fixture_round_trips_through_directory_and_archive_identity() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let plugin = SyntheticPlugin::new(
      "com.example.synthetic",
      "1.0.0",
      "artifacts/plugin.wasm",
      b"\0asm\x01\0\0\0",
    )
    .with_capability("translate.text@1");
    let catalog = catalog_with_synthetic(db, dir.path(), &[], std::slice::from_ref(&plugin));
    let loaded = load_synthetic(&catalog, &plugin);
    assert_eq!(loaded.descriptor.plugin_id, "com.example.synthetic");
    assert_eq!(loaded.descriptor.capabilities, vec!["translate.text@1".to_string()]);
    assert_eq!(loaded.descriptor.source, PluginSource::BuiltIn);

    let archive = plugin.archive_in(dir.path(), "synthetic");
    let loader = PluginLoader::new(dir.path().join("other-cache"));
    let from_archive = loader.load_archive(PluginSource::User, &archive).unwrap();
    assert_eq!(from_archive.descriptor.content_digest, loaded.descriptor.content_digest);
  }

  #[test]
  fn user_archive_install_round_trips_through_public_store() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let plugin = SyntheticPlugin::new("com.example.user", "1.0.0", "artifacts/plugin.wasm", b"\0asm\x01\0\0\0")
      .with_capability("translate.text@1");
    let archive = plugin.archive_in(dir.path(), "user");
    let store = user_store(db.clone(), dir.path());
    let digest = install_user_archive(&store, &archive);
    let catalog = catalog_with_builtins(db, dir.path(), &[]);
    let entries = catalog.entries().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].descriptor.content_digest, digest);
    assert_eq!(entries[0].descriptor.source, PluginSource::User);
  }
}
