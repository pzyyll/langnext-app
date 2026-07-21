// ABOUTME: Tests for configuration export/import IPC and file transfer pipelines.
// ABOUTME: Mocks invoke + dialog/fs; never asserts on secret-bearing payloads.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { isIpcError } from "../../storage/ipcError";
import type { ConfigurationExport, ImportPreview, ImportResult } from "../../storage/types";
import { isFsError } from "../fsError";

const invokeMock = mock<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => undefined);
const saveMock = mock(async (): Promise<string | null> => null);
const openMock = mock(async (): Promise<string | null> => null);
const writeTextFileMock = mock(async (path: string, data: string): Promise<void> => {
  void path;
  void data;
});
const readTextFileMock = mock(async (path: string): Promise<string> => {
  void path;
  return "";
});

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

mock.module("@tauri-apps/plugin-dialog", () => ({
  save: () => saveMock(),
  open: () => openMock(),
}));

mock.module("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (path: string, data: string) => writeTextFileMock(path, data),
  readTextFile: (path: string) => readTextFileMock(path),
}));

const {
  exportConfigurationDocument,
  previewConfigurationImportDocument,
  importConfigurationDocument,
  parseConfigurationExportJson,
  exportConfigurationToFile,
  importConfigurationFromFile,
  runExportConfigurationToFile,
  runImportConfigurationFromFile,
} = await import("./configurationTransfer");

function sampleDocument(): ConfigurationExport {
  return {
    formatVersion: 1,
    exportedAt: "2026-01-01T00:00:00Z",
    providers: [],
    models: [],
    translationProfiles: [],
    profileModels: [],
    profilePromptTemplates: [],
    appSettings: {
      schemaVersion: 1,
      uiLanguage: "en",
      theme: "light",
      defaultProfileId: null,
      defaultOcrServiceId: null,
      translation: { autoDetectSource: true, preserveFormatting: true },
      shortcuts: [],
      network: { proxyMode: "system", proxyUrl: null },
    },
  };
}

function validPreview(): ImportPreview {
  return {
    valid: true,
    counts: {
      providersCreate: 0,
      providersUpdate: 0,
      providersCopy: 0,
      modelsCreate: 0,
      modelsUpdate: 0,
      modelsCopy: 0,
      profilesCreate: 0,
      profilesUpdate: 0,
      profilesCopy: 0,
    },
    validationErrors: [],
    requiresAuthentication: [],
    proxyRequiresAuthentication: false,
    defaultProfileCleared: false,
  };
}

describe("parseConfigurationExportJson", () => {
  test("accepts a minimal valid document shape", () => {
    const doc = parseConfigurationExportJson(JSON.stringify(sampleDocument()));
    expect(doc.formatVersion).toBe(1);
  });

  test("rejects invalid JSON with FsError parse", () => {
    expect(() => parseConfigurationExportJson("{")).toThrow();
    try {
      parseConfigurationExportJson("{");
    } catch (error) {
      expect(isFsError(error)).toBe(true);
      if (isFsError(error)) {
        expect(error.operation).toBe("parse");
      }
    }
  });

  test("rejects missing formatVersion", () => {
    expect(() => parseConfigurationExportJson(JSON.stringify({ providers: [], models: [] }))).toThrow();
  });
});

describe("configuration IPC helpers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("exportConfigurationDocument invokes export_configuration", async () => {
    const doc = sampleDocument();
    invokeMock.mockResolvedValueOnce(doc);
    const result = await Effect.runPromise(exportConfigurationDocument());
    expect(result).toEqual(doc);
    expect(invokeMock).toHaveBeenCalledWith("export_configuration", undefined);
  });

  test("preview failure surfaces validation_failed as IpcError", async () => {
    invokeMock.mockRejectedValueOnce({ code: "validation_failed", message: "bad doc" });
    const either = await Effect.runPromise(
      Effect.either(previewConfigurationImportDocument(sampleDocument(), "merge")),
    );
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(isIpcError(either.left)).toBe(true);
      expect(either.left.code).toBe("validation_failed");
      expect(either.left.message).toBe("bad doc");
    }
  });

  test("importConfigurationDocument forwards mode", async () => {
    const result: ImportResult = { preview: validPreview(), applied: true };
    invokeMock.mockResolvedValueOnce(result);
    const out = await Effect.runPromise(importConfigurationDocument(sampleDocument(), "copy"));
    expect(out.applied).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("import_configuration", {
      document: sampleDocument(),
      mode: "copy",
    });
  });
});

describe("exportConfigurationToFile", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveMock.mockReset();
    writeTextFileMock.mockReset();
  });

  test("cancel after IPC export returns cancelled", async () => {
    invokeMock.mockResolvedValueOnce(sampleDocument());
    saveMock.mockResolvedValueOnce(null);
    const result = await runExportConfigurationToFile();
    expect(result).toEqual({ status: "cancelled" });
    expect(writeTextFileMock).not.toHaveBeenCalled();
  });

  test("write success returns written", async () => {
    invokeMock.mockResolvedValueOnce(sampleDocument());
    saveMock.mockResolvedValueOnce("/tmp/cfg.json");
    writeTextFileMock.mockResolvedValueOnce(undefined);
    const result = await runExportConfigurationToFile();
    expect(result).toEqual({ status: "written" });
    expect(writeTextFileMock).toHaveBeenCalledTimes(1);
  });

  test("write failure is FsError", async () => {
    invokeMock.mockResolvedValueOnce(sampleDocument());
    saveMock.mockResolvedValueOnce("/tmp/cfg.json");
    writeTextFileMock.mockRejectedValueOnce(new Error("ENOSPC"));
    try {
      await runExportConfigurationToFile();
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(isFsError(error)).toBe(true);
      if (isFsError(error)) {
        expect(error.operation).toBe("write");
      }
    }
  });
});

describe("importConfigurationFromFile", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    readTextFileMock.mockReset();
  });

  test("dialog cancel returns cancelled without IPC", async () => {
    openMock.mockResolvedValueOnce(null);
    const result = await runImportConfigurationFromFile("merge");
    expect(result).toEqual({ status: "cancelled" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("invalid preview does not call import", async () => {
    openMock.mockResolvedValueOnce("/tmp/in.json");
    readTextFileMock.mockResolvedValueOnce(JSON.stringify(sampleDocument()));
    const invalid = { ...validPreview(), valid: false, validationErrors: ["broken"] };
    invokeMock.mockResolvedValueOnce(invalid); // preview only
    const result = await runImportConfigurationFromFile("merge");
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.preview.validationErrors).toContain("broken");
    }
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe("preview_configuration_import");
  });

  test("valid preview then import success", async () => {
    openMock.mockResolvedValueOnce("/tmp/in.json");
    readTextFileMock.mockResolvedValueOnce(JSON.stringify(sampleDocument()));
    invokeMock.mockResolvedValueOnce(validPreview()).mockResolvedValueOnce({
      preview: validPreview(),
      applied: true,
    } satisfies ImportResult);
    const result = await runImportConfigurationFromFile("merge");
    expect(result.status).toBe("applied");
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[1]?.[0]).toBe("import_configuration");
  });

  test("valid preview but applied false maps to not_applied", async () => {
    openMock.mockResolvedValueOnce("/tmp/in.json");
    readTextFileMock.mockResolvedValueOnce(JSON.stringify(sampleDocument()));
    invokeMock.mockResolvedValueOnce(validPreview()).mockResolvedValueOnce({
      preview: validPreview(),
      applied: false,
    } satisfies ImportResult);
    const result = await runImportConfigurationFromFile("merge");
    expect(result.status).toBe("not_applied");
  });

  test("Effect either for full pipeline", async () => {
    openMock.mockResolvedValueOnce(null);
    const either = await Effect.runPromise(Effect.either(importConfigurationFromFile("merge")));
    expect(either._tag).toBe("Right");
  });

  test("export Effect either cancel path", async () => {
    invokeMock.mockResolvedValueOnce(sampleDocument());
    saveMock.mockResolvedValueOnce(null);
    const either = await Effect.runPromise(Effect.either(exportConfigurationToFile()));
    expect(either._tag).toBe("Right");
    if (either._tag === "Right") {
      expect(either.right.status).toBe("cancelled");
    }
  });
});
