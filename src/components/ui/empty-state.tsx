import { Text, View, type JSX } from "nsh";
import { Button } from "./button";
import { Card } from "./card";
import { Icon, type IconName } from "./icon";

/** One channel the empty state offers as a direct add action. */
export interface EmptyStateChoice {
  id: string;
  label: string;
  accessibilityLabel: string;
  /** Defaults to `<testID>-channel-<id>`. */
  testID?: string;
  /** The channel's mark before its name. */
  leading?: JSX.Element;
  onPress: () => void;
}

interface ChannelEmptyStateProps {
  testID: string;
  icon: IconName;
  title: string;
  choicesLabel: string;
  choices: readonly EmptyStateChoice[];
  busy?: boolean;
  compact?: boolean;
}

/** First-run card that offers each channel as a direct add action. */
export function ChannelEmptyState(props: ChannelEmptyStateProps) {
  return (
    <Card testID={props.testID} class={props.compact ? "gap-4 p-5" : "gap-6 p-8"}>
      <View class="items-center gap-4">
        <View class="size-16 items-center justify-center rounded-2xl bg-muted">
          <Icon name={props.icon} tone="muted-foreground" class="size-7" />
        </View>
        <Text role="header" class="text-center text-lg font-semibold text-card-foreground">
          {props.title}
        </Text>
      </View>

      <View class={props.compact ? "mx-4 h-px bg-border" : "mx-6 h-px bg-border"} />

      <View class="items-center gap-3">
        <Text class="text-center text-xs text-muted-foreground">{props.choicesLabel}</Text>
        <View class="w-full flex-row flex-wrap justify-center gap-2">
          <Each of={props.choices} key={(choice) => choice.id}>
            {(choice) => (
              <Button
                testID={choice().testID ?? `${props.testID}-channel-${choice().id}`}
                variant="outline"
                size="sm"
                disabled={props.busy}
                accessibilityLabel={choice().accessibilityLabel}
                onPress={() => choice().onPress()}
                class="h-auto px-4 py-1.5"
              >
                <If when={choice().leading !== undefined}>{choice().leading}</If>
                <Text class="text-sm font-medium text-foreground">{choice().label}</Text>
              </Button>
            )}
          </Each>
        </View>
      </View>
    </Card>
  );
}
