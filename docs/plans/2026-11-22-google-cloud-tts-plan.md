# Implementation Plan

**Goal:** Add Settings > Integrations > Text-to-Speech with one Google Cloud Text-to-Speech channel, using the OCR list, detail, and enable flow.

**Inputs:** The request for Settings > Integrations > Text-to-Speech, the current OCR settings in `features/settings/ocr-section.tsx` and `features/ocr/settings.ts`, and the [Cloud TTS v1 synthesize reference](https://cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize).

**Assumptions:**

- This release configures the channel and plays a short sample on demand in Settings. Leave the source and result speaker placeholders in `features/quick-translate/popup.tsx` disabled. No translation text is sent to Google in this release.
- One channel needs no reorder controls, priority badges, or fallback. A fixed Standard voice is sufficient for the sample. Voice selection, SSML, Gemini TTS, streaming, and audio export are out of scope.
- Use a user-supplied Cloud API key if the live check below passes. Windows is the desktop acceptance target. Use the same settings on other desktops and check sound availability at run time. Mobile, web, and TUI are out of scope.

**Architecture:** `SettingsPage` owns list/detail navigation. The TTS store owns the saved channel and enabled state. The detail view owns the masked input and the sample operation. A Cloud TTS adapter converts one HTTPS response into WAV bytes; NSH plays them from memory.

**Tech Stack:** TypeScript, NSH 0.6.1, NSH Storage and `Sound`, Cloud Text-to-Speech REST v1, `nsh/test`, and mise. No new package or Rust code is planned.

---

## Before implementation: verify authentication

The [Cloud TTS authentication guide](https://cloud.google.com/text-to-speech/docs/authentication) documents OAuth for REST. Google's [generated TTS client reference](https://googleapis.dev/nodejs/googleapis/latest/texttospeech/interfaces/StandardParameters.html) also describes an API key parameter, but this does not prove that a restricted key alone works for `text:synthesize`.

- [ ] With approval and a user-owned Cloud project with billing and Cloud Text-to-Speech enabled, send one `POST https://texttospeech.googleapis.com/v1/text:synthesize` using the sample body in Task 1. Use a key restricted to Cloud Text-to-Speech in the `x-goog-api-key` header, with no OAuth token and no key in the URL. Expect HTTP 200 and nonempty WAV bytes.
- [ ] Do not finalize the key form until this check passes. If there is no authorized test project or a correctly restricted key fails, report the blocker and confirm the authentication method. Do not switch to an unrestricted key, add OAuth silently, or use a Gemini API key. Do not put the key in a command history, test fixture, screenshot, or report.

## File map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `features/tts/google-cloud.ts` | Cloud v1 request and typed result. |
| Test | `features/tts/google-cloud.test.ts` | Request contract, UTF-8 limits, failure and cancellation. |
| Create | `features/tts/settings.ts` | Saved channel, credential reference, enablement, and persistence. |
| Test | `features/tts/settings.test.ts` | Public store operations, failed writes, and reload. |
| Create | `features/settings/tts-section.tsx` | Channel list, masked form, and sample playback. |
| Modify | `features/settings/page.tsx`, `App.tsx` | Integrations entry and breadcrumb; load TTS settings before mount. |
| Modify | `locales/en.yml`, `locales/zh-CN.yml` | `settings.sections.tts` and all `settings.tts.*` copy. |
| Test | `features/settings/settings.test.tsx` | List/detail, save and toggle, and sample playback through the app. |
| Modify | `docs/ui/DESIGNE.md` | Settings behavior, motion inventory, and desktop validation. |

## Seams

- `createGoogleCloudTtsClient({ fetchImpl }).synthesize({ apiKey, text, languageCode, voiceName }, { signal, timeoutMs })` — submits the v1 request and returns WAV bytes or a typed failure.
- `createTtsSettingsStore(storage)` — loads and saves the channel, toggles it, and reads the key by reference without exposing it in the channel record.
- Settings UI through `open("../../App.tsx", …)` from `features/settings/settings.test.tsx` — navigation, masked edits, persisted enablement, and playback observed through the headless network and speaker boundaries.

Confirm these seams with the plan before writing tests. For each task, run its test command after adding each case and again after its implementation. Expect the named behavior to fail first, then pass. If needed, add only the public signature before the first run so the red check fails on behavior, not an unresolved import.

## Tasks

### Task 1: Synthesize a short WAV response

**Seam:** `createGoogleCloudTtsClient().synthesize(...)`.

- [ ] **Red:** In `features/tts/google-cloud.test.ts`, follow the fetch fixture pattern in `features/ocr/baidu.test.ts`. Assert one POST to the fixed v1 endpoint with `x-goog-api-key`, `Content-Type: application/json`, no query key, and `redirect: "error"`. Return a WAV fixture and expect its bytes, not the base64 string.
- [ ] **Green:** In `features/tts/google-cloud.ts`, use `FetchLike` from `modules/ai/runtime/http.ts` and default to real `fetch`. Send `input: { text }`, `voice: { languageCode, name: voiceName }`, and `audioConfig: { audioEncoding: "LINEAR16" }`. Return a discriminated result: success with `Uint8Array` WAV bytes, failure with a stable error code, or cancellation. Do not expose the raw response or exception. The sample is `This is a voice sample.` with `en-US` and `en-US-Standard-C` from the [supported voices list](https://cloud.google.com/text-to-speech/docs/list-voices-and-types).
- [ ] **Next cycles:** Reject blank text and text longer than [5,000 UTF-8 bytes](https://cloud.google.com/text-to-speech/quotas) before fetch. Test 5,000 and 5,001 bytes, including multi-byte input. Bound the JSON response to 8 MiB before parsing, including when `Content-Length` is absent. Decode nonempty `audioContent` with `atob`; reject malformed base64 or a response without a RIFF/WAVE header. Use a 15-second deadline for the request and body read, pass through caller cancellation, and ignore any late response. Test auth, quota, malformed data, cancellation, and timeout in separate red/green cycles. Do not retry automatically.
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
- [ ] **Green:** Before editing TSX, record the motion inventory below in `docs/ui/DESIGNE.md`. In `features/settings/page.tsx`, add `tts` after OCR in the Integrations group and a local detail selection with the existing header padding and breadcrumb. In `App.tsx`, load `ttsSettingsStore` alongside `ocrSettingsStore`. In `features/settings/tts-section.tsx`, reuse OCR's row and detail composition (`Card`, `Avatar`, `Button`, `Switch`, `Input`, `FormField`, and `toast`) and the existing `assets/icons/google-cloud.svg`. Do not change OCR or extract a shared channel framework. Use `settings-tts-open-google-cloud`, `settings-tts-toggle-google-cloud`, `settings-tts-breadcrumb-root`, `settings-tts-api-key`, and `settings-tts-save` as test IDs. Localize list summaries, focusable control names, tooltips, and alerts with `t()` in both locale files. Use `Text-to-Speech` / `语音合成` for the section and `Google Cloud Text-to-Speech` for the channel.
- [ ] **Next cycles:** Save a synthetic key and verify first-save enablement, then toggle off, reopen, replace the key, and verify it remains off. The UI must never prefill the saved key; show a masked placeholder when readable. An empty draft makes no change. Leaving the detail or saving successfully clears the draft. A failed save retains the draft for retry and leaves the current channel in place. A missing key shows recovery text and never leaves the user unable to turn the channel off. A toggle write failure keeps the last confirmed state. Save and toggle never make a Cloud request: an enabled switch means the channel is locally configured, not that Google has accepted the key.
- [ ] **Red/green:** `mise exec -- nsh test features/settings/settings.test.tsx --filter "tts settings:"` — expect the new route or state assertion to fail first, then pass. `mise exec -- nsh test features/settings/settings.test.tsx --filter "ocr settings:"` must also pass.

### Task 4: Play a sample only on request

**Seam:** Settings UI through `App.tsx`, using the headless network and speaker boundaries.

- [ ] **Red:** In `features/settings/settings.test.tsx`, add `tts preview:` cases. Seed a readable saved key, stub the POST with a valid short WAV, and press `settings-tts-preview`. Assert one request with the fixed sample and one `play` in `app.audio()`. Opening the form, editing or saving a key, and toggling the channel make no synthesis request. Preview tests the saved key, not the draft, and is available even when the channel is off. With an unsaved edit, disable Preview until the edit is saved or cleared.
- [ ] **Green:** Add the preview action in `features/settings/tts-section.tsx`. Put `Play sample` / `播放示例` near Save and state that it sends a short English sample to Google. Read the saved key by reference at press time. If `Sound.available()` is false, disable Preview with a localized reason. Otherwise use `Sound.load(wavBytes)` then `sound.play()`, with a sample short enough for NSH's five-second `Sound` limit. Keep one operation and one sound per detail view. Disable key edits and Save until the operation ends. Show Cancel while loading and Stop while playing; return to idle when the clip duration elapses. Stop and dispose the sound on cancellation or exit. Cancel the request on exit and ignore late fetch or `Sound.load` completions; dispose a sound that loads after cancellation. There is no temporary audio file and no playback on save.
- [ ] **Next cycles:** Test an auth failure (inline recovery, no play), leaving the detail while the request is pending (late bytes never play), and leaving while playing (sound stops). Use headless WAV fixtures and network stubs, not a production mock mode.
- [ ] **Red/green:** `mise exec -- nsh test features/settings/settings.test.tsx --filter "tts preview:"` — expect the new preview, error, or cancellation assertion to fail first, then pass.

## Motion inventory

| Change | Existing tool and tokens | Reduced motion |
| --- | --- | --- |
| Settings section selection and breadcrumb swap | Settings nav feedback; header changes immediately. | Instant. |
| Channel list or detail enters | `createMotion` with `motion.pageEnter`, as in OCR. The page background stays opaque. | Instant. |
| Row, breadcrumb, chevron, Save, and Preview hover or press | `navigationFeedback`; shared icon and action buttons use `pressScale`. Input keeps its focus ring. | Instant color; no scale. |
| Enable switch changes | `navigationFeedback` and `switchThumb`; use the existing disabled-switch tooltip. | Instant. |
| Save confirmation | Shared toast motion. | Instant; no slide. |
| Validation, saved-key summary, and Preview/Cancel/Stop state | Immediate updates. No new progress animation, overlay, gesture, or layout motion. | No change. |

## Failure behavior

| Condition | Result |
| --- | --- |
| No saved key, unreadable key, or local storage failure | Explain how to save or replace the key. Keep the last confirmed enablement on a failed write. Do not start preview without a readable key. |
| HTTP 401/403 or a Google `API_KEY_INVALID` reason | Ask the user to check the key, Cloud TTS API access, and project billing. Do not show provider text. |
| HTTP 429 | Explain the quota or rate limit. Allow a manual retry. |
| Network failure, timeout, other HTTP rejection, malformed audio, or playback failure | Show a localized inline error near Preview. Preserve the channel and enablement. |
| Explicit cancel or leave | Do not show an error or play a late response. |

## Privacy and rollout

- The only synthesis destination is `texttospeech.googleapis.com`. Only explicit Preview sends text, and it sends the fixed sample, not source text, translated text, the clipboard, or file contents.
- Use the header form recommended in [Google's API-key guidance](https://cloud.google.com/docs/authentication/api-keys-best-practices). Do not bundle an app-owned key. The separate NSH Storage entry follows the OCR pattern and is **not encrypted**. State this next to the key field. Treat local storage and backups as sensitive. Do not log keys, request bodies, or audio. Do not add credential import/export or sync.
- New installations and existing installations start unconfigured. No migration and no change to OCR, language detection, or Quick Translate.

## Final validation

- [ ] Run `mise run verify`. Expect format, lint, type checks, Rust and headless tests, and build to pass.
- [ ] Run `mise exec -- nsh test features/settings/settings.test.tsx --filter "tts settings:" --target windows` for native-capable settings cases. Keep any storage failure simulation that requires `OpenOptions.modules` in a separate headless case. Use `mise run dev` to review light and dark appearances, English and Simplified Chinese, and both `1040 × 720` and `720 × 520`. Check tokens, spacing, masking, focus, labels, hover, pressed, disabled, errors, and reduced motion. Record any Windows keyboard or screen-reader limits rather than inferring support from headless tests.
- [ ] With an authorized Cloud project, save and reopen the channel, play the sample audibly on Windows, and verify Stop and back navigation. Verify no request on save or toggle. If live authentication or sound cannot be verified, record the missing evidence separately from the headless passes.

**Open question:** Can a Cloud TTS-restricted API key alone authorize `text:synthesize` in the target project? Resolve this with the pre-implementation check; the rest of the plan does not require a product decision.
