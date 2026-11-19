import type { CursorAnchor } from "my-translator/native";
import type { Point, Size } from "nsh";
import type { Display, DisplayId } from "nsh/desktop";

export type CursorAnchorPoint = CursorAnchor;

const CURSOR_TOP_OFFSET_PT = 24;

export type ResolvedPopupPlacement =
  | {
      kind: "cursor";
      display: DisplayId;
      bounds: {
        origin: Point;
        size: Size;
      };
    }
  | {
      kind: "center";
      display?: DisplayId;
      size: Size;
    };

function capSizeToWorkArea(desiredSize: Size, display: Display | undefined): Size {
  if (!display) {
    return { width: desiredSize.width, height: desiredSize.height };
  }
  const work = display.visibleBounds.size;
  if (work.width <= 0 || work.height <= 0) {
    return { width: desiredSize.width, height: desiredSize.height };
  }
  return {
    width: Math.max(0, Math.min(desiredSize.width, work.width)),
    height: Math.max(0, Math.min(desiredSize.height, work.height)),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Resolves popup display, size, and initial origin from a cursor monitor anchor.
 * Falls back to centered main-display placement when cursor, display, or scale is unavailable.
 */
export function resolvePopupPlacement(
  anchor: CursorAnchorPoint | null | undefined,
  availableDisplays: readonly Display[],
  desiredSize: Size,
  fallbackDisplayId?: DisplayId,
): ResolvedPopupPlacement {
  const fallbackDisplay = availableDisplays.find((item) => item.id === fallbackDisplayId);
  const fallbackPlacement = (): ResolvedPopupPlacement => ({
    kind: "center",
    display: fallbackDisplayId,
    size: capSizeToWorkArea(desiredSize, fallbackDisplay),
  });

  if (
    !anchor ||
    typeof anchor.displayId !== "string" ||
    !Number.isFinite(anchor.offsetX) ||
    !Number.isFinite(anchor.offsetY)
  ) {
    return fallbackPlacement();
  }

  const targetDisplay = availableDisplays.find((item) => item.id === anchor.displayId);
  if (
    !targetDisplay ||
    !Number.isFinite(targetDisplay.scaleFactor) ||
    targetDisplay.scaleFactor <= 0
  ) {
    return fallbackPlacement();
  }

  const size = capSizeToWorkArea(desiredSize, targetDisplay);
  const work = targetDisplay.visibleBounds;

  const cursorX = targetDisplay.bounds.origin.x + anchor.offsetX / targetDisplay.scaleFactor;
  const cursorY = targetDisplay.bounds.origin.y + anchor.offsetY / targetDisplay.scaleFactor;

  const rawX = cursorX - size.width / 2;
  const rawY = cursorY - CURSOR_TOP_OFFSET_PT;

  const minX = work.origin.x;
  const maxX = Math.max(minX, minX + work.size.width - size.width);
  const minY = work.origin.y;
  const maxY = Math.max(minY, minY + work.size.height - size.height);

  return {
    kind: "cursor",
    display: targetDisplay.id,
    bounds: {
      origin: {
        x: clamp(rawX, minX, maxX),
        y: clamp(rawY, minY, maxY),
      },
      size,
    },
  };
}
