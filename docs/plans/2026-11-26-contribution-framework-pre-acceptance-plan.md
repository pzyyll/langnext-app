# Implementation Plan

**Goal:** Close the M0–M2 review findings and verify the contribution framework before acceptance.

**Inputs:** [Contribution framework implementation plan](./2026-11-26-contribution-framework-plan.md), the review of `f075d5a...ba1d2ed`, and the pre-migration settings behavior at `f075d5a`.

**Assumptions:**

- Keep the new storage keys. Do not migrate legacy data, change vault encryption, or add a reset action for a failed load.
- Preserve pre-migration actions, focus, and save rules. Keep existing test titles and stable test IDs for controls that still exist. Do not add a leave guard or redesign the sections.
- M3–M5, unrelated HTTP logging changes, and unrelated desktop test failures stay out of scope. The Windows acceptance commands in this plan supersede the two broad desktop filters in the original plan.

**Architecture:** Keep the registry, channel collections, vault, chain runner, and `CapabilitySection`. Enforce storage and credential rules at the write boundary. Let contributions supply settings rules through the shared host contract. Keep each vendor transport inside its contribution.

**Tech Stack:** TypeScript/TSX, NSH `Storage` and `nsh/test`, the existing HTTP transport, and mise. No new dependencies.

---

## File Map

| Area | Production files | Test files |
| --- | --- | --- |
| Baidu token exchange | `src/contributions/ocr/vendor/baidu.ts` — suppress authentication payload logs | `src/contributions/ocr/vendor/baidu.test.ts` |
| Failed loads | `src/framework/contributions/channel-collection.ts`, `src/features/language-detection/preferences.ts` — block writes; `src/features/settings/capability-section.tsx`, `src/features/settings/page.tsx`, `src/features/settings/detection-preferences-card.tsx` — show load errors and block actions | `src/framework/contributions/channel-collection.test.ts`, `src/features/language-detection/settings.test.ts`, `src/features/settings/settings.test.tsx` |
| Credentials and Save | `src/features/ocr/store.ts`, `src/features/language-detection/store.ts` — enable policy; `src/framework/contributions/contracts.ts`, `src/framework/contributions/channel-collection.ts`, `src/features/settings/capability-section.tsx` — save rules and draft state; credential and AI channel components named in Tasks 4–5 | `src/framework/contributions/channel-collection.test.ts`, `src/features/language-detection/settings.test.ts`, `src/features/settings/settings.test.tsx` |
| TTS preview | `src/contributions/tts/channels/{azure,google-cloud,sample-preview}.tsx`, `src/framework/contributions/contracts.ts`, `src/features/settings/capability-section.tsx` — preview and host busy state | `src/features/settings/settings.test.tsx` |
| Free Google row | `src/features/settings/capability-section.tsx` — static identity and focus after add | `src/features/settings/capability-section.test.tsx`, `src/features/settings/settings.test.tsx` |
| Startup | `src/contributions/{ocr,detect}/index.ts` — reject duplicate IDs | `src/app/ai-setup.test.ts` |
| Detection transport | `src/features/language-detection/detect.ts`, `src/contributions/detect/types.ts`, `src/contributions/detect/channels/google-cloud.tsx`, `src/contributions/detect/vendor/google-free.ts` — use host I/O | `src/contributions/detect/channels/channels.test.ts`, `src/features/language-detection/detect.test.ts` |
| Native acceptance | No production changes | `src/features/settings/settings.test.tsx`, `src/app/quick-translate.test.tsx` |

## Seams

- `createBaiduOcrClient(...).recognize(...)`: token exchange, recognition result, and emitted logs.
- `ChannelCollection.load/add/save/setEnabled/moveTo/remove` and Settings → Integrations: failed loads, credential policies, and persisted state.
- `languageDetectionPreferences.load/setPreference` and the detection preferences card: isolated load errors and write protection.
- `CapabilitySection` detail and list: save availability, preview controls, and keyboard focus in Settings.
- `initializeContributions()`: duplicate IDs at startup and idempotence after success.
- `detectLanguage()` and the Google channel `execute(..., host)` hooks: vault reads, HTTP requests, and ordered fallback.
- Windows Settings and Quick Translate windows: native input, persisted settings, and channel dispatch.

## Tasks

Run each red command against its new or restored assertion before the production change. Run the same command again after the fix. Keep the earlier passing behavior. Use only synthetic credential values in tests.

### Task 1: Keep Baidu token exchange credentials out of logs

**Seam:** `createBaiduOcrClient(...).recognize(...)`.

- [ ] **Red:** In `src/contributions/ocr/vendor/baidu.test.ts`, add `baidu ocr: token exchange does not log credentials`. Send a synthetic API Key and Secret Key through the existing `fetchImpl` seam. Return a streamed JSON token response with an `application/json` content type, then a successful OCR result. Capture debug and request/status lines, as in `src/services/http.test.ts`. Assert that no authentication request or response body is logged. Check both plain and wire-encoded credential markers. Keep the OCR result, status lines, and masked access token in the OCR URL.
- [ ] **Green:** In `src/contributions/ocr/vendor/baidu.ts`, send the token request through `createHttpFetch({ fetchImpl: options.fetchImpl, scope: "ocr/baidu", logBodies: false })`. Keep the existing body-log policy for recognition requests. Do not add global masking rules for this vendor flow.

**Red → green:** `mise exec -- nsh test src/contributions/ocr/vendor/baidu.test.ts --filter "baidu ocr: token exchange does not log credentials"`. Before the fix, the token exchange logs payload lines. After the fix, it logs metadata only and recognition still succeeds.

### Task 2: Preserve a collection after a failed load

**Seam:** `ChannelCollection` writes and Settings → Integrations.

- [ ] **Red:** In `src/framework/contributions/channel-collection.test.ts`, add `pre-acceptance: a failed collection load blocks writes`. Seed a malformed record, call `load()`, and try Add and Save. Assert the same `loadError` key, byte-for-byte original storage, and no vault write. Replace the test record with valid data, reload, and verify Add works again. In `src/features/settings/settings.test.tsx`, add `pre-acceptance: malformed collection blocks adding from Settings`. Check one load alert and no usable Add action, including the empty-state picker.
- [ ] **Green:** In `src/framework/contributions/channel-collection.ts`, check the outstanding load error inside the shared write queue before mutation or vault I/O. Apply the guard to all collection writes. Reuse the existing error key and message. In `src/features/settings/capability-section.tsx` and `src/features/settings/page.tsx`, prevent header and empty-state Add actions while a load error exists. Do not treat an unknown but valid channel record as a load failure.

**Red → green:**

- `mise exec -- nsh test src/framework/contributions/channel-collection.test.ts --filter "pre-acceptance: a failed collection load"`
- `mise exec -- nsh test src/features/settings/settings.test.tsx --filter "pre-acceptance: malformed collection"`

Before the fix, Add writes over the record and remains available in Settings. After the fix, the record stays intact and the section shows the load error without offering an action that would overwrite it.

### Task 3: Show and preserve a failed detection preferences load

**Seam:** `languageDetectionPreferences` and the detection preferences card.

- [ ] **Red:** In `src/features/language-detection/settings.test.ts`, add `pre-acceptance: a failed preferences load blocks changes`. Call `setPreference` after loading malformed data. Expect a load error, no write, and the original bytes. In `src/features/settings/settings.test.tsx`, add `pre-acceptance: detection preferences show their load error`. Seed a valid detector collection and malformed preferences. Expect one alert in the preferences card, disabled preference controls, and a working detector list.
- [ ] **Green:** In `src/features/language-detection/preferences.ts`, refuse writes until a successful `load()` clears the error. In `src/features/settings/detection-preferences-card.tsx`, render the localized `loadError` and disable both selectors during that error. Keep preference errors separate from channel errors.

**Red → green:**

- `mise exec -- nsh test src/features/language-detection/settings.test.ts --filter "pre-acceptance: a failed preferences load"`
- `mise exec -- nsh test src/features/settings/settings.test.tsx --filter "pre-acceptance: detection preferences show"`

Before the fix, the malformed record is writable and the UI hides the error. After the fix, changes are blocked and the detector list still works.

### Task 4: Block enable and credential reuse when the vault read fails

**Seam:** Capability switches and detail Save in Settings, backed by production collections.

- [ ] **Red:** In `src/features/settings/settings.test.tsx`, add cases with the prefix `pre-acceptance: unreadable credential` for disabled Baidu OCR, Vision OCR, and Google Cloud detection. Seed configured bindings with unreadable vault records. Attempt to enable them. Assert that the switches and saved bindings stay off, and that each detail shows one credential alert. In `src/framework/contributions/channel-collection.test.ts`, add `pre-acceptance: keep requires a readable saved credential`. Assert that Save with `keep` fails without a write when a credential is unreadable, and that a replacement succeeds.
- [ ] **Green:** Set `requireReadableCredentialOnEnable: true` in `src/features/ocr/store.ts` and `src/features/language-detection/store.ts`. In `src/framework/contributions/channel-collection.ts`, use the policy to check the existing vault record before a credentialed `keep` write. Keep the explicit `clear` action and permit turning an unreadable channel off. In `src/features/settings/capability-section.tsx`, use vault readability, not a reference alone, to allow reuse. Render one alert in the host. Add an optional `credentialUnreadableKey` to the contribution contract in `src/framework/contributions/contracts.ts`. Set it to the existing alert key in `src/contributions/ocr/channels/{baidu,google-cloud}.tsx` and `src/contributions/detect/channels/google-cloud.tsx`. Remove those components' duplicate alerts. Update assertions to check the shared alert and its channel-specific text, including the hint to enter both Baidu keys.
- [ ] Update the reorder fixture in `src/features/language-detection/settings.test.ts` to create a configured Cloud detector with a synthetic replacement key. Do not create a configured channel with `keep` and no prior key.

**Red → green:**

- `mise exec -- nsh test src/features/settings/settings.test.tsx --filter "pre-acceptance: unreadable credential"`
- `mise exec -- nsh test src/framework/contributions/channel-collection.test.ts --filter "pre-acceptance: keep requires"`

Before the fix, the production switches enable broken bindings and Save can keep an unreadable credential. After the fix, the write is refused, replacement works, and the user sees one recovery alert. AI and the free Google channel need no vault record. OCR and detection still enable on a valid first save; TTS does not.

### Task 5: Restore the existing Save rules

**Seam:** `CapabilitySection` detail Save.

- [ ] **Red:** In `src/features/settings/settings.test.tsx`, add cases with the prefix `pre-acceptance: Save availability`. For OCR and detection AI channels, seed an unavailable saved model and an eligible alternative. Save must stay disabled until the user selects the alternative. Restore the baseline Save assertions for empty and partial credential drafts in the existing channel tests. Where a migrated test submits a partial Baidu pair to get an error, assert disabled Save and no write instead. Use the pre-migration `draftSaveInput`, `canSave`, and `saveDisabled` rules at `f075d5a` as the reference. Keep the failed-write test that retains the draft.
- [ ] **Green:** In `src/framework/contributions/contracts.ts`, give contributions a save-availability hook with the current draft, readable-credential state, saved binding, and model resolver. In `src/features/settings/capability-section.tsx`, use it both to disable Save and to guard the save handler. Keep `validate` for localized field errors. Supply the rules in `src/contributions/ocr/channels/{ai,baidu,google-cloud}.tsx`, `src/contributions/detect/channels/{ai,google-cloud}.tsx`, and `src/contributions/tts/channels/{azure,google-cloud}.tsx`:
  - AI can save an eligible model only, for images in OCR and text in detection. Keep the recovery action for an unavailable saved model.
  - Baidu requires both replacement fields, or both fields empty with a readable saved pair. Vision and Cloud detection require a replacement key or a readable saved key.
  - Google TTS requires a new key, or changed voice preferences with a readable saved key. Azure TTS requires a new key and a nonblank region. Report an invalid region on submit as before.

**Red → green:** `mise exec -- nsh test src/features/settings/settings.test.tsx --filter "pre-acceptance: Save availability"`. Before the fix, the unavailable model can be saved. After the fix, the eligible choice enables Save and persists. Also run the settings file without a filter to check all restored assertions.

### Task 6: Restore TTS preview eligibility and locking

**Seam:** Google Cloud and Azure sample controls in Settings.

- [ ] **Red:** In `src/features/settings/settings.test.tsx`, add cases with the prefix `pre-acceptance: TTS preview`. Check that a missing or unreadable saved key disables Play with the existing hint. For Azure, change `eastus` to `eastus2` without saving: Play must stay disabled and send no request. Revert the change and check the saved endpoint. Restore the assertions in `tts preview: plays the saved sample and ignores drafts, saves, and toggles` that editing and Save are disabled during playback. Check the same lock while the response is pending and release it on Cancel or Stop.
- [ ] **Green:** In `src/framework/contributions/contracts.ts` and `src/features/settings/capability-section.tsx`, provide the saved binding to settings and a host callback for preview busy state. In `src/contributions/tts/channels/{azure,google-cloud,sample-preview}.tsx`, gate preview on a readable saved key and existing draft rules. Use only the saved Azure region. Continue to preview unsaved Google voice preferences with the saved credential. Keep Cancel and Stop usable while the host locks editing and Save. Clear the lock on finish, error, or exit. Reuse the existing localized hints.

**Red → green:**

- `mise exec -- nsh test src/features/settings/settings.test.tsx --filter "pre-acceptance: TTS preview"`
- `mise exec -- nsh test src/features/settings/settings.test.tsx --filter "tts preview:"`

Before the fix, Play accepts an unusable setting or leaves editing enabled. After the fix, no request uses an unsaved Azure region, and Cancel and Stop release the lock.

### Task 7: Restore the static free Google row and focus

**Seam:** Add a non-configurable channel from the picker or empty state.

- [ ] **Red:** In `src/features/settings/capability-section.test.tsx` and `src/features/settings/settings.test.tsx`, add cases with the prefix `pre-acceptance: free Google row`. Use the generic `free` channel in the shared harness and `google` in Settings. Assert that the name is visible without a no-op button. For both add paths, verify keyboard focus by pressing Enter immediately after add: it must activate the new row's Remove control and open its confirmation. Cancel must keep the row.
- [ ] **Green:** In `src/features/settings/capability-section.tsx`, use static identity content for a non-configurable row. Keep its switch, grip where applicable, and Remove button. After direct add, focus the new row's Remove control after mount. After picker add, do the same after the dialog closes. Restore both keyboard and accessibility focus. Do not change the configurable-row detail or breadcrumb behavior.

**Red → green:**

- `mise exec -- nsh test src/features/settings/capability-section.test.tsx --filter "pre-acceptance: free Google row"`
- `mise exec -- nsh test src/features/settings/settings.test.tsx --filter "pre-acceptance: free Google row"`

Before the fix, the name has a button and focus does not reach Remove. After the fix, both add paths leave the enabled row in the list with usable keyboard focus.

### Task 8: Reject duplicate IDs at startup

**Seam:** `initializeContributions()`.

- [ ] **Red:** In `src/app/ai-setup.test.ts`, add independent OCR and detection cases with the prefix `pre-acceptance: startup rejects a duplicate`. Pre-register one built-in channel in a fresh registry, use `setContributionRegistry`, and call startup assembly. Assert that it throws a duplicate registration error. Restore the prior registry in `finally`. Keep the existing successful idempotence test.
- [ ] **Green:** In `src/contributions/{ocr,detect}/index.ts`, register each channel without silently skipping matches. Keep existing duplicate checks in the registry, the startup one-time guard, and `App.tsx` error handling. IDs that repeat across different capabilities remain valid.

**Red → green:** `mise exec -- nsh test src/app/ai-setup.test.ts --filter "pre-acceptance: startup rejects a duplicate"`. Before the fix, startup skips the duplicate. After the fix, the same-capability duplicate prevents startup. Also run the file without a filter to verify the normal startup path.

### Task 9: Move Google detection I/O behind host services

**Seam:** Google detection channel `execute(..., host)` and the `detectLanguage()` chain.

- [ ] **Red:** In `src/contributions/detect/channels/channels.test.ts`, add `detect contribution: Cloud uses the host fetch boundary`. Pass `HostServices.fetchImpl`, a synthetic vault credential, and a test Cloud response. Replace `globalThis.fetch` with a rejecting function for the test and restore it in `finally`. Assert that the injected transport receives the detect request and the result is a supported language ID. Cover free Google with the same I/O seam.
- [ ] **Green:** In `src/contributions/detect/channels/google-cloud.tsx`, pass `host.fetchImpl` to `createGoogleCloudTranslateClient`. In `src/contributions/detect/vendor/google-free.ts`, pass the injected transport into `createHttpFetch` instead of bypassing the wrapper. Remove the Cloud callback from `src/contributions/detect/types.ts`. In `src/features/language-detection/detect.ts`, replace the Google-specific options with generic `FetchLike` and channel credential read seams. Keep production vault reads, AI model access, and chain policy unchanged. Remove the feature's vendor helper re-exports; tests can import a vendor helper at its owner in `src/contributions/detect/`.
- [ ] Update `src/contributions/detect/channels/channels.test.ts` and `src/features/language-detection/detect.test.ts` to return HTTP responses at the fetch seam. Keep the existing free/Cloud fallback, auth failures, no-key no-request, cancellation, and language mapping coverage. Do not change Google Cloud translation for presets.

**Red → green:** `mise exec -- nsh test src/contributions/detect/channels/channels.test.ts --filter "detect contribution: Cloud uses the host fetch boundary"`. Before the fix, the Cloud contribution does not use the supplied fetch. After the fix, it uses the injected transport and returns the language. Run `mise exec -- nsh test src/features/language-detection/detect.test.ts` to verify the chain.

### Task 10: Add Windows acceptance cases for the migrated paths

**Seam:** Real Windows Settings and Quick Translate windows.

- [ ] Add new cases with the prefix `capability desktop:` to `src/features/settings/settings.test.tsx`. Use seeded NSH storage, real window input, and no `modules` override. Check add, save, enable, priority badges, drag and keyboard reorder, and confirmed removal. Include the free Google static row and a rejected OCR enable with a single unreadable-credential alert. Keep the existing headless failure-injection cases unchanged except for the assertions required by earlier tasks.
- [ ] Add new cases with the same prefix to `src/app/quick-translate.test.tsx`. Reuse the window harness and `network` fixtures. Verify OCR fallback from Baidu to AI and text delivery, Automatic language detection through a saved detector, and a Quick TTS request through the enabled channel. Hold the TTS response until the test cancels it. Assert the request and Cancel state, not the headless `audio()` spy. Use the app's controls to close windows, not a title-bar close button on the frameless popup.
- [ ] Do not rely on simulated operating systems, `modules`, `audio()`, or the five-byte MP3 fixture for Windows playback. Keep audio lifecycle checks in headless tests. Do not mark the failed broad desktop cases as passed or remove them to make the new acceptance commands green.

**Validation:** Run both Windows commands below. Each command must select the new cases and exit with zero failures. These are acceptance tests, not changes to production behavior.

## Final Validation

The review baseline passed `mise run verify` (830 headless passes, 9 skips). The original broad Windows filters did not pass: Settings 28/33, Quick Translate 32/40. They selected cases that use headless-only APIs, assume a different operating system or window frame, or require playable audio from a short test fixture. Record the new results separately.

- [ ] `mise run verify` — formatting, lint, types, Rust and headless tests, and release build pass.
- [ ] `mise exec -- nsh test src/features/settings/settings.test.tsx --target windows --filter "capability desktop:"` — the new Settings cases run and pass.
- [ ] `mise exec -- nsh test src/app/quick-translate.test.tsx --target windows --filter "capability desktop:"` — the new Quick Translate cases run and pass.
- [ ] Manual on Windows with isolated test data: check empty-state and picker add, priority badges, drag and keyboard reorder, breadcrumb return, save and confirmed remove. Verify free Google focus and one unreadable-credential alert. Play and stop a TTS sample with a valid MP3 response from a test route, or with an approved test credential. Do not use production credentials. Record any check that did not run; do not mark it as passed.
- [ ] Record the tested commit, commands, pass/skip counts, and manual results. Accept only when Tasks 1–10 and the manual checks above are complete.

## Failure Behavior

- Failed load: keep the original record and vault entries. Show the localized load error and reject writes until a successful reload. A valid unknown channel remains skipped and preserved.
- Failed credential read: allow disable, refuse enable or reuse, and keep one recovery alert. A valid replacement can recover the channel.
- Failed save: keep the draft and the previous stored binding. Keep the localized error visible.
- Duplicate startup ID: stop assembly and use the existing startup error surface.

## Privacy and Rollout

The Baidu token exchange must not log its request or response body at any log level. Keep credentials out of versioned collection records. Do not read, rewrite, or upload existing user logs during acceptance; any review of historical logs is separate. Ship the fixes with the current storage format and built-in contributions. No data migration is required.

## Risks and Mitigations

- A green headless run does not establish native window or audio behavior. Keep the Windows commands and manual check as separate acceptance gates.
- Changing a fixture or assertion can hide a behavior change. Check the intended behavior at `f075d5a`, and record the red failure before changing production code.

**Open Questions:** None for implementation. If no approved playback fixture or test credential is available, record native playback as an acceptance blocker.
