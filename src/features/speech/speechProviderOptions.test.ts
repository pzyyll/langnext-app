// ABOUTME: Unit tests for schema-backed Speech create options and rebind candidate helpers.
// ABOUTME: Covers descriptor discovery, readiness, and major-version compatibility without plugin identity inference.
import { describe, expect, mock, test } from "bun:test";
import type { IntegrationInstanceDto, ServiceIntegrationDefinitionDto } from "../../storage/types";

// unplugin-icons virtual modules are unavailable under bun:test.
mock.module("~icons/svgs/google-cloud", () => ({ default: () => null }));

const { SPEECH_SYNTHESIZE_CAPABILITY_ID, buildSpeechProviderCreateOptions, listCompatibleSpeechRebindCandidates } =
  await import("./speechProviderOptions");

function instance(overrides: Partial<IntegrationInstanceDto>): IntegrationInstanceDto {
  return {
    id: "int-1",
    pluginId: "com.example.speech",
    pluginVersion: "1.0.0",
    displayName: "Speech A",
    enabled: true,
    configJson: "{}",
    configSchemaVersion: 1,
    healthStatus: "ready",
    effectiveStatus: "ready",
    lastValidatedAt: null,
    lastErrorCode: null,
    credentialSlots: [],
    createdAt: "t0",
    updatedAt: "t0",
    ...overrides,
  };
}

const speechDefinition: ServiceIntegrationDefinitionDto = {
  manifestVersion: 1,
  pluginApiVersion: "1",
  id: "com.example.speech",
  version: "1.0.0",
  displayNameKey: "plugins.example.name",
  minHostVersion: "0.1.0",
  configSchemaVersion: 1,
  credentialSlots: [],
  endpoints: [],
  capabilities: [
    { id: SPEECH_SYNTHESIZE_CAPABILITY_ID, preferencesSchemaVersion: 1 },
    { id: "ocr.image@1", preferencesSchemaVersion: 1 },
  ],
  configSchema: { version: 1, fields: [], groups: [] },
  capabilitySchemas: [],
  presentation: { displayNameFallback: "Example Speech", icon: "extension" },
};

const visionOnlyDefinition: ServiceIntegrationDefinitionDto = {
  ...speechDefinition,
  id: "com.example.vision",
  capabilities: [{ id: "ocr.image@1", preferencesSchemaVersion: 1 }],
  presentation: { displayNameFallback: "Example Vision", icon: "extension" },
};

describe("buildSpeechProviderCreateOptions", () => {
  test("lists Speech-capable integrations ordered by name then id", () => {
    const options = buildSpeechProviderCreateOptions({
      instances: [
        instance({ id: "int-b", displayName: "B", effectiveStatus: "ready" }),
        instance({ id: "int-a", displayName: "A", effectiveStatus: "degraded" }),
      ],
      definitions: [speechDefinition],
    });
    expect(options.map((option) => option.id)).toEqual(["integration:int-a", "integration:int-b"]);
    expect(options.find((option) => option.id === "integration:int-a")?.disabled).toBe(true);
    expect(options.find((option) => option.id === "integration:int-b")?.disabled).toBe(false);
    expect(options.find((option) => option.id === "integration:int-b")?.capabilityId).toBe(
      SPEECH_SYNTHESIZE_CAPABILITY_ID,
    );
  });

  test("uses the definition presentation fallback for the option label", () => {
    const options = buildSpeechProviderCreateOptions({
      instances: [instance({ displayName: "Desk" })],
      definitions: [speechDefinition],
      labels: {
        integrationLabel: "{{plugin}} / {{name}}",
      },
    });
    expect(options[0]?.label).toBe("Example Speech / Desk");
  });

  test("excludes integrations without a registered speech.synthesize descriptor", () => {
    const options = buildSpeechProviderCreateOptions({
      instances: [
        instance({ id: "int-1", pluginId: "com.example.vision", displayName: "Vision" }),
        instance({ id: "int-2", displayName: "Speech" }),
        instance({ id: "int-missing", pluginId: "com.example.missing", effectiveStatus: "plugin_missing" }),
      ],
      definitions: [speechDefinition, visionOnlyDefinition],
    });
    expect(options.map((option) => option.id)).toEqual(["integration:int-2"]);
  });
});

describe("listCompatibleSpeechRebindCandidates", () => {
  test("returns candidates with matching speech.synthesize major", () => {
    const candidates = listCompatibleSpeechRebindCandidates({
      currentInstanceId: "int-1",
      capabilityId: SPEECH_SYNTHESIZE_CAPABILITY_ID,
      instances: [
        instance({ id: "int-1", displayName: "Current" }),
        instance({ id: "int-2", displayName: "Other", effectiveStatus: "ready" }),
        instance({ id: "int-3", displayName: "Bad", effectiveStatus: "unconfigured" }),
      ],
      definitions: [speechDefinition],
    });
    expect(candidates.map((candidate) => candidate.id).sort()).toEqual(["int-1", "int-2", "int-3"]);
    expect(candidates.find((candidate) => candidate.id === "int-2")?.ready).toBe(true);
    expect(candidates.find((candidate) => candidate.id === "int-3")?.ready).toBe(false);
  });
});
