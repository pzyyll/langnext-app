// ABOUTME: Versioned portable application settings and proxy credential updates.
// ABOUTME: Proxy secrets stay out of the settings JSON document.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Global proxy mode for application networking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GlobalProxyMode {
	System,
	Custom,
}

impl GlobalProxyMode {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::System => "system",
			Self::Custom => "custom",
		}
	}

	pub fn parse(value: &str) -> Result<Self, String> {
		match value {
			"system" => Ok(Self::System),
			"custom" => Ok(Self::Custom),
			other => Err(format!("invalid global proxy mode: {other}")),
		}
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSettings {
	pub proxy_mode: GlobalProxyMode,
	/// Custom proxy URL when mode is custom; credentials are not embedded.
	pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationPreferences {
	pub auto_detect_source: bool,
	pub preserve_formatting: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutDefinition {
	pub id: String,
	pub binding: String,
}

/// Portable settings document stored in SQLite `app_settings.value_json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsV1 {
	pub schema_version: u32,
	pub ui_language: String,
	/// Null only before first authoritative Tauri initialization.
	pub theme: Option<String>,
	pub default_profile_id: Option<Uuid>,
	pub translation: TranslationPreferences,
	pub shortcuts: Vec<ShortcutDefinition>,
	pub network: NetworkSettings,
}

impl AppSettingsV1 {
	pub const SCHEMA_VERSION: u32 = 1;

	pub fn default_document() -> Self {
		Self {
			schema_version: Self::SCHEMA_VERSION,
			ui_language: "en".into(),
			theme: None,
			default_profile_id: None,
			translation: TranslationPreferences {
				auto_detect_source: true,
				preserve_formatting: true,
			},
			shortcuts: Vec::new(),
			network: NetworkSettings {
				proxy_mode: GlobalProxyMode::System,
				proxy_url: None,
			},
		}
	}
}

/// IPC DTO with derived proxy credential flag; no secret or reference.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsDto {
	#[serde(flatten)]
	pub settings: AppSettingsV1,
	pub proxy_has_credential: bool,
}

/// Proxy credential mutation. Secrets never print via Debug.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "action", content = "value")]
pub enum ProxyCredentialUpdate {
	Keep,
	Replace(String),
	Clear,
}

impl std::fmt::Debug for ProxyCredentialUpdate {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Keep => write!(f, "Keep"),
			Self::Replace(_) => write!(f, "Replace([redacted])"),
			Self::Clear => write!(f, "Clear"),
		}
	}
}

/// Settings update input including optional proxy credential change.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsUpdate {
	pub settings: AppSettingsV1,
	pub proxy_credential: ProxyCredentialUpdate,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn default_settings_serialize() {
		let settings = AppSettingsV1::default_document();
		let json = serde_json::to_string(&settings).unwrap();
		assert!(json.contains("schemaVersion"));
		assert!(json.contains("proxyMode"));
		let back: AppSettingsV1 = serde_json::from_str(&json).unwrap();
		assert_eq!(back, settings);
	}

	#[test]
	fn proxy_credential_debug_redacts() {
		let update = ProxyCredentialUpdate::Replace("proxy-pass".into());
		assert!(!format!("{update:?}").contains("proxy-pass"));
	}
}
