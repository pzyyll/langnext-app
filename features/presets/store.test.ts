import { expect, test } from "nsh/test";
import { createPresetsStore, PRESETS_STORAGE_KEY } from "./store";
import type { ModelChoiceId, PresetsStorage, SavePresetInput } from "./types";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  let failGetError: Error | null = null;
  let failSetError: Error | null = null;
  let setCalls = 0;

  const storage: PresetsStorage = {
    getItem: async (key) => {
      if (failGetError) throw failGetError;
      return backing[key] ?? null;
    },
    setItem: async (key, value) => {
      setCalls += 1;
      if (failSetError) throw failSetError;
      backing[key] = value;
    },
  };

  return {
    backing,
    storage,
    setGetError: (err: Error | null) => {
      failGetError = err;
    },
    setSetError: (err: Error | null) => {
      failSetError = err;
    },
    getSetCalls: () => setCalls,
  };
}

function makeBaseInput(overrides: Partial<SavePresetInput> = {}): SavePresetInput {
  return {
    name: "Technical EN to ZH",
    enabled: true,
    sourceLanguage: "en",
    targetLanguage: "zh",
    engine: {
      kind: "ai",
      modelIds: ["m-1"],
      temperature: null,
      maxOutputTokens: null,
      templates: [
        {
          id: "tpl-1",
          name: "Default",
          systemTemplate: "Translate from {{source_language}} to {{target_language}} only.",
          userTemplate: "{{text}}",
        },
      ],
      defaultTemplateId: "tpl-1",
    },
    ...overrides,
  };
}

test("presets store: restores a saved preset", async () => {
  const mem = createMemoryStorage();
  const choices = (): ModelChoiceId[] => [{ id: "m-1" }];
  const store1 = createPresetsStore(mem.storage, choices);

  expect(store1.status()).toEqual({ kind: "idle" });
  await store1.load();
  expect(store1.status()).toEqual({ kind: "ready" });
  expect(store1.records()).toEqual([]);

  const created = await store1.save(makeBaseInput({ name: "  Technical EN to ZH  " }));
  expect(created.id.length).toBeGreaterThan(0);
  expect(created.name).toBe("Technical EN to ZH");
  expect(created.enabled).toBe(true);
  expect(created.sourceLanguage).toBe("en");
  expect(created.targetLanguage).toBe("zh");
  expect(created.createdAt).toBeTruthy();
  expect(created.updatedAt).toBeTruthy();

  const updated = await store1.save(
    makeBaseInput({
      id: created.id,
      name: "Updated Preset",
      enabled: false,
      sourceLanguage: "auto",
      targetLanguage: null,
    }),
  );
  expect(updated.id).toBe(created.id);
  expect(updated.createdAt).toBe(created.createdAt);
  expect(updated.name).toBe("Updated Preset");
  expect(updated.enabled).toBe(false);
  expect(updated.sourceLanguage).toBe("auto");
  expect(updated.targetLanguage).toBeNull();

  const store2 = createPresetsStore(mem.storage, choices);
  await store2.load();
  expect(store2.status()).toEqual({ kind: "ready" });
  expect(store2.records()).toEqual([updated]);

  const raw = JSON.parse(mem.backing[PRESETS_STORAGE_KEY]!);
  expect(raw.version).toBe(1);
  expect(raw.items).toEqual([updated]);
});

test("presets store: keeps saved data on write failure", async () => {
  const mem = createMemoryStorage();
  const choices = (): ModelChoiceId[] => [{ id: "m-1" }];
  const store = createPresetsStore(mem.storage, choices);
  await store.load();

  const saved = await store.save(makeBaseInput({ name: "Original" }));
  const setCallsBeforeFailure = mem.getSetCalls();

  mem.setSetError(new Error("ERR_NSH_QUOTA_EXCEEDED"));
  const editedInput = makeBaseInput({
    id: saved.id,
    name: "Edited Name",
    enabled: false,
  });

  await expect(store.save(editedInput)).rejects.toMatchObject({
    key: "storage_write_failed",
  });
  // Previous saved record remains visible and storage was not overwritten.
  expect(store.records()).toEqual([saved]);
  expect(JSON.parse(mem.backing[PRESETS_STORAGE_KEY]!).items).toEqual([saved]);

  // Retry succeeds and commits the same edited record once.
  mem.setSetError(null);
  const retried = await store.save(editedInput);
  expect(retried.id).toBe(saved.id);
  expect(retried.name).toBe("Edited Name");
  expect(retried.enabled).toBe(false);
  expect(store.records()).toEqual([retried]);
  expect(mem.getSetCalls()).toBe(setCallsBeforeFailure + 2);
});

test("presets store: keeps unreadable storage for malformed data", async () => {
  const malformedRaw = "{not valid json";
  const mem = createMemoryStorage({ [PRESETS_STORAGE_KEY]: malformedRaw });
  const choices = (): ModelChoiceId[] => [{ id: "m-1" }];
  const store = createPresetsStore(mem.storage, choices);

  await store.load();
  expect(store.status()).toMatchObject({ kind: "error", key: "storage_malformed" });
  expect(store.records()).toEqual([]);

  await expect(store.save(makeBaseInput())).rejects.toMatchObject({ key: "storage_unreadable" });
  await expect(store.remove("any-id")).rejects.toMatchObject({ key: "storage_unreadable" });
  expect(mem.getSetCalls()).toBe(0);
  expect(mem.backing[PRESETS_STORAGE_KEY]).toBe(malformedRaw);

  // Recovery after valid storage replaces malformed data.
  mem.backing[PRESETS_STORAGE_KEY] = JSON.stringify({ version: 1, items: [] });
  await store.load();
  expect(store.status()).toEqual({ kind: "ready" });
  const saved = await store.save(makeBaseInput());
  expect(store.records()).toEqual([saved]);
});

test("presets store: keeps unreadable storage for unsupported version", async () => {
  const futureRaw = JSON.stringify({ version: 2, items: [] });
  const mem = createMemoryStorage({ [PRESETS_STORAGE_KEY]: futureRaw });
  const choices = (): ModelChoiceId[] => [{ id: "m-1" }];
  const store = createPresetsStore(mem.storage, choices);

  await store.load();
  expect(store.status()).toMatchObject({ kind: "error", key: "storage_unsupported_version" });
  expect(store.records()).toEqual([]);

  await expect(store.save(makeBaseInput())).rejects.toMatchObject({ key: "storage_unreadable" });
  await expect(store.remove("any-id")).rejects.toMatchObject({ key: "storage_unreadable" });
  expect(mem.getSetCalls()).toBe(0);
  expect(mem.backing[PRESETS_STORAGE_KEY]).toBe(futureRaw);
});

test("presets store: validates model order and parameters", async () => {
  const mem = createMemoryStorage();
  let available: ModelChoiceId[] = [{ id: "m-1" }, { id: "m-2" }, { id: "m-3" }];
  const store = createPresetsStore(mem.storage, () => available);
  await store.load();

  // Duplicate model in primary + fallback chain is rejected.
  await expect(
    store.save(
      makeBaseInput({
        engine: {
          ...makeBaseInput().engine,
          modelIds: ["m-1", "m-2", "m-1"],
        },
      }),
    ),
  ).rejects.toMatchObject({ key: "model_duplicate", field: "fallbackModel", fallbackIndex: 1 });

  // Selecting an unavailable new model is rejected.
  await expect(
    store.save(
      makeBaseInput({
        engine: {
          ...makeBaseInput().engine,
          modelIds: ["m-1", "m-missing"],
        },
      }),
    ),
  ).rejects.toMatchObject({ key: "model_unavailable", field: "fallbackModel", fallbackIndex: 0 });

  // Temperature rejects non-numeric and negative inputs.
  await expect(
    store.save(
      makeBaseInput({
        engine: { ...makeBaseInput().engine, temperature: "-0.1" },
      }),
    ),
  ).rejects.toMatchObject({ key: "temperature_invalid", field: "temperature" });
  await expect(
    store.save(
      makeBaseInput({
        engine: { ...makeBaseInput().engine, temperature: "hot" },
      }),
    ),
  ).rejects.toMatchObject({ key: "temperature_invalid", field: "temperature" });

  // Max output tokens rejects 0, decimals, and trailing garbage.
  for (const invalidTokens of ["0", "1.5", "12x", "-10", 0, 1.5]) {
    await expect(
      store.save(
        makeBaseInput({
          engine: { ...makeBaseInput().engine, maxOutputTokens: invalidTokens },
        }),
      ),
    ).rejects.toMatchObject({ key: "max_output_tokens_invalid", field: "maxOutputTokens" });
  }

  // Temperature 0 and valid integer maxOutputTokens persist in exact model order.
  const created = await store.save(
    makeBaseInput({
      engine: {
        ...makeBaseInput().engine,
        modelIds: ["m-3", "m-1", "m-2"],
        temperature: "0",
        maxOutputTokens: "4096",
      },
    }),
  );
  expect(created.engine.modelIds).toEqual(["m-3", "m-1", "m-2"]);
  expect(created.engine.temperature).toBe(0);
  expect(created.engine.maxOutputTokens).toBe(4096);

  // Blank optional numeric fields normalize to null cleanly.
  const cleared = await store.save(
    makeBaseInput({
      id: created.id,
      engine: {
        ...makeBaseInput().engine,
        modelIds: ["m-3", "m-2", "m-1"],
        temperature: "   ",
        maxOutputTokens: "",
      },
    }),
  );
  expect(cleared.engine.modelIds).toEqual(["m-3", "m-2", "m-1"]);
  expect(cleared.engine.temperature).toBeNull();
  expect(cleared.engine.maxOutputTokens).toBeNull();

  // Existing bound unavailable models can stay across unrelated edits/reorders, while new unavailable ones fail.
  available = [{ id: "m-1" }];
  const renamedWithStale = await store.save(
    makeBaseInput({
      id: cleared.id,
      name: "Renamed Stale",
      engine: {
        ...makeBaseInput().engine,
        modelIds: ["m-3", "m-1"],
      },
    }),
  );
  expect(renamedWithStale.engine.modelIds).toEqual(["m-3", "m-1"]);
  await expect(
    store.save(
      makeBaseInput({
        id: renamedWithStale.id,
        engine: {
          ...makeBaseInput().engine,
          modelIds: ["m-3", "m-newly-bad"],
        },
      }),
    ),
  ).rejects.toMatchObject({ key: "model_unavailable", field: "fallbackModel", fallbackIndex: 0 });
});
