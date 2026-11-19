import { expect, open, test } from "nsh/test";

// Run with --target windows. The headless NSH display has no Win32 monitor ID.
test("Windows native cursor monitor ID matches NSH displays()", async () => {
  const app = await open("../../platform/__tests__/cursor-match-app.tsx", {
    width: 400,
    height: 200,
    platform: "windows",
  });
  await app.waitFor("id:cursor-match-result");
  expect(app.texts()[0]).toMatch(/^matched:/);
});
