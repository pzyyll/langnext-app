# Phase 12: Legacy Plugin Executor Retirement Implementation Plan

**Goal:** Remove static plugin-ID branches, direct plugin transports, Bundled Rust service handlers, and legacy frontend provider executors only after runtime replacements have completed a stable dual-stack release.

**Inputs:** Phases 5–8, 11, and 11.5 plus production migration/rollback evidence.

**Assumptions:**

- Every retired implementation has a signed runtime package, an authorized default package-first creation path from Phase 11.5, and one stable release of explicit dual-stack operation.
- Phase 9/10 are optional and do not block retirement unless included in release scope; a Phase 10 native worker included in retirement scope must pass Phase 11.5 activation gates.
- Unresolved/missing runtime rows remain supported data states.
- Export formats v2–v8 remain readable through the Phase 12 release and at least one subsequent stable release; removing any adapter requires a separate reviewed compatibility plan and retained fixtures.

**Architecture:** Retirement is a sequence of evidence-backed removals, not one rewrite. The host keeps typed capabilities, package/runtime/router/broker/schema infrastructure and deletes only duplicate concrete executors and compatibility branches after active-instance inventory reaches zero or users explicitly disable unresolved legacy rows.

**Tech Stack:** Rust/React cleanup, SQLite inventory/migrations only where required, package/runtime conformance, full project validation.

---

## Dependencies

- Runtime replacements from Phases 5–8 stable for one release.
- Phase 11 export/recovery available.
- Phase 11.5 default authorization and package-first creation complete for every executor in retirement scope.

## File Map

- Modify/delete: `src-tauri/src/services/google_translate_web.rs`, `src-tauri/src/services/edge_tts.rs`, `src-tauri/src/services/google_cloud.rs` — production bundled protocol handlers after gates.
- Modify: `src-tauri/src/services/bundled_plugins.rs`, `src-tauri/src/services/service_integration_registry.rs`, `src-tauri/src/services/service_capabilities.rs`, `src-tauri/src/services/service_integrations.rs` — remove retired registrations/compatibility branches.
- Modify: `src-tauri/src/domain/service_integration.rs` — remove concrete config types/constants no longer needed by import compatibility.
- Modify/delete: `src/features/providers/builtin/openaiCompatible.ts`, `src/features/providers/builtin/openaiCompatible.test.ts`, `src/features/providers/builtin/openaiResponses.ts`, `src/features/providers/builtin/openaiResponses.test.ts`, `src/features/providers/builtin/openaiShared.ts`, `src/features/providers/builtin/anthropic.ts`, `src/features/providers/builtin/anthropic.test.ts`, `src/features/providers/builtin/gemini.ts`, `src/features/providers/builtin/gemini.test.ts`, `src/features/providers/builtin/deepseek.ts`, `src/features/providers/builtin/deepseek.test.ts`, `src/features/providers/builtin/index.ts` — retire one protocol implementation at a time.
- Modify/delete: `src/features/providers/executor.ts`, `src/features/providers/registry.ts`, `src/features/providers/types.ts` — remove final legacy frontend adapter/alias path.
- Modify/delete: `src/features/plugins/IntegrationEditor.tsx`, `src/features/plugins/integrationDraft.ts`, `src/features/plugins/integrationDraft.test.ts` — remove retained typed-form/runtime compatibility after package-first creation covers the same behavior.
- Create: `src-tauri/src/services/legacy_runtime_inventory.rs`, `src-tauri/src/cmds/legacy_runtime_inventory.rs` — retirement gate inventory.
- Modify: `src-tauri/src/cmds/mod.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json` — register inventory commands and keep AppManifest/ACL coverage exact.
- Modify: `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/domain/import_export.rs`, `src-tauri/src/services/import_validation.rs` — inventory and unresolved compatibility.
- Modify: `src/features/plugins/IntegrationEditor.tsx`, `src/features/models/ProviderEditor.tsx`, `src/features/settings/configurationTransfer.ts` — migration/unresolved UX.
- Modify: `docs/architecture/adapter-strategy.md`, `docs/architecture/frontend-state-management.md`, `docs/analysis/runtime-plugin-architecture.md` — final architecture.
- Test: runtime inventory/import/conformance tests and full existing suites.

## Tasks

### Task 1: Inventory active legacy identities

**Outcome:** Retirement scope is based on authoritative data rather than code assumptions.

**Files:**

- Create: `src-tauri/src/services/legacy_runtime_inventory.rs`, `src-tauri/src/cmds/legacy_runtime_inventory.rs`
- Modify: `src-tauri/src/cmds/mod.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json`, `src/features/plugins/IntegrationEditor.tsx`, `src/features/models/ProviderEditor.tsx`
- Test: inline inventory service tests and Phase 0 command/AppManifest/ACL coverage tests

**Steps:**

- [ ] Count instances/providers by runtime kind, concrete legacy executor, enabled state, dependency count, package replacement availability, default activation policy state, package-first creation readiness, pending/unavailable activation state, and migration blockers.
- [ ] List unresolved legacy rows with actions: migrate, keep disabled for export/rebind, or delete explicitly.
- [ ] Do not auto-migrate or delete during startup.
- [ ] Block executor removal while an enabled active row still requires it.
- [ ] Capture stable-release telemetry only as sanitized counts if telemetry exists; do not add remote telemetry solely for this phase.
- [ ] Register read-only inventory commands in the `invoke_handler`, `AppManifest`, `app-commands` permission set, and trusted-app capability coverage together; remove retired commands from all four sets in the same retirement slice.

**Validation:**

- Run: `mise run test legacy_runtime_inventory -- --nocapture`
- Run: `mise run test runtime_plugin_security -- --nocapture`
- Expected: every active/missing/disabled/dependent legacy state is classified correctly, and command registration/ACL sets remain identical.

### Task 2: Retire Google Web and Edge bundled executors

**Outcome:** These capabilities execute only through installed runtime packages.

**Files:**

- Modify/delete: `src-tauri/src/services/google_translate_web.rs`, `src-tauri/src/services/edge_tts.rs`, relevant registrations in `src-tauri/src/services/bundled_plugins.rs`
- Preserve: runtime package fixtures and v2–v8 import compatibility tests

**Steps:**

- [ ] Verify zero enabled rows require each bundled executor.
- [ ] Remove handler construction/registration and direct transport code.
- [ ] Keep old config schema migration adapters wherever v2–v8 import or unresolved-row display requires them; removal is blocked through the documented compatibility window.
- [ ] Convert disabled unresolved bundled rows to visible `plugin_missing` requirements without deleting bindings.
- [ ] Remove rollback snapshots that reference retired code only after user/package migration policy permits.

**Validation:**

- Run: `mise run test google_translate_web_runtime -- --nocapture`
- Run: `mise run test edge_tts_runtime -- --nocapture`
- Expected: runtime packages cover all behavior; no production bundled execution symbols remain.

### Task 3: Retire Google Cloud bundled executor incrementally

**Outcome:** Translate/Detect, OCR, and TTS bundled paths are removed only when each capability inventory is clear.

**Files:**

- Modify/delete: `src-tauri/src/services/google_cloud.rs`, Google registration in `src-tauri/src/services/bundled_plugins.rs`, retired config compatibility in `src-tauri/src/domain/service_integration.rs`
- Test: Google Cloud runtime conformance and import compatibility fixtures

**Steps:**

- [ ] Gate removal per capability rather than deleting the whole module at once.
- [ ] Preserve host-owned Google auth policy, service-account exchanger, token grant, and credential validation.
- [ ] Preserve unresolved instance/config import and display support.
- [ ] Remove protocol request/response parsing only after guest fixtures are authoritative.
- [ ] Verify one shared runtime instance still supports all domain bindings.

**Validation:**

- Run: `mise run plugin:conformance google-cloud`
- Run: `mise run test google_cloud_runtime -- --nocapture`
- Expected: no bundled capability execution remains; host auth/broker infrastructure continues.

### Task 4: Retire TypeScript provider executors sequentially

**Outcome:** Each migrated LLM provider executes only through runtime packages while product workflows stay unchanged.

**Files:**

- Delete: each retired provider implementation/test under `src/features/providers/builtin/`
- Modify: `src/features/providers/registry.ts`, `src/features/providers/executor.ts`, `src/features/models/ProviderEditor.tsx`
- Test: remaining provider executor/model/translation/OCR tests

**Steps:**

- [ ] Retire one provider only after zero enabled providers require its legacy executor and its runtime package passed one stable release.
- [ ] Keep provider/model/profile UUIDs and persistence unchanged.
- [ ] Move authoritative protocol fixtures to runtime package tests before deletion.
- [ ] Preserve unknown/missing provider rows visibly.
- [ ] Remove the legacy executor/registry only after the final provider retires.

**Validation:**

- Run: `mise run plugin:conformance llm`
- Run: `bun test src/features/models src/features/translate src/features/ocr`
- Expected: model sync/chat/stream/fallback/history/OCR work through runtime packages only.

### Task 5: Remove shared plugin-ID branches and compatibility UI

**Outcome:** Shared production code is package/capability/schema driven.

**Files:**

- Modify/delete: `src-tauri/src/domain/service_integration.rs`, `src-tauri/src/services/bundled_plugins.rs`, `src-tauri/src/services/service_integration_registry.rs`, `src-tauri/src/services/service_integrations.rs`, `src/features/plugins/IntegrationEditor.tsx`, `src/features/plugins/integrationDraft.ts`, `src/features/plugins/integrationDraft.test.ts`, `src/features/translate/translationEngineOptions.ts`, `src/features/ocr/ocrProviderOptions.ts`, `src/features/speech/speechProviderOptions.ts`
- Test: grep gates and synthetic installed-plugin fixtures

**Steps:**

- [ ] Remove concrete Google/Edge config structs/constants from shared domain when no import compatibility needs them.
- [ ] Remove `isSupportedPlugin`, plugin-specific draft unions/forms, label/icon heuristics, preference inference, and static handler builders.
- [ ] Keep closed capability IDs/contracts and host auth-policy IDs.
- [ ] Add a synthetic installed plugin fixture proving shared code needs no source changes.
- [ ] Update `docs/architecture/adapter-strategy.md`, frontend state management, and runtime plugin documentation.

**Validation:**

- Run:
  ```bash
  rg -n "with_google_cloud|with_google_translate_web|with_edge_tts|isSupportedPlugin|GoogleCloudConfigV1|GoogleTranslateWebConfigV1|EdgeTtsConfigV1" src src-tauri/src --glob "!**/*.test.*"
  ```
- Expected: no production references except explicitly documented import/migration compatibility modules.

### Task 6: Preserve unresolved data and rollback at release boundary

**Outcome:** Cleanup never destroys configurations that need missing packages or manual resolution.

**Files:**

- Modify: `src-tauri/src/services/legacy_runtime_inventory.rs`, `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/import_validation.rs`, `src/features/plugins/IntegrationEditor.tsx`, `src/features/models/ProviderEditor.tsx`, `src/features/settings/configurationTransfer.ts`, `src/features/settings/configurationTransfer.test.ts`, `src/features/settings/importAcceptance.test.ts`

**Steps:**

- [ ] Keep unresolved rows readable, exportable, rebindable, disableable, and deletable.
- [ ] Do not cascade-delete Profile/OCR/Speech/Provider dependencies.
- [ ] Use the Phase 11.5 package-first creation gate to stop creating new legacy runtime rows; block creation with an actionable package/default authorization requirement when no eligible policy exists.
- [ ] Continue reading older export formats through the committed compatibility window.
- [ ] Document that application binary rollback across forward-only DB migrations is unsupported; rollback uses package/runtime switching in the current host.

**Validation:**

- Run: `mise run test runtime_plugin_import -- --nocapture`
- Run: `mise run test legacy_runtime_inventory -- --nocapture`
- Expected: unresolved data survives and no new legacy rows can be created.

## Final Validation

```bash
mise run plugin:conformance all
mise run test
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run build
mise run tauri:build
```

Expected: all production plugin execution uses installed packages/runtime adapters; missing configurations remain manageable; packaged application succeeds.

## Failure Behavior

- Active legacy row found — abort that executor’s removal/release gate.
- Missing runtime replacement — keep row disabled/unresolved and visible.
- Package regression after legacy removal — use package version rollback, not removed executor replay.
- Old import — normalize to unresolved/runtime requirements per Phase 11.

## Privacy and Security

- Removal must not weaken broker/auth/resource policies.
- Old secrets remain in host vault only and are never exported during migration.
- Cleanup commands do not submit validation requests automatically.

## Rollout Notes

- Retire in order: Google Web, Edge TTS, Google Cloud capabilities, then individual LLM providers.
- Keep package rollback versions available across the retirement release.

## Risks and Mitigations

- Hidden legacy row loses execution — authoritative inventory and release blocker.
- New configuration falls back to a retired executor — Phase 11.5 package-first creation is a mandatory per-executor gate.
- Removing fixtures loses protocol confidence — port fixtures before code deletion.
- Binary rollback impossible after DB migration — use runtime/package rollback and backups, not old app binaries.

## Open Questions

None blocking Phase 12 once inventory and stable-release gates are satisfied.
