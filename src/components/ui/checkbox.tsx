import { Text, View, type JSX } from "nsh";
import { Checkbox as BaseCheckbox } from "nsh/base";
import { motion } from "../motion";
import { Icon } from "./icon";

interface CheckboxProps {
  checked?: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label?: string;
  accessibilityLabel?: string;
  testID?: string;
  class?: string;
  onChange?: (checked: boolean) => void;
  children?: JSX.Element;
}

/** Styled checkbox supporting checked and indeterminate states. */
export function Checkbox(props: CheckboxProps) {
  return (
    <BaseCheckbox
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      checked={props.checked}
      indeterminate={props.indeterminate}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange?.(checked)}
      class={`flex-row items-center gap-2 disabled:opacity-50 ${props.class ?? ""}`}
      indicatorClass={`size-4 shrink-0 items-center justify-center rounded border border-input bg-background checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary focus-visible:ring-2 focus-visible:ring-ring ${motion.navigationFeedback}`}
      indicator={
        <If
          when={props.indeterminate}
          else={
            <If when={props.checked}>
              <Icon name="check" tone="primary-foreground" class="size-3" />
            </If>
          }
        >
          <Icon name="minus" tone="primary-foreground" class="size-3" />
        </If>
      }
    >
      <If when={props.label !== undefined}>
        <Text class="text-sm text-foreground">{props.label}</Text>
      </If>
      <If when={props.children !== undefined}>
        <View class="min-w-0 flex-1">{props.children}</View>
      </If>
    </BaseCheckbox>
  );
}
