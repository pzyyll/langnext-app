// ABOUTME: Repository module exports for SQLite aggregate access.
// ABOUTME: Services call repositories; commands never embed SQL.
pub mod app_credentials;
pub mod app_settings;
pub mod credential_operations;
pub mod integration_credential_bindings;
pub mod integration_instances;
pub mod ocr_prompt_templates;
pub mod ocr_services;
pub mod provider_instances;
pub mod provider_models;
pub mod translation_history;
pub mod translation_profiles;

#[cfg(test)]
mod tests;
