import {
  effect,
  fontScale,
  signal,
  Text,
  View,
  type InputRef,
  type JSX,
  type SubmitBehavior,
} from "nsh";
import { Input as BaseInput } from "nsh/base";
import { motion } from "../motion";
import {
  clampFontStep,
  FONT_SIZE_STEPS,
  FONT_STEP_LINE_HEIGHTS,
  comparableMeasureText,
  fieldShouldStepDown,
  FONT_STEP_POINTS,
  fontFitBudget,
  fontFitSlack,
  fontMeasureClass,
  LARGEST_FONT_STEP,
  measurementLooksCollapsed,
  pickFontStep,
  SMALLEST_FONT_STEP,
} from "./font-step";

export type TextareaVariant = "default" | "card" | "frameless";
export type TextareaFontScale = "fixed" | "stepped";

interface TextareaProps {
  testID?: string;
  ref?: (node: InputRef) => void;
  variant?: TextareaVariant;
  value?: string;
  placeholder?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  readonly?: boolean;
  autoFocus?: boolean;
  submitBehavior?: SubmitBehavior;
  footer?: JSX.Element;
  class?: string;
  inputClass?: string;
  /**
   * fixed (default) keeps text-sm.
   * stepped picks the largest type step whose wrapped text fits the row budget.
   */
  fontScale?: TextareaFontScale;
  /** Step used when a stepped field is created. Read once, so a remount can restore it. */
  initialFontStep?: number;
  onFontStep?: (step: number) => void;
  onChange?: (value: string) => void;
  onFocus?: () => void;
  onSubmit?: (text: string) => void;
  onCompositionChange?: (event: { composing: boolean; text: string }) => void;
}

const SURFACE_CLASSES: Record<TextareaVariant, string> = {
  default:
    "rounded-xl border border-input bg-surface-control focus-within:border-ring focus-within:bg-card focus-within:ring-2 focus-within:ring-ring",
  card: "rounded-2xl border border-border bg-card shadow-card dark:shadow-card-dark focus-within:border-ring focus-within:ring-2 focus-within:ring-ring",
  frameless: "bg-transparent",
};

const TEXT_CLASSES: Record<TextareaVariant, string> = {
  default: "text-foreground",
  card: "text-card-foreground",
  frameless: "text-foreground",
};

function FontProbe(props: {
  text: string;
  width: number;
  stepClass: string;
  weightClass: string;
  measureClass: string;
  onHeight: (height: number, measured: string) => void;
}) {
  return (
    <Text
      accessibilityElementsHidden
      class={`${props.stepClass} ${props.weightClass} ${props.measureClass}`}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: props.width,
        opacity: 0,
        pointerEvents: "none",
      }}
      onTextLayout={({ lines }) => {
        const last = lines[lines.length - 1];
        if (!last) return;
        const measured = lines.map((line) => line.text).join("");
        props.onHeight(last.bounds.origin.y + last.bounds.size.height, measured);
      }}
    >
      {props.text}
    </Text>
  );
}

export function FontProbes(props: {
  text: string;
  width: number;
  frameless: boolean;
  measureClass: string;
  onHeight: (index: number, height: number, measured: string) => void;
}) {
  const stepWeight = (index: number) => (props.frameless && index >= 2 ? "font-medium" : "");
  return (
    <View accessibilityElementsHidden style={{ position: "absolute", width: 0, height: 0 }}>
      {/* One probe per FONT_SIZE_STEPS entry; recordProbe waits until every one has a height. */}
      <FontProbe
        text={props.text}
        width={props.width}
        stepClass={FONT_SIZE_STEPS[0]}
        weightClass={stepWeight(0)}
        measureClass={props.measureClass}
        onHeight={(height, measured) => props.onHeight(0, height, measured)}
      />
      <FontProbe
        text={props.text}
        width={props.width}
        stepClass={FONT_SIZE_STEPS[1]}
        weightClass={stepWeight(1)}
        measureClass={props.measureClass}
        onHeight={(height, measured) => props.onHeight(1, height, measured)}
      />
      <FontProbe
        text={props.text}
        width={props.width}
        stepClass={FONT_SIZE_STEPS[2]}
        weightClass={stepWeight(2)}
        measureClass={props.measureClass}
        onHeight={(height, measured) => props.onHeight(2, height, measured)}
      />
      <FontProbe
        text={props.text}
        width={props.width}
        stepClass={FONT_SIZE_STEPS[3]}
        weightClass={stepWeight(3)}
        measureClass={props.measureClass}
        onHeight={(height, measured) => props.onHeight(3, height, measured)}
      />
    </View>
  );
}

/** Multi-line text field supporting an optional embedded footer toolbar row. */
export function Textarea(props: TextareaProps) {
  const variant = () => props.variant ?? "default";
  const stepped = () => (props.fontScale ?? "fixed") === "stepped";
  const sourceText = () => props.value ?? "";
  const measureClass = () => fontMeasureClass(props.inputClass);
  const contentWidth = signal(0);
  // Read once: a later remount (the collapsed preview expanding) passes the remembered step.
  const fontStep = signal(
    stepped() ? clampFontStep(props.initialFontStep ?? LARGEST_FONT_STEP) : SMALLEST_FONT_STEP,
  );
  const fontClass = () => (stepped() ? FONT_SIZE_STEPS[clampFontStep(fontStep())] : "text-sm");
  // The native field must carry the step's line height as a value, not only through its class:
  // the line height and the drawing update together when the step changes.
  const lineHeight = () =>
    stepped() && measureClass() === ""
      ? FONT_STEP_LINE_HEIGHTS[clampFontStep(fontStep())]
      : undefined;
  const fontWeightClass = () =>
    stepped() && variant() === "frameless" && clampFontStep(fontStep()) >= 2 ? "font-medium" : "";
  const showProbes = () => stepped() && contentWidth() >= 1 && sourceText().length > 0;

  let sampleKey = "";
  let sampleHeights = FONT_SIZE_STEPS.map(() => 0);
  let sampleCount = 0;
  // A field that is still too tall can lower this. Probes cannot raise it for the same text and width.
  let ceiling = LARGEST_FONT_STEP;

  const containerPadding = () => {
    if (props.footer !== undefined || variant() === "frameless") return "";
    return variant() === "card" ? "p-3" : "px-3 py-2";
  };

  effect(() => {
    if (!stepped()) return;
    if (sourceText().length === 0) {
      ceiling = LARGEST_FONT_STEP;
      sampleKey = "";
      sampleHeights = FONT_SIZE_STEPS.map(() => 0);
      sampleCount = 0;
      fontStep.set(LARGEST_FONT_STEP);
    }
  });

  effect(() => {
    if (!stepped()) return;
    props.onFontStep?.(fontStep());
  });

  function resetSample(key: string) {
    sampleKey = key;
    sampleHeights = FONT_SIZE_STEPS.map(() => 0);
    sampleCount = 0;
    ceiling = LARGEST_FONT_STEP;
  }

  function commitStep(next: number) {
    const capped = Math.min(next, ceiling);
    if (fontStep() !== capped) fontStep.set(capped);
  }

  function recordProbe(index: number, height: number, measured: string) {
    if (!stepped() || height <= 0) return;
    const text = sourceText();
    const width = contentWidth();
    if (text.length === 0 || width < 1) return;
    if (comparableMeasureText(measured) !== comparableMeasureText(text)) return;
    if (measurementLooksCollapsed(text, width, height, index)) return;
    const scale = fontScale();
    const key = `${Math.round(width)}:${scale}:${text}`;
    if (key !== sampleKey) resetSample(key);
    if (sampleHeights[index] === 0) sampleCount += 1;
    sampleHeights[index] = height;
    if (sampleCount < FONT_SIZE_STEPS.length) return;
    commitStep(pickFontStep(sampleHeights, fontFitBudget(scale), fontFitSlack(scale)));
  }

  function correctFromField(height: number) {
    if (!stepped() || height <= 0) return;
    const text = sourceText();
    const width = contentWidth();
    if (text.length === 0 || width < 1) return;
    const scale = fontScale();
    const limit = fontFitBudget(scale) + fontFitSlack(scale);
    const step = clampFontStep(fontStep());
    if (height <= limit || step <= SMALLEST_FONT_STEP) return;
    const key = `${Math.round(width)}:${scale}:${text}`;
    const probed = key === sampleKey ? (sampleHeights[step] ?? 0) : 0;
    const fontSize = FONT_STEP_POINTS[step] ?? 16;
    if (!fieldShouldStepDown(height, probed, limit, step, fontSize)) return;
    if (key !== sampleKey) resetSample(key);
    ceiling = step - 1;
    commitStep(ceiling);
  }

  return (
    <View
      class={`${SURFACE_CLASSES[variant()]} ${containerPadding()} ${props.disabled || props.readonly ? "opacity-60" : ""} ${motion.navigationFeedback} ${props.class ?? ""}`}
    >
      {/* Keep NSH's measured text overflow out of any enclosing Scroll. */}
      <View
        class={`overflow-hidden ${variant() === "frameless" || props.footer === undefined ? "w-full" : "px-3 pt-2"}`}
      >
        <BaseInput
          testID={props.testID}
          ref={(node) => props.ref?.(node)}
          value={props.value}
          placeholder={props.placeholder}
          accessibilityLabel={props.accessibilityLabel}
          multiline
          autoFocus={props.autoFocus}
          submitBehavior={props.submitBehavior ?? "newline"}
          disabled={props.disabled}
          // A disabled field takes no edits either: platforms keep text fields editable.
          readonly={props.readonly || props.disabled}
          onChange={({ value }) => props.onChange?.(value)}
          onFocus={() => props.onFocus?.()}
          onSubmit={({ text }) => props.onSubmit?.(text)}
          onCompositionChange={(event) => props.onCompositionChange?.(event)}
          onContentSizeChange={({ size }) => correctFromField(size.height)}
          onLayout={({ bounds }) => {
            if (!stepped()) return;
            const next = bounds.size.width;
            if (next < 1 || Math.abs(next - contentWidth()) < 1) return;
            contentWidth.set(next);
          }}
          style={lineHeight() === undefined ? undefined : { lineHeight: lineHeight() }}
          class={`min-h-24 w-full bg-transparent ${fontClass()} ${fontWeightClass()} placeholder:text-muted-foreground ${TEXT_CLASSES[variant()]} ${props.inputClass ?? ""}`}
        />
      </View>
      <If when={props.footer !== undefined}>
        <View class="px-1.5 pb-1.5">{props.footer}</View>
      </If>
      <If when={showProbes()}>
        <FontProbes
          text={sourceText()}
          width={contentWidth()}
          frameless={variant() === "frameless"}
          measureClass={measureClass()}
          onHeight={(index, height, measured) => recordProbe(index, height, measured)}
        />
      </If>
    </View>
  );
}
