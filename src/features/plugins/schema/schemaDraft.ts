// ABOUTME: Schema-driven config and write-only credential draft construction for plugin editors.
// ABOUTME: Applies frontend defaults deterministically while leaving Rust authoritative for validation.
import type {
  CredentialSlotStatusDto,
  IntegrationSlotCredentialWrite,
  PluginSchemaV1,
  SchemaField,
} from "../../../storage/types";

export type SchemaConfigValues = Record<string, unknown>;
export type SchemaCredentialAction = "keep" | "replace" | "clear";

export type SchemaCredentialDraft = {
  action: SchemaCredentialAction;
  /** Ephemeral replacement input only; never populated from an instance DTO. */
  value: string;
  hasCredential: boolean;
};

export type SchemaDraft = {
  values: SchemaConfigValues;
  credentials: Record<string, SchemaCredentialDraft>;
};

export type CreateSchemaDraftOptions = {
  config?: unknown;
  credentialSlots?: readonly CredentialSlotStatusDto[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneJsonValue(nested)]));
  }
  return value;
}

function legacyCamelCaseFieldId(fieldId: string): string {
  return fieldId.replace(/-([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function suppliedFieldValue(config: Record<string, unknown>, fieldId: string): unknown {
  if (Object.prototype.hasOwnProperty.call(config, fieldId)) {
    return config[fieldId];
  }
  return config[legacyCamelCaseFieldId(fieldId)];
}

function fieldDefault(field: SchemaField): unknown {
  switch (field.control.kind) {
    case "string":
    case "multiline-string":
      return field.control.spec.default;
    case "number":
      return field.control.spec.default;
    case "boolean":
      return field.control.spec.default;
    case "enum":
      return field.control.spec.default;
    case "multi-enum":
      return [...field.control.spec.default];
    case "credential-slot":
      return undefined;
  }
}

function credentialSlotIds(schema: PluginSchemaV1): string[] {
  const slotIds = new Set<string>();
  for (const field of schema.fields) {
    if (field.control.kind === "credential-slot") {
      slotIds.add(field.control.spec.slotId);
    }
  }
  return [...slotIds];
}

/** Parse a stored config string into an object, falling back to an empty draft-safe object. */
export function parseSchemaConfigJson(configJson: string): SchemaConfigValues {
  try {
    const parsed: unknown = JSON.parse(configJson);
    return isRecord(parsed) ? (cloneJsonValue(parsed) as SchemaConfigValues) : {};
  } catch {
    return {};
  }
}

/** Build an editable draft from schema defaults, persisted non-secret config, and slot status. */
export function createSchemaDraft(schema: PluginSchemaV1, options: CreateSchemaDraftOptions = {}): SchemaDraft {
  const config = isRecord(options.config) ? options.config : {};
  const slotStatusById = new Map(options.credentialSlots?.map((slot) => [slot.slotId, slot]));
  const values: SchemaConfigValues = {};

  for (const field of schema.fields) {
    if (field.control.kind === "credential-slot") {
      continue;
    }
    const supplied = suppliedFieldValue(config, field.id);
    const value = supplied == null ? fieldDefault(field) : cloneJsonValue(supplied);
    if (value !== undefined) {
      values[field.id] = value;
    }
  }

  const credentials = Object.fromEntries(
    credentialSlotIds(schema).map((slotId) => [
      slotId,
      {
        action: "keep" as const,
        value: "",
        hasCredential: slotStatusById.get(slotId)?.hasCredential ?? false,
      },
    ]),
  );
  return { values, credentials };
}

/** Build a draft directly from persisted JSON without accepting a secret-bearing config object. */
export function createSchemaDraftFromJson(
  schema: PluginSchemaV1,
  configJson: string,
  credentialSlots: readonly CredentialSlotStatusDto[],
): SchemaDraft {
  return createSchemaDraft(schema, {
    config: parseSchemaConfigJson(configJson),
    credentialSlots,
  });
}

/** Apply one controlled config field value without mutating the current draft. */
export function setSchemaDraftValue(draft: SchemaDraft, fieldId: string, value: unknown): SchemaDraft {
  return {
    ...draft,
    values: {
      ...draft.values,
      [fieldId]: value,
    },
  };
}

/** Change a credential action and clear any transient secret when it is no longer a replacement. */
export function setSchemaCredentialAction(
  draft: SchemaDraft,
  slotId: string,
  action: SchemaCredentialAction,
): SchemaDraft {
  const current = draft.credentials[slotId] ?? { action: "keep", value: "", hasCredential: false };
  return {
    ...draft,
    credentials: {
      ...draft.credentials,
      [slotId]: {
        ...current,
        action,
        value: action === "replace" ? current.value : "",
      },
    },
  };
}

/** Store transient credential text; a nonblank value always becomes a replacement action. */
export function setSchemaCredentialValue(draft: SchemaDraft, slotId: string, value: string): SchemaDraft {
  const current = draft.credentials[slotId] ?? { action: "keep", value: "", hasCredential: false };
  return {
    ...draft,
    credentials: {
      ...draft.credentials,
      [slotId]: {
        ...current,
        action: value.trim() ? "replace" : "keep",
        value,
      },
    },
  };
}

/** Project a draft to the non-secret config object accepted by Rust schema adapters. */
export function buildSchemaConfig(schema: PluginSchemaV1, draft: SchemaDraft): SchemaConfigValues {
  const output: SchemaConfigValues = {};
  for (const field of schema.fields) {
    if (field.control.kind === "credential-slot") {
      continue;
    }
    const value = draft.values[field.id];
    if (value !== undefined && value !== null) {
      output[field.id] = cloneJsonValue(value);
    }
  }
  return output;
}

/** Project config with defaults applied for missing fields, so dirty comparison is stable even
 *  when a draft clears a defaulted field (the default is re-projected on both sides). */
function buildSchemaConfigWithDefaults(schema: PluginSchemaV1, draft: SchemaDraft): SchemaConfigValues {
  const output = buildSchemaConfig(schema, draft);
  for (const field of schema.fields) {
    if (field.control.kind === "credential-slot") {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(output, field.id)) {
      const defaultValue = fieldDefault(field);
      if (defaultValue !== undefined && defaultValue !== null) {
        output[field.id] = cloneJsonValue(defaultValue);
      }
    }
  }
  return output;
}

/** Project write-only credential draft intent to storage command inputs. */
export function buildSchemaCredentialWrites(
  schema: PluginSchemaV1,
  draft: SchemaDraft,
): IntegrationSlotCredentialWrite[] {
  return credentialSlotIds(schema).map((slotId) => {
    const credential = draft.credentials[slotId] ?? { action: "keep", value: "", hasCredential: false };
    if (credential.action === "clear") {
      return { slotId, credential: { action: "clear" } };
    }
    if (credential.action === "replace" && credential.value.trim()) {
      return {
        slotId,
        credential: { action: "replace", value: credential.value.trim() },
      };
    }
    return { slotId, credential: { action: "keep" } };
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function credentialMutation(draft: SchemaCredentialDraft): string {
  if (draft.action === "clear") {
    return draft.hasCredential ? "clear" : "";
  }
  if (draft.action === "replace") {
    const value = draft.value.trim();
    return value ? `replace:${value}` : "";
  }
  return "";
}

/** Compare config after default projection and only count credential actions that mutate stored state. */
export function isSchemaDraftDirty(schema: PluginSchemaV1, draft: SchemaDraft, baseline: SchemaDraft): boolean {
  if (
    stableJson(buildSchemaConfigWithDefaults(schema, draft)) !==
    stableJson(buildSchemaConfigWithDefaults(schema, baseline))
  ) {
    return true;
  }
  return credentialSlotIds(schema).some((slotId) => {
    const current = draft.credentials[slotId] ?? { action: "keep", value: "", hasCredential: false };
    const initial = baseline.credentials[slotId] ?? { action: "keep", value: "", hasCredential: false };
    return credentialMutation(current) !== credentialMutation(initial);
  });
}
