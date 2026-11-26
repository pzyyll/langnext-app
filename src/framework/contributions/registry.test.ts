import { expect, test } from "nsh/test";
import cubeIcon from "../../../assets/icons/cube-outline.svg";
import type { ProtocolDefinition } from "../../modules/ai/contracts/protocol";
import type { ProviderDefinition } from "../../modules/ai/contracts/provider";
import type { ProviderPresentation } from "../../modules/ai/ui/contracts";
import type { CapabilityChannelContribution, CapabilityId } from "./contracts";
import { ContributionError, createContributionRegistry } from "./registry";

function exampleProtocol(id = "example:protocol"): ProtocolDefinition {
  return {
    id,
    labelKey: "ai.protocol.example",
    resolveTarget: () => ({ method: "GET", url: "https://example.test/v1/models", headers: {} }),
    listModels: async () => [],
  };
}

function exampleProvider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: "example:provider",
    labelKey: "models.preset.custom",
    allowedProtocolIds: ["example:protocol"],
    defaultProtocolId: "example:protocol",
    defaultBaseUrl: "https://example.test/v1",
    catalogProviderId: null,
    ...overrides,
  };
}

function examplePresentation(providerTypeId = "example:provider"): ProviderPresentation {
  return {
    providerTypeId,
    Settings: (() => null) as unknown as ProviderPresentation["Settings"],
    icon: cubeIcon,
  };
}

function exampleChannel(
  id: string,
  capability: CapabilityId = "tts",
): CapabilityChannelContribution<{ voice: string }, string, string> {
  return {
    id,
    capability,
    labelKey: `settings.example.${id}`,
    icon: cubeIcon,
    configurable: true,
    config: {
      parse: (raw) =>
        typeof raw === "object" && raw !== null && "voice" in raw
          ? (raw as { voice: string })
          : null,
      defaults: () => ({ voice: "default" }),
    },
    credential: null,
    describe: () => id,
    readiness: async () => ({ ready: true }),
    execute: async (_binding, input) => input,
    failureKey: () => null,
  };
}

function expectContributionError(run: () => void, axis: string, id: string): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof ContributionError).toBe(true);
  expect(caught).toMatchObject({ name: "ContributionError", axis, id });
}

test("contributions registry: registers and reads the four axes", () => {
  const registry = createContributionRegistry();
  const protocol = exampleProtocol();
  const provider = exampleProvider();
  const presentation = examplePresentation();
  const tts = exampleChannel("google-cloud", "tts");
  const ocr = exampleChannel("baidu", "ocr");

  registry.registerProtocol(protocol);
  registry.registerProvider(provider);
  registry.registerPresentation(presentation);
  registry.registerCapability(tts);
  registry.registerCapability(ocr);

  expect(registry.get("protocol", "example:protocol")).toBe(protocol);
  expect(registry.get("provider", "example:provider")).toBe(provider);
  expect(registry.get("provider-presentation", "example:provider")).toBe(presentation);
  expect(registry.capabilities("tts").map((entry) => entry.id)).toEqual(["google-cloud"]);
  expect(registry.capabilities("ocr").map((entry) => entry.id)).toEqual(["baidu"]);
  expect(registry.list("capability").map((entry) => entry.id)).toEqual(["google-cloud", "baidu"]);
});

test("contributions registry: rejects blank and duplicate ids", () => {
  const registry = createContributionRegistry();
  registry.registerProtocol(exampleProtocol());

  expectContributionError(() => registry.registerProtocol(exampleProtocol("  ")), "protocol", "  ");
  expectContributionError(
    () => registry.registerProtocol(exampleProtocol()),
    "protocol",
    "example:protocol",
  );
  expectContributionError(() => registry.registerCapability(exampleChannel("")), "capability", "");
  registry.registerCapability(exampleChannel("google-cloud"));
  expectContributionError(
    () => registry.registerCapability(exampleChannel("google-cloud")),
    "capability",
    "google-cloud",
  );
});

test("contributions registry: unknown lookups name the axis and id", () => {
  const registry = createContributionRegistry();

  expectContributionError(() => registry.get("protocol", "missing"), "protocol", "missing");
  expect(registry.find("provider", "missing")).toBeNull();
  expectContributionError(
    () => registry.get("provider-presentation", "missing"),
    "provider-presentation",
    "missing",
  );
});

test("contributions registry: diagnostics report cross-axis inconsistencies", () => {
  const registry = createContributionRegistry();
  registry.registerProtocol(exampleProtocol());
  registry.registerProvider(
    exampleProvider({
      allowedProtocolIds: ["example:protocol", "example:missing"],
      catalogProtocolId: "example:catalog-missing",
    }),
  );
  registry.registerCapability(exampleChannel("orphan", "audio" as unknown as CapabilityId));

  const diagnostics = registry.diagnostics();
  const codes = diagnostics.map((entry) => entry.code);
  expect(codes.includes("unknown_protocol")).toBe(true);
  expect(codes.includes("missing_presentation")).toBe(true);
  expect(codes.includes("invalid_capability")).toBe(true);
  expect(diagnostics.some((entry) => entry.message.includes("example:missing"))).toBe(true);
  expect(diagnostics.some((entry) => entry.id === "orphan")).toBe(true);
});

test("contributions registry: consistent assembly reports no diagnostics", () => {
  const registry = createContributionRegistry();
  registry.registerProtocol(exampleProtocol());
  registry.registerProvider(exampleProvider());
  registry.registerPresentation(examplePresentation());
  registry.registerCapability(exampleChannel("google-cloud"));

  expect(registry.diagnostics()).toEqual([]);
});
test("contributions registry: capability lookup is scoped to one capability", () => {
  const registry = createContributionRegistry();
  const tts = exampleChannel("google-cloud", "tts");
  const ocr = exampleChannel("google-cloud", "ocr");
  registry.registerCapability(tts);
  registry.registerCapability(ocr);

  expect(registry.findCapability("tts", "google-cloud")).toBe(tts);
  expect(registry.findCapability("ocr", "google-cloud")).toBe(ocr);
  expect(registry.findCapability("detect", "google-cloud")).toBeNull();
  expect(registry.capabilities("detect")).toEqual([]);
});
