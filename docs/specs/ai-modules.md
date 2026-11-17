# AI Modules

**Status:** Proposed for implementation review.

**Goal:** Separate provider configuration, API protocols, and Models workspace state. Use registered built-in modules as the base for later plugins.

**Implementation:** [AI Modules Plan](../plans/2026-11-18-ai-modules-plan.md).

## Scope and source of truth

This specification defines code ownership and extension contracts. [Provider Channels](provider-channels.md) remains the source of truth for user behavior, provider defaults, protocol choices, model identity, saving, and discovery. [Design System](../ui/DESIGNE.md) remains the source of truth for presentation.

Keep the five built-in provider types and four protocol IDs. Keep the current desktop layout and save scopes. Do not add dependencies, change NSH 0.5.1, or move business logic to Rust.

This work includes:

- A provider definition and a configuration-view contribution for each provider type.
- An independent module for each API protocol.
- Shared contracts, explicit registries, and one built-in assembly entry.
- A common request client and HTTP implementation.
- A controlled provider-settings boundary within the common channel editor.
- Model metadata enrichment outside protocol implementations.
- Removal of the old centralized provider/protocol implementation after its consumers move.

This work excludes:

- Dynamic imports of installed plugins, package discovery, hot unload, or a plugin marketplace.
- Plugin permissions, signature checks, sandboxing, and a version-negotiation system.
- Inference execution, request-body encoding, streaming, paid connection probes, or new translation features.
- New provider types in the shipped app or new provider-specific request controls.
- A schema-driven form engine, an untyped extension-settings bag, or per-model URLs and credentials.
- Persistent drafts, new retry queues, legacy readers, and storage migrations.
- Unrelated settings, navigation, and visual redesign.

The project is in the Demo stage. Keep existing serialized fields where no change is needed; this is a scope choice, not a promise of backward compatibility. Do not add migration code.

## Research findings

The inspected baseline is commit `e2e793a` on 2026-11-18.

| Evidence | Coupling | Required boundary |
| --- | --- | --- |
| `services/protocols/types.ts`: `AdapterRequestParams` | A wire-protocol request requires a provider preset ID. | Protocol input must not contain provider identity. |
| `services/protocols/routing.ts`: `resolveRequestTarget` | Provider defaults, protocol paths, and DeepSeek exceptions share one resolver. | Resolve provider policy before calling a protocol module. |
| `services/protocols/adapters.ts`: `listRemoteModels` | Protocol selection, provider exceptions, pagination, HTTP, and model-ID heuristics share one file. | Separate protocol behavior, transport, and metadata. |
| `features/models/provider-editor.tsx` | A 1,088-line component owns fields, requests, saves, model actions, and layout. | Extract an editor controller and controlled settings views. |
| `features/models/model-facts.ts`: `PRESET_CATALOG_PROVIDER` | Adding a provider also requires an unrelated feature-level mapping. | Put the catalog provider ID in the provider definition. |
| `services/protocols/presets.ts` and `types.ts` | Closed ID unions and centralized tables require edits for each extension. | Use open IDs with registry validation. |
| `components/ui/icon.tsx` and provider consumers | Provider branding depends on the shared icon-name union. | Let provider presentations contribute their existing assets. |

The existing implementation also has behavior to preserve. Models inherit the channel default dynamically. Model identity does not include protocol or URL. Saved editors are keyed by channel ID. Requests use current connection snapshots and cancel or ignore stale results. These are not defects to replace.

### Options considered

| Option | Result | Decision |
| --- | --- | --- |
| Split the existing large files by helper function. | Smaller files, but provider checks and dependency direction remain. | Insufficient. |
| Put each provider's UI and a copy of every supported protocol in one package. | Good provider locality, but duplicated protocols and fixes. | Reject. |
| Separate provider modules and protocol modules; compose them through a host. | Shared wire behavior, local provider rules, and replaceable configuration views. | Adopt. |
| Build a dynamic plugin runtime now. | Adds deployment and trust decisions that the current feature does not need. | Defer. |

## Domain terms and data

| Term | Meaning | Existing field |
| --- | --- | --- |
| Provider type | A registered policy such as OpenAI or DeepSeek. | `ProviderChannel.presetId` |
| Channel | One user-owned instance with a stable ID, connection, and models. | `ProviderChannel.id` |
| Protocol | A registered wire API, not a provider brand. | `adapterId` or `apiTypeOverride` |
| Discovery source | Historical metadata, not model identity or protocol precedence. | `sourceAdapterId` |

Introduce `ProviderTypeId` and `ProtocolId` as string-based IDs. Keep these built-in values:

- Provider types: `openai`, `gemini`, `anthropic`, `deepseek`, `custom`.
- Protocols: `openai-compatible`, `openai-responses`, `anthropic`, `gemini`.

Do not maintain a closed union that all extensions must modify. Validate IDs when a module registers and when a configuration is used. Require nonempty IDs. Do not add a naming scheme that rejects the current values.

Move shared channel, model, capability, discovery, and protocol contracts out of `features/models/`. Keep feature-only save inputs, filters, and view state in the feature. Do not rename serialized fields just to match the new type names.

Retain these rules:

```text
model identity = channel ID + modelKey
effective protocol = model override ?? channel default
```

Keep the existing `models.v2.*` storage keys and credential separation. Do not change the Models enabled-filter setting or the models.dev cache format.

## Module ownership

### Provider definition

A `ProviderDefinition` is plain TypeScript data and optional path policy. It has no component, Store, Storage, or credential access.

| Member | Contract |
| --- | --- |
| `id` | `ProviderTypeId`. |
| `labelKey` | Existing translation key for the provider name. |
| `allowedProtocolIds` | Ordered, nonempty list of registered protocols. |
| `defaultProtocolId` | A member of `allowedProtocolIds`. |
| `defaultBaseUrl` | Official default root, or `null` for Custom. |
| `catalogProtocolId` | Optional fixed discovery protocol. Omit it to use the selected default protocol. |
| `catalogProviderId` | models.dev provider ID, or `null` for model-ID-only lookup. |
| `resolveBaseUrl` | Optional function of `{ baseUrl, protocolId, operation }` that returns a path-adjusted root. `operation` is `catalog` or `model`. |

The optional root resolver can change the path, not the scheme, authority, or configured proxy host. It receives no credential. It must not perform I/O or select another protocol. The runtime rejects a transformed root that changes the origin.

Use the defaults and allowlists in Provider Channels. Catalog mappings are `openai`, `google` for Gemini, `anthropic`, `deepseek`, and `null` for Custom. A provider does not gain more protocols when its URL changes.

A normal provider needs no custom root resolver. Do not create equivalent callbacks for all five providers.

### Provider presentation

A `ProviderPresentation` has:

- `providerTypeId`, which references a registered provider definition.
- `Settings`, a component with the shared `ProviderSettingsProps` contract.
- `icon`, an NSH `ImageAsset` from the existing local provider assets.

Each provider owns its presentation contribution. All five can initially reuse `ConnectionFields` as their `Settings` component. Add a separate `settings.tsx` only when a provider has different controls or composition. Do not copy the common form or create wrappers that only rename props.

A new contribution must be able to supply a distinct `Settings` component without editing `ModelsPage`, the common editor, or existing provider modules. Provider components may import shared AI UI and `components/ui/`. They must not import the Models Store or editor controller.

`ProviderSettingsProps` is controlled. It supplies:

- The provider definition and `draft` or `saved` mode.
- Current protocol ID, URL input, and draft/replacement credential input.
- Saved-credential presence and the `keep`, `replace`, or `clear` edit state.
- URL error, insecure-HTTP state and consent, compact layout, and disabled state.
- Change callbacks for protocol, URL, credential input, credential mode, and HTTP consent.

The controller owns these values. The component reports edits but does not keep a second connection draft. Saved secrets are not loaded into the form. Keep credential inputs masked and preserve their placeholders and clear/keep actions.

Provider marks use contributed assets through `ProviderMark` and the existing Avatar fallback slot. A new provider must not require an entry in the global `IconName` union. Keep semantic tint tokens and decorative accessibility behavior.

### Protocol definition

Each `ProtocolDefinition` has:

- `id` and a translated `labelKey`.
- `resolveTarget(connection, operation)`, which returns the HTTP method, URL, and headers.
- `listModels(connection, context)`, which returns normalized remote records.

`ProtocolConnection` contains a resolved, nonempty `baseUrl` and a transient `credential`. `ProtocolContext` contains the HTTP boundary, optional abort signal, and optional timeout. Neither contains a provider ID, provider registry, feature state, UI component, or Storage handle.

Retain the existing catalog/model `RequestOperation` distinction. Catalog operations can carry pagination query fields. Model operations carry a model ID. Resolving a model target must not send a model request.

Protocol modules own:

- Standard endpoint and authentication rules.
- Catalog shape validation, model-ID normalization, and pagination.
- Protocol-specific response errors through the shared error contract.

Remote records contain model ID, optional display name, limits, and nullable capability facts. They do not require a model-brand heuristic. The runtime produces the existing complete `DiscoveredRemoteModel` shape after metadata enrichment.

OpenAI Chat Completions and Responses may share catalog decoding and authentication helpers. They remain separate protocol contributions. Anthropic pagination and Gemini pagination stay in their respective modules.

### Runtime and host

| Owner | Responsibility |
| --- | --- |
| AI registry | Register and look up definitions; reject invalid, duplicate, and unknown IDs. |
| AI client | Resolve provider policy, select a protocol, call it, and enrich discovery results. |
| Shared HTTP | `fetch`, JSON validation, timeout, external cancellation, and HTTP error categories. |
| Metadata layer | models.dev lookup, fallback model-ID heuristics, and fact precedence. |
| Models Store | State, serialized writes, write queue, revisions, credentials, and merge commits. |
| Editor controller | Current form values, request snapshots, request lifetime, saves, and model actions. |
| Common editor | Header, connection-card frame and actions, status, model table, and model dialogs. |
| Models page | Selection, provider picker, one draft, leave confirmation, and focus restoration. |

The common editor mounts the selected provider's Settings inside the connection card. The card title, Test, Cancel, Save, and request feedback remain host-owned. Provider Settings do not duplicate those actions or the model table.

## Request resolution

### Common flow

1. The host captures the current connection snapshot.
2. The host applies the existing URL and insecure-HTTP policy, resolves keep/replace/clear credentials, and checks the selected protocol against the provider.
3. The client gets the configured root or that provider's default. An empty Custom root rejects network actions.
4. For discovery, select `catalogProtocolId` when present; otherwise select the current channel default. For a model target, use its effective protocol.
5. Apply the provider's optional path policy using that execution protocol.
6. Call the protocol with the resolved root and transient credential. Preserve configured path prefixes.
7. For discovery, apply metadata facts and return normalized models. The host merges them into its own collection.

A provider's fixed catalog protocol does not change the channel default or any model override. Check the user's selected protocol even when discovery uses another protocol.

### DeepSeek composition

DeepSeek is a provider type, not a fifth protocol:

- Set `catalogProtocolId` to `openai-compatible`. Catalog requests use `/models` and Bearer authentication, including when Messages is selected.
- For a model operation using `anthropic`, remove a terminal `/anthropic`, `/anthropic/v1`, or `/v1` as the current resolver does, then append `/anthropic` to the root. The standard Anthropic module adds `/v1/messages` and its authentication headers.
- For Chat Completions and Responses, use the configured root without that transformation.
- Keep the existing path prefixes and proxy origin. Do not infer provider identity from the hostname.

For example, `https://proxy.example.com/deepseek` with Messages produces `https://proxy.example.com/deepseek/anthropic/v1/messages`. Its catalog remains `https://proxy.example.com/deepseek/models`.

### Metadata and network behavior

Preserve current observable limits and error categories:

- A default 15-second HTTP timeout and a maximum of 10 catalog pages.
- Anthropic `after_id` and Gemini `pageToken` pagination, deduplication, and current stop conditions.
- `auth`, `rate_limited`, `network`, `timeout`, `server`, `invalid_request`, `invalid_response`, and `cancelled` errors.
- An empty valid catalog is not an invalid response.
- Connection testing checks the catalog only. It does not fetch models.dev or run inference.
- Discovery starts the provider listing and the best-effort models.dev load in parallel.
- Catalog capabilities win when known. The existing model-ID heuristic is the fallback. Provider-reported token limits win over catalog limits.
- Discovery merging preserves stored user limits, overrides, enabled state, and local identity.
- models.dev retains its current cache, 24-hour refresh policy, and stale-cache fallback.
- Cancellation is checked after asynchronous metadata work and before returning or persisting results. A cancelled operation must not commit data.

Do not import provider modules into the heuristic. Moving the existing heuristic does not authorize new model-name rules.

## Registration and dependency rules

Create registries through factories for isolated callers and tests. Production uses one runtime registry and one presentation registry. Registry factories do not import or register built-ins themselves.

`app/ai-setup.ts` is the only built-in assembly entry. It registers protocols first, provider definitions second, and presentations last. Its initializer is idempotent. Call it before loading Models state in `App.tsx`. Keep the registries' duplicate-ID checks strict; do not implement idempotence by ignoring duplicate registration errors.

Registration rejects duplicate IDs, unknown protocol references, an invalid default protocol, and a presentation without a matching provider. Lookups never silently fall back to Custom or another protocol.

Keep definition and presentation imports separate. Runtime code must not import presentation modules, the common editor, or `features/models/`. Contracts must not import implementations or NSH UI.

```text
App bootstrap -> built-in definitions + presentations -> registries
Models page -> Store/controller -> AI client -> provider policy -> protocol -> HTTP
Provider Settings -> shared AI UI -> components/ui -> NSH
```

An installed module system can later feed these contracts. This work does not define how external code is loaded or trusted. Static modules run with the application's authority; these boundaries are not a sandbox.

## Target file organization

```text
modules/ai/
  contracts/
    channel.ts
    model.ts
    protocol.ts
    provider.ts
    errors.ts
  protocols/
    openai-chat/index.ts
    openai-responses/index.ts
    anthropic/index.ts
    gemini/index.ts
    openai-common.ts
  providers/
    openai/{definition.ts,presentation.ts}
    gemini/{definition.ts,presentation.ts}
    anthropic/{definition.ts,presentation.ts}
    deepseek/{definition.ts,presentation.ts}
    custom/{definition.ts,presentation.ts}
  runtime/
    registry.ts
    client.ts
    http.ts
    model-metadata.ts
  ui/
    contracts.ts
    registry.ts
    connection-fields.tsx
    provider-mark.tsx
    form-field.tsx
app/ai-setup.ts
features/models/
  editor/
    channel-editor.tsx
    controller.ts
    provider-settings.tsx
  page.tsx
  store.ts
```

These paths are planned, not existing APIs. Tests remain beside their owning code. Keep `services/models-dev/catalog.ts`, the existing provider SVG files, model table, and model dialogs. The implementation plan specifies when each new file is introduced.

At completion, remove `services/protocols/`, `features/models/provider-editor.tsx`, `features/models/model-facts.ts`, and `features/models/form-field.tsx` after moving all consumers and tests. Do not leave duplicate registries or permanent old-path compatibility exports.

## State, errors, and presentation

Keep one controller per draft or saved channel. Preserve the current channel-ID key: switching channels disposes the old editor and native inputs; updates to the same channel retain pending edits. A provider settings contribution is selected once for that owner's immutable provider type. Read changing props through NSH bindings, not snapshots or destructured props.

Keep these save scopes:

- First save: channel, supplied credential, and the currently visible draft models.
- Saved connection: connection settings only.
- Saved model actions: their existing immediate model writes.
- Cancelling connection edits does not roll back saved model changes.

Keep request fingerprints, abort on disposal/input change, revision conflicts, partial-save reporting, and draft discard/focus behavior. Do not create a second global draft Store.

If stored data references an unknown provider, channel-default protocol, or model override, retain the records and show a localized unsupported-configuration error. Do not make requests through missing modules or silently convert a record to Custom. Keep the common channel shell and deletion available. Known providers expose valid protocol choices for correction; show a selector for an unsupported current default even if that provider normally has one fixed protocol. An edited configuration cannot save an unsupported selected value. An unknown discovery-source ID alone is harmless metadata. A missing model override does not prevent an otherwise valid channel catalog request. This does not add a plugin recovery manager.

Reuse existing controls, tokens, test IDs, copy, motion, and keyboard behavior. Add translated protocol labels and the missing module/registration error keys to both locale files. Record the extraction and unchanged motion in the design document before editing UI code. Review light and dark at 1040 x 720 and 720 x 520 after extraction.

The host remains the credential owner. Keep raw secrets out of provider definitions, ordinary persisted records, registry descriptors, diagnostic messages, and screenshots. Do not add credential logging. Existing credential Storage is not a newly introduced secure vault.

## Acceptance criteria

| ID | Required result |
| --- | --- |
| AM-01 | A caller can register a non-built-in provider or protocol ID without changing a union or existing module. |
| AM-02 | Duplicate, unknown, and invalid module references produce explicit errors; no lookup silently uses Custom. |
| AM-03 | A protocol can resolve targets and list models without a provider ID, UI, feature Store, or provider implementation. |
| AM-04 | All four protocols preserve current model/catalog targets, authentication, query rules, and proxy prefixes. |
| AM-05 | DeepSeek discovery uses its shared catalog independently of the selected model protocol; Messages retains its special path. |
| AM-06 | Pagination, deduplication, timeouts, cancellation, JSON validation, and HTTP error categories remain correct. |
| AM-07 | Metadata mapping belongs to providers; enrichment preserves cache behavior, fallback capabilities, and limit precedence. |
| AM-08 | The selected provider's registered Settings renders in the common editor; a distinct contribution needs no editor branch. |
| AM-09 | Provider views are controlled; channel switching, same-channel updates, and stale requests preserve existing isolation. |
| AM-10 | Model identity, protocol inheritance, overrides, missing-model state, and local configuration remain unchanged. |
| AM-11 | Draft, saved-connection, and model save scopes, credential isolation, and partial-write recovery remain unchanged. |
| AM-12 | Existing URL consent applies; provider path policy cannot switch origins or silently use an official host. |
| AM-13 | English/Chinese copy, accessibility, focus, existing motion, and minimum-size layout remain usable. |
| AM-14 | One idempotent bootstrap composes five providers and four protocols without new dependencies or a dynamic loader. |
| AM-15 | Runtime dependencies point downwards; old centralized implementations and global provider-brand registration are removed when unused. |
| AM-16 | Unsupported stored module references remain visible and recoverable without requests through missing modules, fallback conversion, or data deletion. |

Implementation approval must cover the public test boundaries in the linked plan. This document records the proposed result; it does not report that the refactor or its tests have run.
