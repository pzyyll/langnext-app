# Phase 2: Wasm Component Runtime Implementation Plan

**Goal:** Prove a bounded, typed Wasm Component execution boundary with a synthetic conformance plugin before external package installation or real provider traffic.

**Inputs:** Phase 0 WIT/security contracts and Wasmtime `47.0.2` documentation.

**Assumptions:**

- Phase 0 is complete.
- Wasmtime is pinned to `=47.0.2` as approved by the user.
- Phase 1 may proceed in parallel but must complete before Phase 3 package activation.
- Wasm runs in the Tauri core process in this phase; hard process termination is not claimed.

**Architecture:** A shared Wasmtime `Engine` compiles typed Components. Each invocation creates a `Store<PluginHostState>` with principal, approved grant, cancellation, deadline, broker handles, and strict limits. The linker exposes only LangNext WIT interfaces and never links WASI.

**Tech Stack:** Wasmtime 47.0.2 Component Model/async APIs, Tokio, WIT bindgen, existing `CapabilityError`, `CancelToken`, `NetworkBroker`, mise.

---

## Dependencies

- Phase 0 complete.

## File Map

- Create: `src-tauri/src/services/wasm_runtime/mod.rs` — public runtime service.
- Create: `src-tauri/src/services/wasm_runtime/bindings.rs` — `component::bindgen!` generated bindings.
- Create: `src-tauri/src/services/wasm_runtime/engine.rs` — Engine configuration and epoch ticker.
- Create: `src-tauri/src/services/wasm_runtime/store.rs` — host state and store/resource limits.
- Create: `src-tauri/src/services/wasm_runtime/host.rs` — LangNext host import implementations.
- Create: `src-tauri/src/services/wasm_runtime/executor.rs` — typed Component load/instantiate/call.
- Create: `src-tauri/src/services/wasm_runtime/cache.rs` — compiled Component cache identity.
- Create: `src-tauri/src/services/wasm_runtime/errors.rs` — sanitized trap/error mapping.
- Create: `src-tauri/src/services/wasm_runtime/tests.rs` — adversarial runtime tests.
- Create: `runtime-plugins/conformance/wasm-component/Cargo.toml`, `runtime-plugins/conformance/wasm-component/src/lib.rs`, `runtime-plugins/conformance/wasm-component/plugin.json` — synthetic guest source/manifest.
- Create: `runtime-plugins/conformance/wasm-component/tests/fixtures/` — mode inputs and expected outputs.
- Create: `.mise/tasks/plugin/build-conformance` — deterministic conformance build.
- Create: `.mise/tasks/plugin/conformance` — focused host conformance runner.
- Create: `.mise/tasks/plugin/check-no-wasi` — inverted dependency-tree assertion.
- Modify: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` — Wasmtime dependency.
- Modify: `src-tauri/src/services/mod.rs`, `src-tauri/src/state.rs` — compose shared runtime.

## Tasks

### Task 1: Add the pinned Wasmtime dependency

**Outcome:** The project compiles with the exact runtime version and no WASI host implementation.

**Files:**

- Modify: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`

**Steps:**

- [ ] Add `wasmtime = { version = "=47.0.2", default-features = false, features = ["async", "cache", "component-model", "cranelift", "pooling-allocator", "runtime", "std"] }`.
- [ ] Do not enable `component-model-async` unless a separately reviewed Phase 0 WIT revision requires the Component async ABI; v1 uses async host embedding plus LangNext StreamHandle semantics.
- [ ] Do not add `wasmtime-wasi`.
- [ ] Record the selected feature set and 47.0.2 API links in module documentation.
- [ ] Run `cargo tree` and remove any unnecessary default/indirect feature that materially increases runtime authority or package size.

**Validation:**

- Run: `cargo check --manifest-path src-tauri/Cargo.toml`
- Expected: Rust compiles with Wasmtime 47.0.2.
- Run: `mise run plugin:check-no-wasi`
- Expected: the task returns zero only when `cargo tree` contains no `wasmtime-wasi` package.

### Task 2: Generate typed Component bindings

**Outcome:** Host code invokes WIT worlds through generated Rust types rather than dynamic JSON.

**Files:**

- Create: `src-tauri/src/services/wasm_runtime/bindings.rs`
- Modify: `src-tauri/src/services/wasm_runtime/mod.rs`
- Test: `src-tauri/src/services/wasm_runtime/tests.rs`

**Steps:**

- [ ] Use `wasmtime::component::bindgen!` against `src-tauri/wit/runtime-plugin/worlds.wit`.
- [ ] Generate async host traits for broker/log/cancel/deadline interfaces.
- [ ] Expose typed adapters for Translate and Detect first; keep OCR/Speech/LLM bindings compiled but unexecuted.
- [ ] Add compile-time/fixture tests that WIT interface names and major versions match Phase 0 constants.

**Validation:**

- Run: `mise run test wasm_bindings -- --nocapture`
- Expected: generated bindings compile and expected worlds/interfaces are present.

### Task 3: Configure Engine, limits, and interruption

**Outcome:** Guest CPU, memory, table, instance, and compiled-cache use are bounded by named host constants.

**Files:**

- Create: `src-tauri/src/services/wasm_runtime/engine.rs`, `src-tauri/src/services/wasm_runtime/store.rs`, `src-tauri/src/services/wasm_runtime/cache.rs`
- Test: `src-tauri/src/services/wasm_runtime/tests.rs`

**Steps:**

- [ ] Enable Component Model, async support, fuel consumption, epoch interruption, cache, and pooling allocation using Wasmtime 47 APIs.
- [ ] Define named limits for linear memory, tables, instances, components, stack, fuel, concurrent calls, output bytes, and cache entries.
- [ ] Apply `StoreLimits`/async resource limiting to every Store.
- [ ] Set initial fuel and an epoch deadline per invocation; tick the engine epoch from one bounded host task.
- [ ] Key compiled Components by package digest, host API version, Wasmtime version, engine configuration revision, and target triple.
- [ ] Keep cache disposable; verification always uses original package digest.

**Validation:**

- Run: `mise run test wasm_limits -- --nocapture`
- Expected: oversized minimum memory/table declarations fail instantiation; infinite loops exhaust fuel/epoch; cache identity changes with every security-relevant input.

### Task 4: Implement host state and narrow imports

**Outcome:** Guests can use only approved broker/log/cancel/deadline operations bound to one principal.

**Files:**

- Create: `src-tauri/src/services/wasm_runtime/host.rs`, `src-tauri/src/services/wasm_runtime/store.rs`
- Modify: `src-tauri/src/services/wasm_runtime/executor.rs`
- Test: `src-tauri/src/services/wasm_runtime/tests.rs`

**Steps:**

- [ ] Store `PluginPrincipal`, approved execution grant-set revision, cancellation token, wall deadline, broker handle, and sanitized logger in `PluginHostState`.
- [ ] Link only LangNext interfaces; never add WASI to the linker.
- [ ] Link the complete Phase 0 Blob/Stream operation ABI with stable `unsupported` results; do not change the v1 WIT in Phase 6.
- [ ] Make every host import async, independently timeout-bounded, and cancellation-aware.
- [ ] Validate principal/grant/capability/endpoint on each broker call rather than only at invocation start.
- [ ] Permit only allowlisted structured log fields and bounded string lengths.
- [ ] Return opaque resource IDs only; Blob/Stream operations remain `unsupported` until Phase 6.
- [ ] Document that fuel/epoch cannot preempt blocking host code and prohibit blocking work inside imports.

**Validation:**

- Run: `mise run test wasm_host_imports -- --nocapture`
- Expected: unlinked imports fail instantiation; wrong instance/grant/capability calls are denied; cancellation and deadline propagate through broker calls.

### Task 5: Implement typed execution and error mapping

**Outcome:** Synthetic Translate/Detect Components execute behind existing typed capability traits.

**Files:**

- Create: `src-tauri/src/services/wasm_runtime/executor.rs`, `src-tauri/src/services/wasm_runtime/errors.rs`, `src-tauri/src/services/wasm_runtime/mod.rs`
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/services/mod.rs`
- Test: `src-tauri/src/services/wasm_runtime/tests.rs`

**Steps:**

- [ ] Load a verified Component from bytes/digest supplied by tests; package filesystem loading waits for Phase 3.
- [ ] Instantiate a fresh Store per request and call typed Translate/Detect exports asynchronously.
- [ ] Validate request bounds before guest execution and response bounds after return.
- [ ] Map fuel/epoch, trap, timeout, cancellation, invalid response, and host import errors to stable `CapabilityErrorCode` values.
- [ ] Exclude guest stack traces, user content, raw provider bodies, and host paths from IPC-facing errors/logs.
- [ ] Never retry through Bundled Rust automatically after guest execution starts.

**Validation:**

- Run: `mise run test wasm_executor -- --nocapture`
- Expected: success and normalized failure fixtures map deterministically to existing capability errors.

### Task 6: Build the synthetic conformance Component

**Outcome:** One deterministic guest artifact exercises normal and malicious runtime behavior.

**Files:**

- Create: `runtime-plugins/conformance/wasm-component/Cargo.toml`, `runtime-plugins/conformance/wasm-component/src/lib.rs`, `runtime-plugins/conformance/wasm-component/plugin.json`, fixture files
- Create: `.mise/tasks/plugin/build-conformance`, `.mise/tasks/plugin/conformance`
- Test: committed Component fixture plus `src-tauri/src/services/wasm_runtime/tests.rs`

**Steps:**

- [ ] Implement modes for success, broker call, denied endpoint, trap, infinite loop, memory growth, oversized output, slow host call, cancellation, and undeclared import.
- [ ] Build against the committed WIT package with a pinned guest toolchain/task.
- [ ] Commit the generated `.wasm` fixture and a digest manifest; make rebuild comparison fail on unexplained drift.
- [ ] Add no live provider calls or fake production path.

**Validation:**

- Run: `mise run plugin:build-conformance`
- Expected: fixture rebuild succeeds and digest matches the committed expected value.
- Run: `mise run plugin:conformance wasm`
- Expected: allowed modes succeed; every malicious/over-limit mode fails closed without crashing Tauri core tests.

## Final Validation

```bash
mise run plugin:build-conformance
mise run plugin:conformance wasm
mise run test wasm_runtime -- --nocapture
mise run plugin:check-no-wasi
mise run format:check
```

Expected: typed bounded execution passes; no WASI implementation is linked; formatting passes.

## Failure Behavior

- Compile/instantiate failure — return `plugin_unavailable` or `invalid_configuration` without caching the artifact.
- Fuel/epoch/memory limit — abort the guest call and return a sanitized resource-limit error.
- Host import timeout — cancel import/request; do not wait indefinitely or replay.
- Runtime panic — contain through Rust error boundaries where possible; treat process-level panic policy separately.

## Privacy and Security

- Wasm receives no raw credential/token or unrestricted network API.
- Wasm in the core process is memory-isolated but not process-isolated.
- Cache artifacts are untrusted optimizations and never replace digest verification.

## Rollout Notes

- The runtime remains unreachable from production plugin instances until Phase 4.
- Measure debug/release binary size and cold start before approving Phase 3 activation.

## Risks and Mitigations

- Wasmtime size/startup cost — use minimal features, pooling, and digest-keyed cache; record measurements.
- Async host import bug blocks deadlines — require import-level timeouts and consider moving Wasmtime to a worker in later hardening.
- Version/API drift — exact pin 47.0.2 and conformance suite gate any upgrade.

## Open Questions

None blocking Phase 2.
