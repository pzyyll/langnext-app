// ABOUTME: Google Cloud Translation, Vision OCR, and Text-to-Speech capability handlers.
// ABOUTME: Maps app language IDs, builds pinned relative requests, and sanitizes provider errors.
use crate::domain::language_detection::SUPPORTED_LANGUAGES;
use crate::domain::provider_http::ProviderHttpMethod;
use crate::domain::service_capability::{
  CAPABILITY_PROVIDER_CODE_MAX_LEN, CapabilityError, CapabilityErrorCode, DetectLanguageRequest,
  DetectLanguageResponse, ExecutionContext, OCR_IMAGE_CAPABILITY_ID, OcrImageRequest, OcrImageResponse,
  SPEECH_AUDIO_MAX_BYTES, SPEECH_PROVIDER_RESPONSE_MAX_BYTES, SPEECH_SYNTHESIZE_CAPABILITY_ID,
  SpeechSynthesizePreferences, SpeechSynthesizeRequest, SpeechSynthesizeResponse, TranslateTextRequest,
  TranslateTextResponse, validate_capability_language_id, validate_capability_request_id, validate_capability_text,
  validate_ocr_image_preferences, validate_ocr_png_bounds, validate_speech_synthesize_preferences,
  validate_speech_synthesize_text,
};
use crate::domain::service_integration::{GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GoogleCloudConfigV1};
use crate::error::StorageError;
use crate::repositories::integration_instances;
use crate::services::network_broker::{BROKER_OCR_REQUEST_BODY_MAX_BYTES, BrokerRequest, NetworkBroker};
use crate::services::token_grant::{
  GOOGLE_CLOUD_TEXT_TO_SPEECH_SCOPE, GOOGLE_CLOUD_TRANSLATION_SCOPE, GOOGLE_CLOUD_VISION_SCOPE,
  GOOGLE_OAUTH_AUDIENCE_POLICY_ID, GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID, TokenGrantRequest, TokenGrantService,
};
use crate::storage::Database;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::ImageReader;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;
use uuid::Uuid;

/// Official API version for Cloud Translation Advanced in this phase.
pub const GOOGLE_TRANSLATE_API_VERSION: &str = "v3beta1";
/// Manifest endpoint alias for Translation API origin.
pub const GOOGLE_TRANSLATE_ENDPOINT_ALIAS: &str = "translate";
/// MIME type forced for plain-text Translate/Detect.
pub const GOOGLE_TRANSLATE_MIME_TYPE: &str = "text/plain";
/// Capability id for text translation.
pub const GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID: &str = "translate.text@1";
/// Capability id for language detection.
pub const GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID: &str = "translate.detect@1";
/// Manifest endpoint alias for Vision API origin.
pub const GOOGLE_VISION_ENDPOINT_ALIAS: &str = "vision";
/// Relative path for Vision images:annotate.
pub const GOOGLE_VISION_ANNOTATE_PATH: &str = "v1/images:annotate";
/// Manifest endpoint alias for Text-to-Speech API origin.
pub const GOOGLE_TEXT_TO_SPEECH_ENDPOINT_ALIAS: &str = "text_to_speech";
/// Relative path for Text-to-Speech synthesize.
pub const GOOGLE_TEXT_TO_SPEECH_SYNTHESIZE_PATH: &str = "v1/text:synthesize";
/// Fixed synthesis timeout for TTS (provider may take longer than translate).
pub const SPEECH_SYNTHESIS_TIMEOUT_SECS: u64 = 60;
/// Max Google language list entries inspected for detection.
const DETECT_LANGUAGES_MAX_ITEMS: usize = 16;
/// Max path segment length for project/location.
const PATH_SEGMENT_MAX_LEN: usize = 128;

#[derive(Clone)]
pub struct GoogleCloudCapabilities {
  db: Database,
  network: Arc<NetworkBroker>,
  tokens: Arc<TokenGrantService>,
}

impl GoogleCloudCapabilities {
  pub fn new(db: Database, network: Arc<NetworkBroker>, tokens: Arc<TokenGrantService>) -> Self {
    Self { db, network, tokens }
  }

  pub async fn translate_text(
    &self,
    instance_id: Uuid,
    request: TranslateTextRequest,
    context: ExecutionContext,
  ) -> Result<TranslateTextResponse, CapabilityError> {
    validate_capability_request_id(&context.request_id)?;
    validate_capability_text(&request.text)?;
    validate_capability_language_id(&request.target_language_id, "target_language_id")?;
    if !request.source_language_id.is_empty() && request.source_language_id != "auto" {
      validate_capability_language_id(&request.source_language_id, "source_language_id")?;
    }

    let target_google = app_language_to_google(&request.target_language_id).ok_or_else(|| {
      CapabilityError::new(CapabilityErrorCode::UnsupportedLanguage, "unsupported target language")
        .with_capability_id(GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;

    let source_google = if request.source_language_id.is_empty() || request.source_language_id == "auto" {
      None
    } else {
      Some(app_language_to_google(&request.source_language_id).ok_or_else(|| {
        CapabilityError::new(CapabilityErrorCode::UnsupportedLanguage, "unsupported source language")
          .with_capability_id(GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?)
    };

    let (project_id, location) = load_project_location(&self.db, instance_id)?;
    let relative_path =
      format!("{GOOGLE_TRANSLATE_API_VERSION}/projects/{project_id}/locations/{location}:translateText");

    let mut body = json!({
      "contents": [request.text],
      "mimeType": GOOGLE_TRANSLATE_MIME_TYPE,
      "targetLanguageCode": target_google,
    });
    if let Some(source) = source_google {
      body["sourceLanguageCode"] = Value::String(source.to_string());
    }

    let grant = self
      .tokens
      .acquire(
        TokenGrantRequest {
          instance_id,
          capability_id: GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID.into(),
          auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
          scopes: vec![GOOGLE_CLOUD_TRANSLATION_SCOPE.into()],
          audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        },
        Some(&context.cancel),
      )
      .await
      .map_err(|e| {
        e.with_capability_id(GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;

    let response = self
      .network
      .execute(BrokerRequest {
        integration_instance_id: instance_id,
        capability_id: GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        endpoint_alias: GOOGLE_TRANSLATE_ENDPOINT_ALIAS.into(),
        method: ProviderHttpMethod::Post,
        relative_path,
        query: vec![],
        headers: HashMap::new(),
        body: Some(body.to_string()),
        content_type: Some("application/json".into()),
        auth: Some(grant),
        request_id: context.request_id.clone(),
        cancel: Some(context.cancel.clone()),
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .map_err(|e| {
        e.with_capability_id(GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;

    parse_translate_response(response.status, &response.body).map_err(|e| {
      e.with_capability_id(GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })
  }

  pub async fn detect_language(
    &self,
    instance_id: Uuid,
    request: DetectLanguageRequest,
    context: ExecutionContext,
  ) -> Result<DetectLanguageResponse, CapabilityError> {
    validate_capability_request_id(&context.request_id)?;
    validate_capability_text(&request.text)?;

    let (project_id, location) = load_project_location(&self.db, instance_id)?;
    let relative_path =
      format!("{GOOGLE_TRANSLATE_API_VERSION}/projects/{project_id}/locations/{location}:detectLanguage");
    let body = json!({
      "content": request.text,
      "mimeType": GOOGLE_TRANSLATE_MIME_TYPE,
    });

    let grant = self
      .tokens
      .acquire(
        TokenGrantRequest {
          instance_id,
          capability_id: GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID.into(),
          auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
          scopes: vec![GOOGLE_CLOUD_TRANSLATION_SCOPE.into()],
          audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        },
        Some(&context.cancel),
      )
      .await
      .map_err(|e| {
        e.with_capability_id(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;

    let response = self
      .network
      .execute(BrokerRequest {
        integration_instance_id: instance_id,
        capability_id: GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID.into(),
        endpoint_alias: GOOGLE_TRANSLATE_ENDPOINT_ALIAS.into(),
        method: ProviderHttpMethod::Post,
        relative_path,
        query: vec![],
        headers: HashMap::new(),
        body: Some(body.to_string()),
        content_type: Some("application/json".into()),
        auth: Some(grant),
        request_id: context.request_id.clone(),
        cancel: Some(context.cancel.clone()),
        max_response_body_bytes: None,
        max_request_body_bytes: None,
        timeout: None,
      })
      .await
      .map_err(|e| {
        e.with_capability_id(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;

    parse_detect_response(response.status, &response.body).map_err(|e| {
      e.with_capability_id(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })
  }

  pub async fn ocr_image(
    &self,
    instance_id: Uuid,
    request: OcrImageRequest,
    context: ExecutionContext,
  ) -> Result<OcrImageResponse, CapabilityError> {
    validate_capability_request_id(&context.request_id)?;
    validate_ocr_image_preferences(&request.preferences).map_err(|e| {
      e.with_capability_id(OCR_IMAGE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;

    // Decode and bound-check before any network or token work.
    let _bounds = decode_and_validate_ocr_png(&request.png_base64).map_err(|e| {
      e.with_capability_id(OCR_IMAGE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;

    let language_hints = map_ocr_language_hints(&request.preferences.language_hints).map_err(|e| {
      e.with_capability_id(OCR_IMAGE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;

    // Ensure the instance is a Google Cloud integration (no project path needed for annotate).
    ensure_google_cloud_instance(&self.db, instance_id).map_err(|e| {
      e.with_capability_id(OCR_IMAGE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;

    let mut annotate_request = json!({
      "image": { "content": request.png_base64.trim() },
      "features": [{ "type": request.preferences.operation.google_feature_type() }],
    });
    if !language_hints.is_empty() {
      annotate_request["imageContext"] = json!({ "languageHints": language_hints });
    }
    let body = json!({ "requests": [annotate_request] });

    let grant = self
      .tokens
      .acquire(
        TokenGrantRequest {
          instance_id,
          capability_id: OCR_IMAGE_CAPABILITY_ID.into(),
          auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
          scopes: vec![GOOGLE_CLOUD_VISION_SCOPE.into()],
          audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        },
        Some(&context.cancel),
      )
      .await
      .map_err(|e| {
        e.with_capability_id(OCR_IMAGE_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;

    let response = self
      .network
      .execute(BrokerRequest {
        integration_instance_id: instance_id,
        capability_id: OCR_IMAGE_CAPABILITY_ID.into(),
        endpoint_alias: GOOGLE_VISION_ENDPOINT_ALIAS.into(),
        method: ProviderHttpMethod::Post,
        relative_path: GOOGLE_VISION_ANNOTATE_PATH.into(),
        query: vec![],
        headers: HashMap::new(),
        body: Some(body.to_string()),
        content_type: Some("application/json".into()),
        auth: Some(grant),
        request_id: context.request_id.clone(),
        cancel: Some(context.cancel.clone()),
        max_response_body_bytes: None,
        timeout: None,
        // Honor the locked 8 MiB decoded PNG contract (base64 + JSON overhead).
        max_request_body_bytes: Some(BROKER_OCR_REQUEST_BODY_MAX_BYTES),
      })
      .await
      .map_err(|e| {
        e.with_capability_id(OCR_IMAGE_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;

    parse_vision_annotate_response(response.status, &response.body).map_err(|e| {
      e.with_capability_id(OCR_IMAGE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })
  }

  pub async fn synthesize_speech(
    &self,
    instance_id: Uuid,
    request: SpeechSynthesizeRequest,
    context: ExecutionContext,
  ) -> Result<SpeechSynthesizeResponse, CapabilityError> {
    validate_capability_request_id(&context.request_id)?;
    validate_speech_synthesize_text(&request.text).map_err(|e| {
      e.with_capability_id(SPEECH_SYNTHESIZE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;
    validate_capability_language_id(&request.language_id, "language_id").map_err(|e| {
      e.with_capability_id(SPEECH_SYNTHESIZE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;
    let preferences: SpeechSynthesizePreferences =
      serde_json::from_value(request.preferences.clone()).map_err(|_| {
        CapabilityError::new(CapabilityErrorCode::InvalidRequest, "invalid Google TTS preferences")
          .with_capability_id(SPEECH_SYNTHESIZE_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;
    validate_speech_synthesize_preferences(&preferences).map_err(|e| {
      e.with_capability_id(SPEECH_SYNTHESIZE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;

    let language_code = app_language_to_google(&request.language_id).ok_or_else(|| {
      CapabilityError::new(CapabilityErrorCode::UnsupportedLanguage, "unsupported language")
        .with_capability_id(SPEECH_SYNTHESIZE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;

    ensure_google_cloud_instance(&self.db, instance_id).map_err(|e| {
      e.with_capability_id(SPEECH_SYNTHESIZE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;

    let body = json!({
      "input": { "text": request.text },
      "voice": { "languageCode": language_code },
      "audioConfig": {
        "audioEncoding": "MP3",
        "speakingRate": preferences.speaking_rate,
        "pitch": preferences.pitch,
      },
    });

    let grant = self
      .tokens
      .acquire(
        TokenGrantRequest {
          instance_id,
          capability_id: SPEECH_SYNTHESIZE_CAPABILITY_ID.into(),
          auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
          scopes: vec![GOOGLE_CLOUD_TEXT_TO_SPEECH_SCOPE.into()],
          audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        },
        Some(&context.cancel),
      )
      .await
      .map_err(|e| {
        e.with_capability_id(SPEECH_SYNTHESIZE_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;

    let response = self
      .network
      .execute(BrokerRequest {
        integration_instance_id: instance_id,
        capability_id: SPEECH_SYNTHESIZE_CAPABILITY_ID.into(),
        endpoint_alias: GOOGLE_TEXT_TO_SPEECH_ENDPOINT_ALIAS.into(),
        method: ProviderHttpMethod::Post,
        relative_path: GOOGLE_TEXT_TO_SPEECH_SYNTHESIZE_PATH.into(),
        query: vec![],
        headers: HashMap::new(),
        body: Some(body.to_string()),
        content_type: Some("application/json".into()),
        auth: Some(grant),
        request_id: context.request_id.clone(),
        cancel: Some(context.cancel.clone()),
        max_response_body_bytes: Some(SPEECH_PROVIDER_RESPONSE_MAX_BYTES),
        timeout: Some(std::time::Duration::from_secs(SPEECH_SYNTHESIS_TIMEOUT_SECS)),
        max_request_body_bytes: None,
      })
      .await
      .map_err(|e| {
        e.with_capability_id(SPEECH_SYNTHESIZE_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;

    parse_tts_synthesize_response(response.status, &response.body).map_err(|e| {
      e.with_capability_id(SPEECH_SYNTHESIZE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })
  }
}

fn load_project_location(db: &Database, instance_id: Uuid) -> Result<(String, String), CapabilityError> {
  let instance = load_google_cloud_instance(db, instance_id)?;

  let config: GoogleCloudConfigV1 = serde_json::from_str(&instance.config_json).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "invalid Google Cloud configuration",
    )
  })?;

  let project_id = validate_path_segment(&config.project_id, "project_id")?;
  let location = {
    let loc = config.location.trim();
    let loc = if loc.is_empty() {
      GOOGLE_CLOUD_DEFAULT_LOCATION
    } else {
      loc
    };
    validate_path_segment(loc, "location")?
  };
  Ok((project_id, location))
}

fn ensure_google_cloud_instance(db: &Database, instance_id: Uuid) -> Result<(), CapabilityError> {
  load_google_cloud_instance(db, instance_id).map(|_| ())
}

fn load_google_cloud_instance(
  db: &Database,
  instance_id: Uuid,
) -> Result<crate::domain::service_integration::IntegrationInstance, CapabilityError> {
  let instance = db
    .read(|conn| integration_instances::get(conn, instance_id))
    .map_err(|e| match e {
      StorageError::NotFound(_) => CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "integration instance not found",
      ),
      _ => CapabilityError::new(CapabilityErrorCode::Internal, "failed to load integration instance"),
    })?;

  if instance.plugin_id != GOOGLE_CLOUD_PLUGIN_ID {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PluginUnavailable,
      "instance is not a Google Cloud integration",
    ));
  }
  if !instance.enabled {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PluginUnavailable,
      "integration instance is disabled",
    ));
  }
  Ok(instance)
}

/// Max standard-base64 character length that can decode to OCR_IMAGE_MAX_DECODED_BYTES.
/// Standard base64 encodes 3 bytes as 4 chars; pad keeps length a multiple of 4.
pub const OCR_IMAGE_MAX_BASE64_CHARS: usize =
  ((crate::domain::service_capability::OCR_IMAGE_MAX_DECODED_BYTES + 2) / 3) * 4;

/// Decode standard base64 PNG and enforce decoded size / dimension limits.
pub fn decode_and_validate_ocr_png(
  png_base64: &str,
) -> Result<crate::domain::service_capability::OcrPngBounds, CapabilityError> {
  let trimmed = png_base64.trim();
  if trimmed.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "png_base64 must not be empty",
    ));
  }

  // Preflight encoded length before allocating a decoded buffer (fail closed on abuse).
  if trimmed.len() > OCR_IMAGE_MAX_BASE64_CHARS {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      format!(
        "PNG exceeds {} decoded bytes",
        crate::domain::service_capability::OCR_IMAGE_MAX_DECODED_BYTES
      ),
    ));
  }

  let decoded = BASE64.decode(trimmed.as_bytes()).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      "png_base64 is not valid standard base64",
    )
  })?;

  // Reject before image decode when the decoded byte length already exceeds the bound.
  if decoded.len() > crate::domain::service_capability::OCR_IMAGE_MAX_DECODED_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      format!(
        "PNG exceeds {} decoded bytes",
        crate::domain::service_capability::OCR_IMAGE_MAX_DECODED_BYTES
      ),
    ));
  }

  let reader = ImageReader::new(Cursor::new(&decoded))
    .with_guessed_format()
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::UnsupportedInput, "PNG image could not be read"))?;

  // Fail closed unless the decoded format is PNG.
  if reader.format() != Some(image::ImageFormat::Png) {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedInput,
      "image must be PNG",
    ));
  }

  let dyn_image = reader
    .decode()
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::UnsupportedInput, "PNG image is invalid"))?;

  validate_ocr_png_bounds(dyn_image.width(), dyn_image.height(), decoded.len())
}

fn map_ocr_language_hints(hints: &[String]) -> Result<Vec<String>, CapabilityError> {
  let mut mapped = Vec::with_capacity(hints.len());
  for hint in hints {
    let google = app_language_to_google(hint).ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::UnsupportedLanguage,
        format!("unsupported language hint: {hint}"),
      )
    })?;
    mapped.push(google.to_string());
  }
  Ok(mapped)
}

fn validate_path_segment(value: &str, field: &str) -> Result<String, CapabilityError> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      format!("{field} is required"),
    ));
  }
  if trimmed != value {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      format!("{field} must not have leading or trailing whitespace"),
    ));
  }
  if trimmed.len() > PATH_SEGMENT_MAX_LEN {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      format!("{field} exceeds {PATH_SEGMENT_MAX_LEN} characters"),
    ));
  }
  if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") || trimmed.contains(' ') {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      format!("{field} contains invalid path characters"),
    ));
  }
  Ok(trimmed.to_string())
}

/// Map application language id → Google BCP-47 code.
pub fn app_language_to_google(app_id: &str) -> Option<&'static str> {
  let id = app_id.trim().to_ascii_lowercase();
  match id.as_str() {
    "zh" => Some("zh-CN"),
    "no" => Some("nb"),
    "tl" => Some("fil"),
    other => {
      if SUPPORTED_LANGUAGES.contains(&other) {
        // Most app ids are already Google-compatible ISO codes.
        SUPPORTED_LANGUAGES.iter().copied().find(|c| *c == other)
      } else {
        None
      }
    }
  }
}

/// Map Google language code → application language id.
pub fn google_language_to_app(google_code: &str) -> Option<&'static str> {
  let lower = google_code.trim().to_ascii_lowercase();
  match lower.as_str() {
    "zh" | "zh-cn" | "zh-hans" => Some("zh"),
    "zh-tw" | "zh-hant" => Some("zh"),
    "nb" | "nn" | "no" => Some("no"),
    "fil" | "tl" => Some("tl"),
    "iw" => Some("he"),
    other => {
      // Strip region suffix: en-US → en
      let base = other.split('-').next().unwrap_or(other);
      SUPPORTED_LANGUAGES.iter().copied().find(|c| *c == base)
    }
  }
}

#[derive(Debug, Deserialize)]
struct TranslateTextApiResponse {
  #[serde(default)]
  translations: Vec<TranslateTextApiItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateTextApiItem {
  translated_text: Option<String>,
  detected_language_code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DetectLanguageApiResponse {
  #[serde(default)]
  languages: Vec<DetectLanguageApiItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetectLanguageApiItem {
  language_code: Option<String>,
  confidence: Option<f32>,
}

pub fn parse_translate_response(status: u16, body: &str) -> Result<TranslateTextResponse, CapabilityError> {
  map_google_http_error(status, body)?;
  let parsed: TranslateTextApiResponse = serde_json::from_str(body)
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "translate response was malformed"))?;
  let first = parsed.translations.into_iter().next().ok_or_else(|| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "translate response missing translations",
    )
  })?;
  let translated = first
    .translated_text
    .map(|s| s)
    .filter(|s| !s.is_empty())
    .ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidResponse,
        "translate response missing translatedText",
      )
    })?;
  let detected = first
    .detected_language_code
    .as_deref()
    .and_then(google_language_to_app)
    .map(str::to_string);
  Ok(TranslateTextResponse {
    translated_text: translated,
    detected_source_language_id: detected,
  })
}

#[derive(Debug, Deserialize)]
struct VisionAnnotateApiResponse {
  #[serde(default)]
  responses: Vec<VisionAnnotateApiItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisionAnnotateApiItem {
  full_text_annotation: Option<VisionFullTextAnnotation>,
  #[serde(default)]
  text_annotations: Vec<VisionTextAnnotation>,
  error: Option<VisionPerImageError>,
}

#[derive(Debug, Deserialize)]
struct VisionFullTextAnnotation {
  text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VisionTextAnnotation {
  description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VisionPerImageError {
  /// Google RPC numeric code when present.
  code: Option<i64>,
  /// Provider status name or short reason (never logged as free-form message).
  status: Option<String>,
  /// Present on some Vision per-image errors; never surfaced to callers.
  #[allow(dead_code)]
  message: Option<String>,
}

/// Parse Vision `images:annotate` response into plain text.
pub fn parse_vision_annotate_response(status: u16, body: &str) -> Result<OcrImageResponse, CapabilityError> {
  map_google_http_error(status, body)?;
  let parsed: VisionAnnotateApiResponse = serde_json::from_str(body).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "vision annotate response was malformed",
    )
  })?;
  let first = parsed.responses.into_iter().next().ok_or_else(|| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "vision annotate response missing responses",
    )
  })?;

  if let Some(error) = first.error {
    return Err(map_vision_per_image_error(error));
  }

  if let Some(full) = first.full_text_annotation.and_then(|f| f.text) {
    return Ok(OcrImageResponse { text: full });
  }
  if let Some(first_annotation) = first.text_annotations.into_iter().next() {
    if let Some(description) = first_annotation.description {
      return Ok(OcrImageResponse { text: description });
    }
  }
  // Empty text is a successful OCR result (no text found).
  Ok(OcrImageResponse { text: String::new() })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TtsSynthesizeApiResponse {
  audio_content: Option<String>,
}

/// Parse Text-to-Speech synthesize response into bounded MP3 bytes.
pub fn parse_tts_synthesize_response(status: u16, body: &str) -> Result<SpeechSynthesizeResponse, CapabilityError> {
  map_google_http_error(status, body)?;
  let parsed: TtsSynthesizeApiResponse = serde_json::from_str(body).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "text-to-speech response was malformed",
    )
  })?;
  let audio_b64 = parsed
    .audio_content
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidResponse,
        "text-to-speech response missing audioContent",
      )
    })?;

  // Reject oversized base64 before decoding when clearly above the decoded bound.
  let max_base64_chars = (SPEECH_AUDIO_MAX_BYTES * 4 / 3) + 8;
  if audio_b64.len() > max_base64_chars {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "text-to-speech audio exceeds size limit",
    ));
  }

  let mp3_bytes = BASE64.decode(audio_b64).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "text-to-speech audioContent is not valid standard base64",
    )
  })?;
  if mp3_bytes.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "text-to-speech audioContent is empty",
    ));
  }
  if mp3_bytes.len() > SPEECH_AUDIO_MAX_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "text-to-speech audio exceeds size limit",
    ));
  }
  Ok(SpeechSynthesizeResponse { mp3_bytes })
}

/// True when a Vision error payload indicates a language-hint rejection.
/// Body/message is inspected only for mapping; never returned or logged.
fn vision_error_mentions_language(message: Option<&str>) -> bool {
  let Some(raw) = message.map(str::trim).filter(|s| !s.is_empty()) else {
    return false;
  };
  let lower = raw.to_ascii_lowercase();
  lower.contains("language") || lower.contains("lang hint") || lower.contains("languagehint")
}

fn map_vision_per_image_error(error: VisionPerImageError) -> CapabilityError {
  let status_name = error
    .status
    .as_deref()
    .map(|s| s.trim().to_ascii_uppercase())
    .filter(|s| !s.is_empty() && s.len() <= CAPABILITY_PROVIDER_CODE_MAX_LEN);
  let provider_code = status_name
    .clone()
    .or_else(|| error.code.map(|c| c.to_string()))
    .unwrap_or_else(|| "vision_error".into());
  let status_name = status_name.unwrap_or_default();

  // Never include error.message — it can contain image/path details.
  let (code, message, retryable) = match status_name.as_str() {
    "UNAUTHENTICATED" => (CapabilityErrorCode::Auth, "Google Cloud authentication failed", false),
    "PERMISSION_DENIED" => (
      CapabilityErrorCode::PermissionDenied,
      "Google Cloud permission denied",
      false,
    ),
    "RESOURCE_EXHAUSTED" => (CapabilityErrorCode::QuotaExceeded, "Google Cloud quota exceeded", true),
    "INVALID_ARGUMENT" => {
      // Product gate: provider-rejected language hints map to unsupported_language.
      // Inspect body only for mapping; never surface it to callers/logs.
      if vision_error_mentions_language(error.message.as_deref()) {
        (
          CapabilityErrorCode::UnsupportedLanguage,
          "Google Cloud rejected a language hint",
          false,
        )
      } else {
        (
          CapabilityErrorCode::InvalidRequest,
          "Google Cloud rejected the request",
          false,
        )
      }
    }
    "FAILED_PRECONDITION" | "OUT_OF_RANGE" => (
      CapabilityErrorCode::UnsupportedInput,
      "Google Cloud rejected the image input",
      false,
    ),
    "UNAVAILABLE" => (
      CapabilityErrorCode::ProviderUnavailable,
      "Google Cloud service unavailable",
      true,
    ),
    _ => match error.code {
      Some(7) => (
        CapabilityErrorCode::PermissionDenied,
        "Google Cloud permission denied",
        false,
      ),
      Some(16) => (CapabilityErrorCode::Auth, "Google Cloud authentication failed", false),
      Some(8) => (CapabilityErrorCode::QuotaExceeded, "Google Cloud quota exceeded", true),
      Some(3) => {
        if vision_error_mentions_language(error.message.as_deref()) {
          (
            CapabilityErrorCode::UnsupportedLanguage,
            "Google Cloud rejected a language hint",
            false,
          )
        } else {
          (
            CapabilityErrorCode::InvalidRequest,
            "Google Cloud rejected the request",
            false,
          )
        }
      }
      _ => (
        CapabilityErrorCode::ProviderUnavailable,
        "Google Cloud vision request failed",
        false,
      ),
    },
  };

  CapabilityError::new(code, message)
    .with_retryable(retryable)
    .with_provider_code(provider_code)
}

pub fn parse_detect_response(status: u16, body: &str) -> Result<DetectLanguageResponse, CapabilityError> {
  map_google_http_error(status, body)?;
  let parsed: DetectLanguageApiResponse = serde_json::from_str(body)
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "detect response was malformed"))?;
  if parsed.languages.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::UnsupportedLanguage,
      "detect response contained no languages",
    ));
  }

  let mut best: Option<(String, Option<f32>)> = None;
  for (idx, item) in parsed
    .languages
    .into_iter()
    .take(DETECT_LANGUAGES_MAX_ITEMS)
    .enumerate()
  {
    let Some(code) = item.language_code.as_deref() else {
      continue;
    };
    let Some(app_id) = google_language_to_app(code) else {
      continue;
    };
    let confidence = item.confidence.filter(|c| c.is_finite() && *c >= 0.0 && *c <= 1.0);
    match &best {
      None => best = Some((app_id.to_string(), confidence)),
      Some((_, best_conf)) => {
        let better = match (confidence, *best_conf) {
          (Some(c), Some(b)) => c > b,
          (Some(_), None) => true,
          (None, Some(_)) => false,
          (None, None) => idx == 0,
        };
        if better {
          best = Some((app_id.to_string(), confidence));
        }
      }
    }
  }

  let (language_id, confidence) = best.ok_or_else(|| {
    CapabilityError::new(
      CapabilityErrorCode::UnsupportedLanguage,
      "detected languages are outside the app contract",
    )
  })?;

  Ok(DetectLanguageResponse {
    language_id,
    confidence,
  })
}

/// Safe subset of a Google JSON error envelope. Never surface `message` to callers.
#[derive(Debug, Deserialize)]
struct GoogleErrorEnvelope {
  error: Option<GoogleErrorBody>,
}

#[derive(Debug, Deserialize)]
struct GoogleErrorBody {
  /// Numeric Google RPC / HTTP code when present.
  code: Option<i64>,
  /// Google RPC status name, e.g. `PERMISSION_DENIED`.
  status: Option<String>,
  #[serde(default)]
  details: Vec<GoogleErrorDetail>,
}

#[derive(Debug, Deserialize)]
struct GoogleErrorDetail {
  /// e.g. `RATE_LIMIT_EXCEEDED`, `SERVICE_DISABLED` from ErrorInfo.
  reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GoogleProviderErrorSignals {
  status_name: Option<String>,
  reason: Option<String>,
  provider_code: String,
}

/// Parse only non-sensitive provider codes/status from a Google error body.
fn extract_google_error_signals(status: u16, body: &str) -> GoogleProviderErrorSignals {
  let parsed = serde_json::from_str::<GoogleErrorEnvelope>(body).ok();
  let error = parsed.and_then(|envelope| envelope.error);
  let status_name = error
    .as_ref()
    .and_then(|e| e.status.as_ref())
    .map(|s| s.trim().to_ascii_uppercase())
    .filter(|s| !s.is_empty() && s.len() <= CAPABILITY_PROVIDER_CODE_MAX_LEN);
  let reason = error.as_ref().and_then(|e| {
    e.details.iter().find_map(|detail| {
      detail
        .reason
        .as_ref()
        .map(|r| r.trim().to_ascii_uppercase())
        .filter(|r| !r.is_empty() && r.len() <= CAPABILITY_PROVIDER_CODE_MAX_LEN)
    })
  });
  let provider_code = status_name
    .clone()
    .or_else(|| reason.clone())
    .unwrap_or_else(|| status.to_string());
  let _numeric = error.and_then(|e| e.code);
  GoogleProviderErrorSignals {
    status_name,
    reason,
    provider_code,
  }
}

fn map_google_http_error(status: u16, body: &str) -> Result<(), CapabilityError> {
  if (200..300).contains(&status) {
    return Ok(());
  }

  let signals = extract_google_error_signals(status, body);
  let status_name = signals.status_name.as_deref().unwrap_or("");
  let reason = signals.reason.as_deref().unwrap_or("");

  let is_unauthenticated = status == 401
    || status_name == "UNAUTHENTICATED"
    || reason == "ACCESS_TOKEN_EXPIRED"
    || reason == "ACCESS_TOKEN_TYPE_UNSUPPORTED";
  let is_permission = status == 403
    || status_name == "PERMISSION_DENIED"
    || reason == "ACCESS_TOKEN_SCOPE_INSUFFICIENT"
    || reason == "SERVICE_DISABLED"
    || reason == "CONSUMER_INVALID"
    || reason == "USER_PROJECT_DENIED";
  let is_quota = status_name == "RESOURCE_EXHAUSTED"
    || reason.contains("QUOTA")
    || reason == "RATE_LIMIT_EXCEEDED"
    || reason == "DAILY_LIMIT_EXCEEDED"
    || reason == "USER_RATE_LIMIT_EXCEEDED";

  // Vision language-hint rejections arrive as INVALID_ARGUMENT / 400 with a language message.
  if (status == 400 || status_name == "INVALID_ARGUMENT") && vision_error_mentions_language(Some(body)) {
    return Err(
      CapabilityError::new(
        CapabilityErrorCode::UnsupportedLanguage,
        "Google Cloud rejected a language hint",
      )
      .with_retryable(false)
      .with_provider_code(signals.provider_code),
    );
  }

  // Prefer semantic signals over bare HTTP status when both are present.
  if is_quota || status == 429 {
    let code = if is_quota && status != 429 {
      CapabilityErrorCode::QuotaExceeded
    } else if status == 429 && !is_quota {
      CapabilityErrorCode::RateLimited
    } else if reason.contains("QUOTA") || status_name == "RESOURCE_EXHAUSTED" {
      CapabilityErrorCode::QuotaExceeded
    } else {
      CapabilityErrorCode::RateLimited
    };
    let message = match code {
      CapabilityErrorCode::QuotaExceeded => "Google Cloud quota exceeded",
      _ => "Google Cloud rate limited",
    };
    return Err(
      CapabilityError::new(code, message)
        .with_retryable(true)
        .with_provider_code(signals.provider_code),
    );
  }

  if is_unauthenticated {
    return Err(
      CapabilityError::new(CapabilityErrorCode::Auth, "Google Cloud authentication failed")
        .with_retryable(false)
        .with_provider_code(signals.provider_code),
    );
  }

  if is_permission {
    // 403 without auth-shaped signals is permission, not a failed credential exchange.
    return Err(
      CapabilityError::new(CapabilityErrorCode::PermissionDenied, "Google Cloud permission denied")
        .with_retryable(false)
        .with_provider_code(signals.provider_code),
    );
  }

  match status {
    400 => Err(
      CapabilityError::new(CapabilityErrorCode::InvalidRequest, "Google Cloud rejected the request")
        .with_retryable(false)
        .with_provider_code(signals.provider_code),
    ),
    500..=599 => Err(
      CapabilityError::new(
        CapabilityErrorCode::ProviderUnavailable,
        "Google Cloud service unavailable",
      )
      .with_retryable(true)
      .with_provider_code(signals.provider_code),
    ),
    _ => Err(
      CapabilityError::new(CapabilityErrorCode::ProviderUnavailable, "Google Cloud request failed")
        .with_retryable(false)
        .with_provider_code(signals.provider_code),
    ),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn google_cloud_translate_language_mapping_roundtrip() {
    assert_eq!(app_language_to_google("zh"), Some("zh-CN"));
    assert_eq!(app_language_to_google("en"), Some("en"));
    assert_eq!(app_language_to_google("no"), Some("nb"));
    assert_eq!(app_language_to_google("tl"), Some("fil"));
    assert_eq!(app_language_to_google("xx"), None);

    assert_eq!(google_language_to_app("zh-CN"), Some("zh"));
    assert_eq!(google_language_to_app("zh-TW"), Some("zh"));
    assert_eq!(google_language_to_app("nb"), Some("no"));
    assert_eq!(google_language_to_app("fil"), Some("tl"));
    assert_eq!(google_language_to_app("en-US"), Some("en"));
    assert_eq!(google_language_to_app("xyz"), None);
  }

  #[test]
  fn google_cloud_translate_parses_success_and_auto_source() {
    let body = r#"{
      "translations": [
        { "translatedText": "你好", "detectedLanguageCode": "en" }
      ]
    }"#;
    let resp = parse_translate_response(200, body).unwrap();
    assert_eq!(resp.translated_text, "你好");
    assert_eq!(resp.detected_source_language_id.as_deref(), Some("en"));
  }

  #[test]
  fn google_cloud_translate_rejects_empty_translations() {
    let err = parse_translate_response(200, r#"{"translations":[]}"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }

  #[test]
  fn google_cloud_translate_maps_auth_and_quota_errors() {
    let err = parse_translate_response(401, r#"{"error":{"message":"secret-token-value"}}"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::Auth);
    assert!(!format!("{err:?}").contains("secret-token-value"));
    assert!(!err.message.contains("secret-token-value"));

    let err = parse_translate_response(429, "{}").unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::RateLimited);
    assert!(err.retryable);
  }

  #[test]
  fn google_cloud_maps_permission_denied_separate_from_auth() {
    let body = r#"{
      "error": {
        "code": 403,
        "message": "Permission denied on project secret-project",
        "status": "PERMISSION_DENIED",
        "details": [{ "reason": "USER_PROJECT_DENIED" }]
      }
    }"#;
    let err = parse_translate_response(403, body).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
    assert_eq!(err.provider_code.as_deref(), Some("PERMISSION_DENIED"));
    assert!(!err.message.contains("secret-project"));
    assert!(!format!("{err:?}").contains("secret-project"));
  }

  #[test]
  fn google_cloud_maps_unauthenticated_status_to_auth() {
    let body = r#"{
      "error": {
        "code": 401,
        "message": "Request had invalid authentication credentials",
        "status": "UNAUTHENTICATED"
      }
    }"#;
    let err = parse_detect_response(401, body).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::Auth);
    assert_eq!(err.provider_code.as_deref(), Some("UNAUTHENTICATED"));
  }

  #[test]
  fn google_cloud_maps_resource_exhausted_to_quota() {
    let body = r#"{
      "error": {
        "code": 429,
        "message": "Quota exceeded for quota metric",
        "status": "RESOURCE_EXHAUSTED",
        "details": [{ "reason": "RATE_LIMIT_EXCEEDED" }]
      }
    }"#;
    let err = parse_translate_response(429, body).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::QuotaExceeded);
    assert!(err.retryable);
    assert!(!err.message.contains("Quota exceeded for quota metric"));
  }

  #[test]
  fn google_cloud_bare_403_without_body_is_permission_denied() {
    let err = parse_translate_response(403, "not-json").unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
    assert_eq!(err.provider_code.as_deref(), Some("403"));
  }

  #[test]
  fn google_cloud_translate_unicode_and_html_looking_plain_text() {
    let body = r#"{
      "translations": [
        { "translatedText": "<b>not html</b>\n第二行" }
      ]
    }"#;
    let resp = parse_translate_response(200, body).unwrap();
    assert!(resp.translated_text.contains("<b>not html</b>"));
    assert!(resp.translated_text.contains("第二行"));
  }

  #[test]
  fn google_cloud_detect_selects_supported_highest_confidence() {
    let body = r#"{
      "languages": [
        { "languageCode": "xx", "confidence": 0.99 },
        { "languageCode": "zh-TW", "confidence": 0.80 },
        { "languageCode": "en", "confidence": 0.70 }
      ]
    }"#;
    let resp = parse_detect_response(200, body).unwrap();
    assert_eq!(resp.language_id, "zh");
    assert_eq!(resp.confidence, Some(0.80));
  }

  #[test]
  fn google_cloud_detect_unsupported_only() {
    let body = r#"{
      "languages": [
        { "languageCode": "xx", "confidence": 0.9 }
      ]
    }"#;
    let err = parse_detect_response(200, body).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedLanguage);
  }

  #[test]
  fn google_cloud_detect_empty_and_malformed_confidence() {
    let err = parse_detect_response(200, r#"{"languages":[]}"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedLanguage);

    let body = r#"{
      "languages": [
        { "languageCode": "en", "confidence": "bad" }
      ]
    }"#;
    // confidence type mismatch → malformed response
    let err = parse_detect_response(200, body).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }

  #[test]
  fn google_cloud_path_segment_validation() {
    assert!(validate_path_segment("my-project", "project_id").is_ok());
    assert!(validate_path_segment("global", "location").is_ok());
    assert!(validate_path_segment("../x", "project_id").is_err());
    assert!(validate_path_segment("a/b", "project_id").is_err());
    assert!(validate_path_segment(" has space", "project_id").is_err());
    assert!(validate_path_segment("", "project_id").is_err());
  }

  #[test]
  fn google_cloud_vision_parses_full_text_annotation() {
    let body = r#"{
      "responses": [{
        "fullTextAnnotation": { "text": "Hello\nWorld" },
        "textAnnotations": [{ "description": "Hello\nWorld" }]
      }]
    }"#;
    let resp = parse_vision_annotate_response(200, body).unwrap();
    assert_eq!(resp.text, "Hello\nWorld");
  }

  #[test]
  fn google_cloud_vision_falls_back_to_text_annotations() {
    let body = r#"{
      "responses": [{
        "textAnnotations": [{ "description": "fallback text" }]
      }]
    }"#;
    let resp = parse_vision_annotate_response(200, body).unwrap();
    assert_eq!(resp.text, "fallback text");
  }

  #[test]
  fn google_cloud_vision_empty_text_is_success() {
    let body = r#"{ "responses": [{}] }"#;
    let resp = parse_vision_annotate_response(200, body).unwrap();
    assert_eq!(resp.text, "");
  }

  #[test]
  fn google_cloud_vision_per_image_error_maps_permission() {
    let body = r#"{
      "responses": [{
        "error": {
          "code": 7,
          "message": "Cloud Vision API has not been used in project secret-project",
          "status": "PERMISSION_DENIED"
        }
      }]
    }"#;
    let err = parse_vision_annotate_response(200, body).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
    assert_eq!(err.provider_code.as_deref(), Some("PERMISSION_DENIED"));
    assert!(!err.message.contains("secret-project"));
    assert!(!format!("{err:?}").contains("secret-project"));
  }

  #[test]
  fn google_cloud_tts_parse_valid_and_rejects_empty_or_invalid() {
    let audio = BASE64.encode(b"ID3fake-mp3");
    let body = format!(r#"{{"audioContent":"{audio}"}}"#);
    let response = parse_tts_synthesize_response(200, &body).unwrap();
    assert_eq!(response.mp3_bytes, b"ID3fake-mp3");

    let err = parse_tts_synthesize_response(200, r#"{"audioContent":""}"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);

    let err = parse_tts_synthesize_response(200, r#"{"audioContent":"%%%"}"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }

  #[test]
  fn google_cloud_vision_malformed_response() {
    let err = parse_vision_annotate_response(200, "not-json").unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);

    let err = parse_vision_annotate_response(200, r#"{"responses":[]}"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }

  #[test]
  fn google_cloud_vision_http_error_mapping() {
    let err = parse_vision_annotate_response(401, r#"{"error":{"status":"UNAUTHENTICATED"}}"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::Auth);

    let err = parse_vision_annotate_response(429, "{}").unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::RateLimited);
  }

  #[test]
  fn google_cloud_vision_png_validation_rejects_invalid_and_oversized() {
    let err = decode_and_validate_ocr_png("").unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidRequest);

    let err = decode_and_validate_ocr_png("%%%not-base64%%%").unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedInput);

    // Valid base64 that is not a PNG.
    let not_png = BASE64.encode(b"hello world");
    let err = decode_and_validate_ocr_png(&not_png).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedInput);

    // Oversized decoded payload (skip image decode).
    let huge = BASE64.encode(vec![
      0u8;
      crate::domain::service_capability::OCR_IMAGE_MAX_DECODED_BYTES + 1
    ]);
    let err = decode_and_validate_ocr_png(&huge).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedInput);
  }

  #[test]
  fn google_cloud_vision_png_validation_accepts_minimal_png() {
    // 1x1 transparent PNG.
    let png_bytes: &[u8] = &[
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49,
      0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let encoded = BASE64.encode(png_bytes);
    let bounds = decode_and_validate_ocr_png(&encoded).unwrap();
    assert_eq!(bounds.width, 1);
    assert_eq!(bounds.height, 1);
  }

  #[test]
  fn google_cloud_vision_language_hint_mapping() {
    let mapped = map_ocr_language_hints(&["zh".into(), "en".into()]).unwrap();
    assert_eq!(mapped, vec!["zh-CN".to_string(), "en".to_string()]);

    let err = map_ocr_language_hints(&["xx".into()]).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedLanguage);
  }

  // --- grant → broker → request path tests (fake vault/token/network only) ---

  use crate::domain::cancel::CancelToken;
  use crate::domain::provider::ProxyMode;
  use crate::domain::provider_http::{ProviderHttpResponse, ProviderHttpStreamEvent};
  use crate::domain::service_integration::{
    GOOGLE_CLOUD_DEFAULT_LOCATION, IntegrationHealthStatus, IntegrationInstance,
  };
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::services::bounded_http::{PreparedHttpRequest, RawHttpTransport};
  use crate::services::network_broker::NetworkBroker;
  use crate::services::service_integration_registry::ServiceIntegrationRegistry;
  use crate::services::token_grant::{ExchangedToken, GoogleTokenExchanger, TokenGrantService};
  use crate::storage::Database;
  use std::future::Future;
  use std::pin::Pin;
  use std::sync::Mutex;

  struct CaptureTransport {
    last: Mutex<Option<PreparedHttpRequest>>,
    response: Mutex<Result<ProviderHttpResponse, StorageError>>,
  }

  impl RawHttpTransport for CaptureTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderHttpResponse, StorageError>> + Send + '_>> {
      Box::pin(async move {
        *self.last.lock().unwrap() = Some(prepared);
        match &*self.response.lock().unwrap() {
          Ok(r) => Ok(r.clone()),
          Err(e) => Err(StorageError::Validation(e.to_string())),
        }
      })
    }

    fn stream(
      &self,
      _prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
    ) -> Pin<Box<dyn Future<Output = Result<(), StorageError>> + Send + '_>> {
      Box::pin(async { Err(StorageError::Validation("stream not supported".into())) })
    }
  }

  struct PathTestExchanger;

  impl GoogleTokenExchanger for PathTestExchanger {
    fn exchange(
      &self,
      _instance_id: Uuid,
      _scopes: Vec<String>,
      _now_unix_secs: u64,
      _cancel: Option<CancelToken>,
    ) -> Pin<Box<dyn Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>> {
      Box::pin(async {
        Ok(ExchangedToken {
          access_token: "path-test-token".into(),
          expires_in: 3600,
          credential_revision: 1,
        })
      })
    }
  }

  fn seed_google_instance(db: &Database, project_id: &str) -> Uuid {
    let id = new_id();
    let now = now_rfc3339();
    let config = GoogleCloudConfigV1 {
      project_id: project_id.into(),
      location: GOOGLE_CLOUD_DEFAULT_LOCATION.into(),
      proxy_mode: ProxyMode::Direct,
    };
    db.transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &IntegrationInstance {
          id,
          plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
          plugin_version: "1.0.0".into(),
          display_name: "Path Test".into(),
          enabled: true,
          config_json: serde_json::to_string(&config).unwrap(),
          config_schema_version: 1,
          health_status: IntegrationHealthStatus::Unvalidated,
          last_validated_at: None,
          last_error_code: None,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();
    id
  }

  fn make_capabilities(db: Database, transport: Arc<dyn RawHttpTransport>) -> GoogleCloudCapabilities {
    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let network = Arc::new(NetworkBroker::with_transport(db.clone(), registry, transport));
    let tokens = Arc::new(TokenGrantService::new(Arc::new(PathTestExchanger)));
    GoogleCloudCapabilities::new(db, network, tokens)
  }

  fn exec_ctx(instance_id: Uuid, capability_id: &str) -> ExecutionContext {
    ExecutionContext {
      request_id: "req-path-1".into(),
      cancel: CancelToken::new(),
      deadline: None,
      integration_instance_id: instance_id,
      plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
      capability_id: capability_id.into(),
    }
  }

  #[tokio::test]
  async fn translate_text_grant_broker_request_path() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let instance_id = seed_google_instance(&db, "demo-project");

    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: r#"{"translations":[{"translatedText":"hola","detectedLanguageCode":"en"}]}"#.into(),
      })),
    });
    let caps = make_capabilities(db, transport.clone());

    let response = caps
      .translate_text(
        instance_id,
        TranslateTextRequest {
          text: "hello".into(),
          source_language_id: "auto".into(),
          target_language_id: "es".into(),
        },
        exec_ctx(instance_id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID),
      )
      .await
      .unwrap();

    assert_eq!(response.translated_text, "hola");
    assert_eq!(response.detected_source_language_id.as_deref(), Some("en"));

    let prepared = transport.last.lock().unwrap().take().expect("broker executed request");
    assert!(
      prepared
        .url
        .as_str()
        .contains("v3beta1/projects/demo-project/locations/global:translateText")
    );
    assert_eq!(
      prepared.headers.get("Authorization").map(String::as_str),
      Some("Bearer path-test-token")
    );
    let body = prepared.body.as_deref().unwrap_or("");
    assert!(body.contains("\"contents\""));
    assert!(body.contains("hello"));
    assert!(body.contains("text/plain"));
    assert!(body.contains("es"));
    assert!(!body.contains("sourceLanguageCode"));
  }

  #[tokio::test]
  async fn detect_language_grant_broker_request_path() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let instance_id = seed_google_instance(&db, "detect-project");

    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: r#"{"languages":[{"languageCode":"ja","confidence":0.91}]}"#.into(),
      })),
    });
    let caps = make_capabilities(db, transport.clone());

    let response = caps
      .detect_language(
        instance_id,
        DetectLanguageRequest {
          text: "こんにちは".into(),
        },
        exec_ctx(instance_id, GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID),
      )
      .await
      .unwrap();

    assert_eq!(response.language_id, "ja");
    assert_eq!(response.confidence, Some(0.91));

    let prepared = transport.last.lock().unwrap().take().expect("broker executed request");
    assert!(
      prepared
        .url
        .as_str()
        .contains("v3beta1/projects/detect-project/locations/global:detectLanguage")
    );
    assert_eq!(
      prepared.headers.get("Authorization").map(String::as_str),
      Some("Bearer path-test-token")
    );
    let body = prepared.body.as_deref().unwrap_or("");
    assert!(body.contains("こんにちは"));
    assert!(body.contains("text/plain"));
  }

  #[tokio::test]
  async fn ocr_image_grant_broker_request_path() {
    use crate::domain::service_capability::{OcrImageOperation, OcrImagePreferences};

    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let instance_id = seed_google_instance(&db, "vision-project");

    let png_bytes: &[u8] = &[
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49,
      0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let png_base64 = BASE64.encode(png_bytes);

    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: r#"{"responses":[{"fullTextAnnotation":{"text":"vision-ok"}}]}"#.into(),
      })),
    });
    let caps = make_capabilities(db, transport.clone());

    let response = caps
      .ocr_image(
        instance_id,
        OcrImageRequest {
          png_base64: png_base64.clone(),
          preferences: OcrImagePreferences {
            operation: OcrImageOperation::DocumentTextDetection,
            language_hints: vec!["en".into(), "zh".into()],
          },
        },
        exec_ctx(instance_id, OCR_IMAGE_CAPABILITY_ID),
      )
      .await
      .unwrap();

    assert_eq!(response.text, "vision-ok");

    let prepared = transport.last.lock().unwrap().take().expect("broker executed request");
    assert!(prepared.url.as_str().contains("v1/images:annotate"));
    assert!(prepared.url.as_str().contains("vision.googleapis.com"));
    assert_eq!(
      prepared.headers.get("Authorization").map(String::as_str),
      Some("Bearer path-test-token")
    );
    let body = prepared.body.as_deref().unwrap_or("");
    assert!(body.contains("DOCUMENT_TEXT_DETECTION"));
    assert!(body.contains("languageHints"));
    assert!(body.contains("zh-CN"));
    assert!(body.contains(&png_base64));
  }
}
