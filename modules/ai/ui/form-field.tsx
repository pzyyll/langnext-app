import { Text, View, type JSX } from "nsh";
import { buildTooltip } from "../../../components/ui/tooltip";

interface FormFieldProps {
  label: string;
  labelAction?: JSX.Element;
  labelTestID?: string;
  tooltip?: string;
  hint?: string | null;
  error?: string | null;
  class?: string;
  children?: JSX.Element;
}

/** Labeled field container with conditional error and recovery/consequence hint. */
export function FormField(props: FormFieldProps) {
  return (
    <View class={`gap-1.5 ${props.class ?? ""}`}>
      <View class="min-h-5 flex-row items-center justify-between gap-2">
        <Text
          testID={props.labelTestID}
          accessibilityDescription={props.tooltip}
          tooltip={
            props.tooltip ? buildTooltip(props.tooltip, "top", { align: "start" }) : undefined
          }
          class="text-xs font-semibold text-muted-foreground"
        >
          {props.label}
        </Text>
        <If when={props.labelAction !== undefined}>{props.labelAction}</If>
      </View>
      {props.children}
      <If when={Boolean(props.error)}>
        <Text role="alert" class="text-xs text-destructive">
          {props.error}
        </Text>
      </If>
      <If when={!props.error && Boolean(props.hint)}>
        <Text class="text-xs text-muted-foreground">{props.hint}</Text>
      </If>
    </View>
  );
}
