import { effect, signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { AppDialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { toast } from "../../components/ui/toast";
import type { ProviderPresetId } from "../../services/protocols/presets";
import type { AdapterId } from "../../services/protocols/types";
import { FormField } from "./form-field";
import {
  getModelApiTypeItems,
  MODEL_DEFAULT_API_VALUE,
  resolveEffectiveCapabilities,
} from "./model-helpers";
import type { CapabilityOverrides, ProviderModel } from "./types";

export interface EditModelSubmission {
  id: string;
  displayNameOverride: string | null;
  apiTypeOverride: AdapterId | null;
  capabilitiesOverride: CapabilityOverrides | null;
  contextLimit: number | null;
  maxTokens: number | null;
}

interface EditModelDialogProps {
  open: boolean;
  presetId: ProviderPresetId;
  model: ProviderModel | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: EditModelSubmission) => Promise<void> | void;
}

function parseOptionalPositiveInt(
  raw: string,
  label: string,
): {
  value: number | null;
  error: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, error: null };
  if (!/^\d+$/.test(trimmed)) {
    return { value: null, error: t("models.error.positiveInteger", { label }) };
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num <= 0) {
    return { value: null, error: t("models.error.positive", { label }) };
  }
  return { value: num, error: null };
}

/** Modal dialog for per-model display name, API type, capabilities, and token limits. */
export function EditModelDialog(props: EditModelDialogProps) {
  const displayNameOverride = signal("");
  const apiTypeOverride = signal(MODEL_DEFAULT_API_VALUE);
  const capText = signal(true);
  const capImage = signal(false);
  const capPdf = signal(false);
  const capVideo = signal(false);
  const contextLimit = signal("");
  const maxTokens = signal("");
  const submitting = signal(false);
  const submitError = signal<string | null>(null);

  effect(() => {
    const model = props.model;
    if (props.open && model) {
      const caps = resolveEffectiveCapabilities(model);
      displayNameOverride.set(model.displayNameOverride ?? "");
      apiTypeOverride.set(model.apiTypeOverride ?? MODEL_DEFAULT_API_VALUE);
      capText.set(caps.text);
      capImage.set(caps.image);
      capPdf.set(caps.pdf);
      capVideo.set(caps.video);
      contextLimit.set(model.contextLimit !== null ? String(model.contextLimit) : "");
      maxTokens.set(model.maxTokens !== null ? String(model.maxTokens) : "");
      submitting.set(false);
      submitError.set(null);
    }
  });

  const handleSave = async () => {
    const model = props.model;
    if (!model || submitting()) return;

    const ctxParsed = parseOptionalPositiveInt(contextLimit(), t("models.model.contextLimit"));
    if (ctxParsed.error) {
      submitError.set(ctxParsed.error);
      return;
    }

    const maxParsed = parseOptionalPositiveInt(maxTokens(), t("models.model.maxTokens"));
    if (maxParsed.error) {
      submitError.set(maxParsed.error);
      return;
    }

    submitting.set(true);
    submitError.set(null);
    try {
      await props.onSubmit({
        id: model.id,
        displayNameOverride: displayNameOverride().trim() || null,
        apiTypeOverride:
          apiTypeOverride() === MODEL_DEFAULT_API_VALUE ? null : (apiTypeOverride() as AdapterId),
        capabilitiesOverride: {
          text: capText(),
          image: capImage(),
          pdf: capPdf(),
          video: capVideo(),
        },
        contextLimit: ctxParsed.value,
        maxTokens: maxParsed.value,
      });
      toast.success(t("models.model.updated", { key: model.modelKey }));
      props.onOpenChange(false);
    } catch (error) {
      submitError.set(error instanceof Error ? error.message : t("models.error.saveModel"));
    } finally {
      submitting.set(false);
    }
  };

  const handleInputKeyPress = (key: string) => {
    if (key === "Escape" && !submitting()) {
      props.onOpenChange(false);
    }
  };

  return (
    <AppDialog
      testID="edit-model-dialog"
      open={props.open}
      onOpenChange={(open) => {
        if (!submitting()) props.onOpenChange(open);
      }}
      title={t("models.model.configure")}
      size="md"
      closeOnEscape={!submitting()}
      closeOnBackdropPress={!submitting()}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            label={t("common.cancel")}
            disabled={submitting()}
            onPress={() => props.onOpenChange(false)}
          />
          <Button
            testID="confirm-edit-model"
            variant="primary"
            size="sm"
            label={submitting() ? t("common.saving") : t("common.save")}
            disabled={submitting()}
            onPress={() => void handleSave()}
          />
        </>
      }
    >
      <If when={props.model}>
        {(model) => (
          <>
            <View class="rounded-lg border border-border bg-muted px-3 py-2">
              <Text class="text-xs font-medium text-muted-foreground">{model().modelKey}</Text>
            </View>

            <FormField label={t("common.displayName")}>
              <Input
                testID="edit-model-name-input"
                accessibilityLabel={t("common.displayName")}
                placeholder={model().displayName ?? model().modelKey}
                autoFocus
                value={displayNameOverride()}
                onChange={(v) => displayNameOverride.set(v)}
                onSubmit={() => void handleSave()}
                onKeyPress={handleInputKeyPress}
              />
            </FormField>

            <FormField label={t("models.column.apiType")}>
              <Select
                testID="edit-model-api-select"
                accessibilityLabel={t("models.column.apiType")}
                items={getModelApiTypeItems(props.presetId)}
                value={apiTypeOverride()}
                onChange={(v) => {
                  if (v) apiTypeOverride.set(v);
                }}
              />
            </FormField>

            <FormField label={t("models.model.capabilities")}>
              <View class="flex-row flex-wrap gap-4 pt-1">
                <Checkbox
                  testID="edit-model-cap-text"
                  label={t("models.capability.text")}
                  checked={capText()}
                  onChange={(checked) => capText.set(checked)}
                />
                <Checkbox
                  testID="edit-model-cap-image"
                  label={t("models.capability.image")}
                  checked={capImage()}
                  onChange={(checked) => capImage.set(checked)}
                />
                <Checkbox
                  testID="edit-model-cap-pdf"
                  label={t("models.capability.pdf")}
                  checked={capPdf()}
                  onChange={(checked) => capPdf.set(checked)}
                />
                <Checkbox
                  testID="edit-model-cap-video"
                  label={t("models.capability.video")}
                  checked={capVideo()}
                  onChange={(checked) => capVideo.set(checked)}
                />
              </View>
            </FormField>

            <View class="flex-row gap-3">
              <FormField label={t("models.model.contextLimit")} class="min-w-0 flex-1">
                <Input
                  testID="edit-model-context-input"
                  accessibilityLabel={t("models.model.contextLimit")}
                  placeholder={t("common.optional")}
                  value={contextLimit()}
                  onChange={(v) => contextLimit.set(v)}
                  onSubmit={() => void handleSave()}
                  onKeyPress={handleInputKeyPress}
                />
              </FormField>
              <FormField label={t("models.model.maxTokens")} class="min-w-0 flex-1">
                <Input
                  testID="edit-model-max-tokens-input"
                  accessibilityLabel={t("models.model.maxTokens")}
                  placeholder={t("common.optional")}
                  value={maxTokens()}
                  onChange={(v) => maxTokens.set(v)}
                  onSubmit={() => void handleSave()}
                  onKeyPress={handleInputKeyPress}
                />
              </FormField>
            </View>

            <If when={submitError() !== null}>
              <Text role="alert" class="text-xs text-destructive">
                {submitError()}
              </Text>
            </If>
          </>
        )}
      </If>
    </AppDialog>
  );
}
