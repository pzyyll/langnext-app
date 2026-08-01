// ABOUTME: Generic HTTP/IPC/provider error normalization for frontend workflows.
// ABOUTME: Provider JSON error extraction stays inside each plugin.
import { IpcError, isIpcError } from "../../storage/ipcError";
import type { ModelsSyncErrorCode } from "../../storage/types";
import { ProviderProtocolError } from "./types";

export type ProviderWorkflowErrorCode =
  | ModelsSyncErrorCode
  | "cancelled"
  | "plugin_unavailable"
  | "provider_reconfiguration_required"
  | "validation_failed";

export interface NormalizedProviderError {
  code: ProviderWorkflowErrorCode;
  message: string;
  retryable: boolean;
}

const DEFAULT_DETECT_MAX_TOKENS = 256;

export { DEFAULT_DETECT_MAX_TOKENS };

/** Map raw HTTP status to a bounded workflow code (no body inspection). */
export function mapHttpStatus(status: number): ProviderWorkflowErrorCode {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500 && status <= 599) {
    return "server";
  }
  if (status >= 400) {
    return "invalid_response";
  }
  return "invalid_response";
}

export function isRetryableCode(code: ProviderWorkflowErrorCode): boolean {
  return (
    code === "rate_limited" ||
    code === "network" ||
    code === "timeout" ||
    code === "server" ||
    code === "invalid_response"
  );
}

export function normalizeProviderError(error: unknown): NormalizedProviderError {
  if (error instanceof ProviderProtocolError) {
    return {
      code: "invalid_response",
      message: error.message,
      retryable: true,
    };
  }
  if (isIpcError(error)) {
    return mapIpcError(error);
  }
  if (error instanceof Error) {
    const message = error.message || "Provider request failed";
    if (message.toLowerCase().includes("cancel")) {
      return { code: "cancelled", message, retryable: false };
    }
    if (message.toLowerCase().includes("timeout")) {
      return { code: "timeout", message, retryable: true };
    }
    return { code: "invalid_response", message, retryable: false };
  }
  return {
    code: "invalid_response",
    message: "Provider request failed",
    retryable: false,
  };
}

function mapIpcError(error: IpcError): NormalizedProviderError {
  const code = error.code;
  if (code === "credential_unavailable") {
    return { code: "credential_unavailable", message: error.message, retryable: false };
  }
  if (code === "validation_failed") {
    const lower = error.message.toLowerCase();
    if (lower.includes("cancel")) {
      return { code: "cancelled", message: error.message, retryable: false };
    }
    if (lower.includes("timeout")) {
      return { code: "timeout", message: error.message, retryable: true };
    }
    if (lower.includes("network")) {
      return { code: "network", message: error.message, retryable: true };
    }
    return { code: "validation_failed", message: error.message, retryable: false };
  }
  if (code === "not_found") {
    return { code: "validation_failed", message: error.message, retryable: false };
  }
  return {
    code: "invalid_response",
    message: error.message || "Provider request failed",
    retryable: false,
  };
}
