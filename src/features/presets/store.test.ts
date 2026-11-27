import { expect, test } from "nsh/test";
import { t } from "nsh/i18n";
import { googleCloudUsageStorageKey } from "./google-cloud-usage";
import {
  createPresetsStore,
  DEEPL_CREDENTIAL_KEY_PREFIX,
  deepLCredentialStorageKey,
  DEEPLX_TOKEN_KEY_PREFIX,
  deeplxTokenStorageKey,
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

function makeDeepLXInput(overrides: Partial<SavePresetInput> = {}): SavePresetInput {
  return {
    name: "DeepLX Preset",
    enabled: true,
    engine: { kind: "deeplx", endpointUrl: "http://localhost:1188/translate" },
    ...overrides,
  };
}

function deeplxRef(preset: TranslationPreset): string | null {
  if (preset.engine.kind !== "deeplx") throw new Error("expected a DeepLX preset");
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

function makeGoogleWebInput(overrides: Partial<SavePresetInput> = {}): SavePresetInput {
  return {
    name: "Google Web Preset",
    enabled: true,
    engine: { kind: "google-web" },
    ...overrides,
  };
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

test("presets store: renames a saved preset without touching its engine or key", async () => {
  const mem = createMemoryStorage();
  const choices = (): ModelChoiceId[] => [{ id: "m-1" }];
  const store = createPresetsStore(mem.storage, choices);
  await store.load();

  const saved = await store.save(makeDeepLInput({ name: "  DeepL Free  " }));
  const ref = deeplRef(saved);
  const setCallsBeforeRename = mem.getSetCalls();

  // The title trims, persists on its own, and keeps the engine's key reference.
  const renamed = await store.rename(saved.id, "  DeepL Paid  ");
  expect(renamed.name).toBe("DeepL Paid");
  expect(renamed.engine).toEqual(saved.engine);
  expect(renamed.createdAt).toBe(saved.createdAt);
  expect(store.records()).toEqual([renamed]);
  expect(mem.getSetCalls()).toBe(setCallsBeforeRename + 1);
  const reloaded = createPresetsStore(mem.storage, choices);
  await reloaded.load();
  expect(reloaded.records()[0]!.name).toBe("DeepL Paid");
  expect(mem.backing[deepLCredentialStorageKey(ref)]).toBe("deepl-key:fx");

  // Renaming to the stored title writes nothing.
  expect(await store.rename(saved.id, "DeepL Paid")).toEqual(renamed);
  expect(mem.getSetCalls()).toBe(setCallsBeforeRename + 1);

  // An empty title and an unknown preset are refused.
  await expect(store.rename(saved.id, "   ")).rejects.toMatchObject({ key: "name_required" });
  await expect(store.rename("missing-id", "Next")).rejects.toMatchObject({ key: "not_found" });
  expect(store.records()).toEqual([renamed]);

  // A failed write keeps the stored title.
  mem.setSetError(new Error("DISK_FULL"));
  await expect(store.rename(saved.id, "Lost Name")).rejects.toMatchObject({
    key: "storage_write_failed",
  });
  expect(store.records()[0]!.name).toBe("DeepL Paid");
  expect(mem.getSetCalls()).toBe(setCallsBeforeRename + 2);

  // Renaming before the store loaded is refused, as every other write is.
  const unloaded = createPresetsStore(mem.storage, choices);
  await expect(unloaded.rename(saved.id, "Early")).rejects.toMatchObject({
    key: "storage_unreadable",
  });
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

test("Google Web preset: saves, reloads, renames, and removes with no credential or usage record", async () => {
  const mem = createMemoryStorage();
  let catalogReads = 0;
  const catalog = (): ModelChoiceId[] => {
    catalogReads += 1;
    return [{ id: "m-1" }];
  };
  const store = createPresetsStore(mem.storage, catalog);
  await store.load();

  const saved = await store.save(makeGoogleWebInput({ name: "  Google Web  " }));
  expect(saved.name).toBe("Google Web");
  expect(saved.enabled).toBe(true);
  expect(saved.engine).toEqual({ kind: "google-web" });
  expect(Object.keys(saved.engine)).toEqual(["kind"]);
  expect(catalogReads).toBe(0);
  expect(Object.keys(mem.backing)).toEqual([PRESETS_STORAGE_KEY]);
  expect(mem.getSetCalls()).toBe(1);
  expect(await store.readDeepLCredential(saved.id)).toBeNull();
  expect(await store.readGoogleCloudCredential(saved.id)).toBeNull();

  const raw = mem.backing[PRESETS_STORAGE_KEY]!;
  expect(raw).not.toContain("apiKey");
  expect(raw).not.toContain("credentialRef");
  expect(raw).not.toContain("modelIds");
  expect(JSON.parse(raw).items[0]).toEqual(saved);

  const reloaded = createPresetsStore(mem.storage, catalog);
  await reloaded.load();
  expect(reloaded.status()).toEqual({ kind: "ready", skippedCount: 0 });
  expect(reloaded.records()).toEqual([saved]);

  const renamed = await reloaded.save(
    makeGoogleWebInput({ id: saved.id, name: "  Renamed Google Web  ", enabled: false }),
  );
  expect(renamed.id).toBe(saved.id);
  expect(renamed.name).toBe("Renamed Google Web");
  expect(renamed.enabled).toBe(false);
  expect(renamed.engine).toEqual({ kind: "google-web" });
  expect(reloaded.records()).toEqual([renamed]);
  expect(Object.keys(mem.backing)).toEqual([PRESETS_STORAGE_KEY]);

  // The saved kind stays locked in both directions.
  await expect(
    reloaded.save({
      id: renamed.id,
      name: renamed.name,
      enabled: true,
      engine: makeAiEngine(),
    }),
  ).rejects.toMatchObject({ key: "engine_type_locked" });
  const ai = await reloaded.save(makeBaseInput());
  await expect(
    reloaded.save({
      id: ai.id,
      name: ai.name,
      enabled: true,
      engine: { kind: "google-web" },
    }),
  ).rejects.toMatchObject({ key: "engine_type_locked" });

  await reloaded.remove(renamed.id);
  expect(reloaded.records()).toEqual([ai]);
  expect(Object.keys(mem.backing)).toEqual([PRESETS_STORAGE_KEY]);
  expect(JSON.parse(mem.backing[PRESETS_STORAGE_KEY]!).items).toEqual([ai]);
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

  // Delete removes the referenced key and the preset's monthly usage.
  const usageKey = googleCloudUsageStorageKey(replaced.id);
  mem.backing[usageKey] = JSON.stringify({ version: 1, month: "2026-11", characters: 10 });
  await store.remove(replaced.id);
  expect(store.records()).toEqual([]);
  expect(mem.backing[googleCloudCredentialStorageKey(secondRef)]).toBeUndefined();
  expect(mem.backing[usageKey]).toBeUndefined();
});

test("DeepLX preset: saves and reloads an endpoint without a model catalog or token", async () => {
  const mem = createMemoryStorage();
  let catalogReads = 0;
  const store = createPresetsStore(mem.storage, () => {
    catalogReads += 1;
    throw new Error("Models must not be read for a DeepLX preset");
  });
  await store.load();

  const saved = await store.save(
    makeDeepLXInput({
      name: "  DeepLX Local  ",
      engine: { kind: "deeplx", endpointUrl: "  http://localhost:1188/dlx/translate/  " },
    }),
  );
  expect(saved.name).toBe("DeepLX Local");
  expect(saved.engine).toEqual({
    kind: "deeplx",
    endpointUrl: "http://localhost:1188/dlx/translate",
    credentialRef: null,
  });
  expect(catalogReads).toBe(0);
  expect(Object.keys(mem.backing)).toEqual([PRESETS_STORAGE_KEY]);
  expect(mem.getSetCalls()).toBe(1);
  expect(await store.readDeepLXToken(null)).toBeNull();
  expect(await store.readDeepLXToken("missing-ref")).toBeNull();

  const reloaded = createPresetsStore(mem.storage, () => []);
  await reloaded.load();
  expect(reloaded.status()).toEqual({ kind: "ready", skippedCount: 0 });
  expect(reloaded.records()).toEqual([saved]);
  expect(await reloaded.readDeepLXToken(null)).toBeNull();
});

test("DeepLX preset: keeps, replaces, and clears the token at a matching or changed endpoint", async () => {
  const mem = createMemoryStorage();
  const store = createPresetsStore(mem.storage, () => []);
  await store.load();

  const saved = await store.save(
    makeDeepLXInput({
      engine: {
        kind: "deeplx",
        endpointUrl: "http://localhost:1188/translate",
        token: "  first-token  ",
      },
    }),
  );
  const firstRef = deeplxRef(saved)!;
  expect(firstRef.length).toBeGreaterThan(0);
  expect(mem.backing[deeplxTokenStorageKey(firstRef)]).toBe("first-token");
  expect(await store.readDeepLXToken(firstRef)).toBe("first-token");

  // An untouched token at the same normalized URL keeps its reference.
  const kept = await store.save(
    makeDeepLXInput({
      id: saved.id,
      name: "Renamed",
      engine: { kind: "deeplx", endpointUrl: "http://localhost:1188/translate/" },
    }),
  );
  expect(deeplxRef(kept)).toBe(firstRef);
  expect(mem.backing[deeplxTokenStorageKey(firstRef)]).toBe("first-token");

  // A replacement writes a new entry first and removes the old one after the commit.
  const replaced = await store.save(
    makeDeepLXInput({
      id: saved.id,
      engine: {
        kind: "deeplx",
        endpointUrl: "http://localhost:1188/translate",
        token: "second-token",
      },
    }),
  );
  const secondRef = deeplxRef(replaced)!;
  expect(secondRef).not.toBe(firstRef);
  expect(await store.readDeepLXToken(secondRef)).toBe("second-token");
  expect(mem.backing[deeplxTokenStorageKey(firstRef)]).toBeUndefined();

  // An explicit null clears the token.
  const cleared = await store.save(
    makeDeepLXInput({
      id: saved.id,
      engine: {
        kind: "deeplx",
        endpointUrl: "http://localhost:1188/translate",
        token: null,
      },
    }),
  );
  expect(deeplxRef(cleared)).toBeNull();
  expect(mem.backing[deeplxTokenStorageKey(secondRef)]).toBeUndefined();

  // A changed URL drops an untouched token and can authorize the new URL.
  const authorized = await store.save(
    makeDeepLXInput({
      id: saved.id,
      engine: {
        kind: "deeplx",
        endpointUrl: "http://localhost:1188/translate",
        token: "third-token",
      },
    }),
  );
  const thirdRef = deeplxRef(authorized)!;
  const moved = await store.save(
    makeDeepLXInput({
      id: saved.id,
      engine: { kind: "deeplx", endpointUrl: "http://localhost:1188/dlx/translate" },
    }),
  );
  expect(deeplxRef(moved)).toBeNull();
  expect(mem.backing[deeplxTokenStorageKey(thirdRef)]).toBeUndefined();

  // An explicit null at another new URL also clears and never authorizes it.
  const authorizedMoved = await store.save(
    makeDeepLXInput({
      id: saved.id,
      engine: {
        kind: "deeplx",
        endpointUrl: "http://localhost:1188/dlx/translate",
        token: "fourth-token",
      },
    }),
  );
  const fourthRef = deeplxRef(authorizedMoved)!;
  const movedAgain = await store.save(
    makeDeepLXInput({
      id: saved.id,
      engine: {
        kind: "deeplx",
        endpointUrl: "https://example.com/translate",
        token: null,
      },
    }),
  );
  expect(deeplxRef(movedAgain)).toBeNull();
  expect(mem.backing[deeplxTokenStorageKey(fourthRef)]).toBeUndefined();
});

test("DeepLX preset: validates the endpoint and token and locks the engine type", async () => {
  const mem = createMemoryStorage();
  const store = createPresetsStore(mem.storage, () => [{ id: "m-1" }]);
  await store.load();

  for (const endpointUrl of [
    "",
    "not a url",
    "http://example.com/translate",
    "https://example.com/v2/translate",
    "https://example.com/translate?token=x",
  ]) {
    await expect(
      store.save(makeDeepLXInput({ engine: { kind: "deeplx", endpointUrl } })),
    ).rejects.toMatchObject({ key: "deeplx_endpoint_invalid", field: "deeplxEndpoint" });
  }
  for (const token of ["", "   ", "has space", "café"]) {
    await expect(
      store.save(
        makeDeepLXInput({
          engine: {
            kind: "deeplx",
            endpointUrl: "https://example.com/translate",
            token,
          },
        }),
      ),
    ).rejects.toMatchObject({ key: "deeplx_token_invalid", field: "deeplxToken" });
  }
  expect(mem.getSetCalls()).toBe(0);

  const saved = await store.save(
    makeDeepLXInput({
      engine: {
        kind: "deeplx",
        endpointUrl: " https://example.com/dlx/translate/ ",
        token: " token-1 ",
      },
    }),
  );
  expect(saved.engine).toMatchObject({
    kind: "deeplx",
    endpointUrl: "https://example.com/dlx/translate",
  });
  expect(await store.readDeepLXToken(deeplxRef(saved))).toBe("token-1");

  // A saved preset keeps its engine type in both directions.
  await expect(
    store.save({ ...makeDeepLXInput({ id: saved.id }), engine: makeBaseInput().engine }),
  ).rejects.toMatchObject({ key: "engine_type_locked" });
  const ai = await store.save(makeBaseInput());
  await expect(
    store.save({ ...makeBaseInput({ id: ai.id }), engine: makeDeepLXInput().engine }),
  ).rejects.toMatchObject({ key: "engine_type_locked" });
});

test("DeepLX preset: failed writes leave the prior endpoint and token usable", async () => {
  const mem = createMemoryStorage();
  const store = createPresetsStore(mem.storage, () => []);
  await store.load();

  const saved = await store.save(
    makeDeepLXInput({
      engine: {
        kind: "deeplx",
        endpointUrl: "https://example.com/translate",
        token: "first-token",
      },
    }),
  );
  const firstRef = deeplxRef(saved)!;

  // A failed token write leaves the record and its token untouched.
  mem.setSetError(new Error("ERR_NSH_QUOTA_EXCEEDED"), (key) =>
    key.startsWith(DEEPLX_TOKEN_KEY_PREFIX),
  );
  await expect(
    store.save(
      makeDeepLXInput({
        id: saved.id,
        engine: {
          kind: "deeplx",
          endpointUrl: "https://example.com/translate",
          token: "second-token",
        },
      }),
    ),
  ).rejects.toMatchObject({ key: "storage_write_failed" });
  expect(store.records()).toEqual([saved]);
  expect(await store.readDeepLXToken(firstRef)).toBe("first-token");

  // A failed record write removes the unused new token and keeps the old record usable.
  mem.setSetError(new Error("ERR_DISK_LOCKED"), (key) => key === PRESETS_STORAGE_KEY);
  await expect(
    store.save(
      makeDeepLXInput({
        id: saved.id,
        engine: {
          kind: "deeplx",
          endpointUrl: "https://example.com/translate",
          token: "third-token",
        },
      }),
    ),
  ).rejects.toMatchObject({ key: "storage_write_failed" });
  expect(store.records()).toEqual([saved]);
  expect(await store.readDeepLXToken(firstRef)).toBe("first-token");
  expect(Object.keys(mem.backing).filter((key) => key.startsWith(DEEPLX_TOKEN_KEY_PREFIX))).toEqual(
    [deeplxTokenStorageKey(firstRef)],
  );
});

test("DeepLX preset: reports an unreadable token with localized copy and deletes it with the record", async () => {
  const mem = createMemoryStorage();
  const store = createPresetsStore(mem.storage, () => []);
  await store.load();

  const saved = await store.save(
    makeDeepLXInput({
      engine: {
        kind: "deeplx",
        endpointUrl: "https://example.com/translate",
        token: "token-1",
      },
    }),
  );
  const ref = deeplxRef(saved)!;

  mem.setGetError(new Error("ERR_SECRET_READ_FAILED"));
  let readError: unknown = null;
  try {
    await store.readDeepLXToken(ref);
  } catch (error) {
    readError = error;
  }
  expect(readError).toMatchObject({
    key: "storage_read_failed",
    message: t("presets.error.deeplxTokenUnreadable"),
  });
  expect((readError as Error).message).not.toContain("ERR_SECRET_READ_FAILED");
  mem.setGetError(null);

  await store.remove(saved.id);
  expect(store.records()).toEqual([]);
  expect(mem.backing[deeplxTokenStorageKey(ref)]).toBeUndefined();
});
