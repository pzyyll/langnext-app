// ABOUTME: Unified user-facing message helper for FsError and IPC rejections.
// ABOUTME: Routes use this instead of branching isFsError vs getIpcErrorMessage inline.
import { getIpcErrorMessage } from "../storage/errors";
import { isFsError } from "./fsError";

/**
 * Extract a displayable error message from FsError, IpcError, or unknown rejections.
 * Prefers trimmed FsError.message when present; otherwise uses the IPC decode path.
 */
export function getUserErrorMessage(error: unknown, fallback: string): string {
  if (isFsError(error)) {
    const message = error.message.trim();
    return message ? message : fallback;
  }
  return getIpcErrorMessage(error, fallback);
}
