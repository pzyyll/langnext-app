// ABOUTME: React hook for reading and changing the active UI language.
// ABOUTME: Persists via settings IPC in Tauri and rolls back on failure.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { setAppUiLanguage } from "../storage/client";
import { LANGUAGE_CHANGE_EVENT, nextLanguage, normalizeLanguage, type AppLanguage } from "./languages";
import { applyAppLanguage, getAppLanguage } from "./index";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useLanguage() {
  const { t, i18n } = useTranslation();
  const [language, setLanguageState] = useState<AppLanguage>(() => getAppLanguage());
  const [error, setError] = useState<string | null>(null);
  // Last successfully persisted language for rollback on IPC failure.
  const baselineRef = useRef<AppLanguage>(getAppLanguage());

  useEffect(() => {
    const sync = () => {
      setLanguageState(getAppLanguage());
    };

    const onI18n = (lng: string) => {
      setLanguageState(normalizeLanguage(lng));
    };

    // Cross-window localStorage changes are applied by installLanguageCrossWindowSync
    // (initI18n); this hook only mirrors the resulting same-window i18n/DOM updates.
    window.addEventListener(LANGUAGE_CHANGE_EVENT, sync);
    i18n.on("languageChanged", onI18n);
    return () => {
      window.removeEventListener(LANGUAGE_CHANGE_EVENT, sync);
      i18n.off("languageChanged", onI18n);
    };
  }, [i18n]);

  const setLanguage = useCallback(
    async (mode: AppLanguage) => {
      const previous = baselineRef.current;
      await applyAppLanguage(mode);
      setLanguageState(mode);
      setError(null);

      if (!isTauriRuntime()) {
        baselineRef.current = mode;
        return;
      }

      try {
        await setAppUiLanguage(mode);
        baselineRef.current = mode;
      } catch (err: unknown) {
        await applyAppLanguage(previous);
        setLanguageState(previous);
        setError(err instanceof Error ? err.message : t("language.persistFailed"));
      }
    },
    [t],
  );

  const toggle = useCallback(async () => {
    const next = nextLanguage(getAppLanguage());
    await setLanguage(next);
    return next;
  }, [setLanguage]);

  return { language, setLanguage, toggle, error, t };
}
