// ABOUTME: SQLite CRUD for trusted and revoked plugin publisher verification keys.
// ABOUTME: Vendor and user-approved keys share one table; private keys are never stored.
use crate::domain::plugin_package::{PluginPublisher, PublisherSource};
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};

fn map_row(row: &Row<'_>) -> Result<PluginPublisher, rusqlite::Error> {
  let source: String = row.get("source")?;
  let enabled: i64 = row.get("enabled")?;
  let revoked: i64 = row.get("revoked")?;
  Ok(PluginPublisher {
    key_id: row.get("key_id")?,
    fingerprint: row.get("fingerprint")?,
    public_key_hex: row.get("public_key_hex")?,
    source: PublisherSource::parse(&source).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
      )
    })?,
    enabled: enabled != 0,
    revoked: revoked != 0,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

pub fn list(conn: &Connection) -> Result<Vec<PluginPublisher>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM plugin_publishers
     ORDER BY source ASC, key_id ASC",
  )?;
  let rows = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get(conn: &Connection, key_id: &str) -> Result<PluginPublisher, StorageError> {
  conn
    .query_row(
      "SELECT * FROM plugin_publishers WHERE key_id = ?1",
      params![key_id],
      map_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("plugin publisher {key_id}")))
}

pub fn get_optional(conn: &Connection, key_id: &str) -> Result<Option<PluginPublisher>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_publishers WHERE key_id = ?1",
        params![key_id],
        map_row,
      )
      .optional()?,
  )
}

pub fn get_by_fingerprint(conn: &Connection, fingerprint: &str) -> Result<Option<PluginPublisher>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_publishers WHERE fingerprint = ?1",
        params![fingerprint],
        map_row,
      )
      .optional()?,
  )
}

pub fn insert(conn: &Connection, publisher: &PluginPublisher) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO plugin_publishers (
            key_id, fingerprint, public_key_hex, source, enabled, revoked, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      params![
        publisher.key_id,
        publisher.fingerprint,
        publisher.public_key_hex,
        publisher.source.as_str(),
        publisher.enabled as i64,
        publisher.revoked as i64,
        publisher.created_at,
        publisher.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "plugin publisher"))?;
  Ok(())
}

/// Upsert a vendor publisher from seed constants (idempotent by key_id).
pub fn upsert_vendor(
  conn: &Connection,
  key_id: &str,
  fingerprint: &str,
  public_key_hex: &str,
) -> Result<PluginPublisher, StorageError> {
  let now = now_rfc3339();
  if let Some(existing) = get_optional(conn, key_id)? {
    conn.execute(
      "UPDATE plugin_publishers SET
            fingerprint = ?2,
            public_key_hex = ?3,
            source = 'vendor',
            enabled = 1,
            updated_at = ?4
         WHERE key_id = ?1",
      params![key_id, fingerprint, public_key_hex, now],
    )?;
    return get(conn, key_id).or(Ok(existing));
  }
  let publisher = PluginPublisher {
    key_id: key_id.to_string(),
    fingerprint: fingerprint.to_string(),
    public_key_hex: public_key_hex.to_string(),
    source: PublisherSource::Vendor,
    enabled: true,
    revoked: false,
    created_at: now.clone(),
    updated_at: now,
  };
  insert(conn, &publisher)?;
  Ok(publisher)
}

pub fn set_enabled(conn: &Connection, key_id: &str, enabled: bool) -> Result<PluginPublisher, StorageError> {
  let now = now_rfc3339();
  let changed = conn.execute(
    "UPDATE plugin_publishers SET enabled = ?2, updated_at = ?3 WHERE key_id = ?1",
    params![key_id, enabled as i64, now],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("plugin publisher {key_id}")));
  }
  get(conn, key_id)
}

pub fn revoke(conn: &Connection, key_id: &str) -> Result<PluginPublisher, StorageError> {
  let now = now_rfc3339();
  let changed = conn.execute(
    "UPDATE plugin_publishers SET revoked = 1, enabled = 0, updated_at = ?2 WHERE key_id = ?1",
    params![key_id, now],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("plugin publisher {key_id}")));
  }
  get(conn, key_id)
}
