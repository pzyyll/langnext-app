# Phase 2 Google Web Translation Integration Implementation Plan

**Goal:** Add a separate credential-free Google Web integration supporting GTX and an optional HTTPS translation proxy without mixing it with Google Cloud configuration.

**Inputs:** Completed Phase 1C and the roadmap README.

**Assumptions:**

- Plugin ID is `com.langnext.google-translate-web`.
- GTX uses the unofficial `translate.google.com/translate_a/single?client=gtx` endpoint and may stop working without notice.
- New Web integration instances default to `gtx`.
- When proxy mode is selected, its default endpoint is `https://googlet.deno.dev/translate`; users may provide another HTTPS endpoint implementing the same contract.
- No Cloud credential slot, token grant, or auth header is available to this integration.
- No automatic GTX↔proxy failover is implemented.

**Architecture:** The Web/free integration reuses the integration instance/Profile capability infrastructure but registers a separate manifest and zero-secret handlers. GTX uses a pinned origin. Proxy instances use a strictly validated HTTPS origin and show explicit third-party data-egress disclosure.

**Tech Stack:** Existing Rust registry/network broker/Profile execution plus typed React integration form.

---

## File Map

- Create: `src-tauri/src/services/google_translate_web.rs` — GTX/proxy handlers and parsers.
- Create: `src/features/plugins/GoogleTranslateWebIntegrationForm.tsx` — channel/proxy configuration and warning.
- Modify: `src-tauri/src/services/service_integration_registry.rs` — Web definition/capabilities/endpoints.
- Modify: `src-tauri/src/services/service_integrations.rs` — Web config validation/status.
- Modify: `src-tauri/src/services/network_broker.rs` — explicitly authorized user-configured HTTPS origin class.
- Modify: `src-tauri/src/services/service_capabilities.rs` — handler registration only.
- Modify: `src/features/plugins/AddIntegrationDialog.tsx`, `src/features/plugins/IntegrationEditor.tsx` — typed Web editor.
- Modify: frontend storage types only if Web config needs a tagged typed view.
- Modify: `src/features/translate/translationEngineOptions.ts` and tests — display ready Web instances.
- Modify: import/export validation for Web config (no format bump if v4 integration structure is generic enough).
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`.
- Test: Rust parser/security tests and frontend option/form tests.

## Tasks

### Task 1: Register the Google Web integration definition

**Outcome:** Users can create a zero-credential GTX/proxy integration instance.

**Files:**

- Modify: registry and integration service
- Modify: Add dialog/editor/i18n

**Steps:**

- [ ] Register `com.langnext.google-translate-web` with Translate/Detect capabilities and no credential slots.
- [ ] Define config schema version 1 with channel `gtx | https_proxy` and optional proxy URL.
- [ ] Default new instances to GTX and show a persistent unofficial-endpoint warning.
- [ ] Mark a valid/enabled zero-secret instance ready without credential validation.
- [ ] Add a typed editor that never displays Google Cloud project/location/service-account fields.
- [ ] Show persistent privacy/reliability disclosure for unofficial GTX and third-party proxy modes.
- [ ] Ensure Cloud and Web integration definitions remain separate in DTO/export.

**Validation:**

- Run: `mise run test service_integration_registry -- --nocapture`
- Run: `mise run typecheck`
- Expected: Web definition has zero slots and correct capabilities; UI types pass.

### Task 2: Implement GTX Translate/Detect

**Outcome:** A GTX instance can translate and detect through the pinned Google web endpoint.

**Files:**

- Create: `src-tauri/src/services/google_translate_web.rs`
- Modify: registry/capability dispatch
- Test: golden response fixtures

**Steps:**

- [ ] Define named constants for GTX origin/path/client and payload/response limits.
- [ ] Build GET query with `client=gtx`, source, target, encoding fields, `dt=t`, and text.
- [ ] Treat source `auto` explicitly and use the shared Google language-code mapping where compatible.
- [ ] Parse translated segments from the nested response and join them in response order.
- [ ] Parse detected language from the documented observed array position only after validating shape/length.
- [ ] Normalize detected variants into app language IDs.
- [ ] Map 429/network/timeout/invalid response to stable capability errors.
- [ ] Never send Cloud token grants or auth headers.
- [ ] Test multiline/Unicode/segment joins, malformed arrays, empty results, detected variants, cancellation, and limits.

**Validation:**

- Run: `mise run test google_translate_web_gtx -- --nocapture`
- Expected: parser/request/error/security tests pass without live network.

### Task 3: Add restricted HTTPS proxy mode

**Outcome:** Users can select a compatible proxy endpoint without creating an open credential-bearing HTTP primitive.

**Files:**

- Modify: Web service, integration validation, network broker, typed form
- Test: URL/policy tests

**Steps:**

- [ ] Default proxy URL to `https://googlet.deno.dev/translate` as a named constant.
- [ ] Require `https` scheme, non-empty host, no userinfo, no fragment, and no credential-like query parameters.
- [ ] Normalize and persist only the origin/path needed by the fixed contract.
- [ ] Build POST JSON `{ text, source_lang, target_lang }`.
- [ ] Parse bounded `{ data: string }` response.
- [ ] Register the validated origin as a capability-scoped endpoint for this instance only.
- [ ] Prohibit auth grants, Authorization headers, cookies, redirects, and Cloud credential access.
- [ ] Apply stricter request/response timeout and size limits suitable for text translation.
- [ ] DetectLanguage continues through pinned GTX; proxy mode does not invent a detect contract.
- [ ] Show the exact configured hostname in the data-egress warning.
- [ ] Test HTTP rejection, userinfo/fragment/query-secret rejection, redirect rejection, credential-header absence, malformed response, and instance isolation.

**Validation:**

- Run: `mise run test google_translate_web_proxy -- --nocapture`
- Expected: only safe HTTPS endpoints execute and no credential path is reachable.

### Task 4: Reuse plugin Profile discovery/runtime/import

**Outcome:** GTX/proxy instances appear as Profile choices and execute without schema-specific Profile changes.

**Files:**

- Modify: translation option tests, labels, import/export tests as required

**Steps:**

- [ ] Add ready Web instances to existing `translate.text@1` discovery.
- [ ] Use distinct labels for GTX and proxy instances.
- [ ] Reuse the Phase 1 plugin Profile engine and unary runtime.
- [ ] Store channel/proxy configuration at the integration instance, not in Profile credentials.
- [ ] Export/import sanitized Web instance config through v4 without a format bump if the generic v4 structure already covers it.
- [ ] Keep imported zero-secret GTX instances executable after validation; proxy instances remain subject to URL validation.
- [ ] Add tests proving Cloud and Web options do not share status/credential fields.

**Validation:**

- Run: `bun test src/features/translate/translationEngineOptions.test.ts`
- Run: `mise run test import_export -- --nocapture`
- Expected: discovery and structural round trips pass.

## Phase Validation

```bash
mise run format:check
mise run lint
mise run typecheck
mise run test-frontend
mise run test
mise run build
```

Manual:

```bash
mise run tauri:dev
```

Expected:

1. Create GTX and proxy instances without Cloud credentials.
2. Create Profiles from both and translate in main/Quick Translate.
3. GTX/proxy failures are isolated from Google Cloud instances.
4. UI clearly identifies unofficial/third-party data handling.
5. LLM and Cloud v3beta1 Profiles remain unchanged.

## Failure Behavior

- GTX format changes — `invalid_response`, no raw body shown.
- GTX/proxy rate limit — `rate_limited`, no implicit failover.
- Unsafe proxy URL — reject on save before execution.
- Proxy redirect — reject.
- Proxy unavailable — `provider_unavailable`/`network`; Profile remains configured.

## Privacy and Security

- Free integration has no credential slots and cannot request a token grant.
- Every custom proxy call is explicit third-party text egress.
- HTTPS is mandatory; no cookies/auth headers are accepted.
- Cloud private keys and access tokens cannot enter this execution path.

## Open Questions

None. The default is locked to GTX; proxy mode is an explicit user choice.
