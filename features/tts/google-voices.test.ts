import { expect, test } from "nsh/test";
import { LANGUAGE_IDS } from "../presets/languages";
import {
  DEFAULT_GOOGLE_VOICE_PREFERENCES,
  type GoogleVoicePreferences,
} from "./google-preferences";
import {
  GOOGLE_VOICE_FAMILIES,
  GOOGLE_VOICE_TIERS,
  findGoogleVoice,
  googleFamilyChain,
  googleFamilyLanguageCount,
  googleVoiceLocales,
  listGoogleVoices,
  resolveGoogleVoice,
} from "./google-voices";

function preferences(overrides: Partial<GoogleVoicePreferences> = {}): GoogleVoicePreferences {
  return { ...DEFAULT_GOOGLE_VOICE_PREFERENCES, ...overrides };
}

test("google voices: lists the documented English Standard and Neural2 voices", () => {
  const voices = listGoogleVoices("en");
  expect(voices.find((voice) => voice.name === "en-US-Standard-C")).toEqual({
    name: "en-US-Standard-C",
    locale: "en-US",
    family: "standard",
    gender: "female",
  });
  expect(voices.find((voice) => voice.name === "en-US-Neural2-D")).toEqual({
    name: "en-US-Neural2-D",
    locale: "en-US",
    family: "neural2",
    gender: "male",
  });
  expect(voices.every((voice) => GOOGLE_VOICE_TIERS.includes(voice.family))).toBe(true);
  expect(findGoogleVoice("en-US-Standard-C")?.locale).toBe("en-US");
  expect(findGoogleVoice("en-US-DoesNotExist")).toBeNull();
});

test("google voices: default preferences select the existing Standard voice", () => {
  const resolved = resolveGoogleVoice("en", DEFAULT_GOOGLE_VOICE_PREFERENCES);
  expect(resolved).toEqual({
    ok: true,
    voice: { name: "en-US-Standard-C", locale: "en-US", family: "standard", gender: "female" },
  });
  expect(googleFamilyChain("standard")).toEqual(["standard"]);
  expect(googleFamilyChain("neural2")).toEqual(["neural2", "wavenet", "standard"]);
  expect(googleFamilyChain("studio")).toEqual([
    "studio",
    "chirp3-hd",
    "neural2",
    "wavenet",
    "standard",
  ]);
});

test("google voices: Mandarin Neural2 preference falls back to WaveNet", () => {
  const resolved = resolveGoogleVoice("zh", preferences({ voiceTier: "neural2" }));
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error("expected a Mandarin voice");
  expect(resolved.voice.family).toBe("wavenet");
  expect(resolved.voice.locale).toBe("cmn-CN");
});

test("google voices: an exact override wins over the global preference", () => {
  const resolved = resolveGoogleVoice(
    "en",
    preferences({
      voiceTier: "studio",
      voiceGender: "male",
      voiceOverrides: { en: "en-GB-Wavenet-A" },
    }),
  );
  expect(resolved).toEqual({
    ok: true,
    voice: { name: "en-GB-Wavenet-A", locale: "en-GB", family: "wavenet", gender: "female" },
  });
});

test("google voices: a missing or cross-language override never falls back", () => {
  for (const voiceName of ["en-US-DoesNotExist", "fr-FR-Wavenet-A", "hr-HR-Chirp3-HD-Achernar"]) {
    const resolved = resolveGoogleVoice("en", preferences({ voiceOverrides: { en: voiceName } }));
    expect(resolved).toEqual({
      ok: false,
      reason: "override_unavailable",
      overrideName: voiceName,
    });
  }
});

test("google voices: a Cantonese voice is an explicit choice only", () => {
  const automatic = resolveGoogleVoice("zh", DEFAULT_GOOGLE_VOICE_PREFERENCES);
  expect(automatic.ok).toBe(true);
  if (!automatic.ok) throw new Error("expected a default Mandarin voice");
  expect(automatic.voice.locale).not.toBe("yue-HK");
  expect(googleVoiceLocales("zh")).toEqual(["cmn-CN", "cmn-TW", "yue-HK"]);
  expect(listGoogleVoices("zh").some((voice) => voice.locale === "yue-HK")).toBe(true);

  const chosen = resolveGoogleVoice(
    "zh",
    preferences({ voiceOverrides: { zh: "yue-HK-Chirp3-HD-Achernar" } }),
  );
  expect(chosen).toEqual({
    ok: true,
    voice: {
      name: "yue-HK-Chirp3-HD-Achernar",
      locale: "yue-HK",
      family: "chirp3-hd",
      gender: "female",
    },
  });
});

test("google voices: Standard never selects Croatian Chirp 3: HD", () => {
  const automatic = resolveGoogleVoice("hr", DEFAULT_GOOGLE_VOICE_PREFERENCES);
  expect(automatic).toEqual({ ok: false, reason: "no_voice_for_preference" });

  const chirp = listGoogleVoices("hr")[0]!;
  expect(chirp.family).toBe("chirp3-hd");
  const chosen = resolveGoogleVoice("hr", preferences({ voiceOverrides: { hr: chirp.name } }));
  expect(chosen.ok).toBe(true);
});

test("google voices: a missing gender keeps the preferred family", () => {
  const resolved = resolveGoogleVoice("cs", preferences({ voiceGender: "male" }));
  expect(resolved).toEqual({
    ok: true,
    voice: { name: "cs-CZ-Standard-B", locale: "cs-CZ", family: "standard", gender: "female" },
  });
});

test("google voices: distinguishes no voice from no voice in the preference", () => {
  expect(resolveGoogleVoice("fa", DEFAULT_GOOGLE_VOICE_PREFERENCES)).toEqual({
    ok: false,
    reason: "no_voice_for_language",
  });
  expect(resolveGoogleVoice("sw", DEFAULT_GOOGLE_VOICE_PREFERENCES)).toEqual({
    ok: false,
    reason: "no_voice_for_language",
  });
  expect(resolveGoogleVoice("hr", preferences({ voiceTier: "chirp3-hd" })).ok).toBe(true);
  expect(resolveGoogleVoice("hr", DEFAULT_GOOGLE_VOICE_PREFERENCES)).toEqual({
    ok: false,
    reason: "no_voice_for_preference",
  });
  expect(resolveGoogleVoice("hr", preferences({ voiceTier: "chirp-hd" }))).toEqual({
    ok: false,
    reason: "no_voice_for_preference",
  });
  expect(
    resolveGoogleVoice("fa", preferences({ voiceOverrides: { fa: "fa-IR-Standard-A" } })),
  ).toEqual({ ok: false, reason: "override_unavailable", overrideName: "fa-IR-Standard-A" });
});

test("google voices: family language counts come from the selectable catalog", () => {
  for (const family of GOOGLE_VOICE_FAMILIES) {
    const expected = LANGUAGE_IDS.filter((language) =>
      listGoogleVoices(language).some((voice) => voice.family === family.id),
    ).length;
    expect(googleFamilyLanguageCount(family.id)).toBe(expected);
  }
  expect(googleFamilyLanguageCount("standard")).toBeGreaterThan(0);
  expect(googleFamilyLanguageCount("chirp3-hd")).toBeGreaterThan(
    googleFamilyLanguageCount("studio"),
  );
});
