# Implementation Plan

**Goal:** Add a **DeepLX** preset that sends Quick Translate requests to a DLX server the user specifies.

**Inputs:** The request for a DeepLX API preset, [OwO-Network/DLX v1.3.1][dlx-release], and the current DeepL API and Google Web preset flows in Langnext.

**Assumptions:** Support the standard DLX `POST /translate` route and its optional server access token. Do not bundle or deploy DLX. Do not use a public default server, support DLX Pro or `/v2/translate` compatibility routes, or add a separate connection test. DeepL API remains a separate preset.

**Architecture:** The preset stores an endpoint URL and an optional reference to a separate token entry. Quick Translate resolves the language pair before it calls the DeepLX client. The client sends one buffered JSON request; the DLX server sends the text to DeepL and returns the translation.

**Tech Stack:** NSH 0.7.0, TypeScript and TSX, NSH Storage, `createJsonHttpClient`, `nsh/test`, and mise. No new runtime dependency or Rust code.

---

## API and Configuration Contract

| Item | Contract |
| --- | --- |
| Endpoint | A complete URL such as `http://localhost:1188/translate` or `https://translation.example.com/dlx/translate`. Require a path that ends in `/translate`; allow a mount prefix, but reject `/v1/translate` and `/v2/translate`, including under a prefix. Trim input and remove trailing path slashes before saving. Require HTTPS except for HTTP on `localhost`, `127.0.0.1`, or `[::1]`. Reject credentials in the URL authority, query strings, and fragments. Never follow redirects. |
| Access token | Optional. If the server has `TOKEN` configured, send its value as `Authorization: Bearer <token>`. Omit the header without a token. Do not use the query parameter, a DeepL API key, or a DeepL account session. The [DLX middleware][dlx-token] confirms the header contract. |
| Request | `POST`, `Content-Type: application/json`, with `{"text":"Good morning.","source_lang":"EN","target_lang":"ZH-HANS"}`. Send a single string, not an array. The [DLX handler][dlx-route] mirrors the input shape in its result. |
| Success | HTTP success with numeric `code: 200` and non-blank string `data`. Return `data` as-is. Ignore `id`, `method`, `alternatives`, and language metadata. Do not accept a batch response or treat HTTP 200 with an error object as success. |
| Input limit | [DLX v1.3.1][dlx-limit] enforces 1,500 UTF-16 code units on the anonymous route. Match that limit in the client (`text.length`), including spaces and newlines. Reject over-limit input before sending it. Do not split or truncate. |

DLX is a gateway, not a local model. Its anonymous route uses DeepL's undocumented OneShot client endpoint, not the official DeepL API. The server access token protects DLX; it does not increase the DeepL quota or select Pro. A compatible fork can work if it implements the same contract. Do not assume that all projects named DeepLX implement it.

## File Map

- Create `src/modules/deeplx/endpoint.ts` for endpoint normalization, `languages.ts` for DLX language codes, and `client.ts` and `client.test.ts` for the request and its tests.
- Modify `src/modules/ai/runtime/http.ts` to add an opt-in privacy setting for buffered JSON requests. Keep default behavior unchanged. Reuse `src/services/http.ts`; add no second fetch boundary.
- Modify `src/features/presets/types.ts`, `validation.ts`, and `store.ts` for the new engine and token lifecycle. Test saves, reads, and removal in `src/features/presets/store.test.ts`.
- Modify `src/features/quick-translate/translate.ts` for dispatch and `popup.tsx` for the existing DeepL glyph. Exercise the real dispatch in `src/features/quick-translate/popup.test.tsx`.
- Modify `src/features/presets/add-preset-dialog.tsx`, `draft.ts`, `editor.tsx`, `page.tsx`, `model-choices.ts`, and `preset-mark.tsx` for the picker, editor, summary, and mark. Test the app flow in `src/features/presets/presets.test.tsx`.
- Modify `locales/en.yml`, `locales/zh-CN.yml`, `.stitch/DESIGN.md`, `README.md`, and `docs/development.md`. Do not change `nsh.json`: it already grants network access to user-selected hosts.

## Seams

1. `createDeepLXClient({ fetchImpl }).translate(input, options)` — HTTP request, response, errors, and log privacy. Inject only at the HTTP boundary.
2. Quick Translate popup through its existing harness, with seeded NSH Storage and `open({ network })` — a saved preset uses ordinary card translation and back-translation.
3. `createPresetsStore(storage, readModelChoices)` — endpoint validation and the token lifecycle through save, load, read, and remove.
4. Presets through `open(APP_ENTRY, ...)` — create and edit DeepLX without a model, a DeepL API key, or a network test.

Confirm these seams before writing tests. Follow `/tdd`: add one behavior test, run the slice command to see the expected failure, make the minimum change, and rerun the same command. A type error or missing import is not a valid red result. Do not ship intermediate slices.

## Tasks

### 1. Call the DLX translation API

**Seam:** `createDeepLXClient().translate()`. **Files:** `src/modules/deeplx/{endpoint.ts,languages.ts,client.ts,client.test.ts}`, `src/modules/ai/runtime/http.ts`, and `locales/{en.yml,zh-CN.yml}`.

- [ ] **Red:** Translate `Good morning.` from `en` to `zh` using `http://localhost:1188/translate`, with no token. Assert one JSON POST with `source_lang: "EN"` and `target_lang: "ZH-HANS"`, no `Authorization` header, and the unchanged `data` string as the result.
- [ ] **Green:** Expose `translate({ endpointUrl, token, text, sourceLanguage, targetLanguage }, { signal, timeoutMs })`; `token` is `string | null` and languages are concrete `LanguageId`s. Reuse the [existing DeepL mapping][deepl-languages] for shared codes. Add `he → HE` and `vi → VI` on both sides, as accepted by the [DLX maps][dlx-languages]. Keep `ZH` as source, `ZH-HANS` as target, `EN-US` and `PT-BR` as targets, and `NB` for Norwegian. Reject unsupported app languages before sending. Do not change the global language menus.
- [ ] **Next cycles:** Use `normalizeDeepLXEndpoint(value): string | null` in `endpoint.ts`. Test the accepted URL cases above and rejection of a malformed URL, non-loopback HTTP, a query token, user info, and the Pro or v2 route. Test a server token in the header only, blank input, and the exact UTF-16 boundary, including a case with emoji. Reject a supplied token that is not a single visible ASCII value after trimming. Do not modify the source text.
- [ ] Test `401`, `403`, `429`, `413`, `5xx`, invalid JSON or `data`, timeout, and user cancellation during a body read. Reuse `createJsonHttpClient` and `ProviderProtocolError`. Pass `redirect: "error"`, `signal`, and `timeoutMs`. Add a buffered-client option `privatePayloads: true` for DeepLX: use `createHttpFetch` with `logBodies: false`, do not read an error body just to log it, and replace raw network details with the generic localized error before logging or returning them. Assert that a fixture that echoes the token or text in an error does not put either value into logs or the UI error.

**Red/green:** `mise exec -- nsh test src/modules/deeplx/client.test.ts --filter "DeepLX client:"`. Expect a request or result assertion to fail before each behavior change, then all cases to pass. Run `mise exec -- nsh test src/modules/ai/runtime/client.test.ts` for the unchanged default JSON transport.

### 2. Translate with a saved DeepLX preset

**Seam:** Quick Translate popup. **Files:** `src/features/quick-translate/{translate.ts,popup.tsx,popup.test.tsx}`, `src/features/presets/{types.ts,store.ts,model-choices.ts,preset-mark.tsx,page.tsx}`, `locales/{en.yml,zh-CN.yml}`, and `.stitch/DESIGN.md`.

- [ ] **Red:** Seed one card with `engine: { kind: "deeplx", endpointUrl: "http://localhost:1188/translate", credentialRef: null }`, no detector or model, and the explicit `en → zh` pair. Enter text and press Enter. Assert one request to that URL and the displayed translation. The current store skips this engine, so the card cannot run.
- [ ] **Green:** Add `DeepLXPresetEngine` to `PresetEngine` and validate its endpoint and nullable credential reference on load. Add the dispatcher branch before the AI path in `translateWithPreset`. Reuse the existing guards for disabled presets, blank input, and cancellation. Pass the resolved pair to the real client and return `{ ok: true, text, modelId: null, templateId: null }`. Do not stream or read usage.
- [ ] **Next cycle:** Seed an authenticated card and assert the request uses its token only. Add `readDeepLXToken(credentialRef)` to the store and read the reference from the same saved preset snapshot as the endpoint, not from a new lookup by preset ID. A null reference sends no token. If a non-null reference is missing or unreadable, show a localized credential error and send no request; assert zero requests in that case.
- [ ] Record the reused picker and card transitions in `.stitch/DESIGN.md` before TSX edits. Use `presets.engine.deeplx` (`DeepLX` in both locales) in the summaries and reuse the DeepL glyph, with labels that distinguish it from DeepL API. Test that no template picker appears. Add regression cases for automatic source resolution through the existing detector, reversed concrete languages on back-translation, and a `429` that fails only this card without an automatic retry or provider fallback.

**Red/green:** `mise exec -- nsh test src/features/quick-translate/popup.test.tsx --filter "DeepLX card:"`. The seeded card fails before wiring and renders the complete result after it. Cases for unchanged session behavior must pass without changes to the session or history rules.

### 3. Persist endpoint and optional token safely

**Seam:** Presets store. **Files:** `src/features/presets/{types.ts,validation.ts,store.ts,store.test.ts}` and `locales/{en.yml,zh-CN.yml}`.

- [ ] **Red:** Save a DeepLX preset with an empty model catalog. Reload it and verify its canonical URL. With no token, the only write is to `presets.v1.items` and `credentialRef` is null. The current save validator rejects the engine.
- [ ] **Green:** Add `SaveDeepLXPresetEngineInput` with `endpointUrl: string` and `token?: string | null`. Use the shared endpoint validator; enforce the existing name and engine type rules. Keep `presets.v1.items` at the current version. Save the token, if supplied, only in `presets.v1.deeplxTokens.<ref>`; the preset record stores the reference, not the token. Use the validation fields `deeplxEndpoint` and `deeplxToken` with localized errors. Preserve all existing engine records.
- [ ] **Next cycles:** At the same normalized URL, `undefined` keeps the stored token; `null` clears it; a non-empty valid string replaces it. At a changed URL, `undefined` or `null` clears the old token; only a newly supplied string can authorize the new endpoint. Verify that a normalized-equivalent URL keeps the token. Reject an empty string from the save API; the editor sends `undefined` for an untouched field.
- [ ] Reuse the existing secret-then-record write order. On replacement, write a new token entry first, save the preset record, then remove the old entry. On record-write failure, remove the new entry and leave the prior endpoint and token usable. On clear or delete, commit the record change before cleaning up the old entry. Add behavior tests for a failed record write, URL change, explicit clear, and deletion. No history, usage, or model writes.

**Red/green:** `mise exec -- nsh test src/features/presets/store.test.ts --filter "DeepLX preset:"`. Expect the new save to fail before validation is added, then verify token and record state after each operation.

### 4. Add the DeepLX picker option and editor

**Seam:** Presets screen. **Files:** `src/features/presets/{add-preset-dialog.tsx,draft.ts,editor.tsx,page.tsx,presets.test.tsx}`, `locales/{en.yml,zh-CN.yml}`, `.stitch/DESIGN.md`, `README.md`, and `docs/development.md`.

- [ ] **Red:** Add DeepLX from the empty Presets page using `id:preset-type-deeplx`. Verify `id:preset-deeplx-endpoint` and `id:preset-deeplx-token`, and that no model, prompt, or usage section appears. Save a name and URL with no token, reopen the app, and verify the fields and zero requests. The selector is not present before the change.
- [ ] **Green:** Use the existing two-column picker, editor fields, and Save/Cancel flow. Show **Endpoint URL** and masked **Access token (optional)**, plus the normal name and enabled controls. Use `http://localhost:1188/translate` as a localized placeholder, not a default value. On reopen show the saved-token state but never reveal the token. Use the existing focus and error handling; an invalid URL focuses its field. Saving does not contact the server.
- [ ] **Next cycles:** Add **Remove saved token**, visible only for a stored token. The action changes the draft; Save commits the removal and Cancel discards it. Typing a new token replaces rather than clears it. When the endpoint changes and a token exists, say that the existing token will be removed on save unless a new one is entered. Localize all labels, validation, and accessibility names. Add one disclosure: the configured server sends the text to DeepL.
- [ ] Before TSX edits, add the picker and editor states to the motion inventory in `.stitch/DESIGN.md`. Reuse existing focus, press, dialog, toast, and reduced-motion behavior. Document the endpoint, optional server token, input limit, and how the DeepLX preset differs from the official DeepL API preset.

**Red/green:** `mise exec -- nsh test src/features/presets/presets.test.tsx --filter "DeepLX"`. Expect no picker option before the edits, then a complete create, edit, clear, and reopen flow.

## Failure Behavior and Privacy

| Condition | Expected behavior |
| --- | --- |
| Invalid endpoint, blank text, unsupported language, limit exceeded, or unreadable configured token | Localized error and no request. Tell the user to correct the setting, shorten the text, or choose a compatible preset. |
| HTTP `401` | DLX denied access. Tell the user to check the server access token. |
| HTTP `403` or `429` | Report access denied or rate limited. Do not assume that a `403` is a bad token; it can come from DeepL. No automatic retry. |
| HTTP `413`, other `4xx`, or `5xx` | Report text too long, request rejected, or server unavailable, respectively. Do not surface remote error text. |
| Redirect, timeout, malformed response, network error, or cancellation | Use the existing localized error categories. Cancelled and stale results must not update a card. |

Add provider-specific `deeplx.error` keys to both locales. Do not log text, the token, authorization headers, or response bodies. The token uses separate NSH Storage, as existing preset secrets do; do not claim OS keychain protection. Send text only to the specified endpoint. The DLX operator and DeepL can process the text; avoid third-party endpoints for confidential text. The existing local history rules still apply to successful translations.

## Final Validation

- Run `mise run verify`. Expect formatting, lint, checks, headless tests, and the build to pass. Automated tests use fixtures and need no DLX server or account.
- Run `mise exec -- nsh test src/features/presets/presets.test.tsx --target windows --filter "DeepLX"`. Check the picker and editor in both locales, light and dark, at minimum window size. Verify keyboard order, accessible names, focus on validation, and reduced motion.
- On Windows x64, download `deeplx_windows_amd64.exe` from the [v1.3.1 release][dlx-release]. In a shell without a `TOKEN` override, run `./deeplx_windows_amd64.exe --ip 127.0.0.1 --port 1188`. Start the app with `mise run dev`, save the loopback endpoint, and translate short synthetic text in both `en → zh` and `zh → en`. Run one back-translation. Stop the local process, then run `TOKEN=dlx-local-smoke ./deeplx_windows_amd64.exe --ip 127.0.0.1 --port 1188` from a Bash shell. Verify that an omitted or wrong token gets `401` and the correct token succeeds. No remote deployment is necessary. Do not assert exact live wording. If DeepL returns `429` or is unavailable, verify the card error and record that live success was not verified.

**Open questions:** None for the initial scope. Confirm the test seams before implementation. Cloudflare Workers variants and other route contracts require separate verification before support is claimed.

[dlx-release]: https://github.com/OwO-Network/DLX/releases/tag/v1.3.1
[dlx-token]: https://github.com/OwO-Network/DLX/blob/v1.3.1/service/service.go#L31-L59
[dlx-route]: https://github.com/OwO-Network/DLX/blob/v1.3.1/service/service.go#L151-L208
[dlx-languages]: https://github.com/OwO-Network/DLX/blob/v1.3.1/translate/translate.go#L170-L245
[dlx-limit]: https://github.com/OwO-Network/DLX/blob/v1.3.1/translate/translate.go#L498-L518
[deepl-languages]: ../../src/modules/deepl/languages.ts
