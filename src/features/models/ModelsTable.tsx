// ABOUTME: Provider model table with enabled switches, config edit entry, and selection mode.
// ABOUTME: Displays manual, remote, and built-in model DTOs without fabricating data.
import { useMemo, useState } from "react";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { Input } from "@base-ui/react/input";
import { Switch } from "@base-ui/react/switch";
import { useTranslation } from "react-i18next";
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <label className="sr-only" htmlFor="models-search">
            {t("models.searchModels")}
          </label>
          <div className="relative">
            <Input
              id="models-search"
              type="search"
              className={`${inputClassName} ${searchQuery ? "pr-9" : ""}`}
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
                className={`inline-flex size-4 shrink-0 cursor-default items-center justify-center rounded-none border-0 bg-transparent text-error/80 hover:text-error focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-disabled:text-disabled disabled:text-disabled group absolute top-1/2 right-1 -translate-y-1/2`}
                aria-label={t("common.clear")}
                onClick={() => {
                  setSearchQuery("");
                }}
              >
                <IconMaterialSymbolsLightClose
                  className="pointer-events-none shrink-0 transition-transform duration-150 group-hover:scale-110"
                  aria-hidden
                />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="w-full sm:w-40">
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
        </div>
      )}
    </div>
  );
}
