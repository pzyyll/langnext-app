# Implementation Plan

**Goal:** Add Azure Speech as a second text-to-speech (TTS) channel for Settings previews and Quick Translate. Keep Google Cloud available.

**Inputs:** The request to add Azure TTS; the current Google Cloud implementation; the [Azure REST reference], [regions], [voice list], [SSML reference], [quotas], and [pricing].

**Assumptions:** Use a user-owned Speech resource key and a public Azure region. Users can configure both channels, but Quick Translate uses only one at a time. Users can turn both off. Do not add fallback, per-language routing, voice selection, quota tracking, batch synthesis, custom endpoints, sovereign clouds, or Speech SDK support.

**Architecture:** The TTS store owns both channel bindings and enforces one active channel. A small, typed TTS dispatcher takes the saved credentials and selected voice, calls the matching REST client, and returns MP3 bytes. Settings and Quick Translate keep their existing playback owners, cancellation, and temporary-file cleanup.

**Tech Stack:** TypeScript and TSX, NSH 0.6.1 `fetch`, `Storage`, and `AudioPlayer`, `nsh/test`, and mise. No new dependencies or Rust changes.

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `features/tts/synthesis.ts`, `features/tts/channels.ts` | Define shared request and result types; dispatch synthesis, voice lookup, and samples by channel. |
| Create | `features/tts/azure-speech.ts`, `features/tts/azure-regions.ts`, `features/tts/azure-voices.ts` | Implement the Azure REST client, validate public regions, and map concrete languages to Azure neural voices. |
| Modify | `features/tts/google-cloud.ts` | Use the shared result contract. Keep the Google request, voice map, limits, and response handling. |
| Modify | `features/tts/settings.ts`, `features/tts/quick-speech.ts` | Persist both bindings, select the active channel, and prepare speech from its saved configuration. |
| Modify | `features/settings/page.tsx`, `features/settings/tts-section.tsx` | Add the Azure row, detail fields, breadcrumb, and sample. |
| Modify | `features/quick-translate/popup.tsx` | Use the active channel, name its destination, and cancel stale work on a channel change. |
| Modify | `locales/en.yml`, `locales/zh-CN.yml`, `docs/ui/DESIGNE.md` | Add localized controls and recovery messages. Record Settings and Quick Translate behavior and motion. |
| Test | `features/tts/azure-speech.test.ts`, `features/tts/settings.test.ts`, `features/tts/quick-speech.test.ts` | Check the REST contract, settings transitions, and request preparation. Keep `features/tts/google-cloud.test.ts` as a regression suite. |
| Test | `features/settings/settings.test.tsx`, `features/quick-translate/popup.test.tsx` | Check both workflows with the existing NSH harnesses. Keep `app/quick-translate.test.tsx` as the native-window lifecycle regression suite. |
| Test | `features/quick-translate/__tests__/popup-harness.tsx` | Trigger an active-channel change during a test; keep test controls out of the app. |

Reuse `features/tts/playback.ts`, the loads in `App.tsx` and the Quick Translate test harnesses, and the existing network and audio capabilities in `nsh.json`. Do not change their behavior.

## Seams

- `createAzureSpeechTtsClient({ fetchImpl }).synthesize(input, options)` — Azure request, response bytes, failure, and cancellation at the `FetchLike` boundary.
- `createTtsSettingsStore(storage)` — saved configuration, active-channel transitions, and rollback through the store API.
- Settings through `App.tsx` — Azure configuration, switching, and preview through public controls, observed with `app.requests()` and `app.audio()`.
- `prepareQuickSpeech(input, settings)` — selection, language resolution, input validation, and stale credential reads.
- Quick Translate through the popup harness — exact destination and text, cancellation, and no fallback through public speaker controls.

Confirm these seams at plan approval, before writing tests. In each task, add one case, run its command to see the expected red result, implement the minimum change, and run the same command for green. Add a public signature first if necessary so the red result is a behavior failure, not an unresolved import.

## Tasks

### 1. Synthesize MP3 from an Azure Speech resource

**Seam:** `createAzureSpeechTtsClient().synthesize(...)`.

- [ ] **Red:** In `features/tts/azure-speech.test.ts`, inject `FetchLike` as in `features/tts/google-cloud.test.ts`. Supply an `eastus` key, an English voice, and text with `&`, `<`, and `>`. Assert one regional POST with escaped SSML and the headers below. Return a stream with non-ASCII MP3 bytes and expect the exact `Uint8Array` back.
- [ ] **Green:** Create `features/tts/azure-speech.ts`. Default to NSH `fetch`. POST to `https://{region}.tts.speech.microsoft.com/cognitiveservices/v1` with `redirect: "error"`, `Ocp-Apim-Subscription-Key`, `Content-Type: application/ssml+xml`, `X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3`, and `User-Agent: My Translator`. Send no bearer-token request. Build a single `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="…"><voice name="…">…</voice></speak>` document. Use the voice locale as `xml:lang`. Escape XML text and attribute values; preserve line breaks, encode carriage returns as XML character references, and reject characters that XML 1.0 cannot represent. Do not interpret text as SSML.
- [ ] **Next cycle:** In `features/tts/azure-regions.ts`, export `parseAzureSpeechRegion(value)` and accept only region IDs from the public `tts.speech.microsoft.com` entries in the [Azure REST reference]. Trim and lowercase before lookup. Validate before constructing the host. Test padded `EASTUS`, an unknown region, and input containing a URL, dot, slash, or port. Invalid input must make no request.
- [ ] **Next cycles:** Reject blank input and text over 5,000 UTF-8 bytes before fetch; test the boundary with multibyte text. The Azure value is an app limit on plain text before SSML escaping, not a documented Azure REST quota. Keep Google's current 5,000-byte provider limit separate. Do not split or truncate text in the app.
- [ ] **Next cycles:** Read HTTP 200 as bytes from `Response.body`. Cap it at 4 MiB, using `Content-Length` for early rejection and counting chunks when the length is absent or inaccurate. At 48 kbit/s, 10 minutes is about 3.6 MB before file overhead. Treat an empty, missing, or oversized body as `malformed`. Do not convert the bytes to text or base64. Let the existing audio player report decoder errors. Use a 15-second deadline across the request and body read. Abort or cancel the body on early exit without waiting for cleanup. Map 401/403 to `auth`, 429 to `rate_limited`, other non-200 statuses to `rejected`, and transport errors to `network`. Do not read provider error bodies. Test stalled reads, a bad body length, caller cancellation, and status mappings. Never retry automatically.
- [ ] **Contract:** In `features/tts/synthesis.ts`, define `TtsChannelId` (`"google-cloud" | "azure"`), `TtsVoice` (`{ languageCode, voiceName }`), a `TtsCredentials` union tagged by `channel` (Azure adds `region`), `TtsSynthesisRequest` (`{ credentials, text, voice }`), and `TtsSynthesis` (`synthesized` with audio, `failed` with a stable code, or `cancelled`). Keep the Google failure codes, including `quota`, and add `invalid_region`, `invalid_text`, and `rate_limited` for Azure. Keep the Google client wire contract unchanged.

**Red/green:** `mise exec -- nsh test features/tts/azure-speech.test.ts` — first fail on the request, bytes, or failure behavior under test; then pass. Run `mise exec -- nsh test features/tts/google-cloud.test.ts` to confirm Google's existing contract.

### 2. Save both configurations and select one active channel

**Seam:** `createTtsSettingsStore(storage)`.

- [ ] **Red:** In `features/tts/settings.test.ts`, load a Google-only record with an enabled channel. Save Azure with a valid region and key. Expect Google to stay active and Azure to be configured but off. Enable Azure, reload, and expect only Azure active; disable Azure and expect neither active. Confirm that both keys still exist.
- [ ] **Green:** Extend `settings.tts.v1` to `{ version: 1, googleCloud, azure }`. Keep the Google binding shape. The Azure binding is `{ enabled, credentialRef, region }`. A missing `azure` field reads as `null`; write both fields on the next settings change. Treat two enabled bindings or an invalid stored region as malformed and fail closed. Keep keys in separate `settings.tts.credentials.<uuid>` entries as `{ apiKey }`. `load()` must not read keys.
- [ ] **Green:** Change the store API to `savedBinding(channel)`, `activeBinding()`, `saveChannel({ channel, apiKey, region? })` with a required `region` only on Azure, `setEnabled(channel, enabled)`, and `readKey(ref)`. Tag returned bindings by channel without duplicating the channel ID in the stored fields. Update the current Google call sites in `features/settings/tts-section.tsx`, `features/tts/quick-speech.ts`, and `features/quick-translate/popup.tsx` to pass the Google ID until their Azure slices. Update the injected store calls in `features/tts/quick-speech.test.ts` in this slice so the existing tests still compile. On a first save, enable the new channel only if neither channel is active. On a later save, keep that channel's enabled state. Enabling either channel verifies its key, then persists both flags in one write. Disabling the active channel does not enable the other one.
- [ ] **Next cycles:** Reject a blank key or invalid Azure region without writing. Reuse the write queue, write the new key before the settings record, and publish state only after that record saves. On failure, keep the prior settings and other channel's key; remove the unused new key on a best-effort basis. After success, remove only the replaced channel's old key. Test a failed switch, an unreadable key on enable, a failed Azure key or region replacement, and first save on an empty store. An enabled channel with an unreadable key can still be disabled. Add store validation messages to both locale files in the same slice.

**Red/green:** `mise exec -- nsh test features/tts/settings.test.ts` — first fail on Azure persistence, exclusive selection, or rollback; then pass along with the updated Google cases.

### 3. Configure Azure in Settings

**Seam:** Settings through `App.tsx` configuration controls.

- [ ] **Red:** In `features/settings/settings.test.tsx`, open `settings-nav-tts`, expect a second row named `Azure Speech`, and open `settings-tts-open-azure`. Check the breadcrumb and the `settings-tts-region` field. Save a region and key, return to the list, and enable Azure while Google is active. Expect Azure on, Google off, and no network calls.
- [ ] **Green:** Before editing TSX, update the Settings motion inventory in `docs/ui/DESIGNE.md`. Reuse `pageEnter` for list and detail, `navigationFeedback` and `switchThumb` for row and switch feedback, and the existing button, toast, and reduced-motion behavior. Keep error and field updates immediate. Use the same `Card`, `Avatar`, row, switch, chevron, and detail patterns. Keep Google first, use the existing `speaker-one` icon as Azure's decorative mark, and use `settings-tts-{row,channel,summary,toggle,open}-azure` for the new row controls. Keep existing Google test IDs and the shared detail IDs. The breadcrumb uses the selected channel name. Return via the breadcrumb or rail item and restore focus to the row that opened the detail. Keep each channel's draft and credential status separate.
- [ ] **Next cycles:** Show the saved Azure region and a masked placeholder for a readable key, never the key itself. `Region` / `区域` accepts an identifier, with `eastus` as the example. Require a fresh key to save a changed region. Clear the draft on success or exit; keep it and the confirmed binding on a failed write. Keep both toggles locked while a switch is pending. If another channel is active, name the channel that will turn off in the off switch's tooltip and accessible name. Localize the Azure title, field, switch consequence, and recovery messages in both locale files. Add no always-visible helper copy that repeats labels.

**Red/green:** `mise exec -- nsh test features/settings/settings.test.tsx --filter "tts settings:"` — first fail on the Azure route, saved state, or switch behavior under test; then pass with Google settings cases.

### 4. Play a sample from the selected detail page

**Seam:** Settings through `App.tsx`, at its network and audio boundaries.

- [ ] **Red:** In `features/settings/settings.test.tsx`, seed a saved, inactive Azure binding and an active Google binding. In the Azure detail, press `settings-tts-preview` and expect one Azure POST using the saved region and key, the fixed English sample, and `en-US-JennyNeural`. Assert that the player opens and the active channel stays Google. Use a string response with an audio header for NSH's headless network fixture; it checks routing and player calls, not MP3 decoding. Task 1 uses a byte stream for binary coverage.
- [ ] **Green:** In `features/tts/channels.ts`, add `synthesizeSpeech(request, options)` and `sampleSpeechRequest(credentials)`. Dispatch by the credentials' channel. Keep `This is a voice sample.` for both channels, with Google's current Standard voice and Azure's `en-US-JennyNeural`. Share the existing preview flow in `features/settings/tts-section.tsx`. Read the detail's saved key and recheck its binding after that read. Preview works when the detail's channel is off. An unsaved key or region edit disables Preview. Keep the current Cancel, Stop, and exit cleanup. Do not call Azure on load, edit, Save, or toggle.
- [ ] **Next cycles:** Add localized Azure auth recovery that names both the resource key and the region. For 429, say Azure is limiting requests and offer a manual retry later; do not say the allowance ran out. Check that an auth or 429 response opens no player, and that leaving the detail drops a late response without an error.

**Red/green:** `mise exec -- nsh test features/settings/settings.test.tsx --filter "tts preview:"` — first fail on the missing Azure request, feedback, or cancellation; then pass with the Google preview cases.

### 5. Prepare Quick Translate speech for the active channel

**Seam:** `prepareQuickSpeech(input, settings)`.

- [ ] **Red:** In `features/tts/quick-speech.test.ts`, seed Azure active and Google configured but off. Prepare `en`, `zh`, and `fr` requests. Expect Azure credentials and the Azure voice and locale, not the Google values. Delay the key read, switch channels or replace the Azure region and key, and expect no prepared request for the old binding.
- [ ] **Green:** Add `features/tts/azure-voices.ts`, with `en → en-US-JennyNeural`, `zh → zh-CN-YunxiNeural`, and `fr → fr-FR-DeniseNeural`. For other concrete `LanguageId` values, use the first generally available `Standard` voice in the [voice list] for that language and locale. Use `ar-SA`, `bn-IN`, `es-ES`, `nb-NO`, `pt-PT`, `sr-RS`, `sw-KE`, `ta-IN`, `fil-PH`, and `ur-PK` for those corresponding IDs where the language spans locales or the IDs differ. Leave any unmapped language unsupported instead of guessing. Do not copy Google's voice names or depend on a remote catalog at startup.
- [ ] **Green:** In `features/tts/quick-speech.ts`, read `activeBinding()` and resolve the active channel's voice and text validation before reading `readKey(ref)`. Recheck the channel, reference, and Azure region after that read. Return a tagged synthesis request only for the unchanged binding. Preserve the existing choices for unresolved Auto. Report off, unsupported language, invalid XML text, and over-limit text locally; do not make a request for any of them. Use channel-aware recovery messages; describe the Azure text limit as an app limit.

**Red/green:** `mise exec -- nsh test features/tts/quick-speech.test.ts` — first fail on Azure preparation or stale-configuration rejection; then pass with Google's voice and length checks.

### 6. Use Azure from the existing Quick Translate speakers

**Seam:** Quick Translate through `features/quick-translate/__tests__/popup-harness.tsx`.

- [ ] **Red:** In `features/quick-translate/popup.test.tsx`, seed both channel configurations with Azure active. Assert that the source speaker sends the full source before translation, and a result speaker sends only the selected completed result with its stored target voice. Assert one Azure request per press and no Google request. Return a 429 from Azure and verify the localized rate-limit message and no fallback request.
- [ ] **Green:** Update the Quick Translate notes and motion inventory in `docs/ui/DESIGNE.md` before editing TSX. In `features/quick-translate/popup.tsx`, replace the direct Google call with `synthesizeSpeech`. Keep the existing source and result language rules. The idle tooltip names the active destination (`Sends this text to %{name}.`); when no channel is active it points to Settings. Keep the speakers, playback state, and error location unchanged. Show Azure-specific auth and rate-limit recovery next to the affected text. Keep translation state unchanged after a speech failure.
- [ ] **Next cycles:** Capture channel, credential reference, and Azure region when the user presses the speaker. Check that identity and the operation token again before dispatch and before playback. On a switch, disable, or credential replacement, abort synthesis or stop the clip, discard late completions, and wait for another press. Do not interrupt Quick Translate when the user edits or saves the inactive channel. Add a test-only `tts-switch` mode to the popup harness with a button (`harness-activate-google-tts`) that calls the real store. Use it to switch during a delayed response and during playback. Keep current Stop, source or result invalidation, and native hide behavior.

**Red/green:** `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "quick tts:"` — first fail on routing, recovery, or cancellation; then pass. Run `mise exec -- nsh test app/quick-translate.test.tsx --filter "quick tts:"` for the existing hide and close regression cases.

## Failure Behavior and Privacy

- The only new destination is the configured public Azure regional Speech endpoint. Send only the fixed sample or the text selected by an explicit speaker press. Never send the key in the URL or follow a redirect. Do not log keys, text, provider response bodies, or audio.
- Keep the existing local NSH credential storage. It separates keys from settings but does not encrypt them. A region change requires a key entry and does not validate the pair online; Preview is the explicit test. Leave both saved configurations intact on a network or playback failure.
- Azure documents 20 requests per 60 seconds for F0 and a 10-minute audio cap. Azure can return 429 for voice capacity as well as throttling. Use a stable `rate_limited` result without claiming a specific cause. The F0 500,000-character monthly allowance is service information, not an app counter or a reason to send requests to Google.
- Reuse the local temporary MP3 flow. Stop and clean up on cancellation, completion, or exit as before. Never resume or send a new clip automatically after a channel switch, translation, or window reopen.

## Rollout and Final Validation

- [ ] Run `mise run verify`. Expect formatting, lint, type checks, Rust and headless tests, and build to pass. A Google-only record must load without setup or a change of active channel. A new install must start with both channels off.
- [ ] Run `mise exec -- nsh test features/settings/settings.test.tsx --filter "tts settings:" --target windows` for native-capable configuration cases. Keep network and storage failure fixtures headless. Run `mise run dev` to inspect both Settings and Quick Translate in English and Simplified Chinese, light and dark appearance, normal and reduced motion, and the minimum window size. Check route and row focus restoration, keyboard controls, Narrator labels and switch state, masking, alert placement, and the existing motion tokens. Record any check not run and why.
- [ ] With a user-authorized public Azure Speech resource, play an audible sample and read one source and one translated result on Windows. Switch to Google while Azure is loading or playing, confirm no late audio, and verify temporary MP3 cleanup. Confirm the Azure region and key pair and live decoder support separately from headless results. If no credential is authorized, report live checks as not run. Do not create an Azure resource or use a real key for automated tests.

**Open questions:** None for the proposed scope. Live authentication and playback depend on an authorized resource and a Windows desktop session.

[Azure REST reference]: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
[regions]: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions
[voice list]: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts#text-to-speech-voices
[SSML reference]: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-structure
[quotas]: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
[pricing]: https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/
