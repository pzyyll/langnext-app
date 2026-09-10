// ABOUTME: Installed-package service-integration catalog holding atomic package definitions.
// ABOUTME: Package definitions are projected from verified manifests/schemas; no static registrations.
use crate::domain::service_integration::{
  IntegrationCapabilitySchemaDto, ServiceIntegrationDefinitionDto, ServiceIntegrationManifest,
  ServiceIntegrationPresentationDto,
};
use crate::error::StorageError;
use crate::services::bundled_plugins::{BundledPluginRegistration, validate_registrations};
use std::collections::HashMap;

/// In-memory catalog of package-projected definitions. Installed packages are the only
/// source of service definitions; legacy compatibility registrations do not exist.
#[derive(Clone)]
pub struct ServiceIntegrationRegistry {
  package_order: Vec<String>,
  package_definitions: HashMap<String, BundledPluginRegistration>,
}

impl ServiceIntegrationRegistry {
  /// Build the production catalog. Package definitions are upserted from installed packages
  /// during catalog refresh; the initial catalog is empty.
  pub fn empty() -> Self {
    Self {
      package_order: Vec::new(),
      package_definitions: HashMap::new(),
    }
  }

  /// Empty registry for unit tests.
  #[cfg(test)]
  pub fn for_tests() -> Self {
    Self::empty()
  }

  /// Upsert a package-projected definition. Duplicate IDs within the package origin fail closed.
  pub fn upsert_package_definition(&mut self, registration: BundledPluginRegistration) -> Result<(), StorageError> {
    validate_registrations(std::slice::from_ref(&registration))?;
    let id = registration.manifest.id.clone();
    if self.package_definitions.contains_key(&id) {
      return Err(StorageError::Validation(format!(
        "duplicate package definition id: {id}"
      )));
    }
    self.package_order.push(id.clone());
    self.package_definitions.insert(id, registration);
    Ok(())
  }

  /// Test-only: register a bare capability manifest so lifecycle tests can exercise package
  /// definitions for synthetic plugins (e.g. `langnext.conformance`) with a registry-backed
  /// source identity. Inserts directly (bypassing cross-registration validation) because the
  /// manifest is test-only and carries no real capability definitions.
  #[cfg(test)]
  pub fn register_test_manifest(&mut self, manifest: crate::domain::service_integration::ServiceIntegrationManifest) {
    let id = manifest.id.clone();
    let registration = crate::services::bundled_plugins::test_manifest_registration(manifest);
    if !self.package_definitions.contains_key(&id) {
      self.package_order.push(id.clone());
    }
    self.package_definitions.insert(id, registration);
  }

  /// Catalog/create lookup: package definition only.
  pub fn get_registration(&self, plugin_id: &str) -> Option<&BundledPluginRegistration> {
    self.package_definitions.get(plugin_id)
  }

  pub fn contains(&self, plugin_id: &str) -> bool {
    self.package_definitions.contains_key(plugin_id)
  }

  /// Sanitized schema/presentation definitions in deterministic install order.
  pub fn list_definitions(&self) -> Vec<ServiceIntegrationDefinitionDto> {
    self
      .package_order
      .iter()
      .filter_map(|id| self.package_definitions.get(id))
      .map(Self::to_definition_dto)
      .collect()
  }

  fn to_definition_dto(registration: &BundledPluginRegistration) -> ServiceIntegrationDefinitionDto {
    ServiceIntegrationDefinitionDto {
      manifest: registration.manifest.clone(),
      config_schema: registration.config_schema.clone(),
      capability_schemas: registration
        .capabilities
        .iter()
        .map(|capability| IntegrationCapabilitySchemaDto {
          capability_id: capability.descriptor.id.clone(),
          preference_schema: capability.preference_schema.clone(),
        })
        .collect(),
      presentation: ServiceIntegrationPresentationDto {
        display_name_fallback: registration.presentation.display_name_fallback.clone(),
        icon: registration.presentation.icon.clone(),
      },
    }
  }

  /// Sanitized manifest for a plugin id.
  pub fn get(&self, plugin_id: &str) -> Option<&ServiceIntegrationManifest> {
    self
      .get_registration(plugin_id)
      .map(|registration| &registration.manifest)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::service_integration::{EDGE_TTS_PLUGIN_ID, GOOGLE_CLOUD_PLUGIN_ID};

  fn service_manifest(id: &str) -> crate::domain::service_integration::ServiceIntegrationManifest {
    crate::domain::service_integration::ServiceIntegrationManifest {
      manifest_version: 1,
      plugin_api_version: "1.0".into(),
      id: id.into(),
      version: "1.0.0".into(),
      display_name_key: "test".into(),
      min_host_version: "0.1.0".into(),
      config_schema_version: 1,
      credential_slots: vec![],
      endpoints: vec![],
      capabilities: vec![],
    }
  }

  #[test]
  fn empty_registry_lists_no_definitions() {
    let registry = ServiceIntegrationRegistry::empty();
    assert!(registry.list_definitions().is_empty());
    assert!(!registry.contains(GOOGLE_CLOUD_PLUGIN_ID));
    assert!(!registry.contains(EDGE_TTS_PLUGIN_ID));
    assert!(registry.get(GOOGLE_CLOUD_PLUGIN_ID).is_none());
  }

  #[test]
  fn package_definition_upsert_and_dedupe() {
    let mut registry = ServiceIntegrationRegistry::empty();
    let registration =
      crate::services::bundled_plugins::test_manifest_registration(service_manifest("com.example.service"));
    registry.upsert_package_definition(registration).unwrap();
    assert!(registry.contains("com.example.service"));

    let duplicate =
      crate::services::bundled_plugins::test_manifest_registration(service_manifest("com.example.service"));
    let result = registry.upsert_package_definition(duplicate);
    assert!(matches!(result, Err(StorageError::Validation(message)) if message.contains("duplicate")));
  }

  #[test]
  fn registry_accepts_test_manifest_without_adapters() {
    let mut registry = ServiceIntegrationRegistry::empty();
    registry.register_test_manifest(service_manifest("langnext.conformance"));
    assert!(registry.contains("langnext.conformance"));
    assert_eq!(registry.list_definitions().len(), 1);
  }
}
