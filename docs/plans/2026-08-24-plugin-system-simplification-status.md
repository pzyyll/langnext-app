# Plugin System Simplification — Delivery Status

**Plan:** `docs/plans/2026-08-24-plugin-system-simplification-plan.md`
**Branch:** `feat/package-only-migration` (worktree `package-only-migration`)
**Date:** 2026-09-10 (round 4)
**State:** Tasks 1–12 complete and fully checked. Round 4 is the final residual audit and
minimal-fix pass. Every plan validation command passes. No test is quarantined,
feature-gated, or assertion-relaxed to reach this state.

---

## Round 4 — Final residual audit and minimal fixes

**State:** Tasks 1–12 confirmed complete and internally consistent. The audit found residual
vocabulary, dead code left by the migration, and two silent holes in the audit gate. All are
fixed. No production behaviour, DTO, IPC, schema, archive, or task flow changed except where it
named a removed concept.

### Plan consistency

`2026-08-24-plugin-system-simplification-plan.md` now has every task 1–12 checkbox checked. The
last open item, Task 6 “Reset the development database after the schema compiles and tests pass”,
is complete (the round-3 fresh-state verification above records the backup, reset, and clean
launches). No task checkbox is unchecked.

### Dead code removed (zero callers after the migration)

- `RuntimeLifecycleService`: the `#[cfg(test)]` TOCTOU hooks `auto_pin_between_verify_and_apply`
  and `auto_pin_after_final_revalidate` plus their setters/takers. The tests that called them were
  adapted when the auto-pin flow was removed; nothing referenced the hooks any more.
- `edge_tts_effective_origin_is_vendor_default` and the private `EDGE_TTS_VENDOR_DEFAULT_ORIGIN`
  in `services/runtime_lifecycle.rs` — the retired auto-pin qualification had no caller.
- `EDGE_TTS_VENDOR_DEFAULT_ORIGIN` in `services/edge_tts_runtime.rs` — unused public const. The
  module it lived in was deleted in the final cleanup pass; see Remaining.
- `STALE_AUTHORIZED_DEFAULT_CODE` in `services/runtime_providers.rs` — no producer or consumer.

### Removed vocabulary corrected in production comments and messages

- “Signed package / signed manifest / signed file index / signed index” became
  “package / manifest / manifest file index / package index” in `provider_runtime_router.rs`,
  `runtime_router.rs` (including four runtime error messages), `runtime_plugin_contracts.rs`,
  `runtime_providers.rs`, `runtime_lifecycle.rs`, `plugin_models.rs`, `service_integrations.rs`,
  `service_integration_registry.rs`, `service_capabilities.rs`, `storage/client.ts`,
  `adapterOptions.ts`, `executor.ts`, `AddManualModelDialog.tsx`, `EditModelConfigDialog.tsx`,
  `AddProviderDialog.tsx`, `ProviderEditor.tsx`, `PluginModelResourcesPanel.tsx`,
  `pluginModelDownloadFlow.ts`, and `runtimeExecutor.test.ts`.
- “Vendor package / vendor-root / vendor default / vendor bootstrap” became
  “built-in package / catalog snapshot / catalog default / catalog refresh” in
  `edge_tts_runtime.rs`, `plugin_models.rs`, `providers.rs`, `service_integrations.rs`, and
  `service_integration_registry.rs`.
- “Publisher trust / publisher identity” as an existing concept was removed in `events.rs`
  (event doc), `service_capabilities.rs`, `runtime_providers.rs`, and `import_validation.rs`;
  `domain/first_party_plugins.rs` now says non-built-in content cannot claim a first-party id.
- “Revoked binding” became “unavailable binding” in `cmds/runtime_providers.rs`,
  `provider_runtime_router.rs`, `executor.ts`, `errors.ts`, and `translationContext.ts`.
- “Authority confirmation” became package-first activation in `provider_runtime_bindings.rs`;
  “subject authority confirmation” was removed from `edge_tts_runtime.rs`.
- Default-activation/authority-approval and “trust + permission approval” wording was removed
  from `domain/import_export.rs` and `services/import_validation.rs`; the same comment now says
  “built-in” instead of “bundled”.
- Test names `runtime_rejects_{archive,artifact}_replaced_after_auto_pin_before_execution` were
  renamed to `..._after_activation_before_execution` in `google_translate_web_runtime_tests.rs`.

Statements that a removed concept is absent stay: “no authenticated publisher identity” user
warning, `Publisher identity is unknown`, “no plugin-level signature or publisher declaration”,
and the negative migration/import assertions.

### Audit gate holes closed

- ripgrep skips files that contain NUL bytes as binary. Three Rust modules embedded raw NUL bytes
  inside Wasm test fixtures (`state.rs`, `services/package_definition.rs`,
  `services/plugin_catalog.rs`), so `package-only:check` never scanned them. The raw bytes are now
  `\x00` escapes (identical byte values), so the files are plain text again.
- Every source scan in `package-only:check` now passes `--text`, so a future raw control byte
  cannot hide a file from the gate. The shipped-archive scan stays binary-safe.
- The removed-symbol pattern now also rejects `vendor bootstrap`, `authority confirmation`, and
  `LANGNEXT_BUNDLED`.

### Development tooling residuals

- `smoke/google-cloud`, `smoke/paddleocr`, and `smoke/runtime-providers` exported
  `LANGNEXT_BUNDLED_*` package variables that no Rust code reads (the bundled-package seeding
  reader was removed with the simplification). The dead exports and their `native_path` helpers
  are deleted. The launch text now states that the app uses the shipped built-in package; the
  automated preflight, focused-test, and conformance stages are unchanged.
- The PaddleOCR walkthrough no longer instructs the operator to remove an instance with
  `runtimeKind=bundled-rust` or says “auto-pins the smoke package”.

### Verified invariants

| Check                | Result                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10 built-in archives | `plugin.json` plus exactly the manifest-indexed payload; no `publisher.pub`, no `signatures/manifest.sig`, no `publisher` field                                      |
| Conformance fixtures | only `legacy-publisher-key.lnplugin` and `legacy-signature-entry.lnplugin` carry trust entries (deliberate fail-closed fixtures)                                     |
| Removed resources    | `resources/vendor-trust/` and `resources/plugins/default-activation-policies.json` absent; `tauri.conf.json` ships only `resources/plugins/`                         |
| Removed tasks        | `.mise/tasks/keys/`, `plugin/sign-staging`, `plugin/verify`, `plugin/verify-release-bundle`, `plugin/finalize-package`, `plugin/generate-bootstrap-policy` absent    |
| Removed commands     | no occurrence of the removed command names in the Rust command registry or `src/`                                                                                    |
| Import/export        | Rust and TS DTOs carry only plugin id/version, runtime kind, digest, API version, schema version, and required capability majors; status and action sets are closed  |
| Frontend copy        | the only publisher wording is the required user-content statement (“no authenticated publisher identity. Installation is a permission review, not publisher trust.”) |
| Orphans              | 0 Rust orphan modules (excluding `mod.rs` and `bin/` targets); 0 unreferenced frontend modules (excluding the entry and test-setup files)                            |

### Round-4 verification commands

```bash
mise run test                    # 986 passed, 0 failed, 3 ignored (232 s)
mise run test-frontend           # 495 passed, 0 failed, 2710 expect() calls
mise run typecheck               # pass
mise run lint                    # pass
mise run format:check            # pass (468 files)
mise run build                   # pass
mise run plugin:check-builtins   # 10 built-in sources validated
mise run plugin:conformance all  # pass
mise run plugin:check-no-wasi    # pass (15 guest-import tests, no WASI)
mise run package-only:check      # pass (with the strengthened gates)
cargo check --all-targets        # pass, 0 warnings
```

### Remaining (known non-blocking items)

- `services/edge_tts_runtime.rs` was deleted. It had no importer (`rg "edge_tts_runtime::"` and
  LSP find-references both returned nothing; the only match was its own `pub mod` declaration),
  no `Cargo.toml` binary or `#[path]` entry, and no reader for any of its constants. The
  `pub mod edge_tts_runtime;` declaration is removed. `services/edge_tts_runtime_tests.rs` stays
  because it imports `services::edge_tts` directly. The endpoint alias and the synthesize path
  have their own definitions in `services/wasm_runtime/host.rs`, so no value is lost.
- No frontend test fixture uses a retired runtime kind as a convenient value. Every
  `IntegrationInstanceDto`, `RuntimeIdentityDto`, and `ProviderInstanceDto` fixture carries a
  legal `wasm-component` identity with the package digest and grant revision of that binding. The
  only remaining `bundled-rust` occurrence is the deliberate fail-closed assertion in
  `pluginPackagePresentation.test.ts` (`isPackageExecutionEnabled` must return false). The
  `src-tauri` occurrences are the deliberate import and parse rejection tests.
- The package-only catalog does not let a development directory or a user archive replace a
  reserved first-party plugin id, so the interactive smoke walkthroughs exercise the shipped
  built-in package. Fixture-specific validation stays in the automated preflight and conformance
  suites.

---

## Round 3 outcome

The simplification is finished end to end. Publisher, signature, vendor-trust, and
default-activation concepts are gone from the manifest format, the load path, the shipped
archives, the release tooling, the frontend, the import/export format, and the documentation.

- The 10 shipped built-in `.lnplugin` archives were regenerated without a `publisher` block,
  without `publisher.pub`, and without `signatures/manifest.sig`. Each archive now contains
  `plugin.json` plus exactly the manifest-indexed payload.
- `PluginManifestV1` no longer accepts a `publisher` field (`deny_unknown_fields` rejects it),
  and `PublisherDeclaration`, `PublisherKeyId`, `PublisherKeyFingerprint`, `SIGNATURE_FILE_PATH`,
  and `PUBLISHER_PUBLIC_KEY_PATH` are deleted.
- A leftover trust entry is now **rejected**, not tolerated: the loader reports it as an
  undeclared file. The `LEGACY_TRUST_PATHS` tolerance list and the digest exclusion are deleted.
- `src-tauri/resources/vendor-trust/` and
  `src-tauri/resources/plugins/default-activation-policies.json` are deleted, and
  `tauri.conf.json` ships only `resources/plugins/`.
- `tauri:build` runs `plugin:check-builtins` instead of a signing-verification gate.
  `plugin:finalize-package` became `plugin:pack`; `plugin:dev-build` was added.
- Production source, the release binary, and the MSI contain no removed trust vocabulary
  (verified by the `package-only:check` gates and by binary string inspection).

### Test totals

| Suite                             | Result                                                       |
| --------------------------------- | ------------------------------------------------------------ |
| `mise run test`                   | 986 passed, 0 failed, 3 ignored (~192 s)                     |
| `mise run test-frontend`          | 495 passed, 0 failed (74 files)                              |
| `mise run plugin:conformance all` | 33 suites ok, every required name present and not ignored    |
| `mise run plugin:check-builtins`  | 10 built-in sources validated                                |
| `mise run plugin:check-no-wasi`   | 15 guest-import tests, no WASI in host tree or guest imports |
| `cargo check --all-targets`       | 0 warnings                                                   |

The 3 ignored Rust tests are pre-existing and deliberate: two credential-vault tests require an
interactive OS credential store session, and one Wasm runtime test is an on-demand performance
measurement. No suite was ignored to make this work.

---

## Task 9 — Import/export carries content identity only

**Removed from the format.** `RuntimeRequirementExport` and `ProviderRuntimeRequirementExport`
no longer have `publisherKeyId` or `publisherKeyFingerprint`; `RuntimeRequirementExport` also
dropped the unused reserved `providerRuntimeKind`/`providerPackageDigest` fields and now sets
`deny_unknown_fields`. `ImportRuntimeRequirementPreview` no longer carries publisher identity.
An export therefore contains plugin id, version, runtime kind, exact content digest, plugin API
version, config schema version, and required capability majors only.

**Old documents fail closed.** A v8 document that still carries `publisherKeyId`,
`publisherKeyFingerprint`, `signatureStatus`, `providerRuntimeKind`, or
`providerPackageDigest` is rejected at parse with an unknown-field error naming the offending key
(`v8_unknown_and_removed_fields_fail_closed`). There is no compatibility path and no ignored
optional field. The committed import fixture
`src-tauri/src/services/fixtures/import/runtime-plugin-v8/v8-mixed.json` was cleaned.

**Closed status/action set.** `ImportRuntimeLocalStatus` is
`missing | digest_mismatch | incompatible | installed`, and `ImportRuntimeRequiredAction` is
`install_exact_package | resolve_digest_mismatch | resolve_incompatibility | activate_after_import`.
`revoked`, `disabled`, `content_unavailable`, `bundled`, `legacy`, `restore_publisher`, and
`none` had no producer and are deleted from the Rust enums, the TypeScript unions, the i18n copy,
and the presentation order.

**Resolution rule.** `local_content_identity` resolves an exact digest against the immutable
catalog first (so built-in content is found) and against recorded `plugin_user_archives` rows
second (an unresolved imported pin whose file is not in the current snapshot). A locally present
identity at a different digest is `digest_mismatch`; a present digest whose runtime kind
contradicts the requirement is `incompatible`; absent content with no local claim on the identity
is `missing`.

**Import is never a mutation.** Applying a document whose content is present records the exact pin
as `pending_activation` with no grant revision; absent content stays `unavailable` with
`package_digest` NULL and a closed reason. Import writes no user archive, changes no catalog
default, and creates no execution grant — asserted by
`import_apply_never_installs_changes_defaults_or_grants`, which counts `plugin_user_archives`,
`plugin_default_overrides`, `execution_grant_sets`, and the user plugin directory before and after.

New tests: `import_runtime_requirement_preview_resolves_builtin_and_user_content`,
`import_apply_never_installs_changes_defaults_or_grants`,
`v8_package_backed_requirement_parses_without_publisher_metadata`,
`v8_unknown_and_removed_fields_fail_closed`.

---

## Task 10 — Plugin management UI audited and covered

`InstalledPluginVersions` action gating was already correct and is now pinned by a new test file,
`src/features/plugins/InstalledPluginVersions.test.tsx` (8 tests; the component had no test before):

| Requirement                                                     | Test                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Built-in / Development / User presentation                      | `every source renders its own label without trust or signature wording`          |
| Remove exists only for user content                             | `remove exists only for user content`                                            |
| Reload exists only for development content                      | `reload exists only for development content`                                     |
| Native user content is not installable and has no reload action | `native content is listed without a reload action and is never user-installable` |
| Remove sends the exact content digest                           | `removing a user archive sends its exact content digest`                         |
| Built-in automatic default cannot be cleared; override can      | `the built-in default cannot be cleared but a user override can`                 |
| Non-default built-in can receive an explicit override           | `a non-default built-in can be given an explicit default override`               |
| Catalog errors stay visible next to valid entries               | `catalog errors are reported without hiding valid entries`                       |

Copy and DTO cleanup: import-preview publisher rows, the `bundled`/`legacy`/`revoked`/`disabled`/
`content_unavailable` statuses, the `restore_publisher`/`none` actions, the
`runtimeDetailPublisherKeyId`/`runtimeDetailPublisherFingerprint` labels, and the
`statusLegacy`/"signed package" copy are deleted. The only remaining publisher wording is the
required user-content statement ("no authenticated publisher identity. Installation is a
permission review, not publisher trust."), and it renders for user content only.

The orphan module `useAcknowledgedPreviewDialog.ts` (shared controller of the deleted activation
dialogs, no remaining consumer) was deleted.

---

was deleted.

---

## Task 11 — Release and development tooling replaced

**Built-ins regenerated.** All 10 shipped archives were repacked from their extracted payload with
the two trust entries removed and the `publisher` block stripped from `plugin.json`. Payload bytes
are unchanged, so every indexed SHA-256 still matches. The same treatment was applied to the 9
committed fixture copies under `runtime-plugins/`.

**Templates updated.** `runtime-plugins/**/plugin*.json` (16 files, including the conformance
component manifests and the Google Translate Web 1.1.0 manifest) no longer declare a publisher.

**Fixtures updated.** `runtime-plugins/conformance/fixtures/packages/` holds no key material and no
staging tree. `bad-signature`, `user-signed`, and `signed-valid` are deleted;
`unsigned.lnplugin` became `valid-archive.lnplugin`; `legacy-signature-entry.lnplugin` and
`legacy-publisher-key.lnplugin` encode the new fail-closed rule; `llm-provider-valid.lnplugin` was
regenerated as a valid unsigned provider package. The traversal, symlink, duplicate-path,
undeclared-file, missing-indexed-file, locale-tamper, incompatible, target-incompatible,
oversized-entry, zip-bomb, and permission-declaring fixtures are preserved without trust entries.

These fixtures are live, not orphaned: `src-tauri/src/services/conformance_package_fixtures.rs`
loads every one of them through the real `PluginLoader` and pins its expected outcome
(`committed_archive_fixtures_keep_their_expected_outcome`), plus
`fixture_directory_has_no_trust_material`, which fails if signing key or trust material returns to
the directory.

**Task descriptions and helper scripts.** Every `#MISE description` that still said "release CI
signs externally" or "signed ... fixture package" was rewritten, the `build-edge-tts` and
`build-google-web` verifier messages no longer say "signed file index", the
`build-paddleocr-worker` comment no longer says "signed package inventory", and the
`smoke:runtime-providers` walkthrough prose no longer says "attached signed runtime interfaces".
`scripts/build-google-cloud-manifest.js` was migrated with its caller: it no longer takes a public
key argument and no longer asserts `manifest.publisher.*`. The caller and callee were re-verified
together by running the script against the regenerated shipped archive contents (`ok: Google Cloud
manifest verified (files=10, update=false)`), and all 9 regenerated fixture archives pass
`plugin_tool verify-structure`.

**Tasks.** `plugin:pack` (`<plugin-dir> <out.lnplugin>`) replaced `plugin:finalize-package`, and
`plugin:dev-build` (`<plugin-dir>`) was added. Every `build-*`, `refresh-*-fixture`, and `smoke/*`
script lost its public-key input, fingerprint checks, `publisher.pub` writes, `signatures/`
staging, `plugin:sign-staging`/`plugin:verify`/`plugin:verify-release-bundle` calls, and temporary
vendor trust root. `tauri:build` runs `plugin:check-builtins` before packaging. All changed task
files pass `bash -n`, and every remaining `mise run plugin:*` reference resolves to a real task.

---

## Task 12 — Obsolete code removed, final model documented

**Grep gates.** `mise run package-only:check` now fails when production source or scripts name a
removed symbol: `plugin_publishers`, `plugin_package_approvals`, `publisher_fingerprint`,
`publisher_key_id`, `publisherKeyId`, `publisherKeyFingerprint`, `publisher.pub`,
`SIGNATURE_FILE_PATH`, `PUBLISHER_PUBLIC_KEY_PATH`, `signatures/manifest.sig`, `signature_status`,
`vendor_trust`, `LANGNEXT_VENDOR_TRUST_JSON`, `vendor_bootstrap`, `generate-bootstrap-policy`,
`default-activation-policies`, `DefaultPackageActivation`, `default_runtime_activation`,
`authority_approvals`, `risk_acknowledgement`, `plugin_release_tool`, `installed_plugin_versions`,
`plugin_install_operations`, `plugin_uninstall_operations`. It also fails when
`resources/vendor-trust/` or `default-activation-policies.json` exists, or when shipped plugin
content contains a trust entry. Documentation is excluded from the symbol scan, so a document may
state that a symbol is gone.

**Stale vocabulary removed from code documentation.** Module and item docs in
`edge_tts_runtime.rs`, `native_worker.rs`, `native_workers/mod.rs`,
`native_workers/module_audit.rs`, `plugin_model.rs`, `plugin_models.rs`, `runtime_plugin.rs`,
`runtime_provider.rs`, `auth_policies.rs`, `plugin_tool.rs`, the `plugin_models` command module,
`runtime_providers.rs`, `package_definition.rs`, and `edge_tts_runtime_tests.rs` no longer describe
signed packages, publisher keys, or vendor roots.

**Orphan check.** Every `.rs` file under `src-tauri/src` is reachable from the module tree (0
orphans). The frontend has no unreferenced non-test module after the hook deletion above.

**Documentation.** `docs/architecture/plugin-catalog.md` is new and is the authoritative
description of sources, discovery, content identity, trust limits, defaults, the retained runtime
safety boundary, import/export rules, developer tasks, and failure behavior.
`docs/analysis/runtime-plugin-architecture.md`, `docs/architecture/adapter-strategy.md`,
`docs/plans/runtime-plugin-system/README.md`, and the root `README.md` were updated. Historical
plans that described signing, vendor trust, or default activation carry a
`Superseded (2026-08-24)` marker instead of being silently edited.

---

## Fresh-state runtime verification

The development database was backed up and reset (credential vault untouched), and the real
application was launched with `mise run tauri:dev`.

- Backup: `%APPDATA%\langnext-dev-db-backup-20260910-121918` (main `.sqlite3`).
- Reset: `langnext.sqlite3`, `-wal`, `-shm`, and `backups/` removed.
- Launch 1 (no development directory): `plugin_catalog_ready built_in=10 development=0 user=0
invalid=0 defaults=10 rejected_plugins=[]`.
- Launch 2 (development directory set to a container holding one copied built-in with a distinct
  plugin id): `plugin_catalog_ready built_in=10 development=1 user=0 invalid=0 defaults=11
rejected_plugins=[]`.

Fresh database inspection (read-only): `PRAGMA user_version = 16`; 28 tables; the catalog, grant,
pin, endpoint-trust, provider-binding, snapshot, and model-resource tables are present;
`plugin_publishers`, `plugin_package_approvals`, `plugin_default_activation_policies`,
`default_runtime_activation_intents`, `default_runtime_authority_approvals`,
`installed_plugin_versions`, `plugin_install_operations`, and `plugin_uninstall_operations` are
absent; no schema text contains `publisher_key_id`, `publisher_fingerprint`, `signature_status`,
`approved_authority`, or `claim_token`; `plugin_user_archives`, `plugin_default_overrides`,
`integration_instances`, and `execution_grant_sets` are empty.

Release binary inspection: `vendor-trust`, `vendor_trust`, `publisher.pub`,
`signatures/manifest.sig`, `publisher_key_id`, `publisher_fingerprint`, `signature_status`,
`plugin_publishers`, `default-activation-policies`, `LANGNEXT_VENDOR_TRUST_JSON`,
`verify-release-bundle`, and `generate-bootstrap-policy` are absent from
`src-tauri/target/release/langnext-app.exe`. `plugin_catalog_ready` and
`LANGNEXT_PLUGIN_DEV_DIR` are present. The generated WiX source lists exactly the 10 built-in
archives under `resources\plugins\` and no trust resource.

The user plugin directory was not reset (it is not database state): it holds no recorded archives
on the fresh database, so `user=0` in both launches. User archive install/remove behaviour is
covered by `cmds::plugin_packages::tests` in `plugin:conformance catalog`.

---

## Verification commands (round 3)

```bash
mise run test                    # 986 passed, 0 failed, 3 ignored
mise run test-frontend           # 495 passed, 0 failed
mise run typecheck               # pass
mise run lint                    # pass
mise run format:check            # pass
mise run build                   # pass
mise run plugin:check-builtins   # 10 built-in sources validated
mise run plugin:conformance all  # 33 suites ok, 0 required name missing
mise run plugin:check-no-wasi    # pass (15 guest-import tests, no wasmtime-wasi)
mise run package-only:check      # pass (includes the removed-trust symbol gates)
cargo check --all-targets        # 0 warnings
mise run tauri:build             # MSI, NSIS installer, and portable zip produced
```

### Intermittent frontend failure

Round 2 observed one `mise run test-frontend` run with `1 fail` and a lower `expect()` count, and
did not capture the name. Round 3 ran the suite 32 times: 12 runs back to back plus a further 20
runs in a loop, each log written to `/tmp/tflogs/run-<n>.log`. All 32 runs reported 495 passed and
0 failed. One run reported 2711 `expect()` calls instead of 2710, which proves at least one test
has a data-dependent number of assertions and is the likely source of the single unreproduced
failure. No `(fail)` line was ever captured and no reproduction was produced. Treat this as an open
unknown with a known-suspect class (variable-count assertion test), not as a fixed defect and not as
evidence of a real product failure.
