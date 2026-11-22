import { expect, test } from "nsh/test";
import { t } from "nsh/i18n";
import { azureVoiceForLanguage } from "./azure-voices";
import { TTS_MAX_UTF8_BYTES } from "./google-cloud";
import { DEFAULT_GOOGLE_VOICE_PREFERENCES } from "./google-preferences";
import { prepareQuickSpeech } from "./quick-speech";
import {
  createTtsSettingsStore,
  TTS_STORAGE_KEY,
  ttsCredentialStorageKey,
  type TtsSettingsStorage,
} from "./settings";

function googleBinding(options: {
  enabled: boolean;
  credentialRef: string;
  preferences?: unknown;
}): Record<string, unknown> {
  return {
    enabled: options.enabled,
    credentialRef: options.credentialRef,
    preferences: options.preferences ?? DEFAULT_GOOGLE_VOICE_PREFERENCES,
  };
}

function ttsRecord(options: {
  googleCloud?: Record<string, unknown> | null;
  azure?: Record<string, unknown> | null;
  order?: readonly string[];
}): string {
  return JSON.stringify({
    version: 2,
    order: options.order ?? ["google-cloud", "azure"],
    googleCloud: options.googleCloud ?? null,
    azure: options.azure ?? null,
  });
}

function createMemoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  const storage: TtsSettingsStorage = {
    getItem: async (key) => backing[key] ?? null,
    setItem: async (key, value) => {
      backing[key] = value;
    },
    removeItem: async (key) => {
      delete backing[key];
    },
  };
  return { backing, storage };
}

test("tts voices: map documented Azure neural voices for the named locales", () => {
  expect(azureVoiceForLanguage("en")?.voiceName).toBe("en-US-JennyNeural");
  expect(azureVoiceForLanguage("ar")).toEqual({
    languageCode: "ar-SA",
    voiceName: "ar-SA-ZariyahNeural",
  });
  expect(azureVoiceForLanguage("no")?.languageCode).toBe("nb-NO");
  expect(azureVoiceForLanguage("tl")?.languageCode).toBe("fil-PH");
});

test("quick speech: over-limit text is refused before a key read", async () => {
  const reads: string[] = [];
  const mem = createMemoryStorage({
    [TTS_STORAGE_KEY]: ttsRecord({
      googleCloud: googleBinding({ enabled: true, credentialRef: "tts-ref" }),
    }),
    [ttsCredentialStorageKey("tts-ref")]: JSON.stringify({ apiKey: "tts-key" }),
  });
  const settings = createTtsSettingsStore(mem.storage);
  await settings.load();
  const result = await prepareQuickSpeech(
    {
      text: "a".repeat(TTS_MAX_UTF8_BYTES + 1),
      language: "en",
    },
    {
      activeBinding: () => settings.activeBinding(),
      readKey: (ref) => {
        reads.push(ref);
        return settings.readKey(ref);
      },
    },
  );
  expect(result).toEqual({ ok: false, message: t("quickTranslate.speakTooLong") });
  expect(reads).toEqual([]);
});

test("quick speech: prepares the active Azure channel and drops a stale binding", async () => {
  const mem = createMemoryStorage({
    [TTS_STORAGE_KEY]: ttsRecord({
      googleCloud: googleBinding({ enabled: false, credentialRef: "google-ref" }),
      azure: { enabled: true, credentialRef: "azure-ref", region: "eastus" },
    }),
    [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
    [ttsCredentialStorageKey("azure-ref")]: JSON.stringify({ apiKey: "azure-key" }),
  });
  const settings = createTtsSettingsStore(mem.storage);
  await settings.load();
  const voices = [
    ["en", "en-US", "en-US-JennyNeural"],
    ["zh", "zh-CN", "zh-CN-YunxiNeural"],
    ["fr", "fr-FR", "fr-FR-DeniseNeural"],
  ] as const;
  for (const [language, languageCode, voiceName] of voices) {
    const result = await prepareQuickSpeech({ text: "Hello", language }, settings);
    expect(result).toEqual({
      ok: true,
      speech: {
        request: {
          credentials: { channel: "azure", apiKey: "azure-key", region: "eastus" },
          text: "Hello",
          voice: { languageCode, voiceName },
        },
      },
    });
  }

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prepareQuickSpeech(
    { text: "Hello", language: "en" },
    {
      activeBinding: () => settings.activeBinding(),
      readKey: async (ref) => {
        const key = settings.readKey(ref);
        await gate;
        return key;
      },
    },
  );
  const replaced = await settings.saveChannel({
    channel: "azure",
    apiKey: "next-azure-key",
    region: "westus2",
  });
  expect(replaced.ok).toBe(true);
  release();
  const stale = await pending;
  expect(stale.ok).toBe(false);
});

test("quick speech: applies a saved override and audio values to Google", async () => {
  const mem = createMemoryStorage({
    [TTS_STORAGE_KEY]: ttsRecord({
      googleCloud: googleBinding({
        enabled: true,
        credentialRef: "google-ref",
        preferences: {
          ...DEFAULT_GOOGLE_VOICE_PREFERENCES,
          voiceOverrides: { en: "en-GB-Wavenet-A" },
          speakingRate: 1.25,
          pitch: 2,
        },
      }),
    }),
    [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
  });
  const settings = createTtsSettingsStore(mem.storage);
  await settings.load();
  const result = await prepareQuickSpeech({ text: "Hello", language: "en" }, settings);
  expect(result).toEqual({
    ok: true,
    speech: {
      request: {
        credentials: { channel: "google-cloud", apiKey: "google-key" },
        text: "Hello",
        voice: { languageCode: "en-GB", voiceName: "en-GB-Wavenet-A" },
        audio: { speakingRate: 1.25, pitch: 2 },
      },
    },
  });
});

test("quick speech: default Google preferences send the catalog voice and no audio fields", async () => {
  const mem = createMemoryStorage({
    [TTS_STORAGE_KEY]: ttsRecord({
      googleCloud: googleBinding({ enabled: true, credentialRef: "google-ref" }),
    }),
    [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
  });
  const settings = createTtsSettingsStore(mem.storage);
  await settings.load();
  const result = await prepareQuickSpeech({ text: "Hello", language: "en" }, settings);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected prepared speech");
  expect(result.speech.request.voice).toEqual({
    languageCode: "en-US",
    voiceName: "en-US-Standard-C",
  });
  expect(result.speech.request.audio).toBeUndefined();
});

test("quick speech: no eligible Google voice points to Settings before a key read", async () => {
  for (const [override, expected] of [
    [undefined, t("quickTranslate.speakVoiceNeedsSettings")],
    [{ hr: "hr-HR-Wavenet-A" }, t("quickTranslate.speakVoiceUnavailable")],
  ] as const) {
    const reads: string[] = [];
    const mem = createMemoryStorage({
      [TTS_STORAGE_KEY]: ttsRecord({
        googleCloud: googleBinding({
          enabled: true,
          credentialRef: "google-ref",
          preferences: {
            ...DEFAULT_GOOGLE_VOICE_PREFERENCES,
            voiceOverrides: override ?? {},
          },
        }),
      }),
      [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
    });
    const settings = createTtsSettingsStore(mem.storage);
    await settings.load();
    const result = await prepareQuickSpeech(
      { text: "Bok", language: "hr" },
      {
        activeBinding: () => settings.activeBinding(),
        readKey: (ref) => {
          reads.push(ref);
          return settings.readKey(ref);
        },
      },
    );
    expect(result).toEqual({ ok: false, message: expected });
    expect(reads).toEqual([]);
  }
});

test("quick speech: a Google preference change during the key read drops the request", async () => {
  const mem = createMemoryStorage({
    [TTS_STORAGE_KEY]: ttsRecord({
      googleCloud: googleBinding({ enabled: true, credentialRef: "google-ref" }),
    }),
    [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
  });
  const settings = createTtsSettingsStore(mem.storage);
  await settings.load();

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prepareQuickSpeech(
    { text: "Hello", language: "en" },
    {
      activeBinding: () => settings.activeBinding(),
      readKey: async (ref) => {
        const key = settings.readKey(ref);
        await gate;
        return key;
      },
    },
  );
  const saved = await settings.saveChannel({
    channel: "google-cloud",
    preferences: { ...DEFAULT_GOOGLE_VOICE_PREFERENCES, speakingRate: 1.5 },
  });
  expect(saved.ok).toBe(true);
  release();
  const stale = await pending;
  expect(stale.ok).toBe(false);
});

test("quick speech: Azure refuses illegal text and the app byte limit before a key read", async () => {
  const reads: string[] = [];
  const mem = createMemoryStorage({
    [TTS_STORAGE_KEY]: ttsRecord({
      googleCloud: null,
      azure: { enabled: true, credentialRef: "azure-ref", region: "eastus" },
    }),
  });
  const settings = createTtsSettingsStore(mem.storage);
  await settings.load();
  const speechSettings = {
    activeBinding: () => settings.activeBinding(),
    readKey: (ref: string) => {
      reads.push(ref);
      return settings.readKey(ref);
    },
  };
  const illegal = await prepareQuickSpeech(
    { text: "bad" + String.fromCharCode(0), language: "en" },
    speechSettings,
  );
  expect(illegal).toEqual({ ok: false, message: t("quickTranslate.speakInvalidText") });
  const tooLong = await prepareQuickSpeech(
    { text: "a".repeat(5001), language: "en" },
    speechSettings,
  );
  expect(tooLong).toEqual({ ok: false, message: t("quickTranslate.speakTooLongAzure") });
  expect(tooLong.ok === false && tooLong.message).not.toMatch(/quota|allowance/i);
  expect(reads).toEqual([]);
});
