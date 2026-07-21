// ABOUTME: Converts unknown Tauri IPC rejections into safe user-facing messages.
// ABOUTME: Routes helpers through decodeIpcRejection while preserving public signatures.
import { decodeIpcRejection, ipcErrorIsConflict, isIpcError } from "./ipcError";

/**
 * Extract a displayable error message from an unknown IPC rejection.
 * Accepts Tauri `{ code, message }` shapes, plain strings, Error objects, and `IpcError`.
 * Never logs form values or secrets.
 */
export function getIpcErrorMessage(error: unknown, fallback: string): string {
  const message = decodeIpcRejection(error).message;
  return message.trim() ? message : fallback;
}

/**
 * Extract a stable IPC error code when present (`conflict`, `validation_failed`, …).
 * Returns null when the rejection does not carry a code field.
 */
export function getIpcErrorCode(error: unknown): string | null {
  if (isIpcError(error)) {
    return error.code;
  }

  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string" && record.code.trim()) {
      return decodeIpcRejection(error).code;
    }
  }

  return null;
}

/** True when the rejection is an optimistic-concurrency conflict. */
export function isConflictError(error: unknown): boolean {
  return ipcErrorIsConflict(decodeIpcRejection(error));
}
