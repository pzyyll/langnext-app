import { effect, openUrl, signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { SectionHeading } from "../../components/ui/card";
import { AppDialog } from "../../components/ui/dialog";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { Slider } from "../../components/ui/slider";
import { FormField } from "../../modules/ai/ui/form-field";
import { createLogger } from "../../services/log";
import { getLanguageLabel, LANGUAGE_IDS, type LanguageId } from "../presets/languages";
import {
  GOOGLE_PITCH_MAX,
  GOOGLE_PITCH_MIN,
  GOOGLE_PITCH_STEP,
  GOOGLE_SPEAKING_RATE_MAX,
  GOOGLE_SPEAKING_RATE_MIN,
  GOOGLE_SPEAKING_RATE_STEP,
  googleAudioSupport,
  type GoogleVoiceGenderPreference,
  type GoogleVoicePreferences,
  type GoogleVoiceTierId,
} from "../tts/google-preferences";
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
} from "../tts/google-voices";

const log = createLogger("settings/google-tts");

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

const GENDER_PREFERENCES: readonly GoogleVoiceGenderPreference[] = ["any", "female", "male"];

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
      class="flex-row items-center gap-2 rounded-lg border border-border px-2 py-1.5"
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
          <View testID="settings-tts-google-pricing" class="gap-1 rounded-lg bg-muted/40 p-3">
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
            items={GENDER_PREFERENCES.map((gender) => ({
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
