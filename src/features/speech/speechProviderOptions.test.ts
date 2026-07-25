// ABOUTME: Unit tests for Speech create options and rebind candidate helpers.
// ABOUTME: Covers speech.synthesize@1 integration filtering and readiness.
import { describe, expect, mock, test } from "bun:test";
import type { IntegrationInstanceDto, ServiceIntegrationManifest } from "../../storage/types";
import { EDGE_TTS_PLUGIN_ID } from "../../storage/types";

// unplugin-icons virtual modules are unavailable under bun:test.
mock.module("~icons/svgs/google-cloud", () => ({ default: () => null }));
mock.module("~icons/svgs/edge", () => ({ default: () => null }));

const {
  SPEECH_SYNTHESIZE_CAPABILITY_ID,
  buildSpeechProviderCreateOptions,
  defaultEdgeTtsPreferences,
  defaultGoogleTtsPreferences,
  listCompatibleSpeechRebindCandidates,
} = await import("./speechProviderOptions");

function instance(overrides: Partial<IntegrationInstanceDto>): IntegrationInstanceDto {
  return {
    id: "int-1",
    pluginId: "com.langnext.google-cloud",
    pluginVersion: "1.2.0",
    displayName: "Cloud A",
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

const ttsDefinition: ServiceIntegrationManifest = {
  manifestVersion: 1,
  pluginApiVersion: "1",
  id: "com.langnext.google-cloud",
  version: "1.2.0",
  displayNameKey: "plugins.googleCloud.name",
  minHostVersion: "0.1.0",
  configSchemaVersion: 1,
  credentialSlots: [],
  endpoints: [],
  capabilities: [
    { id: SPEECH_SYNTHESIZE_CAPABILITY_ID, preferencesSchemaVersion: 1 },
    { id: "ocr.image@1", preferencesSchemaVersion: 1 },
  ],
};

const visionOnlyDefinition: ServiceIntegrationManifest = {
  ...ttsDefinition,
  id: "com.langnext.other",
  capabilities: [{ id: "ocr.image@1", preferencesSchemaVersion: 1 }],
};

describe("defaultGoogleTtsPreferences", () => {
  test("returns schema v1 speakingRate and pitch defaults", () => {
    expect(defaultGoogleTtsPreferences()).toEqual({ speakingRate: 1.0, pitch: 0.0 });
  });
});

describe("defaultEdgeTtsPreferences", () => {
  test("returns schema v1 voice, speed, pitch, and style defaults", () => {
    expect(defaultEdgeTtsPreferences()).toEqual({
      voice: "zh-CN-XiaoxiaoNeural",
      speed: 1.0,
      pitch: 0,
      style: "general",
    });
  });
});

describe("buildSpeechProviderCreateOptions", () => {
  test("lists Speech-capable integrations ordered by name then id", () => {
    const options = buildSpeechProviderCreateOptions({
      instances: [
        instance({ id: "int-b", displayName: "B", effectiveStatus: "ready" }),
        instance({ id: "int-a", displayName: "A", effectiveStatus: "degraded" }),
      ],
      definitions: [ttsDefinition],
    });
    expect(options.map((option) => option.id)).toEqual(["integration:int-a", "integration:int-b"]);
    expect(options.find((option) => option.id === "integration:int-a")?.disabled).toBe(true);
    expect(options.find((option) => option.id === "integration:int-b")?.disabled).toBe(false);
    expect(options.find((option) => option.id === "integration:int-b")?.capabilityId).toBe(
      SPEECH_SYNTHESIZE_CAPABILITY_ID,
    );
  });

  test("excludes integrations without speech.synthesize capability", () => {
    const options = buildSpeechProviderCreateOptions({
      instances: [
        instance({ id: "int-1", pluginId: "com.langnext.other", displayName: "Other" }),
        instance({ id: "int-2", displayName: "Cloud" }),
      ],
      definitions: [ttsDefinition, visionOnlyDefinition],
    });
    expect(options.map((option) => option.id)).toEqual(["integration:int-2"]);
  });

  test("includes plugin-missing Google Cloud instances as disabled", () => {
    const options = buildSpeechProviderCreateOptions({
      instances: [
        instance({
          id: "int-missing",
          displayName: "Missing",
          effectiveStatus: "plugin_missing",
          enabled: false,
        }),
      ],
      definitions: [],
    });
    expect(options).toHaveLength(1);
    expect(options[0]?.disabled).toBe(true);
  });

  test("includes ready Edge TTS integrations as enabled create options", () => {
    const edgeDefinition: ServiceIntegrationManifest = {
      ...ttsDefinition,
      id: EDGE_TTS_PLUGIN_ID,
      capabilities: [{ id: SPEECH_SYNTHESIZE_CAPABILITY_ID, preferencesSchemaVersion: 1 }],
    };
    const options = buildSpeechProviderCreateOptions({
      instances: [
        instance({ id: "int-edge", pluginId: EDGE_TTS_PLUGIN_ID, displayName: "Edge A" }),
        instance({
          id: "int-edge-missing",
          pluginId: EDGE_TTS_PLUGIN_ID,
          displayName: "Edge Missing",
          effectiveStatus: "plugin_missing",
          enabled: false,
        }),
      ],
      definitions: [edgeDefinition],
    });
    expect(options.map((option) => option.id)).toEqual(["integration:int-edge", "integration:int-edge-missing"]);
    expect(options.find((option) => option.id === "integration:int-edge")?.disabled).toBe(false);
    expect(options.find((option) => option.id === "integration:int-edge-missing")?.disabled).toBe(true);
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
      definitions: [ttsDefinition],
    });
    expect(candidates.map((c) => c.id).sort()).toEqual(["int-1", "int-2", "int-3"]);
    expect(candidates.find((c) => c.id === "int-2")?.ready).toBe(true);
    expect(candidates.find((c) => c.id === "int-3")?.ready).toBe(false);
  });
});
