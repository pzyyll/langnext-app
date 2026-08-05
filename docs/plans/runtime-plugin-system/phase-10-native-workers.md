# Phase 10: PaddleOCR Native Worker and Model Delivery Implementation Plan

**Goal:** Deliver first-party local OCR through a trusted out-of-process PaddleOCR worker whose signed plugin package contains no model bytes, while the host-owned plugin configuration page lets the user explicitly download and verify the required PaddleOCR model bundle.

**Inputs:** Phases 2, 4, and 6; the runtime plugin architecture; the accepted Windows runtime payload of signed `worker.exe` + required DLLs; and the requirement that model download begin only from a button on the plugin configuration page.

**Assumptions:**

- The first production package target is `{ "platform": "windows", "architecture": "x86_64" }`, matching the existing `PackageTargetConstraint`; macOS, Linux, and Windows ARM64 require later target-specific slices.
- The accepted native payload is one host-controlled runtime directory containing `worker.exe` plus its exact required DLL dependency closure. Every executable/DLL is declared as `runtime-artifact` in the signed file index; the directory itself is not treated as a signature boundary.
- The runtime directory contains no Python runtime, model files, shell scripts, executable archives, unindexed files, debug symbols, or optional plugins. DLLs are loaded only by the child worker process, never into the Tauri core process. The signed package still contains mandatory `plugin.json`, configuration schema, license notices, publisher key/signature material, and icons required by the package contract.
- The model control is rendered by the existing host-owned `IntegrationEditor`; it is not a Phase 9 custom page and does not execute plugin JavaScript.
- The first release uses the latest verified stable baseline as of 2026-08-06: PaddleOCR `v3.7.0`, PaddlePaddle/Paddle Inference `v3.3.0`, and the unified 50-language `PP-OCRv6_medium` detection + recognition models.
- Model download does not happen during package install, instance creation, activation, validation, startup, import, or OCR execution. Only an explicit user action starts it.
- Downloaded model files are host-managed product resources, not plugin package contents, configuration JSON, export data, rollback snapshots, or BlobHandle payloads.

**Architecture:** A vendor-signed `.lnplugin` package declares one Windows x64 `runtime-artifact` executable and one signed top-level `modelResources` descriptor, but contains no model bytes. One host-owned Download action retrieves the two pinned official PP-OCRv6 medium TAR artifacts (detection + recognition), verifies archive and expanded-file digests, then atomically installs them into one content-addressed private model resource. RuntimeRouter starts the verified worker without a shell, passes only host-generated arguments including the verified model root, exchanges bounded versioned frames, and implements the existing text-only `ocr.image@1` contract (`pngBase64` request, `{ text }` response); BlobHandle/chunk conversion remains internal to the native adapter.

**Tech Stack:** Rust 2024, Tauri 2.11.x commands and Channel, React 19, TanStack Query, Base UI, host-owned bounded HTTP, TAR extraction with path and size validation, framed serde protocol, Windows Job Objects/process APIs, PaddleOCR C++ `v3.7.0`, PaddlePaddle/Paddle Inference `v3.3.0`, Visual Studio 2022, CMake 3.29, Bun, mise.

---

## Dependencies

- Phases 2, 4, and 6 complete.
- Phase 9 is not required; model management remains host-rendered in `IntegrationEditor`.
- The locked release baseline below is used; implementation must not silently upgrade any component.
- The remaining runtime-inventory/size and model-license gates below are not yet complete and block Task 1.

## Locked Release Baseline

Verified against official release metadata and model bytes on 2026-08-06.

- **PaddleOCR:** `v3.7.0`, release date 2026-06-11, commit `b03f46425e8ff4442b268ce449e3eef758146cd4`.
- **PaddlePaddle/Paddle Inference:** `v3.3.0`, release date 2026-01-31, commit `cbf3469113cd76b7d5f4cba7b8d7d5f55d9e9911`.
- **Model resource:** `pp-ocrv6-medium`, model API version `1`, containing `PP-OCRv6_medium_det` and `PP-OCRv6_medium_rec`.
- **Languages:** one unified model supports Chinese, English, Japanese, and 46 Latin-script languages (50 total); no language-specific model switching in this phase.
- **Windows toolchain:** Visual Studio 2022 and CMake 3.29, matching the official Windows C++ deployment guide.
- **License baseline:** PaddleOCR and PaddlePaddle source repositories are Apache-2.0. Model-weight redistribution must still be confirmed because the downloaded model TAR files contain no embedded license file.

### Pinned Official Model Artifacts

| Role        | Official URL                                                                                                            | Bytes      | SHA-256                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| Detection   | `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_det_infer.tar` | 62,279,680 | `144d0621e059566e5086e228829171591c144c2deb07b2dad4962214fbabfcf7` |
| Recognition | `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_rec_infer.tar` | 76,851,200 | `4eecc1c6a4623765042e6fc15446da0da110b7d875b6b72b2d351d2b2dbd4da6` |

Total download size is 139,130,880 bytes; total expanded file size is 139,110,993 bytes across six files. The descriptor uses a 150 MiB named total-download cap, a 150 MiB named expanded cap, and an exact six-file allowlist. The upstream URLs return `200 OK` without redirects; any changed bytes fail the pinned digest.

### Expanded File Index

| Path                                            | Bytes      | SHA-256                                                            |
| ----------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `PP-OCRv6_medium_det_infer/inference.json`      | 312,150    | `0f1a7ec35da36173529c7a60238b7f7919e3831929c3f700ad90ad4896adecd5` |
| `PP-OCRv6_medium_det_infer/inference.pdiparams` | 61,960,476 | `85218d2e3d98f5a21c58b4220627be923a97aee5db3cc71f39536ab31ac53960` |
| `PP-OCRv6_medium_det_infer/inference.yml`       | 886        | `7298d5ead546584af2504d03355f881ac7a7bc0eb1e282d3e159277c1d0af871` |
| `PP-OCRv6_medium_rec_infer/inference.json`      | 221,814    | `0b2e25e990bd072f1bf77d59d67d508bce6c4bd44af6624e0fb27d6da2cd00e8` |
| `PP-OCRv6_medium_rec_infer/inference.pdiparams` | 76,465,087 | `1b01c79a914587933f615569e75de54f2e638ebb5d3f3b3c1b38c24ede8c7319` |
| `PP-OCRv6_medium_rec_infer/inference.yml`       | 150,580    | `991b700facf5b50a7de193468207d5f4255b538dde0d312ae3b7c7a9b6873129` |

## Remaining Pre-implementation Gates

- Build the Windows x64 CPU runtime with PaddleOCR `v3.7.0` and Paddle Inference `v3.3.0`; record the exact `worker.exe` + DLL dependency closure, licenses, per-file hashes, and total installed/compressed size.
- Run `dumpbin /DEPENDENTS` recursively and a clean-machine smoke test with poisoned current directory/PATH. Every non-system DLL must resolve from the signed runtime directory; undeclared DLL loading fails the gate.
- Measure every runtime file and the complete directory against the existing per-entry, archive, and total-decompressed package caps. Add native-package-specific limits only from measured evidence.
- Confirm the redistribution terms for Paddle Inference/OpenCV DLLs and the two official PP-OCRv6 model archives. Until model terms are confirmed, download models directly from the pinned official URLs; do not mirror or bundle the model weights.

If the dependency inventory is incomplete, package limits are unjustified, or license review fails, stop before Task 1 and make a product packaging decision.

## Explicit Scope

- Install one vendor-signed Windows x64 PaddleOCR native worker package.
- Show the required model, installed state, byte size, and Download button on the existing plugin instance configuration page.
- Download only after an explicit click, with visible bounded progress and cancellation.
- Verify and atomically install the exact signed model bundle.
- Run `ocr.image@1` through the worker after the model is ready.
- Expose sanitized health and failure states in the existing editor.

## Out of Scope

- Phase 9 custom plugin pages or plugin-authored UI.
- Automatic/background model download, remote package installation, or marketplace behavior.
- User-selected model URLs, local model paths, arbitrary worker arguments, or arbitrary archives.
- Model deletion, shared model cache eviction, delta updates, resumable downloads, GPU acceleration, and additional model variants in the first slice.
- macOS, Linux, Windows ARM64, third-party native publishers, Python workers, dynamic libraries loaded into Tauri core, or fallback to cloud OCR.

## File Map

- Create: `src-tauri/src/domain/native_worker.rs` — native runtime descriptors, protocol frames, worker health, and stable errors.
- Create: `src-tauri/src/domain/plugin_model.rs` — signed model descriptor, status DTOs, download input/progress, and stable errors.
- Create: `src-tauri/src/services/plugin_models.rs` — model status, bounded download, archive verification, atomic install, and recovery.
- Create: `src-tauri/src/repositories/plugin_model_resources.rs` — installed/download state persistence without exposing paths.
- Create: `src-tauri/migrations/0026_plugin_model_resources.sql` — model resource metadata and operation state.
- Create: `src-tauri/src/cmds/plugin_models.rs` — trusted-app-only status/download/cancel commands.
- Create: `src-tauri/src/services/native_workers/mod.rs` — worker manager and OCR executor.
- Create: `src-tauri/src/services/native_workers/protocol.rs` — bounded length-prefixed protocol codec.
- Create: `src-tauri/src/services/native_workers/process.rs` — exact-path spawn, deadlines, shutdown, and reap.
- Create: `src-tauri/src/services/native_workers/platform/mod.rs`, `src-tauri/src/services/native_workers/platform/windows.rs` — Windows Job Object process-tree control.
- Create: `src/features/plugins/PluginModelResourcesPanel.tsx` — host-owned model status, Download/Cancel actions, and progress UI.
- Create: `src/features/plugins/pluginModelDownloadFlow.ts` — typed frontend status/download workflow used by the panel.
- Create: `src/features/plugins/pluginModelDownloadFlow.test.ts` — frontend workflow behavior at the storage-client seam.
- Create: `runtime-plugins/paddleocr/worker/CMakeLists.txt`, `runtime-plugins/paddleocr/worker/src/main.cpp` — production PaddleOCR worker and deterministic runtime-directory assembly.
- Create: `runtime-plugins/paddleocr/plugin.json`, `runtime-plugins/paddleocr/schemas/config.json`, `runtime-plugins/paddleocr/licenses/` — package metadata only; no model payload.
- Create: `runtime-plugins/conformance/native-worker/Cargo.toml`, `runtime-plugins/conformance/native-worker/src/main.rs` — non-production protocol/crash/hang fixture worker.
- Create: `.mise/tasks/plugin/build-paddleocr-worker`, `.mise/tasks/plugin/build-paddleocr`, `.mise/tasks/plugin/build-native-conformance` — deterministic worker/package/conformance builds.
- Modify: `src-tauri/src/domain/runtime_plugin.rs`, `src-tauri/src/domain/plugin_package.rs`, `src-tauri/src/services/runtime_plugin_contracts.rs`, `src-tauri/src/services/plugin_package.rs` — native target, existing `runtime-artifact` role, package caps, and signed top-level `modelResources` validation.
- Modify: `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/services/service_capabilities.rs`, `src-tauri/src/services/ocr_services.rs`, `src-tauri/src/services/service_integrations.rs`, `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/blob_resources.rs` — native OCR resolution, existing base64/text contract preservation, validation/model readiness, activation readiness, and internal input ownership.
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/cmds/mod.rs` — service composition and registration.
- Modify: `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json` — exact command manifest and trusted-app ACL coverage.
- Modify: `src/storage/types.ts`, `src/storage/client.ts`, `src/query/keys.ts`, `src/query/options.ts` — typed model-resource IPC, Channel integration, and cache queries; reuse existing `invokeEffect` and `runEffectAsPromise` helpers.
- Modify: `src/features/plugins/IntegrationEditor.tsx`, `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts` — configuration-page integration and copy.
- Modify: `.mise/tasks/plugin/conformance` — add fail-closed `native-worker` and `paddleocr` modes with exact required tests.
- Test: package/model/process/protocol/runtime service tests plus PaddleOCR and native-worker conformance fixtures.

## Seams

These seams must be confirmed before implementation tests begin.

- **Package preview/install seam:** `preview_plugin_package` and `approve_plugin_package` accept one vendor runtime directory whose executable and exact DLL closure are individually indexed as `runtime-artifact`, plus a signed top-level `modelResources` declaration; they reject model bytes, undeclared/optional runtime files, wrong targets, or untrusted publishers.
- **Model resource seam:** `list_plugin_model_resources(instanceId)` returns sanitized state; `download_plugin_model({ input: { instanceId, modelId }, progress })` installs one signed model resource containing the exact pinned detection and recognition TAR artifacts after an explicit call; `cancel_plugin_model_download({ input: { instanceId, modelId, operationId } })` cancels only the matching in-flight operation.
- **Configuration-page workflow seam:** Effect-based `pluginModelDownloadFlow` Promise runners map missing/downloading/ready/failed states to Download/Cancel/progress behavior and invalidate the model query after completion.
- **Worker process seam:** `NativeWorkerManager::execute` starts the exact verified worker, completes the versioned handshake, enforces deadlines, and reaps the process tree.
- **OCR capability seam:** `ServiceCapabilityRegistry::resolve_ocr` and the existing `OcrImageCapability::recognize` boundary retain `OcrImageRequest { png_base64, preferences }` and `OcrImageResponse { text }`; the native adapter alone converts bounded image bytes into worker frames.
- **Lifecycle/health seam:** model DTOs own `missing | downloading | ready | failed`; existing integration/capability health remains `Unvalidated/Ready/Degraded`, with stable normalized codes such as `model_missing` and `worker_crashed`, while disabled state continues to derive from the existing instance `enabled` flag.

## Tasks

### Task 1: Accept a signed PaddleOCR runtime directory contract

**Seam:** Package preview/install seam.

**Outcome:** The host accepts a vendor-signed Windows x64 package containing one declared `worker.exe` and its exact declared DLL dependency closure, while model files and every undeclared runtime file are rejected.

**Files:**

- Modify: `src-tauri/src/domain/runtime_plugin.rs`, `src-tauri/src/domain/plugin_package.rs`, `src-tauri/src/services/runtime_plugin_contracts.rs`, `src-tauri/src/services/plugin_package.rs`
- Create: `src-tauri/src/domain/native_worker.rs`, `src-tauri/src/domain/plugin_model.rs`
- Test: package service tests and `runtime-plugins/conformance/fixtures/packages/`

**Steps:**

- [ ] **Red:** Add a package fixture with runtime kind `trusted-native-worker`, `targets: [{ "platform": "windows", "architecture": "x86_64" }]`, and deny-unknown runtime fields `artifact: "runtime/worker.exe"`, `nativeProtocolVersion: 1`, and `nativeDependencies: string[]`. Require one normalized `.exe` path, a named bounded dependency count, normalized unique/sorted `runtime/*.dll` paths, and matching unique `runtime-artifact` file-index entries with bytes/SHA-256; packaged DLLs are exactly `nativeDependencies`. Windows system/API-set libraries are never package entries: the release/runtime classifier permits only modules resolved under `%SystemRoot%\\System32` plus `api-ms-win-*`/`ext-ms-win-*` API-set names, and treats every other DLL as a required packaged dependency. Add one deny-unknown `modelResources` entry shaped `{ id, version, modelApiVersion, languageSet, totalDownloadBytes, expandedBytes, licenseId, licenseNoticePath, artifacts[], files[] }`; each artifact is `{ role, url, bytes, sha256 }`, and each expanded file is `{ path, role, bytes, sha256 }`. Populate it with the two pinned PP-OCRv6 medium artifacts and six-file index above. Assert preview accepts it only for a `vendor` publisher on the explicit PaddleOCR allowlist.
- [ ] Run the focused test and confirm it fails specifically because `runtime.nativeProtocolVersion` and top-level `modelResources` are not implemented; `TrustedNativeWorker` and platform/architecture target constraints already exist.
- [ ] **Green:** Add the optional v1-compatible descriptors and the minimum validator needed for the fixture to pass.
- [ ] Repeat a separate Red → Green cycle for each prohibited case: model bytes; undeclared DLL; declared dependency missing from the file index; indexed DLL absent from `nativeDependencies`; Python/script/archive/debug-symbol payload; second executable; mutable or HTTP model URL; missing digest; path escape/symlink; wrong target; user-approved publisher; non-allowlisted native package. Each Red adds one package-preview test, and each Green adds only the corresponding guard.
- [ ] Reuse `FileRole::RuntimeArtifact`; do not add DLL-specific roles. Compare every measured runtime file and the total runtime directory against `PACKAGE_ENTRY_MAX_BYTES`, `PACKAGE_ARCHIVE_MAX_BYTES`, and `PACKAGE_TOTAL_DECOMPRESSED_MAX_BYTES`; if a limit is exceeded, add a separate Red for the measured package before introducing narrowly named native-package limits.
- [ ] Keep package approval non-executable; activation still requires the Phase 4 execution grant set.

**Validation:**

- Run (red): `mise run test paddleocr_package -- --nocapture`
- Expected: the first new contract scenario fails before descriptor support; each later adversarial fixture fails before its validator exists.
- Run (green): `mise run test paddleocr_package -- --nocapture`
- Expected: the valid vendor runtime directory using existing platform/architecture and `runtime-artifact` contracts passes; models and every undeclared/missing/mismatched runtime dependency fail closed.

### Task 2: Report missing model state through trusted IPC

**Seam:** Model resource seam.

**Outcome:** A PaddleOCR instance reports its declared model as `missing` without downloading anything or exposing a filesystem path.

**Files:**

- Create: `src-tauri/migrations/0026_plugin_model_resources.sql`, `src-tauri/src/repositories/plugin_model_resources.rs`, `src-tauri/src/services/plugin_models.rs`, `src-tauri/src/cmds/plugin_models.rs`
- Modify: repository/service/command module registration, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json`, `src/storage/types.ts`, `src/storage/client.ts`, `src/query/keys.ts`, `src/query/options.ts`
- Test: inline model service/repository tests and command/AppManifest/ACL coverage tests

**Steps:**

- [ ] **Red:** Through `list_plugin_model_resources(instanceId)`, assert an approved PaddleOCR instance returns one sanitized `missing` DTO containing model ID, version, expected download bytes, and license label, but no URL, absolute path, archive file list, or internal error.
- [ ] Run the focused test and confirm it fails because the command/service/table do not exist.
- [ ] **Green:** Add the migration, repository, descriptor resolution, DTO, trusted command, frontend type/client/query, and exact AppManifest/ACL entries required for the assertion.
- [ ] Repeat a separate Red → Green cycle for unknown instance, non-native package, stale package digest, revoked publisher, and plugin-page WebView. Each Red exercises the public command; each Green adds only the required authoritative resolution or ACL guard.
- [ ] Keep the read path free of worker startup, network requests, package mutation, or implicit download.

**Validation:**

- Run (red): `mise run test plugin_model_status -- --nocapture`
- Expected: the missing-state public command test fails before the model resource service exists.
- Run (green): `mise run test plugin_model_status -- --nocapture`
- Expected: missing state is returned without side effects and unauthorized/stale callers are denied.

### Task 3: Download and atomically install the signed model bundle

**Seam:** Model resource seam.

**Outcome:** An explicit trusted-app call downloads the exact PaddleOCR model bundle, reports bounded progress, verifies it, and changes status to `ready` without placing models in the plugin package or config JSON.

**Files:**

- Modify: `src-tauri/src/services/plugin_models.rs`, `src-tauri/src/repositories/plugin_model_resources.rs`, `src-tauri/src/cmds/plugin_models.rs`, `src-tauri/src/services/bounded_http.rs`, `src-tauri/src/state.rs`
- Test: inline service tests using a local deterministic HTTP fixture and temporary app-data directory

**Steps:**

- [ ] **Red:** Call `download_plugin_model({ input: { instanceId, modelId }, progress })` explicitly for the missing `pp-ocrv6-medium` resource and assert the first Channel event carries a new opaque `operationId`, progress spans both artifacts monotonically, both official TAR files are downloaded once, both archive SHA-256 values and the six expanded files are verified, installation is one atomic rename into a content-addressed host-private directory, and public status becomes `ready`.
- [ ] Run the focused test and confirm it fails because the download operation is not implemented.
- [ ] **Green:** Implement one in-flight operation per canonical model-resource descriptor digest, the locked 150 MiB download/expanded caps, exact six-file cap, staging, streaming archive hashing, safe TAR extraction, per-file verification, atomic install, and sanitized progress/result DTOs.
- [ ] Repeat a separate Red → Green cycle for wrong archive digest, oversized body, truncated response, redirect, path escape, duplicate path, symlink, undeclared file, executable file, expanded-size overflow, restart during staging, and concurrent duplicate requests. Each Green adds only the guard/recovery behavior required by that one Red.
- [ ] In a separate Red → Green cycle, call `cancel_plugin_model_download({ input: { instanceId, modelId, operationId } })`; prove only the matching operation is cancelled and then add stale/foreign-operation rejection. Cancellation/failure removes staging data; startup recovery removes incomplete staging and preserves completed content-addressed installs.
- [ ] The download input contains only `instanceId` and `modelId`; cancel additionally contains the opaque `operationId`. The host resolves URL, expected digests, caps, destination, and file index from the active signed package. The worker, plugin config, frontend, and user cannot provide a URL, digest, headers, proxy override, destination, or path.

**Validation:**

- Run (red): `mise run test plugin_model_download -- --nocapture`
- Expected: each new public download behavior fails before its corresponding implementation.
- Run (green): `mise run test plugin_model_download -- --nocapture`
- Expected: the valid bundle becomes ready; every tampered, oversized, unsafe, cancelled, or duplicated operation fails closed without partial installed state.

### Task 4: Add the Download button to the host configuration page

**Seam:** Configuration-page workflow seam.

**Outcome:** The existing integration configuration page shows PaddleOCR model state and starts download only when the user clicks Download.

**Files:**

- Create: `src/features/plugins/PluginModelResourcesPanel.tsx`, `src/features/plugins/pluginModelDownloadFlow.ts`, `src/features/plugins/pluginModelDownloadFlow.test.ts`
- Modify: `src/features/plugins/IntegrationEditor.tsx`, `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`
- Test: `src/features/plugins/pluginModelDownloadFlow.test.ts`

**Steps:**

- [ ] **Red:** Following `installPluginPackageFlow.ts`, mock `@tauri-apps/api/core` at the IPC boundary and test the Promise runner backed by Effect: `missing` exposes Download, invoking Download calls `download_plugin_model` exactly once with `{ instanceId, modelId }` plus a Tauri Channel, forwards typed progress, and invalidates the instance model-resource query when complete.
- [ ] Run the focused test and confirm it fails because the Effect workflow and Promise runner do not exist.
- [ ] **Green:** Implement `downloadPluginModelEffect`, `cancelPluginModelDownloadEffect`, and route/component-facing Promise runners with `invokeEffect`/`runEffectAsPromise`; add the minimum `PluginModelResourcesPanel` wiring with Base UI Button and TanStack Query. Effect owns the multi-step IPC/progress workflow; Query remains the DTO cache.
- [ ] Repeat a separate Red → Green workflow cycle for: downloading disables duplicate Download; Cancel uses the Channel-provided `operationId`; ready shows installed version/size; failed shows sanitized error and Retry; stale instance/package refreshes the query. Implement only one state transition per cycle and never store progress in plugin config, global events, local storage, or exportable DTOs.
- [ ] Mount the panel in `IntegrationEditor` adjacent to the schema-rendered Configuration section. Render it generically from signed model descriptors, not from a PaddleOCR plugin-ID branch.
- [ ] Keep instance Save independent from model download; clicking Download must not save unrelated dirty schema fields.

**Validation:**

- Run (red): `bun test src/features/plugins/pluginModelDownloadFlow.test.ts`
- Expected: each workflow scenario fails before its state/action mapping exists.
- Run (green): `bun test src/features/plugins/pluginModelDownloadFlow.test.ts`
- Expected: Download/Cancel/Retry/ready states and query invalidation pass.
- Manual: open the PaddleOCR instance in `mise run tauri:dev`; confirm no network starts before clicking Download and progress remains on the host configuration page.

### Task 5: Launch a verified worker and complete one protocol handshake

**Seam:** Worker process seam.

**Outcome:** The host starts the exact package worker, completes a bounded versioned handshake, and shuts it down without leaking a process.

**Files:**

- Create: `src-tauri/src/services/native_workers/mod.rs`, `src-tauri/src/services/native_workers/protocol.rs`, `src-tauri/src/services/native_workers/process.rs`, `src-tauri/src/services/native_workers/platform/mod.rs`, `src-tauri/src/services/native_workers/platform/windows.rs`
- Create: `runtime-plugins/conformance/native-worker/Cargo.toml`, `runtime-plugins/conformance/native-worker/src/main.rs`, `.mise/tasks/plugin/build-native-conformance`
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`
- Test: native worker manager tests through `NativeWorkerManager::execute`

**Steps:**

- [ ] **Red:** Execute the conformance worker through `NativeWorkerManager::execute` and assert exact-path spawn without shell/PATH lookup. Open the canonical runtime directory and every declared file without following reparse points; retain directory/file handles that deny write/delete sharing for the entire worker lifetime, hash through those handles, and record volume/file identities. Require eager dependency loading before `ready`, host-side module identity audit against those locked handles, then verify fixed magic/version/package-digest/runtime-set-digest/process-nonce and reap cleanly.
- [ ] Run the focused test and confirm it fails because the manager and protocol do not exist.
- [ ] **Green:** Implement lifetime locked-handle runtime-set verification, directory/reparse checks, length-prefixed handshake, host-side child-module enumeration/file-identity comparison, and Windows Job Object lifecycle. Before accepting `ready`, require every loaded non-system module identity to match a locked signed runtime file; permit system modules only from `%SystemRoot%\\System32` or resolved API-set names. Release locks only after the process is reaped.
- [ ] **Red:** Attempt to replace/delete/rename the runtime directory, `worker.exe`, and a DLL after hashing, during startup, and after `ready`; assert Windows sharing denies every mutation until process reap. **Green:** retain directory/file handles without write/delete sharing for the entire worker lifetime and terminate on any lock/audit failure.
- [ ] **Red:** Spawn from a poisoned current directory/PATH containing same-named DLLs. Use conformance modes that perform normal, delayed, and explicit loads during bootstrap; assert each resolves to the locked signed file identity or fails closed, and assert any new non-system module appearing after `ready` terminates the worker. **Green:** set a host-private working directory, keep native DLLs adjacent to the executable, require all delayed/explicit dependencies to load before handshake, use absolute signed-runtime `LoadLibraryEx` paths, and prohibit dynamic module loading after `ready`.
- [ ] Repeat a separate Red → Green manager cycle for worker/DLL digest mismatch, missing/extra DLL, wrong target, malformed frame, oversized frame, partial frame, wrong protocol version, unknown frame, startup timeout, hang, crash, child process, stdout/stderr flood, and ignored shutdown. Add only the named cap or process-tree behavior required by that cycle.
- [ ] Keep protocol transport separate from diagnostics. Normal logs contain only stable codes, identifiers, timing, and byte counts.

**Validation:**

- Run (red): `mise run test native_worker_process -- --nocapture`
- Expected: each lifecycle/protocol behavior fails before implementation.
- Run (green): `mise run test native_worker_process -- --nocapture`
- Expected: success completes and every malformed, crashed, hung, flooding, or child-spawning worker leaves no process/resource leak.

### Task 6: Build the production PaddleOCR runtime directory

**Seam:** Worker process seam.

**Outcome:** The production Windows x64 runtime directory contains one `worker.exe` plus its exact DLL dependency closure, opens only the host-selected verified model root, and implements the bounded OCR protocol.

**Files:**

- Create: `runtime-plugins/paddleocr/worker/CMakeLists.txt`, `runtime-plugins/paddleocr/worker/src/main.cpp`, `.mise/tasks/plugin/build-paddleocr-worker`
- Test: worker protocol integration tests with a fixed licensed OCR image fixture and independently authored expected plain text

**Steps:**

- [ ] Before coding, audit the locked PaddleOCR `v3.7.0` / Paddle Inference `v3.3.0` C++ APIs and record the exact CPU-only compiler/link settings, Paddle/OpenCV DLL versions, dependency licenses, and reproducible runtime-directory assembly; do not float to newer commits or copy a broad SDK directory.
- [ ] **Red:** Through `NativeWorkerManager::execute`, start the configured real worker with a verified test model root, send one bounded OCR frame derived from the existing `png_base64` request, and assert a known fixture returns the independently specified plain text required by `OcrImageResponse { text }`.
- [ ] Run `mise run test paddleocr_worker -- --nocapture` and confirm the public manager/protocol integration test fails because the production worker artifact does not exist.
- [ ] **Green:** Implement only handshake, model initialization, one `ocr.image@1` request, response, stable error, and shutdown. Use host-generated `--model-root` and process nonce arguments; reject missing/extra/user-controlled arguments.
- [ ] **Red:** Assert the built runtime directory contains exactly one executable and exactly the recursively discovered required DLL closure; each file must match `runtime.artifact`/`runtime.nativeDependencies` and the signed file index. Assert no Python, model, archive, script, cache, debug symbol, unused SDK DLL, or undeclared file exists, and assert the worker rejects a missing/mismatched model API version.
- [ ] **Green:** Add deterministic runtime-directory assembly, recursive `dumpbin /DEPENDENTS` verification, clean-machine smoke execution, license inventory, and model compatibility checks. Package only dependencies demonstrated by the build and smoke test.

**Validation:**

- Run (red): `mise run test paddleocr_worker -- --nocapture`
- Expected: the manager/protocol integration test fails because the production worker artifact and implementation do not exist.
- Run (green): `mise run plugin:build-paddleocr-worker`
- Run: `mise run test paddleocr_worker -- --nocapture`
- Expected: one signed runtime directory with `worker.exe` and the exact DLL closure is produced, dependency verification passes in a clean environment, and the known OCR fixture passes through the real protocol.

### Task 7: Route `ocr.image@1` through PaddleOCR only when the model is ready

**Seam:** OCR capability seam.

**Outcome:** Existing screenshot OCR workflows can use the PaddleOCR instance through `OcrServices` → `ServiceCapabilityRegistry` → RuntimeRouter without changing the public base64/text-only contract, while missing or invalid model state fails before worker startup.

**Files:**

- Modify: `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/services/service_capabilities.rs`, `src-tauri/src/services/ocr_services.rs`, `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/blob_resources.rs`, `src-tauri/src/services/native_workers/mod.rs`, `src-tauri/src/domain/service_integration.rs`
- Test: runtime router, service capability registry, and OCR service tests

**Steps:**

- [ ] **Red:** Invoke the existing public screenshot OCR path with an active PaddleOCR instance and ready verified model. Before spawn, open the canonical model directory and six declared files without following reparse points, deny write/delete sharing for the entire worker lifetime, hash through those handles, and record file identities. Assert `OcrServices` supplies `OcrImageRequest { png_base64, preferences }`, `ServiceCapabilityRegistry::resolve_ocr` resolves a native adapter, the worker completes model initialization before `ready` and echoes the exact model-set digest, and the caller receives `OcrImageResponse { text }` without frontend/storage DTO changes.
- [ ] Run the focused test and confirm it fails because RuntimeRouter does not route native workers.
- [ ] **Green:** Add the minimal `RuntimeAdapter::TrustedNativeWorker`/`ResolvedOcr::Native` resolution, `ServiceCapabilityRegistry` adapter construction, and base64-to-bounded-worker-frame mapping required for the successful call.
- [ ] **Red:** Attempt to replace/delete/rename the model directory or any of its six files after verification, during initialization, and after `ready`; assert mutation is denied until worker reap and a digest/identity mismatch prevents `ready`. **Green:** retain model directory/file locks for the entire worker lifetime and bind the handshake/session to the model-set digest.
- [ ] Repeat a separate Red → Green public OCR cycle for missing model, downloading model, tampered model, stale package digest, stale grant revision, disabled instance, malformed/oversized base64 image, timeout, and cancellation. Assert no worker starts when a precondition fails and no cloud/bundled fallback runs after a native failure; add only the authoritative check and stable error required by that cycle.
- [ ] Preserve the current text-only OCR response; bounding boxes are explicitly out of scope for `ocr.image@1`. Do not pass arbitrary filesystem paths through OCR requests; only the manager supplies the already verified model root during process creation.

**Validation:**

- Run (red): `mise run test paddleocr_runtime -- --nocapture`
- Expected: each route/precondition scenario fails before native routing or its guard exists.
- Run (green): `mise run test paddleocr_runtime -- --nocapture`
- Expected: ready-model OCR succeeds; invalid principals/resources/model states fail before spawn and never fall back silently.

### Task 8: Surface bounded health and complete the vendor package

**Seam:** Lifecycle/health seam.

**Outcome:** The editor distinguishes model readiness from worker health, and the final signed package contains the exact indexed native runtime directory but no models.

**Files:**

- Modify: `src-tauri/src/services/native_workers/mod.rs`, `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/service_integrations.rs`, `src-tauri/src/domain/service_integration.rs`, `src/features/plugins/IntegrationEditor.tsx`
- Create: `runtime-plugins/paddleocr/plugin.json`, `runtime-plugins/paddleocr/schemas/config.json`, `runtime-plugins/paddleocr/licenses/`, `.mise/tasks/plugin/build-paddleocr`
- Modify: `.mise/tasks/plugin/conformance`
- Test: health/lifecycle tests, package verification, native and PaddleOCR conformance

**Steps:**

- [ ] **Red:** Through the existing `service_integrations::validate_instance` path, validate before model download and assert integration health is `Degraded` with stable `model_missing` rather than the current unconditional local-only `Ready` result.
- [ ] Run the focused test and confirm it fails before model readiness participates in validation.
- [ ] **Green:** Add only the model-readiness validation needed for that test while keeping model-resource DTO state separate.
- [ ] **Red:** After model installation, validate again and assert existing integration health reaches `Ready`; **Green:** add only the ready transition.
- [ ] **Red:** Induce a worker crash and assert existing capability health is `Degraded` with stable `worker_crashed`, without adding enum variants or replaying the business request; **Green:** add normalized worker-health composition, bounded startup restart, and manual reset after the named crash-loop threshold.
- [ ] **Red:** Build and inspect the unsigned staging tree; assert the signed file index includes `worker.exe`, every declared required DLL, schema, licenses, icon, and mandatory metadata, while no model bytes, undeclared DLLs, debug symbols, or unrelated SDK files are present.
- [ ] **Green:** Add the deterministic package task, external-signing/finalization inputs, vendor allowlist entry, and release fixture.
- [ ] **Red:** Run `mise run plugin:conformance native-worker`, `mise run plugin:conformance paddleocr`, and `mise run plugin:conformance all`; assert the current harness rejects the new modes or omits required native tests.
- [ ] **Green:** Add fail-closed suites requiring at least these exact tests: `services::native_workers::tests::native_worker_handshake_reaps_process`, `services::native_workers::tests::native_worker_timeout_kills_process_tree`, `services::plugin_models::tests::plugin_model_download_verifies_and_installs_atomically`, `services::paddleocr_runtime_tests::paddleocr_runtime_ocr_returns_expected_text`, and `services::paddleocr_runtime_tests::paddleocr_runtime_missing_model_does_not_spawn_worker`. A missing/non-passing required name or zero executed tests fails the mode; the `all` branch runs both new suites and usage text lists both modes.
- [ ] Keep the model store outside package uninstall. A package uninstall removes no model content in this phase; model cleanup remains a separate product decision.

**Validation:**

- Run (red): `mise run test paddleocr_health -- --nocapture`
- Expected: model/worker health transitions fail before lifecycle composition.
- Run (green): `mise run test paddleocr_health -- --nocapture`
- Run: `mise run plugin:build-paddleocr`
- Run in release CI after signature injection: `mise run plugin:finalize-package runtime-plugins/dist/staging/com.langnext.paddleocr-1.0.0 runtime-plugins/dist/com.langnext.paddleocr-1.0.0.lnplugin`
- Run: `mise run plugin:verify runtime-plugins/dist/com.langnext.paddleocr-1.0.0.lnplugin`
- Run: `mise run plugin:conformance native-worker`
- Run: `mise run plugin:conformance paddleocr`
- Run: `mise run plugin:conformance all`
- Expected: health transitions pass; package verification proves the exact executable/DLL runtime set and zero model payloads; both new conformance suites are fail-closed and part of `all`.

## Final Validation

```bash
mise run plugin:build-native-conformance
mise run plugin:conformance native-worker
mise run plugin:build-paddleocr-worker
mise run plugin:build-paddleocr
# Release CI only, after external signature injection:
mise run plugin:finalize-package runtime-plugins/dist/staging/com.langnext.paddleocr-1.0.0 runtime-plugins/dist/com.langnext.paddleocr-1.0.0.lnplugin
mise run plugin:verify runtime-plugins/dist/com.langnext.paddleocr-1.0.0.lnplugin
mise run plugin:conformance paddleocr
mise run test plugin_model -- --nocapture
mise run test native_worker -- --nocapture
mise run test paddleocr -- --nocapture
bun test src/features/plugins/pluginModelDownloadFlow.test.ts
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run build
mise run tauri:build
```

Manual validation in `mise run tauri:dev`:

1. Install and approve the vendor PaddleOCR package.
2. Create/open a PaddleOCR integration instance.
3. Confirm the configuration page shows the model as missing and no download starts automatically.
4. Click Download, observe progress, cancel once, then retry to completion.
5. Confirm the model becomes ready without changing or saving config JSON.
6. Run screenshot OCR and verify expected local output.
7. Disable/uninstall the package and confirm no worker remains running and no model path is exposed.

Expected: local PaddleOCR works only after explicit verified model download; the package contains only the signed `worker.exe` + required DLL runtime set and no model bytes.

## Failure Behavior

- Missing or downloading model — return `model_missing`; do not start the worker or download automatically.
- Wrong archive/file digest, unsafe path, unexpected file, or size overflow — cancel, delete staging data, preserve prior installed model, and return a stable model error.
- Download cancellation/network failure — keep status missing/failed and permit explicit Retry; never treat partial bytes as installed.
- Worker/DLL digest mismatch, missing dependency, or undeclared runtime file — reject activation/spawn.
- Worker handshake/protocol failure — terminate and reap the process tree; fail the request without fallback.
- OCR timeout/cancel — request cooperative cancellation, then terminate the process tree after the shutdown deadline.
- Crash loop — disable automatic restart and require manual validation/reset.
- Package upgrade with a different model descriptor — keep the old content-addressed model but require explicit download of the new digest before activating the new runtime.

## Privacy and Security

- The worker is first-party native code with current-user OS authority; process isolation is not a permission sandbox.
- Only vendor-signed, host-allowlisted PaddleOCR packages can declare the native runtime.
- Model URLs and expected digests are signed package metadata but are never exposed as editable config or frontend command input.
- The host downloads models; neither plugin code nor worker receives general network authority for model retrieval.
- Model archives contain only declared non-executable data files and are installed under a host-private content-addressed directory.
- The frontend receives status, progress, size, version, license label, and stable errors only—never absolute paths or archive internals.
- OCR images, recognized text, model bytes, worker stdout/stderr, and raw failure bodies are excluded from normal logs.
- Package/model signatures and hashes prove provenance/integrity, not safety; the selected worker/model release still requires license and security review.

## Rollout Notes

- Ship Windows x64 behind a product feature flag until package, model-download, process-tree, and real OCR conformance pass on packaged builds.
- Enable the Download button only after the two official URLs, pinned archive hashes, expanded file index, and model license review are present in signed production metadata.
- Keep model download opt-in and visible; do not prefetch.
- Add macOS/Linux/Windows ARM64 only as separate target slices with their own indexed native runtime set, signing, process-control implementation, model compatibility evidence, and conformance runs.
- Phase 12 retirement is unaffected unless PaddleOCR replaces a concrete legacy local OCR executor.

## Risks and Mitigations

- Native runtime directory exceeds package caps — measure every file and total archive/expanded size, then add native-package-only caps; never broaden Wasm/general entries without evidence.
- DLL dependency closure drifts between builds — pin compiler and Paddle/OpenCV inputs, generate and diff the recursive dependency inventory, and fail packaging on undeclared/unused files.
- Runtime/model replacement after verification — canonicalize without following reparse points, hash through directory/file handles opened without write/delete sharing, compare file identities during module/model initialization, bind handshake to runtime/model-set digests, and retain all locks until process reap.
- DLL search-path hijacking — keep dependencies adjacent to the verified executable, spawn with a host-private working directory and no PATH lookup, audit loaded module paths, harden delayed/explicit loads, and test with poisoned current directory/PATH.
- Official model hosting changes bytes, redirects, or disappears — reject redirects and changed digests, preserve missing state, show Retry/unavailable, and update the signed descriptor only through a reviewed plugin release.
- Large download consumes disk/memory — stream to bounded staging on disk, enforce compressed/expanded caps, and never buffer the full archive in memory.
- Archive extraction attacks — reject absolute paths, traversal, symlinks, duplicates, executables, undeclared files, and expansion beyond signed limits.
- Worker bypasses host policy — first-party allowlist, no secrets by default, no network requirement, process isolation, and explicit product review.
- OCR output changes across upstream releases — pin worker/model revisions and retain independent golden image expectations per release.

## Evidence

- PaddleOCR `v3.7.0` release: <https://github.com/PaddlePaddle/PaddleOCR/releases/tag/v3.7.0>
- PaddlePaddle `v3.3.0` release: <https://github.com/PaddlePaddle/Paddle/releases/tag/v3.3.0>
- PP-OCRv6 overview and model table: <https://github.com/PaddlePaddle/PaddleOCR/blob/v3.7.0/docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.en.md>
- Official model list: <https://github.com/PaddlePaddle/PaddleOCR/blob/v3.7.0/docs/version3.x/model_list.md>
- Windows C++ deployment: <https://github.com/PaddlePaddle/PaddleOCR/blob/v3.7.0/docs/version3.x/inference_deployment/local_inference/cpp/OCR_windows.en.md>
- Static-link build options: <https://github.com/PaddlePaddle/PaddleOCR/blob/v3.7.0/deploy/cpp_infer/CMakeLists.txt>
- PaddleOCR license: <https://github.com/PaddlePaddle/PaddleOCR/blob/v3.7.0/LICENSE>
- PaddlePaddle license: <https://github.com/PaddlePaddle/Paddle/blob/v3.3.0/LICENSE>
- Context7 documentation source: `/paddlepaddle/paddleocr`

## Open Questions

- What is the measured Windows x64 `worker.exe` + DLL closure, compressed package size, and complete third-party license inventory for PaddleOCR `v3.7.0` / Paddle Inference `v3.3.0`?
- Do the official PP-OCRv6 model weights permit the intended direct-download and optional future redistribution behavior? The archives themselves contain no license file.
- Is explicit model removal/storage management required in the same release, or will it remain a later settings/storage plan?
