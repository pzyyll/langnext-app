# Phase 4: Runtime Pin, Upgrade, and Rollback Implementation Plan

**Goal:** Connect installed packages to integration instances and Wasm execution with exact digest/grant pinning, transactional migrations, explicit activation, and reversible rollback.

**Inputs:** Phases 1–3.

**Assumptions:**

- Only synthetic conformance packages execute in this phase.
- Existing instances remain `BundledRust` until explicitly migrated.
- A catalog default applies only to new instances.

**Architecture:** `RuntimeRouter` resolves one immutable runtime identity from the authoritative instance row. Upgrade prepares copied config/preferences and permission approval, then atomically CAS-updates instance identity, grant, schemas, domain preferences, and rollback snapshot. Runtime failure does not switch executors.

**Tech Stack:** Rust, SQLite transactions/CAS, Wasmtime runtime, existing integration/profile/OCR/Speech repositories, TanStack Query.

---

## Dependencies

- Phases 1, 2, and 3 complete.

## File Map

- Create: `src-tauri/migrations/0017_runtime_plugin_instance_pins.sql` — atomic instance package pins, instance-scoped execution grant sets/entries, and upgrade snapshots.
- Create: `src-tauri/src/domain/runtime_lifecycle.rs` — runtime identity, upgrade/rollback DTOs.
- Create: `src-tauri/src/repositories/plugin_permission_grants.rs` — instance/package-scoped execution grant-set revisions with capability/page authority entries.
- Create: `src-tauri/src/repositories/plugin_upgrade_snapshots.rs` — prior-state snapshots.
- Create: `src-tauri/src/services/runtime_router.rs` — adapter resolution by authoritative identity.
- Create: `src-tauri/src/services/runtime_lifecycle.rs` — prepare/approve/CAS upgrade and rollback.
- Create: `src-tauri/src/cmds/runtime_lifecycle.rs` — preview/upgrade/rollback IPC.
- Modify: `src-tauri/src/repositories/integration_instances.rs`, `src-tauri/src/domain/service_integration.rs`, `src-tauri/src/services/service_integrations.rs` — exact runtime identity persistence/DTOs.
- Modify: `src-tauri/src/repositories/translation_profiles.rs`, `src-tauri/src/repositories/ocr_services.rs`, `src-tauri/src/repositories/speech_services.rs` — preference migration snapshots/CAS.
- Modify: `src-tauri/src/domain/import_export.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/import_validation.rs` — minimum export format v7 runtime requirements and missing-package restore.
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/cmds/mod.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json` — compose lifecycle commands and update the AppManifest/ACL.
- Modify: `src/storage/types.ts`, `src/storage/client.ts`, `src/query/keys.ts`, `src/query/options.ts`, `src/query/events.ts`, `src/query/dataChangeEventBindings.ts` — lifecycle/import DTOs and invalidation.
- Modify: `src/features/plugins/IntegrationEditor.tsx`, `src/features/settings/configurationTransfer.ts` — upgrade/rollback and unresolved runtime UX.
- Test: migration/router/lifecycle/import/concurrency/rollback tests and frontend status/transfer tests.

## Tasks

### Task 1: Persist exact instance runtime identity

**Outcome:** Every integration instance resolves atomically to Bundled Rust or one exact installed package and one execution grant-set revision.

**Files:**

- Create: `src-tauri/migrations/0017_runtime_plugin_instance_pins.sql`, `src-tauri/src/domain/runtime_lifecycle.rs`, `src-tauri/src/repositories/plugin_permission_grants.rs`
- Modify: `src-tauri/src/repositories/integration_instances.rs`, `src-tauri/src/domain/service_integration.rs`, `src/storage/types.ts`
- Test: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/repositories/tests.rs`

**Steps:**

- [ ] Add `runtime_kind`, nullable `package_digest`, nullable `execution_grant_set_revision`, runtime state, and runtime error metadata to instances.
- [ ] Create an execution grant-set header with exactly one subject (`integration_instance_id` or `provider_instance_id`) and bind each revision to subject, plugin ID, package digest, complete requested-permission digest, and approval timestamp. A package installation approval is never accepted as an execution grant set.
- [ ] Store typed child entries under that revision: capability authority entries bind capability major, normalized origin, method set, auth policy, and resource modes/limits; page authority entries bind declared `page_id`, allowed bridge action IDs, and any delegated capability majors/endpoint aliases and remain empty until Phase 9 explicit approval.
- [ ] Enforce one current grant-set revision per subject/package. Runtime pin and grant-set revision change atomically; reject lookup/use when subject, digest, revision, capability entry, origin, method, auth policy, resource mode, page, or bridge action differs. Add cross-instance, cross-provider-instance, cross-capability, cross-page, and cross-action denial fixtures.
- [ ] Backfill current rows as `bundled_rust` without changing plugin/version/config/health.
- [ ] Add constraints requiring package/grant pins only for installed runtimes.
- [ ] Persist a separate catalog default; never resolve an existing instance through that default.
- [ ] Include sanitized runtime identity/status in DTOs immediately and in the minimum export format v7 contract delivered by Task 7; no real runtime instance may ship while exports still lose its exact identity.

**Validation:**

- Run: `mise run test migrate_ -- --nocapture`
- Run: `mise run test runtime_instance_pin -- --nocapture`
- Expected: backfill and identity constraints pass, package approvals cannot execute, runtime/grant-set pins are atomic, and cross-instance/capability/page/action authority reuse is denied; current behavior remains bundled.

### Task 2: Implement the runtime router

**Outcome:** Capability dispatch selects one explicit executor from authoritative SQLite state.

**Files:**

- Create: `src-tauri/src/services/runtime_router.rs`
- Modify: `src-tauri/src/services/service_capabilities.rs`, `src-tauri/src/state.rs`
- Test: inline tests in `src-tauri/src/services/runtime_router.rs`

**Steps:**

- [ ] Define adapters for `BundledRust` and `WasmComponent`; reserve legacy frontend/native variants for later phases.
- [ ] Reload instance, package, grant, enabled/health, capability, and schema state inside the authoritative command path.
- [ ] Before Component load, rehash the retained `package.lnplugin` exact archive bytes against `package_digest`, then verify the selected extracted runtime artifact against its signed file-index length/digest/role; bind the complete `PluginPrincipal` only after both checks pass.
- [ ] Refuse missing/revoked/incompatible packages or grants with stable errors.
- [ ] Route typed capability calls without adding a generic JSON executor.
- [ ] Never fallback after an executor starts.

**Validation:**

- Run: `mise run test runtime_router -- --nocapture`
- Expected: exact adapter selection and missing/revoked/cross-instance denial tests pass.

### Task 3: Prepare and approve upgrades

**Outcome:** Users can preview code/config/preference/permission changes before mutation.

**Files:**

- Create: `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/cmds/runtime_lifecycle.rs`
- Modify: `src-tauri/src/services/plugin_store.rs`, `src-tauri/src/repositories/plugin_permission_grants.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/cmds/mod.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json`, `src/storage/types.ts`, `src/storage/client.ts`, `src/query/options.ts`
- Test: inline preview tests in `src-tauri/src/services/runtime_lifecycle.rs`

**Steps:**

- [ ] Add `preview_integration_runtime_upgrade` returning source/target identity, capability compatibility, schema migrations, credential slot compatibility, and permission differences.
- [ ] Run target migration exports in Wasm against copied non-secret config/preferences only.
- [ ] Validate migrated JSON with target schemas and adapters.
- [ ] Require explicit approval when permissions expand or publisher trust changes; create a complete new execution grant-set revision for the one target instance/package rather than reusing the package installation approval or another instance's grant. Preserve unchanged capability/page entries and add/remove only reviewed differences.
- [ ] Bind the preview to source `updated_at`, target digest, grant request digest, and migrated JSON digests; expire it.
- [ ] Register preview/apply/rollback commands in the `invoke_handler`, `AppManifest`, `app-commands` permission set, and trusted-app capability coverage together; extend the Phase 0 coverage test.

**Validation:**

- Run: `mise run test runtime_upgrade_preview -- --nocapture`
- Run: `mise run test runtime_plugin_security -- --nocapture`
- Expected: stale, incompatible, failed migration, slot mismatch, and expanded permission cases are surfaced without DB mutation, and command registration/ACL sets remain identical.

### Task 4: Apply one transactional upgrade CAS

**Outcome:** Package identity, grant, config, and every dependent preference move together or not at all.

**Files:**

- Create: `src-tauri/src/repositories/plugin_upgrade_snapshots.rs`
- Modify: `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/repositories/translation_profiles.rs`, `src-tauri/src/repositories/ocr_services.rs`, `src-tauri/src/repositories/speech_services.rs`
- Test: lifecycle service failure-injection tests and `src-tauri/src/repositories/tests.rs`

**Steps:**

- [ ] Store a rollback snapshot containing old runtime identity/grant, config/schema, and affected Translation/OCR/Speech preference JSON/schema versions.
- [ ] In one transaction verify expected instance revision and dependency revisions, then update all runtime/config/preference rows.
- [ ] Preserve compatible credential bindings by slot ID/kind; require user input for new required slots and never snapshot secret values.
- [ ] Invalidate token/runtime caches after commit.
- [ ] Emit coarse integration/profile/OCR/Speech invalidation events after commit only.
- [ ] If any check/write fails, retain old runtime and discard prepared state.

**Validation:**

- Run: `mise run test runtime_upgrade_apply -- --nocapture`
- Expected: every injected failure leaves source identity/data unchanged; success updates all rows atomically.

### Task 5: Implement explicit rollback

**Outcome:** A failed or unwanted upgrade can restore the exact prior host-owned state without reverse plugin migrations.

**Files:**

- Modify: `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/cmds/runtime_lifecycle.rs`, `src/features/plugins/IntegrationEditor.tsx`
- Test: rollback tests in `src-tauri/src/services/runtime_lifecycle.rs`

**Steps:**

- [ ] Add rollback preview and confirmation showing target old digest/grant/config/preferences.
- [ ] Require old package/grant availability and current revision CAS.
- [ ] Restore the stored snapshot in one transaction; do not ask the current plugin to migrate backward.
- [ ] Preserve credentials only when snapshot slot identity remains compatible.
- [ ] Keep at least one rollback snapshot per instance until user explicitly discards it or the referenced version is safely removed.

**Validation:**

- Run: `mise run test runtime_rollback -- --nocapture`
- Expected: rollback restores byte-equivalent non-secret state and exact runtime identity; stale/missing target fails closed.

### Task 6: Prove the installed synthetic lifecycle

**Outcome:** The conformance package completes install-to-execution-to-rollback without real provider traffic.

**Files:**

- Modify: `runtime-plugins/conformance/fixtures/packages/`, `.mise/tasks/plugin/conformance`
- Test: `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/runtime_router.rs`, `src/features/plugins/IntegrationEditor.tsx` lifecycle UX helpers/tests

**Steps:**

- [ ] Install two signed synthetic versions with compatible and incompatible migration fixtures.
- [ ] Create a Wasm-backed integration instance from the default version.
- [ ] Execute typed Translate/Detect fixtures through the runtime router.
- [ ] Upgrade to the compatible version, verify expanded permissions require approval, then rollback.
- [ ] Verify the incompatible version cannot mutate the instance.

**Validation:**

- Run: `mise run plugin:conformance installed-lifecycle`
- Manual: complete the lifecycle in `mise run tauri:dev`.
- Expected: exact identity, approval, migration, execution, upgrade, rollback, and dependency-safe uninstall behavior passes.

### Task 7: Introduce minimum export format v7 before real plugins

**Outcome:** Any runtime-backed instance created after this phase can be backed up/restored without silently changing executor identity.

**Files:**

- Modify: `src-tauri/src/domain/import_export.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/import_validation.rs`
- Modify: `src/storage/types.ts`, `src/features/settings/configurationTransfer.ts`
- Test: Rust import/export compatibility tests and frontend configuration transfer tests

**Steps:**

- [ ] Bump the export format from v6 to v7 before Phase 5 is allowed to release.
- [ ] Define generic runtime requirement records containing plugin ID/version, exact package digest, publisher key ID, mandatory publisher key fingerprint, plugin API version, config schema version, and required capability majors; include optional provider runtime fields now so Phases 8 and 11 do not mutate v7 semantics.
- [ ] Keep v2–v6 sequential normalization and map existing integrations/providers to Bundled Rust/Legacy Frontend identities without inventing package digests.
- [ ] Export no package artifacts, secrets, credential refs, package approvals, execution grant sets/revisions, or rollback snapshots.
- [ ] Import absent/unapproved packages as preserved unresolved `plugin_missing` runtime requirements; never substitute a matching ID/version or download/execute code.
- [ ] Require local package installation, publisher trust, permission approval, and explicit activation after restore.
- [ ] Phase 11 expands copy/merge/reapproval/recovery coverage but does not redefine this identity contract.

**Validation:**

- Run: `mise run test runtime_plugin_export_v7 -- --nocapture`
- Run: `mise run test import_format -- --nocapture`
- Run: `bun test src/features/settings/configurationTransfer.test.ts`
- Expected: v2–v7 fixtures pass; exact runtime identity round-trips; missing packages restore unresolved; code/trust/secrets remain local.

## Final Validation

```bash
mise run plugin:conformance installed-lifecycle
mise run test runtime_lifecycle -- --nocapture
mise run test runtime_plugin_export_v7 -- --nocapture
mise run test import_format -- --nocapture
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
```

Expected: synthetic installed Components are safely executable and reversible; real integrations remain unchanged.

## Failure Behavior

- Stale preview/CAS — return `conflict`; no mutation.
- Missing package/grant/snapshot — retain current identity and report unavailable.
- Migration trap/invalid JSON — fail preview and keep source active.
- Runtime trap after activation — fail request and mark health; do not automatic rollback or replay.

## Privacy and Security

- Snapshots exclude secrets and credential refs from frontend DTOs.
- Permission approval is bound to exact target digest and request digest.
- Digest verification occurs again before execution.

## Rollout Notes

- Ship synthetic lifecycle internally before exposing real plugin migration controls.
- Keep instance migration actions behind advanced UI until Phase 5 validates real traffic.

## Risks and Mitigations

- Cross-domain transaction complexity — enumerate dependency rows during preview and CAS every expected revision.
- Snapshot retention blocks uninstall — show dependencies and allow explicit snapshot discard only when current rollback risk is accepted.
- Cache stale after upgrade — evict by instance and package digest after commit.

## Open Questions

None blocking Phase 4.
