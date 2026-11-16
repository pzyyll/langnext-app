import { Text } from "nsh";
import { Switch as BaseSwitch } from "nsh/base";
import { motion } from "../motion";

interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** A setting row with a leading label and a trailing native switch. */
export function Switch(props: SwitchProps) {
  return (
    <BaseSwitch
      accessibilityLabel={props.label}
      checked={props.checked}
      onChange={({ checked }) => props.onChange(checked)}
      class={`flex-row-reverse items-center justify-between gap-4 rounded-lg px-3 py-2 ${motion.navigationFeedback} hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring`}
      trackClass={`w-11 shrink-0 rounded-full bg-input p-0.5 checked:bg-primary ${motion.navigationFeedback}`}
      thumbClass={`size-5 rounded-full bg-background shadow-sm checked:translate-x-5 ${motion.switchThumb}`}
    >
      <Text class="text-sm font-medium text-card-foreground">{props.label}</Text>
    </BaseSwitch>
  );
}
