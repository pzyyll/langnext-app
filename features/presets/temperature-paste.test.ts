import { expect, open, test } from "nsh/test";
import { makeSeedStorage } from "../models/__tests__/fixtures";

// The Windows desktop test driver does not support app.paste.
test("presets ui: rejects out-of-range and over-precision temperature pastes", async () => {
  const app = await open("../../App.tsx", {
    width: 1040,
    height: 720,
    platform: "windows",
    storage: makeSeedStorage({}),
  });
  const temperature = "id:preset-temperature";
  await app.press("id:nav-presets");
  await app.press("id:empty-add-preset-button");
  for (const text of ["-1.0", "2.1", "0.15", "1e0"]) {
    await app.paste(temperature, { text });
    expect(app.value(temperature)).toBe("");
  }
  await app.paste(temperature, { text: "1.7" });
  expect(app.value(temperature)).toBe("1.7");
});
