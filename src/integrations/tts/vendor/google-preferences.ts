import { isLanguageId, type LanguageId } from "../../../framework/languages";
import {
  GOOGLE_VOICE_TIERS,
  isGoogleVoiceForLanguage,
  type GoogleVoiceTier,
} from "./google-voices";

/** Families the app no longer offers but still reads from saved settings. */
export type GoogleLegacyVoiceTier = "chirp-hd" | "news" | "polyglot" | "casual";

/** A preferred family, including a saved family that is no longer eligible. */
export type GoogleVoiceTierId = GoogleVoiceTier | GoogleLegacyVoiceTier;

export type GoogleVoiceGenderPreference = "any" | "female" | "male";

/** Voice and audio preferences for Google Cloud TTS. */
export interface GoogleVoicePreferences {
  voiceTier: GoogleVoiceTierId;
  voiceGender: GoogleVoiceGenderPreference;
  voiceOverrides: Readonly<Partial<Record<LanguageId, string>>>;
  speakingRate: number;
  pitch: number;
}

export const GOOGLE_VOICE_GENDER_PREFERENCES: readonly GoogleVoiceGenderPreference[] = [
  "any",
  "female",
  "male",
];

export const GOOGLE_LEGACY_VOICE_TIERS: readonly GoogleLegacyVoiceTier[] = [
  "chirp-hd",
  "news",
  "polyglot",
  "casual",
];

export const GOOGLE_SPEAKING_RATE_DEFAULT = 1;
export const GOOGLE_SPEAKING_RATE_MIN = 0.25;
export const GOOGLE_SPEAKING_RATE_MAX = 2;
export const GOOGLE_SPEAKING_RATE_STEP = 0.05;

export const GOOGLE_PITCH_DEFAULT = 0;
export const GOOGLE_PITCH_MIN = -20;
export const GOOGLE_PITCH_MAX = 20;
export const GOOGLE_PITCH_STEP = 1;

export const DEFAULT_GOOGLE_VOICE_PREFERENCES: GoogleVoicePreferences = {
  voiceTier: "standard",
  voiceGender: "any",
  voiceOverrides: {},
  speakingRate: GOOGLE_SPEAKING_RATE_DEFAULT,
  pitch: GOOGLE_PITCH_DEFAULT,
};

/** Audio fields the resolved family accepts. Chirp 3: HD supports neither. */
const FAMILY_AUDIO_SUPPORT: Record<GoogleVoiceTier, { speakingRate: boolean; pitch: boolean }> = {
  standard: { speakingRate: true, pitch: true },
  wavenet: { speakingRate: true, pitch: true },
  neural2: { speakingRate: true, pitch: true },
  "chirp3-hd": { speakingRate: false, pitch: false },
  studio: { speakingRate: true, pitch: true },
};

/** Audio fields to send for one request. Absent fields are omitted, never defaulted. */
export interface GoogleAudioOptions {
  speakingRate?: number;
  pitch?: number;
}

/** True for an approved family ID. */
export function isGoogleVoiceTier(value: unknown): value is GoogleVoiceTier {
  return (GOOGLE_VOICE_TIERS as readonly unknown[]).includes(value);
}

/** True for an approved or formerly recognized family ID. */
export function isRecognizedGoogleVoiceTier(value: unknown): value is GoogleVoiceTierId {
  return (
    isGoogleVoiceTier(value) || (GOOGLE_LEGACY_VOICE_TIERS as readonly unknown[]).includes(value)
  );
}

/** What the resolved family can apply from the saved audio preferences. */
export function googleAudioSupport(tier: GoogleVoiceTierId): {
  speakingRate: boolean;
  pitch: boolean;
} {
  if (!isGoogleVoiceTier(tier)) return { speakingRate: false, pitch: false };
  return FAMILY_AUDIO_SUPPORT[tier];
}

/**
 * Effective audio fields for one resolved family: non-default values only,
 * and never a field the family does not support.
 */
export function googleAudioOptions(
  preferences: GoogleVoicePreferences,
  tier: GoogleVoiceTierId,
): GoogleAudioOptions {
  const support = googleAudioSupport(tier);
  const options: GoogleAudioOptions = {};
  if (support.speakingRate && preferences.speakingRate !== GOOGLE_SPEAKING_RATE_DEFAULT) {
    options.speakingRate = preferences.speakingRate;
  }
  if (support.pitch && preferences.pitch !== GOOGLE_PITCH_DEFAULT) {
    options.pitch = preferences.pitch;
  }
  return options;
}

function sortedOverrides(
  overrides: Readonly<Partial<Record<LanguageId, string>>>,
): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const language of (Object.keys(overrides) as LanguageId[]).sort()) {
    const voiceName = overrides[language];
    if (voiceName !== undefined) sorted[language] = voiceName;
  }
  return sorted;
}

/** A complete copy with stable override order, safe to store or compare. */
export function normalizeGoogleVoicePreferences(
  preferences: GoogleVoicePreferences,
): GoogleVoicePreferences {
  return {
    voiceTier: preferences.voiceTier,
    voiceGender: preferences.voiceGender,
    voiceOverrides: sortedOverrides(preferences.voiceOverrides),
    speakingRate: preferences.speakingRate,
    pitch: preferences.pitch,
  };
}

/** Stable identity of the saved voice behavior, without secrets. */
export function googlePreferencesSignature(preferences: GoogleVoicePreferences): string {
  const overrides = Object.entries(sortedOverrides(preferences.voiceOverrides))
    .map(([language, voiceName]) => `${language}=${voiceName}`)
    .join(",");
  return [
    preferences.voiceTier,
    preferences.voiceGender,
    preferences.speakingRate,
    preferences.pitch,
    overrides,
  ].join("|");
}

export type GooglePreferencesErrorKey =
  | "invalid_voice_tier"
  | "invalid_voice_gender"
  | "invalid_voice_override"
  | "invalid_speaking_rate"
  | "invalid_pitch";

export type GooglePreferencesParseResult =
  | { ok: true; preferences: GoogleVoicePreferences }
  | { ok: false; key: GooglePreferencesErrorKey };

export interface ParseGoogleVoicePreferencesOptions {
  /**
   * `save` rejects a newly set override that is not in the shipped catalog and an
   * unapproved family. `load` keeps a saved name or family that later became
   * unavailable, so an unrelated edit is never blocked.
   */
  mode?: "load" | "save";
  /** Preferences in effect before this save, used to recognize a retained choice. */
  current?: GoogleVoicePreferences | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ParsedOverrides =
  | { ok: true; overrides: Partial<Record<LanguageId, string>> }
  | { ok: false; key: GooglePreferencesErrorKey };

function parseOverrides(
  value: unknown,
  options: ParseGoogleVoicePreferencesOptions,
): ParsedOverrides {
  const overrides: Partial<Record<LanguageId, string>> = {};
  if (!isPlainObject(value)) return { ok: false, key: "invalid_voice_override" };
  for (const [language, voiceName] of Object.entries(value)) {
    if (!isLanguageId(language)) return { ok: false, key: "invalid_voice_override" };
    if (typeof voiceName !== "string" || voiceName.trim() !== voiceName || voiceName === "") {
      return { ok: false, key: "invalid_voice_override" };
    }
    const retained = options.current?.voiceOverrides[language] === voiceName;
    if (options.mode === "save" && !retained && !isGoogleVoiceForLanguage(voiceName, language)) {
      return { ok: false, key: "invalid_voice_override" };
    }
    overrides[language] = voiceName;
  }
  return { ok: true, overrides };
}

/** Validates and normalizes stored or drafted Google voice preferences. */
export function parseGoogleVoicePreferences(
  value: unknown,
  options: ParseGoogleVoicePreferencesOptions = {},
): GooglePreferencesParseResult {
  const mode = options.mode ?? "load";
  if (!isPlainObject(value)) return { ok: false, key: "invalid_voice_tier" };

  const tier = value.voiceTier;
  const retainedTier = options.current?.voiceTier === tier && isRecognizedGoogleVoiceTier(tier);
  const tierValid =
    mode === "save" ? isGoogleVoiceTier(tier) || retainedTier : isRecognizedGoogleVoiceTier(tier);
  if (!tierValid) return { ok: false, key: "invalid_voice_tier" };
  const tierId = tier as GoogleVoiceTierId;

  const gender = value.voiceGender;
  if (!(GOOGLE_VOICE_GENDER_PREFERENCES as readonly unknown[]).includes(gender)) {
    return { ok: false, key: "invalid_voice_gender" };
  }

  const parsedOverrides = parseOverrides(value.voiceOverrides, { ...options, mode });
  if (!parsedOverrides.ok) return parsedOverrides;

  const speakingRate = value.speakingRate;
  if (
    typeof speakingRate !== "number" ||
    !Number.isFinite(speakingRate) ||
    speakingRate < GOOGLE_SPEAKING_RATE_MIN ||
    speakingRate > GOOGLE_SPEAKING_RATE_MAX
  ) {
    return { ok: false, key: "invalid_speaking_rate" };
  }

  const pitch = value.pitch;
  if (
    typeof pitch !== "number" ||
    !Number.isInteger(pitch) ||
    pitch < GOOGLE_PITCH_MIN ||
    pitch > GOOGLE_PITCH_MAX
  ) {
    return { ok: false, key: "invalid_pitch" };
  }

  return {
    ok: true,
    preferences: normalizeGoogleVoicePreferences({
      voiceTier: tierId,
      voiceGender: gender as GoogleVoiceGenderPreference,
      voiceOverrides: parsedOverrides.overrides,
      speakingRate,
      pitch,
    }),
  };
}
