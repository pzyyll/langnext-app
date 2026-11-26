import { locale, Text, View, windowSize } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import {
  googleCloudUsageStore,
  nextUsageReset,
  usageMonthKey,
  type GoogleCloudUsage,
} from "./google-cloud-usage";

interface GoogleCloudUsageSectionProps {
  presetId: string;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(locale()).format(value);
}

/** Month and day of the next reset, e.g. "Dec 1" or "12月1日". */
function formatResetDate(date: Date): string {
  return new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric" }).format(date);
}

/** Editor section that shows the preset's locally counted character usage for this month. */
export function GoogleCloudUsageSection(props: GoogleCloudUsageSectionProps) {
  const compact = () => windowSize().width < 860;
  const cardClass = () => (compact() ? "gap-4 p-4" : "gap-5 p-6");

  if (googleCloudUsageStore.state(props.presetId) === null) {
    void googleCloudUsageStore.load(props.presetId);
  }

  const state = () => googleCloudUsageStore.state(props.presetId);
  const loading = () => state()?.kind === "loading";
  const readyUsage = (): GoogleCloudUsage | null => {
    const current = state();
    return current?.kind === "ready" ? current.usage : null;
  };
  const errorText = () => {
    const current = state();
    return current?.kind === "error" ? current.message : null;
  };

  // A count read before the month changed stays in memory; show the new month at zero.
  const characters = () => {
    const usage = readyUsage();
    return usage && usage.month === usageMonthKey() ? usage.characters : 0;
  };

  const resetLabel = () =>
    t("presets.googleCloud.usage.resets", { date: formatResetDate(nextUsageReset()) });

  return (
    <Card testID="preset-google-cloud-usage" class={cardClass()}>
      <View class="flex-row items-center justify-between gap-2">
        <SectionHeading title={t("presets.googleCloud.usage.title")} />
        <Button
          testID="preset-google-cloud-usage-refresh"
          variant="ghost"
          size="icon-sm"
          disabled={loading()}
          tooltip={t("presets.googleCloud.usage.refresh")}
          accessibilityLabel={t("presets.googleCloud.usage.refresh")}
          onPress={() => void googleCloudUsageStore.load(props.presetId, { refresh: true })}
        >
          <Icon name="refresh" tone="muted-foreground" class="size-4" />
        </Button>
      </View>

      <If when={loading()}>
        <Text class="text-sm text-muted-foreground">{t("presets.googleCloud.usage.loading")}</Text>
      </If>

      <If when={errorText() !== null}>
        <Text
          testID="preset-google-cloud-usage-error"
          role="alert"
          class="text-sm text-destructive"
        >
          {errorText() ?? ""}
        </Text>
      </If>

      <If when={readyUsage() !== null}>
        <View class="gap-2">
          <View class="flex-row flex-wrap items-baseline gap-x-2 gap-y-1">
            <Text
              testID="preset-google-cloud-usage-count"
              class="text-2xl font-semibold tabular-nums text-card-foreground"
            >
              {formatCount(characters())}
            </Text>
            <Text class="text-sm text-muted-foreground">
              {t("presets.googleCloud.usage.characters")}
            </Text>
          </View>

          <View class="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <Text testID="preset-google-cloud-usage-scope" class="text-xs text-muted-foreground">
              {t("presets.googleCloud.usage.scope")}
            </Text>
            <Text testID="preset-google-cloud-usage-reset" class="text-xs text-muted-foreground">
              {resetLabel()}
            </Text>
          </View>
        </View>
      </If>
    </Card>
  );
}
