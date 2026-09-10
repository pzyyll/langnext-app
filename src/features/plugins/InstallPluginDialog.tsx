// ABOUTME: User `.lnplugin` selection, permission review, and one exact-digest install confirmation.
// ABOUTME: Uses feature Effect runners for dialog→inspect→install/discard; Rust owns validation.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import {
  checkboxClassName,
  checkboxIndicatorClassName,
  dialogBackdropClassName,
  dialogPopupClassName,
  outlineButtonClassName,
  primaryButtonClassName,
} from "../../components/ui";
import { useToast } from "../../components/toast/useToast";
import { pluginPackageKeys } from "../../query/keys";
import { getIpcErrorMessage } from "../../storage/errors";
import type { UserPackagePreviewDto } from "../../storage/types";
import { getUserErrorMessage } from "../userErrorMessage";
import {
  runDiscardUserPluginPackagePreview,
  runInstallUserPluginPackage,
  runSelectAndPreviewUserPluginPackage,
} from "./installPluginPackageFlow";
import {
  confirmationDigest,
  isUserInstallableRuntime,
  summarizeArchiveFiles,
  summarizeNetworkPermissions,
} from "./pluginPackagePresentation";

export type InstallPluginDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function InstallPluginDialog({ open, onOpenChange }: InstallPluginDialogProps) {
  const { t } = useTranslation();
  const previewIdRef = useRef<string | null>(null);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && previewIdRef.current) {
          const previewId = previewIdRef.current;
          previewIdRef.current = null;
          void runDiscardUserPluginPackagePreview(previewId).catch(() => {
            // Best-effort cleanup on Esc/backdrop close; the backend also expires previews.
          });
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdropClassName} />
        <Dialog.Popup
          className={`
            ${dialogPopupClassName}
            max-h-[min(90vh,40rem)] w-lg overflow-y-auto
          `}
        >
          <Dialog.Title className="text-title-dialog font-bold text-on-surface">
            {t("plugins.packages.installTitle")}
          </Dialog.Title>
          {open ? (
            <InstallPluginForm
              onClose={() => onOpenChange(false)}
              onPreviewIdChange={(id) => {
                previewIdRef.current = id;
              }}
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type InstallPluginFormProps = {
  onClose: () => void;
  onPreviewIdChange: (previewId: string | null) => void;
};

function InstallPluginForm({ onClose, onPreviewIdChange }: InstallPluginFormProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<UserPackagePreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ackPermissions, setAckPermissions] = useState(false);

  useEffect(() => {
    onPreviewIdChange(preview?.previewId ?? null);
  }, [preview, onPreviewIdChange]);

  const previewMutation = useMutation({
    mutationFn: () => runSelectAndPreviewUserPluginPackage(),
    onSuccess: (result) => {
      if (!result) {
        return;
      }
      setPreview(result);
      setError(null);
      setAckPermissions(false);
    },
    onError: (mutationError) => {
      const message = getUserErrorMessage(mutationError, t("plugins.packages.previewFailed"));
      setError(message);
      toast.error({ title: t("plugins.packages.previewFailed"), description: message });
    },
  });

  const installMutation = useMutation({
    mutationFn: async () => {
      if (!preview) {
        throw new Error("missing preview");
      }
      return runInstallUserPluginPackage({
        previewId: preview.previewId,
        contentDigest: confirmationDigest(preview),
        acknowledgePermissions: ackPermissions,
      });
    },
    onSuccess: async () => {
      onPreviewIdChange(null);
      setPreview(null);
      await queryClient.invalidateQueries({ queryKey: pluginPackageKeys.all });
      toast.success({ title: t("plugins.packages.installSuccess") });
      onClose();
    },
    onError: (mutationError) => {
      const message = getIpcErrorMessage(mutationError, t("plugins.packages.installFailed"));
      setError(message);
      toast.error({ title: t("plugins.packages.installFailed"), description: message });
    },
  });

  const discardMutation = useMutation({
    mutationFn: async () => {
      if (preview) {
        await runDiscardUserPluginPackagePreview(preview.previewId);
      }
    },
    onSettled: () => {
      onPreviewIdChange(null);
      setPreview(null);
      onClose();
    },
  });

  const network = preview ? summarizeNetworkPermissions(preview.network) : [];
  const installable = preview ? isUserInstallableRuntime(preview.runtimeKind) : false;

  return (
    <div className="mt-4 flex flex-col gap-4">
      {!preview ? (
        <>
          <p className="text-body-tight text-neutral">{t("plugins.packages.installDescription")}</p>
          <Button
            type="button"
            className={primaryButtonClassName}
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending ? t("plugins.packages.previewing") : t("plugins.packages.chooseFile")}
          </Button>
        </>
      ) : (
        <>
          <p className="text-body-tight text-neutral">{t("plugins.packages.userContentWarning")}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body-tight">
            <dt className="text-neutral">{t("plugins.packages.pluginId")}</dt>
            <dd className="font-mono text-on-surface">{preview.pluginId}</dd>
            <dt className="text-neutral">{t("plugins.packages.version")}</dt>
            <dd className="text-on-surface">{preview.version}</dd>
            <dt className="text-neutral">{t("plugins.packages.digest")}</dt>
            <dd className="font-mono wrap-break-word text-on-surface" title={preview.contentDigest}>
              {preview.contentDigest}
            </dd>
            <dt className="text-neutral">{t("plugins.packages.runtime")}</dt>
            <dd className="text-on-surface">{preview.runtimeKind}</dd>
            <dt className="text-neutral">{t("plugins.packages.files")}</dt>
            <dd className="text-on-surface">{summarizeArchiveFiles(preview)}</dd>
            <dt className="text-neutral">{t("plugins.packages.capabilities")}</dt>
            <dd className="text-on-surface">{preview.capabilities.join(", ") || "—"}</dd>
          </dl>

          {network.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-body-tight font-bold text-on-surface">{t("plugins.packages.network")}</p>
              <ul className="list-disc space-y-1 pl-5 text-body-tight text-neutral">
                {network.map((item) => (
                  <li key={item.id}>
                    <span className="font-mono text-on-surface">{item.id}</span>: {item.summary}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.authPolicies.length > 0 ? (
            <p className="text-body-tight text-neutral">
              {t("plugins.packages.authPolicies")}: {preview.authPolicies.join(", ")}
            </p>
          ) : null}

          {preview.credentialSlots.length > 0 ? (
            <p className="text-body-tight text-neutral">
              {t("plugins.packages.credentialSlots")}: {preview.credentialSlots.join(", ")}
            </p>
          ) : null}

          {preview.permissionDifferences.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-body-tight font-bold text-on-surface">{t("plugins.packages.permissionDiffs")}</p>
              <ul className="list-disc space-y-1 pl-5 font-mono text-code-inline text-neutral">
                {preview.permissionDifferences.map((diff) => (
                  <li key={diff}>{diff}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.warnings.length > 0 ? (
            <ul className="space-y-1 border border-line bg-surface-2 p-3 text-body-tight text-neutral">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}

          <p className="text-body-tight text-neutral">{t("plugins.packages.executionGrantNote")}</p>

          <label className="flex items-start gap-2 text-body-tight text-on-surface">
            <Checkbox.Root
              checked={ackPermissions}
              onCheckedChange={(checked) => setAckPermissions(checked === true)}
              className={checkboxClassName}
            >
              <Checkbox.Indicator className={checkboxIndicatorClassName}>
                <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
              </Checkbox.Indicator>
            </Checkbox.Root>
            <span>{t("plugins.packages.ackPermissions")}</span>
          </label>
        </>
      )}

      {error ? (
        <p className="text-body-tight text-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          className={outlineButtonClassName}
          disabled={installMutation.isPending}
          onClick={() => discardMutation.mutate()}
        >
          {t("common.cancel")}
        </Button>
        {preview ? (
          <Button
            type="button"
            className={primaryButtonClassName}
            disabled={installMutation.isPending || !ackPermissions || !installable}
            onClick={() => installMutation.mutate()}
          >
            {installMutation.isPending ? t("plugins.packages.installing") : t("plugins.packages.install")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
