// ABOUTME: Provider runtime binding identity, state, and sanitized IPC DTOs.
// ABOUTME: Package bytes, grants, snapshots, credential refs, and secrets never enter DTOs.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Runtime executor kind bound to a provider instance. `LegacyFrontendProvider` covers the
/// current TypeScript adapters; `WasmComponent` is an exact signed two-world LLM package.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderRuntimeKind {
  LegacyFrontendProvider,
  WasmComponent,
}

impl ProviderRuntimeKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::LegacyFrontendProvider => "legacy-frontend-provider",
      Self::WasmComponent => "wasm-component",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "legacy-frontend-provider" => Ok(Self::LegacyFrontendProvider),
      "wasm-component" => Ok(Self::WasmComponent),
      other => Err(format!("invalid provider runtime kind: {other}")),
    }
  }
}

/// Host-owned provider runtime state. Mirrors the closed DB enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRuntimeState {
  Active,
  PendingActivation,
  Unavailable,
}

impl ProviderRuntimeState {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Active => "active",
      Self::PendingActivation => "pending_activation",
      Self::Unavailable => "unavailable",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "active" => Ok(Self::Active),
      "pending_activation" => Ok(Self::PendingActivation),
      "unavailable" => Ok(Self::Unavailable),
      other => Err(format!("invalid provider runtime state: {other}")),
    }
  }
}

/// Authoritative persisted provider runtime binding row. One active binding owns one API
/// type (`adapter_id`) per Provider; aliases of the same Provider/package share the exact
/// grant revision while keeping independent adapter-keyed rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeBinding {
  pub provider_id: Uuid,
  /// Persisted effective API type this binding owns (Provider default or model override).
  pub adapter_id: String,
  pub runtime_kind: ProviderRuntimeKind,
  /// Exact signed package digest; always None for legacy bindings.
  pub package_digest: Option<String>,
  /// Execution grant-set revision; required only when the package binding is active.
  pub grant_set_revision: Option<u64>,
  pub state: ProviderRuntimeState,
  pub error_code: Option<String>,
  /// Sanitized, bounded error text; never secret material.
  pub error_message: Option<String>,
  /// Unresolved export-format runtime requirement restored by import.
  pub runtime_requirement_json: Option<String>,
  pub created_at: String,
  pub updated_at: String,
}

/// Sanitized provider runtime binding identity for IPC. Never includes package bytes, grants,
/// snapshots, credential references, or secret material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeBindingDto {
  pub adapter_id: String,
  pub runtime_kind: ProviderRuntimeKind,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub package_digest: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub grant_set_revision: Option<u64>,
  pub state: ProviderRuntimeState,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub error_code: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub error_message: Option<String>,
  pub updated_at: String,
}

impl From<&ProviderRuntimeBinding> for ProviderRuntimeBindingDto {
  fn from(value: &ProviderRuntimeBinding) -> Self {
    Self {
      adapter_id: value.adapter_id.clone(),
      runtime_kind: value.runtime_kind,
      package_digest: value.package_digest.clone(),
      grant_set_revision: value.grant_set_revision,
      state: value.state,
      error_code: value.error_code.clone(),
      error_message: value.error_message.clone(),
      updated_at: value.updated_at.clone(),
    }
  }
}

/// Construct the active legacy binding every provider receives at create/migration time for
/// its default API type.
pub fn legacy_frontend_binding(provider_id: Uuid, adapter_id: &str, now: &str) -> ProviderRuntimeBinding {
  ProviderRuntimeBinding {
    provider_id,
    adapter_id: adapter_id.to_string(),
    runtime_kind: ProviderRuntimeKind::LegacyFrontendProvider,
    package_digest: None,
    grant_set_revision: None,
    state: ProviderRuntimeState::Active,
    error_code: None,
    error_message: None,
    runtime_requirement_json: None,
    created_at: now.to_string(),
    updated_at: now.to_string(),
  }
}

/// One verified provider-runtime capability in the catalog: exact capability id, artifact
/// path, and artifact digest. Visibility is never execution authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeCatalogCapabilityDto {
  pub capability_id: String,
  pub artifact_path: String,
  pub artifact_digest: String,
}

/// Bounded host-interpreted detection defaults projected from a verified manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeDetectionDto {
  pub max_tokens: u32,
  pub thinking: bool,
}

/// Sanitized provider runtime package catalog entry. Projects only bounded aliases,
/// capability/artifact identity, and host-interpreted detection metadata; no package bytes,
/// grants, secrets, or activation authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeCatalogEntryDto {
  pub plugin_id: String,
  pub version: String,
  pub package_digest: String,
  pub publisher: crate::domain::runtime_lifecycle::PublisherIdentityDto,
  pub legacy_aliases: Vec<String>,
  pub capabilities: Vec<ProviderRuntimeCatalogCapabilityDto>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detection: Option<ProviderRuntimeDetectionDto>,
}

/// Upgrade preview returned to the frontend (no secrets, package bytes, or grant content).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeUpgradePreviewDto {
  pub preview_id: String,
  pub provider_id: Uuid,
  pub source: ProviderRuntimeBindingDto,
  pub target: ProviderRuntimeBindingDto,
  pub target_plugin_version: String,
  pub target_publisher: crate::domain::runtime_lifecycle::PublisherIdentityDto,
  pub legacy_aliases: Vec<String>,
  pub requires_permission_approval: bool,
  pub expires_at: String,
}

/// Apply input bound to an opaque upgrade preview.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProviderRuntimeUpgradeInput {
  pub preview_id: String,
  #[serde(default)]
  pub acknowledge_permissions: bool,
}

/// Rollback preview showing the stored prior host-owned identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeRollbackPreviewDto {
  pub preview_id: String,
  pub provider_id: Uuid,
  pub snapshot_id: Uuid,
  pub current: ProviderRuntimeBindingDto,
  pub target: ProviderRuntimeBindingDto,
  pub expires_at: String,
}

/// Apply input bound to an opaque rollback preview.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProviderRuntimeRollbackInput {
  pub preview_id: String,
}

/// Result of apply upgrade/rollback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeLifecycleResultDto {
  pub provider_id: Uuid,
  pub runtime: ProviderRuntimeBindingDto,
  pub updated_at: String,
}

/// Preview input for attaching/replacing ONE API type with an exact signed package.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewProviderRuntimeInterfaceAttachInput {
  pub provider_id: Uuid,
  /// API type this binding owns; must be declared by the package's legacy aliases.
  pub adapter_id: String,
  pub package_digest: String,
}

/// Apply input bound to an opaque interface attach/replace preview.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyProviderRuntimeInterfaceAttachInput {
  pub preview_id: String,
  #[serde(default)]
  pub acknowledge_permissions: bool,
}

/// Preview of attaching/replacing one API type binding (no secrets, package bytes, or grant content).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeInterfacePreviewDto {
  pub preview_id: String,
  pub provider_id: Uuid,
  pub adapter_id: String,
  pub source: ProviderRuntimeBindingDto,
  pub target: ProviderRuntimeBindingDto,
  pub target_plugin_version: String,
  pub target_publisher: crate::domain::runtime_lifecycle::PublisherIdentityDto,
  pub legacy_aliases: Vec<String>,
  pub requires_permission_approval: bool,
  pub expires_at: String,
}

/// Rollback preview input for ONE API type binding.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewProviderRuntimeInterfaceRollbackInput {
  pub provider_id: Uuid,
  pub adapter_id: String,
}

/// Apply input bound to an opaque interface rollback preview.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyProviderRuntimeInterfaceRollbackInput {
  pub preview_id: String,
}

/// Rollback preview showing the stored prior host-owned identity for one API type. A
/// migrated v24 Provider-scoped snapshot restores the whole Provider atomically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeInterfaceRollbackPreviewDto {
  pub preview_id: String,
  pub provider_id: Uuid,
  pub adapter_id: String,
  pub snapshot_id: Uuid,
  pub snapshot_scope: String,
  pub current: ProviderRuntimeBindingDto,
  pub target: ProviderRuntimeBindingDto,
  pub expires_at: String,
}

/// Direct detach input for ONE API type binding (CAS on the provider version AND the exact
/// binding identity the page loaded, so a stale detach after a concurrent replace is rejected).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRuntimeInterfaceDetachInput {
  pub provider_id: Uuid,
  pub adapter_id: String,
  pub expected_updated_at: String,
  /// `updated_at` of the target binding row when the page loaded it. Attach/replace/rollback
  /// never bump the provider row, so this is the only CAS that detects a stale replace.
  pub expected_binding_updated_at: String,
}

/// Direct discard input for one rollback snapshot set (CAS on the provider version).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRuntimeInterfaceDiscardSnapshotInput {
  pub provider_id: Uuid,
  pub snapshot_id: Uuid,
  pub expected_updated_at: String,
}

/// Result of interface attach/replace/rollback/detach lifecycle writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeInterfaceLifecycleResultDto {
  pub provider_id: Uuid,
  pub adapter_id: String,
  pub binding: ProviderRuntimeBindingDto,
  pub updated_at: String,
}

/// Sanitized provider runtime rollback snapshot for the frontend-reachable cleanup seam.
/// Projects the set identity, scope, adapter children, and the exact SOURCE package identity
/// (never the digest as plugin_id); no package bytes, grants, or secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeSnapshotDto {
  pub id: Uuid,
  pub provider_id: Uuid,
  /// "adapter" or "provider" (migrated whole-Provider rollback scope).
  pub scope: String,
  pub created_at: String,
  pub plugin_id: String,
  pub plugin_version: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub package_digest: Option<String>,
  /// API type adapters this snapshot can restore.
  pub adapter_ids: Vec<String>,
}

/// One bounded model descriptor returned by a verified `llm.models.list@1` Component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelDescriptor {
  pub id: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label: Option<String>,
}

/// Complete bounded model set returned by `ProviderRuntimeRouter::list_models`. The ABI
/// response is one aggregate list; guests that need remote cursor pagination must complete
/// their bounded page traversal internally before returning it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelsListResult {
  pub models: Vec<LlmModelDescriptor>,
}

/// Named bounds for the host-owned LLM chat preference envelope.
/// Upper bound for the copied `temperature` value (finite, OpenAI-style range).
pub const LLM_CHAT_TEMPERATURE_MAX: f64 = 2.0;
/// Upper bound for the copied `maxTokens` value.
pub const LLM_CHAT_MAX_TOKENS_MAX: u32 = 1_000_000;
/// Maximum semantic chat messages in one request.
pub const LLM_CHAT_MESSAGES_MAX_COUNT: usize = 128;
/// Maximum UTF-8 bytes in one semantic chat message content.
pub const LLM_CHAT_MESSAGE_CONTENT_MAX_BYTES: usize = 1024 * 1024;
/// Maximum UTF-8 bytes in a message role.
pub const LLM_CHAT_ROLE_MAX_BYTES: usize = 64;
/// Maximum UTF-8 bytes in the semantic model id.
pub const LLM_CHAT_MODEL_MAX_BYTES: usize = 256;
/// Maximum input images in one chat request (each passed as an owned host Blob).
pub const LLM_CHAT_IMAGES_MAX_COUNT: usize = 8;
/// Maximum decoded bytes of one input PNG passed as a host-owned Blob.
pub const LLM_CHAT_IMAGE_MAX_BYTES: usize = 10 * 1024 * 1024;
/// Maximum UTF-8 bytes of a unary complete message content.
pub const LLM_CHAT_COMPLETE_MESSAGE_MAX_BYTES: usize = 256 * 1024;
/// Maximum UTF-8 bytes of one streaming text delta.
pub const LLM_CHAT_DELTA_TEXT_MAX_BYTES: usize = 64 * 1024;
/// Maximum UTF-8 bytes of one streaming reasoning delta.
pub const LLM_CHAT_DELTA_REASONING_MAX_BYTES: usize = 64 * 1024;
/// Maximum UTF-8 bytes of a tool-call id.
pub const LLM_CHAT_TOOL_ID_MAX_BYTES: usize = 128;
/// Maximum UTF-8 bytes of a tool-call name.
pub const LLM_CHAT_TOOL_NAME_MAX_BYTES: usize = 128;
/// Maximum UTF-8 bytes of copied tool-call arguments JSON.
pub const LLM_CHAT_TOOL_ARGUMENTS_MAX_BYTES: usize = 128 * 1024;
/// Maximum cumulative output bytes (text + reasoning + tool arguments) across one stream.
pub const LLM_CHAT_TOTAL_OUTPUT_MAX_BYTES: usize = 1_000_000;
/// Maximum typed delta frames in one stream.
pub const LLM_CHAT_MAX_FRAMES: usize = 4096;

/// Host-owned LLM chat preferences envelope. The host selects and serializes exactly this
/// shape into `chat-request.preferences` (copied JSON); guests must not infer or override the
/// stream mode from provider protocol details.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LlmChatPreferencesV1 {
  pub stream: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub temperature: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub max_tokens: Option<u32>,
  pub thinking: bool,
}

impl LlmChatPreferencesV1 {
  /// Validate the host-owned envelope: bounded temperature/max-token values.
  pub fn validate(&self) -> Result<(), String> {
    if let Some(temperature) = self.temperature {
      if !temperature.is_finite() || temperature < -LLM_CHAT_TEMPERATURE_MAX || temperature > LLM_CHAT_TEMPERATURE_MAX {
        return Err(format!(
          "preferences.temperature must be finite and in [-{LLM_CHAT_TEMPERATURE_MAX}, {LLM_CHAT_TEMPERATURE_MAX}]"
        ));
      }
    }
    if let Some(max_tokens) = self.max_tokens {
      if max_tokens == 0 || max_tokens > LLM_CHAT_MAX_TOKENS_MAX {
        return Err(format!(
          "preferences.maxTokens must be in 1..={LLM_CHAT_MAX_TOKENS_MAX}"
        ));
      }
    }
    Ok(())
  }
}

/// One semantic chat message (never Provider wire format).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LlmChatMessage {
  pub role: String,
  pub content: String,
}

/// Semantic unary/streaming chat input. Images are host-side PNG bytes converted to owned
/// host Blobs before the WIT call; image bytes never cross WIT semantic fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LlmChatRequest {
  pub model: String,
  pub messages: Vec<LlmChatMessage>,
  #[serde(default)]
  pub images: Vec<Vec<u8>>,
  pub preferences: LlmChatPreferencesV1,
}

/// IPC input for the `provider_runtime_chat` command. `request_id` binds the request session
/// used by `cancel_provider_runtime`; `provider_model_id` names the persisted model whose
/// effective API type and exact binding the host resolves server-side. The mode is host-selected
/// via the persisted non-secret provider config and the `preferences.stream` flag. Callers
/// never pass a package digest, grant revision, or API type as authority.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRuntimeChatCommandInput {
  pub request_id: String,
  pub provider_model_id: Uuid,
  #[serde(default)]
  pub config: Vec<u8>,
  pub request: LlmChatRequest,
}

/// Bounded unary chat completion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChatCompleteResult {
  pub role: String,
  pub content: String,
}

/// Chat execution outcome: a bounded complete message, or a streaming run whose typed deltas
/// were already forwarded through the event sink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmChatResult {
  Complete(LlmChatCompleteResult),
  Streaming,
}

/// Sanitized typed delta forwarded from the LLM stream bridge to the frontend Channel.
/// Text is user-visible; reasoning/tool deltas are preserved as typed values and are never
/// reparsed as opaque bytes or persisted as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ProviderRuntimeChatEvent {
  Text {
    text: String,
  },
  Reasoning {
    text: String,
  },
  ToolCall {
    id: String,
    name: String,
    arguments_json: String,
  },
  Complete {
    status: String,
  },
}

/// Non-secret provider runtime requirement carried in configuration exports. Preserves the
/// exact package identity (digest, publisher, API version, legacy aliases, capabilities) but
/// never serializes an execution grant, grant revision, package bytes, credential reference,
/// or any activation authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRuntimeRequirementExport {
  /// Persisted effective API type this requirement names (v8+). Older documents omit it;
  /// import falls back to the Provider default API type.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub adapter_id: Option<String>,
  pub runtime_kind: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub package_digest: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub plugin_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub plugin_version: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub publisher_key_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub publisher_key_fingerprint: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub plugin_api_version: Option<String>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub legacy_aliases: Vec<String>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub capabilities: Vec<String>,
}

impl ProviderRuntimeRequirementExport {
  /// Normalized legacy requirement for providers without a runtime package binding.
  pub fn legacy() -> Self {
    Self {
      adapter_id: None,
      runtime_kind: "legacy-frontend-provider".into(),
      package_digest: None,
      plugin_id: None,
      plugin_version: None,
      publisher_key_id: None,
      publisher_key_fingerprint: None,
      plugin_api_version: None,
      legacy_aliases: Vec::new(),
      capabilities: Vec::new(),
    }
  }

  pub fn is_legacy(&self) -> bool {
    self.runtime_kind == "legacy-frontend-provider"
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn runtime_kind_and_state_round_trip() {
    for kind in [
      ProviderRuntimeKind::LegacyFrontendProvider,
      ProviderRuntimeKind::WasmComponent,
    ] {
      assert_eq!(ProviderRuntimeKind::parse(kind.as_str()).unwrap(), kind);
    }
    assert!(ProviderRuntimeKind::parse("bundled-rust").is_err());
    for state in [
      ProviderRuntimeState::Active,
      ProviderRuntimeState::PendingActivation,
      ProviderRuntimeState::Unavailable,
    ] {
      assert_eq!(ProviderRuntimeState::parse(state.as_str()).unwrap(), state);
    }
    assert!(ProviderRuntimeState::parse("broken").is_err());
  }

  #[test]
  fn binding_dto_is_sanitized() {
    let binding = ProviderRuntimeBinding {
      provider_id: Uuid::nil(),
      adapter_id: "openai-compatible".into(),
      runtime_kind: ProviderRuntimeKind::LegacyFrontendProvider,
      package_digest: None,
      grant_set_revision: None,
      state: ProviderRuntimeState::Active,
      error_code: None,
      error_message: None,
      runtime_requirement_json: None,
      created_at: "t".into(),
      updated_at: "t".into(),
    };
    let dto = ProviderRuntimeBindingDto::from(&binding);
    let json = serde_json::to_string(&dto).unwrap();
    assert!(json.contains("\"adapterId\":\"openai-compatible\""));
    assert!(json.contains("\"runtimeKind\":\"legacy-frontend-provider\""));
    assert!(json.contains("\"state\":\"active\""));
    assert!(!json.contains("runtimeRequirementJson"));
    assert!(!json.contains("credentialRef"));
    assert!(!json.contains("packageDigest"));
  }
}
