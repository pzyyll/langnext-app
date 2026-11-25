import { expect, test } from "nsh/test";
import type { DeepLUsage } from "../../modules/deepl/client";
import { createDeepLUsageStore } from "./deepl-usage";

function usage(characterCount: number): DeepLUsage {
  return {
    characterCount,
    characterLimit: 500_000,
    apiKeyCharacterCount: null,
    periodEnd: null,
  };
}

test("presets deepl usage store: reads once, caches, and reloads a replacement key", async () => {
  let credential = "first:fx";
  const fetched: string[] = [];
  const store = createDeepLUsageStore(
    async () => credential,
    async (apiKey) => {
      fetched.push(apiKey);
      return usage(10);
    },
  );

  await store.load("p-1");
  expect(store.state("p-1")).toEqual({ kind: "ready", usage: usage(10) });
  expect(fetched).toEqual(["first:fx"]);

  await store.load("p-1");
  expect(fetched).toEqual(["first:fx"]);

  credential = "second:fx";
  await store.reload("p-1");
  expect(fetched).toEqual(["first:fx", "second:fx"]);
});

test("presets deepl usage store: reports a missing key and the provider message", async () => {
  const missing = createDeepLUsageStore(
    async () => null,
    async () => {
      throw new Error("should not ask DeepL without a key");
    },
  );
  await missing.load("p-1");
  expect(missing.state("p-1")).toMatchObject({ kind: "error" });

  const rejected = createDeepLUsageStore(
    async () => "bad:fx",
    async () => {
      throw new Error("DeepL rejected the key.");
    },
  );
  await rejected.load("p-1");
  expect(rejected.state("p-1")).toEqual({ kind: "error", message: "DeepL rejected the key." });
});

test("presets deepl usage store: a forgotten read never overwrites the next one", async () => {
  let settleFirst: ((value: DeepLUsage) => void) | null = null;
  const store = createDeepLUsageStore(
    async () => "key:fx",
    (() => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<DeepLUsage>((resolve) => {
            settleFirst = resolve;
          });
        }
        return Promise.resolve(usage(99));
      };
    })(),
  );

  const first = store.load("p-1");
  for (let i = 0; i < 10 && settleFirst === null; i += 1) {
    await Promise.resolve();
  }
  const settle = settleFirst as ((value: DeepLUsage) => void) | null;
  expect(settle).not.toBeNull();
  store.forget("p-1");
  settle!(usage(1));
  await first;
  expect(store.state("p-1")).toBeNull();

  await store.load("p-1");
  expect(store.state("p-1")).toEqual({ kind: "ready", usage: usage(99) });
});
