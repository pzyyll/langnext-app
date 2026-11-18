import { expect, test } from "nsh/test";
import {
  COMPACT_RAIL_WIDTH,
  createSplitRailStore,
  DEFAULT_RAIL_WIDTH,
  MAX_RAIL_WIDTH,
  MIN_RAIL_WIDTH,
  parseRailWidth,
  resolveRailWidth,
  SPLIT_RAIL_STORAGE_KEYS,
  type SplitRailStorage,
} from "./split-rail";

function makeMemoryStorage(initial: Record<string, string> = {}): {
  storage: SplitRailStorage;
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    storage: {
      getItem: async (key) => (key in data ? data[key]! : null),
      setItem: async (key, value) => {
        data[key] = value;
      },
    },
  };
}

test("split rail: parses and clamps stored widths", () => {
  expect(parseRailWidth(null)).toBeNull();
  expect(parseRailWidth("")).toBeNull();
  expect(parseRailWidth("abc")).toBeNull();
  expect(parseRailWidth("0")).toBeNull();
  expect(parseRailWidth("-120")).toBeNull();
  expect(parseRailWidth("90")).toBe(MIN_RAIL_WIDTH);
  expect(parseRailWidth("279.6")).toBe(280);
  expect(parseRailWidth("640")).toBe(MAX_RAIL_WIDTH);
});

test("split rail: resolves defaults and clamps saved width to window bounds", () => {
  expect(resolveRailWidth(null, 1040)).toBe(DEFAULT_RAIL_WIDTH);
  expect(resolveRailWidth(null, 720)).toBe(COMPACT_RAIL_WIDTH);

  // Customized width shrinks to protect minimum detail width at 720, then restores at 1040.
  expect(resolveRailWidth(340, 720)).toBe(268);
  expect(resolveRailWidth(340, 1040)).toBe(340);
});

test("split rail store: loads and saves per-page rail widths independently", async () => {
  const { storage, data } = makeMemoryStorage({
    [SPLIT_RAIL_STORAGE_KEYS.models]: "310",
    [SPLIT_RAIL_STORAGE_KEYS.presets]: "invalid",
    [SPLIT_RAIL_STORAGE_KEYS.settings]: "225",
  });
  const store = createSplitRailStore(storage);
  await store.load();

  expect(store.savedWidth("models")).toBe(310);
  expect(store.savedWidth("presets")).toBeNull();
  expect(store.savedWidth("settings")).toBe(225);
  expect(store.widthFor("models", 1040)).toBe(310);
  expect(store.widthFor("presets", 1040)).toBe(DEFAULT_RAIL_WIDTH);
  expect(store.widthFor("settings", 1040)).toBe(225);

  await store.save("presets", 275.4);
  expect(store.savedWidth("presets")).toBe(275);
  expect(data[SPLIT_RAIL_STORAGE_KEYS.presets]).toBe("275");
  expect(data[SPLIT_RAIL_STORAGE_KEYS.models]).toBe("310");
  expect(data[SPLIT_RAIL_STORAGE_KEYS.settings]).toBe("225");

  await store.save("settings", 290);
  expect(store.savedWidth("settings")).toBe(290);
  expect(data[SPLIT_RAIL_STORAGE_KEYS.settings]).toBe("290");
});

test("split rail store: tolerates storage read and write errors", async () => {
  const failingStorage: SplitRailStorage = {
    getItem: async () => {
      throw new Error("read failed");
    },
    setItem: async () => {
      throw new Error("write failed");
    },
  };
  const store = createSplitRailStore(failingStorage);
  await store.load();
  expect(store.savedWidth("models")).toBeNull();

  await store.save("models", 300);
  expect(store.savedWidth("models")).toBe(300);
});
