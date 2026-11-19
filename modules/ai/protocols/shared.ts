import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../contracts/errors";
import type { RequestOperation } from "../contracts/protocol";

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

/** Joins extracted text parts and rejects missing or whitespace-only output. */
export function requireGeneratedText(parts: readonly string[]): string {
  const combined = parts.join("");
  if (combined.trim().length === 0) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeneratedText"));
  }
  return combined;
}
