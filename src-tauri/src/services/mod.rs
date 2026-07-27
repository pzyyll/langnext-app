// ABOUTME: Application services enforcing business rules before repository writes.
// ABOUTME: Commands call services; services own validation and credential orchestration.
pub mod auth_policies;
pub mod bounded_http;
pub mod bundled_plugins;
pub mod edge_tts;
pub mod google_cloud;
pub mod google_service_account;
pub mod google_translate_web;
pub mod import_export;
pub mod import_validation;
pub mod models;
pub mod models_dev_catalog;
pub mod network_broker;
pub mod ocr_services;
pub mod plugin_schema;
pub mod provider_http;
pub mod providers;
pub mod runtime_plugin_contracts;
pub mod service_capabilities;
pub mod service_integration_registry;
pub mod service_integrations;
pub mod settings;
pub mod speech_services;
pub mod token_grant;
pub mod translation_history;
pub mod translation_profiles;

pub use import_export::ImportExportService;
pub use models::ModelService;
pub use ocr_services::OcrServiceService;
pub use provider_http::ProviderHttpService;
pub use providers::ProviderService;
pub use service_integration_registry::ServiceIntegrationRegistry;
pub use service_integrations::ServiceIntegrationService;
pub use settings::SettingsService;
pub use speech_services::SpeechServiceService;
pub use translation_history::TranslationHistoryService;
pub use translation_profiles::TranslationProfileService;

#[cfg(test)]
mod tests;
