# Implementation Plan

**Goal:** Let users choose Google Cloud Text-to-Speech voices and adjust their speech in Settings. Apply the saved choices to Quick Translate.

**Inputs:** The approved Google TTS settings research, the current [Google TTS plan](2026-11-22-google-cloud-tts-plan.md), and Google's [voice catalog], [voice selection], [audio configuration], [Chirp 3: HD guide], and [pricing].

**Assumptions:** Windows desktop is the acceptance target. This change is for Google Cloud only. Keep synchronous plain-text synthesis, MP3 playback, and the existing channel order and activation rules. Use a bundled voice catalog; do not call `voices.list` at run time. Before sending live requests, obtain approval to use a user-owned Google Cloud test project.

**Architecture:** A bundled catalog maps app languages to Google voices and resolves each request to a specific voice. The TTS store owns saved preferences and keeps keys in separate credential entries. Settings previews the current draft with the saved key; Quick Translate uses the same resolver and audio rules with saved preferences only.

**Tech Stack:** TypeScript, TSX, NSH 0.6.1, `nsh/test`, Node.js, and mise. No new package or Rust changes.

---

## Product Rules

- Offer only Google voice families and synthesis options eligible for a documented monthly free usage allowance. Use the [official pricing page][pricing] as the source. Use a hard allowlist for the exact approved families; an unknown family, a paid-only family, or one whose eligibility is unclear is not selectable. Apply the same rule to automatic selection, overrides, and samples. Default to Standard.
- Show the reachable app-language count, published monthly free allowance, and overage rate for each family. Indicate that Standard and WaveNet share the same allowance. Link to Google pricing and date the published values. Google requires billing and automatically charges overage. These values are not a balance: do not infer remaining allowance from an API key, claim that a particular request is free, or implement a billing or quota tracker. A paid-only voice is never used, even after an eligible request fails.
- Select a voice gender preference: Any, Female, or Male. Use it to rank voices within the chosen family, not as a separate `ssmlGender` request field. If no matching voice exists in that family, use another voice in the same family before considering a lower family. The explicit voice picker shows gender and does not exclude other genders.
- Allow one explicit voice per app language. Store its exact Google name; get the BCP-47 locale from the catalog. An explicit choice overrides both family and gender. Show its locale, family, and rate in the picker so a user can knowingly select a higher-cost voice. Reset a language to automatic to remove its override.
- Automatic selection never upgrades to a more expensive family. Use the following ordered chains and stop at the first family found for the language's default locale. Within that family, rank the gender preference first, then the existing default voice if eligible, then sort by full voice name. Do not use a different locale or channel as an implicit fallback. If a language has only higher-cost voices, tell the user to select one in Settings. For example, under the default Standard preference, do not silently select Chirp 3: HD for Croatian.

| Preferred family | Automatic search order |
| --- | --- |
| Standard | Standard |
| WaveNet | WaveNet, Standard |
| Neural2 | Neural2, WaveNet, Standard |
| Chirp 3: HD | Chirp 3: HD, Neural2, WaveNet, Standard |
| Studio | Studio, Chirp 3: HD, Neural2, WaveNet, Standard |

- A saved override missing from a newer catalog is unavailable. Keep it visible so the user can replace or reset it. Do not silently change the voice or send a request for it. An unrelated settings edit must not require the user to fix it. Do not retry with another voice after a provider error.
- Offer global Google speaking rate (`0.25` to `2.0`, default `1.0`) and pitch (`−20` to `+20` semitones, default `0`). These are audio fields on the same named-voice request and do not change the billed character input or select a different SKU under Google's published pricing. Apply each non-default value only when the resolved voice supports it. Show when a control does not apply to the current preview voice and preserve its value for other voices. Always omit Chirp 3: HD pitch. Enable its rate only after the live check below. Never send unsupported fields with placeholder values.
- Keep Google Cloud API key, channel enablement, and voice preferences independent. Saving only voice preferences does not request a new key or make a network call. Changing voice settings does not enable a channel. Azure keeps its current controls and synthesis behavior.
- Keep output encoding, sample rate, volume gain, device effects, SSML, custom voices, older or specialized families, multi-speaker synthesis, streaming, and Gemini-TTS out of scope. In particular, do not offer Gemini-TTS or Instant Custom Voice: their pricing lists no monthly free usage allowance.

### Approved Google families

Published rates checked on 2026-11-22. Keep the SKU and free allowance in one reviewed data source, shared by the generator and app. An allowlisted family need not have voices in every locale.

| Voice family | SKU | Published free usage per month | USD per million characters after free usage |
| --- | --- | --- | --- |
| Standard | `9D01-5995-B545` | 4 million characters, shared with WaveNet | $4 |
| WaveNet | `9D01-5995-B545` | 4 million characters, shared with Standard | $4 |
| Neural2 | `FEBD-04B6-769B` | 1 million characters | $16 |
| Chirp 3: HD | `F977-2280-6F1B` | 1 million characters | $30 |
| Studio, single speaker | `84AB-48C0-F9C3` | 1 million characters | $160 |

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `.mise/tasks/voices`, `assets/catalog/google-tts-voices.json`, `assets/catalog/google-tts-families.json` | Generate and ship a deterministic offline catalog from Google's public voice table. Share the reviewed allowlist and pricing data. |
| Modify | `features/tts/google-voices.ts` | Catalog lookup, locale mapping, supported families, and voice resolution. |
| Create | `features/tts/google-voices.test.ts` | Locale, exact choice, gender, defaults, and fallback behavior. |
| Create | `features/tts/google-preferences.ts` | Preference types, defaults, validation, and audio capability rules. |
| Modify | `features/tts/settings.ts`, `features/tts/settings.test.ts` | Versioned persistence, credential reuse, reload, and failed writes. |
| Modify | `features/tts/google-cloud.ts`, `features/tts/google-cloud.test.ts`, `features/tts/synthesis.ts`, `features/tts/channels.ts` | Typed Google audio options and request serialization. Keep Azure and MP3 unchanged. |
| Modify | `features/tts/quick-speech.ts`, `features/tts/quick-speech.test.ts`, `features/quick-translate/popup.tsx`, `features/quick-translate/popup.test.tsx` | Apply saved choices to source and result speech, and cancel a request when the active settings change. |
| Modify | `features/settings/tts-section.tsx`, `features/settings/settings.test.tsx` | Connect the Google draft, credential checks, preview, and save. |
| Create | `features/settings/google-tts-fields.tsx`, `components/ui/slider.tsx` | Google field group, per-language voice picker, and styled slider over NSH's semantic control. |
| Modify | `locales/en.yml`, `locales/zh-CN.yml` | Field, locale, pricing, accessibility, preview, and recovery strings. |

## Seams

- `mise run voices -- [local HTML file]` — generate the bundled catalog without credentials; the optional input file supports repeatable validation of the same generator.
- `listGoogleVoices(language)` and `resolveGoogleVoice(language, preferences)` in `features/tts/google-voices.ts` — eligible voices and one exact voice or a reason why no voice can be selected.
- `createTtsSettingsStore(storage)` — defaults, save and reload, credential preservation, and write failures.
- `createGoogleCloudTtsClient({ fetchImpl }).synthesize(input, options)` — exact Google REST body and unchanged MP3 result.
- `prepareQuickSpeech(input, settings)` and the Quick Translate popup's source and result speaker controls — saved preferences, request destination, and cancellation.
- Settings through `App.tsx` — draft controls, Save, and preview. Observe requests and playback with the existing NSH test harness.

Confirm these seams before writing tests. For each cycle, run the specified command with one new case, see a behavior failure, implement the smallest change that passes it, and run the same command again. Add a public signature first when needed so the red result is not an import error.

## Tasks

### 1. Resolve an eligible voice from the offline catalog

**Seam:** `mise run voices` and public voice lookup.

- [x] **Red:** Add `features/tts/google-voices.test.ts`. For English, find `en-US-Standard-C` and `en-US-Neural2-D` with their documented gender and locale. With default preferences, resolve `en-US-Standard-C`. For Mandarin, Neural2 preference resolves to WaveNet, not Chirp 3: HD.
- [x] **Green:** Add `.mise/tasks/voices`. Fetch the public voice list with bounded curl on an explicit maintainer run, or read the supplied HTML file. Parse the voice table, not the samples or overview. Capture full name, locale, family, and gender. Classify the public voice names and filter against `assets/catalog/google-tts-families.json`, excluding Gemini names and multi-speaker entries. Do not infer price, eligibility, or capability from the `Premium` label. Sort by locale then name. Fail if the table, a required column, an allowed family, or a known reference voice from an allowed family is missing. Validate unique names, expected fields, and known gender values before replacing the output. Use a temporary file and leave the old snapshot intact on failure. Ship the output at `assets/catalog/google-tts-voices.json`. Document the source and generator command in the task description.
- [x] **Green:** In `google-voices.ts`, use the existing default locale map and Standard defaults. Add explicit default locale entries for newly covered languages in the snapshot: `he-IL`, `hr-HR`, `sl-SI`, `sr-RS`, `sw-KE`, `uk-UA`, and `ur-IN`. Keep `fa-IR` unsupported if no entry exists. Derive alternate locales by matching the app language's base tag, with explicit aliases for `zh` (`cmn-CN`, `cmn-TW`, `yue-HK`), `no` (`nb-*`), `tl` (`fil-*`), and `ar` (`ar-*`, with `ar-XA` as default). Alternate locales are explicit choices only. A missing default-locale entry is not evidence that an entire language is unsupported. Use the voice record as the source of locale and family, not a user-entered name.
- [x] **Next cycles:** Verify an exact `en-GB` override wins over global preferences, a cross-language or missing override does not fall back, `zh` can explicitly choose a listed `yue-HK` voice but never auto-selects it, and Standard does not select Croatian Chirp 3: HD. Check a requested gender missing from a family does not force a family change. Verify that a synthetic generator input row for a paid-only voice cannot appear in the output, and that a billing-ineligible or unrecognized voice name supplied as an override produces no request. Distinguish `override_unavailable`, `no_voice_for_preference`, and `no_voice_for_language` for recovery messages. Calculate each family's count from supported app languages with any selectable entry in that family; do not hard-code research counts.
- [x] **Generator check:** Run `mise run voices` and save the downloaded HTML separately for a repeatable check, then run `mise run voices -- <path-to-saved-html>` twice against the same input and compare output bytes. Run it against a local HTML file without a voice table; expect a failure with the previous output unchanged. Do not track the temporary input files.

**Red/green:** `mise exec -- nsh test features/tts/google-voices.test.ts` — first fail on catalog lookup or voice resolution, then pass after each cycle.

### 2. Save preferences without replacing a key

**Seam:** `createTtsSettingsStore(storage)`.

- [x] **Red:** Save a Google channel, then save a changed family, gender, override, and audio values with no new key. Reload and expect the new preferences and the original key reference, enable flag, and channel priority. Save or configure Azure in the same store and confirm its binding is unaffected.
- [x] **Green:** Define `GoogleVoicePreferences` in `google-preferences.ts`: `voiceTier`, `voiceGender`, `voiceOverrides` keyed by `LanguageId`, `speakingRate`, and `pitch`. Values follow the product rules. Use a complete normalized value in each Google binding. Make Google `apiKey` optional on `saveChannel`; accept omission only if a readable key already exists and reuse its reference. Distinguish omission from a supplied blank key. A first save still requires a key. A Google key-only replacement keeps the saved preferences if omitted. Keep the existing write queue and credential rollback. Saving both a key and preferences commits them together. Do not write the key or its value into preferences.
- [x] **Next cycles:** Reject unknown preference enum values, unknown language keys, non-finite or out-of-range numbers, and newly set overrides that do not match the language. On load, validate the stored shape but allow formerly valid voice names absent from the current catalog and recognized family IDs that are no longer eligible. A save can retain or clear an unavailable choice, but must not introduce one. Failed writes leave the previous preferences and key active. Load settings without reading credentials. Add localized validation messages.
- [x] **Version:** Write `settings.tts.v2` with payload `version: 2`. Do not migrate, delete, or overwrite v1 records or their keys. On upgrade, saved v1 channel settings do not load; both channels must be configured again. Update v2 fixtures in `features/tts/settings.test.ts`, `features/tts/quick-speech.test.ts`, `features/settings/settings.test.tsx`, `features/quick-translate/popup.test.tsx`, and any other TTS fixtures found by `git grep -n -e TTS_STORAGE_KEY -e settings.tts.v1`. Keep the explicit v1 fixture that verifies the reset.

**Red/green:** `mise exec -- nsh test features/tts/settings.test.ts` — first fail on preference persistence, key reuse, or invalid data behavior, then pass along with the channel-order and enablement tests.

### 3. Serialize Google audio options

**Seam:** `createGoogleCloudTtsClient().synthesize(...)` at the injected fetch boundary.

- [x] **Red:** For `en-US-Neural2-D`, expect `input.text`, named `voice`, and `audioConfig: { audioEncoding: "MP3", speakingRate: 1.25, pitch: 2 }`. For `en-US-Chirp3-HD-Kore`, expect no `pitch` and no `speakingRate` while pace support is unverified. For default values expect the current MP3-only config.
- [x] **Green:** Carry optional Google audio options through `TtsSynthesisRequest` and the Google branch of `synthesizeSpeech`. Build the effective audio configuration from the resolved family and preferences through a shared function in `google-preferences.ts`. Reuse it for Quick Translate and preview. The client serializes only effective non-default fields. Keep current endpoint, API key header, text limits, abort, timeout, byte limits, response mapping, and MP3 playback. Do not add audio options to Azure's request.
- [ ] **Live gate:** In an approved project, use the existing restricted Cloud TTS key and the default endpoint. With a short nonsensitive fixed sample and MP3 output, check one baseline request for each family to be exposed. For Chirp 3: HD, compare `1.0` and `1.5` with the same voice and text. Verify the second clip is audibly faster or has a shorter measured duration; HTTP 200 alone is not enough. Google's [general catalog note][voice catalog] and [Chirp guide][Chirp 3: HD guide] differ on pace support. If approval is unavailable, the pace has no observable effect, or the request rejects it, keep Chirp rate unavailable and keep sending neither field. Do not probe unsupported pitch or test `voices.list` for this implementation.

**Red/green:** `mise exec -- nsh test features/tts/google-cloud.test.ts` — first fail on a missing expected audio field or an unexpected field, then pass with existing request, cancellation, and response tests.

### 4. Apply saved choices to Quick Translate

**Seam:** `prepareQuickSpeech(...)` and source/result speaker controls in the popup.

- [x] **Red:** With a configured Google channel, prepare speech for English with an `en-GB` override and a non-default rate. Expect that exact voice and the effective audio options. With default Standard and no eligible Croatian voice in that family, expect localized Settings guidance before the key read and no outbound request.
- [x] **Green:** Resolve the actual source or result language as before. For Google, resolve with saved preferences and include effective audio options. For Azure, keep `azureVoiceForLanguage` and existing request preparation. Localize the results for no voice, no voice within the preference, and unavailable override. Keep first-enabled-channel selection; no cross-channel fallback. Use a saved-binding signature that includes normalized Google preferences with stable override order as well as channel and credential reference (and Azure region). Check it after key reads and in the popup's existing cancellation paths so a settings change cannot play an obsolete request. Do not include secrets in the signature.
- [x] **Next cycles:** Through `popup.test.tsx`, click the source and result speakers and inspect `app.requests()` for the correct locale, voice, and options for each language. Also test that a preference change during synthesis cancels obsolete playback. Keep the existing active-channel, hide, stop, and credential tests passing.

**Red/green:** `mise exec -- nsh test features/tts/quick-speech.test.ts` and `mise exec -- nsh test features/quick-translate/popup.test.tsx` — each new case first fails on the saved-choice, recovery, or cancellation behavior it verifies, then passes.

### 5. Configure and preview Google voices in Settings

**Seam:** Settings through `App.tsx` controls, storage, network, and audio.

- [x] **Red:** In `settings.test.tsx`, open Google with an existing key. Set Neural2 and `1.25×`, then play the English sample before saving. Expect a Neural2 voice and `speakingRate: 1.25`, one synthesis call, and unchanged saved preferences. Save with the key field empty, reopen, and verify that the settings and key reference persist. Going back without saving must discard the draft.
- [x] **Green:** Keep the current credentials field and action area in `tts-section.tsx`. Compose Voice and Audio groups in `google-tts-fields.tsx` with `FormField`, `Select`, `Button`, `Input`, and the shared styled slider. Check the pinned `nsh/base` slider declaration in `.nsh/types/nsh/base.d.ts`; style its track, fill and thumb in `components/ui/slider.tsx`. Give the sliders labels and accessible values, show the exact numeric values, and use steps of `0.05×` and one semitone. Reuse the theme scale and the page's scroll owner. Use `t()` for both locales; format numbers for the interface locale. Show a short explanation only for price, unavailable options, save dependencies, or recovery. Test that the picker cannot select an ineligible voice even when an old saved record names it and that pressing Preview makes no request until the choice is corrected.
- [x] **Next cycles:** Add a Language overrides action that opens `AppDialog`. Choose one app language with `Select`; search that language's voices with `Input` and select a result with `Select`. Show each match's locale, family, and gender, and identify its family's free allowance and overage rate on selection. Match voice name, localized locale label, or family without case sensitivity. With no match, show a localized empty state; keep an existing exact choice until the user applies another match or resets it. Apply updates the page draft and sets the preview language to the edited language. Cancel or Escape closes the dialog without changing the draft and restores focus to the trigger. The page Save commits all draft changes.
- [x] **Next cycles:** Add a Google sample-language selector that defaults to English when the page opens. Preview uses the selected language, the same draft resolver as Quick Translate, and the resolved locale's fixed localized sample, not user input. Provide a fixed short sample in each selectable app language; for Cantonese use a separate Cantonese sample. Show the actual voice before playback so a fallback is visible. An unavailable choice does not send a request. Keep preview available for a saved readable key even if the Google channel is off. A pending key edit still blocks preview. Preserve Cancel, Stop, settings navigation abort, and no audio on denied credentials. Lock the draft controls while loading or playing. Refresh Azure's existing tests without changing its behavior.

**Red/green:** `mise exec -- nsh test features/settings/settings.test.tsx --filter "tts google:"` — use the `tts google:` prefix for the new cases. Each case first fails on the draft, stored choice, preview, or recovery under test, then passes. Run `mise exec -- nsh test features/settings/settings.test.tsx` for existing settings behavior.

#### Motion inventory for Task 5

Record this inventory in the app design document before editing TSX. Reuse tokens from `components/motion.ts`; do not add decorative motion.

| State change | Tool and reduced motion |
| --- | --- |
| Controls hover, press, or gain focus | Existing input, button, and select state styles. Use `navigationFeedback` and existing `pressScale` where the control already uses them; reduced motion removes the transition and scale. |
| Selected family, locale, or voice changes | Use existing Select selection and focus feedback. Replace the label and cost immediately; do not animate the text or move the form. |
| Detail enters, picker opens or closes, dropdown toggles | Keep `pageEnter` and the `AppDialog` fade, plus existing Select popup transitions. Verify with reduced motion; remove page or overlay motion if the pinned host does not suppress it. |
| Search results, field errors, and unavailable state | Update immediately to preserve keyboard position. Keep slider and preview action positions fixed when capability or playback changes. |
| Slider pointer release, arrow key, or accessibility step | The thumb follows the value directly. No spring or inertial motion. |
| Play sample, Cancel, Stop, completion, save confirmation | Reuse the existing phase label and button state, plus the existing save toast transition. Reduced motion removes the toast movement. No waveform or background animation. |

## Final Validation

- [x] Run `mise run verify`. Expect formatting, lint, checks, tests, and build to pass. The test harness uses recorded boundaries; it must not send live synthesis requests.
- [ ] On Windows, run `mise run test-desktop` and `mise run dev`. Verify the Google flow with keyboard and screen reader, light and dark themes, both locale settings, reduced motion, and the narrow supported window. Check readable labels and errors, spacing and alignment, focus on overlay close, and each motion inventory row. Confirm Azure still saves, previews, and plays as before.
- [x] Recheck the [official pricing page][pricing] before shipping. Confirm each exposed option keeps an eligible SKU and that the UI shows the shared Standard/WaveNet allowance without adding the two figures. Remove any family that has lost eligibility before release.
- [ ] Validate the live synthesis baseline separately from tests. Record tested families, voice names, parameter support, and date. Do not record keys, text from Quick Translate, or raw response bodies. If no approved project is available, report live behavior as unverified.

## Failure Behavior and Rollout

- Generation errors leave the last good snapshot in place. The app never refreshes it in the background. Review removed voices, eligible language counts, and official pricing when refreshing the snapshot. If a previously approved family loses free-usage eligibility, remove its catalog entries. Keep saved preferences and overrides for that family visible as unavailable. Block automatic selection with an unavailable preferred family, but continue to honor an explicit, eligible override for that language. Do not silently substitute another family.
- An unavailable saved voice, missing key, or no eligible voice within the selected family's rate does not route text elsewhere. The UI points to the relevant Google setting. A provider failure follows the existing localized failure path. Do not display raw provider errors.
- A failed save leaves the draft available for retry and the previous working settings active. The demo storage reset is deliberate: document that users must re-enter the Google or Azure key after the update. No v1 entries are deleted by this change.
- Send fixed sample text only after preview is pressed. Send source or result text only after the corresponding speaker action. Keep keys in the existing credential storage and `x-goog-api-key` header, never in a URL or in logs.

[voice catalog]: https://cloud.google.com/text-to-speech/docs/list-voices-and-types
[voice selection]: https://cloud.google.com/text-to-speech/docs/reference/rest/v1/VoiceSelectionParams
[audio configuration]: https://cloud.google.com/text-to-speech/docs/reference/rest/v1/AudioConfig
[Chirp 3: HD guide]: https://cloud.google.com/text-to-speech/docs/chirp3-hd
[pricing]: https://cloud.google.com/text-to-speech/pricing

## Implementation Status (2026-11-22)

Implemented locally and covered by the headless suite. Remaining verification is listed below.

- Catalog: `mise run voices` parsed the live supported-voices table into 1,946 eligible voices across the five approved families. It is deterministic for the same input, filters paid-only and Gemini names, and leaves the previous snapshot in place on any failure. The live table has no Swahili (`sw-KE`) voices, so `sw` now resolves to "no voice for language"; `fa` stays unsupported. `sw-KE` remains in the default-locale map so a future snapshot covers it without a code change.
- Chirp 3: HD keeps speaking rate and pitch off. The live gate needs an approved Google Cloud project, so it was not run. The client sends neither field for that family.
- Live synthesis: not run. The headless suite uses recorded fetch boundaries; no live request was sent.
- `mise run test-desktop` started but its first real-window test made no progress for 12 minutes, so it was stopped. Running the changed UI tests with `--target windows` shows the real audio player rejects the stub MP3 bytes, and `audio()` is headless-only, so playback assertions cannot run there. `mise run dev` and the keyboard, screen-reader, reduced-motion, and narrowed-window checks were not performed. Real-window screenshots in light and dark mode confirm the layout, pricing block, override row, dialog, sliders, and both themes; the headless suite covers labels, focus paths, draft locking, and both locales.
- Version 1 TTS records are not migrated. Saved keys remain in credential storage, but both channels must be configured again after the update; no v1 record or key is deleted.
- Pricing was rechecked against the live Google page on 2026-11-22. The four SKUs, the 4M/1M free limits, and the $4/$16/$30/$160 overage rates match the shipped data. The page lists Standard and WaveNet under one SKU; the UI keeps the shared-allowance wording and does not add the two figures.
