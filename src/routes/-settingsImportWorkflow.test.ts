// ABOUTME: Route workflow gating tests: applied triggers rebind/invalidate/notify once.
// ABOUTME: Cancelled, invalid, and not-applied outcomes must produce zero route effects.
import { describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { IMPORT_INVALIDATION_KEYS } from "../features/settings/importAcceptance";
import type { ImportPreview, ImportResult } from "../storage/types";
import { runSettingsImportWorkflow } from "./-settingsImportWorkflow";
import type { SettingsImportWorkflowOutcome } from "./-settingsImportWorkflow";

function preview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    valid: true,
    counts: {},
    validationErrors: [],
    requiresAuthentication: [],
    integrationRequiresAuthentication: [],
    proxyRequiresAuthentication: false,
    defaultProfileCleared: false,
    runtimeRequirements: [],
    ...overrides,
  };
}

function result(): ImportResult {
  return { preview: preview(), applied: true };
}

function makeDeps() {
  const applyImportedAppSettings = mock(async () => {});
  const queryClient = new QueryClient();
  const invalidateQueries = mock(queryClient.invalidateQueries.bind(queryClient));
  queryClient.invalidateQueries = invalidateQueries;
  const notifySuccess = mock(() => {});
  return { applyImportedAppSettings, queryClient, invalidateQueries, notifySuccess };
}

describe("runSettingsImportWorkflow", () => {
  test("applied rebinds settings, invalidates every domain once, and notifies once", async () => {
    const deps = makeDeps();

    await runSettingsImportWorkflow({ status: "applied", result: result() }, deps);

    expect(deps.applyImportedAppSettings).toHaveBeenCalledTimes(1);
    expect(deps.invalidateQueries).toHaveBeenCalledTimes(IMPORT_INVALIDATION_KEYS.length);
    for (const queryKey of IMPORT_INVALIDATION_KEYS) {
      const called = deps.invalidateQueries.mock.calls.some(
        ([options]) => JSON.stringify(options?.queryKey) === JSON.stringify(queryKey),
      );
      expect(called).toBe(true);
    }
    expect(deps.notifySuccess).toHaveBeenCalledTimes(1);
    expect(deps.notifySuccess).toHaveBeenCalledWith("none");
  });

  test("applied derives the re-auth warning kind for the notification", async () => {
    const deps = makeDeps();
    const withAuth = result();
    withAuth.preview.requiresAuthentication = ["p1"];
    withAuth.preview.integrationRequiresAuthentication = ["i1"];

    await runSettingsImportWorkflow({ status: "applied", result: withAuth }, deps);

    expect(deps.notifySuccess).toHaveBeenCalledTimes(1);
    expect(deps.notifySuccess).toHaveBeenCalledWith("mixed");
  });

  test("cancelled, invalid, and not_applied outcomes trigger no route effects", async () => {
    const outcomes: SettingsImportWorkflowOutcome[] = [
      { status: "cancelled" },
      { status: "invalid" },
      { status: "not_applied" },
    ];
    for (const outcome of outcomes) {
      const deps = makeDeps();
      await runSettingsImportWorkflow(outcome, deps);
      expect(deps.applyImportedAppSettings).not.toHaveBeenCalled();
      expect(deps.invalidateQueries).not.toHaveBeenCalled();
      expect(deps.notifySuccess).not.toHaveBeenCalled();
    }
  });
});
