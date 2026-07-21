// ABOUTME: Unit tests for pure slot epoch helpers used by multi-slot streams.
// ABOUTME: Covers next/current checks and bulk bump invalidation.
import { describe, expect, test } from "bun:test";
import { bumpAllSlotEpochs, isSlotEpochCurrent, nextSlotEpoch } from "./slotEpoch";

describe("slotEpoch helpers", () => {
  test("nextSlotEpoch increments from zero", () => {
    const map = new Map<string, number>();
    expect(nextSlotEpoch(map, "a")).toBe(1);
    expect(nextSlotEpoch(map, "a")).toBe(2);
    expect(map.get("a")).toBe(2);
  });

  test("isSlotEpochCurrent only accepts the latest epoch", () => {
    const map = new Map<string, number>();
    const first = nextSlotEpoch(map, "slot");
    expect(isSlotEpochCurrent(map, "slot", first)).toBe(true);
    const second = nextSlotEpoch(map, "slot");
    expect(isSlotEpochCurrent(map, "slot", first)).toBe(false);
    expect(isSlotEpochCurrent(map, "slot", second)).toBe(true);
  });

  test("bumpAllSlotEpochs advances every existing key", () => {
    const map = new Map<string, number>([
      ["a", 1],
      ["b", 3],
    ]);
    bumpAllSlotEpochs(map);
    expect(map.get("a")).toBe(2);
    expect(map.get("b")).toBe(4);
  });
});
