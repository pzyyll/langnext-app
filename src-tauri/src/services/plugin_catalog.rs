// ABOUTME: Source-based plugin catalog: discovery, precedence, immutable snapshots, defaults.
// ABOUTME: Built-in content is trusted by location; development is debug-only; user content is Wasm.
use crate::domain::first_party_plugins::is_first_party_plugin_id;
use crate::domain::plugin_catalog::{
  CatalogDefault, CatalogEntryError, CatalogRefreshSummary, DEVELOPMENT_PLUGIN_DIR_ENV, PLUGIN_CACHE_DIR_NAME,
  PluginCatalogEntryDto, PluginCatalogSnapshotDto, PluginContentKind, PluginDescriptor, PluginLoadErrorCode,
  PluginSource, USER_PLUGIN_DIR_NAME, catalog_entry_order,
};
use crate::domain::runtime_plugin::RuntimeKind;
use crate::error::StorageError;
use crate::repositories::plugin_catalog as catalog_repo;
use crate::services::plugin_loader::{LoadedPlugin, PluginLoader};
use crate::storage::Database;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// Directory-name suffix for user archives.
pub const PLUGIN_ARCHIVE_EXTENSION: &str = "lnplugin";

/// Catalog construction inputs. Directories are explicit; the catalog never guesses paths.
#[derive(Debug, Clone)]
pub struct PluginCatalogConfig {
  /// Application data root. Model stores and user content resolve relative to it.
  pub app_data_dir: PathBuf,
  /// Application resource plugin directory. `None` means no built-in content (tests, headless).
  pub built_in_dir: Option<PathBuf>,
  /// Explicit development plugin directory. Only honored when `allow_development` is true.
  pub development_dir: Option<PathBuf>,
  /// User archive directory (`<app-data>/plugins`).
  pub user_dir: PathBuf,
  /// Immutable snapshot cache (`<app-data>/plugin-cache`).
  pub cache_dir: PathBuf,
  /// Debug builds only. Release builds must never load a development directory.
  pub allow_development: bool,
}

impl PluginCatalogConfig {
  /// Standard layout under one app data directory.
  pub fn for_app_data(app_data_dir: &Path, built_in_dir: Option<PathBuf>, allow_development: bool) -> Self {
    Self {
      app_data_dir: app_data_dir.to_path_buf(),
      built_in_dir,
      development_dir: development_plugin_dir_from_env(allow_development),
      user_dir: app_data_dir.join(USER_PLUGIN_DIR_NAME),
      cache_dir: app_data_dir.join(PLUGIN_CACHE_DIR_NAME),
      allow_development,
    }
  }
}

/// Read the explicit development plugin directory. Debug builds only; release ignores it.
pub fn development_plugin_dir_from_env(allow_development: bool) -> Option<PathBuf> {
  if !allow_development {
    return None;
  }
  let raw = std::env::var(DEVELOPMENT_PLUGIN_DIR_ENV).ok()?;
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return None;
  }
  Some(PathBuf::from(trimmed))
}

#[derive(Debug, Default)]
struct CatalogState {
  entries: Vec<LoadedPlugin>,
  errors: Vec<CatalogEntryError>,
  /// plugin id → resolved default content digest.
  defaults: BTreeMap<String, String>,
}

/// Discovered plugin content plus resolved defaults. Refreshed explicitly; never mutated in place.
pub struct PluginCatalog {
  db: Database,
  loader: PluginLoader,
  config: PluginCatalogConfig,
  state: RwLock<CatalogState>,
}

impl std::fmt::Debug for PluginCatalog {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("PluginCatalog")
      .field("config", &self.config)
      .finish_non_exhaustive()
  }
}

impl PluginCatalog {
  pub fn new(db: Database, config: PluginCatalogConfig) -> Self {
    let loader = PluginLoader::new(config.cache_dir.clone());
    Self {
      db,
      loader,
      config,
      state: RwLock::new(CatalogState::default()),
    }
  }

  pub fn config(&self) -> &PluginCatalogConfig {
    &self.config
  }

  /// Application data root shared with the model store and user archives.
  pub fn app_data_dir(&self) -> &Path {
    &self.config.app_data_dir
  }

  pub fn loader(&self) -> &PluginLoader {
    &self.loader
  }

  /// Refresh the catalog from every configured source.
  ///
  /// Deterministic precedence: Built-in beats Development beats User for the same
  /// plugin id and version. A different digest inside one source for the same
  /// id/version is a conflict and is isolated as an error entry. Invalid content
  /// never hides valid content from another source.
  pub fn refresh(&self) -> Result<CatalogRefreshSummary, StorageError> {
    let mut candidates: Vec<LoadedPlugin> = Vec::new();
    let mut errors: Vec<CatalogEntryError> = Vec::new();
    let mut summary = CatalogRefreshSummary::default();

    if let Some(dir) = self.config.built_in_dir.clone() {
      self.discover_directories(PluginSource::BuiltIn, &dir, &mut candidates, &mut errors);
    }
    if self.config.allow_development {
      if let Some(dir) = self.config.development_dir.clone() {
        self.discover_directories(PluginSource::Development, &dir, &mut candidates, &mut errors);
      }
    }
    let user_archives = self.db.read(catalog_repo::list_user_archives)?;
    self.discover_user_archives(&user_archives, &mut candidates, &mut errors);

    // Reject non-built-in content that claims a reserved first-party identity.
    let mut accepted: Vec<LoadedPlugin> = Vec::new();
    for candidate in candidates {
      if candidate.descriptor.source != PluginSource::BuiltIn
        && is_first_party_plugin_id(&candidate.descriptor.plugin_id)
      {
        errors.push(
          CatalogEntryError::new(
            PluginLoadErrorCode::FirstPartyIdRejected,
            candidate.descriptor.source,
            candidate.descriptor.plugin_id.clone(),
            "reserved first-party plugin id",
          )
          .with_path(candidate.descriptor.content_digest.clone()),
        );
        continue;
      }
      if candidate.descriptor.runtime_kind == RuntimeKind::TrustedNativeWorker
        && !candidate.descriptor.source.allows_native()
      {
        errors.push(CatalogEntryError::new(
          PluginLoadErrorCode::NativeSourceRejected,
          candidate.descriptor.source,
          candidate.descriptor.plugin_id.clone(),
          "native worker content must be built-in",
        ));
        continue;
      }
      accepted.push(candidate);
    }

    // Deterministic precedence and duplicate detection.
    accepted.sort_by(|left, right| catalog_entry_order(&left.descriptor, &right.descriptor));
    let mut published: Vec<LoadedPlugin> = Vec::new();
    for candidate in accepted {
      let conflicting = published.iter().find(|existing| {
        existing.descriptor.plugin_id == candidate.descriptor.plugin_id
          && existing.descriptor.version == candidate.descriptor.version
      });
      match conflicting {
        None => published.push(candidate),
        Some(existing) => {
          let existing_rank = source_rank(existing.descriptor.source);
          let candidate_rank = source_rank(candidate.descriptor.source);
          if existing.descriptor.content_digest == candidate.descriptor.content_digest {
            continue;
          }
          if candidate_rank < existing_rank {
            // Higher precedence source wins; the loser is reported as a conflict.
            errors.push(conflict_error(&candidate, &existing.descriptor.content_digest));
            let position = published
              .iter()
              .position(|item| {
                item.descriptor.plugin_id == candidate.descriptor.plugin_id
                  && item.descriptor.version == candidate.descriptor.version
              })
              .expect("conflicting entry is published");
            published[position] = candidate;
          } else {
            errors.push(conflict_error(&candidate, &existing.descriptor.content_digest));
          }
        }
      }
    }

    let overrides = self.db.read(catalog_repo::list_default_overrides)?;
    let defaults = resolve_defaults(&published, &overrides);

    for entry in &published {
      match entry.descriptor.source {
        PluginSource::BuiltIn => summary.built_in += 1,
        PluginSource::Development => summary.development += 1,
        PluginSource::User => summary.user += 1,
      }
    }
    summary.invalid = errors.len();
    summary.defaults = defaults.len();

    errors.sort_by(|left, right| {
      left
        .plugin_id
        .cmp(&right.plugin_id)
        .then_with(|| left.source.as_str().cmp(right.source.as_str()))
        .then_with(|| left.code.as_str().cmp(right.code.as_str()))
    });

    let mut state = self.state.write().expect("plugin catalog lock poisoned");
    state.entries = published;
    state.errors = errors;
    state.defaults = defaults;
    Ok(summary)
  }

  /// Published catalog entries with default/in-use/removable/reloadable flags.
  pub fn entries(&self) -> Result<Vec<PluginCatalogEntryDto>, StorageError> {
    let state = self.state.read().expect("plugin catalog lock poisoned");
    let defaults = state.defaults.clone();
    let entries: Vec<(PluginDescriptor, PluginSource)> = state
      .entries
      .iter()
      .map(|entry| (entry.descriptor.clone(), entry.descriptor.source))
      .collect();
    drop(state);

    let in_use = self.db.read(catalog_repo::in_use_digests)?;

    Ok(
      entries
        .into_iter()
        .map(|(descriptor, source)| {
          let is_default = defaults.get(&descriptor.plugin_id) == Some(&descriptor.content_digest);
          PluginCatalogEntryDto {
            in_use: in_use.contains(&descriptor.content_digest),
            is_default,
            removable: source.is_user_removable(),
            reloadable: source.is_reloadable(),
            descriptor,
          }
        })
        .collect(),
    )
  }

  /// One catalog snapshot: entries and isolated per-entry errors.
  pub fn snapshot_dto(&self) -> Result<PluginCatalogSnapshotDto, StorageError> {
    Ok(PluginCatalogSnapshotDto {
      entries: self.entries()?,
      errors: self.errors(),
    })
  }

  pub fn errors(&self) -> Vec<CatalogEntryError> {
    self.state.read().expect("plugin catalog lock poisoned").errors.clone()
  }

  /// True when a built-in entry failed to load. Startup readiness must fail closed.
  pub fn has_builtin_errors(&self) -> bool {
    self
      .state
      .read()
      .expect("plugin catalog lock poisoned")
      .errors
      .iter()
      .any(|error| error.source == PluginSource::BuiltIn)
  }

  /// Immutable snapshot for an exact content digest. Never falls back to another digest.
  pub fn snapshot(&self, content_digest: &str) -> Result<LoadedPlugin, StorageError> {
    self
      .snapshot_optional(content_digest)
      .ok_or_else(|| StorageError::PluginUnavailable(format!("plugin content {content_digest} is unavailable")))
  }

  pub fn snapshot_optional(&self, content_digest: &str) -> Option<LoadedPlugin> {
    self
      .state
      .read()
      .expect("plugin catalog lock poisoned")
      .entries
      .iter()
      .find(|entry| entry.descriptor.content_digest == content_digest)
      .cloned()
  }

  pub fn has_snapshot(&self, content_digest: &str) -> bool {
    self.snapshot_optional(content_digest).is_some()
  }

  /// All loaded snapshots, deterministic order.
  pub fn loaded_plugins(&self) -> Vec<LoadedPlugin> {
    self.state.read().expect("plugin catalog lock poisoned").entries.clone()
  }

  /// All descriptors, deterministic order.
  pub fn descriptors(&self) -> Vec<PluginDescriptor> {
    self
      .state
      .read()
      .expect("plugin catalog lock poisoned")
      .entries
      .iter()
      .map(|entry| entry.descriptor.clone())
      .collect()
  }

  /// Entries for one plugin id, deterministic order.
  pub fn entries_for_plugin(&self, plugin_id: &str) -> Vec<LoadedPlugin> {
    self
      .state
      .read()
      .expect("plugin catalog lock poisoned")
      .entries
      .iter()
      .filter(|entry| entry.descriptor.plugin_id == plugin_id)
      .cloned()
      .collect()
  }

  /// Exact plugin id + version lookup. Used by import restore; never substitutes a digest.
  pub fn find_plugin_version(&self, plugin_id: &str, version: &str) -> Option<LoadedPlugin> {
    self
      .state
      .read()
      .expect("plugin catalog lock poisoned")
      .entries
      .iter()
      .find(|entry| entry.descriptor.plugin_id == plugin_id && entry.descriptor.version == version)
      .cloned()
  }

  /// Resolved default content digest for a plugin id.
  pub fn default_digest(&self, plugin_id: &str) -> Option<String> {
    self
      .state
      .read()
      .expect("plugin catalog lock poisoned")
      .defaults
      .get(plugin_id)
      .cloned()
  }

  /// Resolved default entry. Built-in content is the automatic fallback.
  pub fn resolve_default(&self, plugin_id: &str) -> Option<LoadedPlugin> {
    self
      .default_digest(plugin_id)
      .and_then(|digest| self.snapshot_optional(&digest))
  }

  /// All resolved defaults in deterministic plugin id order.
  pub fn defaults(&self) -> Vec<(String, String)> {
    self
      .state
      .read()
      .expect("plugin catalog lock poisoned")
      .defaults
      .iter()
      .map(|(plugin_id, digest)| (plugin_id.clone(), digest.clone()))
      .collect()
  }

  /// Store one explicit user default override and republish the resolved defaults.
  ///
  /// Existing instance and provider digest pins are never touched.
  pub fn set_user_default(&self, plugin_id: &str, content_digest: &str) -> Result<CatalogDefault, StorageError> {
    let entry = self
      .snapshot_optional(content_digest)
      .ok_or_else(|| StorageError::PluginUnavailable(format!("plugin content {content_digest} is not available")))?;
    if entry.descriptor.plugin_id != plugin_id {
      return Err(StorageError::Validation(format!(
        "content {content_digest} belongs to plugin {}, not {plugin_id}",
        entry.descriptor.plugin_id
      )));
    }
    let stored = self
      .db
      .transaction(|uow| catalog_repo::set_default_override(uow.conn(), plugin_id, content_digest))?;
    let overrides = self.db.read(catalog_repo::list_default_overrides)?;
    let entries = self.state.read().expect("plugin catalog lock poisoned").entries.clone();
    let defaults = resolve_defaults(&entries, &overrides);
    self.state.write().expect("plugin catalog lock poisoned").defaults = defaults;
    Ok(stored)
  }

  /// Remove one explicit user default override. The built-in default applies again.
  pub fn clear_user_default(&self, plugin_id: &str) -> Result<(), StorageError> {
    self
      .db
      .transaction(|uow| catalog_repo::clear_default_override(uow.conn(), plugin_id))?;
    let overrides = self.db.read(catalog_repo::list_default_overrides)?;
    let entries = self.state.read().expect("plugin catalog lock poisoned").entries.clone();
    let defaults = resolve_defaults(&entries, &overrides);
    self.state.write().expect("plugin catalog lock poisoned").defaults = defaults;
    Ok(())
  }

  /// Drop overrides whose content is no longer present, then republish defaults.
  pub fn prune_stale_default_overrides(&self) -> Result<(), StorageError> {
    let entries = self.state.read().expect("plugin catalog lock poisoned").entries.clone();
    let overrides = self.db.read(catalog_repo::list_default_overrides)?;
    for override_row in &overrides {
      let present = entries
        .iter()
        .any(|entry| entry.descriptor.content_digest == override_row.content_digest);
      if !present {
        self.db.transaction(|uow| {
          catalog_repo::clear_default_override_for_digest(uow.conn(), &override_row.content_digest)
        })?;
      }
    }
    let refreshed = self.db.read(catalog_repo::list_default_overrides)?;
    let defaults = resolve_defaults(&entries, &refreshed);
    self.state.write().expect("plugin catalog lock poisoned").defaults = defaults;
    Ok(())
  }

  fn discover_directories(
    &self,
    source: PluginSource,
    dir: &Path,
    candidates: &mut Vec<LoadedPlugin>,
    errors: &mut Vec<CatalogEntryError>,
  ) {
    if !dir.is_dir() {
      if source == PluginSource::BuiltIn {
        errors.push(CatalogEntryError::new(
          PluginLoadErrorCode::ContentMissing,
          source,
          "",
          "built-in plugin directory is missing",
        ));
      }
      return;
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut archives: Vec<PathBuf> = Vec::new();
    match std::fs::read_dir(dir) {
      Ok(read_dir) => {
        for entry in read_dir.flatten() {
          let path = entry.path();
          let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
          if path.is_dir() {
            dirs.push(path);
          } else if is_plugin_archive_name(name) {
            archives.push(path);
          }
        }
      }
      Err(_) => {
        errors.push(CatalogEntryError::new(
          PluginLoadErrorCode::ContentMissing,
          source,
          "",
          "plugin directory is unreadable",
        ));
        return;
      }
    }
    dirs.sort();
    archives.sort();
    for path in dirs {
      match self.loader.load_directory(source, &path) {
        Ok(loaded) => candidates.push(loaded),
        Err(error) => errors.push(error.to_catalog_error(source, "")),
      }
    }
    for path in archives {
      match self.loader.load_archive(source, &path) {
        Ok(loaded) => candidates.push(loaded),
        Err(error) => errors.push(error.to_catalog_error(source, "")),
      }
    }
  }

  fn discover_user_archives(
    &self,
    archives: &[crate::domain::plugin_catalog::UserPluginArchive],
    candidates: &mut Vec<LoadedPlugin>,
    errors: &mut Vec<CatalogEntryError>,
  ) {
    let mut records = archives.to_vec();
    records.sort_by(|left, right| left.file_name.cmp(&right.file_name));
    for record in records {
      let path = self.config.user_dir.join(&record.file_name);
      let loaded = match self.loader.load_archive(PluginSource::User, &path) {
        Ok(loaded) => loaded,
        Err(error) => {
          errors.push(error.to_catalog_error(PluginSource::User, &record.plugin_id));
          continue;
        }
      };
      if loaded.descriptor.content_digest != record.content_digest {
        errors.push(CatalogEntryError::new(
          PluginLoadErrorCode::DigestMismatch,
          PluginSource::User,
          record.plugin_id.clone(),
          "installed archive content no longer matches its recorded digest",
        ));
        continue;
      }
      candidates.push(loaded);
    }
  }
}

fn conflict_error(candidate: &LoadedPlugin, existing_digest: &str) -> CatalogEntryError {
  CatalogEntryError::new(
    PluginLoadErrorCode::VersionConflict,
    candidate.descriptor.source,
    candidate.descriptor.plugin_id.clone(),
    format!(
      "content digest {} conflicts with {} for the same plugin version",
      candidate.descriptor.content_digest, existing_digest
    ),
  )
  .with_path(candidate.descriptor.content_digest.clone())
}

fn source_rank(source: PluginSource) -> u8 {
  match source {
    PluginSource::BuiltIn => 0,
    PluginSource::Development => 1,
    PluginSource::User => 2,
  }
}

/// Resolve one default digest per plugin id: explicit override first, then built-in.
fn resolve_defaults(entries: &[LoadedPlugin], overrides: &[CatalogDefault]) -> BTreeMap<String, String> {
  let mut defaults: BTreeMap<String, String> = BTreeMap::new();
  let mut plugin_ids: Vec<String> = entries.iter().map(|entry| entry.descriptor.plugin_id.clone()).collect();
  plugin_ids.sort();
  plugin_ids.dedup();

  for plugin_id in plugin_ids {
    let override_digest = overrides
      .iter()
      .find(|row| row.plugin_id == plugin_id)
      .map(|row| row.content_digest.clone());
    if let Some(digest) = override_digest {
      let matches_plugin = entries
        .iter()
        .any(|entry| entry.descriptor.plugin_id == plugin_id && entry.descriptor.content_digest == digest);
      if matches_plugin {
        defaults.insert(plugin_id, digest);
        continue;
      }
    }
    let mut candidates: Vec<&LoadedPlugin> = entries
      .iter()
      .filter(|entry| entry.descriptor.plugin_id == plugin_id)
      .collect();
    candidates.sort_by(|left, right| {
      source_rank(left.descriptor.source)
        .cmp(&source_rank(right.descriptor.source))
        .then_with(|| compare_versions(&right.descriptor.version, &left.descriptor.version))
        .then_with(|| left.descriptor.content_digest.cmp(&right.descriptor.content_digest))
    });
    if let Some(first) = candidates.first() {
      defaults.insert(plugin_id, first.descriptor.content_digest.clone());
    }
  }
  defaults
}

/// Numeric-aware version compare; falls back to string compare for non-numeric segments.
fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
  let left_parts: Vec<&str> = left.split(['.', '-', '+']).collect();
  let right_parts: Vec<&str> = right.split(['.', '-', '+']).collect();
  for index in 0..left_parts.len().max(right_parts.len()) {
    let left_part = left_parts.get(index).copied().unwrap_or("");
    let right_part = right_parts.get(index).copied().unwrap_or("");
    let ordering = match (left_part.parse::<u64>(), right_part.parse::<u64>()) {
      (Ok(left_number), Ok(right_number)) => left_number.cmp(&right_number),
      _ => left_part.cmp(right_part),
    };
    if ordering != std::cmp::Ordering::Equal {
      return ordering;
    }
  }
  std::cmp::Ordering::Equal
}

/// Pinned content identity resolved for services that hold only a connection.
#[derive(Debug, Clone)]
pub struct PinnedContent {
  pub content_digest: String,
  pub plugin_id: String,
  pub version: String,
  pub manifest_json: String,
  pub manifest: crate::domain::runtime_plugin::PluginManifestV1,
  pub runtime_kind: RuntimeKind,
  pub source: PluginSource,
}

/// Resolve one pinned content digest without a live catalog handle.
///
/// The catalog is authoritative when present. Without it (narrow tests), only persisted user
/// archives can satisfy the lookup; built-in content is never guessed.
pub fn resolve_pinned_content(
  catalog: Option<&PluginCatalog>,
  conn: &rusqlite::Connection,
  content_digest: &str,
) -> Result<Option<PinnedContent>, StorageError> {
  if let Some(catalog) = catalog {
    if let Some(loaded) = catalog.snapshot_optional(content_digest) {
      return Ok(Some(PinnedContent {
        content_digest: loaded.descriptor.content_digest.clone(),
        plugin_id: loaded.descriptor.plugin_id.clone(),
        version: loaded.descriptor.version.clone(),
        manifest_json: loaded.manifest_json.clone(),
        manifest: loaded.manifest.clone(),
        runtime_kind: loaded.descriptor.runtime_kind,
        source: loaded.descriptor.source,
      }));
    }
    return Ok(None);
  }
  let Some(archive) = catalog_repo::get_user_archive(conn, content_digest)? else {
    return Ok(None);
  };
  let manifest = serde_json::from_str::<crate::domain::runtime_plugin::PluginManifestV1>(&archive.manifest_json)
    .map_err(|error| StorageError::Validation(format!("stored user archive manifest is invalid: {error}")))?;
  Ok(Some(PinnedContent {
    content_digest: archive.content_digest,
    plugin_id: archive.plugin_id,
    version: archive.version,
    manifest_json: archive.manifest_json,
    manifest,
    runtime_kind: archive.runtime_kind,
    source: PluginSource::User,
  }))
}

/// True when the path looks like a user plugin archive.
pub fn is_plugin_archive_name(name: &str) -> bool {
  Path::new(name)
    .extension()
    .is_some_and(|extension| extension.eq_ignore_ascii_case(PLUGIN_ARCHIVE_EXTENSION))
}

/// Built-in content kind for one resource entry.
pub fn built_in_content_kind(path: &Path) -> PluginContentKind {
  if path.is_dir() {
    PluginContentKind::Directory
  } else {
    PluginContentKind::Archive
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::plugin_catalog::sha256_hex;
  use crate::repositories::plugin_catalog as repo;
  use std::io::Write;

  const WASM: &[u8] = b"\0asm\x01\x00\x00\x00";

  fn manifest_json(id: &str, version: &str, runtime_kind: &str, artifact: &str) -> String {
    manifest_json_for(id, version, runtime_kind, artifact, WASM)
  }

  fn manifest_json_for(id: &str, version: &str, runtime_kind: &str, artifact: &str, payload: &[u8]) -> String {
    let sha = sha256_hex(payload);
    let bytes = payload.len();
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

  fn write_plugin_dir(root: &Path, id: &str, version: &str) -> PathBuf {
    let dir = root.join(format!("{id}-{version}"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
      dir.join("plugin.json"),
      manifest_json(id, version, "wasm-component", "artifacts/plugin.wasm"),
    )
    .unwrap();
    std::fs::create_dir_all(dir.join("artifacts")).unwrap();
    std::fs::write(dir.join("artifacts/plugin.wasm"), WASM).unwrap();
    dir
  }

  fn write_plugin_dir_with_artifact(root: &Path, id: &str, version: &str, artifact: &[u8]) -> PathBuf {
    let dir = root.join(format!("{id}-{version}"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
      dir.join("plugin.json"),
      manifest_json_for(id, version, "wasm-component", "artifacts/plugin.wasm", artifact),
    )
    .unwrap();
    std::fs::create_dir_all(dir.join("artifacts")).unwrap();
    std::fs::write(dir.join("artifacts/plugin.wasm"), artifact).unwrap();
    dir
  }

  fn write_archive(path: &Path, id: &str, version: &str) {
    write_archive_with_artifact(path, id, version, WASM);
  }

  fn write_archive_with_artifact(path: &Path, id: &str, version: &str, artifact: &[u8]) {
    let file = std::fs::File::create(path).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
    writer.start_file("plugin.json", options).unwrap();
    writer
      .write_all(manifest_json_for(id, version, "wasm-component", "artifacts/plugin.wasm", artifact).as_bytes())
      .unwrap();
    writer.start_file("artifacts/plugin.wasm", options).unwrap();
    writer.write_all(artifact).unwrap();
    writer.finish().unwrap();
  }

  struct Fixture {
    _dir: tempfile::TempDir,
    db: Database,
    built_in_dir: PathBuf,
    development_dir: PathBuf,
    user_dir: PathBuf,
  }

  fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let built_in_dir = dir.path().join("resources/plugins");
    let development_dir = dir.path().join("dev-plugins");
    let user_dir = dir.path().join(USER_PLUGIN_DIR_NAME);
    std::fs::create_dir_all(&built_in_dir).unwrap();
    std::fs::create_dir_all(&development_dir).unwrap();
    std::fs::create_dir_all(&user_dir).unwrap();
    Fixture {
      _dir: dir,
      db,
      built_in_dir,
      development_dir,
      user_dir,
    }
  }

  fn catalog_for(fixture: &Fixture, allow_development: bool) -> PluginCatalog {
    PluginCatalog::new(
      fixture.db.clone(),
      PluginCatalogConfig {
        app_data_dir: fixture.user_dir.parent().expect("app data dir").to_path_buf(),
        built_in_dir: Some(fixture.built_in_dir.clone()),
        development_dir: Some(fixture.development_dir.clone()),
        user_dir: fixture.user_dir.clone(),
        cache_dir: fixture.user_dir.join("cache"),
        allow_development,
      },
    )
  }

  fn install_user_archive(
    fixture: &Fixture,
    catalog: &PluginCatalog,
    file_name: &str,
    id: &str,
    version: &str,
  ) -> String {
    let path = fixture.user_dir.join(file_name);
    write_archive(&path, id, version);
    let loaded = catalog
      .loader()
      .load_archive(PluginSource::User, &path)
      .expect("user archive loads");
    let record = crate::domain::plugin_catalog::UserPluginArchive {
      content_digest: loaded.descriptor.content_digest.clone(),
      plugin_id: loaded.descriptor.plugin_id.clone(),
      version: loaded.descriptor.version.clone(),
      runtime_kind: loaded.descriptor.runtime_kind,
      manifest_json: loaded.manifest_json.clone(),
      permission_request_digest: crate::domain::plugin_catalog::compute_permission_request_digest(&loaded.manifest),
      file_name: file_name.to_string(),
      installed_at: "t0".into(),
    };
    fixture
      .db
      .write(|conn| repo::insert_user_archive(conn, &record))
      .unwrap();
    loaded.descriptor.content_digest
  }

  #[test]
  fn catalog_refresh_discovers_builtin_development_and_user_sources() {
    let fixture = fixture();
    write_plugin_dir(&fixture.built_in_dir, "com.example.builtin", "1.0.0");
    write_plugin_dir(&fixture.development_dir, "com.example.dev", "1.0.0");
    let catalog = catalog_for(&fixture, true);
    install_user_archive(&fixture, &catalog, "user.lnplugin", "com.example.user", "1.0.0");

    let summary = catalog.refresh().unwrap();
    assert_eq!(summary.built_in, 1);
    assert_eq!(summary.development, 1);
    assert_eq!(summary.user, 1);
    assert_eq!(summary.invalid, 0);
    assert_eq!(summary.defaults, 3);
    assert!(!catalog.has_builtin_errors());

    let entries = catalog.entries().unwrap();
    let sources: Vec<PluginSource> = entries.iter().map(|entry| entry.descriptor.source).collect();
    assert_eq!(
      sources,
      vec![PluginSource::BuiltIn, PluginSource::Development, PluginSource::User]
    );
    assert!(entries.iter().all(|entry| entry.is_default));
    assert!(
      entries
        .iter()
        .find(|entry| entry.descriptor.source == PluginSource::User)
        .unwrap()
        .removable
    );
    assert!(
      entries
        .iter()
        .find(|entry| entry.descriptor.source == PluginSource::Development)
        .unwrap()
        .reloadable
    );
    assert!(
      !entries
        .iter()
        .find(|entry| entry.descriptor.source == PluginSource::BuiltIn)
        .unwrap()
        .removable
    );
  }

  #[test]
  fn release_catalog_ignores_development_source() {
    let fixture = fixture();
    write_plugin_dir(&fixture.built_in_dir, "com.example.builtin", "1.0.0");
    write_plugin_dir(&fixture.development_dir, "com.example.dev", "1.0.0");
    let catalog = catalog_for(&fixture, false);
    let summary = catalog.refresh().unwrap();
    assert_eq!(summary.built_in, 1);
    assert_eq!(summary.development, 0);
    assert!(
      catalog
        .snapshot_optional(
          &catalog
            .entries_for_plugin("com.example.dev")
            .first()
            .map(|entry| entry.descriptor.content_digest.clone())
            .unwrap_or_default()
        )
        .is_none()
    );
    assert!(catalog.entries_for_plugin("com.example.dev").is_empty());
  }

  #[test]
  fn user_plugin_cannot_claim_first_party_id() {
    let fixture = fixture();
    write_plugin_dir(&fixture.built_in_dir, "com.example.builtin", "1.0.0");
    let catalog = catalog_for(&fixture, true);
    install_user_archive(
      &fixture,
      &catalog,
      "fake.lnplugin",
      crate::domain::first_party_plugins::EDGE_TTS_PLUGIN_ID,
      "9.9.9",
    );

    let summary = catalog.refresh().unwrap();
    assert_eq!(summary.user, 0);
    assert_eq!(summary.invalid, 1);
    let errors = catalog.errors();
    assert_eq!(errors[0].code, PluginLoadErrorCode::FirstPartyIdRejected);
    assert_eq!(errors[0].source, PluginSource::User);
    // Built-ins remain available and authoritative.
    assert_eq!(summary.built_in, 1);
    assert!(catalog.resolve_default("com.example.builtin").is_some());
    assert!(
      catalog
        .resolve_default(crate::domain::first_party_plugins::EDGE_TTS_PLUGIN_ID)
        .is_none()
    );
  }

  #[test]
  fn invalid_user_plugin_does_not_hide_builtins() {
    let fixture = fixture();
    write_plugin_dir(&fixture.built_in_dir, "com.example.builtin", "1.0.0");
    // A record exists but the archive on disk is not a valid plugin.
    std::fs::write(fixture.user_dir.join("broken.lnplugin"), b"not a zip").unwrap();
    fixture
      .db
      .write(|conn| {
        repo::insert_user_archive(
          conn,
          &crate::domain::plugin_catalog::UserPluginArchive {
            content_digest: "c".repeat(64),
            plugin_id: "com.example.broken".into(),
            version: "1.0.0".into(),
            runtime_kind: RuntimeKind::WasmComponent,
            manifest_json: "{}".into(),
            permission_request_digest: "p".repeat(64),
            file_name: "broken.lnplugin".into(),
            installed_at: "t0".into(),
          },
        )
      })
      .unwrap();
    let catalog = catalog_for(&fixture, true);
    let summary = catalog.refresh().unwrap();
    assert_eq!(summary.built_in, 1);
    assert_eq!(summary.user, 0);
    assert_eq!(summary.invalid, 1);
    assert_eq!(catalog.errors()[0].source, PluginSource::User);
    assert!(catalog.resolve_default("com.example.builtin").is_some());
  }

  #[test]
  fn builtin_is_default_without_database_policy() {
    let fixture = fixture();
    write_plugin_dir(&fixture.built_in_dir, "com.example.builtin", "1.0.0");
    let catalog = catalog_for(&fixture, true);
    catalog.refresh().unwrap();

    assert!(fixture.db.read(repo::list_default_overrides).unwrap().is_empty());
    let resolved = catalog
      .resolve_default("com.example.builtin")
      .expect("built-in default");
    assert_eq!(resolved.descriptor.source, PluginSource::BuiltIn);
    assert_eq!(
      catalog.default_digest("com.example.builtin"),
      Some(resolved.descriptor.content_digest)
    );
  }

  #[test]
  fn user_default_override_changes_new_instances_only() {
    let fixture = fixture();
    write_plugin_dir(&fixture.built_in_dir, "com.example.builtin", "1.0.0");
    let catalog = catalog_for(&fixture, true);
    let user_digest = install_user_archive(&fixture, &catalog, "user.lnplugin", "com.example.other", "2.0.0");
    catalog.refresh().unwrap();

    // An existing instance stays pinned to the built-in digest.
    let built_in_digest = catalog
      .resolve_default("com.example.builtin")
      .unwrap()
      .descriptor
      .content_digest;
    fixture
      .db
      .write(|conn| {
        conn.execute(
          "INSERT INTO integration_instances (
             id, plugin_id, plugin_version, display_name, enabled, config_json,
             config_schema_version, health_status, runtime_kind, package_digest,
             execution_grant_set_revision, runtime_state, created_at, updated_at
           ) VALUES (
             'inst-1', 'com.example.builtin', '1.0.0', 'Pinned', 1, '{}',
             1, 'ready', 'wasm-component', ?1, 1, 'active', 't0', 't1'
           )",
          rusqlite::params![built_in_digest],
        )?;
        Ok(())
      })
      .unwrap();

    let stored = catalog.set_user_default("com.example.other", &user_digest).unwrap();
    assert_eq!(stored.content_digest, user_digest);
    assert_eq!(catalog.default_digest("com.example.other"), Some(user_digest));
    assert_eq!(
      catalog.resolve_default("com.example.other").unwrap().descriptor.source,
      PluginSource::User
    );

    // The existing instance pin is unchanged, and the built-in default is unchanged.
    let pinned: String = fixture
      .db
      .read(|conn| {
        Ok(conn.query_row(
          "SELECT package_digest FROM integration_instances WHERE id = 'inst-1'",
          [],
          |row| row.get(0),
        )?)
      })
      .unwrap();
    assert_eq!(pinned, built_in_digest);
    assert_eq!(catalog.default_digest("com.example.builtin"), Some(built_in_digest));
  }

  #[test]
  fn missing_override_falls_back_to_builtin() {
    let fixture = fixture();
    write_plugin_dir(&fixture.built_in_dir, "com.example.builtin", "1.0.0");
    let catalog = catalog_for(&fixture, true);
    let user_digest = install_user_archive(&fixture, &catalog, "user.lnplugin", "com.example.builtin", "2.0.0");
    catalog.refresh().unwrap();
    catalog.set_user_default("com.example.builtin", &user_digest).unwrap();
    assert_eq!(catalog.default_digest("com.example.builtin"), Some(user_digest.clone()));

    // Remove the override: the built-in content becomes the default again.
    catalog.clear_user_default("com.example.builtin").unwrap();
    let resolved = catalog
      .resolve_default("com.example.builtin")
      .expect("built-in default");
    assert_eq!(resolved.descriptor.source, PluginSource::BuiltIn);
    assert_ne!(resolved.descriptor.content_digest, user_digest);
  }

  #[test]
  fn builtin_wins_over_user_content_with_the_same_id_and_version() {
    let fixture = fixture();
    write_plugin_dir(&fixture.built_in_dir, "com.example.builtin", "1.0.0");
    let catalog = catalog_for(&fixture, true);
    // Same id/version with different content is a catalog conflict; built-in content wins.
    let conflicting_payload = b"\x00asm\x00\x00\x00";
    let path = fixture.user_dir.join("user.lnplugin");
    write_archive_with_artifact(&path, "com.example.builtin", "1.0.0", conflicting_payload);
    let loaded = catalog.loader().load_archive(PluginSource::User, &path).unwrap();
    fixture
      .db
      .write(|conn| {
        repo::insert_user_archive(
          conn,
          &crate::domain::plugin_catalog::UserPluginArchive {
            content_digest: loaded.descriptor.content_digest.clone(),
            plugin_id: loaded.descriptor.plugin_id.clone(),
            version: loaded.descriptor.version.clone(),
            runtime_kind: loaded.descriptor.runtime_kind,
            manifest_json: loaded.manifest_json.clone(),
            permission_request_digest: crate::domain::plugin_catalog::compute_permission_request_digest(
              &loaded.manifest,
            ),
            file_name: "user.lnplugin".into(),
            installed_at: "t0".into(),
          },
        )
      })
      .unwrap();
    let summary = catalog.refresh().unwrap();
    assert_eq!(summary.built_in, 1);
    assert_eq!(summary.user, 0);
    assert_eq!(summary.invalid, 1);
    assert_eq!(catalog.errors()[0].code, PluginLoadErrorCode::VersionConflict);
    assert_eq!(
      catalog
        .resolve_default("com.example.builtin")
        .unwrap()
        .descriptor
        .source,
      PluginSource::BuiltIn
    );
  }

  #[test]
  fn native_content_outside_builtin_is_rejected() {
    let fixture = fixture();
    let dir = fixture.development_dir.join("native");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
      dir.join("plugin.json"),
      manifest_json(
        "com.example.native",
        "1.0.0",
        "trusted-native-worker",
        "artifacts/plugin.wasm",
      ),
    )
    .unwrap();
    std::fs::create_dir_all(dir.join("artifacts")).unwrap();
    std::fs::write(dir.join("artifacts/plugin.wasm"), WASM).unwrap();
    let catalog = catalog_for(&fixture, true);
    let summary = catalog.refresh().unwrap();
    assert_eq!(summary.development, 0);
    assert_eq!(summary.invalid, 1);
    assert_eq!(catalog.errors()[0].code, PluginLoadErrorCode::NativeSourceRejected);
  }

  /// Reloading changed source content publishes a new immutable digest. The previous digest
  /// is never silently substituted: a pin to it fails closed, and the materialized bytes of
  /// the old snapshot stay byte-for-byte on disk.
  #[test]
  fn refresh_publishes_a_new_digest_and_never_substitutes_old_pinned_content() {
    const OTHER_WASM: &[u8] = b"\0asm\x01\x00\x00\x01";
    let fixture = fixture();
    write_plugin_dir(&fixture.built_in_dir, "com.example.reload", "1.0.0");
    let catalog = catalog_for(&fixture, false);
    catalog.refresh().unwrap();
    let first = catalog
      .resolve_default("com.example.reload")
      .expect("initial content is published");
    let first_digest = first.descriptor.content_digest.clone();
    let first_bytes = first.read_snapshot_file("artifacts/plugin.wasm").unwrap();
    let first_snapshot_dir = first.snapshot_dir.clone();

    write_plugin_dir_with_artifact(&fixture.built_in_dir, "com.example.reload", "1.0.0", OTHER_WASM);
    catalog.refresh().unwrap();
    let second = catalog
      .resolve_default("com.example.reload")
      .expect("changed content is published");
    assert_ne!(
      second.descriptor.content_digest, first_digest,
      "changed source content must publish a new content digest"
    );

    // No silent substitution: the previous digest is gone from the catalog.
    assert!(catalog.snapshot_optional(&first_digest).is_none());
    // The materialized snapshot stays immutable on disk.
    assert_eq!(
      std::fs::read(first_snapshot_dir.join("artifacts/plugin.wasm")).unwrap(),
      first_bytes
    );
  }

  /// A user archive whose file no longer matches its recorded digest is isolated as an error
  /// and never published as executable content.
  #[test]
  fn user_archive_digest_drift_is_isolated() {
    let fixture = fixture();
    let catalog = catalog_for(&fixture, false);
    let digest = install_user_archive(&fixture, &catalog, "user.lnplugin", "com.example.user", "1.0.0");
    catalog.refresh().unwrap();
    assert!(catalog.snapshot_optional(&digest).is_some());

    // Replace the archive file with different content after installation.
    write_archive_with_artifact(
      &fixture.user_dir.join("user.lnplugin"),
      "com.example.user",
      "1.0.0",
      b"\0asm\x01\x00\x00\x02",
    );
    let summary = catalog.refresh().unwrap();
    assert_eq!(summary.user, 0);
    assert_eq!(summary.invalid, 1);
    let errors = catalog.errors();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, PluginLoadErrorCode::DigestMismatch);
    assert_eq!(errors[0].plugin_id, "com.example.user");
    assert!(
      catalog.snapshot_optional(&digest).is_none(),
      "drifted archive content must not be published"
    );
  }
}
