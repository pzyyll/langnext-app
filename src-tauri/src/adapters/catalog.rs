// ABOUTME: Adapter catalog facade over the strategy registry (metadata + validation).
// ABOUTME: Keeps existing service call sites stable while strategies own behavior.
use crate::adapters::protocol::AdapterMeta;
use crate::adapters::registry;
use crate::error::StorageError;
use std::collections::HashMap;

/// Metadata-only view of registered Provider adapters.
pub fn catalog() -> HashMap<&'static str, AdapterMeta> {
  registry::list()
    .into_iter()
    .map(|adapter| {
      let meta = adapter.meta();
      (meta.id, meta)
    })
    .collect()
}

pub fn get(adapter_id: &str) -> Result<AdapterMeta, StorageError> {
  Ok(registry::get(adapter_id)?.meta())
}

/// Delegate profile-option validation to the adapter strategy.
pub fn validate_profile_options(adapter_id: &str, options: &Option<serde_json::Value>) -> Result<(), StorageError> {
  registry::get(adapter_id)?.validate_profile_options(options)
}

/// Validate versioned capability override documents for models.
pub fn validate_capability_overrides(value: &Option<serde_json::Value>) -> Result<(), StorageError> {
  crate::domain::model::CapabilityOverridesV1::from_json(value).map(|_| ())
}

/// Whether a stored secret is required before calling remote endpoints for this adapter.
pub fn secret_required(adapter_id: &str, credential_kind: crate::domain::provider::CredentialKind) -> bool {
  match registry::get(adapter_id) {
    Ok(adapter) => adapter.secret_required(credential_kind),
    // Unknown adapters fail closed: require a secret so callers cannot skip auth by typo.
    Err(_) => true,
  }
}

/// Language-detection chat policy owned by the adapter strategy.
pub fn detect_chat_policy(
  adapter_id: &str,
  model_key: &str,
  base_url: &str,
) -> crate::adapters::protocol::DetectChatPolicy {
  match registry::get(adapter_id) {
    Ok(adapter) => adapter.detect_chat_policy(model_key, base_url),
    Err(_) => crate::adapters::protocol::DetectChatPolicy::default(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::provider::CredentialKind;

  #[test]
  fn known_adapters() {
    assert!(get("openai-compatible").is_ok());
    assert!(get("openai-responses").is_ok());
    assert!(get("anthropic").is_ok());
    assert!(get("gemini").is_ok());
    assert!(get("deepseek").is_ok());
    assert!(get("nope").is_err());
  }

  #[test]
  fn options_reject_nonempty() {
    assert!(validate_profile_options("openai-compatible", &None).is_ok());
    assert!(validate_profile_options("openai-compatible", &Some(serde_json::json!({}))).is_ok());
    assert!(validate_profile_options("openai-compatible", &Some(serde_json::json!({"temp": 1}))).is_err());
  }

  #[test]
  fn secret_required_by_adapter() {
    assert!(!secret_required("openai-compatible", CredentialKind::None));
    assert!(secret_required("openai-compatible", CredentialKind::ApiKey));
    assert!(secret_required("anthropic", CredentialKind::None));
    assert!(secret_required("gemini", CredentialKind::ApiKey));
    assert!(!secret_required("deepseek", CredentialKind::None));
    assert!(secret_required("deepseek", CredentialKind::ApiKey));
  }

  #[test]
  fn deepseek_detect_policy_disables_thinking() {
    let policy = detect_chat_policy("deepseek", "deepseek-chat", "https://api.deepseek.com");
    assert_eq!(policy.thinking, Some(false));
    assert!(policy.max_tokens > 256);
  }
}
