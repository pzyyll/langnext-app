# Implementation Plan

**Goal:** Add Settings > Integrations > Text-to-Speech with one Google Cloud channel. Use the OCR configuration and enable flow. Connect the Quick Translate source and result speaker buttons in the same release.

**Inputs:** The Settings and Quick Translate requests, the current OCR settings in `features/settings/ocr-section.tsx` and `features/ocr/settings.ts`, the speaker placeholders in `features/quick-translate/popup.tsx`, and the [Cloud TTS v1 synthesize reference](https://cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize).

**Assumptions:**

- Settings can play a fixed English sample. Quick Translate sends only the source text or the completed result the user chooses to hear. Manual voice selection, SSML, Gemini TTS, streaming, long-text splitting, and audio export are out of scope.
- One channel needs no reorder controls, priority badges, or fallback. This release uses one documented Standard voice per supported language and does not guess a voice for an unsupported language.
- Use a user-supplied Cloud API key if the live check below passes. Windows is the desktop acceptance target. Use the same settings on other desktops and check audio availability at run time. Mobile, web, and TUI are out of scope.

**Architecture:** `SettingsPage` owns list/detail navigation. The TTS store owns channel settings and enablement. The Settings detail and Quick Translate popup each own their speech operation and share the Cloud adapter and local player. The adapter returns MP3 bytes; a disposable NSH `AudioPlayer` plays a temporary local file, including clips longer than the `Sound` limit of five seconds.

**Tech Stack:** TypeScript, NSH 0.6.1, NSH Storage and `AudioPlayer`, Cloud Text-to-Speech REST v1, `nsh/test`, and mise. No new package or Rust code is planned.

---

## Before implementation: verify authentication and playback

The [Cloud TTS authentication guide](https://cloud.google.com/text-to-speech/docs/authentication) documents OAuth for REST. Google's [generated TTS client reference](https://googleapis.dev/nodejs/googleapis/latest/texttospeech/interfaces/StandardParameters.html) also describes an API key parameter, but this does not prove that a restricted key alone works for `text:synthesize`.

- [ ] With approval and a user-owned Cloud project with billing and Cloud Text-to-Speech enabled, send one `POST https://texttospeech.googleapis.com/v1/text:synthesize` using the sample body in Task 1. Use a key restricted to Cloud Text-to-Speech in the `x-goog-api-key` header, with no OAuth token and no key in the URL. Expect HTTP 200 and nonempty MP3 bytes.
- [ ] Do not finalize the key form until this check passes. If there is no authorized test project or a correctly restricted key fails, report the blocker and confirm the authentication method. Do not switch to an unrestricted key, add OAuth silently, or use a Gemini API key. Do not put the key in a command history, test fixture, screenshot, or report.
- [ ] Before wiring either view, verify on the pinned Windows host that `AudioPlayer` can play a local MP3 longer than five seconds from `process.dataDir`, via `pathToFileURL`, and that disposing the player lets the app remove the file. Use nonsensitive audio and a path with a space or non-ASCII characters. If this fails, revise the playback approach before implementing the UI; do not shorten or silently truncate Quick Translate audio to meet `Sound` limits.

## File map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `features/tts/google-cloud.ts` | Cloud v1 request and typed result. |
| Test | `features/tts/google-cloud.test.ts` | Request contract, UTF-8 limits, failure and cancellation. |
| Create | `features/tts/settings.ts` | Saved channel, credential reference, enablement, and persistence. |
| Test | `features/tts/settings.test.ts` | Public store operations, failed writes, and reload. |
| Create | `features/tts/playback.ts` | Shared MP3 playback and temporary-file lifetime. |
| Create | `features/tts/google-voices.ts` | Verify and map app language IDs to Google Standard voices. |
| Create | `features/settings/tts-section.tsx` | Channel list, masked form, and sample playback. |
| Modify | `features/settings/page.tsx`, `App.tsx` | Integrations entry and breadcrumb; load TTS settings and clean up old playback files before mount. |
| Modify | `features/quick-translate/session.ts` | Keep the resolved target language with each completed result. |
| Modify | `features/quick-translate/popup.tsx`, `app/quick-translate.tsx` | Wire source and per-card speakers; cancel on hide and exit. |
| Modify | `locales/en.yml`, `locales/zh-CN.yml` | Settings and Quick Translate speech copy and accessibility labels. |
| Test | `features/settings/settings.test.tsx` | List/detail, save and toggle, and sample playback through the app. |
| Test | `features/quick-translate/popup.test.tsx`, `features/quick-translate/__tests__/popup-harness.tsx` | Source and result playback, language selection, and cancellation. Load TTS settings in the harness. |
| Test | `app/quick-translate.test.tsx`, `app/__tests__/quick-translate-harness.tsx` | Verify playback stops when the floating window closes or hides. Load TTS settings in the window harness. |
| Modify | `docs/ui/DESIGNE.md` | Settings and Quick Translate behavior, motion, and desktop validation. |

## Seams

- `createGoogleCloudTtsClient({ fetchImpl }).synthesize({ apiKey, text, languageCode, voiceName }, { signal, timeoutMs })` — submits the v1 request and returns MP3 bytes or a typed failure.
- `createTtsSettingsStore(storage)` — loads and saves the channel, toggles it, and reads the key by reference without exposing it in the channel record.
- Settings UI through `open("../../App.tsx", …)` from `features/settings/settings.test.tsx` — navigation, masked edits, persisted enablement, and playback observed through the headless network and speaker boundaries.
- Quick Translate popup and floating window through the existing test harnesses — speaker actions select the correct text and language, and cancel on stop, invalidation, or hide.

Confirm these seams with the plan before writing tests. For each task, run its test command after adding each case and again after its implementation. Expect the named behavior to fail first, then pass. If needed, add only the public signature before the first run so the red check fails on behavior, not an unresolved import.

## Tasks

### Task 1: Synthesize MP3 audio

**Seam:** `createGoogleCloudTtsClient().synthesize(...)`.

- [ ] **Red:** In `features/tts/google-cloud.test.ts`, follow the fetch fixture pattern in `features/ocr/baidu.test.ts`. Assert one POST to the fixed v1 endpoint with `x-goog-api-key`, `Content-Type: application/json`, no query key, and `redirect: "error"`. Return an MP3 fixture and expect its bytes, not the base64 string.
- [ ] **Green:** In `features/tts/google-cloud.ts`, use `FetchLike` from `modules/ai/runtime/http.ts` and default to real `fetch`. Send `input: { text }`, `voice: { languageCode, name: voiceName }`, and `audioConfig: { audioEncoding: "MP3" }`. Return a discriminated result: success with `Uint8Array` MP3 bytes, failure with a stable error code, or cancellation. Do not expose the raw response or exception. The sample is `This is a voice sample.` with `en-US` and `en-US-Standard-C` from the [supported voices list](https://cloud.google.com/text-to-speech/docs/list-voices-and-types).
- [ ] **Next cycles:** Reject blank text and text longer than [5,000 UTF-8 bytes](https://cloud.google.com/text-to-speech/quotas) before fetch. Test 5,000 and 5,001 bytes, including multi-byte input. Do not truncate or send separate requests for one text. Bound the JSON response to 8 MiB before parsing, including when `Content-Length` is absent. Decode nonempty `audioContent` with `atob`; reject malformed base64. Report decode failures from the player as playback errors. Use a 15-second deadline for the request and body read, pass through caller cancellation, and ignore any late response. Test auth, quota, malformed data, cancellation, and timeout in separate red/green cycles. Do not retry automatically.
- [ ] **Red/green:** `mise exec -- nsh test features/tts/google-cloud.test.ts` — expect the new request, bytes, or failure assertion to fail first, then pass without a live Google request.

### Task 2: Persist the channel and its enabled state

**Seam:** `createTtsSettingsStore(storage)`.

- [ ] **Red:** In `features/tts/settings.test.ts`, load an empty store. Expect no channel configuration and `isEnabled()` false, and expect `setEnabled(true)` to fail. Save a nonblank key, reload from the same storage, and expect a configured, enabled channel. Disable it, replace the key, and reload; expect it to stay off.
- [ ] **Green:** In `features/tts/settings.ts`, export a factory and a production `ttsSettingsStore` that uses NSH `Storage`. Use `settings.tts.v1` for `{ version: 1, googleCloud: { enabled, credentialRef } | null }` and `settings.tts.credentials.<uuid>` for the key. Expose `load`, `loadError`, `savedBinding`, `isEnabled`, `saveGoogleCloud({ apiKey })`, `setEnabled`, and `readGoogleCloudKey(ref)`. Trim the draft before storage. First successful save enables the channel. Later saves preserve its current enabled state. Serialize writes and update reactive state only after persistence succeeds. A toggle changes only the channel record.
- [ ] **Next cycles:** Reject enabling when the referenced key is missing or unreadable; allow disabling a broken channel. Write a new credential before a replacement binding, retain the old binding on failure, and make a best-effort cleanup of an unused new key. After success, remove the old credential on a best-effort basis. Test both write failures and confirm the previous key is still usable after reload. Missing settings start off; malformed settings report a load error and remain off. Do not load the secret with the binding at startup.
- [ ] **Red/green:** `mise exec -- nsh test features/tts/settings.test.ts` — expect the new save, enable, or rollback assertion to fail first, then pass. Use the injected storage interface, as in `features/ocr/settings.test.ts`.

### Task 3: Add the OCR-style settings interaction

**Seam:** Settings UI through `App.tsx`.

- [ ] **Red:** In `features/settings/settings.test.tsx`, add `tts settings:` cases. Open Settings and select `settings-nav-tts` under Integrations. Expect one `Google Cloud Text-to-Speech` row, a disabled off switch, and the configure action. Enter the detail view from the row or chevron and verify the `Text-to-Speech > Google Cloud Text-to-Speech` breadcrumb. Go back via the breadcrumb and via the rail item; verify draft disposal and row focus restoration where supported.
- [ ] **Green:** Before editing TSX, record the Settings motion inventory below in `docs/ui/DESIGNE.md`. In `features/settings/page.tsx`, add `tts` after OCR in the Integrations group and a local detail selection with the existing header padding and breadcrumb. In `App.tsx`, load `ttsSettingsStore` alongside `ocrSettingsStore`. In `features/settings/tts-section.tsx`, reuse OCR's row and detail composition (`Card`, `Avatar`, `Button`, `Switch`, `Input`, `FormField`, and `toast`) and the existing `assets/icons/google-cloud.svg`. Do not change OCR or extract a shared channel framework. Use `settings-tts-open-google-cloud`, `settings-tts-toggle-google-cloud`, `settings-tts-breadcrumb-root`, `settings-tts-api-key`, and `settings-tts-save` as test IDs. Localize list summaries, focusable control names, tooltips, and alerts with `t()` in both locale files. Use `Text-to-Speech` / `语音合成` for the section and `Google Cloud Text-to-Speech` for the channel.
- [ ] **Next cycles:** Save a synthetic key and verify first-save enablement, then toggle off, reopen, replace the key, and verify it remains off. The UI must never prefill the saved key; show a masked placeholder when readable. An empty draft makes no change. Leaving the detail or saving successfully clears the draft. A failed save retains the draft for retry and leaves the current channel in place. A missing key shows recovery text and never leaves the user unable to turn the channel off. A toggle write failure keeps the last confirmed state. Save and toggle never make a Cloud request: an enabled switch means the channel is locally configured, not that Google has accepted the key.
- [ ] **Red/green:** `mise exec -- nsh test features/settings/settings.test.tsx --filter "tts settings:"` — expect the new route or state assertion to fail first, then pass. `mise exec -- nsh test features/settings/settings.test.tsx --filter "ocr settings:"` must also pass.

### Task 4: Play a sample only on request

**Seam:** Settings UI through `App.tsx`, using the headless network and speaker boundaries.

- [ ] **Red:** In `features/settings/settings.test.tsx`, add `tts preview:` cases. Seed a readable saved key, stub the POST with MP3 bytes, and press `settings-tts-preview`. Assert one request with the fixed sample and that `app.audio()` records an open for the local player. Use `app.endAudio()` to confirm return to idle. Opening the form, editing or saving a key, and toggling the channel make no synthesis request. Preview tests the saved key, not the draft, and works even when the channel is off. Disable it until an unsaved key edit is saved or cleared.
- [ ] **Green:** In `features/tts/playback.ts`, use `AudioPlayer.available()` and require an app data directory. Write the received MP3 with `fs/promises.writeFile` to an app-owned `tts-playback` directory below `process.dataDir`, using a random filename. Open the local `file:` URL with `AudioPlayer`, call `play()`, and handle `end` and `error`. Dispose before deleting the file with `unlink`. Do this on end, error, stop, or owner exit; delete a file if its write completes after cancellation. In `App.tsx`, run best-effort startup cleanup before mount. Delete only the MP3 files with the app's generated filename pattern in that directory. Do not persist filenames in settings or delete anything outside this directory.
- [ ] **Green:** In `features/settings/tts-section.tsx`, add `Play sample` / `播放示例` near Save and explain that it sends a short English sample to Google. Use the saved key and the shared player. Disable Preview with a localized reason when playback is unavailable. Disable key edits and Save during preview. Show Cancel while loading and Stop while playing. Abort on exit and ignore stale synthesis or playback completions.
- [ ] **Next cycles:** Test auth failure, exit before the response, and exit during playback. Expect no player for a failed or stale response, and a closed player after exit. Verify file cleanup on Windows; headless `app.audio()` does not prove decoder support or removal of a locked file.
- [ ] **Red/green:** `mise exec -- nsh test features/settings/settings.test.tsx --filter "tts preview:"` — expect the new preview, error, or cancellation assertion to fail first, then pass.

### Task 5: Speak the source and the selected result in Quick Translate

**Seam:** The existing Quick Translate popup harness, with synthetic HTTP and audio boundaries.

- [ ] **Red:** In `features/quick-translate/popup.test.tsx`, add a `quick tts:` case. Load TTS settings in `features/quick-translate/__tests__/popup-harness.tsx` and seed the enabled binding in the test. With Auto-translate off and an explicit source language, press `quick-translate-speak-source` before translating. Expect one Cloud TTS request with exactly the full source, its Google voice, and no translation request. After a successful translation, press `quick-translate-speak-result` within a specific `quick-translate-card-{id}` and expect only that card's completed result and target voice.
- [ ] **Green:** Record the Quick Translate motion inventory below in `docs/ui/DESIGNE.md` before editing TSX. Replace its description of the disabled speakers. In `features/quick-translate/popup.tsx`, replace both placeholders with the existing icon buttons in their current locations. Keep the source speaker in both full and collapsed source views for nonblank text; speak the whole text, not only the first line. Keep the result speaker only on an expanded card with a nonblank successful result, not loading, streaming, or partial error output. Use the saved enabled channel and recheck its binding and key before each request. If off or not configured, retain disabled buttons with a reason that points to Settings. In enabled tooltips, state that the action sends the selected text to Google. A key read or request failure shows a localized inline alert beside the affected text without changing source, result, or translation state.
- [ ] **Green:** In `features/quick-translate/session.ts`, keep `resolvedPair.targetLanguage` on the successful `CardResultState` at the point where `outcome.text` is saved. A result uses this stored target, never the current header or app locale. A source uses the selected language, or `sourceDetection().language` if Auto has resolved for the current text. If Auto is unresolved, ask the user to choose a source language. Offer Translate first only if Language Detection is configured. Do not start an additional detection or translation request from the speaker. In `features/tts/google-voices.ts`, map concrete `LanguageId` values to documented Standard `{ languageCode, voiceName }` pairs; for example, use `en-US` for `en` and `cmn-CN` for `zh`. Use only pairs in the [supported voices list](https://cloud.google.com/text-to-speech/docs/list-voices-and-types); give a local unsupported-language message for IDs without a mapping. Never send `auto`, guess a voice, or fall back to English.
- [ ] **Next cycles:** Verify Auto source uses the resolved source and Automatic target uses the successful card's resolved target. Verify selection among multiple results and no request for off, unsupported language, unresolved Auto, and over-limit text. Confirm no speech on translation completion, OCR, clipboard delivery, or language change. Keep the previous non-TTS tests for the unconfigured state.
- [ ] **Red/green:** `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "quick tts:"` — expect the source, card payload, or no-request assertion to fail first, then pass.

### Task 6: Stop or replace Quick Translate playback

**Seam:** Quick Translate popup and floating window through the existing test harnesses.

- [ ] **Red:** Add `quick tts:` cases to `features/quick-translate/popup.test.tsx`. Delay the source response, press a result speaker, and then release the source response. Only the result may play. Press the active result speaker again and verify that playback closes without a new Google request. In `app/quick-translate.test.tsx`, test closing the native window while loading and hiding it for screenshot selection during playback using `app/__tests__/quick-translate-harness.tsx`. Expect no late audio after reopening.
- [ ] **Green:** Keep one speech operation for the popup, keyed by source or card ID and the text/language snapshot. Use the same button for Cancel while loading and Stop while playing. Selecting another speaker aborts or stops the previous one. Cancel the active operation on source changes, changes to its language or target result, collapse/removal of the active result, channel disable/key replacement, or popup disposal. For a native hide that does not dispose the view, pass window visibility from `app/quick-translate.tsx` (`attachedWindow()?.state()?.visible`) and cancel when hidden, including OCR capture. Preserve existing Escape behavior. Ignore old fetch/player completions and do not resume on show.
- [ ] **Next cycles:** Cover edits during playback, result replacement, and disabling the channel in Settings while the popup is pinned. Verify the speaker tooltip and accessible name change with Cancel and Stop.
- [ ] **Red/green:** `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "quick tts:"` and `mise exec -- nsh test app/quick-translate.test.tsx --filter "quick tts:"` — expect stale audio, missing Stop, or hide cancellation assertions to fail first, then pass.

## Motion inventory

| Change | Existing tool and tokens | Reduced motion |
| --- | --- | --- |
| Settings section selection and breadcrumb swap | Settings nav feedback; header changes immediately. | Instant. |
| Channel list or detail enters | `createMotion` with `motion.pageEnter`, as in OCR. The page background stays opaque. | Instant. |
| Row, breadcrumb, chevron, Save, and Preview hover or press | `navigationFeedback`; shared icon and action buttons use `pressScale`. Input keeps its focus ring. | Instant color; no scale. |
| Enable switch changes | `navigationFeedback` and `switchThumb`; use the existing disabled-switch tooltip. | Instant. |
| Save confirmation | Shared toast motion. | Instant; no slide. |
| Validation, saved-key summary, and Preview/Cancel/Stop state | Immediate updates. No new progress animation, overlay, gesture, or layout motion. | No change. |
| Quick Translate source and result speakers | Keep compact icon button size, existing hover/press feedback and `tooltip` opacity. Replace the speaker glyph with the existing `close-circle` glyph while Cancel or Stop is available. | Instant feedback; no scale. |
| Quick Translate synthesis, playback, and errors | Update glyph, tooltip, accessible name, and inline alert immediately. No new animation, progress bar, sound effect, or change to window dismissal. | No change. |

## Failure behavior

| Condition | Result |
| --- | --- |
| Channel off, no saved key, unreadable key, or local storage failure | Quick Translate requires an enabled channel and a readable key; preview requires a readable key only. Explain how to enable, save, or replace the key. Keep the last confirmed enablement on a failed write. |
| Source unset, unsupported language, or text over 5,000 UTF-8 bytes | Show local recovery: select a source language or translate first, use a supported language, or shorten the text. Do not send it to Google. |
| HTTP 401/403 or a Google `API_KEY_INVALID` reason | Ask the user to check the key, Cloud TTS API access, and project billing. Do not show provider text. |
| HTTP 429 | Explain the quota or rate limit. Allow a manual retry. |
| Network failure, timeout, other HTTP rejection, malformed audio, or playback failure | Show a localized inline error next to Preview or the selected text. Preserve channel enablement and the translation state. |
| Explicit cancel or leave | Do not show an error or play a late response. |

## Privacy and rollout

- The only synthesis destination is `texttospeech.googleapis.com`. Preview sends the fixed sample. Quick Translate sends only the original or completed result selected by an explicit speaker press. Clipboard and OCR deliveries never start speech; their text can be sent only if the user presses its speaker. Do not send clipboard metadata, images, prompts, or text from other cards.
- Store synthesized audio in the app's temporary playback directory only while it is needed. Do not save the input text, MP3 bytes, or filenames in history, preferences, logs, or telemetry. A crash can leave an MP3 until the next launch cleanup.
- Use the header form recommended in [Google's API-key guidance](https://cloud.google.com/docs/authentication/api-keys-best-practices). Do not bundle an app-owned key. The separate NSH Storage entry follows the OCR pattern and is **not encrypted**. State this next to the key field. Treat local storage and backups as sensitive. Do not log keys, request bodies, or audio. Do not add credential import/export or sync.
- New installations and existing installations start unconfigured; Quick Translate does not send any speech requests until the user enables the channel and presses a speaker. No migration or change to OCR or the language detector.

## Final validation

- [ ] Run `mise run verify`. Expect format, lint, type checks, Rust and headless tests, and build to pass.
- [ ] Run `mise exec -- nsh test features/settings/settings.test.tsx --filter "tts settings:" --target windows` for native-capable settings cases. Keep any storage failure simulation that requires `OpenOptions.modules` in a separate headless case. Use `mise run dev` to review light and dark appearances, English and Simplified Chinese, and both `1040 × 720` and `720 × 520`. Check tokens, spacing, masking, focus, labels, hover, pressed, disabled, errors, and reduced motion. Record any Windows keyboard or screen-reader limits rather than inferring support from headless tests.
- [ ] With an authorized Cloud project, save and reopen the channel, play the sample audibly on Windows, and verify Stop and back navigation. Play source and result text in different languages in Quick Translate, including a clip longer than five seconds. Verify one active clip in the popup, Stop, hide, reopen without resuming, and no request on save, toggle, or translation completion. Inspect the two speaker locations in light and dark, both locales, and reduced motion. Confirm finished and cancelled MP3 files are removed. If live authentication or sound cannot be verified, record the missing evidence separately from the headless passes.

**Open checks:** Confirm API-key-only authentication and local MP3 playback on the pinned Windows host before wiring the UI. Neither has been live-tested for this plan.
