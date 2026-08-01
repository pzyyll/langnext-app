// ABOUTME: Shared no-std Google Cloud wire codecs for the four runtime Components.
// ABOUTME: Maps app languages and normalizes Google HTTP, Vision, and TTS failures without bodies.
#![no_std]

extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde::Deserialize;
use serde_json::{json, Value};

pub const CAPABILITY_TEXT_MAX_BYTES: usize = 30 * 1024;
pub const OCR_IMAGE_MAX_DECODED_BYTES: usize = 8 * 1024 * 1024;
pub const SPEECH_AUDIO_MAX_BYTES: usize = 12 * 1024 * 1024;
pub const GOOGLE_TRANSLATE_MIME_TYPE: &str = "text/plain";
pub const GOOGLE_TRANSLATE_API_VERSION: &str = "v3beta1";
pub const GOOGLE_TRANSLATE_ENDPOINT: &str = "translate";
pub const GOOGLE_VISION_ENDPOINT: &str = "vision";
pub const GOOGLE_VISION_PATH: &str = "v1/images:annotate";
pub const GOOGLE_TTS_ENDPOINT: &str = "text-to-speech";
pub const GOOGLE_TTS_PATH: &str = "v1/text:synthesize";
pub const GOOGLE_TTS_AUDIO_CONTENT_TYPE: &str = "audio/mpeg";
pub const TOKEN_GRANT_AUTH_FAILURE_MARKER: &str = "token-grant-auth-failed";

pub const SUPPORTED_LANGUAGES: &[&str] = &[
  "zh", "en", "ar", "bg", "bn", "cs", "da", "de", "el", "es", "fa", "fi", "fr", "he", "hi", "hr",
  "hu", "id", "it", "ja", "ko", "lt", "lv", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl",
  "sr", "sv", "sw", "ta", "th", "tl", "tr", "uk", "ur", "vi",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
  InvalidRequest,
  InvalidConfiguration,
  UnsupportedInput,
  UnsupportedLanguage,
  Auth,
  PermissionDenied,
  QuotaExceeded,
  RateLimited,
  InvalidResponse,
  ProviderUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslateResponse {
  pub translated_text: String,
  pub detected_source_language_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DetectResponse {
  pub language_id: String,
  pub confidence: Option<f32>,
}

pub fn app_language_to_google(app_id: &str) -> Option<&'static str> {
  let id = app_id.trim().to_ascii_lowercase();
  match id.as_str() {
    "zh" => Some("zh-CN"),
    "no" => Some("nb"),
    "tl" => Some("fil"),
    other => SUPPORTED_LANGUAGES
      .iter()
      .copied()
      .find(|value| *value == other),
  }
}

pub fn google_language_to_app(google_code: &str) -> Option<&'static str> {
  let lower = google_code.trim().to_ascii_lowercase();
  match lower.as_str() {
    "zh" | "zh-cn" | "zh-hans" | "zh-tw" | "zh-hant" => Some("zh"),
    "nb" | "nn" | "no" => Some("no"),
    "fil" | "tl" => Some("tl"),
    "iw" => Some("he"),
    other => {
      let base = other.split('-').next().unwrap_or(other);
      SUPPORTED_LANGUAGES
        .iter()
        .copied()
        .find(|value| *value == base)
    }
  }
}

pub fn validate_config(config: &[u8]) -> Result<(), ProtocolError> {
  if config.is_empty() {
    return Ok(());
  }
  let value: Value =
    serde_json::from_slice(config).map_err(|_| ProtocolError::InvalidConfiguration)?;
  if !value.is_object() {
    return Err(ProtocolError::InvalidConfiguration);
  }
  Ok(())
}

pub fn config_project_location(config: &[u8]) -> Result<(String, String), ProtocolError> {
  let value: Value =
    serde_json::from_slice(config).map_err(|_| ProtocolError::InvalidConfiguration)?;
  let project = value
    .get("project-id")
    .or_else(|| value.get("projectId"))
    .and_then(Value::as_str)
    .ok_or(ProtocolError::InvalidConfiguration)?;
  let location = value
    .get("location")
    .and_then(Value::as_str)
    .filter(|value| !value.trim().is_empty())
    .unwrap_or("global");
  Ok((path_segment(project)?, path_segment(location)?))
}

pub fn translate_request_body(
  text: &str,
  source_language_id: &str,
  target_language_id: &str,
  project_id: &str,
  location: &str,
) -> Result<(String, Vec<u8>), ProtocolError> {
  let target =
    app_language_to_google(target_language_id).ok_or(ProtocolError::UnsupportedLanguage)?;
  let source = if source_language_id.is_empty() || source_language_id == "auto" {
    None
  } else {
    Some(app_language_to_google(source_language_id).ok_or(ProtocolError::UnsupportedLanguage)?)
  };
  let project = path_segment(project_id)?;
  let location = path_segment(location)?;
  let mut body = json!({
      "contents": [text],
      "mimeType": GOOGLE_TRANSLATE_MIME_TYPE,
      "targetLanguageCode": target,
  });
  if let Some(source) = source {
    body["sourceLanguageCode"] = Value::String(source.to_string());
  }
  let path = alloc::format!(
    "{GOOGLE_TRANSLATE_API_VERSION}/projects/{project}/locations/{location}:translateText"
  );
  let body = serde_json::to_vec(&body).map_err(|_| ProtocolError::InvalidRequest)?;
  Ok((path, body))
}

pub fn detect_request_body(
  text: &str,
  project_id: &str,
  location: &str,
) -> Result<(String, Vec<u8>), ProtocolError> {
  let project = path_segment(project_id)?;
  let location = path_segment(location)?;
  let path = alloc::format!(
    "{GOOGLE_TRANSLATE_API_VERSION}/projects/{project}/locations/{location}:detectLanguage"
  );
  let body = serde_json::to_vec(&json!({
      "content": text,
      "mimeType": GOOGLE_TRANSLATE_MIME_TYPE,
  }))
  .map_err(|_| ProtocolError::InvalidRequest)?;
  Ok((path, body))
}

pub fn vision_request_body(
  image_base64: &str,
  operation: &str,
  language_hints: &[String],
) -> Result<Vec<u8>, ProtocolError> {
  let feature = match operation {
    "text_detection" => "TEXT_DETECTION",
    "document_text_detection" | "" => "DOCUMENT_TEXT_DETECTION",
    _ => return Err(ProtocolError::InvalidRequest),
  };
  let mut request = json!({
      "image": { "content": image_base64 },
      "features": [{ "type": feature }],
  });
  if !language_hints.is_empty() {
    let mapped = language_hints
      .iter()
      .map(|hint| {
        app_language_to_google(hint)
          .ok_or(ProtocolError::UnsupportedLanguage)
          .map(str::to_string)
      })
      .collect::<Result<Vec<_>, _>>()?;
    request["imageContext"] = json!({ "languageHints": mapped });
  }
  serde_json::to_vec(&json!({ "requests": [request] })).map_err(|_| ProtocolError::InvalidRequest)
}

pub fn tts_request_body(
  text: &str,
  language_id: &str,
  speaking_rate: f64,
  pitch: f64,
) -> Result<Vec<u8>, ProtocolError> {
  let language_code =
    app_language_to_google(language_id).ok_or(ProtocolError::UnsupportedLanguage)?;
  serde_json::to_vec(&json!({
      "input": { "text": text },
      "voice": { "languageCode": language_code },
      "audioConfig": {
          "audioEncoding": "MP3",
          "speakingRate": speaking_rate,
          "pitch": pitch,
      },
  }))
  .map_err(|_| ProtocolError::InvalidRequest)
}

pub fn parse_translate_response(
  status: u16,
  body: &str,
) -> Result<TranslateResponse, ProtocolError> {
  map_google_http_error(status, body)?;
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct ApiResponse {
    #[serde(default)]
    translations: Vec<ApiTranslation>,
  }
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct ApiTranslation {
    translated_text: Option<String>,
    detected_language_code: Option<String>,
  }
  let parsed: ApiResponse =
    serde_json::from_str(body).map_err(|_| ProtocolError::InvalidResponse)?;
  let first = parsed
    .translations
    .into_iter()
    .next()
    .ok_or(ProtocolError::InvalidResponse)?;
  let translated = first
    .translated_text
    .filter(|value| !value.is_empty() && value.len() <= CAPABILITY_TEXT_MAX_BYTES)
    .ok_or(ProtocolError::InvalidResponse)?;
  let detected = first
    .detected_language_code
    .as_deref()
    .and_then(google_language_to_app)
    .map(str::to_string);
  Ok(TranslateResponse {
    translated_text: translated,
    detected_source_language_id: detected,
  })
}

pub fn parse_detect_response(status: u16, body: &str) -> Result<DetectResponse, ProtocolError> {
  map_google_http_error(status, body)?;
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct ApiResponse {
    #[serde(default)]
    languages: Vec<ApiLanguage>,
  }
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct ApiLanguage {
    language_code: Option<String>,
    confidence: Option<f32>,
  }
  let parsed: ApiResponse =
    serde_json::from_str(body).map_err(|_| ProtocolError::InvalidResponse)?;
  let mut best: Option<(String, Option<f32>)> = None;
  for item in parsed.languages.into_iter().take(16) {
    let Some(code) = item.language_code.as_deref() else {
      continue;
    };
    let Some(language_id) = google_language_to_app(code) else {
      continue;
    };
    let confidence = item
      .confidence
      .filter(|value| value.is_finite() && (0.0..=1.0).contains(value));
    let replace = match (&best, confidence) {
      (None, _) => true,
      (Some((_, Some(previous))), Some(current)) => current > *previous,
      (Some((_, None)), Some(_)) => true,
      _ => false,
    };
    if replace {
      best = Some((language_id.to_string(), confidence));
    }
  }
  let (language_id, confidence) = best.ok_or(ProtocolError::UnsupportedLanguage)?;
  Ok(DetectResponse {
    language_id,
    confidence,
  })
}

pub fn parse_vision_response(status: u16, body: &str) -> Result<String, ProtocolError> {
  map_google_http_error(status, body)?;
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct ApiResponse {
    #[serde(default)]
    responses: Vec<ApiItem>,
  }
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct ApiItem {
    full_text_annotation: Option<FullText>,
    #[serde(default)]
    text_annotations: Vec<TextAnnotation>,
    error: Option<VisionError>,
  }
  #[derive(Deserialize)]
  struct FullText {
    text: Option<String>,
  }
  #[derive(Deserialize)]
  struct TextAnnotation {
    description: Option<String>,
  }
  #[derive(Deserialize)]
  struct VisionError {
    code: Option<i64>,
    status: Option<String>,
    message: Option<String>,
  }
  let parsed: ApiResponse =
    serde_json::from_str(body).map_err(|_| ProtocolError::InvalidResponse)?;
  let first = parsed
    .responses
    .into_iter()
    .next()
    .ok_or(ProtocolError::InvalidResponse)?;
  if let Some(error) = first.error {
    return Err(map_vision_error(
      error.code,
      error.status.as_deref(),
      error.message.as_deref(),
    ));
  }
  if let Some(text) = first.full_text_annotation.and_then(|value| value.text) {
    return if text.len() <= CAPABILITY_TEXT_MAX_BYTES {
      Ok(text)
    } else {
      Err(ProtocolError::InvalidResponse)
    };
  }
  if let Some(text) = first
    .text_annotations
    .into_iter()
    .next()
    .and_then(|value| value.description)
  {
    return if text.len() <= CAPABILITY_TEXT_MAX_BYTES {
      Ok(text)
    } else {
      Err(ProtocolError::InvalidResponse)
    };
  }
  Ok(String::new())
}

pub fn parse_tts_response<'a>(status: u16, body: &'a str) -> Result<&'a str, ProtocolError> {
  map_google_http_error(status, body)?;
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct ApiResponse<'a> {
    audio_content: Option<&'a str>,
  }
  let parsed: ApiResponse<'_> =
    serde_json::from_str(body).map_err(|_| ProtocolError::InvalidResponse)?;
  let audio = parsed
    .audio_content
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .ok_or(ProtocolError::InvalidResponse)?;
  if audio.len() > (SPEECH_AUDIO_MAX_BYTES * 4 / 3) + 8 {
    return Err(ProtocolError::InvalidResponse);
  }
  Ok(audio)
}

pub fn map_google_http_error(status: u16, body: &str) -> Result<(), ProtocolError> {
  if (200..300).contains(&status) {
    return Ok(());
  }
  #[derive(Deserialize)]
  struct Envelope {
    error: Option<ErrorBody>,
  }
  #[derive(Deserialize)]
  struct ErrorBody {
    status: Option<String>,
    #[serde(default)]
    details: Vec<ErrorDetail>,
  }
  #[derive(Deserialize)]
  struct ErrorDetail {
    reason: Option<String>,
  }
  let parsed = serde_json::from_str::<Envelope>(body).ok();
  let error = parsed.and_then(|value| value.error);
  let status_name = error
    .as_ref()
    .and_then(|value| value.status.as_deref())
    .unwrap_or("")
    .trim()
    .to_ascii_uppercase();
  let reason = error
    .as_ref()
    .and_then(|value| {
      value
        .details
        .iter()
        .find_map(|detail| detail.reason.as_deref())
    })
    .unwrap_or("")
    .trim()
    .to_ascii_uppercase();
  if status == 401 || status_name == "UNAUTHENTICATED" {
    return Err(ProtocolError::Auth);
  }
  if status == 403 || status_name == "PERMISSION_DENIED" || reason == "SERVICE_DISABLED" {
    return Err(ProtocolError::PermissionDenied);
  }
  if status_name == "RESOURCE_EXHAUSTED" || reason.contains("QUOTA") {
    return Err(ProtocolError::QuotaExceeded);
  }
  if status == 429 {
    return Err(ProtocolError::RateLimited);
  }
  if status == 400 || status_name == "INVALID_ARGUMENT" {
    return Err(ProtocolError::InvalidRequest);
  }
  if status >= 500 {
    return Err(ProtocolError::ProviderUnavailable);
  }
  Err(ProtocolError::ProviderUnavailable)
}

fn map_vision_error(
  code: Option<i64>,
  status: Option<&str>,
  message: Option<&str>,
) -> ProtocolError {
  let status = status.unwrap_or("").trim().to_ascii_uppercase();
  match status.as_str() {
    "UNAUTHENTICATED" => ProtocolError::Auth,
    "PERMISSION_DENIED" => ProtocolError::PermissionDenied,
    "RESOURCE_EXHAUSTED" => ProtocolError::QuotaExceeded,
    "INVALID_ARGUMENT" => {
      if message
        .map(|value| value.to_ascii_lowercase().contains("language"))
        .unwrap_or(false)
      {
        ProtocolError::UnsupportedLanguage
      } else {
        ProtocolError::InvalidRequest
      }
    }
    "FAILED_PRECONDITION" | "OUT_OF_RANGE" => ProtocolError::UnsupportedInput,
    "UNAVAILABLE" => ProtocolError::ProviderUnavailable,
    _ => match code {
      Some(7) => ProtocolError::PermissionDenied,
      Some(16) => ProtocolError::Auth,
      Some(8) => ProtocolError::QuotaExceeded,
      Some(3) => ProtocolError::InvalidRequest,
      _ => ProtocolError::ProviderUnavailable,
    },
  }
}

fn path_segment(value: &str) -> Result<String, ProtocolError> {
  let trimmed = value.trim();
  if trimmed.is_empty() || trimmed != value || trimmed.len() > 128 {
    return Err(ProtocolError::InvalidConfiguration);
  }
  if trimmed.contains('/')
    || trimmed.contains('\\')
    || trimmed.contains("..")
    || trimmed.contains(' ')
  {
    return Err(ProtocolError::InvalidConfiguration);
  }
  Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
  extern crate std;
  use super::*;
  use alloc::format;

  #[test]
  fn language_mapping_and_request_shapes_are_stable() {
    assert_eq!(app_language_to_google("zh"), Some("zh-CN"));
    assert_eq!(google_language_to_app("nb"), Some("no"));
    let (_, body) = translate_request_body("Hello", "auto", "zh", "demo", "global").unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["contents"][0], "Hello");
    assert_eq!(value["targetLanguageCode"], "zh-CN");
    assert!(value.get("sourceLanguageCode").is_none());
  }

  #[test]
  fn errors_are_normalized_without_provider_message() {
    let error = parse_translate_response(
      403,
      r#"{"error":{"status":"PERMISSION_DENIED","message":"secret body"}}"#,
    )
    .unwrap_err();
    assert_eq!(error, ProtocolError::PermissionDenied);
    assert!(!format!("{error:?}").contains("secret body"));
    assert_eq!(
      parse_translate_response(429, "{}").unwrap_err(),
      ProtocolError::RateLimited
    );
  }
}
