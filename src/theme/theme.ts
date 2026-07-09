// ABOUTME: Light/dark theme helpers backed by data-theme and localStorage.
// ABOUTME: applyTheme updates <html>; toggleTheme flips between light and dark.
export type ThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "langnext-theme";
export const THEME_CHANGE_EVENT = "langnext-themechange";

function isThemeMode(value: string | null): value is ThemeMode {
	return value === "light" || value === "dark";
}

/** Resolve stored preference or fall back to the OS color scheme. */
export function getTheme(): ThemeMode {
	if (typeof window === "undefined") {
		return "light";
	}

	const stored = localStorage.getItem(THEME_STORAGE_KEY);
	if (isThemeMode(stored)) {
		return stored;
	}

	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Read the currently applied theme attribute (may differ before init). */
export function getAppliedTheme(): ThemeMode {
	if (typeof document === "undefined") {
		return "light";
	}

	const attr = document.documentElement.getAttribute("data-theme");
	return isThemeMode(attr) ? attr : getTheme();
}

/** Persist preference and apply `data-theme` + `color-scheme` on <html>. */
export function setTheme(mode: ThemeMode): void {
	localStorage.setItem(THEME_STORAGE_KEY, mode);
	document.documentElement.setAttribute("data-theme", mode);
	document.documentElement.style.colorScheme = mode;
	window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: mode }));
}

/** Flip light ↔ dark and return the new mode. */
export function toggleTheme(): ThemeMode {
	const next: ThemeMode = getAppliedTheme() === "dark" ? "light" : "dark";
	setTheme(next);
	return next;
}

/** Apply stored or system theme (safe to call at app bootstrap). */
export function initTheme(): ThemeMode {
	const mode = getTheme();
	document.documentElement.setAttribute("data-theme", mode);
	document.documentElement.style.colorScheme = mode;
	return mode;
}
