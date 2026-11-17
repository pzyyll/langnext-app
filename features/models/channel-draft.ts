import { signal } from "nsh";
import { t } from "nsh/i18n";
import {
  getProviderPreset,
  getProviderPresetLabel,
  type ProviderPresetId,
} from "../../services/protocols/presets";
import type { AdapterId } from "../../services/protocols/types";
import { inspectBaseUrl } from "./connection";
import type { CapabilityOverrides, ProviderModel } from "./types";

export interface AddModelDraftInput {
  modelKey: string;
  displayNameOverride: string | null;
  apiTypeOverride: AdapterId | null;
  enabled: boolean;
}

export interface UpdateModelDraftInput {
  id: string;
  displayNameOverride: string | null;
  apiTypeOverride: AdapterId | null;
  capabilitiesOverride: CapabilityOverrides | null;
  contextLimit: number | null;
  maxTokens: number | null;
}

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
  addManualModel: (input: AddModelDraftInput) => ProviderModel;
  updateModel: (input: UpdateModelDraftInput) => ProviderModel;
  setModelEnabled: (modelId: string, enabled: boolean) => void;
  deleteModels: (modelIds: string[]) => number;
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
    addManualModel: (input) => {
      const modelKey = input.modelKey.trim();
      if (!modelKey) {
        throw new Error(t("models.error.modelIdRequired"));
      }
      if (models().some((m) => m.modelKey === modelKey)) {
        throw new Error(t("models.error.modelDuplicate", { key: modelKey }));
      }
      const timestamp = new Date().toISOString();
      const created: ProviderModel = {
        id: crypto.randomUUID(),
        providerId: id,
        modelKey,
        sourceAdapterId: input.apiTypeOverride ?? adapterId(),
        origin: "manual",
        syncStatus: "active",
        enabled: input.enabled,
        displayName: null,
        displayNameOverride: input.displayNameOverride?.trim() || null,
        apiTypeOverride: input.apiTypeOverride,
        capabilities: { text: true, image: false, pdf: false, video: false },
        capabilitiesOverride: null,
        contextLimit: null,
        maxTokens: null,
        lastSeenAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      models.set([...models(), created]);
      return created;
    },
    updateModel: (input) => {
      const existing = models();
      const target = existing.find((m) => m.id === input.id);
      if (!target) {
        throw new Error(t("models.error.modelGone"));
      }
      const updated: ProviderModel = {
        ...target,
        displayNameOverride: input.displayNameOverride?.trim() || null,
        apiTypeOverride: input.apiTypeOverride,
        capabilitiesOverride: input.capabilitiesOverride,
        contextLimit: input.contextLimit,
        maxTokens: input.maxTokens,
        updatedAt: new Date().toISOString(),
      };
      models.set(existing.map((m) => (m.id === input.id ? updated : m)));
      return updated;
    },
    setModelEnabled: (modelId, nextEnabled) => {
      const timestamp = new Date().toISOString();
      models.set(
        models().map((m) =>
          m.id === modelId ? { ...m, enabled: nextEnabled, updatedAt: timestamp } : m,
        ),
      );
    },
    deleteModels: (modelIds) => {
      const idSet = new Set(modelIds);
      const prev = models();
      const next = prev.filter((m) => !idSet.has(m.id));
      models.set(next);
      return prev.length - next.length;
    },
  };
}
