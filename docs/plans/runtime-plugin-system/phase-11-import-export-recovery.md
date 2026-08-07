# Phase 11: Runtime Plugin Import, Export, and Recovery Implementation Plan

**Goal:** Complete format v8 configuration portability with an exact preview/apply contract, actionable runtime requirements, and no transfer of executable code, secrets, trust, grants, or activation authority.

**Inputs:** Phase 4 runtime requirements, Phases 5–8 runtime packages, `docs/plans/2026-08-03-multi-interface-provider-runtime-plan.md`, the current format v8 implementation, and the Phase 11.5 activation-intent boundary.

**Assumptions:**

- `EXPORT_FORMAT_VERSION` remains `8`; supported input versions remain v2–v8.
- Existing Rust normalization, graph validation, transactional apply, credential journaling, runtime requirement persistence, and secret scanning are the baseline and are not rewritten.
- Import remains useful when packages are missing, revoked, disabled, incompatible, or unavailable; these are actionable runtime states, not structural import failures.
- Import never downloads, installs, verifies by execution, migrates through, grants, activates, or invokes plugin code.
- Default package policies and activation intents introduced by Phase 11.5 are local trust state and are never exported.
- Phase 11.5 must persist imported package-backed subjects as `import_requires_confirmation`; only local creation may use automatic activation recovery.
- Export formats v2–v8 remain readable through Phase 12 and at least one subsequent stable release.

**Architecture:** The Rust backend remains authoritative for parsing and sequential v2→v8 normalization. Export reads one SQLite snapshot and writes deterministic, secret-free runtime requirements. Import is split into load, backend preview, explicit user confirmation, and backend apply. Preview creates a bounded, expiring server-side session containing the normalized non-secret document, conflict mode, fixed Copy ID mapping, and hashed CAS baselines; the frontend receives only an opaque preview ID and sanitized summary. Apply submits only that ID, atomically claims the session, and rebuilds the same plan inside the write transaction. Package-backed rows persist inactive exact requirements, while later activation remains a separate lifecycle operation.

**Tech Stack:** Rust 2024, SQLite/rusqlite, Tauri 2 IPC/events, React 19, Effect, TanStack Query, Base UI, Bun, mise.

---

## Current Baseline to Preserve

The following behavior already exists and is guarded by current Rust tests:

- `src-tauri/src/domain/import_export.rs` writes format v8 and accepts v2–v8.
- v7 singular provider runtime identity normalizes to v8 adapter-keyed `runtimeBindings`.
- Integrations export one exact runtime requirement; providers export ordered adapter-keyed requirements.
- Export scans for forbidden secret/ref/token/grant fields.
- `ImportExportService::import` rebuilds and applies one validated plan in a SQLite transaction.
- Copy mode rewrites graph UUIDs; Merge mode uses credential ownership/CAS and journal cleanup.
- Package-backed imported integrations/providers remain inactive with no execution grant revision.
- Import apply emits provider/model/profile/integration/OCR/Speech/settings data-change events.

Do not create TDD tasks to reimplement this baseline. Extend it only through the failing public behaviors below.

## Out of Scope

- Exporting package archives, signatures, publisher trust, package approvals, default policies, execution grants, rollback snapshots, activation intents, credentials, refs, tokens, cache, logs, history payloads, images, audio, or user request bodies.
- Installing/downloading packages during preview or apply.
- Automatically activating a locally available package after import.
- Migrating imported config through guest/native code during import.
- Changing format v8 or removing v2–v8 compatibility.
- Implementing Phase 11.5 default authorization itself.

## File Map

- Modify: `src-tauri/src/domain/import_export.rs` — current-format comments plus v8 preview/runtime action DTOs with one opaque `previewId`.
- Modify: `src-tauri/src/services/import_validation.rs` — derive per-subject runtime availability/actions and deterministic import plan identity.
- Modify: `src-tauri/src/services/import_export.rs` — expose v8 preview data, own bounded preview sessions, and enforce preview/apply CAS inside the import transaction.
- Modify: `src-tauri/src/cmds/import_export.rs` — accept the opaque `previewId` on apply without adding new commands.
- Create: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/` — committed v2–v8 compatibility and mixed-runtime fixtures.
- Modify: `src-tauri/src/services/tests.rs`, `src-tauri/src/services/runtime_provider_tests.rs` — public service/runtime acceptance coverage.
- Modify: `src/storage/types.ts` — v8 preview/action DTOs and opaque preview ID.
- Modify: `src/features/settings/configurationTransfer.ts`, `src/features/settings/configurationTransfer.test.ts` — v8 envelope acceptance and split load/preview/apply Effect workflows.
- Create: `src/features/settings/importPreviewPresentation.ts`, `src/features/settings/importPreviewPresentation.test.ts` — pure counts, runtime actions, and warning presentation.
- Create: `src/features/settings/ConfigurationImportPreviewDialog.tsx` — Base UI Merge/Copy selection, preview, and confirmation.
- Create: `src/features/settings/configurationImportPreviewState.ts`, `src/features/settings/configurationImportPreviewState.test.ts` — pure dialog state transitions covered by the existing Bun test stack.
- Modify: `src/routes/settings.tsx` — replace immediate hard-coded Merge import with the preview dialog workflow.
- Modify: `src/features/settings/importAcceptance.ts`, `src/features/settings/importAcceptance.test.ts` — post-apply invalidation and actionable warnings.
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts` — concise preview, inactive-runtime, package-action, and stale-preview copy.
- Modify: `docs/plans/runtime-plugin-system/phase-11-5-default-package-activation.md` only if the final imported-intent handoff contract changes during implementation.

## Seams

- **Seam:** `parseConfigurationExportJson` — accepts v2–v8 envelopes, rejects unsupported/malformed input, and allows a backend-exported v8 document to re-enter the import workflow.
- **Seam:** `export_configuration` — returns deterministic v8 runtime requirements without forbidden local authority or secret data.
- **Seam:** `preview_configuration_import` — normalizes untrusted v2–v8 input and returns counts, authentication needs, exact runtime actions, and an opaque expiring preview ID without mutation or execution.
- **Seam:** `import_configuration` — accepts only an opaque preview ID, consumes its host-owned normalized document/mode/fixed mapping/CAS plan, and applies after rebuilding inside the write transaction.
- **Seam:** `prepareConfigurationImportFromFile` — loads one document, selects Merge/Copy, obtains preview, and does not apply before explicit confirmation.
- **Seam:** `configurationImportPreviewState` / `ConfigurationImportPreviewDialog` — controls mode/load/preview/confirm/conflict transitions and presents graph counts, runtime actions, credential warnings, and inactive-after-import semantics.
- **Seam:** post-import integration/provider runtime resolution — exact requirements remain inactive and require a separate lifecycle confirmation.
- **Seam:** Phase 11.5 `recover_pending_default_runtime_activations` — never schedules imported `import_requires_confirmation` intents.

## Tasks

### Task 1: Restore frontend format v8 round-trip

**Seam:** `parseConfigurationExportJson`

**Outcome:** A document produced by the current backend can be loaded by the frontend, while unsupported formats still fail before preview IPC.

**Files:**

- Modify: `src/features/settings/configurationTransfer.ts`
- Test: `src/features/settings/configurationTransfer.test.ts`

**Steps:**

- [ ] **Red:** Add a test that passes a minimal format v8 document through `parseConfigurationExportJson`; assert it is accepted unchanged. Confirm the current `[2..7]` frontend list fails.
- [ ] **Green:** Add v8 to `SUPPORTED_CONFIGURATION_FORMAT_VERSIONS` and update stale comments to v2–v8/current-format wording.
- [ ] **Red:** Feed the output shape returned by `exportConfigurationDocument` into the parse/load seam and assert self round-trip succeeds.
- [ ] **Green:** Keep frontend checks envelope-only; backend normalization and graph/runtime validation remain authoritative.
- [ ] Preserve rejection of missing/non-numeric `formatVersion`, unsupported future versions, non-object roots, and missing providers/models arrays.

**Validation:**

- Run (red): `bun test src/features/settings/configurationTransfer.test.ts`
- Expected: format v8 is rejected as unsupported.
- Run (green): same command.
- Expected: v2–v8 pass envelope checks; malformed/future formats fail.

### Task 2: Preview exact runtime requirements and actions

**Seam:** `preview_configuration_import`

**Outcome:** Preview distinguishes structural validity from local runtime readiness and tells the user what each imported integration/provider binding will require after apply.

**Files:**

- Modify: `src-tauri/src/domain/import_export.rs`, `src-tauri/src/services/import_validation.rs`, `src-tauri/src/services/import_export.rs`, `src/storage/types.ts`
- Test: inline validation tests and `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] **Red:** Preview a mixed v8 document containing bundled, legacy, installed package-backed, exact digests absent from the local catalog, revoked publisher, disabled publisher, content-unavailable, and incompatible runtime requirements.
- [ ] Assert each integration or provider adapter binding returns: subject kind/ID, display label, optional adapter ID, runtime kind, plugin/version/digest/publisher identity, local status, and required action.
- [ ] **Green:** Add `ImportRuntimeRequirementPreview` entries to `ImportPreview`; derive them from exact imported requirements plus local catalog/publisher state without substituting by plugin ID/version.
- [ ] Define deterministic status precedence after structural validation: absent exact digest → `missing`; otherwise revoked → disabled → content unavailable → incompatible → installed. Bundled/legacy requirements use their own statuses.
- [ ] Define closed actions: bundled/legacy → `none`; missing/content unavailable → `install_exact_package`; revoked/disabled → `restore_publisher`; incompatible → `resolve_incompatibility`; installed → `activate_after_import`.
- [ ] **Red:** Assert missing/revoked/incompatible requirements do not make an otherwise valid document invalid and do not mutate package/publisher state.
- [ ] **Green:** Keep these as preview actions. Structural identity errors remain `validation_errors`; local availability remains actionable metadata.
- [ ] Assert preview creates no package install operation, execution grant, rollback snapshot, runtime process, network request, or credential lookup.

**Validation:**

- Run (red): `mise run test import_runtime_requirement_preview -- --nocapture`
- Expected: preview lacks per-subject runtime status/action DTOs.
- Run (green): same command.
- Expected: exact local states/actions are reported while preview remains non-mutating and non-executing.

### Task 3: Bind apply to an expiring preview session

**Seam:** `preview_configuration_import`, `import_configuration`

**Outcome:** Apply uses the exact Merge/Copy mode, Copy ID mapping, document identity, and local CAS baseline that the user previewed.

**Files:**

- Modify: `src-tauri/src/domain/import_export.rs`, `src-tauri/src/services/import_validation.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/cmds/import_export.rs`, `src/storage/types.ts`, `src/features/settings/configurationTransfer.ts`
- Test: service transaction/session tests and frontend IPC argument tests

**Steps:**

- [ ] **Red:** Preview a Copy document and immediately apply it without local changes; assert the same generated target IDs are used. This fails if apply calls the current random `new_id()` mapping again.
- [ ] **Green:** Add a bounded in-memory preview session store to `ImportExportService`. Store an opaque preview ID, expiry, normalized non-secret document, conflict mode, fixed provider/model/profile/template/integration/OCR/Speech ID maps, default remaps, and hashed affected-row/credential ownership CAS baselines. Enforce existing document-size limits and a total bounded session budget.
- [ ] Refactor plan building to accept a supplied Copy ID mapping; preview generates it once and apply reuses it.
- [ ] **Red:** Preview, modify an affected local row or credential ownership baseline, then apply by preview ID; assert a normalized conflict and no partial write.
- [ ] **Green:** Apply receives only `{ previewId }`, then atomically claims the matching session from `ready` to `in_flight` before credential recovery, vault access, journal cleanup, or DB mutation. Rebuild from the session-owned normalized document/mode/mapping inside the write transaction and compare current CAS baselines before mutation.
- [ ] **Red:** Run two concurrent apply calls with one preview ID; assert exactly one claims it and the other fails before credential/vault/business mutation.
- [ ] **Green:** Protect claim under the bounded session-store mutex, release the mutex before recovery/apply work, delete on success, and destroy the claimed session on every failure. Users re-preview after any failed apply; no session returns to `ready`.
- [ ] **Red:** Apply with an expired, unknown, or reused preview ID; assert rejection before `recover_affected_owners` and no change to vault, credential journals, or business tables.
- [ ] **Green:** Validate/claim the session before the existing credential preflight/recovery path. Application restart drops all sessions and requires re-preview.
- [ ] Never place the normalized document, CAS evidence, fixed mappings, credential refs, secrets, or package trust in the frontend preview DTO or logs; the frontend receives only `previewId` and sanitized preview fields.

**Validation:**

- Run (red): `mise run test import_preview_session_cas -- --nocapture`
- Expected: Copy preview/apply cannot preserve one random ID mapping and apply accepts no preview ID.
- Run (green): same command.
- Expected: one exact preview session applies once; stale/mismatched sessions fail atomically.

### Task 4: Split file loading, preview, and apply workflows

**Seam:** `prepareConfigurationImportFromFile`

**Outcome:** Selecting a file never immediately imports it; after backend preview, the caller retains only the sanitized preview and opaque ID for explicit confirmation.

**Files:**

- Modify: `src/features/settings/configurationTransfer.ts`, `src/features/settings/configurationTransfer.test.ts`
- Test: `src/features/settings/configurationTransfer.test.ts`

**Steps:**

- [ ] **Red:** Add an Effect workflow test proving file load + preview returns a prepared result and does not call `import_configuration`.
- [ ] **Green:** Introduce `prepareConfigurationImportFromFile(mode)` returning the sanitized prepared preview with `previewId`; discard the frontend document after preview IPC completes and keep cancel/invalid-preview variants explicit.
- [ ] **Red:** Confirm `applyPreparedConfigurationImport` sends only the opaque preview ID, then maps applied/not-applied/conflict/expired outcomes.
- [ ] **Green:** Separate apply from preparation and preserve typed `IpcError | FsError` channels.
- [ ] Do not log, persist to browser storage, or include the document in toast/error text.

**Validation:**

- Run (red): `bun test src/features/settings/configurationTransfer.test.ts`
- Expected: the existing workflow previews and applies immediately.
- Run (green): same command.
- Expected: preparation is non-mutating and apply requires the prepared digest.

### Task 5: Add Merge/Copy preview and confirmation UI

**Seam:** `configurationImportPreviewState`, `ConfigurationImportPreviewDialog`

**Outcome:** Users choose Merge or Copy, inspect exact changes and runtime actions, and explicitly confirm before apply.

**Files:**

- Create: `src/features/settings/ConfigurationImportPreviewDialog.tsx`, `src/features/settings/configurationImportPreviewState.ts`, `src/features/settings/configurationImportPreviewState.test.ts`, `src/features/settings/importPreviewPresentation.ts`, `src/features/settings/importPreviewPresentation.test.ts`
- Modify: `src/routes/settings.tsx`, `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`
- Test: `src/features/settings/configurationImportPreviewState.test.ts`, `src/features/settings/importPreviewPresentation.test.ts`, `src/features/settings/configurationTransfer.test.ts`

**Steps:**

- [ ] **Red:** Add pure presentation tests for create/update/copy counts, authentication categories, runtime local statuses/actions, default-cleared warnings, and “external runtimes remain inactive” copy.
- [ ] **Green:** Implement deterministic presentation helpers with no plugin-ID branches.
- [ ] **Red:** Drive the pure dialog state through mode selection, load, preview success/error, apply, stale/expired conflict, retry, and cancel. Assert Apply is enabled only for a valid prepared preview and unavailable packages do not disable data import.
- [ ] **Green:** Implement `configurationImportPreviewState` and make the Base UI RadioGroup/Dialog render and dispatch only through that state contract.
- [ ] **Red:** Assert presentation includes mode, graph counts, exact package/publisher/digest labels, required actions, credential warnings, all bounded validation errors, and inactive-after-import copy.
- [ ] **Green:** Replace the hard-coded `runImportConfigurationFromFile("merge")` route flow with the dialog, concise English/Chinese copy, and retry/re-preview behavior.
- [ ] Manually smoke the rendered Base UI focus trap, keyboard selection, Cancel, and Apply wiring; the repository currently has no DOM component-test harness, so do not introduce one solely for this phase.
- [ ] State explicitly: import does not install code, trust publishers, grant authority, reuse exported secrets, or activate runtimes.

**Validation:**

- Run (red): `bun test src/features/settings/configurationImportPreviewState.test.ts src/features/settings/importPreviewPresentation.test.ts src/features/settings/configurationTransfer.test.ts`
- Expected: no mode/preview confirmation UI contract exists.
- Run (green): same command.
- Expected: Merge/Copy and runtime actions are reviewed before apply.

### Task 6: Refresh every imported domain after apply

**Seam:** `invalidateAfterConfigurationImport`

**Outcome:** Successful import refreshes every affected TanStack Query cache, including Speech.

**Files:**

- Modify: `src/features/settings/importAcceptance.ts`
- Test: `src/features/settings/importAcceptance.test.ts`

**Steps:**

- [ ] **Red:** Assert `IMPORT_INVALIDATION_KEYS` includes provider, model, profile, integration, OCR, Speech, and settings prefixes. The current helper omits `speechKeys.all`.
- [ ] **Green:** Add the Speech query prefix and update the helper comment.
- [ ] **Red:** Assert an applied result triggers every invalidation once, while cancelled/invalid/not-applied results trigger none through the route workflow seam.
- [ ] **Green:** Keep invalidation after successful apply only; backend data-change events remain the second consistency path.

**Validation:**

- Run (red): `bun test src/features/settings/importAcceptance.test.ts`
- Expected: Speech invalidation assertion fails.
- Run (green): same command.
- Expected: all imported domains refresh only after apply.

## Acceptance Gates

These gates preserve already implemented behavior. They are regression/characterization checks, not new red→green slices unless implementation exposes a concrete failure.

### Format and graph compatibility

- Commit mixed v8 and historical v2–v7 fixtures under `src-tauri/src/services/fixtures/import/runtime-plugin-v8/` for durable acceptance coverage.
- Verify v2–v8 normalize to current v8, integration requirements stay explicit, and provider requirements remain adapter-keyed.
- Verify current v8 export → frontend parse → preview → Copy apply → export preserves portable graph/runtime semantics after expected ID rewriting.
- Preserve current Merge/Copy tests for credential cleanup, complete UUID remapping, runtime binding reconciliation, grant release, and transaction rollback.

Run:

```bash
mise run test import_format -- --nocapture
mise run test runtime_plugin_import -- --nocapture
mise run test runtime_provider -- --nocapture
```

### No execution or authority transfer

- Import exact installed Wasm and trusted-native-worker requirements with matching local defaults/publishers.
- Through public list/runtime-resolution seams, verify exact requirements persist inactive, grant revisions remain absent, and execution resolves unavailable/pending.
- Verify preview/apply starts no runtime process, guest/native migration, network dispatch, package install, grant creation, default policy, or rollback snapshot.

Run:

```bash
mise run test runtime_plugin_import_no_execution -- --nocapture
mise run test runtime_plugin_security -- --nocapture
```

### Phase 11.5 provenance handoff — blocked until Phase 11.5 Task 1/8

This is a cross-phase completion gate, not a Phase 11 implementation task. When migration 0027 and `DefaultPackageActivationService` exist:

- Import must atomically persist package-backed subject state plus `import_requires_confirmation` intent.
- Failure between subject/runtime/intent writes must roll back all related rows.
- Restart recovery with a matching authorized default must schedule zero imported subjects.
- Only a separate post-import authority preview/confirmation may activate them.

Run after Phase 11.5 Task 8:

```bash
mise run test default_package_activation_startup_recovery -- --nocapture
```

Expected: imported intents remain inactive before and after restart.

## Final Validation

```bash
mise run test import_format -- --nocapture
mise run test runtime_plugin_import -- --nocapture
mise run test runtime_plugin_import_no_execution -- --nocapture
mise run test runtime_provider -- --nocapture
bun test src/features/settings/configurationTransfer.test.ts
bun test src/features/settings/configurationImportPreviewState.test.ts
bun test src/features/settings/importPreviewPresentation.test.ts
bun test src/features/settings/importAcceptance.test.ts
bun test src/query/dataChangeEventBindings.test.ts
mise run typecheck
mise run lint
mise run format:check
mise run build
```

Expected: v2–v8 normalize; current exports can be re-imported; preview and apply are exact-bound; Merge/Copy are explicit; missing/untrusted runtimes remain actionable but inactive; no code, secrets, trust, grants, or activation authority crosses the document boundary.

## Failure Behavior

- Invalid JSON/envelope/future format — reject before preview mutation.
- Duplicate/broken graph or invalid runtime identity — preview invalid; apply unavailable.
- Missing/revoked/disabled/incompatible package — data import remains available; exact requirement persists inactive with an action.
- Preview unknown, expired, reused, wrong-mode, wrong-document, or stale against local CAS baselines — apply returns conflict before mutation; UI re-previews.
- Credential owner busy or changed — apply fails atomically and retains recoverable journal state.
- Copy/Merge graph failure — rollback all SQLite writes; do not partially clear credentials.
- Runtime resolution after import — return unavailable/pending until a separate confirmed lifecycle action.

## Privacy and Security

- Export and preview never contain credential refs, secrets, tokens, package approvals, execution grants, default policies, rollback snapshots, or activation intents.
- Preview sessions keep the normalized non-secret document, fixed Copy mappings, and hashed local CAS baselines in bounded host memory; the frontend receives only an opaque ID and sanitized preview DTO.
- Import never invokes Wasm/native code, starts workers, performs network requests, downloads packages, or grants authority.
- Exact digest and publisher identity are retained; plugin ID/version matching never substitutes another package.
- Configuration documents and validation payloads are never logged or embedded in toast text.
- Phase 11.5 local default authorization cannot apply to imported data without a separate post-import confirmation.

## Rollout Notes

1. Ship frontend v8 acceptance first to restore self round-trip.
2. Add preview runtime actions and preview-session CAS before exposing the new dialog.
3. Enable Merge/Copy preview UI after backend DTOs are stable.
4. Land mixed-runtime fixtures and no-execution acceptance tests before Phase 11 completion.
5. Re-run the provenance handoff test when Phase 11.5 introduces activation intents.
6. Preserve v2–v8 readers through Phase 12 and one subsequent stable release.

## Risks and Mitigations

- Frontend/backend version drift — explicit v8 self-round-trip test at both seams.
- User confirms one plan but applies another — apply accepts only the one-time preview ID; the host session owns mode, normalized document, Copy mapping, and CAS baselines.
- Missing package blocks data recovery — separate structural validity from local runtime actions.
- Import accidentally inherits local default authority — no import-time activation/grant and Phase 11.5 provenance isolation.
- Copy preview/apply generates different IDs — preview session stores one fixed mapping and apply injects it into plan rebuilding.
- Copy mode leaves dangling references — committed mixed-graph fixture and full ID-remap acceptance assertions.
- Merge clears the wrong credential — hashed ownership baseline in plan CAS plus existing journal compensation.
- Preview leaks local trust/credential details — bounded status/action DTOs; document digest, fixed mappings, and CAS evidence remain inside the host session.

## Open Questions

None blocking implementation. Phase 11.5 owns activation-intent persistence; this phase owns the imported-inactive contract it must preserve.
