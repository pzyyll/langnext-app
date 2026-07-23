// ABOUTME: Integration editor draft helpers for DTO→form and credential keep/replace/clear.
// ABOUTME: Never copies secret values from DTOs into the draft.
import type {
  CredentialUpdate,
  GoogleCloudConfigV1,
  IntegrationInstanceDto,
  IntegrationInstanceWrite,
  ProxyMode,
} from "../../storage/types";
import {
  GOOGLE_CLOUD_DEFAULT_LOCATION,
  GOOGLE_CLOUD_PLUGIN_ID,
  GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
} from "../../storage/types";

export type CredentialAction = "keep" | "replace" | "clear";

export type GoogleCloudIntegrationDraft = {
  pluginId: typeof GOOGLE_CLOUD_PLUGIN_ID;
  displayName: string;
  enabled: boolean;
  projectId: string;
  location: string;
  proxyMode: ProxyMode;
  serviceAccountJson: string;
  serviceAccountAction: CredentialAction;
  hasServiceAccount: boolean;
  expectedUpdatedAt: string | null;
};

export function emptyGoogleCloudDraft(displayName = ""): GoogleCloudIntegrationDraft {
  return {
    pluginId: GOOGLE_CLOUD_PLUGIN_ID,
    displayName,
    enabled: true,
    projectId: "",
    location: GOOGLE_CLOUD_DEFAULT_LOCATION,
    proxyMode: "inherit",
    serviceAccountJson: "",
    serviceAccountAction: "keep",
    hasServiceAccount: false,
    expectedUpdatedAt: null,
  };
}

export function parseGoogleCloudConfig(configJson: string): GoogleCloudConfigV1 {
  try {
    const parsed = JSON.parse(configJson) as Partial<GoogleCloudConfigV1>;
    return {
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
      location:
        typeof parsed.location === "string" && parsed.location.trim() ? parsed.location : GOOGLE_CLOUD_DEFAULT_LOCATION,
      proxyMode: parsed.proxyMode === "direct" ? "direct" : "inherit",
    };
  } catch {
    return {
      projectId: "",
      location: GOOGLE_CLOUD_DEFAULT_LOCATION,
      proxyMode: "inherit",
    };
  }
}

export function draftFromIntegrationDto(instance: IntegrationInstanceDto): GoogleCloudIntegrationDraft {
  const config = parseGoogleCloudConfig(instance.configJson);
  const serviceAccount = instance.credentialSlots.find((slot) => slot.slotId === GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT);
  return {
    pluginId: GOOGLE_CLOUD_PLUGIN_ID,
    displayName: instance.displayName,
    enabled: instance.enabled,
    projectId: config.projectId,
    location: config.location || GOOGLE_CLOUD_DEFAULT_LOCATION,
    proxyMode: config.proxyMode,
    // Never echo secrets from DTO.
    serviceAccountJson: "",
    serviceAccountAction: "keep",
    hasServiceAccount: serviceAccount?.hasCredential ?? false,
    expectedUpdatedAt: instance.updatedAt,
  };
}

export function toCredentialUpdate(action: CredentialAction, value: string): CredentialUpdate {
  if (action === "clear") {
    return { action: "clear" };
  }
  if (action === "replace" && value.trim()) {
    return { action: "replace", value: value.trim() };
  }
  return { action: "keep" };
}

export function buildGoogleCloudWrite(
  draft: GoogleCloudIntegrationDraft,
  options?: { id?: string | null },
): IntegrationInstanceWrite {
  const config: GoogleCloudConfigV1 = {
    projectId: draft.projectId.trim(),
    location: draft.location.trim() || GOOGLE_CLOUD_DEFAULT_LOCATION,
    proxyMode: draft.proxyMode,
  };
  return {
    id: options?.id ?? null,
    pluginId: draft.pluginId,
    displayName: draft.displayName.trim(),
    enabled: draft.enabled,
    configJson: JSON.stringify(config),
    credentials: [
      {
        slotId: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
        credential: toCredentialUpdate(draft.serviceAccountAction, draft.serviceAccountJson),
      },
    ],
    expectedUpdatedAt: draft.expectedUpdatedAt,
  };
}

export function isGoogleCloudDraftClean(draft: GoogleCloudIntegrationDraft, instance: IntegrationInstanceDto): boolean {
  const baseline = draftFromIntegrationDto(instance);
  // `enabled` is persisted via setIntegrationInstanceEnabled, not full save.
  return (
    draft.displayName === baseline.displayName &&
    draft.projectId === baseline.projectId &&
    draft.location === baseline.location &&
    draft.proxyMode === baseline.proxyMode &&
    draft.serviceAccountAction === "keep" &&
    !draft.serviceAccountJson.trim()
  );
}
