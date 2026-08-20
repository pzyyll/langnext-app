// ABOUTME: Managed Tauri AppState holding database path, services, and device state.
// ABOUTME: Built during setup after SQLite migration and credential recovery.
use crate::credentials::{CredentialVault, NativeCredentialVault};
use crate::device_state::{DeviceStateManager, SharedDeviceState};
use crate::domain::cancel::RequestSessionRegistry;
use crate::error::StorageError;
use crate::services::bundled_plugins::HandlerDeps;
use crate::services::google_service_account::GoogleServiceAccountExchanger;
use crate::services::network_broker::NetworkBroker;
use crate::services::service_capabilities::ServiceCapabilityService;
use crate::services::token_grant::TokenGrantService;
use crate::services::wasm_runtime::WasmRuntime;
use crate::services::{
  DefaultPackageActivationService, EndpointTrustService, ImportExportService, LegacyRuntimeInventoryService,
  ModelService, OcrServiceService, PluginModelService, PluginPackageService, ProviderHttpService, ProviderService,
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
  pub plugin_packages: PluginPackageService,
  pub default_package_activation: DefaultPackageActivationService,
  pub legacy_runtime_inventory: LegacyRuntimeInventoryService,
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
  /// Generic provider HTTP transport (vault auth injection + raw responses).
  pub provider_http: ProviderHttpService,
  /// In-flight request ids → cancel tokens (provider HTTP).
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
    Self::initialize_inner(app_data_dir, resource_dir, Vec::new())
  }

  /// Test-only constructor with the committed dev fixture vendor root so real signed fixture
  /// packages verify through the genuine package store (no mocked verification paths).
  #[cfg(test)]
  pub fn initialize_for_tests(app_data_dir: PathBuf) -> Result<Self, StorageError> {
    Self::initialize_inner(
      app_data_dir,
      None,
      vec![crate::services::vendor_trust::test_vendor_fixture::fixture_vendor_public_key()],
    )
  }

  fn initialize_inner(
    app_data_dir: PathBuf,
    resource_dir: Option<PathBuf>,
    vendor_roots: Vec<crate::services::vendor_trust::VendorPublicKey>,
  ) -> Result<Self, StorageError> {
    std::fs::create_dir_all(&app_data_dir)?;
    let db = Database::new(&app_data_dir)?;
    db.initialize()?;

    // Overflow dir holds AES-GCM sealed large secrets (e.g. service-account JSON) when the OS
    // keyring blob limit is too small (Windows Credential Manager is ~2560 bytes).
    let vault: Arc<dyn CredentialVault> = Arc::new(NativeCredentialVault::new(app_data_dir.join("credential-vault")));
    // Recovery is best-effort; vault unavailability is nonfatal at startup.
    // Covers provider/proxy/OCR and integration slots via shared journal.
    let _recovery = ProviderService::recover_credential_operations(&db, vault.as_ref());

    let registry = Arc::new(ServiceIntegrationRegistry::bundled()?);
    let exchanger = Arc::new(GoogleServiceAccountExchanger::new(db.clone(), vault.clone()));
    let token_grants = Arc::new(TokenGrantService::new(exchanger));
    let network_broker = Arc::new(NetworkBroker::new(db.clone(), registry.clone()));
    let capability_handlers = Arc::new(crate::services::bundled_plugins::build_capability_registry(
      HandlerDeps {
        db: db.clone(),
        broker: network_broker.clone(),
        tokens: token_grants.clone(),
      },
      &registry,
    )?);

    let models = ModelService::new(db.clone(), vault.clone(), app_data_dir.join("cache"));
    let profiles = TranslationProfileService::new(db.clone(), registry.clone());
    let plugin_packages = if vendor_roots.is_empty() {
      PluginPackageService::new(db.clone(), app_data_dir.clone())
    } else {
      PluginPackageService::with_vendor_roots(db.clone(), app_data_dir.clone(), vendor_roots)
    };
    // Best-effort crash recovery for interrupted package installs/uninstalls (no package execution).
    if let Err(err) = plugin_packages.recover_install_operations() {
      log::error!("plugin_package_recovery_failed error={err}");
    }
    // Idempotently import bundled vendor-signed archives on first startup. Release CI places signed
    // archives at resources/plugins/...; local dev has none (no-op). Import alone never sets a
    // catalog default or activation policy — only the audited policy resource can authorize one.
    let mut bundled_archives = locate_bundled_vendor_packages(resource_dir.as_deref());
    bundled_archives.sort();
    for bundled in &bundled_archives {
      match std::fs::read(bundled) {
        Ok(bytes) => {
          if let Err(err) = plugin_packages.bootstrap_bundled_package(&bytes, false) {
            log::error!(
              "vendor_package_bootstrap_import_failed path={} error={err}",
              bundled.display()
            );
          }
        }
        Err(err) => log::warn!(
          "vendor_package_bootstrap_read_failed path={} error={err}",
          bundled.display()
        ),
      }
    }
    // Active staging/preview TTL sweep while the app is running (stoppable via Drop on process exit).
    let _staging_sweep = plugin_packages.start_staging_sweep();
    // Keep the handle alive for the process lifetime by leaking intentionally: AppState is long-lived
    // and Drop of StagingSweepHandle only signals stop; recovery already ran at startup.
    std::mem::forget(_staging_sweep);
    let endpoint_trust = Arc::new(EndpointTrustService::new(db.clone(), registry.clone()));
    // Shared default-activation service for package-first create and IPC (Phase 11.5).
    let mut default_package_activation =
      DefaultPackageActivationService::create(db.clone(), plugin_packages.clone(), app_data_dir.clone());
    if let Some(resource_dir) = resource_dir.as_ref() {
      let bootstrap_path = resource_dir.join("plugins").join("default-activation-policies.json");
      default_package_activation = default_package_activation.with_vendor_bootstrap_path(bootstrap_path);
    }
    if let Err(err) = default_package_activation.apply_vendor_bootstrap_policies() {
      log::warn!("default_package_vendor_bootstrap_failed error={err}");
    }
    // Recovery is scheduled after subject activators are wired (see below). Count-only log here
    // would miss eligible work; the post-wire path runs recovery without blocking setup.
    let service_integrations =
      ServiceIntegrationService::new(db.clone(), vault.clone(), registry.clone(), token_grants.clone())
        .with_endpoint_trust(endpoint_trust.clone())
        // Same vendor-root re-verify seam as RuntimeRouter for PaddleOCR first-model health.
        .with_plugin_packages(plugin_packages.clone())
        .with_default_package_activation(default_package_activation.clone());
    let settings = SettingsService::new(db.clone(), vault.clone());
    let import_export = ImportExportService::new(db.clone(), vault.clone());
    let history = TranslationHistoryService::new(db.clone());
    let provider_http = ProviderHttpService::new(db.clone(), vault.clone());
    let device_state = Arc::new(DeviceStateManager::load(&app_data_dir)?);
    let request_sessions = Arc::new(RequestSessionRegistry::new());
    let wasm_runtime = Arc::new(WasmRuntime::new().map_err(|e| StorageError::Internal(e.to_string()))?);
    let runtime_lifecycle = RuntimeLifecycleService::new(db.clone(), plugin_packages.clone(), registry.clone())
      .with_runtime(wasm_runtime.clone(), token_grants.clone())
      .with_vault(vault.clone());
    let runtime_providers = crate::services::runtime_providers::ProviderRuntimeService::new(
      db.clone(),
      plugin_packages.clone(),
      wasm_runtime.clone(),
    );
    // Production Phase 12 retirement policy: the ordered three-executor integration slice and
    // the empty provider-adapter allowlist (stable-release evidence gates provider retirement).
    let retirement_gate = crate::services::legacy_runtime_retirement::LegacyRuntimeRetirementGate::production();
    let service_integrations = service_integrations.with_runtime_lifecycle(runtime_lifecycle.clone());
    let service_integrations = service_integrations.with_retirement_gate(retirement_gate.clone());
    let providers = ProviderService::new(db.clone(), vault.clone())
      .with_runtime_defaults(Arc::new(runtime_providers.clone()))
      .with_retirement_gate(retirement_gate.clone());
    // Subject activators are wired after lifecycle/provider runtime exist so package-first
    // activation can dispatch per subject without construction cycles.
    default_package_activation = default_package_activation
      .with_integration_lifecycle(runtime_lifecycle.clone())
      .with_provider_runtime(runtime_providers.clone());
    // Resume only local_creation pending/activating intents; imports stay confirmation-required.
    match default_package_activation.list_recovery_eligible_intents() {
      Ok(intents) if !intents.is_empty() => {
        log::info!("default_package_activation_recovery_pending count={}", intents.len());
        // Setup remains prompt: schedule recovery on the async runtime without awaiting.
        let recovery = default_package_activation.clone();
        let _recovery_task = tauri::async_runtime::spawn_blocking(move || {
          if let Err(err) = recovery.recover_pending_default_runtime_activations() {
            log::warn!("default_package_activation_recovery_failed error={err}");
          }
        });
      }
      Ok(_) => {}
      Err(err) => log::warn!("default_package_activation_recovery_list_failed error={err}"),
    }
    // Read-only retirement inventory with the same production policy and the verified provider
    // catalog. The startup snapshot derives release CANDIDATES: only fully ready slices may
    // stop serving, but live SQLite blockers remain authoritative for execution availability —
    // an enabled active legacy row keeps its bundled executor even if it appears after startup.
    let legacy_runtime_inventory =
      LegacyRuntimeInventoryService::create(db.clone(), default_package_activation.clone())
        .with_retirement_gate(retirement_gate)
        .with_provider_runtime(Arc::new(runtime_providers.clone()));
    let release_gate = match legacy_runtime_inventory.list_inventory() {
      Ok(report) => crate::services::legacy_runtime_retirement::LegacyRuntimeReleaseGate::with_released(
        report
          .entries
          .iter()
          .filter(|entry| entry.retirement_ready)
          .map(|entry| entry.executor_id.clone()),
      ),
      Err(err) => {
        log::warn!("legacy_runtime_release_gate_derivation_failed error={err}");
        crate::services::legacy_runtime_retirement::LegacyRuntimeReleaseGate::empty()
      }
    };
    let runtime_router = RuntimeRouter::new(
      db.clone(),
      registry.clone(),
      capability_handlers.clone(),
      plugin_packages.clone(),
      wasm_runtime.clone(),
    )
    .with_release_gate(release_gate);
    // Capability dispatch always goes through the runtime router (no silent executor fallback).
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
    let service_capabilities = ServiceCapabilityService::new(db.clone(), registry.clone(), capability_handlers)
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
      plugin_packages.clone(),
      wasm_runtime.clone(),
      provider_broker_factory,
    );

    let plugin_models = PluginModelService::with_packages(db.clone(), app_data_dir.clone(), plugin_packages.clone());
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
      plugin_packages,
      default_package_activation,
      legacy_runtime_inventory,
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
      provider_http,
      request_sessions,
      wasm_runtime,
    })
  }
}

/// Bundled Google Translate Web package filename prefix (release CI signs and places archives as
/// resources). Both 1.0.0 GTX and 1.1.0 proxy archives may be present.
const BUNDLED_GOOGLE_WEB_PACKAGE_PREFIX: &str = "com.langnext.google-translate-web-";
/// Bundled Edge TTS package filename prefix.
const BUNDLED_EDGE_TTS_PACKAGE_PREFIX: &str = "com.langnext.edge-tts-";
/// Bundled Google Cloud package filename prefix; imported for discovery only, never auto-pinned.
const BUNDLED_GOOGLE_CLOUD_PACKAGE_PREFIX: &str = "com.langnext.google-cloud-";
/// Bundled OpenAI Compatible provider package filename prefix (Phase 8 Task 12): release CI
/// places the externally signed archive at `resources/plugins/`; the app imports it and
/// resolves it as the reviewed default for NEW matching Providers only.
const BUNDLED_OPENAI_COMPATIBLE_PACKAGE_PREFIX: &str = "com.langnext.provider.openai-compatible-";
const BUNDLED_VENDOR_PACKAGE_SUFFIX: &str = ".lnplugin";
/// Env override pointing at a single bundled signed package (release/CI/test injection).
const BUNDLED_GOOGLE_WEB_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_GOOGLE_WEB_PACKAGE";
const BUNDLED_EDGE_TTS_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_EDGE_TTS_PACKAGE";
const BUNDLED_GOOGLE_CLOUD_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_GOOGLE_CLOUD_PACKAGE";
const BUNDLED_OPENAI_COMPATIBLE_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_OPENAI_COMPATIBLE_PACKAGE";
const BUNDLED_PADDLEOCR_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_PADDLEOCR_PACKAGE";
/// Vendor default version explicitly selected as the new-provider default after all bundled
/// archives are imported. Must match the verified installed manifest version.
/// Bundled/smoke PaddleOCR package filename prefix (Phase 10).
const BUNDLED_PADDLEOCR_PACKAGE_PREFIX: &str = "com.langnext.paddleocr-";

/// Locate bundled vendor-signed `.lnplugin` archives (Google Web, Edge TTS, and Google Cloud) to
/// import on first startup. Checks env overrides, the cargo resources dir (dev/test), and `resources/plugins` /
/// `plugins` paths beside the resource root. Returns an empty vec when no bundled archive is
/// present (local dev).
fn locate_bundled_vendor_packages(resource_dir: Option<&std::path::Path>) -> Vec<std::path::PathBuf> {
  let mut archives = Vec::new();
  for env_key in [
    BUNDLED_GOOGLE_WEB_PACKAGE_ENV,
    BUNDLED_EDGE_TTS_PACKAGE_ENV,
    BUNDLED_GOOGLE_CLOUD_PACKAGE_ENV,
    BUNDLED_OPENAI_COMPATIBLE_PACKAGE_ENV,
    BUNDLED_PADDLEOCR_PACKAGE_ENV,
  ] {
    if let Ok(path) = std::env::var(env_key) {
      let path = std::path::PathBuf::from(path);
      if path.is_file() {
        archives.push(path);
      }
    }
  }
  if !archives.is_empty() {
    return archives;
  }

  let mut dirs = Vec::new();
  if let Some(resource_dir) = resource_dir {
    dirs.push(resource_dir.join("resources").join("plugins"));
    dirs.push(resource_dir.join("plugins"));
  }
  dirs.push(crate::services::vendor_trust::cargo_resources_root().join("plugins"));

  for dir in &dirs {
    let Ok(entries) = std::fs::read_dir(dir) else {
      continue;
    };
    for entry in entries.flatten() {
      let path = entry.path();
      if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        let is_vendor = (name.starts_with(BUNDLED_GOOGLE_WEB_PACKAGE_PREFIX)
          || name.starts_with(BUNDLED_EDGE_TTS_PACKAGE_PREFIX)
          || name.starts_with(BUNDLED_GOOGLE_CLOUD_PACKAGE_PREFIX)
          || name.starts_with(BUNDLED_OPENAI_COMPATIBLE_PACKAGE_PREFIX)
          || name.starts_with(BUNDLED_PADDLEOCR_PACKAGE_PREFIX))
          && name.ends_with(BUNDLED_VENDOR_PACKAGE_SUFFIX)
          && path.is_file();
        if is_vendor {
          archives.push(path);
        }
      }
    }
  }
  archives
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::provider::{
    AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode,
  };
  use crate::domain::runtime_provider::ProviderRuntimeKind;
  use crate::domain::service_integration::{
    GOOGLE_TRANSLATE_WEB_PLUGIN_ID, IntegrationInstanceWrite, PADDLEOCR_PLUGIN_ID,
  };

  fn integration_write(plugin_id: &str) -> IntegrationInstanceWrite {
    IntegrationInstanceWrite {
      id: None,
      plugin_id: plugin_id.into(),
      display_name: "production gate fixture".into(),
      enabled: true,
      // Google Web expects `channel`; PaddleOCR expects an empty config shape.
      config_json: if plugin_id == GOOGLE_TRANSLATE_WEB_PLUGIN_ID {
        r#"{"channel":"gtx"}"#.into()
      } else {
        "{}".into()
      },
      credentials: vec![],
      expected_updated_at: None,
      endpoint_trust_preview_id: None,
      acknowledge_endpoint_trust: false,
    }
  }

  fn provider_write() -> ProviderInstanceWrite {
    ProviderInstanceWrite {
      id: None,
      adapter_id: "openai-compatible".into(),
      display_name: "production gate provider".into(),
      base_url: "https://api.openai.com/v1".into(),
      base_url_source: BaseUrlSource::PluginDefault,
      auth_scheme: AuthSchemeV1::none(),
      credential_kind: CredentialKind::None,
      credential: CredentialUpdate::Keep,
      enabled: true,
      proxy_mode: ProxyMode::Inherit,
      insecure_http_confirmed_at: None,
      expected_updated_at: None,
    }
  }

  /// Production wiring rejects new in-scope legacy integration creation when no authorized
  /// package-first path exists (Google Translate Web is the first slice of the ordered set).
  #[test]
  fn production_retirement_gate_blocks_in_scope_integration_create() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::initialize_for_tests(dir.path().to_path_buf()).unwrap();
    let before = state.service_integrations.list_instances().unwrap().len();
    let err = state
      .service_integrations
      .save(integration_write(GOOGLE_TRANSLATE_WEB_PLUGIN_ID))
      .expect_err("production policy blocks in-scope legacy create without an authorized default");
    assert!(err.to_string().contains("retired"), "got {err}");
    assert_eq!(state.service_integrations.list_instances().unwrap().len(), before);
  }

  /// PaddleOCR is not in the production retirement scope and keeps its dual-stack create path.
  #[test]
  fn production_retirement_gate_keeps_paddleocr_dual_stack() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::initialize_for_tests(dir.path().to_path_buf()).unwrap();
    let saved = state
      .service_integrations
      .save(integration_write(PADDLEOCR_PLUGIN_ID))
      .expect("paddleocr legacy create stays dual-stack");
    assert_eq!(
      saved.runtime_kind, "bundled-rust",
      "no package-first default in the fixture"
    );
    assert!(saved.package_digest.is_none());
  }

  /// The production provider adapter allowlist is empty until stable-release evidence names an
  /// adapter: legacy provider create remains available.
  #[test]
  fn production_retirement_gate_keeps_provider_legacy_until_allowlist_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::initialize_for_tests(dir.path().to_path_buf()).unwrap();
    let saved = state
      .providers
      .save(provider_write())
      .expect("provider legacy create remains available with an empty allowlist");
    assert!(
      saved
        .runtime_bindings
        .iter()
        .any(|binding| binding.runtime_kind == ProviderRuntimeKind::LegacyFrontendProvider),
      "legacy frontend binding created"
    );
  }
}
