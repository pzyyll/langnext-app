// ABOUTME: Save-dialog + writeTextFile helper for exporting history rows to CSV.
// ABOUTME: Dialog cancel is non-throwing false; write failures surface as FsError.
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Effect, Either } from "effect";
import type { TranslationHistoryDto } from "../../storage/types";
import { type FsError, toFsError } from "../fsError";
import { buildHistoryCsv } from "./historyCsv";

/** Local timestamp for the default export filename: YYYYMMDDTHHMMSS. */
function localFilenameStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Effect program: build CSV, prompt save dialog, write file.
 * Succeeds with `false` on dialog cancel; fails with `FsError` on write/dialog errors
 * (never maps to IPC codes such as `conflict`).
 */
export function exportHistoryCsvEffect(
  rows: readonly TranslationHistoryDto[],
): Effect.Effect<boolean, FsError> {
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
      return false;
    }

    yield* Effect.tryPromise({
      try: () => writeTextFile(filePath, csv),
      catch: (error) => toFsError("write", error, "write failed"),
    });

    return true;
  });
}

/**
 * Open a system save dialog and write the given history rows as a UTF-8 BOM CSV.
 *
 * @returns `true` when a file was written; `false` when the user cancelled the
 *   save dialog (no error). Throws `FsError` only on filesystem/dialog failures.
 */
export async function exportHistoryCsv(rows: readonly TranslationHistoryDto[]): Promise<boolean> {
  // Reject with raw FsError (not FiberFailure) so UI helpers can read `.message`.
  const result = await Effect.runPromise(Effect.either(exportHistoryCsvEffect(rows)));
  if (Either.isLeft(result)) {
    throw result.left;
  }
  return result.right;
}
