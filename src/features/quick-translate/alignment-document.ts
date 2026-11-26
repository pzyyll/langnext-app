import type { SentenceAlignmentPair } from "langnext-native";
import type { TextViewBlock, TextViewDocument, TextViewInline } from "nsh/base";
import { TextView } from "nsh/base";
import {
  composeSentenceFragments,
  fragmentTestId,
  type SentenceFragment,
  type SentenceSegment,
  type TextRange,
} from "./alignment-ranges";

export const ALIGNMENT_SEGMENT_NODE_NAME = "sentenceAlignmentSegment";
const MAX_CUSTOM_TEXT_RUN_CHARS = 18;

export type SentenceAligner = (
  sourceText: string,
  targetBlocks: (string | null)[],
) => SentenceAlignmentPair[];

export interface AlignmentSegmentMarks {
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  headerCell?: boolean;
  strong?: boolean;
  emphasis?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  linkUrl?: string;
  linkTitle?: string;
  small?: boolean;
  blockquote?: boolean;
}

export interface AlignmentSegmentNodeData {
  segmentId?: string;
  comparisonId?: string;
  testID?: string;
  marks?: AlignmentSegmentMarks;
}

export interface MarkdownAlignedSegment {
  id: string;
  testID: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface MarkdownAlignmentResult {
  document: TextViewDocument;
  segments: MarkdownAlignedSegment[];
}

interface InlineBlockSlot {
  blockIndex: number;
  text: string;
  marks: AlignmentSegmentMarks;
  apply: (annotated: TextViewInline[]) => void;
  getContent: () => TextViewInline[];
}

export interface PreparedMarkdownAlignment {
  document: TextViewDocument;
  targetBlocks: (string | null)[];
  slots: InlineBlockSlot[];
}

const MARKDOWN_PARSE_OPTIONS = { streaming: false, html: false, math: false } as const;

function isWhitespaceTextInline(node: TextViewInline): boolean {
  return node.type === "text" && node.text.trim().length === 0;
}

function isOnlyImages(content: readonly TextViewInline[]): boolean {
  let hasImage = false;
  for (const node of content) {
    if (node.type === "image") {
      hasImage = true;
      continue;
    }
    if (node.type === "link" && isOnlyImages(node.content)) {
      hasImage = true;
      continue;
    }
    if (node.type === "break" || isWhitespaceTextInline(node)) {
      continue;
    }
    return false;
  }
  return hasImage;
}

function extractInlineText(content: readonly TextViewInline[]): string {
  let out = "";
  for (const node of content) {
    switch (node.type) {
      case "text":
      case "keyboard":
        out += node.text;
        break;
      case "code":
        out += node.code;
        break;
      case "math":
        out += node.tex;
        break;
      case "image":
        out += node.alt ?? "";
        break;
      case "break":
        out += "\n";
        break;
      case "footnoteReference":
        out += `[${node.index}]`;
        break;
      case "strong":
      case "emphasis":
      case "strikethrough":
      case "underline":
      case "highlight":
      case "textStyle":
      case "superscript":
      case "subscript":
      case "small":
      case "link":
        out += extractInlineText(node.content);
        break;
      case "custom":
        out += node.content ? extractInlineText(node.content) : (node.text ?? "");
        break;
    }
  }
  return out;
}

function getInlinePlainLength(node: TextViewInline): number {
  switch (node.type) {
    case "text":
    case "keyboard":
      return node.text.length;
    case "code":
      return node.code.length;
    case "math":
      return node.tex.length;
    case "image":
      return (node.alt ?? "").length;
    case "break":
      return 1;
    case "footnoteReference":
      return `[${node.index}]`.length;
    case "strong":
    case "emphasis":
    case "strikethrough":
    case "underline":
    case "highlight":
    case "textStyle":
    case "superscript":
    case "subscript":
    case "small":
    case "link":
      return node.content.reduce((sum, child) => sum + getInlinePlainLength(child), 0);
    case "custom":
      return node.content
        ? node.content.reduce((sum, child) => sum + getInlinePlainLength(child), 0)
        : (node.text ?? "").length;
  }
}

function chunkWrapFriendlyText(text: string): string[] {
  if (text.length <= MAX_CUSTOM_TEXT_RUN_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= MAX_CUSTOM_TEXT_RUN_CHARS) {
      chunks.push(text.slice(start));
      break;
    }
    let end = start + MAX_CUSTOM_TEXT_RUN_CHARS;
    const windowStr = text.slice(start, end + 1);
    const spaceIdx = windowStr.lastIndexOf(" ");
    if (spaceIdx > 0) {
      end = start + spaceIdx + 1;
    } else if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        end -= 1;
      }
      if (end <= start) end = start + 2;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function makeSegmentNode(
  fragment: SentenceFragment,
  fragmentCounters: Map<string, number>,
  inner: TextViewInline[],
  marks: AlignmentSegmentMarks,
): TextViewInline {
  const referenceId = fragment.comparisonId;
  const testID =
    fragment.segment?.testID ?? (referenceId ? `comparison-${referenceId}` : undefined);
  const data: AlignmentSegmentNodeData = {
    segmentId: fragment.segment?.id,
    comparisonId: referenceId,
    testID: fragmentTestId(testID, fragmentCounters),
    marks,
  };
  return {
    type: "custom",
    name: ALIGNMENT_SEGMENT_NODE_NAME,
    data,
    content: inner,
  };
}

function splitTextInline(
  text: string,
  baseOffset: number,
  segments: readonly SentenceFragment[],
  fragmentCounters: Map<string, number>,
  marks: AlignmentSegmentMarks,
): TextViewInline[] {
  if (text.length === 0) return [{ type: "text", text }];
  const nodeEnd = baseOffset + text.length;
  const result: TextViewInline[] = [];
  let cursor = baseOffset;

  for (const seg of segments) {
    if (seg.end <= cursor) continue;
    if (seg.start >= nodeEnd) break;
    const overlapStart = Math.max(cursor, seg.start);
    const overlapEnd = Math.min(nodeEnd, seg.end);
    if (overlapStart > cursor) {
      result.push({
        type: "text",
        text: text.slice(cursor - baseOffset, overlapStart - baseOffset),
      });
    }
    if (overlapEnd > overlapStart) {
      const slice = text.slice(overlapStart - baseOffset, overlapEnd - baseOffset);
      for (const chunk of chunkWrapFriendlyText(slice)) {
        result.push(makeSegmentNode(seg, fragmentCounters, [{ type: "text", text: chunk }], marks));
      }
      cursor = overlapEnd;
    }
  }

  if (cursor < nodeEnd) {
    result.push({ type: "text", text: text.slice(cursor - baseOffset) });
  }
  return result;
}

function extendMarksForInline(
  node: TextViewInline,
  marks: AlignmentSegmentMarks,
): AlignmentSegmentMarks {
  switch (node.type) {
    case "strong":
      return { ...marks, strong: true };
    case "emphasis":
      return { ...marks, emphasis: true };
    case "strikethrough":
      return { ...marks, strikethrough: true };
    case "underline":
      return { ...marks, underline: true };
    case "link":
      return {
        ...marks,
        linkUrl: node.url,
        ...(node.title ? { linkTitle: node.title } : {}),
        underline: true,
      };
    case "small":
    case "superscript":
    case "subscript":
      return { ...marks, small: true };
    default:
      return marks;
  }
}

function annotateInlines(
  content: readonly TextViewInline[],
  segments: readonly SentenceFragment[],
  cursorRef: { value: number },
  fragmentCounters: Map<string, number>,
  marks: AlignmentSegmentMarks,
): TextViewInline[] {
  const out: TextViewInline[] = [];

  for (const node of content) {
    const start = cursorRef.value;
    switch (node.type) {
      case "text": {
        cursorRef.value += node.text.length;
        out.push(...splitTextInline(node.text, start, segments, fragmentCounters, marks));
        break;
      }
      case "code":
      case "keyboard": {
        const len = node.type === "code" ? node.code.length : node.text.length;
        const end = start + len;
        cursorRef.value = end;
        const enclosing =
          len > 0 ? segments.find((seg) => seg.start <= start && end <= seg.end) : undefined;
        out.push(enclosing ? makeSegmentNode(enclosing, fragmentCounters, [node], marks) : node);
        break;
      }
      case "strong":
      case "emphasis":
      case "strikethrough":
      case "underline":
      case "highlight":
      case "textStyle":
      case "superscript":
      case "subscript":
      case "small":
      case "link": {
        const childMarks = extendMarksForInline(node, marks);
        out.push({
          ...node,
          content: annotateInlines(node.content, segments, cursorRef, fragmentCounters, childMarks),
        });
        break;
      }
      case "math":
      case "image":
      case "break":
      case "footnoteReference":
      case "custom": {
        cursorRef.value += getInlinePlainLength(node);
        out.push(node);
        break;
      }
    }
  }

  return out;
}

function collectBlocks(
  blocks: TextViewBlock[],
  targetBlocks: (string | null)[],
  slots: InlineBlockSlot[],
  blockMarks: AlignmentSegmentMarks = {},
): void {
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph": {
        if (isOnlyImages(block.content)) {
          targetBlocks.push(null);
          break;
        }
        const text = extractInlineText(block.content);
        const blockIndex = targetBlocks.length;
        targetBlocks.push(text);
        slots.push({
          blockIndex,
          text,
          marks: blockMarks,
          getContent: () => block.content,
          apply: (annotated) => {
            block.content = annotated;
          },
        });
        break;
      }
      case "heading": {
        const text = extractInlineText(block.content);
        const blockIndex = targetBlocks.length;
        targetBlocks.push(text);
        slots.push({
          blockIndex,
          text,
          marks: { ...blockMarks, headingLevel: block.level, strong: true },
          getContent: () => block.content,
          apply: (annotated) => {
            block.content = annotated;
          },
        });
        break;
      }
      case "blockquote": {
        collectBlocks(block.children, targetBlocks, slots, {
          ...blockMarks,
          blockquote: true,
        });
        break;
      }
      case "list": {
        for (const item of block.items) {
          collectBlocks(item.children, targetBlocks, slots, blockMarks);
        }
        break;
      }
      case "table": {
        const rows: Array<{ row: { content: TextViewInline[] }[]; header: boolean }> = [
          { row: block.head, header: true },
          ...(block.rows ?? []).map((row) => ({ row, header: false })),
        ];
        for (const { row, header } of rows) {
          for (const cell of row) {
            if (isOnlyImages(cell.content)) {
              targetBlocks.push(null);
              continue;
            }
            const text = extractInlineText(cell.content);
            const blockIndex = targetBlocks.length;
            targetBlocks.push(text);
            slots.push({
              blockIndex,
              text,
              marks: header ? { ...blockMarks, headerCell: true, strong: true } : blockMarks,
              getContent: () => cell.content,
              apply: (annotated) => {
                cell.content = annotated;
              },
            });
          }
        }
        break;
      }
      case "codeBlock":
      case "math":
      case "rule":
      case "details":
      case "custom":
        targetBlocks.push(null);
        break;
    }
  }
}

export function prepareMarkdownAlignment(markdown: string): PreparedMarkdownAlignment | null {
  if (!markdown.trim()) return null;
  const document = TextView.parse(markdown, MARKDOWN_PARSE_OPTIONS);
  const targetBlocks: (string | null)[] = [];
  const slots: InlineBlockSlot[] = [];
  collectBlocks(document.blocks, targetBlocks, slots);
  if (slots.length === 0) return null;
  return { document, targetBlocks, slots };
}

export interface MarkdownComparisonSource {
  text: string;
  blocks: readonly (TextRange & { blockIndex: number })[];
}

export function prepareMarkdownComparisonSource(markdown: string): MarkdownComparisonSource {
  const targetBlocks = prepareMarkdownAlignment(markdown)?.targetBlocks ?? [];
  let text = "";
  const blocks: Array<TextRange & { blockIndex: number }> = [];
  for (const [blockIndex, block] of targetBlocks.entries()) {
    if (!block?.trim()) continue;
    if (text.length > 0) text += "\n\n";
    const start = text.length;
    text += block;
    blocks.push({ blockIndex, start, end: text.length });
  }
  return { text, blocks };
}

export function projectMarkdownComparison(
  source: MarkdownComparisonSource,
  segments: readonly SentenceSegment[],
): ReadonlyMap<number, SentenceSegment[]> {
  const byBlock = new Map<number, SentenceSegment[]>();
  for (const block of source.blocks) {
    const ranges: SentenceSegment[] = [];
    for (const segment of segments) {
      const start = Math.max(segment.start, block.start);
      const end = Math.min(segment.end, block.end);
      if (start < end) {
        ranges.push({ id: segment.id, start: start - block.start, end: end - block.start });
      }
    }
    if (ranges.length > 0) byBlock.set(block.blockIndex, ranges);
  }
  return byBlock;
}

export function finalizeMarkdownAlignment(
  sourceText: string,
  prepared: PreparedMarkdownAlignment,
  pairs: readonly SentenceAlignmentPair[],
  comparison?: ReadonlyMap<number, readonly SentenceSegment[]>,
): MarkdownAlignmentResult | null {
  const slotByBlockIndex = new Map<number, InlineBlockSlot>();
  for (const slot of prepared.slots) {
    slotByBlockIndex.set(slot.blockIndex, slot);
  }

  const sorted = [...pairs].sort(
    (a, b) => a.targetBlockIndex - b.targetBlockIndex || a.targetStart - b.targetStart,
  );

  const blockSegments = new Map<number, SentenceSegment[]>();
  const segments: MarkdownAlignedSegment[] = [];
  const fragmentCounters = new Map<string, number>();

  for (const pair of sorted) {
    const slot = slotByBlockIndex.get(pair.targetBlockIndex);
    if (!slot) continue;
    if (
      pair.targetStart < 0 ||
      pair.targetEnd <= pair.targetStart ||
      pair.targetEnd > slot.text.length
    ) {
      continue;
    }
    if (
      pair.sourceStart < 0 ||
      pair.sourceEnd <= pair.sourceStart ||
      pair.sourceEnd > sourceText.length
    ) {
      continue;
    }
    const existingList = blockSegments.get(slot.blockIndex) ?? [];
    const last = existingList[existingList.length - 1];
    if (last && pair.targetStart < last.end) continue;

    const segmentIndex = segments.length;
    const id = `seg-${segmentIndex}`;
    const testID = `result-seg-${segmentIndex}`;
    const indexed: SentenceSegment = {
      id,
      testID,
      start: pair.targetStart,
      end: pair.targetEnd,
    };
    existingList.push(indexed);
    blockSegments.set(slot.blockIndex, existingList);
    segments.push({
      id,
      testID,
      sourceStart: pair.sourceStart,
      sourceEnd: pair.sourceEnd,
    });
  }

  if (segments.length === 0 && !comparison?.size) return null;

  for (const slot of prepared.slots) {
    const segs = blockSegments.get(slot.blockIndex) ?? [];
    const refs = comparison?.get(slot.blockIndex) ?? [];
    if (segs.length === 0 && refs.length === 0) continue;
    const fragments = composeSentenceFragments(segs, refs);
    const cursorRef = { value: 0 };
    slot.apply(
      annotateInlines(slot.getContent(), fragments, cursorRef, fragmentCounters, slot.marks),
    );
  }

  return {
    document: prepared.document,
    segments,
  };
}

export function buildAlignedMarkdownDocument(
  sourceText: string,
  markdown: string,
  align: SentenceAligner,
): MarkdownAlignmentResult | null {
  if (!sourceText.trim() || !markdown.trim()) return null;
  const prepared = prepareMarkdownAlignment(markdown);
  if (!prepared) return null;
  const pairs = align(sourceText, prepared.targetBlocks);
  return finalizeMarkdownAlignment(sourceText, prepared, pairs);
}
