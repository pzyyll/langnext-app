# Phase 5: Effect Unification — Implementation Plan

**Goal:** After Phases 1–3 landed, unify Promise bridges, public API surfaces, cancel/result shapes, and small shared helpers so the Effect layer has one clear entry pattern without expanding Effect into UI/Query.

**Inputs:** Post-landing review of Phases 1–4; [Roadmap](./README.md); `docs/architecture/frontend-state-management.md`; current `src/storage/*` and `src/features/*` Effect modules.

**Assumptions:**

- Phases 1–3 are implemented in `src/`; Phase 4 docs landed; theme queue rewrite stays skipped.
- Do **not** introduce `@effect/platform*`, Schema, RPC, or Effect Streams for Tauri events.
- Do **not** move TanStack Query cache orchestration into Effect.
- Do **not** force window-chrome `invoke` (`set_pin`, `notify_ready`, `resize_window_height`, `show_snap_overlay`) through `invokeEffect` / `IpcError`.
- `src/storage/client.ts` remains the Promise façade for **Query-backed DTO CRUD**; stream/detect/batch-cancel and file transfer stay feature-owned.
- Thin Effect wrappers (`startTranslateStream`, `detectLanguageFlow`) may remain as composition seams for slot batch; they are not dual public Promise APIs.
- Dialog cancel stays non-throwing success; only the **shape** of that success is unified.

**Architecture:** One generic Promise bridge rejects with the raw tagged failure (`IpcError`, `FsError`, or their union). Feature modules compose Effects and export `run*` façades for routes. Storage `client.ts` stops re-exporting APIs that already have a feature owner. Shared filesystem naming and user-facing error formatting live next to existing error helpers. Routes stay thin and Effect-free.

**Tech Stack:** Effect 3.x (core only), existing Tauri dialog/fs plugins, Bun tests, `mise` tasks.

**Depends on:** Phases 1–3 complete (Phase 4 optional docs already done).

**Roadmap:** [README.md](./README.md)

**Sequencing (sub-phases, each mergeable alone):**

```text
5A  Promise bridge            [required first]
 |
 +--> 5B  Dual API convergence   [after 5A]
 |
 +--> 5C  Result shapes + helpers [after 5A; parallel with 5B OK]
 |
 '--> 5D  Optional polish         [after 5A; not required]
```

---

## File Map

### 5A — Promise bridge

- Modify: `src/storage/runStorage.ts` — generic `runEffectAsPromise`; keep `runStorage` as IPC-specialized alias or thin wrapper
- Modify: `src/storage/runStorage.test.ts` — cover generic error tags + existing IpcError behavior
- Modify: `src/features/settings/configurationTransfer.ts` — drop local `runTransfer`; use bridge
- Modify: `src/features/history/historyExport.ts` — drop inline either/throw; use bridge
- Modify: `src/features/translate/runTranslate.ts` — drop `asStorageEffect`; run infallible Effects via generic bridge
- Modify (if needed): `docs/architecture/frontend-state-management.md` — name the generic bridge once

### 5B — Dual API convergence

- Modify: `src/storage/client.ts` — remove or hard-deprecate Promise wrappers superseded by feature runners:
  - `translateTextStream`
  - `detectLanguage`
  - `cancelTranslate` (single-id; batch cancel stays feature-owned)
  - `exportConfiguration` / `previewConfigurationImport` / `importConfiguration` when only used as transfer building blocks (keep only if a non-feature caller still needs bare IPC)
- Verify no production imports remain outside tests / feature internals
- Modify: feature modules only if they currently re-export dual Promise names that collide with client
- Test: existing feature tests; add a grep/typecheck gate (no new orphan imports)

### 5C — Result shapes + helpers

- Create: `src/features/localFilenameStamp.ts` (or `src/lib/localFilenameStamp.ts` if a non-feature home is preferred — default: `src/features/localFilenameStamp.ts`) — shared `YYYYMMDDTHHMMSS` stamp
- Modify: `src/features/history/historyExport.ts` — cancel/write result as status union aligned with config transfer
- Modify: `src/routes/history.tsx` — consume new status shape
- Modify: `src/features/history/historyExport.test.ts` — status assertions
- Modify: `src/storage/errors.ts` — add `getUserErrorMessage(error, fallback)` covering `FsError` + IPC
- Modify: `src/storage/errors.test.ts` — FsError + IpcError cases
- Modify: `src/routes/settings.tsx`, `src/routes/history.tsx` — replace duplicated `isFsError ? … : getIpcErrorMessage` branches
- Document: single-id `cancelTranslate` vs `runCancelRequestIds` failure policy (swallow vs surface)

### 5D — Optional polish (not required for unification success)

- Modify: `src/features/settings/configurationTransfer.ts` and/or new helper — optional `applyImportedAppSettings` for theme/language/shortcuts rebind only
- Modify: `src/routes/settings.tsx` — call rebind helper; **keep** Query invalidation in the route
- Docs only: note window-chrome `invoke` stays raw; translate route listener extraction is hook work, not Effect work
- Explicit non-goals remain: ThemeMutationQueue Effect rewrite; Effect inside components/query

---

## Tasks

### Task 1 (5A): Generic Promise bridge

**Outcome:** One bridge rejects with the raw Effect failure value for any error channel; feature-local either/throw copies are gone.

**Files:**

- Modify: `src/storage/runStorage.ts`
- Modify: `src/storage/runStorage.test.ts`
- Modify: `src/features/settings/configurationTransfer.ts`
- Modify: `src/features/history/historyExport.ts`
- Modify: `src/features/translate/runTranslate.ts`
- Modify (optional wording): `docs/architecture/frontend-state-management.md`

**Steps:**

- [ ] Add `runEffectAsPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A>` using `Effect.runPromise(Effect.either(effect))` and throwing `Either` left as-is (same contract as today’s `runStorage` / `runTransfer`)
- [ ] Keep `runStorage<A>(effect: Effect.Effect<A, IpcError>): Promise<A>` as a named alias or one-line wrapper calling the generic bridge (preserves call-site clarity for IPC-only Effects)
- [ ] Keep `runStorageExit` only if still useful for Cause inspection; if production has zero callers, either leave as test-oriented helper with a short comment or delete and adjust tests to use `Effect.runPromiseExit` directly — prefer **keep + comment** to avoid churn
- [ ] Replace `runTransfer` in `configurationTransfer.ts` with `runEffectAsPromise`
- [ ] Replace inline either/throw in `exportHistoryCsv` with `runEffectAsPromise`
- [ ] In `runTranslate.ts`, remove `asStorageEffect`; call `runEffectAsPromise` for `startSlotStreamBatch` / `cancelRequestIds` (`never` error channel) and keep `runStorage` for true `IpcError` Effects
- [ ] Tests: success; `IpcError` rejection identity; `FsError` rejection identity; infallible `never` Effect resolves
- [ ] Architecture note: Promise bridge row mentions generic + IPC alias

**Validation:**

- Run: `bun test src/storage/runStorage.test.ts src/features/history/historyExport.test.ts src/features/settings/configurationTransfer.test.ts src/features/translate/runTranslate.ts src/features/translate/slotBatch.test.ts src/features/translate/detectLanguageFlow.test.ts src/features/translate/translateStream.test.ts`
- Expected: Pass (adjust path list if `runTranslate` has no dedicated test file — then rely on slot/detect/stream + typecheck)
- Run: `mise run typecheck`
- Expected: Exit 0

---

### Task 2 (5B): Converge dual public APIs

**Outcome:** One public Promise path per concern; `client.ts` no longer shadows feature runners for stream/detect/cancel/config transfer.

**Files:**

- Modify: `src/storage/client.ts`
- Modify: any remaining production importers (should be none after Phases 2–3; fix if found)
- Test: existing suites; optional dead-export grep in PR checklist

**Steps:**

- [ ] Inventory production imports of:
  - `translateTextStream`, `detectLanguage`, `cancelTranslate`
  - `exportConfiguration`, `previewConfigurationImport`, `importConfiguration`
- [ ] Confirm routes use `runStartTranslateStream` / `runDetectLanguage` / `runCancelRequestIds` / `runExportConfigurationToFile` / `runImportConfigurationFromFile`
- [ ] Remove superseded exports from `client.ts` **or** reimplement them as thin re-exports of feature runners with a deprecation comment for one PR cycle — prefer **remove** if inventory is empty outside tests
- [ ] Keep bare IPC wrappers only when still needed as building blocks **and** not duplicated as public feature Promise APIs (feature Effects may call `invokeEffect` directly; that is fine)
- [ ] Keep non-stream DTO APIs on `client` (`list*`, `save*`, history CRUD, settings CRUD, screenshot, etc.)
- [ ] Document in `client.ts` ABOUTME or a short comment block: Query/DTO CRUD lives here; translate orchestration and file workflows live under `src/features/*`
- [ ] Do **not** delete thin Effect seams used by slot batch (`startTranslateStream`, `detectLanguageFlow`)

**Validation:**

- Run: `rg -n "translateTextStream|cancelTranslate|from \"./client\".*detectLanguage|exportConfiguration\\(|previewConfigurationImport|importConfiguration\\(" src --glob "!**/*.test.*"` (adjust if Windows shell; use repo search equivalent)
- Expected: No production call sites to removed APIs (tests may mock internals)
- Run: `mise run typecheck`
- Expected: Exit 0
- Run: `mise run test-frontend`
- Expected: Pass

---

### Task 3 (5C): Align dialog result shapes

**Outcome:** History CSV export and configuration save/export share the same cancel/written success vocabulary.

**Files:**

- Modify: `src/features/history/historyExport.ts`
- Modify: `src/features/history/historyExport.test.ts`
- Modify: `src/routes/history.tsx`
- Optionally share type: export a small `DialogSaveResult = { status: "written" } | { status: "cancelled" }` from history module or a tiny shared types file next to `fsError.ts` (e.g. `src/features/dialogResult.ts`) if both modules should import one definition — prefer **one shared type** over drift

**Steps:**

- [ ] Introduce shared type:

  ```ts
  export type DialogSaveResult =
    | { readonly status: "written" }
    | { readonly status: "cancelled" };
  ```

- [ ] Change `exportHistoryCsvEffect` success type from `boolean` to `DialogSaveResult`
- [ ] Change `exportHistoryCsv(): Promise<DialogSaveResult>` accordingly
- [ ] Update `history.tsx`: `if (result.status === "written")` for success toast; cancel remains silent
- [ ] Align naming with configuration transfer (`written` / `cancelled`); do not invent a third vocabulary
- [ ] Tests: cancel → `{ status: "cancelled" }`; success → `{ status: "written" }`; write failure still `FsError`

**Validation:**

- Run: `bun test src/features/history/historyExport.test.ts`
- Expected: Pass
- Run: `mise run typecheck`
- Expected: Exit 0

---

### Task 4 (5C): Shared filename stamp + user error message helper

**Outcome:** No duplicated stamp helper; routes use one display helper for `FsError | IpcError | unknown`.

**Files:**

- Create: `src/features/localFilenameStamp.ts`
- Modify: `src/features/history/historyExport.ts`
- Modify: `src/features/settings/configurationTransfer.ts`
- Modify: `src/storage/errors.ts`
- Modify: `src/storage/errors.test.ts`
- Modify: `src/routes/settings.tsx`
- Modify: `src/routes/history.tsx`
- Optionally document cancel policies near `runCancelRequestIds` / former `cancelTranslate`

**Steps:**

- [ ] Move identical `localFilenameStamp` implementation to `src/features/localFilenameStamp.ts` with ABOUTME header; export pure function
- [ ] Both export modules import the shared helper; default filenames stay `langnext-history-…csv` and `langnext-config-….json`
- [ ] Add `getUserErrorMessage(error: unknown, fallback: string): string`:
  - If `isFsError(error)` → trimmed `error.message` or `fallback`
  - Else → existing `getIpcErrorMessage(error, fallback)` path (keeps `unknown`-tolerant decode)
- [ ] Replace duplicated branches in settings backup handlers and history export catch
- [ ] Do not change conflict-specific UI (`isConflictError` in ProviderEditor stays)
- [ ] Comment on cancel policy:
  - Feature batch cancel: swallow per-id failures (request may already be finished)
  - If a single-id cancel API remains anywhere, it surfaces `IpcError` / boolean from backend — do not silently mix policies without a comment

**Validation:**

- Run: `bun test src/storage/errors.test.ts src/features/history/historyExport.test.ts src/features/settings/configurationTransfer.test.ts`
- Expected: Pass
- Run: `mise run typecheck`
- Expected: Exit 0

---

### Task 5 (5D, optional): Import settings rebind helper

**Outcome:** Post-import theme/language/shortcuts rebind is testable outside the route; Query invalidation stays in the route.

**Files:**

- Modify: `src/features/settings/configurationTransfer.ts` (or create `src/features/settings/applyImportedAppSettings.ts`)
- Modify: `src/routes/settings.tsx`
- Test: unit test with mocked settings client + theme/i18n applies

**Steps:**

- [ ] Extract only:
  - `getAppSettings`
  - apply theme when mode valid
  - `applyAppLanguage(normalizeLanguage(...))`
  - `setAppShortcuts(settings.shortcuts)`
- [ ] Leave provider/model/profile `queryClient.invalidateQueries` in `settings.tsx`
- [ ] Error channel: IPC failures as `IpcError` via existing bridge; route still uses `getUserErrorMessage`
- [ ] Never log full settings blobs or credentials
- [ ] Skip this task if import UX is stable and extraction would be drive-by scope

**Validation:**

- Run: targeted test for the new helper + `mise run typecheck`
- Expected: Pass / Exit 0

---

### Task 6: Phase 5 gate + docs

**Outcome:** Roadmap and architecture docs match the unified surface; no Effect in components/query/routes.

**Files:**

- Modify: `docs/plans/effect-integration-plan/README.md` — Phase 5 status and links
- Modify: `docs/architecture/frontend-state-management.md` — bridge + ownership table rows if Task 1/2 changed names
- This plan file — mark tasks done in the implementing PR description (checkbox updates optional)

**Steps:**

- [ ] Update roadmap status: Phases 1–3 done; 4 optional done/skipped; 5 unification in progress/done
- [ ] Restate layer rules unchanged: no Effect in `components` / `query`; routes call runners only
- [ ] Explicit out-of-scope recap in architecture note if helpful: window chrome invoke; ThemeMutationQueue; translate listener hooks

**Validation:**

- Run: `mise run typecheck && mise run test-frontend && mise run lint`
- Expected: Exit 0 / Pass
- Run: `rg -n "from [\"']effect" src/components src/query src/routes`
- Expected: No matches

---

## Final Validation

```bash
mise run typecheck
mise run test-frontend
mise run lint
```

Expected: all exit 0 / pass.

Optional inventory checks:

```bash
# No Effect leakage into UI layers
rg -n "from [\"']effect" src/components src/query src/routes

# No dual stream/detect entry from client after 5B
rg -n "translateTextStream|cancelTranslate" src --glob "!**/*.test.*"
```

---

## Failure Behavior

| Failure | Expected |
| ------- | -------- |
| IPC invoke rejection | Bridge rejects raw `IpcError`; UI uses `getUserErrorMessage` / `getIpcErrorMessage` |
| Dialog cancel | Success variant `{ status: "cancelled" }` (history + config); no toast |
| Dialog/fs write/read/parse error | Bridge rejects raw `FsError`; UI uses `getUserErrorMessage` |
| Slot stream start failure | Per-slot `status: "failed"` outcome; siblings still start |
| Batch cancel per-id failure | Swallowed; overall Promise resolves |
| Import invalid preview | Success variant `status: "invalid"`; no import IPC apply |
| Import applied but settings rebind fails (5D) | Surface IPC error after DB import already applied — document as best-effort rebind (same as today) |

---

## Privacy and Security

- Do not log invoke args, export documents, history CSV bodies, or settings blobs.
- Do not put credentials into Effect failures or user-facing messages beyond existing redacted IPC messages.
- Trust boundary remains Tauri IPC + native dialog/fs plugins.

---

## Rollout Notes

| Item | Guidance |
| ---- | -------- |
| Branch | `refactor/effect-unification` (or `refactor/effect-bridge`, then follow-ups) |
| Merge order | 5A → 5B → 5C; 5D optional last |
| Migrations | None (frontend-only; no IPC/DB version bump) |
| Compat | History export boolean → status union is a **breaking internal API**; only `history.tsx` + tests should need updates |
| Bundle | No new packages; expect negligible delta |

---

## Risks and Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Removing `client` exports breaks a hidden caller | Inventory with search before delete; typecheck is the gate |
| Generic bridge weakens IPC-only typing at call sites | Keep `runStorage` alias typed to `IpcError` |
| Status-union migration misses a call site | Typecheck + history tests |
| Scope creep into translate route rewrite | Explicit out-of-scope: listeners/hooks only if separate plan |
| Over-abstracting dialog/fs | Share only stamp + `DialogSaveResult` + error message helper |

---

## Out of Scope

- Effect-ifying `ThemeMutationQueue` (still single consumer)
- Replacing TanStack Query or putting DTO cache in fibers
- Effect inside `src/components/*` or `src/query/*`
- Wrapping window-chrome commands in `IpcError`
- Moving translate stream **event listeners** into Effect Stream
- Large split of `quick-translate.tsx` / `translate/index.tsx` (hook extraction may be a separate plan)
- New Effect ecosystem packages
- Rust protocol changes

---

## Open Questions

| Question | Default | Affects |
| -------- | ------- | ------- |
| Delete vs one-cycle deprecate dual `client` exports | **Delete** when inventory empty | 5B |
| Shared `DialogSaveResult` home (`features/dialogResult.ts` vs export from history and re-export) | **`src/features/dialogResult.ts`** | 5C |
| Keep `runStorageExit` | **Keep + comment** (test/Cause utility) | 5A |
| Ship 5D import rebind extraction | **Skip unless touching settings import anyway** | 5D |

---

## Requirement Traceability

| Review finding | Task / sub-phase |
| -------------- | ---------------- |
| Triple Promise bridge (`runStorage` / `runTransfer` / history either) | Task 1 / 5A |
| `asStorageEffect` cast for `never` | Task 1 / 5A |
| Dual APIs on `client` vs feature runners | Task 2 / 5B |
| `false` vs `{ status: "cancelled" }` | Task 3 / 5C |
| Duplicated `localFilenameStamp` | Task 4 / 5C |
| Duplicated Fs/IPC toast branching | Task 4 / 5C |
| Cancel policy clarity | Task 4 / 5C |
| Import post-steps still in route | Task 5 / 5D (optional) |
| Window chrome raw invoke | Out of scope (documented) |
| Theme queue Effect rewrite | Out of scope |
| Layer rules / docs accuracy | Task 6 |
