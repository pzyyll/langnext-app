// ABOUTME: Host-owned auth-policy registry and drivers for service-integration token grants.
// ABOUTME: A manifest never carries executable auth logic; drivers live here and bind by host id.
use crate::domain::plugin_catalog::PluginSource;
use crate::domain::runtime_plugin::{HttpMethod, PluginManifestV1, RuntimeKind};
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, OCR_IMAGE_CAPABILITY_ID, SPEECH_SYNTHESIZE_CAPABILITY_ID,
};
use crate::error::StorageError;
use crate::services::google_cloud::{GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID};
use crate::services::token_grant::TokenGrantRequest;

/// Host-defined auth policy/driver id for the Google service-account OAuth2 exchange.
/// Package manifests use this id; the audience remains host-derived.
pub const GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID: &str = "com.langnext.auth.google-service-account";
pub const GOOGLE_SERVICE_ACCOUNT_AUTH_POLICY_ID: &str = GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID;
/// Host-defined audience policy id for the Google OAuth2 token endpoint.
pub const GOOGLE_OAUTH_AUDIENCE_POLICY_ID: &str = "google-oauth-token";
/// Host-defined auth policy/driver id for Baidu client-credentials exchange.
pub const BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID: &str = "com.langnext.auth.baidu-client-credentials";
pub const BAIDU_CLIENT_CREDENTIALS_AUTH_POLICY_ID: &str = BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID;
/// Host-defined audience policy id for the Baidu OAuth2 token endpoint.
pub const BAIDU_OAUTH_AUDIENCE_POLICY_ID: &str = "baidu-oauth-token";
/// OAuth2 scope for Cloud Translation.
pub const GOOGLE_CLOUD_TRANSLATION_SCOPE: &str = "https://www.googleapis.com/auth/cloud-translation";
/// OAuth2 scope for Cloud Vision.
pub const GOOGLE_CLOUD_VISION_SCOPE: &str = "https://www.googleapis.com/auth/cloud-vision";
/// OAuth2 scope for Cloud Text-to-Speech (and the broader Cloud Platform).
pub const GOOGLE_CLOUD_TEXT_TO_SPEECH_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";

/// A registered auth policy binding a driver to an audience and a per-capability scope allow-list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthPolicyDriver {
  pub auth_driver_id: &'static str,
  pub audience_policy_id: &'static str,
  /// Capability id -> approved OAuth2 scopes for that capability under this driver.
  pub capability_scopes: &'static [(&'static str, &'static [&'static str])],
}

/// The single host-recognized auth policy for Phase 1: Google service-account OAuth2.
const GOOGLE_SERVICE_ACCOUNT_POLICY: AuthPolicyDriver = AuthPolicyDriver {
  auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID,
  audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID,
  capability_scopes: &[
    (GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID, TRANSLATE_SCOPES),
    (GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, TRANSLATE_SCOPES),
    (OCR_IMAGE_CAPABILITY_ID, VISION_SCOPES),
    (SPEECH_SYNTHESIZE_CAPABILITY_ID, TTS_SCOPES),
  ],
};

const TRANSLATE_SCOPES: &[&str] = &[GOOGLE_CLOUD_TRANSLATION_SCOPE];
const VISION_SCOPES: &[&str] = &[GOOGLE_CLOUD_VISION_SCOPE];
const TTS_SCOPES: &[&str] = &[GOOGLE_CLOUD_TEXT_TO_SPEECH_SCOPE];
const BAIDU_OCR_SCOPES: &[&str] = &[];

const BAIDU_CLIENT_CREDENTIALS_POLICY: AuthPolicyDriver = AuthPolicyDriver {
  auth_driver_id: BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID,
  audience_policy_id: BAIDU_OAUTH_AUDIENCE_POLICY_ID,
  capability_scopes: &[(OCR_IMAGE_CAPABILITY_ID, BAIDU_OCR_SCOPES)],
};

/// Privileged host auth policies that inject host-owned credentials into a request. Only
/// built-in content may request them: a user or development plugin must never receive a
/// host-minted token for a credential it does not own.
pub fn is_privileged_host_auth_policy(auth_policy_id: &str) -> bool {
  auth_policy_id == GOOGLE_SERVICE_ACCOUNT_AUTH_POLICY_ID || auth_policy_id == BAIDU_CLIENT_CREDENTIALS_AUTH_POLICY_ID
}

/// Look up the registered auth policy by auth driver id. Unknown drivers fail closed.
pub fn find_driver(auth_driver_id: &str) -> Option<&'static AuthPolicyDriver> {
  if auth_driver_id == GOOGLE_SERVICE_ACCOUNT_POLICY.auth_driver_id {
    Some(&GOOGLE_SERVICE_ACCOUNT_POLICY)
  } else if auth_driver_id == BAIDU_CLIENT_CREDENTIALS_POLICY.auth_driver_id {
    Some(&BAIDU_CLIENT_CREDENTIALS_POLICY)
  } else {
    None
  }
}

/// True when a driver's token-grant flow requires a non-empty OAuth scope set.
///
/// Baidu client-credentials is the only closed driver that legitimately exchanges with an empty
/// scope set; every other host driver fails closed when scopes are missing. This is the single
/// rule shared by package registration validation and token-grant request validation.
pub fn driver_requires_scopes(driver: &AuthPolicyDriver) -> bool {
  driver.auth_driver_id != BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID
}

/// Validate a token-grant request against the host-owned auth-policy registry. Rejects untrusted
/// drivers, unsupported audience policies, and scopes not approved for the requested capability.
pub fn validate_grant_request(request: &TokenGrantRequest) -> Result<(), CapabilityError> {
  let driver = find_driver(&request.auth_driver_id)
    .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::PermissionDenied, "untrusted auth driver"))?;
  if request.audience_policy_id != driver.audience_policy_id {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "unsupported audience policy",
    ));
  }
  // Same driver-scope rule as package registration: only Baidu client-credentials may exchange
  // with an empty scope set.
  if request.scopes.is_empty() && driver_requires_scopes(driver) {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "at least one OAuth scope is required",
    ));
  }
  if request.capability_id.trim().is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "capability_id is required",
    ));
  }
  validate_scopes_for_capability(&request.capability_id, &request.scopes, driver)
}

/// Validate a package-registration auth binding against closed host driver semantics.
///
/// Scope requirements are a property of each host driver: Baidu client-credentials accepts an
/// empty scope set before any instance credentials exist; Google service-account requires at
/// least one OAuth scope; unknown drivers fail closed. This seam validates static host metadata
/// only — it never consults credential bindings or the credential vault.
pub fn validate_registration_binding(
  binding: &crate::services::bundled_plugins::AuthPolicyBinding,
) -> Result<(), StorageError> {
  if binding.auth_policy_id.trim().is_empty()
    || binding.auth_driver_id.trim().is_empty()
    || binding.audience_policy_id.trim().is_empty()
  {
    return Err(StorageError::Validation(
      "auth policy binding for package is incomplete".into(),
    ));
  }
  let driver = find_driver(&binding.auth_driver_id).ok_or_else(|| {
    StorageError::Validation(format!(
      "auth policy binding uses unknown auth driver {}",
      binding.auth_driver_id
    ))
  })?;
  if binding.auth_policy_id != driver.auth_driver_id {
    return Err(StorageError::Validation(format!(
      "auth policy binding policy id {} does not match host driver {}",
      binding.auth_policy_id, driver.auth_driver_id
    )));
  }
  if binding.audience_policy_id != driver.audience_policy_id {
    return Err(StorageError::Validation(format!(
      "auth policy binding audience {} does not match host driver {}",
      binding.audience_policy_id, driver.audience_policy_id
    )));
  }
  if driver_requires_scopes(driver) && binding.scopes.is_empty() {
    return Err(StorageError::Validation(format!(
      "auth policy binding for driver {} requires at least one OAuth scope",
      driver.auth_driver_id
    )));
  }
  let approved: std::collections::HashSet<&str> = driver
    .capability_scopes
    .iter()
    .flat_map(|(_, scopes)| scopes.iter().copied())
    .collect();
  for scope in &binding.scopes {
    let trimmed = scope.trim();
    if trimmed.is_empty() {
      return Err(StorageError::Validation(
        "auth policy binding contains an empty OAuth scope".into(),
      ));
    }
    if !approved.contains(trimmed) {
      return Err(StorageError::Validation(format!(
        "auth policy binding scope {trimmed} is not approved for driver {}",
        driver.auth_driver_id
      )));
    }
  }
  Ok(())
}

/// Fail-closed scope allow-list for a capability under the given driver.
fn allowed_scopes_for_capability<'a>(
  capability_id: &str,
  driver: &'a AuthPolicyDriver,
) -> Result<&'a [&'static str], CapabilityError> {
  driver
    .capability_scopes
    .iter()
    .find(|(cap, _)| *cap == capability_id)
    .map(|(_, scopes)| *scopes)
    .ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "capability is not authorized for token grants",
      )
    })
}

/// Derive a least-privilege token request from the trusted Google auth policy and capability.
/// Callers cannot provide an audience or scope set of their choosing.
/// Validate the fixed Google Cloud package authority before a package can receive bearer auth.
/// Non-built-in packages cannot claim the first-party Google plugin id and redirect its token.
pub fn validate_google_cloud_manifest_authority(
  manifest: &PluginManifestV1,
  source: PluginSource,
) -> Result<(), String> {
  if manifest.id != crate::domain::service_integration::GOOGLE_CLOUD_PLUGIN_ID {
    return Ok(());
  }
  if !source.allows_privileged_host_auth() {
    return Err("Google Cloud runtime requires built-in plugin content".into());
  }
  if manifest.version != "1.2.0" || manifest.runtime.kind != RuntimeKind::WasmComponent {
    return Err("Google Cloud runtime identity is incompatible".into());
  }
  if manifest.permissions.auth_policies != vec![GOOGLE_SERVICE_ACCOUNT_AUTH_POLICY_ID.to_string()] {
    return Err("Google Cloud auth policy is not the host service-account policy".into());
  }
  if manifest.credential_slots.len() != 1
    || manifest.credential_slots[0].id != crate::domain::service_integration::GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT
    || manifest.credential_slots[0].kind != crate::domain::runtime_plugin::CredentialSlotKindV1::SecretJson
    || !manifest.credential_slots[0].required
  {
    return Err("Google Cloud credential slot authority is invalid".into());
  }
  let expected_capabilities = [
    (
      "translate.text@1",
      "schemas/translate-preferences.json",
      "translate/fixtures/langnext-google-cloud-translate.wasm",
    ),
    (
      "translate.detect@1",
      "schemas/translate-preferences.json",
      "detect/fixtures/langnext-google-cloud-detect.wasm",
    ),
    (
      "ocr.image@1",
      "schemas/ocr-preferences.json",
      "ocr/fixtures/langnext-google-cloud-ocr.wasm",
    ),
    (
      "speech.synthesize@1",
      "schemas/speech-preferences.json",
      "tts/fixtures/langnext-google-cloud-tts.wasm",
    ),
  ];
  if manifest.capabilities.len() != expected_capabilities.len()
    || expected_capabilities.iter().any(|(id, schema, artifact)| {
      !manifest.capabilities.iter().any(|capability| {
        capability.id == *id
          && capability.preferences_schema.as_deref() == Some(*schema)
          && capability.artifact.as_deref() == Some(*artifact)
      })
    })
  {
    return Err("Google Cloud capability authority is incomplete or widened".into());
  }
  let expected_endpoints = [
    ("translate", "https://translation.googleapis.com"),
    ("vision", "https://vision.googleapis.com"),
    ("text-to-speech", "https://texttospeech.googleapis.com"),
  ];
  if manifest.permissions.network.len() != expected_endpoints.len()
    || expected_endpoints.iter().any(|(id, origin)| {
      !manifest.permissions.network.iter().any(|endpoint| {
        endpoint.id == *id
          && endpoint.origins == vec![origin.to_string()]
          && endpoint.methods == vec![HttpMethod::Post]
          && endpoint.instance_origin_config_field.is_none()
      })
    })
  {
    return Err("Google Cloud endpoint authority is not fixed to the approved origins".into());
  }
  Ok(())
}

pub fn token_grant_request_for_capability(
  instance_id: uuid::Uuid,
  auth_policy_id: &str,
  capability_id: &str,
) -> Result<TokenGrantRequest, CapabilityError> {
  if auth_policy_id == BAIDU_CLIENT_CREDENTIALS_AUTH_POLICY_ID {
    let driver = find_driver(BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID).ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "Baidu auth policy is unavailable",
      )
    })?;
    let _allowed = allowed_scopes_for_capability(capability_id, driver)?;
    return Ok(TokenGrantRequest {
      instance_id,
      capability_id: capability_id.to_string(),
      auth_driver_id: driver.auth_driver_id.to_string(),
      scopes: Vec::new(),
      audience_policy_id: driver.audience_policy_id.to_string(),
    });
  }
  if auth_policy_id != GOOGLE_SERVICE_ACCOUNT_AUTH_POLICY_ID {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "untrusted auth policy",
    ));
  }
  let driver = find_driver(GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID).ok_or_else(|| {
    CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "Google auth policy is unavailable",
    )
  })?;
  let allowed = allowed_scopes_for_capability(capability_id, driver)?;
  Ok(TokenGrantRequest {
    instance_id,
    capability_id: capability_id.to_string(),
    auth_driver_id: driver.auth_driver_id.to_string(),
    scopes: allowed.iter().map(|scope| (*scope).to_string()).collect(),
    audience_policy_id: driver.audience_policy_id.to_string(),
  })
}

fn validate_scopes_for_capability(
  capability_id: &str,
  scopes: &[String],
  driver: &AuthPolicyDriver,
) -> Result<(), CapabilityError> {
  let allowed = allowed_scopes_for_capability(capability_id, driver)?;
  for scope in scopes {
    let trimmed = scope.trim();
    if trimmed.is_empty() {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        "OAuth scope must not be empty",
      ));
    }
    if !allowed.iter().any(|allowed_scope| *allowed_scope == trimmed) {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "OAuth scope is not allowed for this capability",
      ));
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn request(driver: &str, audience: &str, capability: &str, scopes: &[&str]) -> TokenGrantRequest {
    TokenGrantRequest {
      instance_id: uuid::Uuid::nil(),
      capability_id: capability.into(),
      auth_driver_id: driver.into(),
      scopes: scopes.iter().map(|s| s.to_string()).collect(),
      audience_policy_id: audience.into(),
    }
  }

  #[test]
  fn rejects_untrusted_driver() {
    let err = validate_grant_request(&request(
      "com.evil",
      GOOGLE_OAUTH_AUDIENCE_POLICY_ID,
      "translate.text@1",
      &[GOOGLE_CLOUD_TRANSLATION_SCOPE],
    ))
    .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[test]
  fn rejects_unsupported_audience() {
    let err = validate_grant_request(&request(
      GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID,
      "other-audience",
      "translate.text@1",
      &[GOOGLE_CLOUD_TRANSLATION_SCOPE],
    ))
    .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[test]
  fn rejects_scope_not_approved_for_capability() {
    let err = validate_grant_request(&request(
      GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID,
      GOOGLE_OAUTH_AUDIENCE_POLICY_ID,
      "translate.text@1",
      &[GOOGLE_CLOUD_VISION_SCOPE],
    ))
    .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[test]
  fn approves_valid_translation_grant() {
    validate_grant_request(&request(
      GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID,
      GOOGLE_OAUTH_AUDIENCE_POLICY_ID,
      "translate.text@1",
      &[GOOGLE_CLOUD_TRANSLATION_SCOPE],
    ))
    .unwrap();
  }

  fn registration_binding(
    driver: &str,
    audience: &str,
    scopes: &[&str],
  ) -> crate::services::bundled_plugins::AuthPolicyBinding {
    crate::services::bundled_plugins::AuthPolicyBinding {
      auth_policy_id: driver.into(),
      auth_driver_id: driver.into(),
      audience_policy_id: audience.into(),
      scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
    }
  }

  /// Baidu client-credentials registers with an empty OAuth scope set before any instance
  /// credentials exist. Registration validation must never consult user credentials.
  #[test]
  fn baidu_registration_binding_accepts_empty_scopes_before_credentials_exist() {
    validate_registration_binding(&registration_binding(
      BAIDU_CLIENT_CREDENTIALS_AUTH_DRIVER_ID,
      BAIDU_OAUTH_AUDIENCE_POLICY_ID,
      &[],
    ))
    .expect("Baidu client-credentials must register with an empty scope set");
  }

  /// Google service-account OAuth requires a non-empty scope set at registration time.
  #[test]
  fn google_registration_binding_rejects_empty_scopes() {
    let err = validate_registration_binding(&registration_binding(
      GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID,
      GOOGLE_OAUTH_AUDIENCE_POLICY_ID,
      &[],
    ))
    .expect_err("Google service-account registration without scopes must fail");
    assert!(err.to_string().contains("scope"), "got {err}");

    validate_registration_binding(&registration_binding(
      GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID,
      GOOGLE_OAUTH_AUDIENCE_POLICY_ID,
      &[GOOGLE_CLOUD_TRANSLATION_SCOPE],
    ))
    .expect("Google registration with approved scopes passes");
  }

  /// Unknown auth drivers fail closed for package registration binding.
  #[test]
  fn unknown_registration_auth_driver_fails_closed() {
    let err = validate_registration_binding(&registration_binding(
      "com.example.auth.unknown",
      GOOGLE_OAUTH_AUDIENCE_POLICY_ID,
      &[GOOGLE_CLOUD_TRANSLATION_SCOPE],
    ))
    .expect_err("unknown registration auth driver must fail closed");
    assert!(err.to_string().contains("unknown auth driver"), "got {err}");
  }

  /// Registration scopes are an exact allow-list per driver; unapproved scopes fail closed.
  #[test]
  fn registration_binding_rejects_scope_not_approved_for_driver() {
    let err = validate_registration_binding(&registration_binding(
      GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID,
      GOOGLE_OAUTH_AUDIENCE_POLICY_ID,
      &["https://example.com/unapproved-scope"],
    ))
    .expect_err("unapproved registration scope must fail closed");
    assert!(err.to_string().contains("not approved"), "got {err}");
  }
}
