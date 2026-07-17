# Translation History Implementation Plan

**Goal:** Persist completed translation attempts and expose a History page for search, filter, review, bulk delete, clear-all, and selected CSV export.

**Inputs:** `next-prompt.md`, `.stitch/history.html`, existing storage/translate stack, STranslate history as reference only, and the grilling decisions below (2026-07-17).

**Assumptions:**

- History is **local runtime data** in the main app SQLite DB. It is **not** part of configuration import/export.
- One row = one completed translate attempt (main Translate or Quick Translate), not a multi-engine session blob.
- Append-only log; **no** translate-time cache hit from history in v1.
- Prototype stats / token-quota cards are out of scope for v1.

**Architecture:** `translation_history` flows through migration → domain → repository → service → IPC → typed client → TanStack Query → `/history` UI. `ModelService` records history after a real provider attempt finishes (success or soft fail), so streaming, non-streaming, and Quick Translate share one write path. List endpoints return **previews**; full text is loaded via `get` / `get_many`.

**Tech Stack:** Tauri 2, Rust, rusqlite, React 19, TanStack Router/Query, Base UI, Tailwind CSS v4, i18next, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs`, Bun tests, cargo tests.

---

## Locked Decisions (grilling)

| #   | Topic                    | Decision                                                                                                |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1   | Storage vs config export | Local SQLite only; excluded from config import/export                                                   |
| 2   | Persist outcomes         | Success + real soft-fail (T1); **not** cancelled; **not** pre-network Early validation (T2)             |
| 3   | Cache / upsert           | Append-only; no STranslate-style upsert cache                                                           |
| 4   | Stats cards              | Out of v1                                                                                               |
| 5   | Write layer              | Backend `ModelService` after translate completion                                                       |
| 6   | Language fields          | Extend `TranslateInput` with ID metadata; prompt labels unchanged; store configured + effective IDs     |
| 7   | Retention                | Hard cap **10_000** rows; prune oldest after insert; no Settings UI in v1                               |
| 8   | Text size on disk        | **No truncation**; store full source/translated text                                                    |
| 9   | Data-change events       | Emit `data://translation-history-changed` on **delete/clear only**; not on each write                   |
| 10  | CSV export scope         | **Selected rows only**                                                                                  |
| 11  | Delete scope             | Single + selected + **Clear All** (strong confirm); no “delete all matching filters”                    |
| 12  | Date filter              | Single local calendar day → `[dayStart, nextDayStart)` UTC bounds in service                            |
| 13  | Model filter options     | Distinct snapshots from history via dedicated facets IPC                                                |
| 14  | Language filter options  | Fixed `LANGUAGE_IDS` + Any                                                                              |
| 15  | Status filter UI         | Column only; no status dropdown in v1 (API may still accept `status`)                                   |
| 16  | Snapshots                | model id + display name, provider display name, profile id + name, latency, error fields                |
| 17  | Pagination               | Page numbers; default `pageSize=20`; clamp 1..=100; `created_at DESC, id DESC`                          |
| 18  | Detail UX                | Modal dialog (not route, not master-detail)                                                             |
| 19  | Nav order                | Translate → Profiles → **History** → Models → About; Settings footer                                    |
| 20  | Filter apply             | Draft + **Apply** button; pagination applies immediately                                                |
| 21  | Failed Target cell       | Fixed i18n failure copy; full error in detail; copy disabled                                            |
| 22  | List payload             | **Preview only** (160 Unicode scalars + truncated flags); not full text                                 |
| 23  | Full text fetch          | `get(id)` + `get_many(ids)` (max **100** ids)                                                           |
| 24  | Model facets API         | Independent `list_translation_history_model_facets`                                                     |
| 25  | Multi-select             | **Current page only**; flip page clears or does not retain cross-page selection                         |
| 26  | Search                   | `source_text` OR `translated_text`, case-insensitive LIKE, escape `%`/`_`, max 200 chars                |
| 27  | Time display             | Local timezone `YYYY-MM-DD HH:mm`                                                                       |
| 28  | Clear All placement      | Title/filter area danger control (not only bulk bar)                                                    |
| 29  | CSV file write           | Frontend `@tauri-apps/plugin-dialog` `save()` + `@tauri-apps/plugin-fs` `writeTextFile`                 |
| 30  | Plugin permissions       | `dialog:default` + `fs:default` in capabilities (explicit product choice; broader than least-privilege) |
| 31  | Phase-2 items            | All deferred; recorded in **Phase 2** below so they are not forgotten                                   |

### Write policy (detail)

Record only after `run_translate_attempts` returns a non-cancelled result:

| Outcome                                              | Persist? | `status`   |
| ---------------------------------------------------- | -------- | ---------- |
| Success                                              | Yes      | `complete` |
| Soft fail after at least one provider attempt        | Yes      | `failed`   |
| `TranslatePrepare::Early` validation/config failures | **No**   | —          |
| Cancelled                                            | **No**   | —          |
| Hard error before a translate result                 | **No**   | —          |

History insert failure must **not** fail translate; log `history_record_failed` only.

---

## File Map

- Create: `src-tauri/migrations/0008_translation_history.sql` — history table + indexes
- Create: `src-tauri/src/domain/translation_history.rs` — entity, list/preview/full DTOs, facets
- Create: `src-tauri/src/repositories/translation_history.rs` — SQL read/write/delete/facets
- Create: `src-tauri/src/services/translation_history.rs` — validation, retention, date normalize, preview
- Create: `src-tauri/src/cmds/translation_history.rs` — IPC handlers
- Create: `src/routes/history.tsx` — History route page
- Create: `src/features/history/HistoryFilters.tsx` — search/model/language/date + Apply
- Create: `src/features/history/HistoryTable.tsx` — selectable table, bulk bar, row actions
- Create: `src/features/history/HistoryDetailDialog.tsx` — full-text review dialog
- Create: `src/features/history/historyCsv.ts` — pure CSV builder
- Create: `src/features/history/historyCsv.test.ts` — CSV escaping/header coverage
- Create: `src/features/history/historyExport.ts` — save dialog + writeTextFile helper
- Modify: `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/src/domain/translation.rs` — language-id metadata on `TranslateInput`
- Modify: `src-tauri/src/repositories/mod.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/models.rs` — record history after real attempts only
- Modify: `src-tauri/src/cmds/mod.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/events.rs` — `data://translation-history-changed`
- Modify: `src-tauri/src/lib.rs` — register history commands + dialog/fs plugins
- Modify: `src-tauri/src/storage/migrations.rs` — migration 0008
- Modify: `src-tauri/Cargo.toml` — `tauri-plugin-dialog`, `tauri-plugin-fs`
- Modify: `src-tauri/capabilities/default.json` — `dialog:default`, `fs:default`
- Modify: `package.json` — `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs`
- Modify: `src-tauri/src/storage/tests.rs` / `repositories/tests.rs` / `services/tests.rs`
- Modify: `src/storage/types.ts`, `src/storage/client.ts`
- Modify: `src/query/keys.ts`, `options.ts`, `events.ts`, `QueryEventSync.tsx`
- Modify: `src/shell/nav.ts`
- Modify: `src/i18n/locales/en.ts`, `zh-CN.ts`
- Modify: `src/routes/translate/index.tsx`, `src/routes/quick-translate.tsx` — language ID metadata
- Generated: `src/routeTree.gen.ts` (router plugin)

## Data Model

### SQLite table `translation_history`

```sql
CREATE TABLE translation_history (
    id                      TEXT PRIMARY KEY,
    created_at              TEXT NOT NULL,
    source_text             TEXT NOT NULL,
    translated_text         TEXT NOT NULL DEFAULT '',
    source_lang             TEXT NOT NULL,
    target_lang             TEXT NOT NULL,
    effective_source_lang   TEXT,
    effective_target_lang   TEXT,
    model_id                TEXT,
    model_display_name      TEXT NOT NULL,
    provider_display_name   TEXT,
    profile_id              TEXT,
    profile_name            TEXT,
    status                  TEXT NOT NULL
                            CHECK (status IN ('complete', 'failed')),
    error_code              TEXT,
    error_message           TEXT,
    latency_ms              INTEGER NOT NULL DEFAULT 0
                            CHECK (latency_ms >= 0)
);

CREATE INDEX idx_translation_history_created_at
    ON translation_history(created_at DESC, id DESC);
CREATE INDEX idx_translation_history_model_id
    ON translation_history(model_id);
CREATE INDEX idx_translation_history_status
    ON translation_history(status);
CREATE INDEX idx_translation_history_effective_source
    ON translation_history(effective_source_lang);
CREATE INDEX idx_translation_history_effective_target
    ON translation_history(effective_target_lang);
```

### DTO shapes

```ts
type HistoryStatus = "complete" | "failed";

/** Full row for get / get_many / CSV. */
interface TranslationHistoryDto {
	id: string;
	createdAt: string; // RFC 3339 UTC
	sourceText: string;
	translatedText: string;
	sourceLang: string;
	targetLang: string;
	effectiveSourceLang: string | null;
	effectiveTargetLang: string | null;
	modelId: string | null;
	modelDisplayName: string;
	providerDisplayName: string | null;
	profileId: string | null;
	profileName: string | null;
	status: HistoryStatus;
	errorCode: string | null;
	errorMessage: string | null;
	latencyMs: number;
}

/** List row: previews instead of full text. */
interface TranslationHistoryListItemDto {
	id: string;
	createdAt: string;
	sourceTextPreview: string; // up to 160 scalars
	translatedTextPreview: string;
	sourceTextTruncated: boolean;
	translatedTextTruncated: boolean;
	sourceLang: string;
	targetLang: string;
	effectiveSourceLang: string | null;
	effectiveTargetLang: string | null;
	modelId: string | null;
	modelDisplayName: string;
	providerDisplayName: string | null;
	profileId: string | null;
	profileName: string | null;
	status: HistoryStatus;
	errorCode: string | null;
	latencyMs: number;
}

interface TranslationHistoryListQuery {
	search?: string | null;
	modelId?: string | null;
	/** When modelId is null but snapshot-only rows exist, optional modelDisplayName filter may be needed — prefer modelId; for null model_id groups use displayName equality in facets payload. */
	modelDisplayName?: string | null;
	language?: string | null; // effective source OR target
	/** UI sends YYYY-MM-DD local day; service expands to RFC3339 bounds. */
	date?: string | null;
	page: number; // 1-based
	pageSize: number; // default 20, clamp 1..=100
}

interface TranslationHistoryListResult {
	items: TranslationHistoryListItemDto[];
	total: number;
	page: number;
	pageSize: number;
}

interface TranslationHistoryModelFacet {
	modelId: string | null;
	modelDisplayName: string;
	lastSeenAt: string;
}
```

### Translate input metadata

Optional camelCase fields on `TranslateInput` (serde default `None`):

- `sourceLangId`, `targetLangId` — configured selectors (`auto` allowed)
- `effectiveSourceLangId`, `effectiveTargetLangId` — concrete ids actually used

Prompt still uses existing `sourceLang` / `targetLang` labels.

### IPC commands

| Command                                 | Purpose                             |
| --------------------------------------- | ----------------------------------- |
| `list_translation_history`              | Preview page + total                |
| `get_translation_history`               | Full DTO by id                      |
| `get_translation_history_many`          | Full DTOs by ids (max 100)          |
| `list_translation_history_model_facets` | Distinct model snapshots for filter |
| `delete_translation_history`            | Delete by ids; emit history-changed |
| `delete_all_translation_history`        | Clear table; emit history-changed   |

## UI Scope (v1)

In scope:

- Nav: History after Profiles, before Models
- Filters: search, model (facets), language (`LANGUAGE_IDS`), single date, Apply
- Table: select, local datetime, source preview, target preview (failed → fixed error copy), model, status, actions
- Row actions: view (dialog), copy target (complete only), delete
- Bulk bar (selection non-empty): Export Selected CSV, Delete Selected
- Clear All control near title/filters with danger confirm showing `total`
- Pagination footer: Showing X–Y of Z + first/prev/next/last
- Empty / loading / error states with existing design tokens

Visual: Base UI + project tokens (not prototype brutalist shadows). Icons via `unplugin-icons` only.

## Tasks

### Task 1: Schema + repository

**Outcome:** SQLite stores full history rows; list/get/facets/delete work.

**Files:** migration 0008, domain, repository, migrations registry, repository tests

**Steps:**

- [ ] Create table/indexes; register as version 8.
- [ ] Implement `insert`, `get`, `get_many`, `list` (full text in SQL; service builds previews), `list_model_facets`, `delete_many`, `delete_all`, `count`, `delete_oldest`.
- [ ] Facets: one row per `model_id` (null ids grouped by `model_display_name`), display name from latest `created_at`.
- [ ] List ordered by `created_at DESC, id DESC` with LIMIT/OFFSET from page/pageSize.
- [ ] Search LIKE on full `source_text` / `translated_text` (not preview).

**Validation:**

- Run: `cargo test --manifest-path src-tauri/Cargo.toml migrate_`
- Expected: version 8.
- Run: `cargo test --manifest-path src-tauri/Cargo.toml translation_history`
- Expected: repository tests pass.

### Task 2: Service + IPC + frontend client/query

**Outcome:** Typed list/get/many/facets/delete/clear; delete emits event.

**Files:** service, cmds, state, events, lib, types, client, query/*, service tests

**Steps:**

- [ ] Validate query bounds; normalize local `date` → UTC `[start, end)`; escape search wildcards; clamp pageSize; cap `get_many` at 100.
- [ ] Build 160-scalar previews + truncated flags in service (or shared pure helper tested in Rust).
- [ ] Wire AppState + generate_handler entries.
- [ ] Frontend keys/options/client; QueryEventSync invalidates on history-changed.

**Validation:**

- Run: `cargo test --manifest-path src-tauri/Cargo.toml translation_history`
- Run: `mise run typecheck`

### Task 3: Record from ModelService

**Outcome:** Real translate attempts persist; Early validation and cancel do not.

**Files:** domain translation, models service, translate + quick-translate pages, tests

**Steps:**

- [ ] Add language-id metadata to `TranslateInput`.
- [ ] After `run_translate_attempts` only, call `record_from_translate` for non-cancelled results.
- [ ] Snapshot model/provider/profile; use result `model_id` when present (fallback chain).
- [ ] Do not record `TranslatePrepare::Early`.
- [ ] Insert failure is logged only; translate still returns.
- [ ] Prune to 10_000 after successful insert.
- [ ] Frontend payloads include the four language id fields.

**Validation:**

- Run: `cargo test --manifest-path src-tauri/Cargo.toml`
- Expected: translate + history recording tests pass; cancel/Early leave history empty.

### Task 4: History page UI + CSV export plugins

**Outcome:** `/history` usable end-to-end including system save dialog export.

**Files:** route, features/history/*, nav, i18n, package.json, Cargo.toml, capabilities, lib plugin init

**Steps:**

- [ ] Add dialog + fs plugins (JS + Rust) and capabilities `dialog:default`, `fs:default`.
- [ ] Nav + page with draft/applied filters, facets query, list query.
- [ ] Table, detail dialog (`get` on open), current-page selection.
- [ ] Export Selected: `get_many` → `historyCsv.build` (UTF-8 BOM) → `save({ defaultPath, filters: csv })` → `writeTextFile`; cancel save is no-op.
- [ ] Delete selected + Clear All with ConfirmDialog.
- [ ] Datetime format local `YYYY-MM-DD HH:mm`.
- [ ] Default export name: `langnext-history-YYYYMMDDTHHMMSS.csv`.

**Validation:**

- Run: `bun test src/features/history/historyCsv.test.ts`
- Run: `mise run typecheck`
- Run: `mise run lint`
- Manual: translate → history → filter → detail → copy → export → delete → clear all.

### Task 5: Hardening

**Outcome:** Cross-window delete invalidation and non-blocking history writes verified.

**Steps:**

- [ ] Delete/clear emit event; other webview refetches.
- [ ] History insert error does not change translate result.
- [ ] Model delete does not cascade history rows.
- [ ] Optional architecture doc note for history keys/event.

**Validation:** full `cargo test`, `mise run typecheck`, `mise run lint`.

## Final Validation

- `cargo test --manifest-path src-tauri/Cargo.toml` — green, including migration v8 + history tests
- `bun test src/features/history/historyCsv.test.ts` — green
- `mise run typecheck` / `mise run lint` — green
- Manual smoke: success + failed rows from main and Quick Translate; filters; detail; export selected; delete; clear all

## Failure Behavior

- Invalid page/pageSize/search — `validation_failed`
- `get` missing id — `not_found`
- `get_many` with >100 ids — `validation_failed`
- `delete_many` missing ids — idempotent (absent ids ignored)
- History insert during translate fails — log only
- Export empty selection — toast, no dialog
- User cancels save dialog — no write, no error toast required
- Oversized search — clamp or validate at 200 chars

## Privacy and Security

- Full source/translated text on local disk; never log bodies at info level
- No secrets/prompts/credential refs in DTOs or logs
- Not in config import/export
- CSV only after explicit user save path (system dialog)
- Note: `fs:default` is intentionally broad per product decision; revisit least-privilege in Phase 2 if desired

## Rollout Notes

- Migration 0008 additive
- New npm + cargo plugins required for export
- Commit regenerated `routeTree.gen.ts`

## Risks and Mitigations

- **Large full-text rows** — list uses previews; export/get_many capped at 100 ids; no disk truncation by product choice
- **High-frequency writes** — no per-write event; lean insert + retention cap
- **Language labels vs ids** — metadata fields required from frontend
- **Deleted models** — soft refs + facets from history snapshots
- **Broad fs permissions** — accepted for v1; document for later tightening

## Phase 2 (deferred — do not implement in this plan)

Recorded so they are not forgotten. Each item should become its own plan when prioritized.

1. **Favorites / remarks** — optional star + free-text note on history rows (STranslate parity).
2. **History-backed translate cache** — upsert/hit by `(source_text, langs, model_id)` before provider call.
3. **FTS5 (or equivalent) full-text search** — replace LIKE for large corpora.
4. **Settings: history limit / disable recording** — user-configurable cap; `0` = off (replace hard 10_000 constant).
5. **Stats / insight cards** — total count trends, “active model”, quota-style UI from prototype.
6. **Open in Translate / retry failed** — prefilling translate page or re-invoking from a failed row.
7. **Delete all matching current filters** — bulk delete by query, not only selected/clear-all.
8. **Export all matching filters / full archive** — beyond selected rows, with confirm + size warnings.
9. **Status filter control** — All / Complete / Failed in the filter bar (API may already support it).
10. **Cross-page multi-select** — retain selected ids across pages; optional “select all matching”.
11. **Date range filter** — from/to instead of single day.
12. **Least-privilege fs/dialog scopes** — replace `fs:default` with path-scoped write permissions or a dedicated Rust save command.
13. **Per-field disk size policy** — optional truncate/reject if unlimited full text becomes an operational problem.
14. **Live filter mode / focus refetch** — debounce search without Apply; optional refetch when History window focused after translates.

## Open Questions

**None blocking v1.** Phase 2 list is the backlog.

## Spec Coverage

| Requirement                             | Task                |
| --------------------------------------- | ------------------- |
| History display page                    | Task 4              |
| Data model                              | Data Model + Task 1 |
| Prototype filters/table/bulk/pagination | Task 4              |
| Persist translations                    | Task 3              |
| Local SQLite via existing stack         | Tasks 1–2           |
| Selected CSV + system save              | Task 4              |
| Clear all                               | Tasks 2 + 4         |

Out of scope for v1 = Phase 2 table above.
