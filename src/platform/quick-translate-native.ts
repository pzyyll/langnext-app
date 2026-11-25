import { QuickTranslateNative, SelectionTextNative } from "langnext-native";
import type {
  CursorAnchorPoint,
  DoubleCopyBinding,
  PointerPressBinding,
  SelectionGestureBinding,
} from "./quick-translate";

/** Reads the physical cursor monitor anchor on Windows; returns null elsewhere or on query failure. */
export function readCursorAnchor(): CursorAnchorPoint | null {
  try {
    return QuickTranslateNative.cursorAnchor();
  } catch {
    return null;
  }
}

/** Native Windows Raw Input double-Ctrl+C binding backed by Rust `QuickTranslateNative`. */
export const nativeDoubleCopyBinding: DoubleCopyBinding = {
  onDoubleCopy: (listener) => QuickTranslateNative.onDoubleCopy(listener),
};

/** Native Windows Raw Input mouse-press binding backed by Rust `QuickTranslateNative`. */
export const nativePointerPressBinding: PointerPressBinding = {
  onPointerPress: (listener) => QuickTranslateNative.onPointerPress(listener),
};

/** The foreground target, or null when no window is in front. */
function readSelectionTarget(): string | null {
  try {
    return SelectionTextNative.snapshot();
  } catch {
    return null;
  }
}

/**
 * Native Windows low-level mouse binding: left button presses, and drag releases that captured a
 * foreground target. It never reads the selected text itself.
 */
export const nativeSelectionGestureBinding: SelectionGestureBinding = {
  onSelectionGesture(listener) {
    return QuickTranslateNative.onSelectionGesture((event) => {
      const point = {
        displayId: event.displayId,
        offsetX: event.offsetX,
        offsetY: event.offsetY,
      };
      if (event.kind === "press") {
        listener({ kind: "press", press: point });
        return;
      }
      const target = readSelectionTarget();
      if (target === null) {
        return;
      }
      listener({ kind: "candidate", release: point, target });
    });
  },
};
