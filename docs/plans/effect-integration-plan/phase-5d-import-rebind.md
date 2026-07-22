# Phase 5D: Import App-Settings Rebind — Implementation Plan

**Goal:** Extract post-import theme / language / shortcuts rebind into a testable settings helper so `settings.tsx` only owns UX toasts and Query invalidation.

**Inputs:** [Phase 5 unification](./phase-5-unification.md) Task 5 (optional); current `BackupSettingsSection` in `src/routes/settings.tsx`; `src/features/settings/configurationTransfer.ts`; storage client `getAppSettings` / `setAppShortcuts`.

**Assumptions:**

- Phases 5A–5C already landed (`runEffectAsPromise`, dual-API removal, `DialogSaveResult`, `getUserErrorMessage`).
- Import file pipeline (`runImportConfigurationFromFile`) stays unchanged.
- **Query invalidation stays in the route** — helper must not take `QueryClient` or call `invalidateQueries`.
- Rebind is **best-effort after DB apply**: if rebind fails, import may already be applied (same as today).
- Prefer Promise façade for the route; internal Effect optional only if composition needs it (default: async function + existing client Promises is enough).
- Do not Effect-ify theme queue or i18n hooks beyond calling existing `applyThemeToDom` / `applyAppLanguage`.

**Architecture:** After a successful configuration import, the desktop process must re-read authoritative `AppSettingsDto` and apply side effects that SQLite write alone does not perform: DOM theme, i18n language, OS shortcut registration. That sequence becomes `applyImportedAppSettings()` under `src/features/settings/*`. The route keeps: busy state, result-status branching, toasts, and provider/model/profile cache invalidation.

**Tech Stack:** Existing storage client Promise API, theme/i18n helpers, Bun tests. Effect only if the implementer composes IPC steps via `invokeEffect` + `runStorage` (not required).

**Depends on:** Phase 3 configuration transfer; Phase 5A bridge (if using Effects). Independent of translate route thinning.

**Roadmap:** [README.md](./README.md)

**Status:** Implemented. Helper owns theme/language/shortcuts rebind; Query invalidation stays route-owned.

---

## File Map

- Create: `src/features/settings/applyImportedAppSettings.ts` — rebind helper (theme + language + shortcuts)
- Create: `src/features/settings/applyImportedAppSettings.test.ts` — mocked client / theme / i18n
- Modify: `src/routes/settings.tsx` — `BackupSettingsSection.handleImport` calls helper; keeps invalidation + toasts
- Modify (optional wording): `docs/architecture/frontend-state-management.md` — note import rebind is feature-owned, Query invalidation route-owned
- Modify: [phase-5-unification.md](./phase-5-unification.md) status when done

---

## Current behavior (must preserve)

From `BackupSettingsSection.handleImport` after `result.status === "applied"`:

1. `const settings = await getAppSettings()`
2. If `isThemeMode(settings.theme)` → `applyThemeToDom(settings.theme)` (null/invalid theme: skip DOM write; do not invent a theme)
3. `await applyAppLanguage(normalizeLanguage(settings.uiLanguage))`
4. `await setAppShortcuts(settings.shortcuts)` — re-registers OS hotkeys (plain `app_settings` import does not)
5. Invalidate `providerKeys.all`, `modelKeys.all`, `profileKeys.all`
6. Success toast; optional `importNeedsAuth` description from preview flags

Cancel / invalid / not_applied paths unchanged. Errors use `getUserErrorMessage`.

---

## Tasks

### Task 1: `applyImportedAppSettings` helper

**Outcome:** One function performs steps 1–4 above; rejects with raw `IpcError` (or existing client rejection shape) on IPC failure.

**Files:**

- Create: `src/features/settings/applyImportedAppSettings.ts`
- Test: `src/features/settings/applyImportedAppSettings.test.ts`

**Steps:**

- [x] Export async function, e.g.:

  ```ts
  /** Rebind this process after configuration import. Does not invalidate Query caches. */
  export async function applyImportedAppSettings(): Promise<AppSettingsDto>;
  ```

- [x] Implementation order must match current route: get settings → theme (conditional) → language → shortcuts
- [x] Return the loaded `AppSettingsDto` so callers can read preview-adjacent fields if needed later (route may ignore return today)
- [x] Do **not** log settings blobs or secrets
- [x] ABOUTME two-line header
- [x] Tests with mocks:
  - Happy path: `getAppSettings` returns light theme + language + shortcuts; asserts `applyThemeToDom`, `applyAppLanguage`, `setAppShortcuts` called once each with expected args
  - `theme: null` or non-mode string: **no** `applyThemeToDom` call; language + shortcuts still run
  - `getAppSettings` rejects → helper rejects; no language/shortcuts calls
  - `setAppShortcuts` rejects after theme/language applied → helper rejects (document best-effort partial apply)

**Validation:**

- Run: `bun test src/features/settings/applyImportedAppSettings.test.ts`
- Expected: Pass
- Run: `mise run typecheck`
- Expected: Exit 0

---

### Task 2: Wire settings route

**Outcome:** Import success path calls the helper; invalidation and toasts remain in the route.

**Files:**

- Modify: `src/routes/settings.tsx`

**Steps:**

- [x] After `status === "applied"`, call `await applyImportedAppSettings()` instead of inlined get/theme/lang/shortcuts
- [x] Keep the three `queryClient.invalidateQueries` lines in the route immediately after successful rebind (or after rebind attempt — **preserve today’s order**: rebind first, then invalidate, then toast)
- [x] If rebind throws, catch still uses `getUserErrorMessage` and import-failed toast (same as any throw in the try block today)
- [x] Remove now-unused imports from the route only if nothing else in the file uses them (`getAppSettings` / `setAppShortcuts` may still be used by shortcut editor section — do not remove blindly)
- [x] No Effect imports in the route

**Validation:**

- Run: `mise run typecheck`
- Expected: Exit 0
- Run: `mise run test-frontend`
- Expected: Pass
- Manual (optional): import a config JSON in Tauri dev → theme/lang/hotkeys update; provider list refreshes

---

### Task 3: Docs gate

**Outcome:** Roadmap/architecture state that 5D landed; Query invalidation still route-owned.

**Files:**

- Modify: `docs/plans/effect-integration-plan/README.md` — 5D status
- Modify: `docs/plans/effect-integration-plan/phase-5-unification.md` — status line
- Modify (short): `docs/architecture/frontend-state-management.md` if ownership table needs “import rebind” row

**Steps:**

- [x] Status: 5D implemented (or keep “skipped” if this plan is abandoned)
- [x] Note: helper does not own Query cache

**Validation:**

- Docs-only review; if code changed, `mise run typecheck && mise run test-frontend && mise run lint`

---

## Final Validation

```bash
mise run typecheck
mise run test-frontend
mise run lint
```

Expected: exit 0 / pass.

---

## Failure Behavior

| Case                                    | Expected                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| User cancels file dialog                | `status: "cancelled"`; no rebind; no toast                                                             |
| Invalid preview                         | `status: "invalid"`; no rebind                                                                         |
| Import not applied                      | `status: "not_applied"`; no rebind                                                                     |
| Import applied; `getAppSettings` fails  | Throw → import-failed toast; DB may already have new config                                            |
| Import applied; `setAppShortcuts` fails | Throw after possible theme/lang apply; same toast path                                                 |
| Rebind succeeds; invalidation fails     | Unlikely (sync void); if invalidate throws, same catch — prefer keep `void invalidateQueries` as today |

---

## Privacy and Security

- Do not log full `AppSettingsDto`, proxy credentials, or import documents.
- Shortcuts payload is not secret but avoid verbose dumps in error messages.

---

## Rollout Notes

| Item                           | Guidance                                                           |
| ------------------------------ | ------------------------------------------------------------------ |
| Branch                         | `refactor/import-settings-rebind` or fold into a small settings PR |
| Migrations                     | None                                                               |
| Compat                         | Internal only; no IPC version change                               |
| Relation to translate thinning | None — separate plan                                               |

---

## Risks and Mitigations

| Risk                                      | Mitigation                           |
| ----------------------------------------- | ------------------------------------ |
| Changing apply order breaks hotkeys/theme | Copy current order; test it          |
| Helper grows Query invalidation           | Hard rule: no `QueryClient` param    |
| Over-use of Effect for linear awaits      | Prefer plain async + client Promises |

---

## Out of Scope

- Changing import merge/copy modes or preview UX
- Auto-rebind on external config file watch
- ThemeMutationQueue / Effect ordered-write rewrite
- Translate routes
- Moving Query invalidation into the helper

---

## Open Questions

| Question                          | Default                                                          | Affects |
| --------------------------------- | ---------------------------------------------------------------- | ------- |
| Return `AppSettingsDto` vs `void` | **Return DTO**                                                   | Task 1  |
| Effect vs plain async             | **Plain async** calling client                                   | Task 1  |
| Invalidate even if rebind throws  | **No** — stay in same try after await rebind (today’s structure) | Task 2  |

---

## Requirement Traceability

| Intent                              | Task   |
| ----------------------------------- | ------ |
| Extract theme/lang/shortcuts rebind | Task 1 |
| Keep Query invalidation in route    | Task 2 |
| Preserve import UX statuses/toasts  | Task 2 |
| Document ownership                  | Task 3 |
