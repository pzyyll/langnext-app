# Phase 3: Startup and File Workflows — Implementation Plan

**Goal:** Type multi-step non-Query workflows — bootstrap, configuration export/import, history CSV export — so cancel, IPC failure, and filesystem failure are distinct channels.

**Inputs:** [Roadmap](./README.md); [Phase 1](./phase-1-ipc-foundation.md); `src/storage/bootstrap.ts`; `src/features/history/historyExport.ts`; settings import/export usage in `src/routes/settings.tsx`.

**Assumptions:**

- Phase 1 is merged. **Phase 2 is not required** (can ship in parallel after Phase 1).
- `bootstrapStorage` keeps export signature `Promise<AppSettingsDto | null>`.
- History export keeps pure `buildHistoryCsv`; only dialog + write are effectful.
- Configuration transfer lives at `src/features/settings/configurationTransfer.ts` (roadmap default; not a new top-level feature folder).
- Filesystem / dialog errors are **not** forced into IPC codes; use a small local tagged error (e.g. `FsError`) when needed.
- Dialog cancel remains non-throwing success (`written: false` / existing `false`).

**Architecture:** Compose Phase 1 storage Effects (or bridged client) for IPC steps. File dialog + `writeTextFile` sit beside IPC in the same program with separate error tags. Routes call Promise façades and map errors with `getIpcErrorMessage` only for IPC-shaped failures.

**Tech Stack:** Effect 3.x, Tauri dialog/fs plugins, storage client bridge, Bun tests.

**Depends on:** Phase 1 complete.

**Roadmap:** [README.md](./README.md)

---

## File Map

- Modify: `src/storage/bootstrap.ts` — Effect program; Promise export unchanged
- Modify: `src/features/history/historyExport.ts` — typed cancel vs write failure
- Create: `src/features/settings/configurationTransfer.ts` — export → preview → import pipeline helpers
- Modify: `src/routes/settings.tsx` — import/export handlers call transfer helpers
- Test: `src/storage/bootstrap.test.ts`
- Test: `src/features/history/historyExport.test.ts`
- Test: `src/features/settings/configurationTransfer.test.ts`

---

## Tasks

### Task 1: Bootstrap program

**Outcome:** Same runtime behavior; internal steps are a composable program with typed IPC failures.

**Files:**

- Modify: `src/storage/bootstrap.ts`
- Test: `src/storage/bootstrap.test.ts`

**Steps:**

- [ ] Steps: `getAppSettings` → if `theme === null`, one-time migration `updateAppSettings` → apply theme DOM/cache → i18n init/apply
- [ ] Browser-only path: no IPC; cache theme + `initI18n`; return `null` (unchanged)
- [ ] Keep public `bootstrapStorage(): Promise<AppSettingsDto | null>`
- [ ] Tests with mocked client: Tauri happy path; null theme migrates once; browser path

**Validation:**

- Run: `bun test src/storage/bootstrap.test.ts`
- Expected: Pass
- Run: `mise run typecheck`
- Expected: Exit 0

---

### Task 2: History CSV export channels

**Outcome:** Cancel ≠ write failure; pure CSV builder untouched.

**Files:**

- Modify: `src/features/history/historyExport.ts`
- Test: `src/features/history/historyExport.test.ts`

**Steps:**

- [ ] Keep `buildHistoryCsv` pure (existing module)
- [ ] Dialog cancel → `false` / `{ written: false }` without throw (preserve current boolean API unless a thin result type is clearer **and** call sites update)
- [ ] `writeTextFile` failure → tagged local error or rejected Promise; **do not** use `conflict` / other IPC codes
- [ ] Mock dialog + fs in tests: cancel; write success; write throw

**Validation:**

- Run: `bun test src/features/history/historyExport.test.ts`
- Expected: Pass
- Run: `mise run typecheck`
- Expected: Exit 0

---

### Task 3: Configuration transfer helpers

**Outcome:** Settings import/export multi-step IPC is testable outside the route.

**Files:**

- Create: `src/features/settings/configurationTransfer.ts`
- Test: `src/features/settings/configurationTransfer.test.ts`
- Modify: `src/routes/settings.tsx` (handlers only)

**Steps:**

- [ ] Helpers for: `exportConfiguration`; `previewConfigurationImport`; `importConfiguration` (via storage client/bridge)
- [ ] File pick/save stays aligned with current settings UX (dialog in helper or route — pick one place and document in ABOUTME)
- [ ] Route toasts: IPC failures via `getIpcErrorMessage`; cancel silent/soft per current UX
- [ ] Never log full export documents or secrets
- [ ] Tests: preview failure; import success; conflict/validation codes if exercised by mocks

**Validation:**

- Run: `bun test src/features/settings/configurationTransfer.test.ts`
- Expected: Pass
- Run: `mise run typecheck`
- Expected: Exit 0

---

### Task 4: Phase 3 gate

**Outcome:** Workflows merge without regressing startup or settings.

**Files:** none

**Steps:**

- [ ] Full suite
- [ ] No Effect under `src/components`
- [ ] Manual smoke list below

**Validation:**

- Run: `mise run typecheck && mise run test-frontend && mise run lint`
- Expected: Exit 0
- Manual (Tauri): cold start theme/language; history export cancel + success; settings export/import happy path + validation error toast

---

## Final Validation

- Run: `mise run typecheck && mise run test-frontend && mise run lint`
- Expected: Exit 0

---

## Failure Behavior

| Failure                        | Behavior                                                               |
| ------------------------------ | ---------------------------------------------------------------------- |
| Bootstrap IPC failure          | Promise rejects `IpcError`; startup error handling unchanged at caller |
| History dialog cancel          | Non-error; `false` / not written                                       |
| History write failure          | Error distinct from cancel; UI toast via existing history route path   |
| Config IPC validation/conflict | `IpcError` codes; toast with sanitized message                         |
| Config dialog cancel           | Silent / soft; no throw                                                |

---

## Privacy and Security

- Do not log configuration documents, CSV bodies, or credentials.
- Export payload already omits raw secrets on the backend — do not reintroduce secrets in frontend logs.
- Bootstrap must not log full settings blobs.

---

## Rollout Notes

- Branch: `feat/effect-workflows`
- Can merge without Phase 2
- No schema migration

---

## Risks and Mitigations

| Risk                                | Mitigation                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Bootstrap regression on first paint | Mocked unit tests + manual cold start                                       |
| Mis-tagged FS errors as IPC         | Local `FsError` (or equivalent); never reuse IPC code strings for dialog/fs |
| Settings route churn                | Touch only import/export handlers                                           |

---

## Open Questions

- Folder name already defaulted to `src/features/settings/configurationTransfer.ts` in roadmap.

---

## Out of Scope (this phase)

- Translate multi-slot (Phase 2)
- Theme mutation queue rewrite (Phase 4)
- Changing export document schema
