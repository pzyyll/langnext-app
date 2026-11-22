import { Text } from "nsh";
import { Switch as BaseSwitch } from "nsh/base";
import { motion } from "../motion";
import { buildTooltip } from "./tooltip";

interface SwitchProps {
  label?: string;
  labelTestID?: string;
  tooltip?: string;
  accessibilityLabel?: string;
  checked: boolean;
  disabled?: boolean;
  variant?: "row" | "inline";
  testID?: string;
  onChange: (checked: boolean) => void;
}

/** Theme-styled native switch supporting full setting rows (`row`) and compact inline controls (`inline`). */
export function Switch(props: SwitchProps) {
  const mode = () => props.variant ?? (props.label ? "row" : "inline");

  return (
    <BaseSwitch
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      checked={props.checked}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange(checked)}
      class={
        mode() === "row"
          ? `flex-row-reverse items-center justify-between gap-4 rounded-lg px-3 py-2 hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${motion.navigationFeedback}`
          : `flex-row items-center gap-2 rounded-lg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50`
      }
      trackClass={`w-11 shrink-0 rounded-full bg-input p-0.5 checked:bg-primary ${motion.navigationFeedback}`}
      thumbClass={`size-5 rounded-full bg-background shadow-sm checked:translate-x-5 ${motion.switchThumb}`}
    >
      <If when={props.label !== undefined}>
        <Text
          testID={props.labelTestID}
          accessibilityDescription={props.tooltip}
          tooltip={
            props.tooltip ? buildTooltip(props.tooltip, "top", { align: "start" }) : undefined
          }
          class={
            mode() === "row"
              ? "text-sm font-medium text-card-foreground"
              : "text-sm text-foreground"
          }
        >
          {props.label}
        </Text>
      </If>
    </BaseSwitch>
  );
}
