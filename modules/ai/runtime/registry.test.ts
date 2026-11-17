import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import type { ProtocolDefinition } from "../contracts/protocol";
import type { ProviderDefinition } from "../contracts/provider";
import { createAiRegistry } from "./registry";

function exampleProtocol(id = "example:protocol"): ProtocolDefinition {
  return {
    id,
    labelKey: "ai.protocol.example",
    resolveTarget: () => ({
      method: "GET",
      url: "https://example.test/v1/models",
      headers: { Accept: "application/json" },
    }),
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

function expectInvalidRequest(run: () => void, message: string): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    name: "ProviderProtocolError",
    kind: "invalid_request",
    message,
  });
}

test("ai registry: accepts an external protocol and provider ID", () => {
  const registry = createAiRegistry();
  const protocol = exampleProtocol();
  const provider = exampleProvider();

  registry.registerProtocol(protocol);
  registry.registerProvider(provider);

  expect(registry.getProtocol("example:protocol")).toBe(protocol);
  expect(registry.getProvider("example:provider")).toEqual(provider);
  expect(registry.getProvider("example:provider").defaultProtocolId).toBe("example:protocol");
  expect(registry.listProtocols()).toEqual([protocol]);
  expect(registry.listProviders()).toEqual([provider]);
  expect(registry.isProtocolAllowed("example:provider", "example:protocol")).toBe(true);
  expect(registry.isProtocolAllowed("example:provider", "openai-compatible")).toBe(false);
});

test("ai registry: lists definitions in registration order", () => {
  const registry = createAiRegistry();
  registry.registerProtocol(exampleProtocol("example:first"));
  registry.registerProtocol(exampleProtocol("example:second"));
  registry.registerProvider(
    exampleProvider({
      id: "example:one",
      allowedProtocolIds: ["example:first"],
      defaultProtocolId: "example:first",
    }),
  );
  registry.registerProvider(
    exampleProvider({
      id: "example:two",
      allowedProtocolIds: ["example:second"],
      defaultProtocolId: "example:second",
    }),
  );

  expect(registry.listProtocols().map((item) => item.id)).toEqual([
    "example:first",
    "example:second",
  ]);
  expect(registry.listProviders().map((item) => item.id)).toEqual(["example:one", "example:two"]);
});

test("ai registry: rejects empty module IDs", () => {
  const registry = createAiRegistry();

  expectInvalidRequest(
    () => registry.registerProtocol(exampleProtocol("")),
    t("ai.error.unknownProtocol", { id: "" }),
  );
  expectInvalidRequest(
    () => registry.registerProvider(exampleProvider({ id: "   " })),
    t("ai.error.invalidProvider", { id: "   " }),
  );
  expect(registry.listProtocols()).toEqual([]);
  expect(registry.listProviders()).toEqual([]);
});

test("ai registry: rejects duplicate protocol and provider IDs", () => {
  const registry = createAiRegistry();
  registry.registerProtocol(exampleProtocol());
  expectInvalidRequest(
    () => registry.registerProtocol(exampleProtocol()),
    t("ai.error.duplicateModule", { id: "example:protocol" }),
  );

  registry.registerProvider(exampleProvider());
  expectInvalidRequest(
    () => registry.registerProvider(exampleProvider()),
    t("ai.error.duplicateModule", { id: "example:provider" }),
  );
});

test("ai registry: unknown lookups fail explicitly", () => {
  const registry = createAiRegistry();
  registry.registerProtocol(exampleProtocol());
  registry.registerProvider(exampleProvider());

  expectInvalidRequest(
    () => registry.getProtocol("example:missing"),
    t("ai.error.unknownProtocol", { id: "example:missing" }),
  );
  expectInvalidRequest(
    () => registry.getProvider("example:missing"),
    t("ai.error.unknownProvider", { id: "example:missing" }),
  );
  expectInvalidRequest(
    () => registry.isProtocolAllowed("example:missing", "example:protocol"),
    t("ai.error.unknownProvider", { id: "example:missing" }),
  );
});

test("ai registry: rejects unknown protocol references", () => {
  const registry = createAiRegistry();
  registry.registerProtocol(exampleProtocol());

  expectInvalidRequest(
    () =>
      registry.registerProvider(
        exampleProvider({ allowedProtocolIds: ["example:protocol", "example:missing"] }),
      ),
    t("ai.error.unknownProtocol", { id: "example:missing" }),
  );
});

test("ai registry: rejects an invalid default protocol and an empty allowlist", () => {
  const registry = createAiRegistry();
  registry.registerProtocol(exampleProtocol());
  registry.registerProtocol(exampleProtocol("example:other"));

  expectInvalidRequest(
    () => registry.registerProvider(exampleProvider({ defaultProtocolId: "example:other" })),
    t("ai.error.invalidProvider", { id: "example:provider" }),
  );
  expectInvalidRequest(
    () => registry.registerProvider(exampleProvider({ allowedProtocolIds: [] })),
    t("ai.error.invalidProvider", { id: "example:provider" }),
  );
});

test("ai registry: rejects an unregistered fixed catalog protocol", () => {
  const registry = createAiRegistry();
  registry.registerProtocol(exampleProtocol());

  expectInvalidRequest(
    () => registry.registerProvider(exampleProvider({ catalogProtocolId: "example:chat" })),
    t("ai.error.unknownProtocol", { id: "example:chat" }),
  );
});
