# Frontend Provider Plugin Migration Implementation Plan

**Goal:** Move provider wire formats and translate/detect/model-sync business workflows to frontend TypeScript plugins while Rust retains only credential storage, generic auth injection, bounded HTTP transport, proxy handling, cancellation, and persistence.

**Inputs:** The agreed “B” architecture: frontend Provider plugins build and parse requests; Rust resolves provider credentials from the OS vault and injects auth without returning secrets or credential references over IPC.

**Assumptions:**

- Authenticated Provider traffic will use a project-owned fetch-like `providerFetch` facade over Tauri commands and `tauri::ipc::Channel`, not stock `@tauri-apps/plugin-http` frontend `fetch`. The stock API accepts frontend-provided URLs/headers but exposes no application hook for vault lookup and native auth injection.
- Provider auth configuration, effective Base URL, and Base URL source (`plugin_default` or `custom`) are persisted with each provider instance. This binds a secret to one configured origin and avoids per-Provider Rust code.
- Each plugin resolves its auth scheme from the saved `CredentialKind`; OpenAI-shaped plugins therefore support both no-auth (`none`) and authenticated (`bearer`) instances.
- A model API Type override is wire-format-only under the new architecture. It is executable only when its auth scheme is compatible and either the provider has a custom Base URL or the override plugin equals the provider plugin. Existing cross-plugin rows that relied on automatic default-host switching fail closed with `provider_reconfiguration_required`; users must configure an explicit shared relay URL or create a separate provider instance.
- Built-in Providers migrate first through the same public TypeScript plugin interface intended for future external plugins.
- Dynamic plugin package discovery, signatures, sandboxing, installation UI, and marketplace/distribution are out of scope. This plan establishes the runtime contract and registration boundary only.
- Existing uncommitted Rust adapter changes are unrelated working-tree changes and must not be overwritten while executing this plan.

**Architecture:** Frontend Provider plugins own metadata, endpoint paths, request bodies, response parsing, SSE interpretation, pagination, and task policy. A generic Rust `ProviderHttpService` resolves the stored provider Base URL, proxy mode, auth scheme, and vault secret; it accepts only relative request paths, injects the secret natively, applies limits, and returns raw response data or byte chunks through a typed Channel. Frontend feature workflows use those plugins for connection testing, model sync, detection, non-stream translation, streaming fallback, and history completion calls.

**Tech Stack:** Tauri 2 commands and `tauri::ipc::Channel`, Rust `reqwest`, React 19, TypeScript, Effect 3, TanStack Query, Bun tests, SQLite, native keyring, mise tasks.

---

## Plan Tree

```text
Frontend Provider Plugin Migration
├─ 1. Persist transport identity
│  ├─ Effective Base URL
│  ├─ Versioned generic AuthScheme
│  ├─ Import/export migration
│  └─ Structural adapter-id validation
├─ 2. Add generic native request transport
│  ├─ Relative URL resolution
│  ├─ Vault lookup + auth injection
│  ├─ Header/redirect/security policy
│  └─ Bounded non-stream response
├─ 3. Add native streaming transport
│  ├─ Typed Tauri Channel
│  ├─ Raw byte chunks
│  ├─ Idle/connect limits
│  └─ Generic request cancellation
├─ 4. Build frontend plugin kernel
│  ├─ ProviderPlugin contract
│  ├─ Registry and capability checks
│  ├─ Fetch-like transport facade
│  └─ Shared SSE decoder
├─ 5. Port built-in Provider plugins
│  ├─ OpenAI Compatible
│  ├─ OpenAI Responses
│  ├─ Anthropic
│  ├─ Gemini
│  └─ DeepSeek
├─ 6. Cut over connection test and model sync
│  ├─ Frontend pagination and parsing
│  ├─ Optimistic sync persistence IPC
│  └─ Query invalidation
├─ 7. Cut over non-stream translation
│  ├─ Context and template resolution
│  ├─ Ordered fallback
│  ├─ Provider error normalization
│  └─ History persistence
├─ 8. Cut over language detection
│  ├─ Detect model resolution
│  ├─ Plugin-owned policy
│  └─ Supported-code validation
├─ 9. Cut over streaming translation
│  ├─ Channel consumption
│  ├─ Delta parsing
│  ├─ Fallback reset semantics
│  ├─ Abort/cancel
│  └─ Single terminal history record
└─ 10. Remove Rust Provider business logic
   ├─ Delete Rust adapters and registry
   ├─ Shrink ModelService to CRUD/persistence
   ├─ Remove legacy translate events/commands
   └─ Document plugin boundary
```

## Target Contracts

### Persisted Auth Scheme

Both Rust and TypeScript use the same versioned discriminated union:

```ts
export type AuthSchemeV1 =
  | { schemaVersion: 1; type: "none" }
  | { schemaVersion: 1; type: "bearer" }
  | { schemaVersion: 1; type: "header"; name: string }
  | { schemaVersion: 1; type: "query"; name: string };
```

Built-in mappings:

| Plugin            | Auth scheme                                               | Non-secret fixed headers        |
| ----------------- | --------------------------------------------------------- | ------------------------------- |
| OpenAI Compatible | `none` when credential kind is `none`; otherwise `bearer` | None                            |
| OpenAI Responses  | `none` when credential kind is `none`; otherwise `bearer` | None                            |
| DeepSeek          | `none` when credential kind is `none`; otherwise `bearer` | None                            |
| Anthropic         | `header/x-api-key`                                        | `anthropic-version: 2023-06-01` |
| Gemini            | `query/key`                                               | None                            |

Rust validates header/query names and credential compatibility but never branches on plugin or adapter IDs.

### Frontend Wire Request

```ts
export interface ProviderWireRequest {
  method: "GET" | "POST";
  relativePath: string;
  query: readonly [name: string, value: string][];
  headers: Readonly<Record<string, string>>;
  body: string | null;
}
```

Rules:

- `relativePath` cannot contain a scheme, authority, fragment, leading `//`, or parent traversal.
- Plugin-provided query values and headers must never contain credentials.
- Rust blocks caller-provided `authorization`, `proxy-authorization`, `x-api-key`, `cookie`, `host`, `content-length`, and the configured auth header/query name.
- Rust resolves the URL only under the provider instance’s persisted Base URL.
- Redirects are disabled for the first release. A later same-origin redirect policy requires a separate security review.

### Native Request IPC

```ts
export interface ProviderHttpRequest {
  requestId: string;
  providerInstanceId: string;
  wire: ProviderWireRequest;
}

export interface ProviderHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}
```

Commands:

- `provider_http_request(input) -> ProviderHttpResponse`
- `provider_http_stream(input, onEvent: Channel<ProviderHttpStreamEvent>) -> void`
- `cancel_provider_http(requestId) -> boolean`

Stream events:

```ts
export type ProviderHttpStreamEvent =
  | { event: "started"; data: { status: number; headers: Record<string, string> } }
  | { event: "chunk"; data: { bytes: number[] } }
  | { event: "finished"; data: null };
```

Transport errors reject the invoke as the existing sanitized `IpcError`. HTTP 4xx/5xx remain normal raw responses so frontend workflows can map provider status and body without Rust Provider knowledge.

### Provider Plugin

```ts
export interface ChatBuildInput {
  operation: "translate" | "detect" | "ocr";
  stream: boolean;
  modelKey: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number | null;
  maxTokens: number | null;
  thinking: boolean | null;
  imagePngBase64: string | null;
}

export type StreamParseResult = { kind: "delta"; text: string } | { kind: "ignore" };

export class ProviderProtocolError extends Error {
  readonly code = "invalid_response";
}

export interface ProviderPlugin {
  readonly manifest: ProviderPluginManifest;
  resolveAuthScheme(credentialKind: CredentialKind): AuthSchemeV1;
  buildModelListRequest(input: ModelListBuildInput): ProviderWireRequest;
  parseModelListPage(response: ProviderHttpResponse): ParsedModelPage;
  buildChatRequest(input: ChatBuildInput): ProviderWireRequest;
  parseChatResponse(response: ProviderHttpResponse): string;
  parseStreamEvent(event: SseEvent): StreamParseResult;
  getDetectPolicy(input: DetectPolicyInput): DetectPolicy;
}
```

`parseChatResponse`, `parseModelListPage`, and `parseStreamEvent` throw `ProviderProtocolError` when a response claims relevant content but is malformed. `parseStreamEvent` returns `ignore` only for valid non-text/keepalive events. Feature workflows catch this exact error and map it to retry-eligible `invalid_response`; unexpected plugin exceptions also map to `invalid_response` but are non-retryable and retain only sanitized diagnostics. `ProviderPluginManifest` includes stable ID, label, default Base URL, supported credential kinds, and capabilities such as model listing, streaming, text generation, and image input. Registry duplicate IDs fail during registration. Missing plugins remain visible in persisted DTOs but execution returns `plugin_unavailable`.

---

## File Map

### Create

- `src-tauri/migrations/0011_provider_transport_contract.sql` — rename/backfill effective provider Base URL, record whether it came from a plugin default or custom value, and persist versioned auth scheme.
- `src-tauri/src/domain/provider_http.rs` — generic wire request, raw response, auth scheme, and Channel event DTOs.
- `src-tauri/src/services/provider_http.rs` — provider resolution, vault lookup, generic auth injection, security validation, and request/stream execution.
- `src-tauri/src/error.rs` — add sanitized raw transport/plugin-boundary error codes where existing codes are insufficient.
- `src-tauri/src/cmds/provider_http.rs` — request, stream, and cancel Tauri commands.
- `src/features/providers/types.ts` — `ProviderPlugin`, manifest, wire, auth, page, chat, and SSE contracts.
- `src/features/providers/registry.ts` — built-in/future plugin registration and lookup.
- `src/features/providers/providerFetch.ts` — fetch-like non-stream/stream facade over invoke and Channel.
- `src/features/providers/sse.ts` — incremental UTF-8 and SSE event decoder over raw chunks.
- `src/features/providers/errors.ts` — raw HTTP/IPC/provider error normalization.
- `src/features/providers/builtin/openaiShared.ts` — shared OpenAI wire helpers.
- `src/features/providers/builtin/openaiCompatible.ts` — OpenAI Chat Completions plugin.
- `src/features/providers/builtin/openaiResponses.ts` — OpenAI Responses plugin.
- `src/features/providers/builtin/anthropic.ts` — Anthropic Messages plugin.
- `src/features/providers/builtin/gemini.ts` — Gemini plugin.
- `src/features/providers/builtin/deepseek.ts` — DeepSeek plugin and detect policy.
- `src/features/providers/builtin/index.ts` — built-in registration list.
- `src/features/providers/*.test.ts` and `src/features/providers/builtin/*.test.ts` — registry, transport facade, SSE, payload, response, pagination, and policy tests.
- `src/features/models/providerConnection.ts` — frontend connection-test workflow.
- `src/features/models/providerModelSync.ts` — paginated model sync and persistence workflow.
- `src/features/models/providerConnection.test.ts` — connection status/error mapping coverage.
- `src/features/models/providerModelSync.test.ts` — paging, repeated cursor, dedupe, race, and persistence coverage.
- `src/features/translate/promptTemplate.ts` — strict translation placeholder rendering.
- `src/features/translate/promptTemplate.test.ts` — placeholder, escaping, and invalid-template coverage.
- `src/features/translate/translationContext.ts` — resolve model, provider, profile, ordered fallback, and display/history snapshots from Query-backed DTOs.
- `src/features/translate/translationWorkflow.ts` — non-stream/stream attempt orchestration and history completion.
- `src/features/translate/translationWorkflow.test.ts` — fallback, cancellation, reset, and history semantics.

### Modify

- `src-tauri/src/lib.rs` — register generic Provider HTTP commands and eventually remove legacy transport commands.
- `src-tauri/src/state.rs` — add `ProviderHttpService`; rename the translate-only session registry to a generic HTTP request registry.
- `src-tauri/src/domain/provider.rs` — replace optional `base_url_override` with effective `base_url`, `base_url_source`, and persisted `auth_scheme` in entities, DTOs, and writes.
- `src-tauri/src/domain/cancel.rs` — generalize request session naming without changing cancellation behavior.
- `src-tauri/src/domain/import_export.rs` — export effective Base URL/auth scheme and bump the configuration format version.
- `src-tauri/src/domain/translation.rs` — remove legacy stream event DTOs/constants after Channel cutover.
- `src-tauri/src/domain/translation_history.rs` — add a validated, idempotent frontend-completion input for history persistence.
- `src-tauri/src/repositories/provider_instances.rs` — read/write new transport metadata.
- `src-tauri/src/repositories/provider_models.rs` — retain transactional remote snapshot application for frontend-parsed model items.
- `src-tauri/src/domain/model.rs` — retain remote sync item DTOs and add frontend-sync persistence inputs.
- `src-tauri/src/services/providers.rs` — validate structural adapter IDs and generic auth schemes instead of consulting the Rust adapter catalog.
- `src-tauri/src/services/models.rs` — add optimistic sync apply/failure methods, then remove remote transport and translation/detection orchestration.
- `src-tauri/src/services/mod.rs` — export the generic Provider HTTP service and remove deleted adapter-service exports.
- `src-tauri/src/services/translation_history.rs` — expose a validated, best-effort record method for frontend-completed attempts.
- `src-tauri/src/services/import_validation.rs` — validate/migrate configuration format and Provider transport metadata.
- `src-tauri/src/cmds/models.rs` — add sync persistence commands, then remove connection/sync/translate/detect commands after cutover.
- `src-tauri/src/cmds/translation_history.rs` — add history completion command.
- `src-tauri/src/cmds/mod.rs` — export `provider_http`.
- `src-tauri/src/services/tests.rs` — replace Provider adapter/transport business tests with persistence and compatibility tests.
- `src-tauri/src/repositories/tests.rs` — cover migrated Provider columns and sync race behavior.
- `src-tauri/src/credentials/tests.rs` — assert secrets still never cross IPC-facing DTOs.
- `src/storage/types.ts` — mirror Provider transport metadata, native raw HTTP types, history completion, and error codes.
- `src/storage/client.ts` — keep CRUD/persistence IPC only; add sync-apply/history-completion wrappers and remove legacy remote workflow wrappers.
- `src/features/models/adapterOptions.ts` — become a compatibility facade over the plugin registry, then remove once call sites import registry selectors directly.
- `src/features/models/AddProviderDialog.tsx` — initialize effective Base URL/auth scheme from selected plugin manifest.
- `src/features/models/ProviderEditor.tsx` — edit persisted effective Base URL and display missing-plugin/auth-compatibility states.
- `src/features/models/AddManualModelDialog.tsx` — source API Type options from registry and enforce auth compatibility.
- `src/features/models/EditModelConfigDialog.tsx` — source API Type options from registry and enforce auth compatibility.
- `src/features/models/ModelsTable.tsx` — resolve labels/missing-plugin state from registry.
- `src/features/translate/translateStream.ts` — start the frontend-owned streaming workflow instead of legacy `translate_text_stream` IPC.
- `src/features/translate/detectLanguageFlow.ts` — build and execute detection through the selected plugin.
- `src/features/translate/slotBatch.ts` — start frontend workflows with per-slot isolation and generic HTTP cancellation.
- `src/features/translate/runTranslate.ts` — expose the migrated runners without deep Effect use in JSX.
- `src/features/translate/useTranslateStreamSession.ts` — consume workflow callbacks instead of global Tauri translate events.
- `src/features/translate/useSlotStreamSessions.ts` — consume per-job workflow callbacks and preserve stale-request guards.
- `src/routes/translate/index.tsx` — pass Query-backed execution context into migrated runners; keep UI behavior unchanged.
- `src/routes/quick-translate.tsx` — pass Query-backed execution context into migrated slot/detect runners.
- `src/query/options.ts` — expose reusable provider/model/profile detail options needed by context resolution.
- `src/i18n/locales/en.ts` — replace “Base URL override” copy and add missing/incompatible plugin errors.
- `src/i18n/locales/zh-CN.ts` — matching localized copy.
- `docs/architecture/adapter-strategy.md` — replace Rust strategy architecture with frontend plugin/native transport boundary.
- `docs/architecture/frontend-state-management.md` — replace global `translate://*` stream ownership with per-call Channel/frontend workflow ownership.

### Delete After Cutover

- `src-tauri/src/adapters/builtin/anthropic.rs`
- `src-tauri/src/adapters/builtin/deepseek.rs`
- `src-tauri/src/adapters/builtin/gemini.rs`
- `src-tauri/src/adapters/builtin/openai_compatible.rs`
- `src-tauri/src/adapters/builtin/openai_responses.rs`
- `src-tauri/src/adapters/builtin/openai_shared.rs`
- `src-tauri/src/adapters/builtin/mod.rs`
- `src-tauri/src/adapters/catalog.rs`
- `src-tauri/src/adapters/protocol.rs`
- `src-tauri/src/adapters/registry.rs`
- `src-tauri/src/adapters/transport.rs`
- `src-tauri/src/adapters/mod.rs`
- `src/features/translate/attachTranslateStreamListeners.ts`

Do not edit `src/routeTree.gen.ts` manually.

---

## Tasks

### Task 1: Persist Provider Transport Identity

**Outcome:** Every provider instance has an explicit effective Base URL and generic versioned auth scheme, so Rust transport can execute requests without a built-in adapter catalog.

**Files:**

- Create: `src-tauri/migrations/0011_provider_transport_contract.sql`
- Modify: `src-tauri/src/domain/provider.rs`
- Modify: `src-tauri/src/repositories/provider_instances.rs`
- Modify: `src-tauri/src/services/providers.rs`
- Modify: `src-tauri/src/domain/import_export.rs`
- Modify: `src-tauri/src/services/import_validation.rs`
- Modify: `src/storage/types.ts`
- Modify: `src/features/models/AddProviderDialog.tsx`
- Modify: `src/features/models/ProviderEditor.tsx`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh-CN.ts`
- Test: `src-tauri/src/repositories/tests.rs`
- Test: `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] Add `AuthSchemeV1` in Rust and TypeScript with only `none`, `bearer`, `header{name}`, and `query{name}` variants.
- [ ] Validate `schemaVersion === 1`, ASCII token header/query names, maximum name length, and restricted names. Keep all non-trivial limits as named constants.
- [ ] Rename the persisted `base_url_override` column to `base_url`; add `base_url_source`; backfill `custom` when the old override was present and `plugin_default` plus the current catalog default when it was absent.
- [ ] Add `auth_scheme_json`; backfill from both built-in adapter ID and stored credential kind so no-auth OpenAI-compatible, OpenAI Responses, and DeepSeek instances remain `none` rather than becoming `bearer`.
- [ ] Add migration tests for authenticated and no-auth OpenAI-compatible rows, plus each fixed-header/query built-in.
- [ ] Inventory models where `model.adapter_id != provider.adapter_id` and the old provider Base URL override was null. Preserve and test those rows during Task 1; Task 5 introduces frontend `provider_reconfiguration_required` enforcement. Do not change interim legacy execution before that cutover.
- [ ] Update Provider entities, DTOs, writes, repositories, form state, and localized copy from optional “Base URL override” semantics to a required effective Base URL.
- [ ] Require current-format unknown plugin IDs to provide explicit `baseUrl`, `baseUrlSource=custom`, and a valid auth scheme; missing plugin metadata remains readable but cannot be created with an invented default.
- [ ] Keep vault secrets and `credential_ref` absent from all DTOs and exports.
- [ ] Replace `catalog::get(adapter_id)` service validation with stable ID syntax validation. Unknown IDs are valid persisted plugin IDs.
- [ ] Validate the explicit compatibility matrix: `none ↔ CredentialKind::None`; `bearer ↔ ApiKey|Bearer`; `header|query ↔ ApiKey|Bearer`. A non-`none` scheme still requires a credential on execution.
- [ ] Bump `EXPORT_FORMAT_VERSION` from `2` to `3` and include `baseUrl`, `baseUrlSource`, and `authScheme`. Replace exact-version rejection with an explicit v2→v3 migration: non-null `baseUrlOverride` becomes `baseUrlSource=custom`; null uses the built-in default and `plugin_default`; auth derives from adapter ID plus credential kind. Reject a v2 provider with an unknown adapter ID and no explicit Base URL rather than inventing a host. Keep unsupported versions rejected.
- [ ] Every built-in provider create/edit write must derive `authScheme` from the selected plugin plus `credentialKind` before IPC. Rust validates the submitted scheme/credential matrix before persistence. When editing a provider whose plugin is missing, allow only preserving the existing auth scheme until the plugin is restored.
- [ ] Keep the current Rust adapters operational during this task. Interim legacy resolution must use the persisted provider Base URL when `baseUrlSource=custom`; when `plugin_default`, it must retain the current model-override default-host behavior until that row is deliberately cut over or rejected by the frontend compatibility rule.
- [ ] Keep existing model-override endpoint/auth tests green in Task 1; rewrite their expected behavior only in Task 5 alongside the new `provider_reconfiguration_required` rule.
- [ ] Start every created code/SQL file with the required two-line `ABOUTME` comment using the file’s comment syntax.

**Validation:**

- Run: `mise run test provider_transport_contract`
- Expected: tests named with the `provider_transport_contract` prefix cover migration, no-auth/authenticated CRUD, previous/current import formats, unknown plugin IDs, model-override inventory, auth validation, and secret omission.
- Run: `mise run typecheck`
- Expected: Provider forms and DTO consumers compile with required `baseUrl` and `authScheme`.

### Task 2: Add Generic Non-Streaming Native Transport

**Outcome:** Frontend code can send an unsigned relative Provider request and receive a raw bounded response while Rust resolves Base URL, proxy, auth metadata, and vault secret generically.

**Files:**

- Create: `src-tauri/src/domain/provider_http.rs`
- Create: `src-tauri/src/services/provider_http.rs`
- Create: `src-tauri/src/cmds/provider_http.rs`
- Modify: `src-tauri/src/cmds/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/error.rs`
- Test: `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] Define serde DTOs for `ProviderWireRequest`, `ProviderHttpRequest`, `ProviderHttpResponse`, and `AuthSchemeV1` using camelCase IPC fields.
- [ ] Resolve the full internal provider row by `providerInstanceId`; reject missing or disabled providers before vault access.
- [ ] Build the target URL from persisted `base_url` plus `relativePath` and query pairs using the current `build_endpoint` semantics: preserve Base URL path prefixes and normalize exactly one separator. Reject absolute paths, alternate authorities, fragments, traversal, and unsupported schemes.
- [ ] Reject insecure HTTP unless the provider row already contains `insecure_http_confirmed_at`.
- [ ] Reject caller-provided sensitive headers/query keys before secret lookup.
- [ ] Resolve the secret only through `CredentialVault::get_for_backend_use`; inject bearer, generic header, or generic query auth according to stored `AuthSchemeV1`.
- [ ] Keep proxy selection native and derive it from persisted `ProxyMode`; do not accept proxy mode or proxy credentials from frontend request input.
- [ ] Disable redirects and preserve existing connect/request timeouts, decompressed body cap, status visibility, and sanitized logging.
- [ ] Return raw status, UTF-8 body, and only `content-type` plus `retry-after` response headers in v1. Invalid UTF-8 or oversized bodies return sanitized transport errors.
- [ ] Do not parse Provider JSON, map Provider status codes, or inspect response business fields in Rust.
- [ ] Keep an injectable native transport trait so tests do not require external network access.

**Validation:**

- Run: `mise run test provider_http_request`
- Expected: URL confinement, auth injection for all schemes, restricted headers, missing credentials, disabled provider, proxy selection, redirects, body limits, and log redaction pass.
- Run: `mise run format:check`
- Expected: Rust formatting passes.

### Task 3: Add Raw Streaming and Generic Cancellation

**Outcome:** Frontend receives incremental raw response bytes through a per-call Tauri Channel and can cancel by request ID without global Provider-specific stream events.

**Files:**

- Modify: `src-tauri/src/domain/provider_http.rs`
- Modify: `src-tauri/src/services/provider_http.rs`
- Modify: `src-tauri/src/cmds/provider_http.rs`
- Modify: `src-tauri/src/domain/cancel.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] Add tagged `started`, `chunk`, and `finished` Channel events. `chunk` carries raw bytes; Rust must not parse SSE event names, JSON, output deltas, or Provider completion markers.
- [ ] Implement `provider_http_stream` as an awaited command that sends Channel progress while the invoke remains active; do not detach a global-event worker.
- [ ] Register the cancellation token before network work begins and remove it exactly once on every terminal path.
- [ ] Generalize `TranslateSessionRegistry` naming to a request/session registry used by raw Provider HTTP requests.
- [ ] Implement `cancel_provider_http`; unknown/finished IDs remain idempotent success with `false`.
- [ ] Preserve connect timeout, stream idle timeout, per-chunk/buffer limits, total streamed byte cap, proxy handling, and secret-redacted logs.
- [ ] Ensure Channel send failure cancels/drops the network request rather than continuing after its frontend consumer disappears.
- [ ] Keep legacy `cancel_translate` as a temporary compatibility alias until Task 9.

**Validation:**

- Run: `mise run test provider_http_stream`
- Expected: incremental chunks, cancellation before headers, cancellation mid-body, idle timeout, byte cap, consumer disconnect, and session cleanup pass.
- Run: `mise run test cancel_provider_http`
- Expected: duplicate/unknown cancellation is safe and no session leaks remain.
- Manual: `mise run tauri:dev`
- Expected: a temporary development caller observes more than one Channel chunk before the request completes; remove the temporary caller before completing the task.

### Task 4: Build the Frontend Provider Plugin Kernel

**Outcome:** TypeScript has a pure, testable plugin contract and fetch-like native transport facade with no built-in Provider assumptions in shared code.

**Files:**

- Create: `src/features/providers/types.ts`
- Create: `src/features/providers/registry.ts`
- Create: `src/features/providers/providerFetch.ts`
- Create: `src/features/providers/sse.ts`
- Create: `src/features/providers/errors.ts`
- Create: `src/features/providers/registry.test.ts`
- Create: `src/features/providers/providerFetch.test.ts`
- Create: `src/features/providers/sse.test.ts`
- Modify: `src/storage/types.ts`

**Steps:**

- [ ] Define `ProviderPluginManifest`, `ProviderPlugin`, `ProviderWireRequest`, `ChatBuildInput` (including `operation` and `stream`), parsed pages, typed stream parse results/errors, detect policy, and capability flags without importing React, Effect, Query, or route code.
- [ ] Implement registration, duplicate-ID rejection, lookup, stable list ordering, missing-plugin errors, `resolveAuthScheme(credentialKind)`, and auth-compatibility comparison.
- [ ] Implement `providerFetch` for non-stream responses and `providerFetchStream` using `Channel<ProviderHttpStreamEvent>`.
- [ ] Wrap Channel chunks as an async iterable or callback-driven byte source; wire `AbortSignal` to one idempotent `cancel_provider_http` call.
- [ ] Decode UTF-8 incrementally and parse SSE per the standard line/event rules: CRLF/LF, comments, repeated `data:` lines, optional `event:`, blank-event dispatch, and trailing decoder flush.
- [ ] Keep HTTP status mapping generic in `errors.ts`; keep Provider JSON error extraction inside each plugin.
- [ ] Verify transport inputs contain no secret-shaped fields such as `secret`, `apiKey`, `credentialRef`, or `authorization`.

**Validation:**

- Run: `bun test src/features/providers/registry.test.ts src/features/providers/providerFetch.test.ts src/features/providers/sse.test.ts`
- Expected: registry, missing plugin, Channel ordering, abort, incremental UTF-8, split-line SSE, and transport error tests pass.
- Run: `mise run typecheck`
- Expected: contracts compile without importing frontend framework layers.

### Task 5: Port All Built-In Providers to TypeScript Plugins

**Outcome:** The five built-ins produce and parse the same request/response behavior through the shared TypeScript plugin interface.

**Files:**

- Create: `src/features/providers/builtin/openaiShared.ts`
- Create: `src/features/providers/builtin/openaiCompatible.ts`
- Create: `src/features/providers/builtin/openaiResponses.ts`
- Create: `src/features/providers/builtin/anthropic.ts`
- Create: `src/features/providers/builtin/gemini.ts`
- Create: `src/features/providers/builtin/deepseek.ts`
- Create: `src/features/providers/builtin/index.ts`
- Create: `src/features/providers/builtin/*.test.ts`
- Modify: `src/features/models/adapterOptions.ts`
- Modify: `src/features/models/AddProviderDialog.tsx`
- Modify: `src/features/models/ProviderEditor.tsx`
- Modify: `src/features/models/AddManualModelDialog.tsx`
- Modify: `src/features/models/EditModelConfigDialog.tsx`
- Modify: `src/features/models/ModelsTable.tsx`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh-CN.ts`

**Steps:**

- [ ] Port URL paths, payload bodies, multimodal image encoding, content extraction, stream delta extraction, model-list page parsing, pagination continuation, and metadata bounds from each Rust adapter as pure TypeScript.
- [ ] Move DeepSeek detection policy (`thinking: disabled`, raised token budget) into `deepseek.ts`.
- [ ] Move Anthropic’s non-secret version header into its plugin-built wire request; keep `x-api-key` injection native.
- [ ] Move Gemini `alt=sse`, model resource normalization, and pagination token handling into `gemini.ts`; keep `key` injection native.
- [ ] Preserve response/page caps in frontend parsing as defense in depth while Rust retains network byte caps. Stream parsers must distinguish valid ignored events from malformed claimed content via typed errors.
- [ ] Register all built-ins through the same registry API future external plugins will call.
- [ ] Replace `ADAPTER_OPTIONS` consumers with registry selectors; retain unknown persisted IDs in selectors with a missing-plugin label rather than deleting data.
- [ ] Prevent model API Type execution when the target plugin auth scheme differs from the owning provider auth scheme. When the provider Base URL source is `plugin_default`, also require the override plugin ID to equal the provider plugin ID; otherwise surface the localized `provider_reconfiguration_required` error. A custom shared relay URL permits wire-compatible overrides with matching auth.
- [ ] Change backend model adapter validation from catalog membership to structural ID validation; imports and writes preserve unknown plugin IDs, while frontend execution fails closed when the plugin is unavailable or transport-incompatible.
- [ ] Replace the current tests that expect model overrides to auto-switch built-in default hosts with explicit tests for the new reconfiguration rule; retain tests proving custom relay URLs remain usable.
- [ ] Port current Rust parser/payload test cases as TypeScript fixtures before deleting any Rust tests.

**Validation:**

- Run: `bun test src/features/providers/builtin`
- Expected: all payload, content, SSE delta, pagination, malformed response, bounds, image, and detect-policy fixtures pass.
- Run: `mise run typecheck`
- Expected: provider/model UI uses registry metadata with no hard-coded adapter option array.

### Task 6: Cut Over Connection Testing and Model Sync

**Outcome:** Connection tests and remote model sync are frontend workflows using Provider plugins; Rust only sends raw requests and transactionally persists parsed model snapshots/status.

**Files:**

- Create: `src/features/models/providerConnection.ts`
- Create: `src/features/models/providerModelSync.ts`
- Create: `src/features/models/providerConnection.test.ts`
- Create: `src/features/models/providerModelSync.test.ts`
- Modify: `src-tauri/src/domain/model.rs`
- Modify: `src-tauri/src/services/models.rs`
- Modify: `src-tauri/src/cmds/models.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/storage/types.ts`
- Modify: `src/storage/client.ts`
- Modify: `src/features/models/ProviderEditor.tsx`
- Modify: `src/query/options.ts`

**Steps:**

- [ ] Build model-list requests and parse pages through the selected plugin.
- [ ] Move page continuation, repeated-cursor detection, dedupe-by-model-key, page count, per-page item count, and total model count policy to `providerModelSync.ts`.
- [ ] Add persistence commands for successful complete snapshots and failed sync status. Inputs include `providerInstanceId` and expected `provider.updatedAt` captured before the first request.
- [ ] Preserve current all-pages-before-merge behavior; any page failure leaves existing model rows unchanged.
- [ ] Preserve `connection_changed`: Rust compares expected connection version before transactionally applying the snapshot and returns the current provider DTO without persisting a stale result.
- [ ] Keep models.dev capability enrichment in the Rust apply-snapshot path, keyed only by frontend-parsed model keys. Do not add a second frontend remote catalog fetch or a second cache.
- [ ] Implement connection test as one complete model-list workflow without persistence; preserve bounded error codes and the captured `providerUpdatedAt` UI race guard.
- [ ] Move component calls from `storage/client.ts` remote workflow wrappers to feature runners; keep Query invalidation after successful persistence.
- [ ] Leave legacy Rust commands registered until frontend callers and tests are green, then mark them for Task 10 removal.

**Validation:**

- Run: `bun test src/features/models/providerConnection.test.ts src/features/models/providerModelSync.test.ts`
- Expected: all-page success, auth/server/network errors, malformed page, repeated cursor, dedupe, cap, and connection race pass.
- Run: `mise run test apply_provider_model_sync`
- Expected: complete-snapshot transaction, stale version rejection, failure status, and no-partial-merge tests pass.
- Manual: `mise run tauri:dev`
- Expected: each built-in can test connection and sync models; changing provider configuration during a slow sync does not apply stale rows.

### Task 7: Cut Over Non-Streaming Translation and History

**Outcome:** Frontend owns prompt preparation and ordered fallback for non-stream translation; Rust records final history but does not build or parse Provider chat requests.

**Files:**

- Create: `src/features/translate/promptTemplate.ts`
- Create: `src/features/translate/promptTemplate.test.ts`
- Create: `src/features/translate/translationContext.ts`
- Create: `src/features/translate/translationWorkflow.ts`
- Create: `src/features/translate/translationWorkflow.test.ts`
- Modify: `src-tauri/src/domain/translation_history.rs`
- Modify: `src-tauri/src/services/translation_history.rs`
- Modify: `src-tauri/src/cmds/translation_history.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/storage/types.ts`
- Modify: `src/storage/client.ts`
- Modify: `src/features/translate/runTranslate.ts`
- Modify: `src/query/options.ts`

**Steps:**

- [ ] Resolve the primary model, ordered profile target chain, provider rows, model API Type override, plugin availability, and model/profile output limits from Query-backed DTOs.
- [ ] Port strict prompt template selection and `{{sourceLang}}`, `{{targetLang}}`, and `{{text}}` rendering from Rust. Invalid/missing template selection returns the same validation soft failure.
- [ ] Port default translation prompt, temperature policy, and max-token precedence: profile, then model, then named default.
- [ ] Execute one raw non-stream request per attempt; plugin builds the wire request and parses final content.
- [ ] Normalize HTTP/IPC/provider parsing failures to the existing bounded result codes and retry eligibility.
- [ ] Preserve fallback ordering and skip disabled/missing provider/model/plugin entries.
- [ ] Add `record_translation_history_completion` IPC with a frontend-generated UUID `completionId` and a validated DTO containing only final business data and display snapshots; do not accept credential, raw request, raw response, or rendered system prompt fields.
- [ ] Use `completionId` as the history row primary key and insert with conflict-ignore semantics; replaying the same completion is a no-op success rather than a duplicate row.
- [ ] Record only after at least one provider attempt; do not record early validation failures or cancellations. Record exactly once for final success/failure, and preserve best-effort history write behavior.
- [ ] Keep the existing public runner shape where practical so route JSX remains thin.

**Validation:**

- Run: `bun test src/features/translate/promptTemplate.test.ts src/features/translate/translationWorkflow.test.ts`
- Expected: prompt rendering, max-token precedence, fallback, retry eligibility, missing plugin, cancellation, and history-once behavior pass.
- Run: `mise run test translation_history_completion`
- Expected: input bounds, snapshot fields, idempotent `completionId`, retention, best-effort failure behavior, and secret-field absence pass.

### Task 8: Cut Over Language Detection

**Outcome:** Language detection is a frontend Effect workflow using plugin-owned request policy and shared raw transport.

**Files:**

- Modify: `src/features/translate/detectLanguageFlow.ts`
- Modify: `src/features/translate/runTranslate.ts`
- Modify: `src/features/translate/detectLanguageFlow.test.ts`
- Modify: `src/storage/types.ts`
- Modify: `src/routes/translate/index.tsx`
- Modify: `src/routes/quick-translate.tsx`

**Steps:**

- [ ] Port detector model resolution from explicit model, profile detector config, and profile primary target.
- [ ] Port the supported-language system prompt and input truncation limits as named frontend constants.
- [ ] Ask the selected plugin for detect policy. DeepSeek disables thinking and uses its raised budget; other plugins use the shared default.
- [ ] Execute through `providerFetch`, parse content through the plugin, normalize/trim/lowercase it, and accept only one member of the existing supported-language set.
- [ ] Preserve optional request ID cancellation through `cancel_provider_http`.
- [ ] Preserve soft validation/provider failures as resolved `DetectLanguageResult`; only IPC contract failures reject as `IpcError`.
- [ ] Keep routes as Promise-runner consumers rather than embedding Effect pipelines or plugin logic in JSX.

**Validation:**

- Run: `bun test src/features/translate/detectLanguageFlow.test.ts`
- Expected: empty text, oversized truncation, model resolution, DeepSeek thinking policy, malformed language output, provider failure, and cancellation pass.
- Manual: `mise run tauri:dev`
- Expected: main and Quick Translate auto-detection behave identically to the legacy backend path.

### Task 9: Cut Over Streaming Translation

**Outcome:** Frontend owns streaming Provider parsing and fallback while native Rust only sends raw chunks and enforces transport limits.

**Files:**

- Modify: `src/features/translate/translationWorkflow.ts`
- Modify: `src/features/translate/translateStream.ts`
- Modify: `src/features/translate/slotBatch.ts`
- Modify: `src/features/translate/runTranslate.ts`
- Modify: `src/features/translate/useTranslateStreamSession.ts`
- Modify: `src/features/translate/useSlotStreamSessions.ts`
- Modify: `src/features/translate/translateStream.test.ts`
- Modify: `src/features/translate/slotBatch.test.ts`
- Modify: `src/features/translate/quickTranslateSession.test.ts`
- Modify: `src/routes/translate/index.tsx`
- Modify: `src/routes/quick-translate.tsx`
- Delete: `src/features/translate/attachTranslateStreamListeners.ts`

**Steps:**

- [ ] Feed raw Channel chunks into the shared SSE decoder and pass each parsed SSE event to the selected plugin’s `parseStreamEvent`.
- [ ] Emit text deltas through workflow callbacks owned by the existing session hooks; stop using global `translate://*` Tauri events.
- [ ] Preserve listener-before-start semantics by assigning active request IDs and callbacks before invoking `providerFetchStream`.
- [ ] Preserve stale request/epoch guards in single and multi-slot hooks.
- [ ] On retryable attempt failure after partial output, invoke one reset callback with the next model ID before emitting replacement deltas.
- [ ] Keep one request ID per provider attempt or define a parent/attempt ID mapping so cancellation aborts the currently active attempt and prevents later fallback starts.
- [ ] Treat HTTP non-success, malformed SSE, plugin parse failures, idle timeout, byte cap, and empty final content according to the same fallback eligibility table as non-stream translation.
- [ ] Record history exactly once after terminal success/failure; never record cancellation or an abandoned partial attempt.
- [ ] Preserve per-slot start/failure isolation and unbounded slot concurrency only where the current workflow already permits it.

**Validation:**

- Run: `bun test src/features/translate/translationWorkflow.test.ts src/features/translate/translateStream.test.ts src/features/translate/slotBatch.test.ts src/features/translate/quickTranslateSession.test.ts`
- Expected: incremental deltas, split SSE frames, reset-before-fallback, empty stream, partial failure, cancellation, stale events, slot isolation, and history-once pass.
- Manual: `mise run tauri:dev`
- Expected: main translate, Quick Translate multi-slot, cancel, fallback, pin/resize, and clipboard-triggered sessions work with progressive output.

### Task 10: Remove Rust Provider Strategies and Finalize Plugin Readiness

**Outcome:** No built-in Provider wire format, response parser, detection policy, or translation orchestration remains in Rust; adding a normal Provider requires only a TypeScript plugin registration.

**Files:**

- Delete: `src-tauri/src/adapters/`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/cmds/models.rs`
- Modify: `src-tauri/src/services/models.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/tests.rs`
- Modify: `src/storage/client.ts`
- Modify: `src/features/models/adapterOptions.ts` or delete after all imports move
- Modify: `docs/architecture/adapter-strategy.md`
- Modify: `docs/architecture/frontend-state-management.md`
- Test: all Rust and frontend suites

**Steps:**

- [ ] Confirm production call sites no longer reference `translate_text`, `translate_text_stream`, `detect_language`, `test_provider_connection`, `sync_provider_models`, `cancel_translate`, or Rust `adapters::*`.
- [ ] Remove legacy command registration and old global translate event constants/payloads after frontend cutover.
- [ ] Delete `ProviderAdapter`, registry/catalog, built-in adapters, Provider-specific transport parsing, and tests already ported to TypeScript.
- [ ] Shrink `ModelService` to model CRUD, model sync persistence, and any retained secret-free models.dev enrichment. Split files only where this materially improves ownership.
- [ ] Remove `ModelTransport` and old adapter-specific test doubles; retain injectable raw HTTP transport tests under `ProviderHttpService`.
- [ ] Verify Rust contains no branches on `openai`, `anthropic`, `gemini`, `deepseek`, adapter ID, Provider response shape, or detect/translate policy outside one-time database migration fixtures.
- [ ] Document how an in-repo plugin registers, resolves auth from credential kind, declares capabilities, builds unsigned requests, parses raw responses, and receives `plugin_unavailable` when absent.
- [ ] Update frontend state-management documentation to remove `translate://chunk|reset|done|error` and `attachTranslateStreamListeners`; document per-call Channel ownership and frontend workflow callbacks.
- [ ] Document that auth scheme expansion is a native platform change only for genuinely new mechanisms such as SigV4, mTLS, or OAuth refresh—not for ordinary Providers using existing schemes.
- [ ] Explicitly document stock `@tauri-apps/plugin-http` as optional for public/no-secret traffic only; authenticated Provider traffic uses `providerFetch` so secrets never enter WebView memory.

**Validation:**

- Run: `rg -n "ProviderAdapter|detect_chat_policy|AuthApplication|translate_text_stream|translate://|test_provider_connection|sync_provider_models" src src-tauri/src --glob "!**/*.test.*"`
- Expected: no production references to removed Provider strategy/legacy workflow symbols.
- Run: `rg -n "openai|anthropic|gemini|deepseek" src-tauri/src --glob "*.rs"`
- Expected: no Provider-specific runtime logic; only explicitly accepted migration/test fixture references remain.
- Run: `mise run test`
- Expected: all Rust storage, vault, raw transport, sync persistence, import/export, and history tests pass.
- Run: `mise run test-frontend`
- Expected: all frontend plugin and workflow tests pass.
- Run: `mise run typecheck`
- Expected: no TypeScript errors.
- Run: `mise run lint`
- Expected: ESLint passes.
- Run: `mise run format:check`
- Expected: Prettier and rustfmt checks pass.
- Run: `mise run build`
- Expected: frontend production build succeeds.

---

## Final Validation

- Run: `mise run test && mise run test-frontend && mise run typecheck && mise run lint && mise run format:check && mise run build`
- Expected: every automated validation completes successfully.
- Run: `mise run tauri:dev`
- Expected:
  - OpenAI Compatible, OpenAI Responses, Anthropic, Gemini, and DeepSeek can test connection and sync models.
  - Main Translate and Quick Translate stream progressively.
  - Language detection returns only supported codes.
  - Fallback clears partial output before the next model emits.
  - Cancelling a request stops native network activity and does not create history.
  - Credentials never appear in frontend DTOs, logs, errors, raw request objects, Channel events, URLs shown to the frontend, or configuration exports.
  - A persisted unknown plugin ID remains visible with a missing-plugin state and cannot execute.

## Failure Behavior

- Missing/disabled provider or model — return the existing validation soft failure before network access.
- Missing plugin — return `plugin_unavailable`; retain persisted configuration unchanged.
- Plugin auth incompatible with provider auth — block model override/save and fail closed during execution.
- Missing/locked credential store — return `auth` or `credential_unavailable` without exposing vault details.
- Invalid relative path/header/query/auth scheme — reject with `validation_failed` before secret lookup.
- HTTP 3xx — return raw status with redirects disabled; frontend maps it as a provider failure.
- HTTP 4xx/5xx — return raw bounded response; plugin extracts safe provider error context and shared workflow maps the bounded code.
- Oversized non-stream body or stream — native transport aborts with `invalid_response`.
- Stream silence — native transport aborts with `timeout`; workflow applies existing fallback policy.
- Malformed JSON/SSE/provider payload — plugin throws `ProviderProtocolError`; the workflow maps it to `invalid_response` with no unchecked coercion.
- Sync page failure — do not merge any remote model rows; persist only bounded failure status if the provider connection version still matches.
- Provider edited during sync — return `connection_changed`; do not persist stale model rows or stale failure state.
- Cancellation — stop the active request, prevent additional fallback attempts, emit no terminal success callback, and write no history.
- History write failure — log a sanitized native error; translation result remains successful/failed as originally produced.

## Privacy and Security

- Secrets and credential references remain native-only. No command returns them.
- Provider requests use persisted Base URL and auth scheme; frontend plugins cannot select an arbitrary secret destination per request.
- Only relative paths are accepted, redirects are disabled, and sensitive caller headers/query keys are rejected.
- Query-string auth is appended only in Rust and the final secret-bearing URL is never logged or returned.
- Channel events carry raw response bytes only; request headers and secret-bearing URLs are excluded.
- Provider raw bodies may contain user text and model output. Do not log them by default; retain the current explicit redaction/debug policy if diagnostic logging is needed.
- Dynamic third-party plugin trust, code signing, and sandboxing require a separate plan before loading untrusted external JavaScript.

## Rollout Notes

- Execute as side-by-side tracer bullets: add native transport first, migrate one complete frontend workflow at a time, and remove legacy Rust paths only in Task 10.
- Do not maintain dual production paths after Task 10; keep rollback at the branch/release level rather than runtime feature flags or mock modes.
- Configuration export format must be bumped before Provider storage semantics change. Import must accept the previous format for built-in Providers.
- Create a dedicated `refactor/provider-plugins-frontend` branch and worktree before implementation because this is a multi-file, non-trivial migration.
- Do not stage or commit unrelated current adapter changes; reconcile them deliberately when porting test behavior.

## Risks and Mitigations

- Channel streaming may batch unexpectedly on a target platform — validate incremental delivery in Task 3 before migrating workflows; keep the existing Rust stream path until proven.
- Moving orchestration may bypass TanStack Query — resolve Provider/model/profile DTOs through shared Query options or pass Query-backed snapshots into runners; do not create a second persistent cache.
- Plugin can attempt secret exfiltration — bind requests to persisted Base URL, reject absolute URLs/redirects/sensitive headers, and persist auth scheme natively.
- Model API Type overrides can imply different auth — require auth compatibility or a separate provider instance.
- Duplicate business logic during migration can drift — port fixtures first, cut over one workflow, then delete its old Rust tests/path promptly.
- Raw Channel bytes increase IPC volume — keep chunk sizes bounded and avoid one event per byte/SSE line; forward network chunks.
- Frontend history completion could create duplicate records — include a frontend-generated completion ID and enforce idempotency in the history command if retries are possible.
- Existing Rust files are already modified — begin from a dedicated worktree/branch and review those diffs before deleting or porting behavior.

## Open Questions

- External plugin installation, signature verification, permissions, and sandboxing remain a separate future plan.
- The plan adopts the recommended model-override rule above. If automatic cross-plugin default-host switching must remain a product requirement, stop before Task 1 and design persisted per-model Base URL/auth metadata instead.
