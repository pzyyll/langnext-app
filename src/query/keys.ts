// ABOUTME: Stable TanStack Query key factories for providers, models, and profiles.
// ABOUTME: Components import factories instead of constructing array keys inline.
import type { TranslationHistoryListQuery } from "../storage/types";
export const providerKeys = {
  all: ["providers"] as const,
  list: () => [...providerKeys.all, "list"] as const,
};

export const modelKeys = {
  all: ["models"] as const,
  allEnabled: () => [...modelKeys.all, "enabled"] as const,
  byProvider: (providerInstanceId: string) => [...modelKeys.all, "provider", providerInstanceId] as const,
};

export const profileKeys = {
  all: ["translation-profiles"] as const,
  list: () => [...profileKeys.all, "list"] as const,
  detail: (id: string) => [...profileKeys.all, "detail", id] as const,
};

export const historyKeys = {
  all: ["translation-history"] as const,
  list: (query: TranslationHistoryListQuery) => [...historyKeys.all, "list", query] as const,
  detail: (id: string) => [...historyKeys.all, "detail", id] as const,
  many: (ids: string[]) => [...historyKeys.all, "many", ids] as const,
  modelFacets: () => [...historyKeys.all, "model-facets"] as const,
};

export const ocrKeys = {
  all: ["ocr-services"] as const,
  list: () => [...ocrKeys.all, "list"] as const,
  detail: (id: string) => [...ocrKeys.all, "detail", id] as const,
};

export const speechKeys = {
  all: ["speech-services"] as const,
  list: () => [...speechKeys.all, "list"] as const,
  detail: (id: string) => [...speechKeys.all, "detail", id] as const,
};

export const integrationKeys = {
  all: ["service-integrations"] as const,
  list: () => [...integrationKeys.all, "list"] as const,
  detail: (id: string) => [...integrationKeys.all, "detail", id] as const,
  definitions: () => [...integrationKeys.all, "definitions"] as const,
  dependencies: (id: string) => [...integrationKeys.all, "dependencies", id] as const,
};

export const settingsKeys = {
  all: ["app-settings"] as const,
  detail: () => [...settingsKeys.all, "detail"] as const,
};

export const pluginPackageKeys = {
  all: ["plugin-packages"] as const,
  versions: () => [...pluginPackageKeys.all, "versions"] as const,
  publishers: () => [...pluginPackageKeys.all, "publishers"] as const,
  dependencies: (packageDigest: string) => [...pluginPackageKeys.all, "dependencies", packageDigest] as const,
};

/** Runtime upgrade/rollback previews are ephemeral; mutations invalidate integration + package keys. */
export const runtimeLifecycleKeys = {
  all: ["runtime-lifecycle"] as const,
  upgradePreview: (instanceId: string, targetPackageDigest: string) =>
    [...runtimeLifecycleKeys.all, "upgrade-preview", instanceId, targetPackageDigest] as const,
  rollbackPreview: (instanceId: string) => [...runtimeLifecycleKeys.all, "rollback-preview", instanceId] as const,
};

/** Provider runtime package catalog (Phase 8); changes only with package install/removal. */
export const providerRuntimeKeys = {
  all: ["provider-runtime"] as const,
  catalog: () => [...providerRuntimeKeys.all, "catalog"] as const,
  snapshots: (providerInstanceId: string) => [...providerRuntimeKeys.all, "snapshots", providerInstanceId] as const,
};
