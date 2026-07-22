// ABOUTME: Provider adapter strategy trait and shared policy types.
// ABOUTME: Each adapter owns auth, list/chat wire format, and detect/translate policy hooks.
use crate::adapters::transport::{AuthApplication, ChatCompletionRequest, ParsedPage, TransportError};
use crate::domain::provider::CredentialKind;
use crate::error::StorageError;
use std::sync::Arc;

/// Default max_tokens for language-detection when the adapter has no special needs.
pub const DEFAULT_DETECT_MAX_TOKENS: u32 = 256;

/// Raised detect budget for adapters that may still emit chain-of-thought.
pub const DETECT_MAX_TOKENS_THINKING: u32 = 2048;

/// Adapter-owned adjustments applied when preparing a language-detection chat call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetectChatPolicy {
  /// DeepSeek `thinking.type` toggle. `None` omits the field.
  pub thinking: Option<bool>,
  pub max_tokens: u32,
}

impl Default for DetectChatPolicy {
  fn default() -> Self {
    Self {
      thinking: None,
      max_tokens: DEFAULT_DETECT_MAX_TOKENS,
    }
  }
}

/// Static catalog metadata for one adapter strategy.
#[derive(Debug, Clone, Copy)]
pub struct AdapterMeta {
  pub id: &'static str,
  pub label: &'static str,
  pub default_base_url: Option<&'static str>,
}

/// Strategy interface for a provider API family.
///
/// Built-ins register at process start; future plugins can call
/// [`crate::adapters::registry::register`] with the same contract.
pub trait ProviderAdapter: Send + Sync + 'static {
  fn meta(&self) -> AdapterMeta;

  fn id(&self) -> &'static str {
    self.meta().id
  }

  /// Whether a stored secret is required before calling remote endpoints.
  fn secret_required(&self, credential_kind: CredentialKind) -> bool;

  fn auth_application(&self, credential_kind: CredentialKind) -> Result<AuthApplication, TransportError>;

  /// Relative path joined onto the provider base URL for model listing.
  fn models_path(&self) -> &'static str;

  fn parse_models_page(&self, value: &serde_json::Value) -> Result<ParsedPage, TransportError>;

  /// Append pagination cursor query params. Default: adapters without list pagination reject.
  fn apply_list_continuation(&self, _url: &mut url::Url, _cursor: &str) -> Result<(), TransportError> {
    Err(TransportError::InvalidResponse)
  }

  /// Build chat/completions (or family equivalent) URL + JSON body.
  fn build_chat(
    &self,
    request: &ChatCompletionRequest,
    stream: bool,
  ) -> Result<(url::Url, serde_json::Value), TransportError>;

  fn parse_chat_content(&self, value: &serde_json::Value) -> Result<String, TransportError>;

  /// Extract one SSE/stream text delta. `None` skips keep-alives and non-text frames.
  fn parse_stream_delta(&self, event_name: Option<&str>, value: &serde_json::Value) -> Option<String>;

  /// Adapter-specific stream URL tweaks (e.g. Gemini `alt=sse`).
  fn finalize_stream_url(&self, _url: &mut url::Url) {}

  /// Policy for language-detection chat requests.
  fn detect_chat_policy(&self, _model_key: &str, _base_url: &str) -> DetectChatPolicy {
    DetectChatPolicy::default()
  }

  /// Until real per-adapter schemas land, only null/empty objects are accepted.
  fn validate_profile_options(&self, options: &Option<serde_json::Value>) -> Result<(), StorageError> {
    match options {
      None => Ok(()),
      Some(serde_json::Value::Object(map)) if map.is_empty() => Ok(()),
      Some(serde_json::Value::Null) => Ok(()),
      _ => Err(StorageError::Validation(
        "provider_options_json must be null or an empty object for built-in adapters".into(),
      )),
    }
  }
}

/// Owned handle used by transport and services.
pub type AdapterHandle = Arc<dyn ProviderAdapter>;
