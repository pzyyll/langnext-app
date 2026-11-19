# Implementation Plan

**Goal:** Add one language detector for My Translator, with an opt-in AI model chain and a user-defined rule for automatic translation targets.

**Inputs:** Mr. Julian's language detection requirements; `docs/specs/system-architecture.md`; `docs/ui/DESIGNE.md`; the current Settings, Models, Presets, and Quick Translate code.

**Assumptions:**

- AI detection is off until the user selects **AI**, assigns a primary model, and saves. No model or language preference is selected for the user. When detection is off or fails, an automatic source needs manual selection; the translation model does not detect it as a fallback.
- The native language and preferred translation language are independent of the interface language. **Automatic** target requires a native language. It requires a preferred translation language only when the source is in the native language. If both are set, they must be different.
- A preset and the Quick Translate popup can both select **Automatic** as the target. Replace the preset's **No preference** option with **Automatic**. This is a Demo-stage schema change; no legacy data migration is in scope.

**Architecture:** A shared store owns the detection mode, model order, and language preferences. A TS service detects the source with the saved AI model chain, then resolves concrete languages before Quick Translate renders a prompt. Preset and popup choices use the same language IDs. A popup action that translates several cards shares one language-resolution run.

**Tech Stack:** NSH Mixed 0.6.0, TS/TSX, NSH Storage, `nsh/test`, mise, existing AI client and protocol adapters. No native or dependency changes.

---

## Behavior

| Source selection | Target selection | Expected behavior |
| --- | --- | --- |
| Concrete | Concrete | Use both choices. No detection request. |
| Concrete | Automatic | Use the source choice to calculate the target. No detection request. |
| Automatic | Concrete | Detect the source once; use the chosen target. |
| Automatic | Automatic | Detect the source once; calculate the target from the detected language. |

For **Automatic** target: if the source is not in the native language, translate into the native language. If the source is in the native language, translate into the preferred translation language. For native `zh` and preferred `en`: `en → zh`, `fr → zh`, and `zh → en`. Always honor a concrete target. **Automatic** target is different from the popup's **Auto-translate** toggle, which controls when requests start.

Only AI detection is in scope. Do not add local detection, detection on clipboard changes outside the current translation triggers, a persistent detection cache, or a detected-language badge.

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create and test | `features/language-detection/settings.ts`, `features/language-detection/settings.test.ts` | Typed, versioned preferences and save behavior. |
| Create and test | `features/language-detection/detect.ts`, `features/language-detection/detect.test.ts` | AI request, response validation, model fallback, and cancellation. |
| Create and test | `features/language-detection/resolve.ts`, `features/language-detection/resolve.test.ts` | Turn source and target selections into concrete IDs. |
| Create | `features/settings/language-detection-section.tsx` | Detection mode, ordered model controls, and language preference form. |
| Modify and test | `features/settings/page.tsx`, `features/settings/settings.test.tsx`, `App.tsx`, `app/shell.tsx` | Settings category, startup load, Models navigation, and integration tests. |
| Modify and test | `features/presets/languages.ts`, `features/presets/types.ts`, `features/presets/draft.ts`, `features/presets/editor.tsx`, `features/presets/presets.test.tsx`, `features/presets/store.test.ts` | Shared language IDs and automatic target persistence. Store and save validation already use `isTargetLanguageId`. |
| Modify and test | `features/quick-translate/translate.ts`, `features/quick-translate/translate.test.ts` | Resolve languages before rendering prompts; check outbound translation requests. |
| Modify and test | `features/quick-translate/popup.tsx`, `features/quick-translate/preferences.ts`, `features/quick-translate/preferences.test.ts`, `features/quick-translate/popup.test.tsx`, `features/quick-translate/__tests__/popup-harness.tsx` | Select and restore automatic target, share a detection run, and manage cancellation. |
| Modify | `locales/en.yml`, `locales/zh-CN.yml`, `docs/ui/DESIGNE.md`, `README.md` | Localized labels, recovery and disclosure, motion inventory, and setup instructions. |

Reuse `readAvailableModelChoices()` and `resolveModelBindingInfo()` in `features/presets/model-choices.ts` for model labels and availability. Use `resolveSavedModelRequest()` from `features/models/store.ts` for each detection attempt. Do not copy credential lookup or protocol selection into the detector.

## Seams

1. **Settings store:** `createLanguageDetectionSettingsStore(storage)` → `load()`, `settings()`, `loadError()`, `save(settings)`.
2. **Settings page:** `SettingsPage` → Language Detection controls, saved configuration on reopen, and recovery actions.
3. **Detector:** `detectLanguage(text, settings, options)` → supported language ID or typed failure, verified at the AI client boundary.
4. **Language pair:** `resolveTranslationLanguages(input, options)` → concrete source and target IDs or typed failure.
5. **Preset editor/store:** `PresetEditor` and `createPresetsStore()` → save and restore an automatic target.
6. **Translation:** `translateWithPreset(input, options)` → concrete languages in the outbound translation request, or no translation request on failure.
7. **Popup:** `QuickTranslatePopup` and `createQuickTranslatePreferencesStore()` → restore the target selection and translate the visible cards with one shared detection run.

Confirm these seams before writing tests. Run each validation command from the repository root before and after each behavior change. Add one failing case, make the minimum change, and repeat. A red result must come from missing behavior, not a compile error, an absent fixture, or zero tests matched.

## Tasks

### 1. Persist language detection settings

**Seam:** Settings store. **Files:** `features/language-detection/settings.ts`, `features/language-detection/settings.test.ts`, `App.tsx`.

- [ ] **Red:** Save `mode: "ai"`, ordered model IDs `["primary", "backup-b", "backup-a"]`, native `zh`, and preferred `en`. Load through a new store instance. Expect the same choices and order.
- [ ] **Green:** Implement `LanguageDetectionSettings` with `mode: "off" | "ai"`, `modelIds: readonly string[]`, `nativeLanguage: LanguageId | null`, and `preferredTranslationLanguage: LanguageId | null`. Store those fields with `version: 1` at `settings.languageDetection.v1`. Export one production store. Add its `load()` to the `App.tsx` startup batch before mount. Keep `settings.language` unchanged.
- [ ] Repeat red → green for missing storage (off, no models, both preferences unset), malformed or unknown-version storage (safe defaults and a load error; no automatic overwrite), and failed writes (keep the last saved snapshot). Use a typed save result, including distinct validation and write errors. Serialize writes so a failed write cannot replace a saved snapshot. Reject blank or duplicate model IDs, AI mode without a primary ID, `auto` in either preference field, and identical concrete preferences. Model eligibility is checked by the picker and again at request time, not while loading settings.

**Red → green:** `mise exec -- nsh test features/language-detection/settings.test.ts --filter "detection settings:"`. Expect a missing round trip or incorrect validation first; then expect correct defaults, order, and recovery.

### 2. Add Settings → Language Detection

**Seam:** Settings page. **Files:** `features/settings/language-detection-section.tsx`, `features/settings/page.tsx`, `features/settings/settings.test.tsx`, `app/shell.tsx`, `locales/en.yml`, `locales/zh-CN.yml`, `docs/ui/DESIGNE.md`.

- [ ] **Red:** Open Settings and choose **Language Detection**. Verify **Off** is selected and the model controls are hidden. Use `makeSeedStorage()` from `features/models/__tests__/fixtures.ts` to seed three eligible saved models. Set **AI**, select a primary and two backups, move a backup up, select the two language preferences, save, and reopen. Verify the restored order and values, zero requests, and no change in **General → Language**.
- [ ] **Green:** Add `settings-nav-language-detection` to the Settings rail and render the third section in the existing detail pane. Keep a local draft and a **Save** action. Hide the model controls in **Off** mode without deleting their choices. Show primary and ordered backups in **AI** mode. Exclude models already assigned elsewhere in the chain. Use add, remove, and move-up/down controls. Reuse `Card`, `SectionHeading`, `FormField`, `Select`, and `Button`. Preference choices use `LANGUAGE_IDS` and `getLanguageLabel()`, plus an unset option, never `auto`. Explain that the preferred translation language is the automatic target only for text in the native language. Discard an unsaved draft on leaving the section. The service only reads saved settings.
- [ ] Repeat red → green for an empty or unavailable model catalog and an unavailable saved binding. Keep saved IDs visible with an availability reason so the user can replace or remove them; do not silently select another model or change the order. Add **Manage models** through `AppShell`'s existing Models navigation. On validation or write failure, show a localized inline alert and keep the draft for correction. Add one disclosure next to AI setup: automatic source detection sends a text sample to the chosen model, and may send it to the chosen backups if needed. Do not test or contact models from this form.
- [ ] Before coding the section, add its motion inventory to `docs/ui/DESIGNE.md`: category change uses the existing immediate detail replacement, presses/selection and focus use shared controls, selects use `motion.popup`, and model row changes and inline validation update without animation. Check the 860-point compact layout and keep one detail scroll owner. Localize all labels, accessibility names, and errors in both locales.

**Red → green:** `mise exec -- nsh test features/settings/settings.test.tsx --filter "language detection:"`. Expect the missing category or incorrect saved order first; then expect the new settings and their recovery states to work through the UI.

### 3. Detect with the configured AI model chain

**Seam:** Detector. **Files:** `features/language-detection/detect.ts`, `features/language-detection/detect.test.ts`.

- [ ] **Red:** For a configured primary, capture one `generateText` request. Return `" FR\n"` and expect `{ ok: true, language: "fr" }`. Verify that the request uses the resolved model key and sends the sample in the user message, not the system message.
- [ ] **Green:** Implement `detectLanguage(text, settings, options)` with `signal`, `timeoutMs`, and optional overrides of `resolveSavedModelRequest` and `aiClient.generateText` for tests. Return a supported concrete `LanguageId` on success; on failure return one of `blank_input`, `unconfigured`, `no_eligible_model`, `unknown_language`, `failed`, or `cancelled`. The fixed system message asks for the dominant language, as one literal ID from `LANGUAGE_IDS`, or `und` if it cannot determine a supported language. Treat the user message as data. Use the first 2,048 Unicode code points of trimmed text, preserving complete code points. Trim and lowercase the response and accept only an exact supported ID or `und`. Do not accept prose, JSON, locale variants, Markdown, or `auto`. Omit optional generation parameters; use the AI client's current per-model timeout unless overridden.
- [ ] Repeat red → green for `unavailable primary → 429 → malformed response → success`, and for `und` followed by a valid backup. Resolve each saved binding just before its attempt. Continue on unavailable bindings, `und`, invalid responses, and `ProviderProtocolError` other than `cancelled`. Stop on success, cancellation, or an unexpected exception; map unexpected exceptions to `failed` without details. If all attempts finish, return `unknown_language` if any model answered `und`, `no_eligible_model` if no request was possible, or `failed` otherwise. Verify blank input and Off mode do not resolve a model, and abort during resolution or generation prevents every later attempt and ignores late results.

**Red → green:** `mise exec -- nsh test features/language-detection/detect.test.ts --filter "AI detection:"`. Expect missing or incorrect language/request order first; then expect valid IDs only, bounded samples, correct fallbacks, and no request after cancellation.

### 4. Resolve the effective language pair

**Seam:** Language pair. **Files:** `features/language-detection/resolve.ts`, `features/language-detection/resolve.test.ts`, `features/presets/languages.ts`.

- [ ] **Red:** With native `zh` and preferred `en`, resolve concrete source `en` and automatic target to `{ sourceLanguage: "en", targetLanguage: "zh" }`. Assert zero detection calls. Add `fr → zh` and `zh → en` separately. The French case distinguishes this rule from one that compares the source with the preferred language.
- [ ] **Green:** Use the existing `AUTO_LANGUAGE` sentinel for both selectors. Define `TargetLanguageId` as `LanguageId | typeof AUTO_LANGUAGE`; `isLanguageId()` still accepts concrete IDs only. Task 5 adds the target-specific automatic label. Implement `resolveTranslationLanguages({ sourceText, sourceLanguage, targetLanguage, settings }, options)` with the detector's options from Task 3. Return `{ ok: true, sourceLanguage: LanguageId, targetLanguage: LanguageId }`, or the detector failure code plus `missing_native_language` or `missing_preferred_language` as applicable. For an automatic target, require the native language before detection. After resolving the source, return the native language as the target if the source differs from it. Otherwise require and use the preferred language. If the source is concrete, do not call the detector. If the target is concrete, do not require preferences. Check cancellation before and after detection.
- [ ] Repeat red → green for both automatic, automatic source with concrete target, both concrete, missing native language with automatic target (zero network), and detector failures (no guessed target). With native `zh` and no preferred language, verify that `fr` still resolves to `zh` and source `zh` returns `missing_preferred_language`. For automatic source and no preferred language, detect once, then apply the same rule to the resulting source ID.

**Red → green:** `mise exec -- nsh test features/language-detection/resolve.test.ts --filter "language pair:"`. Expect the wrong pair or an unnecessary detection first; then expect all four combinations and failure propagation.

### 5. Save Automatic in a translation preset

**Seam:** Preset editor/store. **Files:** `features/presets/languages.ts`, `features/presets/types.ts`, `features/presets/draft.ts`, `features/presets/editor.tsx`, `features/presets/presets.test.tsx`, `features/presets/store.test.ts`, `locales/en.yml`, `locales/zh-CN.yml`. Update existing nullable preset fixtures in `features/quick-translate/translate.test.ts` and `features/quick-translate/popup.test.tsx`.

- [ ] **Red:** Select **Automatic** in the preset target menu, save, reopen the app, and verify the selection. At the store seam, save and reload an `auto` target; confirm a concrete target still round-trips and an unsupported value is rejected.
- [ ] **Green:** Remove the no-preference sentinel and nullable target from preset records and draft saves. Default new preset targets to `AUTO_LANGUAGE`. Make `isTargetLanguageId()` accept only `TargetLanguageId`. Keep the existing store/validation paths. Use concrete `zh` instead of `null` for existing Quick Translate fixtures that expect the old Chinese default. The preset editor can save `auto` even if Language Detection is not configured. It makes no detection request. Add the localized `presets.language.autoTarget` key (**Automatic** / **自动**), remove the null branch of `getLanguageLabel()`, and remove the old no-preference key.

**Red → green:** `mise exec -- nsh test features/presets/store.test.ts --filter "automatic target:"` and `mise exec -- nsh test features/presets/presets.test.tsx --filter "automatic target:"`. Expect rejected `auto` storage or a missing option first; then expect both round trips to pass.

### 6. Resolve languages before translation

**Seam:** Translation. **Files:** `features/quick-translate/translate.ts`, `features/quick-translate/translate.test.ts`, `locales/en.yml`, `locales/zh-CN.yml`.

- [ ] **Red:** Use a preset with `auto` source and target. With native `zh`, preferred `en`, and detector response `fr`, capture the detector request followed by a translation request with French and Chinese in the corresponding prompt positions. Repeat with detector response `zh` and expect Chinese and English. If detection fails, no translation model request occurs.
- [ ] **Green:** Make `resolveInitialPresetLanguages()` return the saved pair as-is, without a Chinese fallback. In `translateWithPreset()`, use explicit input selections over the preset values. After the existing preset, blank input, template, and model-chain guards, call `resolveTranslationLanguages()` with one saved settings snapshot. Allow an optional `languageDetectionSettings` snapshot in `TranslateWithPresetOptions`; forward the existing model request and generation overrides to the detector so the test can observe both phases. Pass only concrete `LanguageId` values to `renderPromptTemplate()`. Remove the old prompt instruction for inline detection. Do not change template rendering or the translation model chain's retry rules.
- [ ] Repeat red → green for concrete overrides (zero detection), missing native language (zero detection), native-language source with no preferred language (no translation request), Off mode with automatic source, unknown source, and abort after a late detector response. Convert typed language failures to localized recovery messages shared with the popup. Point to the specific missing preference or offer a concrete target. For detection errors, ask the user to configure the detector, check the configured models, or choose the source manually. Cancellation is silent. Do not include raw provider replies in a detection error.

**Red → green:** `mise exec -- nsh test features/quick-translate/translate.test.ts --filter "language resolution:"`. Expect an inline-detection prompt, incorrect request order, or a translation request after detection failure first; then expect two concrete labels and the correct request counts.

### 7. Share one language-resolution run across Quick Translate cards

**Seam:** Popup. **Files:** `features/quick-translate/popup.tsx`, `features/quick-translate/preferences.ts`, `features/quick-translate/preferences.test.ts`, `features/quick-translate/popup.test.tsx`, `features/quick-translate/__tests__/popup-harness.tsx`, `docs/ui/DESIGNE.md`.

- [ ] **Red:** Choose **Automatic** target and reopen. Confirm `"auto"` survives the round trip. With no popup override, confirm the seed preset supplies the target. With either selector set to `auto`, the language-swap button must be disabled.
- [ ] **Green:** Add the localized target option. Parse a saved target with `isTargetLanguageId()` while preserving popup `null` as **inherit the preset**. Replace the no-preset target initialization with `AUTO_LANGUAGE`. Disable swap for either automatic selector. Keep these selectors unchanged after resolving a pair; do not save detected or calculated values as user selections.
- [ ] **Red:** Start a translation with two expanded cards. Hold the detector response and verify one detection request and zero translation requests. Return the language and verify both cards translate with the same concrete pair. Repeat for a collapsed card (it does not start or join a run).
- [ ] **Green:** At each `executeAllCards()` call, capture one immutable input and settings snapshot. Create one lazy language-resolution run for that action. Each eligible `executeCard()` enters loading and joins the same promise after its guards, then calls the existing translation entry with the resolved concrete pair. A standalone card request (retry or expand) starts its own run. No successful or failed resolution is retained across actions. A saved Settings change applies to the next action, not the in-flight snapshot. Load the detection settings in the existing popup harness before mount. Seed distinct detection and translation endpoints in the tests and observe `open(..., { network: ... })` requests with `app.requests()`. For deferred responses, control the AI generation boundary in the test harness, not the resolver. Do not add a production mock mode.
- [ ] Repeat red → green for a card collapsing during detection (other cards continue); last consumer leaving, text or language change, Clear, or window close (abort and discard late results); blocked or failed detection (same recoverable message on affected cards, no translation traffic); and retry after failure (new run). Give the shared run its own `AbortController`; release a consumer on card abort or settlement and abort shared work when no consumers remain. Reuse request IDs to stop stale writes and recheck the card signal after the shared await. Manual submit, the existing 500 ms Auto-translate debounce, and double copy must keep their existing trigger rules. Do not start a run for blank input or no eligible expanded cards.

**Red → green:** `mise exec -- nsh test features/quick-translate/preferences.test.ts --filter "automatic target:"` and `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "language resolution:"`. Expect `auto` to be lost, duplicate detection, or a stale request/result first; then expect correct restore, concrete prompts, and independent card cancellation.

## Final Validation

- [ ] Run `mise run verify`. Expect formatting, lint, types, Rust tests, headless NSH tests, and the release bundle to pass. Recheck the existing manual translation, Auto-translate debounce, double copy, and per-card template tests. Update fixtures that previously relied on the inline detection prompt.
- [ ] On Windows, run `mise exec -- nsh test features/settings/settings.test.tsx --target windows --filter "language detection:"`, `mise exec -- nsh test features/presets/presets.test.tsx --target windows --filter "automatic target:"`, and `mise exec -- nsh test features/quick-translate/popup.test.tsx --target windows --filter "language resolution:"`. Verify layouts at `1040 × 720` and `720 × 520` in Settings, and at the minimum Quick Translate width. Inspect light and dark screenshots for radius, typography, spacing, alignment, token colors, hover/press/focus, and empty/error states. Check keyboard selection and reorder, Escape dismissal, and shared motion with reduced motion. Record the checks and results in `docs/ui/DESIGNE.md`.
- [ ] With configured test models and non-sensitive text, set native Chinese and preferred English. Use automatic source and target with English, French, and Chinese source text. Expect Chinese, Chinese, and English targets respectively. Clear the preferred language and verify that French still translates to Chinese, while Chinese prompts for a preferred language or a concrete target. Repeat with explicit source and target to prove the flow still works while detection is off. Document setup and fallback behavior in `README.md`.

## Failure Behavior

- **Unconfigured detector or unknown source:** Do not guess and do not start translation. Tell the user to configure the detector or choose the source manually.
- **Missing native language with automatic target:** Do not start detection or translation. Ask the user to set the native language or select a concrete target.
- **Missing preferred language with automatic target:** This blocks translation only if the source is in the native language. Ask the user to set the preferred language or select a concrete target. If the source was automatic, detection can run first to determine whether this preference is needed.
- **Unavailable model or provider failure:** Try the next configured detector model. If none succeeds, show a localized error. A new action may retry; an old or aborted action cannot update the result.
- **Settings write failure:** Keep the active saved snapshot; leave the form draft available. A malformed file does not enable detection or get rewritten without a user save.

## Privacy and Security

- Detect only within an existing translation action, and only when the source is automatic. Send only the bounded sample to explicitly configured detection models. Each fallback may use a different provider. Reuse Model Store credentials, endpoint rules, saved HTTP consent, and the existing generation adapters' redirect rejection.
- Store only settings and model IDs. Do not store or log samples, detected values tied to text, raw model responses, endpoint details, or credentials. Invalid model output cannot become a prompt language or an endpoint. The translation request still sends the full source text to the selected translation model.

## Rollout Notes

- This is a Demo-stage update. Recreate local Demo presets with a legacy `null` target if the preset store rejects them. Do not automatically delete data. No release migration, native update, or service deployment is needed.
- When AI is off, an existing **Automatic** source selection needs either AI setup or a concrete source selection. Document this behavior explicitly in `README.md` and in the error shown at the point of use.

## Risks and Mitigations

- **Latency and provider cost:** One detection chain per popup action, no separate detection for concrete sources, bounded input, and no automatic retries outside that chain.
- **Short or mixed-language text:** Ask the detector for the dominant supported language; accept `und` and let the user select the source. Do not infer a source from interface or preference languages.

**Open Questions:** None. The assumptions above define the initial behavior.
