// ABOUTME: Route-owned post-import workflow: rebind, invalidate, notify (applied only).
// ABOUTME: Pure seam with injected dependencies so route gating is testable without React.
import type { QueryClient } from "@tanstack/react-query";
import { IMPORT_INVALIDATION_KEYS, importAuthWarningKind } from "../features/settings/importAcceptance";
import type { ImportResult } from "../storage/types";

/** Outcomes the dialog can report to the route after an apply attempt. */
export type SettingsImportWorkflowOutcome =
  | { readonly status: "applied"; readonly result: ImportResult }
  | { readonly status: "cancelled" }
  | { readonly status: "invalid" }
  | { readonly status: "not_applied" };

/** Re-auth domain kinds the success notification can describe. */
export type SettingsImportNotificationKind = ReturnType<typeof importAuthWarningKind>;

/** Route-owned side effects for a completed configuration import workflow. */
export interface SettingsImportWorkflowDeps {
  /** Activate imported app settings in this process (rebind UI/OS state). */
  applyImportedAppSettings: () => Promise<unknown>;
  queryClient: QueryClient;
  /** Show the success toast; the description is derived from the re-auth kind. */
  notifySuccess: (kind: SettingsImportNotificationKind) => void;
}

/**
 * Post-import acceptance: only an applied result rebinds settings, invalidates every
 * configured domain exactly once, and shows the success notification. Cancelled, invalid,
 * and not-applied outcomes trigger none of those effects.
 */
export async function runSettingsImportWorkflow(
  outcome: SettingsImportWorkflowOutcome,
  deps: SettingsImportWorkflowDeps,
): Promise<void> {
  if (outcome.status !== "applied") {
    return;
  }
  // Activate imported app_settings in this process (DB write alone does not rebind UI/OS).
  await deps.applyImportedAppSettings();

  // Local invalidation covers this webview immediately; QueryEventSync also invalidates
  // provider/model/profile/integration prefixes from backend DATA_* events in every window.
  for (const queryKey of IMPORT_INVALIDATION_KEYS) {
    void deps.queryClient.invalidateQueries({ queryKey });
  }

  deps.notifySuccess(importAuthWarningKind(outcome.result.preview));
}
