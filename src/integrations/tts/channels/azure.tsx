// ABOUTME: Azure Speech TTS definition: region config, voice mapping, synthesis, and settings UI.
// ABOUTME: The settings component renders fields and the sample preview; the shared host owns save.
import { signal } from "nsh";
import { t } from "nsh/i18n";
import microsoftAzureIcon from "../../../../assets/icons/microsoft-azure.svg";
import { Input } from "../../../components/ui/input";
import type {
  CapabilityChannelDefinition,
  ChannelBinding,
  ChannelSettingsProps,
  ConfigSchema,
} from "../../../framework/integrations";
import type { LanguageId } from "../../../framework/languages";
import { FormField } from "../../../modules/ai/ui/form-field";
import type { TtsChannelInput, TtsFailure, TtsSynthesis } from "../types";
import {
  AZURE_TTS_MAX_UTF8_BYTES,
  azureTextHasIllegalXml,
  createAzureSpeechTtsClient,
} from "../vendor/azure-speech";
import { parseAzureSpeechRegion } from "../vendor/azure-regions";
import { azureVoiceForLanguage } from "../vendor/azure-voices";
import { TTS_SAMPLE_TEXT } from "../vendor/google-cloud";
import { TtsSamplePreview } from "./sample-preview";

/** Fixed English sample voice the settings preview uses. */
export const AZURE_SAMPLE_VOICE_NAME = "en-US-JennyNeural";

/** Sample language for the fixed English sentence. */
export const AZURE_SAMPLE_LANGUAGE: LanguageId = "en";

/** Saved Azure Speech configuration: the public region that hosts its endpoint. */
export interface AzureTtsConfig {
  region: string;
}

/** Parses one stored or drafted Azure configuration into its canonical region. */
export const azureTtsConfig: ConfigSchema<AzureTtsConfig> = {
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const region = (raw as { region?: unknown }).region;
    if (typeof region !== "string") return null;
    const parsed = parseAzureSpeechRegion(region);
    if (parsed !== null) return { region: parsed };
    return region.trim().length === 0 ? { region: "" } : null;
  },
  defaults: () => ({ region: "" }),
};

/** Existing message for each failure the Azure client can return. */
const FAILURE_KEYS: Partial<Record<TtsFailure, string>> = {
  text_blank: "quickTranslate.error.blankInput",
  text_too_long: "quickTranslate.speakTooLongAzure",
  invalid_text: "quickTranslate.speakInvalidText",
  invalid_region: "settings.tts.error.invalidRegion",
  auth: "settings.tts.failure.azureAuth",
  rate_limited: "settings.tts.failure.azureRateLimited",
  timeout: "settings.tts.failure.playback",
  network: "settings.tts.failure.playback",
  rejected: "settings.tts.failure.playback",
  malformed: "settings.tts.failure.playback",
};

/** Azure Speech definition. */
export const azureTtsDefinition: CapabilityChannelDefinition<
  AzureTtsConfig,
  TtsChannelInput,
  TtsSynthesis
> = {
  id: "azure",
  capability: "tts",
  labelKey: "settings.tts.azure.channel",
  icon: microsoftAzureIcon,
  configurable: true,
  config: azureTtsConfig,
  credential: [{ key: "apiKey", labelKey: "settings.tts.apiKey", masked: true }],
  describe: (binding) => binding.config.region,
  signature: (binding) => binding.config.region,
  validate: ({ config, credentialDraft, savedCredential }) => {
    if (parseAzureSpeechRegion(config.region) === null) {
      return { ok: false, key: "settings.tts.error.invalidRegion", field: "region" };
    }
    const draft = (credentialDraft.apiKey ?? "").trim();
    if (draft.length === 0 && !savedCredential) {
      return { ok: false, key: "settings.tts.error.apiKeyRequired", field: "apiKey" };
    }
    return { ok: true };
  },
  saveAvailable: ({ config, credentialDraft }) =>
    (credentialDraft.apiKey ?? "").trim().length > 0 && config.region.trim().length > 0,
  prepare: (binding, input) => {
    const voice = azureVoiceForLanguage(input.language);
    if (voice === null) {
      return { ok: false, message: t("quickTranslate.speakUnsupportedAzure") };
    }
    if (parseAzureSpeechRegion(binding.config.region) === null) {
      return { ok: false, message: t("settings.tts.error.invalidRegion") };
    }
    const text = input.sample === true ? TTS_SAMPLE_TEXT : input.text;
    if (azureTextHasIllegalXml(text)) {
      return { ok: false, message: t("quickTranslate.speakInvalidText") };
    }
    if (text.trim().length === 0) {
      return { ok: false, message: t("quickTranslate.error.blankInput") };
    }
    if (new TextEncoder().encode(text).byteLength > AZURE_TTS_MAX_UTF8_BYTES) {
      return { ok: false, message: t("quickTranslate.speakTooLongAzure") };
    }
    return { ok: true, input: { ...input, text, voice } };
  },
  readiness: async (_binding, host) =>
    (host.credential?.apiKey ?? "").trim().length > 0
      ? { ready: true }
      : { ready: false, reason: "credential" },
  execute: async (binding, input, host) => {
    const apiKey = host.credential?.apiKey ?? "";
    if (apiKey.trim().length === 0) return { status: "failed", failure: "auth" };
    const region = parseAzureSpeechRegion(binding.config.region);
    if (region === null) return { status: "failed", failure: "invalid_region" };
    return createAzureSpeechTtsClient({ fetchImpl: host.fetchImpl }).synthesize(
      {
        apiKey,
        region,
        text: input.text,
        voice: input.voice ?? { languageCode: "", voiceName: "" },
      },
      { signal: input.signal },
    );
  },
  failureKey: (failure) => FAILURE_KEYS[failure as TtsFailure] ?? null,
  Settings: AzureTtsSettings,
};

/** Azure region field, credential field, and sample preview for one saved channel. */
function AzureTtsSettings(props: ChannelSettingsProps<AzureTtsConfig>) {
  const draft = signal<AzureTtsConfig>({ region: props.binding.config.region });

  const region = () => draft().region;
  const updateRegion = (value: string) => {
    const next = { region: value.trim().toLowerCase() };
    draft.set(next);
    props.onChange(next);
  };
  const controlsLocked = () => props.disabled;
  const apiKeyDraft = () => props.credentialDraft.apiKey ?? "";
  const draftKeyPresent = () => apiKeyDraft().trim().length > 0;
  const savedRegion = () => props.savedBinding.config.region.trim().toLowerCase();
  const regionDirty = () => region().trim().toLowerCase() !== savedRegion();
  const regionProblem = () => parseAzureSpeechRegion(region()) === null;
  const savedRegionProblem = () => parseAzureSpeechRegion(savedRegion()) === null;
  const savedKeyReadable = () => props.savedCredential && props.credentialState === "readable";
  const previewBinding = (): ChannelBinding<AzureTtsConfig> => ({
    enabled: props.binding.enabled,
    configured: props.binding.configured,
    config: { region: savedRegion() },
    credentialRef: props.binding.credentialRef,
  });

  return (
    <>
      <FormField label={t("settings.tts.azure.region")}>
        <Input
          testID="settings-tts-region"
          value={region()}
          placeholder={t("settings.tts.azure.regionExample")}
          disabled={controlsLocked()}
          accessibilityLabel={t("settings.tts.azure.region")}
          onChange={(value) => updateRegion(value)}
        />
      </FormField>

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

      <TtsSamplePreview
        definition={azureTtsDefinition}
        binding={previewBinding()}
        host={props.host}
        language={() => AZURE_SAMPLE_LANGUAGE}
        disabled={() =>
          draftKeyPresent() ||
          !savedKeyReadable() ||
          regionDirty() ||
          regionProblem() ||
          savedRegionProblem()
        }
        note={() => {
          if (draftKeyPresent()) return t("settings.tts.previewUnsaved");
          if (!savedKeyReadable()) return t("settings.tts.previewNeedsKey");
          if (regionDirty()) return t("settings.tts.previewUnsavedRegion");
          return regionProblem() ? t("settings.tts.error.invalidRegion") : undefined;
        }}
      />
    </>
  );
}
