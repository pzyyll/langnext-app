// ABOUTME: SQLite access for host-owned plugin upgrade rollback snapshots.
// ABOUTME: Snapshots never store secrets, credential refs, or package artifacts.
use crate::domain::runtime_lifecycle::{PluginUpgradeSnapshot, PreferenceSnapshotRow};
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

fn parse_preferences(json: &str) -> Result<Vec<PreferenceSnapshotRow>, rusqlite::Error> {
  serde_json::from_str(json)
    .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

fn map_row(row: &Row<'_>) -> Result<PluginUpgradeSnapshot, rusqlite::Error> {
  let id: String = row.get("id")?;
  let instance_id: String = row.get("integration_instance_id")?;
  let grant_set_id: Option<String> = row.get("execution_grant_set_id")?;
  let revision: Option<i64> = row.get("execution_grant_set_revision")?;
  let config_schema_version: i64 = row.get("config_schema_version")?;
  let translation_json: String = row.get("translation_preferences_json")?;
  let ocr_json: String = row.get("ocr_preferences_json")?;
  let speech_json: String = row.get("speech_preferences_json")?;
  Ok(PluginUpgradeSnapshot {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    integration_instance_id: Uuid::parse_str(&instance_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    created_at: row.get("created_at")?,
    discarded_at: row.get("discarded_at")?,
    runtime_kind: row.get("runtime_kind")?,
    package_digest: row.get("package_digest")?,
    execution_grant_set_id: grant_set_id
      .map(|value| {
        Uuid::parse_str(&value)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
      })
      .transpose()?,
    execution_grant_set_revision: revision
      .map(|value| {
        u64::try_from(value)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Integer, Box::new(e)))
      })
      .transpose()?,
    plugin_version: row.get("plugin_version")?,
    config_json: row.get("config_json")?,
    config_schema_version: u32::try_from(config_schema_version)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Integer, Box::new(e)))?,
    grant_snapshot_json: row.get("grant_snapshot_json")?,
    translation_preferences: parse_preferences(&translation_json)?,
    ocr_preferences: parse_preferences(&ocr_json)?,
    speech_preferences: parse_preferences(&speech_json)?,
  })
}

pub fn insert(conn: &Connection, snapshot: &PluginUpgradeSnapshot) -> Result<(), StorageError> {
  let translation = serde_json::to_string(&snapshot.translation_preferences)?;
  let ocr = serde_json::to_string(&snapshot.ocr_preferences)?;
  let speech = serde_json::to_string(&snapshot.speech_preferences)?;
  conn
    .execute(
      "INSERT INTO plugin_upgrade_snapshots (
            id, integration_instance_id, created_at, discarded_at,
            runtime_kind, package_digest, execution_grant_set_id, execution_grant_set_revision,
            plugin_version, config_json, config_schema_version, grant_snapshot_json,
            translation_preferences_json, ocr_preferences_json, speech_preferences_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
      params![
        snapshot.id.to_string(),
        snapshot.integration_instance_id.to_string(),
        snapshot.created_at,
        snapshot.discarded_at,
        snapshot.runtime_kind,
        snapshot.package_digest,
        snapshot.execution_grant_set_id.map(|id| id.to_string()),
        snapshot.execution_grant_set_revision.map(|v| v as i64),
        snapshot.plugin_version,
        snapshot.config_json,
        snapshot.config_schema_version as i64,
        snapshot.grant_snapshot_json,
        translation,
        ocr,
        speech,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "plugin upgrade snapshot"))?;
  Ok(())
}

pub fn get(conn: &Connection, id: Uuid) -> Result<PluginUpgradeSnapshot, StorageError> {
  conn
    .query_row(
      "SELECT * FROM plugin_upgrade_snapshots WHERE id = ?1",
      params![id.to_string()],
      map_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("plugin upgrade snapshot {id}")))
}

pub fn latest_for_instance(
  conn: &Connection,
  integration_instance_id: Uuid,
) -> Result<Option<PluginUpgradeSnapshot>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_upgrade_snapshots
         WHERE integration_instance_id = ?1 AND discarded_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1",
        params![integration_instance_id.to_string()],
        map_row,
      )
      .optional()?,
  )
}

pub fn list_active_for_instance(
  conn: &Connection,
  integration_instance_id: Uuid,
) -> Result<Vec<PluginUpgradeSnapshot>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM plugin_upgrade_snapshots
     WHERE integration_instance_id = ?1 AND discarded_at IS NULL
     ORDER BY created_at DESC",
  )?;
  let rows = stmt
    .query_map(params![integration_instance_id.to_string()], map_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn discard(conn: &Connection, id: Uuid, discarded_at: &str) -> Result<(), StorageError> {
  let changed = conn.execute(
    "UPDATE plugin_upgrade_snapshots
     SET discarded_at = ?2
     WHERE id = ?1 AND discarded_at IS NULL",
    params![id.to_string(), discarded_at],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("plugin upgrade snapshot {id}")));
  }
  Ok(())
}

/// True when any non-discarded snapshot still references the package digest.
pub fn package_referenced_by_snapshot(conn: &Connection, package_digest: &str) -> Result<bool, StorageError> {
  let count: i64 = conn.query_row(
    "SELECT COUNT(*) FROM plugin_upgrade_snapshots
     WHERE package_digest = ?1 AND discarded_at IS NULL",
    params![package_digest],
    |row| row.get(0),
  )?;
  Ok(count > 0)
}
