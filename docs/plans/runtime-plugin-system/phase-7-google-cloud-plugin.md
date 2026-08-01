# Phase 7: Google Cloud Multi-Capability Runtime Plugin Implementation Plan

**Goal:** Migrate Google Cloud Translate, Detect, Vision OCR, and Text-to-Speech into one installable Wasm package while retaining host-owned service-account OAuth, per-capability health, and atomic per-instance rollback.

**Inputs:** Phases 5–6, `docs/analysis/google-cloud-plugin-architecture.md`, the current bundled implementation in `src-tauri/src/services/google_cloud.rs`, and the implemented runtime/package patterns in `runtime-plugins/google-translate-web/` and `runtime-plugins/edge-tts/`.

**Assumptions:**

- Mr. Julian confirmed one package with four single-world Components: Translate, Detect, OCR, and TTS. This preserves the frozen WIT v1 worlds and the router's existing per-capability artifact selection.
- The package keeps plugin ID `com.langnext.google-cloud`, version `1.2.0`, credential slot `service-account-json`, config schema version 1, preference schema majors, and existing integration/profile/OCR/Speech IDs.
- The signed manifest uses the existing host auth policy ID `com.langnext.auth.google-service-account`; no second Google auth-policy namespace is introduced.
- Phase 7 changes host-to-guest OCR transport to `BlobHandle`. The current frontend `OcrRecognizeInput.png_base64` command contract remains unchanged: the host decodes it before guest execution. Replacing frontend OCR IPC with a binary upload resource is a separate phase.
- Capability health changes only when the host-owned `ProviderAttemptTracker` reaches `Completed`. Local validation, resolution failure, and user cancellation leave health unchanged.
- Automated tests use real runtime, package, SQLite, vault, and broker code with fakes only at Google OAuth/HTTPS system boundaries. No automated test calls live Google services.
- Google Cloud STT, microphone capture, SSML, long audio, and partial speech results remain out of scope.

**Architecture:** The package contains four Components, each exporting one existing WIT v1 world and sharing a `no_std` protocol crate for Google wire formats, language mapping, and normalized provider errors. The host resolves a signed per-capability artifact, authorizes the endpoint from the instance grant, derives the OAuth audience and least-privilege scope from the principal's capability, acquires an opaque token grant, and injects `Bearer` only inside `NetworkBrokerHandle`. A host-owned `ProviderAttemptTracker` travels with `ExecutionContext`, is updated by bundled or Wasm broker execution, and lets workflows distinguish preflight/cancellation from a completed auth/network/provider attempt without trusting guest output. One instance pin and grant-set revision cover the complete package; capability results are stored separately and are invalidated whenever instance credentials, config, package, permissions, or grant authority changes.

**Tech Stack:** Rust, Tauri 2, Wasmtime Component Model, frozen WIT v1, `wit-bindgen`, `cargo-component = 0.21.1`, SQLite, React 19, TanStack Query, Bun, mise.

---

## Dependencies

- Phases 5 and 6 are implemented in the current repository.
- Migrations `0018`–`0022` already exist. The next migration in this plan is `0023`; released migrations must not be renumbered.

## TDD Execution Rules

- Confirm the proposed seams below before writing the first test.
- Execute tasks in order. Each task is one vertical red → green slice.
- Run the exact red command after adding the named test and before implementation; a compile failure caused only by an intentionally not-yet-introduced public API is acceptable for that first red run.
- Implement only enough behavior to pass the current test. Do not pre-implement later capabilities or health paths.
- Verify through public traits, services, DTOs, lifecycle APIs, or CLI tasks. Do not test private helpers or mock internal modules.
- Fake only Google OAuth exchange and HTTPS transport. Use the real package verifier, router, Wasm runtime, Blob resources, SQLite repositories, and service workflows.
- Expected values come from committed Google request/response fixtures and fixed literals, not from recomputing values with the implementation under test.
- Refactoring is deferred to review after the red-green slices; it is not mixed into a slice.
- From Task 2 onward, any guest/protocol/manifest change must run `mise run plugin:refresh-google-cloud-fixture` before the green host test. That dev-only task calls `plugin:build-google-cloud -- --update-fixtures`, then performs the exact fixture-key sign → finalize → verify flow and refreshes Component fixtures/digests plus `runtime-plugins/google-cloud/fixtures/com.langnext.google-cloud-1.2.0.lnplugin` and its `.sha256`. Normal `plugin:build-google-cloud` remains verify-only and fails on drift.

## File Map

### Plugin package

- Create: `runtime-plugins/google-cloud/protocol/Cargo.toml`, `runtime-plugins/google-cloud/protocol/Cargo.lock`, `runtime-plugins/google-cloud/protocol/src/lib.rs` — shared `no_std` request/response codecs, language mapping, and normalized Google errors.
- Create: `runtime-plugins/google-cloud/translate/Cargo.toml`, `runtime-plugins/google-cloud/translate/Cargo.lock`, `runtime-plugins/google-cloud/translate/src/lib.rs` — `translate-text-world` Component.
- Create: `runtime-plugins/google-cloud/detect/Cargo.toml`, `runtime-plugins/google-cloud/detect/Cargo.lock`, `runtime-plugins/google-cloud/detect/src/lib.rs` — `translate-detect-world` Component.
- Create: `runtime-plugins/google-cloud/ocr/Cargo.toml`, `runtime-plugins/google-cloud/ocr/Cargo.lock`, `runtime-plugins/google-cloud/ocr/src/lib.rs` — `ocr-image-world` Component.
- Create: `runtime-plugins/google-cloud/tts/Cargo.toml`, `runtime-plugins/google-cloud/tts/Cargo.lock`, `runtime-plugins/google-cloud/tts/src/lib.rs` — `speech-synthesize-world` Component.
- Create: `runtime-plugins/google-cloud/plugin.json` — four artifact declarations, three fixed Google API endpoints, the existing host auth policy, schemas, locales, and signed file index.
- Create: `runtime-plugins/google-cloud/schemas/config.json`, `runtime-plugins/google-cloud/schemas/translate-preferences.json`, `runtime-plugins/google-cloud/schemas/ocr-preferences.json`, `runtime-plugins/google-cloud/schemas/speech-preferences.json` — schema version 1 contracts.
- Create: `runtime-plugins/google-cloud/locales/en.json`, `runtime-plugins/google-cloud/locales/zh-CN.json` — package metadata text.
- Create: `runtime-plugins/google-cloud/tests/fixtures/translate/request.json`, `success.json`, `error-400.json`, `error-401.json`, `error-403.json`, `error-429.json`, `malformed-success.json` — Translate golden contract.
- Create: `runtime-plugins/google-cloud/tests/fixtures/detect/request.json`, `success.json` — Detect golden contract.
- Create: `runtime-plugins/google-cloud/tests/fixtures/vision/input.png`, `request.json`, `success.json`, `error-per-image.json`, `invalid.png`, `oversized.png` — Vision golden contract and bounds.
- Create: `runtime-plugins/google-cloud/tests/fixtures/tts/request.json`, `success.json`, `expected.mp3`, `error-403.json`, `error-429.json`, `malformed-base64.json`, `oversized-audio.json` — TTS golden contract and bounds.
- Create: `runtime-plugins/google-cloud/translate/fixtures/langnext-google-cloud-translate.wasm`, `runtime-plugins/google-cloud/detect/fixtures/langnext-google-cloud-detect.wasm`, `runtime-plugins/google-cloud/ocr/fixtures/langnext-google-cloud-ocr.wasm`, `runtime-plugins/google-cloud/tts/fixtures/langnext-google-cloud-tts.wasm` and adjacent `.sha256` files — deterministic Component fixtures.
- Create: `runtime-plugins/google-cloud/fixtures/com.langnext.google-cloud-1.2.0.lnplugin` and `.sha256` — dev-key-signed package fixture used by host conformance tests.
- Create: `.mise/tasks/plugin/build-google-cloud` — deterministic four-Component build and unsigned staging tree at `runtime-plugins/dist/staging/com.langnext.google-cloud-1.2.0/`.
- Create: `.mise/tasks/plugin/refresh-google-cloud-fixture` — dev-only wrapper that builds, signs with the committed fixture seed, finalizes to the source fixture path, and verifies with `runtime-plugins/conformance/fixtures/packages/keys/vendor-public-key.hex`.
- Modify: `.mise/tasks/plugin/conformance` — fail-closed `google-cloud-translate`, `google-cloud-ocr`, `google-cloud-tts`, and aggregate `google-cloud` modes with required test names.
- Create: `runtime-plugins/conformance/wasm-ocr-trap-component/Cargo.toml`, `runtime-plugins/conformance/wasm-ocr-trap-component/src/lib.rs`, `runtime-plugins/conformance/wasm-ocr-oversized-component/Cargo.toml`, `runtime-plugins/conformance/wasm-ocr-oversized-component/src/lib.rs` — test-only `ocr-image-world` failure Components.
- Modify: `.mise/tasks/plugin/build-conformance` — build the two OCR failure Components for installed-runtime tests.

### Host runtime and lifecycle

- Modify: `src-tauri/src/domain/service_capability.rs` — add cloneable `ProviderAttemptTracker` state to `ExecutionContext`.
- Modify: `src-tauri/src/services/auth_policies.rs` — derive audience and allowed scopes from a trusted auth policy plus capability ID.
- Modify: `src-tauri/src/services/wasm_runtime/host.rs`, `src-tauri/src/services/wasm_runtime/store.rs`, `src-tauri/src/services/wasm_runtime/executor.rs` — carry and update provider-attempt provenance across guest broker execution.
- Modify: `src-tauri/src/services/wasm_runtime/network_handle.rs` — acquire opaque Google grants and inject bearer auth after runtime authorization.
- Modify: `src-tauri/src/state.rs` — provide `TokenGrantService` to the Wasm broker and discover the bundled signed Google Cloud package without auto-pinning instances.
- Modify: `src-tauri/src/services/wasm_runtime/bindings.rs`, `src-tauri/src/services/wasm_runtime/executor.rs` — instantiate `ocr-image-world` and add `WasmOcrImageAdapter`.
- Modify: `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/services/service_capabilities.rs` — route OCR through the authoritative instance pin and signed per-capability artifact.
- Modify: `src-tauri/src/services/google_cloud.rs` — retain bundled rollback and fixture source; remove code only after equivalent guest coverage exists.
- Create: `src-tauri/src/services/google_cloud_runtime_tests.rs` — installed-package tests through lifecycle, router, Wasm executor, broker, Blob resources, and capture transport.
- Modify: `src-tauri/src/services/mod.rs` — register the test module.
- Modify: `src-tauri/src/services/runtime_lifecycle.rs` — invalidate capability health in the same transaction as authority changes.

### Capability health and workflows

- Create: `src-tauri/migrations/0023_integration_capability_health.sql` — per-instance, per-capability-major result rows.
- Create: `src-tauri/src/domain/integration_capability_health.rs` — `CapabilityHealthStatus` and sanitized records/DTOs.
- Create: `src-tauri/src/repositories/integration_capability_health.rs` — upsert, list, and invalidate repository boundary.
- Modify: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/repositories/tests.rs` — migration registration and repository tests.
- Modify: `src-tauri/src/domain/service_integration.rs`, `src-tauri/src/services/service_integrations.rs` — expose sanitized capability health on `IntegrationInstanceDto` and invalidate it after relevant saves.
- Modify: `src-tauri/src/cmds/service_translation.rs` — record Translate/Detect provider results through the public workflows.
- Modify: `src-tauri/src/services/ocr_services.rs`, `src-tauri/src/services/speech_services.rs` — record OCR/TTS provider results through existing service workflows.

### Frontend

- Modify: `src/storage/types.ts` — add sanitized capability-health DTO types.
- Create: `src/features/plugins/capabilityHealthPresentation.ts`, `src/features/plugins/capabilityHealthPresentation.test.ts` — stable presentation mapping for ready, degraded, and not-checked states.
- Modify: `src/features/plugins/IntegrationEditor.tsx`, `src/features/ocr/OcrServiceEditor.tsx`, `src/features/speech/SpeechServiceEditor.tsx` — display relevant capability status without provider bodies or user content.
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts` — short capability-health labels.

All new code files must begin with the repository's two-line `ABOUTME:` comment.

## Seams

These seams are proposed and must be confirmed before implementation begins.

- **Authenticated Wasm egress:** `BrokerHandle::fetch` as reached through WIT `host.broker-fetch` — approved package principals obtain host-derived Google OAuth and unauthorized policy/capability/endpoint combinations fail before transport.
- **Translate:** `TranslateTextCapability::translate` — exact Google request, parsed result, cancellation, and normalized errors; early slices use a verified but unactivated adapter, then Task 9 proves authoritative instance-pin routing.
- **Detect:** `DetectLanguageCapability::detect` — source-auto behavior, language mapping, and Translation-scope isolation under the same unactivated-then-pinned progression.
- **OCR:** `OcrImageCapability::recognize`, then `OcrServiceService::recognize` after complete-package activation — host-decoded image bytes enter the guest as an input `BlobHandle`, with bounded output and cleanup.
- **TTS:** `SpeechSynthesizeCapability::synthesize`, then `SpeechServiceService::synthesize` after complete-package activation — bounded audio returns through an output `BlobHandle` and existing playback bytes.
- **Request cancellation:** `RequestSessionRegistry::cancel` plus the four public capability workflows — cancellation stops auth/network/guest work without executor fallback or leaked Blob resources.
- **Provider-attempt provenance:** `ExecutionContext::provider_attempt` — workflows can observe `NotStarted`, `Started`, `Completed`, or `Cancelled` without inspecting private guest/runtime helpers.
- **Capability health storage:** `integration_capability_health` repository functions — one instance/capability row can change without mutating another.
- **Capability health projection:** `ServiceIntegrationService::get_instance` / `list_instances` — sanitized status, normalized error code, and timestamp only.
- **Atomic runtime lifecycle:** `RuntimeLifecycleService::preview_upgrade`, `apply_upgrade`, and rollback APIs — one package/grant-set identity moves every binding together or not at all.
- **Dependency protection:** `ServiceIntegrationService::delete` — active Profile/OCR/Speech references reject deletion without removing the instance or credential binding.
- **Runtime requirement recovery:** `ImportExportService::export`, `preview`, and `import` — package digest, publisher identity, grant requirement, and all four capability majors round-trip through the public v7 document.
- **Capability status UI:** `capabilityHealthPresentation` consumed by the three editors — users see ready, degraded, or not checked without raw provider data.
- **Package developer CLI:** `mise run plugin:build-google-cloud` and `mise run plugin:conformance google-cloud` — deterministic artifacts and fail-closed required tests.

## Required Existing-Behavior Characterization

These two original Phase 7 safeguards predate this implementation. Do not force an artificial red result. Add and run each public-seam characterization test immediately after Task 9 creates the complete activatable fixture and before Task 10 continues feature work. If either fails, stop Phase 7 and repair that regression as its own red → green bug slice.

### Dependency-protected delete

**Seam:** Dependency protection.

- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`
- Add: `google_cloud_dependency_protected_delete_preserves_instance_and_credentials`.
- Arrange one Google Cloud instance with real Profile, OCR, and Speech dependency rows plus a credential binding. Call `ServiceIntegrationService::delete`, assert `StorageError::InUse`, then read back the instance, all dependencies, credential binding/revision, and vault entry through their public service/repository boundaries.
- Run: `mise run test google_cloud_dependency_protected_delete_preserves_instance_and_credentials -- --nocapture`
- Expected: deletion is rejected and every instance/dependency/credential record remains intact.

### Runtime requirement export/import round-trip

**Seam:** Runtime requirement recovery.

- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`
- Add: `google_cloud_export_import_round_trip_preserves_exact_runtime_requirement`.
- Activate the complete fixture package, call `ImportExportService::export`, assert the public v7 document contains the exact package digest, publisher key/fingerprint, grant requirement, and all four capability majors, then call public `preview` and `import` into a clean database and assert the same unresolved/exact runtime requirement is restored without secrets.
- Run: `mise run test google_cloud_export_import_round_trip_preserves_exact_runtime_requirement -- --nocapture`
- Expected: public export, preview, and import preserve exact runtime authority and every required capability major.

## Tasks

### Task 1: Enable host-owned Google OAuth for Wasm broker calls

**Seam:** Authenticated Wasm egress.

**Outcome:** An approved Google Cloud guest request receives host-injected bearer auth; credentials and token bytes remain inaccessible to the guest.

**Files:**

- Modify: `src-tauri/src/services/auth_policies.rs`
- Modify: `src-tauri/src/services/wasm_runtime/network_handle.rs`
- Modify: `src-tauri/src/state.rs`
- Test: `src-tauri/src/services/wasm_runtime/network_handle.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_wasm_broker_injects_host_bearer_for_approved_translate_grant`. Build a real package principal/grant, a `TokenGrantService` with a stub `GoogleTokenExchanger`, and a capture `RawHttpTransport`; assert transport receives the known literal `Authorization: Bearer fixture-token` only for `translate.text@1`.
- [ ] **Green:** Add a host helper that maps `com.langnext.auth.google-service-account` plus principal capability to the existing audience and allow-listed scopes. Add optional token-grant support to `NetworkBrokerHandle` without changing credential-free `host.none.v1` behavior.
- [ ] **Green:** Wire the production broker factory with `token_grants.clone()`. Keep endpoint, method, principal, package, instance, and grant checks in the existing runtime authorization chokepoint.
- [ ] Keep existing auth-policy, wrong-scope, wrong-audience, token-cache, credential-revision, and blocked-header tests unchanged and passing.

**Validation:**

- Run (red): `mise run test google_cloud_wasm_broker_injects_host_bearer_for_approved_translate_grant -- --nocapture`
- Expected: fails because authenticated policies are currently rejected before token acquisition.
- Run (green): `mise run test google_cloud_wasm_broker_injects_host_bearer_for_approved_translate_grant -- --nocapture`
- Expected: one token exchange and one transport call; token material appears only in the captured host transport header.

### Task 2: Add the unactivated Translate tracer

**Seam:** Translate.

**Outcome:** A verified but unactivated test package executes Translate through the real package verifier, Wasm adapter/runtime, authenticated broker, and guest parser without changing an instance pin.

**Files:**

- Create: `runtime-plugins/google-cloud/protocol/Cargo.toml`, `runtime-plugins/google-cloud/protocol/Cargo.lock`, `runtime-plugins/google-cloud/protocol/src/lib.rs`
- Create: `runtime-plugins/google-cloud/translate/Cargo.toml`, `runtime-plugins/google-cloud/translate/Cargo.lock`, `runtime-plugins/google-cloud/translate/src/lib.rs`
- Create: `runtime-plugins/google-cloud/plugin.json`, `runtime-plugins/google-cloud/schemas/config.json`, `runtime-plugins/google-cloud/schemas/translate-preferences.json`
- Create: `runtime-plugins/google-cloud/locales/en.json`, `runtime-plugins/google-cloud/locales/zh-CN.json`
- Create: `runtime-plugins/google-cloud/tests/fixtures/translate/request.json`, `runtime-plugins/google-cloud/tests/fixtures/translate/success.json`
- Create: `runtime-plugins/google-cloud/translate/fixtures/langnext-google-cloud-translate.wasm`, `runtime-plugins/google-cloud/translate/fixtures/langnext-google-cloud-translate.wasm.sha256`
- Create: `runtime-plugins/google-cloud/fixtures/com.langnext.google-cloud-1.2.0.lnplugin`, `runtime-plugins/google-cloud/fixtures/com.langnext.google-cloud-1.2.0.lnplugin.sha256`
- Create: `.mise/tasks/plugin/build-google-cloud`, `.mise/tasks/plugin/refresh-google-cloud-fixture`
- Create: `src-tauri/src/services/google_cloud_runtime_tests.rs`
- Modify: `src-tauri/src/services/mod.rs`, `.mise/tasks/plugin/conformance`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_translate_matches_golden_contract`. Verify the partial fixture package, load its signed Translate artifact/grant into `WasmTranslateTextAdapter` without lifecycle activation, invoke `TranslateTextCapability::translate`, compare the captured request to `tests/fixtures/translate/request.json`, assert the fixed translated text from `success.json`, and assert no integration instance pin changed.
- [ ] **Green:** Port only Translate path construction, language mapping, request limits, success parsing, and source-auto handling from `google_cloud.rs` into the protocol/Translate crates.
- [ ] **Green:** Stage only implemented capability declarations during this tracer. Do not add the package to application resources or production bootstrap.
- [ ] **Green:** Make normal `plugin:build-google-cloud` pin `cargo-component 0.21.1`, build with `--locked`, verify committed Component digests, and generate the signed file index without signing. Add explicit `--update-fixtures` for the dev refresh task; normal builds must fail on drift.
- [ ] **Green:** Make `plugin:refresh-google-cloud-fixture` run `plugin:build-google-cloud -- --update-fixtures`, `plugin:sign-staging` with the named dev seed constant, `plugin:finalize-package` to the committed fixture path, and `plugin:verify` with `runtime-plugins/conformance/fixtures/packages/keys/vendor-public-key.hex`.
- [ ] **Green:** Add a fail-closed `google-cloud-translate` conformance mode requiring the verified adapter/runtime test; fixture-only parser tests are insufficient. Installed instance-pin coverage arrives in Task 9.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_translate_matches_golden_contract -- --nocapture`
- Expected: fails because the package/Translate artifact and test runtime module do not exist.
- Run (green fixture): `mise run plugin:refresh-google-cloud-fixture`
- Expected: the Translate Component digest, package fixture, and package `.sha256` are refreshed and verified with the dev public key.
- Run (green test): `mise run test google_cloud_runtime_translate_matches_golden_contract -- --nocapture`
- Expected: the verified unactivated guest produces the exact fixture request and fixed translated result through host OAuth without changing any instance pin.

### Task 3: Normalize Translate provider failures

**Seam:** Translate.

**Outcome:** Google auth, IAM, quota, rate-limit, invalid-request, and malformed-response envelopes map to stable capability errors without raw provider text.

**Files:**

- Modify: `runtime-plugins/google-cloud/protocol/src/lib.rs`
- Create: `runtime-plugins/google-cloud/tests/fixtures/translate/error-400.json`, `runtime-plugins/google-cloud/tests/fixtures/translate/error-401.json`, `runtime-plugins/google-cloud/tests/fixtures/translate/error-403.json`, `runtime-plugins/google-cloud/tests/fixtures/translate/error-429.json`, `runtime-plugins/google-cloud/tests/fixtures/translate/malformed-success.json`
- Modify: `runtime-plugins/google-cloud/translate/fixtures/langnext-google-cloud-translate.wasm`, `runtime-plugins/google-cloud/translate/fixtures/langnext-google-cloud-translate.wasm.sha256`, `runtime-plugins/google-cloud/plugin.json`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_translate_maps_provider_errors` as a table of independent fixture responses with fixed expected `CapabilityErrorCode` literals; assert returned messages do not contain fixture provider bodies.
- [ ] **Green:** Port the minimum shared Google error-envelope parser and Translate-specific malformed-success checks needed by the table.
- [ ] Preserve cancellation and timeout errors from the host runtime instead of remapping them as provider failures.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_translate_maps_provider_errors -- --nocapture`
- Expected: at least the first error fixture is returned as an unnormalized guest/provider error.
- Run (green fixture): `mise run plugin:refresh-google-cloud-fixture`
- Expected: the changed protocol is rebuilt into the Translate Component and verified package fixture.
- Run (green test): `mise run test google_cloud_runtime_translate_maps_provider_errors -- --nocapture`
- Expected: every fixture maps to its fixed stable code and no raw provider body is exposed.

### Task 4: Add Detect to the same package

**Seam:** Detect.

**Outcome:** The same instance/package handles language detection with Translation scope and source-auto semantics.

**Files:**

- Create: `runtime-plugins/google-cloud/detect/Cargo.toml`, `runtime-plugins/google-cloud/detect/Cargo.lock`, `runtime-plugins/google-cloud/detect/src/lib.rs`
- Create: `runtime-plugins/google-cloud/detect/fixtures/langnext-google-cloud-detect.wasm`, `runtime-plugins/google-cloud/detect/fixtures/langnext-google-cloud-detect.wasm.sha256`
- Create: `runtime-plugins/google-cloud/tests/fixtures/detect/request.json`, `runtime-plugins/google-cloud/tests/fixtures/detect/success.json`
- Modify: `runtime-plugins/google-cloud/plugin.json`, `.mise/tasks/plugin/build-google-cloud`, `.mise/tasks/plugin/conformance`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_detect_uses_translation_scope_and_maps_language`. Verify the partial package, invoke `DetectLanguageCapability::detect` through `WasmDetectLanguageAdapter` without lifecycle activation, compare the captured request to the Detect fixture, assert the known app language ID, and assert no instance pin changed.
- [ ] **Green:** Port only Detect request/response parsing and Google-to-app language mapping; reuse the protocol crate without changing the Translate seam.
- [ ] **Green:** Add the Detect artifact/capability to the package and required conformance list. Its grant may use only the Translate endpoint and Translation scope.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_detect_uses_translation_scope_and_maps_language -- --nocapture`
- Expected: fails because the package does not declare or ship `translate.detect@1`.
- Run (green fixture): `mise run plugin:refresh-google-cloud-fixture`
- Expected: the Detect Component and updated package fixture verify with the dev public key.
- Run (green test): `mise run test google_cloud_runtime_detect_uses_translation_scope_and_maps_language -- --nocapture`
- Expected: Detect executes from the same verified package authority without activation and no Vision/TTS scope is requested.

### Task 5: Route Vision OCR through an input BlobHandle

**Seam:** OCR.

**Outcome:** The verified unactivated OCR artifact transfers decoded PNG bytes through a host-owned Blob and returns bounded recognized text; Task 9 adds service/router activation.

**Files:**

- Create: `runtime-plugins/google-cloud/ocr/Cargo.toml`, `runtime-plugins/google-cloud/ocr/Cargo.lock`, `runtime-plugins/google-cloud/ocr/src/lib.rs`
- Create: `runtime-plugins/google-cloud/ocr/fixtures/langnext-google-cloud-ocr.wasm`, `runtime-plugins/google-cloud/ocr/fixtures/langnext-google-cloud-ocr.wasm.sha256`
- Create: `runtime-plugins/google-cloud/schemas/ocr-preferences.json`
- Create: `runtime-plugins/google-cloud/tests/fixtures/vision/input.png`, `runtime-plugins/google-cloud/tests/fixtures/vision/request.json`, `runtime-plugins/google-cloud/tests/fixtures/vision/success.json`
- Modify: `runtime-plugins/google-cloud/protocol/src/lib.rs`, `runtime-plugins/google-cloud/plugin.json`, `.mise/tasks/plugin/build-google-cloud`
- Modify: `src-tauri/src/services/wasm_runtime/bindings.rs`, `src-tauri/src/services/wasm_runtime/executor.rs`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_ocr_uses_blob_and_returns_golden_text`. Verify the partial package, invoke `OcrImageCapability::recognize` through `WasmOcrImageAdapter` without lifecycle activation, compare the captured Vision request with the fixture, assert the fixed recognized text, assert the request-owned Blob is released, and assert no instance pin changed.
- [ ] **Green:** Instantiate `ocr-image-world` and add `WasmRuntime::execute_ocr_image` plus `WasmOcrImageAdapter`; authoritative router/service wiring waits for the complete-package slice in Task 9.
- [ ] **Green:** Decode/validate the PNG input in the host adapter, create the input Blob under the request principal, and pass only its handle to WIT.
- [ ] **Green:** Port Vision request construction, language hints, success parsing, and the Vision endpoint/scope declaration.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_ocr_uses_blob_and_returns_golden_text -- --nocapture`
- Expected: fails because OCR currently resolves only the bundled registry and no OCR Wasm adapter exists.
- Run (green fixture): `mise run plugin:refresh-google-cloud-fixture`
- Expected: the OCR Component and updated package fixture verify with the dev public key.
- Run (green test): `mise run test google_cloud_runtime_ocr_uses_blob_and_returns_golden_text -- --nocapture`
- Expected: exact Vision request, fixed recognized text, no remaining request-owned Blob, and no changed instance pin.

### Task 6: Bound and sanitize Vision failures

**Seam:** OCR.

**Outcome:** Invalid/oversized PNGs fail before transport, per-image Vision errors map to stable codes, and image/text content is absent from logs and DTOs.

**Files:**

- Modify: `runtime-plugins/google-cloud/protocol/src/lib.rs`
- Create: `runtime-plugins/google-cloud/tests/fixtures/vision/error-per-image.json`, `runtime-plugins/google-cloud/tests/fixtures/vision/invalid.png`, `runtime-plugins/google-cloud/tests/fixtures/vision/oversized.png`
- Modify: `runtime-plugins/google-cloud/ocr/fixtures/langnext-google-cloud-ocr.wasm`, `runtime-plugins/google-cloud/ocr/fixtures/langnext-google-cloud-ocr.wasm.sha256`, `runtime-plugins/google-cloud/plugin.json`
- Modify: `src-tauri/src/services/wasm_runtime/executor.rs`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_ocr_rejects_invalid_and_provider_error_content`. Use fixed invalid-PNG, oversized-PNG, and Vision per-image error fixtures; assert no transport for invalid inputs and stable sanitized codes for provider errors.
- [ ] **Green:** Port only the PNG bounds and Vision per-image error handling required by the test; keep recognized text and image bytes out of default logs/history/export.
- [ ] Add the required OCR test to `google-cloud-ocr` conformance.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_ocr_rejects_invalid_and_provider_error_content -- --nocapture`
- Expected: at least one case reaches transport or exposes an unnormalized provider error.
- Run (green fixture): `mise run plugin:refresh-google-cloud-fixture`
- Expected: Vision validation/error changes are present in the verified OCR package fixture.
- Run (green test): `mise run test google_cloud_runtime_ocr_rejects_invalid_and_provider_error_content -- --nocapture`
- Expected: invalid inputs fail before transport; provider errors are sanitized and Blob cleanup remains complete.

### Task 7: Route TTS audio through an output BlobHandle

**Seam:** TTS.

**Outcome:** The verified unactivated TTS artifact returns bounded MP3 bytes through an output Blob; Task 9 adds service/router activation and the existing playback workflow.

**Files:**

- Create: `runtime-plugins/google-cloud/tts/Cargo.toml`, `runtime-plugins/google-cloud/tts/Cargo.lock`, `runtime-plugins/google-cloud/tts/src/lib.rs`
- Create: `runtime-plugins/google-cloud/tts/fixtures/langnext-google-cloud-tts.wasm`, `runtime-plugins/google-cloud/tts/fixtures/langnext-google-cloud-tts.wasm.sha256`
- Create: `runtime-plugins/google-cloud/schemas/speech-preferences.json`
- Create: `runtime-plugins/google-cloud/tests/fixtures/tts/request.json`, `runtime-plugins/google-cloud/tests/fixtures/tts/success.json`, `runtime-plugins/google-cloud/tests/fixtures/tts/expected.mp3`
- Modify: `runtime-plugins/google-cloud/protocol/src/lib.rs`, `runtime-plugins/google-cloud/plugin.json`, `.mise/tasks/plugin/build-google-cloud`, `.mise/tasks/plugin/conformance`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_tts_returns_golden_audio_via_blob`. Verify the now-complete package, invoke `SpeechSynthesizeCapability::synthesize` through `WasmSpeechSynthesizeAdapter` without lifecycle activation, compare the captured request to the fixture, assert fixed MP3 bytes, assert the guest output Blob is consumed once, and assert no instance pin changed.
- [ ] **Green:** Port TTS request construction, language/rate/pitch limits, base64 response decode, media validation, and the TTS endpoint/scope. Keep SSML unsupported.
- [ ] **Green:** Add the TTS artifact/capability and the exact grant carve-out already enforced by the router: bounded response mode, `SPEECH_AUDIO_MAX_BYTES`, and `60_000` ms timeout.
- [ ] Preserve the existing one-active-playback controller; do not introduce a second playback path.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_tts_returns_golden_audio_via_blob -- --nocapture`
- Expected: fails because the package does not declare or ship `speech.synthesize@1`.
- Run (green fixture): `mise run plugin:refresh-google-cloud-fixture`
- Expected: the TTS Component and updated package fixture verify with the dev public key.
- Run (green test): `mise run test google_cloud_runtime_tts_returns_golden_audio_via_blob -- --nocapture`
- Expected: exact request, fixed MP3 bytes, one-time Blob transfer, no leaked output resource, and no changed instance pin.

### Task 8: Normalize TTS provider failures

**Seam:** TTS.

**Outcome:** TTS IAM/rate-limit/malformed-audio responses preserve stable host behavior without partial playback.

**Files:**

- Modify: `runtime-plugins/google-cloud/protocol/src/lib.rs`
- Create: `runtime-plugins/google-cloud/tests/fixtures/tts/error-403.json`, `runtime-plugins/google-cloud/tests/fixtures/tts/error-429.json`, `runtime-plugins/google-cloud/tests/fixtures/tts/malformed-base64.json`, `runtime-plugins/google-cloud/tests/fixtures/tts/oversized-audio.json`
- Modify: `runtime-plugins/google-cloud/tts/fixtures/langnext-google-cloud-tts.wasm`, `runtime-plugins/google-cloud/tts/fixtures/langnext-google-cloud-tts.wasm.sha256`, `runtime-plugins/google-cloud/plugin.json`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`, `src/features/speech/speechPlaybackController.test.ts`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_tts_failure_does_not_return_partial_audio` with fixed 403, 429, malformed-base64, and oversized-audio fixtures; assert stable codes and an empty caller result.
- [ ] **Green:** Add only the missing TTS error/media checks.
- [ ] Keep the existing playback controller regression test green; no controller rewrite is in scope.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_tts_failure_does_not_return_partial_audio -- --nocapture`
- Expected: at least one fixture returns an incorrect code or partial bytes.
- Run (green fixture): `mise run plugin:refresh-google-cloud-fixture`
- Expected: TTS error/media changes are present in the verified package fixture.
- Run (green test): `mise run test google_cloud_runtime_tts_failure_does_not_return_partial_audio -- --nocapture`
- Run (regression): `bun test src/features/speech`
- Expected: TTS failures return no audio and existing one-active-playback behavior still passes.

### Task 9: Activate the complete package through authoritative routing

**Seam:** Atomic runtime lifecycle.

**Outcome:** Only the complete four-Component package can be explicitly activated, after which Translate, Detect, OCR, and TTS resolve from one instance pin and one grant-set revision.

**Files:**

- Modify: `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/services/service_capabilities.rs`
- Modify: `src-tauri/src/services/ocr_services.rs`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_complete_package_routes_all_capabilities_from_one_pin`. Install the complete dev-signed fixture, preview/apply one explicit transition, resolve and invoke all four public capability traits, and assert the same package digest/grant-set revision remains authoritative for every call.
- [ ] **Green:** Route OCR through `RuntimeRouter`, compile the signed per-capability artifact, add the post-compile authoritative recheck, and construct `WasmOcrImageAdapter`. Reuse existing Translate/Detect/TTS routing; do not add per-capability pins or fallback.
- [ ] **Green:** Reject partial package manifests at lifecycle preview through the existing source capability-major compatibility rule.
- [ ] Add this exact required test name to aggregate `google-cloud` conformance. Do not add the package to application bootstrap yet.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_complete_package_routes_all_capabilities_from_one_pin -- --nocapture`
- Expected: fails because OCR still resolves only the bundled capability registry and cannot follow the active Wasm pin.
- Run (green): `mise run test google_cloud_runtime_complete_package_routes_all_capabilities_from_one_pin -- --nocapture`
- Expected: all four traits execute through one package digest/grant-set revision and no mixed executor state is persisted.

### Task 10: Cancel authenticated capability work without fallback

**Seam:** Request cancellation.

**Outcome:** Cancelling Translate, Detect, OCR, or TTS stops token/network/guest work, cleans Blob resources, and never switches executors.

**Files:**

- Modify: `src-tauri/src/services/wasm_runtime/network_handle.rs`, `src-tauri/src/services/wasm_runtime/executor.rs`
- Modify: `src-tauri/src/services/ocr_services.rs`, `src-tauri/src/services/speech_services.rs`, `src-tauri/src/cmds/service_translation.rs`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_cancellation_stops_active_capability_without_fallback` as one table-driven public workflow test over Translate, Detect, OCR, and TTS. Block the OAuth or HTTPS boundary, cancel through `RequestSessionRegistry`, and assert stable cancellation, zero fallback calls, and zero request-owned Blob resources.
- [ ] **Green:** Propagate the existing `CancelToken` through Google token acquisition, broker transport, Wasm execution, and OCR/TTS Blob cleanup for only the failing cases.
- [ ] Add this exact required test name to aggregate `google-cloud` conformance.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_cancellation_stops_active_capability_without_fallback -- --nocapture`
- Expected: at least one capability continues auth/network work, falls back, or retains a Blob after cancellation.
- Run (green): `mise run test google_cloud_runtime_cancellation_stops_active_capability_without_fallback -- --nocapture`
- Expected: every table case cancels through its public workflow with no fallback or leaked resource.

### Task 11: Fail safely on guest traps and resource limits

**Seam:** OCR.

**Outcome:** A trapping or oversized-output OCR artifact returns a stable error, releases its input Blob, and leaves explicit rollback available.

**Files:**

- Create: `runtime-plugins/conformance/wasm-ocr-trap-component/Cargo.toml`, `runtime-plugins/conformance/wasm-ocr-trap-component/src/lib.rs`
- Create: `runtime-plugins/conformance/wasm-ocr-oversized-component/Cargo.toml`, `runtime-plugins/conformance/wasm-ocr-oversized-component/src/lib.rs`
- Modify: `.mise/tasks/plugin/build-conformance`
- Modify: `src-tauri/src/services/wasm_runtime/executor.rs`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_ocr_trap_and_limit_cleanup_preserve_rollback`. Build dev-signed test packages whose OCR artifact is a test-only `ocr-image-world` trap or oversized-output Component, invoke through `OcrServiceService::recognize`, and assert `plugin_unavailable`/`invalid_response`, zero request-owned Blobs, unchanged instance pin, and successful rollback preview.
- [ ] **Green:** Add the two minimal test-only conformance Components and build them from `plugin:build-conformance`; do not add failure modes to the production Google Cloud guest.
- [ ] **Green:** Add only the missing OCR execution cleanup/error mapping. Do not add a guest fallback, shadow execution, or pin mutation on invocation failure.
- [ ] Add this exact required test name to `google-cloud-ocr` and aggregate `google-cloud` conformance.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_ocr_trap_and_limit_cleanup_preserve_rollback -- --nocapture`
- Expected: fails because the OCR failure Components do not exist and the installed failure path is unproven.
- Run (green fixtures): `mise run plugin:build-conformance`
- Expected: both test-only OCR failure Components build against frozen WIT v1.
- Run (green test): `mise run test google_cloud_runtime_ocr_trap_and_limit_cleanup_preserve_rollback -- --nocapture`
- Expected: both cases fail stably, clean resources, preserve the pin, and retain rollback preview.

### Task 12: Carry provider-attempt provenance

**Seam:** Provider-attempt provenance.

**Outcome:** Public workflows can distinguish local/preflight/cancelled execution from completed auth/network/provider attempts before health recording exists.

**Files:**

- Modify: `src-tauri/src/domain/service_capability.rs`
- Modify: `src-tauri/src/services/google_cloud.rs`
- Modify: `src-tauri/src/services/wasm_runtime/host.rs`, `src-tauri/src/services/wasm_runtime/store.rs`, `src-tauri/src/services/wasm_runtime/executor.rs`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_provider_attempt_provenance_distinguishes_no_attempt_cancel_and_completed`. Through public capability calls with a retained tracker, cover local invalid input, cancellation while in flight, token-exchange failure, transport failure, provider HTTP error, and success; assert fixed `ProviderAttemptState` values. Resolution failures are covered in Task 14 and create no `ExecutionContext`.
- [ ] **Green:** Add cloneable `ProviderAttemptTracker` to `ExecutionContext`. Set `Started` only after principal/grant authorization enters host auth/broker work, `Completed` when auth/network/provider work returns, and `Cancelled` when cancellation wins. Leave local/resolution failures `NotStarted`.
- [ ] **Green:** Update both bundled Google Cloud and Wasm host execution so rollback behavior records provenance consistently without exposing it over WIT or frontend IPC.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_provider_attempt_provenance_distinguishes_no_attempt_cancel_and_completed -- --nocapture`
- Expected: fails because `ExecutionContext` has no provider-attempt state and workflows cannot distinguish the cases.
- Run (green): `mise run test google_cloud_runtime_provider_attempt_provenance_distinguishes_no_attempt_cancel_and_completed -- --nocapture`
- Expected: every case reports its fixed state; no token, provider body, or user content enters the tracker.

### Task 13: Persist independent capability health

**Seam:** Capability health storage.

**Outcome:** SQLite stores only the latest ready/degraded result per instance and exact capability major; absence means not checked.

**Files:**

- Create: `src-tauri/migrations/0023_integration_capability_health.sql`
- Create: `src-tauri/src/domain/integration_capability_health.rs`
- Create: `src-tauri/src/repositories/integration_capability_health.rs`
- Modify: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/repositories/tests.rs`

**Steps:**

- [ ] **Red:** Add `integration_capability_health_round_trip_is_scoped_by_instance_and_capability`. Through repository APIs, record degraded Translate and ready OCR rows, replace only Translate, and assert OCR is byte-for-byte unchanged.
- [ ] **Green:** Add migration `0023` with an instance foreign key, exact capability ID, constrained `ready|degraded` status, sanitized optional error code, timestamp, and `(integration_instance_id, capability_id)` primary key.
- [ ] **Green:** Add repository `upsert_result`, `list_for_instance`, and `delete_for_instance`; no repository API accepts provider messages or user content.

**Validation:**

- Run (red): `mise run test integration_capability_health_round_trip_is_scoped_by_instance_and_capability -- --nocapture`
- Expected: fails because migration/table/domain/repository APIs do not exist.
- Run (green): `mise run test integration_capability_health_round_trip_is_scoped_by_instance_and_capability -- --nocapture`
- Expected: only the selected capability row changes and cascade delete removes instance-owned rows.

### Task 14: Record independent Translate and Detect health

**Seam:** Capability health projection.

**Outcome:** Text capability workflow results update only their own rows and appear as sanitized `IntegrationInstanceDto.capability_health` entries.

**Files:**

- Modify: `src-tauri/src/domain/service_integration.rs`, `src-tauri/src/services/service_integrations.rs`
- Modify: `src-tauri/src/cmds/service_translation.rs`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_text_capability_health_is_independent`. Run local validation failure, resolution failure, cancelled Translate, completed Translate IAM failure, and successful Detect through the public workflows. Assert only the `Completed` Translate/Detect attempts create rows: degraded Translate and ready Detect with timestamps, while OCR/TTS remain absent.
- [ ] **Green:** Project repository rows onto a sanitized DTO. Record only when `ExecutionContext::provider_attempt` is `Completed`, store only `CapabilityErrorCode::as_str()` on failure, and clear it on success.
- [ ] Keep `NotStarted`, `Started`, and `Cancelled` states as no-ops; do not infer attempt provenance from error text.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_text_capability_health_is_independent -- --nocapture`
- Expected: fails because DTOs and workflows do not expose or record capability health.
- Run (green): `mise run test google_cloud_runtime_text_capability_health_is_independent -- --nocapture`
- Expected: only completed Translate/Detect attempts produce independent rows; no preflight/cancelled/unrelated row is synthesized.

### Task 15: Record OCR health through the OCR workflow

**Seam:** Capability health projection.

**Outcome:** Vision success/failure changes only `ocr.image@1` health.

**Files:**

- Modify: `src-tauri/src/services/ocr_services.rs`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_ocr_health_does_not_change_text_or_tts`. Seed text/TTS rows, run a Vision provider failure through `OcrServiceService::recognize`, and assert only OCR becomes degraded.
- [ ] **Green:** Record the normalized result immediately around the plugin OCR provider call; leave Baidu and frontend AI OCR health behavior unchanged.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_ocr_health_does_not_change_text_or_tts -- --nocapture`
- Expected: OCR has no recorded row after the provider attempt.
- Run (green): `mise run test google_cloud_runtime_ocr_health_does_not_change_text_or_tts -- --nocapture`
- Expected: only `ocr.image@1` changes.

### Task 16: Record TTS health through the Speech workflow

**Seam:** Capability health projection.

**Outcome:** TTS success/failure changes only `speech.synthesize@1` health.

**Files:**

- Modify: `src-tauri/src/services/speech_services.rs`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_tts_health_does_not_change_translate_detect_or_ocr`. Seed other rows, run a successful TTS call, and assert only TTS becomes ready and clears its prior error code.
- [ ] **Green:** Record the normalized result around the existing Speech capability call without changing returned bytes or playback behavior.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_tts_health_does_not_change_translate_detect_or_ocr -- --nocapture`
- Expected: the existing TTS row remains degraded or absent.
- Run (green): `mise run test google_cloud_runtime_tts_health_does_not_change_translate_detect_or_ocr -- --nocapture`
- Expected: only `speech.synthesize@1` becomes ready.

### Task 17: Invalidate health on credential or config changes

**Seam:** Capability health projection.

**Outcome:** Remote-relevant integration saves invalidate stale capability results, while display-only edits do not.

**Files:**

- Modify: `src-tauri/src/services/service_integrations.rs`
- Test: `src-tauri/src/services/service_integrations.rs`

**Steps:**

- [ ] **Red:** Add `service_integration_remote_mutation_invalidates_capability_health`. Seed all four rows, prove rename preserves them, then replace the credential or change project/location config and assert all rows are deleted in the same committed mutation.
- [ ] **Green:** Call repository invalidation only for credential revision/config changes; retain existing token eviction and instance auth-health transitions.

**Validation:**

- Run (red): `mise run test service_integration_remote_mutation_invalidates_capability_health -- --nocapture`
- Expected: stale rows survive a remote-relevant save.
- Run (green): `mise run test service_integration_remote_mutation_invalidates_capability_health -- --nocapture`
- Expected: rename preserves rows; credential/config mutation removes them atomically.

### Task 18: Invalidate health on package, permission, and grant changes

**Seam:** Atomic runtime lifecycle.

**Outcome:** Applying or rolling back an instance runtime authority change removes stale capability results in the same transaction.

**Files:**

- Modify: `src-tauri/src/services/runtime_lifecycle.rs`
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_authority_change_invalidates_capability_health_atomically`. Seed all rows, apply a package/grant-set transition, assert rows are absent, record new rows, roll back, and assert they are absent again.
- [ ] **Green:** Invalidate inside successful apply/rollback transactions only. Failed preview, stale CAS, rejected permissions, or failed apply must preserve source pin, grant, bindings, and health rows.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_authority_change_invalidates_capability_health_atomically -- --nocapture`
- Expected: stale rows survive at least one successful authority transition.
- Run (green): `mise run test google_cloud_runtime_authority_change_invalidates_capability_health_atomically -- --nocapture`
- Expected: successful apply/rollback removes rows; failed transitions mutate nothing.

### Task 19: Display capability-specific status

**Seam:** Capability status UI.

**Outcome:** Integration, OCR, and Speech editors show ready, degraded, or not checked for the relevant capability without raw provider content.

**Files:**

- Modify: `src/storage/types.ts`
- Create: `src/features/plugins/capabilityHealthPresentation.ts`, `src/features/plugins/capabilityHealthPresentation.test.ts`
- Modify: `src/features/plugins/IntegrationEditor.tsx`, `src/features/ocr/OcrServiceEditor.tsx`, `src/features/speech/SpeechServiceEditor.tsx`
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`

**Steps:**

- [ ] **Red:** Add `capability health presentation distinguishes absent ready and degraded rows` using fixed DTO literals and asserting only capability label, status label, normalized code, and timestamp are exposed.
- [ ] **Green:** Implement the pure presentation mapping, show all declared capabilities in `IntegrationEditor`, and show the selected OCR/TTS capability status in their editors using existing integration list data.
- [ ] Use existing layout/typography primitives; add no new form primitive, provider message, request content, or tooltip containing sensitive data.

**Validation:**

- Run (red): `bun test src/features/plugins/capabilityHealthPresentation.test.ts`
- Expected: fails because the presentation module does not exist.
- Run (green): `bun test src/features/plugins/capabilityHealthPresentation.test.ts`
- Run: `mise run typecheck`
- Expected: presentation test and TypeScript compile pass.

### Task 20: Finalize the complete package and prove atomic activation

**Seam:** Atomic runtime lifecycle and package developer CLI.

**Outcome:** The app can import the complete signed package without auto-switching an instance; explicit activation and rollback move Translate/Detect/OCR/TTS bindings together.

**Files:**

- Modify: `runtime-plugins/google-cloud/plugin.json`, `.mise/tasks/plugin/build-google-cloud`, `.mise/tasks/plugin/refresh-google-cloud-fixture`, `.mise/tasks/plugin/conformance`
- Modify: `src-tauri/src/state.rs`
- Release output: `src-tauri/resources/plugins/com.langnext.google-cloud-1.2.0.lnplugin` — production-signed archive copied by release CI; not produced or committed by normal development builds.
- Test: `src-tauri/src/services/google_cloud_runtime_tests.rs`

**Steps:**

- [ ] **Red:** Add `google_cloud_runtime_bundled_package_requires_explicit_atomic_transition_and_rolls_back_all_bindings`. Discover/import the bundled archive, assert an existing instance remains Bundled Rust, bind Profile/OCR/Speech resources, apply one preview with all four capabilities and one complete grant-set revision, then roll back and assert every binding follows the restored identity.
- [ ] **Green:** Require all four Components, exact schemas/locales/fixtures, and adjacent digest files in `plugin:build-google-cloud`; generate the complete signed file index.
- [ ] **Green:** Add Google Cloud archive prefix/env discovery to `state.rs`, but do not add it to `is_host_allowed_vendor_default` and do not auto-pin new or existing instances.
- [ ] **Green:** Build the aggregate `google-cloud` conformance list only from the exact named tests introduced in Tasks 1–18 plus existing generic Wasm/resource tests; do not add unnamed tests after implementation.
- [ ] **Green:** Keep Bundled Rust rollback available for one stable release. Reject incomplete capability-major sets, mixed executor state, stale preview/CAS, or partial grant authority.
- [ ] **Release:** After offline production signing/finalization, copy the exact verified archive to `src-tauri/resources/plugins/com.langnext.google-cloud-1.2.0.lnplugin`; `src-tauri/tauri.conf.json` already packages `resources/plugins/`.

**Validation:**

- Run (red): `mise run test google_cloud_runtime_bundled_package_requires_explicit_atomic_transition_and_rolls_back_all_bindings -- --nocapture`
- Expected: fails because bootstrap discovery does not recognize the already-complete Google Cloud archive.
- Run (green fixture): `mise run plugin:refresh-google-cloud-fixture`
- Expected: the complete four-Component fixture package verifies with the dev public key.
- Run (green test): `mise run test google_cloud_runtime_bundled_package_requires_explicit_atomic_transition_and_rolls_back_all_bindings -- --nocapture`
- Run (green build): `mise run plugin:build-google-cloud -- --self-test`
- Run (green conformance): `mise run plugin:conformance google-cloud`
- Expected: atomic activation/rollback, deterministic package self-test, and every required named conformance test pass; zero or missing required tests fail closed.

## Final Validation

Use the committed dev fixture key only for local validation. Release CI substitutes the production public key and receives externally signed exact `plugin.json` bytes; normal build tasks never read a production private key.

```bash
mise run plugin:build-google-cloud
mise run plugin:sign-staging -- \
  runtime-plugins/dist/staging/com.langnext.google-cloud-1.2.0 \
  0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a
mise run plugin:finalize-package -- \
  runtime-plugins/dist/staging/com.langnext.google-cloud-1.2.0 \
  runtime-plugins/dist/com.langnext.google-cloud-1.2.0.lnplugin \
  --public-key-file runtime-plugins/conformance/fixtures/packages/keys/vendor-public-key.hex
mise run plugin:verify -- \
  runtime-plugins/dist/com.langnext.google-cloud-1.2.0.lnplugin \
  --public-key-file runtime-plugins/conformance/fixtures/packages/keys/vendor-public-key.hex
mise run plugin:check-no-wasi
mise run plugin:conformance google-cloud
mise run test google_cloud_runtime -- --nocapture
mise run test integration_capability_health -- --nocapture
# Existing pre-Phase-11 safeguards required by the original Phase 7 scope:
mise run test google_cloud_dependency_protected_delete_preserves_instance_and_credentials -- --nocapture
mise run test google_cloud_export_import_round_trip_preserves_exact_runtime_requirement -- --nocapture
mise run test
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run build
```

Release CI, after offline production signing and `plugin:verify` with the production public key, copies the verified archive into the Tauri resource directory:

```bash
install -m 0644 \
  runtime-plugins/dist/com.langnext.google-cloud-1.2.0.lnplugin \
  src-tauri/resources/plugins/com.langnext.google-cloud-1.2.0.lnplugin
```

Expected:

- One verified package contains exactly four capability Components selected by the existing per-capability artifact router.
- The guest never receives service-account JSON, JWT assertions, access tokens, OAuth audience, or scope strings.
- Translate/Detect, OCR, and TTS use only their declared endpoint and host-derived scope.
- OCR/TTS Blob resources are bounded, cancellable, single-owner, and cleaned after success/failure/cancellation.
- Capability health is independent and sanitized; authority/config/credential changes invalidate stale rows atomically.
- Explicit apply/rollback changes one instance/package/grant-set identity for every binding; no mixed executor state is persisted.
- Dependency-protected delete and runtime-requirement export/import safeguards remain green without Phase 11 behavior changes.
- Full Rust/frontend/build/format checks pass.

## Manual Validation

Run `mise run smoke:google-cloud` with user-supplied test credentials. The task runs the required Google Cloud fixture self-test and conformance suite, supplies a temporary dev-only fixture vendor trust root, then starts Tauri. Use `mise run smoke:google-cloud -- --preflight-only` to run only the non-interactive preflight:

1. Create one Google Cloud integration and bind Translate, OCR, and Speech resources.
2. Confirm the imported package does not activate automatically.
3. Preview and approve the complete endpoint/auth grant set, then activate the package once.
4. Execute Translate, Detect, OCR, and TTS separately; cancel one active request per capability.
5. Revoke one capability IAM permission and confirm only that capability becomes degraded.
6. Replace credentials and confirm all capability results return to not checked while instance auth validation updates separately.
7. Roll back once and confirm every Profile/OCR/Speech binding follows Bundled Rust.
8. Inspect logs, DTOs, history, export, and crash output for credentials, tokens, source text, OCR images/text, and audio.

## Failure Behavior

- Unknown auth policy, wrong capability, wrong package/instance principal, endpoint mismatch, or grant mismatch — deny before token exchange and transport.
- Token/auth failure — keep instance auth health separate; record a sanitized degraded result only for a completed capability attempt.
- Capability IAM/quota/provider failure — update only the invoked capability row with a normalized code.
- Local validation failure or user cancellation — return the existing stable error and leave capability health unchanged.
- Guest trap, malformed response, or resource limit — return a stable capability error, clean resources, and retain explicit instance rollback.
- Credential/config/package/permission/grant change — evict token cache as applicable and delete stale capability health in the same successful mutation.
- Failed lifecycle preview/apply/rollback — preserve the source pin, grant-set revision, bindings, preferences, and capability health.

## Privacy and Security

- Service-account JSON remains write-only in the host vault.
- JWT signing, OAuth exchange/cache, audience, scope selection, and bearer injection remain host-owned.
- Access tokens never cross WIT or frontend IPC and are excluded from `Debug`, errors, logs, DTOs, and export.
- OCR image bytes cross the guest boundary only as an owned/borrowed Blob resource, never copied guest JSON.
- Translation text, OCR image/text, and audio are excluded from default logs and capability-health records.
- Fixed Google API origins use signed manifest/grant authority; no user endpoint-trust approval is introduced for these endpoints.

## Rollout Notes

- Develop in order: authenticated broker, Translate, Detect, OCR, TTS, health, UI, atomic lifecycle.
- Intermediate package fixtures are test-only and must not enter application resources.
- Release CI copies only the externally signed and verified final archive to `src-tauri/resources/plugins/com.langnext.google-cloud-1.2.0.lnplugin` before Tauri bundling.
- Ship/import only the complete signed four-Component package.
- Existing and new Google Cloud instances remain Bundled Rust until an explicit preview/approval/apply transition.
- Retain Bundled Rust rollback for one stable release; remove it only in the later legacy-retirement phase.

## Risks and Mitigations

- **Authenticated guest egress broadens authority** — derive audience/scopes from the host registry, bind every request to principal/capability/endpoint/grant, and deny before transport.
- **One package can hide partial capability failures** — use per-capability installed tests and health rows, then require one aggregate atomic lifecycle suite before rollout.
- **Same version changes during development** — keep intermediate archives test-only; release identity is the exact final signed archive digest.
- **Large OCR/audio payloads** — enforce existing byte/time limits, Blob ownership, cancellation, and cleanup; do not copy payloads into health/log records.
- **Stale health after authority changes** — delete rows in the same transactions that change credentials, config, package, permissions, or grant revision.

## Open Questions

- Confirm the proposed seams before implementation begins, as required by the TDD workflow.
