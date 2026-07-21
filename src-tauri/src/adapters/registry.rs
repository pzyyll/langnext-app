// ABOUTME: Process-wide provider-adapter registry with plugin-style registration.
// ABOUTME: Built-ins load once; lookups are id-keyed and fail closed on unknown ids.
use crate::adapters::builtin;
use crate::adapters::protocol::{AdapterHandle, ProviderAdapter};
use crate::adapters::transport::TransportError;
use crate::error::StorageError;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

struct AdapterRegistry {
  by_id: HashMap<&'static str, AdapterHandle>,
}

impl AdapterRegistry {
  fn new() -> Self {
    Self { by_id: HashMap::new() }
  }

  fn insert(&mut self, adapter: AdapterHandle) {
    let id = adapter.id();
    self.by_id.insert(id, adapter);
  }
}

static REGISTRY: OnceLock<RwLock<AdapterRegistry>> = OnceLock::new();

fn registry() -> &'static RwLock<AdapterRegistry> {
  REGISTRY.get_or_init(|| {
    let mut reg = AdapterRegistry::new();
    for adapter in builtin::all_builtin_adapters() {
      reg.insert(adapter);
    }
    RwLock::new(reg)
  })
}

/// Ensure built-in adapters are loaded (idempotent).
pub fn ensure_loaded() {
  let _ = registry();
}

/// Register an adapter strategy. Replaces any existing entry with the same id.
///
/// Intended for plugins and tests. Built-ins register automatically on first lookup.
pub fn register(adapter: AdapterHandle) {
  ensure_loaded();
  let mut guard = registry().write().unwrap_or_else(|poisoned| poisoned.into_inner());
  guard.insert(adapter);
}

/// Look up an adapter by stable id.
pub fn get(adapter_id: &str) -> Result<AdapterHandle, StorageError> {
  ensure_loaded();
  let guard = registry().read().unwrap_or_else(|poisoned| poisoned.into_inner());
  guard
    .by_id
    .get(adapter_id)
    .cloned()
    .ok_or_else(|| StorageError::Validation(format!("unknown adapter_id: {adapter_id}")))
}

/// Look up an adapter for transport paths (maps unknown ids to invalid_response).
pub fn get_for_transport(adapter_id: &str) -> Result<AdapterHandle, TransportError> {
  get(adapter_id).map_err(|_| TransportError::InvalidResponse)
}

/// Snapshot of registered adapter ids (stable order by id).
pub fn list_ids() -> Vec<&'static str> {
  ensure_loaded();
  let guard = registry().read().unwrap_or_else(|poisoned| poisoned.into_inner());
  let mut ids: Vec<&'static str> = guard.by_id.keys().copied().collect();
  ids.sort_unstable();
  ids
}

/// Snapshot of all registered adapters (stable order by id).
pub fn list() -> Vec<AdapterHandle> {
  ensure_loaded();
  let guard = registry().read().unwrap_or_else(|poisoned| poisoned.into_inner());
  let mut items: Vec<AdapterHandle> = guard.by_id.values().cloned().collect();
  items.sort_by_key(|adapter| adapter.id());
  items
}

/// Helper for tests/plugins that need an Arc-wrapped unit adapter.
pub fn wrap<T: ProviderAdapter>(adapter: T) -> AdapterHandle {
  Arc::new(adapter)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::adapters::protocol::AdapterMeta;
  use crate::domain::provider::CredentialKind;

  struct FakeAdapter;

  impl ProviderAdapter for FakeAdapter {
    fn meta(&self) -> AdapterMeta {
      AdapterMeta {
        id: "test-fake-adapter",
        label: "Fake",
        default_base_url: None,
      }
    }

    fn secret_required(&self, _credential_kind: CredentialKind) -> bool {
      false
    }

    fn auth_application(
      &self,
      _credential_kind: CredentialKind,
    ) -> Result<crate::adapters::transport::AuthApplication, TransportError> {
      Ok(crate::adapters::transport::AuthApplication::None)
    }

    fn models_path(&self) -> &'static str {
      "models"
    }

    fn parse_models_page(
      &self,
      _value: &serde_json::Value,
    ) -> Result<crate::adapters::transport::ParsedPage, TransportError> {
      Err(TransportError::InvalidResponse)
    }

    fn build_chat(
      &self,
      _request: &crate::adapters::transport::ChatCompletionRequest,
      _stream: bool,
    ) -> Result<(url::Url, serde_json::Value), TransportError> {
      Err(TransportError::InvalidResponse)
    }

    fn parse_chat_content(&self, _value: &serde_json::Value) -> Result<String, TransportError> {
      Err(TransportError::InvalidResponse)
    }

    fn parse_stream_delta(&self, _event_name: Option<&str>, _value: &serde_json::Value) -> Option<String> {
      None
    }
  }

  #[test]
  fn builtins_are_registered() {
    ensure_loaded();
    assert!(get("openai-compatible").is_ok());
    assert!(get("openai-responses").is_ok());
    assert!(get("anthropic").is_ok());
    assert!(get("gemini").is_ok());
    assert!(get("deepseek").is_ok());
    assert!(get("nope").is_err());
  }

  #[test]
  fn register_replaces_or_adds() {
    register(wrap(FakeAdapter));
    let got = get("test-fake-adapter").unwrap();
    assert_eq!(got.id(), "test-fake-adapter");
  }
}
