// ABOUTME: Provider model table with capability icons, enabled switches, and selection mode.
// ABOUTME: Displays manual, remote, and built-in model DTOs without fabricating data.
import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { Input } from "@base-ui/react/input";
import { Switch } from "@base-ui/react/switch";
import { Tooltip } from "@base-ui/react/tooltip";
import { useTranslation } from "react-i18next";
import IconIcOutlineImage from "~icons/ic/outline-image";
import IconIcOutlinePictureAsPdf from "~icons/ic/outline-picture-as-pdf";
import IconIcOutlineTextSnippet from "~icons/ic/outline-text-snippet";
import IconIcOutlineVideocam from "~icons/ic/outline-videocam";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightEditSquareOutlineSharp from "~icons/material-symbols-light/edit-square-outline-sharp";
import {
  checkboxClassName,
  checkboxIndicatorClassName,
  iconButtonClassName,
  inputClassName,
  switchRootClassName,
  switchThumbClassName,
  tooltipArrowClassName,
  tooltipPopupClassName,
} from "../../components/ui";
import { SelectField } from "../../components/SelectField";
import type { ProviderModelDto } from "../../storage/types";
import { getAdapterLabel } from "./adapterOptions";
import {
  getModelEnabledFilter,
  isModelEnabledFilter,
  modelMatchesSearch,
  setModelEnabledFilter,
  type ModelEnabledFilter,
} from "./modelListPreferences";

const CAPABILITY_TOOLTIP_DELAY_MS = 300;
/** Leave room for the 6px arrow tip between popup and trigger. */
const CAPABILITY_TOOLTIP_SIDE_OFFSET_PX = 8;

const capabilityIconClassName = "size-4 shrink-0 text-on-surface";

const capabilityTooltipTriggerClassName =
  "inline-flex items-center justify-center border-0 bg-transparent p-0 text-on-surface focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface";

type ModelCapabilityFlags = {
  textGeneration: boolean;
  imageAnalysis: boolean;
  pdfAnalysis: boolean;
  videoProcessing: boolean;
};

function resolveCapabilityFlags(model: ProviderModelDto): ModelCapabilityFlags {
  const caps = model.capabilityOverridesJson;
  return {
    textGeneration: caps?.textGeneration ?? true,
    imageAnalysis: caps?.imageAnalysis ?? false,
    pdfAnalysis: caps?.pdfAnalysis ?? false,
    videoProcessing: caps?.videoProcessing ?? false,
  };
}

function CapabilityIconTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger className={capabilityTooltipTriggerClassName} aria-label={label}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={CAPABILITY_TOOLTIP_SIDE_OFFSET_PX}>
          <Tooltip.Popup className={tooltipPopupClassName}>
            <Tooltip.Arrow className={tooltipArrowClassName} />
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export type ModelsTableProps = {
  models: ProviderModelDto[];
  pendingModelIds: ReadonlySet<string>;
  onEnabledChange: (modelId: string, enabled: boolean) => void;
  /** Open the per-model configuration dialog. */
  onEditModel?: (model: ProviderModelDto) => void;
  selectionMode?: boolean;
  selectedModelIds?: ReadonlySet<string>;
  onToggleSelect?: (modelId: string) => void;
  /** Select or clear selection for the currently visible (filtered) model ids. */
  onToggleSelectAll?: (checked: boolean, visibleModelIds: readonly string[]) => void;
};

function resolveDisplayName(model: ProviderModelDto): string {
  return model.displayNameOverride ?? model.remoteDisplayName ?? "-";
}

function filterModels(
  models: ProviderModelDto[],
  searchQuery: string,
  enabledFilter: ModelEnabledFilter,
): ProviderModelDto[] {
  return models.filter((model) => {
    if (enabledFilter === "enabled" && !model.enabled) {
      return false;
    }
    if (enabledFilter === "disabled" && model.enabled) {
      return false;
    }
    return modelMatchesSearch(model, searchQuery);
  });
}

export function ModelsTable({
  models,
  pendingModelIds,
  onEnabledChange,
  onEditModel,
  selectionMode = false,
  selectedModelIds = new Set(),
  onToggleSelect,
  onToggleSelectAll,
}: ModelsTableProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [enabledFilter, setEnabledFilterState] = useState<ModelEnabledFilter>(() => getModelEnabledFilter());

  const filteredModels = useMemo(
    () => filterModels(models, searchQuery, enabledFilter),
    [models, searchQuery, enabledFilter],
  );

  function handleEnabledFilterChange(value: string) {
    const next = isModelEnabledFilter(value) ? value : "all";
    setEnabledFilterState(next);
    setModelEnabledFilter(next);
  }

  if (models.length === 0) {
    return <p className="text-body-tight text-neutral">{t("models.noModels")}</p>;
  }

  const allSelected = filteredModels.length > 0 && filteredModels.every((model) => selectedModelIds.has(model.id));

  return (
    <div className="flex flex-col gap-4">
      <div
        className="
          flex flex-col gap-3
          sm:flex-row sm:items-center
        "
      >
        <div className="min-w-0 flex-1">
          <label className="sr-only" htmlFor="models-search">
            {t("models.searchModels")}
          </label>
          <div className="relative">
            <Input
              id="models-search"
              type="search"
              className={`
                ${inputClassName}
                ${searchQuery ? "pr-9" : ""}
              `}
              placeholder={t("models.searchPlaceholder")}
              value={searchQuery}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setSearchQuery(event.currentTarget.value);
              }}
            />
            {searchQuery ? (
              <Button
                type="button"
                className={`
                  group absolute top-1/2 right-1 inline-flex size-4 shrink-0 -translate-y-1/2 cursor-default
                  items-center justify-center rounded-none border-0 bg-transparent text-error/80
                  hover:text-error
                  focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface
                  disabled:text-disabled
                  data-disabled:text-disabled
                `}
                aria-label={t("common.clear")}
                onClick={() => {
                  setSearchQuery("");
                }}
              >
                <IconMaterialSymbolsLightClose
                  className="
                    pointer-events-none shrink-0 transition-transform duration-150
                    group-hover:scale-110
                  "
                  aria-hidden
                />
              </Button>
            ) : null}
          </div>
        </div>
        <div
          className="
            w-full
            sm:w-40
          "
        >
          <SelectField
            value={enabledFilter}
            onValueChange={(value) => handleEnabledFilterChange(value ?? "all")}
            options={[
              { value: "all", label: t("common.all") },
              { value: "enabled", label: t("common.enabled") },
              { value: "disabled", label: t("common.disabled") },
            ]}
            aria-label={t("models.filterEnabled")}
          />
        </div>
      </div>

      {filteredModels.length === 0 ? (
        <p className="text-body-tight text-neutral">{t("models.noModelsMatch")}</p>
      ) : (
        <div className="overflow-x-auto">
          <Tooltip.Provider delay={CAPABILITY_TOOLTIP_DELAY_MS}>
            <table className="w-full min-w-2xl text-left">
              <thead>
                <tr className="border-b border-line text-table-header font-semibold text-neutral uppercase">
                  {selectionMode ? (
                    <th className="w-10 pb-2 font-semibold">
                      <Checkbox.Root
                        className={checkboxClassName}
                        checked={allSelected}
                        aria-label={t("models.selectAllModels")}
                        onCheckedChange={(checked) => {
                          onToggleSelectAll?.(
                            checked,
                            filteredModels.map((model) => model.id),
                          );
                        }}
                      >
                        <Checkbox.Indicator className={checkboxIndicatorClassName}>
                          <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
                        </Checkbox.Indicator>
                      </Checkbox.Root>
                    </th>
                  ) : null}
                  <th className="pb-2 font-semibold">{t("models.modelCount", { count: filteredModels.length })}</th>
                  <th className="pb-2 text-center font-semibold">{t("models.displayNameCol")}</th>
                  <th className="pb-2 text-center font-semibold">{t("models.apiTypeCol")}</th>
                  <th className="pb-2 text-center font-semibold">{t("models.editModelConfig.capabilities")}</th>
                  <th className="w-12 pb-2 text-center font-semibold">
                    <span className="sr-only">{t("models.editModelConfig.column")}</span>
                  </th>
                  <th className="pb-2 text-right font-semibold">{t("models.enabledCol")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/30">
                {filteredModels.map((model) => {
                  const pending = pendingModelIds.has(model.id);
                  const canEditConfig = onEditModel !== undefined;
                  const capabilities = resolveCapabilityFlags(model);
                  return (
                    <tr key={model.id}>
                      {selectionMode ? (
                        <td className="py-4">
                          <Checkbox.Root
                            className={checkboxClassName}
                            checked={selectedModelIds.has(model.id)}
                            disabled={pending}
                            aria-label={t("models.selectModel", { name: model.modelKey })}
                            onCheckedChange={() => {
                              onToggleSelect?.(model.id);
                            }}
                          >
                            <Checkbox.Indicator className={checkboxIndicatorClassName}>
                              <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
                            </Checkbox.Indicator>
                          </Checkbox.Root>
                        </td>
                      ) : null}
                      <td className="py-4">
                        <span className="font-mono text-mono-key font-bold text-on-surface">{model.modelKey}</span>
                      </td>
                      <td className="py-4 text-center text-body-tight text-neutral">{resolveDisplayName(model)}</td>
                      <td className="py-4 text-center text-body-tight text-neutral">
                        {model.adapterId ? getAdapterLabel(model.adapterId) : t("models.apiTypeInherit")}
                      </td>
                      <td className="py-4">
                        <div className="flex items-center justify-center gap-1.5">
                          {capabilities.textGeneration ? (
                            <CapabilityIconTooltip label={t("models.editModelConfig.textGeneration")}>
                              <IconIcOutlineTextSnippet className={capabilityIconClassName} aria-hidden />
                            </CapabilityIconTooltip>
                          ) : null}
                          {capabilities.imageAnalysis ? (
                            <CapabilityIconTooltip label={t("models.editModelConfig.imageAnalysis")}>
                              <IconIcOutlineImage className={capabilityIconClassName} aria-hidden />
                            </CapabilityIconTooltip>
                          ) : null}
                          {capabilities.pdfAnalysis ? (
                            <CapabilityIconTooltip label={t("models.editModelConfig.pdfAnalysis")}>
                              <IconIcOutlinePictureAsPdf className={capabilityIconClassName} aria-hidden />
                            </CapabilityIconTooltip>
                          ) : null}
                          {capabilities.videoProcessing ? (
                            <CapabilityIconTooltip label={t("models.editModelConfig.videoProcessing")}>
                              <IconIcOutlineVideocam className={capabilityIconClassName} aria-hidden />
                            </CapabilityIconTooltip>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-4 text-center">
                        {canEditConfig ? (
                          <Button
                            type="button"
                            className={iconButtonClassName}
                            aria-label={t("models.editModelConfig.editAria", { name: model.modelKey })}
                            title={t("models.editModelConfig.editAria", { name: model.modelKey })}
                            disabled={pending}
                            onClick={() => {
                              onEditModel(model);
                            }}
                          >
                            <IconMaterialSymbolsLightEditSquareOutlineSharp className="pointer-events-none size-5 shrink-0" />
                          </Button>
                        ) : null}
                      </td>
                      <td className="py-4 text-right">
                        <div className="flex justify-end">
                          <Switch.Root
                            checked={model.enabled}
                            disabled={pending}
                            onCheckedChange={(checked: boolean) => {
                              onEnabledChange(model.id, checked);
                            }}
                            className={switchRootClassName}
                            aria-label={`Toggle ${model.modelKey}`}
                          >
                            <Switch.Thumb className={switchThumbClassName} />
                          </Switch.Root>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Tooltip.Provider>
        </div>
      )}
    </div>
  );
}
