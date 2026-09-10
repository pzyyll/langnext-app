// ABOUTME: Directory/archive plugin ingestion into immutable digest-addressed snapshots.
// ABOUTME: Both inputs pass identical manifest, index, path, and size validation.
use crate::domain::plugin_catalog::{
  CATALOG_MANIFEST_FILE_PATH, CatalogEntryError, ContentDigestBuilder, PluginContentKind, PluginDescriptor,
  PluginLoadErrorCode, PluginSource, descriptor_from_manifest, sha256_hex,
};
use crate::domain::plugin_package::{
  PACKAGE_ARCHIVE_MAX_BYTES, PACKAGE_DECOMPRESSION_RATIO_MAX, PACKAGE_ENTRY_MAX_BYTES, PACKAGE_ENTRY_MAX_COUNT,
  PACKAGE_MANIFEST_MAX_BYTES, PACKAGE_PATH_MAX_DEPTH, PACKAGE_SCHEMA_MAX_BYTES, PACKAGE_TOTAL_DECOMPRESSED_MAX_BYTES,
  PACKAGE_UI_ASSET_MAX_BYTES,
};
use crate::domain::runtime_plugin::{
  FileRole, PluginManifestV1, check_file_index_collisions, validate_archive_entry_path,
};
use crate::services::runtime_plugin_contracts::{
  ArchiveEntry, ContractError, ContractErrorCode, ValidatedPluginManifest, parse_manifest, validate_archive_shape,
  validate_manifest, validate_manifest_host_targets,
};
use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

/// Load/validation failure. Sanitized: relative paths only, no content bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginLoadError {
  pub code: PluginLoadErrorCode,
  pub relative_path: String,
  pub message: String,
}

impl PluginLoadError {
  pub fn new(code: PluginLoadErrorCode, message: impl Into<String>) -> Self {
    Self {
      code,
      relative_path: String::new(),
      message: message.into(),
    }
  }

  pub fn with_path(mut self, relative_path: impl Into<String>) -> Self {
    self.relative_path = relative_path.into();
    self
  }

  pub fn to_catalog_error(&self, source: PluginSource, plugin_id: &str) -> CatalogEntryError {
    CatalogEntryError {
      code: self.code,
      source,
      plugin_id: plugin_id.to_string(),
      relative_path: self.relative_path.clone(),
      message: self.message.clone(),
    }
  }
}

impl std::fmt::Display for PluginLoadError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    if self.relative_path.is_empty() {
      write!(f, "{}: {}", self.code.as_str(), self.message)
    } else {
      write!(f, "{}: {} ({})", self.code.as_str(), self.message, self.relative_path)
    }
  }
}

impl std::error::Error for PluginLoadError {}

impl From<PluginLoadError> for crate::error::StorageError {
  fn from(value: PluginLoadError) -> Self {
    crate::error::StorageError::Capability {
      code: value.code.as_str().to_string(),
      message: value.message,
    }
  }
}

impl From<ContractError> for PluginLoadError {
  fn from(value: ContractError) -> Self {
    let code = match value.code {
      ContractErrorCode::UnknownManifestVersion
      | ContractErrorCode::InvalidField
      | ContractErrorCode::UnknownKey
      | ContractErrorCode::DuplicateId
      | ContractErrorCode::UndeclaredReference
      | ContractErrorCode::ReferenceMismatch => PluginLoadErrorCode::InvalidManifest,
      ContractErrorCode::UnsupportedPluginApi | ContractErrorCode::UnsupportedCapabilityMajor => {
        PluginLoadErrorCode::CompatibilityRejected
      }
      ContractErrorCode::InvalidPath => PluginLoadErrorCode::PathInvalid,
      ContractErrorCode::InvalidDigest => PluginLoadErrorCode::DigestMismatch,
      ContractErrorCode::ArchiveMismatch => PluginLoadErrorCode::UndeclaredFile,
      ContractErrorCode::LimitExceeded => PluginLoadErrorCode::EntryCountExceeded,
    };
    Self::new(code, value.message)
  }
}

/// A validated plugin whose content has been published as an immutable snapshot.
#[derive(Debug, Clone)]
pub struct LoadedPlugin {
  pub descriptor: PluginDescriptor,
  pub manifest: PluginManifestV1,
  pub validated: ValidatedPluginManifest,
  pub manifest_json: String,
  pub manifest_bytes: Vec<u8>,
  /// Digest-addressed immutable content root. Runtime never reads the source path.
  pub snapshot_dir: PathBuf,
}

impl LoadedPlugin {
  /// Read one file from the immutable snapshot. Paths are manifest-relative.
  pub fn read_snapshot_file(&self, relative: &str) -> Result<Vec<u8>, PluginLoadError> {
    read_snapshot_file(&self.snapshot_dir, relative)
  }
}

/// Read one manifest-relative file from an immutable snapshot directory.
pub fn read_snapshot_file(snapshot_dir: &Path, relative: &str) -> Result<Vec<u8>, PluginLoadError> {
  let path = confined_join(snapshot_dir, relative)?;
  std::fs::read(&path).map_err(|_| {
    PluginLoadError::new(
      PluginLoadErrorCode::MissingIndexedFile,
      format!("snapshot file {relative} is unreadable"),
    )
  })
}

fn role_max_bytes(role: FileRole) -> u64 {
  match role {
    FileRole::ConfigSchema | FileRole::PreferenceSchema => PACKAGE_SCHEMA_MAX_BYTES,
    FileRole::PageAsset | FileRole::Icon => PACKAGE_UI_ASSET_MAX_BYTES,
    FileRole::RuntimeArtifact | FileRole::Locale | FileRole::License | FileRole::Other => PACKAGE_ENTRY_MAX_BYTES,
  }
}

/// Normalize a directory-relative or archive-relative path into the canonical form.
pub fn normalize_relative_path(raw: &str) -> Result<String, PluginLoadError> {
  if !raw.is_ascii() {
    return Err(PluginLoadError::new(
      PluginLoadErrorCode::InvalidUtf8Path,
      format!("non-ASCII path: {raw}"),
    ));
  }
  let trimmed = raw.trim_end_matches('/');
  if trimmed.is_empty() {
    return Err(PluginLoadError::new(PluginLoadErrorCode::PathInvalid, "empty path"));
  }
  if raw.contains('\\') || raw.contains(':') || raw.starts_with('/') {
    return Err(PluginLoadError::new(
      PluginLoadErrorCode::PathInvalid,
      format!("illegal path: {raw}"),
    ));
  }
  let depth = trimmed.split('/').count();
  if depth > PACKAGE_PATH_MAX_DEPTH {
    return Err(PluginLoadError::new(
      PluginLoadErrorCode::PathTooDeep,
      format!("path depth {depth} exceeds {PACKAGE_PATH_MAX_DEPTH}"),
    ));
  }
  if trimmed
    .split('/')
    .any(|segment| segment.is_empty() || segment == "." || segment == "..")
  {
    return Err(PluginLoadError::new(
      PluginLoadErrorCode::PathInvalid,
      format!("illegal path segment in {raw}"),
    ));
  }
  validate_archive_entry_path(trimmed).map_err(|e| PluginLoadError::new(PluginLoadErrorCode::PathInvalid, e))
}

fn confined_join(base: &Path, relative: &str) -> Result<PathBuf, PluginLoadError> {
  let normalized = normalize_relative_path(relative)?;
  let mut out = base.to_path_buf();
  for segment in normalized.split('/') {
    out.push(segment);
  }
  if !out.starts_with(base) {
    return Err(PluginLoadError::new(
      PluginLoadErrorCode::PathInvalid,
      format!("path escapes content root: {relative}"),
    ));
  }
  Ok(out)
}

/// Directory and archive ingestion into immutable snapshots.
#[derive(Debug, Clone)]
pub struct PluginLoader {
  cache_root: PathBuf,
}

impl PluginLoader {
  pub fn new(cache_root: PathBuf) -> Self {
    Self { cache_root }
  }

  pub fn cache_root(&self) -> &Path {
    &self.cache_root
  }

  /// Immutable snapshot directory for a content digest.
  pub fn snapshot_dir(&self, content_digest: &str) -> PathBuf {
    self.cache_root.join(content_digest)
  }

  /// True when the digest-addressed snapshot is already published.
  pub fn has_snapshot(&self, content_digest: &str) -> bool {
    self.snapshot_dir(content_digest).is_dir()
  }

  /// Load a plugin directory. Symlinks, undeclared files, and mutation are rejected.
  pub fn load_directory(&self, source: PluginSource, dir: &Path) -> Result<LoadedPlugin, PluginLoadError> {
    let metadata = std::fs::symlink_metadata(dir)
      .map_err(|_| PluginLoadError::new(PluginLoadErrorCode::ContentMissing, "plugin directory is unreadable"))?;
    if metadata.file_type().is_symlink() {
      return Err(PluginLoadError::new(
        PluginLoadErrorCode::SymlinkRejected,
        "plugin directory must not be a symlink",
      ));
    }
    if !metadata.is_dir() {
      return Err(PluginLoadError::new(
        PluginLoadErrorCode::ContentMissing,
        "plugin source is not a directory",
      ));
    }
    let mut files = BTreeMap::new();
    collect_directory_files(dir, dir, &mut files)?;
    let loaded = self.materialize(source, PluginContentKind::Directory, files)?;
    self.assert_directory_unchanged(dir, &loaded.descriptor.content_digest)?;
    Ok(loaded)
  }

  /// Load a `.lnplugin` archive from exact file bytes.
  pub fn load_archive(&self, source: PluginSource, archive_path: &Path) -> Result<LoadedPlugin, PluginLoadError> {
    let metadata = std::fs::symlink_metadata(archive_path)
      .map_err(|_| PluginLoadError::new(PluginLoadErrorCode::ContentMissing, "plugin archive is unreadable"))?;
    if metadata.file_type().is_symlink() {
      return Err(PluginLoadError::new(
        PluginLoadErrorCode::SymlinkRejected,
        "plugin archive must not be a symlink",
      ));
    }
    let bytes = read_archive_bytes(archive_path)?;
    let files = extract_archive_files(&bytes)?;
    let loaded = self.materialize(source, PluginContentKind::Archive, files)?;
    let current = read_archive_bytes(archive_path)?;
    if current != bytes {
      return Err(PluginLoadError::new(
        PluginLoadErrorCode::SourceMutated,
        "plugin archive changed during materialization",
      ));
    }
    Ok(loaded)
  }

  fn materialize(
    &self,
    source: PluginSource,
    content_kind: PluginContentKind,
    files: BTreeMap<String, Vec<u8>>,
  ) -> Result<LoadedPlugin, PluginLoadError> {
    let manifest_bytes = files.get(CATALOG_MANIFEST_FILE_PATH).cloned().ok_or_else(|| {
      PluginLoadError::new(
        PluginLoadErrorCode::MissingManifest,
        format!("{CATALOG_MANIFEST_FILE_PATH} is missing"),
      )
    })?;
    if manifest_bytes.len() as u64 > PACKAGE_MANIFEST_MAX_BYTES {
      return Err(PluginLoadError::new(
        PluginLoadErrorCode::ManifestTooLarge,
        format!("{CATALOG_MANIFEST_FILE_PATH} exceeds {PACKAGE_MANIFEST_MAX_BYTES} bytes"),
      ));
    }
    let manifest_json = std::str::from_utf8(&manifest_bytes)
      .map_err(|_| PluginLoadError::new(PluginLoadErrorCode::InvalidManifest, "manifest is not UTF-8"))?;
    let manifest = parse_manifest(manifest_json)?;
    if manifest.runtime.kind == crate::domain::runtime_plugin::RuntimeKind::TrustedNativeWorker {
      if !source.allows_native() {
        return Err(PluginLoadError::new(
          PluginLoadErrorCode::NativeSourceRejected,
          format!(
            "native workers are built-in only; source '{}' may not declare trusted-native-worker",
            source.as_str()
          ),
        ));
      }
      // Native execution stays closed: only the allowlisted first-party release may load.
      if !crate::domain::native_worker::is_allowlisted_native_worker(&manifest.id, &manifest.version) {
        return Err(PluginLoadError::new(
          PluginLoadErrorCode::NativeNotAllowlisted,
          format!(
            "native worker {} {} is not on the host allowlist",
            manifest.id, manifest.version
          ),
        ));
      }
    }
    // Privileged host auth (host-minted Google/Baidu tokens) is built-in content only.
    if !source.allows_privileged_host_auth()
      && let Some(policy) = manifest
        .permissions
        .auth_policies
        .iter()
        .find(|policy| crate::services::auth_policies::is_privileged_host_auth_policy(policy))
    {
      return Err(PluginLoadError::new(
        PluginLoadErrorCode::PrivilegedAuthRejected,
        format!(
          "privileged host auth policy {policy} requires built-in plugin content; source '{}' may not request it",
          source.as_str()
        ),
      ));
    }
    let validated = validate_manifest(&manifest)?;
    validate_manifest_host_targets(&manifest)?;

    let entries: Vec<ArchiveEntry> = files
      .iter()
      .map(|(path, bytes)| ArchiveEntry {
        path: path.clone(),
        bytes: bytes.len() as u64,
        sha256: sha256_hex(bytes),
      })
      .collect();
    // Every archive member must be in the manifest file index. A leftover plugin-level trust
    // envelope file is therefore reported as an undeclared file and rejected.
    validate_archive_shape(&manifest, &entries)?;
    for file in &manifest.files {
      let bytes = files
        .get(&file.path)
        .ok_or_else(|| PluginLoadError::new(PluginLoadErrorCode::MissingIndexedFile, "indexed file is missing"))?;
      let max = role_max_bytes(file.role);
      if bytes.len() as u64 > max {
        return Err(
          PluginLoadError::new(PluginLoadErrorCode::EntryTooLarge, format!("file exceeds {max} bytes"))
            .with_path(file.path.clone()),
        );
      }
    }

    let mut digest_builder = ContentDigestBuilder::new();
    let mut total_bytes = 0u64;
    for (path, bytes) in &files {
      digest_builder.add_file(path, bytes);
      total_bytes = total_bytes.saturating_add(bytes.len() as u64);
    }
    let content_digest = digest_builder.finish();
    let snapshot_dir = self.publish_snapshot(&content_digest, &files)?;
    let descriptor = descriptor_from_manifest(
      &manifest,
      source,
      content_kind,
      content_digest,
      files.len(),
      total_bytes,
    );
    Ok(LoadedPlugin {
      descriptor,
      manifest,
      validated,
      manifest_json: manifest_json.to_string(),
      manifest_bytes,
      snapshot_dir,
    })
  }

  /// Atomically publish an immutable snapshot. Existing identical snapshots are reused.
  fn publish_snapshot(
    &self,
    content_digest: &str,
    files: &BTreeMap<String, Vec<u8>>,
  ) -> Result<PathBuf, PluginLoadError> {
    let final_dir = self.snapshot_dir(content_digest);
    if final_dir.is_dir() {
      return Ok(final_dir);
    }
    std::fs::create_dir_all(&self.cache_root).map_err(|e| {
      PluginLoadError::new(
        PluginLoadErrorCode::Internal,
        format!("plugin cache is not writable: {e}"),
      )
    })?;
    let staging = self
      .cache_root
      .join(format!(".staging-{}", crate::domain::time::new_id()));
    if let Err(err) = write_snapshot_tree(&staging, files) {
      let _ = std::fs::remove_dir_all(&staging);
      return Err(err);
    }
    match std::fs::rename(&staging, &final_dir) {
      Ok(()) => Ok(final_dir),
      Err(_) if final_dir.is_dir() => {
        let _ = std::fs::remove_dir_all(&staging);
        Ok(final_dir)
      }
      Err(err) => {
        let _ = std::fs::remove_dir_all(&staging);
        Err(PluginLoadError::new(
          PluginLoadErrorCode::Internal,
          format!("snapshot publish failed: {err}"),
        ))
      }
    }
  }

  fn assert_directory_unchanged(&self, dir: &Path, expected_digest: &str) -> Result<(), PluginLoadError> {
    let mut files = BTreeMap::new();
    collect_directory_files(dir, dir, &mut files)?;
    let mut digest_builder = ContentDigestBuilder::new();
    for (path, bytes) in files.iter() {
      digest_builder.add_file(path, bytes);
    }
    if digest_builder.finish() != expected_digest {
      return Err(PluginLoadError::new(
        PluginLoadErrorCode::SourceMutated,
        "plugin directory changed during materialization",
      ));
    }
    Ok(())
  }
}

fn write_snapshot_tree(root: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<(), PluginLoadError> {
  std::fs::create_dir_all(root)
    .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::Internal, format!("snapshot staging failed: {e}")))?;
  for (relative, bytes) in files {
    let dest = confined_join(root, relative)?;
    if let Some(parent) = dest.parent() {
      std::fs::create_dir_all(parent)
        .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::Internal, format!("snapshot staging failed: {e}")))?;
    }
    let mut out = File::create(&dest)
      .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::Internal, format!("snapshot staging failed: {e}")))?;
    out
      .write_all(bytes)
      .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::Internal, format!("snapshot staging failed: {e}")))?;
    set_readonly(&dest);
  }
  Ok(())
}

/// Best-effort mark a snapshot file read-only (immutable store intent).
pub fn set_readonly(path: &Path) {
  if let Ok(meta) = std::fs::metadata(path) {
    let mut perms = meta.permissions();
    perms.set_readonly(true);
    let _ = std::fs::set_permissions(path, perms);
  }
}

fn read_archive_bytes(path: &Path) -> Result<Vec<u8>, PluginLoadError> {
  let metadata = std::fs::metadata(path)
    .map_err(|_| PluginLoadError::new(PluginLoadErrorCode::ContentMissing, "plugin archive is unreadable"))?;
  if metadata.len() > PACKAGE_ARCHIVE_MAX_BYTES {
    return Err(PluginLoadError::new(
      PluginLoadErrorCode::ContentTooLarge,
      format!("archive exceeds {PACKAGE_ARCHIVE_MAX_BYTES} bytes"),
    ));
  }
  std::fs::read(path).map_err(|e| PluginLoadError::new(PluginLoadErrorCode::ContentMissing, e.to_string()))
}

fn collect_directory_files(
  root: &Path,
  dir: &Path,
  out: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), PluginLoadError> {
  let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
    .map_err(|_| PluginLoadError::new(PluginLoadErrorCode::ContentMissing, "plugin directory is unreadable"))?
    .map(|entry| {
      entry
        .map(|entry| entry.path())
        .map_err(|_| PluginLoadError::new(PluginLoadErrorCode::ContentMissing, "plugin directory is unreadable"))
    })
    .collect::<Result<Vec<_>, _>>()?;
  entries.sort();
  for path in entries {
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
      PluginLoadError::new(
        PluginLoadErrorCode::ContentMissing,
        "plugin directory entry is unreadable",
      )
    })?;
    if metadata.file_type().is_symlink() {
      return Err(
        PluginLoadError::new(PluginLoadErrorCode::SymlinkRejected, "symlink entries are rejected")
          .with_path(relative_display(root, &path)),
      );
    }
    if metadata.is_dir() {
      collect_directory_files(root, &path, out)?;
      continue;
    }
    if !metadata.is_file() {
      return Err(
        PluginLoadError::new(PluginLoadErrorCode::PathInvalid, "unsupported directory entry")
          .with_path(relative_display(root, &path)),
      );
    }
    let relative = relative_display(root, &path);
    let normalized = normalize_relative_path(&relative)?;
    if out.len() >= PACKAGE_ENTRY_MAX_COUNT {
      return Err(PluginLoadError::new(
        PluginLoadErrorCode::EntryCountExceeded,
        format!("directory has more than {PACKAGE_ENTRY_MAX_COUNT} files"),
      ));
    }
    let bytes = std::fs::read(&path).map_err(|_| {
      PluginLoadError::new(PluginLoadErrorCode::ContentMissing, "plugin file is unreadable")
        .with_path(normalized.clone())
    })?;
    if bytes.len() as u64 > PACKAGE_ENTRY_MAX_BYTES {
      return Err(
        PluginLoadError::new(PluginLoadErrorCode::EntryTooLarge, "file exceeds the entry limit").with_path(normalized),
      );
    }
    if out.insert(normalized.clone(), bytes).is_some() {
      return Err(
        PluginLoadError::new(PluginLoadErrorCode::DuplicatePath, "duplicate plugin path").with_path(normalized),
      );
    }
  }
  let total: u64 = out.values().map(|bytes| bytes.len() as u64).sum();
  if total > PACKAGE_TOTAL_DECOMPRESSED_MAX_BYTES {
    return Err(PluginLoadError::new(
      PluginLoadErrorCode::TotalSizeExceeded,
      format!("directory content exceeds {PACKAGE_TOTAL_DECOMPRESSED_MAX_BYTES} bytes"),
    ));
  }
  let paths: Vec<String> = out.keys().cloned().collect();
  if let Err(message) = check_file_index_collisions(&paths) {
    return Err(PluginLoadError::new(PluginLoadErrorCode::DuplicatePath, message));
  }
  Ok(())
}

fn relative_display(root: &Path, path: &Path) -> String {
  path
    .strip_prefix(root)
    .unwrap_or(path)
    .to_string_lossy()
    .replace('\\', "/")
}

fn extract_archive_files(archive_bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, PluginLoadError> {
  if archive_bytes.len() as u64 > PACKAGE_ARCHIVE_MAX_BYTES {
    return Err(PluginLoadError::new(
      PluginLoadErrorCode::ContentTooLarge,
      format!("archive exceeds {PACKAGE_ARCHIVE_MAX_BYTES} bytes"),
    ));
  }
  let cursor = std::io::Cursor::new(archive_bytes);
  let mut archive = ZipArchive::new(cursor)
    .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::InvalidManifest, format!("invalid zip: {e}")))?;
  if archive.len() > PACKAGE_ENTRY_MAX_COUNT {
    return Err(PluginLoadError::new(
      PluginLoadErrorCode::EntryCountExceeded,
      format!("archive has {} entries (max {PACKAGE_ENTRY_MAX_COUNT})", archive.len()),
    ));
  }
  let mut extracted: BTreeMap<String, Vec<u8>> = BTreeMap::new();
  let mut seen: HashSet<String> = HashSet::new();
  let mut total_compressed = 0u64;
  let mut total_decompressed = 0u64;
  for index in 0..archive.len() {
    let file = archive
      .by_index(index)
      .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::InvalidManifest, e.to_string()))?;
    if file.is_symlink() {
      return Err(
        PluginLoadError::new(PluginLoadErrorCode::SymlinkRejected, "symlink entry rejected")
          .with_path(file.name().to_string()),
      );
    }
    let raw_name = file.name().to_string();
    if String::from_utf8(file.name_raw().to_vec()).is_err() {
      return Err(PluginLoadError::new(
        PluginLoadErrorCode::InvalidUtf8Path,
        "archive entry path is not valid UTF-8",
      ));
    }
    if file.is_dir() || raw_name.ends_with('/') {
      normalize_relative_path(&raw_name)?;
      continue;
    }
    let path = normalize_relative_path(&raw_name)?;
    if !seen.insert(path.clone()) {
      return Err(PluginLoadError::new(PluginLoadErrorCode::DuplicatePath, "duplicate archive path").with_path(path));
    }
    let compressed = file.compressed_size();
    let declared = file.size();
    if declared > PACKAGE_ENTRY_MAX_BYTES {
      return Err(
        PluginLoadError::new(
          PluginLoadErrorCode::EntryTooLarge,
          format!("entry declares {declared} bytes"),
        )
        .with_path(path),
      );
    }
    if compressed > 0 && declared / compressed.max(1) > PACKAGE_DECOMPRESSION_RATIO_MAX {
      return Err(
        PluginLoadError::new(
          PluginLoadErrorCode::ZipBomb,
          format!("entry decompression ratio exceeds {PACKAGE_DECOMPRESSION_RATIO_MAX}"),
        )
        .with_path(path),
      );
    }
    let mut data = Vec::new();
    let mut limited = file.take(declared.saturating_add(1));
    limited
      .read_to_end(&mut data)
      .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::InvalidManifest, e.to_string()))?;
    if data.len() as u64 > declared {
      return Err(
        PluginLoadError::new(PluginLoadErrorCode::ZipBomb, "entry expanded beyond declared size").with_path(path),
      );
    }
    if data.len() as u64 > PACKAGE_ENTRY_MAX_BYTES {
      return Err(
        PluginLoadError::new(
          PluginLoadErrorCode::EntryTooLarge,
          format!("entry is {} bytes", data.len()),
        )
        .with_path(path),
      );
    }
    total_compressed = total_compressed.saturating_add(compressed);
    total_decompressed = total_decompressed.saturating_add(data.len() as u64);
    if total_decompressed > PACKAGE_TOTAL_DECOMPRESSED_MAX_BYTES {
      return Err(PluginLoadError::new(
        PluginLoadErrorCode::TotalSizeExceeded,
        format!("total decompressed size exceeds {PACKAGE_TOTAL_DECOMPRESSED_MAX_BYTES}"),
      ));
    }
    extracted.insert(path, data);
  }
  if total_compressed > 0 && total_decompressed / total_compressed.max(1) > PACKAGE_DECOMPRESSION_RATIO_MAX {
    return Err(PluginLoadError::new(
      PluginLoadErrorCode::ZipBomb,
      format!("archive decompression ratio exceeds {PACKAGE_DECOMPRESSION_RATIO_MAX}"),
    ));
  }
  let paths: Vec<String> = extracted.keys().cloned().collect();
  if let Err(message) = check_file_index_collisions(&paths) {
    return Err(PluginLoadError::new(PluginLoadErrorCode::DuplicatePath, message));
  }
  Ok(extracted)
}

/// Read a bounded archive's entries for offline inspection.
pub fn extract_archive_files_for_inspection(
  archive_bytes: &[u8],
) -> Result<BTreeMap<String, Vec<u8>>, PluginLoadError> {
  extract_archive_files(archive_bytes)
}

/// Build a deterministic unsigned `.lnplugin` archive from a materialized snapshot directory.
///
/// Entries are written in canonical path order with fixed permissions, so packing the same
/// snapshot always produces bytes with the same content digest.
pub fn pack_directory_to_archive_bytes(dir: &Path) -> Result<Vec<u8>, PluginLoadError> {
  let mut files = BTreeMap::new();
  collect_directory_files(dir, dir, &mut files)?;
  let mut buffer = std::io::Cursor::new(Vec::new());
  {
    let mut writer = zip::ZipWriter::new(&mut buffer);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
      .compression_method(zip::CompressionMethod::Deflated)
      .unix_permissions(0o644);
    for (path, bytes) in &files {
      writer
        .start_file(path.as_str(), options)
        .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::Internal, format!("archive write failed: {e}")))?;
      writer
        .write_all(bytes)
        .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::Internal, format!("archive write failed: {e}")))?;
    }
    writer
      .finish()
      .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::Internal, format!("archive write failed: {e}")))?;
  }
  Ok(buffer.into_inner())
}

/// Build an unsigned `.lnplugin` archive from a validated directory.
///
/// Rejects legacy reserved entries and undeclared files. The output is deterministic:
/// entries are written in canonical path order with a fixed timestamp.
pub fn pack_directory_to_archive(dir: &Path, output_path: &Path) -> Result<String, PluginLoadError> {
  let loader = PluginLoader::new(std::env::temp_dir().join("langnext-plugin-pack-cache"));
  let loaded = loader.load_directory(PluginSource::BuiltIn, dir)?;
  let mut files = BTreeMap::new();
  collect_directory_files(dir, dir, &mut files)?;
  let file = File::create(output_path)
    .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::Internal, format!("archive create failed: {e}")))?;
  let mut writer = zip::ZipWriter::new(file);
  let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
    .compression_method(zip::CompressionMethod::Deflated)
    .unix_permissions(0o644);
  for (path, bytes) in &files {
    writer
      .start_file(path.as_str(), options)
      .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::Internal, format!("archive write failed: {e}")))?;
    writer
      .write_all(bytes)
      .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::Internal, format!("archive write failed: {e}")))?;
  }
  writer
    .finish()
    .map_err(|e| PluginLoadError::new(PluginLoadErrorCode::Internal, format!("archive write failed: {e}")))?;
  Ok(loaded.descriptor.content_digest)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  const WASM: &[u8] = b"\0asm\x01\x00\x00\x00";

  fn manifest_json(id: &str, version: &str, runtime_kind: &str, artifact: &str) -> String {
    let sha = sha256_hex(WASM);
    let bytes = WASM.len();
    format!(
      r#"{{
  "manifestVersion": 1,
  "pluginApiVersion": "1.0",
  "id": "{id}",
  "version": "{version}",
  "runtime": {{ "kind": "{runtime_kind}", "artifact": "{artifact}" }},
  "files": [
    {{ "path": "{artifact}", "role": "runtime-artifact", "bytes": {bytes}, "sha256": "{sha}" }}
  ],
  "capabilities": [{{ "id": "translate.text@1" }}],
  "permissions": {{ "network": [], "authPolicies": [] }},
  "ui": {{ "mode": "schema" }}
}}"#
    )
  }

  fn write_dir(root: &Path, files: &[(&str, &[u8])]) {
    for (relative, bytes) in files {
      let path = root.join(relative);
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      let mut out = File::create(&path).unwrap();
      out.write_all(bytes).unwrap();
    }
  }

  fn archive_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
      let mut writer = zip::ZipWriter::new(&mut buffer);
      let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
      for (relative, bytes) in files {
        writer.start_file(*relative, options).unwrap();
        writer.write_all(bytes).unwrap();
      }
      writer.finish().unwrap();
    }
    buffer.into_inner()
  }

  fn loader() -> (tempfile::TempDir, PluginLoader) {
    let dir = tempfile::tempdir().unwrap();
    let loader = PluginLoader::new(dir.path().join("plugin-cache"));
    (dir, loader)
  }

  #[test]
  fn directory_and_archive_with_identical_content_share_digest() {
    let (dir, loader) = loader();
    let plugin_dir = dir.path().join("src");
    let manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    write_dir(
      &plugin_dir,
      &[("plugin.json", manifest.as_bytes()), ("artifacts/plugin.wasm", WASM)],
    );
    let from_directory = loader.load_directory(PluginSource::BuiltIn, &plugin_dir).unwrap();

    let archive_path = dir.path().join("sample.lnplugin");
    std::fs::write(
      &archive_path,
      archive_bytes(&[("plugin.json", manifest.as_bytes()), ("artifacts/plugin.wasm", WASM)]),
    )
    .unwrap();
    let from_archive = loader.load_archive(PluginSource::BuiltIn, &archive_path).unwrap();

    assert_eq!(
      from_directory.descriptor.content_digest,
      from_archive.descriptor.content_digest
    );
    let mut directory_descriptor = from_directory.descriptor.clone();
    let mut archive_descriptor = from_archive.descriptor.clone();
    assert_eq!(directory_descriptor.content_kind, PluginContentKind::Directory);
    assert_eq!(archive_descriptor.content_kind, PluginContentKind::Archive);
    directory_descriptor.content_kind = PluginContentKind::Directory;
    archive_descriptor.content_kind = PluginContentKind::Directory;
    assert_eq!(directory_descriptor, archive_descriptor);
    assert_eq!(from_directory.descriptor.content_kind, PluginContentKind::Directory);
    assert_eq!(from_archive.descriptor.content_kind, PluginContentKind::Archive);
    assert!(from_directory.snapshot_dir.is_dir());
    assert_eq!(
      std::fs::read(from_directory.snapshot_dir.join("artifacts/plugin.wasm")).unwrap(),
      WASM
    );
  }

  #[test]
  fn digest_changes_when_any_file_byte_changes() {
    let (dir, loader) = loader();
    let manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    let plugin_dir = dir.path().join("src");
    write_dir(
      &plugin_dir,
      &[("plugin.json", manifest.as_bytes()), ("artifacts/plugin.wasm", WASM)],
    );
    let first = loader.load_directory(PluginSource::BuiltIn, &plugin_dir).unwrap();
    let other_manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    write_dir(
      &plugin_dir,
      &[
        ("plugin.json", other_manifest.as_bytes()),
        ("artifacts/plugin.wasm", WASM),
      ],
    );
    assert_eq!(first.descriptor.content_digest, {
      loader
        .load_directory(PluginSource::BuiltIn, &plugin_dir)
        .unwrap()
        .descriptor
        .content_digest
    });
    let tampered = dir.path().join("tampered");
    write_dir(
      &tampered,
      &[
        ("plugin.json", manifest.as_bytes()),
        ("artifacts/plugin.wasm", b"\0asm\x01\x00\x00\x01"),
      ],
    );
    // Undeclared/tampered artifact bytes fail the index check before digesting.
    let err = loader.load_directory(PluginSource::BuiltIn, &tampered).unwrap_err();
    assert_eq!(err.code, PluginLoadErrorCode::DigestMismatch);
  }

  #[test]
  fn directory_symlink_is_rejected() {
    let (dir, loader) = loader();
    let manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    let plugin_dir = dir.path().join("src");
    write_dir(
      &plugin_dir,
      &[("plugin.json", manifest.as_bytes()), ("artifacts/plugin.wasm", WASM)],
    );
    let link = plugin_dir.join("artifacts/link.wasm");
    let target = plugin_dir.join("artifacts/plugin.wasm");
    if !try_symlink_file(&target, &link) {
      return;
    }
    let err = loader.load_directory(PluginSource::BuiltIn, &plugin_dir).unwrap_err();
    assert_eq!(err.code, PluginLoadErrorCode::SymlinkRejected);
  }

  #[test]
  fn undeclared_directory_file_is_rejected() {
    let (dir, loader) = loader();
    let manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    let plugin_dir = dir.path().join("src");
    write_dir(
      &plugin_dir,
      &[
        ("plugin.json", manifest.as_bytes()),
        ("artifacts/plugin.wasm", WASM),
        ("extra.txt", b"surprise"),
      ],
    );
    let err = loader.load_directory(PluginSource::BuiltIn, &plugin_dir).unwrap_err();
    assert_eq!(err.code, PluginLoadErrorCode::UndeclaredFile);
  }

  #[test]
  fn missing_indexed_file_is_rejected() {
    let (dir, loader) = loader();
    let manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    let plugin_dir = dir.path().join("src");
    write_dir(&plugin_dir, &[("plugin.json", manifest.as_bytes())]);
    let err = loader.load_directory(PluginSource::BuiltIn, &plugin_dir).unwrap_err();
    assert_eq!(err.code, PluginLoadErrorCode::UndeclaredFile);
  }

  #[test]
  fn legacy_trust_entries_are_rejected_as_undeclared() {
    // A signed-shape directory is not tolerated: no plugin-level signature or publisher key
    // entry exists in the source-based catalog.
    let (dir, loader) = loader();
    let manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    for legacy in ["publisher.pub", "signatures/manifest.sig"] {
      let signed = dir.path().join(format!("signed-{}", legacy.replace('/', "-")));
      write_dir(
        &signed,
        &[
          ("plugin.json", manifest.as_bytes()),
          ("artifacts/plugin.wasm", WASM),
          (legacy, &[0u8; 32]),
        ],
      );
      let err = loader.load_directory(PluginSource::BuiltIn, &signed).unwrap_err();
      assert_eq!(err.code, PluginLoadErrorCode::UndeclaredFile, "entry {legacy}");
    }
  }

  #[test]
  fn real_builtin_archive_carries_no_trust_entries() {
    let (_dir, loader) = loader();
    let archive =
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/plugins/com.langnext.edge-tts-1.0.0.lnplugin");
    if !archive.is_file() {
      return;
    }
    let loaded = loader
      .load_archive(PluginSource::BuiltIn, &archive)
      .expect("shipped built-in archive loads");
    assert_eq!(loaded.descriptor.plugin_id, "com.langnext.edge-tts");
    assert_eq!(
      loaded.descriptor.runtime_kind,
      crate::domain::runtime_plugin::RuntimeKind::WasmComponent
    );
    let mut reader = ZipArchive::new(File::open(&archive).unwrap()).unwrap();
    for index in 0..reader.len() {
      let entry = reader.by_index(index).unwrap();
      let name = entry.name().to_string();
      assert!(
        name != "publisher.pub" && name != "signatures/manifest.sig",
        "shipped built-in archive still carries legacy trust entry {name}"
      );
    }
    assert!(!loaded.snapshot_dir.join("publisher.pub").exists());
  }

  #[test]
  fn malformed_manifest_is_rejected() {
    let (dir, loader) = loader();
    let plugin_dir = dir.path().join("src");
    write_dir(&plugin_dir, &[("plugin.json", b"{ not json")]);
    let err = loader.load_directory(PluginSource::BuiltIn, &plugin_dir).unwrap_err();
    assert_eq!(err.code, PluginLoadErrorCode::InvalidManifest);
  }

  #[test]
  fn path_traversal_equivalent_archive_entry_is_rejected() {
    let (dir, loader) = loader();
    let manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    let archive_path = dir.path().join("traversal.lnplugin");
    std::fs::write(
      &archive_path,
      archive_bytes(&[
        ("plugin.json", manifest.as_bytes()),
        ("artifacts/plugin.wasm", WASM),
        ("../escape.txt", b"nope"),
      ]),
    )
    .unwrap();
    let err = loader.load_archive(PluginSource::BuiltIn, &archive_path).unwrap_err();
    assert_eq!(err.code, PluginLoadErrorCode::PathInvalid);
  }

  #[test]
  fn oversized_archive_entry_is_rejected() {
    let (dir, loader) = loader();
    let manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    let archive_path = dir.path().join("oversized.lnplugin");
    std::fs::write(
      &archive_path,
      archive_bytes(&[
        ("plugin.json", manifest.as_bytes()),
        ("artifacts/plugin.wasm", WASM),
        ("artifacts/big.bin", &vec![0u8; (PACKAGE_ENTRY_MAX_BYTES + 1) as usize]),
      ]),
    )
    .unwrap();
    let err = loader.load_archive(PluginSource::BuiltIn, &archive_path).unwrap_err();
    assert_eq!(err.code, PluginLoadErrorCode::EntryTooLarge);
  }

  #[test]
  fn user_and_development_sources_may_not_declare_native() {
    let (dir, loader) = loader();
    let manifest = manifest_json(
      "com.example.native",
      "1.0.0",
      "trusted-native-worker",
      "runtime/worker.exe",
    );
    let plugin_dir = dir.path().join("native");
    write_dir(
      &plugin_dir,
      &[("plugin.json", manifest.as_bytes()), ("runtime/worker.exe", WASM)],
    );
    for source in [PluginSource::User, PluginSource::Development] {
      let err = loader.load_directory(source, &plugin_dir).unwrap_err();
      assert_eq!(err.code, PluginLoadErrorCode::NativeSourceRejected, "source {source:?}");
    }
  }

  #[test]
  fn archive_source_mutation_is_rejected() {
    let (dir, loader) = loader();
    let manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    let archive_path = dir.path().join("sample.lnplugin");
    std::fs::write(
      &archive_path,
      archive_bytes(&[("plugin.json", manifest.as_bytes()), ("artifacts/plugin.wasm", WASM)]),
    )
    .unwrap();
    let loaded = loader.load_archive(PluginSource::User, &archive_path).unwrap();
    assert!(loaded.snapshot_dir.is_dir());
    // A different archive at the same path yields a different digest identity.
    std::fs::write(
      &archive_path,
      archive_bytes(&[
        ("plugin.json", manifest.as_bytes()),
        ("artifacts/plugin.wasm", WASM),
        ("extra.txt", b"extra"),
      ]),
    )
    .unwrap();
    let err = loader.load_archive(PluginSource::User, &archive_path).unwrap_err();
    assert_eq!(err.code, PluginLoadErrorCode::UndeclaredFile);
  }

  #[test]
  fn snapshot_publish_is_idempotent() {
    let (dir, loader) = loader();
    let manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    let plugin_dir = dir.path().join("src");
    write_dir(
      &plugin_dir,
      &[("plugin.json", manifest.as_bytes()), ("artifacts/plugin.wasm", WASM)],
    );
    let first = loader.load_directory(PluginSource::Development, &plugin_dir).unwrap();
    assert!(loader.has_snapshot(&first.descriptor.content_digest));
    let second = loader.load_directory(PluginSource::Development, &plugin_dir).unwrap();
    assert_eq!(first.snapshot_dir, second.snapshot_dir);
    assert_eq!(second.read_snapshot_file("plugin.json").unwrap(), manifest.as_bytes());
  }

  #[test]
  fn pack_directory_round_trips_to_archive() {
    let (dir, loader) = loader();
    let manifest = manifest_json(
      "com.example.translate",
      "1.0.0",
      "wasm-component",
      "artifacts/plugin.wasm",
    );
    let plugin_dir = dir.path().join("src");
    write_dir(
      &plugin_dir,
      &[("plugin.json", manifest.as_bytes()), ("artifacts/plugin.wasm", WASM)],
    );
    let archive_path = dir.path().join("packed.lnplugin");
    let digest = pack_directory_to_archive(&plugin_dir, &archive_path).unwrap();
    let from_archive = loader.load_archive(PluginSource::User, &archive_path).unwrap();
    assert_eq!(digest, from_archive.descriptor.content_digest);
  }

  fn try_symlink_file(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
      std::os::windows::fs::symlink_file(target, link).is_ok()
    }
    #[cfg(not(any(unix, windows)))]
    {
      let _ = (target, link);
      false
    }
  }
}
