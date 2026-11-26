// ABOUTME: LLM detection channel: one saved text model, one literal-ID answer, no reasoning.
// ABOUTME: Readiness resolves the saved model and execution sends the bounded sample once.
import { t } from "nsh/i18n";
import { Text, View } from "nsh";
import cubeMark from "../../../../assets/icons/cube-outline.svg";
import { Button } from "../../../components/ui/button";
import { Select } from "../../../components/ui/select";
import { FormField } from "../../../modules/ai/ui/form-field";
import { ProviderProtocolError } from "../../../modules/ai/contracts/errors";
import type {
  CapabilityChannelDefinition,
  ChannelSettingsProps,
  ConfigSchema,
} from "../../../framework/integrations";
import type { LanguageId } from "../../../framework/languages";
import {
  DETECTION_SYSTEM_MESSAGE,
  DetectionChannelError,
  detectionFailureKey,
  parseDetectionAnswer,
  type DetectionRequest,
} from "../types";

export interface AiDetectionConfig {
  modelId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const aiDetectionConfig: ConfigSchema<AiDetectionConfig> = {
  parse: (raw) => {
    if (!isPlainObject(raw)) return null;
    const modelId = raw.modelId;
    // An added-but-unsaved channel stores the blank default; validate() rejects it on save.
    return typeof modelId === "string" ? { modelId } : null;
  },
  defaults: () => ({ modelId: "" }),
};

/** Controlled model picker: the host owns the draft, the save button, and the model catalog. */
function AiDetectionSettings(props: ChannelSettingsProps<AiDetectionConfig>) {
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
      <FormField label={t("settings.languageDetection.model")}>
        <Select
          testID="settings-detection-model"
          items={items()}
          value={selected()}
          placeholder={t("presets.model.selectPlaceholder")}
          disabled={props.disabled || items().length === 0}
          accessibilityLabel={t("settings.languageDetection.model")}
          onChange={(value) => {
            if (value !== null) props.onChange({ modelId: value });
          }}
        />
        <If when={unavailable()}>
          <Text testID="settings-detection-model-unavailable" class="text-xs text-warning">
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
              testID="settings-detection-manage-models"
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

export const aiDetectionDefinition: CapabilityChannelDefinition<
  AiDetectionConfig,
  DetectionRequest,
  LanguageId
> = {
  id: "ai",
  capability: "detect",
  labelKey: "settings.languageDetection.ai",
  icon: cubeMark,
  configurable: true,
  config: aiDetectionConfig,
  credential: null,
  describe: (binding, host) => {
    const modelId = binding.config.modelId.trim();
    if (modelId.length === 0) return t("settings.languageDetection.notConfigured");
    const resolved = host?.resolveModelBinding?.(modelId, "text");
    if (resolved === undefined) return modelId;
    return resolved.ok ? resolved.label : (resolved.label ?? t("presets.model.unavailableLabel"));
  },
  validate: ({ config }) =>
    config.modelId.trim().length > 0
      ? { ok: true }
      : { ok: false, key: "settings.languageDetection.error.modelIdBlank", field: "modelId" },
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
    const resolved = await host.models.resolveSaved(binding.config.modelId.trim(), "text");
    if (!resolved.ok) throw new DetectionChannelError("no_eligible_model");
    if (input.signal?.aborted) throw new DetectionChannelError("cancelled");

    let raw: string;
    try {
      raw = await host.models.generateText(
        resolved.connection,
        {
          modelId: resolved.modelKey,
          system: DETECTION_SYSTEM_MESSAGE,
          user: input.sample,
          // One literal ID needs no reasoning; providers that cannot turn it off ignore the hint.
          disableReasoning: true,
        },
        { signal: input.signal, timeoutMs: input.timeoutMs },
      );
    } catch (error) {
      if (
        input.signal?.aborted ||
        (error instanceof ProviderProtocolError && error.kind === "cancelled")
      ) {
        throw new DetectionChannelError("cancelled");
      }
      throw new DetectionChannelError("failed");
    }
    if (input.signal?.aborted) throw new DetectionChannelError("cancelled");

    const answer = parseDetectionAnswer(raw);
    if (answer.kind === "language") return answer.language;
    throw new DetectionChannelError(answer.kind === "undetermined" ? "unknown_language" : "failed");
  },
  failureKey: detectionFailureKey,
  Settings: AiDetectionSettings,
};
