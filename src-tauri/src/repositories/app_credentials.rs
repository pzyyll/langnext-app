// ABOUTME: Non-exported global proxy credential binding in app_credentials.
// ABOUTME: Compare-and-set updates prevent concurrent credential races.
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, params};

pub const GLOBAL_PROXY_SLOT: &str = "global_proxy";

pub fn get_global_proxy_ref(conn: &Connection) -> Result<Option<String>, StorageError> {
  let value: Option<Option<String>> = conn
    .query_row(
      "SELECT credential_ref FROM app_credentials WHERE slot = ?1",
      params![GLOBAL_PROXY_SLOT],
      |row| row.get(0),
    )
    .optional()?;
  Ok(value.flatten())
}

/// Compare-and-set the global proxy credential reference.
pub fn compare_and_set_global_proxy_ref(
  conn: &Connection,
  expected_old_ref: Option<&str>,
  new_ref: Option<&str>,
) -> Result<(), StorageError> {
  let updated_at = now_rfc3339();
  let changed = match expected_old_ref {
    Some(old) => conn.execute(
      "UPDATE app_credentials SET credential_ref = ?1, updated_at = ?2
             WHERE slot = ?3 AND credential_ref = ?4",
      params![new_ref, updated_at, GLOBAL_PROXY_SLOT, old],
    )?,
    None => conn.execute(
      "UPDATE app_credentials SET credential_ref = ?1, updated_at = ?2
             WHERE slot = ?3 AND credential_ref IS NULL",
      params![new_ref, updated_at, GLOBAL_PROXY_SLOT],
    )?,
  };
  if changed == 0 {
    return Err(StorageError::Conflict(
      "global proxy credential reference changed concurrently".into(),
    ));
  }
  Ok(())
}

pub fn clear_global_proxy_ref(conn: &Connection, expected_old_ref: Option<&str>) -> Result<(), StorageError> {
  compare_and_set_global_proxy_ref(conn, expected_old_ref, None)
}
