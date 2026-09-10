// ABOUTME: SQLite access for user-installed plugin archives and explicit default overrides.
// ABOUTME: Built-in and development content is never stored; identity is the content digest.
use crate::domain::plugin_catalog::{CatalogDefault, UserPluginArchive, validate_content_digest};
use crate::domain::runtime_lifecycle::{parse_runtime_kind, runtime_kind_as_str};
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};

fn map_archive(row: &Row<'_>) -> Result<UserPluginArchive, rusqlite::Error> {
  let runtime_kind: String = row.get("runtime_kind")?;
  Ok(UserPluginArchive {
    content_digest: row.get("content_digest")?,
    plugin_id: row.get("plugin_id")?,
    version: row.get("version")?,
    runtime_kind: parse_runtime_kind(&runtime_kind).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
      )
    })?,
    manifest_json: row.get("manifest_json")?,
    permission_request_digest: row.get("permission_request_digest")?,
    file_name: row.get("file_name")?,
    installed_at: row.get("installed_at")?,
  })
}

fn map_default(row: &Row<'_>) -> Result<CatalogDefault, rusqlite::Error> {
  Ok(CatalogDefault {
    plugin_id: row.get("plugin_id")?,
    content_digest: row.get("content_digest")?,
    updated_at: row.get("updated_at")?,
  })
}

pub fn list_user_archives(conn: &Connection) -> Result<Vec<UserPluginArchive>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM plugin_user_archives
     ORDER BY plugin_id ASC, version ASC, content_digest ASC",
  )?;
  let rows = stmt.query_map([], map_archive)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get_user_archive(conn: &Connection, content_digest: &str) -> Result<Option<UserPluginArchive>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_user_archives WHERE content_digest = ?1",
        params![content_digest],
        map_archive,
      )
      .optional()?,
  )
}

pub fn get_user_archive_by_file_name(
  conn: &Connection,
  file_name: &str,
) -> Result<Option<UserPluginArchive>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_user_archives WHERE file_name = ?1",
        params![file_name],
        map_archive,
      )
      .optional()?,
  )
}

pub fn get_user_archive_by_plugin_version(
  conn: &Connection,
  plugin_id: &str,
  version: &str,
) -> Result<Option<UserPluginArchive>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_user_archives WHERE plugin_id = ?1 AND version = ?2",
        params![plugin_id, version],
        map_archive,
      )
      .optional()?,
  )
}

pub fn insert_user_archive(conn: &Connection, archive: &UserPluginArchive) -> Result<(), StorageError> {
  validate_content_digest(&archive.content_digest).map_err(StorageError::Validation)?;
  conn
    .execute(
      "INSERT INTO plugin_user_archives (
            content_digest, plugin_id, version, runtime_kind, manifest_json,
            permission_request_digest, file_name, installed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      params![
        archive.content_digest,
        archive.plugin_id,
        archive.version,
        runtime_kind_as_str(archive.runtime_kind),
        archive.manifest_json,
        archive.permission_request_digest,
        archive.file_name,
        archive.installed_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "plugin user archive"))?;
  Ok(())
}

pub fn delete_user_archive(conn: &Connection, content_digest: &str) -> Result<(), StorageError> {
  let changed = conn.execute(
    "DELETE FROM plugin_user_archives WHERE content_digest = ?1",
    params![content_digest],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("plugin user archive {content_digest}")));
  }
  Ok(())
}

pub fn list_default_overrides(conn: &Connection) -> Result<Vec<CatalogDefault>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM plugin_default_overrides
     ORDER BY plugin_id ASC",
  )?;
  let rows = stmt.query_map([], map_default)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get_default_override(conn: &Connection, plugin_id: &str) -> Result<Option<CatalogDefault>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_default_overrides WHERE plugin_id = ?1",
        params![plugin_id],
        map_default,
      )
      .optional()?,
  )
}

/// Write the explicit user default for a plugin id. Never touches instance or provider pins.
pub fn set_default_override(
  conn: &Connection,
  plugin_id: &str,
  content_digest: &str,
) -> Result<CatalogDefault, StorageError> {
  validate_content_digest(content_digest).map_err(StorageError::Validation)?;
  let updated_at = now_rfc3339();
  conn.execute(
    "INSERT INTO plugin_default_overrides (plugin_id, content_digest, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(plugin_id) DO UPDATE SET
       content_digest = excluded.content_digest,
       updated_at = excluded.updated_at",
    params![plugin_id, content_digest, updated_at],
  )?;
  Ok(CatalogDefault {
    plugin_id: plugin_id.to_string(),
    content_digest: content_digest.to_string(),
    updated_at,
  })
}

pub fn clear_default_override(conn: &Connection, plugin_id: &str) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM plugin_default_overrides WHERE plugin_id = ?1",
    params![plugin_id],
  )?;
  Ok(())
}

/// Drop any override that points at removed content so a stale digest is never retained.
pub fn clear_default_override_for_digest(conn: &Connection, content_digest: &str) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM plugin_default_overrides WHERE content_digest = ?1",
    params![content_digest],
  )?;
  Ok(())
}

/// Count integration instances pinned to this plugin id and version.
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

/// Count integration instances pinned to an exact content digest.
pub fn count_integration_users_by_digest(conn: &Connection, content_digest: &str) -> Result<Vec<String>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT id FROM integration_instances
     WHERE package_digest = ?1
     ORDER BY id ASC",
  )?;
  let rows = stmt
    .query_map(params![content_digest], |row| row.get::<_, String>(0))?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

/// Every content digest that a live instance, provider binding, or grant set references.
pub fn in_use_digests(conn: &Connection) -> Result<Vec<String>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT package_digest FROM integration_instances
     UNION
     SELECT package_digest FROM provider_runtime_bindings
     UNION
     SELECT package_digest FROM execution_grant_sets
     ORDER BY 1 ASC",
  )?;
  let rows = stmt
    .query_map([], |row| row.get::<_, String>(0))?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

/// Count provider runtime bindings pinned to an exact content digest.
pub fn count_provider_users_by_digest(conn: &Connection, content_digest: &str) -> Result<Vec<String>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT provider_id FROM provider_runtime_bindings
     WHERE package_digest = ?1
     ORDER BY provider_id ASC",
  )?;
  let rows = stmt
    .query_map(params![content_digest], |row| row.get::<_, String>(0))?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::runtime_plugin::RuntimeKind;

  fn archive(digest: &str, plugin_id: &str, version: &str, file_name: &str) -> UserPluginArchive {
    UserPluginArchive {
      content_digest: digest.to_string(),
      plugin_id: plugin_id.to_string(),
      version: version.to_string(),
      runtime_kind: RuntimeKind::WasmComponent,
      manifest_json: "{}".into(),
      permission_request_digest: "p".repeat(64),
      file_name: file_name.to_string(),
      installed_at: "t0".into(),
    }
  }

  fn conn() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    crate::storage::migrations::migrate(&mut conn).unwrap();
    conn
  }

  #[test]
  fn user_archive_round_trip_and_unique_file_name() {
    let conn = conn();
    let digest = "a".repeat(64);
    insert_user_archive(&conn, &archive(&digest, "com.example.one", "1.0.0", "one.lnplugin")).unwrap();
    let stored = get_user_archive(&conn, &digest).unwrap().unwrap();
    assert_eq!(stored.plugin_id, "com.example.one");
    assert_eq!(stored.runtime_kind, RuntimeKind::WasmComponent);
    let by_name = get_user_archive_by_file_name(&conn, "one.lnplugin").unwrap().unwrap();
    assert_eq!(by_name.content_digest, digest);
    assert!(
      insert_user_archive(
        &conn,
        &archive(&"b".repeat(64), "com.example.two", "1.0.0", "one.lnplugin")
      )
      .is_err(),
      "file name is unique"
    );
    delete_user_archive(&conn, &digest).unwrap();
    assert!(get_user_archive(&conn, &digest).unwrap().is_none());
  }

  #[test]
  fn default_override_is_upserted_and_cleared_by_digest() {
    let conn = conn();
    let first = "a".repeat(64);
    let second = "b".repeat(64);
    set_default_override(&conn, "com.example.one", &first).unwrap();
    let stored = get_default_override(&conn, "com.example.one").unwrap().unwrap();
    assert_eq!(stored.content_digest, first);
    set_default_override(&conn, "com.example.one", &second).unwrap();
    let stored = get_default_override(&conn, "com.example.one").unwrap().unwrap();
    assert_eq!(stored.content_digest, second);
    clear_default_override_for_digest(&conn, &first).unwrap();
    assert!(get_default_override(&conn, "com.example.one").unwrap().is_some());
    clear_default_override_for_digest(&conn, &second).unwrap();
    assert!(get_default_override(&conn, "com.example.one").unwrap().is_none());
  }
}
