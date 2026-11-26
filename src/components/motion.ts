import type { MotionSpec } from "nsh";
import type { ToastMotion } from "nsh/base";

/** Shared native motion for navigation, controls, and overlays. Honors reduced motion. */
export const motion = {
  navigationFeedback: "transition-colors duration-150 ease-out motion-reduce:duration-0",
  pressScale:
    "transition duration-150 ease-out active:scale-95 motion-reduce:duration-0 motion-reduce:scale-100",
  switchThumb: "transition-transform duration-150 ease-out motion-reduce:duration-0",
  disclosureIcon: "transition-transform duration-150 ease-out motion-reduce:duration-0",
  tooltip: "transition-opacity duration-150 ease-out motion-reduce:duration-0",
  avatarImage: "transition-opacity duration-150 ease-out motion-reduce:duration-0",
  popup: "transition duration-150 ease-out motion-reduce:duration-0",
  popupHidden: "opacity-0 -translate-y-1 motion-reduce:translate-y-0",
  aboutDialog: "fade" as const,
  dialogAnimation: "fade" as const,
  toastTransition: "transition duration-200 ease-out motion-reduce:duration-0",
  toastHidden: "opacity-0 translate-y-2 motion-reduce:translate-y-0",
  toastStack: {
    duration: 220,
    exitDuration: 180,
    expandedGap: 8,
    collapsedVisible: 3,
  } satisfies ToastMotion,
  pageEnter: {
    keyframes: { opacity: [0, 1] },
    duration: 200,
    easing: "easeOut",
  } satisfies MotionSpec,
  skeletonPulse: {
    duration: 1300,
    easing: "easeInOut" as const,
    minOpacity: 0.45,
    maxOpacity: 1,
    reducedOpacity: 0.7,
  },
  skeletonStaggerMs: 180,
  statusPulse: {
    duration: 1300,
    easing: "easeInOut" as const,
    minOpacity: 0.45,
    maxOpacity: 1,
    reducedOpacity: 1,
  },
};
