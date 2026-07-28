// ABOUTME: Local `.lnplugin` selection, permission review, and install approval dialog.
// ABOUTME: Uses feature Effect runners for dialog→preview→approve/discard; Rust owns verification.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { Input } from "@base-ui/react/input";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import {
  checkboxClassName,
  checkboxIndicatorClassName,
  dialogBackdropClassName,
  dialogPopupClassName,
  inputClassName,
  outlineButtonClassName,
  primaryButtonClassName,
} from "../../components/ui";
import { useToast } from "../../components/toast/useToast";
import { pluginPackageKeys } from "../../query/keys";
import { getIpcErrorMessage } from "../../storage/errors";
import type { PluginPackagePreviewDto, PublisherTrustState } from "../../storage/types";
import { getUserErrorMessage } from "../userErrorMessage";
import {
  runApprovePluginPackage,
  runDiscardPluginPackagePreview,
  runSelectAndPreviewPluginPackage,
} from "./installPluginPackageFlow";
import { requiresPublisherApproval, summarizeNetworkPermissions } from "./pluginPackagePresentation";

function trustLabel(
  t: (
    key:
      | "plugins.packages.trust.trustedVendor"
      | "plugins.packages.trust.trustedUser"
      | "plugins.packages.trust.unknown"
      | "plugins.packages.trust.revoked"
      | "plugins.packages.trust.disabled",
  ) => string,
  trust: PublisherTrustState,
): string {
  switch (trust) {
    case "trusted_vendor":
      return t("plugins.packages.trust.trustedVendor");
    case "trusted_user":
      return t("plugins.packages.trust.trustedUser");
    case "unknown":
      return t("plugins.packages.trust.unknown");
    case "revoked":
      return t("plugins.packages.trust.revoked");
    case "disabled":
      return t("plugins.packages.trust.disabled");
  }
}

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
          void runDiscardPluginPackagePreview(previewId).catch(() => {
            // Best-effort cleanup on Esc/backdrop close; backend also TTL-sweeps.
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
  const [preview, setPreview] = useState<PluginPackagePreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ackPermissions, setAckPermissions] = useState(false);
  const [approvePublisher, setApprovePublisher] = useState(false);
  const [setAsDefault, setSetAsDefault] = useState(true);
  const [publicKeyHex, setPublicKeyHex] = useState("");

  useEffect(() => {
    onPreviewIdChange(preview?.previewId ?? null);
  }, [preview, onPreviewIdChange]);

  const previewMutation = useMutation({
    mutationFn: () => runSelectAndPreviewPluginPackage(),
    onSuccess: (result) => {
      if (!result) {
        return;
      }
      setPreview(result);
      setError(null);
      setAckPermissions(false);
      setApprovePublisher(false);
      setPublicKeyHex("");
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
      return runApprovePluginPackage({
        previewId: preview.previewId,
        acknowledgePermissions: ackPermissions,
        approvePublisher: requiresPublisherApproval(preview) ? approvePublisher : false,
        publisherPublicKeyHex:
          requiresPublisherApproval(preview) && approvePublisher ? publicKeyHex.trim() || null : null,
        setAsDefault,
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
        await runDiscardPluginPackagePreview(preview.previewId);
      }
    },
    onSettled: () => {
      onPreviewIdChange(null);
      setPreview(null);
      onClose();
    },
  });

  const network = preview ? summarizeNetworkPermissions(preview.network) : [];

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
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body-tight">
            <dt className="text-neutral">{t("plugins.packages.pluginId")}</dt>
            <dd className="font-mono text-on-surface">{preview.pluginId}</dd>
            <dt className="text-neutral">{t("plugins.packages.version")}</dt>
            <dd className="text-on-surface">{preview.version}</dd>
            <dt className="text-neutral">{t("plugins.packages.digest")}</dt>
            <dd className="font-mono wrap-break-word text-on-surface" title={preview.packageDigest}>
              {preview.packageDigest}
            </dd>
            <dt className="text-neutral">{t("plugins.packages.publisher")}</dt>
            <dd className="text-on-surface">
              <div>{preview.publisherKeyId}</div>
              <div className="font-mono text-code-inline wrap-break-word" title={preview.publisherFingerprint}>
                {preview.publisherFingerprint}
              </div>
              <div className="text-neutral">{trustLabel(t, preview.publisherTrust)}</div>
            </dd>
            <dt className="text-neutral">{t("plugins.packages.runtime")}</dt>
            <dd className="text-on-surface">{preview.runtimeKind}</dd>
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

          {requiresPublisherApproval(preview) ? (
            <div className="flex flex-col gap-2">
              <label className="flex items-start gap-2 text-body-tight text-on-surface">
                <Checkbox.Root
                  checked={approvePublisher}
                  onCheckedChange={(checked) => setApprovePublisher(checked === true)}
                  className={checkboxClassName}
                >
                  <Checkbox.Indicator className={checkboxIndicatorClassName}>
                    <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <span>{t("plugins.packages.approvePublisher")}</span>
              </label>
              {approvePublisher ? (
                <label className="flex flex-col gap-1 text-body-tight text-on-surface">
                  <span>{t("plugins.packages.publicKeyLabel")}</span>
                  <Input
                    className={`
                      ${inputClassName}
                      font-mono text-code-inline
                    `}
                    placeholder={t("plugins.packages.publicKeyPlaceholder")}
                    value={publicKeyHex}
                    onChange={(event) => setPublicKeyHex(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    aria-required
                  />
                </label>
              ) : null}
            </div>
          ) : null}

          <label className="flex items-start gap-2 text-body-tight text-on-surface">
            <Checkbox.Root
              checked={setAsDefault}
              onCheckedChange={(checked) => setSetAsDefault(checked === true)}
              className={checkboxClassName}
            >
              <Checkbox.Indicator className={checkboxIndicatorClassName}>
                <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
              </Checkbox.Indicator>
            </Checkbox.Root>
            <span>{t("plugins.packages.setAsDefault")}</span>
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
            disabled={
              installMutation.isPending ||
              !ackPermissions ||
              (requiresPublisherApproval(preview) && (!approvePublisher || publicKeyHex.trim().length === 0))
            }
            onClick={() => installMutation.mutate()}
          >
            {installMutation.isPending ? t("plugins.packages.installing") : t("plugins.packages.install")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
