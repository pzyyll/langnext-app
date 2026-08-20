// ABOUTME: Tauri IPC commands for default package authorization and activation retry.
// ABOUTME: Preview is non-mutating; authorize writes exact policy after re-verification.
use crate::cmds::runtime::run_blocking;
use crate::domain::default_package_activation::{
  AuthorizeDefaultPluginPackageInput, ConfirmDefaultRuntimeAuthorityInput, DefaultPackageActivationPreviewDto,
  DefaultRuntimeActivationIntent, DefaultRuntimeAuthorityPreviewDto, PreviewDefaultRuntimeAuthorityInput,
  RetryDefaultRuntimeActivationInput,
};
use crate::domain::plugin_package::PluginDefaultVersion;
use crate::domain::runtime_lifecycle::GrantSubjectKind;
use crate::error::IpcError;
use crate::events::{PLUGIN_PACKAGES_CHANGED, PROVIDERS_CHANGED, SERVICE_INTEGRATIONS_CHANGED, emit_data_changed};
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn preview_default_package_activation(
  state: State<'_, AppState>,
  package_digest: String,
) -> Result<DefaultPackageActivationPreviewDto, IpcError> {
  let services = state.default_package_activation.clone();
  run_blocking("preview_default_package_activation", move || {
    services.preview_default_package_activation(&package_digest)
  })
  .await
}

#[tauri::command]
pub async fn authorize_default_plugin_package(
  app: AppHandle,
  state: State<'_, AppState>,
  input: AuthorizeDefaultPluginPackageInput,
) -> Result<PluginDefaultVersion, IpcError> {
  let services = state.default_package_activation.clone();
  let result = run_blocking("authorize_default_plugin_package", move || {
    services.authorize_default_plugin_package(input)
  })
  .await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn preview_default_runtime_authority(
  state: State<'_, AppState>,
  input: PreviewDefaultRuntimeAuthorityInput,
) -> Result<DefaultRuntimeAuthorityPreviewDto, IpcError> {
  let services = state.default_package_activation.clone();
  run_blocking("preview_default_runtime_authority", move || {
    services.preview_default_runtime_authority(input)
  })
  .await
}

#[tauri::command]
pub async fn confirm_default_runtime_authority(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ConfirmDefaultRuntimeAuthorityInput,
) -> Result<(), IpcError> {
  let services = state.default_package_activation.clone();
  let subject_kind = run_blocking("confirm_default_runtime_authority", move || {
    services.confirm_default_runtime_authority(input)
  })
  .await?;
  emit_subject_and_package_events(&app, subject_kind);
  Ok(())
}

#[tauri::command]
pub async fn retry_default_runtime_activation(
  app: AppHandle,
  state: State<'_, AppState>,
  input: RetryDefaultRuntimeActivationInput,
) -> Result<DefaultRuntimeActivationIntent, IpcError> {
  let services = state.default_package_activation.clone();
  let subject_kind = input.subject_kind;
  let subject_id = input.subject_id;
  let result = run_blocking("retry_default_runtime_activation", move || {
    services.retry_default_runtime_activation(input)
  })
  .await?;

  emit_subject_and_package_events(&app, subject_kind);

  let activation = state.default_package_activation.clone();
  schedule_default_runtime_activation(app, activation, subject_kind, subject_id);

  Ok(result)
}

/// Subject-scoped data-change channel for default-runtime activation transitions.
pub(crate) fn subject_data_change_event(subject_kind: GrantSubjectKind) -> &'static str {
  match subject_kind {
    GrantSubjectKind::IntegrationInstance => SERVICE_INTEGRATIONS_CHANGED,
    GrantSubjectKind::ProviderInstance => PROVIDERS_CHANGED,
  }
}

fn emit_subject_and_package_events(app: &AppHandle, subject_kind: GrantSubjectKind) {
  emit_data_changed(app, subject_data_change_event(subject_kind));
  emit_data_changed(app, PLUGIN_PACKAGES_CHANGED);
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::runtime_lifecycle::GrantSubjectKind;

  #[test]
  fn default_package_activation_event_routing_contract() {
    assert_eq!(
      subject_data_change_event(GrantSubjectKind::IntegrationInstance),
      SERVICE_INTEGRATIONS_CHANGED
    );
    assert_eq!(
      subject_data_change_event(GrantSubjectKind::ProviderInstance),
      PROVIDERS_CHANGED
    );
    // Final transitions always also refresh the package catalog channel.
    assert_eq!(PLUGIN_PACKAGES_CHANGED, "data://plugin-packages-changed");
    assert_eq!(SERVICE_INTEGRATIONS_CHANGED, "data://service-integrations-changed");
    assert_eq!(PROVIDERS_CHANGED, "data://providers-changed");
  }

  #[test]
  fn schedule_default_runtime_activation_emits_subject_and_packages() {
    // schedule_default_runtime_activation always pairs subject channel + PLUGIN_PACKAGES_CHANGED.
    let integration_channels = [
      subject_data_change_event(GrantSubjectKind::IntegrationInstance),
      PLUGIN_PACKAGES_CHANGED,
    ];
    let provider_channels = [
      subject_data_change_event(GrantSubjectKind::ProviderInstance),
      PLUGIN_PACKAGES_CHANGED,
    ];
    assert_eq!(integration_channels[0], SERVICE_INTEGRATIONS_CHANGED);
    assert_eq!(provider_channels[0], PROVIDERS_CHANGED);
    assert_eq!(integration_channels[1], provider_channels[1]);
  }
}

/// Schedule package-first activation after a durable create/retry. Always logs failures and emits
/// final subject/package events after the blocking task completes.
pub fn schedule_default_runtime_activation(
  app: AppHandle,
  activation: crate::services::default_package_activation::DefaultPackageActivationService,
  subject_kind: GrantSubjectKind,
  subject_id: uuid::Uuid,
) {
  let _activation_task = tauri::async_runtime::spawn_blocking(move || {
    if let Err(err) = activation.activate_pending_subject(subject_kind, subject_id) {
      log::warn!(
        "package_first_activation_schedule_failed subject={subject_id} kind={} error={err}",
        subject_kind.as_str()
      );
    }
    emit_subject_and_package_events(&app, subject_kind);
  });
}
