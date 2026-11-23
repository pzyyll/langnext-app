import { t } from "nsh/i18n";
import type { LanguageId } from "../../features/presets/languages";
import { ProviderProtocolError } from "../ai/contracts/errors";
import type { JsonHttpClient, ResolvedRequestTarget } from "../ai/contracts/protocol";
import { createJsonHttpClient, type FetchLike } from "../ai/runtime/http";
import { toDeepLSourceLanguage, toDeepLTargetLanguage } from "./languages";

const DEEPL_FREE_HOST = "https://api-free.deepl.com";
const DEEPL_PRO_HOST = "https://api.deepl.com";

/** DeepL rejects a request body above this size before reading the text. */
export const DEEPL_MAX_REQUEST_BYTES = 128 * 1024;

/** `character_limit` value DeepL returns when the account has no character limit. */
export const DEEPL_NO_CHARACTER_LIMIT = 1_000_000_000_000;

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

export interface DeepLUsageInput {
  apiKey: string;
}

export interface DeepLUsage {
  /** Characters translated in the current billing period, text and documents together. */
  characterCount: number;
  /** Current limit; {@link DEEPL_NO_CHARACTER_LIMIT} when the account has none. */
  characterLimit: number;
  /** Characters used by this key; present for Pro API accounts only. */
  apiKeyCharacterCount: number | null;
  /** End of the usage period; present for Pro API accounts only. */
  periodEnd: string | null;
}

export interface DeepLUsageOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DeepLClient {
  /** Sends one buffered text translation and returns only the translated text. */
  translate(input: DeepLTranslateInput, options?: DeepLTranslateOptions): Promise<string>;
  /** Reads character usage and limits for the key's current billing period. */
  getUsage(input: DeepLUsageInput, options?: DeepLUsageOptions): Promise<DeepLUsage>;
}

/** API Free keys end with `:fx`; every other key uses the Pro host. */
function deeplApiUrl(apiKey: string, path: string): string {
  return `${apiKey.endsWith(":fx") ? DEEPL_FREE_HOST : DEEPL_PRO_HOST}${path}`;
}

function requireApiKey(raw: string): string {
  const apiKey = raw.trim();
  if (!apiKey) {
    throw new ProviderProtocolError("auth", t("deepl.error.missingKey"));
  }
  return apiKey;
}

/** Reads one non-negative integer field; absent or malformed values become null. */
function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
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

/** Creates the DeepL client; it performs no I/O until a call. */
export function createDeepLClient(options: DeepLClientOptions = {}): DeepLClient {
  const http = options.http ?? createJsonHttpClient({ fetchImpl: options.fetchImpl });

  return {
    translate: async (input, callOptions = {}) => {
      const apiKey = requireApiKey(input.apiKey);

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
        url: deeplApiUrl(apiKey, "/v2/translate"),
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
    getUsage: async (input, callOptions = {}) => {
      const apiKey = requireApiKey(input.apiKey);
      const target: ResolvedRequestTarget = {
        method: "GET",
        url: deeplApiUrl(apiKey, "/v2/usage"),
        headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
      };

      let response: Record<string, unknown>;
      try {
        response = await http.getJson(target, {
          signal: callOptions.signal,
          timeoutMs: callOptions.timeoutMs,
          redirect: "error",
        });
      } catch (error) {
        mapTransportError(error);
      }

      const characterCount = readCount(response.character_count);
      const characterLimit = readCount(response.character_limit);
      if (characterCount === null || characterLimit === null) {
        throw invalidResponse();
      }
      return {
        characterCount,
        characterLimit,
        apiKeyCharacterCount: readCount(response.api_key_character_count),
        periodEnd:
          typeof response.end_time === "string" && response.end_time.length > 0
            ? response.end_time
            : null,
      };
    },
  };
}
