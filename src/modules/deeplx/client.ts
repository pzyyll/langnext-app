import { t } from "nsh/i18n";
import { isLanguageId, type LanguageId } from "../../framework/languages";
import { ProviderProtocolError } from "../ai/contracts/errors";
import type { JsonHttpClient, ResolvedRequestTarget } from "../ai/contracts/protocol";
import { createJsonHttpClient } from "../ai/runtime/http";
import type { FetchLike } from "../../services/http";
import { normalizeDeepLXEndpoint } from "./endpoint";
import { toDeepLXSourceLanguage, toDeepLXTargetLanguage } from "./languages";

/** DLX v1.3.1 enforces this limit on the text's UTF-16 code units, spaces and newlines included. */
export const DEEPLX_TEXT_LIMIT = 1_500;

export interface DeepLXClientOptions {
  /** Transport seam; a client is built from fetch when omitted. */
  http?: JsonHttpClient;
  fetchImpl?: FetchLike;
}

export interface DeepLXTranslateInput {
  endpointUrl: string;
  /** Server access token; null sends no Authorization header. */
  token: string | null;
  text: string;
  sourceLanguage: LanguageId;
  targetLanguage: LanguageId;
}

export interface DeepLXTranslateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DeepLXClient {
  /** Sends one buffered text translation and returns only the translated text. */
  translate(input: DeepLXTranslateInput, options?: DeepLXTranslateOptions): Promise<string>;
}

function invalidResponse(): ProviderProtocolError {
  return new ProviderProtocolError("invalid_response", t("deeplx.error.invalidResponse"));
}

/** Trims a server token and rejects anything but visible ASCII; null keeps the header off. */
function readableToken(raw: string | null): string | null {
  if (raw === null) return null;
  const token = raw.trim();
  if (token.length === 0 || /[^\x21-\x7E]/.test(token)) {
    throw new ProviderProtocolError("invalid_request", t("deeplx.error.tokenInvalid"));
  }
  return token;
}

/** Replaces transport categories with DeepLX-specific localized copy; never retries. */
function mapTransportError(error: unknown): never {
  if (!(error instanceof ProviderProtocolError)) {
    throw new ProviderProtocolError("network", t("protocol.error.networkDefault"));
  }
  if (error.kind === "cancelled" || error.kind === "timeout" || error.kind === "network") {
    throw error;
  }
  if (error.kind === "invalid_response") {
    throw invalidResponse();
  }

  const status = error.status;
  if (status === 401 || (status === undefined && error.kind === "auth")) {
    throw new ProviderProtocolError("auth", t("deeplx.error.auth"), status);
  }
  if (status === 403) {
    throw new ProviderProtocolError("auth", t("deeplx.error.accessDenied"), status);
  }
  if (status === 429) {
    throw new ProviderProtocolError("rate_limited", t("deeplx.error.rateLimited"), status);
  }
  if (status === 413) {
    throw new ProviderProtocolError("invalid_request", t("deeplx.error.tooLarge"), status);
  }
  if (error.kind === "server") {
    throw new ProviderProtocolError("server", t("deeplx.error.server"), status);
  }
  throw new ProviderProtocolError("invalid_request", t("deeplx.error.rejected"), status);
}

/** Creates the DeepLX client; it performs no I/O until a call. */
export function createDeepLXClient(options: DeepLXClientOptions = {}): DeepLXClient {
  const http =
    options.http ??
    createJsonHttpClient({
      fetchImpl: options.fetchImpl,
      logScope: "deeplx",
      privatePayloads: true,
    });

  return {
    translate: async (input, callOptions = {}) => {
      const endpointUrl = normalizeDeepLXEndpoint(input.endpointUrl);
      if (endpointUrl === null) {
        throw new ProviderProtocolError("invalid_request", t("deeplx.error.invalidEndpoint"));
      }
      if (input.text.trim().length === 0) {
        throw new ProviderProtocolError("invalid_request", t("quickTranslate.error.blankInput"));
      }
      if (!isLanguageId(input.sourceLanguage) || !isLanguageId(input.targetLanguage)) {
        throw new ProviderProtocolError("invalid_request", t("deeplx.error.unsupportedLanguage"));
      }
      const sourceLang = toDeepLXSourceLanguage(input.sourceLanguage);
      const targetLang = toDeepLXTargetLanguage(input.targetLanguage);
      if (sourceLang === null || targetLang === null) {
        throw new ProviderProtocolError("invalid_request", t("deeplx.error.unsupportedLanguage"));
      }
      if (input.text.length > DEEPLX_TEXT_LIMIT) {
        throw new ProviderProtocolError("invalid_request", t("deeplx.error.tooLarge"));
      }
      const token = readableToken(input.token);

      const body = {
        text: input.text,
        source_lang: sourceLang,
        target_lang: targetLang,
      };
      const target: ResolvedRequestTarget = {
        method: "POST",
        url: endpointUrl,
        headers: {
          "Content-Type": "application/json",
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        },
      };

      let response: Record<string, unknown>;
      try {
        response = await http.postJson(target, body, {
          signal: callOptions.signal,
          timeoutMs: callOptions.timeoutMs,
          redirect: "error",
        });
      } catch (error) {
        mapTransportError(error);
      }

      if (response.code !== 200) throw invalidResponse();
      const data = response.data;
      if (typeof data !== "string" || data.trim().length === 0) throw invalidResponse();
      return data;
    },
  };
}
