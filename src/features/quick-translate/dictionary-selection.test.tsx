import { expect, open, test } from "nsh/test";

const HARNESS = "./__tests__/dictionary-selection-app.tsx";
const viewport = { width: 520, height: 680, platform: "windows" as const };

test("dictionary selection native: emits selection text across source, output, and aligned views while preserving segment clicks", async () => {
  const app = await open(HARNESS, viewport);
  await app.waitFor("id:seam-source");

  // 1. Source RichEditor selection + onContextMenu Menu.popup
  await app.drag("id:seam-source >> text:Hello ephemeral world.", { x: 80, y: 0 });
  await app.waitUntil(() => !app.texts().includes("source:none"));
  const sourceState = app.texts().find((line) => line.startsWith("source:"))!;
  expect(sourceState).toContain("|true|");

  await app.rightClick("id:seam-source");
  await app.waitUntil(() => (app.menu()?.length ?? 0) > 0);
  expect(app.menu()!.some((entry) => entry.label === "Look up")).toBe(true);
  await app.chooseMenuItem("Look up");
  await app.waitUntil(() => app.texts().includes("menu:1"));

  // 2. Plain TranslationOutput selection
  await app.waitFor("id:seam-plain");
  await app.drag("id:seam-plain", { x: 90, y: 0 });
  await app.waitUntil(() => !app.texts().includes("plain:none"));
  expect(app.texts().find((line) => line.startsWith("plain:"))).toContain("|true");

  // 3. Markdown TranslationOutput selection
  await app.waitFor("id:seam-md");
  await app.drag("id:seam-md", { x: 80, y: 0 });
  await app.waitUntil(() => !app.texts().includes("md:none"));
  expect(app.texts().find((line) => line.startsWith("md:"))).toContain("|true");

  // 4. Plain AlignedTranslation: dragging selects, pressing segment still invokes onPressSegment
  await app.waitFor("id:seam-aligned-plain");
  await app.drag("id:seam-aligned-plain >> text:First ephemeral clause.", { x: 80, y: 0 });
  await app.waitUntil(() => !app.texts().includes("alignedPlain:none"));
  expect(app.texts().find((line) => line.startsWith("alignedPlain:"))).toContain("|true");
  await app.press("id:seam-aligned-plain >> text:Second aligned clause.");
  await app.waitUntil(() => app.texts().includes("pressed:seg-2"));

  // 5. Markdown AlignedTranslation: dragging selects without losing segment press
  const infoLine = app.texts().find((line) => line.startsWith("mdDoc:"))!;
  expect(infoLine.startsWith("mdDoc:true:")).toBe(true);
  await app.waitFor("id:seam-aligned-md");
  await app.drag("id:seam-aligned-md >> text:Summary V1", { x: 40, y: 0 });
  await app.waitUntil(() => !app.texts().includes("alignedMd:none"));
  expect(app.texts().find((line) => line.startsWith("alignedMd:"))).toContain("|true");
  await app.press("id:result-seg-0");
  await app.waitUntil(() =>
    app.texts().some((line) => line.startsWith("pressed:") && line.split(",").length >= 2),
  );
});
