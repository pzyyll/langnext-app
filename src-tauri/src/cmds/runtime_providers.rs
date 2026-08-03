// ABOUTME: Provider runtime catalog/lifecycle/execution Tauri commands (Phase 8).
// ABOUTME: Emits provider data-changed events only after successful atomic lifecycle commits.
use crate::cmds::runtime::run_blocking;
use crate::domain::cancel::RequestSessionRegistry;
use crate::domain::runtime_provider::{
  ApplyProviderRuntimeInterfaceAttachInput, ApplyProviderRuntimeInterfaceRollbackInput,
  ApplyProviderRuntimeRollbackInput, ApplyProviderRuntimeUpgradeInput, LlmChatCompleteResult, LlmChatResult,
  LlmModelsListResult, PreviewProviderRuntimeInterfaceAttachInput, PreviewProviderRuntimeInterfaceRollbackInput,
  ProviderRuntimeCatalogEntryDto, ProviderRuntimeChatCommandInput, ProviderRuntimeChatEvent,
  ProviderRuntimeInterfaceDetachInput, ProviderRuntimeInterfaceDiscardSnapshotInput,
  ProviderRuntimeInterfaceLifecycleResultDto, ProviderRuntimeInterfacePreviewDto,
  ProviderRuntimeInterfaceRollbackPreviewDto, ProviderRuntimeLifecycleResultDto, ProviderRuntimeRollbackPreviewDto,
  ProviderRuntimeSnapshotDto, ProviderRuntimeUpgradePreviewDto,
};
use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
use crate::error::IpcError;
use crate::events::{PROVIDERS_CHANGED, emit_data_changed};
use crate::services::provider_runtime_router::ProviderRuntimeRouter;
use crate::state::AppState;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub async fn list_runtime_provider_catalog(
  state: State<'_, AppState>,
) -> Result<Vec<ProviderRuntimeCatalogEntryDto>, IpcError> {
  let services = state.runtime_providers.clone();
  run_blocking("list_runtime_provider_catalog", move || services.list_catalog()).await
}

#[tauri::command]
pub async fn preview_provider_runtime_upgrade(
  state: State<'_, AppState>,
  provider_id: Uuid,
  target_package_digest: String,
) -> Result<ProviderRuntimeUpgradePreviewDto, IpcError> {
  let services = state.runtime_providers.clone();
  run_blocking("preview_provider_runtime_upgrade", move || {
    services.preview_upgrade(provider_id, &target_package_digest)
  })
  .await
}

#[tauri::command]
pub async fn apply_provider_runtime_upgrade(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ApplyProviderRuntimeUpgradeInput,
) -> Result<ProviderRuntimeLifecycleResultDto, IpcError> {
  let services = state.runtime_providers.clone();
  let result = run_blocking("apply_provider_runtime_upgrade", move || services.apply_upgrade(input)).await?;
  emit_data_changed(&app, PROVIDERS_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn preview_provider_runtime_rollback(
  state: State<'_, AppState>,
  provider_id: Uuid,
) -> Result<ProviderRuntimeRollbackPreviewDto, IpcError> {
  let services = state.runtime_providers.clone();
  run_blocking("preview_provider_runtime_rollback", move || {
    services.preview_rollback(provider_id)
  })
  .await
}

#[tauri::command]
pub async fn apply_provider_runtime_rollback(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ApplyProviderRuntimeRollbackInput,
) -> Result<ProviderRuntimeLifecycleResultDto, IpcError> {
  let services = state.runtime_providers.clone();
  let result = run_blocking("apply_provider_runtime_rollback", move || {
    services.apply_rollback(input)
  })
  .await?;
  emit_data_changed(&app, PROVIDERS_CHANGED);
  Ok(result)
}

/// Stable IpcError for a provider-runtime capability failure. The code is the sanitized
/// capability code; the message is already bounded and never contains secrets.
fn capability_to_ipc(error: CapabilityError) -> IpcError {
  IpcError::new(error.code.as_str(), error.message)
}

/// Execute `llm.models.list@1` for one provider API type through the persisted interface
/// binding. The request session is registered for `cancel_provider_runtime` and removed exactly
/// once on every terminal path. A missing/revoked binding is a stable error; the legacy
/// executor is never invoked.
#[tauri::command]
pub async fn provider_runtime_models_list(
  state: State<'_, AppState>,
  provider_id: Uuid,
  adapter_id: String,
  request_id: String,
  config: Vec<u8>,
) -> Result<LlmModelsListResult, IpcError> {
  let router = state.provider_runtime_router.clone();
  let sessions = state.request_sessions.clone();
  run_provider_runtime_models_list(&router, &sessions, provider_id, &adapter_id, &request_id, config)
    .await
    .map_err(capability_to_ipc)
}

/// Public runtime Models List command contract (thin, testable without a Tauri app).
/// The request session is removed exactly once on every terminal path.
pub async fn run_provider_runtime_models_list(
  router: &ProviderRuntimeRouter,
  sessions: &RequestSessionRegistry,
  provider_id: Uuid,
  adapter_id: &str,
  request_id: &str,
  config: Vec<u8>,
) -> Result<LlmModelsListResult, CapabilityError> {
  let request_id = request_id.trim().to_string();
  let adapter_id = adapter_id.trim().to_string();
  if request_id.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "request id is required",
    ));
  }
  if adapter_id.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "adapter id is required",
    ));
  }
  let token = sessions.begin(&request_id);
  let result = router
    .list_models(provider_id, &adapter_id, &request_id, config, token, None)
    .await;
  sessions.end(&request_id);
  result
}

/// Execute `llm.chat@1` through the persisted runtime binding: unary completion for
/// `stream = false`, typed `ProviderRuntimeChatEvent` deltas over the per-request `Channel`
/// for `stream = true`. The request session is removed exactly once on every terminal path
/// and a missing/revoked binding is a stable error; the legacy executor is never invoked.
#[tauri::command]
pub async fn provider_runtime_chat(
  state: State<'_, AppState>,
  input: ProviderRuntimeChatCommandInput,
  on_event: Channel<ProviderRuntimeChatEvent>,
) -> Result<Option<LlmChatCompleteResult>, IpcError> {
  let router = state.provider_runtime_router.clone();
  let sessions = state.request_sessions.clone();
  run_provider_runtime_chat(
    &router,
    &sessions,
    input,
    Box::new(move |event| {
      on_event
        .send(event)
        .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "stream consumer disconnected"))
    }),
  )
  .await
  .map_err(capability_to_ipc)
}

/// Public runtime Chat command contract (thin, testable without a Tauri app). Returns
/// `Some(complete)` for a unary run and `None` for a streaming run whose typed deltas were
/// already forwarded through `on_event`. The request session is removed exactly once on
/// every terminal path.
pub async fn run_provider_runtime_chat(
  router: &ProviderRuntimeRouter,
  sessions: &RequestSessionRegistry,
  input: ProviderRuntimeChatCommandInput,
  on_event: Box<dyn Fn(ProviderRuntimeChatEvent) -> Result<(), CapabilityError> + Send>,
) -> Result<Option<LlmChatCompleteResult>, CapabilityError> {
  let request_id = input.request_id.trim().to_string();
  if request_id.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      "request id is required",
    ));
  }
  let token = sessions.begin(&request_id);
  let result = if input.request.preferences.stream {
    router
      .chat_stream(
        input.provider_model_id,
        input.config,
        input.request,
        &request_id,
        token.clone(),
        None,
        on_event,
      )
      .await
      .map(|outcome| match outcome {
        LlmChatResult::Streaming => None,
        LlmChatResult::Complete(complete) => Some(complete),
      })
  } else {
    router
      .chat(
        input.provider_model_id,
        input.config,
        input.request,
        &request_id,
        token.clone(),
        None,
      )
      .await
      .map(Some)
  };
  sessions.end(&request_id);
  result
}

/// Cancel an in-flight provider runtime request by session id. Returns false for an
/// unknown/empty id; the legacy provider HTTP session registry is never touched.
#[tauri::command]
pub async fn cancel_provider_runtime(state: State<'_, AppState>, request_id: String) -> Result<bool, IpcError> {
  Ok(cancel_runtime_request(&state.request_sessions, &request_id))
}

/// Public runtime cancellation command contract (thin, testable without a Tauri app).
pub fn cancel_runtime_request(sessions: &RequestSessionRegistry, request_id: &str) -> bool {
  let request_id = request_id.trim().to_string();
  if request_id.is_empty() {
    return false;
  }
  sessions.cancel(&request_id)
}

/// Preview attaching/replacing ONE API type binding with an exact signed package.
#[tauri::command]
pub async fn preview_provider_runtime_interface_attach(
  state: State<'_, AppState>,
  input: PreviewProviderRuntimeInterfaceAttachInput,
) -> Result<ProviderRuntimeInterfacePreviewDto, IpcError> {
  let services = state.runtime_providers.clone();
  run_blocking("preview_provider_runtime_interface_attach", move || {
    services.preview_interface_attach(&input)
  })
  .await
}

/// Apply a previously previewed interface attach/replace atomically (CAS).
#[tauri::command]
pub async fn apply_provider_runtime_interface_attach(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ApplyProviderRuntimeInterfaceAttachInput,
) -> Result<ProviderRuntimeInterfaceLifecycleResultDto, IpcError> {
  let services = state.runtime_providers.clone();
  let result = run_blocking("apply_provider_runtime_interface_attach", move || {
    services.apply_interface_attach(input)
  })
  .await?;
  emit_data_changed(&app, PROVIDERS_CHANGED);
  Ok(result)
}

/// Preview rolling ONE API type binding back to its stored identity.
#[tauri::command]
pub async fn preview_provider_runtime_interface_rollback(
  state: State<'_, AppState>,
  input: PreviewProviderRuntimeInterfaceRollbackInput,
) -> Result<ProviderRuntimeInterfaceRollbackPreviewDto, IpcError> {
  let services = state.runtime_providers.clone();
  run_blocking("preview_provider_runtime_interface_rollback", move || {
    services.preview_interface_rollback(&input)
  })
  .await
}

/// Apply a previously previewed interface rollback atomically (CAS).
#[tauri::command]
pub async fn apply_provider_runtime_interface_rollback(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ApplyProviderRuntimeInterfaceRollbackInput,
) -> Result<ProviderRuntimeInterfaceLifecycleResultDto, IpcError> {
  let services = state.runtime_providers.clone();
  let result = run_blocking("apply_provider_runtime_interface_rollback", move || {
    services.apply_interface_rollback(input)
  })
  .await?;
  emit_data_changed(&app, PROVIDERS_CHANGED);
  Ok(result)
}

/// Detach ONE API type binding directly (provider version CAS).
#[tauri::command]
pub async fn detach_provider_runtime_interface(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ProviderRuntimeInterfaceDetachInput,
) -> Result<ProviderRuntimeInterfaceLifecycleResultDto, IpcError> {
  let services = state.runtime_providers.clone();
  let result = run_blocking("detach_provider_runtime_interface", move || {
    services.detach_interface(&input)
  })
  .await?;
  emit_data_changed(&app, PROVIDERS_CHANGED);
  Ok(result)
}

/// List undiscarded provider runtime rollback snapshots (the cleanup seam for
/// attach/replace/detach snapshots; discarding the final reference releases the grant).
#[tauri::command]
pub async fn list_provider_runtime_snapshots(
  state: State<'_, AppState>,
  provider_id: Uuid,
) -> Result<Vec<ProviderRuntimeSnapshotDto>, IpcError> {
  let services = state.runtime_providers.clone();
  run_blocking("list_provider_runtime_snapshots", move || {
    services.list_interface_snapshots(provider_id)
  })
  .await
}

/// Discard one undiscarded rollback snapshot set (provider version CAS); releasing the final
/// snapshot releases its retained grant.
#[tauri::command]
pub async fn discard_provider_runtime_snapshot(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ProviderRuntimeInterfaceDiscardSnapshotInput,
) -> Result<(), IpcError> {
  let services = state.runtime_providers.clone();
  run_blocking("discard_provider_runtime_snapshot", move || {
    services.discard_interface_snapshot(&input)
  })
  .await?;
  emit_data_changed(&app, PROVIDERS_CHANGED);
  Ok(())
}
