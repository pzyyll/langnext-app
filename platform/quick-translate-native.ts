import { QuickTranslateNative } from "my-translator/native";
import type { CursorAnchorPoint, DoubleCopyBinding, PointerPressBinding } from "./quick-translate";

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
