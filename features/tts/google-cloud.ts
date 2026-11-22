import { atob } from "buffer";
import type { FetchLike, HttpResponseLike } from "../../modules/ai/runtime/http";
import type { GoogleAudioOptions } from "./google-preferences";
import type { GoogleTtsFailure, TtsResult } from "./synthesis";

/** Cloud Text-to-Speech REST v1 synthesize endpoint. The key travels only in a header. */
export const GOOGLE_CLOUD_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";

/** Fixed English sample the settings preview sends. */
export const TTS_SAMPLE_TEXT = "This is a voice sample.";

/** Language code for {@link TTS_SAMPLE_TEXT}. */
export const TTS_SAMPLE_LANGUAGE_CODE = "en-US";

/** Documented Standard voice for {@link TTS_SAMPLE_TEXT}. */
export const TTS_SAMPLE_VOICE_NAME = "en-US-Standard-C";

/** Cloud TTS rejects input above this many UTF-8 bytes. The client does not truncate. */
export const TTS_MAX_UTF8_BYTES = 5_000;

/** JSON body cap, applied before parse even when Content-Length is absent. */
export const TTS_RESPONSE_BYTE_LIMIT = 8 * 1024 * 1024;

/** Deadline for the request and the body read. */
export const TTS_DEFAULT_TIMEOUT_MS = 15_000;

export type GoogleCloudTtsFailure = GoogleTtsFailure;

export type GoogleCloudTtsSynthesis = TtsResult<GoogleCloudTtsFailure>;

export interface GoogleCloudTtsSynthesizeInput {
  apiKey: string;
  text: string;
  languageCode: string;
  voiceName: string;
  /** Effective audio fields only; absent fields are omitted from the body. */
  audio?: GoogleAudioOptions;
}

export interface GoogleCloudTtsSynthesizeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GoogleCloudTtsClient {
  synthesize(
    input: GoogleCloudTtsSynthesizeInput,
    options?: GoogleCloudTtsSynthesizeOptions,
  ): Promise<GoogleCloudTtsSynthesis>;
}

function failed(failure: GoogleCloudTtsFailure): GoogleCloudTtsSynthesis {
  return { status: "failed", failure };
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

interface AbortWait {
  promise: Promise<never>;
  stop: () => void;
}

function trackAbort(signal: AbortSignal): AbortWait {
  let rejectAbort: (error: Error) => void = () => {};
  let stopped = false;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  promise.catch(() => {});
  const onAbort = () => {
    if (!stopped) rejectAbort(new Error("aborted"));
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    stop: () => {
      stopped = true;
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function headerValue(response: HttpResponseLike, name: string): string | null {
  const headers = response.headers;
  if (!headers) return null;
  return headers.get(name) ?? headers.get(name.toLowerCase());
}

/** Reads a response body up to `maxBytes` before any JSON parse. */
async function readLimitedBytes(
  response: HttpResponseLike,
  maxBytes: number,
  abortPromise: Promise<never>,
  signal: AbortSignal,
): Promise<Uint8Array | "too_large" | "aborted"> {
  if (signal.aborted) return "aborted";
  const declared = headerValue(response, "content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return "too_large";
  }

  const reader = response.body?.getReader();
  if (!reader) {
    try {
      const textPromise = response.text
        ? response.text()
        : response.json().then((value) => JSON.stringify(value));
      textPromise.catch(() => {});
      const text = await Promise.race([textPromise, abortPromise]);
      const bytes = new TextEncoder().encode(text);
      return bytes.byteLength > maxBytes ? "too_large" : bytes;
    } catch {
      return signal.aborted ? "aborted" : "too_large";
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) return "aborted";
      const readPromise = reader.read();
      readPromise.catch(() => {});
      const next = await Promise.race([readPromise, abortPromise]);
      if (next.done) break;
      const value = next.value;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) return "too_large";
      chunks.push(value);
    }
  } catch {
    return "aborted";
  } finally {
    await reader.cancel().catch(() => {});
  }
  return concatBytes(chunks, total);
}

function decodeAudioContent(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  if (binary.length === 0) return null;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasReason(value: unknown, reason: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasReason(item, reason));
  const record = value as Record<string, unknown>;
  if (record.reason === reason) return true;
  for (const nested of Object.values(record)) {
    if (hasReason(nested, reason)) return true;
  }
  return false;
}

function failureForStatus(status: number, body: unknown): GoogleCloudTtsFailure {
  if (hasReason(body, "API_KEY_INVALID") || status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  return "rejected";
}

/** Creates a Cloud TTS client. `fetchImpl` is the only I/O boundary. */
export function createGoogleCloudTtsClient(
  options: { fetchImpl?: FetchLike } = {},
): GoogleCloudTtsClient {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));

  return {
    synthesize: async (input, callOptions) => {
      if (callOptions?.signal?.aborted) return { status: "cancelled" };
      if (input.text.trim().length === 0) return failed("text_blank");
      if (new TextEncoder().encode(input.text).byteLength > TTS_MAX_UTF8_BYTES) {
        return failed("text_too_long");
      }

      const controller = new AbortController();
      const external = callOptions?.signal;
      let timedOut = false;
      const onExternalAbort = () => controller.abort();
      external?.addEventListener("abort", onExternalAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, callOptions?.timeoutMs ?? TTS_DEFAULT_TIMEOUT_MS);
      const abort = trackAbort(controller.signal);
      const stopped = (): GoogleCloudTtsSynthesis =>
        timedOut ? failed("timeout") : { status: "cancelled" };

      const audioConfig: Record<string, unknown> = { audioEncoding: "MP3" };
      if (input.audio?.speakingRate !== undefined) {
        audioConfig.speakingRate = input.audio.speakingRate;
      }
      if (input.audio?.pitch !== undefined) audioConfig.pitch = input.audio.pitch;

      try {
        let response: HttpResponseLike;
        try {
          const pending = fetchImpl(GOOGLE_CLOUD_TTS_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": input.apiKey,
            },
            body: JSON.stringify({
              input: { text: input.text },
              voice: { languageCode: input.languageCode, name: input.voiceName },
              audioConfig,
            }),
            redirect: "error",
            signal: controller.signal,
          });
          pending.catch(() => {});
          response = await Promise.race([pending, abort.promise]);
        } catch {
          return controller.signal.aborted ? stopped() : failed("network");
        }
        if (controller.signal.aborted) return stopped();

        const bytes = await readLimitedBytes(
          response,
          TTS_RESPONSE_BYTE_LIMIT,
          abort.promise,
          controller.signal,
        );
        if (bytes === "aborted") return stopped();
        if (bytes === "too_large") {
          return failed(response.ok ? "malformed" : failureForStatus(response.status, null));
        }

        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return response.ok
            ? failed("malformed")
            : failed(failureForStatus(response.status, null));
        }
        if (!response.ok) return failed(failureForStatus(response.status, payload));
        if (!isPlainObject(payload)) return failed("malformed");
        const audio = decodeAudioContent(payload.audioContent);
        if (audio === null) return failed("malformed");
        return { status: "synthesized", audio };
      } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
        abort.stop();
      }
    },
  };
}
