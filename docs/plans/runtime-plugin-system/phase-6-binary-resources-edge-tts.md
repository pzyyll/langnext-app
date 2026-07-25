# Phase 6: Binary Resources and Edge TTS Runtime Plugin Implementation Plan

**Goal:** Add host-owned bounded Blob/Stream resources and migrate Edge TTS to a brokered Wasm plugin, eliminating its direct `reqwest` production path.

**Inputs:** Phase 5 runtime plugin and existing Speech synthesis/playback contracts.

**Assumptions:**

- Phase 5 is complete.
- Speech synthesis remains bounded complete MP3, not long-audio streaming.
- Stream resources are introduced for later LLM/network streaming but Edge TTS initially uses Blob resources.

**Architecture:** Guests exchange opaque handles, never filesystem paths or unbounded base64. Resource ownership binds package, instance, request, direction, bounds, expiry, and cancellation. NetworkBroker supports bounded JSON, bytes, and stream modes; Edge TTS uses bytes→Blob→existing binary IPC/playback.

**Tech Stack:** Rust resource tables, Wasmtime Component resources, Tauri binary response/Channel, existing Speech services, React/Bun tests.

---

## Dependencies

- Phase 5 complete.

## File Map

- Create: `src-tauri/src/domain/plugin_resource.rs` — handle IDs, ownership, metadata, terminal states.
- Create: `src-tauri/src/services/blob_resources.rs` — bounded blob lifecycle.
- Create: `src-tauri/src/services/stream_resources.rs` — bounded ordered stream lifecycle/backpressure.
- Modify: `src-tauri/src/services/wasm_runtime/bindings.rs`, `src-tauri/src/services/wasm_runtime/host.rs`, `src-tauri/src/services/wasm_runtime/store.rs` — implement the complete Blob/Stream v1 operations already declared in Phase 0; do not change the WIT v1 ABI.
- Modify: `src-tauri/src/services/network_broker.rs`, `src-tauri/src/services/bounded_http.rs` — JSON/bytes/stream response modes.
- Create: `runtime-plugins/edge-tts/Cargo.toml`, `runtime-plugins/edge-tts/src/lib.rs`, `runtime-plugins/edge-tts/plugin.json`, `runtime-plugins/edge-tts/schemas/`, `runtime-plugins/edge-tts/tests/fixtures/` — package implementation.
- Create: `.mise/tasks/plugin/build-edge-tts` — deterministic Component build and unsigned staging tree at `runtime-plugins/dist/staging/com.langnext.edge-tts-1.0.0/`; use the Phase 3 external-signing/finalization pipeline for the final archive.
- Modify: `src-tauri/src/services/edge_tts.rs`, `src-tauri/src/services/speech_services.rs`, `src-tauri/src/services/runtime_router.rs`, `src/features/speech/speechPlaybackController.ts` — compatibility/runtime/playback.
- Test: blob/stream service tests, Edge guest fixtures, Speech service tests, and `src/features/speech/speechPlaybackController.test.ts`.

## Tasks

### Task 1: Implement BlobHandle ownership and bounds

**Outcome:** Images/audio/request bodies can be passed by opaque bounded handle.

**Files:**

- Create: `src-tauri/src/domain/plugin_resource.rs`, `src-tauri/src/services/blob_resources.rs`
- Modify: `src-tauri/src/services/wasm_runtime/bindings.rs`, `src-tauri/src/services/wasm_runtime/host.rs`, `src-tauri/src/services/wasm_runtime/store.rs`; keep Phase 0 WIT v1 unchanged
- Test: inline tests in `src-tauri/src/services/blob_resources.rs`

**Steps:**

- [ ] Define cryptographically unpredictable opaque IDs and bind owner principal, direction, content type, byte length/cap, creation/expiry, and cancel token.
- [ ] Support bounded create/write/read/close/discard operations with chunk caps.
- [ ] Permit one producer and declared consumers only; prevent cross-instance/request/package use.
- [ ] Make close terminal and reads after discard/expiry/cancel fail.
- [ ] Keep bytes in bounded memory initially; document threshold for later temp-file backing without exposing paths.
- [ ] Remove resources at request completion and app shutdown.

**Validation:**

- Run: `mise run test blob_resource -- --nocapture`
- Expected: ownership, cap, chunk, expiry, close, cancel, and cleanup tests pass.

### Task 2: Implement StreamHandle semantics

**Outcome:** Later LLM/network streaming has a typed ordered and backpressured resource contract.

**Files:**

- Create: `src-tauri/src/services/stream_resources.rs`
- Modify: `src-tauri/src/services/wasm_runtime/bindings.rs`, `src-tauri/src/services/wasm_runtime/host.rs`, `src-tauri/src/services/wasm_runtime/store.rs`; keep Phase 0 WIT v1 unchanged
- Test: inline tests in `src-tauri/src/services/stream_resources.rs`

**Steps:**

- [ ] Define single-producer/single-consumer ordered chunks with bounded buffer and chunk size.
- [ ] Define terminal `finished | failed | cancelled` state carrying only sanitized stable error data.
- [ ] Block/yield producer under backpressure with deadline/cancellation support; never grow unbounded queues.
- [ ] Make consumption one-time and bind to the same principal/request.
- [ ] Propagate consumer disconnect to producer/network cancellation.
- [ ] Do not yet expose StreamHandle to production LLM workflows.

**Validation:**

- Run: `mise run test stream_resource -- --nocapture`
- Expected: ordering, backpressure, terminal, disconnect, cross-owner, and cancellation tests pass.

### Task 3: Extend NetworkBroker response modes

**Outcome:** Plugins can receive bounded JSON, binary, or streaming responses through one authorization path.

**Files:**

- Modify: `src-tauri/src/services/network_broker.rs`, `src-tauri/src/services/bounded_http.rs`, `src-tauri/src/services/wasm_runtime/host.rs`
- Test: inline tests in `src-tauri/src/services/network_broker.rs` and `src-tauri/src/services/bounded_http.rs`

**Steps:**

- [ ] Add declared response mode and per-capability byte/chunk/idle/total limits to approved grants.
- [ ] JSON mode preserves current bounded UTF-8 behavior.
- [ ] Bytes mode writes into a host BlobHandle and returns metadata/handle only.
- [ ] Stream mode pumps chunks into StreamHandle with backpressure and cancellation.
- [ ] Apply identical final destination, auth, proxy, redirect, timeout, and log redaction policy to all modes.
- [ ] Ensure guest cannot select a broader mode/limit than the grant.

**Validation:**

- Run: `mise run test network_broker -- --nocapture`
- Expected: all modes respect principal/grant/limits and consumer cancellation stops network work.

### Task 4: Build the Edge TTS Component

**Outcome:** Edge request construction/preferences/response handling run in the installable guest.

**Files:**

- Create: `runtime-plugins/edge-tts/Cargo.toml`, `runtime-plugins/edge-tts/src/lib.rs`, `runtime-plugins/edge-tts/plugin.json`, `runtime-plugins/edge-tts/schemas/config.json`, `runtime-plugins/edge-tts/schemas/speech-preferences.json`, `runtime-plugins/edge-tts/tests/fixtures/`
- Create: `.mise/tasks/plugin/build-edge-tts`
- Port: fixtures from `src-tauri/src/services/edge_tts.rs` into `runtime-plugins/edge-tts/tests/fixtures/`

**Steps:**

- [ ] Implement `speech.synthesize@1` export with voice, speed, pitch, and style schema/preferences.
- [ ] Build the OpenAI-compatible `/v1/audio/speech` request through one approved endpoint alias.
- [ ] Request bytes response mode and validate returned content type/non-empty/declared MP3 cap.
- [ ] Keep default URL in manifest/config schema but require an approved effective HTTPS origin for changes.
- [ ] Port all current request/error/size fixtures.
- [ ] Generate the complete signed file index in the unsigned staging tree; release CI signs exact `plugin.json` bytes, then `plugin:finalize-package` emits `runtime-plugins/dist/com.langnext.edge-tts-1.0.0.lnplugin` and its post-signing `.sha256`.

**Validation:**

- Run: `mise run plugin:build-edge-tts`
- Run in release CI after signature injection: `mise run plugin:finalize-package runtime-plugins/dist/staging/com.langnext.edge-tts-1.0.0 runtime-plugins/dist/com.langnext.edge-tts-1.0.0.lnplugin`
- Run: `mise run plugin:verify runtime-plugins/dist/com.langnext.edge-tts-1.0.0.lnplugin`
- Run: `mise run plugin:conformance edge-tts`
- Expected: request/preference/error/binary fixtures pass.

### Task 5: Migrate Edge instances and remove direct transport

**Outcome:** Production Edge TTS calls use Wasm + broker + Blob while retaining explicit rollback for one release.

**Files:**

- Modify: `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/speech_services.rs`, `src/features/speech/SpeechServiceEditor.tsx`, `src/features/speech/speechPlaybackController.ts`
- Modify/delete after rollout: direct network code in `src-tauri/src/services/edge_tts.rs`
- Test: runtime lifecycle/Speech service tests and `src/features/speech/speechPlaybackController.test.ts`

**Steps:**

- [ ] Seed vendor package and set default for new Edge instances.
- [ ] Add explicit instance migration preserving Speech service/default setting references.
- [ ] Convert current Base URL/preferences through schema migrations and effective-origin approval.
- [ ] Return bounded binary response through the existing Tauri Speech IPC contract; do not add base64.
- [ ] Preserve one-active-playback cancellation/replacement behavior.
- [ ] After a stable dual-stack release, remove direct `OnceLock<reqwest::Client>` execution while retaining rollback only until Phase 12.

**Validation:**

- Run: `mise run test edge_tts_runtime -- --nocapture`
- Run: `bun test src/features/speech`
- Manual: synthesize/play/cancel/migrate/rollback in `mise run tauri:dev`.
- Expected: audio and cancellation behavior matches current UX; all egress is brokered.

## Final Validation

```bash
mise run plugin:build-edge-tts
# Release CI only, after external signature injection:
mise run plugin:finalize-package runtime-plugins/dist/staging/com.langnext.edge-tts-1.0.0 runtime-plugins/dist/com.langnext.edge-tts-1.0.0.lnplugin
mise run plugin:verify runtime-plugins/dist/com.langnext.edge-tts-1.0.0.lnplugin
mise run plugin:conformance resources
mise run plugin:conformance edge-tts
mise run test plugin_resource -- --nocapture
mise run test edge_tts_runtime -- --nocapture
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
```

Expected: resources are bounded/isolated and Edge TTS works without direct plugin-specific HTTP.

## Failure Behavior

- Invalid/expired/cross-owner handle — reject without revealing owner data.
- Buffer/byte/time limit — cancel producer/network and return stable resource error.
- Playback consumer disconnect — cancel synthesis/resource pump.
- Migration/permission failure — retain Bundled Rust executor.

## Privacy and Security

- Handles reveal no path, pointer, or secret.
- Audio bytes are not logged or persisted by default.
- Dynamic Base URL is part of the approved effective-origin grant.

## Rollout Notes

- Land Blob/Stream conformance before Edge migration.
- Keep Stream production use disabled until Phase 8.

## Risks and Mitigations

- In-memory blobs increase memory pressure — strict caps and future host-private temp backing threshold.
- Backpressure deadlocks — single producer/consumer contract, deadlines, cancellation, adversarial tests.
- Binary MIME spoofing — treat MIME as metadata and enforce expected provider contract/size.

## Open Questions

None blocking Phase 6.
