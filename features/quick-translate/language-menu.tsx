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
} from "../presets/languages";
import type { SourceDetectionState } from "./session";

const SOURCE_LANGUAGE_OPTIONS: readonly SourceLanguageId[] = [AUTO_LANGUAGE, ...LANGUAGE_IDS];
const TARGET_LANGUAGE_OPTIONS: readonly TargetLanguageId[] = [AUTO_LANGUAGE, ...LANGUAGE_IDS];

function buildSourceItems(): SelectItem[] {
  return SOURCE_LANGUAGE_OPTIONS.map((id) => ({
    value: id,
    title: id === AUTO_LANGUAGE ? t("quickTranslate.autoDetect") : getLanguageLabel(id),
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
  const sourceItems = () => buildSourceItems();
  const targetItems = () => buildTargetItems();

  const sourceDisplayLabel = () => {
    if (props.sourceLanguage !== AUTO_LANGUAGE) {
      return getLanguageLabel(props.sourceLanguage);
    }
    if (props.sourceDetection.status === "detecting") {
      return t("quickTranslate.detectingLanguage");
    }
    if (props.sourceDetection.status === "detected") {
      return t("quickTranslate.autoDetectDetected", {
        language: getLanguageLabel(props.sourceDetection.language),
      });
    }
    return t("quickTranslate.autoDetect");
  };

  return (
    <View
      testID="quick-translate-language-bar"
      class="h-7 min-w-0 shrink flex-row items-center gap-0.5 rounded-full bg-muted px-1"
    >
      <Select
        testID="quick-translate-source-language"
        variant="inline"
        align={props.align ?? "start"}
        class="min-w-0 shrink"
        items={sourceItems()}
        value={props.sourceLanguage}
        displayLabel={sourceDisplayLabel()}
        labelClass="font-medium text-muted-foreground"
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
        <Icon name="switch" tone="muted-foreground" class="size-3" />
      </Button>
      <Select
        testID="quick-translate-target-language"
        variant="inline"
        align={props.align ?? "start"}
        class="min-w-0 shrink"
        items={targetItems()}
        value={props.targetLanguage}
        labelClass="font-semibold text-foreground"
        accessibilityLabel={t("quickTranslate.targetLanguageLabel")}
        onOpenChange={(open) => props.onTargetOpenChange?.(open)}
        onChange={(value) => {
          if (value) props.onSelectTargetLanguage(value as TargetLanguageId);
        }}
      />
    </View>
  );
}
