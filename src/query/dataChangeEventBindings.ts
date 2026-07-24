// ABOUTME: Pure data-change event → Query key invalidation table for every webview.
// ABOUTME: QueryEventSync consumes this table; tests assert registration contracts without mounting React.
import {
  DATA_APP_SETTINGS_CHANGED,
  DATA_MODELS_CHANGED,
  DATA_OCR_SERVICES_CHANGED,
  DATA_PROVIDERS_CHANGED,
  DATA_SERVICE_INTEGRATIONS_CHANGED,
  DATA_TRANSLATION_HISTORY_CHANGED,
  DATA_TRANSLATION_PROFILES_CHANGED,
} from "./events";
import { historyKeys, integrationKeys, modelKeys, ocrKeys, profileKeys, providerKeys, settingsKeys } from "./keys";

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
    event: DATA_SERVICE_INTEGRATIONS_CHANGED,
    // Integration health/rebind affects plugin OCR service labels and readiness.
    invalidateKeys: [integrationKeys.all, ocrKeys.all],
  },
  {
    event: DATA_APP_SETTINGS_CHANGED,
    invalidateKeys: [settingsKeys.all],
  },
];
