# Models Page Implementation Plan

> Source design: `docs/drafts/ui/models.html`
> Target branch: `feat/models-page`
> Date: 2026-07-10

## Goal

Implement the Models configuration page from `docs/drafts/ui/models.html` using nested TanStack Router routes and the existing real Tauri storage IPC APIs.

## 1. Overview and Scope

### Included

- Add a primary **Models** navigation item between Home and About.
- Add a nested `/models` route with:
  - Provider-instance secondary sidebar.
  - Empty state when no channel is selected.
  - Provider connection editor.
  - Manual model creation and model enabled-state management.
- Load and mutate real data through `src/storage/client.ts`.
- Use Base UI Dialog for adding channels and manual models.
- Preserve credentials securely by using `CredentialUpdate`; never request or display stored secret values.
- Provide loading, empty, validation, pending, success, and error states.
- Match the design with existing semantic theme tokens and outline/frame styling.

### Out of Scope

- Provider HTTP adapters.
- A `test_connection` Tauri command.
- Remote model fetching or synchronization IPC.
- Exposing `ModelService::apply_remote_merge` directly to the frontend.
- Fake connection results, fake model lists, or any mock storage path.
- Provider/model deletion and manual-model editing, because the design has no corresponding controls.
- Changes to the Rust backend or `package.json`.

Render **Test connection** and **Get model** as disabled controls. Wrap each disabled button in an element with `title="Backend command not yet available"` and connect visible or screen-reader help with `aria-describedby`. Do not display "Connected," because no backend operation has verified connectivity; display only factual credential state such as "Token stored securely" or "No token stored."

Future backend work should:

1. Implement adapter-specific HTTP behavior.
2. Add a sanitized `test_connection` command that reads credentials only in Rust.
3. Add a model-sync command that fetches remote models and invokes `ModelService::apply_remote_merge`.
4. Optionally expose adapter catalog metadata through IPC to remove frontend catalog duplication.

## 2. Route and Navigation Changes

Final route structure:

- `src/routes/models.tsx` - `/models` parent layout route.
- `src/routes/models/index.tsx` - `/models/` empty selection state.
- `src/routes/models/$providerId.tsx` - `/models/$providerId` selected provider editor.

The parent route renders the secondary sidebar and an `<Outlet />`. The provider route parameter is the only source of selected-channel state; do not maintain a second selected ID in React state.

Update `src/shell/nav.ts` to:

```text
Home -> Models -> About
```

Use `{ to: "/models", label: "Models", exact: false }` so nested provider routes keep Models active. This ordering makes Home -> Models and Models -> About use `scroll-down`, with the reverse paths using `scroll-up`. Navigations between `/models` children stay within the same primary navigation index and should not trigger a primary-page scroll transition.

After adding route files, generate `src/routeTree.gen.ts` before typechecking:

1. Start `mise run dev`.
2. Wait until the router plugin updates `src/routeTree.gen.ts`.
3. Stop the dev server.
4. Verify generated entries for `/models`, `/models/`, and `/models/$providerId`.

Never hand-edit or format `src/routeTree.gen.ts`. Do not initially use `mise run build` for generation because its `tsc --noEmit` step runs before Vite.

## 3. Component Breakdown

### `src/components/ui.ts`

- Export shared class-name constants for new page controls: `outlineButtonClassName`, `primaryButtonClassName`, `inputClassName`, `selectClassName`, `checkboxClassName`, and Dialog backdrop/popup classes.
- Keep these as class constants rather than wrapper components so Base UI composition remains explicit.
- Do not refactor unrelated TitleBar or ThemeToggle styles.

```ts
// ABOUTME: Shared semantic class-name constants for outline controls and dialogs.
// ABOUTME: Keeps Base UI frame styling consistent without wrapping its primitives.
```

### `src/storage/errors.ts`

- Export a safe helper that converts an unknown rejected IPC value into a display message.
- Accept Tauri's structured `{ code, message }` shape, plain strings, and ordinary `Error` objects.
- Fall back to a caller-provided generic message.
- Never log form values or API tokens.

```ts
// ABOUTME: Converts unknown Tauri IPC rejections into safe user-facing messages.
// ABOUTME: Preserves sanitized backend messages without exposing form secrets.
```

### `src/features/models/adapterOptions.ts`

- Define the three confirmed adapter creation options: `openai-compatible`, `anthropic`, `gemini`.
- Include labels and known default Base URLs for input placeholders.
- Export a default-URL lookup helper.
- Use this list only in the add-channel dialog; the Channels sidebar must come exclusively from `ProviderInstanceDto[]`.

```ts
// ABOUTME: Frontend adapter options used when creating provider instances.
// ABOUTME: Mirrors the backend metadata catalog until catalog IPC is available.
```

### `src/features/models/ModelsContext.ts`

- Define `ModelsContextValue` with `providers`, `providersLoading`, `providersError`, `refreshProviders()`, and `upsertProvider(provider)`.
- Export the context and a guarded `useModelsContext()` hook.

```ts
// ABOUTME: Shared provider-list state for nested Models routes.
// ABOUTME: Keeps route selection in the URL while sharing loaded provider DTOs.
```

### `src/features/models/ModelsLayout.tsx`

- Load channels with `listProviderInstances()` using `useEffect`, `useState`, and a cancellation/stale-response guard.
- Provide the models context.
- Render the fixed-width Channels sidebar and nested `<Outlet />`.
- Render loading, retry, and empty sidebar states.
- Render provider links using `/models/$providerId`.
- Open the add-channel dialog from the bottom `+` button.
- On creation, upsert the returned DTO and navigate to the new provider route.

```tsx
// ABOUTME: Models feature layout with provider sidebar and nested route outlet.
// ABOUTME: Loads real provider instances and coordinates add-channel navigation.
```

### `src/features/models/AddProviderDialog.tsx`

Props: `{ open, onOpenChange, onCreated }`.

- Use Base UI Dialog.
- Collect display name, adapter, optional Base URL override, credential kind, optional token, and initial enabled state.
- Default `proxyMode` to `"inherit"`.
- Submit `saveProviderInstance()` with blank Base URL normalized to `null`; `credential: { action: "replace", value }` for a non-empty token; `{ action: "keep" }` for an authenticated kind without a token; `{ action: "clear" }` when kind is `"none"`.
- Disable submission while pending and show backend validation errors inside the dialog.
- Close only after successful persistence.

```tsx
// ABOUTME: Dialog for creating a real provider instance through Tauri IPC.
// ABOUTME: Collects adapter, endpoint, credential policy, and initial enabled state.
```

### `src/features/models/ProviderEditor.tsx`

Props: `{ providerId }`.

- Resolve the selected provider from `ModelsContext`.
- Show provider-loading, provider-error, and not-found states.
- Own local connection-form state and load models with `listProviderModels(providerId)`.
- Render the header, Connection card, Models card, and persistent footer.
- Coordinate provider saving, Cancel reset, model reload, model toggles, and add-model dialog.
- Upsert the DTO returned by `saveProviderInstance()` into context.

```tsx
// ABOUTME: Selected provider editor for connection settings and model management.
// ABOUTME: Coordinates local form state with real provider and model storage IPC.
```

### `src/features/models/ModelsTable.tsx`

Props: `{ models, pendingModelIds, onEnabledChange }`.

- Render Model, Display Name, and Enabled columns.
- Resolve display name as `displayNameOverride ?? remoteDisplayName ?? "-"`.
- Use each row checkbox as the enabled control.
- Disable a row while its enable mutation is pending.
- Show "Yes" or "No" in the Enabled column.
- Render an explicit no-models state.

```tsx
// ABOUTME: Provider model table with immediate persisted enabled-state controls.
// ABOUTME: Displays manual, remote, and built-in model DTOs without fabricating data.
```

### `src/features/models/AddManualModelDialog.tsx`

Props: `{ open, providerId, onOpenChange, onCreated }`.

- Collect model key, optional display-name override, and initial enabled state.
- Submit `saveManualModel()` with `capabilityOverridesJson: null`.
- Trim the model key and normalize a blank display-name override to `null`.
- Use `maxLength={256}` for the model key to mirror backend validation.
- Keep the dialog open and show errors when persistence fails.

```tsx
// ABOUTME: Dialog for adding a manual model to the selected provider.
// ABOUTME: Persists model identity, display override, and enabled state through IPC.
```

### Route files

```tsx
// src/routes/models.tsx
// ABOUTME: Parent Models route providing the channel sidebar and nested outlet.
// ABOUTME: Delegates provider loading and channel creation to the feature layout.
```

```tsx
// src/routes/models/index.tsx
// ABOUTME: Empty Models child route shown before a channel is selected.
// ABOUTME: Prompts the user to select or create a provider instance.
```

```tsx
// src/routes/models/$providerId.tsx
// ABOUTME: Dynamic Models child route for one selected provider instance.
// ABOUTME: Reads the provider ID from the URL and renders its configuration editor.
```

## 4. Data Flow and State Management

Use `useEffect + useState + invoke wrappers`, matching the existing frontend style. Do not introduce route loaders or another state-management dependency.

### Provider list

1. `ModelsLayout` calls `listProviderInstances()` on mount.
2. The returned order is used directly.
3. Providers are exposed through `ModelsContext`.
4. Sidebar links derive from `provider.id` and `provider.displayName`.
5. Retry calls the same refresh function.
6. Add-channel success appends/upserts the returned provider and navigates to it.
7. Provider-save success replaces the matching DTO in context.

### Selected provider

1. `$providerId.tsx` reads `Route.useParams()`.
2. `ProviderEditor` resolves the DTO from context.
3. While the provider list is loading, render a loading state instead of a false not-found state.
4. After loading completes, show a not-found state if the ID does not exist.

### Model list

1. On `providerId` change, clear stale model state and call `listProviderModels(providerId)`.
2. Ignore responses belonging to an obsolete provider ID or unmounted component.
3. Add-model success should call the model reload function so backend ordering remains authoritative.
4. Retry should rerun the same list operation.

### Model enabled state

- Checkbox changes call `setModelEnabled(id, enabled)` immediately.
- Optimistically update the matching row and mark it pending.
- Replace it with the DTO returned by the backend on success.
- Restore the prior DTO and show a section-level error on failure.
- Prevent overlapping mutations for the same model.
- Cancel in the connection footer does not revert model toggles because they are already persisted.

### Error handling

- Maintain separate errors for provider loading, provider saving, model loading/toggling, and each dialog.
- Clear stale errors before retrying.
- Render failures with `role="alert"` or `aria-live="polite"`.
- Do not add fake fallback data when IPC fails.

## 5. Provider Form and Credential Contract

Initialize local form state from the selected `ProviderInstanceDto` and reset it whenever `provider.id` changes.

Submit a complete `ProviderInstanceWrite`:

```ts
{
	id: provider.id,
	adapterId: provider.adapterId,
	displayName: provider.displayName,
	baseUrlOverride: normalizedBaseUrl,
	credentialKind: provider.credentialKind,
	credential,
	enabled,
	proxyMode: provider.proxyMode,
	insecureHttpConfirmedAt,
}
```

Use `saveProviderInstance()` as the single Save operation. Do not call `setProviderEnabled()` from this form.

### Base URL

- Keep the controlled value empty when `baseUrlOverride` is `null`.
- Show the adapter default URL as a placeholder/help string; do not copy it into the value automatically.
- Normalize whitespace-only input to `null`.
- Preserve the existing `insecureHttpConfirmedAt` only while the endpoint is unchanged.
- For a changed non-loopback HTTP endpoint, show an explicit insecure-HTTP acknowledgment checkbox and submit a new ISO timestamp only after acknowledgment.
- Continue relying on backend validation for userinfo, query strings, fragments, and unsupported schemes.

### API token

- Never populate the input with a stored value.
- If `hasCredential` is true, show a bullet placeholder such as `•••••••••••• (stored)`.
- Use `type="password"`, disable spellcheck, and avoid logging the value.
- Initial action is `"keep"`.
- A non-empty new token produces `{ action: "replace", value: token }`.
- Provide an explicit "Remove stored token" action that produces `{ action: "clear" }`.
- Emptying an edited token must not accidentally clear an existing credential; return to `"keep"` unless the explicit removal action was selected.
- If `credentialKind === "none"`, disable the token control and preserve the credential kind.
- Clear token state after Save, Cancel, or provider change.

If a stored credential exists and `baseUrlOverride` changes, frontend validation must require token replacement or explicit removal. The backend rejects endpoint changes combined with `CredentialUpdate.keep`.

### Enabled state

- Add a "Channel enabled" checkbox to the Connection card action column.
- Keep it in local form state.
- Persist it only through the footer Save action.
- Cancel restores the saved DTO value.

### Save and Cancel

- Save is disabled while pending or when required fields/acknowledgments are invalid.
- On success, update context with the returned DTO and reset token mutation state to `"keep"`.
- Cancel resets only unsaved connection fields and credential actions.
- Display a small saved-state confirmation without claiming the endpoint was tested.

## 6. Add-Channel and Add-Model Interactions

Use Base UI Dialog for both interactions, copying the accessible portal/backdrop/popup pattern from `src/routes/index.tsx`.

Dialogs must provide: `Dialog.Title` and `Dialog.Description`; associated labels for every input; Submit and Cancel controls; pending-state disabling; inline backend error output; state reset when reopened after a successful submission; no close-on-submit until the real IPC operation succeeds.

The sidebar always displays provider instances from storage. The fixed adapter options are used only to construct a new `ProviderInstanceWrite`.

## 7. Style Mapping

| Draft concept                | Project utility                           |
| ---------------------------- | ----------------------------------------- |
| White page/card              | `bg-surface`                              |
| Light selected/hover surface | `bg-surface-2`                            |
| Active pressed surface       | `bg-surface-3`                            |
| Primary text                 | `text-ink`                                |
| Secondary text               | `text-muted`                              |
| Wireframe border             | `border border-line`                      |
| Heavy offset shadow          | `shadow-frame`                            |
| Model/code treatment         | `bg-code`, `font-mono`                    |
| Disabled controls            | `text-disabled`, `border-disabled`        |
| Error text                   | `text-danger`                             |
| Dialog backdrop              | `bg-overlay`                              |
| Primary Save button          | `bg-ink text-surface`                     |
| Focus treatment              | `focus-visible:outline-2 ... outline-ink` |

Use `rounded-none` throughout controls and cards.

Keep the root layout unchanged. Render the secondary layout as a full-height framed region inside the existing root main padding, using a desktop-height calculation equivalent to the viewport minus the titlebar and vertical main padding. The secondary sidebar should be `w-48 shrink-0`; its list scrolls independently while the add button remains at the bottom. The selected provider area must use `min-w-0` and its content must scroll independently above a non-scrolling footer.

Connection fields may stack at narrow widths. The model table must use horizontal overflow rather than compressing labels beyond usability.

No global token additions should be necessary in `src/styles.css`. Preserve the existing `.page-transition` behavior.

## 8. Ordered Implementation Steps

1. Add shared UI class constants in `src/components/ui.ts`.
2. Add the safe IPC error helper in `src/storage/errors.ts`.
3. Add frontend adapter creation metadata in `src/features/models/adapterOptions.ts`.
4. Add Models to `src/shell/nav.ts` between Home and About with `exact: false`.
5. Create the three nested route files with only route wiring and ABOUTME comments.
6. Implement `ModelsContext.ts` and `ModelsLayout.tsx` with provider loading, retry handling, sidebar links, and nested Outlet.
7. Implement `AddProviderDialog.tsx` and wire the sidebar `+` button to real provider creation and navigation.
8. Implement `ProviderEditor.tsx` provider resolution, local connection state, Save/Cancel behavior, credential actions, and factual credential status.
9. Add disabled Test connection behavior with explanatory title/help and no invoke call.
10. Implement provider model loading and retry handling in `ProviderEditor`.
11. Implement `ModelsTable.tsx` and immediate `setModelEnabled()` mutations with pending and rollback behavior.
12. Implement `AddManualModelDialog.tsx` and refresh the model list after successful creation.
13. Add disabled Get model behavior with the same backend-unavailable explanation and no fake model synchronization.
14. Add loading, empty, not-found, validation, and IPC-error states across the page.
15. Apply semantic tokens, outline borders, frame shadows, independent scrolling, sticky footer behavior, and accessible focus states.
16. Generate `src/routeTree.gen.ts` through Vite and verify the generated hierarchy without editing it.
17. Run automated validation and the real Tauri manual smoke test.

## 9. Validation

Run in this order:

1. Start `mise run dev`, wait for route generation, then stop it.
2. Inspect `src/routeTree.gen.ts` for the three Models routes; do not edit it.
3. Run `mise run typecheck`.
4. Run `mise run lint`.
5. Run `mise run format`.
6. Run `mise run format:check`.
7. If formatting changed TypeScript, rerun typecheck and lint.
8. Run `mise run build`.
9. Run `mise run tauri:dev` for real IPC validation.

Manual smoke checks in the Tauri app:

- Models appears between Home and About and has the expected transition direction.
- `/models` shows a selection/empty state without inventing channels.
- Add all supported adapter types and confirm the sidebar uses saved display names.
- Create a channel without a token and another with a real token.
- Confirm a stored token is represented only by a placeholder.
- Cancel restores Base URL, token action, and enabled state.
- Save persists Base URL and enabled state across application restart.
- Replacing and explicitly clearing a token update factual credential status.
- Changing an endpoint with a stored credential is blocked until replacement or removal is selected.
- Non-loopback HTTP requires explicit acknowledgment.
- Add a manual model and confirm it persists after restart.
- Toggle a model and confirm immediate persistence and pending-state disabling.
- Duplicate model keys and invalid URLs surface real backend validation errors.
- Test connection and Get model remain disabled and never claim success.
- Dialogs are keyboard accessible and render correctly in light and dark themes.

## Files to Modify

- `src/shell/nav.ts` - add Models between Home and About with nested-route active matching.
- `src/routeTree.gen.ts` - regenerated by the TanStack Router Vite plugin; never hand-edit.

## New Files

- `src/routes/models.tsx` - parent nested Models route.
- `src/routes/models/index.tsx` - unselected-channel empty state.
- `src/routes/models/$providerId.tsx` - selected provider route.
- `src/components/ui.ts` - shared semantic control and dialog classes.
- `src/storage/errors.ts` - safe IPC error-message extraction.
- `src/features/models/adapterOptions.ts` - known adapter creation metadata.
- `src/features/models/ModelsContext.ts` - provider-list context contract.
- `src/features/models/ModelsLayout.tsx` - secondary sidebar, loading, and add-channel coordination.
- `src/features/models/AddProviderDialog.tsx` - real provider creation dialog.
- `src/features/models/ProviderEditor.tsx` - connection form and model-section coordinator.
- `src/features/models/ModelsTable.tsx` - model table and enabled controls.
- `src/features/models/AddManualModelDialog.tsx` - real manual-model creation dialog.

Every new code file must begin with two syntax-appropriate `ABOUTME:` comment lines.

## Risks

- **No connection verification exists.** Keep Test connection disabled and never display "Connected."
- **No remote model transport exists.** Keep Get model disabled; do not call `apply_remote_merge` from the frontend.
- **Credential DTOs contain no plaintext.** Never initialize the token input from DTO data; use explicit keep/replace/clear state.
- **Endpoint changes are credential-sensitive.** A stored credential cannot be kept when the Base URL changes.
- **Insecure HTTP requires backend confirmation metadata.** The UI must collect explicit acknowledgment or the endpoint cannot be saved.
- **Adapter metadata is duplicated temporarily.** Keep it isolated in one frontend module until catalog IPC exists.
- **Route generation precedes typechecking.** New route literals and navigation targets may fail TypeScript until Vite regenerates `src/routeTree.gen.ts`.
- **Browser-only Vite cannot validate storage IPC.** Use `mise run tauri:dev` for functional verification; do not add a browser mock.
- **Connection Cancel does not undo model toggles.** Model checkboxes persist immediately by design.
- **The draft omits several backend fields.** Preserve adapter ID, credential kind, proxy mode, display name, and relevant confirmation metadata in every full provider write.
