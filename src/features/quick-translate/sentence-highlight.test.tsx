import { expect, open, test } from "nsh/test";
import { TextView } from "nsh/base";
import { finalizeMarkdownAlignment, prepareMarkdownAlignment } from "./alignment-document";

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

  // The source highlight spans a CRLF within the sentence, but not the preceding paragraph.
  await app.press("id:fixture-crlf");
  await app.waitFor("id:quick-translate-result-text >> text:Deuxième 😀 ligne.");
  await app.hover("id:quick-translate-result-text >> text:Deuxième 😀 ligne.");
  for (const line of ["Second 😀", "line."]) {
    expect(app.spanStyle(`id:quick-translate-source >> text:${line}`).backgroundColor).toEqual(
      brandSoft,
    );
  }
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

test("sentence highlight markdown: aligns formatted spans, preserves links and fenced code blocks, and syncs native hover", async () => {
  const source = [
    "Summary V1",
    "",
    "First sentence has bold italic link details 42. Second sentence follows.",
    "",
    "List point A1.",
    "",
    "Table cell B2.",
  ].join("\n");
  const markdown = [
    "## Summary V1",
    "",
    "First **bold** _italic_ [link 42](https://example.com) sentence. Second sentence follows.",
    "",
    "- List point A1.",
    "",
    "| Header |",
    "| --- |",
    "| Table cell B2. |",
    "",
    "```ts",
    "const raw = 42;",
    "```",
  ].join("\n");

  const prepared = prepareMarkdownAlignment(markdown);
  expect(prepared).not.toBeNull();
  expect(prepared!.targetBlocks).toEqual([
    "Summary V1",
    "First bold italic link 42 sentence. Second sentence follows.",
    "List point A1.",
    "Header",
    "Table cell B2.",
    null,
  ]);

  const parsed = TextView.parse(markdown, { streaming: false, html: false, math: false });
  const built = finalizeMarkdownAlignment(source, prepared!, [
    { sourceStart: 0, sourceEnd: 10, targetBlockIndex: 0, targetStart: 0, targetEnd: 10 },
    { sourceStart: 12, sourceEnd: 59, targetBlockIndex: 1, targetStart: 0, targetEnd: 35 },
    { sourceStart: 60, sourceEnd: 84, targetBlockIndex: 1, targetStart: 36, targetEnd: 60 },
    { sourceStart: 86, sourceEnd: 100, targetBlockIndex: 2, targetStart: 0, targetEnd: 14 },
    { sourceStart: 102, sourceEnd: 116, targetBlockIndex: 4, targetStart: 0, targetEnd: 14 },
  ]);
  expect(built).not.toBeNull();
  expect(TextView.plainText(built!.document)).toBe(TextView.plainText(parsed));
  expect(built!.segments).toHaveLength(5);

  const codeBlock = built!.document.blocks.find((block) => block.type === "codeBlock");
  expect(codeBlock).toEqual({ type: "codeBlock", language: "ts", code: "const raw = 42;" });
  const imagePrepared = prepareMarkdownAlignment("![Alt](https://example.com/a.png)");
  expect(imagePrepared).toBeNull();

  const app = await open(HARNESS, viewport);
  await app.waitFor("id:fixture-markdown");
  await app.press("id:fixture-markdown");
  await app.waitFor("id:quick-translate-result-text >> text:const raw = 42;");
  expect(app.texts()).toContain("markdown:seg=5:plain=true:code=true");

  const brandSoft = app.spanStyle("id:ref-brand-soft").backgroundColor;
  expect(brandSoft).toBeTruthy();

  const segmentBg = (id: string, text: string) =>
    app.viewStyle(`id:${id}`)?.backgroundColor ??
    app.spanStyle(`id:${id} >> text:${text}`).backgroundColor;

  // Hovering a non-link fragment highlights plain, bold, italic, link label, and source sentence together.
  await app.hover("id:result-seg-1");
  expect(segmentBg("result-seg-1", "First ")).toEqual(brandSoft);
  expect(segmentBg("result-seg-1-frag-1", "bold")).toEqual(brandSoft);
  expect(segmentBg("result-seg-1-frag-3", "italic")).toEqual(brandSoft);
  expect(segmentBg("result-seg-1-frag-5", "link 42")).toEqual(brandSoft);
  expect(segmentBg("result-seg-2", "Second sentence ")).toBeUndefined();
  expect(app.spanStyle("id:result-seg-1-frag-1 >> text:bold").fontWeight).toBeGreaterThanOrEqual(
    600,
  );
  expect(app.spanStyle("id:result-seg-1-frag-3 >> text:italic").italic).toBe(true);
  expect(app.spanStyle("id:result-seg-1-frag-5 >> text:link 42").underline).toBe(true);
  expect(
    app.spanStyle(
      "id:quick-translate-source >> text:First sentence has bold italic link details 42.",
    ).backgroundColor,
  ).toEqual(brandSoft);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second sentence follows.").backgroundColor,
  ).toBeUndefined();

  // Narrow viewport keeps wrapped formatted sentence and source synchronized.
  await app.setViewport(220, 960);
  await app.hover("id:result-seg-1-frag-3");
  expect(segmentBg("result-seg-1", "First ")).toEqual(brandSoft);
  expect(segmentBg("result-seg-1-frag-5", "link 42")).toEqual(brandSoft);
  expect(
    app.spanStyle(
      "id:quick-translate-source >> text:First sentence has bold italic link details 42.",
    ).backgroundColor,
  ).toEqual(brandSoft);
  await app.setViewport(viewport.size.width, viewport.size.height);

  // Hovering the link fragment highlights the whole sentence, and clicking it still emits onLinkPress.
  await app.hover("id:result-seg-1-frag-5");
  expect(segmentBg("result-seg-1", "First ")).toEqual(brandSoft);
  expect(segmentBg("result-seg-1-frag-5", "link 42")).toEqual(brandSoft);
  await app.press("id:result-seg-1-frag-5", { position: { x: 4, y: 8 } });
  expect(app.texts()).toContain("linkPressed:https://example.com");

  // Moving to the adjacent sentence switches both result and source highlight.
  await app.hover("id:result-seg-2");
  expect(segmentBg("result-seg-2", "Second sentence ")).toEqual(brandSoft);
  expect(segmentBg("result-seg-1", "First ")).toBeUndefined();
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second sentence follows.").backgroundColor,
  ).toEqual(brandSoft);

  // Heading, list, and table cell align while fenced code block stays plain.
  await app.hover("id:result-seg-0");
  expect(app.spanStyle("id:quick-translate-source >> text:Summary V1").backgroundColor).toEqual(
    brandSoft,
  );
  await app.hover("id:result-seg-3");
  expect(app.spanStyle("id:quick-translate-source >> text:List point A1.").backgroundColor).toEqual(
    brandSoft,
  );
  await app.hover("id:result-seg-4");
  expect(app.spanStyle("id:quick-translate-source >> text:Table cell B2.").backgroundColor).toEqual(
    brandSoft,
  );

  await app.hover("id:outside-gap");
  expect(segmentBg("result-seg-4", "Table cell B2.")).toBeUndefined();
});
