// ABOUTME: Crash-recovery journal for plugin package install staging transitions.
// ABOUTME: Tracks prepared/verified/db_committed/finalized/failed without executing packages.
use crate::domain::plugin_package::{InstallOperationState, PluginInstallOperation};
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<PluginInstallOperation, rusqlite::Error> {
  let id: String = row.get("id")?;
  let state: String = row.get("state")?;
  Ok(PluginInstallOperation {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    package_digest: row.get("package_digest")?,
    staging_path: row.get("staging_path")?,
    state: InstallOperationState::parse(&state).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
      )
    })?,
    error_code: row.get("error_code")?,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

pub fn insert_prepared(
  conn: &Connection,
  id: Uuid,
  staging_path: &str,
) -> Result<PluginInstallOperation, StorageError> {
  let now = now_rfc3339();
  conn.execute(
    "INSERT INTO plugin_install_operations (
          id, package_digest, staging_path, state, error_code, created_at, updated_at
      ) VALUES (?1, NULL, ?2, 'prepared', NULL, ?3, ?4)",
    params![id.to_string(), staging_path, now, now],
  )?;
  Ok(PluginInstallOperation {
    id,
    package_digest: None,
    staging_path: staging_path.to_string(),
    state: InstallOperationState::Prepared,
    error_code: None,
    created_at: now.clone(),
    updated_at: now,
  })
}

pub fn get(conn: &Connection, id: Uuid) -> Result<PluginInstallOperation, StorageError> {
  conn
    .query_row(
      "SELECT * FROM plugin_install_operations WHERE id = ?1",
      params![id.to_string()],
      map_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("plugin install operation {id}")))
}

pub fn get_optional(conn: &Connection, id: Uuid) -> Result<Option<PluginInstallOperation>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_install_operations WHERE id = ?1",
        params![id.to_string()],
        map_row,
      )
      .optional()?,
  )
}

pub fn list_unfinished(conn: &Connection) -> Result<Vec<PluginInstallOperation>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM plugin_install_operations
     WHERE state IN ('prepared', 'verified', 'db_committed')
     ORDER BY created_at ASC, id ASC",
  )?;
  let rows = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn mark_verified(
  conn: &Connection,
  id: Uuid,
  package_digest: &str,
) -> Result<PluginInstallOperation, StorageError> {
  let now = now_rfc3339();
  let changed = conn.execute(
    "UPDATE plugin_install_operations SET
          package_digest = ?2,
          state = 'verified',
          error_code = NULL,
          updated_at = ?3
       WHERE id = ?1 AND state = 'prepared'",
    params![id.to_string(), package_digest, now],
  )?;
  if changed == 0 {
    return Err(StorageError::Conflict(format!(
      "install operation {id} is not prepared"
    )));
  }
  get(conn, id)
}

pub fn mark_db_committed(conn: &Connection, id: Uuid) -> Result<PluginInstallOperation, StorageError> {
  let now = now_rfc3339();
  let changed = conn.execute(
    "UPDATE plugin_install_operations SET
          state = 'db_committed',
          updated_at = ?2
       WHERE id = ?1 AND state = 'verified'",
    params![id.to_string(), now],
  )?;
  if changed == 0 {
    return Err(StorageError::Conflict(format!(
      "install operation {id} is not verified"
    )));
  }
  get(conn, id)
}

pub fn mark_finalized(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
  let now = now_rfc3339();
  let changed = conn.execute(
    "UPDATE plugin_install_operations SET
          state = 'finalized',
          updated_at = ?2
       WHERE id = ?1 AND state IN ('verified', 'db_committed')",
    params![id.to_string(), now],
  )?;
  if changed == 0 {
    return Err(StorageError::Conflict(format!(
      "install operation {id} cannot be finalized"
    )));
  }
  Ok(())
}

pub fn mark_failed(conn: &Connection, id: Uuid, error_code: &str) -> Result<(), StorageError> {
  let now = now_rfc3339();
  conn.execute(
    "UPDATE plugin_install_operations SET
          state = 'failed',
          error_code = ?2,
          updated_at = ?3
       WHERE id = ?1",
    params![id.to_string(), error_code, now],
  )?;
  Ok(())
}

pub fn delete(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM plugin_install_operations WHERE id = ?1",
    params![id.to_string()],
  )?;
  Ok(())
}
