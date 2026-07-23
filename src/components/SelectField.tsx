// ABOUTME: Styled Base UI Select wrapper matching the project's outline/frame design tokens.
// ABOUTME: Supports compact variant, disabled options, orphaned items, and placeholder text.

import { useMemo, type ReactNode } from "react";
import { Select } from "@base-ui/react/select";
import IconClarityAngleLine from "~icons/clarity/angle-line";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SelectFieldProps = {
  id?: string;
  /** Extra trigger classes merged onto the base outline styles (does not replace layout). */
  className?: string;
  value: string;
  onValueChange: (value: string | null) => void;
  options: SelectOption[];
  disabled?: boolean;
  placeholder?: string;
  /** Extra items kept selectable when absent from the main options list (e.g. orphaned ids). */
  extraOptions?: SelectOption[];
  /** Omit w-full for inline / toolbar selects. */
  compact?: boolean;
  /** Trailing trigger icon; defaults to angle-line with open-state rotation. */
  icon?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

const triggerBase =
  "flex h-control-height items-center justify-between gap-2 select-none rounded-none border border-line bg-surface pl-2 pr-1 text-body-tight font-normal text-on-surface hover:not-data-disabled:bg-surface-2 data-popup-open:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-disabled:border-disabled data-disabled:text-disabled";

const popupClassName =
  "min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) border border-line bg-surface text-on-surface shadow-frame transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0";

const itemClassName =
  "grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 py-1.5 pr-3 pl-2.5 text-body-tight outline-hidden select-none data-highlighted:bg-on-surface data-highlighted:text-surface data-disabled:text-disabled";

export function SelectField({
  id,
  className,
  value,
  onValueChange,
  options,
  disabled = false,
  placeholder,
  extraOptions,
  compact = false,
  icon,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: SelectFieldProps) {
  const allOptions = useMemo(() => {
    if (!extraOptions || extraOptions.length === 0) return options;
    const existingValues = new Set(options.map((option) => option.value));
    const uniqueExtras = extraOptions.filter((option) => !existingValues.has(option.value));
    return [...options, ...uniqueExtras];
  }, [options, extraOptions]);

  // Always keep triggerBase (flex + icon alignment); className only adds/overrides extras.
  const triggerClassName = [compact ? triggerBase : `${triggerBase} w-full`, className].filter(Boolean).join(" ");

  return (
    <Select.Root value={value} onValueChange={onValueChange} items={allOptions} disabled={disabled}>
      <Select.Trigger id={id} className={triggerClassName} aria-label={ariaLabel} aria-labelledby={ariaLabelledby}>
        <Select.Value
          placeholder={placeholder}
          className="
            min-w-0 flex-1 truncate text-left
            data-placeholder:text-neutral
          "
        />
        <Select.Icon
          className={
            icon
              ? "inline-flex size-4 shrink-0 items-center justify-center"
              : `
            inline-flex size-4 shrink-0 rotate-180 items-center justify-center transition-transform duration-200
            ease-out
            data-popup-open:rotate-0
          `
          }
        >
          {icon ?? <IconClarityAngleLine className="pointer-events-none size-4" />}
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          className="z-50 outline-hidden select-none"
          alignItemWithTrigger={false}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          positionMethod="fixed"
        >
          <Select.Popup className={popupClassName}>
            <Select.List
              className="
                max-h-[min(22.5rem,var(--available-height))] scroll-py-1 overflow-y-auto overscroll-contain py-1
              "
            >
              {allOptions.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={itemClassName}
                >
                  <Select.ItemIndicator className="col-start-1">
                    <IconMaterialSymbolsLightCheck className="pointer-events-none size-4 shrink-0" />
                  </Select.ItemIndicator>
                  <Select.ItemText className="col-start-2 truncate">{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
