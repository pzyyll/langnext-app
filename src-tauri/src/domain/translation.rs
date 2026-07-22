// ABOUTME: Translate IPC input/result DTOs retained for history and type alignment.
// ABOUTME: Streaming no longer uses global translate://* events; frontend owns Channels.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Soft failure code when the user (or UI) cancels an in-flight translate.
pub const TRANSLATE_CANCELLED_CODE: &str = "cancelled";

/**
 * Frontend request to translate text with a configured provider model.
 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateInput {
  /// Provider model row id (`provider_models.id`) - primary model to try first.
  pub model_id: Uuid,
  /// Source language id or display label from the UI (e.g. `zh`, `en`).
  pub source_lang: String,
  /// Target language id or display label from the UI.
  pub target_lang: String,
  /// Source text to translate (not persisted).
  pub text: String,
  /// Optional profile for templates + fallback model chain.
  #[serde(default)]
  pub profile_id: Option<Uuid>,
  /// Optional prompt-template override for this request. Must belong to `profile_id` when set.
  #[serde(default)]
  pub prompt_template_id: Option<Uuid>,
  #[serde(default)]
  pub source_lang_id: Option<String>,
  #[serde(default)]
  pub target_lang_id: Option<String>,
  #[serde(default)]
  pub effective_source_lang_id: Option<String>,
  #[serde(default)]
  pub effective_target_lang_id: Option<String>,
}

/// Successful translation payload returned to the WebView.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateResult {
  pub translated_text: String,
  /// Wall-clock duration of the provider HTTP call in milliseconds.
  pub latency_ms: u64,
  /// Bounded transport/credential failure code when `ok` is false.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error_code: Option<String>,
  /// Human-readable status or error message (secret-free).
  pub message: String,
  pub ok: bool,
  /// Model that produced the result when fallback chain was used.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub model_id: Option<Uuid>,
}

impl TranslateResult {
  pub fn success(translated_text: String, latency_ms: u64) -> Self {
    Self {
      translated_text,
      latency_ms,
      error_code: None,
      message: "ok".into(),
      ok: true,
      model_id: None,
    }
  }

  pub fn success_with_model(translated_text: String, latency_ms: u64, model_id: Uuid) -> Self {
    Self {
      translated_text,
      latency_ms,
      error_code: None,
      message: "ok".into(),
      ok: true,
      model_id: Some(model_id),
    }
  }

  pub fn failure(error_code: impl Into<String>, message: impl Into<String>, latency_ms: u64) -> Self {
    Self {
      translated_text: String::new(),
      latency_ms,
      error_code: Some(error_code.into()),
      message: message.into(),
      ok: false,
      model_id: None,
    }
  }

  pub fn cancelled(latency_ms: u64) -> Self {
    Self::failure(TRANSLATE_CANCELLED_CODE, "Translation cancelled", latency_ms)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cancelled_uses_stable_code() {
    let result = TranslateResult::cancelled(3);
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some(TRANSLATE_CANCELLED_CODE));
  }
}
