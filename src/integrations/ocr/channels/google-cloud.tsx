// ABOUTME: The OCR channel that reads screenshots with Google Cloud Vision and one API key.
// ABOUTME: The key stays in the vault, so the stored config carries no fields.
import { View } from "nsh";
import { t } from "nsh/i18n";
import googleCloudIcon from "../../../../assets/icons/google-cloud.svg";
import { Input } from "../../../components/ui/input";
import type {
  CapabilityChannelDefinition,
  ChannelSettingsProps,
} from "../../../framework/integrations";
import { FormField } from "../../../modules/ai/ui/form-field";
import { createGoogleCloudOcrClient } from "../vendor/google-cloud";
import {
  credentialValue,
  isJsonObject,
  OCR_TIMEOUT_MS,
  type OcrChannelOutcome,
  type OcrRecognizeInput,
} from "../recognition";

/** Cloud Vision stores only its key, so a saved channel has no configuration fields. */
export type OcrGoogleCloudConfig = Record<string, never>;

function trimmedDraft(value: string | undefined): string {
  return (value ?? "").trim();
}

function OcrGoogleCloudSettings(props: ChannelSettingsProps<OcrGoogleCloudConfig>) {
  const canKeepKey = () => props.savedCredential && props.credentialState === "readable";

  return (
    <View class="gap-3">
      <FormField label={t("settings.ocr.apiKey")}>
        <Input
          testID="settings-ocr-google-api-key"
          value={props.credentialDraft.apiKey ?? ""}
          placeholder={canKeepKey() ? t("settings.ocr.savedKeys") : undefined}
          masked={true}
          disabled={props.disabled}
          accessibilityLabel={t("settings.ocr.apiKey")}
          onChange={(value) => props.onCredentialChange("apiKey", value)}
        />
      </FormField>
    </View>
  );
}

/** The Google Cloud Vision OCR channel. */
export const googleCloudOcrChannel: CapabilityChannelDefinition<
  OcrGoogleCloudConfig,
  OcrRecognizeInput,
  OcrChannelOutcome
> = {
  id: "google-cloud",
  capability: "ocr",
  labelKey: "settings.ocr.google-cloud",
  icon: googleCloudIcon,
  iconTone: "brand",
  configurable: true,
  config: {
    parse: (raw) => (isJsonObject(raw) ? {} : null),
    defaults: () => ({}),
  },
  credential: [{ key: "apiKey", labelKey: "settings.ocr.apiKey", masked: true }],
  credentialUnreadableKey: "settings.ocr.googleKeyUnreadable",
  describe: () => t("settings.ocr.configured"),
  validate: ({ credentialDraft, savedCredential }) => {
    const apiKey = trimmedDraft(credentialDraft.apiKey);
    if (apiKey.length > 0 || savedCredential) return { ok: true };
    return { ok: false, key: "settings.ocr.error.googleCloudKeyRequired" };
  },
  saveAvailable: ({ credentialDraft, credentialReadable }) =>
    trimmedDraft(credentialDraft.apiKey).length > 0 || credentialReadable,
  readiness: async (_binding, host) =>
    credentialValue(host.credential, "apiKey").length > 0
      ? { ready: true }
      : { ready: false, reason: t("ocr.failure.unconfigured") },
  execute: async (_binding, input, host) => {
    if (input.signal?.aborted) return { status: "cancelled" };
    const apiKey = credentialValue(host.credential, "apiKey");
    if (apiKey.length === 0) {
      return { status: "unavailable", reason: t("ocr.failure.unconfigured") };
    }

    const result = await createGoogleCloudOcrClient({ fetchImpl: host.fetchImpl }).recognize(
      { apiKey, imageBase64: Buffer.from(input.png).toString("base64") },
      { signal: input.signal, timeoutMs: input.timeoutMs ?? OCR_TIMEOUT_MS },
    );

    switch (result.status) {
      case "recognized":
        return { status: "recognized", text: result.text };
      case "no_text":
        return { status: "no_text" };
      case "cancelled":
        return { status: "cancelled" };
      case "failed":
        return { status: "failed", failure: result.failure };
    }
  },
  failureKey: (failure) => {
    switch (failure) {
      case "image_too_large":
        return "ocr.failure.imageTooLarge";
      case "setup":
        return "ocr.failure.googleSetup";
      case "quota":
        return "ocr.failure.googleQuota";
      case "malformed":
        return "ocr.failure.googleResponse";
      case "timeout":
        return "ocr.failure.timeout";
      case "service":
        return "ocr.failure.googleFailed";
      default:
        return null;
    }
  },
  Settings: OcrGoogleCloudSettings,
};
