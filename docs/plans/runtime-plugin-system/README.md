# Runtime Plugin System Implementation Plan

**Goal:** Replace compile-time integration/provider registration with a staged, installable plugin system that can provide LLM, translation, OCR, and Speech capabilities while preserving host-owned security, data, and UX boundaries.

**Shipped model (2026-08-24):** the plugin system is source-based. One `PluginCatalog` discovers built-in application resources, a debug-only development directory, and user Wasm `.lnplugin` archives. One `PluginLoader` materializes every directory or archive into an immutable digest-addressed snapshot. There is no plugin-level signature, no publisher identity, and no activation policy file. Shipped rules: [docs/architecture/plugin-catalog.md](../../architecture/plugin-catalog.md).

**Inputs:**

- `docs/analysis/runtime-plugin-architecture.md`
- `docs/analysis/google-cloud-plugin-architecture.md`
- `docs/architecture/adapter-strategy.md`
- `docs/architecture/frontend-state-management.md`
- Existing plans under `docs/plans/google-service-integrations/`
- Tauri v2 process, IPC, capability, CSP, asset protocol, plugin, and multi-window documentation
- Wasmtime `47.0.3` Component Model and async embedding documentation

**Assumptions:**

- The first release is desktop-only and supports local package installation, not a marketplace.
- Wasmtime is pinned to `=47.0.3`; implementation must re-run the Phase 2 API audit before changing that pin.
- External service plugins use Wasm Components by default.
- Native workers remain host-allowlisted built-in content. Process isolation is not an OS permission sandbox, so user and development content cannot declare a native runtime.
- Host-rendered schema UI is mandatory; executable custom pages are optional and delayed.
- User archives have no authenticated publisher identity. Installation is one permission review for one exact content digest, not publisher trust.
- Existing integration, provider, model, profile, OCR, Speech, and history UUIDs remain stable.
- Each phase is a delivery milestone; tracer tasks and per-provider/per-capability implementation slices may use separate reviewable branches/PRs, but production activation/rollback follows the atomic instance/package unit defined by the lifecycle contract.

**Architecture:** Plugin content comes from application resources (built-in), a debug development directory, or user Wasm archives. The host validates each directory or archive, materializes an immutable digest-addressed snapshot, resolves one default per plugin id, issues one execution grant-set revision per instance and content digest with capability/page authority entries, atomically pins each instance to an exact digest, and routes execution only through installed Wasm Component or built-in allowlisted native worker adapters (the bundled-rust and legacy-frontend adapters are removed in the package-only convergence). Credentials, network destinations, auth injection, persistence, blobs, streams, logs, and UI bridges remain host-owned.

**Tech Stack:** Rust 2024, Tauri 2.11.x, Wasmtime 47.0.3, WIT/Component Model, SQLite/rusqlite, React 19, Base UI, TanStack Router/Query, Effect, Bun, mise.

---

## Locked Decisions

1. Tauri plugins remain compile-time framework dependencies; application plugins use a separate runtime subsystem.
2. Capability kinds are closed and versioned; plugin implementors are open.
3. WIT is the executable ABI. Generic `execute(name, JSON)` is rejected.
4. Wasm guests receive no ambient WASI filesystem, socket, process, environment, or inherited stdio access.
5. A package manifest requests permissions. A user install review permits catalog availability only; execution requires a separate host grant-set revision bound to one instance and content digest and containing reviewed capability/page authority entries.
6. Secrets, credential refs, and OAuth tokens never cross frontend IPC or guest WIT.
7. The content digest is lowercase hex SHA-256 over the normalized sorted relative paths and file bytes of one content set. It covers every file, including `plugin.json`. A directory and an archive with identical files share the same digest.
8. A catalog default affects only newly created instances. Built-in content is the automatic default, and one `plugin_id + content_digest` row is an optional user override. Existing instances atomically pin an exact content digest and execution grant-set revision.
9. Runtime failure never silently replays a request through another executor.
10. Every plugin instance has a host-owned configuration page. Custom executable pages are optional.
11. Dynamic native libraries loaded into the Tauri process are permanently out of scope.

## Core Terms

| Term                | Meaning                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Plugin content      | One directory or `.lnplugin` archive with a canonical content digest                               |
| Installed version   | Immutable digest-addressed snapshot plus its source (built-in, development, or user)               |
| Plugin definition   | Sanitized catalog metadata derived from one catalog entry                                          |
| Plugin instance     | User configuration, credentials, health, enabled state, atomic runtime pin, and grant-set revision |
| Capability binding  | Domain resource reference to an instance and a capability major                                    |
| Principal           | Content digest + plugin/version + instance + capability + request + grant-set revision             |
| Install review      | One permission confirmation for one exact user content digest; never runtime authority             |
| Execution grant set | One atomic instance/package revision containing capability and page authority entries              |
| Runtime adapter     | Wasm Component executor or built-in allowlisted native worker executor                             |

## Cross-Phase Invariants

- SQLite/Rust remains authoritative; TanStack Query caches DTOs.
- Effect owns typed frontend IPC/workflows, not DTO caching.
- Plugin code cannot mutate SQLite directly or execute SQL migrations.
- Plugin config and preference migrations run only in explicit lifecycle previews against copied JSON and are validated by the host before CAS updates; import preview/apply never executes them.
- Built-in archives are packed deterministically from a validated directory. There is no signing step, and the release build validates every built-in structurally (`mise run plugin:check-builtins`).
- Package code is not included in configuration exports.
- Missing code preserves instances and bindings as `plugin_missing`.
- User text, prompts, provider bodies, images, and audio are excluded from default logs.
- New code files start with two `ABOUTME:` comment lines.
- `src/routeTree.gen.ts` is generated and never edited manually.
- Bun is the only JavaScript package manager; project commands live in `.mise/tasks/`.

## Phase Tree

```text
Phase 0  Security and contracts
  ├─> Phase 1  Schema control plane
  ├─> Phase 2  Wasm runtime conformance
  └─> Phase 1 + Phase 2
         └─> Phase 3  Package lifecycle
                └─> Phase 4  Runtime pin, upgrade, and rollback
                       └─> Phase 5  Google Translate Web tracer
                              └─> Phase 6  Blob/Stream resources + Edge TTS
                                     └─> Phase 7  Google Cloud multi-capability
                                            └─> Phase 8  LLM provider plugins

Phase 0 + Phase 3 + Phase 4
  └─> Phase 9  Isolated plugin pages [optional]

Phase 2 + Phase 4 + Phase 6
  └─> Phase 10 Trusted native workers [conditional]

Phase 4 + Phase 5 + Phase 7 + Phase 8
  └─> Phase 11 Complete v8 import/export and recovery
         └─> Phase 11.5 Default package authorization + package-first creation [superseded by catalog defaults]

Phases 5–8 + Phase 11 + Phase 11.5
  └─> Phase 12 Legacy retirement (executed as package-only convergence)
```

## Phase Index

| Phase | Document                                                               | Outcome                                                                | User value                      |
| ----- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| 0     | [Security and contracts](phase-0-security-and-contracts.md)            | Host authority, ACL/CSP, manifest, WIT, schema, principal              | Security baseline               |
| 1     | [Schema control plane](phase-1-schema-control-plane.md)                | No shared plugin-ID UI/validation branches                             | Dynamic bundled configuration   |
| 2     | [Wasm runtime](phase-2-wasm-runtime.md)                                | Bounded synthetic Component execution                                  | Runtime proof                   |
| 3     | [Package lifecycle](phase-3-package-lifecycle.md)                      | Validated install, immutable snapshots, install review                 | Installable packages            |
| 4     | [Runtime lifecycle](phase-4-runtime-lifecycle.md)                      | Exact pin, CAS upgrade, migration, rollback                            | Safe activation                 |
| 5     | [Google Web plugin](phase-5-google-web-plugin.md)                      | First real Wasm translation plugin                                     | Dynamic Translate/Detect        |
| 6     | [Binary resources and Edge TTS](phase-6-binary-resources-edge-tts.md)  | Blob/Stream data plane and brokered TTS                                | Dynamic Speech synthesis        |
| 7     | [Google Cloud plugin](phase-7-google-cloud-plugin.md)                  | Translate, Detect, OCR, and TTS in one package                         | Shared multi-capability account |
| 8     | [LLM provider plugins](phase-8-llm-provider-plugins.md)                | Dynamic model listing/chat/stream providers                            | Installable LLM providers       |
| 9     | [Isolated plugin pages](phase-9-isolated-plugin-pages.md)              | Restricted custom workflows                                            | Optional rich plugin UX         |
| 10    | [Native workers](phase-10-native-workers.md)                           | Trusted out-of-process local engines                                   | Local OCR/STT/model support     |
| 11    | [Import/export and recovery](phase-11-import-export-recovery.md)       | Complete v8 preview/apply and recovery semantics                       | Reliable backup and restore     |
| 11.5  | [Default package activation](phase-11-5-default-package-activation.md) | Superseded; catalog defaults and explicit digest overrides replaced it | No manual runtime digest        |
| 12    | [Legacy retirement](phase-12-legacy-retirement.md)                     | Remove static branches and duplicate executors                         | Architecture convergence        |

**Decision (2026-08-21, revised):** the application is unpublished and package-only. There are no
legacy users, legacy runtimes, legacy data, or old export formats. Phase 12 retirement no longer
awaits a stable dual-stack release; the bundled and legacy-frontend executors are removed directly
and the retirement/inventory/evidence machinery is deleted with them.

## Delivery Rules

- Do not start Phase 3 until Phases 1 and 2 pass their final validation.
- Do not reintroduce a bundled or legacy executor: package runtime failures surface as package errors and package rollback restores a prior package version.
- Do not run shadow production requests against real providers.
- A permission-expanding upgrade requires a new explicit approval.
- A capability major change requires a new domain compatibility decision; it is not a package-only migration.
- Phase 9 and Phase 10 are optional and do not block service/LLM plugin delivery.
- Phase 12 removes every bundled/legacy executor unconditionally. Package-first creation uses catalog defaults and explicit digest overrides; the Phase 11.5 default authorization model is superseded. No stable dual-stack release is required.

## Program Validation

Run after every completed phase:

```bash
mise run format:check
mise run lint
mise run typecheck
mise run test-frontend
mise run test
mise run build
```

Expected: all existing and phase-specific tests pass; no unresolved migration, missing package, permission, or rollback failures remain.

Run after Phase 3 and later:

```bash
mise run plugin:check-builtins
mise run plugin:conformance all
```

Expected: suites reject malformed, over-limit, structurally invalid, incompatible, and unauthorized fixtures.

Run before release milestones:

```bash
mise run tauri:build
```

Expected: packaged resources contain the built-in plugin content and runtime artifacts, never test credentials.

Manual smoke step:

```bash
mise run tauri:dev
```

Expected: the operator verifies main, Quick Translate, screenshot overlay, Plugins, Models, OCR, and Speech windows/flows, then stops the long-running process explicitly.

## Global Failure Behavior

- Invalid content — isolate the entry, or reject the install, without catalog publication.
- Missing package files — preserve data and return `plugin_unavailable`.
- Permission mismatch — deny before credential lookup or network access.
- Guest trap/resource limit — cancel request, mark capability health, preserve config/bindings.
- Upgrade failure — retain the old package, grant, config, preferences, and active runtime identity.
- Import — persist external runtimes inactive without downloading, instantiating, migrating through, granting, or activating code; activation is a separate confirmed lifecycle action.
- Native worker crash — fail the request, terminate the process tree, apply bounded restart policy.

## Privacy and Security

- Content digests prove integrity, not authorship or safety. User archives have no authenticated publisher.
- Tauri capabilities restrict WebView-to-Core IPC only.
- Wasm memory isolation does not make host imports safe automatically.
- Native subprocesses are not permission sandboxes by default.
- Execution grant sets bind plugin, package digest, and one instance/revision; each network entry additionally binds capability, method, origin, auth policy, and resource limits, while each page entry binds page/action IDs.
- Logs contain identifiers, durations, byte counts, and normalized errors only.

## Explicit Non-Goals

- Marketplace, automatic remote updates, billing, or plugin dependency resolution.
- Dynamic Rust/C/C++ libraries inside the Tauri core process.
- Arbitrary routes or React modules loaded into the main WebView.
- Plugin-controlled SQL or database schema.
- Raw credential/token access.
- Ambient file, socket, shell, environment, or process access for Wasm.
- Plugin-to-plugin execution.
- Real-time STT, microphone capture, or long-audio streaming without a separate product specification.
- Big-bang migration of all providers and integrations.

## References

- `docs/architecture/plugin-catalog.md`
- `docs/analysis/runtime-plugin-architecture.md`
- `docs/plans/google-service-integrations/future-gates.md`
- `docs/plans/2026-07-22-provider-plugin-frontend-migration-plan.md`
- `/bytecodealliance/wasmtime/v38.0.4` Context7 evidence for the original architecture analysis
- Wasmtime `47.0.3` docs.rs and release documentation selected for implementation

## Open Questions

None blocking the plan set. Product-specific STT and third-party native containment remain gated in their respective phases.
