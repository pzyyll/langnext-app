import { effect, signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { FormField } from "../../modules/ai/ui/form-field";
import { modelsStore } from "../models/store";
import { readAvailableModelChoices, resolveModelBindingInfo } from "../presets/model-choices";
import {
  isBaiduOcrOperation,
  ocrSettingsStore,
  type BaiduOcrOperation,
  type OcrServiceKind,
  type SaveOcrBindingInput,
} from "../ocr/settings";

const SERVICE_CHOICES: readonly OcrServiceKind[] = ["ai", "baidu"];
const BAIDU_OPERATIONS: readonly BaiduOcrOperation[] = [
  "general_basic",
  "accurate_basic",
  "general",
  "accurate",
];

interface OcrSectionProps {
  compact: boolean;
  platformOs: string;
  onManageModels?: () => void;
}

type CredentialState = "unknown" | "readable" | "missing";

/** Settings section for the one active OCR service. */
export function OcrSection(props: OcrSectionProps) {
  const saved = ocrSettingsStore.settings();
  const selectedService = signal<OcrServiceKind>(saved?.kind ?? "ai");
  const draftModelId = signal<string | null>(saved?.kind === "ai" ? saved.modelId : null);
  const draftOperation = signal<BaiduOcrOperation>(
    saved?.kind === "baidu" ? saved.operation : "accurate",
  );
  const apiKeyDraft = signal("");
  const secretKeyDraft = signal("");
  const credentialState = signal<CredentialState>("unknown");
  const error = signal<string | null>(null);
  const saving = signal(false);

  effect(() => {
    const current = ocrSettingsStore.settings();
    if (current?.kind !== "baidu") {
      credentialState.set("unknown");
      return;
    }
    const ref = current.credentialRef;
    void ocrSettingsStore.readBaiduCredentials(ref).then((pair) => {
      const latest = ocrSettingsStore.settings();
      if (latest?.kind !== "baidu" || latest.credentialRef !== ref) return;
      credentialState.set(pair ? "readable" : "missing");
    });
  });

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
  const showAiRecovery = () => selectedService() === "ai" && catalogUnusable();
  const canKeepKeys = () =>
    selectedService() === "baidu" &&
    ocrSettingsStore.settings()?.kind === "baidu" &&
    credentialState() === "readable";

  const serviceItems = (): SelectItem[] =>
    SERVICE_CHOICES.map((kind) => ({ value: kind, title: t(`settings.ocr.${kind}`) }));

  const selectService = (value: string | null) => {
    const kind = SERVICE_CHOICES.find((choice) => choice === value);
    if (!kind || kind === selectedService() || saving()) return;
    error.set(null);
    apiKeyDraft.set("");
    secretKeyDraft.set("");
    const current = ocrSettingsStore.settings();
    if (kind === "baidu") {
      draftOperation.set(current?.kind === "baidu" ? current.operation : "accurate");
    }
    if (kind === "ai") {
      draftModelId.set(current?.kind === "ai" ? current.modelId : null);
    }
    selectedService.set(kind);
  };

  const modelItems = (): SelectItem[] =>
    modelChoices().map((choice) => ({ value: choice.id, title: choice.label }));
  const operationItems = (): SelectItem[] =>
    BAIDU_OPERATIONS.map((operation) => ({
      value: operation,
      title: t(`settings.ocr.operation.${operation}`),
    }));

  const selectModel = (modelId: string | null) => {
    if (modelId === null || saving()) return;
    error.set(null);
    draftModelId.set(modelId);
  };

  const selectOperation = (value: string | null) => {
    if (!isBaiduOcrOperation(value) || saving()) return;
    error.set(null);
    draftOperation.set(value);
  };

  const draftSaveInput = (): SaveOcrBindingInput | null => {
    if (selectedService() === "ai") {
      const modelId = eligibleModelId();
      return modelId === null ? null : { kind: "ai", modelId };
    }
    const apiKey = apiKeyDraft().trim();
    const secretKey = secretKeyDraft().trim();
    if (apiKey.length > 0 && secretKey.length > 0) {
      return {
        kind: "baidu",
        operation: draftOperation(),
        credentials: { kind: "replace", apiKey, secretKey },
      };
    }
    if (apiKey.length === 0 && secretKey.length === 0 && canKeepKeys()) {
      return { kind: "baidu", operation: draftOperation(), credentials: { kind: "keep" } };
    }
    return null;
  };

  const handleSave = async () => {
    const input = draftSaveInput();
    if (saving() || input === null) return;
    error.set(null);
    saving.set(true);
    try {
      const result = await ocrSettingsStore.save(input);
      if (!result.ok) {
        error.set(result.message);
        return;
      }
      apiKeyDraft.set("");
      secretKeyDraft.set("");
      if (result.binding.kind === "ai") draftModelId.set(result.binding.modelId);
      if (result.binding.kind === "baidu") draftOperation.set(result.binding.operation);
    } finally {
      saving.set(false);
    }
  };

  const cardClass = () => (props.compact ? "gap-4 p-4" : "gap-5 p-6");

  return (
    <Card testID="settings-ocr-card" class={cardClass()}>
      <View class="flex-row items-center justify-between gap-2">
        <SectionHeading title={t("settings.ocr.title")} />
        <If when={selectedService() === "ai" && !catalogUnusable() && bindingUnavailable()}>
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

      <Each of={[selectedService()]} key={(kind) => kind}>
        {(kind) => (
          <View class="gap-5">
            <If when={kind() === "ai" && showAiRecovery()}>
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

            <If when={kind() === "baidu"}>
              <FormField label={t("settings.ocr.mode")}>
                <Select
                  testID="settings-ocr-baidu-operation"
                  items={operationItems()}
                  value={draftOperation()}
                  disabled={saving()}
                  accessibilityLabel={t("settings.ocr.mode")}
                  onChange={selectOperation}
                />
              </FormField>
              <FormField label={t("settings.ocr.apiKey")}>
                <Input
                  testID="settings-ocr-baidu-api-key"
                  value={apiKeyDraft()}
                  masked={true}
                  disabled={saving()}
                  accessibilityLabel={t("settings.ocr.apiKey")}
                  onChange={(value) => {
                    error.set(null);
                    apiKeyDraft.set(value);
                  }}
                />
              </FormField>
              <FormField
                label={t("settings.ocr.secretKey")}
                hint={canKeepKeys() ? t("settings.ocr.keepKeys") : null}
              >
                <Input
                  testID="settings-ocr-baidu-secret-key"
                  value={secretKeyDraft()}
                  masked={true}
                  disabled={saving()}
                  accessibilityLabel={t("settings.ocr.secretKey")}
                  onChange={(value) => {
                    error.set(null);
                    secretKeyDraft.set(value);
                  }}
                />
              </FormField>
            </If>
          </View>
        )}
      </Each>

      <If when={selectedService() === "baidu" && credentialState() === "missing"}>
        <Text
          testID="settings-ocr-baidu-keys-missing"
          role="alert"
          class="text-sm text-destructive"
        >
          {t("settings.ocr.keysUnreadable")}
        </Text>
      </If>

      <If when={selectedService() === "ai" && ocrSettingsStore.settings()?.kind === "baidu"}>
        <Text testID="settings-ocr-baidu-removal" class="text-xs text-muted-foreground">
          {t("settings.ocr.switchToAi")}
        </Text>
      </If>

      <Text testID="settings-ocr-privacy" class="text-xs text-muted-foreground">
        {selectedService() === "baidu" ? t("settings.ocr.privacyBaidu") : t("settings.ocr.privacy")}
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
          disabled={saving() || draftSaveInput() === null}
          onPress={() => void handleSave()}
        />
      </View>
    </Card>
  );
}
