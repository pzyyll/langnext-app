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
      disableReasoning: true,
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
  expect(store1.status()).toEqual({ kind: "ready", skippedCount: 0 });
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
      targetLanguage: "auto",
    }),
  );
  expect(updated.id).toBe(created.id);
  expect(updated.createdAt).toBe(created.createdAt);
  expect(updated.name).toBe("Updated Preset");
  expect(updated.enabled).toBe(false);
  expect(updated.sourceLanguage).toBe("auto");
  expect(updated.targetLanguage).toBe("auto");

  const store2 = createPresetsStore(mem.storage, choices);
  await store2.load();
  expect(store2.status()).toEqual({ kind: "ready", skippedCount: 0 });
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
  expect(store.status()).toEqual({ kind: "ready", skippedCount: 0 });
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

  // Temperature uses a fixed 0.0–2.0 grid for both text and numeric inputs.
  for (const temperature of ["-0.1", "hot", "2.1", "1.05", "1e0", 2.1, 1.05]) {
    await expect(
      store.save(makeBaseInput({ engine: { ...makeBaseInput().engine, temperature } })),
    ).rejects.toMatchObject({ key: "temperature_invalid", field: "temperature" });
  }

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

test("presets store: validates every prompt template", async () => {
  const mem = createMemoryStorage();
  const store = createPresetsStore(mem.storage, () => [{ id: "m-1" }]);
  await store.load();

  const base = makeBaseInput();

  // Empty template list is rejected.
  await expect(
    store.save({
      ...base,
      engine: { ...base.engine, templates: [] },
    }),
  ).rejects.toMatchObject({ key: "templates_required", field: "templates" });

  // Duplicate template IDs are rejected.
  await expect(
    store.save({
      ...base,
      engine: {
        ...base.engine,
        templates: [
          { id: "tpl-dup", name: "One", systemTemplate: "", userTemplate: "{{text}}" },
          { id: "tpl-dup", name: "Two", systemTemplate: "", userTemplate: "{{text}}" },
        ],
        defaultTemplateId: "tpl-dup",
      },
    }),
  ).rejects.toMatchObject({ key: "template_id_duplicate", templateId: "tpl-dup" });

  // Blank name on a secondary template reports templateName + that templateId.
  await expect(
    store.save({
      ...base,
      engine: {
        ...base.engine,
        templates: [
          base.engine.templates[0]!,
          { id: "tpl-2", name: "   ", systemTemplate: "", userTemplate: "{{text}}" },
        ],
      },
    }),
  ).rejects.toMatchObject({
    key: "template_name_required",
    field: "templateName",
    templateId: "tpl-2",
  });

  // Dangling defaultTemplateId is rejected.
  await expect(
    store.save({
      ...base,
      engine: { ...base.engine, defaultTemplateId: "tpl-missing" },
    }),
  ).rejects.toMatchObject({ key: "default_template_invalid", field: "defaultTemplate" });

  // Unclosed and unknown variables are rejected with field and templateId.
  await expect(
    store.save({
      ...base,
      engine: {
        ...base.engine,
        templates: [
          {
            id: "tpl-1",
            name: "Default",
            systemTemplate: "Translate to {{target_language",
            userTemplate: "{{text}}",
          },
        ],
      },
    }),
  ).rejects.toMatchObject({
    key: "template_unclosed_variable",
    field: "systemTemplate",
    templateId: "tpl-1",
  });

  await expect(
    store.save({
      ...base,
      engine: {
        ...base.engine,
        templates: [
          {
            id: "tpl-1",
            name: "Default",
            systemTemplate: "Use {{tone}}.",
            userTemplate: "{{text}}",
          },
        ],
      },
    }),
  ).rejects.toMatchObject({
    key: "template_unknown_variable",
    field: "systemTemplate",
    templateId: "tpl-1",
  });

  // User prompt requires {{text}} exactly once.
  await expect(
    store.save({
      ...base,
      engine: {
        ...base.engine,
        templates: [{ id: "tpl-1", name: "Default", systemTemplate: "", userTemplate: "Hello" }],
      },
    }),
  ).rejects.toMatchObject({
    key: "user_template_text_required",
    field: "userTemplate",
    templateId: "tpl-1",
  });

  await expect(
    store.save({
      ...base,
      engine: {
        ...base.engine,
        templates: [
          {
            id: "tpl-1",
            name: "Default",
            systemTemplate: "",
            userTemplate: "{{text}} then {{ text }}",
          },
        ],
      },
    }),
  ).rejects.toMatchObject({
    key: "user_template_text_duplicate",
    field: "userTemplate",
    templateId: "tpl-1",
  });

  // Spaced variables, blank system prompt, and multi-line leading/trailing line breaks are preserved.
  const saved = await store.save({
    ...base,
    engine: {
      ...base.engine,
      templates: [
        {
          id: "tpl-1",
          name: "  Minimal  ",
          systemTemplate: "",
          userTemplate: "\n{{ text }}\n",
        },
        {
          id: "tpl-2",
          name: "Detailed",
          systemTemplate: "From {{ source_language }} to {{ target_language }}\nKeep tone.",
          userTemplate: "Text:\n{{text}}",
        },
      ],
      defaultTemplateId: "tpl-2",
    },
  });

  expect(saved.engine.defaultTemplateId).toBe("tpl-2");
  expect(saved.engine.templates).toEqual([
    {
      id: "tpl-1",
      name: "Minimal",
      systemTemplate: "",
      userTemplate: "\n{{ text }}\n",
    },
    {
      id: "tpl-2",
      name: "Detailed",
      systemTemplate: "From {{ source_language }} to {{ target_language }}\nKeep tone.",
      userTemplate: "Text:\n{{text}}",
    },
  ]);
});

test("presets store: removes only the requested preset", async () => {
  const mem = createMemoryStorage();
  const choices = (): ModelChoiceId[] => [{ id: "m-1" }];
  const store1 = createPresetsStore(mem.storage, choices);
  await store1.load();

  const p1 = await store1.save(makeBaseInput({ name: "First Preset" }));
  const p2 = await store1.save(makeBaseInput({ name: "Second Preset" }));

  await store1.remove(p1.id);
  expect(store1.records()).toEqual([p2]);

  const store2 = createPresetsStore(mem.storage, choices);
  await store2.load();
  expect(store2.records()).toEqual([p2]);

  // Removing a missing preset fails explicitly without overwriting storage.
  const callsBeforeMissing = mem.getSetCalls();
  await expect(store2.remove(p1.id)).rejects.toMatchObject({ key: "not_found" });
  expect(mem.getSetCalls()).toBe(callsBeforeMissing);

  // Storage write failure leaves previous records intact.
  mem.setSetError(new Error("ERR_DISK_LOCKED"));
  await expect(store2.remove(p2.id)).rejects.toMatchObject({ key: "storage_write_failed" });
  expect(store2.records()).toEqual([p2]);
  expect(JSON.parse(mem.backing[PRESETS_STORAGE_KEY]!).items).toEqual([p2]);
});

test("automatic target: saves and restores an automatic target", async () => {
  const mem = createMemoryStorage();
  const choices = (): ModelChoiceId[] => [{ id: "m-1" }];
  const store = createPresetsStore(mem.storage, choices);
  await store.load();

  const saved = await store.save(makeBaseInput({ targetLanguage: "auto" }));
  expect(saved.targetLanguage).toBe("auto");

  const reloaded = createPresetsStore(mem.storage, choices);
  await reloaded.load();
  expect(reloaded.status()).toEqual({ kind: "ready", skippedCount: 0 });
  expect(reloaded.records()[0]!.targetLanguage).toBe("auto");
  expect(JSON.parse(mem.backing[PRESETS_STORAGE_KEY]!).items[0].targetLanguage).toBe("auto");

  const concrete = await store.save(makeBaseInput({ id: saved.id, targetLanguage: "ja" }));
  expect(concrete.targetLanguage).toBe("ja");
  const reloadedConcrete = createPresetsStore(mem.storage, choices);
  await reloadedConcrete.load();
  expect(reloadedConcrete.records()[0]!.targetLanguage).toBe("ja");
});

test("automatic target: rejects an unsupported or missing target", async () => {
  const mem = createMemoryStorage();
  const choices = (): ModelChoiceId[] => [{ id: "m-1" }];
  const store = createPresetsStore(mem.storage, choices);
  await store.load();

  const unsupported = await store
    .save(makeBaseInput({ targetLanguage: "__none__" as unknown as "auto" }))
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect((unsupported as { key?: string } | null)?.key).toBe("target_language_invalid");

  const missing = await store
    .save(makeBaseInput({ targetLanguage: null as unknown as "auto" }))
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect((missing as { key?: string } | null)?.key).toBe("target_language_invalid");
});

test("preset recovery: skips invalid entries and preserves them when modifying valid presets", async () => {
  const valid = {
    ...makeBaseInput(),
    id: "p-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const legacy = { ...valid, id: "p-legacy", name: "Legacy", targetLanguage: null };
  // A malformed entry can even reuse the ID of a valid preset.
  const malformed = { ...valid, targetLanguage: "__none__" };
  const raw = JSON.stringify({ version: 1, items: [legacy, valid, malformed] });
  const mem = createMemoryStorage({ [PRESETS_STORAGE_KEY]: raw });
  const choices = (): ModelChoiceId[] => [{ id: "m-1" }];
  const store = createPresetsStore(mem.storage, choices);

  await store.load();
  expect(store.status()).toEqual({ kind: "ready", skippedCount: 2 });
  expect(store.records()).toEqual([valid]);
  expect(mem.backing[PRESETS_STORAGE_KEY]).toBe(raw);
  expect(mem.getSetCalls()).toBe(0);

  const edited = await store.save(makeBaseInput({ id: valid.id, name: "Edited" }));
  expect(JSON.parse(mem.backing[PRESETS_STORAGE_KEY]!).items).toEqual([legacy, edited, malformed]);

  await store.remove(edited.id);
  expect(store.records()).toEqual([]);
  expect(JSON.parse(mem.backing[PRESETS_STORAGE_KEY]!).items).toEqual([legacy, malformed]);

  const added = await store.save(makeBaseInput({ name: "New preset" }));
  const reopened = createPresetsStore(mem.storage, choices);
  await reopened.load();
  expect(reopened.status()).toEqual({ kind: "ready", skippedCount: 2 });
  expect(reopened.records()).toEqual([added]);
  expect(JSON.parse(mem.backing[PRESETS_STORAGE_KEY]!).items).toEqual([legacy, malformed, added]);
});
