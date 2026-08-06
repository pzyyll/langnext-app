// ABOUTME: Unit tests for the plugin model download Effect workflow Promise runners.
// ABOUTME: Mocks Tauri IPC/Channel; asserts Download/Cancel/progress and query seam inputs.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const invokeMock = mock(async (): Promise<unknown> => {
  throw new Error("invoke not stubbed");
});

class FakeChannel<T> {
  onmessage: ((message: T) => void) | null = null;
  send(message: T) {
    this.onmessage?.(message);
  }
}

mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: FakeChannel,
}));

const { runCancelPluginModelDownload, runDownloadPluginModel, runListPluginModelResources } =
  await import("./pluginModelDownloadFlow");

describe("pluginModelDownloadFlow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("missing list returns sanitized DTOs without download IPC", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      expect(cmd).toBe("list_plugin_model_resources");
      return [
        {
          modelId: "pp-ocrv6-medium",
          version: "1.0.0",
          modelApiVersion: 1,
          languageSet: "pp-ocrv6-50lang",
          status: "missing",
          expectedDownloadBytes: 139_130_880,
          installedBytes: null,
          licenseLabel: "paddleocr-model-weights",
          errorCode: null,
        },
      ];
    });
    const list = await runListPluginModelResources("instance-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("missing");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  test("download calls download_plugin_model once with instanceId/modelId and Channel", async () => {
    const progressEvents: Array<{ phase: string; operationId: string }> = [];
    invokeMock.mockImplementation(async (cmd: string, args: { input: unknown; progress: FakeChannel<unknown> }) => {
      expect(cmd).toBe("download_plugin_model");
      expect(args.input).toEqual({ instanceId: "instance-1", modelId: "pp-ocrv6-medium" });
      expect(args.progress).toBeInstanceOf(FakeChannel);
      args.progress.send({
        operationId: "op-1",
        modelId: "pp-ocrv6-medium",
        bytesDownloaded: 0,
        totalBytes: 100,
        phase: "starting",
      });
      args.progress.send({
        operationId: "op-1",
        modelId: "pp-ocrv6-medium",
        bytesDownloaded: 100,
        totalBytes: 100,
        phase: "ready",
      });
      return {
        modelId: "pp-ocrv6-medium",
        version: "1.0.0",
        modelApiVersion: 1,
        languageSet: "pp-ocrv6-50lang",
        status: "ready",
        expectedDownloadBytes: 100,
        installedBytes: 90,
        licenseLabel: "paddleocr-model-weights",
        errorCode: null,
      };
    });

    const result = await runDownloadPluginModel(
      { instanceId: "instance-1", modelId: "pp-ocrv6-medium" },
      {
        onProgress: (p) => progressEvents.push({ phase: p.phase, operationId: p.operationId }),
      },
    );
    expect(result.status).toBe("ready");
    expect(progressEvents[0]?.operationId).toBe("op-1");
    expect(progressEvents.some((e) => e.phase === "ready")).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  test("cancel uses Channel-provided operationId", async () => {
    invokeMock.mockImplementation(async (cmd: string, args: { input: unknown }) => {
      expect(cmd).toBe("cancel_plugin_model_download");
      expect(args.input).toEqual({
        instanceId: "instance-1",
        modelId: "pp-ocrv6-medium",
        operationId: "op-1",
      });
      return undefined;
    });
    await runCancelPluginModelDownload({
      instanceId: "instance-1",
      modelId: "pp-ocrv6-medium",
      operationId: "op-1",
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  test("download failure rejects so panel onSettled can invalidate stale Query cache", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("model_failed");
    });
    await expect(
      runDownloadPluginModel({ instanceId: "instance-1", modelId: "pp-ocrv6-medium" }, { onProgress: () => {} }),
    ).rejects.toBeTruthy();
  });
});
