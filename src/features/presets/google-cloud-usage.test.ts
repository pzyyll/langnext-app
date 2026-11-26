import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import {
  countUsageCharacters,
  createGoogleCloudUsageStore,
  googleCloudUsageStorageKey,
  nextUsageReset,
  usageMonthKey,
} from "./google-cloud-usage";

const NOW = () => new Date(2026, 10, 20, 9, 30);
const NOVEMBER = "2026-11";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  return {
    backing,
    getItem: async (key: string) => backing[key] ?? null,
    setItem: async (key: string, value: string) => {
      // Let another write run first, so a read-modify-write race would lose a count.
      await new Promise((resolve) => setTimeout(resolve, 0));
      backing[key] = value;
    },
  };
}

function storedUsage(month: string, characters: number): string {
  return JSON.stringify({ version: 1, month, characters });
}

test("presets google cloud usage: reads the current month and resets a stale one to zero", async () => {
  const current = createMemoryStorage({
    [googleCloudUsageStorageKey("p-1")]: storedUsage(NOVEMBER, 12_345),
  });
  const store = createGoogleCloudUsageStore(current, NOW);
  await store.load("p-1");
  expect(store.state("p-1")).toEqual({
    kind: "ready",
    usage: { month: NOVEMBER, characters: 12_345 },
  });

  const stale = createMemoryStorage({
    [googleCloudUsageStorageKey("p-2")]: storedUsage("2026-10", 999),
  });
  const staleStore = createGoogleCloudUsageStore(stale, NOW);
  await staleStore.load("p-2");
  expect(staleStore.state("p-2")).toEqual({
    kind: "ready",
    usage: { month: NOVEMBER, characters: 0 },
  });
});

test("presets google cloud usage: records every request into the current month in order", async () => {
  const storage = createMemoryStorage({
    [googleCloudUsageStorageKey("p-1")]: storedUsage("2026-10", 700),
  });
  const store = createGoogleCloudUsageStore(storage, NOW);

  await Promise.all([store.record("p-1", 3), store.record("p-1", 4)]);
  expect(JSON.parse(storage.backing[googleCloudUsageStorageKey("p-1")]!)).toEqual({
    version: 1,
    month: NOVEMBER,
    characters: 7,
  });
  expect(store.state("p-1")).toEqual({
    kind: "ready",
    usage: { month: NOVEMBER, characters: 7 },
  });

  await store.record("p-1", 5);
  expect(JSON.parse(storage.backing[googleCloudUsageStorageKey("p-1")]!).characters).toBe(12);

  // Nothing counts zero, negative, or fractional characters.
  await store.record("p-1", 0);
  await store.record("p-1", -4);
  await store.record("p-1", 1.5);
  expect(JSON.parse(storage.backing[googleCloudUsageStorageKey("p-1")]!).characters).toBe(12);
});

test("presets google cloud usage: unreadable content counts as zero and a failed read is retried", async () => {
  const corrupt = createMemoryStorage({
    [googleCloudUsageStorageKey("p-1")]: "{not json",
    [googleCloudUsageStorageKey("p-2")]: storedUsage(NOVEMBER, -1),
    [googleCloudUsageStorageKey("p-3")]: JSON.stringify({
      version: 99,
      month: NOVEMBER,
      characters: 5,
    }),
  });
  const store = createGoogleCloudUsageStore(corrupt, NOW);
  for (const presetId of ["p-1", "p-2", "p-3"]) {
    await store.load(presetId);
    expect(store.state(presetId)).toEqual({
      kind: "ready",
      usage: { month: NOVEMBER, characters: 0 },
    });
  }

  let failing = true;
  const storage = {
    getItem: async () => {
      if (failing) throw new Error("storage unavailable");
      return null;
    },
    setItem: async () => {},
  };
  const failingStore = createGoogleCloudUsageStore(storage, NOW);
  await failingStore.load("p-1");
  expect(failingStore.state("p-1")).toEqual({
    kind: "error",
    message: t("presets.googleCloud.usage.unreadable"),
  });

  failing = false;
  await failingStore.load("p-1", { refresh: true });
  expect(failingStore.state("p-1")).toEqual({
    kind: "ready",
    usage: { month: NOVEMBER, characters: 0 },
  });
});

test("presets google cloud usage: caches a read until refreshed and survives a failed write", async () => {
  const storage = createMemoryStorage({
    [googleCloudUsageStorageKey("p-1")]: storedUsage(NOVEMBER, 10),
  });
  const store = createGoogleCloudUsageStore(storage, NOW);
  await store.load("p-1");
  storage.backing[googleCloudUsageStorageKey("p-1")] = storedUsage(NOVEMBER, 44);

  await store.load("p-1");
  expect(store.state("p-1")).toEqual({
    kind: "ready",
    usage: { month: NOVEMBER, characters: 10 },
  });

  await store.load("p-1", { refresh: true });
  expect(store.state("p-1")).toEqual({
    kind: "ready",
    usage: { month: NOVEMBER, characters: 44 },
  });

  const unwritable = {
    getItem: async () => null,
    setItem: async () => {
      throw new Error("storage unavailable");
    },
  };
  const failingStore = createGoogleCloudUsageStore(unwritable, NOW);
  await failingStore.record("p-1", 25);
  expect(failingStore.state("p-1")).toBeNull();
});

test("presets google cloud usage: month keys start again on the 1st", () => {
  expect(usageMonthKey(new Date(2026, 0, 5))).toBe("2026-01");
  expect(usageMonthKey(new Date(2026, 11, 31, 23, 59))).toBe("2026-12");

  const newYear = nextUsageReset(new Date(2026, 11, 20, 12, 0));
  expect(newYear.getFullYear()).toBe(2027);
  expect(newYear.getMonth()).toBe(0);
  expect(newYear.getDate()).toBe(1);
  expect(newYear.getHours()).toBe(0);

  const nextMonth = nextUsageReset(new Date(2026, 10, 1, 0, 0));
  expect(nextMonth.getMonth()).toBe(11);
  expect(nextMonth.getDate()).toBe(1);
});

test("presets google cloud usage: counts source characters as code points", () => {
  expect(countUsageCharacters("")).toBe(0);
  expect(countUsageCharacters("Hello")).toBe(5);
  expect(countUsageCharacters("好吃 😀")).toBe(4);
});
