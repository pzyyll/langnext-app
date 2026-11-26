import { Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Progress } from "../../components/ui/progress";
import { Switch } from "../../components/ui/switch";
import { buildTooltip } from "../../components/ui/tooltip";
import { alignmentModel } from "../quick-translate/alignment-model";
import {
  selectSentenceAlignment,
  sentenceAlignmentEnabled,
  sentenceAlignmentSaveFailed,
  sentenceAlignmentSaving,
} from "./quick-translate";

export function QuickTranslateSection(props: { compact: boolean; platformOs: string }) {
  const label = () => t("settings.quickTranslate.sentenceAlignment");
  const hint = () => t("settings.quickTranslate.alignmentHelp");

  return (
    <If
      when={props.platformOs === "windows"}
      else={
        <Card class={props.compact ? "p-4" : "p-6"}>
          <Text class="text-sm text-muted-foreground">
            {t("settings.quickTranslate.windowsOnly")}
          </Text>
        </Card>
      }
    >
      <Card class={props.compact ? "gap-2 p-2" : "gap-2 p-3"}>
        <View class="flex-row items-center justify-between gap-4 px-3 py-2">
          <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
            <Text class="text-sm font-medium text-card-foreground">{label()}</Text>
            <View
              testID="settings-sentence-alignment-info"
              focusable
              accessibilityLabel={hint()}
              tooltip={buildTooltip(hint(), "top", { align: "start" })}
              class="shrink-0 rounded-md p-1 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon name="info" tone="muted-foreground" class="size-4" />
            </View>
          </View>
          <Switch
            testID="settings-sentence-alignment-switch"
            variant="inline"
            accessibilityLabel={label()}
            checked={sentenceAlignmentEnabled()}
            disabled={sentenceAlignmentSaving()}
            onChange={(checked) => void selectSentenceAlignment(checked)}
          />
        </View>
        <If when={sentenceAlignmentSaveFailed()}>
          <Text role="alert" class="px-3 pb-1 text-sm text-destructive">
            {t("settings.quickTranslate.alignmentSaveError")}
          </Text>
        </If>
        <If when={sentenceAlignmentEnabled()}>
          <If when={alignmentModel.status() === "downloading"}>
            <View class="px-3 pb-1">
              <Progress
                testID="settings-alignment-download-progress-bar"
                value={alignmentModel.progress()}
              >
                <Text
                  testID="settings-alignment-download-progress"
                  class="text-sm text-muted-foreground"
                >
                  {t("settings.quickTranslate.downloadingAlignmentModel", {
                    progress: alignmentModel.progress(),
                  })}
                </Text>
              </Progress>
            </View>
          </If>
          <If when={alignmentModel.status() === "error"}>
            <View class="flex-row items-center justify-between gap-3 px-3 pb-1">
              <Text
                testID="settings-alignment-download-error"
                role="alert"
                class="min-w-0 flex-1 text-sm text-destructive"
              >
                {t("settings.quickTranslate.alignmentModelDownloadFailed")}
              </Text>
              <Button
                variant="outline"
                size="sm"
                label={t("common.retry")}
                onPress={alignmentModel.ensureInstalled}
              />
            </View>
          </If>
        </If>
      </Card>
    </If>
  );
}
