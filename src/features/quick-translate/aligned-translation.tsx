import { Text, View, type PressEvent } from "nsh";
import {
  TextView,
  type TextViewCustomNode,
  type TextViewDocument,
  type TextViewLinkPressEvent,
} from "nsh/base";
import type { QuickTranslateSelectionMenu, TextSelectionEventPayload } from "./selection-types";
import {
  translationOutputClass,
  type TranslationOutputSize,
} from "../../components/ui/translation-output";
import {
  ALIGNMENT_SEGMENT_NODE_NAME,
  type AlignmentSegmentMarks,
  type AlignmentSegmentNodeData,
} from "./alignment-document";

import {
  composeSentenceFragments,
  fragmentTestId,
  type SentenceFragment,
  type SentenceSegment,
} from "./alignment-ranges";

export type { SentenceSegment } from "./alignment-ranges";

export interface AlignedTranslationProps {
  testID?: string;
  text: string;
  size?: TranslationOutputSize;
  document?: TextViewDocument | null;
  segments: readonly SentenceSegment[];
  activeSegmentId?: string | null;
  comparisonSegments?: readonly SentenceSegment[];
  activeComparisonId?: string | null;
  onHoverEnterSegment?: (segmentId: string) => void;
  onHoverLeaveSegment?: (segmentId: string) => void;
  onPressSegment?: (segmentId: string, event: PressEvent) => void;
  onLinkPress?: (event: TextViewLinkPressEvent) => void;
  onSelectionChange?: (event: TextSelectionEventPayload) => void;
  selectionMenu?: QuickTranslateSelectionMenu;
}

interface TextPiece {
  text: string;
  fragment?: SentenceFragment;
  testID?: string;
}

function clippedSegments(text: string, segments: readonly SentenceSegment[]): SentenceSegment[] {
  return segments
    .map((seg) => ({
      ...seg,
      start: Math.max(0, seg.start),
      end: Math.min(text.length, seg.end),
    }))
    .filter((seg) => seg.end > seg.start)
    .sort((a, b) => a.start - b.start);
}

function buildTextPieces(
  text: string,
  segments: readonly SentenceSegment[],
  comparison: readonly SentenceSegment[],
): TextPiece[] {
  const fragments = composeSentenceFragments(
    clippedSegments(text, segments),
    clippedSegments(text, comparison),
  );
  const counters = new Map<string, number>();
  const pieces: TextPiece[] = [];
  let cursor = 0;

  for (const fragment of fragments) {
    const start = Math.max(cursor, fragment.start);
    if (fragment.end <= start) continue;
    if (start > cursor) pieces.push({ text: text.slice(cursor, start) });
    pieces.push({
      text: text.slice(start, fragment.end),
      fragment,
      testID: fragmentTestId(fragment.segment?.testID, counters),
    });
    cursor = fragment.end;
  }

  if (cursor < text.length) pieces.push({ text: text.slice(cursor) });
  return pieces;
}

function readCustomNodeText(node: TextViewCustomNode): {
  text: string;
  isCode: boolean;
} {
  const firstChild = node.content?.[0];
  if (!firstChild) {
    return { text: node.text ?? "", isCode: false };
  }
  switch (firstChild.type) {
    case "code":
      return { text: firstChild.code, isCode: true };
    case "keyboard":
      return { text: firstChild.text, isCode: true };
    case "text":
      return { text: firstChild.text, isCode: false };
    default:
      return { text: node.text ?? "", isCode: false };
  }
}

function buildSegmentFragmentClass(
  marks: AlignmentSegmentMarks | undefined,
  isCode: boolean,
  isActive: boolean,
): string {
  const classes = ["hover:opacity-100"];
  if (isActive) {
    classes.push("bg-brand-soft");
  } else if (isCode) {
    classes.push("bg-surface-subtle");
  }
  if (isCode) classes.push("rounded px-1 font-mono text-sm");
  if (marks?.strong) classes.push("font-semibold");
  if (marks?.emphasis) classes.push("italic");
  if (marks?.strikethrough) classes.push("line-through");
  if (marks?.linkUrl) {
    classes.push("underline text-primary");
  } else if (marks?.underline) {
    classes.push("underline");
  }
  if (marks?.small || marks?.headerCell) classes.push("text-xs");
  if (marks?.headerCell) classes.push("text-muted-foreground");
  if (marks?.headingLevel === 1) classes.push("text-2xl");
  else if (marks?.headingLevel === 2) classes.push("text-xl");
  else if (marks?.headingLevel === 3) classes.push("text-lg");
  return classes.join(" ");
}

export function AlignedTranslation(props: AlignedTranslationProps) {
  const pieces = () => buildTextPieces(props.text, props.segments, props.comparisonSegments ?? []);
  const isHighlighted = (segmentId: string | undefined, comparisonId: string | undefined) =>
    (segmentId !== undefined && props.activeSegmentId === segmentId) ||
    (comparisonId !== undefined && props.activeComparisonId === comparisonId);
  const textClass = () => translationOutputClass(props.size);

  const renderCustomSegment = (node: TextViewCustomNode) => {
    if (node.name !== ALIGNMENT_SEGMENT_NODE_NAME) {
      return <Text>{node.text ?? ""}</Text>;
    }
    const data = node.data as AlignmentSegmentNodeData | undefined;
    const segmentId = data?.segmentId;
    const { text, isCode } = readCustomNodeText(node);
    const isActive = () => isHighlighted(segmentId, data?.comparisonId);
    const linkUrl = data?.marks?.linkUrl;
    const linkTitle = data?.marks?.linkTitle;
    return (
      <Text
        testID={data?.testID}
        copyText={text}
        role={linkUrl ? "link" : undefined}
        focusable={linkUrl ? undefined : false}
        accessibilityHint={linkUrl ? (linkTitle ?? linkUrl) : undefined}
        class={buildSegmentFragmentClass(data?.marks, isCode, isActive())}
        onPress={
          linkUrl
            ? (event) => {
                props.onLinkPress?.({ url: linkUrl, modifiers: event.modifiers });
              }
            : segmentId
              ? (event) => {
                  props.onPressSegment?.(segmentId, event);
                }
              : undefined
        }
        onMouseEnter={() => {
          if (segmentId) props.onHoverEnterSegment?.(segmentId);
        }}
        onMouseLeave={() => {
          if (segmentId) props.onHoverLeaveSegment?.(segmentId);
        }}
      >
        {text}
      </Text>
    );
  };

  return (
    <If
      when={Boolean(props.document)}
      else={
        <View
          testID={props.testID ? `${props.testID}-container` : undefined}
          selectable
          onSelectionChange={props.onSelectionChange}
          selectionMenu={props.selectionMenu}
        >
          <Text testID={props.testID} class={textClass()}>
            {pieces().map((piece) => {
              const fragment = piece.fragment;
              if (!fragment) return piece.text;
              const id = fragment.segment?.id;
              return (
                <Text
                  testID={piece.testID}
                  focusable={false}
                  class={
                    isHighlighted(id, fragment.comparisonId)
                      ? "bg-brand-soft hover:opacity-100"
                      : id
                        ? "hover:opacity-100"
                        : undefined
                  }
                  onPress={id ? (event) => props.onPressSegment?.(id, event) : undefined}
                  onMouseEnter={id ? () => props.onHoverEnterSegment?.(id) : undefined}
                  onMouseLeave={id ? () => props.onHoverLeaveSegment?.(id) : undefined}
                >
                  {piece.text}
                </Text>
              );
            })}
          </Text>
        </View>
      }
    >
      <View
        testID={props.testID ? `${props.testID}-container` : undefined}
        selectable
        onSelectionChange={props.onSelectionChange}
        selectionMenu={props.selectionMenu}
      >
        <TextView
          testID={props.testID}
          class={textClass()}
          document={props.document}
          selectable
          links="report"
          renderImage={({ alt }) => <Text>{alt}</Text>}
          onLinkPress={props.onLinkPress}
          renderCustom={renderCustomSegment}
        />
      </View>
    </If>
  );
}
