// ABOUTME: Typed storage errors and secret-free IPC error mapping.
// ABOUTME: Command handlers convert StorageError into stable IpcError codes.
use serde::Serialize;
use thiserror::Error;

/// Internal storage and application-service failures.
#[derive(Debug, Error)]
pub enum StorageError {
  #[error("validation failed: {0}")]
  Validation(String),

  #[error("not found: {0}")]
  NotFound(String),

  #[error("conflict: {0}")]
  Conflict(String),

  #[error("in use: {0}")]
  InUse(String),

  #[error("credential busy for owner")]
  CredentialBusy,

  #[error("credential store unavailable")]
  CredentialUnavailable,

  #[error("credential operation failed")]
  CredentialAccess,

  #[error("storage unavailable: {0}")]
  StorageUnavailable(String),

  #[error("storage version unsupported: {0}")]
  StorageVersionUnsupported(String),

  #[error("io error: {0}")]
  Io(#[from] std::io::Error),

  #[error("sqlite error")]
  Sqlite(#[from] rusqlite::Error),

  #[error("serialization error")]
  Serialization(#[from] serde_json::Error),

  #[error("migration failed: {0}")]
  Migration(String),

  #[error("internal error")]
  Internal(String),
}

/// Sanitized error returned to the WebView. Never includes secrets or SQL.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
  pub code: String,
  pub message: String,
}

impl IpcError {
  pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
    Self {
      code: code.into(),
      message: message.into(),
    }
  }
}

impl From<StorageError> for IpcError {
  fn from(value: StorageError) -> Self {
    match value {
      StorageError::Validation(msg) => IpcError::new("validation_failed", msg),
      StorageError::NotFound(msg) => IpcError::new("not_found", msg),
      StorageError::Conflict(msg) => IpcError::new("conflict", msg),
      StorageError::InUse(msg) => IpcError::new("in_use", msg),
      StorageError::CredentialBusy => IpcError::new("credential_busy", "A credential operation is already in progress"),
      StorageError::CredentialUnavailable => {
        IpcError::new("credential_unavailable", "The system credential store is unavailable")
      }
      StorageError::CredentialAccess => IpcError::new("credential_unavailable", "Credential access failed"),
      StorageError::StorageUnavailable(msg) => IpcError::new("storage_unavailable", msg),
      StorageError::StorageVersionUnsupported(msg) => IpcError::new("storage_version_unsupported", msg),
      StorageError::Io(_) => IpcError::new("storage_unavailable", "Storage I/O failed"),
      StorageError::Sqlite(_) => IpcError::new("storage_unavailable", "Database error"),
      StorageError::Serialization(_) => IpcError::new("validation_failed", "Invalid configuration data"),
      StorageError::Migration(msg) => IpcError::new("storage_unavailable", msg),
      StorageError::Internal(_) => IpcError::new("internal_error", "An internal error occurred"),
    }
  }
}

impl StorageError {
  /// Map SQLite constraint failures to typed domain errors.
  pub fn from_sqlite_constraint(err: rusqlite::Error, context: &str) -> Self {
    match &err {
      rusqlite::Error::SqliteFailure(code, Some(message)) => {
        let msg = message.to_lowercase();
        if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY || msg.contains("foreign key") {
          return StorageError::InUse(format!("{context} is referenced by other records"));
        }
        if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
          || code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
          || msg.contains("unique")
        {
          return StorageError::Conflict(format!("duplicate {context}"));
        }
        StorageError::Sqlite(err)
      }
      _ => StorageError::Sqlite(err),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ipc_error_redacts_internal_details() {
    let err = StorageError::Sqlite(rusqlite::Error::InvalidQuery);
    let ipc = IpcError::from(err);
    assert_eq!(ipc.code, "storage_unavailable");
    assert!(!ipc.message.to_lowercase().contains("select"));
    assert!(!ipc.message.contains("password"));
  }

  #[test]
  fn validation_maps_to_stable_code() {
    let ipc = IpcError::from(StorageError::Validation("bad template".into()));
    assert_eq!(ipc.code, "validation_failed");
    assert_eq!(ipc.message, "bad template");
  }

  #[test]
  fn secret_sentinel_never_appears_in_ipc() {
    let secret = "sk-super-secret-key-value";
    // Even if validation message somehow included a secret-like string from user input,
    // credential errors themselves must not embed vault/SQL details.
    let ipc = IpcError::from(StorageError::CredentialAccess);
    assert!(!ipc.message.contains(secret));
    assert_eq!(ipc.code, "credential_unavailable");
  }
}
