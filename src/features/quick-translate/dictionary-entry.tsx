import { Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import type { DictionaryEntry } from "../../integrations/dictionary";
import type { QuickTranslateSelectionMenu, TextSelectionEventPayload } from "./selection-types";

export interface DictionaryEntryViewProps {
  testIdPrefix: string;
  entry: DictionaryEntry;
  contextSentence?: string;
  onLookupSynonym?: (term: string) => void;
  onSelectionChange?: (event: TextSelectionEventPayload, fullText: string) => void;
  selectionMenu?: QuickTranslateSelectionMenu;
}

function formatPhoneticLabel(label: string): string {
  const normalized = label.trim().toUpperCase();
  if (normalized === "US") return t("dictionary.phonetic.us");
  if (normalized === "UK") return t("dictionary.phonetic.uk");
  return label;
}

/** Structured lexical dictionary entry body rendered inside the docked dictionary drawer. */
export function DictionaryEntryView(props: DictionaryEntryViewProps) {
  const phoneticsToShow = () => props.entry.phonetics;

  const forms = () => props.entry.forms ?? [];
  const synonyms = () => props.entry.synonyms ?? [];
  const contextText = () => props.contextSentence?.trim() || undefined;
  const hasContextBlock = () =>
    Boolean(props.entry.contextSenseSummary || props.entry.contextNote || contextText());

  return (
    <View testID={`${props.testIdPrefix}-entry`} class="gap-2.5">
      <If when={phoneticsToShow().length > 0}>
        <View
          testID={`${props.testIdPrefix}-phonetics`}
          class="flex-row flex-wrap items-center gap-x-3 gap-y-1"
        >
          {phoneticsToShow().map((phonetic) => (
            <View class="flex-row items-center gap-1">
              <If when={Boolean(phonetic.label)}>
                <Text class="text-xs font-medium text-muted-foreground">
                  {formatPhoneticLabel(phonetic.label)}
                </Text>
              </If>
              <Text class="text-xs text-foreground">{phonetic.ipa}</Text>
            </View>
          ))}
        </View>
      </If>

      <If when={hasContextBlock()}>
        <View
          testID={`${props.testIdPrefix}-context`}
          class="gap-0.5 rounded-r-md border-l-2 border-brand bg-brand-soft/40 px-2.5 py-1.5"
        >
          <If when={Boolean(props.entry.contextSenseSummary)}>
            <Text class="text-xs font-medium text-foreground">
              {props.entry.contextSenseSummary ?? ""}
            </Text>
          </If>
          <If when={Boolean(props.entry.contextNote)}>
            <Text class="text-xs text-muted-foreground">{props.entry.contextNote ?? ""}</Text>
          </If>
          <If when={Boolean(contextText())}>
            <Text class="text-xs italic text-muted-foreground">{contextText() ?? ""}</Text>
          </If>
        </View>
      </If>

      <View class="gap-2">
        {props.entry.senses.map((sense) => (
          <View class="gap-1">
            <View class="flex-row items-start gap-2">
              <If when={Boolean(sense.partOfSpeech)}>
                <View class="mt-0.5 shrink-0 rounded bg-surface-control px-1.5 py-0.5">
                  <Text class="text-xs font-medium text-muted-foreground">
                    {sense.partOfSpeech}
                  </Text>
                </View>
              </If>
              <View
                selectable
                class="min-w-0 flex-1"
                onSelectionChange={(event) =>
                  props.onSelectionChange?.(event, sense.glosses.join("; "))
                }
                selectionMenu={props.selectionMenu}
              >
                <Text class="text-sm leading-snug text-foreground">{sense.glosses.join("; ")}</Text>
              </View>
            </View>

            <If when={Boolean(sense.example)}>
              <View class="gap-0.5 pl-2">
                <View
                  selectable
                  onSelectionChange={(event) =>
                    props.onSelectionChange?.(event, sense.example ?? "")
                  }
                  selectionMenu={props.selectionMenu}
                >
                  <Text class="text-xs text-muted-foreground">{sense.example ?? ""}</Text>
                </View>
                <If when={Boolean(sense.exampleTranslation)}>
                  <View
                    selectable
                    onSelectionChange={(event) =>
                      props.onSelectionChange?.(event, sense.exampleTranslation ?? "")
                    }
                    selectionMenu={props.selectionMenu}
                  >
                    <Text class="text-xs text-muted-foreground/80">
                      {sense.exampleTranslation ?? ""}
                    </Text>
                  </View>
                </If>
              </View>
            </If>
          </View>
        ))}
      </View>

      <If when={forms().length > 0}>
        <View class="flex-row flex-wrap items-center gap-x-2.5 gap-y-1">
          <Text class="text-xs font-medium text-muted-foreground">{t("dictionary.forms")}</Text>
          {forms().map((form) => (
            <Text class="text-xs text-foreground">{`${form.label}: ${form.value}`}</Text>
          ))}
        </View>
      </If>

      <If when={synonyms().length > 0}>
        <View class="flex-row flex-wrap items-center gap-1.5">
          <Text class="text-xs font-medium text-muted-foreground">{t("dictionary.synonyms")}</Text>
          {synonyms().map((synonym) =>
            props.onLookupSynonym ? (
              <Button
                testID={`${props.testIdPrefix}-synonym-${synonym}`}
                variant="secondary"
                size="xs"
                label={synonym}
                onPress={() => props.onLookupSynonym?.(synonym)}
              />
            ) : (
              <View class="rounded-md bg-surface-control px-2 py-0.5">
                <Text class="text-xs text-foreground">{synonym}</Text>
              </View>
            ),
          )}
        </View>
      </If>
    </View>
  );
}
