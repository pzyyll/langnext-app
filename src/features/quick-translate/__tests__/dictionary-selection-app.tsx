import { SentenceAlignmentNative } from "langnext-native";
import { Scroll, Text, View, mount, signal } from "nsh";
import { TranslationOutput } from "../../../components/ui/translation-output";
import { AlignedTranslation } from "../aligned-translation";
import { buildAlignedMarkdownDocument } from "../alignment-document";
import { DictionarySelectionPill } from "../dictionary-pill";
import { createDictionarySelectionCoordinator } from "../selection-coordinator";
import type { QuickTranslateSession } from "../session";
import { QuickTranslateSourceEditor } from "../source-editor";

function DictionarySelectionGateApp() {
  const sourceText = signal("Hello ephemeral world.");
  const plainSelection = signal("none");
  const mdSelection = signal("none");
  const alignedPlainSelection = signal("none");
  const alignedMdSelection = signal("none");
  const sourceSelection = signal("none");
  const menuEvents = signal(0);
  const pillLookups = signal<string[]>([]);
  const pressedSegments = signal<string[]>([]);

  const mockSession = {
    notifyOverlayOpenChange: () => {},
    handleLookupSelection: (query: { term: string; region: string }) => {
      pillLookups.update((prev) => [...prev, `${query.region}:${query.term}`]);
    },
  } as unknown as QuickTranslateSession;

  const coordinator = createDictionarySelectionCoordinator({
    session: mockSession,
    isConfigured: () => true,
  });

  const menuItems = [
    {
      label: "Look up",
      onSelect: () => {
        menuEvents.update((count) => count + 1);
      },
    },
  ];

  const mdAligned = buildAlignedMarkdownDocument(
    ["Summary V1", "", "First ephemeral sentence. Second segment follows."].join("\n"),
    ["## Summary V1", "", "First **ephemeral** sentence. Second segment follows."].join("\n"),
    SentenceAlignmentNative.align,
  );
  const mdSegments =
    mdAligned?.segments.map((item) => ({
      id: item.id,
      testID: item.testID,
      start: 0,
      end: 0,
    })) ?? [];

  return (
    <Scroll class="flex-1 bg-background p-4">
      <View class="gap-4">
        <Text testID="seam-source-selection">{`source:${sourceSelection()}`}</Text>
        <Text testID="seam-plain-selection">{`plain:${plainSelection()}`}</Text>
        <Text testID="seam-md-selection">{`md:${mdSelection()}`}</Text>
        <Text testID="seam-aligned-plain-selection">{`alignedPlain:${alignedPlainSelection()}`}</Text>
        <Text testID="seam-aligned-md-selection">{`alignedMd:${alignedMdSelection()}`}</Text>
        <Text testID="seam-menu-count">{`menu:${menuEvents()}`}</Text>
        <Text testID="seam-press-log">{`pressed:${pressedSegments().join(",")}`}</Text>
        <Text testID="seam-pill-log">{`pill:${pillLookups().join(",")}`}</Text>
        <Text testID="seam-md-info">{`mdDoc:${Boolean(mdAligned)}:${mdSegments.map((s) => `${s.id}@${s.testID}`).join(",")}`}</Text>

        <QuickTranslateSourceEditor
          testID="seam-source"
          value={sourceText()}
          onChangeText={(next) => sourceText.set(next)}
          onTextSelectionChange={(sel) => {
            sourceSelection.set(
              sel ? `${sel.text}|${Boolean(sel.pageBounds)}|${sel.start}:${sel.end}` : "none",
            );
            coordinator.handleSelection(
              "source",
              sel ? { text: sel.text, pageBounds: sel.pageBounds ?? undefined } : null,
              { fullText: sourceText(), start: sel?.start, end: sel?.end },
            );
          }}
          selectionMenu={menuItems}
        />

        <TranslationOutput
          testID="seam-plain"
          text="This is ephemeral beauty in spring."
          markdownEnabled={false}
          streaming={false}
          onSelectionChange={(e) => {
            plainSelection.set(e.text ? `${e.text}|${Boolean(e.pageBounds)}` : "none");
            coordinator.handleSelection("result", e, {
              fullText: "This is ephemeral beauty in spring.",
            });
          }}
          selectionMenu={menuItems}
        />

        <TranslationOutput
          testID="seam-md"
          text="**Bold ephemeral** phrase in markdown."
          markdownEnabled={true}
          streaming={false}
          onSelectionChange={(e) => {
            mdSelection.set(e.text ? `${e.text}|${Boolean(e.pageBounds)}` : "none");
          }}
          selectionMenu={menuItems}
        />

        <AlignedTranslation
          testID="seam-aligned-plain"
          text="First ephemeral clause. Second aligned clause."
          segments={[
            { id: "seg-1", testID: "seam-aligned-seg-1", start: 0, end: 23 },
            { id: "seg-2", testID: "seam-aligned-seg-2", start: 24, end: 46 },
          ]}
          onPressSegment={(id) => pressedSegments.update((prev) => [...prev, id])}
          onSelectionChange={(e) => {
            alignedPlainSelection.set(e.text ? `${e.text}|${Boolean(e.pageBounds)}` : "none");
          }}
          selectionMenu={menuItems}
        />

        <AlignedTranslation
          testID="seam-aligned-md"
          text={["First ephemeral segment.", "", "Second segment here."].join("\n")}
          document={mdAligned?.document ?? null}
          segments={mdSegments}
          onPressSegment={(id) => pressedSegments.update((prev) => [...prev, id])}
          onSelectionChange={(e) => {
            alignedMdSelection.set(e.text ? `${e.text}|${Boolean(e.pageBounds)}` : "none");
          }}
          selectionMenu={menuItems}
        />
      </View>
      <DictionarySelectionPill
        anchor={coordinator.pillAnchor()}
        onPressDown={() => coordinator.beginPillPress()}
        onEndPress={() => coordinator.endPillPress()}
        onPress={() => void coordinator.triggerLookup()}
        onDismiss={() => coordinator.clear()}
      />
    </Scroll>
  );
}

mount(() => <DictionarySelectionGateApp />);
