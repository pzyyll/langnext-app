// ABOUTME: Application services enforcing business rules before repository writes.
// ABOUTME: Commands call services; services own validation and credential orchestration.
pub mod import_export;
pub mod import_validation;
pub mod models;
pub mod models_dev_catalog;
pub mod ocr_services;
pub mod provider_http;
pub mod providers;
pub mod settings;
pub mod translation_history;
pub mod translation_profiles;

pub use import_export::ImportExportService;
pub use models::ModelService;
pub use ocr_services::OcrServiceService;
pub use provider_http::ProviderHttpService;
pub use providers::ProviderService;
pub use settings::SettingsService;
pub use translation_history::TranslationHistoryService;
pub use translation_profiles::TranslationProfileService;

#[cfg(test)]
mod tests;
