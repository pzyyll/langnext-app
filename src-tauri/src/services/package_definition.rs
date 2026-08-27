// ABOUTME: Project verified installed-package manifests into catalog definitions.
// ABOUTME: Uses closed host auth policies and schema adapters; never plugin-id match arms.
use crate::domain::plugin_schema::PluginSchemaV1;
use crate::domain::provider::ProxyMode;
use crate::domain::provider_http::ProviderHttpMethod;
use crate::domain::runtime_plugin::{DeclaredPathAuthority, HOST_NONE_AUTH_POLICY_ID, HttpMethod, PluginManifestV1};
use crate::domain::service_integration::{
  CredentialSlotDescriptor, CredentialSlotKind, EndpointGrant, IntegrationCapabilityDescriptor,
  ServiceIntegrationManifest,
};
use crate::error::StorageError;
use crate::services::bundled_plugins::{
  AuthPolicyBinding, BundledCapabilityDefinition, BundledPluginRegistration, CapabilityEndpointAuthority,
  CapabilityPathAuthority, CapabilityPreferencesAdapter, CredentialValidator, EndpointPolicy, PluginConfigAdapter,
  PluginPresentation,
};
use crate::services::network_broker::{BROKER_MAX_RESPONSE_BODY_BYTES, BROKER_REQUEST_BODY_MAX_BYTES};
use crate::services::plugin_package::VerifiedPackage;
use crate::services::plugin_schema::{
  HostOptionResolver, check_config_readiness, normalize_config, normalize_https_endpoint_url, parse_schema,
  validate_schema,
};
use crate::services::runtime_plugin_contracts::validate_manifest;
use crate::services::{auth_policies, bounded_http::REQUEST_TIMEOUT};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// Generic config adapter built from a verified package schema. No plugin-id branches.
#[derive(Clone)]
pub struct SchemaConfigAdapter {
  schema: PluginSchemaV1,
  origin_fields: HashMap<String, String>,
  path_fields: HashMap<String, String>,
}

impl SchemaConfigAdapter {
  pub fn new(
    schema: PluginSchemaV1,
    origin_fields: HashMap<String, String>,
    path_fields: HashMap<String, String>,
  ) -> Self {
    Self {
      schema,
      origin_fields,
      path_fields,
    }
  }
}

/// Edge TTS instance-origin field id projected from the signed package schema.
const EDGE_TTS_BASE_URL_CONFIG_FIELD: &str = "base-url";

fn normalize_instance_endpoint_field(field_id: &str, raw: &str) -> Result<String, StorageError> {
  if field_id == EDGE_TTS_BASE_URL_CONFIG_FIELD {
    crate::services::edge_tts::normalize_edge_tts_base_url(raw)
      .map_err(StorageError::Validation)
      .map(|normalized| normalized.canonical_url)
  } else {
    normalize_https_endpoint_url(raw)
      .map_err(StorageError::Validation)
      .map(|normalized| normalized.canonical_url)
  }
}

impl PluginConfigAdapter for SchemaConfigAdapter {
  fn config_schema(&self) -> &PluginSchemaV1 {
    &self.schema
  }

  fn normalize_config(&self, config_json: &str) -> Result<String, StorageError> {
    let value: Value = serde_json::from_str(config_json)
      .map_err(|_| StorageError::Validation("config_json must be valid JSON".into()))?;
    let resolver = HostOptionResolver::default();
    let mut normalized = normalize_config(&self.schema, &value, &resolver)?;
    for field in self.origin_fields.values().chain(self.path_fields.values()) {
      if let Some(raw) = normalized.get(field).and_then(Value::as_str) {
        if raw.trim().is_empty() {
          continue;
        }
        let canonical_url = normalize_instance_endpoint_field(field, raw)?;
        if let Some(object) = normalized.as_object_mut() {
          object.insert(field.clone(), Value::String(canonical_url));
        }
      }
    }
    serde_json::to_string(&normalized).map_err(StorageError::from)
  }

  fn config_ready(&self, config_json: &str) -> bool {
    let canonical = match self.normalize_config(config_json) {
      Ok(value) => value,
      Err(_) => return false,
    };
    let value: Value = match serde_json::from_str(&canonical) {
      Ok(value) => value,
      Err(_) => return false,
    };
    check_config_readiness(&self.schema, &value, &HostOptionResolver::default())
      .map(|report| report.ready)
      .unwrap_or(false)
  }

  fn proxy_mode(&self, _config_json: &str) -> ProxyMode {
    ProxyMode::Inherit
  }

  fn instance_endpoint_origin(&self, config_json: &str, alias: &str) -> Result<Option<String>, StorageError> {
    let Some(field) = self.origin_fields.get(alias) else {
      return Ok(None);
    };
    let canonical = self.normalize_config(config_json)?;
    let value: Value = serde_json::from_str(&canonical).map_err(StorageError::from)?;
    let Some(raw) = value.get(field).and_then(Value::as_str).filter(|item| !item.is_empty()) else {
      return Ok(None);
    };
    let canonical_url = normalize_instance_endpoint_field(field, raw)?;
    Ok(Some(canonical_url))
  }

  fn instance_endpoint_relative_path(&self, config_json: &str, alias: &str) -> Result<Option<String>, StorageError> {
    let Some(field) = self.path_fields.get(alias) else {
      return Ok(None);
    };
    let canonical = self.normalize_config(config_json)?;
    let value: Value = serde_json::from_str(&canonical).map_err(StorageError::from)?;
    let Some(raw) = value.get(field).and_then(Value::as_str).filter(|item| !item.is_empty()) else {
      return Ok(None);
    };
    Ok(Some(
      normalize_https_endpoint_url(raw)
        .map_err(StorageError::Validation)?
        .relative_path,
    ))
  }
}

/// Generic preference adapter built from a verified package preference schema.
#[derive(Clone)]
pub struct SchemaPreferencesAdapter {
  schema: PluginSchemaV1,
}

impl SchemaPreferencesAdapter {
  pub fn new(schema: PluginSchemaV1) -> Self {
    Self { schema }
  }
}

impl CapabilityPreferencesAdapter for SchemaPreferencesAdapter {
  fn preference_schema(&self) -> &PluginSchemaV1 {
    &self.schema
  }

  fn normalize_preferences(&self, preferences: &Value) -> Result<Value, StorageError> {
    Ok(normalize_config(
      &self.schema,
      preferences,
      &HostOptionResolver::default(),
    )?)
  }
}

struct JsonCredentialValidator;

impl CredentialValidator for JsonCredentialValidator {
  fn validate(&self, secret: &str) -> Result<(), StorageError> {
    if secret.trim().is_empty() {
      return Err(StorageError::Validation("credential value is required".into()));
    }
    let value: Value =
      serde_json::from_str(secret).map_err(|_| StorageError::Validation("credential must be valid JSON".into()))?;
    if !value.is_object() {
      return Err(StorageError::Validation("credential must be a JSON object".into()));
    }
    Ok(())
  }
}

struct TextCredentialValidator;

impl CredentialValidator for TextCredentialValidator {
  fn validate(&self, secret: &str) -> Result<(), StorageError> {
    if secret.trim().is_empty() {
      return Err(StorageError::Validation("credential value is required".into()));
    }
    Ok(())
  }
}

fn empty_schema() -> PluginSchemaV1 {
  PluginSchemaV1 {
    version: 1,
    fields: vec![],
    groups: vec![],
  }
}

fn http_method_from_manifest(method: HttpMethod) -> Result<ProviderHttpMethod, StorageError> {
  match method {
    HttpMethod::Get => Ok(ProviderHttpMethod::Get),
    HttpMethod::Post => Ok(ProviderHttpMethod::Post),
    other => Err(StorageError::Validation(format!(
      "package path authority method {other:?} is not a closed broker method"
    ))),
  }
}

fn map_slot_kind(kind: crate::domain::runtime_plugin::CredentialSlotKindV1) -> CredentialSlotKind {
  match kind {
    crate::domain::runtime_plugin::CredentialSlotKindV1::SecretJson => CredentialSlotKind::SecretJson,
    crate::domain::runtime_plugin::CredentialSlotKindV1::SecretText => CredentialSlotKind::SecretText,
  }
}

fn load_schema(extracted: &HashMap<String, Vec<u8>>, path: Option<&str>) -> Result<PluginSchemaV1, StorageError> {
  let Some(path) = path else {
    return Ok(empty_schema());
  };
  let bytes = extracted
    .get(path)
    .ok_or_else(|| StorageError::Validation(format!("package schema {path} is missing from the verified snapshot")))?;
  let json = std::str::from_utf8(bytes).map_err(|_| StorageError::Validation(format!("schema {path} is not UTF-8")))?;
  let schema = parse_schema(json)?;
  validate_schema(&schema)?;
  Ok(schema)
}

fn presentation_from_package(extracted: &HashMap<String, Vec<u8>>, manifest: &PluginManifestV1) -> PluginPresentation {
  let fallback = extracted
    .get("locales/en.json")
    .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
    .and_then(|value| value.get("name").and_then(Value::as_str).map(str::to_string))
    .unwrap_or_else(|| manifest.id.clone());
  PluginPresentation {
    display_name_key: format!("plugins.{}.name", manifest.id),
    display_name_fallback: fallback,
    icon: None,
  }
}

fn host_auth_binding(manifest: &PluginManifestV1) -> Result<Option<AuthPolicyBinding>, StorageError> {
  for policy in &manifest.permissions.auth_policies {
    if policy == HOST_NONE_AUTH_POLICY_ID {
      continue;
    }
    if let Some(driver) = auth_policies::find_driver(policy) {
      return Ok(Some(AuthPolicyBinding {
        auth_policy_id: driver.auth_driver_id.to_string(),
        auth_driver_id: driver.auth_driver_id.to_string(),
        audience_policy_id: driver.audience_policy_id.to_string(),
        scopes: driver
          .capability_scopes
          .iter()
          .flat_map(|(_, scopes)| scopes.iter().map(|scope| (*scope).to_string()))
          .collect(),
      }));
    }
    if policy == crate::domain::runtime_plugin::HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID {
      continue;
    }
    return Err(StorageError::Validation(format!(
      "package auth policy {policy} is not a closed host policy"
    )));
  }
  Ok(None)
}

/// Project a verified installed package into a catalog definition. Missing schemas fail closed.
pub fn project_verified_package(verified: &VerifiedPackage) -> Result<BundledPluginRegistration, StorageError> {
  validate_manifest(&verified.manifest).map_err(|err| StorageError::Validation(err.to_string()))?;
  let config_schema = load_schema(
    &verified.extracted_files,
    verified.manifest.configuration_schema.as_deref(),
  )?;
  let mut origin_fields = HashMap::new();
  for endpoint in &verified.manifest.permissions.network {
    if let Some(field) = &endpoint.instance_origin_config_field {
      origin_fields.insert(endpoint.id.clone(), field.clone());
    }
  }
  let mut path_fields = HashMap::new();
  for declaration in &verified.manifest.path_authority {
    if let DeclaredPathAuthority::InstanceConfiguredRelativePath { config_field } = &declaration.path {
      if !config_schema.fields.iter().any(|field| field.id == *config_field) {
        return Err(StorageError::Validation(format!(
          "instance-configured path field {config_field} is not declared in the config schema"
        )));
      }
      path_fields.insert(declaration.endpoint_id.clone(), config_field.clone());
    }
  }
  let config_adapter = Arc::new(SchemaConfigAdapter::new(
    config_schema.clone(),
    origin_fields,
    path_fields,
  ));
  let auth_policy = host_auth_binding(&verified.manifest)?;
  let mut credential_validators = HashMap::new();
  for slot in &verified.manifest.credential_slots {
    let validator: Arc<dyn CredentialValidator> = match slot.kind {
      crate::domain::runtime_plugin::CredentialSlotKindV1::SecretJson => Arc::new(JsonCredentialValidator),
      crate::domain::runtime_plugin::CredentialSlotKindV1::SecretText => Arc::new(TextCredentialValidator),
    };
    credential_validators.insert(slot.id.clone(), validator);
  }

  let mut capabilities = Vec::new();
  for capability in &verified.manifest.capabilities {
    let preference_schema = load_schema(&verified.extracted_files, capability.preferences_schema.as_deref())?;
    let preference_adapter: Arc<dyn CapabilityPreferencesAdapter> =
      Arc::new(SchemaPreferencesAdapter::new(preference_schema.clone()));
    let endpoint_aliases: Vec<String> = verified
      .manifest
      .path_authority
      .iter()
      .filter(|declaration| declaration.capability_id == capability.id)
      .map(|declaration| declaration.endpoint_id.clone())
      .collect();
    let mut endpoint_authorities = Vec::new();
    for declaration in verified
      .manifest
      .path_authority
      .iter()
      .filter(|declaration| declaration.capability_id == capability.id)
    {
      let auth_policy_id = declaration
        .auth_policy_id
        .clone()
        .filter(|policy| policy != HOST_NONE_AUTH_POLICY_ID);
      endpoint_authorities.push(CapabilityEndpointAuthority {
        endpoint_alias: declaration.endpoint_id.clone(),
        method: http_method_from_manifest(declaration.method)?,
        path: CapabilityPathAuthority::from_declared(&declaration.path),
        allowed_query_names: declaration.allowed_query_names.clone(),
        allowed_header_names: declaration.allowed_header_names.clone(),
        auth_policy_id,
        max_request_body_bytes: BROKER_REQUEST_BODY_MAX_BYTES,
        max_response_body_bytes: BROKER_MAX_RESPONSE_BODY_BYTES,
        max_timeout: REQUEST_TIMEOUT,
      });
    }
    capabilities.push(BundledCapabilityDefinition {
      descriptor: IntegrationCapabilityDescriptor {
        id: capability.id.clone(),
        preferences_schema_version: preference_schema.version,
        endpoint_aliases,
      },
      preference_schema,
      preference_adapter,
      endpoint_authorities,
    });
  }

  let endpoints = verified
    .manifest
    .permissions
    .network
    .iter()
    .map(|endpoint| EndpointGrant {
      alias: endpoint.id.clone(),
      base_url: endpoint.origins.first().cloned().unwrap_or_default(),
    })
    .collect();
  let allow_instance_endpoints = verified
    .manifest
    .permissions
    .network
    .iter()
    .any(|endpoint| endpoint.instance_origin_config_field.is_some())
    || verified.manifest.path_authority.iter().any(|declaration| {
      matches!(
        declaration.path,
        DeclaredPathAuthority::InstanceConfiguredRelativePath { .. }
      )
    });
  let manifest = ServiceIntegrationManifest {
    manifest_version: verified.manifest.manifest_version,
    plugin_api_version: verified.manifest.plugin_api_version.clone(),
    id: verified.manifest.id.clone(),
    version: verified.manifest.version.clone(),
    display_name_key: format!("plugins.{}.name", verified.manifest.id),
    min_host_version: "0.1.0".into(),
    config_schema_version: verified.manifest.config_schema_version.unwrap_or(1),
    credential_slots: verified
      .manifest
      .credential_slots
      .iter()
      .map(|slot| CredentialSlotDescriptor {
        id: slot.id.clone(),
        kind: map_slot_kind(slot.kind),
        required: slot.required,
      })
      .collect(),
    endpoints,
    capabilities: capabilities
      .iter()
      .map(|capability| capability.descriptor.clone())
      .collect(),
  };

  Ok(BundledPluginRegistration {
    manifest,
    config_schema,
    config_adapter,
    credential_validators,
    capabilities,
    endpoint_policy: EndpointPolicy {
      allow_instance_endpoints,
    },
    auth_policy,
    presentation: presentation_from_package(&verified.extracted_files, &verified.manifest),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn adapter_for_origin_field(field_id: &str) -> SchemaConfigAdapter {
    let schema = parse_schema(&format!(
      r#"{{
        "version": 1,
        "fields": [{{
          "id": "{field_id}",
          "control": {{ "kind": "string", "spec": {{}} }},
          "requiredForReady": true
        }}],
        "groups": []
      }}"#
    ))
    .expect("minimal origin-field schema parses");
    let mut origin_fields = HashMap::new();
    origin_fields.insert("endpoint".into(), field_id.to_string());
    SchemaConfigAdapter::new(schema, origin_fields, HashMap::new())
  }

  #[test]
  fn config_and_instance_origin_share_edge_url_canonicalization() {
    let adapter = adapter_for_origin_field(EDGE_TTS_BASE_URL_CONFIG_FIELD);
    let raw = r#"{"base-url":"https://custom.example/api/"}"#;
    let normalized = adapter.normalize_config(raw).unwrap();
    let value: Value = serde_json::from_str(&normalized).unwrap();
    assert_eq!(
      value.get(EDGE_TTS_BASE_URL_CONFIG_FIELD).and_then(Value::as_str),
      Some("https://custom.example/api")
    );
    let origin = adapter.instance_endpoint_origin(raw, "endpoint").unwrap();
    assert_eq!(origin.as_deref(), Some("https://custom.example/api"));
  }

  #[test]
  fn config_and_instance_origin_share_generic_url_canonicalization() {
    let adapter = adapter_for_origin_field("proxy-url");
    let raw = r#"{"proxy-url":"https://proxy.example/translate/"}"#;
    let normalized = adapter.normalize_config(raw).unwrap();
    let value: Value = serde_json::from_str(&normalized).unwrap();
    assert_eq!(
      value.get("proxy-url").and_then(Value::as_str),
      Some("https://proxy.example/translate/")
    );
    let origin = adapter.instance_endpoint_origin(raw, "endpoint").unwrap();
    assert_eq!(origin.as_deref(), Some("https://proxy.example/translate/"));
  }

  fn baidu_verified_package() -> VerifiedPackage {
    use crate::services::plugin_package::verify_package_bytes;
    use crate::services::vendor_trust::test_vendor_fixture::fixture_vendor_public_key_hex;
    let (bytes, _) = crate::services::test_support::baidu_ocr_package();
    verify_package_bytes(&bytes, &fixture_vendor_public_key_hex()).expect("baidu fixture verifies")
  }

  /// The real-shaped Baidu package projects its host-owned client-credentials auth binding
  /// (empty scope set), its api-key/secret-key slots, its ocr.image@1 capability, and its
  /// fixed endpoints/path authority before any instance credentials exist.
  #[test]
  fn baidu_definition_projection_preserves_host_auth_slots_and_ocr_authority() {
    let verified = baidu_verified_package();
    let registration = project_verified_package(&verified).expect("baidu fixture projects");
    let binding = registration.auth_policy.as_ref().expect("baidu auth binding");
    assert_eq!(
      binding.auth_driver_id,
      crate::services::auth_policies::BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID
    );
    assert_eq!(
      binding.auth_policy_id,
      crate::services::auth_policies::BAIDU_CLIENT_CREDENTIALS_AUTH_POLICY_ID
    );
    assert_eq!(
      binding.audience_policy_id,
      crate::services::auth_policies::BAIDU_OAUTH_AUDIENCE_POLICY_ID
    );
    assert!(
      binding.scopes.is_empty(),
      "Baidu client-credentials registers with no OAuth scopes"
    );

    let slots: Vec<(&str, bool)> = registration
      .manifest
      .credential_slots
      .iter()
      .map(|slot| (slot.id.as_str(), slot.required))
      .collect();
    assert_eq!(
      slots,
      vec![("api-key", true), ("secret-key", true)],
      "Baidu exposes api-key and secret-key slots"
    );

    let ocr = registration
      .capability(crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID)
      .expect("ocr.image@1 capability");
    let expected_paths = [
      ("baidu-general-basic", "rest/2.0/ocr/v1/general_basic"),
      ("baidu-accurate-basic", "rest/2.0/ocr/v1/accurate_basic"),
      ("baidu-general", "rest/2.0/ocr/v1/general"),
      ("baidu-accurate", "rest/2.0/ocr/v1/accurate"),
    ];
    assert_eq!(ocr.endpoint_authorities.len(), expected_paths.len());
    for authority in &ocr.endpoint_authorities {
      let expected = expected_paths
        .iter()
        .find(|(alias, _)| alias == &authority.endpoint_alias)
        .expect("authority alias is a fixed Baidu endpoint");
      assert_eq!(
        authority.path,
        CapabilityPathAuthority::Exact(expected.1.to_string()),
        "{}",
        authority.endpoint_alias
      );
      assert_eq!(
        authority.auth_policy_id.as_deref(),
        Some(crate::services::auth_policies::BAIDU_CLIENT_CREDENTIALS_AUTH_POLICY_ID)
      );
    }
    let endpoints = &registration.manifest.endpoints;
    assert_eq!(endpoints.len(), expected_paths.len());
    for grant in endpoints {
      assert_eq!(grant.base_url, crate::domain::service_integration::BAIDU_OCR_ORIGIN);
    }
  }

  /// An unknown auth policy in a signed package fails closed during projection; the host policy
  /// registry is the only authority for auth bindings.
  #[test]
  fn unknown_auth_policy_projection_fails_closed() {
    use crate::services::plugin_package::test_support::{build_signed_package_with_key, sample_manifest};
    use crate::services::plugin_package::verify_package_bytes;
    use crate::services::vendor_trust::test_vendor_fixture::{
      fixture_vendor_public_key_hex, fixture_vendor_signing_key,
    };

    let wasm = b"\0asm\x01\x00\x00\x00";
    let mut manifest = sample_manifest(wasm);
    manifest.publisher.key_id = crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID.into();
    manifest.publisher.key_fingerprint =
      crate::services::vendor_trust::test_vendor_fixture::fixture_vendor_fingerprint();
    manifest.permissions.auth_policies = vec!["com.example.auth.unknown".into()];
    let bytes = build_signed_package_with_key(
      &manifest,
      &[("artifacts/plugin.wasm", wasm.as_slice())],
      &fixture_vendor_signing_key(),
    );
    let verified = verify_package_bytes(&bytes, &fixture_vendor_public_key_hex()).expect("package verifies");
    match project_verified_package(&verified) {
      Err(err) => {
        assert!(err.to_string().contains("not a closed host policy"), "got {err}");
      }
      Ok(_) => panic!("unknown host auth policy must fail closed"),
    }
  }
}
