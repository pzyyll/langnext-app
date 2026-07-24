// ABOUTME: Typed service-capability request/response contracts and stable capability errors.
// ABOUTME: Host-owned limits reject oversized request IDs, text, and language fields fail-closed.
use crate::domain::cancel::CancelToken;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::Duration;
use uuid::Uuid;

/// Max request_id length accepted by capability handlers and brokers.
pub const CAPABILITY_REQUEST_ID_MAX_LEN: usize = 128;
/// Max translate/detect text payload (UTF-8 bytes).
pub const CAPABILITY_TEXT_MAX_BYTES: usize = 30 * 1024;
/// Max app language id length (e.g. `zh`, `en`).
pub const CAPABILITY_LANGUAGE_ID_MAX_LEN: usize = 16;
/// Max sanitized provider error code length.
pub const CAPABILITY_PROVIDER_CODE_MAX_LEN: usize = 64;
/// Max capability error message length returned to callers.
pub const CAPABILITY_ERROR_MESSAGE_MAX_LEN: usize = 256;
/// Default validation/token-exchange timeout.
pub const CAPABILITY_DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// Stable capability failure codes (never embed secrets or raw provider bodies).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityErrorCode {
  InvalidConfiguration,
  InvalidRequest,
  Auth,
  PermissionDenied,
  QuotaExceeded,
  RateLimited,
  UnsupportedInput,
  UnsupportedLanguage,
  Network,
  Timeout,
  InvalidResponse,
  ProviderUnavailable,
  PluginUnavailable,
  Cancelled,
  Internal,
}

impl CapabilityErrorCode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::InvalidConfiguration => "invalid_configuration",
      Self::InvalidRequest => "invalid_request",
      Self::Auth => "auth",
      Self::PermissionDenied => "permission_denied",
      Self::QuotaExceeded => "quota_exceeded",
      Self::RateLimited => "rate_limited",
      Self::UnsupportedInput => "unsupported_input",
      Self::UnsupportedLanguage => "unsupported_language",
      Self::Network => "network",
      Self::Timeout => "timeout",
      Self::InvalidResponse => "invalid_response",
      Self::ProviderUnavailable => "provider_unavailable",
      Self::PluginUnavailable => "plugin_unavailable",
      Self::Cancelled => "cancelled",
      Self::Internal => "internal",
    }
  }

  /// Whether a bounded retry may be appropriate for this failure class.
  pub fn default_retryable(self) -> bool {
    matches!(
      self,
      Self::RateLimited | Self::QuotaExceeded | Self::Network | Self::Timeout | Self::ProviderUnavailable
    )
  }
}

/// Capability dispatch error with stable code and safe metadata.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityError {
  pub code: CapabilityErrorCode,
  pub message: String,
  pub retryable: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub provider_code: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub capability_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub request_id: Option<String>,
}

impl CapabilityError {
  pub fn new(code: CapabilityErrorCode, message: impl Into<String>) -> Self {
    let message = truncate_chars(message.into(), CAPABILITY_ERROR_MESSAGE_MAX_LEN);
    Self {
      code,
      message,
      retryable: code.default_retryable(),
      provider_code: None,
      capability_id: None,
      request_id: None,
    }
  }

  pub fn with_retryable(mut self, retryable: bool) -> Self {
    self.retryable = retryable;
    self
  }

  pub fn with_provider_code(mut self, provider_code: impl Into<String>) -> Self {
    let code = truncate_chars(provider_code.into(), CAPABILITY_PROVIDER_CODE_MAX_LEN);
    if !code.is_empty() {
      self.provider_code = Some(code);
    }
    self
  }

  pub fn with_capability_id(mut self, capability_id: impl Into<String>) -> Self {
    self.capability_id = Some(capability_id.into());
    self
  }

  pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
    self.request_id = Some(request_id.into());
    self
  }
}

impl fmt::Debug for CapabilityError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("CapabilityError")
      .field("code", &self.code.as_str())
      .field("retryable", &self.retryable)
      .field("provider_code", &self.provider_code)
      .field("capability_id", &self.capability_id)
      .field("request_id", &self.request_id)
      .field("message_len", &self.message.len())
      .finish()
  }
}

impl fmt::Display for CapabilityError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}: {}", self.code.as_str(), self.message)
  }
}

impl std::error::Error for CapabilityError {}

/// Per-invocation execution identity and cancellation (broker handles stay on services).
#[derive(Debug, Clone)]
pub struct ExecutionContext {
  pub request_id: String,
  pub cancel: CancelToken,
  pub deadline: Option<Duration>,
  pub integration_instance_id: Uuid,
  pub plugin_id: String,
  pub capability_id: String,
}

/// Translate text capability request (application language ids).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTextRequest {
  pub text: String,
  /// App source language id, or `auto` / empty for provider detection.
  pub source_language_id: String,
  pub target_language_id: String,
}

/// Translate text capability response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTextResponse {
  pub translated_text: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detected_source_language_id: Option<String>,
}

/// Detect language capability request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectLanguageRequest {
  pub text: String,
}

/// Detect language capability response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectLanguageResponse {
  pub language_id: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub confidence: Option<f32>,
}

/// Validate a capability request id (non-empty, bounded, no outer whitespace).
pub fn validate_capability_request_id(request_id: &str) -> Result<(), CapabilityError> {
  let trimmed = request_id.trim();
  if trimmed.is_empty() || trimmed.len() > CAPABILITY_REQUEST_ID_MAX_LEN {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("request_id must be non-empty and at most {CAPABILITY_REQUEST_ID_MAX_LEN} characters"),
    ));
  }
  if trimmed != request_id {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "request_id must not have leading or trailing whitespace",
    ));
  }
  Ok(())
}

/// Validate translate/detect text against the named byte bound.
pub fn validate_capability_text(text: &str) -> Result<(), CapabilityError> {
  if text.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "text must not be empty",
    ));
  }
  if text.len() > CAPABILITY_TEXT_MAX_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      format!("text exceeds {CAPABILITY_TEXT_MAX_BYTES} bytes"),
    ));
  }
  Ok(())
}

/// Validate an application language id field.
pub fn validate_capability_language_id(language_id: &str, field: &str) -> Result<(), CapabilityError> {
  let trimmed = language_id.trim();
  if trimmed.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("{field} is required"),
    ));
  }
  if trimmed.len() > CAPABILITY_LANGUAGE_ID_MAX_LEN {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("{field} exceeds {CAPABILITY_LANGUAGE_ID_MAX_LEN} characters"),
    ));
  }
  if trimmed != language_id {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("{field} must not have leading or trailing whitespace"),
    ));
  }
  Ok(())
}

fn truncate_chars(input: String, max_chars: usize) -> String {
  if input.chars().count() <= max_chars {
    return input;
  }
  input.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn service_capability_rejects_oversized_request_id() {
    let long = "r".repeat(CAPABILITY_REQUEST_ID_MAX_LEN + 1);
    let err = validate_capability_request_id(&long).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidRequest);
  }

  #[test]
  fn service_capability_rejects_empty_and_padded_request_id() {
    assert!(validate_capability_request_id("").is_err());
    assert!(validate_capability_request_id("  abc  ").is_err());
    assert!(validate_capability_request_id("ok-id").is_ok());
  }

  #[test]
  fn service_capability_rejects_oversized_text() {
    let text = "a".repeat(CAPABILITY_TEXT_MAX_BYTES + 1);
    let err = validate_capability_text(&text).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedInput);
  }

  #[test]
  fn service_capability_rejects_empty_text() {
    let err = validate_capability_text("").unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidRequest);
  }

  #[test]
  fn service_capability_rejects_oversized_language_id() {
    let long = "l".repeat(CAPABILITY_LANGUAGE_ID_MAX_LEN + 1);
    let err = validate_capability_language_id(&long, "target_language_id").unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidRequest);
  }

  #[test]
  fn capability_error_debug_omits_message_body() {
    let err = CapabilityError::new(CapabilityErrorCode::Auth, "secret-looking-detail");
    let rendered = format!("{err:?}");
    assert!(!rendered.contains("secret-looking-detail"));
    assert!(rendered.contains("auth"));
  }

  #[test]
  fn capability_error_codes_are_stable_snake_case() {
    assert_eq!(CapabilityErrorCode::PermissionDenied.as_str(), "permission_denied");
    assert_eq!(
      CapabilityErrorCode::UnsupportedLanguage.as_str(),
      "unsupported_language"
    );
    assert!(CapabilityErrorCode::RateLimited.default_retryable());
    assert!(!CapabilityErrorCode::Auth.default_retryable());
  }
}
