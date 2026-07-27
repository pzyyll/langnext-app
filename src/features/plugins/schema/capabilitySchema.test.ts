// ABOUTME: Tests capability preference schema resolution from sanitized integration definitions.
// ABOUTME: Ensures missing or version-mismatched descriptors fail closed before editors can save.
import { describe, expect, test } from "bun:test";
import type { IntegrationInstanceDto, ServiceIntegrationDefinitionDto } from "../../../storage/types";
import { preferenceSchemaForBinding, preferenceSchemaForCapability } from "./capabilitySchema";

const capabilityId = "speech.synthesize@1";

const definition: ServiceIntegrationDefinitionDto = {
  manifestVersion: 1,
  pluginApiVersion: "1",
  id: "com.example.speech",
  version: "1.0.0",
  displayNameKey: "plugins.example.name",
  minHostVersion: "0.1.0",
  configSchemaVersion: 1,
  credentialSlots: [],
  endpoints: [],
  capabilities: [{ id: capabilityId, preferencesSchemaVersion: 1 }],
  configSchema: { version: 1, fields: [], groups: [] },
  capabilitySchemas: [{ capabilityId, preferenceSchema: { version: 1, fields: [], groups: [] } }],
  presentation: { displayNameFallback: "Example Speech", icon: "extension" },
};

const instance: IntegrationInstanceDto = {
  id: "integration-1",
  pluginId: definition.id,
  pluginVersion: definition.version,
  displayName: "Example",
  enabled: true,
  configJson: "{}",
  configSchemaVersion: 1,
  healthStatus: "ready",
  effectiveStatus: "ready",
  lastValidatedAt: null,
  lastErrorCode: null,
  credentialSlots: [],
  createdAt: "t0",
  updatedAt: "t0",
};

describe("preferenceSchemaForCapability", () => {
  test("returns the descriptor and matching schema", () => {
    const resolved = preferenceSchemaForCapability(definition, capabilityId);
    expect(resolved?.descriptor.id).toBe(capabilityId);
    expect(resolved?.schema.version).toBe(1);
  });

  test("fails closed when the schema version differs from its descriptor", () => {
    const incompatible: ServiceIntegrationDefinitionDto = {
      ...definition,
      capabilitySchemas: [{ capabilityId, preferenceSchema: { version: 2, fields: [], groups: [] } }],
    };
    expect(preferenceSchemaForCapability(incompatible, capabilityId)).toBeNull();
  });

  test("fails closed when a requested capability is not declared", () => {
    expect(preferenceSchemaForCapability(definition, "ocr.image@1")).toBeNull();
  });
});

describe("preferenceSchemaForBinding", () => {
  test("resolves only when both the instance and its definition are present", () => {
    expect(preferenceSchemaForBinding([instance], [definition], instance.id, capabilityId)).not.toBeNull();
    expect(preferenceSchemaForBinding([], [definition], instance.id, capabilityId)).toBeNull();
    expect(preferenceSchemaForBinding([instance], [], instance.id, capabilityId)).toBeNull();
  });
});
