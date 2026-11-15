import type { MotionSpec } from "nsh";

/** Shared timing for sidebar feedback and page entry. Native motion honors reduced motion. */
export const motion = {
  navigationFeedback: "transition-colors duration-150 ease-out motion-reduce:duration-0",
  tooltip: "transition-opacity duration-150 ease-out motion-reduce:duration-0",
  pageEnter: {
    keyframes: { opacity: [0, 1] },
    duration: 200,
    easing: "easeOut",
  } satisfies MotionSpec,
};
