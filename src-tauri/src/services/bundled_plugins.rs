// ABOUTME: Atomic plugin catalog definition types shared by package projection and registries.
// ABOUTME: Manifest + schemas + adapters + policy + presentation; no concrete bundled executors.
use crate::domain::plugin_schema::PluginSchemaV1;
use crate::domain::provider::ProxyMode;
use crate::domain::provider_http::ProviderHttpMethod;
use crate::domain::service_integration::{IntegrationCapabilityDescriptor, ServiceIntegrationManifest};
use crate::error::StorageError;
use crate::services::plugin_schema::validate_schema;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

/// Schema-driven config adapter: normalize/validate non-secret config JSON and report readiness.
/// Shared services call this via trait dispatch instead of branching on plugin id.
pub trait PluginConfigAdapter: Send + Sync + 'static {
  /// The authoritative config schema (kebab-case field ids).
  fn config_schema(&self) -> &PluginSchemaV1;
  /// Validate + normalize config JSON; returns canonical config_json string.
  fn normalize_config(&self, config_json: &str) -> Result<String, StorageError>;
  /// True when required config fields are satisfied (credentials are evaluated separately).
  fn config_ready(&self, config_json: &str) -> bool;
  /// Effective proxy mode for the broker (host-owned network grant projection).
  fn proxy_mode(&self, config_json: &str) -> ProxyMode;
  /// Resolve an instance-sourced endpoint origin for `alias`, if the plugin allows one.
  fn instance_endpoint_origin(&self, config_json: &str, alias: &str) -> Result<Option<String>, StorageError>;
  /// Resolve the one configured relative path authorized for an instance endpoint alias.
  /// Most adapters do not authorize a dynamic path and retain the default `None`.
  fn instance_endpoint_relative_path(&self, _config_json: &str, _alias: &str) -> Result<Option<String>, StorageError> {
    Ok(None)
  }
}

/// Validates a credential slot secret before any vault write.
pub trait CredentialValidator: Send + Sync + 'static {
  fn validate(&self, secret: &str) -> Result<(), StorageError>;
}

/// Schema-driven capability preference adapter: normalize/validate preference JSON.
pub trait CapabilityPreferencesAdapter: Send + Sync + 'static {
  fn preference_schema(&self) -> &PluginSchemaV1;
  fn normalize_preferences(&self, preferences: &Value) -> Result<Value, StorageError>;
}

/// Host-owned endpoint policy metadata for a bundled plugin's brokered network access.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EndpointPolicy {
  /// Whether instance-sourced endpoint origins (e.g. user HTTPS proxy URL) are allowed.
  pub allow_instance_endpoints: bool,
}

/// Path authority for one capability network entry. Paths are always relative to a resolved
/// manifest or instance-configured base URL and never contain executable matching code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityPathAuthority {
  /// Allow exactly one fixed relative path.
  Exact(String),
  /// Allow a dynamic middle segment only when fixed endpoint framing still matches.
  PrefixAndSuffix { prefix: String, suffix: String },
  /// Allow only the normalized relative path persisted in the instance configuration.
  InstanceConfigured,
}

impl CapabilityPathAuthority {
  pub fn matches_static(&self, relative_path: &str) -> bool {
    match self {
      Self::Exact(expected) => relative_path == expected,
      Self::PrefixAndSuffix { prefix, suffix } => {
        crate::domain::runtime_plugin::bounded_prefix_suffix_matches(prefix, suffix, relative_path)
      }
      Self::InstanceConfigured => false,
    }
  }

  pub fn from_declared(declared: &crate::domain::runtime_plugin::DeclaredPathAuthority) -> Self {
    match declared {
      crate::domain::runtime_plugin::DeclaredPathAuthority::Exact { value } => Self::Exact(value.clone()),
      crate::domain::runtime_plugin::DeclaredPathAuthority::BoundedPrefixSuffix { prefix, suffix } => {
        Self::PrefixAndSuffix {
          prefix: prefix.clone(),
          suffix: suffix.clone(),
        }
      }
      crate::domain::runtime_plugin::DeclaredPathAuthority::InstanceConfiguredRelativePath { .. } => {
        Self::InstanceConfigured
      }
    }
  }
}

/// One host-reviewed capability authority entry. It binds an exact capability to endpoint,
/// HTTP method, allowed caller metadata, auth policy, and upper resource limits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityEndpointAuthority {
  pub endpoint_alias: String,
  pub method: ProviderHttpMethod,
  pub path: CapabilityPathAuthority,
  pub allowed_query_names: Vec<String>,
  pub allowed_header_names: Vec<String>,
  /// `Some` requires a grant issued for this exact host-owned auth policy id.
  pub auth_policy_id: Option<String>,
  pub max_request_body_bytes: usize,
  pub max_response_body_bytes: usize,
  pub max_timeout: Duration,
}

/// Host-owned auth-policy binding. A manifest never carries executable auth logic; this binds a
/// plugin to a host-defined auth driver/policy/scope set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthPolicyBinding {
  pub auth_policy_id: String,
  pub auth_driver_id: String,
  pub audience_policy_id: String,
  pub scopes: Vec<String>,
}

/// Localized fallback labels and closed host icon id for plugin presentation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginPresentation {
  pub display_name_key: String,
  pub display_name_fallback: String,
  /// Closed host icon id; `None` means no dedicated icon.
  pub icon: Option<String>,
}

/// A declared capability with its preference schema and adapter (handler attached at build time).
#[derive(Clone)]
pub struct BundledCapabilityDefinition {
  pub descriptor: IntegrationCapabilityDescriptor,
  pub preference_schema: PluginSchemaV1,
  pub preference_adapter: Arc<dyn CapabilityPreferencesAdapter>,
  /// Exact broker authorities available to this capability.
  pub endpoint_authorities: Vec<CapabilityEndpointAuthority>,
}

/// Atomic bundled plugin definition: manifest + config schema/adapter + credential validators +
/// capability definitions + endpoint/auth policy + presentation + handler factory. Handlers are
/// constructed by the registration's own factory via [`build_capability_registry`] after the
/// broker and token grant service exist.
#[derive(Clone)]
pub struct BundledPluginRegistration {
  pub manifest: ServiceIntegrationManifest,
  pub config_schema: PluginSchemaV1,
  pub config_adapter: Arc<dyn PluginConfigAdapter>,
  pub credential_validators: HashMap<String, Arc<dyn CredentialValidator>>,
  pub capabilities: Vec<BundledCapabilityDefinition>,
  pub endpoint_policy: EndpointPolicy,
  pub auth_policy: Option<AuthPolicyBinding>,
  pub presentation: PluginPresentation,
}

impl BundledPluginRegistration {
  /// Look up a capability definition by capability id.
  pub fn capability(&self, capability_id: &str) -> Option<&BundledCapabilityDefinition> {
    self.capabilities.iter().find(|c| c.descriptor.id == capability_id)
  }

  /// True when this plugin requires remote auth (token grant) before becoming Ready.
  pub fn requires_remote_auth(&self) -> bool {
    self.auth_policy.is_some()
  }
}

/// Test-only manifest-only registration for synthetic plugins (e.g. `langnext.conformance`) so
/// lifecycle tests can exercise bundled->Wasm upgrades with a registry-backed source identity
/// without constructing full production adapters. All non-manifest fields are inert dummies;
/// the empty v1 schema validates and the config adapter agrees with it. Never use outside tests.
#[cfg(test)]
pub fn test_manifest_registration(manifest: ServiceIntegrationManifest) -> BundledPluginRegistration {
  /// Inert config adapter returning a minimal valid empty v1 schema; never normalizes or resolves.
  struct DummyTestConfigAdapter;
  impl PluginConfigAdapter for DummyTestConfigAdapter {
    fn config_schema(&self) -> &PluginSchemaV1 {
      static SCHEMA: std::sync::OnceLock<PluginSchemaV1> = std::sync::OnceLock::new();
      SCHEMA.get_or_init(|| PluginSchemaV1 {
        version: 1,
        fields: Vec::new(),
        groups: Vec::new(),
      })
    }
    fn normalize_config(&self, config_json: &str) -> Result<String, StorageError> {
      Ok(config_json.into())
    }
    fn config_ready(&self, _config_json: &str) -> bool {
      true
    }
    fn proxy_mode(&self, _config_json: &str) -> ProxyMode {
      ProxyMode::Direct
    }
    fn instance_endpoint_origin(&self, _config_json: &str, _alias: &str) -> Result<Option<String>, StorageError> {
      Ok(None)
    }
  }
  BundledPluginRegistration {
    manifest,
    config_schema: PluginSchemaV1 {
      version: 1,
      fields: Vec::new(),
      groups: Vec::new(),
    },
    config_adapter: Arc::new(DummyTestConfigAdapter),
    credential_validators: HashMap::new(),
    capabilities: Vec::new(),
    endpoint_policy: EndpointPolicy::default(),
    auth_policy: None,
    presentation: PluginPresentation {
      display_name_key: String::new(),
      display_name_fallback: String::new(),
      icon: None,
    },
  }
}

/// Validate cross-registration uniqueness and per-registration completeness for package
/// definitions projected from installed packages.
pub(crate) fn validate_registrations(registrations: &[BundledPluginRegistration]) -> Result<(), StorageError> {
  let mut plugin_ids = HashSet::new();
  for reg in registrations {
    if !plugin_ids.insert(reg.manifest.id.clone()) {
      return Err(StorageError::Validation(format!(
        "duplicate plugin id: {}",
        reg.manifest.id
      )));
    }
    validate_schema(&reg.config_schema)
      .map_err(|e| StorageError::Validation(format!("config schema for {}: {e}", reg.manifest.id)))?;
    if reg.config_schema != *reg.config_adapter.config_schema() {
      return Err(StorageError::Validation(format!(
        "config adapter schema does not match registration schema for {}",
        reg.manifest.id
      )));
    }
    if reg.config_schema.version != reg.manifest.config_schema_version {
      return Err(StorageError::Validation(format!(
        "config schema version does not match manifest for {}",
        reg.manifest.id
      )));
    }

    if let Some(auth_policy) = &reg.auth_policy {
      // Scope requirements are a property of each closed host auth driver (Baidu client-
      // credentials allows an empty scope set; Google service-account requires non-empty;
      // unknown drivers fail closed). Never consults user credentials.
      crate::services::auth_policies::validate_registration_binding(auth_policy)
        .map_err(|err| StorageError::Validation(format!("auth policy binding for {}: {err}", reg.manifest.id)))?;
    }

    let mut endpoint_aliases = HashSet::new();
    for endpoint in &reg.manifest.endpoints {
      if !endpoint_aliases.insert(endpoint.alias.clone()) {
        return Err(StorageError::Validation(format!(
          "duplicate endpoint alias: {}",
          endpoint.alias
        )));
      }
    }
    let mut manifest_capability_ids = HashSet::new();
    for manifest_capability in &reg.manifest.capabilities {
      if !manifest_capability_ids.insert(manifest_capability.id.clone()) {
        return Err(StorageError::Validation(format!(
          "duplicate manifest capability id: {}",
          manifest_capability.id
        )));
      }
      let mut declared_aliases = HashSet::new();
      for alias in &manifest_capability.endpoint_aliases {
        if !declared_aliases.insert(alias.clone()) {
          return Err(StorageError::Validation(format!(
            "duplicate endpoint alias {} on capability {}",
            alias, manifest_capability.id
          )));
        }
        if !endpoint_aliases.contains(alias) {
          return Err(StorageError::Validation(format!(
            "capability {} references unknown endpoint alias {}",
            manifest_capability.id, alias
          )));
        }
      }
    }

    let mut capability_ids = HashSet::new();
    let mut slot_ids = HashSet::new();
    for slot in &reg.manifest.credential_slots {
      if !slot_ids.insert(slot.id.clone()) {
        return Err(StorageError::Validation(format!("duplicate slot id: {}", slot.id)));
      }
      if slot.required && !reg.credential_validators.contains_key(&slot.id) {
        return Err(StorageError::Validation(format!(
          "required credential slot {} has no validator",
          slot.id
        )));
      }
    }
    for validator_slot_id in reg.credential_validators.keys() {
      if !slot_ids.contains(validator_slot_id) {
        return Err(StorageError::Validation(format!(
          "credential validator references unknown slot {validator_slot_id}"
        )));
      }
    }
    for cap in &reg.capabilities {
      if !capability_ids.insert(cap.descriptor.id.clone()) {
        return Err(StorageError::Validation(format!(
          "duplicate capability id: {}",
          cap.descriptor.id
        )));
      }
      validate_schema(&cap.preference_schema).map_err(|e| {
        StorageError::Validation(format!(
          "preference schema for {} {}: {e}",
          reg.manifest.id, cap.descriptor.id
        ))
      })?;
      if cap.preference_schema != *cap.preference_adapter.preference_schema() {
        return Err(StorageError::Validation(format!(
          "preference adapter schema does not match capability {}",
          cap.descriptor.id
        )));
      }
      if cap.preference_schema.version != cap.descriptor.preferences_schema_version {
        return Err(StorageError::Validation(format!(
          "preference schema version does not match capability {}",
          cap.descriptor.id
        )));
      }
      // Every declared capability must have an identical manifest descriptor, not merely a
      // matching id, so an adapter cannot widen endpoint aliases independently of the manifest.
      let manifest_capability = reg
        .manifest
        .capabilities
        .iter()
        .find(|manifest_capability| manifest_capability.id == cap.descriptor.id)
        .ok_or_else(|| {
          StorageError::Validation(format!(
            "capability {} has a definition but is not declared on manifest {}",
            cap.descriptor.id, reg.manifest.id
          ))
        })?;
      if manifest_capability != &cap.descriptor {
        return Err(StorageError::Validation(format!(
          "capability {} definition does not match its manifest descriptor",
          cap.descriptor.id
        )));
      }
      if !cap.descriptor.endpoint_aliases.is_empty() && cap.endpoint_authorities.is_empty() {
        return Err(StorageError::Validation(format!(
          "capability {} on plugin {} has endpoint aliases but no broker authority",
          cap.descriptor.id, reg.manifest.id
        )));
      }
      let mut authority_keys = HashSet::new();
      for authority in &cap.endpoint_authorities {
        if matches!(authority.path, CapabilityPathAuthority::InstanceConfigured)
          && !reg.endpoint_policy.allow_instance_endpoints
        {
          return Err(StorageError::Validation(format!(
            "instance-configured authority on capability {} is not enabled by endpoint policy",
            cap.descriptor.id
          )));
        }
        if !cap
          .descriptor
          .endpoint_aliases
          .iter()
          .any(|alias| alias == &authority.endpoint_alias)
        {
          return Err(StorageError::Validation(format!(
            "authority alias {} is not declared for capability {}",
            authority.endpoint_alias, cap.descriptor.id
          )));
        }
        if !reg
          .manifest
          .endpoints
          .iter()
          .any(|endpoint| endpoint.alias == authority.endpoint_alias)
        {
          return Err(StorageError::Validation(format!(
            "authority alias {} is missing from plugin {} manifest",
            authority.endpoint_alias, reg.manifest.id
          )));
        }
        let authority_key = format!(
          "{}:{:?}:{:?}",
          authority.endpoint_alias, authority.method, authority.path
        );
        if !authority_keys.insert(authority_key) {
          return Err(StorageError::Validation(format!(
            "duplicate endpoint authority on capability {}",
            cap.descriptor.id
          )));
        }
        if authority.max_request_body_bytes == 0
          || authority.max_response_body_bytes == 0
          || authority.max_timeout.is_zero()
        {
          return Err(StorageError::Validation(format!(
            "endpoint authority for capability {} has an empty resource limit",
            cap.descriptor.id
          )));
        }
        match (&authority.auth_policy_id, &reg.auth_policy) {
          (Some(policy_id), Some(binding)) if policy_id == &binding.auth_policy_id => {}
          (Some(_), _) => {
            return Err(StorageError::Validation(format!(
              "endpoint authority for capability {} references an unknown auth policy",
              cap.descriptor.id
            )));
          }
          (None, Some(_)) => {
            return Err(StorageError::Validation(format!(
              "endpoint authority for capability {} omits required auth policy",
              cap.descriptor.id
            )));
          }
          (None, None) => {}
        }
      }
    }
    // Every manifest capability must have a matching definition (preference schema + adapter).
    for cap in &reg.manifest.capabilities {
      if !reg.capabilities.iter().any(|c| c.descriptor.id == cap.id) {
        return Err(StorageError::Validation(format!(
          "manifest capability {} has no matching definition on plugin {}",
          cap.id, reg.manifest.id
        )));
      }
    }
  }
  Ok(())
}

// ---------------------------------------------------------------------------
// Google Cloud
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;
  use crate::services::auth_policies::{
    BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID, BAIDU_OAUTH_AUDIENCE_POLICY_ID, GOOGLE_OAUTH_AUDIENCE_POLICY_ID,
    GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID,
  };

  fn manifest(id: &str) -> crate::domain::service_integration::ServiceIntegrationManifest {
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

  fn registration_with_auth(id: &str, auth_policy: AuthPolicyBinding) -> BundledPluginRegistration {
    let mut registration = test_manifest_registration(manifest(id));
    registration.auth_policy = Some(auth_policy);
    registration
  }

  /// Baidu registers with an empty scope set (driver semantics), before instance credentials exist.
  #[test]
  fn baidu_registration_with_empty_scopes_passes_registration_validation() {
    let registration = registration_with_auth(
      "com.langnext.baidu-ocr",
      AuthPolicyBinding {
        auth_policy_id: BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID.into(),
        auth_driver_id: BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID.into(),
        audience_policy_id: BAIDU_OAUTH_AUDIENCE_POLICY_ID.into(),
        scopes: vec![],
      },
    );
    validate_registrations(&[registration]).expect("Baidu empty-scope registration must pass");
  }

  /// Google service-account registration without scopes fails the driver scope requirement.
  #[test]
  fn google_registration_without_scopes_fails_registration_validation() {
    let registration = registration_with_auth(
      "com.langnext.google-cloud",
      AuthPolicyBinding {
        auth_policy_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
        auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
        audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        scopes: vec![],
      },
    );
    let err = validate_registrations(&[registration]).expect_err("Google registration requires scopes");
    assert!(err.to_string().contains("scope"), "got {err}");
  }

  /// Unknown auth drivers fail closed during registration validation.
  #[test]
  fn registration_with_unknown_auth_driver_fails_closed() {
    let registration = registration_with_auth(
      "com.example.unknown",
      AuthPolicyBinding {
        auth_policy_id: "com.example.auth.unknown".into(),
        auth_driver_id: "com.example.auth.unknown".into(),
        audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        scopes: vec!["https://example.com/scope".into()],
      },
    );
    let err = validate_registrations(&[registration]).expect_err("unknown driver must fail closed");
    assert!(err.to_string().contains("unknown auth driver"), "got {err}");
  }
}
