# Phase 7: Google Cloud Multi-Capability Runtime Plugin Implementation Plan

**Goal:** Migrate Google Cloud Translate, Detect, Vision OCR, and Text-to-Speech into one installable Wasm plugin while retaining host-owned service-account OAuth, independent capability health, and atomic per-instance rollback.

**Inputs:** Phases 5–6 and current `google_cloud.rs`, token grant, OCR, and Speech implementations.

**Assumptions:**

- Google Cloud package keeps the existing plugin ID, credential slot, and capability majors.
- STT, microphone capture, and long audio remain gated.
- Service-account JSON and access tokens never enter WIT.

**Architecture:** The guest owns API wire formats, language mapping, and response parsing. Host auth policies own service-account validation, JWT signing, token exchange/cache, scope/audience, endpoint grants, and bearer injection. One integration instance supplies several independently healthy capabilities.

**Tech Stack:** Wasm Component/WIT, host Google OAuth driver, NetworkBroker, Blob resources, existing Translation/OCR/Speech domains.

---

## Dependencies

- Phases 5 and 6 complete.

## File Map

- Create: `src-tauri/migrations/0018_integration_capability_health.sql` — per-instance/capability health records.
- Create: `runtime-plugins/google-cloud/Cargo.toml`, `runtime-plugins/google-cloud/src/lib.rs`, `runtime-plugins/google-cloud/plugin.json` — multi-capability guest/package.
- Create: `runtime-plugins/google-cloud/schemas/`, `runtime-plugins/google-cloud/locales/`, `runtime-plugins/google-cloud/tests/fixtures/` — config/preferences/localization/golden fixtures.
- Create: `.mise/tasks/plugin/build-google-cloud` — deterministic Component build and unsigned staging tree at `runtime-plugins/dist/staging/com.langnext.google-cloud-1.2.0/`; use the Phase 3 external-signing/finalization pipeline for the final archive.
- Modify: `src-tauri/src/services/auth_policies.rs`, `src-tauri/src/services/token_grant.rs`, `src-tauri/src/services/google_service_account.rs`, `src-tauri/src/services/network_broker.rs` — host-owned Google auth.
- Modify: `src-tauri/src/services/google_cloud.rs` — compatibility adapter/fixture source during migration.
- Modify: `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/services/service_capabilities.rs` — package migration/routing.
- Modify: `src-tauri/src/services/translation_profiles.rs`, `src-tauri/src/services/ocr_services.rs`, `src-tauri/src/services/speech_services.rs` — runtime bindings.
- Modify: `src/features/plugins/IntegrationEditor.tsx`, `src/features/ocr/OcrServiceEditor.tsx`, `src/features/speech/SpeechServiceEditor.tsx` — status/migration UX.
- Modify: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs` — health migration/module registration.
- Test: guest golden tests, OAuth/grant tests, Blob tests, capability health migration/repository tests, and lifecycle rollback tests.

## Tasks

### Task 1: Register a host-owned Google auth policy

**Outcome:** The guest can request authenticated Google calls without seeing credentials or tokens.

**Files:**

- Modify: `src-tauri/src/services/auth_policies.rs`, `src-tauri/src/services/token_grant.rs`, `src-tauri/src/services/google_service_account.rs`, `src-tauri/src/services/network_broker.rs`
- Test: inline auth/token/broker tests in those modules

**Steps:**

- [ ] Define `host.oauth2.service-account.google.v1` as a trusted host policy.
- [ ] Bind it to the existing `service-account-json` slot, pinned token URI/audience, and declared Google endpoint aliases.
- [ ] Derive allowed scopes by capability: Translation/Detect, Vision OCR, and TTS separately.
- [ ] Keep JWT signing/token exchange/cache/credential revision eviction entirely in Rust.
- [ ] Permit broker bearer injection only when principal, capability, endpoint, grant, slot, and scope all match.
- [ ] Return opaque auth success/failure only; never WIT token material.

**Validation:**

- Run: `mise run test google_auth_policy -- --nocapture`
- Expected: wrong scope/audience/endpoint/slot/instance is denied; token cache revision behavior passes.

### Task 2: Port Translate and Detect

**Outcome:** Google Cloud text translation executes through the multi-capability Component.

**Files:**

- Modify: `runtime-plugins/google-cloud/src/lib.rs`, `runtime-plugins/google-cloud/tests/fixtures/translate/`, `runtime-plugins/google-cloud/plugin.json`, `.mise/tasks/plugin/build-google-cloud`
- Modify: `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/services/runtime_lifecycle.rs`, `src/features/plugins/IntegrationEditor.tsx`

**Steps:**

- [ ] Port project/location path construction, language mapping, request limits, Translate response parsing, detection parsing, and Google error envelope mapping.
- [ ] Request only `translate` endpoint and the host Google auth policy.
- [ ] Preserve source-auto and capability-specific detection behavior.
- [ ] Keep this tracer unactivated in production until OCR and TTS exports also pass Task 6; do not partially switch an instance by capability.
- [ ] Preserve integration/profile IDs and shared credential binding in fixtures.

**Validation:**

- Run: `mise run plugin:conformance google-cloud-translate`
- Run: `mise run test google_cloud_translate_runtime -- --nocapture`
- Expected: golden requests/responses, auth, IAM/quota/rate-limit, cancellation, and unactivated runtime fixtures pass.

### Task 3: Port Vision OCR through BlobHandle

**Outcome:** Existing Google Vision OCR services use the same plugin instance and credential without image bytes in JSON/base64 IPC.

**Files:**

- Modify: `runtime-plugins/google-cloud/src/lib.rs`, `runtime-plugins/google-cloud/schemas/ocr-preferences.json`, `runtime-plugins/google-cloud/tests/fixtures/vision/`, `src-tauri/src/services/ocr_services.rs`, `src-tauri/src/services/runtime_router.rs`
- Test: guest OCR golden tests, OCR runtime lifecycle tests, and `src-tauri/src/services/blob_resources.rs` tests

**Steps:**

- [ ] Implement `ocr.image@1` using an input BlobHandle and bounded recognized text/layout result.
- [ ] Port Vision annotate request construction, language hints/preferences, response parsing, and error mapping.
- [ ] Request only `vision` endpoint and Vision scope through the host policy.
- [ ] Validate OCR bindings against the unactivated package fixture without changing persisted instance runtime, OCR service, or default screenshot settings.
- [ ] Keep input image and recognized text out of default logs/history/export.

**Validation:**

- Run: `mise run plugin:conformance google-cloud-ocr`
- Run: `mise run test google_cloud_ocr_runtime -- --nocapture`
- Expected: Blob ownership, request/response bounds, parsing, IAM isolation, and unactivated binding fixtures pass.

### Task 4: Port Text-to-Speech through BlobHandle

**Outcome:** Google Cloud TTS uses the same instance/auth policy and existing playback UX.

**Files:**

- Modify: `runtime-plugins/google-cloud/src/lib.rs`, `runtime-plugins/google-cloud/schemas/speech-preferences.json`, `runtime-plugins/google-cloud/tests/fixtures/tts/`, `src-tauri/src/services/speech_services.rs`, `src-tauri/src/services/runtime_router.rs`
- Test: guest TTS golden tests, Speech runtime lifecycle tests, and `src/features/speech/speechPlaybackController.test.ts`

**Steps:**

- [ ] Implement `speech.synthesize@1` with current text, language, speaking-rate, and pitch limits; keep SSML unsupported.
- [ ] Port request/response/error parsing and request `text_to_speech` endpoint with least-privilege scope.
- [ ] Return decoded bounded audio through an output BlobHandle and existing binary IPC.
- [ ] Preserve one-active-playback cancellation and Speech service/default IDs.
- [ ] Keep this tracer unactivated until the complete multi-capability package passes Task 6.

**Validation:**

- Run: `mise run plugin:conformance google-cloud-tts`
- Run: `mise run test google_cloud_tts_runtime -- --nocapture`
- Run: `bun test src/features/speech`
- Expected: synthesis/playback/cancel/IAM and unactivated runtime fixture behavior passes.

### Task 5: Track per-capability health

**Outcome:** One IAM/provider failure does not make unrelated capabilities appear healthy or broken.

**Files:**

- Create: `src-tauri/migrations/0018_integration_capability_health.sql`
- Create: `src-tauri/src/domain/integration_capability_health.rs`
- Create: `src-tauri/src/repositories/integration_capability_health.rs`
- Modify: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/domain/service_integration.rs`, `src-tauri/src/services/service_integrations.rs`, `src/features/plugins/IntegrationEditor.tsx`
- Test: migration tests, `src-tauri/src/repositories/tests.rs`, and capability health service tests

**Steps:**

- [ ] Keep instance configuration/auth health separate from last capability invocation health.
- [ ] Record sanitized last result/time per capability major: ready/degraded plus normalized error code.
- [ ] Do not mark all capabilities ready from token exchange alone.
- [ ] Evict/refresh health on credential, config, permission, package, or grant changes.
- [ ] Display capability status without provider body/user content.

**Validation:**

- Run: `mise run test capability_health -- --nocapture`
- Expected: Translation permission failure leaves OCR/TTS state independent; auth/config changes invalidate relevant status.

### Task 6: Complete atomic multi-capability lifecycle validation

**Outcome:** One instance and all of its Profile/OCR/Speech bindings switch to one package/grant-set revision and rollback together, while capability health remains independent.

**Files:**

- Modify: `runtime-plugins/google-cloud/plugin.json`, `.mise/tasks/plugin/build-google-cloud`, `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/repositories/plugin_permission_grants.rs`, `src/features/plugins/IntegrationEditor.tsx`
- Test: `runtime-plugins/google-cloud/tests/fixtures/`, `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/repositories/tests.rs`

**Steps:**

- [ ] Generate the complete signed file index only after Translate/Detect, OCR, and TTS artifacts/schemas/fixtures are present; release CI signs exact `plugin.json` bytes, then `plugin:finalize-package` emits `runtime-plugins/dist/com.langnext.google-cloud-1.2.0.lnplugin` and its post-signing `.sha256`.
- [ ] Configure one test Google Cloud instance with explicit credentials and bind Translate, OCR, and TTS resources.
- [ ] Preview and confirm one atomic instance transition from Bundled Rust to the exact package plus one complete grant-set revision containing all required capability authority entries; all existing bindings resolve through that instance pin.
- [ ] Validate each capability and cancellation separately without changing runtime identity per capability.
- [ ] Roll back the instance atomically to Bundled Rust; verify Translate/OCR/TTS bindings all follow the restored identity and no mixed executor state can be persisted.
- [ ] Seed the final signed package only after this atomic lifecycle passes, retain Bundled Rust rollback for one stable release, and confirm dependency-protected delete/import-export pre-Phase-11 behavior remain safe.

**Validation:**

- Manual: `mise run tauri:dev` with user-supplied test credentials.
- Expected: all capabilities work, runtime/grant-set identity is atomic across bindings, mixed executor state is rejected, and credentials/tokens/user data never appear in logs/DTOs.

## Final Validation

```bash
mise run plugin:build-google-cloud
# Release CI only, after external signature injection:
mise run plugin:finalize-package runtime-plugins/dist/staging/com.langnext.google-cloud-1.2.0 runtime-plugins/dist/com.langnext.google-cloud-1.2.0.lnplugin
mise run plugin:verify runtime-plugins/dist/com.langnext.google-cloud-1.2.0.lnplugin
mise run plugin:conformance google-cloud
mise run test google_cloud_runtime -- --nocapture
mise run test capability_health -- --nocapture
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
```

Expected: four Google Cloud capabilities execute through one package/instance with host-owned OAuth and independent health.

## Failure Behavior

- Token/auth failure — mark auth/capability degraded; no raw provider message/token.
- Capability IAM failure — affect that capability only.
- Guest trap/parse failure — stable capability error and explicit atomic instance rollback availability.
- Credential replacement — evict token grants/runtime health immediately.

## Privacy and Security

- Service-account JSON remains write-only in the host vault.
- JWT assertions/access tokens never cross WIT/frontend IPC.
- OCR images, recognized text, translation text, and audio are excluded from logs/export.

## Rollout Notes

- Implement and review in order: Translate/Detect, OCR, then TTS, but do not activate a production instance from any incomplete sub-slice.
- Ship/seed only the complete signed package; migrate and rollback one instance atomically so every Profile/OCR/Speech binding follows the same executor/package/grant-set revision.

## Risks and Mitigations

- Multi-capability release hides failures — use separate implementation/conformance slices, then require one atomic lifecycle suite before production activation.
- Scope expansion — capability-scoped host allowlist and reapproval on permission changes.
- Large OCR/audio payloads — Blob caps, cancellation, and no base64.

## Open Questions

- Google Cloud STT remains out of scope until formats, duration, partial results, microphone permissions, and retention are specified.
