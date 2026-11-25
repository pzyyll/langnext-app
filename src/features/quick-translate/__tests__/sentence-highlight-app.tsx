import { Text, View, mount, signal } from "nsh";
import { FONT_SIZE_STEPS } from "../../../components/ui/font-step";
import { Button } from "../../../components/ui/button";
import { AlignedTranslation, type SentenceSegment } from "../aligned-translation";
import {
  QuickTranslateSourceEditor,
  type QuickTranslateSourceHandle,
  type SourceHighlightRange,
} from "../source-editor";

interface FixturePair {
  segment: SentenceSegment;
  sourceRange: SourceHighlightRange;
}

interface Fixture {
  id: string;
  source: string;
  result: string;
  pairs: readonly FixturePair[];
}

const DEFAULT_FIXTURE: Fixture = {
  id: "basic",
  source: "First sentence.\n\nHello 😀 world! Last one.",
  result: "Première phrase. Bonjour 😀 monde ! Dernière.",
  pairs: [
    {
      segment: { id: "s0", testID: "result-seg-0", start: 0, end: 16 },
      sourceRange: { start: 0, end: 15 },
    },
    {
      segment: { id: "s1", testID: "result-seg-1", start: 17, end: 35 },
      sourceRange: { start: 17, end: 32 },
    },
    {
      segment: { id: "s2", testID: "result-seg-2", start: 36, end: 45 },
      sourceRange: { start: 33, end: 42 },
    },
  ],
};

const CRLF_FIXTURE: Fixture = {
  id: "crlf",
  source: "Line one.\r\n\r\nSecond 😀 line.",
  result: "Ligne un. Deuxième 😀 ligne.",
  pairs: [
    {
      segment: { id: "c0", testID: "result-seg-0", start: 0, end: 9 },
      sourceRange: { start: 0, end: 9 },
    },
    {
      segment: { id: "c1", testID: "result-seg-1", start: 10, end: 28 },
      sourceRange: { start: 13, end: 28 },
    },
  ],
};

const LONG_FIXTURE: Fixture = {
  id: "long",
  source:
    "One long paragraph that wraps cleanly across narrow widths without clipping or forcing huge vertical expansion. " +
    "Second long sentence follows with enough words to step font size down smoothly and test scrolling behavior cleanly. " +
    "Third long sentence ensures the content exceeds the compact height budget and triggers font step-down.",
  result: "Long result.",
  pairs: [
    {
      segment: { id: "l0", testID: "result-seg-0", start: 0, end: 12 },
      sourceRange: { start: 0, end: 111 },
    },
  ],
};

function SentenceHighlightApp() {
  const fixture = signal<Fixture>(DEFAULT_FIXTURE);
  const sourceText = signal(DEFAULT_FIXTURE.source);
  const activeSegmentId = signal<string | null>(null);
  const submitCount = signal(0);
  const fontStep = signal(FONT_SIZE_STEPS.length - 1);
  const selectionChanges = signal(0);
  const lastSel = signal("none");
  const isFocused = signal(false);
  let sourceHandle: QuickTranslateSourceHandle | null = null;

  const hoveredId = signal<string | null>(null);

  const activeRange = (): SourceHighlightRange | null => {
    const id = activeSegmentId();
    if (!id) return null;
    const match = fixture().pairs.find((item: FixturePair) => item.segment.id === id);
    return match ? match.sourceRange : null;
  };

  const applyFixture = (next: Fixture) => {
    hoveredId.set(null);
    activeSegmentId.set(null);
    fixture.set(next);
    sourceText.set(next.source);
  };

  return (
    <View class="flex-1 bg-background p-4">
      <View class="gap-3">
        <View class="flex-row gap-2">
          <Button
            testID="fixture-basic"
            label="Basic"
            onPress={() => applyFixture(DEFAULT_FIXTURE)}
          />
          <Button testID="fixture-crlf" label="CRLF" onPress={() => applyFixture(CRLF_FIXTURE)} />
          <Button testID="fixture-long" label="Long" onPress={() => applyFixture(LONG_FIXTURE)} />
          <Button
            testID="focus-end"
            label="Focus End"
            onPress={() => {
              sourceHandle?.focus();
              const end = sourceText().length;
              sourceHandle?.setSelection(end, end);
            }}
          />
        </View>

        <Text class="text-sm text-foreground">
          <Text testID="ref-brand-soft" class="bg-brand-soft">
            Reference
          </Text>
        </Text>
        <Text testID="outside-gap" class="text-xs text-muted-foreground">
          Gap target
        </Text>
        <Text testID="submit-count">{`submits:${submitCount()}`}</Text>
        <Text testID="font-step">{`step:${fontStep()}`}</Text>
        <Text testID="source-value">{`source:${sourceText()}`}</Text>
        <Text testID="selection-count">{`selections:${selectionChanges()} sel=${lastSel()} f=${isFocused()}`}</Text>

        <QuickTranslateSourceEditor
          testID="quick-translate-source"
          ref={(handle: QuickTranslateSourceHandle | null) => {
            sourceHandle = handle;
          }}
          value={sourceText()}
          highlightRange={activeRange()}
          maxHeight={120}
          onChangeText={(next: string) => {
            sourceText.set(next);
            activeSegmentId.set(null);
          }}
          onSubmitEditing={() => submitCount.update((n: number) => n + 1)}
          onFocus={() => isFocused.set(true)}
          onBlur={() => isFocused.set(false)}
          onSelectionChange={(sel?: { anchor: number; head: number; empty: boolean }) => {
            selectionChanges.update((n: number) => n + 1);
            if (sel) lastSel.set(`${sel.anchor}..${sel.head}:${sel.empty}`);
          }}
          onFontStepChange={(step: number) => fontStep.set(step)}
        />

        <AlignedTranslation
          testID="quick-translate-result-text"
          text={fixture().result}
          segments={fixture().pairs.map((p: FixturePair) => p.segment)}
          activeSegmentId={activeSegmentId()}
          onHoverEnterSegment={(id: string) => {
            hoveredId.set(id);
            activeSegmentId.set(id);
          }}
          onHoverLeaveSegment={(id: string) => {
            if (hoveredId() === id) {
              hoveredId.set(null);
              activeSegmentId.set(null);
            }
          }}
        />
      </View>
    </View>
  );
}

mount(() => <SentenceHighlightApp />);
