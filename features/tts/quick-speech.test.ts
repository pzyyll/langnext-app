import { expect, test } from "nsh/test";
import { t } from "nsh/i18n";
import { TTS_MAX_UTF8_BYTES } from "./google-cloud";
import { azureVoiceForLanguage } from "./azure-voices";
import { googleVoiceForLanguage } from "./google-voices";
import { prepareQuickSpeech } from "./quick-speech";
import { createTtsSettingsStore, TTS_STORAGE_KEY, ttsCredentialStorageKey } from "./settings";

test("tts voices: map documented Azure neural voices for the named locales", () => {
  expect(azureVoiceForLanguage("en")?.voiceName).toBe("en-US-JennyNeural");
  expect(azureVoiceForLanguage("ar")).toEqual({
    languageCode: "ar-SA",
    voiceName: "ar-SA-ZariyahNeural",
  });
  expect(azureVoiceForLanguage("no")?.languageCode).toBe("nb-NO");
  expect(azureVoiceForLanguage("tl")?.languageCode).toBe("fil-PH");
  expect(azureVoiceForLanguage("en")?.voiceName).not.toBe(googleVoiceForLanguage("en")?.voiceName);
});

test("tts voices: map documented Standard voices and omit languages without one", () => {
  expect(googleVoiceForLanguage("en")).toEqual({
    languageCode: "en-US",
    voiceName: "en-US-Standard-C",
  });
  expect(googleVoiceForLanguage("zh")).toEqual({
    languageCode: "cmn-CN",
    voiceName: "cmn-CN-Standard-A",
  });
  expect(googleVoiceForLanguage("no")).toEqual({
    languageCode: "nb-NO",
    voiceName: "nb-NO-Standard-F",
  });
  expect(googleVoiceForLanguage("hr")).toBeNull();
  expect(googleVoiceForLanguage("fa")).toBeNull();
  expect(googleVoiceForLanguage("uk")).toBeNull();
});

test("quick speech: over-limit text is refused before a key read", async () => {
  const reads: string[] = [];
  const settings = createTtsSettingsStore({
    getItem: async (key) => {
      if (key === TTS_STORAGE_KEY) {
        return JSON.stringify({
          version: 1,
          googleCloud: { enabled: true, credentialRef: "tts-ref" },
        });
      }
      if (key === ttsCredentialStorageKey("tts-ref")) return JSON.stringify({ apiKey: "tts-key" });
      return null;
    },
    setItem: async () => {},
    removeItem: async () => {},
  });
  await settings.load();
  const result = await prepareQuickSpeech(
    {
      text: "a".repeat(TTS_MAX_UTF8_BYTES + 1),
      language: "en",
      unresolvedAuto: null,
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
  const backing: Record<string, string> = {
    [TTS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      googleCloud: { enabled: false, credentialRef: "google-ref" },
      azure: { enabled: true, credentialRef: "azure-ref", region: "eastus" },
    }),
    [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
    [ttsCredentialStorageKey("azure-ref")]: JSON.stringify({ apiKey: "azure-key" }),
  };
  const settings = createTtsSettingsStore({
    getItem: async (key) => backing[key] ?? null,
    setItem: async (key, value) => {
      backing[key] = value;
    },
    removeItem: async (key) => {
      delete backing[key];
    },
  });
  await settings.load();
  const voices = [
    ["en", "en-US", "en-US-JennyNeural"],
    ["zh", "zh-CN", "zh-CN-YunxiNeural"],
    ["fr", "fr-FR", "fr-FR-DeniseNeural"],
  ] as const;
  for (const [language, languageCode, voiceName] of voices) {
    const result = await prepareQuickSpeech(
      { text: "Hello", language, unresolvedAuto: null },
      settings,
    );
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
    { text: "Hello", language: "en", unresolvedAuto: null },
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

test("quick speech: Azure refuses illegal text and the app byte limit before a key read", async () => {
  const reads: string[] = [];
  const settings = createTtsSettingsStore({
    getItem: async (key) => {
      if (key === TTS_STORAGE_KEY) {
        return JSON.stringify({
          version: 1,
          googleCloud: null,
          azure: { enabled: true, credentialRef: "azure-ref", region: "eastus" },
        });
      }
      return null;
    },
    setItem: async () => {},
    removeItem: async () => {},
  });
  await settings.load();
  const speechSettings = {
    activeBinding: () => settings.activeBinding(),
    readKey: (ref: string) => {
      reads.push(ref);
      return settings.readKey(ref);
    },
  };
  const illegal = await prepareQuickSpeech(
    { text: "bad" + String.fromCharCode(0), language: "en", unresolvedAuto: null },
    speechSettings,
  );
  expect(illegal).toEqual({ ok: false, message: t("quickTranslate.speakInvalidText") });
  const tooLong = await prepareQuickSpeech(
    { text: "a".repeat(5001), language: "en", unresolvedAuto: null },
    speechSettings,
  );
  expect(tooLong).toEqual({ ok: false, message: t("quickTranslate.speakTooLongAzure") });
  expect(tooLong.ok === false && tooLong.message).not.toMatch(/quota|allowance/i);
  expect(reads).toEqual([]);
});