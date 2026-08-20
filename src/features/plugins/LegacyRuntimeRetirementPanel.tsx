// ABOUTME: Phase 12 remediation panel for unresolved legacy runtime rows.
// ABOUTME: Migrate / keep disabled / delete actions with sanitized IPC errors.
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "@base-ui/react/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import { useToast } from "../../components/toast/useToast";
import { dangerButtonClassName, outlineButtonClassName } from "../../components/ui";
import { getUserErrorMessage } from "../userErrorMessage";
import { integrationKeys, modelKeys, pluginPackageKeys, providerKeys, retirementKeys } from "../../query/keys";
import { legacyRuntimeRetirementInventoryOptions } from "../../query/options";
import {
  applyIntegrationRuntimeUpgrade,
  applyProviderRuntimeInterfaceAttach,
  deleteIntegrationInstance,
  deleteRetiredLegacyProvider,
  previewIntegrationRuntimeUpgrade,
  previewProviderRuntimeInterfaceAttach,
  setIntegrationInstanceEnabled,
  setProviderEnabled,
} from "../../storage/client";
import type { LegacyRuntimeUnresolvedRowDto } from "../../storage/types";

/** One remediation action in flight per row; serialized by the action buttons. */
type BusyAction = "migrate" | "disable" | "delete" | null;

/** One subject kind's remediation operations, routed by row-owned authority values. */
interface RetirementSubjectOperations {
  migrate: (row: LegacyRuntimeUnresolvedRowDto, digest: string) => Promise<void>;
  disable: (row: LegacyRuntimeUnresolvedRowDto) => Promise<void>;
  delete: (row: LegacyRuntimeUnresolvedRowDto) => Promise<void>;
}

/** Subject-kind strategy map: migrate/disable/delete per unresolved row kind. */
const subjectOperations: Record<LegacyRuntimeUnresolvedRowDto["subjectKind"], RetirementSubjectOperations> = {
  integration_instance: {
    migrate: async (row, digest) => {
      const preview = await previewIntegrationRuntimeUpgrade(row.subjectId, digest);
      await applyIntegrationRuntimeUpgrade({
        previewId: preview.previewId,
        acknowledgePermissions: preview.requiresPermissionApproval,
      });
    },
    disable: async (row) => {
      await setIntegrationInstanceEnabled(row.subjectId, false);
    },
    delete: async (row) => {
      await deleteIntegrationInstance(row.subjectId);
    },
  },
  provider_binding: {
    migrate: async (row, digest) => {
      const preview = await previewProviderRuntimeInterfaceAttach({
        providerId: row.subjectId,
        adapterId: row.adapterId ?? "",
        packageDigest: digest,
      });
      await applyProviderRuntimeInterfaceAttach({
        previewId: preview.previewId,
        acknowledgePermissions: preview.requiresPermissionApproval,
      });
    },
    disable: async (row) => {
      await setProviderEnabled(row.subjectId, false);
    },
    delete: async (row) => {
      await deleteRetiredLegacyProvider({
        providerId: row.subjectId,
        adapterId: row.adapterId ?? "",
        updateToken: row.updateToken,
      });
    },
  },
};

/** Invalidate every query family that retirement remediation can change. */
async function invalidateRetirementViews(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: retirementKeys.all }),
    queryClient.invalidateQueries({ queryKey: integrationKeys.all }),
    queryClient.invalidateQueries({ queryKey: providerKeys.all }),
    queryClient.invalidateQueries({ queryKey: modelKeys.all }),
    queryClient.invalidateQueries({ queryKey: pluginPackageKeys.all }),
  ]);
}

function RetirementRow({ row }: { row: LegacyRuntimeUnresolvedRowDto }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<BusyAction>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const isProvider = row.subjectKind === "provider_binding";

  const runAction = async (action: Exclude<BusyAction, null>): Promise<void> => {
    setBusy(action);
    setRowError(null);
    try {
      const operations = subjectOperations[row.subjectKind];
      if (action === "migrate") {
        const digest = row.replacementPackageDigest;
        if (!digest) {
          throw new Error(t("plugins.retirement.migrateUnavailable"));
        }
        await operations.migrate(row, digest);
      } else if (action === "disable") {
        await operations.disable(row);
      } else if (action === "delete") {
        await operations.delete(row);
        setDeleteOpen(false);
      }
      await invalidateRetirementViews(queryClient);
    } catch (error) {
      // Failed rows stay visible; the sanitized IPC error is shown inline.
      const message = getUserErrorMessage(error, t("plugins.retirement.actionFailed"));
      setRowError(message);
      toast.error({ title: t("plugins.retirement.actionFailed"), description: message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="flex flex-col gap-2 border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-body-tight font-bold text-on-surface">{row.displayName}</span>
          <span className="text-code-inline text-neutral">
            {isProvider ? `${row.adapterId ?? ""} · ` : ""}
            {row.enabled ? t("common.enabled") : t("common.disabled")}
            {row.dependencyCount > 0 ? ` · ${t("plugins.retirement.dependents", { count: row.dependencyCount })}` : ""}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            className={outlineButtonClassName}
            disabled={!row.migrateAvailable || busy != null}
            title={row.migrateAvailable ? undefined : t("plugins.retirement.migrateUnavailable")}
            onClick={() => void runAction("migrate")}
          >
            {t("plugins.retirement.migrate")}
          </Button>
          <Button
            type="button"
            className={outlineButtonClassName}
            disabled={!row.disableAvailable || busy != null}
            onClick={() => void runAction("disable")}
          >
            {t("plugins.retirement.disable")}
          </Button>
          <AlertDialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialog.Trigger
              render={
                <Button
                  type="button"
                  className={outlineButtonClassName}
                  disabled={!row.deleteAvailable || busy != null}
                  title={
                    row.deleteAvailable
                      ? undefined
                      : t("plugins.retirement.deleteBlocked", { count: row.dependencyCount })
                  }
                >
                  {t("plugins.retirement.delete")}
                </Button>
              }
            />
            <AlertDialog.Portal>
              <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
              <AlertDialog.Popup
                className="
                  shadow-frame fixed top-1/2 left-1/2 z-50 w-lg -translate-1/2 rounded-md border border-line bg-surface
                  p-4
                "
              >
                <AlertDialog.Title className="text-title-dialog font-bold text-on-surface">
                  {t("plugins.retirement.deleteConfirmTitle")}
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-2 text-body-tight text-neutral">
                  {t("plugins.retirement.deleteConfirmBody", { name: row.displayName })}
                </AlertDialog.Description>
                <div className="mt-4 flex justify-end gap-2">
                  <AlertDialog.Close
                    render={
                      <Button type="button" className={outlineButtonClassName}>
                        {t("common.cancel")}
                      </Button>
                    }
                  />
                  <Button
                    type="button"
                    className={dangerButtonClassName}
                    disabled={busy === "delete"}
                    onClick={() => void runAction("delete")}
                  >
                    {t("plugins.retirement.deleteConfirmAction")}
                  </Button>
                </div>
              </AlertDialog.Popup>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </div>
      </div>
      {!row.enabled ? <Badge>{t("plugins.retirement.keptDisabledHint")}</Badge> : null}
      {rowError ? (
        <p className="text-body-tight text-error" role="alert">
          {rowError}
        </p>
      ) : null}
    </li>
  );
}

/** Phase 12 legacy runtime retirement panel: unresolved rows with remediation actions. */
export function LegacyRuntimeRetirementPanel() {
  const { t } = useTranslation();
  const inventoryQuery = useQuery(legacyRuntimeRetirementInventoryOptions());
  const error = inventoryQuery.error
    ? getUserErrorMessage(inventoryQuery.error, t("plugins.retirement.loadFailed"))
    : null;
  const entries = inventoryQuery.data?.entries ?? [];
  const unresolved = entries.flatMap((entry) => entry.unresolvedRows);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-body-tight font-bold text-on-surface">{t("plugins.retirement.title")}</h2>
        {inventoryQuery.isLoading ? <Badge>{t("plugins.retirement.loading")}</Badge> : null}
      </div>
      {error ? (
        <div className="flex flex-col gap-2" role="alert">
          <p className="text-body-tight text-error">{error}</p>
          <Button type="button" className={outlineButtonClassName} onClick={() => void inventoryQuery.refetch()}>
            {t("common.retry")}
          </Button>
        </div>
      ) : null}
      {!inventoryQuery.isLoading && !error && unresolved.length === 0 ? (
        <p className="text-body-tight text-neutral">{t("plugins.retirement.empty")}</p>
      ) : null}
      {unresolved.length > 0 ? (
        <ul className="space-y-2">
          {unresolved.map((row) => (
            <RetirementRow key={`${row.subjectKind}:${row.subjectId}:${row.adapterId ?? ""}`} row={row} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
