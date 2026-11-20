# Implementation Plan

**Goal:** Add DeepL API as a translation preset type. When the user adds a preset, show an `AI Translation` / `DeepL API` picker before opening the existing preset editor.

**Inputs:** User request; [DeepL text translation](https://developers.deepl.com/api-reference/translate/request-translation), [authentication](https://developers.deepl.com/docs/getting-started/auth), and [language list](https://developers.deepl.com/api-reference/languages/retrieve-languages-by-resource).

**Assumptions:**

- A DeepL preset has its own user-supplied API key. Follow the Models pattern: store the key separately in local NSH Storage. This is not an encrypted credential vault. The key suffix `:fx` selects API Free; other keys use API Pro. Do not add a custom URL or account selector.
- Keep the current source and target language controls. With an automatic source and a specific target, DeepL detects the source. With an automatic target, keep the application's current target-selection rule. If it must detect the source, it uses the detector already selected in Settings (AI or Google).
- The preset type is fixed after creation. Scope is plain-text translation. No glossary, formality, document translation, AI fallback for DeepL, or Google Apps Script changes.

**Architecture:** `PresetsPage` owns picker and draft state. The store and editor branch on `engine.kind` (`ai` or `deepl`). Quick Translate uses the same cards and language controls, but sends DeepL work to a separate JSON adapter instead of the AI registry or streaming client.

**Tech Stack:** NSH TSX, `nsh/test`, NSH Storage and JSON HTTP transport, DeepL API v2, mise.

---

## File Map

| Files | Responsibility |
| --- | --- |
| Create `modules/deepl/client.ts`, `modules/deepl/languages.ts`, `modules/deepl/client.test.ts` | DeepL request, language map, and HTTP contract tests. Reuse `createJsonHttpClient` in `modules/ai/runtime/http.ts` as transport only. |
| Modify `features/presets/types.ts`, `features/presets/validation.ts`, `features/presets/store.ts`, `features/presets/store.test.ts` | Preset types, per-engine validation, credential lifecycle, and store tests. |
| Create `features/presets/add-preset-dialog.tsx`; modify `features/presets/page.tsx`, `features/presets/draft.ts`, `features/presets/editor.tsx` | Type selection, draft state, and shared editor. Use `features/models/add-channel-dialog.tsx` as the UI reference. |
| Modify `features/presets/presets.test.tsx`, `features/presets/storage-ui.test.ts` | Test picker and editor behavior. Update AI creation tests to select `AI Translation`. |
| Modify `features/quick-translate/translate.ts`, `features/quick-translate/session.ts`, `features/quick-translate/popup.tsx` | Dispatch to DeepL, apply results, and show template controls only for AI. Keep preference reconciliation in `features/quick-translate/preferences.ts` through `resolvePresetTemplate`. |
| Modify `features/quick-translate/translate.test.ts`, `features/quick-translate/popup.test.tsx`, `features/quick-translate/preferences.test.ts` | Verify DeepL execution and mixed-card behavior; retain AI-only fixture types where tests read AI fields. |
| Modify `locales/en.yml`, `locales/zh-CN.yml`, `docs/ui/DESIGNE.md` | Localize all copy. Record picker and result motion before UI edits. |

## Seams

1. `createDeepLClient({ http }).translate()` → HTTPS request and buffered translation result.
2. `createPresetsStore(...).save/load/remove/readDeepLCredential` → validation, saved records, and key lifecycle.
3. Presets page → add, choose type, edit, save, reopen, or cancel through visible controls.
4. `translateWithPreset()` and the Quick Translate popup → correct provider, translation result, and cancellation.

## Tasks

For each red/green cycle, use the same command before and after implementation. The red run must fail on the stated behavior; the green run must pass. Do not start the next cycle until that test passes.

### 1. Implement the DeepL text client

**Seam:** `createDeepLClient({ http }).translate()`.

- [ ] **Red:** In `modules/deepl/client.test.ts`, exercise a Free key, text with a newline, automatic source, and Chinese target. Expect one POST to `https://api-free.deepl.com/v2/translate`, `Authorization: DeepL-Auth-Key <key>`, and JSON `{ text: [originalText], target_lang: "ZH-HANS" }`. Expect `translations[0].text` as the result.
- [ ] **Green:** Implement the adapter using `createJsonHttpClient().postJson`. Reject redirects. Pass through the existing abort signal and timeout options. Use separate source and target maps from existing `LANGUAGE_IDS` to supported DeepL codes. Use only the intersection with DeepL's stable text languages. Confirm the exact map against the official list when implementing. Use `EN-US`, `PT-BR`, and `ZH-HANS` for the unqualified English, Portuguese, and Chinese target IDs. Do not change the shared language ID list.
- [ ] **Next cycles:** Test the Pro URL and explicit `source_lang`; an unmapped language or a serialized UTF-8 body over 128 KiB fails before HTTP; invalid responses and 403/413/429/456/5xx failures give actionable, localized errors. Do not retry automatically. Never pass through raw provider or network error details.
- [ ] **Red/green command:** `nsh test modules/deepl/client.test.ts --filter "deepl client:"`. Before each change, expect the new contract assertion to fail; after it, expect all matching tests to pass.

### 2. Save a DeepL preset without Models

**Seam:** Presets store.

- [ ] **Red:** In `features/presets/store.test.ts`, create and reload a DeepL preset with an empty Models snapshot. Confirm the preset JSON has the engine type and a credential reference, not the secret, and that `readDeepLCredential` resolves the reference.
- [ ] **Green:** Add `DeepLPresetEngine` and the corresponding save input. Use the current `presets.v1.items` envelope, with no migration. Read and validate DeepL entries independently of AI entries. Do not read the Models snapshot when saving DeepL. Validate a required trimmed key on create and reject embedded whitespace, unsupported concrete languages by role, or an attempt to change a saved preset's type. Add `removeItem` to the injected storage boundary and update the store test double and `features/quick-translate/__tests__/popup-harness.tsx`. Guard existing AI-only reads in `page.tsx`, `draft.ts`, `translate.ts`, `session.ts`, `popup.tsx`, and AI fixtures when widening the type.
- [ ] **Next cycles:** Test blank key input on edit retains the stored key; replacement uses a new credential reference; a failed record write leaves the old record and key usable; deleting a preset removes its referenced key. For replacement, write the new key first, then the record, then remove the old key. On a record write failure, remove the unused new key. For deletion, commit the record removal before removing its key. If cleanup fails, report it without undoing a committed record change or exposing a secret.
- [ ] **Red/green command:** `nsh test features/presets/store.test.ts --filter "presets store: DeepL"`. Before each change, expect the new lifecycle assertion to fail; after it, expect all matching tests to pass.

### 3. Add the chooser and edit DeepL presets

**Seam:** Presets page.

- [ ] **Red:** In `features/presets/presets.test.tsx`, press each Add Preset entry point. Expect `add-preset-dialog` and no new draft before selection. Cancel or press Escape and check that the current editor remains. Select `AI Translation` and expect the existing name input and Models section.
- [ ] **Green:** Build `AddPresetDialog` with the shared `AppDialog` and two card buttons (`preset-type-ai`, `preset-type-deepl`). Use `AI Translation` in English, `AI 翻译` in Chinese, and `DeepL API` in both locales. Follow Add Channel's focus pattern: first option on open, trigger on dismissal. On selection, close the picker first. If the current draft is dirty, use the existing discard prompt; keeping edits leaves the current draft intact. If the change proceeds, focus the new name input. Update old UI tests that previously entered the editor directly.
- [ ] **Next cycle:** Select `DeepL API` with no eligible AI model. Expect name, enabled state, and supported source/target options, a masked `preset-deepl-api-key` field, and no model, generation, or prompt controls. Save and reopen. The rail shows `DeepL API`. Reopening shows a stored-key placeholder, not the key; entering a replacement marks the draft dirty. Missing key validation focuses the key field. Reuse the existing Save, Cancel, and Delete actions. Saving does not contact DeepL.
- [ ] **Before UI edits:** In `docs/ui/DESIGNE.md`, record the reused `dialogAnimation`, `navigationFeedback`, and `pressScale`. Keep the existing keyed editor switch. For Quick Translate, record that DeepL shows loading and then the complete result, not a streaming animation. Respect existing reduced-motion behavior.
- [ ] **Red/green command:** `nsh test features/presets/presets.test.tsx --filter "presets ui: preset type"`. Before each change, expect the dialog/editor assertion to fail; after it, expect all matching tests to pass.

### 4. Use DeepL in Quick Translate

**Seam:** `translateWithPreset()` and the Quick Translate popup.

- [ ] **Red:** In `features/quick-translate/translate.test.ts`, pass a DeepL preset with automatic source and concrete target. Expect the translated result with `modelId` and `templateId` both `null`, without calling the app detector, AI model lookup, or streaming API.
- [ ] **Green:** Branch before AI template and model lookup. Fetch the credential for the DeepL preset, resolve the language pair only if the effective target is automatic, then call the buffered client. Ignore template overrides for DeepL. Keep AI results, language resolution, and fallback unchanged.
- [ ] **Next cycle:** In `features/quick-translate/popup.test.tsx`, run a DeepL card with no AI model, then a mixed action. With a specific target, give DeepL cards the shared language selections without joining the app detector. Assert that the DeepL request omits `source_lang` for an automatic source even if an AI card uses the app detector. With an automatic target, both engine types use the existing shared resolver once per action. Hide the template selector for DeepL; keep it for AI. Maintain existing retry, copy, and cancellation behavior, including ignoring results from a superseded or closed card. The source footer continues to show app-detector status only, not the provider's per-card metadata.
- [ ] **Red/green commands:** `nsh test features/quick-translate/translate.test.ts --filter "DeepL preset:"` and `nsh test features/quick-translate/popup.test.tsx --filter "DeepL card:"`. Before each change, expect the DeepL routing or card assertion to fail; after it, expect all matching tests to pass. Use NSH HTTP fixtures in tests, not fake production paths.

## Final Validation

- Run `mise run verify`. Expect formatting, lint, types, Rust tests, headless tests, and the release build to pass.
- On Windows, run `nsh test features/presets/presets.test.tsx --target windows` and `nsh test features/quick-translate/popup.test.tsx --filter "DeepL card:" --target windows`. Check the picker and editor in light and dark, at `1040 × 720` and `720 × 520`, with both locales. Check keyboard access, visible focus, Narrator, and reduced motion against the NSH finishing checklist. Report checks that could not run.
- Automated tests use no paid requests. If the user wants a real-service smoke test, use their own key in the desktop app and test with non-sensitive text.

## Failure Behavior and Privacy

- A missing key, rejected key, unsupported language, or request that is too large gives a localized recovery message. Quota, rate limiting, timeout, and service failures do not fall back to another translation provider. Cancellation does not show an error or replace a newer result.
- Do not store the key in the preset JSON, include it in logs or errors, or send it anywhere except the matching official DeepL host over HTTPS. Only send text when the user initiates translation through the existing manual or opt-in automatic mode. If the target is automatic and the source needs detection, the configured detector receives its usual text sample. Make that consequence clear next to the DeepL automatic-target control.

## Rollout and Risks

- No dependency upgrade, data migration, or service deployment. Existing AI presets keep their editor and translation behavior.
- The app's language list may change independently of DeepL's list. Use the role-specific maps in the editor, store validation, and request adapter. Reject unsupported shared-popup overrides per card rather than narrowing the global language menu.
- Local NSH Storage is not a vault, and a process exit between storage writes can leave an unreferenced key. Store replacement keys before updating references so an interrupted update does not invalidate a working preset. Treat OS-backed credential storage as a separate scope decision.

## Approval

Confirm the two product assumptions before implementation: (1) local per-preset key storage using the existing Models pattern, and (2) the existing detector policy for an automatic target. No implementation or tests start before approval.
