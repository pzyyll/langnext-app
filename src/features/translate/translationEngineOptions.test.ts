// ABOUTME: Tests descriptor-driven translation engine options and compatible rebind candidates.
// ABOUTME: Covers model availability, integration status, presentation labels, and capability majors.
import { describe, expect, test } from "bun:test";
import type { IntegrationInstanceDto, ProviderModelDto, ServiceIntegrationDefinitionDto } from "../../storage/types";
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

function definition(id: string, displayNameFallback = "Example Translate"): ServiceIntegrationDefinitionDto {
  return {
    manifestVersion: 1,
    pluginApiVersion: "1.0",
    id,
    version: "1.0.0",
    displayNameKey: "plugins.example.name",
    minHostVersion: "0.1.0",
    configSchemaVersion: 1,
    credentialSlots: [],
    endpoints: [],
    capabilities: [
      { id: TRANSLATE_TEXT_CAPABILITY_ID, preferencesSchemaVersion: 1, endpointAliases: ["translate"] },
      { id: DETECT_LANGUAGE_CAPABILITY_ID, preferencesSchemaVersion: 1, endpointAliases: ["translate"] },
    ],
    configSchema: { version: 1, fields: [], groups: [] },
    capabilitySchemas: [],
    presentation: { displayNameFallback, icon: "extension" },
  };
}

function instance(
  id: string,
  displayName: string,
  effectiveStatus: IntegrationInstanceDto["effectiveStatus"],
  enabled = true,
  overrides?: Partial<IntegrationInstanceDto>,
): IntegrationInstanceDto {
  return {
    id,
    pluginId: "com.example.translate",
    pluginVersion: "1.0.0",
    displayName,
    enabled,
    configJson: "{}",
    configSchemaVersion: 1,
    healthStatus: effectiveStatus === "ready" ? "ready" : "unconfigured",
    effectiveStatus,
    lastValidatedAt: null,
    lastErrorCode: null,
    runtimeKind: "bundled-rust",
    runtimeState: "active",
    credentialSlots: [],
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

describe("buildTranslationEngineOptions", () => {
  test("puts LLM first and lists ready integrations in stable order", () => {
    const options = buildTranslationEngineOptions({
      enabledModels: [model("m1")],
      instances: [instance("i-b", "Work", "ready"), instance("i-a", "Personal", "ready")],
      definitions: [definition("com.example.translate")],
    });
    expect(options.map((option) => option.id)).toEqual(["llm", "integration:i-a", "integration:i-b"]);
    expect(options[0]?.disabled).toBe(false);
    expect(options[1]?.translateCapabilityId).toBe(TRANSLATE_TEXT_CAPABILITY_ID);
  });

  test("uses presentation fallback metadata for integration labels", () => {
    const options = buildTranslationEngineOptions({
      enabledModels: [model("m1")],
      instances: [instance("i1", "Desk", "ready")],
      definitions: [definition("com.example.translate", "Dictionary")],
      labels: {
        llmLabel: "LLM",
        llmDescriptionReady: "ready",
        llmDescriptionNoModel: "missing",
        statusDisabled: "disabled",
        statusPluginMissing: "missing plugin",
        statusNeedsConfig: "needs config",
        statusGeneric: "{{plugin}}: {{status}}",
        integrationLabel: "{{plugin}} / {{name}}",
      },
    });
    expect(options[1]?.label).toBe("Dictionary / Desk");
  });

  test("disables unavailable integrations with a Plugins configuration hint", () => {
    const options = buildTranslationEngineOptions({
      enabledModels: [model("m1")],
      instances: [
        instance("i1", "Needs config", "unconfigured"),
        instance("i2", "Missing", "plugin_missing"),
        instance("i3", "Off", "disabled", false),
      ],
      definitions: [definition("com.example.translate")],
    });
    const integrationOptions = options.filter((option) => option.kind === "plugin_capability");
    expect(integrationOptions.every((option) => option.disabled && option.configurePath === "/plugins")).toBe(true);
  });

  test("omits instances without a registered translate capability", () => {
    const noTranslate: ServiceIntegrationDefinitionDto = {
      ...definition("com.example.vision"),
      capabilities: [{ id: "ocr.image@1", preferencesSchemaVersion: 1, endpointAliases: [] }],
    };
    const options = buildTranslationEngineOptions({
      enabledModels: [model("m1")],
      instances: [instance("i1", "Vision", "ready", true, { pluginId: "com.example.vision" })],
      definitions: [noTranslate],
    });
    expect(options).toHaveLength(1);
    expect(options[0]?.kind).toBe("llm_model_chain");
  });
});

describe("listCompatiblePluginRebindCandidates", () => {
  test("returns ready and unavailable candidates with matching majors", () => {
    const candidates = listCompatiblePluginRebindCandidates({
      currentInstanceId: "i1",
      translateCapabilityId: TRANSLATE_TEXT_CAPABILITY_ID,
      detectCapabilityId: DETECT_LANGUAGE_CAPABILITY_ID,
      instances: [
        instance("i1", "Work", "ready"),
        instance("i2", "Personal", "ready"),
        instance("i3", "Broken", "unconfigured"),
      ],
      definitions: [definition("com.example.translate")],
    });
    expect(candidates.map((candidate) => candidate.id).sort()).toEqual(["i1", "i2", "i3"]);
    expect(candidates.find((candidate) => candidate.id === "i2")?.ready).toBe(true);
    expect(candidates.find((candidate) => candidate.id === "i3")?.ready).toBe(false);
  });
});

describe("capabilitiesMajorCompatible", () => {
  test("matches capability name and major only", () => {
    expect(capabilitiesMajorCompatible("translate.text@1", "translate.text@1")).toBe(true);
    expect(capabilitiesMajorCompatible("translate.text@1", "translate.text@2")).toBe(false);
    expect(capabilitiesMajorCompatible("translate.text@1", "translate.detect@1")).toBe(false);
  });
});
