# Implementation Plan

**Goal:** Fix all remaining configuration-import review findings across accessibility, apply-state safety, conflict typing, preview presentation, route acceptance, historical normalization, and no-execution guarantees.

**Inputs:** The provided Standards review (4 findings), Spec review (5 findings), the current repository implementation, the vendored Base UI 1.6 documentation, and the Phase 11 acceptance tests and fixtures.

**Assumptions:**

- Add focused component-test dependencies because the repository has no DOM test seam for Base UI accessibility or click concurrency.
- A user can close the dialog while preview or apply work continues. Closing hides the dialog but does not cancel a host operation that has already started. A completed apply still runs the route acceptance workflow.
- `stale` covers unknown, reused, already-claimed, and CAS-mismatched preview IDs. `expired` covers only TTL expiry.
- Runtime package digests, plugin IDs, versions, publisher key IDs, and publisher fingerprints are non-secret identifiers and can appear in full in the confirmation UI.
- The seams below are fixed by the review requirements. No product decision remains before implementation.

**Architecture:** Keep the frontend dialog as a state-machine client. Move to `applying` before IPC and finish only from that state. Preserve TanStack Query as the DTO cache, keep Effect in the transfer workflow, and introduce a thin route workflow seam for post-import effects. Extend the Rust IPC error envelope with a typed optional reason, enrich committed fixtures, and add test-only observation at real runtime dispatch boundaries without adding a production mock path.

**Tech Stack:** React 19, Base UI 1.6, Bun test, Testing Library with Happy DOM, Effect 3, TanStack Query 5, Tauri 2, Rust 1.96, rusqlite.

---

## Finding Coverage

1. **Unnamed `RadioGroup`:** Task 3 composes `Fieldset.Root` with `RadioGroup` and verifies the accessible group name.
2. **Missing corner close control:** Task 3 adds one persistent `Dialog.Close` and verifies it in idle, loading, previewed, applying, conflict, and error phases.
3. **Conflict kind parsed from prose:** Task 1 adds a typed Rust IPC reason and removes frontend message parsing.
4. **Duplicated conflict/error body:** Task 3 introduces one shared `RetryableErrorBody`.
5. **Apply transitions after IPC:** Task 2 transitions before awaiting, prevents duplicate submit, and preserves non-conflict failures.
6. **Incomplete confirmation presentation:** Task 4 displays mode, graph counts, exact runtime identity labels, status, and required action.
7. **Incomplete no-execution acceptance:** Task 7 covers exact installed Wasm and trusted-native-worker requirements and observes all dispatch categories.
8. **Empty historical fixtures:** Task 6 adds linked graph data and runtime semantics to v2-v8 fixtures and asserts normalized content.
9. **Missing route-workflow acceptance:** Task 5 adds and tests the route workflow seam for applied and non-applied outcomes.

**Out of scope:** None. Every review finding is in scope.

## File Map

### Frontend

- Modify: `package.json` — add focused DOM component-test dependencies.
- Modify: `bun.lock` — lock the added test dependencies.
- Create: `src/test/registerDom.ts` — register and clean up the Happy DOM environment for Bun component tests.
- Create: `src/features/settings/ConfigurationImportPreviewDialog.test.tsx` — verify dialog accessibility, persistent close affordance, apply concurrency, error handling, and confirmation content through rendered roles and user actions.
- Modify: `src/features/settings/ConfigurationImportPreviewDialog.tsx` — fix Base UI composition, apply timing, persistent close control, shared retryable error body, and complete preview content.
- Modify: `src/features/settings/configurationImportPreviewState.ts` — retain explicit start/finish transitions and remove the post-result transition shortcut.
- Modify: `src/features/settings/configurationImportPreviewState.test.ts` — verify pre-IPC applying state, terminal results, and error transitions.
- Modify: `src/features/settings/configurationTransfer.ts` — map typed IPC conflict reasons instead of parsing messages.
- Modify: `src/features/settings/configurationTransfer.test.ts` — verify stale/expired reason mapping and non-conflict rejection.
- Modify: `src/features/settings/importPreviewPresentation.ts` — return exact labeled runtime identity rows and mode presentation data.
- Modify: `src/features/settings/importPreviewPresentation.test.ts` — verify all labels and full untruncated values.
- Modify: `src/storage/ipcError.ts` — decode and preserve the optional machine-readable IPC reason.
- Modify: `src/storage/types.ts` — add the optional IPC reason to the frontend wire type.
- Modify: `src/i18n/locales/en.ts` — add mode and runtime identity labels plus the corner-close accessible label if a shared label is not sufficient.
- Modify: `src/i18n/locales/zh-CN.ts` — mirror the new English keys.
- Create: `src/routes/-settingsImportWorkflow.ts` — expose the route-level applied-only post-import workflow.
- Create: `src/routes/-settingsImportWorkflow.test.ts` — verify invalidation and other post-import effects for each route outcome.
- Modify: `src/routes/settings.tsx` — delegate `onApplied` handling to the route workflow seam.
- Modify: `src/features/settings/importAcceptance.ts` — keep invalidation keys only; remove route orchestration that moves to the route seam if no longer used.
- Modify: `src/features/settings/importAcceptance.test.ts` — keep key-list and auth-warning tests; remove the direct invalidation test superseded by the route workflow test.

### Backend and acceptance

- Modify: `src-tauri/src/error.rs` — define typed import-preview conflict reasons and serialize them as optional IPC `reason` values.
- Modify: `src-tauri/src/services/import_export.rs` — emit typed stale/expired conflicts at claim and CAS points.
- Modify: `src-tauri/src/services/tests.rs` — expand normalization, round-trip, no-execution, and conflict acceptance tests.
- Create: `src-tauri/src/services/execution_dispatch_probe.rs` — test-only scoped recorder for actual Wasm guest, native worker, migration, and network dispatch boundaries.
- Modify: `src-tauri/src/services/mod.rs` — register the probe only under `cfg(test)`.
- Modify: `src-tauri/src/services/wasm_runtime/executor.rs` — record Wasm guest and migration dispatch immediately before actual execution.
- Modify: `src-tauri/src/services/wasm_runtime/tests.rs` — calibrate the probe against one real Wasm guest dispatch.
- Modify: `src-tauri/src/services/native_workers/mod.rs` — record and calibrate native worker dispatch immediately before `spawn_exact`.
- Modify: `src-tauri/src/services/network_broker.rs` — record network dispatch immediately before the raw transport call.
- Modify: `src-tauri/src/services/runtime_lifecycle.rs` — record guest/native migration dispatch before lifecycle migration execution.
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v2-config.json` — add a linked legacy provider/model/flat-profile graph.
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v3-config.json` — add the same linked flat-profile graph.
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v4-config.json` — add the linked engine-profile graph and a legacy integration that normalizes to an explicit bundled runtime.
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v5-config.json` — preserve the graph and explicit normalized integration semantics while retaining v5 OCR shape.
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v6-config.json` — preserve the graph and integration semantics with v6 Speech arrays.
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v7-config.json` — preserve the graph with singular provider runtime and explicit integration runtime requirements.
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v8-mixed.json` — preserve the graph, use adapter-keyed provider requirements, and include both Wasm and trusted-native-worker integration requirements.

## Seams

- **Seam:** `IpcError` JSON envelope → `decodeIpcRejection` → `applyPreparedConfigurationImport` — verifies typed `reason` transport and exact stale/expired mapping without message inspection.
- **Seam:** `ConfigurationImportPreviewState` transition functions — verifies that apply starts before IPC, only a valid prepared preview can apply, and failures are accepted from `applying`.
- **Seam:** rendered `ConfigurationImportPreviewDialog` roles and user actions — verifies accessible naming, persistent close control, one in-flight apply, retryable errors, and complete confirmation content.
- **Seam:** `importPreviewPresentation` exported helpers — verifies exact mode/runtime labels and untruncated identity values independently of JSX layout.
- **Seam:** `runSettingsImportWorkflow` in `src/routes/-settingsImportWorkflow.ts` — verifies that only `applied` triggers settings rebind, every invalidation once, and success notification.
- **Seam:** `parse_and_normalize_export_document` with committed v2-v8 fixtures — verifies normalized graph and runtime semantics through the public domain parser.
- **Seam:** `ImportExportService::preview_with_session` and `ImportExportService::import_by_preview_id` with `ExecutionDispatchProbe` — verifies exact installed requirements stay inactive and start no runtime, migration, or network dispatch.

## Tasks

### Task 1: Add Typed Import Conflict Reasons

**Seam:** `IpcError` JSON envelope → `decodeIpcRejection` → `applyPreparedConfigurationImport`.

**Outcome:** Rust emits `reason: "stale" | "expired"` for import-preview conflicts. The frontend maps that field directly and never reads message prose to derive domain state.

**Files:**

- Modify: `src-tauri/src/error.rs`
- Modify: `src-tauri/src/services/import_export.rs`
- Modify: `src-tauri/src/services/tests.rs`
- Modify: `src/storage/ipcError.ts`
- Modify: `src/storage/types.ts`
- Modify: `src/features/settings/configurationTransfer.ts`
- Modify: `src/features/settings/configurationTransfer.test.ts`

**Steps:**

- [ ] **Red:** In `configurationTransfer.test.ts`, reject `import_configuration` with `{ code: "conflict", reason: "expired", message: "wording without the old keyword" }` and expect `conflictKind === "expired"`; add the equivalent stale case with arbitrary prose.
- [ ] **Red:** Add a decoder test that an optional string `reason` survives `decodeIpcRejection`, while errors without a reason remain valid.
- [ ] **Green:** Add `reason?: string` to the frontend `IpcError` class and wire interface, and preserve it in `decodeIpcRejection`.
- [ ] **Green:** Replace `error.message.includes("expired")` in `applyPreparedConfigurationImport` with an exact closed check of `error.reason`; accept only `expired` and `stale` for the conflict result and treat an absent/unknown reason as `stale` for backward compatibility.
- [ ] **Red:** In Rust tests, expect preview-session expiry to convert to IPC `{ code: "conflict", reason: Some("expired") }`, and unknown/reused/already-claimed/CAS mismatch to convert to `reason: Some("stale")`.
- [ ] **Green:** Add a serializable `ImportPreviewConflictReason` enum in `error.rs` and a dedicated `StorageError::ImportPreviewConflict { reason, message }` variant. Map it to `IpcError { code: "conflict", reason: Some(...), message }`; keep generic `StorageError::Conflict` reasonless for unrelated domains.
- [ ] **Green:** Replace preview-session claim and CAS `StorageError::Conflict` construction sites in `import_export.rs` with the typed variant. Do not infer the reason from the message in Rust.
- [ ] Update existing `IpcError::new` construction and equality fixtures to default `reason` to `None` without changing unrelated wire codes.

**Validation:**

- Run (red): `bun test src/features/settings/configurationTransfer.test.ts`
- Expected: the expired case reports `stale` because the current code parses prose.
- Run (green): `bun test src/features/settings/configurationTransfer.test.ts`
- Expected: all transfer and decoder cases pass.
- Run (red): `mise run test import_preview_session_cas_claim_reports_expired_not_unknown`
- Expected: the new typed-reason assertion fails because the current error envelope has no reason.
- Run (green): `mise run test import_preview_session_cas_claim_reports_expired_not_unknown`
- Expected: the typed expired and stale mappings pass.

### Task 2: Enter Applying Before IPC

**Seam:** `ConfigurationImportPreviewState` transitions and rendered dialog apply action.

**Outcome:** The first valid Apply action immediately makes the state `applying`, disables/removes Apply before IPC completes, permits no duplicate request, and routes non-conflict rejection to the visible error phase.

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Create: `src/test/registerDom.ts`
- Create: `src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Modify: `src/features/settings/ConfigurationImportPreviewDialog.tsx`
- Modify: `src/features/settings/configurationImportPreviewState.ts`
- Modify: `src/features/settings/configurationImportPreviewState.test.ts`

**Steps:**

- [ ] Add the component-test stack with `bun add --dev @happy-dom/global-registrator @testing-library/react @testing-library/user-event`; import `src/test/registerDom.ts` before rendering and reset the document plus mocks after each test.
- [ ] **Red:** Mock the Promise façades at the module boundary, render the controlled dialog, complete a valid preview, double-click Apply while the mocked apply Promise is deferred, and expect one `import_configuration` runner call plus visible `Applying…` state.
- [ ] **Red:** Reject the deferred apply Promise with a non-conflict IPC error and expect the dialog to render the mapped error and the Re-preview action.
- [ ] **Green:** In `handleApply`, derive `applying = startImportApply(state)`, return unless it reached `applying`, call `setState(applying)` before `await runApplyPreparedConfigurationImport(previewId)`, and pass the result to `finishImportApply(applying, result)`.
- [ ] **Green:** Keep the catch path as `setState((current) => failImportPreview(current, message))`; it now accepts the error because the current phase is already `applying`.
- [ ] **Green:** Remove `transitionImportApply` from `configurationImportPreviewState.ts`, its dialog import, and tests. Keep `startImportApply` and `finishImportApply` as the only public apply transitions.
- [ ] **Red/Green:** Replace the old stale-closure regression tests with a sequence that asserts `previewed → applying` before any terminal result, `canApplyImportPreview(applying) === false`, and `applying → applied | not_applied | conflict | error`.
- [ ] Keep `previewId` captured from the prepared preview before replacing the phase. Do not store the configuration document or mode in the apply payload.

**Validation:**

- Run (red): `bun test src/features/settings/ConfigurationImportPreviewDialog.test.tsx src/features/settings/configurationImportPreviewState.test.ts`
- Expected: duplicate Apply calls occur or the applying/error expectations fail.
- Run (green): `bun test src/features/settings/ConfigurationImportPreviewDialog.test.tsx src/features/settings/configurationImportPreviewState.test.ts`
- Expected: one apply call, immediate applying UI, disabled apply eligibility, and visible non-conflict error.

### Task 3: Fix Dialog Accessibility and Retry Structure

**Seam:** rendered `ConfigurationImportPreviewDialog` roles and accessible names.

**Outcome:** The conflict-mode radiogroup has the visible legend as its accessible name, every phase has a visible corner close button, and conflict/error phases share one retryable body.

**Files:**

- Modify: `src/features/settings/ConfigurationImportPreviewDialog.tsx`
- Modify: `src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh-CN.ts`

**Steps:**

- [ ] **Red:** Render idle phase and expect `getByRole("radiogroup", { name: t("settings.backup.importConflictMode") })` to succeed.
- [ ] **Green:** Replace the nested `<Fieldset.Root><Fieldset.Legend/><RadioGroup/></Fieldset.Root>` with documented composition: `<Fieldset.Root render={<RadioGroup ... />}>`, followed by `<Fieldset.Legend>` and the two labeled radio options. Preserve the controlled mode and current classes through merged `render` props.
- [ ] **Red:** Drive the component through idle, loading, previewed, applying, conflict, and error phases and expect one visible corner button named Close in every phase.
- [ ] **Green:** Add one `Dialog.Close` as the first persistent child of `Dialog.Popup`, position it in the top-right corner, use `~icons/material-symbols-light/close`, apply the existing icon-button visual classes, and give it an i18n-backed accessible name. Keep it outside all phase branches.
- [ ] The close button must remain enabled while busy because Base UI requires a usable escape affordance for modal touch-screen readers. Document in the test that closing does not cancel an already-started host operation.
- [ ] **Red:** Drive conflict and non-conflict error outcomes and verify both expose the same Cancel and Re-preview action labels with their phase-specific alert text.
- [ ] **Green:** Extract `RetryableErrorBody({ message, onRetry, onCancel })`; use it for both conflict and error phases. Keep `InvalidPreviewBody` separate because it also renders validation details.
- [ ] Retain existing phase-specific footer buttons where they express workflow actions; the new corner close control is the always-available dialog affordance.

**Validation:**

- Run (red): `bun test src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Expected: the radiogroup has no accessible name and loading/applying have no close button.
- Run (green): `bun test src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Expected: accessible group naming, persistent close control, and shared retry behavior pass.

### Task 4: Show Complete Confirmation Data

**Seam:** `importPreviewPresentation` helpers and rendered preview content.

**Outcome:** The confirmation shows Merge/Copy mode, all non-zero graph counts, and full runtime adapter/plugin/version/package/publisher/status/action values with exact labels.

**Files:**

- Modify: `src/features/settings/importPreviewPresentation.ts`
- Modify: `src/features/settings/importPreviewPresentation.test.ts`
- Modify: `src/features/settings/ConfigurationImportPreviewDialog.tsx`
- Modify: `src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh-CN.ts`

**Steps:**

- [ ] **Red:** Add helper tests for `merge` and `copy` mode label keys and for a package-backed runtime entry containing adapter ID, runtime kind, plugin ID, plugin version, full package digest, publisher key ID, full publisher fingerprint, local status, and required action.
- [ ] **Green:** Add a small exported mode-label helper and an exported runtime-detail row helper. Return stable i18n label keys and exact raw values; do not truncate or recompute identifiers.
- [ ] **Red:** Render a prepared Copy preview based on the `v8-mixed.json` contract values and expect the visible mode, graph counts, `pluginId`, `pluginVersion`, `publisherKeyId`, full fingerprint, full digest, status, and required action.
- [ ] **Green:** Add a labeled Mode row before the changes section. Render each runtime requirement as a compact definition list or labeled row set. Include adapter only when present and include every package/publisher field supplied by the DTO.
- [ ] Remove `PACKAGE_DIGEST_PREFIX_LENGTH` and `PACKAGE_DIGEST_SUFFIX_LENGTH`. Render full digest and fingerprint with `font-mono` and `wrap-break-word`; do not rely on `title` for contract data.
- [ ] Add concise English and Chinese labels for Mode, Adapter, Runtime, Plugin ID, Version, Package digest, Publisher key ID, Publisher fingerprint, Status, and Required action.
- [ ] Preserve grouping by required action and the inactive-runtime security note. Avoid duplicate prose by letting the group heading state the action while the labeled detail row still exposes the exact action value for the fixture contract.

**Validation:**

- Run (red): `bun test src/features/settings/importPreviewPresentation.test.ts src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Expected: mode and exact identity assertions fail; the digest is truncated and several fields are absent.
- Run (green): `bun test src/features/settings/importPreviewPresentation.test.ts src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Expected: all mode, count, identity, status, and action assertions pass with full values.

### Task 5: Add the Route Import Workflow Seam

**Seam:** `runSettingsImportWorkflow`.

**Outcome:** An applied result triggers app-settings rebind, every configured invalidation exactly once, and success notification. Cancelled, invalid, and not-applied outcomes trigger none of those effects.

**Files:**

- Create: `src/routes/-settingsImportWorkflow.ts`
- Create: `src/routes/-settingsImportWorkflow.test.ts`
- Modify: `src/routes/settings.tsx`
- Modify: `src/features/settings/importAcceptance.ts`
- Modify: `src/features/settings/importAcceptance.test.ts`

**Steps:**

- [ ] **Red:** Define test scenarios for `{ status: "applied", result }`, `{ status: "cancelled" }`, `{ status: "invalid" }`, and `{ status: "not_applied" }`. Through one route workflow function, assert that applied calls `applyImportedAppSettings` once, calls `invalidateQueries` once for each `IMPORT_INVALIDATION_KEYS` entry, and calls the supplied success notifier once; all other outcomes call none.
- [ ] **Green:** Create the route-prefixed non-route module with an explicit `SettingsImportWorkflowOutcome` union and injected dependencies for settings rebind, QueryClient, and notification. Return early unless `status === "applied"`.
- [ ] **Green:** Move the applied-only sequence from `BackupSettingsSection.handleImported` into `runSettingsImportWorkflow`: await settings rebind, invalidate all keys, derive the auth warning, then notify.
- [ ] **Green:** In `settings.tsx`, adapt `ConfigurationImportPreviewDialog.onApplied` to call the seam with `{ status: "applied", result }` and route-owned real dependencies.
- [ ] Keep `invalidateAfterConfigurationImport` as a small reusable helper only if the route seam calls it. Remove its direct “applied import” test because it does not exercise route gating; retain the exact key-list test.
- [ ] Do not invalidate on dialog cancellation, invalid preview, apply conflict, generic error, or `applied: false`.

**Validation:**

- Run (red): `bun test src/routes/-settingsImportWorkflow.test.ts`
- Expected: the module is absent or negative outcomes are not gated.
- Run (green): `bun test src/routes/-settingsImportWorkflow.test.ts src/features/settings/importAcceptance.test.ts`
- Expected: applied invalidates each domain once; cancelled, invalid, and not-applied produce zero route effects.

### Task 6: Make v2-v8 Fixtures Semantic

**Seam:** `parse_and_normalize_export_document` with committed fixtures.

**Outcome:** Every historical fixture contains linked provider, model, and profile data. Each normalizes to v8 with preserved graph IDs/relations, explicit integration runtime requirements when integrations exist, and adapter-keyed provider requirements.

**Files:**

- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v2-config.json`
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v3-config.json`
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v4-config.json`
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v5-config.json`
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v6-config.json`
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v7-config.json`
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v8-mixed.json`
- Modify: `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] **Red:** Expand `import_format_fixtures_v2_through_v8_normalize_to_current` to assert one stable provider ID, one model linked to that provider, one profile, one target linked to the model, one prompt template used as the profile default, and preserved key semantic values after normalization for every version.
- [ ] **Red:** Assert that versions with integrations normalize each integration to `runtime.is_some()`, v7 singular provider runtime becomes one v8 binding keyed by the provider default adapter, and v8 preserves both distinct adapter keys.
- [ ] **Green:** Populate v2 and v3 with the valid flat `TranslationProfileV3` shape and a linked provider/model/target/template graph. Use fixed UUIDs and known literal values so expectations do not derive from implementation logic.
- [ ] **Green:** Populate v4-v8 with the equivalent engine-tagged LLM profile shape. Keep the same IDs and relation edges across versions.
- [ ] **Green:** Add a bundled integration from v4 onward. Omit its runtime only where the historical schema requires normalization to synthesize `bundled-rust`; make it explicit in v7-v8.
- [ ] **Green:** Keep the historical provider runtime shape version-correct: no runtime requirement in early fixtures, singular `runtime` in v7, and ordered `runtimeBindings` with the default adapter present in v8.
- [ ] **Green:** Preserve version-specific arrays: OCR from v5, Speech from v6, explicit integration runtime records from v7, adapter-keyed provider requirements from v8.
- [ ] Update the v8 round-trip count assertions to account for the graph rows while still verifying Copy ID rewriting and exact runtime identity preservation.

**Validation:**

- Run (red): `mise run test import_format_fixtures_v2_through_v8_normalize_to_current`
- Expected: graph-content assertions fail for the current empty v2-v5 fixtures.
- Run (green): `mise run test import_format_fixtures_v2_through_v8_normalize_to_current`
- Expected: every version normalizes to v8 with the linked graph and required runtime semantics intact.
- Run (green): `mise run test runtime_plugin_import_fixture_v8_round_trip_preserves_runtime_semantics`
- Expected: Copy round-trip preserves graph relations and exact runtime identities after ID rewriting.

### Task 7: Prove Import Starts No Execution

**Seam:** `ImportExportService::preview_with_session` and `ImportExportService::import_by_preview_id` observed at actual runtime dispatch boundaries.

**Outcome:** Preview and apply accept exact installed Wasm and trusted-native-worker requirements, persist both inactive, and produce zero Wasm guest, native worker, migration, and network dispatch events.

**Files:**

- Create: `src-tauri/src/services/execution_dispatch_probe.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/wasm_runtime/executor.rs`
- Modify: `src-tauri/src/services/wasm_runtime/tests.rs`
- Modify: `src-tauri/src/services/native_workers/mod.rs`
- Modify: `src-tauri/src/services/network_broker.rs`
- Modify: `src-tauri/src/services/runtime_lifecycle.rs`
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v8-mixed.json`
- Modify: `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] **Red:** Extend `v8-mixed.json` with an explicit trusted-native-worker integration requirement that has a distinct exact digest, plugin/version, publisher key ID/fingerprint, plugin API version, config schema version, and OCR capability major.
- [ ] **Red:** Expand the no-execution acceptance test to install exact matching catalog rows for both the Wasm and trusted-native-worker fixture requirements, then expect both preview entries to report `installed` plus `activate_after_import`.
- [ ] **Red:** Add assertions that both imported integration rows persist `runtime_state == "unavailable"` with no execution grant revision, while provider package bindings remain unavailable.
- [ ] **Red:** Reference a scoped `ExecutionDispatchProbe` from the import acceptance test, run both preview and apply, and expect zero counts for `WasmGuest`, `NativeWorker`, `Migration`, and `Network`. The test initially fails to compile because the observation seam does not exist.
- [ ] **Green:** Add a `cfg(test)` probe module with a scoped guard, a closed `ExecutionDispatchKind` enum, independent counters, reset/snapshot methods, and a serialization lock so parallel Rust tests cannot contaminate the measurement. Do not compile a mutable probe or mock behavior into production builds.
- [ ] **Red/Green calibration:** Add tests named `execution_dispatch_probe_records_wasm_guest`, `execution_dispatch_probe_records_native_worker`, `execution_dispatch_probe_records_migration`, and `execution_dispatch_probe_records_network`. Reuse an existing known-good Wasm guest fixture, native conformance helper, lifecycle migration fixture, and capture-transport broker request. Expect the corresponding category to increment exactly once. These calibration assertions prevent a disconnected always-zero probe from satisfying the import acceptance test.
- [ ] **Green:** Record `WasmGuest` immediately before Wasmtime guest invocation, `NativeWorker` immediately before `spawn_exact`, `Migration` immediately before lifecycle/Wasm migration execution, and `Network` immediately before the raw HTTP transport call. Recording must not alter control flow or payloads.
- [ ] **Green:** Keep the existing database assertions for zero grants, install operations, and rollback snapshots. Add zero migration-journal or equivalent persisted migration artifacts if the schema has one; otherwise rely on the real dispatch probe for migration.
- [ ] **Green:** Update v8 fixture and round-trip expectations from two integrations/four requirements to three integrations/five requirements: two provider bindings plus bundled, Wasm, and trusted-native-worker integrations.
- [ ] Verify that the test observes both `preview_with_session` and `import_by_preview_id`; no runtime resolve, package install, publisher trust, migration, worker spawn, guest invocation, or network request may occur in either operation.

**Validation:**

- Run (red): `mise run test runtime_plugin_import_no_execution_installed_requirement_stays_inactive`
- Expected: native-worker and dispatch-count assertions fail because the fixture and observation seam are absent.
- Run (green calibration): `mise run test execution_dispatch_probe_records`
- Expected: the focused Wasm, native worker, migration, and network calibration tests each observe their real dispatch boundary exactly once.
- Run (green): `mise run test runtime_plugin_import_no_execution_installed_requirement_stays_inactive`
- Expected: exact Wasm and native requirements are installed but inactive, and all four calibrated dispatch counters remain zero for preview and apply.
- Run (green): `mise run test runtime_plugin_import_fixture_v8_round_trip_preserves_runtime_semantics`
- Expected: the expanded mixed fixture round-trips with all exact requirements preserved.

## Final Validation

Run in this order:

1. `bun test src/features/settings/configurationTransfer.test.ts src/features/settings/configurationImportPreviewState.test.ts src/features/settings/importPreviewPresentation.test.ts src/features/settings/ConfigurationImportPreviewDialog.test.tsx src/features/settings/importAcceptance.test.ts src/routes/-settingsImportWorkflow.test.ts`
   - Expected: all focused frontend import tests pass.
2. `mise run test import_preview_session_cas`
   - Expected: all preview-session claim, stale, expiry, reuse, and concurrency tests pass with typed reasons.
3. `mise run test import_format_fixtures_v2_through_v8_normalize_to_current`
   - Expected: every committed fixture normalizes with preserved graph and runtime semantics.
4. `mise run test runtime_plugin_import_fixture_v8_round_trip_preserves_runtime_semantics`
   - Expected: Copy round-trip preserves the expanded mixed fixture contract.
5. `mise run test runtime_plugin_import_no_execution_installed_requirement_stays_inactive`
   - Expected: exact installed Wasm and trusted-native-worker imports stay inactive and all dispatch counters are zero.
6. `bun test`
   - Expected: the complete frontend test suite passes.
7. `mise run test`
   - Expected: the complete Rust test suite passes without probe cross-test contamination.
8. `mise run typecheck`
   - Expected: TypeScript reports no errors.
9. `mise run lint`
   - Expected: ESLint and oxlint pass.
10. `mise run format:check`
    - Expected: oxfmt and `cargo fmt` checks pass.
11. `mise run build`
    - Expected: the production frontend builds successfully.

## Failure Behavior

- Invalid or missing preview ID: apply remains unavailable.
- Duplicate Apply action: only the first action starts IPC; the dialog immediately enters `applying`.
- Non-conflict apply failure: the dialog enters `error`, shows the safe user message, and offers Cancel and Re-preview.
- Expired preview: the backend returns `code: "conflict", reason: "expired"`; the dialog shows the expiry copy.
- Unknown, reused, already-claimed, or CAS-stale preview: the backend returns `code: "conflict", reason: "stale"`; the dialog requires re-preview.
- Dialog close during loading/applying: the dialog closes without pretending to cancel the host operation. If apply later succeeds, the route workflow still rebinds settings and invalidates caches once.
- `applied: false`, cancelled file selection, invalid preview, conflict, or error: the route workflow performs no rebind, invalidation, or success notification.
- Missing, revoked, disabled, unavailable, or incompatible runtime package: data import remains valid, but runtime state stays inactive and the UI shows the required follow-up action.

## Privacy and Security

- Continue to send only `previewId` during apply. Do not retain or resend the imported document from React state.
- Display only sanitized runtime identifiers already present in `ImportRuntimeRequirementPreview`. Never display credentials, credential references, package bytes, filesystem paths, grants, or configuration payloads.
- Full package digests and publisher fingerprints are integrity identifiers, not secrets. Render them as text with wrapping and no logging.
- The dispatch probe is test-only and records event categories only. It must not record user content, URLs, headers, config JSON, file paths, package bytes, or identifiers.
- Import must not install packages, trust publishers, create execution grants, activate runtimes, run migrations, start Wasm/native code, or dispatch network requests.

## Rollout Notes

- No database migration or export-format version bump is required. The IPC error envelope adds an optional field and remains backward compatible.
- The frontend fallback of unknown/missing conflict reason to `stale` supports an older backend during development, while current Rust always emits a typed import reason.
- The new test dependencies affect development only. Production bundles must not include Happy DOM, Testing Library, or the Rust dispatch probe.

## Risks and Mitigations

- **Base UI `render` composition can lose props if wrapped incorrectly.** Use `Fieldset.Root render={<RadioGroup />}>` exactly as documented and verify the rendered radiogroup name and keyboard role.
- **A stale React closure could still permit re-entry.** Enter `applying` before awaiting and verify with a deferred Promise plus a double user click at the rendered component seam.
- **Optional IPC reason can be dropped by a decoder.** Test the raw object-to-`IpcError` decoder separately from transfer mapping.
- **Historical fixtures can become self-consistent but semantically weak.** Use fixed literal IDs and assert every relation and key semantic value after normalization.
- **Global test observation can become flaky under parallel tests.** Make the dispatch probe scoped and serialized, reset before the operation, and remove it on guard drop.
- **Instrumentation can accidentally affect production.** Compile the probe and recording calls only under `cfg(test)` and keep production dispatch logic unchanged.
- **Full identifiers can widen the dialog.** Use `wrap-break-word`, a definition-list layout, and the existing scroll limit; never reintroduce truncation for required contract fields.

## Open Questions

**Open Questions:** None.
