import { expect, open, test } from "nsh/test";
import type { ProviderChannel, ProviderModel } from "./types";

const APP_ENTRY = "../../App.tsx";

const viewport = { width: 1040, height: 720, platform: "windows" as const };

function sampleChannels(): ProviderChannel[] {
  return [
    {
      id: "ch-openai",
      displayName: "OpenAI Main",
      adapterId: "openai-compatible",
      baseUrl: null,
      hasCredential: true,
      enabled: true,
      sortOrder: 0,
      revision: 1,
      insecureHttpConfirmedAt: null,
      modelsLastSyncedAt: null,
      modelsLastSyncError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "ch-claude",
      displayName: "Claude Team",
      adapterId: "anthropic",
      baseUrl: "https://api.anthropic.com",
      hasCredential: true,
      enabled: false,
      sortOrder: 1,
      revision: 1,
      insecureHttpConfirmedAt: null,
      modelsLastSyncedAt: null,
      modelsLastSyncError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
}

function sampleModels(): ProviderModel[] {
  return [
    {
      id: "m-existing",
      providerId: "ch-openai",
      modelKey: "gpt-4o",
      sourceAdapterId: "openai-compatible",
      origin: "remote",
      syncStatus: "active",
      enabled: true,
      displayName: "GPT-4o",
      displayNameOverride: "Custom GPT-4o",
      apiTypeOverride: null,
      capabilities: { text: true, image: true, pdf: false, video: false },
      capabilitiesOverride: { pdf: true },
      contextLimit: 128_000,
      maxTokens: 16_384,
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "m-legacy",
      providerId: "ch-openai",
      modelKey: "legacy-gpt",
      sourceAdapterId: "openai-compatible",
      origin: "remote",
      syncStatus: "active",
      enabled: false,
      displayName: "Legacy GPT",
      displayNameOverride: null,
      apiTypeOverride: null,
      capabilities: { text: true, image: false, pdf: false, video: false },
      capabilitiesOverride: null,
      contextLimit: null,
      maxTokens: null,
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "m-manual",
      providerId: "ch-openai",
      modelKey: "custom-local",
      sourceAdapterId: "openai-compatible",
      origin: "manual",
      syncStatus: "active",
      enabled: true,
      displayName: null,
      displayNameOverride: "Local Model",
      apiTypeOverride: null,
      capabilities: { text: true, image: false, pdf: false, video: false },
      capabilitiesOverride: null,
      contextLimit: null,
      maxTokens: null,
      lastSeenAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
}

function seededStorage(
  channels = sampleChannels(),
  models = sampleModels(),
): Record<string, string> {
  return {
    "settings.language": "en",
    "models.providers": JSON.stringify(channels),
    "models.items": JSON.stringify(models),
    "models.credentials.ch-openai": "sk-openai-secret",
    "models.credentials.ch-claude": "sk-ant-secret",
  };
}

test("creates a new channel with non-loopback HTTP confirmation and stores secrets separately", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  expect(app.shows("id:empty-add-channel-button")).toBe(true);

  await app.press("id:empty-add-channel-button");
  await app.waitFor("id:add-channel-dialog");

  await app.press("id:confirm-add-channel");
  expect(app.texts()).toContain("Display name is required.");

  await app.type("id:add-channel-name-input", "Self Hosted");
  await app.type("id:add-channel-url-input", "http://192.168.1.50:8080/v1");
  await app.waitFor("id:add-channel-insecure-checkbox");

  await app.press("id:confirm-add-channel");
  expect(app.texts()).toContain("Confirm unencrypted http:// before saving this channel.");

  await app.press("id:add-channel-insecure-checkbox");
  await app.type("id:add-channel-token-input", "sk-secret-token-123");
  await app.press("id:confirm-add-channel");

  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));
  expect(app.shows("id:provider-editor")).toBe(true);
  expect(app.texts()).toContain("Self Hosted");

  const storedProvidersRaw = app.storage()["models.providers"];
  const storedProviders = JSON.parse(storedProvidersRaw!) as ProviderChannel[];
  expect(storedProviders).toHaveLength(1);
  expect(storedProviders[0]!.displayName).toBe("Self Hosted");
  expect(storedProviders[0]!.hasCredential).toBe(true);
  expect(storedProviders[0]!.insecureHttpConfirmedAt).not.toBeNull();
  expect(storedProvidersRaw).not.toContain("sk-secret-token-123");
  expect(app.storage()[`models.credentials.${storedProviders[0]!.id}`]).toBe("sk-secret-token-123");
});

test("supports inline rename, channel toggle, dirty guard, cancel/save, and token reset", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: seededStorage(),
  });

  await app.press("id:rename-channel-button");
  await app.waitFor("id:rename-channel-input");
  await app.clear("id:rename-channel-input");
  await app.type("id:rename-channel-input", "OpenAI Renamed");
  await app.press("id:confirm-rename-channel");
  await app.waitUntil(() => !app.shows("id:rename-channel-input"));
  expect(app.texts()).toContain("OpenAI Renamed");

  await app.press("id:channel-enabled-switch");
  const afterToggle = JSON.parse(app.storage()["models.providers"]!) as ProviderChannel[];
  expect(afterToggle[0]!.enabled).toBe(false);

  expect(app.enabled("id:test-connection-button")).toBe(true);
  await app.type("id:connection-url-input", "https://proxy.example.com/v1");
  expect(app.texts()).toContain("Unsaved");
  expect(app.enabled("id:test-connection-button")).toBe(false);
  expect(app.enabled("id:get-models-button")).toBe(false);

  await app.press("id:cancel-channel-button");
  expect(app.value("id:connection-url-input")).toBe("");
  expect(app.enabled("id:test-connection-button")).toBe(true);

  await app.press("id:clear-token-button");
  expect(app.shows("id:keep-token-button")).toBe(true);
  await app.press("id:save-channel-button");

  await app.waitUntil(() => app.storage()["models.credentials.ch-openai"] === undefined);
  const afterSave = JSON.parse(app.storage()["models.providers"]!) as ProviderChannel[];
  expect(afterSave[0]!.hasCredential).toBe(false);
});

test("reorders channels and deletes a channel with its models and credentials", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: seededStorage(),
  });

  await app.press("id:channel-item-ch-claude");
  expect(app.texts()).toContain("Claude Team");

  await app.press("label:Move Claude Team up");
  const reordered = JSON.parse(app.storage()["models.providers"]!) as ProviderChannel[];
  expect(reordered[0]!.id).toBe("ch-claude");
  expect(reordered[1]!.id).toBe("ch-openai");

  await app.press("id:delete-channel-button");
  await app.waitFor("id:delete-channel-dialog");
  await app.press("role:button[Delete]");
  await app.waitUntil(() => !app.shows("id:delete-channel-dialog"));

  const remaining = JSON.parse(app.storage()["models.providers"]!) as ProviderChannel[];
  expect(remaining).toHaveLength(1);
  expect(remaining[0]!.id).toBe("ch-openai");
  expect(app.storage()["models.credentials.ch-claude"]).toBeUndefined();
});

test("tests connection and syncs remote models while preserving overrides and manual entries", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: seededStorage(),
    network: {
      "GET https://api.openai.com/v1/models": {
        status: 200,
        body: {
          data: [{ id: "gpt-4o" }, { id: "gpt-4.1-mini" }],
        },
      },
      "GET https://api.anthropic.com/v1/models*": (req) => {
        if (req.url.includes("after_id=gpt-4o")) {
          return {
            status: 200,
            body: {
              data: [{ id: "claude-sonnet-4-20250514", display_name: "Claude Sonnet 4" }],
              has_more: false,
            },
          };
        }
        return {
          status: 200,
          body: {
            data: [{ id: "gpt-4o" }],
            has_more: true,
            last_id: "gpt-4o",
          },
        };
      },
    },
  });

  await app.press("id:test-connection-button");
  await app.waitUntil(() => app.texts().some((t) => t.includes("2 models reachable")));
  expect(app.requests()[0]!.headers.authorization).toBe("Bearer sk-openai-secret");

  await app.press("id:get-models-button");
  await app.waitUntil(() => app.shows("id:model-row-gpt-4.1-mini"));

  expect(app.texts()).toContain("Custom GPT-4o");
  expect(app.texts()).toContain("Local Model");
  expect(app.texts()).toContain("Missing");

  const storedModels = JSON.parse(app.storage()["models.items"]!) as ProviderModel[];
  const added = storedModels.find((m) => m.modelKey === "gpt-4.1-mini");
  const kept = storedModels.find((m) => m.modelKey === "gpt-4o");
  const legacy = storedModels.find((m) => m.modelKey === "legacy-gpt");
  const manual = storedModels.find((m) => m.modelKey === "custom-local");

  expect(added?.enabled).toBe(false);
  expect(kept?.enabled).toBe(true);
  expect(kept?.displayNameOverride).toBe("Custom GPT-4o");
  expect(kept?.capabilitiesOverride?.pdf).toBe(true);
  expect(legacy?.syncStatus).toBe("missing");
  expect(manual?.origin).toBe("manual");

  await app.press("id:sync-protocol-select");
  await app.waitFor("role:option[Anthropic Messages]");
  await app.press("role:option[Anthropic Messages]");
  await app.press("id:get-models-button");
  await app.waitUntil(() => app.shows("id:model-row-claude-sonnet-4-20250514"));

  const antRequests = app.requests().filter((r) => r.url.includes("anthropic.com/v1/models"));
  expect(antRequests.length).toBe(2);
  expect(antRequests[0]!.headers["anthropic-version"]).toBe("2023-06-01");
  expect(app.texts()).toContain("Source: Anthropic Messages");
});

test("records normalized sync errors without losing existing models", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: seededStorage(),
    network: {
      "GET https://api.openai.com/v1/models": {
        status: 401,
        body: { error: { message: "Unauthorized" } },
      },
    },
  });

  await app.press("id:get-models-button");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("Authentication failed (HTTP 401)")),
  );
  expect(app.shows("id:model-row-gpt-4o")).toBe(true);
});

test("adds manual models, configures model overrides, searches, persists filter, and bulk deletes", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: seededStorage(),
  });

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "o4-mini");
  await app.type("id:add-model-name-input", "O4 Mini");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));
  expect(app.shows("id:model-row-o4-mini")).toBe(true);

  await app.press("id:configure-model-o4-mini");
  await app.waitFor("id:edit-model-dialog");
  await app.clear("id:edit-model-name-input");
  await app.type("id:edit-model-name-input", "O4 Reasoning");
  await app.press("id:edit-model-cap-image");
  await app.press("id:edit-model-cap-pdf");
  await app.type("id:edit-model-context-input", "200000");
  await app.type("id:edit-model-max-tokens-input", "32768");
  await app.press("id:confirm-edit-model");
  await app.waitUntil(() => !app.shows("id:edit-model-dialog"));

  expect(app.texts()).toContain("O4 Reasoning");
  expect(app.texts()).toContain("200K ctx");
  expect(app.texts()).toContain("32768 out");

  await app.type("id:models-search-input", "Custom GPT");
  expect(app.shows("id:model-row-gpt-4o")).toBe(true);
  expect(app.shows("id:model-row-legacy-gpt")).toBe(false);
  await app.press("label:Clear model search");
  expect(app.shows("id:model-row-legacy-gpt")).toBe(true);

  await app.press("id:models-filter-select");
  await app.waitFor("role:option[Disabled]");
  await app.press("role:option[Disabled]");
  expect(app.storage()["models.enabledFilter"]).toBe("disabled");
  expect(app.shows("id:model-row-legacy-gpt")).toBe(true);
  expect(app.shows("id:model-row-gpt-4o")).toBe(false);

  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: app.storage(),
  });
  expect(reopened.shows("id:model-row-legacy-gpt")).toBe(true);
  expect(reopened.shows("id:model-row-gpt-4o")).toBe(false);

  await reopened.press("id:select-models-button");
  await reopened.press("id:select-all-models-checkbox");
  await reopened.press("id:bulk-delete-models-button");
  await reopened.waitFor("id:bulk-delete-models-dialog");
  await reopened.press("role:button[Delete]");
  await reopened.waitUntil(() => !reopened.shows("id:bulk-delete-models-dialog"));
  expect(reopened.shows("id:model-row-legacy-gpt")).toBe(false);
});

test("renders cleanly at the minimum viewport in dark mode with reduced motion", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    width: 720,
    height: 520,
    colorScheme: "dark",
    reducedMotion: true,
    storage: seededStorage(),
  });

  expect(app.shows("id:models-page")).toBe(true);
  expect(app.shows("id:channels-rail")).toBe(true);
  expect(app.shows("id:provider-editor")).toBe(true);
  expect(app.shows("id:model-row-gpt-4o")).toBe(true);

  await app.press("id:toggle-model-legacy-gpt");
  const updated = JSON.parse(app.storage()["models.items"]!) as ProviderModel[];
  expect(updated.find((m) => m.modelKey === "legacy-gpt")?.enabled).toBe(true);
});
