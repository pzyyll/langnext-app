import { expect, test } from "nsh/test";
import {
  BODY_FONT_POINTS,
  clampFontStep,
  FONT_FIT_ROWS,
  FONT_FIT_SLACK_POINTS,
  FONT_SIZE_STEPS,
  fontFitBudget,
  fieldShouldStepDown,
  fontFitSlack,
  fontMeasureClass,
  LARGEST_FONT_STEP,
  measurementLooksCollapsed,
  pickFontStep,
  SMALLEST_FONT_STEP,
  usesNaturalLineHeight,
} from "./font-step";

test("font step: the largest measured height that fits wins, and the smallest is the floor", () => {
  const budget = fontFitBudget(1);
  const slack = fontFitSlack(1);
  expect(budget).toBe(FONT_FIT_ROWS * BODY_FONT_POINTS);
  expect(slack).toBe(FONT_FIT_SLACK_POINTS);
  expect(fontFitBudget(1.5)).toBe(budget * 1.5);
  expect(fontFitBudget(0)).toBe(budget);

  const fitted = [20, 28, 40, 64];
  expect(pickFontStep(fitted, budget, slack)).toBe(LARGEST_FONT_STEP);
  expect(pickFontStep([20, 28, 40, budget + slack + 1], budget, slack)).toBe(2);
  expect(pickFontStep([20, 28, 200, 240], budget, slack)).toBe(1);
  expect(pickFontStep([budget + slack + 1, 200, 240, 280], budget, slack)).toBe(SMALLEST_FONT_STEP);
  expect(pickFontStep([0, 0, 0, 0], budget, slack)).toBe(SMALLEST_FONT_STEP);
  expect(pickFontStep([20, 28, 40, budget + slack], budget, slack)).toBe(LARGEST_FONT_STEP);
});

test("font step: indexes clamp, and only leading utilities are copied onto the measure text", () => {
  expect(clampFontStep(Number.NaN)).toBe(LARGEST_FONT_STEP);
  expect(clampFontStep(-3)).toBe(SMALLEST_FONT_STEP);
  expect(clampFontStep(99)).toBe(LARGEST_FONT_STEP);
  expect(clampFontStep(1.6)).toBe(2);
  expect(fontMeasureClass("min-h-10 leading-[0]")).toBe("");
  expect(fontMeasureClass("min-h-10 leading-relaxed")).toBe("leading-relaxed");
  expect(fontMeasureClass("min-h-10")).toBe("");
  expect(measurementLooksCollapsed("\u7a7a".repeat(72), 370, 32, LARGEST_FONT_STEP)).toBe(true);
  expect(measurementLooksCollapsed("\u7a7a".repeat(72), 370, 160, LARGEST_FONT_STEP)).toBe(false);
  expect(measurementLooksCollapsed("Hi", 370, 32, LARGEST_FONT_STEP)).toBe(false);
  const limit = fontFitBudget(1) + fontFitSlack(1);
  expect(fieldShouldStepDown(160, 32, limit, LARGEST_FONT_STEP, 24)).toBe(true);
  expect(fieldShouldStepDown(87, 87, limit, LARGEST_FONT_STEP, 24)).toBe(false);
  expect(fieldShouldStepDown(84, 84, limit, 1, 16)).toBe(false);
  expect(usesNaturalLineHeight("min-h-10 leading-[0]")).toBe(true);
  expect(usesNaturalLineHeight("min-h-10")).toBe(false);
  expect(FONT_SIZE_STEPS).toEqual(["text-sm", "text-base", "text-xl", "text-2xl"]);
});
