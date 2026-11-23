# Implementation Plan

**Goal:** Add Google Cloud Vision as a third channel for screenshot OCR in My Translator.

**Inputs:** The request to add Google Cloud OCR, the current AI and Baidu OCR channels, and Google's [Vision request guide][request], [OCR guide][ocr], [REST reference][annotate], [quotas][quotas], and [pricing][pricing].

**Assumptions:**

- Use Cloud Vision API v1 with one fixed `DOCUMENT_TEXT_DETECTION` feature for both short and dense screenshots. Let Vision detect the language. Do not add a mode selector.
- The user supplies a standard API key restricted to Cloud Vision API, from a project with the API and billing enabled. Do not use a built-in key, reuse a Google Cloud Translation preset key, or ask for a project ID. No OAuth, service account file, or proxy in this release.
- Use the existing Windows screenshot entry points. Do not add PDF or TIFF import, batch OCR, language hints, connection checks, or usage tracking.

**Architecture:** The OCR settings store owns the channel order, enabled state, and local key reference. The recognition dispatcher uses its existing fallback rules to pass one cropped PNG to the Vision client. Quick Translate receives the recognized text, not the image or the key.

**Tech Stack:** TypeScript, NSH 0.6.1, NSH Storage, the existing JSON HTTP client, `nsh/test`, and mise. No new dependencies or Rust code.

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `features/ocr/google-cloud.ts` | Vision request, response checks, and typed results. Reuse `modules/ai/runtime/http.ts` without changing it. |
| Test | `features/ocr/google-cloud.test.ts` | Inspect the request and exercise Vision responses at the fetch boundary. |
| Modify | `features/ocr/settings.ts` | Add the channel, key reference, and key lifetime rules. |
| Test | `features/ocr/settings.test.ts` | Check first save, reload, priority, replacement, and failed writes. |
| Modify | `features/ocr/recognize.ts` | Check local readiness, dispatch Vision OCR, and map its outcomes. |
| Test | `features/ocr/recognize.test.ts`, `features/ocr/__tests__/recognize-app.tsx` | Exercise saved bindings, fallback order, and changes between readiness and upload. |
| Modify | `features/settings/ocr-section.tsx` | Add the row and masked key form. Reuse the breadcrumb in `features/settings/page.tsx` and `assets/icons/google-cloud.svg`. |
| Modify | `locales/en.yml`, `locales/zh-CN.yml`, `.stitch/DESIGN.md` | Add localized copy and record the UI motion inventory before editing TSX. |
| Test | `features/settings/settings.test.tsx` | Check the Settings workflow, safe key display, toggle, and reorder. |
| Test | `app/quick-translate.test.tsx` | Verify the workflow through `app/__tests__/quick-translate-harness.tsx`. No controller or capture changes are planned. |

## Seams

- `createGoogleCloudOcrClient({ fetchImpl }).recognize(input, options)` — one Vision request and a typed recognition outcome.
- `createOcrSettingsStore(storage)` through `save`, `load`, `savedGoogleCloudBinding`, `readGoogleCloudCredential`, `setEnabled`, and `moveChannelTo` — saved key and channel state.
- `checkOcrReadiness()` and `recognizeScreenshot()` through `features/ocr/__tests__/recognize-app.tsx` — local readiness and priority fallback with saved bindings.
- Settings > OCR through the app — find, configure, enable, disable, and reorder the Google Cloud channel.
- Quick Translate through the existing app harness — capture, recognize, and deliver text into the current translation flow.

Confirm these seams before writing tests. For each cycle, add one behavior test, run the specified command, observe the named behavior failure, then implement only that behavior and rerun the same command. A missing import or type error is not a valid red result. Use synthetic keys and HTTP fixtures only in automated tests.

## Tasks

### 1. Recognize one crop with Vision

**Seam:** `createGoogleCloudOcrClient({ fetchImpl }).recognize(input, options)`.

- [ ] **Red:** In `features/ocr/google-cloud.test.ts`, supply a synthetic key and Base64 PNG. Expect one `POST https://vision.googleapis.com/v1/images:annotate`, `Content-Type: application/json`, `x-goog-api-key`, and `redirect: "error"`. Expect no query string and the body `{ "requests": [{ "image": { "content": "<base64>" }, "features": [{ "type": "DOCUMENT_TEXT_DETECTION" }] }] }`. Return `responses[0].fullTextAnnotation.text` with two lines in different languages. Expect `recognized` with the original string.
- [ ] **Green:** In `features/ocr/google-cloud.ts`, add the client with `{ apiKey, imageBase64 }` input and `{ signal, timeoutMs }` options. `imageBase64` is the output of the caller's PNG validation and encoding. Use `createJsonHttpClient({ fetchImpl, classifyErrorResponse })` and `postJson`. Do not send `parent`, `imageContext`, or a second feature. Return `recognized`, `no_text`, `cancelled`, or `failed` with a typed reason. Do not retry.
- [ ] **Next cycles:** Require exactly one object in `responses`. Check its `error` before reading text, even on HTTP 200. Reject malformed envelopes and a present `fullTextAnnotation` without string `text`. If there is no annotation and no error, or the text is blank, return `no_text`. Use `trim()` only to test for blank text. Verify a blank key sends nothing, and cover the failure table below, including timeout and cancellation during response reads. Do not pass raw transport details or Google error text to callers.
- [ ] **Red/green:** `mise exec -- nsh test features/ocr/google-cloud.test.ts --filter "google cloud ocr:"` — the new request, result, or failure assertion fails first and then passes.

### 2. Save the channel and manage its key

**Seam:** `createOcrSettingsStore(storage)`.

- [ ] **Red:** In `features/ocr/settings.test.ts`, load a two-channel record with Baidu before AI. Expect `google-cloud` appended and off without a write. In the next cycle, save a new Vision key and reload. Expect the existing order and enabled states unchanged, Google Cloud enabled, and its key readable only through its credential reference.
- [ ] **Green:** In `features/ocr/settings.ts`, add `OcrGoogleCloudBinding` (`kind: "google-cloud"`, `credentialRef`), `savedGoogleCloudBinding()`, and `readGoogleCloudCredential(ref): Promise<string | null>`. Keep `settings.ocr.v3`. Accept the exact two-channel layout when the Google Cloud fields are absent; add the third channel in memory without a migration write. Save all three kinds in `order` and `enabled`, and store `"google-cloud": { "credentialRef": "…" }` or `null`. Reject duplicate or unknown kinds, incomplete three-channel data, and enabled channels without a binding. Do not read keys during `load()`.
- [ ] **Green:** Add `googleCloudCredentialStorageKey(ref)` with prefix `settings.ocr.googleCloudKeys.`. Use `credentials: { kind: "keep" } | { kind: "replace"; apiKey: string }` in the Google save input. Trim surrounding whitespace, reject a blank replacement or embedded whitespace, and do not require a key prefix. First save enables the channel. Later saves preserve its enabled state and its order. Keep requires a readable saved key. Use the existing write queue: write a new key to a new reference, commit the settings, then remove the old key. On record write failure, keep the old key and clean up the unused new key. Use best-effort cleanup; a cleanup warning contains no values or raw errors.
- [ ] **Build boundary:** When widening the union, make the existing AI and Baidu branches explicit in `features/ocr/recognize.ts`; return unavailable for Google until Task 3. Record the Google Cloud OCR motion inventory in `.stitch/DESIGN.md` before the first TSX edit. In `features/settings/ocr-section.tsx`, register its row offset, name, and configured state. Do not show Baidu's summary or allow a Baidu save for the Google detail. Complete the Google detail in Task 4. Do not release an intermediate slice.
- [ ] **Next cycles:** Verify first save, key replacement, both write failure points, and toggle/reorder persistence. Disabling leaves the key in place. Update existing expected persisted payloads and order assertions in the store and Settings tests. Keep valid two-channel fixtures for load regression coverage.
- [ ] **Red/green:** `mise exec -- nsh test features/ocr/settings.test.ts --filter "ocr store:"` — the new default order, reload, or rollback assertion fails first and then passes. Existing AI and Baidu tests also pass after the expected order and payload updates.

### 3. Use Vision in the existing recognition order

**Seam:** `checkOcrReadiness()` and `recognizeScreenshot()`.

- [ ] **Red:** In `features/ocr/recognize.test.ts`, seed a saved Google binding and no AI model or Baidu credentials. Readiness alone is true and sends nothing. In the recognition case, expect one Vision request and the returned original lines.
- [ ] **Green:** In `features/ocr/recognize.ts`, check that the saved Google binding is still enabled with the same reference before and after reading the key. Check cancellation before upload. Use `encodePngForUpload` with the existing 3 MiB raw PNG limit. Even with Base64 and JSON overhead, one such crop stays under Google's 10 MB JSON request limit. Pass the caller's signal and the existing 30-second timeout per channel to Vision. Map typed failures to fixed `ocr.failure.*` messages in both locales.
- [ ] **Next cycles:** Extend `features/ocr/__tests__/recognize-app.tsx` to disable Google Cloud after readiness and before recognition. A missing, unreadable, or disabled binding sends no Vision request. Verify the order when Google succeeds as a backup, and when a Google failure proceeds to an enabled backup. Verify that Google `no_text` and cancellation stop fallback. Preserve the existing last-failure and first-unavailable rules if no channel succeeds. Do not add retries or a new overall deadline. Trying more channels can increase the total wait.
- [ ] **Red/green:** `mise exec -- nsh test features/ocr/recognize.test.ts --filter "ocr recognize:"` — the new readiness, route, or fallback assertion fails first and then passes.

### 4. Configure Vision in Settings

**Seam:** Settings > OCR through the app.

- [ ] **Red:** In `features/settings/settings.test.tsx`, open `settings-ocr-channel-google-cloud` with no AI models. Expect one masked `settings-ocr-google-cloud-api-key` field, no model or mode selector, and Save disabled before entry. Save and reopen. Expect an enabled row, a blank field with a saved-key placeholder, and no requests.
- [ ] **Green:** Extend the existing OCR list and detail card in `features/settings/ocr-section.tsx`; use the Google Cloud mark, `FormField`, `Input`, `Button`, and the existing switch and grip. Use `Google Cloud Vision` in both locales via `settings.ocr.google-cloud`. Reuse the existing breadcrumb and return focus to the row. Reuse the existing entrance, row reorder, control, and save toast behavior, including reduced motion. Do not animate field text or errors.
- [ ] **Green:** Keep the key draft local to the detail view. Never put the saved key in the input or summary. Track Google key readability independently of Baidu; ignore results from a stale reference check. Clear the draft after save or on leaving the detail. Keep it after a failed save for correction. Use `t()` for labels, placeholders, and alerts in both locale files. State that the selected crop is sent to Google and usage may incur charges; state that the key is stored locally without encryption. Do not imply Google is the only possible recipient when multiple OCR channels are enabled.
- [ ] **Next cycles:** Verify a missing stored key asks for a replacement, empty edits keep a readable key, and replacement leaves a disabled channel disabled. Move Google Cloud with its keyboard grip; verify order and focus. Verify the status and labels in both locales. Use the existing Windows-only capture notice on other desktops.
- [ ] **Red/green:** `mise exec -- nsh test features/settings/settings.test.tsx --filter "ocr settings:"` — the new form, restore, or reorder assertion fails first and then passes.

### 5. Verify the screenshot-to-translation workflow

**Seam:** Quick Translate through `app/__tests__/quick-translate-harness.tsx`.

- [ ] **Red/green if a gap is found:** In `app/quick-translate.test.tsx`, start with a Google-only OCR binding, an existing draft, and one eligible translation preset with known source and target languages. Trigger the existing OCR action. Expect one crop, one Vision request, and one translation request. Expect the original lines to replace the draft and only the recognized text to reach the translation endpoint. These assertions can pass on the first run after Task 3. If not, fix only the violated contract, then rerun; do not change the controller just to make a test fail first.
- [ ] **Regression:** Cancel capture and expect no Vision request. Edit the draft while Vision is pending and expect the late result not to replace it or start translation. When Vision fails and no backup can run, expect a localized message and no draft change or translation. Use the existing capture seam and network fixtures; do not add a production test mode.
- [ ] **Run:** `mise exec -- nsh test app/quick-translate.test.tsx --filter "quick ocr:"` — the Google cases and existing AI and Baidu cases pass.

## Failure Behavior

| Condition | Expected behavior |
| --- | --- |
| Missing key, unreadable key, or binding changed before upload | Mark the channel unavailable without making a request. The dispatcher can try the next enabled channel. |
| Invalid or oversized crop | Reject locally before any upload. For HTTP `413`, ask for a smaller selection. |
| HTTP `401`/`403`; Google [`ErrorInfo`][reasons] for an invalid or blocked key, disabled service, or disabled billing; image error code `7` or `16` | Ask the user to check the Vision key, API access, and billing. Do not expose project identifiers. |
| HTTP `429`, `RESOURCE_EXHAUSTED`, image error code `8`, or a documented rate or resource quota reason | Ask the user to check Google Cloud quota or try later. A quota error does not mean the monthly free allowance was used up. Prefer a structured quota reason to the generic `403` mapping. |
| Bad JSON or wrong response shape, including a malformed image error | Report an invalid response. Do not import partial text. |
| Other HTTP errors, network failure, redirect, or nonzero image error not listed above | Report a fixed service failure. The dispatcher can try the next enabled channel. |
| Valid response with no text | Use the existing no-text message. Stop fallback and keep the draft. |
| Timeout or cancellation | On timeout, use the existing timeout message and allow fallback. On cancellation, stop silently. Ignore late results. |

HTTP errors use the HTTP status and the outer `error` object. Match `ErrorInfo` entries in `error.details` or in the image status details when the domain is `googleapis.com`. Map `API_KEY_INVALID`, `API_KEY_SERVICE_BLOCKED`, `SERVICE_DISABLED`, and `BILLING_DISABLED` to setup errors. Map `RATE_LIMIT_EXCEEDED` and `RESOURCE_QUOTA_EXCEEDED` to quota errors. `responses[0].error` is a separate [RPC status][status], with numeric `code` values; code `0` does not indicate a failure. Never use provider message text to classify errors, and never display it.

## Privacy and Rollout

- Only the selected crop goes to Vision. If recognition fails, the same crop may go to the next enabled OCR channel. Capture cancellation and local validation failures send nothing. Do not send the full screen, clipboard, or translation settings to Vision.
- Store the key in a separate NSH Storage entry. This is local separation, not encryption. Do not log the key, headers, image, request or response body, recognized text, raw errors, or credential contents. Do not put a real key in fixtures or documentation. Send it in `x-goog-api-key` over HTTPS to the fixed Google host, not in the URL. Follow Google's [API key guidance][key-guidance].
- The new row is last and off until configured. Existing users retain their AI and Baidu bindings, enabled states, and relative order. The first successful settings write saves the expanded record.
- Google bills by image and feature. With the single Vision feature in this plan, one crop submitted to Google uses one OCR unit. The first 1,000 units of that feature per month are free under [current pricing][pricing]; usage above the allowance can incur charges. The app does not claim or enforce a spending cap. For setup, enable Cloud Vision API and billing in the project, create a key restricted to Cloud Vision API, then enter it under Settings > OCR.

## Final Validation

- [ ] Run `mise run verify`. Expect formatting, lint, Rust and TypeScript checks, headless tests, and build to pass.
- [ ] Run `mise run dev` on Windows. Inspect Settings at its minimum size in light and dark, in English and Simplified Chinese, and with reduced motion. Check spacing, labels, masking, contrast, focus, hover and press states, error recovery, and save feedback. Use keyboard and Narrator to open the row, save, go back, toggle, and reorder. Verify dragging across all three rows and record the motion and accessibility results.
- [ ] With an authorized project and a non-sensitive two-line screenshot, verify that `x-goog-api-key` alone works on the real Vision endpoint, preserves line breaks, and leads to one translation. Also check a blank crop. If an authorized key is not available, report live authentication and response compatibility as unverified. Fixtures do not prove either.

**Open questions:** None that block the plan. The fixed Vision feature and separate user-supplied key are proposed for review before coding.

[request]: https://cloud.google.com/vision/docs/request
[ocr]: https://cloud.google.com/vision/docs/ocr
[annotate]: https://cloud.google.com/vision/docs/reference/rest/v1/images/annotate
[quotas]: https://cloud.google.com/vision/quotas
[pricing]: https://cloud.google.com/vision/pricing
[reasons]: https://docs.cloud.google.com/java/docs/reference/proto-google-common-protos/latest/com.google.api.ErrorReason
[status]: https://cloud.google.com/vision/docs/reference/rest/v1/Status
[key-guidance]: https://cloud.google.com/docs/authentication/api-keys-best-practices
