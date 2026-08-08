// ABOUTME: Test-only scoped dispatch recorder at real runtime execution boundaries.
// ABOUTME: Compiles only under cfg(test); records categories, never payloads or identifiers.
use std::marker::PhantomData;
use std::sync::{Mutex, MutexGuard, OnceLock};

/// Closed dispatch categories observed at real runtime boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionDispatchKind {
  WasmGuest,
  NativeWorker,
  Migration,
  Network,
}

/// Independent counters for one armed measurement scope.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExecutionDispatchCounts {
  pub wasm_guest: usize,
  pub native_worker: usize,
  pub migration: usize,
  pub network: usize,
}

impl ExecutionDispatchCounts {
  pub fn total(&self) -> usize {
    self.wasm_guest + self.native_worker + self.migration + self.network
  }
}

impl ExecutionDispatchCounts {
  fn record(&mut self, kind: ExecutionDispatchKind) {
    match kind {
      ExecutionDispatchKind::WasmGuest => self.wasm_guest += 1,
      ExecutionDispatchKind::NativeWorker => self.native_worker += 1,
      ExecutionDispatchKind::Migration => self.migration += 1,
      ExecutionDispatchKind::Network => self.network += 1,
    }
  }
}

/// One armed measurement. Serialization allows only one active scope process-wide, so
/// a single counter set is sufficient; every thread contributes while the scope is armed.
struct ActiveScope {
  counts: ExecutionDispatchCounts,
}

/// Process-wide probe registry holding the single active measurement.
struct ProbeState {
  active: Option<ActiveScope>,
}

/// Serializes probe scopes process-wide. A second `scope()` blocks on this lock until the
/// first guard drops, so measurements can never overlap, share, or silently reset each
/// other.
fn serialization_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

fn state() -> &'static Mutex<ProbeState> {
  static STATE: OnceLock<Mutex<ProbeState>> = OnceLock::new();
  STATE.get_or_init(|| Mutex::new(ProbeState { active: None }))
}

/// Record one dispatch at a real execution boundary (test builds only). Counts into the
/// active scope whenever one is armed, from any thread: a joined spawned thread's dispatch
/// is attributed exactly like the arming thread's. Parallel cargo tests dispatch
/// concurrently on their own worker threads, so a process-wide counter can mix unrelated
/// tests' measurements; the import acceptance path therefore serializes its scope and
/// keeps the whole suite from arming overlapping measurements. No-op when no scope is
/// armed.
pub fn record(kind: ExecutionDispatchKind) {
  let mut st = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let Some(scope) = st.active.as_mut() else {
    return;
  };
  scope.counts.record(kind);
}

/// Scoped measurement: serializes with every other scope process-wide, arms the shared
/// counter set, and clears it on drop. The guard is not Send; arming, snapshot, and drop
/// stay on the test thread that created the scope, while the counts themselves accept
/// records from any thread.
pub struct ExecutionDispatchProbeGuard {
  _serialization: MutexGuard<'static, ()>,
  _not_send: PhantomData<*const ()>,
}

/// Arm a fresh probe scope. Blocks until any other armed scope drops; it never replaces
/// an active measurement, so only one process-wide measurement exists at a time.
pub fn scope() -> ExecutionDispatchProbeGuard {
  let serialization = serialization_lock()
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  // The serialization lock is held: no other scope is active, so this reset is exclusive.
  let mut st = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  st.active = Some(ActiveScope {
    counts: ExecutionDispatchCounts::default(),
  });
  ExecutionDispatchProbeGuard {
    _serialization: serialization,
    _not_send: PhantomData,
  }
}

impl ExecutionDispatchProbeGuard {
  /// Copy the counts observed from every thread since `scope()` was armed.
  pub fn snapshot(&self) -> ExecutionDispatchCounts {
    state()
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .active
      .as_ref()
      .map(|scope| scope.counts)
      .unwrap_or_default()
  }

  /// Assert that no dispatch of any category was observed.
  pub fn assert_zero(&self) {
    let counts = self.snapshot();
    assert_eq!(
      counts,
      ExecutionDispatchCounts::default(),
      "dispatch probe must observe zero execution, got {counts:?}"
    );
  }
}

impl Drop for ExecutionDispatchProbeGuard {
  fn drop(&mut self) {
    // Clear the active measurement before the serialization lock is released (the lock
    // guard field drops after this body), so the next scope starts from fresh counters.
    state().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).active = None;
  }
}

#[cfg(test)]
mod tests {
  use super::{ExecutionDispatchCounts, ExecutionDispatchKind, record, scope};
  use std::time::Duration;

  /// A dispatch on the owning thread must reach the active scope.
  #[test]
  fn execution_dispatch_probe_records_owner_thread_dispatch() {
    let probe = scope();
    record(ExecutionDispatchKind::WasmGuest);
    let counts = probe.snapshot();
    assert_eq!(counts.wasm_guest, 1, "one owning-thread dispatch must be observed");
    assert_eq!(counts.total(), 1, "no other dispatch category may fire");
  }

  /// A dispatch recorded from a spawned (joined) thread must reach the active scope:
  /// the probe measures process-wide execution while armed, not one thread's activity.
  #[test]
  fn execution_dispatch_probe_records_spawned_thread() {
    let probe = scope();
    std::thread::spawn(|| {
      record(ExecutionDispatchKind::WasmGuest);
    })
    .join()
    .unwrap();
    let counts = probe.snapshot();
    assert_eq!(counts.wasm_guest, 1, "a spawned-thread dispatch must be observed");
    assert_eq!(counts.total(), 1, "no other dispatch category may fire");
  }

  /// A second `scope()` cannot complete until the first guard drops; channels prove the
  /// ordering instead of timing-only assertions.
  #[test]
  fn execution_dispatch_probe_serializes_scopes() {
    let first = scope();
    let (armed_tx, armed_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let second = std::thread::spawn(move || {
      let _second = scope();
      armed_tx.send(()).unwrap();
      release_rx.recv().unwrap();
    });

    // While the first guard is held, the second scope must not have completed.
    assert!(
      armed_rx.recv_timeout(Duration::from_millis(50)).is_err(),
      "a second scope must block until the first guard drops"
    );

    drop(first);
    armed_rx
      .recv_timeout(Duration::from_secs(5))
      .expect("the second scope must start once the first guard drops");
    release_tx.send(()).unwrap();
    second.join().unwrap();
  }

  /// Snapshot is empty and assert_zero passes when no dispatch was recorded.
  #[test]
  fn execution_dispatch_probe_snapshot_is_default_until_records() {
    let probe = scope();
    assert_eq!(probe.snapshot(), ExecutionDispatchCounts::default());
    probe.assert_zero();
  }
}
