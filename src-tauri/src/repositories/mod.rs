// ABOUTME: Repository module exports for SQLite aggregate access.
// ABOUTME: Services call repositories; commands never embed SQL.
pub mod app_credentials;
pub mod app_settings;
pub mod credential_operations;
pub mod installed_plugin_versions;
pub mod integration_capability_health;
pub mod integration_credential_bindings;
pub mod integration_endpoint_trusts;
pub mod integration_instances;
pub mod ocr_prompt_templates;
pub mod ocr_services;
pub mod plugin_install_operations;
pub mod plugin_package_approvals;
pub mod plugin_permission_grants;
pub mod plugin_publishers;
pub mod plugin_uninstall_operations;
pub mod plugin_upgrade_snapshots;
pub mod provider_instances;
pub mod provider_models;
pub mod provider_runtime_bindings;
pub mod speech_services;
pub mod translation_history;
pub mod translation_profiles;

#[cfg(test)]
mod tests;
