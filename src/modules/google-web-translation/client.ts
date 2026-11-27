// ABOUTME: The keyless Google Web translation client: one form POST and a one-element answer.
// ABOUTME: It never reads a credential, retries, or forwards provider text to the user.
import { t } from "nsh/i18n";
import { isLanguageId, type LanguageId } from "../../framework/languages";
import { ProviderProtocolError } from "../ai/contracts/errors";
import type { FetchLike } from "../../services/http";
import { createGoogleWebTransport } from "./transport";

export interface GoogleWebTranslateClientOptions {
  /** Transport seam; defaults to the app's logging HTTP wrapper. */
  fetchImpl?: FetchLike;
}

export interface GoogleWebTranslateInput {
  text: string;
  sourceLanguage: LanguageId;
  targetLanguage: LanguageId;
}

export interface GoogleWebTranslateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GoogleWebTranslateClient {
  /** Sends one buffered plain-text translation and returns only the translated text. */
  translate(input: GoogleWebTranslateInput, options?: GoogleWebTranslateOptions): Promise<string>;
}

/** `zh` is Simplified Chinese on this endpoint; every other supported ID is sent unchanged. */
function toWireLanguage(language: LanguageId): string {
  return language === "zh" ? "zh-CN" : language;
}

function invalidResponse(): ProviderProtocolError {
  return new ProviderProtocolError("invalid_response", t("googleWeb.error.invalidResponse"));
}

/** Creates the Google Web translation client; it performs no I/O until a call. */
export function createGoogleWebTranslateClient(
  options: GoogleWebTranslateClientOptions = {},
): GoogleWebTranslateClient {
  // Translation keeps request and response text out of the log and never follows a redirect.
  const post = createGoogleWebTransport({
    fetchImpl: options.fetchImpl,
    scope: "google-web/translate",
    redirect: "error",
    logBodies: false,
    logFailureDetail: false,
  });

  return {
    translate: async (input, callOptions = {}) => {
      if (input.text.trim().length === 0) {
        throw new ProviderProtocolError("invalid_request", t("quickTranslate.error.blankInput"));
      }
      if (!isLanguageId(input.sourceLanguage) || !isLanguageId(input.targetLanguage)) {
        throw new ProviderProtocolError(
          "invalid_request",
          t("googleWeb.error.unsupportedLanguage"),
        );
      }

      const payload = await post({
        source: toWireLanguage(input.sourceLanguage),
        target: toWireLanguage(input.targetLanguage),
        text: input.text,
        signal: callOptions.signal,
        timeoutMs: callOptions.timeoutMs,
      });

      if (!Array.isArray(payload) || payload.length !== 1) throw invalidResponse();
      const translated = payload[0];
      if (typeof translated !== "string" || translated.trim().length === 0) {
        throw invalidResponse();
      }
      return translated;
    },
  };
}
