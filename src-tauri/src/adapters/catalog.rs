// ABOUTME: Built-in adapter IDs and default metadata (no HTTP behavior).
// ABOUTME: Profile option validation rejects non-empty options until real schemas land.
use crate::error::StorageError;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct AdapterMeta {
  /// Stable adapter identifier used by Provider rows.
  #[allow(dead_code)] // retained for catalog consumers and future HTTP adapters
  pub id: &'static str,
  /// Documented default base URL for the adapter.
  #[allow(dead_code)] // retained for catalog consumers and future HTTP adapters
  pub default_base_url: Option<&'static str>,
}

/// Metadata-only catalog of built-in Provider adapters.
pub fn catalog() -> HashMap<&'static str, AdapterMeta> {
  let mut map = HashMap::new();
  map.insert(
    "openai-compatible",
    AdapterMeta {
      id: "openai-compatible",
      default_base_url: Some("https://api.openai.com/v1"),
    },
  );
  map.insert(
    "openai-responses",
    AdapterMeta {
      id: "openai-responses",
      default_base_url: Some("https://api.openai.com/v1"),
    },
  );
  map.insert(
    "anthropic",
    AdapterMeta {
      id: "anthropic",
      default_base_url: Some("https://api.anthropic.com"),
    },
  );
  map.insert(
    "gemini",
    AdapterMeta {
      id: "gemini",
      default_base_url: Some("https://generativelanguage.googleapis.com"),
    },
  );
  map
}

pub fn get(adapter_id: &str) -> Result<AdapterMeta, StorageError> {
  catalog()
    .get(adapter_id)
    .cloned()
    .ok_or_else(|| StorageError::Validation(format!("unknown adapter_id: {adapter_id}")))
}

/// Until real adapter schemas land, only null or empty objects are accepted.
pub fn validate_profile_options(_adapter_id: &str, options: &Option<serde_json::Value>) -> Result<(), StorageError> {
  match options {
    None => Ok(()),
    Some(serde_json::Value::Object(map)) if map.is_empty() => Ok(()),
    Some(serde_json::Value::Null) => Ok(()),
    _ => Err(StorageError::Validation(
      "provider_options_json must be null or an empty object for built-in adapters".into(),
    )),
  }
}

/// Validate versioned capability override documents for models.
pub fn validate_capability_overrides(value: &Option<serde_json::Value>) -> Result<(), StorageError> {
  crate::domain::model::CapabilityOverridesV1::from_json(value).map(|_| ())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn known_adapters() {
    assert!(get("openai-compatible").is_ok());
    assert!(get("openai-responses").is_ok());
    assert!(get("anthropic").is_ok());
    assert!(get("gemini").is_ok());
    assert!(get("nope").is_err());
  }

  #[test]
  fn options_reject_nonempty() {
    assert!(validate_profile_options("openai-compatible", &None).is_ok());
    assert!(validate_profile_options("openai-compatible", &Some(serde_json::json!({}))).is_ok());
    assert!(validate_profile_options("openai-compatible", &Some(serde_json::json!({"temp": 1}))).is_err());
  }
}
