// ABOUTME: Test app for the shared capability settings host with fake channels.
import { mount, signal, Storage, Text, View } from "nsh";
import { t } from "nsh/i18n";
import cubeIcon from "../../../../assets/icons/cube-outline.svg";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { createChannelCollection } from "../../../framework/integrations/channel-collection";
import { createCredentialVault } from "../../../framework/integrations/credential-vault";
import { createIntegrationRegistry } from "../../../framework/integrations/registry";
import type {
  CapabilityChannelDefinition,
  ChannelSettingsProps,
  ConfigSchema,
} from "../../../framework/integrations/contracts";
import { FormField } from "../../../modules/ai/ui/form-field";
import { CapabilitySection } from "../capability-section";
import { loadLanguage } from "../language";

/** The collection key the tests seed and read. */
export const CAPABILITY_TEST_STORAGE_KEY = "integrations.test.v1";
/** The vault namespace the tests seed and read. */
export const CAPABILITY_TEST_VAULT_NAMESPACE = "secret.test";

interface TestConfig {
  mode: string;
}

const testConfig: ConfigSchema<TestConfig> = {
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null;
    const mode = (raw as { mode?: unknown }).mode;
    return typeof mode === "string" ? { mode } : null;
  },
  defaults: () => ({ mode: "default" }),
};

function TestSettings(props: ChannelSettingsProps<TestConfig>) {
  return (
    <View class="gap-3">
      <FormField label="Mode">
        <Input
          testID="settings-test-mode"
          value={props.binding.config.mode}
          disabled={props.disabled}
          onChange={(value) => props.onChange({ mode: value })}
        />
      </FormField>
      <FormField label={t("settings.tts.apiKey")}>
        <Input
          testID="settings-test-credential"
          value={props.credentialDraft.apiKey ?? ""}
          masked={true}
          disabled={props.disabled}
          placeholder={props.savedCredential ? t("settings.tts.savedKey") : undefined}
          onChange={(value) => props.onCredentialChange("apiKey", value)}
        />
      </FormField>
      <Text testID="settings-test-credential-state">{props.credentialState}</Text>
    </View>
  );
}

function testChannel(
  id: string,
  labelKey: string,
  configurable: boolean,
): CapabilityChannelDefinition<TestConfig, { text: string }, { text: string }> {
  return {
    id,
    capability: "tts",
    labelKey,
    icon: cubeIcon,
    configurable,
    config: testConfig,
    credential: configurable
      ? [{ key: "apiKey", labelKey: "settings.tts.apiKey", masked: true }]
      : null,
    describe: (binding) => binding.config.mode,
    validate: ({ credentialDraft, savedCredential }) => {
      const draft = (credentialDraft.apiKey ?? "").trim();
      if (!savedCredential && draft.length === 0) {
        return { ok: false, key: "settings.tts.error.apiKeyRequired" as const };
      }
      return { ok: true as const };
    },
    readiness: async () => ({ ready: true }),
    execute: async (_binding, input) => input,
    failureKey: () => null,
    ...(configurable ? { Settings: TestSettings } : {}),
  };
}

const CHANNELS = [
  testChannel("alpha", "settings.ocr.ai", true),
  testChannel("beta", "settings.ocr.baidu", true),
  testChannel("free", "settings.ocr.google-cloud", false),
];

const registry = createIntegrationRegistry();
for (const definition of CHANNELS) registry.registerCapability(definition);

const collection = createChannelCollection({
  capability: "tts",
  storage: Storage,
  storageKey: CAPABILITY_TEST_STORAGE_KEY,
  vault: createCredentialVault({
    storage: Storage,
    namespace: CAPABILITY_TEST_VAULT_NAMESPACE,
  }),
  definitions: () =>
    CHANNELS as unknown as readonly CapabilityChannelDefinition<unknown, unknown, unknown>[],
  policy: { enableOnFirstSave: false, requireReadableCredentialOnEnable: true },
});

function HarnessApp() {
  const selected = signal<string | null>(null);
  let openAdd: (() => void) | null = null;

  return (
    <View class="flex-1 gap-3 p-4">
      <Text testID="settings-test-order">{collection.order().join(",")}</Text>
      <View class="flex-row gap-2">
        <Button
          testID="settings-test-add"
          size="sm"
          variant="outline"
          label={t("settings.capabilities.addChannel")}
          onPress={() => openAdd?.()}
        />
        <Button
          testID="settings-test-back"
          size="sm"
          variant="ghost"
          label="Back"
          onPress={() => selected.set(null)}
        />
      </View>
      <CapabilitySection
        capability="tts"
        testIdPrefix="settings-test"
        registry={registry}
        collection={collection}
        labels={{
          titleKey: "settings.sections.tts",
          addKey: "settings.capabilities.addChannel",
          emptyKey: "settings.tts.emptyTitle",
        }}
        compact={false}
        selected={selected()}
        onSelect={(id) => selected.set(id)}
        hostServices={{}}
        onRegisterAddTrigger={(open) => {
          openAdd = open;
          return () => {
            if (openAdd === open) openAdd = null;
          };
        }}
      />
    </View>
  );
}

void (async () => {
  await loadLanguage();
  await collection.load();
  mount(HarnessApp);
})();
