// ABOUTME: OCR provider catalog for static Baidu/AI and schema-backed ocr.image integrations.
// ABOUTME: Discovers capabilities and labels from sanitized registration metadata, never plugin-ID branches.
import type { ComponentType, SVGProps } from "react";
import type { IntegrationInstanceDto, OcrProviderType, ServiceIntegrationDefinitionDto } from "../../storage/types";
import BaiduIcon from "~icons/svgs/baiducloud";
import AiIcon from "~icons/ri/ai";
import PluginIcon from "~icons/svgs/google-cloud";

/** Image OCR capability major contract used by bundled and future compatible plugins. */
export const OCR_IMAGE_CAPABILITY_ID = "ocr.image@1";

type OcrProviderIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type OcrProviderOption = {
  id: OcrProviderType;
  labelKey: "ocr.provider.baidu" | "ocr.provider.ai" | "ocr.provider.plugin";
  Icon: OcrProviderIcon;
};

/** Static built-in OCR providers (Baidu + AI). Integration options are built separately. */
export const OCR_PROVIDER_OPTIONS: readonly OcrProviderOption[] = [
  { id: "baidu", labelKey: "ocr.provider.baidu", Icon: BaiduIcon },
  { id: "ai", labelKey: "ocr.provider.ai", Icon: AiIcon },
] as const;

const OCR_PROVIDER_OPTION_BY_ID: ReadonlyMap<OcrProviderType, OcrProviderOption> = new Map([
  ...OCR_PROVIDER_OPTIONS.map((option) => [option.id, option] as const),
  ["plugin_capability", { id: "plugin_capability", labelKey: "ocr.provider.plugin", Icon: PluginIcon }],
]);

/** Resolve a static logo/label option for any provider type without inferring a concrete plugin. */
export function getOcrProviderOption(providerType: OcrProviderType): OcrProviderOption {
  return OCR_PROVIDER_OPTION_BY_ID.get(providerType) ?? OCR_PROVIDER_OPTION_BY_ID.get("plugin_capability")!;
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

/** Localized copy for catalog labels; plugin names resolve from definition presentation metadata. */
export type OcrProviderCreateOptionLabels = {
  baiduLabel: string;
  aiLabel: string;
  /** `{{plugin}}` and `{{name}}` placeholders. */
  integrationLabel: string;
  resolvePluginLabel?: (definition: ServiceIntegrationDefinitionDto) => string;
};

const DEFAULT_CREATE_LABELS: OcrProviderCreateOptionLabels = {
  baiduLabel: "Baidu OCR",
  aiLabel: "AI OCR",
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

function ocrCapabilityIdForPlugin(
  pluginId: string,
  definitionsById: ReadonlyMap<string, ServiceIntegrationDefinitionDto>,
): string | null {
  const definition = definitionsById.get(pluginId);
  if (!definition) {
    return null;
  }
  return (
    definition.capabilities.find((capability) => capability.id === OCR_IMAGE_CAPABILITY_ID)?.id ??
    definition.capabilities.find((capability) => capability.id.startsWith("ocr.image@"))?.id ??
    null
  );
}

function isOcrCapable(
  instance: IntegrationInstanceDto,
  definitionsById: ReadonlyMap<string, ServiceIntegrationDefinitionDto>,
): boolean {
  return ocrCapabilityIdForPlugin(instance.pluginId, definitionsById) != null;
}

/** Build deterministic create options: static providers first, then OCR-capable integrations. */
export function buildOcrProviderCreateOptions(input: {
  hasEnabledImageModel: boolean;
  modelsPending?: boolean;
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationDefinitionDto[];
  labels?: OcrProviderCreateOptionLabels;
}): OcrProviderCreateOption[] {
  const labels = input.labels ?? DEFAULT_CREATE_LABELS;
  const definitionsById = new Map(input.definitions.map((definition) => [definition.id, definition]));
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
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));

  for (const instance of ocrInstances) {
    const pluginLabel = pluginDisplayName(instance.pluginId, definitionsById, labels.resolvePluginLabel);
    const ocrCapabilityId = ocrCapabilityIdForPlugin(instance.pluginId, definitionsById);
    const ready = instance.enabled && instance.effectiveStatus === "ready";
    options.push({
      id: `integration:${instance.id}`,
      kind: "plugin_capability",
      label: applyTemplate(labels.integrationLabel, { plugin: pluginLabel, name: instance.displayName }),
      disabled: !ready,
      integrationInstanceId: instance.id,
      ocrCapabilityId,
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

export type OcrPluginRebindCandidate = {
  id: string;
  label: string;
  ocrCapabilityId: string;
  ready: boolean;
};

/** List integration candidates compatible with a bound OCR capability major. */
export function listCompatibleOcrRebindCandidates(input: {
  currentInstanceId: string;
  ocrCapabilityId: string;
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationDefinitionDto[];
  labels?: Pick<OcrProviderCreateOptionLabels, "integrationLabel" | "resolvePluginLabel">;
}): OcrPluginRebindCandidate[] {
  const integrationLabel = input.labels?.integrationLabel ?? DEFAULT_CREATE_LABELS.integrationLabel;
  const definitionsById = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const candidates: OcrPluginRebindCandidate[] = [];
  for (const instance of input.instances) {
    const ocrCapabilityId = ocrCapabilityIdForPlugin(instance.pluginId, definitionsById);
    if (!ocrCapabilityId || !capabilitiesMajorCompatible(input.ocrCapabilityId, ocrCapabilityId)) {
      continue;
    }
    const pluginLabel = pluginDisplayName(instance.pluginId, definitionsById, input.labels?.resolvePluginLabel);
    candidates.push({
      id: instance.id,
      label: applyTemplate(integrationLabel, { plugin: pluginLabel, name: instance.displayName }),
      ocrCapabilityId,
      ready: instance.enabled && instance.effectiveStatus === "ready",
    });
  }
  return candidates.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}
