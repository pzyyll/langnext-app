# Phase 1: Schema-Driven Plugin Control Plane Implementation Plan

**Goal:** Remove plugin-ID branches from shared Rust validation and React editors while keeping all execution on existing bundled Rust and legacy frontend implementations.

**Inputs:** Phase 0 contracts and current service-integration/provider architecture.

**Assumptions:**

- Phase 0 is complete.
- External package installation and Wasm execution remain disabled.
- Plugin-specific protocol code may remain inside plugin implementation modules.

**Architecture:** Each bundled plugin registers one atomic definition containing manifest, schemas, config adapter, credential validators, capability preference adapters, handlers, endpoint policy, and auth-policy bindings. Shared services and frontend editors consume only this registration metadata.

**Tech Stack:** Rust trait objects/serde, existing integration registries, React 19, Base UI, TanStack Query, Bun tests.

---

## Dependencies

- Phase 0 complete and validated.

## File Map

- Create: `src-tauri/src/services/bundled_plugins.rs` — atomic bundled registration list and adapters.
- Create: `src/features/plugins/schema/SchemaForm.tsx` — host-owned Base UI form renderer.
- Create: `src/features/plugins/schema/SchemaField.tsx` — field dispatch and accessibility.
- Create: `src/features/plugins/schema/schemaDraft.ts` — config/preference draft projection and writes.
- Create: `src/features/plugins/schema/schemaDraft.test.ts` — defaults, dirty state, and credential actions.
- Create: `src/features/plugins/schema/schemaVisibility.ts` — `visibleWhen` evaluation.
- Create: `src/features/plugins/schema/schemaVisibility.test.ts` — visibility coverage.
- Create: `src/features/plugins/pluginPresentation.ts` — localized fallback labels and closed icon mapping.
- Modify: `src-tauri/src/services/service_integration_registry.rs` — store atomic registrations instead of metadata only.
- Modify: `src-tauri/src/services/service_capabilities.rs` — register handlers from atomic registrations.
- Modify: `src-tauri/src/services/service_integrations.rs` — generic schema/config/credential validation.
- Modify: `src-tauri/src/services/network_broker.rs` — generic effective grant and endpoint policy.
- Create: `src-tauri/src/services/auth_policies.rs` — host-owned auth-policy registry/drivers.
- Modify: `src-tauri/src/services/token_grant.rs` — token cache/grant integration with auth policies.
- Modify: `src-tauri/src/services/bounded_http.rs` — internal bounded byte response.
- Modify: `src-tauri/src/state.rs` — compose registrations once.
- Modify: `src/features/plugins/IntegrationEditor.tsx`, `src/features/plugins/integrationDraft.ts`, `src/features/plugins/AddIntegrationDialog.tsx`, `src/features/plugins/PluginsLayout.tsx` — schema-driven instance UX.
- Modify: `src/features/translate/translationEngineOptions.ts`, `src/routes/translate/profiles.tsx` — metadata-driven labels/preferences.
- Modify: `src/features/ocr/OcrServiceEditor.tsx`, `src/features/ocr/AddOcrServiceDialog.tsx`, `src/features/ocr/ocrProviderOptions.ts` — generic preference schemas.
- Modify: `src/features/speech/SpeechServiceEditor.tsx`, `src/features/speech/AddSpeechServiceDialog.tsx`, `src/features/speech/speechProviderOptions.ts` — generic preference schemas.
- Modify: `src/storage/types.ts`, `src/storage/client.ts`, `src/query/options.ts` — sanitized schema/presentation DTOs.
- Delete after cutover: plugin-specific integration and capability preference forms replaced by schema rendering.

## Tasks

### Task 1: Register bundled plugins atomically

**Outcome:** A definition cannot declare capabilities without matching schemas, policies, and handlers.

**Files:**

- Create: `src-tauri/src/services/bundled_plugins.rs`
- Modify: `src-tauri/src/services/service_integration_registry.rs`, `src-tauri/src/services/service_capabilities.rs`, `src-tauri/src/state.rs`, `src-tauri/src/services/mod.rs`
- Test: inline tests in `src-tauri/src/services/service_integration_registry.rs` and `src-tauri/src/services/bundled_plugins.rs`

**Steps:**

- [ ] Define `BundledPluginRegistration`, `PluginConfigAdapter`, `CapabilityPreferencesAdapter`, endpoint policy, auth-policy bindings, and typed handlers.
- [ ] Register Google Cloud, Google Translate Web, and Edge TTS through one deterministic registration list.
- [ ] Validate duplicate plugin/capability/slot/schema/policy IDs and require every declared capability to have a matching handler and preference schema.
- [ ] Remove `with_google_cloud`, `with_google_translate_web`, and `with_edge_tts` builders.
- [ ] Keep concrete implementation construction inside each registration factory rather than `AppState`.

**Validation:**

- Run: `mise run test service_integration_registry -- --nocapture`
- Expected: complete registrations pass; partial or mismatched registrations fail during startup/test construction.

### Task 2: Move authoritative config and preference validation behind adapters

**Outcome:** Shared services no longer branch on Google/Edge plugin IDs.

**Files:**

- Modify: `src-tauri/src/services/service_integrations.rs`, `src-tauri/src/services/translation_profiles.rs`, `src-tauri/src/services/ocr_services.rs`, `src-tauri/src/services/speech_services.rs`
- Modify: `src-tauri/src/services/google_cloud.rs`, `src-tauri/src/services/google_translate_web.rs`, `src-tauri/src/services/edge_tts.rs`
- Test: inline adapter tests plus `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] Add equivalent config schemas for Google Cloud, Google Web, and Edge TTS.
- [ ] Add preference schemas for Google Vision OCR, Google Cloud TTS, and Edge TTS.
- [ ] Validate unknown keys, defaults, completeness, schema versions, and preference bounds through the registration adapter.
- [ ] Keep service-account shape checks in the Google Cloud credential validator and preserve host-owned slot storage.
- [ ] Derive local health from schema readiness and required slot state; remove zero-secret plugin-ID checks.
- [ ] Preserve optimistic concurrency and all existing DTO/error behavior.

**Validation:**

- Run: `mise run test service_integrations -- --nocapture`
- Run: `mise run test ocr_service -- --nocapture`
- Run: `mise run test speech_service -- --nocapture`
- Expected: existing Cloud/Web/Edge create/edit/health/binding tests pass through generic dispatch.

### Task 3: Generalize broker and auth policy inputs

**Outcome:** Shared broker code consumes approved policy/grant data and supports bounded bytes without parsing a concrete plugin config.

**Files:**

- Create: `src-tauri/src/services/auth_policies.rs`
- Modify: `src-tauri/src/services/network_broker.rs`, `src-tauri/src/services/token_grant.rs`, `src-tauri/src/services/bounded_http.rs`
- Modify: `src-tauri/src/services/google_cloud.rs`, `src-tauri/src/services/google_translate_web.rs`, `src-tauri/src/services/edge_tts.rs`
- Test: inline tests in those service modules

**Steps:**

- [ ] Replace `GoogleCloudConfigV1` parsing in `NetworkBroker` with a normalized host-owned effective network grant.
- [ ] Add an auth-policy registry keyed by host-defined IDs; keep Google audience/scope/token endpoints inside its driver.
- [ ] Make bounded transport return internal bytes; preserve existing provider HTTP UTF-8 DTO behavior through an adapter.
- [ ] Route Edge TTS through the broker using an approved HTTPS origin and bounded binary response.
- [ ] Apply final-destination, method, path, redirect, private/link-local/loopback, proxy, header/query, timeout, cancellation, and size checks consistently.
- [ ] Ensure the broker validates the execution principal, current grant-set revision, and exact capability authority entry before credential/token access.

**Validation:**

- Run: `mise run test network_broker -- --nocapture`
- Run: `mise run test token_grant -- --nocapture`
- Run: `mise run test edge_tts -- --nocapture`
- Expected: all requests are brokered; unauthorized origins, methods, auth, redirects, and private destinations fail before transport.

### Task 4: Build the Base UI schema renderer

**Outcome:** Valid manifests render accessible configuration and preference forms without dedicated React components.

**Files:**

- Create: `src/features/plugins/schema/SchemaForm.tsx`, `src/features/plugins/schema/SchemaField.tsx`, `src/features/plugins/schema/schemaDraft.ts`, `src/features/plugins/schema/schemaDraft.test.ts`, `src/features/plugins/schema/schemaVisibility.ts`, `src/features/plugins/schema/schemaVisibility.test.ts`
- Create: `src/features/plugins/pluginPresentation.ts`, `src/features/plugins/pluginPresentation.test.ts`
- Modify: `src/storage/types.ts`

**Steps:**

- [ ] Mirror sanitized schema DTOs and normalized field errors in TypeScript.
- [ ] Render string fields with Base UI Input, numbers with NumberField, booleans with Checkbox/Switch as declared, enums with Select, groups with Fieldset, and multiline strings with a styled native textarea.
- [ ] Give every field a visible label, description, error association, focus-visible state, and keyboard support.
- [ ] Render credential slots as write-only `keep | replace | clear`; never project secret values from DTOs.
- [ ] Evaluate only the Phase 0 equality-based visibility contract.
- [ ] Resolve plugin labels from localized fallback metadata and icons through a closed host icon ID with `extension` fallback.
- [ ] Keep dirty-state comparison deterministic after normalization/default application.

**Validation:**

- Run: `bun test src/features/plugins/schema`
- Expected: defaults, visibility, field mapping, accessibility attributes, dirty state, and credential actions pass.
- Run: `mise run typecheck && mise run lint`
- Expected: renderer compiles and passes lint without Effect imports in component/query layers.

### Task 5: Cut over the Plugins instance editor

**Outcome:** Any valid bundled manifest can be created and edited without changing shared React code.

**Files:**

- Modify: `src/features/plugins/IntegrationEditor.tsx`, `src/features/plugins/integrationDraft.ts`, `src/features/plugins/AddIntegrationDialog.tsx`, `src/features/plugins/PluginsLayout.tsx`
- Modify: `src/storage/types.ts`, `src/storage/client.ts`, `src/query/options.ts`
- Delete after validation: `src/features/plugins/GoogleCloudIntegrationForm.tsx`, `src/features/plugins/GoogleTranslateWebIntegrationForm.tsx`, `src/features/plugins/EdgeTtsIntegrationForm.tsx`

**Steps:**

- [ ] Build empty config from schema defaults and credential slots.
- [ ] Replace `EditorDraft` union and `isSupportedPlugin()` with one normalized schema draft.
- [ ] Build `IntegrationInstanceWrite` from normalized non-secret JSON and slot actions.
- [ ] Preserve rename, enable, validate, delete, dependency, CAS, Query seeding, and error behavior.
- [ ] Remove plugin-ID label/icon heuristics.
- [ ] Keep unsupported schema/runtime versions visible but read-only.

**Validation:**

- Run: `bun test src/features/plugins/integrationDraft.test.ts src/features/plugins/schema`
- Run: `mise run typecheck`
- Manual: create/edit/validate all three bundled plugin instances in `mise run tauri:dev`.
- Expected: existing behavior is preserved with no form dispatch branch.

### Task 6: Cut over Translation, OCR, and Speech preference editors

**Outcome:** Capability preference forms are selected by capability descriptor/schema, not plugin ID.

**Files:**

- Modify: `src/routes/translate/profiles.tsx`, `src/features/translate/translationEngineOptions.ts`, `src/features/ocr/OcrServiceEditor.tsx`, `src/features/ocr/AddOcrServiceDialog.tsx`, `src/features/ocr/ocrProviderOptions.ts`, `src/features/speech/SpeechServiceEditor.tsx`, `src/features/speech/AddSpeechServiceDialog.tsx`, `src/features/speech/speechProviderOptions.ts`
- Test: `src/features/ocr/ocrProviderOptions.test.ts`, `src/features/speech/speechProviderOptions.test.ts`, and schema tests

**Steps:**

- [ ] Keep instance selection and rebind host-owned.
- [ ] Fetch the selected capability descriptor and render its preference schema/version.
- [ ] Preserve LLM-vs-direct-translation product behavior; only plugin-capability preferences become schema-driven.
- [ ] Remove Google Web channel and Google/Edge preference shape inference from shared option/editor code.
- [ ] Keep incompatible/missing schemas visible and non-executable without deleting stored JSON.

**Validation:**

- Run: `bun test src/features/ocr/ocrProviderOptions.test.ts src/features/speech/speechProviderOptions.test.ts src/features/plugins/schema`
- Run: `mise run test-frontend && mise run typecheck`
- Expected: create, edit, rebind, and missing-plugin fixtures pass without plugin-ID branches.

## Final Validation

```bash
mise run test
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run build
```

Expected: existing bundled features remain operational; adding a synthetic bundled plugin requires registration data/implementation only.

## Failure Behavior

- Missing schema/adapter/handler — fail registration at startup.
- Unsupported schema version — retain data and render read-only unresolved state.
- Invalid preference JSON — reject save and preserve persisted value.
- Broker policy mismatch — deny before secret/token access.

## Privacy and Security

- Frontend validation is advisory; Rust remains authoritative.
- Secret controls never echo values.
- Dynamic labels/icons are sanitized metadata, not executable assets.
- Direct plugin HTTP paths are removed or explicitly documented as compatibility blockers.

## Rollout Notes

- Migrate one editor domain at a time: Plugins, OCR, Speech, Translation Profiles.
- Delete typed forms only after equivalent schema tests and manual checks pass.

## Risks and Mitigations

- Generic schema renderer weakens typed UX — keep schemas closed and add host controls only from real requirements.
- Atomic registration becomes large — keep one registration module per plugin and shared validation in the registry.
- Broker changes affect providers — preserve the current ProviderHttp DTO adapter and its tests.

## Open Questions

None blocking Phase 1.
