// ABOUTME: Bundled service-integration catalog registration and sanitized lookup.
// ABOUTME: Registers Google Cloud and credential-free Google Web translation definitions.
use crate::domain::service_integration::{
  CredentialSlotDescriptor, CredentialSlotKind, EDGE_TTS_PLUGIN_ID, EndpointGrant, GOOGLE_CLOUD_PLUGIN_ID,
  GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT, GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL, GOOGLE_TRANSLATE_WEB_GTX_ORIGIN,
  GOOGLE_TRANSLATE_WEB_PLUGIN_ID, IntegrationCapabilityDescriptor, ServiceIntegrationManifest, validate_capability_id,
  validate_plugin_id, validate_slot_id,
};
use crate::error::StorageError;
use std::collections::{HashMap, HashSet};

/// In-memory bundled definition registry (deterministic registration order).
#[derive(Debug, Clone)]
pub struct ServiceIntegrationRegistry {
  /// Ordered plugin ids for stable list output.
  order: Vec<String>,
  by_id: HashMap<String, ServiceIntegrationManifest>,
}

impl ServiceIntegrationRegistry {
  /// Build the production catalog with every bundled definition.
  pub fn bundled() -> Result<Self, StorageError> {
    let mut registry = Self {
      order: Vec::new(),
      by_id: HashMap::new(),
    };
    registry.register(google_cloud_manifest())?;
    registry.register(google_translate_web_manifest())?;
    registry.register(edge_tts_manifest())?;
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

  /// Register a manifest; fails closed on contract violations.
  pub fn register(&mut self, manifest: ServiceIntegrationManifest) -> Result<(), StorageError> {
    validate_manifest(&manifest)?;
    if self.by_id.contains_key(&manifest.id) {
      return Err(StorageError::Validation(format!(
        "duplicate plugin id: {}",
        manifest.id
      )));
    }
    self.order.push(manifest.id.clone());
    self.by_id.insert(manifest.id.clone(), manifest);
    Ok(())
  }

  pub fn get(&self, plugin_id: &str) -> Option<&ServiceIntegrationManifest> {
    self.by_id.get(plugin_id)
  }

  pub fn contains(&self, plugin_id: &str) -> bool {
    self.by_id.contains_key(plugin_id)
  }

  /// Sanitized definition list in registration order.
  pub fn list_definitions(&self) -> Vec<ServiceIntegrationManifest> {
    self.order.iter().filter_map(|id| self.by_id.get(id).cloned()).collect()
  }
}

fn google_cloud_manifest() -> ServiceIntegrationManifest {
  ServiceIntegrationManifest {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: GOOGLE_CLOUD_PLUGIN_ID.into(),
    version: "1.2.0".into(),
    display_name_key: "plugins.googleCloud.name".into(),
    min_host_version: "0.1.0".into(),
    config_schema_version: 1,
    credential_slots: vec![CredentialSlotDescriptor {
      id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
      kind: CredentialSlotKind::SecretJson,
      required: true,
    }],
    endpoints: vec![
      EndpointGrant {
        alias: "oauth".into(),
        base_url: "https://oauth2.googleapis.com".into(),
      },
      EndpointGrant {
        alias: "translate".into(),
        base_url: "https://translation.googleapis.com".into(),
      },
      EndpointGrant {
        alias: "vision".into(),
        base_url: "https://vision.googleapis.com".into(),
      },
      EndpointGrant {
        alias: "text_to_speech".into(),
        base_url: "https://texttospeech.googleapis.com".into(),
      },
    ],
    capabilities: vec![
      IntegrationCapabilityDescriptor {
        id: "translate.text@1".into(),
        preferences_schema_version: 1,
        endpoint_aliases: vec!["oauth".into(), "translate".into()],
      },
      IntegrationCapabilityDescriptor {
        id: "translate.detect@1".into(),
        preferences_schema_version: 1,
        endpoint_aliases: vec!["oauth".into(), "translate".into()],
      },
      IntegrationCapabilityDescriptor {
        id: "ocr.image@1".into(),
        preferences_schema_version: 1,
        endpoint_aliases: vec!["oauth".into(), "vision".into()],
      },
      IntegrationCapabilityDescriptor {
        id: "speech.synthesize@1".into(),
        preferences_schema_version: 1,
        endpoint_aliases: vec!["oauth".into(), "text_to_speech".into()],
      },
    ],
  }
}

fn google_translate_web_manifest() -> ServiceIntegrationManifest {
  // Default proxy base is origin-only; instance config supplies the validated origin at runtime.
  let default_proxy_origin = url::Url::parse(GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL)
    .map(|u| u.origin().ascii_serialization())
    .unwrap_or_else(|_| "https://googlet.deno.dev".into());
  ServiceIntegrationManifest {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
    version: "1.0.0".into(),
    display_name_key: "plugins.googleTranslateWeb.name".into(),
    min_host_version: "0.1.0".into(),
    config_schema_version: 1,
    credential_slots: vec![],
    endpoints: vec![
      EndpointGrant {
        alias: "gtx".into(),
        base_url: GOOGLE_TRANSLATE_WEB_GTX_ORIGIN.into(),
      },
      EndpointGrant {
        alias: "https_proxy".into(),
        // Placeholder origin; NetworkBroker replaces with instance-validated HTTPS origin.
        base_url: default_proxy_origin,
      },
    ],
    capabilities: vec![
      IntegrationCapabilityDescriptor {
        id: "translate.text@1".into(),
        preferences_schema_version: 1,
        endpoint_aliases: vec!["gtx".into(), "https_proxy".into()],
      },
      IntegrationCapabilityDescriptor {
        id: "translate.detect@1".into(),
        preferences_schema_version: 1,
        // Detect always uses pinned GTX, even in proxy channel mode.
        endpoint_aliases: vec!["gtx".into()],
      },
    ],
  }
}

fn edge_tts_manifest() -> ServiceIntegrationManifest {
  // Credential-free OpenAI-compatible Edge TTS. The handler calls reqwest directly because the
  // service returns raw MP3 bytes and reads a per-instance base URL; no broker endpoint alias is used.
  ServiceIntegrationManifest {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: EDGE_TTS_PLUGIN_ID.into(),
    version: "1.0.0".into(),
    display_name_key: "plugins.edgeTts.name".into(),
    min_host_version: "0.1.0".into(),
    config_schema_version: 1,
    credential_slots: vec![],
    endpoints: vec![],
    capabilities: vec![IntegrationCapabilityDescriptor {
      id: "speech.synthesize@1".into(),
      preferences_schema_version: 1,
      endpoint_aliases: vec![],
    }],
  }
}

fn validate_manifest(manifest: &ServiceIntegrationManifest) -> Result<(), StorageError> {
  if manifest.manifest_version == 0 {
    return Err(StorageError::Validation("manifest_version must be >= 1".into()));
  }
  if manifest.config_schema_version == 0 {
    return Err(StorageError::Validation("config_schema_version must be >= 1".into()));
  }
  if manifest.version.trim().is_empty() {
    return Err(StorageError::Validation("plugin version is required".into()));
  }
  if manifest.plugin_api_version.trim().is_empty() {
    return Err(StorageError::Validation("plugin_api_version is required".into()));
  }
  if manifest.display_name_key.trim().is_empty() {
    return Err(StorageError::Validation("display_name_key is required".into()));
  }
  validate_plugin_id(&manifest.id).map_err(StorageError::Validation)?;

  let mut slot_ids = HashSet::new();
  for slot in &manifest.credential_slots {
    validate_slot_id(&slot.id).map_err(StorageError::Validation)?;
    if !slot_ids.insert(slot.id.clone()) {
      return Err(StorageError::Validation(format!("duplicate slot id: {}", slot.id)));
    }
  }

  let mut endpoint_aliases = HashSet::new();
  for endpoint in &manifest.endpoints {
    let alias = endpoint.alias.trim();
    if alias.is_empty() {
      return Err(StorageError::Validation("endpoint alias is required".into()));
    }
    if endpoint.base_url.trim().is_empty() {
      return Err(StorageError::Validation(format!(
        "endpoint base_url is required for alias {alias}"
      )));
    }
    if !endpoint_aliases.insert(alias.to_string()) {
      return Err(StorageError::Validation(format!("duplicate endpoint alias: {alias}")));
    }
  }

  let mut capability_ids = HashSet::new();
  for capability in &manifest.capabilities {
    validate_capability_id(&capability.id).map_err(StorageError::Validation)?;
    if !capability_ids.insert(capability.id.clone()) {
      return Err(StorageError::Validation(format!(
        "duplicate capability id: {}",
        capability.id
      )));
    }
    if capability.preferences_schema_version == 0 {
      return Err(StorageError::Validation(format!(
        "preferences_schema_version must be >= 1 for {}",
        capability.id
      )));
    }
    for alias in &capability.endpoint_aliases {
      if !endpoint_aliases.contains(alias) {
        return Err(StorageError::Validation(format!(
          "capability {} references undeclared endpoint alias {alias}",
          capability.id
        )));
      }
    }
  }

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

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
    assert!(edge.endpoints.is_empty());
    assert_eq!(edge.capabilities.len(), 1);
    assert!(edge.capabilities.iter().any(|c| c.id == "speech.synthesize@1"));
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
    assert!(defs_contain_separate_cloud_and_web(&registry));
  }

  fn defs_contain_separate_cloud_and_web(registry: &ServiceIntegrationRegistry) -> bool {
    registry.contains(GOOGLE_CLOUD_PLUGIN_ID) && registry.contains(GOOGLE_TRANSLATE_WEB_PLUGIN_ID)
  }

  #[test]
  fn rejects_duplicate_plugin_id() {
    let mut registry = ServiceIntegrationRegistry::empty();
    registry.register(google_cloud_manifest()).unwrap();
    let err = registry.register(google_cloud_manifest()).unwrap_err();
    assert!(matches!(err, StorageError::Validation(msg) if msg.contains("duplicate plugin")));
  }

  #[test]
  fn rejects_duplicate_capability_id() {
    let mut manifest = google_cloud_manifest();
    manifest.capabilities.push(IntegrationCapabilityDescriptor {
      id: "translate.text@1".into(),
      preferences_schema_version: 1,
      endpoint_aliases: vec![],
    });
    let err = ServiceIntegrationRegistry::empty().register(manifest).unwrap_err();
    assert!(matches!(err, StorageError::Validation(msg) if msg.contains("duplicate capability")));
  }

  #[test]
  fn rejects_duplicate_slot_id() {
    let mut manifest = google_cloud_manifest();
    manifest.credential_slots.push(CredentialSlotDescriptor {
      id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
      kind: CredentialSlotKind::SecretJson,
      required: false,
    });
    let err = ServiceIntegrationRegistry::empty().register(manifest).unwrap_err();
    assert!(matches!(err, StorageError::Validation(msg) if msg.contains("duplicate slot")));
  }

  #[test]
  fn rejects_capability_undeclared_endpoint() {
    let mut manifest = google_cloud_manifest();
    manifest.capabilities[0].endpoint_aliases = vec!["missing".into()];
    let err = ServiceIntegrationRegistry::empty().register(manifest).unwrap_err();
    assert!(matches!(err, StorageError::Validation(msg) if msg.contains("undeclared endpoint")));
  }

  #[test]
  fn rejects_invalid_versions() {
    let mut manifest = google_cloud_manifest();
    manifest.manifest_version = 0;
    let err = ServiceIntegrationRegistry::empty().register(manifest).unwrap_err();
    assert!(matches!(err, StorageError::Validation(_)));

    let mut manifest = google_cloud_manifest();
    manifest.capabilities[0].id = "translate.text".into();
    let err = ServiceIntegrationRegistry::empty().register(manifest).unwrap_err();
    assert!(matches!(err, StorageError::Validation(_)));
  }
}
