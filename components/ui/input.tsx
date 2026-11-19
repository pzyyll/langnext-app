import { View, type InputRef, type JSX, type KeyboardType } from "nsh";
import { Input as BaseInput } from "nsh/base";
import { t } from "nsh/i18n";
import { motion } from "../motion";
import { Button } from "./button";
import { Icon, type IconName } from "./icon";

export type InputSize = "sm" | "md";

interface InputProps {
  testID?: string;
  ref?: (node: InputRef) => void;
  value?: string;
  placeholder?: string;
  accessibilityLabel?: string;
  masked?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  autoFocus?: boolean;
  keyboardType?: KeyboardType;
  submitBehavior?: "submit" | "blurAndSubmit" | "newline";
  size?: InputSize;
  leadingIcon?: IconName;
  clearLabel?: string;
  trailing?: JSX.Element;
  class?: string;
  onChange?: (value: string) => void;
  onSubmit?: (text: string) => void;
  onKeyPress?: (key: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onClear?: () => void;
}

/** Single-line styled text field supporting optional leading icon and clear action. */
export function Input(props: InputProps) {
  const heightClass = () => (props.size === "sm" ? "h-8" : "h-9");
  const textClass = () => (props.size === "sm" ? "text-xs" : "text-sm");

  return (
    <View
      class={`flex-row items-center rounded-lg border border-input bg-background pl-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring ${heightClass()} ${motion.navigationFeedback} ${props.class ?? ""}`}
      classList={{
        "opacity-60": Boolean(props.disabled || props.readonly),
        "pr-1": props.trailing !== undefined,
        "pr-3": props.trailing === undefined,
      }}
    >
      <If when={props.leadingIcon !== undefined}>
        <View class="mr-2 shrink-0">
          <Icon name={props.leadingIcon!} tone="muted-foreground" class="size-3.5" />
        </View>
      </If>
      <BaseInput
        testID={props.testID}
        ref={(node) => props.ref?.(node)}
        value={props.value}
        placeholder={props.placeholder}
        accessibilityLabel={props.accessibilityLabel}
        masked={props.masked}
        disabled={props.disabled}
        readonly={props.readonly}
        autoFocus={props.autoFocus}
        keyboardType={props.keyboardType}
        submitBehavior={props.submitBehavior}
        onChange={({ value }) => props.onChange?.(value)}
        onSubmit={({ text }) => props.onSubmit?.(text)}
        onKeyPress={({ key }) => props.onKeyPress?.(key)}
        onFocus={() => props.onFocus?.()}
        onBlur={() => props.onBlur?.()}
        class={`min-w-0 flex-1 bg-transparent text-foreground placeholder:text-muted-foreground ${textClass()}`}
      />
      <If when={props.onClear !== undefined && (props.value ?? "").length > 0}>
        <Button
          size="icon-sm"
          variant="ghost"
          tooltip={props.clearLabel ?? t("common.clearInput")}
          accessibilityLabel={props.clearLabel ?? t("common.clearInput")}
          onPress={() => props.onClear?.()}
          class="ml-1 shrink-0"
        >
          <Icon name="close" tone="muted-foreground" class="size-3.5" />
        </Button>
      </If>
      {props.trailing}
    </View>
  );
}
