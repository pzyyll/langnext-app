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
