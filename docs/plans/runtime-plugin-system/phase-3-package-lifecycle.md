# Phase 3: Signed Plugin Package Lifecycle Implementation Plan

**Goal:** Support crash-safe local installation, approval, immutable storage, listing, default selection, and dependency-safe removal of signed `.lnplugin` packages without executing them.

**Inputs:** Phases 0–2 contracts/runtime and current SQLite migration/credential-journal patterns.

**Assumptions:**

- Phases 0, 1, and 2 are complete.
- Package execution is disabled until Phase 4.
- Package format is a bounded ZIP archive.
- `package_digest` is lowercase hex SHA-256 of the exact final signed `.lnplugin` archive bytes; extracted payload digests are authenticated through the signed manifest file index. Repacking identical files intentionally creates a different package identity.
- Current dependency baselines are `zip 8.6.x`, `ed25519-dalek 3.0.x`, `semver 1.0.x`, and `hex 0.4.x`; exact patch versions are committed in `Cargo.lock`.

**Architecture:** Rust previews archives in a bounded staging area, verifies exact archive/manifest bytes, the complete signed file index, signature, publisher trust, compatibility, and requested permissions, then atomically moves both the original archive and verified extracted content into a SHA-256-addressed store. Approval state and package metadata live in SQLite; code files are never mutable in place.

**Tech Stack:** Rust, zip, ed25519-dalek, SHA-256, SQLite/rusqlite, Tauri dialog IPC, React/Base UI, TanStack Query.

---

## Dependencies

- Phase 0 contracts/security.
- Phase 1 catalog/schema control plane.
- Phase 2 conformance runtime available but not connected to installed packages.

## File Map

- Create: `src-tauri/migrations/0016_runtime_plugin_packages.sql` — publishers, installed versions, package approvals, install operations, defaults.
- Create: `src-tauri/src/domain/plugin_package.rs` — package/install DTOs and states.
- Create: `src-tauri/src/repositories/plugin_publishers.rs` — trusted publisher keys/fingerprints.
- Create: `src-tauri/src/repositories/installed_plugin_versions.rs` — immutable version metadata/defaults.
- Create: `src-tauri/src/repositories/plugin_package_approvals.rs` — install/trust approval revisions with no execution authority.
- Create: `src-tauri/src/repositories/plugin_install_operations.rs` — crash recovery journal.
- Create: `src-tauri/src/services/plugin_package.rs` — archive parse/signature/digest/compatibility validation.
- Create: `src-tauri/src/services/plugin_store.rs` — staging/store/quarantine lifecycle and recovery.
- Create: `src-tauri/src/cmds/plugin_packages.rs` — preview/install/list/default/uninstall commands.
- Create: `src/features/plugins/InstallPluginDialog.tsx` — local package selection and review.
- Create: `src/features/plugins/InstalledPluginVersions.tsx` — package/version/default/remove UI.
- Modify: `src-tauri/src/storage/migrations.rs` — register migration 0016.
- Modify: `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/cmds/mod.rs` — export package modules.
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/events.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json` — compose services, register commands, update the AppManifest/ACL, and emit events.
- Modify: `src/storage/types.ts`, `src/storage/client.ts` — package IPC DTO/client.
- Modify: `src/query/keys.ts`, `src/query/options.ts`, `src/query/events.ts`, `src/query/dataChangeEventBindings.ts` — package queries/invalidation.
- Modify: `src/features/plugins/PluginsLayout.tsx` — package-management entry.
- Modify: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` — archive/signature/version dependencies.
- Create: `.mise/tasks/plugin/verify`, `.mise/tasks/plugin/finalize-package` — offline verification and canonical signed-archive finalization.
- Test: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/repositories/tests.rs`, package service inline tests, and `src/features/plugins/` tests.

## Tasks

### Task 1: Persist publishers, versions, package approvals, and install operations

**Outcome:** SQLite can represent immutable packages and installation approvals without creating reusable execution authority.

**Files:**

- Create: `src-tauri/migrations/0016_runtime_plugin_packages.sql`, `src-tauri/src/domain/plugin_package.rs`, `src-tauri/src/repositories/plugin_publishers.rs`, `src-tauri/src/repositories/installed_plugin_versions.rs`, `src-tauri/src/repositories/plugin_package_approvals.rs`, `src-tauri/src/repositories/plugin_install_operations.rs`
- Modify: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/repositories/mod.rs`
- Test: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/repositories/tests.rs`

**Steps:**

- [ ] Add publisher key records with key ID, fingerprint, public key, source (`vendor | user_approved`), enabled/revoked state, and timestamps.
- [ ] Add installed versions keyed by package digest with unique `(plugin_id, version)` and stored manifest/runtime/schema metadata.
- [ ] Add monotonically versioned package approvals bound to package digest, publisher decision, and requested-permission digest. Package approval permits installation/catalog availability only; it never authorizes network, auth, Blob/Stream, page, or capability execution and is never supplied to the runtime router.
- [ ] Reserve execution grant sets for Phase 4, where one revision binds exactly one integration/provider instance and package while containing reviewed capability/page authority entries; never reuse package approval IDs as grant-set revisions.
- [ ] Add per-plugin default package digest used only for new instances.
- [ ] Add install-operation journal states `prepared | verified | db_committed | finalized | failed` with staging path and digest.
- [ ] Use foreign keys/`ON DELETE RESTRICT` so referenced versions/approvals cannot be removed.
- [ ] Register migration 0016 and test fresh plus 0015→0016 upgrades.

**Validation:**

- Run: `mise run test migrate_ -- --nocapture`
- Run: `mise run test installed_plugin -- --nocapture`
- Expected: schema constraints, uniqueness, defaults, revisions, and restrictions pass; tests prove a package approval cannot satisfy an execution-grant-set lookup.

### Task 2: Implement bounded archive and signature verification

**Outcome:** Untrusted archives can be previewed without writing outside staging or trusting declared metadata prematurely.

**Files:**

- Create: `src-tauri/src/services/plugin_package.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
- Test: inline tests in `src-tauri/src/services/plugin_package.rs` and `runtime-plugins/conformance/fixtures/packages/`

**Steps:**

- [ ] Enforce named limits for archive bytes, entry count, per-entry bytes, total decompressed bytes, path length/depth, manifest/schema/UI size, and decompression ratio.
- [ ] Reject absolute paths, `..`, Windows prefixes, alternate separators after normalization, symlinks, duplicate normalized paths, invalid UTF-8 paths, device names, and undeclared files.
- [ ] Stream the exact archive bytes through SHA-256 before extraction; encode lowercase hex as `package_digest` and verify committed test vectors for empty/valid sample archives.
- [ ] Read exact `plugin.json` bytes, parse `PluginManifestV1`, require archive entries to equal `plugin.json` + `signatures/manifest.sig` + the signed file index, and verify the length/digest/role of every indexed artifact, schema, locale, license, icon, and page asset.
- [ ] Verify `signatures/manifest.sig` over the exact manifest bytes using the selected publisher key; reject missing indexed files, unindexed files, and any manifest/file-index mismatch before preview.
- [ ] Reject same `plugin_id + version` with a different digest.
- [ ] Validate host/plugin API, platform/architecture, runtime kind, schemas, capabilities, and permission requests before returning a preview.
- [ ] Do not treat a valid signature as automatic publisher approval.

**Validation:**

- Run: `mise run test plugin_package -- --nocapture`
- Expected: valid fixtures preview; traversal, symlink, duplicate, zip-bomb, digest, signature, compatibility, and undeclared-file fixtures fail closed.

### Task 3: Implement the content-addressed store and recovery

**Outcome:** Verified packages are installed atomically and interrupted installs reconcile safely.

**Files:**

- Create: `src-tauri/src/services/plugin_store.rs`
- Modify: `src-tauri/src/state.rs`
- Test: inline tests in `src-tauri/src/services/plugin_store.rs`

**Steps:**

- [ ] Use `app_data/plugins/staging/<operation-id>/`, `app_data/plugins/store/sha256/<digest>/package.lnplugin`, `app_data/plugins/store/sha256/<digest>/content/`, and `app_data/plugins/quarantine/`.
- [ ] Copy the selected archive into a newly created same-filesystem staging operation as `package.lnplugin`, hash those exact stored bytes, then extract only into `content/`.
- [ ] Perform parse, digest, signature, compatibility, and permission preview before DB commit.
- [ ] After explicit approval, persist package-approval/install metadata, atomically rename the operation directory containing the original archive and extracted content, finalize the journal, then emit a catalog event.
- [ ] Set installed files read-only where supported; Phase 4 rehashes `package.lnplugin` against `package_digest` and separately verifies the selected runtime artifact against its signed file-index length/digest/role before load.
- [ ] Recover prepared/verified/db-committed operations at startup without executing code.
- [ ] Mark DB-installed but missing content as unavailable; never delete instances/bindings.

**Validation:**

- Run: `mise run test plugin_store -- --nocapture`
- Expected: injected failures at every transition leave either no installation or one complete immutable installation.

### Task 4: Add install preview and approval IPC

**Outcome:** Frontend can inspect requested identity/permissions before installation.

**Files:**

- Create: `src-tauri/src/cmds/plugin_packages.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/cmds/mod.rs`, `src-tauri/build.rs`, `src-tauri/permissions/app-commands.toml`, `src-tauri/capabilities/trusted-app.json`, `src-tauri/src/events.rs`
- Modify: `src/storage/types.ts`, `src/storage/client.ts`, `src/query/keys.ts`, `src/query/options.ts`, `src/query/events.ts`, `src/query/dataChangeEventBindings.ts`

**Steps:**

- [ ] Add commands for preview, approve/install, discard preview, list versions, set default, list publishers, approve/revoke user publisher, and uninstall unused version.
- [ ] Use an opaque preview ID; do not accept a frontend path or parsed manifest during approval.
- [ ] Bind preview to file identity/digest and expire it after a named interval.
- [ ] Return sanitized manifest, publisher fingerprint/state, runtime, capabilities, schemas, requested origins/methods/auth policies, and permission differences only.
- [ ] Emit `data://plugin-packages-changed` after committed mutations.
- [ ] Add each command to the `invoke_handler`, `AppManifest` command list, `app-commands` permission set, and trusted-app capability coverage in the same change; extend the Phase 0 three-way coverage test so omission from any set fails.

**Validation:**

- Run: `mise run test plugin_package_commands -- --nocapture`
- Run: `mise run test runtime_plugin_security -- --nocapture`
- Run: `bun test src/query/dataChangeEventBindings.test.ts src/query/keys.test.ts`
- Expected: preview/approval binding, expiry, event invalidation, and secret/path omission pass.

### Task 5: Build package-management UX

**Outcome:** Users can install local packages, review permissions, manage trust/defaults, and remove unused versions.

**Files:**

- Create: `src/features/plugins/InstallPluginDialog.tsx`, `src/features/plugins/InstalledPluginVersions.tsx`
- Modify: `src/features/plugins/PluginsLayout.tsx`, `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`
- Test: `src/features/plugins/pluginPackagePresentation.test.ts`

**Steps:**

- [ ] Use the Tauri dialog plugin to select one `.lnplugin`; Rust owns file reading.
- [ ] Show plugin/version/digest, publisher fingerprint/trust, capabilities, runtime, requested network/auth permissions, and install warnings.
- [ ] Require explicit confirmation for a new user publisher and a separate package approval acknowledging requested permissions; state clearly that instance execution grant sets are created later per instance/package with capability/page authority entries.
- [ ] Mark one installed version as default for new instances; explain that existing instances remain pinned.
- [ ] Disable uninstall only while pending; backend `in_use` remains authoritative.
- [ ] Keep executable code disabled/unselectable until Phase 4.

**Validation:**

- Run: `bun test src/features/plugins`
- Run: `mise run typecheck && mise run lint`
- Manual: preview valid/invalid packages and manage defaults under `mise run tauri:dev`.
- Expected: UI displays authoritative status and cannot bypass approval or dependency checks.

### Task 6: Add offline package tooling and fixtures

**Outcome:** Developers can build deterministic positive/negative package fixtures without package.json scripts.

**Files:**

- Create: `.mise/tasks/plugin/verify`, `.mise/tasks/plugin/finalize-package`
- Create: `runtime-plugins/conformance/fixtures/packages/`
- Test: fixture manifest/file-index/archive-digest list

**Steps:**

- [ ] Add valid vendor-signed, user-signed, unsigned, corrupted, traversal, symlink, duplicate, oversized, incompatible, permission-expanding, unindexed-file, missing-indexed-file, and locale/license-tamper fixtures.
- [ ] Store test private keys only under test fixtures; exclude them from bundle resources and production trust roots.
- [ ] Make `plugin:verify` call the project Rust verifier and forward arguments.
- [ ] Make `plugin:finalize-package` accept a deterministic staging tree containing the externally produced `signatures/manifest.sig`, revalidate the signed file index, write a canonical final `.lnplugin`, and emit `<archive>.sha256` from the final archive bytes. It must never read a private key or mutate `plugin.json` during finalization.

**Validation:**

- Run: `mise run plugin:finalize-package runtime-plugins/conformance/fixtures/packages/staging/signed-valid runtime-plugins/conformance/fixtures/packages/signed-valid.lnplugin`
- Run: `mise run plugin:verify runtime-plugins/conformance/fixtures/packages/signed-valid.lnplugin`
- Expected: canonical finalization is byte-reproducible, the emitted SHA-256 matches the final archive identity, valid package verifies, and each negative fixture expects the documented stable error code.

## Final Validation

```bash
mise run test plugin_package -- --nocapture
mise run test plugin_store -- --nocapture
mise run test installed_plugin -- --nocapture
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run tauri:dev
```

Expected: packages can be previewed/approved/installed/listed/defaulted/removed safely, but installed external code still cannot execute.

## Failure Behavior

- Invalid/untrusted package — reject or quarantine; no catalog row.
- User declines requested-permission acknowledgement/publisher — delete staging and retain no package approval.
- Crash after DB commit — startup recovery finalizes or marks missing content without execution.
- In-use uninstall — return `in_use` with dependencies.
- Revoked publisher — installed package remains visible but cannot become default/newly activate until policy resolution.

## Privacy and Security

- Signing private keys are never bundled.
- Preview DTOs contain no absolute paths or archive bytes.
- Approval is bound to exact package and permission request digests.
- Package UI assets are stored but not loaded in this phase.

## Rollout Notes

- Seed vendor public keys through bundled resources or Rust constants, not SQLite migration SQL.
- Package management may ship disabled behind a compile-time feature until Phase 4 is ready.

## Risks and Mitigations

- Archive parser vulnerabilities — strict limits, updated zip crate, adversarial fixtures, no symlink extraction.
- Key compromise — publisher enable/revoke state and exact digest pinning; remote revocation operations wait for later distribution scope.
- Disk tampering — digest verification before execution and immutable content-addressed paths.

## Open Questions

None blocking Phase 3.
