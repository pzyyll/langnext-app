// ABOUTME: Integration instance SQL CRUD with optimistic concurrency on updated_at.
// ABOUTME: Credential refs live in integration_credential_bindings, not this table.
use crate::domain::service_integration::{IntegrationDependencyDto, IntegrationHealthStatus, IntegrationInstance};
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<IntegrationInstance, rusqlite::Error> {
  let id: String = row.get("id")?;
  let health_status: String = row.get("health_status")?;
  let enabled: i64 = row.get("enabled")?;
  let config_schema_version: i64 = row.get("config_schema_version")?;
  Ok(IntegrationInstance {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    plugin_id: row.get("plugin_id")?,
    plugin_version: row.get("plugin_version")?,
    display_name: row.get("display_name")?,
    enabled: enabled != 0,
    config_json: row.get("config_json")?,
    config_schema_version: u32::try_from(config_schema_version)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Integer, Box::new(e)))?,
    health_status: IntegrationHealthStatus::parse(&health_status)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
    last_validated_at: row.get("last_validated_at")?,
    last_error_code: row.get("last_error_code")?,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

pub fn list(conn: &Connection) -> Result<Vec<IntegrationInstance>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM integration_instances
     ORDER BY display_name ASC, created_at ASC, id ASC",
  )?;
  let rows = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn list_by_plugin(conn: &Connection, plugin_id: &str) -> Result<Vec<IntegrationInstance>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM integration_instances
     WHERE plugin_id = ?1
     ORDER BY display_name ASC, created_at ASC, id ASC",
  )?;
  let rows = stmt
    .query_map(params![plugin_id], map_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get(conn: &Connection, id: Uuid) -> Result<IntegrationInstance, StorageError> {
  conn
    .query_row(
      "SELECT * FROM integration_instances WHERE id = ?1",
      params![id.to_string()],
      map_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("integration instance {id}")))
}

pub fn insert(conn: &Connection, instance: &IntegrationInstance) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO integration_instances (
            id, plugin_id, plugin_version, display_name, enabled,
            config_json, config_schema_version, health_status,
            last_validated_at, last_error_code, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
      params![
        instance.id.to_string(),
        instance.plugin_id,
        instance.plugin_version,
        instance.display_name,
        instance.enabled as i64,
        instance.config_json,
        instance.config_schema_version as i64,
        instance.health_status.as_str(),
        instance.last_validated_at,
        instance.last_error_code,
        instance.created_at,
        instance.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "integration instance"))?;
  Ok(())
}

/// Compare-and-set update of non-secret instance fields using expected updated_at.
pub fn compare_and_set(
  conn: &Connection,
  id: Uuid,
  expected_updated_at: &str,
  display_name: &str,
  enabled: bool,
  config_json: &str,
  config_schema_version: u32,
  health_status: IntegrationHealthStatus,
  last_validated_at: Option<&str>,
  last_error_code: Option<&str>,
  updated_at: &str,
) -> Result<(), StorageError> {
  let changed = conn
    .execute(
      "UPDATE integration_instances SET
            display_name = ?3,
            enabled = ?4,
            config_json = ?5,
            config_schema_version = ?6,
            health_status = ?7,
            last_validated_at = ?8,
            last_error_code = ?9,
            updated_at = ?10
         WHERE id = ?1 AND updated_at = ?2",
      params![
        id.to_string(),
        expected_updated_at,
        display_name,
        enabled as i64,
        config_json,
        config_schema_version as i64,
        health_status.as_str(),
        last_validated_at,
        last_error_code,
        updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "integration instance"))?;
  if changed == 0 {
    // Distinguish missing vs concurrent update.
    match get(conn, id) {
      Ok(_) => {
        return Err(StorageError::Conflict(
          "integration instance changed concurrently".into(),
        ));
      }
      Err(StorageError::NotFound(_)) => {
        return Err(StorageError::NotFound(format!("integration instance {id}")));
      }
      Err(e) => return Err(e),
    }
  }
  Ok(())
}

pub fn set_enabled(conn: &Connection, id: Uuid, enabled: bool, updated_at: &str) -> Result<(), StorageError> {
  let changed = conn.execute(
    "UPDATE integration_instances SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
    params![id.to_string(), enabled as i64, updated_at],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("integration instance {id}")));
  }
  Ok(())
}

/// Update only health / validation metadata (local validate path).
pub fn update_health(
  conn: &Connection,
  id: Uuid,
  expected_updated_at: &str,
  health_status: IntegrationHealthStatus,
  last_validated_at: Option<&str>,
  last_error_code: Option<&str>,
  updated_at: &str,
) -> Result<(), StorageError> {
  let changed = conn.execute(
    "UPDATE integration_instances SET
          health_status = ?3,
          last_validated_at = ?4,
          last_error_code = ?5,
          updated_at = ?6
       WHERE id = ?1 AND updated_at = ?2",
    params![
      id.to_string(),
      expected_updated_at,
      health_status.as_str(),
      last_validated_at,
      last_error_code,
      updated_at,
    ],
  )?;
  if changed == 0 {
    match get(conn, id) {
      Ok(_) => {
        return Err(StorageError::Conflict(
          "integration instance changed concurrently".into(),
        ));
      }
      Err(StorageError::NotFound(_)) => {
        return Err(StorageError::NotFound(format!("integration instance {id}")));
      }
      Err(e) => return Err(e),
    }
  }
  Ok(())
}

pub fn delete(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
  let changed = conn
    .execute(
      "DELETE FROM integration_instances WHERE id = ?1",
      params![id.to_string()],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "integration instance"))?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("integration instance {id}")));
  }
  Ok(())
}

/// Dependency query hook for delete guards.
///
/// Returns translation profiles bound to this integration instance (plugin engine).
pub fn list_dependencies(conn: &Connection, id: Uuid) -> Result<Vec<IntegrationDependencyDto>, StorageError> {
  get(conn, id)?;
  let profiles = crate::repositories::translation_profiles::list_by_integration_instance(conn, id)?;
  Ok(
    profiles
      .into_iter()
      .map(|profile| IntegrationDependencyDto {
        kind: "translation_profile".into(),
        id: profile.id,
        display_name: profile.name,
      })
      .collect(),
  )
}
