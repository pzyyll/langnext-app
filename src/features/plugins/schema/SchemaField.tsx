// ABOUTME: Renders one closed-schema field with Base UI controls and explicit accessibility links.
// ABOUTME: Credential controls are write-only and expose only keep, replace, and clear intent.
import { Checkbox } from "@base-ui/react/checkbox";
import { Fieldset } from "@base-ui/react/fieldset";
import { Input } from "@base-ui/react/input";
import { NumberField } from "@base-ui/react/number-field";
import { Select } from "@base-ui/react/select";
import IconClarityAngleLine from "~icons/clarity/angle-line";
import IconMaterialSymbolsLightAdd from "~icons/material-symbols-light/add";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightRemove from "~icons/material-symbols-light/remove";
import { checkboxClassName, checkboxIndicatorClassName, inputClassName } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import type { SchemaField as SchemaFieldDefinition, SchemaOption, SchemaOptionSource } from "../../../storage/types";
import type { SchemaCredentialAction, SchemaCredentialDraft } from "./schemaDraft";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";
const fieldDescriptionClassName = "text-body-tight text-neutral";
const fieldErrorClassName = "text-body-tight text-error";
const selectCollisionPadding = 8;
const selectValueClassName = "min-w-0 flex-1 truncate text-left data-placeholder:text-neutral";
const selectIconClassName =
  "inline-flex size-4 shrink-0 rotate-180 items-center justify-center transition-transform duration-200 ease-out data-popup-open:rotate-0";
const selectListClassName =
  "max-h-[min(22.5rem,var(--available-height))] scroll-py-1 overflow-y-auto overscroll-contain py-1";
const multilineInputClassName = `${inputClassName} min-h-28 resize-y`;
const credentialInputClassName = `${inputClassName} min-h-28 font-mono`;
const numberDecrementClassName = "border-r-0";
const numberIncrementClassName = "border-l-0";
const numberInputClassName = `${inputClassName} w-24 border-x-0 text-center tabular-nums`;
const multiEnumGridClassName = "grid grid-cols-1 gap-2 sm:grid-cols-2";
const multiEnumOptionClassName =
  "flex min-h-9 items-center gap-2 border border-line bg-surface px-2 text-body-tight text-on-surface";
const stepperButtonClassName =
  "flex h-control-height w-8 shrink-0 items-center justify-center border border-line bg-surface text-on-surface select-none hover:not-data-disabled:bg-surface-2 active:not-data-disabled:bg-surface-3 data-disabled:border-disabled data-disabled:text-disabled focus-visible:z-1 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface";
const selectTriggerClassName =
  "flex h-control-height w-full items-center justify-between gap-2 rounded-none border border-line bg-surface pl-2 pr-1 text-body-tight font-normal text-on-surface select-none hover:not-data-disabled:bg-surface-2 active:not-data-disabled:bg-surface-3 data-disabled:border-disabled data-disabled:text-disabled data-popup-open:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface";
const selectPopupClassName =
  "min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) border border-line bg-surface text-on-surface shadow-frame transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0";
const selectItemClassName =
  "grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 py-1.5 pr-3 pl-2.5 text-body-tight outline-hidden select-none data-highlighted:bg-on-surface data-highlighted:text-surface data-disabled:text-disabled";

export type SchemaTextResolver = (key: string | undefined, fallback: string | undefined) => string;
export type SchemaOptionResolver = (sourceId: string) => readonly SchemaOption[];

export type SchemaFieldProps = {
  field: SchemaFieldDefinition;
  value: unknown;
  credential?: SchemaCredentialDraft;
  idPrefix: string;
  disabled?: boolean;
  readOnly?: boolean;
  error?: string;
  resolveText: SchemaTextResolver;
  resolveOptions: SchemaOptionResolver;
  onValueChange?: (fieldId: string, value: unknown) => void;
  onCredentialChange?: (slotId: string, credential: SchemaCredentialDraft) => void;
};

type FieldMessagesProps = {
  id: string;
  description?: string;
  error?: string;
};

type SelectOption = {
  value: string;
  label: string;
};

type SchemaSelectProps = {
  id: string;
  label: string;
  description?: string;
  error?: string;
  value: string;
  options: readonly SelectOption[];
  disabled: boolean;
  onValueChange: (value: string) => void;
};

function descriptionId(id: string): string {
  return `${id}-description`;
}

function errorId(id: string): string {
  return `${id}-error`;
}

function describedBy(id: string, description: string | undefined, error: string | undefined): string | undefined {
  const ids = [description ? descriptionId(id) : undefined, error ? errorId(id) : undefined].filter(
    (value): value is string => Boolean(value),
  );
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function FieldMessages({ id, description, error }: FieldMessagesProps) {
  return (
    <>
      {description ? (
        <p id={descriptionId(id)} className={fieldDescriptionClassName}>
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId(id)} className={fieldErrorClassName} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionList(
  source: SchemaOptionSource,
  resolveOptions: SchemaOptionResolver,
  resolveText: SchemaTextResolver,
): SelectOption[] {
  const options = source.type === "fixed" ? source.options : resolveOptions(source.id);
  return options.map((option) => ({
    value: option.value,
    label: resolveText(option.labelKey, option.labelFallback ?? option.value),
  }));
}

function SchemaSelect({ id, label, description, error, value, options, disabled, onValueChange }: SchemaSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <Select.Root
        value={value}
        onValueChange={(next) => onValueChange(next ?? "")}
        items={options}
        disabled={disabled}
      >
        <Select.Label className={fieldLabelClassName}>{label}</Select.Label>
        <Select.Trigger
          id={id}
          className={selectTriggerClassName}
          aria-describedby={describedBy(id, description, error)}
          aria-invalid={Boolean(error) || undefined}
        >
          <Select.Value className={selectValueClassName} placeholder="Select an option" />
          <Select.Icon className={selectIconClassName}>
            <IconClarityAngleLine className="pointer-events-none size-4" aria-hidden />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner
            className="z-50 outline-hidden select-none"
            alignItemWithTrigger={false}
            side="bottom"
            align="start"
            sideOffset={4}
            collisionPadding={selectCollisionPadding}
            positionMethod="fixed"
          >
            <Select.Popup className={selectPopupClassName}>
              <Select.List className={selectListClassName}>
                {options.map((option) => (
                  <Select.Item key={option.value} value={option.value} className={selectItemClassName}>
                    <Select.ItemIndicator className="col-start-1">
                      <IconMaterialSymbolsLightCheck className="pointer-events-none size-4 shrink-0" aria-hidden />
                    </Select.ItemIndicator>
                    <Select.ItemText className="col-start-2 truncate">{option.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
      <FieldMessages id={id} description={description} error={error} />
    </div>
  );
}

function CredentialField({
  field,
  id,
  label,
  description,
  error,
  credential,
  disabled,
  readOnly,
  resolveText,
  onCredentialChange,
}: {
  field: SchemaFieldDefinition;
  id: string;
  label: string;
  description?: string;
  error?: string;
  credential: SchemaCredentialDraft;
  disabled: boolean;
  readOnly: boolean;
  resolveText: SchemaTextResolver;
  onCredentialChange?: (slotId: string, credential: SchemaCredentialDraft) => void;
}) {
  if (field.control.kind !== "credential-slot") {
    return null;
  }
  const slotId = field.control.spec.slotId;
  const editable = !disabled && !readOnly && Boolean(onCredentialChange);
  const action = credential.action;
  const actionOptions: SelectOption[] = [
    { value: "keep", label: resolveText(undefined, "Keep stored credential") },
    { value: "replace", label: resolveText(undefined, "Replace credential") },
    { value: "clear", label: resolveText(undefined, "Clear credential") },
  ];

  return (
    <div className="flex flex-col gap-2">
      <span className={fieldLabelClassName}>{label}</span>
      <p className={fieldDescriptionClassName} role="status">
        {credential.hasCredential
          ? resolveText(undefined, "Credential stored")
          : resolveText(undefined, "No credential stored")}
      </p>
      {description ? (
        <p id={descriptionId(id)} className={fieldDescriptionClassName}>
          {description}
        </p>
      ) : null}
      <SchemaSelect
        id={`${id}-action`}
        label={resolveText(undefined, "Credential action")}
        value={action}
        options={actionOptions}
        disabled={!editable}
        onValueChange={(value) => {
          if (value !== "keep" && value !== "replace" && value !== "clear") {
            return;
          }
          const nextAction = value as SchemaCredentialAction;
          onCredentialChange?.(slotId, {
            ...credential,
            action: nextAction,
            value: nextAction === "replace" ? credential.value : "",
          });
        }}
      />
      {action === "replace" ? (
        <div className="flex flex-col gap-1">
          <label className={fieldLabelClassName} htmlFor={`${id}-replacement`}>
            {resolveText(undefined, "Replacement credential")}
          </label>
          <textarea
            id={`${id}-replacement`}
            autoComplete="off"
            spellCheck={false}
            className={credentialInputClassName}
            value={credential.value}
            disabled={!editable}
            aria-describedby={describedBy(id, description, error)}
            aria-invalid={Boolean(error) || undefined}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onCredentialChange?.(slotId, {
                ...credential,
                action: value.trim() ? "replace" : "keep",
                value,
              });
            }}
          />
        </div>
      ) : null}
      {action === "clear" ? <p className={fieldDescriptionClassName}>Credential will be cleared on save.</p> : null}
      {error ? (
        <p id={errorId(id)} className={fieldErrorClassName} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SchemaField({
  field,
  value,
  credential = { action: "keep", value: "", hasCredential: false },
  idPrefix,
  disabled = false,
  readOnly = false,
  error,
  resolveText,
  resolveOptions,
  onValueChange,
  onCredentialChange,
}: SchemaFieldProps) {
  const id = `${idPrefix}-${field.id}`;
  const label = resolveText(field.labelKey, field.labelFallback ?? field.id);
  const description =
    field.descriptionKey || field.descriptionFallback
      ? resolveText(field.descriptionKey, field.descriptionFallback)
      : undefined;
  const editable = !disabled && !readOnly && Boolean(onValueChange);
  const ariaDescribedBy = describedBy(id, description, error);

  switch (field.control.kind) {
    case "string":
      return (
        <div className="flex flex-col gap-1">
          <label className={fieldLabelClassName} htmlFor={id}>
            {label}
          </label>
          <Input
            id={id}
            autoComplete="off"
            spellCheck={false}
            className={inputClassName}
            value={stringValue(value)}
            maxLength={field.control.spec.maxLength}
            disabled={!editable}
            readOnly={readOnly}
            aria-describedby={ariaDescribedBy}
            aria-invalid={Boolean(error) || undefined}
            onChange={(event) => onValueChange?.(field.id, event.currentTarget.value)}
          />
          <FieldMessages id={id} description={description} error={error} />
        </div>
      );
    case "multiline-string":
      return (
        <div className="flex flex-col gap-1">
          <label className={fieldLabelClassName} htmlFor={id}>
            {label}
          </label>
          <textarea
            id={id}
            autoComplete="off"
            spellCheck={false}
            className={multilineInputClassName}
            value={stringValue(value)}
            maxLength={field.control.spec.maxLength}
            disabled={!editable}
            readOnly={readOnly}
            aria-describedby={ariaDescribedBy}
            aria-invalid={Boolean(error) || undefined}
            onChange={(event) => onValueChange?.(field.id, event.currentTarget.value)}
          />
          <FieldMessages id={id} description={description} error={error} />
        </div>
      );
    case "number":
      return (
        <div className="flex flex-col gap-1">
          <label className={fieldLabelClassName} htmlFor={id}>
            {label}
          </label>
          <NumberField.Root
            id={id}
            value={numberValue(value)}
            min={field.control.spec.min}
            max={field.control.spec.max}
            step={field.control.spec.step}
            disabled={!editable}
            readOnly={readOnly}
            onValueChange={(next) => {
              if (next == null || !Number.isFinite(next)) {
                onValueChange?.(field.id, undefined);
                return;
              }
              onValueChange?.(field.id, next);
            }}
          >
            <NumberField.Group className="flex">
              <NumberField.Decrement
                className={cn(stepperButtonClassName, numberDecrementClassName)}
                aria-label={`Decrease ${label}`}
              >
                <IconMaterialSymbolsLightRemove className="size-4" aria-hidden />
              </NumberField.Decrement>
              <NumberField.Input
                className={numberInputClassName}
                aria-describedby={ariaDescribedBy}
                aria-invalid={Boolean(error) || undefined}
              />
              <NumberField.Increment
                className={cn(stepperButtonClassName, numberIncrementClassName)}
                aria-label={`Increase ${label}`}
              >
                <IconMaterialSymbolsLightAdd className="size-4" aria-hidden />
              </NumberField.Increment>
            </NumberField.Group>
          </NumberField.Root>
          <FieldMessages id={id} description={description} error={error} />
        </div>
      );
    case "boolean":
      return (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-body-tight text-on-surface" htmlFor={id}>
            <Checkbox.Root
              id={id}
              checked={value === true}
              disabled={!editable}
              readOnly={readOnly}
              className={checkboxClassName}
              aria-describedby={ariaDescribedBy}
              aria-invalid={Boolean(error) || undefined}
              onCheckedChange={(checked) => onValueChange?.(field.id, checked)}
            >
              <Checkbox.Indicator className={checkboxIndicatorClassName}>
                <IconMaterialSymbolsLightCheck className="size-3.5" aria-hidden />
              </Checkbox.Indicator>
            </Checkbox.Root>
            <span>{label}</span>
          </label>
          <FieldMessages id={id} description={description} error={error} />
        </div>
      );
    case "enum":
      return (
        <SchemaSelect
          id={id}
          label={label}
          description={description}
          error={error}
          value={stringValue(value)}
          options={optionList(field.control.spec.source, resolveOptions, resolveText)}
          disabled={!editable}
          onValueChange={(next) => onValueChange?.(field.id, next || undefined)}
        />
      );
    case "multi-enum": {
      const multiEnumSpec = field.control.spec;
      const options = optionList(multiEnumSpec.source, resolveOptions, resolveText);
      const selectedValues = stringArrayValue(value);
      return (
        <div className="flex flex-col gap-2">
          <Fieldset.Root className="flex flex-col gap-2">
            <Fieldset.Legend className={fieldLabelClassName}>{label}</Fieldset.Legend>
            {description ? (
              <p id={descriptionId(id)} className={fieldDescriptionClassName}>
                {description}
              </p>
            ) : null}
            <div className={multiEnumGridClassName}>
              {options.map((option) => {
                const checked = selectedValues.includes(option.value);
                const atLimit = !checked && selectedValues.length >= multiEnumSpec.maxSelected;
                return (
                  <label
                    key={option.value}
                    className={cn(multiEnumOptionClassName, !editable || atLimit ? "opacity-60" : undefined)}
                  >
                    <Checkbox.Root
                      checked={checked}
                      disabled={!editable || atLimit}
                      readOnly={readOnly}
                      className={checkboxClassName}
                      aria-describedby={ariaDescribedBy}
                      aria-invalid={Boolean(error) || undefined}
                      onCheckedChange={(next) => {
                        if (next === checked) {
                          return;
                        }
                        if (!next && checked) {
                          onValueChange?.(
                            field.id,
                            selectedValues.filter((selected) => selected !== option.value),
                          );
                          return;
                        }
                        if (next && !atLimit) {
                          onValueChange?.(field.id, [...selectedValues, option.value]);
                        }
                      }}
                    >
                      <Checkbox.Indicator className={checkboxIndicatorClassName}>
                        <IconMaterialSymbolsLightCheck className="size-3.5" aria-hidden />
                      </Checkbox.Indicator>
                    </Checkbox.Root>
                    <span className="min-w-0 truncate">{option.label}</span>
                  </label>
                );
              })}
            </div>
          </Fieldset.Root>
          {error ? (
            <p id={errorId(id)} className={fieldErrorClassName} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      );
    }
    case "credential-slot":
      return (
        <CredentialField
          field={field}
          id={id}
          label={label}
          description={description}
          error={error}
          credential={credential}
          disabled={disabled}
          readOnly={readOnly}
          resolveText={resolveText}
          onCredentialChange={onCredentialChange}
        />
      );
  }
}
