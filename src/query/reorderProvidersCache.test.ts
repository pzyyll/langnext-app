// ABOUTME: Contract tests for optimistic provider reorder and rollback epochs.
// ABOUTME: Pure functions only — no React or QueryClient required.
import { describe, expect, test } from "bun:test";
import { applyProviderReorderOrder, shouldRollbackReorder } from "./reorderProvidersCache";

describe("applyProviderReorderOrder", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("reorders when ids are a complete permutation", () => {
    expect(applyProviderReorderOrder(list, ["c", "a", "b"])).toEqual([{ id: "c" }, { id: "a" }, { id: "b" }]);
  });

  test("returns null when an id is missing from previous", () => {
    expect(applyProviderReorderOrder(list, ["a", "b", "missing"])).toBeNull();
  });

  test("returns null when lengths differ", () => {
    expect(applyProviderReorderOrder(list, ["a", "b"])).toBeNull();
  });

  test("returns null when ids are duplicated", () => {
    expect(applyProviderReorderOrder(list, ["a", "a", "b"])).toBeNull();
  });
});

describe("shouldRollbackReorder", () => {
  test("allows rollback only for the latest mutation epoch", () => {
    expect(shouldRollbackReorder(3, 3)).toBe(true);
    expect(shouldRollbackReorder(2, 3)).toBe(false);
    expect(shouldRollbackReorder(4, 3)).toBe(false);
  });
});
