// ABOUTME: Effect workflow for local `.lnplugin` dialog selection, preview, approve, and discard.
// ABOUTME: Routes/components call Promise runners; Query remains the DTO cache only.
import { open } from "@tauri-apps/plugin-dialog";
import { Effect } from "effect";
import { invokeEffect } from "../../storage/invokeEffect";
import type { IpcError } from "../../storage/ipcError";
import { runEffectAsPromise } from "../../storage/runStorage";
import type {
  ApprovePluginPackageInput,
  ApprovePluginPackageResult,
  PluginPackagePreviewDto,
} from "../../storage/types";
import { FsError, toFsError } from "../fsError";

export type SelectPluginPackageResult =
  | { readonly status: "selected"; readonly path: string }
  | { readonly status: "cancelled" };

/** Native dialog to pick a single `.lnplugin` path. Cancel is a success status. */
export function selectPluginPackageFile(): Effect.Effect<SelectPluginPackageResult, FsError> {
  return Effect.tryPromise({
    try: async () => {
      const selected = await open({
        multiple: false,
        filters: [{ name: "LangNext Plugin", extensions: ["lnplugin"] }],
      });
      if (typeof selected !== "string" || selected.length === 0) {
        return { status: "cancelled" as const };
      }
      return { status: "selected" as const, path: selected };
    },
    catch: (error) => toFsError("dialog", error, "package dialog failed"),
  });
}

/** IPC: preview a local package path (Rust owns reading and verification). */
export function previewPluginPackageEffect(path: string): Effect.Effect<PluginPackagePreviewDto, IpcError> {
  return invokeEffect<PluginPackagePreviewDto>("preview_plugin_package", { path });
}

/** IPC: approve/install by opaque preview id. */
export function approvePluginPackageEffect(
  input: ApprovePluginPackageInput,
): Effect.Effect<ApprovePluginPackageResult, IpcError> {
  return invokeEffect<ApprovePluginPackageResult>("approve_plugin_package", { input });
}

/** IPC: discard a preview and clean staging. */
export function discardPluginPackagePreviewEffect(previewId: string): Effect.Effect<void, IpcError> {
  return invokeEffect<void>("discard_plugin_package_preview", { previewId });
}

/**
 * Dialog → preview composition: open file picker, then preview if selected.
 * Cancel returns null without IPC. Dialog failures are `FsError`; preview failures are `IpcError`.
 */
export function selectAndPreviewPluginPackage(): Effect.Effect<PluginPackagePreviewDto | null, FsError | IpcError> {
  return Effect.gen(function* () {
    const selected = yield* selectPluginPackageFile();
    if (selected.status === "cancelled") {
      return null;
    }
    return yield* previewPluginPackageEffect(selected.path);
  });
}

/** Promise runner for routes/components (Query-friendly). */
export async function runSelectAndPreviewPluginPackage(): Promise<PluginPackagePreviewDto | null> {
  return runEffectAsPromise(selectAndPreviewPluginPackage());
}

export async function runApprovePluginPackage(input: ApprovePluginPackageInput): Promise<ApprovePluginPackageResult> {
  return runEffectAsPromise(approvePluginPackageEffect(input));
}

export async function runDiscardPluginPackagePreview(previewId: string): Promise<void> {
  return runEffectAsPromise(discardPluginPackagePreviewEffect(previewId));
}
