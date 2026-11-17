import { Text, View, type JSX } from "nsh";

interface FormFieldProps {
  label: string;
  hint?: string | null;
  error?: string | null;
  class?: string;
  children?: JSX.Element;
}

/** Labeled field container with conditional error and recovery/consequence hint. */
export function FormField(props: FormFieldProps) {
  return (
    <View class={`gap-1.5 ${props.class ?? ""}`}>
      <Text class="text-xs font-medium text-foreground">{props.label}</Text>
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
