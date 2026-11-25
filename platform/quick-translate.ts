import type { CursorAnchor, DoubleCopyEvent, PointerPress } from "langnext/native";
import type { Bounds, Point, Size } from "nsh";
import type { Display, DisplayId, WindowRef, WindowState } from "nsh/desktop";

export type CursorAnchorPoint = CursorAnchor;
export type PointerPressPoint = PointerPress;
export type DoubleCopyActivationEvent = DoubleCopyEvent;

export interface DoubleCopyBinding {
  onDoubleCopy: (listener: (event: DoubleCopyActivationEvent) => void) => () => void;
}

export interface PointerPressBinding {
  onPointerPress: (listener: (event: PointerPressPoint) => void) => () => void;
}

/** A left button press, or the release of a possible text drag with the target it captured. */
export type SelectionGestureEvent =
  | { kind: "press"; press: PointerPressPoint }
  | { kind: "candidate"; release: PointerPressPoint; target: string };

export interface SelectionGestureBinding {
  onSelectionGesture: (listener: (event: SelectionGestureEvent) => void) => () => void;
}

/** Double-Ctrl+C Raw Input monitoring is only supported on Windows. */
export function canUseDoubleCopy(os: string): boolean {
  return os === "windows";
}

/** Global pointer press monitoring uses Windows Raw Input. */
export function canMonitorPointerPress(os: string): boolean {
  return os === "windows";
}

/** Offset in points from the cursor hotspot to the popup's top-left corner. */
const CURSOR_OFFSET_X_PT = -10;
const CURSOR_OFFSET_Y_PT = -10;

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

/** A display-relative physical point resolved to screen points on the display it belongs to. */
export interface AnchoredDisplayPoint {
  display: Display;
  point: Point;
}

/**
 * Resolves a cursor or press anchor to screen points: the display's origin plus its physical
 * offset at that display's scale.
 * Returns null when the anchor is malformed, or names a display that is missing or has no scale.
 */
export function resolveAnchoredDisplayPoint(
  anchor: CursorAnchorPoint | null | undefined,
  availableDisplays: readonly Display[],
): AnchoredDisplayPoint | null {
  if (
    !anchor ||
    typeof anchor.displayId !== "string" ||
    !Number.isFinite(anchor.offsetX) ||
    !Number.isFinite(anchor.offsetY)
  ) {
    return null;
  }

  const display = availableDisplays.find((item) => item.id === anchor.displayId);
  if (!display || !Number.isFinite(display.scaleFactor) || display.scaleFactor <= 0) {
    return null;
  }

  return {
    display,
    point: {
      x: display.bounds.origin.x + anchor.offsetX / display.scaleFactor,
      y: display.bounds.origin.y + anchor.offsetY / display.scaleFactor,
    },
  };
}

/** Distance in points between a drag release and the hint's nearest edge. */
const SELECTION_HINT_OFFSET_PT = 12;

/** Where a drag-release hint goes: its display and a work-area-fitting top-left corner. */
export interface ResolvedSelectionHintPlacement {
  display: DisplayId;
  origin: Point;
}

/**
 * Places a small hint beside a drag release: below and right of the pointer, flipped above and
 * left when the work area ends there, then clamped into the work area.
 * Returns null when the release names no display, or its work area has no size.
 */
export function resolveSelectionHintPlacement(
  release: PointerPressPoint | null | undefined,
  availableDisplays: readonly Display[],
  size: Size,
): ResolvedSelectionHintPlacement | null {
  const resolved = resolveAnchoredDisplayPoint(release, availableDisplays);
  if (!resolved) return null;

  const work = resolved.display.visibleBounds;
  if (work.size.width <= 0 || work.size.height <= 0) return null;
  const right = work.origin.x + work.size.width;
  const bottom = work.origin.y + work.size.height;
  const width = Math.min(size.width, work.size.width);
  const height = Math.min(size.height, work.size.height);

  // Flip before clamping, so the hint never lands on the pointer at the edge it avoids.
  let x = resolved.point.x + SELECTION_HINT_OFFSET_PT;
  if (x + width > right) {
    x = resolved.point.x - SELECTION_HINT_OFFSET_PT - width;
  }
  let y = resolved.point.y + SELECTION_HINT_OFFSET_PT;
  if (y + height > bottom) {
    y = resolved.point.y - SELECTION_HINT_OFFSET_PT - height;
  }

  return {
    display: resolved.display.id,
    origin: {
      x: clamp(x, work.origin.x, right - width),
      y: clamp(y, work.origin.y, bottom - height),
    },
  };
}

/** Whether screen point `point` falls inside `bounds`, whose right and bottom edges are open. */
export function boundsContainPoint(bounds: Bounds, point: Point): boolean {
  return (
    point.x >= bounds.origin.x &&
    point.x < bounds.origin.x + bounds.size.width &&
    point.y >= bounds.origin.y &&
    point.y < bounds.origin.y + bounds.size.height
  );
}

/** Fits the measured content without changing width. Move up only when the work area requires it. */
export function resolvePopupContentFit(
  state: Pick<WindowState, "bounds" | "contentBounds" | "display" | "scaleFactor">,
  contentHeight: number,
  minContentHeight: number,
): Parameters<WindowRef["setBounds"]>[0] | null {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return null;
  const { bounds, contentBounds, display } = state;
  const scale = state.scaleFactor > 0 ? state.scaleFactor : 1;
  const frameHeight = Math.max(0, bounds.size.height - contentBounds.size.height);
  let height = Math.ceil((Math.max(minContentHeight, contentHeight) + frameHeight) * scale) / scale;
  let y = bounds.origin.y;
  const work = display?.visibleBounds;
  if (work && work.size.height > 0) {
    height = Math.min(height, work.size.height);
    y = clamp(y, work.origin.y, work.origin.y + work.size.height - height);
  }

  // Ignore differences the native frame cannot represent at its current scale.
  const tolerance = 0.5 / scale;
  const resized = Math.abs(height - bounds.size.height) >= tolerance;
  const moved = Math.abs(y - bounds.origin.y) >= tolerance;
  if (!resized && !moved) return null;
  return { ...(resized ? { size: { height } } : {}), ...(moved ? { origin: { y } } : {}) };
}

/**
 * Resolves popup display, size, and initial origin from a cursor monitor anchor.
 * The popup's top-left corner sits up-left of the cursor, so the cursor lands 10 pt inside it,
 * clamped to the display work area.
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

  const anchored = resolveAnchoredDisplayPoint(anchor, availableDisplays);
  if (!anchored) {
    return fallbackPlacement();
  }

  const targetDisplay = anchored.display;
  const size = capSizeToWorkArea(desiredSize, targetDisplay);
  const work = targetDisplay.visibleBounds;

  const rawX = anchored.point.x + CURSOR_OFFSET_X_PT;
  const rawY = anchored.point.y + CURSOR_OFFSET_Y_PT;

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
