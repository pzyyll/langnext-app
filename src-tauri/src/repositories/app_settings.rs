// ABOUTME: Singleton portable application settings document persistence.
// ABOUTME: Validates schema_version and deserializes value_json into AppSettingsV1.
use crate::domain::settings::AppSettingsV1;
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use rusqlite::{Connection, params};

pub fn get(conn: &Connection) -> Result<AppSettingsV1, StorageError> {
  let (schema_version, value_json): (i64, String) = conn.query_row(
    "SELECT schema_version, value_json FROM app_settings WHERE id = 1",
    [],
    |row| Ok((row.get(0)?, row.get(1)?)),
  )?;
  if schema_version != AppSettingsV1::SCHEMA_VERSION as i64 {
    return Err(StorageError::Validation(format!(
      "unsupported settings schema_version {schema_version}"
    )));
  }
  let settings: AppSettingsV1 = serde_json::from_str(&value_json)?;
  if settings.schema_version != AppSettingsV1::SCHEMA_VERSION {
    return Err(StorageError::Validation(format!(
      "settings document schema_version mismatch: {}",
      settings.schema_version
    )));
  }
  Ok(settings)
}

pub fn update(conn: &Connection, settings: &AppSettingsV1) -> Result<(), StorageError> {
  if settings.schema_version != AppSettingsV1::SCHEMA_VERSION {
    return Err(StorageError::Validation(format!(
      "unsupported settings schema_version {}",
      settings.schema_version
    )));
  }
  // Round-trip validation.
  let value_json = serde_json::to_string(settings)?;
  let _: AppSettingsV1 = serde_json::from_str(&value_json)?;
  let updated_at = now_rfc3339();
  let changed = conn.execute(
    "UPDATE app_settings SET schema_version = ?1, value_json = ?2, updated_at = ?3 WHERE id = 1",
    params![AppSettingsV1::SCHEMA_VERSION as i64, value_json, updated_at],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound("app_settings".into()));
  }
  Ok(())
}
