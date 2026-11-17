# Implementation Plan

**Goal:** Implement provider-first channel creation and editable channel drafts with four API protocols, using vertical TDD slices.

**Inputs:** [Provider Channels](../specs/provider-channels.md), including AC-01 through AC-18; [Design System](../ui/DESIGNE.md); the current `features/models/` implementation.

**Assumptions:**

- Keep TypeScript/TSX ownership and NSH 0.5.1. Do not add dependencies or upgrade the framework.
- Keep `adapterId` as the channel's default API field and `providerId` as a model's owning channel ID. Add `presetId` for provider identity instead of renaming unrelated fields.
- Use a new storage namespace. Do not read, migrate, or delete legacy configuration as part of this work.
- A successful catalog request proves catalog connectivity only. Model-route construction can be tested without adding an inference client or sending a paid request.
- Saving during discovery commits the currently visible list and cancels that draft's unfinished fetch. The saved channel can fetch again; Save does not wait for a remote result.

**Architecture:** Keep persisted channels and models in `store.ts`. Own a new channel's connection fields, credential, model collection, and pending operations in one page-owned draft. Reuse the existing editor, dialogs, and table with explicit action callbacks; resolve requests from an immutable connection snapshot rather than from a persisted channel alone.

**Tech Stack:** TypeScript, TSX, NSH signals, `nsh/test`, NSH Storage, `fetch`, `AbortController`, mise, oxlint, oxfmt, and the existing Rust host.

---

## Execution rules

The user confirmed all three test seams below. No further seam approval is needed
unless execution introduces another boundary.

For every slice:

1. Write one behavior test, using a literal expectation from the spec.
2. Run its exact filtered command and observe the required behavioral failure.
3. Implement only enough to pass that test. Run the same command again.
4. Repeat for the next case, not for a batch of imagined behavior.
5. Run affected regressions before committing the completed task locally.

An import error, unrelated type error, runner failure, or zero matched tests is not
the required red result. If a case already passes because an earlier slice delivered
it, keep the regression test and record that fact. Do not break working code to
manufacture a failure or add unnecessary implementation.

Refactoring belongs to the separate review stage below, not to the red-green cycle.
Do not replace the store or editor wholesale. Do not commit failing tests,
placeholders, `test.only`, or skipped required acceptance scenarios.

After each completed task that changed files, make a local Conventional Commit.
Do not push. A breaking storage contract does not authorize a major-version release
message, a `!` marker, or a `BREAKING CHANGE` footer.

## Repository evidence

- `features/models/add-channel-dialog.tsx` currently combines creation fields in a
  modal. `page.tsx` renders only saved-channel details.
- `provider-editor.tsx` holds connection drafts, but Test and Get models are disabled
  while dirty and read saved configuration through the store.
- Model dialogs and `models-table.tsx` call persistence functions directly. They
  cannot currently edit a new channel's in-memory collection.
- `store.ts` separates channel and credential records, but model identity includes
  `sourceAdapterId`. Model discovery and testing require a saved channel ID.
- `model-helpers.ts` displays a source protocol instead of dynamic inheritance.
- `app/shell.tsx` changes pages directly. A draft guard must run before page removal.
- `.mise/tasks/test` forwards arguments to `nsh test .`. The installed CLI confirms
  `--filter` is a test-name substring filter. Use a unique name for each cycle.
- `.nsh/types/nsh/test.d.ts` confirms network routes, delayed responses, request
  inspection, storage snapshots, keyboard input, and native screenshots.
  `OpenOptions.modules` is headless-only. Do not pass it to desktop tests.
- `.nsh/types/nsh/index.d.ts` defines `StorageModule` and quota-write failures.
  No `storageErrors` test option exists in the inspected declaration.

## File Map

Create production files only when their first behavior needs them:

- Create: `services/protocols/presets.ts` — five preset descriptors, defaults,
  protocol allowlists, and translated label keys. No UI imports.
- Create: `services/protocols/routing.ts` — public request-target resolution from
  preset, API, configured root, and request operation.
- Create: `features/models/channel-draft.ts` — the page-owned new-channel state;
  no persistent writes and no second global model store.
- Create: `features/models/model-collection.ts` — shared identity and merge behavior
  used by both draft and saved collections. Do not test private merge machinery.
- Create: `assets/icons/gemini.svg`, `assets/icons/anthropic.svg`, and
  `assets/icons/deepseek.svg` — local provider marks with recorded source and usage
  terms. Reuse `assets/icons/openai.svg` and `cube-outline.svg` for Custom.

Modify existing production files:

- `services/protocols/types.ts` — four protocol IDs, separate preset IDs, and
  connection/request snapshot types.
- `services/protocols/adapters.ts` — use preset-aware routing while retaining
  pagination, parsing, normalized errors, cancellation, and timeouts.
- `features/models/types.ts` — preset identity, transient draft types, and save inputs.
- `features/models/store.ts` — new storage keys, local draft commit, shared model
  merging, and accurate partial-write results.
- `features/models/model-helpers.ts` — effective API resolution and display.
- `features/models/add-channel-dialog.tsx` — provider picker only.
- `features/models/page.tsx` — draft lifecycle, selection, exit confirmation, and
  action routing between draft memory and saved data.
- `features/models/provider-editor.tsx` — reuse the detail layout in draft and saved
  modes; operate on current connection inputs.
- `features/models/add-model-dialog.tsx`, `edit-model-dialog.tsx`, and
  `models-table.tsx` — controlled mutations and preset-filtered API choices.
- `features/models/channels-rail.tsx` — use the preset-aware API label if needed;
  retain saved-channel ordering, selection, and enable controls.
- `app/shell.tsx` — invoke a Models leave guard before changing pages.
- `components/ui/icon.tsx` — register provider assets in the existing icon layer.
- `locales/en.yml`, `locales/zh-CN.yml` — all new labels, errors, and accessible names.
- `docs/ui/DESIGNE.md` — motion inventory before UI changes; validation evidence after.
- `.mise/tasks/test-desktop` — run desktop-capable `*.test.tsx` files without
  passing headless-only native-module replacement tests to the desktop host.

Tests:

- Modify: `features/models/logic.test.ts` — public effective-API and display behavior.
- Modify: `features/models/models.test.tsx` — retain existing model and channel
  regressions; replace obsolete expectations in the slice that changes their behavior.
- Create: `features/models/channels.test.tsx` — new App workflows. Prefix names with
  `provider channels:` so they can also run on a native desktop.
- Create: `features/models/storage.test.ts` — headless-only native Storage fault
  cases. It needs no JSX. Prefix names with `provider storage:`.
- Create: `services/protocols/routing.test.ts` — public request-target contracts.
  Prefix names with `provider routing:`.
- Create: `features/models/__tests__/fixtures.ts` — current-format test records and
  helpers that act through the public App driver. No mocked application modules.

Do not modify `AGENTS.md`, dependency versions, Rust business logic, or unrelated
settings. Do not add production test modes or test-only branches to the store.

## Seams

### S1: Public model API rules

Test `formatModelApiTypeDisplay` and the effective-API resolver introduced in Task 1.
Observe inherited versus explicit APIs. Do not read private signals or duplicate
implementation calculations in assertions.

### S2: Complete App workflow

Use `open("../../App.tsx", ...)` from the feature test files. Press controls and
inspect visible rows, labels, errors, and reopened state. This boundary covers the
picker, draft, model dialogs, saving, navigation, and focus.

For persistence behavior, reopen the App with its storage snapshot and verify the
user-visible result. Do not use JSON field assertions as the only evidence that a
workflow works.

### S3: Request and persistence system boundaries

Observe requests through `app.requests()` and catalog results through the real App.
Test the public request-target resolver for paths that must be constructed without
executing inference. Network routes control only external responses; do not mock
adapters or stores.

Use native Storage boundary replacements only in the dedicated headless fault
suite. Storage inspection is appropriate here for credential isolation, absence of
draft writes, and partial-write behavior. It is not a substitute for App workflows.

## Data and interface decisions

Introduce these decisions incrementally in the task that needs them:

- `AdapterId` contains only `openai-compatible`, `openai-responses`, `anthropic`, and
  `gemini`. Keep the existing IDs; remove `deepseek` as a protocol.
- `ProviderPresetId` contains `openai`, `gemini`, `anthropic`, `deepseek`, and `custom`.
  `ProviderChannel.presetId` selects the policy; `adapterId` selects its default API.
- Use named storage constants for `models.v2.providers`, `models.v2.items`, and
  the credential prefix `models.v2.credentials.`. Keep unrelated settings and the
  existing model-filter preference unchanged.
- Allocate the draft's stable channel ID when a preset is selected. Reuse that ID
  on save and retry. The draft is not a persisted channel just because it has an ID.
- Keep each model's stable local ID and `modelKey`. Uniqueness is channel ID plus
  `modelKey`, irrespective of source, root, or API override.
- `createChannelDraft` is the new page-facing factory. It owns one transient
  connection and collection. Its internal signals are not additional test seams.
- `saveChannelDraft` is the store entry point for the first save. Initially it only
  needs an empty collection; Task 8 adds model persistence, and Task 12 adds tested
  partial-write recovery. Reuse current persistence helpers.
- Model dialogs receive the current preset and an `onSubmit` action. The table
  receives enable/delete actions. The owner chooses memory or store persistence.
- Extend `AdapterRequestParams` with `presetId`. Test and Fetch receive an immutable
  snapshot of current fields plus the resolved credential, not a bare saved ID.
- Introduce `resolveRequestTarget(params, operation)` in `routing.ts`. A catalog
  operation returns its URL and headers. A model operation also receives a model ID
  and returns its documented target, without sending a request or building a body.
- For shell navigation, add a Models leave-guard registration callback. The shell
  keeps the guard while Models is mounted; the page clears it on cleanup. Run a
  pending destination callback only after discard confirmation.

## Tasks

Run Tasks 1–14 in order. Within a task, finish each listed case's red-green cycle
before writing the next case. The commands below are planned checks, not checks
already executed while writing this document.

### Task 1: Resolve a model's API from its channel

**Seam:** S1.

**Outcome:** An inherited model follows the channel default, and its label names the
actual protocol instead of its discovery source. Covers the rule in AC-09.

**Files:** Modify `features/models/model-helpers.ts`, `features/models/logic.test.ts`,
`features/models/models.test.tsx`, `locales/en.yml`, and `locales/zh-CN.yml`.

**Steps:**

- [ ] **Red:** Add `provider channels: inherited API follows the channel default`.
  First exercise the existing formatter with a remotely discovered model whose
  source is Messages, override is absent, and channel default is Responses. Expect
  an inherited Responses label. Do not import a resolver that does not exist yet.
- [ ] **Green:** Add `resolveEffectiveApiType`; use it in the existing formatter.
  Remove source precedence. Keep name, capability, and token formatting unchanged.
- [ ] After the resolver exists, add its public-output cases one at a time. Repeat
  red-green for an explicit Chat override and for clearing that override.
  Split the old multi-purpose helper test only where its API expectations changed.
  Update the existing App test's Source-label assertion in this slice to expect the
  channel's effective API; keep its other synchronization checks.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: inherited API follows the channel default"`
- Expected red: the existing source/default label disagrees with Responses.
- Run green: `mise run test -- --filter "provider channels: inherited API follows the channel default"`
- Expected green: the new behavior passes; the other helper regressions still pass.

### Task 2: Save an empty OpenAI channel through the new draft flow

**Seam:** S2.

**Outcome:** The first end-to-end tracer bullet selects OpenAI, edits the right pane,
and saves locally without a network request. Starts AC-01, AC-02, AC-04, and AC-18.

**Files:** Create `presets.ts` and `channel-draft.ts` at the paths in the File Map;
modify `add-channel-dialog.tsx`, `page.tsx`, `provider-editor.tsx`, `types.ts`, and
`store.ts` under `features/models/`; update both locales, `components/ui/icon.tsx`,
provider assets and `docs/ui/DESIGNE.md`. Create
`features/models/channels.test.tsx` and `features/models/__tests__/fixtures.ts`;
modify `features/models/models.test.tsx` for the changed creation flow and schema.

**Steps:**

- [ ] Record picker/draft motion and focus transitions before changing UI code.
  Reuse `AppDialog`, `Button`, `Icon`, and current layout scales.
- [ ] **Red:** Add `provider channels: saves an empty OpenAI draft offline`.
  Open the picker, select `id:provider-preset-openai`, edit the right-pane name,
  and save with an empty key and list. Reopen and expect that channel to appear.
- [ ] **Green:** Replace the modal form with icon/name cards. Add the page-owned
  draft and the minimum empty-list save path. OpenAI starts with Responses.
- [ ] Introduce `presetId`, stable draft IDs, and the new namespace together. Update
  existing current-format seeds and callers so unrelated tests still compile.
  Move the old creation regression's name, HTTP-consent, and credential checks to
  the new picker/right-pane route in this slice, not at the final validation gate.
- [ ] Assert at the boundary that selection did not persist a channel and that
  creation/save made no network request. Do not read legacy keys or call `Storage.clear`.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: saves an empty OpenAI draft offline"`
- Expected red: the current modal has no preset card or right-pane creation draft.
- Run green: `mise run test -- --filter "provider channels: saves an empty OpenAI draft offline"`
- Expected green: one channel reopens with Responses and an empty model list.

### Task 3: Apply each preset's connection policy

**Seam:** S2.

**Outcome:** All five cards work. Connection choices and initial defaults match the
spec, independent of hostname. Completes AC-01 and AC-04; contributes to AC-05.

**Files:** Modify `services/protocols/presets.ts`, `types.ts`, and `adapters.ts`;
`features/models/add-channel-dialog.tsx`, `provider-editor.tsx`, `store.ts`, and
`channels.test.tsx`; update both locales as needed.

**Steps:**

- [ ] **Red:** Add `provider channels: Gemini has one fixed default API`.
  Select Gemini and expect only Gemini API, not an editable list of unrelated APIs.
- [ ] **Green:** Apply the preset allowlist in the connection form and local input
  validation. Remove DeepSeek from the protocol union and protocol descriptors.
- [ ] Repeat one case at a time for Anthropic, OpenAI, DeepSeek, and Custom. Use the
  spec's literal defaults and official URLs, not values copied from the preset array.
- [ ] Verify picker dismissal leaves selection unchanged. Exercise both add entry
  points. A proxy URL must not change the selected preset or its allowed protocols.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: Gemini has one fixed default API"`
- Expected red: the current shared API list exposes unrelated protocols.
- Run green: `mise run test -- --filter "provider channels: Gemini has one fixed default API"`
- Expected green: Gemini's fixed value is visible with no false choice affordance.

### Task 4: Edit a new channel's model list in memory

**Seam:** S2.

**Outcome:** Manual model editing works before the channel exists in storage.
Covers the manual-edit part of AC-07.

**Files:** Modify `features/models/channel-draft.ts`, `page.tsx`,
`provider-editor.tsx`, `add-model-dialog.tsx`, `edit-model-dialog.tsx`,
`models-table.tsx`, and `channels.test.tsx`; update both locales when needed.

**Steps:**

- [ ] **Red:** Add `provider channels: edits manual models before first save`.
  Add `not-a-real-model`, change its name, capabilities, and limits, toggle it,
  and observe the resulting draft row without saving the channel.
- [ ] **Green:** Supply explicit model actions to dialogs and the table. For a draft,
  mutate its collection in memory; for a saved channel, call existing store actions.
  Keep model defaults: manual entries enabled, discovered entries disabled.
- [ ] Repeat red-green for removing draft entries and for closing a model dialog
  without cancelling channel creation. Ensure no channel/model/credential write occurs.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: edits manual models before first save"`
- Expected red: the existing dialog requires a saved channel or writes through the store.
- Run green: `mise run test -- --filter "provider channels: edits manual models before first save"`
- Expected green: the configured row is visible, with no persisted channel or models.

### Task 5: Constrain model overrides and show effective APIs

**Seam:** S2.

**Outcome:** Model selectors use the channel preset. Clearing an override restores
inheritance in draft and saved editors. Completes AC-09 and model-level AC-04.

**Files:** Modify `features/models/add-model-dialog.tsx`, `edit-model-dialog.tsx`,
`models-table.tsx`, `provider-editor.tsx`, `store.ts`, and `channels.test.tsx`;
update both locales.

**Steps:**

- [ ] **Red:** Add `provider channels: models inherit default API until overridden`.
  In an OpenAI draft, add an inherited model and an explicit Chat model. Change the
  default between Responses and Chat; inspect both effective API labels.
- [ ] **Green:** Reuse Task 1's resolver and the preset policy. Both model dialogs
  offer Use channel default plus only allowed APIs. Never copy a default into an override.
- [ ] Repeat for clearing an override, the saved-channel editor, and a DeepSeek
  model with a Messages override. Remove obsolete Source labels in both locales.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: models inherit default API until overridden"`
- Expected red: row labels or dialog defaults still use source/fixed behavior.
- Run green: `mise run test -- --filter "provider channels: models inherit default API until overridden"`
- Expected green: only inherited models change, and the displayed protocol is explicit.

### Task 6: Test and discover from current connection inputs

**Seam:** S3.

**Outcome:** Draft and dirty saved editors can use their visible connection values.
Requests stay on the configured host. Covers AC-05, AC-06, AC-12, and AC-15.

**Files:** Create `services/protocols/routing.ts` and `routing.test.ts`;
modify `services/protocols/types.ts` and `adapters.ts`; modify
`features/models/provider-editor.tsx`, `models-table.tsx`, `channel-draft.ts`,
`store.ts`, `channels.test.tsx`, `models.test.tsx`, and both locales.

**Steps:**

- [ ] **Red:** Add `provider channels: draft discovery uses current proxy inputs`.
  Set a proxy root and key in an unsaved draft, then Get models. Observe the exact
  outgoing catalog URL and auth headers; return a catalog through `network` routes.
- [ ] **Green:** Build an immutable current-input snapshot and call the real adapter
  without requiring a persisted channel. Remove the independent sync selector and
  dirty-state network prohibition. Preserve credential keep/replace/clear semantics.
  For a saved key in keep mode, resolve it inside the store's request wrapper; do
  not expose a general secret-reader API to UI components. Replace uses the current
  input, clear uses no credential, and a new draft uses its in-memory value.
- [ ] Introduce the public request-target resolver, used by the real catalog adapter.
  Preserve configured path prefixes; never fall back to a provider's official host.
- [ ] Add one route-contract test at a time for the four protocols, DeepSeek's shared
  `GET /models`, and its model Messages target `/anthropic/v1/messages`.
  Model-target tests construct URLs only; do not add inference execution or bodies.
- [ ] Repeat for a saved editor with changed unsaved fields and for Custom with no URL.
  Custom can save, but its network action reports a missing address without making a request.
- [ ] Retain pagination, timeout, auth-error, and cancellation behavior. Connection
  success continues to mean catalog access, not inference verification.
- [ ] Update existing dirty-state and sync-selector regressions in this slice. Use
  a compatible DeepSeek or Custom preset where a test changes protocols; retain
  pagination and authentication assertions through the real adapter.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: draft discovery uses current proxy inputs"`
- Expected red: fetching is disabled, needs a saved ID, or uses the previous connection.
- Run green: `mise run test -- --filter "provider channels: draft discovery uses current proxy inputs"`
- Expected green: the real adapter reaches only the supplied proxy with current auth.
- Run each routing case, red then green: `mise run test -- --filter "provider routing:"`
  Add only the next failing case before each invocation.

### Task 7: Merge catalogs by channel and model ID

**Seam:** S3.

**Outcome:** Changing a proxy or protocol refreshes the same model records without
losing user settings. Covers AC-10 and AC-11.

**Files:** Create `features/models/model-collection.ts`; modify
`features/models/store.ts`, `channel-draft.ts`, `channels.test.tsx`, and
`models.test.tsx`.

**Steps:**

- [ ] **Red:** Add `provider channels: resync preserves one configured model per ID`.
  Configure a DeepSeek model, switch default API and proxy, and fetch the same model
  ID again. Expect one row with its name, enable state, override, and limits retained.
- [ ] **Green:** Share merge behavior between draft and saved collections. Remove
  protocol from identity and duplicate checks. Keep discovery source as metadata only.
- [ ] Repeat for a newly discovered ID, a remote entry missing from a successful
  catalog, a manual entry not returned, manual duplicate addition, and a failed fetch.
  Verify saved behavior after reopening, not only by inspecting stored JSON.
- [ ] Extend the compatible multi-protocol regression from Task 6 to assert stable
  model identity and preserved overrides. Do not remove unrelated regressions.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: resync preserves one configured model per ID"`
- Expected red: source-based identity duplicates the entry or loses configured state.
- Run green: `mise run test -- --filter "provider channels: resync preserves one configured model per ID"`
- Expected green: one stable model survives refresh and retains user configuration.

### Task 8: Save the complete draft without remote approval

**Seam:** S2.

**Outcome:** The first save persists the current model collection, not just the
connection. Completes AC-07 and AC-08.

**Files:** Modify `features/models/store.ts`, `types.ts`, `channel-draft.ts`,
`page.tsx`, `provider-editor.tsx`, and `channels.test.tsx`.

**Steps:**

- [ ] **Red:** Add `provider channels: saves manual and fetched draft models locally`.
  Keep a fetched entry and a configured nonexistent manual ID, then make a later
  catalog action return 401. Save and reopen; expect both entries and their settings.
- [ ] **Green:** Extend `saveChannelDraft` to commit the current collection under the
  draft's channel ID and retain each local model ID. Prevent duplicate submissions.
- [ ] Repeat for an empty list, an empty or invalid key, and a network failure.
  Save must not trigger another request or require a successful Test/Get models.
- [ ] Preserve existing post-creation scopes: connection Cancel does not undo an
  independently saved model change. Keep structural validation and HTTP consent.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: saves manual and fetched draft models locally"`
- Expected red: the current first-save path loses draft model entries or blocks on network state.
- Run green: `mise run test -- --filter "provider channels: saves manual and fetched draft models locally"`
- Expected green: the reopened channel has both entries despite the rejected catalog request.

### Task 9: Guard channel switches and draft cancellation

**Seam:** S2.

**Outcome:** One confirmation controls whether to retain or discard a new draft.
Covers the channel-switch and cancel parts of AC-02 and AC-03.

**Files:** Modify `features/models/page.tsx`, `channel-draft.ts`,
`provider-editor.tsx`, `channels.test.tsx`, and both locales.

**Steps:**

- [ ] **Red:** Add `provider channels: channel switch retains draft until discard`.
  Start a populated draft while a saved channel exists. Select that saved channel,
  cancel confirmation, and expect every draft value to remain.
- [ ] **Green:** Hold the destination action until the user confirms. Discard clears
  memory and performs that action; Cancel leaves the draft and selection intact.
- [ ] Repeat for the draft's own Cancel action and for creation from the empty state.
  A never-saved discarded draft must leave no channel, credential, or models behind.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: channel switch retains draft until discard"`
- Expected red: selecting another channel replaces the draft without confirmation.
- Run green: `mise run test -- --filter "provider channels: channel switch retains draft until discard"`
- Expected green: both retention and confirmed discard produce the specified destination.

### Task 10: Guard shell navigation and repeated creation

**Seam:** S2.

**Outcome:** Settings navigation cannot remove the page before confirmation. A
second add action cannot silently replace a draft. Completes AC-03.

**Files:** Modify `app/shell.tsx`, `features/models/page.tsx`,
`channel-draft.ts`, and `channels.test.tsx`.

**Steps:**

- [ ] **Red:** Add `provider channels: leaving Models waits for discard confirmation`.
  Press `id:nav-settings` from a populated draft, cancel once, then confirm once.
- [ ] **Green:** Register the page's leave guard in the shell. Keep Models mounted
  during confirmation, clear the guard on cleanup, and invoke the destination once.
- [ ] Repeat for Add channel while a draft exists. Confirm discard before opening
  the picker. Cancelling a model dialog must not invoke this page-level guard.
- [ ] Do not add application-exit interception, persistent drafts, or global navigation state.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: leaving Models waits for discard confirmation"`
- Expected red: `selectSettings` currently changes the page immediately.
- Run green: `mise run test -- --filter "provider channels: leaving Models waits for discard confirmation"`
- Expected green: Cancel retains the draft; confirmed discard reaches Settings once.

### Task 11: Isolate pending network work from saved or discarded drafts

**Seam:** S3.

**Outcome:** Local Save never waits for catalog success, and late results cannot
change another editor. Covers AC-13.

**Files:** Modify `features/models/provider-editor.tsx`, `channel-draft.ts`,
`page.tsx`, `store.ts`, and `channels.test.tsx`.

**Steps:**

- [ ] **Red:** Add `provider channels: stale catalog cannot populate a replacement draft`.
  Delay a catalog response, discard its draft, select a different preset, then let
  the old response complete. Expect the replacement's list and status to stay intact.
- [ ] **Green:** Bind each request to its owner and input revision. Abort on discard
  and reject stale completions even when cancellation races with a response.
- [ ] Repeat for changing root/key/API during a request, switching saved channels,
  and saving while a fetch is pending. Save commits the current list, cancels that
  draft-owned fetch, and does not depend on its eventual outcome. The saved channel
  can fetch again normally. Do not add a background request queue.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: stale catalog cannot populate a replacement draft"`
- Expected red: an old completion mutates replacement state or prevents safe replacement.
- Run green: `mise run test -- --filter "provider channels: stale catalog cannot populate a replacement draft"`
- Expected green: the old result is ignored and the replacement remains usable.

### Task 12: Report partial local writes without duplicating data

**Seam:** S3; headless-only Storage fault tests.

**Outcome:** Local write failure is distinct from network rejection. Saved data can
remain, unsaved input remains available, and retry does not duplicate the channel.
Covers AC-14.

**Files:** Create `features/models/storage.test.ts`; extend the test fixtures;
modify `features/models/store.ts`, `types.ts`, `channel-draft.ts`, `page.tsx`,
`provider-editor.tsx`, `.mise/tasks/test-desktop`, and both locales.

**Steps:**

- [ ] Keep the fault suite in `storage.test.ts`, not a JSX test file. Update
  `.mise/tasks/test-desktop` to enable Bash `globstar`/`nullglob` and run the current
  UI globs `*.test.tsx` and `features/**/*.test.tsx`, forwarding arguments to each
  `nsh test "$test_file" --target "$target" "$@"` invocation. Keep automatic OS
  target selection. `mise run test` still discovers both `.test.ts` and `.test.tsx`.
- [ ] Use the declared `open(..., { modules: ... })` mechanism at the native Storage
  boundary. Start with a small headless interception probe for the imported
  `nsh` member `Storage.setItem`; verify interception before treating fault cases
  as evidence. Do not invent `storageErrors` or replace the application store.
- [ ] Back only Storage boundary methods with an isolated per-test map, seeded with
  current-format data. Reject the models write once while allowing the channel and
  credential writes. Override reads/writes consistently; provide the resulting map
  as storage to a normally reopened App when checking persisted behavior.
- [ ] **Red:** Add `provider storage: partial draft save retains unsaved models`.
  Expect an accurate error, retained model input, and one already-saved channel.
- [ ] **Green:** Apply confirmed writes to persisted state as they succeed. Retain
  the draft ID and successful channel result, retry only unsaved work through the
  normal Save action, and never show a full-success notice after partial failure.
- [ ] Repeat for a channel-write failure, credential-write failure, and delayed
  duplicate Save. Do not roll back successful data or add a persistent retry queue.
  Discarding remaining unsaved input must not delete already-saved data.

**Validation:**

- Run red: `mise run test -- --filter "provider storage: partial draft save retains unsaved models"`
- Expected red: missing partial-state handling produces lost input, false success, or duplicates.
- Run green: `mise run test -- --filter "provider storage: partial draft save retains unsaved models"`
- Expected green: the error is accurate and a normal retry yields one complete channel.
- Run this suite headless only. Native hosts reject `OpenOptions.modules` by contract.

### Task 13: Preserve consent and credential isolation in the new flow

**Seam:** S3.

**Outcome:** The picker/draft rewrite keeps existing local validation and HTTP consent
without turning remote errors into save blockers. Completes security aspects of
AC-02, AC-05, AC-08, and AC-15.

**Files:** Modify `features/models/channels.test.tsx`, `storage.test.ts`,
`connection.ts`, `provider-editor.tsx`, `store.ts`, and both locales only as needed.

**Steps:**

- [ ] **Red:** Add `provider channels: draft HTTP consent follows the current root`.
  Confirm a non-loopback HTTP root, change it to another unconfirmed HTTP root,
  and expect fresh consent before use. Test is not blocked merely because fields are dirty.
- [ ] **Green:** Keep consent tied to current normalized connection inputs. Retain
  loopback allowance, URL syntax checks, required names/IDs, and positive numeric limits.
- [ ] Retain or add regression cases proving no credential or model draft writes
  before Save, no raw credential in channel/model records, and no official-host
  fallback after a proxy error. Use dummy keys, never real credentials.
- [ ] For safeguards already passing, record regression evidence rather than inventing
  another implementation. Reopen and verify token keep/replace/clear still works.

**Validation:**

- Run red: `mise run test -- --filter "provider channels: draft HTTP consent follows the current root"`
- Expected red: the current boolean consent can carry over when the HTTP root changes.
- Run green: `mise run test -- --filter "provider channels: draft HTTP consent follows the current root"`
- Expected green: consent follows the current root; network errors still do not block Save.

### Task 14: Verify keyboard, locales, and desktop presentation

**Seam:** S2.

**Outcome:** The new flow is operable by keyboard, exposes accessible names, and
fits both supported locales and window sizes. Covers AC-16 and AC-17.

**Files:** Modify `features/models/channels.test.tsx`, UI files touched above,
`components/ui/dialog.tsx` and `input.tsx` only if a supported focus hook must be
exposed, both locales, and `docs/ui/DESIGNE.md`.

**Steps:**

- [ ] **Red:** Add `provider channels: keyboard completes the provider draft flow`.
  Use `app.keyboard.press` to select a preset, reach the draft, open a model dialog,
  dismiss it, and cancel a discard decision without losing input or focus.
- [ ] **Green:** Use semantic controls and supported focus APIs. Preserve dialog
  restoration, move focus into the draft after selection, and restore the trigger
  when the picker closes without a choice. Do not add a private focus inspection API.
- [ ] Repeat behavior checks with English and Chinese, reduced motion, and 720 × 520.
  Verify missing strings and labels through the rendered App, not YAML key counts.
- [ ] Complete the native visual and accessibility checks in Final Validation.
  A headless presence assertion does not prove focus, clipping, or screen-reader behavior.

**Validation:**

- Run red: `mise exec -- nsh test features/models/channels.test.tsx --target windows --filter "provider channels: keyboard completes the provider draft flow"`
- Expected red: the required focus or keyboard transition is missing; an unsupported
  host capability is a blocker, not a successful red-green implementation.
- Run green: `mise exec -- nsh test features/models/channels.test.tsx --target windows --filter "provider channels: keyboard completes the provider draft flow"`
- Expected green: the complete keyboard route works on the Windows host.

## Acceptance coverage

| Spec scenario | Tasks and evidence |
| --- | --- |
| AC-01 | 2–3: both entry points, five icon/name cards, picker-only content |
| AC-02 | 2, 9, 13: no draft persistence and explicit cancellation |
| AC-03 | 9–10: channel switches, shell navigation, repeated add, single draft |
| AC-04 | 3, 5: initial defaults and constrained channel/model choices |
| AC-05 | 3, 6, 13: proxy roots do not change preset or trigger host fallback |
| AC-06 | 5–6: effective APIs, shared connection, public model-route contracts |
| AC-07 | 4, 6, 8: manual/fetched entries edited in memory and committed locally |
| AC-08 | 2, 8, 13: saving without network or model verification |
| AC-09 | 1, 5: source-independent dynamic inheritance and explicit overrides |
| AC-10 | 7: model-ID identity across API and proxy changes |
| AC-11 | 7: failed fetch preservation and non-destructive missing status |
| AC-12 | 6: current-input snapshots and no sync selector |
| AC-13 | 11: pending request isolation and independent local Save |
| AC-14 | 12: native Storage failures, retained input, partial success, retry |
| AC-15 | 3, 6, 13: Custom without an implicit official URL |
| AC-16 | 14: keyboard, accessible names, focus, English and Chinese |
| AC-17 | 14 and Final Validation: native light/dark and normal/minimum layout |
| AC-18 | 2: new namespace with no legacy read, migration, or reset operation |

The spec's excluded features remain excluded: inference execution, a DeepSeek
parameter editor, per-protocol connection fields, additional presets, persistent
drafts, persistent retry queues, and legacy compatibility.

## Review and Refactoring

After the behavioral slices pass, review standards and spec coverage separately.
Delegate an independent review if an appropriate agent is available; otherwise do a
local review. Keep any cleanup behavior-preserving and rerun the affected tests.

Check state ownership, callback boundaries, stale-result handling, stable IDs,
translation coverage, and the absence of obsolete source precedence or hidden
persistent writes. Do not use the review to redesign unrelated components.

Do not mark a task or the feature complete while its required tests fail. Record an
exact blocker and next action instead. Commit completed review fixes locally.

## Final Validation

### Automated checks

1. Run `mise run verify`.
   Expected: formatting, lint, Rust/TypeScript checks, all headless tests, and the
   release bundle pass. This includes `provider storage:` and `provider routing:`.
2. Run `mise run test-desktop` after the Task 12 runner update.
   Expected: all new desktop-capable App workflows and the existing model, shell,
   navigation, language, and settings UI regressions pass on Windows.

The updated desktop task runs the current UI `.test.tsx` files. The headless-only
Storage fault suite stays in `.test.ts` and runs in `mise run verify`, alongside
pure rule and routing tests. Do not send module-replacement cases to a native host
or claim that they passed there.

Update an obsolete assertion only when it conflicts with the new spec. In
particular, replace expectations for the modal connection form, dirty-state network
blocking, a separate sync selector, source API labels, and the old storage schema.
Do not suppress failures or reduce coverage to make the final gate pass.

### Native visual and accessibility checks

Use `mise run dev` or an isolated `mise exec -- nsh test App.tsx --target windows`
session. The latter accepts App driver steps on standard input. Use
`app.setViewport`, `app.setColorScheme`, and native `app.screenshot` if automated
captures are useful; do not request screenshots from a headless engine.

Review light and dark at 1040 × 720 and 720 × 520 in English and Chinese. Cover:

- Provider picker and all five marks; right-pane draft and saved detail.
- Empty, manual, fetched, and missing model rows; model configuration dialogs.
- Default/API override controls, errors, loading, consent, and discard confirmation.
- Radius, typography, spacing, alignment, theme contrast, hover, pressed, disabled,
  selected, and visible keyboard focus states.
- Every line in the new motion inventory, including reduced motion.
- A keyboard-only creation/edit/discard flow and a Narrator pass on Windows.

Store temporary screenshots under `.nsh/tmp/provider-channels/`. Record results and
unverified items in `docs/ui/DESIGNE.md`; screenshots and passing selectors are not
a substitute for reviewing the actual rendered interface.

## Failure Behavior

- Invalid local structure: show a field-level error. No remote validation is required.
- Unusable Custom root: reject Test/Get models locally; permit configuration saving.
- Catalog rejection, timeout, or connection failure: keep the list and permit manual
  editing and Save. Retain normalized error behavior.
- Stale or cancelled request: do not update another draft, channel, or newer input revision.
- Local partial write: report the unsaved scope, retain input, and keep successful
  writes. Retry uses the same channel and model IDs.
- Leave during a never-saved draft: ask before discard; no persistent record exists.
- Leave after a partial save: discard only unsaved input, never delete confirmed writes.

## Privacy and Security

Use dummy keys and NSH's isolated test storage. Do not contact live providers or use
real credentials during automated checks. Do not add mocks of application modules.

Raw draft credentials remain in memory before Save. Persisted channel/model records
must not contain raw keys. Keep current credential separation, masking, HTTP consent,
and error normalization. Do not log keys or include them in failure messages.

The current credential implementation uses NSH Storage. Separate records are not
proof of encryption or an operating-system keychain. A secure-storage replacement
is outside this feature; report that existing limitation rather than claiming it is solved.

## Rollout Notes

The configuration contract is intentionally incompatible. The new namespace starts
without legacy channels. Do not write a migration, compatibility reader, legacy-key
cleanup, or broad storage reset. Other settings must remain unchanged.

No dependency upgrade, installation, publishing, remote write, or application-data
deletion is part of executing the tests. Release version selection is a separate decision.

## Risks and Mitigations

- **Windows keyboard support:** The existing design document records NSH 0.5.1 view
  focus limits. Probe the native route before declaring AC-16 passed. If supported
  app APIs cannot provide the required behavior, stop and report the exact limitation;
  do not silently upgrade NSH or weaken the acceptance scenario.
- **Storage fault interception:** Confirm that the declared native-module replacement
  intercepts the runtime Storage member before relying on AC-14 tests. A non-intercepted
  request is missing test evidence, not a passing failure case.
- **Provider assets:** OpenAI already has a local mark; the other three require local
  SVGs. Verify source and usage terms before copying them. Do not ship placeholder
  marks or add a new icon runtime dependency.
- **Provider routing:** One root cannot support every arbitrary proxy path scheme.
  Preserve the selected preset's rules; use Custom for standard compatible endpoints.
  Do not infer capabilities from the host or add an endpoint-template editor.
- **Inference scope:** URL-contract tests do not prove live model inference. This plan
  implements shared routing but deliberately does not add or validate an inference client.

## Open Questions

No product or test-seam decisions remain open. Native keyboard support, Storage
fault interception, and asset provenance are execution checks with explicit stop
conditions above. They must not be reported as verified before those checks run.
