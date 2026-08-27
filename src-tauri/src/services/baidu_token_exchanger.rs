// ABOUTME: Host-owned Baidu client-credentials token exchanger for OCR Wasm guests.
// ABOUTME: Reads API key/secret from vault slots only; guests never see credentials or tokens.
use crate::credentials::CredentialVault;
use crate::domain::cancel::CancelToken;
use crate::domain::provider::ProxyMode;
use crate::domain::provider_http::ProviderHttpMethod;
use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode, OCR_IMAGE_CAPABILITY_ID};
use crate::domain::service_integration::BAIDU_OCR_PLUGIN_ID;
use crate::error::StorageError;
use crate::repositories::{integration_credential_bindings, integration_instances};
use crate::services::auth_policies::{BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID, BAIDU_OAUTH_AUDIENCE_POLICY_ID};
use crate::services::bounded_http::{
  DestinationPolicy, PreparedHttpRequest, RawHttpTransport, RequestBody, ReqwestRawHttpTransport, with_cancel,
};
use crate::services::token_grant::{ExchangedToken, TokenExchanger, TokenInjectionKind};
use crate::storage::Database;
use serde::Deserialize;
use std::sync::Arc;
use uuid::Uuid;

/// Host-owned Baidu OAuth token endpoint.
pub const BAIDU_OAUTH_TOKEN_URL: &str = "https://aip.baidubce.com/oauth/2.0/token";
/// Fixed OCR origin used by the official Baidu package.
pub use crate::domain::service_integration::BAIDU_OCR_ORIGIN;
/// Credential slot for the Baidu API key.
pub const BAIDU_API_KEY_SLOT: &str = "api-key";
/// Credential slot for the Baidu secret key.
pub const BAIDU_SECRET_KEY_SLOT: &str = "secret-key";
/// Host-injected query name. Guests cannot supply this key.
pub const BAIDU_ACCESS_TOKEN_QUERY_NAME: &str = "access_token";
/// Host-fixed content type for Baidu OCR request forms.
pub const BAIDU_OCR_FORM_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";
/// Fixed Baidu OCR path for the general-basic action.
pub const BAIDU_OCR_PATH_GENERAL_BASIC: &str = "rest/2.0/ocr/v1/general_basic";
/// Fixed Baidu OCR path for the accurate-basic action.
pub const BAIDU_OCR_PATH_ACCURATE_BASIC: &str = "rest/2.0/ocr/v1/accurate_basic";
/// Fixed Baidu OCR path for the general action.
pub const BAIDU_OCR_PATH_GENERAL: &str = "rest/2.0/ocr/v1/general";
/// Fixed Baidu OCR path for the accurate action.
pub const BAIDU_OCR_PATH_ACCURATE: &str = "rest/2.0/ocr/v1/accurate";

const TOKEN_RESPONSE_MAX_BYTES: usize = 8 * 1024;
const TOKEN_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const DEFAULT_TOKEN_EXPIRY_SECONDS: u64 = 2_592_000;
const MIN_TOKEN_EXPIRY_SECONDS: u64 = 1;
const HTTP_SUCCESS_START: u16 = 200;
const HTTP_SUCCESS_END_EXCLUSIVE: u16 = 300;

/// Host-owned Baidu client-credentials exchanger.
pub struct BaiduTokenExchanger {
  db: Database,
  vault: Arc<dyn CredentialVault>,
  transport: Arc<dyn RawHttpTransport>,
}

impl BaiduTokenExchanger {
  pub fn new(db: Database, vault: Arc<dyn CredentialVault>) -> Self {
    Self {
      db,
      vault,
      transport: Arc::new(ReqwestRawHttpTransport),
    }
  }

  pub fn with_transport(db: Database, vault: Arc<dyn CredentialVault>, transport: Arc<dyn RawHttpTransport>) -> Self {
    Self { db, vault, transport }
  }

  fn load_keys(&self, instance_id: Uuid) -> Result<(String, String, i64), CapabilityError> {
    let (instance, api_binding, secret_binding) = self
      .db
      .read(|conn| {
        let instance = integration_instances::get(conn, instance_id)?;
        let api_binding = integration_credential_bindings::get(conn, instance_id, BAIDU_API_KEY_SLOT)?;
        let secret_binding = integration_credential_bindings::get(conn, instance_id, BAIDU_SECRET_KEY_SLOT)?;
        Ok((instance, api_binding, secret_binding))
      })
      .map_err(map_storage)?;
    if instance.plugin_id != BAIDU_OCR_PLUGIN_ID {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "instance is not a Baidu OCR integration",
      ));
    }
    if !instance.enabled {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "integration instance is disabled",
      ));
    }
    let api_ref = api_binding
      .credential_ref
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::InvalidConfiguration, "Baidu API key is missing"))?;
    let secret_ref = secret_binding
      .credential_ref
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::InvalidConfiguration, "Baidu secret key is missing"))?;
    let api_key = self.vault.get_for_backend_use(&api_ref).map_err(map_vault)?;
    let secret_key = self.vault.get_for_backend_use(&secret_ref).map_err(map_vault)?;
    if api_key.trim().is_empty() || secret_key.trim().is_empty() {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "Baidu credentials are empty",
      ));
    }
    let revision = api_binding.credential_revision.max(secret_binding.credential_revision);
    Ok((api_key, secret_key, revision))
  }
}

impl TokenExchanger for BaiduTokenExchanger {
  fn driver_id(&self) -> &'static str {
    BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID
  }

  fn injection_kind(&self) -> TokenInjectionKind {
    TokenInjectionKind::QueryParameter {
      name: BAIDU_ACCESS_TOKEN_QUERY_NAME,
    }
  }

  fn exchange(
    &self,
    instance_id: Uuid,
    _scopes: Vec<String>,
    _now_unix_secs: u64,
    cancel: Option<CancelToken>,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>> {
    Box::pin(async move {
      let (api_key, secret_key, credential_revision) = self.load_keys(instance_id)?;
      let mut url = url::Url::parse(BAIDU_OAUTH_TOKEN_URL)
        .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "invalid Baidu OAuth URL"))?;
      url
        .query_pairs_mut()
        .append_pair("grant_type", "client_credentials")
        .append_pair("client_id", &api_key)
        .append_pair("client_secret", &secret_key);
      let prepared = PreparedHttpRequest {
        method: ProviderHttpMethod::Post,
        url,
        headers: std::collections::HashMap::new(),
        body: RequestBody::None,
        content_type: None,
        proxy_mode: ProxyMode::Direct,
        destination_policy: DestinationPolicy::TrustedFixed,
        max_response_body_bytes: Some(TOKEN_RESPONSE_MAX_BYTES),
        timeout: Some(TOKEN_REQUEST_TIMEOUT),
      };
      let response = with_cancel(cancel.as_ref(), self.transport.request(prepared))
        .await
        .map_err(map_storage)?;
      if !(HTTP_SUCCESS_START..HTTP_SUCCESS_END_EXCLUSIVE).contains(&response.status) {
        return Err(CapabilityError::new(
          CapabilityErrorCode::Auth,
          "Baidu OAuth HTTP failed",
        ));
      }
      let body = std::str::from_utf8(&response.body)
        .map_err(|_| CapabilityError::new(CapabilityErrorCode::Auth, "Baidu OAuth returned non-UTF-8 body"))?;
      let parsed: BaiduTokenResponse = serde_json::from_str(body)
        .map_err(|_| CapabilityError::new(CapabilityErrorCode::Auth, "Baidu OAuth returned an invalid response"))?;
      let access_token = parsed
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::Auth, "Baidu OAuth token missing"))?;
      Ok(ExchangedToken {
        access_token,
        expires_in: parsed
          .expires_in
          .unwrap_or(DEFAULT_TOKEN_EXPIRY_SECONDS)
          .max(MIN_TOKEN_EXPIRY_SECONDS),
        credential_revision,
      })
    })
  }
}

#[derive(Debug, Deserialize)]
struct BaiduTokenResponse {
  access_token: Option<String>,
  expires_in: Option<u64>,
}

fn map_storage(err: StorageError) -> CapabilityError {
  CapabilityError::new(CapabilityErrorCode::Auth, format!("Baidu token exchange failed: {err}"))
}

fn map_vault(err: StorageError) -> CapabilityError {
  match err {
    StorageError::CredentialUnavailable | StorageError::CredentialAccess => {
      CapabilityError::new(CapabilityErrorCode::Auth, "credential store unavailable")
    }
    other => map_storage(other),
  }
}

/// True when a guest query already carries the host-owned Baidu token name.
pub fn guest_supplied_baidu_access_token(url: &url::Url) -> bool {
  url
    .query_pairs()
    .any(|(key, _)| key.eq_ignore_ascii_case(BAIDU_ACCESS_TOKEN_QUERY_NAME))
}

/// Host-owned OCR capability used by Baidu package validation.
pub fn baidu_remote_capability_id() -> &'static str {
  OCR_IMAGE_CAPABILITY_ID
}

pub fn baidu_audience_policy_id() -> &'static str {
  BAIDU_OAUTH_AUDIENCE_POLICY_ID
}
