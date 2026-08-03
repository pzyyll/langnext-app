// ABOUTME: Fixture tests for the shared OpenAI Responses protocol crate.
// ABOUTME: Ports payload/content/stream/image literals from the TypeScript plugin tests.
use langnext_openai_responses_protocol::*;

#[test]
fn builds_responses_body_with_text_input_and_max_output_tokens() {
  let body = build_responses_body(
    "gpt-5.4-mini",
    "You are an OCR engine.",
    "Extract all text from the image.",
    Some(0.2),
    Some(128000),
    None,
    false,
  );
  assert_eq!(
    body,
    r#"{"model":"gpt-5.4-mini","instructions":"You are an OCR engine.","input":"Extract all text from the image.","stream":false,"temperature":0.2,"max_output_tokens":128000}"#
  );
}

#[test]
fn builds_streaming_body_and_omits_optional_fields() {
  let body = build_responses_body("gpt-5.4-mini", "ocr", "read", None, None, None, true);
  assert_eq!(
    body,
    r#"{"model":"gpt-5.4-mini","instructions":"ocr","input":"read","stream":true}"#
  );
}

#[test]
fn builds_image_body_with_input_image_data_url() {
  let body = build_responses_body("gpt-5.4-mini", "ocr", "read", None, None, Some("abc123"), false);
  assert_eq!(
    body,
    concat!(
      r#"{"model":"gpt-5.4-mini","instructions":"ocr","input":["#,
      r#"{"role":"user","content":[{"type":"input_text","text":"read"},"#,
      r#"{"type":"input_image","image_url":"data:image/png;base64,abc123"}]}],"#,
      r#""stream":false}"#
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
fn parses_output_text_convenience_field_and_stream_deltas() {
  let text = parse_chat_content(br#"{"output_text":"  done  "}"#).unwrap();
  assert_eq!(text, "done");
  let delta = parse_stream_event(br#"{"type":"response.output_text.delta","delta":"hi"}"#, None).unwrap();
  assert_eq!(delta, StreamEventOutcome::Delta("hi".to_string()));
}

#[test]
fn parses_output_array_text_blocks() {
  let text = parse_chat_content(
    br#"{"output":[{"content":[{"type":"output_text","text":"hel"},{"type":"text","text":"lo"}]}]}"#,
  )
  .unwrap();
  assert_eq!(text, "hello");
  assert_eq!(
    parse_chat_content(br#"{"output":[{"content":[{"type":"reasoning","text":"skip"}]}]}"#).unwrap_err().0,
    "responses content is empty"
  );
}

#[test]
fn non_json_delta_stream_event_is_protocol_error() {
  let err = parse_stream_event(b"{not-json", Some("response.output_text.delta")).unwrap_err();
  assert_eq!(err.0, "stream event is not JSON");
}

#[test]
fn lifecycle_stream_events_are_ignored() {
  assert_eq!(
    parse_stream_event(
      br#"{"type":"response.created","response":{"id":"resp_1"}}"#,
      Some("response.created")
    )
    .unwrap(),
    StreamEventOutcome::Ignore
  );
  assert_eq!(
    parse_stream_event(
      br#"{"type":"response.completed","response":{"output_text":"final copy"}}"#,
      Some("response.completed")
    )
    .unwrap(),
    StreamEventOutcome::Ignore
  );
  // Long completed payloads may arrive truncated; content already came via deltas.
  assert_eq!(
    parse_stream_event(br#"{"type":"response.completed","response":{"output_text":"ide-plugins/je"#, Some("response.completed"))
      .unwrap(),
    StreamEventOutcome::Ignore
  );
  assert_eq!(parse_stream_event(b"plain-text-noise", None).unwrap(), StreamEventOutcome::Ignore);
  assert_eq!(parse_stream_event(b"[DONE]", None).unwrap(), StreamEventOutcome::Ignore);
  assert_eq!(parse_stream_event(b"", None).unwrap(), StreamEventOutcome::Ignore);
}

#[test]
fn error_stream_event_surfaces_provider_message() {
  assert_eq!(
    parse_stream_event(
      br#"{"type":"error","code":"rate_limit_exceeded","message":"Rate limit reached for gpt-5.4-mini.","param":null}"#,
      Some("error")
    )
    .unwrap(),
    StreamEventOutcome::Error("Rate limit reached for gpt-5.4-mini.".to_string())
  );
  // Fallback when only a nested code exists.
  assert_eq!(
    parse_stream_event(br#"{"type":"error","error":{"code":"server_error"}}"#, Some("error")).unwrap(),
    StreamEventOutcome::Error("server_error".to_string())
  );
}

#[test]
fn failed_response_stream_event_surfaces_nested_error_message() {
  assert_eq!(
    parse_stream_event(
      br#"{"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"The model failed to generate a response."}}}"#,
      Some("response.failed")
    )
    .unwrap(),
    StreamEventOutcome::Error("The model failed to generate a response.".to_string())
  );
}

#[test]
fn non_json_failure_stream_event_returns_fallback_error() {
  assert_eq!(
    parse_stream_event(b"{broken", Some("error")).unwrap(),
    StreamEventOutcome::Error("Provider stream error".to_string())
  );
  assert_eq!(
    parse_stream_event(b"{broken", Some("response.failed")).unwrap(),
    StreamEventOutcome::Error("Provider stream error".to_string())
  );
}

#[test]
fn nested_delta_text_is_forwarded() {
  // Nested delta.text compatibility applies only to non-delta types; an output_text.delta
  // with a non-string delta is ignored exactly like the current TypeScript plugin.
  assert_eq!(
    parse_stream_event(br#"{"type":"response.output_text.done","delta":{"text":"x"}}"#, None).unwrap(),
    StreamEventOutcome::Delta("x".to_string())
  );
  assert_eq!(
    parse_stream_event(br#"{"type":"response.output_text.delta","delta":{"text":"x"}}"#, None).unwrap(),
    StreamEventOutcome::Ignore
  );
}

#[test]
fn sse_decoder_groups_event_names_and_data_across_frames() {
  let fixture: &[u8] =
    b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"wo\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}\n\ndata: [DONE]\n\n";
  let mut decoder = SseEventDecoder::new();
  let split = fixture.len() / 3;
  let mut events = decoder.feed(&fixture[..split]);
  events.extend(decoder.feed(&fixture[split..]));
  assert_eq!(events.len(), 3);
  assert_eq!(
    events[0].event.as_deref(),
    Some("response.output_text.delta")
  );
  assert_eq!(
    parse_stream_event(&events[0].data, events[0].event.as_deref()).unwrap(),
    StreamEventOutcome::Delta("wo".to_string())
  );
  assert_eq!(events[1].event.as_deref(), Some("response.completed"));
  assert_eq!(
    parse_stream_event(&events[1].data, events[1].event.as_deref()).unwrap(),
    StreamEventOutcome::Ignore
  );
  assert_eq!(events[2].event, None);
  assert_eq!(
    parse_stream_event(&events[2].data, events[2].event.as_deref()).unwrap(),
    StreamEventOutcome::Ignore,
    "DONE"
  );
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
  assert_eq!(validate_png_image(67, &[0x89, 0x50, 0x4e, 0x47]).unwrap(), 67);
  assert!(validate_png_image(0, &[0x89, 0x50, 0x4e, 0x47]).is_err());
  assert!(validate_png_image(67, &[0x00, 0x00, 0x00, 0x00]).is_err());
  assert!(validate_png_image(10 * 1024 * 1024 + 1, &[0x89, 0x50, 0x4e, 0x47]).is_err());
}
