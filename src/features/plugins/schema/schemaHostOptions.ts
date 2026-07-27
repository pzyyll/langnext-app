// ABOUTME: Supplies closed host-owned option lists to the generic plugin schema renderer.
// ABOUTME: Maps only Phase 0 option source IDs; schemas cannot request arbitrary dynamic data.
import { LANGUAGE_IDS } from "../../../routes/translate/-languages";
import type { SchemaOption } from "../../../storage/types";
import type { SchemaOptionResolver, SchemaTextResolver } from "./SchemaField";

export const HOST_SUPPORTED_LANGUAGES_SOURCE_ID = "host.supported-languages@1";

/** Build the option resolver for the fixed host sources accepted by schema v1. */
export function createSchemaHostOptionResolver(resolveText: SchemaTextResolver): SchemaOptionResolver {
  return (sourceId: string): readonly SchemaOption[] => {
    if (sourceId !== HOST_SUPPORTED_LANGUAGES_SOURCE_ID) {
      return [];
    }
    return LANGUAGE_IDS.map((languageId) => ({
      value: languageId,
      labelKey: `translate.languages.${languageId}`,
      labelFallback: resolveText(undefined, languageId),
    }));
  };
}
