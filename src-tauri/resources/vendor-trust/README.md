# Vendor Trust Roots (Public Keys Only)

Production vendor publisher trust is loaded from this directory (and optional
`LANGNEXT_VENDOR_TRUST_JSON` override). `public-keys.json` carries the real
Ed25519 public key that corresponds to the **offline-held** vendor private key.
The app never auto-trusts any fabricated or test key.

## Gate A release configuration

`public-keys.json` is populated with the production vendor public key. Private
signing material must never enter this repository, app resources, CI caches, or
developer machines used for day-to-day builds.

Current shape:

```json
[
  {
    "keyId": "com.langnext.vendor.keys.1",
    "publicKeyHex": "<64-char lowercase hex of the production 32-byte Ed25519 public key>"
  }
]
```

`mise run plugin:verify-release-bundle` enforces that the release bundle
contains this public root plus signed archives and exact default policies.

## Non-goals

- Do not derive production keys from test fixtures (`[0x0a;32]`, `[0x09;32]`, etc.).
- Do not embed private keys or seed bytes here.
- Do not replace the production root with dev/test keys in release builds.
- Conformance fixture keys under `runtime-plugins/conformance/fixtures/packages/keys/`
  are test-only and are never bundled as production trust roots.
