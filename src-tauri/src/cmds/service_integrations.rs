// ABOUTME: Sanitized service-integration definition/instance Tauri commands.
// ABOUTME: Emits coarse change events after successful mutations only.
use crate::cmds::runtime::run_blocking;
use crate::domain::endpoint_trust::{EndpointTrustPreviewDto, EndpointTrustPreviewInput};
use crate::domain::service_integration::{
  IntegrationDependencyDto, IntegrationInstanceDto, IntegrationInstanceWrite, IntegrationValidationResult,
  ServiceIntegrationDefinitionDto,
};
use crate::error::IpcError;
use crate::events::{SERVICE_INTEGRATIONS_CHANGED, emit_data_changed};
use crate::state::AppState;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub async fn list_service_integration_definitions(
  state: State<'_, AppState>,
) -> Result<Vec<ServiceIntegrationDefinitionDto>, IpcError> {
  let services = state.service_integrations.clone();
  run_blocking("list_service_integration_definitions", move || {
    Ok(services.list_definitions())
  })
  .await
}

#[tauri::command]
pub async fn list_integration_instances(state: State<'_, AppState>) -> Result<Vec<IntegrationInstanceDto>, IpcError> {
  let services = state.service_integrations.clone();
  run_blocking("list_integration_instances", move || services.list_instances()).await
}

#[tauri::command]
pub async fn get_integration_instance(
  state: State<'_, AppState>,
  id: Uuid,
) -> Result<IntegrationInstanceDto, IpcError> {
  let services = state.service_integrations.clone();
  run_blocking("get_integration_instance", move || services.get_instance(id)).await
}

#[tauri::command]
pub async fn preview_integration_endpoint_trust(
  state: State<'_, AppState>,
  input: EndpointTrustPreviewInput,
) -> Result<EndpointTrustPreviewDto, IpcError> {
  let endpoint_trust = state.endpoint_trust.clone();
  run_blocking("preview_integration_endpoint_trust", move || {
    endpoint_trust.preview(input, None)
  })
  .await
}

#[tauri::command]
pub async fn save_integration_instance(
  app: AppHandle,
  state: State<'_, AppState>,
  input: IntegrationInstanceWrite,
) -> Result<IntegrationInstanceDto, IpcError> {
  let services = state.service_integrations.clone();
  let result = run_blocking("save_integration_instance", move || services.save(input)).await?;
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);

  // Package-first creates return durable pending state first; activation runs after the response.
  if result.runtime_state == "pending_activation" && result.package_digest.is_some() {
    crate::cmds::default_package_activation::schedule_default_runtime_activation(
      app.clone(),
      state.default_package_activation.clone(),
      crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
      result.id,
    );
  }

  Ok(result)
}

#[tauri::command]
pub async fn set_integration_instance_enabled(
  app: AppHandle,
  state: State<'_, AppState>,
  id: Uuid,
  enabled: bool,
) -> Result<IntegrationInstanceDto, IpcError> {
  let services = state.service_integrations.clone();
  let result = run_blocking("set_integration_instance_enabled", move || {
    services.set_enabled(id, enabled)
  })
  .await?;
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn list_integration_instance_dependencies(
  state: State<'_, AppState>,
  id: Uuid,
) -> Result<Vec<IntegrationDependencyDto>, IpcError> {
  let services = state.service_integrations.clone();
  run_blocking("list_integration_instance_dependencies", move || {
    services.list_dependencies(id)
  })
  .await
}

#[tauri::command]
pub async fn delete_integration_instance(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> Result<(), IpcError> {
  let services = state.service_integrations.clone();
  run_blocking("delete_integration_instance", move || services.delete(id)).await?;
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
  Ok(())
}

/// Local config check + remote token grant (auth health only; not Translate IAM).
#[tauri::command]
pub async fn validate_integration_instance(
  app: AppHandle,
  state: State<'_, AppState>,
  id: Uuid,
) -> Result<IntegrationValidationResult, IpcError> {
  let services = state.service_integrations.clone();
  let result = services.validate_instance(id).await.map_err(IpcError::from)?;
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
  Ok(result)
}

#[cfg(test)]
mod tests {
  #[test]
  fn package_first_activation_is_scheduled_after_durable_create() {
    // save_integration_instance schedules default activation then emits subject + package channels.
    assert_eq!(
      crate::cmds::default_package_activation::subject_data_change_event(
        crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
      ),
      crate::events::SERVICE_INTEGRATIONS_CHANGED
    );
    assert_eq!(
      crate::events::SERVICE_INTEGRATIONS_CHANGED,
      "data://service-integrations-changed"
    );
    assert_eq!(crate::events::PLUGIN_PACKAGES_CHANGED, "data://plugin-packages-changed");
  }
}
