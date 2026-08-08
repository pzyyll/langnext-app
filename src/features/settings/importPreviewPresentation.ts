// ABOUTME: Pure presentation helpers for the configuration import preview dialog.
// ABOUTME: No React/IPC/i18n runtime; helpers return stable data and label keys.
import type {
  ImportConflictMode,
  ImportPreview,
  ImportRuntimeLocalStatus,
  ImportRuntimeRequiredAction,
  ImportRuntimeRequirementPreview,
} from "../../storage/types";

/** Graph-count summary for one import category; labelKey is a stable i18n key. */
export interface ImportGraphCountSummary {
  readonly kind: "providers" | "models" | "profiles" | "integrations" | "ocrServices" | "speechServices";
  readonly create: number;
  readonly update: number;
  readonly copy: number;
  readonly labelKey:
    | "settings.backup.countProviders"
    | "settings.backup.countModels"
    | "settings.backup.countProfiles"
    | "settings.backup.countIntegrations"
    | "settings.backup.countOcrServices"
    | "settings.backup.countSpeechServices";
}

const GRAPH_COUNT_LABEL_KEYS = {
  providers: "settings.backup.countProviders",
  models: "settings.backup.countModels",
  profiles: "settings.backup.countProfiles",
  integrations: "settings.backup.countIntegrations",
  ocrServices: "settings.backup.countOcrServices",
  speechServices: "settings.backup.countSpeechServices",
} as const;

/** Summarize create/update/copy counts per graph category, omitting empty categories. */
export function importGraphCountSummaries(preview: Pick<ImportPreview, "counts">): ImportGraphCountSummary[] {
  const counts = preview.counts;
  const entries: Array<[ImportGraphCountSummary["kind"], number, number, number]> = [
    ["providers", counts.providersCreate ?? 0, counts.providersUpdate ?? 0, counts.providersCopy ?? 0],
    ["models", counts.modelsCreate ?? 0, counts.modelsUpdate ?? 0, counts.modelsCopy ?? 0],
    ["profiles", counts.profilesCreate ?? 0, counts.profilesUpdate ?? 0, counts.profilesCopy ?? 0],
    ["integrations", counts.integrationsCreate ?? 0, counts.integrationsUpdate ?? 0, counts.integrationsCopy ?? 0],
    ["ocrServices", counts.ocrServicesCreate ?? 0, counts.ocrServicesUpdate ?? 0, counts.ocrServicesCopy ?? 0],
    [
      "speechServices",
      counts.speechServicesCreate ?? 0,
      counts.speechServicesUpdate ?? 0,
      counts.speechServicesCopy ?? 0,
    ],
  ];
  return entries
    .filter(([, create, update, copy]) => create > 0 || update > 0 || copy > 0)
    .map(([kind, create, update, copy]) => ({
      kind,
      create,
      update,
      copy,
      labelKey: GRAPH_COUNT_LABEL_KEYS[kind],
    }));
}

/** Credential domains that need re-entry after import. */
export type ImportAuthenticationCategory = "providers" | "integrations" | "ocr" | "proxy";

/** Ordered, deduplicated credential re-entry categories reported by the preview. */
export function importAuthenticationCategories(
  preview: Pick<
    ImportPreview,
    | "requiresAuthentication"
    | "integrationRequiresAuthentication"
    | "ocrRequiresAuthentication"
    | "proxyRequiresAuthentication"
  >,
): ImportAuthenticationCategory[] {
  const categories: ImportAuthenticationCategory[] = [];
  if (preview.requiresAuthentication.length > 0) {
    categories.push("providers");
  }
  if ((preview.integrationRequiresAuthentication ?? []).length > 0) {
    categories.push("integrations");
  }
  if ((preview.ocrRequiresAuthentication ?? []).length > 0) {
    categories.push("ocr");
  }
  if (preview.proxyRequiresAuthentication) {
    categories.push("proxy");
  }
  return categories;
}

/** Stable i18n key for the credential re-entry warning lead-in. */
export const IMPORT_AUTH_LEAD_IN_KEY = "settings.backup.previewAuthNote" as const;

/** Stable i18n keys for the closed credential re-entry category labels. */
export const IMPORT_AUTH_CATEGORY_LABEL_KEYS = {
  providers: "settings.backup.importAuthProviders",
  integrations: "settings.backup.importAuthIntegrations",
  ocr: "settings.backup.importAuthOcr",
  proxy: "settings.backup.importAuthProxy",
} as const;

/** Stable i18n label key for one credential re-entry category. */
export function importAuthenticationCategoryLabelKey(
  category: ImportAuthenticationCategory,
): (typeof IMPORT_AUTH_CATEGORY_LABEL_KEYS)[ImportAuthenticationCategory] {
  return IMPORT_AUTH_CATEGORY_LABEL_KEYS[category];
}

/** Stable i18n key for the import conflict mode (Merge/Copy). */
export function importModeLabelKey(
  mode: ImportConflictMode,
): "settings.backup.importModeMerge" | "settings.backup.importModeCopy" {
  return mode === "merge" ? "settings.backup.importModeMerge" : "settings.backup.importModeCopy";
}

/** Stable i18n keys for the labeled runtime identity rows (Phase 11 fixes). */
export const IMPORT_RUNTIME_DETAIL_LABELS = {
  adapter: "settings.backup.runtimeDetailAdapter",
  runtime: "settings.backup.runtimeDetailRuntime",
  pluginId: "settings.backup.runtimeDetailPluginId",
  pluginVersion: "settings.backup.runtimeDetailPluginVersion",
  packageDigest: "settings.backup.runtimeDetailPackageDigest",
  publisherKeyId: "settings.backup.runtimeDetailPublisherKeyId",
  publisherFingerprint: "settings.backup.runtimeDetailPublisherFingerprint",
  status: "settings.backup.runtimeDetailStatus",
  action: "settings.backup.runtimeDetailAction",
} as const;

/** Closed union of the runtime detail label keys. */
export type ImportRuntimeDetailLabelKey =
  (typeof IMPORT_RUNTIME_DETAIL_LABELS)[keyof typeof IMPORT_RUNTIME_DETAIL_LABELS];

/** Status/action value keys that need translation at render time. */
type ImportRuntimeDetailValueKey =
  | ReturnType<typeof importRuntimeStatusLabelKey>
  | ReturnType<typeof importRuntimeActionLabelKey>;

/** One labeled runtime-identity detail row; value is the exact raw DTO value. */
export type ImportRuntimeDetailRow =
  | { readonly labelKey: ImportRuntimeDetailLabelKey; readonly value: string; readonly valueIsLabelKey: false }
  | {
      readonly labelKey: ImportRuntimeDetailLabelKey;
      readonly value: ImportRuntimeDetailValueKey;
      readonly valueIsLabelKey: true;
    };

/**
 * Ordered labeled detail rows for one exact runtime requirement. Identifiers are
 * returned in full, never truncated or recomputed; absent DTO fields are omitted.
 */
export function importRuntimeDetailRows(entry: ImportRuntimeRequirementPreview): ImportRuntimeDetailRow[] {
  const rows: ImportRuntimeDetailRow[] = [];
  if (entry.adapterId) {
    rows.push({ labelKey: IMPORT_RUNTIME_DETAIL_LABELS.adapter, value: entry.adapterId, valueIsLabelKey: false });
  }
  rows.push({ labelKey: IMPORT_RUNTIME_DETAIL_LABELS.runtime, value: entry.runtimeKind, valueIsLabelKey: false });
  if (entry.pluginId) {
    rows.push({ labelKey: IMPORT_RUNTIME_DETAIL_LABELS.pluginId, value: entry.pluginId, valueIsLabelKey: false });
  }
  if (entry.pluginVersion) {
    rows.push({
      labelKey: IMPORT_RUNTIME_DETAIL_LABELS.pluginVersion,
      value: entry.pluginVersion,
      valueIsLabelKey: false,
    });
  }
  if (entry.packageDigest) {
    rows.push({
      labelKey: IMPORT_RUNTIME_DETAIL_LABELS.packageDigest,
      value: entry.packageDigest,
      valueIsLabelKey: false,
    });
  }
  if (entry.publisherKeyId) {
    rows.push({
      labelKey: IMPORT_RUNTIME_DETAIL_LABELS.publisherKeyId,
      value: entry.publisherKeyId,
      valueIsLabelKey: false,
    });
  }
  if (entry.publisherKeyFingerprint) {
    rows.push({
      labelKey: IMPORT_RUNTIME_DETAIL_LABELS.publisherFingerprint,
      value: entry.publisherKeyFingerprint,
      valueIsLabelKey: false,
    });
  }
  rows.push({
    labelKey: IMPORT_RUNTIME_DETAIL_LABELS.status,
    value: importRuntimeStatusLabelKey(entry.localStatus),
    valueIsLabelKey: true,
  });
  rows.push({
    labelKey: IMPORT_RUNTIME_DETAIL_LABELS.action,
    value: importRuntimeActionLabelKey(entry.requiredAction),
    valueIsLabelKey: true,
  });
  return rows;
}

/** Stable i18n key for one runtime local status. */
export function importRuntimeStatusLabelKey(status: ImportRuntimeLocalStatus) {
  switch (status) {
    case "bundled":
      return "settings.backup.runtimeStatusBundled";
    case "legacy":
      return "settings.backup.runtimeStatusLegacy";
    case "missing":
      return "settings.backup.runtimeStatusMissing";
    case "revoked":
      return "settings.backup.runtimeStatusRevoked";
    case "disabled":
      return "settings.backup.runtimeStatusDisabled";
    case "content_unavailable":
      return "settings.backup.runtimeStatusContentUnavailable";
    case "incompatible":
      return "settings.backup.runtimeStatusIncompatible";
    case "installed":
      return "settings.backup.runtimeStatusInstalled";
  }
}

/** Stable i18n key for one required runtime action. */
export function importRuntimeActionLabelKey(action: ImportRuntimeRequiredAction) {
  switch (action) {
    case "none":
      return "settings.backup.runtimeActionNone";
    case "install_exact_package":
      return "settings.backup.runtimeActionInstallExactPackage";
    case "restore_publisher":
      return "settings.backup.runtimeActionRestorePublisher";
    case "resolve_incompatibility":
      return "settings.backup.runtimeActionResolveIncompatibility";
    case "activate_after_import":
      return "settings.backup.runtimeActionActivateAfterImport";
  }
}

/** Closed display order for runtime action groups. */
export const IMPORT_RUNTIME_ACTION_ORDER: readonly ImportRuntimeRequiredAction[] = [
  "none",
  "install_exact_package",
  "restore_publisher",
  "resolve_incompatibility",
  "activate_after_import",
];

/** Runtime requirement entries grouped by required action in closed display order. */
export interface ImportRuntimeRequirementGroup {
  readonly action: ImportRuntimeRequiredAction;
  readonly actionLabelKey: ReturnType<typeof importRuntimeActionLabelKey>;
  readonly items: ImportRuntimeRequirementPreview[];
}

/** Group exact runtime requirement preview entries by their required action. */
export function groupImportRuntimeRequirements(
  entries: readonly ImportRuntimeRequirementPreview[] | undefined,
): ImportRuntimeRequirementGroup[] {
  const byAction = new Map<ImportRuntimeRequiredAction, ImportRuntimeRequirementPreview[]>();
  for (const entry of entries ?? []) {
    const group = byAction.get(entry.requiredAction) ?? [];
    group.push(entry);
    byAction.set(entry.requiredAction, group);
  }
  return IMPORT_RUNTIME_ACTION_ORDER.filter((action) => byAction.has(action)).map((action) => ({
    action,
    actionLabelKey: importRuntimeActionLabelKey(action),
    items: byAction.get(action) ?? [],
  }));
}

/** True when any requirement is package-backed and needs a post-import action. */
export function importHasPackageBackedRuntimes(
  entries: readonly ImportRuntimeRequirementPreview[] | undefined,
): boolean {
  return (entries ?? []).some((entry) => entry.requiredAction !== "none");
}

/** Stable i18n key stating external runtimes remain inactive after import. */
export const IMPORT_INACTIVE_RUNTIME_COPY_KEY = "settings.backup.importRuntimeInactive" as const;
