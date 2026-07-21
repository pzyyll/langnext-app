// ABOUTME: Unit tests for continuous source-edit heuristic used by quick-translate.
// ABOUTME: Covers append/backspace continuity vs select-all replace restarts.
import { describe, expect, test } from "bun:test";
import { isContinuousSourceEdit } from "./isContinuousSourceEdit";

describe("isContinuousSourceEdit", () => {
  test("treats identical text as continuous", () => {
    expect(isContinuousSourceEdit("hello", "hello")).toBe(true);
  });

  test("treats pure append as continuous", () => {
    expect(isContinuousSourceEdit("hel", "hello")).toBe(true);
  });

  test("treats small end shrink as continuous", () => {
    expect(isContinuousSourceEdit("hello", "hel")).toBe(true);
  });

  test("treats empty either side as not continuous (except identical empty)", () => {
    expect(isContinuousSourceEdit("", "a")).toBe(false);
    expect(isContinuousSourceEdit("a", "")).toBe(false);
  });

  test("treats wholesale replace as not continuous", () => {
    expect(isContinuousSourceEdit("select all this text", "paste")).toBe(false);
  });
});
