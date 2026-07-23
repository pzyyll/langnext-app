# Google Cloud Plugin Architecture Assessment

## Executive Summary

The proposal is feasible and materially better than adding Google credentials separately to Translation Profiles, OCR services, and future Speech settings.

The strongest design is not “each page owns a Google provider,” but a three-layer model:

1. **Plugin definition** — bundled code, manifest, capability handlers, setting schemas, permissions.
2. **Plugin instance** — one user-configured Google Cloud account/environment with shared project, location, service-account credential, proxy policy, and health state.
3. **Capability binding** — a Translation Profile, OCR service, or Speech profile references a plugin instance and stores only capability-specific runtime preferences.

A Google Cloud plugin instance can then expose typed capabilities such as `translate.text@1`, `translate.detect@1`, `ocr.image@1`, `speech.recognize@1`, and `speech.synthesize@1`.

Do **not** let plugins own the OS vault directly. The host must remain the credential and network broker. The plugin declares required secret slots and endpoint permissions; the host stores secrets, obtains short-lived OAuth tokens, injects authentication, enforces endpoint allowlists, applies timeouts, and redacts logs.

For the first implementation, use **bundled, statically registered plugins** behind a runtime registry. Do not begin with downloadable native DLLs. Keep a versioned contract that can later support WASM Component Model plugins; use an out-of-process host only if future offline OCR/Speech engines require native binaries or other languages.

## Verdict

### What is reasonable

- Shared Google Cloud authentication belongs at a plugin-instance level.
- OCR, Translation, and Speech pages should store only runtime preferences and a reference to the shared instance.
- Provider choices in New Profile / Add OCR should come from capability discovery, not hardcoded enums.
- A top-level plugin configuration page is the correct place to create multiple Google Cloud instances, rotate credentials, enable capabilities, and inspect health.
- Registration should be capability-based so one plugin can implement multiple services.

### What needs correction

1. **“The plugin maintains credentials” must mean logical ownership, not direct vault access.** The host owns storage and secret access. Plugins declare credential requirements.
2. **Do not extend the existing chat-shaped `ProviderPlugin` contract with more operations.** `ChatOperation = "translate" | "detect" | "ocr"` and `ChatBuildInput` already mix unrelated input models. Speech would make this substantially worse.
3. **Do not represent Google Cloud Translation as a fake model.** Translation Profiles currently target `provider_model_id`; a first-class service capability needs a different target/binding type.
4. **Do not use dynamic native libraries as the external plugin mechanism.** They share the host address space, have unstable Rust ABI concerns, and can crash or compromise the app.
5. **Do not treat GTX/proxy as Google Cloud.** They have different trust, authentication, SLA, and endpoint semantics.

## Important Product Boundary: Google Cloud vs Google Web Translation

The official v3beta1 Translation API, Cloud Vision OCR, and Cloud Speech share Google Cloud project/IAM/service-account configuration. They belong in one `google-cloud` plugin.

GTX and `googlet.deno.dev` do not use Google Cloud credentials:

- GTX is an unofficial Google Translate web endpoint.
- `googlet.deno.dev` is a third-party proxy.

Recommended catalog:

| Plugin                              | Capabilities                                                      | Shared configuration                                             |
| ----------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `com.langnext.google-cloud`         | v3beta1 Translate/Detect, Vision OCR, Speech recognize/synthesize | Project ID, default location, service-account JSON, proxy policy |
| `com.langnext.google-translate-web` | GTX translate/detect, optional third-party proxy translate        | Free-channel choice, optional proxy URL; no Cloud credential     |

The UI may group both under a **Google** family, but persistence and execution should keep them separate. This prevents a third-party proxy preference from being stored beside a privileged service-account private key and makes privacy status explicit.

If a single umbrella plugin is still preferred, its manifest should register separate capability implementations and separate permission sets; it should not use one ambiguous `channel` switch inside a single handler.

## Current Architecture Evidence

### Reusable foundations

- `src/features/providers/types.ts` already separates provider wire construction from native transport, but its interface is chat/model-specific.
- `src/features/providers/registry.ts` provides duplicate-ID rejection, deterministic registration order, missing-plugin errors, and manifest lookup.
- `src-tauri/src/services/provider_http.rs` already provides valuable broker behavior:
  - relative paths only;
  - blocked sensitive headers/query names;
  - vault-side auth injection;
  - proxy policy;
  - redirects disabled;
  - cancellation;
  - request/response size limits;
  - sanitized debug output.
- `src-tauri/src/credentials/*` provides vault references and crash-safe credential mutation recovery.
- `src/features/ocr/AddOcrServiceDialog.tsx` demonstrates provider selection UX, but options are currently a hardcoded `"baidu" | "ai"` union.
- `src-tauri/src/state.rs` is the application service composition root and is the natural place to add an authoritative service-integration registry.
- `docs/architecture/frontend-state-management.md` already defines the correct frontend boundaries: SQLite/Rust is authoritative, TanStack Query caches DTOs, and Effect owns typed IPC/workflows.

### Structural blockers

- `ChatOperation` and `ChatBuildInput` are unsuitable as a universal capability protocol.
- `TranslationProfileTarget` can reference only a model.
- `OcrProviderType` is a closed Rust/TypeScript enum.
- Credentials use a growing `OwnerKind` enum. OCR needed one owner kind per secret slot, which will not scale to arbitrary plugins.
- The frontend TypeScript registry is authoritative for model-provider plugins; cross-service plugin registration should be authoritative in Rust to avoid frontend/backend manifest drift.
- `ProviderHttpService` resolves one base URL from `provider_instances`; Google Cloud needs named endpoint families plus OAuth token exchange.

## Recommended Conceptual Model

```text
PluginDefinition (code/catalog; one per plugin id)
  ├─ Manifest
  ├─ Common configuration schema
  ├─ Credential slot declarations
  ├─ Endpoint/permission declarations
  └─ Capability registrations
       ├─ translate.text@1
       ├─ translate.detect@1
       ├─ ocr.image@1
       ├─ speech.recognize@1
       └─ speech.synthesize@1

PluginInstance (user configuration; zero or many per definition)
  ├─ display name
  ├─ plugin id + installed version
  ├─ non-secret config JSON + schema version
  ├─ credential bindings (host vault refs)
  ├─ enabled capabilities
  └─ health / validation status

CapabilityBinding (domain resource)
  ├─ TranslationProfile / OcrService / SpeechProfile
  ├─ plugin instance id
  ├─ capability id + major version
  └─ capability-specific preferences JSON
```

### Why multiple plugin instances matter

Users may need separate work/personal projects, billing accounts, regions, or service accounts. Persist references to `integration_instance_id`, never just `plugin_id`.

## Typed Capability Contracts

Keep the set of host-recognized capability kinds closed and versioned; allow an open set of plugins to implement them.

Do not use one generic `execute(name, JSON)` trait as the primary in-process contract. It loses compile-time guarantees and shifts failures to runtime. Prefer one typed trait per capability, then erase it only at the registry boundary.

Conceptual Rust contracts:

```rust
#[async_trait]
pub trait TranslateTextCapability: Send + Sync {
  async fn translate(
    &self,
    request: TranslateTextRequest,
    preferences: TranslatePreferences,
    context: ExecutionContext,
  ) -> Result<TranslateTextResponse, PluginError>;
}

#[async_trait]
pub trait OcrImageCapability: Send + Sync {
  async fn recognize(
    &self,
    request: OcrImageRequest,
    preferences: OcrPreferences,
    context: ExecutionContext,
  ) -> Result<OcrImageResponse, PluginError>;
}
```

Registry storage can use a tagged handler enum:

```rust
pub enum CapabilityHandler {
  TranslateText(Arc<dyn TranslateTextCapability>),
  DetectLanguage(Arc<dyn DetectLanguageCapability>),
  OcrImage(Arc<dyn OcrImageCapability>),
  SpeechRecognize(Arc<dyn SpeechRecognizeCapability>),
  SpeechSynthesize(Arc<dyn SpeechSynthesizeCapability>),
}
```

This deliberately requires a host release to introduce a completely new first-class capability kind. That is desirable: a new capability also requires domain types, UX, permissions, IPC, and workflows.

### Capability IDs

Use stable reverse-domain plugin IDs and versioned capability IDs:

```text
plugin:      com.langnext.google-cloud
capability:  translate.text@1
capability:  translate.detect@1
capability:  ocr.image@1
capability:  speech.recognize@1
capability:  speech.synthesize@1
```

Compatibility should use capability **major** versions. Additive request/response fields remain optional within one major version.

## Manifest Design

The manifest is metadata and policy, not executable UI code.

```json
{
  "manifestVersion": 1,
  "pluginApiVersion": "1.0",
  "id": "com.langnext.google-cloud",
  "version": "1.0.0",
  "displayNameKey": "plugins.googleCloud.name",
  "minHostVersion": "0.1.0",
  "credentialSlots": [
    {
      "id": "service-account-json",
      "kind": "secret_json",
      "required": true
    }
  ],
  "endpoints": {
    "oauth": "https://oauth2.googleapis.com",
    "translate": "https://translation.googleapis.com",
    "vision": "https://vision.googleapis.com",
    "speech": "https://speech.googleapis.com",
    "textToSpeech": "https://texttospeech.googleapis.com"
  },
  "capabilities": [
    { "id": "translate.text@1", "preferencesSchemaVersion": 1 },
    { "id": "translate.detect@1", "preferencesSchemaVersion": 1 },
    { "id": "ocr.image@1", "preferencesSchemaVersion": 1 },
    { "id": "speech.recognize@1", "preferencesSchemaVersion": 1 },
    { "id": "speech.synthesize@1", "preferencesSchemaVersion": 1 }
  ]
}
```

The authoritative catalog for **service integrations** should come from Rust. The existing model-provider plugins remain TypeScript-authoritative in the first slices; do not rewrite them as a prerequisite.

The frontend discovery layer merges two explicit sources:

1. a built-in `LlmTranslationEngine` option backed by the existing TypeScript `ProviderPlugin` + model workflow;
2. sanitized Rust integration instances/capabilities returned by catalog IPC.

Execution remains equally explicit: LLM calls continue through `translationWorkflow.ts` + `providerFetch`; service-capability calls go through Rust plugin commands. This dual-catalog bridge avoids pretending that one registry already owns both systems and can be removed only in an optional later consolidation.

## Persistence Model

### Integration instances

Use `integration_instance` as the persistence/IPC term to avoid confusion with the existing LLM `provider_instances`. “Plugin instance” remains the conceptual/user-facing term in this document.

```text
integration_instances
- id UUID PK
- plugin_id TEXT
- plugin_version TEXT
- display_name TEXT
- enabled INTEGER
- config_json TEXT                 // non-secret common config
- config_schema_version INTEGER
- health_status TEXT               // persisted: unconfigured | unvalidated | ready | degraded
- last_validated_at TEXT NULL
- last_error_code TEXT NULL
- created_at TEXT
- updated_at TEXT
```

For Google Cloud, `config_json` contains non-secrets such as project ID, default location, and proxy mode. DTO `effectiveStatus` derives `plugin_missing` from registry lookup and `disabled` from `enabled = false`; neither is persisted as health.

### Generic credential bindings

The current `OwnerKind` expansion pattern should be generalized **for integration instances** before more integration secrets are added:

```text
integration_credential_bindings
- id UUID PK
- integration_instance_id TEXT
- slot_id TEXT                    // service-account-json, api-key, secret-key
- credential_ref TEXT NULL
- updated_at TEXT
UNIQUE(integration_instance_id, slot_id)
```

The credential operation journal must serialize by `(owner_type, owner_id, slot_id)` or a binding ID, rather than adding one Rust enum variant per secret slot.

Phase 1 does **not** migrate existing `provider_instances.credential_ref` or OCR credential refs. Those keep their current storage/recovery paths to avoid a risky dual-domain rewrite. The generic binding becomes the rule for new integration plugins; existing credential owners may migrate in a later dedicated change.

Vault references can follow:

```text
integration/{integration_instance_id}/{slot_id}/{operation_id}
```

### Capability enablement and preferences

Optional capability visibility/preferences may later live in a generic table:

```text
integration_instance_capabilities
- integration_instance_id
- capability_id
- enabled                         // UI filtering, not an IAM/security boundary
- config_json                     // capability-wide config, not per profile/service
- config_schema_version
```

Do not block the initial Google Translation slice on this table. Google IAM remains authoritative; a locally enabled capability can still fail with `permission_denied`.

Domain bindings remain in their domain tables:

- Translation Profile: engine kind + plugin instance/capability + translation preferences.
- OCR service: plugin instance/capability + OCR preferences.
- Speech profile: plugin instance/capability + voice/audio preferences.

Use foreign keys with `ON DELETE RESTRICT` for configured plugin instances. Deleting a shared Google instance must never silently delete profiles/OCR/Speech bindings. Show dependencies and require reassignment or explicit deletion.

## Translation Profile Integration

Do not add one Google-specific column set to `translation_profiles`.

Introduce an engine discriminant:

```text
TranslationEngineBinding
- LlmModelChain {
    targets, prompts, temperature, max_output_tokens,
    llm_language_detection, ...
  }
- PluginCapability {
    integration_instance_id,
    capability_id = "translate.text@1",
    detect_capability_id = "translate.detect@1" | null,
    preferences_json
  }
```

All existing rows migrate to `LlmModelChain`. The LLM branch retains ordered model fallback, prompts, streaming, and LLM detector settings unchanged. The plugin branch has no model targets/prompts/temperature; source `auto` uses its registered detect capability or provider-returned detected language.

The New Profile dialog becomes capability-driven:

1. Built-in **LLM Translation** option.
2. Each ready plugin instance exposing `translate.text@1`.
3. Disabled/unconfigured instances may appear disabled with “Configure in Plugins.”

If several Google Cloud instances exist, list each by display name, e.g. “Google Cloud — Work” and “Google Cloud — Personal.”

## OCR Integration

Do not re-platform working OCR paths just to satisfy the abstraction. Evolve the domain discriminant to:

```text
OcrEngineBinding
- Baidu                           // existing native Rust HTTP path
- AiModel { model_id, prompts }   // existing TypeScript ProviderPlugin path
- PluginCapability {
    integration_instance_id,
    capability_id = "ocr.image@1",
    preferences_json
  }
```

Google Cloud Vision uses the new Rust capability handler. AI OCR remains on its existing frontend model/prompt workflow; Baidu remains native. A later adapter façade may make dispatch look uniform, but it must not imply that Baidu uses the network broker unless its HTTP/token implementation is actually migrated.

The OCR page stores only OCR preferences: operation mode, language hints, layout/document behavior, and output preferences. It does not store Google credentials or project details.

## Speech Integration

Split Speech into at least two capability types:

- `speech.recognize@1` — audio to text (STT).
- `speech.synthesize@1` — text to audio (TTS).

Do not create one ambiguous `speech` operation. Their requests, responses, streaming direction, preferences, and permissions differ.

Avoid base64 for large/streaming audio. Prefer Tauri Channels with byte chunks or host-managed resource/file handles. Define hard payload, duration, and buffer limits from the beginning.

## Plugin Configuration UX

Add a top-level `/plugins` route (user-facing label may be **Integrations**, while internal names remain “plugin”).

### Page structure

- Left rail: configured plugin instances.
- Add button: catalog of available plugin definitions.
- Editor:
  - instance display name;
  - shared non-secret config;
  - secret slots with replace/clear semantics;
  - enabled capabilities;
  - credential validation state;
  - per-capability health/status;
  - dependency list (profiles/OCR/Speech using the instance).

“Add plugin” in the first phase means **create a configuration instance of bundled plugin code**, not download executable code. The UI should make this distinction clear.

### Settings UI strategy

For the first Google Cloud vertical slice, use a host-owned typed form. The configuration is small and Base UI styling/accessibility already has established project patterns.

Keep schemas in the contract for validation/versioning, but defer a generic JSON Schema form renderer until at least two materially different plugins demonstrate repeated form structure. Do not let plugins inject arbitrary React/JavaScript UI.

The eventual schema layers remain:

1. Common non-secret settings.
2. Credential slot declarations rendered by host controls.
3. Capability preferences rendered in Profile/OCR/Speech pages.

External plugins, if introduced, should be schema-only; complex built-ins may map a trusted editor ID to a host-owned component.

## Credential and OAuth Architecture

### Rules

- The host owns the OS vault and credential journal.
- DTOs expose only `hasCredential`/slot status.
- Plugin settings JSON never contains secrets.
- Secret replacement uses `keep | replace | clear`.
- Import/export omits secrets.
- Logs/errors never contain service-account JSON, private keys, access tokens, user text, image bytes, or audio.

### Google Cloud flow

```text
Google capability handler
  → requests TokenGrant { integration_instance_id, capability_id, scopes, audience }
  → Credential Broker verifies the trusted Google auth driver + manifest grant
  → broker loads service-account JSON from vault
  → driver validates client_email/private_key/token_uri and signs JWT
  → broker exchanges JWT only at the pinned oauth2.googleapis.com endpoint
  → token cached in memory by instance + credential revision + normalized scope set
  → Network Broker injects Bearer token; handler receives no raw secret/token
  → capability calls an approved Google endpoint
```

This is a new host primitive, not a minor extension of the current static `inject_auth` function. Capability handlers cannot choose arbitrary token endpoints, audiences, or scopes.

Default OAuth scopes must be derived from enabled/invoked capabilities with least privilege. Do not default every instance to broad `cloud-platform` when a narrower API scope is sufficient. Cache tokens with expiry skew. Changing/clearing credentials increments a credential revision and evicts cached tokens immediately.

External/untrusted plugin code must never receive the raw service-account JSON. It receives an opaque grant or relies entirely on host-side header injection.

## Network Broker

Generalize `ProviderHttpService` rather than allowing plugin code arbitrary `reqwest` access.

A plugin request should reference a manifest endpoint alias, not an arbitrary origin:

```text
endpoint: "translate"
relativePath: "v3beta1/projects/.../locations/global:translateText"
```

The host resolves the alias, validates the capability is allowed to use it, injects auth, applies global/per-instance proxy policy, disables redirects, applies size/time limits, and records sanitized telemetry.

Official Google Cloud endpoint aliases are pinned by the manifest and cannot be overridden by user Base URLs. The separate free/proxy integration may accept a custom endpoint only with HTTPS, no credentials, explicit third-party data-egress warning, and strict size/time limits.

Preserve existing safeguards from `provider_http.rs`. Add:

- endpoint alias allowlist;
- capability-to-endpoint permission checks;
- per-capability request/response limits;
- retry policy only for safe/idempotent cases and provider-indicated throttling;
- concurrency limits per plugin instance;
- `Retry-After` support;
- optional circuit-breaker state only after real failure patterns justify it.

## Error Contract

Normalize plugin failures into stable host codes:

```text
invalid_configuration
credential_unavailable
auth
permission_denied
quota_exceeded
rate_limited
unsupported_input
unsupported_language
network
timeout
invalid_response
provider_unavailable
plugin_unavailable
cancelled
internal
```

Include `retryable`, sanitized provider code, capability ID, and request ID. Never expose raw provider bodies by default.

## Cancellation, Streaming, and Resource Limits

Every execution receives an `ExecutionContext` containing:

- request ID;
- cancellation token;
- deadline;
- plugin/capability/instance identity;
- credential broker handle;
- network broker handle;
- structured logger/span;
- payload limits.

Translation/OCR can initially be unary. Speech contracts should support streaming from the start. Cancellation must propagate to HTTP requests, token exchange, WASM execution, or child-process RPC.

## Observability and Health

Use structured spans/records with:

- plugin ID/version;
- plugin instance ID;
- capability ID/version;
- request ID;
- duration;
- normalized result code;
- retry count;
- bytes in/out (not content).

Track health separately:

- **Configuration health:** schema/credential validity.
- **Authentication health:** token exchange result.
- **Capability health:** last successful/failed invocation per capability.

Avoid one global “connected” flag: a service account can authenticate while lacking Vision or Speech IAM permissions.

## Runtime Strategy

### Phase 1 — Bundled service-integration registry (recommended now)

- Integration plugins are compiled into the app.
- Rust `PluginRegistry` is authoritative for service integrations only.
- Existing LLM provider plugins stay TypeScript-authoritative and execute through the existing model workflow.
- Frontend discovery explicitly merges the built-in LLM engine option with Rust integration capabilities.
- Registration uses typed capability handlers.
- Plugin page creates/removes integration instances.
- This gives the desired UX and shared credentials without introducing untrusted code execution.

Tauri’s own plugin system is not a runtime marketplace. Official docs show Tauri plugins added as Cargo/npm dependencies and registered with `Builder::plugin(...)`; therefore this application-level registry is a separate subsystem.

### Phase 2 — WASM Component Model (only when external plugins are required)

Use Wasmtime + WIT worlds per capability. Benefits:

- memory isolation;
- explicit host imports;
- fuel/epoch interruption;
- language-neutral contracts;
- versioned WIT packages.

The WASM guest should receive broker handles, not filesystem/network/vault access. Set memory limits, fuel/epoch deadlines, response limits, and signed package verification.

### Phase 3 — Out-of-process plugins (only for native/heavy engines)

Use a managed child process and versioned local RPC for Python/C++ offline OCR or Speech engines that cannot target WASM. Provide startup handshake, health checks, cancellation, deadlines, restart limits, stdout/stderr redaction, and OS process containment.

### Not recommended — Dynamic native libraries

Do not load third-party `.dll/.so/.dylib` into the Tauri process. They have no meaningful fault isolation and can compromise or crash the host. Rust ABI is not stable; a C ABI sacrifices much of the type-safety benefit.

## Versioning and Migrations

Track independently:

- `manifestVersion` — manifest syntax.
- `pluginApiVersion` — host/plugin execution contract.
- plugin semantic version.
- capability major version.
- plugin instance config schema version.
- capability preference schema version.

Plugin code must not execute arbitrary SQL migrations. The host migrates plugin JSON config transactionally through registered, versioned migration functions. External plugin upgrades should be staged: validate package/signature/compatibility, migrate copied config, activate, then retire the prior version.

Missing plugin code must not destroy persisted configurations. Mark instances/bindings `plugin_missing`, keep them visible, and fail closed.

## Testing Strategy

- Manifest validation and duplicate registration tests.
- Capability contract tests per implementation.
- Fake credential and network brokers; no live provider calls in normal tests.
- Golden response parser tests for Google APIs.
- Credential replacement/recovery/token-cache invalidation tests.
- Permission/endpoint-denial tests.
- Cancellation/deadline/size-limit tests.
- Migration tests for existing LLM Profiles and OCR services.
- UI tests for dynamic capability options and unresolved plugin states.
- Optional ignored live smoke tests requiring explicitly supplied credentials.

## Incremental Migration

Prefer vertical slices that produce user-visible value. Do not build a generic marketplace, schema renderer, Speech transport, or WASM runtime before Google Translation validates the contracts.

### Slice 1: Google Cloud integration + Translation vertical slice

- Add the minimum manifest/typed registry needed for one bundled Google Cloud definition.
- Add `integration_instances`, integration credential slot journal/recovery, catalog IPC, and a host-owned `/plugins` Google Cloud editor.
- Add the host `TokenGrant` broker and pinned Google endpoint broker.
- Configure and validate project/location/service-account JSON; secrets stay out of DTO/export.
- Implement v3beta1 Translate/Detect handlers.
- Add the plugin-backed Translation Profile engine variant; migrate every existing profile to the unchanged LLM variant.
- New Profile discovery merges `LLM Translation` with ready Rust integration instances.
- Add export/import structure (without secret), dependency checks, startup credential-journal recovery, and cross-window Query invalidation.

### Slice 2: Google free translation integration

- Register a separate zero-secret Google Web/Free integration for GTX.
- Add optional HTTPS-only proxy instances with explicit privacy warning and no credential slots.
- Reuse the plugin-backed Translation Profile binding without mixing proxy config with Google Cloud credentials.

### Slice 3: Google Cloud OCR

- Extend OCR binding with `PluginCapability` while preserving existing `Baidu` and `AiModel` workflows.
- Add Google Cloud Vision handler using the shared Google Cloud integration instance.
- Defer Baidu network-broker migration unless it is explicitly included and tested as a separate task.

### Slice 4: Speech (future product feature)

- Define STT and TTS separately only when product requirements exist.
- Add binary streaming/resource transport and hard limits before implementing Google Cloud Speech.

### Slice 5: Generic settings schemas and external runtime (optional)

- Introduce a generic Base UI schema renderer only after repeated settings patterns justify it.
- Add signed WASM packages only after bundled contracts stabilize across real Translation/OCR/Speech capabilities.

### Slice 6: Consolidate model-provider plugins (optional)

- Adapt the TypeScript model-provider registry into a shared catalog only if the dual-catalog UX becomes costly.
- Do not block Google Cloud work on a complete rewrite of existing LLM adapters.

## Changes to the Existing Google Translation Plan

`docs/plans/2026-07-24-google-translate-profile-plan.md` should be considered superseded in its storage/auth ownership design before implementation.

Keep from that plan:

- official API is v3beta1 only;
- service-account OAuth, project ID, location;
- GTX/proxy support as free translation capabilities;
- no secret crosses frontend DTOs;
- Google translation is non-streaming initially.

Replace:

- Google-specific credential/config columns on `translation_profiles`;
- profile-owned service-account vault reference;
- hardcoded `LLM | Google` type union;
- a monolithic Google channel switch.

Use plugin-instance references and capability discovery instead.

## Final Recommendation

Proceed with the plugin direction, with these decisions locked first:

1. Build **application-level bundled plugins**, not runtime Tauri plugins or native DLLs.
2. Separate **plugin definition**, **plugin instance**, and **capability binding**.
3. Keep Google Cloud official services in `com.langnext.google-cloud`; keep GTX/proxy in a separate web/free plugin, optionally grouped as Google in UI.
4. Make Rust authoritative for **service integrations**; preserve the TypeScript LLM registry through an explicit dual-catalog bridge.
5. Use typed capability traits, not `ChatOperation` growth or generic JSON execution.
6. Add a real host-owned OAuth `TokenGrant` broker; do not treat service-account auth as static bearer injection.
7. Generalize credential slots for new integrations without migrating existing Provider/OCR secrets in the first slice.
8. Deliver Google Translation as the first vertical slice; defer schema UI, Speech, and external runtimes.
9. Add WASM only when third-party installable plugins become a real requirement.

## References

### Local

- `docs/architecture/adapter-strategy.md`
- `docs/architecture/frontend-state-management.md`
- `src/features/providers/types.ts`
- `src/features/providers/registry.ts`
- `src-tauri/src/services/provider_http.rs`
- `src-tauri/src/credentials/`
- `src-tauri/src/domain/translation_profile.rs`
- `src-tauri/src/domain/ocr_service.rs`

### External

- Tauri plugin development and permission model: https://github.com/tauri-apps/tauri-docs/tree/v2/src/content/docs/develop/Plugins
- Tauri plugin registration (`Builder::plugin`): https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/plugin/logging.mdx
- Wasmtime security: https://docs.wasmtime.dev/security.html
- Wasmtime interruption: https://docs.wasmtime.dev/examples-interrupting-wasm.html
- WebAssembly Component Model / WIT: https://component-model.bytecodealliance.org/design/wit.html
- HashiCorp go-plugin subprocess model: https://github.com/hashicorp/go-plugin
