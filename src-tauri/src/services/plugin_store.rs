// ABOUTME: Content-addressed plugin package store with staging, quarantine, and crash recovery.
// ABOUTME: Installs verified archives immutably; never executes package code.
use crate::domain::plugin_package::{
  ApprovePluginPackageInput, ApprovePluginPackageResult, ApproveUserPublisherInput, InstallOperationState,
  InstalledPluginVersion, InstalledPluginVersionDto, PACKAGE_ARCHIVE_MAX_BYTES, PACKAGE_PREVIEW_TTL_SECS,
  PackageErrorCode, PackageNetworkPermissionDto, PluginDefaultVersion, PluginInstallOperation, PluginPackageApproval,
  PluginPackagePreviewDto, PluginPublisher, PluginPublisherDto, PluginUninstallOperation, PluginVersionDependenciesDto,
  PublisherDecision, PublisherSource, PublisherTrustState, UninstallOperationState, compute_permission_request_digest,
  runtime_kind_storage,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{
  installed_plugin_versions, integration_instances, plugin_install_operations, plugin_package_approvals,
  plugin_publishers, plugin_uninstall_operations,
};
use crate::services::plugin_package::{
  PackageVerifyError, VerifiedPackage, hash_file, inspect_package_bytes, public_key_fingerprint, read_file_bounded,
  set_readonly, verify_package_bytes, verify_store_content, write_extracted_content,
};
use crate::services::vendor_trust::{self, VendorPublicKey, cargo_resources_root};
use crate::storage::Database;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use time::OffsetDateTime;
use uuid::Uuid;

/// Interval for active staging/preview TTL sweep while the app is running.
pub const STAGING_SWEEP_INTERVAL_SECS: u64 = 30;

/// Canonical vendor key id constant (public roots only; never a fabricated production private seed).
pub use crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID;

/// Test-only install fault points injected into the real approve/install chain.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallFaultPoint {
  AfterPreparedBeforeVerify,
  AfterVerifiedBeforeDbCommit,
  AfterDbCommitBeforeRename,
  AfterRenameBeforePostVerify,
  AfterPostVerifyBeforeFinalize,
}

struct PreviewSession {
  operation_id: Uuid,
  package_digest: String,
  verified: VerifiedPackage,
  staging_dir: PathBuf,
  publisher_trust: PublisherTrustState,
  requires_publisher_approval: bool,
  expires_at_unix: u64,
  created_at: String,
}

/// Handle for the background staging TTL sweep thread (stoppable).
pub struct StagingSweepHandle {
  stop: Arc<AtomicBool>,
  join: Option<std::thread::JoinHandle<()>>,
}

impl StagingSweepHandle {
  pub fn stop(mut self) {
    self.stop.store(true, Ordering::SeqCst);
    if let Some(join) = self.join.take() {
      let _ = join.join();
    }
  }
}

impl Drop for StagingSweepHandle {
  fn drop(&mut self) {
    self.stop.store(true, Ordering::SeqCst);
  }
}

/// Plugin package store service: preview, approve/install, list, default, uninstall, recover.
#[derive(Clone)]
pub struct PluginPackageService {
  db: Database,
  app_data_dir: PathBuf,
  previews: Arc<Mutex<HashMap<Uuid, PreviewSession>>>,
  /// Production or injected vendor public keys (never private keys).
  vendor_roots: Arc<Vec<VendorPublicKey>>,
  #[cfg(test)]
  install_fault: Arc<Mutex<Option<InstallFaultPoint>>>,
  #[cfg(test)]
  restore_fault: Arc<Mutex<Option<UninstallRestoreFault>>>,
  /// When true, catalog delete fails after quarantine so restore is exercised.
  #[cfg(test)]
  catalog_delete_fault: Arc<Mutex<bool>>,
}

/// Test-only fault points for uninstall restore/rehash paths.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UninstallRestoreFault {
  BeforeRestore,
  AfterRestoreBeforeRehash,
  AfterRehashBeforeAvailability,
  MarkFailedWrite,
  AvailabilityWrite,
}

impl PluginPackageService {
  /// Production constructor: loads vendor public keys from fail-closed resource/env paths (empty default).
  pub fn new(db: Database, app_data_dir: PathBuf) -> Self {
    let roots = vendor_trust::load_production_vendor_public_keys(&[cargo_resources_root()]).unwrap_or_else(|err| {
      log::error!("vendor_trust_load_failed error={err}; continuing with empty vendor roots");
      Vec::new()
    });
    Self::with_vendor_roots(db, app_data_dir, roots)
  }

  /// Explicit vendor public-key injection (tests and specialized hosts). Production uses [`Self::new`].
  pub fn with_vendor_roots(db: Database, app_data_dir: PathBuf, vendor_roots: Vec<VendorPublicKey>) -> Self {
    let service = Self {
      db,
      app_data_dir,
      previews: Arc::new(Mutex::new(HashMap::new())),
      vendor_roots: Arc::new(vendor_roots),
      #[cfg(test)]
      install_fault: Arc::new(Mutex::new(None)),
      #[cfg(test)]
      restore_fault: Arc::new(Mutex::new(None)),
      #[cfg(test)]
      catalog_delete_fault: Arc::new(Mutex::new(false)),
    };
    if let Err(err) = service.seed_vendor_publishers() {
      log::error!("vendor_publisher_seed_failed error={err}");
    }
    service
  }

  fn plugins_root(&self) -> PathBuf {
    self.app_data_dir.join("plugins")
  }

  fn staging_root(&self) -> PathBuf {
    self.plugins_root().join("staging")
  }

  fn store_root(&self) -> PathBuf {
    self.plugins_root().join("store").join("sha256")
  }

  fn quarantine_root(&self) -> PathBuf {
    self.plugins_root().join("quarantine")
  }

  pub(crate) fn store_package_dir(&self, digest: &str) -> PathBuf {
    self.store_root().join(digest)
  }

  /// Absolute path to the retained exact signed archive for a package digest.
  pub fn package_archive_path(&self, package_digest: &str) -> PathBuf {
    self.store_package_dir(package_digest).join("package.lnplugin")
  }

  /// Absolute path to the extracted immutable content tree for a package digest.
  pub fn package_content_path(&self, package_digest: &str) -> PathBuf {
    self.store_package_dir(package_digest).join("content")
  }

  /// Seed only the configured vendor public keys into SQLite (no fabricated production defaults).
  pub fn seed_vendor_publishers(&self) -> Result<(), StorageError> {
    self.db.transaction(|uow| {
      for root in self.vendor_roots.iter() {
        let fingerprint =
          public_key_fingerprint(&root.public_key_hex).map_err(|e| StorageError::Validation(e.message))?;
        plugin_publishers::upsert_vendor(uow.conn(), &root.key_id, &fingerprint, &root.public_key_hex)?;
      }
      Ok(())
    })
  }

  /// Start a stoppable background sweep for preview TTL and orphan staging cleanup.
  pub fn start_staging_sweep(&self) -> StagingSweepHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let service = self.clone();
    let join = std::thread::Builder::new()
      .name("plugin-staging-sweep".into())
      .spawn(move || {
        while !stop_flag.load(Ordering::SeqCst) {
          if let Err(err) = service.expire_stale_previews() {
            log::error!("plugin_preview_ttl_sweep_failed error={err}");
          }
          if let Err(err) = service.sweep_orphan_staging() {
            log::error!("plugin_orphan_staging_sweep_failed error={err}");
          }
          // Interruptible sleep so stop is responsive.
          for _ in 0..STAGING_SWEEP_INTERVAL_SECS {
            if stop_flag.load(Ordering::SeqCst) {
              break;
            }
            std::thread::sleep(Duration::from_secs(1));
          }
        }
      })
      .ok();
    StagingSweepHandle { stop, join }
  }

  #[cfg(test)]
  pub fn set_install_fault(&self, fault: Option<InstallFaultPoint>) {
    *self.install_fault.lock().expect("install fault lock") = fault;
  }

  #[cfg(test)]
  fn take_install_fault(&self, expected: InstallFaultPoint) -> bool {
    let mut guard = self.install_fault.lock().expect("install fault lock");
    if *guard == Some(expected) {
      *guard = None;
      true
    } else {
      false
    }
  }

  /// Startup recovery: reconcile unfinished install/uninstall operations without executing packages.
  pub fn recover_install_operations(&self) -> Result<(), StorageError> {
    self.expire_stale_previews()?;
    self.sweep_orphan_staging()?;
    let ops = self.db.read(plugin_install_operations::list_unfinished)?;
    for op in ops {
      if let Err(err) = self.recover_one(&op) {
        log::error!(
          "plugin_install_recovery_failed id={} state={:?} error={err}",
          op.id,
          op.state
        );
      }
    }
    let uninstall_ops = self.db.read(plugin_uninstall_operations::list_unfinished)?;
    for op in uninstall_ops {
      if let Err(err) = self.recover_one_uninstall(&op) {
        log::error!(
          "plugin_uninstall_recovery_failed id={} state={:?} error={err}",
          op.id,
          op.state
        );
      }
    }
    // Re-verify DB-installed packages; partial/tampered targets are never content_available.
    let versions = self.db.read(installed_plugin_versions::list)?;
    for version in versions {
      let available = self.is_store_content_verified(&version);
      if available != version.content_available {
        self.db.transaction(|uow| {
          installed_plugin_versions::set_content_available(uow.conn(), &version.package_digest, available)?;
          Ok(())
        })?;
      }
    }
    Ok(())
  }

  fn is_store_content_verified(&self, version: &InstalledPluginVersion) -> bool {
    let package_path = self.store_package_dir(&version.package_digest).join("package.lnplugin");
    let content_dir = self.store_package_dir(&version.package_digest).join("content");
    if !package_path.is_file() || !content_dir.is_dir() {
      return false;
    }
    let Ok(publisher) = self
      .db
      .read(|conn| plugin_publishers::get_optional(conn, &version.publisher_key_id))
    else {
      return false;
    };
    let Some(publisher) = publisher else {
      return false;
    };
    verify_store_content(
      &package_path,
      &content_dir,
      &version.package_digest,
      &publisher.public_key_hex,
    )
    .is_ok()
  }

  fn recover_one_uninstall(&self, op: &PluginUninstallOperation) -> Result<(), StorageError> {
    // Location + exact digest decide recovery. Never delete catalog when a verified store package
    // is present (covers crash after restore/rehash and before journal/availability update).
    let store_verified = self.package_store_archive_matches(&op.package_digest);
    let qpath_opt = op.quarantine_path.as_deref().map(Path::new);
    let quarantine_verified = qpath_opt
      .filter(|p| p.exists())
      .map(|p| self.quarantine_path_is_safe(p) && self.quarantine_archive_matches(&op.package_digest, p))
      .unwrap_or(false);

    match op.state {
      UninstallOperationState::Prepared | UninstallOperationState::ContentQuarantined => {
        if store_verified {
          self.db.transaction(|uow| {
            if installed_plugin_versions::get_optional(uow.conn(), &op.package_digest)?.is_some() {
              installed_plugin_versions::set_content_available(uow.conn(), &op.package_digest, true)?;
            }
            plugin_uninstall_operations::mark_restored(uow.conn(), op.id, "recovered_store_present")?;
            Ok(())
          })?;
          return Ok(());
        }

        if quarantine_verified {
          let qpath = PathBuf::from(op.quarantine_path.as_deref().unwrap_or_default());
          if self
            .db
            .read(|conn| installed_plugin_versions::get_optional(conn, &op.package_digest))?
            .is_some()
          {
            self.restore_and_reverify_package(&op.package_digest, &qpath)?;
            if !self.package_store_archive_matches(&op.package_digest) {
              self.db.transaction(|uow| {
                installed_plugin_versions::set_content_available(uow.conn(), &op.package_digest, false)?;
                plugin_uninstall_operations::mark_failed(uow.conn(), op.id, "blocked_restore_digest_mismatch")?;
                Ok(())
              })?;
              return Ok(());
            }
            self.db.transaction(|uow| {
              installed_plugin_versions::set_content_available(uow.conn(), &op.package_digest, true)?;
              plugin_uninstall_operations::mark_rolled_back(uow.conn(), op.id, "recovered_from_quarantine")?;
              Ok(())
            })?;
            return Ok(());
          }
          // No catalog row: content only in quarantine — drop only when path+digest verified.
          let _ = self.remove_path(&qpath);
          self.db.transaction(|uow| {
            plugin_uninstall_operations::mark_catalog_deleted(uow.conn(), op.id)?;
            plugin_uninstall_operations::mark_finalized(uow.conn(), op.id)?;
            Ok(())
          })?;
          return Ok(());
        }

        if self
          .db
          .read(|conn| installed_plugin_versions::get_optional(conn, &op.package_digest))?
          .is_some()
        {
          self.db.transaction(|uow| {
            installed_plugin_versions::set_content_available(uow.conn(), &op.package_digest, false)?;
            plugin_uninstall_operations::mark_failed(uow.conn(), op.id, "recovered_content_missing")?;
            Ok(())
          })?;
        } else {
          self.db.transaction(|uow| {
            plugin_uninstall_operations::mark_catalog_deleted(uow.conn(), op.id)?;
            plugin_uninstall_operations::mark_finalized(uow.conn(), op.id)?;
            Ok(())
          })?;
        }
      }
      UninstallOperationState::CatalogDeleted => {
        // Catalog already gone; only delete quarantine when under quarantine root + digest match.
        if let Some(q) = op.quarantine_path.as_deref() {
          let qpath = Path::new(q);
          if qpath.exists() {
            if self.quarantine_path_is_safe(qpath) && self.quarantine_archive_matches(&op.package_digest, qpath) {
              let _ = self.remove_path(qpath);
            } else {
              // Do not delete untrusted paths; leave blocked for manual recovery.
              self.db.transaction(|uow| {
                plugin_uninstall_operations::mark_failed(uow.conn(), op.id, "blocked_quarantine_path_or_digest")?;
                Ok(())
              })?;
              return Ok(());
            }
          }
        }
        self.db.transaction(|uow| {
          plugin_uninstall_operations::mark_finalized(uow.conn(), op.id)?;
          Ok(())
        })?;
      }
      UninstallOperationState::Finalized
      | UninstallOperationState::Failed
      | UninstallOperationState::Restored
      | UninstallOperationState::RolledBack => {}
    }
    Ok(())
  }

  /// Quarantine path must resolve under the service quarantine root (no path escape).
  fn quarantine_path_is_safe(&self, quarantine_path: &Path) -> bool {
    let root = match self.quarantine_root().canonicalize() {
      Ok(p) => p,
      Err(_) => return false,
    };
    let path = match quarantine_path.canonicalize() {
      Ok(p) => p,
      Err(_) => return false,
    };
    path.starts_with(&root)
  }

  /// True when the CAS store holds an archive whose SHA-256 equals `package_digest`.
  fn package_store_archive_matches(&self, package_digest: &str) -> bool {
    let archive = self.package_archive_path(package_digest);
    if !archive.is_file() {
      return false;
    }
    crate::services::plugin_package::hash_file(&archive)
      .map(|d| d == package_digest)
      .unwrap_or(false)
  }

  /// True when a quarantine package directory holds `package.lnplugin` with matching digest.
  fn quarantine_archive_matches(&self, package_digest: &str, quarantine_path: &Path) -> bool {
    let archive = quarantine_path.join("package.lnplugin");
    if !archive.is_file() {
      return false;
    }
    crate::services::plugin_package::hash_file(&archive)
      .map(|d| d == package_digest)
      .unwrap_or(false)
  }

  fn recover_one(&self, op: &PluginInstallOperation) -> Result<(), StorageError> {
    match op.state {
      InstallOperationState::Prepared | InstallOperationState::Verified => {
        // Not committed: quarantine staging and mark failed.
        self.quarantine_path(Path::new(&op.staging_path), "recovered_incomplete")?;
        self.db.transaction(|uow| {
          plugin_install_operations::mark_failed(uow.conn(), op.id, "recovered_incomplete")?;
          Ok(())
        })?;
      }
      InstallOperationState::DbCommitted => {
        // DB rows exist; finalize only after full re-verification of archive + content index.
        if let Some(digest) = &op.package_digest {
          let staging = PathBuf::from(&op.staging_path);
          let dest = self.store_package_dir(digest);
          let version = self
            .db
            .read(|conn| installed_plugin_versions::get_optional(conn, digest))?;
          let publisher_key = version.as_ref().and_then(|v| {
            self
              .db
              .read(|conn| plugin_publishers::get_optional(conn, &v.publisher_key_id))
              .ok()
              .flatten()
              .map(|p| p.public_key_hex)
          });

          if dest.join("package.lnplugin").is_file() {
            let content_ok = publisher_key
              .as_ref()
              .is_some_and(|key| self.verify_dest_against_digest(&dest, digest, key).is_ok());
            self.remove_path(&staging)?;
            if content_ok {
              self.db.transaction(|uow| {
                plugin_install_operations::mark_finalized(uow.conn(), op.id)?;
                installed_plugin_versions::set_content_available(uow.conn(), digest, true)?;
                Ok(())
              })?;
            } else {
              // Partial or tampered store target — quarantine and keep catalog unavailable.
              self.quarantine_path(&dest, "partial_store")?;
              self.db.transaction(|uow| {
                installed_plugin_versions::set_content_available(uow.conn(), digest, false)?;
                plugin_install_operations::mark_failed(uow.conn(), op.id, "content_unverified")?;
                Ok(())
              })?;
            }
          } else if staging.join("package.lnplugin").is_file() {
            if let Some(key) = publisher_key.as_deref() {
              match self.verify_staging_complete(&staging, digest, key) {
                Ok(()) => {
                  self.atomic_install_from_staging(&staging, digest)?;
                  // Re-verify after rename before marking available.
                  if self
                    .verify_dest_against_digest(&self.store_package_dir(digest), digest, key)
                    .is_ok()
                  {
                    self.db.transaction(|uow| {
                      plugin_install_operations::mark_finalized(uow.conn(), op.id)?;
                      installed_plugin_versions::set_content_available(uow.conn(), digest, true)?;
                      Ok(())
                    })?;
                  } else {
                    self.quarantine_path(&self.store_package_dir(digest), "post_rename_unverified")?;
                    self.db.transaction(|uow| {
                      installed_plugin_versions::set_content_available(uow.conn(), digest, false)?;
                      plugin_install_operations::mark_failed(uow.conn(), op.id, "content_unverified")?;
                      Ok(())
                    })?;
                  }
                }
                Err(_) => {
                  self.quarantine_path(&staging, "staging_unverified")?;
                  self.db.transaction(|uow| {
                    installed_plugin_versions::set_content_available(uow.conn(), digest, false)?;
                    plugin_install_operations::mark_failed(uow.conn(), op.id, "content_unverified")?;
                    Ok(())
                  })?;
                }
              }
            } else {
              self.quarantine_path(&staging, "missing_publisher")?;
              self.db.transaction(|uow| {
                installed_plugin_versions::set_content_available(uow.conn(), digest, false)?;
                plugin_install_operations::mark_failed(uow.conn(), op.id, "missing_publisher")?;
                Ok(())
              })?;
            }
          } else {
            // Content missing: keep catalog row, mark unavailable, do not delete instances.
            self.db.transaction(|uow| {
              installed_plugin_versions::set_content_available(uow.conn(), digest, false)?;
              plugin_install_operations::mark_failed(uow.conn(), op.id, "content_missing")?;
              Ok(())
            })?;
          }
        } else {
          self.db.transaction(|uow| {
            plugin_install_operations::mark_failed(uow.conn(), op.id, "missing_digest")?;
            Ok(())
          })?;
        }
      }
      InstallOperationState::Finalized | InstallOperationState::Failed => {}
    }
    Ok(())
  }

  fn verify_staging_complete(&self, staging: &Path, digest: &str, public_key_hex: &str) -> Result<(), StorageError> {
    verify_store_content(
      &staging.join("package.lnplugin"),
      &staging.join("content"),
      digest,
      public_key_hex,
    )
    .map(|_| ())
    .map_err(StorageError::from)
  }

  fn verify_dest_against_digest(&self, dest: &Path, digest: &str, public_key_hex: &str) -> Result<(), StorageError> {
    verify_store_content(
      &dest.join("package.lnplugin"),
      &dest.join("content"),
      digest,
      public_key_hex,
    )
    .map(|_| ())
    .map_err(StorageError::from)
  }

  fn expire_stale_previews(&self) -> Result<(), StorageError> {
    let now = now_unix();
    let expired: Vec<PreviewSession> = {
      let mut previews = self
        .previews
        .lock()
        .map_err(|_| StorageError::Internal("preview lock".into()))?;
      let mut expired = Vec::new();
      previews.retain(|_, session| {
        if now > session.expires_at_unix {
          expired.push(PreviewSession {
            operation_id: session.operation_id,
            package_digest: session.package_digest.clone(),
            verified: session.verified.clone(),
            staging_dir: session.staging_dir.clone(),
            publisher_trust: session.publisher_trust,
            requires_publisher_approval: session.requires_publisher_approval,
            expires_at_unix: session.expires_at_unix,
            created_at: session.created_at.clone(),
          });
          false
        } else {
          true
        }
      });
      expired
    };
    let mut first_err: Option<StorageError> = None;
    for session in expired {
      if let Err(err) = self.quarantine_path(&session.staging_dir, "preview_expired") {
        log::error!("preview_ttl_quarantine_failed error={err}");
        first_err.get_or_insert(err);
      }
      if let Err(err) = self.fail_operation(session.operation_id, PackageErrorCode::PreviewExpired.as_str()) {
        log::error!("preview_ttl_journal_failed error={err}");
        first_err.get_or_insert(err);
      }
    }
    if let Some(err) = first_err {
      return Err(err);
    }
    Ok(())
  }

  fn sweep_orphan_staging(&self) -> Result<(), StorageError> {
    let root = self.staging_root();
    if !root.is_dir() {
      return Ok(());
    }
    let unfinished = self.db.read(plugin_install_operations::list_unfinished)?;
    let live_paths: std::collections::HashSet<String> = unfinished.into_iter().map(|op| op.staging_path).collect();
    let mut first_err: Option<StorageError> = None;
    for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
      let path = entry.path();
      let key = path.to_string_lossy().to_string();
      if !live_paths.contains(&key) {
        if let Err(err) = self.quarantine_path(&path, "orphan_staging") {
          log::error!("orphan_staging_quarantine_failed path={} error={err}", path.display());
          first_err.get_or_insert(err);
        }
      }
    }
    if let Some(err) = first_err {
      return Err(err);
    }
    Ok(())
  }

  /// Preview a local package path: stage, verify, return sanitized preview with opaque id.
  pub fn preview_package(&self, source_path: &Path) -> Result<PluginPackagePreviewDto, StorageError> {
    let _ = self.expire_stale_previews();
    let archive_bytes = read_file_bounded(source_path, PACKAGE_ARCHIVE_MAX_BYTES).map_err(StorageError::from)?;
    let operation_id = new_id();
    let staging_dir = self.staging_root().join(operation_id.to_string());
    std::fs::create_dir_all(&staging_dir)?;
    let staged_package = staging_dir.join("package.lnplugin");
    std::fs::write(&staged_package, &archive_bytes)?;
    set_readonly(&staged_package);

    self.db.transaction(|uow| {
      plugin_install_operations::insert_prepared(uow.conn(), operation_id, &staging_dir.to_string_lossy())?;
      Ok(())
    })?;

    let fail_preview = |this: &Self, code: &str, err: StorageError| -> StorageError {
      if let Err(qerr) = this.quarantine_path(&staging_dir, code) {
        log::error!("preview_fail_quarantine_failed code={code} error={qerr}");
        return qerr;
      }
      if let Err(ferr) = this.fail_operation(operation_id, code) {
        log::error!("preview_fail_journal_failed code={code} error={ferr}");
        return ferr;
      }
      err
    };

    let package_digest = match hash_file(&staged_package) {
      Ok(d) => d,
      Err(err) => return Err(fail_preview(self, err.code.as_str(), err.into())),
    };
    let staged_bytes = match read_file_bounded(&staged_package, PACKAGE_ARCHIVE_MAX_BYTES) {
      Ok(b) => b,
      Err(err) => return Err(fail_preview(self, err.code.as_str(), err.into())),
    };
    if hash_file(&staged_package).map_err(StorageError::from)? != package_digest {
      return Err(fail_preview(
        self,
        PackageErrorCode::DigestMismatch.as_str(),
        PackageVerifyError::new(PackageErrorCode::DigestMismatch, "staged digest drift").into(),
      ));
    }

    // Structural inspection first (signature length + manifest/index/semantics).
    let structural = match inspect_package_bytes(&staged_bytes) {
      Ok(v) => v,
      Err(err) => return Err(fail_preview(self, err.code.as_str(), err.into())),
    };

    // Reject same plugin_id+version with different digest.
    if let Some(existing) = self.db.read(|conn| {
      installed_plugin_versions::get_by_plugin_version(conn, &structural.manifest.id, &structural.manifest.version)
    })? {
      if existing.package_digest != structural.package_digest {
        return Err(fail_preview(
          self,
          PackageErrorCode::VersionConflict.as_str(),
          StorageError::Conflict(format!(
            "plugin {} version {} already installed with digest {}",
            existing.plugin_id, existing.version, existing.package_digest
          )),
        ));
      }
    }

    let publisher_row = self
      .db
      .read(|conn| plugin_publishers::get_optional(conn, &structural.manifest.publisher.key_id))?;

    // Also resolve by fingerprint for vendor seed mismatches on key_id.
    let publisher_by_fp = self
      .db
      .read(|conn| plugin_publishers::get_by_fingerprint(conn, &structural.manifest.publisher.key_fingerprint))?;

    let (publisher_trust, requires_publisher_approval, public_key_hex) = match publisher_row.or(publisher_by_fp) {
      Some(p) if p.revoked => {
        return Err(fail_preview(
          self,
          PackageErrorCode::PublisherRevoked.as_str(),
          PackageVerifyError::new(
            PackageErrorCode::PublisherRevoked,
            format!("publisher {} is revoked", p.key_id),
          )
          .into(),
        ));
      }
      Some(p) if !p.enabled => {
        return Err(fail_preview(
          self,
          PackageErrorCode::PublisherDisabled.as_str(),
          PackageVerifyError::new(
            PackageErrorCode::PublisherDisabled,
            format!("publisher {} is disabled", p.key_id),
          )
          .into(),
        ));
      }
      Some(p) => {
        let trust = match p.source {
          PublisherSource::Vendor => PublisherTrustState::TrustedVendor,
          PublisherSource::UserApproved => PublisherTrustState::TrustedUser,
        };
        (trust, false, Some(p.public_key_hex))
      }
      None => (PublisherTrustState::Unknown, true, None),
    };

    // Trusted publishers: full Ed25519 over exact plugin.json bytes (fail closed).
    // Unknown publishers: structural only; crypto required at approve with explicit key.
    let verified = if let Some(ref key) = public_key_hex {
      match verify_package_bytes(&staged_bytes, key) {
        Ok(v) => v,
        Err(err) => return Err(fail_preview(self, err.code.as_str(), err.into())),
      }
    } else {
      structural
    };

    // Extract content into staging/content for later atomic move.
    let content_dir = staging_dir.join("content");
    if let Err(err) = write_extracted_content(&content_dir, &verified.extracted_files) {
      return Err(fail_preview(self, err.code.as_str(), err.into()));
    }

    self.db.transaction(|uow| {
      plugin_install_operations::mark_verified(uow.conn(), operation_id, &verified.package_digest)?;
      Ok(())
    })?;

    let expires_at_unix = now_unix() + PACKAGE_PREVIEW_TTL_SECS;
    let expires_at = unix_to_rfc3339(expires_at_unix);
    let permission_request_digest = compute_permission_request_digest(&verified.manifest);
    let permission_differences = self.permission_differences_for(&verified.manifest)?;
    let network = verified
      .manifest
      .permissions
      .network
      .iter()
      .map(|endpoint| PackageNetworkPermissionDto {
        id: endpoint.id.clone(),
        origins: endpoint.origins.clone(),
        methods: endpoint
          .methods
          .iter()
          .map(|m| {
            serde_json::to_string(m)
              .unwrap_or_else(|_| "\"?\"".into())
              .trim_matches('"')
              .to_string()
          })
          .collect(),
      })
      .collect();
    let capabilities = verified.manifest.capabilities.iter().map(|c| c.id.clone()).collect();
    let mut warnings = Vec::new();
    if requires_publisher_approval {
      warnings.push("Publisher is not trusted. Approving installs a user publisher key.".into());
    }
    if !verified.manifest.permissions.network.is_empty() || !verified.manifest.permissions.auth_policies.is_empty() {
      warnings.push(
        "Package requests network/auth permissions. Approval is catalog-only; instance execution grant sets are created later per instance.".into(),
      );
    }
    if !permission_differences.is_empty() {
      warnings.push("Requested permissions differ from the currently installed version.".into());
    }
    warnings.push("Installed package code cannot execute until Phase 4 runtime activation.".into());

    let preview_id = new_id();
    let dto = PluginPackagePreviewDto {
      preview_id: preview_id.to_string(),
      package_digest: verified.package_digest.clone(),
      plugin_id: verified.manifest.id.clone(),
      version: verified.manifest.version.clone(),
      publisher_key_id: verified.manifest.publisher.key_id.clone(),
      publisher_fingerprint: verified.manifest.publisher.key_fingerprint.clone(),
      publisher_trust,
      requires_publisher_approval,
      runtime_kind: runtime_kind_storage(verified.manifest.runtime.kind).to_string(),
      capabilities,
      configuration_schema: verified.manifest.configuration_schema.clone(),
      network,
      auth_policies: verified.manifest.permissions.auth_policies.clone(),
      permission_request_digest,
      permission_differences,
      warnings,
      expires_at: expires_at.clone(),
    };

    let mut previews = self
      .previews
      .lock()
      .map_err(|_| StorageError::Internal("preview lock".into()))?;
    previews.insert(
      preview_id,
      PreviewSession {
        operation_id,
        package_digest: verified.package_digest.clone(),
        verified,
        staging_dir,
        publisher_trust,
        requires_publisher_approval,
        expires_at_unix,
        created_at: now_rfc3339(),
      },
    );
    Ok(dto)
  }

  fn permission_differences_for(
    &self,
    manifest: &crate::domain::runtime_plugin::PluginManifestV1,
  ) -> Result<Vec<String>, StorageError> {
    let existing = self.db.read(|conn| {
      // Prefer default version for the plugin; fall back to any installed version.
      if let Some(default) = installed_plugin_versions::get_default(conn, &manifest.id)? {
        return installed_plugin_versions::get_optional(conn, &default.package_digest);
      }
      let all = installed_plugin_versions::list(conn)?;
      Ok(all.into_iter().find(|v| v.plugin_id == manifest.id))
    })?;
    let Some(existing) = existing else {
      return Ok(Vec::new());
    };
    let existing_manifest: crate::domain::runtime_plugin::PluginManifestV1 =
      serde_json::from_str(&existing.manifest_json).map_err(|e| StorageError::Internal(e.to_string()))?;
    Ok(diff_permissions(&existing_manifest, manifest))
  }

  pub fn discard_preview(&self, preview_id: &str) -> Result<(), StorageError> {
    let id =
      Uuid::parse_str(preview_id).map_err(|_| StorageError::Validation(format!("invalid preview id: {preview_id}")))?;
    let session = {
      let mut previews = self
        .previews
        .lock()
        .map_err(|_| StorageError::Internal("preview lock".into()))?;
      previews.remove(&id)
    };
    if let Some(session) = session {
      self.quarantine_path(&session.staging_dir, "discarded")?;
      self.fail_operation(session.operation_id, "discarded")?;
    }
    Ok(())
  }

  pub fn approve_package(&self, input: ApprovePluginPackageInput) -> Result<ApprovePluginPackageResult, StorageError> {
    if !input.acknowledge_permissions {
      return Err(StorageError::Validation(
        "requested permissions must be explicitly acknowledged".into(),
      ));
    }
    let preview_id = Uuid::parse_str(&input.preview_id)
      .map_err(|_| StorageError::Validation(format!("invalid preview id: {}", input.preview_id)))?;
    let session = {
      let mut previews = self
        .previews
        .lock()
        .map_err(|_| StorageError::Internal("preview lock".into()))?;
      previews.remove(&preview_id)
    }
    .ok_or_else(|| StorageError::Capability {
      code: PackageErrorCode::PreviewNotFound.as_str().into(),
      message: format!("preview {} not found", input.preview_id),
    })?;

    if now_unix() > session.expires_at_unix {
      self.quarantine_path(&session.staging_dir, PackageErrorCode::PreviewExpired.as_str())?;
      self.fail_operation(session.operation_id, PackageErrorCode::PreviewExpired.as_str())?;
      return Err(StorageError::Capability {
        code: PackageErrorCode::PreviewExpired.as_str().into(),
        message: "package preview expired".into(),
      });
    }

    // Re-hash staged archive against session digest.
    let staged_package = session.staging_dir.join("package.lnplugin");
    let digest = hash_file(&staged_package).map_err(StorageError::from)?;
    if digest != session.package_digest {
      self.quarantine_path(&session.staging_dir, PackageErrorCode::DigestMismatch.as_str())?;
      self.fail_operation(session.operation_id, PackageErrorCode::DigestMismatch.as_str())?;
      return Err(PackageVerifyError::new(PackageErrorCode::DigestMismatch, "digest changed").into());
    }

    if session.requires_publisher_approval && !input.approve_publisher {
      self.quarantine_path(&session.staging_dir, "publisher_not_approved")?;
      self.fail_operation(session.operation_id, "publisher_not_approved")?;
      return Err(StorageError::Validation(
        "unknown publisher requires explicit approve_publisher".into(),
      ));
    }

    // Unknown publisher cannot be fully signature-verified without a key. Require the key to
    // already exist (user registered it) when approving.
    let publisher_key = self
      .db
      .read(|conn| plugin_publishers::get_optional(conn, &session.verified.manifest.publisher.key_id))?;

    let (publisher_decision, public_key_hex, register_user_publisher) = match (
      &session.publisher_trust,
      publisher_key,
      input.approve_publisher,
      &input.publisher_public_key_hex,
    ) {
      (PublisherTrustState::TrustedVendor, Some(p), _, _) => {
        (PublisherDecision::TrustedVendor, p.public_key_hex, false)
      }
      (PublisherTrustState::TrustedUser, Some(p), _, _) => (PublisherDecision::AlreadyTrusted, p.public_key_hex, false),
      (_, Some(p), _, _) if !p.revoked && p.enabled => (PublisherDecision::AlreadyTrusted, p.public_key_hex, false),
      (PublisherTrustState::Unknown, None, true, Some(public_key_hex)) => {
        // Explicit new user publisher: validate fingerprint against supplied key.
        let fp = public_key_fingerprint(public_key_hex).map_err(StorageError::from)?;
        if fp != session.verified.manifest.publisher.key_fingerprint {
          self.quarantine_path(&session.staging_dir, PackageErrorCode::SignatureInvalid.as_str())?;
          self.fail_operation(session.operation_id, PackageErrorCode::SignatureInvalid.as_str())?;
          return Err(StorageError::Validation(
            "publisher public key does not match manifest fingerprint".into(),
          ));
        }
        (PublisherDecision::UserApproved, public_key_hex.clone(), true)
      }
      (PublisherTrustState::Unknown, None, true, None) => {
        self.quarantine_path(&session.staging_dir, PackageErrorCode::PublisherUnknown.as_str())?;
        self.fail_operation(session.operation_id, PackageErrorCode::PublisherUnknown.as_str())?;
        return Err(StorageError::Validation(
          "approve_publisher requires publisher_public_key_hex for unknown publishers".into(),
        ));
      }
      _ => {
        self.quarantine_path(&session.staging_dir, PackageErrorCode::PublisherUnknown.as_str())?;
        self.fail_operation(session.operation_id, PackageErrorCode::PublisherUnknown.as_str())?;
        return Err(PackageVerifyError::new(PackageErrorCode::PublisherUnknown, "publisher is not trusted").into());
      }
    };

    // Full signature verification with trusted key before DB commit (always fail closed).
    let staged_bytes = read_file_bounded(&staged_package, PACKAGE_ARCHIVE_MAX_BYTES).map_err(StorageError::from)?;
    let verified = match verify_package_bytes(&staged_bytes, &public_key_hex) {
      Ok(v) => v,
      Err(err) => {
        self.quarantine_path(&session.staging_dir, err.code.as_str())?;
        self.fail_operation(session.operation_id, err.code.as_str())?;
        return Err(err.into());
      }
    };

    let permission_request_digest = compute_permission_request_digest(&verified.manifest);
    let approval_id = new_id();
    let installed_at = now_rfc3339();
    let manifest_json = serde_json::to_string(&verified.manifest)?;

    #[cfg(test)]
    if self.take_install_fault(InstallFaultPoint::AfterVerifiedBeforeDbCommit) {
      return Err(StorageError::Internal(
        "injected fault after verified before db commit".into(),
      ));
    }

    // Persist metadata then finalize store.
    let approval_revision = self.db.transaction(|uow| {
      if register_user_publisher {
        let now = now_rfc3339();
        plugin_publishers::insert(
          uow.conn(),
          &PluginPublisher {
            key_id: verified.manifest.publisher.key_id.clone(),
            fingerprint: verified.manifest.publisher.key_fingerprint.clone(),
            public_key_hex: public_key_hex.clone(),
            source: PublisherSource::UserApproved,
            enabled: true,
            revoked: false,
            created_at: now.clone(),
            updated_at: now,
          },
        )?;
      }
      let publisher = plugin_publishers::get(uow.conn(), &verified.manifest.publisher.key_id)?;
      if publisher.revoked {
        return Err(PackageVerifyError::new(PackageErrorCode::PublisherRevoked, "publisher revoked").into());
      }
      if !publisher.enabled {
        return Err(PackageVerifyError::new(PackageErrorCode::PublisherDisabled, "publisher disabled").into());
      }

      if installed_plugin_versions::get_optional(uow.conn(), &verified.package_digest)?.is_none() {
        installed_plugin_versions::insert(
          uow.conn(),
          &InstalledPluginVersion {
            package_digest: verified.package_digest.clone(),
            plugin_id: verified.manifest.id.clone(),
            version: verified.manifest.version.clone(),
            publisher_key_id: verified.manifest.publisher.key_id.clone(),
            publisher_fingerprint: verified.manifest.publisher.key_fingerprint.clone(),
            runtime_kind: runtime_kind_storage(verified.manifest.runtime.kind).to_string(),
            manifest_json: manifest_json.clone(),
            permission_request_digest: permission_request_digest.clone(),
            content_available: false, // set true after finalize
            installed_at: installed_at.clone(),
          },
        )?;
      }

      let revision = plugin_package_approvals::next_revision(uow.conn(), &verified.package_digest)?;
      plugin_package_approvals::insert(
        uow.conn(),
        &PluginPackageApproval {
          id: approval_id,
          package_digest: verified.package_digest.clone(),
          revision,
          publisher_key_id: verified.manifest.publisher.key_id.clone(),
          publisher_decision,
          permission_request_digest: permission_request_digest.clone(),
          approved_at: installed_at.clone(),
        },
      )?;

      if input.set_as_default {
        // Temporarily allow default only after content is available; set after finalize.
      }

      plugin_install_operations::mark_db_committed(uow.conn(), session.operation_id)?;
      Ok(revision)
    })?;

    #[cfg(test)]
    if self.take_install_fault(InstallFaultPoint::AfterDbCommitBeforeRename) {
      return Err(StorageError::Internal("injected fault after db_committed".into()));
    }

    if let Err(err) = self.atomic_install_from_staging(&session.staging_dir, &verified.package_digest) {
      // Leave db_committed for recovery; mark content unavailable; quarantine partial target.
      self.quarantine_path(&self.store_package_dir(&verified.package_digest), "rename_failed")?;
      self.db.transaction(|uow| {
        installed_plugin_versions::set_content_available(uow.conn(), &verified.package_digest, false)?;
        Ok(())
      })?;
      return Err(err);
    }

    #[cfg(test)]
    if self.take_install_fault(InstallFaultPoint::AfterRenameBeforePostVerify) {
      return Err(StorageError::Internal("injected fault after rename".into()));
    }

    // Never mark content_available without full archive+index re-verification after rename.
    if let Err(err) = self.verify_dest_against_digest(
      &self.store_package_dir(&verified.package_digest),
      &verified.package_digest,
      &public_key_hex,
    ) {
      self.quarantine_path(
        &self.store_package_dir(&verified.package_digest),
        "post_install_unverified",
      )?;
      self.db.transaction(|uow| {
        installed_plugin_versions::set_content_available(uow.conn(), &verified.package_digest, false)?;
        plugin_install_operations::mark_failed(uow.conn(), session.operation_id, "content_unverified")?;
        Ok(())
      })?;
      return Err(err);
    }

    #[cfg(test)]
    if self.take_install_fault(InstallFaultPoint::AfterPostVerifyBeforeFinalize) {
      return Err(StorageError::Internal("injected fault after post-rename verify".into()));
    }

    // set_as_default rejected for revoked/disabled publishers (backend authority).
    let allow_default = input.set_as_default
      && matches!(
        publisher_decision,
        PublisherDecision::TrustedVendor | PublisherDecision::UserApproved | PublisherDecision::AlreadyTrusted
      );

    self.db.transaction(|uow| {
      plugin_install_operations::mark_finalized(uow.conn(), session.operation_id)?;
      installed_plugin_versions::set_content_available(uow.conn(), &verified.package_digest, true)?;
      if allow_default {
        let publisher = plugin_publishers::get(uow.conn(), &verified.manifest.publisher.key_id)?;
        if publisher.revoked || !publisher.enabled {
          return Err(StorageError::Validation(
            "cannot set default: publisher is revoked or disabled".into(),
          ));
        }
        installed_plugin_versions::set_default(uow.conn(), &verified.manifest.id, &verified.package_digest)?;
      }
      Ok(())
    })?;

    let version = self.to_version_dto(
      &self
        .db
        .read(|conn| installed_plugin_versions::get(conn, &verified.package_digest))?,
    )?;
    Ok(ApprovePluginPackageResult {
      version,
      approval_id: approval_id.to_string(),
      approval_revision,
    })
  }

  fn atomic_install_from_staging(&self, staging_dir: &Path, digest: &str) -> Result<(), StorageError> {
    let dest = self.store_package_dir(digest);
    if dest.join("package.lnplugin").is_file() && dest.join("content").is_dir() {
      // Idempotent only when a complete target already exists.
      self.remove_path(staging_dir)?;
      return Ok(());
    }
    if let Some(parent) = dest.parent() {
      std::fs::create_dir_all(parent)?;
    }
    if dest.exists() {
      // Incomplete prior target must not be treated as finalized; quarantine it.
      self.quarantine_path(&dest, "incomplete_store_target")?;
    }
    // Same-filesystem atomic rename of the operation directory (archive + content).
    // No recursive-copy fallback — cross-device or partial copies fail closed.
    std::fs::rename(staging_dir, &dest).map_err(|err| {
      StorageError::Internal(format!(
        "atomic rename staging→store failed for {digest} (same-filesystem required): {err}"
      ))
    })?;
    if !dest.join("package.lnplugin").is_file() || !dest.join("content").is_dir() {
      self.quarantine_path(&dest, "partial_rename")?;
      return Err(StorageError::Internal(format!(
        "store install incomplete after rename for {digest}"
      )));
    }
    set_readonly(&dest.join("package.lnplugin"));
    Ok(())
  }

  pub fn list_versions(&self) -> Result<Vec<InstalledPluginVersionDto>, StorageError> {
    let versions = self.db.read(installed_plugin_versions::list)?;
    let mut out = Vec::with_capacity(versions.len());
    for version in versions {
      out.push(self.to_version_dto(&version)?);
    }
    Ok(out)
  }

  pub fn set_default(&self, plugin_id: &str, package_digest: &str) -> Result<PluginDefaultVersion, StorageError> {
    // Revoked/disabled publisher cannot become default (backend authority).
    let version = self
      .db
      .read(|conn| installed_plugin_versions::get(conn, package_digest))?;
    if version.plugin_id != plugin_id {
      return Err(StorageError::Validation(format!(
        "package {package_digest} does not belong to plugin {plugin_id}"
      )));
    }
    let publisher = self
      .db
      .read(|conn| plugin_publishers::get(conn, &version.publisher_key_id))?;
    if publisher.revoked {
      return Err(StorageError::Validation(
        "cannot set default: publisher is revoked".into(),
      ));
    }
    if !publisher.enabled {
      return Err(StorageError::Validation(
        "cannot set default: publisher is disabled".into(),
      ));
    }
    if !version.content_available {
      return Err(StorageError::PluginUnavailable(format!(
        "package {package_digest} content is unavailable"
      )));
    }
    self
      .db
      .transaction(|uow| installed_plugin_versions::set_default(uow.conn(), plugin_id, package_digest))
  }

  pub fn list_publishers(&self) -> Result<Vec<PluginPublisherDto>, StorageError> {
    let rows = self.db.read(plugin_publishers::list)?;
    Ok(rows.iter().map(PluginPublisherDto::from).collect())
  }

  pub fn approve_user_publisher(&self, input: ApproveUserPublisherInput) -> Result<PluginPublisherDto, StorageError> {
    let (key_id, fingerprint, public_key_hex) = crate::domain::plugin_package::validate_publisher_identity(
      &input.key_id,
      &input.fingerprint,
      &input.public_key_hex,
    )
    .map_err(StorageError::Validation)?;
    let now = now_rfc3339();
    let publisher = PluginPublisher {
      key_id: key_id.as_str().to_string(),
      fingerprint: fingerprint.as_str().to_string(),
      public_key_hex,
      source: PublisherSource::UserApproved,
      enabled: true,
      revoked: false,
      created_at: now.clone(),
      updated_at: now,
    };
    self.db.transaction(|uow| {
      if let Some(existing) = plugin_publishers::get_optional(uow.conn(), publisher.key_id.as_str())? {
        if existing.source == PublisherSource::Vendor {
          return Err(StorageError::Conflict(format!(
            "publisher {} is a vendor key",
            existing.key_id
          )));
        }
        // Re-enable if previously revoked/disabled only when fingerprint matches.
        if existing.fingerprint != publisher.fingerprint {
          return Err(StorageError::Conflict(format!(
            "publisher {} fingerprint mismatch",
            existing.key_id
          )));
        }
        let updated = plugin_publishers::set_enabled(uow.conn(), &existing.key_id, true)?;
        // Clear revoked if re-approving.
        uow.conn().execute(
          "UPDATE plugin_publishers SET revoked = 0, updated_at = ?2 WHERE key_id = ?1",
          rusqlite::params![existing.key_id, crate::domain::time::now_rfc3339()],
        )?;
        return Ok(PluginPublisherDto::from(&plugin_publishers::get(
          uow.conn(),
          &updated.key_id,
        )?));
      }
      plugin_publishers::insert(uow.conn(), &publisher)?;
      Ok(PluginPublisherDto::from(&publisher))
    })
  }

  pub fn revoke_publisher(&self, key_id: &str) -> Result<PluginPublisherDto, StorageError> {
    self.db.transaction(|uow| {
      let publisher = plugin_publishers::revoke(uow.conn(), key_id)?;
      // Clear defaults for every installed package signed by the revoked publisher so new
      // activations cannot pick them until policy resolution.
      let versions = installed_plugin_versions::list(uow.conn())?;
      for version in versions {
        if version.publisher_key_id == key_id {
          installed_plugin_versions::clear_default_if_matches(uow.conn(), &version.package_digest)?;
        }
      }
      Ok(PluginPublisherDto::from(&publisher))
    })
  }

  pub fn uninstall_version(&self, package_digest: &str) -> Result<(), StorageError> {
    // Crash-safe uninstall with TOCTOU protection:
    // 1) atomic content_available true→false (uninstalling gate)
    // 2) re-check exact-digest deps while gated
    // 3) journal prepared, then move content, then catalog delete
    // Lifecycle preview/apply already rejects content_available=false packages.
    let op_id = new_id();
    self.db.transaction(|uow| {
      let version = installed_plugin_versions::get(uow.conn(), package_digest)?;
      if !version.content_available {
        return Err(StorageError::Conflict(format!(
          "package {package_digest} is already unavailable (uninstalling or incomplete)"
        )));
      }
      // Gate the package before any filesystem mutation so concurrent pins/lifecycle fail closed.
      installed_plugin_versions::compare_and_set_content_available(uow.conn(), package_digest, true, false)?;
      reject_if_package_has_dependencies(uow.conn(), package_digest, &version.plugin_id, &version.version)?;
      plugin_uninstall_operations::insert_prepared(uow.conn(), op_id, package_digest)?;
      Ok(())
    })?;

    let store_dir = self.store_package_dir(package_digest);
    let quarantine_path = if store_dir.exists() {
      match self.quarantine_path_return_dest(&store_dir, "uninstall") {
        Ok(qpath) => {
          if let Err(err) = self.db.transaction(|uow| {
            plugin_uninstall_operations::mark_content_quarantined(uow.conn(), op_id, &qpath.to_string_lossy())?;
            Ok(())
          }) {
            // Journal failed after move: attempt restore; only reopen availability after reverify.
            return Err(self.fail_uninstall_with_restore(
              package_digest,
              op_id,
              Some(&qpath),
              err,
              "quarantine_journal_failed",
            ));
          }
          Some(qpath)
        }
        Err(err) => {
          // Move never happened; content still on disk — safe to reopen availability.
          if let Err(journal_err) = self.db.transaction(|uow| {
            installed_plugin_versions::set_content_available(uow.conn(), package_digest, true)?;
            plugin_uninstall_operations::mark_failed(uow.conn(), op_id, "content_quarantine_failed")?;
            Ok(())
          }) {
            return Err(StorageError::Internal(format!(
              "{err}; quarantine failed and journal reopen also failed: {journal_err}"
            )));
          }
          return Err(err);
        }
      }
    } else {
      None
    };

    #[cfg(test)]
    if self.take_catalog_delete_fault() {
      return Err(self.fail_uninstall_with_restore(
        package_digest,
        op_id,
        quarantine_path.as_deref(),
        StorageError::Internal("injected catalog delete failure".into()),
        "catalog_delete_failed",
      ));
    }

    match self.db.transaction(|uow| {
      // Final dependency re-check while gated and after content move.
      let version = installed_plugin_versions::get(uow.conn(), package_digest)?;
      reject_if_package_has_dependencies(uow.conn(), package_digest, &version.plugin_id, &version.version)?;
      plugin_package_approvals::delete_for_package(uow.conn(), package_digest)?;
      installed_plugin_versions::clear_default_if_matches(uow.conn(), package_digest)?;
      installed_plugin_versions::delete(uow.conn(), package_digest)?;
      plugin_uninstall_operations::mark_catalog_deleted(uow.conn(), op_id)?;
      Ok(())
    }) {
      Ok(()) => {}
      Err(err) => {
        return Err(self.fail_uninstall_with_restore(
          package_digest,
          op_id,
          quarantine_path.as_deref(),
          err,
          "catalog_delete_failed",
        ));
      }
    }

    self.db.transaction(|uow| {
      plugin_uninstall_operations::mark_finalized(uow.conn(), op_id)?;
      Ok(())
    })?;
    Ok(())
  }

  fn restore_package_from_quarantine(&self, package_digest: &str, quarantine_path: &Path) -> Result<(), StorageError> {
    let dest = self.store_package_dir(package_digest);
    if dest.exists() {
      return Ok(());
    }
    if !quarantine_path.exists() {
      return Err(StorageError::Internal(format!(
        "quarantine path missing for package {package_digest}"
      )));
    }
    std::fs::rename(quarantine_path, &dest).map_err(|e| StorageError::Internal(e.to_string()))?;
    Ok(())
  }

  /// Test-only restore fault injection.
  #[cfg(test)]
  pub fn set_restore_fault(&self, fault: Option<UninstallRestoreFault>) {
    *self.restore_fault.lock().unwrap_or_else(|e| e.into_inner()) = fault;
  }

  /// Test-only: force catalog delete to fail after quarantine (exercises restore).
  #[cfg(test)]
  pub fn set_catalog_delete_fault(&self, enabled: bool) {
    *self.catalog_delete_fault.lock().unwrap_or_else(|e| e.into_inner()) = enabled;
  }

  #[cfg(test)]
  fn take_catalog_delete_fault(&self) -> bool {
    let mut guard = self.catalog_delete_fault.lock().unwrap_or_else(|e| e.into_inner());
    if *guard {
      *guard = false;
      true
    } else {
      false
    }
  }

  #[cfg(test)]
  fn take_restore_fault(&self, expected: UninstallRestoreFault) -> bool {
    let mut guard = self.restore_fault.lock().unwrap_or_else(|e| e.into_inner());
    if *guard == Some(expected) {
      *guard = None;
      true
    } else {
      false
    }
  }

  /// Restore store content and re-verify archive digest before reopening availability.
  fn restore_and_reverify_package(&self, package_digest: &str, quarantine_path: &Path) -> Result<(), StorageError> {
    #[cfg(test)]
    if self.take_restore_fault(UninstallRestoreFault::BeforeRestore) {
      return Err(StorageError::Internal("injected restore failure".into()));
    }
    self.restore_package_from_quarantine(package_digest, quarantine_path)?;
    #[cfg(test)]
    if self.take_restore_fault(UninstallRestoreFault::AfterRestoreBeforeRehash) {
      return Err(StorageError::Internal("injected rehash failure".into()));
    }
    let archive = self.package_archive_path(package_digest);
    if !archive.is_file() {
      return Err(StorageError::Internal(format!(
        "restored package archive missing for {package_digest}"
      )));
    }
    let digest = crate::services::plugin_package::hash_file(&archive)
      .map_err(|e| StorageError::Internal(format!("failed to rehash restored package: {}", e.message)))?;
    if digest != package_digest {
      return Err(StorageError::Internal(format!(
        "restored package archive digest mismatch for {package_digest}"
      )));
    }
    Ok(())
  }

  /// On uninstall failure after content may have moved: restore only reopens availability after reverify.
  /// No-quarantine path requires canonical store archive + exact digest before content_available=true.
  fn fail_uninstall_with_restore(
    &self,
    package_digest: &str,
    op_id: Uuid,
    quarantine_path: Option<&Path>,
    primary_err: StorageError,
    failure_code: &str,
  ) -> StorageError {
    let restore_result = match quarantine_path {
      Some(qpath) => self.restore_and_reverify_package(package_digest, qpath),
      None => {
        // No quarantine move happened: only reopen when the store archive is present and matches.
        if self.package_store_archive_matches(package_digest) {
          Ok(())
        } else {
          Err(StorageError::Internal(format!(
            "store archive missing or digest mismatch for {package_digest} (no quarantine path)"
          )))
        }
      }
    };
    match restore_result {
      Ok(()) => {
        #[cfg(test)]
        if self.take_restore_fault(UninstallRestoreFault::AfterRehashBeforeAvailability) {
          return StorageError::Internal(format!(
            "{primary_err}; injected failure after restore/rehash before availability reopen"
          ));
        }
        // Gate availability on a final store reverify (covers no-quarantine and restore paths).
        if !self.package_store_archive_matches(package_digest) {
          let journal = self.db.transaction(|uow| {
            plugin_uninstall_operations::mark_failed(uow.conn(), op_id, &format!("{failure_code}_store_unverified"))?;
            Ok(())
          });
          return match journal {
            Ok(()) => StorageError::Internal(format!(
              "{primary_err}; store archive digest reverify failed before availability reopen"
            )),
            Err(journal_err) => StorageError::Internal(format!(
              "{primary_err}; store reverify failed and journal mark_failed also failed: {journal_err}"
            )),
          };
        }
        let journal = self.db.transaction(|uow| {
          #[cfg(test)]
          if self.take_restore_fault(UninstallRestoreFault::AvailabilityWrite) {
            return Err(StorageError::Internal("injected availability write failure".into()));
          }
          if installed_plugin_versions::get_optional(uow.conn(), package_digest)?.is_some() {
            installed_plugin_versions::set_content_available(uow.conn(), package_digest, true)?;
          }
          #[cfg(test)]
          if self.take_restore_fault(UninstallRestoreFault::MarkFailedWrite) {
            return Err(StorageError::Internal("injected mark_failed write failure".into()));
          }
          // Terminal success state (not failed): excluded from unfinished recovery replay.
          if quarantine_path.is_some() {
            plugin_uninstall_operations::mark_rolled_back(uow.conn(), op_id, failure_code)?;
          } else {
            plugin_uninstall_operations::mark_restored(uow.conn(), op_id, failure_code)?;
          }
          Ok(())
        });
        match journal {
          Ok(()) => primary_err,
          Err(journal_err) => StorageError::Internal(format!(
            "{primary_err}; restore succeeded but journal/availability update failed: {journal_err}"
          )),
        }
      }
      Err(restore_err) => {
        // Never mark content_available=true when restore/reverify failed — leave unavailable + journal.
        let journal = self.db.transaction(|uow| {
          #[cfg(test)]
          if self.take_restore_fault(UninstallRestoreFault::MarkFailedWrite) {
            return Err(StorageError::Internal("injected mark_failed write failure".into()));
          }
          plugin_uninstall_operations::mark_failed(uow.conn(), op_id, &format!("{failure_code}_restore_failed"))?;
          Ok(())
        });
        match journal {
          Ok(()) => StorageError::Internal(format!("{primary_err}; package restore/reverify failed: {restore_err}")),
          Err(journal_err) => StorageError::Internal(format!(
            "{primary_err}; package restore/reverify failed: {restore_err}; journal mark_failed also failed: {journal_err}"
          )),
        }
      }
    }
  }

  pub fn version_dependencies(&self, package_digest: &str) -> Result<PluginVersionDependenciesDto, StorageError> {
    let version = self
      .db
      .read(|conn| installed_plugin_versions::get(conn, package_digest))?;
    let integration_instance_ids = self
      .db
      .read(|conn| installed_plugin_versions::count_integration_users(conn, &version.plugin_id, &version.version))?;
    let is_default = self
      .db
      .read(|conn| installed_plugin_versions::get_default(conn, &version.plugin_id))?
      .is_some_and(|d| d.package_digest == package_digest);
    Ok(PluginVersionDependenciesDto {
      package_digest: package_digest.to_string(),
      integration_instance_ids,
      is_default,
    })
  }

  fn to_version_dto(&self, version: &InstalledPluginVersion) -> Result<InstalledPluginVersionDto, StorageError> {
    let is_default = self
      .db
      .read(|conn| installed_plugin_versions::get_default(conn, &version.plugin_id))?
      .is_some_and(|d| d.package_digest == version.package_digest);
    let users = self
      .db
      .read(|conn| installed_plugin_versions::count_integration_users(conn, &version.plugin_id, &version.version))?;
    let manifest: crate::domain::runtime_plugin::PluginManifestV1 = serde_json::from_str(&version.manifest_json)
      .unwrap_or(crate::domain::runtime_plugin::PluginManifestV1 {
        manifest_version: 1,
        plugin_api_version: "1.0".into(),
        id: version.plugin_id.clone(),
        version: version.version.clone(),
        publisher: crate::domain::runtime_plugin::PublisherDeclaration {
          key_id: version.publisher_key_id.clone(),
          key_fingerprint: version.publisher_fingerprint.clone(),
        },
        runtime: crate::domain::runtime_plugin::RuntimeDescriptor {
          kind: crate::domain::runtime_plugin::RuntimeKind::WasmComponent,
          artifact: None,
        },
        targets: vec![],
        files: vec![],
        capabilities: vec![],
        configuration_schema: None,
        config_schema_version: None,
        credential_slots: vec![],
        permissions: Default::default(),
        ui: Default::default(),
      });
    Ok(InstalledPluginVersionDto {
      package_digest: version.package_digest.clone(),
      plugin_id: version.plugin_id.clone(),
      version: version.version.clone(),
      publisher_key_id: version.publisher_key_id.clone(),
      publisher_fingerprint: version.publisher_fingerprint.clone(),
      runtime_kind: version.runtime_kind.clone(),
      permission_request_digest: version.permission_request_digest.clone(),
      content_available: version.content_available,
      is_default,
      in_use: !users.is_empty() || is_default,
      installed_at: version.installed_at.clone(),
      capabilities: manifest.capabilities.iter().map(|c| c.id.clone()).collect(),
    })
  }

  fn fail_operation(&self, id: Uuid, error_code: &str) -> Result<(), StorageError> {
    self.db.transaction(|uow| {
      plugin_install_operations::mark_failed(uow.conn(), id, error_code)?;
      Ok(())
    })
  }

  /// Move a path into quarantine. Fails closed when the source exists but cannot be moved.
  fn quarantine_path(&self, path: &Path, reason: &str) -> Result<(), StorageError> {
    self.quarantine_path_return_dest(path, reason).map(|_| ())
  }

  /// Move a path into quarantine and return the destination path (for uninstall journal).
  fn quarantine_path_return_dest(&self, path: &Path, reason: &str) -> Result<PathBuf, StorageError> {
    if !path.exists() {
      return Ok(PathBuf::new());
    }
    std::fs::create_dir_all(self.quarantine_root())?;
    let name = path
      .file_name()
      .map(|s| s.to_string_lossy().into_owned())
      .unwrap_or_else(|| "unknown".into());
    let dest = self.quarantine_root().join(format!("{reason}-{name}-{}", new_id()));
    clear_readonly_recursive(path);
    std::fs::rename(path, &dest).map_err(|err| {
      StorageError::Internal(format!(
        "quarantine rename failed for {} → {}: {err}",
        path.display(),
        dest.display()
      ))
    })?;
    Ok(dest)
  }

  fn remove_path(&self, path: &Path) -> Result<(), StorageError> {
    if !path.exists() {
      return Ok(());
    }
    if path.is_dir() {
      clear_readonly_recursive(path);
      std::fs::remove_dir_all(path)?;
    } else {
      let mut perms = std::fs::metadata(path)?.permissions();
      perms.set_readonly(false);
      let _ = std::fs::set_permissions(path, perms);
      std::fs::remove_file(path)?;
    }
    Ok(())
  }
}

fn normalize_network_endpoint(endpoint: &crate::domain::runtime_plugin::NetworkEndpointRequest) -> String {
  let mut origins = endpoint.origins.clone();
  origins.sort();
  let mut methods: Vec<String> = endpoint
    .methods
    .iter()
    .map(|method| {
      serde_json::to_string(method)
        .unwrap_or_else(|_| "\"?\"".into())
        .trim_matches('"')
        .to_string()
    })
    .collect();
  methods.sort();
  format!("{}\u{1f}{}\u{1f}{}", endpoint.id, origins.join(","), methods.join(","))
}

/// Full normalized permission expansion/contraction diff (not just endpoint IDs).
fn diff_permissions(
  previous: &crate::domain::runtime_plugin::PluginManifestV1,
  next: &crate::domain::runtime_plugin::PluginManifestV1,
) -> Vec<String> {
  let mut diffs = Vec::new();

  let prev_nets: std::collections::HashMap<String, String> = previous
    .permissions
    .network
    .iter()
    .map(|e| (e.id.clone(), normalize_network_endpoint(e)))
    .collect();
  let next_nets: std::collections::HashMap<String, String> = next
    .permissions
    .network
    .iter()
    .map(|e| (e.id.clone(), normalize_network_endpoint(e)))
    .collect();

  for (id, next_norm) in &next_nets {
    match prev_nets.get(id) {
      None => diffs.push(format!("network:+{id}")),
      Some(prev_norm) if prev_norm != next_norm => {
        diffs.push(format!("network:~{id}"));
      }
      Some(_) => {}
    }
  }
  for id in prev_nets.keys() {
    if !next_nets.contains_key(id) {
      diffs.push(format!("network:-{id}"));
    }
  }

  let prev_auth: std::collections::HashSet<String> = previous.permissions.auth_policies.iter().cloned().collect();
  let next_auth: std::collections::HashSet<String> = next.permissions.auth_policies.iter().cloned().collect();
  for id in next_auth.difference(&prev_auth) {
    diffs.push(format!("auth:+{id}"));
  }
  for id in prev_auth.difference(&next_auth) {
    diffs.push(format!("auth:-{id}"));
  }

  let prev_caps: std::collections::HashSet<String> = previous.capabilities.iter().map(|c| c.id.clone()).collect();
  let next_caps: std::collections::HashSet<String> = next.capabilities.iter().map(|c| c.id.clone()).collect();
  for id in next_caps.difference(&prev_caps) {
    diffs.push(format!("capability:+{id}"));
  }
  for id in prev_caps.difference(&next_caps) {
    diffs.push(format!("capability:-{id}"));
  }

  diffs.sort();
  diffs
}

fn now_unix() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

fn unix_to_rfc3339(secs: u64) -> String {
  let dt = OffsetDateTime::from_unix_timestamp(secs as i64).unwrap_or(OffsetDateTime::UNIX_EPOCH);
  dt.format(&time::format_description::well_known::Rfc3339)
    .unwrap_or_else(|_| now_rfc3339())
}

fn clear_readonly_recursive(path: &Path) {
  let Ok(entries) = std::fs::read_dir(path) else {
    return;
  };
  for entry in entries.flatten() {
    let p = entry.path();
    if p.is_dir() {
      clear_readonly_recursive(&p);
    }
    if let Ok(meta) = std::fs::metadata(&p) {
      let mut perms = meta.permissions();
      perms.set_readonly(false);
      let _ = std::fs::set_permissions(&p, perms);
    }
  }
  if let Ok(meta) = std::fs::metadata(path) {
    let mut perms = meta.permissions();
    perms.set_readonly(false);
    let _ = std::fs::set_permissions(path, perms);
  }
}

fn reject_if_package_has_dependencies(
  conn: &rusqlite::Connection,
  package_digest: &str,
  plugin_id: &str,
  version: &str,
) -> Result<(), StorageError> {
  let pin_users = integration_instances::list_by_package_digest(conn, package_digest)?;
  let grant_count = crate::repositories::plugin_permission_grants::count_for_package(conn, package_digest)?;
  let snapshot_ref =
    crate::repositories::plugin_upgrade_snapshots::package_referenced_by_snapshot(conn, package_digest)?;
  let users = installed_plugin_versions::count_integration_users(conn, plugin_id, version)?;
  let is_default =
    installed_plugin_versions::get_default(conn, plugin_id)?.is_some_and(|d| d.package_digest == package_digest);
  if !pin_users.is_empty() || grant_count > 0 || snapshot_ref || !users.is_empty() || is_default {
    return Err(StorageError::InUse(format!(
      "package {package_digest} is in use (pins={}, grants={grant_count}, snapshots={snapshot_ref}, instances={}, is_default={is_default})",
      pin_users.len(),
      users.len()
    )));
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::plugin_package::{encode_lowercase_hex, sha256_hex};
  use crate::domain::runtime_plugin::{
    HttpMethod, MANIFEST_FILE_PATH, NetworkEndpointRequest, PermissionRequests, SIGNATURE_FILE_PATH,
  };
  use crate::services::plugin_package::test_support::{
    sample_manifest, test_fingerprint, test_public_key_hex, valid_signed_package,
  };
  use crate::services::vendor_trust::test_vendor_fixture::{
    fixture_vendor_fingerprint, fixture_vendor_public_key, fixture_vendor_public_key_hex, fixture_vendor_signing_key,
  };
  use crate::storage::Database;
  use ed25519_dalek::{Signer, SigningKey};
  use std::io::Write;
  use std::time::Duration;

  fn setup() -> (tempfile::TempDir, PluginPackageService) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    // Production constructor has empty vendor roots; inject fixture vendor key for tests only.
    let service =
      PluginPackageService::with_vendor_roots(db, dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
    let publishers = service.list_publishers().unwrap();
    assert!(
      publishers
        .iter()
        .any(|p| p.key_id == VENDOR_PUBLISHER_KEY_ID && p.source == PublisherSource::Vendor),
      "test-injected vendor root must be present"
    );
    service
      .approve_user_publisher(ApproveUserPublisherInput {
        key_id: "com.example.keys.1".into(),
        fingerprint: test_fingerprint(),
        public_key_hex: test_public_key_hex(),
      })
      .unwrap();
    (dir, service)
  }

  fn setup_without_vendor() -> (tempfile::TempDir, PluginPackageService) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let service = PluginPackageService::with_vendor_roots(db, dir.path().to_path_buf(), vec![]);
    assert!(
      service
        .list_publishers()
        .unwrap()
        .iter()
        .all(|p| p.source != PublisherSource::Vendor),
      "production-empty vendor roots must not invent vendor trust"
    );
    (dir, service)
  }

  fn install_valid(
    service: &PluginPackageService,
    dir: &Path,
    set_default: bool,
  ) -> (String, ApprovePluginPackageResult) {
    let (pkg, digest) = valid_signed_package();
    let src = dir.join("sample.lnplugin");
    std::fs::write(&src, &pkg).unwrap();
    let preview = service.preview_package(&src).unwrap();
    let result = service
      .approve_package(ApprovePluginPackageInput {
        preview_id: preview.preview_id,
        approve_publisher: false,
        publisher_public_key_hex: None,
        acknowledge_permissions: true,
        set_as_default: set_default,
      })
      .unwrap();
    (digest, result)
  }

  fn build_vendor_signed_package() -> (Vec<u8>, String) {
    let sk = fixture_vendor_signing_key();
    let wasm = b"\0asm\x01\x00\x00\x00";
    let mut manifest = sample_manifest(wasm);
    manifest.publisher.key_id = VENDOR_PUBLISHER_KEY_ID.into();
    manifest.publisher.key_fingerprint = fixture_vendor_fingerprint();
    let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    let signature = sk.sign(&manifest_bytes).to_bytes().to_vec();
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
      let mut zip = zip::ZipWriter::new(&mut cursor);
      let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
      zip.start_file(MANIFEST_FILE_PATH, options).unwrap();
      zip.write_all(&manifest_bytes).unwrap();
      zip.start_file("artifacts/plugin.wasm", options).unwrap();
      zip.write_all(wasm).unwrap();
      zip.start_file(SIGNATURE_FILE_PATH, options).unwrap();
      zip.write_all(&signature).unwrap();
      zip.finish().unwrap();
    }
    let pkg = cursor.into_inner();
    let digest = crate::services::plugin_package::hash_archive_bytes(&pkg);
    (pkg, digest)
  }

  #[test]
  fn production_constructor_does_not_seed_fabricated_vendor_root() {
    let (dir, service) = setup_without_vendor();
    assert!(service.list_publishers().unwrap().is_empty());
    let db2 = Database::new(dir.path().join("prod")).unwrap();
    db2.initialize().unwrap();
    let prod = PluginPackageService::new(db2, dir.path().join("prod"));
    assert!(
      prod.list_publishers().unwrap().is_empty(),
      "default production load must not trust fabricated vendor keys"
    );
  }

  #[test]
  fn preview_approve_list_default_uninstall() {
    let (dir, service) = setup();
    let (digest, result) = install_valid(&service, dir.path(), true);
    assert_eq!(result.version.package_digest, digest);
    assert!(result.version.is_default);
    assert!(result.version.content_available);
    assert_eq!(service.list_versions().unwrap().len(), 1);
    assert!(service.store_package_dir(&digest).join("package.lnplugin").is_file());
    assert!(service.store_package_dir(&digest).join("content").is_dir());

    let err = service.uninstall_version(&digest).unwrap_err();
    assert!(matches!(err, StorageError::InUse(_)));

    service
      .db
      .transaction(|uow| {
        installed_plugin_versions::clear_default_if_matches(uow.conn(), &digest)?;
        Ok(())
      })
      .unwrap();
    service.uninstall_version(&digest).unwrap();
    assert!(service.list_versions().unwrap().is_empty());
    assert!(!service.store_package_dir(&digest).exists());
  }

  #[test]
  fn package_approval_cannot_satisfy_execution_grant_lookup() {
    let (dir, service) = setup();
    let (_digest, result) = install_valid(&service, dir.path(), false);
    let approval_id = Uuid::parse_str(&result.approval_id).unwrap();
    let grant = service
      .db
      .read(|conn| plugin_package_approvals::get_execution_grant_set(conn, approval_id))
      .unwrap();
    assert!(grant.is_none());
  }

  #[test]
  fn crash_recovery_prepared_verified_db_committed_partial_and_quarantine() {
    let (dir, service) = setup();
    let (pkg, digest) = valid_signed_package();
    let src = dir.path().join("sample.lnplugin");
    std::fs::write(&src, &pkg).unwrap();

    let prepared_id = new_id();
    let prepared_staging = service.staging_root().join(prepared_id.to_string());
    std::fs::create_dir_all(&prepared_staging).unwrap();
    std::fs::write(prepared_staging.join("package.lnplugin"), &pkg).unwrap();
    service
      .db
      .transaction(|uow| {
        plugin_install_operations::insert_prepared(uow.conn(), prepared_id, &prepared_staging.to_string_lossy())?;
        Ok(())
      })
      .unwrap();

    let verified_id = new_id();
    let verified_staging = service.staging_root().join(verified_id.to_string());
    std::fs::create_dir_all(&verified_staging).unwrap();
    std::fs::write(verified_staging.join("package.lnplugin"), &pkg).unwrap();
    service
      .db
      .transaction(|uow| {
        plugin_install_operations::insert_prepared(uow.conn(), verified_id, &verified_staging.to_string_lossy())?;
        plugin_install_operations::mark_verified(uow.conn(), verified_id, &digest)?;
        Ok(())
      })
      .unwrap();

    service.recover_install_operations().unwrap();
    assert!(!prepared_staging.exists());
    assert!(!verified_staging.exists());
    assert_eq!(
      service
        .db
        .read(|conn| plugin_install_operations::get(conn, prepared_id))
        .unwrap()
        .state,
      InstallOperationState::Failed
    );
    assert_eq!(
      service
        .db
        .read(|conn| plugin_install_operations::get(conn, verified_id))
        .unwrap()
        .state,
      InstallOperationState::Failed
    );

    let preview = service.preview_package(&src).unwrap();
    let result = service
      .approve_package(ApprovePluginPackageInput {
        preview_id: preview.preview_id,
        approve_publisher: false,
        publisher_public_key_hex: None,
        acknowledge_permissions: true,
        set_as_default: false,
      })
      .unwrap();
    assert_eq!(result.version.package_digest, digest);

    let store = service.store_package_dir(&digest);
    let aside = dir.path().join("aside-complete");
    std::fs::rename(&store, &aside).unwrap();
    let op_id = new_id();
    let staging = service.staging_root().join(op_id.to_string());
    std::fs::create_dir_all(service.staging_root()).unwrap();
    std::fs::rename(&aside, &staging).unwrap();
    service
      .db
      .transaction(|uow| {
        installed_plugin_versions::set_content_available(uow.conn(), &digest, false)?;
        plugin_install_operations::insert_prepared(uow.conn(), op_id, &staging.to_string_lossy())?;
        plugin_install_operations::mark_verified(uow.conn(), op_id, &digest)?;
        plugin_install_operations::mark_db_committed(uow.conn(), op_id)?;
        Ok(())
      })
      .unwrap();

    service.recover_install_operations().unwrap();
    let version = service
      .db
      .read(|conn| installed_plugin_versions::get(conn, &digest))
      .unwrap();
    assert!(version.content_available);

    let store = service.store_package_dir(&digest);
    let content = store.join("content");
    clear_readonly_recursive(&content);
    std::fs::remove_dir_all(&content).unwrap();
    service
      .db
      .transaction(|uow| {
        installed_plugin_versions::set_content_available(uow.conn(), &digest, true)?;
        let op_id = new_id();
        let staging = service.staging_root().join(op_id.to_string());
        plugin_install_operations::insert_prepared(uow.conn(), op_id, &staging.to_string_lossy())?;
        plugin_install_operations::mark_verified(uow.conn(), op_id, &digest)?;
        plugin_install_operations::mark_db_committed(uow.conn(), op_id)?;
        Ok(())
      })
      .unwrap();
    service.recover_install_operations().unwrap();
    let version = service
      .db
      .read(|conn| installed_plugin_versions::get(conn, &digest))
      .unwrap();
    assert!(
      !version.content_available,
      "partial store must not be content_available"
    );
  }

  #[test]
  fn install_fault_injection_leaves_no_or_complete_install() {
    let (dir, service) = setup();
    let (pkg, digest) = valid_signed_package();
    let src = dir.path().join("sample.lnplugin");
    std::fs::write(&src, &pkg).unwrap();

    for fault in [
      InstallFaultPoint::AfterVerifiedBeforeDbCommit,
      InstallFaultPoint::AfterDbCommitBeforeRename,
      InstallFaultPoint::AfterRenameBeforePostVerify,
      InstallFaultPoint::AfterPostVerifyBeforeFinalize,
    ] {
      let _ = service.db.transaction(|uow| {
        if installed_plugin_versions::get_optional(uow.conn(), &digest)?.is_some() {
          plugin_package_approvals::delete_for_package(uow.conn(), &digest)?;
          installed_plugin_versions::clear_default_if_matches(uow.conn(), &digest)?;
          installed_plugin_versions::delete(uow.conn(), &digest)?;
        }
        Ok(())
      });
      let _ = service.remove_path(&service.store_package_dir(&digest));

      service.set_install_fault(Some(fault));
      let preview = service.preview_package(&src).unwrap();
      let err = service
        .approve_package(ApprovePluginPackageInput {
          preview_id: preview.preview_id,
          approve_publisher: false,
          publisher_public_key_hex: None,
          acknowledge_permissions: true,
          set_as_default: false,
        })
        .unwrap_err();
      assert!(matches!(err, StorageError::Internal(_)), "fault {fault:?}");

      service.recover_install_operations().unwrap();
      let version = service
        .db
        .read(|conn| installed_plugin_versions::get_optional(conn, &digest))
        .unwrap();
      match version {
        None => {
          assert!(
            !service.store_package_dir(&digest).exists(),
            "no catalog ⇒ no store for {fault:?}"
          );
        }
        Some(v) => {
          if v.content_available {
            assert!(
              service.store_package_dir(&digest).join("package.lnplugin").is_file()
                && service.store_package_dir(&digest).join("content").is_dir(),
              "available requires complete store for {fault:?}"
            );
          } else {
            // Incomplete install kept unavailable.
            let complete = service.store_package_dir(&digest).join("package.lnplugin").is_file()
              && service.store_package_dir(&digest).join("content").is_dir()
              && service
                .verify_dest_against_digest(&service.store_package_dir(&digest), &digest, &test_public_key_hex())
                .is_ok();
            assert!(!complete, "unavailable install must not verify complete for {fault:?}");
          }
        }
      }
    }

    let (digest2, result) = install_valid(&service, dir.path(), false);
    assert_eq!(digest2, digest);
    assert!(result.version.content_available);
  }

  #[test]
  fn discard_and_failed_preview_quarantine_staging() {
    let (dir, service) = setup();
    let (pkg, _) = valid_signed_package();
    let src = dir.path().join("sample.lnplugin");
    std::fs::write(&src, &pkg).unwrap();
    let preview = service.preview_package(&src).unwrap();
    assert!(service.staging_root().read_dir().unwrap().next().is_some());
    service.discard_preview(&preview.preview_id).unwrap();
    let live: Vec<_> = std::fs::read_dir(service.staging_root())
      .into_iter()
      .flatten()
      .flatten()
      .collect();
    assert!(live.is_empty(), "discard must clear staging");
    assert!(
      service.quarantine_root().read_dir().unwrap().next().is_some(),
      "discard should quarantine"
    );
  }

  #[test]
  fn preview_ttl_expires_without_subsequent_preview() {
    let (dir, service) = setup();
    let (pkg, _) = valid_signed_package();
    let src = dir.path().join("sample.lnplugin");
    std::fs::write(&src, &pkg).unwrap();
    let preview = service.preview_package(&src).unwrap();
    {
      let mut previews = service.previews.lock().unwrap();
      let id = Uuid::parse_str(&preview.preview_id).unwrap();
      let session = previews.get_mut(&id).unwrap();
      session.expires_at_unix = now_unix().saturating_sub(1);
    }
    service.expire_stale_previews().unwrap();
    let live: Vec<_> = std::fs::read_dir(service.staging_root())
      .into_iter()
      .flatten()
      .flatten()
      .collect();
    assert!(
      live.is_empty(),
      "TTL expiry must quarantine staging without a later preview"
    );
    let err = service
      .approve_package(ApprovePluginPackageInput {
        preview_id: preview.preview_id,
        approve_publisher: false,
        publisher_public_key_hex: None,
        acknowledge_permissions: true,
        set_as_default: false,
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::Capability { .. }));
  }

  #[test]
  fn staging_sweep_handle_stops() {
    let (_dir, service) = setup();
    let handle = service.start_staging_sweep();
    std::thread::sleep(Duration::from_millis(50));
    handle.stop();
  }

  #[test]
  fn revoke_publisher_clears_default_and_blocks_set_default() {
    let (dir, service) = setup();
    let (digest, _) = install_valid(&service, dir.path(), true);
    assert!(service.list_versions().unwrap()[0].is_default);
    service.revoke_publisher("com.example.keys.1").unwrap();
    assert!(!service.list_versions().unwrap()[0].is_default);
    let err = service.set_default("com.example.translate", &digest).unwrap_err();
    assert!(matches!(err, StorageError::Validation(_)));
  }

  #[test]
  fn preview_dto_is_sanitized_and_opaque() {
    let (dir, service) = setup();
    let (pkg, digest) = valid_signed_package();
    let src = dir.path().join("sample.lnplugin");
    std::fs::write(&src, &pkg).unwrap();
    let preview = service.preview_package(&src).unwrap();
    assert_eq!(preview.package_digest, digest);
    assert!(!preview.preview_id.contains('/') && !preview.preview_id.contains('\\'));
    let json = serde_json::to_string(&preview).unwrap();
    assert!(!json.contains(dir.path().to_string_lossy().as_ref()));
    assert!(!json.contains("package.lnplugin"));
  }

  #[test]
  fn unknown_publisher_requires_key_and_ed25519_on_approve() {
    let (dir, service) = setup();
    let alt_key = SigningKey::from_bytes(&[11u8; 32]);
    let public_hex = encode_lowercase_hex(&alt_key.verifying_key().to_bytes());
    let fingerprint = sha256_hex(&alt_key.verifying_key().to_bytes());
    let wasm = b"\0asm\x01\x00\x00\x00";
    let mut manifest = sample_manifest(wasm);
    manifest.publisher.key_id = "com.unknown.keys.1".into();
    manifest.publisher.key_fingerprint = fingerprint;
    let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    let signature = alt_key.sign(&manifest_bytes).to_bytes().to_vec();
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
      let mut zip = zip::ZipWriter::new(&mut cursor);
      let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
      zip.start_file(MANIFEST_FILE_PATH, options).unwrap();
      zip.write_all(&manifest_bytes).unwrap();
      zip.start_file("artifacts/plugin.wasm", options).unwrap();
      zip.write_all(wasm).unwrap();
      zip.start_file(SIGNATURE_FILE_PATH, options).unwrap();
      zip.write_all(&signature).unwrap();
      zip.finish().unwrap();
    }
    let pkg = cursor.into_inner();
    let src = dir.path().join("unknown.lnplugin");
    std::fs::write(&src, &pkg).unwrap();
    let preview = service.preview_package(&src).unwrap();
    assert!(preview.requires_publisher_approval);

    let err = service
      .approve_package(ApprovePluginPackageInput {
        preview_id: preview.preview_id.clone(),
        approve_publisher: true,
        publisher_public_key_hex: None,
        acknowledge_permissions: true,
        set_as_default: false,
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::Validation(_)));

    let preview = service.preview_package(&src).unwrap();
    let result = service
      .approve_package(ApprovePluginPackageInput {
        preview_id: preview.preview_id,
        approve_publisher: true,
        publisher_public_key_hex: Some(public_hex),
        acknowledge_permissions: true,
        set_as_default: false,
      })
      .unwrap();
    assert!(result.version.content_available);
  }

  #[test]
  fn vendor_positive_path_uses_test_only_injected_root() {
    let (dir, service) = setup();
    let (pkg, _) = build_vendor_signed_package();
    let src = dir.path().join("vendor.lnplugin");
    std::fs::write(&src, &pkg).unwrap();
    let preview = service.preview_package(&src).unwrap();
    assert!(!preview.requires_publisher_approval);
    assert_eq!(preview.publisher_trust, PublisherTrustState::TrustedVendor);
    assert_eq!(preview.publisher_key_id, VENDOR_PUBLISHER_KEY_ID);
    assert_eq!(preview.publisher_fingerprint, fixture_vendor_fingerprint());
    assert_eq!(fixture_vendor_public_key_hex().len(), 64);
  }

  #[test]
  fn permission_diff_detects_same_id_origin_and_method_expansion() {
    let mut prev = sample_manifest(b"\0asm\x01\x00\x00\x00");
    prev.permissions = PermissionRequests {
      network: vec![NetworkEndpointRequest {
        id: "api".into(),
        origins: vec!["https://a.example".into()],
        methods: vec![HttpMethod::Get],
      }],
      auth_policies: vec!["host.none.v1".into()],
    };
    let mut next = prev.clone();
    next.permissions.network[0].origins.push("https://b.example".into());
    next.permissions.network[0].methods.push(HttpMethod::Post);
    next.permissions.auth_policies.push("host.api-key.header.v1".into());
    next
      .capabilities
      .push(crate::domain::runtime_plugin::CapabilityDeclaration {
        id: "translate.detect@1".into(),
        preferences_schema: None,
      });
    let diffs = diff_permissions(&prev, &next);
    assert!(diffs.iter().any(|d| d == "network:~api"), "{diffs:?}");
    assert!(diffs.iter().any(|d| d == "auth:+host.api-key.header.v1"), "{diffs:?}");
    assert!(diffs.iter().any(|d| d == "capability:+translate.detect@1"), "{diffs:?}");
  }

  #[test]
  fn uninstall_journal_recovers_after_content_quarantined() {
    let (dir, service) = setup();
    let (digest, _) = install_valid(&service, dir.path(), false);
    assert!(service.store_package_dir(&digest).exists());

    let op_id = new_id();
    let store = service.store_package_dir(&digest);
    let qpath = service.quarantine_path_return_dest(&store, "uninstall").unwrap();
    service
      .db
      .transaction(|uow| {
        plugin_uninstall_operations::insert_prepared(uow.conn(), op_id, &digest)?;
        plugin_uninstall_operations::mark_content_quarantined(uow.conn(), op_id, &qpath.to_string_lossy())?;
        Ok(())
      })
      .unwrap();
    assert!(
      service
        .db
        .read(|conn| installed_plugin_versions::get_optional(conn, &digest))
        .unwrap()
        .is_some()
    );
    assert!(!service.store_package_dir(&digest).exists());

    service.recover_install_operations().unwrap();
    assert!(
      service
        .db
        .read(|conn| installed_plugin_versions::get_optional(conn, &digest))
        .unwrap()
        .is_none(),
      "recovery must finish catalog delete"
    );
    let op = service
      .db
      .read(|conn| plugin_uninstall_operations::get(conn, op_id))
      .unwrap();
    assert_eq!(op.state, UninstallOperationState::Finalized);
  }

  #[test]
  fn uninstall_blocks_when_default_or_in_use() {
    let (dir, service) = setup();
    let (digest, _) = install_valid(&service, dir.path(), true);
    let err = service.uninstall_version(&digest).unwrap_err();
    assert!(matches!(err, StorageError::InUse(_)));
  }
}
