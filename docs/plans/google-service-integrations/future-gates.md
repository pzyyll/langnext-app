# Future Service Integration Gates

**Goal:** Define evidence required before expanding the service integration system into Speech, generic schema-rendered UI, external WASM plugins, or catalog consolidation.

**Inputs:** `README.md` and `docs/analysis/google-cloud-plugin-architecture.md`.

**Assumptions:** These are gates, not implementation commitments.

**Architecture:** New infrastructure is introduced only after a concrete product need demonstrates that the current typed bundled integration system cannot satisfy it safely and maintainably.

**Tech Stack:** To be selected only after each gate is approved.

---

## Gate 1: Speech

Do not add a generic `speech` operation.

Proceed only after requirements answer:

- Is the feature speech recognition (STT), synthesis (TTS), or both?
- Is input/output streaming required?
- Which audio formats, sample rates, channels, duration, and file-size limits are supported?
- How does recording/playback work across Tauri windows?
- Are partial transcripts required?
- What are cancellation, buffering, retry, and offline behaviors?
- Which runtime preferences belong to an integration instance versus a Speech profile?
- Which history/privacy policies apply to audio and transcripts?

When approved, define separate capability majors:

```text
speech.recognize@1
speech.synthesize@1
```

Before provider implementation:

1. Define typed requests/results/events.
2. Add binary Tauri Channel or host resource/file-handle transport.
3. Define hard byte/duration/buffer limits.
4. Add cancellation/deadline semantics.
5. Add permission and capability-scoped token/network grants.
6. Add a Speech profile/configuration plan.

Never send large/streaming audio as unbounded base64 IPC.

## Gate 2: Generic settings schema renderer

Do not add a JSON Schema renderer for Google Cloud alone.

Proceed only when at least two materially different integrations show repeated form requirements that cannot be maintained reasonably with typed host forms.

Before implementation, lock:

- supported JSON Schema subset/version;
- Base UI control mapping;
- localization key model;
- secret-slot separation;
- validation ownership (Rust authoritative);
- conditional fields and array support;
- accessibility/error behavior;
- schema/config migration versioning;
- trusted custom editor escape hatch for bundled plugins.

External plugin schemas must not inject JavaScript, React components, CSS, HTML, or arbitrary routes.

## Gate 3: Installable external plugins

Do not interpret Tauri's compile-time plugin system as a runtime marketplace.

Proceed only when there is a concrete third-party plugin author/use case and a stable bundled capability contract.

Recommended runtime: Wasmtime + WebAssembly Component Model/WIT.

Required before implementation:

- signed package format and trusted publisher policy;
- manifest/plugin API/capability version negotiation;
- WIT world per typed capability;
- no direct filesystem/network/vault/process access;
- host imports for logging, cancellation, clock, network, and opaque auth grants;
- memory/fuel/epoch/deadline limits;
- package install/update/rollback/uninstall state;
- migration sandbox and rollback;
- permission review UI;
- crash/trap health model;
- conformance test suite.

Dynamic `.dll`, `.so`, or `.dylib` loading remains rejected because it provides no meaningful host fault/security isolation and Rust ABI is not stable.

## Gate 4: Out-of-process native integrations

Proceed only for a real native/offline engine that cannot target WASM, e.g. a Python/C++ local OCR/Speech runtime.

Required:

- versioned local RPC contract;
- startup handshake and compatibility negotiation;
- process containment per OS;
- health/restart/backoff policy;
- cancellation and deadline propagation;
- bounded binary transport;
- stderr/stdout redaction;
- signed executable/update policy;
- resource quotas;
- uninstall cleanup.

Do not add this runtime for network-only REST providers.

## Gate 5: LLM/service catalog consolidation

Through Phase 3:

- TypeScript `ProviderPlugin` stays authoritative for LLM provider/model wire logic.
- Rust integration registry stays authoritative for service integrations.
- Frontend explicitly merges the two catalogs where a domain supports both.

Plan consolidation only if measured duplication or UX inconsistency becomes material. A consolidation plan must preserve:

- frontend provider request/response parsing ownership from `docs/architecture/adapter-strategy.md`, unless intentionally superseded;
- model listing/manual model behavior;
- model fallback/streaming;
- secret-free native transport;
- missing plugin visibility;
- current tests and import compatibility.

Do not block Google Cloud Translation/OCR on this consolidation.

## Gate Validation

Before promoting any gate to an implementation phase:

1. Write a dedicated requirements/spec document.
2. Inspect current code and retrieve current library/provider documentation.
3. Create a focused implementation plan with exact files/tasks/validation.
4. Review security, privacy, migration, and rollback.
5. Obtain explicit product approval.

## Open Questions

None. Each future area intentionally remains gated until concrete requirements exist.
