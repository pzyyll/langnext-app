import { t } from "nsh/i18n";
import type { ProviderChannel } from "../../modules/ai/contracts/channel";
import type { ProviderModel } from "../../modules/ai/contracts/model";
import { aiRegistry } from "../../modules/ai/runtime/registry";
import {
  resolveEffectiveApiType,
  resolveEffectiveCapabilities,
  resolveEffectiveDisplayName,
} from "../models/model-helpers";
import { modelsStore } from "../models/store";
import type { ModelChoice, TranslationPreset } from "./types";

export interface ModelBindingInfo {
  id: string;
  label: string;
  available: boolean;
  reason: string | null;
}

function isEffectiveProtocolSupported(channel: ProviderChannel, model: ProviderModel): boolean {
  try {
    const provider = aiRegistry.getProvider(channel.presetId);
    const effectiveProtocol = resolveEffectiveApiType(model, channel.adapterId);
    if (!provider.allowedProtocolIds.includes(effectiveProtocol)) {
      return false;
    }
    aiRegistry.getProtocol(effectiveProtocol);
    return true;
  } catch {
    return false;
  }
}

function formatChoiceLabel(channel: ProviderChannel, model: ProviderModel): string {
  return t("presets.model.choiceLabel", {
    channel: channel.displayName,
    model: resolveEffectiveDisplayName(model),
  });
}

/** Reads enabled, non-missing, text-capable, supported models from enabled channels. */
export function readAvailableModelChoices(): ModelChoice[] {
  if (modelsStore.channelsError() !== null) {
    return [];
  }

  const channels = modelsStore.channels();
  const models = modelsStore.models();
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));

  const choices: Array<{ sortOrder: number; choice: ModelChoice }> = [];

  for (const model of models) {
    if (!model.enabled || model.syncStatus === "missing") continue;
    const channel = channelById.get(model.providerId);
    if (!channel || !channel.enabled) continue;
    if (!resolveEffectiveCapabilities(model).text) continue;
    if (!isEffectiveProtocolSupported(channel, model)) continue;

    choices.push({
      sortOrder: channel.sortOrder,
      choice: {
        id: model.id,
        channelId: channel.id,
        modelKey: model.modelKey,
        label: formatChoiceLabel(channel, model),
      },
    });
  }

  choices.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return a.choice.label.localeCompare(b.choice.label);
  });

  return choices.map((entry) => entry.choice);
}

/** Resolves display label and unavailability reason for any bound model ID without exposing raw IDs. */
export function resolveModelBindingInfo(modelId: string): ModelBindingInfo {
  if (modelsStore.channelsError() !== null) {
    return {
      id: modelId,
      label: t("presets.model.unavailableLabel"),
      available: false,
      reason: t("presets.model.reasonCatalogLoadFailed"),
    };
  }

  const models = modelsStore.models();
  const model = models.find((entry) => entry.id === modelId);
  if (!model) {
    return {
      id: modelId,
      label: t("presets.model.removedLabel"),
      available: false,
      reason: t("presets.model.reasonDeleted"),
    };
  }

  const channel = modelsStore.channels().find((entry) => entry.id === model.providerId);
  if (!channel) {
    return {
      id: modelId,
      label: resolveEffectiveDisplayName(model),
      available: false,
      reason: t("presets.model.reasonDeleted"),
    };
  }

  const label = formatChoiceLabel(channel, model);

  if (!isEffectiveProtocolSupported(channel, model)) {
    return {
      id: modelId,
      label,
      available: false,
      reason: t("presets.model.reasonUnsupported"),
    };
  }
  if (!channel.enabled) {
    return {
      id: modelId,
      label,
      available: false,
      reason: t("presets.model.reasonChannelDisabled"),
    };
  }
  if (model.syncStatus === "missing") {
    return {
      id: modelId,
      label,
      available: false,
      reason: t("presets.model.reasonMissing"),
    };
  }
  if (!model.enabled) {
    return {
      id: modelId,
      label,
      available: false,
      reason: t("presets.model.reasonModelDisabled"),
    };
  }
  if (!resolveEffectiveCapabilities(model).text) {
    return {
      id: modelId,
      label,
      available: false,
      reason: t("presets.model.reasonNotTextCapable"),
    };
  }

  return {
    id: modelId,
    label,
    available: true,
    reason: null,
  };
}

/** Formats a concise rail summary for a preset's ordered model list. */
export function summarizePresetModels(modelIds: readonly string[]): string {
  if (modelIds.length === 0) {
    return t("presets.list.noModel");
  }
  const primary = resolveModelBindingInfo(modelIds[0]!).label;
  if (modelIds.length === 1) {
    return primary;
  }
  return t("presets.list.modelSummaryWithFallbacks", {
    primary,
    count: modelIds.length - 1,
  });
}

/** Formats a concise rail summary for any preset engine. */
export function summarizePreset(preset: Pick<TranslationPreset, "engine">): string {
  if (preset.engine.kind === "deepl") {
    return t("presets.engine.deepl");
  }
  return summarizePresetModels(preset.engine.modelIds);
}
