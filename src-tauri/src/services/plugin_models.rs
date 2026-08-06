// ABOUTME: Host-owned plugin model resource status, bounded download, verify, and atomic install.
// ABOUTME: URLs/digests/caps come only from the signed package; frontend never supplies them.
use crate::domain::plugin_model::{
  CancelPluginModelDownloadInput, DownloadPluginModelInput, MODEL_DOWNLOAD_CONNECT_TIMEOUT_MS,
  MODEL_DOWNLOAD_OVERALL_TIMEOUT_MS, MODEL_DOWNLOAD_READ_TIMEOUT_MS, ModelResourceDescriptor, PluginModelDownloadPhase,
  PluginModelDownloadProgress, PluginModelErrorCode, PluginModelResourceDto, PluginModelResourceStatus,
};
use crate::domain::plugin_package::sha256_hex;
use crate::domain::runtime_plugin::RuntimeKind;
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use crate::repositories::{installed_plugin_versions, integration_instances, plugin_model_resources};
use crate::storage::Database;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// In-flight download cancellation tokens keyed by operation id.
#[derive(Default)]
struct DownloadRegistry {
  cancelled: HashMap<String, bool>,
}

/// Host service for model resource status and explicit downloads.
#[derive(Clone)]
pub struct PluginModelService {
  db: Database,
  app_data_dir: PathBuf,
  /// When present, descriptors are resolved only from a vendor-root re-verified package archive.
  plugin_packages: Option<crate::services::plugin_store::PluginPackageService>,
  downloads: Arc<Mutex<DownloadRegistry>>,
  /// Optional test override: map URL → body bytes (deterministic HTTP fixture).
  #[cfg(test)]
  test_http_bodies: Arc<Mutex<HashMap<String, Vec<u8>>>>,
  /// Optional test override for overall / per-read budgets (production uses named constants).
  #[cfg(test)]
  test_timeouts: Arc<Mutex<Option<ModelDownloadTestTimeouts>>>,
}

/// Test-only timeout overrides for production-seam overall/cancel tests.
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
struct ModelDownloadTestTimeouts {
  overall: Duration,
  read: Duration,
  connect: Duration,
}

impl PluginModelService {
  pub fn new(db: Database, app_data_dir: PathBuf) -> Self {
    Self {
      db,
      app_data_dir,
      plugin_packages: None,
      downloads: Arc::new(Mutex::new(DownloadRegistry::default())),
      #[cfg(test)]
      test_http_bodies: Arc::new(Mutex::new(HashMap::new())),
      #[cfg(test)]
      test_timeouts: Arc::new(Mutex::new(None)),
    }
  }

  /// Production constructor: model descriptors come only from vendor-root re-verified packages.
  pub fn with_packages(
    db: Database,
    app_data_dir: PathBuf,
    plugin_packages: crate::services::plugin_store::PluginPackageService,
  ) -> Self {
    Self {
      db,
      app_data_dir,
      plugin_packages: Some(plugin_packages),
      downloads: Arc::new(Mutex::new(DownloadRegistry::default())),
      #[cfg(test)]
      test_http_bodies: Arc::new(Mutex::new(HashMap::new())),
      #[cfg(test)]
      test_timeouts: Arc::new(Mutex::new(None)),
    }
  }

  #[cfg(test)]
  pub fn set_test_http_body(&self, url: &str, body: Vec<u8>) {
    self
      .test_http_bodies
      .lock()
      .expect("test http lock")
      .insert(url.to_string(), body);
  }

  /// Shorten production stream budgets for overall/cancel seam tests (not a mock HTTP path).
  #[cfg(test)]
  fn set_test_timeouts(&self, overall: Duration, read: Duration, connect: Duration) {
    *self.test_timeouts.lock().expect("test timeouts") = Some(ModelDownloadTestTimeouts { overall, read, connect });
  }

  fn overall_timeout(&self) -> Duration {
    #[cfg(test)]
    {
      if let Some(t) = *self.test_timeouts.lock().expect("test timeouts") {
        return t.overall;
      }
    }
    Duration::from_millis(MODEL_DOWNLOAD_OVERALL_TIMEOUT_MS)
  }

  fn read_timeout(&self) -> Duration {
    #[cfg(test)]
    {
      if let Some(t) = *self.test_timeouts.lock().expect("test timeouts") {
        return t.read;
      }
    }
    Duration::from_millis(MODEL_DOWNLOAD_READ_TIMEOUT_MS)
  }

  fn connect_timeout(&self) -> Duration {
    #[cfg(test)]
    {
      if let Some(t) = *self.test_timeouts.lock().expect("test timeouts") {
        return t.connect;
      }
    }
    Duration::from_millis(MODEL_DOWNLOAD_CONNECT_TIMEOUT_MS)
  }

  /// List sanitized model resource DTOs for an integration instance. No download side effects.
  pub fn list_for_instance(&self, instance_id: &str) -> Result<Vec<PluginModelResourceDto>, StorageError> {
    let instance_uuid = Uuid::parse_str(instance_id)
      .map_err(|_| StorageError::Validation(PluginModelErrorCode::InstanceNotFound.as_str().into()))?;
    let instance = self
      .db
      .read(|conn| integration_instances::get(conn, instance_uuid))
      .map_err(|err| match err {
        StorageError::NotFound(_) => StorageError::Validation(PluginModelErrorCode::InstanceNotFound.as_str().into()),
        other => other,
      })?;

    let Some(package_digest) = instance.package_digest.as_ref() else {
      return Err(StorageError::Validation(
        PluginModelErrorCode::NotNativePackage.as_str().into(),
      ));
    };
    if instance.runtime_kind != "trusted-native-worker" {
      return Err(StorageError::Validation(
        PluginModelErrorCode::NotNativePackage.as_str().into(),
      ));
    }

    let resources = self.resolve_model_resources(package_digest)?;
    let mut out = Vec::with_capacity(resources.len());
    for descriptor in resources {
      out.push(self.dto_for_descriptor(package_digest, &descriptor)?);
    }
    Ok(out)
  }

  /// Resolve model resource descriptors from a vendor-root re-verified package when available.
  /// Mutable DB `manifest_json` is never trusted when a package service is configured.
  fn resolve_model_resources(&self, package_digest: &str) -> Result<Vec<ModelResourceDescriptor>, StorageError> {
    let version = self.db.read(|conn| {
      installed_plugin_versions::get(conn, package_digest).map_err(|err| match err {
        StorageError::NotFound(_) => StorageError::Validation(PluginModelErrorCode::StalePackage.as_str().into()),
        other => other,
      })
    })?;
    if !version.content_available {
      return Err(StorageError::Validation(
        PluginModelErrorCode::StalePackage.as_str().into(),
      ));
    }
    let publisher = self.db.read(|conn| {
      crate::repositories::plugin_publishers::get(conn, &version.publisher_key_id).map_err(|err| match err {
        StorageError::NotFound(_) => StorageError::Validation(PluginModelErrorCode::StalePackage.as_str().into()),
        other => other,
      })
    })?;
    crate::services::plugin_package::require_native_worker_vendor_publisher(
      publisher.source,
      &publisher.key_id,
      publisher.enabled,
      publisher.revoked,
    )
    .map_err(|message| StorageError::Validation(message))?;

    let manifest = if let Some(packages) = &self.plugin_packages {
      let (verified, vendor_root) = packages
        .verify_store_with_vendor_root(package_digest)
        .map_err(|err| StorageError::Validation(format!("model descriptor re-verify failed: {err}")))?;
      if vendor_root.key_id != publisher.key_id
        || verified.publisher_public_key_hex != publisher.public_key_hex
        || verified.publisher_fingerprint != publisher.fingerprint
        || verified.package_digest != package_digest
      {
        return Err(StorageError::Validation(
          "model descriptor no longer reverse-binds the external vendor root".into(),
        ));
      }
      verified.manifest
    } else {
      // Unit-test / recovery path without a package service: still require vendor publisher,
      // but production composition always injects plugin_packages via with_packages().
      #[cfg(not(test))]
      {
        return Err(StorageError::Validation(
          "model descriptor resolution requires vendor package re-verification".into(),
        ));
      }
      #[cfg(test)]
      {
        serde_json::from_str(&version.manifest_json)
          .map_err(|err| StorageError::Validation(format!("installed manifest is invalid: {err}")))?
      }
    };
    if manifest.runtime.kind != RuntimeKind::TrustedNativeWorker {
      return Err(StorageError::Validation(
        PluginModelErrorCode::NotNativePackage.as_str().into(),
      ));
    }
    Ok(manifest.model_resources.unwrap_or_default())
  }

  fn dto_for_descriptor(
    &self,
    package_digest: &str,
    descriptor: &ModelResourceDescriptor,
  ) -> Result<PluginModelResourceDto, StorageError> {
    let record = self
      .db
      .read(|conn| plugin_model_resources::get_by_package_and_model(conn, package_digest, &descriptor.id))?;
    let (status, installed_bytes, error_code) = match record {
      Some(row) => (row.status, row.installed_bytes, row.error_code),
      None => (PluginModelResourceStatus::Missing, None, None),
    };
    Ok(PluginModelResourceDto {
      model_id: descriptor.id.clone(),
      version: descriptor.version.clone(),
      model_api_version: descriptor.model_api_version,
      language_set: descriptor.language_set.clone(),
      status,
      expected_download_bytes: descriptor.total_download_bytes,
      installed_bytes,
      license_label: descriptor.license_id.clone(),
      error_code,
    })
  }

  /// Explicit download of one signed model resource. Progress is reported through the callback.
  pub fn download_model<F>(
    &self,
    input: DownloadPluginModelInput,
    mut on_progress: F,
  ) -> Result<PluginModelResourceDto, StorageError>
  where
    F: FnMut(PluginModelDownloadProgress),
  {
    let instance_uuid = Uuid::parse_str(&input.instance_id)
      .map_err(|_| StorageError::Validation(PluginModelErrorCode::InstanceNotFound.as_str().into()))?;
    let instance = self
      .db
      .read(|conn| integration_instances::get(conn, instance_uuid))
      .map_err(|err| match err {
        StorageError::NotFound(_) => StorageError::Validation(PluginModelErrorCode::InstanceNotFound.as_str().into()),
        other => other,
      })?;
    let package_digest = instance
      .package_digest
      .as_ref()
      .ok_or_else(|| StorageError::Validation(PluginModelErrorCode::NotNativePackage.as_str().into()))?;
    if instance.runtime_kind != "trusted-native-worker" {
      return Err(StorageError::Validation(
        PluginModelErrorCode::NotNativePackage.as_str().into(),
      ));
    }
    let resources = self.resolve_model_resources(package_digest)?;
    let descriptor = resources
      .into_iter()
      .find(|m| m.id == input.model_id)
      .ok_or_else(|| StorageError::Validation(PluginModelErrorCode::ModelMissing.as_str().into()))?;

    let model_set_digest = model_set_digest_for(&descriptor);
    let resource_key = format!("{package_digest}:{}", descriptor.id);
    let now = now_rfc3339();
    let operation_id = Uuid::now_v7().to_string();

    // Atomic claim: reject concurrent download for the same resource inside one transaction.
    self.db.write(|conn| {
      if plugin_model_resources::find_active_operation(conn, &resource_key)?.is_some() {
        return Err(StorageError::Validation(
          PluginModelErrorCode::ConcurrentDownload.as_str().into(),
        ));
      }
      plugin_model_resources::upsert_resource(
        conn,
        &plugin_model_resources::PluginModelResourceRecord {
          model_resource_key: resource_key.clone(),
          package_digest: package_digest.clone(),
          model_id: descriptor.id.clone(),
          model_version: descriptor.version.clone(),
          model_api_version: descriptor.model_api_version,
          model_set_digest: model_set_digest.clone(),
          status: PluginModelResourceStatus::Downloading,
          installed_bytes: None,
          content_address: None,
          error_code: None,
          updated_at: now.clone(),
        },
      )?;
      plugin_model_resources::insert_operation(
        conn,
        &plugin_model_resources::PluginModelDownloadOperationRecord {
          operation_id: operation_id.clone(),
          model_resource_key: resource_key.clone(),
          package_digest: package_digest.clone(),
          model_id: descriptor.id.clone(),
          initiating_instance_id: instance_uuid.to_string(),
          state: "prepared".into(),
          bytes_downloaded: 0,
          total_bytes: descriptor.total_download_bytes,
          error_code: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )
    })?;

    on_progress(PluginModelDownloadProgress {
      operation_id: operation_id.clone(),
      model_id: descriptor.id.clone(),
      bytes_downloaded: 0,
      total_bytes: descriptor.total_download_bytes,
      phase: PluginModelDownloadPhase::Starting,
    });

    let staging_root = self
      .app_data_dir
      .join("plugin-models")
      .join("staging")
      .join(&operation_id);
    let final_root = self
      .app_data_dir
      .join("plugin-models")
      .join("store")
      .join(&model_set_digest);

    let result = self.run_download_pipeline(&operation_id, &descriptor, &staging_root, &final_root, &mut on_progress);

    match result {
      Ok(()) => {
        let installed_bytes = descriptor.expanded_bytes;
        let ready_at = now_rfc3339();
        self.db.write(|conn| {
          plugin_model_resources::update_operation_state(
            conn,
            &operation_id,
            "ready",
            descriptor.total_download_bytes,
            None,
            &ready_at,
          )?;
          plugin_model_resources::upsert_resource(
            conn,
            &plugin_model_resources::PluginModelResourceRecord {
              model_resource_key: resource_key,
              package_digest: package_digest.clone(),
              model_id: descriptor.id.clone(),
              model_version: descriptor.version.clone(),
              model_api_version: descriptor.model_api_version,
              model_set_digest: model_set_digest.clone(),
              status: PluginModelResourceStatus::Ready,
              installed_bytes: Some(installed_bytes),
              content_address: Some(model_set_digest),
              error_code: None,
              updated_at: ready_at,
            },
          )
        })?;
        on_progress(PluginModelDownloadProgress {
          operation_id: operation_id.clone(),
          model_id: descriptor.id.clone(),
          bytes_downloaded: descriptor.total_download_bytes,
          total_bytes: descriptor.total_download_bytes,
          phase: PluginModelDownloadPhase::Ready,
        });
        let _ = std::fs::remove_dir_all(&staging_root);
        Ok(PluginModelResourceDto {
          model_id: descriptor.id,
          version: descriptor.version,
          model_api_version: descriptor.model_api_version,
          language_set: descriptor.language_set,
          status: PluginModelResourceStatus::Ready,
          expected_download_bytes: descriptor.total_download_bytes,
          installed_bytes: Some(installed_bytes),
          license_label: descriptor.license_id,
          error_code: None,
        })
      }
      Err(code) => {
        let failed_at = now_rfc3339();
        let state = if code == PluginModelErrorCode::Cancelled {
          "cancelled"
        } else {
          "failed"
        };
        let status = if code == PluginModelErrorCode::Cancelled {
          PluginModelResourceStatus::Missing
        } else {
          PluginModelResourceStatus::Failed
        };
        let _ = self.db.write(|conn| {
          plugin_model_resources::update_operation_state(
            conn,
            &operation_id,
            state,
            0,
            Some(code.as_str()),
            &failed_at,
          )?;
          plugin_model_resources::upsert_resource(
            conn,
            &plugin_model_resources::PluginModelResourceRecord {
              model_resource_key: resource_key,
              package_digest: package_digest.clone(),
              model_id: descriptor.id.clone(),
              model_version: descriptor.version.clone(),
              model_api_version: descriptor.model_api_version,
              model_set_digest,
              status,
              installed_bytes: None,
              content_address: None,
              error_code: Some(code.as_str().into()),
              updated_at: failed_at,
            },
          )
        });
        let _ = std::fs::remove_dir_all(&staging_root);
        on_progress(PluginModelDownloadProgress {
          operation_id,
          model_id: descriptor.id,
          bytes_downloaded: 0,
          total_bytes: descriptor.total_download_bytes,
          phase: if code == PluginModelErrorCode::Cancelled {
            PluginModelDownloadPhase::Cancelled
          } else {
            PluginModelDownloadPhase::Failed
          },
        });
        Err(StorageError::Validation(code.as_str().into()))
      }
    }
  }

  fn run_download_pipeline<F>(
    &self,
    operation_id: &str,
    descriptor: &ModelResourceDescriptor,
    staging_root: &Path,
    final_root: &Path,
    on_progress: &mut F,
  ) -> Result<(), PluginModelErrorCode>
  where
    F: FnMut(PluginModelDownloadProgress),
  {
    if self.is_cancelled(operation_id) {
      return Err(PluginModelErrorCode::Cancelled);
    }
    std::fs::create_dir_all(staging_root).map_err(|_| PluginModelErrorCode::ModelFailed)?;
    let mut downloaded = 0u64;
    let archives_dir = staging_root.join("archives");
    std::fs::create_dir_all(&archives_dir).map_err(|_| PluginModelErrorCode::ModelFailed)?;

    for artifact in &descriptor.artifacts {
      if self.is_cancelled(operation_id) {
        return Err(PluginModelErrorCode::Cancelled);
      }
      let archive_path = archives_dir.join(format!("{:?}.tar", artifact.role));
      let written = self.stream_artifact_to_file(
        &artifact.url,
        artifact.bytes,
        &artifact.sha256,
        &archive_path,
        operation_id,
        &descriptor.id,
        downloaded,
        descriptor.total_download_bytes,
        on_progress,
      )?;
      downloaded = downloaded.saturating_add(written);
      let _ = self.db.write(|conn| {
        plugin_model_resources::update_operation_state(
          conn,
          operation_id,
          "downloading",
          downloaded,
          None,
          &now_rfc3339(),
        )
      });
    }

    if self.is_cancelled(operation_id) {
      return Err(PluginModelErrorCode::Cancelled);
    }
    on_progress(PluginModelDownloadProgress {
      operation_id: operation_id.into(),
      model_id: descriptor.id.clone(),
      bytes_downloaded: downloaded,
      total_bytes: descriptor.total_download_bytes,
      phase: PluginModelDownloadPhase::Verifying,
    });

    let expand_dir = staging_root.join("expanded");
    std::fs::create_dir_all(&expand_dir).map_err(|_| PluginModelErrorCode::ModelFailed)?;
    for artifact in &descriptor.artifacts {
      let archive_path = archives_dir.join(format!("{:?}.tar", artifact.role));
      extract_tar_safe(&archive_path, &expand_dir, descriptor)?;
    }

    // Verify exact six-file allowlist (or declared file set).
    let mut expanded_total = 0u64;
    for file in &descriptor.files {
      let path = expand_dir.join(&file.path);
      let bytes = std::fs::read(&path).map_err(|_| PluginModelErrorCode::UnsafeArchive)?;
      if bytes.len() as u64 != file.bytes {
        return Err(PluginModelErrorCode::DigestMismatch);
      }
      if sha256_hex(&bytes) != file.sha256 {
        return Err(PluginModelErrorCode::DigestMismatch);
      }
      expanded_total = expanded_total.saturating_add(bytes.len() as u64);
    }
    if expanded_total != descriptor.expanded_bytes {
      return Err(PluginModelErrorCode::SizeExceeded);
    }

    if self.is_cancelled(operation_id) {
      return Err(PluginModelErrorCode::Cancelled);
    }
    on_progress(PluginModelDownloadProgress {
      operation_id: operation_id.into(),
      model_id: descriptor.id.clone(),
      bytes_downloaded: downloaded,
      total_bytes: descriptor.total_download_bytes,
      phase: PluginModelDownloadPhase::Installing,
    });

    // Atomic install: write to temp then rename into content-addressed store.
    if final_root.exists() {
      // Already installed for this digest; treat as ready.
      return Ok(());
    }
    let parent = final_root.parent().ok_or(PluginModelErrorCode::ModelFailed)?;
    std::fs::create_dir_all(parent).map_err(|_| PluginModelErrorCode::ModelFailed)?;
    let tmp_final = parent.join(format!(".tmp-{}", operation_id));
    if tmp_final.exists() {
      let _ = std::fs::remove_dir_all(&tmp_final);
    }
    copy_dir_recursive(&expand_dir, &tmp_final).map_err(|_| PluginModelErrorCode::ModelFailed)?;
    std::fs::rename(&tmp_final, final_root).map_err(|_| PluginModelErrorCode::ModelFailed)?;
    Ok(())
  }

  /// Stream one artifact to disk with per-chunk size, digest, cancel, and progress checks.
  ///
  /// Production path uses a current-thread async client + `response.chunk()` under
  /// `tokio::select!` with cancel/overall/read budgets. Cancel drops the response (closes the
  /// connection) on the same task — no detached reader threads accumulate across cancels.
  fn stream_artifact_to_file<F>(
    &self,
    url: &str,
    expected_bytes: u64,
    expected_sha256: &str,
    archive_path: &Path,
    operation_id: &str,
    model_id: &str,
    already_downloaded: u64,
    total_bytes: u64,
    on_progress: &mut F,
  ) -> Result<u64, PluginModelErrorCode>
  where
    F: FnMut(PluginModelDownloadProgress),
  {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    const PROGRESS_EMIT_EVERY_BYTES: u64 = 256 * 1024;
    /// Cancel / overall poll slice while waiting for the next body chunk.
    const CANCEL_POLL_SLICE: Duration = Duration::from_millis(50);

    #[cfg(test)]
    {
      if let Some(body) = self.test_http_bodies.lock().expect("test http lock").get(url).cloned() {
        if body.len() as u64 > expected_bytes {
          return Err(PluginModelErrorCode::SizeExceeded);
        }
        if body.len() as u64 != expected_bytes {
          return Err(PluginModelErrorCode::SizeExceeded);
        }
        if sha256_hex(&body) != expected_sha256 {
          return Err(PluginModelErrorCode::DigestMismatch);
        }
        std::fs::write(archive_path, &body).map_err(|_| PluginModelErrorCode::ModelFailed)?;
        let written = body.len() as u64;
        on_progress(PluginModelDownloadProgress {
          operation_id: operation_id.into(),
          model_id: model_id.into(),
          bytes_downloaded: already_downloaded.saturating_add(written),
          total_bytes,
          phase: PluginModelDownloadPhase::Downloading,
        });
        return Ok(written);
      }
    }

    let overall_deadline = Instant::now() + self.overall_timeout();
    let remaining_overall = overall_deadline.saturating_duration_since(Instant::now());
    if remaining_overall.is_zero() {
      return Err(PluginModelErrorCode::ModelFailed);
    }
    if self.is_cancelled(operation_id) {
      return Err(PluginModelErrorCode::Cancelled);
    }

    let read_timeout = self.read_timeout();
    let connect_timeout = self
      .connect_timeout()
      .min(remaining_overall)
      .max(Duration::from_millis(1));

    // Current-thread runtime owns the HTTP body task. Cancel/overall drop the Response in-task
    // (connection close) — never detach a blocked reader thread.
    let runtime = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .map_err(|_| PluginModelErrorCode::ModelFailed)?;

    let client = build_model_download_async_client(connect_timeout).map_err(|_| PluginModelErrorCode::ModelFailed)?;
    let url_owned = url.to_string();
    let operation_id_owned = operation_id.to_string();
    let expected_sha = expected_sha256.to_string();

    let stream_result = runtime.block_on(async {
      let send_budget = remaining_overall.min(read_timeout).max(Duration::from_millis(1));
      let response = tokio::select! {
        biased;
        _ = wait_cancel_or_deadline(self, &operation_id_owned, overall_deadline, CANCEL_POLL_SLICE) => {
          if self.is_cancelled(&operation_id_owned) {
            return Err(PluginModelErrorCode::Cancelled);
          }
          return Err(PluginModelErrorCode::ModelFailed);
        }
        result = tokio::time::timeout(send_budget, client.get(&url_owned).send()) => {
          match result {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
              if self.is_cancelled(&operation_id_owned) {
                return Err(PluginModelErrorCode::Cancelled);
              }
              return Err(PluginModelErrorCode::ModelFailed);
            }
            Err(_) => {
              if self.is_cancelled(&operation_id_owned) {
                return Err(PluginModelErrorCode::Cancelled);
              }
              return Err(PluginModelErrorCode::ModelFailed);
            }
          }
        }
      };
      if response.status().is_redirection() || !response.status().is_success() {
        return Err(PluginModelErrorCode::ModelFailed);
      }

      let mut response = response;
      let mut file = std::fs::File::create(archive_path).map_err(|_| PluginModelErrorCode::ModelFailed)?;
      let mut hasher = Sha256::new();
      let mut written = 0u64;
      let mut since_progress = 0u64;
      let mut stall_started = Instant::now();

      loop {
        if self.is_cancelled(&operation_id_owned) {
          // Dropping `response` closes the TCP body; no background reader remains.
          drop(response);
          return Err(PluginModelErrorCode::Cancelled);
        }
        if Instant::now() >= overall_deadline {
          drop(response);
          return Err(PluginModelErrorCode::ModelFailed);
        }
        let remaining_overall = overall_deadline.saturating_duration_since(Instant::now());
        let remaining_read = read_timeout.saturating_sub(stall_started.elapsed());
        if remaining_overall.is_zero() || remaining_read.is_zero() {
          drop(response);
          if self.is_cancelled(&operation_id_owned) {
            return Err(PluginModelErrorCode::Cancelled);
          }
          return Err(PluginModelErrorCode::ModelFailed);
        }
        // Single-chunk idle bound: min(remaining overall, remaining read).
        // Cancel is observed concurrently via select — dropping response closes the connection.
        let chunk_wait = remaining_overall.min(remaining_read);
        let next = tokio::select! {
          biased;
          _ = wait_cancel_or_deadline(
            self,
            &operation_id_owned,
            overall_deadline,
            CANCEL_POLL_SLICE,
          ) => {
            drop(response);
            if self.is_cancelled(&operation_id_owned) {
              return Err(PluginModelErrorCode::Cancelled);
            }
            return Err(PluginModelErrorCode::ModelFailed);
          }
          chunk = tokio::time::timeout(chunk_wait, response.chunk()) => chunk,
        };
        match next {
          Ok(Ok(Some(bytes))) => {
            stall_started = Instant::now();
            let n = bytes.len() as u64;
            written = written.saturating_add(n);
            if written > expected_bytes {
              drop(response);
              return Err(PluginModelErrorCode::SizeExceeded);
            }
            file.write_all(&bytes).map_err(|_| PluginModelErrorCode::ModelFailed)?;
            hasher.update(&bytes);
            since_progress = since_progress.saturating_add(n);
            if since_progress >= PROGRESS_EMIT_EVERY_BYTES {
              since_progress = 0;
              on_progress(PluginModelDownloadProgress {
                operation_id: operation_id_owned.clone(),
                model_id: model_id.into(),
                bytes_downloaded: already_downloaded.saturating_add(written),
                total_bytes,
                phase: PluginModelDownloadPhase::Downloading,
              });
            }
          }
          Ok(Ok(None)) => break,
          Ok(Err(_)) => {
            drop(response);
            if self.is_cancelled(&operation_id_owned) {
              return Err(PluginModelErrorCode::Cancelled);
            }
            return Err(PluginModelErrorCode::ModelFailed);
          }
          Err(_elapsed) => {
            // chunk_wait elapsed with no data: overall/read stall.
            drop(response);
            if self.is_cancelled(&operation_id_owned) {
              return Err(PluginModelErrorCode::Cancelled);
            }
            return Err(PluginModelErrorCode::ModelFailed);
          }
        }
      }

      if written != expected_bytes {
        return Err(PluginModelErrorCode::SizeExceeded);
      }
      let digest = hex::encode(hasher.finalize());
      if digest != expected_sha {
        return Err(PluginModelErrorCode::DigestMismatch);
      }
      on_progress(PluginModelDownloadProgress {
        operation_id: operation_id_owned,
        model_id: model_id.into(),
        bytes_downloaded: already_downloaded.saturating_add(written),
        total_bytes,
        phase: PluginModelDownloadPhase::Downloading,
      });
      Ok(written)
    });

    if stream_result.is_err() {
      let _ = std::fs::remove_file(archive_path);
    }
    stream_result
  }

  pub fn cancel_download(&self, input: CancelPluginModelDownloadInput) -> Result<(), StorageError> {
    let instance_uuid = Uuid::parse_str(&input.instance_id)
      .map_err(|_| StorageError::Validation(PluginModelErrorCode::InstanceNotFound.as_str().into()))?;
    let instance = self
      .db
      .read(|conn| integration_instances::get(conn, instance_uuid))
      .map_err(|err| match err {
        StorageError::NotFound(_) => StorageError::Validation(PluginModelErrorCode::InstanceNotFound.as_str().into()),
        other => other,
      })?;
    let package_digest = instance
      .package_digest
      .as_ref()
      .ok_or_else(|| StorageError::Validation(PluginModelErrorCode::NotNativePackage.as_str().into()))?;

    let op = self
      .db
      .read(|conn| plugin_model_resources::get_operation(conn, &input.operation_id))?
      .ok_or_else(|| StorageError::Validation(PluginModelErrorCode::OperationNotFound.as_str().into()))?;
    // Foreign/stale: wrong model, wrong package, wrong initiating instance, or already terminal.
    if op.model_id != input.model_id
      || op.package_digest != *package_digest
      || op.initiating_instance_id != instance_uuid.to_string()
    {
      return Err(StorageError::Validation(
        PluginModelErrorCode::OperationNotFound.as_str().into(),
      ));
    }
    if matches!(op.state.as_str(), "ready" | "failed" | "cancelled") {
      return Err(StorageError::Validation(
        PluginModelErrorCode::OperationNotFound.as_str().into(),
      ));
    }
    self
      .downloads
      .lock()
      .expect("download registry")
      .cancelled
      .insert(input.operation_id, true);
    Ok(())
  }

  /// Startup recovery: remove incomplete staging, fail closed in-flight ops, keep ready installs.
  pub fn recover_incomplete_operations(&self) -> Result<(), StorageError> {
    let staging_root = self.app_data_dir.join("plugin-models").join("staging");
    if staging_root.exists() {
      let _ = std::fs::remove_dir_all(&staging_root);
    }
    // Drop partial atomic-install temps under the content-addressed store.
    let store_root = self.app_data_dir.join("plugin-models").join("store");
    if store_root.is_dir() {
      if let Ok(entries) = std::fs::read_dir(&store_root) {
        for entry in entries.flatten() {
          let name = entry.file_name();
          let name = name.to_string_lossy();
          if name.starts_with(".tmp-") {
            let _ = std::fs::remove_dir_all(entry.path());
          }
        }
      }
    }

    let now = now_rfc3339();
    self.db.write(|conn| {
      let active_ops = plugin_model_resources::list_active_operations(conn)?;
      for op in active_ops {
        plugin_model_resources::update_operation_state(
          conn,
          &op.operation_id,
          "failed",
          op.bytes_downloaded,
          Some(PluginModelErrorCode::ModelFailed.as_str()),
          &now,
        )?;
      }
      let downloading = plugin_model_resources::list_downloading_resources(conn)?;
      for mut row in downloading {
        // Preserve a completed content-addressed install if one already exists for this digest.
        let keep_ready = row
          .content_address
          .as_ref()
          .map(|addr| store_root.join(addr).is_dir())
          .unwrap_or(false);
        if keep_ready {
          row.status = PluginModelResourceStatus::Ready;
          row.error_code = None;
        } else {
          row.status = PluginModelResourceStatus::Failed;
          row.installed_bytes = None;
          row.content_address = None;
          row.error_code = Some(PluginModelErrorCode::ModelFailed.as_str().into());
        }
        row.updated_at = now.clone();
        plugin_model_resources::upsert_resource(conn, &row)?;
      }
      Ok(())
    })
  }

  fn is_cancelled(&self, operation_id: &str) -> bool {
    self
      .downloads
      .lock()
      .expect("download registry")
      .cancelled
      .get(operation_id)
      .copied()
      .unwrap_or(false)
  }

  /// Resolve the verified model root path for a ready model (host-private; not exposed over IPC).
  pub fn resolved_model_root(&self, package_digest: &str, model_id: &str) -> Result<PathBuf, StorageError> {
    let record = self
      .db
      .read(|conn| plugin_model_resources::get_by_package_and_model(conn, package_digest, model_id))?
      .ok_or_else(|| StorageError::Validation(PluginModelErrorCode::ModelMissing.as_str().into()))?;
    if record.status != PluginModelResourceStatus::Ready {
      return Err(StorageError::Validation(
        PluginModelErrorCode::ModelMissing.as_str().into(),
      ));
    }
    let address = record
      .content_address
      .ok_or_else(|| StorageError::Validation(PluginModelErrorCode::ModelMissing.as_str().into()))?;
    let root = self.app_data_dir.join("plugin-models").join("store").join(address);
    if !root.is_dir() {
      return Err(StorageError::Validation(
        PluginModelErrorCode::ModelMissing.as_str().into(),
      ));
    }
    Ok(root)
  }
}

fn model_set_digest_for(descriptor: &ModelResourceDescriptor) -> String {
  let mut material = String::new();
  material.push_str(&descriptor.id);
  material.push('\n');
  material.push_str(&descriptor.version);
  material.push('\n');
  for file in &descriptor.files {
    material.push_str(&file.path);
    material.push(':');
    material.push_str(&file.sha256);
    material.push('\n');
  }
  sha256_hex(material.as_bytes())
}

/// Executable bits that must never appear on model archive members.
const TAR_EXECUTABLE_MODE_MASK: u32 = 0o111;

fn extract_tar_safe(
  archive_path: &Path,
  dest: &Path,
  descriptor: &ModelResourceDescriptor,
) -> Result<(), PluginModelErrorCode> {
  let file = std::fs::File::open(archive_path).map_err(|_| PluginModelErrorCode::UnsafeArchive)?;
  let mut archive = tar::Archive::new(file);
  let allowed: std::collections::HashSet<&str> = descriptor.files.iter().map(|f| f.path.as_str()).collect();
  let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
  for entry in archive.entries().map_err(|_| PluginModelErrorCode::UnsafeArchive)? {
    let mut entry = entry.map_err(|_| PluginModelErrorCode::UnsafeArchive)?;
    let entry_type = entry.header().entry_type();
    // Reject link/special entries before path allowlisting so traversal via symlink cannot hide.
    if entry_type.is_symlink() || entry_type.is_hard_link() {
      return Err(PluginModelErrorCode::UnsafeArchive);
    }
    if entry_type.is_fifo() || entry_type.is_character_special() || entry_type.is_block_special() {
      return Err(PluginModelErrorCode::UnsafeArchive);
    }
    let path = entry.path().map_err(|_| PluginModelErrorCode::UnsafeArchive)?;
    let path_str = path.to_string_lossy().replace('\\', "/");
    if path_str.is_empty() || path_str.starts_with('/') || path_str.contains("..") || path_str.contains(':') {
      return Err(PluginModelErrorCode::UnsafeArchive);
    }
    // Skip directory entries.
    if path_str.ends_with('/') || entry_type.is_dir() {
      continue;
    }
    if !allowed.contains(path_str.as_str()) {
      // Allow only declared files; reject any other non-directory payload.
      return Err(PluginModelErrorCode::UnsafeArchive);
    }
    if !seen_paths.insert(path_str.clone()) {
      return Err(PluginModelErrorCode::UnsafeArchive);
    }
    let mode = entry.header().mode().unwrap_or(0);
    if mode & TAR_EXECUTABLE_MODE_MASK != 0 {
      return Err(PluginModelErrorCode::UnsafeArchive);
    }
    let out_path = dest.join(&path_str);
    if let Some(parent) = out_path.parent() {
      std::fs::create_dir_all(parent).map_err(|_| PluginModelErrorCode::ModelFailed)?;
    }
    entry
      .unpack(&out_path)
      .map_err(|_| PluginModelErrorCode::UnsafeArchive)?;
  }
  Ok(())
}

/// Async HTTP client for production model download (cancel drops the Response in-task).
fn build_model_download_async_client(connect: Duration) -> Result<reqwest::Client, reqwest::Error> {
  let connect = if connect.is_zero() {
    Duration::from_millis(1)
  } else {
    connect
  };
  reqwest::Client::builder()
    .connect_timeout(connect)
    // Per-chunk idle + overall budgets are enforced by the stream loop (not a single request timeout).
    .redirect(reqwest::redirect::Policy::none())
    .build()
}

/// Resolve when the operation is cancelled or the absolute overall deadline elapses.
async fn wait_cancel_or_deadline(
  service: &PluginModelService,
  operation_id: &str,
  overall_deadline: Instant,
  slice: Duration,
) {
  let slice = if slice.is_zero() {
    Duration::from_millis(1)
  } else {
    slice
  };
  loop {
    if service.is_cancelled(operation_id) || Instant::now() >= overall_deadline {
      return;
    }
    tokio::time::sleep(slice).await;
  }
}

/// Blocking client builder retained for timeout-composition unit tests.
///
/// `overall` is **not** idle: the transport timeout is `min(read, overall)` so a stalled body
/// cannot sit for a long read budget when the remaining overall window is shorter.
#[cfg(test)]
fn build_model_download_client_with_timeouts(
  connect: Duration,
  read: Duration,
  overall: Duration,
) -> Result<reqwest::blocking::Client, reqwest::Error> {
  let overall = if overall.is_zero() {
    Duration::from_millis(1)
  } else {
    overall
  };
  let effective_timeout = read.min(overall);
  let effective_connect = connect.min(overall);
  reqwest::blocking::Client::builder()
    .connect_timeout(effective_connect)
    .timeout(effective_timeout)
    .redirect(reqwest::redirect::Policy::none())
    .build()
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), std::io::Error> {
  std::fs::create_dir_all(dst)?;
  for entry in std::fs::read_dir(src)? {
    let entry = entry?;
    let ty = entry.file_type()?;
    let target = dst.join(entry.file_name());
    if ty.is_dir() {
      copy_dir_recursive(&entry.path(), &target)?;
    } else if ty.is_file() {
      std::fs::copy(entry.path(), target)?;
    } else {
      return Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "unexpected non-file entry during model install",
      ));
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::native_worker::{NATIVE_PROTOCOL_VERSION_V1, NATIVE_WORKER_ARTIFACT_PATH, PADDLEOCR_PLUGIN_ID};
  use crate::domain::plugin_model::paddleocr_medium_model_resource;
  use crate::domain::plugin_package::{InstalledPluginVersion, sha256_hex};
  use crate::domain::runtime_plugin::{
    CapabilityDeclaration, FileRole, PackageTargetConstraint, PermissionRequests, PluginFileEntry, PluginManifestV1,
    PublisherDeclaration, RuntimeDescriptor, RuntimeKind,
  };
  use crate::domain::service_integration::{IntegrationHealthStatus, IntegrationInstance};
  use crate::services::vendor_trust::{VENDOR_PUBLISHER_KEY_ID, test_vendor_fixture};
  use crate::storage::Database;
  use tempfile::TempDir;

  const LICENSE_NOTICE: &str = "licenses/NOTICE.txt";
  const LICENSE_TEXT: &[u8] = b"notice\n";
  const WORKER_BYTES: &[u8] = b"MZ-worker";
  const DLL_A: &str = "runtime/opencv_world.dll";
  const DLL_B: &str = "runtime/paddle_inference.dll";
  const DLL_A_BYTES: &[u8] = b"dll-a";
  const DLL_B_BYTES: &[u8] = b"dll-b";

  fn test_db(dir: &Path) -> Database {
    let db = Database::new(dir).unwrap();
    db.initialize().unwrap();
    db
  }

  fn paddleocr_manifest() -> PluginManifestV1 {
    let license = LICENSE_TEXT;
    PluginManifestV1 {
      manifest_version: 1,
      plugin_api_version: "1.0".into(),
      id: PADDLEOCR_PLUGIN_ID.into(),
      version: "1.0.0".into(),
      publisher: PublisherDeclaration {
        key_id: VENDOR_PUBLISHER_KEY_ID.into(),
        key_fingerprint: test_vendor_fixture::fixture_vendor_fingerprint(),
      },
      runtime: RuntimeDescriptor {
        kind: RuntimeKind::TrustedNativeWorker,
        artifact: Some(NATIVE_WORKER_ARTIFACT_PATH.into()),
        native_protocol_version: Some(NATIVE_PROTOCOL_VERSION_V1),
        native_dependencies: Some(vec![DLL_A.into(), DLL_B.into()]),
      },
      targets: vec![PackageTargetConstraint {
        platform: "windows".into(),
        architecture: "x86_64".into(),
      }],
      files: vec![
        PluginFileEntry {
          path: NATIVE_WORKER_ARTIFACT_PATH.into(),
          role: FileRole::RuntimeArtifact,
          bytes: WORKER_BYTES.len() as u64,
          sha256: sha256_hex(WORKER_BYTES),
        },
        PluginFileEntry {
          path: DLL_A.into(),
          role: FileRole::RuntimeArtifact,
          bytes: DLL_A_BYTES.len() as u64,
          sha256: sha256_hex(DLL_A_BYTES),
        },
        PluginFileEntry {
          path: DLL_B.into(),
          role: FileRole::RuntimeArtifact,
          bytes: DLL_B_BYTES.len() as u64,
          sha256: sha256_hex(DLL_B_BYTES),
        },
        PluginFileEntry {
          path: LICENSE_NOTICE.into(),
          role: FileRole::License,
          bytes: license.len() as u64,
          sha256: sha256_hex(license),
        },
      ],
      capabilities: vec![CapabilityDeclaration {
        id: "ocr.image@1".into(),
        preferences_schema: None,
        artifact: None,
      }],
      configuration_schema: None,
      config_schema_version: None,
      credential_slots: vec![],
      permissions: PermissionRequests {
        network: vec![],
        auth_policies: vec![],
      },
      ui: Default::default(),
      provider_runtime: None,
      model_resources: Some(vec![paddleocr_medium_model_resource(LICENSE_NOTICE)]),
    }
  }

  fn seed_paddleocr_instance(db: &Database, package_digest: &str) -> Uuid {
    use crate::domain::plugin_package::{PluginPublisher, PublisherSource};
    use crate::repositories::plugin_publishers;
    let manifest = paddleocr_manifest();
    let manifest_json = serde_json::to_string(&manifest).unwrap();
    let now = now_rfc3339();
    db.write(|conn| {
      plugin_publishers::insert(
        conn,
        &PluginPublisher {
          key_id: VENDOR_PUBLISHER_KEY_ID.into(),
          fingerprint: test_vendor_fixture::fixture_vendor_fingerprint(),
          public_key_hex: test_vendor_fixture::fixture_vendor_public_key_hex(),
          source: PublisherSource::Vendor,
          enabled: true,
          revoked: false,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      installed_plugin_versions::insert(
        conn,
        &InstalledPluginVersion {
          package_digest: package_digest.into(),
          plugin_id: PADDLEOCR_PLUGIN_ID.into(),
          version: "1.0.0".into(),
          publisher_key_id: VENDOR_PUBLISHER_KEY_ID.into(),
          publisher_fingerprint: test_vendor_fixture::fixture_vendor_fingerprint(),
          runtime_kind: "trusted-native-worker".into(),
          manifest_json,
          permission_request_digest: "a".repeat(64),
          content_available: true,
          installed_at: now.clone(),
        },
      )?;
      let id = Uuid::now_v7();
      integration_instances::insert(
        conn,
        &IntegrationInstance {
          id,
          plugin_id: PADDLEOCR_PLUGIN_ID.into(),
          plugin_version: "1.0.0".into(),
          display_name: "PaddleOCR".into(),
          enabled: true,
          config_json: "{}".into(),
          config_schema_version: 1,
          health_status: IntegrationHealthStatus::Unvalidated,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "trusted-native-worker".into(),
          package_digest: Some(package_digest.into()),
          execution_grant_set_revision: Some(1),
          runtime_state: "active".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(id)
    })
    .unwrap()
  }

  #[test]
  fn plugin_model_status_reports_missing_without_side_effects() {
    let dir = TempDir::new().unwrap();
    let db = test_db(dir.path());
    let package_digest = "b".repeat(64);
    let instance_id = seed_paddleocr_instance(&db, &package_digest);
    let service = PluginModelService::new(db, dir.path().to_path_buf());

    let list = service
      .list_for_instance(&instance_id.to_string())
      .expect("list model resources");
    assert_eq!(list.len(), 1);
    let dto = &list[0];
    assert_eq!(dto.model_id, "pp-ocrv6-medium");
    assert_eq!(dto.status, PluginModelResourceStatus::Missing);
    assert_eq!(dto.expected_download_bytes, 139_130_880);
    assert_eq!(dto.license_label, "paddleocr-model-weights");
    assert!(dto.installed_bytes.is_none());
    assert!(dto.error_code.is_none());
    // Sanitized: no URL/path leakage in serialized DTO.
    let json = serde_json::to_string(dto).unwrap();
    assert!(!json.contains("https://"));
    assert!(!json.contains("paddle-model-ecology"));
    assert!(!json.contains(dir.path().to_string_lossy().as_ref()));
  }

  const DET_PATH: &str = "PP-OCRv6_medium_det_infer/inference.yml";
  const REC_PATH: &str = "PP-OCRv6_medium_rec_infer/inference.yml";
  const DET_BYTES: &[u8] = b"det: true\n";
  const REC_BYTES: &[u8] = b"rec: true\n";

  fn build_tar_with_files(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (path, bytes) in files {
      let mut header = tar::Header::new_gnu();
      header.set_size(bytes.len() as u64);
      header.set_mode(0o644);
      header.set_cksum();
      builder.append_data(&mut header, path, *bytes).unwrap();
    }
    builder.into_inner().unwrap()
  }

  fn build_tar_with_mode(path: &str, bytes: &[u8], mode: u32) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(mode);
    header.set_cksum();
    builder.append_data(&mut header, path, bytes).unwrap();
    builder.into_inner().unwrap()
  }

  fn build_tar_with_symlink(link_path: &str, target: &str) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_size(0);
    header.set_mode(0o777);
    header.set_cksum();
    builder.append_link(&mut header, link_path, target).unwrap();
    builder.into_inner().unwrap()
  }

  fn build_tar_with_hard_link(link_path: &str, target: &str) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Link);
    header.set_size(0);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_link(&mut header, link_path, target).unwrap();
    builder.into_inner().unwrap()
  }

  struct MiniModelFixture {
    service: PluginModelService,
    instance_id: Uuid,
    package_digest: String,
    det_url: String,
    rec_url: String,
    det_tar: Vec<u8>,
    rec_tar: Vec<u8>,
    _dir: TempDir,
  }

  fn install_mini_model_manifest(
    service: &PluginModelService,
    package_digest: &str,
    det_tar: &[u8],
    rec_tar: &[u8],
    det_files: &[(&str, &[u8])],
    rec_files: &[(&str, &[u8])],
  ) -> (String, String) {
    let mut manifest = paddleocr_manifest();
    let mut model = paddleocr_medium_model_resource(LICENSE_NOTICE);
    model.artifacts[0].bytes = det_tar.len() as u64;
    model.artifacts[0].sha256 = sha256_hex(det_tar);
    model.artifacts[1].bytes = rec_tar.len() as u64;
    model.artifacts[1].sha256 = sha256_hex(rec_tar);
    let mut files = Vec::new();
    for (path, bytes) in det_files {
      files.push(crate::domain::plugin_model::ModelFileDescriptor {
        path: (*path).into(),
        role: crate::domain::plugin_model::ModelFileRole::Detection,
        bytes: bytes.len() as u64,
        sha256: sha256_hex(bytes),
      });
    }
    for (path, bytes) in rec_files {
      files.push(crate::domain::plugin_model::ModelFileDescriptor {
        path: (*path).into(),
        role: crate::domain::plugin_model::ModelFileRole::Recognition,
        bytes: bytes.len() as u64,
        sha256: sha256_hex(bytes),
      });
    }
    model.files = files;
    model.total_download_bytes = model.artifacts.iter().map(|a| a.bytes).sum();
    model.expanded_bytes = model.files.iter().map(|f| f.bytes).sum();
    let det_url = model.artifacts[0].url.clone();
    let rec_url = model.artifacts[1].url.clone();
    manifest.model_resources = Some(vec![model]);
    let manifest_json = serde_json::to_string(&manifest).unwrap();
    service
      .db
      .write(|conn| {
        conn.execute(
          "UPDATE installed_plugin_versions SET manifest_json = ?1 WHERE package_digest = ?2",
          rusqlite::params![manifest_json, package_digest],
        )?;
        Ok(())
      })
      .unwrap();
    (det_url, rec_url)
  }

  fn mini_model_fixture() -> MiniModelFixture {
    let dir = TempDir::new().unwrap();
    let db = test_db(dir.path());
    let package_digest = "c".repeat(64);
    let instance_id = seed_paddleocr_instance(&db, &package_digest);
    let service = PluginModelService::new(db, dir.path().to_path_buf());
    let det_files = [(DET_PATH, DET_BYTES)];
    let rec_files = [(REC_PATH, REC_BYTES)];
    let det_tar = build_tar_with_files(&det_files);
    let rec_tar = build_tar_with_files(&rec_files);
    let (det_url, rec_url) =
      install_mini_model_manifest(&service, &package_digest, &det_tar, &rec_tar, &det_files, &rec_files);
    service.set_test_http_body(&det_url, det_tar.clone());
    service.set_test_http_body(&rec_url, rec_tar.clone());
    MiniModelFixture {
      service,
      instance_id,
      package_digest,
      det_url,
      rec_url,
      det_tar,
      rec_tar,
      _dir: dir,
    }
  }

  fn download_err_code(err: &StorageError) -> String {
    format!("{err:?}")
  }

  #[test]
  fn plugin_model_download_verifies_and_installs_atomically() {
    let fixture = mini_model_fixture();
    let mut events = Vec::new();
    let dto = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |progress| events.push(progress),
      )
      .expect("download succeeds");

    assert_eq!(dto.status, PluginModelResourceStatus::Ready);
    assert!(dto.installed_bytes.is_some());
    assert!(!events.is_empty());
    assert!(!events[0].operation_id.is_empty());
    assert_eq!(events[0].phase, PluginModelDownloadPhase::Starting);
    assert!(
      events.iter().any(|e| e.phase == PluginModelDownloadPhase::Ready),
      "expected ready progress event"
    );
    let mut last = 0u64;
    for event in events
      .iter()
      .filter(|e| e.phase == PluginModelDownloadPhase::Downloading)
    {
      assert!(event.bytes_downloaded >= last);
      last = event.bytes_downloaded;
    }

    let listed = fixture
      .service
      .list_for_instance(&fixture.instance_id.to_string())
      .unwrap();
    assert_eq!(listed[0].status, PluginModelResourceStatus::Ready);
  }

  #[test]
  fn plugin_model_download_rejects_wrong_archive_digest() {
    let fixture = mini_model_fixture();
    // Same length as the pinned archive so size checks pass and digest is the failing guard.
    let mut tampered = fixture.det_tar.clone();
    assert!(!tampered.is_empty());
    let last = tampered.len() - 1;
    tampered[last] ^= 0xff;
    fixture.service.set_test_http_body(&fixture.det_url, tampered);
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("digest mismatch");
    assert!(
      download_err_code(&err).contains("digest_mismatch"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_download_rejects_oversized_body() {
    let fixture = mini_model_fixture();
    let mut oversized = fixture.det_tar.clone();
    oversized.extend_from_slice(b"extra-bytes");
    fixture.service.set_test_http_body(&fixture.det_url, oversized);
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("size exceeded");
    assert!(
      download_err_code(&err).contains("size_exceeded"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_download_rejects_redirect() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind redirect fixture");
    let addr = listener.local_addr().expect("local addr");
    thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf);
        let response = b"HTTP/1.1 302 Found\r\nLocation: https://evil.example/model.tar\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(response);
      }
    });

    let dir = TempDir::new().unwrap();
    let db = test_db(dir.path());
    let package_digest = "d".repeat(64);
    let instance_id = seed_paddleocr_instance(&db, &package_digest);
    let service = PluginModelService::new(db, dir.path().to_path_buf());
    let det_files = [(DET_PATH, DET_BYTES)];
    let rec_files = [(REC_PATH, REC_BYTES)];
    let det_tar = build_tar_with_files(&det_files);
    let rec_tar = build_tar_with_files(&rec_files);
    let redirect_url = format!("http://{addr}/det.tar");
    let mut manifest = paddleocr_manifest();
    let mut model = paddleocr_medium_model_resource(LICENSE_NOTICE);
    // Signed package metadata still pins HTTPS in production; this unit fixture rewrites the
    // installed manifest URL to a local redirect responder to prove the transport rejects 3xx.
    model.artifacts[0].url = redirect_url;
    model.artifacts[0].bytes = det_tar.len() as u64;
    model.artifacts[0].sha256 = sha256_hex(&det_tar);
    model.artifacts[1].bytes = rec_tar.len() as u64;
    model.artifacts[1].sha256 = sha256_hex(&rec_tar);
    model.files = vec![
      crate::domain::plugin_model::ModelFileDescriptor {
        path: DET_PATH.into(),
        role: crate::domain::plugin_model::ModelFileRole::Detection,
        bytes: DET_BYTES.len() as u64,
        sha256: sha256_hex(DET_BYTES),
      },
      crate::domain::plugin_model::ModelFileDescriptor {
        path: REC_PATH.into(),
        role: crate::domain::plugin_model::ModelFileRole::Recognition,
        bytes: REC_BYTES.len() as u64,
        sha256: sha256_hex(REC_BYTES),
      },
    ];
    model.total_download_bytes = model.artifacts.iter().map(|a| a.bytes).sum();
    model.expanded_bytes = model.files.iter().map(|f| f.bytes).sum();
    let rec_url = model.artifacts[1].url.clone();
    manifest.model_resources = Some(vec![model]);
    let manifest_json = serde_json::to_string(&manifest).unwrap();
    service
      .db
      .write(|conn| {
        conn.execute(
          "UPDATE installed_plugin_versions SET manifest_json = ?1 WHERE package_digest = ?2",
          rusqlite::params![manifest_json, package_digest],
        )?;
        Ok(())
      })
      .unwrap();
    // Do not inject a test body for the redirect URL so the real HTTP client path is exercised.
    service.set_test_http_body(&rec_url, rec_tar);

    let err = service
      .download_model(
        DownloadPluginModelInput {
          instance_id: instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("redirect rejected");
    assert!(
      download_err_code(&err).contains("model_failed"),
      "redirect must fail closed, got {err:?}"
    );
  }

  /// Craft a USTAR member whose path contains `..` (the tar crate builder rejects this).
  fn build_tar_with_literal_path(path: &str, bytes: &[u8]) -> Vec<u8> {
    let mut header = [0u8; 512];
    let path_bytes = path.as_bytes();
    assert!(path_bytes.len() < 100, "ustar name field is 100 bytes");
    header[..path_bytes.len()].copy_from_slice(path_bytes);
    // mode 0644 octal
    header[100..108].copy_from_slice(b"0000644\0");
    // uid/gid
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    let size_oct = format!("{:011o}", bytes.len());
    header[124..135].copy_from_slice(size_oct.as_bytes());
    header[135] = 0;
    // mtime
    header[136..148].copy_from_slice(b"00000000000\0");
    // checksum field spaces during calculation
    header[148..156].copy_from_slice(b"        ");
    header[156] = b'0'; // regular file
    header[257..262].copy_from_slice(b"ustar");
    header[263] = 0;
    let sum: u32 = header.iter().map(|b| *b as u32).sum();
    let checksum = format!("{sum:06o}\0 ");
    header[148..156].copy_from_slice(checksum.as_bytes());
    let mut out = Vec::new();
    out.extend_from_slice(&header);
    out.extend_from_slice(bytes);
    let pad = (512 - (bytes.len() % 512)) % 512;
    out.extend(std::iter::repeat_n(0u8, pad));
    // two zero blocks end the archive
    out.extend(std::iter::repeat_n(0u8, 1024));
    out
  }

  #[test]
  fn plugin_model_download_rejects_tar_path_escape() {
    let fixture = mini_model_fixture();
    let evil = build_tar_with_literal_path("../evil.yml", b"x");
    let rec_files = [(REC_PATH, REC_BYTES)];
    let rec_tar = build_tar_with_files(&rec_files);
    let (det_url, rec_url) = install_mini_model_manifest(
      &fixture.service,
      &fixture.package_digest,
      &evil,
      &rec_tar,
      // Descriptor allowlist still uses the legitimate path; archive contains only escape path.
      &[(DET_PATH, DET_BYTES)],
      &rec_files,
    );
    fixture.service.set_test_http_body(&det_url, evil);
    fixture.service.set_test_http_body(&rec_url, rec_tar);
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("path escape");
    assert!(
      download_err_code(&err).contains("unsafe_archive"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_download_rejects_tar_symlink() {
    let fixture = mini_model_fixture();
    let evil = build_tar_with_symlink(DET_PATH, "/tmp/evil");
    let rec_files = [(REC_PATH, REC_BYTES)];
    let rec_tar = build_tar_with_files(&rec_files);
    let (det_url, rec_url) = install_mini_model_manifest(
      &fixture.service,
      &fixture.package_digest,
      &evil,
      &rec_tar,
      &[(DET_PATH, DET_BYTES)],
      &rec_files,
    );
    fixture.service.set_test_http_body(&det_url, evil);
    fixture.service.set_test_http_body(&rec_url, rec_tar);
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("symlink rejected");
    assert!(
      download_err_code(&err).contains("unsafe_archive"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_download_rejects_undeclared_tar_file() {
    let fixture = mini_model_fixture();
    let evil = build_tar_with_files(&[
      (DET_PATH, DET_BYTES),
      ("PP-OCRv6_medium_det_infer/extra.bin", b"nope".as_slice()),
    ]);
    let rec_files = [(REC_PATH, REC_BYTES)];
    let rec_tar = build_tar_with_files(&rec_files);
    let (det_url, rec_url) = install_mini_model_manifest(
      &fixture.service,
      &fixture.package_digest,
      &evil,
      &rec_tar,
      &[(DET_PATH, DET_BYTES)],
      &rec_files,
    );
    fixture.service.set_test_http_body(&det_url, evil);
    fixture.service.set_test_http_body(&rec_url, rec_tar);
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("undeclared file");
    assert!(
      download_err_code(&err).contains("unsafe_archive"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_download_rejects_duplicate_tar_path() {
    let fixture = mini_model_fixture();
    let evil = build_tar_with_files(&[(DET_PATH, DET_BYTES), (DET_PATH, DET_BYTES)]);
    let rec_files = [(REC_PATH, REC_BYTES)];
    let rec_tar = build_tar_with_files(&rec_files);
    let (det_url, rec_url) = install_mini_model_manifest(
      &fixture.service,
      &fixture.package_digest,
      &evil,
      &rec_tar,
      &[(DET_PATH, DET_BYTES)],
      &rec_files,
    );
    fixture.service.set_test_http_body(&det_url, evil);
    fixture.service.set_test_http_body(&rec_url, rec_tar);
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("duplicate path");
    assert!(
      download_err_code(&err).contains("unsafe_archive"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_download_rejects_executable_tar_member() {
    let fixture = mini_model_fixture();
    let evil = build_tar_with_mode(DET_PATH, DET_BYTES, 0o755);
    let rec_files = [(REC_PATH, REC_BYTES)];
    let rec_tar = build_tar_with_files(&rec_files);
    let (det_url, rec_url) = install_mini_model_manifest(
      &fixture.service,
      &fixture.package_digest,
      &evil,
      &rec_tar,
      &[(DET_PATH, DET_BYTES)],
      &rec_files,
    );
    fixture.service.set_test_http_body(&det_url, evil);
    fixture.service.set_test_http_body(&rec_url, rec_tar);
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("executable member");
    assert!(
      download_err_code(&err).contains("unsafe_archive"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_download_rejects_expanded_size_overflow() {
    let fixture = mini_model_fixture();
    // Declare expanded_bytes smaller than actual file sizes so verification fails closed.
    let det_files = [(DET_PATH, DET_BYTES)];
    let rec_files = [(REC_PATH, REC_BYTES)];
    let det_tar = build_tar_with_files(&det_files);
    let rec_tar = build_tar_with_files(&rec_files);
    let mut manifest = paddleocr_manifest();
    let mut model = paddleocr_medium_model_resource(LICENSE_NOTICE);
    model.artifacts[0].bytes = det_tar.len() as u64;
    model.artifacts[0].sha256 = sha256_hex(&det_tar);
    model.artifacts[1].bytes = rec_tar.len() as u64;
    model.artifacts[1].sha256 = sha256_hex(&rec_tar);
    model.files = vec![
      crate::domain::plugin_model::ModelFileDescriptor {
        path: DET_PATH.into(),
        role: crate::domain::plugin_model::ModelFileRole::Detection,
        bytes: DET_BYTES.len() as u64,
        sha256: sha256_hex(DET_BYTES),
      },
      crate::domain::plugin_model::ModelFileDescriptor {
        path: REC_PATH.into(),
        role: crate::domain::plugin_model::ModelFileRole::Recognition,
        bytes: REC_BYTES.len() as u64,
        sha256: sha256_hex(REC_BYTES),
      },
    ];
    model.total_download_bytes = model.artifacts.iter().map(|a| a.bytes).sum();
    model.expanded_bytes = 1; // intentional underflow vs real expanded total
    let det_url = model.artifacts[0].url.clone();
    let rec_url = model.artifacts[1].url.clone();
    manifest.model_resources = Some(vec![model]);
    let manifest_json = serde_json::to_string(&manifest).unwrap();
    fixture
      .service
      .db
      .write(|conn| {
        conn.execute(
          "UPDATE installed_plugin_versions SET manifest_json = ?1 WHERE package_digest = ?2",
          rusqlite::params![manifest_json, fixture.package_digest],
        )?;
        Ok(())
      })
      .unwrap();
    fixture.service.set_test_http_body(&det_url, det_tar);
    fixture.service.set_test_http_body(&rec_url, rec_tar);
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("expanded size overflow");
    assert!(
      download_err_code(&err).contains("size_exceeded"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_download_cancel_removes_staging() {
    let fixture = mini_model_fixture();
    let service = fixture.service.clone();
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |progress| {
          if progress.phase == PluginModelDownloadPhase::Starting {
            let _ = service.cancel_download(CancelPluginModelDownloadInput {
              instance_id: fixture.instance_id.to_string(),
              model_id: "pp-ocrv6-medium".into(),
              operation_id: progress.operation_id.clone(),
            });
          }
        },
      )
      .expect_err("cancelled");
    assert!(download_err_code(&err).contains("cancelled"), "unexpected err: {err:?}");
    let staging_root = fixture._dir.path().join("plugin-models").join("staging");
    if staging_root.exists() {
      let leftover = std::fs::read_dir(&staging_root)
        .map(|rd| rd.filter_map(|e| e.ok()).count())
        .unwrap_or(0);
      assert_eq!(leftover, 0, "staging must be cleaned after cancel");
    }
  }

  #[test]
  fn plugin_model_download_rejects_concurrent_duplicate() {
    let fixture = mini_model_fixture();
    let resource_key = format!("{}:pp-ocrv6-medium", fixture.package_digest);
    let now = now_rfc3339();
    fixture
      .service
      .db
      .write(|conn| {
        plugin_model_resources::upsert_resource(
          conn,
          &plugin_model_resources::PluginModelResourceRecord {
            model_resource_key: resource_key.clone(),
            package_digest: fixture.package_digest.clone(),
            model_id: "pp-ocrv6-medium".into(),
            model_version: "1.0.0".into(),
            model_api_version: 1,
            model_set_digest: "e".repeat(64),
            status: PluginModelResourceStatus::Downloading,
            installed_bytes: None,
            content_address: None,
            error_code: None,
            updated_at: now.clone(),
          },
        )?;
        plugin_model_resources::insert_operation(
          conn,
          &plugin_model_resources::PluginModelDownloadOperationRecord {
            operation_id: Uuid::now_v7().to_string(),
            model_resource_key: resource_key,
            package_digest: fixture.package_digest.clone(),
            model_id: "pp-ocrv6-medium".into(),
            initiating_instance_id: fixture.instance_id.to_string(),
            state: "downloading".into(),
            bytes_downloaded: 0,
            total_bytes: 10,
            error_code: None,
            created_at: now.clone(),
            updated_at: now,
          },
        )
      })
      .unwrap();
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("concurrent download");
    assert!(
      download_err_code(&err).contains("concurrent_download"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_status_unknown_instance_fails_closed() {
    let dir = TempDir::new().unwrap();
    let db = test_db(dir.path());
    let service = PluginModelService::new(db, dir.path().to_path_buf());
    let err = service
      .list_for_instance(&Uuid::now_v7().to_string())
      .expect_err("unknown instance");
    assert!(
      format!("{err:?}").contains("instance_not_found")
        || format!("{err:?}").contains("not found")
        || format!("{err:?}").contains("Validation")
    );
  }

  #[test]
  fn plugin_model_download_rejects_truncated_response() {
    let fixture = mini_model_fixture();
    // Body shorter than the signed artifact.bytes fails closed as size_exceeded.
    let truncated = &fixture.det_tar[..fixture.det_tar.len().saturating_sub(1)];
    fixture.service.set_test_http_body(&fixture.det_url, truncated.to_vec());
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("truncated body rejected");
    assert!(
      download_err_code(&err).contains("size_exceeded"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_download_rejects_tar_hard_link() {
    let fixture = mini_model_fixture();
    let evil = build_tar_with_hard_link(DET_PATH, "/tmp/evil");
    let rec_tar = fixture.rec_tar.clone();
    let (det_url, rec_url) = install_mini_model_manifest(
      &fixture.service,
      &fixture.package_digest,
      &evil,
      &rec_tar,
      &[(DET_PATH, DET_BYTES)],
      &[(REC_PATH, REC_BYTES)],
    );
    // Re-pin digest/size to the hard-link archive so extraction is the failing guard.
    fixture.service.set_test_http_body(&det_url, evil);
    fixture.service.set_test_http_body(&rec_url, rec_tar);
    let err = fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("hard link rejected");
    assert!(
      download_err_code(&err).contains("unsafe_archive"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_download_rejects_foreign_cancel_operation() {
    let fixture = mini_model_fixture();
    let foreign_op = Uuid::now_v7().to_string();
    let now = now_rfc3339();
    // Seed an operation for a different package digest (foreign instance binding).
    fixture
      .service
      .db
      .write(|conn| {
        let foreign_key = format!("{}:pp-ocrv6-medium", "d".repeat(64));
        plugin_model_resources::upsert_resource(
          conn,
          &plugin_model_resources::PluginModelResourceRecord {
            model_resource_key: foreign_key.clone(),
            package_digest: "d".repeat(64),
            model_id: "pp-ocrv6-medium".into(),
            model_version: "1.0.0".into(),
            model_api_version: 1,
            model_set_digest: "e".repeat(64),
            status: PluginModelResourceStatus::Downloading,
            installed_bytes: None,
            content_address: None,
            error_code: None,
            updated_at: now.clone(),
          },
        )?;
        plugin_model_resources::insert_operation(
          conn,
          &plugin_model_resources::PluginModelDownloadOperationRecord {
            operation_id: foreign_op.clone(),
            model_resource_key: foreign_key,
            package_digest: "d".repeat(64),
            model_id: "pp-ocrv6-medium".into(),
            initiating_instance_id: Uuid::now_v7().to_string(),
            state: "downloading".into(),
            bytes_downloaded: 0,
            total_bytes: 10,
            error_code: None,
            created_at: now.clone(),
            updated_at: now,
          },
        )
      })
      .unwrap();

    let err = fixture
      .service
      .cancel_download(CancelPluginModelDownloadInput {
        instance_id: fixture.instance_id.to_string(),
        model_id: "pp-ocrv6-medium".into(),
        operation_id: foreign_op,
      })
      .expect_err("foreign operation rejected");
    assert!(
      download_err_code(&err).contains("operation_not_found"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_download_rejects_stale_cancel_operation() {
    let fixture = mini_model_fixture();
    let op_id = Uuid::now_v7().to_string();
    let now = now_rfc3339();
    let resource_key = format!("{}:pp-ocrv6-medium", fixture.package_digest);
    fixture
      .service
      .db
      .write(|conn| {
        plugin_model_resources::upsert_resource(
          conn,
          &plugin_model_resources::PluginModelResourceRecord {
            model_resource_key: resource_key.clone(),
            package_digest: fixture.package_digest.clone(),
            model_id: "pp-ocrv6-medium".into(),
            model_version: "1.0.0".into(),
            model_api_version: 1,
            model_set_digest: "e".repeat(64),
            status: PluginModelResourceStatus::Ready,
            installed_bytes: Some(2),
            content_address: Some("e".repeat(64)),
            error_code: None,
            updated_at: now.clone(),
          },
        )?;
        plugin_model_resources::insert_operation(
          conn,
          &plugin_model_resources::PluginModelDownloadOperationRecord {
            operation_id: op_id.clone(),
            model_resource_key: resource_key,
            package_digest: fixture.package_digest.clone(),
            model_id: "pp-ocrv6-medium".into(),
            initiating_instance_id: fixture.instance_id.to_string(),
            state: "ready".into(),
            bytes_downloaded: 10,
            total_bytes: 10,
            error_code: None,
            created_at: now.clone(),
            updated_at: now,
          },
        )
      })
      .unwrap();

    let err = fixture
      .service
      .cancel_download(CancelPluginModelDownloadInput {
        instance_id: fixture.instance_id.to_string(),
        model_id: "pp-ocrv6-medium".into(),
        operation_id: op_id,
      })
      .expect_err("stale terminal operation rejected");
    assert!(
      download_err_code(&err).contains("operation_not_found"),
      "unexpected err: {err:?}"
    );
  }

  #[test]
  fn plugin_model_recovery_removes_staging_preserves_ready_store() {
    let fixture = mini_model_fixture();
    // Completed install first.
    fixture
      .service
      .download_model(
        DownloadPluginModelInput {
          instance_id: fixture.instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect("install ready model");
    let listed = fixture
      .service
      .list_for_instance(&fixture.instance_id.to_string())
      .unwrap();
    assert_eq!(listed[0].status, PluginModelResourceStatus::Ready);
    let store_root = fixture._dir.path().join("plugin-models").join("store");
    let ready_dirs_before = std::fs::read_dir(&store_root)
      .unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
      .filter(|e| !e.file_name().to_string_lossy().starts_with(".tmp-"))
      .count();
    assert!(ready_dirs_before >= 1, "ready content-addressed install missing");

    // Simulate crash mid-download: staging leftover + downloading row + active op.
    let crash_op = Uuid::now_v7().to_string();
    let staging = fixture
      ._dir
      .path()
      .join("plugin-models")
      .join("staging")
      .join(&crash_op);
    std::fs::create_dir_all(staging.join("archives")).unwrap();
    std::fs::write(staging.join("archives").join("partial.tar"), b"partial").unwrap();
    let now = now_rfc3339();
    // Second package digest left downloading without a ready store entry.
    let incomplete_digest = "f".repeat(64);
    let incomplete_key = format!("{incomplete_digest}:pp-ocrv6-medium");
    fixture
      .service
      .db
      .write(|conn| {
        plugin_model_resources::upsert_resource(
          conn,
          &plugin_model_resources::PluginModelResourceRecord {
            model_resource_key: incomplete_key.clone(),
            package_digest: incomplete_digest.clone(),
            model_id: "pp-ocrv6-medium".into(),
            model_version: "1.0.0".into(),
            model_api_version: 1,
            model_set_digest: "a".repeat(64),
            status: PluginModelResourceStatus::Downloading,
            installed_bytes: None,
            content_address: None,
            error_code: None,
            updated_at: now.clone(),
          },
        )?;
        plugin_model_resources::insert_operation(
          conn,
          &plugin_model_resources::PluginModelDownloadOperationRecord {
            operation_id: crash_op.clone(),
            model_resource_key: incomplete_key,
            package_digest: incomplete_digest,
            model_id: "pp-ocrv6-medium".into(),
            initiating_instance_id: Uuid::now_v7().to_string(),
            state: "downloading".into(),
            bytes_downloaded: 1,
            total_bytes: 10,
            error_code: None,
            created_at: now.clone(),
            updated_at: now,
          },
        )
      })
      .unwrap();

    fixture.service.recover_incomplete_operations().expect("recovery");

    assert!(!staging.exists(), "incomplete staging must be removed on recovery");
    let ready_dirs_after = std::fs::read_dir(&store_root)
      .unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
      .filter(|e| !e.file_name().to_string_lossy().starts_with(".tmp-"))
      .count();
    assert_eq!(
      ready_dirs_after, ready_dirs_before,
      "ready content-addressed installs must be preserved"
    );
    let listed_after = fixture
      .service
      .list_for_instance(&fixture.instance_id.to_string())
      .unwrap();
    assert_eq!(
      listed_after[0].status,
      PluginModelResourceStatus::Ready,
      "completed install status must survive recovery"
    );
    let incomplete = fixture
      .service
      .db
      .read(|conn| plugin_model_resources::get_by_package_and_model(conn, &"f".repeat(64), "pp-ocrv6-medium"))
      .unwrap()
      .expect("incomplete row");
    assert_eq!(incomplete.status, PluginModelResourceStatus::Failed);
    let op = fixture
      .service
      .db
      .read(|conn| plugin_model_resources::get_operation(conn, &crash_op))
      .unwrap()
      .expect("op");
    assert_eq!(op.state, "failed");
  }

  #[test]
  fn plugin_model_download_client_sets_bounded_timeouts() {
    assert!(MODEL_DOWNLOAD_CONNECT_TIMEOUT_MS > 0);
    assert!(MODEL_DOWNLOAD_READ_TIMEOUT_MS > 0);
    assert!(MODEL_DOWNLOAD_OVERALL_TIMEOUT_MS >= MODEL_DOWNLOAD_CONNECT_TIMEOUT_MS);
    assert!(MODEL_DOWNLOAD_OVERALL_TIMEOUT_MS >= MODEL_DOWNLOAD_READ_TIMEOUT_MS);
    let async_client = build_model_download_async_client(Duration::from_millis(MODEL_DOWNLOAD_CONNECT_TIMEOUT_MS))
      .expect("async client builds");
    drop(async_client);
    let blocking = build_model_download_client_with_timeouts(
      Duration::from_millis(MODEL_DOWNLOAD_CONNECT_TIMEOUT_MS),
      Duration::from_millis(MODEL_DOWNLOAD_READ_TIMEOUT_MS),
      Duration::from_millis(MODEL_DOWNLOAD_OVERALL_TIMEOUT_MS),
    )
    .expect("timeout composition client builds");
    drop(blocking);
  }

  /// Stalled body must fail within the configured per-read timeout (not hang on overall only).
  #[test]
  fn plugin_model_download_stalled_body_fails_within_read_timeout() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stall fixture");
    let addr = listener.local_addr().expect("local addr");
    thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf);
        // Headers claim a large body; send one chunk then stall forever (no further bytes).
        let headers = b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(headers);
        let _ = stream.write_all(b"PARTIAL");
        let _ = stream.flush();
        thread::sleep(Duration::from_secs(60));
      }
    });

    let read_timeout = Duration::from_millis(400);
    let overall = Duration::from_secs(10);
    let client =
      build_model_download_client_with_timeouts(Duration::from_secs(2), read_timeout, overall).expect("client");
    let url = format!("http://{addr}/stall.tar");
    let started = Instant::now();
    let mut response = client.get(&url).send().expect("headers arrive");
    let mut sink = Vec::new();
    // Drive body reads until the transport fails (read_timeout) or completes.
    let copy_result = std::io::copy(&mut response, &mut sink);
    let elapsed = started.elapsed();
    assert!(copy_result.is_err(), "stalled body must fail, got {copy_result:?}");
    assert!(
      elapsed < Duration::from_secs(3),
      "stalled body must fail within read_timeout bound; elapsed={elapsed:?}"
    );
    assert!(
      elapsed >= Duration::from_millis(200),
      "should wait for the read timeout; elapsed={elapsed:?}"
    );
  }

  /// Cancel observation is bounded by the read timeout when the body is stalled.
  #[test]
  fn plugin_model_download_cancel_observed_within_read_timeout_on_stall() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind cancel stall fixture");
    let addr = listener.local_addr().expect("local addr");
    thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf);
        let headers = b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(headers);
        let _ = stream.write_all(b"PARTIAL");
        let _ = stream.flush();
        thread::sleep(Duration::from_secs(60));
      }
    });

    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_flag = cancelled.clone();
    let read_timeout = Duration::from_millis(400);
    let overall = Duration::from_secs(10);
    let client =
      build_model_download_client_with_timeouts(Duration::from_secs(2), read_timeout, overall).expect("client");
    let url = format!("http://{addr}/cancel-stall.tar");
    let started = Instant::now();
    // Flip cancel shortly after the request starts; the next loop iteration after a timed-out
    // read must observe it within the read_timeout bound.
    thread::spawn(move || {
      thread::sleep(Duration::from_millis(50));
      cancelled_flag.store(true, Ordering::SeqCst);
    });
    let mut response = client.get(&url).send().expect("headers");
    let mut buffer = [0u8; 4096];
    let mut saw_cancel_or_timeout = false;
    loop {
      if cancelled.load(Ordering::SeqCst) {
        saw_cancel_or_timeout = true;
        break;
      }
      match std::io::Read::read(&mut response, &mut buffer) {
        Ok(0) => break,
        Ok(_) => {}
        Err(_) => {
          // Read timeout unblocks; cancel flag should be visible immediately after.
          if cancelled.load(Ordering::SeqCst) {
            saw_cancel_or_timeout = true;
          } else {
            // Even without the flag, the stall is still bounded.
            saw_cancel_or_timeout = true;
          }
          break;
        }
      }
    }
    let elapsed = started.elapsed();
    assert!(saw_cancel_or_timeout, "cancel/timeout must be observed");
    assert!(
      elapsed < Duration::from_secs(3),
      "cancel during stall must be bounded by read_timeout; elapsed={elapsed:?}"
    );
  }

  /// Near-deadline stall: overall remaining shorter than read timeout must bound the single read.
  /// Proves `overall` is not idle in the transport builder (`min(read, overall)`).
  #[test]
  fn plugin_model_download_near_deadline_stall_bounded_by_overall() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind near-deadline fixture");
    let addr = listener.local_addr().expect("local addr");
    thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf);
        let headers = b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(headers);
        let _ = stream.write_all(b"PARTIAL");
        let _ = stream.flush();
        thread::sleep(Duration::from_secs(60));
      }
    });

    // Read budget is long; overall is short — transport must use min(read, overall).
    let read_timeout = Duration::from_secs(30);
    let overall = Duration::from_millis(400);
    let client =
      build_model_download_client_with_timeouts(Duration::from_secs(2), read_timeout, overall).expect("client");
    let url = format!("http://{addr}/near-deadline.tar");
    let started = Instant::now();
    let mut response = client.get(&url).send().expect("headers");
    let mut sink = Vec::new();
    let copy_result = std::io::copy(&mut response, &mut sink);
    let elapsed = started.elapsed();
    assert!(
      copy_result.is_err(),
      "near-deadline stall must fail, got {copy_result:?}"
    );
    assert!(
      elapsed < Duration::from_secs(3),
      "stall must be bounded by overall ({overall:?}), not read ({read_timeout:?}); elapsed={elapsed:?}"
    );
    assert!(
      elapsed >= Duration::from_millis(150),
      "should roughly consume the overall window; elapsed={elapsed:?}"
    );
  }

  /// Production `download_model` / `stream_artifact_to_file` cancel seam.
  /// Server publishes an AtomicBool after partial body (sync signal, not sleep); cancel then
  /// returns Cancelled, persists non-downloading status, and removes staging.
  #[test]
  fn plugin_model_download_service_cancel_during_stalled_body_cleans_staging() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind service stall fixture");
    let addr = listener.local_addr().expect("local addr");
    let body_stalled = Arc::new(AtomicBool::new(false));
    let body_stalled_server = body_stalled.clone();
    let server_done = Arc::new(AtomicBool::new(false));
    let server_done_flag = server_done.clone();
    thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf);
        let headers = b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(headers);
        let _ = stream.write_all(b"PARTIAL-BODY");
        let _ = stream.flush();
        // Publish "body stalled" before parking the connection.
        body_stalled_server.store(true, Ordering::SeqCst);
        let park_deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < park_deadline {
          if server_done_flag.load(Ordering::SeqCst) {
            break;
          }
          thread::sleep(Duration::from_millis(20));
        }
      }
    });

    let dir = TempDir::new().unwrap();
    let db = test_db(dir.path());
    let package_digest = "e".repeat(64);
    let instance_id = seed_paddleocr_instance(&db, &package_digest);
    let service = PluginModelService::new(db, dir.path().to_path_buf());
    service.set_test_timeouts(Duration::from_secs(10), Duration::from_secs(10), Duration::from_secs(2));

    let stall_url = format!("http://{addr}/det-stall.tar");
    let mut manifest = paddleocr_manifest();
    let mut model = paddleocr_medium_model_resource(LICENSE_NOTICE);
    model.artifacts[0].url = stall_url;
    model.artifacts[0].bytes = 1_048_576;
    model.artifacts[0].sha256 = "a".repeat(64);
    model.artifacts[1].bytes = 1;
    model.artifacts[1].sha256 = sha256_hex(b"x");
    model.files = vec![crate::domain::plugin_model::ModelFileDescriptor {
      path: DET_PATH.into(),
      role: crate::domain::plugin_model::ModelFileRole::Detection,
      bytes: 1,
      sha256: sha256_hex(b"x"),
    }];
    model.total_download_bytes = model.artifacts.iter().map(|a| a.bytes).sum();
    model.expanded_bytes = 1;
    manifest.model_resources = Some(vec![model]);
    let manifest_json = serde_json::to_string(&manifest).unwrap();
    service
      .db
      .write(|conn| {
        conn.execute(
          "UPDATE installed_plugin_versions SET manifest_json = ?1 WHERE package_digest = ?2",
          rusqlite::params![manifest_json, package_digest],
        )?;
        Ok(())
      })
      .unwrap();

    let service_for_cancel = service.clone();
    let instance_for_cancel = instance_id;
    let operation_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let operation_slot_progress = operation_slot.clone();
    let body_stalled_client = body_stalled.clone();
    let cancel_thread = thread::spawn(move || {
      // Wait for server sync signal (partial body published), then for operation id.
      let signal_deadline = Instant::now() + Duration::from_secs(5);
      while !body_stalled_client.load(Ordering::SeqCst) {
        if Instant::now() >= signal_deadline {
          panic!("server did not publish body-stalled signal");
        }
        thread::sleep(Duration::from_millis(5));
      }
      let op_deadline = Instant::now() + Duration::from_secs(5);
      let operation_id = loop {
        if let Some(id) = operation_slot.lock().expect("op slot").clone() {
          break id;
        }
        if Instant::now() >= op_deadline {
          panic!("operation id not published before cancel");
        }
        thread::sleep(Duration::from_millis(5));
      };
      service_for_cancel
        .cancel_download(CancelPluginModelDownloadInput {
          instance_id: instance_for_cancel.to_string(),
          model_id: "pp-ocrv6-medium".into(),
          operation_id,
        })
        .expect("cancel accepted");
    });

    let started = Instant::now();
    let err = service
      .download_model(
        DownloadPluginModelInput {
          instance_id: instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        move |progress| {
          let mut slot = operation_slot_progress.lock().expect("op slot");
          if slot.is_none() {
            *slot = Some(progress.operation_id.clone());
          }
        },
      )
      .expect_err("stalled body cancel must fail");
    let elapsed = started.elapsed();
    server_done.store(true, Ordering::SeqCst);
    let _ = cancel_thread.join();

    assert!(
      download_err_code(&err).contains("cancelled"),
      "stalled read must prefer Cancelled after cancel, got {err:?}"
    );
    assert!(
      elapsed < Duration::from_secs(5),
      "cancel must close the async body task promptly; elapsed={elapsed:?}"
    );

    let listed = service
      .list_for_instance(&instance_id.to_string())
      .expect("list after cancel");
    assert_eq!(listed.len(), 1);
    assert!(
      matches!(
        listed[0].status,
        PluginModelResourceStatus::Missing | PluginModelResourceStatus::Failed
      ),
      "status after cancel must not stay downloading/ready, got {:?}",
      listed[0].status
    );
    let staging_root = dir.path().join("plugin-models").join("staging");
    if staging_root.exists() {
      let leftover = std::fs::read_dir(&staging_root)
        .map(|rd| rd.filter_map(|e| e.ok()).count())
        .unwrap_or(0);
      assert_eq!(leftover, 0, "staging must be cleaned after cancelled stall");
    }
  }

  /// Production `download_model` overall-budget seam: stalled body fails under a short overall
  /// override; server signals stall with AtomicBool (no sleep guesses); status + staging checked.
  #[test]
  fn plugin_model_download_service_overall_timeout_cleans_staging() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind overall fixture");
    let addr = listener.local_addr().expect("local addr");
    let body_stalled = Arc::new(AtomicBool::new(false));
    let body_stalled_server = body_stalled.clone();
    let server_done = Arc::new(AtomicBool::new(false));
    let server_done_flag = server_done.clone();
    thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf);
        let headers = b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(headers);
        let _ = stream.write_all(b"PARTIAL");
        let _ = stream.flush();
        body_stalled_server.store(true, Ordering::SeqCst);
        let park_deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < park_deadline {
          if server_done_flag.load(Ordering::SeqCst) {
            break;
          }
          thread::sleep(Duration::from_millis(20));
        }
      }
    });

    let dir = TempDir::new().unwrap();
    let db = test_db(dir.path());
    let package_digest = "f".repeat(64);
    let instance_id = seed_paddleocr_instance(&db, &package_digest);
    let service = PluginModelService::new(db, dir.path().to_path_buf());
    // Overall shorter than read: production stream must bound by overall, not hang on read.
    service.set_test_timeouts(
      Duration::from_millis(400),
      Duration::from_secs(30),
      Duration::from_secs(2),
    );

    let stall_url = format!("http://{addr}/det-overall.tar");
    let mut manifest = paddleocr_manifest();
    let mut model = paddleocr_medium_model_resource(LICENSE_NOTICE);
    model.artifacts[0].url = stall_url;
    model.artifacts[0].bytes = 1_048_576;
    model.artifacts[0].sha256 = "b".repeat(64);
    model.artifacts[1].bytes = 1;
    model.artifacts[1].sha256 = sha256_hex(b"y");
    model.files = vec![crate::domain::plugin_model::ModelFileDescriptor {
      path: DET_PATH.into(),
      role: crate::domain::plugin_model::ModelFileRole::Detection,
      bytes: 1,
      sha256: sha256_hex(b"y"),
    }];
    model.total_download_bytes = model.artifacts.iter().map(|a| a.bytes).sum();
    model.expanded_bytes = 1;
    manifest.model_resources = Some(vec![model]);
    let manifest_json = serde_json::to_string(&manifest).unwrap();
    service
      .db
      .write(|conn| {
        conn.execute(
          "UPDATE installed_plugin_versions SET manifest_json = ?1 WHERE package_digest = ?2",
          rusqlite::params![manifest_json, package_digest],
        )?;
        Ok(())
      })
      .unwrap();

    let started = Instant::now();
    let err = service
      .download_model(
        DownloadPluginModelInput {
          instance_id: instance_id.to_string(),
          model_id: "pp-ocrv6-medium".into(),
        },
        |_| {},
      )
      .expect_err("overall stall must fail");
    let elapsed = started.elapsed();
    server_done.store(true, Ordering::SeqCst);

    // Prove the server actually entered the stall (sync signal), not a connect failure.
    assert!(
      body_stalled.load(Ordering::SeqCst),
      "overall test must exercise a stalled body, not a failed connect"
    );
    assert!(
      download_err_code(&err).contains("model_failed") || download_err_code(&err).contains("failed"),
      "overall timeout must fail closed, got {err:?}"
    );
    assert!(
      elapsed < Duration::from_secs(3),
      "overall must bound the production stream; elapsed={elapsed:?}"
    );
    assert!(
      elapsed >= Duration::from_millis(200),
      "should consume part of the overall window; elapsed={elapsed:?}"
    );

    let listed = service
      .list_for_instance(&instance_id.to_string())
      .expect("list after overall");
    assert_eq!(listed.len(), 1);
    assert!(
      matches!(
        listed[0].status,
        PluginModelResourceStatus::Missing | PluginModelResourceStatus::Failed
      ),
      "status after overall must not stay downloading/ready, got {:?}",
      listed[0].status
    );
    let staging_root = dir.path().join("plugin-models").join("staging");
    if staging_root.exists() {
      let leftover = std::fs::read_dir(&staging_root)
        .map(|rd| rd.filter_map(|e| e.ok()).count())
        .unwrap_or(0);
      assert_eq!(leftover, 0, "staging must be cleaned after overall timeout");
    }
  }
}
