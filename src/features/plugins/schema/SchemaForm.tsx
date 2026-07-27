// ABOUTME: Schema-driven form layout for plugin config and capability preference editors.
// ABOUTME: Renders only closed Phase 1 schema controls and delegates validation to Rust on save.
import { Fieldset } from "@base-ui/react/fieldset";
import type { ReactNode } from "react";
import type { PluginSchemaV1, SchemaField as SchemaFieldDefinition, SchemaOption } from "../../../storage/types";
import { SchemaField, type SchemaOptionResolver, type SchemaTextResolver } from "./SchemaField";
import type { SchemaCredentialDraft } from "./schemaDraft";
import { isSchemaFieldVisible } from "./schemaVisibility";

const groupLegendClassName = "border-b border-line pb-1 text-label-sm font-bold uppercase text-on-surface";

const fallbackTextResolver: SchemaTextResolver = (key, fallback) => fallback ?? key ?? "";
const emptyOptionResolver: SchemaOptionResolver = () => [];

export type SchemaFormProps = {
  schema: PluginSchemaV1;
  values: Readonly<Record<string, unknown>>;
  credentials?: Readonly<Record<string, SchemaCredentialDraft>>;
  idPrefix: string;
  disabled?: boolean;
  readOnly?: boolean;
  errors?: Readonly<Record<string, string | undefined>>;
  resolveText?: SchemaTextResolver;
  resolveOptions?: (sourceId: string) => readonly SchemaOption[];
  onValueChange?: (fieldId: string, value: unknown) => void;
  onCredentialChange?: (slotId: string, credential: SchemaCredentialDraft) => void;
};

function groupFields(
  fieldIds: readonly string[],
  fieldsById: ReadonlyMap<string, SchemaFieldDefinition>,
): SchemaFieldDefinition[] {
  const result: SchemaFieldDefinition[] = [];
  for (const fieldId of fieldIds) {
    const field = fieldsById.get(fieldId);
    if (field) {
      result.push(field);
    }
  }
  return result;
}

export function SchemaForm({
  schema,
  values,
  credentials = {},
  idPrefix,
  disabled = false,
  readOnly = false,
  errors = {},
  resolveText = fallbackTextResolver,
  resolveOptions = emptyOptionResolver,
  onValueChange,
  onCredentialChange,
}: SchemaFormProps) {
  const visibleFields = schema.fields.filter((field) => isSchemaFieldVisible(field, values));
  const fieldsById = new Map(visibleFields.map((field) => [field.id, field]));
  const renderedIds = new Set<string>();

  const renderField = (field: SchemaFieldDefinition): ReactNode => (
    <SchemaField
      key={field.id}
      field={field}
      value={values[field.id]}
      credential={field.control.kind === "credential-slot" ? credentials[field.control.spec.slotId] : undefined}
      idPrefix={idPrefix}
      disabled={disabled}
      readOnly={readOnly}
      error={errors[field.id]}
      resolveText={resolveText}
      resolveOptions={resolveOptions}
      onValueChange={onValueChange}
      onCredentialChange={onCredentialChange}
    />
  );

  const groups = schema.groups.map((group) => {
    const fields = groupFields(group.fields, fieldsById);
    if (fields.length === 0) {
      return null;
    }
    for (const field of fields) {
      renderedIds.add(field.id);
    }
    const label = resolveText(group.labelKey, group.labelFallback ?? group.id);
    return (
      <Fieldset.Root key={group.id} className="flex flex-col gap-4">
        <Fieldset.Legend className={groupLegendClassName}>{label}</Fieldset.Legend>
        {fields.map(renderField)}
      </Fieldset.Root>
    );
  });

  const ungroupedFields = visibleFields.filter((field) => !renderedIds.has(field.id));

  return (
    <div className="space-y-4">
      {groups}
      {ungroupedFields.map(renderField)}
    </div>
  );
}
