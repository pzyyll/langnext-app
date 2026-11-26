import { expect, open, test } from "nsh/test";

const APP_ENTRY = "./__tests__/capability-section-app.tsx";
const STORAGE_KEY = "integrations.test.v1";
const VAULT_NAMESPACE = "secret.test";
const viewport = { width: 900, height: 700, platform: "windows" as const };

interface SeedChannel {
  enabled?: boolean;
  configured?: boolean;
  config?: unknown;
  credentialRef?: string | null;
}

function record(order: readonly string[], channels: Record<string, SeedChannel>): string {
  const stored: Record<string, unknown> = {};
  for (const [id, channel] of Object.entries(channels)) {
    stored[id] = {
      enabled: channel.enabled ?? false,
      configured: channel.configured ?? false,
      config: channel.config ?? { mode: "saved" },
      credentialRef: channel.credentialRef ?? null,
    };
  }
  return JSON.stringify({ version: 1, order, channels: stored });
}

function storedRecord(app: { storage: () => Record<string, string> }) {
  return JSON.parse(app.storage()[STORAGE_KEY] ?? "null") as {
    version: number;
    order: string[];
    channels: Record<
      string,
      {
        enabled: boolean;
        configured: boolean;
        config: { mode: string };
        credentialRef: string | null;
      }
    >;
  };
}

test("capability section: shows the empty state and adds a channel from the dialog", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  await app.waitFor("id:settings-test-empty");
  expect(app.texts()).toContain("No speech channels yet");
  expect(app.shows("id:settings-test-add")).toBe(true);

  await app.press("id:settings-test-add");
  await app.waitFor("id:settings-test-add-dialog");
  expect(app.shows("id:settings-test-option-alpha")).toBe(true);
  expect(app.shows("id:settings-test-option-beta")).toBe(true);
  expect(app.shows("id:settings-test-option-free")).toBe(true);

  await app.press("id:settings-test-option-alpha");
  await app.waitFor("id:settings-test-detail-card");
  expect(storedRecord(app).order).toEqual(["alpha"]);

  await app.press("id:settings-test-back");
  await app.waitFor("id:settings-test-row-alpha");
  expect(app.shows("id:settings-test-empty")).toBe(false);
});

function seedTwoChannels() {
  return {
    "settings.language": "en",
    [STORAGE_KEY]: record(["alpha", "beta"], {
      alpha: { configured: true, credentialRef: "ref-alpha" },
      beta: { configured: true, credentialRef: "ref-beta" },
    }),
    [`${VAULT_NAMESPACE}.ref-alpha`]: JSON.stringify({ apiKey: "a" }),
    [`${VAULT_NAMESPACE}.ref-beta`]: JSON.stringify({ apiKey: "b" }),
  };
}

test("capability section: drag reorder persists the order", async () => {
  const app = await open(APP_ENTRY, { ...viewport, storage: seedTwoChannels() });
  await app.waitFor("id:settings-test-row-beta");

  await app.drag("id:settings-test-row-beta", { x: 0, y: -80 });
  await app.waitUntil(() => storedRecord(app).order[0] === "beta");
  expect(storedRecord(app).order).toEqual(["beta", "alpha"]);
});

test("capability section: keyboard reorder persists the order", async () => {
  // A Linux host delivers raw keys to the focused view, as a desktop does.
  const app = await open(APP_ENTRY, {
    ...viewport,
    platform: "linux",
    storage: seedTwoChannels(),
  });
  await app.waitFor("id:settings-test-row-beta");

  await app.press("id:settings-test-grip-beta");
  await app.keyboard.press("arrowup");
  await app.waitUntil(() => storedRecord(app).order[0] === "beta");
  await app.keyboard.press("arrowdown");
  await app.waitUntil(() => storedRecord(app).order[1] === "beta");
  expect(storedRecord(app).order).toEqual(["alpha", "beta"]);
});

test("capability section: a stored unknown channel renders the skipped notice", async () => {
  const seed = record(["alpha", "ghost"], {
    alpha: { configured: true, credentialRef: "ref-alpha" },
    ghost: { configured: true, credentialRef: "ref-ghost" },
  });
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en", [STORAGE_KEY]: seed },
  });
  await app.waitFor("id:settings-test-row-alpha");
  await app.waitFor("id:settings-test-skipped");
  expect(app.texts()).toContain(
    "One saved channel is not available in this build and was skipped.",
  );
  expect(app.storage()[STORAGE_KEY]).toBe(seed);
});

test("capability detail: save persists config and credential, keeping the secret out of the record", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [STORAGE_KEY]: record(["alpha"], { alpha: { configured: false } }),
    },
  });
  await app.waitFor("id:settings-test-row-alpha");
  await app.press("id:settings-test-channel-alpha");
  await app.waitFor("id:settings-test-detail-card");

  await app.type("id:settings-test-mode", " accurate");
  await app.type("id:settings-test-credential", "k-1");
  await app.press("id:settings-test-save");
  await app.waitUntil(() => storedRecord(app).channels.alpha.configured === true);

  const saved = storedRecord(app);
  expect(saved.channels.alpha.config.mode).toBe("saved accurate");
  expect(saved.channels.alpha.credentialRef).not.toBeNull();
  expect(JSON.stringify(saved)).not.toContain("k-1");
  const ref = saved.channels.alpha.credentialRef!;
  expect(app.storage()[`${VAULT_NAMESPACE}.${ref}`]).toBe(JSON.stringify({ apiKey: "k-1" }));
});

test("capability detail: an unreadable credential blocks enabling and shows the alert", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [STORAGE_KEY]: record(["alpha"], {
        alpha: { configured: true, enabled: false, credentialRef: "ref-missing" },
      }),
    },
  });
  await app.waitFor("id:settings-test-row-alpha");
  await app.press("id:settings-test-toggle-alpha");
  await app.waitFor("id:settings-test-list-error");
  expect(app.texts()).toContain("The saved credential could not be read. Enter it again.");
  expect(storedRecord(app).channels.alpha.enabled).toBe(false);

  await app.press("id:settings-test-channel-alpha");
  await app.waitFor("id:settings-test-key-missing");
});

test("capability detail: a failed save keeps the draft and reports the error", async () => {
  let fail = true;
  const saved: Record<string, string> = {
    "settings.language": "en",
    [STORAGE_KEY]: record(["alpha"], { alpha: { configured: false } }),
  };
  const app = await open(APP_ENTRY, {
    ...viewport,
    modules: {
      nsh: {
        "Storage.getItem": async (key: string) => saved[key] ?? null,
        "Storage.setItem": async (key: string, value: string) => {
          if (key === STORAGE_KEY && fail) throw new Error("Storage unavailable");
          saved[key] = value;
        },
        "Storage.removeItem": async (key: string) => {
          delete saved[key];
        },
      },
    },
  });
  await app.waitFor("id:settings-test-row-alpha");
  await app.press("id:settings-test-channel-alpha");
  await app.waitFor("id:settings-test-detail-card");
  await app.type("id:settings-test-mode", " changed");
  await app.type("id:settings-test-credential", "k-2");
  await app.press("id:settings-test-save");
  await app.waitFor("id:settings-test-error");
  expect(app.texts()).toContain("Could not save the settings. Check storage and try again.");
  expect(app.value("id:settings-test-mode")).toBe("saved changed");

  fail = false;
  await app.press("id:settings-test-save");
  await app.waitUntil(() => {
    const stored = JSON.parse(saved[STORAGE_KEY] ?? "null");
    return stored?.channels?.alpha?.configured === true;
  });
});

test("capability detail: remove asks first and clears the credential", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [STORAGE_KEY]: record(["alpha"], {
        alpha: { configured: true, credentialRef: "ref-alpha" },
      }),
      [`${VAULT_NAMESPACE}.ref-alpha`]: JSON.stringify({ apiKey: "a" }),
    },
  });
  await app.waitFor("id:settings-test-row-alpha");
  await app.press("id:settings-test-remove-alpha");
  await app.waitFor("id:settings-test-remove-dialog");
  expect(app.shows("id:settings-test-row-alpha")).toBe(true);

  await app.press("id:settings-test-remove-confirm");
  await app.waitUntil(() => (storedRecord(app).order ?? []).length === 0);
  expect(storedRecord(app).channels.alpha).toBeUndefined();
  expect(app.storage()[`${VAULT_NAMESPACE}.ref-alpha`]).toBeUndefined();
});

test("capability section: a non-configurable channel stays static in the list", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [STORAGE_KEY]: record(["free"], { free: { configured: true, enabled: true } }),
    },
  });
  await app.waitFor("id:settings-test-row-free");
  expect(app.shows("id:settings-test-open-free")).toBe(false);
  expect(app.shows("id:settings-test-channel-free")).toBe(false);
  expect(app.texts()).toContain("Google Cloud Vision");
  expect(app.shows("id:settings-test-remove-free")).toBe(true);
  expect(app.shows("id:settings-test-detail-card")).toBe(false);
});

test("capability section: adding from the empty state opens the new channel", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  await app.waitFor("id:settings-test-empty-channel-alpha");
  await app.press("id:settings-test-empty-channel-alpha");
  await app.waitFor("id:settings-test-detail-card");
  expect(storedRecord(app).order).toEqual(["alpha"]);
});
test("capability section: adding a non-configurable channel keeps the list", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  await app.waitFor("id:settings-test-empty-channel-free");
  await app.press("id:settings-test-empty-channel-free");
  await app.waitFor("id:settings-test-row-free");
  expect(app.shows("id:settings-test-detail-card")).toBe(false);
  expect(storedRecord(app).channels.free).toMatchObject({ enabled: true, configured: true });

  // The static row has no pressable identity; focus lands on its Remove control.
  await app.keyboard.press("enter");
  await app.waitFor("id:settings-test-remove-dialog");
  await app.press("id:settings-test-remove-cancel");
  await app.waitUntil(() => !app.shows("id:settings-test-remove-dialog"));
  expect(app.shows("id:settings-test-row-free")).toBe(true);
  expect(app.shows("id:settings-test-detail-card")).toBe(false);
  expect(storedRecord(app).channels.free).toMatchObject({ enabled: true, configured: true });
});
