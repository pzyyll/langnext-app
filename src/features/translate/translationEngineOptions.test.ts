// ABOUTME: Tests dual-catalog translation engine options for Add Profile.
// ABOUTME: Covers LLM availability, ready integrations, ordering, and disabled states.
import { describe, expect, test } from "bun:test";
import type { IntegrationInstanceDto, ProviderModelDto, ServiceIntegrationManifest } from "../../storage/types";
import {
  DETECT_LANGUAGE_CAPABILITY_ID,
  TRANSLATE_TEXT_CAPABILITY_ID,
  buildTranslationEngineOptions,
  capabilitiesMajorCompatible,
  listCompatiblePluginRebindCandidates,
} from "./translationEngineOptions";

function model(id: string, enabled = true): ProviderModelDto {
  return {
    id,
    providerInstanceId: "p1",
    modelKey: id,
    source: "manual",
    remoteDisplayName: null,
    displayNameOverride: null,
    enabled,
    availability: "available",
    remoteMetadataJson: null,
    capabilityOverridesJson: null,
    adapterId: null,
    lastSeenAt: null,
    createdAt: "t",
    updatedAt: "t",
  };
}

function definition(id: string): ServiceIntegrationManifest {
  return {
    manifestVersion: 1,
    pluginApiVersion: "1.0",
    id,
    version: "1.0.0",
    displayNameKey: "plugins.googleCloud.name",
    minHostVersion: "0.1.0",
    configSchemaVersion: 1,
    credentialSlots: [],
    endpoints: [],
    capabilities: [
      { id: TRANSLATE_TEXT_CAPABILITY_ID, preferencesSchemaVersion: 1, endpointAliases: ["translate"] },
      { id: DETECT_LANGUAGE_CAPABILITY_ID, preferencesSchemaVersion: 1, endpointAliases: ["translate"] },
    ],
  };
}

function instance(
  id: string,
  displayName: string,
  effectiveStatus: IntegrationInstanceDto["effectiveStatus"],
  enabled = true,
): IntegrationInstanceDto {
  return {
    id,
    pluginId: "com.langnext.google-cloud",
    pluginVersion: "1.0.0",
    displayName,
    enabled,
    configJson: "{}",
    configSchemaVersion: 1,
    healthStatus: effectiveStatus === "ready" ? "ready" : "unconfigured",
    effectiveStatus,
    lastValidatedAt: null,
    lastErrorCode: null,
    credentialSlots: [],
    createdAt: "t",
    updatedAt: "t",
  };
}

describe("buildTranslationEngineOptions", () => {
  test("puts LLM first and lists ready integrations with stable labels", () => {
    const options = buildTranslationEngineOptions({
      enabledModels: [model("m1")],
      instances: [instance("i-b", "Work", "ready"), instance("i-a", "Personal", "ready")],
      definitions: [definition("com.langnext.google-cloud")],
    });
    expect(options[0]?.id).toBe("llm");
    expect(options[0]?.disabled).toBe(false);
    expect(options.map((o) => o.id)).toEqual(["llm", "integration:i-a", "integration:i-b"]);
    expect(options[1]?.label).toContain("Personal");
    expect(options[1]?.kind).toBe("plugin_capability");
    expect(options[1]?.translateCapabilityId).toBe(TRANSLATE_TEXT_CAPABILITY_ID);
  });

  test("disables LLM when no enabled models", () => {
    const options = buildTranslationEngineOptions({
      enabledModels: [model("m1", false)],
      instances: [],
      definitions: [],
    });
    expect(options).toHaveLength(1);
    expect(options[0]?.disabled).toBe(true);
  });

  test("disables unconfigured/plugin-missing integrations with /plugins hint", () => {
    const options = buildTranslationEngineOptions({
      enabledModels: [model("m1")],
      instances: [
        instance("i1", "Needs Auth", "unconfigured"),
        instance("i2", "Missing", "plugin_missing"),
        instance("i3", "Off", "disabled", false),
      ],
      definitions: [definition("com.langnext.google-cloud")],
    });
    const service = options.filter((o) => o.kind === "plugin_capability");
    expect(service.every((o) => o.disabled)).toBe(true);
    expect(service.every((o) => o.configurePath === "/plugins")).toBe(true);
  });

  test("omits instances without translate capability", () => {
    const noTranslate: ServiceIntegrationManifest = {
      ...definition("com.langnext.other"),
      id: "com.langnext.other",
      capabilities: [{ id: "vision.ocr@1", preferencesSchemaVersion: 1, endpointAliases: [] }],
    };
    const options = buildTranslationEngineOptions({
      enabledModels: [model("m1")],
      instances: [
        {
          ...instance("i1", "Vision", "ready"),
          pluginId: "com.langnext.other",
        },
      ],
      definitions: [noTranslate],
    });
    expect(options).toHaveLength(1);
    expect(options[0]?.kind).toBe("llm_model_chain");
  });
});

describe("listCompatiblePluginRebindCandidates", () => {
  test("returns ready compatible instances including current", () => {
    const candidates = listCompatiblePluginRebindCandidates({
      currentInstanceId: "i1",
      translateCapabilityId: "translate.text@1",
      detectCapabilityId: "translate.detect@1",
      instances: [
        instance("i1", "Work", "ready"),
        instance("i2", "Personal", "ready"),
        instance("i3", "Broken", "unconfigured"),
      ],
      definitions: [definition("com.langnext.google-cloud")],
    });
    expect(candidates.map((c) => c.id).sort()).toEqual(["i1", "i2", "i3"]);
    expect(candidates.find((c) => c.id === "i2")?.ready).toBe(true);
    expect(candidates.find((c) => c.id === "i3")?.ready).toBe(false);
  });

  test("excludes incompatible capability majors", () => {
    const candidates = listCompatiblePluginRebindCandidates({
      currentInstanceId: "i1",
      translateCapabilityId: "translate.text@2",
      detectCapabilityId: null,
      instances: [instance("i1", "Work", "ready"), instance("i2", "Other", "ready")],
      definitions: [definition("com.langnext.google-cloud")],
    });
    expect(candidates).toHaveLength(0);
  });
});

describe("capabilitiesMajorCompatible", () => {
  test("matches name and major only", () => {
    expect(capabilitiesMajorCompatible("translate.text@1", "translate.text@1")).toBe(true);
    expect(capabilitiesMajorCompatible("translate.text@1", "translate.text@2")).toBe(false);
    expect(capabilitiesMajorCompatible("translate.text@1", "translate.detect@1")).toBe(false);
  });
});
