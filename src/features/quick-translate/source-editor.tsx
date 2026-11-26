import {
  RichEditor,
  RichEditorPlugin,
  type RichEditorRef,
  type RichEditorSession,
  baseKeymap,
  command,
  createRichEditor,
  defineSchema,
  history,
  keymap,
} from "nsh/base";
import { View, cleanup, effect, fontScale, keymap as appKeymap, signal } from "nsh";
import {
  FONT_FIT_SLACK_POINTS,
  FONT_SIZE_STEPS,
  FONT_STEP_LINE_HEIGHTS,
  FONT_STEP_POINTS,
  LARGEST_FONT_STEP,
  clampFontStep,
  comparableMeasureText,
  fieldShouldStepDown,
  fontFitBudget,
  fontFitSlack,
  fontMeasureClass,
  measurementLooksCollapsed,
  pickFontStep,
} from "../../components/ui/font-step";
import { FontProbes } from "../../components/ui/textarea";

export interface SourceHighlightRange {
  start: number;
  end: number;
}

export interface QuickTranslateSourceHandle {
  focus(): void;
  blur(): void;
  setSelection(start: number, end: number): void;
}

export type SourceInputHandle = QuickTranslateSourceHandle;

export interface QuickTranslateSourceEditorProps {
  testID?: string;
  ref?: (handle: QuickTranslateSourceHandle | null) => void;
  value: string;
  placeholder?: string;
  accessibilityLabel?: string;
  highlightRange?: SourceHighlightRange | null;
  frameless?: boolean;
  singleLine?: boolean;
  maxHeight?: number;
  editable?: boolean;
  autoFocus?: boolean;
  initialFontStep?: number;
  class?: string;
  inputClass?: string;
  measureClass?: string;
  onChangeText?: (text: string) => void;
  /** An image pasted into the field. The editor inserts nothing for it. */
  onPasteImage?: (png: Uint8Array) => void;
  onSubmitEditing?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onSelectionChange?: (selection?: { anchor: number; head: number; empty: boolean }) => void;
  onCompositionChange?: (composing: boolean) => void;
  onFontStepChange?: (stepIndex: number) => void;
}

interface ParagraphMeta {
  normStart: number;
  normEnd: number;
  docContentStart: number;
}

export interface SourceProjection {
  raw: string;
  normalized: string;
  rawToNorm: number[];
  paragraphs: string[];
  paragraphMeta: ParagraphMeta[];
}

interface PlainDocJson {
  type: "doc";
  content: {
    type: "paragraph";
    content?: { type: "text"; text: string }[];
  }[];
}

const SOURCE_SCHEMA = defineSchema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
});

const HIGHLIGHT_DECORATION_KEY = "quick-translate-sentence-highlight";
const ASCII_CR = 13;
const ASCII_LF = 10;

/** Builds a raw UTF-16 -> normalized UTF-16 -> ProseMirror paragraph position map. */
export function buildSourceProjection(raw: string): SourceProjection {
  const rawToNorm = Array.from<number>({ length: raw.length + 1 });
  let normalized = "";
  let normPos = 0;

  for (let i = 0; i < raw.length;) {
    const code = raw.charCodeAt(i);
    if (code === ASCII_CR && i + 1 < raw.length && raw.charCodeAt(i + 1) === ASCII_LF) {
      rawToNorm[i] = normPos;
      rawToNorm[i + 1] = normPos;
      normalized += "\n";
      normPos += 1;
      i += 2;
      continue;
    }
    rawToNorm[i] = normPos;
    normalized += code === ASCII_CR ? "\n" : raw[i];
    normPos += 1;
    i += 1;
  }
  rawToNorm[raw.length] = normPos;

  const paragraphs = normalized.split("\n");
  const paragraphMeta: ParagraphMeta[] = [];
  let normCursor = 0;
  let docCursor = 1;
  for (const line of paragraphs) {
    paragraphMeta.push({
      normStart: normCursor,
      normEnd: normCursor + line.length,
      docContentStart: docCursor,
    });
    normCursor += line.length + 1;
    docCursor += line.length + 2;
  }

  return { raw, normalized, rawToNorm, paragraphs, paragraphMeta };
}

function normOffsetToDocPos(projection: SourceProjection, normOffset: number): number {
  const clamped = Math.max(0, Math.min(projection.normalized.length, normOffset));
  for (const meta of projection.paragraphMeta) {
    if (clamped <= meta.normEnd) {
      return meta.docContentStart + (clamped - meta.normStart);
    }
  }
  const last = projection.paragraphMeta[projection.paragraphMeta.length - 1];
  return last ? last.docContentStart + (last.normEnd - last.normStart) : 1;
}

export function rawOffsetToDocPos(projection: SourceProjection, rawOffset: number): number {
  const clamped = Math.max(0, Math.min(projection.raw.length, rawOffset));
  return normOffsetToDocPos(projection, projection.rawToNorm[clamped] ?? 0);
}

/** Maps a half-open UTF-16 source range to ProseMirror positions, returning null if blank/empty. */
export function rawRangeToDocRange(
  projection: SourceProjection,
  range: SourceHighlightRange | null | undefined,
): { from: number; to: number } | null {
  if (!range || range.end <= range.start) return null;
  const start = Math.max(0, Math.min(projection.raw.length, range.start));
  const end = Math.max(start, Math.min(projection.raw.length, range.end));
  const normFrom = projection.rawToNorm[start] ?? 0;
  const normTo = projection.rawToNorm[end] ?? normFrom;
  if (normTo <= normFrom) return null;
  if (!projection.normalized.slice(normFrom, normTo).replace(/\n/g, "").length) {
    return null;
  }
  const from = normOffsetToDocPos(projection, normFrom);
  const to = normOffsetToDocPos(projection, normTo);
  return to > from ? { from, to } : null;
}

function buildPlainDocJson(paragraphs: readonly string[]): PlainDocJson {
  const lines = paragraphs.length > 0 ? paragraphs : [""];
  return {
    type: "doc",
    content: lines.map((line) =>
      line.length > 0
        ? { type: "paragraph", content: [{ type: "text", text: line }] }
        : { type: "paragraph" },
    ),
  };
}

function readSessionPlainText(session: RichEditorSession): string {
  return session.textBetween(undefined, undefined, "\n");
}

export function QuickTranslateSourceEditor(props: QuickTranslateSourceEditorProps) {
  let activeProjection = buildSourceProjection(props.value);
  let lastRawValue = props.value;
  let lastNormalizedValue = activeProjection.normalized;
  let syncingExternal = false;
  let editorRef: RichEditorRef | null = null;

  const docRevision = signal(0);
  const editorFocused = signal(false);
  const composing = signal(false);
  const fieldWidth = signal(0);
  const contentHeight = signal(0);
  const probeHeights = signal<number[]>(FONT_SIZE_STEPS.map(() => 0));
  const initialStep = clampFontStep(props.initialFontStep ?? LARGEST_FONT_STEP);
  const stepIndex = signal(initialStep);
  let lastSteppedText = props.value;
  let lastSteppedWidth = 0;
  let maxAllowedStep = LARGEST_FONT_STEP;

  const shiftEnterPlugin = keymap({
    "Shift-Enter": command("splitBlock"),
  });

  const enterPlugin = new RichEditorPlugin("quick-translate-source-enter");
  enterPlugin.captureKeys(["Enter"], (key) => {
    if (key === "Enter" && !session.composing) {
      props.onSubmitEditing?.();
    }
  });
  const highlightPlugin = new RichEditorPlugin(HIGHLIGHT_DECORATION_KEY);

  const session = createRichEditor({
    schema: SOURCE_SCHEMA,
    content: buildPlainDocJson(activeProjection.paragraphs),
    format: "json",
    plugins: [shiftEnterPlugin, enterPlugin, highlightPlugin, history(), baseKeymap()],
  });

  const syncExternalValue = (nextRaw: string) => {
    if (nextRaw === lastRawValue) return;
    const nextProj = buildSourceProjection(nextRaw);
    lastRawValue = nextRaw;
    activeProjection = nextProj;
    const currentNorm = readSessionPlainText(session);
    if (nextProj.normalized !== currentNorm) {
      syncingExternal = true;
      try {
        session.setContent(buildPlainDocJson(nextProj.paragraphs), "json");
      } finally {
        syncingExternal = false;
      }
    }
    lastNormalizedValue = nextProj.normalized;
  };

  const handle: QuickTranslateSourceHandle = {
    focus() {
      if (editorRef) editorRef.focus();
      else session.focus();
    },
    blur() {
      if (editorRef) editorRef.blur();
      else session.blur();
    },
    setSelection(start: number, end: number) {
      syncExternalValue(props.value);
      const from = rawOffsetToDocPos(activeProjection, start);
      const to = rawOffsetToDocPos(activeProjection, end);
      editorRef?.setSelection(from, to);
    },
  };

  effect(() => {
    enterPlugin.capturing = Boolean(props.onSubmitEditing || props.singleLine);
  });

  const applyHighlightDecorations = (range: SourceHighlightRange | null | undefined) => {
    const mapped = rawRangeToDocRange(activeProjection, range);
    session.setDecorations(
      HIGHLIGHT_DECORATION_KEY,
      mapped
        ? [
            {
              from: mapped.from,
              to: mapped.to,
              kind: "inline",
              attrs: { class: "bg-brand-soft" },
            },
          ]
        : [],
    );
  };

  // Sync external `value` and sentence highlight decorations in order so CRLF projections match.
  effect(() => {
    const nextRaw = props.value;
    const range = props.highlightRange;
    docRevision();
    syncExternalValue(nextRaw);
    applyHighlightDecorations(range);
  });

  effect(() => {
    const text = props.value;
    const width = fieldWidth();
    const heights = probeHeights();
    const scale = fontScale();
    const budget = props.maxHeight ?? fontFitBudget(scale);
    const slack = props.maxHeight !== undefined ? FONT_FIT_SLACK_POINTS : fontFitSlack(scale);
    if (!text) {
      maxAllowedStep = LARGEST_FONT_STEP;
      lastSteppedText = "";
      lastSteppedWidth = width;
      if (stepIndex() !== LARGEST_FONT_STEP) {
        stepIndex.set(LARGEST_FONT_STEP);
        props.onFontStepChange?.(LARGEST_FONT_STEP);
      }
      return;
    }
    if (width <= 0) return;

    if (text !== lastSteppedText || Math.abs(width - lastSteppedWidth) > 1) {
      lastSteppedText = text;
      lastSteppedWidth = width;
      maxAllowedStep = LARGEST_FONT_STEP;
    }

    const picked = pickFontStep(heights, budget, slack);
    let nextStep = Math.min(picked, maxAllowedStep);
    const actualHeight = contentHeight();
    const probeHeight = heights[nextStep] ?? 0;
    if (
      nextStep > 0 &&
      actualHeight > budget + slack &&
      (probeHeight <= 0 ||
        fieldShouldStepDown(
          actualHeight,
          probeHeight,
          budget + slack,
          nextStep,
          FONT_STEP_POINTS[nextStep] ?? FONT_STEP_POINTS[0],
        ))
    ) {
      nextStep -= 1;
      maxAllowedStep = Math.min(maxAllowedStep, nextStep);
    }
    if (nextStep !== stepIndex()) {
      stepIndex.set(nextStep);
      props.onFontStepChange?.(nextStep);
    }
  });

  cleanup(() => {
    props.ref?.(null);
    session.dispose();
  });

  // Pass focus navigation and popup dismiss keys past RichEditor's keymap in plain text mode.
  effect(() => {
    if (!editorFocused() || composing()) return;
    const unbind = appKeymap.bind(
      {
        tab: () => {},
        "shift+tab": () => {},
        escape: () => {},
      },
      { when: "always", overFocused: true, passThrough: true },
    );
    cleanup(unbind);
  });

  const editable = () => props.editable ?? true;
  const stepClass = () => FONT_SIZE_STEPS[stepIndex()] ?? FONT_SIZE_STEPS[0];
  const fontWeightClass = () => (props.frameless && stepIndex() >= 2 ? "font-medium" : "");
  const rootClass = () => {
    const minHeight = props.inputClass ?? "min-h-24";
    if (props.frameless) {
      return `w-full bg-transparent ${minHeight}`;
    }
    return `w-full rounded-xl border border-input bg-background px-3 py-2 focus-within:border-ring ${minHeight}`;
  };
  const measureClass = () => props.measureClass ?? fontMeasureClass(props.inputClass);

  return (
    <View
      disabled={!editable()}
      class={`relative ${!editable() ? "opacity-60" : ""} ${props.class ?? "w-full"}`}
      onLayout={({ bounds }) => {
        if (bounds.size.width > 0 && bounds.size.width !== fieldWidth()) {
          fieldWidth.set(bounds.size.width);
        }
      }}
    >
      <FontProbes
        text={props.value}
        width={fieldWidth()}
        frameless={Boolean(props.frameless)}
        measureClass={measureClass()}
        onHeight={(index, height, measured) => {
          if (comparableMeasureText(measured) !== comparableMeasureText(props.value)) return;
          if (measurementLooksCollapsed(measured, fieldWidth(), height, index)) return;
          probeHeights.update((prev: number[]) => {
            if (prev[index] === height) return prev;
            const next = [...prev];
            next[index] = height;
            return next;
          });
        }}
      />
      <RichEditor
        testID={props.testID ?? "quick-translate-source"}
        ref={(node) => {
          editorRef = node;
          props.ref?.(node ? handle : null);
        }}
        editor={session}
        editable={editable()}
        autoFocus={props.autoFocus}
        placeholder={props.placeholder}
        accessibilityLabel={props.accessibilityLabel}
        classes={{
          root: rootClass(),
          placeholder: `${stepClass()} ${fontWeightClass()} text-muted-foreground`,
          nodes: {
            paragraph: `${stepClass()} ${fontWeightClass()} text-foreground`,
          },
        }}
        styles={{
          // Runtime font-step metrics and caller maxHeight budget cannot use static utilities.
          root: props.maxHeight !== undefined ? { maxHeight: props.maxHeight } : undefined,
          nodes: {
            paragraph: {
              fontSize: FONT_STEP_POINTS[stepIndex()],
              lineHeight: FONT_STEP_LINE_HEIGHTS[stepIndex()],
            },
          },
        }}
        onPasteFiles={
          props.onPasteImage
            ? (event) => {
                const image = event.paste.files.find(
                  (file) => file.mime.startsWith("image/") && file.data.byteLength > 0,
                );
                if (image) props.onPasteImage?.(new Uint8Array(image.data));
              }
            : undefined
        }
        onChange={() => {
          docRevision.update((n: number) => n + 1);
          if (syncingExternal) return;
          const nextNorm = readSessionPlainText(session);
          if (nextNorm === lastNormalizedValue) return;
          lastNormalizedValue = nextNorm;
          lastRawValue = nextNorm;
          activeProjection = buildSourceProjection(nextNorm);
          applyHighlightDecorations(props.highlightRange);
          props.onChangeText?.(nextNorm);
        }}
        onContentSizeChange={({ contentSize }) => {
          if (contentSize.height !== contentHeight()) {
            contentHeight.set(contentSize.height);
          }
        }}
        onSelectionChange={({ selection }) =>
          props.onSelectionChange?.({
            anchor: selection.anchor,
            head: selection.head,
            empty: selection.empty,
          })
        }
        onFocus={() => {
          editorFocused.set(true);
          props.onFocus?.();
        }}
        onBlur={() => {
          editorFocused.set(false);
          props.onBlur?.();
        }}
        onCompositionChange={({ composing: nextComposing }) => {
          composing.set(nextComposing);
          props.onCompositionChange?.(nextComposing);
        }}
      />
    </View>
  );
}
