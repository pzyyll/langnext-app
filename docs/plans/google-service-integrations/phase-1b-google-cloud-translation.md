# Phase 1B Google Cloud Translation Capability Implementation Plan

**Goal:** Add host-owned Google service-account OAuth, endpoint-authorized network execution, and typed Cloud Translation v3beta1 Translate/Detect capabilities.

**Inputs:** Completed Phase 1A and `docs/analysis/google-cloud-plugin-architecture.md`.

**Assumptions:**

- Official API version is `v3beta1` only.
- Default location is `global`.
- Google Cloud official endpoint origins are fixed by the bundled manifest.
- Phase 1B exposes backend capabilities and remote credential validation; Profile/UI execution lands in Phase 1C.
- Live Google credentials are not required for normal automated tests.

**Architecture:** Capability handlers request an opaque `TokenGrant`; only the trusted Google auth driver can load service-account JSON, sign JWT assertions, and exchange them at the pinned OAuth endpoint. A network broker resolves manifest endpoint aliases, injects the cached bearer token, enforces limits/cancellation, and returns bounded raw responses to typed handlers.

**Tech Stack:** Rust, reqwest, JWT RS256 implementation selected from current maintained docs, Tauri cancellation/session infrastructure.

---

## File Map

- Create: `src-tauri/src/domain/service_capability.rs` — typed requests/results/errors and handler contracts.
- Create: `src-tauri/src/services/token_grant.rs` — grant authorization and expiring token cache.
- Create: `src-tauri/src/services/network_broker.rs` — endpoint alias transport.
- Create: `src-tauri/src/services/google_service_account.rs` — SA validation/JWT/token exchange.
- Create: `src-tauri/src/services/google_cloud.rs` — Translate/Detect request builders/parsers.
- Create: `src-tauri/src/services/service_capabilities.rs` — typed capability lookup/dispatch.
- Modify: `src-tauri/src/services/service_integration_registry.rs` — executable Google handlers/endpoint grants.
- Modify: `src-tauri/src/services/provider_http.rs` — share bounded raw HTTP execution without changing its public wire contract.
- Modify: `src-tauri/src/domain/cancel.rs` / request-session use only if required for broker integration.
- Modify: `src-tauri/src/services/service_integrations.rs` — remote validation and token-cache eviction.
- Modify: `src-tauri/src/cmds/service_integrations.rs` — remote validation result.
- Modify: `src-tauri/src/state.rs`, module exports, `src-tauri/src/error.rs`.
- Modify: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` — maintained JWT/async-trait dependencies if required.
- Test: inline module tests and service tests using fake vault/token/network transports.

## Tasks

### Task 0: Lock current OAuth/JWT documentation

**Outcome:** Implementation uses a verified, maintained JWT API and an exact least-privilege scope supported by v3beta1 Translate/Detect.

**Files:**

- Modify: this plan with a short “Resolved implementation dependencies” record before coding Task 4
- Modify: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` only after the decision

**Steps:**

- [x] Retrieve current Google Cloud Translation v3beta1 authentication/scope documentation.
- [x] Retrieve current documentation for the selected maintained Rust JWT crate.
- [x] Record the exact crate/version/API and exact scope string used by Translate/Detect.
- [x] Reject `cloud-platform` unless current official docs prove no narrower supported scope exists.
- [x] Confirm required JWT claims, token endpoint, maximum assertion lifetime, and key format.
- [x] Treat unresolved scope/crate/API as a hard blocker for Tasks 4–7.

#### Resolved implementation dependencies

| Item                   | Decision                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| OAuth scope            | `https://www.googleapis.com/auth/cloud-translation` (narrower than `cloud-platform`; accepted by official v3beta1 Translate/Detect) |
| Token endpoint         | `https://oauth2.googleapis.com/token` (pinned; SA JSON `token_uri` must match)                                                      |
| JWT crate              | `jsonwebtoken` **10.4.0** with feature `rust_crypto` (default includes `use_pem`)                                                   |
| JWT API                | `encode(&Header::new(Algorithm::RS256), &claims, &EncodingKey::from_rsa_pem(pem)?)`                                                 |
| JWT claims             | `iss` (client_email), `scope` (space-delimited), `aud` = token URI, `iat`, `exp`                                                    |
| Max assertion lifetime | 1 hour (`exp - iat ≤ 3600`)                                                                                                         |
| Key format             | PEM RSA private key (PKCS#8) from SA JSON `private_key`                                                                             |
| Token grant form       | `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` + `assertion=<jwt>`                                                        |
| API version            | `v3beta1` only; default location `global`                                                                                           |
| Endpoint origin        | Manifest-pinned `https://translation.googleapis.com` (alias `translate`)                                                            |

Sources: Cloud Translation v3beta1 REST Translate/Detect docs; Google OAuth service-account guide; jsonwebtoken 10.4.0 crate docs.

**Validation:**

- Run: documentation review with authoritative links recorded in this plan or implementation notes.
- Expected: no authentication dependency remains ambiguous.

### Task 1: Define typed capability contracts and errors

**Outcome:** Bundled service integrations implement explicit Translate/Detect contracts without extending chat-shaped frontend plugin types.

**Files:**

- Create: `src-tauri/src/domain/service_capability.rs`
- Create: `src-tauri/src/services/service_capabilities.rs`
- Modify: registry and module exports

**Steps:**

- [x] Define bounded `TranslateTextRequest`/`TranslateTextResponse` with text, app source/target IDs, translated text, and optional detected source.
- [x] Define bounded `DetectLanguageRequest`/`DetectLanguageResponse`.
- [x] Define `ExecutionContext` carrying request ID, deadline/cancel token, and integration/capability identity (broker handles remain on services).
- [x] Define typed `TranslateTextCapability` and `DetectLanguageCapability` contracts; use project-consistent boxed futures or a maintained async-trait dependency.
- [x] Store handlers in a tagged `CapabilityHandler` enum rather than generic `execute(name, JSON)`.
- [x] Define `CapabilityError` with stable code, safe message, retryable flag, bounded provider code, capability ID, and request ID.
- [x] Reject request IDs, text, language IDs, or response fields above named limits.
- [x] Add registry lookup that verifies the instance plugin ID, capability major version, enabled/status state, and handler type.

**Validation:**

- Run: `mise run test service_capability -- --nocapture`
- Expected: type mismatch, missing plugin/capability, disabled instance, and bounded-field tests fail closed.

### Task 2: Extract a shared bounded HTTP executor

**Outcome:** Provider HTTP and service integrations share cancellation/limits/redirect safety without sharing provider-specific auth semantics.

**Files:**

- Create: `src-tauri/src/services/bounded_http.rs` (preferred extraction target)
- Modify: `src-tauri/src/services/provider_http.rs`
- Modify: module exports/tests

**Steps:**

- [x] Run and record the full existing `provider_http` suite before extraction.
- [x] Extract reqwest client construction, redirect disablement, proxy selection, request timeout, streaming connect/idle timeout, response size limits, and cancellation wrappers into a private host transport module.
- [x] Keep extraction mechanical: move existing behavior before adding broker-specific policy; do not retune Provider limits.
- [x] Preserve existing named Provider HTTP limits and behavior.
- [x] Keep `ProviderHttpService.prepare` responsible for provider-instance URL/auth validation.
- [x] Keep service integration endpoint/auth validation outside the raw executor.
- [x] Preserve existing `RawHttpTransport` injection or add an equivalent fake executor interface for both callers.
- [x] Do not change `ProviderHttpRequest`, `ProviderWireRequest`, frontend IPC command names, or TypeScript provider wire contracts.
- [x] Run the full Provider HTTP suite again after extraction and require identical passing behavior before starting Task 3.

**Validation:**

- Run: `mise run test provider_http -- --nocapture`
- Expected: all existing provider transport/auth/security/stream tests pass unchanged.

### Task 3: Implement the network broker

**Outcome:** A capability can call only manifest-approved endpoint aliases with bounded relative requests.

**Files:**

- Create: `src-tauri/src/services/network_broker.rs`
- Modify: registry/state/error mappings
- Test: inline broker tests

**Steps:**

- [x] Define a broker request using integration instance ID, capability ID, endpoint alias, method, relative path, query, headers, body, auth grant handle, and request ID.
- [x] Resolve endpoint aliases from the registered manifest; never accept caller origins for Google Cloud.
- [x] Verify capability→endpoint permission before config/credential access.
- [x] Reuse relative-path, blocked-header/query, redirect, timeout, proxy, cancellation, and response-size safeguards.
- [x] Block caller-provided Authorization, cookies, proxy auth, host, content length, API-key-shaped query/header names, and manifest auth names.
- [x] Apply per-capability named request/response limits.
- [x] Attach auth only through an opaque host grant.
- [x] Produce sanitized debug spans containing origin, header names, sizes, IDs, and result code—not body/query values.
- [x] Add tests for unknown aliases, cross-capability alias use, absolute URLs, path traversal, sensitive headers, cancellation, and response overflow (redirect disablement covered by shared transport; no dedicated broker timeout unit test).

**Validation:**

- Run: `mise run test network_broker -- --nocapture`
- Expected: approved relative requests pass through fake transport; every policy violation fails before network execution.

### Task 4: Implement host-owned Google service-account token grants

**Outcome:** Google capability handlers can obtain authenticated host requests without receiving the service-account JSON or access token.

**Files:**

- Create: `src-tauri/src/services/token_grant.rs`
- Create: `src-tauri/src/services/google_service_account.rs`
- Modify: Cargo files, instance service/state
- Test: fake clock/vault/token endpoint tests

**Steps:**

- [x] Before adding dependencies, retrieve current documentation for the selected JWT crate and use a current non-deprecated API/version.
- [x] Define `TokenGrantRequest` with instance ID, capability ID, trusted auth-driver ID, normalized scope set, and audience policy ID.
- [x] Prevent capability handlers from supplying raw token URLs or arbitrary audiences.
- [x] Load `service-account-json` only inside the trusted Google auth driver.
- [x] Parse bounded JSON and require `client_email`, `private_key`, and pinned `token_uri`.
- [x] Create an RS256 JWT assertion with bounded lifetime and Google-required claims.
- [x] Exchange only at `https://oauth2.googleapis.com/token` through the network host; classify safe OAuth errors.
- [x] Cache tokens by instance ID + credential revision + normalized scope set with an expiry safety skew; generation guard blocks stale in-flight re-insert after eviction.
- [x] Evict all instance grants after credential replace/clear/instance disable/delete.
- [x] Derive allowed scope sets from the registered capability. Translation uses the narrowest documented scope supported by v3beta1; do not silently escalate to broad `cloud-platform`.
- [x] Ensure debug/error output cannot include JWTs, private keys, service-account JSON, or tokens.
- [x] Test cache hit, expiry, revision invalidation, concurrent replace, scope allow-list, malformed key, pinned URI enforcement, OAuth 401/403, and cancellation.

**Validation:**

- Run: `mise run test token_grant -- --nocapture`
- Run: `mise run test google_service_account -- --nocapture`
- Expected: token lifecycle/security tests pass without external network access.

### Task 5: Implement Google language mapping and v3beta1 Translate

**Outcome:** The Google Cloud handler translates supported application language IDs through the pinned v3beta1 endpoint.

**Files:**

- Create/modify: `src-tauri/src/services/google_cloud.rs`
- Modify: capability registry
- Test: golden request/response/error fixtures as Rust constants

**Steps:**

- [x] Define named constants for API version, endpoint alias, default location, MIME type, payload limits, and capability IDs.
- [x] Implement a single Rust app-language↔Google-code mapping shared by Translate and Detect.
- [x] Validate project/location as bounded path segments; reject separators, traversal, whitespace, and empty values.
- [x] Build `POST v3beta1/projects/{project}/locations/{location}:translateText` with `contents`, `mimeType = text/plain`, optional source code, and required target code.
- [x] Omit source code for auto detection.
- [x] Parse only bounded `translations[0].translatedText` and optional detected-language fields.
- [x] Map 401/403/429/quota/network/timeout/invalid payload to stable capability errors (auth vs permission vs quota via Google status/reason).
- [x] Do not return raw Google error bodies.
- [x] Test Unicode, multiline text, auto source, unsupported language, missing/empty translations, HTML-looking content treated as plain text, bounded limits, and grant→broker path.

**Validation:**

- Run: `mise run test google_cloud_translate -- --nocapture`
- Expected: request/response/error mapping tests pass against fake broker fixtures.

### Task 6: Implement v3beta1 DetectLanguage

**Outcome:** Google Cloud integration can detect supported source languages through a typed capability.

**Files:**

- Modify: `src-tauri/src/services/google_cloud.rs`
- Modify: capability registry
- Test: detect fixtures

**Steps:**

- [x] Build `POST v3beta1/projects/{project}/locations/{location}:detectLanguage` with `content` and `mimeType = text/plain`.
- [x] Select the highest-confidence supported language from the ordered response.
- [x] Normalize Google variants (including Chinese variants) through the shared mapping.
- [x] Return `unsupported_language` if Google detects only languages outside the app contract.
- [x] Bound content and response list sizes.
- [x] Test supported/unsupported variants, empty responses, malformed confidence, errors, and grant→broker path.

**Validation:**

- Run: `mise run test google_cloud_detect -- --nocapture`
- Expected: detection normalization and failures pass.

### Task 7: Upgrade remote instance validation

**Outcome:** `/plugins` can validate OAuth token acquisition without sending user translation content.

**Files:**

- Modify: `src-tauri/src/services/service_integrations.rs`
- Modify: `src-tauri/src/cmds/service_integrations.rs`
- Modify: frontend validation result types/copy

**Steps:**

- [x] Change validation from local-only to local config validation + token grant acquisition.
- [x] Keep authentication health separate from capability health; token success must not imply Translate/Vision IAM access.
- [x] Persist only safe status, timestamp, and normalized error code.
- [x] Set `ready` after successful token validation, `unconfigured` for missing required config/credential, and `degraded` for remote failure.
- [x] Add a bounded validation timeout; timeout branch explicitly cancels the in-flight grant (no unused request-id wiring).
- [x] Use `tokio::select! { biased; ... }` with the acquire branch first so simultaneous ready prefers the real grant result.
- [x] Before health write, re-read current `updated_at` and retry CAS a few times so concurrent display_name/enable saves cannot false-fail validation or overwrite config.
- [x] Snapshot required credential ref/revision before remote acquire; after the grant, re-read bindings and discard the remote health when credentials were replaced/cleared mid-flight (keep Unconfigured / write Unvalidated + re-run message — never stamp Ready from a stale secret).
- [x] Ensure validation sends no user text and no capability API request.
- [x] Update frontend copy to distinguish “Credentials validated” from “Translation permission verified.”; degraded shows an auth-failed/unconfirmed hint (not the local-only hint). Toast uses success/warning/error from `healthStatus`/`remoteChecked`.

**Validation:**

- Run: `mise run test service_integration_validation -- --nocapture`
- Run: `mise run typecheck`
- Expected: status transitions and copy/types compile; no secret/provider body is persisted.

## Phase Validation

Run:

```bash
mise run format:check
mise run lint
mise run typecheck
mise run test-frontend
mise run test
mise run build
```

Expected: all validation passes, including unchanged Provider plugin/transport tests.

Manual (with an explicitly supplied test service account):

```bash
mise run tauri:dev
```

Expected:

1. Valid credentials acquire a token and show authentication-ready status.
2. Invalid credentials show a safe `auth` error.
3. No translation request is yet exposed in Profile UI.
4. Logs do not contain service-account fields, JWTs, tokens, or Google raw bodies.

## Failure Behavior

- Missing project/location/credential — `invalid_configuration` / unconfigured status.
- Invalid private key/JWT — `auth`, no network retry loop.
- OAuth 429/5xx — bounded retryability metadata; no implicit unlimited retry.
- Unknown endpoint/capability — `permission_denied` or `plugin_unavailable` before network.
- Cancellation/deadline — abort token exchange and provider call, return `cancelled`/`timeout`.

## Privacy and Security

- Only the trusted Google auth driver reads service-account JSON.
- Capability handlers do not receive raw secrets or tokens.
- Official endpoint origins and OAuth endpoint are pinned.
- Provider HTTP behavior remains backward compatible.

## Open Questions

None after Task 0. Task 0 is a mandatory implementation gate, not optional research.
