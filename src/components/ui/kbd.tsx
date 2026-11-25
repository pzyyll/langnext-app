import { Text, View } from "nsh";

interface KbdProps {
  children: string;
  class?: string;
}

/** Compact monospace keycap label for keyboard shortcut hints. */
export function Kbd(props: KbdProps) {
  return (
    <View
      class={`items-center justify-center rounded border border-border bg-surface-control px-1.5 py-0.5 ${props.class ?? ""}`}
    >
      <Text class="font-mono text-xs leading-none text-muted-foreground">{props.children}</Text>
    </View>
  );
}
