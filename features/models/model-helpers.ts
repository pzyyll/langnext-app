import { t } from "nsh/i18n";
import { getAdapterLabel } from "../../services/protocols/adapters";
import type { AdapterId } from "../../services/protocols/types";
import type { CapabilityFlags, ProviderModel } from "./types";

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

/** Formats the API Type column relative to the owning channel adapter. */
export function formatModelApiTypeDisplay(
  model: ProviderModel,
  providerAdapterId: AdapterId,
): string {
  if (model.apiTypeOverride) {
    return getAdapterLabel(model.apiTypeOverride);
  }
  if (model.sourceAdapterId !== providerAdapterId) {
    return t("models.api.source", { name: getAdapterLabel(model.sourceAdapterId) });
  }
  return t("models.api.default");
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
