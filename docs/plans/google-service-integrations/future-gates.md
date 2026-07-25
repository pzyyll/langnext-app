# Future Service Integration Gates

**Goal:** Define evidence required before expanding beyond approved Google Cloud TTS into remaining Speech, generic schema-rendered UI, external WASM plugins, or catalog consolidation.

**Inputs:** `README.md` and `docs/analysis/google-cloud-plugin-architecture.md`.

**Assumptions:** The approved Google Cloud TTS subset is an implementation commitment only through its linked Phase 4 plan; every other item remains a gate.

**Architecture:** New infrastructure is introduced only after a concrete product need demonstrates that the current typed bundled integration system cannot satisfy it safely and maintainably.

**Tech Stack:** Defined in a promoted phase plan only after its gate is approved.

---

## Gate 1: Speech

Do not add a generic `speech` operation. Keep recognition and synthesis as separate capability majors:

```text
speech.recognize@1
speech.synthesize@1
```

### Approved subset: Google Cloud text-to-speech

**Status: promoted to [Phase 4](./phase-4-google-cloud-text-to-speech.md) (2026-07-24).**

The approved subset is deliberately narrow:

- `speech.synthesize@1` only through `com.langnext.google-cloud`;
- plain text up to 5,000 UTF-8 bytes; no SSML;
- Google-selected voice from the runtime effective source/target language;
- configurable speaking rate and pitch only;
- synchronous complete MP3 playback for Translate source/result;
- one active playback with cancellation/replacement;
- bounded raw Tauri binary response; no base64 audio DTO, stream, cache, download, file, history, or export;
- audio/text excluded from logs and persistence.

For bounded unary audio, `tauri::ipc::Response` is the approved transport. Tauri Channel or host resource/file-handle transport remains mandatory before any streaming or long-audio implementation.

### Remaining Speech gate

Do not implement `speech.recognize@1`, microphone capture, input/output streaming, long-audio synthesis, or partial results until requirements answer:

- Which audio formats, sample rates, channels, duration, and file-size limits are supported?
- How do recording permissions and capture work across Tauri windows and operating systems?
- Are partial transcripts required, and how are ordered events represented?
- What are cancellation, buffering, backpressure, retry, and offline behaviors?
- Which runtime preferences belong to an integration instance versus a Speech service/profile?
- Which history/privacy/retention policies apply to audio and transcripts?

Before promoting another Speech subset:

1. Define typed requests/results/events separately from `speech.synthesize@1` v1.
2. Add bounded Channel or host resource/file-handle transport when audio streams or exceeds unary limits.
3. Define hard byte/duration/buffer/backpressure limits.
4. Add cancellation/deadline and permission semantics.
5. Add capability-scoped token/network grants.
6. Write a focused requirements/spec and implementation plan.

Never send large or streaming audio as unbounded base64 IPC.

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

Through Phase 4:

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

Do not block Google Cloud Translation/OCR/TTS on this consolidation.

## Gate Validation

Before promoting any gate to an implementation phase:

1. Write a dedicated requirements/spec document or a locked Required Product Gate in the focused phase plan.
2. Inspect current code and retrieve current library/provider documentation.
3. Create a focused implementation plan with exact files/tasks/validation.
4. Review security, privacy, migration, and rollback.
5. Obtain explicit product approval.

## Open Questions

None. Google Cloud TTS has been promoted to Phase 4; every remaining future area stays gated until concrete requirements exist.
