# Plan: Channels drag-to-reorder

## Goal

Allow reordering the Channels sidebar list in `ModelsLayout` via drag-and-drop, with the new order persisted to the database.

## Approved decisions

- **Persistence**: new `sort_order` column on `provider_instances`.
- **Drag library**: `@dnd-kit/react` (pre-1.0, user-chosen).

## Design principle

`sort_order` stays a **backend-only concern**. It is NOT added to `ProviderInstance`, `ProviderInstanceDto`, or `ProviderExport`. The frontend only ever works with the array order returned by `list_provider_instances` and sends an ordered `ids: string[]` back through a new `reorder_provider_instances` IPC command. This keeps the Rust domain struct and the frontend DTO unchanged (no fixture updates, no export/import churn).

Existing rows backfill to `sort_order = 0`; the `list` query's secondary `created_at, id` ordering preserves the current display order, so the migration is non-disruptive.

## Backend (Rust)

### 1. Migration — `src-tauri/migrations/0002_provider_sort_order.sql` (new)

```sql
-- User-defined channel ordering for the Models sidebar.
ALTER TABLE provider_instances ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
```

### 2. `src-tauri/src/storage/migrations.rs`

- Append `include_str!("../../migrations/0002_provider_sort_order.sql")` to `MIGRATIONS`.
- `latest_version()` becomes 2. Update tests: `migrate_empty_database_to_v1` and `migrate_is_idempotent` assert `== 1` — update to `2` (rename the first to `..._to_v2` or add a v2 assertion). Grep for any other `read_user_version` / `== 1` assertions.

### 3. `src-tauri/src/repositories/provider_instances.rs`

- `list`: change to `ORDER BY sort_order ASC, created_at ASC, id ASC`.
- `insert`: add `sort_order` to the column list and set it via a subquery so new channels append to the end:
  ```sql
  INSERT INTO provider_instances (
      id, adapter_id, display_name, base_url_override, credential_kind, credential_ref,
      enabled, proxy_mode, insecure_http_confirmed_at, models_synced_at,
      models_sync_status, models_sync_error_code, created_at, updated_at, sort_order
  ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,
            (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM provider_instances))
  ```
  No new bound param — the subquery is literal SQL. Keep the existing 14 `params!`.
- Add `reorder(conn, ordered_ids: &[Uuid]) -> Result<(), StorageError>`: `enumerate()` the ids, `UPDATE provider_instances SET sort_order = ?2 WHERE id = ?1`; return `StorageError::NotFound` if any id matches 0 rows. Runs inside the caller's transaction.

### 4. `src-tauri/src/services/providers.rs`

- Add `reorder(&self, ordered_ids: Vec<Uuid>) -> Result<(), StorageError>` wrapping `provider_instances::reorder` in `self.db.transaction(|uow| ...)`.
- Optional validation: read current provider ids in the same transaction and reject if `ordered_ids` is missing any or has extras. Nice-to-have, not required.

### 5. `src-tauri/src/cmds/providers.rs`

```rust
#[tauri::command]
pub async fn reorder_provider_instances(
    state: State<'_, AppState>,
    ids: Vec<Uuid>,
) -> Result<(), IpcError> {
    let providers = state.providers.clone();
    run_blocking("reorder_provider_instances", move || providers.reorder(ids)).await
}
```

`Vec<Uuid>` deserializes from JS `string[]` via serde (matches existing `delete_provider_instance(id: Uuid)` pattern).

### 6. `src-tauri/src/lib.rs`

Register `cmds::providers::reorder_provider_instances` in the `generate_handler!` list.

## Frontend

### 7. `src/storage/client.ts`

```ts
export async function reorderProviderInstances(ids: string[]): Promise<void> {
	return invoke("reorder_provider_instances", { ids });
}
```

JS key `ids` matches the Rust param `ids` (no camel/snake conversion needed — verify against existing wrappers).

### 8. `src/features/models/ModelsContext.ts`

Add to `ModelsContextValue`:

```ts
reorderProviders: (orderedIds: string[]) => Promise<void>;
```

### 9. `src/features/models/ModelsLayout.tsx`

- Import `reorderProviderInstances` from `../../storage/client`.
- Add `reorderProviders` callback: optimistically reorder local `providers` state to the new id order, then `await reorderProviderInstances(orderedIds)`; on error, rollback via `refreshProviders()` and `setProvidersError(getIpcErrorMessage(...))`.
- Add `reorderProviders` to `contextValue` (and its `useMemo` deps).
- Install `@dnd-kit/react` (`bun add @dnd-kit/react`).
- Replace the `<ul>/<li>` rendering with a dnd-kit sortable list.
  - **The `@dnd-kit/react` API is pre-1.0 (0.2.x) and differs from legacy `@dnd-kit/core`.** Before writing JSX, resolve the library via Context7 and read the installed types in `node_modules/@dnd-kit/react` to confirm the exact imports (likely `DragDropProvider` from `@dnd-kit/react` and `useSortable` from `@dnd-kit/react/sortable`, with `onDragEnd` yielding the new order). Do NOT assume the legacy `SortableContext`/`DndContext` API.
- On drag end: compute the new ordered `provider.id` list and call `reorderProviders(newIds)`.
- Keep `<li key={provider.id}>` stable; the `<Link>` stays inside each sortable item. Decide whole-row drag vs. a drag handle — whole-row drag is fine for a short sidebar list, but must not break link click (dnd-kit distinguishes click vs. drag by movement threshold, so a Link inside a draggable is OK).
- **Auto-Animate conflict mitigation**: the list already has `useAutoAnimate` for add/remove. dnd-kit also animates drops, so both firing on reorder can jitter. Use the `[ref, setEnabled]` second return value from `useAutoAnimate`: `setEnabled(false)` on drag start, `setEnabled(true)` on drag end. If jitter persists, fall back to removing Auto-Animate from this `<ul>` (dnd-kit owns drop animation; add/remove can rely on dnd-kit or be re-added later).

### 10. Export/import

**Out of scope**: `sort_order` is NOT added to `ProviderExport`. Imported providers append via the `insert` subquery. Custom order is not preserved across export/import — note as future work. (Worker may add it if trivially easy, but it is not required and should not expand scope.)

## Validation

Run all of these; fix anything that breaks:

- `cargo test --manifest-path src-tauri/Cargo.toml` (migration tests + repo/service tests)
- `cargo check --manifest-path src-tauri/Cargo.toml` (or `mise run tauri:build` if fast enough)
- `mise run typecheck`
- `mise run lint`
- `mise run format:check`

Manual (report, don't block on it if Tauri build is slow): `mise run tauri:dev` → drag a channel to reorder → reload → confirm order persists; add a new channel → confirm it appears at the end.

## Files touched

- `src-tauri/migrations/0002_provider_sort_order.sql` (new)
- `src-tauri/src/storage/migrations.rs`
- `src-tauri/src/repositories/provider_instances.rs`
- `src-tauri/src/services/providers.rs`
- `src-tauri/src/cmds/providers.rs`
- `src-tauri/src/lib.rs`
- `src/storage/client.ts`
- `src/features/models/ModelsContext.ts`
- `src/features/models/ModelsLayout.tsx`
- `package.json` / `bun.lock` (`@dnd-kit/react`)

## Notes for the worker

- Every new/changed code file must start with two `ABOUTME:` comment lines (Rust and TS).
- Do not hand-edit `src/routeTree.gen.ts`.
- Prefer named Tailwind tokens over arbitrary values.
- Do not commit. Leave changes in the working tree on `feat/models-page`.
- The `ProviderInstance` Rust struct and `ProviderInstanceDto` (both Rust and TS) must NOT change — `sort_order` is SQL-only.
