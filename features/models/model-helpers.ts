import { t } from "nsh/i18n";
import type { ProviderTypeId } from "../../modules/ai/contracts/channel";
import type { CapabilityFlags, ProviderModel } from "../../modules/ai/contracts/model";
import type { ProtocolId } from "../../modules/ai/contracts/protocol";
import { aiRegistry } from "../../modules/ai/runtime/registry";

export const MODEL_DEFAULT_API_VALUE = "__default__";

/** Resolves a translated protocol label, tolerating a reference this build lacks. */
export function getProtocolLabel(protocolId: ProtocolId): string {
  try {
    return t(aiRegistry.getProtocol(protocolId).labelKey);
  } catch {
    return protocolId;
  }
}

/** Builds the ordered API selector choices for manual model add and edit dialogs. */
export function getModelApiTypeItems(
  presetId: ProviderTypeId,
  currentValue?: string | null,
): Array<{ value: string; title: string }> {
  const provider = aiRegistry.getProvider(presetId);
  const items = [
    { value: MODEL_DEFAULT_API_VALUE, title: t("models.model.useChannelDefault") },
    ...provider.allowedProtocolIds.map((id) => ({
      value: id,
      title: getProtocolLabel(id),
    })),
  ];
  if (
    currentValue &&
    currentValue !== MODEL_DEFAULT_API_VALUE &&
    !provider.allowedProtocolIds.includes(currentValue)
  ) {
    // Keep an unsupported stored override visible so the user can replace it.
    items.push({ value: currentValue, title: getProtocolLabel(currentValue) });
  }
  return items;
}

/** Resolves the label shown for a model in tables and summaries. */
export function resolveEffectiveDisplayName(model: ProviderModel): string {
  const overrideName = model.displayNameOverride?.trim();
  if (overrideName) return overrideName;
  const remoteName = model.displayName?.trim();
  if (remoteName) return remoteName;
  return model.modelKey;
}

/** Merges protocol defaults with per-model capability overrides. */
export function resolveEffectiveCapabilities(model: ProviderModel): CapabilityFlags {
  const overrides = model.capabilitiesOverride;
  return {
    text: overrides?.text ?? model.capabilities.text,
    image: overrides?.image ?? model.capabilities.image,
    pdf: overrides?.pdf ?? model.capabilities.pdf,
    video: overrides?.video ?? model.capabilities.video,
  };
}

/** Resolves the effective API protocol for a model from its override or channel default. */
export function resolveEffectiveApiType(
  model: Pick<ProviderModel, "apiTypeOverride">,
  channelDefaultAdapterId: ProtocolId,
): ProtocolId {
  return model.apiTypeOverride ?? channelDefaultAdapterId;
}

/** Formats the API Type column relative to the owning channel adapter. */
export function formatModelApiTypeDisplay(
  model: ProviderModel,
  providerAdapterId: ProtocolId,
): string {
  const effectiveApi = resolveEffectiveApiType(model, providerAdapterId);
  if (model.apiTypeOverride) {
    return getProtocolLabel(effectiveApi);
  }
  return t("models.api.default", { name: getProtocolLabel(effectiveApi) });
}

/** Formats an optional token count cleanly (e.g. `128K`, `1M`, `8192`). */
export function formatTokenCount(count: number | null): string | null {
  if (count === null || !Number.isFinite(count) || count <= 0) return null;
  if (count >= 1_000_000 && count % 1_000_000 === 0) {
    return `${count / 1_000_000}M`;
  }
  if (count >= 1_000 && count % 1_000 === 0) {
    return `${count / 1_000}K`;
  }
  return String(count);
}

/** Formats an ISO timestamp concisely for sync status labels. */
export function formatSyncTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}
