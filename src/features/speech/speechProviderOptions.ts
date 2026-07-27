// ABOUTME: Speech provider catalog discovered from ready speech.synthesize integration capabilities.
// ABOUTME: Uses sanitized descriptors and presentation metadata instead of Google/Edge identity inference.
import type { ComponentType, SVGProps } from "react";
import type { IntegrationInstanceDto, ServiceIntegrationDefinitionDto } from "../../storage/types";
import PluginIcon from "~icons/svgs/google-cloud";

/** Text-to-speech capability major contract shared by bundled and compatible plugins. */
export const SPEECH_SYNTHESIZE_CAPABILITY_ID = "speech.synthesize@1";

type SpeechProviderIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type SpeechProviderCreateOption = {
  /** Stable option id: `integration:<instanceId>`. */
  id: string;
  label: string;
  disabled: boolean;
  integrationInstanceId: string;
  capabilityId: string;
  pluginId: string;
  Icon: SpeechProviderIcon;
};

/** Localized copy for catalog labels; plugin names resolve from definition presentation metadata. */
export type SpeechProviderCreateOptionLabels = {
  /** `{{plugin}}` and `{{name}}` placeholders. */
  integrationLabel: string;
  resolvePluginLabel?: (definition: ServiceIntegrationDefinitionDto) => string;
};

const DEFAULT_CREATE_LABELS: SpeechProviderCreateOptionLabels = {
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

function speechCapabilityIdForPlugin(
  pluginId: string,
  definitionsById: ReadonlyMap<string, ServiceIntegrationDefinitionDto>,
): string | null {
  const definition = definitionsById.get(pluginId);
  if (!definition) {
    return null;
  }
  return (
    definition.capabilities.find((capability) => capability.id === SPEECH_SYNTHESIZE_CAPABILITY_ID)?.id ??
    definition.capabilities.find((capability) => capability.id.startsWith("speech.synthesize@"))?.id ??
    null
  );
}

function isSpeechCapable(
  instance: IntegrationInstanceDto,
  definitionsById: ReadonlyMap<string, ServiceIntegrationDefinitionDto>,
): boolean {
  return speechCapabilityIdForPlugin(instance.pluginId, definitionsById) != null;
}

/** Build ready and disabled Speech integration choices in deterministic display-name order. */
export function buildSpeechProviderCreateOptions(input: {
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationDefinitionDto[];
  labels?: SpeechProviderCreateOptionLabels;
}): SpeechProviderCreateOption[] {
  const labels = input.labels ?? DEFAULT_CREATE_LABELS;
  const definitionsById = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const speechInstances = input.instances
    .filter((instance) => isSpeechCapable(instance, definitionsById))
    .slice()
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));

  const options: SpeechProviderCreateOption[] = [];
  for (const instance of speechInstances) {
    const capabilityId = speechCapabilityIdForPlugin(instance.pluginId, definitionsById);
    if (!capabilityId) {
      continue;
    }
    const pluginLabel = pluginDisplayName(instance.pluginId, definitionsById, labels.resolvePluginLabel);
    options.push({
      id: `integration:${instance.id}`,
      label: applyTemplate(labels.integrationLabel, { plugin: pluginLabel, name: instance.displayName }),
      disabled: !instance.enabled || instance.effectiveStatus !== "ready",
      integrationInstanceId: instance.id,
      capabilityId,
      pluginId: instance.pluginId,
      Icon: PluginIcon,
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
  return /^[0-9]+$/.test(major) ? `${name}@${major}` : null;
}

/** True when two capability ids share name and major version. */
export function capabilitiesMajorCompatible(left: string, right: string): boolean {
  const leftKey = capabilityMajorKey(left);
  const rightKey = capabilityMajorKey(right);
  return leftKey != null && leftKey === rightKey;
}

export type SpeechPluginRebindCandidate = {
  id: string;
  label: string;
  capabilityId: string;
  ready: boolean;
};

/** List integration candidates compatible with a bound Speech capability major. */
export function listCompatibleSpeechRebindCandidates(input: {
  currentInstanceId: string;
  capabilityId: string;
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationDefinitionDto[];
  labels?: SpeechProviderCreateOptionLabels;
}): SpeechPluginRebindCandidate[] {
  const labels = input.labels ?? DEFAULT_CREATE_LABELS;
  const definitionsById = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const candidates: SpeechPluginRebindCandidate[] = [];
  for (const instance of input.instances) {
    const capabilityId = speechCapabilityIdForPlugin(instance.pluginId, definitionsById);
    if (!capabilityId || !capabilitiesMajorCompatible(input.capabilityId, capabilityId)) {
      continue;
    }
    const pluginLabel = pluginDisplayName(instance.pluginId, definitionsById, labels.resolvePluginLabel);
    candidates.push({
      id: instance.id,
      label: applyTemplate(labels.integrationLabel, { plugin: pluginLabel, name: instance.displayName }),
      capabilityId,
      ready: instance.enabled && instance.effectiveStatus === "ready",
    });
  }
  return candidates.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

/** Generic plugin icon used until rail consumers receive the full definition presentation DTO. */
export function getSpeechProviderIcon(): SpeechProviderIcon {
  return PluginIcon;
}
