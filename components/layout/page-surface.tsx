import { createMotion, Scroll, View, type JSX } from "nsh";
import { motion } from "../motion";

interface PageSurfaceProps {
  /** The test id the page's scrolling surface carries. */
  testID?: string;
  children?: JSX.Element;
}

/** The one layout every sidebar destination shares: the work area scrolls and
 * its content is a column that fills the window up to a reading width and stays
 * centred, so a wide window grows the margins rather than the lines. No page
 * sets its own width, padding or scrolling, so switching destinations never
 * moves the leading edge. */
export function PageSurface(props: PageSurfaceProps) {
  const entrance = createMotion({ enter: motion.pageEnter });

  return (
    <View class="min-w-0 flex-1" style={entrance.style}>
      <Scroll testID={props.testID} class="min-w-0 flex-1">
        <View class="mx-auto w-full max-w-4xl gap-8 p-8">{props.children}</View>
      </Scroll>
    </View>
  );
}
