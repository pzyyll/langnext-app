import { View, type InputRef, type JSX, type SubmitBehavior } from "nsh";
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
  autoFocus?: boolean;
  submitBehavior?: SubmitBehavior;
  footer?: JSX.Element;
  class?: string;
  inputClass?: string;
  onChange?: (value: string) => void;
  onFocus?: () => void;
  onSubmit?: (text: string) => void;
  onCompositionChange?: (event: { composing: boolean; text: string }) => void;
}

/** Multi-line text field supporting an optional embedded footer toolbar row. */
export function Textarea(props: TextareaProps) {
  return (
    <View
      class={`rounded-lg border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring ${
        props.footer === undefined ? "px-3 py-2" : ""
      } ${props.disabled || props.readonly ? "opacity-60" : ""} ${motion.navigationFeedback} ${props.class ?? ""}`}
    >
      <View class={props.footer === undefined ? "w-full" : "px-3 pt-2"}>
        <BaseInput
          testID={props.testID}
          ref={(node) => props.ref?.(node)}
          value={props.value}
          placeholder={props.placeholder}
          accessibilityLabel={props.accessibilityLabel}
          multiline
          autoFocus={props.autoFocus}
          submitBehavior={props.submitBehavior ?? "newline"}
          disabled={props.disabled}
          readonly={props.readonly}
          onChange={({ value }) => props.onChange?.(value)}
          onFocus={() => props.onFocus?.()}
          onSubmit={({ text }) => props.onSubmit?.(text)}
          onCompositionChange={(event) => props.onCompositionChange?.(event)}
          class={`min-h-24 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground ${props.inputClass ?? ""}`}
        />
      </View>
      <If when={props.footer !== undefined}>
        <View class="pb-1.5 pl-3 pr-1.5">{props.footer}</View>
      </If>
    </View>
  );
}
