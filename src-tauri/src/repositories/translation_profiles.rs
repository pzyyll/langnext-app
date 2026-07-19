// ABOUTME: Translation profile and fallback-chain transactional persistence.
// ABOUTME: Profile saves replace the complete ordered target list and prompt templates in one unit of work.
use crate::domain::language_detection::LanguageDetectorConfig;
use crate::domain::translation_profile::{
  PromptTemplate, TranslationProfile, TranslationProfileDto, TranslationProfilePromptTemplate, TranslationProfileTarget,
};
use crate::error::StorageError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::collections::HashSet;
use uuid::Uuid;

fn map_profile(row: &Row<'_>) -> Result<TranslationProfile, rusqlite::Error> {
  let id: String = row.get("id")?;
  let enabled: i64 = row.get("enabled")?;
  let default_prompt_template_id: String = row.get("default_prompt_template_id")?;
  let provider_options: Option<String> = row.get("provider_options_json")?;
  let language_detection: Option<String> = row.get("language_detection_json")?;
  Ok(TranslationProfile {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    name: row.get("name")?,
    enabled: enabled != 0,
    template_version: row.get("template_version")?,
    default_prompt_template_id: Uuid::parse_str(&default_prompt_template_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    temperature: row.get("temperature")?,
    max_output_tokens: row.get("max_output_tokens")?,
    provider_options_json: provider_options
      .map(|s| serde_json::from_str(&s))
      .transpose()
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    source_lang: row.get("source_lang")?,
    target_lang: row.get("target_lang")?,
    primary_lang: row.get("primary_lang")?,
    preferred_target_lang: row.get("preferred_target_lang")?,
    language_detection: language_detection
      .map(|s| serde_json::from_str::<LanguageDetectorConfig>(&s))
      .transpose()
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

fn map_target(row: &Row<'_>) -> Result<TranslationProfileTarget, rusqlite::Error> {
  let profile_id: String = row.get("translation_profile_id")?;
  let model_id: String = row.get("provider_model_id")?;
  Ok(TranslationProfileTarget {
    translation_profile_id: Uuid::parse_str(&profile_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    provider_model_id: Uuid::parse_str(&model_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    priority: row.get("priority")?,
  })
}

fn map_prompt_template_row(row: &Row<'_>) -> Result<TranslationProfilePromptTemplate, rusqlite::Error> {
  let id: String = row.get("id")?;
  let profile_id: String = row.get("translation_profile_id")?;
  Ok(TranslationProfilePromptTemplate {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    translation_profile_id: Uuid::parse_str(&profile_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    name: row.get("name")?,
    system_template: row.get("system_template")?,
    user_template: row.get("user_template")?,
    sort_order: row.get("sort_order")?,
  })
}

fn to_prompt_template(row: TranslationProfilePromptTemplate) -> PromptTemplate {
  PromptTemplate {
    id: row.id,
    name: row.name,
    system_template: row.system_template,
    user_template: row.user_template,
  }
}

pub fn list(conn: &Connection) -> Result<Vec<TranslationProfile>, StorageError> {
  let mut stmt = conn.prepare("SELECT * FROM translation_profiles ORDER BY name ASC, id ASC")?;
  let rows = stmt.query_map([], map_profile)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn list_all_targets(conn: &Connection) -> Result<Vec<TranslationProfileTarget>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM translation_profile_models
         ORDER BY translation_profile_id ASC, priority ASC",
  )?;
  let rows = stmt.query_map([], map_target)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn list_all_prompt_templates(conn: &Connection) -> Result<Vec<TranslationProfilePromptTemplate>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM translation_profile_prompt_templates
         ORDER BY translation_profile_id ASC, sort_order ASC, id ASC",
  )?;
  let rows = stmt
    .query_map([], map_prompt_template_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn get(conn: &Connection, id: Uuid) -> Result<TranslationProfileDto, StorageError> {
  let profile = conn
    .query_row(
      "SELECT * FROM translation_profiles WHERE id = ?1",
      params![id.to_string()],
      map_profile,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("profile {id}")))?;
  let targets = list_targets(conn, id)?;
  let prompt_templates = list_prompt_templates(conn, id)?;
  Ok(TranslationProfileDto {
    profile,
    targets,
    prompt_templates,
  })
}

pub fn list_targets(conn: &Connection, profile_id: Uuid) -> Result<Vec<TranslationProfileTarget>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM translation_profile_models
         WHERE translation_profile_id = ?1
         ORDER BY priority ASC",
  )?;
  let rows = stmt
    .query_map(params![profile_id.to_string()], map_target)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn list_prompt_templates(conn: &Connection, profile_id: Uuid) -> Result<Vec<PromptTemplate>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM translation_profile_prompt_templates
         WHERE translation_profile_id = ?1
         ORDER BY sort_order ASC, id ASC",
  )?;
  let rows = stmt
    .query_map(params![profile_id.to_string()], map_prompt_template_row)?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows.into_iter().map(to_prompt_template).collect())
}

/// Load one prompt template and ensure it belongs to the given profile.
pub fn get_prompt_template_for_profile(
  conn: &Connection,
  profile_id: Uuid,
  template_id: Uuid,
) -> Result<PromptTemplate, StorageError> {
  let row = conn
    .query_row(
      "SELECT * FROM translation_profile_prompt_templates
             WHERE id = ?1 AND translation_profile_id = ?2",
      params![template_id.to_string(), profile_id.to_string()],
      map_prompt_template_row,
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("prompt template {template_id} for profile {profile_id}")))?;
  Ok(to_prompt_template(row))
}

pub fn insert_profile(conn: &Connection, profile: &TranslationProfile) -> Result<(), StorageError> {
  let options = match &profile.provider_options_json {
    Some(v) => Some(serde_json::to_string(v)?),
    None => None,
  };
  let detection = match &profile.language_detection {
    Some(v) => Some(serde_json::to_string(v)?),
    None => None,
  };
  conn
    .execute(
      "INSERT INTO translation_profiles (
            id, name, enabled, template_version, default_prompt_template_id,
            temperature, max_output_tokens, provider_options_json, source_lang, target_lang,
            primary_lang, preferred_target_lang, language_detection_json, created_at, updated_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
      params![
        profile.id.to_string(),
        profile.name,
        profile.enabled as i64,
        profile.template_version,
        profile.default_prompt_template_id.to_string(),
        profile.temperature,
        profile.max_output_tokens,
        options,
        profile.source_lang,
        profile.target_lang,
        profile.primary_lang,
        profile.preferred_target_lang,
        detection,
        profile.created_at,
        profile.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "profile"))?;
  Ok(())
}

pub fn update_profile(conn: &Connection, profile: &TranslationProfile) -> Result<(), StorageError> {
  let options = match &profile.provider_options_json {
    Some(v) => Some(serde_json::to_string(v)?),
    None => None,
  };
  let detection = match &profile.language_detection {
    Some(v) => Some(serde_json::to_string(v)?),
    None => None,
  };
  let changed = conn
    .execute(
      "UPDATE translation_profiles SET
            name = ?2,
            enabled = ?3,
            template_version = ?4,
            default_prompt_template_id = ?5,
            temperature = ?6,
            max_output_tokens = ?7,
            provider_options_json = ?8,
            source_lang = ?9,
            target_lang = ?10,
            primary_lang = ?11,
            preferred_target_lang = ?12,
            language_detection_json = ?13,
            updated_at = ?14
         WHERE id = ?1",
      params![
        profile.id.to_string(),
        profile.name,
        profile.enabled as i64,
        profile.template_version,
        profile.default_prompt_template_id.to_string(),
        profile.temperature,
        profile.max_output_tokens,
        options,
        profile.source_lang,
        profile.target_lang,
        profile.primary_lang,
        profile.preferred_target_lang,
        detection,
        profile.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "profile"))?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("profile {}", profile.id)));
  }
  Ok(())
}

pub fn replace_targets(
  conn: &Connection,
  profile_id: Uuid,
  targets: &[TranslationProfileTarget],
) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM translation_profile_models WHERE translation_profile_id = ?1",
    params![profile_id.to_string()],
  )?;
  for target in targets {
    conn
      .execute(
        "INSERT INTO translation_profile_models (translation_profile_id, provider_model_id, priority)
             VALUES (?1, ?2, ?3)",
        params![
          target.translation_profile_id.to_string(),
          target.provider_model_id.to_string(),
          target.priority,
        ],
      )
      .map_err(|e| StorageError::from_sqlite_constraint(e, "profile target"))?;
  }
  Ok(())
}

pub fn replace_prompt_templates(
  conn: &Connection,
  profile_id: Uuid,
  templates: &[PromptTemplate],
) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM translation_profile_prompt_templates WHERE translation_profile_id = ?1",
    params![profile_id.to_string()],
  )?;
  for (index, template) in templates.iter().enumerate() {
    conn
      .execute(
        "INSERT INTO translation_profile_prompt_templates (
                    id, translation_profile_id, name, system_template, user_template, sort_order
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
          template.id.to_string(),
          profile_id.to_string(),
          template.name,
          template.system_template,
          template.user_template,
          index as i32,
        ],
      )
      .map_err(|e| StorageError::from_sqlite_constraint(e, "profile prompt template"))?;
  }
  Ok(())
}

/// Whether a model is explicitly configured as an LLM language detector.
pub fn detection_model_is_referenced(conn: &Connection, model_id: Uuid) -> Result<bool, StorageError> {
  Ok(list(conn)?.into_iter().any(|profile| {
    profile
      .language_detection
      .as_ref()
      .and_then(|config| config.llm_model_id())
      .is_some_and(|configured_id| configured_id == model_id)
  }))
}

/// Clear dedicated detector models owned by a provider before deleting that provider.
/// Profiles then fall back to their primary model instead of retaining orphaned JSON ids.
pub fn clear_detection_models_by_provider(
  conn: &Connection,
  provider_id: Uuid,
  updated_at: &str,
) -> Result<(), StorageError> {
  let model_ids: HashSet<String> = {
    let mut stmt = conn.prepare("SELECT id FROM provider_models WHERE provider_instance_id = ?1")?;
    let ids = stmt
      .query_map(params![provider_id.to_string()], |row| row.get(0))?
      .collect::<Result<_, _>>()?;
    ids
  };
  if model_ids.is_empty() {
    return Ok(());
  }

  for mut profile in list(conn)? {
    let references_provider = profile
      .language_detection
      .as_ref()
      .and_then(|config| config.llm_model_id())
      .is_some_and(|model_id| model_ids.contains(&model_id.to_string()));
    if references_provider {
      profile.language_detection = None;
      profile.updated_at = updated_at.to_string();
      update_profile(conn, &profile)?;
    }
  }
  Ok(())
}

/// Delete translation_profile_models rows referencing any model of a provider.
/// Call ahead of `provider_models::delete_by_provider` to satisfy the ON DELETE RESTRICT FK.
pub fn delete_targets_by_provider(conn: &Connection, provider_id: Uuid) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM translation_profile_models
         WHERE provider_model_id IN (SELECT id FROM provider_models WHERE provider_instance_id = ?1)",
    params![provider_id.to_string()],
  )?;
  Ok(())
}

/// Insert or update profile and replace targets + templates atomically on the given connection/transaction.
pub fn save_with_targets(
  conn: &Connection,
  profile: &TranslationProfile,
  targets: &[TranslationProfileTarget],
  prompt_templates: &[PromptTemplate],
  is_new: bool,
) -> Result<(), StorageError> {
  if is_new {
    insert_profile(conn, profile)?;
  } else {
    update_profile(conn, profile)?;
  }
  replace_targets(conn, profile.id, targets)?;
  replace_prompt_templates(conn, profile.id, prompt_templates)?;
  Ok(())
}

pub fn set_enabled(conn: &Connection, id: Uuid, enabled: bool, updated_at: &str) -> Result<(), StorageError> {
  let changed = conn.execute(
    "UPDATE translation_profiles SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
    params![id.to_string(), enabled as i64, updated_at],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("profile {id}")));
  }
  Ok(())
}

pub fn delete(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
  let changed = conn.execute(
    "DELETE FROM translation_profiles WHERE id = ?1",
    params![id.to_string()],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!("profile {id}")));
  }
  Ok(())
}
