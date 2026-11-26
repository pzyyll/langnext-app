// ABOUTME: Pure contribution contracts shared by framework facilities, contributions, and features.
// ABOUTME: Framework code stays free of feature and app imports, so a runtime loader can reuse it.
import type { ImageAsset, JSX } from "nsh";
import type { FetchLike } from "../../services/http";
import type { Logger } from "../../services/log";

/** The four contribution axes the app assembles at startup. */
export type ContributionAxis = "protocol" | "provider" | "provider-presentation" | "capability";

/** Capability domains that render through one shared settings host. */
export type CapabilityId = "tts" | "ocr" | "detect";

/** Which saved-model purpose a capability asks for. */
export type ModelPurpose = "text" | "image";

/** Identity every contribution carries into lists and detail views. */
export interface ContributionMeta {
  id: string;
  labelKey: string;
  icon: ImageAsset;
  /** Defaults to `monochrome`; `brand` keeps the asset's own colors. */
  iconTone?: "brand" | "monochrome";
}

/** Parses one stored or drafted configuration value and supplies the channel defaults. */
export interface ConfigSchema<C> {
  parse(raw: unknown): C | null;
  defaults(): C;
}

/** One credential input a contribution renders and stores in the vault. */
export interface CredentialField {
  key: string;
  labelKey: string;
  masked: boolean;
}

/** A channel's credential values; it never enters the configuration record or a log. */
export type CredentialRecord = Readonly<Record<string, string>>;

/** One channel as the host and a contribution see it. */
export interface ChannelBinding<C = unknown> {
  enabled: boolean;
  configured: boolean;
  config: C;
  credentialRef: string | null;
}

/** One saved model the host offers to a channel's Settings component. */
export interface ModelChoiceOption {
  id: string;
  channelId: string;
  modelKey: string;
  label: string;
}

/** Whether a saved model can serve a purpose, with its label and reason when it cannot. */
export type ModelBindingStatus =
  | { ok: true; label: string }
  | { ok: false; reason: string; label?: string };

/** The protocol route plus transient credential a model call runs with. */
export interface ModelConnectionRoute {
  providerTypeId: string;
  protocolId: string;
  baseUrl: string | null;
  credential: string | null;
}

/** A saved model resolved to a callable route, or the reason it is unavailable. */
export type ResolvedModelRoute =
  | { ok: true; modelId: string; modelKey: string; connection: ModelConnectionRoute }
  | { ok: false; reason: string };

/** Text request a capability sends through a saved model. */
export interface HostTextRequest {
  modelId: string;
  system: string;
  user: string;
  disableReasoning?: boolean;
}

/** Image request a capability sends through a saved model. */
export interface HostImageRequest {
  modelId: string;
  system: string;
  user: string;
  image: { mimeType: "image/png"; base64: string };
}

/** One call's cancellation and timeout policy. */
export interface HostCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** AI access a capability contribution receives for one call. */
export interface HostModels {
  resolveSaved(modelId: string, purpose: ModelPurpose): Promise<ResolvedModelRoute>;
  generateText(
    connection: ModelConnectionRoute,
    request: HostTextRequest,
    options?: HostCallOptions,
  ): Promise<string>;
  generateTextFromImage(
    connection: ModelConnectionRoute,
    request: HostImageRequest,
    options?: HostCallOptions,
  ): Promise<string>;
}

/** Audio playback a channel uses for its settings sample. */
export interface ChannelAudioHost {
  canPlay(): Promise<boolean>;
  playMp3(
    bytes: Uint8Array,
    hooks?: { onPlaying?: () => void },
  ): { stop(): void; result: Promise<{ status: "ended" | "stopped" | "failed" }> };
}

/** Host-owned controls a contribution's Settings component may use. */
export interface ChannelSettingsHost {
  /** Reports whether a sample preview holds playback; the host locks editing and Save. */
  onPreviewBusyChange?: (busy: boolean) => void;
  modelChoices?: () => readonly ModelChoiceOption[];
  resolveModelBinding?: (modelId: string, purpose: ModelPurpose) => ModelBindingStatus;
  onManageModels?: () => void;
  onDialogOpenChange: (open: boolean) => void;
  readSavedCredential(): Promise<CredentialRecord | null>;
  audio?: ChannelAudioHost;
}

/** Controlled values a contribution's Settings component renders and reports. */
export interface ChannelSettingsProps<C = unknown> {
  /** The draft the user is editing. */
  binding: ChannelBinding<C>;
  /** The saved binding, for rules that compare a draft with what is stored. */
  savedBinding: ChannelBinding<C>;
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

/** Resolvers a list summary may use without importing feature state. */
export interface ChannelDescribeHost {
  resolveModelBinding?: (modelId: string, purpose: ModelPurpose) => ModelBindingStatus;
}

/** Values one Save-availability check sees before the host writes anything. */
export interface ChannelSaveDraft<C = unknown> {
  config: C;
  credentialDraft: CredentialRecord;
  savedBinding: ChannelBinding<C>;
  /** Whether the saved credential record can be read; false when there is no saved reference. */
  credentialReadable: boolean;
  resolveModelBinding?: (modelId: string, purpose: ModelPurpose) => ModelBindingStatus;
}

/** Everything one capability call receives: its credential plus host services. */
export interface HostServices {
  /** Credential read for this single channel call; never exposes other channel refs. */
  credential: CredentialRecord | null;
  models: HostModels;
  fetchImpl?: FetchLike;
  log: Logger;
}

/** Whether a configured channel can run now, and why not when it cannot. */
export type Readiness = { ready: true } | { ready: false; reason: string };

/** A configuration or credential validation result. */
export type ValidationResult = { ok: true } | { ok: false; key: string; field?: string };

/** A request the contribution prepared, or the reason it cannot run. */
export type PrepareResult<In> = { ok: true; input: In } | { ok: false; message: string };

/** A store action result with a localization key and its resolved message. */
export type Result = { ok: true } | { ok: false; key: string; message: string };

/** What a save does with the channel's stored credential. */
export type CredentialInput =
  | { mode: "keep" }
  | { mode: "replace"; value: CredentialRecord }
  | { mode: "clear" };

/** One capability channel: metadata, configuration, runtime hooks, and optional Settings. */
export interface CapabilityChannelContribution<
  C = unknown,
  In = unknown,
  Out = unknown,
> extends ContributionMeta {
  capability: CapabilityId;
  configurable: boolean;
  config: ConfigSchema<C>;
  credential: readonly CredentialField[] | null;
  /** Existing recovery message for an unreadable saved credential; the host renders it once. */
  credentialUnreadableKey?: string;
  describe(binding: ChannelBinding<C>, host?: ChannelDescribeHost): string;
  signature?(binding: ChannelBinding<C>): string;
  validate?(draft: {
    config: C;
    credentialDraft: CredentialRecord;
    savedCredential: boolean;
  }): ValidationResult;
  /** Whether the current draft may be submitted; the host disables Save and guards the write. */
  saveAvailable?(draft: ChannelSaveDraft<C>): boolean;
  prepare?(binding: ChannelBinding<C>, input: In): PrepareResult<In>;
  readiness(binding: ChannelBinding<C>, host: HostServices): Promise<Readiness>;
  execute(binding: ChannelBinding<C>, input: In, host: HostServices): Promise<Out>;
  failureKey(failure: string): string | null;
  Settings?: (props: ChannelSettingsProps<C>) => JSX.Element;
}
