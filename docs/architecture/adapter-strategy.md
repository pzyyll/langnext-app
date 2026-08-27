# Package-Only Runtime Boundary

## Goal

Installed, verified `.lnplugin` packages are the only executable provider and
service-integration implementations. Wasm components own protocol request and
response logic. Rust owns package verification, schema projection, grants, host
auth, endpoint trust, bounded transport, and table-driven authority checks.
The frontend presents package state and invokes typed IPC. It does not implement
provider wire protocols.

## Layout

```text
runtime-plugins/                 Signed package sources and fixtures
src-tauri/resources/plugins/     Bundled .lnplugin archives
src-tauri/src/services/
  plugin_package.rs              Verify and install packages
  package_definition.rs          Project manifest and schema
  wasm_runtime/                  Execute the declared Wasm component
  network_broker.rs              Host-approved network and auth
  endpoint_trust.rs              Endpoint review and fail-closed create
src/features/providers/          Package runtime presentation and IPC
src/features/plugins/            Install, activate, and inspect packages
```

The frontend does not own a plugin contract, SSE decoder, or unsigned relative
wire facade. Provider, Google Web, Google Cloud, Edge TTS, and Baidu OCR
protocol request and response logic belongs to package Wasm components.
Baidu OCR uses the same package execution path as the other service
integrations.

## Installed-package flow

1. Verify the signed package archive and its file index.
2. Project the manifest, config schema, capabilities, and closed host auth
   policies into a host registration.
3. Resolve an authorized package pin for the instance.
4. Execute the declared Wasm component for the requested capability.
5. Broker host-approved network and auth access. Guests cannot select an
   arbitrary origin or auth policy.

Missing packages fail closed with `plugin_unavailable`. Create paths that
have no resolved package runtime identity do not synthesize a Bundled Rust
fallback.

## Host responsibilities

Rust retains:

- Package verification and publisher or default authorization
- Schema projection into config adapters
- Endpoint trust review and exact approval consumption
- Grant construction and credential isolation
- Host auth and token exchange
- Bounded transport, cancellation, and persistence
- Sanitized IPC that never carries secrets, package bytes, grants, or
  credential references

## Frontend responsibilities

The frontend retains:

- Package and runtime presentation
- Configuration UI
- User approvals
- Invocation of typed IPC

It does not parse provider SSE, register TypeScript plugins, or implement
detect, translate, or OCR wire formats.

## Security rules

- Secrets do not cross sanitized IPC DTOs.
- Guests cannot select arbitrary origins or auth policies.
- Authority checks match one complete rule row. Fields from different rows
  never combine.
- Authority validation runs before host auth or token exchange.
- Missing packages fail closed. The host does not invent a Bundled Rust
  identity.
