// ABOUTME: DeepSeek OpenAI-compatible adapter with first-class thinking policy.
// ABOUTME: Reuses chat.completions wire format; owns detect/translate thinking defaults.
use crate::adapters::builtin::openai_shared::{
  build_openai_chat_completions, parse_openai_chat_content, parse_openai_page, parse_openai_stream_delta,
};
use crate::adapters::protocol::{AdapterMeta, DETECT_MAX_TOKENS_THINKING, DetectChatPolicy, ProviderAdapter};
use crate::adapters::transport::{AuthApplication, ChatCompletionRequest, ParsedPage, TransportError};
use crate::domain::provider::CredentialKind;

/// DeepSeek API (OpenAI-compatible wire format + thinking controls).
///
/// DeepSeek V4 defaults thinking to **enabled**. Detection turns thinking off and
/// raises `max_tokens` so a short answer still fits if a gateway ignores the toggle.
#[derive(Debug, Default, Clone, Copy)]
pub struct DeepSeekAdapter;

impl ProviderAdapter for DeepSeekAdapter {
  fn meta(&self) -> AdapterMeta {
    AdapterMeta {
      id: "deepseek",
      label: "DeepSeek",
      default_base_url: Some("https://api.deepseek.com"),
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
    let (url, mut payload) = build_openai_chat_completions(
      &request.base_url,
      &request.model_key,
      &request.system_prompt,
      &request.user_prompt,
      request.temperature,
      request.max_tokens,
      request.image_png_base64.as_deref(),
      stream,
    )?;
    apply_deepseek_thinking(&mut payload, request.thinking);
    Ok((url, payload))
  }

  fn parse_chat_content(&self, value: &serde_json::Value) -> Result<String, TransportError> {
    parse_openai_chat_content(value)
  }

  fn parse_stream_delta(&self, _event_name: Option<&str>, value: &serde_json::Value) -> Option<String> {
    parse_openai_stream_delta(value)
  }

  fn detect_chat_policy(&self, _model_key: &str, _base_url: &str) -> DetectChatPolicy {
    DetectChatPolicy {
      // Best-effort disable; some relays ignore the toggle and still emit CoT.
      thinking: Some(false),
      max_tokens: DETECT_MAX_TOKENS_THINKING,
    }
  }
}

/// DeepSeek-only `thinking.type` control (`enabled` / `disabled`).
fn apply_deepseek_thinking(payload: &mut serde_json::Value, thinking: Option<bool>) {
  if let Some(enabled) = thinking {
    payload["thinking"] = serde_json::json!({
      "type": if enabled { "enabled" } else { "disabled" }
    });
  }
}
