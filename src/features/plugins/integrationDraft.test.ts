// ABOUTME: Tests generic integration draft projection from schema definitions and instance DTOs.
// ABOUTME: Ensures defaults, camelCase migration, dirty state, and write-only credentials stay intact.
import { describe, expect, test } from "bun:test";
import type { IntegrationInstanceDto, ServiceIntegrationDefinitionDto } from "../../storage/types";
import { setSchemaCredentialValue, setSchemaDraftValue } from "./schema/schemaDraft";
import {
  buildIntegrationWrite,
  createIntegrationDraft,
  draftFromIntegrationDto,
  hasIntegrationRemoteRelevantMutation,
  isIntegrationDraftClean,
} from "./integrationDraft";

const pluginId = "com.example.schema-plugin";
const credentialSlotId = "service-account-json";

const definition: ServiceIntegrationDefinitionDto = {
  manifestVersion: 1,
  pluginApiVersion: "1.0",
  id: pluginId,
  version: "1.0.0",
  displayNameKey: "plugins.example.name",
  minHostVersion: "0.1.0",
  configSchemaVersion: 1,
  credentialSlots: [{ id: credentialSlotId, kind: "secret_json", required: true }],
  endpoints: [],
  capabilities: [],
  configSchema: {
    version: 1,
    fields: [
      {
        id: "project-id",
        control: { kind: "string", spec: {} },
        requiredForReady: true,
      },
      {
        id: "proxy-mode",
        control: {
          kind: "enum",
          spec: {
            source: { type: "fixed", options: [{ value: "inherit" }, { value: "direct" }] },
            default: "inherit",
          },
        },
        requiredForReady: true,
      },
      {
        id: "service-account",
        control: { kind: "credential-slot", spec: { slotId: credentialSlotId } },
        requiredForReady: true,
      },
    ],
    groups: [],
  },
  capabilitySchemas: [],
  presentation: { displayNameFallback: "Example plugin", icon: "extension" },
};

function sampleInstance(overrides?: Partial<IntegrationInstanceDto>): IntegrationInstanceDto {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    pluginId,
    pluginVersion: "1.0.0",
    displayName: "Example",
    enabled: true,
    // Legacy frontend shape; the generic draft projects it to schema field IDs.
    configJson: JSON.stringify({ projectId: "my-project", proxyMode: "inherit" }),
    configSchemaVersion: 1,
    healthStatus: "unvalidated",
    effectiveStatus: "unvalidated",
    lastValidatedAt: null,
    lastErrorCode: null,
    runtimeKind: "bundled-rust",
    runtimeState: "active",
    credentialSlots: [{ slotId: credentialSlotId, hasCredential: true, credentialRevision: 2 }],
    createdAt: "t0",
    updatedAt: "t1",
    ...overrides,
  };
}

describe("integrationDraft", () => {
  test("builds an empty draft from schema defaults", () => {
    const draft = createIntegrationDraft(definition, "Example plugin");

    expect(draft.pluginId).toBe(pluginId);
    expect(draft.schema.values).toEqual({ "proxy-mode": "inherit" });
    expect(draft.schema.credentials[credentialSlotId]).toEqual({ action: "keep", value: "", hasCredential: false });
  });

  test("projects legacy config keys without copying secret values", () => {
    const instance = sampleInstance();
    const draft = draftFromIntegrationDto(instance, definition);

    expect(draft.schema.values).toEqual({ "project-id": "my-project", "proxy-mode": "inherit" });
    expect(draft.schema.credentials[credentialSlotId]).toEqual({ action: "keep", value: "", hasCredential: true });
    expect(JSON.stringify(draft)).not.toContain("private_key");
  });

  test("builds canonical config JSON and a separate write-only credential action", () => {
    const instance = sampleInstance();
    let draft = draftFromIntegrationDto(instance, definition);
    draft = {
      ...draft,
      schema: setSchemaCredentialValue(draft.schema, credentialSlotId, "  secret-json  "),
    };

    const write = buildIntegrationWrite(definition, draft, { id: instance.id });
    expect(write.configJson).toBe(JSON.stringify({ "project-id": "my-project", "proxy-mode": "inherit" }));
    expect(write.configJson).not.toContain("secret-json");
    expect(write.credentials).toEqual([
      {
        slotId: credentialSlotId,
        credential: { action: "replace", value: "secret-json" },
      },
    ]);
  });

  test("distinguishes name-only changes from config and credential changes", () => {
    const instance = sampleInstance();
    const initial = draftFromIntegrationDto(instance, definition);
    const renamed = { ...initial, displayName: "Renamed" };
    const configChanged = {
      ...initial,
      schema: setSchemaDraftValue(initial.schema, "project-id", "other-project"),
    };

    expect(isIntegrationDraftClean(definition, initial, instance)).toBe(true);
    expect(isIntegrationDraftClean(definition, renamed, instance)).toBe(false);
    expect(hasIntegrationRemoteRelevantMutation(definition, renamed, instance)).toBe(false);
    expect(hasIntegrationRemoteRelevantMutation(definition, configChanged, instance)).toBe(true);
  });
});
