// ABOUTME: Tauri IPC commands for signed plugin package preview, install, and management.
// ABOUTME: Approval binds an opaque preview ID only; package code is never executed.
use crate::cmds::runtime::run_blocking;
use crate::domain::plugin_package::{
  ApprovePluginPackageInput, ApprovePluginPackageResult, ApproveUserPublisherInput, InstalledPluginVersionDto,
  PluginDefaultVersion, PluginPackagePreviewDto, PluginPublisherDto, PluginVersionDependenciesDto,
};
use crate::error::IpcError;
use crate::events::{PLUGIN_PACKAGES_CHANGED, emit_data_changed};
use crate::state::AppState;
use std::path::PathBuf;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn preview_plugin_package(
  state: State<'_, AppState>,
  path: String,
) -> Result<PluginPackagePreviewDto, IpcError> {
  let services = state.plugin_packages.clone();
  let path = PathBuf::from(path);
  run_blocking("preview_plugin_package", move || services.preview_package(&path)).await
}

#[tauri::command]
pub async fn approve_plugin_package(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ApprovePluginPackageInput,
) -> Result<ApprovePluginPackageResult, IpcError> {
  let services = state.plugin_packages.clone();
  let result = run_blocking("approve_plugin_package", move || services.approve_package(input)).await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn discard_plugin_package_preview(state: State<'_, AppState>, preview_id: String) -> Result<(), IpcError> {
  let services = state.plugin_packages.clone();
  run_blocking("discard_plugin_package_preview", move || {
    services.discard_preview(&preview_id)
  })
  .await
}

#[tauri::command]
pub async fn list_installed_plugin_versions(
  state: State<'_, AppState>,
) -> Result<Vec<InstalledPluginVersionDto>, IpcError> {
  let services = state.plugin_packages.clone();
  run_blocking("list_installed_plugin_versions", move || services.list_versions()).await
}

#[tauri::command]
pub async fn set_default_plugin_package(
  app: AppHandle,
  state: State<'_, AppState>,
  plugin_id: String,
  package_digest: String,
) -> Result<PluginDefaultVersion, IpcError> {
  let services = state.plugin_packages.clone();
  let result = run_blocking("set_default_plugin_package", move || {
    services.set_default(&plugin_id, &package_digest)
  })
  .await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn list_plugin_publishers(state: State<'_, AppState>) -> Result<Vec<PluginPublisherDto>, IpcError> {
  let services = state.plugin_packages.clone();
  run_blocking("list_plugin_publishers", move || services.list_publishers()).await
}

#[tauri::command]
pub async fn approve_user_plugin_publisher(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ApproveUserPublisherInput,
) -> Result<PluginPublisherDto, IpcError> {
  let services = state.plugin_packages.clone();
  let result = run_blocking("approve_user_plugin_publisher", move || {
    services.approve_user_publisher(input)
  })
  .await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn revoke_plugin_publisher(
  app: AppHandle,
  state: State<'_, AppState>,
  key_id: String,
) -> Result<PluginPublisherDto, IpcError> {
  let services = state.plugin_packages.clone();
  let result = run_blocking("revoke_plugin_publisher", move || services.revoke_publisher(&key_id)).await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn restore_plugin_publisher(
  app: AppHandle,
  state: State<'_, AppState>,
  key_id: String,
) -> Result<PluginPublisherDto, IpcError> {
  let services = state.plugin_packages.clone();
  let result = run_blocking("restore_plugin_publisher", move || {
    services.restore_vendor_publisher(&key_id)
  })
  .await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn remove_plugin_publisher(
  app: AppHandle,
  state: State<'_, AppState>,
  key_id: String,
) -> Result<(), IpcError> {
  let services = state.plugin_packages.clone();
  run_blocking("remove_plugin_publisher", move || services.remove_publisher(&key_id)).await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(())
}

#[tauri::command]
pub async fn uninstall_plugin_version(
  app: AppHandle,
  state: State<'_, AppState>,
  package_digest: String,
) -> Result<(), IpcError> {
  let services = state.plugin_packages.clone();
  run_blocking("uninstall_plugin_version", move || {
    services.uninstall_version(&package_digest)
  })
  .await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(())
}

#[tauri::command]
pub async fn get_plugin_version_dependencies(
  state: State<'_, AppState>,
  package_digest: String,
) -> Result<PluginVersionDependenciesDto, IpcError> {
  let services = state.plugin_packages.clone();
  run_blocking("get_plugin_version_dependencies", move || {
    services.version_dependencies(&package_digest)
  })
  .await
}

#[cfg(test)]
mod plugin_package_commands_tests {
  //! Registration coverage is enforced by `storage/tests.rs` three-way ACL check.
  //! Behavioral coverage lives in `services::plugin_store` and `services::plugin_package`.

  use crate::domain::plugin_package::{
    ApprovePluginPackageInput, ApproveUserPublisherInput, PACKAGE_PREVIEW_TTL_SECS, PluginPackagePreviewDto,
  };
  use crate::services::plugin_package::test_support::{test_fingerprint, test_public_key_hex, valid_signed_package};
  use crate::services::plugin_store::PluginPackageService;
  use crate::storage::Database;

  fn setup_service() -> (tempfile::TempDir, PluginPackageService) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let service = PluginPackageService::new(db, dir.path().to_path_buf());
    service
      .approve_user_publisher(ApproveUserPublisherInput {
        key_id: "com.example.keys.1".into(),
        fingerprint: test_fingerprint(),
        public_key_hex: test_public_key_hex(),
      })
      .unwrap();
    (dir, service)
  }

  #[test]
  fn plugin_package_commands_module_links() {
    assert_eq!(crate::events::PLUGIN_PACKAGES_CHANGED, "data://plugin-packages-changed");
  }

  #[test]
  fn preview_dto_is_opaque_and_ttl_bound() {
    let (dir, service) = setup_service();
    let (pkg, digest) = valid_signed_package();
    let src = dir.path().join("sample.lnplugin");
    std::fs::write(&src, &pkg).unwrap();
    let preview = service.preview_package(&src).unwrap();
    assert_eq!(preview.package_digest, digest);
    // Opaque preview id — not a filesystem path.
    assert!(uuid::Uuid::parse_str(&preview.preview_id).is_ok());
    let encoded = serde_json::to_string(&preview).unwrap();
    assert!(!encoded.contains(dir.path().to_string_lossy().as_ref()));
    assert!(!encoded.contains("package.lnplugin"));
    assert!(preview.publisher_fingerprint.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(PACKAGE_PREVIEW_TTL_SECS >= 60);
    // Approve with unknown id fails closed.
    let err = service
      .approve_package(ApprovePluginPackageInput {
        preview_id: crate::domain::time::new_id().to_string(),
        approve_publisher: false,
        publisher_public_key_hex: None,
        acknowledge_permissions: true,
        set_as_default: false,
      })
      .unwrap_err();
    assert!(matches!(err, crate::error::StorageError::Capability { .. }));
  }

  #[test]
  fn discard_removes_preview_session() {
    let (dir, service) = setup_service();
    let (pkg, _) = valid_signed_package();
    let src = dir.path().join("sample.lnplugin");
    std::fs::write(&src, &pkg).unwrap();
    let preview: PluginPackagePreviewDto = service.preview_package(&src).unwrap();
    service.discard_preview(&preview.preview_id).unwrap();
    let err = service
      .approve_package(ApprovePluginPackageInput {
        preview_id: preview.preview_id,
        approve_publisher: false,
        publisher_public_key_hex: None,
        acknowledge_permissions: true,
        set_as_default: false,
      })
      .unwrap_err();
    assert!(matches!(err, crate::error::StorageError::Capability { .. }));
  }
}
