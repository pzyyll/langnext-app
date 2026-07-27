// ABOUTME: Tests the closed equality-only visibility contract for plugin schema fields.
// ABOUTME: Guards against adding expression evaluation or dropping fields from stored drafts.
import { describe, expect, test } from "bun:test";
import type { PluginSchemaV1, SchemaField } from "../../../storage/types";
import { isSchemaFieldVisible, visibleSchemaFields } from "./schemaVisibility";

const proxyUrlField: SchemaField = {
  id: "proxy-url",
  control: { kind: "string", spec: {} },
  requiredForReady: true,
  visibleWhen: { field: "channel", equals: "https_proxy" },
};

const schema: PluginSchemaV1 = {
  version: 1,
  fields: [
    {
      id: "channel",
      control: { kind: "enum", spec: { source: { type: "fixed", options: [] } } },
      requiredForReady: true,
    },
    proxyUrlField,
  ],
  groups: [],
};

describe("schemaVisibility", () => {
  test("shows a field only when its declared equality condition matches", () => {
    expect(isSchemaFieldVisible(proxyUrlField, { channel: "https_proxy" })).toBe(true);
    expect(isSchemaFieldVisible(proxyUrlField, { channel: "gtx" })).toBe(false);
    expect(isSchemaFieldVisible(proxyUrlField, {})).toBe(false);
  });

  test("uses structural equality for schema JSON values", () => {
    const field: SchemaField = {
      id: "advanced",
      control: { kind: "boolean", spec: { default: false } },
      requiredForReady: false,
      visibleWhen: { field: "languages", equals: ["en", "zh"] },
    };

    expect(isSchemaFieldVisible(field, { languages: ["en", "zh"] })).toBe(true);
    expect(isSchemaFieldVisible(field, { languages: ["zh", "en"] })).toBe(false);
  });

  test("preserves declaration order while filtering invisible fields", () => {
    expect(visibleSchemaFields(schema, { channel: "gtx" }).map((field) => field.id)).toEqual(["channel"]);
    expect(visibleSchemaFields(schema, { channel: "https_proxy" }).map((field) => field.id)).toEqual([
      "channel",
      "proxy-url",
    ]);
  });
});
