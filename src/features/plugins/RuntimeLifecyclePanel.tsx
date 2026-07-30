// ABOUTME: Advanced runtime upgrade/rollback panel for an integration instance.
// ABOUTME: Preview → explicit permission ack → apply; never shows secrets or package bytes.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { Input } from "@base-ui/react/input";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/toast/useToast";
import { checkboxClassName, checkboxIndicatorClassName, outlineButtonClassName } from "../../components/ui";
import {
  integrationKeys,
  ocrKeys,
  pluginPackageKeys,
  profileKeys,
  runtimeLifecycleKeys,
  speechKeys,
} from "../../query/keys";
import { runtimeRollbackPreviewOptions, runtimeUpgradePreviewOptions } from "../../query/options";
import {
  applyIntegrationRuntimeRollback,
  applyIntegrationRuntimeUpgrade,
  discardIntegrationRuntimeSnapshot,
} from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { IntegrationInstanceDto } from "../../storage/types";
import {
  formatPermissionDifference,
  formatPublisherIdentity,
  formatRuntimeIdentity,
  hasThirdPartyEgressChange,
  isRuntimeUnresolved,
  upgradeApprovalDetailsReady,
  upgradeRequiresAcknowledgement,
} from "./runtimeLifecyclePresentation";

export type RuntimeLifecyclePanelProps = {
  instance: IntegrationInstanceDto;
};

function invalidateLifecycleQueries(queryClient: ReturnType<typeof useQueryClient>, instanceId: string) {
  void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
  void queryClient.invalidateQueries({ queryKey: profileKeys.all });
  void queryClient.invalidateQueries({ queryKey: ocrKeys.all });
  void queryClient.invalidateQueries({ queryKey: speechKeys.all });
  void queryClient.invalidateQueries({ queryKey: pluginPackageKeys.all });
  void queryClient.invalidateQueries({ queryKey: runtimeLifecycleKeys.all });
  void queryClient.invalidateQueries({ queryKey: integrationKeys.detail(instanceId) });
}

export function RuntimeLifecyclePanel({ instance }: RuntimeLifecyclePanelProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [targetDigest, setTargetDigest] = useState("");
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackEnabled, setRollbackEnabled] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [permissionAck, setPermissionAck] = useState(false);
  const digestReady = targetDigest.trim().length === 64;

  const upgradePreviewQuery = useQuery({
    ...runtimeUpgradePreviewOptions(instance.id, targetDigest.trim()),
    enabled: upgradeOpen && digestReady,
  });
  const rollbackPreviewQuery = useQuery(runtimeRollbackPreviewOptions(instance.id, rollbackEnabled));

  const needsAck = upgradePreviewQuery.data ? upgradeRequiresAcknowledgement(upgradePreviewQuery.data) : false;
  const detailsReady = upgradePreviewQuery.data ? upgradeApprovalDetailsReady(upgradePreviewQuery.data) : false;

  const upgradeMutation = useMutation({
    mutationFn: async () => {
      const preview = upgradePreviewQuery.data;
      if (!preview) {
        throw new Error("missing preview");
      }
      if (upgradeRequiresAcknowledgement(preview) && !permissionAck) {
        throw new Error("permission acknowledgement required");
      }
      return applyIntegrationRuntimeUpgrade({
        previewId: preview.previewId,
        // Never auto-sign expansions: only true after explicit checkbox.
        acknowledgePermissions: upgradeRequiresAcknowledgement(preview) ? permissionAck : false,
      });
    },
    onSuccess: () => {
      invalidateLifecycleQueries(queryClient, instance.id);
      setUpgradeOpen(false);
      setTargetDigest("");
      setPermissionAck(false);
      toast.success({ title: "Runtime upgraded" });
    },
    onError: (error) => {
      toast.error({
        title: "Upgrade failed",
        description: getIpcErrorMessage(error, "Upgrade failed"),
      });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: async () => {
      const preview = rollbackPreviewQuery.data;
      if (!preview) {
        throw new Error("missing preview");
      }
      return applyIntegrationRuntimeRollback({ previewId: preview.previewId });
    },
    onSuccess: () => {
      invalidateLifecycleQueries(queryClient, instance.id);
      setRollbackOpen(false);
      setRollbackEnabled(false);
      toast.success({ title: "Runtime restored" });
    },
    onError: (error) => {
      toast.error({
        title: "Rollback failed",
        description: getIpcErrorMessage(error, "Rollback failed"),
      });
    },
  });

  const discardMutation = useMutation({
    mutationFn: async () => {
      const preview = rollbackPreviewQuery.data;
      if (!preview) {
        throw new Error("missing snapshot");
      }
      return discardIntegrationRuntimeSnapshot(preview.snapshotId);
    },
    onSuccess: () => {
      invalidateLifecycleQueries(queryClient, instance.id);
      setRollbackEnabled(false);
      setDiscardOpen(false);
      toast.success({ title: "Snapshot discarded" });
    },
    onError: (error) => {
      toast.error({
        title: "Discard failed",
        description: getIpcErrorMessage(error, "Discard failed"),
      });
    },
  });

  const pending = upgradeMutation.isPending || rollbackMutation.isPending || discardMutation.isPending;
  const unresolved = isRuntimeUnresolved(instance);

  const upgradeDescription = (
    <div className="space-y-2">
      <p>
        {upgradePreviewQuery.isLoading
          ? "Loading preview…"
          : upgradePreviewQuery.isError
            ? getIpcErrorMessage(upgradePreviewQuery.error, "Preview failed")
            : upgradePreviewQuery.data
              ? `${formatRuntimeIdentity(upgradePreviewQuery.data.source)} → ${formatRuntimeIdentity(upgradePreviewQuery.data.target)}`
              : "Enter a package digest."}
      </p>
      {upgradePreviewQuery.data ? (
        <div className="space-y-1 text-body-tight text-on-surface">
          <p>
            Publisher: {formatPublisherIdentity(upgradePreviewQuery.data.sourcePublisher)} →{" "}
            {formatPublisherIdentity(upgradePreviewQuery.data.targetPublisher)}
          </p>
          {hasThirdPartyEgressChange(upgradePreviewQuery.data) ? (
            <p className="text-error" role="alert">
              Third-party data egress: this upgrade sends your translated text to a third-party proxy server (the
              approved proxy origin). Detect stays on Google GTX. Never use for private content.
            </p>
          ) : null}
          {upgradePreviewQuery.data.permissionDifferences.length ? (
            <ul className="m-0 list-disc space-y-1 pl-5">
              {upgradePreviewQuery.data.permissionDifferences.map((diff) => (
                <li key={`${diff.kind}:${diff.summary}:${diff.resource ?? ""}:${diff.origin ?? ""}`}>
                  {formatPermissionDifference(diff)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {needsAck && detailsReady ? (
        <label className="flex items-center gap-2 text-body-tight text-on-surface">
          <Checkbox.Root
            checked={permissionAck}
            onCheckedChange={(checked) => setPermissionAck(checked === true)}
            className={checkboxClassName}
          >
            <Checkbox.Indicator className={checkboxIndicatorClassName}>✓</Checkbox.Indicator>
          </Checkbox.Root>
          I reviewed permission and publisher changes
        </label>
      ) : null}
      {needsAck && !detailsReady ? (
        <p className="text-body-tight text-error">Approval details incomplete; cannot acknowledge yet.</p>
      ) : null}
    </div>
  );

  const rollbackDescription = rollbackPreviewQuery.isLoading
    ? "Loading preview…"
    : rollbackPreviewQuery.isError
      ? getIpcErrorMessage(rollbackPreviewQuery.error, "No snapshot")
      : rollbackPreviewQuery.data
        ? `Restore ${formatRuntimeIdentity(rollbackPreviewQuery.data.target)} (${rollbackPreviewQuery.data.targetPluginVersion})`
        : "No rollback snapshot.";

  return (
    <section className="space-y-3">
      <h3 className="text-label-sm font-bold tracking-wide text-neutral uppercase">Advanced runtime</h3>
      {unresolved ? (
        <p className="text-body-tight text-error">
          Unresolved package. Install the required package, approve permissions, then activate.
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <label className="text-body-tight text-neutral" htmlFor={`runtime-digest-${instance.id}`}>
          Target package digest
        </label>
        <Input
          id={`runtime-digest-${instance.id}`}
          className="font-mono text-body-tight"
          value={targetDigest}
          disabled={pending}
          maxLength={64}
          onChange={(event) => setTargetDigest(event.currentTarget.value.trim().toLowerCase())}
          placeholder="64-char hex"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className={outlineButtonClassName}
            disabled={pending || !digestReady}
            onClick={() => {
              setPermissionAck(false);
              setUpgradeOpen(true);
            }}
          >
            Preview upgrade
          </Button>
          <Button
            type="button"
            className={outlineButtonClassName}
            disabled={pending}
            onClick={() => {
              setRollbackEnabled(true);
              setRollbackOpen(true);
            }}
          >
            Preview rollback
          </Button>
          {rollbackPreviewQuery.data ? (
            <Button
              type="button"
              className={outlineButtonClassName}
              disabled={pending}
              onClick={() => setDiscardOpen(true)}
            >
              Discard snapshot
            </Button>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={upgradeOpen}
        onOpenChange={(open) => {
          setUpgradeOpen(open);
          if (!open) {
            setPermissionAck(false);
          }
        }}
        title="Upgrade runtime"
        description={upgradeDescription}
        confirmText="Apply"
        onConfirm={async () => {
          if (!upgradePreviewQuery.data || upgradePreviewQuery.isError) {
            throw new Error("preview unavailable");
          }
          if (needsAck && !permissionAck) {
            throw new Error("permission acknowledgement required");
          }
          await upgradeMutation.mutateAsync();
        }}
      />

      <ConfirmDialog
        open={rollbackOpen}
        onOpenChange={(open) => {
          setRollbackOpen(open);
          if (!open) {
            setRollbackEnabled(false);
          }
        }}
        title="Rollback runtime"
        description={rollbackDescription}
        confirmText="Restore"
        onConfirm={async () => {
          if (!rollbackPreviewQuery.data || rollbackPreviewQuery.isError) {
            throw new Error("preview unavailable");
          }
          await rollbackMutation.mutateAsync();
        }}
      />

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard snapshot"
        description="Remove the rollback snapshot permanently. This cannot be undone."
        confirmText="Discard"
        danger
        onConfirm={async () => {
          await discardMutation.mutateAsync();
        }}
      />
    </section>
  );
}
