// ABOUTME: Provider instance domain entities, write inputs, and sanitized DTOs.
// ABOUTME: Credential secrets and references never appear on IPC DTOs.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Maximum length for generic auth header or query parameter names.
pub const MAX_AUTH_SCHEME_NAME_LEN: usize = 64;

/// Restricted header/query names that must not be used as generic auth scheme names.
const RESTRICTED_AUTH_SCHEME_NAMES: &[&str] = &[
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
  None,
  ApiKey,
  Bearer,
}

impl CredentialKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::None => "none",
      Self::ApiKey => "api_key",
      Self::Bearer => "bearer",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "none" => Ok(Self::None),
      "api_key" => Ok(Self::ApiKey),
      "bearer" => Ok(Self::Bearer),
      other => Err(format!("invalid credential_kind: {other}")),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyMode {
  Inherit,
  Direct,
}

impl ProxyMode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Inherit => "inherit",
      Self::Direct => "direct",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "inherit" => Ok(Self::Inherit),
      "direct" => Ok(Self::Direct),
      other => Err(format!("invalid proxy_mode: {other}")),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelsSyncStatus {
  Never,
  Ok,
  Error,
}

impl ModelsSyncStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Never => "never",
      Self::Ok => "ok",
      Self::Error => "error",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "never" => Ok(Self::Never),
      "ok" => Ok(Self::Ok),
      "error" => Ok(Self::Error),
      other => Err(format!("invalid models_sync_status: {other}")),
    }
  }
}

/// Whether the persisted Base URL came from a plugin default or an explicit custom value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BaseUrlSource {
  PluginDefault,
  Custom,
}

impl BaseUrlSource {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::PluginDefault => "plugin_default",
      Self::Custom => "custom",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "plugin_default" => Ok(Self::PluginDefault),
      "custom" => Ok(Self::Custom),
      other => Err(format!("invalid base_url_source: {other}")),
    }
  }
}

/// Versioned generic auth scheme persisted with each provider instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthSchemeV1 {
  #[serde(rename = "none")]
  None {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
  },
  #[serde(rename = "bearer")]
  Bearer {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
  },
  #[serde(rename = "header")]
  Header {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    name: String,
  },
  #[serde(rename = "query")]
  Query {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    name: String,
  },
}

impl AuthSchemeV1 {
  pub const SCHEMA_VERSION: u32 = 1;

  pub fn none() -> Self {
    Self::None {
      schema_version: Self::SCHEMA_VERSION,
    }
  }

  pub fn bearer() -> Self {
    Self::Bearer {
      schema_version: Self::SCHEMA_VERSION,
    }
  }

  pub fn header(name: impl Into<String>) -> Self {
    Self::Header {
      schema_version: Self::SCHEMA_VERSION,
      name: name.into(),
    }
  }

  pub fn query(name: impl Into<String>) -> Self {
    Self::Query {
      schema_version: Self::SCHEMA_VERSION,
      name: name.into(),
    }
  }

  pub fn schema_version(&self) -> u32 {
    match self {
      Self::None { schema_version }
      | Self::Bearer { schema_version }
      | Self::Header { schema_version, .. }
      | Self::Query { schema_version, .. } => *schema_version,
    }
  }

  /// Validate schema version, name token rules, and restricted names.
  pub fn validate(&self) -> Result<(), String> {
    if self.schema_version() != Self::SCHEMA_VERSION {
      return Err(format!(
        "unsupported auth scheme schemaVersion {}",
        self.schema_version()
      ));
    }
    match self {
      Self::None { .. } | Self::Bearer { .. } => Ok(()),
      Self::Header { name, .. } | Self::Query { name, .. } => validate_auth_scheme_name(name),
    }
  }

  /// Compatibility matrix with stored credential kinds.
  pub fn compatible_with(&self, credential_kind: CredentialKind) -> bool {
    match self {
      Self::None { .. } => matches!(credential_kind, CredentialKind::None),
      Self::Bearer { .. } | Self::Header { .. } | Self::Query { .. } => {
        matches!(credential_kind, CredentialKind::ApiKey | CredentialKind::Bearer)
      }
    }
  }

  /// Derive the built-in auth scheme from adapter id + credential kind (migration/import).
  pub fn from_builtin_adapter(adapter_id: &str, credential_kind: CredentialKind) -> Option<Self> {
    match adapter_id {
      "anthropic" => Some(Self::header("x-api-key")),
      "gemini" => Some(Self::query("key")),
      "openai-compatible" | "openai-responses" | "deepseek" => match credential_kind {
        CredentialKind::None => Some(Self::none()),
        CredentialKind::ApiKey | CredentialKind::Bearer => Some(Self::bearer()),
      },
      _ => None,
    }
  }

  pub fn to_json_string(&self) -> Result<String, String> {
    self.validate()?;
    serde_json::to_string(self).map_err(|e| format!("serialize auth scheme: {e}"))
  }

  pub fn from_json_str(raw: &str) -> Result<Self, String> {
    let scheme: Self = serde_json::from_str(raw).map_err(|e| format!("invalid auth scheme JSON: {e}"))?;
    scheme.validate()?;
    Ok(scheme)
  }
}

/// Validate ASCII token header/query names for generic auth schemes.
pub fn validate_auth_scheme_name(name: &str) -> Result<(), String> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err("auth scheme name must not be empty".into());
  }
  if trimmed.len() > MAX_AUTH_SCHEME_NAME_LEN {
    return Err(format!(
      "auth scheme name must be at most {MAX_AUTH_SCHEME_NAME_LEN} characters"
    ));
  }
  if trimmed != name {
    return Err("auth scheme name must not have leading or trailing whitespace".into());
  }
  if !trimmed
    .bytes()
    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
  {
    return Err("auth scheme name must be an ASCII token".into());
  }
  let lower = trimmed.to_ascii_lowercase();
  if RESTRICTED_AUTH_SCHEME_NAMES.contains(&lower.as_str()) {
    return Err(format!("auth scheme name '{trimmed}' is restricted"));
  }
  Ok(())
}

/// Structural validation for plugin/adapter IDs. Unknown IDs are allowed when well-formed.
pub fn validate_adapter_id(adapter_id: &str) -> Result<(), String> {
  let trimmed = adapter_id.trim();
  if trimmed.is_empty() {
    return Err("adapter_id must not be empty".into());
  }
  if trimmed.len() > 128 {
    return Err("adapter_id must be at most 128 characters".into());
  }
  if trimmed != adapter_id {
    return Err("adapter_id must not have leading or trailing whitespace".into());
  }
  // Stable plugin IDs: lowercase alnum with hyphen separators (e.g. openai-compatible).
  let mut chars = trimmed.chars();
  let Some(first) = chars.next() else {
    return Err("adapter_id must not be empty".into());
  };
  if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
    return Err("adapter_id must start with a lowercase letter or digit".into());
  }
  if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
    return Err("adapter_id must contain only lowercase letters, digits, and hyphens".into());
  }
  if trimmed.contains("--") || trimmed.ends_with('-') {
    return Err("adapter_id must not contain consecutive or trailing hyphens".into());
  }
  Ok(())
}

/// Built-in default Base URL for known plugins (migration/import helpers).
pub fn builtin_default_base_url(adapter_id: &str) -> Option<&'static str> {
  match adapter_id {
    "openai-compatible" | "openai-responses" => Some("https://api.openai.com/v1"),
    "anthropic" => Some("https://api.anthropic.com"),
    "gemini" => Some("https://generativelanguage.googleapis.com"),
    "deepseek" => Some("https://api.deepseek.com"),
    _ => None,
  }
}

/// Internal Provider row including opaque credential reference.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstance {
  pub id: Uuid,
  pub adapter_id: String,
  pub display_name: String,
  pub base_url: String,
  pub base_url_source: BaseUrlSource,
  pub auth_scheme: AuthSchemeV1,
  pub credential_kind: CredentialKind,
  pub credential_ref: Option<String>,
  pub enabled: bool,
  pub proxy_mode: ProxyMode,
  pub insecure_http_confirmed_at: Option<String>,
  pub models_synced_at: Option<String>,
  pub models_sync_status: ModelsSyncStatus,
  pub models_sync_error_code: Option<String>,
  pub created_at: String,
  pub updated_at: String,
}

/// Sanitized Provider DTO for IPC. Never includes credential_ref.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstanceDto {
  pub id: Uuid,
  pub adapter_id: String,
  pub display_name: String,
  pub base_url: String,
  pub base_url_source: BaseUrlSource,
  pub auth_scheme: AuthSchemeV1,
  pub credential_kind: CredentialKind,
  pub has_credential: bool,
  pub enabled: bool,
  pub proxy_mode: ProxyMode,
  pub insecure_http_confirmed_at: Option<String>,
  pub models_synced_at: Option<String>,
  pub models_sync_status: ModelsSyncStatus,
  pub models_sync_error_code: Option<String>,
  pub created_at: String,
  pub updated_at: String,
}

impl From<&ProviderInstance> for ProviderInstanceDto {
  fn from(value: &ProviderInstance) -> Self {
    Self {
      id: value.id,
      adapter_id: value.adapter_id.clone(),
      display_name: value.display_name.clone(),
      base_url: value.base_url.clone(),
      base_url_source: value.base_url_source,
      auth_scheme: value.auth_scheme.clone(),
      credential_kind: value.credential_kind,
      has_credential: value.credential_ref.is_some(),
      enabled: value.enabled,
      proxy_mode: value.proxy_mode,
      insecure_http_confirmed_at: value.insecure_http_confirmed_at.clone(),
      models_synced_at: value.models_synced_at.clone(),
      models_sync_status: value.models_sync_status,
      models_sync_error_code: value.models_sync_error_code.clone(),
      created_at: value.created_at.clone(),
      updated_at: value.updated_at.clone(),
    }
  }
}

/// Credential mutation for Provider writes. Secrets are never printed via Debug.
#[derive(Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", tag = "action", content = "value")]
pub enum CredentialUpdate {
  #[default]
  Keep,
  Replace(String),
  Clear,
}

impl std::fmt::Debug for CredentialUpdate {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Keep => write!(f, "Keep"),
      Self::Replace(_) => write!(f, "Replace([redacted])"),
      Self::Clear => write!(f, "Clear"),
    }
  }
}

/// Input for creating or updating a Provider instance.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstanceWrite {
  pub id: Option<Uuid>,
  pub adapter_id: String,
  pub display_name: String,
  pub base_url: String,
  pub base_url_source: BaseUrlSource,
  pub auth_scheme: AuthSchemeV1,
  pub credential_kind: CredentialKind,
  pub credential: CredentialUpdate,
  pub enabled: bool,
  pub proxy_mode: ProxyMode,
  pub insecure_http_confirmed_at: Option<String>,
  /// Optimistic concurrency baseline (`ProviderInstance.updated_at` when the form was loaded).
  /// Required when `id` is Some; ignored on create.
  #[serde(default)]
  pub expected_updated_at: Option<String>,
}

/// Export-only Provider shape (no credentials, sync errors, or device fields).
///
/// Deserialization accepts v2 documents (baseUrlOverride only) and normalizes via
/// [`ProviderExport::normalize_transport`]. Current exports always set v3 fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderExport {
  pub id: Uuid,
  pub adapter_id: String,
  pub display_name: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub base_url: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub base_url_source: Option<BaseUrlSource>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub auth_scheme: Option<AuthSchemeV1>,
  /// Legacy v2 field; never written by current exports.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub base_url_override: Option<String>,
  pub credential_kind: CredentialKind,
  pub enabled: bool,
  pub proxy_mode: ProxyMode,
  pub insecure_http_confirmed_at: Option<String>,
  pub created_at: String,
  pub updated_at: String,
}

/// Normalized transport identity after v2→v3 migration or current-format validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedProviderTransport {
  pub base_url: String,
  pub base_url_source: BaseUrlSource,
  pub auth_scheme: AuthSchemeV1,
}

impl From<&ProviderInstance> for ProviderExport {
  fn from(value: &ProviderInstance) -> Self {
    Self {
      id: value.id,
      adapter_id: value.adapter_id.clone(),
      display_name: value.display_name.clone(),
      base_url: Some(value.base_url.clone()),
      base_url_source: Some(value.base_url_source),
      auth_scheme: Some(value.auth_scheme.clone()),
      base_url_override: None,
      credential_kind: value.credential_kind,
      enabled: value.enabled,
      proxy_mode: value.proxy_mode,
      insecure_http_confirmed_at: value.insecure_http_confirmed_at.clone(),
      created_at: value.created_at.clone(),
      updated_at: value.updated_at.clone(),
    }
  }
}

impl ProviderExport {
  /// Normalize v2 or v3 transport fields into the required persisted shape.
  pub fn normalize_transport(&self) -> Result<NormalizedProviderTransport, String> {
    if let (Some(base_url), Some(base_url_source), Some(auth_scheme)) =
      (&self.base_url, self.base_url_source, self.auth_scheme.clone())
    {
      let base_url = base_url.trim();
      if base_url.is_empty() {
        return Err("base_url must not be empty".into());
      }
      auth_scheme.validate()?;
      return Ok(NormalizedProviderTransport {
        base_url: base_url.to_string(),
        base_url_source,
        auth_scheme,
      });
    }

    // v2 path: derive from base_url_override + built-in adapter defaults.
    let override_url = self
      .base_url_override
      .as_ref()
      .map(|s| s.trim())
      .filter(|s| !s.is_empty())
      .map(|s| s.to_string());
    let (base_url, base_url_source) = match override_url {
      Some(url) => (url, BaseUrlSource::Custom),
      None => {
        let Some(default_url) = builtin_default_base_url(&self.adapter_id) else {
          return Err(format!(
            "v2 provider {} has unknown adapter_id '{}' and no baseUrlOverride",
            self.id, self.adapter_id
          ));
        };
        (default_url.to_string(), BaseUrlSource::PluginDefault)
      }
    };
    let Some(auth_scheme) = AuthSchemeV1::from_builtin_adapter(&self.adapter_id, self.credential_kind) else {
      return Err(format!(
        "v2 provider {} has unknown adapter_id '{}' and cannot derive authScheme",
        self.id, self.adapter_id
      ));
    };
    Ok(NormalizedProviderTransport {
      base_url,
      base_url_source,
      auth_scheme,
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn credential_update_debug_redacts_secret() {
    let update = CredentialUpdate::Replace("sk-super-secret".into());
    let debug = format!("{update:?}");
    assert!(!debug.contains("sk-super-secret"));
    assert!(debug.contains("redacted"));
  }

  #[test]
  fn dto_omits_credential_ref() {
    let provider = ProviderInstance {
      id: Uuid::nil(),
      adapter_id: "openai-compatible".into(),
      display_name: "Local".into(),
      base_url: "https://api.openai.com/v1".into(),
      base_url_source: BaseUrlSource::PluginDefault,
      auth_scheme: AuthSchemeV1::bearer(),
      credential_kind: CredentialKind::ApiKey,
      credential_ref: Some("provider/x/y".into()),
      enabled: true,
      proxy_mode: ProxyMode::Inherit,
      insecure_http_confirmed_at: None,
      models_synced_at: None,
      models_sync_status: ModelsSyncStatus::Never,
      models_sync_error_code: None,
      created_at: "t".into(),
      updated_at: "t".into(),
    };
    let dto = ProviderInstanceDto::from(&provider);
    let json = serde_json::to_string(&dto).unwrap();
    assert!(json.contains("hasCredential"));
    assert!(json.contains("baseUrl"));
    assert!(json.contains("authScheme"));
    assert!(!json.contains("credentialRef"));
    assert!(!json.contains("provider/x/y"));
    assert!(dto.has_credential);
  }

  #[test]
  fn auth_scheme_json_round_trip() {
    let schemes = [
      AuthSchemeV1::none(),
      AuthSchemeV1::bearer(),
      AuthSchemeV1::header("x-api-key"),
      AuthSchemeV1::query("key"),
    ];
    for scheme in schemes {
      let json = scheme.to_json_string().unwrap();
      let back = AuthSchemeV1::from_json_str(&json).unwrap();
      assert_eq!(back, scheme);
    }
  }

  #[test]
  fn auth_scheme_rejects_restricted_names() {
    assert!(AuthSchemeV1::header("Authorization").validate().is_err());
    assert!(AuthSchemeV1::query("cookie").validate().is_err());
  }

  #[test]
  fn adapter_id_structural_validation() {
    assert!(validate_adapter_id("openai-compatible").is_ok());
    assert!(validate_adapter_id("custom-plugin-1").is_ok());
    assert!(validate_adapter_id("").is_err());
    assert!(validate_adapter_id("OpenAI").is_err());
    assert!(validate_adapter_id("-bad").is_err());
    assert!(validate_adapter_id("bad--id").is_err());
  }

  #[test]
  fn builtin_auth_scheme_from_adapter() {
    assert_eq!(
      AuthSchemeV1::from_builtin_adapter("openai-compatible", CredentialKind::None),
      Some(AuthSchemeV1::none())
    );
    assert_eq!(
      AuthSchemeV1::from_builtin_adapter("openai-compatible", CredentialKind::ApiKey),
      Some(AuthSchemeV1::bearer())
    );
    assert_eq!(
      AuthSchemeV1::from_builtin_adapter("anthropic", CredentialKind::None),
      Some(AuthSchemeV1::header("x-api-key"))
    );
    assert_eq!(
      AuthSchemeV1::from_builtin_adapter("gemini", CredentialKind::ApiKey),
      Some(AuthSchemeV1::query("key"))
    );
  }
}
