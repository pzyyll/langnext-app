# Implementation Plan

> **Superseded (2026-08-24):** plugin-level signing, publisher trust, vendor bootstrap, and default-activation orchestration were removed. See `docs/architecture/plugin-catalog.md`.

**Goal:** Close all eight review findings and make the migration consistently package-only, with no Bundled Rust fallback or legacy executor semantics.

**Inputs:** The supplied Standards and Spec review, plus repository evidence from the cited files, existing unit tests, runtime integration tests, and `AGENTS.md`.

**Assumptions:**

- The review report is authoritative that 205 paths are currently staged. The planning harness has no shell tool, so it could not independently run `git diff --cached --name-only`.
- A missing authorized default package is an availability failure. Use `StorageError::PluginUnavailable` so IPC returns the stable `plugin_unavailable` code.
- Provider rollback restores a retained prior package binding. It never restores `legacy-frontend-provider` or another non-package executor.
- `legacyAliases` remains valid manifest compatibility metadata. Remove only runtime state, labels, branches, fixtures, and comments that describe a legacy executor.

**Architecture:** Installed, verified `.lnplugin` packages are the only executable provider and service-integration implementations. Wasm components own protocol request and response logic. Rust owns package verification, schema projection, grants, host auth, endpoint trust, bounded transport, and table-driven authority checks. Frontend runtime presentation exposes package state and package-to-package rollback only.

**Tech Stack:** Rust 1.96.1, Tauri 2, Wasm components, React 19, TypeScript, Bun test, Cargo test, ESLint, oxfmt, mise.

---

## Finding Coverage

| Finding                                                    | Disposition                                                             | Tasks  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| Standards High — 205 staged files                          | Fix first; clear the index without changing worktree content            | Task 0 |
| Standards Medium — stale adapter architecture              | Update to the package-only boundary                                     | Task 7 |
| Standards Low — duplicated URL normalizer selection        | Extract one field-aware helper and name the Edge TTS config field       | Task 4 |
| Standards Low — duplicated Google/Baidu authority switches | Replace with one table-driven validator                                 | Task 5 |
| Spec Medium — `bundled-rust` endpoint preview fallback     | Fail closed with stable `plugin_unavailable` behavior                   | Task 1 |
| Spec Low — `with_bundled_runtime` constructor              | Delete the unused constructor                                           | Task 2 |
| Spec Low — frontend legacy state and rollback wording      | Remove legacy presentation and define rollback as prior-package restore | Task 3 |
| Spec Low — unused Google Web protocol parser code          | Delete host protocol execution code; retain URL normalization only      | Task 6 |

No finding is out of scope. No unsafe or impossible change is identified.

## File Map

- Modify: `docs/architecture/adapter-strategy.md` — define the package-only protocol, host, and trust boundaries.
- Modify: `src-tauri/src/services/endpoint_trust.rs` — reject create previews that have no resolved package runtime; update package-backed tests.
- Modify: `src-tauri/src/domain/service_integration.rs` — remove `with_bundled_runtime` and stale Bundled Rust domain wording.
- Modify: `src/features/providers/runtimeProviderPresentation.ts` — remove the legacy label and describe rollback as package rollback.
- Modify: `src/features/providers/runtimeProviderPresentation.test.ts` — verify package-only runtime presentation.
- Modify: `src/features/providers/runtimeProviderActions.ts` — correct rollback documentation to prior-package restore.
- Modify: `src/features/providers/runtimeProviderActions.test.ts` — replace legacy rollback fixtures with two distinct Wasm package bindings.
- Modify: `src/features/models/ProviderEditor.tsx` — remove the legacy status key and dead legacy-only notice.
- Modify: `src-tauri/src/services/package_definition.rs` — centralize instance endpoint URL normalization and name the Edge TTS field.
- Modify: `src-tauri/src/services/wasm_runtime/host.rs` — validate Google Cloud and Baidu authorities through one rule table.
- Modify: `src-tauri/src/services/google_translate_web.rs` — remove unused host protocol constants, request helpers, response parsers, and DB execution helpers.

No new production or test file is required.

## Seams

- **Seam:** `EndpointTrustService::preview` — a create preview exists only when the caller supplies a resolved package runtime identity.
- **Seam:** `IntegrationInstance` construction surface — the domain cannot opt into a Bundled Rust runtime through `with_bundled_runtime`.
- **Seam:** `presentProviderRuntime` and `RuntimeProviderActions` — UI state and rollback actions describe Wasm package bindings only.
- **Seam:** `PluginConfigAdapter::{normalize_config, instance_endpoint_origin}` — both methods produce the same canonical URL for the same configured endpoint field.
- **Seam:** `PluginHostState::authorize_broker_fetch` — a package request is approved only when one complete authority rule matches.
- **Seam:** Google Translate Web package runtime integration — translation and detection continue through installed Wasm components after Rust protocol parsers are removed.
- **Seam:** `docs/architecture/adapter-strategy.md` — architecture guidance names packages and Wasm components as the only protocol implementation boundary.
- **Seam:** Git index precondition — implementation starts with no staged paths.

These are the required seams for the fix round. Do not add tests against private helper call counts or source layout when behavior can be observed through these boundaries.

## Tasks

### Task 0: Restore the Review Preconditions

**Seam:** Git index precondition.

**Outcome:** The index is empty, while all worktree changes remain available for the fix round.

**Files:** None.

**Steps:**

- [ ] Record the current staged count: `git diff --cached --name-only | wc -l`. Expected baseline from the review: `205`.
- [ ] Remove every path from the index without discarding worktree content: `git restore --staged .`.
- [ ] Do not use `git reset --hard`, `git checkout -- .`, or any command that changes worktree file content.
- [ ] Recheck the index before editing any finding.

**Validation:**

- Run (red): `test -z "$(git diff --cached --name-only)"`
- Expected: exits non-zero before the restore because staged paths exist.
- Run (green): `git restore --staged . && test -z "$(git diff --cached --name-only)"`
- Expected: exits zero; `git diff --cached --name-only` prints nothing.
- Run: `git status --short`
- Expected: existing changes remain as unstaged worktree changes.

### Task 1: Fail Closed When No Default Package Resolves

**Seam:** `EndpointTrustService::preview`.

**Outcome:** A new Edge TTS endpoint preview cannot synthesize a Bundled Rust identity. It returns a stable package-unavailable error until a package runtime identity resolves.

**Files:**

- Modify: `src-tauri/src/services/endpoint_trust.rs`
- Test: `src-tauri/src/services/endpoint_trust.rs`

**Steps:**

- [ ] **Red:** Add `create_preview_without_resolved_package_fails_closed`. Call `preview` for a create (`instance_id: None`) with `creation_runtime: None`. Assert `StorageError::PluginUnavailable`. The error result must contain no preview ID, so the caller has nothing it can reserve or consume.
- [ ] **Red:** Convert the existing create-preview success test to pass `CreationRuntimeIdentity { runtime_kind: "wasm-component", package_digest: Some(...), plugin_version: "1.0.0" }`. Use the digest returned by the real signed Edge TTS fixture installation.
- [ ] **Green:** Replace the `None => (..., "bundled-rust", None)` match arm with an immediate `StorageError::PluginUnavailable`. Use a stable, secret-free message that identifies the plugin/default-package availability problem.
- [ ] **Green:** Update `setup` and all endpoint-trust test instances to use `runtime_kind: "wasm-component"`, the installed package digest, and its package version. Update `consume_for_save` calls to use the same identity tuple.
- [ ] Keep existing update previews unchanged: they must continue to bind to the runtime identity already persisted on the instance.
- [ ] Preserve non-mutation: the failing create preview must not insert a preview session or endpoint approval.

**Validation:**

- Run (red): `mise run test services::endpoint_trust::tests::create_preview_without_resolved_package_fails_closed -- --exact`
- Expected: fails because `preview(..., None)` currently returns `Ok` with a synthetic Bundled Rust identity.
- Run (green): `mise run test services::endpoint_trust::tests::create_preview_without_resolved_package_fails_closed -- --exact`
- Expected: passes with `StorageError::PluginUnavailable`.
- Run: `mise run test services::endpoint_trust::tests`
- Expected: all endpoint trust preview, reservation, expiry, and consumption tests pass with package identities.

### Task 2: Remove the Bundled Runtime Constructor

**Seam:** `IntegrationInstance` construction surface.

**Outcome:** The domain no longer exposes an API that can construct a `bundled-rust` runtime state.

**Files:**

- Modify: `src-tauri/src/domain/service_integration.rs`

**Steps:**

- [ ] **Red:** Run the structural package-only guard below and retain its failing output with the task notes.
- [ ] **Green:** Delete `IntegrationInstance::with_bundled_runtime` and its doc comment. Do not replace it with another default-runtime constructor.
- [ ] **Green:** Change the `runtime_kind` field documentation from examples that include `bundled-rust` to package-only `wasm-component` wording.
- [ ] Confirm there are no call sites. The repository LSP found zero references; the command below is authoritative during execution.

**Validation:**

- Run (red): `! rg -n 'with_bundled_runtime|Default bundled-rust pin' src-tauri/src/domain/service_integration.rs`
- Expected: exits non-zero because the method and comment still exist.
- Run (green): the same command.
- Expected: exits zero with no matches.
- Run: `mise run test domain::service_integration::tests`
- Expected: all domain tests pass.

### Task 3: Make Provider Presentation Package-Only

**Seam:** `presentProviderRuntime` and `RuntimeProviderActions`.

**Outcome:** Runtime UI types, labels, fixtures, branches, and rollback descriptions contain no legacy executor state. Rollback means restore a retained earlier package version.

**Files:**

- Modify: `src/features/providers/runtimeProviderPresentation.ts`
- Modify: `src/features/providers/runtimeProviderPresentation.test.ts`
- Modify: `src/features/providers/runtimeProviderActions.ts`
- Modify: `src/features/providers/runtimeProviderActions.test.ts`
- Modify: `src/features/models/ProviderEditor.tsx`

**Steps:**

- [ ] **Red:** In `runtimeProviderActions.test.ts`, first assert that the rollback preview target has `runtimeKind: "wasm-component"` and a non-null package digest. Run the focused suite and observe failure against `LEGACY_BINDING`.
- [ ] **Green:** Replace `LEGACY_BINDING` with `PREVIOUS_PACKAGE_BINDING`. Give it `runtimeKind: "wasm-component"`, a digest different from `TARGET_BINDING`, a grant revision, and package state. Assert rollback preview and successful rollback target that earlier package binding.
- [ ] **Red:** In `runtimeProviderPresentation.test.ts`, add a compile-time exhaustive helper that accepts only `"activeRuntime" | "unavailableRuntime" | "pendingActivation"`, and pass every returned `labelKey` through it. The typecheck must fail while `ProviderRuntimeStateLabelKey` still includes `"legacy"`.
- [ ] **Green:** Remove `"legacy"` from `ProviderRuntimeStateLabelKey`.
- [ ] **Green:** Update presentation comments: a missing catalog entry is missing package metadata, not a legacy binding; rollback restores a retained package snapshot, not a legacy executor.
- [ ] **Green:** Remove `legacy` from `RUNTIME_STATUS_LABEL_KEYS` in `ProviderEditor.tsx`.
- [ ] **Green:** Delete the dead `runtimePresentation.labelKey === "legacy"` notice. Do not replace it with a package preview branch unless a current package-only state requires one.
- [ ] **Green:** Update `RuntimeProviderActions` comments to state that rollback restores the retained prior package binding. Keep `isRollbackAvailable` gated by `runtimeKind === "wasm-component"`.
- [ ] Keep `legacyAliases` unchanged. It maps historical adapter IDs to package manifests and does not represent a runtime executor.

**Validation:**

- Run (red): `bun test src/features/providers/runtimeProviderPresentation.test.ts src/features/providers/runtimeProviderActions.test.ts`
- Expected: fails before production cleanup because the current fixtures and label type still encode legacy runtime semantics; current TypeScript package-only types can also reject the legacy fixture at compile time.
- Run (green): the same command.
- Expected: both suites pass with package-to-package rollback fixtures.
- Run: `! rg -n 'labelKey === "legacy"|statusLegacy|legacy executor|legacy binding|legacy-frontend-provider' src/features/providers/runtimeProviderPresentation.ts src/features/providers/runtimeProviderPresentation.test.ts src/features/providers/runtimeProviderActions.ts src/features/providers/runtimeProviderActions.test.ts src/features/models/ProviderEditor.tsx`
- Expected: exits zero with no matches. Matches for `legacyAliases` are allowed.

### Task 4: Centralize Endpoint Field Normalization

**Seam:** `PluginConfigAdapter::{normalize_config, instance_endpoint_origin}`.

**Outcome:** Both adapter methods use one field-aware URL canonicalizer and one named Edge TTS field identifier.

**Files:**

- Modify: `src-tauri/src/services/package_definition.rs`
- Test: `src-tauri/src/services/package_definition.rs`

**Steps:**

- [ ] **Characterization:** Add `config_and_instance_origin_share_edge_url_canonicalization`. Build a `SchemaConfigAdapter` from a minimal parsed schema with the `base-url` string field and an origin alias. Assert `normalize_config` changes `https://custom.example/api/` to `https://custom.example/api`, and `instance_endpoint_origin` returns the identical canonical string.
- [ ] **Characterization:** Add the generic-field case with a non-Edge field ID and assert both public trait methods use `normalize_https_endpoint_url` semantics. Run both cases before refactoring; they must pass and pin existing behavior.
- [ ] **Red:** Run the duplicate-branch guard below. It must fail while the two primitive `field == "base-url"` branches remain.
- [ ] **Green:** Define `EDGE_TTS_BASE_URL_CONFIG_FIELD: &str = "base-url"` near the adapter.
- [ ] **Green:** Extract one helper, for example `normalize_instance_endpoint_field(field_id: &str, raw: &str) -> Result<String, StorageError>`. It selects `normalize_edge_tts_base_url` only for `EDGE_TTS_BASE_URL_CONFIG_FIELD`; all other endpoint fields use `normalize_https_endpoint_url`.
- [ ] **Green:** Call the helper from both `normalize_config` and `instance_endpoint_origin`. Remove both duplicated `if field == "base-url"` branches and their repeated comments.
- [ ] Keep the helper field-driven. Do not add plugin-ID match arms.

**Validation:**

- Run (characterization): `mise run test services::package_definition::tests`
- Expected: the new Edge and generic cases pass before and after the refactor and return byte-identical canonical URLs.
- Run (red): `test "$(rg -n 'field == "base-url"' src-tauri/src/services/package_definition.rs | wc -l)" -eq 0`
- Expected: exits non-zero because two duplicated primitive comparisons remain.
- Run (green): the same command.
- Expected: exits zero; the primitive comparisons are removed.
- Run: `mise run test services::package_definition::tests`
- Expected: Edge and generic endpoint normalization tests still pass.

### Task 5: Use One Table-Driven Package Authority Validator

**Seam:** `PluginHostState::authorize_broker_fetch`.

**Outcome:** Google Cloud and Baidu OCR requests pass through one complete-rule matcher. Cross-product combinations fail closed before auth acquisition or transport.

**Files:**

- Modify: `src-tauri/src/services/wasm_runtime/host.rs`
- Test: `src-tauri/src/services/wasm_runtime/host.rs`

**Steps:**

- [ ] **Red:** Replace the helper-level Google-only test with authorization cases that cover one accepted Google Translate request, one accepted Baidu OCR request, and rejected cross-products for wrong plugin ID, endpoint, capability, origin/base URL, auth policy, and path.
- [ ] **Red:** Include a Baidu path mismatch assertion that preserves `BrokerFetchError::PathConfined`; all other authority mismatches remain `BrokerFetchError::NotApproved`.
- [ ] **Green:** Introduce a closed authority rule type with fields for plugin ID, endpoint ID, capability ID, canonical origin, auth policy, path rule, and path-mismatch error class.
- [ ] **Green:** Represent exact Baidu paths as table rows. Represent Google paths with closed path-rule variants: exact Vision/TTS paths and bounded project/location RPC operations for Translate/Detect.
- [ ] **Green:** Add one `validate_package_authority` function. If the plugin has no table entries, return `Ok(())`. If it has entries, require `base_url == origin` and one complete matching row. Never match one field from one row and another field from a different row.
- [ ] **Green:** Replace consecutive calls to `validate_google_cloud_authority` and `validate_baidu_ocr_authority` in `authorize_broker_fetch` with one call to the shared validator.
- [ ] **Green:** Delete the two plugin-specific validators. Keep `google_translate_rpc_path` only as the implementation of the closed Google RPC path-rule variant.
- [ ] Keep validation before token acquisition and broker transport.

**Validation:**

- Run (red): `mise run test services::wasm_runtime::host::tests::package_authority_rules_fail_closed -- --exact`
- Expected: fails before the shared table and Baidu coverage exist.
- Run (green): the same command.
- Expected: all accepted rows pass and every mismatched cross-product fails with the specified error class.
- Run: `! rg -n 'validate_google_cloud_authority|validate_baidu_ocr_authority' src-tauri/src/services/wasm_runtime/host.rs`
- Expected: exits zero with no matches.
- Run: `mise run test services::google_cloud_runtime_tests`
- Expected: installed Google package runtime tests pass.
- Run: `mise run test services::baidu_ocr_runtime_tests`
- Expected: installed Baidu package runtime tests pass; no request reaches transport with invalid authority.

### Task 6: Delete Google Web Host Protocol Execution Code

**Seam:** Google Translate Web package runtime integration.

**Outcome:** Rust retains URL normalization only. Wasm packages remain the sole implementation of GTX/proxy request construction and response parsing.

**Files:**

- Modify: `src-tauri/src/services/google_translate_web.rs`
- Test: `src-tauri/src/services/google_translate_web_runtime_tests.rs` (run unchanged unless an obsolete Rust-parser assertion is found)

**Steps:**

- [ ] **Red:** Run the structural guard below. It must find the obsolete constants and parser functions before deletion.
- [ ] **Green:** Retain `NormalizedProxyUrl`, `normalize_proxy_url`, `looks_like_secret_query_key`, and the query-key denylist used by URL normalization.
- [ ] **Green:** Delete host protocol constants and execution limits: capability IDs, endpoint aliases, GTX path/client/encoding/`dt`, response-size limit, request timeout, and GTX response-shape limits.
- [ ] **Green:** Delete `load_web_config`, source-language mappers, GTX query construction, HTTP response mapping, `parse_gtx_translate_response`, `parse_gtx_detect_response`, detected-language extraction, `parse_proxy_translate_response`, and `resolve_instance_proxy_origin`.
- [ ] **Green:** Delete any zero-call config constructors/serializers/completeness helpers left behind by the package migration. Package schemas and `SchemaConfigAdapter` remain the config authority.
- [ ] **Green:** Remove imports that supported protocol execution (`service_capability` response types, integration repository/database access, Google language mapping, `Duration`, and `Uuid`).
- [ ] Do not move parser logic elsewhere in Rust. The existing Wasm runtime integration tests are the protocol behavior seam.

**Validation:**

- Run (red): `! rg -n 'GOOGLE_WEB_GTX_(RELATIVE_PATH|CLIENT|ENCODING|DT)|GOOGLE_WEB_MAX_RESPONSE_BODY_BYTES|GOOGLE_WEB_REQUEST_TIMEOUT|parse_gtx_translate_response|parse_gtx_detect_response|parse_proxy_translate_response' src-tauri/src/services/google_translate_web.rs`
- Expected: exits non-zero because obsolete protocol code exists.
- Run (green): the same command.
- Expected: exits zero with no matches.
- Run: `mise run test services::google_translate_web_runtime_tests`
- Expected: package installation, activation, Translate, and Detect tests pass through Wasm with no Rust parser dependency.
- Run: `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`
- Expected: passes with no references to deleted APIs.

### Task 7: Correct the Adapter Architecture Document

**Seam:** `docs/architecture/adapter-strategy.md`.

**Outcome:** The architecture document describes the code that exists after package-only migration.

**Files:**

- Modify: `docs/architecture/adapter-strategy.md`

**Steps:**

- [ ] **Red:** Confirm the document still claims that TypeScript Provider plugins own wire formats and that Baidu OCR remains native REST.
- [ ] **Green:** Retitle the document for the package-only runtime boundary.
- [ ] **Green:** Replace the TypeScript Provider plugin layout and contract with the installed-package flow: verify package, project manifest/schema, resolve an authorized package pin, execute the declared Wasm component, and broker host-approved network/auth access.
- [ ] **Green:** State that provider, Google Web, Google Cloud, Edge TTS, and Baidu OCR protocol request/response logic belongs to package Wasm components. Baidu OCR is not a native REST exception.
- [ ] **Green:** State the Rust host responsibilities: package verification, publisher/default authorization, schema projection, endpoint trust, grant construction, credential isolation, host auth/token exchange, bounded transport, cancellation, persistence, and sanitized IPC.
- [ ] **Green:** State the frontend responsibilities: package/runtime presentation, configuration UI, user approvals, and invocation of typed IPC. It does not implement provider wire protocols.
- [ ] **Green:** Preserve security rules that remain true: secrets do not cross sanitized IPC DTOs; guests cannot select arbitrary origins/auth policies; missing packages fail closed.
- [ ] Remove references to deleted `ProviderPlugin`, `providerFetch`, frontend SSE parsing, plugin registration, and “Baidu stays native.”

**Validation:**

- Run (red): `! rg -n 'TypeScript Provider|ProviderPlugin|providerFetch|Baidu stays native|native REST' docs/architecture/adapter-strategy.md`
- Expected: exits non-zero before the rewrite.
- Run (green): the same command.
- Expected: exits zero with no stale boundary claims.
- Run: `rg -n 'package|Wasm|fail closed|credential|bounded transport' docs/architecture/adapter-strategy.md`
- Expected: each package-only boundary concept has at least one clear statement.

## Final Validation

Run in this order after all tasks are green:

1. `test -z "$(git diff --cached --name-only)"`
   - Expected: exits zero. The implementation fix round did not restage the 205-file set.
2. `git diff --check`
   - Expected: exits zero with no whitespace errors.
3. `bun test`
   - Expected: all frontend tests pass, including package-to-package rollback presentation and actions.
4. `mise run test`
   - Expected: all Rust unit and integration tests pass, including endpoint trust and all package runtime suites.
5. `mise run typecheck`
   - Expected: TypeScript reports no errors; no legacy runtime fixture violates `ProviderRuntimeKind = "wasm-component"`.
6. `mise run lint`
   - Expected: ESLint and oxlint pass.
7. `mise run format:check`
   - Expected: oxfmt and `cargo fmt --check` pass.
8. `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
   - Expected: no warnings, dead imports, or dead code remain after parser deletion.
9. Run the final package-only guards:

   ```bash
   ! rg -n 'with_bundled_runtime|Default bundled-rust pin' \
     src-tauri/src/domain/service_integration.rs
   ! rg -n 'labelKey === "legacy"|statusLegacy|legacy executor|legacy binding|legacy-frontend-provider' \
     src/features/providers/runtimeProviderPresentation.ts \
     src/features/providers/runtimeProviderPresentation.test.ts \
     src/features/providers/runtimeProviderActions.ts \
     src/features/providers/runtimeProviderActions.test.ts \
     src/features/models/ProviderEditor.tsx
   ! rg -n 'parse_gtx_translate_response|parse_gtx_detect_response|parse_proxy_translate_response' \
     src-tauri/src/services/google_translate_web.rs
   ! rg -n 'validate_google_cloud_authority|validate_baidu_ocr_authority' \
     src-tauri/src/services/wasm_runtime/host.rs
   ! rg -n 'TypeScript Provider|ProviderPlugin|providerFetch|Baidu stays native|native REST' \
     docs/architecture/adapter-strategy.md
   ```

   - Expected: every command exits zero. `legacyAliases` remains allowed.

10. `git status --short`
    - Expected: only intended unstaged modifications are present. No generated or unrelated file changed.

## Failure Behavior

- No authorized default package for a create preview — return `StorageError::PluginUnavailable`; IPC emits `plugin_unavailable`; create no preview session and persist no approval.
- Existing instance package missing or unavailable — keep the instance visible as unavailable; do not invent a Bundled Rust identity.
- Authority tuple mismatch — deny before token acquisition and transport. Use `NotApproved`, except a Baidu endpoint with the correct authority tuple but wrong path remains `PathConfined`.
- Missing retained rollback package/snapshot — existing lifecycle preview/apply errors remain authoritative; the UI must not offer a legacy fallback.
- Malformed Google Web protocol response — the Wasm package returns the capability error; Rust does not parse or repair the payload.

## Privacy and Security

- Do not include package bytes, grants, credential references, secrets, raw tokens, or endpoint approval fingerprints in frontend DTOs or logs.
- The authority table must match complete rows. Partial matching can create confused-deputy authorization across endpoints.
- Keep authority validation before host auth/token exchange so credentials cannot be sent to an unapproved origin or path.
- The missing-default-package error message must be stable and secret-free.

## Rollout Notes

- This is a local fix round. It needs no data migration because the changes remove fallback constructors and dead execution code.
- Existing persisted non-package rows are not rewritten in this scope. They remain unavailable unless a separate migration requirement exists.
- Do not stage or commit during execution unless requested separately.

## Risks and Mitigations

- **Authority table changes an existing denial code** — encode the path-mismatch error class in each rule and assert Google/Baidu behavior before replacing the old functions.
- **Parser deletion removes a hidden caller** — run `cargo check --all-targets`, full Rust tests, and package runtime integration tests after deletion.
- **Frontend cleanup removes compatibility metadata** — target executor semantics only; retain `legacyAliases` package-manifest metadata.
- **URL helper changes canonical bytes used by trust/grants** — test both public adapter methods against the same Edge and generic inputs.
- **Index cleanup loses changes** — use only `git restore --staged .`; verify worktree changes remain with `git status --short`.

**Open Questions:** None.
