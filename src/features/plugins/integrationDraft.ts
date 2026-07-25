// ABOUTME: Integration editor draft helpers for DTO→form and credential keep/replace/clear.
// ABOUTME: Never copies secret values from DTOs into the draft.
import type {
  CredentialUpdate,
  EdgeTtsConfigV1,
  GoogleCloudConfigV1,
  GoogleTranslateWebChannel,
  GoogleTranslateWebConfigV1,
  IntegrationInstanceDto,
  IntegrationInstanceWrite,
  ProxyMode,
} from "../../storage/types";
import {
  EDGE_TTS_DEFAULT_BASE_URL,
  EDGE_TTS_PLUGIN_ID,
  GOOGLE_CLOUD_DEFAULT_LOCATION,
  GOOGLE_CLOUD_PLUGIN_ID,
  GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
  GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL,
  GOOGLE_TRANSLATE_WEB_PLUGIN_ID,
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

/** True when the draft will mutate the service-account credential on save (replace or clear of an existing binding). */
export function hasCredentialMutation(draft: GoogleCloudIntegrationDraft): boolean {
  if (draft.serviceAccountAction === "replace" && draft.serviceAccountJson.trim()) {
    return true;
  }
  if (draft.serviceAccountAction === "clear" && draft.hasServiceAccount) {
    return true;
  }
  return false;
}

/** True when the draft changes Google Cloud config vs the persisted instance (projectId/location/proxyMode). */
export function hasConfigMutation(draft: GoogleCloudIntegrationDraft, instance: IntegrationInstanceDto): boolean {
  const baseline = draftFromIntegrationDto(instance);
  return (
    draft.projectId !== baseline.projectId ||
    draft.location !== baseline.location ||
    draft.proxyMode !== baseline.proxyMode
  );
}

/** True when the save needs a remote re-check: credential or Google Cloud config mutation (never name-only). */
export function hasRemoteRelevantMutation(
  draft: GoogleCloudIntegrationDraft,
  instance: IntegrationInstanceDto,
): boolean {
  return hasCredentialMutation(draft) || hasConfigMutation(draft, instance);
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

export type GoogleTranslateWebIntegrationDraft = {
  pluginId: typeof GOOGLE_TRANSLATE_WEB_PLUGIN_ID;
  displayName: string;
  enabled: boolean;
  channel: GoogleTranslateWebChannel;
  proxyUrl: string;
  expectedUpdatedAt: string | null;
};

export function emptyGoogleTranslateWebDraft(displayName = ""): GoogleTranslateWebIntegrationDraft {
  return {
    pluginId: GOOGLE_TRANSLATE_WEB_PLUGIN_ID,
    displayName,
    enabled: true,
    channel: "gtx",
    proxyUrl: GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL,
    expectedUpdatedAt: null,
  };
}

export function parseGoogleTranslateWebConfig(configJson: string): GoogleTranslateWebConfigV1 {
  try {
    const parsed = JSON.parse(configJson) as Partial<GoogleTranslateWebConfigV1>;
    const channel: GoogleTranslateWebChannel = parsed.channel === "https_proxy" ? "https_proxy" : "gtx";
    return {
      channel,
      proxyUrl:
        typeof parsed.proxyUrl === "string" && parsed.proxyUrl.trim()
          ? parsed.proxyUrl.trim()
          : channel === "https_proxy"
            ? GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL
            : null,
    };
  } catch {
    return {
      channel: "gtx",
      proxyUrl: null,
    };
  }
}

export function draftFromGoogleTranslateWebDto(instance: IntegrationInstanceDto): GoogleTranslateWebIntegrationDraft {
  const config = parseGoogleTranslateWebConfig(instance.configJson);
  return {
    pluginId: GOOGLE_TRANSLATE_WEB_PLUGIN_ID,
    displayName: instance.displayName,
    enabled: instance.enabled,
    channel: config.channel,
    proxyUrl:
      typeof config.proxyUrl === "string" && config.proxyUrl.trim()
        ? config.proxyUrl
        : GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL,
    expectedUpdatedAt: instance.updatedAt,
  };
}

export function buildGoogleTranslateWebWrite(
  draft: GoogleTranslateWebIntegrationDraft,
  options?: { id?: string | null },
): IntegrationInstanceWrite {
  const config: GoogleTranslateWebConfigV1 =
    draft.channel === "https_proxy"
      ? {
          channel: "https_proxy",
          proxyUrl: draft.proxyUrl.trim() || GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL,
        }
      : {
          channel: "gtx",
        };
  return {
    id: options?.id ?? null,
    pluginId: draft.pluginId,
    displayName: draft.displayName.trim(),
    enabled: draft.enabled,
    configJson: JSON.stringify(config),
    credentials: [],
    expectedUpdatedAt: draft.expectedUpdatedAt,
  };
}

export function hasGoogleTranslateWebConfigMutation(
  draft: GoogleTranslateWebIntegrationDraft,
  instance: IntegrationInstanceDto,
): boolean {
  const baseline = draftFromGoogleTranslateWebDto(instance);
  return draft.channel !== baseline.channel || draft.proxyUrl !== baseline.proxyUrl;
}

export function isGoogleTranslateWebDraftClean(
  draft: GoogleTranslateWebIntegrationDraft,
  instance: IntegrationInstanceDto,
): boolean {
  const baseline = draftFromGoogleTranslateWebDto(instance);
  return (
    draft.displayName === baseline.displayName &&
    draft.channel === baseline.channel &&
    draft.proxyUrl === baseline.proxyUrl
  );
}

export type EdgeTtsIntegrationDraft = {
  pluginId: typeof EDGE_TTS_PLUGIN_ID;
  displayName: string;
  enabled: boolean;
  baseUrl: string;
  expectedUpdatedAt: string | null;
};

export function emptyEdgeTtsDraft(displayName = ""): EdgeTtsIntegrationDraft {
  return {
    pluginId: EDGE_TTS_PLUGIN_ID,
    displayName,
    enabled: true,
    baseUrl: EDGE_TTS_DEFAULT_BASE_URL,
    expectedUpdatedAt: null,
  };
}

export function parseEdgeTtsConfig(configJson: string): EdgeTtsConfigV1 {
  try {
    const parsed = JSON.parse(configJson) as Partial<EdgeTtsConfigV1>;
    return {
      baseUrl:
        typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : EDGE_TTS_DEFAULT_BASE_URL,
    };
  } catch {
    return {
      baseUrl: EDGE_TTS_DEFAULT_BASE_URL,
    };
  }
}

export function draftFromEdgeTtsDto(instance: IntegrationInstanceDto): EdgeTtsIntegrationDraft {
  const config = parseEdgeTtsConfig(instance.configJson);
  return {
    pluginId: EDGE_TTS_PLUGIN_ID,
    displayName: instance.displayName,
    enabled: instance.enabled,
    baseUrl: config.baseUrl,
    expectedUpdatedAt: instance.updatedAt,
  };
}

export function buildEdgeTtsWrite(
  draft: EdgeTtsIntegrationDraft,
  options?: { id?: string | null },
): IntegrationInstanceWrite {
  const config: EdgeTtsConfigV1 = {
    baseUrl: draft.baseUrl.trim() || EDGE_TTS_DEFAULT_BASE_URL,
  };
  return {
    id: options?.id ?? null,
    pluginId: draft.pluginId,
    displayName: draft.displayName.trim(),
    enabled: draft.enabled,
    configJson: JSON.stringify(config),
    credentials: [],
    expectedUpdatedAt: draft.expectedUpdatedAt,
  };
}

export function hasEdgeTtsConfigMutation(draft: EdgeTtsIntegrationDraft, instance: IntegrationInstanceDto): boolean {
  const baseline = draftFromEdgeTtsDto(instance);
  return draft.baseUrl !== baseline.baseUrl;
}

export function isEdgeTtsDraftClean(draft: EdgeTtsIntegrationDraft, instance: IntegrationInstanceDto): boolean {
  const baseline = draftFromEdgeTtsDto(instance);
  return draft.displayName === baseline.displayName && draft.baseUrl === baseline.baseUrl;
}
