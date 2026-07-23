# Phase 1A Service Integration Core Implementation Plan

**Goal:** Add the minimum bundled service-integration registry, instance persistence, host-owned credential slots, and `/plugins` configuration UX required by Google Cloud.

**Inputs:** `README.md` in this plan directory and `docs/analysis/google-cloud-plugin-architecture.md`.

**Assumptions:**

- Phase 1A registers only Google Cloud metadata, credential requirements, and Translate/Detect capability descriptors; it does not call Google APIs.
- Existing Provider/global proxy/OCR credential storage remains unchanged.
- A host-owned typed Google Cloud form is used; generic schema rendering is out of scope.
- Validation in this phase parses configuration and service-account shape but does not claim capability IAM health.

**Architecture:** Rust owns a bundled service-integration catalog and persists user-created integration instances. Credential slots use a generic integration binding plus the existing crash-safe journal pattern. The frontend lists sanitized definitions/instances through Query and provides typed CRUD under `/plugins`.

**Tech Stack:** Rust, rusqlite, keyring vault, Tauri IPC/events, React, TanStack Router/Query, Base UI, i18next.

---

## File Map

### Backend

- Create: `src-tauri/migrations/0012_service_integrations.sql` — instances, credential bindings, slot-aware credential journal.
- Create: `src-tauri/src/domain/service_integration.rs` — manifests, instances, slots, status, writes, dependencies.
- Create: `src-tauri/src/repositories/integration_instances.rs` — instance SQL CRUD.
- Create: `src-tauri/src/repositories/integration_credential_bindings.rs` — slot/ref/revision SQL.
- Create: `src-tauri/src/services/service_integration_registry.rs` — bundled definition registration/lookup.
- Create: `src-tauri/src/services/service_integrations.rs` — CRUD, validation, vault coordination, dependencies.
- Create: `src-tauri/src/cmds/service_integrations.rs` — definition/instance IPC.
- Modify: `src-tauri/src/storage/migrations.rs` — embed migration 0012.
- Modify: `src-tauri/src/{domain,repositories,services,cmds}/mod.rs` — module exports.
- Modify: `src-tauri/src/repositories/credential_operations.rs` — integration owner and slot-aware APIs.
- Modify: `src-tauri/src/credentials/refs.rs` — integration slot vault refs.
- Modify: `src-tauri/src/credentials/mod.rs` — ref export.
- Modify: `src-tauri/src/credentials/coordinator.rs` — current binding/recovery for integration slots.
- Modify: `src-tauri/src/state.rs` — registry/service composition.
- Modify: `src-tauri/src/events.rs` — integration change event.
- Modify: `src-tauri/src/error.rs` — `conflict`, `in_use`, `plugin_unavailable` mappings where absent.
- Modify: `src-tauri/src/lib.rs` — commands/state registration.

### Frontend

- Create: `src/features/plugins/PluginsLayout.tsx` — rail/editor layout.
- Create: `src/features/plugins/AddIntegrationDialog.tsx` — bundled definition chooser.
- Create: `src/features/plugins/IntegrationEditor.tsx` — shared instance editor shell/status/dependencies.
- Create: `src/features/plugins/GoogleCloudIntegrationForm.tsx` — typed Google Cloud common config and credential form.
- Create: `src/features/plugins/integrationDraft.ts` — DTO→draft and credential update helpers.
- Create: `src/features/plugins/integrationDraft.test.ts` — secret-state conversion tests.
- Create: `src/routes/plugins.tsx` — parent route.
- Create: `src/routes/plugins/index.tsx` — empty selection route.
- Create: `src/routes/plugins/$integrationInstanceId.tsx` — instance route.
- Modify: `src/storage/types.ts` — integration DTO/write types.
- Modify: `src/storage/client.ts` — integration Promise API.
- Modify: `src/query/keys.ts` and `src/query/keys.test.ts` — integration keys.
- Modify: `src/query/options.ts` — list/detail/definition options.
- Modify: `src/query/events.ts` — integration event constant.
- Modify: `src/query/registerDataChangeListeners.ts` and test — cross-window invalidation.
- Modify: `src/query/QueryEventSync.tsx` — integration invalidation mapping.
- Modify: `src/shell/nav.ts` — `/plugins` navigation.
- Modify: `src/routes/__root.tsx` — plugin icon mapping.
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts` — labels/errors/help.
- Generated: `src/routeTree.gen.ts` — regenerate; never edit manually.

## Tasks

### Task 1: Add migration 0012

**Outcome:** SQLite can persist bundled integration instances and multiple host-vault credential slots without changing existing credential owners.

**Files:**

- Create: `src-tauri/migrations/0012_service_integrations.sql`
- Modify: `src-tauri/src/storage/migrations.rs`
- Modify: storage migration tests in `src-tauri/src/storage/migrations.rs` / `src-tauri/src/storage/tests.rs`

**Steps:**

- [ ] Create `integration_instances` with UUID id, plugin id/version, display name, enabled flag, non-secret `config_json`, config schema version, persisted `health_status`, last validation/error metadata, and timestamps.
- [ ] Restrict persisted health values to `unconfigured`, `unvalidated`, `ready`, `degraded`.
- [ ] Derive DTO `effectiveStatus`: registry miss → `plugin_missing`; else `enabled = false` → `disabled`; else persisted `health_status`.
- [ ] Re-enabling an instance reveals its prior health status; it does not silently become ready or require storing/restoring a separate disabled status.
- [ ] Create `integration_credential_bindings` with instance FK, stable `slot_id`, nullable opaque `credential_ref`, monotonic `credential_revision`, timestamps, and unique `(integration_instance_id, slot_id)`.
- [ ] Rebuild `credential_operations` to add `owner_kind = integration` and a non-null `slot_id`.
- [ ] Backfill existing credential-operation rows with `slot_id = primary`; preserve existing owner-kind values and data.
- [ ] Change journal uniqueness to `(owner_kind, owner_id, slot_id)`.
- [ ] Keep old owner helper APIs as `primary`-slot wrappers; do not move existing domain refs.
- [ ] Do not collapse `OcrApiKey`/`OcrSecretKey` into integration slots; preserve existing `current_binding` arms and recovery semantics.
- [ ] Add an `Integration` binding lookup that resolves `(instance_id, slot_id)` from `integration_credential_bindings`.
- [ ] Test that Provider/global-proxy owners still permit only one concurrent `primary` operation and that OCR's two existing owner kinds remain independent.
- [ ] Add indexes for plugin-id listing, status listing, slot lookup, and dependency-safe instance lookup only where queries require them.
- [ ] Embed 0012 as the next migration.
- [ ] Add fresh DB and 0011→0012 upgrade assertions, including journal-row preservation.

**Validation:**

- Run: `mise run test migrate_ -- --nocapture`
- Expected: fresh and upgraded databases reach version 12; old credential journal rows remain readable.

### Task 2: Define the integration domain and catalog

**Outcome:** Rust has validated, versioned definitions for Google Cloud and stable sanitized IPC types.

**Files:**

- Create: `src-tauri/src/domain/service_integration.rs`
- Create: `src-tauri/src/services/service_integration_registry.rs`
- Modify: related `mod.rs` files
- Test: inline unit tests in the new modules

**Steps:**

- [ ] Define `ServiceIntegrationManifest`, `IntegrationCapabilityDescriptor`, `CredentialSlotDescriptor`, `EndpointGrant`, and version fields.
- [ ] Define `IntegrationInstance`, `IntegrationInstanceDto`, `IntegrationInstanceWrite`, `CredentialSlotStatusDto`, and `IntegrationDependencyDto`.
- [ ] Keep internal credential refs out of serializable DTO structs.
- [ ] Define plugin ID and capability ID validation rules: bounded ASCII reverse-domain plugin IDs and versioned capability IDs.
- [ ] Register `com.langnext.google-cloud` with config schema version 1, slot `service-account-json`, and descriptors for `translate.text@1` and `translate.detect@1`.
- [ ] Register endpoint aliases as policy metadata only; API execution lands in Phase 1B.
- [ ] Reject duplicate plugin IDs, duplicate capability IDs, duplicate slot IDs, invalid versions, and capabilities referencing undeclared endpoint aliases.
- [ ] Make registration deterministic and expose sanitized definition DTOs.

**Validation:**

- Run: `mise run test service_integration_registry -- --nocapture`
- Expected: valid Google definition registers; every duplicate/invalid contract fails closed.

### Task 3: Add repositories and generic integration credential refs

**Outcome:** Instances and credential slots can be read/written transactionally with optimistic concurrency and revision tracking.

**Files:**

- Create: `src-tauri/src/repositories/integration_instances.rs`
- Create: `src-tauri/src/repositories/integration_credential_bindings.rs`
- Modify: `src-tauri/src/repositories/credential_operations.rs`
- Modify: `src-tauri/src/credentials/refs.rs`, `src-tauri/src/credentials/mod.rs`
- Modify: repository tests

**Steps:**

- [ ] Implement ordered list, get, insert, compare-and-set update, enable/disable, dependency query hook, and delete primitives.
- [ ] Implement create/get/CAS/clear for credential bindings keyed by instance + slot.
- [ ] Increment `credential_revision` on successful replace and clear operations.
- [ ] Add journal operations that accept explicit integration `slot_id`; preserve primary-slot wrappers for existing owners.
- [ ] Generate vault refs as `integration/{instance_id}/{slot_id}/{operation_id}` with validated slot IDs.
- [ ] Ensure debug/error output never includes secret values or credential refs.
- [ ] Test slot uniqueness, CAS conflict, revision increments, and FK-restricted delete behavior.

**Validation:**

- Run: `mise run test integration_ -- --nocapture`
- Expected: CRUD, CAS, slot isolation, revisions, and FK behavior pass.

### Task 4: Implement instance CRUD and crash-safe credential updates

**Outcome:** Google Cloud integration instances can be created, updated, disabled, validated locally, and deleted safely.

**Files:**

- Create: `src-tauri/src/services/service_integrations.rs`
- Modify: `src-tauri/src/credentials/coordinator.rs`
- Modify: `src-tauri/src/error.rs`
- Test: service and credential recovery tests

**Steps:**

- [ ] Validate writes against the registered manifest; plugin ID is immutable after create.
- [ ] Validate display name, project ID, location, proxy mode, and bounded service-account JSON size.
- [ ] Reuse only existing `ProxyMode` values `inherit | direct` for Google Cloud; reject custom Base URL/proxy endpoint fields.
- [ ] For credential replacement, parse JSON and require `client_email`, `private_key`, and the pinned Google token URI before writing it to the vault.
- [ ] Implement `keep | replace | clear` for each declared slot.
- [ ] Use prepare → vault write → DB CAS/commit → journal finalization → old secret cleanup.
- [ ] Recover integration slot operations during startup through the shared coordinator.
- [ ] Expose only slot status (`hasCredential`, revision if safe/needed), never secret/ref data.
- [ ] Use `expectedUpdatedAt` for update conflicts.
- [ ] Report `plugin_missing` without deleting persisted instances.
- [ ] Resolve dependencies before delete and return `in_use`; do not cascade domain resources.
- [ ] Apply explicit persisted health transitions:
  - missing required config/credential → `unconfigured`;
  - locally valid shape, not remotely checked → `unvalidated`;
  - Phase 1B successful token validation → `ready`;
  - Phase 1B remote/auth failure → `degraded`.
- [ ] Derive `disabled` from the enabled flag and `plugin_missing` from registry lookup on read; never persist either as health.
- [ ] Never set `ready` from local/config-only validation.

**Validation:**

- Run: `mise run test service_integrations -- --nocapture`
- Run: `mise run test integration_credential -- --nocapture`
- Expected: create/update/clear/conflict/recovery/secret-exclusion/dependency tests pass.

### Task 5: Add IPC, AppState, and change events

**Outcome:** Frontend consumers can query/mutate integration definitions and instances and synchronize across windows.

**Files:**

- Create: `src-tauri/src/cmds/service_integrations.rs`
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/events.rs`, `src-tauri/src/lib.rs`
- Modify: module exports

**Steps:**

- [ ] Add commands for definition list, instance list/get/save/enable, dependency list, and delete.
- [ ] Reserve `validate_integration_instance` command; in Phase 1A it performs only local validation and returns an explicit non-remote status.
- [ ] Compose registry and service once in `AppState`.
- [ ] Ensure startup credential recovery includes integration slots before instance use.
- [ ] Emit `data://service-integrations-changed` after successful mutations only.
- [ ] Map validation/conflict/in-use/plugin-missing failures to stable IPC codes.
- [ ] Keep event payloads empty/coarse; DTOs are refetched from SQLite.

**Validation:**

- Run: `mise run test service_integrations -- --nocapture`
- Run: `cargo check --manifest-path src-tauri/Cargo.toml`
- Expected: commands compile and mutation-event tests pass.

### Task 6: Add frontend storage and Query integration

**Outcome:** Every webview reads authoritative integration DTOs through shared Query options and invalidates on backend events.

**Files:**

- Modify: `src/storage/types.ts`, `src/storage/client.ts`
- Modify: `src/query/keys.ts`, `src/query/keys.test.ts`, `src/query/options.ts`
- Modify: `src/query/events.ts`, `src/query/registerDataChangeListeners.ts` and test
- Modify: `src/query/QueryEventSync.tsx`

**Steps:**

- [ ] Mirror sanitized Rust definition/instance/write/dependency types.
- [ ] Add Promise client functions for every Phase 1A command.
- [ ] Add `integrationKeys.all/list/detail/definitions/dependencies`.
- [ ] Add Query options with existing stale-time/error conventions.
- [ ] Register the integration event and invalidate `integrationKeys.all` in every webview.
- [ ] Treat events as invalidation signals only.
- [ ] Add tests for key hierarchy and event registration.

**Validation:**

- Run: `bun test src/query/keys.test.ts src/query/registerDataChangeListeners.test.ts`
- Run: `mise run typecheck`
- Expected: Query tests and TypeScript compile pass.

### Task 7: Deliver `/plugins` configuration UX

**Outcome:** Users can create multiple Google Cloud instances and manage shared configuration/credentials from one page.

**Files:**

- Create/modify: frontend files listed in the File Map
- Generated: `src/routeTree.gen.ts`

**Steps:**

- [ ] Build `/plugins` using the existing rail/editor layout pattern.
- [ ] Add `/plugins` to the primary rail with user-facing label `Integrations`, i18n key `nav.integrations`, and `NavIconId` value `extension`; map it to an installed Iconify extension icon in `__root.tsx`.
- [ ] Add an OCR-style definition chooser; describe the action as creating a configuration instance, not installing executable code.
- [ ] Render a typed Google Cloud form with display name, project ID, location (default `global`), proxy mode, service-account replace/clear, and enabled state.
- [ ] Use Base UI primitives and existing UI class helpers; follow the Base UI project skill during implementation.
- [ ] Never populate the service-account input from DTO data; show only stored/not-stored state.
- [ ] Preserve pending local secret input until save completes; clear it after successful replacement.
- [ ] Display local validation status, capabilities, last safe error, and a dependency section.
- [ ] In Phase 1A the dependency section may be an explicit empty-state stub because no domain binding exists until Phase 1C; do not invent a generic dependency graph.
- [ ] Disable destructive confirmation only while mutation is pending; backend remains authoritative for `in_use`.
- [ ] Add `/plugins` to primary navigation with an accessible icon/label.
- [ ] Add English/Chinese copy and regenerate the route tree.
- [ ] Test credential draft conversion (`keep`, `replace`, `clear`) and no secret echo.

**Validation:**

- Run: `bun test src/features/plugins/integrationDraft.test.ts src/query/keys.test.ts`
- Run: `mise run typecheck`
- Run: `mise run lint`
- Expected: tests/typecheck/lint pass; manual UI supports create/edit/disable/delete conflict without secret echo.

## Phase Validation

Run:

```bash
mise run format:check
mise run lint
mise run typecheck
mise run test-frontend
mise run test
mise run build
```

Expected: all checks pass.

Manual:

```bash
mise run tauri:dev
```

Expected:

1. `/plugins` can create two separate Google Cloud instances.
2. Saving service-account JSON never returns it to the frontend.
3. Reload and second-window invalidation show authoritative state.
4. Local malformed JSON/config errors are clear and secret-free.
5. Existing Models, Profiles, OCR, and translation workflows behave unchanged.

## Failure Behavior

- Unknown/missing plugin definition — retain instance, mark `plugin_missing`, block execution.
- Invalid service-account shape — reject before vault mutation.
- Vault unavailable — return `credential_unavailable`; keep journal recoverable.
- Concurrent update — return `conflict`; do not overwrite newer config.
- Referenced instance delete — return `in_use`; no cascade.
- Event delivery failure — mutation remains committed; Query converges on next refetch/app restart.

## Privacy and Security

- Service-account JSON is accepted only in write IPC and immediately handled by Rust.
- Read DTOs, events, logs, exports, errors, and Query caches contain no secret/ref.
- Phase 1A performs no provider HTTP request.
- Existing credential domains remain untouched except for backward-compatible journal slot support.

## Open Questions

None blocking Phase 1A.
