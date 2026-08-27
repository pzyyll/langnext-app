# Implementation Plan

**Goal:** Allow users to package, preview, install, activate, and execute unsigned Wasm Component and allowlisted trusted-native-worker plugins after explicit risk confirmation bound to the exact package digest.

**Inputs:** Mr. Julian's requirements from 2026-08-21; `docs/plans/runtime-plugin-system/README.md`; Phase 3 package lifecycle; Phase 4 runtime lifecycle; Phase 11.5 default package activation; current package, runtime, and install UI code.

**Assumptions:**

- Unsigned support changes package authenticity only. All archive bounds, path checks, manifest validation, file-index digests, archive SHA-256 checks, capability grants, broker limits, and runtime resource limits remain mandatory.
- Signature status is decided before publisher lookup. No `signatures/manifest.sig` entry means `unsigned`; a present but malformed or invalid signature is rejected and cannot fall back to unsigned handling.
- Unsigned approval is bound to the exact final archive digest. A byte change creates a different package and requires a new preview and confirmation.
- The current native plugin ID/version allowlist remains unchanged. This work does not permit arbitrary native plugin IDs or versions.
- Non-vendor native packages, whether user-signed or unsigned, require the same native execution-risk confirmation. Vendor bootstrap remains vendor-signed only.
- The existing `UNIQUE (plugin_id, version)` rule remains. If signed `com.langnext.paddleocr@1.0.0` occupies the slot, a different unsigned digest is rejected with `version_conflict`; the user must remove dependent bindings and uninstall the signed package first.
- Unsigned Wasm packages cannot claim these reserved first-party IDs: `com.langnext.google-translate-web`, `com.langnext.edge-tts`, `com.langnext.google-cloud`, `com.langnext.baidu-ocr`, `com.langnext.provider.openai-compatible`, `com.langnext.provider.openai-responses`, `com.langnext.provider.anthropic`, `com.langnext.provider.gemini`, `com.langnext.provider.deepseek`, or `com.langnext.paddleocr`. Existing behavior for valid user-signed packages remains unchanged. The allowlisted PaddleOCR native identity is the only first-party unsigned exception in this plan.
- Unsigned packages can become defaults only through the existing user-confirmed default activation workflow and a second unsigned-default acknowledgement. They cannot enter vendor bootstrap.
- Package installation approval remains distinct from instance execution grants. An unsigned risk acknowledgement makes the exact package admissible; it does not authorize an instance to execute it.
- Import/export does not transfer unsigned trust or risk acknowledgements.

**Architecture:** Split package validation into integrity validation and optional publisher-authenticity validation. Persist package signature status and exact-digest risk acknowledgements beside the installed package. Runtime and lifecycle services revalidate the retained archive according to its persisted signature status, require an unsigned approval for unsigned packages, then require the existing subject-scoped execution grant. Native execution keeps the current executable, dependency, model, handshake, Job Object, and module-audit checks.

**Tech Stack:** Rust 2024, SQLite/rusqlite, Ed25519, SHA-256, Tauri 2 IPC, React 19, Base UI, TanStack Query, Effect, Bun, mise.

---

## Product Rules

1. Signed packages continue to use the current publisher verification flow.
2. Missing signature produces an `unsigned` preview, not an install error.
3. Invalid or mismatched signatures remain hard failures.
4. Unsigned Wasm install requires an explicit unsigned-risk acknowledgement.
5. Non-vendor native install requires both unsigned/publisher handling and a separate native execution-risk acknowledgement.
6. Each acknowledgement is stored against the exact `package_digest` and a named warning-contract version: `UNSIGNED_PLUGIN_RISK_ACK_V1`, `NATIVE_PLUGIN_RISK_ACK_V1`, and `UNSIGNED_DEFAULT_RISK_ACK_V1`.
7. Runtime execution always requires the existing instance/provider execution grant in addition to package admissibility.
8. User-confirmed defaults may use unsigned packages after a second default-risk acknowledgement.
9. Vendor bootstrap, bundled package discovery, and vendor defaults remain signed-vendor-only.
10. The UI must never label unsigned or non-vendor native code as trusted or sandboxed.

## Out of Scope

- Removing Ed25519 support or publisher trust for signed packages.
- Allowing invalid signatures to downgrade to unsigned status.
- Expanding the trusted-native-worker plugin ID/version allowlist.
- Adding an OS sandbox for native workers.
- Automatically trusting unsigned updates by plugin ID, version, manifest publisher claim, or filename.
- Exporting package bytes, install approvals, risk acknowledgements, or execution grants.
- Changing Tauri command registration or ACL surfaces; the existing preview/approve/default commands remain the public IPC boundary.

## File Map

### Package format and domain

- Modify: `src-tauri/src/domain/plugin_package.rs` — add `PackageSignatureStatus`, optional installed publisher identity, unsigned/native risk fields, preview fields, and approval inputs.
- Modify: `src-tauri/src/domain/runtime_plugin.rs` — keep signature-path constants and manifest types aligned with optional signature envelopes.
- Modify: `src-tauri/src/services/runtime_plugin_contracts.rs` — allow the signature entry to be absent while preserving reserved-path and file-index rules.
- Modify: `src-tauri/src/services/plugin_package.rs` — split structural/integrity verification from optional signature verification; decide signature status before publisher lookup and preserve invalid-signature rejection.
- Modify: `src-tauri/src/bin/plugin_tool.rs` — add explicit unsigned finalization without weakening signed finalization.
- Modify: `.mise/tasks/plugin/finalize-package` — document and forward `--unsigned` mode.

### Persistence

- Create: `src-tauri/migrations/0031_unsigned_plugin_packages.sql` — persist signature status, nullable publisher identity, and exact-digest risk acknowledgements.
- Modify: `src-tauri/src/storage/migrations.rs` — register migration 0031 and migration coverage.
- Modify: `src-tauri/src/repositories/installed_plugin_versions.rs` — read/write signature status and optional publisher identity.
- Modify: `src-tauri/src/repositories/plugin_package_approvals.rs` — persist and query risk acknowledgement state by exact digest.
- Modify: `src-tauri/src/repositories/default_package_activation_policies.rs` — support nullable publisher identity and user-confirmed unsigned defaults while retaining signed vendor-bootstrap checks.

### Install and catalog services

- Modify: `src-tauri/src/services/plugin_store.rs` — preview, approve, install, recover, post-rename verify, list, uninstall, and vendor bootstrap behavior for signed/unsigned packages.
- Modify: `src-tauri/src/cmds/plugin_packages.rs` — command-level DTO coverage; no new command.
- Modify: `src-tauri/src/services/plugin_models.rs` — use installed package verification mode when reading package model resources.
- Modify: `src-tauri/src/services/service_integrations.rs` — make PaddleOCR readiness use installed package verification mode instead of vendor-root-only verification.

### Runtime and lifecycle

- Modify: `src-tauri/src/services/runtime_router.rs` — signed/unsigned Wasm and native resolution with exact-digest risk checks.
- Modify: `src-tauri/src/services/provider_runtime_router.rs` — provider runtime per-request revalidation for unsigned packages.
- Modify: `src-tauri/src/services/runtime_lifecycle.rs` — integration preview/apply/rollback checks for unsigned and non-vendor native targets.
- Modify: `src-tauri/src/services/runtime_providers.rs` — provider preview/apply/rollback checks for unsigned targets.
- Modify: `src-tauri/src/services/native_workers/mod.rs` — retain runtime/model locks, handshake, module audit, and process cleanup; add no signature bypass inside the worker manager.
- Modify: `src-tauri/src/services/default_package_activation/mod.rs` — carry signature/risk status through activation snapshots.
- Modify: `src-tauri/src/services/default_package_activation/policy_authorization.rs` — second acknowledgement for unsigned defaults.
- Modify: `src-tauri/src/services/default_package_activation/single_flight.rs` — verification-mode-aware shared snapshots.
- Modify: `src-tauri/src/services/default_package_activation/recovery.rs` — retry and recovery use installed-package verification mode without assuming publisher identity.
- Modify: `src-tauri/src/services/default_package_activation/vendor_bootstrap.rs` — explicitly reject unsigned bootstrap entries.
- Modify: `src-tauri/src/services/service_capabilities.rs` — profile invocation snapshots carry optional authenticated publisher identity and recheck unsigned pins through installed-package verification.

### Import/export and compatibility

- Modify: `src-tauri/src/services/import_export.rs` — preserve inactive exact runtime requirements without exporting unsigned trust.
- Modify: `src-tauri/src/services/import_validation.rs` — never reactivate imported unsigned requirements from imported metadata.

### Frontend

- Modify: `src/storage/types.ts` — mirror signature status, optional publisher identity, risk acknowledgement, and default-preview fields.
- Modify: `src/storage/client.ts` — typed DTO changes only; no new IPC command.
- Modify: `src/features/plugins/installPluginPackageFlow.ts` — forward explicit unsigned and native risk acknowledgements.
- Modify: `src/features/plugins/InstallPluginDialog.tsx` — show unsigned and native warnings with separate Base UI checkboxes.
- Modify: `src/features/plugins/pluginPackagePresentation.ts` — pure rules for publisher, signature, and native warning presentation.
- Modify: `src/features/plugins/InstalledPluginVersions.tsx` — show signed/unsigned and native-risk status without calling unsigned packages trusted.
- Modify: `src/features/plugins/DefaultPackageActivationDialog.tsx` — require the second unsigned-default acknowledgement.
- Modify: `src/features/plugins/useAcknowledgedPreviewDialog.ts` — support a separate unsigned-default acknowledgement without conflating it with authority acknowledgement.
- Modify: `src/features/plugins/defaultPackageActivationPresentation.ts` — map unsigned/default-risk states to short UI copy.
- Modify: `src/i18n/locales/en.ts` — English warnings and status copy.
- Modify: `src/i18n/locales/zh-CN.ts` — Chinese warnings and status copy.

### Tests and documentation

- Modify: `src-tauri/src/services/plugin_package.rs` tests — unsigned structure and invalid-signature behavior.
- Modify: `src-tauri/src/services/plugin_store.rs` tests — exact-digest installation approval, recovery, and vendor bootstrap denial.
- Modify: `src-tauri/src/services/runtime_lifecycle_installed_tests.rs` — unsigned Wasm lifecycle and rollback.
- Modify: `src-tauri/src/services/runtime_provider_tests.rs` — unsigned provider lifecycle and execution.
- Modify: `src-tauri/src/services/paddleocr_runtime_tests.rs` — non-vendor/unsigned native confirmation and execution.
- Modify: `src-tauri/src/services/default_package_activation/tests/mod.rs` — unsigned default confirmation and activation.
- Modify: `src-tauri/src/services/tests.rs` — import/export trust non-transfer.
- Modify: `src-tauri/src/storage/tests.rs` — migration and unchanged IPC/ACL coverage.
- Modify: `src/features/plugins/InstallPluginDialog.test.tsx` — warning and checkbox behavior.
- Modify: `src/features/plugins/installPluginPackageFlow.test.ts` — DTO forwarding.
- Modify: `src/features/plugins/pluginPackagePresentation.test.ts` — pure warning/status rules.
- Modify: `src/features/plugins/DefaultPackageActivationDialog.test.tsx` — second default confirmation.
- Modify: `src/features/plugins/defaultPackageActivationPresentation.test.ts` — unsigned default status copy.
- Modify: `docs/plans/runtime-plugin-system/README.md` — replace the signed-only invariant with the signed-or-explicit-exact-digest-approval rule.
- Modify: `docs/plans/runtime-plugin-system/phase-3-package-lifecycle.md` — document unsigned packaging/install semantics.
- Modify: `docs/analysis/runtime-plugin-architecture.md` — document authenticity vs integrity and native risk.
- Modify: `src-tauri/resources/plugins/README.md` — retain signed vendor bootstrap requirements.

## Seams

These seams must be confirmed before implementation starts.

- **Seam:** `finalize_package_from_staging`, new `finalize_unsigned_package_from_staging`, and the thin `plugin_tool finalize-package` CLI — create either a signature-verified package or an explicitly unsigned package; never convert an invalid signed package to unsigned.
- **Seam:** `Database::initialize` / `migrations::migrate` — migrates signed package state to schema 31 and supports unsigned rows without inventing publisher trust.
- **Seam:** `PluginPackageService::preview_package` / `approve_package` — decides signature status before publisher lookup and installs only after exact required acknowledgements.
- **Seam:** `preview_plugin_package` / `approve_plugin_package` IPC — preserves opaque preview/CAS behavior and rejects forged frontend acknowledgement combinations.
- **Seam:** `InstallPluginDialog` — presents unsigned and native risk before enabling install.
- **Seam:** `RuntimeRouter::resolve` and capability execution — revalidates exact stored unsigned packages and still requires execution grants.
- **Seam:** `ProviderRuntimeRouter` public models/chat execution — applies the same unsigned integrity rules without legacy replay.
- **Seam:** `RuntimeLifecycleService` and `ProviderRuntimeService` preview/apply/rollback — cannot pin an unsigned package without exact package admissibility.
- **Seam:** `DefaultPackageActivationService::preview_default_package_activation` / `authorize_default_plugin_package` — requires a second unsigned-default acknowledgement and binds the exact digest.
- **Seam:** `AppState` vendor bootstrap — imports and defaults only signed vendor packages.
- **Seam:** import/export preview/apply — preserves requirements but never transfers unsigned trust or activates code.
- **Seam:** `InstalledPluginVersions` — displays signature and native-risk status without representing unsigned content as trusted.

## Tasks

### Task 1: Define explicit unsigned package envelopes

**Seam:** `finalize_package_from_staging`, new `finalize_unsigned_package_from_staging`, and the thin `plugin_tool finalize-package` CLI

**Outcome:** The tool can produce a canonical unsigned `.lnplugin`, while signed finalization still requires a valid signature and public key.

**Files:**

- Modify: `src-tauri/src/domain/plugin_package.rs`
- Modify: `src-tauri/src/domain/runtime_plugin.rs`
- Modify: `src-tauri/src/services/runtime_plugin_contracts.rs`
- Modify: `src-tauri/src/services/plugin_package.rs`
- Modify: `src-tauri/src/bin/plugin_tool.rs`
- Modify: `.mise/tasks/plugin/finalize-package`
- Test: public finalizer/integrity tests in `src-tauri/src/services/plugin_package.rs`; keep `plugin_tool` as a thin CLI

**Steps:**

- [ ] **Red:** Add `unsigned_finalize_produces_integrity_valid_archive_without_signature` through the planned `finalize_unsigned_package_from_staging` public service API using a Wasm staging tree with no signature. The first red may be a compile failure because the named public API does not exist. Assert the final archive has a stable SHA-256, no signature entry, a valid manifest/file index, and no executable extraction before install.
- [ ] **Green:** Add `PackageSignatureStatus::{Signed, Unsigned}` and make parsed signature bytes optional. Update `validate_archive_shape` so only the explicit unsigned envelope may omit the signature entry. Add `finalize_unsigned_package_from_staging` and expose it through `plugin_tool finalize-package --unsigned` without a public-key argument.
- [ ] Reject `--unsigned` when staging already contains `signatures/manifest.sig`; do not strip or ignore a present signature. Task 3 owns signed/unsigned preview classification and the invalid-signature downgrade regression.
- [ ] Preserve all archive limits, path rules, indexed file hashes, Wasm artifact checks, and host target checks. Native authenticity/allowlist separation lands only in Task 7.
- [ ] Keep `plugin_tool verify` signed-only. The explicit unsigned finalizer and application preview are the supported unsigned inspection path; do not add a second CLI verification contract in this scope.

**Validation:**

- Run (red): `mise run test unsigned_finalize_produces_integrity_valid_archive_without_signature -- --nocapture`
- Expected: compilation fails because `finalize_unsigned_package_from_staging` does not exist.
- Run (green): same command.
- Expected: passes and emits a canonical unsigned archive.

### Task 2: Persist signature status and exact-digest risk acknowledgements

**Seam:** storage migration to version 31 through `Database::initialize` / `migrations::migrate`

**Outcome:** Existing signed rows migrate without identity changes; new unsigned rows can persist without a trusted publisher row; risk acknowledgement remains package-level and exact-digest-bound.

**Files:**

- Create: `src-tauri/migrations/0031_unsigned_plugin_packages.sql`
- Modify: `src-tauri/src/storage/migrations.rs`
- Modify: `src-tauri/src/domain/plugin_package.rs`
- Modify: `src-tauri/src/repositories/installed_plugin_versions.rs`
- Modify: `src-tauri/src/repositories/plugin_package_approvals.rs`
- Modify: `src-tauri/src/repositories/default_package_activation_policies.rs`
- Modify: `src-tauri/src/services/plugin_store.rs`
- Modify: `src-tauri/src/services/runtime_router.rs`
- Modify: `src-tauri/src/services/provider_runtime_router.rs`
- Modify: `src-tauri/src/services/runtime_lifecycle.rs`
- Modify: `src-tauri/src/services/runtime_providers.rs`
- Modify: `src-tauri/src/services/plugin_models.rs`
- Modify: `src-tauri/src/services/service_integrations.rs`
- Modify: `src-tauri/src/services/service_capabilities.rs`
- Modify: `src-tauri/src/services/default_package_activation/policy_authorization.rs`
- Modify: `src-tauri/src/services/default_package_activation/single_flight.rs`
- Modify: `src-tauri/src/services/default_package_activation/recovery.rs`
- Test: migration tests in `src-tauri/src/storage/tests.rs`

**Steps:**

- [ ] **Red:** Add `unsigned_package_migration_preserves_signed_rows_and_supports_nullable_publisher` from a v30 fixture.
- [ ] **Green:** In one migration, rebuild `installed_plugin_versions` so `publisher_key_id` and `publisher_fingerprint` are nullable, add `signature_status CHECK ('signed','unsigned')`, enforce signed ⇒ publisher non-null and unsigned ⇒ publisher null, and backfill existing rows as `signed`.
- [ ] **Green:** Rebuild `plugin_package_approvals` with nullable publisher identity, `PublisherDecision::UnsignedExactDigest`, `signature_status`, `unsigned_risk_acknowledged`, `native_execution_risk_acknowledged`, and `risk_acknowledgement_version`; retain the package-digest foreign key and backfill existing signed approvals.
- [ ] **Green:** Rebuild `default_package_activation_policies` in the same 0031 migration with nullable publisher identity plus `signature_status` and `unsigned_default_risk_acknowledgement_version`. Enforce unsigned policies as `policy_source = user_confirmed`; vendor bootstrap rows remain signed with publisher identity.
- [ ] Keep `package_digest` as the approval foreign key and uniqueness authority. Do not use plugin ID/version as approval authority.
- [ ] Add constants `UNSIGNED_PLUGIN_RISK_ACK_V1`, `NATIVE_PLUGIN_RISK_ACK_V1`, and `UNSIGNED_DEFAULT_RISK_ACK_V1`. A future constant change makes old acknowledgement rows ineligible.
- [ ] Update Rust repository/domain fields to use `Option<String>` for authenticated installed publisher identity and an enum for signature status. Add separate claimed publisher fields to sanitized preview/installed DTOs; never place unsigned manifest claims in authenticated publisher fields.
- [ ] Update every existing caller that assumes publisher strings are non-null. In Task 2, signed branches unwrap through one fail-closed helper; unsigned branches return a stable `unsigned_package_not_enabled` error until their vertical behavior lands in Tasks 3, 5-9. This keeps each Task 2 green build complete without prematurely opening execution.
- [ ] Update profile invocation/runtime pin snapshots to carry signature status and optional authenticated publisher identity. Do not treat `manifest_json` claims as publisher authority.
- [ ] Update every hard-coded latest-version assertion in `src-tauri/src/storage/tests.rs` from 30 to 31.

**Validation:**

- Run (red): `mise run test unsigned_package_migration_preserves_signed_rows_and_supports_nullable_publisher -- --nocapture`
- Expected: fails because schema version 30 requires publisher foreign keys and has no signature status.
- Run (green): same command.
- Expected: passes; `latest_version()` is 31 and existing signed identities are unchanged.

### Task 3: Install unsigned Wasm packages with exact acknowledgement

**Seam:** `PluginPackageService::preview_package` / `approve_package`

**Outcome:** An unsigned Wasm package can be previewed and installed only after backend-validated unsigned and permission acknowledgements.

**Files:**

- Modify: `src-tauri/src/domain/plugin_package.rs`
- Modify: `src-tauri/src/services/plugin_store.rs`
- Modify: `src-tauri/src/repositories/plugin_package_approvals.rs`
- Modify: `src-tauri/src/cmds/plugin_packages.rs`
- Test: service and command tests in the same Rust files

**Steps:**

- [ ] **Red:** Add `unsigned_wasm_preview_reports_unverified_publisher_and_exact_digest_risk` through `preview_package`. Table-test a missing signature on a manifest that still claims the configured vendor key and a present invalid signature. Assert the missing-signature archive reports `signatureStatus = unsigned`, publisher claims are display-only, `publisherTrust = unsigned`, `requiresPublisherApproval = false`, and requires unsigned-risk acknowledgement; assert the present invalid signature returns `signature_invalid` and never produces a preview.
- [ ] **Green:** Decide signature presence before any publisher lookup. Extend `PublisherTrustState` with `Unsigned`, then extend preview/session DTOs with signature status and risk requirements. Do not resolve or insert a publisher row for unsigned packages, regardless of manifest publisher claims.
- [ ] **Red:** Add `unsigned_wasm_approve_requires_backend_risk_acknowledgement`. Table-test missing permission acknowledgement, missing unsigned acknowledgement, stale preview, digest drift, and successful exact-digest install.
- [ ] **Green:** Extend `ApprovePluginPackageInput` with `acknowledge_unsigned_package_risk` and `acknowledge_native_execution_risk`. Persist `PublisherDecision::UnsignedExactDigest` with null publisher identity only after re-hashing and re-running integrity validation on the staged archive.
- [ ] **Red:** Add `signed_install_behavior_remains_signature_and_publisher_bound` for trusted, unknown, revoked, disabled, and invalid-signature publishers.
- [ ] **Green:** Keep the existing signed publisher path unchanged except for shared integrity helpers.
- [ ] Make post-rename verification select signed or unsigned verification from persisted signature status and require the exact-digest approval before setting `content_available = true`.
- [ ] Preserve `UNIQUE (plugin_id, version)`: a different unsigned digest for an installed signed version returns `version_conflict`; no replacement or coexistence occurs.
- [ ] Add a closed `RESERVED_FIRST_PARTY_WASM_PLUGIN_IDS` set containing the nine IDs listed in Assumptions. Apply it only when `signature_status = unsigned` and `runtime.kind = wasm-component`. Add table tests for every ID, including rejection of unsigned Wasm using the PaddleOCR ID, plus one synthetic third-party ID that remains installable unsigned. Preserve current valid user-signed behavior. Task 7 separately permits only allowlisted PaddleOCR when `runtime.kind = trusted-native-worker`.
- [ ] Define extra acknowledgement handling: irrelevant `true` flags are rejected as invalid input rather than silently recorded.

**Validation:**

- Run (red): `mise run test unsigned_wasm_approve_requires_backend_risk_acknowledgement -- --nocapture`
- Expected: fails because preview rejects a missing signature.
- Run (green): same command.
- Expected: passes; no publisher row is created and the approval is bound to the installed digest.
- Run: `mise run test signed_install_behavior_remains_signature_and_publisher_bound -- --nocapture`
- Expected: all existing signed trust behavior remains green.

### Task 4: Present unsigned and native install risk in the UI

**Seam:** `InstallPluginDialog`

**Outcome:** The install action remains disabled until the user acknowledges permissions, unsigned authenticity risk, and non-vendor native execution risk as applicable.

**Files:**

- Modify: `src/storage/types.ts`
- Modify: `src/features/plugins/installPluginPackageFlow.ts`
- Modify: `src/features/plugins/InstallPluginDialog.tsx`
- Modify: `src/features/plugins/pluginPackagePresentation.ts`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh-CN.ts`
- Test: `src/features/plugins/InstallPluginDialog.test.tsx`
- Test: `src/features/plugins/installPluginPackageFlow.test.ts`
- Test: `src/features/plugins/pluginPackagePresentation.test.ts`

**Steps:**

- [ ] **Red:** Add `unsigned_wasm_install_requires_visible_exact_digest_warning` and assert the dialog displays “publisher identity is not verified,” displays the exact digest, and requires a separate checkbox.
- [ ] **Green:** Add signature presentation helpers and a Base UI checkbox for unsigned risk. Hide publisher approval/key entry for unsigned packages and label manifest publisher claims as unverified metadata.
- [ ] **Red:** Add `non_vendor_native_install_requires_system_code_warning`. Assert the dialog states that process isolation is not a permission sandbox and requires a second native checkbox.
- [ ] **Green:** Add the native warning panel and acknowledgement. Keep concise English and Chinese copy.
- [ ] **Red:** Extend flow tests to assert both acknowledgement booleans are forwarded exactly and never inferred from visibility.
- [ ] **Green:** Update typed Effect input forwarding.

**Validation:**

- Run (red): `bun test src/features/plugins/InstallPluginDialog.test.tsx`
- Expected: new unsigned/native scenarios fail because the DTO and checkboxes do not exist.
- Run (green): same command.
- Expected: install enables only for the exact applicable acknowledgement combination.
- Run: `bun test src/features/plugins/installPluginPackageFlow.test.ts src/features/plugins/pluginPackagePresentation.test.ts`
- Expected: typed forwarding and pure presentation rules pass.

### Task 5: Execute unsigned Wasm packages without weakening grants

**Seam:** `RuntimeRouter::resolve` and public capability execution

**Outcome:** An installed unsigned Wasm package executes from the exact verified archive snapshot only when its exact-digest install acknowledgement and subject execution grant both exist.

**Files:**

- Modify: `src-tauri/src/services/plugin_store.rs`
- Modify: `src-tauri/src/services/runtime_router.rs`
- Modify: `src-tauri/src/services/service_capabilities.rs`
- Modify: `src-tauri/src/services/runtime_lifecycle_installed_tests.rs`
- Test: `src-tauri/src/services/runtime_router.rs` tests

**Steps:**

- [ ] **Red:** Add `unsigned_wasm_execution_requires_package_ack_and_subject_grant` through both direct `RuntimeRouter::resolve` and the production profile invocation snapshot → `recheck_pin_matches` → `resolve_wasm_from_snapshot` path. Table-test no package acknowledgement, no execution grant, wrong digest, replaced archive, changed extracted content, valid execution, trap, and cancellation.
- [ ] **Green:** Introduce `PluginPackageService::verify_installed_package_snapshot(package_digest)`. It loads persisted signature status, uses the existing signed verifier for signed packages, and uses integrity plus exact-digest risk approval for unsigned packages. Do not widen the signed-only `verify_runtime_store_snapshot` or vendor-root APIs. Then run the existing grant checks unchanged.
- [ ] Ensure Wasm bytes come from the verified archive snapshot, not untrusted extracted files or `manifest_json`.
- [ ] Preserve no-legacy-replay behavior after unsigned runtime failure.
- [ ] Keep reserved first-party Wasm authority checks active when publisher identity is null; unsigned content cannot bypass vendor-only package IDs.

**Validation:**

- Run (red): `mise run test unsigned_wasm_execution_requires_package_ack_and_subject_grant -- --nocapture`
- Expected: fails because runtime verification requires a publisher signature.
- Run (green): same command.
- Expected: valid unsigned execution passes; every missing or drifted authority fails before guest execution.

### Task 6: Support unsigned provider runtimes across models and chat

**Seam:** `ProviderRuntimeRouter` public models/chat execution and `ProviderRuntimeService` lifecycle

**Outcome:** Unsigned provider packages support models, unary chat, stream, cancellation, upgrade, and rollback with the same exact-digest and execution-grant rules.

**Files:**

- Modify: `src-tauri/src/services/provider_runtime_router.rs`
- Modify: `src-tauri/src/services/runtime_providers.rs`
- Modify: `src-tauri/src/services/runtime_provider_tests.rs`

**Steps:**

- [ ] **Red:** Add `unsigned_provider_runtime_models_chat_stream_and_cancel_require_exact_authority` through public provider runtime commands/router.
- [ ] **Green:** Reuse the package verification-mode service from Task 5. Do not duplicate unsigned verification in frontend code.
- [ ] **Red:** Add `unsigned_provider_upgrade_and_rollback_recheck_package_admissibility` for preview/apply/rollback, stale CAS, archive replacement, and unavailable content.
- [ ] **Green:** Carry signature status through lifecycle snapshots and recheck immediately before binding/grant mutation.
- [ ] Preserve model UUIDs, provider UUIDs, complete-snapshot sync, cancellation, and no same-request legacy replay.

**Validation:**

- Run (red): `mise run test unsigned_provider_runtime_models_chat_stream_and_cancel_require_exact_authority -- --nocapture`
- Expected: fails at signed publisher verification.
- Run (green): same command.
- Expected: all runtime operations pass only for the exact acknowledged digest and grant.
- Run: `mise run test unsigned_provider_upgrade_and_rollback_recheck_package_admissibility -- --nocapture`
- Expected: lifecycle behavior passes and stale/tampered states fail closed.

### Task 7: Permit allowlisted non-vendor native workers with a stronger acknowledgement

**Seam:** `RuntimeLifecycleService` plus `RuntimeRouter::resolve_native`

**Outcome:** The existing allowlisted native plugin/version can install and execute without a vendor signature after explicit native-risk confirmation; all native integrity and process controls remain active.

**Files:**

- Modify: `src-tauri/src/services/plugin_package.rs`
- Modify: `src-tauri/src/services/plugin_store.rs`
- Modify: `src-tauri/src/services/runtime_lifecycle.rs`
- Modify: `src-tauri/src/services/runtime_router.rs`
- Modify: `src-tauri/src/services/native_workers/mod.rs`
- Modify: `src-tauri/src/services/plugin_models.rs`
- Modify: `src-tauri/src/services/service_integrations.rs`
- Modify: `src-tauri/src/services/paddleocr_runtime_tests.rs`
- Modify: `src-tauri/src/services/paddleocr_package_tests.rs`

**Steps:**

- [ ] **Red:** Add `non_vendor_native_install_requires_native_risk_ack_and_allowlist`. Table-test unsigned allowlisted package, user-signed allowlisted package, missing native acknowledgement, wrong plugin ID, wrong version, prohibited payload, and missing model resources.
- [ ] **Green:** Split native validation into host allowlist/payload validation and authenticity policy. Vendor-signed native follows vendor verification and does not require the non-vendor native acknowledgement; non-vendor signed or unsigned native follows exact-digest/native-risk approval.
- [ ] **Red:** Add `unsigned_paddleocr_conflicts_with_installed_signed_same_version`. Assert preview returns `version_conflict`, bootstrap skips the occupied slot without replacing it, and the user must remove bindings/defaults and uninstall first.
- [ ] **Green:** Keep the existing `(plugin_id, version)` uniqueness and uninstall dependency checks. Do not add replacement or coexistence behavior.
- [ ] **Red:** Add `unsigned_paddleocr_model_resolution_and_health_readiness_use_integrity_mode` through public `PluginModelService::list_for_instance` and `ServiceIntegrationService::validate_instance`. Assert model resolution succeeds and the integration leaves Degraded only for the exact acknowledged digest.
- [ ] **Green:** Update `plugin_models` model resolution and `service_integrations` PaddleOCR readiness to use installed-package verification mode instead of `require_native_worker_vendor_publisher` / `verify_store_with_vendor_root`.
- [ ] **Red:** Add `unsigned_native_execution_retains_runtime_model_handshake_and_module_audit`. Tamper each of archive, worker, DLL, model, runtime-set digest, model-set digest, process nonce, and loaded module set.
- [ ] **Green:** Select installed-package verification before the existing native lock/spawn/handshake path. Do not bypass Job Object/process-tree cleanup or module audit.
- [ ] Update comments and UI copy so `trusted-native-worker` is a runtime class, not a claim that unsigned code is trusted or sandboxed.

**Validation:**

- Run (red): `mise run test non_vendor_native_install_requires_native_risk_ack_and_allowlist -- --nocapture`
- Expected: fails because native packages currently require the configured vendor publisher.
- Run (green): same command.
- Expected: only allowlisted, acknowledged, integrity-valid packages install.
- Run: `mise run test unsigned_paddleocr_model_resolution_and_health_readiness_use_integrity_mode -- --nocapture`
- Expected: model resolution and production health readiness pass without vendor-root-only assumptions.
- Run: `mise run test unsigned_native_execution_retains_runtime_model_handshake_and_module_audit -- --nocapture`
- Expected: valid execution passes and each tamper scenario fails before or during the existing fail-closed native boundary.

### Task 8: Recheck unsigned admissibility during integration lifecycle

**Seam:** `RuntimeLifecycleService` preview/apply/rollback

**Outcome:** Integration upgrades and rollbacks can target acknowledged unsigned packages but cannot pin stale, replaced, or unacknowledged package content.

**Files:**

- Modify: `src-tauri/src/services/runtime_lifecycle.rs`
- Modify: `src-tauri/src/services/runtime_lifecycle_installed_tests.rs`
- Modify: `src-tauri/src/services/plugin_store.rs`

**Steps:**

- [ ] **Red:** Add `unsigned_integration_upgrade_apply_and_rollback_revalidate_exact_digest`. Cover preview, permission expansion, acknowledgement lookup, CAS drift, final pre-commit recheck, rollback, and content loss.
- [ ] **Green:** Replace publisher-only lifecycle snapshot inputs with installed-package verification mode plus optional signed publisher identity.
- [ ] Keep permission expansion acknowledgement and instance grant creation separate from unsigned install acknowledgement.
- [ ] Ensure rollback to an unsigned snapshot still requires that exact package to remain installed, admissible, and content-valid.

**Validation:**

- Run (red): `mise run test unsigned_integration_upgrade_apply_and_rollback_revalidate_exact_digest -- --nocapture`
- Expected: fails because lifecycle requires a publisher row/signature.
- Run (green): same command.
- Expected: valid transitions pass; stale or tampered states change nothing.

### Task 9: Allow user-confirmed unsigned defaults

**Seam:** `DefaultPackageActivationService::preview_default_package_activation` / `authorize_default_plugin_package`

**Outcome:** A user can set an unsigned package as the default only after a second explicit acknowledgement bound to the previewed digest and authority constraints.

**Files:**

- Modify: `src-tauri/src/domain/default_package_activation.rs`
- Modify: `src-tauri/src/repositories/default_package_activation_policies.rs`
- Modify: `src-tauri/src/services/default_package_activation/mod.rs`
- Modify: `src-tauri/src/services/default_package_activation/policy_authorization.rs`
- Modify: `src-tauri/src/services/default_package_activation/single_flight.rs`
- Modify: `src-tauri/src/services/default_package_activation/recovery.rs`
- Modify: `src/features/plugins/DefaultPackageActivationDialog.tsx`
- Modify: `src/features/plugins/useAcknowledgedPreviewDialog.ts`
- Modify: `src/features/plugins/defaultPackageActivationPresentation.ts`
- Modify: `src/storage/types.ts`
- Test: corresponding Rust and frontend default activation tests

**Steps:**

- [ ] **Red:** Add `unsigned_default_requires_second_exact_digest_acknowledgement`. Assert install acknowledgement alone is insufficient; default preview exposes unsigned status; missing default-risk acknowledgement changes nothing.
- [ ] **Green:** Add signature status and optional publisher identity to default preview/session/policy. Add `acknowledge_unsigned_default_risk` to authorization input and bind it to the opaque preview session. For unsigned policies, authorization status compares exact default digest, `signature_status`, install-risk acknowledgement version, permission digest, and authority digest without looking up a publisher row. Signed policies keep publisher lookup and signature verification.
- [ ] **Red:** Add `unsigned_default_package_first_create_and_activation_reverify_integrity`. Cover new integration/provider creation, single-flight verification, dynamic-origin authority confirmation, retry, and archive/content tamper.
- [ ] **Green:** Make shared activation snapshots, retries, and startup recovery use installed-package verification mode and exact risk approval. Preserve authority ceilings, permission digests, CAS, and subject execution grants.
- [ ] **Red:** Add frontend test that the default action remains disabled until future-instance authority and unsigned-default risk are both acknowledged.
- [ ] **Green:** Extend `useAcknowledgedPreviewDialog` to track authority acknowledgement and unsigned-default acknowledgement separately; `confirmDisabled` remains true until every required acknowledgement is present. Add concise warning copy and checkbox.

**Validation:**

- Run (red): `mise run test unsigned_default_requires_second_exact_digest_acknowledgement -- --nocapture`
- Expected: fails because default authorization requires a publisher row and has no unsigned acknowledgement.
- Run (green): same command.
- Expected: unsigned default is exact-digest-bound and missing acknowledgement is fail-closed.
- Run: `bun test src/features/plugins/DefaultPackageActivationDialog.test.tsx src/features/plugins/defaultPackageActivationPresentation.test.ts`
- Expected: second-confirmation UI and presentation pass.

### Task 10: Keep vendor bootstrap signed-only

**Seam:** `AppState` vendor package bootstrap and `apply_vendor_bootstrap_policies`

**Outcome:** Bundled vendor resources cannot use unsigned packages even though manual user installation can.

**Files:**

- Modify: `src-tauri/src/services/plugin_store.rs`
- Modify: `src-tauri/src/services/default_package_activation/vendor_bootstrap.rs`
- Test: `src-tauri/src/state.rs` bootstrap wiring tests
- Modify: `src-tauri/src/services/google_translate_web_runtime_tests.rs`
- Modify: `src-tauri/src/services/default_package_activation/tests/mod.rs`

**Steps:**

- [ ] **Red:** Add `vendor_bootstrap_rejects_unsigned_exact_digest_package`. Cover bundled archive discovery, install/catalog mutation, set-default, and bootstrap activation policy; assert no unsigned catalog/store row is created.
- [ ] **Green:** In `bootstrap_bundled_package`, inspect signature presence and complete external vendor-root verification before calling the public preview/approve path or mutating DB/store state. Require `signature_status = signed` plus `PublisherSource::Vendor` in every later bootstrap/default recheck.
- [ ] **Red:** Add `manual_unsigned_package_cannot_satisfy_vendor_bootstrap_same_id_version`. Use the same plugin ID/version with a different unsigned digest and assert bootstrap skips the occupied unique slot without replacement or partial import.
- [ ] **Green:** Preserve exact digest/vendor identity reverse binding, never resolve bootstrap by plugin ID/version alone, and never replace an occupied different digest.

**Validation:**

- Run (red): `mise run test vendor_bootstrap_rejects_unsigned_exact_digest_package -- --nocapture`
- Expected: fails if shared unsigned verification accidentally opens bootstrap.
- Run (green): same command.
- Expected: bootstrap rejects unsigned content while manual installation tests remain green.

### Task 11: Preserve local-only trust across recovery and import/export

**Seam:** install recovery and import/export preview/apply

**Outcome:** Crash recovery preserves exact unsigned installation state, while configuration export/import never transfers unsigned approvals or activates code.

**Files:**

- Modify: `src-tauri/src/services/plugin_store.rs`
- Modify: `src-tauri/src/services/import_export.rs`
- Modify: `src-tauri/src/services/import_validation.rs`
- Modify: `src-tauri/src/services/tests.rs`
- Modify: `src-tauri/src/services/plugin_store.rs` tests

**Steps:**

- [ ] **Red:** Add `unsigned_install_recovery_revalidates_status_digest_and_acknowledgement` for crashes before DB commit, before rename, after rename, and before final availability.
- [ ] **Green:** Persist enough journal/catalog state to select unsigned integrity verification during recovery; quarantine mismatches and never infer acknowledgement.
- [ ] **Red:** Add `runtime_import_does_not_restore_unsigned_install_or_execution_trust`. Export an active unsigned Wasm and native requirement, import into a clean database, and assert no package bytes, package approval, default policy, or execution grant is restored.
- [ ] **Green:** Keep imported requirements inactive/unavailable until a local exact package is installed, acknowledged, and explicitly activated.
- [ ] Confirm older v2-v8 fixtures remain readable without adding trust defaults.

**Validation:**

- Run (red): `mise run test unsigned_install_recovery_revalidates_status_digest_and_acknowledgement -- --nocapture`
- Expected: fails because recovery assumes signature verification.
- Run (green): same command.
- Expected: valid recovery finalizes; missing acknowledgement or drift quarantines content.
- Run: `mise run test runtime_import_does_not_restore_unsigned_install_or_execution_trust -- --nocapture`
- Expected: import preserves identity requirements only and executes nothing.

### Task 12: Present installed status and update architecture documentation

**Seam:** `InstalledPluginVersions` and public documentation

**Outcome:** Users can distinguish signed vendor, signed user, unsigned Wasm, and non-vendor native packages after installation; documentation states the new trust model without weakening vendor release rules.

**Files:**

- Modify: `src/features/plugins/InstalledPluginVersions.tsx`
- Modify: `src/features/plugins/pluginPackagePresentation.ts`
- Modify: `src/storage/types.ts`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh-CN.ts`
- Modify: `src/features/plugins/pluginPackagePresentation.test.ts`
- Modify: `docs/plans/runtime-plugin-system/README.md`
- Modify: `docs/plans/runtime-plugin-system/phase-3-package-lifecycle.md`
- Modify: `docs/analysis/runtime-plugin-architecture.md`
- Modify: `src-tauri/resources/plugins/README.md`

**Steps:**

- [ ] **Red:** Add presentation cases for all signature/runtime combinations. Assert unsigned never maps to trusted publisher copy and native always states its process-level risk when non-vendor.
- [ ] **Green:** Add status badges and short descriptions without exposing raw archive paths or package bytes.
- [ ] Update the architecture decisions: signed packages authenticate publishers; unsigned packages rely on exact-digest user acceptance plus existing grants; native workers remain unsandboxed.
- [ ] Keep release documentation explicit that first-party bundled packages must remain vendor-signed and cannot use manual unsigned approval.

**Validation:**

- Run (red): `bun test src/features/plugins/pluginPackagePresentation.test.ts`
- Expected: unsigned/native status cases fail.
- Run (green): same command.
- Expected: every trust state has unambiguous copy.

## Final Validation

Run targeted package and lifecycle suites first:

```bash
mise run test services::plugin_package -- --nocapture
mise run test services::plugin_store -- --nocapture
mise run test runtime_lifecycle -- --nocapture
mise run test runtime_provider -- --nocapture
mise run test default_package_activation -- --nocapture
mise run test paddleocr_runtime -- --nocapture
mise run test runtime_plugin_import -- --nocapture
bun test src/features/plugins
```

Expected: signed behavior remains green; unsigned Wasm/native behavior requires exact acknowledgements; invalid signatures, digest drift, missing grants, and vendor-bootstrap unsigned packages fail closed.

Run project validation:

```bash
mise run plugin:conformance all
mise run test
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run build
mise run tauri:build
```

Expected: all suites pass; the packaged application contains only signed vendor bootstrap packages; manually selected unsigned packages can be installed only through the explicit warning flow.

Manual smoke validation:

1. Build an unsigned Wasm package with `plugin:finalize-package -- --unsigned`.
2. Preview it and verify the UI shows the exact digest and unsigned warning.
3. Confirm install; activate one instance; execute one successful request.
4. Change one archive byte and verify installation/execution fails under the new digest or digest mismatch.
5. Build the allowlisted native worker as unsigned.
6. Verify the separate process-permission warning appears and execution requires both acknowledgements.
7. Set each package as a user-confirmed default and verify the second unsigned-default confirmation.
8. Restart the app and confirm state remains exact-digest-bound.
9. Confirm bundled vendor bootstrap rejects an unsigned archive.

## Failure Behavior

- Missing signature — preview as unsigned; require exact-digest risk acknowledgement.
- Present invalid signature — reject with `signature_invalid`; do not offer unsigned fallback.
- Missing unsigned acknowledgement — reject install in Rust before DB/store mutation.
- Missing native acknowledgement — reject non-vendor native install in Rust before DB/store mutation.
- Digest drift between preview and approval — quarantine staging and fail with `digest_mismatch`.
- Archive/content drift after installation — mark unavailable or deny execution; never run extracted bytes.
- Missing package approval for unsigned content — deny runtime before grant lookup/guest start.
- Missing execution grant — deny runtime even when the package is acknowledged.
- Unknown/revoked/disabled signed publisher — preserve current signed-package failure behavior.
- Unsigned vendor bootstrap archive — reject and leave no default policy.
- Imported unsigned runtime requirement — retain inactive identity only; require local install and confirmation.
- Native allowlist or module-audit failure — terminate/refuse the worker and preserve instance state.

## Privacy and Security

- Unsigned approval does not establish publisher identity. Manifest publisher fields are untrusted display metadata only.
- The UI and logs must not call unsigned packages trusted, verified, official, or vendor-authenticated.
- The install preview shows the exact archive digest that the acknowledgement covers.
- Private keys, publisher public-key input, package bytes, credentials, prompts, images, audio, and provider bodies remain outside logs and sanitized DTOs as currently required.
- Wasm guests still receive no ambient WASI filesystem, sockets, process, environment, or inherited stdio.
- Native workers are not permission sandboxes. They can use the OS permissions of the spawned process. The warning must state this explicitly.
- Native runtime files, dependencies, model files, handshake digests, process nonce, loaded modules, timeout, cancellation, and process-tree cleanup remain mandatory.
- Package approval never substitutes for an instance/provider execution grant.
- Vendor bootstrap continues to use external vendor roots and exact Ed25519 verification.

## Rollout Notes

- Ship the schema migration before exposing unsigned installation in the frontend.
- Do not include unsigned packages in `src-tauri/resources/plugins/`.
- Keep `src-tauri/resources/vendor-trust/public-keys.json` and production signing procedures unchanged.
- Existing signed installed rows migrate to `signature_status = signed` with no user-visible prompt.
- Existing execution grants remain valid only for their exact signed package digests.
- Add release notes that unsigned and non-vendor native installation is an advanced-user action.
- Consider a feature flag only if product rollout needs staged exposure; do not add one by default.

## Risks and Mitigations

- **Unsigned native code can compromise user data.** — Retain the native allowlist, require a separate explicit warning, bind approval to exact digest, and preserve all process/module audits.
- **Signature stripping could be used as a downgrade.** — Treat only a missing signature as unsigned and require a new digest-bound confirmation; reject any present invalid signature.
- **Unsigned approval could become an execution grant.** — Keep package approvals and execution grant tables/queries separate; require both at runtime.
- **Publisher claims could be mistaken for authenticity.** — Make installed publisher identity optional and label unsigned claims as unverified metadata.
- **Shared verification helpers could open vendor bootstrap.** — Keep a dedicated vendor-root verification API and add explicit negative bootstrap tests.
- **Recovery could finalize unacknowledged content.** — Persist signature/risk status before finalization and revalidate it during every recovery branch.
- **Defaults could silently spread unsigned code to future instances.** — Require a second default-risk acknowledgement and exact-digest policy.
- **Import could transfer trust.** — Export no approvals/grants and restore unsigned requirements inactive.
- **Same plugin/version could hide changed content.** — Preserve the existing unique plugin/version conflict and exact digest checks.

## Decisions

- The app is unpublished and package-only: no legacy Bundled Rust, legacy frontend provider, or direct Baidu REST executor exists, and no dual-stack release or retirement evidence is required. This plan's unsigned install path is additive to the signed package world only.
- The listed public seams were confirmed during implementation, as required by the project's TDD workflow.
- The native allowlist remains fixed; non-vendor signed native packages use the same native-risk path as unsigned native packages; a different PaddleOCR digest at the same ID/version is rejected until the installed package and its dependencies are removed.
