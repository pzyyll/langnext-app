import { cleanup, createAnimatedValue, effect, reduceMotion, View } from "nsh";
import { motion } from "../motion";

export interface SkeletonProps {
  testID?: string;
  class?: string;
  delay?: number;
  active?: boolean;
}

/** Pulsing placeholder bar that honors reduced motion. */
export function Skeleton(props: SkeletonProps) {
  const opacity = createAnimatedValue(motion.skeletonPulse.reducedOpacity);

  effect(() => {
    if (reduceMotion() || props.active === false) {
      opacity.set(motion.skeletonPulse.reducedOpacity);
      return;
    }
    void opacity.keyframes(
      [
        motion.skeletonPulse.minOpacity,
        motion.skeletonPulse.maxOpacity,
        motion.skeletonPulse.minOpacity,
      ],
      {
        duration: motion.skeletonPulse.duration,
        delay: props.delay ?? 0,
        easing: motion.skeletonPulse.easing,
        iterations: "infinite",
      },
    );
    cleanup(() => {
      void opacity.stop();
    });
  });

  return (
    <View
      testID={props.testID}
      accessibilityElementsHidden={true}
      class={`rounded-md bg-selection/80 ${props.class ?? ""}`}
      // Runtime animated value drives native UI-thread opacity pulse.
      style={{ opacity }}
    />
  );
}
