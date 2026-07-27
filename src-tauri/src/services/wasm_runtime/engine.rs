// ABOUTME: Shared Wasmtime Engine configuration with Component Model, async, fuel, epoch
// ABOUTME: interruption, on-disk compilation cache, and pooling allocation.
// Bounded by named host constants; the config revision covers every security-relevant constant.
use sha2::{Digest, Sha256};
use wasmtime::{Cache, CacheConfig, Config, Engine, InstanceAllocationStrategy, OptLevel, PoolingAllocationConfig};

/// Pinned Wasmtime runtime version. Cache identity and API conformance gate any upgrade.
pub const WASMTIME_VERSION: &str = "47.0.2";

/// Maximum concurrently allocated component instances in the pooling allocator.
pub const POOL_MAX_COMPONENT_INSTANCES: u32 = 32;
/// Total async stacks pooled across all instances (one per concurrent async call).
pub const POOL_TOTAL_STACKS: u32 = 32;
/// Async stack size in bytes (2 MiB). Must exceed worst-case guest stack depth.
pub const POOL_ASYNC_STACK_SIZE: usize = 2 * 1024 * 1024;
/// Maximum wasm stack size in bytes (512 KiB). Must not exceed `POOL_ASYNC_STACK_SIZE`.
pub const POOL_MAX_WASM_STACK_BYTES: usize = 512 * 1024;
/// Maximum component instance metadata size in bytes (1 MiB).
pub const POOL_MAX_COMPONENT_INSTANCE_SIZE: usize = 1024 * 1024;
/// Maximum core instance metadata size in bytes (1 MiB).
pub const POOL_MAX_CORE_INSTANCE_SIZE: usize = 1024 * 1024;
/// Maximum linear memories a single core module may define.
pub const POOL_MAX_MEMORIES_PER_COMPONENT: u32 = 1;
/// Maximum tables a single core module may define.
pub const POOL_MAX_TABLES_PER_COMPONENT: u32 = 4;
/// Soft limit on cached compiled-Component artifacts in the on-disk cache.
pub const CACHE_FILE_COUNT_SOFT_LIMIT: u64 = 64;
/// Soft limit on total bytes used by cached compiled-Component artifacts.
pub const CACHE_FILES_TOTAL_SIZE_SOFT_LIMIT: u64 = 128 * 1024 * 1024;

/// Shared Wasmtime engine and its configuration revision. The revision is part of compiled
/// Component cache identity (see [`super::cache`]); changing any security-relevant limit or
/// feature changes the revision and invalidates prior cached artifacts.
pub struct WasmEngine {
  engine: Engine,
  config_revision: u64,
}

impl WasmEngine {
  /// Build the shared engine with the Phase 2 configuration. Enables Component Model, async
  /// support, fuel consumption, epoch interruption, the on-disk compilation cache, and a
  /// pooling allocator bounded by the named constants above. Never enables WASI.
  pub fn new() -> wasmtime::Result<Self> {
    let mut config = Config::new();
    config.wasm_component_model(true);
    config.consume_fuel(true);
    config.epoch_interruption(true);
    config.cranelift_opt_level(OptLevel::Speed);
    // Enable the Wasmtime on-disk compilation cache (untrusted optimization; digest
    // verification always overrides any cached artifact). Bounded by named soft limits so
    // the cache cannot grow unbounded. Cache creation is best-effort: if the host cannot
    // create the cache directory, compilation proceeds without on-disk caching.
    config.cache(build_compilation_cache());

    // Async stack sizing: the wasm stack must not exceed the async stack. Both are bounded so a
    // guest cannot exhaust host stack beyond the pooled reservation.
    config.max_wasm_stack(POOL_MAX_WASM_STACK_BYTES);
    config.async_stack_size(POOL_ASYNC_STACK_SIZE);

    let mut pooling = PoolingAllocationConfig::new();
    pooling
      .total_component_instances(POOL_MAX_COMPONENT_INSTANCES)
      .total_core_instances(POOL_MAX_COMPONENT_INSTANCES)
      .total_memories(POOL_MAX_COMPONENT_INSTANCES)
      .total_tables(POOL_MAX_COMPONENT_INSTANCES * POOL_MAX_TABLES_PER_COMPONENT)
      .total_stacks(POOL_TOTAL_STACKS)
      .max_tables_per_module(POOL_MAX_TABLES_PER_COMPONENT)
      .max_memories_per_module(POOL_MAX_MEMORIES_PER_COMPONENT)
      .table_elements(super::store::STORE_TABLE_MAX_ELEMENTS)
      .max_memory_size(super::store::STORE_MEMORY_MAX_BYTES)
      .max_component_instance_size(POOL_MAX_COMPONENT_INSTANCE_SIZE)
      .max_core_instance_size(POOL_MAX_CORE_INSTANCE_SIZE);
    config.allocation_strategy(InstanceAllocationStrategy::Pooling(pooling));

    let config_revision = compute_config_revision();
    let engine = Engine::new(&config)?;
    Ok(Self {
      engine,
      config_revision,
    })
  }

  pub fn engine(&self) -> &Engine {
    &self.engine
  }

  /// Stable revision of the engine configuration, feature set, and named limits. Part of cache
  /// identity; changes invalidate compiled Component cache entries. Covers every
  /// security-relevant constant defined in this module and [`super::store`].
  pub fn config_revision(&self) -> u64 {
    self.config_revision
  }

  /// Advance the engine epoch by one tick. Stores configured with
  /// `epoch_deadline_async_yield_and_update` yield to the async caller at each deadline and
  /// re-arm, so a bounded ticker prevents infinite guest loops from monopolizing a worker.
  pub fn increment_epoch(&self) {
    self.engine.increment_epoch();
  }
}

/// Build the Wasmtime on-disk compilation cache with bounded soft limits. Returns `None` if
/// the cache directory cannot be created (e.g. restricted environment); compilation then
/// proceeds without on-disk caching. The cache is an untrusted optimization and never
/// replaces digest verification.
fn build_compilation_cache() -> Option<Cache> {
  let mut cache_config = CacheConfig::new();
  cache_config.with_file_count_soft_limit(CACHE_FILE_COUNT_SOFT_LIMIT);
  cache_config.with_files_total_size_soft_limit(CACHE_FILES_TOTAL_SIZE_SOFT_LIMIT);
  match Cache::new(cache_config) {
    Ok(cache) => Some(cache),
    Err(error) => {
      log::warn!("wasmtime compilation cache disabled: {error}");
      None
    }
  }
}

/// Compute a stable revision over the Wasmtime version, enabled features, and every named
/// limit. Changing any input changes the revision and invalidates cached compiled Components.
/// Every security-relevant constant in this module and [`super::store`] is included.
fn compute_config_revision() -> u64 {
  let mut hasher = Sha256::new();
  hasher.update(b"wasmtime=");
  hasher.update(WASMTIME_VERSION.as_bytes());
  hasher.update(b";features=component-model,async,fuel,epoch,cache,cranelift,pooling,no-wasi");
  hasher.update(b";store_limits=");
  let store_limits = format!(
    "mem={} tables={} instances={} memories={} table_max={} fuel={} epoch_deadline={} epoch_yield={} trap_on_grow=true",
    super::store::STORE_MEMORY_MAX_BYTES,
    super::store::STORE_TABLE_MAX_ELEMENTS,
    super::store::STORE_MAX_INSTANCES,
    super::store::STORE_MAX_MEMORIES,
    super::store::STORE_MAX_TABLES,
    super::store::STORE_DEFAULT_FUEL,
    super::store::STORE_DEFAULT_EPOCH_DEADLINE,
    super::store::STORE_DEFAULT_EPOCH_YIELD_DELTA,
  );
  hasher.update(store_limits.as_bytes());
  hasher.update(b";pool_limits=");
  let pool_limits = format!(
    "instances={} stacks={} async_stack={} wasm_stack={} component_inst_size={} core_inst_size={} mems_per_mod={} tables_per_mod={}",
    POOL_MAX_COMPONENT_INSTANCES,
    POOL_TOTAL_STACKS,
    POOL_ASYNC_STACK_SIZE,
    POOL_MAX_WASM_STACK_BYTES,
    POOL_MAX_COMPONENT_INSTANCE_SIZE,
    POOL_MAX_CORE_INSTANCE_SIZE,
    POOL_MAX_MEMORIES_PER_COMPONENT,
    POOL_MAX_TABLES_PER_COMPONENT,
  );
  hasher.update(pool_limits.as_bytes());
  hasher.update(b";cache_limits=");
  let cache_limits = format!(
    "file_count_soft={} total_size_soft={}",
    CACHE_FILE_COUNT_SOFT_LIMIT, CACHE_FILES_TOTAL_SIZE_SOFT_LIMIT,
  );
  hasher.update(cache_limits.as_bytes());
  hasher.update(b";opt_level=speed");
  let digest = hasher.finalize();
  let mut bytes = [0u8; 8];
  bytes.copy_from_slice(&digest[..8]);
  u64::from_le_bytes(bytes)
}

/// Canonical host target triple used in compiled Component cache identity. Uses
/// `target_lexicon::HOST`, which yields the complete `arch-vendor-os[-env]` triple (e.g.
/// `x86_64-pc-windows-msvc`, `aarch64-unknown-linux-gnu`), so cache entries are never shared
/// across incompatible targets or ABIs. `std::env::consts::{ARCH,OS}` is incomplete (it omits
/// the vendor and the environment/ABI segment such as `msvc`/`gnu`/`musl`).
pub fn host_target_triple() -> String {
  target_lexicon::HOST.to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn config_revision_is_stable() {
    let a = compute_config_revision();
    let b = compute_config_revision();
    assert_eq!(a, b);
  }

  #[test]
  fn host_target_triple_matches_target_lexicon_host() {
    let triple = host_target_triple();
    // Must equal the canonical target-lexicon HOST triple (full arch-vendor-os[-env]).
    assert_eq!(triple, target_lexicon::HOST.to_string());
    // Must contain the host operating system component.
    let os = target_lexicon::HOST.operating_system.to_string();
    assert!(!os.is_empty());
    assert!(triple.contains(&os), "triple {triple} must contain host OS {os}");
    // When the host has a non-None environment/ABI (msvc/gnu/musl/...), the triple must carry it.
    // This is the core fix: std::env::consts dropped this segment, causing cross-ABI cache sharing.
    let env = target_lexicon::HOST.environment;
    if env != target_lexicon::Environment::None {
      let env_str = env.to_string();
      assert!(
        triple.contains(&env_str),
        "triple {triple} must contain host environment/ABI {env_str}"
      );
    }
    // The triple must have at least 3 dash-separated components (arch-vendor-os) and a 4th when
    // the environment is present.
    let parts: Vec<&str> = triple.split('-').collect();
    assert!(parts.len() >= 3, "triple must have >=3 components: {triple}");
    assert!(!parts[0].is_empty());
  }
}
