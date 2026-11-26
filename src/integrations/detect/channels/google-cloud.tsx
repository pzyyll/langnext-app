// ABOUTME: Google Cloud Translation v2 detection channel with one stored API key.
// ABOUTME: Execution reads the host's credential record once and maps Google's code onto a supported ID.
import { t } from "nsh/i18n";
import googleCloudMark from "../../../../assets/icons/google-cloud.svg";
import { Input } from "../../../components/ui/input";
import { FormField } from "../../../modules/ai/ui/form-field";
import { ProviderProtocolError } from "../../../modules/ai/contracts/errors";
import { createGoogleCloudTranslateClient } from "../../../modules/google-cloud-translation/client";
import type {
  CapabilityChannelDefinition,
  ChannelSettingsProps,
  ConfigSchema,
} from "../../../framework/integrations";
import type { LanguageId } from "../../../framework/languages";
import { DetectionChannelError, detectionFailureKey, type DetectionRequest } from "../types";
import { normalizeGoogleLanguageCode } from "../vendor/google-free";

export type GoogleCloudDetectionConfig = Record<string, never>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const googleCloudDetectionConfig: ConfigSchema<GoogleCloudDetectionConfig> = {
  parse: (raw) => (isPlainObject(raw) ? {} : null),
  defaults: () => ({}),
};

/** Controlled API-key field: the host owns the draft, the vault write, and the save action. */
function GoogleCloudDetectionSettings(props: ChannelSettingsProps<GoogleCloudDetectionConfig>) {
  const apiKey = () => props.credentialDraft["apiKey"] ?? "";
  const canKeepKey = () => props.savedCredential && props.credentialState === "readable";

  return (
    <FormField label={t("settings.languageDetection.apiKey")}>
      <Input
        testID="settings-detection-google-cloud-api-key"
        value={apiKey()}
        placeholder={canKeepKey() ? t("settings.languageDetection.savedApiKey") : undefined}
        masked={true}
        disabled={props.disabled}
        accessibilityLabel={t("settings.languageDetection.apiKey")}
        onChange={(value) => props.onCredentialChange("apiKey", value)}
      />
    </FormField>
  );
}

export const googleCloudDetectionDefinition: CapabilityChannelDefinition<
  GoogleCloudDetectionConfig,
  DetectionRequest,
  LanguageId
> = {
  id: "google-cloud",
  capability: "detect",
  labelKey: "settings.languageDetection.google-cloud",
  icon: googleCloudMark,
  iconTone: "brand",
  configurable: true,
  config: googleCloudDetectionConfig,
  credential: [{ key: "apiKey", labelKey: "settings.languageDetection.apiKey", masked: true }],
  credentialUnreadableKey: "settings.languageDetection.googleCloudKeyUnreadable",
  describe: (binding) =>
    binding.credentialRef === null
      ? t("settings.languageDetection.notConfigured")
      : t("settings.languageDetection.googleCloudSummary"),
  validate: ({ credentialDraft, savedCredential }) => {
    const draft = credentialDraft["apiKey"]?.trim() ?? "";
    return draft.length > 0 || savedCredential
      ? { ok: true }
      : {
          ok: false,
          key: "settings.languageDetection.error.googleCloudKeyRequired",
          field: "apiKey",
        };
  },
  saveAvailable: ({ credentialDraft, credentialReadable }) =>
    (credentialDraft["apiKey"] ?? "").trim().length > 0 || credentialReadable,
  readiness: async (_binding, host) =>
    (host.credential?.["apiKey"] ?? "").trim().length > 0
      ? { ready: true }
      : { ready: false, reason: "failed" },
  execute: async (_binding, input, host) => {
    const apiKey = (host.credential?.["apiKey"] ?? "").trim();
    if (apiKey.length === 0) throw new DetectionChannelError("failed");
    if (input.signal?.aborted) throw new DetectionChannelError("cancelled");

    const client = createGoogleCloudTranslateClient({ fetchImpl: host.fetchImpl });
    let code: string;
    try {
      code = await client.detect(
        { apiKey, text: input.sample },
        { signal: input.signal, timeoutMs: input.timeoutMs },
      );
    } catch (error) {
      if (
        input.signal?.aborted ||
        (error instanceof ProviderProtocolError && error.kind === "cancelled")
      ) {
        throw new DetectionChannelError("cancelled");
      }
      throw new DetectionChannelError("failed");
    }
    if (input.signal?.aborted) throw new DetectionChannelError("cancelled");

    const language = normalizeGoogleLanguageCode(code);
    if (language === null) throw new DetectionChannelError("unsupported_language");
    return language;
  },
  failureKey: detectionFailureKey,
  Settings: GoogleCloudDetectionSettings,
};
