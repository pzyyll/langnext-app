import { t } from "nsh/i18n";
import type { LanguageId } from "../../features/presets/languages";
import { ProviderProtocolError } from "../ai/contracts/errors";
import type { JsonHttpClient, ResolvedRequestTarget } from "../ai/contracts/protocol";
import { createJsonHttpClient } from "../ai/runtime/http";
import type { FetchLike } from "../../services/http";
import { toGoogleTranslationLanguage } from "./languages";

const GOOGLE_TRANSLATION_URL = "https://translation.googleapis.com/language/translate/v2";
const GOOGLE_TRANSLATION_DETECT_URL = `${GOOGLE_TRANSLATION_URL}/detect`;

/** Google rejects a request whose serialized body exceeds 100,000 bytes. */
export const GOOGLE_CLOUD_TRANSLATION_MAX_REQUEST_BYTES = 100_000;

export interface GoogleCloudTranslateClientOptions {
  /** Transport seam; a client is built from fetch when omitted. */
  http?: JsonHttpClient;
  fetchImpl?: FetchLike;
}

export interface GoogleCloudTranslateInput {
  apiKey: string;
  text: string;
  sourceLanguage: LanguageId;
  targetLanguage: LanguageId;
}

export interface GoogleCloudTranslateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GoogleCloudDetectInput {
  apiKey: string;
  text: string;
}

export interface GoogleCloudDetectOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GoogleCloudTranslateClient {
  /** Sends one buffered plain-text translation and returns only the translated text. */
  translate(
    input: GoogleCloudTranslateInput,
    options?: GoogleCloudTranslateOptions,
  ): Promise<string>;
  /** Sends one buffered sample and returns the language code Google detected. */
  detect(input: GoogleCloudDetectInput, options?: GoogleCloudDetectOptions): Promise<string>;
}

function requireApiKey(raw: string): string {
  const apiKey = raw.trim();
  if (!apiKey) {
    throw new ProviderProtocolError("auth", t("googleCloud.error.missingKey"));
  }
  return apiKey;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): ProviderProtocolError {
  return new ProviderProtocolError("invalid_response", t("googleCloud.error.invalidResponse"));
}

const DAILY_QUOTA_REASONS = new Set(["dailyLimitExceeded"]);
const RATE_LIMIT_REASONS = new Set(["userRateLimitExceeded", "rateLimitExceeded"]);
const KEY_REJECTION_REASONS = new Set([
  "keyInvalid",
  "keyExpired",
  "apiKeyInvalid",
  "accessNotConfigured",
  "SERVICE_DISABLED",
  "PERMISSION_DENIED",
  "forbidden",
]);
const KEY_REJECTION_MESSAGES = [
  "api key not valid",
  "api key is invalid",
  "api key expired",
  "missing a valid api key",
  "api key is missing",
  "has not been used in project",
  "is disabled",
  "permission denied",
  "does not have permission",
  "billing",
];

interface GoogleErrorDetails {
  messageText: string;
  reasons: Set<string>;
}

function readGoogleErrorDetails(body: Record<string, unknown>): GoogleErrorDetails {
  const messages: string[] = [];
  const reasons = new Set<string>();
  const error = body.error;
  if (!isPlainObject(error)) {
    return { messageText: "", reasons };
  }
  if (typeof error.message === "string") messages.push(error.message);
  if (typeof error.status === "string") messages.push(error.status);
  if (Array.isArray(error.errors)) {
    for (const entry of error.errors) {
      if (!isPlainObject(entry)) continue;
      if (typeof entry.message === "string") messages.push(entry.message);
      if (typeof entry.reason === "string") reasons.add(entry.reason);
    }
  }
  return { messageText: messages.join(" ").toLowerCase(), reasons };
}

/**
 * Classifies only documented quota limits and recognized key or access rejections.
 * Everything else keeps the shared status mapping, so unknown bodies never become a bad-key claim.
 */
function classifyGoogleErrorResponse(status: number, body: unknown): ProviderProtocolError | null {
  if (!isPlainObject(body)) return null;
  const { messageText, reasons } = readGoogleErrorDetails(body);

  if (status === 403 || status === 429) {
    const dailyQuota =
      [...DAILY_QUOTA_REASONS].some((reason) => reasons.has(reason)) ||
      messageText.includes("daily limit exceeded");
    if (dailyQuota) {
      return new ProviderProtocolError("rate_limited", t("googleCloud.error.quota"), status);
    }
    const perMinute =
      [...RATE_LIMIT_REASONS].some((reason) => reasons.has(reason)) ||
      messageText.includes("user rate limit exceeded") ||
      messageText.includes("rate limit exceeded");
    if (perMinute) {
      return new ProviderProtocolError("rate_limited", t("googleCloud.error.rateLimited"), status);
    }
  }

  const keyRejected =
    [...KEY_REJECTION_REASONS].some((reason) => reasons.has(reason)) ||
    KEY_REJECTION_MESSAGES.some((message) => messageText.includes(message));
  if (keyRejected) {
    return new ProviderProtocolError("auth", t("googleCloud.error.auth"), status);
  }
  return null;
}

/** Replaces transport categories with Google-specific localized copy; never retries. */
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
  if (error.kind === "rate_limited") {
    // A classifier result already names the documented quota case; a bare 429 gets the generic copy.
    throw new ProviderProtocolError(
      "rate_limited",
      error.status === 429 ? t("googleCloud.error.rateLimited") : error.message,
      error.status,
    );
  }
  if (error.kind === "server") {
    throw new ProviderProtocolError("server", t("googleCloud.error.server"), error.status);
  }
  if (error.kind === "auth") {
    throw new ProviderProtocolError("auth", t("googleCloud.error.auth"), error.status);
  }
  if (error.status === 413) {
    throw new ProviderProtocolError("invalid_request", t("googleCloud.error.tooLarge"), 413);
  }
  throw new ProviderProtocolError("invalid_request", t("googleCloud.error.rejected"), error.status);
}

/** Creates the Google Cloud Translation Basic v2 client; it performs no I/O until a call. */
export function createGoogleCloudTranslateClient(
  options: GoogleCloudTranslateClientOptions = {},
): GoogleCloudTranslateClient {
  const http =
    options.http ??
    createJsonHttpClient({
      fetchImpl: options.fetchImpl,
      logScope: "google-cloud/translate",
      classifyErrorResponse: classifyGoogleErrorResponse,
    });

  /** Posts one bounded JSON body. Size, key, and transport failures raise the shared errors. */
  const post = async (
    url: string,
    apiKey: string,
    body: Record<string, unknown>,
    callOptions: GoogleCloudTranslateOptions,
  ): Promise<Record<string, unknown>> => {
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).length > GOOGLE_CLOUD_TRANSLATION_MAX_REQUEST_BYTES) {
      throw new ProviderProtocolError("invalid_request", t("googleCloud.error.tooLarge"));
    }

    const request: ResolvedRequestTarget = {
      method: "POST",
      url,
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
    };

    try {
      return await http.postJson(request, body, {
        signal: callOptions.signal,
        timeoutMs: callOptions.timeoutMs,
        redirect: "error",
      });
    } catch (error) {
      mapTransportError(error);
    }
  };

  const requireSample = (text: string): void => {
    if (text.trim().length === 0) {
      throw new ProviderProtocolError("invalid_request", t("googleCloud.error.blankInput"));
    }
  };

  return {
    translate: async (input, callOptions = {}) => {
      const apiKey = requireApiKey(input.apiKey);
      requireSample(input.text);

      const source = toGoogleTranslationLanguage(input.sourceLanguage);
      const target = toGoogleTranslationLanguage(input.targetLanguage);
      if (source === null || target === null) {
        throw new ProviderProtocolError(
          "invalid_request",
          t("googleCloud.error.unsupportedLanguage"),
        );
      }

      // Always send both resolved codes; omit model so the default NMT model applies.
      const response = await post(
        GOOGLE_TRANSLATION_URL,
        apiKey,
        { q: [input.text], source, target, format: "text" },
        callOptions,
      );

      const data = response.data;
      if (!isPlainObject(data)) throw invalidResponse();
      const translations = data.translations;
      if (!Array.isArray(translations) || translations.length === 0) throw invalidResponse();
      const first = translations[0];
      if (!isPlainObject(first) || typeof first.translatedText !== "string") {
        throw invalidResponse();
      }
      return first.translatedText;
    },
    detect: async (input, callOptions = {}) => {
      const apiKey = requireApiKey(input.apiKey);
      requireSample(input.text);

      const response = await post(
        GOOGLE_TRANSLATION_DETECT_URL,
        apiKey,
        { q: [input.text] },
        callOptions,
      );

      const data = response.data;
      if (!isPlainObject(data)) throw invalidResponse();
      const detections = data.detections;
      if (!Array.isArray(detections) || detections.length === 0) throw invalidResponse();
      // One input answers one detection list that holds the language and its confidence.
      const sentence = detections[0];
      if (!Array.isArray(sentence) || sentence.length === 0) throw invalidResponse();
      const first = sentence[0];
      if (!isPlainObject(first) || typeof first.language !== "string") throw invalidResponse();
      return first.language;
    },
  };
}
