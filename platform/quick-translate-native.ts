import { QuickTranslateNative } from "my-translator/native";
import type { CursorAnchorPoint } from "./quick-translate";

/** Reads the physical cursor monitor anchor on Windows; returns null elsewhere or on query failure. */
export function readCursorAnchor(): CursorAnchorPoint | null {
  try {
    return QuickTranslateNative.cursorAnchor();
  } catch {
    return null;
  }
}
