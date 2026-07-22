// ABOUTME: Tests for translation context resolution and non-stream early failures.
// ABOUTME: Covers missing models, history-once readiness, and prompt precedence inputs.
import { describe, expect, test } from "bun:test";
import type { ProviderInstanceDto, ProviderModelDto, TranslationProfileDto } from "../../storage/types";
import { registerBuiltinProviderPlugins } from "../providers/builtin";
import { resolveTranslationContext } from "./translationContext";
import { runTranslationNonStream } from "./translationWorkflow";

registerBuiltinProviderPlugins();

function provider(
  partial: Partial<ProviderInstanceDto> & Pick<ProviderInstanceDto, "id" | "adapterId">,
): ProviderInstanceDto {
  return {
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
    createdAt: "t",
    updatedAt: "t",
    ...partial,
  };
}

function model(
  partial: Partial<ProviderModelDto> & Pick<ProviderModelDto, "id" | "providerInstanceId" | "modelKey">,
): ProviderModelDto {
  return {
    source: "manual",
    remoteDisplayName: null,
    displayNameOverride: "Display",
    enabled: true,
    availability: "available",
    remoteMetadataJson: null,
    capabilityOverridesJson: null,
    adapterId: null,
    lastSeenAt: null,
    createdAt: "t",
    updatedAt: "t",
    ...partial,
  };
}

describe("resolveTranslationContext", () => {
  test("returns early validation for empty text", () => {
    const ctx = resolveTranslationContext(
      { modelId: "m1", sourceLang: "en", targetLang: "zh", text: "  " },
      { providersById: new Map(), modelsById: new Map(), profile: null },
    );
    expect(ctx.earlyFailure?.errorCode).toBe("validation_failed");
  });

  test("builds attempt with display snapshots", () => {
    const p = provider({ id: "p1", adapterId: "openai-compatible", displayName: "OpenAI" });
    const m = model({
      id: "m1",
      providerInstanceId: "p1",
      modelKey: "gpt-4o-mini",
      displayNameOverride: "Mini",
    });
    const ctx = resolveTranslationContext(
      { modelId: "m1", sourceLang: "en", targetLang: "zh", text: "hello" },
      {
        providersById: new Map([["p1", p]]),
        modelsById: new Map([["m1", m]]),
        profile: null,
      },
    );
    expect(ctx.earlyFailure).toBeUndefined();
    expect(ctx.attempts).toHaveLength(1);
    expect(ctx.attempts[0]?.modelDisplayName).toBe("Mini");
    expect(ctx.attempts[0]?.providerDisplayName).toBe("OpenAI");
  });

  test("includes profile fallback targets and profile name", () => {
    const p = provider({ id: "p1", adapterId: "openai-compatible" });
    const m1 = model({ id: "m1", providerInstanceId: "p1", modelKey: "a" });
    const m2 = model({ id: "m2", providerInstanceId: "p1", modelKey: "b" });
    const profile = {
      id: "prof1",
      name: "Work",
      enabled: true,
      templateVersion: 1,
      defaultPromptTemplateId: "t1",
      temperature: 0.1,
      maxOutputTokens: 1000,
      providerOptionsJson: null,
      createdAt: "t",
      updatedAt: "t",
      targets: [
        { translationProfileId: "prof1", providerModelId: "m1", priority: 0 },
        { translationProfileId: "prof1", providerModelId: "m2", priority: 1 },
      ],
      promptTemplates: [
        {
          id: "t1",
          name: "Default",
          systemTemplate: "S {{sourceLang}}",
          userTemplate: "{{text}}",
        },
      ],
    } as TranslationProfileDto;
    const ctx = resolveTranslationContext(
      {
        modelId: "m1",
        sourceLang: "en",
        targetLang: "zh",
        text: "hi",
        profileId: "prof1",
      },
      {
        providersById: new Map([["p1", p]]),
        modelsById: new Map([
          ["m1", m1],
          ["m2", m2],
        ]),
        profile,
      },
    );
    expect(ctx.attempts.map((a) => a.modelId)).toEqual(["m1", "m2"]);
    expect(ctx.profileName).toBe("Work");
    expect(ctx.systemPrompt).toContain("en");
    expect(ctx.userPrompt).toBe("hi");
  });
});

describe("runTranslationNonStream", () => {
  test("returns early failure without network when no attempts", async () => {
    const result = await runTranslationNonStream(
      { modelId: "missing", sourceLang: "en", targetLang: "zh", text: "hello" },
      { providersById: new Map(), modelsById: new Map(), profile: null },
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("validation_failed");
  });
});
