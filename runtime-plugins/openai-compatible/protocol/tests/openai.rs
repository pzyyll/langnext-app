// ABOUTME: Fixture tests for the shared OpenAI Compatible protocol crate.
// ABOUTME: Ports payload/content/stream/image literals from the TypeScript plugin tests.
use langnext_openai_compatible_protocol::*;

#[test]
fn builds_chat_completions_body_with_fixture_key_order() {
  let body = build_chat_completions(
    "gpt-4o-mini",
    &[
      ("system".to_string(), "sys".to_string()),
      ("user".to_string(), "hello".to_string()),
    ],
    Some(0.2),
    Some(128),
    None,
    false,
  );
  assert_eq!(
    body,
    r#"{"model":"gpt-4o-mini","messages":[{"role":"system","content":"sys"},{"role":"user","content":"hello"}],"stream":false,"temperature":0.2,"max_tokens":128}"#
  );
}

#[test]
fn builds_streaming_body_and_omits_optional_fields() {
  let body = build_chat_completions(
    "gpt-4o-mini",
    &[("user".to_string(), "hello".to_string())],
    None,
    None,
    None,
    true,
  );
  assert_eq!(
    body,
    r#"{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}],"stream":true}"#
  );
}

#[test]
fn builds_image_body_with_base64_data_url() {
  const FIXED_PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGIAAQAABQABDQottAAAAABJRU5ErkJggg==";
  let body = build_chat_completions(
    "gpt-4o-mini",
    &[
      ("system".to_string(), "sys".to_string()),
      ("user".to_string(), "What is in this image?".to_string()),
    ],
    None,
    None,
    Some(FIXED_PNG_BASE64),
    false,
  );
  assert_eq!(
    body,
    concat!(
      r#"{"model":"gpt-4o-mini","messages":[{"role":"system","content":"sys"},"#,
      r#"{"role":"user","content":[{"type":"text","text":"What is in this image?"},"#,
      r#"{"type":"image_url","image_url":{"url":"data:image/png;base64,"#,
      r#"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGIAAQAABQABDQottAAAAABJRU5ErkJggg=="#,
      r#""}}]}],"stream":false}"#
    )
  );
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
fn parses_chat_content_with_trimming() {
  let text = parse_chat_content(br#"{"choices":[{"message":{"content":"  hi  "}}]}"#).unwrap();
  assert_eq!(text, "hi");
  assert_eq!(parse_chat_content(br#"{"choices":[{"message":{"content":"a\nb"}}]}"#).unwrap(), "a\nb");
}

#[test]
fn chat_content_errors_match_provider_fixtures() {
  for (body, expected) in [
    (br#"not-json"#.as_slice(), "chat response is not JSON"),
    (br#"{"choices":[]}"#.as_slice(), "chat response missing choices"),
    (br#"{"choices":[{}]}"#.as_slice(), "chat response missing message"),
    (br#"{"choices":[{"message":{}}]}"#.as_slice(), "chat response missing content"),
    (br#"{"choices":[{"message":{"content":42}}]}"#.as_slice(), "chat response missing content"),
    (br#"{"choices":[{"message":{"content":"   "}}]}"#.as_slice(), "chat content is empty"),
  ] {
    let err = parse_chat_content(body).unwrap_err();
    assert_eq!(err.0, expected, "body: {}", String::from_utf8_lossy(body));
  }
}

#[test]
fn parses_models_page_like_current_provider() {
  let models = parse_models_page(br#"{"data":[{"id":"gpt-4o-mini"},{"id":"gpt-4o"}]}"#).unwrap();
  assert_eq!(models, vec!["gpt-4o-mini".to_string(), "gpt-4o".to_string()]);
  let models = parse_models_page(br#"{"data":[{"id":"  gpt-4o  "}]}"#).unwrap();
  assert_eq!(models, vec!["gpt-4o".to_string()]);
}

#[test]
fn models_page_errors_fail_closed() {
  assert_eq!(
    parse_models_page(b"not-json").unwrap_err().0,
    "model list is not JSON"
  );
  assert_eq!(
    parse_models_page(br#"{"data":42}"#).unwrap_err().0,
    "model list missing data array"
  );
  assert_eq!(
    parse_models_page(br#"{"data":[{}]}"#).unwrap_err().0,
    "model list entry missing id"
  );
  assert_eq!(
    parse_models_page(br#"{"data":[{"id":"   "}]}"#).unwrap_err().0,
    "invalid model key"
  );
  let mut oversized = String::from(r#"{"data":["#);
  for index in 0..501 {
    if index > 0 {
      oversized.push(',');
    }
    oversized.push_str(&format!(r#"{{"id":"model-{index}"}}"#));
  }
  oversized.push_str("]}");
  assert_eq!(
    parse_models_page(oversized.as_bytes()).unwrap_err().0,
    "model list page too large"
  );
}

#[test]
fn parses_stream_deltas_like_current_provider() {
  let delta = parse_stream_event_data(br#"{"choices":[{"delta":{"content":"wo"}}]}"#).unwrap();
  assert_eq!(delta.as_deref(), Some("wo"));
  assert_eq!(parse_stream_event_data(b"[DONE]").unwrap(), None);
  assert_eq!(parse_stream_event_data(b"").unwrap(), None);
  assert_eq!(
    parse_stream_event_data(br#"{"choices":[{"delta":{}}]}"#).unwrap(),
    None
  );
  assert_eq!(
    parse_stream_event_data(br#"{"choices":[{"delta":{"content":""}}]}"#).unwrap(),
    None
  );
  assert_eq!(
    parse_stream_event_data(br#"not-json"#).unwrap_err().0,
    "stream event is not JSON"
  );
}

#[test]
fn sse_decoder_groups_data_lines_across_frames() {
  let fixture: &[u8] = b"data: {\"choices\":[{\"delta\":{\"content\":\"wo\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"rld\"}}]}\n\ndata: [DONE]\n\n";
  let mut decoder = SseDecoder::new();
  // Split the fixture mid-line to prove incremental framing works.
  let split = fixture.len() / 3;
  let mut events = decoder.feed(&fixture[..split]);
  events.extend(decoder.feed(&fixture[split..]));
  assert_eq!(events.len(), 3);
  assert_eq!(
    parse_stream_event_data(&events[0]).unwrap().as_deref(),
    Some("wo")
  );
  assert_eq!(
    parse_stream_event_data(&events[1]).unwrap().as_deref(),
    Some("rld")
  );
  assert_eq!(parse_stream_event_data(&events[2]).unwrap(), None, "DONE");
  assert!(decoder.feed(b"").is_empty());
}

#[test]
fn parses_host_preference_envelope() {
  let preferences =
    parse_preferences(br#"{"stream":false,"temperature":0.2,"maxTokens":128,"thinking":false}"#).unwrap();
  assert_eq!(
    preferences,
    LlmPreferences {
      stream: false,
      temperature: Some(0.2),
      max_tokens: Some(128),
    }
  );
  let streaming = parse_preferences(br#"{"stream":true}"#).unwrap();
  assert_eq!(
    streaming,
    LlmPreferences {
      stream: true,
      temperature: None,
      max_tokens: None,
    }
  );
  assert!(parse_preferences(br#"{}"#).is_err());
  assert!(parse_preferences(b"not-json").is_err());
}

#[test]
fn maps_provider_status_to_bounded_codes() {
  assert_eq!(provider_status_error(200), None);
  assert_eq!(provider_status_error(204), None);
  assert_eq!(provider_status_error(401), Some(ProviderStatusError::Auth));
  assert_eq!(provider_status_error(403), Some(ProviderStatusError::Auth));
  assert_eq!(provider_status_error(429), Some(ProviderStatusError::RateLimited));
  assert_eq!(provider_status_error(500), Some(ProviderStatusError::Server));
  assert_eq!(provider_status_error(400), Some(ProviderStatusError::Client));
}

#[test]
fn validates_png_image_bounds() {
  assert_eq!(
    validate_png_image(67, &[0x89, 0x50, 0x4e, 0x47]).unwrap(),
    67
  );
  assert!(validate_png_image(0, &[0x89, 0x50, 0x4e, 0x47]).is_err());
  assert!(validate_png_image(67, &[0x00, 0x00, 0x00, 0x00]).is_err());
  assert!(validate_png_image(10 * 1024 * 1024 + 1, &[0x89, 0x50, 0x4e, 0x47]).is_err());
}
