// ABOUTME: Google Cloud TTS contribution: config schema, voice resolution, synthesis, and settings UI.
// ABOUTME: The settings component renders fields and the sample preview; the shared host owns save.
import { cleanup, effect, openUrl, signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import googleCloudIcon from "../../../../assets/icons/google-cloud.svg";
import { Button } from "../../../components/ui/button";
import { SectionHeading } from "../../../components/ui/card";
import { AppDialog } from "../../../components/ui/dialog";
import { Icon } from "../../../components/ui/icon";
import { Input } from "../../../components/ui/input";
import { Select, type SelectItem } from "../../../components/ui/select";
import { Slider } from "../../../components/ui/slider";
import type {
  CapabilityChannelContribution,
  ChannelBinding,
  ChannelSettingsProps,
  ConfigSchema,
} from "../../../framework/contributions";
import { getLanguageLabel, LANGUAGE_IDS, type LanguageId } from "../../../framework/languages";
import { FormField } from "../../../modules/ai/ui/form-field";
import { createLogger } from "../../../services/log";
import { createGoogleCloudTtsClient, TTS_MAX_UTF8_BYTES } from "../vendor/google-cloud";
import { GOOGLE_SAMPLE_LANGUAGE, googleSampleText } from "../vendor/google-samples";
import {
  DEFAULT_GOOGLE_VOICE_PREFERENCES,
  googleAudioOptions,
  GOOGLE_PITCH_MAX,
  GOOGLE_PITCH_MIN,
  GOOGLE_VOICE_GENDER_PREFERENCES,
  GOOGLE_PITCH_STEP,
  GOOGLE_SPEAKING_RATE_MAX,
  GOOGLE_SPEAKING_RATE_MIN,
  GOOGLE_SPEAKING_RATE_STEP,
  googleAudioSupport,
  googlePreferencesSignature,
  normalizeGoogleVoicePreferences,
  parseGoogleVoicePreferences,
  type GooglePreferencesErrorKey,
  type GoogleVoiceGenderPreference,
  type GoogleVoicePreferences,
  type GoogleVoiceTierId,
} from "../vendor/google-preferences";
import {
  findGoogleVoice,
  GOOGLE_VOICE_FAMILIES,
  GOOGLE_VOICE_PRICING,
  googleDefaultLocale,
  googleFamilyLanguageCount,
  googleVoiceFamily,
  listGoogleVoices,
  resolveGoogleVoice,
  type GoogleVoice,
  type GoogleVoiceFamily,
  type GoogleVoiceGender,
  type GoogleVoiceResolution,
} from "../vendor/google-voices";
import type { TtsChannelInput, TtsFailure, TtsSynthesis } from "../types";
import { TtsSamplePreview } from "./sample-preview";

const log = createLogger("tts/google-cloud");

const ALTERNATE_LOCALE_LABEL_KEYS: Readonly<Record<string, string>> = {
  "cmn-TW": "settings.tts.google.locale.cmn-TW",
  "en-AU": "settings.tts.google.locale.en-AU",
  "en-GB": "settings.tts.google.locale.en-GB",
  "en-IN": "settings.tts.google.locale.en-IN",
  "es-US": "settings.tts.google.locale.es-US",
  "fr-CA": "settings.tts.google.locale.fr-CA",
  "nl-BE": "settings.tts.google.locale.nl-BE",
  "pt-BR": "settings.tts.google.locale.pt-BR",
  "yue-HK": "settings.tts.google.locale.yue-HK",
};

/** Localized product name of an approved or formerly approved family. */
export function googleFamilyLabel(tier: GoogleVoiceTierId): string {
  return t(`settings.tts.google.tier.${tier}`);
}

/** Localized gender of a voice. */
export function googleGenderLabel(gender: GoogleVoiceGender | GoogleVoiceGenderPreference): string {
  return t(`settings.tts.google.gender.${gender}`);
}

/** Localized label for one Google locale under the app language it belongs to. */
export function googleLocaleLabel(language: LanguageId, locale: string): string {
  if (googleDefaultLocale(language) === locale) return getLanguageLabel(language);
  const key = ALTERNATE_LOCALE_LABEL_KEYS[locale];
  return key === undefined ? locale : t(key);
}

function formatMillions(characters: number): string {
  return String(characters / 1_000_000);
}

function formatUsd(amount: number): string {
  return t("settings.tts.google.priceUsd", { amount: String(amount) });
}

/** Reachable language count, published allowance, and overage for one family. */
export function googleFamilyPricingLines(family: GoogleVoiceFamily): string[] {
  const millions = formatMillions(family.freeCharactersPerMonth);
  const shared = family.sharedWith[0];
  const free =
    shared === undefined
      ? t("settings.tts.google.free", { millions })
      : t("settings.tts.google.freeShared", { millions, family: googleFamilyLabel(shared) });
  return [
    t("settings.tts.google.languages", {
      count: String(googleFamilyLanguageCount(family.id)),
    }),
    free,
    t("settings.tts.google.overage", { price: formatUsd(family.usdPerMillionCharacters) }),
  ];
}

/** Why the draft cannot select a Google voice for this language, or null. */
export function googleVoiceProblem(
  preferences: GoogleVoicePreferences,
  language: LanguageId,
): string | null {
  const resolved = resolveGoogleVoice(language, preferences);
  if (resolved.ok) return null;
  if (resolved.reason === "override_unavailable") {
    return t("settings.tts.google.overrideUnavailable");
  }
  if (resolved.reason === "no_voice_for_preference") {
    return t("settings.tts.google.noVoiceForFamily");
  }
  return t("settings.tts.google.noVoiceForLanguage");
}

/** What the draft resolves to for the preview, including a visible fallback. */
export function googlePreviewVoiceLabel(
  preferences: GoogleVoicePreferences,
  language: LanguageId,
): string {
  const resolved = resolveGoogleVoice(language, preferences);
  if (!resolved.ok) return t("settings.tts.google.previewVoiceUnavailable");
  return t("settings.tts.google.previewVoice", {
    voice: resolved.voice.name,
    family: googleFamilyLabel(resolved.voice.family),
  });
}

function rateText(value: number): string {
  return t("settings.tts.google.rateValue", {
    value: value.toFixed(2).replace(/\.?0+$/, ""),
  });
}

function pitchText(value: number): string {
  return t("settings.tts.google.pitchValue", {
    value: value > 0 ? `+${value}` : String(value),
  });
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

function voiceItemTitle(language: LanguageId, voice: GoogleVoice): string {
  return [
    voice.name,
    googleLocaleLabel(language, voice.locale),
    googleFamilyLabel(voice.family),
    googleGenderLabel(voice.gender),
  ].join(" · ");
}

interface GoogleOverrideRowProps {
  language: LanguageId;
  preferences: () => GoogleVoicePreferences;
  disabled: boolean;
  onEdit: () => void;
  onReset: () => void;
}

function GoogleOverrideRow(props: GoogleOverrideRowProps) {
  const voice = () => {
    const name = props.preferences().voiceOverrides[props.language];
    return name === undefined ? null : findGoogleVoice(name);
  };
  const missing = () => {
    const name = props.preferences().voiceOverrides[props.language];
    return name !== undefined && voice() === null;
  };
  const summary = () => {
    const current = voice();
    if (current !== null) return `${current.name} · ${googleFamilyLabel(current.family)}`;
    return t("settings.tts.google.overrideMissing");
  };

  return (
    <View
      testID={`settings-tts-google-override-${props.language}`}
      class="flex-row items-center gap-2 rounded-xl border border-border px-2 py-1.5"
    >
      <Button
        variant="ghost"
        size="row"
        accessibilityLabel={`${getLanguageLabel(props.language)}: ${summary()}`}
        onPress={props.onEdit}
        disabled={props.disabled}
        class="min-w-0 flex-1 px-1"
      >
        <View class="min-w-0 flex-1 gap-0.5">
          <Text class="min-w-0 truncate text-sm text-card-foreground">
            {getLanguageLabel(props.language)}
          </Text>
          <Text
            class={`min-w-0 truncate text-xs ${missing() ? "text-destructive" : "text-muted-foreground"}`}
          >
            {summary()}
          </Text>
        </View>
      </Button>
      <Button
        testID={`settings-tts-google-override-reset-${props.language}`}
        variant="ghost"
        size="xs"
        label={t("settings.tts.google.overrideReset")}
        disabled={props.disabled}
        onPress={props.onReset}
      />
    </View>
  );
}

export interface GoogleTtsFieldsProps {
  disabled: boolean;
  preferences: () => GoogleVoicePreferences;
  sampleLanguage: () => LanguageId;
  onPreferencesChange: (preferences: GoogleVoicePreferences) => void;
  onSampleLanguageChange: (language: LanguageId) => void;
  onEditOverrides: (language: LanguageId) => void;
}

/** Google voice and audio controls shared by the settings draft. */
export function GoogleTtsFields(props: GoogleTtsFieldsProps) {
  const update = (change: Partial<GoogleVoicePreferences>) => {
    props.onPreferencesChange({ ...props.preferences(), ...change });
  };
  const familyItems = (): SelectItem[] => {
    const items: SelectItem[] = GOOGLE_VOICE_FAMILIES.map((family) => ({
      value: family.id,
      title: googleFamilyLabel(family.id),
    }));
    const tier = props.preferences().voiceTier;
    if (!GOOGLE_VOICE_FAMILIES.some((family) => family.id === tier)) {
      items.push({ value: tier, title: googleFamilyLabel(tier), disabled: true });
    }
    return items;
  };
  const currentFamily = (): GoogleVoiceFamily | null =>
    GOOGLE_VOICE_FAMILIES.find((family) => family.id === props.preferences().voiceTier) ?? null;
  const previewFamily = (): GoogleVoiceTierId | null => {
    const resolved = resolveGoogleVoice(props.sampleLanguage(), props.preferences());
    return resolved.ok ? resolved.voice.family : null;
  };
  const audioSupport = () => {
    const family = previewFamily();
    return family === null ? { speakingRate: true, pitch: true } : googleAudioSupport(family);
  };
  const overrideLanguages = () =>
    (Object.keys(props.preferences().voiceOverrides) as LanguageId[]).sort();
  const languageItems = (): SelectItem[] =>
    LANGUAGE_IDS.map((language) => ({ value: language, title: getLanguageLabel(language) }));
  const resetOverride = (language: LanguageId) => {
    const overrides = { ...props.preferences().voiceOverrides };
    delete overrides[language];
    props.onPreferencesChange({ ...props.preferences(), voiceOverrides: overrides });
  };
  const openPricing = async () => {
    try {
      await openUrl(GOOGLE_VOICE_PRICING.url);
    } catch (error) {
      log.warn("Could not open the Google pricing page.", error);
    }
  };

  return (
    <>
      <View testID="settings-tts-google-voice" class="gap-4 border-t border-border pt-4">
        <SectionHeading title={t("settings.tts.google.voice")} />

        <FormField
          label={t("settings.tts.google.tierLabel")}
          hint={currentFamily() === null ? t("settings.tts.google.unavailableFamily") : undefined}
        >
          <Select
            testID="settings-tts-google-family"
            items={familyItems()}
            value={props.preferences().voiceTier}
            disabled={props.disabled}
            accessibilityLabel={t("settings.tts.google.tierLabel")}
            onChange={(value) => {
              if (value === null) return;
              update({ voiceTier: value as GoogleVoiceTierId });
            }}
          />
        </FormField>

        <If when={currentFamily() !== null}>
          <View testID="settings-tts-google-pricing" class="gap-1 rounded-xl bg-surface-subtle p-3">
            <Each of={googleFamilyPricingLines(currentFamily()!)} key={(line) => line}>
              {(line) => <Text class="text-xs text-muted-foreground">{line()}</Text>}
            </Each>
            <View class="mt-1 flex-row items-center justify-between gap-2">
              <Text class="text-xs text-muted-foreground">
                {t("settings.tts.google.checked", { date: GOOGLE_VOICE_PRICING.checkedAt })}
              </Text>
              <Button
                testID="settings-tts-google-pricing-link"
                variant="brand-ghost"
                size="xs"
                label={t("settings.tts.google.pricingLink")}
                onPress={() => void openPricing()}
                class="px-1"
              />
            </View>
          </View>
        </If>

        <FormField label={t("settings.tts.google.genderLabel")}>
          <Select
            testID="settings-tts-google-gender"
            items={GOOGLE_VOICE_GENDER_PREFERENCES.map((gender) => ({
              value: gender,
              title: googleGenderLabel(gender),
            }))}
            value={props.preferences().voiceGender}
            disabled={props.disabled}
            accessibilityLabel={t("settings.tts.google.genderLabel")}
            onChange={(value) => {
              if (value === null) return;
              update({ voiceGender: value as GoogleVoiceGenderPreference });
            }}
          />
        </FormField>

        <View class="gap-2">
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-xs font-medium text-foreground">
              {t("settings.tts.google.overrides")}
            </Text>
            <Button
              testID="settings-tts-google-overrides"
              variant="outline"
              size="xs"
              label={t("settings.tts.google.overrideAdd")}
              disabled={props.disabled}
              onPress={() => props.onEditOverrides(props.sampleLanguage())}
            />
          </View>
          <Each of={overrideLanguages()} key={(language) => language}>
            {(language) => (
              <GoogleOverrideRow
                language={language()}
                preferences={props.preferences}
                disabled={props.disabled}
                onEdit={() => props.onEditOverrides(language())}
                onReset={() => resetOverride(language())}
              />
            )}
          </Each>
        </View>

        <FormField label={t("settings.tts.google.sampleLanguage")}>
          <Select
            testID="settings-tts-google-sample-language"
            items={languageItems()}
            value={props.sampleLanguage()}
            disabled={props.disabled}
            accessibilityLabel={t("settings.tts.google.sampleLanguage")}
            onChange={(value) => {
              if (value !== null) props.onSampleLanguageChange(value as LanguageId);
            }}
          />
        </FormField>
      </View>

      <View testID="settings-tts-google-audio" class="gap-4 border-t border-border pt-4">
        <SectionHeading title={t("settings.tts.google.audio")} />
        <FormField
          label={`${t("settings.tts.google.rate")} · ${rateText(props.preferences().speakingRate)}`}
          hint={audioSupport().speakingRate ? undefined : t("settings.tts.google.rateUnavailable")}
          labelTestID="settings-tts-google-rate-label"
        >
          <View class="flex-row items-center gap-2">
            <Slider
              testID="settings-tts-google-rate"
              value={props.preferences().speakingRate}
              min={GOOGLE_SPEAKING_RATE_MIN}
              max={GOOGLE_SPEAKING_RATE_MAX}
              step={GOOGLE_SPEAKING_RATE_STEP}
              disabled={props.disabled}
              accessibilityLabel={t("settings.tts.google.rate")}
              class="min-w-0 flex-1"
              onChange={(value) => update({ speakingRate: roundRate(value) })}
            />
            <View class="shrink-0">
              <Button
                testID="settings-tts-google-rate-up"
                variant="ghost"
                size="step"
                accessibilityLabel={t("settings.tts.google.increaseRate")}
                disabled={
                  props.disabled || props.preferences().speakingRate >= GOOGLE_SPEAKING_RATE_MAX
                }
                onPress={() =>
                  update({
                    speakingRate: roundRate(
                      Math.min(
                        props.preferences().speakingRate + GOOGLE_SPEAKING_RATE_STEP,
                        GOOGLE_SPEAKING_RATE_MAX,
                      ),
                    ),
                  })
                }
              >
                <Icon name="chevron-down" tone="foreground" class="size-3.5 rotate-180" />
              </Button>
              <Button
                testID="settings-tts-google-rate-down"
                variant="ghost"
                size="step"
                accessibilityLabel={t("settings.tts.google.decreaseRate")}
                disabled={
                  props.disabled || props.preferences().speakingRate <= GOOGLE_SPEAKING_RATE_MIN
                }
                onPress={() =>
                  update({
                    speakingRate: roundRate(
                      Math.max(
                        props.preferences().speakingRate - GOOGLE_SPEAKING_RATE_STEP,
                        GOOGLE_SPEAKING_RATE_MIN,
                      ),
                    ),
                  })
                }
              >
                <Icon name="chevron-down" tone="foreground" class="size-3.5" />
              </Button>
            </View>
          </View>
        </FormField>
        <FormField
          label={`${t("settings.tts.google.pitch")} · ${pitchText(props.preferences().pitch)}`}
          hint={audioSupport().pitch ? undefined : t("settings.tts.google.pitchUnavailable")}
          labelTestID="settings-tts-google-pitch-label"
        >
          <View class="flex-row items-center gap-2">
            <Slider
              testID="settings-tts-google-pitch"
              value={props.preferences().pitch}
              min={GOOGLE_PITCH_MIN}
              max={GOOGLE_PITCH_MAX}
              step={GOOGLE_PITCH_STEP}
              disabled={props.disabled}
              accessibilityLabel={t("settings.tts.google.pitch")}
              class="min-w-0 flex-1"
              onChange={(value) => update({ pitch: Math.round(value) })}
            />
            <View class="shrink-0">
              <Button
                testID="settings-tts-google-pitch-up"
                variant="ghost"
                size="step"
                accessibilityLabel={t("settings.tts.google.increasePitch")}
                disabled={props.disabled || props.preferences().pitch >= GOOGLE_PITCH_MAX}
                onPress={() =>
                  update({
                    pitch: Math.min(
                      props.preferences().pitch + GOOGLE_PITCH_STEP,
                      GOOGLE_PITCH_MAX,
                    ),
                  })
                }
              >
                <Icon name="chevron-down" tone="foreground" class="size-3.5 rotate-180" />
              </Button>
              <Button
                testID="settings-tts-google-pitch-down"
                variant="ghost"
                size="step"
                accessibilityLabel={t("settings.tts.google.decreasePitch")}
                disabled={props.disabled || props.preferences().pitch <= GOOGLE_PITCH_MIN}
                onPress={() =>
                  update({
                    pitch: Math.max(
                      props.preferences().pitch - GOOGLE_PITCH_STEP,
                      GOOGLE_PITCH_MIN,
                    ),
                  })
                }
              >
                <Icon name="chevron-down" tone="foreground" class="size-3.5" />
              </Button>
            </View>
          </View>
        </FormField>
      </View>
    </>
  );
}

export interface GoogleOverrideDialogProps {
  open: () => boolean;
  initialLanguage: () => LanguageId;
  preferences: () => GoogleVoicePreferences;
  onOpenChange: (open: boolean) => void;
  onApply: (language: LanguageId, voiceName: string | null) => void;
}

/** One explicit voice per app language, chosen from the bundled catalog. */
export function GoogleOverrideDialog(props: GoogleOverrideDialogProps) {
  const language = signal<LanguageId>("en");
  const search = signal("");
  const selected = signal<string | null>(null);
  let wasOpen = false;

  effect(() => {
    const open = props.open();
    if (!open) {
      wasOpen = false;
      return;
    }
    if (wasOpen) return;
    wasOpen = true;
    const initial = props.initialLanguage();
    language.set(initial);
    search.set("");
    selected.set(props.preferences().voiceOverrides[initial] ?? null);
  });

  const chooseLanguage = (next: LanguageId) => {
    language.set(next);
    search.set("");
    selected.set(props.preferences().voiceOverrides[next] ?? null);
  };

  const matches = (): readonly GoogleVoice[] => {
    const query = search().trim().toLowerCase();
    const voices = listGoogleVoices(language());
    if (query === "") return voices;
    return voices.filter((voice) => {
      const locale = googleLocaleLabel(language(), voice.locale).toLowerCase();
      const family = googleFamilyLabel(voice.family).toLowerCase();
      return (
        voice.name.toLowerCase().includes(query) ||
        voice.locale.toLowerCase().includes(query) ||
        locale.includes(query) ||
        family.includes(query)
      );
    });
  };

  const voiceItems = (): SelectItem[] => {
    const items: SelectItem[] = matches().map((voice) => ({
      value: voice.name,
      title: voiceItemTitle(language(), voice),
    }));
    const selectedName = selected();
    if (selectedName !== null && !items.some((item) => item.value === selectedName)) {
      const voice = findGoogleVoice(selectedName);
      items.unshift(
        voice === null
          ? {
              value: selectedName,
              title: `${selectedName} · ${t("settings.tts.google.overrideMissing")}`,
              disabled: true,
            }
          : { value: selectedName, title: voiceItemTitle(language(), voice) },
      );
    }
    return items;
  };
  const selectedFamily = () => {
    const name = selected();
    if (name === null) return null;
    const voice = findGoogleVoice(name);
    return voice === null ? null : googleVoiceFamily(voice.family);
  };
  const hasOverride = () => props.preferences().voiceOverrides[language()] !== undefined;

  return (
    <AppDialog
      testID="settings-tts-google-override-dialog"
      open={props.open()}
      title={t("settings.tts.google.overrideTitle")}
      size="md"
      onOpenChange={(open) => props.onOpenChange(open)}
      footer={
        <>
          <Button
            testID="settings-tts-google-override-cancel"
            variant="outline"
            size="sm"
            label={t("common.cancel")}
            onPress={() => props.onOpenChange(false)}
          />
          <Button
            testID="settings-tts-google-override-reset"
            variant="ghost"
            size="sm"
            label={t("settings.tts.google.overrideReset")}
            disabled={!hasOverride()}
            onPress={() => {
              props.onApply(language(), null);
              props.onOpenChange(false);
            }}
          />
          <Button
            testID="settings-tts-google-override-apply"
            variant="primary"
            size="sm"
            label={t("settings.tts.google.overrideApply")}
            disabled={selected() === null}
            onPress={() => {
              const name = selected();
              if (name !== null) props.onApply(language(), name);
              props.onOpenChange(false);
            }}
          />
        </>
      }
    >
      <FormField label={t("settings.tts.google.overrideLanguage")}>
        <Select
          testID="settings-tts-google-override-language"
          items={LANGUAGE_IDS.map((id) => ({ value: id, title: getLanguageLabel(id) }))}
          value={language()}
          accessibilityLabel={t("settings.tts.google.overrideLanguage")}
          onChange={(value) => {
            if (value !== null) chooseLanguage(value as LanguageId);
          }}
        />
      </FormField>
      <FormField label={t("settings.tts.google.overrideSearch")}>
        <Input
          testID="settings-tts-google-override-search"
          value={search()}
          placeholder={t("settings.tts.google.overrideSearchPlaceholder")}
          accessibilityLabel={t("settings.tts.google.overrideSearch")}
          leadingIcon="search"
          onClear={() => search.set("")}
          onChange={(value) => search.set(value)}
        />
      </FormField>
      <If when={matches().length === 0}>
        <Text testID="settings-tts-google-override-empty" class="text-xs text-muted-foreground">
          {t("settings.tts.google.overrideEmpty")}
        </Text>
      </If>
      <FormField label={t("settings.tts.google.overrideVoice")}>
        <Select
          testID="settings-tts-google-override-voice"
          items={voiceItems()}
          value={selected()}
          disabled={matches().length === 0}
          placeholder={t("settings.tts.google.overrideVoicePlaceholder")}
          accessibilityLabel={t("settings.tts.google.overrideVoice")}
          onChange={(value) => selected.set(value)}
        />
      </FormField>
      <If when={selectedFamily() !== null}>
        <View class="gap-1">
          <Each of={googleFamilyPricingLines(selectedFamily()!)} key={(line) => line}>
            {(line) => <Text class="text-xs text-muted-foreground">{line()}</Text>}
          </Each>
        </View>
      </If>
    </AppDialog>
  );
}

/** Saved Google Cloud TTS configuration: voice and audio preferences only. */
export interface GoogleCloudTtsConfig {
  preferences: GoogleVoicePreferences;
}

/** Parses one stored or drafted Google configuration with the legacy load rules. */
export const googleCloudTtsConfig: ConfigSchema<GoogleCloudTtsConfig> = {
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const parsed = parseGoogleVoicePreferences((raw as { preferences?: unknown }).preferences, {
      mode: "load",
    });
    return parsed.ok ? { preferences: parsed.preferences } : null;
  },
  defaults: () => ({
    preferences: normalizeGoogleVoicePreferences(DEFAULT_GOOGLE_VOICE_PREFERENCES),
  }),
};

const PREFERENCE_ERROR_KEYS: Record<GooglePreferencesErrorKey, string> = {
  invalid_voice_tier: "settings.tts.error.invalidVoiceTier",
  invalid_voice_gender: "settings.tts.error.invalidVoiceGender",
  invalid_voice_override: "settings.tts.error.invalidVoiceOverride",
  invalid_speaking_rate: "settings.tts.error.invalidSpeakingRate",
  invalid_pitch: "settings.tts.error.invalidPitch",
};

/** Existing message for each failure the Google client can return. */
const FAILURE_KEYS: Partial<Record<TtsFailure, string>> = {
  text_blank: "quickTranslate.error.blankInput",
  text_too_long: "quickTranslate.speakTooLong",
  auth: "settings.tts.failure.auth",
  quota: "settings.tts.failure.quota",
  timeout: "settings.tts.failure.playback",
  network: "settings.tts.failure.playback",
  rejected: "settings.tts.failure.playback",
  malformed: "settings.tts.failure.playback",
};

function voiceFailureMessage(
  reason: Extract<GoogleVoiceResolution, { ok: false }>["reason"],
): string {
  if (reason === "override_unavailable") return t("quickTranslate.speakVoiceUnavailable");
  if (reason === "no_voice_for_preference") return t("quickTranslate.speakVoiceNeedsSettings");
  return t("quickTranslate.speakUnsupported");
}

/** Google Cloud Text-to-Speech contribution. */
export const googleCloudTtsContribution: CapabilityChannelContribution<
  GoogleCloudTtsConfig,
  TtsChannelInput,
  TtsSynthesis
> = {
  id: "google-cloud",
  capability: "tts",
  labelKey: "settings.tts.channel",
  icon: googleCloudIcon,
  configurable: true,
  config: googleCloudTtsConfig,
  credential: [{ key: "apiKey", labelKey: "settings.tts.apiKey", masked: true }],
  describe: (binding) => googleFamilyLabel(binding.config.preferences.voiceTier),
  signature: (binding) => googlePreferencesSignature(binding.config.preferences),
  validate: ({ config, credentialDraft, savedCredential }) => {
    const parsed = parseGoogleVoicePreferences(config.preferences, { mode: "load" });
    if (!parsed.ok) {
      return { ok: false, key: PREFERENCE_ERROR_KEYS[parsed.key], field: "preferences" };
    }
    const draft = (credentialDraft.apiKey ?? "").trim();
    if (draft.length === 0 && !savedCredential) {
      return { ok: false, key: "settings.tts.error.apiKeyRequired", field: "apiKey" };
    }
    return { ok: true };
  },
  saveAvailable: ({ config, credentialDraft, savedBinding, credentialReadable }) =>
    (credentialDraft.apiKey ?? "").trim().length > 0 ||
    (credentialReadable &&
      googlePreferencesSignature(config.preferences) !==
        googlePreferencesSignature(savedBinding.config.preferences)),
  prepare: (binding, input) => {
    const preferences = binding.config.preferences;
    const resolved = resolveGoogleVoice(input.language, preferences);
    if (!resolved.ok) return { ok: false, message: voiceFailureMessage(resolved.reason) };
    const text =
      input.sample === true ? googleSampleText(input.language, resolved.voice.locale) : input.text;
    if (text.trim().length === 0) {
      return { ok: false, message: t("quickTranslate.error.blankInput") };
    }
    if (new TextEncoder().encode(text).byteLength > TTS_MAX_UTF8_BYTES) {
      return { ok: false, message: t("quickTranslate.speakTooLong") };
    }
    const audio = googleAudioOptions(preferences, resolved.voice.family);
    return {
      ok: true,
      input: {
        ...input,
        text,
        voice: { languageCode: resolved.voice.locale, voiceName: resolved.voice.name },
        ...(Object.keys(audio).length > 0 ? { audio } : {}),
      },
    };
  },
  readiness: async (_binding, host) =>
    (host.credential?.apiKey ?? "").trim().length > 0
      ? { ready: true }
      : { ready: false, reason: "credential" },
  execute: async (binding, input, host) => {
    const apiKey = host.credential?.apiKey ?? "";
    if (apiKey.trim().length === 0) return { status: "failed", failure: "auth" };
    return createGoogleCloudTtsClient({ fetchImpl: host.fetchImpl }).synthesize(
      {
        apiKey,
        text: input.text,
        languageCode: input.voice?.languageCode ?? "",
        voiceName: input.voice?.voiceName ?? "",
        ...(input.audio !== undefined && Object.keys(input.audio).length > 0
          ? { audio: input.audio }
          : {}),
      },
      { signal: input.signal },
    );
  },
  failureKey: (failure) => FAILURE_KEYS[failure as TtsFailure] ?? null,
  Settings: GoogleCloudTtsSettings,
};

/** Google voice controls, credential field, and sample preview for one saved channel. */
function GoogleCloudTtsSettings(props: ChannelSettingsProps<GoogleCloudTtsConfig>) {
  const initial = props.binding.config.preferences;
  const draft = signal<GoogleCloudTtsConfig>({
    preferences: normalizeGoogleVoicePreferences(initial),
  });
  const sampleLanguage = signal<LanguageId>(GOOGLE_SAMPLE_LANGUAGE);
  const overridesOpen = signal(false);
  const overrideLanguage = signal<LanguageId>(GOOGLE_SAMPLE_LANGUAGE);

  const preferences = () => draft().preferences;
  const update = (change: Partial<GoogleVoicePreferences>) => {
    const next = { preferences: { ...preferences(), ...change } };
    draft.set(next);
    props.onChange(next);
  };
  const controlsLocked = () => props.disabled;
  const apiKeyDraft = () => props.credentialDraft.apiKey ?? "";
  const draftKeyPresent = () => apiKeyDraft().trim().length > 0;
  const savedKeyReadable = () => props.savedCredential && props.credentialState === "readable";
  const problem = () => googleVoiceProblem(preferences(), sampleLanguage());
  const previewBinding = (): ChannelBinding<GoogleCloudTtsConfig> => ({
    enabled: props.binding.enabled,
    configured: props.binding.configured,
    config: draft(),
    credentialRef: props.binding.credentialRef,
  });

  effect(() => props.host.onDialogOpenChange(overridesOpen()));
  cleanup(() => props.host.onDialogOpenChange(false));

  const editOverrides = (language: LanguageId) => {
    overrideLanguage.set(language);
    overridesOpen.set(true);
  };
  const applyOverride = (language: LanguageId, voiceName: string | null) => {
    const overrides = { ...preferences().voiceOverrides };
    if (voiceName === null) delete overrides[language];
    else overrides[language] = voiceName;
    update({ voiceOverrides: overrides });
    sampleLanguage.set(language);
  };

  return (
    <>
      <FormField label={t("settings.tts.apiKey")}>
        <Input
          testID="settings-tts-api-key"
          value={apiKeyDraft()}
          placeholder={props.savedCredential ? t("settings.tts.savedKey") : undefined}
          masked={true}
          disabled={controlsLocked()}
          accessibilityLabel={t("settings.tts.apiKey")}
          onChange={(value) => props.onCredentialChange("apiKey", value)}
        />
      </FormField>

      <GoogleTtsFields
        disabled={controlsLocked()}
        preferences={() => preferences()}
        sampleLanguage={() => sampleLanguage()}
        onPreferencesChange={(next) => update(next)}
        onSampleLanguageChange={(language) => sampleLanguage.set(language)}
        onEditOverrides={editOverrides}
      />

      <TtsSamplePreview
        contribution={googleCloudTtsContribution}
        binding={previewBinding()}
        host={props.host}
        language={() => sampleLanguage()}
        disabled={() => draftKeyPresent() || problem() !== null || !savedKeyReadable()}
        note={() => {
          if (draftKeyPresent()) return t("settings.tts.previewUnsaved");
          if (!savedKeyReadable()) return t("settings.tts.previewNeedsKey");
          return problem() ?? undefined;
        }}
        label={() => problem() ?? googlePreviewVoiceLabel(preferences(), sampleLanguage())}
        labelClass={() =>
          problem() !== null ? "text-xs text-destructive" : "text-xs text-muted-foreground"
        }
        labelTestID="settings-tts-google-preview-voice"
      />

      <GoogleOverrideDialog
        open={() => overridesOpen()}
        initialLanguage={() => overrideLanguage()}
        preferences={() => preferences()}
        onOpenChange={(open) => overridesOpen.set(open)}
        onApply={applyOverride}
      />
    </>
  );
}
