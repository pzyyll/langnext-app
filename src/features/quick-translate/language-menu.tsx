import { View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { Select, type SelectItem } from "../../components/ui/select";
import {
  AUTO_LANGUAGE,
  getLanguageLabel,
  getTargetLanguageLabel,
  LANGUAGE_IDS,
  type SourceLanguageId,
  type TargetLanguageId,
} from "../../framework/languages";
import type { SourceDetectionState } from "./session";

const SOURCE_LANGUAGE_OPTIONS: readonly SourceLanguageId[] = [AUTO_LANGUAGE, ...LANGUAGE_IDS];
const TARGET_LANGUAGE_OPTIONS: readonly TargetLanguageId[] = [AUTO_LANGUAGE, ...LANGUAGE_IDS];

/** The automatic source entry, named after the language one action auto-detected. */
function buildAutoSourceLabel(detection: SourceDetectionState): string {
  if (detection.status !== "detected") return t("quickTranslate.autoDetect");
  return t("quickTranslate.autoDetectDetected", {
    language: getLanguageLabel(detection.language),
  });
}

function buildSourceItems(autoLabel: string): SelectItem[] {
  return SOURCE_LANGUAGE_OPTIONS.map((id) => ({
    value: id,
    title: id === AUTO_LANGUAGE ? autoLabel : getLanguageLabel(id),
  }));
}

function buildTargetItems(): SelectItem[] {
  return TARGET_LANGUAGE_OPTIONS.map((id) => ({
    value: id,
    title: getTargetLanguageLabel(id),
  }));
}

export interface QuickTranslateLanguageBarProps {
  sourceLanguage: SourceLanguageId;
  targetLanguage: TargetLanguageId;
  sourceDetection: SourceDetectionState;
  canSwap: boolean;
  onSelectSourceLanguage: (language: SourceLanguageId) => void;
  onSelectTargetLanguage: (language: TargetLanguageId) => void;
  onSwapLanguages: () => void;
  onSourceOpenChange?: (open: boolean) => void;
  onTargetOpenChange?: (open: boolean) => void;
  align?: "start" | "end";
}

/** Header language capsule with inline source/target Select pickers and a swap action. */
export function QuickTranslateLanguageBar(props: QuickTranslateLanguageBarProps) {
  const sourceItems = () => buildSourceItems(buildAutoSourceLabel(props.sourceDetection));
  const targetItems = () => buildTargetItems();

  // While detection runs the trigger reports progress; the list keeps naming the choice.
  const sourceDisplayLabel = () => {
    if (props.sourceLanguage !== AUTO_LANGUAGE) {
      return getLanguageLabel(props.sourceLanguage);
    }
    if (props.sourceDetection.status === "detecting") {
      return t("quickTranslate.detectingLanguage");
    }
    return buildAutoSourceLabel(props.sourceDetection);
  };

  return (
    <View
      testID="quick-translate-language-bar"
      class="h-7 min-w-0 shrink flex-row items-center gap-0.5 rounded-full border border-border/70 bg-muted/75 px-0.5"
    >
      <Select
        testID="quick-translate-source-language"
        variant="inline"
        labelTooltip
        align={props.align ?? "start"}
        class="min-w-0 shrink"
        items={sourceItems()}
        value={props.sourceLanguage}
        displayLabel={sourceDisplayLabel()}
        labelClass="font-medium text-foreground"
        accessibilityLabel={t("quickTranslate.sourceLanguageLabel")}
        onOpenChange={(open) => props.onSourceOpenChange?.(open)}
        onChange={(value) => {
          if (value) props.onSelectSourceLanguage(value as SourceLanguageId);
        }}
      />
      <Button
        testID="quick-translate-swap-languages"
        variant="ghost"
        size="icon-xs"
        disabled={!props.canSwap}
        tooltip={t("quickTranslate.swapLanguages")}
        accessibilityLabel={t("quickTranslate.swapLanguages")}
        class="shrink-0 rounded-full"
        onPress={() => props.onSwapLanguages()}
      >
        <Icon name="mdi:swap-horizontal" tone="muted-foreground" class="size-3" />
      </Button>
      <Select
        testID="quick-translate-target-language"
        variant="inline"
        labelTooltip
        align={props.align ?? "start"}
        class="min-w-0 shrink"
        items={targetItems()}
        value={props.targetLanguage}
        labelClass="font-medium text-foreground"
        accessibilityLabel={t("quickTranslate.targetLanguageLabel")}
        onOpenChange={(open) => props.onTargetOpenChange?.(open)}
        onChange={(value) => {
          if (value) props.onSelectTargetLanguage(value as TargetLanguageId);
        }}
      />
    </View>
  );
}
