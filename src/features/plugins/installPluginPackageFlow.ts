// ABOUTME: Effect workflow for user `.lnplugin` selection, permission preview, and exact-digest install.
// ABOUTME: Routes/components call Promise runners; Query remains the DTO cache only.
import { open } from "@tauri-apps/plugin-dialog";
import { Effect } from "effect";
import { invokeEffect } from "../../storage/invokeEffect";
import type { IpcError } from "../../storage/ipcError";
import { runEffectAsPromise } from "../../storage/runStorage";
import type { InstallUserPackageInput, InstallUserPackageResult, UserPackagePreviewDto } from "../../storage/types";
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

/** IPC: inspect a local user archive path (Rust owns reading and validation). */
export function previewUserPluginPackageEffect(path: string): Effect.Effect<UserPackagePreviewDto, IpcError> {
  return invokeEffect<UserPackagePreviewDto>("preview_user_plugin_package", { path });
}

/** IPC: install the previewed archive by opaque preview ID plus the exact content digest. */
export function installUserPluginPackageEffect(
  input: InstallUserPackageInput,
): Effect.Effect<InstallUserPackageResult, IpcError> {
  return invokeEffect<InstallUserPackageResult>("install_user_plugin_package", { input });
}

/** IPC: discard a preview without installing. */
export function discardUserPluginPackagePreviewEffect(previewId: string): Effect.Effect<void, IpcError> {
  return invokeEffect<void>("discard_user_plugin_package_preview", { previewId });
}

/**
 * Dialog → preview composition: open file picker, then inspect if selected.
 * Cancel returns null without IPC. Dialog failures are `FsError`; preview failures are `IpcError`.
 */
export function selectAndPreviewUserPluginPackage(): Effect.Effect<UserPackagePreviewDto | null, FsError | IpcError> {
  return Effect.gen(function* () {
    const selected = yield* selectPluginPackageFile();
    if (selected.status === "cancelled") {
      return null;
    }
    return yield* previewUserPluginPackageEffect(selected.path);
  });
}

/** Promise runner for routes/components (Query-friendly). */
export async function runSelectAndPreviewUserPluginPackage(): Promise<UserPackagePreviewDto | null> {
  return runEffectAsPromise(selectAndPreviewUserPluginPackage());
}

export async function runInstallUserPluginPackage(input: InstallUserPackageInput): Promise<InstallUserPackageResult> {
  return runEffectAsPromise(installUserPluginPackageEffect(input));
}

export async function runDiscardUserPluginPackagePreview(previewId: string): Promise<void> {
  return runEffectAsPromise(discardUserPluginPackagePreviewEffect(previewId));
}
