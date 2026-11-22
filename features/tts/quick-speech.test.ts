import { expect, test } from "nsh/test";
import { t } from "nsh/i18n";
import { TTS_MAX_UTF8_BYTES } from "./google-cloud";
import { googleVoiceForLanguage } from "./google-voices";
import { prepareQuickSpeech } from "./quick-speech";
import { createTtsSettingsStore, TTS_STORAGE_KEY, ttsCredentialStorageKey } from "./settings";

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
      savedBinding: () => settings.savedBinding(),
      readGoogleCloudKey: (ref) => {
        reads.push(ref);
        return settings.readGoogleCloudKey(ref);
      },
    },
  );
  expect(result).toEqual({ ok: false, message: t("quickTranslate.speakTooLong") });
  expect(reads).toEqual([]);
});
