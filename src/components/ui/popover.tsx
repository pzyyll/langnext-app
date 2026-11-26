import {
  createMotion,
  Overlay,
  View,
  type Align,
  type Bounds,
  type JSX,
  type Placement,
  type Point,
  type ViewRef,
} from "nsh";
import { motion } from "../motion";
import { FLOATING_POPUP_SURFACE } from "./popup-surface";

export interface AnchoredPopoverProps {
  open: boolean;
  anchor: Bounds | ViewRef | null;
  placement?: Placement;
  align?: Align;
  offset?: number;
  margin?: number;
  maxWidth?: number;
  testID?: string;
  accessibilityLabel?: string;
  class?: string;
  onPressOutside?: (event: { pagePosition: Point }) => void;
  onCancel?: () => void;
  children?: JSX.Element;
}

function AnchoredPopoverSurface(props: Omit<AnchoredPopoverProps, "open">) {
  const enterMotion = createMotion({ enter: motion.popupEnter });

  return (
    <Overlay
      anchor={props.anchor}
      placement={props.placement ?? "bottom"}
      align={props.align ?? "start"}
      offset={props.offset ?? 6}
      margin={props.margin ?? 12}
      onPressOutside={(event) => props.onPressOutside?.(event)}
      onCancel={() => props.onCancel?.()}
    >
      <View
        testID={props.testID}
        role="region"
        accessibilityLabel={props.accessibilityLabel}
        class={`${FLOATING_POPUP_SURFACE} px-3.5 py-2.5 ${props.class ?? ""}`}
        // Runtime animated entrance style combined with measured anchor column maxWidth.
        style={
          props.maxWidth !== undefined
            ? [enterMotion.style, { maxWidth: props.maxWidth }]
            : enterMotion.style
        }
      >
        {props.children}
      </View>
    </Overlay>
  );
}

/** Floating anchored popover sharing the app's popup surface, elevation, and entrance motion. */
export function AnchoredPopover(props: AnchoredPopoverProps) {
  return (
    <If when={props.open && props.anchor !== null}>
      <AnchoredPopoverSurface
        anchor={props.anchor}
        placement={props.placement}
        align={props.align}
        offset={props.offset}
        margin={props.margin}
        maxWidth={props.maxWidth}
        testID={props.testID}
        accessibilityLabel={props.accessibilityLabel}
        class={props.class}
        onPressOutside={(event) => props.onPressOutside?.(event)}
        onCancel={() => props.onCancel?.()}
      >
        {props.children}
      </AnchoredPopoverSurface>
    </If>
  );
}
