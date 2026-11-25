import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../contracts/errors";
import type { ImageInput, RequestOperation } from "../contracts/protocol";

/** Trims a resolved connection root and any trailing slashes it still carries. */
export function normalizeRequestRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** Returns the trimmed model ID of a model operation, rejecting a blank one. */
export function requireModelId(operation: RequestOperation): string {
  const modelId = operation.kind === "model" ? operation.modelId.trim() : "";
  if (!modelId) {
    throw new ProviderProtocolError("invalid_request", t("models.error.modelIdRequired"));
  }
  return modelId;
}

/** Trims a transient credential, treating a blank value as absent. */
export function normalizeCredential(credential: string | null | undefined): string | null {
  const token = credential?.trim();
  return token ? token : null;
}

/** Type guard for non-array JSON objects. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses one server-sent event payload. Returns null for `[DONE]` and for payloads that are
 * not JSON objects, so protocol keepalives do not become errors.
 */
export function parseEventPayload(data: string): Record<string, unknown> | null {
  if (data === "[DONE]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

/** Joins extracted text parts and rejects missing or whitespace-only output. */
export function requireGeneratedText(parts: readonly string[]): string {
  const combined = parts.join("");
  if (combined.trim().length === 0) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeneratedText"));
  }
  return combined;
}

/** Builds the `data:` URL a provider accepts for one buffered image part. */
export function imageDataUrl(image: ImageInput): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

/**
 * Rejects an answer the provider stopped early, so a caller never imports partial text as a
 * complete transcription.
 */
export function requireCompleteOutput(truncated: boolean): void {
  if (truncated) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.outputTruncated"));
  }
}
