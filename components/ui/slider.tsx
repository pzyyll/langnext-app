import { Slider as BaseSlider } from "nsh/base";
import { motion } from "../motion";

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  accessibilityLabel: string;
  testID?: string;
  class?: string;
  onChange: (value: number) => void;
}

/** Styled slider over the semantic control: theme track, range, and thumb. */
export function Slider(props: SliderProps) {
  return (
    <BaseSlider
      testID={props.testID}
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step}
      disabled={props.disabled}
      accessibilityLabel={props.accessibilityLabel}
      class={props.class}
      trackClass="group h-6 justify-center"
      indicatorClass="h-1.5 rounded-full bg-muted"
      rangeClass="rounded-full bg-primary"
      thumbClass={`size-4 rounded-full border border-border bg-background shadow-sm hover:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${motion.navigationFeedback}`}
      onChange={({ value }) => {
        if (typeof value === "number") props.onChange(value);
      }}
    />
  );
}
