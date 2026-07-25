# Phase 8: Runtime LLM Provider Plugins Implementation Plan

**Goal:** Make LLM model-list/chat providers installable runtime plugins while preserving host-owned Translation workflows, provider/model/profile identity, fallback, cancellation, and history semantics.

**Inputs:** Phases 4–6 and `docs/plans/2026-07-22-provider-plugin-frontend-migration-plan.md`.

**Assumptions:**

- Existing TypeScript `ProviderPlugin` implementations remain explicit legacy executors for one stable release.
- OpenAI Compatible migrates first as package ID `com.langnext.provider.openai-compatible` with legacy alias `openai-compatible`; other built-ins migrate separately.
- Provider/model/profile UUIDs and persistence remain authoritative in existing tables.
- Runtime failure never automatically replays through a legacy executor.

**Architecture:** One catalog describes provider/integration packages and capabilities, but execution remains adapter-based. Runtime LLM Components own provider wire formats and SSE parsing. Host workflows own prompts, model fallback, detection policy, history, user cancellation, and Query state.

**Tech Stack:** Wasm `llm.models.list@1`/`llm.chat@1`, StreamHandle, existing Provider HTTP/Broker policy, React/Effect workflows, TanStack Query.

---

## Dependencies

- Phases 4, 5, 6, and 7 complete. Phase 7 must register migration 0018 before this phase appends migration 0019; released migrations are never inserted or renumbered.

## File Map

- Create: `src-tauri/migrations/0019_runtime_provider_bindings.sql` — provider runtime/package/grant pins.
- Create: `src-tauri/src/domain/runtime_provider.rs` — sanitized runtime provider identity DTOs.
- Create: `src-tauri/src/services/runtime_providers.rs` — provider runtime persistence/validation.
- Create: `src-tauri/src/cmds/runtime_providers.rs` — provider runtime preview/switch/rollback IPC.
- Create: `src/features/providers/executor.ts`, `src/features/providers/executor.test.ts` — shared executor interface/contract tests.
- Create: `src/features/providers/runtimeExecutor.ts`, `src/features/providers/runtimeExecutor.test.ts` — runtime IPC/StreamHandle adapter/tests.
- Create: `runtime-plugins/openai-compatible/Cargo.toml`, `runtime-plugins/openai-compatible/src/lib.rs`, `runtime-plugins/openai-compatible/plugin.json`, `runtime-plugins/openai-compatible/schemas/`, `runtime-plugins/openai-compatible/tests/fixtures/` — first LLM Component package.
- Create: `.mise/tasks/plugin/build-openai-compatible` — deterministic Component build and unsigned staging tree at `runtime-plugins/dist/staging/com.langnext.provider.openai-compatible-1.0.0/`.
- Create: `runtime-plugins/openai-responses/`, `.mise/tasks/plugin/build-openai-responses`, `runtime-plugins/anthropic/`, `.mise/tasks/plugin/build-anthropic`, `runtime-plugins/gemini/`, `.mise/tasks/plugin/build-gemini`, `runtime-plugins/deepseek/`, `.mise/tasks/plugin/build-deepseek` — remaining provider package sources and deterministic unsigned staging builds.
- Modify: `src/features/providers/types.ts`, `src/features/providers/registry.ts`, `src/features/providers/providerFetch.ts` — legacy adapter behind executor.
- Modify: `src/features/models/providerConnection.ts`, `src/features/models/providerModelSync.ts`, `src/features/models/ProviderEditor.tsx` — executor-driven model workflows/UI.
- Modify: `src/features/translate/translationWorkflow.ts`, `src/features/translate/detectLanguageFlow.ts`, `src/features/ocr/recognizeOcrFlow.ts` — executor use.
- Modify: `src-tauri/src/domain/provider.rs`, `src-tauri/src/repositories/provider_instances.rs`, `src-tauri/src/services/providers.rs`, `src-tauri/src/domain/import_export.rs` — runtime identity persistence/export.
- Modify: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/cmds/mod.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json` — migration/service/command composition and AppManifest/ACL coverage.
- Modify: `src/storage/types.ts`, `src/storage/client.ts`, `src/query/keys.ts`, `src/query/options.ts`, `src/query/events.ts`, `src/query/dataChangeEventBindings.ts` — DTOs and cache invalidation.
- Test: existing provider/model/translation/OCR tests plus runtime provider migration/identity tests.

## Tasks

### Task 1: Unify catalog metadata without merging persistence

**Outcome:** Frontend can list legacy and runtime provider capabilities through one catalog shape.

**Files:**

- Create: `src-tauri/migrations/0019_runtime_provider_bindings.sql`, `src-tauri/src/domain/runtime_provider.rs`, `src-tauri/src/services/runtime_providers.rs`, `src-tauri/src/cmds/runtime_providers.rs`
- Modify: `src/features/providers/registry.ts`, `src/storage/types.ts`, `src/query/keys.ts`, `src/query/options.ts`, `src/query/events.ts`, `src-tauri/src/domain/provider.rs`, `src-tauri/src/repositories/provider_instances.rs`, `src-tauri/src/services/providers.rs`, `src-tauri/src/cmds/mod.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json`
- Test: Rust runtime provider binding/command security tests and `src/features/providers/registry.test.ts`

**Steps:**

- [ ] Extend catalog entries with package/runtime identity, `llm.models.list@1`, `llm.chat@1`, image-input/stream support, schemas, health, and missing state.
- [ ] Keep `provider_instances` and `integration_instances` separate; do not re-platform working persistence.
- [ ] Add provider runtime kind/pins through migration 0019 and backfill existing rows as `legacy_frontend_provider`.
- [ ] Reuse the Phase 4 execution grant-set tables with `provider_instance_id` as the sole subject and LLM capability entries inside one atomic provider/package revision; package approval or another provider/integration instance grant set must never authorize model/chat execution.
- [ ] Preserve unknown/missing provider plugin IDs and runtime package references visibly.
- [ ] Reject duplicate legacy aliases claimed by multiple installed packages.
- [ ] Register runtime-provider preview/switch/rollback/model/chat commands in the `invoke_handler`, `AppManifest`, `app-commands` permission set, and trusted-app capability coverage together; extend the Phase 0 coverage test.

**Validation:**

- Run: `mise run test runtime_provider_binding -- --nocapture`
- Run: `mise run test runtime_plugin_security -- --nocapture`
- Run: `bun test src/features/providers/registry.test.ts`
- Expected: legacy/runtime catalog entries coexist, UUIDs/existing rows are unchanged, and cross-provider/cross-integration grant-set reuse is denied.

### Task 2: Introduce a provider executor boundary

**Outcome:** Product workflows no longer depend directly on the TypeScript `ProviderPlugin` registry.

**Files:**

- Create: `src/features/providers/executor.ts`, `src/features/providers/executor.test.ts`, `src/features/providers/runtimeExecutor.ts`, `src/features/providers/runtimeExecutor.test.ts`
- Modify: `src/features/providers/registry.ts`, `src/features/providers/providerFetch.ts`, `src/features/models/providerConnection.ts`, `src/features/models/providerModelSync.ts`, `src/features/models/ProviderEditor.tsx`, `src/features/translate/translationWorkflow.ts`, `src/features/translate/detectLanguageFlow.ts`, `src/features/ocr/recognizeOcrFlow.ts`
- Test: `src/features/providers/executor.test.ts`, `src/features/providers/runtimeExecutor.test.ts`, `src/features/providers/providerFetch.test.ts`

**Steps:**

- [ ] Define typed methods for model listing, non-stream chat, streaming chat, cancel, and capability checks.
- [ ] Wrap existing TypeScript plugins as `LegacyFrontendProviderExecutor` without changing wire behavior.
- [ ] Implement `RuntimeProviderExecutor` using Tauri commands and StreamHandle events.
- [ ] Keep provider credentials/auth in host transport/broker; runtime guests receive no secrets.
- [ ] Require explicit executor selection from persisted runtime identity.
- [ ] Do not fallback between executors after request start.

**Validation:**

- Run: `bun test src/features/providers/executor.test.ts src/features/providers/providerFetch.test.ts src/features/providers/sse.test.ts`
- Expected: both adapters satisfy one contract; abort/cancel and no-replay tests pass.

### Task 3: Define LLM stream resource behavior

**Outcome:** Runtime providers can consume provider network streams and emit ordered model deltas with bounded backpressure.

**Files:**

- Modify: `src-tauri/src/services/stream_resources.rs`, `src-tauri/src/services/wasm_runtime/host.rs`, `src-tauri/src/services/wasm_runtime/bindings.rs`; implement the Phase 0 LLM/Stream WIT v1 without changing its ABI
- Test: `src-tauri/src/services/stream_resources.rs`, `src-tauri/src/services/wasm_runtime/tests.rs`, `runtime-plugins/conformance/fixtures/llm-stream/`

**Steps:**

- [ ] Give the guest a read-only provider response StreamHandle authorized by the broker.
- [ ] Give the guest a bounded output delta sink or typed output StreamHandle.
- [ ] Preserve ordered deltas, terminal errors, one-time consumption, idle timeout, total byte cap, cancellation, and consumer disconnect.
- [ ] Make malformed SSE/provider output a guest protocol error, not ignored data.
- [ ] Ensure failed partial output is reset only by existing host fallback policy, never by runtime adapter replay.

**Validation:**

- Run: `mise run plugin:conformance llm-stream`
- Run: `bun test src/features/translate/translationWorkflow.test.ts`
- Expected: split frames, UTF-8 boundaries, backpressure, partial failure, reset, cancel, and history-once pass.

### Task 4: Build OpenAI Compatible runtime package

**Outcome:** One installable package supports model listing, non-stream chat, stream chat, and image input.

**Files:**

- Create: `runtime-plugins/openai-compatible/Cargo.toml`, `runtime-plugins/openai-compatible/src/lib.rs`, `runtime-plugins/openai-compatible/plugin.json`, `runtime-plugins/openai-compatible/schemas/config.json`, `runtime-plugins/openai-compatible/schemas/chat-preferences.json`, `runtime-plugins/openai-compatible/tests/fixtures/`
- Port: fixtures from `src/features/providers/builtin/openaiCompatible.ts` and `src/features/providers/builtin/openaiCompatible.test.ts` into `runtime-plugins/openai-compatible/tests/fixtures/`

**Steps:**

- [ ] Implement package ID `com.langnext.provider.openai-compatible`, legacy alias `openai-compatible`, and `llm.models.list@1`/`llm.chat@1` with current paths/payloads/parsers.
- [ ] Declare auth policies for none/bearer and approved configurable HTTPS Base URL.
- [ ] Port pagination, model normalization, chat content, image input, SSE delta, error, and bounds fixtures.
- [ ] Package config/provider schemas without exposing credential values.
- [ ] Generate the complete signed file index in the unsigned staging tree; release CI signs exact `plugin.json` bytes, then `plugin:finalize-package` emits `runtime-plugins/dist/com.langnext.provider.openai-compatible-1.0.0.lnplugin` and its post-signing `.sha256`.
- [ ] Seed the final vendor-signed package and set default only for newly created matching providers.

**Validation:**

- Run: `mise run plugin:build-openai-compatible`
- Run in release CI after signature injection: `mise run plugin:finalize-package runtime-plugins/dist/staging/com.langnext.provider.openai-compatible-1.0.0 runtime-plugins/dist/com.langnext.provider.openai-compatible-1.0.0.lnplugin`
- Run: `mise run plugin:verify runtime-plugins/dist/com.langnext.provider.openai-compatible-1.0.0.lnplugin`
- Run: `mise run plugin:conformance openai-compatible`
- Expected: deterministic package, current protocol fixtures, legacy alias, and permission tests pass in guest/host runtime.

### Task 5: Cut over connection test and model sync

**Outcome:** Runtime provider instances can test and sync models while preserving transactional snapshot semantics.

**Files:**

- Modify: `src/features/models/providerConnection.ts`, `src/features/models/providerModelSync.ts`, `src/features/models/ProviderEditor.tsx`, `src-tauri/src/services/models.rs`, `src-tauri/src/cmds/models.rs`
- Test: `src/features/models/providerConnection.test.ts`, `src/features/models/providerModelSync.test.ts`, and Rust model sync tests

**Steps:**

- [ ] Resolve executor from authoritative provider runtime identity.
- [ ] Keep pagination/dedupe/caps in the executor contract and transactional snapshot persistence in Rust.
- [ ] Preserve expected provider revision and `connection_changed` behavior.
- [ ] Keep models.dev enrichment and model UUID behavior unchanged.
- [ ] Surface missing/revoked runtime package without deleting models.

**Validation:**

- Run: `bun test src/features/models/providerConnection.test.ts src/features/models/providerModelSync.test.ts`
- Run: `mise run test apply_provider_model_sync -- --nocapture`
- Expected: runtime and legacy sync preserve all-pages-before-merge and race behavior.

### Task 6: Cut over Translation, Detect, and AI OCR workflows

**Outcome:** Runtime providers participate in existing product workflows without moving product policy into plugins.

**Files:**

- Modify: `src/features/translate/translationWorkflow.ts`, `src/features/translate/detectLanguageFlow.ts`, `src/features/ocr/recognizeOcrFlow.ts`
- Test: `src/features/translate/translationWorkflow.test.ts`, `src/features/translate/detectLanguageFlow.test.ts`, `src/features/ocr/recognizeOcrFlow.test.ts`

**Steps:**

- [ ] Keep prompts, template rendering, source/target policy, max-token precedence, model fallback, and history in host workflows.
- [ ] Use runtime executor for selected provider/model.
- [ ] Preserve stale request guards, stream resets, slot isolation, cancellation, and exactly-once history.
- [ ] Prevent automatic legacy replay after any runtime provider request starts.
- [ ] Preserve image Blob ownership for AI OCR.

**Validation:**

- Run: `bun test src/features/translate src/features/ocr`
- Expected: non-stream/stream/detect/OCR/fallback/cancel/history fixtures pass for runtime executor.

### Task 7: Migrate remaining built-in providers sequentially

**Outcome:** OpenAI Responses, Anthropic, Gemini, and DeepSeek each obtain a tested runtime package and explicit migration path.

**Files:**

- Create: `runtime-plugins/openai-responses/`, `.mise/tasks/plugin/build-openai-responses`, `runtime-plugins/anthropic/`, `.mise/tasks/plugin/build-anthropic`, `runtime-plugins/gemini/`, `.mise/tasks/plugin/build-gemini`, `runtime-plugins/deepseek/`, `.mise/tasks/plugin/build-deepseek`
- Port: `src/features/providers/builtin/openaiResponses.ts`, `src/features/providers/builtin/openaiResponses.test.ts`, `src/features/providers/builtin/anthropic.ts`, `src/features/providers/builtin/anthropic.test.ts`, `src/features/providers/builtin/gemini.ts`, `src/features/providers/builtin/gemini.test.ts`, `src/features/providers/builtin/deepseek.ts`, `src/features/providers/builtin/deepseek.test.ts`

**Steps:**

- [ ] Use package IDs `com.langnext.provider.openai-responses`, `com.langnext.provider.anthropic`, `com.langnext.provider.gemini`, and `com.langnext.provider.deepseek`, initial version `1.0.0`, and final release paths `runtime-plugins/dist/<package-id>-1.0.0.lnplugin`.
- [ ] Migrate one provider per reviewable slice using its existing TypeScript fixtures.
- [ ] Preserve provider-specific auth policy, pagination, streaming, thinking, and detection rules.
- [ ] Keep explicit legacy rollback for one stable release after each package ships.
- [ ] For each provider, use the same unsigned staging → external signature → `plugin:finalize-package` → final `.sha256` pipeline; never sign inside the app/developer build.
- [ ] Do not remove TypeScript implementation until Phase 12.

**Validation:**

- Run: `mise run plugin:conformance llm`
- Run: `bun test src/features/providers/builtin src/features/translate src/features/ocr`
- Expected: all provider fixtures pass across explicit runtime/legacy adapters.

## Final Validation

```bash
mise run plugin:build-openai-compatible
# Release CI only, after external signature injection:
mise run plugin:finalize-package runtime-plugins/dist/staging/com.langnext.provider.openai-compatible-1.0.0 runtime-plugins/dist/com.langnext.provider.openai-compatible-1.0.0.lnplugin
mise run plugin:verify runtime-plugins/dist/com.langnext.provider.openai-compatible-1.0.0.lnplugin
mise run plugin:conformance llm
mise run test runtime_provider -- --nocapture
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run build
```

Expected: runtime LLM providers support model sync, chat, streaming, Translate/Detect, and AI OCR with stable identities and no implicit replay.

## Failure Behavior

- Missing/revoked package — provider/models remain visible; execution returns `plugin_unavailable`.
- Stream guest failure — workflow applies existing fallback rules only to configured next model, not legacy executor.
- Sync page failure — no partial model merge.
- Executor switch conflict — CAS failure preserves current backend.

## Privacy and Security

- Provider credentials/tokens remain host-only.
- Stream contents/user prompts/model output are not logged by runtime infrastructure.
- Configurable Base URL requires approved effective origin/auth policy.

## Rollout Notes

- OpenAI Compatible is the only first tracer.
- Each remaining provider gets one stable dual-stack release before legacy removal.

## Risks and Mitigations

- Moving SSE parsing changes subtle behavior — port fixtures first and keep host stream semantics unchanged.
- Catalog unification becomes table rewrite — unify metadata only; keep current domain tables.
- Duplicate requests on failure — forbid automatic executor fallback after start.

## Open Questions

None blocking Phase 8.
