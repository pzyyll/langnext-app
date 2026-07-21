// ABOUTME: Opaque application-owned credential reference generation.
// ABOUTME: Replacement writes use unique operation UUIDs so vault keys never overwrite.
use uuid::Uuid;

/// Build a Provider credential account name for the OS vault.
pub fn provider_ref(provider_id: Uuid, operation_id: Uuid) -> String {
  format!("provider/{provider_id}/{operation_id}")
}

/// Build the global proxy credential account name for the OS vault.
pub fn global_proxy_ref(operation_id: Uuid) -> String {
  format!("proxy/global/{operation_id}")
}

/// Build a Baidu OCR API Key vault account name.
pub fn ocr_api_key_ref(service_id: Uuid, operation_id: Uuid) -> String {
  format!("ocr/{service_id}/api_key/{operation_id}")
}

/// Build a Baidu OCR Secret Key vault account name.
pub fn ocr_secret_key_ref(service_id: Uuid, operation_id: Uuid) -> String {
  format!("ocr/{service_id}/secret_key/{operation_id}")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn refs_include_uuids() {
    let p = Uuid::nil();
    let op = Uuid::from_u128(1);
    assert_eq!(
      provider_ref(p, op),
      "provider/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000001"
    );
    assert!(global_proxy_ref(op).starts_with("proxy/global/"));
    assert_eq!(
      ocr_api_key_ref(p, op),
      "ocr/00000000-0000-0000-0000-000000000000/api_key/00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(
      ocr_secret_key_ref(p, op),
      "ocr/00000000-0000-0000-0000-000000000000/secret_key/00000000-0000-0000-0000-000000000001"
    );
  }
}
