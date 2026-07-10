// ABOUTME: Converts unknown Tauri IPC rejections into safe user-facing messages.
// ABOUTME: Preserves sanitized backend messages without exposing form secrets.

/**
 * Extract a displayable error message from an unknown IPC rejection.
 * Accepts Tauri `{ code, message }` shapes, plain strings, and Error objects.
 * Never logs form values or secrets.
 */
export function getIpcErrorMessage(error: unknown, fallback: string): string {
	if (typeof error === "string" && error.trim()) {
		return error;
	}

	if (error instanceof Error && error.message.trim()) {
		return error.message;
	}

	if (error !== null && typeof error === "object") {
		const record = error as Record<string, unknown>;
		if (typeof record.message === "string" && record.message.trim()) {
			return record.message;
		}
	}

	return fallback;
}
