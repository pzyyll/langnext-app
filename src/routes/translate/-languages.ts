// ABOUTME: Shared translation language policy: supported ids, guards, defaults, and Auto target resolver.
// ABOUTME: Consumed by the translate page and profile editor so one decision rule drives the UI.
import type { AppLanguage } from "../../i18n/languages";

/** Supported concrete translation language ids (mirrors Rust `SUPPORTED_LANGUAGES`). */
export const LANGUAGE_IDS = [
	"zh",
	"en",
	"ar",
	"bg",
	"bn",
	"cs",
	"da",
	"de",
	"el",
	"es",
	"fa",
	"fi",
	"fr",
	"he",
	"hi",
	"hr",
	"hu",
	"id",
	"it",
	"ja",
	"ko",
	"lt",
	"lv",
	"ms",
	"nl",
	"no",
	"pl",
	"pt",
	"ro",
	"ru",
	"sk",
	"sl",
	"sr",
	"sv",
	"sw",
	"ta",
	"th",
	"tl",
	"tr",
	"uk",
	"ur",
	"vi",
] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];

/** Sentinel id marking an unresolved (Auto) source/output selector. */
export const AUTO_LANGUAGE = "auto" as const;

/** Concrete id or `auto`, used by source/output selectors. */
export type SelectableLanguageId = LanguageId | typeof AUTO_LANGUAGE;

/** Source selector accepts `auto`. */
export type SourceLanguageId = SelectableLanguageId;
/** Output selector accepts `auto` (resolved to a concrete id before reaching the backend). */
export type TargetLanguageId = SelectableLanguageId;

/** True for a concrete supported language id (never `auto`). */
export function isLanguageId(value: string | null | undefined): value is LanguageId {
	return !!value && value !== AUTO_LANGUAGE && (LANGUAGE_IDS as readonly string[]).includes(value);
}

/** True for `auto` or a concrete supported language id. */
export function isSelectableLanguageId(value: string | null | undefined): value is SelectableLanguageId {
	return value === AUTO_LANGUAGE || isLanguageId(value);
}

/** Profile-level preferred language pair (Primary/Target preference), both concrete and distinct. */
export interface ProfileLanguageDefaults {
	primary: LanguageId;
	target: LanguageId;
}

/**
 * Default Primary/Target preference pair for a new profile derived from the UI locale.
 *
 * `zh-CN` -> `{ primary: "zh", target: "en" }`; any other locale -> `{ primary: "en", target: "zh" }`
 * so the exclusion rule (Primary !== Target preference) always holds out of the box.
 */
export function getDefaultProfileLanguages(
	uiLanguage: AppLanguage | string | null | undefined,
): ProfileLanguageDefaults {
	if (uiLanguage && uiLanguage.toLowerCase().startsWith("zh")) {
		return { primary: "zh", target: "en" };
	}
	return { primary: "en", target: "zh" };
}

/** Resolved profile language preferences consumed by the Auto-target resolver. */
export interface ProfileLangPrefs {
	primary: LanguageId;
	preferredTarget: LanguageId;
}

/**
 * Resolve the effective profile language preferences for the Auto-target resolver.
 *
 * Falls back to the current UI-locale default pair unless a profile is actively selected AND
 * carries both preference fields, so the resolver always receives a concrete, distinct pair.
 * Passing `hasActiveProfile = false` (no selection, apply failed, or the profile was
 * cleared/invalidated) resets to the defaults even when stale preference state remains, which
 * is the single rule that keeps stale profile preferences from leaking into Auto-target.
 */
export function resolveProfileLangPrefs(
	hasActiveProfile: boolean,
	profilePrimary: LanguageId | null,
	profilePreferredTarget: LanguageId | null,
	uiLanguage: AppLanguage | string | null | undefined,
): ProfileLangPrefs {
	if (hasActiveProfile && profilePrimary && profilePreferredTarget) {
		return { primary: profilePrimary, preferredTarget: profilePreferredTarget };
	}
	const defaults = getDefaultProfileLanguages(uiLanguage);
	return { primary: defaults.primary, preferredTarget: defaults.target };
}

/** Inputs to the Auto output resolver. */
export interface ResolveTargetLanguageInput {
	/** Effective source language id (manual selection or detection result). */
	source: LanguageId;
	/** Configured output selector: a concrete id or `auto`. */
	configuredTarget: SelectableLanguageId;
	/** Profile Primary preference (concrete; must differ from `preferredTarget`). */
	primary: LanguageId;
	/** Profile Target preference (concrete; must differ from `primary`). */
	preferredTarget: LanguageId;
}

/**
 * Resolve the effective concrete target language id from the profile decision rule.
 *
 * 1. A concrete configured target is used unchanged (even when it equals the source).
 * 2. `auto` + `source !== preferredTarget` -> `preferredTarget`.
 * 3. `auto` + `source === preferredTarget` -> `primary`.
 *
 * The result is always a concrete supported id, so the localized label sent to the Rust
 * translation payload is never `Auto`. Equal `primary`/`preferredTarget` is invalid profile
 * data that the UI and Rust service block; this resolver still returns `preferredTarget` in
 * that degenerate case rather than throwing, so a malformed state cannot abort a request.
 */
export function resolveTargetLanguage(input: ResolveTargetLanguageInput): LanguageId {
	const { source, configuredTarget, primary, preferredTarget } = input;
	if (configuredTarget !== AUTO_LANGUAGE) {
		return configuredTarget;
	}
	if (source === preferredTarget) {
		return primary;
	}
	return preferredTarget;
}
