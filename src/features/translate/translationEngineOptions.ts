// ABOUTME: Dual-catalog options for LLM profiles and schema-backed translate capability integrations.
// ABOUTME: Discovers labels and capability compatibility from sanitized registration metadata only.
import type { IntegrationInstanceDto, ProviderModelDto, ServiceIntegrationDefinitionDto } from "../../storage/types";

/** Translate capability major contract shared by bundled and compatible plugins. */
export const TRANSLATE_TEXT_CAPABILITY_ID = "translate.text@1";
/** Optional language detection capability major contract. */
export const DETECT_LANGUAGE_CAPABILITY_ID = "translate.detect@1";

export type TranslationEngineOptionKind = "llm_model_chain" | "plugin_capability";

export type TranslationEngineOption = {
  id: string;
  kind: TranslationEngineOptionKind;
  label: string;
  description: string;
  disabled: boolean;
  configurePath: "/plugins" | null;
  integrationInstanceId: string | null;
  translateCapabilityId: string | null;
  detectCapabilityId: string | null;
  pluginId: string | null;
};

export type TranslationEngineOptionLabels = {
  llmLabel: string;
  llmDescriptionReady: string;
  llmDescriptionNoModel: string;
  statusDisabled: string;
  statusPluginMissing: string;
  statusNeedsConfig: string;
  /** `{{plugin}}` and `{{status}}` placeholders. */
  statusGeneric: string;
  /** `{{plugin}}` and `{{name}}` placeholders. */
  integrationLabel: string;
  resolvePluginLabel?: (definition: ServiceIntegrationDefinitionDto) => string;
};

const llmOptionId = "llm";
const DEFAULT_LABELS: TranslationEngineOptionLabels = {
  llmLabel: "LLM model chain",
  llmDescriptionReady: "Ordered model fallback with prompts",
  llmDescriptionNoModel: "Add an enabled model under Models first",
  statusDisabled: "Disabled — enable under Plugins",
  statusPluginMissing: "Plugin missing — check Plugins",
  statusNeedsConfig: "Needs configuration under Plugins",
  statusGeneric: "{{plugin}} · {{status}}",
  integrationLabel: "{{plugin}} — {{name}}",
};

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

function pluginDisplayName(
  pluginId: string,
  definitionsById: ReadonlyMap<string, ServiceIntegrationDefinitionDto>,
  resolvePluginLabel: ((definition: ServiceIntegrationDefinitionDto) => string) | undefined,
): string {
  const definition = definitionsById.get(pluginId);
  return definition ? (resolvePluginLabel?.(definition) ?? definition.presentation.displayNameFallback) : pluginId;
}

function capabilityIdsForPlugin(
  pluginId: string,
  definitionsById: ReadonlyMap<string, ServiceIntegrationDefinitionDto>,
): { translate: string | null; detect: string | null } {
  const definition = definitionsById.get(pluginId);
  if (!definition) return { translate: null, detect: null };
  return {
    translate:
      definition.capabilities.find((capability) => capability.id === TRANSLATE_TEXT_CAPABILITY_ID)?.id ??
      definition.capabilities.find((capability) => capability.id.startsWith("translate.text@"))?.id ??
      null,
    detect:
      definition.capabilities.find((capability) => capability.id === DETECT_LANGUAGE_CAPABILITY_ID)?.id ??
      definition.capabilities.find((capability) => capability.id.startsWith("translate.detect@"))?.id ??
      null,
  };
}

/** Build deterministic LLM and integration engine choices. */
export function buildTranslationEngineOptions(input: {
  enabledModels: readonly ProviderModelDto[];
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationDefinitionDto[];
  labels?: TranslationEngineOptionLabels;
}): TranslationEngineOption[] {
  const labels = input.labels ?? DEFAULT_LABELS;
  const definitionsById = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const hasEnabledModel = input.enabledModels.some((model) => model.enabled);
  const options: TranslationEngineOption[] = [
    {
      id: llmOptionId,
      kind: "llm_model_chain",
      label: labels.llmLabel,
      description: hasEnabledModel ? labels.llmDescriptionReady : labels.llmDescriptionNoModel,
      disabled: !hasEnabledModel,
      configurePath: null,
      integrationInstanceId: null,
      translateCapabilityId: null,
      detectCapabilityId: null,
      pluginId: null,
    },
  ];
  const translateInstances = input.instances
    .filter((instance) => capabilityIdsForPlugin(instance.pluginId, definitionsById).translate != null)
    .slice()
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));

  for (const instance of translateInstances) {
    const capabilities = capabilityIdsForPlugin(instance.pluginId, definitionsById);
    const pluginLabel = pluginDisplayName(instance.pluginId, definitionsById, labels.resolvePluginLabel);
    const ready = instance.enabled && instance.effectiveStatus === "ready";
    let description = applyTemplate(labels.statusGeneric, { plugin: pluginLabel, status: instance.effectiveStatus });
    const disabled = !ready;
    let configurePath: "/plugins" | null = null;
    if (!instance.enabled || instance.effectiveStatus === "disabled") {
      description = labels.statusDisabled;
      configurePath = "/plugins";
    } else if (instance.effectiveStatus === "plugin_missing") {
      description = labels.statusPluginMissing;
      configurePath = "/plugins";
    } else if (!ready) {
      description = labels.statusNeedsConfig;
      configurePath = "/plugins";
    }
    options.push({
      id: `integration:${instance.id}`,
      kind: "plugin_capability",
      label: applyTemplate(labels.integrationLabel, { plugin: pluginLabel, name: instance.displayName }),
      description,
      disabled,
      configurePath,
      integrationInstanceId: instance.id,
      translateCapabilityId: capabilities.translate,
      detectCapabilityId: capabilities.detect,
      pluginId: instance.pluginId,
    });
  }
  return options;
}

/** Capability major (name + @N) used for rebind compatibility checks. */
export function capabilityMajorKey(capabilityId: string): string | null {
  const at = capabilityId.lastIndexOf("@");
  if (at <= 0 || at === capabilityId.length - 1) return null;
  const name = capabilityId.slice(0, at);
  const major = capabilityId.slice(at + 1);
  return /^[0-9]+$/.test(major) ? `${name}@${major}` : null;
}

/** True when two capability ids share name and major version. */
export function capabilitiesMajorCompatible(left: string, right: string): boolean {
  const leftKey = capabilityMajorKey(left);
  const rightKey = capabilityMajorKey(right);
  return leftKey != null && leftKey === rightKey;
}

export type PluginRebindCandidate = {
  id: string;
  label: string;
  translateCapabilityId: string;
  detectCapabilityId: string | null;
  ready: boolean;
};

/** List rebind candidates compatible with a profile's persisted translate/detect major contracts. */
export function listCompatiblePluginRebindCandidates(input: {
  currentInstanceId: string;
  translateCapabilityId: string;
  detectCapabilityId: string | null;
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationDefinitionDto[];
  labels?: Pick<TranslationEngineOptionLabels, "integrationLabel" | "resolvePluginLabel">;
}): PluginRebindCandidate[] {
  const labels = input.labels ?? DEFAULT_LABELS;
  const definitionsById = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const candidates: PluginRebindCandidate[] = [];
  for (const instance of input.instances) {
    const capabilities = capabilityIdsForPlugin(instance.pluginId, definitionsById);
    if (!capabilities.translate || !capabilitiesMajorCompatible(input.translateCapabilityId, capabilities.translate)) {
      continue;
    }
    if (
      input.detectCapabilityId &&
      capabilities.detect &&
      !capabilitiesMajorCompatible(input.detectCapabilityId, capabilities.detect)
    ) {
      continue;
    }
    const pluginLabel = pluginDisplayName(instance.pluginId, definitionsById, labels.resolvePluginLabel);
    candidates.push({
      id: instance.id,
      label: applyTemplate(labels.integrationLabel, { plugin: pluginLabel, name: instance.displayName }),
      translateCapabilityId: capabilities.translate,
      detectCapabilityId: capabilities.detect,
      ready: instance.enabled && instance.effectiveStatus === "ready",
    });
  }
  return candidates.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}
