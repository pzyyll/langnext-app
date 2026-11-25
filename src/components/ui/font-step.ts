/** Source type steps, dense to display. Empty text uses the largest. */
export const FONT_SIZE_STEPS = ["text-sm", "text-base", "text-xl", "text-2xl"] as const;

/** Font size in points for each FONT_SIZE_STEPS entry. */
export const FONT_STEP_POINTS = [14, 16, 20, 24] as const;

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

/**
 * The field is taller than the budget, and the probe does not show that this step
 * actually fits. A collapsed one-line probe is not that proof.
 */
export function fieldShouldStepDown(
  fieldHeight: number,
  probeHeight: number,
  limit: number,
  step: number,
  fontSize: number,
): boolean {
  if (fieldHeight <= limit || step <= SMALLEST_FONT_STEP) return false;
  const probeFits = probeHeight > 0 && probeHeight <= limit;
  const probeCollapsed = probeHeight > 0 && probeHeight < fontSize * 2;
  if (probeFits && !probeCollapsed) return false;
  return true;
}

/** Text compared across a probe's lines, which do not keep the newline characters. */
export function comparableMeasureText(text: string): string {
  return text.replace(/\r?\n/g, "");
}

/**
 * A clipped box or a collapsed line height reports about one line for text that
 * must wrap. That reading is not a fit.
 */
export function measurementLooksCollapsed(
  text: string,
  width: number,
  height: number,
  step: number,
): boolean {
  const fontSize = FONT_STEP_POINTS[step] ?? BODY_FONT_POINTS;
  if (width < fontSize || height <= 0) return true;
  const perLine = Math.max(1, Math.floor(width / fontSize));
  const minLines = Math.ceil(text.length / perLine);
  return minLines >= 3 && height < fontSize * 2;
}
