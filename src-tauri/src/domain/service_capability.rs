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

/// Max decoded PNG payload accepted by `ocr.image@1` (8 MiB).
pub const OCR_IMAGE_MAX_DECODED_BYTES: usize = 8 * 1024 * 1024;
/// Max width or height edge for OCR PNG input.
pub const OCR_IMAGE_MAX_EDGE_PX: u32 = 10_000;
/// Max total pixel count for OCR PNG input.
pub const OCR_IMAGE_MAX_PIXELS: u64 = 40_000_000;
/// Max language hints accepted by OCR preferences.
pub const OCR_LANGUAGE_HINTS_MAX: usize = 3;
/// Capability id for image OCR.
pub const OCR_IMAGE_CAPABILITY_ID: &str = "ocr.image@1";
/// Capability id for text-to-speech synthesis.
pub const SPEECH_SYNTHESIZE_CAPABILITY_ID: &str = "speech.synthesize@1";
/// Max UTF-8 text bytes accepted by `speech.synthesize@1` (Google content limit).
pub const SPEECH_TEXT_MAX_BYTES: usize = 5_000;
/// Max decoded MP3 bytes accepted after synthesis.
pub const SPEECH_AUDIO_MAX_BYTES: usize = 12 * 1024 * 1024;
/// Expected audio MIME type for speech synthesis responses (MP3). Provider contract validation:
/// a 200 response with a non-audio content type (e.g. JSON error body) must not be accepted as MP3.
pub const SPEECH_EXPECTED_AUDIO_MIME: &str = "audio/mpeg";

/// The only optional parameter accepted from the Edge TTS audio response. The response contract
/// uses this legacy spelling; unknown parameters are rejected rather than treated as metadata.
const SPEECH_AUDIO_CHARSET_PARAMETER: &str = "charset";
/// The only accepted value for [`SPEECH_AUDIO_CHARSET_PARAMETER`].
const SPEECH_AUDIO_CHARSET_BINARY_VALUE: &str = "binary";

/// True when `content_type` is strict `audio/mpeg` with no parameters or one allowlisted
/// `charset=binary` parameter. This intentionally small parser follows HTTP token/quoted-string
/// rules needed by this exact provider contract without adding a MIME dependency solely for one
/// header: it permits OWS only at grammar boundaries and rejects malformed empty/duplicate/
/// unsupported parameters, invalid tokens, control characters, and malformed quoted values.
pub fn is_valid_speech_audio_content_type(content_type: &str) -> bool {
  if content_type.bytes().any(is_forbidden_content_type_control) {
    return false;
  }

  let mut parts = content_type.split(';');
  let Some(media_type) = parts.next() else {
    return false;
  };
  if !trim_ows(media_type).eq_ignore_ascii_case(SPEECH_EXPECTED_AUDIO_MIME) {
    return false;
  }

  let mut charset_seen = false;
  for part in parts {
    let parameter = trim_ows(part);
    if parameter.is_empty() {
      return false;
    }
    let Some((raw_name, raw_value)) = parameter.split_once('=') else {
      return false;
    };
    let name = trim_ows(raw_name);
    let value = trim_ows(raw_value);
    if !is_http_token(name) || !name.eq_ignore_ascii_case(SPEECH_AUDIO_CHARSET_PARAMETER) || charset_seen {
      return false;
    }
    if !is_allowed_speech_charset_value(value) {
      return false;
    }
    charset_seen = true;
  }
  true
}

/// Trim RFC OWS (`SP` / `HTAB`) only. General Unicode whitespace is not HTTP OWS and remains
/// invalid when token grammar is checked.
fn trim_ows(value: &str) -> &str {
  value.trim_matches([' ', '\t'])
}

/// Reject C0 controls other than HTAB (which is valid OWS) and DEL before parsing header syntax.
fn is_forbidden_content_type_control(byte: u8) -> bool {
  (byte < 0x20 && byte != b'\t') || byte == 0x7f
}

/// RFC HTTP `tchar` token grammar used by media parameters. Spaces, quotes, separators, and
/// non-ASCII bytes are rejected for unquoted values so `charset=foo bar` cannot be accepted.
fn is_http_token(value: &str) -> bool {
  !value.is_empty()
    && value.bytes().all(|byte| {
      byte.is_ascii_alphanumeric()
        || matches!(
          byte,
          b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~'
        )
    })
}

/// Validate the one allowlisted charset value as either an HTTP token or a complete quoted
/// string. Escapes, unescaped quotes, and trailing text are rejected because they cannot encode
/// the exact allowlisted `binary` value.
fn is_allowed_speech_charset_value(value: &str) -> bool {
  if let Some(quoted) = value.strip_prefix('"') {
    let Some(inner) = quoted.strip_suffix('"') else {
      return false;
    };
    !inner.is_empty()
      && !inner
        .bytes()
        .any(|byte| is_forbidden_content_type_control(byte) || byte == b'"' || byte == b'\\')
      && inner.eq_ignore_ascii_case(SPEECH_AUDIO_CHARSET_BINARY_VALUE)
  } else {
    is_http_token(value) && value.eq_ignore_ascii_case(SPEECH_AUDIO_CHARSET_BINARY_VALUE)
  }
}
/// Max Google JSON response body for TTS (base64 expansion + envelope).
pub const SPEECH_PROVIDER_RESPONSE_MAX_BYTES: usize = (SPEECH_AUDIO_MAX_BYTES * 4 / 3) + (64 * 1024);
/// Speaking rate lower bound (Google AudioConfig).
pub const SPEECH_SPEAKING_RATE_MIN: f64 = 0.25;
/// Speaking rate upper bound (Google AudioConfig).
pub const SPEECH_SPEAKING_RATE_MAX: f64 = 2.0;
/// Default speaking rate (native speed).
pub const SPEECH_SPEAKING_RATE_DEFAULT: f64 = 1.0;
/// Pitch lower bound in semitones (Google AudioConfig).
pub const SPEECH_PITCH_MIN: f64 = -20.0;
/// Pitch upper bound in semitones (Google AudioConfig).
pub const SPEECH_PITCH_MAX: f64 = 20.0;
/// Default pitch (native pitch).
pub const SPEECH_PITCH_DEFAULT: f64 = 0.0;

/// Stable capability failure codes (never embed secrets or raw provider bodies).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityErrorCode {
  InvalidConfiguration,
  InvalidRequest,
  Auth,
  PermissionDenied,
  EndpointTrustRequired,
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
      Self::EndpointTrustRequired => "endpoint_trust_required",
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

/// Immutable capability invocation identity propagated into host-owned broker calls.
/// It contains no credentials and prevents a handler from borrowing authority from another
/// instance, plugin, capability, or request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityExecutionPrincipal {
  pub request_id: String,
  pub integration_instance_id: Uuid,
  pub plugin_id: String,
  pub capability_id: String,
}

impl ExecutionContext {
  pub fn principal(&self) -> CapabilityExecutionPrincipal {
    CapabilityExecutionPrincipal {
      request_id: self.request_id.clone(),
      integration_instance_id: self.integration_instance_id,
      plugin_id: self.plugin_id.clone(),
      capability_id: self.capability_id.clone(),
    }
  }
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

/// Vision OCR operation (maps to Cloud Vision feature types).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OcrImageOperation {
  TextDetection,
  #[default]
  DocumentTextDetection,
}

impl OcrImageOperation {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::TextDetection => "text_detection",
      Self::DocumentTextDetection => "document_text_detection",
    }
  }

  /// Google Vision REST feature type enum value.
  pub fn google_feature_type(self) -> &'static str {
    match self {
      Self::TextDetection => "TEXT_DETECTION",
      Self::DocumentTextDetection => "DOCUMENT_TEXT_DETECTION",
    }
  }
}

/// Runtime preferences for `ocr.image@1`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct OcrImagePreferences {
  #[serde(default)]
  pub operation: OcrImageOperation,
  /// App language ids (max 3). Empty list means provider auto-detect.
  #[serde(default, alias = "languageHints")]
  pub language_hints: Vec<String>,
}

/// Image OCR capability request (PNG as standard base64, no data-URL prefix).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrImageRequest {
  pub png_base64: String,
  pub preferences: OcrImagePreferences,
}

/// Image OCR capability response (plain text only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrImageResponse {
  pub text: String,
}

/// Runtime preferences for `speech.synthesize@1` (Google Cloud schema).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct SpeechSynthesizePreferences {
  #[serde(default = "default_speech_speaking_rate", alias = "speakingRate")]
  pub speaking_rate: f64,
  #[serde(default = "default_speech_pitch")]
  pub pitch: f64,
}

/// Edge TTS voice ids supported by the bundled plugin (zh-CN only).
pub const EDGE_TTS_VOICES: &[&str] = &[
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoyiNeural",
  "zh-CN-XiaochenNeural",
  "zh-CN-XiaohanNeural",
  "zh-CN-XiaomengNeural",
  "zh-CN-XiaomoNeural",
  "zh-CN-XiaoqiuNeural",
  "zh-CN-XiaoruiNeural",
  "zh-CN-XiaoshuangNeural",
  "zh-CN-XiaoxuanNeural",
  "zh-CN-XiaoyanNeural",
  "zh-CN-XiaoyouNeural",
  "zh-CN-XiaozhenNeural",
  "zh-CN-YunxiNeural",
  "zh-CN-YunyangNeural",
  "zh-CN-YunjianNeural",
  "zh-CN-YunfengNeural",
  "zh-CN-YunhaoNeural",
  "zh-CN-YunxiaNeural",
  "zh-CN-YunyeNeural",
  "zh-CN-YunzeNeural",
];

/// Edge TTS style ids supported by the bundled plugin.
pub const EDGE_TTS_STYLES: &[&str] = &[
  "general",
  "assistant",
  "chat",
  "customerservice",
  "newscast",
  "affectionate",
  "calm",
  "cheerful",
  "gentle",
  "lyrical",
  "serious",
];
/// Edge TTS speed lower bound.
pub const EDGE_TTS_SPEED_MIN: f64 = 0.5;
/// Edge TTS speed upper bound.
pub const EDGE_TTS_SPEED_MAX: f64 = 2.0;
/// Edge TTS speed default.
pub const EDGE_TTS_SPEED_DEFAULT: f64 = 1.0;
/// Edge TTS pitch lower bound.
pub const EDGE_TTS_PITCH_MIN: f64 = -50.0;
/// Edge TTS pitch upper bound.
pub const EDGE_TTS_PITCH_MAX: f64 = 50.0;
/// Edge TTS pitch default.
pub const EDGE_TTS_PITCH_DEFAULT: f64 = 0.0;
/// Default Edge TTS voice.
pub const EDGE_TTS_VOICE_DEFAULT: &str = "zh-CN-XiaoxiaoNeural";
/// Default Edge TTS style.
pub const EDGE_TTS_STYLE_DEFAULT: &str = "general";

/// Runtime preferences for Edge TTS `speech.synthesize@1` (schema v1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct EdgeTtsPreferences {
  #[serde(default = "default_edge_tts_voice")]
  pub voice: String,
  #[serde(default = "default_edge_tts_speed")]
  pub speed: f64,
  #[serde(default = "default_edge_tts_pitch")]
  pub pitch: f64,
  #[serde(default = "default_edge_tts_style")]
  pub style: String,
}

fn default_edge_tts_voice() -> String {
  EDGE_TTS_VOICE_DEFAULT.into()
}

fn default_edge_tts_speed() -> f64 {
  EDGE_TTS_SPEED_DEFAULT
}

fn default_edge_tts_pitch() -> f64 {
  EDGE_TTS_PITCH_DEFAULT
}

fn default_edge_tts_style() -> String {
  EDGE_TTS_STYLE_DEFAULT.into()
}

fn default_speech_speaking_rate() -> f64 {
  SPEECH_SPEAKING_RATE_DEFAULT
}

fn default_speech_pitch() -> f64 {
  SPEECH_PITCH_DEFAULT
}

impl Default for SpeechSynthesizePreferences {
  fn default() -> Self {
    Self {
      speaking_rate: SPEECH_SPEAKING_RATE_DEFAULT,
      pitch: SPEECH_PITCH_DEFAULT,
    }
  }
}

/// Text-to-speech capability request (plain text + app language id).
///
/// `preferences` is the raw stored JSON; each plugin handler parses its own schema
/// (Google `SpeechSynthesizePreferences` or Edge `EdgeTtsPreferences`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechSynthesizeRequest {
  pub text: String,
  pub language_id: String,
  pub preferences: serde_json::Value,
}

/// Text-to-speech capability response (raw MP3 bytes; not a frontend DTO).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeechSynthesizeResponse {
  pub mp3_bytes: Vec<u8>,
}

/// Validate speech preferences against host bounds.
pub fn validate_speech_synthesize_preferences(
  preferences: &SpeechSynthesizePreferences,
) -> Result<(), CapabilityError> {
  if !preferences.speaking_rate.is_finite()
    || preferences.speaking_rate < SPEECH_SPEAKING_RATE_MIN
    || preferences.speaking_rate > SPEECH_SPEAKING_RATE_MAX
  {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("speakingRate must be finite and in [{SPEECH_SPEAKING_RATE_MIN}, {SPEECH_SPEAKING_RATE_MAX}]"),
    ));
  }
  if !preferences.pitch.is_finite() || preferences.pitch < SPEECH_PITCH_MIN || preferences.pitch > SPEECH_PITCH_MAX {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("pitch must be finite and in [{SPEECH_PITCH_MIN}, {SPEECH_PITCH_MAX}]"),
    ));
  }
  Ok(())
}

/// Validate Edge TTS preferences against host bounds.
pub fn validate_edge_tts_preferences(preferences: &EdgeTtsPreferences) -> Result<(), CapabilityError> {
  if !EDGE_TTS_VOICES.contains(&preferences.voice.as_str()) {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "voice is not a supported Edge TTS voice",
    ));
  }
  if !preferences.speed.is_finite() || preferences.speed < EDGE_TTS_SPEED_MIN || preferences.speed > EDGE_TTS_SPEED_MAX
  {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("speed must be finite and in [{EDGE_TTS_SPEED_MIN}, {EDGE_TTS_SPEED_MAX}]"),
    ));
  }
  if !preferences.pitch.is_finite() || preferences.pitch < EDGE_TTS_PITCH_MIN || preferences.pitch > EDGE_TTS_PITCH_MAX
  {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("pitch must be finite and in [{EDGE_TTS_PITCH_MIN}, {EDGE_TTS_PITCH_MAX}]"),
    ));
  }
  if !EDGE_TTS_STYLES.contains(&preferences.style.as_str()) {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "style is not a supported Edge TTS style",
    ));
  }
  Ok(())
}

/// Validate synthesis text against the Google content limit (UTF-8 bytes).
pub fn validate_speech_synthesize_text(text: &str) -> Result<(), CapabilityError> {
  if text.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "text must not be empty",
    ));
  }
  if text.len() > SPEECH_TEXT_MAX_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      format!("text exceeds {SPEECH_TEXT_MAX_BYTES} bytes"),
    ));
  }
  Ok(())
}

/// Validate OCR preferences against host bounds (hint count + language id shape).
pub fn validate_ocr_image_preferences(preferences: &OcrImagePreferences) -> Result<(), CapabilityError> {
  if preferences.language_hints.len() > OCR_LANGUAGE_HINTS_MAX {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("languageHints must contain at most {OCR_LANGUAGE_HINTS_MAX} entries"),
    ));
  }
  for (idx, hint) in preferences.language_hints.iter().enumerate() {
    validate_capability_language_id(hint, &format!("languageHints[{idx}]"))?;
  }
  Ok(())
}

/// Decoded PNG dimensions after successful image decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OcrPngBounds {
  pub width: u32,
  pub height: u32,
  pub decoded_bytes: usize,
}

/// Enforce decoded size / edge / pixel limits for OCR PNG input.
pub fn validate_ocr_png_bounds(width: u32, height: u32, decoded_bytes: usize) -> Result<OcrPngBounds, CapabilityError> {
  if decoded_bytes == 0 {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      "PNG image is empty",
    ));
  }
  if decoded_bytes > OCR_IMAGE_MAX_DECODED_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      format!("PNG exceeds {OCR_IMAGE_MAX_DECODED_BYTES} decoded bytes"),
    ));
  }
  if width == 0 || height == 0 {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      "PNG dimensions must be non-zero",
    ));
  }
  if width > OCR_IMAGE_MAX_EDGE_PX || height > OCR_IMAGE_MAX_EDGE_PX {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      format!("PNG edge exceeds {OCR_IMAGE_MAX_EDGE_PX} px"),
    ));
  }
  let pixels = u64::from(width).saturating_mul(u64::from(height));
  if pixels > OCR_IMAGE_MAX_PIXELS {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      format!("PNG exceeds {OCR_IMAGE_MAX_PIXELS} pixels"),
    ));
  }
  Ok(OcrPngBounds {
    width,
    height,
    decoded_bytes,
  })
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

  #[test]
  fn ocr_image_preferences_reject_too_many_hints() {
    let prefs = OcrImagePreferences {
      operation: OcrImageOperation::TextDetection,
      language_hints: vec!["en".into(), "zh".into(), "ja".into(), "ko".into()],
    };
    let err = validate_ocr_image_preferences(&prefs).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidRequest);
  }

  #[test]
  fn ocr_png_bounds_reject_oversized_and_accept_valid() {
    let ok = validate_ocr_png_bounds(100, 100, 1024).unwrap();
    assert_eq!(ok.width, 100);

    let err = validate_ocr_png_bounds(1, 1, OCR_IMAGE_MAX_DECODED_BYTES + 1).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedInput);

    let err = validate_ocr_png_bounds(OCR_IMAGE_MAX_EDGE_PX + 1, 1, 100).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedInput);

    // 10001 * 4000 would exceed edge; 8000*6000 exceeds 40M pixels.
    let err = validate_ocr_png_bounds(8000, 6000, 100).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedInput);
  }

  #[test]
  fn ocr_image_operation_serde_snake_case() {
    let value = serde_json::to_value(OcrImageOperation::DocumentTextDetection).unwrap();
    assert_eq!(value, serde_json::json!("document_text_detection"));
    assert_eq!(OcrImageOperation::TextDetection.google_feature_type(), "TEXT_DETECTION");
  }

  #[test]
  fn speech_preferences_reject_out_of_range_and_non_finite() {
    let ok = SpeechSynthesizePreferences::default();
    assert!(validate_speech_synthesize_preferences(&ok).is_ok());

    let too_fast = SpeechSynthesizePreferences {
      speaking_rate: SPEECH_SPEAKING_RATE_MAX + 0.01,
      pitch: 0.0,
    };
    assert_eq!(
      validate_speech_synthesize_preferences(&too_fast).unwrap_err().code,
      CapabilityErrorCode::InvalidRequest
    );

    let nan_pitch = SpeechSynthesizePreferences {
      speaking_rate: 1.0,
      pitch: f64::NAN,
    };
    assert_eq!(
      validate_speech_synthesize_preferences(&nan_pitch).unwrap_err().code,
      CapabilityErrorCode::InvalidRequest
    );
  }

  #[test]
  fn speech_text_rejects_empty_and_oversized() {
    assert_eq!(
      validate_speech_synthesize_text("").unwrap_err().code,
      CapabilityErrorCode::InvalidRequest
    );
    let long = "a".repeat(SPEECH_TEXT_MAX_BYTES + 1);
    assert_eq!(
      validate_speech_synthesize_text(&long).unwrap_err().code,
      CapabilityErrorCode::UnsupportedInput
    );
    assert!(validate_speech_synthesize_text("hello").is_ok());
  }

  #[test]
  fn speech_audio_content_type_strictly_parses_allowlisted_parameters() {
    let cases = [
      ("audio/mpeg", true),
      (" AUDIO/MPEG\t", true),
      ("audio/mpeg; charset=binary", true),
      ("audio/mpeg ; charset = \"BINARY\"", true),
      ("audio/mpeg;", false),
      ("audio/mpeg;; charset=binary", false),
      ("audio/mpeg; charset=foo bar", false),
      ("audio/mpeg; charset=", false),
      ("audio/mpeg; charset=\"binary", false),
      ("audio/mpeg; charset=\"bin\\ary\"", false),
      ("audio/mpeg; charset=binary; charset=binary", false),
      ("audio/mpeg; boundary=x", false),
      ("audio/mpeg; charset=binary\u{0001}", false),
      ("audio/mp3", false),
    ];

    for (content_type, expected) in cases {
      assert_eq!(
        is_valid_speech_audio_content_type(content_type),
        expected,
        "content type {content_type:?}"
      );
    }
  }

  #[test]
  fn edge_tts_preferences_reject_invalid_voice_and_style() {
    let ok = EdgeTtsPreferences {
      voice: EDGE_TTS_VOICE_DEFAULT.into(),
      speed: EDGE_TTS_SPEED_DEFAULT,
      pitch: EDGE_TTS_PITCH_DEFAULT,
      style: EDGE_TTS_STYLE_DEFAULT.into(),
    };
    assert!(validate_edge_tts_preferences(&ok).is_ok());

    let bad_voice = EdgeTtsPreferences {
      voice: "zh-CN-BogusNeural".into(),
      ..ok.clone()
    };
    assert_eq!(
      validate_edge_tts_preferences(&bad_voice).unwrap_err().code,
      CapabilityErrorCode::InvalidRequest
    );

    let bad_style = EdgeTtsPreferences {
      style: "singing".into(),
      ..ok.clone()
    };
    assert_eq!(
      validate_edge_tts_preferences(&bad_style).unwrap_err().code,
      CapabilityErrorCode::InvalidRequest
    );

    let bad_speed = EdgeTtsPreferences {
      speed: EDGE_TTS_SPEED_MAX + 0.01,
      ..ok.clone()
    };
    assert_eq!(
      validate_edge_tts_preferences(&bad_speed).unwrap_err().code,
      CapabilityErrorCode::InvalidRequest
    );

    let nan_pitch = EdgeTtsPreferences { pitch: f64::NAN, ..ok };
    assert_eq!(
      validate_edge_tts_preferences(&nan_pitch).unwrap_err().code,
      CapabilityErrorCode::InvalidRequest
    );
  }
}
