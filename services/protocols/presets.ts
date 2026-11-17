import { t } from "nsh/i18n";
import type { AdapterId } from "./types";

/** Supported provider preset identifiers. */
export type ProviderPresetId = "openai" | "gemini" | "anthropic" | "deepseek" | "custom";

/** Icon asset identifier used by provider preset marks. */
export type ProviderPresetIcon = "openai" | "gemini" | "anthropic" | "deepseek" | "cube-outline";

/** Policy and default connection configuration for a provider preset. */
export interface ProviderPresetSpec {
  id: ProviderPresetId;
  labelKey: string;
  icon: ProviderPresetIcon;
  allowedAdapterIds: readonly AdapterId[];
  defaultAdapterId: AdapterId;
  defaultBaseUrl: string | null;
}

export const PROVIDER_PRESETS: readonly ProviderPresetSpec[] = [
  {
    id: "openai",
    labelKey: "models.preset.openai",
    icon: "openai",
    allowedAdapterIds: ["openai-compatible", "openai-responses"],
    defaultAdapterId: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    id: "gemini",
    labelKey: "models.preset.gemini",
    icon: "gemini",
    allowedAdapterIds: ["gemini"],
    defaultAdapterId: "gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
  },
  {
    id: "anthropic",
    labelKey: "models.preset.anthropic",
    icon: "anthropic",
    allowedAdapterIds: ["anthropic"],
    defaultAdapterId: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  {
    id: "deepseek",
    labelKey: "models.preset.deepseek",
    icon: "deepseek",
    allowedAdapterIds: ["openai-compatible", "openai-responses", "anthropic"],
    defaultAdapterId: "openai-compatible",
    defaultBaseUrl: "https://api.deepseek.com",
  },
  {
    id: "custom",
    labelKey: "models.preset.custom",
    icon: "cube-outline",
    allowedAdapterIds: ["openai-compatible", "openai-responses", "anthropic", "gemini"],
    defaultAdapterId: "openai-compatible",
    defaultBaseUrl: null,
  },
];

const PRESET_MAP = new Map<ProviderPresetId, ProviderPresetSpec>(
  PROVIDER_PRESETS.map((preset) => [preset.id, preset]),
);

/** Returns the preset specification for a provider preset ID. */
export function getProviderPreset(presetId: ProviderPresetId): ProviderPresetSpec {
  return PRESET_MAP.get(presetId) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]!;
}

/** Returns the localized display label for a provider preset. */
export function getProviderPresetLabel(presetId: ProviderPresetId): string {
  return t(getProviderPreset(presetId).labelKey);
}

/** Reports whether the protocol adapter is allowed by the given provider preset. */
export function isProtocolAllowedForPreset(
  presetId: ProviderPresetId,
  adapterId: AdapterId,
): boolean {
  return getProviderPreset(presetId).allowedAdapterIds.includes(adapterId);
}
