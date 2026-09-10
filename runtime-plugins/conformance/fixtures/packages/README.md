# ABOUTME: Structural `.lnplugin` fixtures accepted and rejected by the source-based catalog.
# ABOUTME: No signing key, signature, or publisher material is stored or required.

Every fixture is a committed archive loaded through `PluginLoader::load_archive` by
`src-tauri/src/services/conformance_package_fixtures.rs`. That test pins the expected outcome
for each file, so a change to archive validation that silently widens acceptance fails the
suite. There is no generator and no key material: fixtures are hand-maintained artifacts.

Regenerate the whole set after an intentional format change:

```bash
mise run plugin:check-builtins          # shipped built-in archives
cargo test --lib conformance_package_fixtures -- --nocapture
```

## Accepted

| Fixture                        | Notes                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| `valid-archive.lnplugin`       | Minimal Wasm package: `plugin.json` plus one indexed artifact      |
| `llm-provider-valid.lnplugin`  | Provider package with two indexed Wasm artifacts and capabilities  |
| `permission-expanding.lnplugin` | Declares a network permission; declarations are not authority      |

## Rejected (stable error codes)

| Fixture                          | Expected code             |
| -------------------------------- | ------------------------- |
| `legacy-signature-entry.lnplugin` | `undeclared_file`        |
| `legacy-publisher-key.lnplugin`   | `undeclared_file`        |
| `traversal.lnplugin`              | `path_invalid`           |
| `symlink.lnplugin`                | `symlink_rejected`       |
| `duplicate-path.lnplugin`         | `duplicate_path`         |
| `undeclared-file.lnplugin`        | `undeclared_file`        |
| `missing-indexed-file.lnplugin`   | `undeclared_file`        |
| `locale-tamper.lnplugin`          | `digest_mismatch`        |
| `incompatible.lnplugin`           | `compatibility_rejected` |
| `target-incompatible.lnplugin`    | `compatibility_rejected` |
| `oversized-entry.lnplugin`        | `entry_too_large`        |
| `zip-bomb.lnplugin`               | `zip_bomb`               |

`legacy-signature-entry.lnplugin` and `legacy-publisher-key.lnplugin` carry the removed
`signatures/manifest.sig` and `publisher.pub` entries. Both must fail closed as undeclared
files: the catalog has no plugin-level trust envelope, and a legacy archive is rejected rather
than tolerated.

Never add key material, signature files, or publisher declarations to this directory.
Built-in authenticity comes from the signed application installer and the protected
`src-tauri/resources/plugins/` location.
