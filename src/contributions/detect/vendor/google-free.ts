// ABOUTME: Free Google Translate `translate_a/t` client used by the google detect channel.
// ABOUTME: Undocumented and unkeyed: the sample travels in a form body and every failure maps to a code.
import { DEFAULT_HTTP_TIMEOUT_MS } from "../../../modules/ai/runtime/http";
import { createHttpFetch, type FetchLike } from "../../../services/http";
import { isLanguageId, type LanguageId } from "../../../framework/languages";

/**
 * Free Google Translate endpoint used by the `google` detector. It is undocumented and has no
 * support contract: no key, per-IP rate limits, and a plain-text refusal page under abuse.
 * The sample travels in a form body, so it never appears in a URL.
 */
export const GOOGLE_DETECTION_URL =
  "https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=en";

/** Legacy codes Google still answers with for two supported languages. */
const GOOGLE_CODE_ALIASES: Record<string, LanguageId> = { iw: "he", in: "id" };

/** Minimal response shape the Google request needs; a real `Response` satisfies it. */
export interface GoogleDetectionResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Fetch boundary replacement point for isolated tests. */
export type GoogleDetectionFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<GoogleDetectionResponseLike>;

/** Why one free-endpoint call did not answer with a supported language. */
export type GoogleFreeDetectionCode =
  | "cancelled"
  | "failed"
  | "unknown_language"
  | "unsupported_language";

export type GoogleFreeDetectionOutcome =
  | { ok: true; language: LanguageId }
  | { ok: false; code: GoogleFreeDetectionCode };

/**
 * Maps a Google language code onto a supported concrete ID. A regional code keeps its base
 * language (`zh-CN` -> `zh`, `pt-BR` -> `pt`), and an unsupported language returns `null`.
 */
export function normalizeGoogleLanguageCode(raw: string): LanguageId | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const base = normalized.split(/[-_]/)[0] ?? "";
  const candidate = GOOGLE_CODE_ALIASES[base] ?? base;
  return isLanguageId(candidate) ? candidate : null;
}

function looksLikeLanguageCode(value: string): boolean {
  return /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?$/i.test(value);
}

/**
 * Reads the detected code from a `translate_a/t` payload. One input answers
 * `[[translatedText, code]]`; other shapes put the code beside the segments.
 */
export function readGoogleLanguageCode(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null;
  for (const entry of payload) {
    if (Array.isArray(entry) && typeof entry[1] === "string" && looksLikeLanguageCode(entry[1])) {
      return entry[1];
    }
  }
  for (const entry of payload) {
    if (typeof entry === "string" && looksLikeLanguageCode(entry)) return entry;
  }
  return null;
}

export interface GoogleFreeDetectionOptions {
  /** Transport seam; defaults to the app's logging HTTP wrapper. */
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Sends one bounded sample to the free Google Translate endpoint and maps its answer. */
export async function requestGoogleFreeDetection(
  sample: string,
  options: GoogleFreeDetectionOptions = {},
): Promise<GoogleFreeDetectionOutcome> {
  const runFetch: FetchLike = options.fetchImpl ?? createHttpFetch({ scope: "language-detection" });
  const external = options.signal;
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);

  const requestBody = `q=${encodeURIComponent(sample)}`;

  try {
    let response: GoogleDetectionResponseLike;
    try {
      response = await runFetch(GOOGLE_DETECTION_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: requestBody,
        signal: controller.signal,
      });
    } catch {
      return external?.aborted ? { ok: false, code: "cancelled" } : { ok: false, code: "failed" };
    }

    if (external?.aborted) return { ok: false, code: "cancelled" };
    if (!response.ok || controller.signal.aborted) return { ok: false, code: "failed" };

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return external?.aborted ? { ok: false, code: "cancelled" } : { ok: false, code: "failed" };
    }

    if (external?.aborted) return { ok: false, code: "cancelled" };

    const code = readGoogleLanguageCode(payload);
    if (code === null) return { ok: false, code: "unknown_language" };
    const language = normalizeGoogleLanguageCode(code);
    return language === null ? { ok: false, code: "unsupported_language" } : { ok: true, language };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}
