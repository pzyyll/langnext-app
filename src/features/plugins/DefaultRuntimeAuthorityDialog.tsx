// ABOUTME: Subject-bound dialog for additional runtime authority beyond the default policy.
// ABOUTME: Confirms by opaque preview ID only; never mutates the default package policy.
import { Checkbox } from "@base-ui/react/checkbox";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { checkboxClassName, checkboxIndicatorClassName } from "../../components/ui";
import { getIpcErrorMessage } from "../../storage/errors";
import { runConfirmDefaultRuntimeAuthority, runPreviewDefaultRuntimeAuthority } from "./defaultPackageActivationFlow";
import { useAcknowledgedPreviewDialog } from "./useAcknowledgedPreviewDialog";

export type DefaultRuntimeAuthorityDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subjectKind: "integration_instance" | "provider_instance";
  subjectId: string | null;
  onConfirmed: () => void | Promise<void>;
};

export function DefaultRuntimeAuthorityDialog(props: DefaultRuntimeAuthorityDialogProps) {
  const sessionKey = props.open && props.subjectId ? `${props.subjectKind}:${props.subjectId}` : "closed";
  return <DefaultRuntimeAuthorityDialogContent key={sessionKey} {...props} />;
}

function DefaultRuntimeAuthorityDialogContent({
  open,
  onOpenChange,
  subjectKind,
  subjectId,
  onConfirmed,
}: DefaultRuntimeAuthorityDialogProps) {
  const { t } = useTranslation();
  const sessionKey = open && subjectId ? `${subjectKind}:${subjectId}` : "closed";
  const { preview, loading, loadError, acknowledged, setAcknowledged, confirmDisabled, resetAcknowledgement } =
    useAcknowledgedPreviewDialog({
      active: Boolean(open && subjectId),
      sessionKey,
      loadPreview: () => {
        if (!subjectId) {
          return Promise.reject(new Error(t("plugins.packages.defaultActivation.authority.previewFailed")));
        }
        return runPreviewDefaultRuntimeAuthority({ subjectKind, subjectId });
      },
      fallbackError: t("plugins.packages.defaultActivation.authority.previewFailed"),
      formatError: getIpcErrorMessage,
    });

  const description = (
    <div className="space-y-3 text-body-tight">
      {loading ? <p className="text-neutral">{t("plugins.packages.defaultActivation.authority.previewing")}</p> : null}
      {loadError ? (
        <p className="text-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {preview ? (
        <>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-neutral">{t("plugins.packages.digest")}</dt>
            <dd className="m-0 font-mono wrap-break-word text-on-surface">{preview.packageDigest}</dd>
            <dt className="text-neutral">{t("plugins.packages.network")}</dt>
            <dd className="m-0 wrap-break-word text-on-surface">
              {preview.additionalNetworkAuthority
                .map((entry) => {
                  const limits = entry.resourceLimits
                    ? ` req ${entry.resourceLimits.maxRequestBytes}/res ${entry.resourceLimits.maxResponseBytes}/stream ${entry.resourceLimits.maxStreamBytes}/${entry.resourceLimits.timeoutMs}ms`
                    : "";
                  return `${entry.method} ${entry.origin} (${entry.endpointId})${limits}`;
                })
                .join("; ")}
            </dd>
            {preview.additionalNetworkAuthority.map((entry) => (
              <AuthorityEntryDetails key={`${entry.endpointId}:${entry.origin}:${entry.method}`} entry={entry} />
            ))}
            <dt className="text-neutral">{t("plugins.packages.authPolicies")}</dt>
            <dd className="m-0 wrap-break-word text-on-surface">
              {preview.authPolicies.length > 0 ? preview.authPolicies.join(", ") : "—"}
            </dd>
          </dl>
          <p className="text-error" role="alert">
            {t("plugins.packages.defaultActivation.authority.warning")}
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
            <span>{t("plugins.packages.defaultActivation.authority.ackLabel")}</span>
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
      title={t("plugins.packages.defaultActivation.authority.dialogTitle")}
      description={description}
      confirmText={t("plugins.packages.defaultActivation.authority.confirm")}
      pendingText={t("plugins.packages.defaultActivation.authority.confirming")}
      confirmDisabled={confirmDisabled}
      onConfirm={async () => {
        if (!preview || !acknowledged) {
          throw new Error(t("plugins.packages.defaultActivation.authority.stale"));
        }
        await runConfirmDefaultRuntimeAuthority({
          previewId: preview.previewId,
          acknowledgeAdditionalAuthority: true,
        });
        await onConfirmed();
      }}
    />
  );
}

function AuthorityEntryDetails({
  entry,
}: {
  entry: {
    baseUrl?: string | null;
    responseBodyModes?: string | null;
    origin: string;
    endpointId: string;
  };
}) {
  const { t } = useTranslation();
  if (!entry.baseUrl && !entry.responseBodyModes) {
    return null;
  }
  return (
    <>
      {entry.baseUrl ? (
        <>
          <dt className="text-neutral">{t("plugins.packages.defaultActivation.authority.baseUrl")}</dt>
          <dd
            className="m-0 font-mono wrap-break-word text-on-surface"
            data-testid={`authority-base-url-${entry.endpointId}`}
          >
            {entry.baseUrl}
          </dd>
        </>
      ) : null}
      {entry.responseBodyModes ? (
        <>
          <dt className="text-neutral">{t("plugins.packages.defaultActivation.authority.responseBodyModes")}</dt>
          <dd
            className="m-0 font-mono wrap-break-word text-on-surface"
            data-testid={`authority-response-modes-${entry.endpointId}`}
          >
            {entry.responseBodyModes}
          </dd>
        </>
      ) : null}
    </>
  );
}
