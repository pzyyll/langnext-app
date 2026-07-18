// ABOUTME: Cooperative cancellation tokens for in-flight translate HTTP work.
// ABOUTME: AtomicBool + Notify so streaming and non-stream tasks abort promptly.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

/// Shared cancel flag used by translate IPC and transport loops.
#[derive(Clone, Debug, Default)]
pub struct CancelToken {
  inner: Arc<CancelInner>,
}

#[derive(Debug, Default)]
struct CancelInner {
  cancelled: AtomicBool,
  notify: Notify,
}

impl CancelToken {
  pub fn new() -> Self {
    Self {
      inner: Arc::new(CancelInner::default()),
    }
  }

  /// Mark cancelled and wake waiters (HTTP futures drop on select win).
  pub fn cancel(&self) {
    self.inner.cancelled.store(true, Ordering::SeqCst);
    self.inner.notify.notify_waiters();
  }

  pub fn is_cancelled(&self) -> bool {
    self.inner.cancelled.load(Ordering::SeqCst)
  }

  /// Resolves when [`cancel`](Self::cancel) has been called.
  pub async fn cancelled(&self) {
    loop {
      // Subscribe before checking so a concurrent cancel cannot be missed.
      let notified = self.inner.notify.notified();
      if self.is_cancelled() {
        return;
      }
      notified.await;
    }
  }
}

/// Maps client `request_id` values to active cancel tokens.
#[derive(Debug, Default)]
pub struct TranslateSessionRegistry {
  sessions: Mutex<HashMap<String, CancelToken>>,
}

impl TranslateSessionRegistry {
  pub fn new() -> Self {
    Self {
      sessions: Mutex::new(HashMap::new()),
    }
  }

  /// Register (or replace) a session for `request_id` and return its token.
  pub fn begin(&self, request_id: &str) -> CancelToken {
    let token = CancelToken::new();
    let mut map = self.sessions.lock().expect("translate sessions poisoned");
    if let Some(previous) = map.insert(request_id.to_string(), token.clone()) {
      previous.cancel();
    }
    token
  }

  /// Cancel an active session. Returns false when the id is unknown / already finished.
  pub fn cancel(&self, request_id: &str) -> bool {
    let map = self.sessions.lock().expect("translate sessions poisoned");
    if let Some(token) = map.get(request_id) {
      token.cancel();
      true
    } else {
      false
    }
  }

  /// Drop the session entry after the translate task finishes.
  pub fn end(&self, request_id: &str) {
    let mut map = self.sessions.lock().expect("translate sessions poisoned");
    map.remove(request_id);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cancel_token_flags_and_wakes() {
    let token = CancelToken::new();
    assert!(!token.is_cancelled());
    token.cancel();
    assert!(token.is_cancelled());
  }

  #[test]
  fn registry_begin_cancel_end() {
    let registry = TranslateSessionRegistry::new();
    let token = registry.begin("req-1");
    assert!(!token.is_cancelled());
    assert!(registry.cancel("req-1"));
    assert!(token.is_cancelled());
    assert!(!registry.cancel("missing"));
    registry.end("req-1");
    assert!(!registry.cancel("req-1"));
  }

  #[test]
  fn registry_replace_cancels_previous() {
    let registry = TranslateSessionRegistry::new();
    let first = registry.begin("same");
    let second = registry.begin("same");
    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());
    second.cancel();
    assert!(second.is_cancelled());
  }
}
