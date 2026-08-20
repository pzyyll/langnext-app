// ABOUTME: Shared default-runtime activation status, retry, and authority confirmation UI.
// ABOUTME: Parameterized by subject kind/id and caller-owned cache invalidation.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@base-ui/react/button";
import { useTranslation } from "react-i18next";
import { useToast } from "../../components/toast/useToast";
import { outlineButtonClassName, primaryButtonClassName } from "../../components/ui";
import { getIpcErrorMessage } from "../../storage/errors";
import { DefaultRuntimeAuthorityDialog } from "./DefaultRuntimeAuthorityDialog";
import { runRetryDefaultRuntimeActivation } from "./defaultPackageActivationFlow";
import {
  isAuthorityConfirmationRequired,
  presentDefaultRuntimeActivation,
} from "./defaultPackageActivationPresentation";

export type DefaultRuntimeActivationStatusProps = {
  subjectKind: "integration_instance" | "provider_instance";
  subjectId: string;
  runtimeState?: string | null;
  runtimeErrorCode?: string | null;
  retainedPackageDigest?: string | null;
  className?: string;
  /** Caller-owned query invalidation after retry or authority confirmation. */
  onInvalidate: () => Promise<void> | void;
};

export function DefaultRuntimeActivationStatus({
  subjectKind,
  subjectId,
  runtimeState,
  runtimeErrorCode,
  retainedPackageDigest,
  className,
  onInvalidate,
}: DefaultRuntimeActivationStatusProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [authorityOpen, setAuthorityOpen] = useState(false);
  const presentation = presentDefaultRuntimeActivation({
    runtimeState,
    runtimeErrorCode,
    hasAuthorizedDefault: Boolean(retainedPackageDigest),
    authorityConfirmationRequired: isAuthorityConfirmationRequired(runtimeErrorCode),
  });

  const retryMutation = useMutation({
    mutationFn: () =>
      runRetryDefaultRuntimeActivation({
        subjectKind,
        subjectId,
      }),
    onSuccess: async () => {
      await onInvalidate();
      toast.success({ title: t("plugins.packages.defaultActivation.runtime.retry") });
    },
    onError: (error) => {
      toast.error({
        title: t("plugins.packages.defaultActivation.runtime.unavailable"),
        description: getIpcErrorMessage(error, t("plugins.packages.defaultActivation.runtime.unavailableDescription")),
      });
    },
  });

  if (presentation.state === "idle" || presentation.state === "active") {
    return null;
  }

  return (
    <div className={className ?? "space-y-2 border border-line bg-surface-2 p-3"}>
      <p className="text-body-tight font-bold text-on-surface">{t(presentation.labelKey)}</p>
      <p className="text-body-tight text-neutral">{t(presentation.descriptionKey)}</p>
      {runtimeErrorCode ? <p className="font-mono text-code-inline text-error">{runtimeErrorCode}</p> : null}
      <div className="flex flex-wrap gap-2">
        {presentation.showRetry ? (
          <Button
            type="button"
            className={outlineButtonClassName}
            disabled={retryMutation.isPending}
            onClick={() => retryMutation.mutate()}
          >
            {t("plugins.packages.defaultActivation.runtime.retry")}
          </Button>
        ) : null}
        {presentation.showAuthorityConfirm ? (
          <Button type="button" className={primaryButtonClassName} onClick={() => setAuthorityOpen(true)}>
            {t("plugins.packages.defaultActivation.runtime.reviewAuthority")}
          </Button>
        ) : null}
      </div>
      <DefaultRuntimeAuthorityDialog
        open={authorityOpen}
        onOpenChange={setAuthorityOpen}
        subjectKind={subjectKind}
        subjectId={subjectId}
        onConfirmed={async () => {
          setAuthorityOpen(false);
          await onInvalidate();
        }}
      />
    </div>
  );
}
