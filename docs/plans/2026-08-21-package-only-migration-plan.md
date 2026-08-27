# Implementation Plan

**Goal:** Every concrete Google, Edge, LLM provider, PaddleOCR, and Baidu protocol executes only through installed signed runtime packages. Bundled Rust, legacy frontend provider, and direct vendor REST executors are removed; no dual-stack window or release evidence is required because the app has never shipped.

**Inputs:** Current `HEAD` (`68c64f7`); `docs/plans/runtime-plugin-system/README.md`; `docs/plans/runtime-plugin-system/phase-11-5-default-package-activation.md`; `docs/plans/runtime-plugin-system/phase-12-legacy-retirement.md`; `docs/plans/2026-08-21-unsigned-plugin-install-plan.md`; current production code and resources inspected on 2026-08-21.

**Assumptions:**

- “Package-only” means concrete Google, Edge, LLM provider, PaddleOCR, and Baidu protocols execute only through installed Wasm Component or allowlisted native-worker packages.
- The host continues to own credentials, OAuth/token exchange, network authorization, execution grants, persistence, Blob/Stream resources, cancellation, import/export, product workflows, and schema-rendered UI.
- Official replacement packages remain vendor-signed. Unsigned support is an advanced-user path and is not the migration target for first-party defaults.
- **Decision (2026-08-21, revised):** the application is unpublished and has never shipped. There are no legacy users, legacy runtimes, legacy imported data, or prior export formats to preserve. Stable dual-stack release evidence (Gate E/F) and release-owner approval are cancelled; the migration converges directly to the package-only architecture.
- The unsigned package plan uses migration `0031`. Baidu/package cleanup uses migration `0032`/`0033`.
- Existing integration, provider, model, profile, OCR service, Speech service, settings, and history UUIDs remain stable.
- The current `(plugin_id, version)` package uniqueness rule remains.
- Phase 9 isolated custom plugin pages remain optional and are outside this migration.

**Architecture:** First make the release bundle complete and verifiable: production public trust roots, vendor-signed packages, and exact default activation policies. Implement the unsigned package plan and the Baidu OCR package. Then retire every legacy executor unconditionally — Bundled Rust, the five TypeScript provider adapters, direct Baidu REST, and the PaddleOCR bundled placeholder — and delete the retirement/inventory/evidence machinery that existed only to gate a dual-stack window.

**Tech Stack:** Rust 2024, Tauri 2, SQLite/rusqlite, Wasmtime Component Model, trusted native workers, Ed25519, SHA-256, React 19, Base UI, TanStack Query, Effect, Bun, mise.

---

## Current Status

### Delivered

- Runtime plugin security, WIT contracts, schema UI, Wasm runtime, package lifecycle, runtime lifecycle, and exact package pinning are present.
- Runtime package implementations exist under `runtime-plugins/` for:
  - Google Translate Web
  - Edge TTS
  - Google Cloud
  - OpenAI Compatible
  - OpenAI Responses
  - Anthropic
  - Gemini
  - DeepSeek
  - PaddleOCR native worker
- Import/export recovery and default package activation are present.
- Phase 12 inventory, creation gates, release-candidate gates, and remediation UI are present.
- `LegacyRuntimeRetirementPanel` already delegates migration to existing integration and provider lifecycle preview/apply APIs.

### Not production-ready

- `src-tauri/resources/plugins/` contains no `.lnplugin` archive.
- `src-tauri/resources/plugins/default-activation-policies.json` is `[]`.
- `src-tauri/resources/vendor-trust/public-keys.json` is `[]`.
- App resource discovery recognizes Google Web, Edge TTS, Google Cloud, OpenAI Compatible, and PaddleOCR only. It does not recognize OpenAI Responses, Anthropic, Gemini, or DeepSeek.
- No repository evidence proves one stable dual-stack release for any executor.

### Legacy execution still present

- Bundled Rust protocol implementations remain:
  - `src-tauri/src/services/google_translate_web.rs`
  - `src-tauri/src/services/edge_tts.rs`
  - `src-tauri/src/services/google_cloud.rs`
- Bundled registrations and handlers remain in:
  - `src-tauri/src/services/bundled_plugins.rs`
  - `src-tauri/src/services/service_capabilities.rs`
  - `src-tauri/src/services/service_integration_registry.rs`
- The five TypeScript provider implementations and `LegacyFrontendProviderExecutor` remain under `src/features/providers/`.
- PaddleOCR keeps a bundled placeholder and is explicitly outside the current production retirement scope.
- Baidu OCR remains a direct native REST/OAuth implementation in `src-tauri/src/services/ocr_services.rs`.

### Current retirement policy

- Production integration create retirement names Google Web, Edge TTS, and Google Cloud.
- Production provider retirement allowlist is empty.
- PaddleOCR is not in the current retirement inventory scope.
- Existing enabled legacy rows keep their old executor available.
- Migration `0030` is a no-op checkpoint and does not alter user rows.

### Working tree

- `main` is one commit ahead of `origin/main`: `68c64f7` is not pushed.
- `docs/plans/2026-08-21-unsigned-plugin-install-plan.md` is currently untracked.
- This plan is also untracked until explicitly committed.

## Target State

1. Every official protocol implementation ships as a verified runtime package.
2. Every new integration/provider is created package-first from an authorized exact default.
3. Every existing active row is package-backed, or explicitly disabled/unresolved.
4. Baidu OCR uses `ocr.image@1` through a Wasm package.
5. No production request can select Bundled Rust, `LegacyFrontendProviderExecutor`, or direct Baidu REST.
6. Missing package code preserves data and returns a stable unavailable/migration-required state.
7. Package failure never replays the same request through removed legacy code.
8. Package rollback remains available after host executor removal.

## Phase Gates

### Gate A: Release bundle readiness

All conditions are mandatory:

- A real production Ed25519 public key is present in release inputs.
- Vendor-signed archives exist for all nine current runtime packages.
- Every archive passes exact public-key verification and archive digest checks.
- Exact default activation policies exist for every first-party package used for package-first creation.
- The release bundle contains public keys, archives, and policies, but no private key or seed.
- Missing, duplicate, wrong-version, wrong-digest, or stale-policy resources fail release validation.

### Gate B: Migration readiness

- Every replacement package is installed and visible in the catalog.
- Every target has an authorized default and package-first readiness.
- Existing integration/provider lifecycle preview, apply, and rollback pass with real package fixtures.
- Migration preserves IDs, dependencies, credentials, preferences, and app defaults.
- Legacy executors remain compiled and selectable only for rows that still bind them.

### Gate C: Unsigned support readiness

`docs/plans/2026-08-21-unsigned-plugin-install-plan.md` is implemented and validated. Vendor bootstrap remains signed-only. This gate does not retire any executor and does not convert official defaults to unsigned packages.

### Gate D: Baidu package readiness

- A signed `com.langnext.baidu-ocr` Wasm package implements `ocr.image@1`.
- Baidu API key, secret key, and access token never enter guest data, frontend IPC, logs, or export.
- Existing Baidu actions and normalized errors pass conformance against current fixtures.
- Existing Baidu OCR services have preview/apply/rollback migration.
- Direct Baidu REST remains available during the stable dual-stack release.

### Gate E: Stable dual-stack release — CANCELLED

The app is unpublished. No stable dual-stack release is required; release-owner approval is cancelled. Executor removal no longer waits on release evidence.

### Gate F: Executor retirement — CANCELLED

Executor retirement now happens unconditionally: every legacy executor is deleted with its static registration and creation branches. Package rollback remains available through package-version snapshots.

## File Map

### Release verification and resources

- Create: `src-tauri/src/bin/plugin_release_tool.rs` — verify a release resource set and generate exact bootstrap-policy entries from already signed packages; never read private keys.
- Create: `.mise/tasks/plugin/verify-release-bundle` — run the release verifier against a resource directory.
- Create: `.mise/tasks/plugin/generate-bootstrap-policy` — emit reviewed JSON entries from verified signed archives.
- Modify: `src-tauri/src/state.rs` — discover all official package prefixes and bootstrap them deterministically.
- Modify: `src-tauri/resources/plugins/README.md` — list all required release packages and validation steps.
- Modify: `src-tauri/resources/vendor-trust/README.md` — document release-time public-key injection.
- Modify: `src-tauri/tauri.conf.json` — retain public trust and plugin resources in package outputs.
- Test: `src-tauri/src/services/plugin_store.rs` — release bundle validation and vendor bootstrap negatives.
- Test: `src-tauri/src/state.rs` — complete resource discovery.

### Package-derived integration definitions

- Modify: `src-tauri/src/domain/runtime_plugin.rs` — add closed declarative capability→endpoint→path authority forms for service packages.
- Modify: `src-tauri/src/services/runtime_plugin_contracts.rs` — validate exact, bounded prefix/suffix, and host-resolved instance-configured relative-path rules without arbitrary regex or guest-selected authority.
- Modify: `src-tauri/src/services/service_integration_registry.rs` — store package definitions and compatibility-only legacy registrations under separate origins for the same plugin ID.
- Modify: `src-tauri/src/services/plugin_store.rs` — project verified manifest, config schema, preference schemas, presentation, endpoints, credential slots, auth bindings, and path authority.
- Modify: `src-tauri/src/services/plugin_schema.rs` — provide generic installed-package config/preference adapters.
- Modify: current service `runtime-plugins/*/plugin.json` manifests — declare capability-to-endpoint path authority used by package projection.
- Modify: `src-tauri/src/services/service_integrations.rs` — list and create from package-derived definitions.
- Modify: `src-tauri/src/state.rs` — construct the combined catalog after vendor package bootstrap.
- Test: `src-tauri/src/services/service_integrations.rs` — synthetic installed package definition and create path.

### Existing-row migration

- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs` — include all service and provider slices, replacement readiness, rollback readiness, and row actions.
- Modify: `src-tauri/src/domain/legacy_runtime_inventory.rs` — add sanitized evidence/readiness fields without exposing credentials.
- Modify: `src/features/plugins/LegacyRuntimeRetirementPanel.tsx` — present per-row migration, disable, delete, and rollback readiness using existing lifecycle commands.
- Modify: `src/features/plugins/LegacyRuntimeRetirementPanel.test.tsx` — migration/disable/delete/rollback scenarios.
- Reuse: `RuntimeLifecycleService` integration preview/apply/rollback.
- Reuse: `ProviderRuntimeService` provider preview/apply/rollback/interface attach.

### Unsigned package support

- Implement: `docs/plans/2026-08-21-unsigned-plugin-install-plan.md` — migration `0031`, install warnings, exact-digest approval, runtime verification, defaults, native risk, import/recovery, and documentation.

### Baidu OCR package and host auth

- Create: `runtime-plugins/baidu-ocr/plugin.json` — signed Wasm package manifest for `ocr.image@1`.
- Create: `runtime-plugins/baidu-ocr/ocr/` — Component implementation and fixtures.
- Create: `runtime-plugins/baidu-ocr/schemas/` — host-rendered config and OCR preference schemas.
- Create: `runtime-plugins/baidu-ocr/tests/` — protocol fixtures and conformance tests.
- Create: `.mise/tasks/plugin/build-baidu-ocr` — deterministic unsigned staging build.
- Create: `.mise/tasks/plugin/refresh-baidu-ocr-fixture` — dev-only signed fixture refresh.
- Modify: `.mise/tasks/plugin/conformance` — add fail-closed Baidu OCR mode.
- Modify: `.mise/tasks/plugin/check-no-wasi` — assert exact guest imports.
- Create: `src-tauri/src/services/baidu_token_exchanger.rs` — host-only Baidu client-credentials exchange.
- Modify: `src-tauri/src/services/auth_policies.rs` — add a closed Baidu client-credentials auth policy.
- Modify: `src-tauri/src/services/token_grant.rs` — use a closed exchanger registry and typed `TokenInjectionKind` for Bearer header or fixed query parameter.
- Modify: `src-tauri/src/services/wasm_runtime/network_handle.rs` — accept the Baidu policy and apply host-owned query injection after guest query validation.
- Modify: `src-tauri/src/services/wasm_runtime/host.rs` — keep credential-like guest query keys blocked and add Baidu path-authority enforcement.
- Modify: `src-tauri/src/services/network_broker.rs` — share typed token injection where bundled compatibility still uses the broker.
- Modify: `src-tauri/src/services/runtime_plugin_contracts.rs` — validate the closed Baidu endpoint/auth/path declaration.
- Modify: `src-tauri/src/services/service_integrations.rs` — validate readiness through a declared remote capability instead of hard-coded `translate.text@1`.
- Modify: `src-tauri/src/state.rs` — construct the closed token exchanger registry.
- Test: `src-tauri/src/services/baidu_ocr_runtime_tests.rs` — real package/broker/token execution.

### Baidu row migration

- Create: `src-tauri/migrations/0032_baidu_ocr_runtime_migration.sql` — durable preview/apply/recovery/rollback intent and identity snapshot tables; no automatic row conversion.
- Create: `src-tauri/src/domain/baidu_ocr_migration.rs` — sanitized preview/apply/rollback DTOs.
- Create: `src-tauri/src/repositories/baidu_ocr_migration.rs` — intent and snapshot persistence.
- Create: `src-tauri/src/services/baidu_ocr_migration.rs` — explicit migration orchestration.
- Create: `src-tauri/src/cmds/baidu_ocr_migration.rs` — trusted-app preview/apply/rollback commands.
- Modify: `src-tauri/src/repositories/ocr_services.rs` — exact row CAS and provider-type transition.
- Modify: `src-tauri/src/repositories/integration_credential_bindings.rs` — bind existing opaque vault refs to Baidu package slots.
- Modify: `src-tauri/src/services/import_export.rs` — preserve old Baidu rows and new package requirements without exporting secrets or grants.
- Modify: `src-tauri/src/services/import_validation.rs` — keep imported package requirements inactive.
- Modify: `src-tauri/src/storage/migrations.rs` — register migration 0032 and advance version assertions.
- Modify: `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/cmds/mod.rs` — register new modules.
- Modify: `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json` — register commands and preserve command/ACL parity.
- Modify: `src/storage/types.ts`, `src/storage/client.ts` — typed IPC DTOs.
- Modify: `src/features/ocr/OcrServiceEditor.tsx` — migration and rollback actions for legacy Baidu rows.
- Modify: `src/features/ocr/recognizeOcrFlow.ts` — package-capability dispatch after migration; keep legacy dispatch during dual stack.
- Test: `src-tauri/src/services/baidu_ocr_migration.rs` and `src/features/ocr/recognizeOcrFlow.test.ts`.

### Stable release evidence

- Create: `src-tauri/resources/plugins/retirement-release-evidence.json` — release-owner-approved executor/package evidence; empty by default in source.
- Create: `src-tauri/src/domain/retirement_release_evidence.rs` — strict deny-unknown evidence schema.
- Create: `src-tauri/src/services/retirement_release_evidence.rs` — load and validate application version, package digest, policy digest, and prior stable release.
- Modify: `src-tauri/src/services/legacy_runtime_retirement.rs` — keep package-first creation retirement separate from execution-removal evidence.
- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs` — require evidence and live row readiness only for execution removal/final deletion.
- Modify: `src-tauri/src/state.rs` — load evidence fail-closed; missing/invalid evidence keeps only execution release/final deletion disabled and does not reopen legacy creation.
- Test: `src-tauri/src/services/legacy_runtime_inventory.rs` — evidence/readiness matrix.

### Final retirement

- Delete after gates: `src-tauri/src/services/google_translate_web.rs`.
- Delete after gates: `src-tauri/src/services/edge_tts.rs`.
- Delete after gates: `src-tauri/src/services/google_cloud.rs` protocol execution code; preserve host-owned Google auth/broker code.
- Delete after gates: five provider protocol implementations under `src/features/providers/builtin/`.
- Modify/delete after final provider: `src/features/providers/executor.ts`, `src/features/providers/registry.ts`, `src/features/providers/types.ts`.
- Modify: `src-tauri/src/services/bundled_plugins.rs`, `service_capabilities.rs`, `service_integration_registry.rs`, `runtime_router.rs` — remove retired registrations and adapters.
- Modify: `src-tauri/src/services/ocr_services.rs`, `src-tauri/src/domain/ocr_service.rs` — remove direct Baidu execution while preserving compatibility readers.
- Modify: `src/features/ocr/ocrProviderOptions.ts`, `BaiduOcrForm.tsx`, `OcrServiceEditor.tsx` — remove new legacy Baidu creation after migration window.
- Preserve: v2-v8 import fixtures, unresolved-row display, package rollback, host auth policies, brokers, grants, resource limits, and native worker safety controls.

## Seams

These public seams must be confirmed before implementation starts.

- **Seam:** `plugin_release_tool verify-bundle` and `mise run plugin:verify-release-bundle` — release resource completeness and identity.
- **Seam:** `AppState::initialize` — deterministic signed package bootstrap and exact default policy application.
- **Seam:** `ServiceIntegrationService::list_definitions` / `save` — package-derived definition and package-first creation.
- **Seam:** (removed) `LegacyRuntimeInventoryService::list_inventory` — the retirement inventory is deleted with the retirement machinery.
- **Seam:** existing `RuntimeLifecycleService` and `ProviderRuntimeService` preview/apply/rollback methods — existing-row migration.
- **Seam:** seams approved in `docs/plans/2026-08-21-unsigned-plugin-install-plan.md` — unsigned package support.
- **Seam:** `TokenGrantService` plus `wasm_runtime::NetworkBrokerHandle` — host-owned Baidu token exchange and post-validation query injection on the actual guest path.
- **Seam:** `OcrServiceService::recognize` through `RuntimeRouter` — Baidu package execution.
- **Seam:** new Baidu migration preview/apply/rollback commands — identity-preserving row migration.
- **Seam:** `RuntimeRouter::resolve` — package-only integration dispatch.
- **Seam:** `resolveProviderExecutor` — package-only provider dispatch.
- **Seam:** `OcrServiceService::recognize` — package-only OCR dispatch after Baidu retirement.

## Tasks

### Task 1: Add fail-closed release bundle verification

**Seam:** `plugin_release_tool verify-bundle`

**Outcome:** Release packaging fails unless every required official package, public trust root, and exact activation policy is present and mutually consistent.

**Files:**

- Create: `src-tauri/src/bin/plugin_release_tool.rs`
- Create: `.mise/tasks/plugin/verify-release-bundle`
- Create: `.mise/tasks/plugin/generate-bootstrap-policy`
- Modify: `src-tauri/src/services/plugin_package.rs`
- Modify: `src-tauri/src/services/default_package_activation/vendor_bootstrap.rs`
- Test: `src-tauri/src/services/plugin_store.rs`

**Steps:**

- [ ] **Red:** Add `release_bundle_rejects_missing_package_policy_or_root` with fixed complete, missing-package, missing-root, stale-policy, duplicate-version, wrong-publisher, and wrong-digest fixtures.
- [ ] **Green:** Implement a read-only release bundle verifier. Reuse production package verification and authority-constraint derivation. Never read private keys.
- [ ] **Red:** Add `bootstrap_policy_generator_emits_exact_verified_identity` and compare against independently fixed digest/permission/authority literals.
- [ ] **Green:** Generate one `VendorBootstrapPolicyEntry` only from an already signed and verified package plus an external vendor public root.
- [ ] Require these current packages: Google Web, Edge TTS, Google Cloud, OpenAI Compatible, OpenAI Responses, Anthropic, Gemini, DeepSeek, and PaddleOCR.
- [ ] Log only plugin ID, version, package digest, and status.

**Validation:**

- Run (red): `mise run test release_bundle_rejects_missing_package_policy_or_root -- --nocapture`
- Expected: current empty resource fixture fails with a stable missing-resource result.
- Run (green): same command.
- Expected: complete fixture passes; every mismatch fails.
- Run: `mise run plugin:verify-release-bundle`
- Expected now: fails because production resources are empty. It must pass before a release build.

### Task 2: Bootstrap every official signed package and default

**Seam:** `AppState::initialize`

**Outcome:** The app discovers all official archives, imports each exact digest, and applies only reviewed exact default activation policies.

**Files:**

- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/resources/plugins/README.md`
- Test: `src-tauri/src/state.rs`
- Test: `src-tauri/src/services/default_package_activation/tests/mod.rs`

**Steps:**

- [ ] **Red:** Add `production_resource_bootstrap_discovers_all_required_packages` with one signed archive for each required package.
- [ ] **Green:** Add explicit resource prefixes and environment overrides for OpenAI Responses, Anthropic, Gemini, and DeepSeek. Preserve deterministic ordering and exact vendor verification.
- [ ] **Red:** Add `production_bootstrap_missing_policy_installs_but_does_not_authorize_default`.
- [ ] **Green:** Keep package import separate from default policy application. Missing or stale policy leaves the package visible but package-first creation blocked.
- [ ] Generate release policy JSON with Task 1 tooling. Do not hand-author digests or authority ceilings.

**Validation:**

- Run (red): `mise run test production_resource_bootstrap_discovers_all_required_packages -- --nocapture`
- Expected: fails because discovery omits four LLM provider prefixes/overrides.
- Run (green): same command.
- Expected: all nine current packages import deterministically.
- Run (red): `mise run test production_bootstrap_missing_policy_installs_but_does_not_authorize_default -- --nocapture`
- Expected: fails until package visibility and default authorization are asserted separately.
- Run (green): same command.
- Expected: package remains visible; only an exact reviewed policy authorizes its default.

### Task 3: Project integration definitions from installed packages

**Seam:** `ServiceIntegrationService::list_definitions` / `save`

**Outcome:** An installed service package can appear, render schema UI, and create a package-first instance without a concrete registration in `bundled_plugins.rs`.

**Files:**

- Modify: `src-tauri/src/domain/runtime_plugin.rs`
- Modify: `src-tauri/src/services/runtime_plugin_contracts.rs`
- Modify: `src-tauri/src/services/plugin_store.rs`
- Modify: `src-tauri/src/services/service_integration_registry.rs`
- Modify: `src-tauri/src/services/plugin_schema.rs`
- Modify: `src-tauri/src/services/service_integrations.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `runtime-plugins/google-translate-web/plugin.json`
- Modify: `runtime-plugins/edge-tts/plugin.json`
- Modify: `runtime-plugins/google-cloud/plugin.json`
- Modify: `runtime-plugins/paddleocr/plugin.json` only for definition metadata that applies to native packages
- Test: `src-tauri/src/services/service_integrations.rs`
- Test: `src-tauri/src/services/runtime_plugin_contracts.rs`

**Steps:**

- [ ] **Red:** Add `installed_synthetic_package_projects_definition_without_static_registration`. Assert manifest, config schema, capability preference schemas, presentation, endpoints, credential slots, auth-policy binding, and capability path authority come from a verified package.
- [ ] **Green:** Add three closed path declarations to package manifests: `exact`; `bounded-prefix-suffix` with the current ASCII/length segment constraints used by Google Cloud RPC paths; and `instance-configured-relative-path`, whose exact normalized value is resolved from host-validated instance config and must equal the guest request. Reject arbitrary regex, absolute URLs, traversal, undeclared fields, and capability/endpoint widening.
- [ ] **Green:** Refactor `ServiceIntegrationRegistry` to keep `package_definitions` and `legacy_compatibility_registrations` separately. The same plugin ID may exist in both origins: package definition wins for catalog/create; legacy registration remains addressable only for existing bundled rows and compatibility display. Duplicate IDs within one origin remain errors.
- [ ] **Green:** Build generic config/preference adapters from verified schemas. Resolve auth bindings only through the closed host auth-policy registry; package metadata never defines executable auth logic.
- [ ] **Red:** Add `synthetic_package_first_create_needs_no_plugin_id_branch` through `ServiceIntegrationService::save` and a paired existing-bundled-row case using the same plugin ID.
- [ ] **Green:** Resolve package-derived definitions and authorized defaults generically while routing an existing bundled row through its compatibility registration until migration.
- [ ] **Red:** Add table coverage for Google Web exact/instance-configured proxy paths, Edge TTS exact paths, and Google Cloud exact plus bounded-prefix-suffix RPC paths matching their current host constraints.
- [ ] **Green:** Update current service manifests and remove equivalent plugin-ID path decisions only after the package rules are active.
- [ ] Missing package content preserves an unresolved definition and never executes code.

**Validation:**

- Run: `mise run test installed_synthetic_package_projects_definition_without_static_registration -- --nocapture`
- Run: `mise run test synthetic_package_first_create_needs_no_plugin_id_branch -- --nocapture`
- Run: `mise run test installed_package_path_authority_matches_current_service_constraints -- --nocapture`
- Run: `mise run plugin:conformance all`
- Expected: synthetic installed service needs no shared source change.

### Task 4: Keep every current active row package-backed

**Seam:** existing lifecycle preview/apply/rollback methods

**Outcome:** Every existing Google integration and provider adapter becomes package-backed before the legacy executors are removed; row identities, credentials, and defaults are preserved.

**Files:**

- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs`
- Modify: `src-tauri/src/domain/legacy_runtime_inventory.rs`
- Modify: `src/features/plugins/LegacyRuntimeRetirementPanel.tsx`
- Modify: `src/features/plugins/LegacyRuntimeRetirementPanel.test.tsx`
- Test: existing integration/provider lifecycle tests

**Steps:**

- [ ] **Red:** Add `legacy_inventory_reports_exact_replacement_and_rollback_readiness_for_every_slice`. Include Google Web, Edge TTS, Google Cloud, five provider adapters, and PaddleOCR visibility without marking PaddleOCR retired.
- [ ] **Green:** Derive replacement digest, authorization status, package-first readiness, rollback readiness, dependencies, and CAS token from authoritative state.
- [ ] **Red:** Add frontend coverage that migration delegates integration rows to runtime upgrade and provider rows to runtime interface attach; stale or failed actions leave the row visible.
- [ ] **Green:** Reuse existing lifecycle commands. Do not add startup auto-migration or a second mutation service.
- [ ] Preserve subject IDs, model/profile references, credential refs, config, preferences, sort order, defaults, and history.
- [ ] **Red:** Add `package_first_ready_provider_adapters_close_legacy_create_before_stable_evidence` for OpenAI Compatible, OpenAI Responses, Anthropic, Gemini, and DeepSeek.
- [ ] **Green:** Populate/refactor the provider creation-retirement scope when Gate A/B proves each exact authorized default. Creation retirement is independent from stable execution-removal evidence; an adapter without a ready default remains fail-closed/blocked, never silently legacy-created once its migration window opens.
- [ ] Apply the same Gate A/B creation policy to PaddleOCR when its explicit migration window opens; keep its execution removal blocked until Gate E/F.
- [ ] Runtime failure after migration never triggers same-request legacy replay.

**Validation:**

- Run: `mise run test legacy_inventory_reports_exact_replacement_and_rollback_readiness_for_every_slice -- --nocapture`
- Run: `bun test src/features/plugins/LegacyRuntimeRetirementPanel.test.tsx`
- Run: `mise run test runtime_lifecycle -- --nocapture`
- Run: `mise run test package_first_ready_provider_adapters_close_legacy_create_before_stable_evidence -- --nocapture`
- Run: `mise run test runtime_provider -- --nocapture`
- Expected: migrated and unmigrated rows coexist safely.

### Task 5: Implement unsigned package support during the dual-stack window

**Seam:** the approved seams in `docs/plans/2026-08-21-unsigned-plugin-install-plan.md`

**Outcome:** Advanced users can install exact-digest-approved unsigned Wasm and allowlisted native packages without weakening official vendor bootstrap or execution grants.

**Files:**

- Implement: all files and Tasks 1-12 in `docs/plans/2026-08-21-unsigned-plugin-install-plan.md`

**Steps:**

- [ ] Execute that plan in order, including migration `0031`.
- [ ] Keep official migration/default packages vendor-signed.
- [ ] Keep invalid signatures as hard failures.
- [ ] Keep vendor bootstrap signed-only.
- [ ] Keep PaddleOCR outside retirement scope until Gate E and Gate F pass.

**Validation:**

- Run all targeted commands from the unsigned plan.
- Run: `mise run plugin:conformance all`
- Run: `mise run test`
- Run: `mise run test-frontend`
- Expected: unsigned support works, while signed production behavior remains unchanged.

### Task 6: Add host-owned Baidu client-credentials authority

**Seam:** `TokenGrantService` plus `wasm_runtime::NetworkBrokerHandle`

**Outcome:** A Baidu guest can request OCR network access, but only the host can read API key/secret and inject the access token.

**Files:**

- Create: `src-tauri/src/services/baidu_token_exchanger.rs`
- Modify: `src-tauri/src/services/auth_policies.rs`
- Modify: `src-tauri/src/services/token_grant.rs`
- Modify: `src-tauri/src/services/wasm_runtime/network_handle.rs`
- Modify: `src-tauri/src/services/wasm_runtime/host.rs`
- Modify: `src-tauri/src/services/network_broker.rs`
- Modify: `src-tauri/src/services/runtime_plugin_contracts.rs`
- Modify: `src-tauri/src/services/service_integrations.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/state.rs`
- Test: token grant, Wasm network handle/host, service validation, and network broker tests

**Steps:**

- [ ] **Red:** Add `baidu_auth_policy_injects_access_token_without_guest_secret_access` through a real `NetworkBrokerHandle` request. Assert the guest sees neither API key, secret key, credential ref, nor access token.
- [ ] **Green:** Introduce a closed `TokenExchanger` registry keyed by auth-driver ID and `TokenInjectionKind::{BearerHeader, QueryParameter { name }}`. Keep Google as Bearer and add Baidu client credentials with fixed query name `access_token`; do not force Google-style scopes on the Baidu driver.
- [ ] **Green:** Add `BaiduTokenExchanger` and construct the registry in `state.rs`. Resolve the two existing vault refs only through instance credential slots.
- [ ] **Red:** Add `baidu_access_token_query_is_host_only` through `wasm_runtime::NetworkBrokerHandle`. Reject guest-provided `access_token`, wrong token endpoint, wrong OCR origin, wrong capability, wrong slot, and cross-instance reuse before secret lookup or OCR transport.
- [ ] **Green:** Keep `host.rs` credential-like query rejection unchanged for guest input. Apply typed host token injection in `network_handle.rs` only after guest query/path/header validation and exact grant lookup.
- [ ] **Red:** Add `ocr_only_remote_integration_validation_uses_declared_capability`.
- [ ] **Green:** Make `ServiceIntegrationService::validate_instance` select a declared remote capability from the package definition instead of hard-coding `translate.text@1`; record readiness/health for the selected capability.
- [ ] Preserve redirect denial, request/response bounds, cancellation, and secret redaction.

**Validation:**

- Run: `mise run test baidu_auth_policy_injects_access_token_without_guest_secret_access -- --nocapture`
- Run: `mise run test baidu_access_token_query_is_host_only -- --nocapture`
- Run: `mise run test ocr_only_remote_integration_validation_uses_declared_capability -- --nocapture`
- Run: `mise run test token_grant -- --nocapture`
- Run: `mise run test network_handle -- --nocapture`
- Expected: the actual Wasm broker path performs exact host-only injection and OCR-only validation becomes Ready.

### Task 7: Build the Baidu OCR Wasm package

**Seam:** `OcrServiceService::recognize` through `RuntimeRouter`

**Outcome:** A signed Baidu package implements the current four OCR actions through `ocr.image@1` and produces current normalized results.

**Files:**

- Create: `runtime-plugins/baidu-ocr/plugin.json`
- Create: `runtime-plugins/baidu-ocr/ocr/`
- Create: `runtime-plugins/baidu-ocr/schemas/`
- Create: `runtime-plugins/baidu-ocr/tests/`
- Create: `.mise/tasks/plugin/build-baidu-ocr`
- Create: `.mise/tasks/plugin/refresh-baidu-ocr-fixture`
- Modify: `.mise/tasks/plugin/conformance`
- Modify: `.mise/tasks/plugin/check-no-wasi`
- Create: `src-tauri/src/services/baidu_ocr_runtime_tests.rs`
- Modify: `src-tauri/src/bin/plugin_release_tool.rs`
- Modify: `.mise/tasks/plugin/verify-release-bundle`
- Modify: `src-tauri/src/state.rs`
- Modify: unsigned package reserved first-party ID policy introduced by `docs/plans/2026-08-21-unsigned-plugin-install-plan.md`

**Steps:**

- [ ] **Red:** Add `baidu_ocr_runtime_component_matches_current_actions_and_errors` using fixed token, request, response, malformed-body, provider-error, cancellation, and oversized-image fixtures.
- [ ] **Green:** Implement `com.langnext.baidu-ocr` with `ocr.image@1`, fixed Baidu endpoints, two credential slots, and the closed host auth policy.
- [ ] Port only request form construction, action path selection, response parsing, and provider error mapping into the guest.
- [ ] Keep image Blob ownership, credentials, token exchange, network, timeout, cancellation, and health in the host.
- [ ] Add deterministic staging, dev fixture signing, no-WASI checks, and fail-closed conformance registration.
- [ ] Add `com.langnext.baidu-ocr` to `plugin_release_tool`, `.mise/tasks/plugin/verify-release-bundle`, `src-tauri/src/state.rs` package prefix/environment discovery, and generated default policy requirements.
- [ ] Add the Baidu ID to the unsigned plan's reserved first-party Wasm ID set before exposing the official package; valid user-signed behavior follows the policy chosen there, but unsigned content cannot claim the official ID.

**Validation:**

- Run: `mise run plugin:build-baidu-ocr`
- Run: `mise run plugin:conformance baidu-ocr`
- Run: `mise run test baidu_ocr_runtime_component_matches_current_actions_and_errors -- --nocapture`
- Expected: package behavior matches the current contract without guest access to secrets.

### Task 8: Migrate Baidu OCR rows without changing OCR identity

**Seam:** new Baidu migration preview/apply/rollback commands

**Outcome:** Existing Baidu OCR rows become package-capability rows while preserving OCR service identity, default selection, order, and vault references.

**Files:**

- Create: `src-tauri/migrations/0032_baidu_ocr_runtime_migration.sql`
- Create: `src-tauri/src/domain/baidu_ocr_migration.rs`
- Create: `src-tauri/src/repositories/baidu_ocr_migration.rs`
- Create: `src-tauri/src/services/baidu_ocr_migration.rs`
- Create: `src-tauri/src/cmds/baidu_ocr_migration.rs`
- Modify: `src-tauri/src/repositories/ocr_services.rs`
- Modify: `src-tauri/src/repositories/integration_credential_bindings.rs`
- Modify: `src-tauri/src/services/import_export.rs`
- Modify: `src-tauri/src/services/import_validation.rs`
- Modify: `src-tauri/src/storage/migrations.rs`
- Modify: `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/cmds/mod.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json`
- Modify: `src/storage/types.ts`, `src/storage/client.ts`
- Modify: `src/features/ocr/OcrServiceEditor.tsx`, `src/features/ocr/recognizeOcrFlow.ts`
- Test: `src-tauri/src/services/baidu_ocr_migration.rs`, `src-tauri/src/storage/tests.rs`, and `src/features/ocr/recognizeOcrFlow.test.ts`

**Steps:**

- [ ] **Red:** Add `baidu_migration_schema_advances_31_to_32_without_touching_rows`; register 0032 in `MIGRATIONS`, update latest-version assertions, and prove migration remains a schema-only prerequisite until explicit apply.
- [ ] **Green:** Register all new domain/repository/service/command modules and preserve command/AppManifest/ACL parity.
- [ ] **Red:** Add `baidu_migration_preview_is_read_only_and_exact_digest_bound` through the command/service seam.
- [ ] **Green:** Preview the exact authorized Baidu package, action mapping, credential-slot mapping, OCR row CAS token, and rollback identity without reading secret bytes.
- [ ] **Red:** Add `baidu_migration_preserves_service_id_default_order_and_vault_refs`.
- [ ] **Green:** In one transaction, create the package-backed integration, bind existing opaque vault refs to API-key/secret-key slots, switch the OCR row to `plugin_capability`, and preserve OCR service ID, enabled state, sort order, timestamps, and app default.
- [ ] **Red:** Add crash/stale/dependency table tests for apply and rollback.
- [ ] **Green:** Persist durable intent and identity-only rollback snapshot; recover or fail closed without duplicating integrations or credentials.
- [ ] Import/export preserves old Baidu rows and new package requirements but never exports package bytes, credential refs, grants, or risk approval.

**Validation:**

- Run: `mise run test baidu_migration_schema_advances_31_to_32_without_touching_rows -- --nocapture`
- Run: `mise run test baidu_migration_preview_is_read_only_and_exact_digest_bound -- --nocapture`
- Run: `mise run test baidu_migration_preserves_service_id_default_order_and_vault_refs -- --nocapture`
- Run: `mise run test runtime_plugin_import -- --nocapture`
- Run: `bun test src/features/ocr/recognizeOcrFlow.test.ts`
- Expected: Baidu rows migrate and roll back without identity or secret changes.

### Task 9: Record enforceable stable dual-stack release evidence

**Seam:** `LegacyRuntimeInventoryService::list_inventory`

**Outcome:** CANCELLED — no stable dual-stack release evidence is recorded for an unpublished app. This task and its release-evidence resource are removed; executor removal is unconditional.

**Files:**

- Create: `src-tauri/resources/plugins/retirement-release-evidence.json`
- Create: `src-tauri/src/domain/retirement_release_evidence.rs`
- Create: `src-tauri/src/services/retirement_release_evidence.rs`
- Modify: `src-tauri/src/services/legacy_runtime_retirement.rs`
- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs`
- Modify: `src-tauri/src/state.rs`
- Test: `src-tauri/src/services/legacy_runtime_inventory.rs`

**Steps:**

- [ ] **Red:** Add `retirement_requires_live_readiness_and_prior_stable_release_evidence`. Table-test missing evidence, current-release-only evidence, wrong package digest, stale policy digest, enabled legacy row, pending activation, unavailable activation, and fully ready prior-release evidence.
- [ ] **Green:** Load a deny-unknown evidence resource. Bind each executor/adapter to application release, exact package digest, publisher identity, policy digest, and prior stable release.
- [ ] Keep creation retirement separate: once Gate A/B proves an authorized package-first path, new legacy creation remains closed even when stable evidence is absent. Missing or invalid evidence disables only bundled execution removal and final code deletion for that slice.
- [ ] Extend inventory with PaddleOCR and Baidu legacy slices. Keep provider evidence per adapter.
- [ ] Do not infer stable evidence from test success, commit history, or package installation alone.
- [ ] Release owner populates the resource only after an actual dual-stack release passes migration, restart, import/recovery, and package rollback smoke checks.

**Validation:**

- Run: `mise run test retirement_requires_live_readiness_and_prior_stable_release_evidence -- --nocapture`
- Run: `mise run test legacy_runtime_inventory -- --nocapture`
- Expected now: execution removal/final deletion remains blocked because evidence is empty; package-first creation gates do not reopen legacy creation.

### Task 10: Retire Bundled Rust integrations

**Seam:** `RuntimeRouter::resolve`

**Outcome:** Google Web, Edge TTS, Google Cloud, and the PaddleOCR bundled placeholder are deleted; only package adapters execute.

**Files:**

- Modify/delete by slice: `src-tauri/src/services/google_translate_web.rs`
- Modify/delete by slice: `src-tauri/src/services/edge_tts.rs`
- Modify/delete by capability: `src-tauri/src/services/google_cloud.rs`
- Modify: `src-tauri/src/services/bundled_plugins.rs`
- Modify: `src-tauri/src/services/service_capabilities.rs`
- Modify: `src-tauri/src/services/runtime_router.rs`
- Modify: `src-tauri/src/services/service_integration_registry.rs`
- Modify: `src-tauri/src/services/service_integrations.rs`
- Test: corresponding runtime package and import compatibility suites

**Steps:**

For each ordered slice—Google Web, Edge TTS, Google Cloud capabilities, then PaddleOCR placeholder:

- [ ] **Red:** Add `package_only_<slice>_rejects_bundled_resolution_after_evidence_gate` and a paired enabled-legacy-row veto case.
- [ ] **Green:** Remove only that slice's handler construction, registration, and concrete protocol transport.
- [ ] Preserve package definition projection, host auth policies, broker policy, typed capability contracts, old import readers, unresolved display, and package rollback.
- [ ] A package runtime failure returns an error; it never executes removed bundled code.
- [ ] Run the slice validation and package smoke test before the next executor.

**Validation:**

- Run: `mise run test google_translate_web_runtime -- --nocapture`
- Run: `mise run test edge_tts_runtime -- --nocapture`
- Run: `mise run test google_cloud_runtime -- --nocapture`
- Run: `mise run test paddleocr_runtime -- --nocapture`
- Expected: only package adapters execute; old imports remain readable.

### Task 11: Retire TypeScript provider executors

**Seam:** `resolveProviderExecutor`

**Outcome:** Every provider adapter executes only through its runtime package; the shared legacy executor is deleted.

**Files:**

- Delete by adapter after its gate: `src/features/providers/builtin/openaiCompatible.ts`
- Delete: `src/features/providers/builtin/openaiResponses.ts`
- Delete: `src/features/providers/builtin/anthropic.ts`
- Delete: `src/features/providers/builtin/gemini.ts`
- Delete: `src/features/providers/builtin/deepseek.ts`
- Modify: `src/features/providers/builtin/index.ts`
- Modify/delete after final adapter: `src/features/providers/executor.ts`, `registry.ts`, `types.ts`
- Preserve: runtime package protocol fixtures and host workflow tests

**Steps:**

For OpenAI Compatible, OpenAI Responses, Anthropic, Gemini, then DeepSeek:

- [ ] **Red:** Add `package_only_<adapter>_never_selects_legacy_executor` through connection, models, unary chat, stream, cancellation, translation, detection, and AI OCR workflows as applicable.
- [ ] **Green:** Remove that adapter registration and TypeScript protocol implementation only after its evidence/inventory gate passes.
- [ ] Move or retain authoritative protocol fixtures under `runtime-plugins/<adapter>/`.
- [ ] Preserve provider/model/profile UUIDs, custom endpoint rules, history, fallback, cancellation, and missing-provider visibility.
- [ ] Delete `LegacyFrontendProviderExecutor` and static registry only after the fifth adapter retires.

**Validation:**

- Run: `mise run plugin:conformance llm`
- Run: `bun test src/features/providers src/features/models src/features/translate src/features/ocr`
- Expected: no product workflow calls `provider_http_*` for retired adapters.

### Task 12: Retire direct Baidu REST

**Seam:** `OcrServiceService::recognize`

**Outcome:** Baidu OCR executes only through the `com.langnext.baidu-ocr` package capability; direct REST and the static Baidu OCR create path are deleted.

**Files:**

- Modify: `src-tauri/src/services/ocr_services.rs`
- Modify: `src-tauri/src/domain/ocr_service.rs`
- Modify: `src-tauri/src/cmds/ocr_services.rs`
- Modify: `src/features/ocr/ocrProviderOptions.ts`
- Modify/delete: `src/features/ocr/BaiduOcrForm.tsx`
- Modify: `src/features/ocr/OcrServiceEditor.tsx`
- Modify: `src/features/ocr/recognizeOcrFlow.ts`
- Preserve: import and migration compatibility readers/fixtures

**Steps:**

- [ ] **Red:** Add `package_only_baidu_ocr_never_calls_direct_rest`. Cover migrated package rows, unmigrated enabled rows, disabled rows, missing package, package failure, and cancellation.
- [ ] **Green:** Remove `fetch_baidu_access_token`, direct Baidu OCR HTTP request construction, and static new-Baidu creation.
- [ ] Unmigrated rows become visible `migration_required`/unresolved rows. Do not auto-delete or auto-migrate.
- [ ] Keep old export readers and rollback snapshot readers through the documented compatibility window.
- [ ] Package failure never replays through direct REST.

**Validation:**

- Run: `mise run test package_only_baidu_ocr_never_calls_direct_rest -- --nocapture`
- Run: `mise run test baidu_ocr_runtime -- --nocapture`
- Run: `bun test src/features/ocr`
- Expected: no production Baidu request originates outside the runtime broker path.

### Task 13: Remove final static registration and compatibility execution seams

**Seam:** `ServiceIntegrationService::list_definitions`, `RuntimeRouter::resolve`, and `resolveProviderExecutor`

**Outcome:** Installed package metadata defines service plugins, and all production execution is package-backed.

**Files:**

- Modify/delete: `src-tauri/src/services/bundled_plugins.rs`
- Modify: `src-tauri/src/services/service_integration_registry.rs`
- Modify: `src-tauri/src/services/service_integrations.rs`
- Modify: `src-tauri/src/services/runtime_router.rs`
- Modify/delete: `src/features/providers/executor.ts`, `registry.ts`, `builtin/index.ts`
- Modify: `src/features/ocr/ocrProviderOptions.ts`
- Modify: architecture and runtime plugin documentation

**Steps:**

- [ ] **Red:** Add a synthetic installed service/provider fixture proving no shared source change is needed for known capability contracts.
- [ ] **Green:** Remove retired concrete registrations, handler factories, provider registry aliases, label/icon heuristics, and plugin-specific creation branches.
- [ ] Keep closed capability IDs, auth policy IDs, WIT worlds, schema validators, broker permissions, resource limits, and security boundaries.
- [ ] Remove concrete config types only when no import/migration reader still needs them.
- [ ] Add grep gates for production symbols and explicitly allow only documented compatibility readers.

**Validation:**

```bash
rg -n "GoogleCloudCapabilities|GoogleTranslateWebCapabilities|EdgeTtsCapabilities|LegacyFrontendProviderExecutor|PreparedOcr::Baidu|fetch_baidu_access_token" src src-tauri/src --glob "!**/*.test.*"
```

Expected: no production executor reference remains; documented compatibility readers are the only allowed old-format symbols.

## Final Validation

Run targeted release and conformance checks:

```bash
mise run plugin:verify-release-bundle
mise run plugin:conformance all
mise run test legacy_runtime_inventory -- --nocapture
mise run test runtime_plugin_import -- --nocapture
```

Run full project validation:

```bash
mise run test
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run build
mise run tauri:build
```

Manual release smoke:

1. Start from a clean profile.
2. Verify all official signed packages and defaults bootstrap.
3. Create each service/provider package-first.
4. Migrate one legacy row per executor and verify IDs/dependencies remain unchanged.
5. Restart and verify recovery.
6. Roll back each migrated row during the dual-stack release.
7. Migrate and roll back one Baidu OCR row without re-entering credentials.
8. Execute Translation, Detect, OCR, Speech, model sync, chat, stream, cancellation, fallback, and history flows.
9. Record release evidence only after the stable release is accepted.
10. After final retirement, verify package rollback works and no same-request legacy replay exists.

Expected final state:

- the release bundle contains every required signed package and exact policy;
- official new instances are package-first;
- all active existing rows are package-backed;
- no Bundled Rust, TypeScript provider protocol, or direct Baidu REST execution remains;
- unresolved legacy data remains readable, exportable, disableable, migratable, or deletable;
- package regressions use package rollback, not removed host executors.

## Failure Behavior

- Missing release package/root/policy — fail release verification; do not claim production readiness.
- Stale or mismatched default policy — keep package visible but block package-first activation.
- Package-first create without an authorized default — reject the create; no bundled-rust row is ever written.
- Runtime resolution without an eligible package — return a package error; never replay through removed legacy code.
- Baidu token exchange failure — do not send OCR request; expose a sanitized error.
- Package regression after host executor deletion — use retained package version rollback.

## Privacy and Security

- Production private signing keys never enter the repository, application resources, developer build tasks, logs, or CI artifacts.
- API keys, secret keys, access tokens, credential refs, images, audio, provider bodies, and prompts do not enter guest-visible metadata, frontend IPC, logs, or export.
- Baidu `access_token` is host-injected after caller query validation and cannot be guest-provided.
- Package install approval remains distinct from instance/provider execution grants.
- Unsigned package approval establishes no publisher identity and cannot satisfy vendor bootstrap.
- Native workers remain allowlisted and unsandboxed; digest locks, handshake, module audit, model locks, cancellation, timeout, and process-tree cleanup remain mandatory.
- Removal never weakens broker, auth policy, grant, resource, schema, or import-security checks.

## Rollout Notes

1. **Preparation:** Tasks 1-3. Produce signed packages, public roots, exact policies, and package-derived definitions.
2. **Unsigned support:** Task 5. Implement unsigned advanced-user support.
3. **Baidu package + host auth:** Tasks 6-8. Ship the Baidu OCR package; OCR rows use it directly.
4. **Convergence:** Tasks 10-13. Remove Bundled Rust, TypeScript provider executors, direct Baidu REST, the PaddleOCR placeholder, and the retirement/evidence machinery.
5. SQLite migrations are forward-only. Binary rollback is not the primary rollback mechanism.
6. Keep at least one known-good prior package version available for package rollback.

## Risks and Mitigations

- **Current production gate names integrations before resources are present.** — Treat Gate A as a release blocker; release scope is the verified signed package catalog.
- **Removing executors could remove the fallback path.** — There is no fallback: package runtime failures surface as package errors, and package rollback restores a prior package version.
- **Unsigned support could weaken official bootstrap.** — Keep vendor bootstrap signed-only and official defaults signed.
- **Package-derived definitions could widen authority.** — Project only verified manifest/schema data and keep auth policy/capability contracts closed.
- **Old imports can recreate unsupported state.** — Import requirements never activate; package-only schemas reject legacy-only shapes.

## Decisions

- The application is unpublished and package-only: no legacy users, legacy runtimes, legacy data, or old export formats are supported.
- Stable dual-stack release evidence (Gate E/F) and release-owner approval are cancelled.
- Package version rollback remains available through installation snapshots; legacy executor rollback does not exist.
- SQLite migrations 0001-0032 remain untouched; migration 0033 performs the package-only cleanup.
