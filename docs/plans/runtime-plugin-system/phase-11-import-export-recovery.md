# Phase 11: Runtime Plugin Import, Export, and Recovery Implementation Plan

**Goal:** Make runtime plugin configuration portable without exporting executable code, secrets, credential refs, permission trust, or rollback state.

**Inputs:** Phase 4 minimum export format v7 plus Phases 5, 7, and 8 runtime identities.

**Assumptions:**

- Phase 4 already introduced the minimum export format v7 identity and missing-package behavior before any real runtime plugin release.
- This phase completes v7 copy/merge/reapproval/recovery coverage without changing its runtime identity semantics.
- Import never downloads, instantiates, migrates through, executes, grants authority to, or activates external packages.
- Package approval, publisher trust, and instance execution grant sets are local and non-portable.
- Existing v2–v6 normalization remains supported.

**Architecture:** Export records exact runtime requirements and non-secret configuration/bindings. Import validates/persists structure independently from local package availability and leaves every external runtime inactive as `pending_activation` or `plugin_missing`. A distinct post-import lifecycle preview/confirmation may later migrate copied JSON, issue one instance/package execution grant-set revision with reviewed entries, and activate the exact locally installed/trusted package.

**Tech Stack:** Existing Rust import/export/validation services, SQLite transactions, React configuration transfer UX, package/runtime services.

---

## Dependencies

- Phase 4 minimum v7 identity/missing-package restore.
- Phase 5 service runtime proof.
- Phase 7 integration multi-capability identity.
- Phase 8 provider runtime identity.

## File Map

- Modify: `src-tauri/src/domain/import_export.rs` — v7 requirement DTOs.
- Modify: `src-tauri/src/services/import_export.rs` — export runtime requirements.
- Modify: `src-tauri/src/services/import_validation.rs` — v2–v7 normalization and unresolved package validation.
- Modify: `src-tauri/src/repositories/integration_instances.rs`, `src-tauri/src/repositories/provider_instances.rs`, `src-tauri/src/repositories/translation_profiles.rs`, `src-tauri/src/repositories/ocr_services.rs`, `src-tauri/src/repositories/speech_services.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/import_validation.rs` — import apply.
- Modify: `src/storage/types.ts`, `src/storage/client.ts` — v7 DTOs.
- Modify: `src/features/settings/configurationTransfer.ts`, `src/features/settings/configurationTransfer.test.ts`, `src/features/settings/importAcceptance.test.ts`, `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts` — missing package/reapproval presentation.
- Test: `src-tauri/src/domain/import_export.rs`, `src-tauri/src/services/import_validation.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/tests.rs`, `src/features/settings/configurationTransfer.test.ts`, `src/features/settings/importAcceptance.test.ts`.

## Tasks

### Task 1: Complete export format v7 runtime requirements

**Outcome:** The Phase 4 v7 identity contract covers all service and LLM runtime records without containing code or local trust state.

**Files:**

- Modify: `src-tauri/src/domain/import_export.rs`, `src/storage/types.ts`
- Test: inline v7 serialization/secret-scan tests in `src-tauri/src/domain/import_export.rs` and `src-tauri/src/services/import_export.rs`

**Steps:**

- [ ] Keep `EXPORT_FORMAT_VERSION` at 7 and retain the Phase 4 runtime requirement field semantics.
- [ ] Verify required plugin identity preserves the Phase 4 fields unchanged: plugin ID, semantic version, package digest, publisher key ID, mandatory publisher key fingerprint, plugin API version, config schema version, and required capability majors for both integrations and providers; do not add or reinterpret v7 fields here.
- [ ] Add provider runtime requirements while preserving provider/model/profile UUID relationships.
- [ ] Keep non-secret integration/provider config and capability preferences.
- [ ] Explicitly exclude package artifacts, signatures, absolute paths, package approvals, execution grant sets/revisions, rollback snapshots, credential refs/secrets/tokens, cache, logs, history payloads, images, and audio.
- [ ] Extend forbidden-key/content scanning and tests.

**Validation:**

- Run: `mise run test runtime_plugin_export_v7 -- --nocapture`
- Expected: exact requirements serialize deterministically and forbidden data is absent.

### Task 2: Harden v2–v6 import normalization

**Outcome:** The Phase 4 compatibility path remains stable after service and provider runtime migrations.

**Files:**

- Create: `src-tauri/src/services/fixtures/import/runtime-plugin-v7/`
- Modify: `src-tauri/src/services/import_validation.rs`
- Test: v2–v7 compatibility fixtures in `src-tauri/src/services/fixtures/import/runtime-plugin-v7/`, `src-tauri/src/services/import_validation.rs`, `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] Keep the Phase 4 sequential v2→v3→…→v7 normalization unchanged.
- [ ] Verify v6→v7 maps existing integrations to `BundledRust` and providers to `LegacyFrontendProvider` requirements.
- [ ] Do not assign installed package identity based only on matching plugin ID/version.
- [ ] Preserve unknown plugin/provider IDs and all domain bindings.
- [ ] Reject unsupported future formats and malformed runtime requirements.

**Validation:**

- Run: `mise run test import_format -- --nocapture`
- Expected: v2–v7 fixtures normalize; no old export silently activates external code.

### Task 3: Import missing runtime requirements safely

**Outcome:** Configuration can restore before required packages are installed.

**Files:**

- Modify: `src-tauri/src/services/import_validation.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/repositories/integration_instances.rs`, `src-tauri/src/repositories/provider_instances.rs`, `src-tauri/src/repositories/translation_profiles.rs`, `src-tauri/src/repositories/ocr_services.rs`, `src-tauri/src/repositories/speech_services.rs`
- Test: missing-package import tests in `src-tauri/src/services/import_validation.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/tests.rs`

**Steps:**

- [ ] Validate package requirement syntax independently of local installation.
- [ ] Create/import instances/providers/bindings with unresolved required identity and `plugin_missing`/runtime unavailable state.
- [ ] Do not call package download/install/execute during preview or apply.
- [ ] Keep dependencies visible and deletion/rebind/export possible.
- [ ] When the exact digest becomes installed later, require local publisher/permission approval and explicit activation.

**Validation:**

- Run: `mise run test runtime_plugin_import_missing -- --nocapture`
- Expected: all rows/bindings restore; nothing executes; later exact package can be approved/activated.

### Task 4: Define copy/merge credential behavior

**Outcome:** Import never binds credentials to a changed origin/auth/package without explicit confirmation.

**Files:**

- Modify: `src-tauri/src/services/import_validation.rs`, `src-tauri/src/services/import_export.rs`, `src/features/settings/configurationTransfer.ts`
- Test: copy/merge tests in `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/tests.rs`, and `src/features/settings/configurationTransfer.test.ts`

**Steps:**

- [ ] Continue omitting secrets from export/import.
- [ ] In Copy mode create new instance/provider IDs and no credential bindings.
- [ ] In Merge mode preserve a local credential binding only when instance identity, slot ID/kind, auth policy, approved effective origin, and package digest are unchanged and the user confirms.
- [ ] Otherwise retain config as unconfigured and request credential replacement/reauthorization.
- [ ] Never copy credential refs or execution grant-set revisions from import JSON.

**Validation:**

- Run: `mise run test runtime_plugin_import_credentials -- --nocapture`
- Expected: safe same-identity merge can retain local binding; every changed authority requires reconfiguration.

### Task 5: Separate import persistence from migration and activation

**Outcome:** Import never instantiates plugin code or grants runtime authority; imported config/preferences become executable only through a later explicit lifecycle action.

**Files:**

- Modify: `src-tauri/src/services/import_validation.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/cmds/runtime_lifecycle.rs`
- Test: `src-tauri/src/services/tests.rs`, inline tests in `src-tauri/src/services/import_validation.rs` and `src-tauri/src/services/runtime_lifecycle.rs`

**Steps:**

- [ ] During import preview/apply, perform format/identity/bounds checks and host-owned schema validation only. Do not instantiate Wasm/native code, call plugin migration exports, create execution grant sets, or activate a runtime even when the exact package is already installed and package-approved.
- [ ] Persist runtime-backed imported rows as disabled `pending_activation` or unresolved `plugin_missing`, retaining exact package/schema requirements and copied non-secret config/preferences for a later decision.
- [ ] After import commit, expose a separate user-initiated lifecycle preview. That operation reloads local package/publisher state, may run Wasm migration against copied JSON, validates config/preferences/slot/capability compatibility, shows permission and credential changes, and remains non-mutating until explicit confirmation.
- [ ] On explicit post-import confirmation, create one complete instance/package execution grant-set revision with reviewed capability/page entries and activate through the normal revision-checked lifecycle transaction; a package approval alone is insufficient.
- [ ] If package is absent/unapproved or migration/validation fails, preserve imported data inactive without deleting bindings.
- [ ] Do not import portable rollback snapshots; create local snapshots only on the later explicit activation/upgrade.

**Validation:**

- Run: `mise run test runtime_plugin_import_migration -- --nocapture`
- Run: `mise run test runtime_plugin_import_no_execution -- --nocapture`
- Expected: import preview/apply never instantiate code or activate/grant authority; only a distinct confirmed lifecycle operation can migrate and activate valid local requirements, while invalid/unavailable requirements remain preserved/inactive.

### Task 6: Update configuration transfer UX

**Outcome:** Preview clearly explains package availability, trust, permissions, and post-import actions.

**Files:**

- Modify: `src/features/settings/configurationTransfer.ts`, `src/features/settings/configurationTransfer.test.ts`, `src/features/settings/importAcceptance.test.ts`, `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`

**Steps:**

- [ ] Show required plugin/version/digest/publisher/capabilities and local status: installed/approved/missing/revoked/incompatible.
- [ ] Explain that import will not download code or trust publishers.
- [ ] List instances/providers requiring package install, package approval, execution-grant-set approval, credential replacement, migration, or activation.
- [ ] Keep import apply available for unresolved configurations when data validation succeeds; state that all external runtimes are imported inactive.
- [ ] Link post-import actions to a distinct Plugins/Models activation preview/confirmation flow without embedding secrets.

**Validation:**

- Run: `bun test src/features/settings/configurationTransfer.test.ts src/features/settings/importAcceptance.test.ts`
- Run: `mise run typecheck`
- Expected: preview/action states and missing-package acceptance pass.

### Task 7: Add end-to-end backup/restore fixtures

**Outcome:** Mixed Bundled/Wasm/legacy/runtime provider configurations restore deterministically.

**Files:**

- Modify: `src-tauri/src/services/fixtures/import/runtime-plugin-v7/`, `src-tauri/src/services/tests.rs`, `src-tauri/src/services/import_validation.rs`, `src-tauri/src/services/import_export.rs`, `src-tauri/src/services/runtime_lifecycle.rs`
- Test: `src/features/settings/configurationTransfer.test.ts`, `src/features/settings/importAcceptance.test.ts`

**Steps:**

- [ ] Add v7 fixtures containing Google Web, Edge, Google Cloud, runtime OpenAI Compatible, and missing package requirements.
- [ ] Test Replace/Copy/Merge, absent packages, revoked publisher, wrong digest, failed post-import migration, credential reapproval, and proof that import itself never invokes or activates a runtime.
- [ ] Assert exports before/after preserve user configuration/bindings while local trust/secret state remains local.

**Validation:**

- Run: `mise run test runtime_plugin_import -- --nocapture`
- Run: `bun test src/features/settings`
- Expected: all recovery scenarios pass with no import-time code execution/activation and no code/trust/secret transfer.

## Final Validation

```bash
mise run test runtime_plugin_import -- --nocapture
mise run test import_format -- --nocapture
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run build
```

Expected: v2–v7 imports work; v7 preserves exact requirements while every external runtime remains inactive until a separate confirmed lifecycle operation, and code/trust/secrets remain local.

## Failure Behavior

- Missing package — import preserved inactive references.
- Wrong digest/version/publisher — do not substitute a different local package.
- Missing package approval or instance execution grant — preserve inactive; import cannot create either authority.
- Post-import migration/credential mismatch — preserve unconfigured inactive data and report action.
- Unsupported future format — reject before DB mutation.

## Privacy and Security

- Exports contain no executable code, package approval, execution grant, secret, ref, token, user content payload, image, or audio.
- Import JSON never grants publisher trust, package approval, or runtime execution authority.
- Local credential reuse is limited to unchanged authority identity.

## Rollout Notes

- Keep reading v2–v6 for the documented compatibility window.
- Start writing only v7 after all consumers understand runtime requirements.

## Risks and Mitigations

- Restore cannot fetch missing code — intentional fail-closed behavior with clear required digest/publisher UX.
- Merge reuses unsafe credentials — strict equality on package/slot/auth/origin plus explicit confirmation.
- Export schema grows — isolate runtime requirement records and retain deterministic validation.

## Open Questions

None blocking Phase 11.
