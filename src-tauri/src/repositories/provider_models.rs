// ABOUTME: Provider model CRUD and per-interface remote synchronization row writes.
// ABOUTME: Sync identity includes the source API type; cross-type missing transitions never happen.
use crate::domain::model::{Availability, ModelSource, ProviderModel, RemoteModelSyncItem};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<ProviderModel, rusqlite::Error> {
  let id: String = row.get("id")?;
  let provider_instance_id: String = row.get("provider_instance_id")?;
  let source: String = row.get("source")?;
  let availability: String = row.get("availability")?;
  let enabled: i64 = row.get("enabled")?;
  let remote_metadata: Option<String> = row.get("remote_metadata_json")?;
  let capability_overrides: Option<String> = row.get("capability_overrides_json")?;
  Ok(ProviderModel {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    provider_instance_id: Uuid::parse_str(&provider_instance_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    model_key: row.get("model_key")?,
    source: ModelSource::parse(&source)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
    remote_display_name: row.get("remote_display_name")?,
    display_name_override: row.get("display_name_override")?,
    enabled: enabled != 0,
    availability: Availability::parse(&availability)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
    remote_metadata_json: remote_metadata
      .map(|s| serde_json::from_str(&s))
      .transpose()
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    capability_overrides_json: capability_overrides
      .map(|s| serde_json::from_str(&s))
      .transpose()
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    adapter_id: row.get("adapter_id")?,
    source_adapter_id: row.get("source_adapter_id")?,
    last_seen_at: row.get("last_seen_at")?,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

fn json_opt(value: &Option<serde_json::Value>) -> Result<Option<String>, StorageError> {
  match value {
    None => Ok(None),
    Some(v) => Ok(Some(serde_json::to_string(v)?)),
  }
}

pub fn list_by_provider(conn: &Connection, provider_id: Uuid) -> Result<Vec<ProviderModel>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM provider_models WHERE provider_instance_id = ?1
         ORDER BY model_key ASC, id ASC",
  )?;
  let rows = stmt
    .query_map(params![provider_id.to_string()], map_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn list_all(conn: &Connection) -> Result<Vec<ProviderModel>, StorageError> {
  let mut stmt = conn.prepare("SELECT * FROM provider_models ORDER BY model_key ASC, id ASC")?;
  let rows = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get(conn: &Connection, id: Uuid) -> Result<ProviderModel, StorageError> {
  conn
    .query_row(
      "SELECT * FROM provider_models WHERE id = ?1",
      params![id.to_string()],
      map_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("model {id}")))
}

/// Look up one model by provider, model key, and discovery source API type. The empty
/// sentinel matches manual/builtin rows; a non-empty source never matches them.
pub fn get_by_provider_key_and_source(
  conn: &Connection,
  provider_id: Uuid,
  model_key: &str,
  source_adapter_id: &str,
) -> Result<Option<ProviderModel>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM provider_models
          WHERE provider_instance_id = ?1 AND model_key = ?2 AND source_adapter_id = ?3",
        params![provider_id.to_string(), model_key, source_adapter_id],
        map_row,
      )
      .optional()?,
  )
}

/// Look up one model by provider and model key, failing deterministically when the key is
/// ambiguous across discovery source API types.
pub fn get_by_provider_key_unique(
  conn: &Connection,
  provider_id: Uuid,
  model_key: &str,
) -> Result<Option<ProviderModel>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM provider_models
      WHERE provider_instance_id = ?1 AND model_key = ?2
      ORDER BY source_adapter_id ASC, id ASC",
  )?;
  let rows = stmt
    .query_map(params![provider_id.to_string(), model_key], map_row)?
    .collect::<Result<Vec<_>, _>>()?;
  match rows.as_slice() {
    [] => Ok(None),
    [one] => Ok(Some(one.clone())),
    _ => Err(StorageError::Conflict(format!(
      "model key '{model_key}' is ambiguous across source API types for provider {provider_id}"
    ))),
  }
}

pub fn insert(conn: &Connection, model: &ProviderModel) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO provider_models (
            id, provider_instance_id, model_key, source, remote_display_name,
            display_name_override, enabled, availability, remote_metadata_json,
            capability_overrides_json, adapter_id, source_adapter_id, last_seen_at,
            created_at, updated_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
      params![
        model.id.to_string(),
        model.provider_instance_id.to_string(),
        model.model_key,
        model.source.as_str(),
        model.remote_display_name,
        model.display_name_override,
        model.enabled as i64,
        model.availability.as_str(),
        json_opt(&model.remote_metadata_json)?,
        json_opt(&model.capability_overrides_json)?,
        model.adapter_id,
        model.source_adapter_id,
        model.last_seen_at,
        model.created_at,
        model.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "model"))?;
  Ok(())
}

pub fn update(conn: &Connection, model: &ProviderModel) -> Result<(), StorageError> {
  let changed = conn
    .execute(
      "UPDATE provider_models SET
            model_key = ?2,
            source = ?3,
            remote_display_name = ?4,
            display_name_override = ?5,
            enabled = ?6,
            availability = ?7,
            remote_metadata_json = ?8,
            capability_overrides_json = ?9,
            adapter_id = ?10,
            source_adapter_id = ?11,
            last_seen_at = ?12,
            updated_at = ?13
         WHERE id = ?1",
      params![
        model.id.to_string(),
        model.model_key,
        model.source.as_str(),
        model.remote_display_name,
        model.display_name_override,
        model.enabled as i64,
        model.availability.as_str(),
        json_opt(&model.remote_metadata_json)?,
        json_opt(&model.capability_overrides_json)?,
        model.adapter_id,
        model.source_adapter_id,
        model.last_seen_at,
        model.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "model"))?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("model {}", model.id)));
  }
  Ok(())
}

/// Set optional API Type override for any model source. Pass `None` to inherit the effective source.
pub fn set_adapter_id(
  conn: &Connection,
  id: Uuid,
  adapter_id: Option<&str>,
  updated_at: &str,
) -> Result<(), StorageError> {
  let changed = conn.execute(
    "UPDATE provider_models SET adapter_id = ?2, updated_at = ?3 WHERE id = ?1",
    params![id.to_string(), adapter_id, updated_at],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("model {id}")));
  }
  Ok(())
}

pub fn set_enabled(conn: &Connection, id: Uuid, enabled: bool, updated_at: &str) -> Result<(), StorageError> {
  let changed = conn.execute(
    "UPDATE provider_models SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
    params![id.to_string(), enabled as i64, updated_at],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("model {id}")));
  }
  Ok(())
}

pub fn delete(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
  let changed = conn
    .execute("DELETE FROM provider_models WHERE id = ?1", params![id.to_string()])
    .map_err(|e| StorageError::from_sqlite_constraint(e, "model"))?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("model {id}")));
  }
  Ok(())
}

/// Delete all models belonging to a provider instance.
/// Call ahead of `provider_instances::delete` to satisfy the ON DELETE RESTRICT FK.
pub fn delete_by_provider(conn: &Connection, provider_id: Uuid) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM provider_models WHERE provider_instance_id = ?1",
    params![provider_id.to_string()],
  )?;
  Ok(())
}

/// Apply remote synchronization rows for ONE selected API type inside the caller's
/// transaction. Every new remote row is stamped with `source_adapter_id`; the `missing`
/// transition is limited to remote rows whose discovery source matches the completed sync
/// type, so one interface's sync never marks another interface's models missing.
pub fn apply_remote_sync(
  conn: &Connection,
  provider_id: Uuid,
  source_adapter_id: &str,
  remote_models: &[RemoteModelSyncItem],
  seen_at: &str,
) -> Result<(), StorageError> {
  let existing = list_by_provider(conn, provider_id)?;
  let returned_keys: std::collections::HashSet<&str> = remote_models.iter().map(|m| m.model_key.as_str()).collect();

  for item in remote_models {
    if let Some(mut row) = get_by_provider_key_and_source(conn, provider_id, &item.model_key, source_adapter_id)? {
      // Preserve manual/builtin source; update remote metadata and last_seen.
      if row.source == ModelSource::Remote {
        row.availability = Availability::Available;
        row.remote_display_name = item.remote_display_name.clone();
        row.remote_metadata_json = item.remote_metadata_json.clone();
        // Seed catalog capabilities only when the user has not configured overrides yet.
        if row.capability_overrides_json.is_none() {
          row.capability_overrides_json = item.capability_overrides_json.clone();
        }
      } else {
        // Colliding manual/builtin: update non-user remote metadata only.
        row.remote_display_name = item.remote_display_name.clone();
        row.remote_metadata_json = item.remote_metadata_json.clone();
      }
      row.last_seen_at = Some(seen_at.to_string());
      row.updated_at = now_rfc3339();
      update(conn, &row)?;
    } else if let Some(mut row) = get_by_provider_key_and_source(conn, provider_id, &item.model_key, "")? {
      // Manual/builtin rows are user-owned and keep their empty source sentinel; remote
      // discovery refreshes their metadata in place instead of creating a duplicate row.
      row.remote_display_name = item.remote_display_name.clone();
      row.remote_metadata_json = item.remote_metadata_json.clone();
      row.last_seen_at = Some(seen_at.to_string());
      row.updated_at = now_rfc3339();
      update(conn, &row)?;
    } else {
      let now = now_rfc3339();
      // Remote discovery only caches availability; the user opts models in explicitly.
      let model = ProviderModel {
        id: new_id(),
        provider_instance_id: provider_id,
        model_key: item.model_key.clone(),
        source: ModelSource::Remote,
        remote_display_name: item.remote_display_name.clone(),
        display_name_override: None,
        enabled: false,
        availability: Availability::Available,
        remote_metadata_json: item.remote_metadata_json.clone(),
        capability_overrides_json: item.capability_overrides_json.clone(),
        adapter_id: None,
        source_adapter_id: source_adapter_id.to_string(),
        last_seen_at: Some(seen_at.to_string()),
        created_at: now.clone(),
        updated_at: now,
      };
      insert(conn, &model)?;
    }
  }

  // Mark absent remote-only records of the completed source type as missing only.
  for row in existing {
    if row.source == ModelSource::Remote
      && row.source_adapter_id == source_adapter_id
      && !returned_keys.contains(row.model_key.as_str())
    {
      let mut missing = row;
      missing.availability = Availability::Missing;
      missing.updated_at = now_rfc3339();
      update(conn, &missing)?;
    }
  }
  Ok(())
}
