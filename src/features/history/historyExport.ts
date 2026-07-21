// ABOUTME: Save-dialog + writeTextFile helper for exporting history rows to CSV.
// ABOUTME: Dialog cancel is non-throwing DialogSaveResult; write failures surface as FsError.
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Effect } from "effect";
import { runEffectAsPromise } from "../../storage/runStorage";
import type { TranslationHistoryDto } from "../../storage/types";
import type { DialogSaveResult } from "../dialogResult";
import { type FsError, toFsError } from "../fsError";
import { localFilenameStamp } from "../localFilenameStamp";
import { buildHistoryCsv } from "./historyCsv";

/**
 * Effect program: build CSV, prompt save dialog, write file.
 * Succeeds with `{ status: "cancelled" }` on dialog cancel; fails with `FsError` on
 * write/dialog errors (never maps to IPC codes such as `conflict`).
 */
export function exportHistoryCsvEffect(
  rows: readonly TranslationHistoryDto[],
): Effect.Effect<DialogSaveResult, FsError> {
  return Effect.gen(function* () {
    const csv = buildHistoryCsv(rows);
    const defaultPath = `langnext-history-${localFilenameStamp()}.csv`;

    const filePath = yield* Effect.tryPromise({
      try: () =>
        save({
          defaultPath,
          filters: [{ name: "CSV", extensions: ["csv"] }],
        }),
      catch: (error) => toFsError("dialog", error, "save dialog failed"),
    });

    if (!filePath) {
      // User cancelled the save dialog: silent no-op.
      return { status: "cancelled" as const };
    }

    yield* Effect.tryPromise({
      try: () => writeTextFile(filePath, csv),
      catch: (error) => toFsError("write", error, "write failed"),
    });

    return { status: "written" as const };
  });
}

/**
 * Open a system save dialog and write the given history rows as a UTF-8 BOM CSV.
 *
 * @returns `{ status: "written" }` when a file was written; `{ status: "cancelled" }`
 *   when the user cancelled the save dialog (no error). Throws `FsError` only on
 *   filesystem/dialog failures.
 */
export function exportHistoryCsv(rows: readonly TranslationHistoryDto[]): Promise<DialogSaveResult> {
  // Reject with raw FsError (not FiberFailure) so UI helpers can read `.message`.
  return runEffectAsPromise(exportHistoryCsvEffect(rows));
}
