/** Source type steps, dense to display. Empty text uses the largest. */
export const FONT_SIZE_STEPS = ["text-sm", "text-base", "text-xl", "text-2xl"] as const;

export type FontSizeStep = (typeof FONT_SIZE_STEPS)[number];

export const SMALLEST_FONT_STEP = 0;
export const LARGEST_FONT_STEP = FONT_SIZE_STEPS.length - 1;

/**
 * How many rows of the body size the source should fill before stepping down.
 * Matches langnext quick-translate minRows.
 */
export const FONT_FIT_ROWS = 6;

/** text-base on the type scale, the row unit behind FONT_FIT_ROWS. */
export const BODY_FONT_POINTS = 16;

/** Slack so a height sitting on the boundary does not flip between steps. */
export const FONT_FIT_SLACK_POINTS = 2;

/** Fit budget in points at the user's current text scale. */
export function fontFitBudget(fontScale: number): number {
  const scale = fontScale > 0 ? fontScale : 1;
  return FONT_FIT_ROWS * BODY_FONT_POINTS * scale;
}

/** Boundary slack in points at the user's current text scale. */
export function fontFitSlack(fontScale: number): number {
  const scale = fontScale > 0 ? fontScale : 1;
  return FONT_FIT_SLACK_POINTS * scale;
}

/** Clamp a step index onto the scale. Non-finite values use the largest step. */
export function clampFontStep(step: number): number {
  if (!Number.isFinite(step)) return LARGEST_FONT_STEP;
  return Math.min(LARGEST_FONT_STEP, Math.max(SMALLEST_FONT_STEP, Math.round(step)));
}

/**
 * Largest step whose measured height still fits.
 * heights is one entry per FONT_SIZE_STEPS, dense first.
 * A non-positive height is not a fit. Nothing else fitting returns the smallest step.
 */
export function pickFontStep(heights: readonly number[], budget: number, slack: number): number {
  const limit = budget + slack;
  for (let index = heights.length - 1; index > SMALLEST_FONT_STEP; index -= 1) {
    const height = heights[index] ?? Number.POSITIVE_INFINITY;
    if (height > 0 && height <= limit) return index;
  }
  return SMALLEST_FONT_STEP;
}

/** Leading utilities the offscreen measure text must share with the input. */
export function fontMeasureClass(inputClass: string | undefined): string {
  return (inputClass ?? "")
    .split(/\s+/)
    .filter((part) => part.startsWith("leading-"))
    .join(" ");
}

/** leading-[0] asks NSH 0.6.1 to use the font's natural line height. */
export function usesNaturalLineHeight(inputClass: string | undefined): boolean {
  return (inputClass ?? "").split(/\s+/).includes("leading-[0]");
}
