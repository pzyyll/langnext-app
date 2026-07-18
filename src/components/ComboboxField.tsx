// ABOUTME: Styled Base UI Combobox wrapper with search input inside the popup (popover pattern).
// ABOUTME: Filters options by label and value (locale-aware contains) for type-to-search lists.

import { useCallback, useMemo } from "react";
import { Combobox } from "@base-ui/react/combobox";
import IconClarityAngleLine from "~icons/clarity/angle-line";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";

export type ComboboxOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type ComboboxFieldProps = {
  id?: string;
  /** Extra classes merged onto the trigger (does not replace layout). */
  className?: string;
  value: string;
  onValueChange: (value: string | null) => void;
  options: ComboboxOption[];
  disabled?: boolean;
  placeholder?: string;
  /** Shown when the filter matches no options. */
  emptyText?: string;
  /** Extra items kept selectable when absent from the main options list (e.g. orphaned ids). */
  extraOptions?: ComboboxOption[];
  /** Omit w-full for inline / toolbar comboboxes. */
  compact?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

const triggerBase =
  "group flex h-control-height items-center justify-between gap-2 select-none rounded-none border border-line bg-surface pl-2 pr-1 text-body-tight font-normal text-on-surface data-placeholder:text-neutral hover:not-data-disabled:bg-surface-2 data-popup-open:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-disabled:border-disabled data-disabled:text-disabled";

// Popup is search row + list; --available-height is for the whole popup, so list max-height
// subtracts the fixed search row (control-height) and borders — same pattern as Base UI docs.
const popupClassName =
  "[--input-container-height:var(--spacing-control-height)] min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) border border-line bg-surface text-on-surface shadow-frame transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0";

const searchInputClassName =
  "h-control-height w-full border-0 border-b border-line bg-surface px-2 text-body-tight font-normal text-on-surface placeholder:text-neutral focus:outline-none disabled:text-disabled";

const listClassName =
  "max-h-[min(22.5rem,calc(var(--available-height)-var(--input-container-height)-2px))] overflow-y-auto overscroll-contain py-1 scroll-py-1 outline-0 data-empty:p-0";

const itemClassName =
  "grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 py-1.5 pr-3 pl-2.5 text-body-tight outline-hidden select-none data-highlighted:bg-on-surface data-highlighted:text-surface data-disabled:text-disabled";

function isOptionEqual(a: ComboboxOption | null | undefined, b: ComboboxOption | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  return a.value === b.value;
}

export function ComboboxField({
  id,
  className,
  value,
  onValueChange,
  options,
  disabled = false,
  placeholder,
  emptyText = "No matches",
  extraOptions,
  compact = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: ComboboxFieldProps) {
  const allOptions = useMemo(() => {
    if (!extraOptions || extraOptions.length === 0) return options;
    const existingValues = new Set(options.map((option) => option.value));
    const uniqueExtras = extraOptions.filter((option) => !existingValues.has(option.value));
    return [...options, ...uniqueExtras];
  }, [options, extraOptions]);

  const selected = useMemo(() => allOptions.find((option) => option.value === value) ?? null, [allOptions, value]);

  const filter = Combobox.useFilter({ value: selected });

  // Match display labels and raw ids (e.g. "zh" / "Chinese") with locale-aware contains.
  const filterItem = useCallback(
    (item: ComboboxOption, query: string) => {
      if (filter.contains(item, query)) return true;
      if (!query) return true;
      return filter.contains(item.value, query);
    },
    [filter],
  );

  const triggerClassName = [compact ? `${triggerBase} min-w-32 w-40` : `${triggerBase} w-full`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <Combobox.Root
      value={selected}
      onValueChange={(next) => {
        onValueChange(next?.value ?? null);
      }}
      items={allOptions}
      disabled={disabled}
      filter={filterItem}
      isItemEqualToValue={isOptionEqual}
      autoHighlight
    >
      <Combobox.Trigger id={id} className={triggerClassName} aria-label={ariaLabel} aria-labelledby={ariaLabelledby}>
        <Combobox.Value placeholder={placeholder} />
        <Combobox.Icon className="size-4 shrink-0 rotate-180 transition-transform duration-200 ease-out group-data-popup-open:rotate-0">
          <IconClarityAngleLine className="pointer-events-none" />
        </Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          className="outline-hidden z-50 select-none"
          align="start"
          side="bottom"
          sideOffset={4}
          collisionPadding={8}
          positionMethod="fixed"
        >
          <Combobox.Popup className={popupClassName}>
            <Combobox.Input
              placeholder={placeholder}
              className={searchInputClassName}
              aria-label={ariaLabel}
              aria-labelledby={ariaLabelledby}
            />
            <Combobox.Empty>
              <div className="py-3 pr-3 pl-2.5 text-body-tight text-neutral">{emptyText}</div>
            </Combobox.Empty>
            <Combobox.List className={listClassName}>
              {(item: ComboboxOption) => (
                <Combobox.Item key={item.value} value={item} disabled={item.disabled} className={itemClassName}>
                  <Combobox.ItemIndicator className="col-start-1">
                    <IconMaterialSymbolsLightCheck className="pointer-events-none size-4 shrink-0" />
                  </Combobox.ItemIndicator>
                  <span className="col-start-2 truncate">{item.label}</span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
