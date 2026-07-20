# Phase 1: IPC Foundation — Implementation Plan

**Goal:** Add Effect as a typed Tauri IPC adapter: stable `IpcError`, `invokeEffect`, Promise bridge, wire `storage/client`, and keep ProviderEditor conflict UX working.

**Inputs:** [Effect Integration Roadmap](./README.md); `src/storage/*`; `src/features/models/ProviderEditor.tsx`; Rust `IpcError` in `src-tauri/src/error.rs`.

**Assumptions:**

- Ship independently; no Phase 2/3 code in this PR.
- Public Promise APIs on `src/storage/client.ts` keep names and signatures.
- Install `effect` 3.x with Bun only (`bun add effect`).
- Prefer `Data.TaggedError` (or equivalent tagged class) for `IpcError`.
- Display helpers continue to accept `unknown`.

**Architecture:** `invoke` rejections decode to `IpcError`. `invokeEffect` returns `Effect<A, IpcError>`. `runStorage` / `runStorageExit` bridge to Promises for Query and existing callers. Client functions call the bridge; React Query and routes need no Effect imports.

**Tech Stack:** Effect 3.x, Tauri 2 `invoke`, Bun, TypeScript (`mise run typecheck`), frontend tests (`mise run test-frontend`).

**Depends on:** None.

**Roadmap:** [README.md](./README.md)

---

## File Map

- Create: `src/storage/ipcError.ts` — tagged `IpcError`, decode, guards
- Create: `src/storage/invokeEffect.ts` — `invokeEffect(cmd, args)`
- Create: `src/storage/runStorage.ts` — `runStorage` / `runStorageExit`
- Modify: `src/storage/errors.ts` — helpers via decode; preserve signatures
- Modify: `src/storage/client.ts` — all invokes through bridge
- Modify: `package.json` / `bun.lock` — `effect` dependency
- Modify: `src/features/models/ProviderEditor.tsx` — verify conflict path with `IpcError` (minimal touch)
- Test: `src/storage/ipcError.test.ts`
- Test: `src/storage/invokeEffect.test.ts`
- Test: `src/storage/runStorage.test.ts`
- Test: `src/storage/errors.test.ts` (extend)

---

## IPC Error Contract

```ts
// Conceptual — implement with Data.TaggedError or tagged class
type IpcErrorCode =
  | "validation_failed"
  | "not_found"
  | "conflict"
  | "in_use"
  | "credential_busy"
  | "credential_unavailable"
  | "storage_unavailable"
  | "storage_version_unsupported"
  | "internal_error"
  | "shortcut_apply_failed"
  | "unknown";

// code is open: non-empty wire codes not in the list are preserved as-is
interface IpcErrorShape {
  readonly _tag: "IpcError";
  readonly code: IpcErrorCode | (string & {});
  readonly message: string;
}
```

**Decode rules (`decodeIpcRejection`):**

| Input | Result |
|-------|--------|
| Object with non-empty string `code` | Use `code`; `message` = string message or `""` |
| `Error` with non-empty message | `code: "unknown"`, that message |
| Non-empty string | `code: "unknown"`, that string |
| Else | `code: "unknown"`, `message: ""` (UI uses `fallback`) |

- `isConflictError` / `ipcErrorIsConflict` ↔ `code === "conflict"`.
- Do not invent new wire codes.

---

## Tasks

### Task 1: Add Effect dependency

**Outcome:** `effect` is installed and locked; only Bun lockfile.

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`

**Steps:**

- [ ] From repo root: `bun add effect`
- [ ] Confirm no `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`
- [ ] Do not add `package.json` scripts

**Validation:**

- Run: `bun pm ls effect`
- Expected: Resolved **3.x**; `package.json` `dependencies.effect` present

---

### Task 2: Typed `IpcError` + decode

**Outcome:** Unknown rejections become a stable `IpcError` for Effect’s error channel.

**Files:**

- Create: `src/storage/ipcError.ts`
- Test: `src/storage/ipcError.test.ts`

**Steps:**

- [ ] 2-line `ABOUTME` header
- [ ] `IpcError` via `Data.TaggedError` (or equivalent) with `code`, `message`
- [ ] Export `decodeIpcRejection(error: unknown): IpcError` per contract table
- [ ] Export `isIpcError(u: unknown): u is IpcError`
- [ ] Export `ipcErrorIsConflict(err: IpcError): boolean`
- [ ] Tests: structured conflict; `validation_failed`; string; empty object; `Error`; garbage

**Validation:**

- Run: `bun test src/storage/ipcError.test.ts`
- Expected: All pass

---

### Task 3: Compatible error helpers

**Outcome:** Existing `errors.ts` API unchanged for callers; recognizes `IpcError`.

**Files:**

- Modify: `src/storage/errors.ts`
- Test: `src/storage/errors.test.ts`

**Steps:**

- [ ] Route `getIpcErrorCode` / `getIpcErrorMessage` / `isConflictError` through decode (shared path with Task 2)
- [ ] Keep signatures and `getIpcErrorMessage(error, fallback)` fallback semantics
- [ ] Tests: `IpcError` conflict instance; empty message → fallback

**Validation:**

- Run: `bun test src/storage/errors.test.ts src/storage/ipcError.test.ts`
- Expected: All pass

---

### Task 4: `invokeEffect` + Promise bridge

**Outcome:** Commands runnable as Effect or as Promise rejecting `IpcError`.

**Files:**

- Create: `src/storage/invokeEffect.ts`
- Create: `src/storage/runStorage.ts`
- Test: `src/storage/invokeEffect.test.ts`
- Test: `src/storage/runStorage.test.ts`

**Steps:**

- [ ] `invokeEffect<A>(cmd: string, args?: Record<string, unknown>): Effect.Effect<A, IpcError>` using `Effect.tryPromise` + `decodeIpcRejection` in `catch`
- [ ] Never log `args` (may hold credentials)
- [ ] `runStorage(effect)` → `Effect.runPromise(effect)` (reject value = `IpcError`)
- [ ] `runStorageExit(effect)` → `Effect.runPromiseExit(effect)`
- [ ] Tests: success; reject `{ code: "conflict", message: "stale" }` → failed Effect / rejected Promise with that code

**Validation:**

- Run: `bun test src/storage/invokeEffect.test.ts src/storage/runStorage.test.ts`
- Expected: All pass

---

### Task 5: Wire `storage/client`

**Outcome:** Exported async functions still Promise-based; IPC failures reject with decoded `IpcError`.

**Files:**

- Modify: `src/storage/client.ts`

**Steps:**

- [ ] Replace `return invoke(...)` with `return runStorage(invokeEffect<...>(command, args))`
- [ ] Keep export names, param types, event name constants
- [ ] No React imports

**Validation:**

- Run: `mise run typecheck`
- Expected: Exit 0
- Run: `mise run test-frontend`
- Expected: Existing tests pass

---

### Task 6: ProviderEditor conflict pilot

**Outcome:** Rename/save conflict UX still works when rejections are `IpcError`.

**Files:**

- Modify: `src/features/models/ProviderEditor.tsx` (only if needed)

**Steps:**

- [ ] Confirm `isConflictError(error)` in `handleRename` / `handleSave` works with bridged `IpcError`
- [ ] Optional: narrow with `isIpcError` for copy; keep i18n fallbacks
- [ ] No unrelated editor refactors

**Validation:**

- Run: `mise run typecheck`
- Expected: Exit 0
- Manual (Tauri): stale `expectedUpdatedAt` save → conflict UI; no `[object Object]`

---

### Task 7: Phase 1 gate

**Outcome:** PR is mergeable; layer rules hold.

**Files:** none

**Steps:**

- [ ] Full validation suite
- [ ] Grep: no `from "effect"` / `from 'effect'` under `src/components`
- [ ] Grep: `src/query` still imports Promise APIs from `storage/client` only (no Effect)

**Validation:**

- Run: `mise run typecheck`
- Expected: Exit 0
- Run: `mise run test-frontend`
- Expected: Exit 0
- Run: `mise run lint`
- Expected: Exit 0
- Run: `mise run build` (optional but recommended)
- Expected: Exit 0; note bundle delta in PR

---

## Final Validation

- Run: `mise run typecheck && mise run test-frontend && mise run lint`
- Expected: Exit 0

---

## Failure Behavior

| Failure | Behavior |
|---------|----------|
| Tauri `{ code, message }` | `IpcError`; Promise rejects with it; UI uses helpers |
| Non-conforming reject | `code: "unknown"`; display `fallback` when message empty |
| Query `queryFn` failure | Query error state unchanged; error value is `IpcError` |

---

## Privacy and Security

- Do not log invoke args or credentials.
- Reuse `logger` redaction if logging messages.
- No new secret surfaces.

---

## Rollout Notes

- Branch: `feat/effect-ipc`
- No DB/IPC version migration
- Do not start Phase 2/3 files in this PR

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Review / learning cost | Limit to `storage/*` + optional ProviderEditor touch |
| Query double abstraction | Promise bridge; no Effect in `query/options.ts` |
| `instanceof` fragility | Use `isIpcError` / `isConflictError` |

---

## Open Questions

- None for Phase 1.

---

## Out of Scope (this phase)

- Translate route extraction
- Bootstrap / import-export / history export Effect programs
- Theme mutation queue
- Architecture doc rewrite (see Phase 4)
