import { type JSX } from "nsh";
import { ResizablePanel, ResizablePanelGroup } from "../ui/resizable";
import {
  MIN_DETAIL_WIDTH,
  MIN_RAIL_WIDTH,
  saveSplitRailWidth,
  splitMaxRailWidth,
  splitRailWidthFor,
  type SplitPageId,
} from "./split-rail";

interface SplitPaneProps {
  page: SplitPageId;
  handleAccessibilityLabel: string;
  rail: JSX.Element;
  detail: JSX.Element;
}

/**
 * Master-detail horizontal split with a draggable divider and persisted rail width.
 */
export function SplitPane(props: SplitPaneProps) {
  return (
    <ResizablePanelGroup
      testID={`${props.page}-split-pane`}
      axis="horizontal"
      handleAccessibilityLabel={props.handleAccessibilityLabel}
      onResize={({ sizes }) => {
        const nextRail = sizes[0];
        if (nextRail !== undefined) {
          void saveSplitRailWidth(props.page, nextRail);
        }
      }}
    >
      <ResizablePanel
        testID={`${props.page}-rail-panel`}
        size={splitRailWidthFor(props.page)}
        minSize={MIN_RAIL_WIDTH}
        maxSize={splitMaxRailWidth()}
        fixed
      >
        {props.rail}
      </ResizablePanel>
      <ResizablePanel testID={`${props.page}-detail-panel`} minSize={MIN_DETAIL_WIDTH}>
        {props.detail}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
