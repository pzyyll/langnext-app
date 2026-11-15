import { createMotion, View, type JSX } from "nsh";
import { motion } from "./motion";

/** Fills the work area and fades in each newly selected page. */
export function PageSurface(props: { children?: JSX.Element }) {
  const entrance = createMotion({ enter: motion.pageEnter });

  return (
    <View class="min-w-0 flex-1" style={entrance.style}>
      {props.children}
    </View>
  );
}
