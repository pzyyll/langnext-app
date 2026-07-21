// ABOUTME: Rebind this process after configuration import (theme, language, shortcuts).
// ABOUTME: Does not invalidate Query caches; routes own invalidation and UX toasts.
import { applyAppLanguage } from "../../i18n";
import { normalizeLanguage } from "../../i18n/languages";
import { getAppSettings, setAppShortcuts } from "../../storage/client";
import type { AppSettingsDto } from "../../storage/types";
import { applyThemeToDom, isThemeMode } from "../../theme/theme";

/**
 * Rebind this process after configuration import. Does not invalidate Query caches.
 * Order: load settings → conditional theme DOM apply → language → OS shortcuts.
 * Rejects with the underlying client/IPC error on failure (best-effort partial apply).
 */
export async function applyImportedAppSettings(): Promise<AppSettingsDto> {
  const settings = await getAppSettings();
  if (isThemeMode(settings.theme)) {
    applyThemeToDom(settings.theme);
  }
  await applyAppLanguage(normalizeLanguage(settings.uiLanguage));
  // set_app_shortcuts re-registers OS hotkeys; plain app_settings import does not.
  await setAppShortcuts(settings.shortcuts);
  return settings;
}
