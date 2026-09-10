// ABOUTME: Managed Tauri AppState holding database path, services, and device state.
// ABOUTME: Built during setup after SQLite migration and credential recovery.
#![allow(dead_code)]
use crate::credentials::{CredentialVault, NativeCredentialVault};
use crate::device_state::{DeviceStateManager, SharedDeviceState};
use crate::domain::cancel::RequestSessionRegistry;
use crate::error::StorageError;
use crate::services::google_service_account::GoogleServiceAccountExchanger;
use crate::services::network_broker::NetworkBroker;
use crate::services::plugin_catalog::{PluginCatalog, PluginCatalogConfig};
use crate::services::plugin_store::UserPluginStore;
use crate::services::service_capabilities::ServiceCapabilityService;
use crate::services::token_grant::TokenGrantService;
use crate::services::wasm_runtime::WasmRuntime;
use crate::services::{
  EndpointTrustService, ImportExportService, ModelService, OcrServiceService, PluginModelService, ProviderService,
  RuntimeLifecycleService, RuntimeRouter, ServiceIntegrationRegistry, ServiceIntegrationService, SettingsService,
  SpeechServiceService, TranslationHistoryService, TranslationProfileService,
};
use crate::storage::Database;
use std::path::PathBuf;
use std::sync::Arc;

/// Application-managed storage and device state.
pub struct AppState {
  pub db: Database,
  pub app_data_dir: PathBuf,
  pub providers: ProviderService,
  pub models: ModelService,
  pub profiles: TranslationProfileService,
  pub ocr_services: OcrServiceService,
  pub speech_services: SpeechServiceService,
  /// Source-based plugin catalog: built-in, debug development, and user archives.
  pub catalog: std::sync::Arc<PluginCatalog>,
  /// User archive install/remove store.
  pub user_plugins: UserPluginStore,
  pub plugin_models: PluginModelService,
  pub service_integrations: ServiceIntegrationService,
  pub endpoint_trust: Arc<EndpointTrustService>,
  pub service_capabilities: ServiceCapabilityService,
  pub runtime_router: RuntimeRouter,
  pub runtime_lifecycle: RuntimeLifecycleService,
  pub token_grants: Arc<TokenGrantService>,
  pub network_broker: Arc<NetworkBroker>,
  pub settings: SettingsService,
  pub import_export: ImportExportService,
  pub history: TranslationHistoryService,
  pub device_state: SharedDeviceState,
  /// In-flight request ids → cancel tokens (provider runtime).
  pub request_sessions: Arc<RequestSessionRegistry>,
  /// Shared Wasm Component runtime for external service plugins.
  pub wasm_runtime: Arc<WasmRuntime>,
  /// Provider runtime package catalog and lifecycle (Phase 8).
  pub runtime_providers: crate::services::runtime_providers::ProviderRuntimeService,
  /// Provider runtime binding/package/grant resolution and LLM execution (Phase 8).
  pub provider_runtime_router: crate::services::provider_runtime_router::ProviderRuntimeRouter,
}

impl AppState {
  pub fn initialize(app_data_dir: PathBuf, resource_dir: Option<PathBuf>) -> Result<Self, StorageError> {
    Self::initialize_inner(app_data_dir, resource_dir)
  }

  /// Test-only constructor without bundled resources.
  #[cfg(test)]
  pub fn initialize_for_tests(app_data_dir: PathBuf) -> Result<Self, StorageError> {
    Self::initialize_inner(app_data_dir, None)
  }

  /// Test-only constructor that also discovers built-in archives from `resource_dir`.
  #[cfg(test)]
  pub fn initialize_for_tests_with_resources(
    app_data_dir: PathBuf,
    resource_dir: PathBuf,
  ) -> Result<Self, StorageError> {
    Self::initialize_inner(app_data_dir, Some(resource_dir))
  }

  fn initialize_inner(app_data_dir: PathBuf, resource_dir: Option<PathBuf>) -> Result<Self, StorageError> {
    std::fs::create_dir_all(&app_data_dir)?;
    let db = Database::new(&app_data_dir)?;
    db.initialize()?;

    // Overflow dir holds AES-GCM sealed large secrets (e.g. service-account JSON) when the OS
    // keyring blob limit is too small (Windows Credential Manager is ~2560 bytes).
    let vault: Arc<dyn CredentialVault> = Arc::new(NativeCredentialVault::new(app_data_dir.join("credential-vault")));
    // Recovery is best-effort; vault unavailability is nonfatal at startup.
    // Covers provider/proxy/OCR and integration slots via shared journal.
    let _recovery = ProviderService::recover_credential_operations(&db, vault.as_ref());

    let mut registry = ServiceIntegrationRegistry::empty();
    let resolved_official_plugins_dir = resolve_official_plugins_dir(resource_dir.as_deref())?;
    // Source-based catalog: built-ins from application resources, user archives from app data,
    // and an explicit development directory in debug builds only.
    let catalog = Arc::new(PluginCatalog::new(
      db.clone(),
      PluginCatalogConfig::for_app_data(
        &app_data_dir,
        resolved_official_plugins_dir.clone(),
        cfg!(debug_assertions),
      ),
    ));
    let summary = catalog.refresh()?;
    if catalog.has_builtin_errors() {
      let detail = catalog
        .errors()
        .iter()
        .filter(|error| error.source == crate::domain::plugin_catalog::PluginSource::BuiltIn)
        .map(|error| format!("{}:{}", error.plugin_id, error.code.as_str()))
        .collect::<Vec<_>>()
        .join(",");
      log::error!("builtin_plugin_content_invalid detail={detail}");
      return Err(StorageError::Validation(format!(
        "built-in plugin content failed to load: {detail}"
      )));
    }
    // Project every catalog snapshot into a service definition. A built-in that cannot project
    // fails startup readiness; user content stays isolated and visible as a catalog error.
    let mut rejected_definition_ids: Vec<String> = Vec::new();
    for loaded in catalog.loaded_plugins() {
      let plugin_id = loaded.descriptor.plugin_id.clone();
      let is_builtin = loaded.descriptor.source == crate::domain::plugin_catalog::PluginSource::BuiltIn;
      match crate::services::package_definition::project_loaded_plugin(&loaded) {
        Ok(definition) => {
          if let Err(err) = registry.upsert_package_definition(definition) {
            if is_builtin {
              log::error!("builtin_definition_register_failed plugin={plugin_id} error={err}");
              return Err(StorageError::Validation(format!(
                "built-in package definition registration failed for {plugin_id}: {err}"
              )));
            }
            log::warn!("package_definition_register_failed plugin={plugin_id} error={err}");
            rejected_definition_ids.push(plugin_id);
          }
        }
        Err(err) => {
          if is_builtin {
            log::error!("builtin_definition_projection_failed plugin={plugin_id} error={err}");
            return Err(StorageError::Validation(format!(
              "built-in package definition projection failed for {plugin_id}: {err}"
            )));
          }
          log::warn!("package_definition_projection_failed plugin={plugin_id} error={err}");
          rejected_definition_ids.push(plugin_id);
        }
      }
    }
    rejected_definition_ids.sort();
    rejected_definition_ids.dedup();
    log::info!(
      "plugin_catalog_ready built_in={} development={} user={} invalid={} defaults={} rejected_plugins=[{}]",
      summary.built_in,
      summary.development,
      summary.user,
      summary.invalid,
      summary.defaults,
      rejected_definition_ids.join(",")
    );
    let user_plugins = UserPluginStore::new(db.clone(), app_data_dir.clone(), catalog.loader().clone());
    let registry = Arc::new(registry);
    let exchanger = Arc::new(GoogleServiceAccountExchanger::new(db.clone(), vault.clone()));
    let baidu_exchanger = Arc::new(crate::services::baidu_token_exchanger::BaiduTokenExchanger::new(
      db.clone(),
      vault.clone(),
    ));
    let token_grants =
      Arc::new(TokenGrantService::new(vec![exchanger, baidu_exchanger]).map_err(|err| {
        StorageError::Internal(format!("closed token exchanger registry construction failed: {err}"))
      })?);
    let network_broker = Arc::new(NetworkBroker::new(db.clone(), registry.clone()));
    let models = ModelService::new(db.clone(), vault.clone(), app_data_dir.join("cache"));
    let profiles = TranslationProfileService::new(db.clone(), registry.clone());
    let endpoint_trust = Arc::new(EndpointTrustService::new(db.clone(), registry.clone()));
    let service_integrations =
      ServiceIntegrationService::new(db.clone(), vault.clone(), registry.clone(), token_grants.clone())
        .with_endpoint_trust(endpoint_trust.clone())
        .with_catalog(catalog.clone());
    let import_export =
      ImportExportService::new(db.clone(), vault.clone(), Some(registry.clone())).with_catalog(catalog.clone());
    let settings = SettingsService::new(db.clone(), vault.clone());
    let history = TranslationHistoryService::new(db.clone());
    let device_state = Arc::new(DeviceStateManager::load(&app_data_dir)?);
    let request_sessions = Arc::new(RequestSessionRegistry::new());
    let wasm_runtime = Arc::new(WasmRuntime::new().map_err(|e| StorageError::Internal(e.to_string()))?);
    let runtime_lifecycle = RuntimeLifecycleService::new(db.clone(), catalog.clone(), registry.clone())
      .with_runtime(wasm_runtime.clone(), token_grants.clone())
      .with_vault(vault.clone());
    let runtime_providers = crate::services::runtime_providers::ProviderRuntimeService::new(
      db.clone(),
      catalog.clone(),
      wasm_runtime.clone(),
    );
    let service_integrations = service_integrations.with_runtime_lifecycle(runtime_lifecycle.clone());
    let providers =
      ProviderService::new(db.clone(), vault.clone()).with_runtime_defaults(Arc::new(runtime_providers.clone()));
    // Capability dispatch always goes through the runtime router (no silent executor fallback).
    let runtime_router = RuntimeRouter::new(db.clone(), registry.clone(), catalog.clone(), wasm_runtime.clone());
    // Phase 5: Wasm guests (google-web) reach approved HTTPS origins through a bounded transport
    // via NetworkBrokerHandle. No credentials/cookies/auth headers are ever injected.
    let broker_transport: Arc<dyn crate::services::bounded_http::RawHttpTransport> =
      Arc::new(crate::services::bounded_http::ReqwestRawHttpTransport);
    let wasm_token_grants = token_grants.clone();
    let broker_factory: Arc<dyn Fn() -> Box<dyn crate::services::wasm_runtime::host::BrokerHandle> + Send + Sync> =
      Arc::new(move || {
        Box::new(
          crate::services::wasm_runtime::network_handle::NetworkBrokerHandle::new_with_token_grants(
            broker_transport.clone(),
            wasm_token_grants.clone(),
          ),
        )
      });
    let service_capabilities = ServiceCapabilityService::new(db.clone(), registry.clone())
      .with_catalog(catalog.clone())
      .with_router(runtime_router.clone(), wasm_runtime.clone())
      .with_broker_factory(broker_factory);
    let ocr_services = OcrServiceService::new(
      db.clone(),
      vault.clone(),
      registry.clone(),
      service_capabilities.clone(),
    );
    let speech_services = SpeechServiceService::new(db.clone(), registry.clone(), service_capabilities.clone());
    // Provider-runtime egress resolves ONLY the bound provider instance's persisted connection
    // (Base URL, proxy, host-only credential) after package/grant authorization; it never uses
    // the service-capability network broker or package-selected origins.
    let provider_broker_transport: Arc<dyn crate::services::bounded_http::RawHttpTransport> =
      Arc::new(crate::services::bounded_http::ReqwestRawHttpTransport);
    let provider_broker_vault = vault.clone();
    let provider_broker_db = db.clone();
    let provider_broker_factory: Arc<
      dyn Fn(
          crate::services::provider_runtime_router::ProviderRuntimeBrokerContext,
        ) -> Box<dyn crate::services::wasm_runtime::host::BrokerHandle>
        + Send
        + Sync,
    > = Arc::new(move |context| {
      Box::new(
        crate::services::provider_runtime_broker::ProviderRuntimeBrokerHandle::new(
          provider_broker_db.clone(),
          provider_broker_vault.clone(),
          provider_broker_transport.clone(),
          context,
        ),
      )
    });
    let provider_runtime_router = crate::services::provider_runtime_router::ProviderRuntimeRouter::new(
      db.clone(),
      catalog.clone(),
      wasm_runtime.clone(),
      provider_broker_factory,
    );

    let plugin_models = PluginModelService::with_catalog(db.clone(), app_data_dir.clone(), catalog.clone());
    // Best-effort recovery: wipe incomplete model staging and fail closed in-flight downloads.
    // Completed content-addressed installs under plugin-models/store are preserved.
    if let Err(err) = plugin_models.recover_incomplete_operations() {
      log::error!("plugin_model_recovery_failed error={err}");
    }

    Ok(Self {
      db,
      app_data_dir,
      providers,
      models,
      profiles,
      ocr_services,
      speech_services,
      catalog,
      user_plugins,
      plugin_models,
      service_integrations,
      endpoint_trust,
      service_capabilities,
      runtime_router,
      runtime_lifecycle,
      runtime_providers,
      provider_runtime_router,
      token_grants,
      network_broker,
      settings,
      import_export,
      history,
      device_state,
      request_sessions,
      wasm_runtime,
    })
  }
}

/// Resolve the single built-in plugin resource directory in deterministic layout order.
///
/// Supported layouts, highest priority first:
/// 1. `<resource_dir>/resources/plugins` (real Tauri debug resource layout)
/// 2. `<resource_dir>/plugins` (packaged resource layout)
/// 3. (production only) `CARGO_MANIFEST_DIR/resources/plugins` so a dev binary finds the
///    bundled content that a packaged app reads from its runtime resource dir. Unit tests
///    never scan the real production resources: they receive their own temp resource dir.
fn resolve_official_plugins_dir(resource_dir: Option<&std::path::Path>) -> Result<Option<PathBuf>, StorageError> {
  let mut candidates = Vec::new();
  if let Some(resource_dir) = resource_dir {
    candidates.push(resource_dir.join("resources").join("plugins"));
    candidates.push(resource_dir.join("plugins"));
  }
  if !cfg!(test) {
    candidates.push(
      PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("plugins"),
    );
  }
  Ok(candidates.into_iter().find(|dir| dir.is_dir()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::plugin_catalog::{PluginSource, sha256_hex};
  use std::io::Write;

  const WASM: &[u8] = b"\x00asm\x00\x00\x00";

  fn manifest_json(id: &str, version: &str) -> String {
    let sha = sha256_hex(WASM);
    let bytes = WASM.len();
    format!(
      r#"{{
  "manifestVersion": 1,
  "pluginApiVersion": "1.0",
  "id": "{id}",
  "version": "{version}",
  "runtime": {{ "kind": "wasm-component", "artifact": "artifacts/plugin.wasm" }},
  "files": [
    {{ "path": "artifacts/plugin.wasm", "role": "runtime-artifact", "bytes": {bytes}, "sha256": "{sha}" }}
  ],
  "capabilities": [{{ "id": "translate.text@1" }}],
  "permissions": {{ "network": [], "authPolicies": [] }},
  "ui": {{ "mode": "schema" }}
}}"#
    )
  }

  fn write_builtin_plugin(resource_dir: &std::path::Path, id: &str, version: &str) {
    let dir = resource_dir
      .join("resources")
      .join("plugins")
      .join(format!("{id}-{version}"));
    std::fs::create_dir_all(dir.join("artifacts")).unwrap();
    std::fs::write(dir.join("plugin.json"), manifest_json(id, version)).unwrap();
    let mut artifact = std::fs::File::create(dir.join("artifacts/plugin.wasm")).unwrap();
    artifact.write_all(WASM).unwrap();
  }

  /// Startup loads built-in content from the application resource directory alone. No trust
  /// root, publisher row, or policy resource is required.
  #[test]
  fn startup_loads_builtins_without_trust_root_or_policy_resource() {
    let resources = tempfile::tempdir().unwrap();
    write_builtin_plugin(resources.path(), "com.example.edge", "1.0.0");
    let app_data = tempfile::tempdir().unwrap();

    let state =
      AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf())
        .expect("startup succeeds with built-in content only");

    let entries = state.catalog.entries().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].descriptor.plugin_id, "com.example.edge");
    assert_eq!(entries[0].descriptor.source, PluginSource::BuiltIn);
    assert!(entries[0].is_default, "built-in content is an automatic default");
    assert!(!entries[0].removable);
    assert!(state.catalog.resolve_default("com.example.edge").is_some());
    assert!(state.catalog.errors().is_empty());
    assert!(
      !resources
        .path()
        .join("resources")
        .join("plugins")
        .join("default-activation-policies.json")
        .exists()
    );
  }

  /// Startup without any plugin content still initializes; no publisher or policy resource exists.
  #[test]
  fn startup_without_plugin_content_initializes_with_empty_catalog() {
    let resources = tempfile::tempdir().unwrap();
    let app_data = tempfile::tempdir().unwrap();
    let state =
      AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf())
        .expect("startup succeeds without plugin content");
    assert!(state.catalog.entries().unwrap().is_empty());
    assert!(state.catalog.resolve_default("com.example.edge").is_none());
  }
}
