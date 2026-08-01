// ABOUTME: Pure presentation mapping for sanitized integration capability-health DTOs.
// ABOUTME: Converts absent, ready, and degraded rows into stable UI labels without provider content.
import type { CapabilityHealthDto } from "../../storage/types";

export type CapabilityHealthPresentationStatus = "ready" | "degraded" | "not_checked";

export interface CapabilityHealthPresentation {
  capabilityId: string;
  capabilityLabelKey: string;
  status: CapabilityHealthPresentationStatus;
  statusLabelKey: string;
  normalizedCode: string | null;
  checkedAt: string | null;
}

const CAPABILITY_LABEL_KEYS: Record<string, string> = {
  "translate.text@1": "plugins.capabilityHealth.capabilities.translate",
  "translate.detect@1": "plugins.capabilityHealth.capabilities.detect",
  "ocr.image@1": "plugins.capabilityHealth.capabilities.ocr",
  "speech.synthesize@1": "plugins.capabilityHealth.capabilities.tts",
};

const STATUS_LABEL_KEYS: Record<CapabilityHealthPresentationStatus, string> = {
  ready: "plugins.capabilityHealth.status.ready",
  degraded: "plugins.capabilityHealth.status.degraded",
  not_checked: "plugins.capabilityHealth.status.notChecked",
};

function capabilityLabelKey(capabilityId: string): string {
  return CAPABILITY_LABEL_KEYS[capabilityId] ?? "plugins.capabilityHealth.capabilities.unknown";
}

export function presentCapabilityHealth(
  capabilityId: string,
  rows: readonly CapabilityHealthDto[] | null | undefined,
): CapabilityHealthPresentation {
  const row = rows?.find((candidate) => candidate.capabilityId === capabilityId);
  const status: CapabilityHealthPresentationStatus = row?.status ?? "not_checked";
  return {
    capabilityId,
    capabilityLabelKey: capabilityLabelKey(capabilityId),
    status,
    statusLabelKey: STATUS_LABEL_KEYS[status],
    normalizedCode: row?.status === "degraded" ? (row.errorCode ?? null) : null,
    checkedAt: row?.checkedAt ?? null,
  };
}

export function presentCapabilityHealthList(
  capabilityIds: readonly string[],
  rows: readonly CapabilityHealthDto[] | null | undefined,
): CapabilityHealthPresentation[] {
  return capabilityIds.map((capabilityId) => presentCapabilityHealth(capabilityId, rows));
}

export const toCapabilityHealthPresentation = presentCapabilityHealth;
