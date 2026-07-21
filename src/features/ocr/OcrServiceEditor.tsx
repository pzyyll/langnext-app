// ABOUTME: Selected OCR service editor shell with shared name/enabled/footer actions.
// ABOUTME: Hosts Baidu and AI type-specific forms and persists via saveOcrService.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { Switch } from "@base-ui/react/switch";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ScrollArea } from "../../components/ScrollArea";
import { useToast } from "../../components/toast/useToast";
import {
  dangerButtonClassName,
  inputClassName,
  outlineButtonClassName,
  primaryButtonClassName,
  switchRootClassName,
  switchThumbClassName,
} from "../../components/ui";
import { ocrKeys } from "../../query/keys";
import { allProviderModelsOptions, ocrListOptions, providerListOptions } from "../../query/options";
import { deleteOcrService, saveOcrService } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type {
  BaiduOcrAction,
  CredentialUpdate,
  OcrPromptTemplate,
  OcrServiceDto,
  OcrServiceWrite,
} from "../../storage/types";
import { AiOcrForm } from "./AiOcrForm";
import { BaiduOcrForm, type CredentialAction } from "./BaiduOcrForm";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

const panelFooterClassName =
  "box-border flex h-[calc(2rem+2rem+1px)] max-h-[calc(2rem+2rem+1px)] min-h-[calc(2rem+2rem+1px)] shrink-0 grow-0 items-center border-t border-line px-8 py-4";

export type OcrServiceEditorProps = {
  ocrServiceId: string;
};

type EditorDraft = {
  displayName: string;
  enabled: boolean;
  baiduAction: BaiduOcrAction;
  apiKey: string;
  secretKey: string;
  apiKeyAction: CredentialAction;
  secretKeyAction: CredentialAction;
  providerModelId: string;
  temperature: string;
  defaultPromptTemplateId: string;
  promptTemplates: OcrPromptTemplate[];
  expectedUpdatedAt: string;
};

function draftFromDto(service: OcrServiceDto): EditorDraft {
  return {
    displayName: service.displayName,
    enabled: service.enabled,
    baiduAction: service.baiduAction ?? "accurate",
    apiKey: "",
    secretKey: "",
    apiKeyAction: "keep",
    secretKeyAction: "keep",
    providerModelId: service.providerModelId ?? "",
    temperature: service.temperature != null ? String(service.temperature) : "",
    defaultPromptTemplateId: service.defaultPromptTemplateId ?? service.promptTemplates[0]?.id ?? "",
    promptTemplates: service.promptTemplates.map((template) => ({ ...template })),
    expectedUpdatedAt: service.updatedAt,
  };
}

function toCredentialUpdate(action: CredentialAction, value: string): CredentialUpdate {
  if (action === "clear") {
    return { action: "clear" };
  }
  if (action === "replace" && value.trim()) {
    return { action: "replace", value: value.trim() };
  }
  return { action: "keep" };
}

function parseOptionalTemperature(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    return "invalid";
  }
  return value;
}

export function OcrServiceEditor({ ocrServiceId }: OcrServiceEditorProps) {
  const { t } = useTranslation();
  const servicesQuery = useQuery(ocrListOptions());
  const service = (servicesQuery.data ?? []).find((item) => item.id === ocrServiceId) ?? null;
  const loading = servicesQuery.isLoading;
  const error =
    servicesQuery.error != null ? getIpcErrorMessage(servicesQuery.error, t("ocr.loadFailed")) : null;

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-body-tight text-neutral" aria-live="polite">
          {t("ocr.loadingService")}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-8">
        <p className="text-body-tight text-error" role="alert">
          {error}
        </p>
        <Button
          type="button"
          className={outlineButtonClassName}
          onClick={() => {
            void servicesQuery.refetch();
          }}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (!service) {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-8">
        <h1 className="text-headline-md font-bold text-on-surface">{t("ocr.notFound")}</h1>
        <p className="text-body-tight text-neutral">{t("ocr.notFoundHint")}</p>
        <Link to="/ocr" className={outlineButtonClassName}>
          {t("ocr.backToList")}
        </Link>
      </div>
    );
  }

  return <OcrServiceEditorLoaded key={`${service.id}:${service.updatedAt}`} service={service} />;
}

type OcrServiceEditorLoadedProps = {
  service: OcrServiceDto;
};

function OcrServiceEditorLoaded({ service }: OcrServiceEditorLoadedProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const modelsQuery = useQuery(allProviderModelsOptions());
  const providersQuery = useQuery(providerListOptions());

  const [draft, setDraft] = useState<EditorDraft>(() => draftFromDto(service));
  const [savePending, setSavePending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Parent remounts this component on id/updatedAt change via React key.

  const isDirty = useMemo(() => {
    const baseline = draftFromDto(service);
    if (draft.displayName !== baseline.displayName) return true;
    if (draft.enabled !== baseline.enabled) return true;
    if (service.providerType === "baidu") {
      if (draft.baiduAction !== baseline.baiduAction) return true;
      if (draft.apiKeyAction !== "keep" || draft.secretKeyAction !== "keep") return true;
      if (draft.apiKey.trim() || draft.secretKey.trim()) return true;
      return false;
    }
    if (draft.providerModelId !== baseline.providerModelId) return true;
    if (draft.temperature !== baseline.temperature) return true;
    if (draft.defaultPromptTemplateId !== baseline.defaultPromptTemplateId) return true;
    if (JSON.stringify(draft.promptTemplates) !== JSON.stringify(baseline.promptTemplates)) return true;
    return false;
  }, [draft, service]);

  function updateDraft(patch: Partial<EditorDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function seedService(next: OcrServiceDto) {
    queryClient.setQueryData<OcrServiceDto[]>(ocrKeys.list(), (current) => {
      if (!current) {
        return [next];
      }
      const index = current.findIndex((item) => item.id === next.id);
      if (index < 0) {
        return [...current, next];
      }
      const copy = current.slice();
      copy[index] = next;
      return copy;
    });
    queryClient.setQueryData(ocrKeys.detail(next.id), next);
  }

  async function handleSave() {
    if (savePending) {
      return;
    }
    const displayName = draft.displayName.trim();
    if (!displayName) {
      setValidationError(t("ocr.validation.nameRequired"));
      return;
    }

    let write: OcrServiceWrite;
    if (service.providerType === "baidu") {
      write = {
        id: service.id,
        providerType: "baidu",
        displayName,
        enabled: draft.enabled,
        baiduAction: draft.baiduAction,
        apiKey: toCredentialUpdate(draft.apiKeyAction, draft.apiKey),
        secretKey: toCredentialUpdate(draft.secretKeyAction, draft.secretKey),
        promptTemplates: [],
        expectedUpdatedAt: draft.expectedUpdatedAt,
      };
    } else {
      const temperature = parseOptionalTemperature(draft.temperature);
      if (temperature === "invalid") {
        setValidationError(t("ocr.validation.temperatureInvalid"));
        return;
      }
      if (!draft.providerModelId) {
        setValidationError(t("ocr.validation.modelRequired"));
        return;
      }
      if (!(modelsQuery.data ?? []).some((model) => model.id === draft.providerModelId)) {
        setValidationError(t("ocr.validation.modelMissing"));
        return;
      }
      if (draft.promptTemplates.length === 0) {
        setValidationError(t("ocr.validation.templatesRequired"));
        return;
      }
      if (draft.promptTemplates.some((template) => template.name.trim() === "")) {
        setValidationError(t("ocr.validation.templateNameRequired"));
        return;
      }
      if (
        draft.promptTemplates.some(
          (template) => template.systemTemplate.trim() === "" || template.userTemplate.trim() === "",
        )
      ) {
        setValidationError(t("ocr.validation.templateBodyRequired"));
        return;
      }
      if (!draft.promptTemplates.some((template) => template.id === draft.defaultPromptTemplateId)) {
        setValidationError(t("ocr.validation.defaultTemplateRequired"));
        return;
      }
      write = {
        id: service.id,
        providerType: "ai",
        displayName,
        enabled: draft.enabled,
        providerModelId: draft.providerModelId,
        temperature,
        defaultPromptTemplateId: draft.defaultPromptTemplateId,
        promptTemplates: draft.promptTemplates.map((template) => ({
          id: template.id,
          name: template.name.trim(),
          systemTemplate: template.systemTemplate,
          userTemplate: template.userTemplate,
        })),
        expectedUpdatedAt: draft.expectedUpdatedAt,
      };
    }

    setValidationError(null);
    setSavePending(true);
    try {
      const saved = await saveOcrService(write);
      seedService(saved);
      setDraft(draftFromDto(saved));
      toast.success({ title: t("ocr.toast.saved"), description: saved.displayName });
      void queryClient.invalidateQueries({ queryKey: ocrKeys.all });
    } catch (error) {
      const message = getIpcErrorMessage(error, t("ocr.toast.saveFailed"));
      setValidationError(message);
      toast.error({ title: t("ocr.toast.saveFailed"), description: message });
      void queryClient.invalidateQueries({ queryKey: ocrKeys.all });
    } finally {
      setSavePending(false);
    }
  }

  async function handleDelete() {
    if (deletePending) {
      return;
    }
    setDeletePending(true);
    try {
      await deleteOcrService(service.id);
    } catch (error) {
      const message = getIpcErrorMessage(error, t("ocr.toast.deleteFailed"));
      toast.error({ title: t("ocr.toast.deleteFailed"), description: message });
      // Rethrow so ConfirmDialog stays open (matches Models ProviderEditor).
      throw Object.assign(new Error(message), { cause: error });
    } finally {
      setDeletePending(false);
    }

    queryClient.setQueryData<OcrServiceDto[]>(ocrKeys.list(), (current) =>
      (current ?? []).filter((item) => item.id !== service.id),
    );
    queryClient.removeQueries({ queryKey: ocrKeys.detail(service.id) });
    toast.success({ title: t("ocr.toast.deleted"), description: service.displayName });
    void navigate({ to: "/ocr" });
    void queryClient.invalidateQueries({ queryKey: ocrKeys.all });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-outline px-8 py-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label className={fieldLabelClassName} htmlFor="ocr-service-name">
            {t("ocr.displayName")}
          </label>
          <Input
            id="ocr-service-name"
            className={inputClassName}
            value={draft.displayName}
            maxLength={128}
            disabled={savePending || deletePending}
            onChange={(event) => {
              updateDraft({ displayName: event.currentTarget.value });
            }}
          />
        </div>
        <label className="flex shrink-0 items-center gap-2 text-body-tight text-on-surface">
          <Switch.Root
            checked={draft.enabled}
            disabled={savePending || deletePending}
            className={switchRootClassName}
            onCheckedChange={(checked) => {
              updateDraft({ enabled: checked });
            }}
          >
            <Switch.Thumb className={switchThumbClassName} />
          </Switch.Root>
          {t("common.enabled")}
        </label>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 p-8">
          {service.providerType === "baidu" ? (
            <BaiduOcrForm
              apiKey={draft.apiKey}
              secretKey={draft.secretKey}
              apiKeyAction={draft.apiKeyAction}
              secretKeyAction={draft.secretKeyAction}
              hasApiKey={service.hasApiKey}
              hasSecretKey={service.hasSecretKey}
              baiduAction={draft.baiduAction}
              disabled={savePending || deletePending}
              onApiKeyChange={(value) => {
                updateDraft({ apiKey: value });
              }}
              onSecretKeyChange={(value) => {
                updateDraft({ secretKey: value });
              }}
              onApiKeyActionChange={(action) => {
                updateDraft({ apiKeyAction: action });
              }}
              onSecretKeyActionChange={(action) => {
                updateDraft({ secretKeyAction: action });
              }}
              onBaiduActionChange={(action) => {
                updateDraft({ baiduAction: action });
              }}
            />
          ) : (
            <AiOcrForm
              providerModelId={draft.providerModelId}
              temperature={draft.temperature}
              defaultPromptTemplateId={draft.defaultPromptTemplateId}
              promptTemplates={draft.promptTemplates}
              models={modelsQuery.data ?? []}
              providers={providersQuery.data ?? []}
              disabled={savePending || deletePending}
              onProviderModelIdChange={(value) => {
                updateDraft({ providerModelId: value });
              }}
              onTemperatureChange={(value) => {
                updateDraft({ temperature: value });
              }}
              onDefaultPromptTemplateIdChange={(value) => {
                updateDraft({ defaultPromptTemplateId: value });
              }}
              onPromptTemplatesChange={(templates) => {
                updateDraft({ promptTemplates: templates });
              }}
            />
          )}

          {validationError ? (
            <p className="text-body-tight text-error" role="alert">
              {validationError}
            </p>
          ) : null}
        </div>
      </ScrollArea>

      <div className={panelFooterClassName}>
        <div className="flex w-full items-center justify-between gap-3">
          <Button
            type="button"
            className={dangerButtonClassName}
            disabled={savePending || deletePending}
            onClick={() => {
              setDeleteOpen(true);
            }}
          >
            {t("common.delete")}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              className={outlineButtonClassName}
              disabled={!isDirty || savePending || deletePending}
              onClick={() => {
                setDraft(draftFromDto(service));
                setValidationError(null);
              }}
            >
              {t("ocr.discard")}
            </Button>
            <Button
              type="button"
              className={primaryButtonClassName}
              disabled={!isDirty || savePending || deletePending}
              onClick={() => {
                void handleSave();
              }}
            >
              {savePending ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("ocr.deleteConfirmTitle")}
        description={t("ocr.deleteConfirm", { name: service.displayName })}
        confirmText={t("common.delete")}
        pendingText={t("common.deleting")}
        danger
        onConfirm={handleDelete}
      />
    </div>
  );
}
