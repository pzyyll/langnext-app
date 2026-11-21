# Implementation Plan: Baidu OCR

**Goal:** Add Baidu OCR to Settings > OCR and use it to read the selected screen region in Windows Quick Translate.

**Inputs:** The request to add 百度 OCR, the current [screenshot OCR plan](2026-11-20-screenshot-ocr-plan.md), and `langnext-app` at `8513cb4`.

**Assumptions:** The app saves one active OCR service. Baidu uses the same four recognition modes as the reference and defaults to high-accuracy recognition with positions. The app imports text only. Saving AI OCR in place of Baidu OCR removes the saved Baidu credentials. The draft alone does not change the active service.

**Architecture:** Keep the current capture and Quick Translate flow. Route the saved binding to either the existing AI client or a Baidu client that exchanges credentials for a token and uploads only the confirmed crop. Use Windows Data Protection API (DPAPI) for the credential pair and store one protected binding in NSH Storage.

**Tech stack:** Native Shell 0.6.1, TypeScript/TSX, Rust, the existing `windows-sys` 0.61 dependency, `nsh/test`, and mise.

---

## Scope and evidence

- `features/ocr/settings.ts` stores one binding. `features/settings/ocr-section.tsx` offers AI OCR only. `app/quick-translate-controller.ts` checks readiness before capture, restores the popup before upload, and rejects late results. Keep these boundaries. Do not change native capture, translation, language detection, or model eligibility.
- In `langnext-app`, `runtime-plugins/baidu-ocr/schemas/config.json` defines API Key and Secret Key. `runtime-plugins/baidu-ocr/schemas/ocr-preferences.json` defines the four modes and the `accurate` default. `src-tauri/src/services/baidu_token_exchanger.rs` and `runtime-plugins/baidu-ocr/protocol/src/lib.rs` show token exchange, form encoding, and text extraction. Do not port the Tauri/Wasm plugin system or general-purpose credential vault.
- The reference sends `auto_detect` for all modes. Baidu documents it only for the high-accuracy modes below. Use the documented parameters, not the same form for all four modes. Do not add a language selector, file or URL input, position display, custom endpoints, or a connection-test action.

| Mode | English label | Chinese label | POST path under `/rest/2.0/ocr/v1/` | `language_type` |
| --- | --- | --- | --- | --- |
| `general_basic` | Standard | 标准版 | [`general_basic`](https://cloud.baidu.com/doc/OCR/s/zk3h7xz52) | `CHN_ENG` |
| `accurate_basic` | High accuracy | 高精度版 | [`accurate_basic`](https://cloud.baidu.com/doc/OCR/s/1k3h7y3db) | `auto_detect` |
| `general` | Standard with positions | 标准含位置版 | [`general`](https://cloud.baidu.com/doc/OCR/s/vk3h7y58v) | `CHN_ENG` |
| `accurate` | High accuracy with positions | 高精度含位置版 | [`accurate`](https://cloud.baidu.com/doc/OCR/s/tk3h7y2aq) | `auto_detect` |

## File map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `src/baidu_credentials.rs`, `platform/baidu-credentials.ts` | Protect and read a credential pair through a small native module and a typed TS wrapper. Keep native tests in the Rust module. |
| Modify | `src/lib.rs`, `Cargo.toml` | Register the module. Add the `Win32_Security_Cryptography` feature to the existing Windows dependency. Do not upgrade dependencies. |
| Modify and test | `features/ocr/settings.ts`, `features/ocr/settings.test.ts` | Define the Baidu mode values and binding. Test validation, save, load, credential replacement, and write failures. |
| Create and test | `features/ocr/baidu.ts`, `features/ocr/baidu.test.ts` | Validate the Baidu image limits. Exchange a token, send the form, and map the response. |
| Modify and test | `features/ocr/recognize.ts`, `features/ocr/recognize.test.ts`, `features/ocr/__tests__/recognize-app.tsx` | Add the Baidu readiness and recognition routes. Keep the AI route. Allow the test harness to use the saved binding of either kind. |
| Modify and test | `features/settings/ocr-section.tsx`, `features/settings/settings.test.tsx` | Add the service, mode, credential form, and recovery states in the existing card. |
| Modify | `locales/en.yml`, `locales/zh-CN.yml`, `docs/ui/DESIGNE.md` | Add localized copy and record the form's control states and motion. Update model-only descriptions that now apply to both services. |
| Test | `app/quick-translate.test.tsx` | Verify the existing capture, replacement, translation, and cancellation flow with a saved Baidu binding. No controller logic change is planned. |

## Seams

- **Credential protection:** `BaiduCredentialsNative.seal` and `unseal` — data saved by this Windows user can be read again; invalid or unavailable protection fails closed.
- **Settings:** `createOcrSettingsStore(...).save`, `load`, and `settings` — one valid active binding, no plaintext credentials in saved state, and no partial update on reported failure.
- **Baidu client:** `createBaiduOcrClient({ fetchImpl }).recognize({ operation, credentials, png }, { signal, timeoutMs })` — the fixed HTTP contract, time budget, and recognition result.
- **OCR service:** `checkOcrReadiness` and `recognizeScreenshot` — provider routing, local checks before capture/upload, and the existing result types.
- **Settings UI:** Settings > OCR — visible controls, save and restore, and local recovery without network requests.
- **Quick Translate:** The existing OCR button and source editor — a successful result changes the source and triggers one translation action; cancellation and failure do not change the draft.

## Tasks

Confirm these seams before implementation. In each cycle, add one behavior test. Run its command and confirm it fails on the stated behavior. Add the smallest implementation that passes the test and run the same command again. A new API can start with a typed failing stub so the test runs. Use test doubles only at the OS, storage, or HTTP boundary. Do not add a production test mode.

### 1. Save a protected Baidu binding

**Seams:** Credential protection, then Settings. **Outcome:** Save and reload either binding without writing a plaintext key or token.

- [ ] **Red:** In `src/baidu_credentials.rs`, test that `seal` and `unseal` round-trip a synthetic credential payload on Windows. Next, assert that a truncated protected payload fails.
- [ ] **Green:** Add a stateless `BaiduCredentialsNative` module under `my-translator/native`. Wrap `CryptProtectData` and `CryptUnprotectData` with `CRYPTPROTECT_UI_FORBIDDEN` and current-user scope; do not use `CRYPTPROTECT_LOCAL_MACHINE`. Use checked lengths and release Win32 output buffers with `LocalFree`. Export byte inputs and outputs; validate the JSON pair in `platform/baidu-credentials.ts` and Base64-encode only the protected bytes for storage. On non-Windows targets, return an unsupported error. Do not add a plaintext fallback. Use fixed errors without payloads. Check generated NSH types with `mise run check`.
- [ ] **Red:** In `features/ocr/settings.test.ts`, inject the protector and memory storage. Save a Baidu binding with two synthetic keys. Load a second store from the same storage and verify the selected mode, the protected payload, and the absence of plaintext keys in storage and public settings.
- [ ] **Green:** Preserve `{ version: 1, kind: "ai", modelId }` and the `settings.ocr.v1` key. Add `{ version: 1, kind: "baidu", operation, sealedCredentials }`, with the closed mode set above and a nonblank protected value. Model the binding as a discriminated union. Let `save` accept the existing AI input or a Baidu input with `operation` and a credential update of `keep` or `replace` with both keys. Trim the keys and reject a blank key. `keep` can use only the active Baidu binding. Return the saved binding, not the plaintext input. Expose local credential reads only to the OCR runtime through the protector. Loading the settings does not decrypt the keys.
- [ ] **Next cycles:** Verify that an unknown mode, a malformed record, or a first Baidu save with missing keys cannot become active. Mode-only saves keep the protected pair. Replacing the pair seals both keys at once. A successful AI save replaces the Baidu record; switching back to Baidu then requires both keys. Keep sealing and the single `Storage.setItem` call in the existing write queue; resolve `keep` inside that queue. On a reported sealing or write failure, keep the previous binding and allow a retry.
- [ ] **Red/green:** `mise exec -- cargo test --lib baidu_credentials` on Windows: round-trip or damaged-payload test fails, then passes. `mise exec -- nsh test features/ocr/settings.test.ts --filter "ocr store:"`: the new Baidu save/restore case fails, then passes with the existing AI cases. Repeat for each follow-up case.

### 2. Recognize a crop through Baidu

**Seam:** Baidu client. **Outcome:** A valid crop returns text or a specific failure from the selected Baidu mode.

- [ ] **Red:** In `features/ocr/baidu.test.ts`, use a valid synthetic PNG and inject `fetchImpl`. Expect exactly two POST requests in order: token exchange and `accurate` recognition. Inspect the decoded form values. Return two `words_result` items and expect `First line\n第二行`.
- [ ] **Green:** Use `POST https://aip.baidubce.com/oauth/2.0/token` with form fields `grant_type=client_credentials`, `client_id`, and `client_secret` in the body, as shown in [Baidu's token procedure](https://cloud.baidu.com/doc/OCR/s/skruaza7j). Require a nonblank `access_token`. Send the OCR POST to the fixed HTTPS origin and the path in the mode table, with an encoded `access_token` query value. Set `Content-Type: application/x-www-form-urlencoded` on both requests. Use `URLSearchParams` on the raw values so Base64 `+`, `/`, and `=` are encoded once. Send only `image` and the documented `language_type`. Do not send a data URL or request optional metadata. Set `redirect: "error"` on both calls.
- [ ] **Green:** Parse the success object only if `words_result` is an array and every entry has a string `words`. If present, `words_result_num` must match its length. Trim each line, discard blank lines, and join the rest with `\n` in response order. Ignore positions. An empty array or all-blank lines means `no_text`; an absent array or a bad item means malformed response, not partial text.
- [ ] **Next cycle — limits:** Keep the existing shared 3 MiB raw PNG cap. For Baidu, check the PNG's IHDR dimensions before exchange: each side must be 15–4096 pixels. Check the actual Base64-then-URL-encoded `image` value against a conservative 4,000,000-byte limit. The [general call guide](https://cloud.baidu.com/doc/OCR/s/Ck3h7y2ia) lists smaller limits than individual endpoint pages; choose its common bounds for this release. A bad header, crop outside the dimensions, or oversized form sends neither request. Cover exact boundaries with synthetic fixtures. Do not resize or change native capture.
- [ ] **Next cycle — failures:** Read at most 8 KiB for the token response and 2 MiB for OCR, using the NSH response body stream and counting bytes before JSON parsing. Decode errors and schema errors return fixed categories. Check non-2xx status and nonzero `error_code`, even on HTTP 200. Check the mapping below with synthetic responses that include sentinel secrets in `error_msg` and network errors; the result must not contain them.
- [ ] **Next cycle — cancellation:** Use one deadline and abort controller for both requests and both body reads; the recognition caller supplies the current 30-second budget. Clean up timers and listeners. Preserve the distinction between timeout and caller cancellation. Test abort before exchange, abort while waiting for a token (no upload), and timeout during the OCR response (no text). Do not retry or cache tokens in this release: each confirmed, valid crop gets one token exchange and at most one upload.
- [ ] **Red/green:** `mise exec -- nsh test features/ocr/baidu.test.ts --filter "baidu ocr:"`: expect the request or result assertion to fail, then pass. Repeat for the other three modes, limits, failure mappings, redirects, and cancellation.

### 3. Route readiness and recognition

**Seam:** OCR service. **Outcome:** The saved service reads a crop without depending on the other provider.

- [ ] **Red:** In `features/ocr/recognize.test.ts`, use the real recognition entry points with a saved Baidu binding, a credential-protection substitute, and HTTP fixtures. Leave the model catalog empty. Readiness must pass with zero requests. Recognition must use Baidu and return the two original lines.
- [ ] **Green:** In `recognize.ts`, keep the AI model resolver and dispatch by `binding.kind`. For Baidu, reuse the shared raw PNG checks without Base64-encoding in `recognize.ts`; the Baidu client encodes the bytes once. Readiness checks whether the local pair can be read. On missing, unusable, or unsupported credentials, return `unavailable` with localized recovery and no capture. Read the pair again before recognition, compare the Baidu snapshot with the current binding, and reject a changed binding before sending requests. A save between capture and recognition must not redirect the image to a new provider, mode, or credential pair. Keep the client's token and plaintext keys local to the run. Map its results to `OcrRecognitionOutcome` and `t()` messages. Do not fall back to AI OCR or any other Baidu mode.
- [ ] **Next cycles:** Verify that preflight makes zero requests, even if the keys would later fail remote authentication. Verify unreadable credentials and a binding changed during capture make zero requests. Update `features/ocr/__tests__/recognize-app.tsx` to accept a saved binding of either kind, preserving explicit AI model IDs for existing tests. Cover cancellation, no text, malformed responses, and credential/quota errors through the public OCR seam.
- [ ] **Red/green:** `mise exec -- nsh test features/ocr/recognize.test.ts --filter "ocr recognize:"`: expect the saved Baidu route or readiness assertion to fail, then pass along with the existing AI regression tests.

### 4. Configure Baidu in Settings

**Seam:** Settings UI. **Outcome:** The user can select Baidu, save the keys and mode, and reopen Settings without revealing either key.

- [ ] **Red:** In `features/settings/settings.test.tsx`, open `settings-nav-ocr` with an empty model catalog. Choose Baidu OCR. Expect the default mode, no Models warning or shortcut, and Save disabled until both keys are entered. Save, reopen, and verify the saved service and mode, blank key fields, and zero HTTP requests.
- [ ] **Green:** Update `docs/ui/DESIGNE.md` before editing the form. Extend the existing `Card` and service `Select` (`settings-ocr-service`) with a keyed Baidu branch. Add `settings-ocr-baidu-operation`, `settings-ocr-baidu-api-key`, and `settings-ocr-baidu-secret-key`. Use shared `FormField`, `Select`, and masked `Input` components. Keep tab order service → mode → API Key → Secret Key → Save. Make each field's visible and accessibility labels come from `t()`. Reuse the existing shared Select overlay, input focus ring, and press feedback. Change the form, alerts, and Save state immediately; do not add motion.
- [ ] **Green:** Keep service drafts local to the section. Never prefill saved keys. If the active service is Baidu, blank fields keep both saved keys; to replace the pair, require both new keys. Show a short hint for that rule. Clear plaintext drafts on successful save, service change, or leaving the section; preserve them for a local save retry. Hide all AI model controls and recovery while Baidu is selected. On non-Windows targets, keep the existing capture notice and disable Baidu fields and Save; AI settings stay available.
- [ ] **Next cycles:** Use `settings.ocr.baidu` for `Baidu OCR` / `百度 OCR` and add mode labels (above), field labels, and errors to both locale files. Reuse `settings-ocr-privacy`; show “The selected area is sent to Baidu.” / “所选区域会发送给百度。” only for Baidu. Preserve AI's existing copy. When the saved service is Baidu and the draft service is AI, state that saving AI removes the Baidu keys. Verify that merely switching the draft does not remove them; only a successful AI save does. Verify incomplete replacements and failed writes leave the active binding unchanged.
- [ ] **Red/green:** `mise exec -- nsh test features/settings/settings.test.tsx --filter "ocr settings:"`: expect the new service option or restore assertion to fail, then pass with the AI regression tests. Use a native module substitute for deterministic headless protection failures; verify real DPAPI save and restore on Windows as specified below.

### Quick Translate acceptance tests

These tests verify the routes delivered by Task 3 through the existing controller. They do not require a new controller implementation.

- [ ] In `app/quick-translate.test.tsx`, start with a saved Baidu binding, an old draft, and one eligible preset. Reuse the capture harness and HTTP fixture patterns. Activate `quick-translate-ocr`. Verify one crop, one token request, one image upload to Baidu, and one translation request with the recognized text only. Check that the editor replaces the old draft and keeps the line break. The image, keys, and OCR token must not enter the translation request.
- [ ] Check cancelled selection (no requests), a late Baidu response after a source edit (no replacement or translation from OCR), and a quota failure (inline alert, no change to draft or translations).
- [ ] Run `mise exec -- nsh test app/quick-translate.test.tsx --filter "quick ocr:"`. Expect the Baidu and existing AI cases to pass. If a case fails because the controller assumes AI OCR, use it as the red test and fix only that assumption.

## Failure behavior

The following messages are localized. Never pass a raw exception, URL, body, or `error_msg` to a user-facing message. In all cases other than a current `recognized` result, preserve the source and current translation results.

| Condition | Result |
| --- | --- |
| Missing or unreadable local credentials; selection changed before recognition | `unavailable`; ask the user to check Settings > OCR. No HTTP requests. |
| Invalid PNG, small or large dimensions, or encoded value over the limit | `failed`; ask the user to select a valid, larger, or smaller region as applicable. No token or OCR request. |
| Token rejection, HTTP 401/403, or OCR code `6`, `110`, or `111` | `failed`; ask the user to check the keys and selected API permissions. No retry. |
| HTTP 429 or OCR code `4` or `18` | `failed`; ask the user to try again later. |
| OCR code `17` or `19` | `failed`; ask the user to check Baidu quota. |
| HTTP 413 or OCR code `216202` | `failed`; ask the user to select a smaller area. |
| Other network/HTTP failures, provider errors, or malformed responses | `failed`; use a fixed service or response error. Do not import partial text. |
| Empty or all-blank OCR result | `no_text`; use the existing no-text message. |
| Deadline or caller cancellation | Reuse the timeout message for the deadline. Cancellation is silent. Ignore all stale completions. |

Use [Baidu's OCR error reference](https://cloud.baidu.com/doc/OCR/s/zkibizyhz) for code meanings. Do not treat code `18` as an exhausted daily quota or code `100` as a credential failure.

## Privacy and rollout

- The selected crop goes only to the active OCR service. Baidu receives no monitor snapshot, clipboard data, or translation preferences. Only recognized text enters the existing translation flow.
- Store the keys only as current-user DPAPI ciphertext. An unreadable protected record needs both keys again. Keep plaintext keys and the token only in memory while needed. Do not log either key, the token, the crop, or full request URLs. Use synthetic secrets in diagnostics and tests. Do not add credential import, export, or synchronization.
- Reuse the existing AI record shape and storage key without a migration. Leave AI active for existing AI bindings. A new installation has no saved service. Real use requires a Baidu Cloud application with access and quota for the selected OCR API; modes can have different permissions and quotas.

## Final validation

- [ ] Run `mise run verify`. Expect format, lint, Rust/TS checks, headless tests, and build to pass. Run `mise exec -- cargo test --lib baidu_credentials` on Windows and require the real protection tests to pass.
- [ ] Run `mise run dev` on Windows. At the minimum Settings size, inspect light and dark themes, English and Simplified Chinese, keyboard focus and operation, and reduced motion. Check masking, save and reopen with synthetic keys protected by real DPAPI, replace both keys, and switch to AI. Record results in `docs/ui/DESIGNE.md` without recording any key values.
- [ ] With an authorized Baidu application and nonsensitive screenshot text, exercise each mode on Windows. Confirm original-language lines in the editor and exactly one translation action after successful OCR. Check cancellation preserves the draft. If permissions or quota block any live case, record which mode was not verified. Headless HTTP fixtures do not prove live API acceptance.

**Open questions:** None that block implementation. The mode set, default, one-active-service behavior, and Windows scope above are proposed product decisions for review before coding.
