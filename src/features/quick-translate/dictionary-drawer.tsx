import { effect, Scroll, signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { Skeleton } from "../../components/ui/skeleton";
import type { LanguageId } from "../../framework/languages";
import type { DictionaryEntry } from "../../integrations/dictionary";
import { AnkiAddButton, AnkiStatusText, type CardAnkiState } from "./anki-control";
import { DictionaryEntryView } from "./dictionary-entry";
import type {
  QuickTranslateSelectionMenu,
  QuickTranslateSelectionRegion,
  TextSelectionEventPayload,
} from "./selection-types";
import { SpeakerButton } from "./speaker-button";
import type { QuickSpeechCoordinator } from "./speech";
import { DEFAULT_DICTIONARY_DRAWER_HEIGHT, MIN_DICTIONARY_DRAWER_HEIGHT } from "./split-layout";

const INITIAL_DRAWER_TOP_HEIGHT = 34;
const INITIAL_DRAWER_BODY_HEIGHT = 54;

export interface DictionaryDrawerQuery {
  term: string;
  contextSentence?: string;
  sourceLanguage?: LanguageId | "auto";
  explanationLanguage: string;
  region: QuickTranslateSelectionRegion | "drawer";
}

export type DictionaryDrawerEntryState =
  | { status: "loading"; query: DictionaryDrawerQuery }
  | { status: "entry"; query: DictionaryDrawerQuery; entry: DictionaryEntry; anki: CardAnkiState }
  | { status: "not_found"; query: DictionaryDrawerQuery }
  | { status: "error"; query: DictionaryDrawerQuery; message: string };

export interface DictionaryDrawerState {
  open: boolean;
  canGoBack: boolean;
  active: DictionaryDrawerEntryState | null;
}

export interface DockedDictionaryDrawerProps {
  state: DictionaryDrawerState;
  speech: QuickSpeechCoordinator;
  onBack: () => void;
  onPromote: () => void;
  onClose: () => void;
  onRetry: () => void;
  onDrillDown: (term: string) => void;
  onSelectionChange?: (event: TextSelectionEventPayload, fullText: string) => void;
  selectionMenu?: QuickTranslateSelectionMenu;
  onLayoutHeight?: (height: number) => void;
  ankiEnabled?: boolean;
  onAddToAnki?: () => void;
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
  const topSectionHeight = signal(INITIAL_DRAWER_TOP_HEIGHT);
  const bodyContentHeight = signal(INITIAL_DRAWER_BODY_HEIGHT);

  effect(() => {
    if (!props.state.open || active() === null) return;
    const clamped = Math.max(
      MIN_DICTIONARY_DRAWER_HEIGHT,
      Math.min(
        DEFAULT_DICTIONARY_DRAWER_HEIGHT,
        Math.ceil(topSectionHeight() + bodyContentHeight()),
      ),
    );
    props.onLayoutHeight?.(clamped);
  });

  return (
    <If when={props.state.open && active() !== null}>
      <View testID="quick-translate-dictionary-drawer" class="min-h-0 flex-1 bg-surface-subtle/80">
        <View class="shrink-0" onLayout={({ bounds }) => topSectionHeight.set(bounds.size.height)}>
          <View
            testID="quick-translate-dictionary-drawer-header"
            class="flex-row items-center justify-between gap-2 px-4 pt-2 pb-1"
          >
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
              <Icon
                name="mdi:book-open-variant-outline"
                tone="muted-foreground"
                class="size-3.5 shrink-0"
              />
              <Text
                testID="quick-translate-dictionary-drawer-term"
                class="min-w-0 shrink truncate text-sm font-semibold text-foreground"
              >
                {displayTerm()}
              </Text>
              <If when={entryState() !== null}>
                <SpeakerButton
                  testID="quick-translate-dictionary-drawer-speak"
                  control={props.speech.control("drawer-dictionary")}
                  onPress={() => props.speech.toggle("drawer-dictionary")}
                />
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
              <If when={Boolean(props.ankiEnabled && props.onAddToAnki && entryState() !== null)}>
                <AnkiAddButton
                  testID="quick-translate-dictionary-drawer-add-anki"
                  anki={entryState()!.anki}
                  onPress={() => props.onAddToAnki?.()}
                />
              </If>
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

          <If when={entryState() !== null && entryState()!.anki.status === "error"}>
            <AnkiStatusText
              testID="quick-translate-dictionary-drawer-anki-status"
              anki={entryState()!.anki}
              class="px-4 pt-1.5"
            />
          </If>

          <If when={props.speech.drawerDictionaryError() !== null}>
            <Text
              testID="quick-translate-dictionary-drawer-speak-error"
              role="alert"
              class="px-4 pt-1.5 text-xs text-destructive"
            >
              {props.speech.drawerDictionaryError() ?? ""}
            </Text>
          </If>
        </View>

        <Scroll class="min-h-0 flex-1">
          <View
            class="px-4 pt-1 pb-2.5"
            onLayout={({ bounds }) => bodyContentHeight.set(bounds.size.height)}
          >
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
