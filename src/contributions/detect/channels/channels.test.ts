import { expect, test } from "nsh/test";
import { ProviderProtocolError } from "../../../modules/ai/contracts/errors";
import type {
  ChannelBinding,
  HostModels,
  HostServices,
  ModelConnectionRoute,
  ResolvedModelRoute,
} from "../../../framework/contributions";
import type { FetchLike } from "../../../services/http";
import type { Logger } from "../../../services/log";
import { detectChannelContributions } from "../index";
import { aiDetectionContribution } from "./ai";
import { googleDetectionContribution, type GoogleDetectionConfig } from "./google";
import { googleCloudDetectionContribution, type GoogleCloudDetectionConfig } from "./google-cloud";
import { GOOGLE_DETECTION_URL } from "../vendor/google-free";

const CONNECTION: ModelConnectionRoute = {
  providerTypeId: "openai",
  protocolId: "openai-responses",
  baseUrl: "https://api.example.com/v1",
  credential: "sk-test",
};

const LOG: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function binding<C>(config: C, credentialRef: string | null = null): ChannelBinding<C> {
  return { enabled: true, configured: true, config, credentialRef };
}

interface GenerationCall {
  connection: ModelConnectionRoute;
  request: { modelId: string; system: string; user: string; disableReasoning?: boolean };
}

function hostWithModels(
  options: {
    unavailable?: boolean;
    respond?: () => string;
    responseError?: Error;
    generateText?: HostModels["generateText"];
  } = {},
): { host: HostServices; resolveCalls: string[]; generations: GenerationCall[] } {
  const resolveCalls: string[] = [];
  const generations: GenerationCall[] = [];
  const host: HostServices = {
    credential: null,
    models: {
      resolveSaved: async (modelId): Promise<ResolvedModelRoute> => {
        resolveCalls.push(modelId);
        if (options.unavailable === true) return { ok: false, reason: "Model unavailable" };
        return { ok: true, modelId, modelKey: `key-${modelId}`, connection: CONNECTION };
      },
      generateText:
        options.generateText ??
        (async (connection, request) => {
          generations.push({ connection, request });
          if (options.responseError !== undefined) throw options.responseError;
          return options.respond?.() ?? "fr";
        }),
      generateTextFromImage: async () => {
        throw new Error("unexpected image generation");
      },
    },
    log: LOG,
  };
  return { host, resolveCalls, generations };
}

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal };
}

function googleFetch(
  options: {
    payload?: unknown;
    ok?: boolean;
    unreadable?: boolean;
    hang?: boolean;
  } = {},
): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (options.hang === true) {
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return {
      ok: options.ok ?? true,
      status: options.ok === false ? 429 : 200,
      json: async () => {
        if (options.unreadable === true) throw new Error("<html>We're sorry</html>");
        return options.payload ?? [["Hello", "fr"]];
      },
    };
  };
  return { fetchImpl, calls };
}

test("detect contribution: lists ai, google, then google-cloud and keeps google unconfigurable", () => {
  expect(detectChannelContributions.map((entry) => entry.id)).toEqual([
    "ai",
    "google",
    "google-cloud",
  ]);
  for (const contribution of detectChannelContributions) {
    expect(contribution.capability).toBe("detect");
    expect(contribution.icon).toBeDefined();
  }
  expect(aiDetectionContribution.capability).toBe("detect");
  expect(aiDetectionContribution.labelKey).toBe("settings.languageDetection.ai");
  expect(aiDetectionContribution.configurable).toBe(true);
  expect(aiDetectionContribution.credential).toBeNull();
  expect(aiDetectionContribution.Settings).toBeDefined();

  expect(googleDetectionContribution.labelKey).toBe("settings.languageDetection.google");
  expect(googleDetectionContribution.configurable).toBe(false);
  expect(googleDetectionContribution.credential).toBeNull();
  expect(googleDetectionContribution.Settings).toBeUndefined();

  expect(googleCloudDetectionContribution.labelKey).toBe("settings.languageDetection.google-cloud");
  expect(googleCloudDetectionContribution.configurable).toBe(true);
  expect(googleCloudDetectionContribution.credential).toEqual([
    { key: "apiKey", labelKey: "settings.languageDetection.apiKey", masked: true },
  ]);
  expect(googleCloudDetectionContribution.Settings).toBeDefined();
});

test("detect contribution: parses a saved AI model and rejects non-string configs", () => {
  expect(aiDetectionContribution.config.parse({ modelId: "m-1" })).toEqual({ modelId: "m-1" });
  // The unsaved default must parse; validation rejects the blank model at save time.
  expect(aiDetectionContribution.config.parse({ modelId: "" })).toEqual({ modelId: "" });
  expect(aiDetectionContribution.config.parse({ modelId: "   " })).toEqual({ modelId: "   " });
  for (const raw of [null, undefined, "m-1", [], {}, { modelId: 42 }]) {
    expect(aiDetectionContribution.config.parse(raw)).toBeNull();
  }
  expect(aiDetectionContribution.config.defaults()).toEqual({ modelId: "" });

  expect(googleDetectionContribution.config.parse({})).toEqual({});
  expect(googleDetectionContribution.config.parse(null)).toBeNull();
  expect(googleCloudDetectionContribution.config.parse({})).toEqual({});
  expect(googleCloudDetectionContribution.config.parse("x")).toBeNull();
});

test("detect contribution: AI readiness resolves the saved text model", async () => {
  const unavailable = hostWithModels({ unavailable: true });
  expect(
    await aiDetectionContribution.readiness(binding({ modelId: "m-1" }), unavailable.host),
  ).toEqual({ ready: false, reason: "no_eligible_model" });
  expect(unavailable.resolveCalls).toEqual(["m-1"]);

  const ready = hostWithModels();
  expect(await aiDetectionContribution.readiness(binding({ modelId: "m-1" }), ready.host)).toEqual({
    ready: true,
  });
  expect(ready.resolveCalls).toEqual(["m-1"]);

  const blank = hostWithModels();
  expect(await aiDetectionContribution.readiness(binding({ modelId: "  " }), blank.host)).toEqual({
    ready: false,
    reason: "failed",
  });
  expect(blank.resolveCalls).toEqual([]);
});

test("detect contribution: AI executes the literal-ID prompt through the host model", async () => {
  const h = hostWithModels({ respond: () => " FR\n" });

  const language = await aiDetectionContribution.execute(
    binding({ modelId: "m-1" }),
    { sample: "Bonjour le monde" },
    h.host,
  );

  expect(language).toBe("fr");
  expect(h.resolveCalls).toEqual(["m-1"]);
  expect(h.generations).toHaveLength(1);
  expect(h.generations[0]!.connection).toEqual(CONNECTION);
  expect(h.generations[0]!.request).toMatchObject({
    modelId: "key-m-1",
    user: "Bonjour le monde",
    disableReasoning: true,
  });
  expect(h.generations[0]!.request.system).toContain("und");
  expect(h.generations[0]!.request.system).not.toContain("Bonjour");
});

test("detect contribution: AI maps und, prose, and transport failures to failure codes", async () => {
  const und = hostWithModels({ respond: () => " UND " });
  await expect(
    aiDetectionContribution.execute(binding({ modelId: "m-1" }), { sample: "Texte" }, und.host),
  ).rejects.toMatchObject({ code: "unknown_language" });

  const prose = hostWithModels({ respond: () => "The text is French." });
  await expect(
    aiDetectionContribution.execute(binding({ modelId: "m-1" }), { sample: "Texte" }, prose.host),
  ).rejects.toMatchObject({ code: "failed" });

  const server = hostWithModels({
    responseError: new ProviderProtocolError("server", "Upstream failed", 500),
  });
  await expect(
    aiDetectionContribution.execute(binding({ modelId: "m-1" }), { sample: "Texte" }, server.host),
  ).rejects.toMatchObject({ code: "failed" });

  const cancelled = hostWithModels({
    responseError: new ProviderProtocolError("cancelled", "Request cancelled"),
  });
  await expect(
    aiDetectionContribution.execute(
      binding({ modelId: "m-1" }),
      { sample: "Texte" },
      cancelled.host,
    ),
  ).rejects.toMatchObject({ code: "cancelled" });

  const unavailable = hostWithModels({ unavailable: true });
  await expect(
    aiDetectionContribution.execute(
      binding({ modelId: "m-1" }),
      { sample: "Texte" },
      unavailable.host,
    ),
  ).rejects.toMatchObject({ code: "no_eligible_model" });
});

test("detect contribution: Google posts the bounded sample through the host fetch", async () => {
  const h = googleFetch({ payload: [["Hello", "zh-CN"]] });

  const language = await googleDetectionContribution.execute(
    binding<GoogleDetectionConfig>({}),
    { sample: "你好，世界" },
    { credential: null, models: hostWithModels().host.models, fetchImpl: h.fetchImpl, log: LOG },
  );

  expect(language).toBe("zh");
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.url).toBe(GOOGLE_DETECTION_URL);
  expect(h.calls[0]!.init.method).toBe("POST");
  expect(h.calls[0]!.init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  expect(h.calls[0]!.init.body).toBe(`q=${encodeURIComponent("你好，世界")}`);
});

test("detect contribution: Google maps unsupported, unknown, and transport failures", async () => {
  const unsupported = googleFetch({ payload: [["Good morning", "cy"]] });
  await expect(
    googleDetectionContribution.execute(
      binding<GoogleDetectionConfig>({}),
      { sample: "Bore da" },
      {
        credential: null,
        models: hostWithModels().host.models,
        fetchImpl: unsupported.fetchImpl,
        log: LOG,
      },
    ),
  ).rejects.toMatchObject({ code: "unsupported_language" });

  const unknown = googleFetch({ payload: [["Hello"]] });
  await expect(
    googleDetectionContribution.execute(
      binding<GoogleDetectionConfig>({}),
      { sample: "Texte" },
      {
        credential: null,
        models: hostWithModels().host.models,
        fetchImpl: unknown.fetchImpl,
        log: LOG,
      },
    ),
  ).rejects.toMatchObject({ code: "unknown_language" });

  const refusal = googleFetch({ unreadable: true });
  await expect(
    googleDetectionContribution.execute(
      binding<GoogleDetectionConfig>({}),
      { sample: "Texte" },
      {
        credential: null,
        models: hostWithModels().host.models,
        fetchImpl: refusal.fetchImpl,
        log: LOG,
      },
    ),
  ).rejects.toMatchObject({ code: "failed" });

  const rateLimited = googleFetch({ ok: false });
  await expect(
    googleDetectionContribution.execute(
      binding<GoogleDetectionConfig>({}),
      { sample: "Texte" },
      {
        credential: null,
        models: hostWithModels().host.models,
        fetchImpl: rateLimited.fetchImpl,
        log: LOG,
      },
    ),
  ).rejects.toMatchObject({ code: "failed" });
});

test("detect contribution: Google maps a timeout and cancellation to failure codes", async () => {
  const slow = googleFetch({ hang: true });
  await expect(
    googleDetectionContribution.execute(
      binding<GoogleDetectionConfig>({}),
      { sample: "Texte", timeoutMs: 5 },
      {
        credential: null,
        models: hostWithModels().host.models,
        fetchImpl: slow.fetchImpl,
        log: LOG,
      },
    ),
  ).rejects.toMatchObject({ code: "failed" });

  const controller = new AbortController();
  const hanging = googleFetch({ hang: true });
  const pending = googleDetectionContribution.execute(
    binding<GoogleDetectionConfig>({}),
    { sample: "Texte", signal: controller.signal },
    {
      credential: null,
      models: hostWithModels().host.models,
      fetchImpl: hanging.fetchImpl,
      log: LOG,
    },
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
});

test("detect contribution: Google Cloud validates its key and runs with the host credential", async () => {
  expect(
    googleCloudDetectionContribution.validate!({
      config: {},
      credentialDraft: {},
      savedCredential: false,
    }),
  ).toEqual({
    ok: false,
    key: "settings.languageDetection.error.googleCloudKeyRequired",
    field: "apiKey",
  });
  expect(
    googleCloudDetectionContribution.validate!({
      config: {},
      credentialDraft: { apiKey: "draft-key" },
      savedCredential: false,
    }),
  ).toEqual({ ok: true });
  expect(
    googleCloudDetectionContribution.validate!({
      config: {},
      credentialDraft: {},
      savedCredential: true,
    }),
  ).toEqual({ ok: true });

  const withoutKey = hostWithModels();
  expect(
    await googleCloudDetectionContribution.readiness(
      binding<GoogleCloudDetectionConfig>({}, "ref-1"),
      withoutKey.host,
    ),
  ).toEqual({ ready: false, reason: "failed" });

  const withKey = hostWithModels();
  withKey.host.credential = { apiKey: "cloud-key" };
  expect(
    await googleCloudDetectionContribution.readiness(
      binding<GoogleCloudDetectionConfig>({}, "ref-1"),
      withKey.host,
    ),
  ).toEqual({ ready: true });

  const calls: { apiKey: string; text: string }[] = [];
  const language = await googleCloudDetectionContribution.execute(
    binding<GoogleCloudDetectionConfig>({}, "ref-1"),
    {
      sample: "你好，世界",
      googleCloudDetect: async (input) => {
        calls.push({ apiKey: input.apiKey, text: input.text });
        return "pt-BR";
      },
    },
    withKey.host,
  );
  expect(language).toBe("pt");
  expect(calls).toEqual([{ apiKey: "cloud-key", text: "你好，世界" }]);
});

test("detect contribution: Google Cloud maps transport, cancellation, and unsupported codes", async () => {
  const host = hostWithModels();
  host.host.credential = { apiKey: "cloud-key" };
  const cloudBinding = binding<GoogleCloudDetectionConfig>({}, "ref-1");

  await expect(
    googleCloudDetectionContribution.execute(
      cloudBinding,
      {
        sample: "Texte",
        googleCloudDetect: async () => {
          throw new ProviderProtocolError("auth", "API key not valid", 403);
        },
      },
      host.host,
    ),
  ).rejects.toMatchObject({ code: "failed" });

  await expect(
    googleCloudDetectionContribution.execute(
      cloudBinding,
      {
        sample: "Texte",
        googleCloudDetect: async () => {
          throw new ProviderProtocolError("cancelled", "Cancelled");
        },
      },
      host.host,
    ),
  ).rejects.toMatchObject({ code: "cancelled" });

  await expect(
    googleCloudDetectionContribution.execute(
      cloudBinding,
      { sample: "Bore da", googleCloudDetect: async () => "cy" },
      host.host,
    ),
  ).rejects.toMatchObject({ code: "unsupported_language" });

  const controller = new AbortController();
  controller.abort();
  await expect(
    googleCloudDetectionContribution.execute(
      cloudBinding,
      { sample: "Texte", signal: controller.signal },
      host.host,
    ),
  ).rejects.toMatchObject({ code: "cancelled" });
});

test("detect contribution: maps every detection failure code to an existing recovery key", () => {
  const expected: Record<string, string> = {
    unconfigured: "languageDetection.failure.unconfigured",
    no_eligible_model: "languageDetection.failure.noEligibleModel",
    unknown_language: "languageDetection.failure.unknownLanguage",
    unsupported_language: "languageDetection.failure.unsupportedLanguage",
    failed: "languageDetection.failure.failed",
  };
  for (const contribution of [
    aiDetectionContribution,
    googleDetectionContribution,
    googleCloudDetectionContribution,
  ]) {
    for (const [code, key] of Object.entries(expected)) {
      expect(contribution.failureKey(code)).toBe(key);
    }
    expect(contribution.failureKey("blank_input")).toBeNull();
    expect(contribution.failureKey("cancelled")).toBeNull();
  }
});

test("detect contribution: describe reports configured and unconfigured channels", () => {
  expect(googleDetectionContribution.describe(binding<GoogleDetectionConfig>({}))).toBeTruthy();
  expect(
    googleCloudDetectionContribution.describe(binding<GoogleCloudDetectionConfig>({}, null)),
  ).toBeTruthy();
  expect(
    googleCloudDetectionContribution.describe(binding<GoogleCloudDetectionConfig>({}, "ref-1")),
  ).toBeTruthy();
  expect(aiDetectionContribution.describe(binding({ modelId: "m-1" }))).toBe("m-1");
});
