# Translate Route Thinning — Implementation Plan

**Goal:** Shrink `src/routes/translate/index.tsx` and `src/routes/quick-translate.tsx` by extracting stream listener lifecycle, shared pure helpers, and window-chrome invokes — without moving UI state into Effect or Query.

**Inputs:** Post–Effect Phase 2/5 review; current translate routes; feature runners in `src/features/translate/runTranslate.ts`; architecture note in `docs/architecture/frontend-state-management.md` (stream events stay Tauri listeners).

**Assumptions:**

- Effect Phase 2 already owns IPC start/cancel/detect (`runStartTranslateStream`, `runStartSlotStreamBatch`, `runDetectLanguage`, `runCancelRequestIds`). This plan does **not** re-open that layer.
- **No Effect Stream** for `translate://chunk|reset|done|error`. Listeners stay `@tauri-apps/api/event` `listen`.
- **No Query cache for streaming chunks** or per-keystroke source text.
- Routes may keep local React state; extraction targets **reusable hooks and pure modules**, not a second state framework.
- Quick-translate multi-slot and main translate single-stream differ; share primitives first, then page-specific controllers.
- Window chrome (`set_pin`, `notify_ready`, `resize_window_height`) stays raw Tauri `invoke` (not `IpcError` / `invokeEffect`) unless a later shell-error plan says otherwise.
- File-based routes: non-route modules under `src/routes` must use the `-` prefix (`routeFileIgnorePrefix`). Prefer placing shared logic under `src/features/translate/*` instead of route-adjacent files when both pages need it.

**Architecture:**

```text
Route (JSX + page state)
  |  useTranslateStreamSession / useSlotStreamSessions  (listener + requestId)
  |  pure: buildTranslateInput, resolveTranslateFailureMessage, …
  |  window helpers (quick-translate only)
  v
runStartTranslateStream / runStartSlotStreamBatch / runDetectLanguage / runCancelRequestIds
  v
invokeEffect → Tauri
  + parallel: listen(TRANSLATE_*_EVENT) filtered by requestId
```

**Tech Stack:** React 19, TanStack Router, Tauri event API, existing feature Promise runners, Bun tests. No new Effect packages.

**Depends on:** Effect Phase 2 runners stable. Independent of Phase 5D import rebind.

**Related:** [effect-integration-plan/README.md](./effect-integration-plan/README.md) (IPC/workflow only); this plan is UI structure, not Effect adoption.

---

## Phase overview

```text
T1  Shared pure helpers          [mergeable alone]
 |
 +--> T2  Single-stream session hook   [main translate page]
 |
 +--> T3  Multi-slot stream session    [quick-translate; can reuse T1 listen helpers]
 |
 +--> T4  Quick-translate window chrome helpers
 |
 '--> T5  Optional session/debounce pure extracts + route smoke cleanup
```

Each phase is independently reviewable. Prefer **behavior-preserving** moves: same event filters, same cancel/generation/epoch rules, same debounce constants.

---

## File Map (program-wide)

| Path                                                                                                                                    | Role                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Create: `src/features/translate/streamEvents.ts`                                                                                        | Re-export or document event names + payload types used by hooks (optional if hooks import from `storage/client` constants) |
| Create: `src/features/translate/resolveTranslateFailureMessage.ts`                                                                      | Pure failure display mapping shared by pages                                                                               |
| Create: `src/features/translate/buildTranslateInput.ts` (name may match existing payload shape)                                         | Pure `TranslateInput` assembly if both pages duplicate fields                                                              |
| Create: `src/features/translate/useTranslateStreamListeners.ts`                                                                         | Low-level: attach/detach four listeners; return unlisten bundle                                                            |
| Create: `src/features/translate/useTranslateStreamSession.ts`                                                                           | Single active `requestId` + generation-friendly callbacks for main page                                                    |
| Create: `src/features/translate/useSlotStreamSessions.ts`                                                                               | Multi-slot map of requestIds + epoch checks for quick-translate                                                            |
| Create: `src/features/translate/quickTranslateWindow.ts`                                                                                | `notify_ready`, `set_pin`, `resize_window_height` wrappers                                                                 |
| Test: colocated `*.test.ts` for pure helpers; hook tests only if project already patterns support them (prefer pure + thin integration) |
| Modify: `src/routes/translate/index.tsx`                                                                                                | Consume single-stream session + pure helpers                                                                               |
| Modify: `src/routes/quick-translate.tsx`                                                                                                | Consume multi-slot session + window helpers + pure helpers                                                                 |
| Modify: `docs/architecture/frontend-state-management.md`                                                                                | One line: stream session hooks live under features/translate                                                               |

Exact filenames may shift slightly if an existing module already owns a concern; do not create parallel helpers.

---

## Current hotspots (evidence)

### Main translate — `src/routes/translate/index.tsx` (~1.3k lines)

- `activeRequestId` ref + `runCancelRequestIds`
- `listen` ×4 for chunk/reset/done/error with `activeRequestId` filter
- `finishErrorUi` / `resolveTranslateFailureMessage`
- `runStartTranslateStream` after listeners registered
- Workspace rail / profile apply / model options remain page-owned

### Quick translate — `src/routes/quick-translate.tsx` (~1.8k lines)

- `requestIdsRef: Map<slotId, requestId>` + detect key `__detect__`
- `isSlotEpochCurrent`, `prepareSlotStream` (listen-before-invoke)
- `runStartSlotStreamBatch` / `runDetectLanguage` / `runCancelRequestIds`
- Debounce `TRANSLATE_DEBOUNCE_MS`, session `sessionStorage`, continuous source-edit heuristic
- Window: `set_pin`, `notify_ready`, `resize_window_height`

---

## Tasks

### Task T1: Shared pure helpers

**Outcome:** Failure message mapping (and any trivially shared pure builders) live outside both routes; unit-tested.

**Files:**

- Create: `src/features/translate/resolveTranslateFailureMessage.ts`
- Test: `src/features/translate/resolveTranslateFailureMessage.test.ts`
- Modify: both routes to import the helper
- Optionally extract `newRequestId` / `newId` to one `newClientRequestId.ts` if both use crypto/random UUID the same way

**Steps:**

- [ ] Move `resolveTranslateFailureMessage` logic from main translate **without changing** string/i18n behavior (pass `t` or pre-bound messages as args if the function currently closes over `t` — prefer pure `(errorCode, message, labels) => string` or keep `t` injection explicit)
- [ ] If quick-translate uses a different error string path, only share the intersection; do not force one UX copy
- [ ] Extract duplicated `TranslateInput` field assembly only when both pages build the same shape (profile id, model id, langs, text). If shapes diverge, skip and document
- [ ] ABOUTME headers on new files
- [ ] Routes: delete local copies; no behavior change

**Validation:**

- Run: `bun test src/features/translate/resolveTranslateFailureMessage.test.ts`
- Expected: Pass
- Run: `mise run typecheck`
- Expected: Exit 0

---

### Task T2: Single-stream session hook (main translate)

**Outcome:** Main page registers listeners and tracks one active request via a feature hook; still calls `runStartTranslateStream` / `runCancelRequestIds` with the same ordering (**listeners before invoke**).

**Files:**

- Create: `src/features/translate/useTranslateStreamListeners.ts` (optional shared primitive)
- Create: `src/features/translate/useTranslateStreamSession.ts`
- Modify: `src/routes/translate/index.tsx`
- Test: pure parts of request matching if extracted; manual/dev check for stream happy path

**Steps:**

- [ ] Hook API sketch (adjust to fit page without leaking entire UI state machine):

  ```ts
  type StreamHandlers = {
    onChunk: (chunk: TranslateStreamChunk) => void;
    onReset: (reset: TranslateStreamReset) => void;
    onDone: (done: TranslateStreamDone) => void;
    onError: (err: TranslateStreamError) => void;
  };

  // startSession(requestId, handlers) => Promise<void>
  //   attaches listeners filtered by requestId, then caller invokes runStartTranslateStream
  // abortActive() => Promise<void>  // cancel IPC + clear active id + unlisten
  // releaseIfActive(requestId): void
  ```

- [ ] Preserve filter rules: ignore events whose `id` ≠ active request
- [ ] Preserve generation / workspace guards **in the route** if they depend on React state; hook only owns requestId + unlisten lifecycle unless a clean callback boundary exists
- [ ] On unmount: unlisten + cancel in-flight if that is current page behavior
- [ ] Do not import Effect in the hook
- [ ] Route JSX/state for source text, model, profile rail stays put

**Validation:**

- Run: `mise run typecheck`
- Expected: Exit 0
- Run: `mise run test-frontend`
- Expected: Pass
- Manual: start stream, receive chunks, stop/cancel, switch workspace mid-flight (existing abort behavior)

---

### Task T3: Multi-slot stream session (quick-translate)

**Outcome:** Slot requestId map, epoch current checks, and prepare-listen-before-batch-start move into a dedicated module/hook; page keeps debounce, session persistence, and layout.

**Files:**

- Create: `src/features/translate/useSlotStreamSessions.ts` (and/or non-hook `slotStreamSession.ts` for pure epoch/map helpers)
- Modify: `src/routes/quick-translate.tsx`
- Reuse listener primitive from T2 if it was designed generically

**Steps:**

- [ ] Extract:
  - `requestIdsRef` map operations (set/get/delete per slot and `__detect__`)
  - `isSlotEpochCurrent(slotId, epoch)`
  - `prepareSlotStream(...)` listen-before-invoke sequence used before `runStartSlotStreamBatch`
- [ ] Keep **epoch** ownership clear: page still increments epochs on user edits; session helper only reads “is this epoch still current?”
- [ ] Detect flow: still `runDetectLanguage` + cancel via `runCancelRequestIds`; helper may track detect request id under `__detect__` as today
- [ ] Preserve continuous-source-edit and debounce constants in the page unless T5 moves them
- [ ] No behavior change to multi-slot partial failure (`SlotStreamStartOutcome`)

**Validation:**

- Run: `mise run typecheck && mise run test-frontend`
- Expected: Pass
- Manual: multi-slot translate, cancel one slot, detect language, clipboard session restore

---

### Task T4: Quick-translate window chrome helpers

**Outcome:** Pin / ready / height resize invokes live in a small module; route calls named functions.

**Files:**

- Create: `src/features/translate/quickTranslateWindow.ts` (or `src/features/quick-translate/windowChrome.ts` if you prefer feature folder split — default under `features/translate` to avoid new top-level feature)
- Modify: `src/routes/quick-translate.tsx`

**Steps:**

- [ ] Wrap:
  - `set_pin({ isPin })`
  - `notify_ready`
  - `resize_window_height({ height })`
- [ ] Keep fire-and-forget vs await semantics identical to current call sites
- [ ] Do **not** route through `invokeEffect` / `IpcError` in this phase
- [ ] Optional: unit-test with mocked `invoke` if easy; otherwise typecheck-only

**Validation:**

- Run: `mise run typecheck`
- Expected: Exit 0
- Manual: open quick-translate popup — ready notify, pin, height adapt still work

---

### Task T5 (optional): Session / debounce pure extracts

**Outcome:** Further line-count reduction without changing UX constants.

**Files:**

- Possibly create: `src/features/translate/quickTranslateSession.ts` — `loadSession` / `saveSession` / `SESSION_KEY`
- Possibly create: pure `isContinuousSourceEdit` module
- Modify: `src/routes/quick-translate.tsx`

**Steps:**

- [ ] Only extract pure sessionStorage JSON load/save and heuristics already covered by comments
- [ ] Keep `TRANSLATE_DEBOUNCE_MS` and settle timeouts as named constants (same values)
- [ ] Skip if T2–T4 already meet reviewability goals

**Validation:**

- Run: `mise run typecheck && mise run test-frontend`
- Expected: Pass

---

### Task T6: Docs + gate

**Outcome:** Architecture mentions stream session hooks; no Effect in routes/components.

**Files:**

- Modify: `docs/architecture/frontend-state-management.md`
- Optionally link this plan from `docs/plans/effect-integration-plan/README.md` as “related non-Effect work”

**Steps:**

- [ ] State: progressive stream UI uses feature hooks + Tauri listeners; Query still unused for chunks
- [ ] Confirm `rg` no `from "effect"` under `src/routes` / `src/components`

**Validation:**

```bash
mise run typecheck
mise run test-frontend
mise run lint
rg -n "from [\"']effect" src/routes src/components src/query
```

Expected: tools pass; rg no matches.

---

## Final Validation

```bash
mise run typecheck
mise run test-frontend
mise run lint
```

Manual smoke (Tauri):

1. Main translate: stream, stop, error, profile switch mid-flight
2. Quick translate: multi-slot, detect, debounce, pin, resize, clipboard inject

---

## Failure Behavior

| Case                                  | Expected (unchanged)                                             |
| ------------------------------------- | ---------------------------------------------------------------- |
| Listen setup fails before invoke      | Surface error; clear translating; do not leave orphan request id |
| Invoke start fails after listen       | Unlisten/cleanup; show IPC message via existing helpers          |
| Stale chunk after cancel/epoch change | Ignored by requestId / epoch filters                             |
| Batch one slot fails start            | Other slots continue; failed slot shows error outcome            |
| Window invoke fails                   | Same as today (often void/log); do not map to storage `conflict` |

---

## Privacy and Security

- Do not log source text, translated chunks, or API credentials in new helpers.
- SessionStorage for quick-translate may hold recent text — do not expand what is stored; do not log session dumps.

---

## Rollout Notes

| Item        | Guidance                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Branch      | `refactor/translate-route-thinning` with optional per-phase PRs (`…-t1-helpers`, `…-t2-stream-hook`, …) |
| Merge order | T1 → T2 → T3 → T4 → T5 optional                                                                         |
| Migrations  | None                                                                                                    |
| Risk        | High surface area — prefer small PRs; no drive-by UI redesign                                           |
| Effect plan | Does not replace or depend on Phase 5D                                                                  |

---

## Risks and Mitigations

| Risk                                       | Mitigation                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| Hook API sucks in all UI state             | Callbacks for chunk/done/error; page owns React state                            |
| Subtle race regressions                    | Preserve listen-before-invoke; copy filter predicates exactly; manual race tests |
| Over-sharing between single and multi-slot | Shared listener attach only; separate session hooks                              |
| Accidental Effect/Query creep              | Explicit out of scope; lint/search gate                                          |

---

## Out of Scope

- Effect Stream / fiber runtime for translation
- Putting stream chunks in TanStack Query
- Redesign of translate UI, workspace rail, or language tabs
- Changing debounce timings or session schema (unless a product request accompanies T5)
- Wrapping window chrome in `IpcError`
- Phase 5D import rebind
- Non-translate routes

---

## Open Questions

| Question                                                   | Default                                                            | Affects |
| ---------------------------------------------------------- | ------------------------------------------------------------------ | ------- |
| Hook vs plain class/session object for multi-slot          | **Hook + small pure helpers**                                      | T3      |
| Share listener primitive across T2/T3 in first PR          | **Yes if &lt; ~80 lines shared**                                   | T2–T3   |
| Move quick-translate to `features/quick-translate/` folder | **No** — keep under `features/translate` unless folder grows large | T4      |
| Add RTL/component tests for hooks                          | **Prefer pure unit tests + manual Tauri smoke**                    | All     |

---

## Requirement Traceability

| Intent                                           | Phase/Task         |
| ------------------------------------------------ | ------------------ |
| Deduplicate failure message / pure builders      | T1                 |
| Thin main translate stream lifecycle             | T2                 |
| Thin quick-translate multi-slot stream lifecycle | T3                 |
| Isolate window chrome invokes                    | T4                 |
| Optional session/debounce pure modules           | T5                 |
| Docs + no Effect leakage                         | T6                 |
| Keep feature `run*` IPC runners                  | All (consume only) |
