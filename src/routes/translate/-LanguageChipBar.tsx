// ABOUTME: Google-style borderless language tab bar for the translate page.
// ABOUTME: Fixed-position tabs (max 3), centered swap, and a search-more picker.
import { useCallback, useMemo, useState } from "react";
import { Button } from "@base-ui/react/button";
import { Combobox } from "@base-ui/react/combobox";
import { useTranslation } from "react-i18next";
import IconClarityAngleLine from "~icons/clarity/angle-line";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightSwapHoriz from "~icons/material-symbols-light/swap-horiz";
import { iconButtonClassName } from "../../components/ui";
import { cn } from "../../lib/cn";
import { AUTO_LANGUAGE, type SelectableLanguageId, type SourceLanguageId } from "./-languages";
import {
  SOURCE_PIN_FIRST,
  admitLanguageToTabs,
  getRecentLanguagesStore,
  setRecentLanguagesStore,
  visibleLanguageTabs,
  type RecentLanguagesStore,
} from "./-recentLanguages";

export type LanguageOption = {
  id: SelectableLanguageId;
  label: string;
};

export type LanguageChipBarProps = {
  sourceLang: SourceLanguageId;
  targetLang: SelectableLanguageId;
  sourceOptions: LanguageOption[];
  targetOptions: LanguageOption[];
  disabled?: boolean;
  swapDisabled?: boolean;
  /** Detected concrete language label when source is auto (shown on the Auto tab). */
  detectedLanguageLabel?: string | null;
  onSourceChange: (value: SourceLanguageId) => void;
  onTargetChange: (value: SelectableLanguageId) => void;
  onSwap: () => void;
};

const tabBaseClassName =
  "relative shrink-0 cursor-default rounded-none px-2 py-1.5 text-body-tight select-none transition-colors hover:bg-surface-2 active:bg-surface-3 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface disabled:cursor-default disabled:bg-transparent disabled:text-disabled";

const tabIdleClassName = "text-on-surface-variant hover:text-on-surface";

/** Full-width selected bar under the whole tab hit area (not just the label). */
const tabActiveClassName =
  "font-medium text-primary after:absolute after:right-0 after:bottom-0 after:left-0 after:h-0.5 after:bg-primary";

const moreTriggerClassName =
  "group inline-flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-neutral hover:bg-surface-2 hover:text-on-surface focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-disabled:text-disabled data-popup-open:bg-surface-2 data-popup-open:text-on-surface";

// Fixed min width: caret-only trigger would otherwise collapse the popup.
const morePopupClassName =
  "[--input-container-height:var(--spacing-control-height)] min-w-56 max-w-(--available-width) origin-(--transform-origin) border border-line bg-surface text-on-surface shadow-frame transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0";

const moreSearchInputClassName =
  "h-control-height w-full border-0 border-b border-line bg-surface px-2 text-body-tight font-normal text-on-surface placeholder:text-neutral focus:outline-none disabled:text-disabled";

const moreListClassName =
  "max-h-[min(22.5rem,calc(var(--available-height)-var(--input-container-height)-2px))] overflow-y-auto overscroll-contain py-1 scroll-py-1 outline-0 data-empty:p-0";

const moreItemClassName =
  "grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 py-1.5 pr-3 pl-2.5 text-body-tight outline-hidden select-none data-highlighted:bg-on-surface data-highlighted:text-surface data-disabled:text-disabled";

type ComboboxOption = {
  value: string;
  label: string;
};

function isOptionEqual(a: ComboboxOption | null | undefined, b: ComboboxOption | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  return a.value === b.value;
}

function LanguageMorePicker({
  value,
  options,
  disabled,
  ariaLabel,
  emptyText,
  onValueChange,
}: {
  value: SelectableLanguageId;
  options: LanguageOption[];
  disabled?: boolean;
  ariaLabel: string;
  emptyText: string;
  onValueChange: (value: SelectableLanguageId) => void;
}) {
  const comboboxOptions = useMemo<ComboboxOption[]>(
    () => options.map((option) => ({ value: option.id, label: option.label })),
    [options],
  );
  const selected = useMemo(
    () => comboboxOptions.find((option) => option.value === value) ?? null,
    [comboboxOptions, value],
  );
  const filter = Combobox.useFilter({ value: selected });
  const filterItem = useCallback(
    (item: ComboboxOption, query: string) => {
      if (filter.contains(item, query)) return true;
      if (!query) return true;
      return filter.contains(item.value, query);
    },
    [filter],
  );

  return (
    <Combobox.Root
      value={selected}
      onValueChange={(next) => {
        if (next?.value && next.value !== value) {
          onValueChange(next.value as SelectableLanguageId);
        }
      }}
      items={comboboxOptions}
      disabled={disabled}
      filter={filterItem}
      isItemEqualToValue={isOptionEqual}
      autoHighlight
    >
      <Combobox.Trigger className={moreTriggerClassName} aria-label={ariaLabel}>
        <span className="sr-only">
          <Combobox.Value />
        </span>
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
          <Combobox.Popup className={morePopupClassName}>
            <Combobox.Input placeholder={ariaLabel} className={moreSearchInputClassName} aria-label={ariaLabel} />
            <Combobox.Empty>
              <div className="py-3 pr-3 pl-2.5 text-body-tight text-neutral">{emptyText}</div>
            </Combobox.Empty>
            <Combobox.List className={moreListClassName}>
              {(item: ComboboxOption) => (
                <Combobox.Item key={item.value} value={item} className={moreItemClassName}>
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

function LanguageTabRow({
  value,
  options,
  tabIds,
  disabled,
  moreAriaLabel,
  emptyText,
  autoDetectedLabel,
  onSelectTab,
  onPickFromMore,
}: {
  value: SelectableLanguageId;
  options: LanguageOption[];
  tabIds: readonly SelectableLanguageId[];
  disabled?: boolean;
  moreAriaLabel: string;
  emptyText: string;
  /** When set and value is auto, the auto tab shows this Google-style label. */
  autoDetectedLabel?: string | null;
  /** Click an existing tab — selection only, no reorder. */
  onSelectTab: (value: SelectableLanguageId) => void;
  /** Choose from full list — may admit a new tab. */
  onPickFromMore: (value: SelectableLanguageId) => void;
}) {
  const labelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of options) {
      map.set(option.id, option.label);
    }
    return map;
  }, [options]);

  return (
    <div className="flex min-w-0 flex-nowrap items-center gap-0.5" role="tablist" aria-label={moreAriaLabel}>
      {tabIds.map((id) => {
        const selected = id === value;
        const baseLabel = labelById.get(id) ?? id;
        const label = id === AUTO_LANGUAGE && selected && autoDetectedLabel ? autoDetectedLabel : baseLabel;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            disabled={disabled}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={cn(tabBaseClassName, selected ? tabActiveClassName : tabIdleClassName)}
            onClick={() => {
              if (!selected) {
                onSelectTab(id);
              }
            }}
          >
            {label}
          </button>
        );
      })}
      <LanguageMorePicker
        value={value}
        options={options}
        disabled={disabled}
        ariaLabel={moreAriaLabel}
        emptyText={emptyText}
        onValueChange={onPickFromMore}
      />
    </div>
  );
}

export function LanguageChipBar({
  sourceLang,
  targetLang,
  sourceOptions,
  targetOptions,
  disabled = false,
  swapDisabled = false,
  detectedLanguageLabel = null,
  onSourceChange,
  onTargetChange,
  onSwap,
}: LanguageChipBarProps) {
  const { t } = useTranslation();
  const [recents, setRecents] = useState<RecentLanguagesStore>(() => getRecentLanguagesStore());

  function commitRecents(next: RecentLanguagesStore) {
    setRecents(next);
    setRecentLanguagesStore(next);
  }

  const sourceTabs = visibleLanguageTabs(recents.source, sourceLang, { pinFirst: SOURCE_PIN_FIRST });
  const targetTabs = visibleLanguageTabs(recents.target, targetLang);

  const autoDetectedLabel =
    detectedLanguageLabel != null && detectedLanguageLabel !== ""
      ? t("translate.autoDetected", { language: detectedLanguageLabel })
      : null;

  /** Tab click: change selection only — strip order stays put. */
  function handleSourceTab(value: SelectableLanguageId) {
    onSourceChange(value as SourceLanguageId);
  }

  function handleTargetTab(value: SelectableLanguageId) {
    onTargetChange(value);
  }

  /** More picker: admit new language into strip when needed, then select. */
  function handleSourceFromMore(value: SelectableLanguageId) {
    commitRecents({
      ...recents,
      source: admitLanguageToTabs(recents.source, value, { pinFirst: SOURCE_PIN_FIRST }),
    });
    onSourceChange(value as SourceLanguageId);
  }

  function handleTargetFromMore(value: SelectableLanguageId) {
    commitRecents({
      ...recents,
      target: admitLanguageToTabs(recents.target, value),
    });
    onTargetChange(value);
  }

  // Single-row flex strip (Google Translate language bar):
  // [pr-1][Source Tabs][space][pr-1][<->][pl-1][pr-1][Target Tabs][space]
  // Equal flex-1 halves keep tabs aligned with the source/target panes below.
  return (
    <div className="flex w-full min-w-0 shrink-0 items-center">
      <div className="flex min-w-0 flex-1 pl-1 items-center">
        <LanguageTabRow
          value={sourceLang}
          options={sourceOptions}
          tabIds={sourceTabs}
          disabled={disabled}
          moreAriaLabel={t("translate.sourceLanguage")}
          emptyText={t("common.noMatches")}
          autoDetectedLabel={autoDetectedLabel}
          onSelectTab={handleSourceTab}
          onPickFromMore={handleSourceFromMore}
        />
        <div className="min-w-0 flex-1 basis-0" aria-hidden />
      </div>

      <div className="flex shrink-0 items-center px-1">
        <Button
          type="button"
          className={iconButtonClassName}
          aria-label={t("translate.swapLanguages")}
          onClick={onSwap}
          disabled={disabled || swapDisabled}
        >
          <IconMaterialSymbolsLightSwapHoriz className="size-5" aria-hidden />
        </Button>
      </div>

      <div className="flex min-w-0 flex-1 items-center pl-1">
        <LanguageTabRow
          value={targetLang}
          options={targetOptions}
          tabIds={targetTabs}
          disabled={disabled}
          moreAriaLabel={t("translate.targetLanguage")}
          emptyText={t("common.noMatches")}
          onSelectTab={handleTargetTab}
          onPickFromMore={handleTargetFromMore}
        />
        <div className="min-w-0 flex-1 basis-0" aria-hidden />
      </div>
    </div>
  );
}
