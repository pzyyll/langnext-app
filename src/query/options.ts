// ABOUTME: Typed queryOptions factories wrapping storage IPC read functions.
// ABOUTME: Keeps query keys and fetchers co-located for reuse across routes.
import { queryOptions } from "@tanstack/react-query";
import {
  getAppSettings,
  getIntegrationInstance,
  getOcrService,
  getPluginVersionDependencies,
  getTranslationHistory,
  getTranslationProfile,
  listAllProviderModels,
  listInstalledPluginVersions,
  listIntegrationInstanceDependencies,
  listIntegrationInstances,
  listOcrServices,
  listPluginPublishers,
  listSpeechServices,
  getSpeechService,
  listProviderInstances,
  listProviderModels,
  listServiceIntegrationDefinitions,
  listTranslationHistory,
  listTranslationHistoryModelFacets,
  listTranslationProfiles,
  previewIntegrationRuntimeRollback,
  previewIntegrationRuntimeUpgrade,
} from "../storage/client";
import type { TranslationHistoryListQuery } from "../storage/types";
import {
  historyKeys,
  integrationKeys,
  modelKeys,
  ocrKeys,
  pluginPackageKeys,
  profileKeys,
  providerKeys,
  runtimeLifecycleKeys,
  settingsKeys,
  speechKeys,
} from "./keys";

export function providerListOptions() {
  return queryOptions({
    queryKey: providerKeys.list(),
    queryFn: listProviderInstances,
  });
}

export function allProviderModelsOptions() {
  return queryOptions({
    queryKey: modelKeys.allEnabled(),
    queryFn: listAllProviderModels,
  });
}

export function providerModelsOptions(providerInstanceId: string) {
  return queryOptions({
    queryKey: modelKeys.byProvider(providerInstanceId),
    queryFn: () => listProviderModels(providerInstanceId),
    enabled: providerInstanceId.length > 0,
  });
}

export function profileListOptions() {
  return queryOptions({
    queryKey: profileKeys.list(),
    queryFn: listTranslationProfiles,
  });
}

export function profileDetailOptions(id: string) {
  return queryOptions({
    queryKey: profileKeys.detail(id),
    queryFn: () => getTranslationProfile(id),
    enabled: id.length > 0,
  });
}

export function historyListOptions(query: TranslationHistoryListQuery) {
  return queryOptions({
    queryKey: historyKeys.list(query),
    queryFn: () => listTranslationHistory(query),
  });
}

export function historyDetailOptions(id: string) {
  return queryOptions({
    queryKey: historyKeys.detail(id),
    queryFn: () => getTranslationHistory(id),
    enabled: id.length > 0,
  });
}

export function historyModelFacetsOptions() {
  return queryOptions({
    queryKey: historyKeys.modelFacets(),
    queryFn: listTranslationHistoryModelFacets,
  });
}

export function ocrListOptions() {
  return queryOptions({
    queryKey: ocrKeys.list(),
    queryFn: listOcrServices,
  });
}

export function ocrDetailOptions(id: string) {
  return queryOptions({
    queryKey: ocrKeys.detail(id),
    queryFn: () => getOcrService(id),
    enabled: id.length > 0,
  });
}

export function speechListOptions() {
  return queryOptions({
    queryKey: speechKeys.list(),
    queryFn: listSpeechServices,
  });
}

export function speechDetailOptions(id: string) {
  return queryOptions({
    queryKey: speechKeys.detail(id),
    queryFn: () => getSpeechService(id),
    enabled: id.length > 0,
  });
}

export function integrationListOptions() {
  return queryOptions({
    queryKey: integrationKeys.list(),
    queryFn: listIntegrationInstances,
  });
}

export function integrationDetailOptions(id: string) {
  return queryOptions({
    queryKey: integrationKeys.detail(id),
    queryFn: () => getIntegrationInstance(id),
    enabled: id.length > 0,
  });
}

export function integrationDefinitionListOptions() {
  return queryOptions({
    queryKey: integrationKeys.definitions(),
    queryFn: listServiceIntegrationDefinitions,
  });
}

export function integrationDependencyListOptions(id: string) {
  return queryOptions({
    queryKey: integrationKeys.dependencies(id),
    queryFn: () => listIntegrationInstanceDependencies(id),
    enabled: id.length > 0,
  });
}

export function appSettingsOptions() {
  return queryOptions({
    queryKey: settingsKeys.detail(),
    queryFn: getAppSettings,
  });
}

export function installedPluginVersionListOptions() {
  return queryOptions({
    queryKey: pluginPackageKeys.versions(),
    queryFn: listInstalledPluginVersions,
  });
}

export function pluginPublisherListOptions() {
  return queryOptions({
    queryKey: pluginPackageKeys.publishers(),
    queryFn: listPluginPublishers,
  });
}

export function pluginVersionDependencyOptions(packageDigest: string) {
  return queryOptions({
    queryKey: pluginPackageKeys.dependencies(packageDigest),
    queryFn: () => getPluginVersionDependencies(packageDigest),
    enabled: packageDigest.length > 0,
  });
}

/** Ephemeral upgrade preview; disabled until a target digest is supplied. */
export function runtimeUpgradePreviewOptions(instanceId: string, targetPackageDigest: string) {
  return queryOptions({
    queryKey: runtimeLifecycleKeys.upgradePreview(instanceId, targetPackageDigest),
    queryFn: () => previewIntegrationRuntimeUpgrade(instanceId, targetPackageDigest),
    enabled: instanceId.length > 0 && targetPackageDigest.length === 64,
  });
}

/** Ephemeral rollback preview for the latest host-owned snapshot. */
export function runtimeRollbackPreviewOptions(instanceId: string, enabled = false) {
  return queryOptions({
    queryKey: runtimeLifecycleKeys.rollbackPreview(instanceId),
    queryFn: () => previewIntegrationRuntimeRollback(instanceId),
    enabled: enabled && instanceId.length > 0,
  });
}
