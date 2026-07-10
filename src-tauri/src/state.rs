// ABOUTME: Managed Tauri AppState holding database path, services, and device state.
// ABOUTME: Built during setup after SQLite migration and credential recovery.
use crate::credentials::{CredentialVault, NativeCredentialVault};
use crate::device_state::{DeviceStateManager, SharedDeviceState};
use crate::error::StorageError;
use crate::services::{ImportExportService, ModelService, ProviderService, SettingsService, TranslationProfileService};
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
	pub settings: SettingsService,
	pub import_export: ImportExportService,
	pub device_state: SharedDeviceState,
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
		let models = ModelService::new(db.clone());
		let profiles = TranslationProfileService::new(db.clone());
		let settings = SettingsService::new(db.clone(), vault.clone());
		let import_export = ImportExportService::new(db.clone(), vault.clone());
		let device_state = Arc::new(DeviceStateManager::load(&app_data_dir)?);

		Ok(Self {
			db,
			app_data_dir,
			providers,
			models,
			profiles,
			settings,
			import_export,
			device_state,
		})
	}
}
