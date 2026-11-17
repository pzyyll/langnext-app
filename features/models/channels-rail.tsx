import { Scroll, Text, View, windowSize } from "nsh";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { getAdapterLabel } from "../../services/protocols/adapters";
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
  const railWidthClass = () => (windowSize().width < 860 ? "w-48" : "w-60");

  return (
    <View
      testID="channels-rail"
      class={`${railWidthClass()} shrink-0 border-r border-border bg-background`}
    >
      <View class="h-12 shrink-0 flex-row items-center justify-between border-b border-border px-4">
        <Text role="header" class="text-sm font-semibold text-foreground">
          {t("models.channels.title")}
        </Text>
        <Button
          testID="add-channel-button"
          variant="ghost"
          size="icon-sm"
          tooltip={t("models.channel.add")}
          accessibilityLabel={t("models.channel.add")}
          onPress={() => props.onAdd()}
        >
          <Icon name="plus" tone="foreground" class="size-4" />
        </Button>
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
                            class={`flex-row items-center gap-1 rounded-lg border pr-1 ${motion.navigationFeedback}`}
                            classList={{
                              "border-border bg-accent": isSelected(),
                              "border-transparent hover:bg-accent/50 active:bg-accent":
                                !isSelected(),
                            }}
                          >
                            <Button
                              testID={`channel-item-${channel().id}`}
                              variant="ghost"
                              size="row"
                              selected={isSelected()}
                              accessibilityLabel={
                                channel().enabled
                                  ? `${channel().displayName} (${t("models.channel.enabled")})`
                                  : `${channel().displayName} (${t("models.filter.disabled")})`
                              }
                              onPress={() => props.onSelect(channel().id)}
                              class="min-w-0 flex-1 hover:bg-transparent active:bg-transparent"
                            >
                              <View class="w-4 shrink-0 items-center justify-center">
                                <If
                                  when={channel().enabled}
                                  else={
                                    <Icon
                                      name="minus"
                                      tone="muted-foreground"
                                      class="size-3.5 opacity-60"
                                    />
                                  }
                                >
                                  <Icon name="check-circle" tone="success" class="size-3.5" />
                                </If>
                              </View>

                              <View class="min-w-0 flex-1 gap-0.5">
                                <View class="flex-row items-center gap-1.5">
                                  <Text
                                    class={
                                      isSelected()
                                        ? "min-w-0 shrink truncate text-sm font-medium text-accent-foreground"
                                        : channel().enabled
                                          ? "min-w-0 shrink truncate text-sm font-medium text-foreground"
                                          : "min-w-0 shrink truncate text-sm text-muted-foreground"
                                    }
                                  >
                                    {channel().displayName}
                                  </Text>
                                  <If when={!channel().enabled}>
                                    <Badge label={t("models.filter.disabled")} tone="neutral" />
                                  </If>
                                </View>
                                <Text class="truncate text-xs text-muted-foreground">
                                  {getAdapterLabel(channel().adapterId)}
                                </Text>
                              </View>
                            </Button>

                            <If when={isSelected() && props.channels.length > 1}>
                              <View class="shrink-0 flex-row items-center gap-0.5">
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
    </View>
  );
}
