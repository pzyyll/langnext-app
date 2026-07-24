// ABOUTME: Settings route for appearance, language, shortcuts, and config backup.
// ABOUTME: Reuses theme/language hooks; backup handlers call configurationTransfer runners.
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Switch } from "@base-ui/react/switch";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import IconClarityMoonLine from "~icons/clarity/moon-line";
import IconClaritySunLine from "~icons/clarity/sun-line";
import { PageLayout } from "../components/layouts/PageLayout";
import { ScrollArea } from "../components/ScrollArea";
import {
  inputClassName,
  outlineButtonClassName,
  radioClassName,
  radioIndicatorClassName,
  switchRootClassName,
  switchThumbClassName,
} from "../components/ui";
import { useToast } from "../components/toast/useToast";
import { applyImportedAppSettings } from "../features/settings/applyImportedAppSettings";
import {
  runExportConfigurationToFile,
  runImportConfigurationFromFile,
} from "../features/settings/configurationTransfer";
import { importAuthWarningKind, invalidateAfterConfigurationImport } from "../features/settings/importAcceptance";
import { getUserErrorMessage } from "../features/userErrorMessage";
import { APP_LANGUAGES, type AppLanguage } from "../i18n/languages";
import { useLanguage } from "../i18n/useLanguage";
import { getAppSettings, setAppShortcuts } from "../storage/client";
import {
  DEFAULT_OPEN_QUICK_TRANSLATE_BINDING,
  DEFAULT_REGION_SCREENSHOT_BINDING,
  DEFAULT_SCREENSHOT_OCR_BINDING,
  DOUBLE_CTRL_C_BINDING,
  SHORTCUT_DOUBLE_CTRL_C,
  SHORTCUT_OPEN_QUICK_TRANSLATE,
  SHORTCUT_REGION_SCREENSHOT,
  SHORTCUT_SCREENSHOT_OCR,
  type ShortcutDefinition,
} from "../storage/types";
import { useTheme } from "../theme/useTheme";
import { type ThemeMode } from "../theme/theme";
import { formatShortcutBinding, keyboardEventToBinding } from "./-shortcutBinding";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

const optionBaseClassName =
  "flex min-h-10 flex-1 items-center gap-2 rounded-none border border-line bg-surface px-2 text-body-tight leading-none font-normal text-neutral transition-colors duration-150 select-none hover:bg-surface-2 hover:text-on-surface focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-on-surface";

const optionActiveClassName =
  "flex min-h-10 flex-1 items-center gap-2 rounded-none border border-line bg-surface-2 px-2 text-body-tight leading-none font-normal text-on-surface transition-colors duration-150 select-none focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-on-surface";

/** Form card chrome shared by theme/language/shortcuts/backup sections. */
const settingsSectionClassName = "shadow-frame border border-line bg-surface p-gutter";

/** Centered form column inside ScrollArea (same scrollbar as Models/OCR/Profiles). */
const settingsContentColumnClassName = "mx-auto flex w-full max-w-2xl flex-col gap-6";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /Win/i.test(navigator.platform) || /Windows/i.test(navigator.userAgent);
}

function defaultShortcuts(): ShortcutDefinition[] {
  return [
    {
      id: SHORTCUT_OPEN_QUICK_TRANSLATE,
      binding: DEFAULT_OPEN_QUICK_TRANSLATE_BINDING,
      enabled: true,
    },
    {
      id: SHORTCUT_DOUBLE_CTRL_C,
      binding: DOUBLE_CTRL_C_BINDING,
      enabled: true,
    },
    {
      id: SHORTCUT_REGION_SCREENSHOT,
      binding: DEFAULT_REGION_SCREENSHOT_BINDING,
      enabled: true,
    },
    {
      id: SHORTCUT_SCREENSHOT_OCR,
      binding: DEFAULT_SCREENSHOT_OCR_BINDING,
      enabled: true,
    },
  ];
}

function readShortcut(shortcuts: ShortcutDefinition[], id: string, fallback: ShortcutDefinition): ShortcutDefinition {
  return shortcuts.find((entry) => entry.id === id) ?? fallback;
}

function SettingsPage() {
  const { t } = useTranslation();
  const { theme, setTheme, error: themeError } = useTheme();
  const { language, setLanguage, error: languageError } = useLanguage();

  const themeOptions: { value: ThemeMode; label: string; icon: "sun" | "moon" }[] = [
    { value: "light", label: t("theme.light"), icon: "sun" },
    { value: "dark", label: t("theme.dark"), icon: "moon" },
  ];

  const languageOptions: { value: AppLanguage; label: string }[] = APP_LANGUAGES.map((value) => ({
    value,
    label: value === "en" ? t("language.en") : t("language.zhCN"),
  }));

  return (
    <PageLayout title={t("settings.title")} contentClassName="overflow-hidden">
      <ScrollArea className="min-h-0 flex-1" contentClassName="p-gutter">
        <div className={settingsContentColumnClassName}>
          <section className={settingsSectionClassName}>
            <fieldset className="flex flex-col gap-3 border-0 p-0">
              <legend className="float-left w-full text-body-bold font-bold text-on-surface">
                {t("settings.theme.title")}
              </legend>
              <p id="settings-theme-desc" className="clear-both text-body-tight text-neutral">
                {t("settings.theme.description")}
              </p>
              <RadioGroup
                value={theme}
                onValueChange={(value) => {
                  void setTheme(value as ThemeMode);
                }}
                className="
                  flex flex-col gap-2
                  sm:flex-row
                "
                aria-describedby="settings-theme-desc"
              >
                {themeOptions.map((option) => {
                  const selected = theme === option.value;
                  return (
                    <label key={option.value} className={selected ? optionActiveClassName : optionBaseClassName}>
                      <Radio.Root value={option.value} className={radioClassName}>
                        <Radio.Indicator className={radioIndicatorClassName} />
                      </Radio.Root>
                      {option.icon === "sun" ? (
                        <IconClaritySunLine className="pointer-events-none size-4 shrink-0" aria-hidden />
                      ) : (
                        <IconClarityMoonLine className="pointer-events-none size-4 shrink-0" aria-hidden />
                      )}
                      <span>{option.label}</span>
                    </label>
                  );
                })}
              </RadioGroup>
              {themeError ? (
                <p className="text-xs text-error" role="alert" aria-live="polite">
                  {themeError}
                </p>
              ) : null}
            </fieldset>
          </section>

          <section className={settingsSectionClassName}>
            <fieldset className="flex flex-col gap-3 border-0 p-0">
              <legend className="float-left w-full text-body-bold font-bold text-on-surface">
                {t("settings.language.title")}
              </legend>
              <p id="settings-language-desc" className="clear-both text-body-tight text-neutral">
                {t("settings.language.description")}
              </p>
              <RadioGroup
                value={language}
                onValueChange={(value) => {
                  void setLanguage(value as AppLanguage);
                }}
                className="
                  flex flex-col gap-2
                  sm:flex-row
                "
                aria-describedby="settings-language-desc"
              >
                {languageOptions.map((option) => {
                  const selected = language === option.value;
                  return (
                    <label key={option.value} className={selected ? optionActiveClassName : optionBaseClassName}>
                      <Radio.Root value={option.value} className={radioClassName}>
                        <Radio.Indicator className={radioIndicatorClassName} />
                      </Radio.Root>
                      <span
                        className="
                          pointer-events-none size-4 shrink-0 text-center text-[10px]/4 font-bold tracking-wide
                        "
                      >
                        {option.value === "en" ? "EN" : "中"}
                      </span>
                      <span>{option.label}</span>
                    </label>
                  );
                })}
              </RadioGroup>
              {languageError ? (
                <p className="text-xs text-error" role="alert" aria-live="polite">
                  {languageError}
                </p>
              ) : null}
            </fieldset>
          </section>

          <ShortcutsSettingsSection />
          {isTauriRuntime() ? <BackupSettingsSection /> : null}
        </div>
      </ScrollArea>
    </PageLayout>
  );
}

/** Configuration JSON export/import; dialogs live in configurationTransfer helpers. */
function BackupSettingsSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"export" | "import" | null>(null);

  async function handleExport() {
    if (busy) {
      return;
    }
    setBusy("export");
    try {
      const result = await runExportConfigurationToFile();
      if (result.status === "written") {
        toast.success({ title: t("settings.backup.exportSuccess") });
      }
      // cancel: silent per Phase 3 failure table
    } catch (err) {
      toast.error({
        title: t("settings.backup.exportFailed"),
        description: getUserErrorMessage(err, t("settings.backup.exportFailed")),
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleImport() {
    if (busy) {
      return;
    }
    setBusy("import");
    try {
      const result = await runImportConfigurationFromFile("merge");
      if (result.status === "cancelled") {
        return;
      }
      if (result.status === "invalid") {
        const detail = result.preview.validationErrors[0] ?? t("settings.backup.importInvalid");
        toast.error({
          title: t("settings.backup.importInvalid"),
          description: detail,
        });
        return;
      }
      if (result.status === "not_applied") {
        toast.error({ title: t("settings.backup.importNotApplied") });
        return;
      }

      // Activate imported app_settings in this process (DB write alone does not rebind UI/OS).
      await applyImportedAppSettings();

      // Local invalidate covers this webview immediately; QueryEventSync also invalidates
      // provider/model/profile/integration prefixes from backend DATA_* events in every window.
      invalidateAfterConfigurationImport(queryClient);

      const authKind = importAuthWarningKind(result.result.preview);
      if (authKind === "none") {
        toast.success({ title: t("settings.backup.importSuccess") });
      } else {
        const description =
          authKind === "integrations"
            ? t("settings.backup.importNeedsIntegrationAuth")
            : authKind === "both"
              ? t("settings.backup.importNeedsAuthBoth")
              : t("settings.backup.importNeedsAuth");
        toast.success({
          title: t("settings.backup.importSuccess"),
          description,
        });
      }
    } catch (err) {
      toast.error({
        title: t("settings.backup.importFailed"),
        description: getUserErrorMessage(err, t("settings.backup.importFailed")),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={settingsSectionClassName}>
      <div className="flex flex-col gap-3">
        <h2 className="text-body-bold font-bold text-on-surface">{t("settings.backup.title")}</h2>
        <p className="text-body-tight text-neutral">{t("settings.backup.description")}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className={outlineButtonClassName}
            disabled={busy != null}
            onClick={() => {
              void handleExport();
            }}
          >
            {busy === "export" ? t("settings.backup.busyExport") : t("settings.backup.export")}
          </Button>
          <Button
            type="button"
            className={outlineButtonClassName}
            disabled={busy != null}
            onClick={() => {
              void handleImport();
            }}
          >
            {busy === "import" ? t("settings.backup.busyImport") : t("settings.backup.import")}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ShortcutsSettingsSection() {
  const { t } = useTranslation();
  const [shortcuts, setShortcuts] = useState<ShortcutDefinition[]>(() => defaultShortcuts());
  const shortcutsRef = useRef(shortcuts);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const windowsOnly = !isWindowsPlatform();

  const replaceShortcuts = useCallback((next: ShortcutDefinition[]) => {
    shortcutsRef.current = next;
    setShortcuts(next);
  }, []);

  const openShortcut = useMemo(
    () =>
      readShortcut(shortcuts, SHORTCUT_OPEN_QUICK_TRANSLATE, {
        id: SHORTCUT_OPEN_QUICK_TRANSLATE,
        binding: DEFAULT_OPEN_QUICK_TRANSLATE_BINDING,
        enabled: true,
      }),
    [shortcuts],
  );
  const doubleCtrlC = useMemo(
    () =>
      readShortcut(shortcuts, SHORTCUT_DOUBLE_CTRL_C, {
        id: SHORTCUT_DOUBLE_CTRL_C,
        binding: DOUBLE_CTRL_C_BINDING,
        enabled: true,
      }),
    [shortcuts],
  );
  const regionScreenshot = useMemo(
    () =>
      readShortcut(shortcuts, SHORTCUT_REGION_SCREENSHOT, {
        id: SHORTCUT_REGION_SCREENSHOT,
        binding: DEFAULT_REGION_SCREENSHOT_BINDING,
        enabled: true,
      }),
    [shortcuts],
  );
  const screenshotOcr = useMemo(
    () =>
      readShortcut(shortcuts, SHORTCUT_SCREENSHOT_OCR, {
        id: SHORTCUT_SCREENSHOT_OCR,
        binding: DEFAULT_SCREENSHOT_OCR_BINDING,
        enabled: true,
      }),
    [shortcuts],
  );

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const settings = await getAppSettings();
        if (cancelled) {
          return;
        }
        replaceShortcuts(settings.shortcuts.length > 0 ? settings.shortcuts : defaultShortcuts());
        setLoadError(null);
      } catch (err: unknown) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : t("settings.shortcuts.loadFailed"));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [replaceShortcuts, t]);

  const persistShortcuts = useCallback(
    async (previous: ShortcutDefinition[], next: ShortcutDefinition[]) => {
      replaceShortcuts(next);
      setPersistError(null);

      if (!isTauriRuntime()) {
        return;
      }

      setPending(true);
      try {
        const updated = await setAppShortcuts(next);
        replaceShortcuts(updated.shortcuts);
      } catch (err: unknown) {
        replaceShortcuts(previous);
        setPersistError(err instanceof Error ? err.message : t("settings.shortcuts.persistFailed"));
      } finally {
        setPending(false);
      }
    },
    [replaceShortcuts, t],
  );

  const updateEntry = useCallback(
    (id: string, patch: Partial<ShortcutDefinition>) => {
      const previous = shortcutsRef.current;
      const next = previous.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
      // Ensure known ids always exist when patching a missing entry.
      if (!next.some((entry) => entry.id === id)) {
        const fallback = defaultShortcuts().find((entry) => entry.id === id);
        if (fallback) {
          next.push({ ...fallback, ...patch });
        }
      }
      void persistShortcuts(previous, next);
    },
    [persistShortcuts],
  );

  useEffect(() => {
    if (!recordingId) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setRecordingId(null);
        return;
      }

      const binding = keyboardEventToBinding(event);
      if (!binding) {
        return;
      }

      const targetId = recordingId;
      setRecordingId(null);
      updateEntry(targetId, { binding, enabled: true });
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [recordingId, updateEntry]);

  return (
    <section className={settingsSectionClassName}>
      <fieldset className="flex flex-col gap-4 border-0 p-0" disabled={pending}>
        <legend className="float-left w-full text-body-bold font-bold text-on-surface">
          {t("settings.shortcuts.title")}
        </legend>
        <p id="settings-shortcuts-desc" className="clear-both text-body-tight text-neutral">
          {t("settings.shortcuts.description")}
        </p>

        <div className="flex flex-col gap-1 border border-line p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-body-tight font-bold text-on-surface">{t("settings.shortcuts.doubleCtrlC.title")}</p>
              <p className="mt-1 text-body-tight text-neutral">{t("settings.shortcuts.doubleCtrlC.description")}</p>
              {windowsOnly ? <p className="mt-1 text-xs text-neutral">{t("settings.shortcuts.windowsOnly")}</p> : null}
            </div>
            <Switch.Root
              checked={doubleCtrlC.enabled}
              disabled={pending || windowsOnly}
              onCheckedChange={(checked) => {
                updateEntry(SHORTCUT_DOUBLE_CTRL_C, {
                  enabled: checked,
                  binding: DOUBLE_CTRL_C_BINDING,
                });
              }}
              className={switchRootClassName}
              aria-label={t("settings.shortcuts.doubleCtrlC.enableAria")}
            >
              <Switch.Thumb className={switchThumbClassName} />
            </Switch.Root>
          </div>
          <p className="text-xs text-neutral">{formatShortcutBinding(DOUBLE_CTRL_C_BINDING)} × 2</p>
        </div>

        <div className="flex flex-col gap-2 border border-line p-3">
          <div className="min-w-0">
            <p className="text-body-tight font-bold text-on-surface">
              {t("settings.shortcuts.openQuickTranslate.title")}
            </p>
            <p className="mt-1 text-body-tight text-neutral">
              {t("settings.shortcuts.openQuickTranslate.description")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`
                ${inputClassName}
                min-w-40 flex-1 cursor-default text-left
                ${recordingId === SHORTCUT_OPEN_QUICK_TRANSLATE ? `outline-2 -outline-offset-1 outline-on-surface` : ""}
              `}
              onClick={() => {
                setRecordingId(SHORTCUT_OPEN_QUICK_TRANSLATE);
              }}
              disabled={pending}
              aria-label={t("settings.shortcuts.openQuickTranslate.recordAria")}
              aria-pressed={recordingId === SHORTCUT_OPEN_QUICK_TRANSLATE}
            >
              {recordingId === SHORTCUT_OPEN_QUICK_TRANSLATE
                ? t("settings.shortcuts.openQuickTranslate.recording")
                : formatShortcutBinding(openShortcut.binding)}
            </button>
            <Button
              type="button"
              className={outlineButtonClassName}
              disabled={pending || openShortcut.binding === DEFAULT_OPEN_QUICK_TRANSLATE_BINDING}
              aria-label={t("settings.shortcuts.openQuickTranslate.resetAria")}
              onClick={() => {
                setRecordingId(null);
                updateEntry(SHORTCUT_OPEN_QUICK_TRANSLATE, {
                  binding: DEFAULT_OPEN_QUICK_TRANSLATE_BINDING,
                  enabled: true,
                });
              }}
            >
              {t("settings.shortcuts.openQuickTranslate.reset")}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2 border border-line p-3">
          <div className="min-w-0">
            <p className="text-body-tight font-bold text-on-surface">
              {t("settings.shortcuts.regionScreenshot.title")}
            </p>
            <p className="mt-1 text-body-tight text-neutral">{t("settings.shortcuts.regionScreenshot.description")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`
                ${inputClassName}
                min-w-40 flex-1 cursor-default text-left
                ${recordingId === SHORTCUT_REGION_SCREENSHOT ? `outline-2 -outline-offset-1 outline-on-surface` : ""}
              `}
              onClick={() => {
                setRecordingId(SHORTCUT_REGION_SCREENSHOT);
              }}
              disabled={pending}
              aria-label={t("settings.shortcuts.regionScreenshot.recordAria")}
              aria-pressed={recordingId === SHORTCUT_REGION_SCREENSHOT}
            >
              {recordingId === SHORTCUT_REGION_SCREENSHOT
                ? t("settings.shortcuts.regionScreenshot.recording")
                : formatShortcutBinding(regionScreenshot.binding)}
            </button>
            <Button
              type="button"
              className={outlineButtonClassName}
              disabled={pending || regionScreenshot.binding === DEFAULT_REGION_SCREENSHOT_BINDING}
              aria-label={t("settings.shortcuts.regionScreenshot.resetAria")}
              onClick={() => {
                setRecordingId(null);
                updateEntry(SHORTCUT_REGION_SCREENSHOT, {
                  binding: DEFAULT_REGION_SCREENSHOT_BINDING,
                  enabled: true,
                });
              }}
            >
              {t("settings.shortcuts.regionScreenshot.reset")}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2 border border-line p-3">
          <div className="min-w-0">
            <p className="text-body-tight font-bold text-on-surface">{t("settings.shortcuts.screenshotOcr.title")}</p>
            <p className="mt-1 text-body-tight text-neutral">{t("settings.shortcuts.screenshotOcr.description")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`
                ${inputClassName}
                min-w-40 flex-1 cursor-default text-left
                ${recordingId === SHORTCUT_SCREENSHOT_OCR ? `outline-2 -outline-offset-1 outline-on-surface` : ""}
              `}
              onClick={() => {
                setRecordingId(SHORTCUT_SCREENSHOT_OCR);
              }}
              disabled={pending}
              aria-label={t("settings.shortcuts.screenshotOcr.recordAria")}
              aria-pressed={recordingId === SHORTCUT_SCREENSHOT_OCR}
            >
              {recordingId === SHORTCUT_SCREENSHOT_OCR
                ? t("settings.shortcuts.screenshotOcr.recording")
                : formatShortcutBinding(screenshotOcr.binding)}
            </button>
            <Button
              type="button"
              className={outlineButtonClassName}
              disabled={pending || screenshotOcr.binding === DEFAULT_SCREENSHOT_OCR_BINDING}
              aria-label={t("settings.shortcuts.screenshotOcr.resetAria")}
              onClick={() => {
                setRecordingId(null);
                updateEntry(SHORTCUT_SCREENSHOT_OCR, {
                  binding: DEFAULT_SCREENSHOT_OCR_BINDING,
                  enabled: true,
                });
              }}
            >
              {t("settings.shortcuts.screenshotOcr.reset")}
            </Button>
          </div>
        </div>

        {loadError ? (
          <p className="text-xs text-error" role="alert" aria-live="polite">
            {loadError}
          </p>
        ) : null}
        {persistError ? (
          <p className="text-xs text-error" role="alert" aria-live="polite">
            {persistError}
          </p>
        ) : null}
      </fieldset>
    </section>
  );
}
