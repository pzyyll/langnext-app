// ABOUTME: Generic schema-backed integration drafts and storage write projections.
// ABOUTME: Keeps credentials write-only and migrates legacy camelCase config keys on the next save.
import type {
  EndpointTrustSavePayload,
  IntegrationInstanceDto,
  IntegrationInstanceWrite,
  ServiceIntegrationDefinitionDto,
} from "../../storage/types";
import {
  buildSchemaConfig,
  buildSchemaCredentialWrites,
  createSchemaDraft,
  createSchemaDraftFromJson,
  isSchemaDraftDirty,
  type SchemaDraft,
} from "./schema/schemaDraft";

export type IntegrationSchemaDraft = {
  pluginId: string;
  schemaVersion: number;
  displayName: string;
  enabled: boolean;
  schema: SchemaDraft;
  expectedUpdatedAt: string | null;
};

/** Build an empty integration instance draft using only definition defaults and slot metadata. */
export function createIntegrationDraft(
  definition: ServiceIntegrationDefinitionDto,
  displayName = "",
): IntegrationSchemaDraft {
  return {
    pluginId: definition.id,
    schemaVersion: definition.configSchemaVersion,
    displayName,
    enabled: true,
    schema: createSchemaDraft(definition.configSchema),
    expectedUpdatedAt: null,
  };
}

/** Build an editor draft from a sanitized instance DTO; no credential value enters frontend state. */
export function draftFromIntegrationDto(
  instance: IntegrationInstanceDto,
  definition: ServiceIntegrationDefinitionDto,
): IntegrationSchemaDraft {
  return {
    pluginId: instance.pluginId,
    schemaVersion: definition.configSchemaVersion,
    displayName: instance.displayName,
    enabled: instance.enabled,
    schema: createSchemaDraftFromJson(definition.configSchema, instance.configJson, instance.credentialSlots),
    expectedUpdatedAt: instance.updatedAt,
  };
}

/** Serialize generic schema fields and write-only credential actions for an integration save. */
export function buildIntegrationWrite(
  definition: ServiceIntegrationDefinitionDto,
  draft: IntegrationSchemaDraft,
  options: {
    id?: string | null;
    expectedUpdatedAt?: string | null;
    endpointTrust?: EndpointTrustSavePayload | null;
  } = {},
): IntegrationInstanceWrite {
  return {
    id: options.id ?? null,
    pluginId: definition.id,
    displayName: draft.displayName.trim(),
    enabled: draft.enabled,
    configJson: JSON.stringify(buildSchemaConfig(definition.configSchema, draft.schema)),
    credentials: buildSchemaCredentialWrites(definition.configSchema, draft.schema),
    expectedUpdatedAt: options.expectedUpdatedAt ?? draft.expectedUpdatedAt,
    endpointTrustPreviewId: options.endpointTrust?.endpointTrustPreviewId ?? null,
    acknowledgeEndpointTrust: options.endpointTrust?.acknowledgeEndpointTrust ?? false,
  };
}

/** True when user-visible name/config/credential state differs from the loaded instance. */
export function isIntegrationDraftClean(
  definition: ServiceIntegrationDefinitionDto,
  draft: IntegrationSchemaDraft,
  instance: IntegrationInstanceDto,
): boolean {
  if (draft.pluginId !== instance.pluginId) {
    return false;
  }
  const baseline = draftFromIntegrationDto(instance, definition);
  return (
    draft.displayName === baseline.displayName &&
    !isSchemaDraftDirty(definition.configSchema, draft.schema, baseline.schema)
  );
}

/** Config or credential changes need post-save integration validation; a name-only save does not. */
export function hasIntegrationRemoteRelevantMutation(
  definition: ServiceIntegrationDefinitionDto,
  draft: IntegrationSchemaDraft,
  instance: IntegrationInstanceDto,
): boolean {
  const baseline = draftFromIntegrationDto(instance, definition);
  return isSchemaDraftDirty(definition.configSchema, draft.schema, baseline.schema);
}
