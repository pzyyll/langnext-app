// ABOUTME: Atomic bundled plugin registrations bundling manifest, schemas, adapters, validators,
// ABOUTME: endpoint/auth policy, and presentation so shared services never branch on plugin id.
use crate::domain::language_detection::supported_languages;
use crate::domain::plugin_schema::{
  CredentialSlotControl, EnumControl, FieldControl, MultiEnumControl, NumberControl, OptionSource, PluginSchemaV1,
  SchemaField, SchemaOption, StringControl, VisibleWhen,
};
use crate::domain::provider::ProxyMode;
use crate::domain::provider_http::ProviderHttpMethod;
use crate::domain::service_capability::{
  EDGE_TTS_PITCH_MAX, EDGE_TTS_PITCH_MIN, EDGE_TTS_STYLES, EDGE_TTS_VOICES, SPEECH_AUDIO_MAX_BYTES, SPEECH_PITCH_MAX,
  SPEECH_PITCH_MIN, SPEECH_PROVIDER_RESPONSE_MAX_BYTES, SPEECH_SPEAKING_RATE_MAX, SPEECH_SPEAKING_RATE_MIN,
};
use crate::domain::service_integration::{
  CredentialSlotDescriptor, CredentialSlotKind, EDGE_TTS_DEFAULT_BASE_URL, EDGE_TTS_PLUGIN_ID, EndpointGrant,
  GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT, GOOGLE_OAUTH_TOKEN_URI,
  GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL, GOOGLE_TRANSLATE_WEB_GTX_ORIGIN, GOOGLE_TRANSLATE_WEB_PLUGIN_ID,
  IntegrationCapabilityDescriptor, ServiceIntegrationManifest,
};
use crate::error::StorageError;
use crate::services::edge_tts::{EDGE_TTS_ENDPOINT_ALIAS, EdgeTtsCapabilities, normalize_edge_tts_base_url};
use crate::services::google_cloud::GoogleCloudCapabilities;
use crate::services::google_translate_web::{GoogleTranslateWebCapabilities, normalize_proxy_url};
use crate::services::network_broker::{
  BROKER_MAX_RESPONSE_BODY_BYTES, BROKER_OCR_REQUEST_BODY_MAX_BYTES, BROKER_REQUEST_BODY_MAX_BYTES, NetworkBroker,
};
use crate::services::plugin_schema::{HostOptionResolver, check_config_readiness, normalize_config, validate_schema};
use crate::services::service_capabilities::{CapabilityHandler, ServiceCapabilityRegistry};
use crate::services::token_grant::{
  GOOGLE_CLOUD_TRANSLATION_SCOPE, GOOGLE_OAUTH_AUDIENCE_POLICY_ID, GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID,
  TokenGrantService,
};
use crate::services::{
  bounded_http::REQUEST_TIMEOUT,
  edge_tts::EDGE_TTS_SYNTHESIS_TIMEOUT,
  google_cloud::SPEECH_SYNTHESIS_TIMEOUT_SECS,
  google_translate_web::{GOOGLE_WEB_MAX_RESPONSE_BODY_BYTES, GOOGLE_WEB_REQUEST_TIMEOUT},
};
use crate::storage::Database;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

/// Dependencies required to construct concrete capability handler implementations.
pub struct HandlerDeps {
  pub db: Database,
  pub broker: Arc<NetworkBroker>,
  pub tokens: Arc<TokenGrantService>,
}

/// Per-registration factory that constructs a capability handler for one capability id,
/// given runtime deps. Each registration owns its factory so adding a plugin requires no
/// shared dispatch edit.
pub type HandlerFactory = Arc<dyn Fn(&HandlerDeps, &str) -> Option<CapabilityHandler> + Send + Sync>;

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
        relative_path.starts_with(prefix)
          && relative_path.ends_with(suffix)
          && relative_path.len() > prefix.len() + suffix.len()
      }
      Self::InstanceConfigured => false,
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
  pub handler_factory: HandlerFactory,
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
    handler_factory: Arc::new(|_deps: &HandlerDeps, _capability_id: &str| Option::<CapabilityHandler>::None),
  }
}

/// Build the deterministic production registration list for all bundled plugins.
pub fn bundled() -> Result<Vec<BundledPluginRegistration>, StorageError> {
  let mut registrations = Vec::new();
  registrations.push(google_cloud_registration()?);
  registrations.push(google_translate_web_registration()?);
  registrations.push(edge_tts_registration()?);
  validate_registrations(&registrations)?;
  Ok(registrations)
}

/// Validate cross-registration uniqueness and per-registration completeness. Every declared
/// capability must have a matching preference schema; schema/policy/slot ids must be unique.
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
      if auth_policy.auth_policy_id.trim().is_empty()
        || auth_policy.auth_driver_id.trim().is_empty()
        || auth_policy.audience_policy_id.trim().is_empty()
        || auth_policy.scopes.is_empty()
      {
        return Err(StorageError::Validation(format!(
          "auth policy binding for {} is incomplete",
          reg.manifest.id
        )));
      }
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

fn google_cloud_registration() -> Result<BundledPluginRegistration, StorageError> {
  let manifest = google_cloud_manifest();
  let config_schema = google_cloud_config_schema();
  let mut credential_validators = HashMap::new();
  credential_validators.insert(
    GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
    Arc::new(GoogleServiceAccountValidator) as Arc<dyn CredentialValidator>,
  );
  let mut capabilities = Vec::new();
  for descriptor in manifest.capabilities.clone() {
    let (schema, adapter, endpoint_authorities) = google_cloud_capability_definition(&descriptor.id);
    capabilities.push(BundledCapabilityDefinition {
      descriptor,
      preference_schema: schema,
      preference_adapter: adapter,
      endpoint_authorities,
    });
  }
  Ok(BundledPluginRegistration {
    manifest,
    config_schema,
    config_adapter: Arc::new(GoogleCloudConfigAdapter),
    credential_validators,
    capabilities,
    endpoint_policy: EndpointPolicy::default(),
    auth_policy: Some(AuthPolicyBinding {
      auth_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
      auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
      audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
      scopes: vec![GOOGLE_CLOUD_TRANSLATION_SCOPE.into()],
    }),
    presentation: PluginPresentation {
      display_name_key: "plugins.googleCloud.name".into(),
      display_name_fallback: "Google Cloud".into(),
      icon: Some("google-cloud".into()),
    },
    handler_factory: Arc::new(|deps, capability_id| {
      use crate::domain::service_capability::{OCR_IMAGE_CAPABILITY_ID, SPEECH_SYNTHESIZE_CAPABILITY_ID};
      use crate::services::google_cloud::{GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID};
      let caps = Arc::new(GoogleCloudCapabilities::new(
        deps.db.clone(),
        deps.broker.clone(),
        deps.tokens.clone(),
      ));
      match capability_id {
        GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID => Some(CapabilityHandler::TranslateText(caps)),
        GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID => Some(CapabilityHandler::DetectLanguage(caps)),
        OCR_IMAGE_CAPABILITY_ID => Some(CapabilityHandler::OcrImage(caps)),
        SPEECH_SYNTHESIZE_CAPABILITY_ID => Some(CapabilityHandler::SpeechSynthesize(caps)),
        _ => None,
      }
    }),
  })
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

fn google_cloud_config_schema() -> PluginSchemaV1 {
  PluginSchemaV1 {
    version: 1,
    fields: vec![
      SchemaField {
        id: "project-id".into(),
        control: FieldControl::String(StringControl {
          max_length: Some(128),
          default: None,
        }),
        label_key: None,
        label_fallback: Some("Project ID".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: true,
        visible_when: None,
      },
      SchemaField {
        id: "location".into(),
        control: FieldControl::String(StringControl {
          max_length: Some(64),
          default: Some(GOOGLE_CLOUD_DEFAULT_LOCATION.into()),
        }),
        label_key: None,
        label_fallback: Some("Location".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: false,
        visible_when: None,
      },
      SchemaField {
        id: "proxy-mode".into(),
        control: FieldControl::Enum(EnumControl {
          source: OptionSource::Fixed {
            options: vec![
              SchemaOption {
                value: "inherit".into(),
                label_key: None,
                label_fallback: Some("Inherit".into()),
              },
              SchemaOption {
                value: "direct".into(),
                label_key: None,
                label_fallback: Some("Direct".into()),
              },
            ],
          },
          default: Some("inherit".into()),
        }),
        label_key: None,
        label_fallback: Some("Proxy Mode".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: false,
        visible_when: None,
      },
      SchemaField {
        id: "service-account".into(),
        control: FieldControl::CredentialSlot(CredentialSlotControl {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
        }),
        label_key: None,
        label_fallback: Some("Service Account JSON".into()),
        description_key: None,
        description_fallback: Some("Paste the Google Cloud service-account JSON key.".into()),
        required_for_ready: true,
        visible_when: None,
      },
    ],
    groups: vec![],
  }
}

/// Google Cloud config adapter: schema normalize + trim project-id/location.
struct GoogleCloudConfigAdapter;

impl PluginConfigAdapter for GoogleCloudConfigAdapter {
  fn config_schema(&self) -> &PluginSchemaV1 {
    // The adapter owns a static schema; store it via OnceCell for cheap access.
    use std::sync::OnceLock;
    static SCHEMA: OnceLock<PluginSchemaV1> = OnceLock::new();
    SCHEMA.get_or_init(google_cloud_config_schema)
  }

  fn normalize_config(&self, config_json: &str) -> Result<String, StorageError> {
    let value: Value = serde_json::from_str(config_json)
      .map_err(|_| StorageError::Validation("config_json must be valid JSON".into()))?;
    let resolver = HostOptionResolver::default();
    let mut normalized = normalize_config(self.config_schema(), &value, &resolver)?;
    // Trim project-id and location; empty location falls back to the schema default.
    if let Some(obj) = normalized.as_object_mut() {
      if let Some(Value::String(s)) = obj.get_mut("project-id") {
        *s = s.trim().to_string();
      }
      if let Some(Value::String(s)) = obj.get_mut("location") {
        let trimmed = s.trim();
        *s = if trimmed.is_empty() {
          GOOGLE_CLOUD_DEFAULT_LOCATION.into()
        } else {
          trimmed.to_string()
        };
      }
    }
    serde_json::to_string(&normalized).map_err(StorageError::from)
  }

  fn config_ready(&self, config_json: &str) -> bool {
    let canonical = match self.normalize_config(config_json) {
      Ok(c) => c,
      Err(_) => return false,
    };
    let value: Value = match serde_json::from_str(&canonical) {
      Ok(v) => v,
      Err(_) => return false,
    };
    let resolver = HostOptionResolver::default();
    check_config_readiness(self.config_schema(), &value, &resolver)
      .map(|r| r.ready)
      .unwrap_or(false)
  }

  fn proxy_mode(&self, config_json: &str) -> ProxyMode {
    let value: Value = match serde_json::from_str(config_json) {
      Ok(v) => v,
      Err(_) => return ProxyMode::Inherit,
    };
    value
      .get("proxy-mode")
      .and_then(|v| v.as_str())
      .and_then(|s| match s {
        "direct" => Some(ProxyMode::Direct),
        "inherit" => Some(ProxyMode::Inherit),
        _ => None,
      })
      .unwrap_or(ProxyMode::Inherit)
  }

  fn instance_endpoint_origin(&self, _config_json: &str, _alias: &str) -> Result<Option<String>, StorageError> {
    Ok(None)
  }
}

/// Google Cloud service-account credential validator (host-owned slot storage preserved).
struct GoogleServiceAccountValidator;

impl CredentialValidator for GoogleServiceAccountValidator {
  fn validate(&self, secret: &str) -> Result<(), StorageError> {
    validate_service_account_json(secret)
  }
}

fn validate_service_account_json(secret: &str) -> Result<(), StorageError> {
  const SERVICE_ACCOUNT_JSON_MAX_LEN: usize = 64 * 1024;
  if secret.len() > SERVICE_ACCOUNT_JSON_MAX_LEN {
    return Err(StorageError::Validation(format!(
      "credential exceeds {SERVICE_ACCOUNT_JSON_MAX_LEN} bytes"
    )));
  }
  if secret.trim().is_empty() {
    return Err(StorageError::Validation("credential value is required".into()));
  }
  let value: Value = serde_json::from_str(secret)
    .map_err(|_| StorageError::Validation("service-account credential must be valid JSON".into()))?;
  let obj = value
    .as_object()
    .ok_or_else(|| StorageError::Validation("service-account credential must be a JSON object".into()))?;
  let client_email = obj
    .get("client_email")
    .and_then(|v| v.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty());
  if client_email.is_none() {
    return Err(StorageError::Validation(
      "service-account JSON requires client_email".into(),
    ));
  }
  let private_key = obj
    .get("private_key")
    .and_then(|v| v.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty());
  if private_key.is_none() {
    return Err(StorageError::Validation(
      "service-account JSON requires private_key".into(),
    ));
  }
  let token_uri = obj
    .get("token_uri")
    .and_then(|v| v.as_str())
    .map(str::trim)
    .unwrap_or("");
  if token_uri != GOOGLE_OAUTH_TOKEN_URI {
    return Err(StorageError::Validation(format!(
      "service-account JSON requires token_uri = {GOOGLE_OAUTH_TOKEN_URI}"
    )));
  }
  Ok(())
}

/// Preference schema/adapter for a Google Cloud capability.
fn google_cloud_capability_definition(
  capability_id: &str,
) -> (
  PluginSchemaV1,
  Arc<dyn CapabilityPreferencesAdapter>,
  Vec<CapabilityEndpointAuthority>,
) {
  let auth_policy_id = Some(GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into());
  let standard_limits = |path| CapabilityEndpointAuthority {
    endpoint_alias: "translate".into(),
    method: ProviderHttpMethod::Post,
    path,
    allowed_query_names: vec![],
    allowed_header_names: vec![],
    auth_policy_id: auth_policy_id.clone(),
    max_request_body_bytes: BROKER_REQUEST_BODY_MAX_BYTES,
    max_response_body_bytes: BROKER_MAX_RESPONSE_BODY_BYTES,
    max_timeout: REQUEST_TIMEOUT,
  };

  match capability_id {
    "translate.text@1" => (
      empty_preference_schema(),
      Arc::new(EmptyPreferencesAdapter),
      vec![standard_limits(CapabilityPathAuthority::PrefixAndSuffix {
        prefix: "v3beta1/projects/".into(),
        suffix: ":translateText".into(),
      })],
    ),
    "translate.detect@1" => (
      empty_preference_schema(),
      Arc::new(EmptyPreferencesAdapter),
      vec![standard_limits(CapabilityPathAuthority::PrefixAndSuffix {
        prefix: "v3beta1/projects/".into(),
        suffix: ":detectLanguage".into(),
      })],
    ),
    "ocr.image@1" => {
      let schema = google_vision_ocr_preference_schema();
      let adapter: Arc<dyn CapabilityPreferencesAdapter> = Arc::new(GoogleVisionOcrPreferencesAdapter);
      let authority = CapabilityEndpointAuthority {
        endpoint_alias: "vision".into(),
        method: ProviderHttpMethod::Post,
        path: CapabilityPathAuthority::Exact("v1/images:annotate".into()),
        allowed_query_names: vec![],
        allowed_header_names: vec![],
        auth_policy_id,
        max_request_body_bytes: BROKER_OCR_REQUEST_BODY_MAX_BYTES,
        max_response_body_bytes: BROKER_MAX_RESPONSE_BODY_BYTES,
        max_timeout: REQUEST_TIMEOUT,
      };
      (schema, adapter, vec![authority])
    }
    "speech.synthesize@1" => {
      let schema = google_cloud_tts_preference_schema();
      let adapter: Arc<dyn CapabilityPreferencesAdapter> = Arc::new(GoogleCloudTtsPreferencesAdapter);
      let authority = CapabilityEndpointAuthority {
        endpoint_alias: "text_to_speech".into(),
        method: ProviderHttpMethod::Post,
        path: CapabilityPathAuthority::Exact("v1/text:synthesize".into()),
        allowed_query_names: vec![],
        allowed_header_names: vec![],
        auth_policy_id,
        max_request_body_bytes: BROKER_REQUEST_BODY_MAX_BYTES,
        max_response_body_bytes: SPEECH_PROVIDER_RESPONSE_MAX_BYTES,
        max_timeout: Duration::from_secs(SPEECH_SYNTHESIS_TIMEOUT_SECS),
      };
      (schema, adapter, vec![authority])
    }
    _ => (empty_preference_schema(), Arc::new(EmptyPreferencesAdapter), vec![]),
  }
}

fn empty_preference_schema() -> PluginSchemaV1 {
  PluginSchemaV1 {
    version: 1,
    fields: vec![],
    groups: vec![],
  }
}

fn google_vision_ocr_preference_schema() -> PluginSchemaV1 {
  PluginSchemaV1 {
    version: 1,
    fields: vec![
      SchemaField {
        id: "operation".into(),
        control: FieldControl::Enum(EnumControl {
          source: OptionSource::Fixed {
            options: vec![
              SchemaOption {
                value: "text_detection".into(),
                label_key: None,
                label_fallback: Some("Text Detection".into()),
              },
              SchemaOption {
                value: "document_text_detection".into(),
                label_key: None,
                label_fallback: Some("Document Text Detection".into()),
              },
            ],
          },
          default: Some("document_text_detection".into()),
        }),
        label_key: None,
        label_fallback: Some("Operation".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: false,
        visible_when: None,
      },
      SchemaField {
        id: "language-hints".into(),
        control: FieldControl::MultiEnum(MultiEnumControl {
          source: OptionSource::Host {
            id: "host.supported-languages@1".into(),
          },
          max_selected: 3,
          default: vec![],
        }),
        label_key: None,
        label_fallback: Some("Language Hints".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: false,
        visible_when: None,
      },
    ],
    groups: vec![],
  }
}

fn google_cloud_tts_preference_schema() -> PluginSchemaV1 {
  PluginSchemaV1 {
    version: 1,
    fields: vec![
      SchemaField {
        id: "speaking-rate".into(),
        control: FieldControl::Number(NumberControl {
          min: Some(SPEECH_SPEAKING_RATE_MIN),
          max: Some(SPEECH_SPEAKING_RATE_MAX),
          step: None,
          default: Some(1.0),
        }),
        label_key: None,
        label_fallback: Some("Speaking Rate".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: false,
        visible_when: None,
      },
      SchemaField {
        id: "pitch".into(),
        control: FieldControl::Number(NumberControl {
          min: Some(SPEECH_PITCH_MIN),
          max: Some(SPEECH_PITCH_MAX),
          step: None,
          default: Some(0.0),
        }),
        label_key: None,
        label_fallback: Some("Pitch".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: false,
        visible_when: None,
      },
    ],
    groups: vec![],
  }
}

struct GoogleVisionOcrPreferencesAdapter;

impl CapabilityPreferencesAdapter for GoogleVisionOcrPreferencesAdapter {
  fn preference_schema(&self) -> &PluginSchemaV1 {
    use std::sync::OnceLock;
    static SCHEMA: OnceLock<PluginSchemaV1> = OnceLock::new();
    SCHEMA.get_or_init(google_vision_ocr_preference_schema)
  }

  fn normalize_preferences(&self, preferences: &Value) -> Result<Value, StorageError> {
    let resolver = host_supported_languages_resolver();
    normalize_config(self.preference_schema(), preferences, &resolver)
      .map_err(|e| StorageError::Validation(format!("invalid OCR preferences: {e}")))
  }
}

struct GoogleCloudTtsPreferencesAdapter;

impl CapabilityPreferencesAdapter for GoogleCloudTtsPreferencesAdapter {
  fn preference_schema(&self) -> &PluginSchemaV1 {
    use std::sync::OnceLock;
    static SCHEMA: OnceLock<PluginSchemaV1> = OnceLock::new();
    SCHEMA.get_or_init(google_cloud_tts_preference_schema)
  }

  fn normalize_preferences(&self, preferences: &Value) -> Result<Value, StorageError> {
    let resolver = HostOptionResolver::default();
    normalize_config(self.preference_schema(), preferences, &resolver)
      .map_err(|e| StorageError::Validation(format!("invalid speech preferences: {e}")))
  }
}

// ---------------------------------------------------------------------------
// Google Translate Web
// ---------------------------------------------------------------------------

fn google_translate_web_registration() -> Result<BundledPluginRegistration, StorageError> {
  let manifest = google_translate_web_manifest();
  let config_schema = google_translate_web_config_schema();
  let mut capabilities = Vec::new();
  for descriptor in manifest.capabilities.clone() {
    let (schema, adapter, endpoint_authorities) = google_web_capability_definition(&descriptor.id);
    capabilities.push(BundledCapabilityDefinition {
      descriptor,
      preference_schema: schema,
      preference_adapter: adapter,
      endpoint_authorities,
    });
  }
  Ok(BundledPluginRegistration {
    manifest,
    config_schema,
    config_adapter: Arc::new(GoogleTranslateWebConfigAdapter),
    credential_validators: HashMap::new(),
    capabilities,
    endpoint_policy: EndpointPolicy {
      allow_instance_endpoints: true,
    },
    auth_policy: None,
    presentation: PluginPresentation {
      display_name_key: "plugins.googleTranslateWeb.name".into(),
      display_name_fallback: "Google Translate Web".into(),
      icon: Some("google-translate-web".into()),
    },
    handler_factory: Arc::new(|deps, capability_id| {
      use crate::services::google_translate_web::{
        GOOGLE_WEB_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID,
      };
      let caps = Arc::new(GoogleTranslateWebCapabilities::new(
        deps.db.clone(),
        deps.broker.clone(),
      ));
      match capability_id {
        GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID => Some(CapabilityHandler::TranslateText(caps)),
        GOOGLE_WEB_DETECT_LANGUAGE_CAPABILITY_ID => Some(CapabilityHandler::DetectLanguage(caps)),
        _ => None,
      }
    }),
  })
}

fn google_translate_web_manifest() -> ServiceIntegrationManifest {
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
        endpoint_aliases: vec!["gtx".into()],
      },
    ],
  }
}

fn google_translate_web_config_schema() -> PluginSchemaV1 {
  PluginSchemaV1 {
    version: 1,
    fields: vec![
      SchemaField {
        id: "channel".into(),
        control: FieldControl::Enum(EnumControl {
          source: OptionSource::Fixed {
            options: vec![
              SchemaOption {
                value: "gtx".into(),
                label_key: None,
                label_fallback: Some("GTX".into()),
              },
              SchemaOption {
                value: "https_proxy".into(),
                label_key: None,
                label_fallback: Some("HTTPS Proxy".into()),
              },
            ],
          },
          default: Some("gtx".into()),
        }),
        label_key: None,
        label_fallback: Some("Channel".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: true,
        visible_when: None,
      },
      SchemaField {
        id: "proxy-url".into(),
        control: FieldControl::String(StringControl {
          max_length: Some(512),
          default: None,
        }),
        label_key: None,
        label_fallback: Some("Proxy URL".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: true,
        visible_when: Some(VisibleWhen {
          field: "channel".into(),
          equals: json!("https_proxy"),
        }),
      },
    ],
    groups: vec![],
  }
}

struct GoogleTranslateWebConfigAdapter;

impl PluginConfigAdapter for GoogleTranslateWebConfigAdapter {
  fn config_schema(&self) -> &PluginSchemaV1 {
    use std::sync::OnceLock;
    static SCHEMA: OnceLock<PluginSchemaV1> = OnceLock::new();
    SCHEMA.get_or_init(google_translate_web_config_schema)
  }

  fn normalize_config(&self, config_json: &str) -> Result<String, StorageError> {
    let value: Value = serde_json::from_str(config_json)
      .map_err(|_| StorageError::Validation("config_json must be valid JSON".into()))?;
    let resolver = HostOptionResolver::default();
    let mut normalized = normalize_config(self.config_schema(), &value, &resolver)?;
    // Semantic validation: normalize the HTTPS proxy URL when channel is https_proxy.
    if let Some(obj) = normalized.as_object() {
      if obj.get("channel").and_then(|v| v.as_str()) == Some("https_proxy") {
        let raw = obj
          .get("proxy-url")
          .and_then(|v| v.as_str())
          .map(str::trim)
          .filter(|s| !s.is_empty())
          .unwrap_or(GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL);
        let normalized_url = normalize_proxy_url(raw).map_err(StorageError::Validation)?;
        if let Some(obj) = normalized.as_object_mut() {
          obj.insert("proxy-url".into(), Value::String(normalized_url.canonical_url));
        }
      }
    }
    serde_json::to_string(&normalized).map_err(StorageError::from)
  }

  fn config_ready(&self, config_json: &str) -> bool {
    let canonical = match self.normalize_config(config_json) {
      Ok(c) => c,
      Err(_) => return false,
    };
    let value: Value = match serde_json::from_str(&canonical) {
      Ok(v) => v,
      Err(_) => return false,
    };
    let resolver = HostOptionResolver::default();
    check_config_readiness(self.config_schema(), &value, &resolver)
      .map(|r| r.ready)
      .unwrap_or(false)
  }

  fn proxy_mode(&self, _config_json: &str) -> ProxyMode {
    ProxyMode::Inherit
  }

  fn instance_endpoint_origin(&self, config_json: &str, alias: &str) -> Result<Option<String>, StorageError> {
    if alias != "https_proxy" {
      return Ok(None);
    }
    let canonical = self.normalize_config(config_json)?;
    let value: Value = serde_json::from_str(&canonical).map_err(StorageError::from)?;
    if value.get("channel").and_then(|v| v.as_str()) != Some("https_proxy") {
      return Ok(None);
    }
    let raw = value
      .get("proxy-url")
      .and_then(|v| v.as_str())
      .unwrap_or(GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL);
    let normalized = normalize_proxy_url(raw).map_err(StorageError::Validation)?;
    Ok(Some(normalized.origin))
  }

  fn instance_endpoint_relative_path(&self, config_json: &str, alias: &str) -> Result<Option<String>, StorageError> {
    if alias != "https_proxy" {
      return Ok(None);
    }
    let canonical = self.normalize_config(config_json)?;
    let value: Value = serde_json::from_str(&canonical).map_err(StorageError::from)?;
    if value.get("channel").and_then(|v| v.as_str()) != Some("https_proxy") {
      return Ok(None);
    }
    let raw = value
      .get("proxy-url")
      .and_then(|v| v.as_str())
      .unwrap_or(GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL);
    let normalized = normalize_proxy_url(raw).map_err(StorageError::Validation)?;
    Ok(Some(normalized.relative_path))
  }
}

fn google_web_capability_definition(
  capability_id: &str,
) -> (
  PluginSchemaV1,
  Arc<dyn CapabilityPreferencesAdapter>,
  Vec<CapabilityEndpointAuthority>,
) {
  let gtx_authority = CapabilityEndpointAuthority {
    endpoint_alias: "gtx".into(),
    method: ProviderHttpMethod::Get,
    path: CapabilityPathAuthority::Exact("translate_a/single".into()),
    allowed_query_names: vec![
      "client".into(),
      "sl".into(),
      "tl".into(),
      "hl".into(),
      "dt".into(),
      "ie".into(),
      "oe".into(),
      "q".into(),
    ],
    allowed_header_names: vec![],
    auth_policy_id: None,
    max_request_body_bytes: BROKER_REQUEST_BODY_MAX_BYTES,
    max_response_body_bytes: GOOGLE_WEB_MAX_RESPONSE_BODY_BYTES,
    max_timeout: GOOGLE_WEB_REQUEST_TIMEOUT,
  };
  match capability_id {
    "translate.text@1" => {
      let proxy_authority = CapabilityEndpointAuthority {
        endpoint_alias: "https_proxy".into(),
        method: ProviderHttpMethod::Post,
        path: CapabilityPathAuthority::InstanceConfigured,
        allowed_query_names: vec![],
        allowed_header_names: vec![],
        auth_policy_id: None,
        max_request_body_bytes: BROKER_REQUEST_BODY_MAX_BYTES,
        max_response_body_bytes: GOOGLE_WEB_MAX_RESPONSE_BODY_BYTES,
        max_timeout: GOOGLE_WEB_REQUEST_TIMEOUT,
      };
      (
        empty_preference_schema(),
        Arc::new(EmptyPreferencesAdapter),
        vec![gtx_authority, proxy_authority],
      )
    }
    "translate.detect@1" => (
      empty_preference_schema(),
      Arc::new(EmptyPreferencesAdapter),
      vec![gtx_authority],
    ),
    _ => (empty_preference_schema(), Arc::new(EmptyPreferencesAdapter), vec![]),
  }
}

// ---------------------------------------------------------------------------
// Edge TTS
// ---------------------------------------------------------------------------

fn edge_tts_registration() -> Result<BundledPluginRegistration, StorageError> {
  let manifest = edge_tts_manifest();
  let config_schema = edge_tts_config_schema();
  let mut capabilities = Vec::new();
  for descriptor in manifest.capabilities.clone() {
    let (schema, adapter, endpoint_authorities) = edge_tts_capability_definition(&descriptor.id);
    capabilities.push(BundledCapabilityDefinition {
      descriptor,
      preference_schema: schema,
      preference_adapter: adapter,
      endpoint_authorities,
    });
  }
  Ok(BundledPluginRegistration {
    manifest,
    config_schema,
    config_adapter: Arc::new(EdgeTtsConfigAdapter),
    credential_validators: HashMap::new(),
    capabilities,
    endpoint_policy: EndpointPolicy {
      allow_instance_endpoints: true,
    },
    auth_policy: None,
    presentation: PluginPresentation {
      display_name_key: "plugins.edgeTts.name".into(),
      display_name_fallback: "Edge TTS".into(),
      icon: Some("edge-tts".into()),
    },
    handler_factory: Arc::new(|deps, capability_id| {
      use crate::domain::service_capability::SPEECH_SYNTHESIZE_CAPABILITY_ID;
      let caps = Arc::new(EdgeTtsCapabilities::new(deps.broker.clone()));
      match capability_id {
        SPEECH_SYNTHESIZE_CAPABILITY_ID => Some(CapabilityHandler::SpeechSynthesize(caps)),
        _ => None,
      }
    }),
  })
}

fn edge_tts_manifest() -> ServiceIntegrationManifest {
  ServiceIntegrationManifest {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: EDGE_TTS_PLUGIN_ID.into(),
    version: "1.0.0".into(),
    display_name_key: "plugins.edgeTts.name".into(),
    min_host_version: "0.1.0".into(),
    config_schema_version: 1,
    credential_slots: vec![],
    endpoints: vec![EndpointGrant {
      alias: EDGE_TTS_ENDPOINT_ALIAS.into(),
      // The config adapter replaces this pinned default with the normalized instance URL.
      base_url: EDGE_TTS_DEFAULT_BASE_URL.into(),
    }],
    capabilities: vec![IntegrationCapabilityDescriptor {
      id: "speech.synthesize@1".into(),
      preferences_schema_version: 1,
      endpoint_aliases: vec![EDGE_TTS_ENDPOINT_ALIAS.into()],
    }],
  }
}

fn edge_tts_config_schema() -> PluginSchemaV1 {
  PluginSchemaV1 {
    version: 1,
    fields: vec![SchemaField {
      id: "base-url".into(),
      control: FieldControl::String(StringControl {
        max_length: Some(512),
        default: Some(EDGE_TTS_DEFAULT_BASE_URL.into()),
      }),
      label_key: None,
      label_fallback: Some("Base URL".into()),
      description_key: None,
      description_fallback: None,
      required_for_ready: false,
      visible_when: None,
    }],
    groups: vec![],
  }
}

struct EdgeTtsConfigAdapter;

impl PluginConfigAdapter for EdgeTtsConfigAdapter {
  fn config_schema(&self) -> &PluginSchemaV1 {
    use std::sync::OnceLock;
    static SCHEMA: OnceLock<PluginSchemaV1> = OnceLock::new();
    SCHEMA.get_or_init(edge_tts_config_schema)
  }

  fn normalize_config(&self, config_json: &str) -> Result<String, StorageError> {
    let value: Value = serde_json::from_str(config_json)
      .map_err(|_| StorageError::Validation("config_json must be valid JSON".into()))?;
    let resolver = HostOptionResolver::default();
    let mut normalized = normalize_config(self.config_schema(), &value, &resolver)?;
    // Semantic validation: normalize the API base URL.
    if let Some(obj) = normalized.as_object() {
      let raw = obj
        .get("base-url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(EDGE_TTS_DEFAULT_BASE_URL);
      let normalized_url = normalize_edge_tts_base_url(raw).map_err(StorageError::Validation)?;
      if let Some(obj) = normalized.as_object_mut() {
        obj.insert("base-url".into(), Value::String(normalized_url.canonical_url));
      }
    }
    serde_json::to_string(&normalized).map_err(StorageError::from)
  }

  fn config_ready(&self, config_json: &str) -> bool {
    self.normalize_config(config_json).is_ok()
  }

  fn proxy_mode(&self, _config_json: &str) -> ProxyMode {
    ProxyMode::Inherit
  }

  fn instance_endpoint_origin(&self, config_json: &str, alias: &str) -> Result<Option<String>, StorageError> {
    if alias != EDGE_TTS_ENDPOINT_ALIAS {
      return Ok(None);
    }
    let canonical = self.normalize_config(config_json)?;
    let value: Value = serde_json::from_str(&canonical).map_err(StorageError::from)?;
    let raw = value
      .get("base-url")
      .and_then(|v| v.as_str())
      .unwrap_or(EDGE_TTS_DEFAULT_BASE_URL);
    let normalized = normalize_edge_tts_base_url(raw).map_err(StorageError::Validation)?;
    Ok(Some(normalized.canonical_url))
  }
}

fn edge_tts_capability_definition(
  capability_id: &str,
) -> (
  PluginSchemaV1,
  Arc<dyn CapabilityPreferencesAdapter>,
  Vec<CapabilityEndpointAuthority>,
) {
  let schema = edge_tts_preference_schema();
  let adapter: Arc<dyn CapabilityPreferencesAdapter> = Arc::new(EdgeTtsPreferencesAdapter);
  let endpoint_authorities = if capability_id == "speech.synthesize@1" {
    vec![CapabilityEndpointAuthority {
      endpoint_alias: EDGE_TTS_ENDPOINT_ALIAS.into(),
      method: ProviderHttpMethod::Post,
      path: CapabilityPathAuthority::Exact("v1/audio/speech".into()),
      allowed_query_names: vec![],
      allowed_header_names: vec!["accept".into()],
      auth_policy_id: None,
      max_request_body_bytes: BROKER_REQUEST_BODY_MAX_BYTES,
      max_response_body_bytes: SPEECH_AUDIO_MAX_BYTES,
      max_timeout: EDGE_TTS_SYNTHESIS_TIMEOUT,
    }]
  } else {
    vec![]
  };
  (schema, adapter, endpoint_authorities)
}

fn edge_tts_preference_schema() -> PluginSchemaV1 {
  let voice_options = EDGE_TTS_VOICES
    .iter()
    .map(|v| SchemaOption {
      value: (*v).into(),
      label_key: None,
      label_fallback: None,
    })
    .collect();
  let style_options = EDGE_TTS_STYLES
    .iter()
    .map(|s| SchemaOption {
      value: (*s).into(),
      label_key: None,
      label_fallback: None,
    })
    .collect();
  PluginSchemaV1 {
    version: 1,
    fields: vec![
      SchemaField {
        id: "voice".into(),
        control: FieldControl::Enum(EnumControl {
          source: OptionSource::Fixed { options: voice_options },
          default: Some("zh-CN-XiaoxiaoNeural".into()),
        }),
        label_key: None,
        label_fallback: Some("Voice".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: false,
        visible_when: None,
      },
      SchemaField {
        id: "speed".into(),
        control: FieldControl::Number(NumberControl {
          min: Some(0.5),
          max: Some(2.0),
          step: None,
          default: Some(1.0),
        }),
        label_key: None,
        label_fallback: Some("Speed".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: false,
        visible_when: None,
      },
      SchemaField {
        id: "pitch".into(),
        control: FieldControl::Number(NumberControl {
          min: Some(EDGE_TTS_PITCH_MIN),
          max: Some(EDGE_TTS_PITCH_MAX),
          step: None,
          default: Some(0.0),
        }),
        label_key: None,
        label_fallback: Some("Pitch".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: false,
        visible_when: None,
      },
      SchemaField {
        id: "style".into(),
        control: FieldControl::Enum(EnumControl {
          source: OptionSource::Fixed { options: style_options },
          default: Some("general".into()),
        }),
        label_key: None,
        label_fallback: Some("Style".into()),
        description_key: None,
        description_fallback: None,
        required_for_ready: false,
        visible_when: None,
      },
    ],
    groups: vec![],
  }
}

struct EdgeTtsPreferencesAdapter;

impl CapabilityPreferencesAdapter for EdgeTtsPreferencesAdapter {
  fn preference_schema(&self) -> &PluginSchemaV1 {
    use std::sync::OnceLock;
    static SCHEMA: OnceLock<PluginSchemaV1> = OnceLock::new();
    SCHEMA.get_or_init(edge_tts_preference_schema)
  }

  fn normalize_preferences(&self, preferences: &Value) -> Result<Value, StorageError> {
    let resolver = HostOptionResolver::default();
    normalize_config(self.preference_schema(), preferences, &resolver)
      .map_err(|e| StorageError::Validation(format!("invalid Edge TTS preferences: {e}")))
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Empty preference schema/adapter for capabilities with no runtime preferences.
struct EmptyPreferencesAdapter;

impl CapabilityPreferencesAdapter for EmptyPreferencesAdapter {
  fn preference_schema(&self) -> &PluginSchemaV1 {
    use std::sync::OnceLock;
    static SCHEMA: OnceLock<PluginSchemaV1> = OnceLock::new();
    SCHEMA.get_or_init(|| PluginSchemaV1 {
      version: 1,
      fields: vec![],
      groups: vec![],
    })
  }

  fn normalize_preferences(&self, preferences: &Value) -> Result<Value, StorageError> {
    normalize_config(self.preference_schema(), preferences, &HostOptionResolver::default())
      .map_err(|e| StorageError::Validation(format!("invalid preferences: {e}")))
  }
}

/// Build a host option resolver from the current application-supported language set.
fn host_supported_languages_resolver() -> HostOptionResolver {
  HostOptionResolver::supported_languages(supported_languages().iter().map(|s| s.to_string()))
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/// Build the production capability handler registry from the bundled registrations. Each
/// registration's own `handler_factory` constructs concrete implementations; no shared plugin-ID
/// dispatch remains. Fails closed if any declared capability lacks a matching handler.
pub fn build_capability_registry(
  deps: HandlerDeps,
  registry: &crate::services::service_integration_registry::ServiceIntegrationRegistry,
) -> Result<ServiceCapabilityRegistry, StorageError> {
  let mut handler_registry = ServiceCapabilityRegistry::new();
  for reg in registry.registrations() {
    for cap in &reg.manifest.capabilities {
      let handler = (reg.handler_factory)(&deps, &cap.id).ok_or_else(|| {
        StorageError::Validation(format!(
          "no handler for capability {} on plugin {}",
          cap.id, reg.manifest.id
        ))
      })?;
      handler_registry.register(reg.manifest.id.clone(), cap.id.clone(), handler);
    }
  }
  Ok(handler_registry)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bundled_registrations_validate() {
    let registrations = bundled().expect("bundled registrations must validate");
    assert_eq!(registrations.len(), 3);
    let ids: Vec<&str> = registrations.iter().map(|r| r.manifest.id.as_str()).collect();
    assert!(ids.contains(&GOOGLE_CLOUD_PLUGIN_ID));
    assert!(ids.contains(&GOOGLE_TRANSLATE_WEB_PLUGIN_ID));
    assert!(ids.contains(&EDGE_TTS_PLUGIN_ID));
  }

  #[test]
  fn every_capability_has_preference_schema() {
    let registrations = bundled().unwrap();
    for reg in &registrations {
      for cap in &reg.manifest.capabilities {
        assert!(
          reg.capability(&cap.id).is_some(),
          "capability {} on {} lacks a definition",
          cap.id,
          reg.manifest.id
        );
      }
    }
  }

  #[test]
  fn google_cloud_config_adapter_normalizes_and_reports_ready() {
    let registrations = bundled().unwrap();
    let reg = registrations
      .iter()
      .find(|r| r.manifest.id == GOOGLE_CLOUD_PLUGIN_ID)
      .unwrap();
    let canonical = reg
      .config_adapter
      .normalize_config(&json!({"project-id": "  my-project  "}).to_string())
      .unwrap();
    let value: Value = serde_json::from_str(&canonical).unwrap();
    assert_eq!(value["project-id"], json!("my-project"));
    assert_eq!(value["location"], json!("global"));
    assert_eq!(value["proxy-mode"], json!("inherit"));
    assert!(reg.config_adapter.config_ready(&canonical));
    assert!(!reg.config_adapter.config_ready(&json!({}).to_string()));
    // Unknown keys rejected.
    assert!(
      reg
        .config_adapter
        .normalize_config(&json!({"projectId": "x"}).to_string())
        .is_err()
    );
  }

  #[test]
  fn google_web_config_adapter_proxy_channel_requires_url() {
    let registrations = bundled().unwrap();
    let reg = registrations
      .iter()
      .find(|r| r.manifest.id == GOOGLE_TRANSLATE_WEB_PLUGIN_ID)
      .unwrap();
    // GTX channel is ready without proxy-url.
    let gtx = reg
      .config_adapter
      .normalize_config(&json!({"channel": "gtx"}).to_string())
      .unwrap();
    assert!(reg.config_adapter.config_ready(&gtx));
    // https_proxy channel auto-fills the default proxy URL when none is provided.
    assert!(
      reg
        .config_adapter
        .config_ready(&json!({"channel": "https_proxy"}).to_string())
    );
    let proxy = reg
      .config_adapter
      .normalize_config(
        &json!({"channel": "https_proxy", "proxy-url": "https://googlet.deno.dev/translate"}).to_string(),
      )
      .unwrap();
    assert!(reg.config_adapter.config_ready(&proxy));
    let origin = reg
      .config_adapter
      .instance_endpoint_origin(&proxy, "https_proxy")
      .unwrap();
    assert_eq!(origin.as_deref(), Some("https://googlet.deno.dev"));
  }

  #[test]
  fn edge_tts_config_adapter_normalizes_base_url() {
    let registrations = bundled().unwrap();
    let reg = registrations
      .iter()
      .find(|r| r.manifest.id == EDGE_TTS_PLUGIN_ID)
      .unwrap();
    let canonical = reg
      .config_adapter
      .normalize_config(&json!({"base-url": "https://tts.wangwangit.com/v1"}).to_string())
      .unwrap();
    let value: Value = serde_json::from_str(&canonical).unwrap();
    assert_eq!(value["base-url"], json!("https://tts.wangwangit.com/v1"));
    assert!(reg.config_adapter.config_ready(&canonical));
    // Invalid scheme rejected.
    assert!(
      reg
        .config_adapter
        .normalize_config(&json!({"base-url": "http://insecure"}).to_string())
        .is_err()
    );
  }

  #[test]
  fn google_cloud_service_account_validator_rejects_bad_json() {
    let validator = GoogleServiceAccountValidator;
    assert!(validator.validate("not json").is_err());
    assert!(
      validator
        .validate(&json!({"client_email": "bot@example.com"}).to_string())
        .is_err()
    );
    let valid = json!({
      "client_email": "bot@example.iam.gserviceaccount.com",
      "private_key": "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n",
      "token_uri": GOOGLE_OAUTH_TOKEN_URI,
    })
    .to_string();
    assert!(validator.validate(&valid).is_ok());
  }

  #[test]
  fn preference_adapters_normalize_defaults() {
    let registrations = bundled().unwrap();
    let tts = registrations
      .iter()
      .find(|r| r.manifest.id == GOOGLE_CLOUD_PLUGIN_ID)
      .unwrap()
      .capability("speech.synthesize@1")
      .unwrap();
    let normalized = tts.preference_adapter.normalize_preferences(&json!({})).unwrap();
    assert_eq!(normalized["speaking-rate"], json!(1.0));
    assert_eq!(normalized["pitch"], json!(0.0));

    let edge = registrations
      .iter()
      .find(|r| r.manifest.id == EDGE_TTS_PLUGIN_ID)
      .unwrap()
      .capability("speech.synthesize@1")
      .unwrap();
    let normalized = edge.preference_adapter.normalize_preferences(&json!({})).unwrap();
    assert_eq!(normalized["voice"], json!("zh-CN-XiaoxiaoNeural"));
    assert_eq!(normalized["style"], json!("general"));
    // Unsupported voice rejected.
    assert!(
      edge
        .preference_adapter
        .normalize_preferences(&json!({"voice": "bogus"}))
        .is_err()
    );
  }

  #[test]
  fn ocr_preference_adapter_rejects_unsupported_language() {
    let registrations = bundled().unwrap();
    let ocr = registrations
      .iter()
      .find(|r| r.manifest.id == GOOGLE_CLOUD_PLUGIN_ID)
      .unwrap()
      .capability("ocr.image@1")
      .unwrap();
    assert!(
      ocr
        .preference_adapter
        .normalize_preferences(&json!({"language-hints": ["en", "zh"]}))
        .is_ok()
    );
    assert!(
      ocr
        .preference_adapter
        .normalize_preferences(&json!({"language-hints": ["xx"]}))
        .is_err()
    );
    assert!(
      ocr
        .preference_adapter
        .normalize_preferences(&json!({"language-hints": ["en", "zh", "fr", "de"]}))
        .is_err()
    );
  }

  #[test]
  fn build_capability_registry_registers_all_handlers() {
    use crate::services::network_broker::NetworkBroker;
    use crate::services::service_integration_registry::ServiceIntegrationRegistry;
    use crate::services::token_grant::TokenGrantService;
    use crate::storage::Database;

    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let broker = Arc::new(NetworkBroker::new(db.clone(), registry.clone()));
    let tokens = Arc::new(TokenGrantService::new(Arc::new(
      crate::services::google_service_account::GoogleServiceAccountExchanger::new(
        db.clone(),
        Arc::new(crate::credentials::MemoryCredentialVault::default()),
      ),
    )));
    let handlers = build_capability_registry(
      HandlerDeps {
        db: db.clone(),
        broker,
        tokens,
      },
      &registry,
    )
    .expect("build_capability_registry must succeed");

    // Google Cloud: 4 capabilities.
    assert!(handlers.get(GOOGLE_CLOUD_PLUGIN_ID, "translate.text@1").is_some());
    assert!(handlers.get(GOOGLE_CLOUD_PLUGIN_ID, "translate.detect@1").is_some());
    assert!(handlers.get(GOOGLE_CLOUD_PLUGIN_ID, "ocr.image@1").is_some());
    assert!(handlers.get(GOOGLE_CLOUD_PLUGIN_ID, "speech.synthesize@1").is_some());
    // Google Translate Web: 2 capabilities.
    assert!(
      handlers
        .get(GOOGLE_TRANSLATE_WEB_PLUGIN_ID, "translate.text@1")
        .is_some()
    );
    assert!(
      handlers
        .get(GOOGLE_TRANSLATE_WEB_PLUGIN_ID, "translate.detect@1")
        .is_some()
    );
    // Edge TTS: 1 capability.
    assert!(handlers.get(EDGE_TTS_PLUGIN_ID, "speech.synthesize@1").is_some());
  }
}
