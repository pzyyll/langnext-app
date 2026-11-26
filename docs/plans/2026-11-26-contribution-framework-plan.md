# Implementation Plan

> **Current names:** The implementation now uses `src/integrations/`,
> `src/framework/integrations/`, and `src/app/integrations-setup.ts`.
> `IntegrationRegistry`, `initializeIntegrations()`, and `CapabilityChannelDefinition`
> replace `ContributionRegistry`, `initializeContributions()`, and
> `CapabilityChannelContribution`. The storage keys did not change. The paths,
> names, and commands below describe the original implementation.

**Goal:** Build the contribution framework (`src/framework/contributions/`) and migrate the capability domains (TTS, OCR, and language detection) plus the existing AI setup onto shared contracts and one settings host (`CapabilitySection`), so a later runtime loader or future extension axis can register contributions without feature changes.

**Inputs:** The 2026-11-26 research document [功能插件化与模块化架构调研](../analysis/2026-11-26-feature-plugin-architecture.md) and the user's review decisions on 2026-11-26: narrow this plan to M0–M2, apply Demo-stage breaking storage switches with no legacy data migration, and preserve current interaction behavior without adding new leave guards on capability sections.

**Assumptions:**

- Scope covers M0 (framework foundation + AI registry unification), M1 (`CapabilitySection` + TTS), and M2 (OCR + language detection). Preset engines (M3), AI request parameters (M4), and wordbook (M5) move to follow-up plans.
- Runtime plugin loading is out of scope. Contributions are compiled in and registered by `src/app/contributions-setup.ts`. Contracts stay free of feature and app imports so a loader can register them later.
- The app is in the Demo stage. Storage keys switch directly (`integrations.tts.v1`, `integrations.ocr.v1`, `integrations.detect.v1`, and `settings.languageDetection.preferences.v1`) with no one-time legacy readers or migration code for `settings.tts.v3`, `settings.ocr.v4`, `settings.languageDetection.v4`, or old credential prefixes.
- `src/framework/` holds contract-only code and shared primitives; `src/contributions/` holds domain implementations; `src/components/ui/` stays the design system.
- No UI redesign and no new leave-confirmation dialogs on TTS, OCR, or language detection. Existing interaction details (drag and keyboard reorder, breadcrumbs, focus restore, priority badges, and testIDs) stay intact.

**Architecture:** Four framework facilities (`ContributionRegistry`, `CredentialVault`, `ChannelCollection`, `runChain`) plus one host component (`CapabilitySection`) replace the three duplicated capability stores and three hand-written settings sections. A contribution is a plain object with metadata, a `ConfigSchema` with `parse`, optional `CredentialField` declarations, runtime hooks, and an optional controlled `Settings` component.

Layering rules enforced by review:

1. `src/framework/` imports no `src/features/`, `src/contributions/`, or `src/app/` modules. It may import pure contract types from `src/modules/ai/contracts` and `src/modules/ai/ui/contracts`, plus `FetchLike` from `src/services/http` and `Logger` from `src/services/log`.
2. `src/contributions/` imports no `src/features/` or `src/app/` modules. It may import `src/framework/`, `src/components/ui/`, `src/modules/` (vendor clients and `FormField`), and `src/services/`.
3. `src/app/contributions-setup.ts` is the sole assembly entry that populates the production `ContributionRegistry` (protocols, providers, provider presentations, and capability channels). Features read stores from their own `store.ts`, which receives the registry accessor from `src/framework/`.
4. `src/features/` never imports a contribution's vendor client or `Settings` component; features invoke channels through `src/framework/` contracts and render settings only through `CapabilitySection`.

**Tech Stack:** TypeScript/TSX, NSH 0.6 `signal`/`Storage`/`JSX`, `nsh/test` headless runs, `nsh/i18n` (`t`, static YAML keys), mise tasks. No new runtime dependencies.

---

## File Map

**Framework (new)**

- Create: `src/framework/languages.ts` — moved from `src/features/presets/languages.ts` (same exports) so `src/modules/*`, `src/contributions/*`, and `src/features/*` share language definitions without inverted imports.
- Create: `src/framework/contributions/contracts.ts` — `ContributionMeta`, `ContributionAxis`, `ConfigSchema`, `CredentialField`, `CredentialRecord`, `ChannelBinding`, `CapabilityId`, `CapabilityChannelContribution`, `ChannelSettingsProps`, `ChannelSettingsHost`, `ModelChoiceOption`, `ModelBindingStatus`, `ModelConnectionRoute`, `ResolvedModelRoute`, `HostServices`, `ValidationResult`, `Readiness`, `PrepareResult`.
- Create: `src/framework/contributions/registry.ts` — `createContributionRegistry`, `ContributionRegistry`, `Diagnostic`, `getContributionRegistry`, `setContributionRegistry`.
- Create: `src/framework/contributions/credential-vault.ts` — `createCredentialVault`, `CredentialVault`.
- Create: `src/framework/contributions/channel-collection.ts` — `createChannelCollection`, `ChannelCollection`, `ChannelCollectionPolicy`, `StoredCollection`, `CredentialInput`, `Result`.
- Create: `src/framework/contributions/chain.ts` — `runChain`, `ChainStepOutcome`, `ChainPolicy`, `ChainOutcome`.
- Create: `src/framework/contributions/index.ts` — public re-exports.

**Assembly & AI adapter**

- Create: `src/app/contributions-setup.ts` — builds the production `ContributionRegistry`, registers AI modules and capability channels, and exposes startup initialization.
- Create: `src/contributions/ai/index.ts` — `registerAiContributions(registry)` registering the 4 protocols, 5 providers, and 5 provider presentations.
- Modify: `src/modules/ai/runtime/registry.ts`, `src/modules/ai/ui/registry.ts` — make `aiRegistry` and `providerSettingsRegistry` thin views over the shared `ContributionRegistry` instead of storing separate `Map` instances.
- Modify: `src/app/ai-setup.ts`, `App.tsx` — delegate `initializeAiModules()` to `contributions-setup.ts` and call `initializeContributions()` at startup.

**Capability section host (new)**

- Create: `src/features/settings/capability-section.tsx` — list, reorder (drag + keyboard), add dialog trigger, detail shell, save, delete, credential readability check, and contribution `Settings` mount with `testIdPrefix` support.
- Create: `src/features/settings/capability-section-add-dialog.tsx` — available-channel picker shared by all capability domains.

**Localization (modify)**

- Modify: `locales/en.yml`, `locales/zh-CN.yml` — add shared capability-host strings (skipped-contribution notice, generic store errors, plaintext credential storage notice).

**TTS**

- Create: `src/contributions/tts/channels/google-cloud.tsx`, `src/contributions/tts/channels/azure.tsx` — `parse`, `validate`, `describe`, `prepare`, `signature`, `readiness`, `execute`, `failureKey`, and controlled `Settings` (with `GoogleTtsFields` and `GoogleOverrideDialog` moved from `src/features/settings/google-tts-fields.tsx`).
- Create: `src/contributions/tts/index.ts` — exports `ttsChannelContributions`.
- Move: `src/features/tts/{google-cloud,azure-speech,google-voices,google-preferences,google-samples,azure-voices,azure-regions}.ts` and `src/features/tts/{google-cloud,azure-speech,google-voices}.test.ts` to `src/contributions/tts/vendor/`.
- Create: `src/features/tts/store.ts` — `ttsChannels` collection (`integrations.tts.v1`, vault namespace `secret.tts`, `enableOnFirstSave: false`, `requireReadableCredentialOnEnable: true`).
- Modify: `src/features/tts/channels.ts`, `src/features/tts/quick-speech.ts`, `src/features/tts/synthesis.ts` — dispatch through the contribution registry and collection.
- Delete: `src/features/tts/settings.ts`, `src/features/settings/tts-section.tsx`, `src/features/settings/google-tts-fields.tsx`.

**OCR**

- Create: `src/contributions/ocr/channels/{ai,baidu,google-cloud}.tsx` (or `.ts` where headless) and `src/contributions/ocr/index.ts` — exports `ocrChannelContributions`.
- Move: `src/features/ocr/{baidu,google-cloud}.ts` and `src/features/ocr/{baidu,google-cloud}.test.ts` to `src/contributions/ocr/vendor/`.
- Create: `src/features/ocr/store.ts` — `ocrChannels` collection (`integrations.ocr.v1`, vault namespace `secret.ocr`, `enableOnFirstSave: true`).
- Modify: `src/features/ocr/recognize.ts` — run readiness and recognition through contributions and `runChain`.
- Delete: `src/features/ocr/settings.ts`, `src/features/settings/ocr-section.tsx`.

**Language detection**

- Create: `src/contributions/detect/channels/{ai,google,google-cloud}.tsx` (or `.ts` for `google.ts`) and `src/contributions/detect/index.ts` — exports `detectChannelContributions`.
- Create: `src/contributions/detect/vendor/google-free.ts` — the free `translate_a/t` client extracted from `detect.ts`.
- Create: `src/features/language-detection/store.ts` and `src/features/language-detection/preferences.ts` — `detectChannels` collection (`integrations.detect.v1`, vault namespace `secret.detect`, `enableOnFirstSave: true`) plus separate preferences store (`settings.languageDetection.preferences.v1`) and combined `snapshot()`.
- Create: `src/features/settings/detection-preferences-card.tsx` — language-preferences card passed into `CapabilitySection` via `extra`.
- Modify: `src/features/language-detection/detect.ts`, `src/features/language-detection/resolve.ts` — run detection through contributions and `runChain`.
- Delete: `src/features/language-detection/settings.ts`, `src/features/settings/language-detection-section.tsx`.

**Cross-feature & app consumers (modify)**

- Update `src/features/presets/languages.ts` imports across `src/features/presets/*`, `src/features/quick-translate/*`, `src/modules/deepl/*`, and `src/modules/google-cloud-translation/*` to `src/framework/languages`.
- Modify: `src/features/settings/page.tsx` — mount `<CapabilitySection>` for `"tts"`, `"ocr"`, and `"language-detection"`, and unify the three `selected*Channel` signals into one `selectedChannel` signal.
- Modify: `src/features/quick-translate/popup.tsx`, `src/features/quick-translate/session.ts`, `src/features/quick-translate/source-detection.ts`, `src/app/quick-translate-controller.ts`, `App.tsx`.

**Tests (new)**

- Create: `src/framework/contributions/registry.test.ts`, `credential-vault.test.ts`, `channel-collection.test.ts`, `chain.test.ts`.
- Create: `src/features/settings/__tests__/capability-section-app.tsx`, `src/features/settings/capability-section.test.tsx`.
- Create: `src/contributions/tts/channels/channels.test.ts`, `src/contributions/ocr/channels/channels.test.ts`, `src/contributions/detect/channels/channels.test.ts`.

**Tests (modify)**

- `App.test.tsx`, `src/app/ai-setup.test.ts`, `src/modules/ai/runtime/registry.test.ts`, `src/modules/ai/ui/registry.test.ts`, `src/features/settings/settings.test.tsx`.
- `src/features/tts/{settings,quick-speech}.test.ts`, `src/features/ocr/{settings,recognize}.test.ts`, `src/features/language-detection/{settings,detect}.test.ts`.
- `src/features/quick-translate/{popup,source-detection}.test.ts` (and `.tsx`), `src/features/quick-translate/__tests__/popup-harness.tsx`, `src/app/quick-translate.test.tsx`, `src/app/__tests__/quick-translate-harness.tsx`, `src/services/log.test.ts`.

---

## Seams

- **Seam:** `createContributionRegistry()` — registration, lookup, axis filtering, and cross-axis diagnostics.
- **Seam:** `createCredentialVault({ storage, namespace })` — `put` / `read` / `remove` of `CredentialRecord` maps under `${namespace}.${ref}`.
- **Seam:** `createChannelCollection(options)` — load, add, save, enable, reorder, remove, policy enforcement, and skipped-entry counting.
- **Seam:** `runChain(entries, run, policy, signal?)` — ordered fallback, cancellation stop, non-retryable stop, and `lastFailure ?? firstUnavailable` aggregation.
- **Seam:** `CapabilitySection` — shared settings host: empty state, add dialog, reorder, detail shell, save, delete, and credential-readability alert.
- **Seam:** `ttsChannelContributions` / `ocrChannelContributions` / `detectChannelContributions` — each channel's `parse`, `validate`, `describe`, `prepare`, `signature`, `readiness`, `execute`, `failureKey`, and optional `Settings`.

---

## Contract Shape

Framework files expose these contracts; individual tasks only refine non-breaking details.

```ts
export type ContributionAxis =
  | "protocol"
  | "provider"
  | "provider-presentation"
  | "capability";

export type CapabilityId = "tts" | "ocr" | "detect";

export interface ContributionMeta {
  id: string;
  labelKey: string;
  icon: ImageAsset;
  iconTone?: "brand" | "monochrome";
}

export interface ConfigSchema<C> {
  parse(raw: unknown): C | null;
  defaults(): C;
}

export interface CredentialField {
  key: string;
  labelKey: string;
  masked: boolean;
}

export type CredentialRecord = Readonly<Record<string, string>>;

export interface ChannelBinding<C> {
  enabled: boolean;
  configured: boolean;
  config: C;
  credentialRef: string | null;
}

export interface ModelChoiceOption {
  id: string;
  channelId: string;
  modelKey: string;
  label: string;
}

export type ModelBindingStatus =
  | { ok: true; label: string }
  | { ok: false; reason: string };

export interface ModelConnectionRoute {
  providerTypeId: string;
  protocolId: string;
  baseUrl: string | null;
  credential: string | null;
}

export type ResolvedModelRoute =
  | { ok: true; modelId: string; modelKey: string; connection: ModelConnectionRoute }
  | { ok: false; reason: string };

export interface ChannelAudioHost {
  canPlay(): Promise<boolean>;
  playMp3(
    bytes: Uint8Array,
    hooks?: { onPlaying?: () => void },
  ): { stop(): void; result: Promise<{ status: "ended" | "stopped" | "failed" }> };
}

export interface ChannelSettingsHost {
  modelChoices?: () => readonly ModelChoiceOption[];
  resolveModelBinding?: (modelId: string, purpose: "text" | "image") => ModelBindingStatus;
  onManageModels?: () => void;
  onDialogOpenChange: (open: boolean) => void;
  readSavedCredential(): Promise<CredentialRecord | null>;
  audio?: ChannelAudioHost;
}

export interface ChannelSettingsProps<C> {
  binding: ChannelBinding<C>;
  compact: boolean;
  disabled: boolean;
  savedCredential: boolean;
  credentialState: "unknown" | "readable" | "missing";
  credentialDraft: CredentialRecord;
  host: ChannelSettingsHost;
  onChange(patch: Partial<C>): void;
  onCredentialChange(field: string, value: string): void;
  onClearCredential(): void;
}

export interface HostServices {
  /** Credential read for this single channel call; never exposes other channel refs. */
  credential: CredentialRecord | null;
  models: {
    resolveSaved(modelId: string, purpose: "text" | "image"): Promise<ResolvedModelRoute>;
    generateText(
      connection: ModelConnectionRoute,
      request: { modelId: string; system: string; user: string; disableReasoning?: boolean },
      options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<string>;
    generateTextFromImage(
      connection: ModelConnectionRoute,
      request: {
        modelId: string;
        system: string;
        user: string;
        image: { mimeType: "image/png"; base64: string };
      },
      options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<string>;
  };
  fetchImpl?: FetchLike;
  log: Logger;
}

export type Readiness = { ready: true } | { ready: false; reason: string };
export type ValidationResult = { ok: true } | { ok: false; key: string; field?: string };
export type PrepareResult<In> = { ok: true; input: In } | { ok: false; message: string };
export type Result = { ok: true } | { ok: false; key: string; message: string };
export type CredentialInput =
  | { mode: "keep" }
  | { mode: "replace"; value: CredentialRecord }
  | { mode: "clear" };

export interface CapabilityChannelContribution<C, In, Out> extends ContributionMeta {
  capability: CapabilityId;
  configurable: boolean;
  config: ConfigSchema<C>;
  credential: readonly CredentialField[] | null;
  describe(binding: ChannelBinding<C>): string;
  signature?(binding: ChannelBinding<C>): string;
  validate?(draft: {
    config: C;
    credentialDraft: CredentialRecord;
    savedCredential: boolean;
  }): ValidationResult;
  prepare?(binding: ChannelBinding<C>, input: In): PrepareResult<In>;
  readiness(binding: ChannelBinding<C>, host: HostServices): Promise<Readiness>;
  execute(binding: ChannelBinding<C>, input: In, host: HostServices): Promise<Out>;
  failureKey(failure: string): string | null;
  Settings?: (props: ChannelSettingsProps<C>) => JSX.Element;
}
```

---

## Out of Scope

- Preset engines (M3), AI custom request parameters (M4), and wordbook multi-destination support (M5). See **Follow-up Plans** for audit caveats to carry forward.
- Moving `src/modules/ai` into `src/contributions/ai`. Task 5 connects the existing AI modules to the unified `ContributionRegistry` through `src/contributions/ai/index.ts`.
- Runtime plugin loading, sandboxing, and protocol origin allowlists. Contracts stay host-free so a loader can register them later.
- Encrypted credential storage or OS keychain integration.
- Legacy storage migration from `settings.tts.v3`, `settings.ocr.v4`, `settings.languageDetection.v4`, or old credential key prefixes.
- New providers, protocols, voices, OCR engines, or UI redesigns.

---

## Tasks

### Milestone 0: Framework Foundation & AI Registry Unification

#### Task 1: Move shared languages and build the contribution registry

**Seam:** `src/framework/languages.ts` and `createContributionRegistry()`.

**Outcome:** Language definitions live in `src/framework/languages.ts` without feature-to-module inversion; the registry stores the four active axes, validates ids, filters capability channels, and reports cross-axis diagnostics.

**Files:**

- Create: `src/framework/languages.ts` (moved from `src/features/presets/languages.ts`), `src/framework/contributions/contracts.ts`, `src/framework/contributions/registry.ts`, `src/framework/contributions/index.ts`.
- Delete: `src/features/presets/languages.ts` (after updating all importers across `src/features/*`, `src/modules/deepl/*`, and `src/modules/google-cloud-translation/*`).
- Test: `src/framework/contributions/registry.test.ts`.

**Steps:**

- [ ] **Red:** In `src/framework/contributions/registry.test.ts` (each case titled `contributions registry: ...`), register a protocol, a provider, a presentation, and two capability channels (`tts` and `ocr`). Expect `get("protocol", id)` to return the registered object, `capabilities("tts")` to return only TTS channels, a duplicate or blank id to throw, and an unknown lookup to throw an error naming the axis and id.
- [ ] **Red:** Expect `diagnostics()` to report a provider whose `allowedProtocolIds` / `defaultProtocolId` / `catalogProtocolId` references an unregistered protocol, a provider without a matching `provider-presentation`, and a capability channel with an invalid `capability` value.
- [ ] **Green:** Move `src/features/presets/languages.ts` to `src/framework/languages.ts` and update all importers. Implement `contracts.ts` (using pure types from `src/modules/ai/contracts` and `src/modules/ai/ui/contracts`) and `createContributionRegistry()` with one `Map` per axis, shared id validation, and `diagnostics()`.

**Validation:**

- Run (red): `mise exec -- nsh test src/framework/contributions/registry.test.ts --filter "contributions registry:"` — fails on missing module.
- Run (green): `mise exec -- nsh test src/framework/contributions/registry.test.ts --filter "contributions registry:"` — all registry cases pass; `mise run check` passes after the `languages.ts` move.

#### Task 2: Store and read credential records by reference

**Seam:** `createCredentialVault({ storage, namespace })`.

**Outcome:** A `CredentialRecord` (`Record<string, string>`) is serialized under `${namespace}.${ref}`, read back by reference, removed by reference, and rejects on storage I/O failures.

**Files:**

- Create: `src/framework/contributions/credential-vault.ts`; Test `src/framework/contributions/credential-vault.test.ts`.

**Steps:**

- [ ] **Red:** In `src/framework/contributions/credential-vault.test.ts` (each case titled `credential vault: ...`), with an in-memory storage double, expect `put({ apiKey: "sk-1", secretKey: "sec-2" })` to resolve to a UUID ref, `${namespace}.${ref}` to exist in storage, `read(ref)` to return `{ apiKey: "sk-1", secretKey: "sec-2" }`, `read(other)` to return `null`, malformed JSON or non-string fields to return `null`, and `remove(ref)` to delete only that key.
- [ ] **Red:** Expect a storage `getItem` rejection to reject `read(ref)` rather than returning `null`, so callers can distinguish missing secrets from `storage_read_failed`.
- [ ] **Green:** Implement `createCredentialVault` with `crypto.randomUUID()`, JSON serialization of trimmed non-empty string pairs, `storage.getItem`/`setItem`/`removeItem`, and zero logging of credential values.

**Validation:**

- Run (red): `mise exec -- nsh test src/framework/contributions/credential-vault.test.ts --filter "credential vault:"` — fails on missing module.
- Run (green): `mise exec -- nsh test src/framework/contributions/credential-vault.test.ts --filter "credential vault:"` — all vault cases pass.

#### Task 3: Persist a channel collection with domain policies

**Seam:** `createChannelCollection(options)`.

**Outcome:** One versioned JSON record holds `order` and `channels[id]` (`enabled`, `configured`, `config`, `credentialRef`); added-unconfigured channels, non-configurable channels, per-domain enable policies, and unknown stored channel ids all behave predictably.

**Files:**

- Create: `src/framework/contributions/channel-collection.ts`; Test `src/framework/contributions/channel-collection.test.ts`.

**Steps:**

- [ ] **Red:** In `src/framework/contributions/channel-collection.test.ts` (each case titled `channel collection: ...`), with fake configurable (`alpha`, `beta`) and non-configurable (`free`) channels and an in-memory storage double:
  - Expect `load()` on empty storage to leave `order()` empty and `available()` containing all registered ids.
  - Expect `add("alpha")` to append `"alpha"` with `configured: false, enabled: false`, while `add("free")` (`configurable: false`) appends `"free"` with `configured: true, enabled: true`.
  - Expect `save("alpha", config, { mode: "replace", value: { apiKey: "k" } })` to store `{ version: 1, order: ["alpha"], channels: { alpha: { enabled: false, configured: true, config, credentialRef } } }` when `enableOnFirstSave: false`, and `enabled: true` when `enableOnFirstSave: true`.
- [ ] **Red:** Expect `setEnabled("alpha", true)` to fail with `channel_unconfigured` when `configured` is false, to verify credential readability when `requireReadableCredentialOnEnable: true` (failing with `credential_unreadable` when missing), `moveTo` to clamp indices, `remove` to delete the vault entry and keep `order` clean, and an unknown stored channel id to stay untouched on disk and increment `skippedCount()`.
- [ ] **Green:** Implement `createChannelCollection` with versioned JSON parse/serialize, per-channel `config.parse`, write queue serialization, vault cleanup on rollback/replace/remove, and `Result`.

**Validation:**

- Run (red): `mise exec -- nsh test src/framework/contributions/channel-collection.test.ts --filter "channel collection:"` — fails on missing module.
- Run (green): `mise exec -- nsh test src/framework/contributions/channel-collection.test.ts --filter "channel collection:"` — all collection cases pass.

#### Task 4: Run an ordered fallback chain

**Seam:** `runChain(entries, run, policy, signal?)`.

**Outcome:** OCR and language detection share one deterministic chain runner: stop immediately on `done`, `cancelled`, or a non-retryable `failed`; continue on `unavailable` or retryable `failed`; return `lastFailure` when present and otherwise `firstUnavailable`.

**Files:**

- Create: `src/framework/contributions/chain.ts`; Test `src/framework/contributions/chain.test.ts`.

**Steps:**

- [ ] **Red:** In `src/framework/contributions/chain.test.ts` (each case titled `chain: ...`), with three fake entries, expect:
  - First `done` stops the chain and returns `{ kind: "done", value }`.
  - `cancelled` or an aborted `AbortSignal` stops immediately and returns `{ kind: "cancelled" }`.
  - `unavailable` followed by `done` succeeds; `unavailable` across all entries returns `{ kind: "unavailable", reason: firstUnavailable }`.
  - `failed` with `continueOn(outcome) === true` continues and returns the last `failed` when exhausted (even if an earlier entry was `unavailable`, matching `lastFailure ?? firstUnavailable`).
  - `failed` with `continueOn(outcome) === false` stops immediately and returns that failure.
- [ ] **Green:** Implement `runChain` in `src/framework/contributions/chain.ts` and export all M0 framework symbols from `src/framework/contributions/index.ts`.

**Validation:**

- Run (red): `mise exec -- nsh test src/framework/contributions/chain.test.ts --filter "chain:"` — fails on missing module.
- Run (green): `mise exec -- nsh test src/framework/contributions/chain.test.ts --filter "chain:"` — all chain cases pass.

#### Task 5: Unify AI module setup through the contribution registry

**Seam:** `initializeContributions()` plus unified `aiRegistry` / `providerSettingsRegistry`.

**Outcome:** Protocols, providers, and presentations register into one `ContributionRegistry` instance; `aiRegistry` and `providerSettingsRegistry` act as thin views over that registry with no duplicate `Map` state.

**Files:**

- Create: `src/contributions/ai/index.ts`, `src/app/contributions-setup.ts`.
- Modify: `src/modules/ai/runtime/registry.ts`, `src/modules/ai/ui/registry.ts`, `src/app/ai-setup.ts`, `App.tsx`.
- Test: `src/app/ai-setup.test.ts`, `src/modules/ai/runtime/registry.test.ts`, `src/modules/ai/ui/registry.test.ts`, `App.test.tsx`.

**Steps:**

- [ ] **Red:** In `src/app/ai-setup.test.ts`, add a case titled `ai setup: registers built-in protocols, providers, and presentations in a fresh registry` expecting `registerAiContributions(freshRegistry)` to populate the 4 protocols, 5 providers, and 5 presentations with `freshRegistry.diagnostics()` returning `[]`, and keep the existing idempotent `initializeAiModules()` test passing.
- [ ] **Green:** Implement `registerAiContributions(registry)` in `src/contributions/ai/index.ts`, make `aiRegistry` and `providerSettingsRegistry` delegate to `getContributionRegistry()` (while preserving `createAiRegistry()` and `createProviderSettingsRegistry()` for isolated unit tests), create `src/app/contributions-setup.ts`, make `initializeAiModules()` delegate to it, and update `App.tsx` to call `initializeContributions()`. Check `diagnostics()` during startup setup and throw if an inconsistency exists.

**Validation:**

- Run (red): `mise exec -- nsh test src/app/ai-setup.test.ts --filter "ai setup:"` — fails until `src/contributions/ai/index.ts` and `contributions-setup.ts` exist.
- Run (green): `mise exec -- nsh test src/app/ai-setup.test.ts --filter "ai setup:"`, `mise exec -- nsh test src/modules/ai/runtime/registry.test.ts --filter "ai registry:"`, `mise exec -- nsh test src/modules/ai/ui/registry.test.ts`, and `mise exec -- nsh test App.test.tsx` — all pass.

---

### Milestone 1: Shared Settings Host (`CapabilitySection`) & TTS Migration

#### Task 6: Show, add, enable, and reorder channels in `CapabilitySection`

**Seam:** `CapabilitySection` list state and add dialog.

**Outcome:** One host component renders the empty state, priority list with primary/backup badges and enable switches, add dialog, and measured-slot drag plus keyboard reorder.

**Files:**

- Create: `src/features/settings/capability-section.tsx`, `src/features/settings/capability-section-add-dialog.tsx`.
- Modify: `locales/en.yml`, `locales/zh-CN.yml`.
- Test: `src/features/settings/__tests__/capability-section-app.tsx`, `src/features/settings/capability-section.test.tsx`.

**Steps:**

- [ ] **Red:** In `src/features/settings/capability-section.test.tsx` (cases titled `capability section: ...`), mount the test harness with an empty fake collection and `testIdPrefix="settings-test"`. Expect the empty state, add button, and add dialog listing both fake channels; add one and expect a row (`id:settings-test-row-alpha`) whose order persists to storage.
- [ ] **Red:** Add both channels; expect `drag("id:settings-test-row-beta", { x: 0, y: -80 })` and `ArrowUp` / `ArrowDown` on the grip to reorder, persist `order()`, and preserve keyboard focus on the moved grip. Expect a skipped unknown channel in storage to render the localized skipped-count notice.
- [ ] **Green:** Implement `CapabilitySection` and `CapabilitySectionAddDialog`, porting the measured-slot drag algorithm and keyboard handler from `tts-section.tsx` parameterized by `testIdPrefix` (`${testIdPrefix}-row-${id}`, `${testIdPrefix}-add`, etc.). Props: `capability`, `testIdPrefix`, `registry`, `collection`, `labels { titleKey, addKey, emptyKey, priorityHintKey? }`, `compact`, `selected`, `onSelect`, `extra?`, `hostServices`, `getAddButtonRef?`, `onRegisterAddTrigger?`, `onAddBusyChange?`, `onDialogOpenChange?`. Add i18n keys for skipped-count notice and plaintext storage notice in `locales/en.yml` and `locales/zh-CN.yml`.

**Validation:**

- Run (red): `mise exec -- nsh test src/features/settings/capability-section.test.tsx --filter "capability section:"` — fails on missing component.
- Run (green): `mise exec -- nsh test src/features/settings/capability-section.test.tsx --filter "capability section:"` — list, add, skipped-count, and reorder cases pass.

#### Task 7: Open, edit, save, and remove one channel in `CapabilitySection`

**Seam:** `CapabilitySection` detail state.

**Outcome:** Opening a configurable row renders the contribution's `Settings` with host-owned config and credential drafts; non-configurable rows (`configurable: false`) remain static in the list; save persists config and credentials cleanly; delete asks first and recovers on write failure.

**Files:**

- Modify: `src/features/settings/capability-section.tsx`, `src/features/settings/__tests__/capability-section-app.tsx`.
- Test: `src/features/settings/capability-section.test.tsx`.

**Steps:**

- [ ] **Red:** In `src/features/settings/capability-section.test.tsx` (cases titled `capability detail: ...`), open a configurable channel. Expect the contribution `Settings` to render, edits to update draft state only, save to validate via `contribution.validate`, persist config and vault credential, and keep secrets out of `integrations.*.v1` storage.
- [ ] **Red:** Expect an unreadable credential to show the alert banner and block enabling, a failed save to retain the draft and display the error, remove to require confirmation and clear the credential ref, and a `configurable: false` channel row not to open a detail pane.
- [ ] **Green:** Implement the detail shell (avatar, heading, credential-missing alert, save button, remove confirmation dialog, error line, plaintext storage notice), `ChannelSettingsHost` construction (`onDialogOpenChange`, `readSavedCredential`, optional model/audio hooks), and `CredentialInput` state (`keep` / `replace` / `clear`).

**Validation:**

- Run (red): `mise exec -- nsh test src/features/settings/capability-section.test.tsx --filter "capability detail:"` — fails on missing detail behavior.
- Run (green): `mise exec -- nsh test src/features/settings/capability-section.test.tsx --filter "capability detail:"` — all detail cases pass.

#### Task 8: Express TTS channels as contributions

**Seam:** `ttsChannelContributions`.

**Outcome:** Google Cloud and Azure TTS channels each implement `CapabilityChannelContribution` (`parse`, `validate`, `describe`, `prepare`, `signature`, `readiness`, `execute`, `failureKey`, and controlled `Settings`); vendor code and unit tests move to `src/contributions/tts/vendor/`.

**Files:**

- Move: `src/features/tts/{google-cloud,azure-speech,google-voices,google-preferences,google-samples,azure-voices,azure-regions}.ts` and `src/features/tts/{google-cloud,azure-speech,google-voices}.test.ts` to `src/contributions/tts/vendor/`.
- Create: `src/contributions/tts/channels/google-cloud.tsx`, `src/contributions/tts/channels/azure.tsx`, `src/contributions/tts/index.ts`.
- Delete: `src/features/settings/google-tts-fields.tsx` (moved into `src/contributions/tts/channels/google-cloud.tsx`, exporting any helper needed by tests or keeping `googleFamilyPricingLines` exported from `src/contributions/tts/channels/google-cloud.tsx` / `vendor/google-voices.ts`).
- Test: `src/contributions/tts/channels/channels.test.ts`, plus moved vendor tests.

**Steps:**

- [ ] **Red:** In `src/contributions/tts/channels/channels.test.ts` (cases titled `tts contribution: ...`), expect each contribution's `parse` to reject malformed stored config, `describe` to format the voice preference or Azure region, `prepare` to resolve voice/audio options and reject over-limit text or Azure illegal XML, `signature` to reflect channel-specific cache identity, `execute` to invoke the vendor client with `host.credential` and `host.fetchImpl`, and `failureKey` to map every vendor failure code.
- [ ] **Green:** Move the TTS vendor files and vendor tests (updating imports to `src/framework/languages`), implement `google-cloud.tsx` and `azure.tsx` (including controlled sample playback via `host.audio` and `host.readSavedCredential`, and `GoogleOverrideDialog` notifying `host.onDialogOpenChange`), export `ttsChannelContributions` from `src/contributions/tts/index.ts`, and register them in `src/app/contributions-setup.ts`.

**Validation:**

- Run (red): `mise exec -- nsh test src/contributions/tts/channels/channels.test.ts --filter "tts contribution:"` — fails before files exist.
- Run (green):
  - `mise exec -- nsh test src/contributions/tts/channels/channels.test.ts --filter "tts contribution:"`
  - `mise exec -- nsh test src/contributions/tts/vendor/google-cloud.test.ts --filter "google cloud tts:"`
  - `mise exec -- nsh test src/contributions/tts/vendor/azure-speech.test.ts --filter "azure speech tts:"`
  - `mise exec -- nsh test src/contributions/tts/vendor/google-voices.test.ts --filter "google voices:"`

#### Task 9: Move the TTS store and runtime onto the framework

**Seam:** `ttsChannels` collection and `prepareQuickSpeech` / `synthesizeSpeech` dispatch.

**Outcome:** TTS persists under `integrations.tts.v1` and vault namespace `secret.tts`; `channels.ts`, `quick-speech.ts`, and `popup.tsx` use the registry and contribution hooks (`prepare`, `signature`, `execute`, `failureKey`) with zero `if (channel === "azure")` branches in feature code.

**Files:**

- Create: `src/features/tts/store.ts`.
- Modify: `src/features/tts/channels.ts`, `src/features/tts/quick-speech.ts`, `src/features/tts/synthesis.ts`, `src/features/quick-translate/popup.tsx`, `src/features/quick-translate/__tests__/popup-harness.tsx`, `src/app/__tests__/quick-translate-harness.tsx`, `App.tsx`, `src/services/log.test.ts`.
- Delete: `src/features/tts/settings.ts`.
- Test: `src/features/tts/settings.test.ts`, `src/features/tts/quick-speech.test.ts`, `src/features/quick-translate/popup.test.tsx`.

**Steps:**

- [ ] **Red:** Rewrite `src/features/tts/settings.test.ts` (cases titled `tts store: ...`) to test the `integrations.tts.v1` collection: empty load, add disabled, save with `enableOnFirstSave: false`, `setEnabled(true)` requiring a readable vault record, reorder, and remove clearing the vault entry.
- [ ] **Red:** Update `src/features/tts/quick-speech.test.ts` and `src/features/quick-translate/popup.test.tsx` to seed `integrations.tts.v1` + `secret.tts.*` and expect `prepareQuickSpeech` and popup playback to work through contribution `prepare` and `signature`.
- [ ] **Green:** Implement `src/features/tts/store.ts`, update `channels.ts`, `quick-speech.ts`, `popup.tsx`, harnesses, `App.tsx`, and `log.test.ts` (if log scope strings change), and delete `src/features/tts/settings.ts`.

**Validation:**

- Run (red): `mise exec -- nsh test src/features/tts/settings.test.ts --filter "tts store:"` — fails before the new store exists.
- Run (green):
  - `mise exec -- nsh test src/features/tts/settings.test.ts --filter "tts store:"`
  - `mise exec -- nsh test src/features/tts/quick-speech.test.ts --filter "quick speech:"`
  - `mise exec -- nsh test src/features/quick-translate/popup.test.tsx`

#### Task 10: Replace the TTS settings section

**Seam:** Settings -> Integrations -> Text-to-Speech via `CapabilitySection`.

**Outcome:** The TTS settings section renders through `CapabilitySection` with `testIdPrefix="settings-tts"`; the 1202-line `tts-section.tsx` is deleted.

**Files:**

- Modify: `src/features/settings/page.tsx`, `src/features/settings/settings.test.tsx`.
- Delete: `src/features/settings/tts-section.tsx`.

**Steps:**

- [ ] **Red:** In `src/features/settings/settings.test.tsx`, update TTS storage fixtures to `integrations.tts.v1` / `secret.tts.*`, expect `id:settings-capability-tts` to render when opening Text-to-Speech, and keep existing `tts settings:`, `tts google:`, `tts preview:`, and `tts storage:` test titles and `settings-tts-*` testIDs.
- [ ] **Green:** Mount `<CapabilitySection capability="tts" testIdPrefix="settings-tts" ... />` in `src/features/settings/page.tsx`, pass `selectedChannel` signal and audio host services, and delete `src/features/settings/tts-section.tsx`.

**Validation:**

- Run (red/green): `mise exec -- nsh test src/features/settings/settings.test.tsx --filter "tts "` — red before swap, green after.
- Run: `mise exec -- nsh test src/app/quick-translate.test.tsx --filter "quick tts:"` — quick-translate TTS cases pass after updating storage fixtures in `quick-translate.test.tsx`.

---

### Milestone 2: OCR & Language Detection Migrations

#### Task 11: Express OCR channels as contributions

**Seam:** `ocrChannelContributions`.

**Outcome:** AI, Baidu, and Google Cloud Vision OCR channels each implement `CapabilityChannelContribution`; vendor clients and their tests move to `src/contributions/ocr/vendor/`.

**Files:**

- Move: `src/features/ocr/{baidu,google-cloud}.ts` and `src/features/ocr/{baidu,google-cloud}.test.ts` to `src/contributions/ocr/vendor/`.
- Create: `src/contributions/ocr/channels/{ai,baidu,google-cloud}.tsx` (or `.ts` if no JSX), `src/contributions/ocr/index.ts`.
- Test: `src/contributions/ocr/channels/channels.test.ts`, plus moved vendor tests.

**Steps:**

- [ ] **Red:** In `src/contributions/ocr/channels/channels.test.ts` (cases titled `ocr contribution: ...`), expect Baidu `parse` to reject unknown operations, `validate` to require `apiKey` and `secretKey`, `readiness` to report unready when credentials are missing, AI `readiness` and `execute` to delegate to `host.models.resolveSaved(modelId, "image")` and `host.models.generateTextFromImage`, and `failureKey` to map all vendor failure codes.
- [ ] **Green:** Move the OCR vendor files and tests, implement the three OCR contributions (using `host.modelChoices` / `host.resolveModelBinding` / `host.onManageModels` in the AI channel's `Settings`), export `ocrChannelContributions` from `src/contributions/ocr/index.ts`, and register them in `src/app/contributions-setup.ts`.

**Validation:**

- Run (red): `mise exec -- nsh test src/contributions/ocr/channels/channels.test.ts --filter "ocr contribution:"` — fails before files exist.
- Run (green):
  - `mise exec -- nsh test src/contributions/ocr/channels/channels.test.ts --filter "ocr contribution:"`
  - `mise exec -- nsh test src/contributions/ocr/vendor/baidu.test.ts --filter "baidu ocr:"`
  - `mise exec -- nsh test src/contributions/ocr/vendor/google-cloud.test.ts --filter "google cloud ocr:"`

#### Task 12: Run OCR through `ChannelCollection` and `runChain`

**Seam:** `ocrChannels` collection, `checkOcrReadiness()`, and `recognizeScreenshot()`.

**Outcome:** OCR persists under `integrations.ocr.v1` and vault namespace `secret.ocr` with `enableOnFirstSave: true`; `recognize.ts` validates the PNG once and executes enabled channels through `runChain` with zero channel-specific branches.

**Files:**

- Create: `src/features/ocr/store.ts`.
- Modify: `src/features/ocr/recognize.ts`, `src/app/quick-translate-controller.ts`, `src/app/__tests__/quick-translate-harness.tsx`, `App.tsx`, `src/services/log.test.ts`.
- Delete: `src/features/ocr/settings.ts`.
- Test: `src/features/ocr/settings.test.ts`, `src/features/ocr/recognize.test.ts`.

**Steps:**

- [ ] **Red:** Rewrite `src/features/ocr/settings.test.ts` (cases titled `ocr store: ...`) to test `integrations.ocr.v1` and `secret.ocr.*` (including `enableOnFirstSave: true` and Baidu two-field credentials).
- [ ] **Red:** In `src/features/ocr/recognize.test.ts`, keep existing `ocr recognize:` tests and add a chain test with AI first (ineligible model) and Baidu second: expect Baidu to run and AI's unavailability not to override Baidu's success.
- [ ] **Green:** Implement `src/features/ocr/store.ts`, rewrite `checkOcrReadiness` and `recognizeScreenshot` using `runChain`, update `quick-translate-controller.ts`, `quick-translate-harness.tsx`, `App.tsx`, and `log.test.ts`, and delete `src/features/ocr/settings.ts`.

**Validation:**

- Run (red): `mise exec -- nsh test src/features/ocr/settings.test.ts --filter "ocr store:"` — fails before new store exists.
- Run (green):
  - `mise exec -- nsh test src/features/ocr/settings.test.ts --filter "ocr store:"`
  - `mise exec -- nsh test src/features/ocr/recognize.test.ts --filter "ocr recognize:"`

#### Task 13: Express detection channels as contributions and run through `runChain`

**Seam:** `detectChannelContributions`, `detectChannels`, `languageDetectionPreferences`, and `detectLanguage()`.

**Outcome:** AI, free Google, and Google Cloud v2 are contributions; free Google reports `configurable: false` and enables immediately on `add()`; detection preferences live in `settings.languageDetection.preferences.v1`; `detectLanguage()` runs through `runChain`.

**Files:**

- Create: `src/contributions/detect/vendor/google-free.ts`, `src/contributions/detect/channels/{ai,google,google-cloud}.tsx` (and `.ts` for `google.ts`), `src/contributions/detect/index.ts`.
- Create: `src/features/language-detection/store.ts`, `src/features/language-detection/preferences.ts`.
- Modify: `src/features/language-detection/detect.ts`, `src/features/language-detection/resolve.ts`, `src/features/quick-translate/session.ts`, `src/features/quick-translate/source-detection.ts`, `src/features/quick-translate/__tests__/popup-harness.tsx`, `src/app/__tests__/quick-translate-harness.tsx`, `App.tsx`.
- Delete: `src/features/language-detection/settings.ts`.
- Test: `src/contributions/detect/channels/channels.test.ts`, `src/features/language-detection/settings.test.ts`, `src/features/language-detection/detect.test.ts`, `src/features/quick-translate/source-detection.test.ts`.

**Steps:**

- [ ] **Red:** In `src/contributions/detect/channels/channels.test.ts` (cases titled `detect contribution: ...`), expect free Google to declare `configurable: false` and no `Settings`, and expect AI and Google Cloud contributions to validate, check readiness, and execute via `HostServices`.
- [ ] **Red:** Update `src/features/language-detection/settings.test.ts` (cases titled `detection settings: ...`) to test `integrations.detect.v1` + `settings.languageDetection.preferences.v1`, keeping preference validation (`preference_invalid`, `preferences_identical`), immediate enable for `google`, and `enableOnFirstSave: true`.
- [ ] **Green:** Implement the three detection contributions and register `detectChannelContributions` in `src/app/contributions-setup.ts`. Implement `store.ts` and `preferences.ts` exposing `snapshot()` and `preferences()`. Update `detect.ts` to keep `boundDetectionSample` and `parseDetectionAnswer` while delegating channel execution to `runChain`. Delete `src/features/language-detection/settings.ts`.

**Validation:**

- Run (red): `mise exec -- nsh test src/contributions/detect/channels/channels.test.ts --filter "detect contribution:"` — fails before files exist.
- Run (green):
  - `mise exec -- nsh test src/contributions/detect/channels/channels.test.ts --filter "detect contribution:"`
  - `mise exec -- nsh test src/features/language-detection/settings.test.ts --filter "detection settings:"`
  - `mise exec -- nsh test src/features/language-detection/detect.test.ts`
  - `mise exec -- nsh test src/features/quick-translate/source-detection.test.ts --filter "source detection:"`

#### Task 14: Replace the OCR and language-detection settings sections

**Seam:** Settings -> Integrations -> OCR and Language Detection via `CapabilitySection`.

**Outcome:** Both sections render through `CapabilitySection` (`testIdPrefix="settings-ocr"` and `testIdPrefix="settings-detection"`), `DetectionPreferencesCard` renders via `extra`, and both legacy section files are deleted.

**Files:**

- Create: `src/features/settings/detection-preferences-card.tsx`.
- Modify: `src/features/settings/page.tsx`, `src/features/settings/settings.test.tsx`, `src/features/quick-translate/popup.test.tsx`, `src/app/quick-translate.test.tsx`.
- Delete: `src/features/settings/ocr-section.tsx`, `src/features/settings/language-detection-section.tsx`.

**Steps:**

- [ ] **Red:** Update OCR and language-detection storage fixtures in `src/features/settings/settings.test.tsx`, `src/features/quick-translate/popup.test.tsx`, and `src/app/quick-translate.test.tsx` to `integrations.ocr.v1`, `integrations.detect.v1`, `settings.languageDetection.preferences.v1`, and `secret.*` keys. Keep existing `ocr settings:` and `language detection:` test titles and `settings-ocr-*` / `settings-detection-*` testIDs.
- [ ] **Green:** Extract `DetectionPreferencesCard` into `src/features/settings/detection-preferences-card.tsx`, mount `<CapabilitySection>` for both sections in `src/features/settings/page.tsx` (sharing one `selectedChannel` signal and header breadcrumb helper), and delete `ocr-section.tsx` and `language-detection-section.tsx`.

**Validation:**

- Run: `mise exec -- nsh test src/features/settings/settings.test.tsx --filter "ocr settings:"` — passes.
- Run: `mise exec -- nsh test src/features/settings/settings.test.tsx --filter "language detection:"` — passes.
- Run: `mise exec -- nsh test src/app/quick-translate.test.tsx --filter "quick ocr:"` — passes.
- Run: `mise exec -- nsh test src/features/quick-translate/popup.test.tsx` — passes.

---

## Final Validation

- Run: `mise run verify` — formatting, lint, type checks, Rust + headless tests, and release build pass.
- Run: `mise exec -- nsh test src/features/settings/settings.test.tsx --target windows --filter "settings"` — the settings page works in a desktop window.
- Run: `mise exec -- nsh test src/app/quick-translate.test.tsx --target windows --filter "quick"` — Quick Translate works with the new collection stores. (Run explicitly because `.mise/tasks/test-desktop` currently omits the `src/` prefix for desktop globbing.)
- Manual: open Settings -> Integrations for TTS, OCR, and Language Detection; confirm priority badges, drag/keyboard reorder, add dialog, save, remove, non-configurable free Google row, and unreadable-credential alerts behave as expected.

---

## Failure Behavior

- A stored channel whose contribution is missing is skipped, counted, and left untouched on disk; `CapabilitySection` shows the skipped count instead of failing to load.
- A malformed stored record fails the domain load, surfaces one error in the section, and does not overwrite the record.
- A credential read failure marks the channel unreadable, blocks enabling it, and never logs the secret.
- A duplicate or invalid contribution id, or failed startup `diagnostics()`, throws during startup assembly (`src/app/contributions-setup.ts`), which `App.tsx` surfaces through `StartupError`.
- A channel save failure keeps the draft and reports the localized error in the detail pane.

---

## Privacy and Security

- Secrets stay out of config records, logs, and test assertions; they live only under the vault namespace (`secret.tts.*`, `secret.ocr.*`, `secret.detect.*`).
- NSH `Storage` is plaintext with a 5 MB cap. The framework does not add encryption; `CapabilitySection` surfaces the plaintext storage notice in its credential detail view.
- Contributions receive credentials through `HostServices.credential` only for the duration of one call and cannot read other channels' refs.
- Compile-time contributions are trusted code. A future runtime loader must enforce a host allowlist and scoped credential handles; keeping `src/framework/` free of feature and app imports prepares for that boundary.

---

## Rollout Notes

- Milestones ship independently: M0 (Tasks 1–5) establishes contracts and AI registry unification with zero behavior change; M1 (Tasks 6–10) delivers `CapabilitySection` and TTS; M2 (Tasks 11–14) completes OCR and Language Detection.
- Storage uses breaking Demo-stage keys (`integrations.tts.v1`, `integrations.ocr.v1`, `integrations.detect.v1`, `settings.languageDetection.preferences.v1`). Old store singletons and section files are deleted in the same task that finishes switching all consumers.

---

## Risks and Mitigations

- **Host parity drift** — the three legacy sections total 3634 lines of interaction detail. Mitigation: keep existing `testID` prefixes (`settings-tts`, `settings-ocr`, `settings-detection`) and test titles, write `CapabilitySection` parity tests in Tasks 6–7, and migrate TTS first as the reference.
- **Recursive abstraction** — `CapabilitySection` starts encoding domain-specific branches. Mitigation: restrict customization to `ContributionMeta`, `ConfigSchema`, `extra`, `ChannelSettingsHost`, and contribution `Settings`.
- **Test churn** — `settings.test.tsx` and `quick-translate.test.tsx` are large. Mitigation: update fixtures domain by domain inside each migration task rather than rewriting whole test files.

---

## Follow-up Plans

These three axes were reviewed and deferred from this plan to keep M0–M2 focused:

1. **M3 — Preset engines (`PresetEngineContribution`)**:
   - Move `src/features/presets/models-section.tsx` and `prompt-templates.tsx` into `src/components/preset/`.
   - **Audit requirement:** Also move `src/features/presets/deepl-usage.ts` and `deepl-usage-section.tsx` out of `src/features/presets/` (currently coupled to `presetsStore`) into `src/contributions/presets/`, injecting credential lookup through `EngineSettingsProps` / host services.
2. **M4 — AI protocol request parameters (`RequestParamSpec`)**:
   - **Audit requirement:** Do not hardcode only `model`/`messages`/`Authorization` as protected fields; each protocol must protect its own core headers and body keys (`x-api-key`, `anthropic-version`, `x-goog-api-key`, `input`, `instructions`, etc.).
   - **Audit requirement:** Explicitly specify whether `listModels` and `generateTextFromImage` forward `params`, update `ProtocolDefinition` signatures, and include `resolveSavedModelRequest` in `src/features/models/store.ts`, `src/features/models/types.ts`, and `src/features/models/channel-draft.ts`.
3. **M5 — Wordbook (`WordbookContribution`)**:
   - **Audit requirement:** Defer until a second wordbook destination is scheduled (per architecture criterion). When implemented, do not force the single-card Anki discovery/mapping workflow (`wordbook-section.tsx`) into `CapabilitySection` unless `DESIGN.md` explicitly moves Wordbook to a multi-destination priority list.
