# Implementation Plan

**Goal:** Add a **Google Web** translation preset that needs no API key, billing setup, or script deployment.

**Inputs:** The request for a free Google Translate preset, the current preset and Quick Translate paths, the existing free Google detector, and the [Apps Script draft](../drafts/google-translate%28GAS%29.md).

**Assumptions:** `Google Web` means a direct call to Google Translate's undocumented endpoint. It is an opt-in desktop preset, not a built-in saved preset or an automatic fallback. Free does not mean unlimited or supported. Do not add Apps Script or change Google Cloud Translation in this release.

**Architecture:** Share one form POST transport with the current free Google detector. Keep detection and translation response parsing separate. Quick Translate resolves the language pair as it does today, then sends one request per Google Web card and displays the complete result.

**Tech Stack:** NSH 0.7.0, TypeScript and TSX, NSH Storage, `createHttpFetch`, `nsh/test`, and mise. No new dependency or Rust code.

---

## Decision and Evidence

| Option | Cost and setup | Decision |
| --- | --- | --- |
| Direct Google Web | No key, account, or deployment for this request. Google does not publish a support or quota contract for the endpoint. | Use for the opt-in Demo preset. |
| Google Apps Script | `LanguageApp.translate()` is documented and does not need a Cloud Translation key. A Google account must deploy and manage a web app. The listed translation quota is 5,000 calls per day for consumer accounts and 20,000 for Workspace accounts. An anonymous deployment can use the owner's quota. Content Service also redirects its output. | Do not use for a no-setup preset. The draft's claims of unlimited stability and no rate limiting are not supported by the [quota table], [web app guide], or [Content Service guide]. |
| Google Cloud Translation Basic | The [pricing page] lists a shared monthly credit that covers the first 500,000 standard translation characters at the current rate. The existing preset needs a Cloud key, and use beyond the credit can incur charges. | Keep the existing preset as the supported API option. Do not route Google Web requests to it. |

The [free detector] already calls `https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=en` with form field `q`. On 2026-11-27, a read-only probe sent synthetic text to the same endpoint with explicit pairs. `en → zh-CN`, `zh-CN → en`, and `ja → en` each returned HTTP 200 with a JSON array containing one translated string. The first two results retained the line break. This proves the observed request shape, not future availability, translation wording, or a character limit. The [Google Terms of Service] prohibit bypassing protective measures or violating machine-readable restrictions. Review the applicable rules again before public distribution; a working response is not permission.

## File Map

- Create `src/modules/google-web-translation/transport.ts` for the shared POST, status handling, and request deadline; create `client.ts` and `client.test.ts` in the same folder for the public translation client and wire tests.
- Modify `src/integrations/detect/vendor/google-free.ts` to use the shared transport without changing its public API or failure codes. Keep its existing tests in `src/integrations/detect/channels/channels.test.ts` and `src/features/language-detection/detect.test.ts`.
- Modify `src/features/quick-translate/translate.ts` for dispatch and `popup.tsx` for the preset mark. Test the real dispatch path in `src/features/quick-translate/popup.test.tsx` through the existing popup harness.
- Modify `src/features/presets/types.ts`, `validation.ts`, and `store.ts` for the new preset kind. Test saves, loads, and storage in `src/features/presets/store.test.ts`.
- Modify `src/features/presets/add-preset-dialog.tsx`, `draft.ts`, `editor.tsx`, and `page.tsx` for creation and editing. Extend `model-choices.ts` and `preset-mark.tsx` in the same folder for the engine label and mark. Test the workflow in `src/features/presets/presets.test.tsx`.
- Modify `locales/en.yml`, `locales/zh-CN.yml`, `.stitch/DESIGN.md`, `README.md`, and `docs/development.md`. Reuse `assets/icons/google.svg`. Do not change `nsh.json`.

## Seams

1. `createGoogleWebTranslateClient({ fetchImpl }).translate(input, options)` — the POST, text output, and errors. Supply the test double only at the HTTP boundary.
2. Quick Translate popup with seeded `Storage` and `open({ network })` — a saved Google Web card uses the normal translation, retry, and back-translation paths.
3. `createPresetsStore(storage, readModelChoices)` — saving, loading, and removing a preset without credential or usage records.
4. Presets screen through `open(APP_ENTRY, ...)` — choose Google Web, save a name, and reopen the record with no provider setup.

Confirm these seams before writing tests. Follow `/tdd`: add one behavior test, run the task command and confirm the expected failure, implement the smallest change, then run the same command again. A missing import, type error, or fixture error is not a valid red result.

## Tasks

### 1. Establish the Google Web transport and client

**Seam:** Translation client. **Files:** `src/modules/google-web-translation/{transport.ts,client.ts,client.test.ts}`, `src/integrations/detect/vendor/google-free.ts`, `locales/{en.yml,zh-CN.yml}`, and both detector test suites from the file map.

- [ ] **Red:** Send an English fixture with `&`, `+`, and a line break to `zh`. Assert one HTTPS `POST` to `/translate_a/t?client=gtx&sl=en&tl=zh-CN`, content type `application/x-www-form-urlencoded`, and `q` as the only form field. Assert that the translated string from `["您好，欢迎。\n早上好！"]` returns as-is. The first failure must be a missing or wrong request or translation, not setup.
- [ ] **Green:** Define `GoogleWebTranslateInput` as `{ text: string; sourceLanguage: LanguageId; targetLanguage: LanguageId }` and options `{ signal?: AbortSignal; timeoutMs?: number }`. Map `zh` to `zh-CN` in either direction and use the other supported app IDs as-is; reject invalid IDs. Send the original text (do not trim it) as `q=${encodeURIComponent(text)}`. Accept only a one-element array with a non-blank string. Do not parse the detector's nested response as a translation.
- [ ] Use one transport function for the fixed host and path, the ordered `client`, `sl`, and `tl` parameters, the form body, and the deadline. Read JSON as `unknown`. The shared object-only JSON client in `src/modules/ai/runtime/http.ts` cannot send this form or accept the array response; reuse its `DEFAULT_HTTP_TIMEOUT_MS`, not its JSON decoder. Keep `createHttpFetch` as the only fetch boundary. Set `redirect: "error"` for translation; keep the detector's redirect behavior. For translation, disable body logging and do not forward raw response or exception text to logs or the UI. Log only sanitized error categories, method, host/path, and status.
- [ ] **Next cycles:** Assert no request for blank input, invalid language, or an already aborted call; preserve `zh-CN` in the source direction. Test `403`, `429`, `413`, `5xx`, non-JSON, and invalid arrays with the mappings below. Reuse one deadline across fetch and body read. Test caller abort and deadline expiry during body read; they must settle distinctly and not allow late success.
- [ ] Once the client passes, replace the detector's duplicate POST with the shared transport. Keep `GOOGLE_DETECTION_URL`, `sl=auto&tl=en`, its sample limit, parser, log scope, and public outcome codes. Map only caller abort to `cancelled`; map a timeout or other transport error to `failed`. A well-formed response without a usable language still follows the detector's existing unknown and unsupported rules.

**Red/green:** `mise exec -- nsh test src/modules/google-web-translation/client.test.ts --filter "Google Web client:"`. Expect failure on the new behavior before each change and all client cases to pass after it. For the detector regression, run `mise exec -- nsh test src/integrations/detect/channels/channels.test.ts` and `mise exec -- nsh test src/features/language-detection/detect.test.ts`; both must still pass.

### 2. Run a saved Google Web card in Quick Translate

**Seam:** Quick Translate popup. **Files:** `src/features/quick-translate/{popup.test.tsx,popup.tsx,translate.ts}`, `src/features/presets/{types.ts,store.ts,model-choices.ts,preset-mark.tsx,page.tsx}`, `locales/{en.yml,zh-CN.yml}`, and `.stitch/DESIGN.md`.

- [ ] **Red:** Seed one enabled preset with `engine: { kind: "google-web" }`, a card that selects it, and an explicit `en → zh` pair. Seed no credentials, AI models, or detector. Enter text in `id:quick-translate-source` and press Enter. Wait for the result and assert one form POST with the pair and no other requests. The current store skips the new kind, so the card cannot run.
- [ ] **Green:** Add `GoogleWebPresetEngine` with only `kind: "google-web"` to `PresetEngine`. Accept it when loading `presets.v1.items`. In `translateWithPreset`, keep the disabled, blank, and cancelled guards and add the new branch before AI-only logic. Pass the concrete pair, original text, `signal`, and `timeoutMs`. Return `{ ok: true, text, modelId: null, templateId: null }`. Do not call a credential reader, AI model, streaming callback, or usage store. Use the existing failure and cancellation result shapes.
- [ ] Use `presets.engine.googleWeb` (`Google Web` / `Google 网页翻译`) for the engine label and summary. Before TSX edits, record the reused card picker and result transitions in `.stitch/DESIGN.md`. Check that Google Web uses the Google mark in the card and preset picker and does not show a template picker. Reuse the existing preset mark rendering and preserve the AI, DeepL, and Cloud marks.
- [ ] Add regression coverage for a `429` next to a working DeepL card and for a manual retry that sends one new request. Verify that automatic source selection reuses the session's detection result, back-translation sends the reversed concrete pair, and a result that arrives after a source edit or popup close does not replace current state. Keep the existing session or history rules when these cases already pass.

**Red/green:** `mise exec -- nsh test src/features/quick-translate/popup.test.tsx --filter "Google Web card:"`. The seeded card must fail before the new engine is wired and pass after it. Regression cases for unchanged session behavior must pass.

### 3. Save and remove the preset without credentials

**Seam:** Presets store. **Files:** `src/features/presets/{types.ts,validation.ts,store.ts,store.test.ts}`.

- [ ] **Red:** With an empty model catalog, save a named, enabled Google Web preset, reload it from the same injected storage, and remove it. Assert that the only storage record touched is `presets.v1.items` and that its saved engine is exactly `{ kind: "google-web" }`. The current save validator rejects this engine.
- [ ] **Green:** Widen `SavePresetEngineInput` and `ValidatedPresetEngine`. Keep common name validation and the existing engine type lock. Save through the non-credential branch. Do not read model choices, create a credential reference, or touch usage storage for this kind. Use the existing rename, enable/disable, and delete paths. Keep the storage version and existing engine records unchanged.

**Red/green:** `mise exec -- nsh test src/features/presets/store.test.ts --filter "Google Web preset:"`. Expect save to fail before the validator change; save, reload, and removal must pass after it.

### 4. Expose Google Web in the preset picker and editor

**Seam:** Presets screen. **Files:** `src/features/presets/{add-preset-dialog.tsx,draft.ts,editor.tsx,page.tsx,presets.test.tsx}`, `locales/{en.yml,zh-CN.yml}`, `.stitch/DESIGN.md`, `README.md`, and `docs/development.md`.

- [ ] **Red:** From an empty Presets page, open Add preset and select `id:preset-type-google-web`. Enter a name at `id:preset-name` and save with `id:preset-save`. Check that no API key, model, prompt template, or usage section is present. Reopen and check the saved name and enabled switch. Opening, saving, and reopening do not send a request. The new selector is absent before the UI change.
- [ ] **Green:** Add one option to the current two-column picker using `Button` and the shared Google mark. In the editor, show only its common name and enabled controls. Make model and prompt controls AI-only, not merely non-credential. Make `draftToSaveInput` return the config-free engine. Keep the current name focus on selection, focus return on dismissal, and validation on Save. No new screen or motion. Record reuse of dialog, button, and card state transitions under the Google presets motion inventory in `.stitch/DESIGN.md` before TSX edits.
- [ ] Localize the label, error messages, accessibility names, and one disclosure in both locale files. Show `presets.googleWeb.disclosure` in the editor before Save: “Sends text to Google's undocumented translation service.” / “文本将发送到 Google 未公开的翻译接口。” Do not add setup instructions to the picker. Document the choice and limits in `README.md` and the request shape in `docs/development.md`.

**Red/green:** `mise exec -- nsh test src/features/presets/presets.test.tsx --filter "Google Web"`. Expect the picker assertion to fail before the UI change and the full workflow to pass after it.

## Failure Behavior

| Condition | Result |
| --- | --- |
| Blank input, invalid language, or disabled preset | Do not send a request. Use the existing localized guard or a Google Web unsupported-language error. |
| Caller abort or timeout | Return `cancelled` on caller abort and `timeout` on deadline expiry. Do not show a cancelled or stale result. |
| HTTP `403` / `429` | Treat `403` as access denied, not a missing key. Treat `429` as rate limited. Tell the user to choose another preset or retry later, as appropriate. |
| HTTP `413` / other `4xx` | Report input too long for `413`. For other `4xx`, report that Google rejected the request. Do not claim a fixed provider character limit without evidence, or split/truncate the text. |
| Network error, `5xx`, redirect, HTML, or invalid JSON shape | Map to a localized network, server, or unreadable-response error. Never display the raw response. Fail only the current card. |

Use `ProviderProtocolError` categories and these keys under `googleWeb.error` in both locales: `unsupportedLanguage`, `accessDenied`, `rateLimited`, `tooLarge`, `rejected`, `server`, and `invalidResponse`. Reuse the existing protocol strings for blank text, cancel, timeout, and generic network failure. Do not add automatic retries, endpoint rotation, or fallback to another provider.

## Privacy and Rollout

- Send source text only in the HTTPS form body. Do not send Google cookies or credentials, follow redirects for translation, or include text in route parameters or logs. Successful translations stay subject to the app's existing local history settings.
- The preset appears only when the user adds it. Remote availability and response format can change without notice. If a release check shows a block or incompatible contract, stop rollout; do not work around the block. Google Cloud remains a separate, explicitly selected preset.

## Final Validation

- Run `mise run verify`. Expect formatting, lint, Rust and TypeScript checks, headless tests, and the desktop build to pass. Automated tests use fixtures, not the live service.
- Run `mise exec -- nsh test src/features/presets/presets.test.tsx --target windows --filter "Google Web"`. Check the picker and editor in light and dark, in both locales. Check keyboard focus, accessible names, and reduced motion with the existing controls. Confirm that the two Google presets remain distinct and fit their labels.
- Use `mise run dev` for a Windows smoke check. Add the preset with no Cloud key, translate short synthetic text with newlines in both `en → zh` and `zh → en`, and run one back-translation. Check for a whole result, correct wire language codes, a usable card error if the service is unavailable, and no source or result text in `logs/app.log`. Do not assert exact live wording or run a load test.

**Open questions:** No product decision is required to draft this plan. Before implementation, confirm the test seams. Before public release, confirm the endpoint's acceptability and run the live check again.

[free detector]: ../../src/integrations/detect/vendor/google-free.ts
[quota table]: https://developers.google.com/apps-script/guides/services/quotas#current_quotas
[web app guide]: https://developers.google.com/apps-script/guides/web#permissions
[Content Service guide]: https://developers.google.com/apps-script/guides/content#redirects
[pricing page]: https://cloud.google.com/translate/pricing
[Google Terms of Service]: https://policies.google.com/terms?hl=en-US
