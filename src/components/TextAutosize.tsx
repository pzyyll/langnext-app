// ABOUTME: Autosizing textarea that steps font size down as content fills a min height.
// ABOUTME: Port of langnext-translate TextAutosize for sparse-to-dense input typography.
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ChangeEvent,
	type ComponentProps,
	type CSSProperties,
} from "react";
import { cn } from "../lib/cn";

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
 * Font scaling tries to keep content within `minRows * MIN_ROW_UNIT_PX` before growing height.
 */
const MIN_ROW_UNIT_PX = 16;

/** Inset when filling parent height so an empty field does not overflow the root box. */
const EMPTY_HEIGHT_INSET_PX = 8;

/**
 * Hysteresis when deciding whether a larger font still "fits".
 * Avoids border-line oscillation (e.g. 95px ↔ 97px) that thrash layout + window height.
 */
const FONT_FIT_SLACK_PX = 2;

/** Hidden measure node: mirrors textarea box metrics without affecting layout. */
const DUMMY_BASE_CLASS_NAME = "absolute top-[-9999px] invisible h-auto overflow-hidden whitespace-pre-wrap break-words";

const TEXTAREA_BASE_CLASS_NAME =
	"w-full resize-none overflow-hidden border-0 bg-transparent text-on-surface placeholder:text-neutral focus:outline-none";

export type TextAutosizeProps = Omit<ComponentProps<"textarea">, "children" | "rows" | "style"> & {
	/**
	 * Fixed min height for font scaling, in root-font-size rows.
	 * When omitted or 0, falls back to the root box height (fixed parents).
	 * Prefer a positive value when the field itself is allowed to grow.
	 */
	minRows?: number;
	/** Optional extra styles; height is managed imperatively on the textarea. */
	style?: CSSProperties;
};

function resolveMinHeightPx(minRows: number | undefined, fallbackPx: number): number {
	if (minRows != null && minRows > 0) {
		return minRows * MIN_ROW_UNIT_PX;
	}
	return fallbackPx;
}

function clampFontIndex(index: number): number {
	return Math.min(LARGEST_FONT_INDEX, Math.max(SMALLEST_FONT_INDEX, index));
}

/**
 * Measure how tall `text` would be at `sizeClass`.
 * Only mirror box geometry from the live textarea — font metrics come from `sizeClass`
 * so we never bake the current step's line-height into a different step's measurement.
 */
function measureTextHeight(
	dummy: HTMLDivElement,
	textarea: HTMLTextAreaElement,
	text: string,
	sizeClass: FontSizeStep,
): number {
	dummy.className = `${DUMMY_BASE_CLASS_NAME} ${sizeClass}`;
	const style = getComputedStyle(textarea);
	// Geometry only — do not copy font-size / line-height / font-family from the live node.
	dummy.style.width = style.width;
	dummy.style.padding = style.padding;
	dummy.style.border = style.border;
	dummy.style.boxSizing = style.boxSizing;
	dummy.style.fontSize = "";
	dummy.style.lineHeight = "";
	dummy.style.fontFamily = "";
	dummy.style.letterSpacing = "";
	// Non-empty content so an empty string still reports one line box.
	dummy.textContent = text.length > 0 ? text : " ";
	return dummy.scrollHeight;
}

export function TextAutosize({
	value,
	defaultValue,
	className,
	minRows,
	onChange,
	style,
	...props
}: TextAutosizeProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const dummyRef = useRef<HTMLDivElement>(null);
	/** Last value we sized for; null until the first sync so external mounts remeasure. */
	const prevValueRef = useRef<string | null>(null);
	const fontIndexRef = useRef(LARGEST_FONT_INDEX);
	/** Last root width that triggered a font re-fit (height-only resizes are ignored). */
	const lastFitWidthRef = useRef<number | null>(null);
	/** True while we are applying height/font so ResizeObserver does not re-enter. */
	const isFittingRef = useRef(false);
	const [fontIndex, setFontIndex] = useState(LARGEST_FONT_INDEX);

	const fontSizeClass = FONT_SIZE_STEPS[fontIndex] ?? FONT_SIZE_STEPS[LARGEST_FONT_INDEX];

	const readCurrentValue = useCallback((): string => {
		if (value !== undefined) {
			return String(value);
		}
		return textareaRef.current?.value ?? "";
	}, [value]);

	const commitFontIndex = useCallback((nextIndex: number) => {
		const clamped = clampFontIndex(nextIndex);
		if (fontIndexRef.current === clamped) {
			return clamped;
		}
		fontIndexRef.current = clamped;
		setFontIndex(clamped);
		return clamped;
	}, []);

	/**
	 * Set textarea height from content (or fill the root when empty).
	 * Returns natural content height used for font spill checks (0 when empty).
	 */
	const applyHeight = useCallback((nextValue: string): number => {
		const root = rootRef.current;
		const textarea = textareaRef.current;
		if (!root || !textarea) {
			return 0;
		}

		isFittingRef.current = true;
		textarea.style.height = "auto";

		if (nextValue.length === 0) {
			const fillHeight = Math.max(0, root.clientHeight - EMPTY_HEIGHT_INSET_PX);
			textarea.style.height = `${fillHeight}px`;
			// Release on next frame so ResizeObserver from this write is ignored.
			requestAnimationFrame(() => {
				isFittingRef.current = false;
			});
			return 0;
		}

		const naturalHeight = textarea.scrollHeight;
		textarea.style.height = `${naturalHeight}px`;
		requestAnimationFrame(() => {
			isFittingRef.current = false;
		});
		return naturalHeight;
	}, []);

	/**
	 * Largest font whose measured height still fits the min box (with slack).
	 * Always force-fit — directional grow/shrink thrash on paste and border-line widths.
	 */
	const forceFontIndexForValue = useCallback(
		(nextValue: string): number => {
			const root = rootRef.current;
			const textarea = textareaRef.current;
			const dummy = dummyRef.current;
			if (!root || !textarea || !dummy || nextValue.length === 0) {
				return LARGEST_FONT_INDEX;
			}

			const minHeight = resolveMinHeightPx(minRows, root.clientHeight);
			const fitLimit = minHeight + FONT_FIT_SLACK_PX;

			let nextIndex = LARGEST_FONT_INDEX;
			for (; nextIndex > SMALLEST_FONT_INDEX; nextIndex -= 1) {
				const step = FONT_SIZE_STEPS[nextIndex];
				if (!step) {
					break;
				}
				if (measureTextHeight(dummy, textarea, nextValue, step) <= fitLimit) {
					break;
				}
			}
			return nextIndex;
		},
		[minRows],
	);

	/** Fit font + height for a value; records the width used so height-only resizes skip. */
	const fitToValue = useCallback(
		(nextValue: string) => {
			const root = rootRef.current;
			if (root) {
				lastFitWidthRef.current = root.clientWidth;
			}
			if (nextValue.length === 0) {
				commitFontIndex(LARGEST_FONT_INDEX);
				applyHeight(nextValue);
				return;
			}
			commitFontIndex(forceFontIndexForValue(nextValue));
			// Height is reapplied after the font class commits (layout effect on fontIndex).
			// Also apply immediately with the current class so paste does not flash wrong height.
			applyHeight(nextValue);
		},
		[applyHeight, commitFontIndex, forceFontIndexForValue],
	);

	// Re-apply height after font class changes land in the DOM (imperative only — no setState).
	useLayoutEffect(() => {
		applyHeight(readCurrentValue());
	}, [applyHeight, fontIndex, readCurrentValue]);

	// Controlled value changes (typing, paste, clipboard IPC, clear).
	useLayoutEffect(() => {
		if (value === undefined) {
			return;
		}
		const nextValue = String(value);
		const previousValue = prevValueRef.current;
		if (previousValue === nextValue) {
			return;
		}
		prevValueRef.current = nextValue;
		fitToValue(nextValue);
	}, [fitToValue, value]);

	// Width changes only: re-fit font. Height-only changes (our own applyHeight / window
	// content-height chase) must not re-enter or they thrash font steps.
	useEffect(() => {
		const root = rootRef.current;
		if (!root || typeof ResizeObserver === "undefined") {
			return;
		}

		const observer = new ResizeObserver((entries) => {
			if (isFittingRef.current) {
				return;
			}
			const entry = entries[0];
			const nextWidth = entry?.contentRect.width ?? root.clientWidth;
			const prevWidth = lastFitWidthRef.current;
			// Sub-pixel / scrollbar-gutter noise: ignore tiny width deltas.
			if (prevWidth != null && Math.abs(nextWidth - prevWidth) < 1) {
				return;
			}
			lastFitWidthRef.current = nextWidth;
			fitToValue(readCurrentValue());
		});
		observer.observe(root);
		return () => {
			observer.disconnect();
		};
	}, [fitToValue, readCurrentValue]);

	function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
		const nextValue = event.currentTarget.value;
		prevValueRef.current = nextValue;
		// Size immediately on keystroke so controlled parents that re-render async still feel live.
		fitToValue(nextValue);
		onChange?.(event);
	}

	return (
		<div ref={rootRef} className={cn("relative h-full w-full", className)}>
			<textarea
				{...props}
				ref={textareaRef}
				className={cn(TEXTAREA_BASE_CLASS_NAME, fontSizeClass, "h-auto")}
				style={style}
				value={value}
				defaultValue={defaultValue}
				onChange={handleChange}
			/>
			<div ref={dummyRef} className={DUMMY_BASE_CLASS_NAME} aria-hidden />
		</div>
	);
}
