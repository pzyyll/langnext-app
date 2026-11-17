# Implementation Plan

**Goal:** Separate provider configuration and API protocols into registered modules without changing the Models workspace's current behavior.

**Inputs:** [AI Modules](../specs/ai-modules.md), AM-01 through AM-16; [Provider Channels](../specs/provider-channels.md); [Design System](../ui/DESIGNE.md); baseline commit `e2e793a`.

**Assumptions:**

- This request authorizes documentation only. Confirm this plan and seams S1-S4 before implementation or test changes.
- Keep TypeScript/TSX state ownership, NSH 0.5.1, current dependencies, five shipped providers, and four protocol IDs.
- Keep current serialized field names and storage keys to avoid unrelated churn. Do not add legacy readers, migration, or old-path compatibility as a delivery requirement.
- Keep all five provider forms visually unchanged. Each contributes a Settings entry; identical forms reuse the same component directly.
- Build only static, explicitly registered modules. External package loading and plugin trust decisions remain out of scope.

**Architecture:** The host resolves a current connection snapshot and provider policy before it calls an independent protocol module through the AI client. Provider presentation contributions supply controlled connection fields inside the common editor; the host retains state, credentials, requests, saving, and model operations. Bootstrap registers protocol definitions, provider definitions, and presentations before loading Models state.

**Tech Stack:** TypeScript, TSX, NSH signals and `nsh/test`, NSH Storage, `fetch`, `AbortController`, mise, oxlint, oxfmt, and the existing Rust host.

---

## Execution rules

Run tasks in order. Create each file when its first slice needs it, not as an empty directory exercise.

For new behavior:

1. Write one test at its named seam with literal expectations from the spec.
2. Run the exact filtered command listed for that case and observe its behavioral failure.
3. Implement the smallest working path and run the same command again.
4. Repeat for the next case. Do not write the entire task's test matrix first.
5. Run affected regressions and commit the completed task locally.

An import error, unrelated type error, runner failure, or zero matched tests is not a behavioral red result. For a new public surface, first make its signature callable with the smallest temporary scaffold. Confirm the behavioral failure before implementing its promised behavior. Do not commit that scaffold or a placeholder.

For preserved behavior and extraction, a test can already pass at the baseline. Record that result, keep the regression, and move working code in a separate review/extraction step. Do not damage correct code to manufacture a failure. Existing tests are evidence to preserve, not tests to weaken until a refactor passes.

Tests may control external HTTP, time, and native Storage boundaries. Do not mock provider modules, protocol modules, the Store, or the controller. Registry tests may register in-test contributions; those are real inputs to the public registry, not production mock modes. Keep test-only contributors and view harnesses outside the application entry.

Do not replace the Store or editor wholesale. Do not add a generic plugin framework, inference, arbitrary extension settings, or unrelated cleanup. Do not commit failing tests, skipped required cases, `test.only`, or placeholders.

After each completed implementation task, create a local Conventional Commit. Do not push. Use no major-release marker or footer without explicit approval.

## Repository evidence and commands

- `.mise/tasks/test` runs `nsh test . "$@"`. Use `mise run test -- --filter "substring"` for one case. Do not append a second path to this task.
- The installed `mise exec -- nsh test --help` confirms that `--filter` is a test-name substring filter and that a direct `nsh test` accepts one file or directory path.
- `.nsh/types/nsh/test.d.ts` defines `OpenOptions.network`, request inspection, storage snapshots, keyboard input, clock control, and screenshots. `OpenOptions.modules` is headless-only. There is no `routes` option.
- `.mise/tasks/test-desktop` runs root and feature `*.test.tsx` files on the native desktop. New protocol, registry, and Storage-boundary suites must use `.test.ts` when they are not desktop UI tests.
- `.mise/tasks/verify` runs format check, lint, type checks, tests, and build. `format-check` ignores `docs/**` through `.oxfmtrc.json`; it does not validate these Markdown files.
- `App.tsx` loads Models state before mounting. Initialize the module registries before that load.
- `services/protocols/adapters.ts` currently uses a 15-second timeout and a 10-page cap. `routing.test.ts` already specifies target URLs and authentication.
- `features/models/channels.test.tsx` covers current-input requests, protocol inheritance, saved-editor isolation, stale responses, save scopes, localization, and compact layout.
- `features/models/storage.test.ts` covers native Storage failures and partial saves. Keep it headless.

Before Task 1, run `git status --short`, then `mise run verify`. Record the baseline. If a required check fails, record its exact cause and resolve or agree on the blocker before claiming completion. Do not silently absorb unrelated repairs into this plan.

## File Map

All paths below are relative to the repository root. New APIs are specified in the next section; they do not exist at the baseline.

### Create: contracts and runtime

| Path | Responsibility |
| --- | --- |
| `modules/ai/contracts/channel.ts` | `ProviderTypeId`, shared channel and credential records; no UI. |
| `modules/ai/contracts/model.ts` | Model records, capabilities, limits, raw catalog records, normalized discovery records, and sync result. |
| `modules/ai/contracts/protocol.ts` | `ProtocolId`, connection, operation, target, protocol definition, context, and HTTP boundary types. |
| `modules/ai/contracts/provider.ts` | Provider definition and optional root-path policy. |
| `modules/ai/contracts/errors.ts` | Move `ProviderProtocolError` and its categories without UI dependencies. |
| `modules/ai/runtime/registry.ts` | Registry factory and the unpopulated production runtime registry. |
| `modules/ai/runtime/http.ts` | Shared JSON HTTP implementation and existing network error behavior. |
| `modules/ai/runtime/client.ts` | Client factory, production client, provider-to-protocol composition, and public discovery operations. |
| `modules/ai/runtime/model-metadata.ts` | Existing capability fallback, models.dev enrichment, and manual-model fact lookup. |
| `app/ai-setup.ts` | The sole built-in assembly entry; idempotent initialization. |

### Create: contributions and shared AI UI

| Path | Responsibility |
| --- | --- |
| `modules/ai/protocols/openai-chat/index.ts` | Chat Completions contribution with ID `openai-compatible`. |
| `modules/ai/protocols/openai-responses/index.ts` | Responses contribution with ID `openai-responses`. |
| `modules/ai/protocols/anthropic/index.ts` | Messages target and cursor-based catalog. |
| `modules/ai/protocols/gemini/index.ts` | Gemini target and page-token catalog. |
| `modules/ai/protocols/openai-common.ts` | Shared OpenAI catalog decoding and authentication where identical. |
| `modules/ai/providers/openai/definition.ts` and `modules/ai/providers/openai/presentation.ts` | OpenAI policy and UI contribution. |
| `modules/ai/providers/gemini/definition.ts` and `modules/ai/providers/gemini/presentation.ts` | Gemini policy, Google catalog mapping, and UI contribution. |
| `modules/ai/providers/anthropic/definition.ts` and `modules/ai/providers/anthropic/presentation.ts` | Anthropic policy and UI contribution. |
| `modules/ai/providers/deepseek/definition.ts` and `modules/ai/providers/deepseek/presentation.ts` | Shared catalog selection, Messages root policy, and UI contribution. |
| `modules/ai/providers/custom/definition.ts` and `modules/ai/providers/custom/presentation.ts` | Custom policy with no default root or catalog provider. |
| `modules/ai/ui/contracts.ts` | Controlled settings props and presentation types; NSH UI types stay here. |
| `modules/ai/ui/registry.ts` | Presentation registry factory and production registry. |
| `modules/ai/ui/connection-fields.tsx` | The existing connection fields, without card actions or persistence. |
| `modules/ai/ui/provider-mark.tsx` | Render contributed assets with existing tint and accessibility behavior. |
| `modules/ai/ui/form-field.tsx` | Move the existing field layout shared by provider settings and model dialogs. |
| `features/models/editor/channel-editor.tsx` | Common editor frame, connection actions, model table, and dialogs. |
| `features/models/editor/controller.ts` | Extract the current editor's state and operation ownership. |
| `features/models/editor/provider-settings.tsx` | Select and mount the registered settings component. |

### Modify: existing consumers

- `App.tsx` — initialize built-ins before state loading.
- `features/models/types.ts` — retain feature commands and filters; import shared domain contracts. Temporary type re-exports are removed in Task 8.
- `features/models/store.ts` — keep persistence and write locking; use registry validation and the AI client after resolving credentials and URL consent.
- `features/models/channel-draft.ts` — read provider defaults from the registry; retain in-memory model ownership.
- `features/models/model-collection.ts` — use shared records and registry policy without changing merges.
- `features/models/model-helpers.ts` — use registered protocol label keys and provider allowlists; keep inheritance rules.
- `features/models/page.tsx` — mount `ChannelEditor` with the current channel/draft keys and existing leave guards.
- `features/models/add-channel-dialog.tsx` and `channels-rail.tsx` — read ordered provider definitions and contributed marks.
- `features/models/add-model-dialog.tsx`, `edit-model-dialog.tsx`, and `models-table.tsx` — use shared records and registered choices; retain controlled actions and existing test IDs.
- `components/ui/icon.tsx` — remove provider-brand imports and entries only after all consumers use contributed assets. Keep unrelated icons intact.
- `locales/en.yml` and `locales/zh-CN.yml` — protocol labels and explicit registration/unsupported-configuration errors.
- `docs/ui/DESIGNE.md` — record ownership extraction before UI edits and validation afterward. Do not rewrite unrelated historical notes.

Keep `services/models-dev/catalog.ts`, its tests, the provider SVG locations, `app/shell.tsx`, project command scripts, and dependencies unless a named task below identifies a required change. This plan requires no change to the shell or command scripts.

### Create or update: tests

- Create `modules/ai/runtime/registry.test.ts` — S1, prefix `ai registry:`.
- Create `modules/ai/runtime/client.test.ts` — S2, prefix `ai client:`. Move existing provider-aware routing assertions here in Task 8.
- Create `modules/ai/protocols/protocols.test.ts` — S2 protocol contract cases, prefix `ai protocol:`.
- Create `app/ai-setup.test.ts` — S1 bootstrap behavior, prefix `ai setup:`.
- Create `features/models/editor/provider-settings.test.tsx` — S3, prefix `ai settings:`.
- Create `features/models/editor/__tests__/settings-app.tsx` — a real settings-host fixture with controlled state and an additional registered contribution; not a shipped provider or a production test mode.
- Modify `features/models/channels.test.tsx`, `models.test.tsx`, `logic.test.ts`, `storage.test.ts`, and `__tests__/fixtures.ts` — S4 regressions and domain imports. New App cases use prefix `ai workspace:`.
- Retain `services/models-dev/catalog.test.ts` unchanged unless a direct contract import changes.

Remove after migration: `services/protocols/adapters.ts`, `presets.ts`, `routing.ts`, `types.ts`, and `routing.test.ts`; `features/models/provider-editor.tsx`, `model-facts.ts`, and `form-field.tsx`. Move their behavior and tests before deletion.

## Seams

These four seams are proposed for confirmation with this plan. Do not add tests at another seam during execution without agreement.

### S1: Module registration and bootstrap

Public interfaces: `createAiRegistry`, `createProviderSettingsRegistry`, and `initializeAiModules`.

Observe registered definitions, insertion order, explicit lookup failures, reference validation, and idempotent built-in setup. Use fresh registries for isolated registration cases. Do not inspect Maps or registration call counts.

### S2: AI client and protocol contracts

Public interfaces: `createAiClient` and contributed `ProtocolDefinition.resolveTarget/listModels`.

Observe literal HTTP targets, headers, normalized remote records, errors, and enrichment results. Use real provider and protocol contributions. Inject only HTTP/fetch, catalog, or time boundaries. Do not test private decoder functions or mock an adapter.

### S3: Controlled provider-settings renderer

Public interface: `ProviderSettingsHost` in `features/models/editor/provider-settings.tsx`, driven through `open("./__tests__/settings-app.tsx", ...)` from the adjacent test file.

Observe which contributed controls render and how changes reach the owner. The fixture registers a distinct provider and Settings component using the public registries. It uses existing localized controls and does not mock the editor or Store.

### S4: Complete Models workspace

Public interface: the real App, opened from feature tests with `open("../../App.tsx", ...)`.

Observe current input values, protocol labels, requests through `app.requests()`, saved/reopened behavior, errors, focus, and model rows. Use native Storage replacements only in `storage.test.ts` for persistence faults. Do not use serialized-field assertions as the only evidence for user workflows.

## Public interfaces and fixed decisions

Introduce these contracts in the tasks below. This section is the target, not a request to implement everything in Task 1.

### Registry

`createAiRegistry()` returns:

- `registerProtocol(definition)` and `registerProvider(definition)`.
- `getProtocol(id)` and `getProvider(id)`, which throw on unknown IDs.
- `listProtocols()` and `listProviders()` in registration order.
- `isProtocolAllowed(providerTypeId, protocolId)`, which validates the provider and checks its allowlist.

Export `aiRegistry` as one initially empty production instance. No built-in imports belong in this module. Reject duplicate IDs, empty IDs, unknown protocol references, an empty allowlist, and a default outside the allowlist. A fixed catalog protocol must also be registered. Use the existing error categories, with localized new messages where needed.

`createProviderSettingsRegistry(runtimeRegistry)` returns `register`, `get`, and `list`. Each presentation references an existing provider. Reject duplicate or unknown provider IDs. Export `providerSettingsRegistry` over `aiRegistry`; runtime files never import it.

### Protocol and client

`ProtocolConnection` contains `{ baseUrl: string; credential: string | null }`. `ProtocolContext` contains `{ http, signal?, timeoutMs? }`. `JsonHttpClient.getJson(target, options)` is the external HTTP boundary. `createJsonHttpClient({ fetchImpl? })` uses global `fetch` by default and permits a boundary replacement in isolated tests.

`ProtocolDefinition` contains `{ id, labelKey, resolveTarget, listModels }`. Raw `RemoteModelRecord` capabilities are nullable; `DiscoveredRemoteModel` capabilities remain complete. Move common model types to `contracts/model.ts` rather than creating another copy of capability flags.

`createAiClient({ registry, http, loadCatalog? })` exposes:

- `resolveRequestTarget(input, operation)` — pure target resolution; no I/O.
- `testConnection(input, options?)` — list the configured catalog and return `{ modelCount }`; no models.dev request.
- `discoverModels(input, options?)` — list and enrich models without storing them.
- `resolveModelFacts({ providerTypeId, modelKey })` — best-effort manual-model fact lookup.

`input` contains `{ providerTypeId, protocolId, baseUrl, credential }`. Options contain `signal` and `timeoutMs`. The production client uses `aiRegistry`, the real HTTP implementation, and `loadCatalog` from `services/models-dev/catalog.ts`. Never initiate I/O while constructing a client or importing a module.

The Store maps its existing `presetId` and `adapterId` snapshot fields into that input. It retains `inspectBaseUrl`, HTTP consent, and saved-credential resolution. Protocols only receive `ProtocolConnection`, never the full client input.

Use `catalogProtocolId` only for catalog operations. Apply `resolveBaseUrl` after protocol selection. Reject a provider transformation that changes the origin. Use the base-root and DeepSeek normalization rules in the spec; do not add host inference or new path editors.

### Settings

Use this exact controlled field vocabulary for `ProviderSettingsProps`:

- `provider`, `mode`, `protocolId`, `baseUrl`, `credential`.
- `hasSavedCredential`, `credentialMode` (`keep`, `replace`, or `clear`).
- `urlError`, `isInsecureHttp`, `allowInsecureHttp`, `compact`, `disabled`.
- `onProtocolChange`, `onBaseUrlChange`, `onCredentialChange`, `onCredentialModeChange`, `onInsecureHttpChange`.

The five change callbacks take the corresponding next value; credential-mode changes request `keep` or `clear`, while typing lets the controller derive `replace`. `ProviderSettingsHost` takes `providerTypeId` and the controlled settings props. It selects the presentation from the production presentation registry. The fixture uses these same registries in its own App VM.

Keep provider type immutable within an editor owner. Select that owner's Settings component once, but read changing field props in NSH bindings. Do not destructure reactive props or pass snapshots built once. Do not mount a second root for a contribution.

Protocol label keys: `ai.protocol.openaiChat`, `ai.protocol.openaiResponses`, `ai.protocol.anthropic`, and `ai.protocol.gemini`. New error keys: `ai.error.duplicateModule`, `unknownProvider`, `unknownProtocol`, `invalidProvider`, `unknownPresentation`, `providerOriginChanged`, and `unsupportedConfiguration`. All error names after the first share the `ai.error.` prefix. Keep existing translated provider names and existing field/action copy.

## Tasks

### Task 1: Introduce contracts and validated registration

**Seam:** S1.

**Outcome:** Callers can register definitions with open IDs and receive explicit reference errors.

**Files:** Create the five `modules/ai/contracts/*.ts` files, `modules/ai/runtime/registry.ts`, and `registry.test.ts`. Modify `features/models/types.ts`, `services/protocols/types.ts`, `services/protocols/presets.ts`, and both locale files only as needed to move shared types/errors and keep current consumers working.

**Steps:**

- [ ] Move shared records without changing serialized names or existing runtime behavior. Keep feature-only command inputs in the feature. Replace the old `ProviderPresetId` and `AdapterId` unions with temporary aliases to the new open IDs. Temporary old-path type/error re-exports are allowed only until Task 8.
- [ ] **Red:** Add `ai registry: accepts an external protocol and provider ID`. Register in-test contributions named `example:protocol` and `example:provider`; get them by ID and observe the supplied definition/default. The callable but incomplete registry must reject or fail to return this valid contribution.
- [ ] **Green:** Implement open-ID registration and ordered retrieval.
- [ ] Repeat one case at a time for duplicate protocol/provider IDs, unknown lookups, unknown protocol references, an invalid default, and a fixed catalog protocol that is not registered. Expect `invalid_request` and the relevant localized message, not Custom fallback.
- [ ] Keep registry tests independent of the global production instance and concrete built-ins. Do not turn fixture contributions into application providers.

**Validation:**

- Run (red, then green): `mise run test -- --filter "ai registry: accepts an external protocol and provider ID"`.
- Expected red: a behavioral registration/lookup failure; expected green: one matched test passes.
- Run after the remaining cycles: `mise run test -- --filter "ai registry:"`, then `mise run check`.
- Expected: all registry cases and existing types pass; the current App still uses its existing implementation.

**Commit:** `refactor(ai): add shared contracts and module registration`.

### Task 2: Extract HTTP and the Chat Completions protocol

**Seam:** S2.

**Outcome:** A provider-independent Chat module resolves targets and lists models through shared HTTP; the new client composes it with a registered provider.

**Files:** Create `modules/ai/runtime/http.ts`, `client.ts`, `client.test.ts`, `modules/ai/protocols/openai-common.ts`, `openai-chat/index.ts`, and `protocols.test.ts`. Modify `services/protocols/adapters.ts` to reuse the extracted HTTP implementation, not to select the new protocols yet. Add the four protocol label keys to both locales as each contribution needs them.

**Steps:**

- [ ] **Red:** Add `ai protocol: Chat targets preserve a proxy prefix` through the contribution's public `resolveTarget`. Use `https://proxy.example.com/ai/v1/`, `gpt-4.1`, and a test credential. Expect literal `/models` and `/chat/completions` URLs plus Bearer authentication.
- [ ] **Green:** Move the standard Chat target and common catalog decoder. Input has no provider ID. Return nullable remote capabilities rather than applying the heuristic here.
- [ ] Add and pass `ai protocol: Chat lists unique normalized models`, using the external JSON HTTP boundary with a repeated ID, a blank ID, an optional name, and positive/invalid limits. Do not call the private parser.
- [ ] Extract `fetchJsonPage` into the shared HTTP client without rewriting its cancellation/error policy. Keep the named timeout at 15,000 ms. Keep external abort listeners and timers bounded.
- [ ] Introduce client target resolution and `testConnection`. Use a fresh registered provider in the client test; validate its selected protocol and configured/default root before calling Chat.
- [ ] Add client error cases one at a time: HTTP 401/403, 429, 500, non-JSON body, non-object body, network failure, timeout, and external cancellation. Use `createJsonHttpClient` with an external fetch boundary, or App network controls once integrated. Assert public error kind/status; do not mock the protocol.
- [ ] Keep the old App's catalog results unchanged while it still calls the old adapters. Move code, rather than maintaining two different HTTP implementations.

**Validation:**

- Run (red, then green): `mise run test -- --filter "ai protocol: Chat targets preserve a proxy prefix"`.
- Expected red: incorrect or unavailable target behavior after the signature is callable; expected green: literal target/header assertions pass.
- For each additional protocol cycle, run `mise run test -- --filter "ai protocol:"` red, then green. For each HTTP/client error cycle, use `mise run test -- --filter "ai client:"` red, then green. Expect only the new behavior to fail at red and all earlier cases to remain green.
- Run task regressions: `mise run test -- --filter "ai protocol:"`, `mise run test -- --filter "ai client:"`, and `mise run test -- --filter "provider channels:"`.

**Commit:** `refactor(ai): extract Chat protocol and shared HTTP`.

### Task 3: Add Responses, Messages, and Gemini contributions

**Seam:** S2.

**Outcome:** All four wire APIs resolve targets and list models without provider knowledge.

**Files:** Create `modules/ai/protocols/openai-responses/index.ts`, `anthropic/index.ts`, and `gemini/index.ts`. Modify `openai-common.ts`, `protocols.test.ts`, and both locales. Keep the old provider-aware resolver until its consumers move.

**Steps:**

- [ ] Complete each row below in its own red-green cycle. Use the public protocol object and external HTTP boundary.

| Test name after `ai protocol:` | Literal behavior |
| --- | --- |
| `Responses uses its own model target` | Root `https://gateway.example.com/ai/v1` gives `/ai/v1/responses`; the catalog remains `/ai/v1/models`. |
| `Messages paginates with after_id` | Standard `/v1/models`, `x-api-key`, `anthropic-version: 2023-06-01`, then `after_id` from the previous page. |
| `Gemini paginates with pageToken` | Standard `/v1beta/models`, query API key, then `pageToken`; normalize `models/gemini-2.5-flash`. |
| `Gemini model targets encode the model ID` | Strip one leading `models/`, encode the ID, and append `:generateContent` under the preserved prefix. |
| `catalog pagination stops safely` | Stop on no next cursor, an unchanged cursor, or page 10; deduplicate model IDs. |
| `an empty valid catalog succeeds` | Empty arrays return no models; missing required arrays return `invalid_response`. |

- [ ] **Green:** Move the corresponding standard branches and pagination code. Do not move DeepSeek conditions into Anthropic.
- [ ] Add blank-model-ID rejection and existing `/v1` and `/v1beta` root normalization cases. Use named constants for the page cap and Anthropic API version.
- [ ] Review imports: protocols can use contracts and common helpers, not provider definitions, presentation modules, the registry, or `features/models/`.

**Validation:**

Run the corresponding command red, then green for each row:

```sh
mise run test -- --filter "ai protocol: Responses uses its own model target"
mise run test -- --filter "ai protocol: Messages paginates with after_id"
mise run test -- --filter "ai protocol: Gemini paginates with pageToken"
mise run test -- --filter "ai protocol: Gemini model targets encode the model ID"
mise run test -- --filter "ai protocol: catalog pagination stops safely"
mise run test -- --filter "ai protocol: an empty valid catalog succeeds"
```
- Expected red: that protocol's target, header, or result differs from the literal requirement; expected green: each row passes with at least one matched test.
- Run all protocol cases: `mise run test -- --filter "ai protocol:"`, then `mise run check`.

**Commit:** `refactor(ai): add independent Responses Messages and Gemini protocols`.

### Task 4: Compose built-in provider definitions

**Seams:** S1 and S2, exercised in separate cycles.

**Outcome:** Provider definitions select allowed protocols and path policy; the client handles DeepSeek without a protocol-side provider branch.

**Files:** Create all five `modules/ai/providers/*/definition.ts` files, `app/ai-setup.ts`, and `app/ai-setup.test.ts`. Modify `client.ts`, `client.test.ts`, `App.tsx`, and unit-test initialization where registry-backed helpers first need it. Presentations are added to the same setup entry in Task 6.

**Steps:**

- [ ] **Red:** Add `ai client: DeepSeek catalog stays shared with Messages selected`. Register real built-in protocol/provider definitions in a fresh registry. Expect `GET https://proxy.example.com/deepseek/models` with Bearer authentication, not an Anthropic catalog target.
- [ ] **Green:** Give DeepSeek a fixed Chat catalog protocol. Select catalog and model execution protocols separately.
- [ ] Add and pass `ai client: DeepSeek Messages preserves its proxy origin`. Expect `https://proxy.example.com/deepseek/anthropic/v1/messages` with standard Anthropic headers. Repeat with configured roots ending in `/v1`, `/anthropic`, and `/anthropic/v1` to preserve current normalization.
- [ ] Move that root adjustment into DeepSeek's `resolveBaseUrl`. The standard Anthropic contribution must not know the provider ID.
- [ ] Add and pass provider-policy cases: OpenAI defaults to Responses; fixed Gemini/Anthropic choices; Custom has no default root; disallowed protocols reject even for fixed-catalog discovery; provider root policy cannot switch the configured origin.
- [ ] Add and pass `ai setup: initializing twice keeps one ordered built-in set`. Register protocols first and providers second. Preserve picker order OpenAI, Gemini, Anthropic, DeepSeek, Custom. Use an explicit initializer guard, not swallowed duplicate errors.
- [ ] Call the initializer before `loadModelsState` in `App.tsx`. The old Store remains usable until Task 5. Keep imports side-effect-free and do not register built-ins from runtime modules.

**Validation:**

- Run (red, then green): `mise run test -- --filter "ai client: DeepSeek catalog stays shared with Messages selected"`.
- Expected red: the selected Messages protocol produces the wrong catalog path or headers; expected green: the shared catalog target passes.
- Run the other named cases one by one, then `mise run test -- --filter "ai client:"` and `mise run test -- --filter "ai setup:"`.
- Run `mise run test -- --filter "provider routing:"` to retain the old resolver as an independent reference until Task 8.

**Commit:** `refactor(ai): compose built-in provider policies`.

### Task 5: Route Models operations and metadata through the client

**Seams:** S2, then S4 regression/extraction.

**Outcome:** Real Test and Fetch actions use the new modules. Models metadata and domain rules no longer depend on centralized preset tables or adapter labels.

**Files:** Create `modules/ai/runtime/model-metadata.ts`. Modify `client.ts`, `client.test.ts`, `features/models/store.ts`, `channel-draft.ts`, `model-collection.ts`, `model-helpers.ts`, `types.ts`, model dialogs/table, feature tests, and fixtures. Remove `features/models/model-facts.ts` after its consumers move. Temporarily adapt the old editor's provider access to registered definitions; presentation extraction follows in Task 6.

**Steps:**

- [ ] **Red:** Add `ai client: discovery uses the provider catalog mapping`. Build the index with the real `createCatalog` from `services/models-dev/catalog.ts`, controlling its external fetch/cache/time dependencies. Use conflicting bare-ID and provider-specific catalog facts; Gemini must select `google`. Expect catalog capabilities, provider-reported context limits, and catalog-only missing output limits. Do not mock `CatalogIndex.lookup`.
- [ ] **Green:** Move the existing capability heuristic and catalog merge into `model-metadata.ts`. Read `catalogProviderId` from the provider definition. Add `discoverModels` and `resolveModelFacts` to the client with the signatures above.
- [ ] Add cases one at a time for unavailable/stale catalog data, a manually added known model, and unknown-model heuristic fallback. Preserve existing cache logic in `services/models-dev/catalog.ts`.
- [ ] Start listing and catalog loading in parallel. Add and pass `ai client: cancellation after metadata prevents a result`, aborting while an injected catalog boundary is pending. Check cancellation again after awaiting it. Keep Test independent of models.dev.
- [ ] **Regression:** Run the current-input, credential keep/replace/clear, metadata, inheritance, merge, and failed-fetch App cases before changing their callers. They should already pass; record that baseline.
- [ ] **Extraction:** Keep `resolveConnectionRequestParams` or a narrowly renamed host helper for URL consent and secret resolution. Pass only its resolved connection to the new client. Keep Store writes, locks, merge rules, partial errors, and model enable state unchanged.
- [ ] Move model-fact lookup from `ProviderEditor` to `aiClient.resolveModelFacts`. Move existing `logic.test.ts` catalog-enrichment assertions to S2 client cases before deleting their old import; do not add a private metadata test seam. Move shared type imports in feature files without changing serialized fields.
- [ ] Use registry allowlists and `t(registry.getProtocol(id).labelKey)` in model choices/labels. The old editor may use the same definitions temporarily, but must not retain its own provider table.
- [ ] Unit tests that call registry-backed draft/helpers directly call the real idempotent initializer. Registry/client factory tests keep fresh instances.

**Validation:**

- Run (red, then green): `mise run test -- --filter "ai client: discovery uses the provider catalog mapping"`.
- Expected red: provider mapping or fact precedence is absent/wrong; expected green: the literal facts pass.
- Run (red, then green): `mise run test -- --filter "ai client: cancellation after metadata prevents a result"`, then run `mise run test -- --filter "ai client:"`.
- Run regression commands: `mise exec -- nsh test features/models`, `mise exec -- nsh test services/models-dev`, and `mise run check`.
- Expected: current-input requests, no-network local saves, model identity, metadata precedence, and partial-save cases all pass through the real App.

**Commit:** `refactor(models): use registered AI modules and metadata`.

### Task 6: Render registered controlled provider settings

**Seams:** S1 for presentation registration, then S3 for rendering; S4 regressions.

**Outcome:** A provider can contribute a distinct Settings component and brand asset without an editor branch or a global brand-icon entry.

**Files:** Create all five `modules/ai/providers/*/presentation.ts` files; `modules/ai/ui/contracts.ts`, `registry.ts`, `connection-fields.tsx`, `provider-mark.tsx`, and `form-field.tsx`; `features/models/editor/provider-settings.tsx`, `provider-settings.test.tsx`, and `__tests__/settings-app.tsx`. Modify the old editor, picker, rail, model dialog field imports, `app/ai-setup.ts`, `app/ai-setup.test.ts`, registry tests where appropriate, and `docs/ui/DESIGNE.md`.

**Steps:**

- [ ] Before UI edits, record the controlled-settings extraction and unchanged interaction/motion inventory in the design document. Preserve the host's scroll owner and connection card actions.
- [ ] At S1, add presentation registration cycles for an existing provider, duplicate registration, and a missing runtime provider. Register presentations after definitions. All five built-ins reference `ConnectionFields` directly.
- [ ] **Red:** At S3, add `ai settings: renders a distinct registered provider component`. The fixture initializes real built-ins, registers `example:provider` and a distinct Settings contribution, and mounts the real `ProviderSettingsHost` under one root. Observe its contributed URL control/content, not only a host-generated test ID.
- [ ] **Green:** Resolve the registered presentation and mount its Settings. Do not add a switch on provider ID or mock a presentation lookup.
- [ ] Add and pass `ai settings: edits remain owned by the host`. Change a field through the fixture's actual Input and observe the owner's updated value reflected in the rendered view. No storage or network action occurs.
- [ ] Move only the protocol selector/fixed value, URL, HTTP consent, and credential fields from the old editor into `ConnectionFields`. Keep Test, connection Save/Cancel, loading/errors, and Models actions in the common host.
- [ ] Move `FormField` to shared AI UI so provider settings never import a feature-private file. Update model-dialog imports.
- [ ] Contribute the existing SVGs from presentation files. Use `ProviderMark` and Avatar's existing fallback slot in the picker, rail, editor header, and draft identity card. Keep semantic tint and accessible names.
- [ ] Update the picker to use registration order. Extend setup's single initialization path to register all five presentations. Update the setup test to observe them after two initializer calls.
- [ ] Keep field test IDs and labels unchanged. Read props in reactive bindings and preserve fixed versus selectable API behavior.

**Validation:**

- Run (red, then green): `mise run test -- --filter "ai settings: renders a distinct registered provider component"`.
- Expected red: the new contribution does not render or the default view renders instead; expected green: the distinct component appears through registry selection.
- Run (red, then green): `mise run test -- --filter "ai settings: edits remain owned by the host"`, then run `mise run test -- --filter "ai settings:"`.
- Run `mise run test -- --filter "provider channels:"`, `mise run check`, and `mise run build`.
- Expected: standard App fields, provider marks, keyboard names, fixed APIs, and API allowlists are unchanged. Build emits no new unknown-class or missing-export warning.

**Commit:** `refactor(models): render registered provider settings`.

### Task 7: Extract the editor controller and handle unsupported records

**Seam:** S4.

**Outcome:** Common editor composition is separate from state/operations, unknown stored module references do not crash or trigger requests, and existing owner lifetimes remain intact.

**Files:** Create `features/models/editor/controller.ts` and `features/models/editor/channel-editor.tsx`. Modify `features/models/page.tsx`, `channels-rail.tsx`, `models-table.tsx`, `model-helpers.ts`, `channels.test.tsx`, `models.test.tsx`, `storage.test.ts`, both locales if recovery copy needs completion, and `docs/ui/DESIGNE.md`. Remove `provider-editor.tsx` only after its working code has moved.

**Steps:**

- [ ] **Red:** Add `ai workspace: unknown provider remains visible without requests`. Seed a channel with an unregistered `presetId`. Open the real App. Expect its saved display name, a localized unsupported-configuration alert, and a working Delete action; no network request or automatic storage conversion is allowed.
- [ ] **Green:** Add a supported/unsupported configuration state at the common host boundary. Do not attempt to mount missing Settings. Render a neutral provider mark and the common shell; keep deletion available.
- [ ] Add and pass unknown default/override protocol cases. Known providers expose valid choices to correct the configuration. Show an API selector for an unsupported current default even for a normally fixed-protocol provider, then restore its fixed display after correction. A missing channel-default protocol blocks Test/Fetch until corrected; a missing model override blocks saving that unchanged model value, but not an otherwise valid channel catalog action. Unknown `sourceAdapterId` metadata never blocks operations. Make rail labels and model API formatting tolerate unsupported references without a Custom fallback. Reopening must not have silently discarded the model or changed its API.
- [ ] **Regression:** Run `provider channels: repeated saved channel switches isolate connection fields and models`, `provider channels: same-channel updates retain pending connection edits`, and both existing stale-response cases before extraction. They are expected to pass already.
- [ ] **Extraction/review:** Move current signals, effects, request fingerprints, abort ownership, snapshot construction, saves, and model handlers into `createChannelEditorController(props)`. Call it once inside `ChannelEditor` so NSH cleanup belongs to that editor owner. No module-global editor signals.
- [ ] Return named accessors and actions used by the view, not mutable signals. Preserve the old editor's external props, including draft abort/focus registration, and move its JSX into `channel-editor.tsx`. Add no second request/state controller inside Settings.
- [ ] Keep the saved-channel `Each` key in `page.tsx`. Keep draft creation, discard confirmation, focus restoration, and leave guards in the page. Same-channel revisions do not remount the editor.
- [ ] Keep first-save versus saved-connection/model write scopes, revision conflicts, and `PartialDraftSaveError` handling unchanged. Do not rewrite persistence as part of extraction.

**Validation:**

- Run (red, then green): `mise run test -- --filter "ai workspace: unknown provider remains visible without requests"`.
- Expected red: an unknown lookup crashes the view, falls back, or permits the wrong action; expected green: retained, explicit unsupported state with deletion and zero requests.
Run these existing cases before and after extraction:

```sh
mise run test -- --filter "provider channels: repeated saved channel switches isolate connection fields and models"
mise run test -- --filter "provider channels: same-channel updates retain pending connection edits"
mise run test -- --filter "provider channels: stale catalog cannot populate a replacement draft"
mise run test -- --filter "provider channels: switching saved channels and editing connection mid-request drop stale responses"
```
- Run `mise exec -- nsh test features/models`, `mise run check`, and `mise run build`.
- Expected: all feature tests pass, including headless Storage failure tests. Do not move those fault tests to desktop runs.

**Commit:** `refactor(models): isolate editor state and unsupported configurations`.

### Task 8: Remove old paths and verify the completed boundaries

**Seams:** S1-S4, preservation/review stage.

**Outcome:** The new implementation is the only implementation; its extension, request, UI, and persistence contracts pass together.

**Files:** Modify remaining imports, domain fixtures/tests, `client.test.ts`, `components/ui/icon.tsx`, and `docs/ui/DESIGNE.md`. Remove remaining `services/protocols/` files and any obsolete feature type re-exports. Do not remove `features/models/types.ts`, which still owns feature-only command types.

**Steps:**

- [ ] Move all literal provider-aware routing assertions from `services/protocols/routing.test.ts` into `client.test.ts`, using real registered built-ins. Keep the old test names prefixed `provider routing:` so the regression filter still works. Execute them before deleting the old suite.
- [ ] Remove old centralized adapters, routing, presets, and type entries after no production consumer needs them. Remove the old feature fact/field/editor files if not already removed. Do not retain permanent forwarding modules.
- [ ] Remove unused OpenAI/Gemini/Anthropic/DeepSeek imports and entries from `components/ui/icon.tsx`. Keep `cube-outline` and other generic icons used elsewhere. Do not delete provider asset files.
- [ ] Review dependency direction: no contracts import implementations; no runtime/protocol file imports AI UI, provider presentation, the editor, or feature state. Bootstrap is the only built-in assembly entry. No source-based effective-protocol fallback remains.
- [ ] Review adding a contributor: a module directory, required locale entries, and explicit setup registration are sufficient; no union, existing protocol implementation, page branch, catalog-provider map, or global brand enum must change. Use the existing S1/S3 extension tests, not another shipped provider.
- [ ] Run the final validation below. Report actual results and unavailable checks; do not copy historical validation claims into the new design entry.

**Validation:**

This stage preserves proven behavior; it has no manufactured red step. Before removal, run `mise run test -- --filter "provider routing:"`. After moving the assertions, run the same command and require the same scenarios to pass through the new client.

Run these structural checks after migration:

```sh
git grep -n 'services/protocols' -- App.tsx app features components modules
git grep -n -E 'features/models|providers/.*/presentation|modules/ai/ui' -- modules/ai/runtime modules/ai/protocols
git grep -n -E 'from .*nsh|features/|runtime/|providers/|protocols/' -- modules/ai/contracts
```

Expected: no matches. `git grep` exits 1 for no matches; that is the expected result, not a failed test. Also review relative imports: these searches alone do not prove an acyclic graph. Use `git status --short` to confirm that the final source paths match the File Map.

**Commit:** `refactor(ai): remove centralized provider protocol implementation`.

## Final Validation

Run in this order:

1. `mise run verify` — formatting, lint, types, all Rust/headless tests, and release bundle pass. Do not change dependencies or unrelated source to bypass a failure.
2. `mise exec -- nsh test features/models/channels.test.tsx --target windows` — current desktop provider, draft, inheritance, request, save, and recovery flows pass.
3. `mise exec -- nsh test features/models/editor/provider-settings.test.tsx --target windows` — the real contributed-settings fixture and controlled edits pass on the desktop host.
4. `mise exec -- nsh test features/models/models.test.tsx --target windows` — existing model-management behavior passes.
5. Review light and dark screenshots at 1040 x 720 and 720 x 520. Cover provider selection, one fixed-API provider, one selectable-API provider, dirty connection edits, errors, model overrides, and unsupported configuration.
6. Complete the main flow by keyboard in English and Chinese. Verify focus transfer/return, visible focus, masked credentials, reduced motion, shared scroll ownership, and unchanged connection/model save scopes. Do not capture real credentials.

On another desktop OS, replace `--target windows` with the installed native target. Do not run `storage.test.ts` with `--target`: its native-module replacements are headless-only. If no interactive desktop or screen reader is available, report that limit and keep the affected visual/accessibility verification outstanding; a headless pass does not prove appearance.

Record validation by the design checklist groups: radius, typography, spacing, alignment, color, hover, pressed, other states, motion, and accessibility. Because this is an extraction, expected geometry and existing motion are unchanged. Add no new transition merely to decorate provider switching.

## Coverage Map

| Requirement | Tasks and evidence |
| --- | --- |
| AM-01, AM-02 | Tasks 1, 4, 6; open-ID registration, invalid/unknown references, strict lookup. |
| AM-03, AM-04 | Tasks 2, 3, 8; standalone protocol contracts, literal target regressions, dependency review. |
| AM-05 | Task 4; fixed DeepSeek discovery and composed Messages target. |
| AM-06 | Tasks 2, 3, 5, 7; HTTP, pagination, metadata cancellation, and stale-owner regressions. |
| AM-07 | Task 5; provider catalog mapping, precedence, fallback, and existing catalog suite. |
| AM-08 | Task 6; distinct registered Settings and controlled edits. |
| AM-09 | Tasks 6, 7; owner isolation and same-channel retention. |
| AM-10, AM-11 | Tasks 5, 7; existing App, logic, merge, and Storage fault suites. |
| AM-12 | Tasks 4, 5; origin rejection and retained insecure-HTTP App cases. |
| AM-13 | Tasks 6, 7 and Final Validation; localization, focus, screenshots, desktop, and reduced motion. |
| AM-14 | Tasks 4, 6; one idempotent assembly path and unchanged toolchain. |
| AM-15 | Task 8; old-path deletion, contribution review, and structural checks. |
| AM-16 | Task 7; retained unsupported records, no requests through missing modules, no conversion, correction, and deletion. |

## Failure Behavior

- Duplicate/invalid module registration fails explicitly. Do not catch it as successful idempotent setup.
- Unknown configuration remains in local state and is reported by the common editor. It cannot silently use Custom or another protocol.
- Unsupported selected protocols and missing Custom roots reject before HTTP. Empty Custom roots can still be saved as valid local configuration.
- Provider path policy cannot switch origins. A failed proxy request never retries against an official host.
- HTTP/auth/catalog failures preserve local models and do not block structurally valid local saving.
- External cancellation and obsolete owner/input fingerprints prevent results from updating another editor or being merged after cancellation.
- models.dev failures remain best effort; use stale facts or the existing heuristic. Do not turn catalog metadata failure into provider-list failure.
- Partial Storage writes keep the current recovery behavior and accurate saved scopes. Do not claim an atomic transaction.

## Privacy and Security

The host reads credentials only for the current request. Provider definitions and presentations receive no saved secret, Storage handle, or unrestricted feature Store. Form props contain only the current draft/replacement input and saved-secret presence. Protocols receive a transient credential because they construct authentication.

Keep raw credentials out of logs, errors, registry descriptors, normal channel/model records, and screenshots. Retain the existing credential Storage implementation; this plan does not claim encrypted storage or a new vault. Static contributions share the App's authority. Registry boundaries and same-origin path policy are not a plugin sandbox.

## Rollout Notes

There is no deployment, migration, dependency installation, or release step. Keep commits local. The App continues to ship the same five provider types and four protocols. Keep current storage keys, cache format, model defaults, and user overrides; no legacy compatibility layer is required.

Temporary old-path wrappers may exist only between tasks. Remove them in Task 8. New modules must not begin work during import or create a second source of domain state. Loaders, external package manifests, permissions, and runtime API versioning require a separate future specification.

## Risks and Mitigations

- **Moving branches without removing coupling:** prohibit provider identity in protocol inputs and verify the import direction.
- **Settings state snapshots in NSH:** preserve one owner per channel and use prop bindings; test edits after construction and same-channel updates.
- **DeepSeek catalog regression:** test catalog selection independently from model targets and retain literal proxy-prefix examples.
- **Late metadata results:** check cancellation after catalog awaits as well as before Store commits.
- **Overbuilt plugin abstractions:** implement only named contracts and registrations used by this plan; add no lifecycle/permission/config-schema engine.
- **Large refactor conflicts:** follow the task order and preserve green regressions between narrow extractions.
- **Old design notes conflict with current code:** update the affected Models ownership/validation section only; use the current Provider Channels spec for behavior.

## Open Questions

No product decision blocks this document. Before execution, confirm seams S1-S4 and the static-only, behavior-preserving scope. If execution needs a different public boundary or a new product capability, stop that change and request approval instead of expanding this plan.
