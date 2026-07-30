// ABOUTME: Trusted Google service-account driver: parse SA JSON, sign RS256 JWT, exchange tokens.
// ABOUTME: Loads vault secrets only here; never logs private keys, JWTs, or access tokens.
use crate::credentials::CredentialVault;
use crate::domain::cancel::CancelToken;
use crate::domain::provider::ProxyMode;
use crate::domain::provider_http::{ProviderHttpMethod, ProviderHttpResponse};
use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
use crate::domain::service_integration::{
  GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT, GOOGLE_OAUTH_TOKEN_URI, GoogleCloudConfigV1,
  SERVICE_ACCOUNT_JSON_MAX_LEN,
};
use crate::error::StorageError;
use crate::repositories::{integration_credential_bindings, integration_instances};
use crate::services::bounded_http::{
  DestinationPolicy, PreparedHttpRequest, RawHttpTransport, ReqwestRawHttpTransport, build_endpoint, with_cancel,
};
use crate::services::token_grant::{ExchangedToken, GoogleTokenExchanger};
use crate::storage::Database;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

/// JWT assertion lifetime used for Google service-account OAuth (≤ 1 hour).
pub const GOOGLE_JWT_ASSERTION_LIFETIME_SECS: u64 = 3600;
/// OAuth grant type for JWT bearer assertions.
pub const GOOGLE_JWT_BEARER_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/// Relative path under the oauth endpoint alias origin.
pub const GOOGLE_OAUTH_TOKEN_RELATIVE_PATH: &str = "token";
/// Max OAuth error response body retained for classification (not returned to UI).
const OAUTH_ERROR_BODY_SCAN_MAX: usize = 512;

#[derive(Debug, Clone)]
pub struct ParsedServiceAccount {
  pub client_email: String,
  pub private_key_pem: String,
  pub token_uri: String,
}

#[derive(Debug, Serialize)]
struct GoogleJwtClaims {
  iss: String,
  scope: String,
  aud: String,
  exp: u64,
  iat: u64,
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
  access_token: String,
  #[serde(default)]
  expires_in: u64,
  #[serde(default)]
  token_type: String,
}

/// Host-owned Google SA token exchanger backed by vault + bounded HTTP.
pub struct GoogleServiceAccountExchanger {
  db: Database,
  vault: Arc<dyn CredentialVault>,
  transport: Arc<dyn RawHttpTransport>,
}

impl GoogleServiceAccountExchanger {
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

  fn load_instance_secret_and_proxy(&self, instance_id: Uuid) -> Result<(String, i64, ProxyMode), CapabilityError> {
    let (instance, binding) = self
      .db
      .read(|conn| {
        let instance = integration_instances::get(conn, instance_id)?;
        let binding = integration_credential_bindings::get(conn, instance_id, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT)?;
        Ok((instance, binding))
      })
      .map_err(map_storage_to_capability)?;

    if instance.plugin_id != GOOGLE_CLOUD_PLUGIN_ID {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "instance is not a Google Cloud integration",
      ));
    }
    if !instance.enabled {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "integration instance is disabled",
      ));
    }

    let proxy_mode = serde_json::from_str::<GoogleCloudConfigV1>(&instance.config_json)
      .map(|c| c.proxy_mode)
      .unwrap_or(ProxyMode::Inherit);

    let credential_ref = binding.credential_ref.ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "service-account credential is missing",
      )
    })?;

    let secret = self.vault.get_for_backend_use(&credential_ref).map_err(|e| match e {
      StorageError::CredentialUnavailable | StorageError::CredentialAccess => {
        CapabilityError::new(CapabilityErrorCode::Auth, "credential store unavailable")
      }
      other => map_storage_to_capability(other),
    })?;

    if secret.trim().is_empty() {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "service-account credential is empty",
      ));
    }

    Ok((secret, binding.credential_revision, proxy_mode))
  }
}

impl GoogleTokenExchanger for GoogleServiceAccountExchanger {
  fn exchange(
    &self,
    instance_id: Uuid,
    scopes: Vec<String>,
    now_unix_secs: u64,
    cancel: Option<CancelToken>,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>> {
    Box::pin(async move {
      let (secret, credential_revision, proxy_mode) = self.load_instance_secret_and_proxy(instance_id)?;
      let parsed = parse_service_account_json(&secret)?;
      let assertion = sign_service_account_jwt(&parsed, &scopes, now_unix_secs)?;
      let response = exchange_jwt_for_token(self.transport.as_ref(), &assertion, proxy_mode, cancel.as_ref()).await?;
      Ok(ExchangedToken {
        access_token: response.access_token,
        expires_in: if response.expires_in == 0 {
          3600
        } else {
          response.expires_in
        },
        credential_revision,
      })
    })
  }
}

/// Parse and validate bounded service-account JSON for token exchange.
pub fn parse_service_account_json(secret: &str) -> Result<ParsedServiceAccount, CapabilityError> {
  if secret.len() > SERVICE_ACCOUNT_JSON_MAX_LEN {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "service-account JSON exceeds size limit",
    ));
  }
  let value: Value = serde_json::from_str(secret).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "service-account credential must be valid JSON",
    )
  })?;
  let obj = value.as_object().ok_or_else(|| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "service-account credential must be a JSON object",
    )
  })?;

  let client_email = obj
    .get("client_email")
    .and_then(|v| v.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "service-account JSON requires client_email",
      )
    })?
    .to_string();

  let private_key = obj
    .get("private_key")
    .and_then(|v| v.as_str())
    .map(|s| s.replace("\\n", "\n"))
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "service-account JSON requires private_key",
      )
    })?;

  let token_uri = obj
    .get("token_uri")
    .and_then(|v| v.as_str())
    .map(str::trim)
    .unwrap_or("");
  if token_uri != GOOGLE_OAUTH_TOKEN_URI {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "service-account token_uri is not the pinned Google OAuth endpoint",
    ));
  }

  Ok(ParsedServiceAccount {
    client_email,
    private_key_pem: private_key,
    token_uri: token_uri.to_string(),
  })
}

/// Sign a Google OAuth JWT assertion with RS256.
pub fn sign_service_account_jwt(
  account: &ParsedServiceAccount,
  scopes: &[String],
  now_unix_secs: u64,
) -> Result<String, CapabilityError> {
  let scope = scopes
    .iter()
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
  if scope.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "OAuth scope is required",
    ));
  }

  let claims = GoogleJwtClaims {
    iss: account.client_email.clone(),
    scope,
    aud: GOOGLE_OAUTH_TOKEN_URI.to_string(),
    iat: now_unix_secs,
    exp: now_unix_secs.saturating_add(GOOGLE_JWT_ASSERTION_LIFETIME_SECS),
  };

  let key = EncodingKey::from_rsa_pem(account.private_key_pem.as_bytes()).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::Auth,
      "service-account private key is not a valid RSA PEM key",
    )
    .with_retryable(false)
  })?;

  encode(&Header::new(Algorithm::RS256), &claims, &key).map_err(|_| {
    CapabilityError::new(CapabilityErrorCode::Auth, "failed to sign service-account JWT").with_retryable(false)
  })
}

async fn exchange_jwt_for_token(
  transport: &dyn RawHttpTransport,
  assertion: &str,
  proxy_mode: ProxyMode,
  cancel: Option<&CancelToken>,
) -> Result<GoogleTokenResponse, CapabilityError> {
  let url = build_endpoint("https://oauth2.googleapis.com", GOOGLE_OAUTH_TOKEN_RELATIVE_PATH)
    .map_err(map_storage_to_capability)?;
  let body = format!(
    "grant_type={}&assertion={}",
    urlencoding_encode(GOOGLE_JWT_BEARER_GRANT_TYPE),
    urlencoding_encode(assertion)
  );

  let prepared = PreparedHttpRequest {
    method: ProviderHttpMethod::Post,
    url,
    headers: HashMap::new(),
    body: Some(body),
    content_type: Some("application/x-www-form-urlencoded".into()),
    proxy_mode,
    // OAuth URI is a host-pinned constant validated from the service-account credential.
    destination_policy: DestinationPolicy::TrustedFixed,
    max_response_body_bytes: Some(16 * 1024),
    timeout: None,
  };

  let response = with_cancel(cancel, transport.request(prepared))
    .await
    .map_err(map_http_error_to_capability)?
    .into_provider_http_response()
    .map_err(map_http_error_to_capability)?;
  classify_oauth_response(response)
}

fn classify_oauth_response(response: ProviderHttpResponse) -> Result<GoogleTokenResponse, CapabilityError> {
  match response.status {
    200 => {
      let parsed: GoogleTokenResponse = serde_json::from_str(&response.body).map_err(|_| {
        CapabilityError::new(
          CapabilityErrorCode::InvalidResponse,
          "OAuth token response was malformed",
        )
      })?;
      if parsed.access_token.trim().is_empty() {
        return Err(CapabilityError::new(
          CapabilityErrorCode::Auth,
          "OAuth token response missing access_token",
        ));
      }
      let _ = parsed.token_type;
      Ok(parsed)
    }
    401 | 403 => Err(
      CapabilityError::new(CapabilityErrorCode::Auth, "OAuth token exchange was denied")
        .with_retryable(false)
        .with_provider_code(response.status.to_string()),
    ),
    429 => Err(
      CapabilityError::new(CapabilityErrorCode::RateLimited, "OAuth token endpoint rate limited")
        .with_retryable(true)
        .with_provider_code("429"),
    ),
    500..=599 => Err(
      CapabilityError::new(
        CapabilityErrorCode::ProviderUnavailable,
        "OAuth token endpoint unavailable",
      )
      .with_retryable(true)
      .with_provider_code(response.status.to_string()),
    ),
    _ => {
      let _scan = response.body.chars().take(OAUTH_ERROR_BODY_SCAN_MAX).count();
      Err(
        CapabilityError::new(CapabilityErrorCode::Auth, "OAuth token exchange failed")
          .with_retryable(false)
          .with_provider_code(response.status.to_string()),
      )
    }
  }
}

fn map_storage_to_capability(err: StorageError) -> CapabilityError {
  match err {
    StorageError::NotFound(msg) => CapabilityError::new(CapabilityErrorCode::InvalidConfiguration, msg),
    StorageError::Validation(msg) if msg.contains("cancelled") => {
      CapabilityError::new(CapabilityErrorCode::Cancelled, "request cancelled")
    }
    StorageError::Validation(msg) if msg.contains("timed out") => {
      CapabilityError::new(CapabilityErrorCode::Timeout, "request timed out")
    }
    StorageError::Validation(msg) => CapabilityError::new(CapabilityErrorCode::InvalidConfiguration, msg),
    StorageError::CredentialUnavailable | StorageError::CredentialAccess => {
      CapabilityError::new(CapabilityErrorCode::Auth, "credential store unavailable")
    }
    StorageError::PluginUnavailable(msg) => CapabilityError::new(CapabilityErrorCode::PluginUnavailable, msg),
    _ => CapabilityError::new(CapabilityErrorCode::Internal, "internal storage error"),
  }
}

fn urlencoding_encode(value: &str) -> String {
  let mut out = String::with_capacity(value.len());
  for b in value.as_bytes() {
    match *b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
      _ => out.push_str(&format!("%{b:02X}")),
    }
  }
  out
}

fn map_http_error_to_capability(err: StorageError) -> CapabilityError {
  match err {
    StorageError::Validation(msg) if msg.contains("cancelled") => {
      CapabilityError::new(CapabilityErrorCode::Cancelled, "request cancelled")
    }
    StorageError::Validation(msg) if msg.contains("timed out") => {
      CapabilityError::new(CapabilityErrorCode::Timeout, "request timed out")
    }
    StorageError::Validation(msg) if msg.contains("network") => CapabilityError::new(CapabilityErrorCode::Network, msg),
    other => map_storage_to_capability(other),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::provider_http::ProviderHttpStreamEvent;
  use crate::domain::service_integration::{
    GOOGLE_CLOUD_DEFAULT_LOCATION, IntegrationCredentialBinding, IntegrationHealthStatus, IntegrationInstance,
  };
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::services::bounded_http::BoundedHttpResponse;
  use crate::services::service_integration_registry::ServiceIntegrationRegistry;
  use crate::services::token_grant::{
    GOOGLE_OAUTH_AUDIENCE_POLICY_ID, GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID, TokenGrantRequest, TokenGrantService,
  };
  use std::future::Future;
  use std::pin::Pin;
  use std::sync::Mutex;

  // Fixed RSA test key (not a real secret).
  const TEST_PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCqrOBiJ8BcK6ef
RsOwAlkHV9dJHXJXc8kVzGVDLUOAgv2PnC9lDyUThZuXZ8D5nonggx91cyLLM31i
et2qmvITMKG0yA/aTDdEmfRawwu30+D4EP2jRVeR61QgVsjsEQvsp5Z/t9/NO+Wk
tUo3AFVbdM6ghh1HWIBMm41uPBEBXW16faH6TgeWyLEWKNvBTE/8SEze0B3x1zs4
LtpmisAnax8vcl5Csdz1qiykwwdFAXK0y1nvrJjVtqMv8qvurLGSBddxXyXWun0b
bL1cNRbBimyl0LWB+lI1JS7LaA2jLZ1kCiblodaYa+4p8uyI42dWqLHx+DjPYA/y
6duNtQwJAgMBAAECggEARy5PbJBgmPA5+eMU9QCdqcLYTi2CRPfMqxMyPliP2PaI
ko7Uc2TkFSa5U+VZJaIZpbF5+s1Yev/P8LUGYsM5Z4h2QIPZnLUBrdI5h2rmJbYv
krXfWmsukPRhAxW+uTmIzBu+2ChTJfCvn0hemd7BOqHWFTup1VoTNCAB1bImc3cZ
C/2AmPS6snS/S7MF87SgKJo4oXI893u8Yh6yMXPSRBXhlcKzQ3hmmcMTQR2SOXF7
0cxuTjgR5+B5Df2IqFstCW+U7mnoGX3bYgG0BVfGUPkJoFSAwI/jmLyMIhJxSqOo
RCGuAjWdXQc+tHeU6iKnUVZSDwTGGyRvL1uXPW0VWwKBgQDkRk3qTASo0KBxSeL5
bHEHIussQzVlq4ORAPuFDvA72LRo0l7KUd72w6VlOGql6P8xh+JDrZChqvd+Lo5X
ipST3gVz9Yep0F9/J1SbQUB7z4TPmrHD1QKtDAM1GRR4UPuA5iVmY2dpy+4QvAfD
74ND/MfD4w2g5CBwjISf1J+ndwKBgQC/Z6Xvo6Jdpy8VidYCQ1+7f3MxGs6gtk1C
fKseYVu4MSvp+DzqRYGYhAp+ABHSbpba9JbtG1DcDqPXyC7Fzn2MMcYLIgzR4DUi
n4pnkGw/MAzxB+XQg6SDtogvQXfvPp75jal2iAK6g1O5ebec93jJGCjqExEwrA4H
0zQ4KLTIfwKBgQCqSnAxiwgmz4wBN3dlTqp7AmeiG3koIW0CrVL1DhHU83KSh+1C
zRShzY4DFrUok8pcLtxyVHaCxEHhFeYGFFGGhahXuyC7Y8D54GNTdrgeJM8U+HgI
eU2HvmBeKhmFMBSPMiFQYnNxDzrHrR2142VvQJHd5fHyxnwUuh7uBPYdPQKBgDPX
yBszcCv7t4YW8m9kfk6Tw8ieIS9okV6b0+GDr0shjmpuAVnW/7YmtYzRSgJ8T8H4
k9SfHHSuRnSQ1RJgzqKlbKXhUCWcm+fH3L4WYStwQWEbqYSj03CVhSd/jROxG3Au
jaL8Tfjkz02iiTgr03xsXdCg33wWbipya2d2pxjTAoGAZ98HuXhAs5SQWWQfItFa
rM8B5S+t8JOVBTbZJFL5SanYAGuFXEM/LjF0RfdJd0eLbZTeCC478a78kTLuvSr1
NjalgaoygklqOixtOd+LT7/9IC4O07nG9mbTV1bK7vLryUr4YNMBJJ99vfogwLBW
F91NhBYyyc/NJWl83dBkI/I=
-----END PRIVATE KEY-----";

  fn valid_sa_json() -> String {
    serde_json::json!({
      "type": "service_account",
      "client_email": "bot@example.iam.gserviceaccount.com",
      "private_key": TEST_PRIVATE_KEY,
      "token_uri": GOOGLE_OAUTH_TOKEN_URI,
    })
    .to_string()
  }

  #[test]
  fn google_service_account_parses_valid_json() {
    let parsed = parse_service_account_json(&valid_sa_json()).unwrap();
    assert_eq!(parsed.client_email, "bot@example.iam.gserviceaccount.com");
    assert_eq!(parsed.token_uri, GOOGLE_OAUTH_TOKEN_URI);
  }

  #[test]
  fn google_service_account_rejects_wrong_token_uri() {
    let json = serde_json::json!({
      "client_email": "bot@example.iam.gserviceaccount.com",
      "private_key": TEST_PRIVATE_KEY,
      "token_uri": "https://evil.example/token",
    })
    .to_string();
    let err = parse_service_account_json(&json).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidConfiguration);
  }

  #[test]
  fn google_service_account_rejects_malformed_key() {
    let account = ParsedServiceAccount {
      client_email: "bot@example.iam.gserviceaccount.com".into(),
      private_key_pem: "not-a-key".into(),
      token_uri: GOOGLE_OAUTH_TOKEN_URI.into(),
    };
    let err = sign_service_account_jwt(
      &account,
      &["https://www.googleapis.com/auth/cloud-translation".into()],
      1_700_000_000,
    )
    .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::Auth);
    assert!(!err.retryable);
  }

  #[test]
  fn google_service_account_signs_jwt_without_leaking_in_debug() {
    let account = parse_service_account_json(&valid_sa_json()).unwrap();
    let jwt = sign_service_account_jwt(
      &account,
      &["https://www.googleapis.com/auth/cloud-translation".into()],
      1_700_000_000,
    )
    .unwrap();
    assert!(jwt.split('.').count() == 3);
    // JWT should never appear in CapabilityError Debug (we don't put it there).
    let err = CapabilityError::new(CapabilityErrorCode::Auth, "failed");
    assert!(!format!("{err:?}").contains(&jwt));
  }

  struct ScriptedTransport {
    responses: Mutex<Vec<Result<BoundedHttpResponse, StorageError>>>,
    last_body: Mutex<Option<String>>,
    last_destination_policy: Mutex<Option<DestinationPolicy>>,
  }

  impl RawHttpTransport for ScriptedTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, StorageError>> + Send + '_>> {
      Box::pin(async move {
        *self.last_body.lock().unwrap() = prepared.body.clone();
        *self.last_destination_policy.lock().unwrap() = Some(prepared.destination_policy);
        self
          .responses
          .lock()
          .unwrap()
          .pop()
          .unwrap_or_else(|| Err(StorageError::Validation("no scripted response".into())))
      })
    }

    fn stream(
      &self,
      _prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
    ) -> Pin<Box<dyn Future<Output = Result<(), StorageError>> + Send + '_>> {
      Box::pin(async { Err(StorageError::Validation("stream not supported".into())) })
    }
  }

  fn response(status: u16, body: &str) -> BoundedHttpResponse {
    BoundedHttpResponse {
      status,
      headers: HashMap::new(),
      body: body.as_bytes().to_vec(),
    }
  }

  fn seed_instance(db: &Database, vault: &MemoryCredentialVault, sa_json: &str) -> Uuid {
    let registry = ServiceIntegrationRegistry::bundled().unwrap();
    let manifest = registry.get(GOOGLE_CLOUD_PLUGIN_ID).unwrap();
    let id = new_id();
    let now = now_rfc3339();
    let config = GoogleCloudConfigV1 {
      project_id: "demo".into(),
      location: GOOGLE_CLOUD_DEFAULT_LOCATION.into(),
      proxy_mode: ProxyMode::Direct,
    };
    let config_json = serde_json::to_string(&config).unwrap();
    let cred_ref = format!("integration/{id}/{GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT}/op");
    vault.set(&cred_ref, sa_json).unwrap();
    db.transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &IntegrationInstance {
          id,
          plugin_id: manifest.id.clone(),
          plugin_version: manifest.version.clone(),
          display_name: "Test".into(),
          enabled: true,
          config_json,
          config_schema_version: 1,
          health_status: IntegrationHealthStatus::Unvalidated,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "bundled-rust".into(),
          package_digest: None,
          execution_grant_set_revision: None,
          runtime_state: "active".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      integration_credential_bindings::insert(
        uow.conn(),
        &IntegrationCredentialBinding {
          id: new_id(),
          integration_instance_id: id,
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential_ref: Some(cred_ref),
          credential_revision: 3,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();
    id
  }

  #[tokio::test]
  async fn google_service_account_oauth_401_maps_to_auth() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let id = seed_instance(&db, vault.as_ref(), &valid_sa_json());
    let transport = Arc::new(ScriptedTransport {
      responses: Mutex::new(vec![Ok(response(401, r#"{"error":"invalid_grant"}"#))]),
      last_body: Mutex::new(None),
      last_destination_policy: Mutex::new(None),
    });
    let exchanger = GoogleServiceAccountExchanger::with_transport(db, vault, transport);
    let err = match exchanger
      .exchange(
        id,
        vec!["https://www.googleapis.com/auth/cloud-translation".into()],
        1_700_000_000,
        None,
      )
      .await
    {
      Ok(_) => panic!("expected auth failure"),
      Err(e) => e,
    };
    assert_eq!(err.code, CapabilityErrorCode::Auth);
    assert!(!format!("{err:?}").contains("invalid_grant"));
  }

  #[tokio::test]
  async fn google_service_account_token_success_through_grant_service() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let id = seed_instance(&db, vault.as_ref(), &valid_sa_json());
    let transport = Arc::new(ScriptedTransport {
      responses: Mutex::new(vec![Ok(response(
        200,
        r#"{"access_token":"ya29.test","expires_in":3600,"token_type":"Bearer"}"#,
      ))]),
      last_body: Mutex::new(None),
      last_destination_policy: Mutex::new(None),
    });
    let exchanger = Arc::new(GoogleServiceAccountExchanger::with_transport(
      db,
      vault,
      transport.clone(),
    ));
    let service = TokenGrantService::new(exchanger);
    let grant = service
      .acquire(
        TokenGrantRequest {
          instance_id: id,
          capability_id: "translate.text@1".into(),
          auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
          scopes: vec!["https://www.googleapis.com/auth/cloud-translation".into()],
          audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        },
        None,
      )
      .await
      .unwrap();
    assert_eq!(grant.credential_revision(), 3);
    let body = transport.last_body.lock().unwrap().clone().unwrap();
    assert!(body.contains("grant_type="));
    assert!(body.contains("assertion="));
    assert_eq!(
      *transport.last_destination_policy.lock().unwrap(),
      Some(DestinationPolicy::TrustedFixed)
    );
    assert!(!format!("{grant:?}").contains("ya29.test"));
  }
}
