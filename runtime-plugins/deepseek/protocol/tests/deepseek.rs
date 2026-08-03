// ABOUTME: Fixture tests for the shared DeepSeek protocol crate.
// ABOUTME: Ports payload/thinking/content/stream literals from the TypeScript plugin tests.
use langnext_deepseek_protocol::*;

#[test]
fn builds_chat_completions_body_with_thinking_policy() {
  let messages = vec![
    ("system".to_string(), "sys".to_string()),
    ("user".to_string(), "hi".to_string()),
  ];
  let body = build_chat_completions(
    "deepseek-chat",
    &messages,
    Some(0.0),
    Some(2048),
    None,
    false,
    false,
  );
  assert_eq!(
    body,
    r#"{"model":"deepseek-chat","messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"}],"stream":false,"temperature":0,"max_tokens":2048,"thinking":{"type":"disabled"}}"#
  );
  let enabled = build_chat_completions("deepseek-chat", &messages, None, None, None, false, true);
  assert_eq!(
    enabled,
    r#"{"model":"deepseek-chat","messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"}],"stream":false,"thinking":{"type":"enabled"}}"#
  );
  let streamed = build_chat_completions("deepseek-chat", &messages, Some(0.0), Some(2048), None, true, false);
  assert_eq!(
    streamed,
    r#"{"model":"deepseek-chat","messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"}],"stream":true,"temperature":0,"max_tokens":2048,"thinking":{"type":"disabled"}}"#
  );
}

#[test]
fn builds_image_body_with_base64_data_url() {
  let messages = vec![
    ("system".to_string(), "sys".to_string()),
    ("user".to_string(), "What is in this image?".to_string()),
  ];
  let body = build_chat_completions(
    "deepseek-chat",
    &messages,
    Some(0.0),
    Some(2048),
    Some("iVBORw0KGgo"),
    false,
    false,
  );
  assert_eq!(
    body,
    r#"{"model":"deepseek-chat","messages":[{"role":"system","content":"sys"},{"role":"user","content":[{"type":"text","text":"What is in this image?"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo"}}]}],"stream":false,"temperature":0,"max_tokens":2048,"thinking":{"type":"disabled"}}"#
  );
}

#[test]
fn parses_models_page_and_rejects_bad_pages() {
  let models = parse_models_page(br#"{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}"#).unwrap();
  assert_eq!(models, vec!["deepseek-chat".to_string(), "deepseek-reasoner".to_string()]);
  for (body, expected) in [
    (br#"not-json"#.as_slice(), "model list is not JSON"),
    (br#"{"data":42}"#.as_slice(), "model list missing data array"),
    (br#"{"data":[{}]}"#.as_slice(), "model list entry missing id"),
    (br#"{"data":[{"id":"   "}]}"#.as_slice(), "invalid model key"),
  ] {
    let err = parse_models_page(body).unwrap_err();
    assert_eq!(err.0, expected, "body: {}", String::from_utf8_lossy(body));
  }
  let mut oversized = String::from(r#"{"data":["#);
  for index in 0..501 {
    if index > 0 {
      oversized.push(',');
    }
    oversized.push_str(&format!(r#"{{"id":"model-{index}"}}"#));
  }
  oversized.push_str(r#"]}"#);
  assert_eq!(parse_models_page(oversized.as_bytes()).unwrap_err().0, "model list page too large");
}

#[test]
fn parses_content_and_stream_deltas() {
  let text = parse_chat_content(br#"{"choices":[{"message":{"content":"  hi  "}}]}"#).unwrap();
  assert_eq!(text, "hi");
  assert_eq!(parse_stream_event_data(b"data: x").unwrap_err().0, "stream event is not JSON");
  let delta = parse_stream_event_data(br#"{"choices":[{"delta":{"content":"wo"}}]}"#).unwrap();
  assert_eq!(delta, Some("wo".to_string()));
  assert_eq!(parse_stream_event_data(b"[DONE]").unwrap(), None);
  assert_eq!(parse_stream_event_data(br#"{"choices":[{"delta":{"content":""}}]}"#).unwrap(), None);
  assert_eq!(parse_stream_event_data(br#"{"choices":[{"delta":{}}]}"#).unwrap(), None);
  assert_eq!(parse_stream_event_data(b"").unwrap(), None);
}

#[test]
fn chat_content_errors_match_provider_fixtures() {
  for (body, expected) in [
    (br#"not-json"#.as_slice(), "chat response is not JSON"),
    (br#"{"choices":[]}"#.as_slice(), "chat response missing choices"),
    (br#"{"choices":[{"message":{}}]}"#.as_slice(), "chat response missing content"),
    (br#"{"choices":[{"message":{"content":""}}]}"#.as_slice(), "chat content is empty"),
  ] {
    let err = parse_chat_content(body).unwrap_err();
    assert_eq!(err.0, expected, "body: {}", String::from_utf8_lossy(body));
  }
}

#[test]
fn sse_decoder_groups_data_lines_across_frames() {
  let fixture: &[u8] = b"data: {\"choices\":[{\"delta\":{\"content\":\"wo\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"rld\"}}]}\n\ndata: [DONE]\n\n";
  let mut decoder = SseDecoder::new();
  let split = fixture.len() / 3;
  let mut events = decoder.feed(&fixture[..split]);
  events.extend(decoder.feed(&fixture[split..]));
  assert_eq!(events.len(), 3);
  assert_eq!(parse_stream_event_data(&events[0]).unwrap(), Some("wo".to_string()));
  assert_eq!(parse_stream_event_data(&events[1]).unwrap(), Some("rld".to_string()));
  assert_eq!(parse_stream_event_data(&events[2]).unwrap(), None);
  assert!(decoder.feed(b"").is_empty());
}

#[test]
fn parses_host_preference_envelope_with_thinking() {
  let preferences = parse_preferences(br#"{"stream":false,"temperature":0,"maxTokens":2048,"thinking":false}"#).unwrap();
  assert_eq!(
    preferences,
    LlmPreferences {
      stream: false,
      temperature: Some(0.0),
      max_tokens: Some(2048),
      thinking: false,
    }
  );
  let enabled = parse_preferences(br#"{"stream":true,"thinking":true}"#).unwrap();
  assert_eq!(
    enabled,
    LlmPreferences {
      stream: true,
      temperature: None,
      max_tokens: None,
      thinking: true,
    }
  );
  assert!(parse_preferences(br#"{}"#).is_err());
  assert!(parse_preferences(br#"{"stream":false}"#).is_err());
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
  assert_eq!(base64_encode(b"abc"), "YWJj");
}

#[test]
fn detection_defaults_match_the_current_plugin() {
  // The host-interpreted detection metadata projected from the signed manifest.
  assert_eq!(DETECT_MAX_TOKENS, 2048);
}

#[test]
fn validates_png_image_bounds() {
  assert_eq!(validate_png_image(67, &[0x89, 0x50, 0x4e, 0x47]).unwrap(), 67);
  assert!(validate_png_image(0, &[0x89, 0x50, 0x4e, 0x47]).is_err());
  assert!(validate_png_image(67, &[0x00, 0x00, 0x00, 0x00]).is_err());
  assert!(validate_png_image(10 * 1024 * 1024 + 1, &[0x89, 0x50, 0x4e, 0x47]).is_err());
}
