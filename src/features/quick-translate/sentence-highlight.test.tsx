import { expect, open, test } from "nsh/test";

const HARNESS = "./__tests__/sentence-highlight-app.tsx";
const viewport = {
  platform: "windows" as const,
  colorScheme: "light" as const,
  size: { width: 380, height: 640 },
};

test("sentence highlight native: highlights aligned source range on result hover and preserves selection/editing rules", async () => {
  const app = await open(HARNESS, viewport);
  await app.waitFor("id:quick-translate-source");
  await app.waitFor("id:quick-translate-result-text");

  const brandSoft = app.spanStyle("id:ref-brand-soft").backgroundColor;
  expect(brandSoft).toBeTruthy();

  // Hovering the second result sentence (with surrogate emoji) highlights both result and source spans.
  await app.hover("id:quick-translate-result-text >> text:Bonjour 😀 monde !");
  expect(app.spanStyle("id:result-seg-1").backgroundColor).toEqual(brandSoft);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Hello 😀 world!").backgroundColor,
  ).toEqual(brandSoft);
  expect(
    app.spanStyle("id:quick-translate-source >> text:First sentence.").backgroundColor,
  ).toBeUndefined();

  // Moving to non-text gap clears both highlights.
  await app.hover("id:outside-gap");
  expect(app.spanStyle("id:result-seg-1").backgroundColor).toBeUndefined();
  expect(
    app.spanStyle("id:quick-translate-source >> text:Hello 😀 world!").backgroundColor,
  ).toBeUndefined();

  // Hovering CRLF fixture maps offsets after \r\n paragraphs cleanly.
  await app.press("id:fixture-crlf");
  await app.waitFor("id:quick-translate-result-text >> text:Deuxième 😀 ligne.");
  await app.hover("id:quick-translate-result-text >> text:Deuxième 😀 ligne.");
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second 😀 line.").backgroundColor,
  ).toEqual(brandSoft);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Line one.").backgroundColor,
  ).toBeUndefined();

  // Dragging across text selects inside source, copy works, and hovering result sentences preserves selection & highlight.
  await app.press("id:fixture-basic");
  await app.drag("id:quick-translate-source >> text:First sentence.", { x: -160, y: 0 });
  const draggedSelections = app.texts().find((line) => line.startsWith("selections:"));
  expect(draggedSelections).toBeTruthy();
  await app.hover("id:quick-translate-result-text >> text:Bonjour 😀 monde !");
  expect(app.spanStyle("id:result-seg-1").backgroundColor).toEqual(brandSoft);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Hello 😀 world!").backgroundColor,
  ).toEqual(brandSoft);
  expect(app.texts().find((line) => line.startsWith("selections:"))).toEqual(draggedSelections);

  await app.keyboard.press("mod+c");
  const clipAfterDrag = app.clipboard();
  expect(clipAfterDrag).toBeTruthy();
  expect("First sentence.").toContain(clipAfterDrag!);

  // Dark mode switches bg-brand-soft token cleanly on both result and source spans.
  await app.setColorScheme("dark");
  await app.waitUntil(() => app.spanStyle("id:ref-brand-soft").backgroundColor !== brandSoft);
  const darkBrandSoft = app.spanStyle("id:ref-brand-soft").backgroundColor;
  expect(darkBrandSoft).toBeTruthy();
  expect(app.spanStyle("id:result-seg-1").backgroundColor).toEqual(darkBrandSoft);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Hello 😀 world!").backgroundColor,
  ).toEqual(darkBrandSoft);
  await app.setColorScheme("light");

  // Narrow viewport wraps both source and result across lines and keeps highlight synchronized.
  await app.setViewport(220, 640);
  await app.hover("id:quick-translate-result-text >> text:Bonjour 😀 monde !");
  expect(app.spanStyle("id:result-seg-1").backgroundColor).toEqual(brandSoft);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Hello 😀 world!").backgroundColor,
  ).toEqual(brandSoft);
  expect(app.texts().find((line) => line.startsWith("selections:"))).toEqual(draggedSelections);
  await app.hover("id:outside-gap");
  expect(app.spanStyle("id:result-seg-1").backgroundColor).toBeUndefined();
  await app.setViewport(viewport.size.width, viewport.size.height);

  // Focusing to end via ref places caret at UTF-16 end across blank lines + emoji.
  await app.press("id:focus-end");
  await app.type("id:quick-translate-source", "!");
  expect(app.texts()).toContain("source:First sentence.\n\nHello 😀 world! Last one.!");

  // Select all, copy, clear, and insert newline via Shift+Enter without triggering submit.
  await app.type("id:quick-translate-source", "");
  await app.keyboard.press("mod+a");
  await app.keyboard.press("mod+c");
  const clipAfterModA = app.clipboard();
  expect(clipAfterModA?.replace(/\r\n/g, "\n")).toBe(
    "First sentence.\n\nHello 😀 world! Last one.!",
  );

  await app.keyboard.press("backspace");
  await app.type("id:quick-translate-source", "Line 1");
  await app.keyboard.press("shift+enter");
  await app.type("id:quick-translate-source", "Line 2");
  expect(app.texts()).toContain("submits:0");
  expect(app.texts()).toContain("source:Line 1\nLine 2");
  expect(app.texts()).toContain("step:3");

  const selectionTextBeforeHover = app.texts().find((line) => line.startsWith("selections:"));
  expect(selectionTextBeforeHover).toBeTruthy();
  await app.hover("id:quick-translate-result-text >> text:Bonjour 😀 monde !");
  expect(app.spanStyle("id:result-seg-1").backgroundColor).toEqual(brandSoft);
  await app.hover("id:outside-gap");
  const selectionTextAfterHover = app.texts().find((line) => line.startsWith("selections:"));
  expect(selectionTextAfterHover).toEqual(selectionTextBeforeHover);

  await app.type("id:quick-translate-source", "!");
  expect(app.texts()).toContain("source:Line 1\nLine 2!");

  let composeSupported = true;
  try {
    await app.compose("id:quick-translate-source", "ni");
  } catch (error) {
    if (error instanceof Error && error.message.includes("compose")) {
      composeSupported = false;
    } else {
      throw error;
    }
  }
  if (composeSupported) {
    await app.keyboard.press("enter");
    expect(app.texts()).toContain("submits:0");
    await app.compose("id:quick-translate-source", "");
  }
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().includes("submits:1"));

  // Long fixture steps font down from max step (3) cleanly.
  await app.press("id:fixture-long");
  await app.waitUntil(() => {
    const line = app.texts().find((item) => item.startsWith("step:"));
    return line !== undefined && line !== "step:3";
  });
  expect(app.texts()).toContain("step:0");
});
