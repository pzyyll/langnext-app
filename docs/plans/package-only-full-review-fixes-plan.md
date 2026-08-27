# Implementation Plan

**Goal:** Close or objectively verify all 11 package-only full-review findings, remove actionable Vite plugin-timing and oversized-chunk warnings without blanket suppression, and preserve package-only runtime behavior.

**Inputs:** The supplied standards/spec review, current worktree files, Vite 8.1 configuration, Rolldown `checks.pluginTimings` and `output.codeSplitting` documentation, TanStack Router automatic code-splitting documentation, and the package-only old-version compatibility exemption.

**Assumptions:**

- Old-version compatibility stays out of scope. Do not preserve unpublished provider-upgrade APIs only for compatibility.
- `src-tauri/Cargo.lock` and `bun.lock` are authoritative resolution records. Different Tauri packages do not need identical patch numbers unless `tauri info`, package metadata, or an actual build reports an incompatibility.
- The current worktree cannot run shell commands in the planning environment. The implementer must capture the authoritative diff and command output before edits.
- `PLUGIN_TIMINGS` is actionable only if it remains visible at warning log level. If it disappears at warning log level and the build exits successfully, classify it as informational and do not disable diagnostics.
- The oversized chunk identity is unknown. The first safe source boundary is the optional Markdown renderer used by `src/routes/translate/index.tsx`. Add Rolldown package groups only if the post-boundary build still proves that Markdown or syntax-highlighting packages exceed the unchanged 500 kB warning threshold.

**Architecture:** Keep TanStack Router `autoCodeSplitting: true` as the route-level boundary. Add one optional feature boundary around Markdown rendering, then use Rolldown `output.codeSplitting.groups` only for an evidenced oversized Markdown dependency chunk. Keep provider runtime execution Wasm-only, remove unpublished provider-upgrade compatibility wrappers, and retain only package-backed service execution while documenting the package-less `RuntimeIdentity::Bundled` sentinel as host-internal.

**Tech Stack:** Tauri 2, Rust 1.96.1, React 19, TanStack Router, Vite 8.1, Rolldown, Bun, Cargo, mise, ESLint, oxfmt.

---

## Review Coverage

| #   | Authoritative finding                                          | Planned disposition                                                                                                       | Evidence or task  |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 1   | Frontend/backend Tauri import version drift                    | Verify first. Update only independently stale packages; do not force unrelated packages to one patch number.              | Task 2            |
| 2   | Tests use legacy runtime kinds                                 | Verify closed across tracked source, schema, and tests.                                                                   | Task 8            |
| 3   | Stale empty-resource/bundled identity docs                     | Fix the `RuntimeIdentity` contract text while preserving the host-internal sentinel.                                      | Task 5            |
| 4   | Orphan `cmds/provider_http.rs` and unused provider upgrade IPC | Verify command deletion; remove upgrade DTOs and service wrappers. Keep the still-registered rollback API.                | Task 4            |
| 5   | Duplicated first-party/conformance plugin IDs                  | Derive conformance identities from committed manifests.                                                                   | Task 6            |
| 6   | Redundant `0032/0033` migrations                               | Verify no tracked files and no registry entries remain.                                                                   | Task 8            |
| 7   | `mise run test` failures 84–85                                 | Reproduce, fix the deterministic concurrency seam if confirmed, then run the full suite.                                  | Tasks 1 and 7     |
| 8   | `plugin:conformance` red                                       | Run targeted suites after each backend slice and the aggregate suite at the end.                                          | Tasks 4, 6, and 8 |
| 9   | `format:check` red                                             | Format only touched files, then run the authoritative check.                                                              | Task 8            |
| 10  | Default activation concurrency flake                           | Replace scheduler-dependent overlap with a deterministic test synchronization seam; do not weaken single-flight behavior. | Task 7            |
| 11  | Orphan provider HTTP deletion incomplete                       | Same closure as finding 4, plus tracked-source audits for the command module and old invoke names.                        | Tasks 4 and 8     |

The Vite `PLUGIN_TIMINGS` and oversized-chunk diagnostics are additional required build findings. Tasks 1 and 3 cover them.

## File Map

- Modify: `vite.config.ts` — add the scoped Rolldown timing check only when warning-level evidence requires it; add evidenced `codeSplitting` groups only after the source boundary is insufficient.
- Modify: `src/routes/translate/index.tsx` — replace the eager Markdown renderer import with an optional dynamic feature boundary and a non-empty loading fallback.
- Test: production output under `dist/assets/` — public build artifact seam for route/feature chunks and chunk-size warnings.
- Modify: `package.json` — update a Tauri JavaScript package only if the version audit proves it is stale or incompatible.
- Modify: `bun.lock` — record any verified JavaScript dependency update.
- Modify: `src-tauri/Cargo.toml` — change a Tauri crate constraint only if the audit proves the declared major range resolves incompatibly; do not pin merely to make patch numbers look equal.
- Modify: `src-tauri/Cargo.lock` — record any verified Rust dependency update.
- Modify: `src-tauri/src/domain/runtime_provider.rs` — remove unpublished provider-upgrade DTOs while retaining interface attach and rollback DTOs.
- Modify: `src-tauri/src/services/runtime_providers.rs` — remove `preview_upgrade` and `apply_upgrade` wrappers and their imports.
- Modify: `src-tauri/src/services/runtime_provider_tests.rs` — remove or convert tests that call upgrade wrappers; retain coverage through interface attach/rollback public service methods.
- Modify: `src-tauri/src/domain/runtime_plugin.rs` — document `RuntimeIdentity::Bundled` as a host-internal package-less sentinel, not a bundled service-plugin execution path.
- Modify: `src-tauri/src/services/wasm_runtime/tests.rs` — derive conformance plugin ID/version values from the committed fixture manifests.
- Modify: `src-tauri/src/services/default_package_activation/mod.rs` — add only the minimum test synchronization state needed to observe worker start and waiter join deterministically.
- Modify: `src-tauri/src/services/default_package_activation/single_flight.rs` — publish deterministic test-only synchronization events without changing production single-flight behavior.
- Modify: `src-tauri/src/services/default_package_activation/tests/mod.rs` — make same-digest success/failure/panic concurrency tests guarantee overlap before asserting one verification call.
- Verify only: `src-tauri/src/cmds/mod.rs`, `src-tauri/src/lib.rs` — no `provider_http` command module or invoke registration.
- Verify only: `src-tauri/src/storage/migrations.rs`, `src-tauri/migrations/` — production ends at the current `0031` file and has no tracked `0032`/`0033` files.
- Verify only: `src/features/providers/executor.ts` and runtime-kind schemas/tests — Wasm-only provider execution and rejection of removed runtime kinds.

Do not create a bundle-report file in the repository. Capture command logs outside the worktree or remove them before final validation.

## Seams

- **Seam:** `vite build` warning-level output — identifies whether `PLUGIN_TIMINGS` is a warning and reports every emitted chunk against the unchanged 500 kB threshold.
- **Seam:** production `dist/assets` module graph — proves `/translate/` and optional Markdown rendering load from real separate chunks.
- **Seam:** `tauri info` plus locked dependency resolution — proves the frontend API, CLI, Rust core, and plugins form a supported build set.
- **Seam:** `ProviderRuntimeService` interface attach/rollback lifecycle — preserves the current public package-only lifecycle after obsolete upgrade wrappers disappear.
- **Seam:** `WasmRuntime` principal validation — service components reject package-less identities while the migration host can still use its internal sentinel.
- **Seam:** committed conformance `plugin.json` manifests through `parse_manifest` — fixture identity has one source of truth.
- **Seam:** `DefaultPackageActivationService::verify_shared_package_snapshot` — overlapping calls for one digest run one verifier and publish one result to all waiters.
- **Seam:** migration runner and runtime-kind parsers/schemas — no redundant migration slots and no removed runtime kinds.
- **Seam:** project mise tasks — all authoritative test, conformance, lint, format, frontend build, and Tauri package gates pass.

These seams are inferred from the review and current public interfaces. Confirm them before implementation; if a different seam is required, update this plan before writing tests.

## Tasks

### Task 1: Capture the Authoritative Baseline

**Seam:** `vite build` warning-level output and project mise tasks.

**Outcome:** The implementation has a preserved baseline diff, exact failing test names, exact `PLUGIN_TIMINGS` severity, and the oversized chunk file name and size. No fix is selected from an assumed chunk identity.

**Files:**

- Modify: None.
- Test: Existing task and build output only.

**Steps:**

- [ ] Record `git status --short`, `git diff --stat`, `git diff`, and `git diff --cached`. Do not overwrite unrelated worktree changes.
- [ ] Run the normal frontend build and save the exact chunk table and warning lines outside the repository.
- [ ] Run Vite at warning log level. Use this objective classification:
  - If `PLUGIN_TIMINGS` appears with `--logLevel warn`, treat it as a warning and apply Task 3's scoped `checks.pluginTimings: false` change.
  - If it does not appear with `--logLevel warn`, the warning-level build exits `0`, and the normal build has no warning marker for it, classify it as informational. Do not change `checks.pluginTimings`; record this evidence in the review closure.
- [ ] Record every chunk over 500 kB by exact file name and uncompressed size. Do not change `chunkSizeWarningLimit`.
- [ ] Run the Rust test and conformance commands far enough to capture exact failures 84–85 and the first conformance failure. If the reported activation test does not fail once, run the focused repetition command in Task 7.

**Validation:**

- Run (red): `mise run build`
- Expected: reproduce the supplied warning output, including the exact oversized chunk; record whether `PLUGIN_TIMINGS` is present.
- Run (severity): `mise exec -- vite build --logLevel warn`
- Expected: either `PLUGIN_TIMINGS` appears and is objectively warning-level, or it is absent and is objectively informational.
- Run (red): `mise run test`
- Expected: capture exact failing test names and assertions, or record a clean run and continue with the repeated concurrency test.
- Run (red): `mise run plugin:conformance all`
- Expected: capture the first failing required test or fail-closed registration message, or record a clean baseline.

### Task 2: Resolve the Tauri Version Finding by Compatibility Evidence

**Seam:** `tauri info` plus locked dependency resolution.

**Outcome:** The Tauri package set is either proven compatible as resolved or updated to current compatible releases. The closure does not claim that unrelated Tauri packages must share a patch number.

**Files:**

- Modify if required: `package.json`
- Modify if required: `bun.lock`
- Modify if required: `src-tauri/Cargo.toml`
- Modify if required: `src-tauri/Cargo.lock`

**Steps:**

- [ ] **Red:** Run the version audit and capture each resolved package version. Treat an explicit `tauri info` incompatibility, an outdated direct package with a compatible update, duplicate incompatible major/minor resolutions, or a build failure attributable to version skew as red. Numeric differences alone are not red.
- [ ] **Green:** If JavaScript packages are stale, update `@tauri-apps/api`, `@tauri-apps/cli`, and direct `@tauri-apps/plugin-*` packages with Bun only. Keep the existing caret policy unless the repository adopts exact direct-dependency pins in a separate decision.
- [ ] **Green:** If Rust packages are stale or incompatible, update the affected lock entries. Change a broad `"2"` declaration in `src-tauri/Cargo.toml` only when the compatibility evidence requires a narrower minimum or exact constraint.
- [ ] Re-run `tauri info`, frontend typecheck, and `cargo check --locked`.
- [ ] If all packages are current and compatible, make no source change and close finding 1 with the captured evidence.

**Validation:**

- Run (red): `bun outdated`
- Expected: lists any stale direct JavaScript packages; no update is required when the Tauri packages are current.
- Run (red): `mise exec -- tauri info`
- Expected: exposes any supported-version mismatch. Patch-number differences without a warning are not a failure.
- Run (green): `bun install --frozen-lockfile`
- Expected: exits `0` with only `bun.lock` in use.
- Run (green): `cargo check --manifest-path src-tauri/Cargo.toml --locked`
- Expected: exits `0` with one compatible Tauri 2 graph.
- Run (green): `mise run typecheck`
- Expected: exits `0`.

### Task 3: Remove Actionable Vite Build Warnings

**Seam:** `vite build` warning-level output and production `dist/assets` module graph.

**Outcome:** The production build has no actionable `PLUGIN_TIMINGS` warning and no chunk above the unchanged 500 kB threshold. The solution uses a real optional feature boundary and, only when required by evidence, Rolldown code-splitting groups.

**Files:**

- Modify: `src/routes/translate/index.tsx`
- Modify conditionally: `vite.config.ts`
- Test: production `dist/assets` output

**Steps:**

- [ ] **Red:** Capture the exact oversized chunk and verify whether it contains the `/translate/` route or Markdown dependency path. The current source evidence is the eager `MarkdownOutput` import, which pulls `streamdown`, `@streamdown/code`, and Shiki into the route dependency graph.
- [ ] **Green:** In `src/routes/translate/index.tsx`, import React `lazy` and `Suspense`; replace the eager `MarkdownOutput` import with a named dynamic import that maps `module.MarkdownOutput` to a default lazy component. Render it only for Markdown mode. Use the existing plain output styling/content as the `Suspense` fallback so output never disappears while the optional chunk loads.
- [ ] Preserve `autoCodeSplitting: true`. Do not add a `.lazy.tsx` route because the route component is already automatically split; this change targets a feature inside that route.
- [ ] Rebuild. Confirm that the route chunk and Markdown chunk are separate assets and that switching to plain output does not require the Markdown chunk at initial route load.
- [ ] If `PLUGIN_TIMINGS` is warning-level by Task 1's criterion, add exactly this scoped Vite setting under `build.rolldownOptions`: `checks: { pluginTimings: false }`. Do not change `logLevel`, `clearScreen`, or any unrelated check.
- [ ] If `PLUGIN_TIMINGS` is informational by Task 1's criterion, do not add the setting. The objective acceptance criterion is: warning-level build output contains no `PLUGIN_TIMINGS`, and normal build output has no warning marker or non-zero exit caused by it.
- [ ] If the dynamic import removes the oversized warning, stop. Do not add vendor groups.
- [ ] If the new oversized chunk is proven to consist of `streamdown`/`@streamdown/code` plus Shiki, add `build.rolldownOptions.output.codeSplitting.groups` in `vite.config.ts`:
  - Define named RegExp constants for `streamdown`/`@streamdown` modules and `shiki`/`@shikijs` modules.
  - Define a named `BUILD_CHUNK_MAX_BYTES = 500_000` constant. This controls group `maxSize`; it does not alter Vite's `chunkSizeWarningLimit`.
  - Define named priority constants, with the more specific syntax-highlighting group above the general Markdown group.
  - Add `syntax-highlighting` and `markdown-renderer` groups with `test`, `maxSize: BUILD_CHUNK_MAX_BYTES`, and the named priorities.
  - Use `codeSplitting`, not `manualChunks`. Keep recursive dependency capture at Rolldown's safe default.
- [ ] Rebuild after each group. Remove any group that does not reduce an evidenced oversized chunk.
- [ ] If the oversized chunk is not the translate/Markdown graph, stop this task. The blocker is missing module-composition evidence for that exact chunk. Obtain a Rolldown bundle/module report before adding a different package boundary; do not guess and do not raise the warning threshold.

**Validation:**

- Run (red): `mise exec -- vite build --logLevel warn`
- Expected: before the change, shows the actionable timing and/or oversized-chunk warning identified in Task 1.
- Run (green): `mise run build`
- Expected: exits `0`; no emitted JavaScript chunk exceeds 500 kB; no oversized-chunk warning appears; `chunkSizeWarningLimit` remains unset.
- Run (green): `mise exec -- vite build --logLevel warn`
- Expected: exits `0` with no `PLUGIN_TIMINGS` warning and no oversized-chunk warning.
- Run (artifact): inspect the emitted asset table from `mise run build`.
- Expected: `/translate/` and its optional Markdown renderer are separate real chunks; all packaged chunk files remain under `dist/assets/` for Tauri `frontendDist` packaging.
- Run (green): `mise run tauri:build`
- Expected: packages the dynamically imported assets successfully; no missing asset or CSP error is reported.

### Task 4: Remove the Obsolete Provider Upgrade API

**Seam:** `ProviderRuntimeService` interface attach/rollback lifecycle.

**Outcome:** Only the current adapter-keyed attach, rollback, detach, snapshot, models, chat, and cancel APIs remain. No provider-upgrade DTO or compatibility wrapper survives.

**Files:**

- Modify: `src-tauri/src/domain/runtime_provider.rs`
- Modify: `src-tauri/src/services/runtime_providers.rs`
- Modify: `src-tauri/src/services/runtime_provider_tests.rs`
- Verify: `src-tauri/src/cmds/runtime_providers.rs`
- Verify: `src-tauri/src/cmds/mod.rs`
- Verify: `src-tauri/src/lib.rs`

**Steps:**

- [ ] **Red:** Run the obsolete-symbol absence audit below. It must fail because the upgrade DTOs and compatibility wrappers still exist.
- [ ] Add or convert a lifecycle preservation test to use `preview_interface_attach` and `apply_interface_attach` for the provider default adapter, then use the registered interface rollback path. The test must verify exact package/grant identity and rollback behavior through `ProviderRuntimeService`, not inspect preview maps.
- [ ] **Green:** Delete `ProviderRuntimeUpgradePreviewDto` and `ApplyProviderRuntimeUpgradeInput` from `src-tauri/src/domain/runtime_provider.rs`.
- [ ] Delete their imports plus `ProviderRuntimeService::preview_upgrade` and `ProviderRuntimeService::apply_upgrade` from `src-tauri/src/services/runtime_providers.rs`.
- [ ] Convert any remaining wrapper-based tests to `PreviewProviderRuntimeInterfaceAttachInput` and `ApplyProviderRuntimeInterfaceAttachInput`. Do not remove rollback DTOs or wrappers that are still registered in `src-tauri/src/lib.rs`.
- [ ] Audit tracked source for `provider_http.rs`, old provider HTTP invoke command names, upgrade DTO names, and upgrade wrapper names. Domain-level `provider_http` request/event types used by the Wasm broker are not the deleted Tauri command module and remain in scope when referenced.

**Validation:**

- Run (red): `! git grep -n -E 'ProviderRuntimeUpgradePreviewDto|ApplyProviderRuntimeUpgradeInput|preview_upgrade\(|apply_upgrade\(' -- src-tauri/src`
- Expected: exits non-zero because obsolete provider-upgrade symbols still exist.
- Run (green): `mise run test runtime_provider_lifecycle_binds_exact_package_and_provider_grant`
- Expected: passes through interface attach/rollback APIs.
- Run (absence): `! git grep -n -E 'ProviderRuntimeUpgradePreviewDto|ApplyProviderRuntimeUpgradeInput|preview_upgrade\(|apply_upgrade\(' -- src-tauri/src`
- Expected: exits `0` because no obsolete provider-upgrade symbol remains.
- Run (absence): `! git ls-files 'src-tauri/src/cmds/provider_http.rs'`
- Expected: exits `0`; no tracked command module exists. The live domain broker file `src-tauri/src/domain/provider_http.rs` is not part of this audit.
- Run (absence): `! git grep -n -E 'provider_http_(request|stream)|cancel_provider_http' -- src-tauri/src/cmds src-tauri/src/lib.rs`
- Expected: exits `0`; no obsolete provider HTTP invoke command or registration remains.
- Run (green): `mise run plugin:conformance llm`
- Expected: exits `0` and all required provider runtime tests are present and pass.

### Task 5: Correct the Runtime Identity Contract

**Seam:** `WasmRuntime` principal validation.

**Outcome:** Rustdoc no longer claims that `RuntimeIdentity::Bundled` represents an executable bundled service handler. Production package-only behavior stays unchanged.

**Files:**

- Modify: `src-tauri/src/domain/runtime_plugin.rs`
- Test: `src-tauri/src/services/wasm_runtime/tests.rs`
- Verify: `src-tauri/src/services/wasm_runtime/executor.rs`

**Steps:**

- [ ] **Red:** Run the stale-contract text audit below. It must fail while `RuntimeIdentity` still describes a compiled-in bundled service handler.
- [ ] Keep or rename the existing `bundled_principal_without_package_digest_rejected` test so its public behavior is explicit: a package-less host-internal principal cannot execute a Wasm service component.
- [ ] **Green:** Replace the `RuntimeIdentity` doc text with the exact contract: `Bundled` is a package-less host-internal sentinel used for host migration execution and negative authorization tests; installable service-plugin execution must use `Package(PackageIdentity)`.
- [ ] Update nearby `has_package_digest`/`package_digest` comments only if needed to use the same terminology. Do not delete or rename the enum variant in this scoped fix because `run_migration_export` uses it for a host-internal migration principal.
- [ ] Confirm no user-facing package-only comment calls it a legacy or bundled service execution path.

**Validation:**

- Run (red): `! git grep -n -E 'compiled-in bundled handler|Bundled identities are not constrained' -- src-tauri/src/domain/runtime_plugin.rs`
- Expected: exits non-zero while the stale contract text remains.
- Run (green): `mise run test bundled_principal_without_package_digest_rejected`
- Expected: passes and proves the fail-closed service seam.
- Run (green): `mise run test principal_identity_inherits_from_grant_set`
- Expected: passes and preserves identity binding.
- Run (audit): `git grep -n -E 'compiled-in bundled handler|bundled runtime identit' -- src-tauri/src`
- Expected: no stale service-execution description remains.

### Task 6: Derive Conformance Identities from Fixture Manifests

**Seam:** committed conformance `plugin.json` manifests through `parse_manifest`.

**Outcome:** Conformance plugin IDs and versions have one source of truth: the committed manifests.

**Files:**

- Modify: `src-tauri/src/services/wasm_runtime/tests.rs`

**Steps:**

- [ ] **Red:** Add `conformance_fixture_identity_comes_from_committed_manifests`. It must parse both included manifests and compare helper-returned ID/version/capability values to the manifest fields. It initially fails to compile because the helpers do not exist.
- [ ] **Green:** Add `OnceLock<PluginManifestV1>` helpers for the translate and detect fixture manifests using the existing `parse_manifest` function and `CONFORMANCE_PLUGIN_JSON` strings.
- [ ] Replace `CONFORMANCE_PLUGIN_ID`, `CONFORMANCE_DETECT_PLUGIN_ID`, and `CONFORMANCE_PLUGIN_VERSION` constants with helper accessors derived from those parsed manifests.
- [ ] Where a capability value is fixture-owned, derive it from the manifest capability declaration instead of duplicating it. Keep host protocol capability constants from `CAPABILITY_SPECS` when they are testing the host contract rather than fixture identity.
- [ ] Update principal/grant helpers and assertions to call the manifest-derived accessors. Do not read files at runtime; continue using `include_str!` so tests are hermetic.

**Validation:**

- Run (red): `mise run test conformance_fixture_identity_comes_from_committed_manifests`
- Expected: fails to compile before helper creation, or fails because a duplicated constant can diverge from the manifest.
- Run (green): `mise run test conformance_fixture_identity_comes_from_committed_manifests`
- Expected: passes for both fixture manifests.
- Run (green): `mise run test wasm_executor`
- Expected: all Wasm executor conformance tests pass.
- Run (green): `mise run plugin:conformance wasm`
- Expected: required names are present, none are ignored, and the suite exits `0`.

### Task 7: Make Default Activation Concurrency Tests Deterministic

**Seam:** `DefaultPackageActivationService::verify_shared_package_snapshot`.

**Outcome:** Same-digest concurrent callers provably overlap and invoke the verifier exactly once. The test no longer depends on OS scheduling.

**Files:**

- Modify: `src-tauri/src/services/default_package_activation/mod.rs`
- Modify: `src-tauri/src/services/default_package_activation/single_flight.rs`
- Modify: `src-tauri/src/services/default_package_activation/tests/mod.rs`

**Steps:**

- [ ] **Red:** Repeat `default_package_activation_single_flight_same_digest` with multiple test threads until the current scheduler-dependent assertion reproduces, or use the exact tests 84–85 captured in Task 1 if they differ.
- [ ] Add a deterministic test-only observation primitive to `DefaultPackageActivationService`. Use a `Mutex` plus `Condvar` state that records worker start and the number of callers joined to the current flight generation. Name the timeout with the existing `SINGLE_FLIGHT_TEST_TIMEOUT`; add no sleeps.
- [ ] **Green:** Under `#[cfg(test)]`, signal worker start from `verify_policy_bound_package_snapshot` and increment/join notification at the public single-flight entry after obtaining an existing or new flight. Do not branch production behavior or bypass real verification.
- [ ] Update the same-digest success, failure, and panic tests to:
  1. start both callers behind a barrier;
  2. hold the genuine worker at the existing test barrier;
  3. wait with a bounded condition until two callers have joined the same generation;
  4. release the worker;
  5. assert identical result semantics and exactly one genuine verification call.
- [ ] Keep cancellation tests on the real worker and retain bounded waits. Do not replace concurrency with sequential calls and do not weaken the `calls == 1` assertion.
- [ ] If Task 1 identifies a production race rather than a scheduler-dependent test, stop and revise this task around the exact failing state transition. Do not hide a production race with test synchronization.

**Validation:**

- Run (red): `for i in $(seq 1 50); do cargo test --manifest-path src-tauri/Cargo.toml default_package_activation_single_flight_same_digest -- --test-threads=4 || break; done`
- Expected: before the fix, reproduces the scheduler-dependent second verification or the exact captured flake. If it never fails, retain Task 1's captured failure as the red artifact.
- Run (green): `for i in $(seq 1 100); do cargo test --manifest-path src-tauri/Cargo.toml default_package_activation_single_flight -- --test-threads=4 || exit 1; done`
- Expected: all repetitions pass; no timeout, deadlock, poisoned mutex, or `verification_call_count == 2` failure.
- Run (green): `mise run test default_package_activation`
- Expected: all activation authorization, single-flight, recovery, and authority tests pass.

### Task 8: Verify Closed Findings and Run the Full Review Matrix

**Seam:** migration runner, runtime-kind contracts, tracked repository contents, and project mise tasks.

**Outcome:** Every authoritative finding has a command result and final status. Already-closed items stay closed without speculative edits.

**Files:**

- Modify: only files identified by Tasks 2–7.
- Verify: `src/features/providers/executor.ts`
- Verify: `src-tauri/src/domain/runtime_provider.rs`
- Verify: `src-tauri/src/domain/runtime_plugin.rs`
- Verify: `src-tauri/src/storage/migrations.rs`
- Verify: `src-tauri/migrations/`
- Verify: `src-tauri/src/cmds/mod.rs`
- Verify: `src-tauri/src/lib.rs`

**Steps:**

- [ ] Verify runtime kinds. Frontend provider execution must expose only `"wasm-component"`; backend provider parser/schema/tests must reject `"bundled-rust"` and `"legacy-frontend-provider"`. `trusted-native-worker` remains valid only for the first-party native-worker plugin runtime, not provider execution.
- [ ] Verify migrations. `MIGRATIONS` must end with the tracked `0031_unsigned_plugin_packages.sql` entry, and no tracked `0032*` or `0033*` file may exist. Do not renumber published migration slots in this task.
- [ ] Verify command deletion and provider upgrade symbol absence with Task 4's audits.
- [ ] Verify conformance IDs no longer duplicate committed manifest IDs.
- [ ] Run oxfmt and Cargo fmt only after all edits, inspect the diff, then run `format:check`.
- [ ] Run targeted tests first, then the complete authoritative command list below.
- [ ] Compare the final diff to the baseline. Remove logs and generated files not required by the build. Keep `src/routeTree.gen.ts` only if the router plugin legitimately regenerates it; never edit it manually.
- [ ] Produce a closure table with all 11 finding numbers, command evidence, and `Closed`, `Not a defect`, or `Blocked`. Do not use `Unverified` after commands are available.

**Validation:**

- Run (runtime-kind audit): `git grep -n -E 'bundled-rust|legacy-frontend-provider' -- src src-tauri/src src-tauri/migrations`
- Expected: matches occur only in explicit rejection/negative-test assertions or historical migration fixtures allowed by the old-version exemption; no production parser or executor accepts them.
- Run (provider-kind test): `mise run test runtime_kind_and_state_round_trip`
- Expected: passes and confirms the closed provider runtime kind/state parser contract.
- Run (migration audit): `! git ls-files 'src-tauri/migrations/0032*' 'src-tauri/migrations/0033*'`
- Expected: exits `0`.
- Run (migration tests): `mise run test storage::migrations::tests`
- Expected: fresh and upgrade paths pass; latest version matches the registry length.
- Run (format): `mise run format`
- Expected: changes only touched files and Cargo formatting.
- Run (format check): `mise run format:check`
- Expected: exits `0` without modifications.

## Final Validation

Run these commands in this order from the worktree root:

```bash
git status --short
git diff --stat
git diff
bun install --frozen-lockfile
mise exec -- tauri info
mise run typecheck
mise run lint
mise run format:check
mise run build
mise exec -- vite build --logLevel warn
cargo check --manifest-path src-tauri/Cargo.toml --locked
mise run test
mise run plugin:conformance wasm
mise run plugin:conformance llm
mise run plugin:conformance installed-lifecycle
mise run plugin:conformance all
mise run tauri:build
! git grep -n -E 'ProviderRuntimeUpgradePreviewDto|ApplyProviderRuntimeUpgradeInput|preview_upgrade\(|apply_upgrade\(' -- src-tauri/src
! git ls-files ':(glob)src-tauri/src/cmds/provider_http.rs' 'src-tauri/migrations/0032*' 'src-tauri/migrations/0033*'
git status --short
git diff --check
git diff --stat
git diff
```

Expected final result:

- Every command exits `0`.
- Warning-level Vite output contains neither `PLUGIN_TIMINGS` nor an oversized-chunk warning.
- If `PLUGIN_TIMINGS` was classified as informational, normal build output may contain the information line only when warning-level output does not contain it and the build exits `0`; record that objective exception.
- No JavaScript chunk exceeds the unchanged 500 kB threshold.
- The Tauri package build contains every dynamic Markdown asset.
- All Rust tests and every required conformance name pass.
- No provider-upgrade compatibility symbol, provider HTTP command module, or `0032`/`0033` migration file remains.
- The final diff contains no unrelated cleanup and no captured build logs.

## Failure Behavior

- Missing or revoked runtime package authority remains fail-closed with the existing sanitized capability errors.
- Removing provider-upgrade wrappers must not remove current interface rollback behavior or its registered IPC commands.
- A package-less host-internal principal remains valid only for internal migration setup and negative tests; Wasm service execution rejects it.
- A cancelled single-flight waiter returns its cancellation result without cancelling the real shared worker or other waiters.
- A dynamic Markdown chunk load uses visible plain-text output as fallback; translation output must not disappear.
- If a dynamic asset is missing during Tauri packaging, `tauri:build` fails. Do not add an eager fallback that silently defeats code splitting.

## Privacy and Security

- Do not log provider credentials, grant contents, package bytes, publisher public-key material, or user translation text while diagnosing tests or bundle output.
- Keep DTO deletion scoped to already-unpublished upgrade contracts. Retain sanitized current DTOs and capability errors.
- Do not weaken CSP, grant validation, signature verification, or Tauri asset protocol settings to support dynamic chunks.
- Build reports may contain local absolute paths. Store them outside the repository and do not commit them.

## Rollout Notes

- No database migration is required. The migration finding is a deletion/registry verification for unpublished slots.
- Dynamic chunks are packaged under the existing Tauri `frontendDist: "../dist"` flow. No remote asset hosting is introduced.
- Do not raise `build.chunkSizeWarningLimit` and do not set global `logLevel: "silent"`.
- Do not add legacy `manualChunks`; Vite 8 uses Rolldown `output.codeSplitting`.
- Do not stage or commit as part of implementation unless explicitly requested.

## Risks and Mitigations

- **Unknown oversized chunk composition** — Capture the exact build output first. Add only the Markdown boundary initially; block further grouping until module evidence exists.
- **Over-splitting optional Markdown dependencies** — Stop after the dynamic import if it clears the warning. Add at most the evidenced syntax/Markdown groups and verify Tauri packaging.
- **Misclassifying `PLUGIN_TIMINGS`** — Use `--logLevel warn` as the objective severity test. Disable only `checks.pluginTimings`, not global logs.
- **Mistaking independent Tauri package versions for drift** — Use `tauri info`, lock resolution, and real build results. Do not force equal patch numbers.
- **Deleting live rollback contracts with obsolete upgrade wrappers** — Audit `src-tauri/src/lib.rs` registrations and retain `ProviderRuntimeRollback*` APIs.
- **Hiding a production concurrency defect with test hooks** — Keep hooks under `#[cfg(test)]`, use the real verifier, and stop if the baseline shows a state-transition failure rather than scheduler-dependent overlap.
- **Magic build values** — Name every RegExp, byte limit, priority, timeout, and repetition count introduced in source. Do not add unexplained literals.

## Open Questions

- The exact oversized chunk and its module composition are unavailable until Task 1 runs. This blocks any non-Markdown Rolldown group.
- The exact failures numbered 84–85 are unavailable until Task 1 runs. If they are not the same-digest single-flight tests, revise Task 7 around the captured public seam before editing.
- It is not yet proven whether `PLUGIN_TIMINGS` is warning-level in this Vite invocation. Task 1 defines the objective decision and Task 3 defines both valid outcomes.
- It is not yet proven whether any Tauri package is actually incompatible. Task 2 must prefer evidence-only closure over cosmetic version alignment.
