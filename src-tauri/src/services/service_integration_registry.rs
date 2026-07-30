// ABOUTME: Bundled service-integration catalog storing atomic registrations (manifest + schemas +
// ABOUTME: adapters + validators + policy) and exposing sanitized manifest DTOs for IPC.
use crate::domain::service_integration::{
  IntegrationCapabilitySchemaDto, ServiceIntegrationDefinitionDto, ServiceIntegrationManifest,
  ServiceIntegrationPresentationDto,
};
use crate::error::StorageError;
use crate::services::bundled_plugins::{BundledPluginRegistration, bundled, validate_registrations};
use std::collections::HashMap;

/// In-memory bundled registration registry (deterministic registration order).
#[derive(Clone)]
pub struct ServiceIntegrationRegistry {
  /// Ordered plugin ids for stable list output.
  order: Vec<String>,
  by_id: HashMap<String, BundledPluginRegistration>,
}

impl ServiceIntegrationRegistry {
  /// Build the production catalog with every bundled atomic registration.
  pub fn bundled() -> Result<Self, StorageError> {
    let registrations = bundled()?;
    let mut registry = Self {
      order: Vec::new(),
      by_id: HashMap::new(),
    };
    for registration in registrations {
      registry.register(registration)?;
    }
    Ok(registry)
  }

  /// Empty registry for unit tests.
  #[cfg(test)]
  pub fn empty() -> Self {
    Self {
      order: Vec::new(),
      by_id: HashMap::new(),
    }
  }

  /// Register an atomic definition; fails closed on contract violations (validated upstream).
  pub fn register(&mut self, registration: BundledPluginRegistration) -> Result<(), StorageError> {
    validate_registrations(std::slice::from_ref(&registration))?;
    if self.by_id.contains_key(&registration.manifest.id) {
      return Err(StorageError::Validation(format!(
        "duplicate plugin id: {}",
        registration.manifest.id
      )));
    }
    self.order.push(registration.manifest.id.clone());
    self.by_id.insert(registration.manifest.id.clone(), registration);
    Ok(())
  }

  /// Test-only: register a bare capability manifest as a manifest-only registration so lifecycle
  /// tests can exercise bundled->Wasm upgrades for synthetic plugins (e.g. `langnext.conformance`)
  /// with a registry-backed source identity. Inserts directly (bypassing cross-registration
  /// validation) because the manifest is test-only and carries no real capability definitions;
  /// `source_capability_majors` only reads `manifest.capabilities`.
  #[cfg(test)]
  pub fn register_test_manifest(&mut self, manifest: crate::domain::service_integration::ServiceIntegrationManifest) {
    let id = manifest.id.clone();
    let registration = crate::services::bundled_plugins::test_manifest_registration(manifest);
    if !self.by_id.contains_key(&id) {
      self.order.push(id.clone());
    }
    self.by_id.insert(id, registration);
  }

  /// Look up the atomic registration for a plugin id.
  pub fn get_registration(&self, plugin_id: &str) -> Option<&BundledPluginRegistration> {
    self.by_id.get(plugin_id)
  }

  pub fn contains(&self, plugin_id: &str) -> bool {
    self.by_id.contains_key(plugin_id)
  }

  /// Sanitized schema/presentation definitions in registration order for frontend IPC.
  pub fn list_definitions(&self) -> Vec<ServiceIntegrationDefinitionDto> {
    self
      .order
      .iter()
      .filter_map(|id| self.by_id.get(id).map(Self::to_definition_dto))
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
    self.by_id.get(plugin_id).map(|r| &r.manifest)
  }

  /// Iterate all atomic registrations in deterministic order.
  pub fn registrations(&self) -> impl Iterator<Item = &BundledPluginRegistration> {
    self.order.iter().filter_map(move |id| self.by_id.get(id))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::service_integration::{
    EDGE_TTS_PLUGIN_ID, GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT, GOOGLE_TRANSLATE_WEB_PLUGIN_ID,
  };
  use crate::services::edge_tts::EDGE_TTS_ENDPOINT_ALIAS;

  #[test]
  fn bundled_registers_google_cloud() {
    let registry = ServiceIntegrationRegistry::bundled().unwrap();
    let defs = registry.list_definitions();
    assert_eq!(defs.len(), 3);
    let google = registry.get(GOOGLE_CLOUD_PLUGIN_ID).unwrap();
    assert_eq!(google.config_schema_version, 1);
    assert_eq!(google.credential_slots.len(), 1);
    assert_eq!(google.credential_slots[0].id, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT);
    assert_eq!(google.version, "1.2.0");
    assert_eq!(google.capabilities.len(), 4);
    assert!(google.capabilities.iter().any(|c| c.id == "translate.text@1"));
    assert!(google.capabilities.iter().any(|c| c.id == "translate.detect@1"));
    assert!(google.capabilities.iter().any(|c| c.id == "ocr.image@1"));
    assert!(google.capabilities.iter().any(|c| c.id == "speech.synthesize@1"));
    assert!(google.endpoints.iter().any(|e| e.alias == "vision"));
    assert!(google.endpoints.iter().any(|e| e.alias == "text_to_speech"));
    assert_eq!(
      google
        .endpoints
        .iter()
        .find(|e| e.alias == "vision")
        .map(|e| e.base_url.as_str()),
      Some("https://vision.googleapis.com")
    );
    assert_eq!(
      google
        .endpoints
        .iter()
        .find(|e| e.alias == "text_to_speech")
        .map(|e| e.base_url.as_str()),
      Some("https://texttospeech.googleapis.com")
    );
  }

  #[test]
  fn bundled_registers_edge_tts_zero_secret() {
    let registry = ServiceIntegrationRegistry::bundled().unwrap();
    let edge = registry.get(EDGE_TTS_PLUGIN_ID).unwrap();
    assert!(edge.credential_slots.is_empty());
    assert!(
      edge
        .endpoints
        .iter()
        .any(|endpoint| endpoint.alias == EDGE_TTS_ENDPOINT_ALIAS)
    );
    assert_eq!(edge.capabilities.len(), 1);
    let speech = edge
      .capabilities
      .iter()
      .find(|capability| capability.id == "speech.synthesize@1")
      .unwrap();
    assert_eq!(speech.endpoint_aliases, vec![EDGE_TTS_ENDPOINT_ALIAS.to_string()]);
    assert_eq!(edge.display_name_key, "plugins.edgeTts.name");
  }

  #[test]
  fn bundled_registers_google_translate_web_zero_secret() {
    let registry = ServiceIntegrationRegistry::bundled().unwrap();
    let web = registry.get(GOOGLE_TRANSLATE_WEB_PLUGIN_ID).unwrap();
    assert_eq!(web.config_schema_version, 1);
    assert!(web.credential_slots.is_empty());
    assert_eq!(web.capabilities.len(), 2);
    assert!(web.capabilities.iter().any(|c| c.id == "translate.text@1"));
    assert!(web.capabilities.iter().any(|c| c.id == "translate.detect@1"));
    let translate = web.capabilities.iter().find(|c| c.id == "translate.text@1").unwrap();
    assert!(translate.endpoint_aliases.iter().any(|a| a == "gtx"));
    assert!(translate.endpoint_aliases.iter().any(|a| a == "https_proxy"));
    let detect = web.capabilities.iter().find(|c| c.id == "translate.detect@1").unwrap();
    assert_eq!(detect.endpoint_aliases, vec!["gtx".to_string()]);
    assert!(registry.contains(GOOGLE_CLOUD_PLUGIN_ID) && registry.contains(GOOGLE_TRANSLATE_WEB_PLUGIN_ID));
  }

  #[test]
  fn registry_rejects_capability_without_broker_authority() {
    let mut registrations = bundled().unwrap();
    let mut edge = registrations.pop().unwrap();
    edge.capabilities[0].endpoint_authorities.clear();

    let mut registry = ServiceIntegrationRegistry::empty();
    let result = registry.register(edge);
    assert!(matches!(result, Err(StorageError::Validation(message)) if message.contains("no broker authority")));
  }

  #[test]
  fn registry_rejects_descriptor_that_widens_manifest_authority() {
    let mut registrations = bundled().unwrap();
    let mut edge = registrations.pop().unwrap();
    edge.capabilities[0]
      .descriptor
      .endpoint_aliases
      .push("unreviewed".into());

    let mut registry = ServiceIntegrationRegistry::empty();
    let result = registry.register(edge);
    assert!(
      matches!(result, Err(StorageError::Validation(message)) if message.contains("does not match its manifest descriptor"))
    );
  }

  #[test]
  fn registrations_expose_adapters_and_schemas() {
    let registry = ServiceIntegrationRegistry::bundled().unwrap();
    let google = registry.get_registration(GOOGLE_CLOUD_PLUGIN_ID).unwrap();
    assert!(
      google
        .config_adapter
        .config_schema()
        .fields
        .iter()
        .any(|f| f.id == "project-id")
    );
    assert!(
      google
        .credential_validators
        .contains_key(GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT)
    );
    assert!(google.auth_policy.is_some());
    let edge = registry.get_registration(EDGE_TTS_PLUGIN_ID).unwrap();
    assert!(edge.auth_policy.is_none());
    assert!(edge.capability("speech.synthesize@1").is_some());
  }
}
