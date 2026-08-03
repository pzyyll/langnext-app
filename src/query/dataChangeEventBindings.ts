// ABOUTME: Pure data-change event → Query key invalidation table for every webview.
// ABOUTME: QueryEventSync consumes this table; tests assert registration contracts without mounting React.
import {
  DATA_APP_SETTINGS_CHANGED,
  DATA_MODELS_CHANGED,
  DATA_OCR_SERVICES_CHANGED,
  DATA_PLUGIN_PACKAGES_CHANGED,
  DATA_PROVIDERS_CHANGED,
  DATA_SERVICE_INTEGRATIONS_CHANGED,
  DATA_SPEECH_SERVICES_CHANGED,
  DATA_TRANSLATION_HISTORY_CHANGED,
  DATA_TRANSLATION_PROFILES_CHANGED,
} from "./events";
import {
  historyKeys,
  integrationKeys,
  modelKeys,
  ocrKeys,
  pluginPackageKeys,
  profileKeys,
  providerKeys,
  providerRuntimeKeys,
  runtimeLifecycleKeys,
  settingsKeys,
  speechKeys,
} from "./keys";

/** One backend data-change event and the Query prefixes it must invalidate. */
export type DataChangeEventBinding = {
  event: string;
  invalidateKeys: readonly (readonly string[])[];
};

/**
 * Authoritative list of Tauri data-change events and their Query invalidation
 * targets. Keep in sync with backend `events.rs` emitters.
 */
export const DATA_CHANGE_EVENT_BINDINGS: readonly DataChangeEventBinding[] = [
  {
    event: DATA_TRANSLATION_PROFILES_CHANGED,
    invalidateKeys: [profileKeys.all],
  },
  {
    event: DATA_PROVIDERS_CHANGED,
    // Provider enablement affects model availability in selectors.
    invalidateKeys: [providerKeys.all, modelKeys.all],
  },
  {
    event: DATA_MODELS_CHANGED,
    invalidateKeys: [modelKeys.all],
  },
  {
    event: DATA_TRANSLATION_HISTORY_CHANGED,
    invalidateKeys: [historyKeys.all],
  },
  {
    event: DATA_OCR_SERVICES_CHANGED,
    invalidateKeys: [ocrKeys.all],
  },
  {
    event: DATA_SPEECH_SERVICES_CHANGED,
    invalidateKeys: [speechKeys.all],
  },
  {
    event: DATA_SERVICE_INTEGRATIONS_CHANGED,
    // Runtime upgrade/rollback CAS co-mutates profiles/OCR/Speech preferences and package in_use.
    invalidateKeys: [
      integrationKeys.all,
      profileKeys.all,
      ocrKeys.all,
      speechKeys.all,
      pluginPackageKeys.all,
      runtimeLifecycleKeys.all,
    ],
  },
  {
    event: DATA_APP_SETTINGS_CHANGED,
    invalidateKeys: [settingsKeys.all],
  },
  {
    event: DATA_PLUGIN_PACKAGES_CHANGED,
    // Package install/removal changes the verified provider runtime catalog.
    invalidateKeys: [pluginPackageKeys.all, providerRuntimeKeys.catalog()],
  },
];
