import { expect, test } from "nsh/test";
import { t } from "nsh/i18n";
import type { FetchLike, HttpResponseLike } from "../../../services/http";
import type {
  ChannelBinding,
  CredentialRecord,
  HostServices,
} from "../../../framework/contributions";
import {
  azureTtsContribution,
  googleCloudTtsContribution,
  ttsChannelContributions,
  type AzureTtsConfig,
  type GoogleCloudTtsConfig,
  type TtsChannelInput,
  type TtsFailure,
} from "../index";
import { TTS_SAMPLE_TEXT, TTS_MAX_UTF8_BYTES } from "../vendor/google-cloud";
import {
  DEFAULT_GOOGLE_VOICE_PREFERENCES,
  googlePreferencesSignature,
  type GoogleVoicePreferences,
} from "../vendor/google-preferences";
import { googleSampleText } from "../vendor/google-samples";
import { AZURE_TTS_MAX_UTF8_BYTES } from "../vendor/azure-speech";

const GOOGLE_REF = "google-ref";
const AZURE_REF = "azure-ref";

function googlePreferences(
  overrides: Partial<GoogleVoicePreferences> = {},
): GoogleVoicePreferences {
  return { ...DEFAULT_GOOGLE_VOICE_PREFERENCES, ...overrides };
}

function googleBinding(
  preferences: GoogleVoicePreferences = DEFAULT_GOOGLE_VOICE_PREFERENCES,
): ChannelBinding<GoogleCloudTtsConfig> {
  return {
    enabled: true,
    configured: true,
    config: { preferences },
    credentialRef: GOOGLE_REF,
  };
}

function azureBinding(region = "eastus"): ChannelBinding<AzureTtsConfig> {
  return { enabled: true, configured: true, config: { region }, credentialRef: AZURE_REF };
}

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

function host(credential: CredentialRecord | null, fetchImpl?: FetchLike): HostServices {
  return {
    credential,
    models: {
      resolveSaved: async () => ({ ok: false, reason: "TTS never resolves a model." }),
      generateText: async () => {
        throw new Error("TTS never generates text.");
      },
      generateTextFromImage: async () => {
        throw new Error("TTS never reads an image.");
      },
    },
    log: quietLog,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  };
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function capture(response: HttpResponseLike) {
  const requests: CapturedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({
      url,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    return response;
  };
  return { requests, fetchImpl };
}

function jsonResponse(value: unknown, status = 200): HttpResponseLike {
  const text = JSON.stringify(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function audioResponse(bytes: Uint8Array, status = 200): HttpResponseLike {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    json: async () => {
      throw new Error("Audio responses are not JSON.");
    },
  };
}

function prepared(
  contribution: typeof googleCloudTtsContribution | typeof azureTtsContribution,
  binding: ChannelBinding<GoogleCloudTtsConfig> | ChannelBinding<AzureTtsConfig>,
  input: TtsChannelInput,
): TtsChannelInput {
  const result = contribution.prepare!(binding as never, input);
  if (!result.ok) throw new Error("expected the input to be prepared: " + result.message);
  return result.input;
}

test("tts contribution: registers Google Cloud and Azure in priority order", () => {
  expect(ttsChannelContributions.map((contribution) => contribution.id)).toEqual([
    "google-cloud",
    "azure",
  ]);
  for (const contribution of ttsChannelContributions) {
    expect(contribution.capability).toBe("tts");
    expect(contribution.configurable).toBe(true);
    expect(contribution.credential).toEqual([
      { key: "apiKey", labelKey: "settings.tts.apiKey", masked: true },
    ]);
    expect(contribution.Settings).toBeDefined();
  }
});

test("tts contribution: parse rejects malformed config and restores defaults", () => {
  const google = googleCloudTtsContribution.config;
  expect(google.parse(null)).toBeNull();
  expect(google.parse({})).toBeNull();
  expect(google.parse({ preferences: { voiceTier: "gemini-tts" } })).toBeNull();
  expect(
    google.parse({ preferences: { ...DEFAULT_GOOGLE_VOICE_PREFERENCES, speakingRate: 9 } }),
  ).toBeNull();
  expect(google.parse({ preferences: DEFAULT_GOOGLE_VOICE_PREFERENCES })).toEqual({
    preferences: DEFAULT_GOOGLE_VOICE_PREFERENCES,
  });
  expect(
    google.parse({ preferences: { ...DEFAULT_GOOGLE_VOICE_PREFERENCES, voiceTier: "chirp-hd" } }),
  ).toEqual({
    preferences: { ...DEFAULT_GOOGLE_VOICE_PREFERENCES, voiceTier: "chirp-hd" },
  });
  expect(google.defaults()).toEqual({ preferences: DEFAULT_GOOGLE_VOICE_PREFERENCES });

  const azure = azureTtsContribution.config;
  expect(azure.parse(null)).toBeNull();
  expect(azure.parse({})).toBeNull();
  expect(azure.parse({ region: 2 })).toBeNull();
  expect(azure.parse({ region: "not-a-region" })).toBeNull();
  expect(azure.parse({ region: " EASTUS " })).toEqual({ region: "eastus" });
  expect(azure.defaults()).toEqual({ region: "" });
});

test("tts contribution: describe formats the Google voice family and the Azure region", () => {
  expect(googleCloudTtsContribution.describe(googleBinding())).toBe(
    t("settings.tts.google.tier.standard"),
  );
  expect(
    googleCloudTtsContribution.describe(googleBinding(googlePreferences({ voiceTier: "neural2" }))),
  ).toBe(t("settings.tts.google.tier.neural2"));
  expect(azureTtsContribution.describe(azureBinding("westus2"))).toBe("westus2");
});

test("tts contribution: Google prepare resolves the automatic voice with its audio fields", () => {
  const input = prepared(googleCloudTtsContribution, googleBinding(), {
    text: "Hello",
    language: "en",
  });
  expect(input.text).toBe("Hello");
  expect(input.voice).toEqual({ languageCode: "en-US", voiceName: "en-US-Standard-C" });
  expect(input.audio).toBeUndefined();

  const overridden = prepared(
    googleCloudTtsContribution,
    googleBinding(
      googlePreferences({
        voiceTier: "studio",
        voiceOverrides: { en: "en-GB-Wavenet-A" },
        speakingRate: 1.25,
        pitch: 2,
      }),
    ),
    { text: "Hello", language: "en" },
  );
  expect(overridden.voice).toEqual({
    languageCode: "en-GB",
    voiceName: "en-GB-Wavenet-A",
  });
  expect(overridden.audio).toEqual({ speakingRate: 1.25, pitch: 2 });

  const sample = prepared(googleCloudTtsContribution, googleBinding(), {
    text: "ignored",
    language: "en",
    sample: true,
  });
  expect(sample.text).toBe(TTS_SAMPLE_TEXT);

  const cantonese = prepared(
    googleCloudTtsContribution,
    googleBinding(googlePreferences({ voiceOverrides: { zh: "yue-HK-Chirp3-HD-Achernar" } })),
    { text: "ignored", language: "zh", sample: true },
  );
  expect(cantonese.text).toBe(googleSampleText("zh", "yue-HK"));
});

test("tts contribution: Google prepare refuses an unusable voice and over-limit text", () => {
  const noVoice = googleCloudTtsContribution.prepare!(googleBinding(), {
    text: "Bok",
    language: "hr",
  });
  expect(noVoice).toEqual({ ok: false, message: t("quickTranslate.speakVoiceNeedsSettings") });

  const removed = googleCloudTtsContribution.prepare!(
    googleBinding(googlePreferences({ voiceOverrides: { en: "en-US-Removed-A" } })),
    { text: "Hello", language: "en" },
  );
  expect(removed).toEqual({ ok: false, message: t("quickTranslate.speakVoiceUnavailable") });

  const unsupported = googleCloudTtsContribution.prepare!(googleBinding(), {
    text: "Sawubona",
    language: "fa",
  });
  expect(unsupported).toEqual({ ok: false, message: t("quickTranslate.speakUnsupported") });

  const blank = googleCloudTtsContribution.prepare!(googleBinding(), {
    text: "   ",
    language: "en",
  });
  expect(blank).toEqual({ ok: false, message: t("quickTranslate.error.blankInput") });

  const tooLong = googleCloudTtsContribution.prepare!(googleBinding(), {
    text: "a".repeat(TTS_MAX_UTF8_BYTES + 1),
    language: "en",
  });
  expect(tooLong).toEqual({ ok: false, message: t("quickTranslate.speakTooLong") });
});

test("tts contribution: Azure prepare resolves the channel voice and refuses illegal text", () => {
  const input = prepared(azureTtsContribution, azureBinding(), {
    text: "Hello",
    language: "en",
  });
  expect(input.voice).toEqual({ languageCode: "en-US", voiceName: "en-US-JennyNeural" });
  expect(input.audio).toBeUndefined();

  const sample = prepared(azureTtsContribution, azureBinding(), {
    text: "ignored",
    language: "en",
    sample: true,
  });
  expect(sample.text).toBe(TTS_SAMPLE_TEXT);

  const illegal = azureTtsContribution.prepare!(azureBinding(), {
    text: "bad" + String.fromCharCode(0),
    language: "en",
  });
  expect(illegal).toEqual({ ok: false, message: t("quickTranslate.speakInvalidText") });

  const tooLong = azureTtsContribution.prepare!(azureBinding(), {
    text: "a".repeat(AZURE_TTS_MAX_UTF8_BYTES + 1),
    language: "en",
  });
  expect(tooLong).toEqual({ ok: false, message: t("quickTranslate.speakTooLongAzure") });

  const invalidRegion = azureTtsContribution.prepare!(azureBinding("not-a-region"), {
    text: "Hello",
    language: "en",
  });
  expect(invalidRegion).toEqual({
    ok: false,
    message: t("settings.tts.error.invalidRegion"),
  });
});

test("tts contribution: signature identifies the cache-relevant saved config", () => {
  const google = googleCloudTtsContribution.signature!;
  expect(google(googleBinding())).toBe(
    googlePreferencesSignature(DEFAULT_GOOGLE_VOICE_PREFERENCES),
  );
  expect(google(googleBinding(googlePreferences({ speakingRate: 1.5 })))).not.toBe(
    google(googleBinding()),
  );
  expect(
    google(
      googleBinding(
        googlePreferences({ voiceOverrides: { en: "en-GB-Wavenet-A", hr: "hr-HR-Wavenet-A" } }),
      ),
    ),
  ).toBe(
    google(
      googleBinding(
        googlePreferences({ voiceOverrides: { hr: "hr-HR-Wavenet-A", en: "en-GB-Wavenet-A" } }),
      ),
    ),
  );

  const azure = azureTtsContribution.signature!;
  expect(azure(azureBinding("eastus"))).toBe("eastus");
  expect(azure(azureBinding("westus2"))).not.toBe(azure(azureBinding("eastus")));
});

test("tts contribution: Google execute sends the saved credential through the host fetch", async () => {
  const audio = Uint8Array.from([0xff, 0xfb, 0x90, 0x64]);
  const captured = capture(jsonResponse({ audioContent: Buffer.from(audio).toString("base64") }));
  const binding = googleBinding(googlePreferences({ speakingRate: 1.25 }));
  const input = prepared(googleCloudTtsContribution, binding, { text: "Hello", language: "en" });
  const result = await googleCloudTtsContribution.execute(
    binding,
    input,
    host({ apiKey: "key-1" }, captured.fetchImpl),
  );
  expect(result).toEqual({ status: "synthesized", audio });
  expect(captured.requests).toHaveLength(1);
  const request = captured.requests[0]!;
  expect(request.url).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
  expect(request.headers["x-goog-api-key"]).toBe("key-1");
  const body = JSON.parse(request.body ?? "");
  expect(body.input.text).toBe("Hello");
  expect(body.voice).toEqual({ languageCode: "en-US", name: "en-US-Standard-C" });
  expect(body.audioConfig).toEqual({ audioEncoding: "MP3", speakingRate: 1.25 });

  const missing = await googleCloudTtsContribution.execute(
    binding,
    input,
    host(null, captured.fetchImpl),
  );
  expect(missing).toEqual({ status: "failed", failure: "auth" });
  expect(captured.requests).toHaveLength(1);
});

test("tts contribution: Azure execute posts SSML to the saved region with the host key", async () => {
  const audio = Uint8Array.from([0xff, 0xfb, 0x90, 0xc3]);
  const captured = capture(audioResponse(audio));
  const binding = azureBinding("westus2");
  const input = prepared(azureTtsContribution, binding, { text: "A & B", language: "en" });
  const result = await azureTtsContribution.execute(
    binding,
    input,
    host({ apiKey: "azure-key" }, captured.fetchImpl),
  );
  expect(result).toEqual({ status: "synthesized", audio });
  expect(captured.requests).toHaveLength(1);
  const request = captured.requests[0]!;
  expect(request.url).toBe("https://westus2.tts.speech.microsoft.com/cognitiveservices/v1");
  expect(request.headers["Ocp-Apim-Subscription-Key"]).toBe("azure-key");
  expect(request.body).toBe(
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' +
      '<voice name="en-US-JennyNeural">A &amp; B</voice></speak>',
  );

  const missing = await azureTtsContribution.execute(
    binding,
    input,
    host(null, captured.fetchImpl),
  );
  expect(missing).toEqual({ status: "failed", failure: "auth" });
  expect(captured.requests).toHaveLength(1);
});

test("tts contribution: failureKey maps every vendor failure to an existing message", () => {
  const googleFailures: TtsFailure[] = [
    "text_blank",
    "text_too_long",
    "auth",
    "quota",
    "timeout",
    "network",
    "rejected",
    "malformed",
  ];
  for (const failure of googleFailures) {
    expect(googleCloudTtsContribution.failureKey(failure)).not.toBeNull();
  }
  expect(googleCloudTtsContribution.failureKey("auth")).toBe("settings.tts.failure.auth");
  expect(googleCloudTtsContribution.failureKey("quota")).toBe("settings.tts.failure.quota");
  expect(googleCloudTtsContribution.failureKey("rate_limited")).toBeNull();

  const azureFailures: TtsFailure[] = [
    "text_blank",
    "text_too_long",
    "invalid_text",
    "invalid_region",
    "auth",
    "rate_limited",
    "timeout",
    "network",
    "rejected",
    "malformed",
  ];
  for (const failure of azureFailures) {
    expect(azureTtsContribution.failureKey(failure)).not.toBeNull();
  }
  expect(azureTtsContribution.failureKey("auth")).toBe("settings.tts.failure.azureAuth");
  expect(azureTtsContribution.failureKey("rate_limited")).toBe(
    "settings.tts.failure.azureRateLimited",
  );
  expect(azureTtsContribution.failureKey("quota")).toBeNull();
});

test("tts contribution: readiness reports whether the call receives a credential", async () => {
  expect(
    await googleCloudTtsContribution.readiness(googleBinding(), host({ apiKey: "k" })),
  ).toEqual({
    ready: true,
  });
  expect(await googleCloudTtsContribution.readiness(googleBinding(), host(null))).toEqual({
    ready: false,
    reason: "credential",
  });
  expect(await azureTtsContribution.readiness(azureBinding(), host(null))).toEqual({
    ready: false,
    reason: "credential",
  });
});
