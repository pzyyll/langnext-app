// ABOUTME: Tests for history CSV export cancel vs write failure channels.
// ABOUTME: Mocks Tauri dialog/fs; pure CSV builder remains covered elsewhere.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { isFsError } from "../fsError";
import type { TranslationHistoryDto } from "../../storage/types";

const saveMock = mock(async (): Promise<string | null> => null);
const writeTextFileMock = mock(async (path: string, data: string): Promise<void> => {
  void path;
  void data;
});

mock.module("@tauri-apps/plugin-dialog", () => ({
  save: () => saveMock(),
  open: async () => null,
}));

mock.module("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (path: string, data: string) => writeTextFileMock(path, data),
  // Provide readTextFile so sibling suite mocks can co-exist when files share a process.
  readTextFile: async () => "",
}));

const { exportHistoryCsv, exportHistoryCsvEffect } = await import("./historyExport");

const sampleRow: TranslationHistoryDto = {
  id: "h1",
  createdAt: "2026-01-01T00:00:00Z",
  sourceText: "hello",
  translatedText: "你好",
  sourceLang: "en",
  targetLang: "zh",
  effectiveSourceLang: "en",
  effectiveTargetLang: "zh",
  modelId: "m1",
  modelDisplayName: "Model",
  providerDisplayName: "Provider",
  profileId: null,
  profileName: null,
  status: "complete",
  errorCode: null,
  errorMessage: null,
  latencyMs: 10,
};

describe("exportHistoryCsv", () => {
  beforeEach(() => {
    saveMock.mockReset();
    writeTextFileMock.mockReset();
  });

  test("dialog cancel returns false without writing", async () => {
    saveMock.mockResolvedValueOnce(null);
    const written = await exportHistoryCsv([sampleRow]);
    expect(written).toBe(false);
    expect(writeTextFileMock).not.toHaveBeenCalled();
  });

  test("write success returns true", async () => {
    saveMock.mockResolvedValueOnce("/tmp/out.csv");
    writeTextFileMock.mockResolvedValueOnce(undefined);
    const written = await exportHistoryCsv([sampleRow]);
    expect(written).toBe(true);
    expect(writeTextFileMock).toHaveBeenCalledTimes(1);
    const [path, body] = writeTextFileMock.mock.calls[0] ?? [];
    expect(path).toBe("/tmp/out.csv");
    expect(typeof body).toBe("string");
    expect(body).toContain("hello");
  });

  test("write failure rejects with FsError (not IPC codes)", async () => {
    saveMock.mockResolvedValueOnce("/tmp/out.csv");
    writeTextFileMock.mockRejectedValueOnce(new Error("disk full"));
    try {
      await exportHistoryCsv([sampleRow]);
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(isFsError(error)).toBe(true);
      if (isFsError(error)) {
        expect(error.operation).toBe("write");
        expect(error.message).toContain("disk full");
        expect(error._tag).toBe("FsError");
      }
    }
  });

  test("dialog failure rejects with FsError operation dialog", async () => {
    saveMock.mockRejectedValueOnce(new Error("dialog crashed"));
    const either = await Effect.runPromise(Effect.either(exportHistoryCsvEffect([sampleRow])));
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(isFsError(either.left)).toBe(true);
      expect(either.left.operation).toBe("dialog");
    }
  });
});
