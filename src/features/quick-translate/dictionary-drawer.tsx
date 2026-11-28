import type { JSX } from "nsh";
import { Scroll, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { Skeleton } from "../../components/ui/skeleton";
import type { LanguageId } from "../../framework/languages";
import type { DictionaryEntry } from "../../integrations/dictionary";
import type { DictionarySpeakControlState } from "./dictionary-band";
import { DictionaryEntryView } from "./dictionary-entry";
import type {
  QuickTranslateSelectionMenu,
  QuickTranslateSelectionRegion,
  TextSelectionEventPayload,
} from "./selection-types";

export interface DictionaryDrawerQuery {
  term: string;
  contextSentence?: string;
  sourceLanguage?: LanguageId | "auto";
  explanationLanguage: string;
  region: QuickTranslateSelectionRegion | "drawer";
}

export type DictionaryDrawerEntryState =
  | { status: "loading"; query: DictionaryDrawerQuery }
  | { status: "entry"; query: DictionaryDrawerQuery; entry: DictionaryEntry }
  | { status: "not_found"; query: DictionaryDrawerQuery }
  | { status: "error"; query: DictionaryDrawerQuery; message: string };

export interface DictionaryDrawerState {
  open: boolean;
  canGoBack: boolean;
  active: DictionaryDrawerEntryState | null;
}

export interface DockedDictionaryDrawerProps {
  state: DictionaryDrawerState;
  speakControl: DictionarySpeakControlState;
  speechError: string | null;
  onSpeak: () => void;
  onBack: () => void;
  onPromote: () => void;
  onClose: () => void;
  onRetry: () => void;
  onDrillDown: (term: string) => void;
  onSelectionChange?: (event: TextSelectionEventPayload, fullText: string) => void;
  selectionMenu?: QuickTranslateSelectionMenu;
  onLayoutHeight?: (height: number) => void;
  ankiAction?: JSX.Element;
}

/** Non-modal docked lexical dictionary drawer mounted between the translation scroll view and footer. */
export function DockedDictionaryDrawer(props: DockedDictionaryDrawerProps) {
  const active = () => props.state.active;
  const entryState = () => {
    const current = active();
    return current?.status === "entry" ? current : null;
  };
  const errorState = () => {
    const current = active();
    return current?.status === "error" ? current : null;
  };
  const notFoundState = () => {
    const current = active();
    return current?.status === "not_found" ? current : null;
  };
  const displayTerm = () => entryState()?.entry.term ?? active()?.query.term ?? "";
  const primaryPhonetic = () => {
    const item = entryState()?.entry.phonetics[0];
    if (!item) return "";
    return item.label ? `${item.label} ${item.ipa}` : item.ipa;
  };

  return (
    <If when={props.state.open && active() !== null}>
      <View
        testID="quick-translate-dictionary-drawer"
        class="shrink-0 border-t border-border bg-surface-subtle/80"
        onLayout={({ bounds }) => props.onLayoutHeight?.(bounds.size.height)}
      >
        <View class="flex-row items-center justify-between gap-2 border-b border-border/50 px-4 py-2">
          <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
            <If when={props.state.canGoBack}>
              <Button
                testID="quick-translate-dictionary-drawer-back"
                variant="ghost"
                size="icon-xs"
                accessibilityLabel={t("dictionary.back")}
                tooltip={t("dictionary.back")}
                onPress={props.onBack}
              >
                <Icon name="mdi:arrow-left" tone="muted-foreground" class="size-3.5" />
              </Button>
            </If>
            <Icon name="mdi:book-open-variant-outline" tone="brand" class="size-3.5 shrink-0" />
            <Text
              testID="quick-translate-dictionary-drawer-term"
              class="min-w-0 shrink truncate text-sm font-semibold text-foreground"
            >
              {displayTerm()}
            </Text>
            <If when={Boolean(primaryPhonetic())}>
              <Text class="shrink-0 text-xs text-muted-foreground">{primaryPhonetic()}</Text>
            </If>
            <If when={entryState() !== null}>
              <Button
                testID="quick-translate-dictionary-drawer-speak"
                variant="ghost"
                size="icon-xs"
                accessibilityLabel={props.speakControl.label}
                tooltip={props.speakControl.tooltip}
                disabled={props.speakControl.disabled}
                onPress={props.onSpeak}
              >
                <Icon
                  name={props.speakControl.icon}
                  tone={props.speakControl.busy ? "brand" : "muted-foreground"}
                  class="size-3.5"
                />
              </Button>
            </If>
          </View>

          <View class="shrink-0 flex-row items-center gap-0.5">
            <Button
              testID="quick-translate-dictionary-drawer-promote"
              variant="ghost"
              size="icon-xs"
              accessibilityLabel={t("dictionary.promoteToSource")}
              tooltip={t("dictionary.promoteToSource")}
              onPress={props.onPromote}
            >
              <Icon name="mdi:arrow-top-left" tone="muted-foreground" class="size-3.5" />
            </Button>
            {props.ankiAction}
            <Button
              testID="quick-translate-dictionary-drawer-close"
              variant="ghost"
              size="icon-xs"
              accessibilityLabel={t("dictionary.close")}
              tooltip={t("dictionary.close")}
              onPress={props.onClose}
            >
              <Icon name="mdi:close" tone="muted-foreground" class="size-3.5" />
            </Button>
          </View>
        </View>

        <If when={props.speechError !== null}>
          <Text
            testID="quick-translate-dictionary-drawer-speak-error"
            role="alert"
            class="px-4 pt-1.5 text-xs text-destructive"
          >
            {props.speechError ?? ""}
          </Text>
        </If>

        <Scroll class="min-h-0 max-h-44">
          <View class="px-4 py-2.5">
            <If when={active()?.status === "loading"}>
              <View
                testID="quick-translate-dictionary-drawer-loading"
                accessibilityLabel={t("dictionary.loading")}
                class="gap-2 py-1"
              >
                <Skeleton class="h-3.5 w-28" />
                <Skeleton class="h-3.5 w-52" delay={motion.skeletonStaggerMs} />
              </View>
            </If>

            <If when={errorState() !== null}>
              <View
                testID="quick-translate-dictionary-drawer-error"
                class="flex-row items-center justify-between gap-2 py-1"
              >
                <Text role="alert" class="min-w-0 flex-1 text-xs text-muted-foreground">
                  {errorState()?.message ?? ""}
                </Text>
                <Button
                  testID="quick-translate-dictionary-drawer-retry"
                  variant="ghost"
                  size="xs"
                  label={t("common.retry")}
                  onPress={props.onRetry}
                />
              </View>
            </If>

            <If when={notFoundState() !== null}>
              <Text
                testID="quick-translate-dictionary-drawer-not-found"
                class="py-1 text-xs text-muted-foreground"
              >
                {t("dictionary.notFound", { term: notFoundState()?.query.term ?? "" })}
              </Text>
            </If>

            <If when={entryState() !== null}>
              <DictionaryEntryView
                testIdPrefix="quick-translate-dictionary-drawer"
                entry={entryState()!.entry}
                contextSentence={entryState()!.query.contextSentence}
                extraPhoneticsFrom={1}
                onLookupSynonym={props.onDrillDown}
                onSelectionChange={props.onSelectionChange}
                selectionMenu={props.selectionMenu}
              />
            </If>
          </View>
        </Scroll>
      </View>
    </If>
  );
}
