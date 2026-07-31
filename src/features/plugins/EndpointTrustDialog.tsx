// ABOUTME: Acknowledgement-gated custom Edge TTS endpoint review dialog.
// ABOUTME: Shows the exact base URL, speech data category, and fixed request scope before save.
import { useState } from "react";
import { Checkbox } from "@base-ui/react/checkbox";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { checkboxClassName, checkboxIndicatorClassName } from "../../components/ui";
import type { EndpointTrustPreviewDto } from "../../storage/types";
import { buildEndpointTrustSavePayload, type EndpointTrustSavePayload } from "./endpointTrustPresentation";

export type EndpointTrustDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: EndpointTrustPreviewDto | null;
  /** Draft base URL the preview was created for; a change invalidates the preview. */
  candidateBaseUrlAtPreview: string;
  /** Current draft base URL; it may drift while the dialog is open. */
  currentCandidateBaseUrl: string;
  onTrust: (payload: EndpointTrustSavePayload) => void | Promise<void>;
};

export function EndpointTrustDialog(props: EndpointTrustDialogProps) {
  return <EndpointTrustDialogContent key={props.preview?.previewId ?? "empty"} {...props} />;
}

function EndpointTrustDialogContent({
  open,
  onOpenChange,
  preview,
  candidateBaseUrlAtPreview,
  currentCandidateBaseUrl,
  onTrust,
}: EndpointTrustDialogProps) {
  const { t } = useTranslation();
  const [acknowledged, setAcknowledged] = useState(false);

  const description = preview ? (
    <div className="space-y-3 text-body-tight">
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-neutral">{t("plugins.endpointTrust.originLabel")}</dt>
        <dd className="m-0 font-mono wrap-break-word text-on-surface">{preview.origin}</dd>
        <dt className="text-neutral">{t("plugins.endpointTrust.requestLabel")}</dt>
        <dd className="m-0 font-mono text-on-surface">
          {preview.method} /{preview.relativePath}
        </dd>
        <dt className="text-neutral">{t("plugins.endpointTrust.dataLabel")}</dt>
        <dd className="m-0 text-on-surface">{t("plugins.endpointTrust.dataSpeech")}</dd>
      </dl>
      <p className="text-error" role="alert">
        {t("plugins.endpointTrust.warning")}
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
        <span>{t("plugins.endpointTrust.ackLabel")}</span>
      </label>
    </div>
  ) : null;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setAcknowledged(false);
        }
        onOpenChange(nextOpen);
      }}
      title={t("plugins.endpointTrust.dialogTitle")}
      description={description}
      confirmText={t("plugins.endpointTrust.confirm")}
      pendingText={t("common.saving")}
      confirmDisabled={!acknowledged || !preview}
      onConfirm={async () => {
        if (!preview) {
          throw new Error(t("plugins.endpointTrust.stale"));
        }
        const payload = buildEndpointTrustSavePayload({
          preview,
          acknowledged,
          candidateBaseUrlAtPreview,
          currentCandidateBaseUrl,
        });
        if (!payload) {
          throw new Error(t("plugins.endpointTrust.stale"));
        }
        await onTrust(payload);
      }}
    />
  );
}
