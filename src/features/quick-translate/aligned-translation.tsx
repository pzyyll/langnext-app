import { Text, View, type PressEvent } from "nsh";
import {
  TextView,
  type TextViewCustomNode,
  type TextViewDocument,
  type TextViewLinkPressEvent,
} from "nsh/base";
import {
  ALIGNMENT_SEGMENT_NODE_NAME,
  type AlignmentSegmentMarks,
  type AlignmentSegmentNodeData,
} from "./alignment-document";

export interface SentenceSegment {
  id: string;
  start: number;
  end: number;
  testID?: string;
}

export interface AlignedTranslationProps {
  testID?: string;
  text: string;
  textClass?: string;
  document?: TextViewDocument | null;
  segments: readonly SentenceSegment[];
  activeSegmentId?: string | null;
  onHoverEnterSegment?: (segmentId: string) => void;
  onHoverLeaveSegment?: (segmentId: string) => void;
  onPressSegment?: (segmentId: string, event: PressEvent) => void;
  onLinkPress?: (event: TextViewLinkPressEvent) => void;
}

interface TextPiece {
  key: string;
  text: string;
  segment: SentenceSegment | null;
}

function buildTextPieces(text: string, segments: readonly SentenceSegment[]): TextPiece[] {
  if (!text) return [];
  const valid = segments
    .map((seg) => ({
      ...seg,
      start: Math.max(0, Math.min(text.length, seg.start)),
      end: Math.max(0, Math.min(text.length, seg.end)),
    }))
    .filter((seg) => seg.end > seg.start)
    .sort((a, b) => a.start - b.start);

  const pieces: TextPiece[] = [];
  let cursor = 0;

  for (const seg of valid) {
    const start = Math.max(cursor, seg.start);
    if (seg.end <= start) continue;
    if (start > cursor) {
      pieces.push({
        key: `gap:${cursor}:${start}`,
        text: text.slice(cursor, start),
        segment: null,
      });
    }
    pieces.push({
      key: `seg:${seg.id}:${start}:${seg.end}`,
      text: text.slice(start, seg.end),
      segment: seg,
    });
    cursor = seg.end;
  }

  if (cursor < text.length) {
    pieces.push({
      key: `gap:${cursor}:${text.length}`,
      text: text.slice(cursor),
      segment: null,
    });
  }

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
  const pieces = () => buildTextPieces(props.text, props.segments);
  const textClass = () => props.textClass ?? "text-base leading-relaxed text-card-foreground";

  const renderCustomSegment = (node: TextViewCustomNode) => {
    if (node.name !== ALIGNMENT_SEGMENT_NODE_NAME) {
      return <Text>{node.text ?? ""}</Text>;
    }
    const data = node.data as AlignmentSegmentNodeData | undefined;
    const segmentId = data?.segmentId ?? "";
    const { text, isCode } = readCustomNodeText(node);
    const isActive = () => segmentId.length > 0 && props.activeSegmentId === segmentId;
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
        <View testID={props.testID ? `${props.testID}-container` : undefined} selectable>
          <Text testID={props.testID} class={textClass()}>
            {pieces().map((piece) => {
              const seg = piece.segment;
              if (!seg) return piece.text;
              const isActive = () => props.activeSegmentId === seg.id;
              return (
                <Text
                  testID={seg.testID}
                  focusable={false}
                  class={isActive() ? "bg-brand-soft hover:opacity-100" : "hover:opacity-100"}
                  onPress={(event) => props.onPressSegment?.(seg.id, event)}
                  onMouseEnter={() => props.onHoverEnterSegment?.(seg.id)}
                  onMouseLeave={() => props.onHoverLeaveSegment?.(seg.id)}
                >
                  {piece.text}
                </Text>
              );
            })}
          </Text>
        </View>
      }
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
    </If>
  );
}
