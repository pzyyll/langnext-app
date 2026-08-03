// ABOUTME: Translation execution-context resolution tests for interface provenance.
// ABOUTME: Asserts effective API type = override → source interface → Provider default.
import { describe, expect, test } from "bun:test";
import { registerBuiltinProviderPlugins } from "../providers/builtin";
import { RuntimeProviderExecutor } from "../providers/runtimeExecutor";
import type { ProviderInstanceDto, ProviderModelDto, ProviderRuntimeCatalogEntryDto } from "../../storage/types";
import { resolveTranslationContext } from "./translationContext";

registerBuiltinProviderPlugins();

const CATALOG_ENTRY = {
  pluginId: "com.langnext.provider.gemini",
  version: "1.0.0",
  packageDigest: "digest-2",
  publisher: { keyId: "key-2", keyFingerprint: "fp-2" },
  legacyAliases: ["gemini"],
  capabilities: [
    { capabilityId: "llm.models.list@1", artifactPath: "fixtures/llm-models.wasm", artifactDigest: "c" },
    { capabilityId: "llm.chat@1", artifactPath: "fixtures/llm-chat.wasm", artifactDigest: "d" },
  ],
  detection: null,
} satisfies ProviderRuntimeCatalogEntryDto;

/** Provider whose default API type is legacy while the gemini interface is runtime-bound. */
function sourceInterfaceProvider(): ProviderInstanceDto {
  return {
    id: "p1",
    adapterId: "openai-compatible",
    displayName: "P",
    baseUrl: "https://api.openai.com/v1",
    baseUrlSource: "custom",
    authScheme: { schemaVersion: 1, type: "bearer" },
    credentialKind: "api_key",
    hasCredential: true,
    enabled: true,
    proxyMode: "inherit",
    insecureHttpConfirmedAt: null,
    modelsSyncedAt: null,
    modelsSyncStatus: "never",
    modelsSyncErrorCode: null,
    runtime: {
      adapterId: "openai-compatible",
      runtimeKind: "legacy-frontend-provider",
      packageDigest: null,
      grantSetRevision: null,
      state: "active",
      errorCode: null,
      errorMessage: null,
      updatedAt: "t",
    },
    runtimeBindings: [
      {
        adapterId: "openai-compatible",
        runtimeKind: "legacy-frontend-provider",
        packageDigest: null,
        grantSetRevision: null,
        state: "active",
        errorCode: null,
        errorMessage: null,
        updatedAt: "t",
      },
      {
        adapterId: "gemini",
        runtimeKind: "wasm-component",
        packageDigest: "digest-2",
        grantSetRevision: 1,
        state: "active",
        errorCode: null,
        errorMessage: null,
        updatedAt: "t",
      },
    ],
    createdAt: "t",
    updatedAt: "t",
  };
}

function model(partial: Partial<ProviderModelDto> = {}): ProviderModelDto {
  return {
    id: "m1",
    providerInstanceId: "p1",
    source: "remote",
    modelKey: "gemini-2.0-flash",
    remoteDisplayName: null,
    displayNameOverride: null,
    enabled: true,
    availability: "available",
    remoteMetadataJson: null,
    capabilityOverridesJson: null,
    adapterId: null,
    sourceAdapterId: null,
    lastSeenAt: null,
    createdAt: "t",
    updatedAt: "t",
    ...partial,
  };
}

describe("resolveTranslationContext effective API type", () => {
  test("a synced model without an override selects the runtime executor of its source interface", () => {
    const context = resolveTranslationContext(
      { modelId: "m1", sourceLang: "en", targetLang: "zh", text: "hello" },
      {
        providersById: new Map([["p1", sourceInterfaceProvider()]]),
        modelsById: new Map([["m1", model({ sourceAdapterId: "gemini" })]]),
        profile: null,
        runtimeCatalog: [CATALOG_ENTRY],
      },
    );
    expect(context.kind).toBe("llm");
    if (context.kind !== "llm") {
      throw new Error("expected llm context");
    }
    expect(context.attempts).toHaveLength(1);
    expect(context.attempts[0]?.executor).toBeInstanceOf(RuntimeProviderExecutor);
  });

  test("an explicit model override wins over the source interface", () => {
    const context = resolveTranslationContext(
      { modelId: "m1", sourceLang: "en", targetLang: "zh", text: "hello" },
      {
        providersById: new Map([["p1", sourceInterfaceProvider()]]),
        modelsById: new Map([["m1", model({ sourceAdapterId: "gemini", adapterId: "openai-compatible" })]]),
        profile: null,
        runtimeCatalog: [CATALOG_ENTRY],
      },
    );
    expect(context.kind).toBe("llm");
    if (context.kind !== "llm") {
      throw new Error("expected llm context");
    }
    expect(context.attempts).toHaveLength(1);
    expect(context.attempts[0]?.executor).not.toBeInstanceOf(RuntimeProviderExecutor);
  });
});
