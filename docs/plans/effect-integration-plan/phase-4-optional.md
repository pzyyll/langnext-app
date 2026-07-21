# Phase 4: Optional Polish — Implementation Plan

**Goal:** Opportunistic cleanup only — architecture documentation for Effect vs Query, and theme ordered-write unification **if** a second ordered-write use-case appears.

**Inputs:** [Roadmap](./README.md); [Phase 1](./phase-1-ipc-foundation.md); `docs/architecture/frontend-state-management.md`; `src/theme/themeMutationQueue.ts`.

**Assumptions:**

- **Not required** for Effect adoption success. Phase 1–3 deliver the program value.
- Do **not** rewrite `ThemeMutationQueue` solely to use Effect; only if another ordered-write shares the same pattern and duplication hurts.
- Architecture note can land earlier (even with Phase 1) if reviewers want the boundary written down.

**Architecture:** Documentation restates roadmap layer rules. Any queue rewrite must preserve: enqueue order = backend invoke order; monotonic mutation ids; stale failure suppression.

**Tech Stack:** Docs; optional Effect 3.x if queue is rewritten.

**Depends on:** Phase 1 (for accurate “what we shipped” docs). Theme code change optional and independent of Phase 2/3.

**Roadmap:** [README.md](./README.md)

---

## File Map

- Modify: `docs/architecture/frontend-state-management.md` — short Effect vs Query section + link to roadmap
- Modify (only if justified): `src/theme/themeMutationQueue.ts`
- Test (only if queue changes): `src/theme/themeMutationQueue.test.ts`

---

## Tasks

### Task 1: Architecture note

**Outcome:** Contributors see where Effect stops and Query starts.

**Files:**

- Modify: `docs/architecture/frontend-state-management.md`

**Steps:**

- [x] Append a short section (do not rewrite the whole doc)
- [x] State: Query = persistent DTO cache; Effect = IPC typing + multi-step workflows; routes stay thin; no Effect in components
- [x] Link: `docs/plans/effect-integration-plan/README.md`

**Validation:**

- Run: none (doc-only). Reviewer checks against implemented Phases 1–3.

---

### Task 2: Theme queue (conditional)

**Outcome:** Either skip, or one shared ordered-write helper used by theme (and the second caller).

**Files:**

- Modify: `src/theme/themeMutationQueue.ts` (conditional)
- Test: `src/theme/themeMutationQueue.test.ts` (conditional)

**Steps:**

- [x] **Gate:** skipped — only `useTheme` consumes `ThemeMutationQueue` (no second ordered-write use-case)
- [ ] Preserve public behavior of `enqueue` / `drain` / mutation ids / onSuccess / onFailure
- [ ] Prefer minimal Effect (serial `flatMap` / queue) over a framework-wide concurrency rewrite
- [ ] Extend existing tests; do not drop stale-failure cases

**Validation (if changed):**

- Run: `bun test src/theme/themeMutationQueue.test.ts`
- Expected: Pass
- Run: `mise run typecheck`
- Expected: Exit 0

**Validation (if skipped):**

- Document “skipped — single consumer” in the PR description

---

### Task 3: Phase 4 gate

**Outcome:** Docs accurate; optional code green.

**Validation:**

- Run: `mise run typecheck && mise run test-frontend && mise run lint` (if code changed)
- Expected: Exit 0
- If docs only: markdown review only

---

## Final Validation

- Docs-only: link check to roadmap path
- Code path: `mise run typecheck && mise run test-frontend && mise run lint`

---

## Failure Behavior

- Theme persist failure: still `onFailure(mode, mutationId, error)`; error should remain decodable via Phase 1 helpers when IPC-backed

---

## Privacy and Security

- No new data paths. Do not log theme-unrelated settings.

---

## Rollout Notes

- Branch: `docs/effect-boundaries` or fold Task 1 into an earlier phase PR
- Skipping Task 2 is the default and preferred outcome

---

## Risks and Mitigations

| Risk                        | Mitigation                                      |
| --------------------------- | ----------------------------------------------- |
| Premature queue abstraction | Hard gate: second consumer required             |
| Doc drift                   | Link to phase plans; update when Phase 2/3 land |

---

## Open Questions

- None. Task 2 is explicitly optional.

---

## Out of Scope

- New Effect packages
- Broad refactor of i18n/theme hooks beyond queue internals
- Reopening Phase 1–3 designs
