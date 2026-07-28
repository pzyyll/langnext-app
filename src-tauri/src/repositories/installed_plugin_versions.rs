// ABOUTME: SQLite access for immutable installed plugin package versions and defaults.
// ABOUTME: Content availability is tracked separately from instance bindings.
use crate::domain::plugin_package::{InstalledPluginVersion, PluginDefaultVersion};
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};

fn map_version(row: &Row<'_>) -> Result<InstalledPluginVersion, rusqlite::Error> {
  let content_available: i64 = row.get("content_available")?;
  Ok(InstalledPluginVersion {
    package_digest: row.get("package_digest")?,
    plugin_id: row.get("plugin_id")?,
    version: row.get("version")?,
    publisher_key_id: row.get("publisher_key_id")?,
    publisher_fingerprint: row.get("publisher_fingerprint")?,
    runtime_kind: row.get("runtime_kind")?,
    manifest_json: row.get("manifest_json")?,
    permission_request_digest: row.get("permission_request_digest")?,
    content_available: content_available != 0,
    installed_at: row.get("installed_at")?,
  })
}

fn map_default(row: &Row<'_>) -> Result<PluginDefaultVersion, rusqlite::Error> {
  Ok(PluginDefaultVersion {
    plugin_id: row.get("plugin_id")?,
    package_digest: row.get("package_digest")?,
    updated_at: row.get("updated_at")?,
  })
}

pub fn list(conn: &Connection) -> Result<Vec<InstalledPluginVersion>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM installed_plugin_versions
     ORDER BY plugin_id ASC, version ASC, package_digest ASC",
  )?;
  let rows = stmt.query_map([], map_version)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn list_by_plugin(conn: &Connection, plugin_id: &str) -> Result<Vec<InstalledPluginVersion>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM installed_plugin_versions
     WHERE plugin_id = ?1
     ORDER BY version ASC, package_digest ASC",
  )?;
  let rows = stmt
    .query_map(params![plugin_id], map_version)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get(conn: &Connection, package_digest: &str) -> Result<InstalledPluginVersion, StorageError> {
  conn
    .query_row(
      "SELECT * FROM installed_plugin_versions WHERE package_digest = ?1",
      params![package_digest],
      map_version,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("installed plugin version {package_digest}")))
}

pub fn get_optional(conn: &Connection, package_digest: &str) -> Result<Option<InstalledPluginVersion>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM installed_plugin_versions WHERE package_digest = ?1",
        params![package_digest],
        map_version,
      )
      .optional()?,
  )
}

pub fn get_by_plugin_version(
  conn: &Connection,
  plugin_id: &str,
  version: &str,
) -> Result<Option<InstalledPluginVersion>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM installed_plugin_versions WHERE plugin_id = ?1 AND version = ?2",
        params![plugin_id, version],
        map_version,
      )
      .optional()?,
  )
}

pub fn insert(conn: &Connection, version: &InstalledPluginVersion) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO installed_plugin_versions (
            package_digest, plugin_id, version, publisher_key_id, publisher_fingerprint,
            runtime_kind, manifest_json, permission_request_digest, content_available, installed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
      params![
        version.package_digest,
        version.plugin_id,
        version.version,
        version.publisher_key_id,
        version.publisher_fingerprint,
        version.runtime_kind,
        version.manifest_json,
        version.permission_request_digest,
        version.content_available as i64,
        version.installed_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "installed plugin version"))?;
  Ok(())
}

pub fn set_content_available(conn: &Connection, package_digest: &str, available: bool) -> Result<(), StorageError> {
  let changed = conn.execute(
    "UPDATE installed_plugin_versions SET content_available = ?2 WHERE package_digest = ?1",
    params![package_digest, available as i64],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!(
      "installed plugin version {package_digest}"
    )));
  }
  Ok(())
}

/// Atomic content_available CAS used as the uninstall protection gate.
pub fn compare_and_set_content_available(
  conn: &Connection,
  package_digest: &str,
  expected: bool,
  next: bool,
) -> Result<(), StorageError> {
  let changed = conn.execute(
    "UPDATE installed_plugin_versions
     SET content_available = ?3
     WHERE package_digest = ?1 AND content_available = ?2",
    params![package_digest, expected as i64, next as i64],
  )?;
  if changed == 0 {
    match get_optional(conn, package_digest)? {
      Some(_) => Err(StorageError::Conflict(format!(
        "package {package_digest} content_available changed concurrently"
      ))),
      None => Err(StorageError::NotFound(format!(
        "installed plugin version {package_digest}"
      ))),
    }
  } else {
    Ok(())
  }
}

pub fn delete(conn: &Connection, package_digest: &str) -> Result<(), StorageError> {
  let changed = conn.execute(
    "DELETE FROM installed_plugin_versions WHERE package_digest = ?1",
    params![package_digest],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!(
      "installed plugin version {package_digest}"
    )));
  }
  Ok(())
}

pub fn get_default(conn: &Connection, plugin_id: &str) -> Result<Option<PluginDefaultVersion>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_default_versions WHERE plugin_id = ?1",
        params![plugin_id],
        map_default,
      )
      .optional()?,
  )
}

pub fn list_defaults(conn: &Connection) -> Result<Vec<PluginDefaultVersion>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM plugin_default_versions
     ORDER BY plugin_id ASC",
  )?;
  let rows = stmt.query_map([], map_default)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn set_default(
  conn: &Connection,
  plugin_id: &str,
  package_digest: &str,
) -> Result<PluginDefaultVersion, StorageError> {
  let version = get(conn, package_digest)?;
  if version.plugin_id != plugin_id {
    return Err(StorageError::Validation(format!(
      "package {package_digest} belongs to plugin {}, not {plugin_id}",
      version.plugin_id
    )));
  }
  if !version.content_available {
    return Err(StorageError::PluginUnavailable(format!(
      "package {package_digest} content is unavailable"
    )));
  }
  let updated_at = now_rfc3339();
  conn.execute(
    "INSERT INTO plugin_default_versions (plugin_id, package_digest, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(plugin_id) DO UPDATE SET
       package_digest = excluded.package_digest,
       updated_at = excluded.updated_at",
    params![plugin_id, package_digest, updated_at],
  )?;
  Ok(PluginDefaultVersion {
    plugin_id: plugin_id.to_string(),
    package_digest: package_digest.to_string(),
    updated_at,
  })
}

pub fn clear_default_if_matches(conn: &Connection, package_digest: &str) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM plugin_default_versions WHERE package_digest = ?1",
    params![package_digest],
  )?;
  Ok(())
}

/// Count integration instances that reference this plugin_id + version string.
/// Phase 4 will pin digests; Phase 3 uses plugin_id/version as the dependency signal.
pub fn count_integration_users(conn: &Connection, plugin_id: &str, version: &str) -> Result<Vec<String>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT id FROM integration_instances
     WHERE plugin_id = ?1 AND plugin_version = ?2
     ORDER BY id ASC",
  )?;
  let rows = stmt
    .query_map(params![plugin_id, version], |row| row.get::<_, String>(0))?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}
