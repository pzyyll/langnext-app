import { t } from "nsh/i18n";
import type { LanguageId } from "../../features/presets/languages";
import { ProviderProtocolError } from "../ai/contracts/errors";
import type { JsonHttpClient, ResolvedRequestTarget } from "../ai/contracts/protocol";
import { createJsonHttpClient, type FetchLike } from "../ai/runtime/http";
import { toDeepLSourceLanguage, toDeepLTargetLanguage } from "./languages";

const DEEPL_FREE_URL = "https://api-free.deepl.com/v2/translate";
const DEEPL_PRO_URL = "https://api.deepl.com/v2/translate";

/** DeepL rejects a request body above this size before reading the text. */
export const DEEPL_MAX_REQUEST_BYTES = 128 * 1024;

export interface DeepLClientOptions {
  /** Transport seam; a client is built from fetch when omitted. */
  http?: JsonHttpClient;
  fetchImpl?: FetchLike;
}

export interface DeepLTranslateInput {
  apiKey: string;
  text: string;
  sourceLanguage: LanguageId;
  targetLanguage: LanguageId;
}

export interface DeepLTranslateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DeepLClient {
  /** Sends one buffered text translation and returns only the translated text. */
  translate(input: DeepLTranslateInput, options?: DeepLTranslateOptions): Promise<string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): ProviderProtocolError {
  return new ProviderProtocolError("invalid_response", t("deepl.error.invalidResponse"));
}

/** Replaces transport categories with DeepL-specific localized copy; never retries. */
function mapTransportError(error: unknown): never {
  if (!(error instanceof ProviderProtocolError)) {
    throw new ProviderProtocolError("network", t("protocol.error.networkDefault"));
  }
  if (error.kind === "cancelled" || error.kind === "timeout" || error.kind === "network") {
    throw error;
  }
  if (error.kind === "invalid_response") {
    throw new ProviderProtocolError("invalid_response", t("deepl.error.invalidResponse"));
  }

  const status = error.status;
  if (status === 403 || error.kind === "auth") {
    throw new ProviderProtocolError("auth", t("deepl.error.auth"), status);
  }
  if (status === 413) {
    throw new ProviderProtocolError("invalid_request", t("deepl.error.tooLarge"), status);
  }
  if (status === 429) {
    throw new ProviderProtocolError("rate_limited", t("deepl.error.rateLimited"), status);
  }
  if (status === 456) {
    throw new ProviderProtocolError("rate_limited", t("deepl.error.quota"), status);
  }
  if (error.kind === "server") {
    throw new ProviderProtocolError("server", t("deepl.error.server"), status);
  }
  throw new ProviderProtocolError("invalid_request", t("deepl.error.rejected"), status);
}

/** Creates the DeepL text-translation client; it performs no I/O until a call. */
export function createDeepLClient(options: DeepLClientOptions = {}): DeepLClient {
  const http = options.http ?? createJsonHttpClient({ fetchImpl: options.fetchImpl });

  return {
    translate: async (input, callOptions = {}) => {
      const apiKey = input.apiKey.trim();
      if (!apiKey) {
        throw new ProviderProtocolError("auth", t("deepl.error.missingKey"));
      }

      const sourceLang = toDeepLSourceLanguage(input.sourceLanguage);
      const targetLang = toDeepLTargetLanguage(input.targetLanguage);
      if (sourceLang === null || targetLang === null) {
        throw new ProviderProtocolError("invalid_request", t("deepl.error.unsupportedLanguage"));
      }

      const body = {
        text: [input.text],
        source_lang: sourceLang,
        target_lang: targetLang,
      };
      const serialized = JSON.stringify(body);
      if (new TextEncoder().encode(serialized).length > DEEPL_MAX_REQUEST_BYTES) {
        throw new ProviderProtocolError("invalid_request", t("deepl.error.tooLarge"));
      }

      const target: ResolvedRequestTarget = {
        method: "POST",
        url: apiKey.endsWith(":fx") ? DEEPL_FREE_URL : DEEPL_PRO_URL,
        headers: {
          Authorization: `DeepL-Auth-Key ${apiKey}`,
          "Content-Type": "application/json",
        },
      };

      let response: Record<string, unknown>;
      try {
        response = await http.postJson(target, body, {
          signal: callOptions.signal,
          timeoutMs: callOptions.timeoutMs,
        });
      } catch (error) {
        mapTransportError(error);
      }

      const translations = response.translations;
      if (!Array.isArray(translations) || translations.length === 0) {
        throw invalidResponse();
      }
      const first = translations[0];
      if (!isPlainObject(first) || typeof first.text !== "string") {
        throw invalidResponse();
      }
      return first.text;
    },
  };
}
