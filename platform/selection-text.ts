import { platform } from "nsh";
import { SelectionTextNative } from "langnext/native";

/** How one on-demand selection read ended. Only `selected` carries text. */
export type SelectionTextRead =
  | { status: "selected"; text: string }
  | { status: "noSelection" }
  | { status: "unavailable" }
  | { status: "stale" };

/** How one read may obtain the text. */
export interface SelectionTextReadOptions {
  /** Forbids the simulated copy: only UI Automation may answer. */
  uiaOnly?: boolean;
}

/** Reads the foreground selection captured by `snapshot`. Tests substitute this port. */
export interface SelectionTextPort {
  /** Opaque foreground target, or `null` when no window is in front. */
  snapshot(): string | null;
  /** Whether `target` still names the foreground window and its focused control. */
  isCurrent(target: string): boolean;
  /** Reads the selection captured in `target`. */
  read(target: string, options?: SelectionTextReadOptions): Promise<SelectionTextRead>;
}

/** Foreground selection uses UI Automation, so only Windows offers it. */
export function canReadSelectionText(os: string): boolean {
  return os === "windows";
}

/** Production reader. Copy fallback permission is sampled for each read. */
export function createSelectionTextPort(allowCopyFallback: () => boolean): SelectionTextPort {
  return {
    snapshot() {
      if (!canReadSelectionText(platform.os)) return null;
      try {
        return SelectionTextNative.snapshot();
      } catch {
        return null;
      }
    },
    isCurrent(target) {
      if (!canReadSelectionText(platform.os)) return false;
      try {
        return SelectionTextNative.isCurrent(target);
      } catch {
        return false;
      }
    },
    async read(target, options) {
      if (!canReadSelectionText(platform.os)) return { status: "unavailable" };
      const allowCopy = options?.uiaOnly === true ? false : allowCopyFallback();
      try {
        const result = await SelectionTextNative.read(target, allowCopy);
        if (result.status === "selected" && typeof result.text === "string") {
          return { status: "selected", text: result.text };
        }
        if (
          result.status === "noSelection" ||
          result.status === "unavailable" ||
          result.status === "stale"
        ) {
          return { status: result.status };
        }
        return { status: "unavailable" };
      } catch {
        return { status: "unavailable" };
      }
    },
  };
}
