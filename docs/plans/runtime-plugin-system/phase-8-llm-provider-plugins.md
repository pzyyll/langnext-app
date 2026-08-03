# Phase 8: Runtime LLM Provider Plugins Implementation Plan

**Goal:** Make LLM model-list and chat providers installable runtime plugins while preserving host-owned provider identity, transport/authentication, Translation/Detect/OCR workflow policy, fallback, cancellation, and history semantics.

**Inputs:**

- `docs/plans/runtime-plugin-system/README.md`
- Phases 0, 4, 6, and 7 in `docs/plans/runtime-plugin-system/`
- `docs/plans/2026-07-22-provider-plugin-frontend-migration-plan.md`
- Current provider boundaries in `src/features/providers/`, `src/features/models/`, `src/features/translate/`, and `src/features/ocr/`
- Frozen LLM ABI in `src-tauri/wit/runtime-plugin/llm.wit`

**Assumptions:**

- Phase 7 is complete. Migration `0023_integration_capability_health.sql` is released, so this phase starts with migration `0024`; released migrations are never inserted or renumbered.
- `llm.models.list@1` and `llm.chat@1` remain ABI-compatible with Phase 0. Models List returns one bounded aggregate list, so a guest that needs cursor pagination must complete its bounded page traversal internally rather than changing WIT.
- The host serializes one validated `LlmChatPreferencesV1` envelope into `chat-request.preferences`. It includes the host-selected `stream`, temperature, max-token, and thinking values, so a guest deterministically returns `complete` for `stream = false` or writes to the supplied stream writer for `stream = true`; no WIT major is required.
- Every LLM provider package contains two separately compiled Components, one for `llm-models-world` and one for `llm-chat-world`. Its signed manifest maps each declared capability to its own indexed artifact path.
- Runtime packages receive neither a provider credential, credential reference, nor effective Base URL. The host resolves the persisted provider connection and injects authentication only after package, provider-instance, capability, and grant authorization succeed.
- Existing TypeScript `ProviderPlugin` implementations remain explicit `legacy-frontend-provider` executors for one stable dual-stack release. A runtime failure never retries the same request through that legacy executor.
- A runtime package pin is provider-level. Before activation, every existing model API Type override must be absent or match the provider package's declared legacy alias; a mismatched override, including a currently valid custom-relay override, fails closed as `provider_reconfiguration_required` until the user keeps the Provider legacy, clears the override, or creates a separately configured Provider. Saving a new mismatched override while a runtime binding is active is rejected by the same rule.
- OpenAI Compatible migrates first as `com.langnext.provider.openai-compatible`, with legacy alias `openai-compatible`. OpenAI Responses, Anthropic, Gemini, and DeepSeek follow as independent reviewable slices.
- Existing product UI renders only `llm-delta.text` as translation/OCR output. Reasoning and tool-call deltas remain typed inside the host stream bridge, are not parsed as text, and are not persisted in history or default logs.

**Architecture:** Each provider instance receives a separate, authoritative runtime binding that is either `legacy-frontend-provider` or an exact signed two-Component Wasm package plus an instance-scoped grant revision. A provider runtime router verifies the package, binding, and provider-scoped authority, serializes host-owned `LlmChatPreferencesV1`, and invokes the frozen LLM worlds through a broker that resolves only that provider instance's saved Base URL, proxy mode, and host-only credential. Frontend workflows select a semantic executor from the persisted runtime binding; prompts, detection policy, model fallback, stream resets, cancellation, Query state, and history remain host-owned.

**Tech Stack:** Rust, SQLite/rusqlite, Tauri 2 IPC and `Channel`, Wasmtime Component Model, frozen WIT v1, existing Blob/Stream resources, React 19, Effect, TanStack Query, Bun, mise, cargo-component `0.21.1`.

---

## Dependencies

- Phases 4–7 must pass final validation before implementation begins.
- `src-tauri/wit/runtime-plugin/llm.wit` and `src-tauri/wit/runtime-plugin/common.wit` are frozen v1 contracts. This phase implements their generated `llm_models` and `llm_chat` bindings; it does not alter their ABI.
- Existing `execution_grant_sets` already support `subject_kind = provider_instance`. This phase must use that subject kind rather than reusing an integration-instance grant.
- `mise run plugin:conformance llm` does not exist yet. Task 2 adds its fixture/package foundation; do not use it before that task's green step.

## TDD Execution Rules

- Confirm the proposed seams below before writing the first implementation test.
- Execute tasks in order. Each task is one vertical red → green slice at its named public seam.
- Add the named test first, run its exact red command, and capture the expected failure before adding production behavior. A compile failure caused only by the intentionally absent public API is an acceptable first red result.
- Implement only the behavior required by the current failing test. Do not pre-implement later providers, UI paths, or fallback behavior.
- Test through public repositories, services, Tauri commands, executor interfaces, workflows, or mise tasks. Do not test private helpers or mock internal modules.
- Use the real SQLite migration runner, package verifier, grant repository, Wasm runtime, Blob/Stream tables, and workflow code. Fakes are allowed only at the external HTTPS/provider boundary and must use committed fixed request/response fixtures.
- Use fixed fixture values as the expected source of truth; never calculate expected wire payloads with the code under test.
- Keep every new Rust, TypeScript, shell, SQL, and guest source file compliant with the repository's two-line `ABOUTME:` rule.
- Defer refactoring to post-green review. It is not part of a red → green slice.

## File Map

### Provider runtime identity and lifecycle

- Create: `src-tauri/migrations/0024_runtime_provider_bindings.sql` — one provider-instance runtime binding, provider runtime snapshots, and constraints.
- Create: `src-tauri/src/domain/runtime_provider.rs` — provider runtime identity, catalog, lifecycle, chat, and sanitized IPC DTOs.
- Create: `src-tauri/src/repositories/provider_runtime_bindings.rs` — provider binding and snapshot persistence.
- Create: `src-tauri/src/services/runtime_providers.rs` — provider catalog, preview/apply/rollback, default binding, and runtime availability.
- Create: `src-tauri/src/services/provider_runtime_router.rs` — immutable provider binding/package/grant resolution for LLM calls.
- Create: `src-tauri/src/services/provider_runtime_broker.rs` — provider-instance-authorized Wasm broker handle.
- Create: `src-tauri/src/cmds/runtime_providers.rs` — lifecycle, Models List, Chat, stream, and cancellation commands.
- Create: `src-tauri/src/services/runtime_provider_tests.rs` — real SQLite/package/runtime integration tests for this phase.
- Modify: `src-tauri/src/domain/provider.rs`, `src-tauri/src/repositories/provider_instances.rs`, `src-tauri/src/services/providers.rs` — join and preserve sanitized runtime binding DTOs during Provider CRUD.
- Modify: `src-tauri/src/domain/runtime_plugin.rs`, `src-tauri/src/services/runtime_plugin_contracts.rs` — validate the optional signed `providerRuntime` manifest declaration without changing WIT.
- Modify: `src-tauri/src/domain/import_export.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/import_validation.rs` — preserve exact provider runtime requirements without exporting code, grants, secrets, or credential references.
- Modify: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/cmds/mod.rs` — register provider runtime modules and migration `0024`.
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json` — construct services and keep command registration, AppManifest, permissions, and trusted capability coverage identical.

### Wasm execution and provider transport

- Modify: `src-tauri/src/services/provider_http.rs` — expose one internal binary-safe preparation/execution path shared by frontend Provider HTTP and provider-runtime broker calls; retain frontend IPC behavior.
- Modify: `src-tauri/src/services/wasm_runtime/bindings.rs`, `src-tauri/src/services/wasm_runtime/executor.rs`, `src-tauri/src/services/wasm_runtime/host.rs`, `src-tauri/src/services/wasm_runtime/store.rs` — instantiate LLM worlds, pass owned image Blobs, and bridge paired typed stream resources.
- Modify: `src-tauri/src/services/stream_resources.rs` — only where required to supervise LLM reader cleanup; retain the existing `stream-writer`/`stream-reader` v1 semantics.
- Modify: `src-tauri/src/services/wasm_runtime/tests.rs`, `.mise/tasks/plugin/build-conformance`, `.mise/tasks/plugin/conformance`, `.mise/tasks/plugin/check-no-wasi` — add two-world LLM package fixtures, fail-closed execution requirements, and import auditing.
- Create: `runtime-plugins/conformance/wasm-llm-models-component/`, `runtime-plugins/conformance/wasm-llm-chat-component/` — test-only Components for the two frozen LLM worlds.
- Create: `runtime-plugins/conformance/llm-provider/`, `runtime-plugins/conformance/fixtures/packages/llm-provider-valid.lnplugin`, `.mise/tasks/plugin/refresh-llm-conformance-fixture` — deterministic signed two-artifact fixture package.

### Frontend executor and workflows

- Create: `src/features/providers/executor.ts`, `src/features/providers/executor.test.ts` — semantic executor contract and legacy frontend adapter.
- Create: `src/features/providers/runtimeExecutor.ts`, `src/features/providers/runtimeExecutor.test.ts` — Tauri runtime adapter and typed Chat event bridge.
- Create: `src/features/providers/runtimeProviderPresentation.ts`, `src/features/providers/runtimeProviderPresentation.test.ts` — pure sanitized runtime status mapping.
- Create: `src/features/providers/runtimeProviderActions.ts`, `src/features/providers/runtimeProviderActions.test.ts` — tested preview/apply/rollback controller consumed by ProviderEditor.
- Modify: `src/features/providers/types.ts`, `src/features/providers/registry.ts`, `src/features/providers/providerFetch.ts` — retain the existing TypeScript plugin contract only behind the legacy executor and expose catalog metadata needed by host workflows.
- Modify: `src/storage/types.ts`, `src/storage/client.ts`, `src/query/keys.ts`, `src/query/options.ts`, `src/query/events.ts`, `src/query/dataChangeEventBindings.ts` — provider runtime DTOs, commands, and cache invalidation.
- Modify: `src/features/models/providerConnection.ts`, `src/features/models/providerModelSync.ts`, `src/features/models/ProviderEditor.tsx` — executor-selected connection/sync and explicit lifecycle UI.
- Create: `src/features/models/providerConnection.test.ts`, `src/features/models/providerModelSync.test.ts` — executor-selected connection and complete-snapshot sync coverage.
- Modify: `src/features/translate/translationWorkflow.ts`, `src/features/translate/detectLanguageFlow.ts`, `src/features/ocr/recognizeOcrFlow.ts` — route LLM work through the selected executor while retaining host workflow policy.
- Modify: `src/features/translate/translationWorkflow.test.ts`, `src/features/translate/detectLanguageFlow.test.ts`, `src/features/ocr/recognizeOcrFlow.test.ts` — runtime executor regression cases at public workflow seams.

### Runtime provider packages

- Create: `runtime-plugins/openai-compatible/protocol/`, `runtime-plugins/openai-compatible/models/`, `runtime-plugins/openai-compatible/chat/`, and `.mise/tasks/plugin/build-openai-compatible` — first two-Component LLM package and deterministic unsigned staging build.
- Create: `.mise/tasks/plugin/refresh-openai-compatible-fixture` — dev-only build/sign/finalize/verify of a committed fixture package; production signing remains external.
- Create: `runtime-plugins/openai-responses/{protocol,models,chat}/`, `.mise/tasks/plugin/build-openai-responses`, `.mise/tasks/plugin/refresh-openai-responses-fixture` — OpenAI Responses two-Component package and fixture path.
- Create: `runtime-plugins/anthropic/{protocol,models,chat}/`, `.mise/tasks/plugin/build-anthropic`, `.mise/tasks/plugin/refresh-anthropic-fixture` — Anthropic two-Component package and fixture path.
- Create: `runtime-plugins/gemini/{protocol,models,chat}/`, `.mise/tasks/plugin/build-gemini`, `.mise/tasks/plugin/refresh-gemini-fixture` — Gemini two-Component package and fixture path.
- Create: `runtime-plugins/deepseek/{protocol,models,chat}/`, `.mise/tasks/plugin/build-deepseek`, `.mise/tasks/plugin/refresh-deepseek-fixture` — DeepSeek two-Component package and fixture path.
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/src/state.rs` — discover externally signed vendor LLM archives and set only reviewed defaults for newly created matching provider instances.

## Seams

These seams are proposed and must be confirmed before implementation begins.

- **Provider runtime binding storage:** public functions in `provider_runtime_bindings` and `ProviderService::get`/`list` — every existing Provider keeps its UUID and receives a visible active legacy binding after migration.
- **Provider runtime package catalog:** `ProviderRuntimeCatalog::list` — a verified signed two-world manifest projects only bounded aliases, capability/artifact identity, and host-interpreted detection metadata; visibility is not execution authority.
- **Provider runtime lifecycle:** `ProviderRuntimeService::preview_upgrade`, `apply_upgrade`, `preview_rollback`, and `apply_rollback` — a provider moves atomically between explicit legacy and exact package/grant identities, or not at all.
- **Provider runtime recovery:** `ImportExportService::export`, `preview`, and `import` — exact provider package requirements survive export/import without code, grants, credentials, or secret references.
- **Host-authorized provider egress:** `ProviderRuntimeBrokerHandle::fetch`, reached through WIT `host.broker-fetch` — only the bound provider instance's approved package/grant can use its persisted destination, proxy, and host-injected authentication.
- **Runtime Models List:** `ProviderRuntimeRouter::list_models` — a verified `llm.models.list@1` Component returns one bounded, normalized complete model set.
- **Runtime unary Chat:** `ProviderRuntimeRouter::chat` — a verified `llm.chat@1` Component returns a bounded complete response and cleans owned input Blobs.
- **Runtime streaming Chat:** `ProviderRuntimeRouter::chat_stream` and `ProviderRuntimeChatEvent` — ordered typed deltas cross the paired writer/reader resources, terminate once, and cancel upstream work.
- **Provider executor contract:** `ProviderExecutor` — legacy and runtime adapters expose the same semantic models/chat/cancel operations without leaking Provider wire formats into workflows.
- **Runtime executor IPC:** `RuntimeProviderExecutor` — persisted runtime identity selects runtime Tauri commands, and runtime errors do not invoke legacy Provider HTTP.
- **Provider lifecycle actions:** `runtimeProviderActions` consumed by `ProviderEditor` — preview/apply/rollback calls, confirmation requirements, and provider/model cache invalidation are tested outside JSX.
- **Provider lifecycle presentation:** `runtimeProviderPresentation` consumed by `ProviderEditor` — users see only sanitized runtime state and explicit actions.
- **Connection and model sync:** `testProviderConnectionFrontend` and `syncProviderModelsFrontend` — executor-selected model enumeration preserves all-pages-before-merge, race, and complete-snapshot semantics.
- **Translation:** `runTranslationNonStream` and `runTranslationStream` — host prompts, fallback, reset, cancellation, and exactly-once history remain intact with a runtime executor.
- **Language detection:** `detectLanguage` — host-owned detection policy and supported-language validation execute through the selected executor.
- **AI OCR:** `recognizeOcrFlow` — runtime multimodal Chat transfers image data through the host Blob path and returns only parsed OCR text.
- **Package developer CLI:** `mise run plugin:build-<provider>`, `mise run plugin:refresh-<provider>-fixture`, and `mise run plugin:conformance llm` — deterministic package input and fail-closed host conformance execute real Components.

## Required Existing-Behavior Characterization

Do not force these tests red. Add them immediately after Task 9 creates the legacy executor and before Task 10 changes runtime selection. They must pass against the current TypeScript plugins; a failure is a separate regression slice that blocks this phase.

- **Legacy model behavior:** add `legacy_executor_preserves_openai_compatible_model_and_chat_fixtures` to `src/features/providers/executor.test.ts`. Exercise Models List, unary Chat, and streaming text parsing through `LegacyFrontendProviderExecutor` using the existing OpenAI Compatible fixture literals.
- **Legacy workflow behavior:** add `legacy_executor_preserves_translation_cancel_and_history_contract` to `src/features/translate/translationWorkflow.test.ts`. Exercise the public workflow and assert cancellation writes no history, while a terminal failure/success writes once.

## Tasks

### Task 1: Persist provider runtime bindings without rewriting provider rows

**Seam:** Provider runtime binding storage.

**Outcome:** Every current Provider has an active `legacy-frontend-provider` binding; provider/model/profile UUIDs and existing Provider transport fields remain unchanged, while sanitized runtime identity is visible on Provider DTOs.

**Files:**

- Create: `src-tauri/migrations/0024_runtime_provider_bindings.sql`, `src-tauri/src/domain/runtime_provider.rs`, `src-tauri/src/repositories/provider_runtime_bindings.rs`
- Modify: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/domain/provider.rs`, `src-tauri/src/repositories/provider_instances.rs`, `src-tauri/src/services/providers.rs`, `src/storage/types.ts`
- Test: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/repositories/tests.rs`

**Steps:**

- [ ] **Red:** Add `runtime_provider_binding_backfill_preserves_provider_rows` using a v23 fixture database with a provider, model, profile target, credential reference, sync state, and fixed UUIDs. Migrate it and assert the old rows are byte-equivalent where their schema is unchanged, the new binding is `legacy-frontend-provider`/`active`, and the DTO contains no credential reference.
- [ ] **Green:** Add migration `0024_runtime_provider_bindings.sql` with a separate one-to-one `provider_runtime_bindings` table and provider-runtime rollback snapshots. Store runtime kind, exact package digest, grant revision, state, sanitized error, unresolved runtime requirement, timestamps, and checks equivalent to the Phase 4 pin invariants.
- [ ] **Green:** Backfill every existing `provider_instances.id` as active `legacy-frontend-provider` with no package or grant pin. Do not rebuild `provider_instances` or change Provider, model, profile, credential, or history IDs.
- [ ] **Green:** Add public repository read/write types and join the sanitized binding onto `ProviderInstanceDto`; keep package bytes, grants, snapshots, credential references, and secret material out of DTOs.
- [ ] **Green:** Register migration `0024` after `0023` and add a migration test proving the empty database reaches the new latest version.

**Validation:**

- Run (red): `mise run test runtime_provider_binding_backfill_preserves_provider_rows -- --nocapture`
- Expected: fails because migration `0024`, binding persistence, and DTO runtime fields do not exist.
- Run (green): `mise run test runtime_provider_binding_backfill_preserves_provider_rows -- --nocapture`
- Expected: the binding backfills as legacy and every existing Provider relation/UUID remains unchanged.

### Task 2: Establish the signed two-world LLM fixture and catalog metadata

**Seam:** Provider runtime package catalog.

**Outcome:** The host verifies a minimal dev-signed provider-runtime package with distinct Models List and Chat artifacts, projects only validated catalog metadata, and rejects an invalid alias, capability/artifact mapping, detection policy, or WASI import before lifecycle work begins.

**Files:**

- Create: `runtime-plugins/conformance/wasm-llm-models-component/Cargo.toml`, `runtime-plugins/conformance/wasm-llm-models-component/src/lib.rs`
- Create: `runtime-plugins/conformance/wasm-llm-chat-component/Cargo.toml`, `runtime-plugins/conformance/wasm-llm-chat-component/src/lib.rs`
- Create: `runtime-plugins/conformance/llm-provider/plugin.json`, `runtime-plugins/conformance/llm-provider/fixtures/`, `runtime-plugins/conformance/fixtures/packages/llm-provider-valid.lnplugin`, `runtime-plugins/conformance/fixtures/packages/llm-provider-valid.lnplugin.sha256`
- Create: `.mise/tasks/plugin/refresh-llm-conformance-fixture`
- Create: `src-tauri/src/services/runtime_providers.rs`, `src-tauri/src/services/runtime_provider_tests.rs`
- Modify: `src-tauri/src/domain/runtime_plugin.rs`, `src-tauri/src/services/runtime_plugin_contracts.rs`, `src-tauri/src/services/mod.rs`, `.mise/tasks/plugin/build-conformance`, `.mise/tasks/plugin/conformance`, `.mise/tasks/plugin/check-no-wasi`, `src-tauri/src/services/wasm_runtime/tests.rs`

**Steps:**

- [ ] **Red:** Add `provider_runtime_fixture_package_verifies_and_projects_catalog`. Build/install the fixture through the real package verifier, then assert the public catalog projects fixed aliases and bounded host-owned detection defaults. Use table cases that reject a missing Models or Chat artifact, duplicate alias, both capabilities targeting one artifact/digest, an artifact instantiating the wrong WIT world, unknown providerRuntime field, unsupported detection values, incorrect provider-instance authority, and a guest importing anything other than `langnext:runtime-plugin`.
- [ ] **Green:** Add a deny-unknown `providerRuntime` manifest declaration with bounded legacy aliases, exactly `llm.models.list@1` and `llm.chat@1`, a fixed provider-instance endpoint/auth form, and optional bounded detection defaults. Validate it in Rust and project it as sanitized catalog metadata; the guest never receives workflow-policy authority.
- [ ] **Green:** Build two minimal separate conformance Components, one for `llm-models-world` and one for `llm-chat-world`, and verify each artifact instantiates only its declared world. The signed fixture manifest requires distinct artifact paths/digests for the two capabilities, indexes both artifacts, and is refreshed through a deterministic dev-only build → sign → finalize → verify task. These initial stubs establish package topology only; Tasks 6–8 add their behavior modes, refresh the fixture, and re-verify before each green host test.
- [ ] **Green:** Extend `plugin:check-no-wasi` and the compiled guest-import tests to inspect both LLM Components by exact name. Extend `plugin:conformance all` with the fail-closed `llm` mode, but do not require execution tests that land in later tasks yet.
- [ ] **Green:** Keep runtime package metadata separate from package authority: catalog visibility never grants execution and cannot auto-bind a Provider.

**Validation:**

- Run (red): `mise run test provider_runtime_fixture_package_verifies_and_projects_catalog -- --nocapture`
- Expected: fails because providerRuntime manifest validation, two-artifact fixture layout, catalog projection, and LLM import checks do not exist.
- Run (green fixture): `mise run plugin:refresh-llm-conformance-fixture`
- Expected: the signed fixture contains exactly two indexed LLM world artifacts and verifies with the committed dev public key.
- Run (green): `mise run test provider_runtime_fixture_package_verifies_and_projects_catalog -- --nocapture`
- Expected: only a valid signed two-world package projects catalog metadata; all malformed/ambiguous/WASI cases fail closed.
- Run: `mise run plugin:check-no-wasi`
- Expected: the host tree and every conformance guest, including both LLM worlds, import no WASI interface.

### Task 3: Add atomic provider runtime lifecycle

**Seam:** Provider runtime lifecycle.

**Outcome:** A provider can preview, explicitly activate, and roll back one exact signed LLM package/grant revision; alias ambiguity, cross-provider grants, missing packages, and stale CAS inputs fail closed.

**Files:**

- Create: `src-tauri/src/cmds/runtime_providers.rs`
- Modify: `src-tauri/src/services/runtime_providers.rs`, `src-tauri/src/services/runtime_provider_tests.rs`, `src-tauri/src/services/plugin_store.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/cmds/mod.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json`, `src/storage/types.ts`, `src/storage/client.ts`

**Steps:**

- [ ] **Red:** Add `runtime_provider_lifecycle_binds_exact_package_and_provider_grant` in `runtime_provider_tests.rs` through the public runtime-provider command contracts backed by a real `AppState`, SQLite database, package verifier, and fixture archive. Create two providers plus a provider with a mismatched per-model API Type override, preview/apply only the first, then assert: the package digest and grant revision are exact; the grant subject is only the first provider; reuse by the second provider is denied; the mismatched override is rejected as `provider_reconfiguration_required`; a stale apply changes nothing; rollback restores the legacy binding; and the second provider remains legacy.
- [ ] **Green:** Implement `ProviderRuntimeService` preview/apply/rollback against the validated Task 2 catalog with provider `updated_at` CAS, signed package re-verification, publisher trust checks, an exact `GrantSubjectKind::ProviderInstance` grant bundle, an identity-only rollback snapshot, and a fail-closed scan of existing model API Type overrides. Provider Base URL, auth scheme, proxy mode, and credential storage remain in the existing Provider row and are not guest config.
- [ ] **Green:** Retain unknown/missing package references as `unavailable` rather than deleting the Provider or models. A catalog-visible package can become active only through this explicit lifecycle path.
- [ ] **Green:** Add `list_runtime_provider_catalog`, `preview_provider_runtime_upgrade`, `apply_provider_runtime_upgrade`, `preview_provider_runtime_rollback`, and `apply_provider_runtime_rollback` commands. Register all five commands in `invoke_handler`, `AppManifest`, `app-commands.toml`, trusted capability coverage, and the Phase 0 command-coverage test together.

**Validation:**

- Run (red): `mise run test runtime_provider_lifecycle_binds_exact_package_and_provider_grant -- --nocapture`
- Expected: fails because provider lifecycle APIs, provider-scoped grants, and rollback snapshots do not exist.
- Run (green): `mise run test runtime_provider_lifecycle_binds_exact_package_and_provider_grant -- --nocapture`
- Expected: only the selected provider moves to the verified package/grant; cross-provider reuse, stale apply, and alias ambiguity fail closed; rollback restores legacy identity.
- Run: `mise run test runtime_plugin_security_app_commands_fully_covered -- --nocapture`
- Expected: registered commands, AppManifest, reviewed permissions, and trusted capabilities remain identical sets.

### Task 4: Preserve exact provider runtime requirements through export/import

**Seam:** Provider runtime recovery.

**Outcome:** Active and unavailable Provider runtime requirements round-trip through the public configuration document without exporting package bytes, grant revisions, snapshots, credentials, credential references, or activation authority.

**Files:**

- Modify: `src-tauri/src/domain/provider.rs`, `src-tauri/src/domain/import_export.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/import_validation.rs`, `src-tauri/src/services/runtime_provider_tests.rs`, `src/storage/types.ts`

**Steps:**

- [ ] **Red:** Add `runtime_provider_export_import_preserves_exact_requirement_without_activation`. Activate the Task 2 fixture for one Provider, export through `ImportExportService::export`, import into a clean database through public preview/import APIs, and assert the exact package digest, publisher identity/fingerprint, plugin API version, aliases/capabilities, and runtime kind are preserved as unavailable requirements without package bytes, grants, credential references, or activation.
- [ ] **Green:** Add a non-secret provider runtime requirement to Provider export/import types. Current legacy bindings normalize to `legacy-frontend-provider`; active/imported package bindings preserve exact identity but never serialize an execution grant or executable archive.
- [ ] **Green:** During import, retain absent/unapproved package requirements as unavailable binding metadata. Do not download, instantiate, migrate, grant, default-bind, or activate code; recovery remains an explicit Task 3 lifecycle action after local trust/installation/approval.
- [ ] Keep older configuration formats sequentially normalized and retain current Provider transport import behavior.

**Validation:**

- Run (red): `mise run test runtime_provider_export_import_preserves_exact_requirement_without_activation -- --nocapture`
- Expected: fails because Provider exports have no runtime requirement and import cannot preserve an unresolved provider binding.
- Run (green): `mise run test runtime_provider_export_import_preserves_exact_requirement_without_activation -- --nocapture`
- Expected: exact runtime identity round-trips as unavailable when code is absent, with no executable authority or secret data restored.

### Task 5: Broker provider-runtime egress through the bound host connection

**Seam:** Host-authorized provider egress.

**Outcome:** A guest can request only a relative path on its bound provider instance's persisted connection; the host injects configured authentication and keeps credentials, references, and final secret-bearing URLs out of the guest and frontend.

**Files:**

- Create: `src-tauri/src/services/provider_runtime_broker.rs`
- Modify: `src-tauri/src/services/provider_http.rs`, `src-tauri/src/services/wasm_runtime/network_handle.rs`, `src-tauri/src/services/runtime_provider_tests.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/state.rs`

**Steps:**

- [ ] **Red:** Add `runtime_provider_broker_uses_only_bound_provider_connection`. Use two real provider rows, a real package/grant principal, a memory vault, and a capture `RawHttpTransport`. Assert that a permitted request uses provider A's Base URL/proxy/auth header; a provider B grant, an absolute/traversal path, a sensitive caller header, or an undeclared provider-auth policy is denied before vault lookup or transport.
- [ ] **Green:** Implement the Task 2 closed `host.provider-instance-auth.v1` policy and provider-instance endpoint form. It resolves “the current provider instance,” never a package-selected origin, and is valid only for a provider-runtime manifest plus `ProviderInstance` grant subject.
- [ ] **Green:** Extract a binary-safe internal preparation path from `ProviderHttpService` so frontend Provider HTTP and Wasm broker calls share URL confinement, persisted proxy selection, credential lookup, host auth injection, redirects-disabled policy, limits, and cancellation without exposing a frontend command that accepts a provider runtime principal.
- [ ] **Green:** Implement `ProviderRuntimeBrokerHandle` using the request principal's provider binding. It accepts only approved relative paths/headers/body modes, maps bounded provider responses to broker JSON/stream bodies, and never logs or returns credential material, a credential reference, or a secret-bearing URL.
- [ ] Keep the existing frontend `provider_http_request` and `provider_http_stream` command contracts green and unchanged.

**Validation:**

- Run (red): `mise run test runtime_provider_broker_uses_only_bound_provider_connection -- --nocapture`
- Expected: fails because a provider-runtime broker and provider-scoped auth policy do not exist.
- Run (green): `mise run test runtime_provider_broker_uses_only_bound_provider_connection -- --nocapture`
- Expected: exactly one approved provider connection reaches capture transport; every cross-provider or unsafe request is denied before transport.

### Task 6: Execute bounded Models List through a verified Component

**Seam:** Runtime Models List.

**Outcome:** A real `llm.models.list@1` Component can execute through a provider binding, package verification, provider grant, and broker, returning one bounded complete model set without changing the frozen WIT pagination shape.

**Files:**

- Create: `src-tauri/src/services/provider_runtime_router.rs`
- Modify: `runtime-plugins/conformance/wasm-llm-models-component/src/lib.rs`, `.mise/tasks/plugin/refresh-llm-conformance-fixture`, `.mise/tasks/plugin/conformance`, `src-tauri/src/services/runtime_provider_tests.rs`, `src-tauri/src/services/wasm_runtime/bindings.rs`, `src-tauri/src/services/wasm_runtime/executor.rs`, `src-tauri/src/services/mod.rs`

**Steps:**

- [ ] **Red:** Add `runtime_provider_models_list_executes_verified_component`. Install the Task 2 dev-signed fixture with an `llm-models-world` artifact, route it through a real provider binding/grant and capture broker response, and table-test fixed model IDs/labels, duplicate descriptors, and an over-limit aggregate result; the binding must remain unchanged in every case.
- [ ] **Green:** Add only the named Models List modes to the Task 2 fixture Component, refresh/sign/verify `llm-provider-valid.lnplugin`, then implement `WasmRuntime::execute_llm_models_list` and create `ProviderRuntimeRouter::list_models`. Enforce verified package/artifact identity, ProviderInstance grant subject, capability grant, copied non-secret config bounds, descriptor ID/label bounds, duplicate rejection, and a named host maximum model count.
- [ ] **Green:** Treat the ABI response as one aggregate list. Provider guests that need remote cursor pagination must enforce named page, repeated-cursor, item, and total-model limits internally before returning it; do not add a WIT continuation field.
- [ ] **Green:** Add this exact Models List execution test to the Task 2 fail-closed `llm` conformance mode. The mode must fail when the named test is absent, zero tests run, or the real Component is not executed.

**Validation:**

- Run (red): `mise run test runtime_provider_models_list_executes_verified_component -- --nocapture`
- Expected: fails because no LLM Models executor or provider runtime router exists.
- Run (green fixture): `mise run plugin:refresh-llm-conformance-fixture`
- Expected: the fixture is re-signed and verifies after adding only the Models List modes.
- Run (green): `mise run test runtime_provider_models_list_executes_verified_component -- --nocapture`
- Expected: the verified Component returns the fixed bounded model list through the real provider grant/broker path.
- Run: `mise run plugin:conformance llm`
- Expected: the LLM conformance mode verifies the required Models List execution test by name.

### Task 7: Execute complete Chat with owned image Blobs

**Seam:** Runtime unary Chat.

**Outcome:** A real `llm.chat@1` Component receives a host-selected `stream = false` preference, returns a bounded complete message, receives optional image input only as an owned host Blob, and releases both required stream endpoints on every complete/error path.

**Files:**

- Modify: `runtime-plugins/conformance/wasm-llm-chat-component/src/lib.rs`, `.mise/tasks/plugin/refresh-llm-conformance-fixture`, `.mise/tasks/plugin/conformance`, `src-tauri/src/domain/runtime_provider.rs`, `src-tauri/src/services/runtime_provider_tests.rs`, `src-tauri/src/services/wasm_runtime/bindings.rs`, `src-tauri/src/services/wasm_runtime/executor.rs`, `src-tauri/src/services/provider_runtime_router.rs`, `src-tauri/src/services/stream_resources.rs`

**Steps:**

- [ ] **Red:** Add `runtime_provider_chat_complete_uses_host_mode_and_releases_all_resources`. Invoke the Task 2 verified Chat fixture with fixed semantic messages, a valid fixed PNG, and `LlmChatPreferencesV1.stream = false`. Table-test fixed complete text, oversized complete text, guest error, malformed response, and unexpected streaming result; assert the capture broker request matches the expected non-stream provider fixture, WIT receives only an image Blob handle, and input Blob plus retained reader/writer resources are gone in every case.
- [ ] **Green:** Add only the named complete/error/oversize Chat modes to the Task 2 fixture Component and refresh/sign/verify its package. Define and validate `LlmChatPreferencesV1` as a host-owned copied JSON envelope containing `stream`, temperature, max tokens, and thinking; the runtime command/router creates it and guests must not infer or override mode from provider protocol details.
- [ ] **Green:** Implement `WasmRuntime::execute_llm_chat` for `stream = false` with named complete-message and total-output byte limits. It always creates the required `llm-delta` writer/reader pair before the WIT call, transfers only the writer, retains and discards the reader after a complete/error result, converts PNG input to a host-owned Blob, validates bounded semantic inputs, and cleans all request resources when the store drops.
- [ ] **Green:** Add `ProviderRuntimeRouter::chat` semantic input/output types. Recheck binding/package/grant authority after external package verification and before returning; map a `streaming` result under `stream = false` to a stable invalid response and never call the legacy executor.
- [ ] **Green:** Add this complete-Chat cleanup/bounds test by exact name to the fail-closed `llm` conformance mode.
- [ ] Keep outbound provider image encoding in the capture fixture where the protocol requires it, but exclude image bytes from WIT semantic fields, logs, DTOs, errors, exports, and history.

**Validation:**

- Run (red): `mise run test runtime_provider_chat_complete_uses_host_mode_and_releases_all_resources -- --nocapture`
- Expected: fails because LLM Chat execution, host preference envelope, and pair cleanup do not exist.
- Run (green fixture): `mise run plugin:refresh-llm-conformance-fixture`
- Expected: the fixture is re-signed and verifies after adding only complete-Chat modes.
- Run (green): `mise run test runtime_provider_chat_complete_uses_host_mode_and_releases_all_resources -- --nocapture`
- Expected: fixed non-stream text returns, oversized output is rejected, WIT image ownership is preserved, and every Blob/reader/writer endpoint is cleaned.
- Run: `mise run plugin:conformance llm`
- Expected: the named complete-Chat cleanup/bounds test is required and passes.

### Task 8: Bridge streaming Chat through paired typed resources

**Seam:** Runtime streaming Chat.

**Outcome:** A streaming guest writes ordered typed LLM deltas to the host-created writer; the host consumes the paired reader, exposes sanitized runtime events, applies backpressure/cancellation, and never replays the request through legacy transport.

**Files:**

- Modify: `runtime-plugins/conformance/wasm-llm-chat-component/src/lib.rs`, `.mise/tasks/plugin/refresh-llm-conformance-fixture`, `.mise/tasks/plugin/conformance`, `src-tauri/src/services/stream_resources.rs`, `src-tauri/src/services/wasm_runtime/bindings.rs`, `src-tauri/src/services/wasm_runtime/executor.rs`, `src-tauri/src/services/provider_runtime_router.rs`, `src-tauri/src/cmds/runtime_providers.rs`, `src-tauri/src/services/runtime_provider_tests.rs`
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json`

**Steps:**

- [ ] **Red:** Add `runtime_provider_streamed_chat_orders_deltas_and_cleans_on_cancel`. Execute the Task 2 Chat fixture through `ProviderRuntimeRouter::chat_stream` with `LlmChatPreferencesV1.stream = true`, block its broker call, cancel through the public runtime cancellation command, and table-test ordered text/reasoning/tool/complete frames, one terminal transition, oversized single delta, oversized cumulative output, and cancellation. Assert no remaining request resources, no second provider request, and no legacy call.
- [ ] **Green:** Add only the named streaming/cancel/oversize modes to the Task 2 fixture Component and refresh/sign/verify its package. Consume the writer/reader pair created by the shared Chat executor in Task 7 when `stream = true`: retain/read the reader concurrently while the guest owns the writer, bridge typed frames into `ProviderRuntimeChatEvent`, and require a streaming result. `text` remains text; reasoning/tool/complete are never reparsed as opaque bytes.
- [ ] **Green:** Enforce named per-text, per-reasoning, per-tool-argument, total-output, and frame-count bounds before forwarding a delta to the frontend Channel; on a limit breach, fail/cancel the stream and clean both endpoints. Reuse the existing single-producer/single-consumer backpressure, idle/deadline, consumer-close, and terminal-state semantics; do not change the frozen stream ABI.
- [ ] **Green:** Add `provider_runtime_models_list`, `provider_runtime_chat`, and `cancel_provider_runtime` commands. The Chat command uses a per-request `Channel`, removes its request session exactly once on every terminal path, and returns a stable error for a missing/revoked binding.
- [ ] **Green:** Register the new execution/cancellation commands in all Tauri command surfaces, extend the Phase 0 coverage test, and add this streaming/cancel/bounds test by exact name to the fail-closed `llm` conformance mode.

**Validation:**

- Run (red): `mise run test runtime_provider_streamed_chat_orders_deltas_and_cleans_on_cancel -- --nocapture`
- Expected: fails because the LLM writer/reader bridge and runtime Chat commands do not exist.
- Run (green fixture): `mise run plugin:refresh-llm-conformance-fixture`
- Expected: the fixture is re-signed and verifies after adding only streaming/cancel/oversize modes.
- Run (green): `mise run test runtime_provider_streamed_chat_orders_deltas_and_cleans_on_cancel -- --nocapture`
- Expected: ordered typed events terminate once; oversized deltas/output fail safely; cancellation stops guest/broker work, cleans resources, and performs no legacy replay.
- Run: `mise run plugin:conformance llm`
- Expected: the named streaming/cancel/bounds test is required and passes.
- Run: `mise run test runtime_plugin_security_app_commands_fully_covered -- --nocapture`
- Expected: execution and cancellation commands remain fully reviewed and trusted-app-only.

### Task 9: Put existing TypeScript plugins behind one legacy executor

**Seam:** Provider executor contract.

**Outcome:** The existing Provider plugin registry remains operational only through `LegacyFrontendProviderExecutor`, so product workflows can stop importing Provider wire/parser details directly.

**Files:**

- Create: `src/features/providers/executor.ts`, `src/features/providers/executor.test.ts`
- Modify: `src/features/providers/types.ts`, `src/features/providers/registry.ts`, `src/features/providers/providerFetch.ts`

**Steps:**

- [ ] **Red:** Add `legacy_frontend_executor_satisfies_models_unary_stream_and_cancel_contract` using the existing OpenAI Compatible fixture literals. Assert the public executor produces model descriptors, a unary response, ordered text deltas, and one best-effort cancellation without exposing a wire request to a caller.
- [ ] **Green:** Define a semantic `ProviderExecutor` interface for complete Models List, unary Chat, streaming Chat, capability metadata, and cancellation. Its callers pass model/message/image semantics, not `ProviderWireRequest`, SSE events, or ProviderPlugin instances.
- [ ] **Green:** Implement `LegacyFrontendProviderExecutor` by composing the current registry, `providerFetch`, `providerFetchStream`, and SSE decoder. Keep current malformed-response/error normalization behavior and retain every TypeScript ProviderPlugin implementation unchanged.
- [ ] **Green:** Move direct ProviderPlugin/Provider HTTP use behind the legacy executor without switching any product workflow yet.
- [ ] Add and run the two existing-behavior characterization tests above. Stop this phase and repair any characterization failure as its own red → green regression slice.

**Validation:**

- Run (red): `bun test src/features/providers/executor.test.ts`
- Expected: fails because the public executor contract and legacy adapter do not exist.
- Run (green): `bun test src/features/providers/executor.test.ts`
- Expected: legacy model/chat/stream/cancel fixtures pass entirely through the executor boundary.
- Run (characterization): `bun test src/features/providers/executor.test.ts src/features/translate/translationWorkflow.test.ts`
- Expected: existing fixture behavior, cancellation, and history semantics remain unchanged before runtime selection is introduced.

### Task 10: Add the runtime frontend executor without legacy fallback

**Seam:** Runtime executor IPC.

**Outcome:** A Provider with an active Wasm runtime binding selects `RuntimeProviderExecutor` only for models that inherit or match its declared alias; incompatible per-model API Type overrides fail closed before transport and regain existing legacy behavior only after explicit rollback.

**Files:**

- Create: `src/features/providers/runtimeExecutor.ts`, `src/features/providers/runtimeExecutor.test.ts`
- Modify: `src/features/providers/executor.ts`, `src/storage/types.ts`, `src/storage/client.ts`, `src/query/keys.ts`, `src/query/options.ts`, `src/query/events.ts`, `src/query/dataChangeEventBindings.ts`, `src-tauri/src/services/models.rs`, `src-tauri/src/cmds/models.rs`

**Steps:**

- [ ] **Red:** Add `runtime_executor_uses_runtime_ipc_and_enforces_effective_model_adapter`. With the existing Tauri invoke mock, table-test an inherited/matching model API Type, a mismatched custom-relay override, Detect, and a post-rollback legacy Provider. For active runtime, make `provider_runtime_chat` fail after start and assert runtime Commands/Channel events are used while `provider_http_request`, `provider_http_stream`, and legacy executor methods are never called; a mismatched override returns `provider_reconfiguration_required` before either transport; after rollback the existing valid legacy custom-relay behavior resumes.
- [ ] **Green:** Implement `RuntimeProviderExecutor` over `provider_runtime_models_list`, `provider_runtime_chat`, and `cancel_provider_runtime`. Convert typed runtime events to the semantic executor callbacks, forward only text as user-visible deltas, and preserve terminal error/cancellation signals.
- [ ] **Green:** Add an effective-adapter resolver that accepts Provider runtime identity plus `model.adapterId`. With an active runtime binding, only null/inherited or matching declared aliases select runtime; an incompatible override, including a custom-relay override, returns the new bounded `provider_reconfiguration_required` error before transport. With a legacy binding, retain the existing API-type/custom-relay compatibility rule.
- [ ] **Green:** Make Model API Type save/update reject a mismatched override while its Provider has an active runtime binding. This prevents a later model edit from creating a runtime state that Task 3 would have rejected.
- [ ] **Green:** Add the exact sanitized runtime/lifecycle DTO and command types to storage/client/query layers, emitting Provider cache invalidation only after successful lifecycle mutation.

**Validation:**

- Run (red): `bun test src/features/providers/runtimeExecutor.test.ts`
- Expected: fails because runtime DTOs, commands, effective-model selection, and override enforcement do not exist.
- Run (green): `bun test src/features/providers/runtimeExecutor.test.ts`
- Expected: matching models use runtime IPC exclusively, mismatched overrides fail before transport, rollback restores the legacy compatibility path, and runtime failure never calls legacy transport.

### Task 11: Build the OpenAI Compatible runtime package

**Seam:** Package developer CLI.

**Outcome:** `com.langnext.provider.openai-compatible` is a deterministic signed-package candidate whose real Component reproduces current Models List, unary/stream Chat, image input, and sanitized error behavior through the generic runtime host.

**Files:**

- Create: `runtime-plugins/openai-compatible/protocol/Cargo.toml`, `runtime-plugins/openai-compatible/protocol/src/lib.rs` — shared bounded OpenAI protocol code.
- Create: `runtime-plugins/openai-compatible/models/Cargo.toml`, `runtime-plugins/openai-compatible/models/src/lib.rs` — `llm-models-world` Component.
- Create: `runtime-plugins/openai-compatible/chat/Cargo.toml`, `runtime-plugins/openai-compatible/chat/src/lib.rs` — `llm-chat-world` Component.
- Create: `runtime-plugins/openai-compatible/plugin.json`, `runtime-plugins/openai-compatible/schemas/config.json`, `runtime-plugins/openai-compatible/tests/fixtures/`, `runtime-plugins/openai-compatible/fixtures/`
- Create: `.mise/tasks/plugin/build-openai-compatible`, `.mise/tasks/plugin/refresh-openai-compatible-fixture`
- Modify: `.mise/tasks/plugin/conformance`, `src-tauri/src/services/runtime_provider_tests.rs`
- Port: stable request/response/error/stream/image literals from `src/features/providers/builtin/openaiCompatible.ts` and `src/features/providers/builtin/openaiCompatible.test.ts`

**Steps:**

- [ ] **Red:** Add `openai_compatible_runtime_component_matches_current_provider_fixtures`. Execute a dev-signed package fixture through the provider binding/router/broker path and assert fixed Models List request/result, Chat request/result, split streaming text deltas, image Blob usage, and sanitized malformed/error cases.
- [ ] **Green:** Implement the two frozen LLM worlds as separate Models and Chat Components sharing the protocol crate. Declare package ID `com.langnext.provider.openai-compatible`, legacy alias `openai-compatible`, capabilities `llm.models.list@1`/`llm.chat@1` with distinct artifact paths, the closed provider-instance endpoint/auth policy, and no credential slots.
- [ ] **Green:** Port only current OpenAI Compatible wire construction, parsing, stream decoding, image handling, bounded aggregate model listing, provider error mapping, and the host-selected `LlmChatPreferencesV1` mode. The guest owns provider protocol; it does not own prompts, fallback, cancellation policy, history, credential resolution, destination choice, or stream-mode policy.
- [ ] **Green:** Make `plugin:build-openai-compatible` pin cargo-component `0.21.1`, build both Components with `--locked`, verify committed artifact fixtures, assemble a deterministic unsigned staging tree, generate the complete signed file index, and never write a final package digest. Extend `plugin:check-no-wasi` with exact import checks for both production OpenAI Compatible artifacts.
- [ ] **Green:** Make `plugin:refresh-openai-compatible-fixture` the dev-only fixture path: build with explicit fixture refresh, sign staged exact `plugin.json` with the committed dev seed, finalize, and verify with `runtime-plugins/conformance/fixtures/packages/keys/vendor-public-key.hex`. Production signing stays external.
- [ ] **Green:** Add exact named OpenAI Compatible tests to `plugin:conformance llm`; fixture-only parser tests are insufficient.

**Validation:**

- Run (red): `mise run test openai_compatible_runtime_component_matches_current_provider_fixtures -- --nocapture`
- Expected: fails because the package, fixture, and guest implementation do not exist.
- Run (green fixture): `mise run plugin:refresh-openai-compatible-fixture`
- Expected: the dev-signed fixture archive and adjacent SHA-256 verify with the committed dev public key.
- Run (green): `mise run test openai_compatible_runtime_component_matches_current_provider_fixtures -- --nocapture`
- Expected: the actual guest matches fixed current-provider fixtures through the runtime host.
- Run: `mise run plugin:conformance llm`
- Expected: all named generic and OpenAI Compatible real-component tests pass.

### Task 12: Seed only reviewed defaults for new matching providers

**Seam:** Provider runtime lifecycle.

**Outcome:** A verified vendor OpenAI Compatible package can become the default only for newly created matching providers; existing providers remain legacy until an explicit lifecycle transition or rollback action.

**Files:**

- Modify: `src-tauri/src/services/runtime_providers.rs`, `src-tauri/src/services/providers.rs`, `src-tauri/src/services/plugin_store.rs`, `src-tauri/src/state.rs`, `src-tauri/src/services/runtime_provider_tests.rs`, `src-tauri/tauri.conf.json`
- Release output: `src-tauri/resources/plugins/com.langnext.provider.openai-compatible-1.0.0.lnplugin` — copied only by release CI after external signing and verification.

**Steps:**

- [ ] **Red:** Add `runtime_provider_vendor_default_applies_only_to_new_matching_provider`. Bootstrap a verified vendor fixture, create one matching and one nonmatching Provider, then assert only the matching newly created Provider receives the exact default package/grant; an existing matching Provider stays legacy; an untrusted, revoked, alias-ambiguous, or missing package never becomes a default.
- [ ] **Green:** Add vendor LLM archive discovery using a dedicated filename prefix/environment override. Reuse immutable package verification and bind a default by exact digest, publisher identity, version, and legacy alias — never by an ID/version lookup alone.
- [ ] **Green:** In the Provider create transaction, create the default runtime binding only when the new Provider adapter alias and persisted connection requirements match the reviewed vendor default. Failure to find/verify a default leaves the new Provider safely legacy; it does not fail the Provider CRUD operation.
- [ ] **Green:** Keep existing Provider rows legacy and offer only the Task 3 explicit preview/apply migration path. Do not auto-pin a package after install, app startup, edit, sync, or request failure.
- [ ] **Release:** After offline signing/finalization, copy the verified archive to `src-tauri/resources/plugins/`; normal developer builds and the app never receive a production private key.

**Validation:**

- Run (red): `mise run test runtime_provider_vendor_default_applies_only_to_new_matching_provider -- --nocapture`
- Expected: fails because provider package defaults and provider-create binding do not exist.
- Run (green): `mise run test runtime_provider_vendor_default_applies_only_to_new_matching_provider -- --nocapture`
- Expected: only a newly created matching Provider receives the verified exact default; every pre-existing or unsafe case remains legacy.

### Task 13: Expose tested provider runtime lifecycle actions

**Seam:** Provider lifecycle actions.

**Outcome:** A public controller performs preview, permission acknowledgement, apply, rollback, and Provider/model cache invalidation; `ProviderEditor` is a thin consumer that presents only sanitized state.

**Files:**

- Create: `src/features/providers/runtimeProviderActions.ts`, `src/features/providers/runtimeProviderActions.test.ts`
- Create: `src/features/providers/runtimeProviderPresentation.ts`, `src/features/providers/runtimeProviderPresentation.test.ts`
- Modify: `src/features/models/ProviderEditor.tsx`, `src/features/models/adapterOptions.ts`, `src/storage/client.ts`, `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`

**Steps:**

- [ ] **Red:** Add `runtime_provider_actions_preview_apply_rollback_and_invalidate`. Through the public action controller, use fixed lifecycle command results and a capture Query client. Assert preview is requested first, permission-expanding apply requires acknowledgement, successful apply/rollback invalidate Provider and Provider-model keys, and failed/cancelled actions mutate neither cache nor runtime identity. In the same table, assert the presentation mapper exposes only a label, runtime kind/version, safe state, and explicit actions.
- [ ] **Green:** Implement `runtimeProviderActions` over the typed storage client lifecycle commands and inject its cache invalidator. Implement the pure presentation mapping with short localized labels for legacy, active runtime package, unavailable package, pending activation, preview, apply, and rollback.
- [ ] **Green:** Update `ProviderEditor` to consume the controller/presentation mapping, show previewed permission/package differences, require an explicit confirmation before apply, and expose rollback only when the controller reports it available.
- [ ] **Green:** Keep the existing adapter picker and missing-plugin display behavior. A status view or failed action must not silently mutate the selected Provider or its models.

**Validation:**

- Run (red): `bun test src/features/providers/runtimeProviderActions.test.ts src/features/providers/runtimeProviderPresentation.test.ts`
- Expected: fails because lifecycle actions, invalidation behavior, and presentation mapping do not exist.
- Run (green): `bun test src/features/providers/runtimeProviderActions.test.ts src/features/providers/runtimeProviderPresentation.test.ts`
- Expected: action ordering, acknowledgement, cache invalidation, failure isolation, and safe presentation all pass.
- Run: `mise run typecheck`
- Expected: ProviderEditor and storage lifecycle DTO consumers compile.

### Task 14: Cut over connection testing and model sync

**Seam:** Connection and model sync.

**Outcome:** Connection tests and model sync select the persisted executor while preserving complete-snapshot persistence, version races, model UUID behavior, and no-partial-merge failure semantics.

**Files:**

- Create: `src/features/models/providerConnection.test.ts`, `src/features/models/providerModelSync.test.ts`
- Modify: `src/features/models/providerConnection.ts`, `src/features/models/providerModelSync.ts`, `src/features/models/ProviderEditor.tsx`, `src/features/providers/executor.ts`
- Modify: `src-tauri/src/services/models.rs`, `src-tauri/src/cmds/models.rs` only if a runtime aggregate DTO needs an existing persistence input extension

**Steps:**

- [ ] **Red:** Add `runtime_executor_connection_and_sync_preserve_complete_snapshot_semantics`. Run public connection and sync workflows against a runtime Provider with a fixed aggregate list, then assert the current complete-snapshot apply path receives all unique models once; a runtime list failure preserves current model rows; and a changed `updatedAt` returns `connection_changed` without persistence.
- [ ] **Green:** Resolve the executor from the Provider DTO before testing/syncing. Legacy execution retains the current frontend pagination loop; runtime execution consumes the guest's bounded aggregate list without inventing a second frontend pagination protocol.
- [ ] **Green:** Preserve all-pages-before-merge semantics, dedupe, caps, models.dev enrichment, sync status, and optimistic concurrency in the existing Rust persistence seam. Do not create a second remote model cache.
- [ ] **Green:** Surface unavailable/revoked runtime state as a bounded sync/connection error while retaining visible existing models and Provider identity.

**Validation:**

- Run (red): `bun test src/features/models/providerConnection.test.ts src/features/models/providerModelSync.test.ts`
- Expected: fails because workflows directly require a TypeScript ProviderPlugin and cannot select a runtime executor.
- Run (green): `bun test src/features/models/providerConnection.test.ts src/features/models/providerModelSync.test.ts`
- Expected: runtime and legacy execution preserve complete snapshot, dedupe, failure, and race behavior.
- Run: `mise run test apply_provider_model_sync -- --nocapture`
- Expected: transactional persistence still rejects stale or partial sync updates.

### Task 15: Cut over Translation, including streaming fallback

**Seam:** Translation.

**Outcome:** Runtime providers participate in unary and streaming Translation while host workflows retain prompt creation, fallback ordering, reset behavior, cancellation, and exactly-once history semantics.

**Files:**

- Modify: `src/features/translate/translationWorkflow.ts`, `src/features/translate/translationContext.ts`, `src/features/translate/translationWorkflow.test.ts`, `src/features/providers/executor.ts`

**Steps:**

- [ ] **Red:** Add `runtime_executor_translation_preserves_host_fallback_reset_cancel_and_history_once`. Through `runTranslationNonStream` and `runTranslationStream`, use a runtime primary attempt that emits partial text then fails and a separately configured next model that succeeds. Assert one reset before the next model's text, no replay through the primary Provider's legacy executor, exactly one final history record, and no history after cancellation.
- [ ] **Green:** Replace direct registry/fetch/SSE calls with the selected executor. Keep prompt templates, source/target resolution, temperature/max-token precedence, retry eligibility, fallback ordering, stale guards, and history completion in the existing workflow.
- [ ] **Green:** Map runtime typed text events to the existing chunk callback. Treat terminal resource/guest errors as the attempt result; never restart the same request through `LegacyFrontendProviderExecutor`.
- [ ] **Green:** Permit existing configured model fallback only after the failed attempt ends. It may select a different provider/runtime under current product rules, but it is never an implicit same-provider legacy replay.

**Validation:**

- Run (red): `bun test src/features/translate/translationWorkflow.test.ts`
- Expected: fails because Translation directly selects the legacy TypeScript plugin/transport path.
- Run (green): `bun test src/features/translate/translationWorkflow.test.ts`
- Expected: runtime unary/stream failures retain host fallback/reset/cancel/history behavior with no same-request legacy replay.

### Task 16: Keep detection policy host-owned across executors

**Seam:** Language detection.

**Outcome:** Detect uses the selected executor while host-owned catalog metadata supplies policy and the existing workflow retains truncation, supported-code validation, soft failures, and cancellation semantics.

**Files:**

- Modify: `src/features/translate/detectLanguageFlow.ts`, `src/features/translate/detectLanguageFlow.test.ts`, `src/features/providers/executor.ts`, `src/features/providers/registry.ts`, `src/features/providers/runtimeExecutor.ts`

**Steps:**

- [ ] **Red:** Add `runtime_executor_detection_uses_host_policy_and_supported_language_validation`. Give a runtime Provider fixed detection metadata and response fixtures. Assert host-selected thinking/max-token policy reaches the runtime Chat input, valid language output succeeds, an unsupported code is `invalid_response`, and a cancelled request does not start legacy transport.
- [ ] **Green:** Move detection policy to host-interpreted provider catalog metadata. Legacy registrations expose the same data; signed runtime manifests declare bounded metadata that the host validates and projects. The guest receives already-selected Chat options, not workflow policy authority.
- [ ] **Green:** Route Detect Chat through the selected executor while retaining sample truncation, model selection, app language set validation, Effect boundary, and existing soft failure behavior.
- [ ] Keep the DeepSeek policy as catalog metadata until Task 21 ports the matching guest; do not hard-code a second workflow branch by package ID.

**Validation:**

- Run (red): `bun test src/features/translate/detectLanguageFlow.test.ts`
- Expected: fails because detection obtains policy and transport directly from the legacy ProviderPlugin.
- Run (green): `bun test src/features/translate/detectLanguageFlow.test.ts`
- Expected: runtime detection receives host policy, returns only supported codes, and cancellation has no legacy fallback.

### Task 17: Route AI OCR through the selected executor

**Seam:** AI OCR.

**Outcome:** AI OCR can use a runtime provider's multimodal Chat path while the host creates the WIT image Blob, preserves current model/API-type checks, and returns only parsed text.

**Files:**

- Modify: `src/features/ocr/recognizeOcrFlow.ts`, `src/features/ocr/recognizeOcrFlow.test.ts`, `src/features/providers/executor.ts`, `src/features/providers/runtimeExecutor.ts`

**Steps:**

- [ ] **Red:** Add `runtime_executor_ai_ocr_uses_host_blob_path_without_legacy_http`. Configure a runtime AI OCR Provider and fixed image fixture, then assert `recognizeOcrFlow` invokes runtime Chat, does not call `provider_http_*`, receives fixed text, and maps image/guest errors without leaking PNG content.
- [ ] **Green:** Select the executor after existing Provider/model/API-type validation. Pass the PNG only in semantic executor input; the runtime command converts it to the host-owned Blob path established in Task 7.
- [ ] **Green:** Preserve existing Baidu and service-plugin OCR dispatch, AI prompt-template selection, output/token rules, and returned `OcrRecognizeResult` shape.
- [ ] **Green:** On runtime image/guest error, retain the existing normalized error path and do not retry the same OCR call through the TypeScript ProviderPlugin.

**Validation:**

- Run (red): `bun test src/features/ocr/recognizeOcrFlow.test.ts`
- Expected: fails because AI OCR directly requires a TypeScript ProviderPlugin and Provider HTTP.
- Run (green): `bun test src/features/ocr/recognizeOcrFlow.test.ts`
- Expected: runtime OCR uses only the host Blob/runtime path; legacy Baidu/service paths remain unchanged.

### Task 18: Migrate OpenAI Responses as an independent package

**Seam:** Package developer CLI.

**Outcome:** `com.langnext.provider.openai-responses` reproduces the existing OpenAI Responses protocol through the runtime host and can coexist with its explicit legacy executor.

**Files:**

- Create: `runtime-plugins/openai-responses/protocol/`, `runtime-plugins/openai-responses/models/`, `runtime-plugins/openai-responses/chat/` — shared protocol plus distinct Models/Chat Component crates and locks.
- Create: `runtime-plugins/openai-responses/plugin.json`, `runtime-plugins/openai-responses/schemas/config.json`, `runtime-plugins/openai-responses/tests/fixtures/`, `runtime-plugins/openai-responses/fixtures/`
- Create: `.mise/tasks/plugin/build-openai-responses`, `.mise/tasks/plugin/refresh-openai-responses-fixture`
- Modify: `.mise/tasks/plugin/conformance`, `src-tauri/src/services/runtime_provider_tests.rs`
- Port: fixtures from `src/features/providers/builtin/openaiResponses.ts` and `src/features/providers/builtin/openaiResponses.test.ts`

**Steps:**

- [ ] **Red:** Add `openai_responses_runtime_component_matches_current_provider_fixtures` that executes the dev-signed guest through the provider router and asserts fixed model, Responses API unary, event-stream, image, and malformed/error fixture behavior.
- [ ] **Green:** Implement only OpenAI Responses request/response/event behavior in shared protocol plus separate Models/Chat Components; declare its package ID, legacy alias, frozen LLM capabilities with distinct artifact paths, and closed provider-instance authority.
- [ ] **Green:** Add deterministic two-Component build, dev fixture refresh, signed-file-index validation, exact host preference-envelope fixtures, no-WASI import checks, and required LLM conformance registration following the OpenAI Compatible task.
- [ ] Keep the legacy OpenAI Responses executor available for the dual-stack release; do not delete its TypeScript implementation.

**Validation:**

- Run (red): `mise run test openai_responses_runtime_component_matches_current_provider_fixtures -- --nocapture`
- Expected: fails because the runtime package and fixture do not exist.
- Run (green fixture): `mise run plugin:refresh-openai-responses-fixture`
- Expected: a deterministic dev-signed fixture verifies with the committed public key.
- Run (green): `mise run test openai_responses_runtime_component_matches_current_provider_fixtures -- --nocapture`
- Expected: the real guest matches the fixed OpenAI Responses protocol fixtures.

### Task 19: Migrate Anthropic as an independent package

**Seam:** Package developer CLI.

**Outcome:** `com.langnext.provider.anthropic` reproduces current Messages API, content, streaming, and image behavior while the host continues to inject the persisted API-key credential.

**Files:**

- Create: `runtime-plugins/anthropic/protocol/`, `runtime-plugins/anthropic/models/`, `runtime-plugins/anthropic/chat/` — shared protocol plus distinct Models/Chat Component crates and locks.
- Create: `runtime-plugins/anthropic/plugin.json`, `runtime-plugins/anthropic/schemas/config.json`, `runtime-plugins/anthropic/tests/fixtures/`, `runtime-plugins/anthropic/fixtures/`
- Create: `.mise/tasks/plugin/build-anthropic`, `.mise/tasks/plugin/refresh-anthropic-fixture`
- Modify: `.mise/tasks/plugin/conformance`, `src-tauri/src/services/runtime_provider_tests.rs`
- Port: fixtures from `src/features/providers/builtin/anthropic.ts` and `src/features/providers/builtin/anthropic.test.ts`

**Steps:**

- [ ] **Red:** Add `anthropic_runtime_component_matches_current_provider_fixtures` through the real signed package/router/broker path. Assert the fixed Messages request, non-secret version header, content/image handling, event parsing, and normalized error fixtures.
- [ ] **Green:** Implement only Anthropic protocol behavior in shared protocol plus separate Models/Chat Components with distinct manifest artifact paths. The guest may request its non-secret version header; the host injects the stored `x-api-key` only through the bound provider auth scheme.
- [ ] **Green:** Add deterministic two-Component build/fixture refresh, no-WASI import checks, and required LLM conformance registration, including an assertion that neither API key nor credential reference enters guest data, package bytes, logs, or DTOs.
- [ ] Retain the legacy Anthropic executor for the dual-stack release.

**Validation:**

- Run (red): `mise run test anthropic_runtime_component_matches_current_provider_fixtures -- --nocapture`
- Expected: fails because the Anthropic guest/package fixture does not exist.
- Run (green fixture): `mise run plugin:refresh-anthropic-fixture`
- Expected: the deterministic dev fixture finalizes and verifies.
- Run (green): `mise run test anthropic_runtime_component_matches_current_provider_fixtures -- --nocapture`
- Expected: actual guest behavior matches fixed Anthropic fixtures and host-only authentication remains intact.

### Task 20: Migrate Gemini with guest-owned bounded pagination

**Seam:** Package developer CLI.

**Outcome:** `com.langnext.provider.gemini` preserves Gemini model normalization, bounded internal page traversal, chat/image behavior, and stream parsing without adding a WIT pagination field.

**Files:**

- Create: `runtime-plugins/gemini/protocol/`, `runtime-plugins/gemini/models/`, `runtime-plugins/gemini/chat/` — shared protocol plus distinct Models/Chat Component crates and locks.
- Create: `runtime-plugins/gemini/plugin.json`, `runtime-plugins/gemini/schemas/config.json`, `runtime-plugins/gemini/tests/fixtures/`, `runtime-plugins/gemini/fixtures/`
- Create: `.mise/tasks/plugin/build-gemini`, `.mise/tasks/plugin/refresh-gemini-fixture`
- Modify: `.mise/tasks/plugin/conformance`, `src-tauri/src/services/runtime_provider_tests.rs`
- Port: fixtures from `src/features/providers/builtin/gemini.ts` and `src/features/providers/builtin/gemini.test.ts`

**Steps:**

- [ ] **Red:** Add `gemini_runtime_component_aggregates_bounded_pages_and_matches_current_fixtures`. Feed fixed paginated responses, a repeated token, image/chat inputs, stream events, and malformed bodies through the real guest. Assert the fixed aggregate models, duplicate/repeated-token rejection, bounded failure code, and no host WIT change.
- [ ] **Green:** Implement Gemini protocol behavior in shared protocol plus separate Models/Chat Components with distinct manifest artifact paths. Keep bounded page traversal inside the Models guest with named maximum page/item/total constants; it returns one `llm.models.list@1` aggregate only after all pages succeed, and any page failure returns no partial list.
- [ ] **Green:** Keep query-key authentication host-only, port `alt=sse` and model-resource normalization from current fixtures, and add deterministic two-Component build/fixture/no-WASI/conformance requirements.
- [ ] Retain the legacy Gemini executor for the dual-stack release.

**Validation:**

- Run (red): `mise run test gemini_runtime_component_aggregates_bounded_pages_and_matches_current_fixtures -- --nocapture`
- Expected: fails because the Gemini runtime guest and bounded aggregate behavior do not exist.
- Run (green fixture): `mise run plugin:refresh-gemini-fixture`
- Expected: the deterministic dev fixture finalizes and verifies.
- Run (green): `mise run test gemini_runtime_component_aggregates_bounded_pages_and_matches_current_fixtures -- --nocapture`
- Expected: real guest pagination and protocol fixtures pass without a WIT change or partial model result.

### Task 21: Migrate DeepSeek and close the LLM conformance set

**Seam:** Package developer CLI.

**Outcome:** `com.langnext.provider.deepseek` reproduces current protocol and detection metadata, and all five built-ins have explicit package fixtures, exact required conformance tests, and one stable dual-stack release path.

**Files:**

- Create: `runtime-plugins/deepseek/protocol/`, `runtime-plugins/deepseek/models/`, `runtime-plugins/deepseek/chat/` — shared protocol plus distinct Models/Chat Component crates and locks.
- Create: `runtime-plugins/deepseek/plugin.json`, `runtime-plugins/deepseek/schemas/config.json`, `runtime-plugins/deepseek/tests/fixtures/`, `runtime-plugins/deepseek/fixtures/`
- Create: `.mise/tasks/plugin/build-deepseek`, `.mise/tasks/plugin/refresh-deepseek-fixture`
- Modify: `.mise/tasks/plugin/conformance`, `src-tauri/src/services/runtime_provider_tests.rs`, `src/features/providers/registry.ts`
- Port: fixtures from `src/features/providers/builtin/deepseek.ts` and `src/features/providers/builtin/deepseek.test.ts`

**Steps:**

- [ ] **Red:** Add `deepseek_runtime_component_matches_current_provider_and_detection_policy_fixtures`. Execute fixed model/chat/stream/error fixtures through the real guest and assert host-projected DeepSeek detection metadata produces the known thinking/max-token input without placing policy control in the guest.
- [ ] **Green:** Implement only DeepSeek protocol behavior in shared protocol plus separate Models/Chat Components with distinct manifest artifact paths; declare bounded host-interpreted detection metadata, package ID, legacy alias, frozen LLM capabilities, and provider-instance authority.
- [ ] **Green:** Add deterministic two-Component build/fixture refresh, no-WASI import checks, and exact required test names to `plugin:conformance llm`. Make the aggregate suite fail if any of OpenAI Compatible, OpenAI Responses, Anthropic, Gemini, or DeepSeek is omitted.
- [ ] **Green:** Verify every built-in has an explicit lifecycle migration/rollback path and legacy executor retained for one stable release. Do not remove TypeScript implementations until Phase 12.

**Validation:**

- Run (red): `mise run test deepseek_runtime_component_matches_current_provider_and_detection_policy_fixtures -- --nocapture`
- Expected: fails because the DeepSeek guest, package fixture, and catalog metadata do not exist.
- Run (green fixture): `mise run plugin:refresh-deepseek-fixture`
- Expected: the deterministic dev fixture finalizes and verifies.
- Run (green): `mise run test deepseek_runtime_component_matches_current_provider_and_detection_policy_fixtures -- --nocapture`
- Expected: actual guest protocol behavior and host-owned detection policy match fixed fixtures.
- Run: `mise run plugin:conformance llm`
- Expected: the aggregate LLM suite verifies all required generic and five-provider real-component tests by name.

## Review Gate

After every task's green validation and before the next task, review the changed public seam for duplication, naming, error handling, and security regressions. Refactor only in a separate reviewed change after the relevant green suite remains passing; do not mix refactoring into a red → green slice.

## Final Validation

Local fixture validation uses only committed development fixture keys. Production release CI receives externally signed exact `plugin.json` bytes and verifies packages with the production public key; it never exposes a production private key to the app or developer build.

```bash
mise run plugin:build-openai-compatible
mise run plugin:build-openai-responses
mise run plugin:build-anthropic
mise run plugin:build-gemini
mise run plugin:build-deepseek
mise run plugin:check-no-wasi
mise run plugin:verify -- \
  runtime-plugins/conformance/fixtures/packages/signed-valid.lnplugin \
  --public-key-file runtime-plugins/conformance/fixtures/packages/keys/vendor-public-key.hex
mise run plugin:conformance llm
mise run plugin:conformance all
mise run test runtime_provider -- --nocapture
mise run test
mise run test runtime_plugin_security_app_commands_fully_covered -- --nocapture
bun test src/features/providers/executor.test.ts src/features/providers/runtimeExecutor.test.ts
bun test src/features/models/providerConnection.test.ts src/features/models/providerModelSync.test.ts
bun test src/features/translate/translationWorkflow.test.ts src/features/translate/detectLanguageFlow.test.ts
bun test src/features/ocr/recognizeOcrFlow.test.ts
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run build
```

Expected: no-WASI and signed-package verification pass; generic, existing Phase 4–7, and five-provider packages execute through verified provider bindings; model sync, Translation, Detect, and AI OCR retain stable identity, cancellation, fallback, and history behavior; no test observes an implicit same-request legacy replay.

Release CI runs the following pattern once per package after external signature injection; replace the package ID/version and production public-key file as appropriate:

```bash
mise run plugin:finalize-package -- \
  runtime-plugins/dist/staging/com.langnext.provider.openai-compatible-1.0.0 \
  runtime-plugins/dist/com.langnext.provider.openai-compatible-1.0.0.lnplugin \
  --public-key-file <production-vendor-public-key-file>
mise run plugin:verify -- \
  runtime-plugins/dist/com.langnext.provider.openai-compatible-1.0.0.lnplugin \
  --public-key-file <production-vendor-public-key-file>
```

Expected: final archive verification succeeds before release CI copies it into `src-tauri/resources/plugins/` for Tauri packaging.

## Manual Validation

Run `mise run tauri:dev` with a user-owned harmless test provider account after the automated suites pass. This step is manual-only; it cannot be replaced with fixtures or marked complete from automated output.

1. Create a new matching OpenAI Compatible Provider and confirm the reviewed default package is visible; confirm a pre-existing matching Provider remains legacy.
2. Preview and explicitly apply a runtime package to one existing Provider, then test connection and sync models.
3. Translate harmless fixed text once non-stream and once stream; cancel one stream after partial output; trigger a configured fallback and confirm the UI resets before the next model emits.
4. Run language detection and AI OCR with a harmless fixed image; verify the image/output are absent from default logs.
5. Roll back the Provider runtime and confirm the exact legacy executor works again without changed Provider/model/profile IDs.
6. Inspect Provider DTOs, exported configuration, logs, and error surfaces for credentials, credential references, secret-bearing URLs, user prompts, images, raw provider bodies, or raw model output.

## Failure Behavior

- Missing, revoked, incompatible, or alias-ambiguous package — preserve Provider/models and return `plugin_unavailable`; never substitute another package or legacy executor.
- Grant subject, package digest, capability, endpoint, auth policy, or provider instance mismatch — deny before vault lookup or network transport.
- Runtime lifecycle preview/CAS/rollback failure — preserve source binding, provider connection fields, models, credentials, and snapshots.
- Models List page/protocol failure inside a guest — return a bounded failure and do not apply a partial model snapshot.
- Guest trap, malformed response, stream terminal failure, limit, or consumer disconnect — clean request resources, return a stable error, and let only existing configured next-model fallback rules run after the attempt ends.
- Runtime request cancellation — stop guest/broker work, suppress later fallback starts, emit no terminal translation success/error callback for abandoned work, and write no history.
- History persistence failure — retain existing best-effort behavior; the terminal Translation result is unchanged.

## Privacy and Security

- Provider credentials, credential references, persisted Base URLs, proxy credentials, and final secret-bearing URLs remain host-only; runtime guests receive only bounded semantic request/config data and broker results.
- `providerRuntime` manifest metadata requests capability/transport shape; it never grants access. Exact package digest, ProviderInstance grant subject, capability, endpoint, method, limits, and auth policy must all authorize execution.
- User prompts, provider request/response bodies, model output, OCR images/text, and typed reasoning/tool deltas are excluded from default runtime logs, DTOs, exports, and health/status records.
- WIT image transfer uses host-owned Blob resources and streaming uses paired host-owned writer/reader resources. Handles are principal/request scoped and never persist.
- Production package signing is external. Developer fixture signing is explicitly dev-only and uses only committed fixture material.

## Rollout Notes

- Ship OpenAI Compatible first and retain its legacy executor for one stable dual-stack release.
- Migrate OpenAI Responses, Anthropic, Gemini, and DeepSeek one package per reviewable change after their real-component conformance slice passes.
- Package defaults affect only new matching Providers. Existing Provider migration and rollback always require explicit preview/approval/apply actions.
- Do not remove TypeScript Provider implementations, frontend raw Provider HTTP, or legacy bindings in this phase; Phase 12 owns retirement after the dual-stack release gate.

## Risks and Mitigations

- **Frozen Models List ABI lacks continuation.** Guest-owned bounded aggregation preserves WIT v1 and prevents host/frontend pagination drift.
- **Protocol drift during porting.** Port current fixed TypeScript fixtures before lifecycle activation and execute them through the real signed guest/host path.
- **Credential exfiltration by guest code.** Bind broker access to one ProviderInstance grant and inject auth only after host authorization; guests never receive Base URL or secret material.
- **Partial stream/fallback duplication.** Preserve paired stream terminal/cancellation semantics and forbid same-request legacy replay after runtime execution starts.
- **Unsafe default activation.** Bind defaults to an exact verified vendor package and apply them only during new matching Provider creation; keep existing Providers explicit.

## Open Questions

- Confirm the proposed seams before implementation begins, as required by the TDD workflow.
- Confirm whether v1 should expose reasoning/tool-call deltas in a future UI; this plan intentionally preserves them only inside the typed host bridge and displays/persists text deltas only.

---

## Superseded: Multi-Interface Control Plane (Post-Phase 8)

The singular provider-level package pin described above is superseded by the multi-interface
control plane in `docs/plans/2026-08-03-multi-interface-provider-runtime-plan.md` (migration
0025 and later). The following Phase 8 assumptions no longer hold and are replaced there:

- **Singular provider pin.** The control plane is now a set of `ProviderRuntimeInterfaceBinding`
  records keyed by `(provider_id, adapter_id)`. One active binding owns one API type per
  Provider; a package may serve several declared aliases, each with an independent
  adapter-keyed row sharing the exact Provider/package grant revision.
- **Mismatched override rejection.** Saving or attaching no longer rejects model API Type
  overrides globally. The additive executor resolver routes a matching attached interface
  through the runtime executor and an unbound API type through the legacy executor; a Wasm
  binding that is unavailable/revoked fails closed.
- **One package per Provider.** Reuse of the same verified package across Providers is safe:
  grants are scoped to `(provider_instance, package_digest, revision)`.
- **Provider-level rollback snapshots.** Lifecycle snapshots are adapter-scoped; migrated v24
  snapshots become Provider-scoped atomic snapshot sets.
- **Export format v7.** Configuration export advances to v8 with ordered `runtimeBindings`
  requirements; v7 imports normalize to per-effective-type unavailable requirements.
- **Provider DTO `runtime`.** Kept as a deprecated compatibility projection of the Provider
  default API type; `runtimeBindings` is authoritative.

WIT v1 stays byte-for-byte unchanged: API-type dispatch remains host-owned persistent
control-plane state, never a guest-controlled WIT field.
