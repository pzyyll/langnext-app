# Implementation Plan

**Goal:** Make the five extension axes (LLM protocol, LLM channel, preset engine, capability channel for TTS/OCR/language detection, wordbook) compile-time contributions behind shared contracts, so a later runtime plugin loader can register them without touching feature code.

**Inputs:** The 2026-11-26 research document [功能插件化与模块化架构调研](../analysis/2026-11-26-feature-plugin-architecture.md) and the user's decision: compile-time built-ins first, feature modularization now, runtime plugins later.

**Assumptions:**

- Runtime plugin loading is out of scope. Contributions are compiled in and registered by `src/app/contributions-setup.ts`. The contracts must stay free of host imports so a loader can be added later.
- The app is in the Demo stage: breaking storage changes are allowed. Each migrated domain still keeps a one-time reader for its old key and does not delete the old data, so a misread is recoverable during the same release.
- `src/framework/` is a new top-level folder for contract-only code; `src/contributions/` holds implementations. `src/components/ui` stays the design system.
- No UI redesign. Every milestone preserves the current interaction model (drag and keyboard reorder, breadcrumbs, focus restore, dirty guard, priority badges).

**Architecture:** Four facilities (`contribution registry`, `credential vault`, `channel collection store`, `chain runner`) plus one host component (`CapabilitySection`) replace the three hand-written stores and three hand-written settings sections. A contribution is a plain object: metadata, a config schema with `parse`, optional credential fields, runtime hooks, and an optional controlled `Settings` component.

Layering rules enforced by review (not lint, to keep the change reviewable):

1. A contribution never imports `src/features`; it may import `src/framework`, `src/components/ui`, and vendor clients under `src/modules`.
2. `src/framework` imports no feature, contribution, or app module.
3. `src/app/contributions-setup.ts` is the only place that builds the production registry and collection stores; a feature receives its store from its own `store.ts`, which imports the contribution array and the registry accessor.
4. Features never import a contribution's vendor client or `Settings`; they render it only through `CapabilitySection`. These rules are what make a later runtime loader possible without rewriting contributions.

**Tech Stack:** TypeScript/TSX, NSH 0.6 `signal`/`Storage`/`JSX`, `nsh/test` headless runs, `nsh/i18n` (`t`, static YAML keys), mise tasks. No new runtime dependencies.

---

## File Map

**Framework (new)**

- Create: `src/framework/contributions/contracts.ts` — `ContributionMeta`, `ConfigSchema`, `CredentialField`, `ChannelBinding`, `CapabilityId`, `CapabilityChannelContribution`, `ChannelSettingsProps`, `HostServices`, `ValidationResult`, `Readiness`.
- Create: `src/framework/contributions/registry.ts` — `createContributionRegistry`, `ContributionRegistry`, `Diagnostic`.
- Create: `src/framework/contributions/credential-vault.ts` — `createCredentialVault`, `CredentialVault`.
- Create: `src/framework/contributions/channel-collection.ts` — `createChannelCollection`, `ChannelCollection`, `StoredCollection`, `CredentialInput`, `Result`.
- Create: `src/framework/contributions/chain.ts` — `runChain`, `ChainOutcome`.
- Create: `src/framework/contributions/index.ts` — public re-exports.
- Create: `src/framework/languages.ts` — moved from `src/features/presets/languages.ts` (same exports) so `src/modules/*` stops importing a feature.

- Create: `src/app/contributions-setup.ts` — the single assembly entry: builds the registry and registers every built-in contribution. `App.tsx` calls it instead of `initializeAiModules`.

**Capability section host (new)**

- Create: `src/features/settings/capability-section.tsx` — list, add dialog, detail shell, reorder, delete, dirty tracking, contribution `Settings` mount.
- Create: `src/features/settings/capability-section-add-dialog.tsx` — available-channel picker shared by all capabilities.

**TTS**

- Create: `src/contributions/tts/channels/google-cloud.tsx` — config schema, credential field, `describe`, `readiness`, `execute`, `failureKey`, `Settings`.
- Create: `src/contributions/tts/channels/azure.tsx` — the same surface for Azure.
- Create: `src/contributions/tts/index.ts` — `ttsChannelContributions`.
- Create: `src/contributions/tts/vendor/google-cloud.ts`, `google-voices.ts`, `google-preferences.ts`, `google-samples.ts`, `azure-speech.ts`, `azure-voices.ts`, `azure-regions.ts` — moved from `src/features/tts/*`.
- Create: `src/features/tts/store.ts` — `ttsChannels` collection instance, `settings.tts.v3` migration.
- Modify: `src/features/tts/channels.ts` — dispatch through the collection instead of `if (azure)`.
- Modify: `src/features/tts/settings.ts` — deleted after migration; its type exports move to `synthesis.ts` and the store.
- Modify: `src/features/settings/tts-section.tsx` — replaced by `CapabilitySection`; file deleted.
- Modify: `src/features/settings/google-tts-fields.tsx` — moved into the Google contribution `Settings`, kept controlled.

**OCR and language detection**

- Create: `src/contributions/ocr/channels/{ai,baidu,google-cloud}.ts` and `index.ts`.
- Create: `src/contributions/ocr/vendor/{baidu,google-cloud}.ts` — moved from `src/features/ocr/*`.
- Create: `src/contributions/detect/channels/{ai,google,google-cloud}.ts` and `index.ts`.
- Create: `src/contributions/detect/vendor/google-free.ts` — the free `translate_a/t` call extracted from `detect.ts`.
- Create: `src/features/ocr/store.ts`, `src/features/language-detection/store.ts` — collection instances and migrations.
- Modify: `src/features/ocr/recognize.ts`, `src/features/language-detection/detect.ts` — run the chain over contribution `readiness`/`execute`.
- Modify: `src/features/settings/ocr-section.tsx`, `src/features/settings/language-detection-section.tsx` — replaced by `CapabilitySection`; files deleted.

**Preset engines**

- Create: `src/framework/contributions/preset-engine.ts` — `PresetEngineContribution`, `EngineSettingsProps`.
- Create: `src/contributions/presets/{ai,deepl,google-cloud}.tsx` and `index.ts`.
- Create: `src/components/preset/models-section.tsx`, `src/components/preset/prompt-templates.tsx` — moved from `src/features/presets/` unchanged (props-only, no store access) so the AI engine's `Settings` can compose them.
- Modify: `src/features/presets/types.ts` — engine union becomes `PresetEngineRecord` with `kind: string` plus contribution-parsed config; error keys lose engine-specific members.
- Modify: `src/features/presets/store.ts`, `validation.ts`, `draft.ts`, `editor.tsx`, `page.tsx`, `add-preset-dialog.tsx`, `model-choices.ts`, `preset-mark.tsx` — read contribution metadata instead of switching on `kind`.
- Modify: `src/features/quick-translate/translate.ts` — one `contribution.execute` call replaces the DeepL/Google branches.

**AI request parameters**

- Create: `src/modules/ai/contracts/request-params.ts` — `RequestParamSpec`, merge helpers.
- Modify: `src/modules/ai/contracts/protocol.ts`, `src/modules/ai/contracts/channel.ts`, `src/modules/ai/runtime/client.ts`, `src/modules/ai/runtime/registry.ts`, `src/modules/ai/protocols/*/index.ts`, `src/features/models/store.ts`, `src/features/models/editor/channel-editor.tsx`, `src/modules/ai/ui/contracts.ts`, `src/modules/ai/ui/connection-fields.tsx`.

**Wordbook**

- Create: `src/framework/contributions/wordbook.ts` — `WordEntry`, `WordbookContribution`.
- Create: `src/contributions/wordbook/anki.ts` — contribution wrapping the existing Anki client.
- Create: `src/features/wordbook/store.ts` — collection instance, `settings.wordbook.anki.v1` migration.
- Modify: `src/features/quick-translate/session.ts`, `popup.tsx`, `src/app/quick-translate.tsx` — generic add action and neutral vocabulary.
- Modify: `src/features/settings/wordbook-section.tsx` — replaced by `CapabilitySection`; file deleted.

**Tests (new)**

- Create: `src/framework/contributions/registry.test.ts`, `credential-vault.test.ts`, `channel-collection.test.ts`, `chain.test.ts`.
- Create: `src/features/settings/__tests__/capability-section-app.tsx` and `src/features/settings/capability-section.test.tsx`.
- Create: `src/contributions/tts/channels/channels.test.ts`, `src/contributions/ocr/channels/channels.test.ts`, `src/contributions/detect/channels/channels.test.ts`, `src/contributions/presets/engines.test.ts`, `src/contributions/wordbook/anki.test.ts`.

**Tests (modify)**

- `src/app/ai-setup.test.ts`, `src/features/settings/settings.test.tsx`, `src/features/tts/settings.test.ts`, `src/features/ocr/settings.test.ts`, `src/features/language-detection/settings.test.ts`, `src/features/presets/store.test.ts`, `src/features/presets/presets.test.tsx`, `src/features/quick-translate/translate.test.ts`, `src/features/quick-translate/popup.test.tsx`, `src/features/wordbook/settings.test.tsx`, `src/app/quick-translate.test.tsx`, `src/app/__tests__/quick-translate-harness.tsx`, `App.test.tsx`.

## Seams

- **Seam:** `createContributionRegistry()` — registration, lookup, axis filtering, and diagnostics.
- **Seam:** `createCredentialVault({ storage, namespace })` — `put`/`read`/`remove` over one namespace.
- **Seam:** `createChannelCollection(options)` — load, migrate, add, save, enable, reorder, remove, skipped counting.
- **Seam:** `runChain(entries, run, policy)` — ordered fallback, cancellation, terminal outcomes.
- **Seam:** `CapabilitySection` — the settings host: empty state, add dialog, reorder, detail shell, save, delete, dirty guard.
- **Seam:** `ttsChannelContributions` / `ocrChannelContributions` / `detectChannelContributions` — each channel's `parse`, `validate`, `describe`, `readiness`, `execute`.
- **Seam:** `presetEngineContributions` — `validate` and `execute` replace the `kind` branches.
- **Seam:** `ProtocolDefinition.requestParams` + `AiClientInput.params` — a declared parameter reaches the request body/header/query.
- **Seam:** `WordbookContribution.add(entry)` — one saved word reaches a destination through the contribution.

## Contract Shape

The framework exposes these names; tasks only refine details.

```ts
interface ContributionMeta { id: string; labelKey: string; icon: ImageAsset }
interface ConfigSchema<C> { parse(raw: unknown): C | null; defaults(): C }
interface CredentialField { key: string; labelKey: string; masked: boolean }

interface ChannelBinding<C> {
  enabled: boolean;
  config: C;
  credentialRef: string | null;
}

type CapabilityId = "tts" | "ocr" | "detect";

interface ChannelSettingsProps<C> {
  binding: ChannelBinding<C>;
  compact: boolean;
  disabled: boolean;
  savedCredential: boolean;
  credentialDraft: Readonly<Record<string, string>>;
  onChange(patch: Partial<C>): void;
  onCredentialChange(field: string, value: string): void;
  onClearCredential(): void;
}

interface CapabilityChannelContribution<C, In, Out> extends ContributionMeta {
  capability: CapabilityId;
  configurable: boolean;                       // false: no settings page, e.g. free Google detection
  config: ConfigSchema<C>;
  credential: readonly CredentialField[] | null;
  describe(binding: ChannelBinding<C>): string;
  validate?(draft: { config: C; credentialDraft: Record<string, string>; savedCredential: boolean }): ValidationResult;
  readiness(binding: ChannelBinding<C>, host: HostServices): Promise<Readiness>;
  execute(binding: ChannelBinding<C>, input: In, host: HostServices): Promise<Out>;
  failureKey(failure: string): string | null;
  Settings: (props: ChannelSettingsProps<C>) => JSX.Element;
}

interface HostServices {
  models: { resolveSaved(modelId: string, purpose: "text" | "image"): Promise<SavedModelRequest> };
  fetchImpl?: FetchLike;
  log: Logger;
}

type Readiness = { ready: true } | { ready: false; reasonKey: string };
type ValidationResult = { ok: true } | { ok: false; key: string; field?: string };
type Result = { ok: true } | { ok: false; key: string; message: string };
type CredentialInput =
  | { mode: "keep" }
  | { mode: "replace"; value: Record<string, string> }
  | { mode: "clear" };
```

## Out of Scope

- Moving `src/modules/ai` into `src/contributions/ai`. It is already contribution-shaped; Task 5 proves the framework hosts it through an adapter, and a loader can keep the folder as-is.
- Runtime plugin loading, a sandbox, and an origin allowlist for protocols. The contracts stay host-free so this is possible later.
- Encrypted credential storage or a system keychain.
- New providers, protocols, voices, or OCR engines. This plan only modularizes what exists.
- UI redesign. Section order, copy, and interaction stay as they are.

## Tasks

### Task 1: Register contributions by axis

**Seam:** `createContributionRegistry()`.

**Outcome:** A registry accepts contributions for five axes, validates ids, filters capability channels, and reports cross-axis diagnostics.

**Files:** Create `src/framework/contributions/registry.ts`, `contracts.ts`, `index.ts`; Test `src/framework/contributions/registry.test.ts`.

**Steps:**

- [ ] **Red:** In `registry.test.ts` (each case titled `contributions registry: ...`), register a protocol object and a capability channel object. Expect `get("protocol", id)` to return the same object, `capabilities("tts")` to return only TTS channels, a duplicate id to throw, a blank id to throw, and an unknown id to throw an error whose message names the axis and id.
- [ ] **Red:** Expect `diagnostics()` to report a provider whose `allowedProtocolIds` names an unregistered protocol, and a capability channel whose `capability` is not `tts | ocr | detect`.
- [ ] **Green:** Define `ContributionsByAxis` in `contracts.ts` (protocol/provider use the existing types from `src/modules/ai/contracts`; capability, preset engine, wordbook use the new contracts). Implement `createContributionRegistry` with one `Map` per axis, a shared `assertId`, and `diagnostics()` returning `{ axis, id, problem }[]`.

**Validation:**

- Run (red): `mise exec -- nsh test framework/contributions/registry.test.ts --filter "contributions registry:"` — fails on a missing module.
- Run (green): the same command — all registry cases pass.

### Task 2: Store and read credentials by reference

**Seam:** `createCredentialVault({ storage, namespace })`.

**Outcome:** A secret is written under `${namespace}.${ref}`, read back by reference, removed, and never returned for a missing entry.

**Files:** Create `src/framework/contributions/credential-vault.ts`; Test `credential-vault.test.ts`.

**Steps:**

- [ ] **Red:** In `credential-vault.test.ts` (each case titled `credential vault: ...`), with an in-memory storage double, expect `put("sk-1")` to resolve to a UUID ref, the key to exist under the namespace, `read(ref)` to return `sk-1`, `read(other)` to return `null`, and `remove(ref)` to delete only that key.
- [ ] **Red:** Expect a storage read rejection to reject `read` instead of returning `null`, so callers can report `storage_read_failed`.
- [ ] **Green:** Implement `createCredentialVault` with `crypto.randomUUID()`, `storage.getItem/setItem/removeItem`, and no logging of values.

**Validation:**

- Run (red): `mise exec -- nsh test framework/contributions/credential-vault.test.ts --filter "credential vault:"` — fails on a missing module.
- Run (green): the same command — all vault cases pass.

### Task 3: Persist a channel collection

**Seam:** `createChannelCollection(options)`.

**Outcome:** One versioned record holds order, enabled flags, per-channel config, and credential refs; a new channel needs no schema change.

**Files:** Create `src/framework/contributions/channel-collection.ts`; Test `channel-collection.test.ts`.

**Steps:**

- [ ] **Red:** In `channel-collection.test.ts` (each case titled `channel collection: ...`), with two fake channels (`alpha`, `beta`) and an in-memory storage, expect `load()` on an empty storage to leave `order()` empty and `available()` equal to both ids; `add("alpha")` to append and leave it disabled with `config.defaults()`; `save("alpha", config, { mode: "replace", value: "k" })` to persist `{ version: 1, order: ["alpha"], channels: { alpha: { enabled: false, config, credentialRef } } }` under the given key.
- [ ] **Red:** Expect `moveTo` to clamp, `remove` to delete the credential through the vault, a stored id with no registered contribution to be skipped and counted by `skippedCount()`, and `migrate` to run once when the key is absent.
- [ ] **Green:** Implement the record parse/serialize, per-channel `config.parse` validation on load, a write queue, and a `Result` type shared with the host.

**Validation:**

- Run (red): `mise exec -- nsh test framework/contributions/channel-collection.test.ts --filter "channel collection:"` — fails on a missing module.
- Run (green): the same command — all collection cases pass.

### Task 4: Run an ordered fallback chain

**Seam:** `runChain(entries, run, policy)`.

**Outcome:** OCR, detection, and the preset model chain share one loop: stop on success or cancellation, continue on a retryable failure, remember the first unavailable reason.

**Files:** Create `src/framework/contributions/chain.ts`; Test `chain.test.ts`.

**Steps:**

- [ ] **Red:** In `chain.test.ts` (each case titled `chain: ...`), with three fake entries, expect a first success to stop the chain, a `cancelled` outcome to stop immediately, a `continue` outcome to reach the next entry, a `stop` outcome to end the chain, and an all-failed run to return the last failure.
- [ ] **Green:** Implement `runChain` with `ChainOutcome = { kind: "done"; value } | { kind: "cancelled" } | { kind: "unavailable"; reason } | { kind: "failed"; message }` and a policy `{ continueOn(outcome): boolean }`.

**Validation:**

- Run (red): `mise exec -- nsh test framework/contributions/chain.test.ts --filter "chain:"` — fails on a missing module.
- Run (green): the same command — all chain cases pass.

### Task 5: Host the built-in AI modules through the registry

**Seam:** `initializeAiModules()` plus `createContributionRegistry()`.

**Outcome:** Protocols, providers, and presentations register through an adapter that keeps today's behavior; a registry instance is injectable for tests.

**Files:** Modify `src/app/ai-setup.ts`, `src/modules/ai/runtime/registry.ts`, `App.tsx`; Create `src/contributions/ai/index.ts`, `src/app/contributions-setup.ts`; Test `src/app/ai-setup.test.ts`, `App.test.tsx`.

**Steps:**

- [ ] **Red:** In `ai-setup.test.ts`, expect a fresh registry passed through the new adapter to hold exactly the four protocol ids and five provider ids, and expect two calls to be idempotent. The case fails until the adapter and `createAiSetup(registry)` exist.
- [ ] **Green:** Add `createAiSetup(registry, settingsRegistry)` in `src/contributions/ai/index.ts` that registers the four protocols, five providers, and five presentations; add `src/app/contributions-setup.ts` to build the registry, call the AI setup, and expose it to features; `initializeAiModules()` delegates to it. Keep `aiRegistry` and `providerSettingsRegistry` as the production instances.

**Validation:**

- Run (red): `mise exec -- nsh test app/ai-setup.test.ts --filter "ai setup:"` — fails until the adapter exists; `App.test.tsx` fails to start without the new setup entry.
- Run (green): the same command, then `mise exec -- nsh test modules/ai --filter "ai registry:"` — both pass.

### Task 6: Show and reorder channels in one host

**Seam:** `CapabilitySection` list state.

**Outcome:** One component renders the empty state, the ordered channel rows with enabled switches, the add dialog, and drag plus keyboard reorder.

**Files:** Create `src/features/settings/capability-section.tsx`, `capability-section-add-dialog.tsx`; Test `src/features/settings/capability-section.test.tsx` with `__tests__/capability-section-app.tsx`.

**Steps:**

- [ ] **Red:** In `capability-section.test.tsx` (cases titled `capability section: ...`), mount the harness with an empty collection. Expect the empty state text, the add button, and a dialog listing both fake channels. Add one, expect a row with the contribution label, and expect `order()` to persist to storage.
- [ ] **Red:** Expect `drag("id:settings-test-row-beta", { x: 0, y: -80 })` to reorder and persist, and ArrowUp/ArrowDown on the grip to reorder while keeping the focus.
- [ ] **Green:** Implement the host list with the measured-slot drag algorithm and keyboard handler currently in `tts-section.tsx` (lines 293–397), parameterized by channel id. Host props: `capability`, `registry`, `collection`, `labels { titleKey, addKey, emptyKey, priorityHintKey? }`, `selected`, `onSelect`, `extra?`, `onRegisterAddTrigger?`, `onAddBusyChange?`, `onDialogOpenChange?`, `onDirtyChange?`.

**Validation:**

- Run (red): `mise exec -- nsh test features/settings/capability-section.test.tsx --filter "capability section:"` — fails on a missing component.
- Run (green): the same command — list, add, and reorder cases pass.

### Task 7: Open, edit, save, and remove one channel

**Seam:** `CapabilitySection` detail state.

**Outcome:** Opening a row renders the contribution `Settings` with host-owned state; save persists config and credentials; delete asks first and survives a write failure.

**Files:** Modify `capability-section.tsx`; Test `capability-section.test.tsx`.

**Steps:**

- [ ] **Red:** In `capability-section.test.tsx` (cases titled `capability detail: ...`), open a saved channel. Expect the contribution Settings to render, a typed field to update the draft only, save to write the new config, and `app.storage()` not to contain a secret value in the config record.
- [ ] **Red:** Expect navigation away with a dirty draft to raise the guard, a failed save to keep the draft, and remove to clear the credential reference after confirmation.
- [ ] **Green:** Implement the detail shell (avatar, title, enable switch, delete, save, error line), `onDirtyChange`, and credential draft handling (`keep`/`replace`/`clear`).

**Validation:**

- Run (red): `mise exec -- nsh test features/settings/capability-section.test.tsx --filter "capability detail:"` — fails on missing detail behavior.
- Run (green): the same command — detail cases pass.

### Task 8: Express TTS channels as contributions

**Seam:** `ttsChannelContributions`.

**Outcome:** Google Cloud and Azure each declare config schema, credential fields, readiness, execute, and a controlled `Settings` component.

**Files:** Create `src/contributions/tts/channels/{google-cloud,azure}.tsx`, `src/contributions/tts/index.ts`, `src/contributions/tts/vendor/*` (moved); Modify `src/features/tts/{google-cloud,azure-speech,google-voices,google-preferences,google-samples,azure-voices,azure-regions}.ts` (deleted after the move).

**Steps:**

- [ ] **Red:** In `channels.test.ts` (cases titled `tts contribution: ...`), expect each contribution's `parse` to reject malformed stored config, `describe` to return the configured voice or region, `execute` to call the vendor client with the binding's credential through an injected `fetchImpl`, and `failureKey` to map every failure it can return.
- [ ] **Green:** Implement the two contributions, move the vendor files unchanged except import paths, export `TTS_CHANNELS` from `src/contributions/tts/index.ts`, and register both in `src/app/contributions-setup.ts`.

**Validation:**

- Run (red): `mise exec -- nsh test contributions/tts --filter "tts contribution:"` — fails before the files exist.
- Run (green): the same command, then `mise exec -- nsh test features/tts/google-cloud.test.ts --filter "google cloud tts:"` and `--filter "azure speech:"` — all pass.

### Task 9: Move the TTS store and runtime onto the framework

**Seam:** `ttsChannels` collection and `synthesizeSpeech` dispatch.

**Outcome:** TTS reads and writes `integrations.tts.v1`, migrating `settings.tts.v3` once; synthesis picks the active channel through the registry.

**Files:** Create `src/features/tts/store.ts`; Modify `src/features/tts/channels.ts`, `quick-speech.ts`, `synthesis.ts`, `App.tsx`, `src/app/__tests__/quick-translate-harness.tsx`; Delete `src/features/tts/settings.ts`; Test `src/features/tts/settings.test.ts` (rewritten), `quick-speech.test.ts`.

**Steps:**

- [ ] **Red:** In the rewritten `settings.test.ts`, seed a legacy `settings.tts.v3` payload with Google and Azure keys, expect the store to load both channels, keep the old key untouched, and persist the new record under `integrations.tts.v1`.
- [ ] **Red:** Expect enable to require a readable credential, remove to clear it, and reorder to persist.
- [ ] **Green:** Implement the migration (`order`, `enabled`, per-channel config from the legacy `googleCloud`/`azure` fields, credential text copied to the vault namespace) and route `synthesizeSpeech` through `contribution.execute`.

**Validation:**

- Run (red): `mise exec -- nsh test features/tts/settings.test.ts --filter "tts store:"` — fails on the new store.
- Run (green): the same command, then `--filter "quick speech:"` — all TTS runtime cases pass.

### Task 10: Replace the TTS settings section

**Seam:** Settings → Integrations → Text-to-Speech through `CapabilitySection`.

**Outcome:** The TTS section is the generic host with the Google and Azure contributions; the old 1202-line section is deleted.

**Files:** Modify `src/features/settings/page.tsx`; Delete `src/features/settings/tts-section.tsx`; Move `google-tts-fields.tsx` into `src/contributions/tts/channels/google-cloud.tsx`; Test `src/features/settings/settings.test.tsx`.

**Steps:**

- [ ] **Red:** In `settings.test.tsx`, add one case that opens Settings → Text-to-Speech and expects the shared host root `id:settings-capability-tts`, then keep the existing TTS test names and testIDs (`settings-tts-row-*`, `settings-tts-breadcrumb-root`, sample playback). It fails because the section still renders its own list.
- [ ] **Green:** Render `<CapabilitySection capability="tts" ... />` for the TTS entry, move the selection and breadcrumb to one generic `selectedChannel` signal, and delete the old section.

**Validation:**

- Run (red/green): `mise exec -- nsh test features/settings/settings.test.tsx --filter "tts settings:"` — red before the swap, green after.
- Run: `mise exec -- nsh test app/quick-translate.test.tsx --filter "quick tts:"` — speech playback cases still pass.

### Task 11: Express OCR channels as contributions

**Seam:** `ocrChannelContributions`.

**Outcome:** AI, Baidu, and Google Cloud Vision each declare config, credential fields, readiness, execute, and `Settings`; the vendor clients move under `src/contributions/ocr/vendor/`.

**Files:** Create `src/contributions/ocr/**`; Delete `src/features/ocr/{baidu,google-cloud}.ts` after the move; Test `src/contributions/ocr/channels.test.ts`.

**Steps:**

- [ ] **Red:** In `channels.test.ts` (cases titled `ocr contribution: ...`), expect Baidu `parse` to reject an unknown operation, `validate` to require both keys, `readiness` to be unready when the credential is missing, and `execute` to return the vendor failure mapped through `failureKey`.
- [ ] **Green:** Implement the three contributions, keep the AI channel's model resolution behind `HostServices.models.resolveSaved(modelId, "image")`, and register them in `src/app/contributions-setup.ts`.

**Validation:**

- Run (red): `mise exec -- nsh test contributions/ocr --filter "ocr contribution:"` — fails before the files exist.
- Run (green): the same command, then `mise exec -- nsh test features/ocr/baidu.test.ts --filter "baidu ocr:"` — pass.

### Task 12: Run OCR through the chain

**Seam:** `recognizeScreenshot()`.

**Outcome:** `recognize.ts` validates the PNG once, checks readiness through contributions, and runs `runChain`; the old per-channel branches are gone.

**Files:** Modify `src/features/ocr/recognize.ts`, `src/app/quick-translate-controller.ts`, `App.tsx`, `src/app/__tests__/quick-translate-harness.tsx`; Delete `src/features/ocr/settings.ts`; Create `src/features/ocr/store.ts`; Test `src/features/ocr/recognize.test.ts`, `settings.test.ts`.

**Steps:**

- [ ] **Red:** Keep `recognize.test.ts` behavior names. Add a case with the AI channel first and Baidu second where the AI model is ineligible: expect Baidu to run and the AI unavailability not to be reported when Baidu succeeds.
- [ ] **Red:** Seed `settings.ocr.v4` and expect the new `integrations.ocr.v1` record to load it once, including both credential prefixes.
- [ ] **Green:** Implement the store and the chain call; delete the readiness and recognize branches.

**Validation:**

- Run (red/green): `mise exec -- nsh test features/ocr/recognize.test.ts --filter "ocr recognize:"` — red before the refactor, green after.
- Run: `mise exec -- nsh test features/settings/settings.test.tsx --filter "ocr settings:"` — still passes.

### Task 13: Express detection channels as contributions

**Seam:** `detectChannelContributions`.

**Outcome:** AI, free Google, and Google Cloud v2 are contributions; the free Google channel needs no config; the detection chain runs through `runChain`.

**Files:** Create `src/contributions/detect/**`, `src/features/language-detection/store.ts`; Modify `src/features/language-detection/detect.ts`, `App.tsx`, `src/app/__tests__/quick-translate-harness.tsx`; Delete `src/features/language-detection/settings.ts`; Test `src/contributions/detect/channels.test.ts`, `src/features/language-detection/detect.test.ts`, `settings.test.ts`.

**Steps:**

- [ ] **Red:** In `channels.test.ts` (cases titled `detect contribution: ...`), expect the free Google contribution to report `configurable: false`, `available()` to include it while unconfigured, and adding it to enable it immediately.
- [ ] **Red:** Expect `detectLanguage` to keep its current fallback order and failure codes after the refactor, and the new store to migrate `settings.languageDetection.v4`.
- [ ] **Green:** Implement the three contributions, register them in `src/app/contributions-setup.ts`, and run the chain while keeping `boundDetectionSample` and `parseDetectionAnswer` in `detect.ts`.

**Validation:**

- Run (red): `mise exec -- nsh test contributions/detect --filter "detect contribution:"` — fails before the files exist.
- Run (green): `mise exec -- nsh test features/language-detection --filter "detect:"` and `--filter "language detection store:"` — pass.

### Task 14: Replace the OCR and language-detection sections

**Seam:** Settings → Integrations → OCR and Language Detection through `CapabilitySection`.

**Outcome:** Both sections render through the host; the detection language-preferences card becomes the host's `extra` slot; both old section files are deleted.

**Files:** Modify `src/features/settings/page.tsx`; Delete `ocr-section.tsx`, `language-detection-section.tsx`; Test `settings.test.tsx`.

**Steps:**

- [ ] **Red:** Keep the existing test names and testIDs for both sections; expect priority badges, key-unreadable alerts, and the detection preferences card to keep their current behavior.
- [ ] **Green:** Render both through the host; pass `extra={<DetectionPreferencesCard />}` for detection; delete old sections and the per-section selection signals.

**Validation:**

- Run: `mise exec -- nsh test features/settings/settings.test.tsx --filter "ocr settings:"` and `--filter "language detection:"` — pass.
- Run: `mise exec -- nsh test app/quick-translate.test.tsx --filter "quick ocr:"` and `--filter "quick detection:"` — pass.

### Task 15: Declare preset engines as contributions

**Seam:** `presetEngineContributions`.

**Outcome:** Each engine declares `id`, `labelKey`, `icon`, `config`, `credential`, `validate`, `execute`, `summary`, and `Settings`; the preset types carry `kind: string` plus contribution-parsed config.

**Files:** Create `src/framework/contributions/preset-engine.ts`, `src/contributions/presets/{index,deepl,google-cloud}.tsx`; Modify `src/features/presets/types.ts`, `validation.ts`; Test `src/contributions/presets/engines.test.ts`.

**Steps:**

- [ ] **Red:** In `engines.test.ts` (cases titled `preset engine: ...`), expect DeepL `validate` to reject a blank key with `deepl_key_required` and accept a stored key; Google Cloud likewise; the AI engine to require a primary model and at least one template.
- [ ] **Green:** Implement the contract and the DeepL plus Google Cloud contributions, register both in `src/app/contributions-setup.ts`, and keep the AI engine for Task 16.

**Validation:**

- Run (red): `mise exec -- nsh test contributions/presets --filter "preset engine:"` — fails before the files exist.
- Run (green): the same command — engine validation cases pass.

### Task 16: Move the AI preset engine and preset UI onto contributions

**Seam:** `translateWithPreset()`, `PresetEditor`, `AddPresetDialog`.

**Outcome:** The editor renders `contribution.Settings`; the engine-type picker comes from the registry; `translate.ts` calls `contribution.execute` once.

**Files:** Create `src/contributions/presets/ai.tsx`, `src/components/preset/{models-section,prompt-templates}.tsx` (moved); Modify `src/features/presets/{draft,editor,page,add-preset-dialog,model-choices,preset-mark,store}.ts(x)`, `src/features/quick-translate/translate.ts`; Test `src/features/presets/presets.test.tsx`, `store.test.ts`, `translate.test.ts`.

**Steps:**

- [ ] **Red:** Expect a new preset to be creatable for each of the three registered engines, `engine_type_locked` to still reject a kind change on save, and `translateWithPreset` to produce the same `{ text, modelId, templateId }` for all three.
- [ ] **Green:** Implement the AI engine contribution, derive the picker from `registry.list("preset-engine")`, replace the two credential branches plus the model-chain branch with `contribution.execute`, and move `src/features/presets/languages.ts` to `src/framework/languages.ts` (same exports) so `src/modules/deepl` and `src/modules/google-cloud-translation` stop importing a feature.

**Validation:**

- Run (red/green): `mise exec -- nsh test features/presets/presets.test.tsx --filter "presets:"` — red before the swap, green after.
- Run: `mise exec -- nsh test features/quick-translate/translate.test.ts --filter "translate with preset:"` — pass.

### Task 17: Let a protocol declare request parameters

**Seam:** `ProtocolDefinition.requestParams` plus `AiClientInput.params`.

**Outcome:** A protocol declares body, header, and query parameters; a channel value reaches the outgoing request; an unknown stored key is preserved but not applied.

**Files:** Create `src/modules/ai/contracts/request-params.ts`; Modify `src/modules/ai/contracts/protocol.ts`, `channel.ts`, `runtime/client.ts`, `protocols/*/index.ts`; Test `src/modules/ai/protocols/request-params.test.ts`, `src/modules/ai/runtime/client.test.ts`.

**Steps:**

- [ ] **Red:** In `request-params.test.ts` (cases titled `request params: ...`), declare two parameters on a fake protocol and expect a body extra to merge without overriding `model`/`messages`, a header extra to merge without overriding `Authorization`, a query extra to append with encoding, and an unknown key to be ignored.
- [ ] **Green:** Implement `RequestParamSpec`, the merge order (protocol default → channel → call), and apply it in the four built-in protocols' request builders.

**Validation:**

- Run (red): `mise exec -- nsh test modules/ai/protocols/request-params.test.ts --filter "request params:"` — fails before the contract exists.
- Run (green): the same command, then `mise exec -- nsh test modules/ai/runtime/client.test.ts --filter "ai client:"` — pass.

### Task 18: Configure request parameters per channel

**Seam:** Channel editor → advanced request parameters card.

**Outcome:** The channel stores `params` per protocol id, the editor renders the declared fields, and saving validates values before persistence.

**Files:** Modify `src/modules/ai/contracts/channel.ts`, `src/features/models/store.ts`, `src/features/models/editor/controller.ts`, `channel-editor.tsx`, `src/modules/ai/ui/contracts.ts`, `connection-fields.tsx`; Test `src/features/models/channels.test.tsx`, `src/features/models/storage.test.ts`.

**Steps:**

- [ ] **Red:** In `channels.test.tsx` (cases titled `request params: ...`), expect a channel to save `{ params: { protocol: { key: value } } }`, reload it, and pass it into `ConnectionSnapshot`; expect switching the protocol to keep the other protocol's values and hide its fields.
- [ ] **Green:** Implement the advanced card, controller state, and store validation that rejects a value failing `RequestParamSpec.validate` before writing.

**Validation:**

- Run (red/green): `mise exec -- nsh test features/models/channels.test.tsx --filter "request params:"` — red before the UI, green after.

### Task 19: Add the word entry model and the Anki contribution

**Seam:** `WordbookContribution.add(entry)`.

**Outcome:** One saving action passes a full `WordEntry` to the active destination; Anki maps only the fields it supports.

**Files:** Create `src/framework/contributions/wordbook.ts`, `src/contributions/wordbook/anki.ts`, `src/features/wordbook/store.ts`; Modify `src/app/quick-translate.tsx`, `src/features/quick-translate/session.ts`, `App.tsx`, `src/app/__tests__/quick-translate-harness.tsx`; Test `src/contributions/wordbook/anki.test.ts`, `src/features/wordbook/settings.test.ts`.

**Steps:**

- [ ] **Red:** In `anki.test.ts` (cases titled `wordbook contribution: ...`), expect `add(entry)` to reject a blank pair without a request, to send source and translation to the configured Anki deck, and to ignore the optional model/language fields.
- [ ] **Green:** Implement `WordEntry` and the contribution, register it in `src/app/contributions-setup.ts`, and add the store migration from `settings.wordbook.anki.v1`.

**Validation:**

- Run (red): `mise exec -- nsh test contributions/wordbook --filter "wordbook contribution:"` — fails before the files exist.
- Run (green): the same command, then `mise exec -- nsh test features/wordbook --filter "wordbook settings:"` — pass.

### Task 20: Replace the wordbook section and drop Anki vocabulary from the session

**Seam:** Settings → Integrations → Wordbook plus the Quick Translate add action.

**Outcome:** The section renders through the host; session and popup name the action by the destination, not by Anki.

**Files:** Modify `src/features/settings/page.tsx`, `src/features/quick-translate/session.ts`, `popup.tsx`; Delete `src/features/settings/wordbook-section.tsx`; Test `settings.test.tsx`, `popup.test.tsx`, `app/quick-translate.test.tsx`.

**Steps:**

- [ ] **Red:** Keep the wordbook page test names and testIDs; expect the add action to show the destination label and the discard guard to still work.
- [ ] **Green:** Render the section through the host with a single destination; rename `CardAnkiState` and `ANKI_FAILURE` to destination-neutral names; delete the old section.

**Validation:**

- Run: `mise exec -- nsh test features/settings/settings.test.tsx --filter "wordbook page:"` — pass.
- Run: `mise exec -- nsh test app/quick-translate.test.tsx --filter "quick anki:"` — pass after the rename.

## Final Validation

- Run: `mise run verify` — formatting, lint, type checks, tests, and build pass.
- Run: `mise exec -- nsh test features/settings/settings.test.tsx --target windows --filter "settings"` — the settings page works in a desktop window.
- Run: `mise exec -- nsh test app/quick-translate.test.tsx --target windows --filter "quick"` — Quick Translate still works with the migrated stores. Run this explicitly because `mise run test-desktop` does not include `app/*.test.tsx`.
- Manual: open Settings → Integrations with each migrated domain, confirm the priority hint, reorder, save, remove, and a failed credential read all behave as before.

## Failure Behavior

- A stored channel whose contribution is missing is skipped, counted, and left on disk; the section shows the count instead of failing to load.
- A malformed stored record fails the domain load, surfaces one error in the section, and does not overwrite the record.
- A credential read failure marks the channel unreadable and blocks enabling it; the secret is never logged.
- A duplicate contribution id throws during startup assembly, which `App.tsx` turns into the existing startup error window; the message names the axis and id.
- A channel save failure keeps the draft and reports the message in the detail pane.

## Privacy and Security

- Secrets stay out of config records, logs, and test assertions; they live only under the vault namespace.
- NSH `Storage` is plaintext with a 5 MB cap. The plan does not add encryption; the wordbook and TTS UI keep their existing notice, and new sections must state that keys are stored unencrypted.
- Contributions receive credentials through `HostServices` only for the duration of one call; no contribution may retain them.
- Compile-time contributions are trusted code. A runtime loader must add a host allowlist and a credential handle that cannot leave the declared origin; that work is out of scope but the contracts must not assume in-process trust.

## Rollout Notes

- Milestones ship independently: M0 (Tasks 1–5) changes no behavior; M1 (6–10) proves the pattern on TTS; M2 (11–14) repeats it for OCR and detection; M3 (15–16) covers presets; M4 (17–18) adds request parameters; M5 (19–20) covers the wordbook.
- Each migrated domain writes a new key and keeps reading the old one for one release; no migration deletes the legacy entry.
- Old store singletons stay until their last consumer is switched, then are deleted in the same task.

## Risks and Mitigations

- **Host parity drift** — the three sections carry 3634 lines of interaction detail. Mitigation: keep the existing testIDs and test names, port tests before deleting each section, and land TTS first as the reference.
- **Recursive abstraction** — `CapabilitySection` starts to encode per-domain differences. Mitigation: only metadata, config, and the contribution `Settings` may differ; add a prop only when two domains need it.
- **Migration data loss** — mitigated by the read-old-key rule and by tests that seed legacy payloads.
- **Test churn** — `settings.test.tsx` is 144 KB. Mitigation: port cases domain by domain inside the same task that deletes the old section; never rewrite the file wholesale.
- **Preset engine contract too wide** — the AI engine needs model and template UI. Mitigation: engine `Settings` composes feature-owned presentational blocks moved to `src/components/preset/`, and the contract stays data-only.

## Open Questions

1. Should M3–M5 ship as this plan or as three follow-up plans? The tasks are independent after M0.
2. The wordbook stays a single destination in Task 20. If a second destination is planned, Task 19's store should carry a destination id from day one.
3. Should the credential migration rewrite refs into the new vault namespace, or keep the old key prefixes to avoid touching secrets? The plan assumes copying (small, testable) so every namespace is uniform.
