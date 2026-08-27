// ABOUTME: Managed Tauri AppState holding database path, services, and device state.
// ABOUTME: Built during setup after SQLite migration and credential recovery.
#![allow(dead_code)]
use crate::credentials::{CredentialVault, NativeCredentialVault};
use crate::device_state::{DeviceStateManager, SharedDeviceState};
use crate::domain::cancel::RequestSessionRegistry;
use crate::error::StorageError;
use crate::services::default_package_activation::OfficialBundleIdentity;
use crate::services::google_service_account::GoogleServiceAccountExchanger;
use crate::services::network_broker::NetworkBroker;
use crate::services::service_capabilities::ServiceCapabilityService;
use crate::services::token_grant::TokenGrantService;
use crate::services::wasm_runtime::WasmRuntime;
use crate::services::{
  DefaultPackageActivationService, EndpointTrustService, ImportExportService, ModelService, OcrServiceService,
  PluginModelService, PluginPackageService, ProviderService, RuntimeLifecycleService, RuntimeRouter,
  ServiceIntegrationRegistry, ServiceIntegrationService, SettingsService, SpeechServiceService,
  TranslationHistoryService, TranslationProfileService,
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

  /// Test-only constructor that also imports bundled archives from `resource_dir`.
  #[cfg(test)]
  pub fn initialize_for_tests_with_resources(
    app_data_dir: PathBuf,
    resource_dir: PathBuf,
  ) -> Result<Self, StorageError> {
    Self::initialize_inner(
      app_data_dir,
      Some(resource_dir),
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

    let mut registry = ServiceIntegrationRegistry::empty();
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
    // One resolved plugin directory owns BOTH archive discovery and the policy path so a debug
    // vs packaged layout mismatch cannot produce a split archive/policy bundle.
    let resolved_official_plugins_dir = resolve_official_plugins_dir(resource_dir.as_deref())?;
    let mut bundled_archives = locate_bundled_vendor_packages(resolved_official_plugins_dir.as_deref());
    bundled_archives.sort();
    // Exact identities of the discovered official archives, used by the vendor bootstrap startup
    // invariant to require every default matches the official bundle. A present official archive
    // that fails to read or import fails startup readiness instead of silently vanishing.
    let mut official_bundle_identities: Vec<OfficialBundleIdentity> = Vec::new();
    for bundled in &bundled_archives {
      match std::fs::read(bundled) {
        Ok(bytes) => match plugin_packages.bootstrap_bundled_package(&bytes, false) {
          Ok(import) => official_bundle_identities.push(OfficialBundleIdentity {
            plugin_id: import.plugin_id().to_string(),
            package_digest: import.package_digest().to_string(),
          }),
          Err(err) => {
            log::error!(
              "official_vendor_bundle_import_failed path={} error={err}",
              bundled.display()
            );
            return Err(StorageError::Internal(format!(
              "official vendor bundle archive import failed: {} ({err})",
              bundled.display()
            )));
          }
        },
        Err(err) => {
          log::error!(
            "official_vendor_bundle_read_failed path={} error={err}",
            bundled.display()
          );
          return Err(StorageError::Internal(format!(
            "official vendor bundle archive is unreadable: {} ({err})",
            bundled.display()
          )));
        }
      }
    }
    // Active staging/preview TTL sweep while the app is running (stoppable via Drop on process exit).
    let _staging_sweep = plugin_packages.start_staging_sweep();
    // Keep the handle alive for the process lifetime by leaking intentionally: AppState is long-lived
    // and Drop of StagingSweepHandle only signals stop; recovery already ran at startup.
    std::mem::forget(_staging_sweep);
    let mut rejected_definition_ids: Vec<String> = Vec::new();
    let official_ids: std::collections::HashSet<String> = official_bundle_identities
      .iter()
      .map(|identity| identity.plugin_id.clone())
      .collect();
    match plugin_packages.project_installed_service_definitions() {
      Ok(definitions) => {
        let projected_ids: std::collections::HashSet<String> = definitions
          .iter()
          .map(|definition| definition.manifest.id.clone())
          .collect();
        for definition in &definitions {
          let plugin_id = definition.manifest.id.clone();
          if let Err(err) = registry.upsert_package_definition(definition.clone()) {
            // Official built-ins must never silently vanish: their registration failure is an
            // aggregate startup readiness failure. User-installed invalid packages stay
            // isolated and visible as package errors.
            if official_ids.contains(&plugin_id) {
              log::error!("official_package_definition_register_failed plugin={plugin_id} error={err}");
              return Err(StorageError::Validation(format!(
                "official package definition registration failed for {plugin_id}: {err}"
              )));
            }
            log::warn!("package_definition_register_failed plugin={plugin_id} error={err}");
            rejected_definition_ids.push(plugin_id);
          }
        }
        // Every official archive must project a definition; a package that verifies but cannot
        // project (unknown host policy, invalid schema) fails the official readiness invariant.
        for identity in &official_bundle_identities {
          if !projected_ids.contains(&identity.plugin_id) {
            log::error!("official_package_definition_unavailable plugin={}", identity.plugin_id);
            return Err(StorageError::Validation(format!(
              "official package definition is unavailable for {}",
              identity.plugin_id
            )));
          }
        }
      }
      Err(err) => {
        log::error!("package_definition_list_failed error={err}");
        if !official_ids.is_empty() {
          return Err(StorageError::Validation(format!(
            "official package definition projection failed: {err}"
          )));
        }
      }
    }
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
    // Shared default-activation service for package-first create and IPC (Phase 11.5).
    let mut default_package_activation =
      DefaultPackageActivationService::create(db.clone(), plugin_packages.clone(), app_data_dir.clone());
    if let Some(plugins_dir) = resolved_official_plugins_dir.as_ref() {
      // Presence of the resolved official bundle activates the startup readiness invariant: the
      // policy resource beside the archives must be complete and authorize every official default.
      default_package_activation = default_package_activation
        .with_official_resource_bundle(plugins_dir.clone(), official_bundle_identities.clone());
      default_package_activation =
        default_package_activation.with_vendor_bootstrap_path(plugins_dir.join(DEFAULT_ACTIVATION_POLICIES_FILE));
    }
    if let Err(err) = default_package_activation.apply_vendor_bootstrap_policies() {
      log::error!("default_package_vendor_bootstrap_failed error={err}");
      return Err(err);
    }
    // One sanitized startup summary logged after the official bootstrap invariant passes: installed
    // count, definition count, authorized-default count, and rejected plugin IDs. Never logs
    // credentials or package contents.
    rejected_definition_ids.sort();
    rejected_definition_ids.dedup();
    let installed_count = plugin_packages
      .list_versions()
      .map(|versions| versions.len())
      .unwrap_or(0);
    let definition_count = registry.list_definitions().len();
    let authorized_default_count = db
      .read(|conn| crate::repositories::installed_plugin_versions::list_defaults(conn))
      .map(|defaults| defaults.len())
      .unwrap_or(0);
    log::info!(
      "official_plugin_startup_ready installed={installed_count} definitions={definition_count} authorized_defaults={authorized_default_count} rejected_plugins=[{}]",
      rejected_definition_ids.join(",")
    );
    // Recovery is scheduled after subject activators are wired (see below). Count-only log here
    // would miss eligible work; the post-wire path runs recovery without blocking setup.
    let service_integrations =
      ServiceIntegrationService::new(db.clone(), vault.clone(), registry.clone(), token_grants.clone())
        .with_endpoint_trust(endpoint_trust.clone())
        // Same vendor-root re-verify seam as RuntimeRouter for PaddleOCR first-model health.
        .with_plugin_packages(plugin_packages.clone())
        .with_default_package_activation(default_package_activation.clone());
    let settings = SettingsService::new(db.clone(), vault.clone());
    let import_export = ImportExportService::new(db.clone(), vault.clone(), Some(registry.clone()));
    let history = TranslationHistoryService::new(db.clone());
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
    let service_integrations = service_integrations.with_runtime_lifecycle(runtime_lifecycle.clone());
    let providers =
      ProviderService::new(db.clone(), vault.clone()).with_runtime_defaults(Arc::new(runtime_providers.clone()));
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
    // Capability dispatch always goes through the runtime router (no silent executor fallback).
    let runtime_router = RuntimeRouter::new(
      db.clone(),
      registry.clone(),
      plugin_packages.clone(),
      wasm_runtime.clone(),
    );
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

const BUNDLED_VENDOR_PACKAGE_SUFFIX: &str = ".lnplugin";
/// Official activation policy resource file that must live beside the official archives.
const DEFAULT_ACTIVATION_POLICIES_FILE: &str = "default-activation-policies.json";
/// Env override pointing at a single bundled signed package (release/CI/test injection).
const BUNDLED_GOOGLE_WEB_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_GOOGLE_WEB_PACKAGE";
const BUNDLED_EDGE_TTS_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_EDGE_TTS_PACKAGE";
const BUNDLED_GOOGLE_CLOUD_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_GOOGLE_CLOUD_PACKAGE";
const BUNDLED_OPENAI_COMPATIBLE_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_OPENAI_COMPATIBLE_PACKAGE";
const BUNDLED_OPENAI_RESPONSES_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_OPENAI_RESPONSES_PACKAGE";
const BUNDLED_ANTHROPIC_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_ANTHROPIC_PACKAGE";
const BUNDLED_GEMINI_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_GEMINI_PACKAGE";
const BUNDLED_DEEPSEEK_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_DEEPSEEK_PACKAGE";
const BUNDLED_PADDLEOCR_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_PADDLEOCR_PACKAGE";
const BUNDLED_BAIDU_OCR_PACKAGE_ENV: &str = "LANGNEXT_BUNDLED_BAIDU_OCR_PACKAGE";

fn bundled_vendor_package_env_keys() -> &'static [&'static str] {
  &[
    BUNDLED_GOOGLE_WEB_PACKAGE_ENV,
    BUNDLED_EDGE_TTS_PACKAGE_ENV,
    BUNDLED_GOOGLE_CLOUD_PACKAGE_ENV,
    BUNDLED_OPENAI_COMPATIBLE_PACKAGE_ENV,
    BUNDLED_OPENAI_RESPONSES_PACKAGE_ENV,
    BUNDLED_ANTHROPIC_PACKAGE_ENV,
    BUNDLED_GEMINI_PACKAGE_ENV,
    BUNDLED_DEEPSEEK_PACKAGE_ENV,
    BUNDLED_PADDLEOCR_PACKAGE_ENV,
    BUNDLED_BAIDU_OCR_PACKAGE_ENV,
  ]
}

fn is_bundled_vendor_archive_name(name: &str) -> bool {
  crate::services::plugin_release_bundle::REQUIRED_OFFICIAL_RELEASE_PACKAGES
    .iter()
    .any(|spec| name.starts_with(&format!("{}-", spec.plugin_id)) && name.ends_with(BUNDLED_VENDOR_PACKAGE_SUFFIX))
}

/// Resolve the single official plugin resource directory in deterministic layout order.
///
/// Supported layouts, highest priority first:
/// 1. `<resource_dir>/resources/plugins` (real Tauri debug resource layout)
/// 2. `<resource_dir>/plugins` (packaged resource layout)
/// 3. (production only) `CARGO_MANIFEST_DIR/resources/plugins` so a dev binary finds the
///    bundled archives that a packaged app reads from its runtime resource dir. Unit tests
///    never scan the real production resources: they receive their own temp resource dir.
///
/// Both official archive discovery and the activation policy path derive from the ONE returned
/// directory. A split bundle that mixes archives from one layout with a policy from another is
/// rejected instead of silently assembled.
fn resolve_official_plugins_dir(resource_dir: Option<&std::path::Path>) -> Result<Option<PathBuf>, StorageError> {
  let mut candidates = Vec::new();
  if let Some(resource_dir) = resource_dir {
    candidates.push(resource_dir.join("resources").join("plugins"));
    candidates.push(resource_dir.join("plugins"));
  }
  if !cfg!(test) {
    candidates.push(crate::services::vendor_trust::cargo_resources_root().join("plugins"));
  }
  let existing: Vec<PathBuf> = candidates.into_iter().filter(|dir| dir.is_dir()).collect();
  let Some(plugins_dir) = existing.first() else {
    return Ok(None);
  };
  // Reject a split bundle: the official archives and the activation policy must come from one
  // directory. If a lower-priority directory alone holds the policy while the resolved layout
  // does not, fail rather than assemble a bundle from two layouts.
  let policy_here = plugins_dir.join(DEFAULT_ACTIVATION_POLICIES_FILE);
  for candidate in existing.iter().skip(1) {
    let policy_there = candidate.join(DEFAULT_ACTIVATION_POLICIES_FILE);
    if !policy_here.is_file() && policy_there.is_file() {
      return Err(StorageError::Validation(format!(
        "split official resource bundle: archives in {} but policy in {}",
        plugins_dir.display(),
        candidate.display()
      )));
    }
  }
  Ok(Some(plugins_dir.clone()))
}

/// Locate bundled vendor-signed `.lnplugin` archives for every official package.
///
/// Env overrides point at single signed packages (release/CI/test injection) and remain
/// explicit and deterministic; they bypass directory scanning. Otherwise archives come from the
/// one resolved plugins directory. Import never authorizes a default; only the audited policy
/// resource can.
fn locate_bundled_vendor_packages(plugins_dir: Option<&std::path::Path>) -> Vec<std::path::PathBuf> {
  let mut archives = Vec::new();
  for env_key in bundled_vendor_package_env_keys() {
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
  let Some(plugins_dir) = plugins_dir else {
    return archives;
  };
  let Ok(entries) = std::fs::read_dir(plugins_dir) else {
    return archives;
  };
  for entry in entries.flatten() {
    let path = entry.path();
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
      if is_bundled_vendor_archive_name(name) && path.is_file() {
        archives.push(path);
      }
    }
  }
  archives
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::default_package_activation::DefaultPackageAuthorizationStatus;
  use crate::domain::first_party_plugins::OPENAI_COMPATIBLE_PLUGIN_ID;
  use crate::domain::provider::{
    AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode,
  };
  use crate::domain::service_integration::{
    BAIDU_OCR_PLUGIN_ID, GOOGLE_TRANSLATE_WEB_PLUGIN_ID, IntegrationHealthStatus, IntegrationInstanceWrite,
    PADDLEOCR_PLUGIN_ID,
  };
  use crate::services::plugin_package::test_support::{build_signed_package_with_key, sample_manifest};
  use crate::services::plugin_release_bundle::{REQUIRED_OFFICIAL_RELEASE_PACKAGES, generate_bootstrap_policy_entry};
  use crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID;
  use crate::services::vendor_trust::test_vendor_fixture::{
    fixture_vendor_fingerprint, fixture_vendor_public_key_hex, fixture_vendor_signing_key,
  };

  fn integration_write(plugin_id: &str) -> IntegrationInstanceWrite {
    IntegrationInstanceWrite {
      id: None,
      plugin_id: plugin_id.into(),
      display_name: "production gate fixture".into(),
      enabled: true,
      // The synthetic test archives project an empty v1 config schema, so the config is `{}`
      // for every plugin id (the default-package gate must reject before schema concerns).
      config_json: "{}".into(),
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

  /// Package-first wiring rejects new integration creation when no authorized default package
  /// exists: no bundled-rust instance is ever created. Installed packages still project their
  /// definitions into the registry, so the fail-closed error is the default-package gate, not
  /// a missing plugin. With the complete official bundle every default is authorized; removing
  /// one plugin's authorization must re-gate its create.
  #[test]
  fn package_only_blocks_integration_create_without_authorized_default() {
    let resources = tempfile::tempdir().unwrap();
    write_official_resource_bundle(resources.path(), true);
    let dir = tempfile::tempdir().unwrap();
    let state =
      AppState::initialize_for_tests_with_resources(dir.path().to_path_buf(), resources.path().to_path_buf()).unwrap();
    let digest = state
      .plugin_packages
      .list_versions()
      .unwrap()
      .into_iter()
      .find(|version| version.plugin_id == GOOGLE_TRANSLATE_WEB_PLUGIN_ID)
      .expect("google translate archive imported")
      .package_digest;
    state
      .db
      .transaction(|uow| {
        crate::repositories::installed_plugin_versions::clear_default_if_matches(uow.conn(), &digest)?;
        crate::repositories::default_package_activation_policies::delete_policy_if_digest_matches(uow.conn(), &digest)?;
        Ok(())
      })
      .unwrap();
    let before = state.service_integrations.list_instances().unwrap().len();
    let err = state
      .service_integrations
      .save(integration_write(GOOGLE_TRANSLATE_WEB_PLUGIN_ID))
      .expect_err("package-first create without an authorized default must fail");
    assert!(err.to_string().contains("default package"), "got {err}");
    assert_eq!(state.service_integrations.list_instances().unwrap().len(), before);
  }

  /// PaddleOCR create is also package-first: without an authorized default, save fails closed
  /// instead of creating a bundled-rust row.
  #[test]
  fn paddleocr_create_requires_authorized_default_package() {
    let resources = tempfile::tempdir().unwrap();
    write_official_resource_bundle(resources.path(), true);
    let dir = tempfile::tempdir().unwrap();
    let state =
      AppState::initialize_for_tests_with_resources(dir.path().to_path_buf(), resources.path().to_path_buf()).unwrap();
    let digest = state
      .plugin_packages
      .list_versions()
      .unwrap()
      .into_iter()
      .find(|version| version.plugin_id == PADDLEOCR_PLUGIN_ID)
      .expect("paddleocr archive imported")
      .package_digest;
    state
      .db
      .transaction(|uow| {
        crate::repositories::installed_plugin_versions::clear_default_if_matches(uow.conn(), &digest)?;
        crate::repositories::default_package_activation_policies::delete_policy_if_digest_matches(uow.conn(), &digest)?;
        Ok(())
      })
      .unwrap();
    let before = state.service_integrations.list_instances().unwrap().len();
    let err = state
      .service_integrations
      .save(integration_write(PADDLEOCR_PLUGIN_ID))
      .expect_err("paddleocr create is package-first");
    assert!(err.to_string().contains("default package"), "got {err}");
    assert_eq!(state.service_integrations.list_instances().unwrap().len(), before);
  }

  /// Provider create without an authorized default fails closed with a package-first message.
  #[test]
  fn provider_create_requires_authorized_default_package() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::initialize_for_tests(dir.path().to_path_buf()).unwrap();
    let err = state
      .providers
      .save(provider_write())
      .expect_err("provider create without an authorized default must fail");
    assert!(err.to_string().contains("default package"), "got {err}");
  }

  fn official_vendor_package(plugin_id: &str, version: &str) -> (Vec<u8>, String) {
    let wasm = b"\0asm\x01\x00\x00\x00";
    let mut manifest = sample_manifest(wasm);
    manifest.id = plugin_id.to_string();
    manifest.version = version.to_string();
    manifest.publisher.key_id = VENDOR_PUBLISHER_KEY_ID.into();
    manifest.publisher.key_fingerprint = fixture_vendor_fingerprint();
    let bytes = build_signed_package_with_key(
      &manifest,
      &[("artifacts/plugin.wasm", wasm.as_slice())],
      &fixture_vendor_signing_key(),
    );
    let digest = crate::services::plugin_package::hash_archive_bytes(&bytes);
    (bytes, digest)
  }

  /// Real-shaped openai-compatible provider package: declares `provider_runtime` with the
  /// `openai-compatible` legacy alias, both frozen LLM capabilities, and the host
  /// provider-instance auth policy. Mirrors the runtime-provider test fixture so provider
  /// default resolution sees a provider declaration instead of `None`.
  fn official_provider_vendor_package(plugin_id: &str, version: &str) -> (Vec<u8>, String) {
    use crate::domain::runtime_plugin::{
      CapabilityDeclaration, FileRole, HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID,
      PROVIDER_RUNTIME_ENDPOINT_FORM_PROVIDER_INSTANCE, PluginFileEntry, ProviderRuntimeDeclaration,
      ProviderRuntimeEndpointDecl,
    };
    use crate::services::plugin_package::public_sha256_hex;
    let wasm = b"\0asm\x01\x00\x00\x00";
    let models_path = "artifacts/llm-models.wasm";
    let chat_path = "artifacts/llm-chat.wasm";
    let mut files = vec![
      PluginFileEntry {
        path: models_path.into(),
        role: FileRole::RuntimeArtifact,
        bytes: wasm.len() as u64,
        sha256: public_sha256_hex(wasm),
      },
      PluginFileEntry {
        path: chat_path.into(),
        role: FileRole::RuntimeArtifact,
        bytes: wasm.len() as u64,
        sha256: public_sha256_hex(wasm),
      },
    ];
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut manifest = sample_manifest(wasm);
    manifest.id = plugin_id.to_string();
    manifest.version = version.to_string();
    manifest.publisher.key_id = VENDOR_PUBLISHER_KEY_ID.into();
    manifest.publisher.key_fingerprint = fixture_vendor_fingerprint();
    manifest.files = files;
    manifest.runtime.artifact = Some(models_path.into());
    manifest.capabilities = vec![
      CapabilityDeclaration {
        id: "llm.models.list@1".into(),
        preferences_schema: None,
        artifact: Some(models_path.into()),
      },
      CapabilityDeclaration {
        id: "llm.chat@1".into(),
        preferences_schema: None,
        artifact: Some(chat_path.into()),
      },
    ];
    manifest.permissions.auth_policies = vec![HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID.into()];
    manifest.provider_runtime = Some(ProviderRuntimeDeclaration {
      legacy_aliases: vec!["openai-compatible".into()],
      capabilities: std::collections::BTreeMap::from([
        ("llm.models.list@1".to_string(), models_path.to_string()),
        ("llm.chat@1".to_string(), chat_path.to_string()),
      ]),
      endpoint: ProviderRuntimeEndpointDecl {
        form: PROVIDER_RUNTIME_ENDPOINT_FORM_PROVIDER_INSTANCE.into(),
        auth_policy: HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID.into(),
      },
      detection: None,
    });
    let bytes = build_signed_package_with_key(
      &manifest,
      &[(models_path, wasm.as_slice()), (chat_path, wasm.as_slice())],
      &fixture_vendor_signing_key(),
    );
    let digest = crate::services::plugin_package::hash_archive_bytes(&bytes);
    (bytes, digest)
  }

  /// Write the official bundle under `<resource_dir>/plugins` (packaged layout).
  fn write_official_resource_bundle(resource_dir: &std::path::Path, include_policies: bool) -> Vec<(String, String)> {
    write_official_resource_bundle_in(resource_dir, "plugins", include_policies)
  }

  /// Write the official bundle under `<resource_dir>/<sub_path>` (e.g. the real Tauri debug
  /// `resources/plugins` layout) and return the exact imported package identities.
  fn write_official_resource_bundle_in(
    resource_dir: &std::path::Path,
    sub_path: &str,
    include_policies: bool,
  ) -> Vec<(String, String)> {
    let plugins = resource_dir.join(sub_path);
    std::fs::create_dir_all(&plugins).unwrap();
    write_official_bundle_contents(&plugins, include_policies)
  }

  /// Write archives and the activation policy file into one plugin directory.
  /// Write the official bundle with the REAL-SHAPED Baidu archive (auth policy + credential
  /// slots + fixed endpoints/path authority) replacing the synthetic Baidu fixture. Returns
  /// the exact imported package identities.
  fn write_official_bundle_with_baidu_shape(
    resource_dir: &std::path::Path,
    sub_path: &str,
    baidu_bytes: Vec<u8>,
  ) -> Vec<(String, String)> {
    write_official_bundle_with_shapes(resource_dir, sub_path, baidu_bytes, false)
  }

  /// Real-shaped bundle variant whose openai-compatible package declares a provider runtime,
  /// so a provider create can resolve an applicable authorized default through the public seam.
  fn write_official_bundle_with_baidu_and_provider_shape(
    resource_dir: &std::path::Path,
    sub_path: &str,
    baidu_bytes: Vec<u8>,
  ) -> Vec<(String, String)> {
    write_official_bundle_with_shapes(resource_dir, sub_path, baidu_bytes, true)
  }

  fn write_official_bundle_with_shapes(
    resource_dir: &std::path::Path,
    sub_path: &str,
    baidu_bytes: Vec<u8>,
    openai_is_provider: bool,
  ) -> Vec<(String, String)> {
    let plugins = resource_dir.join(sub_path);
    std::fs::create_dir_all(&plugins).unwrap();
    let mut identities = Vec::new();
    let mut policies = Vec::new();
    for spec in REQUIRED_OFFICIAL_RELEASE_PACKAGES {
      let (bytes, digest) = if spec.plugin_id == crate::domain::service_integration::BAIDU_OCR_PLUGIN_ID {
        let digest = crate::services::plugin_package::hash_archive_bytes(&baidu_bytes);
        (baidu_bytes.clone(), digest)
      } else if openai_is_provider && spec.plugin_id == OPENAI_COMPATIBLE_PLUGIN_ID {
        official_provider_vendor_package(spec.plugin_id, spec.expected_version)
      } else {
        official_vendor_package(spec.plugin_id, spec.expected_version)
      };
      std::fs::write(
        plugins.join(format!("{}-{}.lnplugin", spec.plugin_id, spec.expected_version)),
        &bytes,
      )
      .unwrap();
      policies.push(generate_bootstrap_policy_entry(&bytes, &fixture_vendor_public_key_hex()).unwrap());
      identities.push((spec.plugin_id.to_string(), digest));
    }
    std::fs::write(
      plugins.join("default-activation-policies.json"),
      serde_json::to_vec_pretty(&policies).unwrap(),
    )
    .unwrap();
    identities
  }

  /// Every official service definition registers immediately after startup with an empty
  /// credential vault/binding table and an empty Integration table — including Baidu OCR with
  /// its api-key/secret-key slots and host-owned client-credentials auth policy. Missing user
  /// credentials are configuration state, never a registration gate.
  #[test]
  fn all_official_service_definitions_register_without_instance_credentials() {
    let resources = tempfile::tempdir().unwrap();
    let (baidu_bytes, _) = crate::services::test_support::baidu_ocr_package();
    let identities = write_official_bundle_with_baidu_shape(resources.path(), "plugins", baidu_bytes);
    assert_eq!(identities.len(), REQUIRED_OFFICIAL_RELEASE_PACKAGES.len());
    let app_data = tempfile::tempdir().unwrap();
    let state =
      AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf())
        .unwrap();
    let definitions = state.service_integrations.list_definitions();
    let present: std::collections::HashSet<String> = definitions
      .iter()
      .map(|definition| definition.manifest.id.clone())
      .collect();
    assert_eq!(
      present.len(),
      REQUIRED_OFFICIAL_RELEASE_PACKAGES.len(),
      "definitions {present:?}"
    );
    for spec in REQUIRED_OFFICIAL_RELEASE_PACKAGES {
      assert!(
        present.contains(spec.plugin_id),
        "missing definition {}",
        spec.plugin_id
      );
    }
    let baidu = definitions
      .iter()
      .find(|definition| definition.manifest.id == crate::domain::service_integration::BAIDU_OCR_PLUGIN_ID)
      .expect("Baidu definition registered");
    let slots: Vec<&str> = baidu
      .manifest
      .credential_slots
      .iter()
      .map(|slot| slot.id.as_str())
      .collect();
    assert_eq!(
      slots,
      vec!["api-key", "secret-key"],
      "Baidu exposes its credential slots"
    );
    assert!(
      baidu
        .manifest
        .capabilities
        .iter()
        .any(|capability| capability.id == crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID)
    );
    assert_eq!(
      baidu.manifest.endpoints.len(),
      4,
      "Baidu keeps its fixed endpoint/path authority"
    );
    // No instance rows and no credential bindings were created by registration.
    assert!(state.service_integrations.list_instances().unwrap().is_empty());
    let bindings = state
      .db
      .read(|conn| {
        let count: i64 = conn
          .query_row("SELECT COUNT(*) FROM integration_credential_bindings", [], |row| {
            row.get(0)
          })
          .map_err(crate::error::StorageError::from)?;
        Ok(count)
      })
      .unwrap();
    assert_eq!(
      bindings, 0,
      "definition registration must never create credential bindings"
    );
  }

  /// Task-6 public-seam smoke against the real-shaped official bundle: a credentialless
  /// Integration, a credential-required Integration, and a Provider all create through the
  /// same `save` seam the IPC commands call, with an empty credential vault. A credential-
  /// required instance is available with `unconfigured` health (not executable — capability
  /// resolution for unconfigured instances is gated; see `assert_capability_rejects_unconfigured`)
  /// until the user saves credentials; a credentialless instance is `ready` from local config
  /// alone. Runtime state stays `pending_activation` until background activation runs.
  #[test]
  fn startup_ready_creates_credentialless_credential_required_and_provider() {
    let resources = tempfile::tempdir().unwrap();
    let (baidu_bytes, _) = crate::services::test_support::baidu_ocr_package();
    write_official_bundle_with_baidu_and_provider_shape(resources.path(), "plugins", baidu_bytes);
    let app_data = tempfile::tempdir().unwrap();
    let state =
      AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf())
        .unwrap();

    // Credentialless Integration: no required slots, ready from local config alone.
    let web = state
      .service_integrations
      .save(integration_write(GOOGLE_TRANSLATE_WEB_PLUGIN_ID))
      .expect("credentialless integration create");
    assert!(web.credential_slots.is_empty(), "web must have no credential slots");
    assert_eq!(web.health_status, IntegrationHealthStatus::Ready, "web health");

    // Credential-required Integration (Baidu OCR): available as unconfigured; its required
    // api-key/secret-key slots stay visible with no stored credential bytes until the user
    // saves them.
    let baidu = state
      .service_integrations
      .save(integration_write(BAIDU_OCR_PLUGIN_ID))
      .expect("Baidu create without credentials");
    assert_eq!(
      baidu.health_status,
      IntegrationHealthStatus::Unconfigured,
      "baidu health"
    );
    assert_eq!(
      baidu.credential_slots.len(),
      2,
      "Baidu keeps its api-key/secret-key slots visible"
    );
    assert!(
      baidu
        .credential_slots
        .iter()
        .all(|slot| !slot.has_credential && slot.credential_revision == 0),
      "no credentials were synthesized"
    );
    let missing_refs = state
      .db
      .read(|conn| {
        let count: i64 = conn
          .query_row(
            "SELECT COUNT(*) FROM integration_credential_bindings WHERE credential_ref IS NULL",
            [],
            |row| row.get(0),
          )
          .map_err(crate::error::StorageError::from)?;
        Ok(count)
      })
      .unwrap();
    assert_eq!(
      missing_refs,
      baidu.credential_slots.len() as i64,
      "create without credentials registers empty slot bindings, never credential bytes"
    );

    // Provider: package-first create succeeds because every official default is authorized.
    let provider = state
      .providers
      .save(provider_write())
      .expect("provider create with authorized default");
    assert_eq!(state.providers.list().unwrap().len(), 1, "provider persisted");
    assert_eq!(provider.id.to_string().len(), 36, "provider id is a UUID");
  }

  /// A definition that fails to project or register from an official archive is a startup
  /// readiness failure, not a per-definition warning: official built-ins cannot silently vanish.
  #[test]
  fn official_definition_projection_failure_fails_startup_readiness() {
    let resources = tempfile::tempdir().unwrap();
    // One official package declares an unknown host auth policy: it still signs/verifies and
    // imports, but its definition cannot project. The other nine stay intact.
    let wasm = b"\0asm\x01\x00\x00\x00";
    let mut manifest = sample_manifest(wasm);
    manifest.id = "com.langnext.provider.openai-responses".into();
    manifest.version = "1.0.0".into();
    manifest.publisher.key_id = VENDOR_PUBLISHER_KEY_ID.into();
    manifest.publisher.key_fingerprint = fixture_vendor_fingerprint();
    manifest.permissions.auth_policies = vec!["com.example.auth.unknown".into()];
    let invalid_bytes = build_signed_package_with_key(
      &manifest,
      &[("artifacts/plugin.wasm", wasm.as_slice())],
      &fixture_vendor_signing_key(),
    );
    let plugins = resources.path().join("plugins");
    std::fs::create_dir_all(&plugins).unwrap();
    write_official_bundle_contents(&plugins, true);
    std::fs::write(
      plugins.join("com.langnext.provider.openai-responses-1.0.0.lnplugin"),
      &invalid_bytes,
    )
    .unwrap();
    // The activation policy must still match the replaced archive.
    let policy_bytes = {
      let entry = generate_bootstrap_policy_entry(&invalid_bytes, &fixture_vendor_public_key_hex()).unwrap();
      // Keep the other nine entries and replace the openai-responses one.
      let mut policies: serde_json::Value =
        serde_json::from_slice(&std::fs::read(plugins.join("default-activation-policies.json")).unwrap()).unwrap();
      let entries = policies.as_array_mut().unwrap();
      entries.retain(|entry| {
        entry.get("pluginId").and_then(serde_json::Value::as_str) != Some("com.langnext.provider.openai-responses")
      });
      entries.push(serde_json::to_value(&entry).unwrap());
      serde_json::to_vec_pretty(&policies).unwrap()
    };
    std::fs::write(plugins.join("default-activation-policies.json"), policy_bytes).unwrap();
    let app_data = tempfile::tempdir().unwrap();
    match AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf()) {
      Err(err) => {
        assert!(
          err.to_string().contains("com.langnext.provider.openai-responses"),
          "readiness error must name the failing official package, got {err}"
        );
      }
      Ok(_) => panic!("official definition projection failure must fail startup readiness"),
    }
  }

  fn write_official_bundle_contents(plugins: &std::path::Path, include_policies: bool) -> Vec<(String, String)> {
    let mut identities = Vec::new();
    let mut policies = Vec::new();
    for spec in REQUIRED_OFFICIAL_RELEASE_PACKAGES {
      let (bytes, digest) = official_vendor_package(spec.plugin_id, spec.expected_version);
      std::fs::write(
        plugins.join(format!("{}-{}.lnplugin", spec.plugin_id, spec.expected_version)),
        &bytes,
      )
      .unwrap();
      if include_policies {
        policies.push(generate_bootstrap_policy_entry(&bytes, &fixture_vendor_public_key_hex()).unwrap());
      }
      identities.push((spec.plugin_id.to_string(), digest));
    }
    let policy_json = if include_policies {
      serde_json::to_vec_pretty(&policies).unwrap()
    } else {
      b"[]".to_vec()
    };
    std::fs::write(plugins.join("default-activation-policies.json"), policy_json).unwrap();
    identities
  }

  /// Assert the resolved plugin directory authorizes all 10 official defaults with 10 policies.
  fn assert_all_official_defaults(state: &AppState, identities: &[(String, String)]) {
    let versions = state.plugin_packages.list_versions().unwrap();
    assert_eq!(
      versions.len(),
      REQUIRED_OFFICIAL_RELEASE_PACKAGES.len(),
      "all official archives must be imported"
    );
    for (plugin_id, digest) in identities {
      let found = versions
        .iter()
        .find(|version| version.plugin_id == *plugin_id)
        .unwrap_or_else(|| panic!("missing imported package {plugin_id}"));
      assert_eq!(found.package_digest, *digest, "{plugin_id}");
      assert!(found.content_available, "{plugin_id}");
    }
    let defaults = state
      .db
      .read(|conn| crate::repositories::installed_plugin_versions::list_defaults(conn))
      .unwrap();
    assert_eq!(
      defaults.len(),
      REQUIRED_OFFICIAL_RELEASE_PACKAGES.len(),
      "every official package must have an exact vendor default"
    );
    let policies = state
      .db
      .read(|conn| crate::repositories::default_package_activation_policies::list_policies(conn))
      .unwrap();
    assert_eq!(
      policies.len(),
      REQUIRED_OFFICIAL_RELEASE_PACKAGES.len(),
      "every official default must carry an activation policy"
    );
    for spec in REQUIRED_OFFICIAL_RELEASE_PACKAGES {
      assert_eq!(
        state
          .default_package_activation
          .authorization_status(spec.plugin_id)
          .unwrap(),
        DefaultPackageAuthorizationStatus::Authorized,
        "{} must be default-authorized",
        spec.plugin_id
      );
    }
  }

  #[test]
  fn production_resource_bootstrap_discovers_all_required_packages() {
    let resources = tempfile::tempdir().unwrap();
    let identities = write_official_resource_bundle(resources.path(), true);
    let app_data = tempfile::tempdir().unwrap();
    let state =
      AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf())
        .unwrap();
    assert_all_official_defaults(&state, &identities);
    let versions = state.plugin_packages.list_versions().unwrap();
    for (plugin_id, digest) in &identities {
      let found = versions
        .iter()
        .find(|version| version.plugin_id == *plugin_id)
        .unwrap_or_else(|| panic!("missing imported package {plugin_id}"));
      assert_eq!(found.package_digest, *digest, "{plugin_id}");
      assert!(found.content_available, "{plugin_id}");
    }
    assert_eq!(versions.len(), REQUIRED_OFFICIAL_RELEASE_PACKAGES.len());
  }

  /// The real Tauri debug resource layout is `<resource_dir>/resources/plugins`. The unified
  /// resource resolver must discover archives AND the activation policy from that layout and
  /// authorize all 10 official defaults, not silently fall back to an empty policy path.
  #[test]
  fn production_resource_bootstrap_uses_tauri_debug_layout_and_authorizes_all_official_defaults() {
    let resources = tempfile::tempdir().unwrap();
    let identities = write_official_resource_bundle_in(resources.path(), "resources/plugins", true);
    let app_data = tempfile::tempdir().unwrap();
    let state =
      AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf())
        .unwrap();
    assert_all_official_defaults(&state, &identities);
    // All expected service definitions, including Baidu OCR, register before user configuration.
    let definitions = state.service_integrations.list_definitions();
    let present: std::collections::HashSet<String> = definitions.iter().map(|d| d.manifest.id.clone()).collect();
    assert_eq!(
      present.len(),
      REQUIRED_OFFICIAL_RELEASE_PACKAGES.len(),
      "definitions {present:?}"
    );
    for spec in REQUIRED_OFFICIAL_RELEASE_PACKAGES {
      assert!(
        present.contains(spec.plugin_id),
        "missing definition {}",
        spec.plugin_id
      );
    }
  }

  /// A split bundle (archives in one layout, policy in another) must be rejected instead of
  /// silently mixing an archive directory with a policy directory.
  #[test]
  fn split_official_resource_bundle_layers_are_rejected() {
    let resources = tempfile::tempdir().unwrap();
    // Archives live in the debug layout; the policy only exists in the packaged layout.
    let identities = write_official_archives_only(resources.path(), "resources/plugins");
    let delegated = write_official_resource_bundle_in(resources.path(), "plugins", true);
    let _ = delegated;
    assert_eq!(identities.len(), REQUIRED_OFFICIAL_RELEASE_PACKAGES.len());
    let app_data = tempfile::tempdir().unwrap();
    match AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf()) {
      Err(err) => {
        assert!(err.to_string().contains("split"), "got {err}");
      }
      Ok(_) => panic!("split archive/policy bundle must be rejected"),
    }
  }

  /// Write only the official `.lnplugin` archives (no activation policy file at all).
  fn write_official_archives_only(resource_dir: &std::path::Path, sub_path: &str) -> Vec<(String, String)> {
    let plugins = resource_dir.join(sub_path);
    std::fs::create_dir_all(&plugins).unwrap();
    let mut identities = Vec::new();
    for spec in REQUIRED_OFFICIAL_RELEASE_PACKAGES {
      let (bytes, digest) = official_vendor_package(spec.plugin_id, spec.expected_version);
      std::fs::write(
        plugins.join(format!("{}-{}.lnplugin", spec.plugin_id, spec.expected_version)),
        &bytes,
      )
      .unwrap();
      identities.push((spec.plugin_id.to_string(), digest));
    }
    identities
  }

  /// Official archives present with a missing or incomplete policy resource is a startup
  /// readiness failure — never a silent zero-default success. Both the absent-file and the
  /// empty-array policy variants fail closed through the AppState seam.
  #[test]
  fn official_bundle_present_without_policy_fails_startup_readiness() {
    for layout in ["plugins", "resources/plugins"] {
      // Variant 1: policy file absent beside official archives.
      let resources = tempfile::tempdir().unwrap();
      let identities = write_official_archives_only(resources.path(), layout);
      assert_eq!(identities.len(), REQUIRED_OFFICIAL_RELEASE_PACKAGES.len());
      let app_data = tempfile::tempdir().unwrap();
      match AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf())
      {
        Err(err) => {
          assert!(
            err.to_string().contains("bootstrap policies"),
            "readiness error must name the policy resource, got {err}"
          );
        }
        Ok(_) => panic!("official archives without a complete policy must fail startup readiness"),
      }
    }

    // Variant 2: empty-array policy file is also incomplete: archives present, zero exact entries.
    let resources = tempfile::tempdir().unwrap();
    write_official_resource_bundle(resources.path(), false);
    let app_data = tempfile::tempdir().unwrap();
    match AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf()) {
      Err(err) => {
        assert!(err.to_string().contains("incomplete"), "got {err}");
      }
      Ok(_) => panic!("an empty policy resource beside official archives must fail startup readiness"),
    }
  }

  /// Re-running startup against the same app-data directory is idempotent: exactly 10 defaults
  /// and 10 activation policies with unchanged package digests after both starts.
  #[test]
  fn official_vendor_bootstrap_is_idempotent_across_restart() {
    let resources = tempfile::tempdir().unwrap();
    let identities = write_official_resource_bundle(resources.path(), true);
    let app_data = tempfile::tempdir().unwrap();
    let first_digests = {
      let state =
        AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf())
          .unwrap();
      assert_all_official_defaults(&state, &identities);
      let defaults = state
        .db
        .read(|conn| crate::repositories::installed_plugin_versions::list_defaults(conn))
        .unwrap();
      assert_eq!(defaults.len(), REQUIRED_OFFICIAL_RELEASE_PACKAGES.len());
      let mut digests: Vec<(String, String)> = defaults
        .into_iter()
        .map(|default| (default.plugin_id, default.package_digest))
        .collect();
      digests.sort();
      digests
    };
    let second =
      AppState::initialize_for_tests_with_resources(app_data.path().to_path_buf(), resources.path().to_path_buf())
        .unwrap();
    assert_all_official_defaults(&second, &identities);
    let policies = second
      .db
      .read(|conn| crate::repositories::default_package_activation_policies::list_policies(conn))
      .unwrap();
    assert_eq!(policies.len(), REQUIRED_OFFICIAL_RELEASE_PACKAGES.len());
    let defaults = second
      .db
      .read(|conn| crate::repositories::installed_plugin_versions::list_defaults(conn))
      .unwrap();
    assert_eq!(defaults.len(), REQUIRED_OFFICIAL_RELEASE_PACKAGES.len());
    let mut second_digests: Vec<(String, String)> = defaults
      .into_iter()
      .map(|default| (default.plugin_id, default.package_digest))
      .collect();
    second_digests.sort();
    assert_eq!(
      second_digests, first_digests,
      "default digests must be unchanged across restart"
    );
  }
}
