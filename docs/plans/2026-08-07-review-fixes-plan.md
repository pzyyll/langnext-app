# Implementation Plan

**Goal:** Correct cross-thread execution dispatch measurement and remove all review-identified speculative, dead, and out-of-scope changes.

**Inputs:** The verbatim Standards and Spec review output supplied for the worktree diff against `d9f9c1f`; repository evidence in the cited implementation, test, locale, task, and acceptance-test files.

**Assumptions:**

- Commit `d9f9c1f` is the required source of truth for the two unrelated PaddleOCR files.
- The supplied review defines the approved seams. No product decision or API design remains open.
- The wrong implementation and missing spawned-thread test are one root cause and one TDD slice, but the coverage table tracks both findings separately.

**Architecture:** Keep the existing process-wide serialized probe scope and its non-`Send` guard. Change the active measurement from thread-owned counts to one shared count set that accepts `record` calls from any thread while the scope is armed. Remove unused frontend API and locale surface without changing dialog behavior, then restore unrelated files to the baseline commit.

**Tech Stack:** Rust 2024, Cargo tests through `mise`, TypeScript, Bun tests, typed i18n catalogs, Git.

---

## Finding Coverage

| Review finding                                                            | Disposition                                                                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Standards: speculative `canRetryImportPreview` export and self-only tests | Task 2 removes the export, import, and assertions. Retry UI behavior remains phase-driven in `ConfigurationImportPreviewDialog`. |
| Standards: orphaned `settings.backup.busyImport` in English and Chinese   | Task 3 removes both catalog entries and verifies catalog type parity.                                                            |
| Spec 1(c): `record` ignores non-owner threads                             | Task 1 changes the sole active measurement to count every calling thread.                                                        |
| Spec 2(a): required spawned-thread coverage is absent                     | Task 1 adds the exact spawned-thread behavior test before the implementation change.                                             |
| Spec 3(b): PaddleOCR CRLF-to-LF churn is unrelated                        | Task 4 restores both files from `d9f9c1f` and proves that their diff is empty.                                                   |

No hard documented-standard violation needs a fix. The review found no Feature Envy, Data Clumps, Repeated Switches, Middle Man, or Message Chains, so the plan makes no changes for those categories. All other accepted work remains out of scope because the review found it consistent with the source plans.

## File Map

- Modify: `src-tauri/src/services/execution_dispatch_probe.rs` — make the active test measurement thread-independent; replace the opposite-contract test with spawned-thread coverage; update ownership comments.
- Modify: `src-tauri/src/services/tests.rs` — update the runtime import acceptance-gate comment to state the cross-thread probe contract.
- Modify: `src/features/settings/configurationImportPreviewState.ts` — remove the unconsumed `canRetryImportPreview` public helper.
- Modify: `src/features/settings/configurationImportPreviewState.test.ts` — remove imports and assertions that only test the deleted helper; retain transition and apply-eligibility coverage.
- Modify: `src/i18n/locales/en.ts` — remove the unreferenced `settings.backup.busyImport` source key.
- Modify: `src/i18n/locales/zh-CN.ts` — remove the matching Chinese key and preserve catalog parity.
- Restore: `runtime-plugins/paddleocr/plugin.json` — restore baseline bytes and line endings from `d9f9c1f`.
- Restore: `runtime-plugins/paddleocr/patches/README.md` — restore baseline bytes and line endings from `d9f9c1f`.
- Test: `src-tauri/src/services/execution_dispatch_probe.rs` — unit coverage for owner-thread recording, spawned-thread recording, scope serialization, and empty snapshots.
- Test: `src-tauri/src/services/tests.rs` — existing public import-service acceptance coverage for zero dispatch during preview and apply.

## Seams

- **Seam:** `execution_dispatch_probe::{scope, record, ExecutionDispatchProbeGuard::snapshot}` — a dispatch recorded by a joined spawned thread increments the sole active scope, while scope serialization and no-scope behavior remain unchanged.
- **Seam:** `configurationImportPreviewState` public exports — the module exposes only state operations consumed by production code; existing phase transitions continue to support dialog retries through `startImportPreviewLoad`.
- **Seam:** typed `en` and `zhCN` locale catalogs — both catalogs omit the orphaned key and retain identical compile-time structure.
- **Seam:** worktree diff against `d9f9c1f` for the two PaddleOCR paths — unrelated files have no content or line-ending delta.

## Tasks

### Task 1: Count Spawned-Thread Dispatches

**Seam:** `execution_dispatch_probe::{scope, record, ExecutionDispatchProbeGuard::snapshot}`

**Outcome:** The serialized active probe counts dispatches from every thread, the required spawned-thread test passes, and the runtime import acceptance comment matches the enforced contract.

**Files:**

- Modify/Test: `src-tauri/src/services/execution_dispatch_probe.rs`
- Modify/Test: `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] **Red:** In `src-tauri/src/services/execution_dispatch_probe.rs`, replace `execution_dispatch_probe_ignores_foreign_thread_dispatches` with `execution_dispatch_probe_records_spawned_thread`. Arm `scope()`, spawn and join a thread that calls `record(ExecutionDispatchKind::WasmGuest)`, then assert `snapshot().wasm_guest == 1` and `snapshot().total() == 1`.
- [ ] Run the focused test before changing `record`. Confirm that it fails because the current `ActiveScope.owner` check leaves `wasm_guest` at `0`.
- [ ] **Green:** Remove `ThreadId` from the imports and remove `owner` from `ActiveScope`. Keep one `ExecutionDispatchCounts` value in the active scope.
- [ ] Update `record` so it increments the active counts whenever a scope exists, regardless of `std::thread::current().id()`. Preserve the no-op behavior when no scope is active and preserve poisoned-mutex recovery.
- [ ] Remove owner-thread claims from the `ActiveScope`, `record`, guard, `scope`, and `snapshot` comments. State that serialization permits only one active process-wide measurement and that all threads contribute while it is armed.
- [ ] In `runtime_plugin_import_no_execution_installed_requirement_stays_inactive` in `src-tauri/src/services/tests.rs`, replace the arming-thread/synchronous attribution text with the cross-thread contract: the serialized scope spans preview and apply and observes dispatches from any thread while armed.
- [ ] Run all probe tests to ensure owner-thread recording, spawned-thread recording, scope serialization, empty snapshots, and `assert_zero` still pass.
- [ ] Run the runtime import acceptance test to confirm preview and apply still report zero real dispatches under the stronger probe.

**Validation:**

- Run (red): `mise run test execution_dispatch_probe_records_spawned_thread`
- Expected: the new test fails with `wasm_guest` observed as `0` instead of `1`.
- Run (green): `mise run test execution_dispatch_probe_records_spawned_thread`
- Expected: one test passes and the snapshot reports exactly one Wasm guest dispatch.
- Run: `mise run test execution_dispatch_probe`
- Expected: all dispatch-probe unit tests pass; the serialization test does not deadlock.
- Run: `mise run test runtime_plugin_import_no_execution_installed_requirement_stays_inactive`
- Expected: the acceptance test passes with zero dispatches for both preview and apply.

### Task 2: Remove the Speculative Retry Helper

**Seam:** `configurationImportPreviewState` public exports

**Outcome:** `canRetryImportPreview` and its self-only tests no longer exist; the dialog continues to render Retry controls from explicit phase branches and uses `startImportPreviewLoad` for retry transitions.

**Files:**

- Modify: `src/features/settings/configurationImportPreviewState.ts`
- Modify/Test: `src/features/settings/configurationImportPreviewState.test.ts`

**Steps:**

- [ ] **Red:** Run the static acceptance check and confirm it fails because `canRetryImportPreview` exists in the state module and its test file.
- [ ] **Green:** Delete the `canRetryImportPreview` export and its comment from `configurationImportPreviewState.ts`.
- [ ] Remove the matching test import and only the `canRetryImportPreview(...)` assertions from `configurationImportPreviewState.test.ts`. Do not remove tests for invalid, error, stale, expired, or retry transitions.
- [ ] Do not modify `ConfigurationImportPreviewDialog.tsx`: repository evidence shows that invalid, conflict, error, and previewed phases already render their Retry buttons directly and call `handlePreview`.
- [ ] Run the static check again, then run the focused state tests.

**Validation:**

- Run (red): `! git grep -n "canRetryImportPreview" -- src/features/settings`
- Expected: the command fails and prints references from the implementation and test file.
- Run (green): `! git grep -n "canRetryImportPreview" -- src/features/settings`
- Expected: the command succeeds with no output.
- Run: `bun test --isolate src/features/settings/configurationImportPreviewState.test.ts`
- Expected: all state-transition and apply-eligibility tests pass.

### Task 3: Remove the Orphaned Importing Copy

**Seam:** typed `en` and `zhCN` locale catalogs

**Outcome:** The unused `settings.backup.busyImport` key is absent from both locales, and locale structure remains type-correct.

**Files:**

- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh-CN.ts`

**Steps:**

- [ ] **Red:** Run the static acceptance check and confirm it fails because both locale catalogs still contain `busyImport`.
- [ ] **Green:** Remove `busyImport: "Importing…"` from `src/i18n/locales/en.ts` and `busyImport: "正在导入…"` from `src/i18n/locales/zh-CN.ts`.
- [ ] Keep `busyExport`, `applying`, and all active import dialog keys unchanged. Do not reintroduce an `"import"` route busy state.
- [ ] Run the static check again and run TypeScript type checking. The `zhCN` object must continue to satisfy `TranslationLeaves<typeof en>`.

**Validation:**

- Run (red): `! git grep -n "busyImport" -- src/i18n/locales src/routes src/features`
- Expected: the command fails and prints the two locale definitions.
- Run (green): `! git grep -n "busyImport" -- src/i18n/locales src/routes src/features`
- Expected: the command succeeds with no output.
- Run: `mise run typecheck`
- Expected: TypeScript reports no errors, including no English/Chinese catalog shape mismatch.

### Task 4: Revert Unrelated PaddleOCR Churn

**Seam:** worktree diff against `d9f9c1f` for the two PaddleOCR paths

**Outcome:** Neither PaddleOCR file appears in the feature diff; their baseline CRLF bytes are restored without changing semantic content.

**Files:**

- Restore: `runtime-plugins/paddleocr/plugin.json`
- Restore: `runtime-plugins/paddleocr/patches/README.md`

**Steps:**

- [ ] **Red:** Confirm that the focused diff check fails because both files differ from `d9f9c1f` by line endings.
- [ ] **Green:** Restore only these two working-tree files from `d9f9c1f`. Do not stage them and do not restore any other path.
- [ ] Re-run the focused diff check and confirm that no content or line-ending delta remains.

**Validation:**

- Run (red): `git diff --exit-code d9f9c1f -- runtime-plugins/paddleocr/plugin.json runtime-plugins/paddleocr/patches/README.md`
- Expected: the command fails and shows the existing whole-file line-ending churn.
- Run (green): `git restore --source=d9f9c1f --worktree -- runtime-plugins/paddleocr/plugin.json runtime-plugins/paddleocr/patches/README.md && git diff --exit-code d9f9c1f -- runtime-plugins/paddleocr/plugin.json runtime-plugins/paddleocr/patches/README.md`
- Expected: the restore does not stage files, and the diff command succeeds with no output.

## Final Validation

Run these commands after all four tasks:

- Run: `mise run test execution_dispatch_probe`
- Expected: all probe unit tests pass, including `execution_dispatch_probe_records_spawned_thread`.
- Run: `mise run test runtime_plugin_import_no_execution_installed_requirement_stays_inactive`
- Expected: the import acceptance gate passes with the cross-thread probe armed.
- Run: `mise run test-frontend`
- Expected: all frontend behavioral tests pass.
- Run: `mise run typecheck`
- Expected: TypeScript reports no errors.
- Run: `mise run lint`
- Expected: ESLint and oxlint report no errors.
- Run: `mise run format:check`
- Expected: oxfmt and rustfmt report no formatting changes.
- Run: `! git grep -n -E "canRetryImportPreview|busyImport" -- src`
- Expected: no removed helper or locale key remains.
- Run: `git diff --exit-code d9f9c1f -- runtime-plugins/paddleocr/plugin.json runtime-plugins/paddleocr/patches/README.md`
- Expected: both unrelated PaddleOCR paths have an empty diff.

## Failure Behavior

- `record` remains a no-op when no probe scope is active.
- A poisoned probe or serialization mutex continues to recover with `into_inner()`.
- A second `scope()` continues to block until the first guard drops; the stronger counting contract must not weaken scope serialization.
- Closing or retrying the import dialog remains unchanged because the removed helper is not used by production UI code.
- Removing `busyImport` changes no rendered copy because no production reference exists.

## Privacy and Security

- Keep the dispatch probe under its existing test-only compilation boundary.
- Record only the closed `ExecutionDispatchKind` categories and numeric counts. Do not record payloads, identifiers, configuration data, credentials, paths, or network targets.
- Do not change runtime execution authorization, import activation, IPC payloads, or credential handling.

## Rollout Notes

- No migration, feature flag, configuration change, or deployment step is required.
- Do not stage or commit changes as part of execution unless separately requested.

## Risks and Mitigations

- Cross-thread counting can observe a real dispatch from another thread while the sole scope is armed. This is the required contract. Keep process-wide scope serialization and run the full Rust suite to detect unintended concurrent dispatch activity.
- Removing assertions with `canRetryImportPreview` could accidentally reduce useful transition coverage. Remove only helper-specific assertions; retain direct tests for invalid, error, conflict, and retry state transitions.
- A broad restore could discard valid feature work. Restore only the two named PaddleOCR paths from `d9f9c1f` and verify their focused diff.

**Open Questions:** None.
