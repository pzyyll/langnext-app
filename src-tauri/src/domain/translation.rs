// ABOUTME: Translate IPC input/result DTOs and streaming event payloads.
// ABOUTME: Never includes secrets, rendered prompts beyond user text, or full provider payloads.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
  /// Configured source language id (`auto` allowed). History metadata only; prompts use `source_lang`.
  #[serde(default)]
  pub source_lang_id: Option<String>,
  /// Configured target language id (`auto` allowed). History metadata only.
  #[serde(default)]
  pub target_lang_id: Option<String>,
  /// Concrete source language id actually used (post-detection). History metadata only.
  #[serde(default)]
  pub effective_source_lang_id: Option<String>,
  /// Concrete target language id actually used (post Auto resolution). History metadata only.
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

/// Event name for progressive translation text chunks.
pub const TRANSLATE_CHUNK_EVENT: &str = "translate://chunk";
/// Event name for a finished stream (success path).
pub const TRANSLATE_DONE_EVENT: &str = "translate://done";
/// Event name for a hard stream failure after all retries.
pub const TRANSLATE_ERROR_EVENT: &str = "translate://error";
/// Event name when the fallback chain switches models mid-stream.
pub const TRANSLATE_RESET_EVENT: &str = "translate://reset";

/// Soft failure code when the user (or UI) cancels an in-flight translate.
pub const TRANSLATE_CANCELLED_CODE: &str = "cancelled";

/// One streamed text fragment for the active request id.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateStreamChunk {
  pub id: String,
  pub delta: String,
}

/// Clears progressive output before chunks from the next fallback model arrive.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateStreamReset {
  pub id: String,
  /// Model that will produce the next chunks (next fallback target).
  pub model_id: Uuid,
}

/// Terminal success/soft-failure payload after streaming (or non-stream fallback path).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateStreamDone {
  pub id: String,
  pub translated_text: String,
  pub latency_ms: u64,
  pub ok: bool,
  pub message: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error_code: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub model_id: Option<Uuid>,
}

/// Terminal hard error when the stream cannot complete.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateStreamError {
  pub id: String,
  pub error_code: String,
  pub message: String,
  pub latency_ms: u64,
}

impl TranslateStreamDone {
  pub fn from_result(id: String, result: TranslateResult) -> Self {
    Self {
      id,
      translated_text: result.translated_text,
      latency_ms: result.latency_ms,
      ok: result.ok,
      message: result.message,
      error_code: result.error_code,
      model_id: result.model_id,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cancelled_result_uses_stable_code() {
    let result = TranslateResult::cancelled(12);
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some(TRANSLATE_CANCELLED_CODE));
    assert!(result.translated_text.is_empty());
    assert_eq!(result.latency_ms, 12);
  }

  #[test]
  fn stream_done_from_cancelled_preserves_code() {
    let done = TranslateStreamDone::from_result("req-1".into(), TranslateResult::cancelled(3));
    assert_eq!(done.id, "req-1");
    assert!(!done.ok);
    assert_eq!(done.error_code.as_deref(), Some("cancelled"));
  }

  #[test]
  fn reset_event_name_is_stable() {
    assert_eq!(TRANSLATE_RESET_EVENT, "translate://reset");
    assert_eq!(TRANSLATE_CHUNK_EVENT, "translate://chunk");
  }
}
