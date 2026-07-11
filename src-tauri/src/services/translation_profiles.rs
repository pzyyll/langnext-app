// ABOUTME: Translation profile template/parameter validation and profile writes.
// ABOUTME: Fallback chains are stored as contiguous priorities starting at 0.
use crate::adapters::catalog;
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{
	TranslationProfile, TranslationProfileDto, TranslationProfileTarget, TranslationProfileWrite,
};
use crate::error::StorageError;
use crate::repositories::{provider_models, translation_profiles};
use crate::storage::Database;
use std::collections::HashMap;
use uuid::Uuid;

const ALLOWED_VARS: &[&str] = &["source_language", "target_language", "text"];

#[derive(Clone)]
pub struct TranslationProfileService {
	db: Database,
}

impl TranslationProfileService {
	pub fn new(db: Database) -> Self {
		Self { db }
	}

	/// List profiles with ordered target chains via two bulk SQL queries (no N+1).
	///
	/// Both SELECTs run inside one deferred read snapshot so a concurrent write
	/// cannot produce a torn view of profiles vs targets.
	pub fn list(&self) -> Result<Vec<TranslationProfileDto>, StorageError> {
		self.db.read_snapshot(|conn| {
			let profiles = translation_profiles::list(conn)?;
			let all_targets = translation_profiles::list_all_targets(conn)?;
			let mut by_profile: HashMap<Uuid, Vec<TranslationProfileTarget>> = HashMap::new();
			for target in all_targets {
				by_profile
					.entry(target.translation_profile_id)
					.or_default()
					.push(target);
			}
			Ok(
				profiles
					.into_iter()
					.map(|profile| {
						let targets = by_profile.remove(&profile.id).unwrap_or_default();
						TranslationProfileDto { profile, targets }
					})
					.collect(),
			)
		})
	}

	pub fn get(&self, id: Uuid) -> Result<TranslationProfileDto, StorageError> {
		self.db.read(|conn| translation_profiles::get(conn, id))
	}

	pub fn save(&self, input: TranslationProfileWrite) -> Result<TranslationProfileDto, StorageError> {
		validate_profile_write(&input)?;
		self.db.transaction(|uow| {
			// Validate all target models exist.
			for model_id in &input.target_model_ids {
				provider_models::get(uow.conn(), *model_id)?;
			}
			// Adapter options: use first target's provider adapter when present, else generic.
			let adapter_id = if let Some(first) = input.target_model_ids.first() {
				let model = provider_models::get(uow.conn(), *first)?;
				let provider = crate::repositories::provider_instances::get(uow.conn(), model.provider_instance_id)?;
				provider.adapter_id
			} else {
				"openai-compatible".into()
			};
			catalog::validate_profile_options(&adapter_id, &input.provider_options_json)?;

			let now = now_rfc3339();
			let (id, created_at, is_new) = match input.id {
				None => (new_id(), now.clone(), true),
				Some(id) => {
					let existing = translation_profiles::get(uow.conn(), id)?;
					(id, existing.profile.created_at, false)
				}
			};

			let profile = TranslationProfile {
				id,
				name: input.name.clone(),
				enabled: input.enabled,
				template_version: input.template_version,
				system_template: input.system_template.clone(),
				user_template: input.user_template.clone(),
				temperature: input.temperature,
				max_output_tokens: input.max_output_tokens,
				provider_options_json: input.provider_options_json.clone(),
				source_lang: normalize_optional_lang(input.source_lang.as_deref()),
				target_lang: normalize_optional_lang(input.target_lang.as_deref()),
				created_at,
				updated_at: now,
			};

			let targets: Vec<TranslationProfileTarget> = input
				.target_model_ids
				.iter()
				.enumerate()
				.map(|(i, model_id)| TranslationProfileTarget {
					translation_profile_id: id,
					provider_model_id: *model_id,
					priority: i as i32,
				})
				.collect();

			translation_profiles::save_with_targets(uow.conn(), &profile, &targets, is_new)?;
			translation_profiles::get(uow.conn(), id)
		})
	}

	pub fn set_enabled(&self, id: Uuid, enabled: bool) -> Result<TranslationProfileDto, StorageError> {
		let now = now_rfc3339();
		self.db.transaction(|uow| {
			translation_profiles::set_enabled(uow.conn(), id, enabled, &now)?;
			translation_profiles::get(uow.conn(), id)
		})
	}

	pub fn delete(&self, id: Uuid) -> Result<(), StorageError> {
		self.db.transaction(|uow| translation_profiles::delete(uow.conn(), id))
	}
}

fn validate_profile_write(input: &TranslationProfileWrite) -> Result<(), StorageError> {
	if input.name.trim().is_empty() {
		return Err(StorageError::Validation("profile name must not be empty".into()));
	}
	if input.target_model_ids.is_empty() {
		return Err(StorageError::Validation(
			"profile requires at least one target model".into(),
		));
	}
	let mut seen = std::collections::HashSet::new();
	for id in &input.target_model_ids {
		if !seen.insert(*id) {
			return Err(StorageError::Validation("profile targets must be unique models".into()));
		}
	}
	if let Some(temp) = input.temperature {
		if temp < 0.0 {
			return Err(StorageError::Validation("temperature must be >= 0".into()));
		}
	}
	if let Some(tokens) = input.max_output_tokens {
		if tokens <= 0 {
			return Err(StorageError::Validation("max_output_tokens must be > 0".into()));
		}
	}
	validate_template(&input.system_template, false)?;
	validate_template(&input.user_template, true)?;
	Ok(())
}

/// Parse templates: allow only documented variables; user template requires `text` exactly once.
pub fn validate_template(template: &str, require_text_once: bool) -> Result<(), StorageError> {
	let mut text_count = 0usize;
	let mut rest = template;
	while let Some(start) = rest.find("{{") {
		let after = &rest[start + 2..];
		let Some(end) = after.find("}}") else {
			return Err(StorageError::Validation("unclosed template variable".into()));
		};
		let var = after[..end].trim();
		if !ALLOWED_VARS.contains(&var) {
			return Err(StorageError::Validation(format!("unknown template variable: {var}")));
		}
		if var == "text" {
			text_count += 1;
		}
		rest = &after[end + 2..];
	}
	if require_text_once && text_count != 1 {
		return Err(StorageError::Validation(
			"user_template must contain {{text}} exactly once".into(),
		));
	}
	Ok(())
}

/// Render a profile template by substituting the three allowed variables.
pub fn render_template(template: &str, source_language: &str, target_language: &str, text: &str) -> String {
	let mut out = String::with_capacity(template.len() + text.len());
	let mut rest = template;
	while let Some(start) = rest.find("{{") {
		out.push_str(&rest[..start]);
		let after = &rest[start + 2..];
		let Some(end) = after.find("}}") else {
			out.push_str("{{");
			out.push_str(after);
			return out;
		};
		let var = after[..end].trim();
		match var {
			"source_language" => out.push_str(source_language),
			"target_language" => out.push_str(target_language),
			"text" => out.push_str(text),
			other => {
				out.push_str("{{");
				out.push_str(other);
				out.push_str("}}");
			}
		}
		rest = &after[end + 2..];
	}
	out.push_str(rest);
	out
}

/// Default system template used when saving a profile from the translate page.
pub fn default_system_template() -> String {
	"You are a professional translation engine. Translate the user's text from {{source_language}} to {{target_language}}.\n\
		Rules:\n\
		- Output only the translated text, with no preface, labels, quotes, or explanations.\n\
		- Preserve meaning, tone, and formatting (line breaks, lists, punctuation) when possible.\n\
		- If the source is already in the target language, return it unchanged.\n\
		- Do not invent content that is not present in the source."
		.into()
}

/// Default user template: source text only.
pub fn default_user_template() -> String {
	"{{text}}".into()
}

fn normalize_optional_lang(value: Option<&str>) -> Option<String> {
	value.map(str::trim).filter(|s| !s.is_empty()).map(|s| s.to_string())
}
