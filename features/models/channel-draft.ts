import { signal } from "nsh";
import {
  getProviderPreset,
  getProviderPresetLabel,
  type ProviderPresetId,
} from "../../services/protocols/presets";
import type { AdapterId } from "../../services/protocols/types";
import { inspectBaseUrl } from "./connection";
import type { ProviderModel } from "./types";

/** Page-owned transient state for creating a new provider channel before first save. */
export interface ChannelDraft {
  readonly id: string;
  readonly presetId: ProviderPresetId;
  displayName: () => string;
  setDisplayName: (value: string) => void;
  adapterId: () => AdapterId;
  setAdapterId: (value: AdapterId) => void;
  baseUrl: () => string;
  setBaseUrl: (value: string) => void;
  credential: () => string;
  setCredential: (value: string) => void;
  allowInsecureHttp: () => boolean;
  setAllowInsecureHttp: (value: boolean) => void;
  enabled: () => boolean;
  setEnabled: (value: boolean) => void;
  models: () => ProviderModel[];
}

/** Allocates a fresh in-memory channel draft prefilled from the chosen preset. */
export function createChannelDraft(presetId: ProviderPresetId): ChannelDraft {
  const preset = getProviderPreset(presetId);
  const id = crypto.randomUUID();
  const displayName = signal(getProviderPresetLabel(presetId));
  const adapterId = signal<AdapterId>(preset.defaultAdapterId);
  const baseUrl = signal(preset.defaultBaseUrl ?? "");
  const credential = signal("");
  const allowInsecureHttp = signal(false);
  const enabled = signal(true);
  const models = signal<ProviderModel[]>([]);

  return {
    id,
    presetId,
    displayName: () => displayName(),
    setDisplayName: (value) => displayName.set(value),
    adapterId: () => adapterId(),
    setAdapterId: (value) => adapterId.set(value),
    baseUrl: () => baseUrl(),
    setBaseUrl: (value) => {
      baseUrl.set(value);
      if (!inspectBaseUrl(value).isInsecureHttp) {
        allowInsecureHttp.set(false);
      }
    },
    credential: () => credential(),
    setCredential: (value) => credential.set(value),
    allowInsecureHttp: () => allowInsecureHttp(),
    setAllowInsecureHttp: (value) => allowInsecureHttp.set(value),
    enabled: () => enabled(),
    setEnabled: (value) => enabled.set(value),
    models: () => models(),
  };
}
