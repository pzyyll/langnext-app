import { beforeEach, expect, test } from "nsh/test";
import type {
  ChannelDescribeHost,
  HostModels,
  HostServices,
} from "../../../framework/integrations";
import { ProviderProtocolError } from "../../../modules/ai/contracts/errors";
import { createLogger } from "../../../services/log";
import { setLocale } from "nsh/i18n";
import { DictionaryChannelError, type DictionaryLookupInput } from "../types";
import { aiDictionaryChannel, type AiDictionaryConfig } from "./ai";

beforeEach(() => {
  setLocale("en");
});

const SAMPLE_CONNECTION = {
  providerTypeId: "openai" as const,
  protocolId: "openai-responses" as const,
  baseUrl: "https://api.example.com/v1",
  credential: "sk-test",
};

function makeBinding(config: AiDictionaryConfig, enabled = true) {
  return {
    enabled,
    configured: config.modelId.trim().length > 0,
    credentialRef: null,
    config,
  };
}

function makeDescribeHost(): ChannelDescribeHost {
  return {
    resolveModelBinding: (modelId) =>
      modelId === "m-ready"
        ? { ok: true, label: "OpenAI / GPT-4o Mini" }
        : { ok: false, reason: "Model missing" },
  };
}

function makeHost(overrides: Partial<HostModels> = {}): HostServices {
  const models: HostModels = {
    resolveSaved: async (modelId) =>
      modelId === "m-ready"
        ? {
            ok: true,
            modelId,
            connection: SAMPLE_CONNECTION,
            modelKey: "gpt-4o-mini",
          }
        : { ok: false, reason: "no_models" },
    generateText: async () =>
      JSON.stringify({
        found: true,
        term: "ephemeral",
        phonetics: [{ label: "US", ipa: "/ɪˈfɛmərəl/" }],
        senses: [{ partOfSpeech: "adj.", glosses: ["短暂的"] }],
      }),
    generateTextFromImage: async () => "",
    ...overrides,
  };

  return {
    credential: null,
    models,
    log: createLogger("test/dictionary-channel"),
  };
}

const SAMPLE_INPUT: DictionaryLookupInput = {
  term: "ephemeral",
  contextSentence: "Fame is ephemeral.",
  sourceLanguage: "en",
  explanationLanguage: "zh",
};

test("dictionary channel: config parse and defaults validate modelId", () => {
  expect(aiDictionaryChannel.config.defaults()).toEqual({ modelId: "" });
  expect(aiDictionaryChannel.config.parse({ modelId: "m-ready" })).toEqual({ modelId: "m-ready" });
  expect(aiDictionaryChannel.config.parse(null)).toBeNull();
  expect(aiDictionaryChannel.config.parse({ modelId: 123 })).toBeNull();
});

test("dictionary channel: describe and readiness reflect saved model state", async () => {
  const describeHost = makeDescribeHost();
  const host = makeHost();

  expect(aiDictionaryChannel.describe(makeBinding({ modelId: "" }), describeHost)).toBe(
    "Not configured",
  );
  expect(aiDictionaryChannel.describe(makeBinding({ modelId: "m-ready" }), describeHost)).toBe(
    "OpenAI / GPT-4o Mini",
  );
  expect(aiDictionaryChannel.describe(makeBinding({ modelId: "m-gone" }), describeHost)).toBe(
    "Unavailable model",
  );

  expect(await aiDictionaryChannel.readiness(makeBinding({ modelId: "" }), host)).toEqual({
    ready: false,
    reason: "failed",
  });
  expect(await aiDictionaryChannel.readiness(makeBinding({ modelId: "m-gone" }), host)).toEqual({
    ready: false,
    reason: "no_eligible_model",
  });
  expect(await aiDictionaryChannel.readiness(makeBinding({ modelId: "m-ready" }), host)).toEqual({
    ready: true,
  });
});

test("dictionary channel: AI executes structured prompt and parses entry or not_found", async () => {
  const calls: { modelId: string; system: string; user: string; disableReasoning?: boolean }[] = [];
  const host = makeHost({
    generateText: async (_conn, req) => {
      calls.push(req);
      return JSON.stringify({
        found: true,
        term: "ephemeral",
        phonetics: [{ label: "US", ipa: "/ɪˈfɛmərəl/" }],
        senses: [{ partOfSpeech: "adj.", glosses: ["短暂的"] }],
        contextSenseSummary: "此处意为短暂的。",
      });
    },
  });

  const entryResult = await aiDictionaryChannel.execute(
    makeBinding({ modelId: "m-ready" }),
    SAMPLE_INPUT,
    host,
  );
  expect(calls.length).toBe(1);
  expect(calls[0]!.modelId).toBe("gpt-4o-mini");
  expect(calls[0]!.disableReasoning).toBe(true);
  expect(calls[0]!.user).toContain("Fame is ephemeral.");
  expect(entryResult.kind).toBe("entry");
  if (entryResult.kind === "entry") {
    expect(entryResult.entry.contextSenseSummary).toBe("此处意为短暂的。");
  }

  const notFoundHost = makeHost({
    generateText: async () => JSON.stringify({ found: false, term: "asdfqwer" }),
  });
  const notFound = await aiDictionaryChannel.execute(
    makeBinding({ modelId: "m-ready" }),
    { term: "asdfqwer", explanationLanguage: "en" },
    notFoundHost,
  );
  expect(notFound).toEqual({ kind: "not_found", term: "asdfqwer" });
});

test("dictionary channel: maps malformed responses, protocol errors, and aborts to DictionaryChannelError", async () => {
  const badJsonHost = makeHost({ generateText: async () => "not json" });
  await expect(
    aiDictionaryChannel.execute(makeBinding({ modelId: "m-ready" }), SAMPLE_INPUT, badJsonHost),
  ).rejects.toMatchObject({ failure: "invalid_response" });

  const authHost = makeHost({
    generateText: async () => {
      throw new ProviderProtocolError("auth", "bad key", 401);
    },
  });
  await expect(
    aiDictionaryChannel.execute(makeBinding({ modelId: "m-ready" }), SAMPLE_INPUT, authHost),
  ).rejects.toMatchObject({ failure: "auth" });

  const rateHost = makeHost({
    generateText: async () => {
      throw new ProviderProtocolError("rate_limited", "429", 429);
    },
  });
  await expect(
    aiDictionaryChannel.execute(makeBinding({ modelId: "m-ready" }), SAMPLE_INPUT, rateHost),
  ).rejects.toMatchObject({ failure: "rate_limit" });

  const controller = new AbortController();
  controller.abort();
  let called = false;
  const abortHost = makeHost({
    generateText: async () => {
      called = true;
      return "{}";
    },
  });
  let caught: unknown = null;
  try {
    await aiDictionaryChannel.execute(
      makeBinding({ modelId: "m-ready" }),
      { ...SAMPLE_INPUT, signal: controller.signal },
      abortHost,
    );
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof DictionaryChannelError).toBe(true);
  expect((caught as DictionaryChannelError).failure).toBe("cancelled");
  expect(called).toBe(false);
});
