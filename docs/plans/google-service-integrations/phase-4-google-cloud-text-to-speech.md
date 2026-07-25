# Phase 4 Google Cloud Text-to-Speech Implementation Plan

**Goal:** Add configurable Google Cloud text-to-speech services, a Speech page matching the OCR management UX, and immediate MP3 playback for source and translated text.

**Inputs:** Product decisions from 2026-07-24, `docs/plans/google-service-integrations/future-gates.md`, the implemented OCR/Google Cloud integration architecture, current Google Cloud Text-to-Speech REST documentation, and the local Tauri v2 commands/channels reference.

**Assumptions:**

- Phases 1A–3 are implemented and remain the baseline; this phase extends `com.langnext.google-cloud` rather than adding separate Google credentials.
- “Same as OCR” means a top-level `/speech` route with a left service rail, nested editor, Add dialog, automatic first-item selection, default-service selector, and matching Base UI/frame styling.
- Multiple Speech services are allowed so users can bind different Google Cloud instances or speaking preferences; one app-level default serves Translate playback.
- A Speech service stores no language or named voice. Each synthesis call supplies the effective source/target app language, which Rust maps to a Google BCP-47 `languageCode`; Google chooses the voice.
- Source playback with `sourceLang = auto` reuses the existing language-detection workflow when no prior detection result exists.
- The app uses the synchronous REST method and receives the complete MP3 before playback. Audio is memory-only and is neither cached nor downloaded.

**Architecture:** Migration 0015 adds capability-backed Speech services that reference a ready integration instance implementing `speech.synthesize@1`; app settings hold the default Speech service. Rust validates text/language/preferences, obtains a capability-scoped Google token grant, calls the pinned Text-to-Speech REST endpoint, decodes the bounded MP3, and returns raw bytes through `tauri::ipc::Response`. A frontend playback controller owns one `HTMLAudioElement`, cancellation request, Blob URL, and playback state shared by the source and result controls.

**Tech Stack:** Rust, SQLite/rusqlite, Google Cloud Text-to-Speech REST v1, existing TokenGrant/NetworkBroker services, Tauri 2 binary command responses, React 19, TanStack Router/Query, Effect IPC, Base UI, Tailwind CSS v4, i18next, Bun.

---

## Required Product Gate

**Status: locked (2026-07-24)**

| #   | Decision          | Locked value                                                                                                                                        |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Operation set     | Text-to-speech only: `speech.synthesize@1`; no `speech.recognize@1` implementation                                                                  |
| 2   | Provider          | Google Cloud only through `com.langnext.google-cloud`                                                                                               |
| 3   | User entry points | Source and translated text controls on `src/routes/translate/index.tsx`                                                                             |
| 4   | Voice selection   | Runtime effective language only; no persisted voice name/gender; Google auto-selects the voice                                                      |
| 5   | Input             | Plain text only; no SSML; non-empty UTF-8 payload up to **5,000 bytes**                                                                             |
| 6   | Preferences v1    | `speakingRate` **0.25–2.0**, default **1.0**; `pitch` **-20.0–20.0**, default **0.0**                                                               |
| 7   | Audio             | Fixed `MP3`; provider-native sample rate; no effects profile, volume gain, or sample-rate override                                                  |
| 8   | Transport         | Synchronous unary REST; bounded raw binary Tauri response; no streaming, file handle, or base64 audio in frontend DTOs                              |
| 9   | Playback          | One active playback across source/result; new playback stops and cancels the prior request/playback                                                 |
| 10  | Persistence       | Audio and synthesis text are not saved to history, cache, files, logs, events, or exports                                                           |
| 11  | OAuth scope       | `https://www.googleapis.com/auth/cloud-platform`, the scope documented by Google for `text.synthesize`; allow-listed only for `speech.synthesize@1` |
| 12  | REST              | `POST https://texttospeech.googleapis.com/v1/text:synthesize` via pinned `text_to_speech` endpoint alias                                            |
| 13  | Export            | Advance configuration export to v6; include Speech service structure/default binding, omit audio and all secrets/refs                               |

Named constants (implementation):

```text
SPEECH_SYNTHESIZE_CAPABILITY_ID = speech.synthesize@1
GOOGLE_CLOUD_TEXT_TO_SPEECH_SCOPE = https://www.googleapis.com/auth/cloud-platform
GOOGLE_TEXT_TO_SPEECH_ENDPOINT_ALIAS = text_to_speech
GOOGLE_TEXT_TO_SPEECH_SYNTHESIZE_PATH = v1/text:synthesize
SPEECH_DISPLAY_NAME_MAX_LEN = 128
SPEECH_TEXT_MAX_BYTES = 5_000
SPEECH_AUDIO_MAX_BYTES = 12 * 1024 * 1024
SPEECH_PROVIDER_RESPONSE_MAX_BYTES = (SPEECH_AUDIO_MAX_BYTES * 4 / 3) + (64 * 1024)
SPEECH_SYNTHESIS_TIMEOUT_SECS = 60
SPEECH_SPEAKING_RATE_MIN = 0.25
SPEECH_SPEAKING_RATE_MAX = 2.0
SPEECH_SPEAKING_RATE_DEFAULT = 1.0
SPEECH_PITCH_MIN = -20.0
SPEECH_PITCH_MAX = 20.0
SPEECH_PITCH_DEFAULT = 0.0
GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION = 1
```

### Gate rationale

- Google documents `POST /v1/text:synthesize` as synchronous and returns `audioContent` as base64 in the provider JSON response. The host decodes it once and returns raw bytes to the webview.
- Google documents a 5,000-byte synthesis content limit and requires `cloud-platform` for `text.synthesize`; the host duplicates the input limit locally and constrains that broad scope to this capability in `token_grant.rs`.
- Tauri documents `tauri::ipc::Response` for large binary command returns and Channels for ordered streaming. Because this phase is explicitly unary, a bounded binary response is simpler than introducing a stream protocol while still satisfying the gate’s no-unbounded-base64 requirement.
- For `speech.synthesize@1` v1 only, this locked phase supersedes the earlier generic recommendation in `docs/analysis/google-cloud-plugin-architecture.md` that every Speech contract support streaming from the start. That recommendation still applies before streaming, long-audio, or STT work.

## Out of Scope

- Speech-to-text, microphone capture, recording permissions, partial transcripts, and input audio transport.
- Streaming synthesis, long-audio synthesis, Cloud Storage output, playback-before-completion, and playback queues.
- SSML, named voices, gender selection, custom voices, Journey/Gemini-specific options, effects profiles, sample-rate selection, and volume gain.
- Audio download, disk/memory cache, history, sharing, or export.
- Quick Translate, History, OCR, and other windows as TTS entry points.
- Non-Google providers, installable plugins, generic settings-schema rendering, and service-catalog consolidation.

## File Map

### Backend

- Create: `src-tauri/migrations/0015_speech_services.sql` — capability-backed Speech services with an integration FK and ordered rows.
- Create: `src-tauri/src/domain/speech_service.rs` — Speech service DTO/write/synthesis input and validation-facing domain types.
- Create: `src-tauri/src/repositories/speech_services.rs` — Speech service CRUD and integration dependency lookup.
- Create: `src-tauri/src/services/speech_services.rs` — CRUD validation, default resolution, capability dispatch, and deletion/default cleanup.
- Create: `src-tauri/src/cmds/speech_services.rs` — Speech CRUD, synthesize, and cancel IPC commands; default selection remains in settings IPC.
- Modify: `src-tauri/src/storage/migrations.rs` — embed migration 0015 and add fresh/upgrade coverage.
- Modify: `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/cmds/mod.rs` — register the Speech modules.
- Modify: `src-tauri/src/domain/service_capability.rs` — typed synthesis request/response/preferences and hard limits.
- Modify: `src-tauri/src/services/service_capabilities.rs` — `SpeechSynthesizeCapability`, handler registration, and resolver.
- Modify: `src-tauri/src/services/service_integration_registry.rs` — Google Text-to-Speech endpoint/capability manifest entries and plugin version.
- Modify: `src-tauri/src/services/token_grant.rs` — capability-only `cloud-platform` scope allow-list.
- Modify: `src-tauri/src/services/network_broker.rs` — named provider-response cap for TTS JSON.
- Modify: `src-tauri/src/services/google_cloud.rs` — request construction, language mapping, provider error mapping, and MP3 decode.
- Modify: `src-tauri/src/repositories/integration_instances.rs` — include Speech services in dependency results.
- Modify: `src-tauri/src/domain/settings.rs`, `src-tauri/src/services/settings.rs`, `src-tauri/src/cmds/settings.rs` — `defaultSpeechServiceId` persistence and command behavior.
- Modify: `src-tauri/src/events.rs` — Speech service data-change event.
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs` — compose the service and register commands.
- Modify: `src-tauri/src/domain/import_export.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/import_validation.rs`, `src-tauri/src/cmds/import_export.rs` — export/import v6, remapping, preview counts, and invalidation.

### Frontend

- Create: `src/features/speech/SpeechContext.ts` — Speech route layout context token.
- Create: `src/features/speech/SpeechLayout.tsx` — OCR-style rail, nested outlet, default-service selector, and Add dialog host.
- Create: `src/features/speech/AddSpeechServiceDialog.tsx` — capability-driven Google Cloud TTS creation options.
- Create: `src/features/speech/SpeechServiceEditor.tsx` — rename, enable, rebind, preferences, save/reset, and delete.
- Create: `src/features/speech/GoogleCloudTtsForm.tsx` — integration health/rebind, speaking-rate, and pitch controls.
- Create: `src/features/speech/speechProviderOptions.ts` — discovery/default preferences/compatible rebind helpers.
- Create: `src/features/speech/speechProviderOptions.test.ts` — capability discovery, readiness, and rebind tests.
- Create: `src/features/speech/speechPlaybackController.ts` — injected one-audio state machine, cancellation, Blob URL lifecycle, and cleanup.
- Create: `src/features/speech/speechPlaybackController.test.ts` — state transitions, replacement, cancellation, and URL revocation without a browser test renderer.
- Create: `src/features/speech/useSpeechPlayback.ts` — thin React lifecycle wrapper around the playback controller.
- Create: `src/routes/speech.tsx`, `src/routes/speech/index.tsx`, `src/routes/speech/$speechServiceId.tsx` — Speech route tree and editor selection.
- Create: `src/routes/translate/-speechLanguage.ts`, `src/routes/translate/-speechLanguage.test.ts` — pure source/target playback language resolution and tests.
- Modify: `src/shell/nav.ts`, `src/routes/__root.tsx` — primary Speech navigation item and Iconify icon.
- Generated: `src/routeTree.gen.ts` — TanStack Router output; never edit manually.
- Modify: `src/storage/types.ts`, `src/storage/client.ts` — Speech DTOs, CRUD/default IPC, cancellation, and raw `Uint8Array` synthesis response.
- Modify: `src/query/keys.ts`, `src/query/options.ts`, `src/query/events.ts`, `src/query/dataChangeEventBindings.ts` — Speech Query cache and cross-window invalidation.
- Modify: `src/query/dataChangeEventBindings.test.ts` — event-to-key coverage.
- Modify: `src/routes/translate/index.tsx` — source/result speak controls and effective-language resolution.
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts` — navigation, Speech CRUD/preferences, playback, and error copy.
- Modify: `src/features/settings/configurationTransfer.ts` and tests/fixtures that construct `AppSettingsV1` — v6 transfer shape and default Speech binding.
- Modify: `src/storage/bootstrap.ts` and settings/bootstrap tests — additive `defaultSpeechServiceId` compatibility.

Every created code file starts with the repository-required two-line `ABOUTME` comment in its language’s comment syntax.

## Tasks

### Task 1: Lock the TTS contract and promote the gate

**Outcome:** The roadmap has one approved TTS phase and keeps STT/streaming behind the Speech gate.

**Files:**

- Create: `docs/plans/google-service-integrations/phase-4-google-cloud-text-to-speech.md`
- Modify: `docs/plans/google-service-integrations/README.md`
- Modify: `docs/plans/google-service-integrations/future-gates.md`

**Steps:**

- [x] Record the provider, capability ID, entry points, automatic voice policy, preferences, MP3 behavior, content/output bounds, OAuth scope, endpoint, privacy policy, and export decision above.
- [x] Split the future Speech gate into an approved TTS subset and a still-gated STT/streaming subset.
- [x] Add Phase 4 after Phase 3 in the roadmap without changing the completed Translation/OCR architecture.
- [x] Cite current Google REST/quotas references and the local Tauri binary-response guidance in this plan’s References.

**Validation:**

- Run: `mise run format:check`
- Expected: the roadmap, gate, and phase plan are formatted and have no unresolved TTS product decision.

### Task 2: Add Speech persistence and domain types

**Outcome:** Speech services survive restart, preserve ordering, bind compatible integration instances, and expose no secrets.

**Files:**

- Create: `src-tauri/migrations/0015_speech_services.sql`
- Create: `src-tauri/src/domain/speech_service.rs`
- Create: `src-tauri/src/repositories/speech_services.rs`
- Modify: migration/module files, `src-tauri/src/repositories/integration_instances.rs`, and repository tests

**Steps:**

- [ ] Create `speech_services` with `id`, `display_name`, `enabled`, `sort_order`, `integration_instance_id`, `capability_id`, `preferences_schema_version`, `preferences_json`, `created_at`, and `updated_at`.
- [ ] Require `integration_instance_id` with `ON DELETE RESTRICT`; keep the capability ID versioned instead of adding a Google-specific provider enum.
- [ ] Define `SpeechService`, sanitized `SpeechServiceDto`, and `SpeechServiceWrite` with optimistic `expectedUpdatedAt` updates.
- [ ] Reject blank display names or names over `SPEECH_DISPLAY_NAME_MAX_LEN = 128`, unsupported preference schema versions, non-finite/out-of-range values, incompatible capability majors, disabled/unready instances, and unknown fields.
- [ ] Preserve deterministic ordering by `sort_order`, `created_at`, and `id`; assign the next sort order on create.
- [ ] Extend integration dependency results with `kind = "speech_service"` so deletion UI and FK failures are actionable.
- [ ] Add fresh database and v14→v15 migration tests plus CRUD/conflict/FK/dependency tests.

**Validation:**

- Run: `mise run test migrate_ -- --nocapture`
- Run: `mise run test speech_service -- --nocapture`
- Expected: fresh/upgrade databases create the table, CRUD round-trips preferences, stale writes conflict, and referenced integrations cannot be deleted.

### Task 3: Register and implement `speech.synthesize@1`

**Outcome:** A Google Cloud integration instance can synthesize bounded plain text to validated MP3 bytes through existing auth/network brokers.

**Files:**

- Modify: `src-tauri/src/domain/service_capability.rs`
- Modify: `src-tauri/src/services/service_capabilities.rs`
- Modify: `src-tauri/src/services/service_integration_registry.rs`
- Modify: `src-tauri/src/services/token_grant.rs`
- Modify: `src-tauri/src/services/network_broker.rs`
- Modify: `src-tauri/src/services/google_cloud.rs`
- Test: colocated Rust unit/contract tests

**Steps:**

- [ ] Add `SpeechSynthesizeRequest { text, languageId, preferences }` and `SpeechSynthesizeResponse { mp3Bytes }` as internal typed contracts; do not serialize MP3 into DTO JSON.
- [ ] Validate non-empty text, the 5,000-byte UTF-8 limit, supported app language IDs, schema v1, finite speaking rate/pitch, and the locked ranges before token or network work.
- [ ] Add `SpeechSynthesizeCapability`, `CapabilityHandler::SpeechSynthesize`, Google handler registration, and instance-aware `resolve_speech_synthesize` checks.
- [ ] Add `text_to_speech -> https://texttospeech.googleapis.com` and `speech.synthesize@1` to the Google manifest; increment the bundled Google Cloud version from `1.1.0` to `1.2.0` while preserving config schema v1.
- [ ] Add `GOOGLE_CLOUD_TEXT_TO_SPEECH_SCOPE` to the fail-closed token policy only for `speech.synthesize@1`; assert Translate/Vision handlers cannot request it and Speech cannot request their scopes.
- [ ] Build `{ input: { text }, voice: { languageCode }, audioConfig: { audioEncoding: "MP3", speakingRate, pitch } }` and call only `v1/text:synthesize` with the named timeout and provider response cap.
- [ ] Reuse the existing app→Google language mapper; return `unsupported_language` before network for unsupported IDs.
- [ ] Parse successful JSON, base64-decode `audioContent`, reject empty/invalid/oversized decoded output, and never include audio/provider bodies in errors or logs.
- [ ] Map Google auth, permission, quota/rate, invalid argument, timeout/network, and malformed response failures to stable capability errors with bounded provider/request metadata.
- [ ] Test exact request JSON, endpoint/scope grants, defaults/ranges, multibyte 5,000-byte enforcement, cancellation, malformed base64, empty audio, output cap, and sanitized errors using fake brokers only.

**Validation:**

- Run: `mise run test service_capability -- --nocapture`
- Run: `mise run test token_grant -- --nocapture`
- Run: `mise run test google_cloud_tts -- --nocapture`
- Expected: the handler emits only the locked REST contract, enforces every bound before returning bytes, and does not broaden other capability grants.

### Task 4: Add Speech service runtime and binary IPC

**Outcome:** Frontend callers can manage Speech services and request/cancel one bounded MP3 synthesis using an explicit service or the app default.

**Files:**

- Create: `src-tauri/src/services/speech_services.rs`
- Create: `src-tauri/src/cmds/speech_services.rs`
- Modify: `src-tauri/src/domain/settings.rs`
- Modify: `src-tauri/src/services/settings.rs`
- Modify: `src-tauri/src/cmds/settings.rs`
- Modify: `src-tauri/src/events.rs`
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, and module registration files

**Steps:**

- [ ] Implement `list_speech_services`, `get_speech_service`, `save_speech_service`, and `delete_speech_service` around the repository, validating ready/enabled compatible instances on save and execution.
- [ ] Add `defaultSpeechServiceId` to `AppSettingsV1` with a serde default for existing v1 documents; validate that a selected ID exists and clear it transactionally when that service is deleted.
- [ ] Add `set_app_default_speech_service` with the same Query/settings update pattern as OCR.
- [ ] Define `SpeechSynthesizeInput { text, languageId, speechServiceId?, requestId? }`; null service ID resolves the app default, and a missing/disabled default fails without provider work.
- [ ] Register each request ID in the shared `RequestSessionRegistry`, propagate cancellation/deadline to token exchange and HTTP, and always remove the session entry on completion/error.
- [ ] Return successful `Vec<u8>` as `tauri::ipc::Response`; keep structured `IpcError` for failures and do not add base64 to `SpeechServiceDto` or `AppSettingsDto`.
- [ ] Add `cancel_speech_synthesis(requestId)` as a semantically scoped wrapper over the shared registry; cancellation is idempotent.
- [ ] Emit `data://speech-services-changed` after Speech CRUD. Emit `data://app-settings-changed` after default selection and after deleting the selected default; integration changes invalidate Speech readiness through the existing integration event.
- [ ] Test explicit/default selection, no default, disabled/missing service, stale/degraded integration, cancellation cleanup, deletion default cleanup, and raw response bytes.

**Validation:**

- Run: `mise run test speech_services -- --nocapture`
- Run: `mise run test speech_commands -- --nocapture`
- Expected: CRUD/default/cancellation behavior passes and command success is binary MP3 data rather than JSON/base64.

### Task 5: Add the OCR-style Speech management page

**Outcome:** The primary navigation exposes a Speech page whose add/list/editor/default interactions match OCR and offer only compatible Google Cloud instances.

**Files:**

- Create: all `src/features/speech/` management files and `src/routes/speech*` files from the File Map
- Modify: shell, root icon map, storage, Query/events, i18n, and generated route tree files from the File Map
- Test: `speechProviderOptions.test.ts` and event-binding tests

**Steps:**

- [ ] Add `Speech` between OCR and Integrations in the primary navigation using an installed Iconify speaker/record icon; extend `primaryNavItems` through the new Speech/Integrations indexes, move `settingsNavItem` to the new final index, and update nav-order transition tests if present.
- [ ] Mirror OCR route composition: `/speech` layout, `/speech/` empty state, and `/speech/$speechServiceId` editor; implementation/test files under route folders keep the `-` ignore prefix when applicable.
- [ ] Mirror `OcrLayout` rail dimensions, first-service navigation, loading/error/empty states, selected/disabled row styling, bottom Add button, and nested editor outlet.
- [ ] Add a header `Default Speech` selector backed by `defaultSpeechServiceId`; include a missing-reference fallback and disable it while no service exists.
- [ ] Build Add options from ready/enabled integration instances whose manifest exposes `speech.synthesize@1`; with Google Cloud as the only implementation, each compatible integration instance is one tile.
- [ ] Create with schema v1 defaults (`speakingRate = 1.0`, `pitch = 0.0`), then update the list cache and navigate to the new editor.
- [ ] Mirror the OCR editor shell for rename, enable, reset, save, optimistic conflict handling, confirm-delete, cache updates, and navigation after delete.
- [ ] Show only integration rebind/health, speaking rate, and pitch. Do not show project, credential, scope, endpoint, language, voice, encoding, sample rate, or audio storage fields.
- [ ] Use Base UI equivalents for dialog, select, `Field`, `NumberField`, switch, and confirm primitives. Configure controlled `NumberField.Root` values with named `min`, `max`, and `step`, give every control a visible accessible label, and keep Tailwind v4 canonical syntax plus existing frame/outline tokens.
- [ ] Add `speechKeys`; bind Speech and integration events so changes invalidate list/detail/readiness in every webview.
- [ ] Add English and Simplified Chinese copy with short labels; regenerate `src/routeTree.gen.ts` through the router plugin.

**Validation:**

- Run: `bun test src/features/speech/speechProviderOptions.test.ts src/query/dataChangeEventBindings.test.ts`
- Run: `mise run typecheck`
- Run: `mise run lint`
- Expected: compatible Google instances create editable Speech services, default selection persists, missing/degraded instances remain visible but fail closed, and OCR styling/behavior is preserved.

### Task 6: Add source/result playback to Translate

**Outcome:** Users can synthesize, play, stop, replace, and cancel source or translated text through the default Speech service.

**Files:**

- Create: `src/features/speech/speechPlaybackController.ts`
- Create: `src/features/speech/speechPlaybackController.test.ts`
- Create: `src/features/speech/useSpeechPlayback.ts`
- Create: `src/routes/translate/-speechLanguage.ts`
- Create: `src/routes/translate/-speechLanguage.test.ts`
- Modify: `src/storage/client.ts`, `src/storage/types.ts`
- Modify: `src/routes/translate/index.tsx`
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`

**Steps:**

- [ ] Add an Effect-backed storage client call for `synthesize_speech`; normalize Tauri’s binary `ArrayBuffer | Uint8Array` result to `Uint8Array` before returning it, and add the cancel client without logging text or args.
- [ ] Implement an injected, framework-independent playback controller with `idle | synthesizing | playing`, active target `source | output | null`, current request ID, one audio adapter, one URL adapter, and one Blob URL; wrap it with `useSpeechPlayback` for React mount/state cleanup.
- [ ] Before a new request, cancel the prior request, pause/reset the prior audio, revoke the prior URL, then synthesize; on unmount do the same cleanup.
- [ ] Create `Blob([bytes], { type: "audio/mpeg" })`, create an object URL, and call `audio.play()` only after the full response arrives; handle rejected autoplay/play promises as user-visible errors.
- [ ] Put pure language decisions in `-speechLanguage.ts`: source uses the selected concrete language or requests detection for `auto`; result resolves the same effective target used by translation from configured target plus profile primary/preferred settings and never infers language from generated text.
- [ ] If source is `auto`, reuse `detectedSourceLang`; if absent, run the existing detection flow, persist the successful result, then synthesize. A detection failure sends no TTS request.
- [ ] Add a source-pane volume control and activate the existing result-pane volume control. The active control becomes Stop while synthesizing/playing; the other remains available and replaces the active playback when clicked.
- [ ] Disable a control for blank text, unresolved language, or active translation text that is not yet stable; backend remains authoritative for missing/default/limit failures.
- [ ] Surface concise toast/error copy for no default, unsupported language, oversized text, permission/quota/network, cancellation, invalid audio, and playback rejection.
- [ ] Test manual language, auto detection reuse/new detection, target auto resolution, request replacement, explicit stop, cancellation race, stale completion suppression, Blob MIME, URL revocation, and unmount cleanup.

**Validation:**

- Run: `bun test src/features/speech/speechPlaybackController.test.ts src/routes/translate/-speechLanguage.test.ts`
- Run: `mise run typecheck`
- Expected: only the latest source/result request can play, every replaced request is cancelled, and object URLs/audio are always cleaned up.

### Task 7: Add configuration export v6

**Outcome:** Speech configuration and the default binding round-trip structurally without exporting text, audio, credentials, or vault references.

**Files:**

- Modify: backend import/export files from the File Map
- Modify: `src/features/settings/configurationTransfer.ts` and relevant frontend fixtures/tests

**Steps:**

- [ ] Advance export format to v6 and supported versions to `{2, 3, 4, 5, 6}`; add explicit `normalize_v5_to_v6` after the existing normalization chain.
- [ ] Add ordered `speechServices` with IDs, names, enabled/sort state, integration binding, capability ID, schema version, and validated preferences only.
- [ ] Include `appSettings.defaultSpeechServiceId`; merge/copy import remaps integration IDs, Speech service IDs, and the default reference after rows are written.
- [ ] Extend import preview/apply counts and validation; unresolved plugin/integration bindings remain visible and unavailable until corrected.
- [ ] Omit synthesis input, MP3 bytes, object URLs, credential bindings, service-account JSON, tokens, request IDs, and provider bodies; add secret/audio-field scanning assertions.
- [ ] Broadcast Speech/integration/settings invalidation after successful import.
- [ ] Add v5→v6 fixtures plus v2–v6 compatibility, merge/copy remap, missing credential, invalid preference, and missing-default tests.

**Validation:**

- Run: `mise run test import_export -- --nocapture`
- Run: `bun test src/features/settings/configurationTransfer.test.ts`
- Expected: versions 2–6 import, v6 Speech/default IDs remap correctly, and no secret/audio/request material appears in exports.

## Phase Validation

Run automated checks:

```bash
mise run format:check
mise run lint
mise run typecheck
mise run test-frontend
mise run test
mise run build
```

Expected: formatting, ESLint, TypeScript, Bun tests, Rust tests, and the production frontend build all pass; `src/routeTree.gen.ts` is regenerated rather than manually edited.

Run desktop smoke validation:

```bash
mise run tauri:dev
```

Expected:

1. Speech appears between OCR and Integrations and matches the OCR rail/editor frame.
2. Add shows one tile per compatible ready Google Cloud instance and creates a default-preference Speech service.
3. Default Speech selection persists after restart; deleting it clears the default.
4. Source playback works for manual languages and runs detection when source is Auto with no prior result.
5. Result playback uses the effective translated target language.
6. Starting source playback while result playback/request is active, or vice versa, cancels/stops/replaces it without stale audio.
7. MP3 is playable on Windows, macOS, and Linux WebViews; no temporary file remains.
8. Missing Text-to-Speech API/IAM returns a sanitized permission error without affecting Translate/Vision capability execution.
9. Export/import v6 restores Speech structure/default selection but contains no text, audio, credentials, refs, or tokens.

## Failure Behavior

- No default Speech service — do not call Google; show a configure/default-service error.
- Auto source language cannot be detected — do not call TTS; preserve the existing detection failure and playback remains idle.
- Text is empty or exceeds 5,000 UTF-8 bytes — reject locally; do not request a token or call Google.
- Language is unsupported — return `unsupported_language` before network.
- Speech service/integration is disabled, degraded, missing, or incompatible — keep it visible in configuration and fail closed at execution.
- Google Text-to-Speech API is disabled or IAM is missing — return sanitized `permission_denied`; Translation and Vision health remain independent.
- Quota/rate/network/timeout failure — stop loading, release the request session, keep prior text unchanged, and show normalized retry guidance.
- Provider returns missing/invalid/oversized audio — reject the whole response as `invalid_response`; never play partial bytes.
- A second playback starts — cancel synthesis or stop current playback, revoke its URL, and let only the newest request transition to playing.
- Component/window closes — cancel the request, pause audio, clear `src`, and revoke the Blob URL.
- Imported integration lacks credentials — Speech service remains configured but unavailable until the shared Google Cloud instance is reauthenticated.

## Privacy and Security

- Source/result text is sent only after explicit user playback action to the selected default Google Cloud integration endpoint.
- The Speech page and frontend DTOs never receive service-account JSON, access tokens, credential refs, OAuth endpoint choices, or raw provider bodies.
- The required broad `cloud-platform` OAuth scope is capability allow-listed only for `speech.synthesize@1`; cache keys remain instance + credential revision + normalized scope.
- Provider requests use the pinned `text_to_speech` origin, redirects remain disabled, and request/response/deadline limits are enforced by the host broker.
- Text, MP3 bytes, provider bodies, and Blob URLs are excluded from normal logs, events, history, configuration export, and diagnostics.
- MP3 exists only in Rust/webview memory for the active playback and is released on stop, replacement, error, or unmount.

## Rollout Notes

- Google Cloud users must enable the Text-to-Speech API and grant the service account permission before the capability succeeds.
- Adding the bundled capability must not mark existing Google Cloud instances globally ready for Speech; capability invocation remains the authoritative IAM check.
- Migration 0015 and export v6 are forward-only. Older app versions will not understand v6 exports; document this at export time using the existing version warning pattern.
- No feature flag or credential migration is required because Speech reuses existing integration instances and credential slots.

## Risks and Mitigations

- `cloud-platform` is broader than the scopes used by Translate/Vision — enforce exact capability/scope allow-list tests and pinned endpoint grants; do not share this grant with other handlers.
- Provider auto-selected voices can vary by availability/region — label the behavior as automatic and avoid promising a stable named voice in v1.
- MP3 size is not directly bounded by Google’s text quota — enforce both provider JSON and decoded-byte caps before IPC/playback.
- Browser audio lifecycle leaks can retain user-derived bytes — centralize ownership and test pause/reset/revoke behavior on every terminal transition.
- Source Auto playback adds a detection request — reuse existing detection state/workflow and never synthesize after a failed/stale detection.
- The Translate route is already large — keep audio/request lifecycle in `speechPlaybackController.ts`/`useSpeechPlayback.ts` and pure language decisions in `-speechLanguage.ts`; limit route changes to orchestration and controls.

## Open Questions

None. The Required Product Gate is locked for this phase; any named-voice, streaming, download/cache, or STT request requires a separate gate update and plan.

## References

### Local

- `docs/plans/google-service-integrations/README.md`
- `docs/plans/google-service-integrations/future-gates.md`
- `docs/plans/google-service-integrations/phase-3-google-cloud-vision-ocr.md`
- `docs/analysis/google-cloud-plugin-architecture.md`
- `src/features/ocr/OcrLayout.tsx`
- `src/features/ocr/AddOcrServiceDialog.tsx`
- `src/features/ocr/GoogleVisionOcrForm.tsx`
- `src/routes/translate/index.tsx`
- `src-tauri/src/domain/service_capability.rs`
- `src-tauri/src/services/google_cloud.rs`
- `src-tauri/src/services/service_integration_registry.rs`
- `.agents/skills/tauri-reference/references/development/commands.md`
- `.agents/skills/tauri-reference/references/development/channels.md`
- `.agents/skills/base-ui/references/react/components/number-field.md`
- `.agents/skills/base-ui/references/react/handbook/forms.md`

### External

- Google Cloud Text-to-Speech `text.synthesize`: https://cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize
- Google Cloud Text-to-Speech quotas and 5,000-byte content limit: https://cloud.google.com/text-to-speech/quotas
- Google Cloud Text-to-Speech `AudioConfig`: https://cloud.google.com/text-to-speech/docs/reference/rest/v1/AudioConfig
- Google Cloud Text-to-Speech `VoiceSelectionParams`: https://cloud.google.com/text-to-speech/docs/reference/rest/v1/VoiceSelectionParams
