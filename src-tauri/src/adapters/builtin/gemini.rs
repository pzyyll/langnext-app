// ABOUTME: Google Gemini generateContent adapter strategy.
// ABOUTME: Owns query-key auth, model list metadata, generate/stream paths, and SSE alt flag.
use crate::adapters::builtin::openai_shared::normalize_model_key;
use crate::adapters::protocol::{AdapterMeta, ProviderAdapter};
use crate::adapters::transport::{AuthApplication, ChatCompletionRequest, ParsedPage, TransportError, build_endpoint};
use crate::domain::model::RemoteModelSyncItem;
use crate::domain::provider::CredentialKind;

const MAX_MODELS_PER_PAGE: usize = 500;
const MAX_MODEL_KEY_LEN: usize = 256;
const MAX_REMOTE_METADATA_BYTES: usize = 2048;
const MAX_GEMINI_METHODS: usize = 32;
const MAX_GEMINI_METHOD_LEN: usize = 128;

/// Google Gemini generateContent / streamGenerateContent.
#[derive(Debug, Default, Clone, Copy)]
pub struct GeminiAdapter;

impl ProviderAdapter for GeminiAdapter {
  fn meta(&self) -> AdapterMeta {
    AdapterMeta {
      id: "gemini",
      label: "Gemini",
      default_base_url: Some("https://generativelanguage.googleapis.com"),
    }
  }

  fn secret_required(&self, _credential_kind: CredentialKind) -> bool {
    true
  }

  fn auth_application(&self, _credential_kind: CredentialKind) -> Result<AuthApplication, TransportError> {
    Ok(AuthApplication::GeminiQueryKey)
  }

  fn models_path(&self) -> &'static str {
    "v1beta/models"
  }

  fn parse_models_page(&self, value: &serde_json::Value) -> Result<ParsedPage, TransportError> {
    parse_gemini_page(value)
  }

  fn apply_list_continuation(&self, url: &mut url::Url, cursor: &str) -> Result<(), TransportError> {
    url.query_pairs_mut().append_pair("pageToken", cursor);
    Ok(())
  }

  fn build_chat(
    &self,
    request: &ChatCompletionRequest,
    stream: bool,
  ) -> Result<(url::Url, serde_json::Value), TransportError> {
    let model_path = if stream {
      gemini_stream_generate_path(&request.model_key)?
    } else {
      gemini_generate_path(&request.model_key)?
    };
    let url = build_endpoint(&request.base_url, &model_path)?;
    let image = request.image_png_base64.as_deref();
    let mut generation_config = serde_json::Map::new();
    if let Some(temp) = request.temperature {
      generation_config.insert("temperature".into(), serde_json::json!(temp));
    }
    if let Some(max) = request.max_tokens {
      generation_config.insert("maxOutputTokens".into(), serde_json::json!(max));
    }
    let mut payload = serde_json::json!({
      "systemInstruction": {
        "parts": [{ "text": request.system_prompt }]
      },
      "contents": [{
        "role": "user",
        "parts": gemini_user_parts(&request.user_prompt, image)
      }]
    });
    if !generation_config.is_empty() {
      payload["generationConfig"] = serde_json::Value::Object(generation_config);
    }
    Ok((url, payload))
  }

  fn parse_chat_content(&self, value: &serde_json::Value) -> Result<String, TransportError> {
    parse_gemini_generate_content(value)
  }

  fn parse_stream_delta(&self, _event_name: Option<&str>, value: &serde_json::Value) -> Option<String> {
    parse_gemini_stream_delta(value)
  }

  fn finalize_stream_url(&self, url: &mut url::Url) {
    // Gemini official streaming uses alt=sse for Server-Sent Events framing.
    url.query_pairs_mut().append_pair("alt", "sse");
  }
}

/// Pure Gemini models page parser.
pub fn parse_gemini_page(value: &serde_json::Value) -> Result<ParsedPage, TransportError> {
  let models = value
    .get("models")
    .and_then(|v| v.as_array())
    .ok_or(TransportError::InvalidResponse)?;
  if models.len() > MAX_MODELS_PER_PAGE {
    return Err(TransportError::InvalidResponse);
  }
  let mut items = Vec::with_capacity(models.len());
  for entry in models {
    let name = entry
      .get("name")
      .and_then(|v| v.as_str())
      .ok_or(TransportError::InvalidResponse)?;
    let stripped = name.strip_prefix("models/").unwrap_or(name);
    let model_key = normalize_model_key(stripped)?;
    let remote_display_name = entry.get("displayName").and_then(|v| v.as_str()).map(|s| s.to_string());
    let remote_metadata_json = bound_gemini_metadata(entry)?;
    items.push(RemoteModelSyncItem {
      model_key,
      remote_display_name,
      remote_metadata_json,
      capability_overrides_json: None,
    });
  }
  let continuation = parse_gemini_next_page_token(value.get("nextPageToken"))?;
  Ok(ParsedPage { items, continuation })
}

fn parse_gemini_next_page_token(token: Option<&serde_json::Value>) -> Result<Option<String>, TransportError> {
  match token {
    None | Some(serde_json::Value::Null) => Ok(None),
    Some(serde_json::Value::String(s)) => {
      if s.is_empty() {
        Ok(None)
      } else {
        Ok(Some(s.clone()))
      }
    }
    // Present but wrong type — never treat as end of pagination.
    Some(_) => Err(TransportError::InvalidResponse),
  }
}

/// Bound Gemini metadata to a small list of string method names.
fn bound_gemini_metadata(entry: &serde_json::Value) -> Result<Option<serde_json::Value>, TransportError> {
  let Some(methods_val) = entry.get("supportedGenerationMethods") else {
    return Ok(None);
  };
  if methods_val.is_null() {
    return Ok(None);
  }
  let methods = methods_val.as_array().ok_or(TransportError::InvalidResponse)?;
  if methods.len() > MAX_GEMINI_METHODS {
    return Err(TransportError::InvalidResponse);
  }
  let mut out: Vec<String> = Vec::with_capacity(methods.len());
  for method in methods {
    let s = method.as_str().ok_or(TransportError::InvalidResponse)?;
    if s.is_empty() || s.len() > MAX_GEMINI_METHOD_LEN {
      return Err(TransportError::InvalidResponse);
    }
    out.push(s.to_string());
  }
  let meta = serde_json::json!({ "supportedGenerationMethods": out });
  let serialized = serde_json::to_vec(&meta).map_err(|_| TransportError::InvalidResponse)?;
  if serialized.len() > MAX_REMOTE_METADATA_BYTES {
    return Err(TransportError::InvalidResponse);
  }
  Ok(Some(meta))
}

fn gemini_user_parts(user_prompt: &str, image_png_base64: Option<&str>) -> serde_json::Value {
  match image_png_base64 {
    Some(image) => serde_json::json!([
      { "text": user_prompt },
      {
        "inline_data": {
          "mime_type": "image/png",
          "data": image
        }
      }
    ]),
    None => serde_json::json!([{ "text": user_prompt }]),
  }
}

fn gemini_generate_path(model_key: &str) -> Result<String, TransportError> {
  let resource = gemini_model_resource(model_key)?;
  Ok(format!("v1beta/{resource}:generateContent"))
}

fn gemini_stream_generate_path(model_key: &str) -> Result<String, TransportError> {
  let resource = gemini_model_resource(model_key)?;
  Ok(format!("v1beta/{resource}:streamGenerateContent"))
}

fn gemini_model_resource(model_key: &str) -> Result<String, TransportError> {
  let key = model_key.trim();
  if key.is_empty() || key.len() > MAX_MODEL_KEY_LEN {
    return Err(TransportError::InvalidResponse);
  }
  if key.contains("://") || key.contains('?') || key.contains('#') {
    return Err(TransportError::InvalidResponse);
  }
  if key.starts_with("models/") {
    Ok(key.to_string())
  } else {
    Ok(format!("models/{key}"))
  }
}

fn parse_gemini_generate_content(value: &serde_json::Value) -> Result<String, TransportError> {
  let parts = value
    .get("candidates")
    .and_then(|c| c.as_array())
    .and_then(|arr| arr.first())
    .and_then(|cand| cand.get("content"))
    .and_then(|c| c.get("parts"))
    .and_then(|p| p.as_array())
    .ok_or(TransportError::InvalidResponse)?;
  let mut texts = Vec::new();
  for part in parts {
    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
      if !text.is_empty() {
        texts.push(text);
      }
    }
  }
  let joined = texts.join("");
  let trimmed = joined.trim();
  if trimmed.is_empty() {
    return Err(TransportError::InvalidResponse);
  }
  Ok(trimmed.to_string())
}

fn parse_gemini_stream_delta(value: &serde_json::Value) -> Option<String> {
  let parts = value
    .get("candidates")
    .and_then(|c| c.as_array())
    .and_then(|arr| arr.first())
    .and_then(|cand| cand.get("content"))
    .and_then(|c| c.get("parts"))
    .and_then(|p| p.as_array())?;
  let mut texts = Vec::new();
  for part in parts {
    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
      if !text.is_empty() {
        texts.push(text);
      }
    }
  }
  if texts.is_empty() { None } else { Some(texts.join("")) }
}
