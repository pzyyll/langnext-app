// ABOUTME: Adapter-keyed provider runtime interface binding and snapshot-set persistence.
// ABOUTME: Snapshot rows never store package bytes, grants, credentials, or secret material.
use crate::domain::runtime_provider::{ProviderRuntimeBinding, ProviderRuntimeKind, ProviderRuntimeState};
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

fn map_binding_row(row: &Row<'_>) -> Result<ProviderRuntimeBinding, rusqlite::Error> {
  let provider_id: String = row.get("provider_id")?;
  let runtime_kind: String = row.get("runtime_kind")?;
  let state: String = row.get("state")?;
  Ok(ProviderRuntimeBinding {
    provider_id: Uuid::parse_str(&provider_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    adapter_id: row.get("adapter_id")?,
    runtime_kind: ProviderRuntimeKind::parse(&runtime_kind)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
    package_digest: row.get("package_digest")?,
    grant_set_revision: match row.get::<_, Option<i64>>("grant_set_revision")? {
      Some(revision) => Some(
        u64::try_from(revision)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Integer, e.into()))?,
      ),
      None => None,
    },
    state: ProviderRuntimeState::parse(&state)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
    error_code: row.get("error_code")?,
    error_message: row.get("error_message")?,
    runtime_requirement_json: row.get("runtime_requirement_json")?,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

/// Read the authoritative runtime binding for one provider API type.
pub fn get(conn: &Connection, provider_id: Uuid, adapter_id: &str) -> Result<ProviderRuntimeBinding, StorageError> {
  conn
    .query_row(
      "SELECT * FROM provider_runtime_bindings WHERE provider_id = ?1 AND adapter_id = ?2",
      params![provider_id.to_string(), adapter_id],
      map_binding_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("provider runtime binding {provider_id} adapter {adapter_id}")))
}

/// Optional read of one provider API type binding. A missing non-default binding means
/// legacy execution, never a synthetic Wasm binding.
pub fn get_optional(
  conn: &Connection,
  provider_id: Uuid,
  adapter_id: &str,
) -> Result<Option<ProviderRuntimeBinding>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM provider_runtime_bindings WHERE provider_id = ?1 AND adapter_id = ?2",
        params![provider_id.to_string(), adapter_id],
        map_binding_row,
      )
      .optional()?,
  )
}

/// Read the Provider default API type binding (every provider row owns one).
pub fn get_default(conn: &Connection, provider_id: Uuid) -> Result<ProviderRuntimeBinding, StorageError> {
  conn
    .query_row(
      "SELECT * FROM provider_runtime_bindings b
        JOIN provider_instances p ON p.id = b.provider_id
       WHERE b.provider_id = ?1 AND b.adapter_id = p.adapter_id",
      params![provider_id.to_string()],
      map_binding_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("provider default runtime binding {provider_id}")))
}

/// Every runtime binding for one provider, ordered by adapter id.
pub fn list_by_provider(conn: &Connection, provider_id: Uuid) -> Result<Vec<ProviderRuntimeBinding>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM provider_runtime_bindings
      WHERE provider_id = ?1
      ORDER BY adapter_id ASC",
  )?;
  let rows = stmt
    .query_map(params![provider_id.to_string()], map_binding_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

/// Read every provider runtime binding in provider display order, then adapter order.
pub fn list(conn: &Connection) -> Result<Vec<ProviderRuntimeBinding>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT b.* FROM provider_runtime_bindings b
       JOIN provider_instances p ON p.id = b.provider_id
      ORDER BY p.sort_order ASC, p.created_at ASC, p.id ASC, b.adapter_id ASC",
  )?;
  let rows = stmt.query_map([], map_binding_row)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

/// Insert a provider runtime interface binding (create path and lifecycle writes).
pub fn insert(conn: &Connection, binding: &ProviderRuntimeBinding) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO provider_runtime_bindings (
        provider_id, adapter_id, runtime_kind, package_digest, grant_set_revision, state,
        error_code, error_message, runtime_requirement_json, created_at, updated_at
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
      params![
        binding.provider_id.to_string(),
        binding.adapter_id,
        binding.runtime_kind.as_str(),
        binding.package_digest,
        binding.grant_set_revision.map(|revision| revision as i64),
        binding.state.as_str(),
        binding.error_code,
        binding.error_message,
        binding.runtime_requirement_json,
        binding.created_at,
        binding.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "provider runtime binding"))?;
  Ok(())
}

/// Replace the current adapter-keyed binding row (lifecycle transitions), preserving the provider row.
pub fn update(conn: &Connection, binding: &ProviderRuntimeBinding) -> Result<(), StorageError> {
  let changed = conn
    .execute(
      "UPDATE provider_runtime_bindings SET
        runtime_kind = ?3,
        package_digest = ?4,
        grant_set_revision = ?5,
        state = ?6,
        error_code = ?7,
        error_message = ?8,
        runtime_requirement_json = ?9,
        updated_at = ?10
       WHERE provider_id = ?1 AND adapter_id = ?2",
      params![
        binding.provider_id.to_string(),
        binding.adapter_id,
        binding.runtime_kind.as_str(),
        binding.package_digest,
        binding.grant_set_revision.map(|revision| revision as i64),
        binding.state.as_str(),
        binding.error_code,
        binding.error_message,
        binding.runtime_requirement_json,
        binding.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "provider runtime binding"))?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!(
      "provider runtime binding {} adapter {}",
      binding.provider_id, binding.adapter_id
    )));
  }
  Ok(())
}

/// Remove one adapter-keyed interface binding.
pub fn delete(conn: &Connection, provider_id: Uuid, adapter_id: &str) -> Result<(), StorageError> {
  let changed = conn.execute(
    "DELETE FROM provider_runtime_bindings WHERE provider_id = ?1 AND adapter_id = ?2",
    params![provider_id.to_string(), adapter_id],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!(
      "provider runtime binding {provider_id} adapter {adapter_id}"
    )));
  }
  Ok(())
}

/// True when any active binding row of one provider names the exact package.
pub fn has_active_package(conn: &Connection, provider_id: Uuid, package_digest: &str) -> Result<bool, StorageError> {
  let count: i64 = conn.query_row(
    "SELECT COUNT(*) FROM provider_runtime_bindings
      WHERE provider_id = ?1 AND package_digest = ?2 AND state = 'active'",
    params![provider_id.to_string(), package_digest],
    |row| row.get(0),
  )?;
  Ok(count > 0)
}

/// True when any binding row of one provider names the exact package (any state).
pub fn has_any_package(conn: &Connection, provider_id: Uuid, package_digest: &str) -> Result<bool, StorageError> {
  let count: i64 = conn.query_row(
    "SELECT COUNT(*) FROM provider_runtime_bindings
      WHERE provider_id = ?1 AND package_digest = ?2",
    params![provider_id.to_string(), package_digest],
    |row| row.get(0),
  )?;
  Ok(count > 0)
}

/// True when any provider binding row references the package (uninstall reference check).
pub fn package_referenced_by_binding(conn: &Connection, package_digest: &str) -> Result<bool, StorageError> {
  let count: i64 = conn.query_row(
    "SELECT COUNT(*) FROM provider_runtime_bindings WHERE package_digest = ?1",
    params![package_digest],
    |row| row.get(0),
  )?;
  Ok(count > 0)
}

/// Identity-only rollback snapshot set parent. A Provider-scoped set preserves a historic
/// v24 Provider-wide rollback scope; adapter-scoped sets own exactly one interface child.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeSnapshotSet {
  pub id: Uuid,
  pub provider_id: Uuid,
  pub scope: ProviderRuntimeSnapshotScope,
  pub created_at: String,
  pub discarded_at: Option<String>,
  pub runtime_kind: ProviderRuntimeKind,
  pub package_digest: Option<String>,
  pub grant_set_revision: Option<u64>,
  pub grant_set_id: Option<Uuid>,
  pub plugin_id: String,
  pub plugin_version: String,
  pub publisher_key_id: Option<String>,
  pub publisher_fingerprint: Option<String>,
  pub plugin_api_version: Option<String>,
  pub capability_ids_json: String,
  pub updated_at: String,
}

/// Rollback scope of one snapshot set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRuntimeSnapshotScope {
  Provider,
  Adapter,
}

impl ProviderRuntimeSnapshotScope {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Provider => "provider",
      Self::Adapter => "adapter",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "provider" => Ok(Self::Provider),
      "adapter" => Ok(Self::Adapter),
      other => Err(format!("invalid provider runtime snapshot scope: {other}")),
    }
  }
}

/// One adapter-keyed binding identity inside a snapshot set (no config, grants, or secrets).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeSnapshotBinding {
  pub id: Uuid,
  pub snapshot_set_id: Uuid,
  pub provider_id: Uuid,
  pub adapter_id: String,
  pub runtime_kind: ProviderRuntimeKind,
  pub package_digest: Option<String>,
  pub grant_set_revision: Option<u64>,
  pub state: ProviderRuntimeState,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
  pub runtime_requirement_json: Option<String>,
  pub created_at: String,
  pub updated_at: String,
}

fn map_snapshot_set_row(row: &Row<'_>) -> Result<ProviderRuntimeSnapshotSet, rusqlite::Error> {
  let id: String = row.get("id")?;
  let provider_id: String = row.get("provider_id")?;
  let scope: String = row.get("scope")?;
  let runtime_kind: String = row.get("runtime_kind")?;
  let grant_set_id: Option<String> = row.get("grant_set_id")?;
  Ok(ProviderRuntimeSnapshotSet {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    provider_id: Uuid::parse_str(&provider_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    scope: ProviderRuntimeSnapshotScope::parse(&scope)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
    created_at: row.get("created_at")?,
    discarded_at: row.get("discarded_at")?,
    runtime_kind: ProviderRuntimeKind::parse(&runtime_kind)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
    package_digest: row.get("package_digest")?,
    grant_set_revision: match row.get::<_, Option<i64>>("grant_set_revision")? {
      Some(revision) => Some(
        u64::try_from(revision)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Integer, e.into()))?,
      ),
      None => None,
    },
    grant_set_id: grant_set_id
      .map(|value| Uuid::parse_str(&value))
      .transpose()
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    plugin_id: row.get("plugin_id")?,
    plugin_version: row.get("plugin_version")?,
    publisher_key_id: row.get("publisher_key_id")?,
    publisher_fingerprint: row.get("publisher_fingerprint")?,
    plugin_api_version: row.get("plugin_api_version")?,
    capability_ids_json: row.get("capability_ids_json")?,
    updated_at: row.get("updated_at")?,
  })
}

fn map_snapshot_binding_row(row: &Row<'_>) -> Result<ProviderRuntimeSnapshotBinding, rusqlite::Error> {
  let id: String = row.get("id")?;
  let snapshot_set_id: String = row.get("snapshot_set_id")?;
  let provider_id: String = row.get("provider_id")?;
  let runtime_kind: String = row.get("runtime_kind")?;
  let state: String = row.get("state")?;
  Ok(ProviderRuntimeSnapshotBinding {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    snapshot_set_id: Uuid::parse_str(&snapshot_set_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    provider_id: Uuid::parse_str(&provider_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    adapter_id: row.get("adapter_id")?,
    runtime_kind: ProviderRuntimeKind::parse(&runtime_kind)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
    package_digest: row.get("package_digest")?,
    grant_set_revision: match row.get::<_, Option<i64>>("grant_set_revision")? {
      Some(revision) => Some(
        u64::try_from(revision)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Integer, e.into()))?,
      ),
      None => None,
    },
    state: ProviderRuntimeState::parse(&state)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
    error_code: row.get("error_code")?,
    error_message: row.get("error_message")?,
    runtime_requirement_json: row.get("runtime_requirement_json")?,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

/// Insert a provider runtime snapshot set.
pub fn insert_snapshot_set(conn: &Connection, set: &ProviderRuntimeSnapshotSet) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO provider_runtime_snapshot_sets (
        id, provider_id, scope, created_at, discarded_at, runtime_kind, package_digest,
        grant_set_revision, grant_set_id, plugin_id, plugin_version,
        publisher_key_id, publisher_fingerprint, plugin_api_version,
        capability_ids_json, updated_at
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
      params![
        set.id.to_string(),
        set.provider_id.to_string(),
        set.scope.as_str(),
        set.created_at,
        set.discarded_at,
        set.runtime_kind.as_str(),
        set.package_digest,
        set.grant_set_revision.map(|revision| revision as i64),
        set.grant_set_id.map(|id| id.to_string()),
        set.plugin_id,
        set.plugin_version,
        set.publisher_key_id,
        set.publisher_fingerprint,
        set.plugin_api_version,
        set.capability_ids_json,
        set.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "provider runtime snapshot set"))?;
  Ok(())
}

/// Insert one adapter-keyed snapshot child inside the caller's transaction.
pub fn insert_snapshot_binding(
  conn: &Connection,
  binding: &ProviderRuntimeSnapshotBinding,
) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO provider_runtime_snapshot_bindings (
        id, snapshot_set_id, provider_id, adapter_id, runtime_kind, package_digest,
        grant_set_revision, state, error_code, error_message, runtime_requirement_json,
        created_at, updated_at
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
      params![
        binding.id.to_string(),
        binding.snapshot_set_id.to_string(),
        binding.provider_id.to_string(),
        binding.adapter_id,
        binding.runtime_kind.as_str(),
        binding.package_digest,
        binding.grant_set_revision.map(|revision| revision as i64),
        binding.state.as_str(),
        binding.error_code,
        binding.error_message,
        binding.runtime_requirement_json,
        binding.created_at,
        binding.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "provider runtime snapshot binding"))?;
  Ok(())
}

/// Read one undiscarded snapshot set by id.
pub fn get_snapshot_set(conn: &Connection, id: Uuid) -> Result<Option<ProviderRuntimeSnapshotSet>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM provider_runtime_snapshot_sets WHERE id = ?1",
        params![id.to_string()],
        map_snapshot_set_row,
      )
      .optional()?,
  )
}

/// List non-discarded snapshot sets for one provider (newest first).
pub fn list_snapshot_sets(
  conn: &Connection,
  provider_id: Uuid,
) -> Result<Vec<ProviderRuntimeSnapshotSet>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM provider_runtime_snapshot_sets
      WHERE provider_id = ?1 AND discarded_at IS NULL
      ORDER BY created_at DESC, id DESC",
  )?;
  let rows = stmt
    .query_map(params![provider_id.to_string()], map_snapshot_set_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

/// Every adapter-keyed child of one snapshot set.
pub fn list_snapshot_bindings(
  conn: &Connection,
  set_id: Uuid,
) -> Result<Vec<ProviderRuntimeSnapshotBinding>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM provider_runtime_snapshot_bindings
      WHERE snapshot_set_id = ?1
      ORDER BY adapter_id ASC",
  )?;
  let rows = stmt
    .query_map(params![set_id.to_string()], map_snapshot_binding_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

/// Mark one snapshot set discarded (returns false when already discarded).
pub fn discard_snapshot_set(conn: &Connection, id: Uuid, discarded_at: &str) -> Result<bool, StorageError> {
  let changed = conn.execute(
    "UPDATE provider_runtime_snapshot_sets SET discarded_at = ?2, updated_at = ?2 WHERE id = ?1",
    params![id.to_string(), discarded_at],
  )?;
  Ok(changed > 0)
}

/// True when any undiscarded snapshot set of one provider references the exact package.
pub fn provider_snapshot_references_package(
  conn: &Connection,
  provider_id: Uuid,
  package_digest: &str,
) -> Result<bool, StorageError> {
  let count: i64 = conn.query_row(
    "SELECT COUNT(*) FROM provider_runtime_snapshot_sets
      WHERE provider_id = ?1 AND discarded_at IS NULL AND package_digest = ?2",
    params![provider_id.to_string(), package_digest],
    |row| row.get(0),
  )?;
  Ok(count > 0)
}

/// True when any undiscarded snapshot set anywhere references the package (uninstall check).
pub fn package_referenced_by_snapshot_set(conn: &Connection, package_digest: &str) -> Result<bool, StorageError> {
  let count: i64 = conn.query_row(
    "SELECT COUNT(*) FROM provider_runtime_snapshot_sets
      WHERE discarded_at IS NULL AND package_digest = ?1",
    params![package_digest],
    |row| row.get(0),
  )?;
  Ok(count > 0)
}

/// True when any undiscarded snapshot set of one provider references the exact
/// package/grant revision (grant release check).
pub fn provider_snapshot_references_grant(
  conn: &Connection,
  provider_id: Uuid,
  package_digest: &str,
  revision: u64,
) -> Result<bool, StorageError> {
  let count: i64 = conn.query_row(
    "SELECT COUNT(*) FROM provider_runtime_snapshot_sets
      WHERE provider_id = ?1 AND discarded_at IS NULL
        AND package_digest = ?2 AND grant_set_revision = ?3",
    params![provider_id.to_string(), package_digest, revision as i64],
    |row| row.get(0),
  )?;
  Ok(count > 0)
}
