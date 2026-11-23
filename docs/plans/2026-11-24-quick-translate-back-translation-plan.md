# Implementation Plan

**Goal:** Let users translate a Quick Translate card's result back into its source language, then read it aloud, copy it, or close it.

**Inputs:** The requested two-area card layout, the reference image for placement only, the existing My Translator style, and `assets/icons/mdi--reply-outline.svg`.

**Assumptions:**

- Use the same preset engine as the forward translation. AI presets keep their configured model chain and generation settings but use a translation-only prompt. Do not use the selected template, which can ask for grammar checks or other tasks.
- Closing the lower area keeps its completed result in memory for the current forward result. Reopening it makes no request. Do not offer back-translation for an empty result or a pair with the same source and target language.
- Validate the desktop layout on Windows. Do not add settings, a provider picker, formatting buttons, shortcuts, or persistent history.

**Architecture:** The session records both resolved languages when a forward query succeeds. On request, it passes that result's text and the reversed pair to the existing translation service. The session owns the lower result and its request and copy state; the popup renders both areas and uses its existing single speech player.

**Tech Stack:** TypeScript, NSH 0.6.1, `nsh/test`, and mise. No new dependencies, Rust changes, or provider APIs.

---

## Card Layout

```text
  [Existing preset and template controls]
  Forward translation
  ────────────────────────────────────────
  [Speak] [Copy] [↩]                [Retry]
  ────────────────────────────────────────
  Back-translated text
  ────────────────────────────────────────
  [Speak] [Copy]                        [×]
```

The toolbar labels in the sketch stand for icons. Do not add visible button text. Keep the outer card, heading controls, text style, spacing, and theme. Use the same body inset and compact ghost toolbar in both areas. The reply button follows forward copy; the lower toolbar has speak and copy on the left and close on the right. The lower area is absent until requested. It has no title, language line, new background, or nested card. Loading and error text replace the lower body only.

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Modify | `features/quick-translate/session.ts` | Record the resolved pair. Own the lower request, result, visibility, and copy feedback by card. |
| Modify | `features/quick-translate/translate.ts` | Add a translation-only request purpose for AI. Keep existing provider dispatch and credential access. |
| Modify | `features/quick-translate/popup.tsx` | Add the reply action and lower area. Route speech to the correct result. |
| Modify | `components/ui/icon.tsx` | Register `mdi:reply-outline` from `assets/icons/mdi--reply-outline.svg`. Close uses the existing `close` icon. Include the supplied asset in the feature change. |
| Modify | `locales/en.yml`, `locales/zh-CN.yml` | Add action labels, status, and lower copy feedback under `quickTranslate`. |
| Modify | `.stitch/DESIGN.md` | Record the Quick Translate motion inventory before TSX edits. |
| Test | `features/quick-translate/popup.test.tsx` | Drive card actions through `QuickTranslatePopup`. Check rendered results, network requests, clipboard, and audio. |

## Seams

- `QuickTranslatePopup` through `features/quick-translate/__tests__/popup-harness.tsx` — card actions, layout states, and request lifetime.
- Provider HTTP, clipboard, and audio through `nsh/test` — verify reversed request data, the copied text, and the text and voice language sent to TTS. Use the existing harness and network fixtures. Do not replace the session or the translation service for these tests.

Confirm these seams before writing tests. Prefix the new test names with the filter in each task. For each scenario, run the specified command before implementing the behavior, then run it again. Red must be the named assertion failing, not a compile error.

## Tasks

### 1. Translate a completed card result in reverse

**Seam:** Popup controls and provider HTTP.

- [ ] **Red:** With explicit English and French, enter `Good morning` and return `Bonjour` from the provider. Press `quick-translate-back-translate`. Check that the next provider request sends `Bonjour` as the text, with French as source and English as target. Return `Hello` and check that both `Bonjour` and `Hello` remain visible in that card. Check that a selected AI grammar template affects the forward request but not the reverse request.
- [ ] **Green:** Add `sourceLanguage: LanguageId` to `CardResultState` success and record it with `targetLanguage` from `resolveActionLanguages`. Add `handleBackTranslate(cardId)` to `QuickTranslateSession`. For a nonblank success with distinct languages, send the stored result text and reversed pair through `runTranslate`. Do not read the input box, run language detection again, or edit the popup's language selection. Give the card a separate reverse state: closed, loading, success, or error. Track the active reverse request independently of the forward query.
- [ ] **Green:** Add `purpose?: "back-translation"` to `TranslateWithPresetInput`. In the AI branch, use a built-in system instruction to translate from `{{source_language}}` to `{{target_language}}` and return only the translation. Use `{{text}}` as the user template. Reuse `renderPromptTemplate`, the model chain, and existing generation options. Return `templateId: null` for this purpose. Leave normal template execution and DeepL and Google Cloud dispatch unchanged.
- [ ] **Green:** Record motion in `.stitch/DESIGN.md`: use existing button press, focus, and tooltip styles; add or remove the lower area in the current scroll region without a new layout animation. In `popup.tsx`, use `Button` (`ghost`, `icon-xs`), `Icon`, and `TranslationOutput` with the existing Markdown setting. Use `quickTranslate.backTranslate` (`Back-translate` / `回译`) for the reply tooltip and accessible name, and `quickTranslate.backTranslating` (`Back-translating…` / `正在回译…`) for loading. Do not publish partial reverse output. Keep the forward retry action unchanged.
- [ ] **Next cycles:** Cover Auto source and target: reverse the pair used by the forward call and assert no second detector call. Cover a DeepL card and a Google Cloud card using their saved credentials and reversed wire codes. Check that idle, streaming, failed, blank, and same-language results do not offer the reply action.

**Red/green:** `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "back-translation: request"` — expect the missing action, result, or request assertion to fail first; all request cases must then pass.

### 2. Close, reopen, and retry without changing the forward result

**Seam:** Popup controls and provider HTTP.

- [ ] **Red:** Complete a reverse request, press `quick-translate-close-back-translation`, and check that only the lower area closes. Press reply again. Check that the same result returns without another request. In a separate test, close a loading result, resolve its response late, and check that it does not reappear. Reopening after cancellation must start a new request.
- [ ] **Green:** Add `handleCloseBackTranslation(cardId)`. Bind the lower result to the exact selected forward query, not just the text. Keep one current lower result per card. On close, cancel an active request and clear lower feedback. Keep a success for reuse; discard a failure so opening again starts a fresh attempt. Keep the reply button in the upper toolbar. Repeated activation while the lower area is open must not create another request. Add the lower-right `close` icon with `quickTranslate.closeBackTranslation` (`Close back-translation` / `关闭回译`). Keep keyboard focus on reply when opening and return it there when closing with the lower close button.
- [ ] **Next cycles:** On a reverse provider error, show a localized inline error and a lower retry button using the existing refresh icon. Its tooltip and accessible name use `quickTranslate.retryBackTranslation` (`Retry back-translation` / `重试回译`). Keep close available during loading and failure. Add `handleRetryBackTranslation(cardId)` for the open error state; it repeats only the reverse request. Treat a blank reverse response as a failure and use `quickTranslate.error.emptyBackTranslation` (`No back-translation returned.` / `未返回回译文。`). A forward retry or a template, preset, input, or language change clears the lower result when the existing session replaces or invalidates the forward result. Collapse closes the lower area and cancels active reverse work. Keep a completed lower result only while the same forward query survives. Card removal and popup cleanup clear it. Guard late updates with both request and forward query identity. Reordering or acting on another card must not change the first card's result.

**Red/green:** `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "back-translation: lifetime"` — expect the close, reuse, retry, or stale-response assertion under test to fail first; all lifetime cases must then pass.

### 3. Copy only the lower text

**Seam:** Popup copy buttons and `app.clipboard()`.

- [ ] **Red:** With distinct forward and reverse text, press `quick-translate-copy-back-translation`. Check the clipboard and the lower success checkmark. Press forward copy and check that it still copies only the forward text. Check that neither action sets feedback for the other.
- [ ] **Green:** Add `handleCopyBackTranslation(cardId)`. Call the session's existing clipboard boundary with the lower success text. Reuse the existing copied-state timing and check icon, with separate lower feedback and timer. A late success or failure must not update a closed or replaced result. Add `quickTranslate.copyBackTranslation` (`Copy back-translation` / `复制回译文`) and `quickTranslate.backTranslationCopied` (`Back-translation copied` / `已复制回译文`). On copy failure, show `quickTranslate.error.copyBackTranslationFailed` (`Could not copy the back-translation.` / `无法复制回译文。`) next to the lower toolbar. Show no lower copy button before a nonblank success.

**Red/green:** `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "back-translation: copy"` — expect the lower copy or feedback assertion to fail first; it must then pass.

### 4. Read the lower result aloud in the resolved source language

**Seam:** Popup speech buttons, TTS HTTP, and audio commands.

- [ ] **Red:** With forward French text and reverse English text distinct from the input, press `quick-translate-speak-back-translation`. Check the TTS request for the reverse result's text and an English voice. Verify that opening the lower area does not start playback. Close it during a delayed TTS response and check that no player opens; in a separate test, close it during playback and check that audio stops.
- [ ] **Green:** Reuse `SpeakerButton`, `runSpeech`, and the active TTS binding. Identify speech owners and error feedback by card and result area. Use the forward result's stored source language, not current input detection. Keep one player: a new speech action replaces the previous one. Closing or invalidating the lower area stops its speech only. Keep existing unavailable, cancel, stop, and playback error behavior scoped to the correct area. Use `quickTranslate.speakBackTranslation` (`Read back-translation aloud` / `朗读回译文`) for the ready action. Show it only for a nonblank lower success.

**Red/green:** `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "back-translation: speech"` — expect the lower text, voice, or playback assertion to fail first; all speech cases must then pass.

## Final Validation

- [ ] Run `mise exec -- nsh test features/quick-translate/popup.test.tsx`; all new and existing popup tests pass.
- [ ] Run `mise run verify`; format, lint, type checks, tests, and build pass.
- [ ] Run `mise run dev` on Windows. Check light and dark at the default and narrow popup widths. Take before and after screenshots. Check the current theme, card radius, typography, equal body insets, toolbar alignment, and existing scroll area with long results. Confirm that the closed state adds no height, and the open state has no visible title or language line. Check loading, retry, copied, disabled, hover, pressed, and focus states, plus the recorded motion with and without reduced motion.
- [ ] Use Tab and Enter or Space to open, copy, speak, and close. Verify focus returns to reply on close and that Narrator distinguishes the upper and lower actions. Check that the card collapse, remove, and forward retry controls still operate as before.

## Failure Behavior

- Reverse translation failure affects the lower area only. Retrying it does not retransmit the original input or start a new forward query.
- Closing, removing, or replacing a result aborts obsolete work or discards its late response. Copy and speech failures stay with the text that caused them.

## Privacy and Rollout

- Only a user action starts a reverse translation. It sends the forward result to the selected preset's configured provider or AI fallback chain. Only a separate speech action sends the lower result to the active TTS channel. Do not add logs that contain text, prompts, request bodies, or credentials.
- Use the current credential paths. Do not add storage keys, preference fields, migration, or configuration steps. Automated tests use synthetic text and credentials.

## Open Questions

None. The preset and session-cache choices above are implementation assumptions, not new UI settings.
