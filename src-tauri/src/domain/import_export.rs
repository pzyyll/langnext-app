// ABOUTME: Versioned configuration import/export document and preview types.
// ABOUTME: Documents never carry secrets, credential refs, or device state.
use crate::domain::model::ProviderModel;
use crate::domain::ocr_service::OcrProviderType;
use crate::domain::provider::ProviderExport;
use crate::domain::settings::AppSettingsV1;
use crate::domain::translation_profile::{
  TranslationProfile, TranslationProfilePromptTemplate, TranslationProfileTarget,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Current configuration export format version (runtime requirements + Speech + OCR + integrations).
pub const EXPORT_FORMAT_VERSION: u32 = 8;
/// Supported import format version. Unpublished package-only convergence: only the current
/// package-aware format is importable; older documents that normalized to bundled/legacy
/// runtime identities are rejected, never synthesized.
pub const SUPPORTED_EXPORT_FORMAT_VERSIONS: &[u32] = &[8];

/// Sanitized integration instance row for export/import (no secrets, refs, or journal data).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationInstanceExport {
  pub id: Uuid,
  pub plugin_id: String,
  pub plugin_version: String,
  pub display_name: String,
  pub enabled: bool,
  /// Non-secret common config JSON string.
  pub config_json: String,
  pub config_schema_version: u32,
  /// Last known health (may become unconfigured after import until re-auth).
  pub health_status: String,
  /// Exact runtime requirement (current format). Package-only: every integration's
  /// requirement is package-backed; bundled/legacy identities never import.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub runtime: Option<crate::domain::runtime_lifecycle::RuntimeRequirementExport>,
  pub created_at: String,
  pub updated_at: String,
}

/// Sanitized OCR service for export/import (no vault refs or secrets).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrServiceExport {
  pub id: Uuid,
  pub provider_type: OcrProviderType,
  pub display_name: String,
  pub enabled: bool,
  pub sort_order: i32,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub provider_model_id: Option<Uuid>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub temperature: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub default_prompt_template_id: Option<Uuid>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub integration_instance_id: Option<Uuid>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub ocr_capability_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub capability_preferences_version: Option<i32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub capability_preferences: Option<Value>,
  pub created_at: String,
  pub updated_at: String,
}

/// AI OCR prompt template row for export/import.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OcrPromptTemplateExport {
  pub id: Uuid,
  pub ocr_service_id: Uuid,
  pub name: String,
  pub system_template: String,
  pub user_template: String,
  pub sort_order: i32,
}

/// Sanitized Speech service for export/import (no audio, text, or credentials).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechServiceExport {
  pub id: Uuid,
  pub display_name: String,
  pub enabled: bool,
  pub sort_order: i32,
  pub integration_instance_id: Uuid,
  pub capability_id: String,
  pub preferences_schema_version: i32,
  pub preferences: Value,
  pub created_at: String,
  pub updated_at: String,
}

/// Current (v8) configuration export document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationExport {
  pub format_version: u32,
  pub exported_at: String,
  pub providers: Vec<ProviderExport>,
  pub models: Vec<ProviderModel>,
  pub translation_profiles: Vec<TranslationProfile>,
  pub profile_models: Vec<TranslationProfileTarget>,
  /// Ordered prompt templates for all profiles (sort_order ascending within each profile).
  pub profile_prompt_templates: Vec<TranslationProfilePromptTemplate>,
  /// Sanitized integration instances (no credentials/refs).
  #[serde(default)]
  pub integration_instances: Vec<IntegrationInstanceExport>,
  /// OCR services (ai/plugin); secrets omitted.
  #[serde(default)]
  pub ocr_services: Vec<OcrServiceExport>,
  /// Ordered AI OCR prompt templates for all OCR services.
  #[serde(default)]
  pub ocr_prompt_templates: Vec<OcrPromptTemplateExport>,
  /// Speech services (capability-backed); audio/text/credentials omitted.
  #[serde(default)]
  pub speech_services: Vec<SpeechServiceExport>,
  pub app_settings: AppSettingsV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportConflictMode {
  Merge,
  Copy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewCounts {
  pub providers_create: u32,
  pub providers_update: u32,
  pub providers_copy: u32,
  pub models_create: u32,
  pub models_update: u32,
  pub models_copy: u32,
  pub profiles_create: u32,
  pub profiles_update: u32,
  pub profiles_copy: u32,
  #[serde(default)]
  pub integrations_create: u32,
  #[serde(default)]
  pub integrations_update: u32,
  #[serde(default)]
  pub integrations_copy: u32,
  #[serde(default)]
  pub ocr_services_create: u32,
  #[serde(default)]
  pub ocr_services_update: u32,
  #[serde(default)]
  pub ocr_services_copy: u32,
  #[serde(default)]
  pub speech_services_create: u32,
  #[serde(default)]
  pub speech_services_update: u32,
  #[serde(default)]
  pub speech_services_copy: u32,
}

/// Import subject kinds that carry exact runtime requirements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportRuntimeSubjectKind {
  Integration,
  Provider,
}

/// Local availability of one exact imported content requirement, resolved against the
/// immutable plugin catalog (built-in, development, and user content) plus recorded user
/// archives. The exact digest is the only identity: plugin ID/version matching never
/// substitutes another package. Package-only: legacy bundled/TypeScript requirements never
/// import.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportRuntimeLocalStatus {
  /// Exact digest absent locally with no local content claiming its plugin id/version.
  Missing,
  /// Local content claims the same plugin id/version at a different digest.
  DigestMismatch,
  /// Exact digest present but its manifest identity contradicts the requirement.
  Incompatible,
  /// Exact digest present, content available, manifest compatible.
  Installed,
}

/// Closed required user action for one exact imported runtime requirement. Import itself
/// never installs, trusts, grants, or activates anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportRuntimeRequiredAction {
  InstallExactPackage,
  ResolveDigestMismatch,
  ResolveIncompatibility,
  ActivateAfterImport,
}

/// One exact per-subject runtime requirement preview entry: subject identity, display
/// label, optional adapter id, requirement identity, local status, and required action.
/// Never carries secrets, refs, grants, package bytes, publisher identity, or activation
/// authority.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportRuntimeRequirementPreview {
  pub subject_kind: ImportRuntimeSubjectKind,
  /// Final (post-import) subject id; Copy mode shows the remapped id.
  pub subject_id: Uuid,
  pub display_label: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub adapter_id: Option<String>,
  pub runtime_kind: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub plugin_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub plugin_version: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub package_digest: Option<String>,
  pub local_status: ImportRuntimeLocalStatus,
  pub required_action: ImportRuntimeRequiredAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
  pub valid: bool,
  pub counts: ImportPreviewCounts,
  pub validation_errors: Vec<String>,
  /// Provider IDs (post-import IDs for copy mode) that need credentials.
  pub requires_authentication: Vec<Uuid>,
  /// Integration instance IDs that need credential re-entry after import.
  #[serde(default)]
  pub integration_requires_authentication: Vec<Uuid>,
  pub proxy_requires_authentication: bool,
  pub default_profile_cleared: bool,
  /// Opaque bounded expiring preview session id; empty when no session exists (invalid
  /// preview or direct internal preview). Apply accepts only this id.
  #[serde(default)]
  pub preview_id: String,
  /// Exact per-subject runtime requirement local availability and required actions.
  #[serde(default)]
  pub runtime_requirements: Vec<ImportRuntimeRequirementPreview>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
  pub preview: ImportPreview,
  pub applied: bool,
}

/// Parse an untrusted JSON value into a normalized configuration document.
///
/// Unpublished package-only convergence: only the current package-aware format (v8) is
/// accepted. Older documents that normalized to bundled/legacy runtime identities are
/// rejected as unsupported instead of being synthesized.
pub fn parse_and_normalize_export_document(value: serde_json::Value) -> Result<ConfigurationExport, String> {
  let version = value
    .get("formatVersion")
    .and_then(|v| v.as_u64())
    .ok_or_else(|| "missing formatVersion".to_string())? as u32;
  if !SUPPORTED_EXPORT_FORMAT_VERSIONS.contains(&version) {
    return Err(format!("unsupported formatVersion {version}"));
  }
  let doc: ConfigurationExport =
    serde_json::from_value(value).map_err(|e| format!("invalid v8 configuration document: {e}"))?;
  validate_current_format_integration_runtime_records(&doc)?;
  validate_v8_provider_runtime_bindings(&doc)?;
  Ok(doc)
}

/// Current-format (v8) runtime record validation used by the import service after parsing.
pub fn validate_current_format_runtime_records(doc: &ConfigurationExport) -> Result<(), String> {
  validate_current_format_integration_runtime_records(doc)?;
  validate_v8_provider_runtime_bindings(doc)
}

/// Current-format (v8) integration runtime record validation: every integration must carry an explicit
/// package-backed runtime requirement whose identity matches the outer instance fields
/// (fail closed). Legacy bundled/TypeScript identities are rejected by the runtime-kind
/// parser and never import.
fn validate_current_format_integration_runtime_records(doc: &ConfigurationExport) -> Result<(), String> {
  for row in &doc.integration_instances {
    let Some(req) = row.runtime.as_ref() else {
      return Err(format!(
        "v8 integration {} is missing required runtime requirement",
        row.id
      ));
    };
    if req.plugin_id != row.plugin_id || req.plugin_version != row.plugin_version {
      return Err(format!(
        "v8 integration {} runtime identity does not match outer fields",
        row.id
      ));
    }
    if req.config_schema_version != row.config_schema_version {
      return Err(format!(
        "v8 integration {} runtime config_schema_version mismatch",
        row.id
      ));
    }
    let kind = crate::domain::runtime_lifecycle::parse_runtime_kind(&req.runtime_kind)
      .map_err(|e| format!("v8 integration {} has invalid runtimeKind: {e}", row.id))?;
    // Domain parsers for plugin identity and schema majors (fail closed).
    crate::domain::runtime_plugin::SemVerVersion::parse(&req.plugin_version)
      .map_err(|e| format!("v8 integration {} has invalid pluginVersion: {e}", row.id))?;
    if req.config_schema_version < 1 {
      return Err(format!("v8 integration {} config_schema_version must be >= 1", row.id));
    }
    for major in &req.required_capability_majors {
      crate::domain::runtime_plugin::CapabilityId::parse(major).map_err(|e| {
        format!(
          "v8 integration {} has invalid requiredCapabilityMajors entry: {e:?}",
          row.id
        )
      })?;
    }
    match kind {
      crate::domain::runtime_plugin::RuntimeKind::WasmComponent
      | crate::domain::runtime_plugin::RuntimeKind::TrustedNativeWorker => {
        // Trim only for empty-presence checks; domain parsers receive the raw string
        // so surrounding whitespace fails closed.
        let digest = req.package_digest.as_deref().ok_or_else(|| {
          format!(
            "v8 integration {} package-backed runtime is missing mandatory fields",
            row.id
          )
        })?;
        if digest.trim().is_empty() {
          return Err(format!(
            "v8 integration {} package-backed runtime is missing mandatory fields",
            row.id
          ));
        }
        crate::domain::runtime_plugin::PackageDigest::parse(digest)
          .map_err(|e| format!("v8 integration {} has invalid packageDigest: {e}", row.id))?;
        let api = req.plugin_api_version.as_deref().ok_or_else(|| {
          format!(
            "v8 integration {} package-backed runtime is missing mandatory fields",
            row.id
          )
        })?;
        if api.trim().is_empty() {
          return Err(format!(
            "v8 integration {} package-backed runtime is missing mandatory fields",
            row.id
          ));
        }
        crate::domain::runtime_plugin::PluginApiVersion::parse(api)
          .map_err(|e| format!("v8 integration {} has invalid pluginApiVersion: {e}", row.id))?;
      }
    }
  }
  Ok(())
}

/// v8 provider runtime bindings validation: every adapter-keyed requirement is a closed
/// identity document (no grants, revisions, package bytes, or secrets) and v8 documents
/// never carry the deprecated singular `runtime` field. Package-only: every provider must
/// carry a non-empty `runtimeBindings` set containing its default adapter, every entry uses
/// `wasm-component`, each adapter appears at most once, and every entry names its adapter
/// explicitly — an import that violated these would corrupt per-interface reads.
fn validate_v8_provider_runtime_bindings(doc: &ConfigurationExport) -> Result<(), String> {
  for provider in &doc.providers {
    if provider.runtime.is_some() {
      return Err(format!(
        "v8 provider {} must not carry the singular runtime field; use runtimeBindings",
        provider.id
      ));
    }
    if provider.runtime_bindings.is_empty() {
      return Err(format!(
        "v8 provider {} must carry a non-empty runtimeBindings set; legacy frontend providers do not exist",
        provider.id
      ));
    }
    let mut seen_adapters = std::collections::HashSet::new();
    let mut has_default_adapter = false;
    for requirement in &provider.runtime_bindings {
      let Some(adapter) = requirement.adapter_id.as_deref() else {
        return Err(format!(
          "v8 provider {} runtime binding is missing adapterId",
          provider.id
        ));
      };
      crate::domain::provider::validate_adapter_id(adapter)
        .map_err(|e| format!("provider {} runtime binding has invalid adapterId: {e}", provider.id))?;
      if !seen_adapters.insert(adapter) {
        return Err(format!(
          "v8 provider {} runtime binding adapter '{adapter}' appears more than once",
          provider.id
        ));
      }
      if adapter == provider.adapter_id {
        has_default_adapter = true;
      }
      validate_provider_runtime_requirement(requirement)
        .map_err(|e| format!("provider {} has invalid runtime requirement: {e}", provider.id))?;
    }
    if !has_default_adapter {
      return Err(format!(
        "v8 provider {} runtimeBindings must include the Provider default API type '{}'",
        provider.id, provider.adapter_id
      ));
    }
  }
  Ok(())
}

/// Fail-closed validation of an imported provider runtime requirement: only the
/// `wasm-component` kind with exact package identity fields and bounded legacy adapter
/// aliases. Grants, revisions, package bytes, and secrets are never part of the requirement.
pub fn validate_provider_runtime_requirement(
  requirement: &crate::domain::runtime_provider::ProviderRuntimeRequirementExport,
) -> Result<(), String> {
  use crate::domain::provider::validate_adapter_id;
  use crate::domain::runtime_plugin::{
    CapabilityId, PROVIDER_RUNTIME_LEGACY_ALIASES_MAX_COUNT, PackageDigest, PluginApiVersion, PluginId, SemVerVersion,
  };
  if let Some(adapter) = requirement.adapter_id.as_deref() {
    validate_adapter_id(adapter).map_err(|e| format!("provider runtime adapterId: {e}"))?;
  }
  match requirement.runtime_kind.as_str() {
    "wasm-component" => {
      let digest = requirement
        .package_digest
        .as_deref()
        .ok_or_else(|| "wasm provider runtime requirement is missing packageDigest".to_string())?;
      PackageDigest::parse(digest).map_err(|e| format!("provider runtime packageDigest: {e}"))?;
      requirement
        .plugin_id
        .as_deref()
        .map(|value| PluginId::parse(value).map_err(|e| format!("provider runtime pluginId: {e}")))
        .transpose()?;
      requirement
        .plugin_version
        .as_deref()
        .map(|value| SemVerVersion::parse(value).map_err(|e| format!("provider runtime pluginVersion: {e}")))
        .transpose()?;
      requirement
        .plugin_api_version
        .as_deref()
        .map(|value| PluginApiVersion::parse(value).map_err(|e| format!("provider runtime pluginApiVersion: {e}")))
        .transpose()?;
      if requirement.capabilities.is_empty() {
        return Err("wasm provider runtime requirement must declare capabilities".into());
      }
      for capability in &requirement.capabilities {
        CapabilityId::parse(capability).map_err(|e| format!("provider runtime capability {capability}: {e:?}"))?;
      }
    }
    other => return Err(format!("invalid provider runtime kind {other}")),
  }
  if requirement.legacy_aliases.len() > PROVIDER_RUNTIME_LEGACY_ALIASES_MAX_COUNT {
    return Err(format!(
      "provider runtime legacyAliases exceed {PROVIDER_RUNTIME_LEGACY_ALIASES_MAX_COUNT} entries"
    ));
  }
  for alias in &requirement.legacy_aliases {
    validate_adapter_id(alias).map_err(|e| format!("provider runtime legacyAliases: {e}"))?;
  }
  Ok(())
}

/// Secret-like field names that must never appear in serialized export JSON.
pub const FORBIDDEN_EXPORT_SECRET_KEYS: &[&str] = &[
  "credentialRef",
  "credential_ref",
  "apiKeyRef",
  "secretKeyRef",
  "private_key",
  "privateKey",
  "client_email",
  "clientEmail",
  "access_token",
  "accessToken",
  "serviceAccountJson",
  "service_account_json",
  "newRef",
  "expectedOldRef",
  // Speech runtime payloads must never appear in configuration documents.
  "audioContent",
  "audio_content",
  "mp3Bytes",
  "mp3_bytes",
  // Removed authority-approval artifacts stay local-only and must never appear in a document.
  "approvedAuthorityJson",
  "approved_authority_json",
  "approvedAuthorityDigest",
  "approved_authority_digest",
  "policyConstraintsDigest",
  "policy_constraints_digest",
  "claimToken",
  "claim_token",
];

/// Scan serialized export JSON text for forbidden secret/ref keys.
pub fn export_json_contains_forbidden_secret_keys(json: &str) -> Vec<String> {
  let mut found = Vec::new();
  for key in FORBIDDEN_EXPORT_SECRET_KEYS {
    // Match JSON object keys: "key":
    let needle = format!("\"{key}\"");
    if json.contains(&needle) {
      found.push((*key).to_string());
    }
  }
  found
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::settings::AppSettingsV1;

  #[test]
  fn export_document_round_trip() {
    let doc = ConfigurationExport {
      format_version: EXPORT_FORMAT_VERSION,
      exported_at: "2026-07-10T00:00:00Z".into(),
      providers: vec![],
      models: vec![],
      translation_profiles: vec![],
      profile_models: vec![],
      profile_prompt_templates: vec![],
      integration_instances: vec![],
      ocr_services: vec![],
      ocr_prompt_templates: vec![],
      speech_services: vec![],
      app_settings: AppSettingsV1::default_document(),
    };
    let json = serde_json::to_string(&doc).unwrap();
    assert!(json.contains("formatVersion"));
    assert!(json.contains("profilePromptTemplates"));
    assert!(json.contains("integrationInstances"));
    assert!(json.contains("ocrServices"));
    assert!(json.contains("ocrPromptTemplates"));
    assert!(json.contains("speechServices"));
    assert!(!json.contains("credentialRef"));
    assert!(!json.contains("credential_ref"));
    assert!(!json.contains("audioContent"));
    assert!(!json.contains("mp3Bytes"));
    let back: ConfigurationExport = serde_json::from_str(&json).unwrap();
    assert_eq!(back, doc);
    assert!(export_json_contains_forbidden_secret_keys(&json).is_empty());
  }

  #[test]
  fn secret_scan_catches_event_error_and_log_like_fixtures() {
    let fixtures = [
      r#"{"event":"credential","credentialRef":"provider/x","status":"ok"}"#,
      r#"{"errorCode":"auth","private_key":"BEGIN","message":"no"}"#,
      r#"{"log":"token","access_token":"ya29.abc","level":"info"}"#,
      r#"{"binding":{"service_account_json":"{}"}}"#,
      r#"{"response":{"audioContent":"ID3fake"}}"#,
      r#"{"payload":{"mp3Bytes":"not-exported"}}"#,
    ];
    for fixture in fixtures {
      let found = export_json_contains_forbidden_secret_keys(fixture);
      assert!(
        !found.is_empty(),
        "expected forbidden keys in fixture {fixture}, found {found:?}"
      );
    }
    // Clean capability error/event shapes must remain free of secret keys.
    let clean = r#"{"errorCode":"auth","message":"auth failed","modelId":null,"ok":false}"#;
    assert!(export_json_contains_forbidden_secret_keys(clean).is_empty());
  }

  #[test]
  fn parse_and_normalize_accepts_current_version_only() {
    let value = serde_json::json!({
      "formatVersion": EXPORT_FORMAT_VERSION,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let doc = parse_and_normalize_export_document(value).unwrap();
    assert_eq!(doc.format_version, EXPORT_FORMAT_VERSION);
  }

  #[test]
  fn parse_and_normalize_rejects_pre_package_formats() {
    // Unpublished package-only convergence: every pre-v8 format that normalized to
    // bundled/legacy runtime identities is unsupported and must fail closed.
    for version in [2_u32, 3, 4, 5, 6, 7] {
      let value = serde_json::json!({
        "formatVersion": version,
        "exportedAt": "t",
        "providers": [],
        "models": [],
        "translationProfiles": [],
        "profileModels": [],
        "profilePromptTemplates": [],
        "integrationInstances": [],
        "ocrServices": [],
        "ocrPromptTemplates": [],
        "speechServices": [],
        "appSettings": AppSettingsV1::default_document(),
      });
      let err = parse_and_normalize_export_document(value).unwrap_err();
      assert!(
        err.contains("unsupported formatVersion"),
        "version {version} must be unsupported, got {err}"
      );
    }
  }

  #[test]
  fn parse_and_normalize_rejects_legacy_runtime_identities() {
    // A v8 document importing a bundled-rust integration requirement fails closed.
    let bundled_integration = serde_json::json!({
      "formatVersion": EXPORT_FORMAT_VERSION,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000001",
        "pluginId": "com.langnext.google-cloud",
        "pluginVersion": "1.0.0",
        "displayName": "Cloud",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "runtime": {
          "pluginId": "com.langnext.google-cloud",
          "pluginVersion": "1.0.0",
          "runtimeKind": "bundled-rust",
          "configSchemaVersion": 1,
          "requiredCapabilityMajors": []
        },
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(bundled_integration).unwrap_err();
    assert!(
      err.contains("invalid runtimeKind") || err.contains("runtimeKind"),
      "bundled-rust integration must fail closed, got {err}"
    );

    // A legacy-frontend-provider provider without bindings fails closed.
    let legacy_provider = serde_json::json!({
      "formatVersion": EXPORT_FORMAT_VERSION,
      "exportedAt": "t",
      "providers": [{
        "id": "00000000-0000-0000-0000-000000000010",
        "adapterId": "openai-compatible",
        "displayName": "Legacy",
        "enabled": true,
        "baseUrl": "https://example.com",
        "baseUrlSource": "custom",
        "authScheme": {"type": "none", "schemaVersion": 1},
        "credentialKind": "none",
        "proxyMode": "inherit",
        "runtime": {
          "runtimeKind": "legacy-frontend-provider"
        },
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(legacy_provider).unwrap_err();
    assert!(
      err.contains("runtime") || err.contains("runtimeBindings"),
      "legacy provider must fail closed, got {err}"
    );
    // A provider with empty runtimeBindings fails closed (no legacy default synthesis).
    let empty_bindings = serde_json::json!({
      "formatVersion": EXPORT_FORMAT_VERSION,
      "exportedAt": "t",
      "providers": [{
        "id": "00000000-0000-0000-0000-000000000011",
        "adapterId": "openai-compatible",
        "displayName": "Empty",
        "enabled": true,
        "baseUrl": "https://example.com",
        "baseUrlSource": "custom",
        "authScheme": {"type": "none", "schemaVersion": 1},
        "credentialKind": "none",
        "proxyMode": "inherit",
        "runtimeBindings": [],
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(empty_bindings).unwrap_err();
    assert!(
      err.contains("runtimeBindings"),
      "empty provider runtimeBindings must fail closed, got {err}"
    );
  }

  fn parse_and_normalize_rejects_unsupported_version() {
    let value = serde_json::json!({ "formatVersion": 99, "exportedAt": "t" });
    let err = parse_and_normalize_export_document(value).unwrap_err();
    assert!(err.contains("unsupported formatVersion"));
  }

  #[test]
  fn v8_missing_runtime_fails_closed() {
    let value = serde_json::json!({
      "formatVersion": EXPORT_FORMAT_VERSION,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000001",
        "pluginId": "com.langnext.google-translate-web",
        "pluginVersion": "1.0.0",
        "displayName": "Web",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(value).unwrap_err();
    assert!(
      err.contains("missing required runtime") || err.contains("runtime"),
      "expected missing runtime error, got {err}"
    );
  }

  /// A package-backed requirement carries content identity only: plugin id, version, exact
  /// digest, runtime kind, API version, and required capability majors.
  #[test]
  fn v8_package_backed_requirement_parses_without_publisher_metadata() {
    let value = serde_json::json!({
      "formatVersion": EXPORT_FORMAT_VERSION,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000002",
        "pluginId": "langnext.conformance",
        "pluginVersion": "1.0.0",
        "displayName": "Wasm",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "runtime": {
          "pluginId": "langnext.conformance",
          "pluginVersion": "1.0.0",
          "runtimeKind": "wasm-component",
          "packageDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "pluginApiVersion": "1.0",
          "configSchemaVersion": 1,
          "requiredCapabilityMajors": ["translate.text@1"]
        },
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let parsed = parse_and_normalize_export_document(value).expect("content identity alone satisfies a v8 requirement");
    let runtime = parsed.integration_instances[0]
      .runtime
      .as_ref()
      .expect("package-backed runtime preserved");
    assert_eq!(runtime.package_digest.as_deref(), Some("a".repeat(64).as_str()));
    assert_eq!(runtime.plugin_id, "langnext.conformance");
    assert_eq!(runtime.plugin_api_version.as_deref(), Some("1.0"));
    assert_eq!(runtime.required_capability_majors, vec!["translate.text@1".to_string()]);
  }

  /// Removed publisher/signature/activation fields are rejected, never silently ignored.
  /// There is no compatibility path for an older document that still carries them.
  #[test]
  fn v8_unknown_and_removed_fields_fail_closed() {
    for (key, value) in [
      ("publisherKeyId", serde_json::json!("com.example.keys.1")),
      ("publisherKeyFingerprint", serde_json::json!("a".repeat(64))),
      ("signatureStatus", serde_json::json!("verified")),
      ("providerRuntimeKind", serde_json::json!("wasm-component")),
      ("providerPackageDigest", serde_json::json!("a".repeat(64))),
    ] {
      let mut runtime = serde_json::json!({
        "pluginId": "langnext.conformance",
        "pluginVersion": "1.0.0",
        "runtimeKind": "wasm-component",
        "packageDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pluginApiVersion": "1.0",
        "configSchemaVersion": 1,
        "requiredCapabilityMajors": ["translate.text@1"]
      });
      runtime[key] = value;
      let doc = serde_json::json!({
        "formatVersion": EXPORT_FORMAT_VERSION,
        "exportedAt": "t",
        "providers": [],
        "models": [],
        "translationProfiles": [],
        "profileModels": [],
        "profilePromptTemplates": [],
        "integrationInstances": [{
          "id": "00000000-0000-0000-0000-000000000002",
          "pluginId": "langnext.conformance",
          "pluginVersion": "1.0.0",
          "displayName": "x",
          "enabled": true,
          "configJson": "{}",
          "configSchemaVersion": 1,
          "healthStatus": "ready",
          "runtime": runtime,
          "createdAt": "t",
          "updatedAt": "t"
        }],
        "ocrServices": [],
        "ocrPromptTemplates": [],
        "speechServices": [],
        "appSettings": AppSettingsV1::default_document(),
      });
      let err = parse_and_normalize_export_document(doc).expect_err(&format!("removed field {key} must fail closed"));
      assert!(
        err.contains(key),
        "expected an unknown-field error naming {key}, got {err}"
      );
    }
  }

  #[test]
  fn v8_invalid_capability_major_fails_closed() {
    let doc = serde_json::json!({
      "formatVersion": EXPORT_FORMAT_VERSION,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000003",
        "pluginId": "langnext.conformance",
        "pluginVersion": "1.0.0",
        "displayName": "x",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "runtime": {
          "pluginId": "langnext.conformance",
          "pluginVersion": "1.0.0",
          "runtimeKind": "wasm-component",
          "packageDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "pluginApiVersion": "1.0",
          "configSchemaVersion": 1,
          "requiredCapabilityMajors": ["not-a-capability"]
        },
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(doc).unwrap_err();
    assert!(
      err.contains("requiredCapabilityMajors") || err.contains("capability"),
      "expected capability major error, got {err}"
    );
  }

  /// v8 provider helper: one runtime binding requirement entry for a wasm package.
  fn v8_wasm_binding(adapter_id: &str) -> serde_json::Value {
    serde_json::json!({
      "adapterId": adapter_id,
      "runtimeKind": "wasm-component",
      "packageDigest": "ab".repeat(32),
      "pluginId": "com.langnext.provider.openai-compatible",
      "pluginVersion": "1.0.0",
      "pluginApiVersion": "1.0",
      "legacyAliases": [adapter_id],
      "capabilities": ["llm.chat@1", "llm.models.list@1"]
    })
  }

  /// v8 provider helper: one provider row with the given runtime binding requirements.
  fn v8_provider_document(bindings: Vec<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({
      "formatVersion": EXPORT_FORMAT_VERSION,
      "exportedAt": "t",
      "providers": [{
        "id": "00000000-0000-7000-8000-000000000001",
        "adapterId": "openai-compatible",
        "displayName": "P",
        "credentialKind": "api_key",
        "enabled": true,
        "proxyMode": "inherit",
        "insecureHttpConfirmedAt": null,
        "runtimeBindings": bindings,
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    })
  }

  #[test]
  fn v8_duplicate_runtime_binding_adapters_fail_closed() {
    let value = v8_provider_document(vec![
      v8_wasm_binding("openai-compatible"),
      v8_wasm_binding("openai-compatible"),
    ]);
    let err = parse_and_normalize_export_document(value).unwrap_err();
    assert!(
      err.contains("duplicate") || err.contains("more than once"),
      "expected duplicate adapter error, got {err}"
    );
  }

  #[test]
  fn v8_runtime_bindings_missing_default_adapter_fail_closed() {
    let value = v8_provider_document(vec![v8_wasm_binding("openai-responses")]);
    let err = parse_and_normalize_export_document(value).unwrap_err();
    assert!(
      err.contains("default") && err.contains("openai-compatible"),
      "expected missing default adapter error, got {err}"
    );
  }

  #[test]
  fn v8_runtime_bindings_without_adapter_id_fail_closed() {
    let mut binding = v8_wasm_binding("openai-compatible");
    binding.as_object_mut().unwrap().remove("adapterId");
    let value = v8_provider_document(vec![binding]);
    let err = parse_and_normalize_export_document(value).unwrap_err();
    assert!(
      err.contains("adapterId") || err.contains("adapter"),
      "expected adapter identity error, got {err}"
    );
  }

  #[test]
  fn v8_distinct_binding_adapters_containing_default_pass() {
    let value = v8_provider_document(vec![
      v8_wasm_binding("openai-compatible"),
      v8_wasm_binding("openai-responses"),
    ]);
    let doc = parse_and_normalize_export_document(value).unwrap();
    assert_eq!(doc.providers[0].runtime_bindings.len(), 2);
  }

  #[test]
  fn v8_package_digest_surrounding_whitespace_fails_closed() {
    let padded = format!(" {} ", "a".repeat(64));
    let doc = serde_json::json!({
      "formatVersion": EXPORT_FORMAT_VERSION,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000011",
        "pluginId": "langnext.conformance",
        "pluginVersion": "1.0.0",
        "displayName": "x",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "runtime": {
          "pluginId": "langnext.conformance",
          "pluginVersion": "1.0.0",
          "runtimeKind": "wasm-component",
          "packageDigest": padded,
          "pluginApiVersion": "1.0",
          "configSchemaVersion": 1,
          "requiredCapabilityMajors": ["translate.text@1"]
        },
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(doc).unwrap_err();
    assert!(
      err.contains("packageDigest") || err.contains("package digest") || err.contains("whitespace"),
      "expected whitespace digest fail, got {err}"
    );
  }
}
