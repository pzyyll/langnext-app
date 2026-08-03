// ABOUTME: Effective API-type display decisions shared by the model table and edit dialog.
// ABOUTME: Explicit override wins; discovered remote models show their source, never a generic default.
import type { ProviderModelDto } from "../../storage/types";

/**
 * What the model table and edit dialog must show for one model's API type.
 * Mirrors the backend effective-adapter resolution: explicit override → discovery
 * source type → channel default. A discovered model without an override is NOT a
 * generic default; it runs through the source type that discovered it.
 */
export type ModelApiTypeDisplay =
  | { kind: "override"; adapterId: string }
  | { kind: "source"; adapterId: string }
  | { kind: "inherit" };

export function resolveModelApiTypeDisplay(
  model: Pick<ProviderModelDto, "adapterId" | "sourceAdapterId">,
): ModelApiTypeDisplay {
  if (model.adapterId) {
    return { kind: "override", adapterId: model.adapterId };
  }
  if (model.sourceAdapterId) {
    return { kind: "source", adapterId: model.sourceAdapterId };
  }
  return { kind: "inherit" };
}

/**
 * i18n key for the empty "inherit" select option. Models discovered through a
 * source name that source instead of a generic channel default; clearing an
 * override on such a model returns to the source, not to "Default".
 */
export function resolveInheritApiTypeLabelKey(
  sourceAdapterId: string | null,
): "models.apiTypeInherit" | "models.apiTypeFromSource" {
  return sourceAdapterId ? "models.apiTypeFromSource" : "models.apiTypeInherit";
}
