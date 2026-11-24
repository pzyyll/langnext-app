import type { FetchLike, HttpResponseLike } from "../../modules/ai/runtime/http";
import { createHttpLog } from "../../services/http-log";
import { parseAzureSpeechRegion } from "./azure-regions";
import type { TtsFailure, TtsSynthesis, TtsVoice } from "./synthesis";

/** App limit on plain text before SSML escaping. This is not an Azure REST quota. */
export const AZURE_TTS_MAX_UTF8_BYTES = 5_000;

/** MP3 body cap. Ten minutes at 48 kbit/s is about 3.6 MB before container overhead. */
export const AZURE_TTS_RESPONSE_BYTE_LIMIT = 4 * 1024 * 1024;

/** Deadline for the request and the body read. */
export const AZURE_TTS_DEFAULT_TIMEOUT_MS = 15_000;

const httpLog = createHttpLog("tts/azure");

export interface AzureSpeechTtsSynthesizeInput {
  apiKey: string;
  region: string;
  text: string;
  voice: TtsVoice;
}

export interface AzureSpeechTtsSynthesizeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AzureSpeechTtsClient {
  synthesize(
    input: AzureSpeechTtsSynthesizeInput,
    options?: AzureSpeechTtsSynthesizeOptions,
  ): Promise<TtsSynthesis>;
}

function failed(failure: TtsFailure): TtsSynthesis {
  return { status: "failed", failure };
}

/** True when `text` contains a character XML 1.0 cannot represent. */
export function azureTextHasIllegalXml(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined || !isXmlChar(code)) return true;
  }
  return false;
}

function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** Escapes one XML text or attribute value. Carriage returns become character references. */
function escapeXml(value: string): string | null {
  let escaped = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined || !isXmlChar(code)) return null;
    if (char === "&") escaped += "&amp;";
    else if (char === "<") escaped += "&lt;";
    else if (char === ">") escaped += "&gt;";
    else if (char === '"') escaped += "&quot;";
    else if (char === "'") escaped += "&apos;";
    else if (code === 0xd) escaped += "&#xD;";
    else escaped += char;
  }
  return escaped;
}

function ssmlDocument(voice: TtsVoice, text: string): string | null {
  const languageCode = escapeXml(voice.languageCode);
  const voiceName = escapeXml(voice.voiceName);
  const body = escapeXml(text);
  if (languageCode === null || voiceName === null || body === null) return null;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${languageCode}">` +
    `<voice name="${voiceName}">${body}</voice></speak>`
  );
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

function discardBody(body: ReadableStream<Uint8Array> | null | undefined): void {
  if (!body) return;
  try {
    void Promise.resolve(body.cancel()).catch(() => {});
  } catch {
    // The caller already has its result. Cleanup must not change it or block it.
  }
}

type AudioRead = Uint8Array | "too_large" | "empty" | "aborted";

async function readAudioBytes(
  response: HttpResponseLike,
  maxBytes: number,
  abortPromise: Promise<never>,
  signal: AbortSignal,
): Promise<AudioRead> {
  if (signal.aborted) {
    discardBody(response.body);
    return "aborted";
  }
  const declared = headerValue(response, "content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      discardBody(response.body);
      return "too_large";
    }
  }

  const stream = response.body;
  if (!stream) return "empty";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stopReader = () => {
    try {
      void Promise.resolve(reader.cancel()).catch(() => {});
    } catch {
      // Same as discardBody: do not wait for a stalled cancel.
    }
  };
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
    stopReader();
  }
  return total === 0 ? "empty" : concatBytes(chunks, total);
}

function failureForStatus(status: number): TtsFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  return "rejected";
}

/** Creates an Azure Speech TTS client. `fetchImpl` is the only I/O boundary. */
export function createAzureSpeechTtsClient(
  options: { fetchImpl?: FetchLike } = {},
): AzureSpeechTtsClient {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));

  return {
    synthesize: async (input, callOptions) => {
      if (callOptions?.signal?.aborted) return { status: "cancelled" };
      const region = parseAzureSpeechRegion(input.region);
      if (region === null) return failed("invalid_region");
      const document = ssmlDocument(input.voice, input.text);
      if (document === null) return failed("invalid_text");
      if (input.text.trim().length === 0) return failed("text_blank");
      if (new TextEncoder().encode(input.text).byteLength > AZURE_TTS_MAX_UTF8_BYTES) {
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
      }, callOptions?.timeoutMs ?? AZURE_TTS_DEFAULT_TIMEOUT_MS);
      const abort = trackAbort(controller.signal);
      const stopped = (): TtsSynthesis => (timedOut ? failed("timeout") : { status: "cancelled" });

      const synthesizeUrl = "https://" + region + ".tts.speech.microsoft.com/cognitiveservices/v1";

      try {
        let response: HttpResponseLike;
        httpLog.request("POST", synthesizeUrl, document);
        try {
          const pending = fetchImpl(synthesizeUrl, {
            method: "POST",
            headers: {
              "Ocp-Apim-Subscription-Key": input.apiKey,
              "Content-Type": "application/ssml+xml",
              "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
              "User-Agent": "Langnext",
            },
            body: document,
            redirect: "error",
            signal: controller.signal,
          });
          pending.catch(() => {});
          response = await Promise.race([pending, abort.promise]);
        } catch (error) {
          if (controller.signal.aborted) return stopped();
          httpLog.failure("POST", synthesizeUrl, error);
          return failed("network");
        }
        if (controller.signal.aborted) return stopped();
        if (response.status !== 200) {
          discardBody(response.body);
          httpLog.response("POST", synthesizeUrl, response.status);
          return failed(failureForStatus(response.status));
        }

        const audio = await readAudioBytes(
          response,
          AZURE_TTS_RESPONSE_BYTE_LIMIT,
          abort.promise,
          controller.signal,
        );
        if (audio === "aborted") return stopped();
        if (audio === "too_large" || audio === "empty") {
          httpLog.response("POST", synthesizeUrl, response.status, { unreadable: audio });
          return failed("malformed");
        }
        httpLog.response("POST", synthesizeUrl, response.status, { audioBytes: audio.byteLength });
        return { status: "synthesized", audio };
      } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
        abort.stop();
      }
    },
  };
}
