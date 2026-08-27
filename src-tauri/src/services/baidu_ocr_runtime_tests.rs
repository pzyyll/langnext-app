// ABOUTME: Baidu OCR Component conformance through the real Wasm executor, host Blob, and broker import.
// ABOUTME: Uses fixed local fixtures only; no production key, credential, token, or network evidence.
#![cfg(test)]

use crate::domain::cancel::CancelToken;
use crate::domain::plugin_resource::NetworkResponseBodyModes;
use crate::domain::runtime_plugin::{
  AuthPolicyId, CapabilityId, ComponentArtifactDigest, ExecutionGrantSet, HttpMethod, HttpsOrigin, NetworkGrantEntry,
  NetworkOriginKind, NetworkResourceMode, PackageDigest, PackageIdentity, PluginId, RuntimeIdentity, SemVerVersion,
};
use crate::domain::service_capability::{
  CapabilityErrorCode, ExecutionContext, OCR_IMAGE_CAPABILITY_ID, OcrImageOperation, OcrImagePreferences,
  OcrImageRequest, ProviderAttemptTracker,
};
use crate::services::plugin_package::public_sha256_hex;
use crate::services::service_capabilities::OcrImageCapability;
use crate::services::wasm_runtime::host::{
  BrokerAuthorization, BrokerFetchOutcome, BrokerFetchRequest, BrokerFetchResponse, BrokerHandle, BrokerRequestBody,
  BrokerResponseBody,
};
use crate::services::wasm_runtime::{WasmOcrImageAdapter, WasmRuntime};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use uuid::Uuid;

const BAIDU_COMPONENT: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/baidu-ocr/ocr/fixtures/langnext-baidu-ocr.wasm"
));
const INPUT_PNG: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/baidu-ocr/tests/fixtures/input.png"
));
const SUCCESS_RESPONSE: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/baidu-ocr/tests/fixtures/success.json"
));
const MALFORMED_RESPONSE: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/baidu-ocr/tests/fixtures/malformed.json"
));
const HTTP_OK: u16 = 200;
const PACKAGE_DIGEST_HEX: &str = "babababababababababababababababababababababababababababababababa";

#[derive(Clone)]
struct CaptureBroker {
  response: Arc<Mutex<Vec<u8>>>,
  requests: Arc<Mutex<Vec<BrokerFetchRequest>>>,
}

impl BrokerHandle for CaptureBroker {
  fn fetch(
    &self,
    principal: &crate::domain::runtime_plugin::PluginPrincipal,
    _grant: &ExecutionGrantSet,
    request: BrokerFetchRequest,
    authorization: BrokerAuthorization,
    cancel: &CancelToken,
    _deadline: Option<Instant>,
  ) -> Pin<Box<dyn Future<Output = BrokerFetchOutcome> + Send + '_>> {
    assert_eq!(
      principal.plugin_id().as_str(),
      crate::domain::service_integration::BAIDU_OCR_PLUGIN_ID
    );
    assert_eq!(principal.capability_id().as_str(), OCR_IMAGE_CAPABILITY_ID);
    assert_eq!(
      authorization.origin.as_str(),
      crate::domain::service_integration::BAIDU_OCR_ORIGIN
    );
    assert_eq!(
      authorization.auth_policy.as_str(),
      crate::services::auth_policies::BAIDU_CLIENT_CREDENTIALS_AUTH_POLICY_ID
    );
    self.requests.lock().unwrap().push(request);
    let response = self.response.lock().unwrap().clone();
    let cancelled = cancel.is_cancelled();
    Box::pin(async move {
      if cancelled {
        return Err(crate::services::wasm_runtime::host::BrokerFetchError::Cancelled);
      }
      Ok(BrokerFetchResponse {
        status: HTTP_OK,
        headers: vec![("content-type".into(), "application/json".into())],
        body: BrokerResponseBody::Json(response),
      })
    })
  }
}

fn create_adapter(response: &[u8]) -> (WasmOcrImageAdapter, Arc<Mutex<Vec<BrokerFetchRequest>>>, Uuid) {
  let runtime = Arc::new(WasmRuntime::new().unwrap());
  let package_digest = PackageDigest::parse(PACKAGE_DIGEST_HEX).unwrap();
  let artifact_digest = ComponentArtifactDigest::parse(&public_sha256_hex(BAIDU_COMPONENT)).unwrap();
  let verified = Arc::new(
    runtime
      .compile_component(&package_digest, &artifact_digest, BAIDU_COMPONENT)
      .expect("Baidu OCR component compiles"),
  );
  let instance_id = Uuid::now_v7();
  let capability = CapabilityId::parse(OCR_IMAGE_CAPABILITY_ID).unwrap();
  let networks = [
    "baidu-general-basic",
    "baidu-accurate-basic",
    "baidu-general",
    "baidu-accurate",
  ]
  .into_iter()
  .map(|endpoint_id| {
    NetworkGrantEntry::with_mode_origin_and_response_modes(
      capability.clone(),
      crate::domain::runtime_plugin::EndpointId::parse(endpoint_id).unwrap(),
      HttpsOrigin::parse(crate::domain::service_integration::BAIDU_OCR_ORIGIN).unwrap(),
      NetworkOriginKind::HostFixed,
      HttpMethod::Post,
      AuthPolicyId::parse(crate::services::auth_policies::BAIDU_CLIENT_CREDENTIALS_AUTH_POLICY_ID).unwrap(),
      NetworkResourceMode::Bounded,
      crate::services::runtime_authority::effective_resource_limits_for_capability(OCR_IMAGE_CAPABILITY_ID),
      NetworkResponseBodyModes::JSON_ONLY,
    )
  })
  .collect();
  let grant = ExecutionGrantSet::initial(
    instance_id,
    RuntimeIdentity::Package(PackageIdentity { package_digest }),
    PluginId::parse(crate::domain::service_integration::BAIDU_OCR_PLUGIN_ID).unwrap(),
    SemVerVersion::parse("1.0.0").unwrap(),
    vec![capability],
    networks,
    vec![],
  )
  .unwrap();
  let requests = Arc::new(Mutex::new(Vec::new()));
  let broker = CaptureBroker {
    response: Arc::new(Mutex::new(response.to_vec())),
    requests: requests.clone(),
  };
  (
    WasmOcrImageAdapter::new(
      runtime,
      verified,
      grant,
      OCR_IMAGE_CAPABILITY_ID,
      b"{}".to_vec(),
      Arc::new(move || Box::new(broker.clone())),
    ),
    requests,
    instance_id,
  )
}

fn context(instance_id: Uuid, cancel: CancelToken) -> ExecutionContext {
  ExecutionContext {
    request_id: "baidu-ocr-conformance".into(),
    cancel,
    deadline: None,
    integration_instance_id: instance_id,
    plugin_id: crate::domain::service_integration::BAIDU_OCR_PLUGIN_ID.into(),
    capability_id: OCR_IMAGE_CAPABILITY_ID.into(),
    provider_attempt: ProviderAttemptTracker::new(),
  }
}

#[test]
fn baidu_ocr_runtime_component_matches_current_actions_and_errors() {
  let (adapter, requests, instance_id) = create_adapter(SUCCESS_RESPONSE);
  let result = tauri::async_runtime::block_on(adapter.recognize(
    instance_id,
    OcrImageRequest {
      png_base64: BASE64.encode(INPUT_PNG),
      preferences: OcrImagePreferences {
        operation: OcrImageOperation::Accurate,
        language_hints: vec![],
      },
    },
    context(instance_id, CancelToken::new()),
  ))
  .expect("Baidu OCR succeeds");
  assert_eq!(result.text, "LangNext\n百度 OCR");
  let request = requests.lock().unwrap().pop().unwrap();
  assert_eq!(request.endpoint_id, "baidu-accurate");
  assert_eq!(
    request.relative_path,
    crate::services::baidu_token_exchanger::BAIDU_OCR_PATH_ACCURATE
  );
  let BrokerRequestBody::Blob { bytes, byte_len } = request.body else {
    panic!("Baidu OCR must send a host Blob form body");
  };
  assert_eq!(byte_len, bytes.len());
  let form = std::str::from_utf8(&bytes).unwrap();
  assert!(form.starts_with("image="));
  assert!(!form.contains("access_token"));
  assert!(!form.contains("api-key") && !form.contains("secret-key"));

  let (malformed, malformed_requests, malformed_instance) = create_adapter(MALFORMED_RESPONSE);
  let error = tauri::async_runtime::block_on(malformed.recognize(
    malformed_instance,
    OcrImageRequest {
      png_base64: BASE64.encode(INPUT_PNG),
      preferences: OcrImagePreferences {
        operation: OcrImageOperation::GeneralBasic,
        language_hints: vec![],
      },
    },
    context(malformed_instance, CancelToken::new()),
  ))
  .unwrap_err();
  assert_eq!(
    error.code,
    CapabilityErrorCode::InvalidResponse,
    "{error:?}; broker requests={:?}",
    malformed_requests.lock().unwrap()
  );

  let cancelled = CancelToken::new();
  cancelled.cancel();
  let (cancel_adapter, _, cancel_instance) = create_adapter(SUCCESS_RESPONSE);
  let error = tauri::async_runtime::block_on(cancel_adapter.recognize(
    cancel_instance,
    OcrImageRequest {
      png_base64: BASE64.encode(INPUT_PNG),
      preferences: OcrImagePreferences {
        operation: OcrImageOperation::Accurate,
        language_hints: vec![],
      },
    },
    context(cancel_instance, cancelled),
  ))
  .unwrap_err();
  assert_eq!(error.code, CapabilityErrorCode::Cancelled);
}
