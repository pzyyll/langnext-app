// ABOUTME: Light/dark theme helpers for DOM application and pre-paint cache.
// ABOUTME: Immediate DOM/cache updates are separate from authoritative settings persistence.
export type ThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "langnext-theme";
export const THEME_CHANGE_EVENT = "langnext-themechange";

let themeSyncInstalled = false;

export function isThemeMode(value: string | null | undefined): value is ThemeMode {
	return value === "light" || value === "dark";
}

export function getOsTheme(): ThemeMode {
	if (typeof window === "undefined") {
		return "light";
	}
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Resolve cached preference or fall back to the OS color scheme (not SQLite). */
export function getTheme(): ThemeMode {
	if (typeof window === "undefined") {
		return "light";
	}

	const stored = localStorage.getItem(THEME_STORAGE_KEY);
	if (isThemeMode(stored)) {
		return stored;
	}

	return getOsTheme();
}

/** Read the currently applied theme attribute (may differ before init). */
export function getAppliedTheme(): ThemeMode {
	if (typeof document === "undefined") {
		return "light";
	}

	const attr = document.documentElement.getAttribute("data-theme");
	return isThemeMode(attr) ? attr : getTheme();
}

/** Apply theme to DOM and pre-paint cache only (no backend persistence). */
export function applyThemeToDom(mode: ThemeMode): void {
	if (typeof document === "undefined") {
		return;
	}
	// Skip setItem when unchanged so peer webviews do not re-broadcast storage events.
	if (localStorage.getItem(THEME_STORAGE_KEY) !== mode) {
		localStorage.setItem(THEME_STORAGE_KEY, mode);
	}
	if (document.documentElement.getAttribute("data-theme") !== mode) {
		document.documentElement.setAttribute("data-theme", mode);
	}
	if (document.documentElement.style.colorScheme !== mode) {
		document.documentElement.style.colorScheme = mode;
	}
	window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: mode }));
}

/** Resolve the theme implied by a peer-window storage event, or null if unrelated. */
export function resolveThemeFromStorageEvent(event: Pick<StorageEvent, "key" | "newValue">): ThemeMode | null {
	if (event.key !== THEME_STORAGE_KEY && event.key !== null) {
		return null;
	}
	if (event.key === null || event.newValue == null) {
		return getTheme();
	}
	return isThemeMode(event.newValue) ? event.newValue : getTheme();
}

/** Apply a peer-window theme cache change to this webview's DOM. */
export function handleThemeStorageEvent(event: Pick<StorageEvent, "key" | "newValue">): void {
	const next = resolveThemeFromStorageEvent(event);
	if (next == null) {
		return;
	}
	applyThemeToDom(next);
}

/**
 * Keep secondary Tauri webviews (e.g. Quick Translate) in sync when another
 * window updates the shared localStorage theme cache.
 * Same-window updates use THEME_CHANGE_EVENT instead.
 */
export function installThemeCrossWindowSync(): void {
	if (typeof window === "undefined" || themeSyncInstalled) {
		return;
	}
	themeSyncInstalled = true;

	window.addEventListener("storage", (event: StorageEvent) => {
		handleThemeStorageEvent(event);
	});
}

/**
 * Persist preference to the pre-paint cache and apply DOM theme.
 * Authoritative desktop persistence goes through the settings client.
 */
export function setTheme(mode: ThemeMode): void {
	applyThemeToDom(mode);
}

/** Flip light ↔ dark and return the new mode (DOM/cache only). */
export function toggleTheme(): ThemeMode {
	const next: ThemeMode = getAppliedTheme() === "dark" ? "light" : "dark";
	setTheme(next);
	return next;
}

/** Apply cached or system theme (safe to call at app bootstrap before storage). */
export function initTheme(): ThemeMode {
	// Install before apply so early peer storage events are not dropped after mount.
	installThemeCrossWindowSync();
	const mode = getTheme();
	applyThemeToDom(mode);
	return mode;
}
