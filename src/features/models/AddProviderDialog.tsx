// ABOUTME: Dialog for creating a real provider instance through Tauri IPC.
// ABOUTME: Collects adapter, endpoint, credential policy, and initial enabled state.
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
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
import { saveProviderInstance } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { CredentialKind, CredentialUpdate, ProviderInstanceDto } from "../../storage/types";
import { getDefaultBaseUrl, listAdapterOptions, resolveAuthScheme, resolveBaseUrlFields } from "./adapterOptions";

export type AddProviderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (provider: ProviderInstanceDto) => void;
};

export function AddProviderDialog({ open, onOpenChange, onCreated }: AddProviderDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdropClassName} />
        <Dialog.Popup
          className={`
            ${dialogPopupClassName}
            max-h-[min(90dvh,40rem)] w-md overflow-y-auto
          `}
        >
          <div className="flex flex-col gap-1">
            <Dialog.Title className="text-title-dialog font-bold text-on-surface">
              {t("models.addChannel.title")}
            </Dialog.Title>
            <Dialog.Description className="text-body-tight text-neutral">
              {t("models.addChannel.description")}
            </Dialog.Description>
          </div>
          {open ? (
            <AddProviderForm
              onCreated={(provider) => {
                onCreated(provider);
                onOpenChange(false);
              }}
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type AddProviderFormProps = {
  onCreated: (provider: ProviderInstanceDto) => void;
};

function AddProviderForm({ onCreated }: AddProviderFormProps) {
  const { t } = useTranslation();
  const toast = useToast();
  // Registered plugins are fixed at module load; options are stable for the dialog's lifetime.
  const adapterOptions = useMemo(() => listAdapterOptions(), []);
  const [displayName, setDisplayName] = useState("");
  const [adapterId, setAdapterId] = useState(adapterOptions[0]?.id ?? "openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [credentialKind, setCredentialKind] = useState<CredentialKind>("api_key");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: saveProviderInstance,
    onSuccess: (created) => {
      toast.success({ title: t("models.toast.channelCreated"), description: created.displayName });
      onCreated(created);
    },
    onError: (err: unknown) => {
      const message = getIpcErrorMessage(err, t("models.toast.createChannelFailed"));
      setError(message);
      toast.error({ title: t("models.toast.createFailed"), description: message });
    },
  });

  const pending = createMutation.isPending;
  const defaultBaseUrl = getDefaultBaseUrl(adapterId);
  const canSubmit = displayName.trim().length > 0 && !pending;

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    const kind = credentialKind;
    const baseUrlFields = resolveBaseUrlFields(adapterId, baseUrl);
    if ("error" in baseUrlFields) {
      setError(t("models.errors.baseUrlRequired"));
      return;
    }
    let credential: CredentialUpdate;
    if (kind === "none") {
      credential = { action: "clear" };
    } else if (token.trim()) {
      credential = { action: "replace", value: token.trim() };
    } else {
      credential = { action: "keep" };
    }

    setError(null);
    createMutation.mutate({
      id: null,
      adapterId,
      displayName: displayName.trim(),
      baseUrl: baseUrlFields.baseUrl,
      baseUrlSource: baseUrlFields.baseUrlSource,
      authScheme: resolveAuthScheme(adapterId, kind),
      credentialKind: kind,
      credential,
      enabled,
      proxyMode: "inherit",
      insecureHttpConfirmedAt: null,
    });
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)}>
      <div className="flex flex-col gap-1">
        <label className="text-body-tight font-medium text-on-surface" htmlFor="add-provider-name">
          {t("models.displayName")}
        </label>
        <Input
          id="add-provider-name"
          className={inputClassName}
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.currentTarget.value);
          }}
          maxLength={200}
          required
          autoFocus
          disabled={pending}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-body-tight font-medium text-on-surface" id="add-provider-adapter-label">
          {t("models.apiTypeLabel")}
        </label>
        <SelectField
          value={adapterId}
          onValueChange={(value) => setAdapterId(value ?? adapterOptions[0]?.id ?? "")}
          options={adapterOptions.map((option) => ({ value: option.id, label: option.label }))}
          disabled={pending}
          aria-labelledby="add-provider-adapter-label"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-body-tight font-medium text-on-surface" htmlFor="add-provider-base-url">
          {t("models.baseUrl")}
        </label>
        <Input
          id="add-provider-base-url"
          className={inputClassName}
          value={baseUrl}
          onChange={(event) => {
            setBaseUrl(event.currentTarget.value);
          }}
          placeholder={defaultBaseUrl ?? t("common.optional")}
          spellCheck={false}
          disabled={pending}
        />
        {defaultBaseUrl ? (
          <p className="text-xs text-neutral">{t("common.default", { value: defaultBaseUrl })}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-body-tight font-medium text-on-surface" id="add-provider-credential-kind-label">
          {t("models.credentialKind")}
        </label>
        <SelectField
          value={credentialKind}
          onValueChange={(value) => setCredentialKind((value ?? "api_key") as CredentialKind)}
          options={[
            { value: "api_key", label: t("models.credentialApiKey") },
            { value: "bearer", label: t("models.credentialBearer") },
            { value: "none", label: t("models.credentialNone") },
          ]}
          disabled={pending}
          aria-labelledby="add-provider-credential-kind-label"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-body-tight font-medium text-on-surface" htmlFor="add-provider-token">
          {t("models.apiToken")}
        </label>
        <Input
          id="add-provider-token"
          className={inputClassName}
          type="password"
          value={token}
          onChange={(event) => {
            setToken(event.currentTarget.value);
          }}
          placeholder={credentialKind === "none" ? t("models.addChannel.tokenNotUsed") : t("common.optional")}
          spellCheck={false}
          autoComplete="off"
          disabled={pending || credentialKind === "none"}
        />
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
        {t("models.channelEnabled")}
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
          {pending ? t("common.creating") : t("models.addChannel.create")}
        </Button>
      </div>
    </form>
  );
}
