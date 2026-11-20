import { expect, open, test } from "nsh/test";
import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../../modules/ai/contracts/errors";
import { aiRegistry } from "../../modules/ai/runtime/registry";
import { initializeAiModules } from "../../app/ai-setup";
import { makeChannel, makeModel, makeSeedStorage } from "../models/__tests__/fixtures";
import type { SavedModelRequestResolution } from "../models/store";
import { PRESETS_STORAGE_KEY } from "../presets/store";
import { getLanguageLabel } from "../presets/languages";
import type { TranslationPreset } from "../presets/types";
import {
  resolvePresetTemplate,
  translateWithPreset,
  type TranslateWithPresetOptions,
} from "./translate";

initializeAiModules();

function makePreset(overrides: Partial<TranslationPreset> = {}): TranslationPreset {
  return {
    id: "preset-1",
    name: "Default EN to ZH",
    enabled: true,
    sourceLanguage: "en",
    targetLanguage: "zh",
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    engine: {
      kind: "ai",
      modelIds: ["model-uuid-1"],
      temperature: null,
      maxOutputTokens: null,
      disableReasoning: true,
      templates: [
        {
          id: "tpl-default",
          name: "Default",
          systemTemplate:
            "Translate from {{source_language}} to {{target_language}}. Preserve formatting.",
          userTemplate: "Text:\n{{text}}",
        },
      ],
      defaultTemplateId: "tpl-default",
    },
    ...overrides,
  };
}

function makeReadyResolution(modelId: string, modelKey: string): SavedModelRequestResolution {
  return {
    ok: true,
    modelId,
    modelKey,
    connection: {
      providerTypeId: "openai",
      protocolId: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      credential: "sk-test",
    },
  };
}

test("preset translation: saved preset sends exact prompt, leaves braces literal, and uses model key", async () => {
  const channel = makeChannel({
    id: "ch-1",
    presetId: "openai",
    adapterId: "openai-compatible",
    baseUrl: null,
    hasCredential: true,
    enabled: true,
  });
  const model = makeModel({
    id: "uuid-model-1",
    providerId: "ch-1",
    modelKey: "gpt-4.1-mini",
    enabled: true,
  });
  const preset = makePreset({
    sourceLanguage: "en",
    targetLanguage: "zh",
    engine: {
      kind: "ai",
      modelIds: ["uuid-model-1"],
      temperature: 0.2,
      maxOutputTokens: 256,
      disableReasoning: true,
      templates: [
        {
          id: "tpl-default",
          name: "Default",
          systemTemplate: "From {{source_language}} to {{target_language}}",
          userTemplate: "Translate: {{text}}",
        },
      ],
      defaultTemplateId: "tpl-default",
    },
  });

  const seed = makeSeedStorage({
    channels: [channel],
    models: [model],
    credentials: { "ch-1": "sk-real-secret" },
  });
  seed[PRESETS_STORAGE_KEY] = JSON.stringify({ version: 1, items: [preset] });

  const app = await open("./__tests__/translate-app.tsx", {
    platform: "windows",
    storage: seed,
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: {
          choices: [{ message: { content: "你好 {{target_language}}" } }],
        },
      },
    },
  });

  await app.waitUntil(() => app.texts()[0] !== "running");
  expect(app.texts()[0]).toBe("done");

  const outcome = JSON.parse(app.texts()[1]!);
  expect(outcome).toEqual({
    ok: true,
    text: "你好 {{target_language}}",
    modelId: "uuid-model-1",
    templateId: "tpl-default",
  });

  const requests = app.requests();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
  expect(requests[0]!.headers?.authorization).toBe("Bearer sk-real-secret");
  const body = JSON.parse(requests[0]!.body ?? "{}") as {
    model: string;
    temperature?: number;
    max_completion_tokens?: number;
    messages: Array<{ role: string; content: string }>;
  };
  expect(body.model).toBe("gpt-4.1-mini");
  expect(body.temperature).toBe(0.2);
  expect(body.max_completion_tokens).toBe(256);
  expect(body.messages).toEqual([
    {
      role: "system",
      content: `From ${getLanguageLabel("en")} to ${getLanguageLabel("zh")}`,
    },
    {
      role: "user",
      content: "Translate: Hello {{target_language}}",
    },
  ]);
});

test("preset translation: renders the caller's resolved pair and uses its model key", async () => {
  const captured: Array<{ system: string; user: string; modelId: string }> = [];
  const preset = makePreset({ sourceLanguage: "en", targetLanguage: "zh" });

  const result = await translateWithPreset(
    {
      preset,
      sourceText: "Bonjour $& {{text}}",
      sourceLanguage: "ja",
      targetLanguage: "de",
    },
    {
      resolveModelRequest: async (id) => makeReadyResolution(id, "gpt-4.1"),
      streamText: async (_conn, req, options) => {
        captured.push({ system: req.system, user: req.user, modelId: req.modelId });
        options.onText("こんにちは");
        return "こんにちは";
      },
    },
  );

  expect(result).toEqual({
    ok: true,
    text: "こんにちは",
    modelId: "model-uuid-1",
    templateId: "tpl-default",
  });
  expect(captured).toHaveLength(1);
  expect(captured[0]!.modelId).toBe("gpt-4.1");
  expect(captured[0]!.system).toContain(getLanguageLabel("ja"));
  expect(captured[0]!.system).toContain(getLanguageLabel("de"));
  expect(captured[0]!.user).toBe("Text:\nBonjour $& {{text}}");
});

test("preset translation: streams partial text and forwards the preset reasoning choice", async () => {
  const requests: Array<{ disableReasoning?: boolean }> = [];
  const partials: string[] = [];

  const result = await translateWithPreset(
    { preset: makePreset(), sourceText: "Hello", sourceLanguage: "en", targetLanguage: "zh" },
    {
      resolveModelRequest: async (id) => makeReadyResolution(id, "gpt-4.1"),
      onText: (text) => partials.push(text),
      streamText: async (_conn, req, options) => {
        requests.push({ disableReasoning: req.disableReasoning });
        options.onText("你");
        options.onText("你好");
        return "你好";
      },
    },
  );

  expect(result).toEqual({
    ok: true,
    text: "你好",
    modelId: "model-uuid-1",
    templateId: "tpl-default",
  });
  expect(partials).toEqual(["你", "你好"]);
  expect(requests).toEqual([{ disableReasoning: true }]);

  const keepThinking = makePreset();
  keepThinking.engine.disableReasoning = false;
  requests.length = 0;
  await translateWithPreset(
    { preset: keepThinking, sourceText: "Hello", sourceLanguage: "en", targetLanguage: "zh" },
    {
      resolveModelRequest: async (id) => makeReadyResolution(id, "gpt-4.1"),
      streamText: async (_conn, req, options) => {
        requests.push({ disableReasoning: req.disableReasoning });
        options.onText("ok");
        return "ok";
      },
    },
  );
  expect(requests).toEqual([{ disableReasoning: false }]);
});

test("preset translation: rejects blank input, disabled preset, and missing template without a request", async () => {
  let calls = 0;
  const deps: TranslateWithPresetOptions = {
    resolveModelRequest: async (id: string) => {
      calls += 1;
      return makeReadyResolution(id, "gpt-4.1");
    },
    streamText: async (_conn, _req, options) => {
      calls += 1;
      options.onText("unexpected");
      return "unexpected";
    },
  };

  const blankRes = await translateWithPreset(
    { preset: makePreset(), sourceText: "   \n\t  ", sourceLanguage: "en", targetLanguage: "zh" },
    deps,
  );
  expect(blankRes).toMatchObject({
    ok: false,
    cancelled: false,
    error: t("quickTranslate.error.blankInput"),
  });

  const disabledRes = await translateWithPreset(
    {
      preset: makePreset({ enabled: false }),
      sourceText: "Hello",
      sourceLanguage: "en",
      targetLanguage: "zh",
    },
    deps,
  );
  expect(disabledRes).toMatchObject({
    ok: false,
    cancelled: false,
    error: t("quickTranslate.error.presetDisabled"),
  });

  const badTemplatePreset = makePreset();
  badTemplatePreset.engine.defaultTemplateId = "missing-template";
  const missingTemplateRes = await translateWithPreset(
    { preset: badTemplatePreset, sourceText: "Hello", sourceLanguage: "en", targetLanguage: "zh" },
    deps,
  );
  expect(missingTemplateRes).toMatchObject({
    ok: false,
    cancelled: false,
    error: t("quickTranslate.error.missingTemplate"),
  });

  expect(calls).toBe(0);
});

test("preset translation: resolveSavedModelRequest skips disabled, missing, non-text, unsupported, and unconfirmed HTTP", async () => {
  const chDisabled = makeChannel({ id: "ch-dis", enabled: false });
  const chOk = makeChannel({
    id: "ch-ok",
    presetId: "openai",
    adapterId: "openai-compatible",
    enabled: true,
  });
  const chBadProtocol = makeChannel({
    id: "ch-bad",
    presetId: "anthropic",
    adapterId: "openai-compatible",
    enabled: true,
  });
  const chHttpUnconfirmed = makeChannel({
    id: "ch-http-no",
    presetId: "custom",
    adapterId: "openai-compatible",
    baseUrl: "http://proxy.example.com/v1",
    insecureHttpConfirmedAt: null,
    enabled: true,
  });
  const chHttpConfirmed = makeChannel({
    id: "ch-http-yes",
    presetId: "custom",
    adapterId: "openai-compatible",
    baseUrl: "http://proxy.example.com/v1",
    insecureHttpConfirmedAt: "2026-11-19T00:00:00.000Z",
    enabled: true,
  });

  const models = [
    makeModel({ id: "m-ch-dis", providerId: "ch-dis", modelKey: "k1", enabled: true }),
    makeModel({ id: "m-dis", providerId: "ch-ok", modelKey: "k2", enabled: false }),
    makeModel({
      id: "m-miss",
      providerId: "ch-ok",
      modelKey: "k3",
      enabled: true,
      syncStatus: "missing",
    }),
    makeModel({
      id: "m-nontext",
      providerId: "ch-ok",
      modelKey: "k4",
      enabled: true,
      capabilities: { text: false, image: true, pdf: false, video: false },
    }),
    makeModel({ id: "m-badproto", providerId: "ch-bad", modelKey: "k5", enabled: true }),
    makeModel({ id: "m-http-no", providerId: "ch-http-no", modelKey: "k6", enabled: true }),
    makeModel({
      id: "m-http-yes",
      providerId: "ch-http-yes",
      modelKey: "k-http-ok",
      enabled: true,
    }),
  ];

  const seed = makeSeedStorage({
    channels: [chDisabled, chOk, chBadProtocol, chHttpUnconfirmed, chHttpConfirmed],
    models,
    credentials: {
      "ch-http-no": "sk-should-not-send",
      "ch-http-yes": "sk-http-ok",
    },
  });

  const preset = makePreset({
    engine: {
      kind: "ai",
      modelIds: [
        "m-deleted",
        "m-ch-dis",
        "m-dis",
        "m-miss",
        "m-nontext",
        "m-badproto",
        "m-http-no",
        "m-http-yes",
      ],
      temperature: null,
      maxOutputTokens: null,
      disableReasoning: true,
      templates: [
        {
          id: "tpl-default",
          name: "Default",
          systemTemplate: "{{source_language}}->{{target_language}}",
          userTemplate: "{{text}}",
        },
      ],
      defaultTemplateId: "tpl-default",
    },
  });
  seed[PRESETS_STORAGE_KEY] = JSON.stringify({ version: 1, items: [preset] });

  const app = await open("./__tests__/translate-app.tsx", {
    platform: "windows",
    storage: seed,
    network: {
      "POST http://proxy.example.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "已翻译" } }] },
      },
    },
  });

  await app.waitUntil(() => app.texts()[0] !== "running");
  const outcome = JSON.parse(app.texts()[1]!);
  expect(outcome).toEqual({
    ok: true,
    text: "已翻译",
    modelId: "m-http-yes",
    templateId: "tpl-default",
  });
  const requests = app.requests();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers?.authorization).toBe("Bearer sk-http-ok");
});

test("preset translation: follows fallback chain unavailable -> 429 -> success and stops on 401 and abort", async () => {
  const attempted: string[] = [];
  const presetChain = makePreset({
    engine: {
      kind: "ai",
      modelIds: ["m-unavail", "m-429", "m-ok"],
      temperature: null,
      maxOutputTokens: null,
      disableReasoning: true,
      templates: [
        {
          id: "tpl-default",
          name: "Default",
          systemTemplate: "{{source_language}}->{{target_language}}",
          userTemplate: "{{text}}",
        },
      ],
      defaultTemplateId: "tpl-default",
    },
  });

  const chainRes = await translateWithPreset(
    { preset: presetChain, sourceText: "Hello", sourceLanguage: "en", targetLanguage: "zh" },
    {
      resolveModelRequest: async (id) => {
        if (id === "m-unavail") {
          return { ok: false, reason: t("presets.model.reasonModelDisabled") };
        }
        return makeReadyResolution(id, `key-${id}`);
      },
      streamText: async (_conn, req, options) => {
        attempted.push(req.modelId);
        if (req.modelId === "key-m-429") {
          throw new ProviderProtocolError(
            "rate_limited",
            t("protocol.error.rateLimited", { status: 429 }),
            429,
          );
        }
        options.onText("Salut");
        return "Salut";
      },
    },
  );

  expect(chainRes).toEqual({
    ok: true,
    text: "Salut",
    modelId: "m-ok",
    templateId: "tpl-default",
  });
  expect(attempted).toEqual(["key-m-429", "key-m-ok"]);

  const authAttempted: string[] = [];
  const authRes = await translateWithPreset(
    { preset: presetChain, sourceText: "Hello", sourceLanguage: "en", targetLanguage: "zh" },
    {
      resolveModelRequest: async (id) => makeReadyResolution(id, `key-${id}`),
      streamText: async (_conn, req) => {
        authAttempted.push(req.modelId);
        throw new ProviderProtocolError("auth", t("protocol.error.auth", { status: 401 }), 401);
      },
    },
  );
  expect(authRes).toEqual({
    ok: false,
    cancelled: false,
    error: t("protocol.error.auth", { status: 401 }),
  });
  expect(authAttempted).toEqual(["key-m-unavail"]);

  const controller = new AbortController();
  const abortAttempted: string[] = [];
  const abortedRes = await translateWithPreset(
    { preset: presetChain, sourceText: "Hello", sourceLanguage: "en", targetLanguage: "zh" },
    {
      signal: controller.signal,
      resolveModelRequest: async (id) => makeReadyResolution(id, `key-${id}`),
      streamText: async (_conn, req) => {
        abortAttempted.push(req.modelId);
        controller.abort();
        throw new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
      },
    },
  );
  expect(abortedRes).toEqual({
    ok: false,
    cancelled: true,
    error: t("protocol.error.cancelled"),
  });
  expect(abortAttempted).toEqual(["key-m-unavail"]);
  expect(aiRegistry.listProtocols().length).toBeGreaterThan(0);
});

test("preset translation: returns localized actionable failure when all chain models fail", async () => {
  const preset = makePreset({
    engine: {
      kind: "ai",
      modelIds: ["m-timeout", "m-500"],
      temperature: null,
      maxOutputTokens: null,
      disableReasoning: true,
      templates: [
        {
          id: "tpl-default",
          name: "Default",
          systemTemplate: "{{source_language}}->{{target_language}}",
          userTemplate: "{{text}}",
        },
      ],
      defaultTemplateId: "tpl-default",
    },
  });

  const res = await translateWithPreset(
    { preset, sourceText: "Hello", sourceLanguage: "en", targetLanguage: "zh" },
    {
      resolveModelRequest: async (id) => makeReadyResolution(id, `key-${id}`),
      streamText: async (_conn, req) => {
        if (req.modelId === "key-m-timeout") {
          throw new ProviderProtocolError("timeout", t("protocol.error.timeout"));
        }
        throw new ProviderProtocolError("server", t("protocol.error.server", { status: 503 }), 503);
      },
    },
  );

  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.cancelled).toBe(false);
    expect(res.error).toContain(t("protocol.error.server", { status: 503 }));
  }
});

test("template override: executes non-default template verbatim without cross-template leaks and resolves removed override safely", async () => {
  const preset = makePreset({
    engine: {
      kind: "ai",
      modelIds: ["model-uuid-1"],
      temperature: null,
      maxOutputTokens: null,
      disableReasoning: true,
      templates: [
        {
          id: "tpl-default",
          name: "Default",
          systemTemplate: "Default {{source_language}}->{{target_language}}",
          userTemplate: "Default: {{text}}",
        },
        {
          id: "tpl-formal",
          name: "Formal",
          systemTemplate: "Formal {{source_language}} to {{target_language}}",
          userTemplate: "FormalText:\n{{text}}",
        },
      ],
      defaultTemplateId: "tpl-default",
    },
  });

  const resolvedOverride = resolvePresetTemplate(preset, "tpl-formal");
  expect(resolvedOverride).toMatchObject({
    fellBackToDefault: false,
    template: { id: "tpl-formal" },
  });
  const resolvedFallback = resolvePresetTemplate(preset, "tpl-deleted");
  expect(resolvedFallback).toMatchObject({
    fellBackToDefault: true,
    template: { id: "tpl-default" },
  });

  let capturedSystem = "";
  let capturedUser = "";
  const outcome = await translateWithPreset(
    {
      preset,
      sourceText: "Keep {{target_language}} literal",
      sourceLanguage: "en",
      targetLanguage: "ja",
      templateId: "tpl-formal",
    },
    {
      resolveModelRequest: async (id) => makeReadyResolution(id, "gpt-4o"),
      streamText: async (_conn, req, options) => {
        capturedSystem = req.system;
        capturedUser = req.user;
        options.onText("Keigo result");
        return "Keigo result";
      },
    },
  );

  expect(outcome).toEqual({
    ok: true,
    text: "Keigo result",
    modelId: "model-uuid-1",
    templateId: "tpl-formal",
  });
  expect(capturedSystem).toBe(`Formal ${getLanguageLabel("en")} to ${getLanguageLabel("ja")}`);
  expect(capturedUser).toBe("FormalText:\nKeep {{target_language}} literal");
});
