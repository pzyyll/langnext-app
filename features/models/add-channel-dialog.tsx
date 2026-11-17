import { effect, signal, Text } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { AppDialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast";
import { ADAPTER_SPECS, getAdapterDefaultBaseUrl } from "../../services/protocols/adapters";
import type { AdapterId } from "../../services/protocols/types";
import { inspectBaseUrl } from "./connection";
import { FormField } from "./form-field";
import { createChannel } from "./store";

interface AddChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ADAPTER_ITEMS: SelectItem[] = ADAPTER_SPECS.map((spec) => ({
  value: spec.id,
  title: spec.label,
}));

/** Modal dialog for adding a new provider channel. */
export function AddChannelDialog(props: AddChannelDialogProps) {
  const displayName = signal("");
  const adapterId = signal<AdapterId>("openai-compatible");
  const baseUrl = signal("");
  const credential = signal("");
  const allowInsecureHttp = signal(false);
  const enabled = signal(true);
  const submitting = signal(false);
  const submitError = signal<string | null>(null);

  effect(() => {
    if (props.open) {
      displayName.set("");
      adapterId.set("openai-compatible");
      baseUrl.set("");
      credential.set("");
      allowInsecureHttp.set(false);
      enabled.set(true);
      submitting.set(false);
      submitError.set(null);
    }
  });

  const urlCheck = () => inspectBaseUrl(baseUrl());

  const handleAdapterChange = (next: string | null) => {
    if (next) adapterId.set(next as AdapterId);
  };

  const handleSubmit = async () => {
    if (submitting()) return;
    const trimmedName = displayName().trim();
    if (!trimmedName) {
      submitError.set(t("models.error.displayNameRequired"));
      return;
    }

    const check = urlCheck();
    if (!check.ok) {
      submitError.set(check.error ?? t("models.error.invalidBaseUrl"));
      return;
    }
    if (check.isInsecureHttp && !allowInsecureHttp()) {
      submitError.set(t("models.error.confirmInsecureSave"));
      return;
    }

    submitting.set(true);
    submitError.set(null);
    try {
      const created = await createChannel({
        displayName: trimmedName,
        adapterId: adapterId(),
        baseUrl: check.normalizedBaseUrl,
        credential: credential(),
        enabled: enabled(),
        allowInsecureHttp: allowInsecureHttp(),
      });
      toast.success(t("models.channel.added", { name: created.displayName }));
      props.onOpenChange(false);
    } catch (error) {
      submitError.set(error instanceof Error ? error.message : t("models.error.addChannel"));
    } finally {
      submitting.set(false);
    }
  };

  return (
    <AppDialog
      testID="add-channel-dialog"
      open={props.open}
      onOpenChange={(open) => {
        if (!submitting()) props.onOpenChange(open);
      }}
      title={t("models.channel.add")}
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
            testID="confirm-add-channel"
            variant="primary"
            size="sm"
            label={submitting() ? t("common.adding") : t("models.channel.add")}
            disabled={submitting()}
            onPress={() => void handleSubmit()}
          />
        </>
      }
    >
      <FormField label={t("common.displayName")}>
        <Input
          testID="add-channel-name-input"
          accessibilityLabel={t("common.displayName")}
          placeholder={t("models.channel.displayNamePlaceholder")}
          autoFocus
          value={displayName()}
          onChange={(v) => displayName.set(v)}
        />
      </FormField>

      <FormField label={t("models.connection.apiType")}>
        <Select
          testID="add-channel-adapter-select"
          accessibilityLabel={t("models.connection.apiType")}
          items={ADAPTER_ITEMS}
          value={adapterId()}
          onChange={handleAdapterChange}
        />
      </FormField>

      <FormField label={t("models.connection.baseUrl")} error={urlCheck().error}>
        <Input
          testID="add-channel-url-input"
          accessibilityLabel={t("models.connection.baseUrl")}
          placeholder={getAdapterDefaultBaseUrl(adapterId())}
          value={baseUrl()}
          onChange={(v) => {
            baseUrl.set(v);
            if (!inspectBaseUrl(v).isInsecureHttp) {
              allowInsecureHttp.set(false);
            }
          }}
        />
      </FormField>

      <If when={urlCheck().isInsecureHttp}>
        <Checkbox
          testID="add-channel-insecure-checkbox"
          checked={allowInsecureHttp()}
          onChange={(checked) => allowInsecureHttp.set(checked)}
          label={t("models.connection.insecureHttp")}
        />
      </If>

      <FormField label={t("models.connection.apiKey")}>
        <Input
          testID="add-channel-token-input"
          accessibilityLabel={t("models.connection.apiKey")}
          masked
          placeholder={t("models.connection.apiKeyPlaceholder")}
          value={credential()}
          onChange={(v) => credential.set(v)}
        />
      </FormField>

      <Switch
        testID="add-channel-enabled-switch"
        label={t("models.channel.enabledSwitch")}
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
