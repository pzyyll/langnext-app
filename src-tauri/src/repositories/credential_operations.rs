// ABOUTME: Credential mutation journal for crash-safe vault/SQLite coordination.
// ABOUTME: Unique (owner_kind, owner_id) serializes unfinished operations per owner.
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerKind {
  Provider,
  GlobalProxy,
  OcrApiKey,
  OcrSecretKey,
}

impl OwnerKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Provider => "provider",
      Self::GlobalProxy => "global_proxy",
      Self::OcrApiKey => "ocr_api_key",
      Self::OcrSecretKey => "ocr_secret_key",
    }
  }

  pub fn parse(value: &str) -> Result<Self, StorageError> {
    match value {
      "provider" => Ok(Self::Provider),
      "global_proxy" => Ok(Self::GlobalProxy),
      "ocr_api_key" => Ok(Self::OcrApiKey),
      "ocr_secret_key" => Ok(Self::OcrSecretKey),
      other => Err(StorageError::Internal(format!("unknown owner_kind: {other}"))),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationState {
  Prepared,
  DbCommitted,
}

impl OperationState {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Prepared => "prepared",
      Self::DbCommitted => "db_committed",
    }
  }

  pub fn parse(value: &str) -> Result<Self, StorageError> {
    match value {
      "prepared" => Ok(Self::Prepared),
      "db_committed" => Ok(Self::DbCommitted),
      other => Err(StorageError::Internal(format!("unknown op state: {other}"))),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialOperation {
  pub id: Uuid,
  pub owner_kind: OwnerKind,
  pub owner_id: String,
  pub expected_old_ref: Option<String>,
  pub new_ref: Option<String>,
  pub state: OperationState,
  pub created_at: String,
}

fn map_row(row: &Row<'_>) -> Result<CredentialOperation, rusqlite::Error> {
  let id: String = row.get("id")?;
  let owner_kind: String = row.get("owner_kind")?;
  let state: String = row.get("state")?;
  Ok(CredentialOperation {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    owner_kind: OwnerKind::parse(&owner_kind).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())),
      )
    })?,
    owner_id: row.get("owner_id")?,
    expected_old_ref: row.get("expected_old_ref")?,
    new_ref: row.get("new_ref")?,
    state: OperationState::parse(&state).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())),
      )
    })?,
    created_at: row.get("created_at")?,
  })
}

pub fn insert_prepared(
  conn: &Connection,
  id: Uuid,
  owner_kind: OwnerKind,
  owner_id: &str,
  expected_old_ref: Option<&str>,
  new_ref: Option<&str>,
) -> Result<CredentialOperation, StorageError> {
  let created_at = now_rfc3339();
  conn
    .execute(
      "INSERT INTO credential_operations (
            id, owner_kind, owner_id, expected_old_ref, new_ref, state, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'prepared', ?6)",
      params![
        id.to_string(),
        owner_kind.as_str(),
        owner_id,
        expected_old_ref,
        new_ref,
        created_at,
      ],
    )
    .map_err(|e| {
      // Unique owner index → credential busy.
      if let rusqlite::Error::SqliteFailure(code, _) = &e {
        if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
          || code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
        {
          return StorageError::CredentialBusy;
        }
      }
      StorageError::from(e)
    })?;
  Ok(CredentialOperation {
    id,
    owner_kind,
    owner_id: owner_id.to_string(),
    expected_old_ref: expected_old_ref.map(str::to_string),
    new_ref: new_ref.map(str::to_string),
    state: OperationState::Prepared,
    created_at,
  })
}

pub fn mark_db_committed(conn: &Connection, id: Uuid) -> Result<CredentialOperation, StorageError> {
  let changed = conn.execute(
    "UPDATE credential_operations SET state = 'db_committed' WHERE id = ?1",
    params![id.to_string()],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("credential_operation {id}")));
  }
  get_required(conn, id)
}

pub fn list_unfinished(conn: &Connection) -> Result<Vec<CredentialOperation>, StorageError> {
  let mut stmt = conn.prepare("SELECT * FROM credential_operations ORDER BY created_at ASC, id ASC")?;
  let rows = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get_by_id(conn: &Connection, id: Uuid) -> Result<Option<CredentialOperation>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM credential_operations WHERE id = ?1",
        params![id.to_string()],
        map_row,
      )
      .optional()?,
  )
}

pub fn get_for_owner(
  conn: &Connection,
  owner_kind: OwnerKind,
  owner_id: &str,
) -> Result<Option<CredentialOperation>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM credential_operations WHERE owner_kind = ?1 AND owner_id = ?2",
        params![owner_kind.as_str(), owner_id],
        map_row,
      )
      .optional()?,
  )
}

pub fn delete(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM credential_operations WHERE id = ?1",
    params![id.to_string()],
  )?;
  Ok(())
}

/// Insert a journal row already in db_committed state (e.g. post-delete cleanup).
pub fn insert_db_committed(
  conn: &Connection,
  id: Uuid,
  owner_kind: OwnerKind,
  owner_id: &str,
  expected_old_ref: Option<&str>,
  new_ref: Option<&str>,
) -> Result<CredentialOperation, StorageError> {
  let created_at = now_rfc3339();
  conn
    .execute(
      "INSERT INTO credential_operations (
            id, owner_kind, owner_id, expected_old_ref, new_ref, state, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'db_committed', ?6)",
      params![
        id.to_string(),
        owner_kind.as_str(),
        owner_id,
        expected_old_ref,
        new_ref,
        created_at,
      ],
    )
    .map_err(|e| {
      if let rusqlite::Error::SqliteFailure(code, _) = &e {
        if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
          || code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
        {
          return StorageError::CredentialBusy;
        }
      }
      StorageError::from(e)
    })?;
  Ok(CredentialOperation {
    id,
    owner_kind,
    owner_id: owner_id.to_string(),
    expected_old_ref: expected_old_ref.map(str::to_string),
    new_ref: new_ref.map(str::to_string),
    state: OperationState::DbCommitted,
    created_at,
  })
}

/// Reload the operation after marking it db_committed so callers hold complete state.
pub fn get_required(conn: &Connection, id: Uuid) -> Result<CredentialOperation, StorageError> {
  get_by_id(conn, id)?.ok_or_else(|| StorageError::NotFound(format!("credential_operation {id}")))
}
