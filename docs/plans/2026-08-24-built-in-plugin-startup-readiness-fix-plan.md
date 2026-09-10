# Implementation Plan

> **Superseded (2026-08-24):** plugin-level signing, publisher trust, vendor bootstrap, and default-activation orchestration were removed. See `docs/architecture/plugin-catalog.md`.

**Goal:** Make all 10 official built-in plugins installed, registered, and authorized as exact defaults on every startup, while requiring user credentials only when a plugin executes an authenticated capability.

**Inputs:** User requirement: “所有内置的插件开机即用，而不是各种卡检查”; current startup log and database diagnosis on 2026-08-24; `docs/plans/2026-08-21-package-only-migration-plan.md`; `docs/plans/2026-08-21-unsigned-plugin-install-plan.md`.

**Assumptions:**

- “Ready on startup” means every official package is imported, projected into its catalog, and authorized as the exact vendor default without user confirmation.
- Startup does not auto-create Provider or Integration instances.
- Plugins that require credentials appear immediately and can be configured. They remain `unconfigured` until the user supplies credentials. Missing credentials must not hide the plugin or block definition registration.
- Official bootstrap remains limited to vendor-signed archives that exact-match the committed public root, package digest, permission digest, publisher identity, and authority ceiling.
- Unsigned and user-installed packages keep their current acknowledgement, default-confirmation, and execution-grant checks.

**Architecture:** Resolve official package archives and their activation policy from one ordered resource-directory abstraction. Startup imports the signed archives, projects every package definition, and applies exact vendor defaults idempotently. Auth-policy registration validates static host-driver metadata independently from user credential bindings; each driver defines whether OAuth scopes are required.

**Tech Stack:** Rust, Tauri 2, SQLite/rusqlite, Ed25519, Wasmtime Component Model, React 19, TanStack Query, Bun, mise.

---

## File Map

- Modify: `src-tauri/src/state.rs` — resolve one official plugin resource directory, import archives, register definitions, apply exact defaults, and emit a startup readiness summary.
- Modify: `src-tauri/src/services/default_package_activation/mod.rs` — accept the resolved vendor policy path without deriving a conflicting directory.
- Modify: `src-tauri/src/services/default_package_activation/vendor_bootstrap.rs` — return explicit bootstrap results for present official resources and preserve exact-match security checks.
- Modify: `src-tauri/src/services/auth_policies.rs` — make scope requirements a property of each host auth driver.
- Modify: `src-tauri/src/services/bundled_plugins.rs` — validate package auth bindings through the host auth-policy registry instead of a universal non-empty-scope rule.
- Modify: `src-tauri/src/services/package_definition.rs` — preserve the projected auth driver, audience, capability, and scope metadata required by registration validation.
- Modify: `src-tauri/src/services/service_integration_registry.rs` — expose definition-count/readiness checks used by startup verification.
- Modify: `src-tauri/src/services/default_package_activation/tests/mod.rs` — cover exact vendor bootstrap, idempotency, and signed-only behavior.
- Modify: `src-tauri/src/state.rs` tests — cover the real Tauri debug resource layout and all-10 readiness.
- Modify: `src-tauri/src/services/auth_policies.rs` tests — cover driver-specific scope requirements.
- Modify: `src-tauri/src/services/package_definition.rs` tests — cover Baidu definition projection and rejection of incomplete or unknown auth policies.
- Modify: `src/features/plugins/AddIntegrationDialog.tsx` — show built-in definitions immediately and distinguish missing credentials from package unavailability if current DTOs expose readiness.
- Modify: `src/features/models/AddProviderDialog.tsx` — present authorized built-in Provider packages without a manual default-activation step.
- Modify: related frontend tests under `src/features/plugins/` and `src/features/models/` — verify built-in availability and credential-required presentation.
- Modify: `src-tauri/resources/plugins/README.md` — document committed official bundle startup behavior.

## Seams

- **Seam:** `AppState::initialize_for_tests_with_resources` — a real Tauri resource layout imports, registers, and authorizes all official packages.
- **Seam:** `DefaultPackageActivationService::apply_vendor_bootstrap_policies` — exact signed policies become defaults idempotently and invalid policies fail closed.
- **Seam:** `auth_policies::validate_registration_binding` — driver-specific static auth metadata is validated without consulting user credentials.
- **Seam:** `PluginPackageService::project_installed_service_definitions` plus `ServiceIntegrationRegistry::upsert_package_definition` — Baidu and all other service definitions register before instance credentials exist.
- **Seam:** Provider and Integration catalog query options — built-in packages appear as available after startup; credential requirements are configuration state, not package readiness.

## Tasks

### Task 1: Resolve one official resource bundle

**Seam:** `AppState::initialize_for_tests_with_resources`

**Outcome:** Package discovery and default-policy discovery use the same resolved directory in source/debug and packaged layouts.

**Files:**

- Modify: `src-tauri/src/state.rs`
- Test: `src-tauri/src/state.rs`

**Steps:**

- [ ] **Red:** Add `production_resource_bootstrap_uses_tauri_debug_layout_and_authorizes_all_official_defaults`. Write all official archives and `default-activation-policies.json` under `<resource_dir>/resources/plugins`, initialize `AppState`, and assert 10 installed versions, 10 default versions, and 10 activation policies.
- [ ] **Red:** Assert all expected service definitions, including `com.langnext.baidu-ocr`, are present in the registry after initialization.
- [ ] **Green:** Introduce one resource resolver that checks the supported layouts in deterministic order and returns the directory that contains the official bundle. Use that result for archive discovery and the policy path.
- [ ] Keep environment overrides explicit and deterministic. Reject a split bundle that mixes archives from one directory with a policy from another.
- [ ] Update the existing flat `<resource_dir>/plugins` test so both supported layouts remain covered.

**Validation:**

- Run (red): `mise run test production_resource_bootstrap_uses_tauri_debug_layout_and_authorizes_all_official_defaults -- --nocapture`
- Expected: fails with zero default versions/policies because startup looks in the wrong policy directory.
- Run (green): same command.
- Expected: 10 installed, 10 authorized defaults, 10 policies, and every expected definition.

### Task 2: Make official default bootstrap an explicit startup invariant

**Seam:** `DefaultPackageActivationService::apply_vendor_bootstrap_policies`

**Outcome:** A present official bundle either authorizes every exact policy or returns a visible startup error; missing policies cannot silently produce an unusable catalog.

**Files:**

- Modify: `src-tauri/src/services/default_package_activation/mod.rs`
- Modify: `src-tauri/src/services/default_package_activation/vendor_bootstrap.rs`
- Modify: `src-tauri/src/state.rs`
- Test: `src-tauri/src/services/default_package_activation/tests/mod.rs`
- Test: `src-tauri/src/state.rs`

**Steps:**

- [ ] **Red:** Add `official_bundle_present_without_policy_fails_startup_readiness` through `AppState::initialize_for_tests_with_resources`.
- [ ] **Red:** Add `official_vendor_bootstrap_is_idempotent_across_restart`; initialize twice against the same app-data directory and assert exactly 10 defaults and policies with unchanged digests.
- [ ] **Green:** Distinguish “no official bundle” from “official archives are present but policy is absent or incomplete.” The latter is a startup readiness error, not an empty successful result.
- [ ] Return an applied/rejected summary from vendor bootstrap. Require the applied exact identities to match the discovered official archive identities.
- [ ] Preserve signed-only, publisher, digest, permission-digest, external-root, and authority-ceiling checks.
- [ ] Log one sanitized startup summary: installed count, definition count, authorized-default count, and rejected plugin IDs. Never log credentials or package contents.

**Validation:**

- Run (red): `mise run test official_bundle_present_without_policy_fails_startup_readiness -- --nocapture`
- Expected: fails because the current missing-policy path silently returns an empty list.
- Run (green): same command.
- Expected: initialization returns a stable readiness error naming the missing policy resource.
- Run: `mise run test official_vendor_bootstrap_is_idempotent_across_restart -- --nocapture`
- Expected: passes with exactly 10 unchanged defaults after both starts.

### Task 3: Validate auth metadata by driver semantics

**Seam:** `auth_policies::validate_registration_binding`

**Outcome:** Static auth-policy validation accepts Baidu client credentials with no OAuth scopes, requires scopes for Google service-account OAuth, and never reads user credentials.

**Files:**

- Modify: `src-tauri/src/services/auth_policies.rs`
- Modify: `src-tauri/src/services/bundled_plugins.rs`
- Test: `src-tauri/src/services/auth_policies.rs`
- Test: `src-tauri/src/services/bundled_plugins.rs`

**Steps:**

- [ ] **Red:** Add `baidu_registration_binding_accepts_empty_scopes_before_credentials_exist` through the public registration validation seam.
- [ ] **Red:** Add `google_registration_binding_rejects_empty_scopes` and `unknown_registration_auth_driver_fails_closed`.
- [ ] **Green:** Add a driver property or validation method that defines whether scopes are required. Use the same rule for package registration and token-grant request validation.
- [ ] Remove the universal `auth_policy.scopes.is_empty()` rejection from registration validation.
- [ ] Keep non-empty driver ID, policy ID, audience, approved capability, and exact-scope allow-list checks.
- [ ] Do not query credential bindings or the credential vault during definition registration.

**Validation:**

- Run (red): `mise run test baidu_registration_binding_accepts_empty_scopes_before_credentials_exist -- --nocapture`
- Expected: fails with `auth policy binding ... is incomplete`.
- Run (green): same command.
- Expected: passes.
- Run: `mise run test google_registration_binding_rejects_empty_scopes -- --nocapture`
- Run: `mise run test unknown_registration_auth_driver_fails_closed -- --nocapture`
- Expected: both pass and remain fail closed.

### Task 4: Register all official definitions before user configuration

**Seam:** `PluginPackageService::project_installed_service_definitions` plus `ServiceIntegrationRegistry::upsert_package_definition`

**Outcome:** Every official service definition is visible immediately after startup, including Baidu OCR, without credential rows or Integration instances.

**Files:**

- Modify: `src-tauri/src/services/package_definition.rs`
- Modify: `src-tauri/src/services/service_integration_registry.rs`
- Test: `src-tauri/src/services/package_definition.rs`
- Test: `src-tauri/src/state.rs`

**Steps:**

- [ ] **Red:** Add `all_official_service_definitions_register_without_instance_credentials`. Use the verified official package fixtures, an empty credential vault/binding table, and an empty Integration table.
- [ ] Assert Baidu exposes the `api-key` and `secret-key` slots, `ocr.image@1`, its fixed endpoints/path authority, and the host-owned auth policy.
- [ ] **Green:** Correct projection or registry validation only where the red test identifies a mismatch. Do not synthesize credential values or mark credential-required instances Ready.
- [ ] Replace per-definition warning-and-continue behavior for official resources with an aggregate startup readiness failure. Keep user-installed invalid packages isolated and visible as package errors.

**Validation:**

- Run (red): `mise run test all_official_service_definitions_register_without_instance_credentials -- --nocapture`
- Expected: Baidu registration fails before the validator fix.
- Run (green): same command.
- Expected: every official service definition registers with no instance credentials.

### Task 5: Present built-ins as available, not manually activatable

**Seam:** Provider and Integration catalog query options

**Outcome:** The UI immediately offers all authorized built-ins. Credential-required plugins lead to configuration, while missing official bootstrap is shown as an application readiness error rather than a failed create submission.

**Files:**

- Modify: `src/features/plugins/AddIntegrationDialog.tsx`
- Modify: `src/features/models/AddProviderDialog.tsx`
- Modify: related query/presentation helpers only if existing DTOs do not expose default authorization.
- Test: related tests under `src/features/plugins/` and `src/features/models/`.

**Steps:**

- [ ] **Red:** Add a test that an authorized built-in Integration definition is selectable before credentials exist and opens/creates an unconfigured instance.
- [ ] **Red:** Add a test that official Provider catalog entries are selectable without a manual “Make Default” action.
- [ ] **Red:** Add a test that a startup-readiness/catalog error is presented before submission rather than as a generic create failure.
- [ ] **Green:** Use backend authorization/readiness data to render built-ins as available. Keep credential fields in the create/editor workflow.
- [ ] Do not bypass backend package-first checks. Do not auto-fill, persist, or log credentials.

**Validation:**

- Run (red): targeted Bun tests for the modified dialogs.
- Expected: current flow either hides Baidu or fails only after submit when defaults are absent.
- Run (green): same tests.
- Expected: built-ins are available; credential-required state is explicit; no manual official-default activation is required.

### Task 6: Verify real startup readiness

**Seam:** `AppState::initialize` and real Tauri debug resources

**Outcome:** A fresh database starts with 10 installed official packages, every official definition registered, and 10 exact authorized defaults.

**Files:**

- Modify: `src-tauri/resources/plugins/README.md`
- Test: startup integration tests and the real debug run.

**Steps:**

- [ ] Reset only the test/dev database used for manual validation.
- [ ] Start with `mise run tauri:dev` and capture the startup summary.
- [ ] Query the real database and assert:
  - `installed_plugin_versions = 10`
  - `plugin_default_versions = 10`
  - `plugin_default_activation_policies = 10`
  - no official definition registration rejection
- [ ] Create one credentialless Integration, one credential-required Integration, and one Provider through public IPC/UI seams.
- [ ] Confirm credential-required instances are available but not executable until credentials are saved.
- [ ] Update resource documentation to state that the committed official bundle auto-bootstraps exact defaults.

**Validation:**

- Run: `mise run tauri:dev`
- Expected: no `package_definition_register_failed`, `default_package_vendor_bootstrap_failed`, or rejected official policy log.
- Run the read-only database readiness probe.
- Expected: installed/defaults/policies are all 10.

## Final Validation

- Run: `mise run test`
- Expected: all Rust tests pass with no warnings.
- Run: `mise run test-frontend`
- Expected: all frontend tests pass.
- Run: `mise run typecheck`
- Expected: pass.
- Run: `mise run lint`
- Expected: pass.
- Run: `mise run format:check`
- Expected: pass.
- Run: `mise run build`
- Expected: pass with no actionable warnings.
- Run: `mise run plugin:conformance all`
- Expected: all suites pass.
- Run: `mise run plugin:verify-release-bundle`
- Expected: all 10 official packages pass.
- Run: `mise run package-only:check`
- Expected: no legacy execution path.
- Run: `mise run tauri:build`
- Expected: installers and portable package build successfully.

## Failure Behavior

- No official bundle in a development/test context — startup may continue with an explicitly empty external-plugin catalog when the caller opted out of official resources.
- Official archives present but policy missing — fail startup readiness with the missing resource path; do not silently install unusable built-ins.
- Official policy entry mismatch — reject that exact package and fail the official readiness invariant; do not downgrade to unsigned or authorize another digest.
- Unknown auth driver or unsupported capability — reject the package definition.
- Credential-required plugin without user credentials — definition remains available; instance remains unconfigured; execution fails with a credential-required error.
- One invalid user-installed package — isolate its error; do not remove valid official definitions.

## Privacy and Security

- Official auto-readiness never bypasses signature, publisher, digest, permission-digest, external-root, or authority-ceiling verification.
- User credentials remain in the Host credential vault. Package definition registration never reads credential bytes or credential references.
- Baidu API Key, Secret Key, and access token never enter guest metadata, frontend logs, exports, or package manifests.
- Unsigned package acknowledgement, second default confirmation, native allowlist, execution grants, and vendor-bootstrap signed-only rules remain unchanged.

## Rollout Notes

- This application is unpublished. No legacy runtime or old database compatibility is required.
- Reset the local development database once after implementation so startup evidence is produced from the final package-only schema and resource bundle.
- Do not commit private signing material. Commit only the existing public root, signed archives, and exact activation policies.

## Risks and Mitigations

- **“Ready” is confused with “credentialed.”** — Keep separate states: package available/default-authorized versus instance configured/executable.
- **Resource lookup selects a partial directory.** — Resolve one complete bundle directory and reject split archive/policy layouts.
- **Driver-specific scope rules weaken OAuth validation.** — Validate through the closed host driver registry; only the Baidu driver permits an empty scope set.
- **Auto-default behavior expands to user packages.** — Restrict automatic activation to exact vendor policy entries and vendor publisher identity.
- **Startup becomes fragile for optional user packages.** — Apply the aggregate readiness invariant only to the official resource bundle; isolate user package errors.

## Open Questions

None. The requested behavior defines official built-ins as automatically available/default-authorized, while user credentials remain a separate configuration step.
