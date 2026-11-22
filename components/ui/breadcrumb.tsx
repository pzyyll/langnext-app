import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { motion } from "../motion";
import { Icon } from "./icon";

export interface BreadcrumbItem {
  label: string;
  testID?: string;
  onPress?: () => void;
}

interface BreadcrumbProps {
  items: readonly BreadcrumbItem[];
  accessibilityLabel?: string;
  testID?: string;
}

/** Hierarchical header breadcrumb with clickable ancestor destinations and current page title. */
export function Breadcrumb(props: BreadcrumbProps) {
  return (
    <View
      role="navigation"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      class="min-w-0 flex-row items-center gap-1.5"
    >
      <Each of={props.items} key={(item, index) => `${index}:${item.onPress !== undefined}`}>
        {(item, index) => (
          <>
            <If when={index() > 0}>
              <Icon name="chevron-right" tone="muted-foreground" class="size-4 shrink-0" />
            </If>
            <If
              when={item().onPress !== undefined}
              else={
                <Text
                  role="header"
                  testID={item().testID}
                  class="min-w-0 truncate text-lg font-semibold text-foreground"
                >
                  {item().label}
                </Text>
              }
            >
              <BaseButton
                testID={item().testID}
                accessibilityLabel={item().label}
                onPress={() => item().onPress?.()}
                class={`group shrink-0 rounded-md px-2 py-1 hover:bg-accent active:bg-border focus-visible:ring-2 focus-visible:ring-ring ${motion.navigationFeedback}`}
              >
                <Text class="text-lg font-medium text-muted-foreground group-hover:text-foreground">
                  {item().label}
                </Text>
              </BaseButton>
            </If>
          </>
        )}
      </Each>
    </View>
  );
}
