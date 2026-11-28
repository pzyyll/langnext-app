# Implementation Plan

**Goal:** Add an AI-backed dictionary to the Quick Translate window that shows an inline lexicon band for whole-word input and a two-stage selection lookup (floating `[Look up]` pill to a non-modal docked bottom drawer) for words selected inside the source, translation, back-translation, or history areas, with one-click Anki Wordbook saving (word, definition, and context sentence).

**Inputs:** Mr. Julian's Quick Translate dictionary design decisions (Phase 1 AI structured prompt with `[Look up]` trigger pill before querying; whole-word inline dictionary running in parallel with translation cards; Anki saves include word, definition, and context sentence), the existing Quick Translate vertical-stream and sentence-highlight flows (`src/features/quick-translate/`), the shared integration capability host (`src/framework/integrations/`, `src/features/settings/`), and the Anki Wordbook client (`src/features/wordbook/`).

**Assumptions:**

- Register Dictionary as a new integration capability (`CapabilityId = "dictionary"`) under **Settings → Integrations → Dictionary**, using the existing `CapabilitySection` host and `modelHostServices("text", ...)`. Ship one channel in Phase 1 (`ai`), matching `src/integrations/detect/channels/ai.tsx`. Local offline dictionaries (ECDICT/StarDict) and dedicated dictionary APIs are out of scope for Phase 1 and will plug into the same capability later.
- Hide dictionary UI chrome (the inline band and the selection `[Look up]` pill) when no dictionary channel is configured and enabled. Once a channel is enabled, both whole-word lookups and selection lookups activate automatically.
- Do not add a third Anki field selector in Phase 1. Reuse the saved two-field Anki binding (`sourceField` and `translationField`): write the canonical headword (`entry.term`) to `sourceField` so Anki duplicate detection deduplicates by word, and write formatted plain text (phonetics, concise senses, and the captured context sentence) to `translationField`.
- Keep the Quick Translate popup width unchanged (`420pt` default, `340pt` min). Responsive side-inspector placement on manually widened windows (`>= 680pt`) is deferred to a follow-up after the docked bottom drawer ships.
- Ship and gate native selection coordinate verification on Windows first (`RichEditor`, `View selectable`, `TextView selectable`). Non-Windows platforms wire the same public selection callbacks through `Textarea` (`onSelectionChange` + `onCaretMove`) and selectable outputs without blocking Windows delivery.
- In-popup selection lookups do not write to translation history; they use an in-memory session cache and drawer back-stack only.

**Architecture:** Dictionary joins the integration registry as capability `"dictionary"` with `dictionaryChannels` (`integrations.dictionary.v1`) and a priority fallback runner `lookupDictionaryEntry()` backed by an in-memory session LRU cache. The AI channel sends one non-reasoning text generation request with a strict JSON schema prompt and validates the parsed `DictionaryEntry`. In Quick Translate, `createQuickTranslateSession` owns both the Scenario A inline lexicon state (triggered in parallel with translation cards on lexical queries) and the Scenario B docked drawer state (back-stack, TTS single-channel sharing, and Anki single-in-flight sharing), while `QuickTranslatePopup` owns the transient non-focus-stealing `[Look up]` pill and its mutual exclusion with sentence alignment.

**Tech Stack:** NSH 0.7.0, TypeScript and TSX, existing `src/framework/integrations/` capability host, `aiClient.generateText`, `createAnkiClient().addTranslation`, `nsh/test`, and mise. No new runtime dependencies or Rust code.

---

## Interaction and Data Contract

| Area | Contract |
| --- | --- |
| AI JSON schema | System prompt instructs the model to act as a concise lexicographer and return one JSON object only: `{"found": boolean, "term": string, "language": "<LanguageId\|null>", "phonetics": [{"label"?: string, "text": string}], "senses": [{"pos": string, "definitions": string[], "synonyms"?: string[]}], "inflections": [{"label": string, "form": string}], "examples": [{"source": string, "translation": string}]}`. User message carries structured data only (term, optional source language, target explanation language, optional context sentence). Parser strips accidental markdown code fences, validates types, trims whitespace, caps array lengths (max 3 phonetics, 6 senses, 8 inflections, 3 examples), validates `language` via `isLanguageId`, and requires at least 1 non-empty sense when `found` is `true`. |
| Lexical query gates | `normalizeLookupTerm(raw)` trims whitespace and strips outer surrounding punctuation/quotes/brackets while preserving internal hyphens and apostrophes (`cutting-edge`, `don't`); rejects blank strings, multiline strings, URLs, emails, paths, and pure digits/symbols. `isInlineLexicalQuery(raw)` (Scenario A) accepts single-line terms without internal sentence-ending punctuation: `1–3` words and `<= 40` UTF-16 code units for space-delimited scripts, or `1–4` characters for CJK/non-spaced scripts. `isSelectionLookupCandidate(raw)` (Scenario B pill) accepts `1–4` words and `<= 48` code units, or `<= 8` CJK characters. |
| Context sentence & language inference | `extractContextSentence(fullText, selectionStart, selectedText)` returns the single containing sentence around the selection (split on newlines and `. ! ? 。 ！ ？ ; ；`, trimmed, capped at 240 chars), or `null` when `fullText.trim()` equals `selectedText.trim()`. Language inference by region: **Source** → `sourceLanguage` (or detected language) to `targetLanguage`; **Result card** → `result.targetLanguage` to `result.sourceLanguage` (falling back to native language if equal); **Back-translation** → `result.sourceLanguage` to `result.targetLanguage`; **History card** → `result.targetLanguage` to `result.sourceLanguage`. |
| Scenario A: Inline Lexicon Band | Renders between `quick-translate-source-section` and `quick-translate-stream` when `!showingHistory()` and `dictionaryEnabled()`. Runs in parallel with translation cards on Enter, Auto-translate, delivery, or language change. Reuses `session.detectSourceLanguage` when language resolution needs detection. Renders nothing for `idle` and `not_found`. Displays compact loading text while pending, a retryable error row on channel failure, and a collapsible band on success (optional lemma indicator when lemmatized, phonetic speaker pills, copy, Anki add, collapse `+` ↔ `×`, up to 4 visible senses with a disclosure row for inflections and examples). |
| Scenario B Stage 1: Selection `[Look up]` Pill | Appears after a `180ms` selection stability debounce when `dictionaryEnabled()`, window is visible, IME is not composing, and `isSelectionLookupCandidate(text)` is true. Uses `AnchoredPopover` (`placement="top"`, `align="center"`, `offset={6}`, non-focus-stealing) anchored to `pageBounds`. Dismisses immediately on selection clear, source edit, outer scroll, outside press, `Esc`, window hide, or opening sentence popover. Never intercepts `Ctrl+C`, `Backspace`, or typing. Keyboard path: `Alt+D` looks up the current selection directly into the drawer. Context-menu path: `selectionMenu` adds a localized `Look up` item on selectable outputs. |
| Scenario B Stage 2: Non-Modal Docked Drawer | Mounts in `QuickTranslateWindowBody` between `<Scroll>` and `<QuickTranslateFooter>` (and mirrored in `popup-harness.tsx`), outside the main scroll viewport so `fitContentHeight` expands naturally on short windows and the drawer never clips. Has its own bounded `<Scroll class="max-h-60">` and no modal backdrop, so users can scroll and select another word above to push onto the drawer back-stack. Header shows `[←]` back (`stack.length > 1`, `Alt+Left`), headword, `[🔊]` speak, `[🔖]` add to Anki, `[↗]` promote term to source input, and `[×]` close. Clicking a lemma, inflection, or synonym in either Scenario A or Scenario B pushes that term onto the drawer stack with `contextSentence: null`. |
| Sentence alignment & `Esc` layering | Non-empty selection in any result/back-translation clears `activeMatch`, closes `sentencePopover`, and suppresses a drag-release `onPressSegment`. Opening `sentencePopover` dismisses the selection pill. Register `"dictionary-pill"` and `"dictionary-drawer"` with `session.notifyOverlayOpenChange`: `Esc` dismisses the pill first, then the docked drawer (restoring focus), and only then hides the Quick Translate window. |
| Anki Wordbook payload | `formatDictionaryAnkiNote(entry, contextSentence, labels)` maps `sourceText = entry.term` and `translatedText` to plain text lines: phonetics (when present), `pos. def1; def2` lines, and a separated context line (`<label>: <sentence>`) using the selection's `contextSentence` (Scenario B) or `entry.examples[0].source` (Scenario A fallback when present). Shares `session`'s single-in-flight `ankiInFlight` lock and `windowEpoch` / target freshness guard with translation cards. |

---

## File Map

### Create

- `src/integrations/dictionary/types.ts` — Dictionary request/entry/outcome types, structured JSON prompt builder, strict response parser, and failure key map.
- `src/integrations/dictionary/channels/ai.tsx` — AI Dictionary `CapabilityChannelDefinition` and model-picker `Settings` component.
- `src/integrations/dictionary/index.ts` — Dictionary channel list and `registerDictionaryIntegrations(registry)`.
- `src/features/dictionary/lexical-query.ts` — `normalizeLookupTerm`, `isInlineLexicalQuery`, `isSelectionLookupCandidate`, and `extractContextSentence`.
- `src/features/dictionary/anki-format.ts` — `formatDictionaryAnkiNote` formatting word, phonetics, definitions, and context sentence for Anki.
- `src/features/dictionary/store.ts` — `dictionaryChannels` (`integrations.dictionary.v1`, vault `secret.dictionary`).
- `src/features/dictionary/lookup.ts` — `enabledDictionaryEntries`, `lookupDictionaryEntry`, and bounded in-memory session LRU cache.
- `src/features/quick-translate/dictionary-entry.tsx` — Shared `DictionaryEntryView` (phonetic speaker pills, aligned POS/sense rows, clickable synonyms/inflections, collapsible examples).
- `src/features/quick-translate/dictionary-band.tsx` — `InlineDictionaryBand` (Scenario A) and `DockedDictionaryDrawer` (Scenario B).
- `assets/icons/mdi--book-open-variant-outline.svg` — Material Design Icon for Dictionary Settings empty state and `[Look up]` pill.
- `assets/icons/mdi--arrow-left.svg` — Material Design Icon for drawer back-stack navigation.
- `assets/icons/mdi--arrow-top-left.svg` — Material Design Icon for promoting a looked-up term into the source input.

### Modify

- `src/framework/integrations/contracts.ts` — Add `"dictionary"` to `CapabilityId`.
- `src/framework/integrations/registry.ts` — Add `"dictionary"` to `CAPABILITY_IDS`.
- `src/app/integrations-setup.ts` — Call `registerDictionaryIntegrations(registry)`.
- `src/components/ui/icon.tsx` — Register `mdi:book-open-variant-outline`, `mdi:arrow-left`, and `mdi:arrow-top-left`.
- `src/features/settings/capability-section.tsx` — Add `dictionary: "mdi:book-open-variant-outline"` to `EMPTY_ICONS`.
- `src/features/settings/page.tsx` — Add `dictionary` section under `integrations` group with `CapabilitySection` and `modelHostServices("text", props.onNavigateToModels)`.
- `App.tsx` — Load `dictionaryChannels.load()` during startup.
- `src/components/ui/translation-output.tsx` — Forward `onSelectionChange` and `selectionMenu` on `<View selectable>` and `<TextView selectable>`.
- `src/features/quick-translate/aligned-translation.tsx` — Forward `onSelectionChange` and `selectionMenu` on plain `<View selectable>` and Markdown `<TextView selectable>`, and guard `onPressSegment` against active drag selection.
- `src/features/quick-translate/source-editor.tsx` — Extend `onSelectionChange` payload with selected `text` and computed `pageBounds` (`session.pageCoordsAtPos`).
- `src/features/quick-translate/history-results.tsx` — Forward result text selection callbacks to support lookup from restored history cards.
- `src/features/quick-translate/session.ts` — Add inline dictionary query lifecycle, docked drawer stack/lookup lifecycle, TTS language metadata, and shared-lock Anki save handlers for dictionary entries.
- `src/features/quick-translate/popup.tsx` — Mount `InlineDictionaryBand`, track cross-region text selection, render the debounced non-focus-stealing `[Look up]` `AnchoredPopover`, coordinate mutual exclusion with sentence alignment, wire `Alt+D` shortcut, and unify TTS playback for dictionary phonetics.
- `src/app/quick-translate.tsx` — Mount `DockedDictionaryDrawer` between `<Scroll>` and `<QuickTranslateFooter>`, include its measured height in `fitContentHeight`, and wire `dictionaryChannels` readiness and `Esc` handling.
- `locales/en.yml` and `locales/zh-CN.yml` — Add localized keys for Settings Dictionary, Quick Translate dictionary labels, `[Look up]` pill, drawer controls, Anki context prefix, accessibility names, and errors.
- `DESIGN.md` — Record the Quick Translate Dictionary motion inventory before TSX UI edits.
- `README.md` — Document Dictionary setup, whole-word inline lookup, in-popup selection lookup, and Anki context saving.

### Test

- `src/features/dictionary/dictionary.test.ts` — Unit tests for `lexical-query.ts`, `types.ts` prompt/parser, `anki-format.ts`, and `lookup.ts` chain/cache behavior.
- `src/integrations/dictionary/channels/channels.test.ts` — Unit tests for `aiDictionaryDefinition` config, validation, readiness, execution, cancellation, and failure mapping.
- `src/features/settings/settings.test.tsx` — Settings UI tests for **Settings → Integrations → Dictionary**.
- `src/features/quick-translate/__tests__/dictionary-selection-app.tsx` and `src/features/quick-translate/dictionary-selection.test.tsx` — Native Windows seam test proving `RichEditor`, `View selectable`, and `TextView selectable` selection events, `pageBounds` anchoring, non-focus-stealing `[Look up]` pill, and zero conflict with `AlignedTranslation` click popovers.
- `src/features/quick-translate/__tests__/popup-harness.tsx` and `src/features/quick-translate/popup.test.tsx` — End-to-end Quick Translate inline band, selection pill, docked drawer, back-stack, promote-to-input, TTS, and sentence-highlight coexistence tests.
- `src/app/__tests__/quick-translate-harness.tsx` and `src/app/quick-translate.test.tsx` — Full `AppShell` + `QuickTranslateWindow` tests covering height fit, `Esc` layering, and Anki Wordbook saving from inline band and docked drawer.

---

## Seams

Confirm these seams before writing tests. Follow `/tdd`: write one failing behavior test at the seam, run the slice command to observe the expected failure, write the minimal implementation, and rerun the same command.

1. **Seam 1 (`lexical-query`, `dictionary/types`, `anki-format`):** Pure functions `normalizeLookupTerm`, `isInlineLexicalQuery`, `isSelectionLookupCandidate`, `extractContextSentence`, `buildDictionaryPrompt`, `parseDictionaryResponse`, and `formatDictionaryAnkiNote` — deterministic classification, context extraction, JSON validation, and Anki payload formatting.
2. **Seam 2 (`aiDictionaryDefinition`, `lookupDictionaryEntry`, `SettingsPage`):** Capability registration, AI channel execution/fallback/caching, and **Settings → Integrations → Dictionary** add/configure/enable/reload flow through `open(APP_ENTRY)`.
3. **Seam 3 (Native Windows Selection Gate):** `QuickTranslateSourceEditor`, `TranslationOutput`, `AlignedTranslation`, and `AnchoredPopover` mounted in `dictionary-selection-app.tsx` — proves real selection `text` + `pageBounds`, non-focus-stealing `[Look up]` pill, and drag-selection isolation from sentence popovers on Windows.
4. **Seam 4 (Inline Whole-Word Band):** `QuickTranslatePopup` + `createQuickTranslateSession` through `popup-harness.tsx` — parallel whole-word dictionary lookup alongside translation cards, silent hide on `not_found`/sentences, TTS, collapse, copy, and retry.
5. **Seam 5 (Selection Lookup Pill & Docked Drawer):** `QuickTranslatePopup` + `DockedDictionaryDrawer` through `popup-harness.tsx` and `quick-translate-harness.tsx` — debounced `[Look up]` pill across source/result/back-translation/history, `Alt+D`, non-modal bottom drawer, back-stack drill-down, promote-to-input, `Esc` layering, and window height fit.
6. **Seam 6 (Dictionary → Anki Wordbook):** Quick Translate inline band and docked drawer through `AppShell` (`app/quick-translate.test.tsx`) — real `createAnkiClient().addTranslation()` HTTP payloads containing word, formatted definitions, and context sentence, sharing the single-in-flight lock and freshness checks.

---

## Tasks

### Task 1: Build lexical classification, context extraction, AI prompt/parser, and Anki formatter

**Seam:** Pure functions in `src/features/dictionary/lexical-query.ts`, `src/integrations/dictionary/types.ts`, and `src/features/dictionary/anki-format.ts`.

**Outcome:** All lexical gates, sentence extraction, strict JSON parsing, and two-field Anki formatting rules pass deterministic unit tests.

**Files:**

- Create: `src/features/dictionary/lexical-query.ts`
- Create: `src/integrations/dictionary/types.ts`
- Create: `src/features/dictionary/anki-format.ts`
- Test: `src/features/dictionary/dictionary.test.ts`

**Steps:**

- [ ] **Red:** Add `dictionary lexical:` tests covering `normalizeLookupTerm` (trimming outer punctuation while keeping `cutting-edge` and `don't`; rejecting blank, multiline, URL, email, pure digits), `isInlineLexicalQuery` (single English word, 2–3 word phrasal verb, 2-char Chinese word accepted; full sentence rejected), `isSelectionLookupCandidate` (short phrase accepted; long sentence rejected), and `extractContextSentence` (extracts exact sentence in English and Chinese paragraphs, returns `null` when full text equals the term, caps at 240 chars).
- [ ] **Green:** Implement `lexical-query.ts` to satisfy all cases cleanly with named constants for length and word bounds.
- [ ] **Red:** Add `dictionary prompt and parser:` tests verifying `buildDictionaryPrompt` keeps user term and context sentence in the `user` payload (never interpolated into `system`), and `parseDictionaryResponse` handles valid JSON, fenced ```` ```json ```` JSON, `{"found": false}`, unknown language codes coerced to `null`, empty/malformed responses, and array length caps (3 phonetics, 6 senses, 8 inflections, 3 examples).
- [ ] **Green:** Implement `src/integrations/dictionary/types.ts` with `DictionaryLookupInput`, `DictionaryEntry`, `DictionaryChannelOutcome`, `DictionaryChannelFailure`, `buildDictionaryPrompt`, `parseDictionaryResponse`, and `dictionaryFailureKey`.
- [ ] **Red:** Add `dictionary anki format:` tests verifying `formatDictionaryAnkiNote` puts canonical `entry.term` in `sourceText`, puts phonetics + `pos. def1; def2` lines + localized context sentence line in `translatedText`, prefers `contextSentence` over `examples[0]`, falls back to `examples[0].source` when `contextSentence` is absent, and omits the context block when both are absent.
- [ ] **Green:** Implement `src/features/dictionary/anki-format.ts`.

**Validation:**

- Run (red): `mise exec -- nsh test src/features/dictionary/dictionary.test.ts --filter "dictionary "`
- Expected: tests fail on missing behavior before each Green step.
- Run (green): `mise exec -- nsh test src/features/dictionary/dictionary.test.ts --filter "dictionary "`
- Expected: all `dictionary lexical:`, `dictionary prompt and parser:`, and `dictionary anki format:` cases pass.

---

### Task 2: Register the AI Dictionary capability, lookup runner, and Settings section

**Seam:** `aiDictionaryDefinition`, `lookupDictionaryEntry()`, and **Settings → Integrations → Dictionary** in `SettingsPage`.

**Outcome:** Users can add, configure, enable, and reload the AI Dictionary channel in **Settings → Integrations → Dictionary**, and `lookupDictionaryEntry` executes enabled channels in priority order with session caching.

**Files:**

- Create: `assets/icons/mdi--book-open-variant-outline.svg`
- Create: `src/integrations/dictionary/channels/ai.tsx`
- Create: `src/integrations/dictionary/index.ts`
- Create: `src/features/dictionary/store.ts`
- Create: `src/features/dictionary/lookup.ts`
- Modify: `src/components/ui/icon.tsx`
- Modify: `src/framework/integrations/contracts.ts`
- Modify: `src/framework/integrations/registry.ts`
- Modify: `src/app/integrations-setup.ts`
- Modify: `src/features/settings/capability-section.tsx`
- Modify: `src/features/settings/page.tsx`
- Modify: `App.tsx`
- Modify: `locales/en.yml`
- Modify: `locales/zh-CN.yml`
- Modify: `DESIGN.md`
- Test: `src/integrations/dictionary/channels/channels.test.ts`
- Test: `src/features/dictionary/dictionary.test.ts`
- Test: `src/features/settings/settings.test.tsx`

**Steps:**

- [ ] **Red:** In `src/integrations/dictionary/channels/channels.test.ts`, add `dictionary ai channel:` tests covering `config.parse`, `validate` rejecting blank `modelId`, `readiness` resolving saved `"text"` model, `execute` calling `host.models.generateText` with `disableReasoning: true` and returning `found`, `not_found`, `cancelled`, `unavailable`, and `failed` (`malformed_response`, `request_failed`).
- [ ] **Green:** Extend `CapabilityId` and `CAPABILITY_IDS` with `"dictionary"`, implement `src/integrations/dictionary/channels/ai.tsx` (mirroring `src/integrations/detect/channels/ai.tsx` with `testID` prefix `settings-dictionary-`), export `registerDictionaryIntegrations` in `index.ts`, and register it in `src/app/integrations-setup.ts`.
- [ ] **Red:** In `src/features/dictionary/dictionary.test.ts`, add `dictionary lookup:` tests covering priority chain fallback via `runChain`, unconfigured outcome when no channel is enabled, cancellation mid-request, and session LRU cache hit (second call with identical term/languages/context and unchanged channel signature sends zero model requests; channel config change invalidates cache).
- [ ] **Green:** Implement `src/features/dictionary/store.ts` (`integrations.dictionary.v1`, `secret.dictionary`, `enableOnFirstSave: true`) and `src/features/dictionary/lookup.ts` (`enabledDictionaryEntries`, `lookupDictionaryEntry`, bounded 64-entry LRU cache).
- [ ] **Red:** In `src/features/settings/settings.test.tsx`, add `dictionary settings:` test opening `App.tsx`, navigating to `id:settings-nav-dictionary` under `id:settings-group-integrations`, adding the AI channel, selecting a saved text model, saving, reloading the app, and verifying the saved enabled binding with zero network requests.
- [ ] **Green:** Record Settings Dictionary motion (reusing shared `CapabilitySection` transitions) in `DESIGN.md`. Add `assets/icons/mdi--book-open-variant-outline.svg` and wire it in `icon.tsx` and `capability-section.tsx`. Add `"dictionary"` to `SETTINGS_GROUPS`, `CAPABILITY_SECTIONS`, `collectionFor`, and detail rendering in `src/features/settings/page.tsx` using `modelHostServices("text", props.onNavigateToModels)`. Load `dictionaryChannels.load()` in `App.tsx`. Add localized keys to both `locales/en.yml` and `locales/zh-CN.yml`.

**Validation:**

- Run (red/green): `mise exec -- nsh test src/integrations/dictionary/channels/channels.test.ts --filter "dictionary ai channel:"`
- Run (red/green): `mise exec -- nsh test src/features/dictionary/dictionary.test.ts --filter "dictionary lookup:"`
- Run (red/green): `mise exec -- nsh test src/features/settings/settings.test.tsx --filter "dictionary settings:"`
- Run: `mise exec -- nsh test src/framework/integrations/registry.test.ts`
- Expected: new tests fail before implementation and pass after; registry diagnostics pass with zero errors.

---

### Task 3: Prove native selection reporting and non-focus-stealing lookup pill on Windows

**Seam:** `QuickTranslateSourceEditor`, `TranslationOutput`, `AlignedTranslation`, and `AnchoredPopover` in a real NSH window (`dictionary-selection-app.tsx`).

**Outcome:** Real Windows NSH runtime proves that selecting a word in `RichEditor`, plain `<View selectable>`, and Markdown `<TextView selectable>` delivers `text` and `pageBounds`, shows a non-focus-stealing `[Look up]` pill without breaking `Ctrl+C`/typing, and never triggers `AlignedTranslation`'s click popover on drag release.

**Files:**

- Modify: `src/features/quick-translate/source-editor.tsx`
- Modify: `src/components/ui/translation-output.tsx`
- Modify: `src/features/quick-translate/aligned-translation.tsx`
- Create: `src/features/quick-translate/__tests__/dictionary-selection-app.tsx`
- Test: `src/features/quick-translate/dictionary-selection.test.tsx`

**Steps:**

- [ ] **Red:** Create `dictionary-selection-app.tsx` mounting `QuickTranslateSourceEditor`, plain `AlignedTranslation`, and Markdown `AlignedTranslation` with known sentences, plus an `AnchoredPopover` `[Look up]` pill. Add `dictionary selection native:` test cases in `dictionary-selection.test.tsx` verifying:
  1. Selecting one word in `QuickTranslateSourceEditor` reports non-empty `text` and finite `pageBounds`, mounts the pill without stealing focus from the editor, and typing immediately clears the pill and edits the document normally.
  2. Drag-selecting or double-clicking a word in plain and Markdown `AlignedTranslation` reports `text` and `pageBounds`, shows the pill, and does **not** fire `onPressSegment`.
  3. Clicking a sentence without dragging still fires `onPressSegment`.
- [ ] **Green:**
  - In `source-editor.tsx`, extend `onSelectionChange` to report `{ anchor, head, empty, text, pageBounds }`, computing `text` via `session.textBetween(from, to, "\n")` and `pageBounds` from `session.pageCoordsAtPos(from)` / `session.pageCoordsAtPos(to)` (union rect, falling back to measured editor bounds when unavailable).
  - In `translation-output.tsx` and `aligned-translation.tsx`, wire `onSelectionChange` and `selectionMenu` onto both `<View selectable>` and `<TextView selectable>`. Guard `onPressSegment` so an active non-empty selection (or drag-release within the guard window) suppresses sentence clicks.
- [ ] **Native Windows gate:** Run the test with `--target windows --foreground` and verify visually and interactively in a real Windows window that:
  - Dragging across words does not flash or jitter the pill before stabilization;
  - `Ctrl+C` copies the selected word while the pill is visible;
  - `pageBounds` places the pill cleanly above/below the selected word in both plain and Markdown modes, including wrapped lines.
  - **Stop condition:** If `View selectable` or `TextView selectable` fails to deliver reliable `pageBounds` on Windows, fall back to anchoring the pill at the last pointer release coordinate (`pagePosition`) or container bounds and document the exact NSH finding before proceeding to Task 5.

**Validation:**

- Run (red/green headless): `mise exec -- nsh test src/features/quick-translate/dictionary-selection.test.tsx --filter "dictionary selection native:"`
- Run (Windows native gate): `mise exec -- nsh test src/features/quick-translate/dictionary-selection.test.tsx --target windows --foreground --filter "dictionary selection native:"`
- Expected: headless and Windows native selection assertions pass with zero spurious `onPressSegment` activations and preserved editor focus.

---

### Task 4: Add the whole-word inline dictionary band in Quick Translate

**Seam:** `QuickTranslatePopup` and `createQuickTranslateSession` through `src/features/quick-translate/__tests__/popup-harness.tsx`.

**Outcome:** Entering or delivering a single word or short term with an enabled dictionary channel renders the collapsible `InlineDictionaryBand` above the translation stream in parallel with translation cards, with phonetic TTS playback, copy, retry, and silent hiding for sentences or `not_found`.

**Files:**

- Create: `src/features/quick-translate/dictionary-entry.tsx`
- Create: `src/features/quick-translate/dictionary-band.tsx`
- Modify: `src/features/quick-translate/session.ts`
- Modify: `src/features/quick-translate/popup.tsx`
- Modify: `src/app/quick-translate.tsx`
- Modify: `src/features/quick-translate/__tests__/popup-harness.tsx`
- Modify: `DESIGN.md`
- Modify: `locales/en.yml`
- Modify: `locales/zh-CN.yml`
- Test: `src/features/quick-translate/popup.test.tsx`

**Steps:**

- [ ] **Design first:** Add the **Quick Translate Dictionary** motion inventory to `DESIGN.md` before TSX edits (inline band immediate mount/height fit, disclosure rotation via `motion.disclosureIcon`, phonetic pill hover/press via `motion.pressScale`, `[Look up]` pill via `motion.popupEnter`, drawer immediate mount with no modal backdrop, and reduced-motion fallbacks).
- [ ] **Red:** Extend `popup-harness.tsx` to load `dictionaryChannels` and allow stubbing/inspecting dictionary lookups (calls, aborts, deferred responses). Add `dictionary inline:` tests in `popup.test.tsx` verifying:
  1. With an enabled AI dictionary channel, typing `"ephemeral"` and pressing Enter triggers **both** the inline dictionary lookup and the translation card in parallel; renders phonetics, POS-aligned senses, and collapsed details disclosure; expanding details reveals inflections and examples.
  2. Entering a full sentence (`"This is a complete sentence."`) triggers translation cards and sends **zero** dictionary requests.
  3. A `not_found` dictionary reply hides the inline band silently without showing an error alert, while translation cards stay visible.
  4. Clicking a phonetic speaker pill triggers TTS playback for `entry.term` using `entry.language` (stopping any active card speech), and clicking Copy copies formatted definitions.
  5. Editing source, closing the popup mid-request, or disabling the dictionary channel cancels in-flight inline lookups and drops stale responses.
  6. Restoring a History snapshot hides the inline band; typing again restores live mode.
- [ ] **Green:**
  - Build `DictionaryEntryView` in `dictionary-entry.tsx` (compact mode caps initial visible senses at 4 with a disclosure toggle for extra senses/inflections/examples; uses neutral muted POS columns, `brand` speaker tint, and `t()` labels).
  - Build `InlineDictionaryBand` in `dictionary-band.tsx` (aligned to the `px-4` vertical stream spine, `border-t border-border/70`, optional lemma chip when `entry.term` differs from `queriedTerm`, collapse `+` ↔ `×` toggle, copy, retry).
  - Wire inline dictionary state and request lifecycle into `session.ts` (sharing `resolveActionLanguages` / `detectSourceLanguage` with translation cards so `auto` detection never runs twice) and mount `InlineDictionaryBand` in `popup.tsx`.

**Validation:**

- Run (red/green): `mise exec -- nsh test src/features/quick-translate/popup.test.tsx --filter "dictionary inline:"`
- Expected: tests fail before wiring and pass after; existing translation, auto-translate, TTS, and history tests in `popup.test.tsx` remain green.

---

### Task 5: Add in-popup selection `[Look up]` pill and non-modal docked dictionary drawer

**Seam:** `QuickTranslatePopup`, `DockedDictionaryDrawer`, and `QuickTranslateWindowBody` through `popup-harness.tsx` and `quick-translate-harness.tsx`.

**Outcome:** Selecting a word in the source editor, translation result, back-translation, or history card shows the debounced non-focus-stealing `[Look up]` pill; activating it (or pressing `Alt+D` or choosing the context-menu item) opens the non-modal docked bottom drawer with context-aware language inference, back-stack drill-down, promote-to-input, TTS, `Esc` layering, and `fitContentHeight` support.

**Files:**

- Create: `assets/icons/mdi--arrow-left.svg`
- Create: `assets/icons/mdi--arrow-top-left.svg`
- Modify: `src/components/ui/icon.tsx`
- Modify: `src/features/quick-translate/dictionary-band.tsx`
- Modify: `src/features/quick-translate/history-results.tsx`
- Modify: `src/features/quick-translate/session.ts`
- Modify: `src/features/quick-translate/popup.tsx`
- Modify: `src/app/quick-translate.tsx`
- Modify: `src/features/quick-translate/__tests__/popup-harness.tsx`
- Modify: `src/app/__tests__/quick-translate-harness.tsx`
- Modify: `locales/en.yml`
- Modify: `locales/zh-CN.yml`
- Test: `src/features/quick-translate/popup.test.tsx`
- Test: `src/app/quick-translate.test.tsx`

**Steps:**

- [ ] **Red:** Add `dictionary selection:` tests in `popup.test.tsx` verifying:
  1. Selecting `"agentic"` inside a completed English-to-Chinese result (and in source/back-translation/history) shows `id:quick-translate-lookup-pill` after stabilization without sending any dictionary request yet.
  2. Clicking `id:quick-translate-lookup-pill` (or pressing `Alt+D`) closes the pill and opens `id:quick-translate-dictionary-drawer` with the inferred language pair and extracted `contextSentence`.
  3. Selecting a long sentence (`> 48` chars / `> 4` words) does **not** show the pill.
  4. While the drawer is open, clicking a synonym/inflection inside the drawer—or selecting a second word in the upper translation area and clicking `[Look up]`—pushes a new frame onto the back-stack with `id:quick-translate-dictionary-back`; pressing Back (or `Alt+Left`) restores the previous entry from session cache with zero extra requests.
  5. Clicking Promote (`id:quick-translate-dictionary-promote`) closes the drawer, sets `sourceText` to `entry.term`, expands source if collapsed, and triggers normal translation + inline dictionary.
  6. Mutual exclusion with sentence alignment: selecting text in an aligned result closes `sentencePopover` and clears `activeMatch`; scrolling dismisses the pill while keeping the docked drawer open; a `not_found` lookup in the drawer shows a localized empty message with a Promote-to-translate action.
- [ ] **Red:** Add `dictionary window:` tests in `src/app/quick-translate.test.tsx` verifying `Esc` layering (first `Esc` closes the pill or docked drawer without closing `quick-translate` window; next `Esc` closes the window), focus restoration after closing the drawer, and `fitContentHeight` accounting for `drawerHeight` when open and shrinking back when closed.
- [ ] **Green:**
  - Add `mdi:arrow-left` and `mdi:arrow-top-left` icons.
  - Implement `DockedDictionaryDrawer` in `dictionary-band.tsx` (top hairline separator, compact header with Back / headword / Speak / Anki / Promote / Close, bounded internal `<Scroll class="max-h-60">` hosting `DictionaryEntryView`, subtle context sentence preview when `contextSentence` is present, loading/not_found/error states).
  - Add drawer stack management (`handleLookupSelection`, `handleNavigateDictionaryTerm`, `handleDictionaryBack`, `handleRetryDrawerDictionary`, `handleCloseDictionaryDrawer`, `handlePromoteDrawerTermToSource`, `handleCopyDrawerDictionary`) to `session.ts`; clear drawer on new whole-source delivery (`clipboard`/`selection`/`ocr`) or popup close.
  - Wire cross-region selection handlers in `popup.tsx` (`source`, `result`, `back-translation`, `history`), `180ms` stability timer, `AnchoredPopover` pill (`notifyOverlayOpenChange("dictionary-pill", open)`), `Alt+D` / `Alt+Left` keybindings, and `selectionMenu` handler.
  - Mount `DockedDictionaryDrawer` in `src/app/quick-translate.tsx` between `<Scroll>` and `<QuickTranslateFooter>`, track `drawerHeight` in `fitContentHeight`, register `"dictionary-drawer"` overlay state, and bind `Escape` to dismiss the drawer before the window. Mirror the layout slot in `popup-harness.tsx` and load `dictionaryChannels.load()` in `quick-translate-harness.tsx`.

**Validation:**

- Run (red/green): `mise exec -- nsh test src/features/quick-translate/popup.test.tsx --filter "dictionary selection:"`
- Run (red/green): `mise exec -- nsh test src/app/quick-translate.test.tsx --filter "dictionary window:"`
- Expected: all selection pill, docked drawer, back-stack, promote, sentence-alignment coexistence, `Esc` layering, and height-fit tests pass.

---

### Task 6: Save dictionary entries (word, definition, and context sentence) to Anki Wordbook

**Seam:** Quick Translate inline dictionary band and docked dictionary drawer through `AppShell` (`src/app/quick-translate.test.tsx`), injecting only at the HTTP/Storage boundary for AnkiConnect v1.

**Outcome:** When Anki Wordbook is enabled, both `InlineDictionaryBand` and `DockedDictionaryDrawer` expose an Add to Anki action that writes `entry.term` to `sourceField` and phonetics + definitions + context sentence to `translationField`, sharing the single-in-flight guard and localized error/duplicate feedback.

**Files:**

- Modify: `src/features/quick-translate/session.ts`
- Modify: `src/features/quick-translate/dictionary-band.tsx`
- Modify: `src/features/quick-translate/popup.tsx`
- Modify: `src/app/quick-translate.tsx`
- Modify: `locales/en.yml`
- Modify: `locales/zh-CN.yml`
- Modify: `README.md`
- Test: `src/app/quick-translate.test.tsx`

**Steps:**

- [ ] **Red:** In `src/app/quick-translate.test.tsx`, add `quick anki dictionary:` tests with a seeded enabled Anki target and AI dictionary channel:
  1. Look up a word selected inside a multi-sentence result (`"agentic"` inside `"Cutting-edge intelligence... agentic workflows."`), press `id:quick-translate-dictionary-drawer-anki`. Assert one `notes.create` RPC where `fields[sourceField]` is `"agentic"` and `fields[translationField]` contains the phonetics, formatted definitions, and the extracted context sentence (`<br>`-formatted HTML-safe plain text). Expect `Added to Anki` feedback in the drawer without closing it or stealing focus.
  2. Look up a whole word (`"ephemeral"`) in the inline band and press `id:quick-translate-dictionary-inline-anki`. Assert `fields[sourceField]` is `"ephemeral"` and `fields[translationField]` includes the definition and first example sentence (when returned).
  3. Delay the drawer Anki write and attempt to press a card's Add to Anki button while in flight; assert zero second write starts (shared `ankiInFlight` lock).
  4. Verify duplicate (`validationFailed` with `duplicate`), unconfirmed write, Anki disabled (buttons hidden), and stale result (navigating to another word or closing/reopening window before reply resolves drops old feedback).
- [ ] **Green:**
  - Add `handleAddInlineDictionaryToAnki` and `handleAddDrawerDictionaryToAnki` to `session.ts`, calling `formatDictionaryAnkiNote` and sharing `ankiInFlight`, `sameAnkiTarget`, `windowEpoch`, and `ANKI_FAILURE` mapping with `handleAddToAnki`.
  - Render the Anki action button (`mdi:share-variant-outline` → `mdi:check` with `success` tone on confirmed add) and inline status text in `InlineDictionaryBand` and `DockedDictionaryDrawer` only when `ankiEnabled()` is true and entry lookup succeeded.
  - Update `README.md` with concise documentation of Dictionary setup, whole-word inline lookup, in-popup selection lookup, and Anki context saving.

**Validation:**

- Run (red/green): `mise exec -- nsh test src/app/quick-translate.test.tsx --filter "quick anki dictionary:"`
- Expected: tests fail before wiring and pass after; existing `quick anki:` card tests continue to pass unchanged.

---

## Final Validation

- Run: `mise run verify`
  - Expected: formatting (`format-check`), `lint` (oxlint + Clippy), `check` (Rust + TS), full headless `test`, and `build` all pass with zero warnings or errors.
- Run: `mise exec -- nsh test src/features/quick-translate/dictionary-selection.test.tsx --target windows --foreground`
  - Expected: native Windows selection reporting, non-focus-stealing `[Look up]` pill, and sentence-highlight coexistence pass in a real window.
- Run: `mise exec -- nsh test src/features/settings/settings.test.tsx --target windows --filter "dictionary settings:"`
  - Expected: **Settings → Integrations → Dictionary** renders cleanly on Windows.
- Manual desktop visual and interactive pass via `mise run dev` on Windows in both light and dark appearance and both `en` and `zh-CN` locales (covering the NSH Design Guides Finishing Checklist):
  - Narrow (`340pt`) and default (`420pt`) popup widths: check `px-4` spine alignment, POS column alignment, wrapping, focus rings, and zero overlap in header/drawer/footer.
  - Whole-word lookup (`ephemeral`, `running`, `不可思议`) with parallel AI/DeepL cards, phonetic TTS playback, disclosure expand/collapse, and Anki save.
  - Multi-sentence translation with sentence alignment enabled: verify click opens sentence popover, drag/double-click opens `[Look up]` pill without opening sentence popover, `Ctrl+C` works while pill is open, clicking `[Look up]` opens docked drawer, selecting a second word pushes onto back-stack, `Alt+Left` goes back, Promote fills source, and `Esc` closes pill → drawer → window in order.
  - Verify reduced motion disables pill entrance travel and disclosure rotation while keeping all state transitions understandable.

---

## Failure Behavior

| Condition | Expected behavior |
| --- | --- |
| No dictionary channel configured or enabled | Hide inline dictionary band and selection `[Look up]` pill completely. No requests, no errors, no dead controls. |
| Enabled channel model deleted or unavailable | Inline band and drawer display the localized recovery error (`dictionary.failure.noEligibleModel`) with a Retry action; translation cards stay unaffected. |
| AI returns `{"found": false}` | Inline band (Scenario A) hides silently with no alert; docked drawer (Scenario B) shows a concise muted "No entry found" state plus a **Use as input** button to translate with main engines. |
| AI returns malformed JSON or empty senses | Treat as `malformed_response`; show localized failure message and Retry button. Never render raw model JSON or raw stack traces. |
| Network timeout, rate limit (`429`), or server error | Try next enabled channel in priority order via `runChain`; if all fail, show localized error with manual Retry. No blind auto-retry loop. |
| User edits source, scrolls, switches history, or hides window mid-request | Abort in-flight lookup signal and drop late responses via generation/key checks. |
| TTS disabled when phonetic speaker clicked | Disable phonetic speaker icon with existing `quickTranslate.speakOff` tooltip/label, matching card speaker buttons. |
| Anki duplicate, unreachable, profile mismatch, or unconfirmed write | Show localized status inside the inline band or drawer without closing the drawer; never mark as added on unconfirmed/duplicate outcomes. |

---

## Privacy and Security

- Prompt boundary: keep lookup instructions exclusively in the `system` message; send user term and context sentence as data in the `user` message so selected text cannot rewrite instructions.
- Logging: never log API keys or credentials. All AI requests go through `aiClient.generateText` (`services/http.ts`), keeping request/response bodies at `debug` level only; log only error categories at `warn`/`error`.
- Anki writes stay on `http://127.0.0.1:8765/api/v1` via `createAnkiClient().addTranslation()`, with HTML-escaped plain text (`htmlPlain`) and `logBodies: false`.
- In-popup selection lookups stay in memory (bounded 64-entry session cache cleared on process exit) and are never persisted to translation history or disk.

---

## Rollout Notes

- Demo stage: no legacy data migration is required. New storage key `integrations.dictionary.v1` defaults cleanly to an empty channel list.
- Because Dictionary uses the shared `CapabilityId` registry and `runChain`, Phase 2 offline/API dictionary providers can be added as new `CapabilityChannelDefinition` modules without changing Quick Translate UI or Settings host code.
- If a future phase adds a fast local dictionary channel, Scenario B can optionally upgrade the read-only `[Look up]` pill into an inline single-line Peek bar while preserving the exact same docked drawer for full details.

---

## Risks and Mitigations

- **Windows `onSelectionChange` firing cadence & `pageBounds` accuracy:** Native drag-selection may emit rapidly or omit `pageBounds` on some spans. Mitigation: Task 3 gates this on a real Windows window before popup wiring, applies a `180ms` stability debounce, and specifies a deterministic pointer-anchor fallback if needed.
- **Drag-selection release triggering `AlignedTranslation` `onPressSegment`:** Mouse-up after dragging across a sentence could invoke the sentence click handler. Mitigation: guard `onPressSegment` against active non-empty selections and verify explicitly in Task 3's Windows gate.
- **AI JSON compliance and latency:** Some models wrap JSON in code fences or spend latency on chain-of-thought reasoning. Mitigation: pass `disableReasoning: true` (reusing `aiClient`'s existing `runWithReasoningFallback`), strip accidental code fences in `parseDictionaryResponse`, bound output counts, and cache resolved entries per session.
- **Window height bounce when toggling the docked drawer:** Opening and closing the drawer changes total measured height. Mitigation: mount the drawer as a sibling of `<Scroll>` inside `QuickTranslateWindowBody` so `fitContentHeight` computes `header + content + drawer + footer + ROOT_BORDER_HEIGHT` in one layout pass, and cap drawer scroll height (`max-h-60`) so upper context stays visible.

---

## Open Questions

**Open Questions:** None blocking Phase 1 implementation. Confirm the 6 test seams before starting Task 1. Future follow-ups (explicitly outside Phase 1) include local offline dictionary channels, an optional third Anki "Example" field mapping in Wordbook Settings, and responsive right-side inspector layout on manually widened windows.
