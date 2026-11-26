import { effect, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { alignmentModel } from "./alignment-model";

export function AlignmentModelDownload() {
  effect(() => void alignmentModel.load());

  return (
    <If when={alignmentModel.status() !== "checking" && alignmentModel.status() !== "ready"}>
      <View class="flex-row items-center justify-between gap-2 border-t border-border/70 bg-background px-4 py-1.5">
        <If
          when={alignmentModel.status() === "downloading"}
          else={
            <Button
              testID="quick-translate-download-alignment"
              size="xs"
              variant="ghost"
              label={t("quickTranslate.downloadAlignmentModel")}
              onPress={() => void alignmentModel.install()}
            />
          }
        >
          <Text class="min-w-0 flex-1 text-xs text-muted-foreground">
            {t("quickTranslate.downloadingAlignmentModel", { progress: alignmentModel.progress() })}
          </Text>
          <Button
            size="xs"
            variant="ghost"
            label={t("common.cancel")}
            onPress={alignmentModel.cancel}
          />
        </If>
        <If when={alignmentModel.status() === "error"}>
          <Text role="alert" class="min-w-0 flex-1 text-xs text-destructive">
            {t("quickTranslate.alignmentModelDownloadFailed")}
          </Text>
        </If>
      </View>
    </If>
  );
}
