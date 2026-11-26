import type { App } from "nsh/test";
import type { ProviderTypeId } from "../../../modules/ai/contracts/channel";
import { credentialStorageKey, MODELS_STORAGE_KEY, PROVIDERS_STORAGE_KEY } from "../store";
import type { ProviderChannel } from "../../../modules/ai/contracts/channel";
import type { ProviderModel } from "../../../modules/ai/contracts/model";

export function makeChannel(overrides: Partial<ProviderChannel> = {}): ProviderChannel {
  return {
    id: "ch-openai",
    presetId: "openai",
    displayName: "OpenAI Main",
    adapterId: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    hasCredential: true,
    enabled: true,
    sortOrder: 0,
    revision: 1,
    insecureHttpConfirmedAt: null,
    modelsLastSyncedAt: null,
    modelsLastSyncError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeModel(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: "m-1",
    providerId: "ch-openai",
    modelKey: "gpt-4o",
    sourceAdapterId: "openai-responses",
    origin: "remote",
    syncStatus: "active",
    enabled: false,
    displayName: null,
    displayNameOverride: null,
    apiTypeOverride: null,
    capabilities: { text: true, image: true, pdf: false, video: false },
    capabilitiesOverride: null,
    contextLimit: null,
    maxTokens: null,
    lastSeenAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeSeedStorage(options: {
  channels?: ProviderChannel[];
  models?: ProviderModel[];
  credentials?: Record<string, string>;
  extra?: Record<string, string>;
}): Record<string, string> {
  const storage: Record<string, string> = {
    "settings.language": "en",
    ...options.extra,
  };
  if (options.channels) {
    storage[PROVIDERS_STORAGE_KEY] = JSON.stringify(options.channels);
  }
  if (options.models) {
    storage[MODELS_STORAGE_KEY] = JSON.stringify(options.models);
  }
  if (options.credentials) {
    for (const [providerId, secret] of Object.entries(options.credentials)) {
      storage[credentialStorageKey(providerId)] = secret;
    }
  }
  return storage;
}

export async function startDraftFromEmptyState(app: App, presetId: ProviderTypeId): Promise<void> {
  await app.press("id:empty-add-channel-button");
  await app.waitFor("id:add-channel-dialog");
  await app.press(`id:provider-preset-${presetId}`);
  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));
  await app.waitFor("id:provider-editor");
}

export async function startDraftFromRail(app: App, presetId: ProviderTypeId): Promise<void> {
  await app.press("id:add-channel-button");
  await app.waitFor("id:add-channel-dialog");
  await app.press(`id:provider-preset-${presetId}`);
  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));
  await app.waitFor("id:provider-editor");
}
