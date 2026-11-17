import { Text, View, type JSX } from "nsh";

interface CardProps {
  testID?: string;
  class?: string;
  children?: JSX.Element;
}

/** Surface container matching Settings cards. */
export function Card(props: CardProps) {
  return (
    <View
      testID={props.testID}
      class={`gap-5 rounded-xl border border-border bg-card p-6 ${props.class ?? ""}`}
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
