// ABOUTME: Effect workflow for host-owned plugin model status download and cancel.
// ABOUTME: Routes/components call Promise runners; Query remains the DTO cache only.
import { Channel } from "@tauri-apps/api/core";
import { Effect } from "effect";
import { invokeEffect } from "../../storage/invokeEffect";
import { IpcError } from "../../storage/ipcError";
import { runEffectAsPromise } from "../../storage/runStorage";
import type {
  CancelPluginModelDownloadInput,
  DownloadPluginModelInput,
  PluginModelDownloadProgress,
  PluginModelResourceDto,
} from "../../storage/types";

/** IPC: list sanitized model resources for one integration instance. */
export function listPluginModelResourcesEffect(instanceId: string): Effect.Effect<PluginModelResourceDto[], IpcError> {
  return invokeEffect<PluginModelResourceDto[]>("list_plugin_model_resources", { instanceId });
}

export type DownloadPluginModelHandlers = {
  readonly onProgress?: (progress: PluginModelDownloadProgress) => void;
};

/**
 * Explicit model download with Tauri Channel progress.
 * Host resolves URL/digests/caps from the signed package; input is only instanceId + modelId.
 */
export function downloadPluginModelEffect(
  input: DownloadPluginModelInput,
  handlers: DownloadPluginModelHandlers = {},
): Effect.Effect<PluginModelResourceDto, IpcError> {
  return Effect.tryPromise({
    try: async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const channel = new Channel<PluginModelDownloadProgress>();
      channel.onmessage = (progress) => {
        handlers.onProgress?.(progress);
      };
      return await invoke<PluginModelResourceDto>("download_plugin_model", {
        input,
        progress: channel,
      });
    },
    catch: (error) => {
      const message =
        error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : "download_plugin_model failed";
      const code =
        error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "unknown";
      return new IpcError({ code, message });
    },
  });
}

/** Cancel only the matching in-flight download operation. */
export function cancelPluginModelDownloadEffect(input: CancelPluginModelDownloadInput): Effect.Effect<void, IpcError> {
  return invokeEffect<void>("cancel_plugin_model_download", { input });
}

export async function runListPluginModelResources(instanceId: string): Promise<PluginModelResourceDto[]> {
  return runEffectAsPromise(listPluginModelResourcesEffect(instanceId));
}

export async function runDownloadPluginModel(
  input: DownloadPluginModelInput,
  handlers: DownloadPluginModelHandlers = {},
): Promise<PluginModelResourceDto> {
  return runEffectAsPromise(downloadPluginModelEffect(input, handlers));
}

export async function runCancelPluginModelDownload(input: CancelPluginModelDownloadInput): Promise<void> {
  return runEffectAsPromise(cancelPluginModelDownloadEffect(input));
}
