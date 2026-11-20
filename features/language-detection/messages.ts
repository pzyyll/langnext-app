import { t } from "nsh/i18n";
import type { LanguageResolutionFailureCode } from "./resolve";

/** Localized recovery text for a language-resolution failure, shared by every translation entry. */
export function languageResolutionErrorMessage(code: LanguageResolutionFailureCode): string {
  switch (code) {
    case "missing_native_language":
      return t("languageDetection.failure.missingNativeLanguage");
    case "missing_preferred_language":
      return t("languageDetection.failure.missingPreferredLanguage");
    case "unconfigured":
      return t("languageDetection.failure.unconfigured");
    case "no_eligible_model":
      return t("languageDetection.failure.noEligibleModel");
    case "unknown_language":
      return t("languageDetection.failure.unknownLanguage");
    case "unsupported_language":
      return t("languageDetection.failure.unsupportedLanguage");
    case "blank_input":
      return t("quickTranslate.error.blankInput");
    default:
      return t("languageDetection.failure.failed");
  }
}
