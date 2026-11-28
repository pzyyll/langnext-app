import type { Bounds } from "nsh";
import type { MenuItem } from "nsh/desktop";

export type QuickTranslateSelectionRegion = "source" | "result" | "back-translation" | "history";

export interface TextSelectionEventPayload {
  text: string;
  start?: number;
  bounds?: Bounds;
  pageBounds?: Bounds;
}

export interface QuickTranslateTextSelection {
  text: string;
  start: number;
  end: number;
  pageBounds?: Bounds | null;
}

export type QuickTranslateSelectionMenu = MenuItem[];
