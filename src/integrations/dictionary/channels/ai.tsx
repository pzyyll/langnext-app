import { Text, View } from "nsh";
import { t } from "nsh/i18n";
import cubeMark from "../../../../assets/icons/cube-outline.svg";
import { Button } from "../../../components/ui/button";
import { Select } from "../../../components/ui/select";
import type {
  CapabilityChannelDefinition,
  ChannelSettingsProps,
  ConfigSchema,
} from "../../../framework/integrations";
import { ProviderProtocolError } from "../../../modules/ai/contracts/errors";
import { FormField } from "../../../modules/ai/ui/form-field";
import {
  buildDictionaryPrompt,
  DictionaryChannelError,
  dictionaryFailureKey,
  isDictionaryChannelFailure,
  parseDictionaryResponse,
  type DictionaryChannelFailure,
  type DictionaryLookupInput,
  type DictionaryLookupResult,
} from "../types";

export interface AiDictionaryConfig {
  modelId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const aiDictionaryConfig: ConfigSchema<AiDictionaryConfig> = {
  parse: (raw) => {
    if (!isPlainObject(raw)) return null;
    return typeof raw.modelId === "string" ? { modelId: raw.modelId } : null;
  },
  defaults: () => ({ modelId: "" }),
};

function mapProtocolErrorToDictionaryFailure(error: unknown): DictionaryChannelFailure {
  if (!(error instanceof ProviderProtocolError)) return "unknown";
  switch (error.kind) {
    case "auth":
      return "auth";
    case "rate_limited":
      return "rate_limit";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "invalid_response":
      return "invalid_response";
    case "network":
    case "server":
      return "network";
    case "invalid_request":
      return "unsupported";
    default:
      return "unknown";
  }
}

function AiDictionarySettings(props: ChannelSettingsProps<AiDictionaryConfig>) {
  const modelId = () => props.binding.config.modelId;
  const choices = () => props.host.modelChoices?.() ?? [];
  const items = () => choices().map((choice) => ({ value: choice.id, title: choice.label }));
  const selected = () => (modelId().trim().length > 0 ? modelId() : null);
  const status = () => {
    const id = selected();
    if (id === null || props.host.resolveModelBinding === undefined) return null;
    return props.host.resolveModelBinding(id, "text");
  };
  const unavailable = () => status() !== null && status()!.ok === false;
  const unavailableReason = () => {
    const current = status();
    return current !== null && current.ok === false ? current.reason : "";
  };

  return (
    <View class="gap-4">
      <FormField label={t("settings.dictionary.model")}>
        <Select
          testID="settings-dictionary-model"
          items={items()}
          value={selected()}
          placeholder={t("presets.model.selectPlaceholder")}
          disabled={props.disabled || items().length === 0}
          accessibilityLabel={t("settings.dictionary.model")}
          onChange={(value) => {
            if (value !== null) props.onChange({ modelId: value });
          }}
        />
        <If when={unavailable()}>
          <Text testID="settings-dictionary-model-unavailable" class="text-xs text-warning">
            {unavailableReason()}
          </Text>
        </If>
      </FormField>

      <If when={props.host.onManageModels !== undefined}>
        <View
          class={
            choices().length === 0
              ? "gap-2 rounded-xl border border-border bg-surface-subtle p-3"
              : "flex-row"
          }
        >
          <If when={choices().length === 0}>
            <Text role="alert" class="text-xs text-muted-foreground">
              {t("presets.model.noEligible")}
            </Text>
          </If>
          <View class="flex-row">
            <Button
              testID="settings-dictionary-manage-models"
              variant="outline"
              size="sm"
              label={t("presets.action.manageModels")}
              disabled={props.disabled}
              onPress={() => props.host.onManageModels?.()}
            />
          </View>
        </View>
      </If>
    </View>
  );
}

export const aiDictionaryChannel: CapabilityChannelDefinition<
  AiDictionaryConfig,
  DictionaryLookupInput,
  DictionaryLookupResult
> = {
  id: "ai",
  capability: "dictionary",
  labelKey: "settings.dictionary.ai",
  icon: cubeMark,
  configurable: true,
  config: aiDictionaryConfig,
  credential: null,
  describe: (binding, host) => {
    const modelId = binding.config.modelId.trim();
    if (modelId.length === 0) return t("settings.dictionary.notConfigured");
    const resolved = host?.resolveModelBinding?.(modelId, "text");
    if (resolved === undefined) return modelId;
    return resolved.ok ? resolved.label : (resolved.label ?? t("presets.model.unavailableLabel"));
  },
  validate: ({ config }) =>
    config.modelId.trim().length > 0
      ? { ok: true }
      : { ok: false, key: "settings.dictionary.error.modelIdBlank", field: "modelId" },
  saveAvailable: ({ config, resolveModelBinding }) => {
    const modelId = config.modelId.trim();
    if (modelId.length === 0) return false;
    return resolveModelBinding?.(modelId, "text")?.ok === true;
  },
  readiness: async (binding, host) => {
    const modelId = binding.config.modelId.trim();
    if (modelId.length === 0) return { ready: false, reason: "failed" };
    const resolved = await host.models.resolveSaved(modelId, "text");
    return resolved.ok ? { ready: true } : { ready: false, reason: "no_eligible_model" };
  },
  execute: async (binding, input, host) => {
    if (input.signal?.aborted) throw new DictionaryChannelError("cancelled");
    const resolved = await host.models.resolveSaved(binding.config.modelId.trim(), "text");
    if (!resolved.ok) throw new DictionaryChannelError("unconfigured");
    if (input.signal?.aborted) throw new DictionaryChannelError("cancelled");

    const prompt = buildDictionaryPrompt(input);
    let raw: string;
    try {
      raw = await host.models.generateText(
        resolved.connection,
        {
          modelId: resolved.modelKey,
          system: prompt.system,
          user: prompt.user,
          disableReasoning: true,
        },
        { signal: input.signal, timeoutMs: input.timeoutMs },
      );
    } catch (error) {
      if (input.signal?.aborted) throw new DictionaryChannelError("cancelled");
      throw new DictionaryChannelError(mapProtocolErrorToDictionaryFailure(error));
    }

    if (input.signal?.aborted) throw new DictionaryChannelError("cancelled");
    const parsed = parseDictionaryResponse(raw, input.term);
    if (!parsed) throw new DictionaryChannelError("invalid_response");
    return parsed;
  },
  failureKey: (reason) =>
    isDictionaryChannelFailure(reason) ? dictionaryFailureKey(reason) : null,
  Settings: AiDictionarySettings,
};
