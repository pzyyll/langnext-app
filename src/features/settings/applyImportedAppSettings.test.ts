// ABOUTME: Tests for post-import app settings rebind (theme, language, shortcuts).
// ABOUTME: Mocks storage client, theme DOM apply, and i18n; never logs settings blobs.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppSettingsDto, ShortcutDefinition } from "../../storage/types";

const getAppSettingsMock = mock(async (): Promise<AppSettingsDto> => baseSettings());
const setAppShortcutsMock = mock(async (shortcuts: ShortcutDefinition[]): Promise<AppSettingsDto> => {
  return baseSettings({ shortcuts });
});
const applyThemeToDomMock = mock((mode: "light" | "dark"): void => {
  void mode;
});
const applyAppLanguageMock = mock(async (language: string): Promise<void> => {
  void language;
});

mock.module("../../storage/client", () => ({
  getAppSettings: () => getAppSettingsMock(),
  setAppShortcuts: (shortcuts: ShortcutDefinition[]) => setAppShortcutsMock(shortcuts),
}));

mock.module("../../theme/theme", () => ({
  isThemeMode: (value: string | null | undefined): value is "light" | "dark" =>
    value === "light" || value === "dark",
  applyThemeToDom: (mode: "light" | "dark") => applyThemeToDomMock(mode),
}));

mock.module("../../i18n", () => ({
  applyAppLanguage: (language: string) => applyAppLanguageMock(language),
}));

const { applyImportedAppSettings } = await import("./applyImportedAppSettings");

const sampleShortcuts: ShortcutDefinition[] = [
  { id: "open_quick_translate", binding: "CommandOrControl+Shift+T", enabled: true },
];

function baseSettings(overrides: Partial<AppSettingsDto> = {}): AppSettingsDto {
  return {
    schemaVersion: 1,
    uiLanguage: "en",
    theme: "light",
    defaultProfileId: null,
    defaultOcrServiceId: null,
    translation: { autoDetectSource: true, preserveFormatting: true },
    shortcuts: sampleShortcuts,
    network: { proxyMode: "system", proxyUrl: null },
    proxyHasCredential: false,
    ...overrides,
  };
}

describe("applyImportedAppSettings", () => {
  beforeEach(() => {
    getAppSettingsMock.mockReset();
    setAppShortcutsMock.mockReset();
    applyThemeToDomMock.mockReset();
    applyAppLanguageMock.mockReset();

    getAppSettingsMock.mockImplementation(async () => baseSettings());
    setAppShortcutsMock.mockImplementation(async (shortcuts) => baseSettings({ shortcuts }));
    applyThemeToDomMock.mockImplementation(() => undefined);
    applyAppLanguageMock.mockImplementation(async () => undefined);
  });

  test("happy path applies theme, language, and shortcuts once", async () => {
    const settings = baseSettings({
      theme: "light",
      uiLanguage: "zh-CN",
      shortcuts: sampleShortcuts,
    });
    getAppSettingsMock.mockImplementation(async () => settings);

    const result = await applyImportedAppSettings();

    expect(result).toEqual(settings);
    expect(getAppSettingsMock).toHaveBeenCalledTimes(1);
    expect(applyThemeToDomMock).toHaveBeenCalledTimes(1);
    expect(applyThemeToDomMock).toHaveBeenCalledWith("light");
    expect(applyAppLanguageMock).toHaveBeenCalledTimes(1);
    expect(applyAppLanguageMock).toHaveBeenCalledWith("zh-CN");
    expect(setAppShortcutsMock).toHaveBeenCalledTimes(1);
    expect(setAppShortcutsMock).toHaveBeenCalledWith(sampleShortcuts);
  });

  test("null theme skips DOM theme apply; language and shortcuts still run", async () => {
    getAppSettingsMock.mockImplementation(async () =>
      baseSettings({ theme: null, uiLanguage: "en", shortcuts: sampleShortcuts }),
    );

    await applyImportedAppSettings();

    expect(applyThemeToDomMock).not.toHaveBeenCalled();
    expect(applyAppLanguageMock).toHaveBeenCalledTimes(1);
    expect(applyAppLanguageMock).toHaveBeenCalledWith("en");
    expect(setAppShortcutsMock).toHaveBeenCalledTimes(1);
    expect(setAppShortcutsMock).toHaveBeenCalledWith(sampleShortcuts);
  });

  test("non-mode theme string skips DOM theme apply", async () => {
    getAppSettingsMock.mockImplementation(async () =>
      baseSettings({ theme: "system" as unknown as AppSettingsDto["theme"] }),
    );

    await applyImportedAppSettings();

    expect(applyThemeToDomMock).not.toHaveBeenCalled();
    expect(applyAppLanguageMock).toHaveBeenCalledTimes(1);
    expect(setAppShortcutsMock).toHaveBeenCalledTimes(1);
  });

  test("getAppSettings rejection skips language and shortcuts", async () => {
    const failure = new Error("settings unavailable");
    getAppSettingsMock.mockImplementation(async () => {
      throw failure;
    });

    await expect(applyImportedAppSettings()).rejects.toBe(failure);
    expect(applyThemeToDomMock).not.toHaveBeenCalled();
    expect(applyAppLanguageMock).not.toHaveBeenCalled();
    expect(setAppShortcutsMock).not.toHaveBeenCalled();
  });

  test("setAppShortcuts rejection after theme/language is best-effort partial apply", async () => {
    const failure = new Error("shortcut apply failed");
    setAppShortcutsMock.mockImplementation(async () => {
      throw failure;
    });

    await expect(applyImportedAppSettings()).rejects.toBe(failure);
    expect(applyThemeToDomMock).toHaveBeenCalledTimes(1);
    expect(applyAppLanguageMock).toHaveBeenCalledTimes(1);
    expect(setAppShortcutsMock).toHaveBeenCalledTimes(1);
  });
});
