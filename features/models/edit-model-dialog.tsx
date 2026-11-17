import { effect, signal, Text, View } from "nsh";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { AppDialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { toast } from "../../components/ui/toast";
import { ADAPTER_SPECS } from "../../services/protocols/adapters";
import type { AdapterId } from "../../services/protocols/types";
import { FormField } from "./form-field";
import { resolveEffectiveCapabilities } from "./model-helpers";
import { updateModelConfig } from "./store";
import type { ProviderModel } from "./types";

const DEFAULT_ADAPTER_VALUE = "__default__";

const API_TYPE_ITEMS: SelectItem[] = [
  { value: DEFAULT_ADAPTER_VALUE, title: "Default (Source)" },
  ...ADAPTER_SPECS.map((spec) => ({ value: spec.id, title: spec.label })),
];

interface EditModelDialogProps {
  open: boolean;
  model: ProviderModel | null;
  onOpenChange: (open: boolean) => void;
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
    return { value: null, error: `${label} must be a positive whole number.` };
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num <= 0) {
    return { value: null, error: `${label} must be greater than 0.` };
  }
  return { value: num, error: null };
}

/** Modal dialog for per-model display name, API type, capabilities, and token limits. */
export function EditModelDialog(props: EditModelDialogProps) {
  const displayNameOverride = signal("");
  const apiTypeOverride = signal(DEFAULT_ADAPTER_VALUE);
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
      apiTypeOverride.set(model.apiTypeOverride ?? DEFAULT_ADAPTER_VALUE);
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

    const ctxParsed = parseOptionalPositiveInt(contextLimit(), "Context Limit");
    if (ctxParsed.error) {
      submitError.set(ctxParsed.error);
      return;
    }

    const maxParsed = parseOptionalPositiveInt(maxTokens(), "Max Tokens");
    if (maxParsed.error) {
      submitError.set(maxParsed.error);
      return;
    }

    submitting.set(true);
    submitError.set(null);
    try {
      await updateModelConfig({
        id: model.id,
        displayNameOverride: displayNameOverride().trim() || null,
        apiTypeOverride:
          apiTypeOverride() === DEFAULT_ADAPTER_VALUE ? null : (apiTypeOverride() as AdapterId),
        capabilitiesOverride: {
          text: capText(),
          image: capImage(),
          pdf: capPdf(),
          video: capVideo(),
        },
        contextLimit: ctxParsed.value,
        maxTokens: maxParsed.value,
      });
      toast.success(`Updated ${model.modelKey}`);
      props.onOpenChange(false);
    } catch (error) {
      submitError.set(error instanceof Error ? error.message : "Could not save model settings.");
    } finally {
      submitting.set(false);
    }
  };

  return (
    <AppDialog
      testID="edit-model-dialog"
      open={props.open}
      onOpenChange={(open) => {
        if (!submitting()) props.onOpenChange(open);
      }}
      title="Configure Model"
      size="md"
      closeOnEscape={!submitting()}
      closeOnBackdropPress={!submitting()}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            label="Cancel"
            disabled={submitting()}
            onPress={() => props.onOpenChange(false)}
          />
          <Button
            testID="confirm-edit-model"
            variant="primary"
            size="sm"
            label={submitting() ? "Saving…" : "Save"}
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

            <FormField label="Display Name">
              <Input
                testID="edit-model-name-input"
                accessibilityLabel="Display Name"
                placeholder={model().displayName ?? model().modelKey}
                value={displayNameOverride()}
                onChange={(v) => displayNameOverride.set(v)}
              />
            </FormField>

            <FormField label="API Type">
              <Select
                testID="edit-model-api-select"
                accessibilityLabel="API Type"
                items={API_TYPE_ITEMS}
                value={apiTypeOverride()}
                onChange={(v) => {
                  if (v) apiTypeOverride.set(v);
                }}
              />
            </FormField>

            <FormField label="Capabilities">
              <View class="flex-row flex-wrap gap-4 pt-1">
                <Checkbox
                  testID="edit-model-cap-text"
                  label="Text"
                  checked={capText()}
                  onChange={(checked) => capText.set(checked)}
                />
                <Checkbox
                  testID="edit-model-cap-image"
                  label="Image"
                  checked={capImage()}
                  onChange={(checked) => capImage.set(checked)}
                />
                <Checkbox
                  testID="edit-model-cap-pdf"
                  label="PDF"
                  checked={capPdf()}
                  onChange={(checked) => capPdf.set(checked)}
                />
                <Checkbox
                  testID="edit-model-cap-video"
                  label="Video"
                  checked={capVideo()}
                  onChange={(checked) => capVideo.set(checked)}
                />
              </View>
            </FormField>

            <View class="flex-row gap-3">
              <FormField label="Context Limit" class="min-w-0 flex-1">
                <Input
                  testID="edit-model-context-input"
                  accessibilityLabel="Context Limit"
                  placeholder="Optional"
                  value={contextLimit()}
                  onChange={(v) => contextLimit.set(v)}
                />
              </FormField>
              <FormField label="Max Tokens" class="min-w-0 flex-1">
                <Input
                  testID="edit-model-max-tokens-input"
                  accessibilityLabel="Max Tokens"
                  placeholder="Optional"
                  value={maxTokens()}
                  onChange={(v) => maxTokens.set(v)}
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
