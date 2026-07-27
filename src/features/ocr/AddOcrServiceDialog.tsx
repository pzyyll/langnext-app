// ABOUTME: Dialog for creating Baidu, AI, and schema-backed plugin OCR services through Tauri IPC.
// ABOUTME: Uses selected capability schemas for defaults; credentials remain owned by their integration.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import { dialogBackdropClassName, dialogPopupClassName, outlineButtonClassName } from "../../components/ui";
import { useToast } from "../../components/toast/useToast";
import {
  allProviderModelsOptions,
  integrationDefinitionListOptions,
  integrationListOptions,
  providerListOptions,
} from "../../query/options";
import { saveOcrService } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { OcrServiceDto, OcrServiceWrite } from "../../storage/types";
import { resolvePluginDisplayName } from "../plugins/pluginPresentation";
import { preferenceSchemaForBinding } from "../plugins/schema/capabilitySchema";
import { buildSchemaConfig, createSchemaDraft } from "../plugins/schema/schemaDraft";
import {
  DEFAULT_AI_OCR_PROMPT_TEMPLATE_NAME,
  DEFAULT_AI_OCR_SYSTEM_TEMPLATE,
  DEFAULT_AI_OCR_USER_TEMPLATE,
} from "./defaultAiOcrPrompt";
import { buildOcrProviderCreateOptions, type OcrProviderCreateOption } from "./ocrProviderOptions";

const providerGridMaxColumns = 3;
const dialogPopupWidthClassName = `${dialogPopupClassName} w-md`;
const providerOptionClassName = `
  flex min-w-0 items-center gap-2 border border-line bg-surface p-3 text-left text-on-surface
  transition-colors
  hover:bg-surface-container-highest
  disabled:cursor-default disabled:opacity-60
  disabled:hover:bg-surface
`;

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
        <Dialog.Popup className={dialogPopupWidthClassName}>
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

function AddOcrServiceForm({ onCreated }: { onCreated: (service: OcrServiceDto) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const modelsQuery = useQuery(allProviderModelsOptions());
  const providersQuery = useQuery(providerListOptions());
  const integrationsQuery = useQuery(integrationListOptions());
  const definitionsQuery = useQuery(integrationDefinitionListOptions());
  const instances = useMemo(() => integrationsQuery.data ?? [], [integrationsQuery.data]);
  const definitions = useMemo(() => definitionsQuery.data ?? [], [definitionsQuery.data]);
  const modelsPending = modelsQuery.isPending;
  const modelsLoadError = modelsQuery.isError
    ? getIpcErrorMessage(modelsQuery.error, t("ocr.add.modelsLoadFailed"))
    : null;

  const hasEnabledImageModel = useMemo(
    () =>
      (modelsQuery.data ?? []).some((model) => model.enabled && model.capabilityOverridesJson?.imageAnalysis === true),
    [modelsQuery.data],
  );
  const defaultModelId = useMemo(() => {
    const providerNameById = new Map(
      (providersQuery.data ?? []).map((provider) => [provider.id, provider.displayName]),
    );
    return (
      (modelsQuery.data ?? [])
        .filter((model) => model.enabled && model.capabilityOverridesJson?.imageAnalysis === true)
        .slice()
        .sort((left, right) => {
          const leftLabel = `${providerNameById.get(left.providerInstanceId) ?? ""}:${left.displayNameOverride ?? left.remoteDisplayName ?? left.modelKey}`;
          const rightLabel = `${providerNameById.get(right.providerInstanceId) ?? ""}:${right.displayNameOverride ?? right.remoteDisplayName ?? right.modelKey}`;
          return leftLabel.localeCompare(rightLabel);
        })[0]?.id ?? null
    );
  }, [modelsQuery.data, providersQuery.data]);
  const createOptions = useMemo(
    () =>
      buildOcrProviderCreateOptions({
        hasEnabledImageModel,
        modelsPending,
        instances,
        definitions,
        labels: {
          baiduLabel: t("ocr.provider.baidu"),
          aiLabel: t("ocr.provider.ai"),
          integrationLabel: t("ocr.vision.integrationLabel"),
          resolvePluginLabel: (definition) => resolvePluginDisplayName(definition, (key, options) => t(key, options)),
        },
      }),
    [definitions, hasEnabledImageModel, instances, modelsPending, t],
  );
  const createMutation = useMutation({
    mutationFn: saveOcrService,
    onSuccess: (created) => {
      toast.success({ title: t("ocr.toast.created"), description: created.displayName });
      onCreated(created);
    },
    onError: (mutationError: unknown) => {
      const message = getIpcErrorMessage(mutationError, t("ocr.toast.createFailed"));
      setError(message);
      toast.error({ title: t("ocr.toast.createFailed"), description: message });
    },
  });
  const pending = createMutation.isPending;
  const providerColumnCount = Math.min(Math.max(createOptions.length, 1), providerGridMaxColumns);

  function handleCreate(option: OcrProviderCreateOption) {
    if (pending || option.disabled) return;
    if (option.kind === "ai") {
      if (modelsLoadError) {
        setError(modelsLoadError);
        return;
      }
      if (!defaultModelId) {
        setError(t("ocr.add.needModel"));
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
    if (option.kind === "plugin_capability") {
      if (!option.integrationInstanceId || !option.ocrCapabilityId) {
        setError(t("ocr.add.needIntegration"));
        return;
      }
      const binding = preferenceSchemaForBinding(
        instances,
        definitions,
        option.integrationInstanceId,
        option.ocrCapabilityId,
      );
      if (!binding) {
        setError(t("plugins.unsupportedInstance"));
        return;
      }
      const preferences = createSchemaDraft(binding.schema);
      const write: OcrServiceWrite = {
        id: null,
        providerType: "plugin_capability",
        displayName: option.label,
        enabled: true,
        integrationInstanceId: option.integrationInstanceId,
        ocrCapabilityId: option.ocrCapabilityId,
        capabilityPreferencesVersion: binding.descriptor.preferencesSchemaVersion,
        capabilityPreferences: buildSchemaConfig(binding.schema, preferences),
        promptTemplates: [],
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
        {createOptions.map((option) => {
          const Icon = option.Icon;
          return (
            <button
              key={option.id}
              type="button"
              disabled={pending || option.disabled}
              onClick={() => handleCreate(option)}
              className={providerOptionClassName}
            >
              <Icon className="size-5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate text-body-md font-bold">{option.label}</span>
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
