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

const FORM_LABEL_KEYS: Readonly<Record<string, string>> = {
  plural: "dictionary.form.plural",
  singular: "dictionary.form.singular",
  past: "dictionary.form.past",
  "past tense": "dictionary.form.past",
  "past simple": "dictionary.form.past",
  "past participle": "dictionary.form.pastParticiple",
  "present participle": "dictionary.form.presentParticiple",
  gerund: "dictionary.form.presentParticiple",
  "third person singular": "dictionary.form.thirdPerson",
  "third person": "dictionary.form.thirdPerson",
  "3rd person singular": "dictionary.form.thirdPerson",
  "3rd person": "dictionary.form.thirdPerson",
  "present tense third person singular": "dictionary.form.thirdPerson",
  comparative: "dictionary.form.comparative",
  superlative: "dictionary.form.superlative",
  noun: "dictionary.form.noun",
  verb: "dictionary.form.verb",
  adjective: "dictionary.form.adjective",
  adj: "dictionary.form.adjective",
  adverb: "dictionary.form.adverb",
  adv: "dictionary.form.adverb",
};

function formatPhoneticLabel(label: string): string {
  const normalized = label.trim().toUpperCase();
  if (normalized === "US") return t("dictionary.phonetic.us");
  if (normalized === "UK") return t("dictionary.phonetic.uk");
  return label;
}

function formatFormLabel(label: string): string {
  const normalized = label
    .trim()
    .replace(/[:：]$/, "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  const key = FORM_LABEL_KEYS[normalized];
  return key ? t(key) : label.trim();
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
        <View testID={`${props.testIdPrefix}-forms`} class="gap-1">
          <Text class="text-xs font-medium text-muted-foreground">{t("dictionary.forms")}</Text>
          <View class="gap-1">
            {forms().map((form) => (
              <View class="flex-row items-baseline gap-3">
                <Text class="min-w-20 shrink-0 text-xs text-muted-foreground">
                  {formatFormLabel(form.label)}
                </Text>
                <View
                  selectable
                  class="min-w-0 flex-1"
                  onSelectionChange={(event) => props.onSelectionChange?.(event, form.value)}
                  selectionMenu={props.selectionMenu}
                >
                  <Text class="text-xs text-foreground">{form.value}</Text>
                </View>
              </View>
            ))}
          </View>
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
