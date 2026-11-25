import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import cubeIcon from "../../../../assets/icons/cube-outline.svg";
import type { ProtocolDefinition } from "../contracts/protocol";
import { createAiRegistry } from "../runtime/registry";
import type { ProviderPresentation } from "./contracts";
import { createProviderSettingsRegistry } from "./registry";

function exampleProtocol(): ProtocolDefinition {
  return {
    id: "example:protocol",
    labelKey: "ai.protocol.openaiChat",
    resolveTarget: () => ({ method: "GET", url: "https://example.test/models", headers: {} }),
    listModels: async () => [],
  };
}

function examplePresentation(providerTypeId = "example:provider"): ProviderPresentation {
  return {
    providerTypeId,
    Settings: (() => null) as unknown as ProviderPresentation["Settings"],
    icon: cubeIcon,
  };
}

function createRuntime() {
  const runtime = createAiRegistry();
  runtime.registerProtocol(exampleProtocol());
  runtime.registerProvider({
    id: "example:provider",
    labelKey: "models.preset.custom",
    allowedProtocolIds: ["example:protocol"],
    defaultProtocolId: "example:protocol",
    defaultBaseUrl: "https://example.test/v1",
    catalogProviderId: null,
  });
  return { runtime, presentations: createProviderSettingsRegistry(runtime) };
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

test("ai registry: registers a presentation for an existing provider", () => {
  const { presentations } = createRuntime();
  const presentation = examplePresentation();

  presentations.register(presentation);

  expect(presentations.get("example:provider")).toBe(presentation);
  expect(presentations.list()).toEqual([presentation]);
  expect(presentations.find("example:missing")).toBeNull();
});

test("ai registry: rejects duplicate presentations", () => {
  const { presentations } = createRuntime();
  presentations.register(examplePresentation());

  expectInvalidRequest(
    () => presentations.register(examplePresentation()),
    t("ai.error.duplicateModule", { id: "example:provider" }),
  );
});

test("ai registry: rejects a presentation without a runtime provider", () => {
  const { presentations } = createRuntime();

  expectInvalidRequest(
    () => presentations.register(examplePresentation("example:missing")),
    t("ai.error.unknownProvider", { id: "example:missing" }),
  );
  expectInvalidRequest(
    () => presentations.get("example:missing"),
    t("ai.error.unknownPresentation", { id: "example:missing" }),
  );
});
