import { expect, open, test } from "nsh/test";
import { LARGEST_FONT_STEP } from "./font-step";

const viewport = { width: 420, height: 360 };

function stepLabel(texts: readonly string[]): string | undefined {
  return texts.find((value) => value.startsWith("step:"));
}

test("a long textarea does not extend scrolling past the content below it", async () => {
  const app = await open("./__tests__/textarea-scroll-harness.tsx", viewport);

  await app.scroll("id:source-scroll", 120);
  const metrics = app.texts().find((text) => text.startsWith("scroll-extent:"))!;
  const [, extent, body] = metrics.split(":").map(Number);

  // Allow one point for rounding between layout and scroll metrics.
  expect(body).toBeGreaterThan(viewport.height);
  expect(Math.abs(extent! - body!)).toBeLessThanOrEqual(1);
});

test("a stepped textarea uses a larger step for a short line than a long passage", async () => {
  const app = await open("./__tests__/textarea-font-harness.tsx", viewport);
  await app.waitUntil(() => stepLabel(app.texts()) === `step:${LARGEST_FONT_STEP}`);

  await app.press("id:use-long-text");
  await app.waitUntil(() => {
    const label = stepLabel(app.texts());
    return label !== undefined && label !== `step:${LARGEST_FONT_STEP}`;
  });
  const next = Number(stepLabel(app.texts())?.slice("step:".length));
  expect(next).toBeLessThan(LARGEST_FONT_STEP);
  expect(next).toBeGreaterThanOrEqual(0);
});
