// ABOUTME: Supported UI languages and helpers for normalize / detect / cache.
// ABOUTME: Aligns with AppSettings.uiLanguage and localStorage pre-init cache.

export const APP_LANGUAGES = ["en", "zh-CN"] as const;

export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: AppLanguage = "en";
export const FALLBACK_LANGUAGE: AppLanguage = "en";

export const LANGUAGE_STORAGE_KEY = "langnext-ui-language";
export const LANGUAGE_CHANGE_EVENT = "langnext-languagechange";

export function isAppLanguage(value: string | null | undefined): value is AppLanguage {
	return value === "en" || value === "zh-CN";
}

/** Map arbitrary language tags (BCP 47 / settings) onto supported app languages. */
export function normalizeLanguage(value: string | null | undefined): AppLanguage {
	if (!value) {
		return DEFAULT_LANGUAGE;
	}
	if (isAppLanguage(value)) {
		return value;
	}
	const lower = value.toLowerCase();
	if (lower === "zh-cn" || lower === "zh" || lower.startsWith("zh-")) {
		return "zh-CN";
	}
	if (lower === "en" || lower.startsWith("en-")) {
		return "en";
	}
	return DEFAULT_LANGUAGE;
}

export function detectBrowserLanguage(): AppLanguage {
	if (typeof navigator === "undefined") {
		return DEFAULT_LANGUAGE;
	}
	const candidates = [navigator.language, ...(navigator.languages ?? [])];
	for (const tag of candidates) {
		const normalized = normalizeLanguage(tag);
		if (tag && (isAppLanguage(tag) || tag.toLowerCase().startsWith("zh") || tag.toLowerCase().startsWith("en"))) {
			return normalized;
		}
	}
	return DEFAULT_LANGUAGE;
}

/** Read pre-init cache; falls back to browser language, then default. */
export function readLanguageCache(): AppLanguage {
	if (typeof window === "undefined") {
		return DEFAULT_LANGUAGE;
	}
	const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
	if (isAppLanguage(stored)) {
		return stored;
	}
	return detectBrowserLanguage();
}

/** Apply language to document + localStorage cache (not SQLite). */
export function applyLanguageToDom(language: AppLanguage): void {
	if (typeof document === "undefined") {
		return;
	}
	// Skip setItem when unchanged so peer webviews do not re-broadcast storage events.
	if (localStorage.getItem(LANGUAGE_STORAGE_KEY) !== language) {
		localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
	}
	if (document.documentElement.lang !== language) {
		document.documentElement.lang = language;
	}
	window.dispatchEvent(new CustomEvent(LANGUAGE_CHANGE_EVENT, { detail: language }));
}

export function languageDisplayName(language: AppLanguage): string {
	switch (language) {
		case "en":
			return "English";
		case "zh-CN":
			return "中文";
	}
}

export function nextLanguage(current: AppLanguage): AppLanguage {
	return current === "en" ? "zh-CN" : "en";
}
