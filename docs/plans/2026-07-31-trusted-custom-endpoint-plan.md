# Trusted Custom Endpoint Approval Implementation Plan

**Goal:** Require one explicit user acknowledgement before an Edge TTS custom `base-url` can execute, then allow that exact HTTPS domain origin through system DNS/proxy without filtering its resolved address class.

**Inputs:** User-reported Edge TTS fake-IP failure; `docs/plans/runtime-plugin-system/phase-6-binary-resources-edge-tts.md`; current `IntegrationEditor`, runtime-grant, Bundled Rust broker, and Wasm broker implementations.

**Assumptions:**

- The official `https://tts.wangwangit.com` origin remains host-trusted and needs no prompt.
- Any non-default Edge TTS `base-url` is blocked until the user reviews and acknowledges its exact normalized origin.
- After acknowledgement, the host accepts every DNS result for that exact approved domain origin, including public, fake-IP, reserved, and private address results. This is an intentional user-authorized SSRF protection override.
- The override applies to DNS names only. Raw-IP and localhost URL literals remain rejected; HTTPS, certificate/hostname validation, redirect blocking, endpoint alias, method, path, headers, byte limits, and timeouts remain enforced.
- Origin, endpoint scope, configuration fingerprint, plugin version/package digest, runtime upgrade, downgrade, and rollback invalidate approval. A fresh confirmation is required.
- Scope starts with Edge TTS but the host approval model is reusable for future instance-configured endpoints.

**Architecture:** Saving a custom Base URL first obtains a short-lived host preview that contains only its normalized origin and fixed speech egress scope. After the user acknowledges it, the existing integration save transaction verifies the opaque preview, persists an exact-origin approval, and seals `user-approved-instance` provenance into any active Wasm execution grant. The native `NetworkBroker` and Wasm `NetworkBrokerHandle` call one shared classifier: vendor default uses `TrustedFixed`; a matching explicit approval uses `UserApprovedCustom`; every other custom origin is blocked as requiring review.

**Tech Stack:** Rust/Tauri commands, SQLite migrations and repositories, execution grants/authority digest, reqwest transport policies, React 19, TanStack Query, Base UI, Tailwind v4, Bun, Cargo.

---

## Scope

### In scope

- Exact-origin, explicit custom endpoint approval for Edge TTS `base-url`.
- Preview → acknowledgement → Save interaction in the plugin instance editor.
- Approval persistence, automatic invalidation, grant sealing, and policy parity between Bundled Rust and Wasm.
- System DNS/proxy compatibility after approval, including fake-IP DNS answers.
- Clear status and localized risk copy in the integration editor.

### Out of scope

- Raw-IP or localhost URL literals.
- A separate local-network endpoint feature.
- HTTP, disabled TLS verification, redirects, arbitrary methods/paths/headers, or relaxed body/timeout limits.
- Speech playback changes; the existing binary IPC/playback contract remains unchanged.

## File Map

- Create: `src-tauri/migrations/0021_integration_endpoint_trusts.sql` — persist exact user-approved endpoint records.
- Create: `src-tauri/src/domain/endpoint_trust.rs` — approval binding, preview DTO/input, configuration fingerprint, and named TTL constants.
- Create: `src-tauri/src/repositories/integration_endpoint_trusts.rs` — SQLite approval reads/writes/revocation.
- Create: `src-tauri/src/services/endpoint_trust.rs` — preview session lifecycle, candidate validation, and shared egress-policy classifier.
- Create: `src/features/plugins/endpointTrustPresentation.ts` — pure status, save, and acknowledgement decisions.
- Create: `src/features/plugins/endpointTrustPresentation.test.ts` — Bun coverage for the pure frontend seam.
- Create: `src/features/plugins/EndpointTrustDialog.tsx` — acknowledgement-gated custom endpoint dialog.
- Modify: `src-tauri/src/domain/mod.rs` — export endpoint-trust types.
- Modify: `src-tauri/src/domain/runtime_plugin.rs` — add `user-approved-instance` network-origin provenance.
- Modify: `src-tauri/src/domain/runtime_lifecycle.rs` — carry new provenance through grant records/exports where required.
- Modify: `src-tauri/src/repositories/mod.rs`, `src-tauri/src/repositories/tests.rs`, `src-tauri/src/storage/migrations.rs` — register/persist/test migration 0021.
- Modify: `src-tauri/src/error.rs` — expose safe endpoint-review/stale-preview IPC failures.
- Modify: `src-tauri/src/services/service_integrations.rs`, `src-tauri/src/state.rs` — issue/consume preview and atomically save/revoke approval.
- Modify: `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/runtime_router.rs` — seal/revalidate approved provenance in Wasm grants.
- Modify: `src-tauri/src/services/bounded_http.rs` — add `UserApprovedCustom` transport policy using OS DNS and the configured proxy mode without address-class filtering.
- Modify: `src-tauri/src/services/network_broker.rs`, `src-tauri/src/services/wasm_runtime/network_handle.rs` — use one shared classifier in both execution paths.
- Modify: `src-tauri/src/cmds/service_integrations.rs`, `src-tauri/src/lib.rs` — expose preview IPC and register the command.
- Modify: `src/storage/types.ts`, `src/storage/client.ts` — add preview DTO/input and opaque approval fields to integration save.
- Modify: `src/features/plugins/IntegrationEditor.tsx`, `src/components/ConfirmDialog.tsx` — show status and preview/acknowledgement save flow.
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts` — trust warning, status, and stale-review copy.
- Modify: `src-tauri/src/services/network_broker.rs`, `src-tauri/src/services/wasm_runtime/network_handle.rs`, `src-tauri/src/services/edge_tts_runtime_tests.rs`, `src-tauri/src/services/runtime_lifecycle_preference_tests.rs`, `.mise/tasks/plugin/conformance` — execution-path and lifecycle conformance coverage.

All new code files must start with the repository-required two `ABOUTME:` lines.

## Seams

Confirm these seams before implementation begins; tests must exercise these public boundaries rather than private caches, rows, or task handles.

- **Seam:** `EndpointTrustService::preview` — a custom Edge TTS candidate produces a sanitized expiring preview and never persists trust itself.
- **Seam:** `ServiceIntegrationService::save` — only a matching acknowledged opaque preview can atomically save custom configuration and approval.
- **Seam:** `NetworkBroker::execute_bytes` and `BrokerHandle::fetch` — both production paths choose the same official/approved/review-required egress policy.
- **Seam:** `RuntimeLifecycleService::preview_upgrade` / `apply_upgrade` — package-backed grants retain user-approved provenance only while the exact approval remains current.
- **Seam:** `endpointTrustPresentation` — the UI never auto-acknowledges or submits a preview after the candidate changes.

## Tasks

### Task 1: Add an exact-origin trust preview model

**Seam:** `EndpointTrustService::preview`

**Outcome:** The host can normalize a custom Edge TTS Base URL and create an expiring, sanitized review preview without mutating configuration, grants, or approval state.

**Files:**

- Create: `src-tauri/migrations/0021_integration_endpoint_trusts.sql`
- Create: `src-tauri/src/domain/endpoint_trust.rs`
- Create: `src-tauri/src/repositories/integration_endpoint_trusts.rs`
- Create: `src-tauri/src/services/endpoint_trust.rs`
- Modify: `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/storage/migrations.rs`, `src-tauri/src/repositories/tests.rs`
- Test: inline tests in `src-tauri/src/services/endpoint_trust.rs` and `src-tauri/src/repositories/tests.rs`

**Steps:**

- [ ] **Red:** Add tests for official default, custom HTTPS domain, HTTP URL, localhost/raw-IP literal, stale instance revision, and expired preview. Assert preview creation writes no approval row.
- [ ] **Green:** Introduce `EndpointTrustPreviewInput`, `EndpointTrustPreviewDto`, `IntegrationEndpointTrust`, a canonical non-secret configuration fingerprint, and `ENDPOINT_TRUST_PREVIEW_TTL_SECS`.
- [ ] Add migration 0021 with a unique approval binding over integration instance, plugin identity, endpoint alias, normalized origin, configuration fingerprint, runtime identity fingerprint, and approval timestamp. Do not store credentials, speech text, DNS answers, or provider data.
- [ ] Implement a short-lived in-memory preview session containing only normalized candidate metadata, current CAS revision, fixed Edge TTS `POST v1/audio/speech` scope, and expiry.
- [ ] Reject untrusted URL shapes before preview: non-HTTPS, userinfo, raw IP, localhost, fragment, or a domain/origin that fails the existing canonical Base URL validation.
- [ ] Return the precise custom origin and data-egress scope needed by the dialog; do not expose SSRF terminology or resolved IP addresses to the UI.

**Validation:**

- Run (red): `mise run test endpoint_trust -- --nocapture`
- Expected: new preview tests fail because the endpoint-trust service and persistence do not exist.
- Run (green): `mise run test endpoint_trust -- --nocapture`
- Expected: official/custom/invalid/expired cases pass and preview remains non-mutating.

### Task 2: Consume acknowledgement atomically during integration save

**Seam:** `ServiceIntegrationService::save`

**Outcome:** A custom Base URL is saved only after an acknowledged host preview exactly matches the current candidate; normal/default saves revoke obsolete approval.

**Files:**

- Modify: `src-tauri/src/domain/service_integration.rs`, `src-tauri/src/error.rs`
- Modify: `src-tauri/src/services/service_integrations.rs`, `src-tauri/src/state.rs`
- Modify: `src-tauri/src/cmds/service_integrations.rs`, `src-tauri/src/lib.rs`
- Modify: `src/storage/types.ts`, `src/storage/client.ts`
- Test: inline tests in `src-tauri/src/services/service_integrations.rs` and `src-tauri/src/error.rs`

**Steps:**

- [ ] **Red:** Add create/update tests through `ServiceIntegrationService::save`: acknowledged matching preview persists approval; missing acknowledgement, mismatched origin/configuration, expired preview, stale `expected_updated_at`, and another instance’s preview all fail without changing config or approval.
- [ ] **Green:** Add optional opaque `endpointTrustPreviewId` and `acknowledgeEndpointTrust` to `IntegrationInstanceWrite`. Do not accept frontend-supplied origin, policy, or “trusted” boolean.
- [ ] Add `preview_integration_endpoint_trust` IPC. It receives plugin/optional instance identity, non-secret candidate config, expected revision, and re-normalizes everything on the host.
- [ ] During save, consume the preview in the existing database transaction after schema/credential preflight. Verify plugin, instance, revision, endpoint alias, origin, configuration fingerprint, runtime identity, acknowledgement, and expiry.
- [ ] For a default official Base URL, save normally and revoke any custom approval. For a custom Base URL with no exact approved preview, return stable `endpoint_trust_required`; do not persist an executable custom configuration.
- [ ] Return sanitized endpoint-trust status with `IntegrationInstanceDto`: official, trusted custom, or review required. A stale approval is never returned as trusted.

**Validation:**

- Run (red): `mise run test service_integrations -- --nocapture`
- Expected: approval/CAS tests fail because save cannot verify an endpoint-trust preview.
- Run (green): `mise run test service_integrations -- --nocapture`
- Expected: create/update/revoke scenarios pass and failed attempts leave no partial state.

### Task 3: Enforce the approved policy in native and Wasm egress

**Seam:** `NetworkBroker::execute_bytes` and `BrokerHandle::fetch`

**Outcome:** The same exact approval permits system DNS/proxy connectivity in both execution paths; all unresolved custom configurations are blocked before transport.

**Files:**

- Modify: `src-tauri/src/services/endpoint_trust.rs`
- Modify: `src-tauri/src/services/bounded_http.rs`
- Modify: `src-tauri/src/services/network_broker.rs`
- Modify: `src-tauri/src/services/wasm_runtime/network_handle.rs`
- Test: inline tests in `src-tauri/src/services/bounded_http.rs`, `src-tauri/src/services/network_broker.rs`, and `src-tauri/src/services/wasm_runtime/network_handle.rs`

**Steps:**

- [ ] **Red:** Add capture-transport tests through both public broker seams. Assert vendor default selects `TrustedFixed`, matching approved custom origin selects `UserApprovedCustom`, and unapproved/mismatched custom origin returns `endpoint_trust_required` before transport.
- [ ] **Green:** Implement one shared classifier taking host-owned plugin ID, endpoint alias, normalized origin, execution-grant provenance, and current approval. Remove duplicated Edge policy checks from `network_broker.rs` and `network_handle.rs`.
- [ ] Add `DestinationPolicy::UserApprovedCustom`. Its reqwest client uses OS DNS and the instance’s approved `ProxyMode`, including normal system proxy behavior. It must not use `PublicDestinationResolver` or filter DNS answers by public/fake/private/reserved address class.
- [ ] Retain default TLS certificate and hostname verification, no redirects, request/response caps, timeout caps, path confinement, blocked sensitive headers, cancellation, and log redaction for `UserApprovedCustom`.
- [ ] Continue rejecting raw-IP and localhost URL literals before policy selection. The user confirms a hostname origin, not a general local-network permission.
- [ ] Add deterministic resolver tests proving a synthetic `198.18.0.0/15` answer and a private answer reach the user-approved transport policy, while no unapproved custom origin reaches any transport. Do not add live network tests to CI.

**Validation:**

- Run (red): `mise run test network_broker -- --nocapture`
- Expected: approved custom origin tests fail because custom endpoints are still treated as public-only or policy selection is duplicated.
- Run (green): `mise run test network_broker -- --nocapture`
- Expected: Bundled Rust official/approved/unapproved scenarios and existing authorization coverage pass.
- Run: `mise run test network_handle -- --nocapture`
- Expected: Wasm official/approved/unapproved scenarios and existing resource/stream coverage pass.
- Run: `mise run test bounded_http -- --nocapture`
- Expected: DNS-class behavior follows approval state without live egress.

### Task 4: Seal approval into Wasm grants and invalidate it on identity change

**Seam:** `RuntimeLifecycleService::preview_upgrade` / `apply_upgrade`

**Outcome:** A package-backed Edge TTS grant uses relaxed DNS policy only while it carries a live exact approval; config and runtime identity changes safely remove that authority.

**Files:**

- Modify: `src-tauri/src/domain/runtime_plugin.rs`, `src-tauri/src/domain/runtime_lifecycle.rs`
- Modify: `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/runtime_router.rs`
- Modify: `src-tauri/src/repositories/plugin_permission_grants.rs`, `src-tauri/src/repositories/tests.rs`
- Test: `src-tauri/src/services/edge_tts_runtime_tests.rs`, `src-tauri/src/services/runtime_lifecycle_preference_tests.rs`, and runtime-router inline tests

**Steps:**

- [ ] **Red:** Add lifecycle tests proving an exact live approval produces `user-approved-instance` grant provenance, while default uses host trust and every unmatched/expired/changed custom value is review-required.
- [ ] **Green:** Extend `NetworkOriginKind` with `UserApprovedInstance`; include it in canonical serialization and authority digest input so policy cannot be broadened after grant approval.
- [ ] Update `build_grant_bundle_for_target` to select `UserApprovedInstance` only after an exact approval lookup against normalized target configuration and target runtime identity. Never infer approval from a URL or frontend field.
- [ ] Update runtime-router manifest/grant validation: `UserApprovedInstance` is valid only for an endpoint with `instance_origin_config_field`, a matching exact approval, and its declared capability/method/origin.
- [ ] On upgrade, downgrade, migration, rollback, config change, or package identity change, revoke approval and create strict/review-required state. Do not restore a prior approval automatically from a rollback snapshot.
- [ ] Keep existing speech service/default reference preservation tests green; approval changes must not alter service IDs or preferences.

**Validation:**

- Run (red): `mise run test runtime_lifecycle -- --nocapture`
- Expected: provenance and invalidation tests fail because grants cannot carry/revalidate custom approval.
- Run (green): `mise run test runtime_lifecycle -- --nocapture`
- Expected: grant sealing, identity invalidation, migration, and rollback tests pass.
- Run: `mise run test edge_tts_runtime -- --nocapture`
- Expected: Edge synthesis, binary Blob, MIME, auto-pin, migration, and rollback regressions pass.

### Task 5: Build the simple review-and-save UI

**Seam:** `endpointTrustPresentation` and the `IntegrationEditor` save flow

**Outcome:** A user sees a single clear custom-endpoint warning, must acknowledge it, and can only save after host preview confirmation.

**Files:**

- Create: `src/features/plugins/endpointTrustPresentation.ts`, `src/features/plugins/endpointTrustPresentation.test.ts`, `src/features/plugins/EndpointTrustDialog.tsx`
- Modify: `src/features/plugins/IntegrationEditor.tsx`, `src/components/ConfirmDialog.tsx`
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`
- Test: `src/features/plugins/endpointTrustPresentation.test.ts`; manual `tauri:dev` flow

**Steps:**

- [ ] **Red:** Write pure Bun tests for official status, custom-review-required status, trusted-custom status, acknowledgement gating, preview expiry, and cancellation. Assert no helper can produce an acknowledged save payload after the candidate origin changes.
- [ ] **Green:** Implement status/payload helpers and `EndpointTrustDialog`. Use the project’s Base UI dialog/checkbox conventions; do not introduce inline SVG or custom primitives.
- [ ] Extend `ConfirmDialog` with `confirmDisabled` so the action stays disabled until acknowledgement instead of failing after click.
- [ ] In `IntegrationEditor`, show `Official endpoint`, `Custom endpoint · Review required`, or `Custom endpoint · Trusted` under the Base URL field. Do not add a radio selector or a public/fake-IP choice.
- [ ] For a changed custom Base URL, Save first requests host preview, then opens one dialog containing the exact origin, the speech data category, the fixed `POST /v1/audio/speech` scope, and this plain-language warning: system DNS/proxy may resolve the trusted hostname to public, fake-IP, or internal addresses.
- [ ] The dialog requires one acknowledgement checkbox: “I trust this endpoint with speech text.” `Cancel` retains the unsaved draft; `Trust and save` submits the original write plus opaque preview ID and acknowledgement.
- [ ] Keep `SpeechServiceEditor` unchanged. It selects an integration binding and must not own integration endpoint authority.

**Validation:**

- Run (red): `bun test src/features/plugins/endpointTrustPresentation.test.ts`
- Expected: tests fail because the presentation/save-flow helpers do not exist.
- Run (green): `bun test src/features/plugins/endpointTrustPresentation.test.ts`
- Expected: status, acknowledgement, candidate-change, and cancellation decisions pass.
- Run: `mise run typecheck`
- Expected: the new IPC DTO and editor flow type-check.
- Manual: `mise run tauri:dev`
- Expected: official save has no dialog; custom save requires acknowledgement; Cancel persists nothing; reload shows trusted status.

### Task 6: Add end-to-end conformance and operator feedback

**Seam:** Edge TTS synthesis through the selected integration instance

**Outcome:** Approved custom endpoints work in fake-IP and non-public DNS environments; unapproved custom endpoints cannot execute and give an actionable safe message.

**Files:**

- Modify: `.mise/tasks/plugin/conformance`
- Modify: `src-tauri/src/services/network_broker.rs`, `src-tauri/src/services/wasm_runtime/network_handle.rs`, `src-tauri/src/services/edge_tts_runtime_tests.rs`
- Modify: `src/routes/translate/index.tsx` only if the stable `endpoint_trust_required` speech error can be surfaced without leaking endpoint/DNS detail
- Test: existing Edge runtime/broker suites and frontend presentation tests

**Steps:**

- [ ] **Red:** Add required conformance tests for unapproved custom blocking, approved fake-IP policy selection, approved private DNS-result policy selection, and approval invalidation after origin/package changes through both Bundled Rust and Wasm routes.
- [ ] **Green:** Register exact test names in `plugin:conformance edge-tts`. Do not use fixture-only checks or transports that bypass `NetworkBroker` / `BrokerHandle`.
- [ ] Map only the known unapproved-custom condition to non-retryable `endpoint_trust_required`; keep unrelated network/TLS/timeout failures in their current generic categories.
- [ ] If the translator route receives `endpoint_trust_required`, show localized guidance to review the integration endpoint. Do not include the origin, resolved IP, headers, or provider response in the toast.
- [ ] Confirm logs contain only policy category, endpoint alias, plugin ID, and request ID; never log speech text, preview tokens, raw DNS results, or response bodies.

**Validation:**

- Run (red): `mise run plugin:conformance edge-tts`
- Expected: required custom-trust test names are absent or fail.
- Run (green): `mise run plugin:conformance edge-tts`
- Expected: all Edge trust, broker, and existing binary-resource tests pass.

## Final Validation

```bash
mise run test endpoint_trust -- --nocapture
mise run test service_integrations -- --nocapture
mise run test network_broker -- --nocapture
mise run test network_handle -- --nocapture
mise run test bounded_http -- --nocapture
mise run test runtime_lifecycle -- --nocapture
mise run test edge_tts_runtime -- --nocapture
mise run plugin:conformance edge-tts
bun test src/features/plugins/endpointTrustPresentation.test.ts
bun test src/features/speech
mise run typecheck
mise run lint
mise run format:check
git diff --check
```

Expected: all tests pass; official Edge TTS works without prompt; a custom endpoint cannot execute before acknowledgement; an acknowledged exact DNS-name endpoint can connect regardless of its later DNS address class in both Bundled Rust and Wasm paths.

Manual checks in `mise run tauri:dev`:

1. Confirm official `https://tts.wangwangit.com` synthesizes in the current fake-IP environment.
2. Enter a custom Base URL and cancel the trust dialog; confirm config/trust do not change.
3. Approve a custom Base URL; confirm synthesis works and reload displays `Trusted`.
4. Exercise a test/custom domain resolving to fake-IP and a non-public address through controlled test infrastructure; confirm approved policy reaches the transport while unapproved policy stops before transport.
5. Change origin, upgrade, downgrade, or roll back runtime; confirm a new review is required.

## Failure Behavior

- Non-HTTPS, raw-IP, localhost, malformed, or unsupported custom URL — reject before preview and leave the draft unsaved.
- Missing acknowledgement, stale/expired preview, origin/config/runtime mismatch, or stale instance revision — reject save with a sanitized stable IPC error and write no config, grant, or approval.
- Unapproved custom endpoint at execution time — reject before network transport with `endpoint_trust_required`.
- Approved custom endpoint whose network/TLS/provider request fails — report the existing network/timeout/provider category; do not falsely call it an approval error.
- Origin/package/runtime change — revoke approval and require new review; never retain it implicitly.

## Privacy and Security

- The dialog states that speech text and preferences leave the device, and displays the exact normalized origin plus fixed method/path scope.
- The host, not the frontend, computes origin, policy, configuration fingerprint, and approval state. The frontend sends only an opaque preview ID and acknowledgement.
- User acknowledgement intentionally allows that DNS-name endpoint to resolve to any address class. This can reach internal resources if the hostname resolves there; this is the accepted security trade-off.
- The override remains limited to one exact origin and preserves HTTPS, TLS validation, no redirects, host-owned path/method/header checks, response limits, cancellation, and redaction.

## Rollout Notes

- Migration 0021 creates no approval rows. Existing custom endpoints become review-required; existing official Edge default remains host-trusted.
- Do not auto-approve on import, package seed, instance auto-pin, migration, upgrade, downgrade, or rollback.
- Release notes must explain that approving a custom endpoint accepts all DNS address classes for that exact hostname.

## Risks and Mitigations

- **DNS rebinding reaches an internal address.** — This is explicitly authorized only after the user sees the exact-origin warning and acknowledges it; scope remains one origin with TLS/method/path limits.
- **A changed plugin/config reuses prior approval.** — Bind approval to origin, endpoint alias, configuration fingerprint, runtime identity, and CAS revision; revoke on mismatch.
- **Bundled Rust and Wasm differ.** — Route both public execution seams through the same classifier and conformance tests.
- **A user treats approval as a generic connectivity switch.** — Dialog and release notes state exact origin and full DNS-address-class consequence; no global setting exists.
- **Preview cache holds sensitive data.** — Store only normalized endpoint metadata/fingerprints, never full writes, credentials, speech text, headers, DNS results, or provider responses.

## Open Questions

None blocking this plan. A future request to trust raw IP, localhost, or a broad local-network range requires a separate threat model and approval flow.
