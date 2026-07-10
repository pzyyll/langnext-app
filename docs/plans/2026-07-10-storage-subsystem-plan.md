# Storage Subsystem Implementation Plan

**Goal:** Build a Rust-owned persistence subsystem that stores portable AI Provider configuration in SQLite, protects secrets in native OS credential stores, persists device-only state separately, and exposes a sanitized typed IPC API to React.

**Inputs:** `docs/analysis/storage-architecture.md` and the product decisions recorded during the storage design interview.

**Assumptions:**

- This plan delivers the complete storage boundary and typed CRUD/import/export IPC, but not Provider HTTP adapters, live model-list requests, translation execution, or settings screens.
- Provider model synchronization includes the deterministic cache-merge algorithm and tests; a future Provider adapter calls it after receiving a remote model list.
- A non-`none` Provider may temporarily have no `credential_ref`. This represents the agreed “needs authentication” state after creation, credential removal, or secret-free import. The initial schema will therefore enforce only that `credential_kind = 'none'` has a null reference.
- Durable internal `app_credentials` and `credential_operations` tables store the global-proxy credential binding and crash-recovery journal because the native keyring API cannot reliably enumerate all application entries on every platform.
- UUIDv7 identifies user-created entities. UTC timestamps are stored as RFC 3339 text; filenames use a Windows-safe compact UTC format without colons.
- The current Rust toolchain (`rustc 1.96.1`) satisfies the `keyring 4.1.4` and `time 0.3.53` minimum Rust requirements.

**Architecture:** SQLite is the source of truth for portable business configuration and is accessed only by Rust through repositories and application services. Secrets remain in the native platform credential store behind a private Rust interface, while machine-specific state uses a versioned JSON file. Thin Tauri commands dispatch blocking work away from the WebView boundary and return DTOs that omit credentials and credential references.

**Tech Stack:** Tauri 2.11, Rust 2021, `rusqlite 0.40.1` with `bundled` and `backup`, `keyring 4.1.4`, `uuid 1.23.4`, `time 0.3.53`, Serde, `thiserror 2.0.18`, `url 2`, `tempfile 3.27`, React 19, TypeScript 6, mise.

---

## Scope Boundaries

### Included

- SQLite lifecycle, PRAGMAs, migrations, integrity checks, and rotating pre-migration snapshots
- Provider instance, model, translation profile, fallback target, and application settings persistence
- Native credential-vault integration and crash-safe credential replacement
- Provider/model/profile/settings application services and validation
- Remote model cache-merge behavior without network transport
- Versioned device-state storage and main-window geometry integration
- Versioned secret-free JSON import/export with preview, merge, and copy modes
- Sanitized Tauri commands and a typed React IPC client
- Migration of the existing theme preference so SQLite is authoritative in Tauri while `localStorage` remains only a pre-paint/browser-development cache
- Rust unit/integration tests and project validation tasks

### Excluded

- Provider HTTP adapters and real `/models` calls
- Translation requests, streaming output, fallback execution, and request metrics
- Provider/settings/profile management screens
- Translation history, favorites, terminology, and request/response persistence
- Cloud synchronization, multiple users/workspaces, SQLCipher, and executable Provider plugins
- Frontend-owned SQL, filesystem access, or credential access

## File Map

### Project configuration and bootstrap

- Modify: `src-tauri/Cargo.toml` — add verified persistence, credential, ID, timestamp, URL, error, and test dependencies.
- Modify: `src-tauri/src/lib.rs` — initialize managed application state and register storage commands while preserving existing shell setup.
- Modify: `src-tauri/src/cmds/mod.rs` — export new command modules without changing existing demo and snap commands.
- Modify: `src-tauri/src/consts.rs` — define database, backup directory, device-state filename, and credential service-name constants.
- Modify: `src-tauri/src/windows/main.rs` — restore validated window geometry and persist move/resize state through the device-state service.
- Modify: `src-tauri/src/windows/tray.rs` — flush pending device-state writes before application exit.
- Create: `.mise/tasks/test` — run Rust tests through mise and forward optional test filters.

### Domain and errors

- Create: `src-tauri/src/error.rs` — typed internal errors and sanitized IPC errors.
- Create: `src-tauri/src/domain/mod.rs` — domain module exports.
- Create: `src-tauri/src/domain/provider.rs` — Provider entities, enums, write inputs, and safe DTOs.
- Create: `src-tauri/src/domain/model.rs` — model entities, source/availability enums, synchronization inputs, and DTOs.
- Create: `src-tauri/src/domain/translation_profile.rs` — profile, validated templates, ordered model targets, and DTOs.
- Create: `src-tauri/src/domain/settings.rs` — versioned `AppSettings`, network settings, and defaults.
- Create: `src-tauri/src/domain/import_export.rs` — versioned export document, preview, conflict mode, and import result types.
- Create: `src-tauri/src/domain/time.rs` — shared RFC 3339 UTC serialization helpers.

### SQLite and repositories

- Create: `src-tauri/migrations/0001_initial.sql` — initial portable configuration and credential-operation schema.
- Create: `src-tauri/src/storage/mod.rs` — storage module exports.
- Create: `src-tauri/src/storage/database.rs` — connection creation, PRAGMAs, transactions, integrity checks, backups, and migration entry point.
- Create: `src-tauri/src/storage/migrations.rs` — ordered embedded migration runner using `PRAGMA user_version`.
- Create: `src-tauri/src/storage/unit_of_work.rs` — transaction-scoped repository access for multi-aggregate writes.
- Create: `src-tauri/src/storage/tests.rs` — database lifecycle, PRAGMA, migration, backup, and constraint tests.
- Create: `src-tauri/src/repositories/mod.rs` — repository module exports.
- Create: `src-tauri/src/repositories/provider_instances.rs` — Provider CRUD and credential-reference updates.
- Create: `src-tauri/src/repositories/provider_models.rs` — model CRUD and synchronization writes.
- Create: `src-tauri/src/repositories/translation_profiles.rs` — profile and fallback-chain transactional persistence.
- Create: `src-tauri/src/repositories/app_settings.rs` — singleton settings document persistence.
- Create: `src-tauri/src/repositories/app_credentials.rs` — non-exported global proxy credential binding.
- Create: `src-tauri/src/repositories/credential_operations.rs` — credential journal persistence and recovery queries.
- Create: `src-tauri/src/repositories/tests.rs` — repository behavior and referential-integrity tests.

### Credentials, services, and device state

- Create: `src-tauri/src/credentials/mod.rs` — credential module exports.
- Create: `src-tauri/src/credentials/vault.rs` — `CredentialVault` trait and native `keyring` implementation.
- Create: `src-tauri/src/credentials/refs.rs` — opaque application-owned reference generation.
- Create: `src-tauri/src/credentials/tests.rs` — non-production in-memory vault and compensation/recovery tests.
- Create: `src-tauri/src/adapters/mod.rs` — metadata-only adapter catalog and profile-option validation contract.
- Create: `src-tauri/src/adapters/catalog.rs` — built-in adapter IDs/default metadata; no HTTP behavior.
- Create: `src-tauri/src/services/mod.rs` — service module exports.
- Create: `src-tauri/src/services/providers.rs` — Provider validation, CRUD, and credential orchestration.
- Create: `src-tauri/src/services/models.rs` — manual model CRUD and remote-cache merge algorithm.
- Create: `src-tauri/src/services/translation_profiles.rs` — template/parameter validation and profile writes.
- Create: `src-tauri/src/services/settings.rs` — typed settings reads and updates.
- Create: `src-tauri/src/services/import_export.rs` — export, preview, merge, copy, UUID rewriting, and transactional import.
- Create: `src-tauri/src/services/tests.rs` — service validation, rollback, cache merge, and privacy tests.
- Create: `src-tauri/src/device_state.rs` — atomic versioned JSON reads/writes for machine-specific state.

### Tauri IPC and frontend client

- Create: `src-tauri/src/state.rs` — managed `AppState` containing database path, services, and device-state handle.
- Create: `src-tauri/src/cmds/providers.rs` — sanitized Provider CRUD commands.
- Create: `src-tauri/src/cmds/models.rs` — model CRUD commands.
- Create: `src-tauri/src/cmds/translation_profiles.rs` — profile and fallback-chain commands.
- Create: `src-tauri/src/cmds/settings.rs` — portable settings commands.
- Create: `src-tauri/src/cmds/import_export.rs` — export/preview/import commands.
- Create: `src/storage/types.ts` — frontend-safe DTO and command-input types.
- Create: `src/storage/client.ts` — typed `invoke` wrappers; no SQL, files, or credential APIs.
- Create: `src/storage/bootstrap.ts` — load authoritative settings in Tauri and synchronize the pre-paint theme cache.
- Modify: `src/main.tsx` — complete storage bootstrap before mounting React in Tauri.
- Modify: `src/theme/theme.ts` — separate immediate DOM/cache application from authoritative settings persistence.
- Modify: `src/theme/useTheme.ts` — persist theme changes through the settings client and roll back on failure.
- Modify: `index.html` — retain `localStorage` only as a pre-paint cache to avoid theme flashing.

Every new Rust, TypeScript, shell, and SQL code file must begin with two syntax-appropriate `ABOUTME:` comment lines.

## Tasks

### Task 1: Add Verified Dependencies and Test Task

**Outcome:** The project has the exact backend dependencies and a mise-owned Rust test command, with no frontend storage plugin or capability expansion.

**Files:**

- Modify: `src-tauri/Cargo.toml`
- Create: `.mise/tasks/test`

**Steps:**

- [ ] Preserve the untracked analysis/plan documents, then create `feat/storage-subsystem` in the current worktree with `git switch -c feat/storage-subsystem`; this satisfies the dedicated-branch rule without losing untracked inputs in a newly created worktree.
- [ ] Add `rusqlite = { version = "0.40.1", features = ["bundled", "backup"] }`.
- [ ] Add `keyring = "4.1.4"`; retain its default native backend set, which uses macOS Keychain, Windows Credential Manager, and Linux Secret Service.
- [ ] Add `uuid = { version = "1.23.4", features = ["v7", "serde"] }`.
- [ ] Add `time = { version = "0.3.53", features = ["formatting", "parsing", "serde", "serde-well-known"] }`.
- [ ] Add `thiserror = "2.0.18"` and `url = "2"`.
- [ ] Add `tempfile = "3.27.0"` as a regular dependency because production device-state writes use `NamedTempFile`; no separate dev dependency is needed.
- [ ] Create `.mise/tasks/test` with two `ABOUTME:` lines, a bash shebang, executable mode, a mise description, `set -euo pipefail`, and `cargo test --manifest-path src-tauri/Cargo.toml "$@"` so commands such as `mise run test storage` actually filter tests.
- [ ] Do not add `tauri-plugin-sql`, `tauri-plugin-store`, frontend packages, package scripts, or permissions to `src-tauri/capabilities/default.json`.

**Validation:**

- Run: `mise run test`
- Expected: Existing Rust tests compile and pass; Cargo resolves the new dependencies and updates `src-tauri/Cargo.lock`.
- Run: `git diff -- src-tauri/capabilities/default.json package.json`
- Expected: No changes.

### Task 2: Define Domain Types and Sanitized Errors

**Outcome:** Storage entities have one strongly typed Rust representation, and all command-visible failures use bounded, secret-free errors.

**Files:**

- Create: `src-tauri/src/error.rs`
- Create: `src-tauri/src/domain/mod.rs`
- Create: `src-tauri/src/domain/provider.rs`
- Create: `src-tauri/src/domain/model.rs`
- Create: `src-tauri/src/domain/translation_profile.rs`
- Create: `src-tauri/src/domain/settings.rs`
- Create: `src-tauri/src/domain/import_export.rs`
- Create: `src-tauri/src/domain/time.rs`
- Modify: `src-tauri/src/lib.rs`

**Steps:**

- [ ] Define `StorageError` variants for I/O, SQLite, migration, serialization, validation, not found, conflict/in-use, credential access, and unavailable credential store.
- [ ] Define serializable `IpcError { code: String, message: String }`; map internal errors to stable codes such as `validation_failed`, `not_found`, `in_use`, `credential_unavailable`, `storage_unavailable`, and `internal_error`.
- [ ] Ensure `IpcError` never includes SQL statements, raw keyring errors, credential references, URL userinfo, API response bodies, or secret input.
- [ ] Define Provider enums exactly as `CredentialKind::{None, ApiKey, Bearer}`, `ProxyMode::{Inherit, Direct}`, and `ModelsSyncStatus::{Never, Ok, Error}`.
- [ ] Define model enums exactly as `ModelSource::{Remote, Manual, Builtin}` and `Availability::{Available, Missing, Unknown}`.
- [ ] Define separate internal entities and IPC DTOs. `ProviderInstanceDto` must expose `has_credential: bool` and must not expose `credential_ref`.
- [ ] Define `CredentialUpdate::{Keep, Replace(String), Clear}` for Provider write input. Apply a custom `Debug` implementation or omit `Debug` so `Replace` never prints its value.
- [ ] Define `AppSettingsV1` with UI language, nullable `theme` (`null` only before first authoritative initialization), optional default profile UUID, translation preferences, shortcut definitions, and global proxy mode/URL. Define `AppSettingsDto` with derived `proxyHasCredential`; keep the proxy credential reference and secret outside the portable document.
- [ ] Define `ProxyCredentialUpdate::{Keep, Replace(String), Clear}` with the same secret-redaction guarantees as Provider credential input.
- [ ] Define versioned import/export DTOs using `formatVersion = 1` at the JSON boundary.
- [ ] Add shared UUIDv7 and RFC 3339 UTC helpers so repositories never hand-roll identifiers or timestamp formats.
- [ ] Declare modules in `lib.rs` without changing application behavior yet.

**Validation:**

- Run: `mise run test`
- Expected: Domain serialization round trips and error-redaction tests pass.
- Run: `mise run format:check`
- Expected: Rust formatting and existing frontend formatting pass.

### Task 3: Create the Initial SQLite Schema and Database Lifecycle

**Outcome:** A fresh application database is created with enforced constraints, and reopening it is idempotent.

**Files:**

- Create: `src-tauri/migrations/0001_initial.sql`
- Create: `src-tauri/src/storage/mod.rs`
- Create: `src-tauri/src/storage/database.rs`
- Create: `src-tauri/src/storage/migrations.rs`
- Create: `src-tauri/src/storage/tests.rs`
- Modify: `src-tauri/src/consts.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `docs/analysis/storage-architecture.md`

**Steps:**

- [ ] Add constants for `langnext.sqlite3`, `backups`, `device-state.json`, and credential service name `com.balaenis.langnext-app`.
- [ ] Create the application-data directory before opening a new database, backup, device-state file, or credential metadata.
- [ ] Implement `Database { path: PathBuf }`; open a new configured connection per operation rather than sharing one `Connection` across asynchronous commands.
- [ ] For an existing database, first open a read-only probe connection to read `user_version` and run integrity checks without changing journal mode or creating sidecars; reject corrupt or newer-version databases before any writable open.
- [ ] After successful probing/migration, configure runtime connections with `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, and a 5-second busy timeout.
- [ ] Implement `Database::read`, `Database::write`, and `Database::transaction` closures plus a transaction-scoped `UnitOfWork` whose repositories all borrow the same `rusqlite::Transaction`. Keep transaction closures synchronous and prohibit holding a transaction over keyring or network operations.
- [ ] Embed ordered SQL migrations with `include_str!` and track the applied schema with `PRAGMA user_version`.
- [ ] Before writing the migration, update the Provider DDL in `docs/analysis/storage-architecture.md` so a non-`none` Provider may have a null credential reference and explicitly define that state as `needs authentication`.
- [ ] Create the five business tables defined in `docs/analysis/storage-architecture.md`: `provider_instances`, `provider_models`, `translation_profiles`, `translation_profile_models`, and `app_settings`.
- [ ] Use Provider constraint `CHECK (credential_kind <> 'none' OR credential_ref IS NULL)`, allowing `api_key` and `bearer` instances to exist without a configured credential.
- [ ] Add internal table `app_credentials(slot PRIMARY KEY, credential_ref, updated_at)` with the only initial slot `global_proxy`; it is never exported.
- [ ] Add internal table `credential_operations(id, owner_kind, owner_id, expected_old_ref, new_ref, state, created_at)` with states `prepared` and `db_committed`; add a unique index on `(owner_kind, owner_id)` so only one unfinished mutation can exist for a Provider or the singleton global proxy. This table is never exported.
- [ ] Preserve `ON DELETE RESTRICT` from models to Providers and profile targets to models; preserve `ON DELETE CASCADE` only from profile targets to their owning profile.
- [ ] Seed `app_settings(id = 1, schema_version = 1, value_json = default AppSettingsV1)` during first migration/application initialization.
- [ ] Before migration, execute `PRAGMA integrity_check`; return a startup-blocking storage error unless the single result is `ok`.
- [ ] Tests must cover fresh creation, reopen idempotence, `user_version = 1`, active foreign keys, WAL mode, busy timeout, credential-state constraint, model uniqueness, profile priority uniqueness, and every delete rule.

**Validation:**

- Run: `mise run test storage`
- Expected: All database lifecycle and schema constraint tests pass against real temporary SQLite files.

### Task 4: Implement SQLite Repositories

**Outcome:** Services can manipulate each aggregate through focused repository APIs without embedding SQL in commands.

**Files:**

- Create: `src-tauri/src/repositories/mod.rs`
- Create: `src-tauri/src/repositories/provider_instances.rs`
- Create: `src-tauri/src/repositories/provider_models.rs`
- Create: `src-tauri/src/repositories/translation_profiles.rs`
- Create: `src-tauri/src/repositories/app_settings.rs`
- Create: `src-tauri/src/repositories/app_credentials.rs`
- Create: `src-tauri/src/repositories/credential_operations.rs`
- Create: `src-tauri/src/repositories/tests.rs`
- Modify: `src-tauri/src/lib.rs`

**Steps:**

- [ ] Implement Provider operations: list, get, insert, update configuration, set enabled, update credential reference, and delete.
- [ ] Implement model operations: list by Provider, get, insert/update manual model, set enabled, update aliases/capability overrides, delete, and apply remote synchronization rows.
- [ ] Implement profile operations: list, get with ordered targets, insert/update profile plus complete target replacement in one transaction, set enabled, and delete.
- [ ] Implement settings operations: get singleton and update singleton while preserving `id = 1` and validating the document schema version.
- [ ] Implement global proxy credential-binding operations: get reference, compare-and-set reference against an expected old value, and clear reference.
- [ ] Implement credential-operation journal methods: insert prepared operation, mark database committed, list unfinished operations, and delete completed operation.
- [ ] Make every repository operation accept either a connection/transaction executor or a transaction-scoped `UnitOfWork`, so profile saves, model merge/status updates, credential commits, and imports cannot accidentally open independent transactions.
- [ ] Bind all SQL values; do not build SQL using user-supplied strings.
- [ ] Convert database uniqueness violations to `Conflict` and foreign-key delete violations to `InUse`.
- [ ] Validate JSON columns by deserializing them into their owning typed structures before writes.
- [ ] Add tests for all CRUD paths, duplicate model IDs per Provider, the same model ID across different Providers, fallback ordering, transaction rollback, singleton settings, global proxy binding compare-and-set, one-active-journal-operation uniqueness, and delete restrictions.

**Validation:**

- Run: `mise run test repositories`
- Expected: Repository tests pass and failed aggregate writes leave no partial rows.

### Task 5: Implement Native Credential Storage and Crash Recovery

**Outcome:** Secrets are stored only in the native OS vault, can never be returned through IPC, and survive process crashes without losing the previously valid credential.

**Files:**

- Create: `src-tauri/src/credentials/mod.rs`
- Create: `src-tauri/src/credentials/vault.rs`
- Create: `src-tauri/src/credentials/refs.rs`
- Create: `src-tauri/src/credentials/tests.rs`
- Create: `src-tauri/src/services/mod.rs`
- Create: `src-tauri/src/services/providers.rs`
- Create: `src-tauri/src/services/settings.rs`

**Steps:**

- [ ] Define private trait `CredentialVault` with `set`, `get_for_backend_use`, `delete`, and `exists`; do not expose the trait through Tauri commands.
- [ ] Implement `NativeCredentialVault` using `keyring::Entry::new(service, account)`, `set_password`, `get_password`, and `delete_credential`.
- [ ] Use credential account names `provider/<provider-uuid>/<operation-uuid>` and `proxy/global/<operation-uuid>` so replacement writes never overwrite the currently referenced entry.
- [ ] Serialize mutations through the journal's unique `(owner_kind, owner_id)` index. A second replace, clear, delete, settings update, or import for the same owner returns `credential_busy`; SQLite reference updates use compare-and-set against `expected_old_ref` so stale commands cannot commit out of order.
- [ ] Enforce this Provider transition matrix: target `none` rejects `Replace`; `none + Keep` is valid only when the current kind is already `none` with no reference; changing an authenticated Provider to `none` requires `Clear`; target `api_key`/`bearer` permits `Keep`, `Replace`, or `Clear`; `Keep` with no existing reference preserves the `needs authentication` state; changing `adapter_id` or effective base URL while a reference exists rejects `Keep` and requires `Replace` or `Clear` so a secret is never silently sent to a different endpoint.
- [ ] Implement Provider creation with `credential_kind = none` without a vault write; `api_key`/`bearer` may begin unconfigured or receive `CredentialUpdate::Replace`.
- [ ] Implement Provider credential replacement as: journal `prepared` → write new vault entry → one SQLite transaction compare-and-sets the old credential reference, updates the complete validated Provider configuration (including adapter, URL, and credential kind), and marks the journal `db_committed` → delete old vault entry → remove journal row.
- [ ] Implement Provider clear with the same flow but a null `new_ref`; the same SQLite transaction writes the complete Provider configuration.
- [ ] Implement global proxy replacement/clear so one SQLite transaction updates `AppSettings` proxy mode/URL, compare-and-sets `app_credentials`, and marks the journal `db_committed`; never commit endpoint configuration separately from its credential binding.
- [ ] Implement Provider deletion as one SQLite transaction that verifies `ON DELETE RESTRICT`, deletes the Provider, and inserts a `db_committed` cleanup journal containing the old reference; after commit, delete the vault entry and remove the journal. A restricted delete rolls back without creating a journal row.
- [ ] `update_app_settings` accepts `ProxyCredentialUpdate`; if a new proxy URL differs from the current URL, `Keep` is rejected to prevent sending old credentials to a different endpoint.
- [ ] On any pre-commit failure, delete a newly written vault entry and preserve the old binding.
- [ ] Implement startup recovery: for `prepared`, compare the current owner binding with `new_ref` and either delete the unused new entry or complete old-entry deletion; for `db_committed`, delete the old entry and clear the journal. Provider-deletion recovery treats an absent Provider as committed cleanup.
- [ ] Treat “credential not found” as idempotent success during cleanup; treat vault-unavailable as a bounded recoverable startup diagnostic and leave the journal row for the next launch.
- [ ] Define `has_credential` and `proxyHasCredential` strictly as “a SQLite credential reference exists”; vault availability is reported separately when backend use is attempted.
- [ ] Use an in-memory `CredentialVault` only under `#[cfg(test)]`; there is no production mock mode.
- [ ] Add tests for the complete transition matrix, Provider deletion with/without references, proxy replace/clear/URL change, compare-and-set failure, concurrent mutation rejection, crash at each journal state, idempotent recovery, and secret-free `Debug`/error output.
- [ ] Add ignored platform smoke tests that set/read/delete a disposable entry in the real OS vault; document that they require an interactive user session.

**Validation:**

- Run: `mise run test credentials`
- Expected: Compensation and crash-recovery tests pass without accessing the real OS vault.
- Run manually on each release platform: `mise exec -- cargo test --manifest-path src-tauri/Cargo.toml native_vault_smoke -- --ignored`
- Expected: A disposable credential is created, read by Rust, and deleted from the native platform store.

### Task 6: Implement Provider, Model, Profile, and Settings Services

**Outcome:** All agreed business rules are enforced in Rust before repository writes.

**Files:**

- Create: `src-tauri/src/adapters/mod.rs`
- Create: `src-tauri/src/adapters/catalog.rs`
- Create: `src-tauri/src/services/models.rs`
- Create: `src-tauri/src/services/translation_profiles.rs`
- Create: `src-tauri/src/services/tests.rs`
- Modify: `src-tauri/src/services/settings.rs`
- Modify: `src-tauri/src/services/providers.rs`
- Modify: `src-tauri/src/lib.rs`

**Steps:**

- [ ] Implement a metadata-only adapter catalog containing `openai-compatible`, `anthropic`, and `gemini`; expose adapter ID/default base URL plus `validate_profile_options`. Until real adapter schemas land, each built-in accepts only null or an empty JSON object and rejects non-empty Provider-specific options rather than storing unchecked data.
- [ ] Validate Provider URLs with `url::Url`: allow HTTPS; allow HTTP loopback hosts; require `insecure_http_confirmed_at` for all other HTTP hosts; reject non-HTTP schemes, userinfo, query strings, and fragments so exported base URLs cannot carry secrets.
- [ ] Enforce Provider deletion through repository constraints and return `in_use` with no cascading deletion.
- [ ] Validate manual model IDs as non-empty bounded strings and preserve uniqueness within a Provider instance.
- [ ] Implement pure model synchronization merge behavior: upsert returned remote models, mark them available, update `last_seen_at`, mark only absent `remote` records missing, and preserve enabled state, aliases, and capability overrides. When a returned `model_key` collides with an existing manual/builtin row, keep its source as manual/builtin, update non-user remote metadata/`last_seen_at`, and do not make it eligible for future remote-missing marking.
- [ ] Update Provider `models_synced_at` and `models_sync_status = ok` only in the same database transaction as a successful merge.
- [ ] Record only bounded `models_sync_error_code` values such as `auth`, `rate_limited`, `network`, `timeout`, `server`, and `invalid_response`; never store response bodies.
- [ ] Parse translation templates on save. Permit only `source_language`, `target_language`, and `text`; reject unknown variables and require `text` exactly once in the user template.
- [ ] Validate profile targets: at least one target, unique models, contiguous priorities beginning at `0`, and no disabled/missing requirement at edit time.
- [ ] Validate `temperature >= 0`, `max_output_tokens > 0`, and adapter-owned `provider_options_json` before save.
- [ ] Validate `AppSettings.default_profile_id` when non-null; return a validation error instead of silently selecting another profile.
- [ ] Validate global proxy mode as `system` or `custom`; require an HTTP/SOCKS5 URL for custom mode; reject proxy URL userinfo, query strings, and fragments; keep proxy credentials out of `value_json`.
- [ ] Add tests for every validation rule, model merge state transition, fallback ordering, and settings default-profile behavior.

**Validation:**

- Run: `mise run test services`
- Expected: All service rules and transaction-boundary tests pass.

### Task 7: Persist and Restore Device State

**Outcome:** Window geometry survives restart without entering SQLite or exported configuration, and corrupt state safely falls back to defaults.

**Files:**

- Create: `src-tauri/src/device_state.rs`
- Modify: `src-tauri/src/windows/main.rs`
- Modify: `src-tauri/src/windows/tray.rs`
- Modify: `src-tauri/src/lib.rs`

**Steps:**

- [ ] Define `DeviceStateV1 { format_version, main_window }` and a window geometry structure containing logical position, logical size, and maximized state.
- [ ] Resolve `<app-data>/device-state.json` through Tauri 2 `app.path().resolve(..., BaseDirectory::AppData)` and create the parent directory before the first read/write.
- [ ] Load missing state as defaults. Rename invalid JSON to `device-state.invalid-<YYYYMMDDTHHMMSSZ>.json` and continue with defaults without touching SQLite.
- [ ] Write state with `tempfile::NamedTempFile::new_in` in the same directory, flush and sync it, then call `persist` to replace the destination atomically on supported platforms; serialize writes through one Rust mutex and surface persistence failures without corrupting the previous file.
- [ ] In `windows/main.rs`, apply validated size/position before showing the main window. Reject non-positive sizes and geometry entirely outside all current monitors; center the window when rejected.
- [ ] Subscribe to move, resize, and maximize changes; debounce writes so active dragging does not write on every event.
- [ ] Expose `DeviceStateManager::flush`; call it in `windows/tray.rs` before `app.exit(0)` so a pending debounced update is not lost.
- [ ] Keep close-to-hide behavior unchanged.
- [ ] Add tests for missing file, round trip, invalid schema version, corrupt JSON quarantine, and invalid geometry fallback.

**Validation:**

- Run: `mise run test device_state`
- Expected: File and validation tests pass.
- Run: `mise run tauri:dev`
- Expected: Move/resize/maximize the window, exit through the tray, restart, and observe restored valid geometry; deleting `device-state.json` resets only the window state.

### Task 8: Add Integrity Checks and Rotating Migration Snapshots

**Outcome:** Pending schema upgrades create restorable SQLite snapshots and fail closed without modifying the original database when migration cannot complete.

**Files:**

- Modify: `src-tauri/src/storage/database.rs`
- Modify: `src-tauri/src/storage/migrations.rs`
- Modify: `src-tauri/src/storage/tests.rs`

**Steps:**

- [ ] Compare `PRAGMA user_version` with the embedded migration count; reject a database whose version is newer than the application with `storage_version_unsupported`.
- [ ] For an existing non-empty database with pending migrations, run `PRAGMA integrity_check` before backup.
- [ ] Create the backup directory and use the `rusqlite` `backup` feature to write a consistent snapshot under `<app-data>/backups/langnext-v<old-version>-<YYYYMMDDTHHMMSSZ>.sqlite3`.
- [ ] Verify the snapshot opens and returns `ok` from `PRAGMA integrity_check` before applying the migration.
- [ ] Apply all pending migrations and the final `PRAGMA user_version` update in one SQLite transaction; migration SQL in this subsystem must remain transaction-compatible.
- [ ] On any migration failure, roll back the single transaction, close the database, verify the original version/data remains intact, preserve the snapshot, return `storage_unavailable`, and do not start windows or register writable state.
- [ ] Keep the three newest valid snapshots and remove older snapshots only after the complete pending migration set commits.
- [ ] Test a successful synthetic version upgrade, snapshot rotation, corrupt input rejection, and a deliberately failing migration that preserves the original schema/data.

**Validation:**

- Run: `mise run test migrations`
- Expected: Backup, rotation, integrity, and failure-preservation tests pass.

### Task 9: Implement Versioned Import and Export

**Outcome:** Users can export portable non-secret configuration and preview/import it transactionally using merge or copy conflict behavior.

**Files:**

- Create: `src-tauri/src/services/import_export.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] Export `formatVersion`, `exportedAt`, Providers, models, translation profiles, profile targets, and `AppSettingsV1` in deterministic UUID/priority order.
- [ ] Define export-specific Provider DTOs that omit `credential_ref`, `has_credential`, synchronization errors, and device-only fields.
- [ ] Exclude device state, credential journal rows, migration backups, adapter catalog metadata, request content, and all secrets.
- [ ] Validate import format version and every entity before opening the write transaction; return a preview containing create/update/copy counts and validation errors.
- [ ] Implement merge mode so every imported Provider row clears any matching local credential reference, regardless of whether adapter or URL changed. Write each required `db_committed` cleanup journal in the same import transaction and report `requiresAuthentication` for imported `api_key`/`bearer` Providers in the preview.
- [ ] Implement copy mode: allocate UUIDv7 values for every imported Provider, model, and profile, then rewrite Provider-model references, profile-target references, and `AppSettings.default_profile_id` consistently. If the imported default profile is not part of the copied document, set it to null and report that decision in the preview.
- [ ] In copy mode, imported non-`none` Providers have null credential references and therefore report `has_credential = false`.
- [ ] If imported application settings include custom proxy configuration, clear the local `app_credentials` binding even when the URL is identical, write a `db_committed` cleanup journal in the same import transaction, and perform vault cleanup after commit. The preview reports `proxyRequiresAuthentication`.
- [ ] Execute all import writes in one SQLite transaction; any uniqueness, reference, or validation failure rolls back the whole import.
- [ ] Reject import before writing when an affected Provider or global proxy already has an unfinished credential operation; return `credential_busy` rather than interleaving cleanup journals.
- [ ] Add round-trip tests, merge-clears-credential tests, proxy-import-clears-credential tests, copy-reference-rewrite tests, unsupported-version tests, rollback tests, and serialized-output scans for seeded secret strings and forbidden field names.

**Validation:**

- Run: `mise run test import_export`
- Expected: Round-trip, conflict handling, rollback, and secret-exclusion tests pass.

### Task 10: Wire Managed State and Sanitized Tauri Commands

**Outcome:** React can use the storage subsystem only through stable typed commands, while SQL and credentials remain inaccessible to the WebView.

**Files:**

- Create: `src-tauri/src/state.rs`
- Create: `src-tauri/src/cmds/providers.rs`
- Create: `src-tauri/src/cmds/models.rs`
- Create: `src-tauri/src/cmds/translation_profiles.rs`
- Create: `src-tauri/src/cmds/settings.rs`
- Create: `src-tauri/src/cmds/import_export.rs`
- Modify: `src-tauri/src/cmds/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/storage/types.ts`
- Create: `src/storage/client.ts`
- Create: `src/storage/bootstrap.ts`
- Modify: `src/main.tsx`
- Modify: `src/theme/theme.ts`
- Modify: `src/theme/useTheme.ts`
- Modify: `index.html`

**Steps:**

- [ ] Build `AppState` during Tauri setup after resolving and creating the app-data directory, probing/opening/migrating SQLite, constructing the native-vault adapter, attempting credential-journal recovery, and loading device state.
- [ ] Call `app.manage(state)` before `windows::setup(app.handle())`. Database integrity/migration failures are fatal and prevent the window from opening; temporary vault unavailability is nonfatal, leaves journal rows intact, and makes credential-backed operations return `credential_unavailable` until recovery succeeds.
- [ ] Keep existing `greet` and `show_snap_overlay` command registration intact.
- [ ] Add thin Provider commands: `list_provider_instances`, `save_provider_instance`, `set_provider_enabled`, and `delete_provider_instance`.
- [ ] Add model commands: `list_provider_models`, `save_manual_model`, `set_model_enabled`, and `delete_provider_model`. Do not expose a fake remote-refresh command before Provider adapters exist.
- [ ] Add profile commands: `list_translation_profiles`, `get_translation_profile`, `save_translation_profile`, `set_translation_profile_enabled`, and `delete_translation_profile`.
- [ ] Add settings commands: `get_app_settings` and `update_app_settings`; the update input includes `ProxyCredentialUpdate` while the response includes only `proxyHasCredential`.
- [ ] Add import/export commands: `export_configuration`, `preview_configuration_import`, and `import_configuration` using JSON strings or structured DTOs, not arbitrary file paths supplied to Rust.
- [ ] Dispatch SQLite/keyring operations through Tauri's blocking runtime facility so keyring prompts and database work do not block the UI event loop.
- [ ] Map every failure to `IpcError`; log only error code, entity UUID, and bounded diagnostic context.
- [ ] Define matching camelCase TypeScript types and `invoke` wrappers in `src/storage`; never define `credentialRef`, API-key response fields, SQL strings, or filesystem methods.
- [ ] Add representative TypeScript `satisfies` fixtures for every DTO/input union and Rust serialization snapshots for the same documented JSON shapes; run both Rust tests and `tsc` whenever the contract changes.
- [ ] In Tauri, load `AppSettings` before mounting React. If `theme` is null, take the valid legacy cache value or OS preference and persist it once; otherwise apply the SQLite value. Refresh `localStorage` as a pre-paint cache. In frontend-only `mise run dev`, use the browser cache because no Rust backend exists; do not present it as persisted desktop configuration.
- [ ] Change theme mutation to optimistically apply the DOM/cache value, call `update_app_settings`, and restore the previous value plus surface an error if persistence fails. This makes SQLite authoritative while preserving no-flash startup.
- [ ] Keep the inline `index.html` theme script as cache-only pre-paint behavior; document that authoritative reconciliation occurs during bootstrap.
- [ ] Leave `src-tauri/capabilities/default.json` unchanged because core Tauri invoke does not require SQL, store, or filesystem permissions.

**Validation:**

- Run: `mise run test`
- Expected: Command serialization and storage tests pass.
- Run: `mise run typecheck`
- Expected: Typed frontend clients compile with no TypeScript errors.
- Run: `mise run lint`
- Expected: No ESLint errors.

### Task 11: Update Architecture Documentation and Operational Guidance

**Outcome:** The repository documents actual storage locations, reset/recovery behavior, privacy boundaries, internal credential metadata, and theme authority.

**Files:**

- Modify: `docs/analysis/storage-architecture.md`
- Modify: `README.md`

**Steps:**

- [ ] Confirm the Task 3 architecture correction matches the released `0001_initial.sql`.
- [ ] Document `app_credentials` and `credential_operations` as internal, non-exported credential metadata tables, including operation-scoped vault references and one-active-operation serialization.
- [ ] Document the actual database, backup, and device-state filenames and their operating-system app-data location.
- [ ] Document reset behavior separately: deleting device state resets window state; deleting SQLite removes portable configuration; deleting the database does not automatically delete OS credentials until conservative reconciliation can prove ownership.
- [ ] Document that exports contain no credentials, all imported authenticated Providers require credential replacement, and importing custom proxy settings clears the local proxy binding.
- [ ] Document that SQLite is authoritative for theme in Tauri and `localStorage` is only a pre-paint/browser-development cache.
- [ ] Document the ignored native-vault smoke-test command and its interactive-session requirement.
- [ ] Update the README task table with `mise run test`.

**Validation:**

- Run: `mise exec -- prettier --check docs/analysis/storage-architecture.md docs/plans/2026-07-10-storage-subsystem-plan.md README.md`
- Expected: All documentation matches Prettier formatting.

## Final Validation

- Run: `mise run test`
- Expected: All Rust unit and integration tests pass, excluding explicitly ignored native-vault smoke tests.
- Run: `mise run typecheck`
- Expected: TypeScript completes with no errors.
- Run: `mise run lint`
- Expected: ESLint reports no errors.
- Run: `mise run format:check`
- Expected: Prettier and rustfmt report no changes required.
- Run: `mise run build`
- Expected: TypeScript checking and Vite production build complete successfully.
- Run: `mise run tauri:build`
- Expected: The desktop bundle compiles successfully on the current host platform and bundled SQLite links without external SQLite installation.
- Run on each release platform: `mise exec -- cargo test --manifest-path src-tauri/Cargo.toml native_vault_provider_lifecycle -- --ignored`
- Expected: The ignored integration test uses a temporary SQLite database and disposable native-vault entries to create, restart/reopen, replace, clear, and delete a Provider credential; it verifies the old entry is inaccessible after replacement/deletion and cleans all entries on success or failure.
- Run: `mise run test provider_reference_lifecycle`
- Expected: A real temporary SQLite test creates a Provider/model/profile fallback chain, verifies referenced model/Provider deletion returns `in_use`, verifies disable succeeds, and confirms no profile or target is silently removed.
- Run manually: move/resize/maximize the main window, restart, then delete only `device-state.json` and restart again.
- Expected: Valid geometry restores after the first restart and resets after file deletion without affecting SQLite configuration.

## Rollout Notes

- This is the first schema, so no legacy database migration is required. `AppSettingsV1.theme = null` marks the one-time frontend migration point: first Tauri bootstrap persists the valid legacy cache value or OS preference; subsequent launches treat SQLite as authoritative and use `localStorage` only for pre-paint cache.
- Release validation must run the ignored native-vault smoke test separately on Windows, macOS, and a Linux desktop session with Secret Service available.
- Headless CI should use the test-only `CredentialVault` implementation and must not silently fall back to plaintext storage.
- A keyring outage must leave authenticated Providers visible but unavailable for requests; it must not erase credential references or prompt React to obtain stored secrets.
- Future migrations are forward-only. Never edit `0001_initial.sql` after a released build has used it; add `0002_*.sql` and rely on the snapshot path.
- The first reviewable delivery should stop after Tasks 1–4. It produces a tested SQLite foundation without exposing incomplete IPC or credential behavior.
- The second delivery should cover Tasks 5–6, the third Tasks 7–9, and the final delivery Tasks 10–11 plus cross-platform validation.

## Risks and Mitigations

- **Native credential stores behave differently across platforms.** — Keep a narrow `CredentialVault` trait, use the `keyring` default native backends, run ignored smoke tests on all release platforms, and fail closed rather than adding a plaintext fallback.
- **SQLite and the OS credential store cannot share a transaction.** — Use durable `credential_operations`, unique per-owner operations, compare-and-set reference updates, new references for replacements, compensating deletes, and idempotent startup recovery.
- **Linux Secret Service may be absent in headless or minimal desktop environments.** — Return `credential_unavailable`, keep journal state intact, and explain the requirement; do not switch to an encrypted file without a separate design decision.
- **Migration defects could block startup.** — Integrity-check first, create and verify a SQLite backup, retain three snapshots, and stop before opening windows when migration fails.
- **WAL files can make naive file-copy backups inconsistent.** — Use the `rusqlite` backup API instead of copying `.sqlite3`, `-wal`, and `-shm` files manually.
- **Credential data could leak through DTOs, errors, or logs.** — Separate internal entities from IPC DTOs, test serialized output and `Debug` text with sentinel secrets, and never expose credential references.
- **Imported IDs can collide with local configuration.** — Preview before write, clear credentials for every imported Provider/proxy configuration, rewrite every model/profile/default-profile reference in copy mode, and use one transaction.
- **Remote model lists may be incomplete.** — Mark absent remote models `missing` rather than deleting them, preserve manual entries and user overrides, and update sync status only with the merge transaction.
- **Device geometry can be invalid after monitor changes or lost during tray exit.** — Validate against current monitors, center unusable geometry, persist through a same-directory atomic temp file, and flush debounced state before exit.
- **The storage plan is large enough to invite broad refactoring.** — Follow the delivery boundaries, preserve existing window/tray behavior, and avoid unrelated frontend state-management or Provider adapter work.

## Evidence Used

- Current project command registration: `src-tauri/src/lib.rs`, `src-tauri/src/cmds/mod.rs`
- Current app-data and window patterns: `src-tauri/src/windows/main.rs`, `src-tauri/src/consts.rs`
- Current capability boundary: `src-tauri/capabilities/default.json`
- Current task conventions: `.mise/tasks/*`, `mise.toml`, `AGENTS.md`
- Current crate registry results on 2026-07-10: `rusqlite 0.40.1`, `keyring 4.1.4`, `uuid 1.23.4`, `time 0.3.53`, `thiserror 2.0.18`, `tempfile 3.27.0`
- Current documentation: `/rusqlite/rusqlite`, `/open-source-cooperative/keyring-rs`, and `/websites/v2_tauri_app` through Context7
