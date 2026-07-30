// ABOUTME: Guest-side golden fixture tests for the Google Translate Web protocol crate.
// ABOUTME: Asserts GTX/proxy response fixtures parse to the expected translated/detected text.
#![cfg(test)]

extern crate alloc;
use langnext_google_translate_web_protocol as protocol;

const GTX_TRANSLATE_FIXTURE: &str =
    include_str!("../../tests/fixtures/gtx-translate-response.json");
const GTX_DETECT_FIXTURE: &str = include_str!("../../tests/fixtures/gtx-detect-response.json");
const PROXY_TRANSLATE_FIXTURE: &str =
    include_str!("../../tests/fixtures/proxy-translate-response.json");

#[test]
fn gtx_translate_fixture_parses_multiline_unicode_with_detected_source() {
    let resp =
        protocol::parse_gtx_translate_response(200, GTX_TRANSLATE_FIXTURE).expect("fixture parses");
    assert_eq!(resp.translated_text, "Hello world 🌍");
    assert_eq!(resp.detected_source_language_id.as_deref(), Some("zh"));
}

#[test]
fn gtx_detect_fixture_parses_to_app_language() {
    let resp =
        protocol::parse_gtx_detect_response(200, GTX_DETECT_FIXTURE).expect("fixture parses");
    assert_eq!(resp.language_id, "zh");
}

#[test]
fn proxy_translate_fixture_parses_data_field() {
    let translated = protocol::parse_proxy_translate_response(200, PROXY_TRANSLATE_FIXTURE)
        .expect("fixture parses");
    assert_eq!(translated, "Hello");
}

#[test]
fn proxy_relative_path_preserves_default_and_custom_urls() {
    let default_path = protocol::extract_proxy_relative_path(br#"{"channel":"https_proxy"}"#)
        .expect("default proxy path");
    assert_eq!(default_path, "translate");

    let custom_path = protocol::extract_proxy_relative_path(
        br#"{"channel":"https_proxy","proxy-url":"https://proxy.example/v1/translate"}"#,
    )
    .expect("custom proxy path");
    assert_eq!(custom_path, "v1/translate");
}

#[test]
fn gtx_query_relative_path_targets_single_endpoint() {
    let path = protocol::gtx_relative_path("auto", "en", "Hello world");
    assert!(path.starts_with(
        "translate_a/single?client=gtx&sl=auto&tl=en&hl=en&dt=t&ie=UTF-8&oe=UTF-8&q="
    ));
    assert!(
        path.contains("Hello%20world"),
        "query text must be percent-encoded: {path}"
    );
    // The relative path targets exactly the pinned GTX endpoint alias and no other origin.
    assert!(
        !path.contains("://") && !path.contains('#'),
        "path must stay confined: {path}"
    );
}
