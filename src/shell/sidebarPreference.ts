// ABOUTME: Main-window sidebar expanded/collapsed preference helpers.
// ABOUTME: localStorage-backed with safe parse; default is expanded.

/** Namespaced key for main-window sidebar open state. */
export const SIDEBAR_OPEN_KEY = "langnext-sidebar-open";

/** Default: expanded rail with labels. */
export const DEFAULT_SIDEBAR_OPEN = true;

/** True when value is an explicit boolean open flag. */
export function isSidebarOpenValue(value: unknown): value is boolean {
  return value === true || value === false;
}

/**
 * Normalize a raw stored value into open/closed.
 * Accepts bare `"true"` / `"false"`, JSON booleans, or unknown → default expanded.
 */
export function normalizeSidebarOpen(raw: unknown): boolean {
  if (isSidebarOpenValue(raw)) {
    return raw;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return DEFAULT_SIDEBAR_OPEN;
}

/** Read sidebar open preference; invalid JSON or values fall back to expanded. */
export function getSidebarOpen(): boolean {
  if (typeof window === "undefined") {
    return DEFAULT_SIDEBAR_OPEN;
  }

  try {
    const stored = localStorage.getItem(SIDEBAR_OPEN_KEY);
    if (stored == null || stored === "") {
      return DEFAULT_SIDEBAR_OPEN;
    }
    if (stored === "true" || stored === "false") {
      return stored === "true";
    }
    return normalizeSidebarOpen(JSON.parse(stored) as unknown);
  } catch {
    return DEFAULT_SIDEBAR_OPEN;
  }
}

/** Persist sidebar open preference. Swallows storage errors. */
export function setSidebarOpen(open: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    localStorage.setItem(SIDEBAR_OPEN_KEY, normalizeSidebarOpen(open) ? "true" : "false");
  } catch {
    // Quota or private-mode failures must not break the page.
  }
}
