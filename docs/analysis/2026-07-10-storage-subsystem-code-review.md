# Storage Subsystem Code Review

## Summary

**Target:** Staged changes on `feat/storage-subsystem`

**Conclusion:** Request changes.

The implementation substantially matches the approved architecture and passes the current automated suite. However, several untested failure and concurrency paths can orphan credentials, remove unrelated recovery records, misbind secrets, produce inconsistent exports, or persist invalid imported configuration. These findings must be fixed before merge.

## Validation Evidence

| Command                     | Result                                                 |
| --------------------------- | ------------------------------------------------------ |
| `mise run test`             | 63 passed, 1 ignored                                   |
| `mise run typecheck`        | Passed                                                 |
| `mise run lint`             | Passed                                                 |
| `mise run format:check`     | Passed                                                 |
| `mise run build`            | Passed; Vite emitted a non-blocking chunk-size warning |
| `git diff --check --cached` | Passed                                                 |

The passing suite does not exercise the injected vault failures, deterministic mutation races, malformed import graphs, delayed device-state writes, or real migration rollback scenarios described below.

## Findings

### R-001 — Credential journals are deleted after failed vault cleanup

**Severity:** Critical

**Evidence:**

- `src-tauri/src/services/providers.rs:231-247,288-303,338-343`
- `src-tauri/src/services/settings.rs:103-119,148-163`

Provider and proxy replacement/clear/delete paths ignore `CredentialVault::delete` failures and then delete the operation journal. A locked or unavailable OS vault can therefore retain the old or newly created secret while the only reference needed for later cleanup is lost.

**Required fix:** Delete an operation journal only after idempotent vault cleanup succeeds. Retain `prepared` or `db_committed` for every other error and retry exact operations on startup and before owner mutations.

### R-002 — Import removes unrelated committed credential journals

**Severity:** Critical

**Evidence:** `src-tauri/src/services/import_export.rs:101-114`

After import, the service scans all unfinished operations and deletes every `db_committed` row, not only rows created by that import. An unrelated deferred cleanup can become permanently unrecoverable.

**Required fix:** Return complete import-owned `CredentialOperation` values from the transaction and finalize only those exact operations.

### R-003 — `Keep` mutations can race credential replacement

**Severity:** High

**Evidence:**

- `src-tauri/src/services/providers.rs:145-168`
- `src-tauri/src/repositories/provider_instances.rs:85-105`
- `src-tauri/src/services/settings.rs:26-55`

Provider `Keep` rebuilds and writes an earlier `credential_ref`. Proxy `Keep` validates before entering the write transaction. Concurrent replace/clear operations can restore stale references or bind a credential to a changed endpoint.

**Required fix:** Serialize owner mutations, re-read inside the write transaction, check unfinished operations, and update configuration without writing a stale credential reference.

### R-004 — Import bypasses complete validation

**Severity:** High

**Evidence:**

- `src-tauri/src/services/import_export.rs:125-182,320-348,351-368,472-478`
- `src-tauri/src/repositories/provider_models.rs:123-149`

Preview validates only selected fields. Apply writes directly through repositories. Duplicate IDs, unknown adapters, orphan targets, empty fallback chains, invalid options, and cross-Provider model UUID collisions are not consistently rejected.

**Required fix:** Build a normalized, self-contained import plan with complete entity and relationship validation. Rebuild/revalidate it inside the import write transaction before applying.

### R-005 — Proxy URL validation can be bypassed

**Severity:** High

**Evidence:** `src-tauri/src/services/settings.rs:193-201`

System mode accepts any non-null `proxy_url`; import only checks settings schema version. A URL such as `http://user:secret@host` can be persisted and exported in plaintext.

**Required fix:** Require null URL in system mode and apply the full URL validator during interactive updates, preview, and import.

### R-006 — Aggregate reads are not SQLite snapshots

**Severity:** High

**Evidence:**

- `src-tauri/src/services/import_export.rs:34-40`
- `src-tauri/src/services/settings.rs:26-34`
- `src-tauri/src/storage/database.rs:169-174`

Multiple SELECT statements run in autocommit mode. A concurrent commit can produce exports with orphan models/targets or settings DTOs whose JSON and credential flag come from different states.

**Required fix:** Add and use an explicit deferred read transaction for aggregate reads.

### R-007 — Device-state debounce does not perform delayed writes

**Severity:** High

**Evidence:**

- `src-tauri/src/device_state.rs:89-119`
- `src-tauri/src/windows/main.rs:22-28`
- `src-tauri/src/windows/tray.rs:24-29`

Each event resets the timestamp and immediately checks elapsed time, so normal use never reaches the debounce duration. `flush` removes pending state before writing, and tray exit ignores write failures.

**Required fix:** Schedule a real delayed write, serialize writers, retain pending state on failure, and handle final-flush failure explicitly.

### R-008 — Theme writes are unordered whole-document updates

**Severity:** High

**Evidence:**

- `src/theme/useTheme.ts:34-64`
- `src/components/ThemeToggle.tsx:10-20`
- `src-tauri/src/services/settings.rs:26-55`

Rapid toggles can complete out of order, and each toggle overwrites the full settings document read earlier. The component also discards the persistence error.

**Required fix:** Add a focused atomic theme command, queue frontend writes in user-action order, rollback only the latest failed mutation, and expose errors accessibly.

### R-009 — Credential recovery state is discarded and not retried

**Severity:** Medium

**Evidence:**

- `src-tauri/src/state.rs:21-34`
- `src-tauri/src/services/providers.rs:349-423`

Startup recovery returns no result, `vault_available` is always true and unused, and later mutations do not retry recovery. A temporary outage can leave an owner permanently `credential_busy` until restart.

**Required fix:** Return a recovery report and retry owner recovery before each credential mutation/import preflight.

### R-010 — Failed model refresh erases last successful sync time

**Severity:** Medium

**Evidence:**

- `src-tauri/src/services/models.rs:113-125`
- `src-tauri/src/repositories/provider_instances.rs:171-186`

`record_sync_error` writes `models_synced_at = NULL`, breaking stale-cache age semantics.

**Required fix:** Update only status, bounded error code, and `updated_at` on failure.

### R-011 — Blocking-task join errors expose raw runtime text

**Severity:** Medium

**Evidence:** `src-tauri/src/cmds/*.rs`

Each command maps `spawn_blocking` join errors through `e.to_string()`. Panic payloads or dependency diagnostics can cross the intended sanitized IPC boundary. The default Rust panic hook can also emit payload text before the join error is handled.

**Required fix:** Centralize blocking dispatch, return a constant IPC error, and install a production-safe panic hook that never formats payload text.

### R-012 — Backup rotation does not verify candidates

**Severity:** Medium

**Evidence:**

- `src-tauri/src/storage/database.rs:122-164`
- `src-tauri/src/storage/tests.rs:267-288`

Snapshots are published directly to `.sqlite3`, and rotation trusts extension/mtime. A partial or corrupt recent file can displace an older valid recovery point. Tests do not exercise a real failing migration.

**Required fix:** Write/verify a partial snapshot before atomic publication, rotate only integrity-checked snapshots, and add real success/failure migration tests.

### R-013 — Capability overrides are arbitrary unversioned JSON

**Severity:** Medium

**Evidence:**

- `src-tauri/src/domain/model.rs`
- `src-tauri/src/services/models.rs:41-70`
- `src/storage/types.ts:49-66`

Malformed or future-incompatible fields can enter the authoritative database.

**Required fix:** Define and validate a versioned sparse capability override DTO during manual writes and import.

### R-014 — Geometry validation and maximized-state handling are incomplete

**Severity:** Medium

**Evidence:**

- `src-tauri/src/device_state.rs:17-38,133-143`
- `src-tauri/src/windows/main.rs:35-52,110-132`

Huge finite dimensions can pass basic checks, and maximized outer bounds overwrite the normal restore rectangle.

**Required fix:** Validate finite/bounded geometry against monitor work areas and retain the last normal rectangle while maximized.

### R-015 — Contract and platform lifecycle coverage is incomplete

**Severity:** Low

**Evidence:**

- `src-tauri/src/credentials/vault.rs:151-159`
- `src/storage/types.ts:194-226`
- Current compiler warnings from `mise run test`

The ignored native test lacks failure-safe cleanup and does not cover SQLite/journal lifecycle. Only two frontend contract fixtures exist. Several backend APIs emit dead-code warnings.

**Required fix:** Add RAII native lifecycle coverage, complete DTO fixtures/snapshots, and remove or narrowly annotate intentionally retained APIs.

## Positive Observations

- SQLite, native vault, and device-state responsibilities are separated as designed.
- SQL/file/vault access remains Rust-owned; Tauri capabilities were not broadened.
- Database constraints and repository transaction usage cover the main CRUD paths.
- Credential values and references are absent from normal IPC DTOs and exports.
- Existing tests, type checking, linting, formatting, and production frontend build all pass.

## Conclusion

Request changes before merge. Fix R-001 through R-008 first; they protect secret recoverability and configuration integrity. R-009 through R-014 should also be completed in this branch because they affect the promised storage behavior. R-015 is release-hardening work and can be completed last, but before cross-platform release validation.
