// ABOUTME: Tagged filesystem/dialog error distinct from IPC IpcError codes.
// ABOUTME: Used by history export and configuration transfer; never reuses IPC code strings.
import { Data } from "effect";

/** Filesystem or native dialog failure — not an IPC wire code. */
export type FsOperation = "dialog" | "read" | "write" | "parse";

/**
 * Local tagged error for dialog/fs/parse failures.
 * Callers must not map these to `conflict` or other IPC codes.
 */
export class FsError extends Data.TaggedError("FsError")<{
  readonly operation: FsOperation;
  readonly message: string;
}> {}

/** Type guard for `FsError` instances. */
export function isFsError(u: unknown): u is FsError {
  return u instanceof FsError;
}

/** Decode an unknown throw into FsError for the given operation. */
export function toFsError(operation: FsOperation, error: unknown, fallback: string): FsError {
  if (isFsError(error)) {
    return error;
  }
  if (error instanceof Error && error.message.trim()) {
    return new FsError({ operation, message: error.message });
  }
  if (typeof error === "string" && error.trim()) {
    return new FsError({ operation, message: error });
  }
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return new FsError({ operation, message: record.message });
    }
  }
  return new FsError({ operation, message: fallback });
}
