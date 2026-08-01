// ABOUTME: SQLite repository boundary for independent integration capability health rows.
// ABOUTME: Upserts only sanitized status/error-code metadata and scopes every operation by instance.
use crate::domain::integration_capability_health::{CapabilityHealthRecord, CapabilityHealthStatus};
use crate::domain::service_integration::validate_capability_id;
use crate::error::StorageError;
use rusqlite::{Connection, Row, params};
use uuid::Uuid;

const ERROR_CODE_MAX_LEN: usize = 64;
const ALLOWED_ERROR_CODES: &[&str] = &[
  "invalid_configuration",
  "invalid_request",
  "auth",
  "permission_denied",
  "endpoint_trust_required",
  "quota_exceeded",
  "rate_limited",
  "unsupported_input",
  "unsupported_language",
  "network",
  "timeout",
  "invalid_response",
  "provider_unavailable",
  "plugin_unavailable",
  "cancelled",
  "internal",
];

fn map_row(row: &Row<'_>) -> Result<CapabilityHealthRecord, rusqlite::Error> {
  let instance_id: String = row.get("integration_instance_id")?;
  let status: String = row.get("status")?;
  Ok(CapabilityHealthRecord {
    integration_instance_id: Uuid::parse_str(&instance_id)
      .map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error)))?,
    capability_id: row.get("capability_id")?,
    status: CapabilityHealthStatus::parse(&status)
      .map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, error.into()))?,
    error_code: row.get("error_code")?,
    checked_at: row.get("checked_at")?,
  })
}

fn validate_error_code(error_code: Option<&str>) -> Result<(), StorageError> {
  let Some(error_code) = error_code else { return Ok(()) };
  if error_code.is_empty()
    || error_code.len() > ERROR_CODE_MAX_LEN
    || !error_code
      .bytes()
      .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    || !ALLOWED_ERROR_CODES.contains(&error_code)
  {
    return Err(StorageError::Validation(
      "capability health error code is invalid".into(),
    ));
  }
  Ok(())
}

pub fn upsert_result(
  conn: &Connection,
  integration_instance_id: Uuid,
  capability_id: &str,
  status: CapabilityHealthStatus,
  error_code: Option<&str>,
  checked_at: &str,
) -> Result<(), StorageError> {
  validate_capability_id(capability_id).map_err(StorageError::Validation)?;
  validate_error_code(error_code)?;
  conn.execute(
    "INSERT INTO integration_capability_health (
       integration_instance_id, capability_id, status, error_code, checked_at
     ) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(integration_instance_id, capability_id) DO UPDATE SET
       status = excluded.status,
       error_code = excluded.error_code,
       checked_at = excluded.checked_at",
    params![
      integration_instance_id.to_string(),
      capability_id,
      status.as_str(),
      error_code,
      checked_at,
    ],
  )?;
  Ok(())
}

pub fn upsert(conn: &Connection, record: &CapabilityHealthRecord) -> Result<(), StorageError> {
  upsert_result(
    conn,
    record.integration_instance_id,
    &record.capability_id,
    record.status,
    record.error_code.as_deref(),
    &record.checked_at,
  )
}

pub fn list_for_instance(
  conn: &Connection,
  integration_instance_id: Uuid,
) -> Result<Vec<CapabilityHealthRecord>, StorageError> {
  let mut statement = conn.prepare(
    "SELECT integration_instance_id, capability_id, status, error_code, checked_at
     FROM integration_capability_health
     WHERE integration_instance_id = ?1
     ORDER BY capability_id ASC",
  )?;
  let rows = statement
    .query_map(params![integration_instance_id.to_string()], map_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn delete_for_instance(conn: &Connection, integration_instance_id: Uuid) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM integration_capability_health WHERE integration_instance_id = ?1",
    params![integration_instance_id.to_string()],
  )?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::integration_capability_health::CapabilityHealthStatus;
  use crate::domain::service_integration::{IntegrationHealthStatus, IntegrationInstance};
  use crate::domain::time::now_rfc3339;
  use crate::repositories::integration_instances;
  use crate::storage::Database;

  fn setup() -> (tempfile::TempDir, Database, Uuid) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = Uuid::now_v7();
    let now = now_rfc3339();
    db.transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &IntegrationInstance {
          id,
          plugin_id: "com.langnext.google-cloud".into(),
          plugin_version: "1.2.0".into(),
          display_name: "Google Cloud".into(),
          enabled: true,
          config_json: "{}".into(),
          config_schema_version: 1,
          health_status: IntegrationHealthStatus::Ready,
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
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();
    (dir, db, id)
  }

  #[test]
  fn integration_capability_health_round_trip_is_scoped_by_instance_and_capability() {
    let (_dir, db, id) = setup();
    db.transaction(|uow| {
      upsert_result(
        uow.conn(),
        id,
        "translate.text@1",
        CapabilityHealthStatus::Degraded,
        Some("permission_denied"),
        "t1",
      )?;
      upsert_result(uow.conn(), id, "ocr.image@1", CapabilityHealthStatus::Ready, None, "t2")?;
      upsert_result(
        uow.conn(),
        id,
        "translate.text@1",
        CapabilityHealthStatus::Ready,
        None,
        "t3",
      )?;
      Ok(())
    })
    .unwrap();
    let rows = db.read(|conn| list_for_instance(conn, id)).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].capability_id, "ocr.image@1");
    assert_eq!(rows[1].status, CapabilityHealthStatus::Ready);
    assert_eq!(rows[1].checked_at, "t3");
  }
}
