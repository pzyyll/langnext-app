// ABOUTME: Load authoritative AppSettings in Tauri and sync the pre-paint theme cache.
// ABOUTME: Browser-only dev keeps localStorage as a non-authoritative cache.
import { getAppSettings, updateAppSettings } from "./client";
import type { AppSettingsDto, AppSettingsV1 } from "./types";
import { THEME_STORAGE_KEY, applyThemeToDom, getOsTheme, isThemeMode, type ThemeMode } from "../theme/theme";

function isTauriRuntime(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Cache-only pre-paint theme from localStorage or OS preference. */
export function readThemeCache(): ThemeMode {
	if (typeof window === "undefined") {
		return "light";
	}
	const stored = localStorage.getItem(THEME_STORAGE_KEY);
	if (isThemeMode(stored)) {
		return stored;
	}
	return getOsTheme();
}

/**
 * In Tauri: load SQLite settings, migrate null theme once, apply and refresh cache.
 * In browser-only dev: apply cache only (not persisted desktop configuration).
 */
export async function bootstrapStorage(): Promise<AppSettingsDto | null> {
	if (!isTauriRuntime()) {
		applyThemeToDom(readThemeCache());
		return null;
	}

	const settings = await getAppSettings();
	let theme = settings.theme;

	if (theme === null) {
		const legacy = readThemeCache();
		const next: AppSettingsV1 = {
			...settings,
			theme: legacy,
		};
		// Drop proxyHasCredential from the flattened DTO when building update payload.
		const { proxyHasCredential: _proxy, ...portable } = next as AppSettingsDto;
		void _proxy;
		const updated = await updateAppSettings({
			settings: {
				schemaVersion: portable.schemaVersion,
				uiLanguage: portable.uiLanguage,
				theme: legacy,
				defaultProfileId: portable.defaultProfileId,
				translation: portable.translation,
				shortcuts: portable.shortcuts,
				network: portable.network,
			},
			proxyCredential: { action: "keep" },
		});
		theme = updated.theme;
		applyAuthoritativeTheme(theme);
		return updated;
	}

	applyAuthoritativeTheme(theme);
	return settings;
}

function applyAuthoritativeTheme(theme: string | null): void {
	const mode: ThemeMode = isThemeMode(theme) ? theme : readThemeCache();
	applyThemeToDom(mode);
	localStorage.setItem(THEME_STORAGE_KEY, mode);
}
