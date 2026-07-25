# Phase 5: Google Translate Web Runtime Plugin Implementation Plan

**Goal:** Deliver the first real installable Wasm plugin using Google Translate Web Translate/Detect while preserving explicit Bundled Rust rollback.

**Inputs:** Phases 1–4 and current `google_translate_web.rs` behavior/tests.

**Assumptions:**

- GTX ships first with a pinned origin.
- Configurable HTTPS proxy support is a second tracer bullet in the same phase.
- Existing instances remain Bundled Rust until explicit migration.
- No request is shadow-executed.

**Architecture:** A vendor-signed `com.langnext.google-translate-web` Component owns language mapping, request construction, GTX/proxy response parsing, and provider error normalization. Network egress remains host-brokered; the instance pins either Bundled Rust or the Wasm package.

**Tech Stack:** Rust guest Component/WIT, Wasmtime host, existing NetworkBroker, schema UI, Translation Profile bindings.

---

## Dependencies

- Phase 4 complete.

## File Map

- Create: `runtime-plugins/google-translate-web/Cargo.toml`, `runtime-plugins/google-translate-web/src/lib.rs` — guest crate and capability exports.
- Create: `runtime-plugins/google-translate-web/plugin.json` — signed package manifest input.
- Create: `runtime-plugins/google-translate-web/schemas/config.json`, `runtime-plugins/google-translate-web/schemas/translate-preferences.json` — GTX/proxy schemas.
- Create: `runtime-plugins/google-translate-web/locales/en.json`, `runtime-plugins/google-translate-web/locales/zh-CN.json` — package fallback localization.
- Create: `runtime-plugins/google-translate-web/tests/fixtures/` — protocol golden fixtures.
- Create: `.mise/tasks/plugin/build-google-web` — deterministic Component build and unsigned staging tree at `runtime-plugins/dist/staging/com.langnext.google-translate-web-1.0.0/`; Phase 3 `plugin:finalize-package` creates the final signed archive.
- Modify: `src-tauri/src/services/google_translate_web.rs` — compatibility adapter and shared fixtures only.
- Modify: `src-tauri/src/services/plugin_store.rs`, `src-tauri/tauri.conf.json` — idempotent vendor package bootstrap/resource bundling.
- Modify: `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/services/service_capabilities.rs`, `src-tauri/src/cmds/service_translation.rs` — runtime Translate/Detect dispatch.
- Modify: `src-tauri/src/services/runtime_lifecycle.rs`, `src/features/plugins/IntegrationEditor.tsx` — migration/rollback UX.
- Modify: `src/features/translate/translationEngineOptions.ts` — generic runtime state only, never plugin-ID behavior.
- Test: guest fixtures, `src-tauri/src/services/wasm_runtime/tests.rs`, Google Web service tests, runtime lifecycle tests, and `src/features/translate/translationEngineOptions.test.ts`.

## Tasks

### Task 1: Port pure GTX protocol behavior into the guest

**Outcome:** The Component reproduces existing Translate/Detect request and response semantics against fixtures.

**Files:**

- Create: `runtime-plugins/google-translate-web/src/lib.rs`, `runtime-plugins/google-translate-web/tests/gtx.rs`
- Reuse/port: fixtures from `src-tauri/src/services/google_translate_web.rs` into `runtime-plugins/google-translate-web/tests/fixtures/`

**Steps:**

- [ ] Implement `translate.text@1` and `translate.detect@1` WIT exports.
- [ ] Port language mapping, input bounds, GTX query/body construction, nested-array parsing, detected-language handling, and error mapping.
- [ ] Request only endpoint alias `gtx`, approved methods, and relative paths.
- [ ] Keep user text/provider bodies out of logs.
- [ ] Move golden parser/request fixtures before removing any bundled test coverage.

**Validation:**

- Run: `mise run plugin:build-google-web`
- Run: `mise run plugin:conformance google-web-gtx`
- Expected: guest golden fixtures match bundled behavior and malformed responses map to stable errors.

### Task 2: Build and seed the vendor-signed package

**Outcome:** Fresh installs can discover the package without exposing signing private keys.

**Files:**

- Create: `runtime-plugins/google-translate-web/plugin.json`, `runtime-plugins/google-translate-web/schemas/config.json`, `runtime-plugins/google-translate-web/schemas/translate-preferences.json`, `runtime-plugins/google-translate-web/locales/en.json`, `runtime-plugins/google-translate-web/locales/zh-CN.json`, `.mise/tasks/plugin/build-google-web`
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/src/services/plugin_store.rs`
- Test: `src-tauri/src/services/plugin_package.rs` verification tests and `src-tauri/src/services/plugin_store.rs` bootstrap tests

**Steps:**

- [ ] Keep plugin ID and capability majors unchanged.
- [ ] Declare zero credential slots and one pinned GTX origin permission.
- [ ] Use schema config v1 with `channel = gtx` only in the initial package.
- [ ] Make `plugin:build-google-web` compile the Component, generate the complete signed file index, copy all indexed files into a deterministic staging tree, and emit the exact `plugin.json` signing input; it must not claim or write a final package digest.
- [ ] In release CI, sign the exact staged `plugin.json` bytes with the offline/vendor signing service and inject only `signatures/manifest.sig`; the app build and developer task never receive a private key.
- [ ] Run `plugin:finalize-package` after signature injection to revalidate the file index, canonically create `runtime-plugins/dist/com.langnext.google-translate-web-1.0.0.lnplugin`, and emit `runtime-plugins/dist/com.langnext.google-translate-web-1.0.0.lnplugin.sha256` from the final archive bytes. Treat only this post-signing digest as package identity.
- [ ] On first startup, import the bundled final archive into the same immutable store idempotently.
- [ ] Set it as default for new Google Web instances without migrating existing instances.

**Validation:**

- Run locally: `mise run plugin:build-google-web`
- Run in release CI after signature injection: `mise run plugin:finalize-package runtime-plugins/dist/staging/com.langnext.google-translate-web-1.0.0 runtime-plugins/dist/com.langnext.google-translate-web-1.0.0.lnplugin`
- Run: `mise run plugin:verify runtime-plugins/dist/com.langnext.google-translate-web-1.0.0.lnplugin`
- Run: `mise run test vendor_package_bootstrap -- --nocapture`
- Expected: the unsigned staging tree is reproducible, finalization occurs only after external signing, the `.sha256` matches the final archive, package verifies/seeds once, and signing private material is absent from bundle inputs.

### Task 3: Execute GTX through the runtime router

**Outcome:** A Wasm-backed Translation Profile can Translate/Detect through the broker.

**Files:**

- Modify: `src-tauri/src/services/runtime_router.rs`, `src-tauri/src/services/service_capabilities.rs`, `src-tauri/src/cmds/service_translation.rs`
- Test: `src-tauri/src/services/wasm_runtime/tests.rs` and service translation tests

**Steps:**

- [ ] Resolve the exact package/grant from the authoritative integration instance.
- [ ] Execute Translate/Detect through Wasmtime with normal deadlines/cancellation/limits.
- [ ] Enforce pinned GTX origin, methods, relative path, response cap, and no auth policy.
- [ ] Preserve Translation Profile source-auto detection and history semantics.
- [ ] Ensure one request uses one executor; Wasm errors enter existing profile/fallback policy only where product rules already permit another configured target.

**Validation:**

- Run: `mise run test google_translate_web_runtime -- --nocapture`
- Expected: Translate/Detect, cancel, timeout, rate-limit, invalid response, and single-executor tests pass without live network.

### Task 4: Add explicit existing-instance migration and rollback

**Outcome:** Users can migrate one Google Web instance without changing its ID or dependent profile bindings.

**Files:**

- Modify: `src-tauri/src/services/runtime_lifecycle.rs`, `src/features/plugins/IntegrationEditor.tsx`
- Test: runtime lifecycle migration/rollback tests and `src-tauri/src/repositories/integration_instances.rs` dependency tests

**Steps:**

- [ ] Offer migration only for matching plugin ID/capability majors and compatible config schema.
- [ ] Convert current GTX config to package schema through the normal preview/CAS flow.
- [ ] Keep integration instance and Translation Profile UUIDs unchanged.
- [ ] Retain Bundled Rust snapshot/handler for one stable release.
- [ ] Display active executor/version and rollback action.

**Validation:**

- Run: `mise run test google_web_runtime_migration -- --nocapture`
- Manual: migrate, translate, detect, and rollback under `mise run tauri:dev`.
- Expected: outputs/workflows remain functional and identity/bindings are stable.

### Task 5: Add configurable HTTPS proxy as a permission-expanding update

**Outcome:** Proxy channel support validates dynamic-origin approval separately from pinned GTX.

**Files:**

- Modify: `runtime-plugins/google-translate-web/schemas/config.json`, `runtime-plugins/google-translate-web/src/lib.rs`, `src-tauri/src/services/network_broker.rs`, `src-tauri/src/services/runtime_lifecycle.rs`
- Test: guest proxy fixtures and NetworkBroker dynamic-origin tests

**Steps:**

- [ ] Release a new package version adding `https_proxy` channel and proxy URL field.
- [ ] Normalize to one HTTPS effective origin; reject userinfo, fragments, forbidden query keys, private/link-local/loopback addresses, and non-HTTPS URLs.
- [ ] Persist the approved effective origin in the instance grant rather than trusting mutable config alone.
- [ ] Require a new explicit permission approval on GTX→proxy upgrade or URL change.
- [ ] Show a third-party data-egress warning and never attach credentials.
- [ ] Keep Detect pinned to GTX as the current product contract requires.

**Validation:**

- Run: `mise run plugin:conformance google-web-proxy`
- Run: `mise run test google_translate_web_runtime -- --nocapture`
- Expected: only the approved origin/method is reachable; changing URL invalidates/requires a new grant.

### Task 6: Complete real-service smoke validation

**Outcome:** The first runtime plugin proves user-visible installation-to-rollback behavior.

**Files:** No temporary production code.

**Steps:**

- [ ] Install/create/migrate a GTX instance.
- [ ] Create or reuse a plugin-backed Translation Profile.
- [ ] Translate fixed harmless smoke text and run auto-detection.
- [ ] Cancel one request and verify no history on cancellation.
- [ ] Upgrade to proxy only with an explicitly chosen test endpoint, then rollback.

**Validation:**

- Manual: `mise run tauri:dev`
- Expected: complete flow works; logs/DTO/export contain no user text, provider body, path, or unapproved URL.

## Final Validation

```bash
mise run plugin:build-google-web
# Release CI only, after external signature injection:
mise run plugin:finalize-package runtime-plugins/dist/staging/com.langnext.google-translate-web-1.0.0 runtime-plugins/dist/com.langnext.google-translate-web-1.0.0.lnplugin
mise run plugin:verify runtime-plugins/dist/com.langnext.google-translate-web-1.0.0.lnplugin
mise run plugin:conformance google-web
mise run test google_translate_web_runtime -- --nocapture
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run build
```

Expected: GTX and approved proxy paths work through Wasm; Bundled Rust rollback remains available.

## Failure Behavior

- Guest parser/protocol failure — stable `invalid_response`; no executor replay.
- Missing/revoked package — `plugin_unavailable`; preserve instance/profile.
- Proxy permission mismatch — deny before transport.
- Migration failure — keep Bundled Rust active.

## Privacy and Security

- User text egress is limited to approved Google/proxy origins.
- No credentials or auth headers are available to the plugin.
- Smoke tests use harmless fixed content and are never automatic/shadowed.

## Rollout Notes

- Ship GTX runtime first; proxy follows as a separate version/review.
- Retain Bundled Rust for at least one stable release after proxy support is proven.

## Risks and Mitigations

- Unofficial GTX response changes — golden fixtures, bounded parser errors, explicit rollback.
- Proxy becomes arbitrary SSRF — host effective-origin grant and private-address/final-destination checks.
- Behavioral drift — port existing fixtures before switching any instance.

## Open Questions

None blocking Phase 5.
