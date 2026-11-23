# Implementation Plan

**Goal:** Add Google Cloud Translation Basic v2 as a preset engine for plain-text Quick Translate.

**Inputs:** The request to use v2, the existing DeepL preset, and Google's [Basic text guide](https://cloud.google.com/translate/docs/basic/translating-text), [v2 REST contract](https://cloud.google.com/translate/docs/reference/rest/v2/translate), [REST authentication guide](https://cloud.google.com/docs/authentication/rest), [language list](https://cloud.google.com/translate/docs/languages), [quotas](https://cloud.google.com/translate/quotas), and [pricing](https://cloud.google.com/translate/pricing).

**Assumptions:**

- The user supplies an API key from a Google Cloud project with Cloud Translation API and billing enabled. Restrict the key to Cloud Translation API. Do not bundle a key or request a project ID in the app.
- Use the default NMT model. Send one text per request and display one complete result. Exclude documents, HTML, chunking, model selection, a usage panel, v3, Google Web Translate, and Apps Script.
- Windows is the desktop acceptance target. Do not expand distribution to mobile, Web, or TUI.

**Architecture:** Presets own the engine choice and the key reference. Quick Translate resolves the source and target with its existing language flow and passes both to a dedicated v2 client. The client uses the shared JSON transport for timeout and cancellation; it owns Google language codes and failure mapping, not Models or the AI registry.

**Tech Stack:** TypeScript, NSH 0.6.1, NSH Storage and fetch, `nsh/test`, and mise. No new dependencies, Rust code, or services.

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `modules/google-cloud-translation/client.ts` | Fixed endpoint, v2 request, response checks, and localized failures. |
| Create | `modules/google-cloud-translation/languages.ts` | Map the current `LanguageId` set to Google NMT codes. |
| Test | `modules/google-cloud-translation/client.test.ts` | Check the wire contract, limits, response failures, and cancellation at the fetch boundary. |
| Modify | `modules/ai/runtime/http.ts` | Let the v2 client classify error responses without changing existing callers. |
| Modify | `features/presets/types.ts`, `features/presets/validation.ts`, `features/presets/store.ts` | Add the engine, validate saves, and manage its key separately. |
| Test | `features/presets/store.test.ts` | Check key lifetime, failed writes, and reload. |
| Modify | `features/presets/add-preset-dialog.tsx`, `features/presets/draft.ts`, `features/presets/editor.tsx`, `features/presets/page.tsx`, `features/presets/model-choices.ts` | Add the picker option, masked key form, and preset summary. |
| Test | `features/presets/presets.test.tsx` | Check selection, focus, validation, save, and reopen. |
| Modify | `features/quick-translate/translate.ts`, `features/quick-translate/popup.tsx` | Dispatch v2 translation and show the existing Google Cloud mark on its card chip. |
| Test | `features/quick-translate/translate.test.ts`, `features/quick-translate/popup.test.tsx`, `features/quick-translate/__tests__/popup-harness.tsx` | Check stored-key execution, language resolution, and result lifetime with HTTP fixtures. |
| Modify | `locales/en.yml`, `locales/zh-CN.yml`, `.stitch/DESIGN.md` | Add localized labels and failures. Record motion before editing TSX. |

## Seams

- `createGoogleCloudTranslateClient({ fetchImpl }).translate(input, options)` — one v2 request at the network boundary; returns plain text or a typed failure.
- `createPresetsStore(storage, readModelChoices)` through `save`, `load`, `remove`, and `readGoogleCloudCredential` — persist a preset and manage the referenced key.
- `translateWithPreset()` through `features/quick-translate/__tests__/translate-app.tsx` — use a saved key and the supplied language pair without a model or prompt.
- Presets through `App.tsx` — add, edit, save, and reopen a Google Cloud Translation preset.
- Quick Translate through its popup harness — translate, display, retry, cancel, and ignore stale results.

Confirm these seams before writing tests. Within each task, add one failing behavior test at a time. Run the task command, confirm the named behavior fails, implement only that behavior, and run the same command again. A missing import or type error does not count as red. Use synthetic keys and the existing storage and HTTP test boundaries. Do not send real requests in automated tests.

## Tasks

### 1. Send one plain-text request

**Seam:** `createGoogleCloudTranslateClient().translate()`.

- [ ] **Red:** For an English source and Chinese target, assert one POST to `https://translation.googleapis.com/language/translate/v2`, `x-goog-api-key` in the header, no key or source text in the URL, and `redirect: "error"`. Expect `{ "q": ["Hello\nWorld"], "source": "en", "target": "zh-CN", "format": "text" }` in the body. Supply a v2 response fixture and expect the text from `data.translations[0].translatedText`.
- [ ] **Green:** Add the client and language map under `modules/google-cloud-translation/`. Use `createJsonHttpClient({ fetchImpl })` with JSON content type. Send the original text, including whitespace and line breaks, and always supply both language codes. Verify the app's current language IDs against Google's NMT list; map `zh` to `zh-CN` and use the documented codes for the others. Omit `model` to select NMT. Do not pass `auto` to Google or add a runtime language-list request.
- [ ] **Next cycles:** Reject a blank key, blank input, or invalid language before HTTP. Check the serialized request in UTF-8 against a local `100_000`-byte ceiling (Google documents a 100K-byte limit). Include a multibyte boundary case. Do not make the 5,000-code-point latency recommendation a hard limit. For a successful HTTP response, require one translation with a string `translatedText`; reject bad JSON or response shape. Return that string as plain text.
- [ ] **Red/green:** `mise exec -- nsh test modules/google-cloud-translation/client.test.ts --filter "google cloud client:"` — expect the new request, result, or no-request assertion to fail, then pass.

### 2. Separate quota errors from key rejection

**Seam:** `createGoogleCloudTranslateClient().translate()`.

- [ ] **Red:** Return Google's documented quota `403` responses at the fetch boundary. Expect localized daily-quota and rate-limit failures, not a key error. Include a non-quota `403` case as a separate cycle.
- [ ] **Green:** `requestJson` in `modules/ai/runtime/http.ts` currently rejects non-2xx responses before reading JSON. Add an optional `classifyErrorResponse(status, body)` to `CreateJsonHttpClientOptions`. For an opted-in buffered client, read error JSON under the existing deadline and abort signal, then use the returned `ProviderProtocolError` or the default status mapping when the classifier returns `null`. Use the default mapping for malformed error JSON, but preserve cancellation and timeout. Do not read error bodies for existing clients or change the streaming path. Only the Google client opts in.
- [ ] **Next cycles:** Match the documented `Daily Limit Exceeded` and `User Rate Limit Exceeded` messages or the corresponding structured reasons. Use the failure table below for an invalid key, `429`, `5xx`, and unrecognized or non-JSON errors. Verify timeout and cancellation during the request or response read, including a pending error body. Do not return or log Google's raw body or a raw fetch error. One call makes at most one request; do not retry internally.
- [ ] **Red/green:** `mise exec -- nsh test modules/google-cloud-translation/client.test.ts --filter "google cloud client:"` — expect the new failure category or cancellation assertion to fail, then pass. Run `mise exec -- nsh test modules/ai/runtime/client.test.ts` and `mise exec -- nsh test modules/deepl/client.test.ts` to check unchanged callers.

### 3. Save the engine and manage its key

**Seam:** `createPresetsStore(...).save/load/remove/readGoogleCloudCredential`.

- [ ] **Red:** Save a Google preset with no configured AI models. Reload it and read its key by preset ID. Expect the record to contain `kind: "google-cloud"` and `credentialRef`, but no key, project, model, prompt, or language fields.
- [ ] **Green:** Add the saved and write-input engine types in `features/presets/types.ts`. Use `googleCloudCredentialStorageKey(ref)` with the separate `presets.v1.googleCloudKeys.` prefix; keep `presets.v1.items` and the DeepL key prefix unchanged. Share the existing credential save and cleanup sequence only where both engines need the same behavior. Recognize the new kind on reload. Trim surrounding whitespace, reject embedded whitespace without requiring a key prefix, and require a key on creation. Add localized validation for `googleCloudKey` and preserve the saved engine type lock.
- [ ] **Build boundary:** When widening the union, keep model reads in `model-choices.ts` and `translate.ts` behind an explicit AI guard. Until Task 4 wires the Google branch, return `presets.error.engineUnsupported` from the dispatcher for the new kind. Do not expose the picker option until Task 5.
- [ ] **Next cycles:** A blank edit retains the key; a replacement writes the new key before switching the reference, then removes the old key. If either write fails, keep the old record and key; clean up an unused new key on a best-effort basis. After a successful record deletion, remove its key. `readGoogleCloudCredential` returns `null` for the wrong engine or a missing key. A key storage failure gives a localized error without the underlying storage exception text. Verify the replacement and rollback through reload, and keep the existing DeepL store tests passing.
- [ ] **Red/green:** `mise exec -- nsh test features/presets/store.test.ts --filter "presets store: Google Cloud"` — expect the new save, read, or rollback assertion to fail, then pass.

### 4. Translate through a saved Google Cloud preset

**Seam:** `translateWithPreset()` through the existing translation harness.

- [ ] **Red:** In `features/quick-translate/translate.test.ts`, open `./__tests__/translate-app.tsx` with a saved Google Cloud preset and a stored test key, but no AI models. Stub the v2 POST. Expect the key in its header, the harness's `en` and `zh-CN` pair, `Hello {{target_language}}` unchanged, and a result with `modelId` and `templateId` set to `null`.
- [ ] **Green:** Replace the temporary dispatch guard for Google in `features/quick-translate/translate.ts`. Read only that preset's key and call the v2 client with the resolved pair, `signal`, and `timeoutMs`. Add `readGoogleCloudCredential` to `TranslateWithPresetOptions` for the popup harness's injected storage. Do not emit `onText` deltas, render a template, look up an AI model, or fall back to any other provider. Keep the existing enabled and blank-input checks. On cancel, return the current cancelled result rather than an error card.
- [ ] **Next cycles:** A missing key gives an actionable localized error and no HTTP request. For cancellation during a key read, call `translateWithPreset()` with the injected storage reader, hold its promise, abort, then release the key. Expect a cancelled result and no request.
- [ ] **Red/green:** `mise exec -- nsh test features/quick-translate/translate.test.ts --filter "Google Cloud preset:"` — expect the new dispatch or missing-key assertion to fail, then pass.

### 5. Configure Google Cloud Translation in Presets

**Seam:** Presets through `App.tsx`.

- [ ] **Red:** In `features/presets/presets.test.tsx`, open Add Preset with no AI models. Press `preset-type-google-cloud` and expect `preset-google-cloud-api-key`. Check that it needs no model, language, or prompt input. Save and reopen; the rail shows the engine label, the key input is empty with a stored-key placeholder, and the flow makes no network requests.
- [ ] **Green:** Add `Google Cloud Translation` / `Google Cloud 翻译` as the third choice in `AddPresetDialog`. Use three equal, full-width rows in the existing dialog so the label fits without widening the window. Reuse `assets/icons/google-cloud.svg`, the card button, and the existing focus and discard flow. In `draft.ts`, `editor.tsx`, and `page.tsx`, wire the Google key draft, dirty check, masked input, validation, and field focus. Keep model and prompt controls AI-only, and usage and auto-refresh DeepL-only. Use the localized engine label for draft and saved summaries, including `summarizePreset` in `model-choices.ts`.
- [ ] **Next cycles:** Saving with a missing key focuses the key field. A failed save keeps the draft for correction; a successful save or discard clears the plaintext draft. A blank key on edit leaves the key unchanged. Do not prefill the field from storage. Next to the field, state that the key is stored locally without encryption and Google Cloud usage may incur charges. Use `t()` for all new copy and accessible labels in both locales.
- [ ] **Red/green:** `mise exec -- nsh test features/presets/presets.test.tsx --filter "presets ui: Google Cloud"` — expect the option or editor behavior to fail, then pass. Run the whole file to check AI and DeepL.

### 6. Verify Quick Translate cards and language behavior

**Seam:** Quick Translate through `features/quick-translate/__tests__/popup-harness.tsx`.

- [ ] **Red:** In `features/quick-translate/popup.test.tsx`, seed a Google card and a DeepL card, automatic source, and explicit target. Verify that the current detector resolves the shared source once and that the two translation endpoints receive the same resolved pair in their own codes. The Google card shows the complete result and no template selector, even with a stale override.
- [ ] **Green:** Pass the harness store's `readGoogleCloudCredential` into `translateWithPreset`. In `features/quick-translate/popup.tsx`, extend `PresetLeadingMark` with the existing Google Cloud mark and keep template controls AI-only. Keep `session.ts`'s language and request lifecycle: use its resolved pair, debounce, cancellation and stale-result checks. Do not add a Google detector, a separate auto-translate toggle, or a new card state. Record the motion inventory in `.stitch/DESIGN.md` before writing affected TSX.
- [ ] **Next cycles:** Two explicit languages make no detection request. Detection off or failed for automatic source blocks the translation with the existing recovery message. Automatic target uses the current target resolution rules. A rejected Google request fails only its card; retry follows the existing card action. After a newer request or popup close, a late Google result cannot replace the current result or repopulate the popup.
- [ ] **Red/green:** `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "Google Cloud card:"` — expect missing Google dispatch in the harness or the new card assertion to fail, then pass. Run `mise exec -- nsh test features/quick-translate/popup.test.tsx` to check the shared behavior.

## Motion Inventory

Record the following before Tasks 5 and 6; verify on Windows as part of final validation.

| State change | Existing tool and reduced motion |
| --- | --- |
| Picker or discard dialog opens and closes | `AppDialog` with `motion.dialogAnimation`; instant with reduced motion. Keep focus return or move focus to the new draft name. |
| Option and action hover or press; rail selection; enabled switch | `motion.pressScale`, `motion.navigationFeedback`, and `motion.switchThumb` from the existing controls. Reduced motion removes transitions and scale; focus remains visible. |
| Draft and saved editor, key placeholder, validation, save and delete | Keep the existing editor swap, field feedback, and save toast (`motion.toastTransition` and `motion.toastStack`). Do not animate form layout or errors. Reduced motion removes toast movement. |
| Card picker and translation result | Keep the existing Select popup transition and loading/result states. Replace loading with the complete result or inline error. No streaming, progress animation, gesture, sound, or new layout transition. |

## Failure Behavior

| Condition | Result |
| --- | --- |
| Missing or unreadable key | Explain how to add or replace it in Presets. Do not send a request. |
| Blank, unsupported language, or over the local byte limit | Reject locally. Explain how to correct the input or shorten it. |
| `403` with a known daily-quota or per-minute reason; HTTP `429` | Report quota or rate limit (`rate_limited`) and allow manual retry. |
| Known invalid or restricted key, including a key error sent as `400`; `401` or other `403` | Report rejected access. Ask the user to check the key, enabled API, billing, or quota as applicable. Do not label a known quota error as a bad key. |
| Other `400`, `413`, `5xx`, bad success response, network failure, or timeout | Use a localized input, size, server, invalid-response, network, or timeout message. Do not show raw provider text. |
| Cancel or stale completion | No error card or late result. |

## Privacy and Security

- Send the key only in `x-goog-api-key` to `translation.googleapis.com` over HTTPS. Reject redirects. Do not accept a custom host, put the key in the URL, or expose it in logs, error details, or test reports.
- NSH Storage separates the key from preset JSON but does not encrypt it. Do not load the key into editor state on reopen. Do not add import, export, or sync for keys.
- Send only the source text and resolved language codes needed for translation. Do not log the source, result, or request body. Keep existing detection behavior and send no additional detection request to Google. Save, reopen, or replace the key in Presets without testing it over the network.

## Rollout and Risks

- No default Google preset, migration, deployment, or setting change. A user creates a Google preset and selects it as a Quick Translate card. Existing Auto-translate behavior applies to that active card and can add billable requests. Do not claim the service is free or that a saved key has been verified.
- Watch for v2 error-body variants. Use the documented quota cases and recognized structured reasons. Keep a generic, localized fallback for unknown forms without exposing raw details.
- `features/quick-translate/session.ts` and `features/quick-translate/popup.test.tsx` had unrelated local edits when this plan was written. Recheck the worktree before implementation, preserve existing changes, and confirm the popup baseline before editing its tests.

## Final Validation

- [ ] `mise run verify` — formatting, lint, type checks, tests, and build pass.
- [ ] `mise exec -- nsh test features/presets/presets.test.tsx --filter "presets ui: Google Cloud" --target windows` — picker and editor work on the desktop host. Use `mise run dev` to check the picker, form, and result card in light and dark, both locales, at the default and minimum window sizes. Check visible focus, keyboard operation, Narrator, and reduced motion. Report unverified groups separately from headless test results.
- [ ] With approval and a user-owned Cloud project, save an API-restricted key in the desktop app. Translate one short, non-sensitive sample with an apostrophe, `&`, and a newline. Verify key-only header authentication and inspect the plain-text rendering. Do not send sensitive text, intentionally exhaust quota, or record the key. If no project is available, report live verification as not done.

**Approval:** Confirm the plan and the per-preset, unencrypted local key storage before implementation. Do not change feature code or run live translation requests for this planning task.
