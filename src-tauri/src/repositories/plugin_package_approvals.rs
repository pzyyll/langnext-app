// ABOUTME: SQLite access for non-executable plugin package installation approvals.
// ABOUTME: Approvals never authorize runtime execution or grant-set lookups.
use crate::domain::plugin_package::{PluginPackageApproval, PublisherDecision};
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<PluginPackageApproval, rusqlite::Error> {
  let id: String = row.get("id")?;
  let decision: String = row.get("publisher_decision")?;
  let revision: i64 = row.get("revision")?;
  Ok(PluginPackageApproval {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    package_digest: row.get("package_digest")?,
    revision: u64::try_from(revision)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Integer, Box::new(e)))?,
    publisher_key_id: row.get("publisher_key_id")?,
    publisher_decision: PublisherDecision::parse(&decision).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
      )
    })?,
    permission_request_digest: row.get("permission_request_digest")?,
    approved_at: row.get("approved_at")?,
  })
}

pub fn list_for_package(conn: &Connection, package_digest: &str) -> Result<Vec<PluginPackageApproval>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM plugin_package_approvals
     WHERE package_digest = ?1
     ORDER BY revision ASC",
  )?;
  let rows = stmt
    .query_map(params![package_digest], map_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get(conn: &Connection, id: Uuid) -> Result<PluginPackageApproval, StorageError> {
  conn
    .query_row(
      "SELECT * FROM plugin_package_approvals WHERE id = ?1",
      params![id.to_string()],
      map_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("plugin package approval {id}")))
}

pub fn latest_for_package(
  conn: &Connection,
  package_digest: &str,
) -> Result<Option<PluginPackageApproval>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_package_approvals
         WHERE package_digest = ?1
         ORDER BY revision DESC
         LIMIT 1",
        params![package_digest],
        map_row,
      )
      .optional()?,
  )
}

pub fn next_revision(conn: &Connection, package_digest: &str) -> Result<u64, StorageError> {
  let current: Option<i64> = conn
    .query_row(
      "SELECT MAX(revision) FROM plugin_package_approvals WHERE package_digest = ?1",
      params![package_digest],
      |row| row.get(0),
    )
    .optional()?
    .flatten();
  Ok(current.map(|v| (v as u64) + 1).unwrap_or(1))
}

pub fn insert(conn: &Connection, approval: &PluginPackageApproval) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO plugin_package_approvals (
            id, package_digest, revision, publisher_key_id, publisher_decision,
            permission_request_digest, approved_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      params![
        approval.id.to_string(),
        approval.package_digest,
        approval.revision as i64,
        approval.publisher_key_id,
        approval.publisher_decision.as_str(),
        approval.permission_request_digest,
        approval.approved_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "plugin package approval"))?;
  Ok(())
}

pub fn delete_for_package(conn: &Connection, package_digest: &str) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM plugin_package_approvals WHERE package_digest = ?1",
    params![package_digest],
  )?;
  Ok(())
}

/// Execution-grant-set lookup by primary key. Package approval IDs must never match.
pub fn get_execution_grant_set(conn: &Connection, id: Uuid) -> Result<Option<(String, i64)>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT id, revision FROM execution_grant_sets WHERE id = ?1",
        params![id.to_string()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
      )
      .optional()?,
  )
}

/// Insert a Phase-4-reserved execution grant-set header (tests only until Phase 4).
#[cfg(test)]
pub fn insert_execution_grant_set_for_test(
  conn: &Connection,
  id: Uuid,
  revision: u64,
  subject_kind: &str,
  subject_id: &str,
  plugin_id: &str,
  package_digest: &str,
  permission_request_digest: &str,
  approved_at: &str,
) -> Result<(), StorageError> {
  conn.execute(
    "INSERT INTO execution_grant_sets (
          id, revision, subject_kind, subject_id, plugin_id,
          package_digest, permission_request_digest, approved_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    params![
      id.to_string(),
      revision as i64,
      subject_kind,
      subject_id,
      plugin_id,
      package_digest,
      permission_request_digest,
      approved_at,
    ],
  )?;
  Ok(())
}
