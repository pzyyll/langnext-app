# Phase 10: Trusted Native Worker Runtime Implementation Plan

**Goal:** Support a first-party out-of-process runtime for local OCR/STT/model engines that cannot target Wasm, with bounded RPC, lifecycle control, and process termination.

**Inputs:** Phases 2, 4, and 6.

**Assumptions:**

- A concrete first-party engine is selected before implementation begins.
- Third-party native packages remain prohibited.
- Separate process means fault/address-space isolation only, not permission sandbox.
- Dynamic libraries loaded into Tauri core remain forbidden.

**Architecture:** The package declares signed target-specific executable artifacts. The host starts the exact verified path without a shell/PATH lookup, performs a versioned handshake over framed stdio or a host-created local transport, and maps the same capability/blob/stream contracts. The host owns deadlines, cancellation, process-tree kill, health, restart, and logs.

**Tech Stack:** Rust `std::process`/Tokio process APIs selected after platform review, framed serde protocol, existing package/principal/resource services, Windows/macOS/Linux process helpers.

---

## Dependencies

- Phases 2, 4, and 6 complete.
- Concrete first-party product engine and supported platforms selected.

## File Map

- Create: `src-tauri/src/domain/native_worker.rs` — runtime descriptors, handshake/frame DTOs, health.
- Create: `src-tauri/src/services/native_workers/mod.rs` — manager/executor.
- Create: `src-tauri/src/services/native_workers/protocol.rs` — length-prefixed codec.
- Create: `src-tauri/src/services/native_workers/process.rs` — spawn/kill/lifecycle.
- Create: `src-tauri/src/services/native_workers/platform/mod.rs`, `src-tauri/src/services/native_workers/platform/windows.rs`, `src-tauri/src/services/native_workers/platform/unix.rs` — process-group/job control helpers.
- Create: `runtime-plugins/conformance/native-worker/Cargo.toml`, `runtime-plugins/conformance/native-worker/src/main.rs` — deterministic crash/hang/protocol worker.
- Create: `.mise/tasks/plugin/build-native-conformance` — target worker build.
- Modify: `src-tauri/src/domain/runtime_plugin.rs`, `src-tauri/src/services/runtime_plugin_contracts.rs`, `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/services/blob_resources.rs`, `src-tauri/src/services/stream_resources.rs` — native descriptors/routing/resources.
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/domain/service_integration.rs`, `src/features/plugins/IntegrationEditor.tsx` — manager composition and health.
- Test: native protocol/process/health/runtime modules plus package trust tests.

## Tasks

### Task 1: Gate native runtime by trust and platform

**Outcome:** Only explicitly approved first-party packages can declare a native worker.

**Files:**

- Modify: `src-tauri/src/domain/runtime_plugin.rs`, `src-tauri/src/services/runtime_plugin_contracts.rs`, `src-tauri/src/services/plugin_package.rs`
- Test: native package trust fixtures in package service tests

**Steps:**

- [ ] Add target triple→artifact path/native protocol version descriptors to manifest v1-compatible runtime descriptors; each executable remains covered by the Phase 0 signed file index with native-worker role, byte length, and digest.
- [ ] Require publisher source `vendor` and an explicit host allowlist for `TrustedNativeWorker`.
- [ ] Reject user-approved third-party keys, missing target artifacts, mutable paths, shell commands, PATH lookup, and frontend-supplied arguments.
- [ ] Verify executable digest immediately before every spawn.
- [ ] Display “trusted native code with user-level OS access” in permission review.

**Validation:**

- Run: `mise run test native_worker_package -- --nocapture`
- Expected: non-vendor/wrong-target/digest/argument violations are denied.

### Task 2: Define the versioned framed protocol

**Outcome:** Host and worker exchange bounded typed messages with explicit compatibility.

**Files:**

- Create: `src-tauri/src/domain/native_worker.rs`, `src-tauri/src/services/native_workers/protocol.rs`
- Test: inline codec tests in `src-tauri/src/services/native_workers/protocol.rs`

**Steps:**

- [ ] Use a fixed magic/version handshake with package digest, plugin API, capability majors, process nonce, and supported frame types.
- [ ] Use length-prefixed frames with named maximum frame/message/in-flight limits.
- [ ] Define request, response, stream chunk, terminal error, cancel, health, and shutdown frames.
- [ ] Bind request IDs/resources to the spawning principal and reject replay/unknown/out-of-order frames.
- [ ] Keep blobs/streams as opaque host resource IDs or bounded framed chunks; never pass arbitrary host paths.
- [ ] Sanitize worker errors before exposing them.

**Validation:**

- Run: `mise run test native_worker_protocol -- --nocapture`
- Expected: partial, oversized, malformed, wrong-version, reordered, replayed, and unknown frames fail closed.

### Task 3: Implement process lifecycle and hard deadlines

**Outcome:** Host can start, cancel, terminate, and reap worker process trees predictably.

**Files:**

- Create: `src-tauri/src/services/native_workers/process.rs`, `src-tauri/src/services/native_workers/platform/mod.rs`, `src-tauri/src/services/native_workers/platform/windows.rs`, `src-tauri/src/services/native_workers/platform/unix.rs`
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`
- Test: process/platform lifecycle tests in native worker modules

**Steps:**

- [ ] Spawn the exact verified executable with no shell and fixed host-generated arguments.
- [ ] Clear nonessential environment variables and use a dedicated plugin-instance work directory containing no secrets by default.
- [ ] Enforce startup/handshake/request/idle/shutdown deadlines.
- [ ] On cancel/timeout/protocol violation/app exit, close transport then terminate the full process tree with platform-specific handling.
- [ ] Keep protocol transport separate from stdout/stderr. Discard raw stdout/stderr by default after enforcing a byte cap; never persist or forward it. Accept diagnostics only through a typed protocol frame with a fixed allowlist of non-content fields. Any temporary raw capture requires an explicit local debug opt-in, remains memory-only, is truncated, and is excluded from normal logs.
- [ ] Reap every child and clean work directories/resources.

**Validation:**

- Run: `mise run test native_worker_process -- --nocapture`
- Expected: crash, hang, orphan child, output flood, failed handshake, cancel, and app shutdown leave no process/resource leak.

### Task 4: Add health, restart, and concurrency policy

**Outcome:** Worker failures are visible and bounded rather than restart loops.

**Files:**

- Modify: `src-tauri/src/services/native_workers/mod.rs`, `src-tauri/src/domain/service_integration.rs`, `src/features/plugins/IntegrationEditor.tsx`
- Test: native worker manager restart/backoff tests

**Steps:**

- [ ] Track stopped/starting/ready/degraded/crashed/disabled state and sanitized last failure.
- [ ] Define max concurrent processes/calls and per-instance queue limits.
- [ ] Restart only for declared retry-safe startup/process failures with exponential backoff and a named attempt cap.
- [ ] Never retry a business request automatically after the worker may have processed it.
- [ ] Require manual reset after crash-loop threshold.

**Validation:**

- Run: `mise run test native_worker_health -- --nocapture`
- Expected: restart/backoff/crash-loop/concurrency behavior is bounded and deterministic.

### Task 5: Connect native adapter to RuntimeRouter

**Outcome:** A trusted worker implements the same known capability traits as Wasm/Bundled adapters.

**Files:**

- Modify: `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/blob_resources.rs`, `src-tauri/src/services/stream_resources.rs`
- Test: native runtime adapter tests

**Steps:**

- [ ] Resolve exact package/grant/runtime identity authoritatively.
- [ ] Map typed capability requests to framed protocol and responses to existing domain DTOs/errors.
- [ ] Propagate Blob/Stream ownership, deadline, and cancellation.
- [ ] Apply host network/auth policy only if the worker requests broker operations through RPC; acknowledge that the worker can otherwise use ambient OS network unless separately contained.
- [ ] Keep native activation blocked for packages outside the first-party allowlist.

**Validation:**

- Run: `mise run test native_worker_runtime -- --nocapture`
- Expected: conformance capability succeeds and all principal/resource/trust violations fail.

### Task 6: Build the conformance worker and product-specific follow-up gate

**Outcome:** Infrastructure is validated without inventing a fake production engine.

**Files:**

- Create: `runtime-plugins/conformance/native-worker/Cargo.toml`, `runtime-plugins/conformance/native-worker/src/main.rs`, `.mise/tasks/plugin/build-native-conformance`
- Test: `runtime-plugins/conformance/native-worker/tests/` and native worker host tests

**Steps:**

- [ ] Implement modes for success, wrong handshake, crash, hang, child spawn, oversized frame, stdout/stderr flood, stale response, and ignored cancellation.
- [ ] Build target-specific fixtures through mise.
- [ ] Require a separate product plan before integrating the selected real OCR/STT/model engine, including model files, licensing, hardware, permissions, and retention.

**Validation:**

- Run: `mise run plugin:build-native-conformance`
- Run: `mise run plugin:conformance native-worker`
- Expected: every failure mode is contained/reaped; success follows the typed contract.

## Final Validation

```bash
mise run plugin:conformance native-worker
mise run test native_worker -- --nocapture
mise run format:check
mise run tauri:build
```

Expected: target installers contain only verified first-party worker artifacts and all lifecycle tests pass.

## Failure Behavior

- Wrong trust/target/digest — reject activation/spawn.
- Handshake/protocol failure — terminate worker and fail request.
- Timeout/cancel — terminate process tree if cooperative shutdown fails.
- Crash loop — disable automatic restart and require manual action.

## Privacy and Security

- Native worker has ambient current-user OS authority unless platform containment is added.
- No secret is passed by default; auth/network through broker RPC where product permits.
- Worker output/logs are bounded and redacted.

## Rollout Notes

- Do not start without a selected first-party engine.
- Add platform containment as a separate prerequisite before any third-party native publisher.

## Risks and Mitigations

- Platform child-tree termination differences — dedicated tested helpers per OS.
- Worker bypasses broker — first-party trust only and explicit product security review.
- Large model distribution — separate product packaging/updater plan.

## Open Questions

- Which concrete first-party OCR/STT/model engine triggers implementation?
- Which platforms and OS containment requirements apply to that engine?
