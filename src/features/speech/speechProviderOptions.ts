// ABOUTME: Speech provider catalog for add dialog tiles and service list labels.
// ABOUTME: Discovers ready speech.synthesize@1 integration instances and rebind candidates.
import type { ComponentType, SVGProps } from "react";
import type { EdgeTtsPreferencesV1, IntegrationInstanceDto, ServiceIntegrationManifest } from "../../storage/types";
import { EDGE_TTS_PLUGIN_ID, GOOGLE_CLOUD_PLUGIN_ID } from "../../storage/types";
import EdgeIcon from "~icons/svgs/edge";
import GoogleCloudIcon from "~icons/svgs/google-cloud";

/** Text-to-speech capability major contract used by speech plugins. */
export const SPEECH_SYNTHESIZE_CAPABILITY_ID = "speech.synthesize@1";
/** Google TTS preferences schema version (speakingRate + pitch). */
export const GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION = 1;
/** Edge TTS preferences schema version (voice + speed + pitch + style). */
export const EDGE_TTS_PREFERENCES_SCHEMA_VERSION = 1;

/** speakingRate range and default for Google schema v1. */
export const SPEECH_SPEAKING_RATE_MIN = 0.25;
export const SPEECH_SPEAKING_RATE_MAX = 2.0;
export const SPEECH_SPEAKING_RATE_DEFAULT = 1.0;
export const SPEECH_SPEAKING_RATE_STEP = 0.05;

/** pitch range and default for Google schema v1. */
export const SPEECH_PITCH_MIN = -20.0;
export const SPEECH_PITCH_MAX = 20.0;
export const SPEECH_PITCH_DEFAULT = 0.0;
export const SPEECH_PITCH_STEP = 0.5;

/** Edge TTS speed range and default. */
export const EDGE_TTS_SPEED_MIN = 0.5;
export const EDGE_TTS_SPEED_MAX = 2.0;
export const EDGE_TTS_SPEED_DEFAULT = 1.0;
export const EDGE_TTS_SPEED_STEP = 0.05;

/** Edge TTS pitch range and default. */
export const EDGE_TTS_PITCH_MIN = -50.0;
export const EDGE_TTS_PITCH_MAX = 50.0;
export const EDGE_TTS_PITCH_DEFAULT = 0.0;
export const EDGE_TTS_PITCH_STEP = 1.0;

/** Default Edge TTS voice and style. */
export const EDGE_TTS_VOICE_DEFAULT = "zh-CN-XiaoxiaoNeural";
export const EDGE_TTS_STYLE_DEFAULT = "general";

/** Edge TTS voices (zh-CN only). */
export const EDGE_TTS_VOICES = [
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoyiNeural",
  "zh-CN-XiaochenNeural",
  "zh-CN-XiaohanNeural",
  "zh-CN-XiaomengNeural",
  "zh-CN-XiaomoNeural",
  "zh-CN-XiaoqiuNeural",
  "zh-CN-XiaoruiNeural",
  "zh-CN-XiaoshuangNeural",
  "zh-CN-XiaoxuanNeural",
  "zh-CN-XiaoyanNeural",
  "zh-CN-XiaoyouNeural",
  "zh-CN-XiaozhenNeural",
  "zh-CN-YunxiNeural",
  "zh-CN-YunyangNeural",
  "zh-CN-YunjianNeural",
  "zh-CN-YunfengNeural",
  "zh-CN-YunhaoNeural",
  "zh-CN-YunxiaNeural",
  "zh-CN-YunyeNeural",
  "zh-CN-YunzeNeural",
] as const;

/** Edge TTS styles. */
export const EDGE_TTS_STYLES = [
  "general",
  "assistant",
  "chat",
  "customerservice",
  "newscast",
  "affectionate",
  "calm",
  "cheerful",
  "gentle",
  "lyrical",
  "serious",
] as const;

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

/** Localized copy for dual-catalog option labels (instance names stay dynamic). */
export type SpeechProviderCreateOptionLabels = {
  /** `{{plugin}}` and `{{name}}` placeholders. */
  integrationLabel: string;
};

const DEFAULT_CREATE_LABELS: SpeechProviderCreateOptionLabels = {
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
  const segments = pluginId.split(".");
  const last = segments[segments.length - 1] ?? pluginId;
  return last
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function speechCapabilityIdForPlugin(
  pluginId: string,
  definitionsById: Map<string, ServiceIntegrationManifest>,
): string | null {
  const definition = definitionsById.get(pluginId);
  if (!definition) {
    return null;
  }
  return (
    definition.capabilities.find((c) => c.id === SPEECH_SYNTHESIZE_CAPABILITY_ID)?.id ??
    definition.capabilities.find((c) => c.id.startsWith("speech.synthesize@"))?.id ??
    null
  );
}

function isSpeechCapable(
  instance: IntegrationInstanceDto,
  definitionsById: Map<string, ServiceIntegrationManifest>,
): boolean {
  if (speechCapabilityIdForPlugin(instance.pluginId, definitionsById) != null) {
    return true;
  }
  // Keep plugin-missing speech-capable instances visible as disabled create options.
  return (
    instance.effectiveStatus === "plugin_missing" &&
    (instance.pluginId === GOOGLE_CLOUD_PLUGIN_ID || instance.pluginId === EDGE_TTS_PLUGIN_ID)
  );
}

function iconForPlugin(pluginId: string): SpeechProviderIcon {
  if (pluginId === EDGE_TTS_PLUGIN_ID) {
    return EdgeIcon;
  }
  return GoogleCloudIcon;
}

/**
 * Build create options from Speech-capable integrations ordered by display name then id.
 * Only ready/enabled instances are clickable; others remain visible but disabled.
 */
export function buildSpeechProviderCreateOptions(input: {
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationManifest[];
  labels?: SpeechProviderCreateOptionLabels;
}): SpeechProviderCreateOption[] {
  const labels = input.labels ?? DEFAULT_CREATE_LABELS;
  const definitionsById = new Map(input.definitions.map((d) => [d.id, d]));

  const speechInstances = input.instances
    .filter((instance) => isSpeechCapable(instance, definitionsById))
    .slice()
    .sort((a, b) => {
      const byName = a.displayName.localeCompare(b.displayName);
      if (byName !== 0) return byName;
      return a.id.localeCompare(b.id);
    });

  const options: SpeechProviderCreateOption[] = [];
  for (const instance of speechInstances) {
    const pluginLabel = pluginDisplayName(instance.pluginId, definitionsById);
    const capabilityId =
      speechCapabilityIdForPlugin(instance.pluginId, definitionsById) ?? SPEECH_SYNTHESIZE_CAPABILITY_ID;
    const ready = instance.enabled && instance.effectiveStatus === "ready";

    options.push({
      id: `integration:${instance.id}`,
      label: applyTemplate(labels.integrationLabel, {
        plugin: pluginLabel,
        name: instance.displayName,
      }),
      disabled: !ready,
      integrationInstanceId: instance.id,
      capabilityId,
      pluginId: instance.pluginId,
      Icon: iconForPlugin(instance.pluginId),
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

export type SpeechPluginRebindCandidate = {
  id: string;
  label: string;
  capabilityId: string;
  ready: boolean;
};

/**
 * Ready/enabled integration candidates compatible with a Speech service rebind.
 * Candidates must implement the same speech.synthesize capability major.
 */
export function listCompatibleSpeechRebindCandidates(input: {
  currentInstanceId: string;
  capabilityId: string;
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationManifest[];
  labels?: SpeechProviderCreateOptionLabels;
}): SpeechPluginRebindCandidate[] {
  const integrationLabel = input.labels?.integrationLabel ?? DEFAULT_CREATE_LABELS.integrationLabel;
  const definitionsById = new Map(input.definitions.map((d) => [d.id, d]));
  const candidates: SpeechPluginRebindCandidate[] = [];
  for (const instance of input.instances) {
    const capabilityId = speechCapabilityIdForPlugin(instance.pluginId, definitionsById);
    if (!capabilityId) {
      continue;
    }
    if (!capabilitiesMajorCompatible(input.capabilityId, capabilityId)) {
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
      capabilityId,
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

/** Default Google TTS preferences for schema v1. */
export function defaultGoogleTtsPreferences(): {
  speakingRate: number;
  pitch: number;
} {
  return {
    speakingRate: SPEECH_SPEAKING_RATE_DEFAULT,
    pitch: SPEECH_PITCH_DEFAULT,
  };
}

/** Default Edge TTS preferences for schema v1. */
export function defaultEdgeTtsPreferences(): EdgeTtsPreferencesV1 {
  return {
    voice: EDGE_TTS_VOICE_DEFAULT,
    speed: EDGE_TTS_SPEED_DEFAULT,
    pitch: EDGE_TTS_PITCH_DEFAULT,
    style: EDGE_TTS_STYLE_DEFAULT,
  };
}

/** Icon used for Speech service rail rows (defaults to Google Cloud). */
export function getSpeechProviderIcon(pluginId?: string): SpeechProviderIcon {
  return iconForPlugin(pluginId ?? GOOGLE_CLOUD_PLUGIN_ID);
}
