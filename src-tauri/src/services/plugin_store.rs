// ABOUTME: User plugin archive store: preview, atomic install, and atomic remove.
// ABOUTME: User content is Wasm-only with unknown publisher identity; built-in content never lives here.
use crate::domain::plugin_catalog::{
  InstallUserPackageInput, InstallUserPackageResult, PluginCatalogEntryDto, PluginDescriptor, PluginLoadErrorCode,
  PluginSource, UserPackagePreviewDto, UserPluginArchive, compute_permission_request_digest, sha256_hex,
  validate_content_digest,
};
use crate::domain::runtime_plugin::RuntimeKind;
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use crate::repositories::plugin_catalog as catalog_repo;
use crate::services::plugin_loader::{LoadedPlugin, PluginLoader};
use crate::storage::Database;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// Stable warning shown for every user archive: publisher identity is unknown.
pub const USER_PACKAGE_WARNING_NO_PUBLISHER: &str = "user plugin content has no authenticated publisher identity";

struct PreviewRecord {
  preview_id: String,
  content_digest: String,
  plugin_id: String,
  version: String,
  runtime_kind: RuntimeKind,
  capabilities: Vec<String>,
  configuration_schema: Option<String>,
  network: Vec<crate::domain::plugin_catalog::CatalogNetworkPermission>,
  auth_policies: Vec<String>,
  credential_slots: Vec<String>,
  file_count: usize,
  total_bytes: u64,
  permission_differences: Vec<String>,
  warnings: Vec<String>,
  source_path: PathBuf,
  expires_at: String,
  expires_at_unix_secs: u64,
}

/// User archive preview registry and atomic archive operations.
#[derive(Clone)]
pub struct UserPluginStore {
  db: Database,
  app_data_dir: PathBuf,
  loader: PluginLoader,
  previews: std::sync::Arc<Mutex<HashMap<String, PreviewRecord>>>,
  generation: std::sync::Arc<AtomicU64>,
  mutation_lock: std::sync::Arc<Mutex<()>>,
}

impl std::fmt::Debug for UserPluginStore {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("UserPluginStore")
      .field("app_data_dir", &self.app_data_dir)
      .finish_non_exhaustive()
  }
}

impl UserPluginStore {
  pub fn new(db: Database, app_data_dir: PathBuf, loader: PluginLoader) -> Self {
    Self {
      db,
      app_data_dir,
      loader,
      previews: std::sync::Arc::new(Mutex::new(HashMap::new())),
      generation: std::sync::Arc::new(AtomicU64::new(0)),
      mutation_lock: std::sync::Arc::new(Mutex::new(())),
    }
  }

  pub fn app_data_dir(&self) -> &Path {
    &self.app_data_dir
  }

  /// Directory holding installed user archives.
  pub fn user_plugin_dir(&self) -> PathBuf {
    self
      .app_data_dir
      .join(crate::domain::plugin_catalog::USER_PLUGIN_DIR_NAME)
  }

  /// Installed archive path for a store-relative file name.
  pub fn user_archive_path(&self, file_name: &str) -> PathBuf {
    self.user_plugin_dir().join(file_name)
  }

  /// Monotonic store generation. Runtime lifecycle revalidates a mutation against it.
  pub fn store_generation(&self) -> u64 {
    self.generation.load(Ordering::SeqCst)
  }

  /// Serialize store mutations. The guard is held for the whole lifecycle operation.
  pub fn lock_store(&self) -> Result<std::sync::MutexGuard<'_, ()>, StorageError> {
    self
      .mutation_lock
      .lock()
      .map_err(|_| StorageError::Internal("plugin store lock poisoned".into()))
  }

  pub fn list_installed(&self) -> Result<Vec<UserPluginArchive>, StorageError> {
    self.db.read(catalog_repo::list_user_archives)
  }

  pub fn installed_archive(&self, content_digest: &str) -> Result<Option<UserPluginArchive>, StorageError> {
    self
      .db
      .read(|conn| catalog_repo::get_user_archive(conn, content_digest))
  }

  /// Validate one archive and return a sanitized permission review.
  pub fn preview_archive(&self, source_path: &Path) -> Result<UserPackagePreviewDto, StorageError> {
    let loaded = self
      .loader
      .load_archive(PluginSource::User, source_path)
      .map_err(StorageError::from)?;
    if loaded.descriptor.runtime_kind != RuntimeKind::WasmComponent {
      return Err(StorageError::Validation(
        "user plugins must be Wasm components; native workers are built-in only".into(),
      ));
    }
    let preview_id = crate::domain::time::new_id().to_string();
    let now = now_rfc3339();
    let expires_at_unix_secs = unix_now_secs() + crate::domain::plugin_package::PACKAGE_PREVIEW_TTL_SECS;
    let permission_differences = self.permission_differences(&loaded)?;
    let warnings = vec![USER_PACKAGE_WARNING_NO_PUBLISHER.to_string()];
    let dto = UserPackagePreviewDto {
      preview_id: preview_id.clone(),
      content_digest: loaded.descriptor.content_digest.clone(),
      plugin_id: loaded.descriptor.plugin_id.clone(),
      version: loaded.descriptor.version.clone(),
      runtime_kind: loaded.descriptor.runtime_kind,
      capabilities: loaded.descriptor.capabilities.clone(),
      configuration_schema: loaded.descriptor.configuration_schema.clone(),
      network: loaded.descriptor.network.clone(),
      auth_policies: loaded.descriptor.auth_policies.clone(),
      credential_slots: loaded.descriptor.credential_slots.clone(),
      file_count: loaded.descriptor.file_count,
      total_bytes: loaded.descriptor.total_bytes,
      permission_differences: permission_differences.clone(),
      warnings: warnings.clone(),
      expires_at: now,
    };
    let record = PreviewRecord {
      preview_id: preview_id.clone(),
      content_digest: loaded.descriptor.content_digest.clone(),
      plugin_id: loaded.descriptor.plugin_id.clone(),
      version: loaded.descriptor.version.clone(),
      runtime_kind: loaded.descriptor.runtime_kind,
      capabilities: loaded.descriptor.capabilities.clone(),
      configuration_schema: loaded.descriptor.configuration_schema.clone(),
      network: loaded.descriptor.network.clone(),
      auth_policies: loaded.descriptor.auth_policies.clone(),
      credential_slots: loaded.descriptor.credential_slots.clone(),
      file_count: loaded.descriptor.file_count,
      total_bytes: loaded.descriptor.total_bytes,
      permission_differences,
      warnings,
      source_path: source_path.to_path_buf(),
      expires_at: now_rfc3339(),
      expires_at_unix_secs,
    };
    self
      .previews
      .lock()
      .map_err(|_| StorageError::Internal("plugin preview lock poisoned".into()))?
      .insert(preview_id, record);
    Ok(dto)
  }

  /// Drop a preview without installing.
  pub fn discard_preview(&self, preview_id: &str) -> Result<(), StorageError> {
    let removed = self
      .previews
      .lock()
      .map_err(|_| StorageError::Internal("plugin preview lock poisoned".into()))?
      .remove(preview_id);
    match removed {
      Some(_) => Ok(()),
      None => Err(StorageError::NotFound(format!("plugin preview {preview_id}"))),
    }
  }

  /// Install exactly the previewed content. Fails closed on digest drift or missing acknowledgement.
  pub fn install_previewed(&self, input: InstallUserPackageInput) -> Result<InstallUserPackageResult, StorageError> {
    let _guard = self.lock_store()?;
    let record = {
      let mut previews = self
        .previews
        .lock()
        .map_err(|_| StorageError::Internal("plugin preview lock poisoned".into()))?;
      let record = previews
        .remove(&input.preview_id)
        .ok_or_else(|| StorageError::NotFound(format!("plugin preview {}", input.preview_id)))?;
      if record.expires_at_unix_secs <= unix_now_secs() {
        return Err(StorageError::Validation("plugin preview expired".into()));
      }
      record
    };
    if !input.acknowledge_permissions {
      return Err(StorageError::Validation(
        "user plugin permissions must be acknowledged".into(),
      ));
    }
    validate_content_digest(&input.content_digest).map_err(StorageError::Validation)?;
    if record.content_digest != input.content_digest {
      return Err(StorageError::Validation(
        "preview content digest does not match the confirmation".into(),
      ));
    }
    let loaded = self
      .loader
      .load_archive(PluginSource::User, &record.source_path)
      .map_err(StorageError::from)?;
    if loaded.descriptor.content_digest != record.content_digest {
      return Err(StorageError::Validation("plugin archive changed after preview".into()));
    }
    if loaded.descriptor.runtime_kind != RuntimeKind::WasmComponent {
      return Err(StorageError::Validation(
        "user plugins must be Wasm components; native workers are built-in only".into(),
      ));
    }

    let file_name = archive_file_name(&loaded.descriptor);
    self.db.transaction(|uow| {
      if let Some(existing) = catalog_repo::get_user_archive_by_plugin_version(
        uow.conn(),
        &loaded.descriptor.plugin_id,
        &loaded.descriptor.version,
      )? {
        if existing.content_digest != loaded.descriptor.content_digest {
          return Err(StorageError::Conflict(format!(
            "plugin {} {} is already installed with a different content digest",
            loaded.descriptor.plugin_id, loaded.descriptor.version
          )));
        }
        return Ok(());
      }
      catalog_repo::insert_user_archive(
        uow.conn(),
        &UserPluginArchive {
          content_digest: loaded.descriptor.content_digest.clone(),
          plugin_id: loaded.descriptor.plugin_id.clone(),
          version: loaded.descriptor.version.clone(),
          runtime_kind: loaded.descriptor.runtime_kind,
          manifest_json: loaded.manifest_json.clone(),
          permission_request_digest: compute_permission_request_digest(&loaded.manifest),
          file_name: file_name.clone(),
          installed_at: now_rfc3339(),
        },
      )
    })?;
    self.write_archive_atomically(&loaded, &file_name)?;
    self.generation.fetch_add(1, Ordering::SeqCst);

    let descriptor = loaded.descriptor.clone();
    Ok(InstallUserPackageResult {
      entry: PluginCatalogEntryDto {
        is_default: false,
        in_use: false,
        removable: true,
        reloadable: false,
        descriptor,
      },
    })
  }

  /// Remove one installed user archive. Refuses while an instance, provider, or grant pins it.
  pub fn remove_user_archive(&self, content_digest: &str) -> Result<(), StorageError> {
    let _guard = self.lock_store()?;
    let record = self
      .db
      .read(|conn| catalog_repo::get_user_archive(conn, content_digest))?
      .ok_or_else(|| StorageError::NotFound(format!("plugin user archive {content_digest}")))?;
    let instances = self
      .db
      .read(|conn| catalog_repo::count_integration_users_by_digest(conn, content_digest))?;
    if !instances.is_empty() {
      return Err(StorageError::InUse(format!(
        "plugin content {content_digest} is pinned by integration instances"
      )));
    }
    let providers = self
      .db
      .read(|conn| catalog_repo::count_provider_users_by_digest(conn, content_digest))?;
    if !providers.is_empty() {
      return Err(StorageError::InUse(format!(
        "plugin content {content_digest} is pinned by provider bindings"
      )));
    }

    self.db.transaction(|uow| {
      catalog_repo::clear_default_override_for_digest(uow.conn(), content_digest)?;
      catalog_repo::delete_user_archive(uow.conn(), content_digest)
    })?;
    let path = self.user_archive_path(&record.file_name);
    if path.exists() {
      std::fs::remove_file(&path)?;
    }
    self.generation.fetch_add(1, Ordering::SeqCst);
    Ok(())
  }

  /// Permission deltas against the newest installed version of the same plugin, when any.
  fn permission_differences(&self, loaded: &LoadedPlugin) -> Result<Vec<String>, StorageError> {
    let installed = self.db.read(|conn| {
      let archives = catalog_repo::list_user_archives(conn)?;
      Ok(
        archives
          .into_iter()
          .filter(|archive| archive.plugin_id == loaded.descriptor.plugin_id)
          .collect::<Vec<_>>(),
      )
    })?;
    let Some(previous) = installed.iter().max_by(|left, right| left.version.cmp(&right.version)) else {
      return Ok(Vec::new());
    };
    let mut differences = Vec::new();
    let previous_network: Vec<String> = previous_network_endpoint_ids(&previous.manifest_json);
    for endpoint in &loaded.descriptor.network {
      if !previous_network.contains(&endpoint.id) {
        differences.push(format!("network endpoint {}", endpoint.id));
      }
    }
    let previous_auth = previous_auth_policies(&previous.manifest_json);
    for policy in &loaded.descriptor.auth_policies {
      if !previous_auth.contains(policy) {
        differences.push(format!("auth policy {policy}"));
      }
    }
    for capability in &loaded.descriptor.capabilities {
      if !previous_capability_ids(&previous.manifest_json).contains(capability) {
        differences.push(format!("capability {capability}"));
      }
    }
    differences.sort();
    Ok(differences)
  }

  fn write_archive_atomically(&self, loaded: &LoadedPlugin, file_name: &str) -> Result<(), StorageError> {
    let dir = self.user_plugin_dir();
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(file_name);
    let staging = dir.join(format!(".{}.staging", crate::domain::time::new_id()));
    std::fs::write(&staging, archive_bytes(loaded)?)?;
    match std::fs::rename(&staging, &target) {
      Ok(()) => Ok(()),
      Err(error) => {
        let _ = std::fs::remove_file(&staging);
        Err(StorageError::Io(error))
      }
    }
  }
}

fn unix_now_secs() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|duration| duration.as_secs())
    .unwrap_or(0)
}

/// Deterministic store file name: plugin id, version, and digest prefix.
fn archive_file_name(descriptor: &PluginDescriptor) -> String {
  let digest_prefix = &descriptor.content_digest[..12.min(descriptor.content_digest.len())];
  format!(
    "{}-{}-{digest_prefix}.lnplugin",
    sanitize_file_segment(&descriptor.plugin_id),
    sanitize_file_segment(&descriptor.version)
  )
}

fn sanitize_file_segment(value: &str) -> String {
  value
    .chars()
    .map(|character| {
      if character.is_ascii_alphanumeric() || character == '-' || character == '.' || character == '_' {
        character
      } else {
        '_'
      }
    })
    .collect()
}

/// Rebuild the exact archive bytes from the immutable snapshot so the store file matches the digest.
fn archive_bytes(loaded: &LoadedPlugin) -> Result<Vec<u8>, StorageError> {
  crate::services::plugin_loader::pack_directory_to_archive_bytes(&loaded.snapshot_dir).map_err(StorageError::from)
}

fn previous_network_endpoint_ids(manifest_json: &str) -> Vec<String> {
  serde_json::from_str::<crate::domain::runtime_plugin::PluginManifestV1>(manifest_json)
    .map(|manifest| {
      manifest
        .permissions
        .network
        .iter()
        .map(|endpoint| endpoint.id.clone())
        .collect()
    })
    .unwrap_or_default()
}

fn previous_auth_policies(manifest_json: &str) -> Vec<String> {
  serde_json::from_str::<crate::domain::runtime_plugin::PluginManifestV1>(manifest_json)
    .map(|manifest| manifest.permissions.auth_policies.clone())
    .unwrap_or_default()
}

fn previous_capability_ids(manifest_json: &str) -> Vec<String> {
  serde_json::from_str::<crate::domain::runtime_plugin::PluginManifestV1>(manifest_json)
    .map(|manifest| {
      manifest
        .capabilities
        .iter()
        .map(|capability| capability.id.clone())
        .collect()
    })
    .unwrap_or_default()
}

/// Digest of one installed archive file, used by tests and integrity checks.
pub fn archive_file_digest(path: &Path) -> Result<String, StorageError> {
  let bytes =
    crate::domain::plugin_catalog::read_file_bounded(path, crate::domain::plugin_package::PACKAGE_ARCHIVE_MAX_BYTES)
      .map_err(StorageError::Validation)?;
  Ok(sha256_hex(&bytes))
}

/// Error code for a plugin load failure surfaced through the store.
pub fn load_error_code(error: &crate::services::plugin_loader::PluginLoadError) -> PluginLoadErrorCode {
  error.code
}
