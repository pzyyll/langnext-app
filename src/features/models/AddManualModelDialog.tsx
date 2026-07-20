// ABOUTME: Dialog for adding a manual model to the selected provider.
// ABOUTME: Persists model identity, display override, optional API Type, and enabled state through IPC.
import { useState } from "react";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { Dialog } from "@base-ui/react/dialog";
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
import { SelectField } from "../../components/SelectField";
import { useToast } from "../../components/toast/useToast";
import { saveManualModel } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { ProviderModelDto } from "../../storage/types";
import { ADAPTER_OPTIONS } from "./adapterOptions";

export type AddManualModelDialogProps = {
  open: boolean;
  providerId: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (model: ProviderModelDto) => void;
};

export function AddManualModelDialog({ open, providerId, onOpenChange, onCreated }: AddManualModelDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdropClassName} />
        <Dialog.Popup className={dialogPopupClassName}>
          <div className="flex flex-col gap-1">
            <Dialog.Title className="text-title-dialog font-bold text-on-surface">
              {t("models.addModelDialog.title")}
            </Dialog.Title>
            <Dialog.Description className="text-body-tight text-neutral">
              {t("models.addModelDialog.description")}
            </Dialog.Description>
          </div>
          {open ? (
            <AddManualModelForm
              providerId={providerId}
              onCreated={(model) => {
                onCreated(model);
                onOpenChange(false);
              }}
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type AddManualModelFormProps = {
  providerId: string;
  onCreated: (model: ProviderModelDto) => void;
};

function AddManualModelForm({ providerId, onCreated }: AddManualModelFormProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [modelKey, setModelKey] = useState("");
  const [displayNameOverride, setDisplayNameOverride] = useState("");
  /** Empty string means inherit the channel API Type. */
  const [adapterId, setAdapterId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = modelKey.trim().length > 0 && !pending;

  async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    setPending(true);
    setError(null);
    try {
      const created = await saveManualModel({
        id: null,
        providerInstanceId: providerId,
        modelKey: modelKey.trim(),
        displayNameOverride: displayNameOverride.trim() ? displayNameOverride.trim() : null,
        enabled,
        capabilityOverridesJson: null,
        adapterId: adapterId.trim() ? adapterId.trim() : null,
      });
      toast.success({
        title: t("models.toast.modelAdded"),
        description: created.displayNameOverride ?? created.modelKey,
      });
      onCreated(created);
    } catch (err: unknown) {
      const message = getIpcErrorMessage(err, t("models.toast.addModelFailedDesc"));
      setError(message);
      toast.error({ title: t("models.toast.addModelFailed"), description: message });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)}>
      <div className="flex flex-col gap-1">
        <label className="text-body-tight font-medium text-on-surface" htmlFor="add-model-key">
          {t("models.addModelDialog.modelId")}
        </label>
        <Input
          id="add-model-key"
          className={`
            ${inputClassName}
            font-mono
          `}
          value={modelKey}
          onChange={(event) => {
            setModelKey(event.currentTarget.value);
          }}
          maxLength={256}
          required
          autoFocus
          spellCheck={false}
          disabled={pending}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-body-tight font-medium text-on-surface" htmlFor="add-model-display-name">
          {t("models.addModelDialog.displayNameOverride")}
        </label>
        <Input
          id="add-model-display-name"
          className={inputClassName}
          value={displayNameOverride}
          onChange={(event) => {
            setDisplayNameOverride(event.currentTarget.value);
          }}
          placeholder={t("common.optional")}
          disabled={pending}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-body-tight font-medium text-on-surface" id="add-model-api-type-label">
          {t("models.apiTypeLabel")}
        </label>
        <SelectField
          value={adapterId}
          onValueChange={(value) => setAdapterId(value ?? "")}
          options={[
            { value: "", label: t("models.apiTypeInherit") },
            ...ADAPTER_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
          ]}
          disabled={pending}
          aria-labelledby="add-model-api-type-label"
        />
        <p className="text-xs text-neutral">{t("models.apiTypeModelHint")}</p>
      </div>

      <label className="flex items-center gap-2 text-body-tight text-on-surface">
        <Checkbox.Root
          className={checkboxClassName}
          checked={enabled}
          onCheckedChange={(checked) => {
            setEnabled(checked);
          }}
          disabled={pending}
        >
          <Checkbox.Indicator className={checkboxIndicatorClassName}>
            <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
          </Checkbox.Indicator>
        </Checkbox.Root>
        {t("common.enabled")}
      </label>

      {error ? (
        <p className="text-body-tight text-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-3 pt-1">
        <Dialog.Close className={outlineButtonClassName} disabled={pending}>
          {t("common.cancel")}
        </Dialog.Close>
        <Button type="submit" className={primaryButtonClassName} disabled={!canSubmit} focusableWhenDisabled>
          {pending ? t("common.adding") : t("models.addModelDialog.submit")}
        </Button>
      </div>
    </form>
  );
}
