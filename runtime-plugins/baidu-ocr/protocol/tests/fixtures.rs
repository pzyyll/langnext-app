// ABOUTME: Fixed Baidu OCR protocol fixtures for success, malformed data, and provider errors.
// ABOUTME: Tests normalize wire behavior without network access or production credentials.
use langnext_baidu_ocr_protocol::{parse_response, ProtocolError};

const SUCCESS: &[u8] = include_bytes!("../../tests/fixtures/success.json");
const AUTH_ERROR: &[u8] = include_bytes!("../../tests/fixtures/provider-auth-error.json");
const QUOTA_ERROR: &[u8] = include_bytes!("../../tests/fixtures/provider-quota-error.json");
const MALFORMED: &[u8] = include_bytes!("../../tests/fixtures/malformed.json");
const HTTP_OK: u16 = 200;

#[test]
fn baidu_ocr_protocol_fixtures_match_normalized_contract() {
    assert_eq!(
        parse_response(HTTP_OK, SUCCESS).unwrap(),
        "LangNext\n百度 OCR"
    );
    assert_eq!(
        parse_response(HTTP_OK, AUTH_ERROR),
        Err(ProtocolError::Auth)
    );
    assert_eq!(
        parse_response(HTTP_OK, QUOTA_ERROR),
        Err(ProtocolError::QuotaExceeded)
    );
    assert_eq!(
        parse_response(HTTP_OK, MALFORMED),
        Err(ProtocolError::InvalidResponse)
    );
}
