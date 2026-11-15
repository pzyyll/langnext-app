import type { MotionSpec } from "nsh";

/** Shared native motion for navigation and overlays. Honors reduced motion. */
export const motion = {
  navigationFeedback: "transition-colors duration-150 ease-out motion-reduce:duration-0",
  tooltip: "transition-opacity duration-150 ease-out motion-reduce:duration-0",
  popup: "transition duration-150 ease-out motion-reduce:duration-0",
  popupHidden: "opacity-0 -translate-y-1 motion-reduce:translate-y-0",
  aboutDialog: "fade" as const,
  pageEnter: {
    keyframes: { opacity: [0, 1] },
    duration: 200,
    easing: "easeOut",
  } satisfies MotionSpec,
};
