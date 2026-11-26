// ABOUTME: The OCR channel that reads screenshots with Baidu OCR and one API/Secret Key pair.
// ABOUTME: The pair stays in the vault; the stored config keeps only the recognition mode.
import { View } from "nsh";
import { t } from "nsh/i18n";
import baiduCloudIcon from "../../../../assets/icons/baidu-cloud.svg";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import type {
  CapabilityChannelContribution,
  ChannelSettingsProps,
} from "../../../framework/contributions";
import { FormField } from "../../../modules/ai/ui/form-field";
import {
  BAIDU_OCR_OPERATIONS,
  createBaiduOcrClient,
  type BaiduOcrOperation,
} from "../vendor/baidu";
import {
  credentialValue,
  isJsonObject,
  OCR_TIMEOUT_MS,
  type OcrChannelOutcome,
  type OcrRecognizeInput,
} from "../recognition";

export interface OcrBaiduConfig {
  operation: BaiduOcrOperation;
}

function isBaiduOcrOperation(value: unknown): value is BaiduOcrOperation {
  return typeof value === "string" && (BAIDU_OCR_OPERATIONS as readonly string[]).includes(value);
}

function trimmedDraft(value: string | undefined): string {
  return (value ?? "").trim();
}

function OcrBaiduSettings(props: ChannelSettingsProps<OcrBaiduConfig>) {
  const canKeepKeys = () => props.savedCredential && props.credentialState === "readable";
  const placeholder = () => (canKeepKeys() ? t("settings.ocr.savedKeys") : undefined);

  return (
    <View class="gap-3">
      <FormField label={t("settings.ocr.mode")}>
        <Select
          testID="settings-ocr-baidu-operation"
          items={BAIDU_OCR_OPERATIONS.map((operation) => ({
            value: operation,
            title: t(`settings.ocr.operation.${operation}`),
          }))}
          value={props.binding.config.operation}
          disabled={props.disabled}
          accessibilityLabel={t("settings.ocr.mode")}
          onChange={(value) => {
            if (!isBaiduOcrOperation(value)) return;
            props.onChange({ operation: value });
          }}
        />
      </FormField>

      <FormField label={t("settings.ocr.apiKey")}>
        <Input
          testID="settings-ocr-baidu-api-key"
          value={props.credentialDraft.apiKey ?? ""}
          placeholder={placeholder()}
          masked={true}
          disabled={props.disabled}
          accessibilityLabel={t("settings.ocr.apiKey")}
          onChange={(value) => props.onCredentialChange("apiKey", value)}
        />
      </FormField>

      <FormField label={t("settings.ocr.secretKey")}>
        <Input
          testID="settings-ocr-baidu-secret-key"
          value={props.credentialDraft.secretKey ?? ""}
          placeholder={placeholder()}
          masked={true}
          disabled={props.disabled}
          accessibilityLabel={t("settings.ocr.secretKey")}
          onChange={(value) => props.onCredentialChange("secretKey", value)}
        />
      </FormField>
    </View>
  );
}

/** The Baidu OCR channel. */
export const baiduOcrChannel: CapabilityChannelContribution<
  OcrBaiduConfig,
  OcrRecognizeInput,
  OcrChannelOutcome
> = {
  id: "baidu",
  capability: "ocr",
  labelKey: "settings.ocr.baidu",
  icon: baiduCloudIcon,
  iconTone: "brand",
  configurable: true,
  config: {
    parse: (raw) => {
      if (!isJsonObject(raw) || !isBaiduOcrOperation(raw.operation)) return null;
      return { operation: raw.operation };
    },
    defaults: () => ({ operation: "accurate" }),
  },
  credential: [
    { key: "apiKey", labelKey: "settings.ocr.apiKey", masked: true },
    { key: "secretKey", labelKey: "settings.ocr.secretKey", masked: true },
  ],
  credentialUnreadableKey: "settings.ocr.keysUnreadable",
  describe: (binding) => t(`settings.ocr.operation.${binding.config.operation}`),
  validate: ({ credentialDraft, savedCredential }) => {
    const apiKey = trimmedDraft(credentialDraft.apiKey);
    const secretKey = trimmedDraft(credentialDraft.secretKey);
    if (apiKey.length > 0 && secretKey.length > 0) return { ok: true };
    if (apiKey.length === 0 && secretKey.length === 0 && savedCredential) return { ok: true };
    return { ok: false, key: "settings.ocr.error.baiduKeysRequired" };
  },
  saveAvailable: ({ credentialDraft, credentialReadable }) => {
    const apiKey = trimmedDraft(credentialDraft.apiKey);
    const secretKey = trimmedDraft(credentialDraft.secretKey);
    if (apiKey.length > 0 || secretKey.length > 0) {
      return apiKey.length > 0 && secretKey.length > 0;
    }
    return credentialReadable;
  },
  readiness: async (_binding, host) => {
    const apiKey = credentialValue(host.credential, "apiKey");
    const secretKey = credentialValue(host.credential, "secretKey");
    if (apiKey.length === 0 || secretKey.length === 0) {
      return { ready: false, reason: t("ocr.failure.unconfigured") };
    }
    return { ready: true };
  },
  execute: async (binding, input, host) => {
    if (input.signal?.aborted) return { status: "cancelled" };
    const apiKey = credentialValue(host.credential, "apiKey");
    const secretKey = credentialValue(host.credential, "secretKey");
    if (apiKey.length === 0 || secretKey.length === 0) {
      return { status: "unavailable", reason: t("ocr.failure.unconfigured") };
    }

    const result = await createBaiduOcrClient({ fetchImpl: host.fetchImpl }).recognize(
      {
        operation: binding.config.operation,
        credentials: { apiKey, secretKey },
        png: input.png,
      },
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
      case "invalid_image":
        return "ocr.failure.invalidImage";
      case "image_too_small":
        return "ocr.failure.imageTooSmall";
      case "image_too_large":
        return "ocr.failure.imageTooLarge";
      case "credentials":
        return "ocr.failure.baiduCredentials";
      case "rate_limited":
        return "ocr.failure.baiduLater";
      case "quota":
        return "ocr.failure.baiduQuota";
      case "malformed":
        return "ocr.failure.baiduResponse";
      case "timeout":
        return "ocr.failure.timeout";
      case "service":
        return "ocr.failure.failed";
      default:
        return null;
    }
  },
  Settings: OcrBaiduSettings,
};
