// ABOUTME: OCR service editor preserving Baidu/AI flows and rendering plugin preferences from schemas.
// ABOUTME: Keeps credentials write-only and rebuilds plugin preference drafts on compatible rebinds.
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
import {
  allProviderModelsOptions,
  integrationDefinitionListOptions,
  integrationListOptions,
  ocrListOptions,
  providerListOptions,
} from "../../query/options";
import { deleteOcrService, saveOcrService } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type {
  BaiduOcrAction,
  CredentialUpdate,
  IntegrationInstanceDto,
  OcrPromptTemplate,
  OcrServiceDto,
  OcrServiceWrite,
  ServiceIntegrationDefinitionDto,
} from "../../storage/types";
import { AiOcrForm } from "./AiOcrForm";
import { BaiduOcrForm, type CredentialAction } from "./BaiduOcrForm";
import { PluginOcrForm } from "./PluginOcrForm";
import { OCR_IMAGE_CAPABILITY_ID } from "./ocrProviderOptions";
import { preferenceSchemaForBinding } from "../plugins/schema/capabilitySchema";
import { presentCapabilityHealth } from "../plugins/capabilityHealthPresentation";
import {
  buildSchemaConfig,
  createSchemaDraft,
  isSchemaDraftDirty,
  type SchemaDraft,
} from "../plugins/schema/schemaDraft";

export type OcrServiceEditorProps = {
  ocrServiceId: string;
};

const emptyPreferenceSchema = { version: 1, fields: [], groups: [] };
const deleteButtonClassName = [dangerIconButtonClassName, "mr-auto"].join(" ");
const saveButtonClassName = [primaryButtonClassName, "relative"].join(" ");

type OcrDraft = {
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
  integrationInstanceId: string;
  ocrCapabilityId: string;
  capabilityPreferencesVersion: number;
  pluginPreferences: SchemaDraft;
  schemaKey: string;
  expectedUpdatedAt: string;
};

function preferenceKey(instanceId: string, capabilityId: string, schemaVersion: number): string {
  return `${instanceId}:${capabilityId}:${schemaVersion}`;
}

function parseOptionalTemperature(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

function toCredentialUpdate(action: CredentialAction, value: string): CredentialUpdate {
  if (action === "clear") return { action: "clear" };
  return action === "replace" && value.trim() ? { action: "replace", value: value.trim() } : { action: "keep" };
}

function draftFromDto(
  service: OcrServiceDto,
  instances: readonly IntegrationInstanceDto[],
  definitions: readonly ServiceIntegrationDefinitionDto[],
): OcrDraft {
  const integrationInstanceId = service.integrationInstanceId ?? "";
  const ocrCapabilityId = service.ocrCapabilityId ?? OCR_IMAGE_CAPABILITY_ID;
  const binding =
    service.providerType === "plugin_capability"
      ? preferenceSchemaForBinding(instances, definitions, integrationInstanceId, ocrCapabilityId)
      : null;
  const capabilityPreferencesVersion =
    binding?.descriptor.preferencesSchemaVersion ?? service.capabilityPreferencesVersion ?? 1;
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
    integrationInstanceId,
    ocrCapabilityId,
    capabilityPreferencesVersion,
    pluginPreferences: binding
      ? createSchemaDraft(binding.schema, { config: service.capabilityPreferences ?? {} })
      : createSchemaDraft(emptyPreferenceSchema),
    schemaKey: binding ? preferenceKey(integrationInstanceId, ocrCapabilityId, capabilityPreferencesVersion) : "",
    expectedUpdatedAt: service.updatedAt,
  };
}

function isDraftFieldsClean(
  draft: OcrDraft,
  service: OcrServiceDto,
  instances: readonly IntegrationInstanceDto[],
  definitions: readonly ServiceIntegrationDefinitionDto[],
): boolean {
  const baseline = draftFromDto(service, instances, definitions);
  if (
    draft.enabled !== baseline.enabled ||
    draft.baiduAction !== baseline.baiduAction ||
    draft.apiKeyAction !== "keep" ||
    draft.secretKeyAction !== "keep" ||
    Boolean(draft.apiKey.trim()) ||
    Boolean(draft.secretKey.trim()) ||
    draft.providerModelId !== baseline.providerModelId ||
    draft.temperature !== baseline.temperature ||
    draft.defaultPromptTemplateId !== baseline.defaultPromptTemplateId ||
    draft.integrationInstanceId !== baseline.integrationInstanceId ||
    draft.ocrCapabilityId !== baseline.ocrCapabilityId ||
    draft.capabilityPreferencesVersion !== baseline.capabilityPreferencesVersion ||
    draft.schemaKey !== baseline.schemaKey ||
    JSON.stringify(draft.promptTemplates) !== JSON.stringify(baseline.promptTemplates)
  ) {
    return false;
  }
  const binding = preferenceSchemaForBinding(
    instances,
    definitions,
    draft.integrationInstanceId,
    draft.ocrCapabilityId,
  );
  return binding ? !isSchemaDraftDirty(binding.schema, draft.pluginPreferences, baseline.pluginPreferences) : true;
}

/** Persist a rename without altering provider-specific values or opaque plugin preference data. */
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
  if (service.providerType === "plugin_capability") {
    return {
      id: service.id,
      providerType: "plugin_capability",
      displayName,
      enabled: service.enabled,
      integrationInstanceId: service.integrationInstanceId ?? "",
      ocrCapabilityId: service.ocrCapabilityId ?? OCR_IMAGE_CAPABILITY_ID,
      capabilityPreferencesVersion: service.capabilityPreferencesVersion ?? 1,
      capabilityPreferences: service.capabilityPreferences ?? {},
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
  const error = servicesQuery.error != null ? getIpcErrorMessage(servicesQuery.error, t("ocr.loadFailed")) : null;

  if (servicesQuery.isLoading) {
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
        <Button type="button" className={outlineButtonClassName} onClick={() => void servicesQuery.refetch()}>
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
  return <OcrServiceEditorLoaded key={service.id} service={service} />;
}

function OcrServiceEditorLoaded({ service }: { service: OcrServiceDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const modelsQuery = useQuery(allProviderModelsOptions());
  const providersQuery = useQuery(providerListOptions());
  const integrationsQuery = useQuery(integrationListOptions());
  const definitionsQuery = useQuery(integrationDefinitionListOptions());
  const instances = useMemo(() => integrationsQuery.data ?? [], [integrationsQuery.data]);
  const definitions = useMemo(() => definitionsQuery.data ?? [], [definitionsQuery.data]);
  const integrationInstance = instances.find((item) => item.id === service.integrationInstanceId) ?? null;
  const capabilityHealth =
    service.providerType === "plugin_capability" && integrationInstance
      ? presentCapabilityHealth(
          service.ocrCapabilityId ?? OCR_IMAGE_CAPABILITY_ID,
          integrationInstance.capabilityHealth,
        )
      : null;
  const currentBinding = preferenceSchemaForBinding(
    instances,
    definitions,
    service.integrationInstanceId ?? "",
    service.ocrCapabilityId ?? OCR_IMAGE_CAPABILITY_ID,
  );
  const currentSchemaKey = currentBinding
    ? preferenceKey(
        service.integrationInstanceId ?? "",
        service.ocrCapabilityId ?? OCR_IMAGE_CAPABILITY_ID,
        currentBinding.descriptor.preferencesSchemaVersion,
      )
    : "";

  const [draft, setDraft] = useState<OcrDraft>(() => draftFromDto(service, instances, definitions));
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

  if (
    service.updatedAt !== trackedService.updatedAt ||
    service.id !== trackedService.id ||
    (service.providerType === "plugin_capability" && draft.schemaKey !== currentSchemaKey)
  ) {
    const shouldReset =
      service.id !== trackedService.id ||
      (service.providerType === "plugin_capability" && draft.schemaKey !== currentSchemaKey) ||
      isDraftFieldsClean(draft, trackedService, instances, definitions);
    setTrackedService(service);
    if (shouldReset) setDraft(draftFromDto(service, instances, definitions));
  }

  useEffect(() => {
    if (!renaming || !renameInputRef.current) return;
    renameInputRef.current.focus();
    if (renameInputRef.current instanceof HTMLInputElement) renameInputRef.current.select();
  }, [renaming]);

  const isDirty = useMemo(
    () => !isDraftFieldsClean(draft, service, instances, definitions),
    [definitions, draft, instances, service],
  );
  const formDisabled = savePending || deletePending || renamePending;
  const draftBinding =
    service.providerType === "plugin_capability"
      ? preferenceSchemaForBinding(instances, definitions, draft.integrationInstanceId, draft.ocrCapabilityId)
      : null;
  const pluginSchemaUnavailable = service.providerType === "plugin_capability" && !draftBinding;

  function seedService(next: OcrServiceDto) {
    queryClient.setQueryData<OcrServiceDto[]>(ocrKeys.list(), (current) => {
      if (!current) return [next];
      return current.map((item) => (item.id === next.id ? next : item));
    });
    queryClient.setQueryData(ocrKeys.detail(next.id), next);
  }

  function updateDraft(patch: Partial<OcrDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setValidationError(null);
  }

  async function commitRename() {
    const displayName = renameValue.trim();
    if (!displayName || renamePending) return;
    if (displayName === service.displayName) {
      setRenaming(false);
      return;
    }
    setRenamePending(true);
    try {
      const saved = await saveOcrService(renameWrite(service, displayName));
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
    if (savePending || !isDirty) return;
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
    } else if (service.providerType === "plugin_capability") {
      const binding = preferenceSchemaForBinding(
        instances,
        definitions,
        draft.integrationInstanceId,
        draft.ocrCapabilityId,
      );
      if (!binding) {
        setValidationError(t("plugins.unsupportedInstance"));
        return;
      }
      write = {
        id: service.id,
        providerType: "plugin_capability",
        displayName: service.displayName,
        enabled: draft.enabled,
        integrationInstanceId: draft.integrationInstanceId,
        ocrCapabilityId: draft.ocrCapabilityId,
        capabilityPreferencesVersion: binding.descriptor.preferencesSchemaVersion,
        capabilityPreferences: buildSchemaConfig(binding.schema, draft.pluginPreferences),
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
      if (
        draft.promptTemplates.some(
          (template) => !template.name.trim() || !template.systemTemplate.trim() || !template.userTemplate.trim(),
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
        promptTemplates: draft.promptTemplates.map((template) => ({ ...template, name: template.name.trim() })),
        expectedUpdatedAt: draft.expectedUpdatedAt,
      };
    }

    setSavePending(true);
    setValidationError(null);
    try {
      const saved = await saveOcrService(write);
      seedService(saved);
      setDraft(draftFromDto(saved, instances, definitions));
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
    if (deletePending) return;
    setDeletePending(true);
    try {
      await deleteOcrService(service.id);
    } catch (error) {
      const message = getIpcErrorMessage(error, t("ocr.toast.deleteFailed"));
      toast.error({ title: t("ocr.toast.deleteFailed"), description: message });
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
    void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
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
                    setRenaming(false);
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
                onClick={() => setRenaming(false)}
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
                disabled={formDisabled}
                onClick={() => {
                  setRenameValue(service.displayName);
                  setRenameError(null);
                  setRenaming(true);
                }}
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
              onCheckedChange={(enabled) => updateDraft({ enabled })}
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
              className={deleteButtonClassName}
              aria-label={t("ocr.deleteConfirmTitle")}
              title={t("ocr.deleteConfirmTitle")}
              disabled={formDisabled}
              onClick={() => setDeleteOpen(true)}
            >
              <IconMaterialSymbolsLightDeleteOutlineSharp className="pointer-events-none size-5 shrink-0" />
            </Button>
            <Button
              type="button"
              className={outlineButtonClassName}
              disabled={formDisabled}
              onClick={() => {
                setDraft(draftFromDto(service, instances, definitions));
                setValidationError(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              className={saveButtonClassName}
              disabled={formDisabled || !isDirty || pluginSchemaUnavailable}
              focusableWhenDisabled
              aria-busy={savePending}
              aria-label={savePending ? t("common.saving") : t("common.save")}
              onClick={() => void handleSave()}
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
            onApiKeyChange={(apiKey) => updateDraft({ apiKey })}
            onSecretKeyChange={(secretKey) => updateDraft({ secretKey })}
            onApiKeyActionChange={(apiKeyAction) => updateDraft({ apiKeyAction })}
            onSecretKeyActionChange={(secretKeyAction) => updateDraft({ secretKeyAction })}
            onBaiduActionChange={(baiduAction) => updateDraft({ baiduAction })}
          />
        ) : service.providerType === "plugin_capability" ? (
          <PluginOcrForm
            integrationInstanceId={draft.integrationInstanceId}
            ocrCapabilityId={draft.ocrCapabilityId}
            preferences={draft.pluginPreferences}
            instances={instances}
            definitions={definitions}
            disabled={formDisabled}
            onIntegrationInstanceIdChange={(integrationInstanceId, ocrCapabilityId) => {
              const binding = preferenceSchemaForBinding(
                instances,
                definitions,
                integrationInstanceId,
                ocrCapabilityId,
              );
              if (!binding) {
                setValidationError(t("plugins.unsupportedInstance"));
                return;
              }
              updateDraft({
                integrationInstanceId,
                ocrCapabilityId,
                capabilityPreferencesVersion: binding.descriptor.preferencesSchemaVersion,
                pluginPreferences: createSchemaDraft(binding.schema),
                schemaKey: preferenceKey(
                  integrationInstanceId,
                  ocrCapabilityId,
                  binding.descriptor.preferencesSchemaVersion,
                ),
              });
            }}
            onPreferencesChange={(pluginPreferences) => updateDraft({ pluginPreferences })}
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
            onProviderModelIdChange={(providerModelId) => updateDraft({ providerModelId })}
            onTemperatureChange={(temperature) => updateDraft({ temperature })}
            onDefaultPromptTemplateIdChange={(defaultPromptTemplateId) => updateDraft({ defaultPromptTemplateId })}
            onPromptTemplatesChange={(promptTemplates) => updateDraft({ promptTemplates })}
          />
        )}
        {capabilityHealth ? (
          <section className="mt-6 space-y-1" aria-label={t("plugins.capabilityHealth.title")}>
            <h3 className="text-label-sm font-bold tracking-wide text-neutral uppercase">
              {t("plugins.capabilityHealth.title")}
            </h3>
            <p className="text-body-tight text-on-surface">
              {t(capabilityHealth.capabilityLabelKey, { defaultValue: capabilityHealth.capabilityId })}:{" "}
              {t(capabilityHealth.statusLabelKey, { defaultValue: capabilityHealth.status })}
              {capabilityHealth.normalizedCode ? ` (${capabilityHealth.normalizedCode})` : ""}
            </p>
          </section>
        ) : null}
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
