# Implementation Plan

**Goal:** Fix every actionable legacy runtime retirement re-review finding without disabling active users, deleting unrelated dependencies, or attaching incompatible provider packages.

**Inputs:** The supplied Standards and Spec re-review; `AGENTS.md`; the current frontend retirement panel; the Rust retirement inventory, gates, services, state wiring, migration runner, and runtime tests.

**Assumptions:**

- The production integration retirement sequence is Google Translate Web, Edge TTS, then Google Cloud. PaddleOCR is not in this retirement scope.
- The creation gate and the executor release gate are separate decisions. Production must stop new in-scope legacy creation. Production must keep an executor available while an enabled legacy row still needs it.
- No repository evidence identifies an LLM provider adapter that has completed one stable package-backed release. Provider adapter production retirement remains disabled until that evidence exists.
- The listed seams are the proposed test boundaries. Confirm them before implementation starts, as required by the repository TDD process.

**Architecture:** Split the current all-purpose retirement gate into a production creation policy and an inventory-derived execution release gate. Build provider inventory per adapter, resolve one exact authorized replacement digest per row, and use a non-cascading provider deletion path. Keep migration 0030 as a registered no-op checkpoint so upgrades preserve user state and the runtime inventory remains the decision authority.

**Tech Stack:** Rust 2024, Tauri 2 IPC, rusqlite migrations, serde, React 19, TypeScript, TanStack Query, Base UI, Bun Test, cargo test through mise.

---

## Finding Coverage

| Finding | Resolution |
| --- | --- |
| `Keep Disabled` is not a direct label | Rename the DTO capability and UI copy to `Disable`; test the accessible button name and action. |
| Repeated `isProvider` branches | Add one subject-kind operation map for migrate, disable, and delete. |
| Rust `subject_kind: String` | Add a serde `LegacyRuntimeSubjectKind` enum that serializes to the existing snake-case tokens. |
| Repeated package-first tamper fixture | Extract one fixture helper that returns the activated instance ID. |
| Production retirement gate is disabled | Wire a production creation policy into integrations, providers, and inventory. Derive and wire a separate execution gate into the router. |
| Migration disables active rows and is unregistered | Replace 0030 with a no-op checkpoint, register it, and prove enabled rows remain enabled. |
| Provider delete cascades unrelated state | Add a retirement-only, fail-closed provider delete operation. It deletes a provider only when no models, profile references, or unrelated runtime bindings exist. |
| Provider replacement digest is entry-wide and incompatible | Build provider inventory per adapter and select exactly one authorized default whose `providerRuntime.legacyAliases` contains that adapter. The panel must use the row digest. |
| Provider retirement lacks zero-enabled and stable-release checks | Evaluate readiness per adapter. Keep the production provider retirement allowlist empty until stable-release evidence names an eligible adapter. |
| PaddleOCR scope creep | Remove PaddleOCR from the production policy, retirement inventory, and migration scope. The no-op migration contains no executor list. |

## Explicit Out of Scope

- **Enable production retirement for a specific LLM provider adapter.** The repository has package manifests and authorization state, but no release-history record that proves one stable release has passed. Enabling an adapter would invent release evidence and could strand active providers. This plan adds the adapter-scoped policy and readiness mechanism, but leaves the production provider allowlist empty. A follow-up release change must cite the eligible adapter and stable release before it adds that adapter.
- **Change ordinary provider deletion outside the retirement panel.** `ProviderService::delete` has existing product semantics. The fix adds a separate fail-closed retirement operation so unrelated screens do not change.
- **Retire PaddleOCR.** The supplied spec excludes it from the ordered retirement sequence.

## File Map

- Modify: `src-tauri/src/domain/legacy_runtime_inventory.rs` — add the serialized subject enum, direct action capability names, and any adapter-scoped inventory identity needed by the public DTO.
- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs` — remove PaddleOCR, build provider slices per adapter, resolve exact compatible replacement packages through the verified provider catalog, and calculate adapter-scoped readiness.
- Modify: `src-tauri/src/services/legacy_runtime_retirement.rs` — separate production creation policy from execution release policy; replace the provider-wide Boolean with adapter IDs.
- Modify: `src-tauri/src/services/service_integrations.rs` — enforce the production integration creation policy.
- Modify: `src-tauri/src/services/providers.rs` — enforce provider creation policy by adapter and add non-cascading retirement deletion.
- Modify: `src-tauri/src/services/runtime_router.rs` — deny bundled execution only for inventory-ready release slices.
- Modify: `src-tauri/src/state.rs` — construct one production policy, inject it and the verified provider catalog service into inventory, derive the release gate, and inject the applicable gates into creation services and the router.
- Modify: `src-tauri/src/cmds/providers.rs` — expose the retirement-only safe provider delete command.
- Modify: `src-tauri/src/lib.rs` — register the new Tauri command.
- Modify: `src-tauri/src/storage/migrations.rs` — register migration 0030 and test preservation behavior.
- Modify: `src-tauri/migrations/0030_disable_retired_legacy_runtimes.sql` — replace unconditional updates with a documented no-op checkpoint.
- Modify: `src-tauri/src/services/google_translate_web_runtime_tests.rs` — extract the repeated activated package-first fixture helper.
- Modify: `src/storage/types.ts` — keep the frontend subject union aligned and rename `keepDisabledAvailable` to `disableAvailable`.
- Modify: `src/storage/client.ts` — add the retirement-only safe provider delete client.
- Modify: `src/features/plugins/LegacyRuntimeRetirementPanel.tsx` — use row-level digests, a subject operation map, the direct Disable action, and the safe provider delete command.
- Modify: `src/features/plugins/LegacyRuntimeRetirementPanel.test.tsx` — cover direct labels, subject routing, row-specific digests, and safe provider deletion.
- Modify: `src/i18n/locales/en.ts` — replace `keepDisabled` with `disable` and keep concise supporting copy.

## Seams

- **Seam:** `LegacyRuntimeInventoryDto` serde JSON contract — only declared subject-kind tokens serialize and deserialize.
- **Seam:** `LegacyRuntimeInventoryService::list_inventory` — each integration or provider-adapter slice reports exact blockers, actions, and compatible replacement digest.
- **Seam:** retirement-only provider delete Tauri command — unsafe deletion fails without changing provider, models, profiles, credentials, or runtime bindings; a truly unused provider can be deleted.
- **Seam:** `LegacyRuntimeRetirementPanel` user interaction — buttons expose direct copy and route each subject action with the row-owned authority values.
- **Seam:** `ServiceIntegrationService::save` and `ProviderService::save` from production-wired `AppState` — new in-scope legacy rows cannot be created.
- **Seam:** `RuntimeRouter::resolve` — active legacy rows retain execution, while a release-ready retired executor is unavailable.
- **Seam:** `storage::migrations::migrate` — migration 0030 advances the schema version without changing enabled state or deleting data.
- **Seam:** Google Web runtime resolution tests — all tamper scenarios still start from a real activated package-first instance.

## Tasks

### Task 1: Close the inventory subject contract

**Seam:** `LegacyRuntimeInventoryDto` serde JSON contract.

**Outcome:** Rust cannot construct an unresolved row with an unknown subject kind, and JSON remains compatible with the frontend union.

**Files:**

- Modify: `src-tauri/src/domain/legacy_runtime_inventory.rs`
- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs`
- Modify: `src/storage/types.ts`

**Steps:**

- [ ] **Red:** Add serde contract tests that deserialize `integration_instance` and `provider_binding`, round-trip both tokens, and reject `unknown_subject`.
- [ ] **Green:** Add `LegacyRuntimeSubjectKind` with `Serialize`, `Deserialize`, and `#[serde(rename_all = "snake_case")]`; change `LegacyRuntimeUnresolvedRowDto.subject_kind` and the internal unresolved-row representation to this enum.
- [ ] Keep the TypeScript union exactly `"integration_instance" | "provider_binding"`; do not add a string fallback.
- [ ] Update comments to describe `disable_available`, not “Keep Disabled.”

**Validation:**

- Run (red): `mise run test legacy_runtime_inventory_subject_kind_serde`
- Expected: compilation or assertions fail because the enum contract does not exist.
- Run (green): `mise run test legacy_runtime_inventory_subject_kind_serde`
- Expected: both known tokens round-trip and the unknown token is rejected.
- Run: `mise run typecheck`
- Expected: TypeScript accepts the unchanged closed union.

### Task 2: Resolve provider retirement per adapter

**Seam:** `LegacyRuntimeInventoryService::list_inventory`.

**Outcome:** Each provider adapter has an independent retirement slice. A row is migratable only when exactly one installed, content-available, authorized default package declares that adapter in `providerRuntime.legacyAliases`.

**Files:**

- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs`
- Modify: `src-tauri/src/domain/legacy_runtime_inventory.rs`
- Modify: `src-tauri/src/state.rs`

**Steps:**

- [ ] **Red:** Add an inventory test with two legacy adapters and two authorized provider packages. Assert that each row receives only its compatible package digest, not the last or entry-wide digest.
- [ ] **Green:** Group legacy provider bindings by `adapter_id` and emit one inventory entry per adapter. Use a stable slice identity such as `legacy-frontend-provider:<adapter_id>` while retaining `runtimeKind = "legacy-frontend-provider"`.
- [ ] **Red:** Add zero-match and multiple-match tests. Assert `replacementPackageDigest = null`, `migrateAvailable = false`, and non-ready blocker state for both cases.
- [ ] **Green:** Inject the already-constructed `ProviderRuntimeService` into `LegacyRuntimeInventoryService` from `state.rs`. Reuse its verified catalog output, then filter catalog defaults by content availability, authorization status, and exact `legacyAliases` membership. Accept one match only. Treat catalog verification failure or ambiguity as fail-closed; do not trust manifest JSON parsed only from SQLite.
- [ ] **Red:** Add a readiness test with one enabled provider on adapter A and zero enabled providers on adapter B. Assert only adapter A has `enabled_legacy_rows`.
- [ ] **Green:** Calculate counts, dependency totals, package readiness, and retirement readiness from each adapter snapshot. Do not share counts or digests across adapters.
- [ ] Remove `PADDLEOCR_PLUGIN_ID` from the integration inventory list. Keep only Google Web, Edge TTS, and Google Cloud in the specified order.

**Validation:**

- Run (red/green after each cycle): `mise run test legacy_runtime_inventory_provider`
- Expected red: the current aggregate provider entry assigns one digest/count set to all rows.
- Expected green: exact per-adapter digest, ambiguity, and enabled-row assertions pass.

### Task 3: Add non-cascading retirement deletion

**Seam:** retirement-only provider delete Tauri command.

**Outcome:** The retirement panel cannot call whole-provider cascading deletion. The new operation deletes only a provider that has no dependent models or profile references and no runtime binding other than the target legacy binding.

**Files:**

- Modify: `src-tauri/src/services/providers.rs`
- Modify: `src-tauri/src/cmds/providers.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/storage/client.ts`
- Modify: `src-tauri/src/domain/legacy_runtime_inventory.rs`
- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs`

**Steps:**

- [ ] **Red:** Add a service/command test with a target legacy binding plus an unrelated package-backed binding and model. Call the retirement delete seam. Assert a stable conflict, and assert all provider rows, bindings, models, profile references, and credential state remain unchanged.
- [ ] **Green:** Add a retirement-specific input containing `providerId`, `adapterId`, and the inventory binding `updateToken`. In one database transaction, verify the exact legacy binding token, count every provider model and every runtime binding, and reject unless the target legacy binding is the only binding and no model or profile dependency exists.
- [ ] Do not call `ProviderService::delete` from this path. Reuse its credential preflight/journal pattern, but perform only the deletion proven safe by the transaction.
- [ ] **Red:** Add a stale-token test and assert no state changes.
- [ ] **Green:** Enforce binding-token CAS before any credential journal or database delete.
- [ ] **Red:** Add the success case for a disabled, unused provider with one legacy binding. Assert the provider and its credential are removed and no unrelated row changes.
- [ ] **Green:** Complete the narrow deletion and emit the existing provider data-changed event only after success.
- [ ] Change provider `deleteAvailable` calculation to require the full safe-delete preconditions. Keep integration delete availability based on integration dependency count.

**Validation:**

- Run (red/green after each cycle): `mise run test retirement_delete_provider`
- Expected red: current behavior deletes unrelated provider state or lacks the safe command.
- Expected green: dependency and CAS failures preserve all state; only the isolated provider is deleted.

### Task 4: Make panel actions direct and subject-specific

**Seam:** `LegacyRuntimeRetirementPanel` user interaction.

**Outcome:** The panel displays `Disable`, uses each row's replacement digest, and routes migrate/disable/delete through one subject operation map.

**Files:**

- Modify: `src/features/plugins/LegacyRuntimeRetirementPanel.tsx`
- Modify: `src/features/plugins/LegacyRuntimeRetirementPanel.test.tsx`
- Modify: `src/storage/types.ts`
- Modify: `src/storage/client.ts`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src-tauri/src/domain/legacy_runtime_inventory.rs`
- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs`

**Steps:**

- [ ] **Red:** Change panel expectations from `Keep Disabled` to `Disable`. Assert enabled rows expose an enabled Disable button and already-disabled rows expose it disabled.
- [ ] **Green:** Rename the translation key to `plugins.retirement.disable` and the DTO field to `disableAvailable`. Keep `keptDisabledHint` as status copy because it is not an action.
- [ ] **Red:** Return an entry digest that differs from the row digest. Assert integration and provider migration IPC receives the row digest.
- [ ] **Green:** Remove the entry-wide `replacementDigest` variable and read `row.replacementPackageDigest` only.
- [ ] **Red:** Update the provider delete test to expect the new retirement-safe command with `providerId`, `adapterId`, and `updateToken`; assert `delete_provider_instance` is never invoked.
- [ ] **Green:** Define one `Record<LegacyRuntimeSubjectKind, RetirementSubjectOperations>` outside the component. Give each subject implementation `migrate`, `disable`, and `delete` operations. Replace all three `isProvider` branches with one strategy lookup.
- [ ] Preserve the existing sanitized error handling, query invalidation, confirmation dialog, and one-action-per-row serialization.

**Validation:**

- Run (red/green after each cycle): `bun test src/features/plugins/LegacyRuntimeRetirementPanel.test.tsx`
- Expected red: old copy, entry-wide digest use, or whole-provider delete calls fail the new assertions.
- Expected green: all retirement panel tests pass through the mocked Tauri IPC boundary.

### Task 5: Define staged production retirement policy

**Seam:** `ServiceIntegrationService::save` and `ProviderService::save` under explicit policy injection.

**Outcome:** The production creation policy is scoped and ordered. It blocks new legacy creation for Google Web, Edge TTS, and Google Cloud; it does not include PaddleOCR; provider decisions are adapter-specific.

**Files:**

- Modify: `src-tauri/src/services/legacy_runtime_retirement.rs`
- Modify: `src-tauri/src/services/service_integrations.rs`
- Modify: `src-tauri/src/services/providers.rs`

**Steps:**

- [ ] **Red:** Add policy tests that assert the three ordered integration IDs are in scope and PaddleOCR is not.
- [ ] **Green:** Replace the current four-executor production constant with the ordered three-executor creation policy.
- [ ] **Red:** Add provider tests showing adapter A can be retired without retiring adapter B. Assert the production provider adapter set is empty pending stable-release evidence.
- [ ] **Green:** Replace `provider_legacy_retired: bool` with a closed adapter-ID set. Change `require_package_first_for_provider` to accept the provider adapter ID.
- [ ] **Red:** Add create tests: an in-scope integration without a ready authorized default fails before insert; PaddleOCR keeps existing dual-stack behavior; an explicitly retired provider adapter fails while an unrelated adapter is unchanged.
- [ ] **Green:** Update integration and provider creation services to consult the scoped creation policy. Preserve package-first creation when the exact authorized default is ready.

**Validation:**

- Run (red/green after each cycle): `mise run test legacy_runtime_retirement`
- Expected red: the current provider-wide Boolean and PaddleOCR production membership violate the assertions.
- Expected green: all scope, ordering, and adapter-isolation assertions pass.

### Task 6: Wire creation and release gates safely

**Seam:** production-wired `AppState` service behavior and `RuntimeRouter::resolve`.

**Outcome:** Production uses the creation policy everywhere, but active legacy rows still execute. The router denies a legacy executor only when its inventory slice has zero enabled legacy rows and all release blockers are clear.

**Files:**

- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/services/legacy_runtime_retirement.rs`
- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs`
- Modify: `src-tauri/src/services/runtime_router.rs`

**Steps:**

- [ ] **Red:** Add an `AppState::initialize_for_tests` test that calls the public integration save seam and proves production wiring rejects new in-scope legacy creation when no authorized package-first path exists.
- [ ] **Green:** Construct the production creation policy once in `state.rs`. Inject the same value into `ServiceIntegrationService`, `ProviderService`, and `LegacyRuntimeInventoryService` instead of retaining disabled defaults.
- [ ] **Red:** Add a router test with an enabled legacy row. Build release state from its inventory and assert `RuntimeRouter::resolve` still returns the bundled adapter.
- [ ] **Green:** Add a distinct execution release gate derived from inventory. Exclude every slice with `enabledLegacyRowCount > 0` or any blocker. Do not reuse the creation policy directly as execution authority.
- [ ] **Red:** Add a ready-slice router test with zero enabled legacy rows, authorized package-first readiness, no pending/unavailable activations, and production release membership. Assert bundled resolution returns `PluginUnavailable`.
- [ ] **Green:** Inject the derived execution gate into `RuntimeRouter` in `state.rs`.
- [ ] Keep provider execution retirement empty until the stable-release adapter allowlist is populated. Inventory still reports adapter-specific blockers and readiness for release review.

**Validation:**

- Run (red/green after each cycle): `mise run test production_retirement_gate`
- Expected red: production services use disabled defaults and the router cannot distinguish creation retirement from safe executor release.
- Expected green: new legacy creation is blocked, active legacy execution remains available, and only ready slices deny bundled execution.

### Task 7: Register a state-preserving migration checkpoint

**Seam:** `storage::migrations::migrate`.

**Outcome:** Databases advance to version 30 without automatic disablement or deletion. User remediation remains explicit through inventory actions.

**Files:**

- Modify: `src-tauri/migrations/0030_disable_retired_legacy_runtimes.sql`
- Modify: `src-tauri/src/storage/migrations.rs`

**Steps:**

- [ ] **Red:** Add a migration test that migrates to version 29, inserts enabled legacy Google Web, Edge TTS, Google Cloud, PaddleOCR, and provider rows with dependencies, then migrates to latest. Assert every enabled flag and dependency row is unchanged and `user_version` becomes 30.
- [ ] **Green:** Replace migration 0030's `UPDATE` statements with comments and a transaction-safe no-op such as `SELECT 1;`. Update ABOUTME text to state that retirement is inventory-driven and never automatic.
- [ ] Register migration 0030 as the next entry in `MIGRATIONS`.
- [ ] Assert the migration contains no executor allowlist. This prevents PaddleOCR from re-entering scope through SQL.

**Validation:**

- Run (red): `mise run test retirement_migration_preserves_active_rows`
- Expected: version remains 29 because migration 0030 is not registered.
- Run (green): `mise run test retirement_migration_preserves_active_rows`
- Expected: version is 30 and all rows, enabled flags, and dependencies are unchanged.

### Task 8: Deduplicate the activated tamper fixture

**Seam:** Google Web runtime resolution tests.

**Outcome:** Four tamper tests share one real package-first activation helper that returns the active instance ID; assertions and production paths remain unchanged.

**Files:**

- Modify: `src-tauri/src/services/google_translate_web_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Convert the first repeated setup block to call `activate_package_first_tamper_fixture` before defining it. Keep the existing runtime-kind assertion in the test. Confirm the focused test fails to compile because the helper is missing.
- [ ] **Green:** Add the helper near the existing package-first test helpers. It must call `authorize_installed_default`, wire the integration lifecycle, create the real integration through `ServiceIntegrationService::save`, activate it through `DefaultPackageActivationService::activate_pending_subject`, verify `runtime_kind == "wasm-component"`, and return the instance UUID.
- [ ] Replace the other three identical setup blocks with the helper. Pass existing `db`, `packages`, `lifecycle`, package digest, and any required temp path explicitly; do not add global fixture state.
- [ ] Keep each tamper mutation and public runtime assertion in its original test.

**Validation:**

- Run (red): `mise run test runtime_rejects_archive_replaced_after_auto_pin_before_execution`
- Expected: compilation fails because `activate_package_first_tamper_fixture` is undefined.
- Run (green): `mise run test runtime_rejects_archive_replaced_after_auto_pin_before_execution`
- Expected: the test passes using a real active package-first instance.
- Run: `mise run test runtime_rejects_artifact_replaced_after_auto_pin_before_execution`
- Run: `mise run test runtime_snapshot_recheck_rejects_archive_only_replacement_after_archive_verification`
- Run: `mise run test runtime_snapshot_recheck_rejects_replacement_after_archive_verification`
- Expected: all three tests pass with unchanged tamper rejection behavior.

## Final Validation

- Run: `bun test src/features/plugins/LegacyRuntimeRetirementPanel.test.tsx`
- Expected: all panel behavior passes, including direct Disable copy, row digest authority, operation-map routing, and safe provider deletion.
- Run: `bun test`
- Expected: all frontend tests pass.
- Run: `mise run test legacy_runtime`
- Expected: focused retirement domain, inventory, policy, state, and migration tests pass.
- Run: `mise run test google_translate_web_runtime_tests`
- Expected: Google Web runtime tests pass after fixture extraction.
- Run: `mise run test`
- Expected: the complete Rust test suite passes.
- Run: `mise run typecheck`
- Expected: TypeScript reports no errors.
- Run: `mise run lint`
- Expected: ESLint and oxlint report no errors.
- Run: `mise run format:check`
- Expected: oxfmt and cargo fmt report no differences.
- Run: `mise run build`
- Expected: frontend typecheck and production build complete successfully.

## Failure Behavior

- Missing, unauthorized, stale, incompatible, or ambiguous replacement package — migration stays unavailable and no package digest is sent to IPC.
- Enabled legacy row — creation remains blocked for the retired slice, but its executor remains available until the user migrates, disables, or safely deletes the row.
- Provider has any model, profile reference, unrelated binding, or stale update token — retirement deletion returns a sanitized conflict and changes nothing.
- Migration 0030 — advances only the schema version; it never disables or deletes user data.
- Unknown subject kind — Rust deserialization fails closed; the frontend has no fallback strategy.

## Privacy and Security

- Inventory and delete inputs contain only IDs, adapter IDs, digests, counts, and update tokens. They must not expose config JSON, credentials, grants, package bytes, paths, or publisher keys.
- Package compatibility must come from installed signed-manifest metadata plus authorization state. The frontend must never select a package independently.
- Provider deletion must run dependency checks and deletion in one database transaction. Credential cleanup must use the existing journal and sanitized error path.
- Runtime release authority is backend-owned. Frontend inventory values are display data, not authorization to remove an executor.

## Rollout Notes

- Ship migration 0030 only as the registered no-op checkpoint.
- Bundle and authorize replacement packages before enabling the production creation policy for an integration slice.
- Release slices in the fixed order: Google Web, Edge TTS, Google Cloud.
- Do not add PaddleOCR to the production policy in this change.
- Do not add a provider adapter to the production retirement allowlist until a release record identifies the package version and the prior stable application release that carried it.
- Before removing bundled executor code in a later release, capture inventory evidence that the corresponding slice has zero enabled legacy rows and no blockers.

## Risks and Mitigations

- **Creation and execution gates are accidentally coupled again** — use separate types and constructor parameters; test active-row execution with creation already blocked.
- **Provider package ambiguity attaches the wrong runtime** — require exactly one authorized compatible default per adapter; ambiguity disables migration.
- **Safe delete checks drift from inventory checks** — treat the write seam as authoritative and fail closed even when stale inventory displayed Delete as available.
- **Default provider binding invariant is broken** — never delete a binding independently through the retirement panel; delete only an isolated provider after full dependency checks.
- **Production policy silently expands** — use ordered explicit constants and tests that reject PaddleOCR and keep the provider allowlist empty without release evidence.
- **Startup snapshot becomes stale after remediation** — executor removal remains a later release decision. The current release keeps bundled code present; a restart can recompute readiness before any future physical removal.

## Open Questions

- Which provider adapter, package version, and prior stable application release provide the evidence required to enable the first provider retirement slice? Until this is answered, the production provider adapter allowlist must remain empty.
