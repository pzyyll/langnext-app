// ABOUTME: OCR service CRUD against SQLite (list/get/insert/update/delete).
// ABOUTME: Vault refs stay internal; services map to sanitized DTOs.
use crate::domain::ocr_service::{BaiduOcrAction, OcrProviderType, OcrService};
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<OcrService, rusqlite::Error> {
  let id: String = row.get("id")?;
  let provider_type: String = row.get("provider_type")?;
  let enabled: i64 = row.get("enabled")?;
  let baidu_action: Option<String> = row.get("baidu_action")?;
  let provider_model_id: Option<String> = row.get("provider_model_id")?;
  let default_prompt_template_id: Option<String> = row.get("default_prompt_template_id")?;
  let integration_instance_id: Option<String> = row.get("integration_instance_id")?;
  let ocr_capability_id: Option<String> = row.get("ocr_capability_id")?;
  let capability_preferences_version: Option<i64> = row.get("capability_preferences_version")?;
  let capability_preferences_json: Option<String> = row.get("capability_preferences_json")?;
  let capability_preferences = capability_preferences_json
    .map(|json| {
      serde_json::from_str::<Value>(&json)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
    })
    .transpose()?;
  Ok(OcrService {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    provider_type: OcrProviderType::parse(&provider_type)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
    display_name: row.get("display_name")?,
    enabled: enabled != 0,
    sort_order: row.get("sort_order")?,
    baidu_action: baidu_action
      .map(|value| {
        BaiduOcrAction::parse(&value)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))
      })
      .transpose()?,
    api_key_ref: row.get("api_key_ref")?,
    secret_key_ref: row.get("secret_key_ref")?,
    provider_model_id: provider_model_id
      .map(|value| {
        Uuid::parse_str(&value)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
      })
      .transpose()?,
    temperature: row.get("temperature")?,
    default_prompt_template_id: default_prompt_template_id
      .map(|value| {
        Uuid::parse_str(&value)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
      })
      .transpose()?,
    integration_instance_id: integration_instance_id
      .map(|value| {
        Uuid::parse_str(&value)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
      })
      .transpose()?,
    ocr_capability_id,
    capability_preferences_version: capability_preferences_version
      .map(|v| {
        i32::try_from(v)
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Integer, Box::new(e)))
      })
      .transpose()?,
    capability_preferences,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

pub fn list(conn: &Connection) -> Result<Vec<OcrService>, StorageError> {
  let mut stmt = conn.prepare("SELECT * FROM ocr_services ORDER BY sort_order ASC, created_at ASC, id ASC")?;
  let rows = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn list_by_integration_instance(
  conn: &Connection,
  integration_instance_id: Uuid,
) -> Result<Vec<OcrService>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM ocr_services
     WHERE integration_instance_id = ?1
     ORDER BY sort_order ASC, created_at ASC, id ASC",
  )?;
  let rows = stmt
    .query_map(params![integration_instance_id.to_string()], map_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get(conn: &Connection, id: Uuid) -> Result<OcrService, StorageError> {
  conn
    .query_row(
      "SELECT * FROM ocr_services WHERE id = ?1",
      params![id.to_string()],
      map_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("ocr service {id}")))
}

pub fn insert(conn: &Connection, service: &OcrService) -> Result<(), StorageError> {
  let preferences_json = service
    .capability_preferences
    .as_ref()
    .map(serde_json::to_string)
    .transpose()?;
  conn
    .execute(
      "INSERT INTO ocr_services (
            id, provider_type, display_name, enabled, sort_order,
            baidu_action, api_key_ref, secret_key_ref,
            provider_model_id, temperature, default_prompt_template_id,
            integration_instance_id, ocr_capability_id,
            capability_preferences_version, capability_preferences_json,
            created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4,
            (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ocr_services),
            ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
        )",
      params![
        service.id.to_string(),
        service.provider_type.as_str(),
        service.display_name,
        service.enabled as i64,
        service.baidu_action.map(|action| action.as_str()),
        service.api_key_ref,
        service.secret_key_ref,
        service.provider_model_id.map(|id| id.to_string()),
        service.temperature,
        service.default_prompt_template_id.map(|id| id.to_string()),
        service.integration_instance_id.map(|id| id.to_string()),
        service.ocr_capability_id,
        service.capability_preferences_version,
        preferences_json,
        service.created_at,
        service.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "ocr service"))?;
  Ok(())
}

/// Update configuration without rewriting vault refs (baidu / ai paths).
pub fn update_configuration_keep_credentials(
  conn: &Connection,
  id: Uuid,
  display_name: &str,
  enabled: bool,
  baidu_action: Option<BaiduOcrAction>,
  provider_model_id: Option<Uuid>,
  temperature: Option<f64>,
  default_prompt_template_id: Option<Uuid>,
  updated_at: &str,
) -> Result<(), StorageError> {
  let changed = conn
    .execute(
      "UPDATE ocr_services SET
            display_name = ?2,
            enabled = ?3,
            baidu_action = ?4,
            provider_model_id = ?5,
            temperature = ?6,
            default_prompt_template_id = ?7,
            updated_at = ?8
         WHERE id = ?1",
      params![
        id.to_string(),
        display_name,
        enabled as i64,
        baidu_action.map(|action| action.as_str()),
        provider_model_id.map(|model_id| model_id.to_string()),
        temperature,
        default_prompt_template_id.map(|template_id| template_id.to_string()),
        updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "ocr service"))?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("ocr service {id}")));
  }
  Ok(())
}

/// Update plugin_capability configuration (instance rebind + preferences).
pub fn update_plugin_configuration(
  conn: &Connection,
  id: Uuid,
  display_name: &str,
  enabled: bool,
  integration_instance_id: Uuid,
  ocr_capability_id: &str,
  capability_preferences_version: i32,
  capability_preferences: &Value,
  updated_at: &str,
) -> Result<(), StorageError> {
  let preferences_json = serde_json::to_string(capability_preferences)?;
  let changed = conn
    .execute(
      "UPDATE ocr_services SET
            display_name = ?2,
            enabled = ?3,
            integration_instance_id = ?4,
            ocr_capability_id = ?5,
            capability_preferences_version = ?6,
            capability_preferences_json = ?7,
            updated_at = ?8
         WHERE id = ?1",
      params![
        id.to_string(),
        display_name,
        enabled as i64,
        integration_instance_id.to_string(),
        ocr_capability_id,
        capability_preferences_version,
        preferences_json,
        updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "ocr service"))?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("ocr service {id}")));
  }
  Ok(())
}

/// Compare-and-set api_key_ref; fails when the current ref differs.
pub fn compare_and_set_api_key_ref(
  conn: &Connection,
  id: Uuid,
  expected_old_ref: Option<&str>,
  new_ref: Option<&str>,
  updated_at: &str,
) -> Result<(), StorageError> {
  let changed = match expected_old_ref {
    Some(old) => conn.execute(
      "UPDATE ocr_services SET api_key_ref = ?2, updated_at = ?3
             WHERE id = ?1 AND api_key_ref = ?4",
      params![id.to_string(), new_ref, updated_at, old],
    )?,
    None => conn.execute(
      "UPDATE ocr_services SET api_key_ref = ?2, updated_at = ?3
             WHERE id = ?1 AND api_key_ref IS NULL",
      params![id.to_string(), new_ref, updated_at],
    )?,
  };
  if changed == 0 {
    return Err(StorageError::Conflict(
      "ocr api key reference changed concurrently".into(),
    ));
  }
  Ok(())
}

/// Compare-and-set secret_key_ref; fails when the current ref differs.
pub fn compare_and_set_secret_key_ref(
  conn: &Connection,
  id: Uuid,
  expected_old_ref: Option<&str>,
  new_ref: Option<&str>,
  updated_at: &str,
) -> Result<(), StorageError> {
  let changed = match expected_old_ref {
    Some(old) => conn.execute(
      "UPDATE ocr_services SET secret_key_ref = ?2, updated_at = ?3
             WHERE id = ?1 AND secret_key_ref = ?4",
      params![id.to_string(), new_ref, updated_at, old],
    )?,
    None => conn.execute(
      "UPDATE ocr_services SET secret_key_ref = ?2, updated_at = ?3
             WHERE id = ?1 AND secret_key_ref IS NULL",
      params![id.to_string(), new_ref, updated_at],
    )?,
  };
  if changed == 0 {
    return Err(StorageError::Conflict(
      "ocr secret key reference changed concurrently".into(),
    ));
  }
  Ok(())
}

pub fn delete(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
  let changed = conn
    .execute("DELETE FROM ocr_services WHERE id = ?1", params![id.to_string()])
    .map_err(|e| StorageError::from_sqlite_constraint(e, "ocr service"))?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("ocr service {id}")));
  }
  Ok(())
}
