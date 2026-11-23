import { Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
import { Select, type SelectItem } from "../../../components/ui/select";
import type { ProviderCredentialMode, ProviderSettingsProps } from "./contracts";
import { FormField } from "./form-field";
import { getProtocolLabel } from "./labels";

/**
 * The shared controlled connection fields: protocol, URL, insecure-HTTP consent,
 * and credential input. Card actions, persistence, and request status stay with
 * the common editor.
 */
export function ConnectionFields(props: ProviderSettingsProps) {
  const currentProtocolSupported = () =>
    props.provider.allowedProtocolIds.includes(props.protocolId);

  const protocolItems = (): SelectItem[] => {
    const items: SelectItem[] = props.provider.allowedProtocolIds.map((id) => ({
      value: id,
      title: getProtocolLabel(id),
    }));
    if (!currentProtocolSupported()) {
      // Keep an unsupported stored value visible so the user can replace it.
      items.unshift({ value: props.protocolId, title: getProtocolLabel(props.protocolId) });
    }
    return items;
  };

  const hasFixedApiType = () =>
    currentProtocolSupported() && props.provider.allowedProtocolIds.length <= 1;

  const urlPlaceholder = () =>
    props.provider.defaultBaseUrl ?? t("models.connection.baseUrlPlaceholder");

  const tokenPlaceholder = () => {
    if (props.mode === "saved") {
      if (props.credentialMode === "clear") return t("models.connection.tokenWillClear");
      if (props.hasSavedCredential) return t("models.connection.tokenRetained");
    }
    return t("models.connection.apiKeyPlaceholder");
  };

  const showCredentialActions = () => props.mode === "saved" && props.hasSavedCredential;

  const requestCredentialMode = (mode: ProviderCredentialMode) => {
    props.onCredentialModeChange(mode);
  };

  return (
    <>
      <View class={props.compact ? "gap-3.5" : "flex-row items-start gap-4"}>
        <FormField
          label={t("models.connection.apiType")}
          class={props.compact ? undefined : "w-64 shrink-0"}
        >
          <If
            when={hasFixedApiType()}
            else={
              <Select
                testID="connection-adapter-select"
                accessibilityLabel={t("models.connection.apiType")}
                items={protocolItems()}
                value={props.protocolId}
                onChange={(value) => {
                  if (value) props.onProtocolChange(value);
                }}
              />
            }
          >
            <View
              testID="connection-fixed-api-type"
              class="h-9 flex-row items-center rounded-xl border border-border bg-muted px-3"
            >
              <Text class="truncate text-sm text-foreground">
                {getProtocolLabel(props.protocolId)}
              </Text>
            </View>
          </If>
        </FormField>

        <FormField
          label={t("models.connection.baseUrl")}
          error={props.urlError}
          class={props.compact ? undefined : "min-w-0 flex-1"}
        >
          <Input
            testID="connection-url-input"
            accessibilityLabel={t("models.connection.baseUrl")}
            placeholder={urlPlaceholder()}
            inputClass="font-mono"
            value={props.baseUrl}
            onChange={(value) => props.onBaseUrlChange(value)}
          />
        </FormField>
      </View>

      <If when={props.isInsecureHttp}>
        <Checkbox
          testID="connection-insecure-checkbox"
          checked={props.allowInsecureHttp}
          onChange={(checked) => props.onInsecureHttpChange(checked)}
          label={t("models.connection.insecureHttp")}
        />
      </If>

      <FormField
        label={t("models.connection.apiKey")}
        labelAction={
          <If when={showCredentialActions()}>
            <If
              when={props.credentialMode === "clear"}
              else={
                <Button
                  testID="clear-token-button"
                  size="xs"
                  variant="ghost"
                  disabled={props.disabled}
                  label={t("models.connection.resetToken")}
                  onPress={() => requestCredentialMode("clear")}
                />
              }
            >
              <Button
                testID="keep-token-button"
                size="xs"
                variant="ghost"
                disabled={props.disabled}
                label={t("models.connection.keepToken")}
                onPress={() => requestCredentialMode("keep")}
              />
            </If>
          </If>
        }
      >
        <Input
          testID="connection-token-input"
          accessibilityLabel={t("models.connection.apiKey")}
          masked
          readonly={props.mode === "saved" && props.credentialMode === "clear"}
          placeholder={tokenPlaceholder()}
          value={props.credential}
          onChange={(value) => props.onCredentialChange(value)}
        />
      </FormField>
    </>
  );
}
