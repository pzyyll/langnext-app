// ABOUTME: Compiled Component cache: bounded LRU store of serialized Components keyed by a
// ABOUTME: deterministic identity (package + artifact digests + host API + Wasmtime + config + target).
//! Host-level compiled Component cache. Stores serialized `Component` artifacts keyed by a
//! deterministic identity derived from the package digest, component artifact digest, host API
//! version, Wasmtime version, engine configuration revision, and target triple. The cache is
//! bounded by a named entry limit with LRU eviction; artifacts are untrusted optimizations and
//! never replace digest verification. Disposable: dropping the cache releases all stored artifacts.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;

use crate::domain::runtime_plugin::{ComponentArtifactDigest, PackageDigest};

/// Host plugin API version included in cache identity. Mirrors the Phase 0 host major/minor.
pub const CACHE_HOST_API_VERSION: &str = "1.0";
/// Maximum compiled Component artifacts retained in the host-level cache.
pub const CACHE_MAX_ENTRIES: usize = 32;

/// One cached serialized Component artifact with an LRU generation counter.
struct CacheEntry {
  serialized: Vec<u8>,
  last_access: u64,
}

/// Bounded LRU cache of serialized compiled Components. Thread-safe via a `Mutex`. Disposable:
/// dropping releases all stored artifacts. The cache never replaces digest verification; a
/// caller must always re-verify the original package and artifact digests before trusting a
/// cached artifact.
pub struct CompiledComponentCache {
  entries: Mutex<HashMap<String, CacheEntry>>,
  max_entries: usize,
  generation: Mutex<u64>,
}

impl CompiledComponentCache {
  /// Create a bounded cache with the given maximum entry count.
  pub fn new(max_entries: usize) -> Self {
    Self {
      entries: Mutex::new(HashMap::new()),
      max_entries,
      generation: Mutex::new(0),
    }
  }

  /// Look up a serialized Component by cache identity. Returns `Some(bytes)` on hit (and
  /// updates the LRU access time), or `None` on miss. The caller must deserialize with the
  /// same engine configuration that produced the identity.
  pub fn lookup(&self, identity: &str) -> Option<Vec<u8>> {
    let mut generation = self.generation.lock().expect("cache generation poisoned");
    *generation += 1;
    let current = *generation;
    drop(generation);
    let mut entries = self.entries.lock().expect("cache entries poisoned");
    if let Some(entry) = entries.get_mut(identity) {
      entry.last_access = current;
      Some(entry.serialized.clone())
    } else {
      None
    }
  }

  /// Insert a serialized Component. If the cache is full, evict the least-recently-used entry
  /// before inserting. No-op if `identity` already exists (the existing entry is kept).
  pub fn insert(&self, identity: String, serialized: Vec<u8>) {
    let mut generation = self.generation.lock().expect("cache generation poisoned");
    *generation += 1;
    let current = *generation;
    drop(generation);
    let mut entries = self.entries.lock().expect("cache entries poisoned");
    if entries.contains_key(&identity) {
      return;
    }
    if entries.len() >= self.max_entries {
      // Evict the least-recently-used entry.
      if let Some(evict_key) = entries
        .iter()
        .min_by_key(|(_, entry)| entry.last_access)
        .map(|(key, _)| key.clone())
      {
        entries.remove(&evict_key);
      }
    }
    entries.insert(
      identity,
      CacheEntry {
        serialized,
        last_access: current,
      },
    );
  }

  /// Number of cached artifacts.
  pub fn len(&self) -> usize {
    self.entries.lock().expect("cache entries poisoned").len()
  }

  /// Whether the cache is empty.
  pub fn is_empty(&self) -> bool {
    self.len() == 0
  }
}

impl Default for CompiledComponentCache {
  fn default() -> Self {
    Self::new(CACHE_MAX_ENTRIES)
  }
}

/// Compute the deterministic cache identity for a compiled Component. The identity changes with
/// every security-relevant input: package digest (archive), component artifact digest (file
/// bytes), host API version, Wasmtime version, engine configuration revision, and target triple.
/// Cache entries are untrusted optimizations: a caller must always re-verify both digests before
/// trusting a cached artifact. Same package with different artifacts must never share a key.
pub fn component_cache_identity(
  package_digest: &PackageDigest,
  artifact_digest: &ComponentArtifactDigest,
  host_api_version: &str,
  wasmtime_version: &str,
  config_revision: u64,
  target_triple: &str,
) -> String {
  let mut hasher = Sha256::new();
  hasher.update(b"package_digest=");
  hasher.update(package_digest.as_str().as_bytes());
  hasher.update(b";artifact_digest=");
  hasher.update(artifact_digest.as_str().as_bytes());
  hasher.update(b";host_api=");
  hasher.update(host_api_version.as_bytes());
  hasher.update(b";wasmtime=");
  hasher.update(wasmtime_version.as_bytes());
  hasher.update(b";config_revision=");
  hasher.update(config_revision.to_le_bytes());
  hasher.update(b";target=");
  hasher.update(target_triple.as_bytes());
  let digest = hasher.finalize();
  digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn package_a() -> PackageDigest {
    PackageDigest::parse("0000000000000000000000000000000000000000000000000000000000000000").unwrap()
  }
  fn package_b() -> PackageDigest {
    PackageDigest::parse("1111111111111111111111111111111111111111111111111111111111111111").unwrap()
  }
  fn artifact_a() -> ComponentArtifactDigest {
    ComponentArtifactDigest::parse("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap()
  }
  fn artifact_b() -> ComponentArtifactDigest {
    ComponentArtifactDigest::parse("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").unwrap()
  }

  #[test]
  fn cache_identity_is_deterministic_for_same_inputs() {
    let a = component_cache_identity(
      &package_a(),
      &artifact_a(),
      "1.0",
      "47.0.2",
      42,
      "x86_64-unknown-windows",
    );
    let b = component_cache_identity(
      &package_a(),
      &artifact_a(),
      "1.0",
      "47.0.2",
      42,
      "x86_64-unknown-windows",
    );
    assert_eq!(a, b);
    assert_eq!(a.len(), 64);
  }

  #[test]
  fn cache_identity_changes_with_every_security_relevant_input() {
    let base = component_cache_identity(
      &package_a(),
      &artifact_a(),
      "1.0",
      "47.0.2",
      42,
      "x86_64-unknown-windows",
    );
    assert_ne!(
      base,
      component_cache_identity(
        &package_b(),
        &artifact_a(),
        "1.0",
        "47.0.2",
        42,
        "x86_64-unknown-windows"
      )
    );
    assert_ne!(
      base,
      component_cache_identity(
        &package_a(),
        &artifact_b(),
        "1.0",
        "47.0.2",
        42,
        "x86_64-unknown-windows"
      ),
      "same package with a different artifact digest must isolate cache entries"
    );
    assert_ne!(
      base,
      component_cache_identity(
        &package_a(),
        &artifact_a(),
        "2.0",
        "47.0.2",
        42,
        "x86_64-unknown-windows"
      )
    );
    assert_ne!(
      base,
      component_cache_identity(
        &package_a(),
        &artifact_a(),
        "1.0",
        "47.0.3",
        42,
        "x86_64-unknown-windows"
      )
    );
    assert_ne!(
      base,
      component_cache_identity(
        &package_a(),
        &artifact_a(),
        "1.0",
        "47.0.2",
        43,
        "x86_64-unknown-windows"
      )
    );
    assert_ne!(
      base,
      component_cache_identity(&package_a(), &artifact_a(), "1.0", "47.0.2", 42, "aarch64-apple-darwin")
    );
  }

  #[test]
  fn compiled_cache_lookup_miss_then_hit() {
    let cache = CompiledComponentCache::new(4);
    let identity = component_cache_identity(
      &package_a(),
      &artifact_a(),
      "1.0",
      "47.0.2",
      1,
      "x86_64-unknown-windows",
    );
    assert!(cache.lookup(&identity).is_none());
    cache.insert(identity.clone(), b"artifact".to_vec());
    assert_eq!(cache.lookup(&identity).unwrap(), b"artifact");
    assert_eq!(cache.len(), 1);
  }

  #[test]
  fn compiled_cache_evicts_lru_when_full() {
    let cache = CompiledComponentCache::new(2);
    let id_a = component_cache_identity(
      &package_a(),
      &artifact_a(),
      "1.0",
      "47.0.2",
      1,
      "x86_64-unknown-windows",
    );
    let id_b = component_cache_identity(
      &package_b(),
      &artifact_a(),
      "1.0",
      "47.0.2",
      1,
      "x86_64-unknown-windows",
    );
    let id_c = component_cache_identity(
      &PackageDigest::parse("2222222222222222222222222222222222222222222222222222222222222222").unwrap(),
      &artifact_a(),
      "1.0",
      "47.0.2",
      1,
      "x86_64-unknown-windows",
    );
    cache.insert(id_a.clone(), b"a".to_vec());
    cache.insert(id_b.clone(), b"b".to_vec());
    // Access A so B becomes LRU.
    assert_eq!(cache.lookup(&id_a).unwrap(), b"a");
    cache.insert(id_c.clone(), b"c".to_vec());
    // B should have been evicted; A and C remain.
    assert!(cache.lookup(&id_b).is_none());
    assert!(cache.lookup(&id_a).is_some());
    assert!(cache.lookup(&id_c).is_some());
    assert_eq!(cache.len(), 2);
  }

  #[test]
  fn compiled_cache_is_disposable() {
    let cache = CompiledComponentCache::new(4);
    let identity = component_cache_identity(
      &package_a(),
      &artifact_a(),
      "1.0",
      "47.0.2",
      1,
      "x86_64-unknown-windows",
    );
    cache.insert(identity, b"artifact".to_vec());
    assert_eq!(cache.len(), 1);
    drop(cache);
  }

  #[test]
  fn cache_identity_rejects_non_lowercase_hex_digest() {
    assert!(PackageDigest::parse("ABCDEF0000000000000000000000000000000000000000000000000000000000").is_err());
    assert!(ComponentArtifactDigest::parse("xyz").is_err());
  }
}
