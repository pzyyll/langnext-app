import { expect, open, test } from "nsh/test";

const viewport = { width: 420, height: 360 };

test("a long textarea does not extend scrolling past the content below it", async () => {
  const app = await open("./__tests__/textarea-scroll-harness.tsx", viewport);

  await app.scroll("id:source-scroll", 120);
  const metrics = app.texts().find((text) => text.startsWith("scroll-extent:"))!;
  const [, extent, body] = metrics.split(":").map(Number);

  // Allow one point for rounding between layout and scroll metrics.
  expect(body).toBeGreaterThan(viewport.height);
  expect(Math.abs(extent! - body!)).toBeLessThanOrEqual(1);
});
