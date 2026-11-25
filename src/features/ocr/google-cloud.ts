import { ProviderProtocolError } from "../../modules/ai/contracts/errors";
import { createJsonHttpClient } from "../../modules/ai/runtime/http";
import type { FetchLike } from "../../services/http";

const ANNOTATE_URL = "https://vision.googleapis.com/v1/images:annotate";
const DEFAULT_TIMEOUT_MS = 30_000;

const SETUP_REASONS = new Set([
  "API_KEY_INVALID",
  "API_KEY_SERVICE_BLOCKED",
  "SERVICE_DISABLED",
  "BILLING_DISABLED",
]);

const QUOTA_REASONS = new Set(["RATE_LIMIT_EXCEEDED", "RESOURCE_QUOTA_EXCEEDED"]);

export type GoogleCloudOcrFailureReason =
  | "image_too_large"
  | "setup"
  | "quota"
  | "malformed"
  | "service"
  | "timeout";

export type GoogleCloudOcrRecognition =
  | { status: "recognized"; text: string }
  | { status: "no_text" }
  | { status: "cancelled" }
  | { status: "failed"; failure: GoogleCloudOcrFailureReason };

export interface GoogleCloudOcrRecognizeInput {
  apiKey: string;
  imageBase64: string;
}

export interface GoogleCloudOcrRecognizeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GoogleCloudOcrClient {
  recognize(
    input: GoogleCloudOcrRecognizeInput,
    options?: GoogleCloudOcrRecognizeOptions,
  ): Promise<GoogleCloudOcrRecognition>;
}

function failed(failure: GoogleCloudOcrFailureReason): GoogleCloudOcrRecognition {
  return { status: "failed", failure };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reasonClass(value: unknown): "quota" | "setup" | null {
  if (!isPlainObject(value) || !Array.isArray(value.details)) return null;
  let setup = false;
  for (const item of value.details) {
    if (!isPlainObject(item) || item.domain !== "googleapis.com") continue;
    if (typeof item.reason !== "string") continue;
    if (QUOTA_REASONS.has(item.reason)) return "quota";
    if (SETUP_REASONS.has(item.reason)) setup = true;
  }
  return setup ? "setup" : null;
}

function rpcCode(value: unknown): number | "invalid" | null {
  if (!isPlainObject(value) || !("code" in value)) return null;
  const code = value.code;
  if (typeof code !== "number" || !Number.isInteger(code)) return "invalid";
  return code;
}

function classifyStatusBody(
  httpStatus: number | null,
  statusBody: unknown,
): GoogleCloudOcrFailureReason {
  const reason = reasonClass(statusBody);
  if (reason !== null) return reason;
  const code = rpcCode(statusBody);
  const statusName = isPlainObject(statusBody) ? statusBody.status : undefined;
  if (code === 8 || httpStatus === 429 || statusName === "RESOURCE_EXHAUSTED") return "quota";
  if (code === 7 || code === 16 || httpStatus === 401 || httpStatus === 403) return "setup";
  if (httpStatus === 413) return "image_too_large";
  return "service";
}

function classifyHttpError(status: number, body: unknown): GoogleCloudOcrFailureReason {
  const statusBody = isPlainObject(body) && isPlainObject(body.error) ? body.error : body;
  return classifyStatusBody(status, statusBody);
}

function protocolKind(failure: GoogleCloudOcrFailureReason): ProviderProtocolError["kind"] {
  if (failure === "setup") return "auth";
  if (failure === "quota") return "rate_limited";
  if (failure === "image_too_large") return "invalid_request";
  if (failure === "malformed") return "invalid_response";
  return "server";
}

function classifyErrorResponse(status: number, body: unknown): ProviderProtocolError {
  const failure = classifyHttpError(status, body);
  return new ProviderProtocolError(protocolKind(failure), "Cloud Vision request failed", status);
}

function fromTransport(error: unknown): GoogleCloudOcrRecognition {
  if (!(error instanceof ProviderProtocolError)) return failed("service");
  if (error.kind === "cancelled") return { status: "cancelled" };
  if (error.kind === "timeout") return failed("timeout");
  if (error.kind === "invalid_response") return failed("malformed");
  if (error.kind === "auth") return failed("setup");
  if (error.kind === "rate_limited") return failed("quota");
  if (error.kind === "invalid_request" && error.status === 413) return failed("image_too_large");
  return failed("service");
}

function interpretSuccess(body: Record<string, unknown>): GoogleCloudOcrRecognition {
  const responses = body.responses;
  if (!Array.isArray(responses) || responses.length !== 1 || !isPlainObject(responses[0])) {
    return failed("malformed");
  }
  const response = responses[0];
  if ("error" in response && response.error !== undefined) {
    const code = rpcCode(response.error);
    if (code === null || code === "invalid") return failed("malformed");
    if (code !== 0) return failed(classifyStatusBody(null, response.error));
  }
  if (!("fullTextAnnotation" in response) || response.fullTextAnnotation === undefined) {
    return { status: "no_text" };
  }
  const annotation = response.fullTextAnnotation;
  if (!isPlainObject(annotation) || typeof annotation.text !== "string") return failed("malformed");
  if (annotation.text.trim().length === 0) return { status: "no_text" };
  return { status: "recognized", text: annotation.text };
}

/** Creates a Cloud Vision OCR client. `fetchImpl` is the only I/O boundary. */
export function createGoogleCloudOcrClient(
  options: { fetchImpl?: FetchLike } = {},
): GoogleCloudOcrClient {
  const http = createJsonHttpClient({
    fetchImpl: options.fetchImpl,
    logScope: "ocr/google-cloud",
    classifyErrorResponse,
  });

  return {
    recognize: async (input, callOptions) => {
      if (callOptions?.signal?.aborted) return { status: "cancelled" };
      if (input.apiKey.trim().length === 0) return failed("setup");

      const body: Record<string, unknown> = {
        requests: [
          {
            image: { content: input.imageBase64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      };

      try {
        const payload = await http.postJson(
          {
            method: "POST",
            url: ANNOTATE_URL,
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": input.apiKey,
            },
          },
          body,
          {
            signal: callOptions?.signal,
            timeoutMs: callOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            redirect: "error",
          },
        );
        return interpretSuccess(payload);
      } catch (error) {
        return fromTransport(error);
      }
    },
  };
}
