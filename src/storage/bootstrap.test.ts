// ABOUTME: Tests for bootstrapStorage Effect: Tauri path, null-theme migration, browser path.
// ABOUTME: Mocks Tauri invoke only; installs a minimal DOM/localStorage like themeSync tests.
import { beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../test/tauriInvokeMock";
import { isIpcError } from "./ipcError";
import type { AppSettingsDto } from "./types";

installTauriInvokeMock();

const { bootstrapStorage, bootstrapStorageEffect, readThemeCache } = await import("./bootstrap");

function baseSettings(overrides: Partial<AppSettingsDto> = {}): AppSettingsDto {
  return {
    schemaVersion: 1,
    uiLanguage: "en",
    theme: "dark",
    defaultProfileId: null,
    defaultOcrServiceId: null,
    defaultSpeechServiceId: null,
    translation: { autoDetectSource: true, preserveFormatting: true },
    shortcuts: [],
    network: { proxyMode: "system", proxyUrl: null },
    proxyHasCredential: false,
    ...overrides,
  };
}

/** Minimal in-memory localStorage + document/window for bun:test (mirrors themeSync). */
function installDomAndStorage(initialTheme: "light" | "dark" | null = null): void {
  const store = new Map<string, string>();
  if (initialTheme) {
    store.set("langnext-theme", initialTheme);
  }
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

  const documentElement = {
    attributes: new Map<string, string>(),
    style: { colorScheme: "" as string },
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
  };

  const windowLike = {
    localStorage: memoryStorage,
    matchMedia() {
      return { matches: false };
    },
    dispatchEvent() {
      return true;
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: windowLike,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: { documentElement },
    configurable: true,
    writable: true,
  });
}

function setTauriRuntime(enabled: boolean): void {
  const win = globalThis.window as unknown as Record<string, unknown>;
  if (enabled) {
    win.__TAURI_INTERNALS__ = {};
  } else {
    delete win.__TAURI_INTERNALS__;
  }
}

describe("bootstrapStorage", () => {
  beforeEach(() => {
    resetInvokeMock();
    invokeMock.mockImplementation(async () => undefined);
    invokeMock.mockImplementation(async () => undefined);
    installDomAndStorage("light");
  });

  test("browser path applies cache theme/language and returns null without IPC", async () => {
    setTauriRuntime(false);
    const result = await bootstrapStorage();
    expect(result).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  test("Tauri happy path loads settings and applies theme/language", async () => {
    setTauriRuntime(true);
    const settings = baseSettings({ theme: "dark", uiLanguage: "zh-CN" });
    invokeMock.mockResolvedValueOnce(settings);

    const result = await bootstrapStorage();
    expect(result).toEqual(settings);
    expect(invokeMock).toHaveBeenCalledWith("get_app_settings", undefined);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("langnext-theme")).toBe("dark");
  });

  test("null theme migrates once via update_app_settings", async () => {
    setTauriRuntime(true);
    localStorage.setItem("langnext-theme", "light");
    const initial = baseSettings({ theme: null });
    const updated = baseSettings({ theme: "light" });
    invokeMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(updated);

    const result = await bootstrapStorage();
    expect(result?.theme).toBe("light");
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[1]?.[0]).toBe("update_app_settings");
    const args = invokeMock.mock.calls[1]?.[1] as { input: { settings: { theme: string } } };
    expect(args.input.settings.theme).toBe("light");
  });

  test("IPC failure surfaces as IpcError", async () => {
    setTauriRuntime(true);
    invokeMock.mockRejectedValueOnce({ code: "storage_unavailable", message: "db locked" });
    try {
      await bootstrapStorage();
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isIpcError(err)).toBe(true);
      if (isIpcError(err)) {
        expect(err.code).toBe("storage_unavailable");
        expect(err.message).toBe("db locked");
      }
    }
  });

  test("bootstrapStorageEffect is runnable as Effect on browser path", async () => {
    setTauriRuntime(false);
    const either = await Effect.runPromise(Effect.either(bootstrapStorageEffect()));
    expect(either._tag).toBe("Right");
    if (either._tag === "Right") {
      expect(either.right).toBeNull();
    }
  });

  test("readThemeCache falls back to OS theme when unset", () => {
    localStorage.clear();
    expect(readThemeCache()).toBe("light");
  });
});
