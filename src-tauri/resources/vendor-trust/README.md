# Vendor Trust Roots (Public Keys Only)

Production vendor publisher trust is loaded from this directory (and optional
`LANGNEXT_VENDOR_TRUST_JSON` override). The default `public-keys.json` is an
empty array: the app does **not** auto-trust any fabricated or test key.

## Release configuration blocker

Before shipping first-party signed packages, replace `public-keys.json` with the
real Ed25519 public keys that correspond to **offline-held** vendor private
keys. Private signing material must never enter this repository, app resources,
CI caches, or developer machines used for day-to-day builds.

Example shape:

```json
[
  {
    "keyId": "com.langnext.vendor.keys.1",
    "publicKeyHex": "<64-char lowercase hex of 32-byte Ed25519 public key>"
  }
]
```

## Non-goals

- Do not derive production keys from test fixtures (`[0x0a;32]`, `[0x09;32]`, etc.).
- Do not embed private keys or seed bytes here.
- Conformance fixture keys under `runtime-plugins/conformance/fixtures/packages/keys/`
  are test-only and are never bundled as production trust roots.
