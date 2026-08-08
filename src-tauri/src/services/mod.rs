// ABOUTME: Application services enforcing business rules before repository writes.
// ABOUTME: Commands call services; services own validation and credential orchestration.
pub mod auth_policies;
pub mod blob_resources;
pub mod bounded_http;
pub mod bundled_plugins;
pub mod edge_tts;
pub mod edge_tts_runtime;
pub mod endpoint_trust;
pub mod google_cloud;
pub mod google_service_account;
pub mod google_translate_web;
pub mod import_export;
pub mod import_validation;
pub mod models;
pub mod models_dev_catalog;
pub mod native_workers;
pub mod network_broker;
pub mod ocr_services;
pub mod plugin_models;
pub mod plugin_package;
pub mod plugin_schema;
pub mod plugin_store;
pub mod provider_http;
pub mod provider_runtime_broker;
pub mod provider_runtime_router;
pub mod providers;
pub mod runtime_lifecycle;
pub mod runtime_plugin_contracts;
pub mod runtime_providers;
pub mod runtime_router;

#[cfg(test)]
mod runtime_provider_tests;

#[cfg(test)]
pub mod execution_dispatch_probe;

#[cfg(test)]
mod edge_tts_runtime_tests;
#[cfg(test)]
mod google_cloud_runtime_tests;
#[cfg(test)]
mod google_translate_web_runtime_tests;
#[cfg(test)]
mod paddleocr_package_tests;
#[cfg(test)]
mod paddleocr_runtime_tests;
#[cfg(test)]
mod runtime_lifecycle_installed_tests;
#[cfg(test)]
mod runtime_lifecycle_preference_tests;
pub mod service_capabilities;
pub mod service_integration_registry;
pub mod service_integrations;
pub mod settings;
pub mod speech_services;
pub mod stream_resources;
pub mod token_grant;
pub mod translation_history;
pub mod translation_profiles;
pub mod vendor_trust;
pub mod wasm_runtime;

pub use endpoint_trust::EndpointTrustService;
pub use import_export::ImportExportService;
pub use models::ModelService;
pub use ocr_services::OcrServiceService;
pub use plugin_models::PluginModelService;
pub use plugin_store::PluginPackageService;
pub use provider_http::ProviderHttpService;
pub use providers::ProviderService;
pub use runtime_lifecycle::RuntimeLifecycleService;
pub use runtime_router::RuntimeRouter;
pub use service_integration_registry::ServiceIntegrationRegistry;
pub use service_integrations::ServiceIntegrationService;
pub use settings::SettingsService;
pub use speech_services::SpeechServiceService;
pub use translation_history::TranslationHistoryService;
pub use translation_profiles::TranslationProfileService;

#[cfg(test)]
mod tests;
