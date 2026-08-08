// ABOUTME: Pure dialog state transition tests for the configuration import preview.
// ABOUTME: No React or IPC; the dialog component dispatches only through this contract.
import { describe, expect, test } from "bun:test";
import type { ImportPreview, ImportResult } from "../../storage/types";
import {
  canApplyImportPreview,
  closeImportPreviewDialog,
  failImportPreview,
  finishImportApply,
  finishImportPreviewLoad,
  initialImportPreviewDialogState,
  openImportPreviewDialog,
  selectImportPreviewMode,
  startImportApply,
  startImportPreviewLoad,
} from "./configurationImportPreviewState";

function preview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    valid: true,
    counts: {},
    validationErrors: [],
    requiresAuthentication: [],
    integrationRequiresAuthentication: [],
    proxyRequiresAuthentication: false,
    defaultProfileCleared: false,
    previewId: "cfgimp_test-1",
    runtimeRequirements: [],
    ...overrides,
  };
}

function appliedResult(): ImportResult {
  return { preview: preview(), applied: true };
}

describe("configurationImportPreviewState", () => {
  test("starts closed at idle with Merge selected", () => {
    expect(initialImportPreviewDialogState).toEqual({
      open: false,
      mode: "merge",
      phase: { kind: "idle" },
    });
    expect(canApplyImportPreview(initialImportPreviewDialogState)).toBe(false);
  });

  test("open/close transitions", () => {
    const opened = openImportPreviewDialog(initialImportPreviewDialogState);
    expect(opened.open).toBe(true);
    expect(opened.phase).toEqual({ kind: "idle" });
    expect(closeImportPreviewDialog(opened).open).toBe(false);
    expect(closeImportPreviewDialog(opened).phase).toEqual({ kind: "idle" });
  });

  test("mode selection switches Merge/Copy and resets a previewed state", () => {
    let state = openImportPreviewDialog(initialImportPreviewDialogState);
    state = selectImportPreviewMode(state, "copy");
    expect(state.mode).toBe("copy");
    state = startImportPreviewLoad(state);
    state = finishImportPreviewLoad(state, { status: "prepared", preview: preview() });
    expect(state.phase).toEqual({ kind: "previewed", preview: preview() });
    state = selectImportPreviewMode(state, "merge");
    expect(state.mode).toBe("merge");
    expect(state.phase).toEqual({ kind: "idle" }, "mode change invalidates the preview");
    expect(canApplyImportPreview(state)).toBe(false);
  });

  test("load → preview success enables apply", () => {
    let state = openImportPreviewDialog(initialImportPreviewDialogState);
    state = startImportPreviewLoad(state);
    expect(state.phase).toEqual({ kind: "loading" });
    state = finishImportPreviewLoad(state, { status: "prepared", preview: preview() });
    expect(state.phase.kind).toBe("previewed");
    expect(canApplyImportPreview(state)).toBe(true);
  });

  test("invalid preview disables apply", () => {
    let state = openImportPreviewDialog(initialImportPreviewDialogState);
    state = startImportPreviewLoad(state);
    state = finishImportPreviewLoad(state, {
      status: "invalid",
      preview: preview({ valid: false, previewId: "", validationErrors: ["broken"] }),
    });
    expect(state.phase.kind).toBe("invalid");
    expect(canApplyImportPreview(state)).toBe(false);
  });

  test("load failure maps to an error phase", () => {
    let state = openImportPreviewDialog(initialImportPreviewDialogState);
    state = startImportPreviewLoad(state);
    state = failImportPreview(state, "read failed");
    expect(state.phase).toEqual({ kind: "error", message: "read failed" });
    expect(canApplyImportPreview(state)).toBe(false);
  });

  test("apply only from a valid prepared preview", () => {
    let state = openImportPreviewDialog(initialImportPreviewDialogState);
    // Apply from idle is a no-op.
    expect(startImportApply(state).phase.kind).toBe("idle");
    state = startImportPreviewLoad(state);
    state = finishImportPreviewLoad(state, { status: "prepared", preview: preview() });
    state = startImportApply(state);
    expect(state.phase).toEqual({ kind: "applying" });
  });

  test("apply enters applying before any terminal result", () => {
    // The dialog calls startImportApply before awaiting IPC; the sequence below models
    // that contract: previewed → applying must precede every terminal outcome, and
    // `applying` disables further Apply while the host operation is in flight.
    let state = openImportPreviewDialog(initialImportPreviewDialogState);
    state = startImportPreviewLoad(state);
    state = finishImportPreviewLoad(state, { status: "prepared", preview: preview() });

    const applying = startImportApply(state);
    expect(applying.phase).toEqual({ kind: "applying" });
    expect(canApplyImportPreview(applying)).toBe(false);
    // A second Apply from `applying` is a no-op.
    expect(startImportApply(applying).phase.kind).toBe("applying");

    const applied = finishImportApply(applying, { status: "applied", result: appliedResult() });
    expect(applied.phase).toEqual({ kind: "applied", result: appliedResult() });

    const notApplied = finishImportApply(startImportApply(state), {
      status: "not_applied",
      result: { preview: preview(), applied: false },
    });
    expect(notApplied.phase.kind).toBe("not_applied");

    const conflict = finishImportApply(startImportApply(state), {
      status: "conflict",
      conflictKind: "expired",
      message: "preview expired",
    });
    expect(conflict.phase).toEqual({ kind: "conflict", conflictKind: "expired" });

    const error = failImportPreview(startImportApply(state), "apply failed");
    expect(error.phase).toEqual({ kind: "error", message: "apply failed" });
  });

  test("apply success/not-applied/conflict outcomes", () => {
    let state = openImportPreviewDialog(initialImportPreviewDialogState);
    state = startImportPreviewLoad(state);
    state = finishImportPreviewLoad(state, { status: "prepared", preview: preview() });

    const applied = finishImportApply(startImportApply(state), { status: "applied", result: appliedResult() });
    expect(applied.phase).toEqual({ kind: "applied", result: appliedResult() });

    const notApplied = finishImportApply(startImportApply(state), {
      status: "not_applied",
      result: { preview: preview(), applied: false },
    });
    expect(notApplied.phase.kind).toBe("not_applied");

    const stale = finishImportApply(startImportApply(state), {
      status: "conflict",
      conflictKind: "stale",
      message: "local configuration changed",
    });
    expect(stale.phase).toEqual({ kind: "conflict", conflictKind: "stale" });
    expect(canApplyImportPreview(stale)).toBe(false);

    const expired = finishImportApply(startImportApply(state), {
      status: "conflict",
      conflictKind: "expired",
      message: "preview expired",
    });
    expect(expired.phase).toEqual({ kind: "conflict", conflictKind: "expired" });
  });

  test("retry after conflict re-previews from the same mode", () => {
    let state = openImportPreviewDialog(initialImportPreviewDialogState);
    state = selectImportPreviewMode(state, "copy");
    state = startImportPreviewLoad(state);
    state = finishImportPreviewLoad(state, { status: "prepared", preview: preview() });
    state = startImportApply(state);
    state = finishImportApply(state, { status: "conflict", conflictKind: "expired", message: "preview expired" });
    state = startImportPreviewLoad(state);
    expect(state.phase).toEqual({ kind: "loading" });
    expect(state.mode).toBe("copy");
  });

  test("unavailable packages do not disable data import", () => {
    let state = openImportPreviewDialog(initialImportPreviewDialogState);
    state = startImportPreviewLoad(state);
    state = finishImportPreviewLoad(state, {
      status: "prepared",
      preview: preview({
        runtimeRequirements: [
          {
            subjectKind: "provider",
            subjectId: "p1",
            displayLabel: "OpenAI",
            adapterId: "openai-compatible",
            runtimeKind: "wasm-component",
            pluginId: "com.langnext.provider.test",
            pluginVersion: "1.0.0",
            packageDigest: "a".repeat(64),
            publisherKeyId: "com.langnext.keys.1",
            publisherKeyFingerprint: "f".repeat(64),
            localStatus: "missing",
            requiredAction: "install_exact_package",
          },
        ],
      }),
    });
    expect(canApplyImportPreview(state)).toBe(true);
  });

  test("prepared preview without a preview id cannot apply", () => {
    let state = openImportPreviewDialog(initialImportPreviewDialogState);
    state = startImportPreviewLoad(state);
    state = finishImportPreviewLoad(state, {
      status: "prepared",
      preview: preview({ previewId: "" }),
    });
    expect(state.phase.kind).toBe("previewed");
    expect(canApplyImportPreview(state)).toBe(false);
  });

  test("cancel from any phase resets to the closed idle state", () => {
    let state = openImportPreviewDialog(initialImportPreviewDialogState);
    state = startImportPreviewLoad(state);
    state = finishImportPreviewLoad(state, { status: "prepared", preview: preview() });
    state = startImportApply(state);
    state = finishImportApply(state, { status: "conflict", conflictKind: "stale", message: "stale" });
    state = closeImportPreviewDialog(state);
    expect(state).toEqual(initialImportPreviewDialogState);
  });
});
