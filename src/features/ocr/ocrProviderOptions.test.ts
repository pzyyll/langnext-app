// ABOUTME: Unit tests for OCR create options and plugin rebind candidate helpers.
// ABOUTME: Covers static Baidu/AI options and ocr.image@1 integration filtering.
import { describe, expect, mock, test } from "bun:test";
import type { IntegrationInstanceDto, ServiceIntegrationManifest } from "../../storage/types";

// unplugin-icons virtual modules are unavailable under bun:test.
mock.module("~icons/svgs/baiducloud", () => ({ default: () => null }));
mock.module("~icons/ri/ai", () => ({ default: () => null }));
mock.module("~icons/svgs/google-cloud", () => ({ default: () => null }));

const {
  OCR_IMAGE_CAPABILITY_ID,
  buildOcrProviderCreateOptions,
  getOcrProviderOption,
  listCompatibleOcrRebindCandidates,
} = await import("./ocrProviderOptions");

function instance(overrides: Partial<IntegrationInstanceDto>): IntegrationInstanceDto {
  return {
    id: "int-1",
    pluginId: "com.langnext.google-cloud",
    pluginVersion: "1.0.0",
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

const visionDefinition: ServiceIntegrationManifest = {
  manifestVersion: 1,
  pluginApiVersion: "1",
  id: "com.langnext.google-cloud",
  version: "1.0.0",
  displayNameKey: "plugins.googleCloud.name",
  minHostVersion: "0.1.0",
  configSchemaVersion: 1,
  credentialSlots: [],
  endpoints: [],
  capabilities: [
    { id: OCR_IMAGE_CAPABILITY_ID, preferencesSchemaVersion: 1 },
    { id: "translate.text@1", preferencesSchemaVersion: 1 },
  ],
};

describe("getOcrProviderOption", () => {
  test("returns static options for baidu and ai", () => {
    expect(getOcrProviderOption("baidu").id).toBe("baidu");
    expect(getOcrProviderOption("ai").id).toBe("ai");
  });

  test("does not throw for plugin_capability", () => {
    expect(getOcrProviderOption("plugin_capability").id).toBe("plugin_capability");
  });
});

describe("buildOcrProviderCreateOptions", () => {
  test("places baidu and ai first, then ready OCR integrations", () => {
    const options = buildOcrProviderCreateOptions({
      hasEnabledImageModel: true,
      instances: [
        instance({ id: "int-b", displayName: "B", effectiveStatus: "ready" }),
        instance({ id: "int-a", displayName: "A", effectiveStatus: "degraded" }),
      ],
      definitions: [visionDefinition],
    });
    expect(options.map((option) => option.id)).toEqual(["baidu", "ai", "integration:int-a", "integration:int-b"]);
    expect(options[0]?.disabled).toBe(false);
    expect(options[1]?.disabled).toBe(false);
    expect(options.find((option) => option.id === "integration:int-a")?.disabled).toBe(true);
    expect(options.find((option) => option.id === "integration:int-b")?.disabled).toBe(false);
    expect(options.find((option) => option.id === "integration:int-b")?.ocrCapabilityId).toBe(OCR_IMAGE_CAPABILITY_ID);
  });

  test("disables ai while models are pending", () => {
    const options = buildOcrProviderCreateOptions({
      hasEnabledImageModel: false,
      modelsPending: true,
      instances: [],
      definitions: [],
    });
    expect(options.find((option) => option.kind === "ai")?.disabled).toBe(true);
  });
});

describe("listCompatibleOcrRebindCandidates", () => {
  test("returns ready candidates with matching ocr.image major", () => {
    const candidates = listCompatibleOcrRebindCandidates({
      currentInstanceId: "int-1",
      ocrCapabilityId: OCR_IMAGE_CAPABILITY_ID,
      instances: [
        instance({ id: "int-1", displayName: "Current" }),
        instance({ id: "int-2", displayName: "Other", effectiveStatus: "ready" }),
        instance({ id: "int-3", displayName: "Bad", effectiveStatus: "unconfigured" }),
      ],
      definitions: [visionDefinition],
    });
    expect(candidates.map((c) => c.id).sort()).toEqual(["int-1", "int-2", "int-3"]);
    expect(candidates.find((c) => c.id === "int-2")?.ready).toBe(true);
    expect(candidates.find((c) => c.id === "int-3")?.ready).toBe(false);
  });
});
