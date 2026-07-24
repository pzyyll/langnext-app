// ABOUTME: Translation profile and fallback-chain transactional persistence.
// ABOUTME: Engine-aware saves replace LLM targets/templates or plugin bindings in one unit of work.
use crate::domain::language_detection::LanguageDetectorConfig;
use crate::domain::translation_profile::{
  ENGINE_KIND_LLM_MODEL_CHAIN, ENGINE_KIND_PLUGIN_CAPABILITY, LlmModelChainEngine, PluginCapabilityEngine,
  PromptTemplate, TranslationProfile, TranslationProfileDto, TranslationProfileEngine,
  TranslationProfilePromptTemplate, TranslationProfileTarget,
};
use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, params};
use std::collections::HashSet;
use uuid::Uuid;

fn parse_uuid(value: &str, column: usize) -> Result<Uuid, rusqlite::Error> {
  Uuid::parse_str(value)
    .map_err(|e| rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(e)))
}

fn map_profile(row: &Row<'_>) -> Result<TranslationProfile, rusqlite::Error> {
  let id: String = row.get("id")?;
  let enabled: i64 = row.get("enabled")?;
  let engine_kind: String = row.get("engine_kind")?;
  let engine = match engine_kind.as_str() {
    ENGINE_KIND_LLM_MODEL_CHAIN => {
      let template_version: i32 = row.get("template_version")?;
      let default_prompt_template_id: String = row.get("default_prompt_template_id")?;
      let provider_options: Option<String> = row.get("provider_options_json")?;
      let language_detection: Option<String> = row.get("language_detection_json")?;
      TranslationProfileEngine::LlmModelChain(LlmModelChainEngine {
        template_version,
        default_prompt_template_id: parse_uuid(&default_prompt_template_id, 0)?,
        temperature: row.get("temperature")?,
        max_output_tokens: row.get("max_output_tokens")?,
        provider_options_json: provider_options
          .map(|s| serde_json::from_str(&s))
          .transpose()
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
        language_detection: language_detection
          .map(|s| serde_json::from_str::<LanguageDetectorConfig>(&s))
          .transpose()
          .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
      })
    }
    ENGINE_KIND_PLUGIN_CAPABILITY => {
      let integration_instance_id: String = row.get("integration_instance_id")?;
      let translate_capability_id: String = row.get("translate_capability_id")?;
      let detect_capability_id: Option<String> = row.get("detect_capability_id")?;
      let capability_preferences_version: i32 = row.get("capability_preferences_version")?;
      let preferences_json: String = row.get("capability_preferences_json")?;
      let capability_preferences = serde_json::from_str(&preferences_json)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?;
      TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
        integration_instance_id: parse_uuid(&integration_instance_id, 0)?,
        translate_capability_id,
        detect_capability_id,
        capability_preferences_version,
        capability_preferences,
      })
    }
    other => {
      return Err(rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
          std::io::ErrorKind::InvalidData,
          format!("invalid engine_kind: {other}"),
        )),
      ));
    }
  };

  Ok(TranslationProfile {
    id: parse_uuid(&id, 0)?,
    name: row.get("name")?,
    enabled: enabled != 0,
    source_lang: row.get("source_lang")?,
    target_lang: row.get("target_lang")?,
    primary_lang: row.get("primary_lang")?,
    preferred_target_lang: row.get("preferred_target_lang")?,
    engine,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

fn map_target(row: &Row<'_>) -> Result<TranslationProfileTarget, rusqlite::Error> {
  let profile_id: String = row.get("translation_profile_id")?;
  let model_id: String = row.get("provider_model_id")?;
  Ok(TranslationProfileTarget {
    translation_profile_id: parse_uuid(&profile_id, 0)?,
    provider_model_id: parse_uuid(&model_id, 0)?,
    priority: row.get("priority")?,
  })
}

fn map_prompt_template_row(row: &Row<'_>) -> Result<TranslationProfilePromptTemplate, rusqlite::Error> {
  let id: String = row.get("id")?;
  let profile_id: String = row.get("translation_profile_id")?;
  Ok(TranslationProfilePromptTemplate {
    id: parse_uuid(&id, 0)?,
    translation_profile_id: parse_uuid(&profile_id, 0)?,
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

fn engine_columns(
  engine: &TranslationProfileEngine,
) -> Result<
  (
    &'static str,
    Option<i32>,
    Option<String>,
    Option<f64>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i32>,
    Option<String>,
  ),
  StorageError,
> {
  match engine {
    TranslationProfileEngine::LlmModelChain(llm) => {
      let options = match &llm.provider_options_json {
        Some(v) => Some(serde_json::to_string(v)?),
        None => None,
      };
      let detection = match &llm.language_detection {
        Some(v) => Some(serde_json::to_string(v)?),
        None => None,
      };
      Ok((
        ENGINE_KIND_LLM_MODEL_CHAIN,
        Some(llm.template_version),
        Some(llm.default_prompt_template_id.to_string()),
        llm.temperature,
        llm.max_output_tokens,
        options,
        detection,
        None,
        None,
        None,
        None,
        None,
      ))
    }
    TranslationProfileEngine::PluginCapability(plugin) => {
      let preferences = serde_json::to_string(&plugin.capability_preferences)?;
      Ok((
        ENGINE_KIND_PLUGIN_CAPABILITY,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(plugin.integration_instance_id.to_string()),
        Some(plugin.translate_capability_id.clone()),
        plugin.detect_capability_id.clone(),
        Some(plugin.capability_preferences_version),
        Some(preferences),
      ))
    }
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

/// List plugin profiles bound to a given integration instance (for dependency guards).
pub fn list_by_integration_instance(
  conn: &Connection,
  integration_instance_id: Uuid,
) -> Result<Vec<TranslationProfile>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM translation_profiles
         WHERE integration_instance_id = ?1
         ORDER BY name ASC, id ASC",
  )?;
  let rows = stmt
    .query_map(params![integration_instance_id.to_string()], map_profile)?
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
  let targets = if profile.engine.is_llm() {
    list_targets(conn, id)?
  } else {
    Vec::new()
  };
  let prompt_templates = if profile.engine.is_llm() {
    list_prompt_templates(conn, id)?
  } else {
    Vec::new()
  };
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
  let (
    engine_kind,
    template_version,
    default_prompt_template_id,
    temperature,
    max_output_tokens,
    options,
    detection,
    integration_instance_id,
    translate_capability_id,
    detect_capability_id,
    capability_preferences_version,
    capability_preferences_json,
  ) = engine_columns(&profile.engine)?;

  conn
    .execute(
      "INSERT INTO translation_profiles (
            id, name, enabled, engine_kind,
            template_version, default_prompt_template_id,
            temperature, max_output_tokens, provider_options_json, language_detection_json,
            integration_instance_id, translate_capability_id, detect_capability_id,
            capability_preferences_version, capability_preferences_json,
            source_lang, target_lang, primary_lang, preferred_target_lang,
            created_at, updated_at
        ) VALUES (
            ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21
        )",
      params![
        profile.id.to_string(),
        profile.name,
        profile.enabled as i64,
        engine_kind,
        template_version,
        default_prompt_template_id,
        temperature,
        max_output_tokens,
        options,
        detection,
        integration_instance_id,
        translate_capability_id,
        detect_capability_id,
        capability_preferences_version,
        capability_preferences_json,
        profile.source_lang,
        profile.target_lang,
        profile.primary_lang,
        profile.preferred_target_lang,
        profile.created_at,
        profile.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "profile"))?;
  Ok(())
}

pub fn update_profile(conn: &Connection, profile: &TranslationProfile) -> Result<(), StorageError> {
  let (
    engine_kind,
    template_version,
    default_prompt_template_id,
    temperature,
    max_output_tokens,
    options,
    detection,
    integration_instance_id,
    translate_capability_id,
    detect_capability_id,
    capability_preferences_version,
    capability_preferences_json,
  ) = engine_columns(&profile.engine)?;

  let changed = conn
    .execute(
      "UPDATE translation_profiles SET
            name = ?2,
            enabled = ?3,
            engine_kind = ?4,
            template_version = ?5,
            default_prompt_template_id = ?6,
            temperature = ?7,
            max_output_tokens = ?8,
            provider_options_json = ?9,
            language_detection_json = ?10,
            integration_instance_id = ?11,
            translate_capability_id = ?12,
            detect_capability_id = ?13,
            capability_preferences_version = ?14,
            capability_preferences_json = ?15,
            source_lang = ?16,
            target_lang = ?17,
            primary_lang = ?18,
            preferred_target_lang = ?19,
            updated_at = ?20
         WHERE id = ?1",
      params![
        profile.id.to_string(),
        profile.name,
        profile.enabled as i64,
        engine_kind,
        template_version,
        default_prompt_template_id,
        temperature,
        max_output_tokens,
        options,
        detection,
        integration_instance_id,
        translate_capability_id,
        detect_capability_id,
        capability_preferences_version,
        capability_preferences_json,
        profile.source_lang,
        profile.target_lang,
        profile.primary_lang,
        profile.preferred_target_lang,
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

/// Clear dedicated detector configs that reference any of the given model ids.
/// Profiles then fall back to their primary model instead of retaining orphaned JSON ids.
/// Only LLM profiles carry detector config; plugin profiles are skipped.
pub fn clear_detection_models(
  conn: &Connection,
  model_ids: &HashSet<Uuid>,
  updated_at: &str,
) -> Result<(), StorageError> {
  if model_ids.is_empty() {
    return Ok(());
  }

  for mut profile in list(conn)? {
    let Some(llm) = profile.engine.as_llm() else {
      continue;
    };
    let references_model = llm
      .language_detection
      .as_ref()
      .and_then(|config| config.llm_model_id())
      .is_some_and(|model_id| model_ids.contains(&model_id));
    if references_model {
      if let TranslationProfileEngine::LlmModelChain(ref mut engine) = profile.engine {
        engine.language_detection = None;
      }
      profile.updated_at = updated_at.to_string();
      update_profile(conn, &profile)?;
    }
  }
  Ok(())
}

/// Clear dedicated detector models owned by a provider before deleting that provider.
pub fn clear_detection_models_by_provider(
  conn: &Connection,
  provider_id: Uuid,
  updated_at: &str,
) -> Result<(), StorageError> {
  let model_ids: HashSet<Uuid> = {
    let mut stmt = conn.prepare("SELECT id FROM provider_models WHERE provider_instance_id = ?1")?;
    let ids = stmt
      .query_map(params![provider_id.to_string()], |row| {
        let id: String = row.get(0)?;
        parse_uuid(&id, 0)
      })?
      .collect::<Result<_, _>>()?;
    ids
  };
  clear_detection_models(conn, &model_ids, updated_at)
}

/// Delete translation_profile_models rows for any of the given model ids.
/// Call ahead of `provider_models::delete` to satisfy the ON DELETE RESTRICT FK.
/// Remaining targets on affected profiles are recompacted to priorities `0..n-1` so the
/// first survivor becomes the primary again after a mid-chain delete.
pub fn delete_targets_by_models(conn: &Connection, model_ids: &[Uuid]) -> Result<(), StorageError> {
  if model_ids.is_empty() {
    return Ok(());
  }

  let mut affected_profiles: HashSet<Uuid> = HashSet::new();
  {
    let mut stmt = conn
      .prepare("SELECT DISTINCT translation_profile_id FROM translation_profile_models WHERE provider_model_id = ?1")?;
    for model_id in model_ids {
      let profile_ids = stmt
        .query_map(params![model_id.to_string()], |row| {
          let id: String = row.get(0)?;
          parse_uuid(&id, 0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
      affected_profiles.extend(profile_ids);
    }
  }

  for model_id in model_ids {
    conn.execute(
      "DELETE FROM translation_profile_models WHERE provider_model_id = ?1",
      params![model_id.to_string()],
    )?;
  }

  for profile_id in affected_profiles {
    recompact_target_priorities(conn, profile_id)?;
  }
  Ok(())
}

/// Delete translation_profile_models rows referencing any model of a provider.
/// Call ahead of `provider_models::delete_by_provider` to satisfy the ON DELETE RESTRICT FK.
pub fn delete_targets_by_provider(conn: &Connection, provider_id: Uuid) -> Result<(), StorageError> {
  // Collect affected profiles before the delete so survivors can be recompacted.
  let affected_profiles: HashSet<Uuid> = {
    let mut stmt = conn.prepare(
      "SELECT DISTINCT translation_profile_id FROM translation_profile_models
           WHERE provider_model_id IN (SELECT id FROM provider_models WHERE provider_instance_id = ?1)",
    )?;
    let ids = stmt
      .query_map(params![provider_id.to_string()], |row| {
        let id: String = row.get(0)?;
        parse_uuid(&id, 0)
      })?
      .collect::<Result<Vec<_>, _>>()?;
    ids.into_iter().collect()
  };

  conn.execute(
    "DELETE FROM translation_profile_models
         WHERE provider_model_id IN (SELECT id FROM provider_models WHERE provider_instance_id = ?1)",
    params![provider_id.to_string()],
  )?;

  for profile_id in affected_profiles {
    recompact_target_priorities(conn, profile_id)?;
  }
  Ok(())
}

/// Rewrite remaining targets as a contiguous `0..n-1` priority chain.
fn recompact_target_priorities(conn: &Connection, profile_id: Uuid) -> Result<(), StorageError> {
  let targets = list_targets(conn, profile_id)?;
  if targets.is_empty() {
    return Ok(());
  }
  let needs_recompact = targets
    .iter()
    .enumerate()
    .any(|(index, target)| target.priority != index as i32);
  if !needs_recompact {
    return Ok(());
  }
  let recompacted: Vec<TranslationProfileTarget> = targets
    .into_iter()
    .enumerate()
    .map(|(index, mut target)| {
      target.priority = index as i32;
      target
    })
    .collect();
  replace_targets(conn, profile_id, &recompacted)
}

/// Insert or update profile and replace targets + templates atomically on the given connection/transaction.
/// Plugin profiles must pass empty targets/templates (enforced by service validation).
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
