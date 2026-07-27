// ABOUTME: Resolves a bound integration capability to its sanitized preference schema metadata.
// ABOUTME: Makes missing or incompatible descriptors explicit so editors can stay read-only safely.
import type {
  IntegrationCapabilityDescriptor,
  IntegrationInstanceDto,
  PluginSchemaV1,
  ServiceIntegrationDefinitionDto,
} from "../../../storage/types";

export type CapabilityPreferenceSchema = {
  definition: ServiceIntegrationDefinitionDto;
  descriptor: IntegrationCapabilityDescriptor;
  schema: PluginSchemaV1;
};

/** Find the schema registered for a concrete capability on one bundled definition. */
export function preferenceSchemaForCapability(
  definition: ServiceIntegrationDefinitionDto,
  capabilityId: string,
): CapabilityPreferenceSchema | null {
  const descriptor = definition.capabilities.find((capability) => capability.id === capabilityId);
  const capabilitySchema = definition.capabilitySchemas.find((entry) => entry.capabilityId === capabilityId);
  if (
    !descriptor ||
    !capabilitySchema ||
    capabilitySchema.preferenceSchema.version !== descriptor.preferencesSchemaVersion
  ) {
    return null;
  }
  return {
    definition,
    descriptor,
    schema: capabilitySchema.preferenceSchema,
  };
}

/** Resolve a persisted service binding through its integration instance and current definition catalog. */
export function preferenceSchemaForBinding(
  instances: readonly IntegrationInstanceDto[],
  definitions: readonly ServiceIntegrationDefinitionDto[],
  integrationInstanceId: string,
  capabilityId: string,
): CapabilityPreferenceSchema | null {
  const instance = instances.find((item) => item.id === integrationInstanceId);
  if (!instance) {
    return null;
  }
  const definition = definitions.find((item) => item.id === instance.pluginId);
  return definition ? preferenceSchemaForCapability(definition, capabilityId) : null;
}
