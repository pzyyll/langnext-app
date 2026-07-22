// ABOUTME: Managed Tauri AppState holding database path, services, and device state.
// ABOUTME: Built during setup after SQLite migration and credential recovery.
use crate::adapters::transport::{HttpModelTransport, ModelTransport};
use crate::credentials::{CredentialVault, NativeCredentialVault};
use crate::device_state::{DeviceStateManager, SharedDeviceState};
use crate::domain::cancel::TranslateSessionRegistry;
use crate::error::StorageError;
use crate::services::{
  ImportExportService, ModelService, OcrServiceService, ProviderService, SettingsService, TranslationHistoryService,
  TranslationProfileService,
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
  pub settings: SettingsService,
  pub import_export: ImportExportService,
  pub history: TranslationHistoryService,
  pub device_state: SharedDeviceState,
  /// In-flight translate request ids → cancel tokens.
  pub translate_sessions: Arc<TranslateSessionRegistry>,
}

impl AppState {
  pub fn initialize(app_data_dir: PathBuf) -> Result<Self, StorageError> {
    std::fs::create_dir_all(&app_data_dir)?;
    let db = Database::new(&app_data_dir)?;
    db.initialize()?;

    let vault: Arc<dyn CredentialVault> = Arc::new(NativeCredentialVault::new());
    // Recovery is best-effort; vault unavailability is nonfatal at startup.
    let _recovery = ProviderService::recover_credential_operations(&db, vault.as_ref());

    let providers = ProviderService::new(db.clone(), vault.clone());
    let transport: Arc<dyn ModelTransport> = Arc::new(HttpModelTransport);
    let history = TranslationHistoryService::new(db.clone());
    let models = ModelService::new(
      db.clone(),
      vault.clone(),
      transport,
      history,
      app_data_dir.join("cache"),
    );
    let profiles = TranslationProfileService::new(db.clone());
    let ocr_services = OcrServiceService::new(db.clone(), vault.clone());
    let settings = SettingsService::new(db.clone(), vault.clone());
    let import_export = ImportExportService::new(db.clone(), vault.clone());
    let history = TranslationHistoryService::new(db.clone());
    let device_state = Arc::new(DeviceStateManager::load(&app_data_dir)?);
    let translate_sessions = Arc::new(TranslateSessionRegistry::new());

    Ok(Self {
      db,
      app_data_dir,
      providers,
      models,
      profiles,
      ocr_services,
      settings,
      import_export,
      history,
      device_state,
      translate_sessions,
    })
  }
}
