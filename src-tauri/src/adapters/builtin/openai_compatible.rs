// ABOUTME: OpenAI-compatible chat.completions adapter strategy.
// ABOUTME: Owns auth, model list, chat/stream wire format, and DeepSeek-relay detect policy.
use crate::adapters::builtin::openai_shared::{
  build_openai_chat_completions, parse_openai_chat_content, parse_openai_page, parse_openai_stream_delta,
};
use crate::adapters::protocol::{AdapterMeta, DETECT_MAX_TOKENS_THINKING, DetectChatPolicy, ProviderAdapter};
use crate::adapters::transport::{AuthApplication, ChatCompletionRequest, ParsedPage, TransportError};
use crate::domain::provider::CredentialKind;

/// OpenAI chat.completions-compatible endpoints (official + third-party relays).
#[derive(Debug, Default, Clone, Copy)]
pub struct OpenAiCompatibleAdapter;

impl ProviderAdapter for OpenAiCompatibleAdapter {
  fn meta(&self) -> AdapterMeta {
    AdapterMeta {
      id: "openai-compatible",
      label: "OpenAI Compatible",
      default_base_url: Some("https://api.openai.com/v1"),
    }
  }

  fn secret_required(&self, credential_kind: CredentialKind) -> bool {
    matches!(credential_kind, CredentialKind::ApiKey | CredentialKind::Bearer)
  }

  fn auth_application(&self, credential_kind: CredentialKind) -> Result<AuthApplication, TransportError> {
    match credential_kind {
      CredentialKind::None => Ok(AuthApplication::None),
      CredentialKind::ApiKey | CredentialKind::Bearer => Ok(AuthApplication::BearerHeader),
    }
  }

  fn models_path(&self) -> &'static str {
    "models"
  }

  fn parse_models_page(&self, value: &serde_json::Value) -> Result<ParsedPage, TransportError> {
    parse_openai_page(value)
  }

  fn build_chat(
    &self,
    request: &ChatCompletionRequest,
    stream: bool,
  ) -> Result<(url::Url, serde_json::Value), TransportError> {
    build_openai_chat_completions(
      &request.base_url,
      &request.model_key,
      &request.system_prompt,
      &request.user_prompt,
      request.temperature,
      request.max_tokens,
      request.thinking,
      request.image_png_base64.as_deref(),
      stream,
    )
  }

  fn parse_chat_content(&self, value: &serde_json::Value) -> Result<String, TransportError> {
    parse_openai_chat_content(value)
  }

  fn parse_stream_delta(&self, _event_name: Option<&str>, value: &serde_json::Value) -> Option<String> {
    parse_openai_stream_delta(value)
  }

  fn detect_chat_policy(&self, model_key: &str, base_url: &str) -> DetectChatPolicy {
    // Relays that host DeepSeek under openai-compatible still need thinking disabled
    // for short detect answers. Prefer the dedicated `deepseek` adapter for new configs.
    if looks_like_deepseek_relay(model_key, base_url) {
      DetectChatPolicy {
        thinking: Some(false),
        max_tokens: DETECT_MAX_TOKENS_THINKING,
      }
    } else {
      DetectChatPolicy::default()
    }
  }
}

/// Heuristic for DeepSeek-style models hosted on generic OpenAI-compatible relays.
fn looks_like_deepseek_relay(model_key: &str, base_url: &str) -> bool {
  let model = model_key.to_ascii_lowercase();
  let base = base_url.to_ascii_lowercase();
  model.contains("deepseek") || base.contains("deepseek")
}
