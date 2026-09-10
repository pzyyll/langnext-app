// ABOUTME: Catalog list of built-in, development, and user plugin content with default actions.
// ABOUTME: Built-in content is trusted by location; user archives carry no publisher identity.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@base-ui/react/button";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { dangerButtonClassName, outlineButtonClassName } from "../../components/ui";
import { useToast } from "../../components/toast/useToast";
import { pluginPackageKeys } from "../../query/keys";
import { pluginCatalogOptions } from "../../query/options";
import {
  clearPluginCatalogDefault,
  refreshPluginCatalog,
  removeUserPluginPackage,
  setPluginCatalogDefault,
} from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { PluginCatalogEntryDto } from "../../storage/types";
import {
  formatPackageDigestShort,
  isPackageExecutionEnabled,
  isReloadableEntry,
  isRemovableEntry,
  pluginSourceLabelKey,
  requiresUserContentWarning,
  summarizeNetworkPermissions,
} from "./pluginPackagePresentation";

export function InstalledPluginVersions() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const catalogQuery = useQuery(pluginCatalogOptions());
  const entries = catalogQuery.data?.entries ?? [];
  const errors = catalogQuery.data?.errors ?? [];
  const [pendingDigest, setPendingDigest] = useState<string | null>(null);
  const [confirmRemoveDigest, setConfirmRemoveDigest] = useState<string | null>(null);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: pluginPackageKeys.all });
  };

  const defaultMutation = useMutation({
    mutationFn: async (entry: PluginCatalogEntryDto) => {
      if (entry.isDefault) {
        await clearPluginCatalogDefault(entry.pluginId);
        return;
      }
      await setPluginCatalogDefault(entry.pluginId, entry.contentDigest);
    },
    onMutate: (entry) => {
      setPendingDigest(entry.contentDigest);
    },
    onSuccess: async () => {
      await invalidate();
      toast.success({ title: t("plugins.packages.defaultUpdated") });
    },
    onError: (error) => {
      toast.error({
        title: t("plugins.packages.defaultFailed"),
        description: getIpcErrorMessage(error, t("plugins.packages.defaultFailed")),
      });
    },
    onSettled: () => {
      setPendingDigest(null);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (contentDigest: string) => removeUserPluginPackage(contentDigest),
    onMutate: (contentDigest) => {
      setPendingDigest(contentDigest);
    },
    onSuccess: async () => {
      await invalidate();
      toast.success({ title: t("plugins.packages.removeSuccess") });
    },
    onError: (error) => {
      toast.error({
        title: t("plugins.packages.removeFailed"),
        description: getIpcErrorMessage(error, t("plugins.packages.removeFailed")),
      });
    },
    onSettled: () => {
      setPendingDigest(null);
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshPluginCatalog(),
    onSuccess: async () => {
      await invalidate();
      toast.success({ title: t("plugins.packages.refreshSuccess") });
    },
    onError: (error) => {
      toast.error({
        title: t("plugins.packages.refreshFailed"),
        description: getIpcErrorMessage(error, t("plugins.packages.refreshFailed")),
      });
    },
  });

  if (catalogQuery.isLoading) {
    return <p className="text-body-tight text-neutral">{t("plugins.packages.loading")}</p>;
  }

  if (catalogQuery.error) {
    return (
      <div className="flex flex-col gap-2" role="alert">
        <p className="text-body-tight text-error">
          {getIpcErrorMessage(catalogQuery.error, t("plugins.packages.loadFailed"))}
        </p>
        <Button type="button" className={outlineButtonClassName} onClick={() => void catalogQuery.refetch()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  const confirmRemoveEntry = entries.find((entry) => entry.contentDigest === confirmRemoveDigest) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label={t("plugins.packages.installedTitle")}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-body-tight text-neutral">{t("plugins.packages.defaultHint")}</p>
          <Button
            type="button"
            className={outlineButtonClassName}
            disabled={refreshMutation.isPending}
            onClick={() => refreshMutation.mutate()}
          >
            {refreshMutation.isPending ? t("plugins.packages.refreshing") : t("plugins.packages.refresh")}
          </Button>
        </div>
        {entries.length === 0 ? (
          <p className="text-body-tight text-neutral">{t("plugins.packages.empty")}</p>
        ) : (
          <ul className="space-y-3">
            {entries.map((entry) => (
              <CatalogEntryRow
                key={`${entry.pluginId}@${entry.version}#${entry.contentDigest}`}
                entry={entry}
                busy={pendingDigest === entry.contentDigest}
                onToggleDefault={() => defaultMutation.mutate(entry)}
                onReload={() => refreshMutation.mutate()}
                onRemove={() => setConfirmRemoveDigest(entry.contentDigest)}
              />
            ))}
          </ul>
        )}
      </section>

      {errors.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label={t("plugins.packages.errorsTitle")}>
          <h3 className="text-body-tight font-bold text-on-surface">{t("plugins.packages.errorsTitle")}</h3>
          <ul className="space-y-2">
            {errors.map((error) => (
              <li
                key={`${error.source}:${error.pluginId}:${error.relativePath}:${error.code}`}
                className="border border-line bg-surface-2 p-3 text-body-tight text-neutral"
              >
                <span className="font-mono text-code-inline text-on-surface">{error.code}</span>
                {error.pluginId ? <span className="font-mono text-code-inline"> · {error.pluginId}</span> : null}
                {error.relativePath ? (
                  <span className="font-mono text-code-inline wrap-break-word"> · {error.relativePath}</span>
                ) : null}
                <p>{error.message}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirmRemoveDigest !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmRemoveDigest(null);
          }
        }}
        title={t("plugins.packages.removeConfirmTitle")}
        description={
          confirmRemoveEntry
            ? `${confirmRemoveEntry.pluginId}@${confirmRemoveEntry.version}`
            : t("plugins.packages.removeConfirmDescription")
        }
        confirmText={t("plugins.packages.removeConfirm")}
        pendingText={t("plugins.packages.removing")}
        danger
        onConfirm={async () => {
          if (!confirmRemoveDigest) {
            return;
          }
          await removeMutation.mutateAsync(confirmRemoveDigest);
        }}
      />
    </div>
  );
}

type CatalogEntryRowProps = {
  entry: PluginCatalogEntryDto;
  busy: boolean;
  onToggleDefault: () => void;
  onReload: () => void;
  onRemove: () => void;
};

function CatalogEntryRow({ entry, busy, onToggleDefault, onReload, onRemove }: CatalogEntryRowProps) {
  const { t } = useTranslation();
  const network = summarizeNetworkPermissions(entry.network);
  const executionEnabled = isPackageExecutionEnabled(entry);
  // Built-in content is the automatic default; only an override can be cleared.
  const defaultToggleEnabled = !entry.isDefault || entry.source !== "built_in";

  return (
    <li className="border border-line bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-body-tight font-bold text-on-surface">
            {entry.pluginId}@{entry.version}
          </p>
          <p className="font-mono text-code-inline wrap-break-word text-neutral" title={entry.contentDigest}>
            {formatPackageDigestShort(entry.contentDigest)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge>{t(pluginSourceLabelKey(entry.source))}</Badge>
          {entry.isDefault ? <Badge tone="accent">{t("plugins.packages.defaultBadge")}</Badge> : null}
          {entry.inUse ? <Badge>{t("plugins.packages.inUseBadge")}</Badge> : null}
          {!executionEnabled ? <Badge>{t("plugins.packages.notExecutable")}</Badge> : null}
        </div>
      </div>
      {requiresUserContentWarning(entry) ? (
        <p className="mb-2 text-body-tight text-neutral">{t("plugins.packages.userContentWarning")}</p>
      ) : null}
      <p className="mb-1 text-code-inline text-neutral">
        {entry.runtimeKind}
        {entry.capabilities.length > 0 ? ` · ${entry.capabilities.join(", ")}` : ""}
      </p>
      {network.length > 0 ? (
        <ul className="mb-2 list-disc pl-5 text-code-inline text-neutral">
          {network.map((item) => (
            <li key={item.id}>
              <span className="font-mono text-on-surface">{item.id}</span>: {item.summary}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className={outlineButtonClassName}
          disabled={busy || !defaultToggleEnabled}
          onClick={onToggleDefault}
          title={t("plugins.packages.defaultHint")}
        >
          {entry.isDefault ? t("plugins.packages.clearDefault") : t("plugins.packages.makeDefault")}
        </Button>
        {isReloadableEntry(entry) ? (
          <Button
            type="button"
            className={outlineButtonClassName}
            disabled={busy}
            onClick={onReload}
            title={t("plugins.packages.reloadHint")}
          >
            {t("plugins.packages.reload")}
          </Button>
        ) : null}
        {entry.removable ? (
          <Button
            type="button"
            className={dangerButtonClassName}
            disabled={busy || !isRemovableEntry(entry)}
            onClick={onRemove}
            title={entry.inUse ? t("plugins.packages.removeInUse") : undefined}
          >
            {busy ? t("plugins.packages.removing") : t("plugins.packages.remove")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
