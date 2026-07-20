// ABOUTME: Google-style borderless language tab bar for the translate page.
// ABOUTME: Fixed-position tabs (max 3), centered swap, and a search-more picker.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Button } from "@base-ui/react/button";
import { Combobox } from "@base-ui/react/combobox";
import { useTranslation } from "react-i18next";
import IconClarityAngleLine from "~icons/clarity/angle-line";
import IconMaterialSymbolsLightArrowBack from "~icons/material-symbols-light/arrow-back";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightSwapHoriz from "~icons/material-symbols-light/swap-horiz";
import { iconButtonCircleLargeClassName, iconButtonClassName } from "../../components/ui";
import { cn } from "../../lib/cn";
import { AUTO_LANGUAGE, type LanguageId, type SelectableLanguageId, type SourceLanguageId } from "./-languages";
import { AUTO_PIN_FIRST, recordLanguageUse, resolveOppositeOnConflict, visibleLanguageTabs } from "./-recentLanguages";

export type LanguageOption = {
  id: SelectableLanguageId;
  label: string;
};

export type LanguageChipBarProps = {
  sourceLang: SourceLanguageId;
  targetLang: SelectableLanguageId;
  /** Per-workspace used concrete source languages (excludes auto). */
  usedSourceLangs: readonly LanguageId[];
  /** Per-workspace used concrete target languages (excludes auto). */
  usedTargetLangs: readonly LanguageId[];
  sourceOptions: LanguageOption[];
  targetOptions: LanguageOption[];
  disabled?: boolean;
  swapDisabled?: boolean;
  /** Detected concrete language label when source is auto (shown on the Auto tab). */
  detectedLanguageLabel?: string | null;
  /**
   * Size/position bounds for the language more-picker popup (typically the source/target
   * panes grid). Popup width matches the element; max height does not exceed it.
   */
  popupBoundsRef?: RefObject<HTMLElement | null>;
  onSourceChange: (value: SourceLanguageId) => void;
  onTargetChange: (value: SelectableLanguageId) => void;
  onUsedLangsChange: (next: { source: LanguageId[]; target: LanguageId[] }) => void;
  onSwap: () => void;
};

const tabBaseClassName =
  "relative shrink-0 cursor-default rounded-none px-2 py-1.5 text-body-tight select-none transition-colors hover:bg-surface-2 active:bg-surface-3 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface disabled:cursor-default disabled:bg-transparent disabled:text-disabled";

const tabIdleClassName = "text-on-surface-variant hover:text-on-surface";

const tabSelectedClassName = "font-medium text-primary";

/** Sliding selected indicator under the active tab (left + width). */
const TAB_INDICATOR_TRANSITION_MS = 200;
const tabIndicatorClassName =
  "pointer-events-none absolute bottom-0 h-0.5 bg-primary ease-out motion-reduce:transition-none";

const moreTriggerClassName =
  "group inline-flex size-7 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-neutral hover:bg-surface-2 hover:text-on-surface focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-disabled:text-disabled data-popup-open:bg-surface-2 data-popup-open:text-on-surface";

/** Adaptive grid: column count = clamp(floor(width / minCol), min, max). */
const LANGUAGE_GRID_MIN_COLUMN_PX = 144;
const LANGUAGE_GRID_MIN_COLUMNS = 1;
const LANGUAGE_GRID_MAX_COLUMNS = 6;
const LANGUAGE_GRID_FALLBACK_COLUMNS = 3;
/**
 * Non-list chrome inside the popup (box-sizing: border-box):
 * popup borders (2) + search header (32) + header bottom border (1).
 */
const LANGUAGE_POPUP_CHROME_PX = 35;

const morePopupClassName =
  "max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-none border border-line bg-surface text-on-surface shadow-frame transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0";

const moreSearchHeaderClassName = "flex h-control-height items-center gap-0.5 border-b border-line px-1";

const moreSearchInputClassName =
  "h-full min-w-0 flex-1 border-0 bg-transparent px-1 text-body-tight font-normal text-on-surface placeholder:text-neutral focus:outline-none disabled:text-disabled";

const moreListClassName = "overflow-y-auto overscroll-contain px-2 py-2 scroll-py-2 outline-0 data-empty:p-0";

// Soft selected/hover (Google-style); avoid inverted black highlight on a dense grid.
const moreItemClassName =
  "grid min-w-0 cursor-default grid-cols-[1rem_minmax(0,1fr)] items-center gap-1.5 rounded-sm px-2 py-1.5 text-body-tight text-on-surface outline-hidden select-none data-selected:bg-surface-2 data-selected:font-medium data-selected:text-primary data-highlighted:bg-surface-2 data-highlighted:text-on-surface data-selected:data-highlighted:bg-surface-3 data-disabled:text-disabled";

type PopupBoundsSize = {
  width: number;
  height: number;
};

function columnsForWidth(width: number): number {
  if (width <= 0) return LANGUAGE_GRID_FALLBACK_COLUMNS;
  return Math.max(
    LANGUAGE_GRID_MIN_COLUMNS,
    Math.min(LANGUAGE_GRID_MAX_COLUMNS, Math.floor(width / LANGUAGE_GRID_MIN_COLUMN_PX)),
  );
}

/**
 * Zero-height strip at the top of `element` so the popup opens over that box.
 * Full width is kept so `align="center"` pins the popup to the container midpoint.
 */
function topEdgeAnchor(element: HTMLElement) {
  return {
    contextElement: element,
    getBoundingClientRect() {
      const rect = element.getBoundingClientRect();
      return new DOMRect(rect.left, rect.top, rect.width, 0);
    },
  };
}

type ComboboxOption = {
  value: string;
  label: string;
};

function isOptionEqual(a: ComboboxOption | null | undefined, b: ComboboxOption | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  return a.value === b.value;
}

function chunkOptions<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

/** Grid list body: chunk filtered items into keyboard-navigable rows. */
function LanguageMoreGridList({
  emptyText,
  columnCount,
  maxListHeightPx,
}: {
  emptyText: string;
  columnCount: number;
  /** Cap only — list height still follows row count when shorter. */
  maxListHeightPx?: number;
}) {
  const filteredItems = Combobox.useFilteredItems<ComboboxOption>();
  const rows = useMemo(() => chunkOptions(filteredItems, columnCount), [filteredItems, columnCount]);
  const rowStyle = useMemo<CSSProperties>(
    () => ({
      gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
    }),
    [columnCount],
  );
  const listStyle = useMemo<CSSProperties | undefined>(() => {
    if (maxListHeightPx == null || maxListHeightPx <= 0) return undefined;
    return { maxHeight: maxListHeightPx };
  }, [maxListHeightPx]);

  return (
    <>
      <Combobox.Empty>
        <div className="px-3 py-6 text-center text-body-tight text-neutral">{emptyText}</div>
      </Combobox.Empty>
      <Combobox.List className={moreListClassName} style={listStyle}>
        {rows.map((row, rowIndex) => (
          <Combobox.Row key={rowIndex} className="grid gap-x-1" style={rowStyle}>
            {row.map((item) => (
              <Combobox.Item key={item.value} value={item} className={moreItemClassName}>
                <Combobox.ItemIndicator className="col-start-1">
                  <IconMaterialSymbolsLightCheck className="pointer-events-none size-4 shrink-0" />
                </Combobox.ItemIndicator>
                <span className="col-start-2 truncate">{item.label}</span>
              </Combobox.Item>
            ))}
          </Combobox.Row>
        ))}
      </Combobox.List>
    </>
  );
}

function LanguageMorePicker({
  value,
  options,
  disabled,
  ariaLabel,
  searchPlaceholder,
  closeAriaLabel,
  emptyText,
  popupBoundsRef,
  onValueChange,
}: {
  value: SelectableLanguageId;
  options: LanguageOption[];
  disabled?: boolean;
  ariaLabel: string;
  searchPlaceholder: string;
  closeAriaLabel: string;
  emptyText: string;
  popupBoundsRef?: RefObject<HTMLElement | null>;
  onValueChange: (value: SelectableLanguageId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [bounds, setBounds] = useState<PopupBoundsSize | null>(null);
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

  const measureBounds = useCallback(() => {
    const element = popupBoundsRef?.current;
    if (!element) {
      setBounds(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    setBounds((current) => {
      if (current && current.width === width && current.height === height) {
        return current;
      }
      return { width, height };
    });
  }, [popupBoundsRef]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    measureBounds();
    const element = popupBoundsRef?.current;
    if (!element) {
      return;
    }
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            measureBounds();
          });
    observer?.observe(element);
    window.addEventListener("resize", measureBounds);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureBounds);
    };
  }, [open, measureBounds, popupBoundsRef]);

  const columnCount = bounds ? columnsForWidth(bounds.width) : LANGUAGE_GRID_FALLBACK_COLUMNS;
  const popupStyle = useMemo<CSSProperties | undefined>(() => {
    if (!bounds) return undefined;
    // Width matches the bounds element; height stays content-sized (row count).
    return { width: bounds.width };
  }, [bounds]);
  const maxListHeightPx = useMemo(() => {
    if (!bounds) return undefined;
    return Math.max(0, bounds.height - LANGUAGE_POPUP_CHROME_PX);
  }, [bounds]);

  const positionAnchor = useCallback(() => {
    const element = popupBoundsRef?.current;
    return element ? topEdgeAnchor(element) : null;
  }, [popupBoundsRef]);

  return (
    <Combobox.Root
      value={selected}
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          measureBounds();
        }
        setOpen(nextOpen);
      }}
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
      grid
    >
      <Combobox.Trigger className={moreTriggerClassName} aria-label={ariaLabel}>
        <span className="sr-only">
          <Combobox.Value />
        </span>
        <Combobox.Icon
          className="
            inline-flex size-4 shrink-0 rotate-180 items-center justify-center transition-transform duration-200
            ease-out
            group-data-popup-open:rotate-0
          "
        >
          <IconClarityAngleLine className="pointer-events-none size-4" />
        </Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          className="z-50 outline-hidden select-none"
          anchor={popupBoundsRef ? positionAnchor : undefined}
          align="center"
          side="bottom"
          sideOffset={0}
          collisionPadding={0}
          collisionAvoidance={{
            side: "none",
            align: "none",
          }}
          positionMethod="fixed"
        >
          <Combobox.Popup className={morePopupClassName} style={popupStyle} aria-label={ariaLabel}>
            <div className={moreSearchHeaderClassName}>
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={closeAriaLabel}
                onClick={() => {
                  setOpen(false);
                }}
              >
                <IconMaterialSymbolsLightArrowBack className="size-5" aria-hidden />
              </Button>
              <Combobox.Input
                placeholder={searchPlaceholder}
                className={moreSearchInputClassName}
                aria-label={searchPlaceholder}
              />
            </div>
            <LanguageMoreGridList emptyText={emptyText} columnCount={columnCount} maxListHeightPx={maxListHeightPx} />
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

type TabIndicatorBox = {
  left: number;
  width: number;
  ready: boolean;
};

function LanguageTabRow({
  value,
  options,
  tabIds,
  disabled,
  moreAriaLabel,
  searchPlaceholder,
  closeAriaLabel,
  emptyText,
  popupBoundsRef,
  autoDetectedLabel,
  onSelectTab,
  onPickFromMore,
}: {
  value: SelectableLanguageId;
  options: LanguageOption[];
  tabIds: readonly SelectableLanguageId[];
  disabled?: boolean;
  moreAriaLabel: string;
  searchPlaceholder: string;
  closeAriaLabel: string;
  emptyText: string;
  popupBoundsRef?: RefObject<HTMLElement | null>;
  /** When set and value is auto, the auto tab shows this Google-style label. */
  autoDetectedLabel?: string | null;
  /** Click an existing tab — selection only, no reorder. */
  onSelectTab: (value: SelectableLanguageId) => void;
  /** Choose from full list — may admit a new tab. */
  onPickFromMore: (value: SelectableLanguageId) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  /** Skip the first paint so the bar does not slide in from (0,0). */
  const hasPlacedIndicator = useRef(false);
  const [indicator, setIndicator] = useState<TabIndicatorBox>({
    left: 0,
    width: 0,
    ready: false,
  });
  const [animateIndicator, setAnimateIndicator] = useState(false);

  const labelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of options) {
      map.set(option.id, option.label);
    }
    return map;
  }, [options]);

  const measureIndicator = useCallback(() => {
    const list = listRef.current;
    const tab = tabRefs.current.get(value);
    if (!list || !tab) {
      setIndicator((current) => (current.ready ? { left: 0, width: 0, ready: false } : current));
      return;
    }
    const listRect = list.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const left = tabRect.left - listRect.left + list.scrollLeft;
    const width = tabRect.width;
    setIndicator((current) => {
      if (current.ready && current.left === left && current.width === width) {
        return current;
      }
      return { left, width, ready: true };
    });
    if (!hasPlacedIndicator.current) {
      hasPlacedIndicator.current = true;
      // Enable transitions only after the first real placement.
      requestAnimationFrame(() => {
        setAnimateIndicator(true);
      });
    }
  }, [value]);

  useLayoutEffect(() => {
    measureIndicator();
  }, [measureIndicator, tabIds, autoDetectedLabel]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      measureIndicator();
    });
    observer.observe(list);
    for (const tab of tabRefs.current.values()) {
      observer.observe(tab);
    }
    return () => {
      observer.disconnect();
    };
  }, [measureIndicator, tabIds, autoDetectedLabel]);

  return (
    <div
      ref={listRef}
      className="relative flex min-w-0 flex-nowrap items-center"
      role="tablist"
      aria-label={moreAriaLabel}
    >
      {tabIds.map((id) => {
        const selected = id === value;
        const baseLabel = labelById.get(id) ?? id;
        const label = id === AUTO_LANGUAGE && selected && autoDetectedLabel ? autoDetectedLabel : baseLabel;
        return (
          <button
            key={id}
            ref={(node) => {
              if (node) {
                tabRefs.current.set(id, node);
              } else {
                tabRefs.current.delete(id);
              }
            }}
            type="button"
            role="tab"
            disabled={disabled}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={cn(tabBaseClassName, selected ? tabSelectedClassName : tabIdleClassName)}
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
      <span
        aria-hidden
        className={tabIndicatorClassName}
        style={{
          left: indicator.left,
          width: indicator.width,
          opacity: indicator.ready ? 1 : 0,
          transitionProperty: animateIndicator ? "left, width, opacity" : "opacity",
          transitionDuration: `${TAB_INDICATOR_TRANSITION_MS}ms`,
        }}
      />
      <LanguageMorePicker
        value={value}
        options={options}
        disabled={disabled}
        ariaLabel={moreAriaLabel}
        searchPlaceholder={searchPlaceholder}
        closeAriaLabel={closeAriaLabel}
        emptyText={emptyText}
        popupBoundsRef={popupBoundsRef}
        onValueChange={onPickFromMore}
      />
    </div>
  );
}

export function LanguageChipBar({
  sourceLang,
  targetLang,
  usedSourceLangs,
  usedTargetLangs,
  sourceOptions,
  targetOptions,
  disabled = false,
  swapDisabled = false,
  detectedLanguageLabel = null,
  popupBoundsRef,
  onSourceChange,
  onTargetChange,
  onUsedLangsChange,
  onSwap,
}: LanguageChipBarProps) {
  const { t } = useTranslation();

  const sourceTabs = visibleLanguageTabs(usedSourceLangs, sourceLang, { pinFirst: AUTO_PIN_FIRST });
  const targetTabs = visibleLanguageTabs(usedTargetLangs, targetLang, { pinFirst: AUTO_PIN_FIRST });

  const autoDetectedLabel =
    detectedLanguageLabel != null && detectedLanguageLabel !== ""
      ? t("translate.autoDetected", { language: detectedLanguageLabel })
      : null;

  /**
   * User actually picked a source language (tab or more menu):
   * record use on this workspace so the tab stays, then resolve target conflict → Auto.
   */
  function handleSourceSelect(value: SelectableLanguageId) {
    const nextSourceUsed = recordLanguageUse(usedSourceLangs, value, sourceLang);
    const nextTargetLang = resolveOppositeOnConflict(value, targetLang);
    const nextTargetUsed =
      nextTargetLang !== targetLang
        ? recordLanguageUse(usedTargetLangs, nextTargetLang, targetLang)
        : [...usedTargetLangs];

    onUsedLangsChange({ source: nextSourceUsed, target: nextTargetUsed });
    onSourceChange(value as SourceLanguageId);
    if (nextTargetLang !== targetLang) {
      onTargetChange(nextTargetLang);
    }
  }

  /** Same as source: grow-on-use + conflict flips source to Auto when needed. */
  function handleTargetSelect(value: SelectableLanguageId) {
    const nextTargetUsed = recordLanguageUse(usedTargetLangs, value, targetLang);
    const nextSourceLang = resolveOppositeOnConflict(value, sourceLang);
    const nextSourceUsed =
      nextSourceLang !== sourceLang
        ? recordLanguageUse(usedSourceLangs, nextSourceLang, sourceLang)
        : [...usedSourceLangs];

    onUsedLangsChange({ source: nextSourceUsed, target: nextTargetUsed });
    onTargetChange(value);
    if (nextSourceLang !== sourceLang) {
      onSourceChange(nextSourceLang as SourceLanguageId);
    }
  }

  // Single-row flex strip (Google Translate language bar):
  // [pr-1][Source Tabs][space][pr-1][<->][pl-1][pr-1][Target Tabs][space]
  // Equal flex-1 halves keep tabs aligned with the source/target panes below.
  return (
    <div className="flex w-full min-w-0 shrink-0 items-center">
      <div className="flex min-w-0 flex-1 items-center pl-1">
        <LanguageTabRow
          value={sourceLang}
          options={sourceOptions}
          tabIds={sourceTabs}
          disabled={disabled}
          moreAriaLabel={t("translate.sourceLanguage")}
          searchPlaceholder={t("translate.searchLanguages")}
          closeAriaLabel={t("common.close")}
          emptyText={t("common.noMatches")}
          popupBoundsRef={popupBoundsRef}
          autoDetectedLabel={autoDetectedLabel}
          onSelectTab={handleSourceSelect}
          onPickFromMore={handleSourceSelect}
        />
        <div className="min-w-0 flex-1 basis-0" aria-hidden />
      </div>

      <div className="flex shrink-0 items-center px-1">
        <Button
          type="button"
          className={iconButtonCircleLargeClassName}
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
          searchPlaceholder={t("translate.searchLanguages")}
          closeAriaLabel={t("common.close")}
          emptyText={t("common.noMatches")}
          popupBoundsRef={popupBoundsRef}
          onSelectTab={handleTargetSelect}
          onPickFromMore={handleTargetSelect}
        />
        <div className="min-w-0 flex-1 basis-0" aria-hidden />
      </div>
    </div>
  );
}
