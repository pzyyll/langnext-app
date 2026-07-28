// ABOUTME: Crash-recovery journal for plugin package uninstall transitions.
// ABOUTME: Tracks prepared/content_quarantined/catalog_deleted/finalized without losing content or catalog consistency.
use crate::domain::plugin_package::{PluginUninstallOperation, UninstallOperationState};
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<PluginUninstallOperation, rusqlite::Error> {
  let id: String = row.get("id")?;
  let state: String = row.get("state")?;
  Ok(PluginUninstallOperation {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    package_digest: row.get("package_digest")?,
    quarantine_path: row.get("quarantine_path")?,
    state: UninstallOperationState::parse(&state).map_err(|e| {
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
  package_digest: &str,
) -> Result<PluginUninstallOperation, StorageError> {
  let now = now_rfc3339();
  conn.execute(
    "INSERT INTO plugin_uninstall_operations (
          id, package_digest, quarantine_path, state, error_code, created_at, updated_at
      ) VALUES (?1, ?2, NULL, 'prepared', NULL, ?3, ?4)",
    params![id.to_string(), package_digest, now, now],
  )?;
  Ok(PluginUninstallOperation {
    id,
    package_digest: package_digest.to_string(),
    quarantine_path: None,
    state: UninstallOperationState::Prepared,
    error_code: None,
    created_at: now.clone(),
    updated_at: now,
  })
}

pub fn get(conn: &Connection, id: Uuid) -> Result<PluginUninstallOperation, StorageError> {
  conn
    .query_row(
      "SELECT * FROM plugin_uninstall_operations WHERE id = ?1",
      params![id.to_string()],
      map_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("plugin uninstall operation {id}")))
}

pub fn list_unfinished(conn: &Connection) -> Result<Vec<PluginUninstallOperation>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM plugin_uninstall_operations
     WHERE state IN ('prepared', 'content_quarantined', 'catalog_deleted')
     ORDER BY created_at ASC, id ASC",
  )?;
  let rows = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn mark_content_quarantined(
  conn: &Connection,
  id: Uuid,
  quarantine_path: &str,
) -> Result<PluginUninstallOperation, StorageError> {
  let now = now_rfc3339();
  let changed = conn.execute(
    "UPDATE plugin_uninstall_operations SET
          quarantine_path = ?2,
          state = 'content_quarantined',
          error_code = NULL,
          updated_at = ?3
       WHERE id = ?1 AND state = 'prepared'",
    params![id.to_string(), quarantine_path, now],
  )?;
  if changed == 0 {
    return Err(StorageError::Conflict(format!(
      "uninstall operation {id} is not prepared"
    )));
  }
  get(conn, id)
}

pub fn mark_catalog_deleted(conn: &Connection, id: Uuid) -> Result<PluginUninstallOperation, StorageError> {
  let now = now_rfc3339();
  let changed = conn.execute(
    "UPDATE plugin_uninstall_operations SET
          state = 'catalog_deleted',
          updated_at = ?2
       WHERE id = ?1 AND state IN ('prepared', 'content_quarantined')",
    params![id.to_string(), now],
  )?;
  if changed == 0 {
    return Err(StorageError::Conflict(format!(
      "uninstall operation {id} cannot mark catalog_deleted"
    )));
  }
  get(conn, id)
}

pub fn mark_finalized(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
  let now = now_rfc3339();
  let changed = conn.execute(
    "UPDATE plugin_uninstall_operations SET
          state = 'finalized',
          updated_at = ?2
       WHERE id = ?1 AND state IN ('content_quarantined', 'catalog_deleted')",
    params![id.to_string(), now],
  )?;
  if changed == 0 {
    return Err(StorageError::Conflict(format!(
      "uninstall operation {id} cannot be finalized"
    )));
  }
  Ok(())
}

pub fn mark_failed(conn: &Connection, id: Uuid, error_code: &str) -> Result<(), StorageError> {
  let now = now_rfc3339();
  conn.execute(
    "UPDATE plugin_uninstall_operations SET
          state = 'failed',
          error_code = ?2,
          updated_at = ?3
       WHERE id = ?1",
    params![id.to_string(), error_code, now],
  )?;
  Ok(())
}
