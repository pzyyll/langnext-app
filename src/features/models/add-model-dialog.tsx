import { effect, signal, Text } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { AppDialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast";
import type { ProviderTypeId } from "../../modules/ai/contracts/channel";
import type { ProtocolId } from "../../modules/ai/contracts/protocol";
import { FormField } from "../../modules/ai/ui/form-field";
import { getModelApiTypeItems, MODEL_DEFAULT_API_VALUE } from "./model-helpers";

export interface AddModelSubmission {
  modelKey: string;
  displayNameOverride: string | null;
  apiTypeOverride: ProtocolId | null;
  enabled: boolean;
}

interface AddModelDialogProps {
  open: boolean;
  presetId: ProviderTypeId;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: AddModelSubmission) => Promise<void> | void;
}

/** Modal dialog for manually registering a model under a channel. */
export function AddModelDialog(props: AddModelDialogProps) {
  const modelKey = signal("");
  const displayName = signal("");
  const apiType = signal<string>(MODEL_DEFAULT_API_VALUE);
  const enabled = signal(true);
  const submitting = signal(false);
  const submitError = signal<string | null>(null);

  effect(() => {
    if (props.open) {
      modelKey.set("");
      displayName.set("");
      apiType.set(MODEL_DEFAULT_API_VALUE);
      enabled.set(true);
      submitting.set(false);
      submitError.set(null);
    }
  });

  const handleSubmit = async () => {
    if (submitting()) return;
    const key = modelKey().trim();
    if (!key) {
      submitError.set(t("models.error.modelIdRequired"));
      return;
    }

    submitting.set(true);
    submitError.set(null);
    try {
      await props.onSubmit({
        modelKey: key,
        displayNameOverride: displayName().trim() || null,
        apiTypeOverride: apiType() === MODEL_DEFAULT_API_VALUE ? null : (apiType() as ProtocolId),
        enabled: enabled(),
      });
      toast.success(t("models.model.added", { key }));
      props.onOpenChange(false);
    } catch (error) {
      submitError.set(error instanceof Error ? error.message : t("models.error.addModel"));
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
      testID="add-model-dialog"
      open={props.open}
      onOpenChange={(open) => {
        if (!submitting()) props.onOpenChange(open);
      }}
      title={t("models.model.add")}
      size="sm"
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
            testID="confirm-add-model"
            variant="primary"
            size="sm"
            label={submitting() ? t("common.adding") : t("models.model.add")}
            disabled={submitting()}
            onPress={() => void handleSubmit()}
          />
        </>
      }
    >
      <FormField label={t("models.model.id")}>
        <Input
          testID="add-model-key-input"
          accessibilityLabel={t("models.model.id")}
          placeholder={t("models.model.idPlaceholder")}
          autoFocus
          value={modelKey()}
          onChange={(v) => modelKey.set(v)}
          onSubmit={() => void handleSubmit()}
          onKeyPress={handleInputKeyPress}
        />
      </FormField>

      <FormField label={t("common.displayName")}>
        <Input
          testID="add-model-name-input"
          accessibilityLabel={t("common.displayName")}
          placeholder={t("common.optional")}
          value={displayName()}
          onChange={(v) => displayName.set(v)}
          onSubmit={() => void handleSubmit()}
          onKeyPress={handleInputKeyPress}
        />
      </FormField>

      <FormField label={t("models.column.apiType")}>
        <Select
          testID="add-model-api-select"
          accessibilityLabel={t("models.column.apiType")}
          items={getModelApiTypeItems(props.presetId)}
          value={apiType()}
          onChange={(v) => {
            if (v) apiType.set(v);
          }}
        />
      </FormField>

      <Switch
        testID="add-model-enabled-switch"
        label={t("models.channel.enabled")}
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
