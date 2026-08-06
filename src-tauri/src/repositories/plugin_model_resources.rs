// ABOUTME: SQLite persistence for installed plugin model resources and download operations.
// ABOUTME: Stores content-address keys and status only; never returns absolute filesystem paths.
use crate::domain::plugin_model::PluginModelResourceStatus;
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginModelResourceRecord {
  pub model_resource_key: String,
  pub package_digest: String,
  pub model_id: String,
  pub model_version: String,
  pub model_api_version: u32,
  pub model_set_digest: String,
  pub status: PluginModelResourceStatus,
  pub installed_bytes: Option<u64>,
  pub content_address: Option<String>,
  pub error_code: Option<String>,
  pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginModelDownloadOperationRecord {
  pub operation_id: String,
  pub model_resource_key: String,
  pub package_digest: String,
  pub model_id: String,
  /// Instance that started the download; cancel requires matching ownership.
  pub initiating_instance_id: String,
  pub state: String,
  pub bytes_downloaded: u64,
  pub total_bytes: u64,
  pub error_code: Option<String>,
  pub created_at: String,
  pub updated_at: String,
}

fn map_resource(row: &Row<'_>) -> Result<PluginModelResourceRecord, rusqlite::Error> {
  let status: String = row.get("status")?;
  Ok(PluginModelResourceRecord {
    model_resource_key: row.get("model_resource_key")?,
    package_digest: row.get("package_digest")?,
    model_id: row.get("model_id")?,
    model_version: row.get("model_version")?,
    model_api_version: row.get::<_, i64>("model_api_version")? as u32,
    model_set_digest: row.get("model_set_digest")?,
    status: PluginModelResourceStatus::parse(&status)
      .map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, error.into()))?,
    installed_bytes: row.get::<_, Option<i64>>("installed_bytes")?.map(|v| v as u64),
    content_address: row.get("content_address")?,
    error_code: row.get("error_code")?,
    updated_at: row.get("updated_at")?,
  })
}

fn map_operation(row: &Row<'_>) -> Result<PluginModelDownloadOperationRecord, rusqlite::Error> {
  Ok(PluginModelDownloadOperationRecord {
    operation_id: row.get("operation_id")?,
    model_resource_key: row.get("model_resource_key")?,
    package_digest: row.get("package_digest")?,
    model_id: row.get("model_id")?,
    initiating_instance_id: row.get("initiating_instance_id")?,
    state: row.get("state")?,
    bytes_downloaded: row.get::<_, i64>("bytes_downloaded")? as u64,
    total_bytes: row.get::<_, i64>("total_bytes")? as u64,
    error_code: row.get("error_code")?,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

pub fn get_by_package_and_model(
  conn: &Connection,
  package_digest: &str,
  model_id: &str,
) -> Result<Option<PluginModelResourceRecord>, StorageError> {
  conn
    .query_row(
      "SELECT model_resource_key, package_digest, model_id, model_version, model_api_version,
              model_set_digest, status, installed_bytes, content_address, error_code, updated_at
       FROM plugin_model_resources
       WHERE package_digest = ?1 AND model_id = ?2",
      params![package_digest, model_id],
      map_resource,
    )
    .optional()
    .map_err(StorageError::from)
}

pub fn list_by_package(
  conn: &Connection,
  package_digest: &str,
) -> Result<Vec<PluginModelResourceRecord>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT model_resource_key, package_digest, model_id, model_version, model_api_version,
            model_set_digest, status, installed_bytes, content_address, error_code, updated_at
     FROM plugin_model_resources
     WHERE package_digest = ?1
     ORDER BY model_id ASC",
  )?;
  let rows = stmt
    .query_map(params![package_digest], map_resource)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn upsert_resource(conn: &Connection, record: &PluginModelResourceRecord) -> Result<(), StorageError> {
  conn.execute(
    "INSERT INTO plugin_model_resources (
       model_resource_key, package_digest, model_id, model_version, model_api_version,
       model_set_digest, status, installed_bytes, content_address, error_code, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(model_resource_key) DO UPDATE SET
       model_version = excluded.model_version,
       model_api_version = excluded.model_api_version,
       model_set_digest = excluded.model_set_digest,
       status = excluded.status,
       installed_bytes = excluded.installed_bytes,
       content_address = excluded.content_address,
       error_code = excluded.error_code,
       updated_at = excluded.updated_at",
    params![
      record.model_resource_key,
      record.package_digest,
      record.model_id,
      record.model_version,
      record.model_api_version as i64,
      record.model_set_digest,
      record.status.as_str(),
      record.installed_bytes.map(|v| v as i64),
      record.content_address,
      record.error_code,
      record.updated_at,
    ],
  )?;
  Ok(())
}

pub fn insert_operation(conn: &Connection, record: &PluginModelDownloadOperationRecord) -> Result<(), StorageError> {
  conn.execute(
    "INSERT INTO plugin_model_download_operations (
       operation_id, model_resource_key, package_digest, model_id, initiating_instance_id, state,
       bytes_downloaded, total_bytes, error_code, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    params![
      record.operation_id,
      record.model_resource_key,
      record.package_digest,
      record.model_id,
      record.initiating_instance_id,
      record.state,
      record.bytes_downloaded as i64,
      record.total_bytes as i64,
      record.error_code,
      record.created_at,
      record.updated_at,
    ],
  )?;
  Ok(())
}

pub fn get_operation(
  conn: &Connection,
  operation_id: &str,
) -> Result<Option<PluginModelDownloadOperationRecord>, StorageError> {
  conn
    .query_row(
      "SELECT operation_id, model_resource_key, package_digest, model_id, initiating_instance_id, state,
              bytes_downloaded, total_bytes, error_code, created_at, updated_at
       FROM plugin_model_download_operations
       WHERE operation_id = ?1",
      params![operation_id],
      map_operation,
    )
    .optional()
    .map_err(StorageError::from)
}

pub fn update_operation_state(
  conn: &Connection,
  operation_id: &str,
  state: &str,
  bytes_downloaded: u64,
  error_code: Option<&str>,
  updated_at: &str,
) -> Result<(), StorageError> {
  conn.execute(
    "UPDATE plugin_model_download_operations
     SET state = ?2, bytes_downloaded = ?3, error_code = ?4, updated_at = ?5
     WHERE operation_id = ?1",
    params![operation_id, state, bytes_downloaded as i64, error_code, updated_at],
  )?;
  Ok(())
}

pub fn find_active_operation(
  conn: &Connection,
  model_resource_key: &str,
) -> Result<Option<PluginModelDownloadOperationRecord>, StorageError> {
  conn
    .query_row(
      "SELECT operation_id, model_resource_key, package_digest, model_id, initiating_instance_id, state,
              bytes_downloaded, total_bytes, error_code, created_at, updated_at
       FROM plugin_model_download_operations
       WHERE model_resource_key = ?1
         AND state IN ('prepared', 'downloading', 'verifying', 'installing')
       ORDER BY created_at DESC
       LIMIT 1",
      params![model_resource_key],
      map_operation,
    )
    .optional()
    .map_err(StorageError::from)
}

/// Resources left in `downloading` after a crash/restart — incomplete, not ready.
pub fn list_downloading_resources(conn: &Connection) -> Result<Vec<PluginModelResourceRecord>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT model_resource_key, package_digest, model_id, model_version, model_api_version,
            model_set_digest, status, installed_bytes, content_address, error_code, updated_at
     FROM plugin_model_resources
     WHERE status = 'downloading'
     ORDER BY model_resource_key ASC",
  )?;
  let rows = stmt.query_map([], map_resource)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

/// In-flight download operations that must be failed closed on startup recovery.
pub fn list_active_operations(conn: &Connection) -> Result<Vec<PluginModelDownloadOperationRecord>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT operation_id, model_resource_key, package_digest, model_id, initiating_instance_id, state,
            bytes_downloaded, total_bytes, error_code, created_at, updated_at
     FROM plugin_model_download_operations
     WHERE state IN ('prepared', 'downloading', 'verifying', 'installing')
     ORDER BY created_at ASC",
  )?;
  let rows = stmt.query_map([], map_operation)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}
