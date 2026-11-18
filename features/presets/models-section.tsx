import { cleanup, effect, Text, View, windowSize, type InputRef, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { FormField } from "../../modules/ai/ui/form-field";
import { resolveModelBindingInfo } from "./model-choices";
import type { ModelChoice, PresetValidationField } from "./types";

interface ModelsSectionProps {
  primaryModelId: string | null;
  fallbackModelIds: readonly string[];
  temperatureText: string;
  maxOutputTokensText: string;
  saving: boolean;
  modelChoices: readonly ModelChoice[];
  modelsError: string | null;
  errorMessage: string | null;
  errorField: PresetValidationField | null;
  errorFallbackIndex: number | null;
  onChangePrimary: (modelId: string | null) => void;
  onAddFallback: () => void;
  onChangeFallback: (index: number, modelId: string) => void;
  onMoveFallback: (index: number, direction: "up" | "down") => void;
  onRemoveFallback: (index: number) => void;
  onChangeTemperature: (value: string) => void;
  onChangeMaxOutputTokens: (value: string) => void;
  onManageModels: () => void;
  onPrimaryModelRef: (node: ViewRef) => void;
  onFallbackRef: (index: number, node: ViewRef | null) => void;
  onTemperatureRef: (node: InputRef) => void;
  onMaxTokensRef: (node: InputRef) => void;
}

/** Editor section for ordered primary + fallback AI models and optional sampling parameters. */
export function ModelsSection(props: ModelsSectionProps) {
  const compact = () => windowSize().width < 860;
  const cardClass = () => (compact() ? "gap-4 p-4" : "gap-5 p-5");

  const fieldError = (field: PresetValidationField): string | null =>
    props.errorField === field ? props.errorMessage : null;

  const primaryBinding = () =>
    props.primaryModelId ? resolveModelBindingInfo(props.primaryModelId) : null;

  const fallbackError = (index: number): string | null =>
    props.errorField === "fallbackModel" && props.errorFallbackIndex === index
      ? props.errorMessage
      : null;

  const primaryItems = (): SelectItem[] => {
    const usedByFallbacks = new Set(props.fallbackModelIds.filter((id) => id.length > 0));
    const items: SelectItem[] = props.modelChoices
      .filter((choice) => !usedByFallbacks.has(choice.id))
      .map((choice) => ({
        value: choice.id,
        title: choice.label,
      }));
    const currentId = props.primaryModelId;
    if (currentId && !props.modelChoices.some((choice) => choice.id === currentId)) {
      const resolved = resolveModelBindingInfo(currentId);
      items.unshift({ value: currentId, title: resolved.label });
    }
    return items;
  };

  const fallbackItems = (rowIndex: number): SelectItem[] => {
    const usedElsewhere = new Set<string>();
    if (props.primaryModelId) {
      usedElsewhere.add(props.primaryModelId);
    }
    for (let i = 0; i < props.fallbackModelIds.length; i++) {
      if (i === rowIndex) continue;
      const other = props.fallbackModelIds[i];
      if (other) usedElsewhere.add(other);
    }

    const items: SelectItem[] = props.modelChoices
      .filter((choice) => !usedElsewhere.has(choice.id))
      .map((choice) => ({
        value: choice.id,
        title: choice.label,
      }));
    const currentId = props.fallbackModelIds[rowIndex] ?? "";
    if (currentId && !props.modelChoices.some((choice) => choice.id === currentId)) {
      const resolved = resolveModelBindingInfo(currentId);
      items.unshift({ value: currentId, title: resolved.label });
    }
    return items;
  };

  const canAddFallback = () => {
    if (props.saving) return false;
    const assigned = new Set<string>();
    if (props.primaryModelId) {
      assigned.add(props.primaryModelId);
    }
    let emptySlots = 0;
    for (const id of props.fallbackModelIds) {
      if (id.length > 0) {
        assigned.add(id);
      } else {
        emptySlots += 1;
      }
    }
    const remainingCount = props.modelChoices.filter((choice) => !assigned.has(choice.id)).length;
    return remainingCount > emptySlots;
  };

  const hasUnavailableBinding = () => {
    const primary = primaryBinding();
    if (primary !== null && !primary.available) return true;
    return props.fallbackModelIds.some(
      (id) => id.length > 0 && !resolveModelBindingInfo(id).available,
    );
  };

  const showCatalogBanner = () => props.modelsError !== null || props.modelChoices.length === 0;

  return (
    <Card class={cardClass()}>
      <View class="flex-row items-center justify-between gap-2">
        <SectionHeading title={t("presets.section.models")} />
        <If when={!showCatalogBanner() && hasUnavailableBinding()}>
          <Button
            testID="preset-manage-models"
            variant="outline"
            size="sm"
            label={t("presets.action.manageModels")}
            disabled={props.saving}
            onPress={() => props.onManageModels()}
          />
        </If>
      </View>

      <If when={showCatalogBanner()}>
        <View
          testID="preset-models-recovery"
          class="gap-2 rounded-lg border border-border bg-muted/50 p-3"
        >
          <Text
            role="alert"
            class={
              props.modelsError !== null
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {props.modelsError !== null
              ? t("presets.model.catalogLoadError")
              : t("presets.model.noEligible")}
          </Text>
          <View class="flex-row">
            <Button
              testID="preset-manage-models"
              variant="outline"
              size="sm"
              label={t("presets.action.manageModels")}
              disabled={props.saving}
              onPress={() => props.onManageModels()}
            />
          </View>
        </View>
      </If>

      <FormField label={t("presets.model.primary")} error={fieldError("primaryModel")}>
        <Select
          testID="preset-primary-model"
          ref={(node) => props.onPrimaryModelRef(node)}
          items={primaryItems()}
          value={props.primaryModelId}
          placeholder={t("presets.model.selectPlaceholder")}
          disabled={props.saving || primaryItems().length === 0}
          accessibilityLabel={t("presets.model.primary")}
          onChange={(value) => props.onChangePrimary(value)}
        />
        <If when={primaryBinding() !== null && !primaryBinding()!.available}>
          <Text testID="preset-primary-unavailable" class="text-xs text-warning">
            {primaryBinding()!.reason}
          </Text>
        </If>
      </FormField>

      <View class="gap-2">
        <View class="flex-row items-center justify-between gap-2">
          <Text class="text-xs font-medium text-foreground">{t("presets.model.fallbacks")}</Text>
          <Button
            testID="preset-add-fallback"
            variant="outline"
            size="xs"
            label={t("presets.model.addFallback")}
            disabled={!canAddFallback()}
            onPress={() => props.onAddFallback()}
          />
        </View>

        <If when={props.fallbackModelIds.length > 0}>
          <View class="gap-2">
            <Each of={props.fallbackModelIds} key="index">
              {(modelId, index) => {
                let selectNode: ViewRef | null = null;
                effect(() => {
                  const rowIndex = index();
                  if (selectNode) {
                    props.onFallbackRef(rowIndex, selectNode);
                  }
                  cleanup(() => props.onFallbackRef(rowIndex, null));
                });

                const binding = () => (modelId() ? resolveModelBindingInfo(modelId()) : null);
                const err = () => fallbackError(index());

                return (
                  <View testID={`preset-fallback-row-${index()}`} class="gap-1">
                    <View class="flex-row items-center gap-2">
                      <View class="min-w-0 flex-1">
                        <Select
                          testID={`preset-fallback-${index()}`}
                          ref={(node) => {
                            selectNode = node;
                          }}
                          items={fallbackItems(index())}
                          value={modelId() || null}
                          placeholder={t("presets.model.selectPlaceholder")}
                          disabled={props.saving || fallbackItems(index()).length === 0}
                          accessibilityLabel={t("presets.model.fallbackItemLabel", {
                            index: index() + 1,
                          })}
                          onChange={(value) => {
                            if (value) {
                              props.onChangeFallback(index(), value);
                            }
                          }}
                        />
                      </View>
                      <Button
                        testID={`preset-fallback-up-${index()}`}
                        variant="ghost"
                        size="icon-sm"
                        tooltip={t("presets.model.moveUp", { index: index() + 1 })}
                        accessibilityLabel={t("presets.model.moveUp", { index: index() + 1 })}
                        disabled={props.saving || index() === 0}
                        onPress={() => props.onMoveFallback(index(), "up")}
                      >
                        <Icon name="arrow-up" tone="muted-foreground" class="size-3.5" />
                      </Button>
                      <Button
                        testID={`preset-fallback-down-${index()}`}
                        variant="ghost"
                        size="icon-sm"
                        tooltip={t("presets.model.moveDown", { index: index() + 1 })}
                        accessibilityLabel={t("presets.model.moveDown", { index: index() + 1 })}
                        disabled={props.saving || index() === props.fallbackModelIds.length - 1}
                        onPress={() => props.onMoveFallback(index(), "down")}
                      >
                        <Icon name="arrow-down" tone="muted-foreground" class="size-3.5" />
                      </Button>
                      <Button
                        testID={`preset-fallback-remove-${index()}`}
                        variant="ghost"
                        size="icon-sm"
                        tooltip={t("presets.model.removeFallback", { index: index() + 1 })}
                        accessibilityLabel={t("presets.model.removeFallback", {
                          index: index() + 1,
                        })}
                        disabled={props.saving}
                        onPress={() => props.onRemoveFallback(index())}
                      >
                        <Icon name="close" tone="muted-foreground" class="size-3.5" />
                      </Button>
                    </View>

                    <If when={err() !== null}>
                      <Text role="alert" class="text-xs text-destructive">
                        {err()}
                      </Text>
                    </If>
                    <If when={err() === null && binding() !== null && !binding()!.available}>
                      <Text
                        testID={`preset-fallback-unavailable-${index()}`}
                        class="text-xs text-warning"
                      >
                        {binding()!.reason}
                      </Text>
                    </If>
                  </View>
                );
              }}
            </Each>
          </View>
        </If>
      </View>

      <View class={compact() ? "gap-4" : "flex-row gap-4"}>
        <FormField
          class={compact() ? "" : "min-w-0 flex-1"}
          label={t("presets.model.temperature")}
          error={fieldError("temperature")}
        >
          <Input
            testID="preset-temperature"
            ref={(node) => props.onTemperatureRef(node)}
            value={props.temperatureText}
            placeholder={t("presets.model.temperaturePlaceholder")}
            accessibilityLabel={t("presets.model.temperature")}
            disabled={props.saving}
            onChange={(value) => props.onChangeTemperature(value)}
          />
        </FormField>

        <FormField
          class={compact() ? "" : "min-w-0 flex-1"}
          label={t("presets.model.maxOutputTokens")}
          error={fieldError("maxOutputTokens")}
        >
          <Input
            testID="preset-max-output-tokens"
            ref={(node) => props.onMaxTokensRef(node)}
            value={props.maxOutputTokensText}
            placeholder={t("presets.model.maxOutputTokensPlaceholder")}
            accessibilityLabel={t("presets.model.maxOutputTokens")}
            disabled={props.saving}
            onChange={(value) => props.onChangeMaxOutputTokens(value)}
          />
        </FormField>
      </View>
    </Card>
  );
}
