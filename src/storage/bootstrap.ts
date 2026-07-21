// ABOUTME: Load authoritative AppSettings in Tauri and sync theme/language caches.
// ABOUTME: Browser-only dev keeps localStorage as a non-authoritative cache.
import { Effect } from "effect";
import { applyAppLanguage, initI18n } from "../i18n";
import { normalizeLanguage, readLanguageCache, type AppLanguage } from "../i18n/languages";
import { THEME_STORAGE_KEY, applyThemeToDom, getOsTheme, isThemeMode, type ThemeMode } from "../theme/theme";
import { invokeEffect } from "./invokeEffect";
import type { IpcError } from "./ipcError";
import { runStorage } from "./runStorage";
import type { AppSettingsDto, AppSettingsUpdate, AppSettingsV1 } from "./types";

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

function applyAuthoritativeTheme(theme: string | null): void {
  const mode: ThemeMode = isThemeMode(theme) ? theme : readThemeCache();
  applyThemeToDom(mode);
  localStorage.setItem(THEME_STORAGE_KEY, mode);
}

function applyAuthoritativeLanguage(uiLanguage: string): Effect.Effect<void, never> {
  const language: AppLanguage = normalizeLanguage(uiLanguage);
  return Effect.promise(async () => {
    await initI18n(language);
    await applyAppLanguage(language);
  });
}

/** Build the one-time null-theme migration update payload from a settings DTO. */
function nullThemeMigrationUpdate(settings: AppSettingsDto, legacyTheme: ThemeMode): AppSettingsUpdate {
  const next: AppSettingsV1 = {
    ...settings,
    theme: legacyTheme,
  };
  // Drop proxyHasCredential from the flattened DTO when building update payload.
  const { proxyHasCredential: _proxy, ...portable } = next as AppSettingsDto;
  void _proxy;
  return {
    settings: {
      schemaVersion: portable.schemaVersion,
      uiLanguage: portable.uiLanguage,
      theme: legacyTheme,
      defaultProfileId: portable.defaultProfileId,
      translation: portable.translation,
      shortcuts: portable.shortcuts,
      network: portable.network,
    },
    proxyCredential: { action: "keep" },
  };
}

/**
 * Bootstrap program: Tauri loads SQLite settings (migrate null theme once), then applies
 * theme/language. Browser-only path uses local caches and returns null.
 * Does not log full settings blobs.
 */
export function bootstrapStorageEffect(): Effect.Effect<AppSettingsDto | null, IpcError> {
  if (!isTauriRuntime()) {
    return Effect.gen(function* () {
      applyThemeToDom(readThemeCache());
      yield* Effect.promise(() => initI18n(readLanguageCache()));
      return null;
    });
  }

  return Effect.gen(function* () {
    let result = yield* invokeEffect<AppSettingsDto>("get_app_settings");

    if (result.theme === null) {
      const legacy = readThemeCache();
      result = yield* invokeEffect<AppSettingsDto>("update_app_settings", {
        input: nullThemeMigrationUpdate(result, legacy),
      });
    }

    applyAuthoritativeTheme(result.theme);
    yield* applyAuthoritativeLanguage(result.uiLanguage);
    return result;
  });
}

/**
 * In Tauri: load SQLite settings, migrate null theme once, apply theme/language caches.
 * In browser-only dev: apply cache only (not persisted desktop configuration).
 * Rejects with raw `IpcError` on IPC failure.
 */
export async function bootstrapStorage(): Promise<AppSettingsDto | null> {
  return runStorage(bootstrapStorageEffect());
}
