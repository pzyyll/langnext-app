# Storage Subsystem Review Fix Implementation Plan

**Goal:** Resolve the credential-recovery, import validation, concurrency, snapshot consistency, device-state, and IPC issues found during review so the storage subsystem is safe to merge.

**Inputs:** Staged implementation on `feat/storage-subsystem`, `docs/analysis/2026-07-10-storage-subsystem-code-review.md`, `docs/analysis/storage-architecture.md`, `docs/plans/2026-07-10-storage-subsystem-plan.md`, and the successful local validation run on 2026-07-10.

**Assumptions:**

- The staged storage schema has not shipped to users. JSON payload shapes and `0001_initial.sql` may be corrected in place. If any build containing this schema has been distributed, preserve version 1 and add a forward-only `0002_*.sql` migration instead.
- Provider HTTP adapters and live model synchronization remain outside this fix scope; the existing cache-merge service is retained and tested.
- The native credential vault remains the only production secret store. No plaintext or file-based fallback is permitted.
- The fix may add focused internal helpers and Tauri commands, but it must not add Provider/settings management screens or unrelated UI work.

**Architecture:** Preserve the existing Rust-owned SQLite/vault/device-state boundaries. Centralize credential-journal finalization so vault cleanup and journal deletion have one tested invariant, validate imports into a normalized plan before any write, and add explicit SQLite read snapshots and owner-serialized mutation paths. Device-state persistence receives a real delayed writer, while focused settings commands prevent whole-document frontend races.

**Tech Stack:** Existing Tauri 2.11, Rust 2021, `rusqlite 0.40.1`, `keyring 4.1.4`, Serde, React 19, TypeScript 6, and mise tasks. No new production dependency is required.

---

## Review Baseline

### Conclusion

**Request changes.** Automated checks pass, but tests do not cover several failure and concurrency paths that can orphan credentials, misbind secrets, or persist invalid configuration.

### Validation already run

| Command                 | Result                                           |
| ----------------------- | ------------------------------------------------ |
| `mise run test`         | 63 passed, 1 ignored                             |
| `mise run typecheck`    | Passed                                           |
| `mise run lint`         | Passed                                           |
| `mise run format:check` | Passed                                           |
| `mise run build`        | Passed; existing Vite chunk-size warning remains |

### Findings addressed by this plan

| Priority | Finding                                                                                   | Primary evidence                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P0       | R-001: Credential cleanup errors are ignored while recovery journals are deleted          | `src-tauri/src/services/providers.rs:231-247,288-303,338-343`; `src-tauri/src/services/settings.rs:103-119,148-163` |
| P0       | R-002: Import deletes every committed credential journal, including unrelated operations  | `src-tauri/src/services/import_export.rs:101-114`                                                                   |
| P0       | R-003: Provider/proxy `Keep` paths bypass owner serialization and credential CAS          | `src-tauri/src/services/providers.rs:145-168`; `src-tauri/src/services/settings.rs:26-55`                           |
| P1       | R-004: Import preview/write bypasses complete service and relationship validation         | `src-tauri/src/services/import_export.rs:125-182,320-348,472-478`                                                   |
| P1       | R-005: System proxy mode can persist an unvalidated URL containing secrets                | `src-tauri/src/services/settings.rs:193-201`                                                                        |
| P1       | R-006: Export and aggregate reads are not pinned to one SQLite snapshot                   | `src-tauri/src/services/import_export.rs:34-40`; `src-tauri/src/storage/database.rs:169-174`                        |
| P1       | R-007/R-014: Device-state debounce and geometry handling are incomplete                   | `src-tauri/src/device_state.rs:17-38,89-119`; `src-tauri/src/windows/main.rs:22-52`                                 |
| P1       | R-008: Theme updates are unordered whole-document read-modify-write operations            | `src/theme/useTheme.ts:34-64`; `src-tauri/src/services/settings.rs:26-55`                                           |
| P2       | R-009: Startup credential recovery status is discarded and never retried                  | `src-tauri/src/state.rs:21-34`                                                                                      |
| P2       | R-010: Failed model refresh erases the previous successful synchronization timestamp      | `src-tauri/src/services/models.rs:113-125`                                                                          |
| P2       | R-011: Raw `spawn_blocking` join errors cross the IPC boundary                            | `src-tauri/src/cmds/*.rs`                                                                                           |
| P2       | R-012: Backup rotation can retain corrupt snapshots and lacks real migration tests        | `src-tauri/src/storage/database.rs:122-164`; `src-tauri/src/storage/tests.rs:267-288`                               |
| P2       | R-013: Capability overrides remain arbitrary unversioned JSON                             | `src-tauri/src/domain/model.rs`; `src-tauri/src/services/models.rs:41-70`                                           |
| P3       | R-015: Native lifecycle, DTO contract, export target, and warning coverage are incomplete | Existing ignored/test modules                                                                                       |

### Finding-to-task map

| Finding             | Fix task |
| ------------------- | -------- |
| R-001, R-009        | Task 1   |
| R-002               | Task 2   |
| R-003, R-008        | Task 3   |
| R-004, R-005, R-013 | Task 4   |
| R-006               | Task 5   |
| R-007, R-014        | Task 6   |
| R-010               | Task 7   |
| R-011               | Task 8   |
| R-012               | Task 9   |
| R-015               | Task 10  |

## File Map

### Credential coordination and health

- Create: `src-tauri/src/credentials/coordinator.rs` — shared vault-cleanup, journal-finalization, owner recovery, and mutation preflight rules.
- Modify: `src-tauri/src/credentials/mod.rs` — export internal coordinator APIs.
- Modify: `src-tauri/src/credentials/vault.rs` — add a failure-injecting test vault and RAII cleanup for ignored native tests.
- Modify: `src-tauri/src/credentials/tests.rs` — cover cleanup failures, retained journals, retries, and real lifecycle integration.
- Modify: `src-tauri/src/repositories/credential_operations.rs` — return/query complete operations for exact finalization.
- Modify: `src-tauri/src/services/providers.rs` — route replace/clear/delete/keep/recovery through the coordinator.
- Modify: `src-tauri/src/services/settings.rs` — route proxy replace/clear/keep/recovery through the coordinator.
- Modify: `src-tauri/src/services/import_export.rs` — finalize only operation IDs created by the current import.
- Modify: `src-tauri/src/state.rs` — replace dead `vault_available` state with a live recovery status or remove it in favor of coordinator preflight.

### Validation and transactional reads

- Modify: `src-tauri/src/storage/database.rs` — add explicit read-snapshot transactions.
- Modify: `src-tauri/src/storage/unit_of_work.rs` — support read-only snapshot closure usage if needed.
- Create: `src-tauri/src/services/import_validation.rs` — normalize and validate complete import graphs before writes.
- Modify: `src-tauri/src/services/mod.rs` — register import validation module.
- Modify: `src-tauri/src/services/import_export.rs` — consume a validated import plan.
- Modify: `src-tauri/src/services/settings.rs` — split pure settings validation from transaction-aware reference validation.
- Modify: `src-tauri/src/services/translation_profiles.rs` — expose reusable profile/target/options validation over a supplied connection.
- Modify: `src-tauri/src/adapters/catalog.rs` — validate versioned capability overrides and profile options.

### Device state, settings, and IPC

- Modify: `src-tauri/src/device_state.rs` — implement actual delayed flushing, retry-safe pending state, and stronger geometry validation.
- Modify: `src-tauri/src/windows/main.rs` — retain normal geometry while maximized and schedule a real delayed flush.
- Modify: `src-tauri/src/windows/tray.rs` — explicitly handle final flush failure.
- Modify: `src-tauri/src/domain/settings.rs` — add focused theme update input if needed.
- Modify: `src-tauri/src/services/settings.rs` — add atomic `set_theme` and owner-serialized settings mutation.
- Modify: `src-tauri/src/cmds/settings.rs` — expose focused theme mutation.
- Create: `src-tauri/src/cmds/runtime.rs` — shared sanitized `spawn_blocking` wrapper.
- Create: `src-tauri/src/panic.rs` — production-safe global panic hook that never formats panic payloads.
- Modify: `src-tauri/src/cmds/mod.rs` — export command runtime helper.
- Modify: `src-tauri/src/cmds/providers.rs` — use sanitized blocking wrapper.
- Modify: `src-tauri/src/cmds/models.rs` — use sanitized blocking wrapper.
- Modify: `src-tauri/src/cmds/translation_profiles.rs` — use sanitized blocking wrapper.
- Modify: `src-tauri/src/cmds/settings.rs` — use sanitized blocking wrapper.
- Modify: `src-tauri/src/cmds/import_export.rs` — use sanitized blocking wrapper.
- Modify: `src-tauri/src/lib.rs` — register focused command if added.
- Modify: `src/storage/types.ts` — define focused theme and versioned capability DTOs.
- Modify: `src/storage/client.ts` — add focused theme client.
- Create: `src/theme/themeMutationQueue.ts` — ordered theme persistence queue independent of React/DOM.
- Create: `src/theme/themeMutationQueue.test.ts` — Bun behavioral tests for rapid writes and rollback ordering.
- Create: `.mise/tasks/test-frontend` — run frontend behavioral tests with Bun.
- Modify: `src/theme/useTheme.ts` — enqueue mutations and rollback only the latest request.
- Modify: `src/components/ThemeToggle.tsx` — expose a persistence failure to the user.

### Model metadata, backups, tests, and docs

- Modify: `src-tauri/src/domain/model.rs` — replace arbitrary capability override JSON with a versioned typed structure.
- Modify: `src-tauri/src/repositories/provider_models.rs` — serialize typed overrides and preserve last successful sync state.
- Modify: `src-tauri/src/repositories/provider_instances.rs` — add failure-only sync status update.
- Modify: `src-tauri/src/services/models.rs` — validate typed overrides and preserve `models_synced_at` on failure.
- Modify: `src-tauri/src/storage/database.rs` — publish backups through verified temporary files and rotate only valid snapshots.
- Modify: `src-tauri/src/storage/migrations.rs` — expose test-only migration injection for real rollback tests.
- Modify: `src-tauri/src/storage/tests.rs` — cover successful/failing migration snapshots and rotation.
- Modify: `src-tauri/src/services/tests.rs` — cover import graph/security and snapshot behavior.
- Modify: `src-tauri/src/repositories/tests.rs` — cover sync timestamp and mutation CAS behavior.
- Modify: `src/storage/types.ts` — expand compile-time DTO fixtures.
- Modify: `docs/analysis/storage-architecture.md` — document corrected cleanup, retry, import, snapshot, and capability semantics.
- Modify: `README.md` — document any new ignored lifecycle command or recovery behavior.

Every new Rust and TypeScript code file must begin with two syntax-appropriate `ABOUTME:` lines.

## Tasks

### Task 1: Make Credential Cleanup and Recovery Lossless

**Outcome:** A credential journal is removed only after the corresponding vault cleanup succeeds or is confirmed idempotently absent; every other vault error remains recoverable.

**Files:**

- Create: `src-tauri/src/credentials/coordinator.rs`
- Modify: `src-tauri/src/credentials/mod.rs`
- Modify: `src-tauri/src/credentials/vault.rs`
- Modify: `src-tauri/src/credentials/tests.rs`
- Modify: `src-tauri/src/repositories/credential_operations.rs`
- Modify: `src-tauri/src/services/providers.rs`
- Modify: `src-tauri/src/services/settings.rs`
- Modify: `src-tauri/src/state.rs`

**Steps:**

- [ ] Change `credential_operations::insert_prepared` and `insert_db_committed` to return the complete persisted `CredentialOperation`, and add `get_by_id` for exact recovery/finalization. Callers must not reconstruct operations without the repository-generated state/timestamp.
- [ ] Add a coordinator function that accepts a complete `CredentialOperation`, determines the exact cleanup from the matrix below, and deletes that operation row only after required `CredentialVault::delete` calls succeed. `NativeCredentialVault::delete` already maps `NoEntry` to success.
- [ ] Implement and test the complete matrix: `prepared + new_ref Some + current != new_ref` deletes the unused new secret; `prepared + current == new_ref` treats the database change as committed and deletes `expected_old_ref` when present; `prepared + new_ref None + current == expected_old_ref` performs no vault delete and removes only the uncommitted clear journal; `prepared + new_ref None + current None` deletes `expected_old_ref` when present; `db_committed` deletes `expected_old_ref` when present; every branch with no target reference performs journal-only completion.
- [ ] On `CredentialUnavailable`, `CredentialAccess`, or any unexpected vault error, retain the journal unchanged and return a structured recovery result containing owner, operation ID, and sanitized error code.
- [ ] Replace every `let _ = vault.delete(...)` followed by unconditional journal deletion in Provider replace, clear, and delete paths with the coordinator invariant.
- [ ] For post-commit cleanup failure, keep the committed Provider/proxy configuration, retain `db_committed`, return the successful DTO, and emit only a bounded backend `cleanup_deferred` diagnostic containing operation ID and owner kind; do not roll back a committed reference change.
- [ ] For pre-commit compensation failure after a new secret may have been written, retain `prepared` with `new_ref` so the next recovery attempt can delete it.
- [ ] Add `recover_owner(owner_kind, owner_id)` and call it before every Provider/proxy credential mutation and before import busy checks for every affected existing owner. If recovery still cannot contact the vault, return `credential_unavailable` instead of leaving the caller with a misleading permanent `credential_busy`.
- [ ] Make startup recovery return a report. Remove `vault_available: true` from `AppState`, or replace it with synchronized live status that services actually consume; do not retain an unused boolean.
- [ ] Add a test-only `FailingCredentialVault` configurable to fail set/delete/read operations without embedding secrets in errors.
- [ ] Test replacement old-secret deletion failure, replacement compensation failure, clear failure, Provider deletion failure, proxy cleanup failure, repeated recovery, and eventual success after the failing vault is restored.
- [ ] Assert after each failure that the exact journal row still exists with the expected state/reference and after recovery that only that row and secret are removed.

**Validation:**

- Run: `mise run test credentials::`
- Expected: All credential tests pass, including injected failures and recovery retries.
- Run: `mise run test services::tests::provider`
- Expected: Provider success paths still pass and cleanup-failure tests retain recoverable journals.

### Task 2: Isolate Import Credential Cleanup

**Outcome:** Import finalizes only credentials it cleared in its own transaction and never removes unrelated recovery state.

**Files:**

- Modify: `src-tauri/src/services/import_export.rs`
- Modify: `src-tauri/src/services/tests.rs`
- Modify: `src-tauri/src/lib.rs`

**Steps:**

- [ ] Temporarily unregister `export_configuration`, `preview_configuration_import`, and `import_configuration` from `tauri::generate_handler!` at the start of this task; re-register them only after Task 4 validation tests pass.
- [ ] Replace `Vec<String>` cleanup output with `Vec<CredentialOperation>` returned from the import transaction. Use the complete values returned by `insert_db_committed`; do not pass partial operation IDs/references.
- [ ] Preserve one complete operation for every imported merge Provider whose local credential is cleared and for the global proxy binding when imported settings clear it.
- [ ] Before checking `credential_busy`, call `recover_owner` for every affected existing Provider and the global proxy. Add a retry test where the vault is restored without restarting the app.
- [ ] After commit, pass each exact operation to the credential coordinator from Task 1.
- [ ] Remove the global `list_unfinished`/delete-all-`db_committed` sweep.
- [ ] Leave failed cleanup operations in `credential_operations`; report the import itself as applied because its SQLite transaction committed, and surface deferred cleanup only through sanitized diagnostics.
- [ ] Add a regression test with one unrelated pre-existing `db_committed` operation and one import-owned operation. Force the import-owned vault delete to fail and assert both journal rows remain; restore the vault, recover only the import owner, and assert the unrelated row remains untouched.

**Validation:**

- Run: `mise run test services::tests::import_credential_cleanup`
- Expected: Import never removes unrelated journal rows and failed cleanup remains recoverable.

### Task 3: Serialize `Keep` Mutations and Add Atomic Theme Updates

**Outcome:** Provider/proxy settings cannot race credential replacement, and rapid theme changes cannot write stale whole-document settings.

**Files:**

- Modify: `src-tauri/src/repositories/provider_instances.rs`
- Modify: `src-tauri/src/repositories/app_settings.rs`
- Modify: `src-tauri/src/services/providers.rs`
- Modify: `src-tauri/src/services/settings.rs`
- Modify: `src-tauri/src/domain/settings.rs`
- Modify: `src-tauri/src/cmds/settings.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/storage/types.ts`
- Modify: `src/storage/client.ts`
- Create: `src/theme/themeMutationQueue.ts`
- Create: `src/theme/themeMutationQueue.test.ts`
- Create: `.mise/tasks/test-frontend`
- Modify: `src/theme/useTheme.ts`
- Modify: `src/components/ThemeToggle.tsx`
- Modify: `src-tauri/src/repositories/tests.rs`
- Modify: `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] Move Provider `Keep` preflight, current-row read, endpoint-change validation, unfinished-owner check, and write into one SQLite transaction.
- [ ] Add a repository update that changes Provider configuration without writing `credential_ref`; never rebuild and write an earlier credential reference on the `Keep` path.
- [ ] Move proxy `Keep` current-settings/current-binding reads, owner-journal check, URL-change validation, default-profile validation, and settings write into one transaction.
- [ ] Split settings validation into a pure document validator plus a connection-scoped default-profile validator so no read occurs before the write transaction.
- [ ] Add `SettingsService::set_theme(theme)` that reads the current document and writes only the theme inside one transaction. Expose `set_theme` through a focused Tauri command and TypeScript client.
- [ ] Implement an ordered `ThemeMutationQueue` that chains each backend write after the previous write settles. Do not rely on a token alone: the queue must guarantee backend invocation order matches click order.
- [ ] Track a monotonically increasing UI mutation ID in addition to the queue; rollback/error state is applied only when the failed mutation is still the latest visible action.
- [ ] Create `.mise/tasks/test-frontend` with two `ABOUTME:` lines and `bun test src/theme/themeMutationQueue.test.ts`.
- [ ] Render a compact accessible persistence error in `ThemeToggle` or its containing UI; do not discard the hook's `error` field.
- [ ] Add deterministic Rust concurrency tests using barriers for Provider Keep versus Replace and proxy Keep versus Replace.
- [ ] Add Bun tests with deferred promises for two rapid successful writes, first failure followed by success, and stale failure after a newer optimistic action. Assert backend call order and final visible state.

**Validation:**

- Run: `mise run test provider_keep`
- Expected: Provider Keep/Replace race tests pass.
- Run: `mise run test proxy_keep`
- Expected: Proxy Keep/Replace race tests pass.
- Run: `mise run test-frontend`
- Expected: Theme mutation ordering and rollback tests pass deterministically.
- Run: `mise run typecheck && mise run lint`
- Expected: Focused theme IPC and error rendering compile and lint cleanly.

### Task 4: Validate Imports into a Complete Normalized Plan

**Outcome:** Preview reports malformed documents, and import revalidates the complete graph inside its write transaction before any mutation.

**Files:**

- Create: `src-tauri/src/services/import_validation.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/import_export.rs`
- Modify: `src-tauri/src/services/settings.rs`
- Modify: `src-tauri/src/services/translation_profiles.rs`
- Modify: `src-tauri/src/adapters/catalog.rs`
- Modify: `src-tauri/src/domain/model.rs`
- Modify: `src-tauri/src/repositories/provider_models.rs`
- Modify: `src-tauri/src/services/models.rs`
- Modify: `src/storage/types.ts`
- Modify: `src-tauri/src/services/tests.rs`
- Modify: `src-tauri/src/lib.rs`

**Steps:**

- [ ] First define `CapabilityOverridesV1 { schema_version: 1, streaming: Option<bool>, max_context_tokens: Option<u32> }`, replace arbitrary capability JSON at Rust/TypeScript boundaries, and add repository serialization plus adapter validation. This prerequisite must land before import validation consumes it.
- [ ] Build `ValidatedImportPlan` containing normalized Providers, models, profiles, ordered targets, rewritten IDs for copy mode, resolved default profile, complete credential cleanup operations, preview counts, and expected local-row ownership/version preconditions.
- [ ] Reject duplicate Provider, model, profile, and target identities before building hash maps; never allow later entries to silently overwrite earlier entries.
- [ ] Validate every Provider with the code-owned adapter catalog, display-name bounds, credential-kind invariants, base URL rules, and parsed RFC 3339 insecure-HTTP confirmation timestamp.
- [ ] Validate every model's non-empty bounded key, source/availability combination, typed capability overrides, and Provider reference.
- [ ] In merge mode, reject a model UUID that already belongs to a different Provider instead of updating its fields while retaining local ownership.
- [ ] Validate every profile's name, templates, common parameters, adapter options, at-least-one target rule, unique model targets, and contiguous priorities beginning at zero.
- [ ] Require import documents to be self-contained: every model references a Provider in the document, every target references a profile/model in the document, and a non-null default profile references a profile in the document. Do not permit references to local-only entities.
- [ ] Add pure settings validation that requires `proxy_url = null` for system mode and validates every non-null custom URL for scheme, userinfo, query, and fragment.
- [ ] Resolve `default_profile_id` explicitly: preserve a valid imported/allowed local profile, or set it to null only when the preview reports `defaultProfileCleared`; never silently clear during apply.
- [ ] Make `preview` return validation errors from a snapshot-built `ValidatedImportPlan` for display only.
- [ ] Inside the import write transaction, rebuild and revalidate the plan against current local rows before applying. Check expected merge ownership and credential bindings in that same transaction so concurrent deletes/replacements cannot invalidate a stale preview. Return the transaction's final preview in `ImportResult`.
- [ ] After all import validation and regression tests pass, re-register `export_configuration`, `preview_configuration_import`, and `import_configuration` in `tauri::generate_handler!`.
- [ ] Add sentinel tests for `http://user:secret@host`, system mode with a URL, duplicate IDs, orphan targets, empty target chains, non-contiguous priorities, unknown adapters, cross-Provider model UUID collisions, invalid options, and invalid capability overrides.
- [ ] Serialize every accepted/rejected sentinel document and assert no secret appears in export or `IpcError` messages.

**Validation:**

- Run: `mise run test import_`
- Expected: Valid round trips pass; every malformed graph/security fixture is rejected before writes; rollback leaves row counts unchanged.
- Run: `mise run typecheck`
- Expected: Versioned capability override DTOs compile across the Rust/TypeScript contract.

### Task 5: Add SQLite Read Snapshots for Aggregate Reads

**Outcome:** Exports, settings DTOs, and import previews observe one committed database state.

**Files:**

- Modify: `src-tauri/src/storage/database.rs`
- Modify: `src-tauri/src/storage/unit_of_work.rs`
- Modify: `src-tauri/src/services/import_export.rs`
- Modify: `src-tauri/src/services/settings.rs`
- Modify: `src-tauri/src/storage/tests.rs`
- Modify: `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] Add `Database::read_snapshot` that opens one runtime connection, starts a deferred read transaction, executes the closure against that transaction, and commits/rolls back without permitting writes through the API.
- [ ] Use `read_snapshot` for export Provider/model/profile/target/settings reads.
- [ ] Use `read_snapshot` for `SettingsService::get` so settings JSON and `proxyHasCredential` cannot come from different commits.
- [ ] Use one snapshot for import preview local Provider/model/profile/binding maps and busy checks.
- [ ] Add a test hook/barrier that commits an aggregate from a second connection between export queries. Assert the export contains either the complete old aggregate or complete new aggregate, never orphan models/targets.
- [ ] Add the equivalent settings/binding snapshot test.

**Validation:**

- Run: `mise run test read_snapshot`
- Expected: Concurrent writer tests prove aggregate reads remain internally consistent.

### Task 6: Implement Real Device-State Debouncing and Safe Geometry

**Outcome:** Geometry is written after inactivity, failed writes retain pending state, and maximized/off-screen data cannot corrupt startup behavior.

**Files:**

- Modify: `src-tauri/src/device_state.rs`
- Modify: `src-tauri/src/windows/main.rs`
- Modify: `src-tauri/src/windows/tray.rs`

**Steps:**

- [ ] Replace `schedule_main_window` plus immediate `maybe_flush` with one real delayed mechanism: keep a generation/deadline for the latest pending state and schedule a cancellable task that flushes only when its generation remains current after 300 ms.
- [ ] Ensure file I/O runs through `spawn_blocking` or a dedicated writer thread, not the Tauri event-loop callback.
- [ ] Serialize flushes so delayed and tray flushes cannot write concurrently.
- [ ] Change `flush` to clone/borrow pending state, write it, then clear pending only after successful persistence. On failure, retain pending for retry and preserve the previous durable file.
- [ ] Define tray-exit behavior explicitly: attempt final flush; on failure, emit a bounded log warning and preserve the previous durable state before exiting. Do not silently discard the error.
- [ ] Strengthen `WindowGeometry` validation: all fields finite, positive sizes, bounded dimensions, and a meaningful intersection with a current monitor work area.
- [ ] While maximized, update only `maximized = true`; preserve the last known normal rectangle instead of replacing it with maximized outer bounds.
- [ ] Clamp restored normal geometry to the selected monitor work area and center when no usable intersection remains.
- [ ] Add tests using a short injected debounce duration: one write after a burst, latest state wins, no early write, failed write retains pending, retry succeeds, maximized events preserve normal bounds, huge/non-finite/off-screen geometry falls back safely.

**Validation:**

- Run: `mise run test device_state::`
- Expected: Debounce, retry, geometry, and atomic-write tests pass.
- Run manually: `mise run tauri:dev`
- Expected: Moving/resizing persists after 300 ms without tray exit; maximizing/restoring retains the previous normal bounds; restart restores usable geometry.

### Task 7: Preserve the Last Successful Model Sync State

**Outcome:** Failed refreshes preserve the last successful synchronization timestamp while recording a bounded failure status.

**Files:**

- Modify: `src-tauri/src/repositories/provider_instances.rs`
- Modify: `src-tauri/src/services/models.rs`
- Modify: `src-tauri/src/repositories/tests.rs`
- Modify: `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] Add a failure-specific repository update that changes only `models_sync_status`, `models_sync_error_code`, and `updated_at`.
- [ ] Change `record_sync_error` to preserve `models_synced_at` from the last successful merge.
- [ ] Add success-then-failure tests asserting the timestamp remains unchanged and the bounded error code is stored.

**Validation:**

- Run: `mise run test model_sync_`
- Expected: Model merge and success-then-failure timestamp tests pass.

### Task 8: Sanitize Blocking Runtime Failures

**Outcome:** Panics or join failures cannot expose runtime diagnostics through Tauri IPC.

**Files:**

- Create: `src-tauri/src/cmds/runtime.rs`
- Create: `src-tauri/src/panic.rs`
- Modify: `src-tauri/src/cmds/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/cmds/providers.rs`
- Modify: `src-tauri/src/cmds/models.rs`
- Modify: `src-tauri/src/cmds/translation_profiles.rs`
- Modify: `src-tauri/src/cmds/settings.rs`
- Modify: `src-tauri/src/cmds/import_export.rs`
- Modify: `src-tauri/src/error.rs`

**Steps:**

- [ ] Implement one generic helper around `tauri::async_runtime::spawn_blocking` that maps service `StorageError` through `IpcError::from`.
- [ ] Map every task join/panic error to constant `{ code: "internal_error", message: "An internal error occurred" }`.
- [ ] Install a process-wide production panic hook before Tauri setup. The hook logs only a constant panic event and an optional static subsystem identifier; it must not format `PanicHookInfo::payload`, user input, SQL, vault diagnostics, or credential references.
- [ ] Keep the standard verbose hook only when explicitly running debug/test builds; release builds must use the sanitized hook.
- [ ] Log only a bounded event name and command identifier on join failure; do not interpolate the join error or panic payload.
- [ ] Replace duplicated raw `e.to_string()` mappings in every storage command module.
- [ ] Unit-test the panic-report formatter as a payload-free constant function and test serialized join-failure `IpcError` separately. Do not claim log redaction from an IPC-only assertion.

**Validation:**

- Run: `mise run test ipc_`
- Expected: Service and join failures map to stable sanitized IPC shapes.

### Task 9: Publish and Rotate Only Verified Backups

**Outcome:** A corrupt or partial snapshot cannot displace a valid recovery point.

**Files:**

- Modify: `src-tauri/src/storage/database.rs`
- Modify: `src-tauri/src/storage/migrations.rs`
- Modify: `src-tauri/src/storage/tests.rs`

**Steps:**

- [ ] Write migration backups to a same-directory `.partial` path.
- [ ] Complete `rusqlite::Backup`, sync/close the destination, reopen it read-only, run integrity check, and only then atomically rename it to the final `.sqlite3` filename.
- [ ] Remove or quarantine a failed `.partial` file; never let it match snapshot rotation.
- [ ] During rotation, open each candidate read-only and retain only files that pass integrity check. Rename corrupt candidates with an `.invalid` suffix before selecting the newest three valid snapshots.
- [ ] Refactor migration application to accept a test-only ordered migration slice so tests can execute a real version 1→2 success and a real failing second migration.
- [ ] Assert failed migration preserves source version/data, leaves a valid backup, and does not publish a corrupt snapshot.
- [ ] Create four verified snapshots plus one corrupt `.sqlite3`; run rotation and assert the newest three valid snapshots remain while the corrupt file is quarantined.

**Validation:**

- Run: `mise run test migration_`
- Expected: Real success, rollback, backup publication, integrity, and three-valid-snapshot rotation tests pass.

### Task 10: Complete Contract and Platform Lifecycle Coverage

**Outcome:** Cross-language DTO drift and platform credential lifecycle regressions are caught before release.

**Files:**

- Modify: `src-tauri/src/credentials/vault.rs`
- Modify: `src-tauri/src/credentials/tests.rs`
- Modify: `src-tauri/src/services/tests.rs`
- Modify: `src/storage/types.ts`
- Modify: `README.md`

**Steps:**

- [ ] Replace the direct native-vault smoke test with an RAII cleanup guard so the disposable account is deleted even when an assertion fails.
- [ ] Add the planned ignored native lifecycle test using a temporary SQLite database: create Provider with secret, reopen services, replace, clear, delete, and verify old/new entries are absent after each finalized operation.
- [ ] Add direct export coverage for `list_all_targets` by asserting a multi-profile fallback graph round trips exactly.
- [ ] Add representative Rust serialization snapshots and TypeScript `satisfies` fixtures for every command input/output family: Provider credentials, model capabilities, profiles/targets, settings/proxy credentials, import preview/result, and `IpcError`.
- [ ] Remove truly unused fields/methods reported by `cargo test`; for intentionally backend-only future APIs retained by this scope, add narrow `#[allow(dead_code)]` with a reason rather than module-wide suppression.
- [ ] Document the ignored native lifecycle command and platform requirements in README.

**Validation:**

- Run: `mise run test`
- Expected: All non-ignored tests pass without dead-code warnings introduced by the storage subsystem, except narrowly documented future APIs.
- Run on each release platform: `mise exec -- cargo test --manifest-path src-tauri/Cargo.toml native_vault_provider_lifecycle -- --ignored`
- Expected: Provider credential lifecycle succeeds and the cleanup guard leaves no disposable OS-vault entries.
- Run: `mise run typecheck`
- Expected: All TypeScript contract fixtures compile.

### Task 11: Update Storage Documentation

**Outcome:** Documentation matches the corrected runtime behavior and recovery guarantees.

**Files:**

- Modify: `docs/analysis/storage-architecture.md`
- Modify: `README.md`

**Steps:**

- [ ] State that journal deletion occurs only after successful/idempotent vault cleanup and that any other vault error retains recoverable metadata.
- [ ] Document per-owner recovery before credential mutation and startup recovery retry behavior.
- [ ] Document that import uses one normalized validated plan, clears only its own credential bindings, and finalizes exact operation IDs.
- [ ] Document SQLite read-snapshot requirements for export and aggregate DTOs.
- [ ] Document versioned capability overrides and last-successful model sync timestamp semantics.
- [ ] Document delayed device-state persistence and final-flush failure behavior.
- [ ] Update validation/test counts only after the final suite runs; do not hard-code expected counts before implementation.

**Validation:**

- Run: `mise exec -- prettier --check docs/analysis/storage-architecture.md docs/plans/2026-07-10-storage-subsystem-review-fix-plan.md README.md`
- Expected: All modified documentation follows repository formatting.

## Final Validation

- Run: `mise run test`
- Expected: All non-ignored Rust tests pass, including new failure-injection, concurrency, import graph, snapshot, debounce, migration, and IPC redaction tests.
- Run: `mise run test-frontend`
- Expected: Frontend mutation ordering and rollback tests pass.
- Run: `mise run typecheck`
- Expected: TypeScript DTOs, focused theme client, and contract fixtures compile without errors.
- Run: `mise run lint`
- Expected: ESLint reports no errors.
- Run: `mise run format:check`
- Expected: Prettier and rustfmt report no changes required.
- Run: `mise run build`
- Expected: Vite production build succeeds; the existing chunk-size warning is non-blocking and outside this fix scope.
- Run: `mise run tauri:build`
- Expected: The desktop application and bundled SQLite compile successfully on the current host platform.
- Run: `git diff --check && git diff --check --cached`
- Expected: No whitespace errors in working-tree or staged implementation changes.
- Run on Windows, macOS, and Linux desktop sessions: `mise exec -- cargo test --manifest-path src-tauri/Cargo.toml native_vault_provider_lifecycle -- --ignored`
- Expected: Native credential lifecycle passes with no leftover disposable entries.

## Rollout Notes

- Complete Tasks 1–5 before accepting any further Provider/settings feature work; they protect secrets and configuration consistency.
- Complete Task 6 before claiming window geometry is persisted during normal operation; the current implementation only reliably writes on tray exit.
- Task 2 explicitly unregisters import/export commands; Task 4 re-registers them only after normalized-plan tests pass. Do not distribute an artifact from the intermediate unregistered state.
- If the current schema has already shipped, introduce migration/document version changes rather than editing released V1 formats.
- Do not use passing unit tests as approval evidence until the new fault-injection and concurrency tests exist; the current 63 passing tests do not exercise the identified failure paths.

## Risks and Mitigations

- **Cleanup retries may block subsequent credential mutations.** — Recover the affected owner before mutation and return `credential_unavailable` only while the vault remains unreachable; never delete the journal to unblock artificially.
- **A committed configuration can coexist temporarily with deferred old-secret cleanup.** — Treat the business write as committed, keep `db_committed`, and retry exact cleanup without exposing either reference to the WebView.
- **Import validation can become duplicated across services.** — Extract reusable pure/connection-scoped validators and make both interactive saves and import normalization call them.
- **Concurrency tests can become timing-dependent.** — Use barriers/channels and injected hooks rather than sleeps to force the target interleaving deterministically.
- **Device-state scheduling can retain tasks during shutdown.** — Store one cancellable generation/task, serialize final flush, and make shutdown policy explicit.
- **Typed capability JSON changes existing local development rows.** — Because the branch is staged and assumed unreleased, reset or migrate local test databases; add a real V2 migration if any build has shipped.
- **Read transactions can be held too long.** — Build export/preview snapshots synchronously without vault or network calls, then release the transaction before serialization or cleanup I/O.
- **Backup verification adds migration latency.** — It runs only when migrations are pending; correctness takes priority over startup speed.
