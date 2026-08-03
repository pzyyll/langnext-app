// ABOUTME: Fixture tests for the shared Anthropic protocol crate.
// ABOUTME: Ports payload/content/stream/image literals from the TypeScript plugin tests.
use langnext_anthropic_protocol::*;

#[test]
fn builds_messages_body_with_version_header_and_default_max_tokens() {
  let body = build_messages_body(
    "claude-3-5-haiku",
    "sys",
    "hi",
    Some(0.1),
    None,
    None,
    true,
  );
  assert_eq!(
    body,
    r#"{"model":"claude-3-5-haiku","system":"sys","messages":[{"role":"user","content":"hi"}],"max_tokens":32768,"stream":true,"temperature":0.1}"#
  );
  assert_eq!(ANTHROPIC_VERSION, "2023-06-01");
  assert_eq!(ANTHROPIC_VERSION_HEADER, "anthropic-version");
}

#[test]
fn builds_unary_body_and_omits_stream() {
  let body = build_messages_body("claude-3-5-haiku", "sys", "hi", None, Some(64), None, false);
  assert_eq!(
    body,
    r#"{"model":"claude-3-5-haiku","system":"sys","messages":[{"role":"user","content":"hi"}],"max_tokens":64}"#
  );
}

#[test]
fn builds_image_body_with_base64_source_block() {
  let body = build_messages_body("claude-3-5-haiku", "sys", "read", None, None, Some("abc123"), false);
  assert_eq!(
    body,
    concat!(
      r#"{"model":"claude-3-5-haiku","system":"sys","messages":[{"role":"user","content":["#,
      r#"{"type":"image","source":{"type":"base64","media_type":"image/png","data":"abc123"}},"#,
      r#"{"type":"text","text":"read"}]}],"max_tokens":32768}"#
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
fn parses_model_page_continuation_from_last_id() {
  let page = parse_models_page(
    br#"{"data":[{"id":"claude-3-5-haiku","display_name":"Haiku"}],"has_more":true,"first_id":"a","last_id":"cursor-1"}"#,
  )
  .unwrap();
  assert_eq!(
    page,
    ModelsPage {
      items: vec![("claude-3-5-haiku".to_string(), Some("Haiku".to_string()))],
      continuation: Some("cursor-1".to_string()),
    }
  );
  let last = parse_models_page(
    br#"{"data":[{"id":"claude-3-opus","display_name":null}],"has_more":false,"last_id":null}"#,
  )
  .unwrap();
  assert_eq!(
    last,
    ModelsPage {
      items: vec![("claude-3-opus".to_string(), None)],
      continuation: None,
    }
  );
}

#[test]
fn model_page_errors_fail_closed() {
  for (body, expected) in [
    (br#"not-json"#.as_slice(), "anthropic model list is not JSON"),
    (br#"{"data":42}"#.as_slice(), "anthropic model list missing data"),
    (br#"{"data":[{}]}"#.as_slice(), "anthropic model missing id"),
    (br#"{"data":[{"id":"x"}],"has_more":"yes"}"#.as_slice(), "anthropic model list missing has_more"),
    (
      br#"{"data":[],"has_more":true}"#.as_slice(),
      "anthropic continuation missing last_id",
    ),
    (br#"{"data":[{"id":"   "}],"has_more":false}"#.as_slice(), "invalid model key"),
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
  oversized.push_str(r#"],"has_more":false}"#);
  assert_eq!(
    parse_models_page(oversized.as_bytes()).unwrap_err().0,
    "anthropic model list page too large"
  );
}

#[test]
fn parses_content_and_stream_text_deltas() {
  let text = parse_chat_content(br#"{"content":[{"type":"text","text":"hello"}]}"#).unwrap();
  assert_eq!(text, "hello");
  // Blocks without a type default to text; joined and trimmed like the current plugin.
  let text = parse_chat_content(br#"{"content":[{"text":"  hel"},{"type":"text","text":"lo  "}]}"#).unwrap();
  assert_eq!(text, "hello");
  let delta = parse_stream_event(
    br#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"wo"}}"#,
    Some("content_block_delta"),
  )
  .unwrap();
  assert_eq!(delta, StreamEventOutcome::Delta("wo".to_string()));
  let delta = parse_stream_event(br#"{"type":"content_block_delta","delta":{"type":"text","text":"rld"}}"#, None).unwrap();
  assert_eq!(delta, StreamEventOutcome::Delta("rld".to_string()));
}

#[test]
fn chat_content_errors_match_provider_fixtures() {
  for (body, expected) in [
    (br#"not-json"#.as_slice(), "anthropic response is not JSON"),
    (br#"{"content":"nope"}"#.as_slice(), "anthropic response missing content"),
    (br#"{"content":[]}"#.as_slice(), "anthropic content is empty"),
    (br#"{"content":[{"type":"text","text":""}]}"#.as_slice(), "anthropic content is empty"),
    (br#"{"content":[{"type":"image","source":{}}]}"#.as_slice(), "anthropic content is empty"),
  ] {
    let err = parse_chat_content(body).unwrap_err();
    assert_eq!(err.0, expected, "body: {}", String::from_utf8_lossy(body));
  }
}

#[test]
fn stream_events_ignore_lifecycle_and_non_deltas() {
  assert_eq!(
    parse_stream_event(
      br#"{"type":"message_start","message":{"id":"msg_1","content":[],"role":"assistant","model":"claude-3-5-haiku"}}"#,
      Some("message_start")
    )
    .unwrap(),
    StreamEventOutcome::Ignore
  );
  assert_eq!(
    parse_stream_event(br#"{"type":"message_stop"}"#, Some("message_stop")).unwrap(),
    StreamEventOutcome::Ignore
  );
  assert_eq!(
    parse_stream_event(
      br#"{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"role\":\"user\"}"}}"#,
      None,
    )
    .unwrap(),
    StreamEventOutcome::Ignore
  );
  assert_eq!(
    parse_stream_event(br#"{"type":"content_block_delta","delta":{"type":"text_delta"}}"#, None).unwrap(),
    StreamEventOutcome::Ignore
  );
  assert_eq!(parse_stream_event(b"", None).unwrap(), StreamEventOutcome::Ignore);
  // Anthropic never sends `[DONE]`; a non-JSON data payload is a stable error like the
  // current TypeScript plugin.
  assert_eq!(
    parse_stream_event(b"[DONE]", None).unwrap_err().0,
    "stream event is not JSON"
  );
  assert_eq!(parse_stream_event(b"42", None).unwrap(), StreamEventOutcome::Ignore, "non-object JSON");
  assert_eq!(
    parse_stream_event(b"{broken", Some("content_block_delta")).unwrap_err().0,
    "stream event is not JSON"
  );
}

#[test]
fn sse_decoder_groups_event_names_and_data_across_frames() {
  let fixture: &[u8] = b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"wo\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
  let mut decoder = SseEventDecoder::new();
  let split = fixture.len() / 3;
  let mut events = decoder.feed(&fixture[..split]);
  events.extend(decoder.feed(&fixture[split..]));
  assert_eq!(events.len(), 3);
  assert_eq!(events[0].event.as_deref(), Some("message_start"));
  assert_eq!(
    parse_stream_event(&events[0].data, events[0].event.as_deref()).unwrap(),
    StreamEventOutcome::Ignore
  );
  assert_eq!(events[1].event.as_deref(), Some("content_block_delta"));
  assert_eq!(
    parse_stream_event(&events[1].data, events[1].event.as_deref()).unwrap(),
    StreamEventOutcome::Delta("wo".to_string())
  );
  assert_eq!(events[2].event.as_deref(), Some("message_stop"));
  assert_eq!(
    parse_stream_event(&events[2].data, events[2].event.as_deref()).unwrap(),
    StreamEventOutcome::Ignore
  );
  assert!(decoder.feed(b"").is_empty());
}

#[test]
fn parses_host_preference_envelope() {
  let preferences =
    parse_preferences(br#"{"stream":false,"temperature":0.1,"thinking":false}"#).unwrap();
  assert_eq!(
    preferences,
    LlmPreferences {
      stream: false,
      temperature: Some(0.1),
      max_tokens: None,
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
  assert_eq!(validate_png_image(67, &[0x89, 0x50, 0x4e, 0x47]).unwrap(), 67);
  assert!(validate_png_image(0, &[0x89, 0x50, 0x4e, 0x47]).is_err());
  assert!(validate_png_image(67, &[0x00, 0x00, 0x00, 0x00]).is_err());
  assert!(validate_png_image(10 * 1024 * 1024 + 1, &[0x89, 0x50, 0x4e, 0x47]).is_err());
}
