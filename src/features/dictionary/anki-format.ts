import type { DictionaryEntry } from "../../integrations/dictionary/types";

export interface FormattedAnkiNote {
  sourceText: string;
  translatedText: string;
}

/** Formats a dictionary entry and optional context sentence into clean plain text for two-field Anki notes. */
export function formatDictionaryAnkiNote(
  entry: DictionaryEntry,
  contextSentence?: string,
): FormattedAnkiNote {
  const sourceText = entry.term.trim();
  const lines: string[] = [];

  if (entry.phonetics.length > 0) {
    lines.push(
      entry.phonetics
        .map((phonetic) => (phonetic.label ? `${phonetic.label} ${phonetic.ipa}` : phonetic.ipa))
        .join(" · "),
    );
  }

  for (const sense of entry.senses) {
    const glossText = sense.glosses.join("; ");
    lines.push(sense.partOfSpeech ? `${sense.partOfSpeech} ${glossText}` : glossText);
  }

  const trimmedContext = contextSentence?.trim();
  if (trimmedContext && trimmedContext.toLowerCase() !== sourceText.toLowerCase()) {
    lines.push(trimmedContext);
  } else {
    const exampleSense = entry.senses.find((sense) => Boolean(sense.example?.trim()));
    if (exampleSense?.example) {
      lines.push(exampleSense.example.trim());
      if (exampleSense.exampleTranslation?.trim()) {
        lines.push(exampleSense.exampleTranslation.trim());
      }
    }
  }

  return {
    sourceText,
    translatedText: lines.join("\n"),
  };
}
