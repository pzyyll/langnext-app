import { locale, Text, View, windowSize } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { DEEPL_NO_CHARACTER_LIMIT, type DeepLUsage } from "../../modules/deepl/client";
import { deepLUsageStore } from "./deepl-usage";

interface DeepLUsageSectionProps {
  presetId: string;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(locale()).format(value);
}

function formatPeriodEnd(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric" }).format(date);
}

/** False when DeepL reports its no-limit sentinel or an empty allowance. */
function hasLimit(usage: DeepLUsage): boolean {
  return usage.characterLimit > 0 && usage.characterLimit < DEEPL_NO_CHARACTER_LIMIT;
}

function usedShare(usage: DeepLUsage): number {
  const share = (usage.characterCount / usage.characterLimit) * 100;
  return Math.round(Math.min(100, Math.max(0, share)) * 100) / 100;
}

/** Editor section that reads and shows the preset key's character usage. */
export function DeepLUsageSection(props: DeepLUsageSectionProps) {
  const compact = () => windowSize().width < 860;
  const cardClass = () => (compact() ? "gap-4 p-4" : "gap-5 p-5");

  if (deepLUsageStore.state(props.presetId) === null) {
    void deepLUsageStore.load(props.presetId);
  }

  const state = () => deepLUsageStore.state(props.presetId);
  const loading = () => state()?.kind === "loading";
  const readyUsage = () => {
    const current = state();
    return current?.kind === "ready" ? current.usage : null;
  };
  const errorText = () => {
    const current = state();
    return current?.kind === "error" ? current.message : null;
  };

  const limitLabel = (usage: DeepLUsage): string =>
    hasLimit(usage)
      ? t("presets.deepl.usage.limit", { limit: formatCount(usage.characterLimit) })
      : t("presets.deepl.usage.characters");

  const resetLabel = (): string | null => {
    const periodEnd = readyUsage()?.periodEnd;
    const date = periodEnd ? formatPeriodEnd(periodEnd) : null;
    return date === null ? null : t("presets.deepl.usage.resets", { date });
  };

  const keyUsageLabel = (): string | null => {
    const count = readyUsage()?.apiKeyCharacterCount;
    return count === null || count === undefined
      ? null
      : t("presets.deepl.usage.keyUsage", { count: formatCount(count) });
  };

  return (
    <Card testID="preset-deepl-usage" class={cardClass()}>
      <View class="flex-row items-center justify-between gap-2">
        <SectionHeading title={t("presets.deepl.usage.title")} />
        <Button
          testID="preset-deepl-usage-refresh"
          variant="ghost"
          size="icon-sm"
          disabled={loading()}
          tooltip={t("presets.deepl.usage.refresh")}
          accessibilityLabel={t("presets.deepl.usage.refresh")}
          onPress={() => void deepLUsageStore.load(props.presetId, { refresh: true })}
        >
          <Icon name="refresh" tone="muted-foreground" class="size-4" />
        </Button>
      </View>

      <If when={loading()}>
        <Text class="text-sm text-muted-foreground">{t("presets.deepl.usage.loading")}</Text>
      </If>

      <If when={errorText() !== null}>
        <Text testID="preset-deepl-usage-error" role="alert" class="text-sm text-destructive">
          {errorText() ?? ""}
        </Text>
      </If>

      <If when={readyUsage() !== null}>
        <View class="gap-2">
          <View class="flex-row flex-wrap items-baseline gap-x-2 gap-y-1">
            <Text
              testID="preset-deepl-usage-count"
              class="text-2xl font-semibold tabular-nums text-card-foreground"
            >
              {formatCount(readyUsage()!.characterCount)}
            </Text>
            <Text class="text-sm text-muted-foreground">{limitLabel(readyUsage()!)}</Text>
          </View>

          <If when={hasLimit(readyUsage()!)}>
            {/* The bar width is the share DeepL reports, computed at run time. */}
            <View
              testID="preset-deepl-usage-bar"
              class="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <View
                class={`h-full rounded-full ${readyUsage()!.characterCount >= readyUsage()!.characterLimit ? "bg-destructive" : "bg-primary"}`}
                style={{ width: `${usedShare(readyUsage()!)}%` }}
              />
            </View>
          </If>

          <View class="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <If when={resetLabel() !== null}>
              <Text testID="preset-deepl-usage-reset" class="text-xs text-muted-foreground">
                {resetLabel() ?? ""}
              </Text>
            </If>
            <If when={keyUsageLabel() !== null}>
              <Text testID="preset-deepl-usage-key" class="text-xs text-muted-foreground">
                {keyUsageLabel() ?? ""}
              </Text>
            </If>
          </View>
        </View>
      </If>
    </Card>
  );
}
