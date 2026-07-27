// ABOUTME: Speech service domain entities, write inputs, and sanitized DTOs.
// ABOUTME: Capability preferences stay host-validated; secrets never appear on DTOs.
use crate::domain::service_capability::{SPEECH_SYNTHESIZE_CAPABILITY_ID, SpeechSynthesizePreferences};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

/// Maximum length for Speech service display names.
pub const SPEECH_DISPLAY_NAME_MAX_LEN: usize = 128;
/// Google TTS preferences schema version (v1: speakingRate + pitch).
pub const GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION: i32 = 1;
/// Edge TTS preferences schema version (v1: voice + speed + pitch + style).
pub const EDGE_TTS_PREFERENCES_SCHEMA_VERSION: i32 = 1;

/// Internal Speech service row.
#[derive(Debug, Clone, PartialEq)]
pub struct SpeechService {
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

/// Sanitized Speech service DTO for IPC.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechServiceDto {
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

impl SpeechServiceDto {
  pub fn from_service(service: &SpeechService) -> Self {
    Self {
      id: service.id,
      display_name: service.display_name.clone(),
      enabled: service.enabled,
      sort_order: service.sort_order,
      integration_instance_id: service.integration_instance_id,
      capability_id: service.capability_id.clone(),
      preferences_schema_version: service.preferences_schema_version,
      preferences: service.preferences.clone(),
      created_at: service.created_at.clone(),
      updated_at: service.updated_at.clone(),
    }
  }
}

/// Input for creating or updating a Speech service.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechServiceWrite {
  pub id: Option<Uuid>,
  pub display_name: String,
  pub enabled: bool,
  pub integration_instance_id: Uuid,
  pub capability_id: String,
  pub preferences_schema_version: i32,
  pub preferences: Value,
  /// Required on update.
  #[serde(default)]
  pub expected_updated_at: Option<String>,
}

/// Input for one-shot speech synthesis.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechSynthesizeInput {
  pub text: String,
  /// Application language id (e.g. `en`, `zh`); never a free-form BCP-47 override from the page.
  pub language_id: String,
  /// Explicit service; when null/absent the app settings default is used.
  #[serde(default)]
  pub speech_service_id: Option<Uuid>,
  /// Optional client request id for cancellation via the shared session registry.
  #[serde(default)]
  pub request_id: Option<String>,
}

/// Default Google TTS preferences for schema v1.
pub fn default_google_tts_preferences() -> Value {
  json!({
    "speaking-rate": 1.0,
    "pitch": 0.0,
  })
}

/// Default Edge TTS preferences for schema v1 (Xiaoxiao voice, general style).
pub fn default_edge_tts_preferences() -> Value {
  json!({
    "voice": "zh-CN-XiaoxiaoNeural",
    "speed": 1.0,
    "pitch": 0,
    "style": "general",
  })
}

/// Parse stored preferences JSON into typed synthesis preferences.
pub fn parse_speech_synthesize_preferences(value: &Value) -> Result<SpeechSynthesizePreferences, String> {
  serde_json::from_value(value.clone()).map_err(|e| format!("invalid Speech preferences: {e}"))
}

/// Canonical default capability id for Google Cloud TTS.
pub fn default_speech_capability_id() -> &'static str {
  SPEECH_SYNTHESIZE_CAPABILITY_ID
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::time::{new_id, now_rfc3339};

  #[test]
  fn dto_json_shape_is_secret_free() {
    let service = SpeechService {
      id: new_id(),
      display_name: "Google Cloud TTS".into(),
      enabled: true,
      sort_order: 0,
      integration_instance_id: new_id(),
      capability_id: SPEECH_SYNTHESIZE_CAPABILITY_ID.into(),
      preferences_schema_version: GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION,
      preferences: default_google_tts_preferences(),
      created_at: now_rfc3339(),
      updated_at: now_rfc3339(),
    };
    let dto = SpeechServiceDto::from_service(&service);
    let json = serde_json::to_string(&dto).unwrap();
    assert!(json.contains("\"capabilityId\":\"speech.synthesize@1\""));
    assert!(json.contains("\"speaking-rate\":1.0"));
    assert!(!json.contains("credential"));
    assert!(!json.contains("token"));
  }

  #[test]
  fn default_google_tts_preferences_parse() {
    let prefs = parse_speech_synthesize_preferences(&default_google_tts_preferences()).unwrap();
    assert!((prefs.speaking_rate - 1.0).abs() < f64::EPSILON);
    assert!((prefs.pitch - 0.0).abs() < f64::EPSILON);
  }
}
