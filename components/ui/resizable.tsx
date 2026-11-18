import { type JSX } from "nsh";
import {
  ResizablePanel as BaseResizablePanel,
  ResizablePanelGroup as BaseResizablePanelGroup,
  type Axis,
  type ResizablePanelGroupProps as BaseResizablePanelGroupProps,
  type ResizablePanelProps as BaseResizablePanelProps,
} from "nsh/base";
import { t } from "nsh/i18n";
import { motion } from "../motion";

interface ResizablePanelGroupProps {
  axis?: Axis;
  disabled?: boolean;
  testID?: string;
  handleAccessibilityLabel?: string;
  class?: string;
  onResize?: BaseResizablePanelGroupProps["onResize"];
  children?: JSX.Element;
}

/**
 * Theme-styled resizable split panel group built over nsh/base.
 * Draws a hairline border divider that highlights on hover and active drag.
 */
export function ResizablePanelGroup(props: ResizablePanelGroupProps) {
  return (
    <BaseResizablePanelGroup
      testID={props.testID}
      axis={props.axis ?? "horizontal"}
      disabled={props.disabled}
      handleAccessibilityLabel={props.handleAccessibilityLabel ?? t("common.resizePanels")}
      onResize={props.onResize}
      class={`min-w-0 flex-1 ${props.class ?? ""}`}
      handleClass={`bg-border group-hover:bg-ring group-active:bg-primary ${motion.navigationFeedback}`}
      handleThumbClass={`h-6 w-1 rounded-full bg-muted-foreground opacity-0 group-hover:opacity-60 group-active:opacity-90 ${motion.tooltip}`}
    >
      {props.children}
    </BaseResizablePanelGroup>
  );
}

interface ResizablePanelProps {
  size?: number | null;
  minSize?: number;
  maxSize?: number | null;
  fixed?: boolean;
  visible?: boolean;
  testID?: string;
  class?: string;
  onResize?: BaseResizablePanelProps["onResize"];
  children?: JSX.Element;
}

/** Direct child panel of ResizablePanelGroup. */
export function ResizablePanel(props: ResizablePanelProps) {
  return (
    <BaseResizablePanel
      testID={props.testID}
      size={props.size}
      minSize={props.minSize}
      maxSize={props.maxSize}
      fixed={props.fixed}
      visible={props.visible}
      onResize={props.onResize}
      class={`min-w-0 ${props.class ?? ""}`}
    >
      {props.children}
    </BaseResizablePanel>
  );
}
