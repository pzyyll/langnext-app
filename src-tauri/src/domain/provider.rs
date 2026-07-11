// ABOUTME: Provider instance domain entities, write inputs, and sanitized DTOs.
// ABOUTME: Credential secrets and references never appear on IPC DTOs.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
	None,
	ApiKey,
	Bearer,
}

impl CredentialKind {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::None => "none",
			Self::ApiKey => "api_key",
			Self::Bearer => "bearer",
		}
	}

	pub fn parse(value: &str) -> Result<Self, String> {
		match value {
			"none" => Ok(Self::None),
			"api_key" => Ok(Self::ApiKey),
			"bearer" => Ok(Self::Bearer),
			other => Err(format!("invalid credential_kind: {other}")),
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyMode {
	Inherit,
	Direct,
}

impl ProxyMode {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::Inherit => "inherit",
			Self::Direct => "direct",
		}
	}

	pub fn parse(value: &str) -> Result<Self, String> {
		match value {
			"inherit" => Ok(Self::Inherit),
			"direct" => Ok(Self::Direct),
			other => Err(format!("invalid proxy_mode: {other}")),
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelsSyncStatus {
	Never,
	Ok,
	Error,
}

impl ModelsSyncStatus {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::Never => "never",
			Self::Ok => "ok",
			Self::Error => "error",
		}
	}

	pub fn parse(value: &str) -> Result<Self, String> {
		match value {
			"never" => Ok(Self::Never),
			"ok" => Ok(Self::Ok),
			"error" => Ok(Self::Error),
			other => Err(format!("invalid models_sync_status: {other}")),
		}
	}
}

/// Internal Provider row including opaque credential reference.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstance {
	pub id: Uuid,
	pub adapter_id: String,
	pub display_name: String,
	pub base_url_override: Option<String>,
	pub credential_kind: CredentialKind,
	pub credential_ref: Option<String>,
	pub enabled: bool,
	pub proxy_mode: ProxyMode,
	pub insecure_http_confirmed_at: Option<String>,
	pub models_synced_at: Option<String>,
	pub models_sync_status: ModelsSyncStatus,
	pub models_sync_error_code: Option<String>,
	pub created_at: String,
	pub updated_at: String,
}

/// Sanitized Provider DTO for IPC. Never includes credential_ref.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstanceDto {
	pub id: Uuid,
	pub adapter_id: String,
	pub display_name: String,
	pub base_url_override: Option<String>,
	pub credential_kind: CredentialKind,
	pub has_credential: bool,
	pub enabled: bool,
	pub proxy_mode: ProxyMode,
	pub insecure_http_confirmed_at: Option<String>,
	pub models_synced_at: Option<String>,
	pub models_sync_status: ModelsSyncStatus,
	pub models_sync_error_code: Option<String>,
	pub created_at: String,
	pub updated_at: String,
}

impl From<&ProviderInstance> for ProviderInstanceDto {
	fn from(value: &ProviderInstance) -> Self {
		Self {
			id: value.id,
			adapter_id: value.adapter_id.clone(),
			display_name: value.display_name.clone(),
			base_url_override: value.base_url_override.clone(),
			credential_kind: value.credential_kind,
			has_credential: value.credential_ref.is_some(),
			enabled: value.enabled,
			proxy_mode: value.proxy_mode,
			insecure_http_confirmed_at: value.insecure_http_confirmed_at.clone(),
			models_synced_at: value.models_synced_at.clone(),
			models_sync_status: value.models_sync_status,
			models_sync_error_code: value.models_sync_error_code.clone(),
			created_at: value.created_at.clone(),
			updated_at: value.updated_at.clone(),
		}
	}
}

/// Credential mutation for Provider writes. Secrets are never printed via Debug.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "action", content = "value")]
pub enum CredentialUpdate {
	Keep,
	Replace(String),
	Clear,
}

impl std::fmt::Debug for CredentialUpdate {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Keep => write!(f, "Keep"),
			Self::Replace(_) => write!(f, "Replace([redacted])"),
			Self::Clear => write!(f, "Clear"),
		}
	}
}

/// Input for creating or updating a Provider instance.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstanceWrite {
	pub id: Option<Uuid>,
	pub adapter_id: String,
	pub display_name: String,
	pub base_url_override: Option<String>,
	pub credential_kind: CredentialKind,
	pub credential: CredentialUpdate,
	pub enabled: bool,
	pub proxy_mode: ProxyMode,
	pub insecure_http_confirmed_at: Option<String>,
	/// Optimistic concurrency baseline (`ProviderInstance.updated_at` when the form was loaded).
	/// Required when `id` is Some; ignored on create.
	#[serde(default)]
	pub expected_updated_at: Option<String>,
}

/// Export-only Provider shape (no credentials, sync errors, or device fields).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderExport {
	pub id: Uuid,
	pub adapter_id: String,
	pub display_name: String,
	pub base_url_override: Option<String>,
	pub credential_kind: CredentialKind,
	pub enabled: bool,
	pub proxy_mode: ProxyMode,
	pub insecure_http_confirmed_at: Option<String>,
	pub created_at: String,
	pub updated_at: String,
}

impl From<&ProviderInstance> for ProviderExport {
	fn from(value: &ProviderInstance) -> Self {
		Self {
			id: value.id,
			adapter_id: value.adapter_id.clone(),
			display_name: value.display_name.clone(),
			base_url_override: value.base_url_override.clone(),
			credential_kind: value.credential_kind,
			enabled: value.enabled,
			proxy_mode: value.proxy_mode,
			insecure_http_confirmed_at: value.insecure_http_confirmed_at.clone(),
			created_at: value.created_at.clone(),
			updated_at: value.updated_at.clone(),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn credential_update_debug_redacts_secret() {
		let update = CredentialUpdate::Replace("sk-super-secret".into());
		let debug = format!("{update:?}");
		assert!(!debug.contains("sk-super-secret"));
		assert!(debug.contains("redacted"));
	}

	#[test]
	fn dto_omits_credential_ref() {
		let provider = ProviderInstance {
			id: Uuid::nil(),
			adapter_id: "openai-compatible".into(),
			display_name: "Local".into(),
			base_url_override: None,
			credential_kind: CredentialKind::ApiKey,
			credential_ref: Some("provider/x/y".into()),
			enabled: true,
			proxy_mode: ProxyMode::Inherit,
			insecure_http_confirmed_at: None,
			models_synced_at: None,
			models_sync_status: ModelsSyncStatus::Never,
			models_sync_error_code: None,
			created_at: "t".into(),
			updated_at: "t".into(),
		};
		let dto = ProviderInstanceDto::from(&provider);
		let json = serde_json::to_string(&dto).unwrap();
		assert!(json.contains("hasCredential"));
		assert!(!json.contains("credentialRef"));
		assert!(!json.contains("provider/x/y"));
		assert!(dto.has_credential);
	}
}
