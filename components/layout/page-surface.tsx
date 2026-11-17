import { createMotion, Scroll, View, type JSX } from "nsh";
import { motion } from "../motion";

interface PageSurfaceProps {
  /** The test id the page surface carries. */
  testID?: string;
  /** Layout mode: `"column"` wraps children in a scrolling centred column; `"split"` fills horizontally for master-detail pages. */
  layout?: "column" | "split";
  children?: JSX.Element;
}

/** The one layout every sidebar destination shares: the work area is the panel
 * the chrome frames, so it carries the work surface's fill and its rounded
 * start-start corner, and it scrolls its own content column. The column fills
 * the window up to a reading width and stays centred, so a wide window grows
 * the margins rather than the lines. No page sets its own width, padding or
 * scrolling, so switching destinations never moves the leading edge. */
export function PageSurface(props: PageSurfaceProps) {
  const entrance = createMotion({ enter: motion.pageEnter });

  return (
    <View
      testID={props.layout === "split" ? props.testID : undefined}
      class="min-w-0 flex-1 overflow-hidden rounded-xl bg-background"
      classList={{ "flex-row": props.layout === "split" }}
      style={entrance.style}
    >
      <If
        when={props.layout === "split"}
        else={
          <Scroll testID={props.testID} class="min-w-0 flex-1">
            <View class="mx-auto w-full max-w-5xl gap-8 p-8">{props.children}</View>
          </Scroll>
        }
      >
        {props.children}
      </If>
    </View>
  );
}
