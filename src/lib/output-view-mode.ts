// ABOUTME: Shared plain/markdown preference for translation output panes.
// ABOUTME: localStorage-backed with safe parse; default is plain text.

/** Namespaced key for translation output view mode (main + quick translate). */
export const OUTPUT_VIEW_MODE_KEY = "langnext-output-view-mode";

export type OutputViewMode = "plain" | "markdown";

export const DEFAULT_OUTPUT_VIEW_MODE: OutputViewMode = "plain";

/** True when value is a supported output view mode. */
export function isOutputViewMode(value: unknown): value is OutputViewMode {
  return value === "plain" || value === "markdown";
}

/**
 * Normalize a raw stored value into a full view mode.
 * Invalid values fall back to plain without throwing.
 */
export function normalizeOutputViewMode(raw: unknown): OutputViewMode {
  if (isOutputViewMode(raw)) {
    return raw;
  }
  return DEFAULT_OUTPUT_VIEW_MODE;
}

/** Read view mode from localStorage; invalid JSON or values fall back to plain. */
export function getOutputViewMode(): OutputViewMode {
  if (typeof window === "undefined") {
    return DEFAULT_OUTPUT_VIEW_MODE;
  }

  try {
    const stored = localStorage.getItem(OUTPUT_VIEW_MODE_KEY);
    if (stored == null || stored === "") {
      return DEFAULT_OUTPUT_VIEW_MODE;
    }
    // Accept bare string or JSON-encoded string.
    if (isOutputViewMode(stored)) {
      return stored;
    }
    return normalizeOutputViewMode(JSON.parse(stored) as unknown);
  } catch {
    return DEFAULT_OUTPUT_VIEW_MODE;
  }
}

/** Persist view mode. Swallows storage errors. */
export function setOutputViewMode(mode: OutputViewMode): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    localStorage.setItem(OUTPUT_VIEW_MODE_KEY, normalizeOutputViewMode(mode));
  } catch {
    // Quota or private-mode failures must not break the page.
  }
}

/** Toggle between plain and markdown; returns the next mode. */
export function toggleOutputViewMode(current: OutputViewMode): OutputViewMode {
  return current === "markdown" ? "plain" : "markdown";
}
