// ABOUTME: Acknowledgement-gated default package authorization dialog.
// ABOUTME: Shows exact publisher, digest, capabilities, and authority before authorize IPC.
import { Checkbox } from "@base-ui/react/checkbox";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { checkboxClassName, checkboxIndicatorClassName } from "../../components/ui";
import { getIpcErrorMessage } from "../../storage/errors";
import { runAuthorizeDefaultPluginPackage, runPreviewDefaultPackageActivation } from "./defaultPackageActivationFlow";
import { useAcknowledgedPreviewDialog } from "./useAcknowledgedPreviewDialog";

export type DefaultPackageActivationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Package digest selected for default authorization; null closes the preview. */
  packageDigest: string | null;
  onAuthorized: () => void | Promise<void>;
};

export function DefaultPackageActivationDialog(props: DefaultPackageActivationDialogProps) {
  // Remount per open+digest so load state never needs a synchronous reset effect.
  const sessionKey = props.open && props.packageDigest ? props.packageDigest : "closed";
  return <DefaultPackageActivationDialogContent key={sessionKey} {...props} />;
}

function DefaultPackageActivationDialogContent({
  open,
  onOpenChange,
  packageDigest,
  onAuthorized,
}: DefaultPackageActivationDialogProps) {
  const { t } = useTranslation();
  const sessionKey = open && packageDigest ? packageDigest : "closed";
  const { preview, loading, loadError, acknowledged, setAcknowledged, confirmDisabled, resetAcknowledgement } =
    useAcknowledgedPreviewDialog({
      active: Boolean(open && packageDigest),
      sessionKey,
      loadPreview: () => {
        if (!packageDigest) {
          return Promise.reject(new Error(t("plugins.packages.defaultActivation.previewFailed")));
        }
        return runPreviewDefaultPackageActivation(packageDigest);
      },
      fallbackError: t("plugins.packages.defaultActivation.previewFailed"),
      formatError: getIpcErrorMessage,
    });

  const description = (
    <div className="space-y-3 text-body-tight">
      {loading ? <p className="text-neutral">{t("plugins.packages.defaultActivation.previewing")}</p> : null}
      {loadError ? (
        <p className="text-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {preview ? (
        <>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-neutral">{t("plugins.packages.pluginId")}</dt>
            <dd className="m-0 font-mono wrap-break-word text-on-surface">{preview.pluginId}</dd>
            <dt className="text-neutral">{t("plugins.packages.version")}</dt>
            <dd className="m-0 font-mono text-on-surface">{preview.version}</dd>
            <dt className="text-neutral">{t("plugins.packages.digest")}</dt>
            <dd className="m-0 font-mono wrap-break-word text-on-surface">{preview.packageDigest}</dd>
            <dt className="text-neutral">{t("plugins.packages.publisher")}</dt>
            <dd className="m-0 font-mono wrap-break-word text-on-surface">
              <div>{preview.publisherKeyId}</div>
              <div>{preview.publisherFingerprint}</div>
            </dd>
            <dt className="text-neutral">{t("plugins.packages.runtime")}</dt>
            <dd className="m-0 text-on-surface">{preview.runtimeKind}</dd>
            <dt className="text-neutral">{t("plugins.packages.capabilities")}</dt>
            <dd className="m-0 wrap-break-word text-on-surface">
              {preview.capabilities.length > 0 ? preview.capabilities.join(", ") : "—"}
            </dd>
            <dt className="text-neutral">{t("plugins.packages.network")}</dt>
            <dd className="m-0 wrap-break-word text-on-surface">
              {preview.fixedNetworkAuthority.length > 0
                ? preview.fixedNetworkAuthority
                    .map((entry) => `${entry.method} ${entry.origin} (${entry.endpointId})`)
                    .join("; ")
                : "—"}
            </dd>
            <dt className="text-neutral">{t("plugins.packages.authPolicies")}</dt>
            <dd className="m-0 wrap-break-word text-on-surface">
              {preview.authPolicies.length > 0 ? preview.authPolicies.join(", ") : "—"}
            </dd>
            {preview.resourceLimits ? (
              <>
                <dt className="text-neutral">{t("plugins.packages.defaultActivation.resourceLimits")}</dt>
                <dd className="m-0 font-mono text-on-surface">{`req ${preview.resourceLimits.maxRequestBytes}/res ${preview.resourceLimits.maxResponseBytes}/stream ${preview.resourceLimits.maxStreamBytes}/${preview.resourceLimits.timeoutMs}ms`}</dd>
              </>
            ) : null}
          </dl>
          {preview.dynamicAuthorityWarnings.length > 0 ? (
            <ul className="m-0 list-disc space-y-1 pl-5 text-error">
              {preview.dynamicAuthorityWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {preview.requiresInstanceConfirmationForDynamicOrigins ? (
            <p className="text-neutral" role="note">
              {t("plugins.packages.defaultActivation.dynamicOriginsNote")}
            </p>
          ) : null}
          <p className="text-error" role="alert">
            {t("plugins.packages.defaultActivation.authorityWarning")}
          </p>
          <label className="flex items-start gap-2 text-on-surface">
            <Checkbox.Root
              checked={acknowledged}
              onCheckedChange={(checked) => setAcknowledged(checked === true)}
              className={checkboxClassName}
            >
              <Checkbox.Indicator className={checkboxIndicatorClassName}>
                <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
              </Checkbox.Indicator>
            </Checkbox.Root>
            <span>{t("plugins.packages.defaultActivation.ackLabel")}</span>
          </label>
        </>
      ) : null}
    </div>
  );

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          resetAcknowledgement();
        }
        onOpenChange(nextOpen);
      }}
      title={t("plugins.packages.defaultActivation.dialogTitle")}
      description={description}
      confirmText={t("plugins.packages.defaultActivation.confirm")}
      pendingText={t("plugins.packages.defaultActivation.confirming")}
      confirmDisabled={confirmDisabled}
      onConfirm={async () => {
        if (!preview || !acknowledged) {
          throw new Error(t("plugins.packages.defaultActivation.stale"));
        }
        await runAuthorizeDefaultPluginPackage({
          previewId: preview.previewId,
          acknowledgeFutureInstanceAuthority: true,
        });
        await onAuthorized();
      }}
    />
  );
}
