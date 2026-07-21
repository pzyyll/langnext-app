# Effect Integration Roadmap

**Goal:** Introduce Effect on the frontend as a typed IPC and workflow layer without replacing TanStack Query, React UI, or the Rust domain model.

**Inputs:** Storage/query/translate boundary analysis; `src/storage/*`, `src/query/*`, translate routes; Rust `IpcError` in `src-tauri/src/error.rs`.

**Status:** Phases 1–3 implemented in `src/`; Phase 4 architecture note landed (theme queue rewrite skipped — single consumer). This directory remains the roadmap and phase-plan reference.

---

## Documents

| Doc                                                              | Role                                                             | Mergeable alone?                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| [phase-1-ipc-foundation.md](./phase-1-ipc-foundation.md)         | Typed `IpcError`, `invokeEffect`, Promise bridge, conflict pilot | Yes — first ship                           |
| [phase-2-translate-usecases.md](./phase-2-translate-usecases.md) | Stream / detect / multi-slot use-cases out of routes             | Yes — after Phase 1                        |
| [phase-3-workflows.md](./phase-3-workflows.md)                   | Bootstrap, config transfer, history export                       | Yes — after Phase 1 (Phase 2 not required) |
| [phase-4-optional.md](./phase-4-optional.md)                     | Ordered writes, architecture note polish                         | Optional                                   |

Phase plans are full implementation plans (file map, tasks, validation). This file is the roadmap only: sequencing, shared decisions, and cross-phase constraints.

---

## Shared Assumptions

- **Frontend TypeScript only.** Rust keeps `StorageError` / `IpcError`; no Effect on the backend.
- **TanStack Query stays** the persistent DTO cache. `queryFn` / `mutationFn` remain Promise-based.
- **`src/storage/client.ts` Promise signatures stay** for callers; Effect runs under the bridge.
- **Core package only for Phases 1–2:** npm `effect` 3.x via `bun add effect`. No `@effect/platform*`, `@effect/rpc`, or HTTP Schema stacks unless a later plan requires them.
- **Domain authority stays in Rust.** Frontend Effect = orchestration + error channels.
- **Display helpers stay `unknown`-tolerant:** `getIpcErrorMessage` / `getIpcErrorCode` / `isConflictError`.
- Every app code file keeps the 2-line `ABOUTME:` header.

---

## Architecture (cross-phase)

```text
Route / Feature UI
  |  hooks, Query, local UI state
  v
Feature use-case (Phase 2+)     -- optional --
  |  Effect composition
  v
storage/client Promise API  <--+-- runStorage (Effect.runPromise)
  |                            |
  v                            |
invokeEffect  -----------------+
  |  tryPromise + decode -> IpcError
  v
Tauri invoke
  |
  v
Rust -> StorageError -> IpcError { code, message }
```

### Layer rules

| Layer                      | Rule                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `src/components/*`         | No Effect imports                                              |
| `src/query/*`              | Promise storage APIs only                                      |
| `src/storage/*`            | Owns IPC Effect adapter + typed errors                         |
| `src/features/*` use-cases | May compose Effects; export runners for routes                 |
| `src/routes/*`             | Thin: call runners; no deep Effect pipelines in JSX            |
| Secrets / logs             | Never put credentials in Effect errors; use `logger` redaction |

---

## Phase Overview

```text
Phase 1  IPC foundation          [required first]
   |
   +---> Phase 2  Translate use-cases     [depends on Phase 1]
   |
   +---> Phase 3  Startup / file workflows [depends on Phase 1; parallel to Phase 2]
   |
   '---> Phase 4  Optional polish          [after Phase 1; mostly docs / opportunistic]
```

| Phase | Outcome                                                                                                     | Depends on |
| ----- | ----------------------------------------------------------------------------------------------------------- | ---------- |
| 1     | `effect` dep; `IpcError`; `invokeEffect` + `runStorage`; client bridge; ProviderEditor conflict still works | —          |
| 2     | Translate stream/detect/slot batch as feature modules; thinner routes                                       | Phase 1    |
| 3     | Bootstrap + configuration transfer + history export typed cancel/fail                                       | Phase 1    |
| 4     | Theme queue only if second ordered-write appears; architecture doc note                                     | Phase 1    |

---

## IPC Error Contract (shared)

Mirror Rust `IpcError` (`src-tauri/src/error.rs`). Full decode rules live in Phase 1.

Known codes (open union — unknown string codes from the wire are kept, not forced to `"unknown"`):

`validation_failed` · `not_found` · `conflict` · `in_use` · `credential_busy` · `credential_unavailable` · `storage_unavailable` · `storage_version_unsupported` · `internal_error` · `shortcut_apply_failed` · `unknown` (non-conforming rejections)

---

## Out of Scope (program-wide)

- Replacing TanStack Query or putting server-state in Effect fibers
- Effect inside UI primitives / Base UI
- Effect-ifying pure helpers (`historyCsv`, language lists, workspace prefs, query keys)
- Dual public API surface (`*Effect` exports) with no consumer
- Rust protocol or toolchain changes
- Full multi-slot fiber runtime unless Phase 2 tests justify it (default: explicit `requestId` sets)

---

## Rollout

| Item           | Guidance                                                  |
| -------------- | --------------------------------------------------------- |
| First merge    | Phase 1 only (`feat/effect-ipc`)                          |
| Later branches | `feat/effect-translate-usecases`, `feat/effect-workflows` |
| Migrations     | None (no DB / no IPC version bump)                        |
| Bundle         | Note main-chunk delta after Phase 1 (`mise run build`)    |

### Cross-phase validation (any phase PR)

```bash
mise run typecheck
mise run test-frontend
mise run lint
```

---

## Privacy and Security (program-wide)

- Trust boundary = Tauri IPC; do not log invoke args (credentials).
- Log `IpcError.message` only through existing redaction paths.
- Do not log import/export documents or history CSV bodies.
- Do not put tokens/API keys into Effect failures or dev stack dumps.

---

## Open Questions

| Question                                                              | Default                                           | Affects |
| --------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Multi-slot cancel: fibers vs explicit `requestId` sets                | Explicit `requestId` + `cancel_translate`         | Phase 2 |
| Config transfer path: `features/settings` vs `features/import-export` | `src/features/settings/configurationTransfer.ts`  | Phase 3 |
| Architecture note timing                                              | Phase 4 (or append early in Phase 1 PR if useful) | Phase 4 |

---

## Requirement Traceability

| Intent                                     | Phase plan             |
| ------------------------------------------ | ---------------------- |
| Typed IPC errors + bridge                  | Phase 1                |
| Keep Query; progressive adoption           | Phase 1 (+ rules here) |
| Conflict pilot                             | Phase 1                |
| Translate orchestration extraction         | Phase 2                |
| Bootstrap / import-export / history export | Phase 3                |
| Optional ordered-write unification         | Phase 4                |
| No component-level Effect                  | All phases             |

---

## Supersedes

This directory replaces the monolithic `docs/plans/2026-07-21-effect-integration-plan.md` (stub pointer only).
