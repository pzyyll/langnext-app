import { effect, signal, Text } from "nsh";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { AppDialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast";
import {
  ADAPTER_SPECS,
  getAdapterDefaultBaseUrl,
  getAdapterSpec,
} from "../../services/protocols/adapters";
import type { AdapterId, CredentialKind } from "../../services/protocols/types";
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

const CREDENTIAL_KIND_ITEMS: SelectItem[] = [
  { value: "api_key", title: "API Key" },
  { value: "bearer", title: "Bearer Token" },
  { value: "none", title: "None" },
];

/** Modal dialog for adding a new provider channel. */
export function AddChannelDialog(props: AddChannelDialogProps) {
  const displayName = signal("");
  const adapterId = signal<AdapterId>("openai-compatible");
  const baseUrl = signal("");
  const credentialKind = signal<CredentialKind>("bearer");
  const credentialKindTouched = signal(false);
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
      credentialKind.set("bearer");
      credentialKindTouched.set(false);
      credential.set("");
      allowInsecureHttp.set(false);
      enabled.set(true);
      submitting.set(false);
      submitError.set(null);
    }
  });

  const urlCheck = () => inspectBaseUrl(baseUrl());

  const handleAdapterChange = (next: string | null) => {
    if (!next) return;
    const id = next as AdapterId;
    adapterId.set(id);
    if (!credentialKindTouched()) {
      credentialKind.set(getAdapterSpec(id).defaultCredentialKind);
    }
  };

  const handleSubmit = async () => {
    if (submitting()) return;
    const trimmedName = displayName().trim();
    if (!trimmedName) {
      submitError.set("Display name is required.");
      return;
    }

    const check = urlCheck();
    if (!check.ok) {
      submitError.set(check.error ?? "Invalid base URL.");
      return;
    }
    if (check.isInsecureHttp && !allowInsecureHttp()) {
      submitError.set("Confirm unencrypted http:// before saving this channel.");
      return;
    }

    submitting.set(true);
    submitError.set(null);
    try {
      const created = await createChannel({
        displayName: trimmedName,
        adapterId: adapterId(),
        baseUrl: check.normalizedBaseUrl,
        credentialKind: credentialKind(),
        credential: credentialKind() === "none" ? null : credential(),
        enabled: enabled(),
        allowInsecureHttp: allowInsecureHttp(),
      });
      toast.success(`Added channel ${created.displayName}`);
      props.onOpenChange(false);
    } catch (error) {
      submitError.set(error instanceof Error ? error.message : "Could not add channel.");
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
      title="Add Channel"
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
            testID="confirm-add-channel"
            variant="primary"
            size="sm"
            label={submitting() ? "Adding…" : "Add Channel"}
            disabled={submitting()}
            onPress={() => void handleSubmit()}
          />
        </>
      }
    >
      <FormField label="Display Name">
        <Input
          testID="add-channel-name-input"
          accessibilityLabel="Display Name"
          placeholder="e.g. OpenAI Main"
          autoFocus
          value={displayName()}
          onChange={(v) => displayName.set(v)}
        />
      </FormField>

      <FormField label="API Type">
        <Select
          testID="add-channel-adapter-select"
          accessibilityLabel="API Type"
          items={ADAPTER_ITEMS}
          value={adapterId()}
          onChange={handleAdapterChange}
        />
      </FormField>

      <FormField label="Base URL" error={urlCheck().error}>
        <Input
          testID="add-channel-url-input"
          accessibilityLabel="Base URL"
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
          label="Allow unencrypted http:// for non-local host"
        />
      </If>

      <FormField label="Credential Type">
        <Select
          testID="add-channel-credential-kind-select"
          accessibilityLabel="Credential Type"
          items={CREDENTIAL_KIND_ITEMS}
          value={credentialKind()}
          onChange={(v) => {
            if (!v) return;
            credentialKindTouched.set(true);
            credentialKind.set(v as CredentialKind);
          }}
        />
      </FormField>

      <If when={credentialKind() !== "none"}>
        <FormField label="API Token">
          <Input
            testID="add-channel-token-input"
            accessibilityLabel="API Token"
            masked
            placeholder="sk-..."
            value={credential()}
            onChange={(v) => credential.set(v)}
          />
        </FormField>
      </If>

      <Switch
        testID="add-channel-enabled-switch"
        label="Channel enabled"
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
