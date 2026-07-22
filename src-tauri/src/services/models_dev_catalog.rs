// ABOUTME: Cached models.dev catalog used to seed model capability overrides on sync.
// ABOUTME: Fetches https://models.dev/models.json at most once per 24h and maps modalities/limits.
use crate::domain::model::CapabilityOverridesV1;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as AsyncMutex;

/// Upstream models.dev catalog endpoint.
const MODELS_DEV_URL: &str = "https://models.dev/models.json";
/// On-disk cache file name under the app cache directory.
const CACHE_FILE_NAME: &str = "models-dev-catalog.json";
/// Refresh the remote catalog only after this age.
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Bound remote catalog HTTP time so model sync is not blocked indefinitely.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Soft cap on accepted catalog body size (10 MiB).
const MAX_CATALOG_BYTES: usize = 10 * 1024 * 1024;
/// User-Agent for the catalog request.
const USER_AGENT: &str = "langnext-app/0.1 (models.dev catalog)";

/// In-memory + disk-backed models.dev catalog for capability seeding.
#[derive(Clone)]
pub struct ModelsDevCatalog {
  cache_path: PathBuf,
  state: Arc<AsyncMutex<CatalogState>>,
}

#[derive(Default)]
struct CatalogState {
  /// Shared index when loaded (fresh or stale).
  index: Option<Arc<CatalogIndex>>,
  /// Unix seconds when the current index was fetched from network (or restored from disk).
  fetched_at_unix: u64,
}

/// Lookup indexes built from a models.dev snapshot.
#[derive(Debug, Clone)]
struct CatalogIndex {
  /// Full catalog ids (`openai/gpt-4o`).
  by_full_id: HashMap<String, CatalogModel>,
  /// Bare model keys (`gpt-4o`).
  by_bare_key: HashMap<String, CatalogModel>,
  /// Lowercased bare keys for case-insensitive fallback.
  by_bare_key_lower: HashMap<String, CatalogModel>,
}

/// Capability-relevant slice of a models.dev model entry.
#[derive(Debug, Clone, Default)]
struct CatalogModel {
  text: bool,
  image: bool,
  pdf: bool,
  video: bool,
  context: Option<u32>,
  output: Option<u32>,
}

/// Disk cache envelope so TTL survives process restarts.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiskCache {
  fetched_at_unix: u64,
  /// Raw models.dev payload: `"provider/model" -> entry`.
  models: HashMap<String, ModelsDevEntry>,
}

/// Minimal models.dev entry shape (unknown fields ignored).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ModelsDevEntry {
  #[serde(default)]
  modalities: ModelsDevModalities,
  #[serde(default)]
  limit: ModelsDevLimit,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ModelsDevModalities {
  #[serde(default)]
  input: Vec<String>,
  #[serde(default)]
  output: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ModelsDevLimit {
  #[serde(default)]
  context: Option<u64>,
  #[serde(default)]
  output: Option<u64>,
}

impl ModelsDevCatalog {
  /// Create a catalog cache rooted at `cache_dir` (created on first write).
  pub fn new(cache_dir: impl Into<PathBuf>) -> Self {
    let cache_dir = cache_dir.into();
    Self {
      cache_path: cache_dir.join(CACHE_FILE_NAME),
      state: Arc::new(AsyncMutex::new(CatalogState::default())),
    }
  }

  /// Write a fresh empty on-disk cache so the next lookup skips the network.
  ///
  /// Used by tests (and any offline bootstrap) to avoid a models.dev round-trip.
  pub fn seed_fresh_empty_cache(cache_dir: impl AsRef<Path>) -> Result<(), String> {
    let path = cache_dir.as_ref().join(CACHE_FILE_NAME);
    write_disk_cache(
      &path,
      &DiskCache {
        fetched_at_unix: unix_now_secs(),
        models: HashMap::new(),
      },
    )
  }

  /// Resolve capability overrides for a remote model key.
  ///
  /// Uses the cached models.dev catalog when available; falls back to defaults when the
  /// model is unknown or the catalog cannot be loaded.
  pub async fn capabilities_for_model_key(&self, model_key: &str) -> CapabilityOverridesV1 {
    match self.ensure_index().await {
      Some(index) => index
        .lookup(model_key)
        .map(|model| model.to_capability_overrides())
        .unwrap_or_else(default_capabilities),
      None => default_capabilities(),
    }
  }

  /// Ensure an index is loaded, refreshing from network when the 24h TTL expires.
  async fn ensure_index(&self) -> Option<Arc<CatalogIndex>> {
    let mut state = self.state.lock().await;
    let now = unix_now_secs();

    if let Some(index) = state.index.as_ref() {
      if now.saturating_sub(state.fetched_at_unix) < CACHE_TTL.as_secs() {
        return Some(Arc::clone(index));
      }
    } else if let Some(disk) = load_disk_cache(&self.cache_path) {
      let index = Arc::new(CatalogIndex::from_entries(&disk.models));
      state.fetched_at_unix = disk.fetched_at_unix;
      state.index = Some(Arc::clone(&index));
      if now.saturating_sub(disk.fetched_at_unix) < CACHE_TTL.as_secs() {
        return Some(index);
      }
    }

    match fetch_remote_catalog().await {
      Ok(models) => {
        let disk = DiskCache {
          fetched_at_unix: now,
          models,
        };
        if let Err(err) = write_disk_cache(&self.cache_path, &disk) {
          log::warn!("models_dev_cache_write_failed error={err}");
        }
        let index = Arc::new(CatalogIndex::from_entries(&disk.models));
        state.fetched_at_unix = now;
        state.index = Some(Arc::clone(&index));
        Some(index)
      }
      Err(err) => {
        log::warn!("models_dev_fetch_failed error={err}");
        // Prefer any previously loaded (possibly stale) index over defaults-only.
        state.index.clone()
      }
    }
  }
}

impl CatalogIndex {
  fn from_entries(entries: &HashMap<String, ModelsDevEntry>) -> Self {
    let mut by_full_id = HashMap::with_capacity(entries.len());
    let mut by_bare_key: HashMap<String, CatalogModel> = HashMap::with_capacity(entries.len());
    let mut by_bare_key_lower: HashMap<String, CatalogModel> = HashMap::with_capacity(entries.len());

    for (full_id, entry) in entries {
      let model = CatalogModel::from_entry(entry);
      by_full_id.insert(full_id.clone(), model.clone());

      let bare = bare_model_key(full_id);
      merge_into_map(&mut by_bare_key, bare.to_string(), &model);
      merge_into_map(&mut by_bare_key_lower, bare.to_ascii_lowercase(), &model);
    }

    Self {
      by_full_id,
      by_bare_key,
      by_bare_key_lower,
    }
  }

  fn lookup(&self, model_key: &str) -> Option<&CatalogModel> {
    let key = model_key.trim();
    if key.is_empty() {
      return None;
    }
    if let Some(model) = self.by_full_id.get(key) {
      return Some(model);
    }
    if let Some(model) = self.by_bare_key.get(key) {
      return Some(model);
    }
    if let Some((_, bare)) = key.split_once('/') {
      if let Some(model) = self.by_bare_key.get(bare) {
        return Some(model);
      }
      if let Some(model) = self.by_bare_key_lower.get(&bare.to_ascii_lowercase()) {
        return Some(model);
      }
    }
    self.by_bare_key_lower.get(&key.to_ascii_lowercase())
  }
}

impl CatalogModel {
  fn from_entry(entry: &ModelsDevEntry) -> Self {
    let mut text = false;
    let mut image = false;
    let mut pdf = false;
    let mut video = false;
    for modality in &entry.modalities.input {
      match modality.to_ascii_lowercase().as_str() {
        "text" => text = true,
        "image" => image = true,
        "pdf" => pdf = true,
        "video" => video = true,
        _ => {}
      }
    }
    // Catalog entries without input modalities still count as text-capable.
    if entry.modalities.input.is_empty() {
      text = true;
    }
    Self {
      text,
      image,
      pdf,
      video,
      context: clamp_token_limit(entry.limit.context),
      output: clamp_token_limit(entry.limit.output),
    }
  }

  fn merge_with(&mut self, other: &Self) {
    self.text |= other.text;
    self.image |= other.image;
    self.pdf |= other.pdf;
    self.video |= other.video;
    self.context = max_opt(self.context, other.context);
    self.output = max_opt(self.output, other.output);
  }

  fn to_capability_overrides(&self) -> CapabilityOverridesV1 {
    let max_context_tokens = self
      .context
      .unwrap_or(CapabilityOverridesV1::DEFAULT_MAX_CONTEXT_TOKENS);
    let max_output_tokens = self
      .output
      .unwrap_or(CapabilityOverridesV1::DEFAULT_MAX_OUTPUT_TOKENS);
    CapabilityOverridesV1 {
      schema_version: CapabilityOverridesV1::SCHEMA_VERSION,
      streaming: None,
      max_context_tokens: Some(max_context_tokens),
      max_output_tokens: Some(max_output_tokens),
      // Seed request default to the model output cap so the editor/runtime stay aligned.
      default_output_tokens: Some(max_output_tokens),
      text_generation: Some(self.text),
      image_analysis: Some(self.image),
      pdf_analysis: Some(self.pdf),
      video_processing: Some(self.video),
    }
  }
}

/// Default capabilities when the model is missing from models.dev or the catalog is unavailable.
pub fn default_capabilities() -> CapabilityOverridesV1 {
  CapabilityOverridesV1 {
    schema_version: CapabilityOverridesV1::SCHEMA_VERSION,
    streaming: None,
    max_context_tokens: Some(CapabilityOverridesV1::DEFAULT_MAX_CONTEXT_TOKENS),
    max_output_tokens: Some(CapabilityOverridesV1::DEFAULT_MAX_OUTPUT_TOKENS),
    default_output_tokens: Some(CapabilityOverridesV1::DEFAULT_MAX_OUTPUT_TOKENS),
    text_generation: Some(true),
    image_analysis: Some(false),
    pdf_analysis: Some(false),
    video_processing: Some(false),
  }
}

fn bare_model_key(full_id: &str) -> &str {
  full_id.split('/').next_back().unwrap_or(full_id)
}

fn merge_into_map(map: &mut HashMap<String, CatalogModel>, key: String, model: &CatalogModel) {
  match map.get_mut(&key) {
    Some(existing) => existing.merge_with(model),
    None => {
      map.insert(key, model.clone());
    }
  }
}

fn max_opt(a: Option<u32>, b: Option<u32>) -> Option<u32> {
  match (a, b) {
    (Some(x), Some(y)) => Some(x.max(y)),
    (Some(x), None) => Some(x),
    (None, Some(y)) => Some(y),
    (None, None) => None,
  }
}

fn clamp_token_limit(value: Option<u64>) -> Option<u32> {
  value.and_then(|n| {
    if n == 0 {
      None
    } else if n > u64::from(u32::MAX) {
      Some(u32::MAX)
    } else {
      Some(n as u32)
    }
  })
}

fn unix_now_secs() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

fn load_disk_cache(path: &Path) -> Option<DiskCache> {
  let bytes = std::fs::read(path).ok()?;
  if bytes.len() > MAX_CATALOG_BYTES {
    log::warn!(
      "models_dev_cache_too_large path={} bytes={}",
      path.display(),
      bytes.len()
    );
    return None;
  }
  match serde_json::from_slice::<DiskCache>(&bytes) {
    Ok(cache) => Some(cache),
    Err(err) => {
      log::warn!("models_dev_cache_parse_failed path={} error={err}", path.display());
      None
    }
  }
}

fn write_disk_cache(path: &Path, cache: &DiskCache) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("create cache dir: {e}"))?;
  }
  let bytes = serde_json::to_vec(cache).map_err(|e| format!("serialize cache: {e}"))?;
  if bytes.len() > MAX_CATALOG_BYTES {
    return Err(format!("cache payload too large: {} bytes", bytes.len()));
  }
  // Atomic-ish replace via temp file in the same directory.
  let tmp_path = path.with_extension("json.tmp");
  std::fs::write(&tmp_path, &bytes).map_err(|e| format!("write temp cache: {e}"))?;
  std::fs::rename(&tmp_path, path).map_err(|e| format!("replace cache: {e}"))?;
  Ok(())
}

async fn fetch_remote_catalog() -> Result<HashMap<String, ModelsDevEntry>, String> {
  let client = reqwest::Client::builder()
    .timeout(FETCH_TIMEOUT)
    .user_agent(USER_AGENT)
    .build()
    .map_err(|e| format!("build http client: {e}"))?;

  let response = client
    .get(MODELS_DEV_URL)
    .send()
    .await
    .map_err(|e| format!("request failed: {e}"))?;

  if !response.status().is_success() {
    return Err(format!("http status {}", response.status()));
  }

  let bytes = response
    .bytes()
    .await
    .map_err(|e| format!("read body: {e}"))?;
  if bytes.len() > MAX_CATALOG_BYTES {
    return Err(format!("body too large: {} bytes", bytes.len()));
  }

  // models.dev returns a flat map of "provider/model" -> entry.
  serde_json::from_slice::<HashMap<String, ModelsDevEntry>>(&bytes)
    .map_err(|e| format!("parse body: {e}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bare_key_strips_provider_prefix() {
    assert_eq!(bare_model_key("openai/gpt-4o"), "gpt-4o");
    assert_eq!(bare_model_key("gpt-4o"), "gpt-4o");
  }

  #[test]
  fn catalog_model_maps_modalities_and_limits() {
    let entry = ModelsDevEntry {
      modalities: ModelsDevModalities {
        input: vec!["text".into(), "image".into(), "pdf".into()],
        output: vec!["text".into()],
      },
      limit: ModelsDevLimit {
        context: Some(128_000),
        output: Some(16_384),
      },
    };
    let caps = CatalogModel::from_entry(&entry).to_capability_overrides();
    assert_eq!(caps.text_generation, Some(true));
    assert_eq!(caps.image_analysis, Some(true));
    assert_eq!(caps.pdf_analysis, Some(true));
    assert_eq!(caps.video_processing, Some(false));
    assert_eq!(caps.max_context_tokens, Some(128_000));
    assert_eq!(caps.max_output_tokens, Some(16_384));
    assert_eq!(caps.default_output_tokens, Some(16_384));
  }

  #[test]
  fn lookup_prefers_full_id_then_bare_key() {
    let mut entries = HashMap::new();
    entries.insert(
      "openai/gpt-4o".into(),
      ModelsDevEntry {
        modalities: ModelsDevModalities {
          input: vec!["text".into(), "image".into()],
          output: vec!["text".into()],
        },
        limit: ModelsDevLimit {
          context: Some(128_000),
          output: Some(16_384),
        },
      },
    );
    let index = CatalogIndex::from_entries(&entries);
    assert!(index.lookup("openai/gpt-4o").is_some());
    assert!(index.lookup("gpt-4o").is_some());
    assert!(index.lookup("GPT-4O").is_some());
    assert!(index.lookup("missing-model").is_none());
  }

  #[test]
  fn disk_cache_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(CACHE_FILE_NAME);
    let mut models = HashMap::new();
    models.insert(
      "deepseek/deepseek-chat".into(),
      ModelsDevEntry {
        modalities: ModelsDevModalities {
          input: vec!["text".into()],
          output: vec!["text".into()],
        },
        limit: ModelsDevLimit {
          context: Some(128_000),
          output: Some(8_192),
        },
      },
    );
    let cache = DiskCache {
      fetched_at_unix: 1_700_000_000,
      models,
    };
    write_disk_cache(&path, &cache).unwrap();
    let loaded = load_disk_cache(&path).unwrap();
    assert_eq!(loaded.fetched_at_unix, 1_700_000_000);
    assert!(loaded.models.contains_key("deepseek/deepseek-chat"));
  }

  #[test]
  fn default_capabilities_match_domain_defaults() {
    let caps = default_capabilities();
    assert_eq!(
      caps.max_context_tokens,
      Some(CapabilityOverridesV1::DEFAULT_MAX_CONTEXT_TOKENS)
    );
    assert_eq!(
      caps.max_output_tokens,
      Some(CapabilityOverridesV1::DEFAULT_MAX_OUTPUT_TOKENS)
    );
    assert_eq!(caps.text_generation, Some(true));
    assert_eq!(caps.image_analysis, Some(false));
    assert_eq!(caps.pdf_analysis, Some(false));
    assert_eq!(caps.video_processing, Some(false));
  }
}
