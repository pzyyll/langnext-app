// ABOUTME: SQLite repository for exact integration endpoint approvals.
// ABOUTME: Rows are replaceable trust bindings and never contain secrets, DNS answers, or payloads.
use crate::domain::endpoint_trust::IntegrationEndpointTrust;
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<IntegrationEndpointTrust, rusqlite::Error> {
  let id: String = row.get("id")?;
  let instance_id: String = row.get("integration_instance_id")?;
  Ok(IntegrationEndpointTrust {
    id: Uuid::parse_str(&id)
      .map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error)))?,
    integration_instance_id: Uuid::parse_str(&instance_id)
      .map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error)))?,
    plugin_id: row.get("plugin_id")?,
    plugin_version: row.get("plugin_version")?,
    endpoint_alias: row.get("endpoint_alias")?,
    normalized_origin: row.get("normalized_origin")?,
    configuration_fingerprint: row.get("configuration_fingerprint")?,
    runtime_identity_fingerprint: row.get("runtime_identity_fingerprint")?,
    approved_at: row.get("approved_at")?,
  })
}

/// Look up an approval only when every host-owned binding field matches exactly.
pub fn get_exact(
  conn: &Connection,
  instance_id: Uuid,
  plugin_id: &str,
  plugin_version: &str,
  endpoint_alias: &str,
  normalized_origin: &str,
  configuration_fingerprint: &str,
  runtime_identity_fingerprint: &str,
) -> Result<Option<IntegrationEndpointTrust>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM integration_endpoint_trusts
         WHERE integration_instance_id = ?1
           AND plugin_id = ?2
           AND plugin_version = ?3
           AND endpoint_alias = ?4
           AND normalized_origin = ?5
           AND configuration_fingerprint = ?6
           AND runtime_identity_fingerprint = ?7
         ORDER BY approved_at DESC
         LIMIT 1",
        params![
          instance_id.to_string(),
          plugin_id,
          plugin_version,
          endpoint_alias,
          normalized_origin,
          configuration_fingerprint,
          runtime_identity_fingerprint,
        ],
        map_row,
      )
      .optional()?,
  )
}

/// Insert or refresh one exact approval binding.
pub fn upsert(conn: &Connection, trust: &IntegrationEndpointTrust) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO integration_endpoint_trusts (
          id, integration_instance_id, plugin_id, plugin_version, endpoint_alias,
          normalized_origin, configuration_fingerprint, runtime_identity_fingerprint, approved_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (
          integration_instance_id, plugin_id, plugin_version, endpoint_alias,
          normalized_origin, configuration_fingerprint, runtime_identity_fingerprint
       ) DO UPDATE SET approved_at = excluded.approved_at",
      params![
        trust.id.to_string(),
        trust.integration_instance_id.to_string(),
        trust.plugin_id,
        trust.plugin_version,
        trust.endpoint_alias,
        trust.normalized_origin,
        trust.configuration_fingerprint,
        trust.runtime_identity_fingerprint,
        trust.approved_at,
      ],
    )
    .map_err(|error| StorageError::from_sqlite_constraint(error, "integration endpoint trust"))?;
  Ok(())
}

/// Revoke every endpoint approval for an instance before a normal/default save.
pub fn delete_for_instance(conn: &Connection, instance_id: Uuid) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM integration_endpoint_trusts WHERE integration_instance_id = ?1",
    params![instance_id.to_string()],
  )?;
  Ok(())
}

/// Count approvals for repository and non-mutating preview tests.
pub fn count_for_instance(conn: &Connection, instance_id: Uuid) -> Result<i64, StorageError> {
  Ok(conn.query_row(
    "SELECT COUNT(*) FROM integration_endpoint_trusts WHERE integration_instance_id = ?1",
    params![instance_id.to_string()],
    |row| row.get(0),
  )?)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::time::new_id;
  use crate::storage::Database;

  #[test]
  fn exact_approval_round_trip_and_revoke() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::new(directory.path()).unwrap();
    database.initialize().unwrap();
    let instance_id = new_id();
    let trust = IntegrationEndpointTrust {
      id: new_id(),
      integration_instance_id: instance_id,
      plugin_id: "com.example.plugin".into(),
      plugin_version: "1.0.0".into(),
      endpoint_alias: "endpoint".into(),
      normalized_origin: "https://example.com".into(),
      configuration_fingerprint: "a".repeat(64),
      runtime_identity_fingerprint: "b".repeat(64),
      approved_at: "2026-01-01T00:00:00Z".into(),
    };
    database
      .transaction(|unit| {
        unit.conn().execute(
          "INSERT INTO integration_instances (
             id, plugin_id, plugin_version, display_name, enabled, config_json,
             config_schema_version, health_status, runtime_kind, runtime_state,
             created_at, updated_at
           ) VALUES (?1, 'com.example.plugin', '1.0.0', 'Test', 1, '{}', 1,
                     'unconfigured', 'bundled-rust', 'active', ?2, ?2)",
          rusqlite::params![instance_id.to_string(), trust.approved_at],
        )?;
        upsert(unit.conn(), &trust)?;
        assert_eq!(count_for_instance(unit.conn(), instance_id)?, 1);
        assert_eq!(
          get_exact(
            unit.conn(),
            instance_id,
            &trust.plugin_id,
            &trust.plugin_version,
            &trust.endpoint_alias,
            &trust.normalized_origin,
            &trust.configuration_fingerprint,
            &trust.runtime_identity_fingerprint,
          )?,
          Some(trust.clone())
        );
        delete_for_instance(unit.conn(), instance_id)?;
        assert_eq!(count_for_instance(unit.conn(), instance_id)?, 0);
        Ok(())
      })
      .unwrap();
  }
}
