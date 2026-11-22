import { Text, View, type JSX } from "nsh";

export type CardVariant = "default" | "subtle";

interface CardProps {
  testID?: string;
  variant?: CardVariant;
  class?: string;
  children?: JSX.Element;
}

const CARD_VARIANT_CLASSES: Record<CardVariant, string> = {
  default: "gap-5 rounded-xl border border-border bg-card p-6",
  subtle: "gap-0 rounded-xl border border-border bg-surface-subtle p-0",
};

/** Surface container matching Settings cards or subtle inset result cards. */
export function Card(props: CardProps) {
  return (
    <View
      testID={props.testID}
      class={`${CARD_VARIANT_CLASSES[props.variant ?? "default"]} ${props.class ?? ""}`}
    >
      {props.children}
    </View>
  );
}

interface SectionHeadingProps {
  title: string;
  class?: string;
}

/** Section header inside a card. */
export function SectionHeading(props: SectionHeadingProps) {
  return (
    <Text role="header" class={`text-base font-semibold text-card-foreground ${props.class ?? ""}`}>
      {props.title}
    </Text>
  );
}
