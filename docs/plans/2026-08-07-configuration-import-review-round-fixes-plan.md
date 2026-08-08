# Implementation Plan

**Goal:** Fix all four remaining configuration-import review findings so the preview presents complete validation and credential information, the no-execution probe observes cross-thread dispatches under a serialization lock, and DOM setup stays local to the focused component tests.

**Inputs:** The provided Standards review (`None`), the four Spec findings, `docs/plans/runtime-plugin-system/phase-11-import-export-recovery.md`, `docs/plans/2026-08-07-configuration-import-review-fixes-plan.md`, and the current repository implementation.

**Assumptions:**

- The backend already bounds `ImportPreview.validationErrors`. The dialog must render every error delivered in that DTO and must not add a second frontend limit.
- Credential warning categories use the existing `ImportAuthenticationCategory` values: `providers`, `integrations`, `ocr`, and `proxy`.
- The existing `scope()`, `record()`, `snapshot()`, and `assert_zero()` probe API remains stable. Only its test-only storage and guard semantics change.
- The review requirements fix the seams below. No product decision remains before implementation.

**Architecture:** Keep presentation derivation in `importPreviewPresentation.ts` and verify the final user output through the rendered dialog. Replace the thread-keyed dispatch counters with one serialized, process-wide test measurement so dispatches from runtime worker threads reach the active scope. Remove the global Bun preload and let the one DOM component-test module register and clean up its own environment.

**Tech Stack:** React 19, Base UI 1.6, i18next, Bun test, Testing Library, Happy DOM, Tauri 2, Rust 1.96.

---

## Finding Coverage

1. **Validation errors are truncated:** Task 1 renders every `validationErrors` entry and removes the overflow summary.
2. **Credential warning categories are inaccurate:** Task 2 renders only the categories reported by `importAuthenticationCategories`, including proxy-only previews.
3. **Dispatch observation is not serialized or cross-thread:** Task 3 adds a process-wide serialization guard and cross-thread counting, then retains the real import acceptance assertion.
4. **DOM setup is globally preloaded:** Task 4 deletes `bunfig.toml`, imports DOM and matcher setup only in the dialog test, and resets the DOM and mocks after each test.

**Out of scope:** None. Every remaining finding is in scope. No Standards fixes are required because that review axis has no findings.

## File Map

- Modify: `src/features/settings/ConfigurationImportPreviewDialog.tsx` — render all delivered validation errors and category-accurate credential warnings.
- Modify: `src/features/settings/ConfigurationImportPreviewDialog.test.tsx` — verify complete validation output, exact credential categories, and local DOM/mock lifecycle.
- Modify: `src/features/settings/importPreviewPresentation.ts` — map authentication categories to stable i18n label keys.
- Modify: `src/features/settings/importPreviewPresentation.test.ts` — verify all category values and their presentation keys, including proxy-only input.
- Modify: `src/i18n/locales/en.ts` — add generic warning lead-in and English category labels; remove obsolete overflow copy if it has no remaining references.
- Modify: `src/i18n/locales/zh-CN.ts` — mirror the credential warning keys and obsolete-key removal.
- Modify: `src-tauri/src/services/execution_dispatch_probe.rs` — serialize probe scopes, count events from any thread in the active scope, and add probe contract tests.
- Modify: `src-tauri/src/services/tests.rs` — keep the no-execution acceptance test bound to the serialized probe and make the scope intent explicit.
- Modify: `src/test/registerDom.ts` — keep explicit registration and document-only reset behavior for focused tests.
- Modify: `src/test/jestDom.ts` — keep matcher registration as an explicitly imported focused-test module.
- Delete: `bunfig.toml` — remove suite-wide Happy DOM and jest-dom preloads.

## Seams

- **Seam:** rendered `ConfigurationImportPreviewDialog` roles and visible text — verifies that invalid previews expose every delivered validation error.
- **Seam:** `importAuthenticationCategories` plus rendered `ConfigurationImportPreviewDialog` warning content — verifies exact provider, integration, OCR, and proxy credential categories without unrelated claims.
- **Seam:** `execution_dispatch_probe::{scope, record, snapshot, assert_zero}` as used by `ImportExportService::preview_with_session` and `ImportExportService::import_by_preview_id` — verifies serialized measurement and observation of dispatches from non-arming threads.
- **Seam:** `ConfigurationImportPreviewDialog.test.tsx` as an independently executable Bun test module — verifies that focused DOM tests initialize and clean up their own environment without global suite preload.

## Tasks

### Task 1: Present Every Validation Error

**Seam:** rendered `ConfigurationImportPreviewDialog` roles and visible text.

**Outcome:** An invalid import preview displays every bounded validation error received from the host. It does not replace later errors with an overflow count.

**Files:**

- Modify: `src/features/settings/ConfigurationImportPreviewDialog.tsx`
- Modify: `src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh-CN.ts`

**Steps:**

- [ ] **Red:** Add a rendered-dialog scenario whose invalid preview contains more than eight distinct literal validation errors. Assert that the first, ninth, and final errors are visible and that no “more errors” summary is rendered.
- [ ] **Green:** In `InvalidPreviewBody`, map over the complete `state.phase.preview.validationErrors` array.
- [ ] **Green:** Remove `MAX_PREVIEW_ERRORS_SHOWN`, `errors.slice(...)`, and the `settings.backup.importMoreErrors` overflow branch from `ConfigurationImportPreviewDialog.tsx`.
- [ ] Remove `settings.backup.importMoreErrors` from both locale files only if repository references confirm that the dialog was its last consumer.
- [ ] Keep each error as wrapped text in the existing scrollable dialog. Do not alter, combine, deduplicate, or log host-provided validation messages.

**Validation:**

- Run (red): `bun test src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Expected: the assertion for the ninth or final error fails because the current dialog renders only eight entries.
- Run (green): `bun test src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Expected: every supplied error is visible and no overflow summary appears.

### Task 2: Render Exact Credential Categories

**Seam:** `importAuthenticationCategories` plus rendered `ConfigurationImportPreviewDialog` warning content.

**Outcome:** The warning names exactly the authentication categories reported by the preview. A proxy-only preview says that proxy credentials require re-entry and does not mention channels, integrations, or OCR services.

**Files:**

- Modify: `src/features/settings/importPreviewPresentation.ts`
- Modify: `src/features/settings/importPreviewPresentation.test.ts`
- Modify: `src/features/settings/ConfigurationImportPreviewDialog.tsx`
- Modify: `src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh-CN.ts`

**Steps:**

- [ ] **Red:** Extend the pure presentation test with fixed expected label keys for all four `ImportAuthenticationCategory` values. Include a proxy-only preview and expect only the proxy category.
- [ ] **Green:** Add `importAuthenticationCategoryLabelKey(category)` or an equivalent closed constant map in `importPreviewPresentation.ts`. Map `providers`, `integrations`, `ocr`, and `proxy` to stable locale keys.
- [ ] **Red:** Render a proxy-only prepared preview. Assert that the credential warning includes the generic re-entry lead-in and `Proxy`, and excludes `Channels`, `Integrations`, and `OCR services`.
- [ ] **Red:** Render a mixed prepared preview with all four categories. Assert that each category label appears once.
- [ ] **Green:** Replace the hard-coded `previewAuthNote` sentence in `PreviewBody` with a generic warning lead-in and a list built from `authCategories`. Use the category-label helper for each list item.
- [ ] **Green:** Add concise English and Chinese keys for the lead-in and the four category labels. Do not infer categories from count fields or runtime requirements in JSX.
- [ ] Keep the warning informational. It must not expose credential values, references, or provider configuration.

**Validation:**

- Run (red): `bun test src/features/settings/importPreviewPresentation.test.ts src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Expected: the helper has no category label mapping, and the proxy-only dialog still displays the inaccurate fixed sentence.
- Run (green): same command.
- Expected: pure category mapping and rendered proxy-only/mixed warning scenarios pass.

### Task 3: Serialize and Globalize Dispatch Measurement

**Seam:** `execution_dispatch_probe::{scope, record, snapshot, assert_zero}` as used around import preview and apply.

**Outcome:** Only one dispatch measurement scope can be active at a time, and every instrumented dispatch during that scope is counted even when it occurs on a spawned runtime thread. The import no-execution acceptance test can therefore trust a zero snapshot.

**Files:**

- Modify: `src-tauri/src/services/execution_dispatch_probe.rs`
- Modify: `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] **Red:** Add `execution_dispatch_probe_records_spawned_thread` in `execution_dispatch_probe.rs`. Arm `scope()`, call `record(ExecutionDispatchKind::WasmGuest)` from a joined `std::thread::spawn`, and expect `snapshot().wasm_guest == 1`.
- [ ] **Green:** Replace the `HashMap<ThreadId, ExecutionDispatchCounts>` with one active measurement shared by all threads. Keep the state under `Mutex`/`OnceLock` and keep the module under `cfg(test)`.
- [ ] **Green:** Make `record` increment the sole active measurement regardless of the calling thread. Preserve no-op behavior when no scope is active.
- [ ] **Red:** Add `execution_dispatch_probe_serializes_scopes`. Hold one guard, start another thread that calls `scope()`, and use channels/barriers to prove the second call cannot complete until the first guard drops. Do not use timing-only assertions.
- [ ] **Green:** Add a separate process-wide serialization mutex. Store its guard inside `ExecutionDispatchProbeGuard` for the full measurement lifetime. Initialize/reset the active counts only after this lock is acquired; clear the active measurement before releasing it on drop.
- [ ] **Green:** Keep `ExecutionDispatchProbeGuard` non-`Send`. Permit dispatch recording from other threads, but require scope ownership and snapshot access to remain on the arming test thread.
- [ ] **Green:** Preserve poison recovery for both mutexes. Prevent nested `scope()` calls from silently replacing an active measurement; they must block on the serialization lock rather than reset counts.
- [ ] In `runtime_plugin_import_no_execution_installed_requirement_stays_inactive`, bind the guard as `probe`, retain one serialized scope across both `preview_with_session` and `import_by_preview_id`, and call `assert_zero()` after each operation.
- [ ] Retain the existing real dispatch-boundary instrumentation and calibration tests for Wasm guest, native worker, migration, and network categories. Do not add production flags, mock execution paths, payload recording, or changes to runtime control flow.

**Validation:**

- Run (red): `mise run test execution_dispatch_probe_records_spawned_thread`
- Expected: the count remains zero because the current `record` looks up only the spawned thread ID.
- Run (green): `mise run test execution_dispatch_probe_records_spawned_thread`
- Expected: the spawned-thread event increments the active scope exactly once.
- Run (red): `mise run test execution_dispatch_probe_serializes_scopes`
- Expected: the new serialization contract fails because the current guard holds no serialization lock.
- Run (green): `mise run test execution_dispatch_probe_serializes_scopes`
- Expected: the second scope starts only after the first guard drops.
- Run (green calibration): `mise run test execution_dispatch_probe_records`
- Expected: existing Wasm guest, native worker, migration, and network calibration tests still count their real boundary once.
- Run (green acceptance): `mise run test runtime_plugin_import_no_execution_installed_requirement_stays_inactive`
- Expected: preview and apply retain exact installed requirements as inactive and report zero dispatches across all four categories.

### Task 4: Localize the DOM Test Harness

**Seam:** `ConfigurationImportPreviewDialog.test.tsx` as an independently executable Bun test module.

**Outcome:** The focused dialog test registers Happy DOM and jest-dom itself, resets rendered state and mocks after each case, and passes without any global Bun test preload. Non-DOM Bun tests no longer inherit browser globals.

**Files:**

- Delete: `bunfig.toml`
- Modify: `src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Modify: `src/test/registerDom.ts`
- Modify: `src/test/jestDom.ts`

**Steps:**

- [ ] **Red:** Remove the `[test] preload` configuration from the test run, then run the dialog test unchanged. Expect matcher or DOM setup to fail if the test still depends on global preload ordering.
- [ ] **Green:** Delete `bunfig.toml`; it exists only to preload `registerDom.ts` and `jestDom.ts` for every Bun test.
- [ ] **Green:** At the top of `ConfigurationImportPreviewDialog.test.tsx`, import `../../test/registerDom` before React rendering utilities, then import `../../test/jestDom` explicitly so the focused module owns both setup steps.
- [ ] **Green:** Update comments in `ConfigurationImportPreviewDialog.test.tsx`, `registerDom.ts`, and `jestDom.ts` to describe explicit focused-test imports. Remove claims that bunfig is the canonical registration path.
- [ ] **Green:** In the dialog test `afterEach`, run Testing Library `cleanup()`, call `resetDom()`, and reset `applyRunnerMock` and `prepareRunnerMock`. Keep per-test default mock implementations in `beforeEach`.
- [ ] Do not add a replacement global preload, global test bootstrap, or DOM setup import to pure presentation/state/transfer tests.

**Validation:**

- Run (red): `bun test src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
- Expected: before the explicit matcher import is added, the focused test fails because jest-dom is no longer globally preloaded.
- Run (green): same command.
- Expected: the focused component suite passes with local DOM and matcher registration.
- Run (green isolation): `bun test src/features/settings/importPreviewPresentation.test.ts src/features/settings/configurationImportPreviewState.test.ts src/features/settings/configurationTransfer.test.ts`
- Expected: pure Bun tests pass without loading the DOM harness.

## Final Validation

Run in this order:

1. `bun test src/features/settings/importPreviewPresentation.test.ts src/features/settings/ConfigurationImportPreviewDialog.test.tsx`
   - Expected: complete error presentation and exact credential-category output pass.
2. `mise run test execution_dispatch_probe_`
   - Expected: cross-thread counting, scope serialization, and all existing calibration tests pass.
3. `mise run test runtime_plugin_import_no_execution_installed_requirement_stays_inactive`
   - Expected: preview and apply produce zero reliable dispatch counts and keep installed runtimes inactive.
4. `bun test`
   - Expected: the complete frontend suite passes without global Happy DOM preload.
5. `mise run test`
   - Expected: the complete Rust suite passes; parallel probe users do not overlap measurements.
6. `mise run typecheck`
   - Expected: TypeScript reports no errors.
7. `mise run lint`
   - Expected: ESLint and oxlint pass.
8. `mise run format:check`
   - Expected: oxfmt and `cargo fmt` checks pass.
9. `mise run build`
   - Expected: the production frontend builds successfully and includes no test harness modules.

## Failure Behavior

- Invalid preview: the dialog remains non-applicable and shows every validation error returned by the bounded host contract.
- No credential categories: the credential warning is absent.
- One or more credential categories: the warning lists only those categories.
- No active dispatch probe: `record` remains a no-op.
- Concurrent probe request: the later `scope()` waits for the active guard to drop; it never resets or shares the first scope's counts.
- Poisoned test mutex: recover the inner state as the current implementation does, then reset a fresh measurement under the serialization guard.

## Privacy and Security

- Validation messages remain rendered text only. Do not log or persist them.
- Credential warnings contain category names only. Never render credential values, credential references, tokens, proxy URLs, or imported configuration payloads.
- The dispatch probe remains `cfg(test)` only and records category counters only. It must not record identifiers, URLs, headers, package data, file paths, or configuration content.
- Import behavior remains unchanged: it must not install code, trust publishers, grant execution authority, activate runtimes, run migrations, spawn workers, invoke Wasm guests, or send network requests.

## Rollout Notes

- No database migration, export-format change, or IPC contract change is required.
- Deleting `bunfig.toml` changes test setup only. Production behavior and dependencies do not change.
- The Rust probe redesign compiles only in test builds.

## Risks and Mitigations

- **Long validation lists can increase dialog height.** Keep the existing bounded DTO and scrollable popup; remove only the second frontend truncation.
- **Category copy can drift from detection logic.** Render directly from the closed `ImportAuthenticationCategory` list and test proxy-only plus all-category fixtures.
- **A global active probe can mix overlapping measurements.** Hold the serialization guard for the complete scope and prove lock ordering with channel/barrier coordination.
- **A cross-thread event can arrive after scope drop.** Join or await all work before snapshot/drop in calibration and acceptance tests; the import operations already complete synchronously before each assertion.
- **Focused component tests can depend on import order.** Import DOM registration and jest-dom explicitly before rendering, then validate by running the file without bunfig.

## Open Questions

**Open Questions:** None.
