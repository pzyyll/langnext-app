// ABOUTME: OCR provider catalog for add dialog logos and service list labels.
// ABOUTME: Static Baidu/AI plus dynamic ocr.image@1 integration create options.
import type { ComponentType, SVGProps } from "react";
import type { IntegrationInstanceDto, OcrProviderType, ServiceIntegrationManifest } from "../../storage/types";
import BaiduIcon from "~icons/svgs/baiducloud";
import AiIcon from "~icons/ri/ai";
import GoogleCloudIcon from "~icons/svgs/google-cloud";

/** Image OCR capability major contract used by Google Cloud Vision. */
export const OCR_IMAGE_CAPABILITY_ID = "ocr.image@1";
/** Google Vision OCR preferences schema version (operation + languageHints). */
export const GOOGLE_VISION_PREFERENCES_SCHEMA_VERSION = 1;
/** Max language hints accepted by ocr.image@1. */
export const OCR_LANGUAGE_HINTS_MAX = 3;

type OcrProviderIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type OcrProviderOption = {
  id: OcrProviderType;
  labelKey: "ocr.provider.baidu" | "ocr.provider.ai" | "ocr.provider.plugin";
  Icon: OcrProviderIcon;
};

/** Static built-in OCR providers (Baidu + AI). Integration options are built separately. */
export const OCR_PROVIDER_OPTIONS: readonly OcrProviderOption[] = [
  {
    id: "baidu",
    labelKey: "ocr.provider.baidu",
    Icon: BaiduIcon,
  },
  {
    id: "ai",
    labelKey: "ocr.provider.ai",
    Icon: AiIcon,
  },
] as const;

const OCR_PROVIDER_OPTION_BY_ID: ReadonlyMap<OcrProviderType, OcrProviderOption> = new Map([
  ...OCR_PROVIDER_OPTIONS.map((option) => [option.id, option] as const),
  [
    "plugin_capability",
    {
      id: "plugin_capability",
      labelKey: "ocr.provider.plugin",
      Icon: GoogleCloudIcon,
    },
  ],
]);

/**
 * Resolve a static logo/label option for any provider type.
 * Plugin services use a generic Vision/plugin icon; never throws for plugin_capability.
 */
export function getOcrProviderOption(providerType: OcrProviderType): OcrProviderOption {
  const option = OCR_PROVIDER_OPTION_BY_ID.get(providerType);
  if (!option) {
    // Unknown future types fall back to plugin presentation instead of crashing the rail.
    return OCR_PROVIDER_OPTION_BY_ID.get("plugin_capability")!;
  }
  return option;
}

export type OcrProviderCreateOptionKind = "baidu" | "ai" | "plugin_capability";

export type OcrProviderCreateOption = {
  /** Stable option id: `baidu`, `ai`, or `integration:<instanceId>`. */
  id: string;
  kind: OcrProviderCreateOptionKind;
  label: string;
  disabled: boolean;
  integrationInstanceId: string | null;
  ocrCapabilityId: string | null;
  pluginId: string | null;
  Icon: OcrProviderIcon;
};

/** Localized copy for dual-catalog option labels (instance names stay dynamic). */
export type OcrProviderCreateOptionLabels = {
  baiduLabel: string;
  aiLabel: string;
  /** `{{plugin}}` and `{{name}}` placeholders. */
  integrationLabel: string;
};

const DEFAULT_CREATE_LABELS: OcrProviderCreateOptionLabels = {
  baiduLabel: "Baidu OCR",
  aiLabel: "AI OCR",
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

function ocrCapabilityIdForPlugin(
  pluginId: string,
  definitionsById: Map<string, ServiceIntegrationManifest>,
): string | null {
  const definition = definitionsById.get(pluginId);
  if (!definition) {
    return null;
  }
  return (
    definition.capabilities.find((c) => c.id === OCR_IMAGE_CAPABILITY_ID)?.id ??
    definition.capabilities.find((c) => c.id.startsWith("ocr.image@"))?.id ??
    null
  );
}

function isOcrCapable(
  instance: IntegrationInstanceDto,
  definitionsById: Map<string, ServiceIntegrationManifest>,
): boolean {
  if (ocrCapabilityIdForPlugin(instance.pluginId, definitionsById) != null) {
    return true;
  }
  // Keep plugin-missing Google Cloud instances visible as disabled create options.
  return instance.effectiveStatus === "plugin_missing" && instance.pluginId.includes("google-cloud");
}

/**
 * Build deterministic create options: static Baidu/AI first, then OCR-capable integrations.
 * Integrations ordered by display name then id.
 */
export function buildOcrProviderCreateOptions(input: {
  hasEnabledImageModel: boolean;
  modelsPending?: boolean;
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationManifest[];
  labels?: OcrProviderCreateOptionLabels;
}): OcrProviderCreateOption[] {
  const labels = input.labels ?? DEFAULT_CREATE_LABELS;
  const definitionsById = new Map(input.definitions.map((d) => [d.id, d]));
  const modelsPending = input.modelsPending === true;

  const options: OcrProviderCreateOption[] = [
    {
      id: "baidu",
      kind: "baidu",
      label: labels.baiduLabel,
      disabled: false,
      integrationInstanceId: null,
      ocrCapabilityId: null,
      pluginId: null,
      Icon: BaiduIcon,
    },
    {
      id: "ai",
      kind: "ai",
      label: labels.aiLabel,
      // Models still loading: block create clicks until the list settles.
      disabled: modelsPending,
      integrationInstanceId: null,
      ocrCapabilityId: null,
      pluginId: null,
      Icon: AiIcon,
    },
  ];

  const ocrInstances = input.instances
    .filter((instance) => isOcrCapable(instance, definitionsById))
    .slice()
    .sort((a, b) => {
      const byName = a.displayName.localeCompare(b.displayName);
      if (byName !== 0) return byName;
      return a.id.localeCompare(b.id);
    });

  for (const instance of ocrInstances) {
    const pluginLabel = pluginDisplayName(instance.pluginId, definitionsById);
    const ocrCapabilityId = ocrCapabilityIdForPlugin(instance.pluginId, definitionsById);
    const ready = instance.enabled && instance.effectiveStatus === "ready";

    options.push({
      id: `integration:${instance.id}`,
      kind: "plugin_capability",
      label: applyTemplate(labels.integrationLabel, {
        plugin: pluginLabel,
        name: instance.displayName,
      }),
      disabled: !ready,
      integrationInstanceId: instance.id,
      ocrCapabilityId,
      pluginId: instance.pluginId,
      Icon: GoogleCloudIcon,
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

export type OcrPluginRebindCandidate = {
  id: string;
  label: string;
  ocrCapabilityId: string;
  ready: boolean;
};

/**
 * Ready/enabled integration candidates compatible with a plugin OCR rebind.
 * Candidates must implement the same ocr.image capability major.
 */
export function listCompatibleOcrRebindCandidates(input: {
  currentInstanceId: string;
  ocrCapabilityId: string;
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationManifest[];
  labels?: Pick<OcrProviderCreateOptionLabels, "integrationLabel">;
}): OcrPluginRebindCandidate[] {
  const integrationLabel = input.labels?.integrationLabel ?? DEFAULT_CREATE_LABELS.integrationLabel;
  const definitionsById = new Map(input.definitions.map((d) => [d.id, d]));
  const candidates: OcrPluginRebindCandidate[] = [];
  for (const instance of input.instances) {
    const ocrCapabilityId = ocrCapabilityIdForPlugin(instance.pluginId, definitionsById);
    if (!ocrCapabilityId) {
      continue;
    }
    if (!capabilitiesMajorCompatible(input.ocrCapabilityId, ocrCapabilityId)) {
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
      ocrCapabilityId,
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

/** Default plugin OCR preferences for schema v1. */
export function defaultGoogleVisionPreferences(): {
  operation: "document_text_detection";
  languageHints: string[];
} {
  return {
    operation: "document_text_detection",
    languageHints: [],
  };
}
