# Phase 11.5: Default Package Authorization and Package-First Creation Implementation Plan

**Goal:** Make an authorized default package automatically activate for future integration and provider instances without manual digest entry or creation of new legacy runtime rows.

**Inputs:** Phase 4 runtime lifecycle, Phases 5–8 and 10 runtime packages, Phase 11 recovery semantics, the default-package UX findings from 2026-08-07, and Phase 12 retirement gates.

**Assumptions:**

- Setting a package as default is an explicit authorization for future instances, not only a catalog preference.
- Authorization is exact-bound to package digest, publisher identity, manifest permission request, and approved authority constraints.
- Existing instances are never migrated or rebound when a default changes.
- Fixed package authority may be approved at default-selection time. Instance-configured authority outside the approved constraints still requires instance-level confirmation.
- Existing default rows migrate without authorization; the user must confirm them once. Host-shipped vendor defaults may create the same persisted policy only from an audited host resource that exact-binds digest, publisher, and permission ceiling.
- Activation intent provenance is persisted. Only `local_creation` intents are eligible for automatic recovery; imports remain `import_requires_confirmation` across restart.
- Phase 12 may retire a legacy executor only after this phase supplies package-first creation for that executor.

**Architecture:** Add a persisted default activation policy beside `plugin_default_versions` and a subject activation-intent journal that distinguishes local creation from imported inactive data. The set-default workflow first previews an externally re-verified package and its future-instance authority, then atomically stores the exact default and authorization policy. New matching integrations/providers are created directly against that package as `pending_activation`; a shared activation service re-verifies, migrates/normalizes configuration, derives an instance grant from the policy, and CAS-activates the exact digest. Authority outside the policy uses a subject/config-bound preview-confirm seam. No path creates an intermediate active `bundled-rust`/`legacy-frontend-provider` row when an authorized default exists.

**Tech Stack:** Rust 2024, SQLite/rusqlite, Tauri 2 IPC/events, React 19, TanStack Query, Effect, Base UI, Bun, mise.

---

## Scope

### In scope

- Integration and provider default-package authorization.
- Package-first creation and `pending_activation` state.
- Generic policy checks; no plugin-ID allowlist.
- Background verification with per-package single-flight.
- Instance-level confirmation when resolved authority exceeds the default policy.
- Explicit retry/failure UX without manual digest entry.
- Phase 12 dependency and inventory updates.

### Out of scope

- Migrating existing instances when a default changes.
- Trusting imported default policies or execution grants; Phase 11 keeps them local and non-portable.
- Automatic remote package download/update.
- Weakening package/store/TOCTOU verification.
- Removing legacy executors; Phase 12 performs retirement after its existing release gates.

## State Model

| Condition                                             | New instance runtime identity                                                                    | User action                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Authorized default; authority covered                 | Exact package kind/digest, `pending_activation`, no grant revision                               | None; host activates in background                               |
| Authorized default; instance authority exceeds policy | Exact package kind/digest, `pending_activation`, no grant revision, confirmation-required intent | Review a subject/config-bound authority preview; no digest entry |
| Verification/migration failure                        | Exact package kind/digest, `unavailable`, no grant revision, normalized error                    | Retry or choose another installed package                        |
| Default exists without authorization                  | Exact package requirement retained inactive                                                      | Authorize the default or choose another package                  |
| No default during dual-stack transition               | Existing legacy creation behavior until that executor enters Phase 12 retirement                 | Set/authorize a default before retirement                        |
| Retired executor has no authorized default            | Creation is blocked with an actionable package requirement                                       | Install and authorize a package                                  |

## File Map

- Create: `src-tauri/migrations/0027_default_package_activation_policies.sql` — exact default authorization policy, subject activation intent/provenance journal, and revocation constraints.
- Create: `src-tauri/src/domain/default_package_activation.rs` — policy, preview, status, input, and error DTOs.
- Create: `src-tauri/src/repositories/default_package_activation_policies.rs` — policy CRUD and exact-binding queries.
- Create: `src-tauri/src/services/default_package_activation.rs` — default preview/authorization, subject authority preview/confirm, package-first preparation, activation, retry, recovery, and per-package single-flight.
- Create: `src-tauri/src/cmds/default_package_activation.rs` — trusted-app IPC and data-change events.
- Create: `src/features/plugins/DefaultPackageActivationDialog.tsx` — permission/publisher confirmation when setting a default.
- Create: `src/features/plugins/defaultPackageActivationPresentation.ts` — pure status and copy mapping.
- Create: `src/features/plugins/defaultPackageActivationPresentation.test.ts` — pending/failure/confirmation presentation coverage.
- Create: `src-tauri/resources/plugins/default-activation-policies.json` — release-generated exact identities and permission ceilings for host-shipped defaults; never a plugin-ID allowlist.
- Modify: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/cmds/mod.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json` — register schema, services, commands, and ACL coverage.
- Modify: `src-tauri/src/domain/plugin_package.rs`, `src-tauri/src/repositories/installed_plugin_versions.rs`, `src-tauri/src/services/plugin_store.rs`, `src-tauri/src/cmds/plugin_packages.rs` — expose default authorization status and replace direct set-default mutation.
- Modify: `src-tauri/src/services/runtime_lifecycle.rs` — consume generic policy, remove host plugin-ID allowlist, preserve re-verification/CAS checks.
- Modify: `src-tauri/src/services/service_integrations.rs`, `src-tauri/src/cmds/service_integrations.rs`, `src-tauri/src/repositories/integration_instances.rs` — package-first integration creation and activation completion.
- Modify: `src-tauri/src/services/providers.rs`, `src-tauri/src/cmds/providers.rs`, `src-tauri/src/services/runtime_providers.rs`, `src-tauri/src/repositories/provider_runtime_bindings.rs` — package-first provider creation through the same policy.
- Modify: `src/storage/types.ts`, `src/storage/client.ts`, `src/query/keys.ts`, `src/query/options.ts`, `src/query/dataChangeEventBindings.ts` — DTOs, IPC, cache, and event invalidation.
- Modify: `src/features/plugins/InstalledPluginVersions.tsx`, `src/features/plugins/IntegrationEditor.tsx`, `src/features/plugins/RuntimeLifecyclePanel.tsx`, `src/features/models/ProviderEditor.tsx`, `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts` — authorize-default, pending, retry, and advanced fallback UX.
- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs`, `src-tauri/src/cmds/legacy_runtime_inventory.rs` when introduced by Phase 12 Task 1 — include policy/readiness blockers.
- Modify: `docs/plans/runtime-plugin-system/README.md`, `docs/plans/runtime-plugin-system/phase-12-legacy-retirement.md` — phase dependency and retirement gates.
- Test: `src-tauri/src/services/default_package_activation.rs`, `src-tauri/src/services/google_translate_web_runtime_tests.rs`, `src-tauri/src/services/edge_tts_runtime_tests.rs`, `src-tauri/src/services/google_cloud_runtime_tests.rs`, `src-tauri/src/services/paddleocr_runtime_tests.rs`, `src-tauri/src/services/runtime_provider_tests.rs`, `src-tauri/src/storage/tests.rs`, `src/features/plugins/defaultPackageActivationPresentation.test.ts`, `src/features/plugins/runtimeLifecyclePresentation.test.ts`, and `src/query/dataChangeEventBindings.test.ts`.

## Seams

- **Seam:** `preview_default_package_activation` — returns exact publisher/package/permission details from a vendor-root/store re-verified installed package without mutating defaults or grants.
- **Seam:** `authorize_default_plugin_package` — atomically sets the default and persists a future-instance authorization policy only after exact preview confirmation.
- **Seam:** `save_integration_instance` — creates a new integration against an authorized default as package-first `pending_activation`, then returns promptly.
- **Seam:** `save_provider_instance` — creates provider runtime bindings through the same generic default policy.
- **Seam:** `preview_default_runtime_authority` / `confirm_default_runtime_authority` — reviews and applies only authority beyond the default policy, bound to subject, exact package, config identity, normalized origin/method/auth, and resource limits.
- **Seam:** `DefaultPackageActivationService::activate_pending_subject` — shares immutable package verification per digest while applying migration/grant/CAS independently per subject.
- **Seam:** `retry_default_runtime_activation` — retries the retained exact package requirement without digest entry or legacy fallback.
- **Seam:** `recover_pending_default_runtime_activations` — resumes only eligible `local_creation` intents and never import-created pending rows.
- **Seam:** `list_installed_plugin_versions` — exposes whether a default is authorized, stale, confirmation-required, or absent.
- **Seam:** Plugins/Integration/Provider UI — displays authorization details, pending activation, actionable failures, and hides manual digest entry during normal default activation.
- **Seam:** `legacy_runtime_inventory` — blocks retirement while a replacement lacks authorized package-first creation.

## Tasks

### Task 1: Persist exact default activation policies

**Seam:** `list_installed_plugin_versions`

**Outcome:** Defaults and future-instance authorization are distinct, exact-bound persisted states; existing defaults remain unauthorized after migration.

**Files:**

- Create: `src-tauri/migrations/0027_default_package_activation_policies.sql`
- Create: `src-tauri/src/domain/default_package_activation.rs`
- Create: `src-tauri/src/repositories/default_package_activation_policies.rs`
- Modify: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/domain/plugin_package.rs`, `src-tauri/src/repositories/installed_plugin_versions.rs`
- Test: migration tests in `src-tauri/src/storage/migrations.rs`; repository tests beside the repository

**Steps:**

- [ ] **Red:** Add a migration test with an existing `plugin_default_versions` row; assert the upgraded DB reports the default but no authorization policy.
- [ ] **Green:** Add `plugin_default_activation_policies` keyed by `plugin_id`, with exact `package_digest`, publisher key ID/fingerprint, permission-request digest, approved authority constraints JSON/digest, policy source (`user_confirmed` or `vendor_bootstrap`), and timestamps.
- [ ] **Red:** Persist activation intents for integration/provider subjects and assert `local_creation` and `import_requires_confirmation` remain distinguishable after restart.
- [ ] **Green:** Add `default_runtime_activation_intents` with subject kind/ID, exact digest, source, expected config digest/update token, state, normalized error, and timestamps; never store secrets.
- [ ] **Red:** Add repository behavior tests for exact lookup and automatic invalidation when digest, publisher identity, permission digest, or content availability differs.
- [ ] **Green:** Add domain/repository APIs and expose policy status on installed-version DTOs without treating an old default row as authorized.
- [ ] Keep execution grants instance-scoped; the policy is a template/constraint, never an executable grant.

**Validation:**

- Run (red): `mise run test default_package_activation_migration -- --nocapture`
- Expected: failure because migration 27/policy status does not exist.
- Run (green): `mise run test default_package_activation_migration -- --nocapture`
- Expected: existing defaults are preserved but unauthorized; exact policy rows round-trip.

### Task 2: Preview and authorize a default package

**Seam:** `preview_default_package_activation`, `authorize_default_plugin_package`

**Outcome:** “Set as default” shows and records exact future-instance authority rather than writing only a catalog pointer.

**Files:**

- Create: `src-tauri/src/services/default_package_activation.rs`, `src-tauri/src/cmds/default_package_activation.rs`
- Modify: `src-tauri/src/services/plugin_store.rs`, `src-tauri/src/cmds/plugin_packages.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, command/ACL registration files
- Test: service/command tests in `src-tauri/src/services/default_package_activation.rs` and command/AppManifest/ACL coverage in `src-tauri/src/storage/tests.rs`

**Steps:**

- [ ] **Red:** Preview a real signed installed fixture and assert package digest, publisher fingerprint, runtime kind, capability majors, fixed network authority, dynamic authority warnings, auth policies, resource limits, and an opaque expiring preview ID.
- [ ] **Green:** Re-verify retained archive/content with the external vendor/user trust root and build a non-mutating preview from signed data only.
- [ ] **Red:** Apply with missing acknowledgement, stale preview, replaced package/store generation, revoked publisher, or mismatched digest; assert no default or policy mutation.
- [ ] **Green:** Atomically write `plugin_default_versions` plus the exact policy after a final re-verification and preview CAS.
- [ ] Mark instance-configured origins outside explicit preview constraints as requiring later instance confirmation; never authorize an arbitrary future origin.
- [ ] Replace the public direct-set behavior. Keep an internal vendor-bootstrap path that accepts only entries from `src-tauri/resources/plugins/default-activation-policies.json`, generated by the release package pipeline with exact package digest, publisher fingerprint, permission-request digest, and authority ceiling.
- [ ] Reject vendor-signed but non-host-shipped packages, resource/package replacement, publisher revocation, and permission expansion; vendor signature alone never grants bootstrap-default eligibility.

**Validation:**

- Run (red): `mise run test default_package_activation_authorization -- --nocapture`
- Expected: preview/apply interfaces or exact policy checks are missing.
- Run (green): `mise run test default_package_activation_authorization -- --nocapture`
- Expected: only exact confirmed package authority becomes the default policy.

### Task 3: Create integrations package-first

**Seam:** `save_integration_instance`

**Outcome:** An authorized default creates an exact package-backed pending instance immediately; no transient active `bundled-rust` row or manual digest is required.

**Files:**

- Modify: `src-tauri/src/services/default_package_activation.rs`, `src-tauri/src/services/service_integrations.rs`, `src-tauri/src/cmds/service_integrations.rs`, `src-tauri/src/repositories/integration_instances.rs`, `src-tauri/src/services/runtime_lifecycle.rs`
- Test: integration/runtime tests for Google Web, Edge TTS, Google Cloud, and PaddleOCR

**Steps:**

- [ ] **Red:** Through `save_integration_instance`, create each integration with an authorized default and assert the returned DTO has target runtime kind/digest, `pending_activation`, no grant revision, and no legacy runtime identity.
- [ ] **Green:** Resolve the exact policy before insert and persist package requirement + pending state plus a `local_creation` activation intent in the create transaction; return without waiting for large-package verification.
- [ ] **Red:** Complete activation and assert final re-verification, config migration/normalization, preference validation, one instance grant revision, and CAS transition to `active`.
- [ ] **Green:** Route background work through the shared activation service and emit `SERVICE_INTEGRATIONS_CHANGED` after durable create and final transition.
- [ ] **Red:** Change/disable/delete/explicitly upgrade the instance during activation; assert background activation does not overwrite or resurrect it.
- [ ] **Green:** Preserve current CAS/fail-closed behavior and remove the PaddleOCR-only deferred command branch after the generic path passes.
- [ ] Remove `is_host_allowed_vendor_default` and plugin-specific vendor-default predicates only after equivalent policy security tests pass.

**Validation:**

- Run (red): `mise run test default_package_activation_integration -- --nocapture`
- Expected: new instances still return legacy identity or require plugin-ID allowlisting.
- Run (green): `mise run test default_package_activation_integration -- --nocapture`
- Expected: all authorized integration defaults use the same package-first path.

### Task 4: Create providers package-first

**Seam:** `save_provider_instance`

**Outcome:** LLM/provider defaults use the same persisted authorization semantics instead of provider-specific reviewed-vendor branches.

**Files:**

- Modify: `src-tauri/src/services/providers.rs`, `src-tauri/src/cmds/providers.rs`, `src-tauri/src/services/runtime_providers.rs`, `src-tauri/src/repositories/provider_runtime_bindings.rs`, `src-tauri/src/services/default_package_activation.rs`
- Test: provider/runtime catalog and binding coverage in `src-tauri/src/services/runtime_provider_tests.rs`

**Steps:**

- [ ] **Red:** Create a provider matching an authorized default and assert its binding is exact package `pending_activation`, not `legacy-frontend-provider`.
- [ ] **Green:** In the same provider create transaction, persist the provider row, exact package `pending_activation` binding, and `local_creation` activation intent while preserving provider/model/profile UUIDs and credential journaling.
- [ ] **Red:** Inject failure between provider/binding/intent writes and assert the transaction rolls back all three, leaving no orphan pending provider or recovery intent.
- [ ] **Green:** Keep all three writes under the existing provider create transaction and credential-journal compensation boundary.
- [ ] **Red:** Verify alias mismatch, endpoint/auth mismatch, revoked publisher, stale policy, and authority expansion remain inactive without legacy fallback.
- [ ] **Green:** Replace `vendor_default_candidate`/reviewed-vendor special cases with generic exact policy checks.
- [ ] Existing provider rows and bindings remain unchanged until explicit lifecycle migration.

**Validation:**

- Run (red): `mise run test default_package_activation_provider -- --nocapture`
- Expected: provider creation still depends on legacy/vendor-special-case binding.
- Run (green): `mise run test default_package_activation_provider -- --nocapture`
- Expected: authorized provider defaults activate through the shared policy.

### Task 5: Confirm instance authority outside the default policy

**Seam:** `preview_default_runtime_authority`, `confirm_default_runtime_authority`

**Outcome:** Dynamic/config-derived authority receives an exact instance-level confirmation without broadening the default policy or requiring a digest.

**Files:**

- Modify: `src-tauri/src/domain/default_package_activation.rs`, `src-tauri/src/services/default_package_activation.rs`, `src-tauri/src/cmds/default_package_activation.rs`, command/ACL registration files
- Test: authority preview/confirm service and command tests

**Steps:**

- [ ] **Red:** Preview an instance-configured origin outside the default policy and assert the response includes subject kind/ID, exact package digest, expected instance update token, config digest, normalized origin/base URL, method, auth policy, response modes, byte/time limits, and an opaque expiring preview ID.
- [ ] **Green:** Build the preview from the current subject, externally re-verified package, normalized config, and resolved authority; store only bounded preview session state.
- [ ] **Red:** Confirm after config change, subject update/delete, package/default/publisher change, preview expiry, or authority change; assert no grant or activation mutation.
- [ ] **Green:** Final re-verify and CAS-create one instance grant revision, then activate the exact retained package. Confirmation never modifies the future-instance default policy.

**Validation:**

- Run (red): `mise run test default_runtime_authority_confirmation -- --nocapture`
- Expected: no subject/config-bound preview-confirm seam exists.
- Run (green): same command.
- Expected: only the reviewed resolved authority activates the subject.

### Task 6: Single-flight immutable package verification

**Seam:** `DefaultPackageActivationService::activate_pending_subject`

**Outcome:** Subjects sharing a digest reuse one immutable verification result while migration, authority derivation, grant creation, and CAS remain subject-specific.

**Files:**

- Modify: `src-tauri/src/services/default_package_activation.rs`, `src-tauri/src/services/runtime_lifecycle.rs`
- Test: focused activation service concurrency tests

**Steps:**

- [ ] **Red:** Activate two subjects for the same digest and assert one package verification pipeline, two independent subject migrations/authority checks, and two distinct grant/CAS outcomes.
- [ ] **Green:** Add per-digest single-flight before the first full verification and fan out an immutable verified snapshot/result; never share subject config, migration output, or grants.
- [ ] **Red:** Cover one waiter cancellation/deletion, verification failure, task panic, map cleanup/retry, and two different digests running concurrently.
- [ ] **Green:** Run shared verification independently of every caller: caller cancellation stops only that caller’s wait, never the shared task. Verification failure or panic wakes all waiters with the same normalized failure. Clean up the map with a per-entry generation token so an old completion cannot remove a newer task for the same digest. Never hold DB transactions, store locks, or async mutex guards across subject work.

**Validation:**

- Run (red): `mise run test default_package_activation_single_flight -- --nocapture`
- Expected: duplicate verification, cross-subject state, or leaked in-flight entries violate assertions.
- Run (green): same command.
- Expected: verification is bounded per digest and subject outcomes remain isolated.

### Task 7: Persist deterministic failure and retry

**Seam:** `retry_default_runtime_activation`

**Outcome:** Every terminal activation failure is visible and retryable against the retained exact requirement without legacy fallback.

**Files:**

- Modify: `src-tauri/src/services/default_package_activation.rs`, `src-tauri/src/repositories/integration_instances.rs`, `src-tauri/src/repositories/provider_runtime_bindings.rs`, `src-tauri/src/cmds/default_package_activation.rs`
- Test: failure-state and retry service/command tests

**Steps:**

- [ ] **Red:** Simulate signature/store mismatch, migration error, stale policy, authority expansion, and subject CAS conflict; assert `pending_activation` never silently becomes legacy or stays ambiguous.
- [ ] **Green:** Persist normalized activation intent/error states and transition the subject to `unavailable` or confirmation-required while retaining the exact package requirement.
- [ ] **Red:** Retry without a digest and assert it uses only the retained subject requirement after current policy/store checks; a changed default does not retarget it.
- [ ] **Green:** Implement retry IPC and emit integration/provider/package events for durable retry and final transitions.

**Validation:**

- Run (red): `mise run test default_package_activation_retry -- --nocapture`
- Expected: failure remains ambiguous or retry requires a manually entered digest.
- Run (green): same command.
- Expected: exact retained activation retries safely and visibly.

### Task 8: Recover only eligible local creation intents

**Seam:** `recover_pending_default_runtime_activations`

**Outcome:** Restart resumes local creation work but never activates or grants imported pending data.

**Files:**

- Modify: `src-tauri/src/services/default_package_activation.rs`, `src-tauri/src/state.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/import_validation.rs`
- Test: startup recovery and import-boundary tests

**Steps:**

- [ ] **Red:** Persist one `local_creation` and one `import_requires_confirmation` pending intent, restart services, and assert only the local intent is scheduled.
- [ ] **Green:** Query recovery by exact provenance/state; resume eligible local work only after current policy/store checks.
- [ ] **Red:** Cover import apply followed by event processing, process restart, concurrent recovery workers, stale policy, and already-confirmed/active subjects; assert imported rows never execute or gain grants.
- [ ] **Green:** Claim recovery work with durable CAS/idempotency and mark ineligible stale local intents actionable unavailable.

**Validation:**

- Run (red): `mise run test default_package_activation_startup_recovery -- --nocapture`
- Expected: recovery cannot distinguish local creation from imported pending data.
- Run (green): same command.
- Expected: only eligible local intents resume and all import states remain inactive.

### Task 9: Replace default and manual-hex UX

**Seam:** Installed Plugins, Integration Editor, and Provider Editor UI

**Outcome:** Users authorize once when setting a default, see activation progress/failure, and never type a digest in the normal flow.

**Files:**

- Create: `src/features/plugins/DefaultPackageActivationDialog.tsx`, `src/features/plugins/DefaultRuntimeAuthorityDialog.tsx`, `src/features/plugins/defaultPackageActivationPresentation.ts`, `src/features/plugins/defaultPackageActivationPresentation.test.ts`
- Modify: `src/features/plugins/InstalledPluginVersions.tsx`, `src/features/plugins/IntegrationEditor.tsx`, `src/features/plugins/RuntimeLifecyclePanel.tsx`, `src/features/models/ProviderEditor.tsx`, `src/storage/types.ts`, `src/storage/client.ts`, query/event files, locales
- Test: frontend component/presentation and data-change binding tests

**Steps:**

- [ ] **Red:** Assert “Set as default” opens a preview showing publisher, exact digest, capabilities, network/auth/resource authority, future-instance scope, and any instance-confirmation limitation.
- [ ] **Green:** Add preview/confirm mutation and show default states: unauthorized, authorized, stale, and active default.
- [ ] **Red:** Assert pending instances/providers show “Verifying and activating default package”, disable normal actions that require readiness, and hide the manual digest field.
- [ ] **Green:** Map runtime state/error codes to pending, confirmation, retry, and unavailable UI; refresh from existing data-change events.
- [ ] **Red:** Assert authority outside the default policy opens the subject/config-bound preview from Task 5 and confirms only those additional entries.
- [ ] **Green:** Add `DefaultRuntimeAuthorityDialog`; never copy the target digest into an editable field or broaden the saved default policy.
- [ ] **Red:** Assert manual digest is shown only in an explicitly expanded Advanced recovery section when no usable default exists or the user chooses another package.
- [ ] **Green:** Move digest entry behind Advanced recovery and prefill installed alternatives where possible.
- [ ] Keep copy short: default authorization applies to future instances only and does not migrate existing ones.

**Validation:**

- Run (red): `bun test src/features/plugins/defaultPackageActivationPresentation.test.ts src/features/plugins/runtimeLifecyclePresentation.test.ts src/query/dataChangeEventBindings.test.ts`
- Expected: pending/default authorization states are absent or misleading.
- Run (green): same command.
- Expected: normal flows need no digest entry and cache refresh reaches final runtime state.

### Task 10: Preserve Phase 11 trust and migration boundaries

**Seam:** Runtime plugin export/import

**Outcome:** Default policies remain local; imports stay inactive and cannot inherit future-instance authority.

**Files:**

- Modify: `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/import_validation.rs`, Phase 11 fixtures/tests, `src/features/settings/configurationTransfer.test.ts`
- Test: import/export security coverage

**Steps:**

- [ ] **Red:** Export a configured default policy and assert the export contains no default policy, preview, publisher approval, execution grant, or activation authority.
- [ ] **Green:** Keep policy tables outside export and forbidden-key scanning.
- [ ] **Red:** Import a package requirement that matches a locally authorized default; assert import apply persists `import_requires_confirmation`, remains inactive, and does not auto-activate before or after restart.
- [ ] **Green:** Preserve Phase 11’s separate post-import confirmation boundary; package-first auto-activation and recovery apply only to persisted `local_creation` intents.

**Validation:**

- Run (red): `mise run test runtime_plugin_import_no_execution -- --nocapture`
- Expected: any accidental policy portability or import-time activation fails.
- Run (green): same command.
- Expected: local defaults do not weaken import/reapproval semantics.

### Task 11: Gate Phase 12 retirement on package-first creation

**Seam:** `legacy_runtime_inventory`

**Outcome:** No executor is retired until its replacement supports authorized default creation and no new legacy rows can be created for that slice.

**Files:**

- Modify: `docs/plans/runtime-plugin-system/README.md`, `docs/plans/runtime-plugin-system/phase-12-legacy-retirement.md`
- Modify when implemented: `src-tauri/src/services/legacy_runtime_inventory.rs`, `src-tauri/src/cmds/legacy_runtime_inventory.rs`
- Test: Phase 12 inventory tests and grep gates

**Steps:**

- [ ] **Red:** Inventory a plugin with an installed replacement but no exact authorized default; assert retirement is blocked.
- [ ] **Green:** Add default-policy state, package-first create readiness, pending/unavailable counts, and last legacy-create capability to inventory.
- [ ] **Red:** Attempt creation after one executor’s retirement gate is enabled without an authorized default; assert actionable rejection and no legacy row.
- [ ] **Green:** Disable legacy creation per retired executor only after its policy/create tests and stable-release gate pass.
- [ ] Remove plugin-ID auto-pin allowlists and provider reviewed-vendor branches before Phase 12 Task 5 removes shared plugin-ID code.

**Validation:**

- Run (red): `mise run test legacy_runtime_inventory -- --nocapture`
- Expected: inventory does not account for default activation readiness.
- Run (green): same command.
- Expected: retirement cannot proceed while package-first creation is incomplete.

## Final Validation

```bash
mise run test default_package_activation -- --nocapture
mise run test runtime_plugin_security -- --nocapture
mise run test runtime_plugin_import -- --nocapture
mise run test legacy_runtime_inventory -- --nocapture
bun test src/features/plugins src/query/dataChangeEventBindings.test.ts
mise run typecheck
mise run lint
mise run format:check
mise run build
mise run tauri:build
```

Expected: authorized defaults create package-first integrations/providers without manual digest input; large activation is bounded and visible; imports remain inactive; Phase 12 inventory blocks unsafe retirement.

## Failure Behavior

- Default preview stale or package/store changed — reject apply; keep the prior default/policy unchanged.
- Publisher revoked/disabled or trust root missing — invalidate policy and block new activation.
- Permission request or publisher identity changed — require a new default authorization.
- Instance authority exceeds policy — retain exact package pending/inactive and request only the additional authority.
- Activation verification/migration/CAS failure — retain exact requirement as unavailable; never fall back to legacy or replay requests.
- Default changed during activation — CAS fails; the instance keeps the digest selected at creation until explicit retry/choice.
- Application exits during activation — startup recovery resumes exact eligible work or marks it actionable; no execution before grant completion.

## Privacy and Security

- Default policy is local trust state and is never exported.
- Policy binds exact digest, publisher identity, permission request, and authority constraints; package ID/version alone are insufficient.
- Future-instance authorization does not expose credentials or authorize arbitrary instance-configured origins.
- Execution grants remain instance/package revisions and are created only after final store re-verification and resolved authority checks.
- Existing TOCTOU, store-generation, module audit, broker, auth, resource-limit, and CAS checks remain mandatory.
- Native workers remain vendor-only under Phase 10 containment rules; this plan does not broaden native publisher eligibility.

## Rollout Notes

1. Ship migration/policy preview first; existing defaults appear as “authorization required”.
2. Reauthorize each desired default once. Existing instances remain unchanged.
3. Enable package-first creation per integration/provider after its conformance tests pass.
4. Observe one stable dual-stack release with activation failure/pending inventory.
5. Begin Phase 12 retirement one executor at a time.
6. Remove the temporary PaddleOCR deferred-`bundled-rust` path when Task 3 lands.

## Risks and Mitigations

- Default authorization becomes blanket future trust — exact digest/publisher/permission/authority binding and reapproval on any change.
- Dynamic origins are over-authorized — do not preauthorize unresolved instance-configured origins; request instance confirmation.
- Large packages exhaust memory under parallel creates — per-package single-flight before full verification.
- Event order leaves stale Bundled/legacy DTOs — package-first pending DTO plus durable-create/final-transition invalidation tests.
- Phase 12 removes fallback too early — inventory gate includes authorized-default and package-first creation readiness.
- Vendor bootstrap bypasses user semantics — persist the same policy shape with explicit `vendor_bootstrap` source and external-root verification.

## Open Questions

None blocking the plan. The confirmed roadmap placement is Phase 11.5, required before Phase 12.
