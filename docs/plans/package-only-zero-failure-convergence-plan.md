# Implementation Plan

**Goal:** Finish the unpublished package-only migration so every supported path uses exact package identity, every unsupported legacy path fails closed, and all tests, builds, conformance checks, format checks, and compiler warning gates pass with zero warnings.

**Inputs:** The package-only failure review supplied by Mr. Julian, the current `package-only-migration` worktree, `AGENTS.md`, the `writing-plans` skill, and the current repository tasks and source files inspected for this plan.

**Assumptions:**

- The application is unpublished. No user database or export compatibility is required for format versions 2–7, Bundled Rust, legacy frontend providers, or direct Baidu OCR rows.
- Configuration export format v8 is the only accepted frontend and backend format.
- `wasm-component` and `trusted-native-worker` remain the only integration runtime kinds. Provider runtime bindings remain `wasm-component` only.
- Baidu OCR remains supported only as the signed `com.langnext.baidu-ocr` package. The host-owned Baidu auth policy, token exchanger, network policy, guest, conformance tests, and production package resources stay in scope.
- Signed and unsigned package support remains as currently designed. This plan does not weaken exact archive digest, signature status, publisher identity, grant, or trust checks.
- The current production public root and signed package resources are intentional release assets. Tests can use only `test_vendor_fixture` material.
- The current review did not include executable test output or Git index state. The implementation must capture the exact baseline before the first edit. Any failure outside the mapped groups is a blocker that requires a plan amendment, not an ad hoc relaxation.
- Provider-wide runtime upgrade/rollback IPC is removable only if the caller inventory proves there is no non-test frontend or external consumer. If it is an intentional public compatibility API, Mr. Julian must decide to retain it; the implementation must not guess.

**Architecture:** Keep the package verifier, content-addressed store, runtime routers, broker, Wasm/native worker execution, and fail-closed import validation as the security core. Converge schema, DTOs, fixtures, commands, and documentation around exact package identity. Apply changes as vertical slices at public seams: migration, v8 parse/preview/apply, package lifecycle, runtime conformance, activation CAS, IPC registration, and release verification.

**Tech Stack:** Rust 1.96.1, SQLite/rusqlite, Tauri 2, React 19, TypeScript 7, Bun test, Effect 3, Wasmtime 47.0.2, mise file tasks, ESLint, oxlint, oxfmt, rustfmt.

---

## Scope Boundaries

### In scope

- v8-only import/export behavior in Rust and TypeScript.
- Canonical package-only SQLite schema and migration tests for a fresh unpublished database.
- Real signed package fixtures and shared package identity helpers.
- Import, lifecycle, repository, conformance, and frontend fixture migration.
- Removal of obsolete v2–v7, Bundled Rust, legacy frontend provider, and direct Baidu row tests only where those behaviors are explicitly unsupported.
- Removal of orphan command source and confirmed dead IPC surface.
- First-party package identity ownership.
- Vendor trust and release resource documentation corrections.
- Reproducible activation concurrency repair without sleeps or retry inflation.
- Zero Rust compiler warnings, frontend build warnings, format errors, and whitespace errors.

### Out of scope

- Restoring any legacy executor or import normalizer.
- Importing v2–v7 documents.
- Migrating existing published user databases or preserving migration version numbers for released binaries.
- Direct Baidu OCR rows or credentials in `ocr_services`.
- Adding private signing material, changing the production public key, or replacing signed release packages.
- Weakening digest, signature, publisher, capability/artifact, grant, endpoint, WASI, or path confinement checks.
- Unrelated UI or architecture cleanup.

## File Map

### Create

- `src-tauri/src/domain/first_party_plugins.rs` — canonical first-party package IDs and membership checks. Start with two `ABOUTME` lines.
- `.mise/tasks/package-only/check` — fail-closed production source and migration/schema convergence gates. Start with the repository-standard shebang and two `ABOUTME` lines.

### Modify: package-only contract and fixtures

- `src-tauri/src/domain/mod.rs` — register the first-party identity module.
- `src-tauri/src/domain/import_export.rs` — retain v8-only parsing; rename v7-era helpers/messages; keep explicit rejection coverage.
- `src-tauri/src/domain/runtime_lifecycle.rs` — rename v7-era export comments/types where wire compatibility does not require the old name; keep only package runtime parsing.
- `src-tauri/src/domain/runtime_provider.rs` — remove provider-wide lifecycle DTOs if the dead-IPC gate passes; remove stale legacy comments while keeping adapter alias contract fields that remain in the signed manifest.
- `src-tauri/src/domain/service_integration.rs` — re-export first-party service package IDs from the canonical owner; retain package Baidu constants and auth policy data.
- `src-tauri/src/services/test_support.rs` — add shared helpers that return verified installed package identity and construct complete integration/provider v8 requirements.
- `src-tauri/src/services/import_validation.rs` — replace placeholder identity fixtures; remove direct-Baidu credential bookkeeping from the import plan and preview.
- `src-tauri/src/services/import_export.rs` — use current-format names, real package-backed test data, and no direct-Baidu credential recovery path.
- `src-tauri/src/services/tests.rs` — remove v2–v7 normalization acceptance; migrate v8 round-trip, preview, apply, CAS, and inactive-import tests to real installed package fixtures.
- `src-tauri/src/services/runtime_lifecycle_installed_tests.rs` — migrate supported lifecycle tests to real package identity; remove only v7/legacy restoration scenarios.
- `src-tauri/src/services/runtime_lifecycle_preference_tests.rs` — use shared installed package helpers and retain exact snapshot/CAS behavior.
- `src-tauri/src/services/runtime_provider_tests.rs` — use shared package helpers; move provider lifecycle conformance to adapter/interface seams if provider-wide lifecycle is removed.
- `src-tauri/src/repositories/tests.rs` — replace legacy pin/backfill fixtures with package-only pin/grant fixtures; keep repository constraints and approval-is-not-execution coverage.
- `src-tauri/src/storage/migrations.rs` — register only the canonical unpublished migration sequence and update latest-schema tests.
- `src-tauri/src/storage/tests.rs` — keep AppManifest/ACL equality and storage startup tests aligned with removed commands and canonical schema.

### Modify/delete: migrations and obsolete fixtures

- `src-tauri/migrations/0010_ocr_services.sql` — define AI OCR without direct-Baidu columns or OCR-specific vault journal owners.
- `src-tauri/migrations/0012_service_integrations.sql` — add integration credential ownership without carrying direct-Baidu credential owner kinds.
- `src-tauri/migrations/0014_ocr_service_integration_binding.sql` — converge OCR to `ai | plugin_capability` only.
- `src-tauri/migrations/0017_runtime_plugin_instance_pins.sql` — define package-only integration pins and snapshots; remove Bundled Rust/legacy checks and backfill.
- `src-tauri/migrations/0024_runtime_provider_bindings.sql` — define package-only provider bindings; remove legacy frontend provider checks and backfill.
- `src-tauri/migrations/0025_provider_runtime_interface_bindings.sql` — retain adapter-keyed bindings, snapshots, and model provenance without legacy rows or alias-based historical migration branches.
- Delete `src-tauri/migrations/0030_disable_retired_legacy_runtimes.sql` — obsolete no-op retirement slot for an unpublished app.
- Delete `src-tauri/migrations/0032_baidu_ocr_runtime_migration.sql` — unsupported direct-Baidu transition state.
- Delete `src-tauri/migrations/0033_package_only_cleanup.sql` — cleanup becomes unnecessary after canonical earlier migrations.
- Delete `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v2-config.json` through `v7-config.json` — unsupported import documents.
- Modify `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v8-mixed.json` — current package-only identities only, or replace it with a v8 fixture generated from shared verified package identities if fixed archive digests are required.

### Modify/delete: commands, IPC, and dead code

- Delete `src-tauri/src/cmds/provider_http.rs` — orphan frontend command layer.
- Preserve `src-tauri/src/services/provider_http.rs` — shared provider runtime broker transport preparation.
- `src-tauri/src/cmds/runtime_providers.rs` — remove provider-wide upgrade/rollback handlers if caller inventory is empty; retain interface attach/rollback/detach, catalog, execution, and cancellation.
- `src-tauri/src/services/runtime_providers.rs` — remove provider-wide lifecycle methods only if they have no supported non-test seam; retain adapter-keyed lifecycle and activation.
- `src-tauri/src/lib.rs` — remove confirmed dead handlers and the crate-wide `#![allow(dead_code)]`.
- `src-tauri/build.rs` — remove confirmed dead commands from `APP_COMMANDS`.
- `src-tauri/permissions/app-commands.toml` — remove matching `allow-*` entries.
- `src-tauri/capabilities/trusted-app.json` — no direct command list change is expected; validate that the grouped permission remains correct.
- `src-tauri/src/services/mod.rs` — remove only modules made unused by supported-path convergence.

### Modify: first-party and release security

- `src-tauri/src/services/plugin_store.rs` — use canonical first-party membership; correct stale empty-root comments; keep test roots isolated.
- `src-tauri/src/services/plugin_release_bundle.rs` — derive required package identity checks from the canonical first-party owner while retaining exact expected versions.
- `src-tauri/src/services/vendor_trust.rs` — state that the bundled production public root is non-empty; preserve fail-closed parsing and fixture exclusion tests.
- `src-tauri/resources/vendor-trust/public-keys.json` — validate only; do not edit without explicit signing-owner approval.
- `src-tauri/resources/plugins/default-activation-policies.json` — validate only; regenerate only through the existing public verification tool if signed archive bytes changed.
- `.mise/tasks/plugin/verify-release-bundle` — remove the stale “current empty production resources” comment; keep fail-closed verification.
- `.mise/tasks/tauri/build` — remove the stale “resources are intentionally empty” comment; keep mandatory release-bundle verification.

### Modify: conformance and activation stability

- `.mise/tasks/plugin/conformance` — remove required names for v7 normalization, Bundled Rust pin backfill, and direct migration behavior; require current package-only lifecycle tests; keep Baidu package, native worker, Wasm, LLM, resource, and network suites.
- `.mise/tasks/plugin/check-no-wasi` — update counts/names only if conformance test names change; never reduce coverage to make the task pass.
- `src-tauri/src/services/runtime_plugin_contracts.rs` — change only if a real manifest/artifact contract failure remains after fixture repair.
- `runtime-plugins/conformance/fixtures/packages/llm-provider-valid.lnplugin` — validate only; rebuild with the existing fixture signing path only if its manifest or archive is stale.
- `runtime-plugins/conformance/llm-provider/fixtures/llm-models.wasm` — validate the `llm.models.list@1` artifact.
- `runtime-plugins/conformance/llm-provider/fixtures/llm-chat.wasm` — validate the `llm.chat@1` artifact.
- `src-tauri/src/services/default_package_activation/mod.rs` — add production CAS/claim behavior only if the race reproduces.
- `src-tauri/src/services/default_package_activation/single_flight.rs` — fix verified same-digest single-flight races only if reproduced; do not add sleeps.
- `src-tauri/src/services/default_package_activation/recovery.rs` — keep recovery claim ownership and stable loser outcomes.
- `src-tauri/src/services/default_package_activation/tests/mod.rs` — make concurrency tests deterministic with barriers/hooks and assert exact winner/loser, grant, pin, and intent outcomes.
- `src-tauri/src/repositories/default_package_activation_policies.rs` — add or tighten intent claim/state CAS only when reproduction proves the repository seam permits duplicate ownership.
- `src-tauri/src/repositories/plugin_permission_grants.rs` — change only if duplicate grant creation is the reproduced defect.
- `src-tauri/src/repositories/integration_instances.rs` and `src-tauri/src/repositories/provider_runtime_bindings.rs` — change only if subject pin CAS is the reproduced defect.

### Modify: frontend v8 and direct-Baidu drift

- `src/storage/types.ts` — make configuration format comments v8-only; remove direct-Baidu import-auth preview fields; remove provider-wide lifecycle DTOs if IPC is removed.
- `src/features/settings/configurationTransfer.ts` — set `SUPPORTED_CONFIGURATION_FORMAT_VERSIONS` to `[8]`; remove normalization comments.
- `src/features/settings/configurationTransfer.test.ts` — use a complete v8 document and assert versions 2–7 fail at the frontend parse seam.
- `src/features/settings/importAcceptance.ts` — remove direct-Baidu OCR re-auth classification.
- `src/features/settings/importAcceptance.test.ts` — remove obsolete direct-Baidu warning scenarios; keep provider, integration, proxy, and mixed warnings.
- Frontend provider runtime caller files returned by the required `rg` inventory — remove provider-wide invokes/types only if present; do not invent replacement calls.

### Modify: documentation

- `docs/plans/runtime-plugin-system/phase-12-legacy-retirement.md` — mark the dual-stack compatibility plan superseded by the unpublished package-only decision; remove instructions to retain v2–v8 and legacy executors.
- Release/package documentation returned by the vendor-resource `rg` inventory — state that production public roots and exact policies are non-empty release inputs; retain the private-key prohibition.

## Seams

The supplied requirements pre-confirm these public seams. The implementer must not add tests below these boundaries.

- **Seam:** `storage::migrations::migrate` on a fresh database — produces the final package-only schema atomically with no transitional legacy tables or columns.
- **Seam:** `domain::import_export::parse_and_normalize_export_document` — accepts a complete v8 document and rejects versions 2–7, missing package identity, and unsupported runtime kinds.
- **Seam:** `ImportExportService::preview_raw` / `preview_with_session` / `import_by_preview_id` / `export` — validates and applies exact package-backed graphs without install, trust, grant, or execution side effects.
- **Seam:** `parseConfigurationExportJson` — accepts v8 only before the preview IPC call.
- **Seam:** `PluginPackageService` preview/install/bootstrap/list operations — supplies verified exact package identity to tests and enforces reserved first-party IDs.
- **Seam:** `runtime_plugin_contracts::validate_manifest` plus `plugin:conformance` — requires the two LLM worlds, distinct signed artifacts, exact file-index digests, and current WIT imports.
- **Seam:** `DefaultPackageActivationService::activate_pending_subject` and `recover_pending_default_runtime_activations` — one intent has one mutation winner; stale or losing callers receive a stable non-mutating result.
- **Seam:** Tauri `invoke_handler` + `APP_COMMANDS` + `allow-trusted-app-commands` equality — no orphan or unregistered command remains.
- **Seam:** `verify_release_bundle` — production roots, signed archives, and exact activation policies agree without private material.
- **Seam:** project mise tasks and `git diff --check` — zero test failures, format errors, build warnings, or whitespace errors.

## Tasks

### Task 1: Capture the failure baseline and protect package-only boundaries

**Seam:** Project validation tasks and the new `package-only:check` gate.

**Outcome:** The implementation starts from an exact failure inventory. A fail-closed source gate prevents legacy execution/schema paths from returning during later slices.

**Files:**

- Create: `.mise/tasks/package-only/check`
- Modify: none before baseline capture
- Test: task itself

**Steps:**

- [ ] Record `git status --short`, `git diff --stat`, `git diff`, and `git diff --cached` before edits. Do not overwrite unrelated work.
- [ ] Run `mise run test -- --test-threads=1`, `mise run test-frontend`, `mise run typecheck`, `mise run lint`, `mise run format:check`, `mise run build`, and `mise run plugin:conformance all`. Save every failing test name and warning by command.
- [ ] Classify each failure into the task below that owns it. If a failure has no owner, stop and amend this plan before changing code.
- [ ] Add `.mise/tasks/package-only/check` with exact `rg` gates. Exclude `docs/plans/`, test modules, and explicit rejection tests where the string is test input. Fail on production occurrences of `bundled-rust`, `legacy-frontend-provider`, `formatVersion` compatibility ranges 2–7, direct-Baidu OCR row fields (`baidu_action`, `ocr_api_key`, `ocr_secret_key`), Baidu migration preview/intent/snapshot tables, and the removed provider HTTP command names.
- [ ] Add a migration-specific gate that fails if deleted migration files remain registered or if final-schema SQL contains the forbidden direct/legacy runtime values. Do not forbid the signed `com.langnext.baidu-ocr` package, Baidu host auth policy, or package conformance tests.

**Validation:**

- Run (red): `mise run package-only:check`
- Expected: fails on current legacy migration SQL, frontend versions 2–7, orphan command names, or stale production comments.
- Run (green): `mise run package-only:check`
- Expected: passes after later slices; until then, keep the command red and use its output as the convergence checklist.

### Task 2: Canonicalize the unpublished database schema

**Seam:** `storage::migrations::migrate` and repository writes against a fresh database.

**Outcome:** A fresh database reaches one package-only schema. No migration creates and then deletes direct-Baidu or legacy runtime state.

**Files:**

- Modify: `src-tauri/migrations/0010_ocr_services.sql`
- Modify: `src-tauri/migrations/0012_service_integrations.sql`
- Modify: `src-tauri/migrations/0014_ocr_service_integration_binding.sql`
- Modify: `src-tauri/migrations/0017_runtime_plugin_instance_pins.sql`
- Modify: `src-tauri/migrations/0024_runtime_provider_bindings.sql`
- Modify: `src-tauri/migrations/0025_provider_runtime_interface_bindings.sql`
- Delete: `src-tauri/migrations/0030_disable_retired_legacy_runtimes.sql`
- Delete: `src-tauri/migrations/0032_baidu_ocr_runtime_migration.sql`
- Delete: `src-tauri/migrations/0033_package_only_cleanup.sql`
- Modify/Test: `src-tauri/src/storage/migrations.rs`
- Modify/Test: `src-tauri/src/repositories/tests.rs`

**Steps:**

- [ ] **Red:** Change `migrate_empty_database_to_latest` to assert only `ai | plugin_capability` OCR, only package runtime kinds, mandatory package identity for package pins, and absence of all direct-Baidu orchestration objects. Add public repository write tests that reject a missing package digest and unsupported runtime kind.
- [ ] **Green:** Rewrite the named early migrations to create the final constraints directly. Remove unsupported backfill `INSERT` statements. Remove 0030/0032/0033 from `MIGRATIONS` and delete the files.
- [ ] Remove tests such as `migrate_v16_to_v17_backfills_bundled_runtime_pins` and repository backfill tests because that migration behavior is explicitly unsupported. Do not remove tests for exact digest constraints, unresolved package identity, grants, snapshots, or transaction rollback.
- [ ] Update migration slice indices and `latest_version()` assertions. Because the app is unpublished, do not preserve old numeric user versions with no-op slots.
- [ ] Keep migration execution atomic and keep `PRAGMA foreign_keys` restoration behavior unchanged.

**Validation:**

- Run (red): `mise run test storage::migrations::tests::migrate_empty_database_to_latest -- --exact --nocapture`
- Expected: fails because the current sequence still creates legacy/direct state before cleanup or has the old latest version.
- Run (green): `mise run test storage::migrations -- --nocapture`
- Expected: all migration tests pass; fresh schema contains no transitional objects.
- Run: `mise run test repositories::tests -- --nocapture`
- Expected: package-only constraints and repository behavior pass.

### Task 3: Establish one first-party package identity owner

**Seam:** `PluginPackageService` reserved-ID validation and `verify_release_bundle` required-package validation.

**Outcome:** Store approval, release verification, service package constants, and tests use one canonical ID set.

**Files:**

- Create: `src-tauri/src/domain/first_party_plugins.rs`
- Modify: `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/src/domain/service_integration.rs`
- Modify/Test: `src-tauri/src/services/plugin_store.rs`
- Modify/Test: `src-tauri/src/services/plugin_release_bundle.rs`

**Steps:**

- [ ] **Red:** Add a release/store consistency test that compares the required release package IDs with the canonical first-party set and proves unsigned packages cannot claim any member.
- [ ] **Green:** Move all ten first-party IDs to `domain/first_party_plugins.rs`. Provide `FIRST_PARTY_PLUGIN_IDS` and `is_first_party_plugin_id(&str)`. Re-export named constants where existing domain callers need them.
- [ ] Keep expected release versions in `REQUIRED_OFFICIAL_RELEASE_PACKAGES`; derive identity membership from the canonical constants rather than duplicating literals.
- [ ] Replace `RESERVED_FIRST_PARTY_WASM_PLUGIN_IDS` with the canonical membership function. Do not change signed/unsigned approval rules.

**Validation:**

- Run (red): `mise run test first_party -- --nocapture`
- Expected: new consistency test fails while IDs remain duplicated.
- Run (green): `mise run test first_party -- --nocapture`
- Expected: canonical set, release list, and unsigned rejection tests pass.
- Run: `mise run test plugin_release_bundle -- --nocapture`
- Expected: exact version, digest, publisher, policy, and private-material tests pass.

### Task 4: Make the frontend and backend v8 contract identical

**Seam:** `parseConfigurationExportJson` and `parse_and_normalize_export_document`.

**Outcome:** Both sides accept v8 only. Unsupported documents fail before apply. Current v8 failures remain specific and fail closed.

**Files:**

- Modify/Test: `src/features/settings/configurationTransfer.ts`
- Modify/Test: `src/features/settings/configurationTransfer.test.ts`
- Modify/Test: `src-tauri/src/domain/import_export.rs`
- Modify: `src-tauri/src/domain/runtime_lifecycle.rs`
- Modify: `src/storage/types.ts`

**Steps:**

- [ ] **Red:** Change frontend tests to use a complete v8 sample and assert each version 2–7 is rejected. Keep tests for invalid JSON, missing version, version 99, preview-only behavior, and opaque apply IDs.
- [ ] **Green:** Set the frontend supported version tuple to `[8]` and remove normalization wording.
- [ ] **Red:** Rename backend current-format tests and assert v8 rejects missing runtime requirements, invalid digest, publisher key ID/fingerprint, API version, capability major, duplicate adapter, missing default adapter, missing adapter ID, and unsupported runtime strings.
- [ ] **Green:** Rename `validate_v7_integration_runtime_records` and `validate_v7_runtime_records` to current-format names. Change v7 error prefixes/comments to v8/current. Keep validation strength unchanged.
- [ ] Keep one explicit rejection table for versions 2–7 and one explicit rejection table for unsupported runtime strings. Delete normalization success tests, not rejection tests.

**Validation:**

- Run (red): `bun test --isolate src/features/settings/configurationTransfer.test.ts`
- Expected: versions 2–7 are still accepted by the current frontend parser.
- Run (green): `bun test --isolate src/features/settings/configurationTransfer.test.ts`
- Expected: v8 passes and versions 2–7 fail.
- Run (red): `mise run test domain::import_export::tests -- --nocapture`
- Expected: renamed current-format expectations expose stale names/messages or incomplete fixtures.
- Run (green): `mise run test domain::import_export::tests -- --nocapture`
- Expected: all v8 success and fail-closed cases pass.

### Task 5: Replace placeholder import identities with shared verified package fixtures

**Seam:** `PluginPackageService` bootstrap plus `build_validated_plan`.

**Outcome:** Every supported import success fixture uses identity returned by a real verified package archive. Missing-package tests use a complete but absent identity, not a partial fake row.

**Files:**

- Modify/Test: `src-tauri/src/services/test_support.rs`
- Modify/Test: `src-tauri/src/services/import_validation.rs`
- Modify: `src-tauri/src/services/import_export.rs`

**Steps:**

- [ ] **Red:** Add a `build_validated_plan` success test that installs a committed signed package, builds the requirement from the returned verified identity, and asserts preview status `Installed` with `ActivateAfterImport` while apply remains inactive.
- [ ] **Green:** Add `InstalledPackageFixtureIdentity` to `test_support.rs` with digest, plugin ID/version, publisher key ID/fingerprint, plugin API version, runtime kind, and declared capabilities/adapters. Construct it only from `bootstrap_bundled_package` plus verified manifest data.
- [ ] Add shared `integration_runtime_requirement` and `provider_runtime_requirement` builders. These builders must not accept an arbitrary digest without the rest of the verified identity.
- [ ] Replace `FIXTURE_PACKAGE_DIGEST`, repeated `"f".repeat(64)`, and hand-built success requirements in `import_validation.rs` with shared identities from Edge TTS, Google Cloud, Google Web, and provider packages.
- [ ] For intentional missing-package scenarios, clone a complete verified identity and substitute one independently computed, parse-valid absent archive digest. Keep publisher and manifest identity complete so only local availability is missing.
- [ ] Convert the mixed-cloud/web test with `runtime: None` into a complete package runtime fixture so it fails for the intended config-schema reason. Keep a separate explicit missing-runtime rejection test at the parser seam.
- [ ] Remove `expected_ocr_api_key_refs`, `expected_ocr_secret_key_refs`, and `ocr_requires_authentication` from backend import plan/preview paths because direct Baidu rows are unsupported.

**Validation:**

- Run (red): `mise run test services::import_validation::tests -- --nocapture`
- Expected: at least one new real-identity test fails while helpers or fixtures are incomplete.
- Run (green): `mise run test services::import_validation::tests -- --nocapture`
- Expected: package-backed import validation passes; missing identity and config errors stay specific.
- Run: `mise run test services::test_support -- --nocapture`
- Expected: shared helper tests prove identity comes from verified archive bytes.

### Task 6: Converge import preview/apply/export acceptance on v8

**Seam:** `ImportExportService::preview_with_session`, `import_by_preview_id`, and `export`.

**Outcome:** Current v8 round-trip, Copy/Merge CAS, inactive import, graph integrity, and no-execution guarantees pass with real package fixtures. Unsupported fixture files are gone.

**Files:**

- Modify/Test: `src-tauri/src/services/tests.rs`
- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v8-mixed.json`
- Delete: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v2-config.json`
- Delete: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v3-config.json`
- Delete: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v4-config.json`
- Delete: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v5-config.json`
- Delete: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v6-config.json`
- Delete: `src-tauri/src/services/fixtures/import/runtime-plugin-v8/v7-config.json`

**Steps:**

- [ ] **Red:** Replace `import_format_fixtures_v2_through_v8_normalize_to_current` with a v8-only acceptance test and explicit parser rejection checks for deleted versions.
- [ ] **Green:** Delete v2–v7 files and all assertions that synthesize or preserve Bundled Rust.
- [ ] Migrate `v8-mixed.json` and helper-built documents to complete package identity. Prefer shared helper construction for tests that need installed status. Keep a committed JSON fixture only for the public raw JSON parse seam.
- [ ] Replace manual `insert_installed_package` success setup with real package store bootstrap. Retain direct repository insertion only in repository failure tests that intentionally exercise corrupted/missing catalog rows.
- [ ] Preserve these behaviors: exact runtime requirement preview states, import does not install/trust/grant/activate/dispatch, Copy ID maps remain fixed, stale apply is atomic, concurrent double apply has one winner, reused/expired/unknown preview IDs fail closed, and replaced bindings release grants only when unreferenced.

**Validation:**

- Run (red): `mise run test import_format_fixtures -- --nocapture`
- Expected: old normalization test fails under v8-only parsing.
- Run (green): `mise run test runtime_plugin_import -- --nocapture`
- Expected: v8 round-trip and no-execution tests pass with exact package identity.
- Run: `mise run test import_preview_session_cas -- --nocapture`
- Expected: all preview claim and CAS tests pass.
- Run: `mise run test import_merge_ -- --nocapture`
- Expected: binding reconciliation and grant retention/release tests pass.

### Task 7: Migrate lifecycle and repository tests without restoring legacy behavior

**Seam:** Integration/provider runtime lifecycle services and public repository constraints.

**Outcome:** Supported upgrade, rollback, snapshot, pin, grant, and uninstall behavior uses exact package fixtures. Unsupported backfill/restore behavior is removed only where explicitly outside scope.

**Files:**

- Modify/Test: `src-tauri/src/services/runtime_lifecycle_installed_tests.rs`
- Modify/Test: `src-tauri/src/services/runtime_lifecycle_preference_tests.rs`
- Modify/Test: `src-tauri/src/services/runtime_provider_tests.rs`
- Modify/Test: `src-tauri/src/repositories/tests.rs`
- Modify/Test: `src-tauri/src/services/runtime_lifecycle.rs`
- Modify/Test: `src-tauri/src/services/runtime_providers.rs`

**Steps:**

- [ ] **Red:** For each still-supported lifecycle test, replace partial catalog rows with a package installed through `PluginPackageService`; assert exact source/target digest, publisher, artifact, grant revision, and snapshot identity.
- [ ] **Green:** Reuse `test_support` helpers. Do not introduce a second fixture builder in lifecycle test modules.
- [ ] Delete or replace these explicitly unsupported tests: v7 missing-package restore to a legacy requirement, v7 mapping to Bundled Rust, migration backfill to Bundled Rust, and any rollback to legacy frontend provider. Replace valuable negative coverage with v8 missing-content, revoked publisher, stale preview, missing snapshot, tampered grant, and incompatible package tests.
- [ ] Keep trusted native worker package tests, package rollback, preference byte-exact snapshots, dependency-protected uninstall, grant tamper matrices, and cross-instance authority denial.
- [ ] Remove stale `v7` and “legacy fallback” helper names in production lifecycle code without changing the v8 wire shape.

**Validation:**

- Run (red): `mise run test runtime_lifecycle_installed_tests -- --nocapture`
- Expected: old partial/legacy fixtures fail under package-only constraints.
- Run (green): `mise run test runtime_lifecycle_installed_tests -- --nocapture`
- Expected: supported installed lifecycle passes with verified packages.
- Run: `mise run test runtime_lifecycle_preference_tests -- --nocapture`
- Expected: exact snapshot/CAS behavior passes.
- Run: `mise run test runtime_provider_tests -- --nocapture`
- Expected: provider package lifecycle and execution tests pass.
- Run: `mise run test repositories::tests -- --nocapture`
- Expected: package-only pin, grant, approval, and snapshot constraints pass.

### Task 8: Repair conformance registration and fixture identity

**Seam:** `validate_manifest`, real Wasm execution tests, and `.mise/tasks/plugin/conformance` required-name enforcement.

**Outcome:** `plugin:conformance all` requires only supported tests and proves current signed artifacts, WIT worlds, broker paths, resources, native worker, and package lifecycle.

**Files:**

- Modify/Test: `.mise/tasks/plugin/conformance`
- Modify/Test if names change: `.mise/tasks/plugin/check-no-wasi`
- Modify/Test only on proven product defect: `src-tauri/src/services/runtime_plugin_contracts.rs`
- Modify/Test: `src-tauri/src/services/runtime_provider_tests.rs`
- Validate/rebuild only if stale: `runtime-plugins/conformance/fixtures/packages/llm-provider-valid.lnplugin`
- Validate: `runtime-plugins/conformance/llm-provider/fixtures/llm-models.wasm`
- Validate: `runtime-plugins/conformance/llm-provider/fixtures/llm-chat.wasm`

**Steps:**

- [ ] **Red:** Run each conformance mode separately and record whether failure is a missing required name, package verification failure, manifest contract failure, guest import failure, or runtime behavior failure.
- [ ] Remove required names for unsupported v7/Bundled Rust/backfill tests. Add the renamed v8 package lifecycle tests from Tasks 6–7. Required-name lists must stay fail closed and non-empty.
- [ ] Ensure `all` runs all five LLM protocol crate tests that `llm` runs, then verifies the aggregate provider and guest-import required lists.
- [ ] Verify the LLM fixture manifest declares exactly `llm.models.list@1` and `llm.chat@1`, maps them to different runtime artifacts, indexes both artifacts with exact byte length and SHA-256, and has an archive digest computed from final archive bytes.
- [ ] Rebuild fixture archives only with existing dev fixture signing helpers. Never use or alter production signing keys/resources for conformance.
- [ ] Change `runtime_plugin_contracts.rs` or Wasm host code only after the signed fixture passes structural verification and the real execution test still proves a host/runtime defect.
- [ ] Keep Baidu package conformance. Remove only direct-row migration tests, not `baidu-ocr` protocol/auth/guest/broker tests.

**Validation:**

- Run (red): `mise run plugin:conformance installed-lifecycle`
- Expected: current required-name list reports missing obsolete v7/Bundled Rust tests or those tests fail.
- Run (green): `mise run plugin:conformance installed-lifecycle`
- Expected: all required package-only lifecycle names run and pass.
- Run: `mise run plugin:conformance llm`
- Expected: all protocol crates, package fixtures, two-world execution, and guest imports pass.
- Run: `mise run plugin:conformance wasm`
- Expected: Wasm limits, broker, cancellation, artifact, and import tests pass.
- Run: `mise run plugin:conformance all`
- Expected: every required suite and exact name passes; zero tests or ignored required tests fail the task.

### Task 9: Remove orphan command code and confirmed dead provider-wide IPC

**Seam:** Tauri command registration/ACL equality and frontend invoke inventory.

**Outcome:** No dead command file, invoke, handler, manifest entry, permission, DTO, or test remains. Shared runtime transport stays intact.

**Files:**

- Delete: `src-tauri/src/cmds/provider_http.rs`
- Preserve: `src-tauri/src/services/provider_http.rs`
- Modify/Test: `src-tauri/src/cmds/runtime_providers.rs`
- Modify/Test: `src-tauri/src/services/runtime_providers.rs`
- Modify: `src-tauri/src/domain/runtime_provider.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/permissions/app-commands.toml`
- Validate: `src-tauri/capabilities/trusted-app.json`
- Modify: `src/storage/types.ts`
- Modify frontend caller files found by inventory, if any
- Test: `src-tauri/src/storage/tests.rs`

**Steps:**

- [ ] **Red:** Run `rg -n "provider_http_request|provider_http_stream|cancel_provider_http|preview_provider_runtime_upgrade|apply_provider_runtime_upgrade|preview_provider_runtime_rollback|apply_provider_runtime_rollback" src src-tauri --glob '!src-tauri/src/cmds/provider_http.rs'`. Classify production callers, registrations, ACL entries, types, docs, and tests.
- [ ] Delete the orphan command file. Confirm `provider_runtime_broker.rs` still calls `services::provider_http::prepare_provider_transport`; retain that service and its transport tests.
- [ ] If provider-wide lifecycle has no non-test caller, remove its command handlers, service methods superseded by interface lifecycle, DTOs, handler registrations, `APP_COMMANDS`, permissions, and tests. Port still-valid lifecycle behavior to interface attach/rollback tests first.
- [ ] If a non-test caller exists or Mr. Julian identifies this as an intentional public API, stop this sub-step and request the product decision. Do not silently keep it with `allow(dead_code)` and do not silently break it.
- [ ] Keep provider catalog, interface attach/rollback/detach, snapshot cleanup, models list, chat, and cancellation commands.
- [ ] Run the existing security conformance test that compares handler, AppManifest, and ACL permission sets.

**Validation:**

- Run (red): `mise run test storage::tests -- --nocapture`
- Expected: command set equality fails after the first handler/manifest change until all surfaces are updated together.
- Run (green): `mise run test storage::tests -- --nocapture`
- Expected: handler, AppManifest, generated permission source, and trusted permission set agree.
- Run: `rg -n "provider_http_request|provider_http_stream|cancel_provider_http" src src-tauri`
- Expected: no matches.
- Run: `rg -n "prepare_provider_transport" src-tauri/src/services/provider_runtime_broker.rs src-tauri/src/services/provider_http.rs`
- Expected: shared broker transport remains referenced.

### Task 10: Remove direct-Baidu preview/UI residue while preserving the package

**Seam:** Import preview DTO serialization and `importAuthWarningKind`.

**Outcome:** Import warnings cover only current credential domains. Package Baidu auth and conformance remain unchanged.

**Files:**

- Modify/Test: `src-tauri/src/domain/import_export.rs`
- Modify/Test: `src-tauri/src/services/import_validation.rs`
- Modify/Test: `src-tauri/src/services/import_export.rs`
- Modify: `src/storage/types.ts`
- Modify/Test: `src/features/settings/importAcceptance.ts`
- Modify/Test: `src/features/settings/importAcceptance.test.ts`
- Modify/Test: `src/features/settings/configurationTransfer.test.ts`

**Steps:**

- [ ] **Red:** Update frontend DTO tests to expect no `ocrRequiresAuthentication` field and no `ocr` warning kind.
- [ ] **Green:** Remove the field from Rust/TypeScript DTOs, import plan state, serialization, helper picks, and warning logic.
- [ ] Keep integration credential re-entry for `com.langnext.baidu-ocr` through `integrationRequiresAuthentication`; package credential slots remain the supported path.
- [ ] Ensure no code removes `baidu_token_exchanger.rs`, Baidu auth policy tests, guest package, signed release package, or conformance mode.

**Validation:**

- Run (red): `bun test --isolate src/features/settings/importAcceptance.test.ts`
- Expected: old direct OCR warning expectations fail.
- Run (green): `bun test --isolate src/features/settings/importAcceptance.test.ts src/features/settings/configurationTransfer.test.ts`
- Expected: current provider/integration/proxy warnings pass.
- Run: `mise run test baidu_ocr -- --nocapture`
- Expected: package runtime, auth injection, host-only token, guest import, and integration capability tests pass.

### Task 11: Reproduce and fix activation concurrency failures

**Seam:** `activate_pending_subject`, `recover_pending_default_runtime_activations`, intent claim CAS, grant insertion, and subject pin CAS.

**Outcome:** Deterministic concurrency tests prove one mutation winner, stable loser behavior, one grant/pin, one consumed intent/preview, and correct lock order. No sleeps or expanded retries hide races.

**Files:**

- Modify/Test: `src-tauri/src/services/default_package_activation/tests/mod.rs`
- Modify only if reproduced: `src-tauri/src/services/default_package_activation/mod.rs`
- Modify only if reproduced: `src-tauri/src/services/default_package_activation/single_flight.rs`
- Modify only if reproduced: `src-tauri/src/services/default_package_activation/recovery.rs`
- Modify only if reproduced: `src-tauri/src/repositories/default_package_activation_policies.rs`
- Modify only if reproduced: `src-tauri/src/repositories/plugin_permission_grants.rs`
- Modify only if reproduced: `src-tauri/src/repositories/integration_instances.rs`
- Modify only if reproduced: `src-tauri/src/repositories/provider_runtime_bindings.rs`
- Preserve lock contract: `src-tauri/src/services/plugin_store.rs`

**Steps:**

- [ ] Reproduce each concurrency test at least 50 times with `--test-threads=1` so only the test's own threads race. Cover same-digest single flight, two-subject grants, double recovery workers, and import double apply.
- [ ] **Red:** Replace scheduling-dependent thread starts with existing barriers/test hooks. Assert exact outcomes: one owner/winner, loser `Conflict` or no-op as specified by the public service, intent terminal state, one grant revision, one active pin, no duplicate approval, and no reused preview/session.
- [ ] If only `default_package_activation_single_flight_same_digest` flakes because two spawned calls do not actually overlap, use `verification_block` to prove overlap. This is a test synchronization correction, not a production semantic change.
- [ ] If duplicate subject activation reproduces, add one atomic pending-to-activating claim CAS for normal activation as well as recovery. Bind it to intent ID, subject, digest, expected update token, and optional recovery claim. The loser must not enter store verification or grant mutation.
- [ ] Keep lock order `package store mutation lock -> DB transaction`. Never hold a DB transaction while waiting for the package store lock.
- [ ] If duplicate grant insertion reproduces after intent ownership is fixed, tighten repository uniqueness/CAS at the grant public write seam. Do not catch and ignore constraint errors.
- [ ] If no production race reproduces after deterministic overlap, make no production synchronization change. Keep the deterministic test correction and document the evidence in the implementation PR/commit description.

**Validation:**

- Run (red): `for i in {1..50}; do mise run test default_package_activation_single_flight_same_digest -- --nocapture --test-threads=1 || break; done`
- Expected: current unsynchronized test reproduces the call-count flake or the new exact assertion fails.
- Run (green): `for i in {1..100}; do mise run test default_package_activation_single_flight_same_digest -- --nocapture --test-threads=1 || exit 1; done`
- Expected: 100 deterministic passes.
- Run: `for i in {1..100}; do mise run test default_package_activation_single_flight_two_subjects_independent_grants -- --nocapture --test-threads=1 || exit 1; done`
- Expected: one grant/pin per subject and bounded shared verification on every run.
- Run: `for i in {1..100}; do mise run test default_package_activation_startup_recovery_two_workers_claim_partition -- --nocapture --test-threads=1 || exit 1; done`
- Expected: every intent is claimed exactly once with no overlap.
- Run: `for i in {1..100}; do mise run test import_preview_session_cas_concurrent_double_apply_claims_once -- --nocapture --test-threads=1 || exit 1; done`
- Expected: one apply winner and one stable conflict on every run.

### Task 12: Correct production trust and release documentation without changing trust material

**Seam:** `load_production_vendor_public_keys` and `verify_release_bundle`.

**Outcome:** Code and task documentation match the actual non-empty production resources. Security tests continue to exclude fixture keys and private material.

**Files:**

- Modify/Test: `src-tauri/src/services/vendor_trust.rs`
- Modify: `src-tauri/src/services/plugin_store.rs`
- Modify: `.mise/tasks/plugin/verify-release-bundle`
- Modify: `.mise/tasks/tauri/build`
- Modify: `docs/plans/runtime-plugin-system/phase-12-legacy-retirement.md`
- Modify other release/package docs returned by `rg -n "empty.*vendor|vendor.*empty|empty production resources|v2.?v8|dual-stack" docs .mise src-tauri/src`
- Validate only: `src-tauri/resources/vendor-trust/public-keys.json`
- Validate only: `src-tauri/resources/plugins/default-activation-policies.json`

**Steps:**

- [ ] **Red:** Keep/extend the production trust test to require the canonical production key ID, reject the fixture public key, and load the cargo resource root.
- [ ] **Green:** Remove claims that bundled production JSON or release resources are empty by default. State that only public verification material is committed and private signing material remains offline.
- [ ] Mark the old Phase 12 dual-stack plan as superseded. Do not leave executable instructions that require v2–v7 or legacy executor compatibility.
- [ ] Do not edit public key hex, policy digests, archive bytes, or expected package versions in this documentation slice.

**Validation:**

- Run (red): `rg -n "empty by default|ships empty|intentionally empty|v2.?v8 remain readable|dual-stack legacy" src-tauri/src .mise docs`
- Expected: stale comments and the superseded plan are found.
- Run (green): same command
- Expected: no active instruction claims empty production resources or retained legacy compatibility; a superseded historical note can name the old decision only in explanatory text.
- Run: `mise run test vendor_trust -- --nocapture`
- Expected: production root is present; fixture root is absent.
- Run: `mise run plugin:verify-release-bundle`
- Expected: all production public roots, signed archives, exact versions, digests, publishers, and activation policies verify.

### Task 13: Eliminate compiler warnings, dead code allowances, and format failures

**Seam:** Rust compiler all-targets check, frontend build, linters, and formatters.

**Outcome:** No crate-wide warning suppression remains. Every supported target compiles with warnings denied. Formatting and whitespace checks pass.

**Files:**

- Modify: `src-tauri/src/lib.rs`
- Modify/delete warning owners identified by `cargo check --all-targets`
- Modify: `src-tauri/src/services/mod.rs` only for modules made unused by prior tasks
- Format: all changed Rust, TypeScript, JSON, Markdown, SQL, and task files except generated `src/routeTree.gen.ts`

**Steps:**

- [ ] **Red:** Remove `#![allow(dead_code)]` from `src-tauri/src/lib.rs` and run warnings-as-errors across all targets.
- [ ] For each warning, either remove the dead item, connect it to a supported production caller, move test-only code under `#[cfg(test)]`, or narrow an allow to a documented unavoidable generated/external boundary. Do not add a crate/module-wide dead-code allow.
- [ ] Remove imports, helpers, DTOs, and modules made unused by fixture, migration, and IPC deletion.
- [ ] Run `mise run format` once logical edits are complete. Review its diff and do not edit `src/routeTree.gen.ts` manually.
- [ ] Fix `git diff --check` whitespace errors, including tabs inside comments that formatters can miss.

**Validation:**

- Run (red): `RUSTFLAGS="-D warnings" cargo check --manifest-path src-tauri/Cargo.toml --all-targets`
- Expected: current dead or unused items fail compilation after global suppression is removed.
- Run (green): same command
- Expected: exits 0 with no warnings.
- Run: `RUSTFLAGS="-D warnings" cargo test --manifest-path src-tauri/Cargo.toml --all-targets --no-run`
- Expected: all test targets compile with no warnings.
- Run: `mise run format:check`
- Expected: oxfmt and rustfmt report no changes.
- Run: `git diff --check`
- Expected: no whitespace errors.

## Final Validation

Run from the repository root in this order. Do not start `tauri:build` until all earlier gates pass.

1. `mise run test`
   - Expected: all Rust unit and integration tests pass; zero ignored required conformance tests are used as substitutes.
2. `mise run test-frontend`
   - Expected: all Bun frontend tests pass in isolation.
3. `mise run typecheck`
   - Expected: TypeScript 7 exits 0 with no diagnostics.
4. `mise run lint`
   - Expected: authoritative ESLint and companion oxlint both pass with no warnings treated as success.
5. `mise run format:check`
   - Expected: oxfmt and rustfmt report a clean tree.
6. `mise run build`
   - Expected: TypeScript and Vite production build pass with no build warnings.
7. `mise run plugin:conformance all`
   - Expected: every required package-only Wasm, lifecycle, LLM, provider, service package, native worker, network, resource, and Baidu package test runs by exact name and passes.
8. `mise run plugin:check-no-wasi`
   - Expected: host dependency tree and all guest imports contain no WASI implementation/import; required count and names match.
9. `mise run plugin:verify-release-bundle`
   - Expected: production public roots, signed archives, versions, digests, publisher identities, and policies match; no private material exists.
10. `RUSTFLAGS="-D warnings" cargo check --manifest-path src-tauri/Cargo.toml --all-targets`
    - Expected: compiler warning check exits 0 with no warnings.
11. `RUSTFLAGS="-D warnings" cargo test --manifest-path src-tauri/Cargo.toml --all-targets --no-run`
    - Expected: every test target compiles with warnings denied.
12. `mise run package-only:check`
    - Expected: production legacy/runtime/direct-row gates pass.
13. Production legacy gates, shown explicitly even though the mise task wraps them:

    ```bash
    rg -n "bundled-rust|legacy-frontend-provider" src src-tauri/src src-tauri/migrations \
      --glob '!**/*test*' --glob '!**/tests/**'
    rg -n "baidu_ocr_migration_(previews|intents|snapshots)|baidu_action|ocr_api_key|ocr_secret_key" \
      src src-tauri/src src-tauri/migrations --glob '!**/*test*' --glob '!**/tests/**'
    rg -n "provider_http_request|provider_http_stream|cancel_provider_http" src src-tauri
    rg -n "SUPPORTED_CONFIGURATION_FORMAT_VERSIONS.*[234567]|normalize.*v2|v2.?v7" src src-tauri/src \
      --glob '!**/*test*' --glob '!**/tests/**'
    ```

    - Expected: no production matches. Explicit rejection tests can contain unsupported input literals outside these production globs. Package Baidu symbols are not forbidden.

14. `git diff --check`
    - Expected: no whitespace errors.
15. `mise run tauri:build`
    - Expected: release-bundle gate reruns, frontend rebuild succeeds, Tauri compiles/packages all configured targets available on the host, and portable packaging succeeds with no warnings.
16. Review `git status --short`, `git diff --stat`, and `git diff`.
    - Expected: only in-scope source, test, fixture, task, migration, and documentation changes remain; no generated cache, private signing material, unrelated edits, or accidental `src/routeTree.gen.ts` edits.

Optional manual startup check after all required gates:

- Run: `mise run tauri:dev`
- Expected: startup loads production public trust roots and bundled package definitions, creates no legacy runtime/direct-Baidu rows, and does not duplicate default activation intents.

## Failure Behavior

- Import format 2–7 — reject as unsupported before preview/apply; do not normalize.
- Missing integration/provider runtime identity — reject the document as invalid; do not synthesize package data.
- Complete but locally absent package identity — preview as missing and import inactive/unavailable without installation or execution.
- Invalid digest, signature, publisher, manifest, artifact, capability, or grant — fail closed with no partial mutation.
- Revoked/disabled publisher or unavailable content — retain exact identity and report the existing stable unavailable/action state.
- Unsupported runtime string — reject; never route to Bundled Rust or frontend execution.
- Direct Baidu OCR row data — unsupported schema/input; do not convert automatically. The signed Baidu package remains supported.
- Concurrent activation loser — stable conflict or documented no-op with no grant, pin, approval, or intent duplication.
- Stale/reused/expired preview — reject before mutation; preserve current local state.
- Release root/package/policy mismatch — `plugin:verify-release-bundle` and `tauri:build` fail.
- Compiler or build warning — warnings-as-errors gate fails; do not suppress globally.

## Privacy and Security

- Configuration exports, previews, logs, and errors must not contain secrets, credential references, package bytes, grants, or absolute paths.
- Tests use only `test_vendor_fixture` signing material. Production resources must never contain fixture keys.
- Do not add, regenerate, or request private signing keys. Production archive/resource changes require the signing owner and are outside this plan unless a verified archive is proven stale.
- Import never installs, trusts, grants, activates, or executes packages.
- Keep exact final archive SHA-256, publisher reverse binding, signed file index, capability/artifact identity, endpoint policy, resource bounds, path confinement, and no-WASI checks.
- Keep package store lock before DB transaction whenever both are required.

## Rollout Notes

- No data rollout or compatibility migration is required because the app is unpublished.
- Treat the rewritten migration sequence as the only baseline. Delete local development databases created by older worktree revisions before manual startup validation.
- Do not commit or stage as part of implementation unless Mr. Julian requests it.
- If signed production archive bytes must change, stop before resource mutation. Obtain signing-owner approval and rerun policy generation and release verification through existing tools.

## Risks and Mitigations

- **Broad fixture edits hide a product defect** — migrate one public seam at a time and require red-before-green on the exact focused command.
- **Fake digest helpers recreate the current problem** — shared success helpers derive identity only from verified archive output; absent-package tests mutate only the digest after a complete identity exists.
- **Migration rewrite misses a final constraint** — assert the final schema through public repository writes and `migrate_empty_database_to_latest`, not only SQL text inspection.
- **Deleting Baidu code removes the package path** — gates forbid only direct-row fields/tables; package ID, auth policy, broker, guest, release resource, and conformance remain required.
- **Dead IPC removal breaks an intentional external caller** — complete caller inventory first and stop for the explicit product decision if a real caller or promised API exists.
- **Concurrency test remains scheduler-dependent** — use barriers and existing hooks; never sleeps, timing windows, or retry inflation.
- **Global warning cleanup expands scope** — remove only items made dead by this convergence or already reported by all-target compiler checks; report unrelated warnings as blockers.
- **Production trust resources are accidentally replaced by fixture data** — validate resource hashes/digests, retain fixture-exclusion tests, and prohibit private/test material in release bundles.

## Open Questions

1. **Provider-wide lifecycle API:** Is `preview/apply_provider_runtime_upgrade` and `preview/apply_provider_runtime_rollback` an intentional public compatibility API despite no known frontend caller? If caller inventory is empty, this plan removes it. If it is intentional, Mr. Julian must approve retention and its supported seam must be documented and warning-clean.
2. **Signed fixture ownership:** If `llm-provider-valid.lnplugin` or a production package archive is structurally stale, who is authorized to regenerate it? Dev conformance fixtures can use the existing test signing key. Production archives and activation policy digests require signing-owner permission.
3. **Unmapped baseline failures:** The complete 84–85 failure list was not available during planning. Any failure not owned by Tasks 2–13 must be surfaced and mapped before implementation continues.
