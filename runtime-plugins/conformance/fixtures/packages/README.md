# ABOUTME: Positive and negative `.lnplugin` fixtures for Phase 3 package verification.
# ABOUTME: Test private keys live only under `keys/` and are never bundled as trust roots.

Regenerate (from `src-tauri`):

```bash
GENERATE_PLUGIN_FIXTURES=1 cargo test --lib generate_conformance_package_fixtures -- --nocapture
```

Offline verify / finalize require an explicit trusted public key:

```bash
mise run plugin:verify -- runtime-plugins/conformance/fixtures/packages/signed-valid.lnplugin \
  --public-key-file runtime-plugins/conformance/fixtures/packages/keys/vendor-public-key.hex

mise run plugin:verify -- runtime-plugins/conformance/fixtures/packages/user-signed.lnplugin \
  --public-key-file runtime-plugins/conformance/fixtures/packages/keys/test-public-key.hex

mise run plugin:finalize-package -- \
  runtime-plugins/conformance/fixtures/packages/staging/signed-valid \
  /tmp/out.lnplugin \
  --public-key-file runtime-plugins/conformance/fixtures/packages/keys/vendor-public-key.hex
```

`staging/signed-valid` is the exact source tree for `signed-valid.lnplugin`. The formal
finalizer must reproduce the committed archive byte-for-byte (same `plugin.json` bytes,
signature, and public key).

## Positive

| Fixture | Notes |
| --- | --- |
| `signed-valid.lnplugin` | Fixture vendor key id (`com.langnext.vendor.keys.1`); finalizer output of `staging/signed-valid` |
| `user-signed.lnplugin` | User key id (`com.example.keys.1`), valid index/signature |
| `permission-expanding.lnplugin` | Valid package that requests network permissions |
| `staging/signed-valid/` | Deterministic staging tree for `plugin:finalize-package` |

## Negative (stable error codes)

| Fixture | Expected code |
| --- | --- |
| `unsigned.lnplugin` | `missing_signature` |
| `bad-signature.lnplugin` | `signature_invalid` |
| `traversal.lnplugin` | `path_invalid` |
| `symlink.lnplugin` | `symlink_rejected` |
| `duplicate-path.lnplugin` | `duplicate_path` |
| `undeclared-file.lnplugin` | `undeclared_file` |
| `missing-indexed-file.lnplugin` | `missing_indexed_file` |
| `locale-tamper.lnplugin` | `digest_mismatch` |
| `incompatible.lnplugin` | `compatibility_rejected` |
| `target-incompatible.lnplugin` | `compatibility_rejected` |
| `oversized-entry.lnplugin` | `entry_too_large` |
| `zip-bomb.lnplugin` | `zip_bomb` |

## Keys

Public only in fixture trust material (never production roots):

- `keys/test-signing-key.hex` — unit-test seed (all `09` bytes); fixtures only, never bundled
- `keys/test-public-key.hex` — matching user-fixture public key
- `keys/vendor-public-key.hex` — fixture vendor public key (seed `[0x0a; 32]` for tests only)

Never ship private keys in app resources or production vendor trust roots.
Production vendor public keys are loaded from `src-tauri/resources/vendor-trust/public-keys.json`
(empty by default) or `LANGNEXT_VENDOR_TRUST_JSON`.
