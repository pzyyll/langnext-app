// ABOUTME: Configuration export/import workflows: IPC steps + native dialog/fs.
// ABOUTME: Dialogs live here (not in the route); never logs documents or secrets.
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Effect } from "effect";
import { invokeEffect } from "../../storage/invokeEffect";
import type { IpcError } from "../../storage/ipcError";
import { runEffectAsPromise } from "../../storage/runStorage";
import type { ConfigurationExport, ImportConflictMode, ImportPreview, ImportResult } from "../../storage/types";
import { FsError, toFsError } from "../fsError";

/** Local timestamp for the default export filename: YYYYMMDDTHHMMSS. */
function localFilenameStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** IPC: load full portable configuration document from the backend. */
export function exportConfigurationDocument(): Effect.Effect<ConfigurationExport, IpcError> {
  return invokeEffect<ConfigurationExport>("export_configuration");
}

/** IPC: dry-run import validation and counts. */
export function previewConfigurationImportDocument(
  document: ConfigurationExport,
  mode: ImportConflictMode,
): Effect.Effect<ImportPreview, IpcError> {
  return invokeEffect<ImportPreview>("preview_configuration_import", { document, mode });
}

/** IPC: apply import after preview validation on the backend. */
export function importConfigurationDocument(
  document: ConfigurationExport,
  mode: ImportConflictMode,
): Effect.Effect<ImportResult, IpcError> {
  return invokeEffect<ImportResult>("import_configuration", { document, mode });
}

export type SaveConfigurationResult = { readonly status: "written" } | { readonly status: "cancelled" };

/**
 * Save a configuration document via native save dialog + writeTextFile.
 * Cancel → `{ status: "cancelled" }`; write/dialog failure → `FsError`.
 * Does not log document contents.
 */
export function saveConfigurationDocumentToFile(
  document: ConfigurationExport,
): Effect.Effect<SaveConfigurationResult, FsError> {
  return Effect.gen(function* () {
    const defaultPath = `langnext-config-${localFilenameStamp()}.json`;
    const filePath = yield* Effect.tryPromise({
      try: () =>
        save({
          defaultPath,
          filters: [{ name: "JSON", extensions: ["json"] }],
        }),
      catch: (error) => toFsError("dialog", error, "save dialog failed"),
    });

    if (!filePath) {
      return { status: "cancelled" as const };
    }

    const body = JSON.stringify(document, null, 2);
    yield* Effect.tryPromise({
      try: () => writeTextFile(filePath, body),
      catch: (error) => toFsError("write", error, "write failed"),
    });

    return { status: "written" as const };
  });
}

export type LoadConfigurationResult =
  { readonly status: "loaded"; readonly document: ConfigurationExport } | { readonly status: "cancelled" };

/** Structural check for a configuration export document (not full schema validation). */
export function parseConfigurationExportJson(raw: string): ConfigurationExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw toFsError("parse", error, "invalid JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new FsError({ operation: "parse", message: "configuration root must be an object" });
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.formatVersion !== "number") {
    throw new FsError({ operation: "parse", message: "missing formatVersion" });
  }
  if (!Array.isArray(record.providers) || !Array.isArray(record.models)) {
    throw new FsError({ operation: "parse", message: "missing providers or models arrays" });
  }
  return parsed as ConfigurationExport;
}

/**
 * Open a file dialog, read JSON, and parse a configuration export.
 * Cancel → `{ status: "cancelled" }`; dialog/read/parse failure → `FsError`.
 */
export function loadConfigurationDocumentFromFile(): Effect.Effect<LoadConfigurationResult, FsError> {
  return Effect.gen(function* () {
    const selected = yield* Effect.tryPromise({
      try: () =>
        open({
          multiple: false,
          filters: [{ name: "JSON", extensions: ["json"] }],
        }),
      catch: (error) => toFsError("dialog", error, "open dialog failed"),
    });

    const filePath = typeof selected === "string" ? selected : null;
    if (!filePath) {
      return { status: "cancelled" as const };
    }

    const raw = yield* Effect.tryPromise({
      try: () => readTextFile(filePath),
      catch: (error) => toFsError("read", error, "read failed"),
    });

    const document = yield* Effect.try({
      try: () => parseConfigurationExportJson(raw),
      catch: (error) => toFsError("parse", error, "invalid configuration file"),
    });

    return { status: "loaded" as const, document };
  });
}

export type ExportConfigurationToFileResult = { readonly status: "written" } | { readonly status: "cancelled" };

/**
 * Full export pipeline: IPC export → save dialog → write file.
 * Error channel is `IpcError | FsError`. Cancel is a success variant.
 */
export function exportConfigurationToFile(): Effect.Effect<ExportConfigurationToFileResult, IpcError | FsError> {
  return Effect.gen(function* () {
    const document = yield* exportConfigurationDocument();
    return yield* saveConfigurationDocumentToFile(document);
  });
}

export type ImportConfigurationFromFileResult =
  | { readonly status: "applied"; readonly result: ImportResult }
  | { readonly status: "not_applied"; readonly result: ImportResult }
  | { readonly status: "cancelled" }
  | { readonly status: "invalid"; readonly preview: ImportPreview };

/**
 * Full import pipeline: open dialog → parse → preview → import when valid.
 * Invalid preview does not call import. Cancel is a success variant.
 * Error channel is `IpcError | FsError`.
 */
export function importConfigurationFromFile(
  mode: ImportConflictMode,
): Effect.Effect<ImportConfigurationFromFileResult, IpcError | FsError> {
  return Effect.gen(function* () {
    const loaded = yield* loadConfigurationDocumentFromFile();
    if (loaded.status === "cancelled") {
      return { status: "cancelled" as const };
    }

    const preview = yield* previewConfigurationImportDocument(loaded.document, mode);
    if (!preview.valid) {
      return { status: "invalid" as const, preview };
    }

    const result = yield* importConfigurationDocument(loaded.document, mode);
    if (!result.applied) {
      return { status: "not_applied" as const, result };
    }
    return { status: "applied" as const, result };
  });
}

/** Promise façade: export configuration to a user-chosen JSON file. */
export function runExportConfigurationToFile(): Promise<ExportConfigurationToFileResult> {
  return runEffectAsPromise(exportConfigurationToFile());
}

/** Promise façade: import configuration from a user-chosen JSON file. */
export function runImportConfigurationFromFile(mode: ImportConflictMode): Promise<ImportConfigurationFromFileResult> {
  return runEffectAsPromise(importConfigurationFromFile(mode));
}
