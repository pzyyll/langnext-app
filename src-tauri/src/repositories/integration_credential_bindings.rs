// ABOUTME: Integration credential slot bindings (opaque vault ref + revision).
// ABOUTME: Secrets never leave the vault; CAS protects concurrent slot updates.
use crate::domain::service_integration::IntegrationCredentialBinding;
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<IntegrationCredentialBinding, rusqlite::Error> {
  let id: String = row.get("id")?;
  let instance_id: String = row.get("integration_instance_id")?;
  Ok(IntegrationCredentialBinding {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    integration_instance_id: Uuid::parse_str(&instance_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    slot_id: row.get("slot_id")?,
    credential_ref: row.get("credential_ref")?,
    credential_revision: row.get("credential_revision")?,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

pub fn list_for_instance(
  conn: &Connection,
  instance_id: Uuid,
) -> Result<Vec<IntegrationCredentialBinding>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM integration_credential_bindings
     WHERE integration_instance_id = ?1
     ORDER BY slot_id ASC",
  )?;
  let rows = stmt
    .query_map(params![instance_id.to_string()], map_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get(conn: &Connection, instance_id: Uuid, slot_id: &str) -> Result<IntegrationCredentialBinding, StorageError> {
  conn
    .query_row(
      "SELECT * FROM integration_credential_bindings
       WHERE integration_instance_id = ?1 AND slot_id = ?2",
      params![instance_id.to_string(), slot_id],
      map_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("integration credential binding {instance_id}/{slot_id}")))
}

pub fn get_optional(
  conn: &Connection,
  instance_id: Uuid,
  slot_id: &str,
) -> Result<Option<IntegrationCredentialBinding>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM integration_credential_bindings
         WHERE integration_instance_id = ?1 AND slot_id = ?2",
        params![instance_id.to_string(), slot_id],
        map_row,
      )
      .optional()?,
  )
}

pub fn insert(conn: &Connection, binding: &IntegrationCredentialBinding) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO integration_credential_bindings (
            id, integration_instance_id, slot_id, credential_ref,
            credential_revision, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      params![
        binding.id.to_string(),
        binding.integration_instance_id.to_string(),
        binding.slot_id,
        binding.credential_ref,
        binding.credential_revision,
        binding.created_at,
        binding.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "integration credential binding"))?;
  Ok(())
}

/// Compare-and-set credential_ref and bump revision on success.
pub fn compare_and_set_ref(
  conn: &Connection,
  instance_id: Uuid,
  slot_id: &str,
  expected_old_ref: Option<&str>,
  new_ref: Option<&str>,
  updated_at: &str,
) -> Result<IntegrationCredentialBinding, StorageError> {
  let changed = match expected_old_ref {
    Some(old) => conn.execute(
      "UPDATE integration_credential_bindings SET
            credential_ref = ?3,
            credential_revision = credential_revision + 1,
            updated_at = ?4
         WHERE integration_instance_id = ?1 AND slot_id = ?2 AND credential_ref = ?5",
      params![instance_id.to_string(), slot_id, new_ref, updated_at, old],
    )?,
    None => conn.execute(
      "UPDATE integration_credential_bindings SET
            credential_ref = ?3,
            credential_revision = credential_revision + 1,
            updated_at = ?4
         WHERE integration_instance_id = ?1 AND slot_id = ?2 AND credential_ref IS NULL",
      params![instance_id.to_string(), slot_id, new_ref, updated_at],
    )?,
  };
  if changed == 0 {
    return Err(StorageError::Conflict(
      "integration credential binding changed concurrently".into(),
    ));
  }
  get(conn, instance_id, slot_id)
}

pub fn delete_for_instance(conn: &Connection, instance_id: Uuid) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM integration_credential_bindings WHERE integration_instance_id = ?1",
    params![instance_id.to_string()],
  )?;
  Ok(())
}
