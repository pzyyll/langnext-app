import type { ProviderTypeId } from "../../../modules/ai/contracts/channel";
import { aiRegistry } from "../../../modules/ai/runtime/registry";
import type { ProviderSettingsProps } from "../../../modules/ai/ui/contracts";
import { providerSettingsRegistry } from "../../../modules/ai/ui/registry";

export interface ProviderSettingsHostProps extends Omit<ProviderSettingsProps, "provider"> {
  providerTypeId: ProviderTypeId;
}

/**
 * Selects the registered Settings component once for this editor owner, then
 * passes the controlled field props through as NSH bindings.
 */
export function ProviderSettingsHost(props: ProviderSettingsHostProps) {
  const presentation = providerSettingsRegistry.get(props.providerTypeId);
  const provider = aiRegistry.getProvider(props.providerTypeId);
  const Settings = presentation.Settings;

  return (
    <Settings
      provider={provider}
      mode={props.mode}
      protocolId={props.protocolId}
      baseUrl={props.baseUrl}
      credential={props.credential}
      hasSavedCredential={props.hasSavedCredential}
      credentialMode={props.credentialMode}
      urlError={props.urlError}
      isInsecureHttp={props.isInsecureHttp}
      allowInsecureHttp={props.allowInsecureHttp}
      compact={props.compact}
      disabled={props.disabled}
      onProtocolChange={props.onProtocolChange}
      onBaseUrlChange={props.onBaseUrlChange}
      onCredentialChange={props.onCredentialChange}
      onCredentialModeChange={props.onCredentialModeChange}
      onInsecureHttpChange={props.onInsecureHttpChange}
    />
  );
}
