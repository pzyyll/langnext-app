import type { Display } from "nsh/desktop";
import { expect, open, test } from "nsh/test";
import { resolvePopupPlacement } from "./quick-translate";

function makeDisplay(overrides: Partial<Display> = {}): Display {
  return {
    id: "disp-primary",
    bounds: { origin: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
    visibleBounds: { origin: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
    primary: true,
    name: "Primary",
    scaleFactor: 1,
    cutouts: [],
    ...overrides,
  };
}

test("quick placement: right/bottom clamp on negative-origin display yields (-420, 504)", () => {
  const negDisplay = makeDisplay({
    id: "disp-left",
    bounds: { origin: { x: -1280, y: -120 }, size: { width: 1280, height: 1024 } },
    visibleBounds: { origin: { x: -1280, y: -120 }, size: { width: 1280, height: 984 } },
    primary: false,
    scaleFactor: 1,
  });

  // Cursor at (-5, 860) in display points => physical offset (1275, 980) from (-1280, -120) at scale 1.
  const placed = resolvePopupPlacement(
    { displayId: "disp-left", offsetX: 1275, offsetY: 980 },
    [makeDisplay(), negDisplay],
    { width: 420, height: 360 },
    "disp-primary",
  );

  expect(placed).toEqual({
    kind: "cursor",
    display: "disp-left",
    bounds: {
      origin: { x: -420, y: 504 },
      size: { width: 420, height: 360 },
    },
  });
});

test("quick placement: clamps left/top edge against display visibleBounds", () => {
  const display = makeDisplay({
    id: "disp-top",
    bounds: { origin: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
    visibleBounds: { origin: { x: 48, y: 32 }, size: { width: 1872, height: 1008 } },
    scaleFactor: 1,
  });

  const placed = resolvePopupPlacement(
    { displayId: "disp-top", offsetX: 60, offsetY: 40 },
    [display],
    { width: 420, height: 360 },
    "disp-top",
  );

  expect(placed).toEqual({
    kind: "cursor",
    display: "disp-top",
    bounds: {
      origin: { x: 48, y: 32 },
      size: { width: 420, height: 360 },
    },
  });
});

test("quick placement: converts per-display physical offset using matched display scaleFactor on mixed-DPI displays", () => {
  const primary = makeDisplay({
    id: "disp-1x",
    bounds: { origin: { x: 0, y: 0 }, size: { width: 1707, height: 960 } },
    visibleBounds: { origin: { x: 0, y: 0 }, size: { width: 1707, height: 920 } },
    scaleFactor: 1.5,
  });
  const secondary = makeDisplay({
    id: "disp-2x",
    bounds: { origin: { x: 1707, y: 100 }, size: { width: 1920, height: 1080 } },
    visibleBounds: { origin: { x: 1707, y: 100 }, size: { width: 1920, height: 1040 } },
    primary: false,
    scaleFactor: 2,
  });

  // Offset (1000, 600) px at 2x => (500, 300) pt from (1707, 100) => cursor (2207, 400).
  // Centered x = 2207 - 210 = 1997; top y = 400 - 24 = 376.
  const placed = resolvePopupPlacement(
    { displayId: "disp-2x", offsetX: 1000, offsetY: 600 },
    [primary, secondary],
    { width: 420, height: 360 },
    "disp-1x",
  );

  expect(placed).toEqual({
    kind: "cursor",
    display: "disp-2x",
    bounds: {
      origin: { x: 1997, y: 376 },
      size: { width: 420, height: 360 },
    },
  });
});

test("quick placement: caps size to work area when viewport is smaller than desired frame", () => {
  const tiny = makeDisplay({
    id: "disp-tiny",
    bounds: { origin: { x: 100, y: 50 }, size: { width: 320, height: 280 } },
    visibleBounds: { origin: { x: 100, y: 50 }, size: { width: 320, height: 280 } },
    scaleFactor: 1,
  });

  const placed = resolvePopupPlacement(
    { displayId: "disp-tiny", offsetX: 250, offsetY: 200 },
    [tiny],
    { width: 420, height: 360 },
    "disp-tiny",
  );

  expect(placed).toEqual({
    kind: "cursor",
    display: "disp-tiny",
    bounds: {
      origin: { x: 100, y: 50 },
      size: { width: 320, height: 280 },
    },
  });
});

test("quick placement: falls back to centered main-display placement when cursor or display scale is missing", () => {
  const main = makeDisplay({ id: "disp-main" });
  const badScale = makeDisplay({ id: "disp-zero", scaleFactor: 0, primary: false });

  expect(resolvePopupPlacement(null, [main], { width: 420, height: 360 }, "disp-main")).toEqual({
    kind: "center",
    display: "disp-main",
    size: { width: 420, height: 360 },
  });

  expect(
    resolvePopupPlacement(
      { displayId: "unknown-display", offsetX: 100, offsetY: 100 },
      [main],
      { width: 420, height: 360 },
      "disp-main",
    ),
  ).toEqual({
    kind: "center",
    display: "disp-main",
    size: { width: 420, height: 360 },
  });

  expect(
    resolvePopupPlacement(
      { displayId: "disp-zero", offsetX: 100, offsetY: 100 },
      [main, badScale],
      { width: 420, height: 360 },
      "disp-main",
    ),
  ).toEqual({
    kind: "center",
    display: "disp-main",
    size: { width: 420, height: 360 },
  });
});

test("desktop: quick placement native cursor monitor ID matches NSH displays()", async () => {
  const app = await open("./__tests__/cursor-match-app.tsx", {
    width: 400,
    height: 200,
    platform: "windows",
  });
  await app.waitFor("id:cursor-match-result");
  const text = app.texts()[0] ?? "";
  expect(text.startsWith("matched:") || text === "no-anchor").toBe(true);
  expect(text.startsWith("mismatch:")).toBe(false);
});
