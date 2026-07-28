// ABOUTME: Lists installed signed plugin package versions with default, remove, and publisher trust actions.
// ABOUTME: Package code remains non-executable; backend in_use is authoritative for uninstall.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@base-ui/react/button";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { dangerButtonClassName, outlineButtonClassName } from "../../components/ui";
import { useToast } from "../../components/toast/useToast";
import { pluginPackageKeys } from "../../query/keys";
import { installedPluginVersionListOptions, pluginPublisherListOptions } from "../../query/options";
import { revokePluginPublisher, setDefaultPluginPackage, uninstallPluginVersion } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { InstalledPluginVersionDto, PluginPublisherDto } from "../../storage/types";
import { isPackageExecutionEnabled } from "./pluginPackagePresentation";

export function InstalledPluginVersions() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const versionsQuery = useQuery(installedPluginVersionListOptions());
  const publishersQuery = useQuery(pluginPublisherListOptions());
  const versions = versionsQuery.data ?? [];
  const publishers = publishersQuery.data ?? [];
  const [pendingUninstallDigest, setPendingUninstallDigest] = useState<string | null>(null);
  const [pendingRevokeKeyId, setPendingRevokeKeyId] = useState<string | null>(null);
  const [confirmUninstallDigest, setConfirmUninstallDigest] = useState<string | null>(null);
  const [confirmRevokeKeyId, setConfirmRevokeKeyId] = useState<string | null>(null);

  const setDefaultMutation = useMutation({
    mutationFn: ({ pluginId, packageDigest }: { pluginId: string; packageDigest: string }) =>
      setDefaultPluginPackage(pluginId, packageDigest),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: pluginPackageKeys.all });
      toast.success({ title: t("plugins.packages.defaultUpdated") });
    },
    onError: (error) => {
      toast.error({
        title: t("plugins.packages.defaultFailed"),
        description: getIpcErrorMessage(error, t("plugins.packages.defaultFailed")),
      });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: (packageDigest: string) => uninstallPluginVersion(packageDigest),
    onMutate: (packageDigest) => {
      setPendingUninstallDigest(packageDigest);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: pluginPackageKeys.all });
      toast.success({ title: t("plugins.packages.uninstallSuccess") });
    },
    onError: (error) => {
      toast.error({
        title: t("plugins.packages.uninstallFailed"),
        description: getIpcErrorMessage(error, t("plugins.packages.uninstallFailed")),
      });
    },
    onSettled: () => {
      setPendingUninstallDigest(null);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => revokePluginPublisher(keyId),
    onMutate: (keyId) => {
      setPendingRevokeKeyId(keyId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: pluginPackageKeys.all });
      toast.success({ title: t("plugins.packages.revokeSuccess") });
    },
    onError: (error) => {
      toast.error({
        title: t("plugins.packages.revokeFailed"),
        description: getIpcErrorMessage(error, t("plugins.packages.revokeFailed")),
      });
    },
    onSettled: () => {
      setPendingRevokeKeyId(null);
    },
  });

  if (versionsQuery.isLoading || publishersQuery.isLoading) {
    return <p className="text-body-tight text-neutral">{t("plugins.packages.loading")}</p>;
  }

  if (versionsQuery.error) {
    return (
      <div className="flex flex-col gap-2" role="alert">
        <p className="text-body-tight text-error">
          {getIpcErrorMessage(versionsQuery.error, t("plugins.packages.loadFailed"))}
        </p>
        <Button type="button" className={outlineButtonClassName} onClick={() => void versionsQuery.refetch()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  const confirmUninstallVersion = versions.find((v) => v.packageDigest === confirmUninstallDigest) ?? null;
  const confirmRevokePublisher = publishers.find((p) => p.keyId === confirmRevokeKeyId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label={t("plugins.packages.installedTitle")}>
        <p className="text-body-tight text-neutral">{t("plugins.packages.defaultHint")}</p>
        <p className="text-body-tight text-neutral">{t("plugins.packages.executionDisabled")}</p>
        {versions.length === 0 ? (
          <p className="text-body-tight text-neutral">{t("plugins.packages.empty")}</p>
        ) : (
          <ul className="space-y-3">
            {versions.map((version) => (
              <InstalledVersionRow
                key={version.packageDigest}
                version={version}
                defaultBusy={setDefaultMutation.isPending}
                uninstallPending={pendingUninstallDigest === version.packageDigest}
                onSetDefault={() =>
                  setDefaultMutation.mutate({
                    pluginId: version.pluginId,
                    packageDigest: version.packageDigest,
                  })
                }
                onUninstall={() => setConfirmUninstallDigest(version.packageDigest)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label={t("plugins.packages.publishersTitle")}>
        <h3 className="text-body-tight font-bold text-on-surface">{t("plugins.packages.publishersTitle")}</h3>
        <p className="text-body-tight text-neutral">{t("plugins.packages.publishersHint")}</p>
        {publishers.length === 0 ? (
          <p className="text-body-tight text-neutral">{t("plugins.packages.publishersEmpty")}</p>
        ) : (
          <ul className="space-y-3">
            {publishers.map((publisher) => (
              <PublisherRow
                key={publisher.keyId}
                publisher={publisher}
                revokePending={pendingRevokeKeyId === publisher.keyId}
                onRevoke={() => setConfirmRevokeKeyId(publisher.keyId)}
              />
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirmUninstallDigest !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmUninstallDigest(null);
          }
        }}
        title={t("plugins.packages.uninstallConfirmTitle")}
        description={
          confirmUninstallVersion
            ? `${confirmUninstallVersion.pluginId}@${confirmUninstallVersion.version}`
            : t("plugins.packages.uninstallConfirmDescription")
        }
        confirmText={t("plugins.packages.uninstallConfirm")}
        pendingText={t("plugins.packages.uninstalling")}
        danger
        onConfirm={async () => {
          if (!confirmUninstallDigest) {
            return;
          }
          await uninstallMutation.mutateAsync(confirmUninstallDigest);
        }}
      />

      <ConfirmDialog
        open={confirmRevokeKeyId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmRevokeKeyId(null);
          }
        }}
        title={t("plugins.packages.revokeConfirmTitle")}
        description={
          confirmRevokePublisher ? confirmRevokePublisher.keyId : t("plugins.packages.revokeConfirmDescription")
        }
        confirmText={t("plugins.packages.revokeConfirm")}
        pendingText={t("plugins.packages.revoking")}
        danger
        onConfirm={async () => {
          if (!confirmRevokeKeyId) {
            return;
          }
          await revokeMutation.mutateAsync(confirmRevokeKeyId);
        }}
      />
    </div>
  );
}

type InstalledVersionRowProps = {
  version: InstalledPluginVersionDto;
  defaultBusy: boolean;
  uninstallPending: boolean;
  onSetDefault: () => void;
  onUninstall: () => void;
};

function InstalledVersionRow({
  version,
  defaultBusy,
  uninstallPending,
  onSetDefault,
  onUninstall,
}: InstalledVersionRowProps) {
  const { t } = useTranslation();
  const executionEnabled = isPackageExecutionEnabled(version);

  return (
    <li className="border border-line bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-body-tight font-bold text-on-surface">
            {version.pluginId}@{version.version}
          </p>
          <p className="font-mono text-code-inline wrap-break-word text-neutral" title={version.packageDigest}>
            {version.packageDigest}
          </p>
          <p className="font-mono text-code-inline wrap-break-word text-neutral" title={version.publisherFingerprint}>
            {version.publisherKeyId}
            <br />
            {version.publisherFingerprint}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {version.isDefault ? <Badge tone="accent">{t("plugins.packages.defaultBadge")}</Badge> : null}
          {version.inUse ? <Badge>{t("plugins.packages.inUseBadge")}</Badge> : null}
          {!version.contentAvailable ? <Badge>{t("plugins.packages.contentMissing")}</Badge> : null}
          {!executionEnabled ? <Badge>{t("plugins.packages.notExecutable")}</Badge> : null}
        </div>
      </div>
      <p className="mb-3 text-code-inline text-neutral">
        {version.runtimeKind}
        {version.capabilities.length > 0 ? ` · ${version.capabilities.join(", ")}` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className={outlineButtonClassName}
          disabled={defaultBusy || version.isDefault || !version.contentAvailable}
          onClick={onSetDefault}
        >
          {t("plugins.packages.makeDefault")}
        </Button>
        <Button
          type="button"
          className={dangerButtonClassName}
          disabled={uninstallPending || version.inUse}
          onClick={onUninstall}
          title={version.inUse ? t("plugins.packages.uninstallInUse") : undefined}
        >
          {uninstallPending ? t("plugins.packages.uninstalling") : t("plugins.packages.uninstall")}
        </Button>
      </div>
    </li>
  );
}

type PublisherRowProps = {
  publisher: PluginPublisherDto;
  revokePending: boolean;
  onRevoke: () => void;
};

function PublisherRow({ publisher, revokePending, onRevoke }: PublisherRowProps) {
  const { t } = useTranslation();
  const sourceLabel =
    publisher.source === "vendor" ? t("plugins.packages.trust.trustedVendor") : t("plugins.packages.trust.trustedUser");
  const stateLabel = publisher.revoked
    ? t("plugins.packages.trust.revoked")
    : publisher.enabled
      ? t("common.enabled")
      : t("plugins.packages.trust.disabled");

  return (
    <li className="border border-line bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-body-tight font-bold text-on-surface">{publisher.keyId}</p>
          <p className="font-mono text-code-inline wrap-break-word text-neutral" title={publisher.fingerprint}>
            {publisher.fingerprint}
          </p>
          <p className="text-code-inline text-neutral">
            {sourceLabel} · {stateLabel}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className={dangerButtonClassName}
          disabled={revokePending || publisher.revoked || publisher.source === "vendor"}
          onClick={onRevoke}
          title={publisher.source === "vendor" ? t("plugins.packages.revokeVendorBlocked") : undefined}
        >
          {revokePending ? t("plugins.packages.revoking") : t("plugins.packages.revoke")}
        </Button>
      </div>
    </li>
  );
}
