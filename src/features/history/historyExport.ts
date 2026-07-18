// ABOUTME: Save-dialog + writeTextFile helper for exporting history rows to CSV.
// ABOUTME: User-cancel of the system save dialog is a silent no-op.
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { TranslationHistoryDto } from "../../storage/types";
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
 * Open a system save dialog and write the given history rows as a UTF-8 BOM CSV.
 *
 * @returns `true` when a file was written; `false` when the user cancelled the
 *   save dialog (no error). Throws only on filesystem write failures.
 */
export async function exportHistoryCsv(rows: readonly TranslationHistoryDto[]): Promise<boolean> {
  const csv = buildHistoryCsv(rows);
  const defaultPath = `langnext-history-${localFilenameStamp()}.csv`;

  const filePath = await save({
    defaultPath,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });

  if (!filePath) {
    // User cancelled the save dialog: silent no-op.
    return false;
  }

  await writeTextFile(filePath, csv);
  return true;
}
