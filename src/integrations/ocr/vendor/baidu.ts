import { createHttpFetch, type FetchLike, type HttpResponseLike } from "../../../services/http";

/** Baidu OCR recognition modes. `accurate` is the default. */
export const BAIDU_OCR_OPERATIONS = [
  "general_basic",
  "accurate_basic",
  "general",
  "accurate",
] as const;

export type BaiduOcrOperation = (typeof BAIDU_OCR_OPERATIONS)[number];

/** API Key and Secret Key pair used for one client-credentials exchange. */
export interface BaiduCredentialPair {
  apiKey: string;
  secretKey: string;
}

const BAIDU_ORIGIN = "https://aip.baidubce.com";
const TOKEN_URL = BAIDU_ORIGIN + "/oauth/2.0/token";
const TOKEN_BODY_LIMIT = 8 * 1024;
const OCR_BODY_LIMIT = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const RAW_PNG_LIMIT = 3 * 1024 * 1024;
const MIN_SIDE = 15;
const MAX_SIDE = 4096;
const ENCODED_IMAGE_LIMIT = 4_000_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const OPERATION_REQUEST: Record<BaiduOcrOperation, { path: string; languageType: string }> = {
  general_basic: { path: "general_basic", languageType: "CHN_ENG" },
  accurate_basic: { path: "accurate_basic", languageType: "auto_detect" },
  general: { path: "general", languageType: "CHN_ENG" },
  accurate: { path: "accurate", languageType: "auto_detect" },
};

export type BaiduOcrFailureReason =
  | "invalid_image"
  | "image_too_small"
  | "image_too_large"
  | "credentials"
  | "rate_limited"
  | "quota"
  | "service"
  | "malformed"
  | "timeout";

export type BaiduOcrRecognition =
  | { status: "recognized"; text: string }
  | { status: "no_text" }
  | { status: "cancelled" }
  | { status: "failed"; failure: BaiduOcrFailureReason };

export interface BaiduOcrRecognizeInput {
  operation: BaiduOcrOperation;
  credentials: BaiduCredentialPair;
  png: Uint8Array;
}

export interface BaiduOcrRecognizeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BaiduOcrClient {
  recognize(
    input: BaiduOcrRecognizeInput,
    options?: BaiduOcrRecognizeOptions,
  ): Promise<BaiduOcrRecognition>;
}

function failed(failure: BaiduOcrFailureReason): BaiduOcrRecognition {
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

/** Reads a response body up to `maxBytes` before any JSON parse. */
async function readLimitedText(
  response: HttpResponseLike,
  maxBytes: number,
  abortPromise: Promise<never>,
  signal: AbortSignal,
): Promise<string | "too_large" | "aborted"> {
  if (signal.aborted) return "aborted";
  const reader = response.body?.getReader();
  if (!reader) {
    try {
      const textPromise = response.text
        ? response.text()
        : response.json().then((value) => JSON.stringify(value));
      textPromise.catch(() => {});
      const text = await Promise.race([textPromise, abortPromise]);
      return new TextEncoder().encode(text).byteLength > maxBytes ? "too_large" : text;
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
  return new TextDecoder().decode(concatBytes(chunks, total));
}

type JsonBody =
  | { ok: true; value: unknown }
  | { ok: false; failure: BaiduOcrFailureReason }
  | { ok: false; aborted: true };

async function readJson(
  response: HttpResponseLike,
  maxBytes: number,
  abortPromise: Promise<never>,
  signal: AbortSignal,
): Promise<JsonBody> {
  let text: string | "too_large" | "aborted";
  try {
    text = await readLimitedText(response, maxBytes, abortPromise, signal);
  } catch {
    return signal.aborted ? { ok: false, aborted: true } : { ok: false, failure: "service" };
  }
  if (text === "aborted") return { ok: false, aborted: true };
  if (text === "too_large") return { ok: false, failure: "malformed" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, failure: "malformed" };
  }
}

function parseWords(payload: unknown): BaiduOcrRecognition {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return failed("malformed");
  const record = payload as Record<string, unknown>;
  const rows = record.words_result;
  if (!Array.isArray(rows)) return failed("malformed");
  if (record.words_result_num !== undefined && record.words_result_num !== rows.length) {
    return failed("malformed");
  }

  const lines: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return failed("malformed");
    const words = (row as Record<string, unknown>).words;
    if (typeof words !== "string") return failed("malformed");
    const trimmed = words.trim();
    if (trimmed.length > 0) lines.push(trimmed);
  }
  if (lines.length === 0) return { status: "no_text" };
  return { status: "recognized", text: lines.join("\n") };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = (crc & 1) === 1 ? 0xedb88320 : 0;
      crc = (crc >>> 1) ^ mask;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 33) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  if (crc32(bytes.subarray(12, 29)) !== view.getUint32(29)) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function acceptedImage(
  png: Uint8Array,
): { ok: true; image: string } | { ok: false; failure: BaiduOcrFailureReason } {
  const size = pngSize(png);
  if (size === null) return { ok: false, failure: "invalid_image" };
  if (png.byteLength > RAW_PNG_LIMIT) return { ok: false, failure: "image_too_large" };
  if (size.width < MIN_SIDE || size.height < MIN_SIDE)
    return { ok: false, failure: "image_too_small" };
  if (size.width > MAX_SIDE || size.height > MAX_SIDE)
    return { ok: false, failure: "image_too_large" };
  const image = Buffer.from(png).toString("base64");
  const encoded = new URLSearchParams({ image }).toString().length - "image=".length;
  if (encoded > ENCODED_IMAGE_LIMIT) return { ok: false, failure: "image_too_large" };
  return { ok: true, image };
}

function readAccessToken(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const token = (payload as Record<string, unknown>).access_token;
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readErrorCode(payload: unknown): number | "invalid" | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!("error_code" in payload)) return null;
  const code = (payload as Record<string, unknown>).error_code;
  if (typeof code !== "number" || !Number.isFinite(code)) return "invalid";
  return code;
}

function classifyErrorCode(code: number): BaiduOcrFailureReason | null {
  if (code === 0) return null;
  if (code === 6 || code === 110 || code === 111) return "credentials";
  if (code === 4 || code === 18) return "rate_limited";
  if (code === 17 || code === 19) return "quota";
  if (code === 216202) return "image_too_large";
  return "service";
}

function classifyStatus(status: number): BaiduOcrFailureReason | null {
  if (status === 401 || status === 403) return "credentials";
  if (status === 429) return "rate_limited";
  if (status === 413) return "image_too_large";
  return null;
}

function isOAuthError(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const error = (payload as Record<string, unknown>).error;
  return typeof error === "string" && error.trim().length > 0;
}

type Interpreted =
  | { kind: "token"; token: string }
  | { kind: "words"; result: BaiduOcrRecognition }
  | { kind: "failure"; failure: BaiduOcrFailureReason }
  | { kind: "aborted" };

async function interpretResponse(
  response: HttpResponseLike,
  maxBytes: number,
  phase: "token" | "ocr",
  abortPromise: Promise<never>,
  signal: AbortSignal,
): Promise<Interpreted> {
  const body = await readJson(response, maxBytes, abortPromise, signal);
  if ("aborted" in body && body.aborted) return { kind: "aborted" };
  const statusFailure = classifyStatus(response.status);
  if (!body.ok) {
    if (!("failure" in body)) return { kind: "aborted" };
    if (statusFailure) return { kind: "failure", failure: statusFailure };
    if (phase === "token" && response.status === 400)
      return { kind: "failure", failure: "credentials" };
    if (response.status < 200 || response.status >= 300)
      return { kind: "failure", failure: "service" };
    return { kind: "failure", failure: body.failure };
  }

  const code = readErrorCode(body.value);
  if (code === "invalid") return { kind: "failure", failure: "malformed" };
  if (typeof code === "number") {
    const mapped = classifyErrorCode(code);
    if (mapped) return { kind: "failure", failure: mapped };
  }
  if (statusFailure) return { kind: "failure", failure: statusFailure };
  if (response.status < 200 || response.status >= 300) {
    return { kind: "failure", failure: phase === "token" ? "credentials" : "service" };
  }
  if (phase === "token") {
    if (isOAuthError(body.value)) return { kind: "failure", failure: "credentials" };
    const token = readAccessToken(body.value);
    if (token === null) return { kind: "failure", failure: "malformed" };
    return { kind: "token", token };
  }
  return { kind: "words", result: parseWords(body.value) };
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  body: string,
  signal: AbortSignal,
  abortPromise: Promise<never>,
): Promise<HttpResponseLike | "aborted" | "network"> {
  if (signal.aborted) return "aborted";
  try {
    const pending = fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal,
    });
    pending.catch(() => {});
    return await Promise.race([pending, abortPromise]);
  } catch {
    return signal.aborted ? "aborted" : "network";
  }
}

/** Creates a Baidu OCR client. `fetchImpl` is the only I/O boundary. */
export function createBaiduOcrClient(options: { fetchImpl?: FetchLike } = {}): BaiduOcrClient {
  // The token exchange sends the API Key and Secret Key and answers with an access token;
  // its bodies stay out of the log while recognition keeps the transport's body lines.
  const tokenFetch = createHttpFetch({
    fetchImpl: options.fetchImpl,
    scope: "ocr/baidu",
    logBodies: false,
  });
  const recognitionFetch = createHttpFetch({ fetchImpl: options.fetchImpl, scope: "ocr/baidu" });

  return {
    recognize: async (input, callOptions) => {
      if (callOptions?.signal?.aborted) return { status: "cancelled" };
      const accepted = acceptedImage(input.png);
      if (!accepted.ok) return failed(accepted.failure);

      const controller = new AbortController();
      const external = callOptions?.signal;
      let timedOut = false;
      const onExternalAbort = () => controller.abort();
      external?.addEventListener("abort", onExternalAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, callOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const abort = trackAbort(controller.signal);
      const abortedResult = (): BaiduOcrRecognition =>
        timedOut ? failed("timeout") : { status: "cancelled" };

      try {
        const spec = OPERATION_REQUEST[input.operation];
        const tokenBody = new URLSearchParams({
          grant_type: "client_credentials",
          client_id: input.credentials.apiKey,
          client_secret: input.credentials.secretKey,
        }).toString();
        const tokenResponse = await postForm(
          tokenFetch,
          TOKEN_URL,
          tokenBody,
          controller.signal,
          abort.promise,
        );
        if (tokenResponse === "aborted") return abortedResult();
        if (tokenResponse === "network") return failed("service");

        const token = await interpretResponse(
          tokenResponse,
          TOKEN_BODY_LIMIT,
          "token",
          abort.promise,
          controller.signal,
        );
        if (token.kind === "aborted") return abortedResult();
        if (token.kind === "failure") return failed(token.failure);
        if (token.kind !== "token") return failed("malformed");

        const ocrBody = new URLSearchParams({
          image: accepted.image,
          language_type: spec.languageType,
        }).toString();
        const ocrUrl =
          BAIDU_ORIGIN +
          "/rest/2.0/ocr/v1/" +
          spec.path +
          "?access_token=" +
          encodeURIComponent(token.token);
        const ocrResponse = await postForm(
          recognitionFetch,
          ocrUrl,
          ocrBody,
          controller.signal,
          abort.promise,
        );
        if (ocrResponse === "aborted") return abortedResult();
        if (ocrResponse === "network") return failed("service");

        const recognized = await interpretResponse(
          ocrResponse,
          OCR_BODY_LIMIT,
          "ocr",
          abort.promise,
          controller.signal,
        );
        if (recognized.kind === "aborted") return abortedResult();
        if (recognized.kind === "failure") return failed(recognized.failure);
        if (recognized.kind !== "words") return failed("malformed");
        return recognized.result;
      } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
        abort.stop();
      }
    },
  };
}
