// ABOUTME: Unit tests for translate session preference normalize/read helpers.
// ABOUTME: Covers defaults, partial objects, invalid language ids, and JSON edge cases.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_TRANSLATE_SESSION_PREFERENCES,
	TRANSLATE_SESSION_PREFERENCES_KEY,
	getTranslateSessionPreferences,
	normalizeTranslateSessionPreferences,
	setTranslateSessionPreferences,
} from "./-sessionPreferences";

/** Minimal in-memory localStorage for bun:test (no DOM globals). */
function installMemoryLocalStorage(): void {
	const store = new Map<string, string>();
	const memoryStorage: Storage = {
		get length() {
			return store.size;
		},
		clear() {
			store.clear();
		},
		getItem(key: string) {
			return store.has(key) ? (store.get(key) ?? null) : null;
		},
		key(index: number) {
			return [...store.keys()][index] ?? null;
		},
		removeItem(key: string) {
			store.delete(key);
		},
		setItem(key: string, value: string) {
			store.set(key, String(value));
		},
	};
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: memoryStorage,
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		writable: true,
		value: { localStorage: memoryStorage },
	});
}

beforeEach(() => {
	installMemoryLocalStorage();
});

afterEach(() => {
	localStorage.removeItem(TRANSLATE_SESSION_PREFERENCES_KEY);
});

describe("normalizeTranslateSessionPreferences", () => {
	test("returns defaults for null, undefined, and non-objects", () => {
		expect(normalizeTranslateSessionPreferences(null)).toEqual(DEFAULT_TRANSLATE_SESSION_PREFERENCES);
		expect(normalizeTranslateSessionPreferences(undefined)).toEqual(DEFAULT_TRANSLATE_SESSION_PREFERENCES);
		expect(normalizeTranslateSessionPreferences("oops")).toEqual(DEFAULT_TRANSLATE_SESSION_PREFERENCES);
		expect(normalizeTranslateSessionPreferences(42)).toEqual(DEFAULT_TRANSLATE_SESSION_PREFERENCES);
	});

	test("accepts a full valid payload", () => {
		expect(
			normalizeTranslateSessionPreferences({
				profileId: "prof-1",
				modelId: "model-1",
				sourceLang: "zh",
				targetLang: "en",
			}),
		).toEqual({
			profileId: "prof-1",
			modelId: "model-1",
			sourceLang: "zh",
			targetLang: "en",
		});
	});

	test("keeps empty profile/model ids and auto languages", () => {
		expect(
			normalizeTranslateSessionPreferences({
				profileId: "",
				modelId: "",
				sourceLang: "auto",
				targetLang: "auto",
			}),
		).toEqual({
			profileId: "",
			modelId: "",
			sourceLang: "auto",
			targetLang: "auto",
		});
	});

	test("falls back invalid language ids", () => {
		expect(
			normalizeTranslateSessionPreferences({
				profileId: 123,
				modelId: null,
				sourceLang: "ru",
				targetLang: "xx",
			}),
		).toEqual({
			profileId: "",
			modelId: "",
			sourceLang: "auto",
			targetLang: "en",
		});
	});

	test("fills missing fields from defaults without dropping valid ones", () => {
		expect(
			normalizeTranslateSessionPreferences({
				sourceLang: "ja",
			}),
		).toEqual({
			profileId: "",
			modelId: "",
			sourceLang: "ja",
			targetLang: "en",
		});
	});

	test("ignores a legacy useStreaming field stored by older versions", () => {
		expect(
			normalizeTranslateSessionPreferences({
				profileId: "p1",
				modelId: "m1",
				sourceLang: "zh",
				targetLang: "en",
				useStreaming: false,
			}),
		).toEqual({
			profileId: "p1",
			modelId: "m1",
			sourceLang: "zh",
			targetLang: "en",
		});
	});
});

describe("getTranslateSessionPreferences / setTranslateSessionPreferences", () => {
	test("returns defaults when nothing is stored", () => {
		expect(getTranslateSessionPreferences()).toEqual(DEFAULT_TRANSLATE_SESSION_PREFERENCES);
	});

	test("round-trips a valid preference object", () => {
		const prefs = {
			profileId: "p1",
			modelId: "m1",
			sourceLang: "fr" as const,
			targetLang: "de" as const,
		};
		setTranslateSessionPreferences(prefs);
		expect(getTranslateSessionPreferences()).toEqual(prefs);
	});

	test("returns defaults for corrupt JSON", () => {
		localStorage.setItem(TRANSLATE_SESSION_PREFERENCES_KEY, "{not-json");
		expect(getTranslateSessionPreferences()).toEqual(DEFAULT_TRANSLATE_SESSION_PREFERENCES);
	});

	test("normalizes invalid stored payloads on read", () => {
		localStorage.setItem(TRANSLATE_SESSION_PREFERENCES_KEY, JSON.stringify({ sourceLang: "nope", modelId: "keep-me" }));
		expect(getTranslateSessionPreferences()).toEqual({
			profileId: "",
			modelId: "keep-me",
			sourceLang: "auto",
			targetLang: "en",
		});
	});
});
