# Phase 1C Plugin Profile Runtime and UX Implementation Plan

**Goal:** Make Google Cloud Translation available through Translation Profiles, Translate, and Quick Translate while preserving existing LLM behavior.

**Inputs:** Completed Phases 1A–1B and the roadmap README.

**Assumptions:**

- Google Cloud Profile execution is unary/non-streaming.
- Existing LLM Profiles retain ordered fallback, prompts, streaming, temperature, output-token settings, and LLM language detection.
- Profile engine kind is immutable after creation.
- Plugin Profiles may rebind to another ready instance implementing compatible capability IDs.
- Export format advances from v3 to v4; v2/v3 imports remain supported.

**Architecture:** Migration 0013 introduces an engine discriminant. The frontend discovery layer explicitly combines the built-in LLM Profile option with ready Rust integration instances. LLM execution stays in the existing TypeScript provider workflow; plugin Profile execution calls Rust, which reloads and validates the authoritative Profile/instance/capability before execution.

**Tech Stack:** Rust Profile/import services, Tauri IPC/cancellation, React, TanStack Query/Router, existing translation workflows, Bun/Rust tests.

---

## File Map

### Backend

- Create: `src-tauri/migrations/0013_translation_profile_engines.sql` — engine discriminant and integration binding.
- Create: `src-tauri/src/cmds/service_translation.rs` — plugin Profile Translate/Detect IPC.
- Modify: `src-tauri/src/storage/migrations.rs` — embed 0013.
- Modify: `src-tauri/src/domain/translation_profile.rs` — engine union and writes.
- Modify: `src-tauri/src/repositories/translation_profiles.rs` — branch persistence.
- Modify: `src-tauri/src/services/translation_profiles.rs` — branch validation/immutability/dependencies.
- Modify: `src-tauri/src/cmds/translation_profiles.rs` — updated DTO/event behavior.
- Modify: `src-tauri/src/domain/import_export.rs` — export v4 types/counts/auth requirements.
- Modify: `src-tauri/src/services/import_export.rs` — v4 export/import.
- Modify: `src-tauri/src/services/import_validation.rs` — v2/v3 normalization and v4 validation/remapping.
- Modify: `src-tauri/src/cmds/import_export.rs` — integration/profile invalidation events.
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, module exports.
- Modify: `src-tauri/src/services/models.rs` / provider dependency cleanup paths only where Profile targets are assumed to be universal.

### Frontend

- Create: `src/features/translate/AddTranslationProfileDialog.tsx` — LLM/integration chooser.
- Create: `src/features/translate/translationEngineOptions.ts` — dual-catalog merge.
- Create: `src/features/translate/translationEngineOptions.test.ts` — ordering/filtering/status tests.
- Modify: `src/storage/types.ts`, `src/storage/client.ts` — engine DTO/write and runtime IPC.
- Modify: `src/query/options.ts` — Profile + integration option composition inputs.
- Modify: `src/routes/translate/profiles.tsx` — engine-specific drafts/forms.
- Modify: `src/features/translate/translationContext.ts` — LLM vs service context.
- Modify: `src/features/translate/translationWorkflow.ts` and tests — unary service branch.
- Modify: `src/features/translate/detectLanguageFlow.ts` and tests — service detect branch.
- Modify: `src/features/translate/runTranslate.ts` — Promise runners.
- Modify: `src/features/translate/translateStream.ts` and tests if session bridge changes.
- Modify: `src/features/translate/slotBatch.ts` and tests if input/model assumptions change.
- Modify: `src/routes/translate/index.tsx` — main page Profile behavior.
- Modify: `src/routes/quick-translate.tsx` — plugin Profile availability/prompt behavior.
- Modify: `src/features/models/ProviderEditor.tsx` — LLM-only Profile dependency assumptions.
- Modify: `src/features/settings/configurationTransfer.ts` and tests — v4 document handling.
- Modify: `src/routes/settings.tsx` — imported integration credential warning/invalidation.
- Modify: Query event listeners/sync as required by import broadcasts.
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`.

## Tasks

### Task 1: Add migration 0013 and engine domain types

**Outcome:** Existing Profiles are explicitly LLM Profiles; new plugin-capability Profiles can exist without models/prompts.

**Files:**

- Create: `src-tauri/migrations/0013_translation_profile_engines.sql`
- Modify: migration runner/tests and `src-tauri/src/domain/translation_profile.rs`

**Steps:**

- [x] Rebuild `translation_profiles` with `engine_kind TEXT NOT NULL CHECK (engine_kind IN ('llm_model_chain','plugin_capability'))`; make LLM-only `template_version`, `default_prompt_template_id`, `temperature`, and `max_output_tokens` nullable; add nullable integration/capability/preference fields.
- [x] Add an OCR-style branch CHECK:
  - `llm_model_chain`: `template_version` and `default_prompt_template_id` are non-null; all integration/capability/preference fields are NULL; existing optional LLM fields retain their current validation.
  - `plugin_capability`: `template_version`, `default_prompt_template_id`, `temperature`, `max_output_tokens`, `provider_options_json`, and `language_detection_json` are NULL; `integration_instance_id` and Translate capability are non-null; Detect capability is nullable; preferences JSON/version are non-null.
- [x] Backfill every existing row as `llm_model_chain` without changing targets, prompt-template rows, timestamps, language settings, or existing LLM parameters.
- [x] Add FK from plugin Profile to `integration_instances` with `ON DELETE RESTRICT`.
- [x] Keep target/template child tables, but service validation must require ≥1 target/template for LLM and exactly zero target/template rows for plugin Profiles.
- [x] Add parent-engine guards/triggers only if repository/service encapsulation cannot prevent invalid child inserts; document whichever enforcement is chosen.
- [x] Define a tagged Rust/TypeScript Profile engine union in the same task:
  - `LlmModelChain` owns existing targets/templates/default template/temperature/tokens/language detection.
  - `PluginCapability` owns integration instance/capability/detect capability/preferences.
- [x] Keep common Profile name/enabled/source/target/primary/preferred-target fields outside the engine union.
- [x] Add fresh and v12→v13 migration tests proving byte-equivalent relevant legacy values.

**Validation:**

- Run: `mise run test migrate_ -- --nocapture`
- Run: `mise run test translation_profile -- --nocapture`
- Expected: legacy Profiles remain LLM and plugin rows satisfy branch constraints.

### Task 2: Update Profile repository/service validation

**Outcome:** Profile CRUD is engine-aware and prevents invalid cross-engine fields or type changes.

**Files:**

- Modify: Profile repository/service/command files
- Modify: model/provider dependency cleanup where needed
- Test: Profile service/repository tests

**Steps:**

- [x] Read/write both engine variants without N+1 queries.
- [x] LLM validation retains current model existence/uniqueness, prompt-template, temperature/token, and detector rules.
- [x] Plugin validation requires a ready/enabled instance and exact compatible Translate capability; detect capability is optional but must belong to the same instance/plugin.
- [x] Lock Google Translate capability preferences schema v1 to exactly `{}`; common Profile language fields carry source/target preferences and unknown preference keys are rejected.
- [x] Plugin Profile requires no model target, prompt template, default template, temperature, max tokens, or LLM detector.
- [x] Reject engine-kind changes on update.
- [x] Allow rebind only to another ready instance with compatible capability major versions.
- [x] Extend integration dependency lookup with Profile id/name.
- [x] Keep model/provider deletion logic scoped to LLM Profile targets.
- [x] Expose plugin-missing/unconfigured/disabled Profile states without mutating persisted bindings.

**Validation:**

- Run: `mise run test translation_profiles -- --nocapture`
- Expected: both branches save/read; cross-engine writes/type changes fail; dependencies are correct.

### Task 3: Add export format v4 and import compatibility

**Outcome:** Integration structures and plugin-backed Profiles round-trip without secrets; v2/v3 remain importable.

**Files:**

- Modify: import/export domain/service/validation/command files
- Modify: frontend configuration transfer types/tests

**Steps:**

- [x] Replace the single `PREVIOUS_EXPORT_FORMAT_VERSION` model with an explicit supported-version set `{2, 3, 4}` and sequential normalizers.
- [x] Change preview/import IPC to accept an untrusted raw `serde_json::Value` (frontend structural envelope with `formatVersion`) rather than deserializing directly into the current `ConfigurationExport` shape.
- [x] Parse/validate `formatVersion` first, then deserialize the matching versioned document struct.
- [x] Implement `normalize_v2_to_v3` followed by `normalize_v3_to_v4`; all downstream validation/import consumes only normalized v4.
- [x] Define v4 fields explicitly: current provider/model/settings data, sanitized `integrationInstances`, engine-tagged translation profiles, LLM target/template arrays, and no credential bindings/secrets.
- [x] Export sanitized integration instances, non-secret config, and both Profile engine variants.
- [x] Omit integration credential binding rows, refs, revisions if sensitive, journal data, service-account JSON, tokens, and validation provider bodies.
- [x] Merge mode updates structural integration config but leaves imported integration credentials empty/re-auth-required.
- [x] Copy mode assigns new integration/Profile IDs and rewrites all internal plugin binding references.
- [x] Preserve missing plugin definitions as `plugin_missing` instances and visible non-executable Profiles.
- [x] Extend import preview counts and authentication requirements for integration instances.
- [x] Broadcast integration + Profile change events after successful import.
- [x] Add secret-scanning assertions over serialized export JSON.

**Validation:**

- Run: `mise run test import_export -- --nocapture`
- Run: `bun test src/features/settings/configurationTransfer.test.ts`
- Expected: v2/v3/v4 merge/copy tests pass and exports contain no secret/ref material.

### Task 4: Add dual-catalog Profile creation options

**Outcome:** New Profile shows LLM plus each ready Translate-capable integration instance without changing the TS Provider registry.

**Files:**

- Create: `src/features/translate/AddTranslationProfileDialog.tsx`
- Create: `src/features/translate/translationEngineOptions.ts` and test
- Modify: storage/query types/options and Profile route

**Steps:**

- [x] Build one explicit built-in LLM option from existing enabled model availability.
- [x] Build integration options from Rust definition/instance DTOs implementing `translate.text@1`.
- [x] Label instances distinctly, e.g. `Google Cloud — Work`.
- [x] Show disabled/unconfigured/degraded/plugin-missing options disabled with a direct `/plugins` configuration hint.
- [x] Preserve deterministic option ordering and stable IDs.
- [x] Selecting LLM creates the current LLM draft/default prompt behavior.
- [x] Selecting an integration creates a plugin draft bound to its Translate/Detect capabilities.
- [x] Replace existing direct New Profile creation buttons with the dialog.
- [x] Do not register Google in `src/features/providers/registry.ts` or invent a provider model.

**Validation:**

- Run: `bun test src/features/translate/translationEngineOptions.test.ts`
- Run: `mise run typecheck`
- Expected: option merge/filter/order tests and types pass.

### Task 5: Add engine-specific Profile editor UX

**Outcome:** LLM Profiles keep their current editor; plugin Profiles show only common languages and integration binding/preferences.

**Files:**

- Modify: `src/routes/translate/profiles.tsx`
- Optional Create: focused plugin Profile form under `src/features/translate/` if route size warrants extraction
- Modify: i18n

**Steps:**

- [x] Extend local draft conversion/dirty detection/save payloads for both engine variants.
- [x] Preserve existing LLM model chain, fallback, prompt templates, detector model, temperature, and token UX unchanged.
- [x] Plugin editor shows instance, Translate capability, Detect capability availability, execution status, and capability-specific preferences only.
- [x] Hide model/prompt/LLM detector controls for plugin Profiles.
- [x] Allow compatible integration-instance rebind with explicit confirmation if execution behavior changes.
- [x] Profile rail renders integration/capability labels instead of “missing model.”
- [x] Use integration Query data directly; do not copy authoritative lists into local state.
- [x] Keep route files thin by extracting helpers/forms when needed.

**Validation:**

- Run: `mise run typecheck`
- Run: `mise run lint`
- Manual: create/edit/reload one LLM and one Google Cloud Profile; verify no hidden branch data appears.

### Task 6: Add authoritative plugin Profile Translate/Detect IPC

**Outcome:** Rust executes a plugin Profile only after reloading and validating its persisted binding.

**Files:**

- Create: `src-tauri/src/cmds/service_translation.rs`
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, module exports
- Modify: storage client/types
- Test: service translation tests with fake capability handlers

**Steps:**

- [x] Add `translate_service_profile` input with request ID, Profile ID, source text, app source language, and app target language.
- [x] Add `detect_service_profile_language` input with request ID, Profile ID, and text.
- [x] Never accept plugin ID, endpoint, credential, project, model, or capability override from the frontend.
- [x] Reload Profile, instance, and registered handler from SQLite/registry.
- [x] Validate enabled/readiness/config/capability compatibility immediately before execution.
- [x] Register request ID in the existing request-session registry and propagate cancellation/deadline through token/network brokers.
- [x] Return existing translate/detect result shapes where practical, with `modelId = null` and a service-integration detector type.
- [x] Normalize capability errors to stable IPC/soft failure shapes without provider bodies.
- [x] Add tests for stale frontend DTO, disabled instance, missing plugin, cancellation, timeout, and success.

**Validation:**

- Run: `mise run test service_translation -- --nocapture`
- Expected: authoritative reload and failure cases pass.

### Task 7: Branch frontend translation/detection workflows

**Outcome:** LLM execution remains unchanged; plugin execution uses unary Rust commands and existing session callbacks.

**Files:**

- Modify: translation context/workflow/detect/run/stream/slot files and tests

**Steps:**

- [x] Resolve translation context as `llm` or `service_integration`.
- [x] Keep LLM attempt/fallback/plugin logic byte-for-byte scoped where possible.
- [x] Service branch calls the new Promise runner once; it must short-circuit before prompt/model resolution and must never call `requireProviderPlugin`.
- [x] For stream-facing callers, emit `onReset` then one terminal `onDone`/`onError`; do not fabricate incremental chunks.
- [x] Source auto detection calls the Profile's service Detect capability where registered.
- [x] Make model ID nullable only where service results require it; retain model requirements in LLM contexts.
- [x] Preserve slot request IDs, epoch guards, cancellation, and terminal-result isolation.
- [x] Record history once: `modelId = null`, safe capability label as model display, integration instance name as provider display.
- [x] Do not record cancelled execution, matching current policy.
- [x] Add service success/error/cancel tests, including an assertion that plugin Profiles never call `requireProviderPlugin`, while retaining all existing LLM fallback/stream tests.

**Validation:**

- Run: `bun test src/features/translate/translationWorkflow.test.ts src/features/translate/detectLanguageFlow.test.ts src/features/translate/translateStream.test.ts src/features/translate/slotBatch.test.ts`
- Expected: new service branch and all existing LLM behavior pass.

### Task 8: Update Translate and Quick Translate UI behavior

**Outcome:** Plugin Profiles are selectable and executable in both translation surfaces without model/prompt assumptions.

**Files:**

- Modify: `src/routes/translate/index.tsx`
- Modify: `src/routes/quick-translate.tsx`
- Modify: related session/preferences tests as needed

**Steps:**

- [x] Determine Profile availability by engine-specific rules rather than primary-model presence.
- [x] Hide/disable prompt-template selection for plugin Profile cards and sessions.
- [x] Do not overwrite workspace model selection when a plugin Profile is selected.
- [x] Restore existing model/prompt behavior when switching back to LLM/no Profile.
- [x] Preserve source/target language preferences and auto-target logic.
- [x] Show non-streaming progress/cancel state through existing session controls.
- [x] Surface unconfigured/disabled/plugin-missing errors with a `/plugins` action where appropriate.
- [x] Preserve existing selected-context/UI work in `quick-translate.tsx`; inspect local changes before editing.

**Validation:**

- Run: `mise run typecheck`
- Run: `mise run lint`
- Run: `mise run test-frontend`
- Manual: execute LLM and Google Cloud Profiles in main/Quick Translate, switch between them, cancel, and retry.

### Task 9: Complete cross-window/import/security acceptance

**Outcome:** Phase 1 is releasable as one vertical Google Cloud Translation feature.

**Files:**

- Modify: settings import UI/workflow, Query invalidation, event tests, security tests

**Steps:**

- [x] Invalidate integration and Profile Query prefixes after import/mutation events in every webview.
- [x] Show imported integration instances requiring credentials without exposing missing-secret details.
- [x] Verify referenced integration deletion returns `in_use` from Profile and plugin pages.
- [x] Test crash recovery for prepared and DB-committed integration credential operations.
- [x] Test token-cache eviction after credential revision changes.
- [x] Scan export/event/error/log test fixtures for secret/ref fields.
- [x] Add history/UI coverage proving service completions with `modelId = null` render safely.
- [x] Re-run existing Provider, model, LLM Profile, Baidu OCR, and AI OCR suites unchanged.

**Validation:**

- Run: full Phase Validation below.
- Expected: all automated and manual acceptance checks pass.

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

1. Configure a Google Cloud instance once under `/plugins`.
2. Create a Google Cloud Profile without selecting an LLM model.
3. Translate/detect in main and Quick Translate.
4. LLM Profiles still stream and fall back exactly as before.
5. Export contains structure but no credentials; import requires credential re-entry.
6. Referenced Cloud instance cannot be deleted.
7. Multiple windows converge through Query invalidation.

## Failure Behavior

- Integration becomes disabled/unconfigured after Profile creation — Profile remains visible and fails closed with configuration action.
- Missing plugin code — binding remains visible as unavailable.
- Detect capability unavailable — source auto fails clearly; explicit source translation may still run if Translate capability is ready.
- Unary Google call returns after slot changed — epoch/session guard discards stale result.
- Import references missing integration/plugin — retain visible unresolved binding; do not silently convert to LLM.

## Privacy and Security

- Runtime IPC identifies the Profile, not provider endpoints or credentials.
- Rust re-resolves every binding before execution.
- Export/import never carries secrets.
- Translation content is sent only to the selected integration endpoint and excluded from logs/history errors.

## Open Questions

None blocking once Phase 1B confirms the v3beta1 OAuth scope.
