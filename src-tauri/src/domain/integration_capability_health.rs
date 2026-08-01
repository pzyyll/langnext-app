// ABOUTME: Sanitized per-capability provider health records for integration instances.
// ABOUTME: Stores only ready/degraded state, stable error codes, capability ids, and timestamps.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityHealthStatus {
  Ready,
  Degraded,
}

impl CapabilityHealthStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Ready => "ready",
      Self::Degraded => "degraded",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "ready" => Ok(Self::Ready),
      "degraded" => Ok(Self::Degraded),
      other => Err(format!("invalid capability health status: {other}")),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityHealthRecord {
  pub integration_instance_id: Uuid,
  pub capability_id: String,
  pub status: CapabilityHealthStatus,
  pub error_code: Option<String>,
  pub checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityHealthDto {
  pub capability_id: String,
  pub status: CapabilityHealthStatus,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub error_code: Option<String>,
  pub checked_at: String,
}

impl CapabilityHealthRecord {
  pub fn dto(&self) -> CapabilityHealthDto {
    CapabilityHealthDto {
      capability_id: self.capability_id.clone(),
      status: self.status,
      error_code: self.error_code.clone(),
      checked_at: self.checked_at.clone(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn capability_health_status_is_closed_and_sanitized() {
    assert_eq!(CapabilityHealthStatus::Ready.as_str(), "ready");
    assert!(CapabilityHealthStatus::parse("provider-body").is_err());
    let record = CapabilityHealthRecord {
      integration_instance_id: Uuid::nil(),
      capability_id: "translate.text@1".into(),
      status: CapabilityHealthStatus::Degraded,
      error_code: Some("permission_denied".into()),
      checked_at: "2026-01-01T00:00:00Z".into(),
    };
    let dto = record.dto();
    assert_eq!(dto.capability_id, "translate.text@1");
    assert_eq!(dto.error_code.as_deref(), Some("permission_denied"));
  }
}
