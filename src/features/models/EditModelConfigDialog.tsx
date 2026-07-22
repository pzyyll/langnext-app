// ABOUTME: Modal dialog for editing model display name, API type, capabilities, and token limits.
// ABOUTME: Persists overrides through IPC for any model source; profile max tokens still override at request time.
import { useMemo, useState } from "react";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { Dialog } from "@base-ui/react/dialog";
import { Input } from "@base-ui/react/input";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import {
  checkboxClassName,
  checkboxIndicatorClassName,
  dialogBackdropClassName,
  dialogPopupClassName,
  iconButtonClassName,
  inputClassName,
  outlineButtonClassName,
  primaryButtonClassName,
} from "../../components/ui";
import { SelectField } from "../../components/SelectField";
import { useToast } from "../../components/toast/useToast";
import { updateModelConfig } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { CapabilityOverridesV1, ProviderModelDto } from "../../storage/types";
import { ADAPTER_OPTIONS, getAdapterLabel } from "./adapterOptions";

const TOKEN_MIN = 1;
const TOKEN_MAX = 0xffff_ffff;
const DEFAULT_CONTEXT_LIMIT = 128 * 1024;
const DEFAULT_MAX_TOKENS = 32 * 1024;
const DISPLAY_NAME_MAX_LEN = 200;

// Header / body / footer own spacing. Replace conflicting utilities in the shared
// popup chrome instead of appending overrides (Tailwind keeps one winner per property
// by CSS generation order, not className string order).
const editModelDialogPopupClassName = [
  dialogPopupClassName
    .replace(/\bw-96\b/, "w-md")
    .replace(/\bgap-4\b/, "gap-0")
    .replace(/\bp-gutter\b/, "p-0"),
  "max-h-[min(90dvh,40rem)] overflow-y-auto",
].join(" ");

export type EditModelConfigDialogProps = {
  open: boolean;
  model: ProviderModelDto | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (model: ProviderModelDto) => void;
};

export function EditModelConfigDialog({ open, model, onOpenChange, onSaved }: EditModelConfigDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdropClassName} />
        <Dialog.Popup className={editModelDialogPopupClassName}>
          <div className="flex flex-col gap-0.5 border-b border-line p-4">
            <div className="flex items-center justify-between gap-2">
              <Dialog.Title className="min-w-0 text-headline-sm font-bold tracking-tight text-on-surface uppercase italic">
                {t("models.editModelConfig.title")}
              </Dialog.Title>
              <Dialog.Close className={iconButtonClassName} aria-label={t("common.close")}>
                <IconMaterialSymbolsLightClose className="pointer-events-none size-5 shrink-0" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="truncate font-mono text-xs text-neutral">
              {model?.modelKey ?? t("models.editModelConfig.title")}
            </Dialog.Description>
          </div>
          {open && model ? (
            <EditModelConfigForm
              key={model.id}
              model={model}
              onSaved={(updated) => {
                onSaved(updated);
                onOpenChange(false);
              }}
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type EditModelConfigFormProps = {
  model: ProviderModelDto;
  onSaved: (model: ProviderModelDto) => void;
};

function EditModelConfigForm({ model, onSaved }: EditModelConfigFormProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const initial = useMemo(() => formStateFromModel(model), [model]);

  const [displayNameOverride, setDisplayNameOverride] = useState(initial.displayNameOverride);
  const [adapterId, setAdapterId] = useState(initial.adapterId);
  const [textGeneration, setTextGeneration] = useState(initial.textGeneration);
  const [imageAnalysis, setImageAnalysis] = useState(initial.imageAnalysis);
  const [pdfAnalysis, setPdfAnalysis] = useState(initial.pdfAnalysis);
  const [videoProcessing, setVideoProcessing] = useState(initial.videoProcessing);
  const [contextLimit, setContextLimit] = useState(initial.contextLimit);
  const [maxTokens, setMaxTokens] = useState(initial.maxTokens);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayNamePlaceholder = model.remoteDisplayName?.trim() || t("common.optional");

  const isDirty =
    displayNameOverride !== initial.displayNameOverride ||
    adapterId !== initial.adapterId ||
    textGeneration !== initial.textGeneration ||
    imageAnalysis !== initial.imageAnalysis ||
    pdfAnalysis !== initial.pdfAnalysis ||
    videoProcessing !== initial.videoProcessing ||
    contextLimit !== initial.contextLimit ||
    maxTokens !== initial.maxTokens;

  async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !isDirty) {
      return;
    }

    setPending(true);
    setError(null);
    try {
      const nextAdapterId = adapterId.trim() ? adapterId.trim() : null;
      const nextDisplayName = displayNameOverride.trim() ? displayNameOverride.trim() : null;
      const capabilityOverridesJson = buildCapabilityOverrides({
        previous: model.capabilityOverridesJson,
        textGeneration,
        imageAnalysis,
        pdfAnalysis,
        videoProcessing,
        contextLimit,
        maxTokens,
      });
      const updated = await updateModelConfig({
        id: model.id,
        displayNameOverride: nextDisplayName,
        adapterId: nextAdapterId,
        capabilityOverridesJson,
      });
      toast.success({
        title: t("models.toast.modelConfigSaved"),
        description: updated.displayNameOverride ?? updated.remoteDisplayName ?? updated.modelKey,
      });
      onSaved(updated);
    } catch (err: unknown) {
      const message = getIpcErrorMessage(err, t("models.toast.updateModelFailed"));
      setError(message);
      toast.error({ title: t("models.toast.updateFailed"), description: message });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="flex flex-col" onSubmit={(event) => void handleSubmit(event)}>
      <div className="space-y-6 p-6">
        <div className="space-y-2">
          <label
            className="block text-label-sm font-bold tracking-widest text-neutral uppercase"
            htmlFor="edit-model-display-name"
          >
            {t("models.displayName")}
          </label>
          <Input
            id="edit-model-display-name"
            type="text"
            className={inputClassName}
            value={displayNameOverride}
            onChange={(event) => {
              setDisplayNameOverride(event.currentTarget.value);
            }}
            maxLength={DISPLAY_NAME_MAX_LEN}
            placeholder={displayNamePlaceholder}
            spellCheck={false}
            disabled={pending}
          />
        </div>

        <div className="space-y-2">
          <label
            className="block text-label-sm font-bold tracking-widest text-neutral uppercase"
            id="edit-model-api-type-label"
          >
            {t("models.apiTypeLabel")}
          </label>
          <SelectField
            value={adapterId}
            onValueChange={(value) => setAdapterId(value ?? "")}
            options={[
              { value: "", label: t("models.apiTypeInherit") },
              ...ADAPTER_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
            ]}
            extraOptions={
              adapterId && !ADAPTER_OPTIONS.some((o) => o.id === adapterId)
                ? [{ value: adapterId, label: getAdapterLabel(adapterId) }]
                : undefined
            }
            disabled={pending}
            aria-labelledby="edit-model-api-type-label"
          />
        </div>

        <div className="space-y-2">
          <span className="block text-label-sm font-bold tracking-widest text-neutral uppercase">
            {t("models.editModelConfig.capabilities")}
          </span>
          <div className="flex flex-wrap gap-4 pt-1">
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox.Root
                className={checkboxClassName}
                checked={textGeneration}
                onCheckedChange={(checked) => {
                  setTextGeneration(checked);
                }}
                disabled={pending}
              >
                <Checkbox.Indicator className={checkboxIndicatorClassName}>
                  <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <span className="text-body-tight font-medium text-on-surface">
                {t("models.editModelConfig.textGeneration")}
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox.Root
                className={checkboxClassName}
                checked={imageAnalysis}
                onCheckedChange={(checked) => {
                  setImageAnalysis(checked);
                }}
                disabled={pending}
              >
                <Checkbox.Indicator className={checkboxIndicatorClassName}>
                  <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <span className="text-body-tight font-medium text-on-surface">
                {t("models.editModelConfig.imageAnalysis")}
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox.Root
                className={checkboxClassName}
                checked={pdfAnalysis}
                onCheckedChange={(checked) => {
                  setPdfAnalysis(checked);
                }}
                disabled={pending}
              >
                <Checkbox.Indicator className={checkboxIndicatorClassName}>
                  <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <span className="text-body-tight font-medium text-on-surface">
                {t("models.editModelConfig.pdfAnalysis")}
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox.Root
                className={checkboxClassName}
                checked={videoProcessing}
                onCheckedChange={(checked) => {
                  setVideoProcessing(checked);
                }}
                disabled={pending}
              >
                <Checkbox.Indicator className={checkboxIndicatorClassName}>
                  <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <span className="text-body-tight font-medium text-on-surface">
                {t("models.editModelConfig.videoProcessing")}
              </span>
            </label>
          </div>
        </div>

        <div
          className="
            grid gap-4
            sm:grid-cols-2
          "
        >
          <div className="space-y-2">
            <label
              className="block text-label-sm font-bold tracking-widest text-neutral uppercase"
              htmlFor="edit-model-context-limit"
            >
              {t("models.editModelConfig.contextLimit")}
            </label>
            <Input
              id="edit-model-context-limit"
              type="number"
              className={`
                ${inputClassName}
                font-mono
              `}
              min={TOKEN_MIN}
              max={TOKEN_MAX}
              step={1}
              value={contextLimit}
              onChange={(event) => {
                setContextLimit(toPositiveInteger(event.currentTarget.value, DEFAULT_CONTEXT_LIMIT));
              }}
              disabled={pending}
              required
            />
          </div>

          <div className="space-y-2">
            <label
              className="block text-label-sm font-bold tracking-widest text-neutral uppercase"
              htmlFor="edit-model-max-tokens"
            >
              {t("models.editModelConfig.maxTokens")}
            </label>
            <Input
              id="edit-model-max-tokens"
              type="number"
              className={`
                ${inputClassName}
                font-mono
              `}
              min={TOKEN_MIN}
              max={TOKEN_MAX}
              step={1}
              value={maxTokens}
              onChange={(event) => {
                setMaxTokens(toPositiveInteger(event.currentTarget.value, DEFAULT_MAX_TOKENS));
              }}
              disabled={pending}
              required
            />
          </div>
        </div>

        {error ? (
          <p className="text-body-tight text-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex justify-end gap-3 border-t border-line bg-surface-2 p-4">
        <Dialog.Close className={outlineButtonClassName} disabled={pending}>
          {t("common.cancel")}
        </Dialog.Close>
        <Button type="submit" className={primaryButtonClassName} disabled={pending || !isDirty} focusableWhenDisabled>
          {pending ? t("common.saving") : t("models.editModelConfig.save")}
        </Button>
      </div>
    </form>
  );
}

type FormState = {
  displayNameOverride: string;
  adapterId: string;
  textGeneration: boolean;
  imageAnalysis: boolean;
  pdfAnalysis: boolean;
  videoProcessing: boolean;
  contextLimit: number;
  maxTokens: number;
};

function formStateFromModel(model: ProviderModelDto): FormState {
  const caps = model.capabilityOverridesJson;
  return {
    displayNameOverride: model.displayNameOverride ?? "",
    adapterId: model.adapterId ?? "",
    textGeneration: caps?.textGeneration ?? true,
    imageAnalysis: caps?.imageAnalysis ?? false,
    pdfAnalysis: caps?.pdfAnalysis ?? false,
    videoProcessing: caps?.videoProcessing ?? false,
    contextLimit: positiveIntegerOr(caps?.maxContextTokens, DEFAULT_CONTEXT_LIMIT),
    // Prefer the request value when present so existing configs keep their effective max.
    maxTokens: positiveIntegerOr(caps?.defaultOutputTokens ?? caps?.maxOutputTokens, DEFAULT_MAX_TOKENS),
  };
}

function positiveIntegerOr(value: number | null | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value < TOKEN_MIN) {
    return fallback;
  }
  return Math.min(TOKEN_MAX, Math.round(value));
}

function toPositiveInteger(raw: string, fallback: number): number {
  return positiveIntegerOr(Number(raw), fallback);
}

function buildCapabilityOverrides(input: {
  previous: CapabilityOverridesV1 | null;
  textGeneration: boolean;
  imageAnalysis: boolean;
  pdfAnalysis: boolean;
  videoProcessing: boolean;
  contextLimit: number;
  maxTokens: number;
}): CapabilityOverridesV1 {
  const overrides: CapabilityOverridesV1 = {
    schemaVersion: 1,
    textGeneration: input.textGeneration,
    imageAnalysis: input.imageAnalysis,
    pdfAnalysis: input.pdfAnalysis,
    videoProcessing: input.videoProcessing,
    maxContextTokens: input.contextLimit,
    // Write the same value for both fields so the request path uses Max Tokens as-is.
    maxOutputTokens: input.maxTokens,
    defaultOutputTokens: input.maxTokens,
  };
  // Preserve streaming when present so unrelated sparse fields are not dropped.
  if (input.previous?.streaming != null) {
    overrides.streaming = input.previous.streaming;
  }
  return overrides;
}
