import { View, type InputRef } from "nsh";
import { Input as BaseInput } from "nsh/base";
import { motion } from "../motion";

interface TextareaProps {
  testID?: string;
  ref?: (node: InputRef) => void;
  value?: string;
  placeholder?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  readonly?: boolean;
  class?: string;
  inputClass?: string;
  onChange?: (value: string) => void;
  onFocus?: () => void;
}

/** Multi-line text field where Return inserts a newline instead of submitting. */
export function Textarea(props: TextareaProps) {
  return (
    <View
      class={`rounded-lg border border-input bg-background px-3 py-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring ${props.disabled || props.readonly ? "opacity-60" : ""} ${motion.navigationFeedback} ${props.class ?? ""}`}
    >
      <BaseInput
        testID={props.testID}
        ref={(node) => props.ref?.(node)}
        value={props.value}
        placeholder={props.placeholder}
        accessibilityLabel={props.accessibilityLabel}
        multiline
        submitBehavior="newline"
        disabled={props.disabled}
        readonly={props.readonly}
        onChange={({ value }) => props.onChange?.(value)}
        onFocus={() => props.onFocus?.()}
        class={`min-h-24 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground ${props.inputClass ?? ""}`}
      />
    </View>
  );
}
