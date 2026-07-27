// ABOUTME: Host-owned auth-policy registry and drivers for service-integration token grants.
// ABOUTME: A manifest never carries executable auth logic; drivers live here and bind by host id.
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, OCR_IMAGE_CAPABILITY_ID, SPEECH_SYNTHESIZE_CAPABILITY_ID,
};
use crate::services::google_cloud::{GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID};
use crate::services::token_grant::TokenGrantRequest;

/// Host-defined auth driver id for the Google service-account OAuth2 exchange.
pub const GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID: &str = "com.langnext.auth.google-service-account";
/// Host-defined audience policy id for the Google OAuth2 token endpoint.
pub const GOOGLE_OAUTH_AUDIENCE_POLICY_ID: &str = "google-oauth-token";
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

/// Look up the registered auth policy by auth driver id. Unknown drivers fail closed.
pub fn find_driver(auth_driver_id: &str) -> Option<&'static AuthPolicyDriver> {
  if auth_driver_id == GOOGLE_SERVICE_ACCOUNT_POLICY.auth_driver_id {
    Some(&GOOGLE_SERVICE_ACCOUNT_POLICY)
  } else {
    None
  }
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
  if request.scopes.is_empty() {
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
}
