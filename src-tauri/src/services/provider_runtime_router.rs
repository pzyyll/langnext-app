// ABOUTME: Immutable provider binding/package/grant resolution for LLM runtime calls.
// ABOUTME: Re-verifies the signed package before every execution; never falls back to legacy.
use crate::domain::cancel::CancelToken;
use crate::domain::model::resolve_model_effective_adapter;
use crate::domain::plugin_package::{InstalledPluginVersion, runtime_kind_storage};
use crate::domain::runtime_lifecycle::GrantSubjectKind;
use crate::domain::runtime_plugin::{
  ComponentArtifactDigest, ExecutionGrantSet, FileRole, PackageDigest, PluginManifestV1, RuntimeKind,
};
use crate::domain::runtime_provider::{
  LlmChatCompleteResult, LlmChatRequest, LlmChatResult, LlmModelsListResult, ProviderRuntimeBinding,
  ProviderRuntimeChatEvent, ProviderRuntimeKind, ProviderRuntimeState,
};
use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
use crate::error::StorageError;
use crate::repositories::{
  installed_plugin_versions, plugin_permission_grants, plugin_publishers, provider_instances, provider_models,
  provider_runtime_bindings,
};
use crate::services::plugin_store::PluginPackageService;
use crate::services::runtime_router::bundle_to_execution_grant_set;
use crate::services::wasm_runtime::host::BrokerHandle;
use crate::services::wasm_runtime::{VerifiedComponent, WasmRuntime};
use crate::storage::Database;
use std::sync::Arc;
use std::time::Instant;
use uuid::Uuid;

/// Immutable host-only broker context bound to one exact adapter-keyed binding. Constructed
/// by the router from persisted state; never crosses IPC and never accepts a caller-supplied
/// package digest or grant revision. The broker re-reads the same
/// `(provider_id, adapter_id, package_digest, grant_revision)` record before vault lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRuntimeBrokerContext {
  pub provider_id: Uuid,
  pub adapter_id: String,
  pub package_digest: String,
  pub grant_revision: u64,
}

/// Immutable provider runtime resolution for LLM calls: binding, signed package, and
/// `ProviderInstance` grant are re-resolved and re-verified before EVERY execution. The broker
/// factory receives a host-only `ProviderRuntimeBrokerContext` and produces a host-authorized
/// provider-instance broker per request. There is no fallback: a missing/revoked binding is a
/// stable error, never a legacy replay.
#[derive(Clone)]
pub struct ProviderRuntimeRouter {
  db: Database,
  packages: PluginPackageService,
  wasm: Arc<WasmRuntime>,
  broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync>,
}

/// One resolved execution context for a provider runtime LLM call.
struct ResolvedExecution {
  binding: ProviderRuntimeBinding,
  grant: ExecutionGrantSet,
  verified: VerifiedComponent,
  /// Host-only binding identity handed to the broker factory; never crosses IPC.
  context: ProviderRuntimeBrokerContext,
}

impl ProviderRuntimeRouter {
  pub fn new(
    db: Database,
    packages: PluginPackageService,
    wasm: Arc<WasmRuntime>,
    broker_factory: Arc<dyn Fn(ProviderRuntimeBrokerContext) -> Box<dyn BrokerHandle> + Send + Sync>,
  ) -> Self {
    Self {
      db,
      packages,
      wasm,
      broker_factory,
    }
  }

  /// Execute `llm.models.list@1` for one provider API type: returns one bounded, normalized
  /// complete model set through the verified Component, provider grant, and broker.
  pub async fn list_models(
    &self,
    provider_id: Uuid,
    adapter_id: &str,
    request_id: &str,
    config: Vec<u8>,
    cancel: CancelToken,
    deadline: Option<Instant>,
  ) -> Result<LlmModelsListResult, CapabilityError> {
    let resolved = self.resolve(provider_id, adapter_id, "llm.models.list@1", request_id)?;
    let broker = (self.broker_factory)(resolved.context.clone());
    self
      .wasm
      .execute_llm_models_list(
        &resolved.verified,
        resolved
          .grant
          .principal_for_request("llm.models.list@1", request_id)
          .map_err(|_| CapabilityError::new(CapabilityErrorCode::PermissionDenied, "capability not granted"))?,
        resolved.grant,
        cancel,
        deadline,
        broker,
        config,
      )
      .await
  }

  /// Execute `llm.chat@1` for one persisted provider model with a host-owned non-stream
  /// preference envelope: returns one bounded complete message; a `streaming` result under
  /// `stream = false` is a stable invalid response and never falls back to the legacy executor.
  /// The effective API type is derived server-side from the persisted model row
  /// (override → source type → Provider default); callers never choose a package.
  pub async fn chat(
    &self,
    provider_model_id: Uuid,
    config: Vec<u8>,
    request: LlmChatRequest,
    request_id: &str,
    cancel: CancelToken,
    deadline: Option<Instant>,
  ) -> Result<LlmChatCompleteResult, CapabilityError> {
    if request.preferences.stream {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        "unary chat requires stream = false",
      ));
    }
    match self
      .execute_chat(provider_model_id, config, request, request_id, cancel, deadline, None)
      .await?
    {
      LlmChatResult::Complete(complete) => Ok(complete),
      LlmChatResult::Streaming => Err(CapabilityError::new(
        CapabilityErrorCode::InvalidResponse,
        "unexpected streaming result under a non-stream preference",
      )),
    }
  }

  /// Execute `llm.chat@1` for one persisted provider model with `stream = true`: typed deltas
  /// are forwarded to `on_event` as they arrive (bounded per-delta/cumulative/frame counts are
  /// enforced by the executor bridge before forwarding); the guest must return a streaming result.
  pub async fn chat_stream(
    &self,
    provider_model_id: Uuid,
    config: Vec<u8>,
    request: LlmChatRequest,
    request_id: &str,
    cancel: CancelToken,
    deadline: Option<Instant>,
    on_event: Box<dyn Fn(ProviderRuntimeChatEvent) -> Result<(), CapabilityError> + Send>,
  ) -> Result<LlmChatResult, CapabilityError> {
    if !request.preferences.stream {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidRequest,
        "streaming chat requires stream = true",
      ));
    }
    self
      .execute_chat(
        provider_model_id,
        config,
        request,
        request_id,
        cancel,
        deadline,
        Some(on_event),
      )
      .await
  }

  async fn execute_chat(
    &self,
    provider_model_id: Uuid,
    config: Vec<u8>,
    request: LlmChatRequest,
    request_id: &str,
    cancel: CancelToken,
    deadline: Option<Instant>,
    on_event: Option<Box<dyn Fn(ProviderRuntimeChatEvent) -> Result<(), CapabilityError> + Send>>,
  ) -> Result<LlmChatResult, CapabilityError> {
    let (provider_id, adapter_id) = self
      .db
      .read(|conn| {
        let model = provider_models::get(conn, provider_model_id)?;
        let provider = provider_instances::get(conn, model.provider_instance_id)?;
        let effective = resolve_model_effective_adapter(
          model.adapter_id.as_deref(),
          &model.source_adapter_id,
          &provider.adapter_id,
        );
        Ok((provider.id, effective))
      })
      .map_err(map_storage_to_capability)?;
    let resolved = self.resolve(provider_id, &adapter_id, "llm.chat@1", request_id)?;
    let broker = (self.broker_factory)(resolved.context.clone());
    let principal = resolved
      .grant
      .principal_for_request("llm.chat@1", request_id)
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::PermissionDenied, "capability not granted"))?;
    self
      .wasm
      .execute_llm_chat(
        &resolved.verified,
        principal,
        resolved.grant,
        cancel,
        deadline,
        broker,
        config,
        request,
        on_event,
      )
      .await
  }

  /// Resolve and re-verify the exact adapter-keyed binding/package/grant for one provider
  /// runtime call. The package digest and grant revision always come from the persisted
  /// binding row; IPC callers only name a Provider and API type.
  fn resolve(
    &self,
    provider_id: Uuid,
    adapter_id: &str,
    capability_id: &str,
    _request_id: &str,
  ) -> Result<ResolvedExecution, CapabilityError> {
    let binding = self
      .db
      .read(|conn| provider_runtime_bindings::get(conn, provider_id, adapter_id))
      .map_err(map_storage_to_capability)?;
    if binding.runtime_kind != ProviderRuntimeKind::WasmComponent {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "provider has no runtime package binding for this API type",
      ));
    }
    if binding.state != ProviderRuntimeState::Active {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "provider runtime binding is not active",
      ));
    }
    let package_digest = binding.package_digest.clone().ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "provider runtime binding has no package digest",
      )
    })?;
    let grant_revision = binding.grant_set_revision.ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "provider runtime binding has no grant revision",
      )
    })?;

    let version = self
      .db
      .read(|conn| installed_plugin_versions::get_optional(conn, &package_digest))
      .map_err(map_storage_to_capability)?
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::PluginUnavailable, "installed package is missing"))?;
    if !version.content_available {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "installed package content is unavailable",
      ));
    }
    if version.runtime_kind != runtime_kind_storage(RuntimeKind::WasmComponent) {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "package runtime kind is not wasm-component",
      ));
    }
    let publisher = self
      .db
      .read(|conn| plugin_publishers::get(conn, &version.publisher_key_id))
      .map_err(map_storage_to_capability)?;
    if publisher.revoked || !publisher.enabled {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "publisher trust is revoked or disabled",
      ));
    }

    let bundle = self
      .db
      .read(|conn| {
        plugin_permission_grants::get_bundle_for_subject_package_revision(
          conn,
          GrantSubjectKind::ProviderInstance,
          provider_id,
          &package_digest,
          grant_revision,
        )
      })
      .map_err(map_storage_to_capability)?;
    if bundle.header.subject_id != provider_id {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "grant set is bound to a different provider instance",
      ));
    }
    if bundle.header.package_digest != package_digest {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "grant set package digest mismatch",
      ));
    }
    if bundle.header.revision != grant_revision {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "grant set revision mismatch",
      ));
    }
    if !bundle.capabilities.iter().any(|cap| cap.capability_id == capability_id) {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "capability is not granted for this provider instance",
      ));
    }

    // External package verification (store snapshot + signed manifest) happens before the
    // compiled artifact is trusted; then the exact adapter-keyed binding is re-checked so a
    // concurrent lifecycle change can never execute with stale authority.
    let verified = self.verify_and_compile_artifact(&version, &publisher, capability_id, &package_digest)?;
    let rechecked = self
      .db
      .read(|conn| provider_runtime_bindings::get(conn, provider_id, adapter_id))
      .map_err(map_storage_to_capability)?;
    if rechecked.package_digest.as_deref() != Some(package_digest.as_str())
      || rechecked.grant_set_revision != Some(grant_revision)
      || rechecked.state != ProviderRuntimeState::Active
    {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "provider runtime binding changed during verification",
      ));
    }

    let grant = bundle_to_execution_grant_set(&bundle).map_err(|message| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        format!("invalid execution grant set: {message}"),
      )
    })?;
    Ok(ResolvedExecution {
      binding: rechecked,
      grant,
      verified,
      context: ProviderRuntimeBrokerContext {
        provider_id,
        adapter_id: adapter_id.to_string(),
        package_digest: package_digest.clone(),
        grant_revision,
      },
    })
  }

  /// Re-verify the signed package through the real store and compile the capability's artifact.
  fn verify_and_compile_artifact(
    &self,
    version: &InstalledPluginVersion,
    publisher: &crate::domain::plugin_package::PluginPublisher,
    capability_id: &str,
    package_digest: &str,
  ) -> Result<VerifiedComponent, CapabilityError> {
    let verified = self
      .packages
      .verify_runtime_store_snapshot(
        package_digest,
        &publisher.key_id,
        &publisher.fingerprint,
        &publisher.public_key_hex,
        publisher.source,
      )
      .map_err(|err| {
        CapabilityError::new(
          CapabilityErrorCode::PluginUnavailable,
          format!("runtime package snapshot verification failed: {err}"),
        )
      })?;
    let manifest: PluginManifestV1 = serde_json::from_str(&version.manifest_json).map_err(|err| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        format!("invalid installed manifest: {err}"),
      )
    })?;
    if verified.manifest != manifest {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "signed package manifest differs from the installed package record",
      ));
    }
    let artifact_path = manifest
      .capabilities
      .iter()
      .find(|cap| cap.id == capability_id)
      .and_then(|cap| cap.artifact.as_deref())
      .ok_or_else(|| {
        CapabilityError::new(
          CapabilityErrorCode::PluginUnavailable,
          format!("capability {capability_id} is not mapped to an artifact"),
        )
      })?;
    let file_entry = verified
      .manifest
      .files
      .iter()
      .find(|file| file.path == artifact_path && file.role == FileRole::RuntimeArtifact)
      .ok_or_else(|| {
        CapabilityError::new(
          CapabilityErrorCode::PluginUnavailable,
          "runtime artifact is missing from the signed file index",
        )
      })?;
    let artifact_bytes = verified.extracted_files.get(artifact_path).cloned().ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "runtime artifact is missing from the verified archive snapshot",
      )
    })?;
    if artifact_bytes.len() as u64 != file_entry.bytes {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "runtime artifact length differs from the verified file index",
      ));
    }
    let artifact_digest = ComponentArtifactDigest::parse(&file_entry.sha256)
      .map_err(|err| CapabilityError::new(CapabilityErrorCode::PluginUnavailable, err))?;
    let package = PackageDigest::parse(package_digest)
      .map_err(|err| CapabilityError::new(CapabilityErrorCode::PluginUnavailable, err))?;
    self
      .wasm
      .compile_component(&package, &artifact_digest, &artifact_bytes)
      .map_err(map_wasmtime_to_capability)
  }
}

/// Map a storage failure to a stable provider-runtime capability error. The raw message may
/// contain provider-internal text, so it is truncated to a bounded sanitized label.
fn map_storage_to_capability(err: StorageError) -> CapabilityError {
  let message = err.to_string();
  let bounded: String = message.chars().take(160).collect();
  CapabilityError::new(CapabilityErrorCode::PluginUnavailable, bounded)
}

fn map_wasmtime_to_capability(err: wasmtime::Error) -> CapabilityError {
  CapabilityError::new(
    CapabilityErrorCode::PluginUnavailable,
    format!("runtime component compile failed: {err}"),
  )
}
