// ABOUTME: Contract tests for data-change event → Query key invalidation bindings.
// ABOUTME: Pure table checks only — no DOM, Tauri listen, or React mount required.
import { describe, expect, test } from "bun:test";
import { DATA_CHANGE_EVENT_BINDINGS } from "./dataChangeEventBindings";
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

describe("DATA_CHANGE_EVENT_BINDINGS", () => {
  test("registers every known data-change event exactly once", () => {
    const events = DATA_CHANGE_EVENT_BINDINGS.map((binding) => binding.event);
    expect(events).toEqual([
      DATA_TRANSLATION_PROFILES_CHANGED,
      DATA_PROVIDERS_CHANGED,
      DATA_MODELS_CHANGED,
      DATA_TRANSLATION_HISTORY_CHANGED,
      DATA_OCR_SERVICES_CHANGED,
      DATA_SERVICE_INTEGRATIONS_CHANGED,
      DATA_APP_SETTINGS_CHANGED,
    ]);
    expect(new Set(events).size).toBe(events.length);
  });

  test("DATA_SERVICE_INTEGRATIONS_CHANGED invalidates integrations and OCR", () => {
    const binding = DATA_CHANGE_EVENT_BINDINGS.find((entry) => entry.event === DATA_SERVICE_INTEGRATIONS_CHANGED);
    expect(binding).toBeDefined();
    expect(binding?.invalidateKeys).toEqual([integrationKeys.all, ocrKeys.all]);
    expect(binding?.invalidateKeys[0]?.[0]).toBe(integrationKeys.all[0]);
    expect(binding?.invalidateKeys[1]?.[0]).toBe(ocrKeys.all[0]);
  });

  test("existing domains keep their invalidation prefixes", () => {
    const byEvent = new Map(DATA_CHANGE_EVENT_BINDINGS.map((b) => [b.event, b.invalidateKeys]));

    expect(byEvent.get(DATA_TRANSLATION_PROFILES_CHANGED)).toEqual([profileKeys.all]);
    expect(byEvent.get(DATA_PROVIDERS_CHANGED)).toEqual([providerKeys.all, modelKeys.all]);
    expect(byEvent.get(DATA_MODELS_CHANGED)).toEqual([modelKeys.all]);
    expect(byEvent.get(DATA_TRANSLATION_HISTORY_CHANGED)).toEqual([historyKeys.all]);
    expect(byEvent.get(DATA_OCR_SERVICES_CHANGED)).toEqual([ocrKeys.all]);
    expect(byEvent.get(DATA_APP_SETTINGS_CHANGED)).toEqual([settingsKeys.all]);
  });

  test("every binding invalidates at least one non-empty key prefix", () => {
    for (const binding of DATA_CHANGE_EVENT_BINDINGS) {
      expect(binding.event.length).toBeGreaterThan(0);
      expect(binding.invalidateKeys.length).toBeGreaterThan(0);
      for (const key of binding.invalidateKeys) {
        expect(key.length).toBeGreaterThan(0);
      }
    }
  });
});
