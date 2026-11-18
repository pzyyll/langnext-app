# Implementation Plan: Translation Presets

**Goal:** Add a main-window workspace for managing AI translation presets with an ordered model fallback list and multiple named prompt templates.

**Inputs:** The approved Presets scope (management first, with LangNext model fallback and multiple prompt templates); [System Architecture](../specs/system-architecture.md); [Provider Channels](../specs/provider-channels.md); [AI Modules](../specs/ai-modules.md); [Design System](../ui/DESIGNE.md). The local `langnext-app` reference is `src/routes/translate/profiles.tsx`, `src/routes/translate/-languages.ts`, and `src-tauri/src/services/translation_profiles.rs`.

**Assumptions:**

- This plan does not authorize implementation. Confirm the plan and test seams before writing code or tests.
- Ship only AI presets in this phase. Do not add a Translate or Test action, inference, fallback execution, a quick-translation window, language detection, the LangNext automatic target rule, a global default preset, import/export, or a traditional API integration or placeholder. DeepL and Google Cloud are future engine types, not Models channels.
- Borrow LangNext's behavior and language IDs. Reimplement it with the existing NSH controls and Store patterns, not React, Tauri, SQLite, or a plugin host.

**Architecture:** The Presets Store owns saved records in NSH Storage. `PresetsPage` owns selection and the current draft; `Models` remains the source of model and channel data. A preset stores model IDs and translation settings only. The record has an engine discriminator so a later service engine can have a separate configuration without changing the AI fields.

**Tech Stack:** TypeScript/TSX, NSH signals and Storage, `nsh/test`, existing theme tokens and UI controls, `nsh/i18n`, and mise.

---

## Behavior and data contract

| Area | Phase-one rule |
| --- | --- |
| Workspace | Add **Presets** below **Models** in the sidebar. Keep Models as the startup page and Settings at the bottom. Use `PageSurface` in split mode: a list on the left and a scrollable editor on the right. Align the pane headers with Models. The editor sections are **Languages**, **Models and parameters**, and **Prompt templates**. Show the name, enabled state, and model summary in the list. |
| Lifecycle | Create an unsaved draft with no model selected and one default prompt. Edit the name, enabled state, and all other fields in the draft. One explicit **Save** commits the full preset. **Cancel** restores the saved record or closes a new draft. Confirm before discarding edits on Cancel, switching presets, creating another preset, or leaving the page. Confirm deletion separately; deleting a preset also deletes its unsaved edits, but not any model or channel. |
| Selection | Select the first saved preset when the page opens. After create or update, select the saved preset. After delete, select the next item, the previous item if there is no next item, or show the empty state. Keep list order by creation; edits do not move a row. Key editor instances by preset ID or new-draft ID, not by list index. Selecting a template inside the same preset does not discard edits or make the preset dirty. |
| Common fields | `id`, `name`, `enabled`, `sourceLanguage`, `targetLanguage`, `createdAt`, `updatedAt`, `engine`. Use stable IDs and ISO timestamps. Trim names; reject empty names. New presets are enabled; source defaults to `auto`; target defaults to `null` (**No preference**). Store concrete language IDs from the LangNext language list, not UI labels. A target cannot be `auto`; the page does not resolve language preferences. |
| AI engine | `kind: "ai"`, `modelIds`, `temperature`, `maxOutputTokens`, `templates`, `defaultTemplateId`. `modelIds[0]` is the required primary; subsequent IDs are unique fallbacks, used in exactly that order by a future runtime. Add/replace/remove fallbacks and move them up/down, with boundary moves disabled. Never allow the primary in the fallback list or two fallbacks with the same ID. No implicit fallback or model selection. |
| Model availability | Offer enabled text-capable models from enabled channels. Exclude models marked `missing` and models whose provider or effective API protocol is unsupported. Use the model's API override or the channel's default, never the discovery source. Label choices **Channel · Model**. Credentials do not determine picker eligibility; the page never checks connectivity. |
| Stale bindings | Keep a saved binding if it becomes unavailable. Show its current label when known and an unavailable reason; do not expose a missing record's raw ID as its label. An existing unavailable primary can remain in the primary slot; existing unavailable fallbacks can remain or move within the fallback list. Users can edit other fields and save without losing these references. A new or changed primary or a newly added fallback must be available at Save time. Show **Manage Models** when no model can be selected; route it through the same leave guard. |
| Parameters | Both fields are optional; blank stores `null`, with no numeric runtime default written by the editor. A nonblank temperature must be a finite nonnegative decimal. A nonblank output limit must be a positive safe integer. Validate the entire input; do not truncate or clamp. Protocol-specific limits and effective defaults belong to the future runtime. |
| Prompt templates | Each template has `id`, `name`, `systemTemplate`, and `userTemplate`. A preset has at least one. The user can add, select, rename, edit, set as default, or remove a template. Display a **Default** badge on exactly one template. Remove only nondefault templates; if the user wants to remove the default, they must first choose another default. Preserve template order and text (including line breaks). Save the templates and default ID together. |
| Prompt variables | Seed a ready-to-edit template whose system message names the source and target and requests translation only, and whose user message contains `{{text}}`. Show the supported variables beside the fields: `{{source_language}}`, `{{target_language}}`, and `{{text}}`. As in the LangNext writer, accept surrounding whitespace inside braces, reject unknown or unclosed `{{…}}` tokens, and require exactly one `{{text}}` in the User Prompt. Allow a blank System Prompt. Validate all templates on Save, not just the selected one. |
| Storage | Use `presets.v1.items` for one `{ version: 1, items: TranslationPreset[] }` record. A missing key means an empty list. Reject malformed data or an unsupported version without overwriting it. Use one `Storage.setItem` per mutation and publish only on success. Prevent overlapping mutations and changes to the draft while a mutation is pending. Keep Models keys and the credential store unchanged. |

## File map

| Change | Path | Responsibility |
| --- | --- | --- |
| Create | `features/presets/types.ts`, `features/presets/languages.ts`, `features/presets/validation.ts` | Record and draft input types, fixed language IDs, and validation for Save. |
| Create | `features/presets/store.ts` | `createPresetsStore(storage, readModelChoices)` with `load()`, `records()`, `status()`, `save(input)`, and `remove(id)`; injected `readModelChoices()` supplies the IDs available for new bindings, or no choices while Models is unreadable. The production instance uses NSH Storage and the model choices below. `status()` reports idle, loading, ready, or a load error. Expected write and validation errors include a stable error key and, when applicable, a field or template ID. |
| Create | `features/presets/model-choices.ts` | Read Models state and the AI registry. Derive picker options and unavailable reasons. Reuse `features/models/model-helpers.ts` for the display name, effective capabilities, and effective API type. No credentials or network calls. |
| Create | `features/presets/page.tsx`, `editor.tsx`, `models-section.tsx`, `prompt-templates.tsx` (all under `features/presets/`) | Page owner and guard; preset editor and controlled sections. Only the owner holds the draft, validation state, and selection IDs. |
| Create | `components/ui/textarea.tsx`, `components/layout/navigation-leave-guard.ts` | Shared styled multiline field over `nsh/base` Input with `multiline` and `submitBehavior="newline"`; move the existing `NavigationLeaveGuard` type to a shared path. |
| Modify | `app/shell.tsx`, `components/sidebar.tsx`, `features/models/page.tsx` | Add the sidebar destination and shared guard registration. Keep Models guard behavior unchanged. Load presets on first page entry; keep the Store alive across visits. |
| Modify | `locales/en.yml`, `locales/zh-CN.yml`, `docs/ui/DESIGNE.md` | Add copy, accessible names, language labels, and initial prompt text in both locales. Read shipped strings through `t()`; store prompt text once when the template is created. Record split layout and motion before coding the screen; add verification results after. |
| Test | `features/presets/store.test.ts`, `features/presets/presets.test.tsx`, `features/presets/storage-ui.test.ts`, `App.test.tsx` | Store contract, real workspace actions, headless Storage failures, and shell navigation. Reuse fixtures from `features/models/__tests__/fixtures.ts`. |

## Test seams

- **S1 — Presets Store:** Call `load`, `save`, and `remove` through `createPresetsStore`. Supply Storage I/O and a current model-choice snapshot as inputs; assert results and the records exposed by the Store. Do not test validators or draft internals in isolation.
- **S2 — AppShell navigation:** Open `App.tsx` and use the real sidebar. Assert the current page, visible dialogs, and navigation outcome.
- **S3 — Presets workspace:** Open `App.tsx` with seeded Models data. Use visible controls and reopen with persisted state to verify what was saved. Stub only external boundaries. Do not replace the Store, Models, or editor. Put tests that require `OpenOptions.modules` in `features/presets/storage-ui.test.ts`; do not pass that option to a desktop run. Seed `settings.language` with `en` in tests that assert English labels.

## Tasks

Run the tasks in order. For each bullet marked **Red → Green**, write one test, run its exact command and observe the stated behavioral failure, then implement the smallest change and rerun the same command. Use a callable scaffold only if needed to reach the behavior. A missing import, runner error, or zero matching tests is not Red. Commit each completed implementation task locally. Run `mise run verify` before starting and record any unrelated baseline failures.

### 1. Persist one preset and protect saved records

**Seam:** S1. **Files:** `types.ts`, `languages.ts`, `validation.ts`, `store.ts`, `store.test.ts` under `features/presets/`.

- [ ] **Red → Green:** `mise run test -- --filter "presets store: restores a saved preset"`. Red: a new Store on the same Storage cannot reload the saved ID and fields. Green: can create, update without changing ID or `createdAt`, and reload. Start with one AI model and one valid template.
- [ ] **Red → Green:** `mise run test -- --filter "presets store: keeps saved data on write failure"`. Red: a rejected save changes the exposed record or gives no write error. Green: the previous record remains visible and retry commits the same edited record once.
- [ ] **Red → Green:** `mise run test -- --filter "presets store: keeps unreadable storage"`. Red: malformed or unsupported data looks empty or can be overwritten. Green: show a load error, refuse mutations until a successful load, and keep the stored value untouched. Run malformed data and unsupported version as separate cycles under this filter.

### 2. Open Presets from the main window and save a draft

**Seams:** S2 for navigation, then S3 for creation. **Files:** `app/shell.tsx`, `components/sidebar.tsx`, `features/models/page.tsx`, `components/layout/navigation-leave-guard.ts`, `features/presets/{page.tsx,editor.tsx,model-choices.ts,presets.test.tsx,storage-ui.test.ts}`, `locales/en.yml`, `locales/zh-CN.yml`, `docs/ui/DESIGNE.md`, `App.test.tsx`.

- [ ] Before screen code, record the layout, focus paths, and motion in `docs/ui/DESIGNE.md`. Reuse Models pane sizes and responsive spacing. Use a virtualized NSH `List` keyed by preset ID for the rail and one `Scroll` for the editor. Reuse the shared button, card, input, select, switch, badge, and dialog components. The sidebar can reuse `assets/icons/file-text.svg` with the standard selected wash.
- [ ] **Red → Green:** `mise run test -- --filter "presets nav: opens the workspace from Models"`. Red: there is no Presets destination. Green: Models still opens first; Presets mounts once when selected and renders the empty state.
- [ ] **Red → Green:** `mise run test -- --filter "presets storage UI: retries a failed load"`. Red: a rejected Storage read is shown as an empty list or has no recovery. Green: display the load error, disable creation while storage is unreadable, and reload successfully with **Retry** when the external read succeeds.
- [ ] **Red → Green:** `mise run test -- --filter "presets ui: saves a new preset"`. Red: Add cannot save a named preset with a chosen primary. Green: a new editor focuses the name; the user selects a model from Models, chooses language preferences, edits the enabled state, and saves. Reopen and confirm the selected fields, one default template, and no HTTP request. With no eligible models, keep Save unavailable for a new preset and provide **Manage Models**.
- [ ] Use visible field labels and localized accessibility names. For the narrow layout, stack the field pairs and keep Save/Cancel and destructive actions visible without horizontal scrolling. Use identifiers such as `nav-presets`, `presets-page`, `preset-name`, and `preset-save` for stable test targets.

### 3. Manage the ordered model list and optional parameters

**Seams:** S1 for write rules, S3 for model choices and editing. **Files:** `features/presets/{model-choices.ts,models-section.tsx,editor.tsx,validation.ts,store.ts,store.test.ts,presets.test.tsx}` and both locale files.

- [ ] **Red → Green:** `mise run test -- --filter "presets store: validates model order and parameters"`. Red: a duplicate model, invalid new binding, or invalid numeric input can be saved. Green: the Store rejects each invalid case without changing the last saved record, preserves explicit order, and stores blank numeric fields as `null`. Run each scenario as a separate cycle. Include `0` for temperature, `4096` for a valid output limit, and rejection of `0`, `1.5`, and `12x` for the output limit.
- [ ] **Red → Green:** `mise run test -- --filter "presets ui: reorders fallbacks and restores them"`. Red: no reorder action or order is lost after reopen. Green: start with primary A and fallbacks B, C; move C up, save, and reopen to observe A, C, B. Cover replacement, removal, duplicate exclusion, and boundary moves in separate cycles under the same filter.
- [ ] **Red → Green:** `mise run test -- --filter "presets ui: retains unavailable bindings"`. Red: an unavailable binding disappears, silently changes, or prevents an unrelated edit. Green: a disabled channel, disabled/missing model, deleted model, or unsupported effective protocol is excluded from new selections; a previously saved unavailable binding remains visible and survives a rename. Replacing a stale primary with an available model and removing a stale fallback clear their warnings. Use separate cycles for the availability cases. Do not treat a Models load error as an empty catalog; keep bindings visible and make recovery available from Models.

### 4. Manage multiple named prompts and a default

**Seams:** S1 for template validation, then S3 for editing. **Files:** `features/presets/{prompt-templates.tsx,editor.tsx,validation.ts,store.test.ts,presets.test.tsx}`, `components/ui/textarea.tsx`, and both locale files.

- [ ] **Red → Green:** `mise run test -- --filter "presets store: validates every prompt template"`. Red: a default ID outside the preset or an invalid template is accepted. Green: reject empty lists, duplicate IDs, blank names, dangling default IDs, malformed variables, and User Prompts with no `{{text}}` or two occurrences. Use separate test cycles. Preserve valid text and line breaks without trimming the prompt body.
- [ ] **Red → Green:** `mise run test -- --filter "presets ui: saves multiple prompts and the chosen default"`. Red: a second template, its edited content, or its default designation is lost. Green: add and rename a template, type multiline System and User Prompts, set it as default, and reopen to verify both templates, exact text, and one default badge. Keep local edits when switching templates. Key the multiline inputs by template ID. Make Enter insert a new line in both prompt fields, not save.
- [ ] **Red → Green:** `mise run test -- --filter "presets ui: removes only a nondefault prompt"`. Red: the current default can be removed or a removed nondefault template returns after Save. Green: the current default cannot be removed; choose a different default, remove the former default, and verify the saved result. Template removal is only a draft change until Save.

### 5. Protect edits and finish the deletion flow

**Seams:** S1 for deletion persistence, S2 and S3 for guard and focus behavior. **Files:** `features/presets/{page.tsx,editor.tsx,store.ts,store.test.ts,presets.test.tsx,storage-ui.test.ts}`, `app/shell.tsx`, `App.test.tsx`, and both locale files.

- [ ] **Red → Green:** `mise run test -- --filter "presets ui: guards dirty navigation"`. Red: switching the selected preset, adding, leaving the workspace, or pressing Cancel loses a dirty draft without confirmation. Green: **Keep Editing** or Escape keeps all edits and restores focus; **Discard** performs only the pending action. No dialog for a clean saved editor. Test each destination separately, including **Manage Models**. A pending write blocks leaving until it settles.
- [ ] **Red → Green:** `mise run test -- --filter "presets store: removes only the requested preset"`. Red: removal is not persisted or a rejected removal alters the list. Green: remove only the requested ID, reload successfully, and leave the previous records intact on write failure. Use separate cycles.
- [ ] **Red → Green:** `mise run test -- --filter "presets ui: confirms delete and selects the next preset"`. Red: deletion does not require confirmation or leaves the editor on a removed record. Green: Cancel preserves the record; Confirm removes it, focuses the next or previous row, or focuses **Add Preset** in the empty state.
- [ ] **Red → Green:** `mise run test -- --filter "presets storage UI: preserves edits after a failed write"`. Red: a rejected write loses the draft or appears successful. Green: a failed save keeps edits and a failed delete keeps the saved record and selection; both show localized, retryable errors. Use separate cycles and reject only the preset write at the Storage boundary.

## Motion and desktop verification

Record the final inventory in `docs/ui/DESIGNE.md` before screen code. Use `pageEnter` for the workspace, `navigationFeedback` for row selection and control states, `pressScale` for buttons, `switchThumb` for enabled state, `popup` for selects, and `dialogAnimation` for confirmations. Swap editors immediately to avoid showing values from the wrong preset. Change the template selection, order, default badge, and Saving label immediately so feedback matches state; do not add drag, continuous animation, or streaming. All transitions honor reduced motion.

- [ ] Run `mise run verify`. Expect formatting, lint, type checks, the complete headless suite, and the release bundle to pass.
- [ ] On Windows, run `mise exec -- nsh test features/presets/presets.test.tsx --target windows` and `mise exec -- nsh test App.test.tsx --target windows --filter "presets nav:"`. Expect the new screen and shell navigation cases to pass in a native window.
- [ ] Run `mise run dev`. Inspect Light and Dark at `1040 × 720` and `720 × 520`, in English and Simplified Chinese. Cover empty, filled, unavailable-model, multiline, validation-error, and confirmation states. Check radius, typography, spacing, alignment, contrast, hover/pressed/focus, and each motion line with reduced motion on and off. Walk Add → model selection → fallback reorder → template edit → Save → delete by keyboard and check labels and focus with Narrator. Record any platform limit instead of marking an unverified check as passed.

## Safety and rollout

- All configuration is local. Never read or copy credentials, Base URLs, or model metadata into preset storage; store only model IDs. Do not log prompt content or send it over the network. Preset text is not a place to enter secrets.
- On save/delete failure, keep the last saved state and any applicable edits. Show a localized message near the failed action. Focus the first invalid field on validation failure; if it is in another template, select that template first. On read failure, show **Retry** and do not create a new empty collection over the old value.
- There is no migration from LangNext or change to existing Models data. No preset is created until the user saves one. No runtime or traditional API work is needed to ship this phase.

**Open questions:** None for drafting this plan. The assumptions and test seams above are subject to approval before implementation.
