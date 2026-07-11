// ABOUTME: i18next singleton setup for the React app.
// ABOUTME: Uses bundled resources only; language persistence lives in settings/cache helpers.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";
import {
	DEFAULT_LANGUAGE,
	FALLBACK_LANGUAGE,
	applyLanguageToDom,
	normalizeLanguage,
	readLanguageCache,
	type AppLanguage,
} from "./languages";

export const resources = {
	en: { translation: en },
	"zh-CN": { translation: zhCN },
} as const;

let initPromise: Promise<typeof i18n> | null = null;

/**
 * Initialize i18next once. Safe to call multiple times.
 * @param language Optional authoritative language (e.g. from AppSettings).
 */
export async function initI18n(language?: string | null): Promise<typeof i18n> {
	const resolved = normalizeLanguage(language ?? readLanguageCache());

	if (i18n.isInitialized) {
		if (i18n.language !== resolved) {
			await i18n.changeLanguage(resolved);
		}
		applyLanguageToDom(resolved);
		return i18n;
	}

	if (!initPromise) {
		initPromise = i18n
			.use(initReactI18next)
			.init({
				resources,
				lng: resolved,
				fallbackLng: FALLBACK_LANGUAGE,
				defaultNS: "translation",
				ns: ["translation"],
				interpolation: {
					escapeValue: false,
				},
				returnNull: false,
			})
			.then(() => {
				applyLanguageToDom(resolved);
				return i18n;
			});
	}

	const instance = await initPromise;
	if (instance.language !== resolved) {
		await instance.changeLanguage(resolved);
		applyLanguageToDom(resolved);
	}
	return instance;
}

/** Apply language in i18n + DOM/cache without persisting to SQLite. */
export async function applyAppLanguage(language: AppLanguage): Promise<void> {
	const resolved = normalizeLanguage(language);
	if (!i18n.isInitialized) {
		await initI18n(resolved);
		return;
	}
	if (i18n.language !== resolved) {
		await i18n.changeLanguage(resolved);
	}
	applyLanguageToDom(resolved);
}

export function getAppLanguage(): AppLanguage {
	if (!i18n.isInitialized) {
		return readLanguageCache();
	}
	return normalizeLanguage(i18n.language);
}

export { DEFAULT_LANGUAGE, FALLBACK_LANGUAGE };
export type { AppLanguage };
export default i18n;
