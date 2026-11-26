import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import { ProviderProtocolError } from "../../../modules/ai/contracts/errors";
import type {
  ChannelBinding,
  HostModels,
  HostServices,
  ModelConnectionRoute,
  ResolvedModelRoute,
} from "../../../framework/integrations";
import type { FetchLike } from "../../../services/http";
import type { Logger } from "../../../services/log";
import { detectChannelDefinitions } from "../index";
import { aiDetectionDefinition } from "./ai";
import { googleDetectionDefinition, type GoogleDetectionConfig } from "./google";
import { googleCloudDetectionDefinition, type GoogleCloudDetectionConfig } from "./google-cloud";
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

const GOOGLE_CLOUD_DETECT_URL = "https://translation.googleapis.com/language/translate/v2/detect";

function cloudFetch(
  options: {
    language?: string;
    status?: number;
    errorText?: string;
    hang?: boolean;
    beforeJson?: () => void;
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
    const status = options.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => {
        options.beforeJson?.();
        return { data: { detections: [[{ language: options.language ?? "fr" }]] } };
      },
      text: async () => options.errorText ?? "",
    };
  };
  return { fetchImpl, calls };
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

test("detect channel: lists ai, google, then google-cloud and keeps google unconfigurable", () => {
  expect(detectChannelDefinitions.map((entry) => entry.id)).toEqual([
    "ai",
    "google",
    "google-cloud",
  ]);
  for (const definition of detectChannelDefinitions) {
    expect(definition.capability).toBe("detect");
    expect(definition.icon).toBeDefined();
  }
  expect(aiDetectionDefinition.capability).toBe("detect");
  expect(aiDetectionDefinition.labelKey).toBe("settings.languageDetection.ai");
  expect(aiDetectionDefinition.configurable).toBe(true);
  expect(aiDetectionDefinition.credential).toBeNull();
  expect(aiDetectionDefinition.Settings).toBeDefined();

  expect(googleDetectionDefinition.labelKey).toBe("settings.languageDetection.google");
  expect(googleDetectionDefinition.configurable).toBe(false);
  expect(googleDetectionDefinition.credential).toBeNull();
  expect(googleDetectionDefinition.Settings).toBeUndefined();

  expect(googleCloudDetectionDefinition.labelKey).toBe("settings.languageDetection.google-cloud");
  expect(googleCloudDetectionDefinition.configurable).toBe(true);
  expect(googleCloudDetectionDefinition.credential).toEqual([
    { key: "apiKey", labelKey: "settings.languageDetection.apiKey", masked: true },
  ]);
  expect(googleCloudDetectionDefinition.Settings).toBeDefined();
});

test("detect channel: parses a saved AI model and rejects non-string configs", () => {
  expect(aiDetectionDefinition.config.parse({ modelId: "m-1" })).toEqual({ modelId: "m-1" });
  // The unsaved default must parse; validation rejects the blank model at save time.
  expect(aiDetectionDefinition.config.parse({ modelId: "" })).toEqual({ modelId: "" });
  expect(aiDetectionDefinition.config.parse({ modelId: "   " })).toEqual({ modelId: "   " });
  for (const raw of [null, undefined, "m-1", [], {}, { modelId: 42 }]) {
    expect(aiDetectionDefinition.config.parse(raw)).toBeNull();
  }
  expect(aiDetectionDefinition.config.defaults()).toEqual({ modelId: "" });

  expect(googleDetectionDefinition.config.parse({})).toEqual({});
  expect(googleDetectionDefinition.config.parse(null)).toBeNull();
  expect(googleCloudDetectionDefinition.config.parse({})).toEqual({});
  expect(googleCloudDetectionDefinition.config.parse("x")).toBeNull();
});

test("detect channel: AI readiness resolves the saved text model", async () => {
  const unavailable = hostWithModels({ unavailable: true });
  expect(
    await aiDetectionDefinition.readiness(binding({ modelId: "m-1" }), unavailable.host),
  ).toEqual({ ready: false, reason: "no_eligible_model" });
  expect(unavailable.resolveCalls).toEqual(["m-1"]);

  const ready = hostWithModels();
  expect(await aiDetectionDefinition.readiness(binding({ modelId: "m-1" }), ready.host)).toEqual({
    ready: true,
  });
  expect(ready.resolveCalls).toEqual(["m-1"]);

  const blank = hostWithModels();
  expect(await aiDetectionDefinition.readiness(binding({ modelId: "  " }), blank.host)).toEqual({
    ready: false,
    reason: "failed",
  });
  expect(blank.resolveCalls).toEqual([]);
});

test("detect channel: AI executes the literal-ID prompt through the host model", async () => {
  const h = hostWithModels({ respond: () => " FR\n" });

  const language = await aiDetectionDefinition.execute(
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

test("detect channel: AI maps und, prose, and transport failures to failure codes", async () => {
  const und = hostWithModels({ respond: () => " UND " });
  await expect(
    aiDetectionDefinition.execute(binding({ modelId: "m-1" }), { sample: "Texte" }, und.host),
  ).rejects.toMatchObject({ code: "unknown_language" });

  const prose = hostWithModels({ respond: () => "The text is French." });
  await expect(
    aiDetectionDefinition.execute(binding({ modelId: "m-1" }), { sample: "Texte" }, prose.host),
  ).rejects.toMatchObject({ code: "failed" });

  const server = hostWithModels({
    responseError: new ProviderProtocolError("server", "Upstream failed", 500),
  });
  await expect(
    aiDetectionDefinition.execute(binding({ modelId: "m-1" }), { sample: "Texte" }, server.host),
  ).rejects.toMatchObject({ code: "failed" });

  const cancelled = hostWithModels({
    responseError: new ProviderProtocolError("cancelled", "Request cancelled"),
  });
  await expect(
    aiDetectionDefinition.execute(binding({ modelId: "m-1" }), { sample: "Texte" }, cancelled.host),
  ).rejects.toMatchObject({ code: "cancelled" });

  const unavailable = hostWithModels({ unavailable: true });
  await expect(
    aiDetectionDefinition.execute(
      binding({ modelId: "m-1" }),
      { sample: "Texte" },
      unavailable.host,
    ),
  ).rejects.toMatchObject({ code: "no_eligible_model" });
});

test("detect channel: Google posts the bounded sample through the host fetch", async () => {
  const h = googleFetch({ payload: [["Hello", "zh-CN"]] });

  const language = await googleDetectionDefinition.execute(
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

test("detect channel: Google maps unsupported, unknown, and transport failures", async () => {
  const unsupported = googleFetch({ payload: [["Good morning", "cy"]] });
  await expect(
    googleDetectionDefinition.execute(
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
    googleDetectionDefinition.execute(
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
    googleDetectionDefinition.execute(
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
    googleDetectionDefinition.execute(
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

test("detect channel: Google maps a timeout and cancellation to failure codes", async () => {
  const slow = googleFetch({ hang: true });
  await expect(
    googleDetectionDefinition.execute(
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
  const pending = googleDetectionDefinition.execute(
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

test("detect channel: Google Cloud validates its key and runs with the host credential", async () => {
  expect(
    googleCloudDetectionDefinition.validate!({
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
    googleCloudDetectionDefinition.validate!({
      config: {},
      credentialDraft: { apiKey: "draft-key" },
      savedCredential: false,
    }),
  ).toEqual({ ok: true });
  expect(
    googleCloudDetectionDefinition.validate!({
      config: {},
      credentialDraft: {},
      savedCredential: true,
    }),
  ).toEqual({ ok: true });

  const withoutKey = hostWithModels();
  expect(
    await googleCloudDetectionDefinition.readiness(
      binding<GoogleCloudDetectionConfig>({}, "ref-1"),
      withoutKey.host,
    ),
  ).toEqual({ ready: false, reason: "failed" });

  const withKey = hostWithModels();
  withKey.host.credential = { apiKey: "cloud-key" };
  expect(
    await googleCloudDetectionDefinition.readiness(
      binding<GoogleCloudDetectionConfig>({}, "ref-1"),
      withKey.host,
    ),
  ).toEqual({ ready: true });

  const cloud = cloudFetch({ language: "pt-BR" });
  withKey.host.fetchImpl = cloud.fetchImpl;
  const language = await googleCloudDetectionDefinition.execute(
    binding<GoogleCloudDetectionConfig>({}, "ref-1"),
    { sample: "你好，世界" },
    withKey.host,
  );
  expect(language).toBe("pt");
  expect(cloud.calls).toHaveLength(1);
  expect(cloud.calls[0]!.url).toBe(GOOGLE_CLOUD_DETECT_URL);
  expect(cloud.calls[0]!.init.headers["x-goog-api-key"]).toBe("cloud-key");
  expect(JSON.parse(cloud.calls[0]!.init.body ?? "null")).toEqual({ q: ["你好，世界"] });
});

test("detect channel: Cloud uses the host fetch boundary", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("global fetch must not run");
  };
  try {
    const cloud = cloudFetch({ language: "ja" });
    const cloudHost: HostServices = {
      credential: { apiKey: "synthetic-cloud-key" },
      models: hostWithModels().host.models,
      fetchImpl: cloud.fetchImpl,
      log: LOG,
    };

    const language = await googleCloudDetectionDefinition.execute(
      binding<GoogleCloudDetectionConfig>({}, "ref-1"),
      { sample: "こんにちは" },
      cloudHost,
    );

    expect(language).toBe("ja");
    expect(cloud.calls).toHaveLength(1);
    expect(cloud.calls[0]!.url).toBe(GOOGLE_CLOUD_DETECT_URL);
    expect(cloud.calls[0]!.init.method).toBe("POST");
    expect(cloud.calls[0]!.init.headers["x-goog-api-key"]).toBe("synthetic-cloud-key");
    expect(JSON.parse(cloud.calls[0]!.init.body ?? "null")).toEqual({ q: ["こんにちは"] });

    const free = googleFetch({ payload: [["Hello", "fr"]] });
    const freeHost: HostServices = {
      credential: null,
      models: hostWithModels().host.models,
      fetchImpl: free.fetchImpl,
      log: LOG,
    };

    const freeLanguage = await googleDetectionDefinition.execute(
      binding<GoogleDetectionConfig>({}),
      { sample: "Bonjour" },
      freeHost,
    );

    expect(freeLanguage).toBe("fr");
    expect(free.calls).toHaveLength(1);
    expect(free.calls[0]!.url).toBe(GOOGLE_DETECTION_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("detect channel: Google Cloud maps transport, cancellation, and unsupported codes", async () => {
  const host = hostWithModels();
  host.host.credential = { apiKey: "cloud-key" };
  const cloudBinding = binding<GoogleCloudDetectionConfig>({}, "ref-1");

  const authFailure = cloudFetch({
    status: 403,
    errorText: JSON.stringify({
      error: {
        message: "API key not valid",
        status: "PERMISSION_DENIED",
        errors: [{ reason: "keyInvalid" }],
      },
    }),
  });
  host.host.fetchImpl = authFailure.fetchImpl;
  await expect(
    googleCloudDetectionDefinition.execute(cloudBinding, { sample: "Texte" }, host.host),
  ).rejects.toMatchObject({ code: "failed" });
  expect(authFailure.calls).toHaveLength(1);

  const controller = new AbortController();
  const hanging = cloudFetch({ hang: true });
  host.host.fetchImpl = hanging.fetchImpl;
  const pending = googleCloudDetectionDefinition.execute(
    cloudBinding,
    { sample: "Texte", signal: controller.signal },
    host.host,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });

  const unsupported = cloudFetch({ language: "cy" });
  host.host.fetchImpl = unsupported.fetchImpl;
  await expect(
    googleCloudDetectionDefinition.execute(cloudBinding, { sample: "Bore da" }, host.host),
  ).rejects.toMatchObject({ code: "unsupported_language" });

  const preAborted = new AbortController();
  preAborted.abort();
  await expect(
    googleCloudDetectionDefinition.execute(
      cloudBinding,
      { sample: "Texte", signal: preAborted.signal },
      host.host,
    ),
  ).rejects.toMatchObject({ code: "cancelled" });
});

test("detect channel: maps every detection failure code to an existing recovery key", () => {
  const expected: Record<string, string> = {
    unconfigured: "languageDetection.failure.unconfigured",
    no_eligible_model: "languageDetection.failure.noEligibleModel",
    unknown_language: "languageDetection.failure.unknownLanguage",
    unsupported_language: "languageDetection.failure.unsupportedLanguage",
    failed: "languageDetection.failure.failed",
  };
  for (const definition of [
    aiDetectionDefinition,
    googleDetectionDefinition,
    googleCloudDetectionDefinition,
  ]) {
    for (const [code, key] of Object.entries(expected)) {
      expect(definition.failureKey(code)).toBe(key);
    }
    expect(definition.failureKey("blank_input")).toBeNull();
    expect(definition.failureKey("cancelled")).toBeNull();
  }
});

test("detect channel: describe reports configured and unconfigured channels", () => {
  expect(googleDetectionDefinition.describe(binding<GoogleDetectionConfig>({}))).toBeTruthy();
  expect(
    googleCloudDetectionDefinition.describe(binding<GoogleCloudDetectionConfig>({}, null)),
  ).toBeTruthy();
  expect(
    googleCloudDetectionDefinition.describe(binding<GoogleCloudDetectionConfig>({}, "ref-1")),
  ).toBeTruthy();
  expect(aiDetectionDefinition.describe(binding({ modelId: "m-1" }))).toBe("m-1");
  expect(
    aiDetectionDefinition.describe(binding({ modelId: "m-1" }), {
      resolveModelBinding: () => ({ ok: true, label: "OpenAI Main · gpt-4.1-mini" }),
    }),
  ).toBe("OpenAI Main · gpt-4.1-mini");
  expect(
    aiDetectionDefinition.describe(binding({ modelId: "m-removed" }), {
      resolveModelBinding: () => ({
        ok: false,
        reason: "deleted",
        label: t("presets.model.unavailableLabel"),
      }),
    }),
  ).toBe(t("presets.model.unavailableLabel"));
});
