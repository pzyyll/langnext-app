// ABOUTME: Translation profile and fallback-chain transactional persistence.
// ABOUTME: Profile saves replace the complete ordered target list in one unit of work.
use crate::domain::language_detection::LanguageDetectorConfig;
use crate::domain::translation_profile::{TranslationProfile, TranslationProfileDto, TranslationProfileTarget};
use crate::error::StorageError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::collections::HashSet;
use uuid::Uuid;

fn map_profile(row: &Row<'_>) -> Result<TranslationProfile, rusqlite::Error> {
  let id: String = row.get("id")?;
  let enabled: i64 = row.get("enabled")?;
  let stream_enabled: i64 = row.get("stream_enabled")?;
  let provider_options: Option<String> = row.get("provider_options_json")?;
  let language_detection: Option<String> = row.get("language_detection_json")?;
  Ok(TranslationProfile {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    name: row.get("name")?,
    enabled: enabled != 0,
    stream_enabled: stream_enabled != 0,
    template_version: row.get("template_version")?,
    system_template: row.get("system_template")?,
    user_template: row.get("user_template")?,
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
  Ok(TranslationProfileDto { profile, targets })
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
            id, name, enabled, stream_enabled, template_version, system_template, user_template,
            temperature, max_output_tokens, provider_options_json, source_lang, target_lang,
            primary_lang, preferred_target_lang, language_detection_json, created_at, updated_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
      params![
        profile.id.to_string(),
        profile.name,
        profile.enabled as i64,
        profile.stream_enabled as i64,
        profile.template_version,
        profile.system_template,
        profile.user_template,
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
            stream_enabled = ?4,
            template_version = ?5,
            system_template = ?6,
            user_template = ?7,
            temperature = ?8,
            max_output_tokens = ?9,
            provider_options_json = ?10,
            source_lang = ?11,
            target_lang = ?12,
            primary_lang = ?13,
            preferred_target_lang = ?14,
            language_detection_json = ?15,
            updated_at = ?16
         WHERE id = ?1",
      params![
        profile.id.to_string(),
        profile.name,
        profile.enabled as i64,
        profile.stream_enabled as i64,
        profile.template_version,
        profile.system_template,
        profile.user_template,
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

/// Insert or update profile and replace targets atomically on the given connection/transaction.
pub fn save_with_targets(
  conn: &Connection,
  profile: &TranslationProfile,
  targets: &[TranslationProfileTarget],
  is_new: bool,
) -> Result<(), StorageError> {
  if is_new {
    insert_profile(conn, profile)?;
  } else {
    update_profile(conn, profile)?;
  }
  replace_targets(conn, profile.id, targets)?;
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
