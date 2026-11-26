// ABOUTME: The keyless free Google Translate detection channel; nothing to configure or store.
// ABOUTME: `add()` enables it immediately because it has neither config fields nor credentials.
import { t } from "nsh/i18n";
import googleMark from "../../../../assets/icons/google.svg";
import type { CapabilityChannelContribution, ConfigSchema } from "../../../framework/contributions";
import type { LanguageId } from "../../../framework/languages";
import { DetectionChannelError, detectionFailureKey, type DetectionRequest } from "../types";
import { requestGoogleFreeDetection } from "../vendor/google-free";

export type GoogleDetectionConfig = Record<string, never>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const googleDetectionConfig: ConfigSchema<GoogleDetectionConfig> = {
  parse: (raw) => (isPlainObject(raw) ? {} : null),
  defaults: () => ({}),
};

export const googleDetectionContribution: CapabilityChannelContribution<
  GoogleDetectionConfig,
  DetectionRequest,
  LanguageId
> = {
  id: "google",
  capability: "detect",
  labelKey: "settings.languageDetection.google",
  icon: googleMark,
  iconTone: "brand",
  configurable: false,
  config: googleDetectionConfig,
  credential: null,
  describe: () => t("settings.languageDetection.googleSummary"),
  readiness: async () => ({ ready: true }),
  execute: async (binding, input, host) => {
    const outcome = await requestGoogleFreeDetection(input.sample, {
      fetchImpl: host.fetchImpl,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    if (outcome.ok) return outcome.language;
    throw new DetectionChannelError(outcome.code);
  },
  failureKey: detectionFailureKey,
};
