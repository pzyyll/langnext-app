// ABOUTME: Speech service CRUD against SQLite (list/get/insert/update/delete).
// ABOUTME: Capability preferences stay as validated JSON; no secrets in this table.
use crate::domain::speech_service::SpeechService;
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<SpeechService, rusqlite::Error> {
  let id: String = row.get("id")?;
  let integration_instance_id: String = row.get("integration_instance_id")?;
  let enabled: i64 = row.get("enabled")?;
  let preferences_schema_version: i64 = row.get("preferences_schema_version")?;
  let preferences_json: String = row.get("preferences_json")?;
  let preferences = serde_json::from_str::<Value>(&preferences_json)
    .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?;
  Ok(SpeechService {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    display_name: row.get("display_name")?,
    enabled: enabled != 0,
    sort_order: row.get("sort_order")?,
    integration_instance_id: Uuid::parse_str(&integration_instance_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    capability_id: row.get("capability_id")?,
    preferences_schema_version: i32::try_from(preferences_schema_version)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Integer, Box::new(e)))?,
    preferences,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

pub fn list(conn: &Connection) -> Result<Vec<SpeechService>, StorageError> {
  let mut stmt = conn.prepare("SELECT * FROM speech_services ORDER BY sort_order ASC, created_at ASC, id ASC")?;
  let rows = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn list_by_integration_instance(
  conn: &Connection,
  integration_instance_id: Uuid,
) -> Result<Vec<SpeechService>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM speech_services
     WHERE integration_instance_id = ?1
     ORDER BY sort_order ASC, created_at ASC, id ASC",
  )?;
  let rows = stmt
    .query_map(params![integration_instance_id.to_string()], map_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get(conn: &Connection, id: Uuid) -> Result<SpeechService, StorageError> {
  conn
    .query_row(
      "SELECT * FROM speech_services WHERE id = ?1",
      params![id.to_string()],
      map_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("speech service {id}")))
}

pub fn insert(conn: &Connection, service: &SpeechService) -> Result<(), StorageError> {
  let preferences_json = serde_json::to_string(&service.preferences)?;
  conn
    .execute(
      "INSERT INTO speech_services (
            id, display_name, enabled, sort_order,
            integration_instance_id, capability_id,
            preferences_schema_version, preferences_json,
            created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3,
            (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM speech_services),
            ?4, ?5, ?6, ?7, ?8, ?9
        )",
      params![
        service.id.to_string(),
        service.display_name,
        service.enabled as i64,
        service.integration_instance_id.to_string(),
        service.capability_id,
        service.preferences_schema_version,
        preferences_json,
        service.created_at,
        service.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "speech service"))?;
  Ok(())
}

pub fn update_configuration(
  conn: &Connection,
  id: Uuid,
  display_name: &str,
  enabled: bool,
  integration_instance_id: Uuid,
  capability_id: &str,
  preferences_schema_version: i32,
  preferences: &Value,
  updated_at: &str,
) -> Result<(), StorageError> {
  let preferences_json = serde_json::to_string(preferences)?;
  let changed = conn
    .execute(
      "UPDATE speech_services SET
            display_name = ?2,
            enabled = ?3,
            integration_instance_id = ?4,
            capability_id = ?5,
            preferences_schema_version = ?6,
            preferences_json = ?7,
            updated_at = ?8
         WHERE id = ?1",
      params![
        id.to_string(),
        display_name,
        enabled as i64,
        integration_instance_id.to_string(),
        capability_id,
        preferences_schema_version,
        preferences_json,
        updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "speech service"))?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("speech service {id}")));
  }
  Ok(())
}

pub fn delete(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
  let changed = conn
    .execute("DELETE FROM speech_services WHERE id = ?1", params![id.to_string()])
    .map_err(|e| StorageError::from_sqlite_constraint(e, "speech service"))?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("speech service {id}")));
  }
  Ok(())
}
