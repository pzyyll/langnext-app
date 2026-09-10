// ABOUTME: Tauri IPC commands for the source-based plugin catalog and user archive install.
// ABOUTME: User installs confirm an opaque preview ID plus the exact content digest; no publisher state.
use crate::cmds::runtime::run_blocking;
use crate::domain::plugin_catalog::{
  CatalogDefault, InstallUserPackageInput, InstallUserPackageResult, PluginCatalogSnapshotDto, UserPackagePreviewDto,
};
use crate::error::IpcError;
use crate::events::{PLUGIN_PACKAGES_CHANGED, emit_data_changed};
use crate::state::AppState;
use std::path::PathBuf;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn preview_user_plugin_package(
  state: State<'_, AppState>,
  path: String,
) -> Result<UserPackagePreviewDto, IpcError> {
  let store = state.user_plugins.clone();
  let path = PathBuf::from(path);
  run_blocking("preview_user_plugin_package", move || store.preview_archive(&path)).await
}

#[tauri::command]
pub async fn install_user_plugin_package(
  app: AppHandle,
  state: State<'_, AppState>,
  input: InstallUserPackageInput,
) -> Result<InstallUserPackageResult, IpcError> {
  let store = state.user_plugins.clone();
  let catalog = state.catalog.clone();
  let result = run_blocking("install_user_plugin_package", move || {
    let installed = store.install_previewed(input)?;
    catalog.refresh()?;
    Ok(installed)
  })
  .await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn discard_user_plugin_package_preview(
  state: State<'_, AppState>,
  preview_id: String,
) -> Result<(), IpcError> {
  let store = state.user_plugins.clone();
  run_blocking("discard_user_plugin_package_preview", move || {
    store.discard_preview(&preview_id)
  })
  .await
}

#[tauri::command]
pub async fn list_plugin_catalog(state: State<'_, AppState>) -> Result<PluginCatalogSnapshotDto, IpcError> {
  let catalog = state.catalog.clone();
  run_blocking("list_plugin_catalog", move || catalog.snapshot_dto()).await
}

#[tauri::command]
pub async fn refresh_plugin_catalog(
  app: AppHandle,
  state: State<'_, AppState>,
) -> Result<PluginCatalogSnapshotDto, IpcError> {
  let catalog = state.catalog.clone();
  let snapshot = run_blocking("refresh_plugin_catalog", move || {
    catalog.refresh()?;
    catalog.snapshot_dto()
  })
  .await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(snapshot)
}

#[tauri::command]
pub async fn set_plugin_catalog_default(
  app: AppHandle,
  state: State<'_, AppState>,
  plugin_id: String,
  content_digest: String,
) -> Result<CatalogDefault, IpcError> {
  let catalog = state.catalog.clone();
  let stored = run_blocking("set_plugin_catalog_default", move || {
    catalog.set_user_default(&plugin_id, &content_digest)
  })
  .await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(stored)
}

#[tauri::command]
pub async fn clear_plugin_catalog_default(
  app: AppHandle,
  state: State<'_, AppState>,
  plugin_id: String,
) -> Result<(), IpcError> {
  let catalog = state.catalog.clone();
  run_blocking("clear_plugin_catalog_default", move || {
    catalog.clear_user_default(&plugin_id)
  })
  .await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(())
}

#[tauri::command]
pub async fn remove_user_plugin_package(
  app: AppHandle,
  state: State<'_, AppState>,
  content_digest: String,
) -> Result<(), IpcError> {
  let store = state.user_plugins.clone();
  let catalog = state.catalog.clone();
  run_blocking("remove_user_plugin_package", move || {
    store.remove_user_archive(&content_digest)?;
    catalog.prune_stale_default_overrides()?;
    catalog.refresh()?;
    Ok(())
  })
  .await?;
  emit_data_changed(&app, PLUGIN_PACKAGES_CHANGED);
  Ok(())
}

#[cfg(test)]
mod tests {
  // ABOUTME: Public command-seam tests for user archive inspect/install/remove and defaults.
  // ABOUTME: Exercises the exact service/DTO calls the IPC commands make; no publisher state exists.
  use crate::domain::plugin_catalog::{
    InstallUserPackageInput, PluginLoadErrorCode, PluginSource, UserPackagePreviewDto,
  };
  use crate::domain::runtime_plugin::HttpMethod;
  use crate::services::plugin_catalog::PluginCatalog;
  use crate::services::plugin_store::{USER_PACKAGE_WARNING_NO_PUBLISHER, UserPluginStore};
  use crate::services::test_support::{
    EDGE_TTS_ARCHIVE, SyntheticPlugin, catalog_with_builtins, fixture_digest, install_user_archive, user_store,
  };
  use crate::storage::Database;
  use std::sync::Arc;

  const USER_PLUGIN_ID: &str = "com.example.user-translate";

  struct Fixture {
    _dir: tempfile::TempDir,
    db: Database,
    catalog: Arc<PluginCatalog>,
    store: UserPluginStore,
  }

  fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let catalog = catalog_with_builtins(db.clone(), dir.path(), &[EDGE_TTS_ARCHIVE]);
    let store = user_store(db.clone(), dir.path());
    Fixture {
      _dir: dir,
      db,
      catalog,
      store,
    }
  }

  fn user_plugin(version: &str) -> SyntheticPlugin {
    SyntheticPlugin::new(
      USER_PLUGIN_ID,
      version,
      "artifacts/plugin.wasm",
      b"\0asm\x01\x00\x00\x00",
    )
    .with_config_schema(
      r#"{"version":1,"fields":[{"id":"mode","control":{"kind":"string","spec":{}}}],"groups":[]}"#,
      1,
    )
    .with_capability_and_preferences(
      "translate.text@1",
      r#"{"version":1,"fields":[{"id":"tone","control":{"kind":"string","spec":{}}}],"groups":[]}"#,
    )
    .with_network_endpoint("api", &["https://api.example.com"], &[HttpMethod::Post])
    .with_auth_policy("host.none.v1")
  }

  /// One permission confirmation installs the exact previewed digest once; the DTO exposes
  /// source, digest, runtime, permissions, and the unknown-publisher warning.
  #[test]
  fn user_wasm_install_requires_matching_digest_and_permission_confirmation() {
    let fixture = fixture();
    let archive = user_plugin("1.0.0").archive_in(fixture._dir.path(), "user");
    let preview: UserPackagePreviewDto = fixture.store.preview_archive(&archive).expect("inspect archive");
    assert_eq!(preview.plugin_id, USER_PLUGIN_ID);
    assert_eq!(preview.version, "1.0.0");
    assert_eq!(
      preview.runtime_kind,
      crate::domain::runtime_plugin::RuntimeKind::WasmComponent
    );
    assert_eq!(preview.capabilities, vec!["translate.text@1".to_string()]);
    assert_eq!(preview.network.len(), 1);
    assert_eq!(preview.auth_policies, vec!["host.none.v1".to_string()]);
    assert_eq!(preview.content_digest.len(), 64);
    assert!(preview.file_count >= 3);
    assert!(preview.total_bytes > 0);
    assert_eq!(preview.warnings, vec![USER_PACKAGE_WARNING_NO_PUBLISHER.to_string()]);
    // Inspect is non-mutating.
    assert!(fixture.store.list_installed().unwrap().is_empty());

    // A mismatched confirmation digest fails closed and consumes no install.
    let mismatch = fixture
      .store
      .install_previewed(InstallUserPackageInput {
        preview_id: preview.preview_id.clone(),
        content_digest: "b".repeat(64),
        acknowledge_permissions: true,
      })
      .unwrap_err();
    assert!(
      matches!(mismatch, crate::error::StorageError::Validation(_)),
      "{mismatch:?}"
    );
    assert!(fixture.store.list_installed().unwrap().is_empty());

    // A missing acknowledgement fails closed too.
    let preview = fixture.store.preview_archive(&archive).unwrap();
    let denied = fixture
      .store
      .install_previewed(InstallUserPackageInput {
        preview_id: preview.preview_id.clone(),
        content_digest: preview.content_digest.clone(),
        acknowledge_permissions: false,
      })
      .unwrap_err();
    assert!(
      matches!(denied, crate::error::StorageError::Validation(_)),
      "{denied:?}"
    );

    // The exact digest installs once.
    let preview = fixture.store.preview_archive(&archive).unwrap();
    let installed = fixture
      .store
      .install_previewed(InstallUserPackageInput {
        preview_id: preview.preview_id,
        content_digest: preview.content_digest.clone(),
        acknowledge_permissions: true,
      })
      .expect("install exact digest");
    assert_eq!(installed.entry.descriptor.source, PluginSource::User);
    assert_eq!(installed.entry.descriptor.content_digest, preview.content_digest);
    assert!(installed.entry.removable);
    assert!(!installed.entry.reloadable);

    // The archive file is copied atomically under the user plugin directory and re-loads to
    // the same content identity.
    let records = fixture.store.list_installed().unwrap();
    assert_eq!(records.len(), 1);
    let stored = fixture.store.user_archive_path(&records[0].file_name);
    assert!(stored.is_file());
    let reloaded = fixture
      .catalog
      .loader()
      .load_archive(PluginSource::User, &stored)
      .expect("stored archive reloads");
    assert_eq!(reloaded.descriptor.content_digest, preview.content_digest);
    // No staging leftovers remain.
    let leftovers: Vec<_> = std::fs::read_dir(fixture.store.user_plugin_dir())
      .unwrap()
      .filter_map(|entry| entry.ok())
      .filter(|entry| entry.file_name().to_string_lossy().contains("staging"))
      .collect();
    assert!(leftovers.is_empty(), "staging files must be cleaned up");

    // The catalog publishes the user content after refresh.
    fixture.catalog.refresh().unwrap();
    assert!(fixture.catalog.snapshot_optional(&preview.content_digest).is_some());
  }

  /// The same plugin id and version with different content is a conflict, never a silent
  /// replacement.
  #[test]
  fn same_id_version_different_digest_is_conflict() {
    let fixture = fixture();
    let first = user_plugin("1.0.0").archive_in(fixture._dir.path(), "first");
    let first_digest = install_user_archive(&fixture.store, &first);
    fixture.catalog.refresh().unwrap();

    let changed = user_plugin("1.0.0").add_file(
      "locales/en.json",
      crate::domain::runtime_plugin::FileRole::Locale,
      b"{}",
    );
    let second = changed.archive_in(fixture._dir.path(), "second");
    let preview = fixture.store.preview_archive(&second).expect("inspect changed archive");
    assert_ne!(preview.content_digest, first_digest);
    let conflict = fixture
      .store
      .install_previewed(InstallUserPackageInput {
        preview_id: preview.preview_id,
        content_digest: preview.content_digest,
        acknowledge_permissions: true,
      })
      .unwrap_err();
    assert!(
      matches!(conflict, crate::error::StorageError::Conflict(_)),
      "{conflict:?}"
    );
    let records = fixture.store.list_installed().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].content_digest, first_digest);
  }

  /// Native user archives are rejected before any file is written.
  #[test]
  fn user_native_install_is_rejected() {
    let fixture = fixture();
    let native = SyntheticPlugin::native(USER_PLUGIN_ID, "1.0.0", "runtime/worker.exe", b"MZ-user-native")
      .with_capability("ocr.image@1");
    let archive = native.archive_in(fixture._dir.path(), "native");
    let err = fixture.store.preview_archive(&archive).unwrap_err();
    let message = format!("{err:?}");
    assert!(message.contains("native_source_rejected"), "{message}");
    assert!(fixture.store.list_installed().unwrap().is_empty());
  }

  /// User content may not claim a reserved first-party identity.
  #[test]
  fn user_first_party_id_is_rejected() {
    let fixture = fixture();
    let impostor = SyntheticPlugin::new(
      "com.langnext.google-cloud",
      "1.0.0",
      "artifacts/plugin.wasm",
      b"\0asm\x01\x00\x00\x00",
    )
    .with_capability("translate.text@1");
    let archive = impostor.archive_in(fixture._dir.path(), "impostor");
    fixture
      .store
      .preview_archive(&archive)
      .expect("structurally valid archive");
    let digest = install_user_archive(&fixture.store, &archive);
    fixture.catalog.refresh().unwrap();
    let errors = fixture.catalog.errors();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert_eq!(errors[0].code, PluginLoadErrorCode::FirstPartyIdRejected);
    assert!(fixture.catalog.snapshot_optional(&digest).is_none());
  }

  /// Privileged host auth (host-minted Google/Baidu tokens) is built-in content only.
  #[test]
  fn user_privileged_host_auth_is_rejected() {
    let fixture = fixture();
    let privileged = user_plugin("1.0.0").with_auth_policy("com.langnext.auth.google-service-account");
    let archive = privileged.archive_in(fixture._dir.path(), "privileged");
    let err = fixture.store.preview_archive(&archive).unwrap_err();
    let message = format!("{err:?}");
    assert!(message.contains("privileged_auth_rejected"), "{message}");
    assert!(fixture.store.list_installed().unwrap().is_empty());

    // The same policy is accepted for built-in content.
    let builtin = user_plugin("1.0.0").with_auth_policy("com.langnext.auth.google-service-account");
    let builtin_digest = crate::services::test_support::catalog_with_synthetic(
      fixture.db.clone(),
      fixture._dir.path(),
      &[],
      std::slice::from_ref(&builtin),
    )
    .resolve_default(USER_PLUGIN_ID)
    .expect("built-in content with privileged auth loads")
    .descriptor
    .content_digest;
    assert_eq!(builtin_digest.len(), 64);
  }

  /// Removing user content is refused while an instance pins it, and succeeds afterwards.
  #[test]
  fn remove_user_archive_is_refused_while_pinned() {
    let fixture = fixture();
    let archive = user_plugin("1.0.0").archive_in(fixture._dir.path(), "user");
    let digest = install_user_archive(&fixture.store, &archive);
    fixture.catalog.refresh().unwrap();

    let now = crate::domain::time::now_rfc3339();
    let instance_id = crate::domain::time::new_id();
    fixture
      .db
      .transaction(|uow| {
        crate::repositories::integration_instances::insert(
          uow.conn(),
          &crate::domain::service_integration::IntegrationInstance {
            id: instance_id,
            plugin_id: USER_PLUGIN_ID.into(),
            plugin_version: "1.0.0".into(),
            display_name: "User".into(),
            enabled: true,
            config_json: "{}".into(),
            config_schema_version: 1,
            health_status: crate::domain::service_integration::IntegrationHealthStatus::Unvalidated,
            last_validated_at: None,
            last_error_code: None,
            runtime_kind: "wasm-component".into(),
            package_digest: Some(digest.clone()),
            execution_grant_set_revision: None,
            runtime_state: "pending_activation".into(),
            runtime_error_code: None,
            runtime_error_message: None,
            runtime_requirement_json: None,
            created_at: now.clone(),
            updated_at: now,
          },
        )
      })
      .unwrap();

    let in_use = fixture.store.remove_user_archive(&digest).unwrap_err();
    assert!(matches!(in_use, crate::error::StorageError::InUse(_)), "{in_use:?}");
    assert_eq!(fixture.store.list_installed().unwrap().len(), 1);

    fixture
      .db
      .write(|conn| crate::repositories::integration_instances::delete(conn, instance_id))
      .unwrap();
    fixture.store.remove_user_archive(&digest).expect("remove after unpin");
    assert!(fixture.store.list_installed().unwrap().is_empty());
    let removed =
      fixture
        .store
        .user_archive_path(&format!("{}-{}-{}.lnplugin", USER_PLUGIN_ID, "1.0.0", &digest[..12]));
    assert!(!removed.exists(), "archive file must be deleted");
  }

  /// Default overrides are one explicit digest per plugin id and never change existing pins.
  #[test]
  fn catalog_default_override_is_one_explicit_digest() {
    let fixture = fixture();
    let builtin_digest = fixture_digest(&fixture.catalog, "com.langnext.edge-tts");
    assert_eq!(
      fixture
        .catalog
        .resolve_default("com.langnext.edge-tts")
        .unwrap()
        .descriptor
        .content_digest,
      builtin_digest
    );

    let archive = user_plugin("1.0.0").archive_in(fixture._dir.path(), "user");
    let user_digest = install_user_archive(&fixture.store, &archive);
    fixture.catalog.refresh().unwrap();

    let stored = fixture
      .catalog
      .set_user_default(USER_PLUGIN_ID, &user_digest)
      .expect("set user default");
    assert_eq!(stored.content_digest, user_digest);
    assert_eq!(
      fixture.catalog.default_digest(USER_PLUGIN_ID).as_deref(),
      Some(user_digest.as_str())
    );
    // The built-in default for another plugin id is untouched.
    assert_eq!(
      fixture.catalog.default_digest("com.langnext.edge-tts").as_deref(),
      Some(builtin_digest.as_str())
    );

    fixture
      .catalog
      .clear_user_default(USER_PLUGIN_ID)
      .expect("clear override");
    // The explicit override row is gone; the resolved default falls back to the best
    // available candidate for that plugin id.
    let override_row = fixture
      .db
      .read(|conn| crate::repositories::plugin_catalog::get_default_override(conn, USER_PLUGIN_ID))
      .unwrap();
    assert!(override_row.is_none(), "override row must be deleted");
    assert_eq!(
      fixture.catalog.default_digest(USER_PLUGIN_ID).as_deref(),
      Some(user_digest.as_str())
    );

    // Setting a default for an unknown digest fails closed.
    let err = fixture
      .catalog
      .set_user_default(USER_PLUGIN_ID, &"c".repeat(64))
      .unwrap_err();
    assert!(
      matches!(err, crate::error::StorageError::PluginUnavailable(_)),
      "{err:?}"
    );
  }

  /// A preview is consumed by exactly one install attempt; a discarded preview is not found.
  #[test]
  fn preview_is_single_use() {
    let fixture = fixture();
    let archive = user_plugin("1.0.0").archive_in(fixture._dir.path(), "user");
    let preview = fixture.store.preview_archive(&archive).unwrap();
    fixture.store.discard_preview(&preview.preview_id).expect("discard");
    let err = fixture
      .store
      .install_previewed(InstallUserPackageInput {
        preview_id: preview.preview_id,
        content_digest: preview.content_digest,
        acknowledge_permissions: true,
      })
      .unwrap_err();
    assert!(matches!(err, crate::error::StorageError::NotFound(_)), "{err:?}");
  }
}
