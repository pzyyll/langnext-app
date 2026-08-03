# Multi-Interface Provider Runtime Implementation Plan

**Goal:** Allow one Provider to use multiple explicitly approved runtime-plugin API types while preserving existing legacy API types and host-owned transport, authentication, cancellation, fallback, history, and privacy boundaries.

**Inputs:**

- User requirement: “插件提供新接口类型，同一 Provider 中可以使用多个插件提供的接口类型”.
- `docs/plans/runtime-plugin-system/phase-8-llm-provider-plugins.md`.
- Current Phase 8 implementation in `src-tauri/src/services/{runtime_providers,provider_runtime_router,provider_runtime_broker,models}.rs` and `src/features/providers/{executor,runtimeExecutor}.ts`.
- Frozen WIT v1 in `src-tauri/wit/runtime-plugin/`.

**Assumptions:**

- An API type is the persisted effective adapter ID: `model.adapterId ?? model.sourceAdapterId ?? provider.adapterId`.
- One Provider has one host-owned connection and credential, but can explicitly approve several package bindings; every binding grants that package access to that Provider’s connection only.
- One active binding owns one API type per Provider. Two packages may not claim the same active API type on the same Provider; attachment fails closed on that ambiguity. One package may serve several of its declared aliases on that Provider, but every alias keeps an independent adapter-keyed binding row and shares only that exact Provider/package grant.
- Installing a package does not authorize it for every Provider. Vendor default attachment remains limited to a new matching Provider’s default API type; every additional interface requires Preview → permission acknowledgement → Apply.
- An API type without an active runtime binding continues through the existing legacy executor and compatibility checks. A request that has selected a runtime binding never retries through legacy after a runtime failure.
- Remote model discovery is explicit per API type. `source_adapter_id` is a non-null database discriminator (`""` only for manual/builtin rows) so SQLite uniqueness is deterministic; DTOs expose the empty sentinel as `null`.
- Migration 0025 expands a v24 active binding only to the Provider default/model effective API types that are actually present and verified as declared aliases in its installed manifest. For an unavailable/missing manifest—or any effective type without positive alias evidence—the migration creates a per-type unavailable requirement requiring explicit review; it never guesses an active route or silently sends that model to legacy.
- A v24 provider-scoped rollback snapshot migrates to a snapshot set: a parent preserves the historic snapshot ID and scope, and atomically restores its adapter-keyed child bindings. Migrated v24 snapshots retain Provider-wide rollback scope; snapshots created after migration are adapter-scoped. Existing package/grant references remain retained until the last active binding and undiscarded snapshot-set child releases them.
- Export format advances from v7 to v8 because v7’s singular provider runtime requirement cannot represent multiple independently unavailable requirements. A v7 import has no alias selection, so it creates unavailable requirements for every persisted effective API type (Provider default plus model overrides) rather than dropping non-default model routes. Users explicitly reattach each verified interface. The v2–v7 normalizers remain lossless for fields they contain and normalize to v8.

**Architecture:** The control plane changes from a single Provider runtime pin to a set of `ProviderRuntimeInterfaceBinding` records keyed by `(provider_id, adapter_id)`. Every record names one exact signed package and its Provider-scoped grant revision. The backend derives the effective API type from a persisted model or validated models-list request, resolves the exact binding server-side, revalidates the package and grant, and creates a host-only `ProviderRuntimeBrokerContext` from that binding. The broker factory receives that context and re-reads the same `(provider_id, adapter_id, package_digest, grant_revision)` record before vault lookup; the adapter key never crosses IPC as package authority or changes frozen WIT v1. The frontend selects the executor per model: a matching active interface binding selects `RuntimeProviderExecutor`; an unbound type retains `LegacyFrontendProviderExecutor`.

**Tech Stack:** Rust, SQLite/rusqlite migrations, Tauri 2 typed IPC, Wasmtime Component Model, frozen WIT v1, React 19, TanStack Query, Effect, Base UI, Tailwind CSS v4, Bun, mise.

---

## File Map

- Create: `src-tauri/migrations/0025_provider_runtime_interface_bindings.sql` — migrate the singular Provider binding model to adapter-keyed interface bindings, preserve IDs through provider-scoped snapshot sets, and add source API type provenance for remote models.
- Modify: `src-tauri/src/storage/migrations.rs` — register migration 0025 and migration-fixture coverage.
- Modify: `src-tauri/src/domain/runtime_provider.rs` — add sanitized interface-binding, lifecycle-preview, and route DTOs; make lifecycle results identify the affected API type.
- Modify: `src-tauri/src/domain/provider.rs` — expose `runtime_bindings` on Provider DTOs and export the v8 multi-requirement representation.
- Modify: `src-tauri/src/domain/model.rs` — add persisted `source_adapter_id` and define effective adapter resolution.
- Modify: `src-tauri/src/repositories/provider_runtime_bindings.rs` — query, insert, CAS-update, list, snapshot-set, and delete bindings by `(provider_id, adapter_id)`.
- Modify: `src-tauri/src/repositories/provider_models.rs` — persist and merge remote models per source API type without cross-type `missing` writes.
- Modify: `src-tauri/src/repositories/provider_instances.rs` — hydrate Provider rows with a binding collection rather than a singular binding.
- Modify: `src-tauri/src/services/providers.rs` — create a legacy default binding plus an optional vendor-default binding only for the Provider default API type.
- Modify: `src-tauri/src/services/runtime_providers.rs` — implement interface attach/replace/rollback/detach previews, alias-conflict checks, per-interface grant lifecycle, and vendor-default attachment.
- Modify: `src-tauri/src/services/provider_runtime_router.rs` — resolve runtime packages from a persisted Provider/model API type, not a singular Provider pin.
- Modify: `src-tauri/src/services/provider_runtime_broker.rs` — add host-only `ProviderRuntimeBrokerContext` and authorize against the exact `(provider_id, adapter_id, package_digest, grant_revision)` binding before credential lookup.
- Modify: `src-tauri/src/services/plugin_store.rs` — prevent package removal while any active interface binding or undiscarded interface snapshot still references it.
- Modify: `src-tauri/src/services/models.rs` — remove global mismatch rejection; validate/execute sync by selected interface and persist discovery provenance.
- Modify: `src-tauri/src/cmds/runtime_providers.rs` and `src-tauri/src/cmds/models.rs` — expose adapter-aware lifecycle, models-list, chat, and sync contracts.
- Modify: `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json`, and `src-tauri/src/storage/tests.rs` — register/review every added interface-lifecycle command and assert ACL/invoke-handler parity.
- Modify: `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/import_validation.rs`, and `src-tauri/src/domain/import_export.rs` — add v8 normalization, multi-runtime requirement import/export, and secret-free validation.
- Modify: `src-tauri/src/services/runtime_provider_tests.rs` — add migration, lifecycle, routing, grant, cancellation, privacy, and rollback integration coverage.
- Modify: `src-tauri/src/services/import_export_tests.rs` or the existing inline import/export test modules — cover v7→v8 normalization and multi-interface unavailable imports.
- Modify: `src/storage/types.ts` and `src/storage/client.ts` — represent binding collections and adapter-aware IPC payloads.
- Modify: `src/features/providers/executor.ts` and `src/features/providers/runtimeExecutor.ts` — select executor by effective API type and pass model identity/API type through IPC without trusting a caller-supplied package digest.
- Modify: `src/features/models/adapterOptions.ts`, `AddManualModelDialog.tsx`, and `EditModelConfigDialog.tsx` — show attached runtime API types alongside legacy types and explain inactive/unavailable states.
- Modify: `src/features/models/ProviderEditor.tsx`, `providerConnection.ts`, and `providerModelSync.ts` — manage multiple attached interfaces and test/sync a selected API type.
- Modify: `src/features/translate/translationContext.ts`, `translationWorkflow.test.ts`, `detectLanguageFlow.ts`, `detectLanguageFlow.test.ts`, `src/features/ocr/recognizeOcrFlow.ts`, and `recognizeOcrFlow.test.ts` — route each selected model through its effective API type and preserve cancellation/history semantics.
- Modify: `src/features/providers/attachRequestCancellation.test.ts` and runtime executor tests as needed — assert no same-request legacy retry after a runtime dispatch begins.
- Modify: `docs/plans/runtime-plugin-system/phase-8-llm-provider-plugins.md` — supersede the singular Provider package-pin assumption and document the multi-interface control plane.
- Modify: `.mise/tasks/smoke/runtime-providers` — add an explicit two-interface, one-Provider walkthrough after the unit/integration contract exists.

## Seams

Confirm these public seams before implementation and tests:

- **Seam:** `ProviderService::get` / `list` Provider DTO contract — a Provider exposes zero or more sanitized runtime interface bindings without secrets, grants, package bytes, or credential references.
- **Seam:** `preview_provider_runtime_interface_attach` → `apply_provider_runtime_interface_attach` — a user can approve two distinct API types from two signed packages for one Provider; duplicate API types fail before any grant or binding write.
- **Seam:** `provider_runtime_models_list` — a selected API type resolves exactly one active interface binding and produces a per-type remote model snapshot.
- **Seam:** `provider_runtime_chat` — a persisted Provider model determines the API type/binding server-side; the request cannot select another package, Provider, grant, or credential.
- **Seam:** `resolveProviderExecutor` — matching attached types use runtime; unbound legacy types remain executable through legacy; a runtime failure does not replay via legacy.
- **Seam:** Provider Editor/model configuration UI — attached runtime API types are discoverable and selectable, while unavailable/ambiguous types cannot be silently chosen.
- **Seam:** configuration export/import — v8 preserves all multi-interface requirements as unavailable identities, while excluding packages, grants, snapshots, paths, credential refs, and secrets.

## Tasks

### Task 1: Define adapter-keyed binding and model-discovery contracts

**Seam:** `ProviderService::get` / `list` Provider DTO contract.

**Outcome:** Provider DTOs contain an ordered, sanitized `runtimeBindings` collection; remote models retain a `sourceAdapterId` that distinguishes discovery origins from user overrides; and migrated Provider-wide rollback snapshots become atomic binding snapshot sets.

**Files:**

- Create: `src-tauri/migrations/0025_provider_runtime_interface_bindings.sql`
- Modify: `src-tauri/src/storage/migrations.rs`
- Modify: `src-tauri/src/domain/runtime_provider.rs`
- Modify: `src-tauri/src/domain/provider.rs`
- Modify: `src-tauri/src/domain/model.rs`
- Modify: `src-tauri/src/repositories/provider_runtime_bindings.rs`
- Modify: `src-tauri/src/repositories/provider_models.rs`
- Modify: `src-tauri/src/repositories/provider_instances.rs`
- Modify: `src/storage/types.ts`
- Test: `src-tauri/src/services/runtime_provider_tests.rs`

**Steps:**

- [ ] **Red:** Add public Provider-service migration tests from v24 fixtures covering: a legacy Provider; a Wasm Provider whose default and model override each match different declared aliases of one package; an unavailable/missing-manifest requirement with default and override types; a historical invalid default type not declared by the package; and legacy/Wasm rollback snapshots. Assert provider/model UUIDs, connection fields, model overrides, profile references, historic snapshot IDs, and valid runtime routes survive. Assert every effective type without positive alias evidence becomes a sanitized unavailable requirement rather than guessed active/legacy routing; assert no DTO surface contains a secret/ref/grant/package bytes.
- [ ] **Green:** Add migration 0025. Rebuild `provider_runtime_bindings` with `PRIMARY KEY (provider_id, adapter_id)`. Use SQLite `json_each` over the installed signed manifest’s `providerRuntime.legacyAliases` (covered by the migration fixture) to create active rows only for effective v24 API types that both existed and match the manifest; create unavailable rows for every other persisted default/override type. Preserve the shared exact grant revision for aliases of the same Provider/package.
- [ ] **Green:** Replace the singular snapshot table with `provider_runtime_snapshot_sets` (parent keeps each v24 snapshot ID, Provider ID, grant/package references, and `provider`/`adapter` scope) plus `provider_runtime_snapshot_bindings` children. Migrate every v24 snapshot as a Provider-scoped atomic set: legacy snapshots restore no active interface bindings; Wasm snapshots restore all positively evidenced alias rows and retain unavailable children where alias evidence is missing. New lifecycle snapshots are adapter-scoped. Update package-reference counting to include set children.
- [ ] **Green:** Add non-null `provider_models.source_adapter_id` (`""` sentinel for manual/builtin rows), backfill remote rows to the Provider default API type, and rebuild its unique key as `(provider_instance_id, model_key, source_adapter_id)` while preserving all model IDs and inbound profile references. Update lookups that formerly used only `(provider_id, model_key)` to require a source type or fail deterministically on ambiguity.
- [ ] **Green:** Add `ProviderRuntimeInterfaceBinding` / DTO types, `ProviderInstanceDto.runtime_bindings`, and deterministic ordering by adapter ID. Keep `runtime` as a deprecated compatibility projection of the Provider default API type until all frontend callers move; do not make it execution authority.
- [ ] **Green:** Implement repository APIs that fetch/list/update bindings by both Provider and adapter IDs. Missing non-default bindings mean legacy execution, not a synthetic Wasm binding.
- [ ] **Refactor:** Remove singular-binding-only repository callers after equivalent collection-based methods are covered.

**Validation:**

- Run (red): `mise run test provider_runtime_multi_interface_migration -- --nocapture`
- Expected: compilation/test failure because v24 data cannot expose multiple adapter-keyed binding/model origins.
- Run (green): `mise run test provider_runtime_multi_interface_migration -- --nocapture`
- Expected: test passes with UUID/reference preservation and sanitized DTO assertions.

### Task 2: Attach and manage independent interface packages

**Seam:** `preview_provider_runtime_interface_attach` → `apply_provider_runtime_interface_attach`.

**Outcome:** A Provider can independently approve, attach, inspect, replace, rollback, and detach multiple signed runtime packages, one unambiguous API type per binding.

**Files:**

- Modify: `src-tauri/src/domain/runtime_provider.rs`
- Modify: `src-tauri/src/services/runtime_providers.rs`
- Modify: `src-tauri/src/repositories/provider_runtime_bindings.rs`
- Modify: `src-tauri/src/repositories/plugin_permission_grants.rs`
- Modify: `src-tauri/src/services/plugin_store.rs`
- Modify: `src-tauri/src/cmds/runtime_providers.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json`, and `src-tauri/src/storage/tests.rs`
- Test: `src-tauri/src/services/runtime_provider_tests.rs`

**Steps:**

- [ ] **Red:** Add a lifecycle test that installs two separately signed LLM packages with distinct declared aliases (including one runtime-only alias absent from the TypeScript registry), creates one Provider, previews/applies both attachments, and observes two active bindings with independent exact grants. Attach one package’s second declared alias and assert it reuses the same Provider/package grant while retaining a separate adapter-keyed binding. Assert both packages can be attached to a second Provider with separate grants.
- [ ] **Red:** Add rejection cases: requested adapter is absent from the package declaration; a second package claims an already attached API type; package/publisher/artifact verification fails; acknowledgement is missing; stale preview CAS fails; and every rejection leaves bindings/grants/snapshots unchanged.
- [ ] **Red:** Add detach/rollback tests: detaching alias A does not remove a shared package grant while alias B remains active; discarding the final snapshot releases its retained grant; package uninstall remains denied while any active binding or undiscarded snapshot references it; and another Provider’s binding remains independent.
- [ ] **Green:** Add adapter-aware attach/replace/rollback/detach inputs and adapter-scoped snapshots. Preserve migrated v24 Provider-scoped snapshot-set rollback as an atomic whole-Provider restore rather than silently narrowing it to one type. Use compatibility wrappers for existing default-interface commands only until frontend callers migrate; register every new command in `generate_handler!`, `APP_COMMANDS`, reviewed permissions, and the trusted-app capability, then satisfy the ACL parity test.
- [ ] **Green:** Remove `ensure_package_not_bound_elsewhere`; reuse of the same verified package across Providers is safe because grants are scoped to `(provider_instance, package_digest, revision)`. Replace it with a Provider-local API-type collision check that rejects ambiguity.
- [ ] **Green:** Build/reuse exactly one grant bundle per active Provider/package. Alias rows for the same package share that grant revision; detach removes a grant only after no active alias row or undiscarded rollback snapshot references it. Extend package-uninstall reference checks accordingly. Require explicit acknowledgement for every added package because each gains access to the selected Provider’s host-owned egress identity.
- [ ] **Green:** Restrict vendor-default attachment to the new Provider’s default adapter type. It must not attach any package to existing Providers or to unrelated API types.

**Validation:**

- Run (red): `mise run test runtime_provider_can_attach_two_interface_packages -- --nocapture`
- Expected: test fails because the current single binding model rejects the second attachment.
- Run (green): `mise run test runtime_provider_can_attach_two_interface_packages -- --nocapture`
- Expected: both bindings/grants are active; collision, approval, CAS, and verification failures are atomic.

### Task 3: Resolve package authority from persisted API type

**Seam:** `provider_runtime_models_list` and `provider_runtime_chat`.

**Outcome:** The backend derives the target interface binding from persisted Provider/model data, then revalidates its exact package and grant before broker credential lookup.

**Files:**

- Modify: `src-tauri/src/domain/runtime_provider.rs`
- Modify: `src-tauri/src/services/provider_runtime_router.rs`
- Modify: `src-tauri/src/services/provider_runtime_broker.rs`
- Modify: `src-tauri/src/services/wasm_runtime/executor.rs`
- Modify: `src-tauri/src/cmds/runtime_providers.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/services/runtime_provider_tests.rs`

**Steps:**

- [ ] **Red:** Add an adapter-aware Models List test with one Provider and two active packages. Pass each approved adapter ID and assert the corresponding Component, fixture request shape, grant revision, and Provider credential are used; assert an unbound/ambiguous/unavailable adapter is rejected before vault lookup.
- [ ] **Red:** Add a Chat test passing `provider_model_id` rather than a caller-selected package. Store models for two adapters, invoke both, and assert the host derives the correct package from the persisted model. Attempt a model from another Provider and a forged adapter/package and assert `not_approved`/validation before transport.
- [ ] **Green:** Add `adapter_id` to models-list command input and `provider_model_id` to chat command input. Resolve effective adapter server-side using model override/source/default precedence; do not accept package digest or grant revision from IPC callers.
- [ ] **Green:** Make `ProviderRuntimeRouter::resolve` construct an immutable host-only `ProviderRuntimeBrokerContext` from `(provider_id, adapter_id, package_digest, grant_revision)` and pass it through the broker factory. `ProviderRuntimeBrokerHandle` re-reads that exact adapter-keyed binding after Component setup and before vault lookup; it must reject a stale/deleted alias even when another alias uses the same package/grant. Preserve host-only Base URL, proxy, auth scheme, vault lookup, bounded paths, Blob, stream, and cancellation rules.
- [ ] **Green:** Keep WIT v1 byte-for-byte unchanged. API-type dispatch remains host control-plane state, not a guest-controlled WIT field.

**Validation:**

- Run (red): `mise run test runtime_provider_routes_by_persisted_model_interface -- --nocapture`
- Expected: test fails because chat/models list resolve only the singular Provider binding.
- Run (green): `mise run test runtime_provider_routes_by_persisted_model_interface -- --nocapture`
- Expected: both interface packages execute only for their stored models; forged cross-provider/package attempts fail before transport/vault access.

### Task 4: Synchronize remote models independently per API type

**Seam:** adapter-aware `syncProviderModelsFrontend` → `apply_provider_model_sync`.

**Outcome:** Each API type can test its connection and synchronize models without marking models from another API type missing or overwriting its route.

**Files:**

- Modify: `src-tauri/src/domain/model.rs`
- Modify: `src-tauri/src/services/models.rs`
- Modify: `src-tauri/src/repositories/provider_models.rs`
- Modify: `src-tauri/src/cmds/models.rs`
- Modify: `src/features/models/providerConnection.ts`
- Modify: `src/features/models/providerModelSync.ts`
- Modify: `src/storage/client.ts`
- Test: `src-tauri/src/services/runtime_provider_tests.rs`
- Test: `src/features/models/providerModelSync.test.ts`
- Test: `src/features/models/providerConnection.test.ts`

**Steps:**

- [ ] **Red:** Add a backend sync test where interfaces A and B each return a model named identically and a distinct model. Sync A, then B; assert separate source records, routes, UUID stability, and that neither sync marks the other type’s remote models missing.
- [ ] **Red:** Add a frontend connection/sync test that selects a specific API type and proves the IPC request carries that type—not a package digest—and that stale connection CAS/error persistence remains per Provider connection as today.
- [ ] **Green:** Change remote sync merge identity to include non-null `source_adapter_id` (`""` only for manual/builtin). Persist the selected interface as the source type for new remote rows; preserve an explicit user `adapter_id` override separately. Update key lookups to reject ambiguity and limit `missing` transitions to rows whose source matches the completed sync type.
- [ ] **Green:** Define effective model API type as override → source type → Provider default. Preserve manual/builtin model behavior and existing profile references.
- [ ] **Green:** Add an explicit selected API type to connection-test and sync interfaces. Default the UI action to the Provider default API type; never silently aggregate multiple provider protocol responses into one snapshot.

**Validation:**

- Run (red): `mise run test runtime_provider_multi_interface_model_sync -- --nocapture && bun test --isolate src/features/models/providerModelSync.test.ts src/features/models/providerConnection.test.ts`
- Expected: tests fail because sync has one Provider-wide snapshot and one model-key identity.
- Run (green): same command.
- Expected: independent model snapshots survive with correct type routing and no cross-type `missing` state.

### Task 5: Make executor selection additive, not blocking

**Seam:** `resolveProviderExecutor`.

**Outcome:** An attached matching runtime API type uses the exact runtime executor; an unbound existing API type stays legacy; runtime failures never retry through legacy.

**Files:**

- Modify: `src/features/providers/executor.ts`
- Modify: `src/features/providers/runtimeExecutor.ts`
- Modify: `src/features/providers/registry.ts`
- Modify: `src/features/providers/types.ts`
- Modify: `src/storage/types.ts`
- Modify: `src/storage/client.ts`
- Test: `src/features/providers/runtimeExecutor.test.ts`
- Test: `src/features/providers/registry.test.ts`
- Test: `src/features/translate/translationWorkflow.test.ts`

**Steps:**

- [ ] **Red:** Add tests for one Provider with three models: runtime interface A, runtime interface B, and an existing legacy API type. Assert A/B construct runtime executors with their model identity; legacy constructs the previous executor; no mismatch error is thrown merely because another runtime interface is attached.
- [ ] **Red:** Add tests that an active unavailable binding fails closed, a runtime chat error advances only configured model fallback, and no same-request legacy transport runs after a runtime executor has been selected.
- [ ] **Green:** Replace singular `provider.runtime` package lookup with exact matching against `provider.runtimeBindings`. Pass model ID to runtime chat and selected adapter to runtime models list. Never pass a package digest as trusted frontend authority.
- [ ] **Green:** Remove the old `ProviderReconfigurationRequiredError` rule that rejects all model overrides under a singular active runtime package. Retain existing legacy endpoint/auth compatibility checks for models with no active matching runtime binding.
- [ ] **Green:** Treat duplicate/ambiguous binding IDs as unavailable rather than choosing the first catalog result.

**Validation:**

- Run (red): `bun test --isolate src/features/providers/runtimeExecutor.test.ts src/features/providers/registry.test.ts src/features/translate/translationWorkflow.test.ts`
- Expected: current resolver rejects API types B/legacy when A is bound.
- Run (green): same command.
- Expected: each model selects its intended executor; runtime failures retain no-legacy-replay behavior.

### Task 6: Expose attachable runtime API types in the Provider UI

**Seam:** Provider Editor, model API-type dialogs, and selected-interface sync controls.

**Outcome:** Users can review/attach multiple package interfaces to a Provider and configure models with those interfaces without encountering a misleading save-time mismatch.

**Files:**

- Modify: `src/features/models/ProviderEditor.tsx`
- Modify: `src/features/models/adapterOptions.ts`
- Modify: `src/features/models/AddManualModelDialog.tsx`
- Modify: `src/features/models/EditModelConfigDialog.tsx`
- Modify: `src/features/models/ModelsTable.tsx`
- Modify: `src/features/providers/runtimeProviderActions.ts`
- Modify: `src/features/providers/runtimeProviderPresentation.ts`
- Modify: `src/i18n/locales/en.ts` and the matching locale files
- Test: `src/features/models/ProviderEditor.test.tsx` or the existing focused UI test file
- Test: `src/features/models/EditModelConfigDialog.test.tsx` or the existing focused UI test file

**Steps:**

- [ ] **Red:** Add a component test showing one Provider with two active interface bindings and one legacy type. Assert the Runtime section identifies each package/API type/publisher/state and exposes explicit attach/replace/rollback/detach actions per type.
- [ ] **Red:** Add model-dialog tests that attached runtime types are selectable, unavailable types show an actionable disabled reason, duplicate aliases cannot be selected ambiguously, and legacy types remain selectable.
- [ ] **Green:** Build adapter options from registered legacy providers plus verified, attached runtime interface bindings. Label runtime-only IDs from signed catalog metadata; never invent a package or mark an uninstalled catalog entry active.
- [ ] **Green:** Add a selected API type control for connection test/sync. Keep copy concise and make the default explicit. Use Base UI controls and existing query invalidation helpers.
- [ ] **Green:** Update status presentation so a Provider can be partially available: one interface unavailable must not hide or disable other active/legacy API types.

**Validation:**

- Run (red): `bun test --isolate src/features/models/ProviderEditor.test.tsx src/features/models/EditModelConfigDialog.test.tsx`
- Expected: UI cannot display/manage more than one runtime binding and exposes only static API types.
- Run (green): same command.
- Expected: multi-interface actions and options are clear, accessible, and do not block legacy types.

### Task 7: Preserve workflow behavior for each selected model interface

**Seam:** Translation, Detect, and OCR workflows through their public frontend helpers.

**Outcome:** Workflows route a selected model to its matching interface binding, preserve fallback/cancellation/history behavior, and leave unrelated interfaces usable.

**Files:**

- Modify: `src/features/translate/translationContext.ts`
- Modify: `src/features/translate/translationWorkflow.ts`
- Modify: `src/features/translate/detectLanguageFlow.ts`
- Modify: `src/features/ocr/recognizeOcrFlow.ts`
- Test: `src/features/translate/translationWorkflow.test.ts`
- Test: `src/features/translate/detectLanguageFlow.test.ts`
- Test: `src/features/ocr/recognizeOcrFlow.test.ts`
- Test: `src/features/providers/attachRequestCancellation.test.ts`

**Steps:**

- [ ] **Red:** Add one workflow fixture with a Provider containing runtime A, runtime B, and legacy C models. Assert Translation, Detect, and OCR resolve the selected model’s executor only; a missing/unavailable A does not disable B/C.
- [ ] **Red:** Assert stream cancellation cleans up the selected runtime session, writes no cancellation history, emits no legacy retry, and only resets when configured fallback moves to another model.
- [ ] **Green:** Thread `ProviderModelDto.id`, override, and source adapter through executor calls; eliminate any remaining assumptions that `provider.runtime` is the only route.
- [ ] **Green:** Preserve host-selected prompts/options/images, profile fallback policy, text-only render policy, and one-record history semantics unchanged.

**Validation:**

- Run (red): `bun test --isolate src/features/translate/translationWorkflow.test.ts src/features/translate/detectLanguageFlow.test.ts src/features/ocr/recognizeOcrFlow.test.ts src/features/providers/attachRequestCancellation.test.ts`
- Expected: current workflows either reject a non-default type or use the Provider-wide binding.
- Run (green): same command.
- Expected: selected interfaces route independently; fallback/cancellation/history contracts remain unchanged.

### Task 8: Preserve portable, secret-free multi-interface configuration

**Seam:** configuration export → parse/normalize → preview/import → unavailable requirements.

**Outcome:** Exports/imports retain all interface identities and model source API types without packages, approvals, grants, snapshots, credentials, prompts, images, raw provider bodies, or paths.

**Files:**

- Modify: `src-tauri/src/domain/import_export.rs`
- Modify: `src-tauri/src/domain/provider.rs`
- Modify: `src-tauri/src/domain/model.rs`
- Modify: `src-tauri/src/services/import_export.rs`
- Modify: `src-tauri/src/services/import_validation.rs`
- Modify: `src/storage/types.ts`
- Test: `src-tauri/src/domain/import_export.rs`
- Test: `src-tauri/src/services/import_export.rs`
- Test: `src-tauri/src/services/runtime_provider_tests.rs`

**Steps:**

- [ ] **Red:** Add v7 fixture imports with one singular provider runtime requirement, a Provider default type A, and a model override type B; add v8 fixtures with two runtime interface requirements. Assert v7 creates unavailable A and B requirements rather than routing B to legacy; assert v8 preserves both API type/source identities; and assert every imported runtime interface is unavailable pending local package verification/approval.
- [ ] **Red:** Extend forbidden-key/content tests with multi-binding fields and ensure they reject credential refs, grants/revisions, snapshot sets/children, package paths/bytes/signatures, secrets, prompts, images, and raw provider responses.
- [ ] **Green:** Add explicit v7→v8 normalization and current v8 schema validation. Enumerate the Provider default plus all persisted model override types when normalizing a singular v7 requirement; export ordered `runtimeBindings` requirements; preserve v7’s `runtime` fields exactly while reading old documents.
- [ ] **Green:** Import only identity requirements/configuration. Do not import a package, active authority, grant, approval, vault entry, cache, log, history payload, image, or raw response.

**Validation:**

- Run (red): `mise run test import_export_runtime_provider_multi_interface -- --nocapture`
- Expected: v7 cannot normalize into multiple requirements and v8 is unsupported.
- Run (green): `mise run test import_export_runtime_provider_multi_interface -- --nocapture`
- Expected: old/new documents normalize securely; all runtime interfaces remain unavailable until local approval.

### Task 9: Update documentation, smoke coverage, and final validation

**Seam:** `mise run smoke:runtime-providers --preflight-only`.

**Outcome:** The published Phase 8 contract, automated walkthrough, and full validation suite prove one Provider can use two runtime interfaces plus a legacy API type without secret leakage or fallback regression.

**Files:**

- Modify: `docs/plans/runtime-plugin-system/phase-8-llm-provider-plugins.md`
- Modify: `.mise/tasks/smoke/runtime-providers`
- Modify: `src-tauri/src/services/runtime_provider_tests.rs`
- Modify: relevant package fixture manifests/tests only if a second package fixture needs a distinct test alias

**Steps:**

- [ ] **Red:** Extend the smoke test with one Provider, two attached signed runtime packages, two corresponding model types, and one legacy model. Assert type-correct Models List/Chat/stream/cancel, isolated rollback/detach, and export/DTO/error privacy scans.
- [ ] **Green:** Update smoke task stages and documentation to state the new additive routing contract, explicit per-interface approval, no runtime-to-legacy replay, and selected-interface model sync.
- [ ] **Green:** Run the existing signed package build/verification/conformance/no-WASI gates for every affected package; do not use unsigned staging as an installable package.

**Validation:**

- Run (red): `mise run smoke:runtime-providers --preflight-only`
- Expected: preflight fails before two-interface route/lifecycle support exists.
- Run (green): `mise run smoke:runtime-providers --preflight-only`
- Expected: fixture gates, two-interface headless walkthrough, conformance, no-WASI, and focused frontend workflows pass.

## Final Validation

- Run: `mise run format:check`
- Expected: oxfmt and cargo formatting checks pass.
- Run: `mise run lint`
- Expected: ESLint and oxlint pass.
- Run: `mise run typecheck`
- Expected: TypeScript has no errors.
- Run: `mise run test`
- Expected: all Rust tests pass, including migration/lifecycle/router/export coverage.
- Run: `mise run test-frontend`
- Expected: all isolated frontend tests pass.
- Run: `mise run plugin:build-openai-compatible`
- Expected: deterministic unsigned staging verification passes; it is not installed.
- Run: `mise run plugin:conformance llm` and `mise run plugin:check-no-wasi`
- Expected: affected package fixtures conform and declare no WASI imports.
- Run: `mise run smoke:runtime-providers --preflight-only`
- Expected: two runtime interfaces and one legacy API type work on one Provider, with no secrets/prompts/images/raw output in exported or error surfaces.

## Failure Behavior

- A package claims an API type already attached to the Provider — reject Preview/Apply with `provider_reconfiguration_required`; do not choose a package by list ordering.
- A requested API type has no active runtime binding — select the existing legacy executor only if its existing endpoint/auth compatibility checks pass; otherwise fail with the existing legacy reconfiguration error.
- A matching binding is unavailable, revoked, missing, has a changed artifact, lacks its exact grant, or fails Component execution — fail closed before/at runtime; do not replay that request through legacy.
- A chat command receives a model ID from another Provider or an API type/package identity from the caller — reject before grant, vault, broker, or network access.
- A per-interface sync fails — persist only the existing Provider-level sanitized sync error/status behavior; do not mark models from another interface missing.
- A package interface is detached/rolled back — remove only that adapter route. Retain its grant while an undiscarded adapter snapshot, Provider-scoped migrated snapshot set, or another alias of the same Provider/package references it; release it only after the final reference disappears. A migrated Provider-scoped snapshot restores its child bindings atomically. Other interface bindings, models, profiles, Provider UUID, credentials, and connection stay unchanged.

## Privacy and Security

- WIT v1 stays byte-for-byte unchanged; package selection is host-owned persistent control-plane state.
- The guest never receives an endpoint URL, proxy setting, credential reference, token, secret, or another Provider’s grant.
- Each package attachment has a distinct Provider-scoped grant and explicit acknowledgement because it may make authenticated requests as that Provider through the broker.
- The router creates a host-only binding context and the broker rechecks the exact Provider/API type/package/revision association before vault lookup and transport preparation; neither guest nor frontend can forge this context.
- All DTOs, exports, errors, and logs remain sanitized. They exclude package bytes, signatures, absolute paths, grants, snapshots, credential refs/secrets, prompts, images, raw provider bodies, and stream payloads.

## Rollout Notes

- Do not edit released migration 0024; add migration 0025 and migration fixtures for v24 data.
- Existing v24 bindings expand only to actually used, manifest-declared effective API types; every missing/unverifiable or historically invalid default/override route becomes an unavailable requirement requiring explicit review. Historic Provider-scoped snapshots migrate as atomic snapshot sets. Existing Providers and models retain UUIDs, connection configuration, credential references, profile links, and legacy behavior.
- New package interfaces are opt-in per Provider. Installation/catalog visibility alone is never execution authority.
- v7 imports remain supported via v7→v8 normalization; their singular requirement creates an unavailable requirement for every persisted effective Provider/model API type. v8 restores every interface requirement as unavailable and requires local package installation/verification/approval.
- Do not use `plugin:build-openai-compatible` output as an installable artifact. Use a signed release package or the signed development fixture with explicit temporary trust configuration.

## Risks and Mitigations

- **Shared Provider credential capability grows with each attached package.** — Require separate preview/permission acknowledgement, exact grants, and clear UI package/publisher/API-type identity.
- **Two packages claim one API type.** — Enforce a Provider-local unique adapter ID and reject ambiguity server-side and in UI.
- **Multi-source remote model keys collide.** — Persist a non-null source API type discriminator, include it in sync identity, require source-aware lookups, and preserve model/profile UUIDs during migration.
- **Aggregate models-list would silently corrupt sync snapshots.** — Require a selected API type per connection test/sync; do not aggregate packages.
- **A stale shared-package alias reaches the broker.** — Construct a host-only binding context in the router and re-read its exact adapter-keyed binding before vault access; test detach of one alias while another remains active.
- **Untrusted frontend routes a request to the wrong package.** — Pass model identity/API type only; resolve binding and package server-side; never trust a package digest or grant revision from IPC input.
- **Orphaned grants block package removal or weaken rollback.** — Keep grants while an active alias, adapter snapshot, or Provider-scoped snapshot-set child references them; reference-count before cleanup, make uninstall reject every remaining reference, and restore migrated snapshot sets atomically.
- **Phase 8 docs and v7 export format conflict with the new scope.** — Explicitly update the plan and versioned import normalizers rather than retaining misleading singular semantics.

## Open Questions

**None for the core implementation.** This plan treats “multiple plugins” as multiple independently signed provider-runtime packages, each attached to one distinct API type on a Provider. A future request for one package to implement multiple wire protocols would need a separate manifest and host-dispatch design because frozen WIT v1 does not carry an API-type field to a multi-protocol guest.
