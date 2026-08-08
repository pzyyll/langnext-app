// ABOUTME: Tests for configuration export/import IPC and file transfer pipelines.
// ABOUTME: Mocks invoke + dialog/fs; never asserts on secret-bearing payloads.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { isIpcError } from "../../storage/ipcError";
import type { ConfigurationExport, ImportPreview, ImportResult } from "../../storage/types";
import { isFsError } from "../fsError";

import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../../test/tauriInvokeMock";

installTauriInvokeMock();
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
  applyPreparedConfigurationImport,
  parseConfigurationExportJson,
  runExportConfigurationToFile,
  runPrepareConfigurationImportFromFile,
  runApplyPreparedConfigurationImport,
} = await import("./configurationTransfer");

function sampleDocument(): ConfigurationExport {
  return {
    formatVersion: 7,
    exportedAt: "2026-01-01T00:00:00Z",
    providers: [],
    models: [],
    translationProfiles: [],
    profileModels: [],
    profilePromptTemplates: [],
    integrationInstances: [],
    ocrServices: [],
    ocrPromptTemplates: [],
    speechServices: [],
    appSettings: {
      schemaVersion: 1,
      uiLanguage: "en",
      theme: "light",
      defaultProfileId: null,
      defaultOcrServiceId: null,
      defaultSpeechServiceId: null,
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
      integrationsCreate: 0,
      integrationsUpdate: 0,
      integrationsCopy: 0,
    },
    validationErrors: [],
    requiresAuthentication: [],
    integrationRequiresAuthentication: [],
    proxyRequiresAuthentication: false,
    defaultProfileCleared: false,
    previewId: "cfgimp_test-1",
    runtimeRequirements: [],
  };
}

describe("parseConfigurationExportJson", () => {
  test("accepts a minimal valid document shape", () => {
    const doc = parseConfigurationExportJson(JSON.stringify(sampleDocument()));
    expect(doc.formatVersion).toBe(7);
  });

  test("accepts supported legacy formatVersion 2–6 envelopes", () => {
    for (const formatVersion of [2, 3, 4, 5, 6]) {
      const doc = parseConfigurationExportJson(JSON.stringify({ ...sampleDocument(), formatVersion }));
      expect(doc.formatVersion).toBe(formatVersion);
    }
  });

  test("accepts current format v8 envelopes unchanged", () => {
    const doc = parseConfigurationExportJson(JSON.stringify({ ...sampleDocument(), formatVersion: 8 }));
    expect(doc.formatVersion).toBe(8);
  });

  test("v8 backend export reloads through the parse seam", async () => {
    // The current backend exports format v8; the load seam must accept that exact shape so
    // export → parse → preview round-trips without re-formatting.
    const exported = { ...sampleDocument(), formatVersion: 8 };
    invokeMock.mockResolvedValueOnce(exported);
    const document = await Effect.runPromise(exportConfigurationDocument());
    const reloaded = parseConfigurationExportJson(JSON.stringify(document));
    expect(reloaded).toEqual(exported);
  });

  test("rejects unsupported formatVersion", () => {
    expect(() => parseConfigurationExportJson(JSON.stringify({ ...sampleDocument(), formatVersion: 99 }))).toThrow();
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
    resetInvokeMock();
    invokeMock.mockImplementation(async () => undefined);
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

  test("applyPreparedConfigurationImport sends only the opaque preview id", async () => {
    const result: ImportResult = { preview: validPreview(), applied: true };
    invokeMock.mockResolvedValueOnce(result);
    const out = await runApplyPreparedConfigurationImport("cfgimp_test-1");
    expect(out.status).toBe("applied");
    if (out.status === "applied") {
      expect(out.result.applied).toBe(true);
    }
    expect(invokeMock).toHaveBeenCalledWith("import_configuration", { previewId: "cfgimp_test-1" });
  });

  test("applyPreparedConfigurationImport rejects non-conflict IPC errors", async () => {
    invokeMock.mockRejectedValueOnce({ code: "validation_failed", message: "bad doc" });
    const either = await Effect.runPromise(Effect.either(applyPreparedConfigurationImport("cfgimp_test-1")));
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(isIpcError(either.left)).toBe(true);
      expect(either.left.code).toBe("validation_failed");
    }
  });
});

describe("exportConfigurationToFile", () => {
  beforeEach(() => {
    resetInvokeMock();
    invokeMock.mockImplementation(async () => undefined);
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

describe("prepareConfigurationImportFromFile", () => {
  beforeEach(() => {
    resetInvokeMock();
    invokeMock.mockImplementation(async () => undefined);
    openMock.mockReset();
    readTextFileMock.mockReset();
  });

  test("dialog cancel returns cancelled without IPC", async () => {
    openMock.mockResolvedValueOnce(null);
    const result = await runPrepareConfigurationImportFromFile("merge");
    expect(result.status).toBe("cancelled");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("load + preview returns a prepared preview without calling import_configuration", async () => {
    openMock.mockResolvedValueOnce("/tmp/in.json");
    readTextFileMock.mockResolvedValueOnce(JSON.stringify(sampleDocument()));
    invokeMock.mockResolvedValueOnce(validPreview());
    const result = await runPrepareConfigurationImportFromFile("merge");
    expect(result.status).toBe("prepared");
    if (result.status === "prepared") {
      expect(result.preview.previewId).toBe("cfgimp_test-1");
    }
    // Preparation must never apply; only the backend preview command runs.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe("preview_configuration_import");
  });

  test("invalid preview maps to an explicit invalid variant", async () => {
    openMock.mockResolvedValueOnce("/tmp/in.json");
    readTextFileMock.mockResolvedValueOnce(JSON.stringify(sampleDocument()));
    const invalid = { ...validPreview(), valid: false, validationErrors: ["broken"] };
    invokeMock.mockResolvedValueOnce(invalid); // preview only
    const result = await runPrepareConfigurationImportFromFile("merge");
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.preview.validationErrors).toContain("broken");
    }
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe("preview_configuration_import");
  });
});

describe("applyPreparedConfigurationImport", () => {
  beforeEach(() => {
    resetInvokeMock();
    invokeMock.mockImplementation(async () => undefined);
  });

  test("applied result maps to applied", async () => {
    invokeMock.mockResolvedValueOnce({ preview: validPreview(), applied: true } satisfies ImportResult);
    const result = await runApplyPreparedConfigurationImport("cfgimp_test-1");
    expect(result.status).toBe("applied");
  });

  test("applied false maps to not_applied", async () => {
    invokeMock.mockResolvedValueOnce({ preview: validPreview(), applied: false } satisfies ImportResult);
    const result = await runApplyPreparedConfigurationImport("cfgimp_test-1");
    expect(result.status).toBe("not_applied");
  });

  test("stale conflict maps to conflict with stale kind", async () => {
    invokeMock.mockRejectedValueOnce({
      code: "conflict",
      reason: "stale",
      message: "local state changed since preview; run the preview again",
    });
    const result = await runApplyPreparedConfigurationImport("cfgimp_test-1");
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.conflictKind).toBe("stale");
    }
  });

  test("expired conflict maps to conflict with expired kind via typed reason", async () => {
    // The prose intentionally avoids the old keyword: the reason field, not the
    // message, must drive the retry state.
    invokeMock.mockRejectedValueOnce({
      code: "conflict",
      reason: "expired",
      message: "this preview session is no longer valid",
    });
    const result = await runApplyPreparedConfigurationImport("cfgimp_test-1");
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.conflictKind).toBe("expired");
    }
  });

  test("conflict without reason falls back to stale", async () => {
    invokeMock.mockRejectedValueOnce({
      code: "conflict",
      message: "some older backend wording",
    });
    const result = await runApplyPreparedConfigurationImport("cfgimp_test-1");
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.conflictKind).toBe("stale");
    }
  });

  test("conflict with unknown reason falls back to stale", async () => {
    invokeMock.mockRejectedValueOnce({
      code: "conflict",
      reason: "mystery",
      message: "some other conflict wording",
    });
    const result = await runApplyPreparedConfigurationImport("cfgimp_test-1");
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.conflictKind).toBe("stale");
    }
  });
});
