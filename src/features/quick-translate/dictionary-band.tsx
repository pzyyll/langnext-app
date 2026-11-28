import { Text, View } from "nsh";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
import { Button } from "../../components/ui/button";
import { Icon, type IconName } from "../../components/ui/icon";
import { Skeleton } from "../../components/ui/skeleton";
import type { DictionaryEntry } from "../../integrations/dictionary";
import { AnkiAddButton, AnkiStatusText, type CardAnkiState } from "./anki-control";
import { DictionaryEntryView } from "./dictionary-entry";

export type InlineDictionaryViewState =
  | { status: "hidden" }
  | { status: "loading"; term: string }
  | {
      status: "entry";
      term: string;
      entry: DictionaryEntry;
      expanded: boolean;
      anki: CardAnkiState;
    }
  | { status: "error"; term: string; message: string };

export interface DictionarySpeakControlState {
  disabled: boolean;
  tooltip?: string;
  label: string;
  icon: IconName;
  busy: boolean;
}

export interface InlineDictionaryBandProps {
  state: InlineDictionaryViewState;
  speakControl: DictionarySpeakControlState;
  speechError: string | null;
  onSpeak: () => void;
  onToggleExpand: () => void;
  onRetry: () => void;
  onLookupSynonym?: (term: string) => void;
  ankiEnabled?: boolean;
  onAddToAnki?: () => void;
}

/** Compact inline dictionary strip rendered between source input and translation stream for whole-word queries. */
export function InlineDictionaryBand(props: InlineDictionaryBandProps) {
  const entryState = () => (props.state.status === "entry" ? props.state : null);
  const errorState = () => (props.state.status === "error" ? props.state : null);

  const primaryPhonetic = () => {
    const item = entryState()?.entry.phonetics[0];
    if (!item) return "";
    return item.label ? `${item.label} ${item.ipa}` : item.ipa;
  };

  const primaryPreview = () => {
    const first = entryState()?.entry.senses[0];
    if (!first) return "";
    const glosses = first.glosses.join("; ");
    return first.partOfSpeech ? `${first.partOfSpeech} ${glosses}` : glosses;
  };

  return (
    <If when={props.state.status !== "hidden"}>
      <View
        testID="quick-translate-dictionary-inline"
        class="border-t border-border/70 bg-surface-subtle/60 px-4 py-2"
      >
        <If when={props.state.status === "loading"}>
          <View
            testID="quick-translate-dictionary-inline-loading"
            accessibilityLabel={t("dictionary.loading")}
            class="flex-row items-center gap-2.5 py-0.5"
          >
            <Icon
              name="mdi:book-open-variant-outline"
              tone="muted-foreground"
              class="size-3.5 shrink-0"
            />
            <Skeleton class="h-3 w-20" />
            <Skeleton class="h-3 w-36" delay={motion.skeletonStaggerMs} />
          </View>
        </If>

        <If when={errorState() !== null}>
          <View
            testID="quick-translate-dictionary-inline-error"
            class="flex-row items-center justify-between gap-2"
          >
            <View class="min-w-0 flex-1 flex-row items-center gap-2">
              <Icon
                name="mdi:book-open-variant-outline"
                tone="muted-foreground"
                class="size-3.5 shrink-0"
              />
              <Text role="alert" class="min-w-0 flex-1 text-xs text-muted-foreground">
                {errorState()?.message ?? ""}
              </Text>
            </View>
            <Button
              testID="quick-translate-dictionary-inline-retry"
              variant="ghost"
              size="xs"
              label={t("common.retry")}
              onPress={props.onRetry}
            />
          </View>
        </If>

        <If when={entryState() !== null}>
          <View>
            <View class="flex-row items-center gap-1.5">
              <Icon name="mdi:book-open-variant-outline" tone="brand" class="size-3.5 shrink-0" />
              <Text
                testID="quick-translate-dictionary-inline-term"
                class="shrink-0 text-sm font-semibold text-foreground"
              >
                {entryState()?.entry.term ?? ""}
              </Text>
              <If when={Boolean(primaryPhonetic())}>
                <Text class="shrink-0 text-xs text-muted-foreground">{primaryPhonetic()}</Text>
              </If>
              <Button
                testID="quick-translate-dictionary-inline-speak"
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
              <View class="min-w-0 flex-1">
                <If when={!entryState()?.expanded}>
                  <Text class="truncate text-xs text-muted-foreground">{primaryPreview()}</Text>
                </If>
              </View>
              <If when={Boolean(props.ankiEnabled && props.onAddToAnki)}>
                <AnkiAddButton
                  testID="quick-translate-dictionary-inline-add-anki"
                  anki={entryState()!.anki}
                  onPress={() => props.onAddToAnki?.()}
                />
              </If>
              <Button
                testID="quick-translate-dictionary-inline-toggle"
                variant="ghost"
                size="icon-xs"
                accessibilityLabel={
                  entryState()?.expanded ? t("dictionary.collapse") : t("dictionary.expand")
                }
                tooltip={entryState()?.expanded ? t("dictionary.collapse") : t("dictionary.expand")}
                onPress={props.onToggleExpand}
              >
                <Icon
                  name="mdi:chevron-down"
                  tone="muted-foreground"
                  class={`size-3.5 ${motion.disclosureIcon} ${entryState()?.expanded ? "rotate-180" : ""}`}
                />
              </Button>
            </View>

            <If when={entryState()!.anki.status !== "idle"}>
              <AnkiStatusText
                testID="quick-translate-dictionary-inline-anki-status"
                anki={entryState()!.anki}
                class="pt-1"
              />
            </If>

            <If when={props.speechError !== null}>
              <Text
                testID="quick-translate-dictionary-inline-speak-error"
                role="alert"
                class="pt-1 text-xs text-destructive"
              >
                {props.speechError ?? ""}
              </Text>
            </If>

            <If when={entryState()?.expanded === true}>
              <View
                testID="quick-translate-dictionary-inline-details"
                class="mt-2 border-t border-border/50 pt-2"
              >
                <DictionaryEntryView
                  testIdPrefix="quick-translate-dictionary-inline"
                  entry={entryState()!.entry}
                  extraPhoneticsFrom={1}
                  onLookupSynonym={props.onLookupSynonym}
                />
              </View>
            </If>
          </View>
        </If>
      </View>
    </If>
  );
}
