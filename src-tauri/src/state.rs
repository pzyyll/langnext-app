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
use crate::services::{
  ImportExportService, ModelService, OcrServiceService, ProviderHttpService, ProviderService,
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
  pub service_integrations: ServiceIntegrationService,
  pub service_capabilities: ServiceCapabilityService,
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
}

impl AppState {
  pub fn initialize(app_data_dir: PathBuf) -> Result<Self, StorageError> {
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
    let service_capabilities = ServiceCapabilityService::new(db.clone(), registry.clone(), capability_handlers);

    let providers = ProviderService::new(db.clone(), vault.clone());
    let models = ModelService::new(db.clone(), vault.clone(), app_data_dir.join("cache"));
    let profiles = TranslationProfileService::new(db.clone(), registry.clone());
    let ocr_services = OcrServiceService::new(
      db.clone(),
      vault.clone(),
      registry.clone(),
      service_capabilities.clone(),
    );
    let speech_services = SpeechServiceService::new(db.clone(), registry.clone(), service_capabilities.clone());
    let service_integrations =
      ServiceIntegrationService::new(db.clone(), vault.clone(), registry, token_grants.clone());
    let settings = SettingsService::new(db.clone(), vault.clone());
    let import_export = ImportExportService::new(db.clone(), vault.clone());
    let history = TranslationHistoryService::new(db.clone());
    let provider_http = ProviderHttpService::new(db.clone(), vault.clone());
    let device_state = Arc::new(DeviceStateManager::load(&app_data_dir)?);
    let request_sessions = Arc::new(RequestSessionRegistry::new());

    Ok(Self {
      db,
      app_data_dir,
      providers,
      models,
      profiles,
      ocr_services,
      speech_services,
      service_integrations,
      service_capabilities,
      token_grants,
      network_broker,
      settings,
      import_export,
      history,
      device_state,
      provider_http,
      request_sessions,
    })
  }
}
