// ABOUTME: Shared no-std Google Translate Web protocol: language mapping, GTX query/body
// ABOUTME: construction, nested-array response parsing, proxy parsing, and error normalization.
#![no_std]

extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

/// Maximum translated/detected text byte length the host accepts (mirrors host constant).
pub const CAPABILITY_TEXT_MAX_BYTES: usize = 30 * 1024;
/// Stricter response body cap for free-text GTX/proxy calls (bytes).
pub const MAX_RESPONSE_BODY_BYTES: usize = 256 * 1024;
/// GTX relative path under translate.google.com.
pub const GTX_RELATIVE_PATH: &str = "translate_a/single";
/// Default third-party HTTPS proxy URL preserved from the bundled Rust implementation.
pub const DEFAULT_PROXY_URL: &str = "https://googlet.deno.dev/translate";
/// GTX client query value (unofficial free endpoint).
pub const GTX_CLIENT: &str = "gtx";
/// GTX text encoding query values.
pub const GTX_ENCODING: &str = "UTF-8";
/// GTX `dt` value requesting translation segments.
pub const GTX_DT: &str = "t";
/// Max translated segment count accepted from a GTX payload.
const GTX_MAX_SEGMENTS: usize = 512;
/// Minimum outer-array length required to read the detected-language slot.
const GTX_DETECT_MIN_OUTER_LEN: usize = 3;
/// Documented outer-array index of the detected language code.
const GTX_DETECT_LANGUAGE_INDEX: usize = 2;

/// App-supported language ids (mirrors host `SUPPORTED_LANGUAGES`).
pub const SUPPORTED_LANGUAGES: &[&str] = &[
    "zh", "en", "ar", "bg", "bn", "cs", "da", "de", "el", "es", "fa", "fi", "fr", "he", "hi", "hr",
    "hu", "id", "it", "ja", "ko", "lt", "lv", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl",
    "sr", "sv", "sw", "ta", "th", "tl", "tr", "uk", "ur", "vi",
];

/// Normalized protocol failure. The guest maps each variant to the matching WIT `plugin-error`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidRequest(String),
    InvalidConfiguration,
    InvalidInput(String),
    PermissionDenied,
    RateLimited,
    UnsupportedLanguage(String),
    Network(String),
    Timeout,
    InvalidResponse(String),
    ProviderUnavailable,
    Cancelled,
    Internal(String),
}

/// Resolved translation channel read from copied config JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Gtx,
    HttpsProxy,
}

/// GTX/proxy translate response (translated text + optional detected source language).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslateResponse {
    pub translated_text: String,
    pub detected_source_language_id: Option<String>,
}

/// GTX detect response (app language id, no confidence from the free endpoint).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectResponse {
    pub language_id: String,
}

/// Map application language id -> Google BCP-47 code. Mirrors host `app_language_to_google`.
pub fn app_language_to_google(app_id: &str) -> Option<&'static str> {
    let id = app_id.trim().to_ascii_lowercase();
    match id.as_str() {
        "zh" => Some("zh-CN"),
        "no" => Some("nb"),
        "tl" => Some("fil"),
        other => SUPPORTED_LANGUAGES.iter().copied().find(|c| *c == other),
    }
}

/// Map Google language code -> application language id. Mirrors host `google_language_to_app`.
pub fn google_language_to_app(google_code: &str) -> Option<&'static str> {
    let lower = google_code.trim().to_ascii_lowercase();
    match lower.as_str() {
        "zh" | "zh-cn" | "zh-hans" => Some("zh"),
        "zh-tw" | "zh-hant" => Some("zh"),
        "nb" | "nn" | "no" => Some("no"),
        "fil" | "tl" => Some("tl"),
        "iw" => Some("he"),
        other => {
            let base = other.split('-').next().unwrap_or(other);
            SUPPORTED_LANGUAGES.iter().copied().find(|c| *c == base)
        }
    }
}

/// Resolve a GTX source language token ("auto"/"" -> "auto").
pub fn gtx_source_language(source_language_id: &str) -> Result<&'static str, ProtocolError> {
    if source_language_id.is_empty() || source_language_id == "auto" {
        return Ok("auto");
    }
    app_language_to_google(source_language_id)
        .ok_or_else(|| ProtocolError::UnsupportedLanguage(source_language_id.to_string()))
}

/// Resolve a proxy source language token ("auto"/"" -> "auto").
pub fn proxy_source_language(source_language_id: &str) -> Result<&'static str, ProtocolError> {
    gtx_source_language(source_language_id)
}

/// Read the `channel` field from copied config JSON bytes. Defaults to `gtx` when absent.
pub fn extract_channel(config: &[u8]) -> Channel {
    let s = match core::str::from_utf8(config) {
        Ok(s) => s,
        Err(_) => return Channel::Gtx,
    };
    let value: Value = match serde_json::from_str(s) {
        Ok(v) => v,
        Err(_) => return Channel::Gtx,
    };
    match value.get("channel").and_then(Value::as_str) {
        Some("https_proxy") => Channel::HttpsProxy,
        _ => Channel::Gtx,
    }
}

/// Read the normalized proxy URL path from copied config, preserving the bundled default.
/// The host validates the complete HTTPS URL and pins its effective origin in the grant.
pub fn extract_proxy_relative_path(config: &[u8]) -> Result<String, ProtocolError> {
    let value: Value =
        serde_json::from_slice(config).map_err(|_| ProtocolError::InvalidConfiguration)?;
    let proxy_url = value
        .get("proxy-url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_PROXY_URL);
    let authority_and_path = proxy_url
        .strip_prefix("https://")
        .ok_or(ProtocolError::InvalidConfiguration)?;
    let relative_path = authority_and_path
        .find('/')
        .map(|index| &authority_and_path[index + 1..])
        .unwrap_or(".");
    let relative_path = relative_path.trim_matches('/');
    if relative_path.is_empty() {
        Ok(String::from("."))
    } else {
        Ok(String::from(relative_path))
    }
}

/// Build the GTX GET relative path with query string for a translate/detect request.
/// Query values are percent-encoded so the host can append the raw string to the origin URL.
pub fn gtx_relative_path(source: &str, target: &str, text: &str) -> String {
    let mut pairs: Vec<(&str, &str)> = Vec::with_capacity(8);
    pairs.push(("client", GTX_CLIENT));
    pairs.push(("sl", source));
    pairs.push(("tl", target));
    pairs.push(("hl", target));
    pairs.push(("dt", GTX_DT));
    pairs.push(("ie", GTX_ENCODING));
    pairs.push(("oe", GTX_ENCODING));
    pairs.push(("q", text));
    let mut out = String::from(GTX_RELATIVE_PATH);
    out.push('?');
    let mut first = true;
    for (k, v) in &pairs {
        if !first {
            out.push('&');
        }
        first = false;
        out.push_str(k);
        out.push('=');
        percent_encode_into(v, &mut out);
    }
    out
}

/// Build the proxy POST JSON body `{ "text": ..., "source_lang": ..., "target_lang": ... }`.
pub fn proxy_request_body(text: &str, source: &str, target: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
      "text": text,
      "source_lang": source,
      "target_lang": target,
    }))
    .unwrap_or_else(|_| b"{}".to_vec())
}

/// Map free-endpoint HTTP status to protocol errors (no Cloud auth codes).
pub fn map_web_http_error(status: u16) -> Result<(), ProtocolError> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    match status {
        429 => Err(ProtocolError::RateLimited),
        400 => Err(ProtocolError::InvalidRequest(
            "Google Web rejected the request".into(),
        )),
        500..=599 => Err(ProtocolError::ProviderUnavailable),
        _ => Err(ProtocolError::ProviderUnavailable),
    }
}

/// Parse GTX nested-array translate response; join segments in order.
pub fn parse_gtx_translate_response(
    status: u16,
    body: &str,
) -> Result<TranslateResponse, ProtocolError> {
    map_web_http_error(status)?;
    if body.len() > MAX_RESPONSE_BODY_BYTES {
        return Err(ProtocolError::InvalidResponse(
            "response body exceeds size limit".into(),
        ));
    }
    let root: Value = serde_json::from_str(body)
        .map_err(|_| ProtocolError::InvalidResponse("translate response was malformed".into()))?;
    let outer = root
        .as_array()
        .ok_or_else(|| ProtocolError::InvalidResponse("translate response was malformed".into()))?;
    let segments = outer.first().and_then(Value::as_array).ok_or_else(|| {
        ProtocolError::InvalidResponse("translate response missing segments".into())
    })?;

    let mut parts: Vec<String> = Vec::new();
    for (idx, segment) in segments.iter().enumerate() {
        if idx >= GTX_MAX_SEGMENTS {
            return Err(ProtocolError::InvalidResponse(
                "translate response has too many segments".into(),
            ));
        }
        let arr = segment.as_array().ok_or_else(|| {
            ProtocolError::InvalidResponse("translate segment was malformed".into())
        })?;
        let text = arr.first().and_then(Value::as_str).ok_or_else(|| {
            ProtocolError::InvalidResponse("translate segment missing text".into())
        })?;
        if !text.is_empty() {
            parts.push(text.to_string());
        }
    }
    if parts.is_empty() {
        return Err(ProtocolError::InvalidResponse(
            "translate response contained no text".into(),
        ));
    }
    let translated_text = parts.join("");
    if translated_text.len() > CAPABILITY_TEXT_MAX_BYTES {
        return Err(ProtocolError::InvalidResponse(
            "translated text exceeds size limit".into(),
        ));
    }

    let detected = extract_gtx_detected_language(outer)
        .and_then(|code| google_language_to_app(&code).map(|s| s.to_string()));

    Ok(TranslateResponse {
        translated_text,
        detected_source_language_id: detected,
    })
}

/// Parse GTX detect response from the documented outer-array language slot.
pub fn parse_gtx_detect_response(status: u16, body: &str) -> Result<DetectResponse, ProtocolError> {
    map_web_http_error(status)?;
    if body.len() > MAX_RESPONSE_BODY_BYTES {
        return Err(ProtocolError::InvalidResponse(
            "response body exceeds size limit".into(),
        ));
    }
    let root: Value = serde_json::from_str(body)
        .map_err(|_| ProtocolError::InvalidResponse("detect response was malformed".into()))?;
    let outer = root
        .as_array()
        .ok_or_else(|| ProtocolError::InvalidResponse("detect response was malformed".into()))?;
    let code = extract_gtx_detected_language(outer)
        .ok_or_else(|| ProtocolError::InvalidResponse("detect response missing language".into()))?;
    let language_id = google_language_to_app(&code).ok_or_else(|| {
        ProtocolError::UnsupportedLanguage("detected language is outside the app contract".into())
    })?;
    Ok(DetectResponse {
        language_id: language_id.to_string(),
    })
}

/// Parse bounded proxy `{ "data": string }` response into translated text.
pub fn parse_proxy_translate_response(status: u16, body: &str) -> Result<String, ProtocolError> {
    map_web_http_error(status)?;
    if body.len() > MAX_RESPONSE_BODY_BYTES {
        return Err(ProtocolError::InvalidResponse(
            "response body exceeds size limit".into(),
        ));
    }
    let root: Value = serde_json::from_str(body)
        .map_err(|_| ProtocolError::InvalidResponse("proxy response was malformed".into()))?;
    let data = root
        .get("data")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| {
            ProtocolError::InvalidResponse("proxy response missing data string".into())
        })?;
    if data.is_empty() {
        return Err(ProtocolError::InvalidResponse(
            "proxy response data is empty".into(),
        ));
    }
    if data.len() > CAPABILITY_TEXT_MAX_BYTES {
        return Err(ProtocolError::InvalidResponse(
            "translated text exceeds size limit".into(),
        ));
    }
    Ok(data)
}

fn extract_gtx_detected_language(outer: &[Value]) -> Option<String> {
    if outer.len() < GTX_DETECT_MIN_OUTER_LEN {
        return None;
    }
    outer
        .get(GTX_DETECT_LANGUAGE_INDEX)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Percent-encode a query value per RFC 3986 unreserved set (A-Za-z0-9-._~). All other bytes
/// become `%XX` uppercase hex. Used so the host can append the raw encoded value to the URL.
fn percent_encode_into(input: &str, out: &mut String) {
    for &b in input.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => {
                out.push('%');
                out.push(hex_upper(b >> 4));
                out.push(hex_upper(b & 0x0f));
            }
        }
    }
}

fn hex_upper(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'A' + (n - 10)) as char,
        _ => '0',
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use alloc::format;

    #[test]
    fn gtx_parses_multiline_unicode_segments() {
        let body =
            r#"[[["Hello ","你好",null,null,10],["world 🌍","世界 🌍",null,null,10]],null,"zh"]"#;
        let resp = parse_gtx_translate_response(200, body).unwrap();
        assert_eq!(resp.translated_text, "Hello world 🌍");
        assert_eq!(resp.detected_source_language_id.as_deref(), Some("zh"));
    }

    #[test]
    fn gtx_rejects_malformed_and_empty() {
        assert!(matches!(
            parse_gtx_translate_response(200, r#"{"not":"array"}"#).unwrap_err(),
            ProtocolError::InvalidResponse(_)
        ));
        assert!(matches!(
            parse_gtx_translate_response(200, r#"[[],null,"en"]"#).unwrap_err(),
            ProtocolError::InvalidResponse(_)
        ));
        assert!(matches!(
            parse_gtx_translate_response(200, "not-json").unwrap_err(),
            ProtocolError::InvalidResponse(_)
        ));
    }

    #[test]
    fn gtx_rejects_malformed_segments_fail_closed() {
        let err =
            parse_gtx_translate_response(200, r#"[[["Hello","x",null,null,1],"bad"],null,"en"]"#)
                .unwrap_err();
        assert!(matches!(err, ProtocolError::InvalidResponse(_)));
        let err =
            parse_gtx_translate_response(200, r#"[[["Hello","x",null,null,1],[123]],null,"en"]"#)
                .unwrap_err();
        assert!(matches!(err, ProtocolError::InvalidResponse(_)));
        let err = parse_gtx_translate_response(200, r#"[[[null,"x"]],null,"en"]"#).unwrap_err();
        assert!(matches!(err, ProtocolError::InvalidResponse(_)));
    }

    #[test]
    fn gtx_joins_valid_multi_segments() {
        let body = r#"[[["PartA","源A",null,null,10],["PartB","源B",null,null,10],["PartC","源C",null,null,10]],null,"zh"]"#;
        let resp = parse_gtx_translate_response(200, body).unwrap();
        assert_eq!(resp.translated_text, "PartAPartBPartC");
        assert_eq!(resp.detected_source_language_id.as_deref(), Some("zh"));
    }

    #[test]
    fn gtx_detect_variants() {
        assert_eq!(
            parse_gtx_detect_response(200, r#"[[["x","y",null,null,1]],null,"zh-CN"]"#)
                .unwrap()
                .language_id,
            "zh"
        );
        assert_eq!(
            parse_gtx_detect_response(200, r#"[[["x","y",null,null,1]],null,"nb"]"#)
                .unwrap()
                .language_id,
            "no"
        );
        assert_eq!(
            parse_gtx_detect_response(200, r#"[[["x","y",null,null,1]],null,"fil"]"#)
                .unwrap()
                .language_id,
            "tl"
        );
        assert!(matches!(
            parse_gtx_detect_response(200, r#"[[["x"]],null]"#).unwrap_err(),
            ProtocolError::InvalidResponse(_)
        ));
        assert!(matches!(
            parse_gtx_detect_response(200, r#"[[["x"]],null,"xyzzy"]"#).unwrap_err(),
            ProtocolError::UnsupportedLanguage(_)
        ));
    }

    #[test]
    fn gtx_maps_rate_limit_and_oversize() {
        assert!(matches!(
            map_web_http_error(429).unwrap_err(),
            ProtocolError::RateLimited
        ));
        let huge = format!(
            r#"[[["{}"]],null,"en"]"#,
            "a".repeat(CAPABILITY_TEXT_MAX_BYTES + 1)
        );
        assert!(matches!(
            parse_gtx_translate_response(200, &huge).unwrap_err(),
            ProtocolError::InvalidResponse(_)
        ));
    }

    #[test]
    fn proxy_parses_data_and_rejects_malformed() {
        assert_eq!(
            parse_proxy_translate_response(200, r#"{"data":"你好"}"#).unwrap(),
            "你好"
        );
        assert!(matches!(
            parse_proxy_translate_response(200, r#"{"data":123}"#).unwrap_err(),
            ProtocolError::InvalidResponse(_)
        ));
        assert!(matches!(
            parse_proxy_translate_response(200, r#"{"result":"x"}"#).unwrap_err(),
            ProtocolError::InvalidResponse(_)
        ));
        assert!(matches!(
            parse_proxy_translate_response(200, r#"{"data":""}"#).unwrap_err(),
            ProtocolError::InvalidResponse(_)
        ));
    }

    #[test]
    fn language_mapping_round_trips() {
        assert_eq!(app_language_to_google("zh"), Some("zh-CN"));
        assert_eq!(app_language_to_google("no"), Some("nb"));
        assert_eq!(app_language_to_google("tl"), Some("fil"));
        assert_eq!(app_language_to_google("en"), Some("en"));
        assert_eq!(app_language_to_google("klingon"), None);
        assert_eq!(google_language_to_app("zh-CN"), Some("zh"));
        assert_eq!(google_language_to_app("zh-TW"), Some("zh"));
        assert_eq!(google_language_to_app("nb"), Some("no"));
        assert_eq!(google_language_to_app("fil"), Some("tl"));
        assert_eq!(google_language_to_app("iw"), Some("he"));
        assert_eq!(google_language_to_app("en-US"), Some("en"));
    }

    #[test]
    fn gtx_relative_path_encodes_query() {
        let path = gtx_relative_path("auto", "en", "Hello world");
        assert!(path.starts_with(
            "translate_a/single?client=gtx&sl=auto&tl=en&hl=en&dt=t&ie=UTF-8&oe=UTF-8&q="
        ));
        assert!(path.contains("Hello%20world"));
    }

    #[test]
    fn proxy_request_body_shape() {
        let body = proxy_request_body("你好", "zh-CN", "en");
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["text"], "你好");
        assert_eq!(v["source_lang"], "zh-CN");
        assert_eq!(v["target_lang"], "en");
    }

    #[test]
    fn extract_channel_defaults_and_reads() {
        assert_eq!(extract_channel(b"{}"), Channel::Gtx);
        assert_eq!(extract_channel(br#"{"channel":"gtx"}"#), Channel::Gtx);
        assert_eq!(
            extract_channel(br#"{"channel":"https_proxy"}"#),
            Channel::HttpsProxy
        );
        assert_eq!(extract_channel(b"not-json"), Channel::Gtx);
    }
}
