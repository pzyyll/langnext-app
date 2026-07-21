// ABOUTME: Typed queryOptions factories wrapping storage IPC read functions.
// ABOUTME: Keeps query keys and fetchers co-located for reuse across routes.
import { queryOptions } from "@tanstack/react-query";
import {
  getAppSettings,
  getOcrService,
  getTranslationHistory,
  getTranslationProfile,
  listAllProviderModels,
  listOcrServices,
  listProviderInstances,
  listProviderModels,
  listTranslationHistory,
  listTranslationHistoryModelFacets,
  listTranslationProfiles,
} from "../storage/client";
import type { TranslationHistoryListQuery } from "../storage/types";
import { historyKeys, modelKeys, ocrKeys, profileKeys, providerKeys, settingsKeys } from "./keys";

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

export function appSettingsOptions() {
  return queryOptions({
    queryKey: settingsKeys.detail(),
    queryFn: getAppSettings,
  });
}
