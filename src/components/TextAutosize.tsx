// ABOUTME: Stepped-font autosize field and read-only frame with built-in ScrollArea.
// ABOUTME: Grow (quick translate) and fill (main translate source/output) layouts.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "../lib/cn";
import { ScrollArea } from "./ScrollArea";

/**
 * Font steps from dense (small) to sparse (large), matching TextAutosize.vue order.
 * Index grows with available space; starts at the largest when empty.
 */
const FONT_SIZE_STEPS = [
  "text-body-md",
  "text-title-dialog",
  "text-headline-sm",
  "text-headline-md",
  "text-headline-display",
] as const;

type FontSizeStep = (typeof FONT_SIZE_STEPS)[number];

const SMALLEST_FONT_INDEX = 0;
const LARGEST_FONT_INDEX = FONT_SIZE_STEPS.length - 1;

/**
 * Per-row unit for `minRows`, matching Vue `$rootFontSize` (1rem) used by TextAutosize.
 * In grow layout, font scaling tries to keep content within `minRows * MIN_ROW_UNIT_PX` first.
 */
const MIN_ROW_UNIT_PX = 16;

/** Inset when filling the visible shell so an empty field does not overflow. */
const EMPTY_HEIGHT_INSET_PX = 8;

/**
 * Parse a computed length like `"6rem"` / `"96px"` to CSS pixels.
 * Returns 0 for `auto`, `%`, or unparsable values (caller falls back to natural height).
 */
function parseComputedPx(value: string): number {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "auto" || trimmed === "none") {
    return 0;
  }
  const px = Number.parseFloat(trimmed);
  if (!Number.isFinite(px) || px <= 0) {
    return 0;
  }
  // getComputedStyle usually resolves rem/em to px; reject bare percentages.
  if (trimmed.endsWith("%")) {
    return 0;
  }
  return px;
}

/**
 * Hysteresis when deciding whether a larger font still "fits".
 * Avoids border-line oscillation (e.g. 95px ↔ 97px) that thrash layout + window height.
 */
const FONT_FIT_SLACK_PX = 2;

/** Hidden measure node: mirrors content box metrics without affecting layout. */
const DUMMY_BASE_CLASS_NAME = "absolute top-[-9999px] invisible h-auto overflow-hidden whitespace-pre-wrap break-words";

const TEXTAREA_BASE_CLASS_NAME =
  // break-words: long unbroken tokens must wrap instead of expanding the shell width.
  "w-full min-w-0 resize-none overflow-hidden break-words border-0 bg-transparent text-on-surface placeholder:text-neutral focus:outline-none disabled:text-disabled";

export type TextAutosizeLayout = "grow" | "fill";

export type TextAutosizeProps = Omit<ComponentProps<"textarea">, "children" | "rows" | "style"> & {
  /**
   * `grow` — height follows content up to the max height in `className`, then scrolls.
   * `fill` — fills a fixed parent; font scales to the shell height; overflow scrolls.
   */
  layout?: TextAutosizeLayout;
  /**
   * Fixed font-scaling floor in root-font-size rows (grow layout).
   * When omitted or 0, falls back to the visible shell height.
   */
  minRows?: number;
  /**
   * Classes for the outer shell (min/max height, flex fill).
   * Grow: pass e.g. `min-h-24 max-h-64`. Fill: pass e.g. `h-full min-h-0`.
   */
  className?: string;
  /** Classes for the textarea itself (padding, etc.). */
  textareaClassName?: string;
  /** Forwarded to the inner ScrollArea when scrolling is enabled. */
  showScrollbarOnHover?: boolean;
  /** Optional extra styles; height is managed imperatively on the textarea. */
  style?: CSSProperties;
};

export type TextAutosizeFontScale = "stepped" | "fixed";

/** Body reading size used when `fontScale="fixed"` (Markdown / non-plain output). */
const FIXED_FONT_SIZE_CLASS: FontSizeStep = "text-body-md";

export type TextAutosizeContentProps = {
  /**
   * Text used only for font measurement (output body, error copy, loading label, …).
   * Empty string → largest font step.
   */
  text: string;
  /**
   * `fill` (default) — fixed parent pane. `grow` — content height; optional `max-h-*` then scrolls.
   */
  layout?: TextAutosizeLayout;
  /**
   * `stepped` (default) — scale font to fit shell / minRows.
   * `fixed` — always body-md; use for Markdown HTML whose height is not plain-text measurable.
   */
  fontScale?: TextAutosizeFontScale;
  /** Fixed font-scaling floor in root-font-size rows (grow layout). */
  minRows?: number;
  /** Outer shell classes. Grow without `max-h-*` stays content-sized (no ScrollArea). */
  className?: string;
  /** Inner content box (padding, leading). Font step class is applied here. */
  contentClassName?: string;
  showScrollbarOnHover?: boolean;
  /**
   * While true, follow the growing tail during stream output.
   * Auto-scroll pauses if the user scrolls away from the end, and resumes when they return near the bottom.
   * Uses the local ScrollArea viewport when present; otherwise the nearest scroll parent.
   */
  stickToEnd?: boolean;
  children: ReactNode;
};

/** Pixels of slack when treating a programmatic jump as already at the bottom. */
const STICK_TO_END_BOTTOM_SLACK_PX = 4;

/**
 * Distance from the end within which the user is considered "at the bottom".
 * Scrolling farther up pauses follow; returning within this band resumes it.
 */
const STICK_TO_END_RESUME_THRESHOLD_PX = 64;

/**
 * Find the nearest ancestor that can scroll vertically (overflow auto/scroll).
 * Prefers an already-overflowed scroller; falls back to the first scrollable ancestor
 * so stream stick can bind before content exceeds the viewport.
 */
function findVerticalScrollParent(start: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = start.parentElement;
  let firstScrollable: HTMLElement | null = null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    const canScroll = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
    if (canScroll) {
      if (node.scrollHeight > node.clientHeight + STICK_TO_END_BOTTOM_SLACK_PX) {
        return node;
      }
      firstScrollable ??= node;
    }
    node = node.parentElement;
  }
  return firstScrollable;
}

/** Resolve the element that should receive scrollTop updates for stick-to-end. */
function resolveStickScrollViewport(shell: HTMLElement | null, content: HTMLElement): HTMLElement | null {
  const local = shell?.querySelector<HTMLElement>("[data-scroll-viewport]");
  if (local && local.contains(content)) {
    return local;
  }
  return findVerticalScrollParent(content);
}

/** Distance from the scrollable end (0 = flush with the bottom). */
function distanceFromScrollEnd(viewport: HTMLElement): number {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
}

/** Jump a vertical scroller so its bottom edge shows the latest content. */
function scrollViewportToEnd(viewport: HTMLElement): void {
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  if (Math.abs(viewport.scrollTop - maxTop) > STICK_TO_END_BOTTOM_SLACK_PX) {
    viewport.scrollTop = maxTop;
  }
}

/**
 * Whether the user is near the followed end of this content.
 * Local fill panes use scroll metrics; multi-card pages use content bottom vs viewport bottom.
 */
function isNearFollowedEnd(
  content: HTMLElement,
  viewport: HTMLElement,
  pinAbsoluteEnd: boolean,
  thresholdPx: number,
): boolean {
  if (pinAbsoluteEnd) {
    return distanceFromScrollEnd(viewport) <= thresholdPx;
  }
  const overflowBelow = content.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom;
  return overflowBelow <= thresholdPx;
}

/**
 * Keep `content`'s bottom edge inside `viewport`'s visible box (multi-card page scroll).
 * Prefer absolute end-pin when content is the sole scroll payload of a local viewport.
 */
function ensureElementBottomVisible(content: HTMLElement, viewport: HTMLElement, pinAbsoluteEnd: boolean): void {
  if (pinAbsoluteEnd) {
    scrollViewportToEnd(viewport);
    return;
  }

  const contentRect = content.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  const overflowBelow = contentRect.bottom - viewportRect.bottom;
  if (overflowBelow > STICK_TO_END_BOTTOM_SLACK_PX) {
    viewport.scrollTop += overflowBelow;
  }
}

function resolveMinHeightPx(minRows: number | undefined, shellHeightPx: number): number {
  if (minRows != null && minRows > 0) {
    return minRows * MIN_ROW_UNIT_PX;
  }
  return shellHeightPx;
}

function clampFontIndex(index: number): number {
  return Math.min(LARGEST_FONT_INDEX, Math.max(SMALLEST_FONT_INDEX, index));
}

/**
 * Measure how tall `text` would be at `sizeClass`.
 * Geometry comes from `box`; font metrics come only from `sizeClass`.
 */
function measureTextHeight(dummy: HTMLDivElement, box: HTMLElement, text: string, sizeClass: FontSizeStep): number {
  dummy.className = `${DUMMY_BASE_CLASS_NAME} ${sizeClass}`;
  const style = getComputedStyle(box);
  dummy.style.width = style.width;
  dummy.style.padding = style.padding;
  dummy.style.border = style.border;
  dummy.style.boxSizing = style.boxSizing;
  dummy.style.fontSize = "";
  dummy.style.lineHeight = "";
  dummy.style.fontFamily = "";
  dummy.style.letterSpacing = "";
  dummy.textContent = text.length > 0 ? text : " ";
  return dummy.scrollHeight;
}

function pickFontIndexForText(options: {
  text: string;
  dummy: HTMLDivElement | null;
  box: HTMLElement | null;
  shellHeight: number;
  isFill: boolean;
  minRows: number | undefined;
}): number {
  const { text, dummy, box, shellHeight, isFill, minRows } = options;
  if (!dummy || !box || text.length === 0) {
    return LARGEST_FONT_INDEX;
  }

  const minHeight = isFill ? Math.max(shellHeight, 1) : resolveMinHeightPx(minRows, shellHeight);
  const fitLimit = minHeight + FONT_FIT_SLACK_PX;

  let nextIndex = LARGEST_FONT_INDEX;
  for (; nextIndex > SMALLEST_FONT_INDEX; nextIndex -= 1) {
    const step = FONT_SIZE_STEPS[nextIndex];
    if (!step) {
      break;
    }
    if (measureTextHeight(dummy, box, text, step) <= fitLimit) {
      break;
    }
  }
  return nextIndex;
}

type FitSize = { width: number; height: number };

/**
 * Shared shell + font-step engine for the editable field and the read-only content frame.
 * `observeHeight` is true for fill (pane resize changes the font floor).
 */
function useSteppedFontSize(options: {
  text: string;
  isFill: boolean;
  minRows: number | undefined;
  shellRef: RefObject<HTMLDivElement | null>;
  boxRef: RefObject<HTMLElement | null>;
  dummyRef: RefObject<HTMLDivElement | null>;
  /** When false, only width changes re-fit (grow layout content height is self-driven). */
  observeHeight: boolean;
  /** Optional side effect after font commit (e.g. textarea height). */
  onAfterFontFit?: (text: string) => void;
}): { fontSizeClass: string; fitToText: (nextText: string) => void } {
  const { text, isFill, minRows, shellRef, boxRef, dummyRef, observeHeight, onAfterFontFit } = options;

  const fontIndexRef = useRef(LARGEST_FONT_INDEX);
  const lastFitSizeRef = useRef<FitSize | null>(null);
  const isFittingRef = useRef(false);
  const prevTextRef = useRef<string | null>(null);
  const onAfterFontFitRef = useRef(onAfterFontFit);
  const [fontIndex, setFontIndex] = useState(LARGEST_FONT_INDEX);

  useEffect(() => {
    onAfterFontFitRef.current = onAfterFontFit;
  }, [onAfterFontFit]);

  const fontSizeClass = FONT_SIZE_STEPS[fontIndex] ?? FONT_SIZE_STEPS[LARGEST_FONT_INDEX];

  const readShellHeight = useCallback((): number => {
    return shellRef.current?.clientHeight ?? boxRef.current?.clientHeight ?? 0;
  }, [boxRef, shellRef]);

  const commitFontIndex = useCallback((nextIndex: number) => {
    const clamped = clampFontIndex(nextIndex);
    if (fontIndexRef.current === clamped) {
      return clamped;
    }
    fontIndexRef.current = clamped;
    setFontIndex(clamped);
    return clamped;
  }, []);

  const recordFitSize = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    lastFitSizeRef.current = {
      width: shell.clientWidth,
      height: shell.clientHeight,
    };
  }, [shellRef]);

  const fitToText = useCallback(
    (nextText: string) => {
      // Collapsed / display:none panels report width 0. Fitting then forces the smallest
      // (or wrong) step; on expand Collapsible measures that size then content corrects → jitter.
      const layoutWidth = shellRef.current?.clientWidth ?? boxRef.current?.clientWidth ?? 0;
      if (layoutWidth < 1) {
        return;
      }

      prevTextRef.current = nextText;
      recordFitSize();
      isFittingRef.current = true;
      if (nextText.length === 0) {
        commitFontIndex(LARGEST_FONT_INDEX);
      } else {
        commitFontIndex(
          pickFontIndexForText({
            text: nextText,
            dummy: dummyRef.current,
            box: boxRef.current,
            shellHeight: readShellHeight(),
            isFill,
            minRows,
          }),
        );
      }
      onAfterFontFitRef.current?.(nextText);
      requestAnimationFrame(() => {
        isFittingRef.current = false;
      });
    },
    [boxRef, commitFontIndex, dummyRef, isFill, minRows, readShellHeight, recordFitSize, shellRef],
  );

  // Text changes from props (stream, clear, clipboard, controlled re-render).
  useLayoutEffect(() => {
    if (prevTextRef.current === text) {
      return;
    }
    fitToText(text);
  }, [fitToText, text]);

  // Re-run post-fit after the font class lands (textarea height, etc.).
  useLayoutEffect(() => {
    onAfterFontFitRef.current?.(text);
  }, [fontIndex, text]);

  // Shell resize: grow → width only; fill → width or height.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (isFittingRef.current) {
        return;
      }
      const nextWidth = shell.clientWidth;
      const nextHeight = shell.clientHeight;
      // Ignore collapsed/hidden shells so we do not clobber a good font with a 0-width measure.
      if (nextWidth < 1) {
        return;
      }
      const prev = lastFitSizeRef.current;
      const widthChanged = prev == null || Math.abs(nextWidth - prev.width) >= 1;
      const heightChanged = prev == null || Math.abs(nextHeight - prev.height) >= 1;
      // First valid layout after being hidden (prev null or was never recorded).
      const becameVisible = prev == null || prev.width < 1;

      if (!becameVisible && !widthChanged && !(observeHeight && heightChanged)) {
        return;
      }

      lastFitSizeRef.current = { width: nextWidth, height: nextHeight };
      fitToText(text);
    });
    observer.observe(shell);
    return () => {
      observer.disconnect();
    };
  }, [fitToText, observeHeight, shellRef, text]);

  return { fontSizeClass, fitToText };
}

function scrollAreaClassNames(isFill: boolean, className: string | undefined) {
  return {
    root: cn(isFill ? "h-full min-h-0 min-w-0 w-full" : "min-w-0 w-full", className),
    // Grow: h-auto + same min/max as shell so the box tracks content then scrolls.
    // Fill: h-full so the fixed pane is the viewport; content may overflow and scroll.
    viewport: isFill
      ? "h-full min-h-0 min-w-0 [scrollbar-gutter:stable]"
      : cn("h-auto min-w-0 [scrollbar-gutter:stable]", className),
    content: cn("min-w-0 w-full", isFill && "min-h-full"),
  };
}

/**
 * Grow layout only needs ScrollArea when a max-height cap can create overflow.
 * Without max-h, a nested ScrollArea breaks content-height propagation (window resize / collapsible).
 */
function growNeedsScrollArea(className: string | undefined): boolean {
  return typeof className === "string" && /(?:^|\s)max-h-/.test(className);
}

/** Editable autosizing textarea (quick translate grow, main translate source fill). */
export function TextAutosize({
  value,
  defaultValue,
  className,
  textareaClassName,
  layout = "grow",
  minRows,
  showScrollbarOnHover = true,
  onChange,
  style,
  ...props
}: TextAutosizeProps) {
  const isFill = layout === "fill";
  const useScroll = isFill || growNeedsScrollArea(className);
  const shellRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dummyRef = useRef<HTMLDivElement>(null);

  const readShellHeight = useCallback((): number => {
    return shellRef.current?.clientHeight ?? rootRef.current?.clientHeight ?? 0;
  }, []);

  const resetViewportScrollIfNeeded = useCallback((nextValue: string) => {
    const viewport = shellRef.current?.querySelector<HTMLElement>("[data-scroll-viewport]");
    if (!viewport) {
      return;
    }
    // After clear / shrink past overflow, drop residual scrollTop so the shell can collapse
    // cleanly (otherwise a max-clamped grow box can keep looking “stuck” tall).
    if (nextValue.length === 0 || viewport.scrollHeight <= viewport.clientHeight + 1) {
      if (viewport.scrollTop !== 0) {
        viewport.scrollTop = 0;
      }
    }
  }, []);

  const applyHeight = useCallback(
    (nextValue: string) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.style.height = "auto";
      if (nextValue.length === 0) {
        if (isFill) {
          // Fill: shell height is fixed by the parent; pad the empty field to that pane.
          const fillHeight = Math.max(0, readShellHeight() - EMPTY_HEIGHT_INSET_PX);
          textarea.style.height = `${fillHeight}px`;
        } else {
          // Grow: never use clientHeight here — after max-h overflow it stays clamped at the
          // cap, so clearing would leave a tall empty textarea + scrollbar.
          // Prefer CSS min-height (e.g. min-h-24); otherwise natural one-line height.
          const shell = shellRef.current;
          const minHeightPx = shell ? parseComputedPx(getComputedStyle(shell).minHeight) : 0;
          const naturalHeight = textarea.scrollHeight;
          const fillMin = minHeightPx > 0 ? Math.max(0, minHeightPx - EMPTY_HEIGHT_INSET_PX) : naturalHeight;
          textarea.style.height = `${Math.max(naturalHeight, fillMin)}px`;
        }
        resetViewportScrollIfNeeded(nextValue);
        return;
      }
      textarea.style.height = `${textarea.scrollHeight}px`;
      resetViewportScrollIfNeeded(nextValue);
    },
    [isFill, readShellHeight, resetViewportScrollIfNeeded],
  );

  const text = value !== undefined ? String(value) : String(defaultValue ?? "");

  const { fontSizeClass, fitToText } = useSteppedFontSize({
    text,
    isFill,
    minRows,
    shellRef,
    boxRef: textareaRef,
    dummyRef,
    observeHeight: isFill,
    onAfterFontFit: applyHeight,
  });

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    // Fit immediately so controlled parents that setState async still feel live.
    fitToText(event.currentTarget.value);
    onChange?.(event);
  }

  const field = (
    <div ref={rootRef} className={cn("relative min-w-0 w-full", isFill && "min-h-full")}>
      <textarea
        {...props}
        ref={textareaRef}
        // fontSizeClass last so twMerge does not drop it for text-on-surface / other text-* utilities.
        className={cn(TEXTAREA_BASE_CLASS_NAME, "h-auto", textareaClassName, fontSizeClass)}
        style={style}
        value={value}
        defaultValue={defaultValue}
        onChange={handleChange}
      />
      <div ref={dummyRef} className={DUMMY_BASE_CLASS_NAME} aria-hidden />
    </div>
  );

  if (!useScroll) {
    return (
      <div ref={shellRef} className={cn("min-w-0 w-full", className)}>
        {field}
      </div>
    );
  }

  const scroll = scrollAreaClassNames(isFill, className);

  return (
    <ScrollArea
      ref={shellRef}
      className={scroll.root}
      viewportClassName={scroll.viewport}
      contentClassName={scroll.content}
      showScrollbarOnHover={showScrollbarOnHover}
    >
      {field}
    </ScrollArea>
  );
}

/**
 * Read-only stepped-font frame for translation output (and similar panes).
 * Pass the string to measure via `text`; render streaming/error/placeholder as `children`.
 *
 * Grow without `max-h-*`: plain block (height follows content → window can resize).
 * Grow with `max-h-*` / fill: ScrollArea for overflow.
 */
export function TextAutosizeContent({
  text,
  layout = "fill",
  fontScale = "stepped",
  minRows,
  className,
  contentClassName,
  showScrollbarOnHover = true,
  stickToEnd = false,
  children,
}: TextAutosizeContentProps) {
  const isFill = layout === "fill";
  const useScroll = isFill || growNeedsScrollArea(className);
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dummyRef = useRef<HTMLDivElement>(null);
  const useStepped = fontScale === "stepped";

  const { fontSizeClass: steppedFontSizeClass } = useSteppedFontSize({
    // Fixed scale still mounts the hook with empty measure text so it stays idle at largest index.
    text: useStepped ? text : "",
    isFill,
    minRows,
    shellRef,
    boxRef: contentRef,
    dummyRef,
    observeHeight: useStepped && isFill,
  });
  const fontSizeClass = useStepped ? steppedFontSizeClass : FIXED_FONT_SIZE_CLASS;

  // Stream output: follow the growing tail; pause on user scroll-away, resume near bottom.
  useLayoutEffect(() => {
    if (!stickToEnd) {
      return;
    }
    const content = contentRef.current;
    if (!content) {
      return;
    }

    /** User is following the tail; cleared when they scroll up past the resume band. */
    let followingEnd = true;
    /** Suppress pin updates from our own programmatic scrollTop writes. */
    let ignoreScrollEvents = false;
    let attachedViewport: HTMLElement | null = null;
    let releaseIgnoreFrame = 0;

    const resolveViewport = (): { viewport: HTMLElement | null; pinAbsoluteEnd: boolean } => {
      const localViewport = shellRef.current?.querySelector<HTMLElement>("[data-scroll-viewport]");
      const pinAbsoluteEnd = Boolean(useScroll && localViewport && localViewport.contains(content));
      const viewport = pinAbsoluteEnd
        ? localViewport
        : (resolveStickScrollViewport(shellRef.current, content) ?? localViewport);
      return { viewport: viewport ?? null, pinAbsoluteEnd };
    };

    const stickIfFollowing = () => {
      if (!followingEnd) {
        return;
      }
      const { viewport, pinAbsoluteEnd } = resolveViewport();
      if (!viewport) {
        return;
      }
      ignoreScrollEvents = true;
      ensureElementBottomVisible(content, viewport, pinAbsoluteEnd);
      if (releaseIgnoreFrame !== 0) {
        window.cancelAnimationFrame(releaseIgnoreFrame);
      }
      // Two frames: Base UI may emit scroll after layout settles.
      releaseIgnoreFrame = window.requestAnimationFrame(() => {
        releaseIgnoreFrame = window.requestAnimationFrame(() => {
          ignoreScrollEvents = false;
          releaseIgnoreFrame = 0;
        });
      });
    };

    const onScroll = () => {
      if (ignoreScrollEvents) {
        return;
      }
      const { viewport, pinAbsoluteEnd } = resolveViewport();
      if (!viewport) {
        return;
      }
      followingEnd = isNearFollowedEnd(content, viewport, pinAbsoluteEnd, STICK_TO_END_RESUME_THRESHOLD_PX);
    };

    const bindScrollTarget = () => {
      const { viewport } = resolveViewport();
      if (viewport === attachedViewport) {
        return;
      }
      if (attachedViewport) {
        attachedViewport.removeEventListener("scroll", onScroll);
      }
      attachedViewport = viewport;
      attachedViewport?.addEventListener("scroll", onScroll, { passive: true });
    };

    bindScrollTarget();
    stickIfFollowing();

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            bindScrollTarget();
            stickIfFollowing();
          })
        : null;
    resizeObserver?.observe(content);

    // Markdown/stream tokens may restructure DOM before the box size settles.
    const mutationObserver =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            stickIfFollowing();
          })
        : null;
    mutationObserver?.observe(content, { childList: true, subtree: true, characterData: true });

    return () => {
      if (attachedViewport) {
        attachedViewport.removeEventListener("scroll", onScroll);
      }
      if (releaseIgnoreFrame !== 0) {
        window.cancelAnimationFrame(releaseIgnoreFrame);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [stickToEnd, useScroll]);

  /*
	  fontSizeClass last: twMerge treats text-on-surface and text-headline-*
	  as the same text-* group, so a trailing color utility would drop the font step.
	*/
  const content = (
    <div
      ref={contentRef}
      // break-words matches the measure dummy so long tokens wrap the same way they are measured.
      className={cn(
        "relative min-w-0 w-full break-words text-on-surface",
        isFill && "min-h-full",
        contentClassName,
        fontSizeClass,
      )}
    >
      {children}
      {useStepped ? <div ref={dummyRef} className={DUMMY_BASE_CLASS_NAME} aria-hidden /> : null}
    </div>
  );

  if (!useScroll) {
    // Content-sized shell so collapsible / window height observers see real offsetHeight.
    return (
      <div ref={shellRef} className={cn("min-w-0 w-full", className)}>
        {content}
      </div>
    );
  }

  const scroll = scrollAreaClassNames(isFill, className);

  return (
    <ScrollArea
      ref={shellRef}
      className={scroll.root}
      viewportClassName={scroll.viewport}
      contentClassName={scroll.content}
      showScrollbarOnHover={showScrollbarOnHover}
    >
      {content}
    </ScrollArea>
  );
}
