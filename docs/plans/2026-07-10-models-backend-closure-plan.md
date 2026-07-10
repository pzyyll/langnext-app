# Models Backend Closure Plan

> Goal: close the loop on model features - Get models (remote sync), Test connection, Add model.
> Branch: `feat/models-page`
> Date: 2026-07-10

## 1. Goal and Scope

### Already working

- **Add model (manual)**: `AddManualModelDialog` -> `saveManualModel` IPC -> `ModelService::save_manual`. Closed loop.

### In scope (this plan)

- **Test connection**: backend HTTP call to the provider's models endpoint; returns ok/error without mutating model rows.
- **Get models (sync)**: backend HTTP fetch of remote model list -> `ModelService::apply_remote_merge` (or `record_sync_error` on failure) -> return refreshed models + provider DTO.
- Enable the two disabled frontend buttons and surface connection/sync status.

### Out of scope (later)

- Custom proxy URL support (`network.proxyUrl`). reqwest reads system env proxies by default; `proxy_mode: direct` should disable proxies. Full custom-proxy wiring is a follow-up.
- Streaming / chat completions / actual translation. Only the models-list endpoint is used for both test and sync.
- Editing `adapter_id` from the provider editor (creation-only remains).

## 2. HTTP Client: async `reqwest`

Rationale:

- Tauri `#[tauri::command] async fn` already runs on the tokio runtime. async reqwest is awaited directly - no `spawn_blocking` needed for HTTP. This is exactly the pattern used by the sibling project `F:\workspace\my\langnext-translate\src-tauri\src\module\translate.rs` (a lazy `reqwest::Client`, async commands, direct `.await`).
- Existing storage commands use `run_blocking`/`spawn_blocking` only because rusqlite is synchronous. That constraint applies to DB access, **not** to HTTP.
- Do **not** use `reqwest::blocking` - it panics inside a tokio-thread-pool thread ("cannot start a runtime from within a runtime"). The async client has no such issue.

Add to `src-tauri/Cargo.toml`:

```toml
reqwest = { version = "0.13", features = ["json"] }
```

(Align version with the sibling project, currently `0.13.4`. Worker: verify the latest stable 0.13.x via `cargo add` or context7. TLS uses reqwest defaults, matching the sibling project; if a rustls build is preferred for portability, use `default-features = false, features = ["json", "rustls-tls"]`.)

Share one `reqwest::Client` via a `lazy_static`/`once_cell` singleton (like the sibling project) to reuse connection pooling. Set a per-request timeout (e.g. 20s) via `.timeout(Duration::from_secs(20))` on the request builder so slow providers map to `Timeout` rather than hanging.

## 3. Adapter Transport Layer

New module: `src-tauri/src/adapters/transport.rs`

```rust
// ABOUTME: Async HTTP transport for provider model-list fetching.
// ABOUTME: Maps network/HTTP failures to bounded sync error codes; never logs secrets.
use crate::domain::model::RemoteModelSyncItem;
use crate::domain::provider::CredentialKind;

/// Bounded error code matching ModelsSyncStatus error codes.
pub enum TransportError {
    Auth,            // 401 / 403
    RateLimited,     // 429
    Network,         // connection / DNS / TLS failure
    Timeout,         // request timeout
    Server,          // 5xx
    InvalidResponse, // JSON parse / schema mismatch
}

impl TransportError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::RateLimited => "rate_limited",
            Self::Network => "network",
            Self::Timeout => "timeout",
            Self::Server => "server",
            Self::InvalidResponse => "invalid_response",
        }
    }
    pub fn message(&self) -> &'static str { /* human text */ }
}

/// Fetch the remote model list for a provider configuration.
/// `base_url` is the resolved endpoint (override or adapter default).
/// `secret` is the credential read from the vault (backend use only).
pub async fn list_models(
    adapter_id: &str,
    base_url: &str,
    credential_kind: CredentialKind,
    secret: &str,
) -> Result<Vec<RemoteModelSyncItem>, TransportError> { ... }
```

Register in `src-tauri/src/adapters/mod.rs`: `pub mod transport;`.

### Adapter API details (worker: verify current API via context7/web before finalizing)

Resolve base URL: `provider.baseUrlOverride.unwrap_or(catalog::get(adapter_id).default_base_url)`.

| adapter_id          | Endpoint                                                                | Auth                                                   | Response shape                                                                  | model_key                       | remote_display_name                     |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------- |
| `openai-compatible` | `GET {base}/models`                                                     | `Authorization: Bearer {secret}`                       | `{ data: [{ id, ... }] }`                                                       | `id`                            | `None` (OpenAI returns no display name) |
| `openai-responses`  | same as openai-compatible (Responses API shares the `/models` endpoint) | same                                                   | same                                                                            | `id`                            | `None`                                  |
| `anthropic`         | `GET {base}/v1/models`                                                  | `x-api-key: {secret}`, `anthropic-version: 2023-06-01` | `{ data: [{ id, display_name, type }] }`                                        | `id`                            | `display_name`                          |
| `gemini`            | `GET {base}/v1beta/models?key={secret}`                                 | query param (no header)                                | `{ models: [{ name: "models/xxx", displayName, supportedGenerationMethods }] }` | `name` (strip `models/` prefix) | `displayName`                           |

Notes:

- For `credential_kind: none`, callers must reject before reaching transport (service layer guard).
- `bearer` and `api_key` both map to `Authorization: Bearer` for OpenAI adapters; Anthropic always uses `x-api-key`; Gemini always uses the `key` query param regardless of credential_kind.
- Status-code mapping: 401/403 -> Auth; 429 -> RateLimited; 5xx -> Server; reqwest `is_timeout` -> Timeout; other send/decode errors -> Network or InvalidResponse.
- Do not log the secret or the full URL with query. On error, log only `adapter_id` + `TransportError::code()`.
- Split parsing from HTTP: expose a pure `fn parse_models(adapter_id, body: &serde_json::Value) -> Result<Vec<RemoteModelSyncItem>, TransportError>` so tests cover parsing without network.

## 4. Error -> Status Mapping

`TransportError::code()` returns one of the six codes already validated by `services::models::validate_sync_error_code` (`auth`/`rate_limited`/`network`/`timeout`/`server`/`invalid_response`). No new error codes needed.

`StorageError` gains no HTTP variant; transport errors are handled in the service layer and converted to either a `ConnectionTestResult` (test) or a `record_sync_error` call (sync).

## 5. ModelService Changes

Inject the vault into `ModelService` so it can read credentials for backend HTTP use. The two new methods are **async** (they await HTTP); DB access inside them is wrapped with `tauri::async_runtime::spawn_blocking` to keep the existing "DB never blocks the tokio worker" discipline.

`src-tauri/src/services/models.rs`:

```rust
#[derive(Clone)]
pub struct ModelService {
    db: Database,
    vault: Arc<dyn CredentialVault>,
}

impl ModelService {
    pub fn new(db: Database, vault: Arc<dyn CredentialVault>) -> Self { Self { db, vault } }
    // existing sync methods (list_by_provider, save_manual, set_enabled, delete,
    // apply_remote_merge, record_sync_error) unchanged...
}
```

New async methods:

```rust
/// Test reachability + credential validity without mutating model rows or sync status.
pub async fn test_connection(&self, provider_id: Uuid) -> Result<ConnectionTestResult, StorageError>;

/// Fetch remote models, merge into cache, update sync status, return refreshed models + provider.
pub async fn sync_models(&self, provider_id: Uuid) -> Result<SyncModelsResult, StorageError>;
```

### Shared credential resolution (sync helper, runs inside spawn_blocking)

```rust
struct ResolvedProvider {
    provider: ProviderInstance,
    base_url: String,
    secret: Option<String>, // None when kind=none or no ref
}
fn resolve_for_http(&self, provider_id: Uuid) -> Result<ResolvedProvider, StorageError>;
```

- Read provider via `self.db.read`; NotFound -> `StorageError::NotFound`.
- Resolve base URL (override or catalog default).
- If `credential_kind == None` or `credential_ref == None` -> `secret: None`.
- Else `vault.get_for_backend_use(ref)`; on vault error surface as a failed-test/sync outcome (see below), not a hard `CredentialUnavailable` IPC error.

### `test_connection` flow (async)

1. `spawn_blocking` -> `resolve_for_http(provider_id)`.
2. If `secret` is None -> return `ConnectionTestResult { ok: false, error_code: None, message: "No credential configured" }`.
3. If vault read failed -> `ConnectionTestResult { ok: false, error_code: Some("auth"), message: "Credential store unavailable" }`.
4. `transport::list_models(adapter_id, base_url, kind, secret).await`.
5. Ok -> `ConnectionTestResult { ok: true, error_code: None, message: "Connected" }` (optionally include model count).
6. Err -> `{ ok: false, error_code: Some(code), message }`.
7. Do not write to DB.

### `sync_models` flow (async)

1. `spawn_blocking` -> `resolve_for_http(provider_id)`.
2. If `secret` is None -> `spawn_blocking` -> `record_sync_error(provider_id, "auth")`; return `Err(StorageError::Validation("no credential configured"))`.
3. `transport::list_models(...).await`.
4. On Ok -> `spawn_blocking` -> `apply_remote_merge(provider_id, &models)`; re-read provider + models; return `SyncModelsResult { models, provider }`.
5. On Err -> `spawn_blocking` -> `record_sync_error(provider_id, code)`; return `Err(StorageError::Validation(message))` so the frontend shows the failure inline, while sync_status is persisted as Error.

### Test seam for HTTP

The transport call is the only thing that hits the network. To keep production free of mock modes (AGENTS.md), inject the transport through a `#[cfg(test)]`-only override on `ModelService`:

```rust
#[cfg(test)]
type TransportFn = fn(&str, &str, CredentialKind, &str)
    -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<RemoteModelSyncItem>, TransportError>> + Send>>;

#[cfg(test)]
pub fn set_transport_override(&self, f: Option<TransportFn>);
```

Production path always calls the real `transport::list_models`; tests set an override that returns canned futures. Keep the override field behind `#[cfg(test)]`.

## 6. Domain Types

`src-tauri/src/domain/model.rs` (or a new `domain/runtime.rs`):

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub error_code: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncModelsResult {
    pub models: Vec<ProviderModelDto>,
    pub provider: ProviderInstanceDto,
}
```

## 7. AppState Change

`src-tauri/src/state.rs`:

```rust
let models = ModelService::new(db.clone(), vault.clone());
```

(was `ModelService::new(db.clone())`.)

Update any test fixtures that construct `ModelService::new(db)` to pass a vault (`MemoryCredentialVault`).

## 8. IPC Commands

`src-tauri/src/cmds/models.rs` - the two new commands are async and await the service directly (no `run_blocking`, because the service method is async and already keeps DB work off the tokio thread):

```rust
#[tauri::command]
pub async fn test_provider_connection(
    state: State<'_, AppState>,
    provider_instance_id: Uuid,
) -> Result<ConnectionTestResult, IpcError> {
    let models = state.models.clone();
    models.test_connection(provider_instance_id).await.map_err(IpcError::from)
}

#[tauri::command]
pub async fn sync_provider_models(
    state: State<'_, AppState>,
    provider_instance_id: Uuid,
) -> Result<SyncModelsResult, IpcError> {
    let models = state.models.clone();
    models.sync_models(provider_instance_id).await.map_err(IpcError::from)
}
```

Register both in `src-tauri/src/lib.rs` `invoke_handler!`.

## 9. Frontend Changes

### `src/storage/types.ts`

Add:

```ts
export interface ConnectionTestResult {
	ok: boolean;
	errorCode: string | null;
	message: string;
}
export interface SyncModelsResult {
	models: ProviderModelDto[];
	provider: ProviderInstanceDto;
}
```

### `src/storage/client.ts`

```ts
export async function testProviderConnection(providerInstanceId: string): Promise<ConnectionTestResult> {
	return invoke("test_provider_connection", { providerInstanceId });
}
export async function syncProviderModels(providerInstanceId: string): Promise<SyncModelsResult> {
	return invoke("sync_provider_models", { providerInstanceId });
}
```

(Confirm the exact camelCase invoke arg name Tauri expects - `providerInstanceId` maps to the `provider_instance_id` param.)

### `src/features/models/ProviderEditor.tsx`

- **Test connection**: remove `disabled`; on click call `testProviderConnection(providerId)`; show pending state; render result - green "Connected" when `ok`, red message + code when not. Keep the result in local state; clear on provider change.
- **Get model**: remove `disabled`; on click call `syncProviderModels(providerId)`; on success `setModels(result.models)` + `upsertProvider(result.provider)`; on failure show the error inline and keep existing models.
- Show `provider.modelsSyncStatus` / `modelsSyncedAt` / `modelsSyncErrorCode` somewhere in the Models section header (e.g. a small status line: "Last synced …" / "Sync error: auth").
- Remove the `title="Backend command not yet available"` and the sr-only help spans for these two buttons.

## 10. Tests

### Rust

- `adapters::transport::tests`: unit-test `parse_models` with fixture JSON for each adapter (OpenAI, Anthropic, Gemini shapes). Pure function, no network.
- `services::models::tests` (or `services::tests`): test `test_connection` and `sync_models` using `MemoryCredentialVault` + the `#[cfg(test)]` transport override returning canned futures.
  - test_connection: missing credential -> ok:false; transport Ok -> ok:true; transport Auth -> ok:false code:auth.
  - sync_models: transport Ok -> models merged + provider.syncStatus=Ok; transport Err -> record_sync_error called + provider.syncStatus=Error.
- `cmds` mapping: covered by the existing `map_blocking_result` pattern; the new async commands are thin wrappers.

### Frontend

- No new tests required, but ensure `typecheck`/`lint`/`build` pass.

## 11. Ordered Implementation Steps

1. Add `reqwest` dependency to `src-tauri/Cargo.toml`; verify it compiles.
2. Create `adapters/transport.rs` with `TransportError`, `parse_models` (pure), and `async fn list_models`. Register in `adapters/mod.rs`.
3. Add `ConnectionTestResult` / `SyncModelsResult` domain types.
4. Inject vault into `ModelService`; update `AppState` and test fixtures.
5. Implement async `ModelService::test_connection` and `sync_models` (with the `#[cfg(test)]` transport seam).
6. Add `test_provider_connection` / `sync_provider_models` async commands; register in `lib.rs`.
7. Add Rust tests (transport parsers + service flows with stubbed transport); run `cargo test`.
8. Add frontend types + client wrappers.
9. Update `ProviderEditor` to enable both buttons, call the new IPC, and render connection/sync status.
10. Regenerate `routeTree.gen.ts` only if routes changed (likely none) - otherwise skip.
11. Run full validation.

## 12. Validation

Backend:

1. `cargo test` (in `src-tauri`) - all tests pass, including new transport + service tests.
2. `cargo fmt` (via `mise run format`) and `cargo clippy` if configured.
3. `cargo build` (or `mise run tauri:build`) to confirm the Tauri binary compiles.

Frontend: 4. `mise run typecheck` 5. `mise run lint` 6. `mise run format` + `mise run format:check` 7. `mise run build`

Manual (Tauri, if GUI available): 8. `mise run tauri:dev` -> create a provider with a real OpenAI/Anthropic/Gemini token -> Test connection shows Connected -> Get model pulls the remote list -> toggling models persists -> restart shows synced models.

## 13. Risks / Follow-ups

- **reqwest version**: align with sibling project (`0.13.x`); worker verifies latest stable. Do not use `reqwest::blocking`.
- **DB access in async service**: wrapped in `spawn_blocking` so rusqlite never blocks the tokio worker. HTTP is awaited directly.
- **Transport seam for tests**: `#[cfg(test)]`-only override; production always calls the real `transport::list_models` (AGENTS.md: "Do not implement mock modes").
- **Adapter API drift**: OpenAI/Anthropic/Gemini list-models endpoints may change; worker verifies current API via context7/web before finalizing parsers.
- **Proxy**: not wired to `network.proxyUrl`; reqwest honors system env proxies by default. Follow-up task.
- **Rate limiting / large model lists**: no pagination handling; if a provider returns paginated models, only the first page is synced. Follow-up.
- **Credential-unavailable during test/sync**: surfaced as a failed result rather than a hard `CredentialUnavailable` IPC error, so the UI shows a helpful message.
