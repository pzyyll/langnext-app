# TanStack Query Optimization Implementation Plan

**Goal:** Introduce TanStack Query as the per-window cache and synchronization layer for persistent Tauri data, eliminate duplicated manual loading state, and support real-time translation-profile synchronization between the main window and the planned quick-translation window.

**Inputs:** Current `langnext-app` implementation; the requirement that `/translate`, `/translate/profiles`, and a future quick-translation window share current translation profiles in real time; TanStack Query v5 concepts and the existing Tauri IPC/event architecture.

**Assumptions:**

- SQLite accessed through the Rust command layer remains the only source of truth.
- The first implementation targets translation profiles, provider instances, and provider models because they are already duplicated across routes and will be consumed by multiple windows.
- Theme and UI-language persistence remain on the existing bootstrap and ordered-mutation paths during the first migration; their startup and rollback semantics require a separate focused change.
- Streaming and non-streaming translation requests remain imperative operations. Streaming continues to use Tauri events and is not stored in the Query cache.
- Cross-window change events are coarse-grained notifications. Receivers invalidate affected query keys and refetch authoritative data instead of applying event payloads directly.
- Each Tauri webview owns an independent `QueryClient`; cross-window JavaScript memory is not shared.

**Architecture:** Rust/SQLite remains authoritative, typed functions in `src/storage/client.ts` remain the IPC boundary, and TanStack Query becomes the React-side cache for persistent data. Every webview subscribes to global Tauri data-change events and invalidates its local cache when another window changes profiles, providers, or models. Route-local input, selection, dialog, translation-progress, and streaming state remain in React or TanStack Router.

**Tech Stack:** React 19, TanStack Query v5, TanStack Router, Tauri 2 IPC/events, TypeScript 6, Bun, Rust, mise.

---

## Scope and Decision Rules

### State handled by TanStack Query

- Translation profile list DTOs, including ordered targets needed by list summaries: `listTranslationProfiles()`
- Translation profile details: `getTranslationProfile(id)`
- Provider instances: `listProviderInstances()`
- All enabled/provider models used by translation pages: `listAllProviderModels()`
- Models belonging to one provider: `listProviderModels(providerInstanceId)`
- Mutations that create, update, enable, disable, delete, reorder, or synchronize those records

### State not handled by TanStack Query

- Source text, output text, selected languages, copy feedback, dialog open state, and pending translation UI
- URL-addressable selection such as provider/profile IDs; these remain TanStack Router state
- `translate_text_stream` chunks and cancellation; these remain Tauri event-driven
- Application startup bootstrap in `src/storage/bootstrap.ts`
- Theme and UI-language ordered mutations in `src/theme/useTheme.ts` and `src/i18n/useLanguage.ts` during the first migration
- Cross-window transport itself; Tauri events provide transport, while Query only invalidates/refetches each window's cache

### Why Query is the correct boundary

Profiles, providers, and models are persistent records whose authoritative value lives in SQLite. The frontend must cache and synchronize those records rather than become a second source of truth. Query provides keyed caching, in-flight request deduplication, loading/error state, mutation lifecycle management, invalidation, and background refetching. Tauri events add the missing cross-window notification channel.

## Current Problems

1. `src/routes/translate/index.tsx` loads providers, all models, and profiles into component-local state.
2. `src/routes/translate/profiles.tsx` loads the same three collections independently, then performs an N+1 profile-detail load through `loadProfileListItems()`.
3. Profile mutations manually patch local arrays, so other routes and future windows cannot observe the change.
4. `src/features/models/ModelsLayout.tsx` and `ModelsContext.ts` implement a feature-local cache with manual refresh, upsert, removal, loading, and error handling.
5. `src/features/models/ProviderEditor.tsx` independently loads and refreshes provider models after mutations.
6. Rust profile/provider/model mutation commands do not emit data-change events. The only existing global event pattern is the translation-stream implementation using `tauri::Emitter` and `app.emit(...)`.
7. Every page repeats `useState` + `useEffect` + cancellation guards + loading/error state for authoritative data.

## Target Data Flow

```text
Main window                         Quick-translation window
QueryClient A                       QueryClient B
  useQuery(profileKeys.list())        useQuery(profileKeys.list())
            |                                   |
            +----------- Tauri IPC -------------+
                            |
                      Rust services
                            |
                          SQLite

Mutation in either window
  -> Tauri command writes SQLite successfully
  -> Rust app.emit("data://profiles-changed")
  -> every webview receives the event
  -> each QueryClient invalidates profileKeys.all
  -> active profile queries refetch authoritative data
  -> both windows render the same state
```

## Query Key Contract

Create stable key factories rather than scattering array literals across components:

```ts
export const providerKeys = {
  all: ["providers"] as const,
  list: () => [...providerKeys.all, "list"] as const,
};

export const modelKeys = {
  all: ["models"] as const,
  allEnabled: () => [...modelKeys.all, "enabled"] as const,
  byProvider: (providerInstanceId: string) => [...modelKeys.all, "provider", providerInstanceId] as const,
};

export const profileKeys = {
  all: ["translation-profiles"] as const,
  list: () => [...profileKeys.all, "list"] as const,
  detail: (id: string) => [...profileKeys.all, "detail", id] as const,
};
```

Rules:

- Components must import factories instead of constructing keys themselves.
- List mutations invalidate the corresponding `all` prefix so both list and detail consumers converge.
- Direct mutation results may seed the relevant detail cache with `setQueryData`, but invalidation remains the correctness mechanism.
- IDs must always occupy the same key position and retain their original string form.

## Query Client Defaults

Create one `QueryClient` per webview with conservative desktop defaults:

```ts
new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
      networkMode: "always",
    },
    mutations: {
      retry: false,
    },
  },
});
```

Rationale:

- A 30-second stale window prevents navigation-driven IPC churn without hiding mutation invalidations.
- Five-minute garbage collection preserves recently visited route data without retaining it indefinitely.
- One query retry tolerates a transient IPC failure; mutations are never retried automatically because writes may not be idempotent.
- Focus refetch is a fallback if a window missed an event while being created or destroyed.
- Local SQLite queries must run even when `navigator.onLine` is false, so query `networkMode` is `always`. Provider connection tests and model synchronization remain mutations and keep their explicit network/error behavior.

## File Map

### New frontend files

- Create: `src/query/client.ts` — construct and export the per-webview `QueryClient`.
- Create: `src/query/keys.ts` — central query-key factories for profiles, providers, and models.
- Create: `src/query/options.ts` — typed `queryOptions(...)` factories wrapping read functions from `src/storage/client.ts`.
- Create: `src/query/QueryEventSync.tsx` — subscribe once per webview to Tauri data-change events and invalidate local query keys.
- Create: `src/query/events.ts` — frontend event-name constants shared by the event subscriber.
- Create: `src/query/keys.test.ts` — verify key hierarchy and prefix invalidation contracts without requiring DOM rendering.

### Existing frontend files

- Modify: `package.json` — add `@tanstack/react-query`.
- Modify: `bun.lock` — lock the installed Query version.
- Modify: `src/main.tsx` — mount `QueryClientProvider` and `QueryEventSync` around the router.
- Modify: `src/routes/translate/index.tsx` — replace manual provider/model/profile loading with shared queries; use profile-detail query fetching when a profile is selected.
- Modify: `src/routes/translate/profiles.tsx` — replace list/detail loading and CRUD state patches with queries and mutations.
- Modify: `src/storage/client.ts` — update the profile-list return type to include ordered targets.
- Modify: `src/storage/types.ts` — represent profile-list rows with the target-chain data required by the UI.
- Modify: `src/features/models/ModelsLayout.tsx` — consume provider queries and mutations instead of maintaining a manual collection cache.
- Modify: `src/features/models/ModelsContext.ts` — reduce the context to layout/animation coordination only, or delete it if no non-query value remains after migration.
- Modify: `src/features/models/ProviderEditor.tsx` — query provider models and invalidate provider/model keys after mutations.
- Modify: `src/features/models/AddProviderDialog.tsx` — use a provider-create mutation and invalidate provider keys on success.
- Modify: `.mise/tasks/test-frontend` — execute all frontend `*.test.ts` files rather than only `themeMutationQueue.test.ts`.

### Rust files

- Modify: `src-tauri/src/domain/translation_profile.rs` — define the list response contract with ordered targets.
- Modify: `src-tauri/src/repositories/translation_profiles.rs` — reuse `list()` and `list_all_targets()` as two bulk queries; do not issue one target query per profile.
- Modify: `src-tauri/src/services/translation_profiles.rs` — group all targets by profile ID and return list DTOs from one database read operation.
- Modify: `src-tauri/src/cmds/translation_profiles.rs` — return the enriched list DTO and emit a global profile-change event after successful save, enabled-state change, and deletion.
- Modify: `src-tauri/src/cmds/providers.rs` — emit a provider-change event after successful save, enable/disable, delete, and reorder.
- Modify: `src-tauri/src/cmds/models.rs` — emit a model-change event after successful manual save, enable/disable, delete, and successful synchronization.
- Create: `src-tauri/src/events.rs` — central backend constants for data-change event names.
- Modify: `src-tauri/src/lib.rs` — register the event constants module.
- Test: add focused command/service tests in the closest existing Rust test module where the mutation result can be verified; event delivery itself should be covered by a small unit-testable helper or a Tauri integration test only if the existing harness supports `AppHandle` construction without broad test infrastructure changes.

## Event Contract

Use global, coarse-grained notifications:

```text
data://translation-profiles-changed
data://providers-changed
data://models-changed
```

Backend rules:

1. Emit only after the repository operation succeeds.
2. Do not emit after validation, repository, or transaction failure.
3. Broadcast with `AppHandle::emit`, not `emit_to`, so every current webview receives the notification.
4. Payload may be an empty object for v1; consumers must refetch from SQLite.
5. Import operations that modify multiple data domains must emit all affected domain events after successful transaction commit.

Frontend rules:

1. `QueryEventSync` mounts once under `QueryClientProvider` in every webview.
2. It registers all listeners and removes all listeners on unmount.
3. Profile events invalidate `profileKeys.all`.
4. Provider events invalidate `providerKeys.all` and `modelKeys.all`, because provider enablement affects model availability.
5. Model events invalidate `modelKeys.all`.
6. Duplicate invalidations in the initiating window are acceptable; Query deduplicates concurrent fetches.
7. Event handlers must not treat event payloads as authoritative records.

## Migration Matrix

| Current operation                | Query target                              | Mutation invalidation                        |
| -------------------------------- | ----------------------------------------- | -------------------------------------------- |
| `listTranslationProfiles()`      | `profileKeys.list()`                      | N/A                                          |
| `getTranslationProfile(id)`      | `profileKeys.detail(id)`                  | N/A                                          |
| `saveTranslationProfile()`       | `useMutation`                             | `profileKeys.all`                            |
| `setTranslationProfileEnabled()` | `useMutation`                             | `profileKeys.all`                            |
| `deleteTranslationProfile()`     | `useMutation`                             | `profileKeys.all`; remove deleted detail key |
| `listProviderInstances()`        | `providerKeys.list()`                     | N/A                                          |
| `saveProviderInstance()`         | `useMutation`                             | `providerKeys.all`, `modelKeys.all`          |
| `setProviderEnabled()`           | `useMutation`                             | `providerKeys.all`, `modelKeys.all`          |
| `deleteProviderInstance()`       | `useMutation`                             | `providerKeys.all`, `modelKeys.all`          |
| `reorderProviderInstances()`     | `useMutation`                             | `providerKeys.all`                           |
| `listAllProviderModels()`        | `modelKeys.allEnabled()`                  | N/A                                          |
| `listProviderModels(id)`         | `modelKeys.byProvider(id)`                | N/A                                          |
| `saveManualModel()`              | `useMutation`                             | `modelKeys.all`                              |
| `setModelEnabled()`              | `useMutation`                             | `modelKeys.all`                              |
| `deleteProviderModel()`          | `useMutation`                             | `modelKeys.all`                              |
| `syncProviderModels()`           | `useMutation`                             | `modelKeys.all`                              |
| `translateText()`                | Keep imperative or model as mutation only | No persistent-cache invalidation             |
| `translateTextStream()`          | Keep Tauri event flow                     | No Query cache                               |

## Tasks

### Task 1: Add Query infrastructure

**Outcome:** Every webview has a correctly configured Query client, while existing pages continue to work unchanged.

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Create: `src/query/client.ts`
- Create: `src/query/keys.ts`
- Create: `src/query/options.ts`
- Modify: `src/main.tsx`

**Steps:**

- [ ] Run `mise exec -- bun add @tanstack/react-query` so `package.json` and `bun.lock` use Bun-managed dependency metadata.
- [ ] Create `src/query/client.ts` with the defaults documented above and both required `ABOUTME:` lines.
- [ ] Create typed key factories in `src/query/keys.ts`.
- [ ] Create `queryOptions(...)` factories for profile list/detail, provider list, all models, and provider-scoped models.
- [ ] Wrap the existing `ToastProvider`/`RouterProvider` tree with `QueryClientProvider`; do not alter `bootstrapStorage()` ordering.
- [ ] Confirm that React Strict Mode does not create multiple clients by constructing the client at module scope rather than inside `mount()` or a component.

**Validation:**

- Run: `mise run typecheck`
- Expected: Query providers and options compile without changing current page behavior.
- Run: `mise run build`
- Expected: Vite production build completes and Query is included once.

### Task 2: Add cross-window cache invalidation

**Outcome:** Every current and future webview can learn that authoritative profile/provider/model data changed.

**Files:**

- Create: `src-tauri/src/events.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/cmds/translation_profiles.rs`
- Modify: `src-tauri/src/cmds/providers.rs`
- Modify: `src-tauri/src/cmds/models.rs`
- Create: `src/query/events.ts`
- Create: `src/query/QueryEventSync.tsx`
- Modify: `src/main.tsx`

**Steps:**

- [ ] Define matching event constants in Rust and TypeScript.
- [ ] Inject `AppHandle` into each affected Tauri command and import `tauri::Emitter`.
- [ ] Restructure each command so it awaits a successful repository operation before broadcasting its domain event.
- [ ] Ensure profile save/enable/delete emit only `translation-profiles-changed`.
- [ ] Ensure provider save/enable/delete/reorder emit `providers-changed`; provider changes must also cause frontend model invalidation.
- [ ] Ensure manual model save/enable/delete and successful provider-model synchronization emit `models-changed`.
- [ ] Update successful configuration import to emit every event for a data domain it may replace or merge.
- [ ] Implement `QueryEventSync` with listener cleanup and query-prefix invalidation.
- [ ] Mount `QueryEventSync` inside `QueryClientProvider` and outside `RouterProvider`, so it works for every route and future quick-window entry tree.

**Validation:**

- Run: `mise run test`
- Expected: Rust tests pass and command signatures remain registered successfully.
- Run: `mise run typecheck`
- Expected: all listener names and Query key references typecheck.
- Manual: open two webviews once the quick window exists, mutate a profile in either window, and verify the other window refetches `list_translation_profiles` without focus change or restart.

### Task 3: Migrate translation-profile reads

**Outcome:** `/translate` and `/translate/profiles` share one keyed profile cache per window, list hydration uses two bulk SQL queries instead of one detail IPC call per profile, and selected details no longer require duplicated manual lifecycle state.

**Files:**

- Modify: `src-tauri/src/domain/translation_profile.rs`
- Modify: `src-tauri/src/repositories/translation_profiles.rs`
- Modify: `src-tauri/src/services/translation_profiles.rs`
- Modify: `src-tauri/src/cmds/translation_profiles.rs`
- Modify: `src/storage/types.ts`
- Modify: `src/storage/client.ts`
- Modify: `src/routes/translate/index.tsx`
- Modify: `src/routes/translate/profiles.tsx`
- Modify: `src/query/options.ts`

**Steps:**

- [ ] Define a profile-list DTO that contains the existing `TranslationProfile` fields plus its ordered target chain. Keep `TranslationProfileDto` as the single-profile detail/write result unless the identical shape makes one shared DTO clearer.
- [ ] In the profile service, run existing repository `list()` and `list_all_targets()` calls inside one database read closure, group targets by `translationProfileId`, and return one DTO per profile. Do not call `get()` or `list_targets()` in a profile loop.
- [ ] Update the command and frontend client/type contract so `listTranslationProfiles()` exposes targets needed for `primaryModelId` and `fallbackCount`.
- [ ] Add Rust tests covering profiles with zero, one, and multiple ordered targets; expect stable profile ordering and target priority ordering.
- [ ] Replace `profiles`, `profilesLoading`, and `profilesError` state in `translate/index.tsx` with the profile-list query.
- [ ] Replace imperative `getTranslationProfile(profileId)` selection loading with a profile-detail query enabled only when an ID is selected, or `queryClient.fetchQuery(profileDetailOptions(id))` where the existing imperative event flow requires awaiting the result.
- [ ] Preserve language/model application behavior after detail resolution; do not put selected profile ID into the Query cache.
- [ ] Replace `loadProfileListItems()` in `translate/profiles.tsx`; derive its primary model and fallback count from the target chain already present in the cached list DTO.
- [ ] Fetch only the selected profile detail using `profileKeys.detail(selectedId)`.
- [ ] Preserve draft state separately from cached DTOs so editing a form never mutates Query cache objects.
- [ ] Keep editor loading and detail errors derived from the detail query; keep save-specific errors on the mutation.

**Validation:**

- Run: `mise run typecheck`
- Expected: no obsolete profile loading setters or cancelled-effect guards remain.
- Manual: navigate repeatedly between `/translate` and `/translate/profiles`; expect cached profile lists without duplicate IPC calls during the stale window.
- Manual: select profiles with valid and invalid IDs; expect detail loading/error behavior to remain visible and drafts to populate only from successful detail data.

### Task 4: Migrate translation-profile mutations

**Outcome:** Profile creation, update, enable/disable, and deletion synchronize all route and window consumers through standard invalidation.

**Files:**

- Modify: `src/routes/translate/profiles.tsx`
- Modify: `src/query/options.ts` or create focused mutation hooks under `src/query/`

**Steps:**

- [ ] Wrap save, enabled-state update, and delete commands in `useMutation`.
- [ ] On successful save, seed `profileKeys.detail(dto.id)` with the returned DTO and invalidate `profileKeys.all`.
- [ ] On successful enabled-state update, seed the returned detail DTO and invalidate `profileKeys.all`.
- [ ] On successful delete, remove `profileKeys.detail(deletedId)`, invalidate `profileKeys.all`, close the confirmation dialog, and select the next item only after the refreshed list resolves.
- [ ] Retain mutation-specific pending/error UI and existing translated error messages.
- [ ] Remove manual list patching and `refreshProfiles()` calls that duplicate Query invalidation.
- [ ] Do not add optimistic cache writes in the first pass. Rust validation and fallback-chain updates make server-confirmed updates safer and sufficiently fast over local IPC.

**Validation:**

- Run: `mise run typecheck`
- Expected: profile CRUD compiles with no manual array synchronization paths.
- Manual: create, rename, enable/disable, and delete a profile; verify `/translate` updates immediately and no stale deleted selection remains.
- Manual: force an IPC validation failure; expect cached data to remain unchanged and the existing mutation error message to render.

### Task 5: Migrate shared provider and model reads on translation routes

**Outcome:** Both translation routes share provider/model caches and stop issuing duplicate collection loads.

**Files:**

- Modify: `src/routes/translate/index.tsx`
- Modify: `src/routes/translate/profiles.tsx`
- Modify: `src/query/options.ts`

**Steps:**

- [ ] Replace provider and all-model `useState`/`useEffect` groups with provider-list and all-model queries.
- [ ] Preserve the existing `toModelOptions(...)` transformation using `useMemo` derived from query data.
- [ ] Derive combined loading/error presentation from the relevant queries without merging their cache identities.
- [ ] Keep selected model ID as local or route state; when a selected model disappears after invalidation, apply the existing fallback-selection behavior.
- [ ] Remove cancelled flags and duplicated initial `Promise.all` loading from both routes.

**Validation:**

- Run: `mise run typecheck`
- Expected: both routes compile with one source of provider/model query options.
- Manual: enable/disable a provider model from the Models screen; expect active translation pages and the future quick window to refresh their model options through the model/provider events.

### Task 6: Replace the manual Models feature cache

**Outcome:** Provider and provider-model data in the Models feature use the same cache and invalidation contract as translation routes.

**Files:**

- Modify: `src/features/models/ModelsLayout.tsx`
- Modify or delete: `src/features/models/ModelsContext.ts`
- Modify: `src/features/models/ProviderEditor.tsx`
- Modify: `src/features/models/AddProviderDialog.tsx`
- Modify: `src/query/options.ts`

**Steps:**

- [ ] Replace provider-list loading in `ModelsLayout` with `providerKeys.list()`.
- [ ] Preserve enter/exit animation bookkeeping outside the Query cache. Query data must represent records, not animation lifecycle.
- [ ] Implement provider reorder as a mutation. Keep the current visible order during the request only if a focused optimistic helper can snapshot and restore `providerKeys.list()`; otherwise use server-confirmed invalidation in the first pass.
- [ ] Replace `upsertProvider`, `removeProvider`, and `refreshProviders` with mutation result seeding plus query invalidation.
- [ ] Remove `ModelsContext` if no layout-only values remain. If animation callbacks still need context, rename/reduce its type so it no longer claims ownership of provider records.
- [ ] Replace `ProviderEditor.reloadModels` and its initial effect with `modelKeys.byProvider(providerId)`.
- [ ] Invalidate provider/model key prefixes after provider save, model enablement, deletion, and synchronization.
- [ ] Convert `AddProviderDialog` save handling to a mutation while preserving its local form fields and error rendering.

**Validation:**

- Run: `mise run typecheck`
- Expected: no feature-owned authoritative provider/model arrays remain.
- Run: `mise run lint`
- Expected: removed effects/setters leave no unused imports or hook dependency errors.
- Manual: add, edit, reorder, enable/disable, synchronize, and delete providers/models; verify sidebar animations remain correct and translation model selectors converge.

### Task 7: Add cache-contract tests and broaden frontend test discovery

**Outcome:** Query key hierarchy and cache-update helpers are regression-tested alongside the existing theme queue tests.

**Files:**

- Create: `src/query/keys.test.ts`
- Create additional focused pure tests under `src/query/*.test.ts` if cache helpers are introduced
- Modify: `.mise/tasks/test-frontend`

**Steps:**

- [ ] Test that every profile detail key starts with `profileKeys.all` and differs by ID.
- [ ] Test that provider-scoped model keys start with `modelKeys.all` and remain distinct from `modelKeys.allEnabled()`.
- [ ] If delete/reorder cache helpers are extracted, test success and rollback snapshots with a real `QueryClient` and no mocked data path in production code.
- [ ] Change the frontend task from one hard-coded test file to `bun test src`, preserving the existing theme queue test execution.
- [ ] Do not introduce component-test dependencies solely for this migration; rely on pure cache tests plus typecheck/build/manual multi-window verification unless a component harness is added as a separately approved scope.

**Validation:**

- Run: `mise run test-frontend`
- Expected: existing theme tests and new Query cache/key tests all pass.

### Task 8: Remove obsolete state machinery and document the boundary

**Outcome:** The codebase has one documented rule for persistent data and no dead manual-cache paths.

**Files:**

- Modify: affected routes/features from Tasks 3-6
- Modify: `docs/plans/2026-07-12-tanstack-query-optimization-plan.md` only if implementation decisions differ from this plan
- Optionally create: `docs/architecture/frontend-state-management.md` if a permanent architecture guide is desired during implementation

**Steps:**

- [ ] Remove obsolete loading/error/data setters, refresh callbacks, cancellation flags, and imports replaced by Query.
- [ ] Confirm no component copies Query data into local state except deliberate editable drafts.
- [ ] Confirm query keys are imported only from `src/query/keys.ts`.
- [ ] Record the state-placement rule: local UI state in React, navigation state in Router, persistent authoritative data in Query, cross-window notification in Tauri events, streaming translation in Tauri event listeners.
- [ ] Leave `ThemeMutationQueue`, `bootstrapStorage`, and streaming translation unchanged and document them as explicit exclusions.

**Validation:**

- Run: `mise run format:check`
- Expected: Prettier and Cargo formatting checks pass.
- Run: `mise run lint`
- Expected: ESLint reports no errors.
- Run: `mise run typecheck`
- Expected: TypeScript emits no errors.

## Final Validation

- Run: `mise run test-frontend`
- Expected: all frontend behavioral and Query contract tests pass.
- Run: `mise run test`
- Expected: all Rust unit/integration tests pass.
- Run: `mise run format:check`
- Expected: frontend and Rust formatting checks pass.
- Run: `mise run lint`
- Expected: ESLint passes.
- Run: `mise run build`
- Expected: TypeScript and the Vite production build pass.
- Manual: open `/translate` and `/translate/profiles`, navigate repeatedly, and verify collection IPC calls are deduplicated within the configured stale window.
- Manual: mutate each profile operation and verify both routes render the same result without reload.
- Manual after the quick window exists: keep both windows open, mutate a profile and a model in either window, and verify the other window updates without focus change or restart.
- Manual: disable network connectivity and verify local SQLite-backed queries still execute; provider connection tests and model synchronization should continue to surface their own network errors.
- Manual: start and cancel streaming and non-streaming translations to verify Query introduction did not alter request-generation guards, listener cleanup, or cancellation.

## Rollout Notes

- Implement in the task order above. Tasks 1-2 establish infrastructure; Tasks 3-4 deliver the required profile-sharing outcome before the broader provider/model migration.
- No database migration is required.
- The planned quick-translation window must mount the same `QueryClientProvider` and `QueryEventSync` composition as the main window. Prefer extracting a shared `AppProviders` component when the second frontend entry point is introduced, not before.
- Event-based invalidation is intentionally coarse. Profile/provider/model collections are small and mutation frequency is low; correctness and maintainability outweigh avoiding a local IPC refetch.
- Do not remove the backend event broadcasts even if the initiating window also invalidates locally. Other webviews depend on the broadcast.
- If configuration import mutates profiles/providers/models, it must broadcast all affected events after successful commit or other windows will remain stale.

## Risks and Mitigations

- **Duplicate invalidation in the initiating window** — Query deduplicates concurrent reads; accept this rather than introducing sender IDs and event-routing complexity.
- **Event emitted before transaction completion** — emit only after the service/repository future returns success.
- **Missed event during window creation** — initial query load and `refetchOnWindowFocus` recover the cache.
- **Query cache accidentally used as an editable form model** — clone DTO data into local draft state and write back only through mutations.
- **N+1 profile-detail requests persist** — enrich `listTranslationProfiles()` with targets using the existing bulk `list()` and `list_all_targets()` repository queries, then query only the selected detail from React.
- **Provider changes leave model selectors stale** — provider events invalidate both provider and model key prefixes.
- **Automatic mutation retries duplicate writes** — set mutation retry to `false` globally and opt in only for explicitly idempotent operations.
- **Offline browser status blocks local IPC** — set query `networkMode` to `always` for SQLite-backed reads.
- **Models sidebar animations regress when Context is removed** — keep animation identity/transition state local to `ModelsLayout`; migrate data ownership separately.
- **Theme mutation ordering regresses** — keep theme/language migration out of this implementation and retain the tested `ThemeMutationQueue`.
- **Insufficient frontend test infrastructure** — add pure Query key/cache tests now and record component/E2E infrastructure as separate scope rather than introducing it implicitly.

## Completion Criteria

The optimization is complete when:

1. Profiles, providers, and models are read through shared Query options rather than page-owned authoritative arrays.
2. Profile mutations update `/translate`, `/translate/profiles`, and every open quick-translation window without reload.
3. Provider/model mutations refresh every active model selector across windows.
4. SQLite remains the only authoritative data source; Tauri events carry invalidation signals only.
5. Streaming translation, startup bootstrap, theme ordering, routing, and editable draft behavior remain intact.
6. All final validation commands pass and manual cross-window synchronization is verified.
