// ABOUTME: Sanitized service-integration definition/instance Tauri commands.
// ABOUTME: Emits coarse change events after successful mutations only.
use crate::cmds::runtime::run_blocking;
use crate::domain::endpoint_trust::{EndpointTrustPreviewDto, EndpointTrustPreviewInput};
use crate::domain::service_integration::{
  IntegrationDependencyDto, IntegrationInstanceDto, IntegrationInstanceWrite, IntegrationValidationResult,
  PADDLEOCR_PLUGIN_ID, ServiceIntegrationDefinitionDto,
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
    endpoint_trust.preview(input)
  })
  .await
}

#[tauri::command]
pub async fn save_integration_instance(
  app: AppHandle,
  state: State<'_, AppState>,
  input: IntegrationInstanceWrite,
) -> Result<IntegrationInstanceDto, IpcError> {
  let defer_default_pin = should_defer_default_pin(input.id, &input.plugin_id);
  let services = state.service_integrations.clone();
  let result = run_blocking("save_integration_instance", move || {
    if defer_default_pin {
      services.save_without_default_pin(input)
    } else {
      services.save(input)
    }
  })
  .await?;
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);

  if defer_default_pin {
    let instance_id = result.id;
    let lifecycle = state.runtime_lifecycle.clone();
    let app = app.clone();
    let _default_pin_task = tauri::async_runtime::spawn_blocking(move || {
      if let Err(err) = lifecycle.pin_default_package_for_new_instance(instance_id) {
        log::warn!("new_instance_background_default_pin_failed instance={instance_id} error={err}");
      }
      emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
    });
  }

  Ok(result)
}

fn should_defer_default_pin(id: Option<Uuid>, plugin_id: &str) -> bool {
  id.is_none() && plugin_id.trim() == PADDLEOCR_PLUGIN_ID
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
  use super::*;
  use crate::domain::service_integration::{EDGE_TTS_PLUGIN_ID, GOOGLE_TRANSLATE_WEB_PLUGIN_ID};

  #[test]
  fn paddleocr_create_defers_default_pin() {
    assert!(should_defer_default_pin(None, PADDLEOCR_PLUGIN_ID));
    assert!(should_defer_default_pin(None, "  com.langnext.paddleocr  "));
  }

  #[test]
  fn other_creates_and_paddleocr_updates_keep_synchronous_pin_semantics() {
    assert!(!should_defer_default_pin(None, GOOGLE_TRANSLATE_WEB_PLUGIN_ID));
    assert!(!should_defer_default_pin(None, EDGE_TTS_PLUGIN_ID));
    assert!(!should_defer_default_pin(Some(Uuid::nil()), PADDLEOCR_PLUGIN_ID));
  }
}
