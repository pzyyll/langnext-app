// ABOUTME: Dialog for creating a Baidu or AI OCR service through Tauri IPC.
// ABOUTME: AI create requires at least one configured model; seeds default prompts.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import { dialogBackdropClassName, dialogPopupClassName, outlineButtonClassName } from "../../components/ui";
import { useToast } from "../../components/toast/useToast";
import { allProviderModelsOptions, providerListOptions } from "../../query/options";
import { saveOcrService } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { OcrProviderType, OcrServiceDto, OcrServiceWrite } from "../../storage/types";
import {
  DEFAULT_AI_OCR_PROMPT_TEMPLATE_NAME,
  DEFAULT_AI_OCR_SYSTEM_TEMPLATE,
  DEFAULT_AI_OCR_USER_TEMPLATE,
} from "./defaultAiOcrPrompt";
import { OCR_PROVIDER_OPTIONS } from "./ocrProviderOptions";

const PROVIDER_GRID_MAX_COLUMNS = 3;

export type AddOcrServiceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (service: OcrServiceDto) => void;
};

export function AddOcrServiceDialog({ open, onOpenChange, onCreated }: AddOcrServiceDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdropClassName} />
        <Dialog.Popup
          className={`
            ${dialogPopupClassName}
            w-md
          `}
        >
          <div className="flex flex-col gap-1">
            <Dialog.Title className="text-title-dialog font-bold text-on-surface">{t("ocr.add.title")}</Dialog.Title>
          </div>
          {open ? (
            <AddOcrServiceForm
              onCreated={(service) => {
                onCreated(service);
                onOpenChange(false);
              }}
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type AddOcrServiceFormProps = {
  onCreated: (service: OcrServiceDto) => void;
};

function AddOcrServiceForm({ onCreated }: AddOcrServiceFormProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  const modelsQuery = useQuery(allProviderModelsOptions());
  const providersQuery = useQuery(providerListOptions());

  const modelsPending = modelsQuery.isPending;
  const modelsLoadError = modelsQuery.isError
    ? getIpcErrorMessage(modelsQuery.error, t("ocr.add.modelsLoadFailed"))
    : null;

  const defaultModelId = useMemo(() => {
    if (!modelsQuery.isSuccess) {
      return null;
    }
    const models = modelsQuery.data ?? [];
    const providers = providersQuery.data ?? [];
    const providerNameById = new Map(providers.map((provider) => [provider.id, provider.displayName]));
    const sorted = models
      .filter((model) => model.enabled && model.capabilityOverridesJson?.imageAnalysis === true)
      .slice()
      .sort((a, b) => {
        const providerA = providerNameById.get(a.providerInstanceId) ?? "";
        const providerB = providerNameById.get(b.providerInstanceId) ?? "";
        if (providerA !== providerB) {
          return providerA.localeCompare(providerB);
        }
        const nameA = a.displayNameOverride ?? a.remoteDisplayName ?? a.modelKey;
        const nameB = b.displayNameOverride ?? b.remoteDisplayName ?? b.modelKey;
        return nameA.localeCompare(nameB);
      });
    return sorted[0]?.id ?? null;
  }, [modelsQuery.data, modelsQuery.isSuccess, providersQuery.data]);

  const createMutation = useMutation({
    mutationFn: saveOcrService,
    onSuccess: (created) => {
      toast.success({ title: t("ocr.toast.created"), description: created.displayName });
      onCreated(created);
    },
    onError: (err: unknown) => {
      const message = getIpcErrorMessage(err, t("ocr.toast.createFailed"));
      setError(message);
      toast.error({ title: t("ocr.toast.createFailed"), description: message });
    },
  });

  const pending = createMutation.isPending;
  const providerColumnCount = Math.min(OCR_PROVIDER_OPTIONS.length, PROVIDER_GRID_MAX_COLUMNS);

  function isOptionDisabled(providerType: OcrProviderType) {
    if (pending) {
      return true;
    }
    // AI create needs the model list; block clicks until it settles.
    return providerType === "ai" && modelsPending;
  }

  function handleCreate(providerType: OcrProviderType) {
    if (isOptionDisabled(providerType)) {
      return;
    }

    if (providerType === "ai") {
      if (modelsLoadError) {
        setError(modelsLoadError);
        return;
      }
      // Only treat as "no models" after a successful query with zero enabled models.
      if (!modelsQuery.isSuccess) {
        return;
      }
      if (!defaultModelId) {
        const message = t("ocr.add.needModel");
        setError(message);
        return;
      }
      const templateId = crypto.randomUUID();
      const write: OcrServiceWrite = {
        id: null,
        providerType: "ai",
        displayName: t("ocr.defaults.aiName"),
        enabled: true,
        providerModelId: defaultModelId,
        temperature: null,
        defaultPromptTemplateId: templateId,
        promptTemplates: [
          {
            id: templateId,
            name: DEFAULT_AI_OCR_PROMPT_TEMPLATE_NAME,
            systemTemplate: DEFAULT_AI_OCR_SYSTEM_TEMPLATE,
            userTemplate: DEFAULT_AI_OCR_USER_TEMPLATE,
          },
        ],
      };
      setError(null);
      createMutation.mutate(write);
      return;
    }

    const write: OcrServiceWrite = {
      id: null,
      providerType: "baidu",
      displayName: t("ocr.defaults.baiduName"),
      enabled: true,
      baiduAction: "accurate",
      apiKey: { action: "keep" },
      secretKey: { action: "keep" },
      promptTemplates: [],
    };
    setError(null);
    createMutation.mutate(write);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${providerColumnCount}, minmax(0, 1fr))` }}>
        {OCR_PROVIDER_OPTIONS.map((option) => {
          const Icon = option.Icon;
          const disabled = isOptionDisabled(option.id);
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => {
                handleCreate(option.id);
              }}
              className={`
                flex min-w-0 items-center gap-2 border border-line bg-surface p-3 text-left text-on-surface
                transition-colors
                hover:bg-surface-container-highest
                disabled:cursor-default disabled:opacity-60
                disabled:hover:bg-surface
              `}
            >
              <Icon className="size-5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate text-body-md font-bold">
                {option.id === "ai" && modelsPending ? t("ocr.add.loadingModels") : t(option.labelKey)}
              </span>
            </button>
          );
        })}
      </div>

      {error ? (
        <p className="text-body-tight text-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Dialog.Close className={outlineButtonClassName} disabled={pending}>
          {t("common.cancel")}
        </Dialog.Close>
      </div>
    </div>
  );
}
