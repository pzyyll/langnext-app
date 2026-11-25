import { expect, open, test } from "nsh/test";

const SETTINGS_APP = "./__tests__/settings-app.tsx";

test("ai settings: renders a distinct registered provider component", async () => {
  const app = await open(SETTINGS_APP);
  await app.waitFor("id:example-settings-url");

  expect(app.value("id:example-settings-url")).toBe("https://example.test/v1");
  expect(app.shows("id:example-settings-provider >> text:example:provider")).toBe(true);
  // The registered component renders, not the shared default connection fields.
  expect(app.shows("id:connection-url-input")).toBe(false);
});

test("ai settings: edits remain owned by the host", async () => {
  const app = await open(SETTINGS_APP);
  await app.waitFor("id:example-settings-url");

  await app.clear("id:example-settings-url");
  await app.type("id:example-settings-url", "https://typed.example.com/v2");

  expect(app.value("id:example-settings-url")).toBe("https://typed.example.com/v2");
  await app.waitUntil(() => app.shows("id:example-owner-url >> text:https://typed.example.com/v2"));
  expect(app.requests()).toHaveLength(0);
  expect(app.storage()["models.v2.providers"]).toBeUndefined();
});
