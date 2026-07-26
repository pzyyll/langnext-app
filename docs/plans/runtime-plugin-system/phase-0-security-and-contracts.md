# Phase 0: Runtime Plugin Security and Contracts Implementation Plan

**Goal:** Establish the host authority, Tauri security baseline, package identity, permission, WIT, and schema contracts required before any runtime plugin code can execute.

**Inputs:** `docs/analysis/runtime-plugin-architecture.md` and `docs/plans/runtime-plugin-system/README.md`.

**Assumptions:**

- Existing windows and commands retain current behavior.
- Runtime package execution and installation are deferred to Phases 2 and 3.
- App-local commands become explicitly permissioned before custom plugin WebViews exist.
- Schema v1 is intentionally limited and host-rendered.

**Architecture:** Phase 0 defines contracts only. Rust validates manifests, schemas, identities, and permission requests; Tauri ACL/CSP limits current frontend authority; WIT declares typed guest/host interfaces without linking an engine.

**Tech Stack:** Tauri 2.11.x ACL/CSP, Rust/serde, WIT text files, SQLite types only where needed for serialization tests, Bun/mise.

---

## Design Revision (pre-v1-freeze)

This section is the authoritative record of an explicit design revision made before the v1 ABI freeze. It does not relax any other requirement; it replaces one draft decision with a direction-specific one.

- **Replaced decision.** The `caa4f20` draft used a single `stream-handle` resource for LLM streaming: `variant { complete(llm-response), streaming(stream-handle) }` with one bidirectional handle. That draft is superseded and must not be implemented.
- **New decision.** Streaming uses direction-specific, paired resources: a `stream-writer` and a `stream-reader`. `llm.chat@1` receives a host-created `stream-writer` and returns `variant { complete(llm-response), streaming }`; the host retains the paired `stream-reader` before invoking Chat so the guest writes ordered typed delta frames while the host/frontend concurrently reads them.
- **Ownership direction (locked).** Ownership is direction-specific and never bidirectional: (1) LLM Chat — the host creates the writer/reader pair, transfers the writer to the guest, and retains the reader; (2) broker response body — the host is the producer and transfers a reader to the guest while retaining the producer; (3) guest-initiated `stream-create` — both provisional endpoints are returned to that guest. Handles are opaque host table indices scoped to one principal/request and cannot be persisted or reused.
- **Concurrency semantics (locked).** A stream is single-producer/single-consumer. The writer sends ordered typed `stream-frame` values; the reader receives them in send order. The host enforces: a stream is bound to one immutable `stream-kind` (`network-binary` or `llm-delta`) at creation, mixed-kind non-terminal frames are rejected, and exactly one terminal transition (`terminal` frame, or `stream-finish`/`stream-fail` on the writer) is allowed per stream. The reader may query terminal state and request cancellation without holding the writer.
- **Resource completeness (locked).** The v1 ABI defines the complete resource operation set now: blob `create/write/read/length/metadata/close/discard`; stream `create/send/receive/state/finish/fail/cancel/metadata` plus reader `close/discard` so both endpoints can be fully released. Phases 6–8 implement these without mutating the v1 ABI; any incompatible change requires a new interface/world version and an explicit dual-link compatibility matrix.

---

## Dependencies

None.

## File Map

- Create: `src-tauri/src/domain/runtime_plugin.rs` — package identity, runtime kind, principal, permission request, and approved grant types.
- Create: `src-tauri/src/domain/plugin_schema.rs` — limited schema v1 types.
- Create: `src-tauri/src/services/runtime_plugin_contracts.rs` — manifest, compatibility, and permission validation.
- Create: `src-tauri/src/services/plugin_schema.rs` — authoritative schema validation and normalization.
- Create: `src-tauri/wit/runtime-plugin/common.wit` — common IDs, errors, and resource handles.
- Create: `src-tauri/wit/runtime-plugin/host.wit` — narrow host imports.
- Create: `src-tauri/wit/runtime-plugin/translate.wit` — Translate and Detect contracts.
- Create: `src-tauri/wit/runtime-plugin/ocr.wit` — OCR contract.
- Create: `src-tauri/wit/runtime-plugin/speech.wit` — Speech synthesis/recognition contracts.
- Create: `src-tauri/wit/runtime-plugin/llm.wit` — model-list/chat contracts.
- Create: `src-tauri/wit/runtime-plugin/worlds.wit` — capability worlds and migration world.
- Create: `src-tauri/permissions/app-commands.toml` — explicit app-local command permissions.
- Create: `src-tauri/capabilities/trusted-app.json` — current trusted WebView permissions.
- Modify: `src-tauri/build.rs` — register the app command manifest.
- Modify: `src-tauri/tauri.conf.json` — enable explicit capabilities, CSP/devCsp, and narrow asset scope.
- Modify: `src-tauri/capabilities/default.json` — replace broad window matching or retire after trusted capability cutover.
- Modify: `src-tauri/src/domain/mod.rs`, `src-tauri/src/services/mod.rs` — export new modules.
- Test: `src-tauri/src/services/runtime_plugin_contracts.rs` — inline contract tests.
- Test: `src-tauri/src/services/plugin_schema.rs` — inline schema tests.
- Test: `src-tauri/src/storage/tests.rs` — configuration/security assertions that need project paths.

## Tasks

### Task 1: Restrict app-local IPC

**Outcome:** Every `invoke_handler` command is represented in the Tauri app manifest and granted only to trusted application WebViews.

**Files:**

- Create: `src-tauri/permissions/app-commands.toml`
- Create: `src-tauri/capabilities/trusted-app.json`
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/tauri.conf.json`
- Test: `src-tauri/src/storage/tests.rs`

**Steps:**

- [ ] Replace `tauri_build::build()` with `tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(...)))` using the complete command list from `src-tauri/src/lib.rs`.
- [ ] Define explicit allow permissions for app-local commands; do not grant them through a wildcard default set. In this phase all current commands belong to the trusted-app permission set; Phase 9 adds a separate plugin-page subset without granting the trusted set.
- [ ] Target the existing trusted labels through the narrowest supported `webviews` entries: `main`, `quick-translate`, and `screenshot-overlay`.
- [ ] Keep plugin page labels unmatched; Phase 9 introduces a separate capability.
- [ ] Add a test requiring the registered command list and generated `AppManifest` command list to equal the union of reviewed custom permission command lists, and requiring each custom permission to be assigned only through an explicit capability. This prevents new commands from bypassing ACL review while allowing Phase 9 to partition a narrow plugin-page subset.

**Validation:**

- Run: `mise run test runtime_plugin_security -- --nocapture`
- Expected: command and capability coverage tests pass with no unlisted command.
- Run: `mise run tauri:dev`
- Expected: main, Quick Translate, screenshot overlay, tray, clipboard, and settings flows retain current behavior.

### Task 2: Enable CSP and narrow asset access

**Outcome:** Current application pages run under a reviewed CSP and no longer expose all of `$TEMP/**` through the asset protocol.

**Files:**

- Modify: `src-tauri/tauri.conf.json`
- Verify/modify if required: `src-tauri/src/windows/screenshot.rs` already uses the `langnext-screenshot` temp subtree; keep its path aligned with the narrowed asset scope.
- Test: `src-tauri/src/storage/tests.rs`

**Steps:**

- [ ] Set production CSP with local scripts/styles/assets only, plus the documented Tauri IPC sources required by the built frontend.
- [ ] Set `devCsp` separately for the Vite dev origin and HMR endpoints; do not copy dev allowances to production.
- [ ] Move screenshot assets under a dedicated `$TEMP/langnext-screenshot/**/*` subtree and restrict `assetProtocol.scope` to it.
- [ ] Add assertions that `csp` is non-null, production CSP has no remote script source, and the asset scope is not `$TEMP/**`.

**Validation:**

- Run: `mise run build`
- Expected: frontend assets build successfully before packaging.
- Run: `mise run tauri:build`
- Expected: the production Tauri bundle is generated with the production CSP and narrowed asset scope.
- Manual: launch the packaged application and `mise run tauri:dev` separately.
- Expected: packaged main/Quick Translate/screenshot windows load production assets without unexpected CSP violations; development windows load under `devCsp`; screenshots and local image previews work.

### Task 3: Define plugin identity and permission contracts

**Outcome:** Rust can validate an external plugin manifest and derive an immutable execution principal without plugin-specific branches.

**Files:**

- Create: `src-tauri/src/domain/runtime_plugin.rs`
- Create: `src-tauri/src/services/runtime_plugin_contracts.rs`
- Modify: `src-tauri/src/domain/mod.rs`, `src-tauri/src/services/mod.rs`

**Steps:**

- [ ] Define `RuntimeKind::{BundledRust,WasmComponent,LegacyFrontendProvider,TrustedNativeWorker}`.
- [ ] Define validated newtypes for SHA-256 package digest, publisher key ID, publisher key fingerprint, execution grant-set revision, plugin API version, capability major, and request ID.
- [ ] Define `PluginPrincipal` binding package/bundled identity, plugin/version, instance, capability, request, and execution grant-set revision.
- [ ] Define `PluginManifestV1`, runtime artifact descriptors, config/preference schema references, credential slots, capability declarations, optional pages, and permission requests.
- [ ] Define network requests as endpoint IDs/origins/methods and auth-policy IDs; a manifest must never contain executable auth logic.
- [ ] Define `PluginManifestV1.files` as the signed file index for every archive payload entry except `plugin.json` and `signatures/manifest.sig`; each record contains normalized path, role, byte length, and SHA-256 digest and therefore covers runtime artifacts, schemas, locales, licenses, icons, and optional page assets.
- [ ] Define the archive allowlist exactly as `plugin.json`, `signatures/manifest.sig`, and the indexed files. Reject an indexed file that is absent, an archive file that is not indexed, duplicate normalized paths, or a role/reference mismatch. The signature covers the exact `plugin.json` bytes, which transitively authenticate the complete file index; the signature file itself is the only unsigned archive entry.
- [ ] Validate duplicate IDs, path normalization, reverse-domain plugin IDs, semantic versions, capability major syntax, bounds, host/plugin API compatibility, and undeclared references.
- [ ] Keep signature verification out of this phase; validate only the signed payload shape.

**Validation:**

- Run: `mise run test runtime_plugin_contracts -- --nocapture`
- Expected: valid synthetic manifests pass; malformed IDs, duplicates, bad digests, incompatible versions, and undeclared references fail closed.

### Task 4: Lock WIT capability worlds

**Outcome:** The host/guest ABI is typed and versioned before Wasmtime is introduced.

**Files:**

- Create: `src-tauri/wit/runtime-plugin/common.wit`, `src-tauri/wit/runtime-plugin/host.wit`, `src-tauri/wit/runtime-plugin/translate.wit`, `src-tauri/wit/runtime-plugin/ocr.wit`, `src-tauri/wit/runtime-plugin/speech.wit`, `src-tauri/wit/runtime-plugin/llm.wit`, `src-tauri/wit/runtime-plugin/worlds.wit`
- Test: `src-tauri/src/services/runtime_plugin_contracts.rs`

**Steps:**

- [ ] Declare package `langnext:runtime-plugin@1.0.0`.
- [ ] Define typed request/response/error records for `translate.text@1`, `translate.detect@1`, `ocr.image@1`, `speech.synthesize@1`, `speech.recognize@1`, `llm.models.list@1`, and `llm.chat@1`; copied config/preferences remain bounded UTF-8 JSON bytes, never credential material.
- [ ] Lock resource placement in capability signatures: OCR and Speech Recognize requests carry a host-owned input `blob-handle`; Speech Synthesize returns a host-owned output `blob-handle` plus media metadata; LLM Chat carries message metadata and zero or more image `blob-handle` values, receives a host-created `stream-writer`, and returns `variant { complete(llm-response), streaming }`. The host retains the paired `stream-reader` before invoking Chat, so the guest can write ordered typed delta frames while the host/frontend concurrently reads them.
- [ ] Lock the broker body union: request body is `variant { empty, json(list<u8>), blob(blob-handle) }`; response body is `variant { json(list<u8>), blob(blob-handle), stream(stream-reader) }`. Endpoint/auth policy remain host-resolved, JSON bytes are bounded/validated UTF-8, and binary/stream bodies never cross as base64.
- [ ] Define the complete v1 `blob-handle`, `stream-writer`, and `stream-reader` resource operation signatures now: bounded create/write/read/close/discard, blob `length` and `metadata`, ownership/direction checks, ordered typed stream send/receive, terminal state, cancellation, stream `metadata`, and reader `close`/`discard`. `stream-create` binds one immutable `stream-kind` (`network-binary` or `llm-delta`); the host rejects mixed-kind non-terminal frames and allows exactly one terminal transition per stream. Ownership is direction-specific: LLM Chat transfers a host-created writer to the guest while the host retains its reader; broker response bodies transfer a reader to the guest while the host retains the producer; guest-initiated `stream-create` returns both provisional endpoints to that guest. Handles are opaque host table indices scoped to one principal/request and cannot be persisted or reused.
- [ ] Define host imports for the broker union, bounded structured logs, monotonic deadline checks, cancellation, and the complete resource operations. Add ABI fixtures for every capability signature and every body/result variant, including OCR input Blob, Speech input/output Blob, broker JSON/Blob/Stream, LLM image Blob, complete Chat, and streaming Chat delta flow.
- [ ] Phase 2 links these operations with a stable `unsupported` result until Phase 6 implements them; Phases 6–8 must not mutate the v1 ABI. Any incompatible resource or capability signature change requires a new interface/world version and an explicit dual-link compatibility matrix.
- [ ] Define pure copied-JSON config/preference migration exports.
- [ ] Do not import WASI filesystem, sockets, environment, process, clocks, random, or stdio interfaces.
- [ ] Add parser/fixture tests that reject world/interface version drift.

**Validation:**

- Run: `mise run test runtime_plugin_wit -- --nocapture`
- Expected: all worlds parse, expected exports/imports are present, and forbidden imports are absent.

### Task 5: Define the limited UI schema dialect

**Outcome:** Plugin configuration and capability preferences can be represented without executable UI.

**Files:**

- Create: `src-tauri/src/domain/plugin_schema.rs`
- Create: `src-tauri/src/services/plugin_schema.rs`
- Modify: `src-tauri/src/domain/mod.rs`, `src-tauri/src/services/mod.rs`

**Steps:**

- [ ] Support string, multiline string, number, boolean, enum/select, bounded multi-enum, credential slot, and presentation-only groups.
- [ ] Support defaults, min/max/step, max length, localization fallback text, `requiredForReady`, and simple equality-based `visibleWhen`.
- [ ] Keep persisted config flat; groups do not alter JSON shape.
- [ ] Support only fixed option arrays and closed host sources such as `host.supported-languages@1`.
- [ ] Reject remote `$ref`, recursion, arbitrary HTML/CSS, scripts, executable validators, unknown keys, and unbounded arrays.
- [ ] Separate structural validity from readiness completeness so incomplete instances can be saved but cannot execute.
- [ ] Define credential controls by slot reference only; secrets remain outside config JSON.

**Validation:**

- Run: `mise run test plugin_schema -- --nocapture`
- Expected: defaults, normalization, visibility, bounds, readiness, unknown-key, and credential-separation tests pass.

## Final Validation

```bash
mise run test runtime_plugin_contracts -- --nocapture
mise run test runtime_plugin_wit -- --nocapture
mise run test plugin_schema -- --nocapture
mise run test runtime_plugin_security -- --nocapture
mise run typecheck
mise run lint
mise run format:check
mise run build
mise run tauri:build
```

Expected: contracts/security checks and existing application validation pass; no runtime plugin code executes yet.

## Failure Behavior

- Unknown manifest version — reject before catalog registration.
- Unsupported plugin API or capability major — preserve package bytes only in staging; do not activate.
- Invalid schema — reject the definition; do not infer a fallback shape.
- CSP regression — block Phase 2/3 promotion until manual trusted-window smoke tests pass.

## Privacy and Security

- Manifest permission declarations are requests, not grants.
- No raw secret/token field exists in manifest, WIT, or schema types.
- Tauri ACL does not constrain future Rust/Wasm/native execution; broker checks remain mandatory.

## Rollout Notes

- Land ACL/CSP changes separately before contract types if manual UI regression diagnosis would otherwise be difficult.
- Keep the current bundled registries operational throughout this phase.

## Risks and Mitigations

- CSP breaks development or Markdown assets — maintain separate production and dev CSP, then smoke-test every window.
- WIT churn — lock v1 before adding Wasmtime and change incompatible contracts only through new majors.
- Schema overreach — keep v1 deliberately closed; add features only from real plugin requirements.

## Open Questions

None blocking Phase 0.
