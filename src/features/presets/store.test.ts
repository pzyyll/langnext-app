import { expect, test } from "nsh/test";
import { t } from "nsh/i18n";
import {
  createPresetsStore,
  DEEPL_CREDENTIAL_KEY_PREFIX,
  deepLCredentialStorageKey,
  GOOGLE_CLOUD_CREDENTIAL_KEY_PREFIX,
  googleCloudCredentialStorageKey,
  PRESETS_STORAGE_KEY,
} from "./store";
import type {
  AiPresetEngine,
  ModelChoiceId,
  PresetsStorage,
  SaveAiPresetEngineInput,
  SavePresetInput,
  TranslationPreset,
} from "./types";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  let failGetError: Error | null = null;
  let failSetError: Error | null = null;
  let failSetPredicate: ((key: string) => boolean) | null = null;
  let setCalls = 0;

  const storage: PresetsStorage = {
    getItem: async (key) => {
      if (failGetError) throw failGetError;
      return backing[key] ?? null;
    },
    setItem: async (key, value) => {
      setCalls += 1;
      if (failSetError && (!failSetPredicate || failSetPredicate(key))) throw failSetError;
      backing[key] = value;
    },
    removeItem: async (key) => {
      delete backing[key];
    },
  };

  return {
    backing,
    storage,
    setGetError: (err: Error | null) => {
      failGetError = err;
    },
    setSetError: (err: Error | null, predicate?: (key: string) => boolean) => {
      failSetError = err;
      failSetPredicate = predicate ?? null;
    },
    getSetCalls: () => setCalls,
  };
}

function makeAiEngine(overrides: Partial<SaveAiPresetEngineInput> = {}): SaveAiPresetEngineInput {
  return {
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
    ...overrides,
  };
}

function aiEngine(preset: TranslationPreset): AiPresetEngine {
  if (preset.engine.kind !== "ai") throw new Error("expected an AI preset");
  return preset.engine;
}

function makeDeepLInput(overrides: Partial<SavePresetInput> = {}): SavePresetInput {
  return {
    name: "DeepL Preset",
    enabled: true,
    engine: { kind: "deepl", apiKey: "deepl-key:fx" },
    ...overrides,
  };
}

function deeplRef(preset: TranslationPreset): string {
  if (preset.engine.kind !== "deepl") throw new Error("expected a DeepL preset");
  return preset.engine.credentialRef;
}

function makeGoogleCloudInput(overrides: Partial<SavePresetInput> = {}): SavePresetInput {
  return {
    name: "Google Cloud Preset",
    enabled: true,
    engine: { kind: "google-cloud", apiKey: "google-key" },
    ...overrides,
  };
}

function googleCloudRef(preset: TranslationPreset): string {
  if (preset.engine.kind !== "google-cloud") throw new Error("expected a Google Cloud preset");
  return preset.engine.credentialRef;
}

function makeBaseInput(overrides: Partial<SavePresetInput> = {}): SavePresetInput {
  return {
    name: "Technical EN to ZH",
    enabled: true,
    engine: makeAiEngine(),
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
  expect(created.createdAt).toBeTruthy();
  expect(created.updatedAt).toBeTruthy();
  expect(Object.keys(created).sort()).toEqual([
    "createdAt",
    "enabled",
    "engine",
    "id",
    "name",
    "updatedAt",
  ]);

  const updated = await store1.save(
    makeBaseInput({
      id: created.id,
      name: "Updated Preset",
      enabled: false,
    }),
  );
  expect(updated.id).toBe(created.id);
  expect(updated.createdAt).toBe(created.createdAt);
  expect(updated.name).toBe("Updated Preset");
  expect(updated.enabled).toBe(false);

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
          ...makeAiEngine(),
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
          ...makeAiEngine(),
          modelIds: ["m-1", "m-missing"],
        },
      }),
    ),
  ).rejects.toMatchObject({ key: "model_unavailable", field: "fallbackModel", fallbackIndex: 0 });

  // Temperature uses a fixed 0.0–2.0 grid for both text and numeric inputs.
  for (const temperature of ["-0.1", "hot", "2.1", "1.05", "1e0", 2.1, 1.05]) {
    await expect(
      store.save(makeBaseInput({ engine: { ...makeAiEngine(), temperature } })),
    ).rejects.toMatchObject({ key: "temperature_invalid", field: "temperature" });
  }

  // Max output tokens rejects 0, decimals, and trailing garbage.
  for (const invalidTokens of ["0", "1.5", "12x", "-10", 0, 1.5]) {
    await expect(
      store.save(
        makeBaseInput({
          engine: { ...makeAiEngine(), maxOutputTokens: invalidTokens },
        }),
      ),
    ).rejects.toMatchObject({ key: "max_output_tokens_invalid", field: "maxOutputTokens" });
  }

  // Temperature 0 and valid integer maxOutputTokens persist in exact model order.
  const created = await store.save(
    makeBaseInput({
      engine: {
        ...makeAiEngine(),
        modelIds: ["m-3", "m-1", "m-2"],
        temperature: "0",
        maxOutputTokens: "4096",
      },
    }),
  );
  expect(aiEngine(created).modelIds).toEqual(["m-3", "m-1", "m-2"]);
  expect(aiEngine(created).temperature).toBe(0);
  expect(aiEngine(created).maxOutputTokens).toBe(4096);

  // Blank optional numeric fields normalize to null cleanly.
  const cleared = await store.save(
    makeBaseInput({
      id: created.id,
      engine: {
        ...makeAiEngine(),
        modelIds: ["m-3", "m-2", "m-1"],
        temperature: "   ",
        maxOutputTokens: "",
      },
    }),
  );
  expect(aiEngine(cleared).modelIds).toEqual(["m-3", "m-2", "m-1"]);
  expect(aiEngine(cleared).temperature).toBeNull();
  expect(aiEngine(cleared).maxOutputTokens).toBeNull();

  // Existing bound unavailable models can stay across unrelated edits/reorders, while new unavailable ones fail.
  available = [{ id: "m-1" }];
  const renamedWithStale = await store.save(
    makeBaseInput({
      id: cleared.id,
      name: "Renamed Stale",
      engine: {
        ...makeAiEngine(),
        modelIds: ["m-3", "m-1"],
      },
    }),
  );
  expect(aiEngine(renamedWithStale).modelIds).toEqual(["m-3", "m-1"]);
  await expect(
    store.save(
      makeBaseInput({
        id: renamedWithStale.id,
        engine: {
          ...makeAiEngine(),
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
      engine: { ...makeAiEngine(), templates: [] },
    }),
  ).rejects.toMatchObject({ key: "templates_required", field: "templates" });

  // Duplicate template IDs are rejected.
  await expect(
    store.save({
      ...base,
      engine: {
        ...makeAiEngine(),
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
        ...makeAiEngine(),
        templates: [
          makeAiEngine().templates[0]!,
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
      engine: { ...makeAiEngine(), defaultTemplateId: "tpl-missing" },
    }),
  ).rejects.toMatchObject({ key: "default_template_invalid", field: "defaultTemplate" });

  // Unclosed and unknown variables are rejected with field and templateId.
  await expect(
    store.save({
      ...base,
      engine: {
        ...makeAiEngine(),
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
        ...makeAiEngine(),
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
        ...makeAiEngine(),
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
        ...makeAiEngine(),
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
      ...makeAiEngine(),
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

  expect(aiEngine(saved).defaultTemplateId).toBe("tpl-2");
  expect(aiEngine(saved).templates).toEqual([
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

test("presets store: engine data holds no languages", async () => {
  const mem = createMemoryStorage();
  const choices = (): ModelChoiceId[] => [{ id: "m-1" }];
  const store = createPresetsStore(mem.storage, choices);
  await store.load();

  const created = await store.save(makeBaseInput());
  const raw = mem.backing[PRESETS_STORAGE_KEY]!;
  expect(raw).not.toContain("sourceLanguage");
  expect(raw).not.toContain("targetLanguage");
  expect(JSON.parse(raw).items[0]).toEqual(created);

  const reloaded = createPresetsStore(mem.storage, choices);
  await reloaded.load();
  expect(reloaded.records()).toEqual([created]);

  // A readable record with legacy values stays readable; the next save drops them.
  const legacyMem = createMemoryStorage({
    [PRESETS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      items: [{ ...created, sourceLanguage: "en", targetLanguage: "fr" }],
    }),
  });
  const legacyStore = createPresetsStore(legacyMem.storage, choices);
  await legacyStore.load();
  expect(legacyStore.status()).toEqual({ kind: "ready", skippedCount: 0 });
  expect(legacyStore.records()[0]!.id).toBe(created.id);
  expect(legacyStore.records()[0]!.name).toBe(created.name);

  const edited = await legacyStore.save(makeBaseInput({ id: created.id, name: "Renamed" }));
  expect(Object.keys(edited)).not.toContain("sourceLanguage");
  expect(Object.keys(edited)).not.toContain("targetLanguage");
  const written = JSON.parse(legacyMem.backing[PRESETS_STORAGE_KEY]!).items[0];
  expect(written.sourceLanguage).toBeUndefined();
  expect(written.targetLanguage).toBeUndefined();
  expect(written.name).toBe("Renamed");
});

test("presets store: records a DeepL preset without AI models or the secret", async () => {
  const mem = createMemoryStorage();
  // Saving DeepL must not read the Models snapshot at all.
  const store = createPresetsStore(mem.storage, () => {
    throw new Error("Models must not be read for a DeepL preset");
  });
  await store.load();

  const saved = await store.save(makeDeepLInput({ name: "  DeepL Free  " }));
  expect(saved.name).toBe("DeepL Free");
  expect(saved.engine.kind).toBe("deepl");
  const ref = deeplRef(saved);
  expect(ref.length).toBeGreaterThan(0);
  expect(mem.backing[deepLCredentialStorageKey(ref)]).toBe("deepl-key:fx");

  const raw = mem.backing[PRESETS_STORAGE_KEY]!;
  expect(raw).not.toContain("deepl-key:fx");
  expect(raw).not.toContain("apiKey");
  expect(await store.readDeepLCredential(saved.id)).toBe("deepl-key:fx");
  expect(await store.readDeepLCredential("missing-id")).toBeNull();

  const reloaded = createPresetsStore(mem.storage, () => []);
  await reloaded.load();
  expect(reloaded.records()).toEqual([saved]);
  expect(await reloaded.readDeepLCredential(saved.id)).toBe("deepl-key:fx");
});

test("presets store: validates DeepL keys and locked engine types", async () => {
  const mem = createMemoryStorage();
  const store = createPresetsStore(mem.storage, () => [{ id: "m-1" }]);
  await store.load();

  await expect(store.save(makeDeepLInput({ engine: { kind: "deepl" } }))).rejects.toMatchObject({
    key: "deepl_key_required",
    field: "deeplKey",
  });
  await expect(
    store.save(makeDeepLInput({ engine: { kind: "deepl", apiKey: "   " } })),
  ).rejects.toMatchObject({
    key: "deepl_key_required",
    field: "deeplKey",
  });
  await expect(
    store.save(makeDeepLInput({ engine: { kind: "deepl", apiKey: "deepl key:fx" } })),
  ).rejects.toMatchObject({ key: "deepl_key_invalid", field: "deeplKey" });

  const saved = await store.save(
    makeDeepLInput({ engine: { kind: "deepl", apiKey: "  deepl-key-1:fx  " } }),
  );
  expect(mem.backing[deepLCredentialStorageKey(deeplRef(saved))]).toBe("deepl-key-1:fx");

  // A saved preset keeps its engine type in both directions.
  await expect(
    store.save({ ...makeDeepLInput({ id: saved.id }), engine: makeBaseInput().engine }),
  ).rejects.toMatchObject({ key: "engine_type_locked" });

  const ai = await store.save(makeBaseInput());
  const setCallsBeforeTypeChange = mem.getSetCalls();
  await expect(
    store.save({ ...makeBaseInput({ id: ai.id }), engine: { kind: "deepl", apiKey: "key:fx" } }),
  ).rejects.toMatchObject({ key: "engine_type_locked" });
  expect(mem.getSetCalls()).toBe(setCallsBeforeTypeChange);
});

test("presets store: keeps, replaces, and removes DeepL keys with the record", async () => {
  const mem = createMemoryStorage();
  const store = createPresetsStore(mem.storage, () => []);
  await store.load();

  const saved = await store.save(
    makeDeepLInput({ engine: { kind: "deepl", apiKey: "first-key:fx" } }),
  );
  const firstRef = deeplRef(saved);
  const firstKey = deepLCredentialStorageKey(firstRef);

  // A blank input on edit keeps the stored key and reference.
  const kept = await store.save(
    makeDeepLInput({ id: saved.id, name: "Renamed", engine: { kind: "deepl", apiKey: "   " } }),
  );
  expect(deeplRef(kept)).toBe(firstRef);
  expect(mem.backing[firstKey]).toBe("first-key:fx");

  // Replacement writes a new reference first and removes the old key after the commit.
  const replaced = await store.save(
    makeDeepLInput({ id: saved.id, engine: { kind: "deepl", apiKey: "second-key:fx" } }),
  );
  const secondRef = deeplRef(replaced);
  expect(secondRef).not.toBe(firstRef);
  expect(mem.backing[deepLCredentialStorageKey(secondRef)]).toBe("second-key:fx");
  expect(mem.backing[firstKey]).toBeUndefined();

  // A failed key write leaves the existing record and key untouched.
  mem.setSetError(new Error("ERR_NSH_QUOTA_EXCEEDED"), (key) =>
    key.startsWith(DEEPL_CREDENTIAL_KEY_PREFIX),
  );
  await expect(
    store.save(
      makeDeepLInput({ id: replaced.id, engine: { kind: "deepl", apiKey: "third-key:fx" } }),
    ),
  ).rejects.toMatchObject({ key: "storage_write_failed" });
  expect(store.records()).toEqual([replaced]);
  expect(await store.readDeepLCredential(replaced.id)).toBe("second-key:fx");

  // A failed record write removes the unused new key and keeps the old record usable.
  mem.setSetError(new Error("ERR_DISK_LOCKED"), (key) => key === PRESETS_STORAGE_KEY);
  await expect(
    store.save(
      makeDeepLInput({ id: replaced.id, engine: { kind: "deepl", apiKey: "fourth-key:fx" } }),
    ),
  ).rejects.toMatchObject({ key: "storage_write_failed" });
  expect(store.records()).toEqual([replaced]);
  expect(await store.readDeepLCredential(replaced.id)).toBe("second-key:fx");
  expect(
    Object.keys(mem.backing).filter((key) => key.startsWith(DEEPL_CREDENTIAL_KEY_PREFIX)),
  ).toEqual([deepLCredentialStorageKey(secondRef)]);

  // Delete removes the referenced key.
  mem.setSetError(null);
  await store.remove(replaced.id);
  expect(store.records()).toEqual([]);
  expect(mem.backing[deepLCredentialStorageKey(secondRef)]).toBeUndefined();
});

test("preset recovery: skips invalid entries and preserves them when modifying valid presets", async () => {
  const valid = {
    ...makeBaseInput(),
    id: "p-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const legacy = { ...valid, id: "p-legacy", enabled: "yes" };
  // A malformed entry can even reuse the ID of a valid preset.
  const malformed = { ...valid, engine: { ...valid.engine, modelIds: [] } };
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

test("presets store: Google Cloud records an engine without AI models or the secret", async () => {
  const mem = createMemoryStorage();
  // Saving Google Cloud must not read the Models snapshot at all.
  const store = createPresetsStore(mem.storage, () => {
    throw new Error("Models must not be read for a Google Cloud preset");
  });
  await store.load();

  const saved = await store.save(makeGoogleCloudInput({ name: "  Google Cloud  " }));
  expect(saved.name).toBe("Google Cloud");
  expect(saved.engine.kind).toBe("google-cloud");
  expect(Object.keys(saved).sort()).toEqual([
    "createdAt",
    "enabled",
    "engine",
    "id",
    "name",
    "updatedAt",
  ]);
  const ref = googleCloudRef(saved);
  expect(ref.length).toBeGreaterThan(0);
  expect(mem.backing[googleCloudCredentialStorageKey(ref)]).toBe("google-key");

  const raw = mem.backing[PRESETS_STORAGE_KEY]!;
  expect(raw).not.toContain("google-key");
  expect(raw).not.toContain("apiKey");
  expect(raw).not.toContain("modelIds");
  expect(raw).not.toContain("templates");
  expect(raw).not.toContain("project");
  expect(JSON.parse(raw).items[0]).toEqual(saved);

  expect(await store.readGoogleCloudCredential(saved.id)).toBe("google-key");
  expect(await store.readGoogleCloudCredential("missing-id")).toBeNull();

  const reloaded = createPresetsStore(mem.storage, () => []);
  await reloaded.load();
  expect(reloaded.status()).toEqual({ kind: "ready", skippedCount: 0 });
  expect(reloaded.records()).toEqual([saved]);
  expect(await reloaded.readGoogleCloudCredential(saved.id)).toBe("google-key");
});

test("presets store: Google Cloud validates keys, trims them, and locks the engine type", async () => {
  const mem = createMemoryStorage();
  const store = createPresetsStore(mem.storage, () => [{ id: "m-1" }]);
  await store.load();

  await expect(
    store.save(makeGoogleCloudInput({ engine: { kind: "google-cloud" } })),
  ).rejects.toMatchObject({
    key: "google_cloud_key_required",
    field: "googleCloudKey",
  });
  await expect(
    store.save(makeGoogleCloudInput({ engine: { kind: "google-cloud", apiKey: "   " } })),
  ).rejects.toMatchObject({
    key: "google_cloud_key_required",
    field: "googleCloudKey",
  });
  await expect(
    store.save(makeGoogleCloudInput({ engine: { kind: "google-cloud", apiKey: "google key" } })),
  ).rejects.toMatchObject({ key: "google_cloud_key_invalid", field: "googleCloudKey" });

  const saved = await store.save(
    makeGoogleCloudInput({ engine: { kind: "google-cloud", apiKey: "  google-key-1  " } }),
  );
  expect(mem.backing[googleCloudCredentialStorageKey(googleCloudRef(saved))]).toBe("google-key-1");

  // Key reads are engine-scoped: AI, DeepL, and unknown IDs return null.
  const ai = await store.save(makeBaseInput());
  const deepl = await store.save(makeDeepLInput());
  expect(await store.readGoogleCloudCredential(ai.id)).toBeNull();
  expect(await store.readGoogleCloudCredential(deepl.id)).toBeNull();

  // A saved preset keeps its engine type in both directions.
  await expect(
    store.save({
      ...makeGoogleCloudInput({ id: saved.id }),
      engine: { kind: "deepl", apiKey: "k:fx" },
    }),
  ).rejects.toMatchObject({ key: "engine_type_locked" });
  await expect(
    store.save({ ...makeBaseInput({ id: ai.id }), engine: makeGoogleCloudInput().engine }),
  ).rejects.toMatchObject({ key: "engine_type_locked" });
});

test("presets store: Google Cloud keeps, replaces, and removes keys with the record", async () => {
  const mem = createMemoryStorage();
  const store = createPresetsStore(mem.storage, () => []);
  await store.load();

  const saved = await store.save(
    makeGoogleCloudInput({ engine: { kind: "google-cloud", apiKey: "first-google-key" } }),
  );
  const firstRef = googleCloudRef(saved);
  const firstKey = googleCloudCredentialStorageKey(firstRef);

  // A blank input on edit keeps the stored key and reference.
  const kept = await store.save(
    makeGoogleCloudInput({
      id: saved.id,
      name: "Renamed",
      engine: { kind: "google-cloud", apiKey: "   " },
    }),
  );
  expect(googleCloudRef(kept)).toBe(firstRef);
  expect(mem.backing[firstKey]).toBe("first-google-key");

  // Replacement writes a new reference first and removes the old key after the commit.
  const replaced = await store.save(
    makeGoogleCloudInput({
      id: saved.id,
      engine: { kind: "google-cloud", apiKey: "second-google-key" },
    }),
  );
  const secondRef = googleCloudRef(replaced);
  expect(secondRef).not.toBe(firstRef);
  expect(mem.backing[googleCloudCredentialStorageKey(secondRef)]).toBe("second-google-key");
  expect(mem.backing[firstKey]).toBeUndefined();

  // A failed key write leaves the existing record and key untouched.
  mem.setSetError(new Error("ERR_NSH_QUOTA_EXCEEDED"), (key) =>
    key.startsWith(GOOGLE_CLOUD_CREDENTIAL_KEY_PREFIX),
  );
  await expect(
    store.save(
      makeGoogleCloudInput({
        id: replaced.id,
        engine: { kind: "google-cloud", apiKey: "third-google-key" },
      }),
    ),
  ).rejects.toMatchObject({ key: "storage_write_failed" });
  expect(store.records()).toEqual([replaced]);
  expect(await store.readGoogleCloudCredential(replaced.id)).toBe("second-google-key");

  // A failed record write removes the unused new key and keeps the old record usable.
  mem.setSetError(new Error("ERR_DISK_LOCKED"), (key) => key === PRESETS_STORAGE_KEY);
  await expect(
    store.save(
      makeGoogleCloudInput({
        id: replaced.id,
        engine: { kind: "google-cloud", apiKey: "fourth-google-key" },
      }),
    ),
  ).rejects.toMatchObject({ key: "storage_write_failed" });
  expect(store.records()).toEqual([replaced]);
  expect(await store.readGoogleCloudCredential(replaced.id)).toBe("second-google-key");
  expect(
    Object.keys(mem.backing).filter((key) => key.startsWith(GOOGLE_CLOUD_CREDENTIAL_KEY_PREFIX)),
  ).toEqual([googleCloudCredentialStorageKey(secondRef)]);

  // A failed key read reports localized copy without the storage exception text.
  mem.setSetError(null);
  mem.setGetError(new Error("ERR_SECRET_READ_FAILED"));
  let readError: unknown = null;
  try {
    await store.readGoogleCloudCredential(replaced.id);
  } catch (error) {
    readError = error;
  }
  expect(readError).toMatchObject({
    key: "storage_read_failed",
    message: t("presets.error.googleCloudKeyUnreadable"),
  });
  expect((readError as Error).message).not.toContain("ERR_SECRET_READ_FAILED");
  mem.setGetError(null);

  // Delete removes the referenced key.
  await store.remove(replaced.id);
  expect(store.records()).toEqual([]);
  expect(mem.backing[googleCloudCredentialStorageKey(secondRef)]).toBeUndefined();
});
