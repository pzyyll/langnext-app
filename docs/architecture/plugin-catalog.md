# Plugin Catalog

## Purpose and scope

The plugin system is source-based. One `PluginCatalog` (`src-tauri/src/services/plugin_catalog.rs`) discovers three source types. One `PluginLoader` (`src-tauri/src/services/plugin_loader.rs`) materializes each directory or archive into an immutable, digest-addressed snapshot. Runtime execution reads only that snapshot.

This document describes the shipped model: content sources, discovery, content identity, trust limits, defaults, the runtime safety boundary, import/export content rules, developer tasks, and failure behavior. It also replaces the earlier signed-package and activation-policy model: there is no plugin-level signature, no publisher identity, no vendor key root, and no activation policy file.

## Sources

`PluginSource` has three members. The source decides Native eligibility, privileged Host auth eligibility, and user-facing actions.

| Source      | Location                                                                         | Availability      | Runtime kinds                             | Install approval                                                                        | Default behavior                                                                                    | Privileged Host auth              |
| ----------- | -------------------------------------------------------------------------------- | ----------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------- |
| Built-in    | Application resources (`src-tauri/resources/plugins/`, directory or `.lnplugin`) | All builds        | Wasm Component, allowlisted Native worker | None. Authenticity comes from the signed installer and the protected resource location. | Automatic default for its plugin id                                                                 | Allowed by the closed Host policy |
| Development | Directory named by `LANGNEXT_PLUGIN_DEV_DIR`                                     | Debug builds only | Wasm Component                            | None. The developer selects the directory explicitly.                                   | Built-in first; development content only when the plugin id has no built-in entry                   | Denied                            |
| User        | `<app-data>/plugins/*.lnplugin` archives                                         | All builds        | Wasm Component                            | One permission review for one exact content digest                                      | Built-in first; user content only when the plugin id has no built-in entry, or by explicit override | Denied                            |

Rules that apply to all sources:

- Non-built-in content cannot claim a reserved first-party plugin id (`first_party_id_rejected`).
- Only built-in content may declare a `trusted-native-worker` runtime (`native_source_rejected` elsewhere).
- Native content must pass the first-party id/version allowlist (`native_not_allowlisted`).
- Only built-in content may request a privileged Host auth policy (Google service account or Baidu client credentials); other sources fail with `privileged_auth_rejected`.
- Built-in content is discovered from the resource directory. Built-in archives ship as `src-tauri/resources/plugins/*.lnplugin`.
- User archives are copied to `<app-data>/plugins` and recorded in `plugin_user_archives` with the plugin id, version, runtime kind, manifest JSON, permission-request digest, file name, and install time.
- Development content is read only when `allow_development` is true. Release builds ignore the environment variable.

## Discovery and precedence

`PluginCatalog::refresh` performs these steps:

1. Scan the built-in directory. Each subdirectory and each `*.lnplugin` archive is a candidate. Entries are processed in sorted path order.
2. Scan the development directory with the same rule, in debug builds only.
3. Read every recorded user archive from the database in file-name order and load the archive file.
4. Reject candidates that violate a source rule (reserved first-party id, non-built-in Native, non-built-in privileged Host auth).
5. Sort candidates by plugin id, version, content digest, and source.
6. Resolve one entry per `plugin id + version`.
7. Resolve one default digest per plugin id.

Precedence rules:

- For one `plugin id + version`, Built-in beats Development, and Development beats User.
- Two candidates with the same `plugin id + version` and the same content digest collapse into one entry.
- Two candidates with the same `plugin id + version` and different digests are a conflict (`version_conflict`). The higher-precedence source stays published; the loser is reported as an error entry.
- Every failure is isolated per entry. Invalid user or development content never hides built-in content.
- User archives are checked against their recorded digest. A file that no longer matches is isolated as `digest_mismatch` and is not published.

Startup readiness is fail-closed for built-ins. `PluginCatalog::has_builtin_errors` returns true for any built-in entry error, and `AppState::initialize` then refuses to start with a sanitized error message. A built-in entry that cannot project into a service definition also fails startup readiness. Errors from user and development content stay visible in the catalog snapshot and do not stop the app.

A successful refresh writes one startup log line with the built-in, development, user, invalid, and default counts, plus the plugin ids that failed definition projection. The log carries no paths and no content.

## Content digest and immutable snapshots

The content digest is the content identity. Snapshot lookup, instance pins, provider bindings, execution grants, and import requirements resolve content by digest. A plugin id and a version are display and compatibility metadata.

The digest is SHA-256 over a domain-separated preimage (`lnplugin-content-v1`). For each file, in ascending normalized relative path order, the preimage appends: a record separator, the path, a field separator, the length as a big-endian 64-bit value, a field separator, and the file bytes.

- The digest covers normalized sorted relative paths plus file bytes.
- The digest excludes nothing. `plugin.json` is part of the preimage, because the manifest is one member of the content set.
- The manifest file index cannot declare `plugin.json`. The manifest is the only reserved entry, and it is the only member that the index does not list.
- Two different path/byte partitions can never produce the same digest, because each record carries its own path and length.
- A directory and an archive with identical files produce the same digest. `PluginContentKind` records the input kind (`directory` or `archive`) but does not change the identity.
- Path normalization accepts ASCII only, forward slashes only, no leading `/`, no `\`, no `:`, no empty segment, no `.` segment, and no `..` segment. Trailing slashes are removed. The maximum depth is 16 segments.
- Structural caps: archive 400 MiB, one file entry 100 MiB, 1024 entries, total decompressed payload 400 MiB, `plugin.json` 256 KiB, schema file 256 KiB, UI asset 4 MiB, decompression ratio 100.

`PluginLoader` materializes content in this order:

1. Collect every file into a `BTreeMap` keyed by the normalized relative path.
2. Validate the manifest, the file index, path safety, entry roles, and size caps.
3. Compute the content digest.
4. Write the files to `<app-data>/plugin-cache/.staging-<id>/` and rename the directory to `<app-data>/plugin-cache/<digest>/`. An existing digest directory is reused.
5. Mark snapshot files read-only (best effort).

Source mutation is rejected. After materialization, the loader re-collects and re-digests a directory, or re-reads an archive file and compares bytes. A change produces `source_mutated` and the refresh fails for that entry.

Snapshots are immutable in use. A changed source file produces a new digest at the next refresh. The catalog never substitutes another digest for a pinned one. A pin to a digest that is no longer available fails closed with `plugin_unavailable`, and the previously materialized snapshot bytes stay on disk.

## Trust model and explicit limits

- Built-in authenticity comes from the signed application installer or update channel and from the protected resource location. The app does not verify a second plugin-level signature.
- User archives have no authenticated publisher identity. The install dialog shows the unknown-publisher warning. Installation is one permission review for one exact content digest, not publisher trust.
- Explicit limit: built-in resources can be modified after installation on an unprotected system. The catalog detects a content change only through the digest. It cannot establish who changed the content, and it cannot restore the original bytes.
- Explicit limit: a user archive is untrusted input with unknown authorship. The permission review shows the requested network, auth, and credential slots. It does not make the author trustworthy.
- The model has no publisher keys, no signature envelopes, no key revocation, and no trust-on-first-use registry. New content is always a new digest and a new review.
- The catalog is not a security boundary by itself. The runtime safety boundary below is the only protection against malicious content that passes structural validation.

## Defaults and instance pinning

- Built-in content is the automatic default for its plugin id. No database row and no policy file is necessary.
- A user override is one row in `plugin_default_overrides`: `plugin_id`, `content_digest`, `updated_at`.
- `PluginCatalog::set_user_default` accepts only an available digest that belongs to the given plugin id. An unknown digest fails closed.
- `PluginCatalog::clear_user_default` deletes the row, and the built-in default applies again.
- `PluginCatalog::prune_stale_default_overrides` deletes rows whose content digest has disappeared.
- Default resolution order: an explicit override whose digest is present, then the highest ranked candidate by source (Built-in, Development, User), then the newest version, then the digest.
- A default affects new instances only. Existing integration instances and provider runtime bindings keep their exact `package_digest` pin and grant-set revision.
- A default change never rewrites an existing pin, never upgrades a runtime, and never grants authority.

## Retained runtime safety boundary

Simplification removed authenticity machinery. It did not remove runtime controls. Every control below is active in the shipped build.

### Wasm execution

- Wasmtime 47.0.3 with the Component Model and async support. The host never links WASI. `mise run plugin:check-no-wasi` fails if `wasmtime-wasi` appears in the host dependency tree or in a conformance guest.
- Each WIT world imports only the `langnext:runtime-plugin` interfaces (`common` and `host`). A component with an undeclared import fails instantiation.
- Fuel and epoch interruption bound guest execution. The default fuel budget is 10,000,000 units; payload capability calls receive 100,000,000 units. Epoch interruption stops a guest that ignores fuel accounting.
- Store limits: 128 MiB memory, 10,000 table elements, 8 instances, 2 memories, 8 tables, 512 KiB Wasm stack, 2 MiB async stack. The pooling allocator bounds concurrent component instances.
- Output bounds apply to every capability result. The default resource response limit is 8 MiB, and the LLM chat stream has a total output bound.
- Request deadlines apply to the guest call and to every Host import. The default invocation timeout is 20 seconds; speech synthesis uses 60 seconds.
- Cancellation is a first-class Host import. A cancelled request stops the guest call and aborts owned stream and blob tasks. A cancelled attempt is never replayed through another executor.
- Guest traps and resource exhaustion map to stable capability errors (`quota_exceeded`, `plugin_unavailable`) without guest backtraces or host paths.
- The compiled-component cache is keyed by the package digest, the component artifact digest, the host API version, the Wasmtime version, the runtime configuration revision, and the target. The configuration revision covers every security-relevant limit, so a limit change invalidates cached artifacts.

### Host broker authority

- A guest cannot choose an origin. It names a declared endpoint alias and a relative path. The Host broker resolves the effective origin.
- The broker derives authority from one execution grant set, bound to the exact subject, plugin id, version, package digest, capability id, endpoint id, origin, method, auth policy, resource mode, and limit set. Fields from different grant rows never combine.
- Instance-configured origins require an exact user approval in `integration_endpoint_trusts`, bound to the plugin identity and the configuration fingerprint. An unapproved origin fails before transport.
- Path confinement rejects absolute paths and traversal segments.
- Sensitive request headers and credential-like query keys are blocked. The Host adds its own header or query injection after guest validation.
- Bounded transport limits the request, response, and stream sizes. Streaming has backpressure, an idle timeout, a total deadline, and a size cap. Redirects are disabled or revalidated.
- Broker errors are sanitized. Provider bodies, credential bytes, and user text never reach the frontend or the log.

### Host-owned credentials

- Credential values live in the OS-backed vault or the sealed overflow store. Guest modules receive neither secret bytes nor credential references.
- A manifest declares credential slots. It never carries credential values or executable auth logic.
- Host auth drivers are closed and registered by id: Google service account (OAuth2) and Baidu client credentials. An unknown driver fails closed.
- The Host validates the driver, the audience policy, the capability, and the OAuth scopes before it mints a token. Scope sets are a property of the Host policy, not of the guest.
- Privileged Host auth drivers are built-in content only. A user or development plugin cannot receive a host-minted token.

### Native workers

- `trusted-native-worker` is built-in only. The loader rejects the kind from user and development content.
- The Host enforces a closed first-party allowlist on both the plugin id and the exact version (`com.langnext.paddleocr` 1.0.0). The router also checks digest equality against the pinned catalog snapshot before it spawns a process.
- The worker is a separate process with a framed, versioned stdio protocol (magic `LNWP`, 16 MiB frame cap, 1 MiB stdio flood cap).
- The process starts suspended and joins a Job Object, so descendants cannot escape process-tree cleanup. Termination failure is reported as `process_tree_cleanup_failed`.
- The handshake binds the protocol version, package digest, runtime-set digest, model-set digest, process nonce, and model API version.
- The Host audits loaded modules against the locked runtime set and locks the model set before it accepts `ready`.
- Timeouts: 15 seconds to start, 30 seconds per OCR request, 3 seconds to shut down before a forced tree kill.
- Cancellation sends a cancel frame and terminates the process tree.
- The worker is not a permission sandbox. Process isolation limits address-space and crash damage only. The allowlist, the digest check, the module audit, and the model lock carry the trust decision.

### Content structural defenses

Both directory and archive input pass the same checks. The loader rejects:

- traversal-equivalent paths and absolute paths (`path_invalid`);
- symlink entries and symlink plugin roots (`symlink_rejected`);
- duplicate paths, including case-fold collisions (`duplicate_path`);
- files that the manifest index does not declare (`undeclared_file`), except the reserved `plugin.json`;
- indexed files that are absent from the content set (`missing_indexed_file`);
- oversized entries, too many entries, and oversized totals (`entry_too_large`, `entry_count_exceeded`, `total_size_exceeded`);
- zip bombs by declared size, actual expansion, per-entry ratio, and total ratio (`zip_bomb`);
- non-UTF-8 or non-ASCII entry paths (`invalid_utf8_path`);
- a missing or oversized manifest (`missing_manifest`, `manifest_too_large`);
- an invalid manifest, an unsupported plugin API version, or an unsupported capability major (`invalid_manifest`, `compatibility_rejected`);
- per-file digest or length drift against the manifest index (`digest_mismatch`).

## Import and export content requirements

An export document carries content identity only:

- plugin id;
- plugin version;
- exact content digest;
- runtime kind;
- plugin API version;
- config schema version;
- required capability majors.

An export never carries package bytes, secrets, credential references, grants, publisher fields, or approval state.

Import accepts format version 8 only. A document that still carries a removed publisher or activation field fails closed as an unknown field. There is no compatibility path for older documents.

Import preview resolves the exact digest against the immutable catalog first, and against recorded user archives second. It reports one local status per subject:

| Status            | Meaning                                                                           | Required action           |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------- |
| `missing`         | The exact digest is absent locally                                                | `install_exact_package`   |
| `digest_mismatch` | Local content claims the same plugin id and version at another digest             | `resolve_digest_mismatch` |
| `incompatible`    | The exact digest is present but its manifest identity contradicts the requirement | `resolve_incompatibility` |
| `installed`       | The exact digest is present and compatible                                        | `activate_after_import`   |

Import never installs content, never changes a catalog default, never restores an approval, and never writes an execution grant. Imported requirements stay inactive until the user starts a separate explicit lifecycle action.

## Developer workflows

| Task                                                  | Purpose                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise run plugin:check-builtins`                      | Validate every shipped built-in directory and archive structurally. Run before `tauri build`. A structural failure stops the release.                                                                                                              |
| `mise run plugin:pack -- <plugin-dir> <out.lnplugin>` | Validate one plugin directory, then write one deterministic archive. Entries use canonical path order and fixed permissions. No key input exists.                                                                                                  |
| `mise run plugin:dev-build -- <plugin-dir>`           | Check the pinned `cargo-component` version, build the declared Wasm artifacts, and validate the directory for a debug reload.                                                                                                                      |
| `mise run plugin:conformance [mode]`                  | Run the required-name conformance suites. Modes include `wasm`, `llm`, `catalog`, `fixtures`, `import-export`, `installed-lifecycle`, `native-worker`, `paddleocr`, `baidu-ocr`, `edge-tts`, `google-web`, `google-cloud`, `resources`, and `all`. |
| `mise run plugin:check-no-wasi`                       | Prove that no WASI implementation is linked into the host or imported by a conformance guest.                                                                                                                                                      |

Conformance tests pin behavior that a refactor must not break:

- `src-tauri/src/services/conformance_package_fixtures.rs` pins the accepted or rejected outcome and the stable error code of every committed archive fixture under `runtime-plugins/conformance/fixtures/packages/`. Legacy signature and publisher entries in an archive fail as undeclared files.
- `src/features/plugins/InstalledPluginVersions.test.tsx` pins the source-specific UI actions: Remove exists for user content only, and Reload exists for development content only.

Never hand-author a manifest digest or a content digest. Build the plugin source under `runtime-plugins/<name>/` and pack it with `mise run plugin:pack`.

## Failure behavior

- Invalid built-in content — startup readiness fails with a sanitized plugin id and error code. The app never starts with a partial built-in catalog.
- Invalid built-in definition projection — startup readiness fails with the plugin id and the projection error.
- Invalid development content — the catalog reports an error entry; built-in content stays available.
- Invalid user archive at install — the install is rejected before any file is written.
- Invalid user archive already recorded — the catalog isolates it as an error entry; built-in content stays available.
- Source file changes during directory materialization — the refresh rejects that entry with `source_mutated` and the previous immutable snapshot stays on disk.
- User archive changes after preview — the install fails on digest mismatch.
- Installed user archive no longer matches its recorded digest — the catalog isolates it as `digest_mismatch` and stops publishing it.
- Missing explicit user default — the built-in default applies, and no instance pin changes.
- Missing pinned snapshot — the instance keeps its identity and the runtime returns `plugin_unavailable`. The router never selects another digest silently.
- User or development content declares a Native worker — the catalog rejects the entry before publication, and a user install is rejected.
- User content requests a privileged Host auth policy — definition registration is rejected.
- Same plugin id and version with a different digest — the catalog reports `version_conflict`; the higher-precedence source stays available.
- Missing credentials — the definition stays visible and the instance is unconfigured. Execution fails with a credential-required error until the user supplies credentials.
- Guest trap, fuel exhaustion, or memory limit — the request fails with a stable capability error, capability health degrades, and the instance configuration and bindings remain intact.
- Native worker crash — the request fails, the process tree is terminated, and the bounded restart policy applies.
