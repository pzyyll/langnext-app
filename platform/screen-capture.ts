import { platform } from "nsh";
import { ScreenCaptureNative } from "langnext/native";

/** Instruction line and theme colors the native selection overlay draws. */
export interface ScreenCaptureOverlayConfig {
  /** Localized instruction shown on every display's overlay. */
  caption: string;
  /** Keyboard crosshair color, as `#rrggbbaa` or `#rrggbb`. */
  accentColor: string;
  /** Instruction text color, as `#rrggbbaa` or `#rrggbb`. */
  textColor: string;
  /** Fill behind the instruction text, as `#rrggbbaa` or `#rrggbb`. */
  backdropColor: string;
}

/** How one screen selection ended. */
export type ScreenCaptureOutcome =
  | { status: "captured"; png: Uint8Array }
  | { status: "cancelled" }
  | { status: "tooLarge" }
  | { status: "failed" }
  /** The platform has no native selection surface. */
  | { status: "unavailable" };

/** One screen region selection: hides nothing itself, cancels through `signal`. */
export interface ScreenCapturePort {
  capture(options: {
    signal?: AbortSignal;
    overlay: ScreenCaptureOverlayConfig;
  }): Promise<ScreenCaptureOutcome>;
}

/** Screen selection uses Win32 surfaces and snapshots, so only Windows offers it. */
export function canCaptureScreen(os: string): boolean {
  return os === "windows";
}

/** Requests are numbered so one cancellation can never end another session. */
let nextRequestId = 1;

/** Production screen selection over the native `ScreenCaptureNative` module. */
export const ScreenCapture: ScreenCapturePort = {
  async capture({ signal, overlay }) {
    if (!canCaptureScreen(platform.os)) return { status: "unavailable" };
    if (signal?.aborted) return { status: "cancelled" };

    const requestId = nextRequestId;
    nextRequestId += 1;
    const cancel = () => {
      ScreenCaptureNative.cancel(requestId);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await ScreenCaptureNative.capture(requestId, overlay);
      if (result.status === "captured" && result.png) {
        return { status: "captured", png: result.png };
      }
      if (result.status === "tooLarge") return { status: "tooLarge" };
      if (result.status === "cancelled") return { status: "cancelled" };
      return { status: "failed" };
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  },
};
