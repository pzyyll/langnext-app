# Frontend State Management

## Placement rules

| Kind of state                    | Home                    | Examples                                                                                   |
| -------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| Local UI / ephemeral interaction | React `useState` / refs | Source text, dialog open, copy feedback, streaming progress                                |
| URL-addressable selection        | TanStack Router         | Selected provider id, nested route params                                                  |
| Persistent authoritative data    | TanStack Query          | Translation profiles, provider instances, provider models                                  |
| Cross-window notification        | Tauri global events     | `data://translation-profiles-changed`, `data://providers-changed`, `data://models-changed` |
| Streaming translation            | Tauri event listeners   | `translate://chunk`, `translate://reset`, `translate://done`, `translate://error`          |

SQLite accessed through Rust commands remains the only source of truth. Query caches DTOs per webview; event payloads are invalidation signals only and must not be applied as records.

## Explicit exclusions

- **Startup bootstrap** (`src/storage/bootstrap.ts`) — ordered theme/language reconciliation before React mounts.
- **Theme and UI language mutations** (`src/theme/useTheme.ts`, `src/i18n/useLanguage.ts`, `ThemeMutationQueue`) — ordered write + rollback semantics stay outside Query until a focused migration.
- **Translate streaming** — progressive chunks stay event-driven; they are not stored in the Query cache.

## Query keys

Import factories from `src/query/keys.ts` only. List mutations invalidate the domain `all` prefix so list and detail consumers converge. Direct mutation results may seed detail caches with `setQueryData`; invalidation remains the correctness mechanism.

## Cross-window sync

Each webview owns an independent `QueryClient`. `QueryEventSync` subscribes once under `QueryClientProvider` and invalidates local key prefixes when another window mutates profiles, providers, or models. The initiating window may invalidate both locally and via the broadcast; concurrent refetches are deduplicated by Query.

## Effect vs Query

Frontend Effect (npm `effect` 3.x) is a **typed IPC and multi-step workflow** layer. It does **not** replace TanStack Query or own server-state caches.

| Concern                                | Owner                                                      | Notes                                                                              |
| -------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Persistent DTO cache                   | TanStack Query                                             | `queryFn` / `mutationFn` stay Promise-based                                        |
| Typed Tauri invoke failures            | `src/storage/*` (`IpcError`, `invokeEffect`, `runEffectAsPromise` / `runStorage`) | Wire codes decode to a stable error channel; generic Promise bridge rejects raw tagged failures; `runStorage` is the IPC-only alias |
| Multi-step non-Query workflows         | Feature modules + storage bootstrap                        | Bootstrap, configuration transfer (export/import), history CSV export dialog       |
| Post-import app-settings rebind        | `src/features/settings/applyImportedAppSettings.ts`        | Theme DOM + i18n + OS shortcuts only; **Query invalidation stays in the route**    |
| Translate stream/detect/slot IPC start | `src/features/translate/*`                                 | Stream **events** stay Tauri listeners; chunks are not stored in Query             |
| Filesystem / native dialog failures    | Local `FsError` (not IPC codes)                            | Cancel is a success status (`DialogSaveResult`), not a throw                       |
| Dialog/fs user-facing errors           | `src/features/userErrorMessage.ts`                         | Routes use `getUserErrorMessage` for Fs + IPC display                              |

### Layer rules

| Layer                      | Rule                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `src/components/*`         | No Effect imports                                              |
| `src/query/*`              | Promise storage APIs only                                      |
| `src/storage/*`            | Owns IPC Effect adapter + typed errors                         |
| `src/features/*` use-cases | May compose Effects; export Promise runners for routes         |
| `src/routes/*`             | Thin: call runners/helpers; no deep Effect pipelines in JSX    |
| Secrets / logs             | Never put credentials in Effect errors; use `logger` redaction |

`src/storage/client.ts` is the Promise façade for Query/DTO CRUD only; translate orchestration and file workflows export `run*` façades under `src/features/*`. Routes and Query must not import Effect solely for cache orchestration. Theme ordered writes (`ThemeMutationQueue`) stay a single-consumer queue outside Effect unless a second ordered-write use-case appears.

**Roadmap / phase plans (Phases 1–3 landed in `src/`; Phase 4 theme-queue rewrite skipped — single consumer; Phase 5A–5D unification landed):** [docs/plans/effect-integration-plan/README.md](../plans/effect-integration-plan/README.md). **Translate route thinning (hooks, not Effect):** [docs/plans/2026-07-21-translate-route-thinning-plan.md](../plans/2026-07-21-translate-route-thinning-plan.md).
