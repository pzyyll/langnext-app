// ABOUTME: Load authoritative AppSettings in Tauri and sync theme/language caches.
// ABOUTME: Browser-only dev keeps localStorage as a non-authoritative cache.
import { getAppSettings, updateAppSettings } from "./client";
import type { AppSettingsDto, AppSettingsV1 } from "./types";
import { THEME_STORAGE_KEY, applyThemeToDom, getOsTheme, isThemeMode, type ThemeMode } from "../theme/theme";
import { applyAppLanguage, initI18n } from "../i18n";
import { normalizeLanguage, readLanguageCache, type AppLanguage } from "../i18n/languages";

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
 * In Tauri: load SQLite settings, migrate null theme once, apply theme/language caches.
 * In browser-only dev: apply cache only (not persisted desktop configuration).
 */
export async function bootstrapStorage(): Promise<AppSettingsDto | null> {
	if (!isTauriRuntime()) {
		applyThemeToDom(readThemeCache());
		await initI18n(readLanguageCache());
		return null;
	}

	const settings = await getAppSettings();
	let theme = settings.theme;
	let result: AppSettingsDto = settings;

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
		result = updated;
	}

	applyAuthoritativeTheme(theme);
	await applyAuthoritativeLanguage(result.uiLanguage);
	return result;
}

function applyAuthoritativeTheme(theme: string | null): void {
	const mode: ThemeMode = isThemeMode(theme) ? theme : readThemeCache();
	applyThemeToDom(mode);
	localStorage.setItem(THEME_STORAGE_KEY, mode);
}

async function applyAuthoritativeLanguage(uiLanguage: string): Promise<void> {
	const language: AppLanguage = normalizeLanguage(uiLanguage);
	await initI18n(language);
	await applyAppLanguage(language);
}
