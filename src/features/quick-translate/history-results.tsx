import type { HistoryResult, HistorySnapshot } from "langnext-native";
import { Clipboard, signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { TranslationOutput } from "../../components/ui/translation-output";
import { getLanguageLabel, isLanguageId } from "../presets/languages";

function resultLanguages(result: HistoryResult): string {
  const { sourceLanguage, targetLanguage } = result;
  return isLanguageId(sourceLanguage) && isLanguageId(targetLanguage)
    ? t("quickTranslate.historyResultLanguages", {
        source: getLanguageLabel(sourceLanguage),
        target: getLanguageLabel(targetLanguage),
      })
    : "";
}

function HistoryResultCard(props: { result: HistoryResult; markdownEnabled: boolean }) {
  const copyStatus = signal<"idle" | "copied" | "failed">("idle");
  const copyLabel = () =>
    t(copyStatus() === "copied" ? "quickTranslate.copied" : "quickTranslate.copy");
  const copy = async () => {
    try {
      await Clipboard.writeText(props.result.text);
      copyStatus.set("copied");
    } catch {
      copyStatus.set("failed");
    }
  };

  return (
    <View
      class="gap-2 border-b border-border/70 bg-surface-subtle/85 px-4 py-3 last:border-b-0"
      testID="quick-translate-history-result"
    >
      <View class="flex-row items-center justify-between gap-2">
        <View class="min-w-0 flex-1 gap-0.5">
          <Text class="truncate text-sm font-semibold text-foreground">
            {props.result.presetName}
          </Text>
          <Text class="truncate text-xs text-muted-foreground">
            {resultLanguages(props.result)}
          </Text>
        </View>
        <Button
          testID="quick-translate-history-copy"
          size="icon-xs"
          variant="ghost"
          tooltip={copyLabel()}
          accessibilityLabel={copyLabel()}
          onPress={() => void copy()}
        >
          <Icon
            name={copyStatus() === "copied" ? "mdi:check" : "mdi:content-copy"}
            tone={copyStatus() === "copied" ? "success" : "muted-foreground"}
            class="size-3.5"
          />
        </Button>
      </View>
      <TranslationOutput
        testID="quick-translate-history-result-text"
        text={props.result.text}
        markdownEnabled={props.markdownEnabled}
        streaming={false}
      />
      <If when={copyStatus() === "failed"}>
        <Text role="alert" class="text-xs text-destructive">
          {t("quickTranslate.error.copyFailed")}
        </Text>
      </If>
    </View>
  );
}

/** Displays recorded results without attaching them to editable preset cards. */
export function QuickTranslateHistoryResults(props: {
  snapshot: HistorySnapshot | null;
  markdownEnabled: boolean;
}) {
  return (
    <View class="border-t border-border/70" testID="quick-translate-history-results">
      <Each
        of={props.snapshot?.results ?? []}
        key={(result) => `${props.snapshot?.id}:${result.position}`}
      >
        {(result) => (
          <HistoryResultCard result={result()} markdownEnabled={props.markdownEnabled} />
        )}
      </Each>
    </View>
  );
}
