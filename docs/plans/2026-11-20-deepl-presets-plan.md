# Implementation Plan

**Goal:** Add `DeepL API` beside `AI Translation` in the Add Preset picker. Neither preset type stores languages. The translation entry point supplies the source and target selections, and the existing Language Detection module resolves them before translation.

**Inputs:** User request and language ownership clarification; [DeepL text translation](https://developers.deepl.com/api-reference/translate/request-translation), [authentication](https://developers.deepl.com/docs/getting-started/auth), and [language list](https://developers.deepl.com/api-reference/languages/retrieve-languages-by-resource).

**Assumptions:**

- Quick Translate restores its own saved source and target selections. Each missing selection defaults to Automatic. No preset supplies default languages. Switching, adding, or removing cards does not change the popup's language selections.
- A DeepL preset has its own user-supplied API key. Follow the Models pattern: store the key separately in local NSH Storage. This is not an encrypted credential vault. A key that ends with `:fx` selects API Free; other keys use API Pro. Do not add a custom URL or account selector.
- The preset type is fixed after creation. Scope is plain-text translation. No glossary, formality, document translation, AI fallback for DeepL, or Google Apps Script changes.

**Architecture:** `PresetsPage` owns the picker and draft; presets store engine configuration only. Quick Translate owns the language selections and calls `resolveTranslationLanguages` from `features/language-detection/resolve.ts` once per action for all active cards. It passes the resolved pair to the AI prompt renderer or the DeepL adapter. Neither engine detects the language on its own.

**Tech Stack:** NSH TSX, `nsh/test`, NSH Storage and JSON HTTP transport, DeepL API v2, mise.

---

## File Map

| Files | Responsibility |
| --- | --- |
| `features/quick-translate/session.ts`, `features/quick-translate/translate.ts`, `features/quick-translate/popup.tsx` | Restore popup languages, resolve one pair per action, dispatch to the preset engine, and show template controls only for AI. |
| `features/quick-translate/popup.test.tsx`, `features/quick-translate/translate.test.ts`, `features/quick-translate/preferences.test.ts`, `features/quick-translate/__tests__/translate-app.tsx`, `features/quick-translate/__tests__/popup-harness.tsx` | Verify popup preferences, shared detection, and provider requests. Set languages in caller fixtures, not preset fixtures. |
| `features/presets/types.ts`, `features/presets/validation.ts`, `features/presets/store.ts`, `features/presets/store.test.ts` | Remove preset language fields. Add the DeepL engine and credential lifecycle. |
| Create `features/presets/add-preset-dialog.tsx`; modify `features/presets/page.tsx`, `features/presets/draft.ts`, `features/presets/editor.tsx`, `features/presets/presets.test.tsx`, `features/presets/storage-ui.test.ts`, `features/presets/temperature-paste.test.ts` | Remove preset language controls; add the picker and DeepL key field. Use `features/models/add-channel-dialog.tsx` as the UI reference. |
| Create `modules/deepl/client.ts`, `modules/deepl/languages.ts`, `modules/deepl/client.test.ts` | Map the resolved languages to DeepL codes and send the text request. Reuse `createJsonHttpClient` in `modules/ai/runtime/http.ts` as transport only. |
| `locales/en.yml`, `locales/zh-CN.yml`, `docs/ui/DESIGNE.md` | Localize the new controls and errors, remove preset-only language labels, and record motion before UI edits. Keep the shared language IDs and labels used by Quick Translate and Language Detection. |

## Seams

1. Quick Translate popup → restore its own languages, resolve the pair once per action, and show translation results or errors.
2. Presets page → add, choose a type, edit, save, reopen, or cancel through visible controls.
3. `createPresetsStore(...).save/load/remove/readDeepLCredential` → record and credential lifecycle.
4. `createDeepLClient({ http }).translate()` → HTTPS request and buffered translation result.
5. `translateWithPreset()` → use a resolved language pair and route to the correct provider.

## Tasks

For each red/green cycle, run the same command before and after implementation. Expect the new assertion to fail first and all matching tests to pass after each change.

### 1. Make Quick Translate own its language selections

**Seam:** Quick Translate popup.

- [ ] **Red:** In `features/quick-translate/popup.test.tsx`, open Quick Translate with no saved popup languages and a preset that has different legacy language values. Expect both selections to default to Automatic. In the next cycle, assert that the popup restores a saved pair even when there are no enabled presets. Add a regression check that switching presets preserves the pair and uses it in the next request.
- [ ] **Green:** In `features/quick-translate/session.ts`, remove `seedPreset` and `resolveInitialPresetLanguages` from language initialization. Use saved `quickTranslate.preferences.v1` selections, with `AUTO_LANGUAGE` for each missing value. Restore selections independently of card selection. Leave the picker and preferences format unchanged.
- [ ] **Update the execution boundary:** Keep the existing shared resolver in `session.ts`. Require concrete `LanguageId` values in `translateWithPreset()` and remove its duplicate resolver and detector-specific options. Quick Translate resolves the pair before execution; any other caller must do the same. Use `features/quick-translate/__tests__/translate-app.tsx` and `features/quick-translate/translate.test.ts` to retain coverage for AI prompts with an explicit pair. Keep automatic behavior tests at the popup and existing resolver seam. Seed popup preferences in existing tests that previously took their languages from the preset.
- [ ] **Red/green command:** `nsh test features/quick-translate/popup.test.tsx --filter "quick languages:"`. Expect the popup to stop using preset languages. Regress with `nsh test features/quick-translate/translate.test.ts` and `nsh test features/language-detection/resolve.test.ts`.

### 2. Remove language controls from the preset editor

**Seam:** Presets page.

- [ ] **Red:** In `features/presets/presets.test.tsx`, open an existing AI preset and a new AI draft. Assert that neither shows source or target language controls. Confirm the editor still shows name, enabled state, Models, and prompt templates, and can save without a language selection.
- [ ] **Green:** Remove the Languages card from `features/presets/editor.tsx` and retire its preset-only strings in `locales/en.yml` and `locales/zh-CN.yml`. Keep AI prompt variables `{{source_language}}` and `{{target_language}}`: `translateWithPreset()` fills them from the caller's resolved pair. Update the Presets section in `docs/ui/DESIGNE.md` before UI edits.
- [ ] **Red/green command:** `nsh test features/presets/presets.test.tsx --filter "presets ui: no languages"`. Expect language controls to disappear without changing AI model or prompt controls.

### 3. Store engine configuration, not languages

**Seam:** Presets store.

- [ ] **Red:** In `features/presets/store.test.ts`, save and reload an AI preset. Assert that neither the returned record nor its stored JSON contains `sourceLanguage` or `targetLanguage`.
- [ ] **Green:** Remove both fields from `TranslationPreset`, `SavePresetInput`, `PresetDraft`, and their validation and dirty-check paths. Keep the `presets.v1.items` envelope: validate only fields that the app still uses, and write only the supported fields for readable records. Ignore any old language values; never copy them into Quick Translate preferences. No migration job. Update unreadable-entry tests in `store.test.ts` and `storage-ui.test.ts` to use a malformed field that the store still needs. Leave unreadable records untouched.
- [ ] **Next cycle:** Create and reload a DeepL preset with no AI models. Add `DeepLPresetEngine` and a matching save input. Store the engine type and a reference, not the secret. Do not read the Models snapshot when saving DeepL. Require a trimmed key on create, reject embedded whitespace, and reject type changes on saved presets. Add `removeItem` to the injected storage boundary; update test doubles including `features/quick-translate/__tests__/popup-harness.tsx`. Guard AI-only engine reads and fixtures when widening `PresetEngine`.
- [ ] **Credential cycles:** Test that a blank input on edit retains the key, replacement uses a new reference, failure to write the record leaves the old record and key usable, and delete removes the referenced key. Write a new key before its record. After successful replacement or delete, remove the old key. If a record write fails, remove the unused new key. Report cleanup failures without undoing a committed record change or exposing a secret.
- [ ] **Red/green command:** `nsh test features/presets/store.test.ts --filter "presets store: engine data"`. Expect saved records to omit languages and the DeepL key lifecycle to pass.

### 4. Implement the DeepL text client

**Seam:** `createDeepLClient({ http }).translate()`.

- [ ] **Red:** In `modules/deepl/client.test.ts`, send a Free key, text with a newline, English source, and Chinese target. Expect one POST to `https://api-free.deepl.com/v2/translate`, `Authorization: DeepL-Auth-Key <key>`, and JSON `{ text: [originalText], source_lang: "EN", target_lang: "ZH-HANS" }`. Expect `translations[0].text` as the result.
- [ ] **Green:** Implement the adapter using `createJsonHttpClient().postJson`. Reject redirects and pass through the abort signal and timeout. Use separate source and target maps for the intersection of existing `LANGUAGE_IDS` and DeepL's stable text languages. Verify the map against the official list. Map unqualified English, Portuguese, and Chinese targets to `EN-US`, `PT-BR`, and `ZH-HANS`. Both request fields are required by the adapter; never omit `source_lang` to trigger provider-side detection.
- [ ] **Next cycles:** Test the Pro URL, unmapped languages, and the 128 KiB serialized UTF-8 limit. Reject unmapped languages and oversized bodies before HTTP. Give localized errors for invalid responses and 403/413/429/456/5xx. Do not retry automatically or show raw error details.
- [ ] **Red/green command:** `nsh test modules/deepl/client.test.ts --filter "deepl client:"`. Expect both language fields on every request and no request for unsupported input.

### 5. Add the type picker and DeepL editor

**Seam:** Presets page.

- [ ] **Red:** In `features/presets/presets.test.tsx`, use each Add Preset entry point. Expect `add-preset-dialog`, with no new draft until selection. Cancel or press Escape to leave the current editor unchanged. Select `AI Translation` to open the existing editor without a Languages card.
- [ ] **Green:** Build `AddPresetDialog` with `AppDialog` and two card buttons (`preset-type-ai`, `preset-type-deepl`). Use `AI Translation` in English, `AI 翻译` in Chinese, and `DeepL API` in both locales. Focus the first option on open and return focus to the trigger on dismissal. Close the picker before invoking the existing discard prompt for a dirty draft. Keeping edits leaves the current draft intact. Focus the new name input when creation proceeds. Update tests that previously entered the editor directly.
- [ ] **Next cycle:** Select `DeepL API` with no eligible AI model. Expect name, enabled state, and a masked `preset-deepl-api-key` field. Do not show languages, models, generation parameters, or prompt templates. Save and reopen. The rail shows `DeepL API`. The editor shows a stored-key placeholder, not the key. A replacement marks the draft dirty. Missing key validation focuses the key field. Saving does not contact DeepL.
- [ ] **Before UI edits:** Record the reused `dialogAnimation`, `navigationFeedback`, and `pressScale` in `docs/ui/DESIGNE.md`. Keep the existing keyed editor switch and reduced-motion behavior.
- [ ] **Red/green command:** `nsh test features/presets/presets.test.tsx --filter "presets ui: preset type"`. Expect both entry points to use the picker and each type to open the correct form.

### 6. Use the same resolved pair for AI and DeepL

**Seams:** `translateWithPreset()` and Quick Translate popup. Run one cycle at each seam.

- [ ] **Execution cycle:** In `features/quick-translate/translate.test.ts`, expect a DeepL preset to use the supplied pair and stored key and return the full text without AI model lookup, prompt rendering, or streaming. Implement the DeepL branch in `translate.ts`. Set DeepL result `modelId` and `templateId` to `null`. AI prompts, streaming, and fallback stay unchanged.
- [ ] **Popup cycle:** In `features/quick-translate/popup.test.tsx`, run an action with one AI card and one DeepL card, an automatic source, and a specific target. Expect one request to the configured detector, followed by requests to both translation engines with the same resolved pair. DeepL must receive `source_lang`. Use the same shared path for automatic targets. With both selections explicit, neither engine calls a detector. When detection is off or fails, show the existing recovery message and make no translation request. Do not fall back to DeepL detection. Test a DeepL-only action with both languages selected and no AI models.
- [ ] **Card controls:** Hide the template selector for DeepL and ignore old template overrides for those cards. Keep AI template selection, retry, copy, and cancellation. Ignore stale results after a newer action or after a card or popup closes. Record DeepL's loading-to-result change in `docs/ui/DESIGNE.md` before UI edits: show the complete result without a streaming animation.
- [ ] **Red/green commands:** `nsh test features/quick-translate/translate.test.ts --filter "DeepL preset:"` and `nsh test features/quick-translate/popup.test.tsx --filter "DeepL card:"`. Use NSH HTTP fixtures. Expect detection failures to block both engines, with no DeepL-specific detection path.

## Final Validation

- Run `mise run verify`. Expect formatting, lint, type checks, tests, and the release build to pass.
- On Windows, run `nsh test features/presets/presets.test.tsx --target windows`, `nsh test features/quick-translate/popup.test.tsx --filter "quick languages:" --target windows`, and `nsh test features/quick-translate/popup.test.tsx --filter "DeepL card:" --target windows`. Check the picker and editor in light and dark, at `1040 × 720` and `720 × 520`, with both locales. Check keyboard access, visible focus, Narrator, and reduced motion against the NSH finishing checklist. Report checks that could not run.
- Automated tests make no paid requests. If the user requests a real-service check, use their own key in the desktop app with non-sensitive text.

## Failure Behavior and Privacy

- The Language Detection module keeps its current rules: two explicit languages need no detector; an automatic source uses the saved detection mode; an automatic target uses the native and preferred language settings. Detection off, detection failure, or missing settings produce the existing recovery messages. Do not translate with a guessed language.
- An unsupported DeepL language fails only that card. Keep the shared language menu unchanged so AI cards can still use the same selection. A missing key, rejected key, oversized request, quota limit, timeout, or service failure gives a localized message. Do not use another provider as a fallback. Cancellation does not show an error or replace a newer result.
- Do not include the key in preset JSON, logs, or errors. Send it only to the matching official DeepL host over HTTPS. When an automatic source needs detection, only the configured detector receives its usual text sample, as it does today. The DeepL translation request contains the original text and the resolved language codes.

## Rollout and Risks

- No dependency upgrade, service deployment, or migration job. Old preset language values are ignored. The source and target are both Automatic when Quick Translate has no saved selections. If detection or the required language preferences are not configured, the user can select both languages directly in Quick Translate.
- DeepL and the app can change their supported language lists independently. Keep provider-specific codes and checks in the adapter, not in presets or the shared language detection module.
- Local NSH Storage is not a vault. A process exit between storage writes can leave an unreferenced key. Write new keys before updating references so that an interrupted replacement does not invalidate a working preset. OS-backed credential storage is out of scope unless requested.

## Approval

Confirm the revised plan and the remaining assumption about local per-preset API key storage before implementation. Do not change feature code or tests before approval.
