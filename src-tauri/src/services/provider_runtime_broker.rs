// ABOUTME: Provider-instance-authorized Wasm broker handle: only the bound provider instance's
// ABOUTME: persisted connection, proxy mode, and host-injected auth reach the transport.
use crate::credentials::CredentialVault;
use crate::domain::cancel::CancelToken;
use crate::domain::plugin_resource::NetworkResponseBodyMode;
use crate::domain::runtime_plugin::{HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID, PluginPrincipal};
use crate::error::StorageError;
use crate::repositories::provider_runtime_bindings;
use crate::services::bounded_http::{RawHttpTransport, with_cancel};
use crate::services::provider_http::prepare_provider_transport;
use crate::services::provider_runtime_router::ProviderRuntimeBrokerContext;
use crate::services::wasm_runtime::host::{
  BrokerAuthorization, BrokerFetchError, BrokerFetchOutcome, BrokerFetchRequest, BrokerHandle,
};
use crate::services::wasm_runtime::network_handle::{
  bounded_to_broker_response, map_storage_to_broker, parse_method, pump_stream_response, request_body_into_transport,
};
use crate::storage::Database;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// `BrokerHandle` for provider-runtime principals. The host's `authorize_broker_fetch` already
/// accepted the fixed provider-instance endpoint shape; this handle performs the exact
/// provider-instance authority check (active adapter-keyed binding + package digest + grant
/// revision matching the host-only context and principal) and only then resolves the persisted
/// provider connection and injects its authentication. Credentials, credential references,
/// and final secret-bearing URLs never cross into the guest or the frontend.
#[derive(Clone)]
pub struct ProviderRuntimeBrokerHandle {
  db: Database,
  vault: Arc<dyn CredentialVault>,
  transport: Arc<dyn RawHttpTransport>,
  /// Host-only binding identity constructed by the router; never crosses IPC.
  context: ProviderRuntimeBrokerContext,
}

impl ProviderRuntimeBrokerHandle {
  pub fn new(
    db: Database,
    vault: Arc<dyn CredentialVault>,
    transport: Arc<dyn RawHttpTransport>,
    context: ProviderRuntimeBrokerContext,
  ) -> Self {
    Self {
      db,
      vault,
      transport,
      context,
    }
  }

  /// Resolve the exact provider-instance authority for the host-only context. Denied (before
  /// any vault lookup or transport) when: the provider has no binding for this API type, the
  /// binding is not an active Wasm package binding, the bound package digest differs from the
  /// context's, or the bound grant revision differs from the context's. A grant for another
  /// provider instance, a stale/deleted alias, or a forged context therefore cannot reach the
  /// transport.
  fn authorize_instance(&self, principal: &PluginPrincipal) -> Result<(), BrokerFetchError> {
    if principal.instance_id() != self.context.provider_id {
      return Err(BrokerFetchError::NotApproved);
    }
    if principal.package_digest().map(|d| d.as_str()) != Some(self.context.package_digest.as_str()) {
      return Err(BrokerFetchError::NotApproved);
    }
    if principal.grant_set_revision().as_u64() != self.context.grant_revision {
      return Err(BrokerFetchError::NotApproved);
    }
    let binding = self
      .db
      .read(|conn| provider_runtime_bindings::get(conn, self.context.provider_id, &self.context.adapter_id))
      .map_err(|_| BrokerFetchError::NotApproved)?;
    if binding.runtime_kind != crate::domain::runtime_provider::ProviderRuntimeKind::WasmComponent
      || binding.state != crate::domain::runtime_provider::ProviderRuntimeState::Active
    {
      return Err(BrokerFetchError::NotApproved);
    }
    if binding.package_digest.as_deref() != Some(self.context.package_digest.as_str()) {
      return Err(BrokerFetchError::NotApproved);
    }
    if binding.grant_set_revision != Some(self.context.grant_revision) {
      return Err(BrokerFetchError::NotApproved);
    }
    Ok(())
  }
}

impl BrokerHandle for ProviderRuntimeBrokerHandle {
  fn fetch(
    &self,
    principal: &PluginPrincipal,
    _grant: &crate::domain::runtime_plugin::ExecutionGrantSet,
    request: BrokerFetchRequest,
    authorization: BrokerAuthorization,
    cancel: &CancelToken,
    deadline: Option<Instant>,
  ) -> Pin<Box<dyn std::future::Future<Output = BrokerFetchOutcome> + Send + '_>> {
    let db = self.db.clone();
    let vault = self.vault.clone();
    let transport = self.transport.clone();
    let context = self.context.clone();
    let principal = principal.clone();
    let cancel = cancel.clone();
    Box::pin(async move {
      // The host never builds a provider-instance authorization for any other policy; a
      // different/undeclared auth policy is denied before any provider resolution.
      if authorization.auth_policy.as_str() != HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID {
        return Err(BrokerFetchError::NotApproved);
      }
      // Exact adapter-keyed binding/package/grant authority before vault lookup or transport.
      let handle = ProviderRuntimeBrokerHandle {
        db,
        vault,
        transport,
        context,
      };
      handle.authorize_instance(&principal)?;

      // Confined relative path (defense in depth; the host already validated the shape).
      let (path_part, query_part) = request
        .relative_path
        .split_once('?')
        .unwrap_or((&request.relative_path, ""));
      let query = parse_query_pairs(query_part)?;
      let method = parse_method(&request.method)?;
      let headers = request
        .headers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<std::collections::HashMap<_, _>>();
      let (body, _content_type) = request_body_into_transport(&request.body);

      // Shared binary-safe preparation: persisted Base URL + proxy mode, credential lookup
      // and host auth injection happen ONLY after the instance authorization above.
      let prepared = prepare_provider_transport(
        &handle.db,
        handle.vault.as_ref(),
        principal.instance_id(),
        method,
        path_part,
        &query,
        &headers,
        body,
        Some(authorization.resource_limits.max_response_bytes() as usize),
        Some(Duration::from_millis(authorization.resource_limits.timeout_ms())),
      )
      .map_err(|err| {
        if matches!(
          err,
          StorageError::CredentialUnavailable | StorageError::CredentialAccess
        ) {
          BrokerFetchError::Network("provider credential unavailable".into())
        } else {
          map_storage_to_broker(err)
        }
      })?;

      if authorization.selected_response_mode == NetworkResponseBodyMode::Stream {
        return pump_stream_response(handle.transport, principal, prepared, authorization, cancel, deadline).await;
      }
      let work = handle.transport.request(prepared);
      let response = match with_cancel(Some(&cancel), work).await {
        Ok(response) => response,
        Err(err) => return Err(map_storage_to_broker(err)),
      };
      bounded_to_broker_response(response, authorization.selected_response_mode)
    })
  }
}

/// Split a validated broker query suffix into pairs (`k=v&k=v`). Values are already
/// percent-encoded by the guest and are not re-encoded; the host authorization validated the
/// shape and rejected credential-like keys, and `prepare_provider_transport` re-checks names
/// against the provider auth scheme before transport.
fn parse_query_pairs(query: &str) -> Result<Vec<(String, String)>, BrokerFetchError> {
  if query.is_empty() {
    return Ok(Vec::new());
  }
  let mut pairs = Vec::new();
  for pair in query.split('&') {
    let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
    if key.is_empty() {
      return Err(BrokerFetchError::PathConfined);
    }
    pairs.push((key.to_string(), value.to_string()));
  }
  Ok(pairs)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn query_pairs_parse_preserves_encoded_values() {
    let pairs = parse_query_pairs("client=gtx&sl=auto&tl=en&q=Hi").unwrap();
    assert_eq!(
      pairs,
      vec![
        ("client".to_string(), "gtx".to_string()),
        ("sl".to_string(), "auto".to_string()),
        ("tl".to_string(), "en".to_string()),
        ("q".to_string(), "Hi".to_string()),
      ]
    );
    assert_eq!(parse_query_pairs("").unwrap(), Vec::<(String, String)>::new());
    assert!(parse_query_pairs("=value").is_err());
  }
}
