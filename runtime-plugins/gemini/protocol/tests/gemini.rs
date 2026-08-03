// ABOUTME: Fixture tests for the shared Gemini protocol crate.
// ABOUTME: Ports payload/content/stream/image literals from the TypeScript plugin tests.
use langnext_gemini_protocol::*;

#[test]
fn builds_generate_content_body_and_resource_path() {
  let resource = gemini_model_resource("gemini-2.0-flash").unwrap();
  assert_eq!(resource, "models/gemini-2.0-flash");
  assert_eq!(gemini_model_resource("models/gemini-2.0-flash").unwrap(), "models/gemini-2.0-flash");
  let body = build_generate_content(&resource, "sys", "hi", None, Some(256), None, false);
  assert_eq!(
    body,
    r#"{"systemInstruction":{"parts":[{"text":"sys"}]},"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":256}}"#
  );
  let body = build_generate_content(&resource, "sys", "hi", Some(0.2), None, None, true);
  assert_eq!(
    body,
    r#"{"systemInstruction":{"parts":[{"text":"sys"}]},"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"temperature":0.2}}"#
  );
}

#[test]
fn builds_image_inline_data_parts() {
  let resource = gemini_model_resource("gemini-2.0-flash").unwrap();
  let body = build_generate_content(
    &resource,
    "sys",
    "What is in this image?",
    None,
    Some(256),
    Some("iVBORw0KGgo"),
    false,
  );
  assert_eq!(
    body,
    r#"{"systemInstruction":{"parts":[{"text":"sys"}]},"contents":[{"role":"user","parts":[{"text":"What is in this image?"},{"inline_data":{"mime_type":"image/png","data":"iVBORw0KGgo"}}]}],"generationConfig":{"maxOutputTokens":256}}"#
  );
}

#[test]
fn gemini_model_resource_rejects_invalid_keys() {
  assert!(gemini_model_resource("").is_err());
  assert!(gemini_model_resource("  ").is_err());
  assert!(gemini_model_resource(&"x".repeat(257)).is_err());
  assert!(gemini_model_resource("a://b").is_err());
  assert!(gemini_model_resource("a?b").is_err());
  assert!(gemini_model_resource("a#b").is_err());
  assert_eq!(gemini_model_resource(" gemini-2.0-flash ").unwrap(), "models/gemini-2.0-flash");
}

#[test]
fn parses_model_page_and_next_page_token() {
  let page = parse_models_page(
    br#"{"models":[{"name":"models/gemini-2.0-flash","displayName":"Flash","supportedGenerationMethods":["generateContent"]}],"nextPageToken":"tok-2"}"#,
  )
  .unwrap();
  assert_eq!(
    page,
    GeminiModelsPage {
      items: vec![("gemini-2.0-flash".to_string(), Some("Flash".to_string()))],
      continuation: Some("tok-2".to_string()),
    }
  );
  let last = parse_models_page(br#"{"models":[{"name":"models/gemini-2.0-pro","displayName":"Pro"}]}"#).unwrap();
  assert_eq!(
    last,
    GeminiModelsPage {
      items: vec![("gemini-2.0-pro".to_string(), Some("Pro".to_string()))],
      continuation: None,
    }
  );
}

#[test]
fn model_page_errors_fail_closed() {
  for (body, expected) in [
    (br#"not-json"#.as_slice(), "gemini model list is not JSON"),
    (br#"{"models":42}"#.as_slice(), "gemini model list missing models"),
    (br#"{"models":[{}]}"#.as_slice(), "gemini model missing name"),
    (br#"{"models":[{"name":"models/x","supportedGenerationMethods":"nope"}]}"#.as_slice(), "invalid gemini methods metadata"),
    (br#"{"models":[{"name":"models/x","supportedGenerationMethods":[""]}]}"#.as_slice(), "invalid gemini method name"),
    (br#"{"models":[{"name":"models/x","supportedGenerationMethods":["x"]}],"nextPageToken":42}"#.as_slice(), "invalid gemini nextPageToken"),
    (br#"{"models":[{"name":"   "}]}"#.as_slice(), "invalid model key"),
  ] {
    let err = parse_models_page(body).unwrap_err();
    assert_eq!(err.0, expected, "body: {}", String::from_utf8_lossy(body));
  }
  let mut oversized = String::from(r#"{"models":["#);
  for index in 0..501 {
    if index > 0 {
      oversized.push(',');
    }
    oversized.push_str(&format!(r#"{{"name":"models/model-{index}"}}"#));
  }
  oversized.push_str(r#"]}"#);
  assert_eq!(
    parse_models_page(oversized.as_bytes()).unwrap_err().0,
    "gemini model list page too large"
  );
}

#[test]
fn parses_content_and_stream_parts() {
  let text = parse_chat_content(br#"{"candidates":[{"content":{"parts":[{"text":"hello"},{"text":" world"}]}}]}"#).unwrap();
  assert_eq!(text, "hello world");
  let delta = parse_stream_event_data(
    br#"{"candidates":[{"content":{"parts":[{"text":"hello"},{"text":" world"}]}}]}"#,
  )
  .unwrap();
  assert_eq!(delta, StreamEventOutcome::Delta("hello world".to_string()));
  assert_eq!(
    parse_stream_event_data(br#"{"candidates":[{"content":{"parts":[]}}]}"#).unwrap(),
    StreamEventOutcome::Ignore
  );
  assert_eq!(parse_stream_event_data(b"{}").unwrap(), StreamEventOutcome::Ignore);
  assert_eq!(parse_stream_event_data(b"").unwrap(), StreamEventOutcome::Ignore);
  assert_eq!(parse_stream_event_data(b"{broken").unwrap_err().0, "stream event is not JSON");
}

#[test]
fn chat_content_errors_match_provider_fixtures() {
  for (body, expected) in [
    (br#"not-json"#.as_slice(), "gemini response is not JSON"),
    (br#"{"candidates":[]}"#.as_slice(), "gemini content is empty"),
    (br#"{"candidates":[{"content":{"parts":[{"text":""}]}}]}"#.as_slice(), "gemini content is empty"),
    (br#"{"candidates":[{"content":{"parts":[{"text":"  "}]}}]}"#.as_slice(), "gemini content is empty"),
  ] {
    let err = parse_chat_content(body).unwrap_err();
    assert_eq!(err.0, expected, "body: {}", String::from_utf8_lossy(body));
  }
}

#[test]
fn sse_decoder_groups_data_lines_across_frames() {
  let fixture: &[u8] = b"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"wo\"}]}}]}\n\ndata: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"rld\"}]}}]}\n\n";
  let mut decoder = SseDecoder::new();
  let split = fixture.len() / 2;
  let mut events = decoder.feed(&fixture[..split]);
  events.extend(decoder.feed(&fixture[split..]));
  assert_eq!(events.len(), 2);
  assert_eq!(
    parse_stream_event_data(&events[0]).unwrap(),
    StreamEventOutcome::Delta("wo".to_string())
  );
  assert_eq!(
    parse_stream_event_data(&events[1]).unwrap(),
    StreamEventOutcome::Delta("rld".to_string())
  );
  assert!(decoder.feed(b"").is_empty());
}

#[test]
fn parses_host_preference_envelope() {
  let preferences = parse_preferences(br#"{"stream":false,"maxTokens":256}"#).unwrap();
  assert_eq!(
    preferences,
    LlmPreferences {
      stream: false,
      temperature: None,
      max_tokens: Some(256),
    }
  );
  let streaming = parse_preferences(br#"{"stream":true,"temperature":0.2}"#).unwrap();
  assert_eq!(
    streaming,
    LlmPreferences {
      stream: true,
      temperature: Some(0.2),
      max_tokens: None,
    }
  );
  assert!(parse_preferences(br#"{}"#).is_err());
  assert!(parse_preferences(b"not-json").is_err());
}

#[test]
fn maps_provider_status_to_bounded_codes() {
  assert_eq!(provider_status_error(200), None);
  assert_eq!(provider_status_error(401), Some(ProviderStatusError::Auth));
  assert_eq!(provider_status_error(403), Some(ProviderStatusError::Auth));
  assert_eq!(provider_status_error(429), Some(ProviderStatusError::RateLimited));
  assert_eq!(provider_status_error(500), Some(ProviderStatusError::Server));
  assert_eq!(provider_status_error(400), Some(ProviderStatusError::Client));
}

#[test]
fn base64_encoder_matches_fixed_png() {
  const FIXED_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ];
  assert_eq!(
    base64_encode(FIXED_PNG),
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGIAAQAABQABDQottAAAAABJRU5ErkJggg=="
  );
  assert_eq!(base64_encode(b""), "");
  assert_eq!(base64_encode(b"a"), "YQ==");
  assert_eq!(base64_encode(b"ab"), "YWI=");
  assert_eq!(base64_encode(b"abc"), "YWJj");
}

#[test]
fn validates_png_image_bounds() {
  assert_eq!(validate_png_image(67, &[0x89, 0x50, 0x4e, 0x47]).unwrap(), 67);
  assert!(validate_png_image(0, &[0x89, 0x50, 0x4e, 0x47]).is_err());
  assert!(validate_png_image(67, &[0x00, 0x00, 0x00, 0x00]).is_err());
  assert!(validate_png_image(10 * 1024 * 1024 + 1, &[0x89, 0x50, 0x4e, 0x47]).is_err());
}
