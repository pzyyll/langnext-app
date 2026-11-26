import { setAccessibilityFocus, signal, Text, View, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Icon } from "../../components/ui/icon";
import { Progress } from "../../components/ui/progress";
import { Switch } from "../../components/ui/switch";
import { buildTooltip } from "../../components/ui/tooltip";
import { alignmentModel } from "../quick-translate/alignment-model";
import {
  cancelAlignmentModelDownload,
  confirmDownloadAndEnableSentenceAlignment,
  downloadAlignmentModel,
  selectSentenceAlignment,
  sentenceAlignmentEnabled,
  sentenceAlignmentPendingEnable,
  sentenceAlignmentPrepareFailed,
  sentenceAlignmentSaveFailed,
  sentenceAlignmentSaving,
} from "./quick-translate";

function focusTarget(node: ViewRef | null | undefined) {
  if (!node) return;
  node.focus();
  setAccessibilityFocus(node);
}

export function QuickTranslateSection(props: { compact: boolean; platformOs: string }) {
  const label = () => t("settings.quickTranslate.sentenceAlignment");
  const hint = () => t("settings.quickTranslate.alignmentHelp");
  const modelStatus = () => alignmentModel.status();
  const downloadDialogOpen = signal(false);
  let switchNode: ViewRef | null = null;
  let dialogCancelNode: ViewRef | null = null;
  let downloadCancelNode: ViewRef | null = null;
  let downloadRetryNode: ViewRef | null = null;
  let confirmedDownload = false;

  if (props.platformOs === "windows" && modelStatus() === "checking") {
    void alignmentModel.checkInstalled();
  }

  const handleSwitchChange = async (checked: boolean) => {
    if (!checked) {
      await selectSentenceAlignment(false);
      return;
    }
    const result = await selectSentenceAlignment(true);
    if (result === "needs-download") {
      downloadDialogOpen.set(true);
    }
  };

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
      <>
        <Card class={props.compact ? "gap-2 p-2" : "gap-2 p-3"}>
          <View class="flex-row items-center justify-between gap-4 px-3 py-2">
            <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
              <Text class="text-sm font-medium text-card-foreground">{label()}</Text>
              <View
                testID="settings-sentence-alignment-info"
                focusable
                accessibilityLabel={hint()}
                tooltip={buildTooltip(hint(), "top", {
                  align: "start",
                  disabled: downloadDialogOpen(),
                })}
                class="shrink-0 rounded-md p-1 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon name="info" tone="muted-foreground" class="size-4" />
              </View>
            </View>
            <Switch
              ref={(node) => {
                switchNode = node;
              }}
              testID="settings-sentence-alignment-switch"
              variant="inline"
              accessibilityLabel={label()}
              checked={sentenceAlignmentEnabled()}
              disabled={
                sentenceAlignmentSaving() ||
                sentenceAlignmentPendingEnable() ||
                (!sentenceAlignmentEnabled() && modelStatus() === "downloading")
              }
              onChange={(checked) => void handleSwitchChange(checked)}
            />
          </View>
          <If when={sentenceAlignmentPrepareFailed()}>
            <Text
              testID="settings-alignment-prepare-error"
              role="alert"
              class="px-3 pb-1 text-sm text-destructive"
            >
              {t("settings.quickTranslate.alignmentPrepareFailed")}
            </Text>
          </If>
          <If when={sentenceAlignmentSaveFailed()}>
            <Text role="alert" class="px-3 pb-1 text-sm text-destructive">
              {t("settings.quickTranslate.alignmentSaveError")}
            </Text>
          </If>
          <View class="mx-3 h-px bg-border" />
          <View
            testID="settings-alignment-model"
            class="flex-row items-center justify-between gap-4 px-3 py-2"
          >
            <View class="min-w-0 flex-1 gap-0.5">
              <Text class="text-sm font-medium text-card-foreground">
                {t("settings.quickTranslate.semanticModel")}
              </Text>
              <Text class="text-xs text-muted-foreground">
                {t("settings.quickTranslate.alignmentModelName")}
              </Text>
            </View>
            <If when={modelStatus() === "ready"}>
              <Badge
                testID="settings-alignment-model-downloaded"
                tone="success"
                label={t("settings.quickTranslate.alignmentModelDownloaded")}
              />
            </If>
            <If when={modelStatus() === "missing"}>
              <Button
                testID="settings-alignment-download"
                variant="outline"
                size="sm"
                label={t("settings.quickTranslate.downloadAlignmentModel")}
                onPress={() => void downloadAlignmentModel()}
              />
            </If>
          </View>
          <If when={sentenceAlignmentPendingEnable()}>
            <Text
              testID="settings-alignment-pending-enable"
              class="px-3 text-xs text-muted-foreground"
            >
              {t("settings.quickTranslate.alignmentPendingEnable")}
            </Text>
          </If>
          <If when={modelStatus() === "downloading"}>
            <View class="flex-row items-center gap-3 px-3 pb-2">
              <View class="min-w-0 flex-1">
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
              <Button
                ref={(node) => {
                  downloadCancelNode = node;
                }}
                testID="settings-alignment-download-cancel"
                variant="outline"
                size="sm"
                label={t("common.cancel")}
                onPress={cancelAlignmentModelDownload}
              />
            </View>
          </If>
          <If when={modelStatus() === "error"}>
            <View class="flex-row items-center justify-between gap-3 px-3 pb-2">
              <Text
                testID="settings-alignment-download-error"
                role="alert"
                class="min-w-0 flex-1 text-sm text-destructive"
              >
                {t("settings.quickTranslate.alignmentModelDownloadFailed")}
              </Text>
              <Button
                ref={(node) => {
                  downloadRetryNode = node;
                }}
                testID="settings-alignment-download-retry"
                variant="outline"
                size="sm"
                label={t("common.retry")}
                onPress={() => void downloadAlignmentModel()}
              />
            </View>
          </If>
        </Card>
        <ConfirmDialog
          testID="settings-alignment-download-dialog"
          open={downloadDialogOpen()}
          title={t("settings.quickTranslate.alignmentDownloadTitle")}
          description={t("settings.quickTranslate.alignmentDownloadDescription")}
          confirmLabel={t("settings.quickTranslate.downloadAndEnable")}
          cancelLabel={t("common.cancel")}
          confirmVariant="primary"
          cancelTestID="settings-alignment-download-cancel-dialog"
          confirmTestID="settings-alignment-download-confirm"
          cancelRef={(node) => {
            dialogCancelNode = node;
          }}
          onOpen={() => {
            focusTarget(dialogCancelNode);
          }}
          onClose={() => {
            const confirmed = confirmedDownload;
            confirmedDownload = false;
            if (!confirmed) {
              focusTarget(switchNode);
              return;
            }
            if (modelStatus() === "downloading") {
              focusTarget(downloadCancelNode ?? switchNode);
            } else if (modelStatus() === "error") {
              focusTarget(downloadRetryNode ?? switchNode);
            } else {
              focusTarget(switchNode);
            }
          }}
          onConfirm={() => {
            confirmedDownload = true;
            downloadDialogOpen.set(false);
            void confirmDownloadAndEnableSentenceAlignment();
          }}
          onOpenChange={(open) => {
            downloadDialogOpen.set(open);
          }}
        />
      </>
    </If>
  );
}
