// ABOUTME: OCR AI prompt-template SQL helpers (list/replace by service).
// ABOUTME: Templates are replaced as a complete ordered list per save.
use crate::domain::ocr_service::{OcrPromptTemplate, OcrPromptTemplateRow};
use crate::error::StorageError;
use rusqlite::{Connection, Row, params};
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<OcrPromptTemplateRow, rusqlite::Error> {
  let id: String = row.get("id")?;
  let ocr_service_id: String = row.get("ocr_service_id")?;
  Ok(OcrPromptTemplateRow {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    ocr_service_id: Uuid::parse_str(&ocr_service_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    name: row.get("name")?,
    system_template: row.get("system_template")?,
    user_template: row.get("user_template")?,
    sort_order: row.get("sort_order")?,
  })
}

fn to_prompt_template(row: OcrPromptTemplateRow) -> OcrPromptTemplate {
  OcrPromptTemplate {
    id: row.id,
    name: row.name,
    system_template: row.system_template,
    user_template: row.user_template,
  }
}

pub fn list_all(conn: &Connection) -> Result<Vec<OcrPromptTemplateRow>, StorageError> {
  let mut stmt =
    conn.prepare("SELECT * FROM ocr_prompt_templates ORDER BY ocr_service_id ASC, sort_order ASC, id ASC")?;
  let rows = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn list_for_service(conn: &Connection, ocr_service_id: Uuid) -> Result<Vec<OcrPromptTemplate>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM ocr_prompt_templates
         WHERE ocr_service_id = ?1
         ORDER BY sort_order ASC, id ASC",
  )?;
  let rows = stmt
    .query_map(params![ocr_service_id.to_string()], map_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows.into_iter().map(to_prompt_template).collect())
}

/// Replace all templates for a service with the complete ordered list.
pub fn replace_for_service(
  conn: &Connection,
  ocr_service_id: Uuid,
  templates: &[OcrPromptTemplate],
) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM ocr_prompt_templates WHERE ocr_service_id = ?1",
    params![ocr_service_id.to_string()],
  )?;
  for (index, template) in templates.iter().enumerate() {
    conn
      .execute(
        "INSERT INTO ocr_prompt_templates (
                    id, ocr_service_id, name, system_template, user_template, sort_order
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
          template.id.to_string(),
          ocr_service_id.to_string(),
          template.name,
          template.system_template,
          template.user_template,
          index as i32,
        ],
      )
      .map_err(|e| StorageError::from_sqlite_constraint(e, "ocr prompt template"))?;
  }
  Ok(())
}
