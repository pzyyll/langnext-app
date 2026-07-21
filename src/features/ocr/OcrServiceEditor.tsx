// ABOUTME: Selected OCR service editor shell matching Models provider editor layout.
// ABOUTME: Hosts Baidu and AI forms with inline rename, scroll body, and footer actions.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { Switch } from "@base-ui/react/switch";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightDeleteOutlineSharp from "~icons/material-symbols-light/delete-outline-sharp";
import IconMaterialSymbolsLightEditSquareOutlineSharp from "~icons/material-symbols-light/edit-square-outline-sharp";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ConfigEditorLayout, configEditorRenameInputClassName } from "../../components/layouts/ConfigEditorLayout";
import { useToast } from "../../components/toast/useToast";
import {
  dangerIconButtonClassName,
  iconButtonClassName,
  outlineButtonClassName,
  primaryButtonClassName,
  switchRootClassName,
  switchThumbClassName,
} from "../../components/ui";
import { ocrKeys, settingsKeys } from "../../query/keys";
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

export type OcrServiceEditorProps = {
  ocrServiceId: string;
};

type EditorDraft = {
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

function isDraftFieldsClean(draft: EditorDraft, service: OcrServiceDto): boolean {
  const baseline = draftFromDto(service);
  return (
    draft.enabled === baseline.enabled &&
    draft.baiduAction === baseline.baiduAction &&
    draft.apiKeyAction === "keep" &&
    draft.secretKeyAction === "keep" &&
    !draft.apiKey.trim() &&
    !draft.secretKey.trim() &&
    draft.providerModelId === baseline.providerModelId &&
    draft.temperature === baseline.temperature &&
    draft.defaultPromptTemplateId === baseline.defaultPromptTemplateId &&
    JSON.stringify(draft.promptTemplates) === JSON.stringify(baseline.promptTemplates)
  );
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

/** Persist a rename without applying unsaved form fields. */
function renameWrite(service: OcrServiceDto, displayName: string): OcrServiceWrite {
  if (service.providerType === "baidu") {
    return {
      id: service.id,
      providerType: "baidu",
      displayName,
      enabled: service.enabled,
      baiduAction: service.baiduAction ?? "accurate",
      apiKey: { action: "keep" },
      secretKey: { action: "keep" },
      promptTemplates: [],
      expectedUpdatedAt: service.updatedAt,
    };
  }

  return {
    id: service.id,
    providerType: "ai",
    displayName,
    enabled: service.enabled,
    providerModelId: service.providerModelId ?? "",
    temperature: service.temperature,
    defaultPromptTemplateId: service.defaultPromptTemplateId ?? service.promptTemplates[0]?.id ?? "",
    promptTemplates: service.promptTemplates.map((template) => ({ ...template })),
    expectedUpdatedAt: service.updatedAt,
  };
}

export function OcrServiceEditor({ ocrServiceId }: OcrServiceEditorProps) {
  const { t } = useTranslation();
  const servicesQuery = useQuery(ocrListOptions());
  const service = (servicesQuery.data ?? []).find((item) => item.id === ocrServiceId) ?? null;
  const loading = servicesQuery.isLoading;
  const error = servicesQuery.error != null ? getIpcErrorMessage(servicesQuery.error, t("ocr.loadFailed")) : null;

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

  // Remount only when the selected service changes so rename/save keep local draft state.
  return <OcrServiceEditorLoaded key={service.id} service={service} />;
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
  const [trackedService, setTrackedService] = useState(service);
  const [savePending, setSavePending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLElement | null>(null);

  // Accept remote service updates into the draft only while the form is clean.
  if (service.updatedAt !== trackedService.updatedAt || service.id !== trackedService.id) {
    const shouldResetDraft = service.id !== trackedService.id || isDraftFieldsClean(draft, trackedService);
    setTrackedService(service);
    if (shouldResetDraft) {
      setDraft(draftFromDto(service));
    }
  }

  useEffect(() => {
    if (!renaming) {
      return;
    }
    const node = renameInputRef.current;
    if (!node) {
      return;
    }
    node.focus();
    if (node instanceof HTMLInputElement) {
      node.select();
    }
  }, [renaming]);

  const isDirty = useMemo(() => !isDraftFieldsClean(draft, service), [draft, service]);

  const formDisabled = savePending || deletePending || renamePending;
  const renameDisabled = formDisabled;

  function updateDraft(patch: Partial<EditorDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setValidationError(null);
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

  function startRename() {
    setRenameValue(service.displayName);
    setRenameError(null);
    setRenaming(true);
  }

  function cancelRename() {
    setRenaming(false);
    setRenameValue("");
    setRenameError(null);
  }

  async function commitRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || renamePending) {
      return;
    }
    if (trimmed === service.displayName) {
      cancelRename();
      return;
    }

    setRenamePending(true);
    setRenameError(null);
    try {
      const saved = await saveOcrService(renameWrite(service, trimmed));
      seedService(saved);
      setDraft((current) => ({ ...current, expectedUpdatedAt: saved.updatedAt }));
      setRenaming(false);
      setRenameValue("");
      void queryClient.invalidateQueries({ queryKey: ocrKeys.all });
    } catch (error) {
      setRenameError(getIpcErrorMessage(error, t("ocr.toast.renameFailed")));
    } finally {
      setRenamePending(false);
    }
  }

  async function handleSave() {
    if (savePending || !isDirty) {
      return;
    }

    let write: OcrServiceWrite;
    if (service.providerType === "baidu") {
      write = {
        id: service.id,
        providerType: "baidu",
        displayName: service.displayName,
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
        displayName: service.displayName,
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
    // Backend clears defaultOcrServiceId when the selected service is deleted.
    void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
  }

  function resetForm() {
    setDraft(draftFromDto(service));
    setValidationError(null);
  }

  return (
    <>
      <ConfigEditorLayout
        title={
          renaming ? (
            <form
              className="flex min-w-0 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void commitRename();
              }}
            >
              <Input
                ref={renameInputRef}
                className={configEditorRenameInputClassName}
                value={renameValue}
                onChange={(event) => {
                  setRenameValue(event.currentTarget.value);
                  setRenameError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !renamePending) {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
                maxLength={128}
                spellCheck={false}
                autoComplete="off"
                disabled={renamePending}
              />
              <Button
                type="submit"
                className={iconButtonClassName}
                aria-label={t("ocr.saveServiceName")}
                disabled={renamePending || !renameValue.trim()}
              >
                <IconMaterialSymbolsLightCheck className="pointer-events-none size-5 shrink-0" />
              </Button>
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("ocr.cancelRename")}
                disabled={renamePending}
                onClick={cancelRename}
              >
                <IconMaterialSymbolsLightClose className="pointer-events-none size-5 shrink-0" />
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <h1 className="truncate text-headline-display font-bold text-on-surface">{service.displayName}</h1>
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("ocr.renameService")}
                title={t("ocr.renameService")}
                disabled={renameDisabled}
                onClick={startRename}
              >
                <IconMaterialSymbolsLightEditSquareOutlineSharp className="pointer-events-none size-5 shrink-0" />
              </Button>
            </div>
          )
        }
        titleTrailing={
          <label className="flex shrink-0 items-center gap-2 text-body-tight text-on-surface">
            <Switch.Root
              checked={draft.enabled}
              disabled={formDisabled}
              className={switchRootClassName}
              onCheckedChange={(checked) => {
                updateDraft({ enabled: checked });
              }}
            >
              <Switch.Thumb className={switchThumbClassName} />
            </Switch.Root>
          </label>
        }
        titleMeta={
          renameError ? (
            <p className="mb-2 text-body-tight text-error" role="alert">
              {renameError}
            </p>
          ) : null
        }
        footer={
          <>
            <Button
              type="button"
              className={`
                ${dangerIconButtonClassName}
                mr-auto
              `}
              aria-label={t("ocr.deleteConfirmTitle")}
              title={t("ocr.deleteConfirmTitle")}
              disabled={formDisabled}
              onClick={() => {
                setDeleteOpen(true);
              }}
            >
              <IconMaterialSymbolsLightDeleteOutlineSharp className="pointer-events-none size-5 shrink-0" />
            </Button>

            <Button type="button" className={outlineButtonClassName} disabled={formDisabled} onClick={resetForm}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              className={`
                ${primaryButtonClassName}
                relative
              `}
              disabled={formDisabled || !isDirty}
              focusableWhenDisabled
              aria-busy={savePending}
              aria-label={savePending ? t("common.saving") : t("common.save")}
              onClick={() => {
                void handleSave();
              }}
            >
              <span className={savePending ? "invisible" : undefined} aria-hidden="true">
                {t("common.save")}
              </span>
              {savePending ? (
                <span
                  className="absolute size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
                  aria-hidden="true"
                />
              ) : null}
            </Button>
          </>
        }
      >
        {service.providerType === "baidu" ? (
          <BaiduOcrForm
            apiKey={draft.apiKey}
            secretKey={draft.secretKey}
            apiKeyAction={draft.apiKeyAction}
            secretKeyAction={draft.secretKeyAction}
            hasApiKey={service.hasApiKey}
            hasSecretKey={service.hasSecretKey}
            baiduAction={draft.baiduAction}
            disabled={formDisabled}
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
            disabled={formDisabled}
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
          <p className="mt-6 text-body-tight text-error" role="alert">
            {validationError}
          </p>
        ) : null}
      </ConfigEditorLayout>

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
    </>
  );
}
