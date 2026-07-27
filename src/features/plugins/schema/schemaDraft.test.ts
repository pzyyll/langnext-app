// ABOUTME: Tests schema draft defaults, deterministic dirty state, and write-only credential projections.
// ABOUTME: Ensures config JSON never receives credential text or credential-slot field values.
import { describe, expect, test } from "bun:test";
import type { PluginSchemaV1 } from "../../../storage/types";
import {
  buildSchemaConfig,
  buildSchemaCredentialWrites,
  createSchemaDraft,
  createSchemaDraftFromJson,
  isSchemaDraftDirty,
  setSchemaCredentialAction,
  setSchemaCredentialValue,
  setSchemaDraftValue,
} from "./schemaDraft";

const schema: PluginSchemaV1 = {
  version: 1,
  fields: [
    {
      id: "project-id",
      control: { kind: "string", spec: {} },
      requiredForReady: true,
    },
    {
      id: "channel",
      control: {
        kind: "enum",
        spec: {
          source: { type: "fixed", options: [{ value: "gtx" }, { value: "https_proxy" }] },
          default: "gtx",
        },
      },
      requiredForReady: true,
    },
    {
      id: "enabled",
      control: { kind: "boolean", spec: { default: false } },
      requiredForReady: false,
    },
    {
      id: "language-hints",
      control: {
        kind: "multi-enum",
        spec: { source: { type: "host", id: "host.supported-languages@1" }, maxSelected: 3, default: ["en"] },
      },
      requiredForReady: false,
    },
    {
      id: "service-account",
      control: { kind: "credential-slot", spec: { slotId: "service-account-json" } },
      requiredForReady: true,
    },
  ],
  groups: [],
};

describe("schemaDraft", () => {
  test("applies defaults and projects credentials as write-only state", () => {
    const draft = createSchemaDraft(schema, {
      config: { "project-id": "demo" },
      credentialSlots: [{ slotId: "service-account-json", hasCredential: true, credentialRevision: 4 }],
    });

    expect(draft.values).toEqual({
      "project-id": "demo",
      channel: "gtx",
      enabled: false,
      "language-hints": ["en"],
    });
    expect(draft.credentials["service-account-json"]).toEqual({
      action: "keep",
      value: "",
      hasCredential: true,
    });
  });

  test("keeps dirty state deterministic after default application", () => {
    const baseline = createSchemaDraft(schema, {
      config: { channel: "gtx", enabled: false, "language-hints": ["en"] },
    });
    const fromEmpty = createSchemaDraft(schema);

    expect(isSchemaDraftDirty(schema, fromEmpty, baseline)).toBe(false);
    const changed = setSchemaDraftValue(fromEmpty, "project-id", "demo");
    expect(isSchemaDraftDirty(schema, changed, baseline)).toBe(true);
  });

  test("projects credential actions without putting secret text in config", () => {
    const initial = createSchemaDraft(schema, {
      credentialSlots: [{ slotId: "service-account-json", hasCredential: true, credentialRevision: 1 }],
    });
    const replacement = setSchemaCredentialValue(initial, "service-account-json", "  secret-json  ");

    expect(buildSchemaConfig(schema, replacement)).not.toHaveProperty("service-account");
    expect(buildSchemaCredentialWrites(schema, replacement)).toEqual([
      {
        slotId: "service-account-json",
        credential: { action: "replace", value: "secret-json" },
      },
    ]);
    expect(isSchemaDraftDirty(schema, replacement, initial)).toBe(true);

    const cleared = setSchemaCredentialAction(replacement, "service-account-json", "clear");
    expect(cleared.credentials["service-account-json"]?.value).toBe("");
    expect(buildSchemaCredentialWrites(schema, cleared)[0]?.credential).toEqual({ action: "clear" });
  });

  test("reads only object-shaped persisted config", () => {
    const valid = createSchemaDraftFromJson(schema, '{"project-id":"demo"}', []);
    const malformed = createSchemaDraftFromJson(schema, "not-json", []);

    expect(valid.values["project-id"]).toBe("demo");
    expect(malformed.values["project-id"]).toBeUndefined();
    expect(malformed.values.channel).toBe("gtx");
  });

  test("projects legacy camelCase config keys onto canonical schema field IDs", () => {
    const legacy = createSchemaDraft(schema, {
      config: { projectId: "legacy-project", languageHints: ["zh"] },
    });

    expect(legacy.values["project-id"]).toBe("legacy-project");
    expect(legacy.values["language-hints"]).toEqual(["zh"]);
    expect(buildSchemaConfig(schema, legacy)).toMatchObject({
      "project-id": "legacy-project",
      "language-hints": ["zh"],
    });
  });

  test("clearing a defaulted number is not dirty after default re-projection", () => {
    const numberSchema: PluginSchemaV1 = {
      version: 1,
      fields: [
        {
          id: "speed",
          control: { kind: "number", spec: { min: 0, max: 2, step: 0.1, default: 1.0 } },
          requiredForReady: false,
        },
      ],
      groups: [],
    };
    const baseline = createSchemaDraft(numberSchema, { config: { speed: 1.0 } });
    const cleared = setSchemaDraftValue(baseline, "speed", undefined);

    // buildSchemaConfig omits undefined, but dirty comparison re-projects defaults.
    expect(buildSchemaConfig(numberSchema, cleared)).toEqual({});
    expect(isSchemaDraftDirty(numberSchema, cleared, baseline)).toBe(false);

    const changed = setSchemaDraftValue(baseline, "speed", 0.5);
    expect(isSchemaDraftDirty(numberSchema, changed, baseline)).toBe(true);
  });
});
