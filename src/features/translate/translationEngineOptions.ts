// ABOUTME: Dual-catalog options for creating translation profiles (LLM + integrations).
// ABOUTME: Built-in LLM option plus ready translate.text@1 integration instances.
import type { IntegrationInstanceDto, ProviderModelDto, ServiceIntegrationManifest } from "../../storage/types";

/** Translate capability major contract used by Google Cloud and compatible plugins. */
export const TRANSLATE_TEXT_CAPABILITY_ID = "translate.text@1";
/** Detect capability major contract used by Google Cloud and compatible plugins. */
export const DETECT_LANGUAGE_CAPABILITY_ID = "translate.detect@1";

export type TranslationEngineOptionKind = "llm_model_chain" | "plugin_capability";

export type TranslationEngineOption = {
  /** Stable option id: `llm` or `integration:<instanceId>`. */
  id: string;
  kind: TranslationEngineOptionKind;
  label: string;
  description: string;
  disabled: boolean;
  /** When disabled, hint path for configuration. */
  configurePath: "/plugins" | null;
  integrationInstanceId: string | null;
  translateCapabilityId: string | null;
  detectCapabilityId: string | null;
  pluginId: string | null;
};

/** Localized copy for dual-catalog option labels/descriptions (instance names stay dynamic). */
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
};

const LLM_OPTION_ID = "llm";

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

function pluginDisplayName(pluginId: string, definitionsById: Map<string, ServiceIntegrationManifest>): string {
  const definition = definitionsById.get(pluginId);
  if (!definition) {
    return pluginId;
  }
  // displayNameKey is i18n key; fall back to last segment of plugin id for option labels.
  const segments = pluginId.split(".");
  const last = segments[segments.length - 1] ?? pluginId;
  return last
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function capabilityIdsForPlugin(
  pluginId: string,
  definitionsById: Map<string, ServiceIntegrationManifest>,
): { translate: string | null; detect: string | null } {
  const definition = definitionsById.get(pluginId);
  if (!definition) {
    return { translate: null, detect: null };
  }
  const translate =
    definition.capabilities.find((c) => c.id === TRANSLATE_TEXT_CAPABILITY_ID)?.id ??
    definition.capabilities.find((c) => c.id.startsWith("translate.text@"))?.id ??
    null;
  const detect =
    definition.capabilities.find((c) => c.id === DETECT_LANGUAGE_CAPABILITY_ID)?.id ??
    definition.capabilities.find((c) => c.id.startsWith("translate.detect@"))?.id ??
    null;
  return { translate, detect };
}

function isTranslateCapable(
  instance: IntegrationInstanceDto,
  definitionsById: Map<string, ServiceIntegrationManifest>,
): boolean {
  const { translate } = capabilityIdsForPlugin(instance.pluginId, definitionsById);
  return translate != null;
}

/**
 * Build deterministic dual-catalog options for Add Profile.
 * LLM is always first; integrations ordered by display name then id.
 */
export function buildTranslationEngineOptions(input: {
  enabledModels: readonly ProviderModelDto[];
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationManifest[];
  labels?: TranslationEngineOptionLabels;
}): TranslationEngineOption[] {
  const labels = input.labels ?? DEFAULT_LABELS;
  const definitionsById = new Map(input.definitions.map((d) => [d.id, d]));
  const hasEnabledModel = input.enabledModels.some((m) => m.enabled);
  const options: TranslationEngineOption[] = [
    {
      id: LLM_OPTION_ID,
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
    .filter((instance) => isTranslateCapable(instance, definitionsById))
    .slice()
    .sort((a, b) => {
      const byName = a.displayName.localeCompare(b.displayName);
      if (byName !== 0) return byName;
      return a.id.localeCompare(b.id);
    });

  for (const instance of translateInstances) {
    const pluginLabel = pluginDisplayName(instance.pluginId, definitionsById);
    const caps = capabilityIdsForPlugin(instance.pluginId, definitionsById);
    const ready = instance.enabled && instance.effectiveStatus === "ready";
    let description = applyTemplate(labels.statusGeneric, {
      plugin: pluginLabel,
      status: instance.effectiveStatus,
    });
    let disabled = !ready;
    let configurePath: "/plugins" | null = null;
    if (!instance.enabled || instance.effectiveStatus === "disabled") {
      description = labels.statusDisabled;
      disabled = true;
      configurePath = "/plugins";
    } else if (instance.effectiveStatus === "plugin_missing") {
      description = labels.statusPluginMissing;
      disabled = true;
      configurePath = "/plugins";
    } else if (
      instance.effectiveStatus === "unconfigured" ||
      instance.effectiveStatus === "unvalidated" ||
      instance.effectiveStatus === "degraded"
    ) {
      description = labels.statusNeedsConfig;
      disabled = true;
      configurePath = "/plugins";
    }

    options.push({
      id: `integration:${instance.id}`,
      kind: "plugin_capability",
      label: applyTemplate(labels.integrationLabel, {
        plugin: pluginLabel,
        name: instance.displayName,
      }),
      description,
      disabled,
      configurePath,
      integrationInstanceId: instance.id,
      translateCapabilityId: caps.translate,
      detectCapabilityId: caps.detect,
      pluginId: instance.pluginId,
    });
  }

  return options;
}

/** Capability major (name + @N) used for rebind compatibility checks. */
export function capabilityMajorKey(capabilityId: string): string | null {
  const at = capabilityId.lastIndexOf("@");
  if (at <= 0 || at === capabilityId.length - 1) {
    return null;
  }
  const name = capabilityId.slice(0, at);
  const major = capabilityId.slice(at + 1);
  if (!/^[0-9]+$/.test(major)) {
    return null;
  }
  return `${name}@${major}`;
}

/** True when two capability ids share name and major version. */
export function capabilitiesMajorCompatible(left: string, right: string): boolean {
  const a = capabilityMajorKey(left);
  const b = capabilityMajorKey(right);
  return a != null && b != null && a === b;
}

export type PluginRebindCandidate = {
  id: string;
  label: string;
  translateCapabilityId: string;
  detectCapabilityId: string | null;
  ready: boolean;
};

/**
 * Ready/enabled integration candidates compatible with a plugin Profile rebind.
 * Candidates must implement the same translate capability major (detect optional).
 */
export function listCompatiblePluginRebindCandidates(input: {
  currentInstanceId: string;
  translateCapabilityId: string;
  detectCapabilityId: string | null;
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationManifest[];
  labels?: Pick<TranslationEngineOptionLabels, "integrationLabel">;
}): PluginRebindCandidate[] {
  const integrationLabel = input.labels?.integrationLabel ?? DEFAULT_LABELS.integrationLabel;
  const definitionsById = new Map(input.definitions.map((d) => [d.id, d]));
  const candidates: PluginRebindCandidate[] = [];
  for (const instance of input.instances) {
    const caps = capabilityIdsForPlugin(instance.pluginId, definitionsById);
    if (!caps.translate) {
      continue;
    }
    if (!capabilitiesMajorCompatible(input.translateCapabilityId, caps.translate)) {
      continue;
    }
    if (
      input.detectCapabilityId &&
      caps.detect &&
      !capabilitiesMajorCompatible(input.detectCapabilityId, caps.detect)
    ) {
      continue;
    }
    const ready = instance.enabled && instance.effectiveStatus === "ready";
    const pluginLabel = pluginDisplayName(instance.pluginId, definitionsById);
    candidates.push({
      id: instance.id,
      label: applyTemplate(integrationLabel, {
        plugin: pluginLabel,
        name: instance.displayName,
      }),
      translateCapabilityId: caps.translate,
      detectCapabilityId: caps.detect,
      ready,
    });
  }
  candidates.sort((a, b) => {
    const byLabel = a.label.localeCompare(b.label);
    if (byLabel !== 0) return byLabel;
    return a.id.localeCompare(b.id);
  });
  return candidates;
}
