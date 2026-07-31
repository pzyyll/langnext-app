// ABOUTME: SQLite access for instance/package execution grant-set revisions and entries.
// ABOUTME: Package approval IDs never satisfy grant-set lookups or runtime authority.
use crate::domain::runtime_lifecycle::{
  CapabilityGrantEntryRecord, ExecutionGrantSetBundle, ExecutionGrantSetRecord, GrantSubjectKind,
  NetworkGrantEntryRecord, PageGrantEntryRecord,
};
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

fn map_header(row: &Row<'_>) -> Result<ExecutionGrantSetRecord, rusqlite::Error> {
  let id: String = row.get("id")?;
  let subject_id: String = row.get("subject_id")?;
  let subject_kind: String = row.get("subject_kind")?;
  let revision: i64 = row.get("revision")?;
  Ok(ExecutionGrantSetRecord {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    revision: u64::try_from(revision)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Integer, Box::new(e)))?,
    subject_kind: GrantSubjectKind::parse(&subject_kind).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
      )
    })?,
    subject_id: Uuid::parse_str(&subject_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    plugin_id: row.get("plugin_id")?,
    plugin_version: row.get("plugin_version")?,
    package_digest: row.get("package_digest")?,
    permission_request_digest: row.get("permission_request_digest")?,
    authority_digest: row.get("authority_digest")?,
    approved_at: row.get("approved_at")?,
  })
}

pub fn get_header(conn: &Connection, id: Uuid) -> Result<ExecutionGrantSetRecord, StorageError> {
  conn
    .query_row(
      "SELECT * FROM execution_grant_sets WHERE id = ?1",
      params![id.to_string()],
      map_header,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("execution grant set {id}")))
}

pub fn get_header_optional(conn: &Connection, id: Uuid) -> Result<Option<ExecutionGrantSetRecord>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM execution_grant_sets WHERE id = ?1",
        params![id.to_string()],
        map_header,
      )
      .optional()?,
  )
}

/// Look up the exact grant-set revision for one subject/package pair.
pub fn get_for_subject_package_revision(
  conn: &Connection,
  subject_kind: GrantSubjectKind,
  subject_id: Uuid,
  package_digest: &str,
  revision: u64,
) -> Result<ExecutionGrantSetRecord, StorageError> {
  conn
    .query_row(
      "SELECT * FROM execution_grant_sets
       WHERE subject_kind = ?1
         AND subject_id = ?2
         AND package_digest = ?3
         AND revision = ?4",
      params![
        subject_kind.as_str(),
        subject_id.to_string(),
        package_digest,
        revision as i64
      ],
      map_header,
    )
    .optional()?
    .ok_or_else(|| {
      StorageError::NotFound(format!(
        "execution grant set for subject {subject_id} package {package_digest} revision {revision}"
      ))
    })
}

pub fn latest_revision_for_subject_package(
  conn: &Connection,
  subject_kind: GrantSubjectKind,
  subject_id: Uuid,
  package_digest: &str,
) -> Result<Option<u64>, StorageError> {
  let current: Option<i64> = conn
    .query_row(
      "SELECT MAX(revision) FROM execution_grant_sets
       WHERE subject_kind = ?1 AND subject_id = ?2 AND package_digest = ?3",
      params![subject_kind.as_str(), subject_id.to_string(), package_digest],
      |row| row.get(0),
    )
    .optional()?
    .flatten();
  Ok(current.map(|v| v as u64))
}

pub fn next_revision_for_subject_package(
  conn: &Connection,
  subject_kind: GrantSubjectKind,
  subject_id: Uuid,
  package_digest: &str,
) -> Result<u64, StorageError> {
  Ok(
    latest_revision_for_subject_package(conn, subject_kind, subject_id, package_digest)?
      .map(|v| v + 1)
      .unwrap_or(1),
  )
}

fn list_capabilities(conn: &Connection, grant_set_id: Uuid) -> Result<Vec<CapabilityGrantEntryRecord>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT id, grant_set_id, capability_id
     FROM execution_grant_capability_entries
     WHERE grant_set_id = ?1
     ORDER BY capability_id ASC",
  )?;
  let rows = stmt
    .query_map(params![grant_set_id.to_string()], |row| {
      let id: String = row.get(0)?;
      let grant_id: String = row.get(1)?;
      Ok(CapabilityGrantEntryRecord {
        id: Uuid::parse_str(&id)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
        grant_set_id: Uuid::parse_str(&grant_id)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
        capability_id: row.get(2)?,
      })
    })?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

fn list_network(conn: &Connection, grant_set_id: Uuid) -> Result<Vec<NetworkGrantEntryRecord>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT id, grant_set_id, capability_id, endpoint_id, origin, origin_kind, method, auth_policy,
            resource_mode, max_request_bytes, max_response_bytes, max_stream_bytes, timeout_ms,
            response_body_modes
     FROM execution_grant_network_entries
     WHERE grant_set_id = ?1
     ORDER BY capability_id ASC, endpoint_id ASC, origin ASC, origin_kind ASC, method ASC, auth_policy ASC, resource_mode ASC",
  )?;
  let rows = stmt
    .query_map(params![grant_set_id.to_string()], |row| {
      let id: String = row.get(0)?;
      let grant_id: String = row.get(1)?;
      let max_request_bytes: i64 = row.get(9)?;
      let max_response_bytes: i64 = row.get(10)?;
      let max_stream_bytes: i64 = row.get(11)?;
      let timeout_ms: i64 = row.get(12)?;
      Ok(NetworkGrantEntryRecord {
        id: Uuid::parse_str(&id)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
        grant_set_id: Uuid::parse_str(&grant_id)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
        capability_id: row.get(2)?,
        endpoint_id: row.get(3)?,
        origin: row.get(4)?,
        origin_kind: row.get(5)?,
        method: row.get(6)?,
        auth_policy: row.get(7)?,
        resource_mode: row.get(8)?,
        max_request_bytes: max_request_bytes as u64,
        max_response_bytes: max_response_bytes as u64,
        max_stream_bytes: max_stream_bytes as u64,
        timeout_ms: timeout_ms as u64,
        response_body_modes: row.get(13)?,
      })
    })?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

fn list_pages(conn: &Connection, grant_set_id: Uuid) -> Result<Vec<PageGrantEntryRecord>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT id, grant_set_id, page_id, allowed_actions_json,
            delegated_capability_majors_json, delegated_endpoint_aliases_json
     FROM execution_grant_page_entries
     WHERE grant_set_id = ?1
     ORDER BY page_id ASC",
  )?;
  let rows = stmt
    .query_map(params![grant_set_id.to_string()], |row| {
      let id: String = row.get(0)?;
      let grant_id: String = row.get(1)?;
      let actions_json: String = row.get(3)?;
      let majors_json: String = row.get(4)?;
      let aliases_json: String = row.get(5)?;
      let allowed_actions: Vec<String> = serde_json::from_str(&actions_json)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?;
      let delegated_capability_majors: Vec<String> = serde_json::from_str(&majors_json)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?;
      let delegated_endpoint_aliases: Vec<String> = serde_json::from_str(&aliases_json)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?;
      Ok(PageGrantEntryRecord {
        id: Uuid::parse_str(&id)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
        grant_set_id: Uuid::parse_str(&grant_id)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
        page_id: row.get(2)?,
        allowed_actions,
        delegated_capability_majors,
        delegated_endpoint_aliases,
      })
    })?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get_bundle(conn: &Connection, id: Uuid) -> Result<ExecutionGrantSetBundle, StorageError> {
  let header = get_header(conn, id)?;
  Ok(ExecutionGrantSetBundle {
    capabilities: list_capabilities(conn, id)?,
    network: list_network(conn, id)?,
    pages: list_pages(conn, id)?,
    header,
  })
}

pub fn get_bundle_for_subject_package_revision(
  conn: &Connection,
  subject_kind: GrantSubjectKind,
  subject_id: Uuid,
  package_digest: &str,
  revision: u64,
) -> Result<ExecutionGrantSetBundle, StorageError> {
  let header = get_for_subject_package_revision(conn, subject_kind, subject_id, package_digest, revision)?;
  get_bundle(conn, header.id)
}

pub fn insert_bundle(conn: &Connection, bundle: &ExecutionGrantSetBundle) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO execution_grant_sets (
            id, revision, subject_kind, subject_id, plugin_id, plugin_version,
            package_digest, permission_request_digest, authority_digest, approved_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
      params![
        bundle.header.id.to_string(),
        bundle.header.revision as i64,
        bundle.header.subject_kind.as_str(),
        bundle.header.subject_id.to_string(),
        bundle.header.plugin_id,
        bundle.header.plugin_version,
        bundle.header.package_digest,
        bundle.header.permission_request_digest,
        bundle.header.authority_digest,
        bundle.header.approved_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "execution grant set"))?;

  for cap in &bundle.capabilities {
    conn
      .execute(
        "INSERT INTO execution_grant_capability_entries (id, grant_set_id, capability_id)
         VALUES (?1, ?2, ?3)",
        params![cap.id.to_string(), cap.grant_set_id.to_string(), cap.capability_id],
      )
      .map_err(|e| StorageError::from_sqlite_constraint(e, "execution grant capability entry"))?;
  }

  for net in &bundle.network {
    conn
      .execute(
        "INSERT INTO execution_grant_network_entries (
              id, grant_set_id, capability_id, endpoint_id, origin, origin_kind, method, auth_policy,
              resource_mode, max_request_bytes, max_response_bytes, max_stream_bytes, timeout_ms,
              response_body_modes
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
          net.id.to_string(),
          net.grant_set_id.to_string(),
          net.capability_id,
          net.endpoint_id,
          net.origin,
          net.origin_kind,
          net.method,
          net.auth_policy,
          net.resource_mode,
          net.max_request_bytes as i64,
          net.max_response_bytes as i64,
          net.max_stream_bytes as i64,
          net.timeout_ms as i64,
          net.response_body_modes,
        ],
      )
      .map_err(|e| StorageError::from_sqlite_constraint(e, "execution grant network entry"))?;
  }

  for page in &bundle.pages {
    let actions = serde_json::to_string(&page.allowed_actions)?;
    let majors = serde_json::to_string(&page.delegated_capability_majors)?;
    let aliases = serde_json::to_string(&page.delegated_endpoint_aliases)?;
    conn
      .execute(
        "INSERT INTO execution_grant_page_entries (
              id, grant_set_id, page_id, allowed_actions_json,
              delegated_capability_majors_json, delegated_endpoint_aliases_json
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
          page.id.to_string(),
          page.grant_set_id.to_string(),
          page.page_id,
          actions,
          majors,
          aliases
        ],
      )
      .map_err(|e| StorageError::from_sqlite_constraint(e, "execution grant page entry"))?;
  }

  Ok(())
}

/// Count grant sets that reference a package (blocks uninstall while authority remains).
pub fn count_for_package(conn: &Connection, package_digest: &str) -> Result<i64, StorageError> {
  Ok(conn.query_row(
    "SELECT COUNT(*) FROM execution_grant_sets WHERE package_digest = ?1",
    params![package_digest],
    |row| row.get(0),
  )?)
}

/// Reject package-approval IDs used as grant-set lookups.
pub fn reject_if_package_approval_id(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
  let is_approval: Option<i64> = conn
    .query_row(
      "SELECT 1 FROM plugin_package_approvals WHERE id = ?1",
      params![id.to_string()],
      |row| row.get(0),
    )
    .optional()?;
  if is_approval.is_some() {
    return Err(StorageError::Validation(
      "package approval cannot authorize runtime execution".into(),
    ));
  }
  Ok(())
}
