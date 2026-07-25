# Phase 9: Isolated Plugin Pages Implementation Plan

**Goal:** Allow approved plugins to expose optional custom workflows in separately permissioned WebViews without importing plugin JavaScript into the main React realm.

**Inputs:** Phases 0, 3, and 4 plus Tauri 2.11.5 capability, CSP, navigation, asset/protocol, and multi-window documentation.

**Assumptions:**

- Schema-rendered instance configuration remains mandatory and sufficient for normal settings.
- Custom pages are local verified package assets only.
- Plugin WebViews receive no general app/Plugin/Tauri APIs.
- Tauri API signatures are rechecked against locked 2.11.5 before implementation.

**Architecture:** A host-owned page manager serves verified assets by exact package digest, creates a uniquely labeled WebviewWindow, applies host-controlled response policy/navigation checks, and issues a short-lived session nonce. The page can call only a narrow typed bridge whose backend revalidates label, session, instance, page declaration, digest, action, and grant.

**Tech Stack:** Tauri WebviewWindow, app command ACL/capabilities, host URI protocol or shell, CSP, React host navigation, Rust session service.

---

## Dependencies

- Phases 0, 3, and 4 complete.
- Recommended after Phase 8 stability; not required for normal plugins.

## File Map

- Create: `src-tauri/src/domain/plugin_page.rs` — page descriptors, sessions, bridge DTOs/actions.
- Create: `src-tauri/src/services/plugin_pages.rs` — page/session/asset authorization.
- Create: `src-tauri/src/cmds/plugin_pages.rs` — open/close/narrow bridge commands.
- Create: `src-tauri/src/windows/plugin_page.rs` — WebviewWindow creation and navigation policy.
- Create: `src-tauri/capabilities/plugin-pages.json` — `webviews`-scoped narrow permissions.
- Create: `src-tauri/permissions/plugin-pages.toml` — plugin-page-only bootstrap/bridge/self-close permissions; trusted-app open remains in `app-commands.toml`.
- Create: `src/features/plugins/PluginPageActions.tsx` — host buttons for declared pages.
- Create: `src/features/plugin-page/bridge.ts` — typed frontend bridge client for package SDK documentation.
- Modify: `src-tauri/src/domain/runtime_plugin.rs`, `src-tauri/src/services/plugin_package.rs`, `src-tauri/src/services/plugin_store.rs`, `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/repositories/plugin_permission_grants.rs`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/src/cmds/mod.rs`, `src-tauri/src/state.rs`, `src-tauri/capabilities/trusted-app.json`, `src-tauri/capabilities/plugin-pages.json`, `src-tauri/permissions/plugin-pages.toml`.
- Test: malicious page fixtures, session/bridge/navigation/CSP tests.

## Tasks

### Task 1: Lock custom-page manifest and asset rules

**Outcome:** Packages can declare bounded pages without arbitrary routes/origins.

**Files:**

- Modify: `src-tauri/src/domain/runtime_plugin.rs`, `src-tauri/src/domain/plugin_page.rs`, `src-tauri/src/services/runtime_plugin_contracts.rs`, `src-tauri/src/services/plugin_package.rs`
- Test: inline manifest/page/package validator tests

**Steps:**

- [ ] Define page ID, local entry artifact, fallback title, closed icon ID, allowed bridge action IDs, and minimum page API version.
- [ ] Require every page asset to be declared with the page role and digest-protected in the signed manifest file index.
- [ ] Reject remote entry URLs, inline remote imports, path escapes, service workers, nested executable archives, and undeclared page assets.
- [ ] Apply separate page asset/count/size limits.
- [ ] Keep pages optional; schema config cannot be disabled by a page declaration.

**Validation:**

- Run: `mise run test plugin_page_manifest -- --nocapture`
- Expected: only declared local verified assets/pages pass.

### Task 2: Add explicit plugin-page ACL

**Outcome:** Plugin WebViews cannot invoke trusted application commands.

**Files:**

- Create: `src-tauri/capabilities/plugin-pages.json`, `src-tauri/permissions/plugin-pages.toml`
- Modify: `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/src/cmds/mod.rs`, `src-tauri/capabilities/trusted-app.json`
- Test: Phase 0 command/AppManifest/ACL coverage tests extended for plugin page labels

**Steps:**

- [ ] Define `plugin-page-*` WebView label pattern and grant only one-time bootstrap, page bridge, and self-close commands plus the minimum non-event core getter proven necessary; do not grant generic `core:event` listen/emit permissions.
- [ ] Grant `open_plugin_page` only through `app-commands.toml` + `trusted-app.json`; never include it in `plugin-pages.toml`. Grant bootstrap/bridge/self-close only through `plugin-pages.toml` + `plugin-pages.json`; never expose them to trusted app pages unless a separately named host command is required.
- [ ] Do not match plugin page windows in the trusted app capability; avoid `windows` matching that grants all child WebViews.
- [ ] Register page commands in the `invoke_handler` and Phase 0 `AppManifest`, then prove trusted-app/plugin-page capability coverage is intentional rather than wildcard-derived.
- [ ] Add bidirectional tests: trusted app may open but cannot invoke page-only bootstrap/bridge/self-close; plugin pages may bootstrap/bridge/self-close but cannot open pages or resolve unrelated trusted commands.

**Validation:**

- Run: `mise run test plugin_page_acl -- --nocapture`
- Run: `mise run test runtime_plugin_security -- --nocapture`
- Expected: open is trusted-app-only; bootstrap/bridge/self-close are plugin-page-only; reverse and unrelated command access is denied; command registration/AppManifest/permission coverage remains exact.

### Task 3: Serve assets with host-controlled policy

**Outcome:** Plugin HTML cannot choose its own effective CSP or navigate to arbitrary content.

**Files:**

- Create: `src-tauri/src/services/plugin_pages.rs`, `src-tauri/src/windows/plugin_page.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/windows/mod.rs`
- Test: inline protocol/header/path tests in page service/window modules

**Steps:**

- [ ] Verify the exact Tauri 2.11.5 custom-protocol API before coding; use the current non-deprecated builder API.
- [ ] Serve assets from the exact content-addressed package directory after digest/path/MIME validation.
- [ ] Set CSP/security response headers in host code, not package HTML: local scripts/styles/assets only; no direct connect/form/frame/object/base/navigation by default.
- [ ] Reject range/large responses outside named asset limits and prevent directory listing.
- [ ] Intercept navigation, new windows/popups, downloads, external schemes, and top-level origin changes in host callbacks.
- [ ] Do not widen the global asset protocol scope for plugin packages.

**Validation:**

- Run: `mise run test plugin_page_protocol -- --nocapture`
- Expected: traversal, MIME, remote navigation, popup/download, CSP bypass, and stale digest fixtures fail closed.

### Task 4: Create page sessions and WebviewWindows

**Outcome:** Opening a declared page produces a short-lived instance/version-bound principal.

**Files:**

- Create: `src-tauri/src/domain/plugin_page.rs`, `src-tauri/src/services/plugin_pages.rs`, `src-tauri/src/windows/plugin_page.rs`, `src-tauri/src/cmds/plugin_pages.rs`
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/domain/mod.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/windows/mod.rs`, `src-tauri/src/cmds/mod.rs`
- Test: inline session lifecycle tests in `src-tauri/src/services/plugin_pages.rs`

**Steps:**

- [ ] Trusted-app-only `open_plugin_page(instance_id,page_id)` reloads instance/package/manifest/current grant set, validates the declaration, requires an exact page authority entry for that `page_id` and requested action/capability aliases, then creates a random nonce/session server-side and creates/focuses a unique WebviewWindow; neither nonce nor secret state appears in its URL.
- [ ] Return `page_approval_required` without creating a WebView/session when the current grant set lacks the page/action entry; package approval and capability/network entries alone are insufficient.
- [ ] Bind session to WebView label, instance ID, package digest, grant-set revision, page ID, creation/expiry, bootstrap-consumed state, and the approved action/capability subset.
- [ ] Invalidate/close sessions on package upgrade, rollback, disable, uninstall, instance deletion, app shutdown, or expiry.
- [ ] Limit concurrent page sessions globally and per instance.
- [ ] Never place secret/config values in URL query/fragment.

**Validation:**

- Run: `mise run test plugin_page_session -- --nocapture`
- Expected: stale, cross-instance/version, disabled, expired, and over-limit sessions are denied/closed.

### Task 5: Implement the narrow bridge

**Outcome:** Plugin pages can perform declared sanitized actions without direct system authority.

**Files:**

- Modify: `src-tauri/src/cmds/plugin_pages.rs`, `src-tauri/src/services/plugin_pages.rs`, `src-tauri/src/domain/plugin_page.rs`, `src/features/plugin-page/bridge.ts`
- Test: inline bridge authorization tests in `src-tauri/src/services/plugin_pages.rs` and `src/features/plugin-page/bridge.test.ts`

**Steps:**

- [ ] Define v1 actions for sanitized instance summary, schema config draft/save, validation request, declared package action, brokered network action, and close.
- [ ] Add `bootstrap_plugin_page` as a one-time command with no caller-supplied nonce. It resolves the invoking WebView label from command context, finds the pre-created unconsumed session, atomically marks bootstrap consumed, and returns the nonce plus sanitized page API/version/action metadata. A second call, wrong label, expired session, or non-plugin WebView fails closed.
- [ ] `src/features/plugin-page/bridge.ts` calls bootstrap once and holds the nonce only in module memory; never place it in URL, DOM, local/session storage, logs, global events, or package-controlled persisted config. Reload/session invalidation requires reopening from trusted host UI.
- [ ] For host-to-page progress/events, return a session-bound Tauri Channel from the narrow bridge command; do not expose the global event listener surface.
- [ ] Require each post-bootstrap call to include the nonce; backend also checks invoking WebView label from the Tauri command context.
- [ ] Revalidate package digest, current grant-set revision, exact page/action entry, and any delegated capability/endpoint entry on every call.
- [ ] Enforce bounded payloads and typed DTOs; reject arbitrary command names/URLs/headers/files.
- [ ] Route network/auth through existing brokers and schema saves through authoritative services.
- [ ] Return no credential refs/secrets/tokens/raw provider bodies.

**Validation:**

- Run: `mise run test plugin_page_bridge -- --nocapture`
- Expected: one-time bootstrap and allowed actions work; second-bootstrap, cross-window bootstrap, nonce replay, and nonce/label/action/instance/digest/grant spoofing fail.

### Task 6: Add host UX and adversarial page fixtures

**Outcome:** Declared pages are discoverable and security behavior is demonstrable.

**Files:**

- Create/modify: `src/features/plugins/PluginPageActions.tsx`, `src/i18n/locales/en.ts`, `src/i18n/locales/zh-CN.ts`, `runtime-plugins/conformance/plugin-pages/`
- Modify: `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/cmds/runtime_lifecycle.rs`, `src-tauri/src/repositories/plugin_permission_grants.rs`
- Test: `src/features/plugin-page/bridge.test.ts`, `src-tauri/src/services/runtime_lifecycle.rs`, `src-tauri/src/services/plugin_pages.rs`, and manual page security checks

**Steps:**

- [ ] Show declared page actions in the existing integration instance editor. If absent from the current grant set, show package/publisher/page identity plus exact bridge actions and delegated capability/endpoint aliases before an explicit approval action.
- [ ] Apply approval through the normal lifecycle preview/CAS path by creating a complete new grant-set revision for the same instance/package, preserving reviewed capability entries and adding only the approved page entry; invalidate old sessions/runtime caches after commit.
- [ ] Make custom pages secondary to schema configuration and never treat package approval as page approval.
- [ ] Add fixtures attempting parent access, unrelated invoke, direct fetch, navigation, popup, download, service worker, second/cross-window bootstrap, oversized bridge, cross-session replay, and cross-page/action/capability grant reuse.
- [ ] Add one benign page that reads sanitized status and updates schema config.

**Validation:**

- Run: `mise run plugin:conformance plugin-pages`
- Manual: `mise run tauri:dev`
- Expected: unapproved page open fails, explicit page/action approval creates one new instance grant-set revision, benign page works, and every cross-page/action/capability or malicious action is blocked and logged without sensitive payloads.

## Final Validation

```bash
mise run plugin:conformance plugin-pages
mise run test plugin_page -- --nocapture
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run tauri:dev
```

Expected: custom pages are isolated from trusted app commands and can use only the declared bridge.

## Failure Behavior

- Missing/stale package/session — close page and return unavailable.
- Undeclared action/navigation/asset — deny and retain instance state.
- Package upgrade/rollback — invalidate old page immediately.
- Bridge payload overflow — reject before deserialization/business action where possible.

## Privacy and Security

- Separate WebView is an IPC principal, not guaranteed separate OS process.
- HTML sandbox/CSP/signature alone is insufficient; ACL and backend checks are mandatory.
- No remote scripts, direct network, secrets, filesystem, clipboard, shell, or broad Tauri API.

## Rollout Notes

- Ship one benign vendor diagnostic page before permitting user-approved publishers to declare pages.
- Keep the feature disabled until the current instance/package grant-set revision contains an explicit page/action authority entry.

## Risks and Mitigations

- Platform WebView differences — conformance on Windows/macOS/Linux and strict host navigation policy.
- Custom protocol API drift — verify against Tauri 2.11.5 before implementation and pin tests.
- Main-app permission inheritance — use `webviews` labels and ACL coverage tests, not parent window matching.

## Open Questions

None blocking Phase 9 after Tauri 2.11.5 API verification.
