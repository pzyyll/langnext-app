# Models Backend Closure Implementation Plan

**Goal:** Complete the model-management loop for testing saved provider connections and synchronizing remote model lists without exposing credentials or corrupting the local model cache.

**Inputs:** Existing models page implementation, provider/model storage services, credential vault, adapter catalog, and the review completed on 2026-07-10.

**Assumptions:**

- “Test connection” tests the provider configuration already saved in SQLite and the credential already stored in the native vault.
- Connection-relevant form changes must be saved before Test connection or Get models can run.
- OpenAI-compatible endpoints may legitimately use `credential_kind: none`, especially local endpoints.
- Anthropic and Gemini default endpoints require a credential, although custom provider instances may still be created before a credential is configured.
- A remote list is a complete snapshot only after every response page has been fetched successfully.

**Architecture:** Add an async adapter transport behind a small injected interface, while keeping synchronous SQLite and native-vault work inside `tauri::async_runtime::spawn_blocking`. The transport owns adapter-specific authentication, endpoint construction, proxy selection, response parsing, and pagination. Expected remote failures return typed result DTOs so the frontend can refresh persisted sync status; storage and internal failures continue through `IpcError`.

**Tech Stack:** Tauri 2, Rust, async reqwest 0.13, rusqlite, native keyring vault, React 19, TypeScript, Base UI.

**Branch:** `feat/models-page`

---

## 1. Scope

### Already working

- **Add model (manual):** `AddManualModelDialog` -> `saveManualModel` IPC -> `ModelService::save_manual`.
- Remote-cache merge and bounded sync-status persistence already exist in `ModelService::apply_remote_merge` and `ModelService::record_sync_error`.

### In scope

- **Test connection:** call the saved provider’s model-list endpoint and return a typed success/failure result without mutating model rows or sync status.
- **Get models:** fetch every remote model-list page, merge the complete snapshot, persist success/failure status, and return refreshed models plus provider state for both success and expected remote failure.
- Honor provider `ProxyMode::Inherit` and `ProxyMode::Direct`.
- Support unauthenticated OpenAI-compatible endpoints.
- Enable the two frontend actions and render pending, success, failure, and last-sync state.

### Out of scope

- Custom application proxy URL and proxy credentials from `network.proxyUrl`.
- Streaming, chat completions, Responses calls, and translation execution.
- Editing `adapter_id` or `credential_kind` from the existing provider editor.
- Background or scheduled model synchronization.

## 2. Prerequisite Tasks

These tasks must be completed before implementing the HTTP command flow.

### Task P1: Lock Authentication Semantics

**Outcome:** Credential absence is handled according to adapter behavior instead of being rejected globally.

**Decisions:**

- `openai-compatible` and `openai-responses`:
  - `none`: send no authentication header.
  - `api_key` or `bearer`: send `Authorization: Bearer <secret>`.
- `anthropic`:
  - Require a stored secret for the built-in endpoint.
  - Send `x-api-key: <secret>` and `anthropic-version: 2023-06-01`.
- `gemini`:
  - Require a stored secret for the built-in endpoint.
  - Send the secret through the `key` query parameter.
- Missing required credentials map to `auth` without making a network request.
- Native credential-store failures map to `credential_unavailable`, not `auth`.
- The transport request carries `secret: Option<String>`.
- Secrets and URLs containing query parameters are never logged.

**Validation:**

- An unauthenticated loopback OpenAI-compatible endpoint reaches the transport without an `Authorization` header.
- Missing Anthropic/Gemini credentials return `auth`.
- A failing vault returns `credential_unavailable` and never embeds the vault error or secret in IPC output.

### Task P2: Lock Proxy Semantics

**Outcome:** `ProxyMode::Direct` cannot silently use environment/system proxies.

**Decisions:**

- Use `std::sync::OnceLock`; do not add `lazy_static` or `once_cell`.
- Build and reuse two reqwest clients:
  - inherit client: default reqwest system-proxy behavior.
  - direct client: `reqwest::Client::builder().no_proxy()`.
- Configure a 20-second total request timeout on both clients.
- Select the client from the saved provider’s `ProxyMode`.
- Custom application proxy configuration remains out of scope.

**Validation:**

- Unit-test client selection as a pure mapping from `ProxyMode` to a client kind.
- Review the direct-client builder and confirm `.no_proxy()` is present.

### Task P3: Lock Failure Result Semantics

**Outcome:** Expected remote failures update the visible provider status without being mislabeled as validation errors.

**Decisions:**

- Add `credential_unavailable` to the bounded model-sync error codes.
- Expected connection/sync failures use result DTOs with `ok: false`.
- Do not convert authentication, timeout, rate-limit, network, server, invalid-response, missing-credential, or vault-unavailable outcomes into `StorageError::Validation`.
- Storage, serialization, task-join, and internal invariant failures continue to return `Err(StorageError)` and map through `IpcError`.
- On sync failure, persist the bounded error code, re-read the provider and current models, and return them in `SyncModelsResult`.
- Test connection never writes model rows or provider sync status.

**Validation:**

- A failed sync returns `ok: false` with `provider.modelsSyncStatus == "error"` in the same IPC response.
- A failed sync preserves the existing model list and last successful `modelsSyncedAt`.
- A transport failure never reaches the frontend as `validation_failed`.

### Task P4: Lock Pagination and Snapshot Safety

**Outcome:** `apply_remote_merge` is called only with a complete remote snapshot.

**Decisions:**

- OpenAI responses are treated as a single page.
- Anthropic pagination follows `has_more` and continues with the returned last ID cursor.
- Gemini pagination follows `nextPageToken`.
- Accumulate and deduplicate models by `model_key` before merging.
- Set a defensive maximum of 100 pages per sync.
- A repeated cursor/token, missing continuation cursor while more pages are declared, or page-limit overflow returns `invalid_response`.
- If any page fails, do not call `apply_remote_merge`; record the failure and keep all existing model rows unchanged.

**Validation:**

- Parser tests cover single-page and multi-page Anthropic/Gemini fixtures.
- A second-page failure leaves existing model availability unchanged.
- Duplicate model keys across pages produce one merged remote item.

### Task P5: Lock Saved-Configuration UX

**Outcome:** Users cannot accidentally test stale saved values while looking at unsaved Base URL or credential edits.

**Decisions:**

- Both actions operate on `providerId` and therefore use saved backend state.
- Define connection-relevant dirty state as either:
  - normalized Base URL differs from the saved value; or
  - credential action is `replace` or `clear`.
- Disable Test connection and Get models while connection-relevant changes are unsaved.
- Show visible helper text: “Save connection changes before testing or syncing models.”
- Saving successfully clears the dirty state and re-enables both actions.

**Validation:**

- Editing Base URL disables both actions.
- Entering or clearing a token disables both actions.
- Saving successfully re-enables both actions and subsequent calls use the saved provider ID.

## 3. File Map

- Modify: `src-tauri/Cargo.toml` — add async reqwest JSON support.
- Modify: `src-tauri/src/adapters/mod.rs` — register the transport module.
- Create: `src-tauri/src/adapters/transport.rs` — clients, request types, adapter authentication, endpoint construction, page parsing, pagination, and transport tests.
- Modify: `src-tauri/src/domain/model.rs` — connection/sync result DTOs and any internal transport page/item types that belong to the model domain.
- Modify: `src-tauri/src/services/models.rs` — vault/transport injection and async test/sync orchestration.
- Modify: `src-tauri/src/services/tests.rs` — service success/failure, vault, unauthenticated endpoint, pagination-failure, and status tests.
- Modify: `src-tauri/src/state.rs` — construct the real HTTP transport and inject vault plus transport into `ModelService`.
- Modify: `src-tauri/src/cmds/models.rs` — add async IPC commands.
- Modify: `src-tauri/src/lib.rs` — register both commands.
- Modify: `src-tauri/src/error.rs` only if task-join/internal mapping needs a new stable error; remote failures must not add a generic HTTP variant to `StorageError`.
- Modify: `src/storage/types.ts` — frontend DTO types and bounded sync-error type.
- Modify: `src/storage/client.ts` — typed Tauri invoke wrappers.
- Modify: `src/features/models/ProviderEditor.tsx` — action handlers, dirty-state guards, pending/result UI, and sync-status display.

## 4. HTTP Dependency and Clients

Add to `src-tauri/Cargo.toml`:

```toml
reqwest = { version = "0.13", features = ["json"] }
```

Use async reqwest directly from async Tauri commands. Do not enable or use `reqwest::blocking`.

In `src-tauri/src/adapters/transport.rs`, define two `OnceLock<reqwest::Client>` values or one `OnceLock<ClientSet>` containing both clients. Client construction must:

- set a 20-second timeout;
- retain default system-proxy behavior for inherit mode;
- call `.no_proxy()` for direct mode;
- return a sanitized internal error if a client cannot be built.

## 5. Adapter Transport Layer

`src-tauri/src/adapters/transport.rs` must start with:

```rust
// ABOUTME: Async HTTP transport for complete provider model-list synchronization.
// ABOUTME: Applies authentication, proxy, pagination, and bounded secret-free errors.
```

### Public transport contract

Define owned request data so the async future does not borrow form or vault state:

```rust
pub struct ModelListRequest {
    pub adapter_id: String,
    pub base_url: String,
    pub credential_kind: CredentialKind,
    pub secret: Option<String>,
    pub proxy_mode: ProxyMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    Auth,
    RateLimited,
    Network,
    Timeout,
    Server,
    InvalidResponse,
}
```

`TransportError::code()` returns exactly:

- `auth`
- `rate_limited`
- `network`
- `timeout`
- `server`
- `invalid_response`

`credential_unavailable` is a service-level sync code produced only when the native vault cannot supply a credential; it is not a transport error.

Implement `Display` with bounded human-readable text and implement `std::error::Error`. Messages must not contain response bodies, secrets, query strings, SQL, or raw vault errors.

### Injectable transport interface

Define a small interface without adding `async-trait`:

```rust
pub trait ModelTransport: Send + Sync {
    fn list_models(
        &self,
        request: ModelListRequest,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<RemoteModelSyncItem>, TransportError>> + Send + '_>>;
}

#[derive(Default)]
pub struct HttpModelTransport;
```

`HttpModelTransport` always uses real reqwest clients. Tests inject a test-only implementation from `services::tests`; there is no production mock mode or runtime mock switch.

### Endpoint construction

Parse the configured base URL with `url::Url`. Construct endpoints without string concatenation and without dropping an existing base path:

- OpenAI adapters: append `models` to bases such as `https://api.openai.com/v1` or `http://localhost:11434/v1`.
- Anthropic: append `v1/models` to `https://api.anthropic.com`.
- Gemini: append `v1beta/models` to `https://generativelanguage.googleapis.com`.

Normalize the base URL to a trailing slash before using `Url::join`. Reject URLs that cannot produce the expected endpoint as `invalid_response`. Do not log Gemini URLs after adding the `key` query parameter.

### Response parsing

Use adapter-specific page structs or pure `serde_json::Value` parsers:

- OpenAI: `{ data: [{ id }] }`.
- Anthropic: `{ data: [{ id, display_name }], has_more, first_id, last_id }`.
- Gemini: `{ models: [{ name, displayName, supportedGenerationMethods }], nextPageToken }`.

Strip the `models/` prefix from Gemini names. Reject blank IDs and IDs over the existing model-key limit before merge. Preserve bounded useful metadata only; never preserve credentials, headers, or complete raw responses.

Expose pure page-parsing helpers so fixtures can verify item extraction and continuation values without network access.

### HTTP error mapping

- 401/403 -> `Auth`
- 429 -> `RateLimited`
- 5xx -> `Server`
- reqwest timeout -> `Timeout`
- connection/DNS/TLS/send failure -> `Network`
- URL, JSON, schema, cursor, page-limit, and invalid-item failures -> `InvalidResponse`

On error, logs may include only `adapter_id` and the bounded error code.

## 6. ModelService Changes

Update `ModelService`:

```rust
#[derive(Clone)]
pub struct ModelService {
    db: Database,
    vault: Arc<dyn CredentialVault>,
    transport: Arc<dyn ModelTransport>,
}
```

Constructor:

```rust
pub fn new(
    db: Database,
    vault: Arc<dyn CredentialVault>,
    transport: Arc<dyn ModelTransport>,
) -> Self
```

Existing synchronous CRUD and merge methods remain synchronous.

### Saved provider resolution

Create an internal resolved request builder that runs inside `spawn_blocking` and distinguishes:

- provider/storage failure;
- missing required credential;
- credential-store unavailable/access failure;
- ready transport request, including `ProxyMode` and optional secret.

Resolve base URL from `provider.base_url_override` or `adapters::catalog::get(adapter_id).default_base_url`. A missing default and missing override is a validation/configuration failure before transport.

### `test_connection`

Signature:

```rust
pub async fn test_connection(
    &self,
    provider_id: Uuid,
) -> Result<ConnectionTestResult, StorageError>
```

Flow:

1. Resolve the saved provider and vault secret inside `spawn_blocking`.
2. Missing required secret -> `ok: false`, code `auth`.
3. Vault unavailable/access failure -> `ok: false`, code `credential_unavailable`.
4. Ready request -> await `transport.list_models`.
5. Complete list fetched -> `ok: true`, message includes the model count.
6. Transport failure -> `ok: false` with bounded code/message.
7. Never mutate model rows or provider sync status.

### `sync_models`

Signature:

```rust
pub async fn sync_models(
    &self,
    provider_id: Uuid,
) -> Result<SyncModelsResult, StorageError>
```

Flow:

1. Resolve the saved provider and vault secret inside `spawn_blocking`.
2. Missing required secret -> record `auth` and return a refreshed failure result.
3. Vault unavailable/access failure -> record `credential_unavailable` and return a refreshed failure result.
4. Ready request -> await the complete paginated transport result.
5. Success -> call `apply_remote_merge` inside `spawn_blocking`, then re-read models and provider.
6. Expected transport failure -> call `record_sync_error` inside `spawn_blocking`, then re-read unchanged models and updated provider.
7. Return `Ok(SyncModelsResult)` for both remote success and expected remote failure.
8. Return `Err(StorageError)` only when provider/storage/serialization/task execution prevents producing a trustworthy result.

Add a private helper that reads the current model DTOs and provider DTO after success/failure so both paths return a consistent snapshot.

## 7. Domain and Frontend Types

### Rust DTOs

Add to `src-tauri/src/domain/model.rs`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    /// Bounded transport/credential code; never `connection_changed`.
    pub error_code: Option<String>,
    pub message: String,
    pub model_count: Option<usize>,
    /// Non-sensitive connection version (`provider.updated_at` at resolve).
    /// Frontend discards results that no longer match the current provider version.
    pub provider_updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncModelsResult {
    pub ok: bool,
    /// Persisted models-sync error code, or the non-persisted race outcome
    /// `connection_changed`. Only bounded persisted codes are written to SQLite;
    /// `connection_changed` is never stored on the provider row.
    pub error_code: Option<String>,
    pub message: String,
    pub models: Vec<ProviderModelDto>,
    pub provider: ProviderInstanceDto,
}
```

Extend `validate_sync_error_code` to accept `credential_unavailable`. Do **not** accept `connection_changed` for persistence.

### TypeScript types

Add to `src/storage/types.ts`:

```ts
export type ModelsSyncErrorCode =
	"auth" | "rate_limited" | "network" | "timeout" | "server" | "invalid_response" | "credential_unavailable";

/** IPC sync result codes; includes non-persisted `connection_changed`. */
export type SyncModelsResultCode = ModelsSyncErrorCode | "connection_changed";

export interface ConnectionTestResult {
	ok: boolean;
	/** Transport / credential failure only; never connection_changed. */
	errorCode: ModelsSyncErrorCode | null;
	message: string;
	modelCount: number | null;
	/**
	 * Non-sensitive connection version from the provider row at resolve time
	 * (`provider.updatedAt`). UI should only display results that still match
	 * the currently selected provider's `updatedAt`.
	 */
	providerUpdatedAt: string;
}

export interface SyncModelsResult {
	ok: boolean;
	/**
	 * Failure or race outcome for this request.
	 * connection_changed is not a ModelsSyncErrorCode and is never persisted on the provider.
	 */
	errorCode: SyncModelsResultCode | null;
	message: string;
	models: ProviderModelDto[];
	provider: ProviderInstanceDto;
}
```

Use the project formatter for final indentation.

## 8. AppState and Test Construction

In `src-tauri/src/state.rs`:

```rust
let transport: Arc<dyn ModelTransport> = Arc::new(HttpModelTransport);
let models = ModelService::new(db.clone(), vault.clone(), transport);
```

Update every `ModelService::new` call in service tests. Test setup receives an `Arc<TestModelTransport>` whose queued results are protected by a mutex so each test controls its own responses without global state or cross-test interference.

## 9. IPC Commands

Add to `src-tauri/src/cmds/models.rs`:

```rust
#[tauri::command]
pub async fn test_provider_connection(
    state: State<'_, AppState>,
    provider_instance_id: Uuid,
) -> Result<ConnectionTestResult, IpcError>

#[tauri::command]
pub async fn sync_provider_models(
    state: State<'_, AppState>,
    provider_instance_id: Uuid,
) -> Result<SyncModelsResult, IpcError>
```

Clone `state.models` before awaiting. The service already moves SQLite and vault work off the async worker, so commands must not wrap the complete service future in `run_blocking`.

Register both commands in `src-tauri/src/lib.rs`.

## 10. Frontend Client and ProviderEditor

### Client wrappers

Add to `src/storage/client.ts`:

```ts
export async function testProviderConnection(providerInstanceId: string): Promise<ConnectionTestResult>;

export async function syncProviderModels(providerInstanceId: string): Promise<SyncModelsResult>;
```

Invoke names:

- `test_provider_connection`
- `sync_provider_models`

Use `{ providerInstanceId }`; Tauri maps this to `provider_instance_id`.

### ProviderEditor state

Add separate state for:

- connection-test pending and result;
- model-sync pending and result message;
- existing model-loading and model-mutation state.

Prevent duplicate calls while the corresponding action is pending. Disable both remote actions while connection-relevant changes are unsaved. Clear the connection-test result after a successful save or provider remount.

### Test connection behavior

- Call `testProviderConnection(provider.id)`.
- Render the returned message in an `aria-live` region.
- Success uses the project success color and includes model count when present.
- Expected failure uses danger styling and includes the bounded code.
- Unexpected IPC failure uses `getIpcErrorMessage`.

### Get models behavior

- Call `syncProviderModels(provider.id)`.
- For every successful IPC response, regardless of `result.ok`:
  - `setModels(result.models)`;
  - `upsertProvider(result.provider)`;
  - render `result.message` as success or failure.
- Preserve the displayed model list only when the IPC call itself fails before a trustworthy result is returned.
- Disable Get models while initial models are loading or another sync is pending.

### Sync status display

Show near the Models heading:

- never synced;
- last successful sync timestamp;
- latest persisted error code when status is error;
- current sync pending state.

Remove the “Backend command not yet available” wrappers and sr-only placeholders. Keep accessible names and live regions for the real result messages.

## 11. Tests

### Transport unit tests

In `src-tauri/src/adapters/transport.rs`:

- OpenAI item parsing.
- OpenAI blank/missing ID rejection.
- Anthropic item/display-name parsing.
- Anthropic continuation using `last_id` when `has_more` is true.
- Anthropic field semantics: missing/null/wrong-type `has_more` → `invalid_response`; empty `data` with `has_more=false` OK; `has_more=true` requires non-empty string `last_id` (missing/null/`""`/wrong type invalid); wrong-type `first_id`/`last_id` invalid even when unused.
- Anthropic missing/repeated cursor rejection.
- Gemini `models/` prefix stripping and display-name parsing.
- Gemini `nextPageToken` continuation and repeated-token rejection.
- Deduplication across pages.
- 100-page defensive limit.
- **Streaming body cap:** Content-Length oversize early reject; **chunked / no Content-Length** oversize production path aborts mid-stream at 2 MiB (server observes early disconnect / partial send, not full-buffer-then-check); small chunked body succeeds.
- Proxy client selection for inherit/direct.
- Authentication header/query construction without including secrets in formatted errors.
- Base URLs with and without trailing slash, including a custom `/v1` path.

### Service tests

In `src-tauri/src/services/tests.rs`:

- Test connection with unauthenticated OpenAI-compatible provider -> success, includes `providerUpdatedAt`.
- Test connection with missing required credential -> `ok: false`, `auth`, includes `providerUpdatedAt`.
- Test connection with failing vault -> `ok: false`, `credential_unavailable`.
- Test connection with transport auth/timeout failure -> matching bounded code and no DB mutation.
- Sync success -> models merged and returned provider status is `Ok`.
- Sync transport failure -> model rows unchanged, status `Error`, previous success timestamp preserved.
- Sync second-page failure -> no partial merge.
- Sync missing credential -> returned provider status is `Error` with `auth`.
- Sync failing vault -> returned provider status is `Error` with `credential_unavailable`.
- Test transport receives the saved `ProxyMode` and optional secret state.
- **connection_changed:** mid-flight identity change aborts merge/error write; race code not persisted.
- **Connection identity reset on Save:** base URL / proxy / credential replace reset `models_sync_status` to `Never` and clear `synced_at`/`error_code` in the save transaction; display-name-only preserves status; vault set failure before SQLite leaves prior status intact.
- **Per-provider serialization:** start two syncs; confirm the second is queued (still concurrency 1) before saving a connection change; release the first; assert the second re-resolves the new identity under the lock (not single-flight / shared Future).
- **clear_credential / none Save vs sync:** final clear transaction re-reads latest provider (preserve sync fields when identity unchanged; reset Never/None when changed). credentialKind none ordinary Keep Save after a committed sync preserves status when identity is unchanged and resets when it changes.

### Frontend validation

No React component-test framework is currently established for this feature. Record these manual checks in the implementation result instead of claiming typecheck covers behavior:

- dirty Base URL/token disables both actions and shows helper text;
- pending actions cannot be submitted twice;
- connection success/failure is announced;
- sync failure updates provider status without page reload;
- sync success refreshes model rows;
- changing provider clears transient results through keyed remount.

Run the existing frontend behavioral test task as part of regression validation.

## 12. Ordered Implementation Tasks

### Task 1: Add HTTP dependency and client policy

**Outcome:** Async reqwest compiles and inherit/direct clients have explicit behavior.

**Files:**

- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/adapters/transport.rs`
- Modify: `src-tauri/src/adapters/mod.rs`

**Steps:**

- Add reqwest 0.13 with JSON support.
- Add `OnceLock` client construction and explicit direct `.no_proxy()` behavior.
- Add proxy-selection tests.

**Validation:**

- Run: `cargo test adapters::transport` from `src-tauri`.
- Expected: client-policy tests pass and the crate compiles without blocking reqwest.

### Task 2: Implement complete adapter transport

**Outcome:** Every supported adapter returns a complete, deduplicated model snapshot or a bounded error.

**Files:**

- Modify: `src-tauri/src/adapters/transport.rs`

**Steps:**

- Implement URL construction and adapter authentication.
- Implement pure page parsers.
- Implement Anthropic and Gemini pagination guards.
- Implement HTTP/status/error mapping and secret-safe diagnostics.
- Add all parser, URL, pagination, and authentication tests from Section 11.

**Validation:**

- Run: `cargo test adapters::transport` from `src-tauri`.
- Expected: all adapter fixtures, pagination cases, URL cases, and error mappings pass.

### Task 3: Add result DTOs and bounded status code

**Outcome:** Backend and frontend can represent expected failure without IPC rejection.

**Files:**

- Modify: `src-tauri/src/domain/model.rs`
- Modify: `src-tauri/src/services/models.rs`
- Modify: `src/storage/types.ts`

**Steps:**

- Add Rust result DTOs.
- Extend sync-error validation with `credential_unavailable`.
- Add matching TypeScript types and narrow `ProviderInstanceDto.modelsSyncErrorCode` from `string | null` to `ModelsSyncErrorCode | null`.

**Validation:**

- Run: `mise run typecheck`.
- Run: `cargo test validate_sync_error_code` from `src-tauri` if a focused test is added; otherwise run the service test module.
- Expected: Rust and TypeScript agree on serialized camelCase fields and bounded codes.

### Task 4: Inject vault and transport into ModelService

**Outcome:** ModelService can resolve saved credentials and use a per-test transport without global overrides.

**Files:**

- Modify: `src-tauri/src/services/models.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/services/tests.rs`

**Steps:**

- Add vault and transport fields/constructor arguments.
- Build `HttpModelTransport` in AppState.
- Add per-test queued transport implementation.
- Update every ModelService test fixture.

**Validation:**

- Run: `cargo test services` from `src-tauri`.
- Expected: existing CRUD/merge tests still pass with the new constructor.

### Task 5: Implement service orchestration

**Outcome:** Test and sync flows follow the failure, credential, proxy, and snapshot rules in this plan.

**Files:**

- Modify: `src-tauri/src/services/models.rs`
- Modify: `src-tauri/src/services/tests.rs`

**Steps:**

- Implement saved-provider resolution inside `spawn_blocking`.
- Implement `test_connection` without DB mutation.
- Implement `sync_models` with full-snapshot merge and refreshed results on expected failure.
- Add every service scenario from Section 11.

**Validation:**

- Run: `cargo test services` from `src-tauri`.
- Expected: success, missing credential, vault failure, transport failure, and no-partial-merge tests pass.

### Task 6: Add and register IPC commands

**Outcome:** The frontend can call both async service methods through typed Tauri commands.

**Files:**

- Modify: `src-tauri/src/cmds/models.rs`
- Modify: `src-tauri/src/lib.rs`

**Steps:**

- Add both async commands.
- Clone ModelService before await.
- Register both command names.

**Validation:**

- Run: `cargo test` from `src-tauri`.
- Expected: all Rust tests pass and command signatures compile.

### Task 7: Add frontend client contracts

**Outcome:** TypeScript exposes typed wrappers for both commands.

**Files:**

- Modify: `src/storage/client.ts`
- Modify: `src/storage/types.ts`

**Steps:**

- Add imports and invoke wrappers.
- Confirm camelCase argument and response fields through typecheck and a desktop smoke test.

**Validation:**

- Run: `mise run typecheck`.
- Expected: no TypeScript errors.

### Task 8: Complete ProviderEditor behavior

**Outcome:** Both actions work against saved configuration and display current persisted state.

**Files:**

- Modify: `src/features/models/ProviderEditor.tsx`

**Steps:**

- Add dirty-state guards and helper text.
- Add connection-test pending/result behavior.
- Add model-sync pending/result behavior.
- Upsert returned provider on both expected success and expected failure.
- Render sync status and timestamp.
- Remove disabled-placeholder markup.

**Validation:**

- Run: `mise run typecheck`.
- Run: `mise run lint`.
- Run: `mise run build`.
- Expected: all commands pass.

### Task 9: Run full regression and desktop smoke test

**Outcome:** The complete backend/frontend loop works with real providers and existing behavior remains intact.

**Files:** No additional files unless validation exposes an in-scope defect.

**Steps:**

- Run all repository validation commands below.
- Exercise a real authenticated provider.
- Exercise a real unauthenticated local OpenAI-compatible provider if one is available.
- Verify dirty-form guards and failure-state refresh behavior.

**Validation:** See Section 13.

## 13. Final Validation

Run from the repository root unless noted:

1. `cargo test` in `src-tauri` — all Rust tests pass.
2. `cargo fmt --check` in `src-tauri` — Rust formatting is clean.
3. `cargo clippy --all-targets --all-features -- -D warnings` in `src-tauri` — no Clippy warnings.
4. `mise run test-frontend` — existing frontend behavioral tests pass.
5. `mise run typecheck` — TypeScript passes.
6. `mise run lint` — ESLint passes.
7. `mise run format:check` — Prettier and cargo fmt checks pass.
8. `mise run build` — frontend production build passes.
9. `cargo build` in `src-tauri` — Tauri Rust target compiles without requiring package/signing setup.

Do not regenerate `src/routeTree.gen.ts` because no route files are changed. If the router plugin regenerates it incidentally, inspect the diff rather than editing it manually.

### Manual desktop checks

Run `mise run tauri:dev` when a GUI and real endpoints are available:

1. Save a valid OpenAI, Anthropic, or Gemini provider and credential.
2. Test connection; confirm success and model count.
3. Sync models; confirm rows and last-sync status update.
4. Force an authentication failure; confirm the same response updates the visible provider error status without reload.
5. Edit Base URL or token without saving; confirm both remote actions are disabled.
6. Save changes; confirm actions re-enable and use the saved configuration.
7. Use an unauthenticated local OpenAI-compatible endpoint; confirm no Authorization header is required.
8. Restart the app; confirm synchronized models and status persist.

If real endpoints or GUI access are unavailable, report those skipped checks explicitly and retain the automated parser/service coverage as the verification evidence.

## 14. Rollout Notes

- No database migration is required; existing model and provider sync columns are reused.
- Adding `credential_unavailable` changes the bounded allowed values but does not require rewriting existing rows.
- No route generation is expected.
- Do not log request headers, response bodies, secrets, or Gemini query URLs during rollout diagnostics.
- Custom application proxy support must be designed separately because it requires proxy URL/credential resolution and more than the two client policies in this plan.

## 15. Risks and Mitigations

- **Provider API drift:** Keep page parsing isolated and fixture-tested; verify official model-list documentation immediately before implementation.
- **Partial pagination:** Never merge until all pages succeed; guard repeated cursors and page-count overflow.
- **False missing models:** Complete-snapshot rule prevents first-page-only responses from marking valid rows missing.
- **Proxy leakage:** Direct mode always selects the `.no_proxy()` client.
- **Credential leakage:** Use owned secret values only in backend request construction; never include headers/query URLs/raw errors in logs or DTOs.
- **Vault outage mislabeled as auth:** Persist and return `credential_unavailable` separately.
- **Stale frontend sync status:** Expected failure returns refreshed provider/models in `SyncModelsResult` and the frontend always upserts them.
- **Testing stale form values:** Disable remote actions while connection-relevant edits are unsaved.
- **Concurrent sync clicks:** Per-provider async mutex serializes syncs (transport max concurrency 1). This is **serialization**, not single-flight: each caller runs its own Future after the previous finishes and **re-reads the latest connection identity** under the lock. Frontend also disables the action while pending.
- **Large provider responses:** Stream response bodies with a hard **2 MiB** cap (`response.chunk()`, never full-buffer `response.bytes()` first). Reject oversized `Content-Length` early; for chunked / missing-length bodies abort as soon as cumulative size exceeds the cap. Also deduplicate incrementally and enforce the 100-page defensive limit and total-model cap.
- **connection_changed races:** Merge and sync-error writes compare connection identity (adapter / base URL / credential kind / ref / proxy) in the same SQLite transaction. When identity no longer matches the resolved request, skip the write and return non-persisted `connection_changed` with a refreshed snapshot.
- **New connection inheriting old sync status:** When a Save changes connection identity, the same save transaction resets `models_sync_status` to `Never` and clears `models_synced_at` / `models_sync_error_code`. Covers the reverse order where a guarded sync write commits first and Save commits second, and vault set failures that never reach SQLite (status stays put).
- **Stale test-connection UI:** `ConnectionTestResult` carries non-sensitive `providerUpdatedAt` (provider row `updated_at` at resolve). The editor only displays results that still match the current provider version on the save/refresh path.
