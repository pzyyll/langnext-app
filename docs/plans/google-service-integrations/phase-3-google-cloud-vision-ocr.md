# Phase 3 Google Cloud Vision OCR Implementation Plan

**Goal:** Add Google Cloud Vision OCR as a typed capability that reuses an existing Google Cloud integration instance while preserving Baidu and AI OCR paths.

**Inputs:** Completed Phase 1C, the roadmap README, and explicit Phase 3 product decisions listed below.

**Assumptions:**

- Existing Baidu OCR remains on its native Rust implementation.
- Existing AI OCR remains on the frontend TypeScript model/prompt workflow.
- Google Vision executes in Rust through the integration token/network brokers.
- OCR engine kind is immutable after creation; a Vision service may rebind to another compatible Google Cloud instance.
- Import/export advances to v5 only because this phase includes OCR configuration portability.

**Architecture:** Migration 0014 extends OCR's domain discriminant with `plugin_capability`. Google Cloud registers `ocr.image@1` and a pinned Vision endpoint. OCR execution dispatches Baidu to the existing backend, AI to the existing frontend provider workflow, and plugin capability to the Rust registry.

**Tech Stack:** Rust Google Cloud capability infrastructure, Cloud Vision REST, existing OCR routes/services, React/Base UI, Tauri screenshot/OCR workflow.

---

## Required Product Gate

Lock these before implementation:

1. Initial operation set: `TEXT_DETECTION`, `DOCUMENT_TEXT_DETECTION`, or both.
2. Default operation.
3. Supported language-hint UI and maximum hint count.
4. Maximum image dimensions/encoded bytes and downscale policy.
5. Narrowest Google OAuth scope supporting Vision annotate.
6. Whether export v5 should include all existing Baidu/AI OCR configurations (recommended for consistency).

If these decisions are not locked, do not begin Phase 3 implementation.

## File Map

### Backend

- Create: `src-tauri/migrations/0014_ocr_service_integration_binding.sql` — OCR plugin engine binding.
- Modify: `src-tauri/src/storage/migrations.rs` — embed 0014.
- Modify: `src-tauri/src/domain/service_capability.rs` — typed OCR request/result/handler.
- Modify: `src-tauri/src/domain/ocr_service.rs` — `baidu | ai | plugin_capability` union.
- Modify: `src-tauri/src/repositories/ocr_services.rs` — plugin binding persistence.
- Modify: `src-tauri/src/services/service_integration_registry.rs` — Vision descriptor/grants.
- Modify: `src-tauri/src/services/google_cloud.rs` — Vision annotate implementation/parser.
- Modify: `src-tauri/src/services/service_capabilities.rs` — OCR handler dispatch.
- Modify: `src-tauri/src/services/ocr_services.rs` — Baidu/plugin backend dispatch and dependency rules.
- Modify: `src-tauri/src/cmds/ocr_services.rs` — updated DTO/recognize commands.
- Modify: `src-tauri/src/domain/import_export.rs` — export v5 OCR structures.
- Modify: `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/import_validation.rs` — OCR export/import/remap.
- Modify: `src-tauri/src/cmds/import_export.rs` — OCR/integration event broadcasts.
- Modify: state/error/module files as needed.

### Frontend

- Create: `src/features/ocr/GoogleVisionOcrForm.tsx` — instance + runtime preferences.
- Modify: `src/features/ocr/ocrProviderOptions.ts` — preserve static built-ins and add integration options through a separate resolver.
- Modify: `src/features/ocr/AddOcrServiceDialog.tsx` — dynamic Vision instances.
- Modify: `src/features/ocr/OcrServiceEditor.tsx` — plugin form branch.
- Modify: `src/features/ocr/OcrLayout.tsx` — status/provider labels.
- Modify: `src/features/ocr/recognizeOcrFlow.ts` and tests — three-way execution.
- Modify: screenshot OCR runner only if input transport changes.
- Modify: `src/storage/types.ts`, `src/storage/client.ts` — OCR union/IPC.
- Modify: Query integration event invalidation for OCR capability state.
- Modify: `src/features/settings/configurationTransfer.ts` and tests — v5.
- Modify: `src/routes/settings.tsx` — imported OCR/integration credential warnings.
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`.

## Tasks

### Task 1: Lock and document the Vision contract

**Outcome:** Implementation has explicit operation, hint, payload, scope, and portability decisions.

**Files:**

- Modify: this plan's Required Product Gate with resolved values before code starts
- Modify: roadmap README if capability/policy decisions change

**Steps:**

- [ ] Confirm supported operation enum and default.
- [ ] Confirm language-hint source, maximum count, normalization, and behavior for unsupported hints.
- [ ] Name max encoded bytes, decoded dimensions/pixels, and optional downscale constants.
- [ ] Confirm REST endpoint/method and narrow OAuth scope from current Google documentation.
- [ ] Confirm v5 export includes all OCR service structures and omits all OCR/integration secrets.
- [ ] Confirm Vision results return plain text only in this phase; blocks/layout/confidence are out of scope unless explicitly required.

**Validation:**

- Run: documentation review against current Google Vision docs.
- Expected: no unresolved gate remains.

### Task 2: Add migration 0014 and OCR engine union

**Outcome:** Existing OCR rows remain unchanged while plugin-backed OCR services can reference integration instances.

**Files:**

- Create: `src-tauri/migrations/0014_ocr_service_integration_binding.sql`
- Modify: migration runner/tests and OCR domain

**Steps:**

- [ ] Extend/rebuild OCR storage with plugin capability instance ID, capability ID, preferences JSON, and schema version.
- [ ] Backfill Baidu rows as `baidu` and AI rows as `ai` without changing keys/model IDs/templates/sort/timestamps.
- [ ] Add `ON DELETE RESTRICT` FK to `integration_instances` for plugin rows.
- [ ] Preserve existing Baidu and AI SQL/service invariants.
- [ ] Define tagged Rust/TS OCR union for Baidu, AI model, and plugin capability.
- [ ] Make engine kind immutable after create.
- [ ] Allow compatible plugin-instance rebind.
- [ ] Add fresh and v13→v14 migration tests using realistic 0010 OCR data.

**Validation:**

- Run: `mise run test migrate_ -- --nocapture`
- Run: `mise run test ocr_service -- --nocapture`
- Expected: all legacy OCR data remains valid and plugin rows enforce FKs/branch invariants.

### Task 3: Add typed OCR capability and Vision registration

**Outcome:** Google Cloud definition advertises `ocr.image@1` with least-privilege grants.

**Files:**

- Modify: service capability domain, registry, token-grant scope policy
- Test: registry/contract tests

**Steps:**

- [ ] Define bounded `OcrImageRequest`, `OcrImagePreferences`, and `OcrImageResponse`.
- [ ] Define `OcrImageCapability` and add `OcrImage` to the handler enum.
- [ ] Keep image request binary/base64 representation compatible with current IPC for this phase, but enforce the locked size/pixel limits before provider execution.
- [ ] Register `ocr.image@1` on `com.langnext.google-cloud` and pin the Vision endpoint alias.
- [ ] Add the narrow Vision scope to allowed TokenGrant scope sets without broadening Translate grants; test that a Translate-only grant cannot call the Vision endpoint alias.
- [ ] Increment bundled plugin semantic/config version as required; preserve existing instances through compatible manifest evolution.
- [ ] Verify capabilities remain independently healthy because IAM can differ.

**Validation:**

- Run: `mise run test service_capability -- --nocapture`
- Run: `mise run test service_integration_registry -- --nocapture`
- Expected: Vision handler/scope/endpoint are registered without affecting Translate/Detect grants.

### Task 4: Implement Google Vision annotate

**Outcome:** The Rust handler recognizes text from bounded PNG input through the shared Cloud credential.

**Files:**

- Modify: `src-tauri/src/services/google_cloud.rs`
- Test: golden Vision fixtures and fake broker

**Steps:**

- [ ] Validate/decode PNG and enforce encoded/decoded limits before constructing provider JSON.
- [ ] Build the locked Vision REST annotate request using the selected operation and normalized language hints.
- [ ] Execute only through the pinned Vision endpoint and OCR TokenGrant scope.
- [ ] Parse full text annotation (or the locked field) into plain text.
- [ ] Handle provider per-image errors even when the HTTP status is successful.
- [ ] Map auth/permission/quota/rate/network/timeout/invalid response to stable capability errors.
- [ ] Exclude image content and raw provider body from logs/errors.
- [ ] Test valid response, no text, per-image error, malformed payload, oversized image, invalid PNG, hints, cancellation, and IAM failures.

**Validation:**

- Run: `mise run test google_cloud_vision -- --nocapture`
- Expected: request/parser/error/security tests pass without live Google access.

### Task 5: Preserve OCR's three execution paths

**Outcome:** Baidu, AI model, and plugin OCR each use their existing/correct runtime.

**Files:**

- Modify: OCR repository/service/command and frontend flow/tests

**Steps:**

- [ ] Persist/list/get/save plugin OCR bindings with common display/enabled/sort fields and plugin preferences.
- [ ] Validate ready/enabled compatible integration instance on save and execution.
- [ ] Extend integration dependencies with OCR service id/name.
- [ ] Backend `recognize_ocr` dispatches Baidu to the existing implementation and plugin capability to the registry.
- [ ] AI OCR remains in `recognizeOcrFlow.ts` through the existing TS ProviderPlugin/model/prompt path.
- [ ] Do not claim Baidu uses network-broker safeguards unless separately migrated.
- [ ] Preserve app default OCR selection and screenshot handoff.
- [ ] Test all three branches, stale/disabled integration, rebind, dependency deletion, and cancellation.

**Validation:**

- Run: `mise run test ocr_services -- --nocapture`
- Run: `bun test src/features/ocr/recognizeOcrFlow.test.ts`
- Expected: three-way dispatch and existing Baidu/AI tests pass.

### Task 6: Add Vision OCR creation/editor UX

**Outcome:** OCR Add dialog discovers ready Google Cloud instances and its editor stores only OCR preferences.

**Files:**

- Create/modify: OCR frontend files listed above
- Modify: i18n/storage/query types

**Steps:**

- [ ] Keep Baidu and AI options available exactly as today.
- [ ] Dynamically list ready integration instances implementing `ocr.image@1`.
- [ ] Label each instance distinctly and disable degraded/unconfigured/plugin-missing instances with `/plugins` action.
- [ ] Vision editor shows selected integration, operation, language hints, enabled state, and capability health only.
- [ ] Do not show/edit project, location, service-account, token, or endpoint on the OCR page.
- [ ] Allow compatible integration rebind.
- [ ] Follow Base UI primitives and route-file conventions.
- [ ] Invalidate OCR Query when referenced integration status changes.

**Validation:**

- Run: `mise run typecheck`
- Run: `mise run lint`
- Run: targeted OCR frontend tests
- Expected: Add/editor UX works without affecting Baidu/AI configuration.

### Task 7: Add export format v5 with OCR structures

**Outcome:** All OCR configurations round-trip structurally while every secret is omitted.

**Files:**

- Modify: import/export backend/frontend files and tests

**Steps:**

- [ ] Advance export format to v5 and extend the explicit supported-version set to `{2, 3, 4, 5}`.
- [ ] Keep raw-value/version-first parsing from Phase 1C; add `normalize_v4_to_v5` after the existing v2→v3→v4 chain.
- [ ] Define v5 additions explicitly: ordered OCR service records, AI OCR prompt templates, plugin OCR bindings/preferences, and `appSettings.defaultOcrServiceId` remapping metadata.
- [ ] Export OCR services and AI OCR prompt templates in deterministic order.
- [ ] Omit Baidu API/secret refs, integration credential bindings, secrets, tokens, and provider bodies.
- [ ] Merge/copy remap AI model IDs, plugin integration IDs, OCR service IDs, prompt template IDs, and app default OCR ID.
- [ ] Imported Baidu/Google Cloud-dependent services report required re-authentication through their owning configurations.
- [ ] Preserve unresolved plugin/model bindings visibly and fail closed.
- [ ] Broadcast OCR/integration/settings invalidation events after successful import.
- [ ] Add v2–v5 fixtures and secret-scanning tests.

**Validation:**

- Run: `mise run test import_export -- --nocapture`
- Run: `bun test src/features/settings/configurationTransfer.test.ts`
- Expected: all supported versions import and v5 contains no secret/ref material.

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

1. One Google Cloud instance is selectable by both Translation Profile and Vision OCR.
2. Vision OCR works through screenshot/selected-image flow.
3. Baidu and AI OCR behavior is unchanged.
4. Missing Vision IAM affects OCR health without disabling Translation unnecessarily.
5. Referenced integration cannot be deleted until Profile/OCR dependencies are reassigned.
6. Export/import v5 omits all secrets and restores structural bindings.

## Failure Behavior

- Authentication succeeds but Vision IAM is missing — OCR returns `permission_denied`; Translation capability health remains independent.
- Image exceeds limits — reject locally with `unsupported_input`, no network call.
- No recognized text — return successful empty/plain result according to locked product behavior.
- Integration disabled/missing — OCR service remains visible and fails closed.
- Import lacks credential — service remains configured but unavailable until the shared integration is reauthenticated.

## Privacy and Security

- Images are sent only to the selected Google Cloud instance endpoint.
- OCR page never receives Cloud credentials.
- Image bytes and provider response bodies are excluded from logs/errors/export.
- Vision and Translation token grants use capability-scoped permissions/cache keys.

## Open Questions

All items in Required Product Gate must be resolved before implementation.
