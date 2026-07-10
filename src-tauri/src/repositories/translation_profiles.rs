// ABOUTME: Translation profile and fallback-chain transactional persistence.
// ABOUTME: Profile saves replace the complete ordered target list in one unit of work.
use crate::domain::translation_profile::{TranslationProfile, TranslationProfileDto, TranslationProfileTarget};
use crate::error::StorageError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

fn map_profile(row: &Row<'_>) -> Result<TranslationProfile, rusqlite::Error> {
	let id: String = row.get("id")?;
	let enabled: i64 = row.get("enabled")?;
	let provider_options: Option<String> = row.get("provider_options_json")?;
	Ok(TranslationProfile {
		id: Uuid::parse_str(&id)
			.map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
		name: row.get("name")?,
		enabled: enabled != 0,
		template_version: row.get("template_version")?,
		system_template: row.get("system_template")?,
		user_template: row.get("user_template")?,
		temperature: row.get("temperature")?,
		max_output_tokens: row.get("max_output_tokens")?,
		provider_options_json: provider_options
			.map(|s| serde_json::from_str(&s))
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
	conn
		.execute(
			"INSERT INTO translation_profiles (
            id, name, enabled, template_version, system_template, user_template,
            temperature, max_output_tokens, provider_options_json, created_at, updated_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
			params![
				profile.id.to_string(),
				profile.name,
				profile.enabled as i64,
				profile.template_version,
				profile.system_template,
				profile.user_template,
				profile.temperature,
				profile.max_output_tokens,
				options,
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
	let changed = conn
		.execute(
			"UPDATE translation_profiles SET
            name = ?2,
            enabled = ?3,
            template_version = ?4,
            system_template = ?5,
            user_template = ?6,
            temperature = ?7,
            max_output_tokens = ?8,
            provider_options_json = ?9,
            updated_at = ?10
         WHERE id = ?1",
			params![
				profile.id.to_string(),
				profile.name,
				profile.enabled as i64,
				profile.template_version,
				profile.system_template,
				profile.user_template,
				profile.temperature,
				profile.max_output_tokens,
				options,
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
