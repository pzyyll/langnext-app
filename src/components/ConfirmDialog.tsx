// ABOUTME: Generic confirmation dialog built on Base UI Dialog.
// ABOUTME: Handles pending state, errors, and optional danger styling for destructive actions.
import { useState } from "react";
import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import {
  dangerButtonClassName,
  dialogBackdropClassName,
  dialogPopupClassName,
  outlineButtonClassName,
  primaryButtonClassName,
} from "./ui";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  pendingText?: string;
  onConfirm: () => void | Promise<void>;
  danger?: boolean;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText,
  pendingText,
  onConfirm,
  danger = false,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolvedConfirmText = confirmText ?? t("common.confirm");
  const resolvedCancelText = cancelText ?? t("common.cancel");
  const resolvedPendingText = pendingText ?? `${resolvedConfirmText}…`;

  async function handleConfirm() {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setPending(false);
      setError(null);
      onOpenChange(false);
    } catch (err: unknown) {
      setError((err as Error)?.message ?? String(err));
      setPending(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) {
          return;
        }
        if (!nextOpen) {
          setError(null);
          setPending(false);
        }
        onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdropClassName} />
        <Dialog.Popup className={dialogPopupClassName}>
          <div className="flex flex-col gap-1">
            <Dialog.Title className="text-title-dialog font-bold text-on-surface">{title}</Dialog.Title>
            <Dialog.Description className="text-body-tight text-neutral">{description ?? ""}</Dialog.Description>
          </div>

          {error ? (
            <p className="text-body-tight text-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-3 pt-1">
            <Dialog.Close className={outlineButtonClassName} disabled={pending}>
              {resolvedCancelText}
            </Dialog.Close>
            <Button
              type="button"
              className={danger ? dangerButtonClassName : primaryButtonClassName}
              disabled={pending}
              focusableWhenDisabled
              onClick={() => {
                void handleConfirm();
              }}
            >
              {pending ? resolvedPendingText : resolvedConfirmText}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
