# Phase 2: Translate Use-Cases — Implementation Plan

**Goal:** Move translate stream start, language detect, and quick-translate multi-slot orchestration out of route modules into testable feature use-cases on top of Phase 1 IPC Effect.

**Inputs:** [Roadmap](./README.md); [Phase 1](./phase-1-ipc-foundation.md); `src/routes/translate/index.tsx`; `src/routes/quick-translate.tsx`; stream/event constants in `src/storage/client.ts`.

**Assumptions:**

- Phase 1 is merged (`IpcError`, `invokeEffect`, `runStorage`, bridged `client`).
- **Chunk / reset / done / error events stay Tauri subscriptions** (route or thin listener helper). Do not put stream chunks in TanStack Query.
- Default cancel model: **explicit `requestId` sets + `cancelTranslate`**, not Effect fibers, unless tests prove fibers simplify without lifecycle bugs.
- Routes keep UI state (text, slots, generation counters, toasts). Use-cases own IPC/orchestration only.
- Export **Promise runners** for routes (`runStorage` / existing client wrappers) so JSX modules need not import Effect deeply.

**Architecture:** Feature modules under `src/features/translate/` compose storage invokes (Effect or bridged Promises). `runTranslate.ts` is the route-facing façade. Multi-slot batch isolates per-slot failures; abort cancels all active `requestId`s. Preserve “register listeners before `translate_text_stream` invoke” ordering.

**Tech Stack:** Effect 3.x (via Phase 1), Tauri events, React routes (callers only), Bun tests.

**Depends on:** Phase 1 complete.

**Roadmap:** [README.md](./README.md)

---

## File Map

- Create: `src/features/translate/translateStream.ts` — start stream invoke; requestId wiring
- Create: `src/features/translate/detectLanguageFlow.ts` — detect invoke helpers
- Create: `src/features/translate/runTranslate.ts` — Promise runners for routes
- Create: `src/features/translate/slotBatch.ts` — multi-slot start/cancel orchestration
- Modify: `src/routes/translate/index.tsx` — stream/detect call sites → runners
- Modify: `src/routes/quick-translate.tsx` — stream/detect/slot loop → runners; keep UI
- Test: `src/features/translate/translateStream.test.ts`
- Test: `src/features/translate/detectLanguageFlow.test.ts`
- Test: `src/features/translate/slotBatch.test.ts`

---

## Tasks

### Task 1: Stream + detect modules

**Outcome:** Stream start and detect are unit-testable; failures surface as `IpcError`.

**Files:**

- Create: `src/features/translate/translateStream.ts`
- Create: `src/features/translate/detectLanguageFlow.ts`
- Create: `src/features/translate/runTranslate.ts`
- Test: `src/features/translate/translateStream.test.ts`
- Test: `src/features/translate/detectLanguageFlow.test.ts`

**Steps:**

- [ ] 2-line `ABOUTME` on each new file
- [ ] `startTranslateStream({ input, requestId })` → Effect (or internal Effect) calling `translate_text_stream` via Phase 1 path (`invokeEffect` or bridged client)
- [ ] Detect flow for `detect_language` with optional `requestId` (same cancel registry as today)
- [ ] Document listener-before-invoke invariant in module comments
- [ ] Export runners: e.g. `runStartTranslateStream`, `runDetectLanguage` via `runStorage`
- [ ] Cancel remains separate: use existing `cancelTranslate(requestId)` (Promise/bridge)
- [ ] Tests (mock bridge/invoke): success; `validation_failed`; do not require full event bus

**Validation:**

- Run: `bun test src/features/translate/translateStream.test.ts src/features/translate/detectLanguageFlow.test.ts`
- Expected: All pass
- Run: `mise run typecheck`
- Expected: Exit 0

---

### Task 2: Wire main translate + quick-translate stream/detect

**Outcome:** Both routes use runners for stream start and detect; display still uses `getIpcErrorMessage` + i18n.

**Files:**

- Modify: `src/routes/translate/index.tsx`
- Modify: `src/routes/quick-translate.tsx` (stream/detect only)

**Steps:**

- [ ] Replace inline `translateTextStream` / `detectLanguage` try/catch cores with runners
- [ ] Keep generation/requestId guards and event listeners in the route (or extract listener helper **without** forcing Effect)
- [ ] UI error strings: `getIpcErrorMessage(err, t(...))` unchanged in spirit
- [ ] No drive-by formatting of unrelated route code

**Validation:**

- Run: `mise run typecheck`
- Expected: Exit 0
- Manual (Tauri): one-shot stream translate success; detect failure shows toast/inline error; cancel mid-stream still works

---

### Task 3: Multi-slot batch orchestrator

**Outcome:** Quick-translate multi-slot loop lives in `slotBatch.ts` with cancel-all.

**Files:**

- Create: `src/features/translate/slotBatch.ts`
- Test: `src/features/translate/slotBatch.test.ts`
- Modify: `src/routes/quick-translate.tsx`

**Steps:**

- [ ] Slot job descriptor: slot id, payload fields the route already builds, `requestId`
- [ ] Start N jobs; **per-slot failure isolation** (no invented cross-slot domain rules)
- [ ] Abort/cancel path invokes `cancel_translate` for each active `requestId`
- [ ] Prefer explicit requestId tracking; add Effect concurrency/fibers only with tests
- [ ] Leave DOM measurement, pin, window resize, and rendering in the route

**Validation:**

- Run: `bun test src/features/translate/slotBatch.test.ts`
- Expected: Pass, including cancel-all active ids
- Run: `mise run typecheck`
- Expected: Exit 0

---

### Task 4: Phase 2 gate

**Outcome:** Feature tests green; routes thinner on IPC; no Effect in `src/components`.

**Files:** none

**Steps:**

- [ ] Full suite
- [ ] Confirm no Effect imports under `src/components`
- [ ] Confirm stream events still not stored in Query cache

**Validation:**

- Run: `mise run typecheck && mise run test-frontend && mise run lint`
- Expected: Exit 0
- Manual smoke: main translate stream; quick-translate multi-slot; abort all

---

## Final Validation

- Run: `mise run typecheck && mise run test-frontend && mise run lint`
- Expected: Exit 0
- Manual: stream + cancel; multi-slot partial failure leaves other slots intact

---

## Failure Behavior

| Failure | Behavior |
|---------|----------|
| Stream invoke validation failure | `IpcError` before/without chunks; UI error prefix via i18n |
| Detect failure | `IpcError`; UI detect-failed copy |
| One slot fails in batch | That slot error only; others continue |
| User abort all | `cancelTranslate` per active id; in-flight UI cleared per existing UX |
| Event listener errors | Unchanged from current route handling (out of Effect path unless later extracted) |

---

## Privacy and Security

- Do not log full source text or model tokens in use-case errors.
- `requestId` is fine to log; never API keys.
- Same IPC trust boundary as Phase 1.

---

## Rollout Notes

- Branch: `feat/effect-translate-usecases`
- Prefer stacked PR after Phase 1; do not re-implement IPC decode here
- Large route diffs: keep commits split (extract modules → wire main translate → wire quick-translate → slot batch)

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Fiber/HMR leaks | Default explicit requestId cancel; short-lived `runPromise` |
| Regress stream race (listeners after invoke) | Document + test ordering; code review checklist |
| Mega-diff in `quick-translate.tsx` | Task 2 then Task 3; avoid unrelated cleanup |

---

## Open Questions

- Multi-slot: fibers vs requestId sets — **default requestId sets** (see roadmap). Revisit only with a failing test that fibers fix cleanly.

---

## Out of Scope (this phase)

- Bootstrap / settings import-export / history CSV
- Query key changes
- Changing Rust stream event payloads
- Full rewrite of quick-translate UI layout
