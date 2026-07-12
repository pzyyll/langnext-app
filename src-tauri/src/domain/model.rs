// ABOUTME: Provider model domain entities, sync inputs, and IPC DTOs.
// ABOUTME: Models belong to one Provider instance and track remote availability.
use crate::error::StorageError;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Versioned sparse capability overrides accepted on manual writes and import.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityOverridesV1 {
	pub schema_version: u32,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub streaming: Option<bool>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub max_context_tokens: Option<u32>,
}

impl CapabilityOverridesV1 {
	pub const SCHEMA_VERSION: u32 = 1;

	pub fn validate(&self) -> Result<(), StorageError> {
		if self.schema_version != Self::SCHEMA_VERSION {
			return Err(StorageError::Validation(format!(
				"unsupported capabilityOverrides.schemaVersion {}",
				self.schema_version
			)));
		}
		Ok(())
	}

	/// Parse optional JSON into a validated override document.
	pub fn from_json(value: &Option<serde_json::Value>) -> Result<Option<Self>, StorageError> {
		match value {
			None | Some(serde_json::Value::Null) => Ok(None),
			Some(v) => {
				let parsed: Self = serde_json::from_value(v.clone())
					.map_err(|e| StorageError::Validation(format!("invalid capabilityOverrides: {e}")))?;
				parsed.validate()?;
				Ok(Some(parsed))
			}
		}
	}

	pub fn to_json(value: &Option<Self>) -> Option<serde_json::Value> {
		value
			.as_ref()
			.map(|v| serde_json::to_value(v).expect("capability overrides serialize"))
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelSource {
	Remote,
	Manual,
	Builtin,
}

impl ModelSource {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::Remote => "remote",
			Self::Manual => "manual",
			Self::Builtin => "builtin",
		}
	}

	pub fn parse(value: &str) -> Result<Self, String> {
		match value {
			"remote" => Ok(Self::Remote),
			"manual" => Ok(Self::Manual),
			"builtin" => Ok(Self::Builtin),
			other => Err(format!("invalid model source: {other}")),
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
	Available,
	Missing,
	Unknown,
}

impl Availability {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::Available => "available",
			Self::Missing => "missing",
			Self::Unknown => "unknown",
		}
	}

	pub fn parse(value: &str) -> Result<Self, String> {
		match value {
			"available" => Ok(Self::Available),
			"missing" => Ok(Self::Missing),
			"unknown" => Ok(Self::Unknown),
			other => Err(format!("invalid availability: {other}")),
		}
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
	pub id: Uuid,
	pub provider_instance_id: Uuid,
	pub model_key: String,
	pub source: ModelSource,
	pub remote_display_name: Option<String>,
	pub display_name_override: Option<String>,
	pub enabled: bool,
	pub availability: Availability,
	pub remote_metadata_json: Option<serde_json::Value>,
	/// Versioned sparse capability overrides (`CapabilityOverridesV1` JSON).
	pub capability_overrides_json: Option<serde_json::Value>,
	/// Optional API Type override; when null/absent, runtime inherits the channel adapter.
	#[serde(default)]
	pub adapter_id: Option<String>,
	pub last_seen_at: Option<String>,
	pub created_at: String,
	pub updated_at: String,
}

pub type ProviderModelDto = ProviderModel;

/// Input for creating or updating a manual model.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualModelWrite {
	pub id: Option<Uuid>,
	pub provider_instance_id: Uuid,
	pub model_key: String,
	pub display_name_override: Option<String>,
	pub enabled: bool,
	pub capability_overrides_json: Option<serde_json::Value>,
	/// Optional API Type override; null/empty inherits the channel adapter at runtime.
	#[serde(default)]
	pub adapter_id: Option<String>,
}

/// One remote model row returned by a Provider adapter for cache merge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModelSyncItem {
	pub model_key: String,
	pub remote_display_name: Option<String>,
	pub remote_metadata_json: Option<serde_json::Value>,
}

/// Result of testing a saved provider connection without mutating model rows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
	pub ok: bool,
	/// Bounded transport/credential code; never `connection_changed`.
	pub error_code: Option<String>,
	pub message: String,
	pub model_count: Option<usize>,
	/// Non-sensitive connection version (`provider.updated_at` at resolve time).
	/// Frontend discards results that no longer match the current provider version.
	pub provider_updated_at: String,
}

/// Result of a full remote model sync, including refreshed provider/models on expected failure.
///
/// `error_code` may be a persisted models-sync error code or the non-persisted
/// `connection_changed` race outcome. Only bounded persisted codes are written to SQLite.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncModelsResult {
	pub ok: bool,
	pub error_code: Option<String>,
	pub message: String,
	pub models: Vec<ProviderModelDto>,
	pub provider: crate::domain::provider::ProviderInstanceDto,
}

/// Export shape for models (same fields; no secrets).
pub type ModelExport = ProviderModel;

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn model_source_round_trip() {
		for source in [ModelSource::Remote, ModelSource::Manual, ModelSource::Builtin] {
			assert_eq!(ModelSource::parse(source.as_str()).unwrap(), source);
		}
	}

	#[test]
	fn capability_overrides_v1_round_trip() {
		let overrides = CapabilityOverridesV1 {
			schema_version: 1,
			streaming: Some(true),
			max_context_tokens: Some(8192),
		};
		let json = serde_json::to_value(&overrides).unwrap();
		let back = CapabilityOverridesV1::from_json(&Some(json)).unwrap().unwrap();
		assert_eq!(back, overrides);
	}

	#[test]
	fn capability_overrides_reject_unknown_version() {
		let json = serde_json::json!({"schemaVersion": 99, "streaming": true});
		assert!(CapabilityOverridesV1::from_json(&Some(json)).is_err());
	}

	#[test]
	fn provider_model_deserializes_without_adapter_id() {
		// Older exports omit adapterId; serde default keeps null for channel inheritance.
		let json = serde_json::json!({
			"id": "00000000-0000-7000-8000-000000000002",
			"providerInstanceId": "00000000-0000-7000-8000-000000000001",
			"modelKey": "gpt-4o",
			"source": "manual",
			"remoteDisplayName": null,
			"displayNameOverride": "GPT-4o",
			"enabled": true,
			"availability": "available",
			"remoteMetadataJson": null,
			"capabilityOverridesJson": null,
			"lastSeenAt": null,
			"createdAt": "2026-07-10T00:00:00Z",
			"updatedAt": "2026-07-10T00:00:00Z"
		});
		let model: ProviderModel = serde_json::from_value(json).unwrap();
		assert!(model.adapter_id.is_none());
	}
}
