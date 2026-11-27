import type { LanguageId } from "../../framework/languages";
import { toDeepLSourceLanguage, toDeepLTargetLanguage } from "../deepl/languages";

const DEEPLX_EXTRA_SOURCE_CODES: Partial<Record<LanguageId, string>> = {
  he: "HE",
  vi: "VI",
};

const DEEPLX_EXTRA_TARGET_CODES: Partial<Record<LanguageId, string>> = {
  he: "HE",
  vi: "VI",
};

/** Maps an app language to its DLX source code, or null when the server cannot read it. */
export function toDeepLXSourceLanguage(id: LanguageId): string | null {
  return DEEPLX_EXTRA_SOURCE_CODES[id] ?? toDeepLSourceLanguage(id);
}

/** Maps an app language to its DLX target code, or null when the server cannot write it. */
export function toDeepLXTargetLanguage(id: LanguageId): string | null {
  return DEEPLX_EXTRA_TARGET_CODES[id] ?? toDeepLTargetLanguage(id);
}
