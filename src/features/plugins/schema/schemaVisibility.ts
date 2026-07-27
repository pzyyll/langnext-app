// ABOUTME: Equality-only visibility evaluation for the closed Phase 1 plugin schema dialect.
// ABOUTME: Keeps hidden fields in drafts while deciding which controls the renderer displays.
import type { PluginSchemaV1, SchemaField } from "../../../storage/types";

export type SchemaValues = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => valuesEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && valuesEqual(left[key], right[key]))
    );
  }
  return false;
}

/** Whether a schema field is visible under the current config values. */
export function isSchemaFieldVisible(field: SchemaField, values: SchemaValues): boolean {
  const condition = field.visibleWhen;
  if (!condition) {
    return true;
  }
  return valuesEqual(values[condition.field], condition.equals);
}

/** Return schema fields in declaration order after applying Phase 0 visibility conditions. */
export function visibleSchemaFields(schema: PluginSchemaV1, values: SchemaValues): SchemaField[] {
  return schema.fields.filter((field) => isSchemaFieldVisible(field, values));
}
