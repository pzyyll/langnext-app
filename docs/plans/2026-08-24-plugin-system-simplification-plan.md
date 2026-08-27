# Implementation Plan

**Goal:** Replace the multi-publisher signed-package and default-activation system with a small source-based plugin catalog that loads built-in directories, debug development directories, and user Wasm archives while preserving runtime sandbox and Host authority controls.

**Inputs:** User request on 2026-08-24 to simplify the plugin system; current package-only implementation; `docs/plans/2026-08-21-package-only-migration-plan.md`; `docs/plans/2026-08-21-unsigned-plugin-install-plan.md`; `docs/plans/2026-08-24-built-in-plugin-startup-readiness-fix-plan.md`.

**Assumptions:**

- The recommended product scope is accepted: built-in plugins are trusted by application resource location; development directory plugins are enabled only in debug builds; user-installed plugins are Wasm-only; Native workers are built-in-only.
- The application is unpublished. The implementation may rewrite plugin-related migrations and reset the development database. It does not preserve old package, publisher, activation-policy, or export formats.
- “Source loading” means loading a plugin directory that contains `plugin.json`, schemas/assets, and built runtime artifacts. The application does not embed a Rust compiler or execute Rust source directly.
- A debug build task can rebuild a development plugin before reload. Production never compiles arbitrary user source.
- Built-in plugin integrity is inherited from the signed application installer/update channel. The application does not verify a second plugin-level publisher signature for built-in resources.
- User archives have no authenticated publisher identity. The UI must state this. Installation approval is a permission review, not publisher trust.
- Existing instance package pins and package rollback remain. Changing a catalog default affects new instances only; it does not silently upgrade existing instances.

**Architecture:** Add one `PluginCatalog` that discovers three source types and materializes every directory or archive into an immutable, digest-addressed snapshot. `PluginLoader` validates the same manifest, indexed files, capability contracts, and permission requests for both directory and archive input. Built-in entries become automatic defaults; optional user overrides are stored as `plugin_id + content_digest`. Runtime execution continues through the current Wasm/native routers, credential vault, auth drivers, network broker, execution grants, resource limits, and cancellation.

**Tech Stack:** Rust, Tauri 2, SQLite/rusqlite, Wasmtime Component Model, React 19, TanStack Query, Base UI, Bun, mise.

---

## Product Boundary

### Supported

- Built-in Wasm plugins from application resources.
- Built-in trusted Native workers from application resources and a closed first-party allowlist.
- Development plugin directories in debug builds.
- User-installed Wasm `.lnplugin` archives.
- Immutable content digest identity, package pinning, explicit instance upgrade, and package rollback.
- Host-owned credentials, OAuth/client-credentials drivers, network/path authority, execution grants, Blob/Stream resources, cancellation, and limits.

### Removed

- Plugin-level Ed25519 signatures.
- Publisher public keys, fingerprints, trust roots, enable/revoke state, and publisher approval.
- Signed versus unsigned package state.
- Vendor bootstrap activation-policy JSON.
- Permission-request digest and authority-ceiling digest as authorization artifacts.
- Default activation previews, confirmations, intents, claims, recovery workers, and authority approvals.
- Unsigned/default/native risk acknowledgement versions.
- User-installed Native plugins.
- Old import/export formats and old database compatibility.

### Not Added

- Runtime execution of raw Rust/TypeScript source.
- A plugin marketplace.
- Remote plugin download/update.
- Automatic upgrade of existing instances when a default changes.
- A second scripting runtime such as QuickJS.

## Target Data Flow

```text
Built-in directory ─┐
Development directory ─┼─> PluginLoader ─> immutable snapshot ─> PluginCatalog
User .lnplugin archive ─┘                            │
                                                     ├─> package-derived definitions
                                                     ├─> default resolver
                                                     └─> RuntimeRouter

Instance create ─> selected catalog digest ─> config/credential binding ─> execution grant ─> runtime
```

## Target Trust Model

| Source | Availability | Runtime | Install approval | Default behavior | Privileged Host auth |
|---|---|---|---|---|---|
| Built-in | All builds | Wasm / allowlisted Native | None | Automatic | Allowed by closed Host policy |
| Development | Debug only | Wasm | None; explicit debug opt-in | Optional debug override | Denied unless an explicit debug-only policy permits it |
| User | All builds | Wasm only | One permission confirmation per content digest | Explicit user selection | Denied for built-in-only auth drivers |

## File Map

### New core

- Create: `src-tauri/src/domain/plugin_catalog.rs` — `PluginSource`, `PluginContentKind`, `PluginDescriptor`, `LoadedPlugin`, `CatalogDefault`, and sanitized DTOs.
- Create: `src-tauri/src/services/plugin_loader.rs` — directory/archive ingestion, canonical indexed-file validation, immutable snapshot materialization, and content digest computation.
- Create: `src-tauri/src/services/plugin_catalog.rs` — source discovery, precedence, default resolution, snapshot lookup, refresh, and catalog errors.
- Create: `src-tauri/src/repositories/plugin_catalog.rs` — simple user catalog preferences and user archive records.
- Create: `src-tauri/migrations/0016_runtime_plugin_catalog.sql` — replacement plugin schema for an unpublished fresh database.
- Create: `.mise/tasks/plugin/pack` — package a validated directory as an unsigned `.lnplugin` archive.
- Create: `.mise/tasks/plugin/dev-build` — build one development plugin directory before reload.
- Create: `.mise/tasks/plugin/check-builtins` — validate all built-in resources structurally and enforce Native source rules.

### Core modifications

- Modify: `src-tauri/src/domain/plugin_package.rs` — reduce package DTOs to source, runtime, version, digest, permissions, content state, and errors; remove publisher/signature/risk types.
- Modify: `src-tauri/src/domain/runtime_plugin.rs` — remove required publisher metadata from `PluginManifestV1`; preserve capabilities, endpoints, path authority, credential slots, schemas, UI, and runtime declarations.
- Modify: `src-tauri/src/domain/import_export.rs` — replace publisher requirements with exact content requirements.
- Modify: `src-tauri/src/services/plugin_package.rs` — become archive/directory structural validation shared by `PluginLoader`, or be removed after helpers move.
- Modify: `src-tauri/src/services/plugin_store.rs` — replace install/approval/publisher lifecycle with catalog snapshot lookup and atomic user archive install/remove.
- Modify: `src-tauri/src/services/package_definition.rs` — project definitions from `LoadedPlugin` and authorize privileged Host policies by `PluginSource`.
- Modify: `src-tauri/src/services/runtime_plugin_contracts.rs` — preserve manifest/capability/path/import checks without publisher inputs.
- Modify: `src-tauri/src/services/runtime_router.rs` — resolve immutable snapshots from `PluginCatalog`; Native requires `PluginSource::BuiltIn` plus allowlist.
- Modify: `src-tauri/src/services/provider_runtime_router.rs` — use catalog digest lookup.
- Modify: `src-tauri/src/services/runtime_lifecycle.rs` — use simple defaults for new instances and explicit digest upgrades for existing instances.
- Modify: `src-tauri/src/services/runtime_providers.rs` — use catalog defaults and explicit provider binding pins.
- Modify: `src-tauri/src/services/auth_policies.rs` — replace `PublisherSource::Vendor` checks with `PluginSource::BuiltIn` checks.
- Modify: `src-tauri/src/services/import_export.rs` and `import_validation.rs` — preserve exact content requirements; never install or approve content during import.
- Modify: `src-tauri/src/services/plugin_models.rs` — resolve model resources from immutable snapshots.
- Modify: `src-tauri/src/state.rs` — construct and refresh `PluginCatalog`; remove vendor roots/default activation startup.
- Modify: `src-tauri/src/cmds/plugin_packages.rs` — expose inspect/install/remove/refresh/set-default commands for the simple catalog.
- Modify: `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json` — remove activation/publisher command surface and add catalog commands with parity.
- Modify: `src-tauri/tauri.conf.json` — ship built-in plugin directories or unsigned archives without vendor trust/policy resources.

### Remove Rust signing and activation system

- Delete: `src-tauri/src/services/vendor_trust.rs`.
- Delete: `src-tauri/src/services/plugin_release_bundle.rs`.
- Delete: `src-tauri/src/services/default_package_activation/`.
- Delete: `src-tauri/src/domain/default_package_activation.rs`.
- Delete: `src-tauri/src/cmds/default_package_activation.rs`.
- Delete: `src-tauri/src/repositories/plugin_publishers.rs`.
- Delete: `src-tauri/src/repositories/plugin_package_approvals.rs`.
- Delete: `src-tauri/src/repositories/default_package_activation_policies.rs`.
- Delete or fold: `src-tauri/src/repositories/plugin_install_operations.rs`, `plugin_uninstall_operations.rs`, and `plugin_upgrade_snapshots.rs` after simple atomic file operations and explicit instance rollback replace their use.
- Delete: `src-tauri/src/bin/plugin_release_tool.rs`.
- Simplify: `src-tauri/src/bin/plugin_tool.rs` to `inspect`, `verify-structure`, and `pack` only.

### Database

- Rewrite: `src-tauri/migrations/0016_runtime_plugin_packages.sql` as the new `0016_runtime_plugin_catalog.sql`, or replace it and update the ordered migration list.
- Modify: `src-tauri/migrations/0017_runtime_plugin_instance_pins.sql` — reference simple catalog content identities only.
- Modify: `src-tauri/migrations/0018_plugin_uninstall_restored_states.sql` — remove if no longer needed, or rewrite for atomic user archive removal.
- Preserve and adapt: `0019`–`0026` where execution grants, endpoint trust, health, provider bindings, and plugin model resources remain.
- Delete: `0027_default_package_activation_policies.sql`.
- Delete: `0028_default_runtime_activation_claims.sql`.
- Delete: `0029_default_runtime_authority_approvals.sql`.
- Delete: `0031_unsigned_plugin_packages.sql`.
- Modify: `src-tauri/src/storage/migrations.rs` and tests — final unpublished schema is contiguous and fresh-only.

### Frontend

- Create: `src/features/plugins/pluginCatalogPresentation.ts` — source/runtime/default/error presentation.
- Modify: `src/features/plugins/InstalledPluginVersions.tsx` — show source, version, digest, runtime, permissions, default, reload/remove actions.
- Modify: `src/features/plugins/InstallPluginDialog.tsx` — one permission review for a user Wasm archive; remove publisher/signature/native acknowledgement UI.
- Modify: `src/features/plugins/installPluginPackageFlow.ts` — inspect then install exact digest.
- Delete: `src/features/plugins/DefaultPackageActivationDialog.tsx`.
- Delete: `src/features/plugins/DefaultRuntimeActivationStatus.tsx`.
- Delete: `src/features/plugins/DefaultRuntimeAuthorityDialog.tsx`.
- Delete: `src/features/plugins/defaultPackageActivationFlow.ts`.
- Delete: `src/features/plugins/defaultPackageActivationPresentation.ts`.
- Modify: `src/features/plugins/RuntimeLifecyclePanel.tsx` — explicit instance upgrade/rollback only.
- Modify: `src/features/plugins/PluginsLayout.tsx` — catalog refresh and source-oriented navigation.
- Modify: `src/features/models/AddProviderDialog.tsx` and `src/features/plugins/AddIntegrationDialog.tsx` — consume simple catalog defaults.
- Modify: `src/storage/types.ts`, `src/storage/client.ts`, `src/storage/bootstrap.ts` — remove publisher/signature/default-activation DTOs and commands; add catalog APIs.
- Modify: `src/i18n/locales/en.ts`, `zh-CN.ts` — source, permission, refresh, default, and user-package warning copy.
- Delete/update: related activation/signature tests and add source/catalog tests.

### Resources and tasks

- Delete: `src-tauri/resources/vendor-trust/`.
- Delete: `src-tauri/resources/plugins/default-activation-policies.json`.
- Replace: signed built-in `.lnplugin` files with unsigned structural archives or built-in directories.
- Delete: `.mise/tasks/keys/`.
- Delete: `.mise/tasks/plugin/sign-staging`.
- Delete: `.mise/tasks/plugin/generate-bootstrap-policy`.
- Delete: `.mise/tasks/plugin/verify-release-bundle`.
- Modify: `.mise/tasks/plugin/finalize-package` — become unsigned structural pack.
- Modify: `.mise/tasks/plugin/conformance` — remove signature/publisher cases; add source, digest, directory/archive equivalence, and built-in Native rules.
- Modify: `.mise/tasks/tauri/build` — run `plugin:check-builtins`, not release signature verification.
- Modify: all `runtime-plugins/*/plugin.json` — remove publisher declarations.
- Remove: `publisher.pub` and signed-package fixtures.
- Preserve/update: traversal, duplicate-path, missing-indexed-file, oversized-entry, zip-bomb, symlink, incompatible, no-WASI, permission-expansion, and native module fixtures.

### Documentation

- Create: `docs/architecture/plugin-catalog.md` — target source/trust/runtime model.
- Modify: `docs/analysis/runtime-plugin-architecture.md`.
- Modify: `docs/architecture/adapter-strategy.md`.
- Modify: `docs/plans/runtime-plugin-system/README.md`.
- Mark superseded: signing/default-activation sections of the 2026-08-21 plans.
- Modify: root `README.md` and `src-tauri/resources/plugins/README.md`.

## Seams

- **Seam:** `PluginLoader::load_directory` and `PluginLoader::load_archive` — both inputs produce the same validated immutable content identity.
- **Seam:** `PluginCatalog::refresh` — discovers all source types, applies source rules, isolates invalid user content, and publishes a deterministic catalog.
- **Seam:** `PluginCatalog::resolve_default` / `set_user_default` — built-in fallback and explicit user override without activation policies.
- **Seam:** `PluginCatalog::snapshot` — runtime receives immutable digest-addressed content and cannot execute mutable source files directly.
- **Seam:** `PluginPackageService` public inspect/install/remove commands, or their replacement catalog commands — user archive permission review and atomic file operations.
- **Seam:** `RuntimeRouter::resolve` and provider router — Wasm execution for all sources; Native only for built-in allowlisted content.
- **Seam:** `auth_policies::validate_manifest_auth_policy` — privileged Host auth drivers require `PluginSource::BuiltIn`.
- **Seam:** existing runtime lifecycle preview/apply/rollback — instance pins remain explicit and do not follow defaults silently.
- **Seam:** import preview/apply — exact content requirements are restored only when already present; no trust/default state is imported.
- **Seam:** plugin catalog IPC and React query options — UI displays source and permissions without publisher/signature concepts.

## Tasks

### Task 1: Introduce plugin source and content identity

**Seam:** `PluginLoader::load_directory` and `PluginLoader::load_archive`

**Outcome:** A directory and an archive with identical indexed content produce the same immutable digest and sanitized descriptor.

**Files:**

- Create: `src-tauri/src/domain/plugin_catalog.rs`
- Create: `src-tauri/src/services/plugin_loader.rs`
- Modify: `src-tauri/src/domain/runtime_plugin.rs`
- Modify: `src-tauri/src/services/plugin_package.rs`
- Test: `src-tauri/src/services/plugin_loader.rs`

**Steps:**

- [ ] **Red:** Add `directory_and_archive_with_identical_content_share_digest` through both loader methods.
- [ ] **Red:** Add directory tests for symlink, traversal-equivalent path, undeclared file, missing indexed file, oversized file/count, mutable-file race, and malformed manifest.
- [ ] **Green:** Add `PluginSource::{BuiltIn, Development, User}` and `PluginContentKind::{Directory, Archive}`.
- [ ] **Green:** Remove publisher fields from the manifest. Define a canonical content digest over normalized sorted relative paths and file bytes.
- [ ] **Green:** Materialize both inputs into a temporary snapshot, validate, then atomically publish under `<app-data>/plugin-cache/<digest>/`. Runtime never executes the source directory directly.
- [ ] Re-stat/re-hash source files after copy to detect mutation during materialization.

**Validation:**

- Run (red): `mise run test directory_and_archive_with_identical_content_share_digest -- --nocapture`
- Expected: fails because no common directory/archive loader exists.
- Run (green): same command.
- Expected: descriptors and content digests match.

### Task 2: Build the source-based catalog

**Seam:** `PluginCatalog::refresh`

**Outcome:** Startup discovers built-in, debug development, and user plugins with deterministic precedence and isolated errors.

**Files:**

- Create: `src-tauri/src/services/plugin_catalog.rs`
- Create: `src-tauri/src/repositories/plugin_catalog.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/domain/first_party_plugins.rs`
- Test: `src-tauri/src/services/plugin_catalog.rs`
- Test: `src-tauri/src/state.rs`

**Steps:**

- [ ] **Red:** Add `catalog_refresh_discovers_builtin_development_and_user_sources` in a debug test context.
- [ ] **Red:** Add `release_catalog_ignores_development_source`, `user_plugin_cannot_claim_first_party_id`, and `invalid_user_plugin_does_not_hide_builtins`.
- [ ] **Green:** Discover built-ins from the resolved app resource directory, user archives from `<app-data>/plugins`, and development directories only from an explicit debug environment/config path.
- [ ] **Green:** Enforce source precedence and duplicate rules. A different digest at the same source/id/version is a catalog conflict; built-in remains available.
- [ ] Return descriptors and per-entry errors in one catalog snapshot.

**Validation:**

- Run: targeted catalog tests.
- Expected: source rules and isolation pass.

### Task 3: Simplify defaults

**Seam:** `PluginCatalog::resolve_default` / `set_user_default`

**Outcome:** Built-ins are automatic defaults, user choices are one simple digest override, and existing instances remain pinned.

**Files:**

- Modify: `src-tauri/src/services/plugin_catalog.rs`
- Modify: `src-tauri/src/repositories/plugin_catalog.rs`
- Modify: `src-tauri/src/services/runtime_lifecycle.rs`
- Modify: `src-tauri/src/services/runtime_providers.rs`
- Test: catalog and lifecycle tests

**Steps:**

- [ ] **Red:** Add `builtin_is_default_without_database_policy`.
- [ ] **Red:** Add `user_default_override_changes_new_instances_only` and `missing_override_falls_back_to_builtin`.
- [ ] **Green:** Store only `plugin_id + digest + updated_at` for an explicit user override.
- [ ] Built-in fallback is deterministic. Existing instance/provider pins never change during refresh or default selection.
- [ ] Remove default activation policy/intent/claim/authority orchestration from runtime lifecycle.

**Validation:**

- Run: targeted catalog/lifecycle/provider tests.
- Expected: no automatic subject migration and package rollback still passes.

### Task 4: Simplify user archive install

**Seam:** catalog inspect/install/remove commands

**Outcome:** A user can inspect permissions and install a Wasm archive with one confirmation; publisher/signature state does not exist.

**Files:**

- Modify: `src-tauri/src/cmds/plugin_packages.rs`
- Modify: `src-tauri/src/services/plugin_store.rs`
- Modify: `src-tauri/src/domain/plugin_package.rs`
- Modify: `src/storage/types.ts`, `client.ts`
- Modify: install flow/dialog and tests

**Steps:**

- [ ] **Red:** Add `user_wasm_install_requires_matching_digest_and_permission_confirmation` through public commands.
- [ ] **Red:** Add `user_native_install_is_rejected`, `changed_archive_after_preview_is_rejected`, and `same_id_version_different_digest_is_conflict`.
- [ ] **Green:** Preview returns source, content digest, runtime, capabilities, network/auth requests, file summary, and validation errors.
- [ ] **Green:** Confirm accepts the opaque preview ID/content digest and atomically copies the archive to the user plugin directory.
- [ ] Remove public-key, signature, publisher, and risk-version fields from DTOs and UI.

**Validation:**

- Run: command/service/frontend install tests.
- Expected: Wasm install succeeds once; Native and drift fail closed.

### Task 5: Restrict Native and privileged Host auth by source

**Seam:** `RuntimeRouter::resolve` and `auth_policies::validate_manifest_auth_policy`

**Outcome:** Native workers and privileged Host auth policies are available only to built-in content.

**Files:**

- Modify: `src-tauri/src/services/runtime_router.rs`
- Modify: `src-tauri/src/services/native_workers/`
- Modify: `src-tauri/src/services/auth_policies.rs`
- Modify: `src-tauri/src/services/package_definition.rs`
- Test: runtime/auth/native tests

**Steps:**

- [ ] **Red:** Add user/development Native rejection at catalog and router seams.
- [ ] **Red:** Add user package rejection for Google/Baidu Host auth drivers.
- [ ] **Green:** Replace publisher-source checks with `PluginSource::BuiltIn`; retain first-party Native ID/version allowlist and module/model audit.
- [ ] Preserve network/path/capability/grant checks for all Wasm sources.

**Validation:**

- Run: native, auth-policy, network-handle, and Baidu/Google runtime tests.

### Task 6: Replace the package database schema

**Seam:** fresh database initialization and repository APIs

**Outcome:** A fresh unpublished database contains only the simple catalog/default schema plus preserved runtime pin/grant/resource tables.

**Files:**

- Rewrite/create migrations described in Database File Map.
- Modify: migrations runner, repositories, storage tests.

**Steps:**

- [ ] **Red:** Add `fresh_plugin_schema_contains_no_publisher_signature_or_activation_tables`.
- [ ] Assert retained tables support exact pins, user archive records, explicit defaults, grants, health, endpoint trust, provider bindings, and model resources.
- [ ] **Green:** Rewrite plugin-related migrations and remove 0027–0029/0031 from the sequence. Keep the migration list contiguous.
- [ ] Delete publisher/approval/activation repositories and update all foreign keys.
- [ ] Reset the development database after the schema compiles and tests pass.

**Validation:**

- Run: storage/migration/repository tests.
- Expected: fresh schema passes and deleted tables are absent.

### Task 7: Remove signing and activation services

**Seam:** `AppState::initialize` and command registration parity

**Outcome:** Startup constructs one catalog and no publisher, vendor trust, release policy, or default activation service.

**Files:**

- Delete/modify Rust files listed above.
- Modify: state, lib, build, ACL, AppManifest.
- Test: startup and command parity tests.

**Steps:**

- [ ] **Red:** Add `startup_loads_builtins_without_trust_root_or_activation_policy`.
- [ ] **Green:** Remove signing/default service construction and commands.
- [ ] Keep command/build/permission/capability lists exact.
- [ ] Startup log reports source counts, valid/invalid entries, and defaults without sensitive paths or contents.

**Validation:**

- Run: startup, ACL/CSP, AppManifest, and package-only checks.

### Task 8: Preserve runtime safety on the simple catalog

**Seam:** `PluginCatalog::snapshot`, routers, and Host broker

**Outcome:** Simplification removes authenticity machinery but does not weaken runtime isolation or authority.

**Files:**

- Modify: routers, runtime contracts, Wasm runtime, network broker, lifecycle tests as required.

**Steps:**

- [ ] **Red:** Re-run/adapt traversal, zip-bomb, no-WASI, permission expansion, endpoint/path, credential secrecy, token injection, cancellation, timeout, memory/fuel, stream/blob, and native process cleanup tests using source-based descriptors.
- [ ] **Green:** Replace publisher inputs with source/digest inputs only. Do not remove broker/grant checks.
- [ ] Ensure directory reload creates a new immutable digest; running instances continue using their pinned snapshot.

**Validation:**

- Run: full plugin conformance and targeted security suites.

### Task 9: Simplify import/export

**Seam:** import preview/apply

**Outcome:** Current exports carry exact content requirements without publisher or approval state.

**Files:**

- Modify: import/export domain/service/validation and fixtures.

**Steps:**

- [ ] **Red:** Add package-present, package-missing, digest-mismatch, built-in, and user-Wasm import cases.
- [ ] **Green:** Export plugin ID, version, digest, runtime, and required capabilities only.
- [ ] Import never installs archives, changes defaults, restores install approval, or authorizes grants.
- [ ] Remove old publisher/signature fields and old fixtures.

**Validation:**

- Run: import/export tests.

### Task 10: Simplify plugin UI

**Seam:** catalog query and plugin management actions

**Outcome:** UI explains source, permissions, default, install/remove/reload, and errors without trust-root concepts.

**Files:**

- Modify/delete frontend files listed above.
- Test: catalog/install/default/reload UI tests.

**Steps:**

- [ ] **Red:** Add Built-in, Development, and User presentation tests.
- [ ] **Red:** Add tests that Remove exists only for User, Reload only for Development, and Native User install is unavailable.
- [ ] **Green:** Remove signature/publisher/default-activation dialogs and DTOs.
- [ ] Keep accessible permission review for user archives.

**Validation:**

- Run: targeted Bun tests, full frontend tests, typecheck, lint.

### Task 11: Replace release and development tooling

**Seam:** `plugin:pack`, `plugin:dev-build`, and `plugin:check-builtins`

**Outcome:** Developers build directories or unsigned archives without key generation/signing/policy generation.

**Files:**

- Add/remove/modify mise tasks and plugin fixtures listed above.

**Steps:**

- [ ] **Red:** Add task-level fixtures proving directory/archive equivalence and built-in validation.
- [ ] **Green:** Remove signing/key tasks and release verifier.
- [ ] `tauri:build` validates built-in structure, source identity, Native rules, indexed files, and no-WASI where applicable.
- [ ] Update every built-in manifest and package fixture.

**Validation:**

- Run all build/conformance/check-builtins tasks and Tauri package build.

### Task 12: Remove obsolete code and document the final model

**Seam:** repository-wide production symbol and documentation checks

**Outcome:** No publisher/signature/activation code or copy remains; documentation matches the simple catalog.

**Files:**

- Modify documentation and remove obsolete files/tests/resources.

**Steps:**

- [ ] Add grep gates for `plugin_publishers`, `publisher_fingerprint`, `signature_status`, `vendor_bootstrap`, `DefaultPackageActivation`, `default_runtime_activation`, `authority_approvals`, and risk-acknowledgement symbols in production code.
- [ ] Permit historical plan references only where marked superseded.
- [ ] Document the loss of user-package authenticity and the retained runtime safety boundary.

**Validation:**

- Run grep gates and all documentation/format checks.

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
- Run: `mise run plugin:check-builtins`
- Expected: every built-in directory/archive validates; Native entries are built-in and allowlisted.
- Run: `mise run plugin:conformance all`
- Expected: all structural/runtime/security suites pass without signature cases.
- Run: `mise run plugin:check-no-wasi`
- Expected: pass.
- Run: `mise run package-only:check`
- Expected: no legacy executor and no removed trust/activation production symbol.
- Run: `mise run tauri:build`
- Expected: installers and portable package build successfully.
- Reset the dev database and run: `mise run tauri:dev`
- Expected: built-ins load, definitions/defaults are available, and no trust-root/policy resources are required.

## Failure Behavior

- Invalid built-in content — fail startup readiness with a sanitized plugin/path-relative error.
- Invalid development content — show a development catalog error; keep built-ins available.
- Invalid user archive — reject install or isolate the existing file; keep built-ins available.
- Source file changes during directory materialization — reject the refresh and keep the previous immutable snapshot.
- User archive changes after preview — reject install by digest mismatch.
- Missing explicit user default — fall back to built-in; do not mutate existing pins.
- Missing pinned snapshot — preserve instance identity and return package unavailable; do not select another digest silently.
- User/Development Native declaration — reject before install/catalog publication.
- User request for privileged Host auth — reject definition registration.
- Missing credentials — definition remains visible; instance is unconfigured and execution fails with a credential-required error.

## Privacy and Security

- Built-in authenticity relies on the application installer/update signature and protected installation resources.
- User package publisher identity is unknown and must never be presented as trusted.
- Immutable digest snapshots prevent runtime TOCTOU for directory and archive inputs.
- Archive traversal, symlink, duplicate path, undeclared file, size/count, and zip-bomb defenses remain.
- Wasm import allowlists, no-WASI, memory/fuel limits, cancellation, and output bounds remain.
- Credential bytes and references remain Host-owned and absent from manifests, guests, logs, exports, and catalog DTOs.
- Network origins, paths, methods, auth policies, response modes, and limits remain Host-validated and instance-granted.
- Native execution remains built-in-only with ID/version allowlist, module audit, handshake, model locks, timeout, cancellation, and process-tree cleanup.

## Rollout Notes

- This is a replacement implementation, not an incremental compatibility migration.
- Work on a dedicated branch/worktree. Do not mix it with signing-system stabilization changes.
- Reset the development database after Task 6. Preserve the credential vault only if manual testing needs it; old database references are unsupported.
- Regenerate all 10 built-in packages without publisher/signature files.
- Remove production signing seeds from this workflow. Keep any archived key material outside the repository; it is no longer used by the app.
- Release artifacts rely on Tauri application signing, not internal plugin signatures.

## Risks and Mitigations

- **User packages have no authenticated publisher.** — State this clearly, allow Wasm only, require permission review, and keep Host sandbox/grants.
- **Built-in resources can be modified after installation on an unprotected system.** — Rely on installer/update integrity and immutable runtime snapshots; document this reduced threat model.
- **Directory source loading creates TOCTOU risk.** — Materialize and execute digest-addressed snapshots, never the mutable source path.
- **Removing activation orchestration can change existing instances unexpectedly.** — Defaults affect new instances only; existing instances remain digest-pinned and use explicit lifecycle upgrade/rollback.
- **Native trust becomes location-based.** — Require built-in source plus fixed ID/version allowlist and retain module/process audit.
- **Schema rewrite touches many tests.** — Complete vertical slices and keep all runtime security suites active; do not batch-delete tests before replacement coverage exists.
- **Development source builds can execute build scripts.** — Enable only in debug, require an explicit developer directory, and never run build hooks for user archives.
- **Simplification can accidentally remove runtime authorization with supply-chain code.** — Task 8 explicitly preserves and revalidates every broker/grant/resource boundary.

## Open Questions

None for planning. The plan uses the recommended hybrid: built-in trusted plugins, debug source directories, user Wasm archives, and built-in-only Native workers.
