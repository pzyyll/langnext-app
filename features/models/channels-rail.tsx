import { Scroll, Text, View, windowSize } from "nsh";
import { t } from "nsh/i18n";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import type { ProviderChannel } from "./types";

interface ChannelsRailProps {
  channels: ProviderChannel[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, direction: "up" | "down") => void;
  onAdd: () => void;
  onRetry: () => void;
}

/** Left master list of configured provider channels with selection and reordering. */
export function ChannelsRail(props: ChannelsRailProps) {
  const railWidthClass = () => (windowSize().width < 860 ? "w-48" : "w-56");

  return (
    <View
      testID="channels-rail"
      class={`${railWidthClass()} shrink-0 border-r border-border bg-background`}
    >
      <View class="border-b border-border px-4 py-3">
        <Text
          role="header"
          class="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {t("models.channels.title")}
        </Text>
      </View>

      <Scroll class="min-h-0 flex-1">
        <If
          when={props.loading && props.channels.length === 0}
          else={
            <If
              when={Boolean(props.error) && props.channels.length === 0}
              else={
                <If
                  when={props.channels.length > 0}
                  else={
                    <View class="p-4">
                      <Text class="text-xs text-muted-foreground">
                        {t("models.channels.empty")}
                      </Text>
                    </View>
                  }
                >
                  <View class="gap-1 p-2">
                    <Each of={props.channels} key={(channel) => channel.id}>
                      {(channel, index) => {
                        const isSelected = () => props.selectedId === channel().id;
                        return (
                          <View
                            class="flex-row items-center gap-0.5 rounded-lg pr-1"
                            classList={{
                              "bg-accent": isSelected(),
                              "hover:bg-accent/50": !isSelected(),
                            }}
                          >
                            <Button
                              testID={`channel-item-${channel().id}`}
                              variant="ghost"
                              size="sm"
                              selected={isSelected()}
                              accessibilityLabel={channel().displayName}
                              onPress={() => props.onSelect(channel().id)}
                              class="h-8 min-w-0 flex-1 justify-between px-2 hover:bg-transparent active:bg-transparent"
                            >
                              <Text
                                class={
                                  isSelected()
                                    ? "min-w-0 flex-1 truncate text-sm font-medium text-accent-foreground"
                                    : "min-w-0 flex-1 truncate text-sm text-foreground"
                                }
                              >
                                {channel().displayName}
                              </Text>
                              <If when={channel().enabled}>
                                <Badge label={t("models.channels.on")} tone="success" />
                              </If>
                            </Button>

                            <If when={isSelected()}>
                              <View class="shrink-0 flex-row items-center">
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  accessibilityLabel={t("models.channels.moveUp", {
                                    name: channel().displayName,
                                  })}
                                  disabled={index() === 0}
                                  onPress={() => props.onMove(channel().id, "up")}
                                  class="size-6"
                                >
                                  <Icon name="arrow-up" tone="muted-foreground" class="size-3" />
                                </Button>
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  accessibilityLabel={t("models.channels.moveDown", {
                                    name: channel().displayName,
                                  })}
                                  disabled={index() === props.channels.length - 1}
                                  onPress={() => props.onMove(channel().id, "down")}
                                  class="size-6"
                                >
                                  <Icon name="arrow-down" tone="muted-foreground" class="size-3" />
                                </Button>
                              </View>
                            </If>
                          </View>
                        );
                      }}
                    </Each>
                  </View>
                </If>
              }
            >
              <View class="gap-3 p-4">
                <Text role="alert" class="text-xs text-destructive">
                  {props.error}
                </Text>
                <Button
                  size="sm"
                  variant="outline"
                  label={t("common.retry")}
                  onPress={() => props.onRetry()}
                />
              </View>
            </If>
          }
        >
          <View class="p-4">
            <Text class="text-xs text-muted-foreground">{t("models.channels.loading")}</Text>
          </View>
        </If>
      </Scroll>

      <View class="border-t border-border p-2">
        <Button
          testID="add-channel-button"
          variant="outline"
          size="sm"
          accessibilityLabel={t("models.channel.add")}
          onPress={() => props.onAdd()}
          class="w-full"
        >
          <Icon name="plus" tone="foreground" class="size-3.5" />
          <Text class="text-sm font-medium text-foreground">{t("models.channel.add")}</Text>
        </Button>
      </View>
    </View>
  );
}
