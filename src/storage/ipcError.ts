// ABOUTME: Tagged IpcError model and decoder for Tauri invoke rejections.
// ABOUTME: Maps unknown wire failures into a stable Effect error channel.
import { Data } from "effect";

/** Known IPC codes from the Rust storage layer; wire may send additional non-empty codes. */
export type IpcErrorCode =
  | "validation_failed"
  | "not_found"
  | "conflict"
  | "in_use"
  | "credential_busy"
  | "credential_unavailable"
  | "storage_unavailable"
  | "storage_version_unsupported"
  | "internal_error"
  | "shortcut_apply_failed"
  | "unknown";

/**
 * Stable IPC failure used on the Effect error channel and Promise rejections.
 * `code` is open: non-empty wire codes outside the known list are preserved as-is.
 */
export class IpcError extends Data.TaggedError("IpcError")<{
  readonly code: IpcErrorCode | (string & {});
  readonly message: string;
}> {}

/** Type guard for decoded or rethrown `IpcError` instances. */
export function isIpcError(u: unknown): u is IpcError {
  return u instanceof IpcError;
}

/** True when the IPC failure is an optimistic-concurrency conflict. */
export function ipcErrorIsConflict(err: IpcError): boolean {
  return err.code === "conflict";
}

/**
 * Decode an unknown Tauri/invoke rejection into a stable `IpcError`.
 * Does not invent new wire codes; unstructured input becomes `code: "unknown"`.
 */
export function decodeIpcRejection(error: unknown): IpcError {
  if (isIpcError(error)) {
    return error;
  }

  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string" && record.code.trim()) {
      const message = typeof record.message === "string" ? record.message : "";
      return new IpcError({ code: record.code, message });
    }
    // Preserve displayable messages when the wire shape omitted a usable code.
    if (typeof record.message === "string" && record.message.trim()) {
      return new IpcError({ code: "unknown", message: record.message });
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return new IpcError({ code: "unknown", message: error.message });
  }

  if (typeof error === "string" && error.trim()) {
    return new IpcError({ code: "unknown", message: error });
  }

  return new IpcError({ code: "unknown", message: "" });
}
