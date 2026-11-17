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
