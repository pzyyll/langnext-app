import { mount, signal, Text, View } from "nsh";
import { initializeAiModules } from "../../../../app/ai-setup";
import cubeIcon from "../../../../../assets/icons/cube-outline.svg";
import { Input } from "../../../../components/ui/input";
import { aiRegistry } from "../../../../modules/ai/runtime/registry";
import type { ProviderSettingsProps } from "../../../../modules/ai/ui/contracts";
import { providerSettingsRegistry } from "../../../../modules/ai/ui/registry";
import { ProviderSettingsHost } from "../provider-settings";

// A real settings host fixture: built-ins plus one test-only definition.
initializeAiModules();

aiRegistry.registerProvider({
  id: "example:provider",
  labelKey: "models.preset.custom",
  allowedProtocolIds: ["openai-compatible"],
  defaultProtocolId: "openai-compatible",
  defaultBaseUrl: "https://example.test/v1",
  catalogProviderId: null,
});

function ExampleSettings(props: ProviderSettingsProps) {
  return (
    <View class="gap-2">
      <View testID="example-settings-provider">
        <Text class="text-sm text-foreground">{props.provider.id}</Text>
      </View>
      <Input
        testID="example-settings-url"
        accessibilityLabel="Example endpoint"
        value={props.baseUrl}
        onChange={(value) => props.onBaseUrlChange(value)}
      />
    </View>
  );
}

providerSettingsRegistry.register({
  providerTypeId: "example:provider",
  Settings: ExampleSettings,
  icon: cubeIcon,
});

function SettingsApp() {
  const baseUrl = signal("https://example.test/v1");
  const protocolId = signal("openai-compatible");

  return (
    <View class="gap-2 p-4">
      <View testID="example-owner-url">
        <Text class="text-sm text-foreground">{baseUrl()}</Text>
      </View>
      <ProviderSettingsHost
        providerTypeId="example:provider"
        mode="draft"
        protocolId={protocolId()}
        baseUrl={baseUrl()}
        credential=""
        hasSavedCredential={false}
        credentialMode="keep"
        urlError={null}
        isInsecureHttp={false}
        allowInsecureHttp={false}
        compact={false}
        disabled={false}
        onProtocolChange={(value) => protocolId.set(value)}
        onBaseUrlChange={(value) => baseUrl.set(value)}
        onCredentialChange={() => {}}
        onCredentialModeChange={() => {}}
        onInsecureHttpChange={() => {}}
      />
    </View>
  );
}

mount(SettingsApp);
