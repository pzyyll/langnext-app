import { signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Select, type SelectItem } from "../../components/ui/select";
import { FormField } from "../../modules/ai/ui/form-field";
import { modelsStore } from "../models/store";
import { readAvailableModelChoices, resolveModelBindingInfo } from "../presets/model-choices";
import { ocrSettingsStore, type OcrServiceBinding, type OcrServiceKind } from "../ocr/settings";

/** OCR services in display order; AI is the only service in this release. */
const SERVICE_CHOICES: readonly OcrServiceKind[] = ["ai"];

interface OcrSectionProps {
  compact: boolean;
  platformOs: string;
  onManageModels?: () => void;
}

/** Settings section for the saved OCR service and its image-capable model. */
export function OcrSection(props: OcrSectionProps) {
  const saved = ocrSettingsStore.settings();
  const selectedService = signal<OcrServiceKind>(saved?.kind ?? "ai");
  const draftModelId = signal<string | null>(saved?.kind === "ai" ? saved.modelId : null);
  const error = signal<string | null>(null);
  const saving = signal(false);

  const modelChoices = () => readAvailableModelChoices("image");
  const catalogUnusable = () => modelsStore.channelsError() !== null || modelChoices().length === 0;
  const eligibleModelId = () =>
    modelChoices().find((choice) => choice.id === draftModelId())?.id ?? null;
  const binding = () => {
    const modelId = draftModelId();
    return modelId === null ? null : resolveModelBindingInfo(modelId, "image");
  };
  const bindingUnavailable = () => {
    const info = binding();
    return info !== null && !info.available;
  };

  const serviceItems = (): SelectItem[] =>
    SERVICE_CHOICES.map((kind) => ({ value: kind, title: t(`settings.ocr.${kind}`) }));

  const selectService = (value: string | null) => {
    const kind = SERVICE_CHOICES.find((choice) => choice === value);
    if (!kind || saving()) return;
    error.set(null);
    selectedService.set(kind);
  };

  const modelItems = (): SelectItem[] =>
    modelChoices().map((choice) => ({ value: choice.id, title: choice.label }));

  const selectModel = (modelId: string | null) => {
    if (modelId === null || saving()) return;
    error.set(null);
    draftModelId.set(modelId);
  };

  const draftBinding = (): OcrServiceBinding | null => {
    const kind = selectedService();
    switch (kind) {
      case "ai": {
        const modelId = eligibleModelId();
        return modelId === null ? null : { kind, modelId };
      }
      case "baidu":
        return null;
    }
  };

  const handleSave = async () => {
    const binding = draftBinding();
    if (saving() || binding === null) return;
    error.set(null);
    saving.set(true);
    try {
      const result = await ocrSettingsStore.save(binding);
      if (!result.ok) {
        error.set(result.message);
        return;
      }
      if (result.binding.kind === "ai") draftModelId.set(result.binding.modelId);
    } finally {
      saving.set(false);
    }
  };

  const cardClass = () => (props.compact ? "gap-4 p-4" : "gap-5 p-6");

  return (
    <Card testID="settings-ocr-card" class={cardClass()}>
      <View class="flex-row items-center justify-between gap-2">
        <SectionHeading title={t("settings.ocr.title")} />
        <If when={!catalogUnusable() && bindingUnavailable()}>
          <Button
            testID="settings-ocr-manage-models"
            variant="outline"
            size="sm"
            label={t("presets.action.manageModels")}
            disabled={saving()}
            onPress={() => props.onManageModels?.()}
          />
        </If>
      </View>

      <If when={ocrSettingsStore.loadError() !== null}>
        <Text testID="settings-ocr-load-error" role="alert" class="text-sm text-destructive">
          {ocrSettingsStore.loadError()!.message}
        </Text>
      </If>

      <FormField label={t("settings.ocr.service")}>
        <Select
          testID="settings-ocr-service"
          items={serviceItems()}
          value={selectedService()}
          disabled={saving()}
          accessibilityLabel={t("settings.ocr.service")}
          onChange={selectService}
        />
      </FormField>

      <If when={catalogUnusable()}>
        <View
          testID="settings-ocr-models-recovery"
          class="gap-2 rounded-lg border border-border bg-muted/50 p-3"
        >
          <Text
            role="alert"
            class={
              modelsStore.channelsError() !== null
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {modelsStore.channelsError() !== null
              ? t("presets.model.catalogLoadError")
              : t("presets.model.noEligibleImageModel")}
          </Text>
          <View class="flex-row">
            <Button
              testID="settings-ocr-manage-models"
              variant="outline"
              size="sm"
              label={t("presets.action.manageModels")}
              disabled={saving()}
              onPress={() => props.onManageModels?.()}
            />
          </View>
        </View>
      </If>

      <Each of={[selectedService()]} key={(kind) => kind}>
        {(kind) => (
          <If when={kind() === "ai"}>
            <FormField label={t("settings.ocr.model")}>
              <Select
                testID="settings-ocr-model"
                items={modelItems()}
                value={eligibleModelId()}
                placeholder={t("presets.model.selectPlaceholder")}
                disabled={saving() || modelItems().length === 0}
                accessibilityLabel={t("settings.ocr.model")}
                onChange={selectModel}
              />
              <If when={bindingUnavailable()}>
                <Text testID="settings-ocr-model-unavailable" class="text-xs text-warning">
                  {binding()?.reason}
                </Text>
              </If>
            </FormField>
          </If>
        )}
      </Each>

      <Text testID="settings-ocr-privacy" class="text-xs text-muted-foreground">
        {t("settings.ocr.privacy")}
      </Text>

      <If when={props.platformOs !== "windows"}>
        <Text testID="settings-ocr-windows-only" class="text-xs text-muted-foreground">
          {t("settings.ocr.windowsOnly")}
        </Text>
      </If>

      <If when={error() !== null}>
        <Text testID="settings-ocr-error" role="alert" class="text-sm text-destructive">
          {error()}
        </Text>
      </If>

      <View class="flex-row justify-end">
        <Button
          testID="settings-ocr-save"
          variant="primary"
          size="sm"
          label={saving() ? t("common.saving") : t("common.save")}
          disabled={saving() || draftBinding() === null}
          onPress={() => void handleSave()}
        />
      </View>
    </Card>
  );
}
