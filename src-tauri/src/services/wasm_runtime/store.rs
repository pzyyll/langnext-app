// ABOUTME: Per-invocation host state, store/resource limits, and Store construction for the Wasm
// ABOUTME: Component runtime. A fresh Store<PluginHostState> is created per request; never reused.
use crate::domain::cancel::CancelToken;
use crate::domain::runtime_plugin::{ExecutionGrantSet, PluginPrincipal};
use crate::services::blob_resources::BlobResourceTable;
use crate::services::stream_resources::StreamResourceTable;
use std::time::{Duration, Instant};
use wasmtime::component::ResourceTable;
use wasmtime::{Engine, Store, StoreLimits, StoreLimitsBuilder};

use super::host::{BrokerHandle, LogBudget};

/// Maximum bytes a single guest linear memory may grow to (16 MiB).
pub const STORE_MEMORY_MAX_BYTES: usize = 16 * 1024 * 1024;
/// Maximum elements per guest table.
pub const STORE_TABLE_MAX_ELEMENTS: usize = 10_000;
/// Maximum core instances per store. A single component may instantiate a few core modules.
pub const STORE_MAX_INSTANCES: usize = 8;
/// Maximum linear memories per store.
pub const STORE_MAX_MEMORIES: usize = 2;
/// Maximum tables per store.
pub const STORE_MAX_TABLES: usize = 8;
/// Default fuel granted to a guest invocation. Guest CPU work beyond this traps.
pub const STORE_DEFAULT_FUEL: u64 = 10_000_000;
/// Default epoch deadline (ticks) for cooperative async yielding.
pub const STORE_DEFAULT_EPOCH_DEADLINE: u64 = 1;
/// Epoch delta re-applied after each async yield, bounding uninterrupted guest CPU slices.
pub const STORE_DEFAULT_EPOCH_YIELD_DELTA: u64 = 1;
/// Interval at which the shared engine epoch ticker advances the epoch. Bounds the granularity
/// of fuel/epoch interruption for infinite-loop detection.
pub const EPOCH_TICK_INTERVAL: Duration = Duration::from_millis(10);
/// Hard upper bound on a single broker import's wall-clock duration, even when no explicit
/// deadline is set. Prevents a missing deadline from hanging the host.
pub const BROKER_IMPORT_MAX_TIMEOUT: Duration = Duration::from_secs(30);
/// Default per-import timeout when no explicit request deadline is set. Shorter than
/// [`BROKER_IMPORT_MAX_TIMEOUT`] so imports without a deadline still bounded.
pub const BROKER_IMPORT_NO_DEADLINE_DEFAULT: Duration = Duration::from_secs(20);
/// Bounded grace period for a broker future to observe cancellation/deadline before the import
/// returns. Stream brokers use it to cancel, join, and if needed abort their pre-header task.
pub const BROKER_IMPORT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(4);

/// Per-invocation host state bound to one principal, grant set, cancellation, deadline, broker
/// handle, and resource table. A fresh `Store<PluginHostState>` is created per request; this
/// state is never persisted or reused across requests.
pub struct PluginHostState {
  /// Immutable execution principal for this request. Every host import re-validates against it.
  pub principal: PluginPrincipal,
  /// Approved execution grant set authority snapshot. Broker calls authorize here.
  pub grant: ExecutionGrantSet,
  /// Cooperative cancellation token. Imports check it and abort promptly.
  pub cancel: CancelToken,
  /// Wall-clock request deadline. Imports enforce it regardless of guest hints.
  pub deadline: Option<Instant>,
  /// Bounded structured-log policy (enforced on every `host.log`).
  pub log_budget: LogBudget,
  /// Broker handle. Phase 2 uses a conformance broker; Phase 5+ swaps in real transport.
  pub broker: Box<dyn BrokerHandle>,
  /// Wasmtime resource table mapping guest handle indices to host Blob/Stream resources.
  pub table: ResourceTable,
  /// Bounded blob bytes owned by this request (opaque to guests except via host imports).
  pub blobs: BlobResourceTable,
  /// Ordered stream pairs owned by this request.
  pub streams: StreamResourceTable,
  /// Per-store resource limits (memory/tables/instances). Applied via `Store::limiter`.
  pub limits: StoreLimits,
  /// Initial fuel granted to this invocation. Guest CPU work beyond this traps. Stored on the
  /// state so tests can override it (e.g. to prove epoch yielding with ample fuel).
  pub fuel: u64,
}

impl Drop for PluginHostState {
  fn drop(&mut self) {
    // Request completion / store drop: release all host-owned binary resources.
    self.blobs.clear();
    self.streams.clear();
  }
}

/// Build a fresh `Store<PluginHostState>` with resource limits, initial fuel, and an epoch
/// deadline configured for cooperative async yielding. The caller drives the engine epoch ticker
/// (see [`super::engine::WasmEngine::increment_epoch`]); fuel/epoch cannot preempt blocking host
/// imports, so imports must be independently timeout-bounded and cancellation-aware.
pub fn build_store(engine: &Engine, state: PluginHostState) -> Store<PluginHostState> {
  let mut store = Store::new(engine, state);
  // Inline closure so the expected `-> &mut dyn ResourceLimiter` return type is known and the
  // `&mut StoreLimits` unsized coercion fires (StoreLimits impls ResourceLimiter).
  store.limiter(|state: &mut PluginHostState| &mut state.limits);
  // Fuel is always enabled on the engine; ignore the inert error case. Use the per-state fuel
  // so tests can grant more fuel than the default (e.g. to isolate epoch-yield behavior).
  let fuel = store.data().fuel;
  let _ = store.set_fuel(fuel);
  store.set_epoch_deadline(STORE_DEFAULT_EPOCH_DEADLINE);
  // Yield to the async caller on epoch deadline and re-arm; the engine epoch ticker advances
  // deadlines so infinite loops eventually trap instead of monopolizing a worker.
  store.epoch_deadline_async_yield_and_update(STORE_DEFAULT_EPOCH_YIELD_DELTA);
  store
}

/// Construct the default per-store resource limits used by every invocation. Growth
/// failures (memory.grow/table.grow exceeding limits) trap deterministically so the host can
/// map them to a stable resource-limit error code instead of a silent -1 return.
pub fn default_store_limits() -> StoreLimits {
  StoreLimitsBuilder::new()
    .memory_size(STORE_MEMORY_MAX_BYTES)
    .table_elements(STORE_TABLE_MAX_ELEMENTS)
    .instances(STORE_MAX_INSTANCES)
    .memories(STORE_MAX_MEMORIES)
    .tables(STORE_MAX_TABLES)
    .trap_on_grow_failure(true)
    .build()
}

/// Build a `PluginHostState` from its required parts, installing default log budget, limits,
/// and the default fuel grant.
pub fn new_state(
  principal: PluginPrincipal,
  grant: ExecutionGrantSet,
  cancel: CancelToken,
  deadline: Option<Instant>,
  broker: Box<dyn BrokerHandle>,
) -> PluginHostState {
  new_state_with_fuel(principal, grant, cancel, deadline, broker, STORE_DEFAULT_FUEL)
}

/// Build a `PluginHostState` with an explicit fuel grant. Used by tests that need to isolate
/// fuel exhaustion from epoch yielding (e.g. grant ample fuel so only the epoch ticker +
/// deadline can interrupt an infinite guest).
pub fn new_state_with_fuel(
  principal: PluginPrincipal,
  grant: ExecutionGrantSet,
  cancel: CancelToken,
  deadline: Option<Instant>,
  broker: Box<dyn BrokerHandle>,
  fuel: u64,
) -> PluginHostState {
  PluginHostState {
    principal,
    grant,
    cancel,
    deadline,
    log_budget: LogBudget::default(),
    broker,
    table: ResourceTable::new(),
    blobs: BlobResourceTable::new(),
    streams: StreamResourceTable::new(),
    limits: default_store_limits(),
    fuel,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::plugin_resource::{ResourceCreateParams, ResourceDirection, ResourceOwner};
  use crate::domain::runtime_plugin::{
    CapabilityId, PackageDigest, PackageIdentity, PluginId, RuntimeIdentity, SemVerVersion,
  };
  use crate::services::wasm_runtime::host::{
    BrokerAuthorization, BrokerFetchError, BrokerFetchOutcome, BrokerFetchRequest,
  };
  use std::future::Future;
  use std::pin::Pin;
  use std::sync::Arc;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use uuid::Uuid;

  const STORE_DROP_ABORT_WAIT: Duration = Duration::from_secs(1);
  const STORE_DROP_TASK_COUNT: usize = 2;

  struct NoopBroker;

  impl BrokerHandle for NoopBroker {
    fn fetch(
      &self,
      _principal: &PluginPrincipal,
      _grant: &ExecutionGrantSet,
      _request: BrokerFetchRequest,
      _authorization: BrokerAuthorization,
      _cancel: &CancelToken,
      _deadline: Option<Instant>,
    ) -> Pin<Box<dyn Future<Output = BrokerFetchOutcome> + Send + '_>> {
      Box::pin(async { Err(BrokerFetchError::NotApproved) })
    }
  }

  struct AbortCounter(Arc<AtomicUsize>);

  impl Drop for AbortCounter {
    fn drop(&mut self) {
      self.0.fetch_add(1, Ordering::SeqCst);
    }
  }

  fn spawn_stubborn_task(
    started: tokio::sync::oneshot::Sender<()>,
    aborted: Arc<AtomicUsize>,
  ) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
      let _counter = AbortCounter(aborted);
      let _ = started.send(());
      std::future::pending::<()>().await;
    })
  }

  fn test_state() -> PluginHostState {
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Package(PackageIdentity {
        package_digest: PackageDigest::parse("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
          .unwrap(),
      }),
      PluginId::parse("com.langnext.store-drop-test").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![CapabilityId::parse("translate.text@1").unwrap()],
      vec![],
      vec![],
    )
    .unwrap();
    let principal = grant
      .principal_for_request("translate.text@1", "store-drop-request")
      .unwrap();
    new_state(principal, grant, CancelToken::new(), None, Box::new(NoopBroker))
  }

  #[tokio::test]
  async fn plugin_host_state_drop_aborts_owned_stream_tasks() {
    let mut state = test_state();
    let params = ResourceCreateParams {
      owner: ResourceOwner::from_principal(&state.principal),
      direction: ResourceDirection::Output,
      content_type: None,
      max_bytes: 1,
      expires_at: None,
      cancel: CancelToken::new(),
    };
    let (_writer, mut reader) = StreamResourceTable::create_network_binary_pair(params).unwrap();
    let aborted = Arc::new(AtomicUsize::new(0));
    let (transport_started_tx, transport_started_rx) = tokio::sync::oneshot::channel();
    let (pump_started_tx, pump_started_rx) = tokio::sync::oneshot::channel();
    reader.install_pump_handles(
      spawn_stubborn_task(transport_started_tx, aborted.clone()),
      spawn_stubborn_task(pump_started_tx, aborted.clone()),
    );
    state.streams.adopt_reader(reader).unwrap();
    transport_started_rx.await.expect("transport task started");
    pump_started_rx.await.expect("pump task started");

    drop(state);

    tokio::time::timeout(STORE_DROP_ABORT_WAIT, async {
      while aborted.load(Ordering::SeqCst) != STORE_DROP_TASK_COUNT {
        tokio::task::yield_now().await;
      }
    })
    .await
    .expect("store drop must abort every owned stream task");
  }
}
