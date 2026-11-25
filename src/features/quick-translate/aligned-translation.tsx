import { Text, View } from "nsh";

export interface SentenceSegment {
  id: string;
  start: number;
  end: number;
  testID?: string;
}

export interface AlignedTranslationProps {
  testID?: string;
  text: string;
  segments: readonly SentenceSegment[];
  activeSegmentId?: string | null;
  onHoverEnterSegment?: (segmentId: string) => void;
  onHoverLeaveSegment?: (segmentId: string) => void;
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

export function AlignedTranslation(props: AlignedTranslationProps) {
  const pieces = () => buildTextPieces(props.text, props.segments);

  return (
    <View testID={props.testID ? `${props.testID}-container` : undefined} selectable>
      <Text testID={props.testID}>
        {pieces().map((piece) => {
          const seg = piece.segment;
          if (!seg) return piece.text;
          const isActive = () => props.activeSegmentId === seg.id;
          return (
            <Text
              testID={seg.testID}
              class={isActive() ? "bg-brand-soft hover:bg-brand-soft" : "hover:bg-brand-soft"}
              onMouseEnter={() => props.onHoverEnterSegment?.(seg.id)}
              onMouseLeave={() => props.onHoverLeaveSegment?.(seg.id)}
            >
              {piece.text}
            </Text>
          );
        })}
      </Text>
    </View>
  );
}
