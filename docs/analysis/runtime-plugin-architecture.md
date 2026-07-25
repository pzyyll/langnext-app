# Runtime Plugin Architecture Assessment

## Executive summary

LangNext already has a useful plugin-shaped control plane, but it is not a runtime plugin system.

The current implementation has:

- plugin definitions and user-configured integration instances;
- versioned capability IDs;
- typed Rust capability traits;
- generic credential bindings;
- a credential vault, token grant service, network broker, cancellation, and health state;
- capability-driven discovery when creating Translation, OCR, and Speech bindings.

It is still statically coupled because plugin code, validation, registration, UI forms, and capability preferences are compiled into the host. Adding a plugin requires changes in both Rust and React followed by a full application release.

The recommended target is a hybrid runtime:

1. **Wasm Component plugins** are the default for external network services and lightweight processing.
2. **Trusted native worker plugins** are an optional later runtime for local OCR, STT, or model engines that cannot target Wasm.
3. **Host-rendered schema UI** is the default configuration experience.
4. **Custom plugin pages** run in a separately permissioned WebView, never as imported React code in the main application realm.
5. **All authority remains host-owned**: credentials, network destinations, auth injection, files, logs, resource limits, installation approval, and configuration persistence.
6. **The catalog is unified before the execution stacks are unified**. Existing TypeScript LLM providers and Rust service integrations can temporarily share one catalog while retaining separate adapters.

The first runtime tracer bullet should be `com.langnext.google-translate-web`. It is credential-free, already exposes `translate.text@1` and `translate.detect@1`, and uses bounded HTTP. It validates package installation, Wasm execution, brokered egress, dynamic discovery, schema configuration, and rollback without mixing in OAuth, binary audio, or LLM streaming.

## What “true pluginization” means

A plugin is genuinely runtime-pluggable only when all of the following are true:

- The host can discover and validate it without recompiling the application.
- Installing or removing it does not require editing Rust or React source.
- It declares capabilities through stable, versioned contracts.
- A plugin instance can be created multiple times with isolated configuration and credentials.
- Execution occurs behind a runtime boundary with explicit resource limits.
- The plugin receives only approved host capabilities, not ambient OS access.
- Its configuration and capability preferences are rendered without host `pluginId` branches.
- Optional custom UI cannot access the main DOM or the full Tauri IPC surface.
- Upgrades are version-pinned, permission-reviewed, migratable, and reversible.
- Missing or incompatible plugin code preserves user data and fails closed.

Dynamic metadata alone is insufficient. The current system dynamically lists capability options, but the implementation and UI remain statically compiled.

## Current architecture

### Existing execution path

```text
React route / workflow
  -> Tauri command
  -> domain service
  -> ServiceCapabilityService
  -> ServiceCapabilityRegistry<(plugin_id, capability_id), CapabilityHandler>
  -> compiled Rust handler
  -> TokenGrantService / NetworkBroker / direct reqwest
  -> provider API
```

The production composition root in `src-tauri/src/state.rs` constructs:

- `ServiceIntegrationRegistry::bundled()`;
- `GoogleCloudCapabilities`;
- `GoogleTranslateWebCapabilities`;
- `EdgeTtsCapabilities`;
- `ServiceCapabilityRegistry::with_google_cloud(...).with_google_translate_web(...).with_edge_tts(...)`.

This is dependency injection, but it is compile-time dependency injection.

### Existing control plane

The current model already separates three valuable concepts:

```text
ServiceIntegrationManifest
  -> describes a plugin definition and capability metadata

IntegrationInstance
  -> stores one configured account/service instance

Domain binding
  -> Translation Profile, OCR service, or Speech service references
     an integration instance and a capability ID
```

This separation should remain. It is the strongest part of the current design.

### Existing capability discovery

The frontend can discover existing capability implementations when creating domain resources:

- `src/features/translate/translationEngineOptions.ts` filters `translate.text@1`.
- `src/features/ocr/ocrProviderOptions.ts` filters `ocr.image@1`.
- `src/features/speech/speechProviderOptions.ts` filters `speech.synthesize@1`.

Discovery currently stops at option creation. Editors, labels, icons, validation, and preference shapes still branch on known plugin IDs.

## Coupling inventory

### Rust coupling

#### Static catalog registration

`src-tauri/src/services/service_integration_registry.rs` constructs three manifests directly in `bundled()`:

- `com.langnext.google-cloud`;
- `com.langnext.google-translate-web`;
- `com.langnext.edge-tts`.

A new plugin requires a new Rust manifest function and registration call.

#### Static handler construction

`src-tauri/src/services/service_capabilities.rs` imports concrete plugin implementations and provides plugin-specific builders:

- `with_google_cloud`;
- `with_google_translate_web`;
- `with_edge_tts`.

`src-tauri/src/state.rs` constructs every concrete handler. There is no package loader or runtime factory.

#### Plugin-specific domain types

`src-tauri/src/domain/service_integration.rs` contains host-domain types and constants for specific plugins:

- `GoogleCloudConfigV1`;
- `GoogleTranslateWebConfigV1`;
- `EdgeTtsConfigV1`;
- plugin IDs, endpoint defaults, and service-specific limits.

A runtime plugin host should persist opaque, schema-versioned config while the plugin contract or host policy validates its shape.

#### Plugin-specific configuration validation

`src-tauri/src/services/service_integrations.rs` dispatches configuration validation by manifest ID:

```text
Google Cloud -> validate_google_cloud_config
Google Web   -> validate_google_translate_web_config
Edge TTS     -> validate_edge_tts_config
```

It also special-cases zero-secret readiness, configuration completeness, and Google service-account validation.

#### Plugin-specific broker policy

`src-tauri/src/services/network_broker.rs` parses `GoogleCloudConfigV1` to resolve proxy behavior. Broker policy should consume a generic, host-approved grant, not a concrete plugin config type.

`src-tauri/src/services/token_grant.rs` hardcodes Google auth driver, audience, and capability-to-scope mappings. The security principle is correct, but the implementation needs an auth policy registry rather than direct plugin knowledge.

#### Direct transport bypass

`src-tauri/src/services/edge_tts.rs` creates its own `reqwest::Client` and executes a user-configured URL outside `NetworkBroker`. This means “all plugin network access is brokered” is not currently true.

#### Closed capability kinds

`CapabilityHandler` is a closed enum containing Translate, Detect, OCR, and Speech Synthesis.

This is not inherently a flaw. The host should keep a closed set of first-class capability contracts because each new capability needs domain types, UX, IPC, limits, and product behavior. The open extension point should be “which plugins implement a known capability,” not an untyped `execute(name, JSON)` function.

### Frontend coupling

#### Plugin editor dispatch

`src/features/plugins/IntegrationEditor.tsx` contains:

- an `isSupportedPlugin()` whitelist;
- per-plugin DTO-to-draft dispatch;
- per-plugin clean-state and save dispatch;
- hardcoded rendering of `GoogleCloudIntegrationForm`, `GoogleTranslateWebIntegrationForm`, and `EdgeTtsIntegrationForm`.

An unknown manifest can be listed but cannot be edited.

#### Plugin-specific draft union

`src/features/plugins/integrationDraft.ts` defines a closed union of three drafts and separate parsing, write, dirty-state, and mutation helpers for each plugin.

#### Domain preference coupling

OCR and Speech use generic instance/capability references in persistence, but their editors infer preference shapes from plugin IDs. For example, Speech maps Edge TTS to one draft shape and treats other instances as Google Cloud.

#### Catalog identity coupling

Plugin labels and icons are partly inferred from plugin IDs. `displayNameKey` exists in the manifest but is not sufficient for installable packages because an external package cannot add compiled host translation keys.

#### Separate LLM plugin universe

`src/features/providers/registry.ts` is a separate TypeScript registry for LLM provider wire formats. It is cleaner than the service-integration UI dispatch, but it is still build-time, executes in the main frontend realm, and has no runtime installation or isolation.

## Target architecture

### Layer model

```text
Plugin Package
  -> immutable, signed/versioned artifacts and manifest

Installed Plugin Version
  -> verified package digest + approved permission-grant revision
  -> optional default-for-new-instances marker (never an execution override)

Plugin Definition
  -> sanitized catalog metadata derived from an installed version

Plugin Instance
  -> user configuration, credential bindings, enabled state, health, version pin

Capability Binding
  -> Translation/OCR/Speech/LLM domain resource -> instance + capability major

Runtime Instance
  -> Bundled Rust adapter | Wasm component | Trusted native worker

Host Brokers
  -> network, auth, credentials, blobs, files, clock, logging, cancellation

Plugin UI
  -> host schema form by default; isolated WebView page when explicitly declared
```

Do not collapse these into one “plugin” table or object. They have different lifecycles and trust levels.

### Package format

Use a content-addressed archive such as `.lnplugin`:

```text
plugin.json
artifacts/
  plugin.wasm
  windows-x86_64/plugin.exe       # optional trusted native runtime
ui/
  index.html                      # optional custom page
  assets/*
locales/
  en.json
  zh-CN.json
licenses/*
signatures/manifest.sig
```

A conceptual manifest:

```json
{
  "manifestVersion": 1,
  "pluginApiVersion": "1.0",
  "id": "com.example.translate",
  "version": "1.2.0",
  "publisher": "example",
  "runtime": {
    "kind": "wasm-component",
    "artifact": "artifacts/plugin.wasm",
    "sha256": "..."
  },
  "capabilities": [
    {
      "id": "translate.text@1",
      "preferencesSchema": "schemas/translate-preferences.json"
    }
  ],
  "configurationSchema": "schemas/config.json",
  "credentialSlots": [
    {
      "id": "api-key",
      "kind": "secret-text",
      "required": true
    }
  ],
  "permissions": {
    "network": [
      {
        "id": "translate-api",
        "origins": ["https://api.example.com"],
        "methods": ["POST"]
      }
    ],
    "authPolicies": ["host.api-key.header.v1"]
  },
  "ui": {
    "mode": "schema",
    "page": null
  }
}
```

The manifest requests permissions. It does not grant them. Installation produces a separate host-owned approval record.

### Package installation lifecycle

```text
archive
  -> bounded staging extraction
  -> reject traversal, symlinks, duplicates, and decompression abuse
  -> validate manifest and compatibility
  -> verify every artifact digest
  -> verify publisher signature
  -> show requested permissions
  -> persist host approval
  -> atomically move to content-addressed directory
  -> optionally set the version as the default for newly created instances
  -> publish catalog change event
```

Required properties:

- same `plugin_id + version` with a different digest is rejected;
- installed files are treated as immutable;
- plugin instances pin an exact installed version/digest and permission-grant revision;
- a catalog default affects only newly created instances and never redirects an existing instance;
- the runtime router resolves the pinned package identity instead of trusting the current `plugin_version` string alone;
- upgrades cannot silently expand permissions;
- an instance upgrade is one compare-and-swap transition across package digest, config schema/version, approved grant revision, capability compatibility, and non-secret preference migrations;
- credential bindings remain host-owned and are reused only when slot IDs and kinds remain compatible;
- the previous version, grant revision, and configuration/preference migration snapshot remain available for rollback;
- in-use versions cannot be removed;
- missing packages preserve instances and bindings as `plugin_missing`;
- config migrations run against copied JSON in the sandbox and never execute SQL.

A signature proves provenance and integrity, not safety. Publisher trust, key rotation, revocation, downgrade policy, and permission review are separate controls.

## Capability contracts

### Keep typed, versioned capability worlds

Recommended first-class capability IDs:

```text
translate.text@1
translate.detect@1
llm.chat@1
llm.models.list@1
ocr.image@1
speech.synthesize@1
speech.recognize@1
```

Each capability major has a dedicated WIT world or interface. Avoid a universal JSON execution API.

The Wasmtime Component Model supports WIT-generated typed bindings and explicit host linking. Wasmtime v38 documentation shows `component::bindgen`, `Component`, and `component::Linker`; WASI is added only when the embedder explicitly links it. The host should therefore link only LangNext interfaces and no ambient WASI APIs.

### LLM and translation are related but not identical

A traditional translation plugin should expose `translate.text@1` directly.

An LLM provider should expose `llm.chat@1` and optionally `llm.models.list@1`. The host-owned LLM Translation engine continues to own:

- prompt templates;
- source/target language policy;
- ordered model fallback;
- translation history semantics;
- streaming reset and cancellation behavior.

It uses an `llm.chat@1` binding as an execution dependency. A plugin may also expose `translate.text@1` if it implements its own translation-specific policy.

This prevents the capability catalog from repeating the current mistake of treating every provider as the same product operation.

### Large and streaming data

Do not pass large images or audio repeatedly as base64 or unbounded `list<u8>` values.

Use host-managed resources:

```text
BlobHandle
  -> owner plugin/version/instance/request
  -> content type
  -> byte length
  -> read/write permissions
  -> expiration and cancellation

StreamHandle
  -> owner plugin/version/instance/request
  -> ordered, single-producer/single-consumer chunks
  -> bounded buffer and chunk size
  -> backpressure
  -> terminal state: finished | failed | cancelled
  -> cancellation and one-time consumption
```

The WIT contract passes opaque handles. Blob imports provide bounded chunk reads/writes. Stream imports define ordering, terminal errors, backpressure, and cancellation explicitly for LLM/network streaming. Handles cannot cross plugin instances or requests, and a failed runtime attempt is never replayed automatically through another executor.

## Execution runtimes

### Runtime A: Wasm Component Model

Use for:

- traditional HTTP translation APIs;
- LLM wire protocols and response parsing;
- cloud OCR;
- cloud TTS/STT;
- lightweight local parsing and transforms.

Security contract:

- no WASI filesystem, sockets, process, environment, or inherited stdio by default;
- only explicit LangNext host imports are linked;
- store memory/table/instance limits;
- fuel or epoch interruption for guest Wasm execution;
- asynchronous, timeout-bounded, cancellation-aware host imports with no unbounded blocking work;
- a wall-clock request deadline propagated through guest calls and every host import;
- request, response, stream, log, and concurrency limits;
- traps map to stable plugin errors and degraded health;
- compiled-component cache is keyed by package digest, host API version, runtime configuration, and target.

“No WASI” is not a complete sandbox. Wasmtime runs in the Tauri core process, so host import correctness and resource limits remain critical. Fuel or epoch interruption can stop guest execution, but it cannot preempt a blocking or cancellation-insensitive host import. A hard process-level deadline requires a terminable worker process. A later hardening step may therefore run Wasmtime in a low-privilege worker process.

### Runtime B: trusted native worker

Use only when a real local engine cannot target Wasm, for example a Python/C++ OCR or STT engine with platform libraries or GPU access.

The worker uses a versioned framed RPC protocol and the same logical capability contracts. The host owns lifecycle, handshake, cancellation, deadlines, frame limits, process-tree termination, health, and restart policy.

A subprocess provides crash and address-space isolation. It is not automatically a permission sandbox. Without Windows AppContainer, macOS sandboxing, and Linux namespace/seccomp containment, native workers must be restricted to trusted publishers and must not be described as untrusted plugins.

### Runtime C: bundled Rust compatibility adapter

Keep current handlers temporarily behind the same runtime router:

```text
RuntimeKind::BundledRust
RuntimeKind::WasmComponent
RuntimeKind::TrustedNativeWorker
```

This permits per-instance migration and rollback without changing profile, OCR, or Speech bindings.

## Host broker model

### Principal

Every host import is evaluated against an execution principal:

```text
package digest
plugin id + version
plugin instance id
capability id + major
request id
approved permission grant revision
```

### Network broker

A guest requests an approved endpoint alias and relative path. It never supplies an arbitrary secret-bearing URL.

The broker enforces:

- endpoint permission approved at install time;
- capability-to-endpoint association;
- allowed methods;
- relative-path confinement;
- blocked sensitive headers and query names;
- redirects disabled or revalidated at every hop;
- proxy policy;
- DNS/private/link-local/loopback policy;
- request/response/stream limits;
- timeouts, cancellation, concurrency, and rate limits;
- sanitized telemetry.

For configurable endpoints, the user-approved effective origin becomes part of the instance grant. A plugin manifest cannot self-authorize arbitrary egress.

### Credential and auth broker

The current generic credential slot storage should remain.

Untrusted plugins receive no raw credential or OAuth token. They request a host-owned auth policy, for example:

```text
host.api-key.header.v1
host.api-key.query.v1
host.oauth2.service-account.google.v1
host.oauth2.authorization-code.v1
```

The host validates that the installed plugin, capability, endpoint, and credential slot are authorized for that policy, then injects authentication internally.

New auth mechanisms are host platform changes. A plugin cannot define executable credential handling in its manifest.

### Other host imports

Provide narrowly scoped interfaces for:

- structured logs with a fixed field allowlist;
- monotonic time and deadline checks;
- cancellation state;
- bounded blob resources;
- optional plugin-private key/value storage;
- localization lookup for declared keys.

Do not provide ambient filesystem, shell, process, clipboard, notifications, or arbitrary Tauri command access in the first runtime.

## UI architecture

Every plugin instance gets a stable host-owned configuration page under the existing Plugins route. “Each plugin has its own page” should mean this guaranteed instance page first; executable custom UI is an optional extension, not the default.

### Default: schema-rendered host UI

Most plugins should provide data, not executable UI.

Use a versioned, limited schema dialect instead of unrestricted JSON Schema. Initial controls can include:

- string and multiline string;
- number with bounds and step;
- boolean;
- enum/select;
- credential slot control;
- groups and descriptions;
- simple `visibleWhen` conditions;
- localization keys and fallback text.

Explicitly exclude:

- remote `$ref`;
- HTML or JavaScript expressions;
- arbitrary CSS;
- arbitrary React components;
- executable validators;
- deep recursive structures;
- unbounded arrays.

Rust remains the authoritative validator. Frontend validation is immediate feedback only.

The same mechanism should render:

1. integration-instance configuration;
2. Translation/OCR/Speech capability preferences;
3. validation and permission status.

This removes the current React `pluginId` switches without sacrificing design consistency or accessibility.

### Optional: isolated custom page

A custom page is justified only when schema UI cannot express a workflow, such as account authorization, model download management, or local engine diagnostics.

Do not load plugin JavaScript with `React.lazy`, module federation, or a script tag in the main application realm. That code would inherit the main page's DOM and IPC exposure.

Recommended initial model:

- open the page in a dedicated WebviewWindow or separately labeled WebView;
- serve only verified package assets through a host-owned protocol or host shell;
- make the host, not plugin HTML, set the CSP and security response headers;
- use host navigation checks to block undeclared origins, top-level navigation, popups, downloads, and external schemes;
- grant only a narrow plugin-page bridge permission through a statically defined `webviews` capability;
- bind every bridge call to the WebView label, package digest, instance ID, and session nonce;
- deny direct network access unless the page calls the same broker through an approved action;
- expose sanitized state and schema mutations only;
- close or invalidate the session when the package/version changes.

Tauri capabilities protect WebView-to-Core IPC. They do not constrain Rust, Wasm host imports, or native workers. Also, app commands registered with `invoke_handler` are allowed by default unless the build uses an app command manifest. Before custom plugin pages, the project must:

- register app-local commands in `src-tauri/build.rs`;
- define explicit command permissions;
- grant by `webviews` labels rather than a parent `windows` match;
- ensure plugin WebViews do not match the current main-window capability;
- enable a host-controlled CSP before any plugin asset is parsed;
- narrow the current `$TEMP/**` asset protocol scope;
- add explicit navigation, popup, download, and external-scheme interception.

The current `csp: null` configuration is not acceptable for third-party plugin UI.

## Catalog and frontend model

### Unified catalog, multiple execution adapters

The first consolidation should be metadata-only:

```text
PluginCatalogEntry
  -> package/version/runtime/health
  -> capabilities
  -> config and preference schemas
  -> approved permissions
  -> optional pages
```

The catalog may contain:

- legacy TypeScript LLM providers;
- bundled Rust integrations;
- installed Wasm plugins;
- trusted native workers.

Execution remains behind adapters until migrated:

```text
CapabilityExecutor
  -> LegacyFrontendProviderExecutor
  -> BundledRustExecutor
  -> WasmExecutor
  -> NativeWorkerExecutor
```

This avoids a big-bang rewrite of model discovery, SSE parsing, fallback, translation history, OCR, and Speech.

### Frontend routes

Host routes remain stable:

```text
/plugins
/translate/profiles
/ocr
/speech
```

These routes consume capability metadata and schemas. Plugins do not register arbitrary TanStack Router files at runtime.

Optional plugin pages are catalog entries opened through one host route or window manager, for example:

```text
/plugin-page/$integrationInstanceId/$pageId
```

The host validates that the selected installed package declares the page.

## Security truth table

| Mechanism                         | Provides                                  | Does not provide                                          |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| Tauri plugin crate                | Reusable compile-time Rust/JS integration | Runtime marketplace or sandbox                            |
| Tauri capability                  | WebView-to-Core IPC authorization         | Restrictions on Rust, Wasm host code, or native processes |
| Wasm without WASI                 | No ambient WASI APIs                      | Automatic CPU, memory, or host-import safety              |
| Wasmtime limits                   | Bounded guest execution                   | Protection from unsafe or overpowered host imports        |
| Separate WebView                  | Separate page identity and IPC grant      | Guaranteed separate OS process on every platform          |
| HTML iframe sandbox               | Browser-level document restrictions       | A Tauri ACL principal by itself                           |
| Native subprocess                 | Crash/address-space isolation             | OS permission sandbox by default                          |
| Package signature                 | Integrity and publisher provenance        | Trustworthiness or absence of malicious behavior          |
| AssemblyLoadContext in STranslate | Dependency loading and unload boundary    | Security isolation from the host OS/process               |

## Lessons from the reference applications

### STranslate

Useful ideas:

- clear root plugin and per-capability interfaces;
- a plugin definition can create multiple service instances;
- host context injection;
- plugin-specific storage;
- package installation, upgrade, unload, and delayed cleanup;
- plugin-owned configuration UI as a product experience.

Do not copy:

- `AssemblyLoadContext` as a security boundary;
- in-process DLL execution for untrusted code;
- WPF `Control` injection into the host UI;
- the assumption that an injected HTTP service prevents direct OS/network access.

STranslate is more dynamically extensible than LangNext today, but its plugins run in the host process and are trusted. It is a good lifecycle and SDK reference, not the target isolation model.

### langnext-translate

The reference project has hardcoded Nuxt/Tauri integration and channel lists. Its `plugins/` directory contains Nuxt application plugins, not runtime provider plugins. It does not provide a reusable plugin architecture for this goal.

## Migration strategy

### Phase 0: harden and define the contract

Deliverables:

- threat model and plugin principal;
- package manifest and compatibility rules;
- WIT capability majors;
- limited UI schema dialect;
- permission request and approval model;
- app command ACL plan;
- CSP and asset-scope baseline;
- conformance test contract.

Exit criteria:

- no unresolved ambiguity about who grants network/auth/file access;
- a synthetic manifest can be validated without plugin-specific host branches;
- existing rows can be represented as `RuntimeKind::BundledRust` without behavior change.

### Phase 1: remove static control-plane coupling

Keep execution bundled, but replace plugin-specific catalog and UI logic:

- registration becomes one atomic object containing manifest, handlers, validators, and migrations;
- manifests include host-renderable configuration and preference schemas;
- `IntegrationEditor`, OCR, and Speech use schema-driven drafts;
- labels, icons, and fallback text come from sanitized manifest metadata;
- broker proxy/auth policy reads generic approved grants;
- Edge TTS moves through the broker or an equivalent bounded binary broker path.

Exit criteria:

- a new bundled plugin implementing an existing capability needs no changes in shared editors;
- production code no longer branches on Google/Edge plugin IDs outside compatibility adapters and plugin implementation modules.

### Phase 2: package store and lifecycle

Implement local manual installation of signed packages, content-addressed storage, permissions, version pinning, activation, rollback, and dependency-safe uninstall. Execution may remain disabled for external packages until the runtime is ready.

Exit criteria:

- corrupted, traversing, unsigned, incompatible, or permission-expanding packages fail closed;
- installation and recovery are crash-safe;
- missing packages preserve instances and bindings.

### Phase 3: Wasm runtime tracer bullet

First run a synthetic conformance Component that exercises only typed imports, limits, traps, cancellation, and denied permissions. Then port `com.langnext.google-translate-web` to a Wasm Component while retaining the bundled Rust implementation as an explicit per-instance fallback. Start with the pinned GTX origin; add the configurable HTTPS proxy only after dynamic-origin approval is tested.

Exit criteria:

- install -> create instance -> configure -> bind profile -> translate/detect -> upgrade -> rollback works;
- the guest cannot access sockets, filesystem, environment, raw credentials, or arbitrary endpoints;
- infinite loop, memory growth, oversized output, trap, timeout, and cancellation tests pass;
- no real-request shadow execution duplicates user text egress.

### Phase 4: schema-first plugin UX

Enable installed plugins in the existing Plugins, Translation, OCR, and Speech flows. Keep custom pages out of scope until the security baseline is complete.

Exit criteria:

- a synthetic third-party plugin can be configured and bound without React source changes;
- secrets remain write-only and host-owned;
- capability preference schemas drive domain editors without plugin-ID inference.

### Phase 5: binary data and Edge TTS

Add bounded blob resources and port Edge TTS. This validates binary responses, dynamic TTS preferences, and configurable endpoint approval.

Exit criteria:

- audio never travels as unbounded base64;
- byte, duration, timeout, cancellation, and ownership limits pass;
- direct plugin-specific `reqwest` access is removed from the execution path.

### Phase 6: Google Cloud multi-capability plugin

Port Google Cloud Translate, Detect, OCR, and TTS. Keep Google OAuth and token policy host-owned. Add STT only after its product contract defines formats, duration, streaming, microphone permissions, and retention.

Exit criteria:

- one instance and credential binding serve multiple capabilities;
- raw service-account JSON and access tokens never cross WIT or frontend IPC;
- capability-specific IAM failures are reported independently.

### Phase 7: LLM provider migration

Unify catalog metadata first, then port OpenAI Compatible as the first runtime LLM component. Preserve existing provider/model/profile IDs and retain explicit legacy fallback for one release cycle. Define a typed `StreamHandle` lifecycle for network input and output deltas before moving any streaming workflow.

Exit criteria:

- model listing, non-stream chat, streaming chat, translation fallback, and AI OCR fixtures pass through the runtime executor;
- switching execution backend does not rewrite provider/model identity;
- runtime failure never silently duplicates a request through legacy fallback.

### Phase 8: custom pages

After app-command ACL and CSP hardening, add dedicated plugin WebViews with a narrow bridge.

Exit criteria:

- plugin pages cannot invoke unrelated app commands;
- bridge calls cannot cross instance or package-version boundaries;
- remote scripts, navigation, unapproved network, and parent-page access are blocked.

### Phase 9: trusted native workers

Add only for a concrete local OCR/STT/model engine that cannot target Wasm. Define whether OS-level containment is required before accepting any third-party publisher.

### Phase 10: import, export, and recovery compatibility

Upgrade the configuration format so backups describe required runtime identity without embedding executable code.

Required behavior:

- export plugin ID, semantic version, package digest, publisher identity, config schema version, and capability major requirements;
- do not export package artifacts, secrets, credential refs, or trusted approval state;
- imported packages require local installation and permission approval again;
- absent packages restore instances and bindings as `plugin_missing` without downloading or executing code;
- import validates config and preference migrations against the exact installed version before activation;
- rollback snapshots remain local runtime state and are not treated as portable trust evidence.

## Recommended first implementation slice

Do not start by migrating Google Cloud, implementing a marketplace, or allowing custom pages.

Deliver the first slice as four consecutive tracer bullets:

1. **Security baseline:** application-command ACL, CSP, asset/navigation policy, plugin principal, WIT, and schema dialect.
2. **Synthetic runtime:** one conformance Component proves limits, denied imports, broker authorization, traps, and cancellation without package installation complexity.
3. **Package lifecycle:** content-addressed local installation, publisher approval, version pinning, and rollback using the synthetic Component.
4. **Real service:** Google Translate Web GTX through host-rendered schema UI, followed separately by configurable HTTPS proxy approval and rollback to the bundled Rust handler.

Together these prove bounded runtime execution, installation, dynamic capability discovery, dynamic configuration, and reversibility without making one integration milestone carry every new subsystem at once.

## Decisions required before implementation

1. **Distribution scope:** local signed package installation only, or a marketplace in the first release? Recommendation: local installation only.
2. **Publisher trust:** vendor-only keys, user-approved keys, or both? Recommendation: vendor keys plus an explicit advanced user approval path.
3. **Native trust:** first-party only, or cross-platform OS containment before third-party native plugins? Recommendation: first-party only until containment exists.
4. **Custom UI timing:** schema-only first, or custom pages in the first runtime release? Recommendation: schema-only first.
5. **LLM timing:** catalog consolidation now or after the first service Wasm plugin? Recommendation: after Google Translate Web proves the runtime.
6. **Mobile scope:** desktop only initially? Recommendation: desktop only because package execution, native workers, and custom pages need separate mobile constraints.

## Explicit non-goals for the first release

- dynamic Rust `.dll`, `.so`, or `.dylib` loading;
- arbitrary React/JavaScript injection into the main WebView;
- arbitrary JSON execution contracts;
- plugin-provided SQL migrations;
- raw secret or OAuth token access;
- ambient filesystem, socket, environment, or process access;
- native third-party plugins without OS containment;
- automatic marketplace updates;
- plugin-to-plugin calls;
- real-time STT or long-audio streaming;
- a big-bang rewrite of all existing providers and integrations.

## Final recommendation

Promote the existing “future external Wasm plugin” gate: the user goal now provides the concrete product requirement that gate was waiting for.

Preserve the current definition/instance/binding model, capability IDs, typed requests, vault, cancellation, and broker concepts. Replace static registration, plugin-specific host validation, direct transports, hardcoded React forms, and separate catalog identity with a package-driven control plane and runtime adapters.

The target should be described precisely:

> LangNext plugins are signed, version-pinned packages that declare known capabilities and permission requests. Untrusted service plugins execute as bounded Wasm Components with no ambient WASI access. The host owns all credentials, network authorization, persistence, and resource handles. Configuration is schema-rendered by default; optional custom pages run in separately permissioned WebViews. Native workers are trusted and out of process, not assumed sandboxed.

That architecture provides genuine dynamic extensibility without moving secrets or full OS authority into third-party code.

## Evidence

### Current repository

- `src-tauri/src/state.rs`
- `src-tauri/src/domain/service_integration.rs`
- `src-tauri/src/domain/service_capability.rs`
- `src-tauri/src/services/service_integration_registry.rs`
- `src-tauri/src/services/service_capabilities.rs`
- `src-tauri/src/services/service_integrations.rs`
- `src-tauri/src/services/network_broker.rs`
- `src-tauri/src/services/token_grant.rs`
- `src-tauri/src/services/edge_tts.rs`
- `src/features/plugins/IntegrationEditor.tsx`
- `src/features/plugins/integrationDraft.ts`
- `src/features/providers/registry.ts`
- `src/features/translate/translationEngineOptions.ts`
- `src/features/ocr/ocrProviderOptions.ts`
- `src/features/speech/speechProviderOptions.ts`
- `src-tauri/build.rs`
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`

### Reference repositories

- `F:/workspace/source/STranslate/src/STranslate.Plugin/IPlugin.cs`
- `F:/workspace/source/STranslate/src/STranslate.Plugin/IPluginContext.cs`
- `F:/workspace/source/STranslate/src/STranslate.Plugin/ITranslatePlugin.cs`
- `F:/workspace/source/STranslate/src/STranslate.Plugin/IOcrPlugin.cs`
- `F:/workspace/source/STranslate/src/STranslate.Plugin/ITtsPlugin.cs`
- `F:/workspace/source/STranslate/src/STranslate/Core/PluginManager.cs`
- `F:/workspace/source/STranslate/src/STranslate/Core/PluginAssemblyLoader.cs`
- `F:/workspace/source/STranslate/src/STranslate/Core/ServiceManager.cs`
- `F:/workspace/source/STranslate/src/STranslate.Plugin/Service.cs`
- `F:/workspace/my/langnext-translate/src-renderer/plugins/01.global.ts`
- `F:/workspace/my/langnext-translate/src-renderer/plugins/03.translate.ts`
- `F:/workspace/my/langnext-translate/src-tauri/src/plugin/mod.rs`

### Platform and runtime documentation

- Tauri v2 plugin development: compile-time crate/plugin registration through `Builder::plugin(...)`.
- Tauri v2 process model: Rust core has full OS access; WebViews are restricted through IPC.
- Tauri v2 capabilities: permissions constrain windows/WebViews, not Rust code.
- Tauri v2 IPC isolation pattern: frontend message interception, not a backend plugin sandbox.
- Tauri v2 CSP and asset protocol documentation.
- Wasmtime `/bytecodealliance/wasmtime/v38.0.4`: Component Model typed bindings, explicit linking, fuel, epoch interruption, and memory limits.
