// ABOUTME: Pure dialog state contract for the configuration import preview workflow.
// ABOUTME: The Base UI dialog renders and dispatches only through this state machine.
import type { ImportConflictMode, ImportPreview, ImportResult } from "../../storage/types";
import type { ApplyConfigurationImportResult, PrepareConfigurationImportResult } from "./configurationTransfer";

/** Phases of the import preview dialog. */
export type ImportPreviewDialogPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "invalid"; readonly preview: ImportPreview }
  | { readonly kind: "previewed"; readonly preview: ImportPreview }
  | { readonly kind: "applying" }
  | { readonly kind: "applied"; readonly result: ImportResult }
  | { readonly kind: "not_applied"; readonly result: ImportResult }
  | { readonly kind: "conflict"; readonly conflictKind: "stale" | "expired" }
  | { readonly kind: "error"; readonly message: string };

/** Immutable dialog state; every transition returns a new state. */
export interface ConfigurationImportPreviewState {
  readonly open: boolean;
  readonly mode: ImportConflictMode;
  readonly phase: ImportPreviewDialogPhase;
}

export const initialImportPreviewDialogState: ConfigurationImportPreviewState = {
  open: false,
  mode: "merge",
  phase: { kind: "idle" },
};

/** Open the dialog; the previous preview (if any) is discarded. */
export function openImportPreviewDialog(state: ConfigurationImportPreviewState): ConfigurationImportPreviewState {
  return { open: true, mode: state.mode, phase: { kind: "idle" } };
}

/** Close the dialog and reset everything. */
export function closeImportPreviewDialog(state: ConfigurationImportPreviewState): ConfigurationImportPreviewState {
  void state;
  return initialImportPreviewDialogState;
}

/** Select Merge/Copy. Mode changes invalidate any existing preview (it is mode-bound). */
export function selectImportPreviewMode(
  state: ConfigurationImportPreviewState,
  mode: ImportConflictMode,
): ConfigurationImportPreviewState {
  if (state.mode === mode || state.phase.kind === "loading" || state.phase.kind === "applying") {
    return state;
  }
  return { ...state, mode, phase: { kind: "idle" } };
}

/** Start loading + previewing a file. Allowed from idle/invalid/previewed/conflict/error. */
export function startImportPreviewLoad(state: ConfigurationImportPreviewState): ConfigurationImportPreviewState {
  if (state.phase.kind === "loading" || state.phase.kind === "applying") {
    return state;
  }
  return { ...state, phase: { kind: "loading" } };
}

/** Apply the result of `prepareConfigurationImportFromFile`. */
export function finishImportPreviewLoad(
  state: ConfigurationImportPreviewState,
  result: PrepareConfigurationImportResult,
): ConfigurationImportPreviewState {
  if (state.phase.kind !== "loading") {
    return state;
  }
  switch (result.status) {
    case "cancelled":
      return { ...state, phase: { kind: "idle" } };
    case "invalid":
      return { ...state, phase: { kind: "invalid", preview: result.preview } };
    case "prepared":
      return { ...state, phase: { kind: "previewed", preview: result.preview } };
  }
}

/** Start applying the prepared preview. Only valid prepared previews can apply. */
export function startImportApply(state: ConfigurationImportPreviewState): ConfigurationImportPreviewState {
  if (state.phase.kind !== "previewed" || !canApplyImportPreview(state)) {
    return state;
  }
  return { ...state, phase: { kind: "applying" } };
}

/** Apply the result of `applyPreparedConfigurationImport`. */
export function finishImportApply(
  state: ConfigurationImportPreviewState,
  result: ApplyConfigurationImportResult,
): ConfigurationImportPreviewState {
  if (state.phase.kind !== "applying") {
    return state;
  }
  switch (result.status) {
    case "applied":
      return { ...state, phase: { kind: "applied", result: result.result } };
    case "not_applied":
      return { ...state, phase: { kind: "not_applied", result: result.result } };
    case "conflict":
      return { ...state, phase: { kind: "conflict", conflictKind: result.conflictKind } };
  }
}

/** Map an IpcError/FsError from load/preview/apply into the error phase. */
export function failImportPreview(
  state: ConfigurationImportPreviewState,
  message: string,
): ConfigurationImportPreviewState {
  if (state.phase.kind !== "loading" && state.phase.kind !== "applying") {
    return state;
  }
  return { ...state, phase: { kind: "error", message } };
}

/** True when Apply is enabled: a valid prepared preview with an opaque preview id. */
export function canApplyImportPreview(state: ConfigurationImportPreviewState): boolean {
  return (
    state.phase.kind === "previewed" && state.phase.preview.valid && (state.phase.preview.previewId ?? "").length > 0
  );
}
