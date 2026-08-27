// ABOUTME: Baidu OCR request form construction, action selection, and response normalization.
// ABOUTME: The codec contains no credential, token, network, filesystem, or host integration logic.
#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use serde::Deserialize;

pub const OCR_IMAGE_MAX_DECODED_BYTES: usize = 8 * 1024 * 1024;
pub const OCR_RESPONSE_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const OCR_ENDPOINT_GENERAL_BASIC: &str = "baidu-general-basic";
pub const OCR_ENDPOINT_ACCURATE_BASIC: &str = "baidu-accurate-basic";
pub const OCR_ENDPOINT_GENERAL: &str = "baidu-general";
pub const OCR_ENDPOINT_ACCURATE: &str = "baidu-accurate";
pub const OCR_PATH_GENERAL_BASIC: &str = "rest/2.0/ocr/v1/general_basic";
pub const OCR_PATH_ACCURATE_BASIC: &str = "rest/2.0/ocr/v1/accurate_basic";
pub const OCR_PATH_GENERAL: &str = "rest/2.0/ocr/v1/general";
pub const OCR_PATH_ACCURATE: &str = "rest/2.0/ocr/v1/accurate";
pub const FORM_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";
pub const TOKEN_GRANT_AUTH_FAILURE_MARKER: &str = "token-grant-auth-failed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OcrAction {
    GeneralBasic,
    AccurateBasic,
    General,
    Accurate,
}

impl OcrAction {
    pub fn parse(value: Option<&str>) -> Result<Self, ProtocolError> {
        match value.unwrap_or("accurate") {
            "general_basic" => Ok(Self::GeneralBasic),
            "accurate_basic" => Ok(Self::AccurateBasic),
            "general" => Ok(Self::General),
            "accurate" => Ok(Self::Accurate),
            _ => Err(ProtocolError::InvalidRequest),
        }
    }

    pub const fn endpoint_id(self) -> &'static str {
        match self {
            Self::GeneralBasic => OCR_ENDPOINT_GENERAL_BASIC,
            Self::AccurateBasic => OCR_ENDPOINT_ACCURATE_BASIC,
            Self::General => OCR_ENDPOINT_GENERAL,
            Self::Accurate => OCR_ENDPOINT_ACCURATE,
        }
    }

    pub const fn relative_path(self) -> &'static str {
        match self {
            Self::GeneralBasic => OCR_PATH_GENERAL_BASIC,
            Self::AccurateBasic => OCR_PATH_ACCURATE_BASIC,
            Self::General => OCR_PATH_GENERAL,
            Self::Accurate => OCR_PATH_ACCURATE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidRequest,
    UnsupportedInput,
    Auth,
    RateLimited,
    QuotaExceeded,
    ProviderUnavailable,
    InvalidResponse,
}

pub fn form_body(image_base64: &str) -> Result<Vec<u8>, ProtocolError> {
    if image_base64.is_empty() || image_base64.len() > encoded_image_max_bytes() {
        return Err(ProtocolError::UnsupportedInput);
    }
    let mut body = String::from("image=");
    append_form_component(&mut body, image_base64.as_bytes());
    body.push_str("&language_type=auto_detect");
    body.push_str("&detect_direction=false");
    body.push_str("&detect_language=false");
    body.push_str("&vertexes_location=false");
    body.push_str("&paragraph=false");
    body.push_str("&probability=false");
    Ok(body.into_bytes())
}

pub fn parse_response(status: u16, body: &[u8]) -> Result<String, ProtocolError> {
    if body.len() > OCR_RESPONSE_MAX_BYTES {
        return Err(ProtocolError::InvalidResponse);
    }
    if status == 401 || status == 403 {
        return Err(ProtocolError::Auth);
    }
    if status == 429 {
        return Err(ProtocolError::RateLimited);
    }
    if !(200..300).contains(&status) {
        return Err(ProtocolError::ProviderUnavailable);
    }
    let response: BaiduOcrResponse =
        serde_json::from_slice(body).map_err(|_| ProtocolError::InvalidResponse)?;
    if let Some(code) = response.error_code.filter(|code| *code != 0) {
        return Err(map_provider_error(code));
    }
    let mut output = String::new();
    for item in response.words_result.unwrap_or_default() {
        let line = item.words.trim();
        if line.is_empty() {
            continue;
        }
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(line);
    }
    Ok(output)
}

pub const fn encoded_image_max_bytes() -> usize {
    OCR_IMAGE_MAX_DECODED_BYTES.div_ceil(3) * 4
}

fn append_form_component(output: &mut String, bytes: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for &byte in bytes {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(char::from(byte));
        } else {
            output.push('%');
            output.push(char::from(HEX[(byte >> 4) as usize]));
            output.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
}

fn map_provider_error(code: i64) -> ProtocolError {
    match code {
        6 | 100 | 110 | 111 => ProtocolError::Auth,
        17 | 18 | 19 => ProtocolError::QuotaExceeded,
        4 => ProtocolError::RateLimited,
        216100..=216999 => ProtocolError::InvalidResponse,
        _ => ProtocolError::ProviderUnavailable,
    }
}

#[derive(Deserialize)]
struct BaiduOcrResponse {
    error_code: Option<i64>,
    #[allow(dead_code)]
    error_msg: Option<String>,
    words_result: Option<Vec<BaiduWord>>,
}

#[derive(Deserialize)]
struct BaiduWord {
    words: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_actions_map_to_closed_endpoint_and_path_pairs() {
        let cases = [
            (
                "general_basic",
                OCR_ENDPOINT_GENERAL_BASIC,
                OCR_PATH_GENERAL_BASIC,
            ),
            (
                "accurate_basic",
                OCR_ENDPOINT_ACCURATE_BASIC,
                OCR_PATH_ACCURATE_BASIC,
            ),
            ("general", OCR_ENDPOINT_GENERAL, OCR_PATH_GENERAL),
            ("accurate", OCR_ENDPOINT_ACCURATE, OCR_PATH_ACCURATE),
        ];
        for (value, endpoint, path) in cases {
            let action = OcrAction::parse(Some(value)).unwrap();
            assert_eq!(action.endpoint_id(), endpoint);
            assert_eq!(action.relative_path(), path);
        }
    }

    #[test]
    fn request_form_percent_encodes_base64_and_uses_fixed_flags() {
        let body = String::from_utf8(form_body("ab+/=").unwrap()).unwrap();
        assert!(body.starts_with("image=ab%2B%2F%3D"));
        assert!(body.contains("language_type=auto_detect"));
        assert!(body.ends_with("probability=false"));
    }

    #[test]
    fn response_normalizes_lines_and_provider_errors() {
        let body = br#"{"words_result":[{"words":" first "},{"words":""},{"words":"second"}]}"#;
        assert_eq!(parse_response(200, body).unwrap(), "first\nsecond");
        assert_eq!(
            parse_response(200, br#"{"error_code":110,"error_msg":"expired"}"#),
            Err(ProtocolError::Auth)
        );
        assert_eq!(
            parse_response(200, b"not-json"),
            Err(ProtocolError::InvalidResponse)
        );
    }
}
