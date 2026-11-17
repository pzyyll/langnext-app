import { effect, signal, Text } from "nsh";
import { Button } from "../../components/ui/button";
import { AppDialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast";
import { ADAPTER_SPECS } from "../../services/protocols/adapters";
import type { AdapterId } from "../../services/protocols/types";
import { FormField } from "./form-field";
import { createManualModel } from "./store";

const DEFAULT_ADAPTER_VALUE = "__default__";

const API_TYPE_ITEMS: SelectItem[] = [
  { value: DEFAULT_ADAPTER_VALUE, title: "Default (Channel)" },
  ...ADAPTER_SPECS.map((spec) => ({ value: spec.id, title: spec.label })),
];

interface AddModelDialogProps {
  open: boolean;
  providerId: string;
  onOpenChange: (open: boolean) => void;
}

/** Modal dialog for manually registering a model under a channel. */
export function AddModelDialog(props: AddModelDialogProps) {
  const modelKey = signal("");
  const displayName = signal("");
  const apiType = signal<string>(DEFAULT_ADAPTER_VALUE);
  const enabled = signal(true);
  const submitting = signal(false);
  const submitError = signal<string | null>(null);

  effect(() => {
    if (props.open) {
      modelKey.set("");
      displayName.set("");
      apiType.set(DEFAULT_ADAPTER_VALUE);
      enabled.set(true);
      submitting.set(false);
      submitError.set(null);
    }
  });

  const handleSubmit = async () => {
    if (submitting()) return;
    const key = modelKey().trim();
    if (!key) {
      submitError.set("Model ID is required.");
      return;
    }

    submitting.set(true);
    submitError.set(null);
    try {
      await createManualModel({
        providerId: props.providerId,
        modelKey: key,
        displayNameOverride: displayName().trim() || null,
        apiTypeOverride: apiType() === DEFAULT_ADAPTER_VALUE ? null : (apiType() as AdapterId),
        enabled: enabled(),
      });
      toast.success(`Added model ${key}`);
      props.onOpenChange(false);
    } catch (error) {
      submitError.set(error instanceof Error ? error.message : "Could not add model.");
    } finally {
      submitting.set(false);
    }
  };

  return (
    <AppDialog
      testID="add-model-dialog"
      open={props.open}
      onOpenChange={(open) => {
        if (!submitting()) props.onOpenChange(open);
      }}
      title="Add Model"
      size="sm"
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
            testID="confirm-add-model"
            variant="primary"
            size="sm"
            label={submitting() ? "Adding…" : "Add Model"}
            disabled={submitting()}
            onPress={() => void handleSubmit()}
          />
        </>
      }
    >
      <FormField label="Model ID">
        <Input
          testID="add-model-key-input"
          accessibilityLabel="Model ID"
          placeholder="e.g. gpt-4.1-mini"
          autoFocus
          value={modelKey()}
          onChange={(v) => modelKey.set(v)}
        />
      </FormField>

      <FormField label="Display Name">
        <Input
          testID="add-model-name-input"
          accessibilityLabel="Display Name"
          placeholder="Optional"
          value={displayName()}
          onChange={(v) => displayName.set(v)}
        />
      </FormField>

      <FormField label="API Type">
        <Select
          testID="add-model-api-select"
          accessibilityLabel="API Type"
          items={API_TYPE_ITEMS}
          value={apiType()}
          onChange={(v) => {
            if (v) apiType.set(v);
          }}
        />
      </FormField>

      <Switch
        testID="add-model-enabled-switch"
        label="Enabled"
        variant="row"
        checked={enabled()}
        onChange={(checked) => enabled.set(checked)}
      />

      <If when={submitError() !== null}>
        <Text role="alert" class="text-xs text-destructive">
          {submitError()}
        </Text>
      </If>
    </AppDialog>
  );
}
