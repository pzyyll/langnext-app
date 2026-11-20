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
  fontFitBudget,
  fontFitSlack,
  fontMeasureClass,
  LARGEST_FONT_STEP,
  pickFontStep,
  SMALLEST_FONT_STEP,
  usesNaturalLineHeight,
} from "./font-step";

export type TextareaVariant = "default" | "card";
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
  default: "rounded-lg border border-input bg-background",
  card: "rounded-xl border border-border bg-card",
};

const TEXT_CLASSES: Record<TextareaVariant, string> = {
  default: "text-foreground",
  card: "text-card-foreground",
};

function FontProbe(props: {
  text: string;
  width: number;
  stepClass: string;
  measureClass: string;
  naturalLineHeight: boolean;
  onHeight: (height: number) => void;
}) {
  return (
    <Text
      accessibilityElementsHidden
      class={`${props.stepClass} ${props.measureClass}`}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: props.width,
        ...(props.naturalLineHeight ? { lineHeight: 0 } : {}),
      }}
      onLayout={({ bounds }) => props.onHeight(bounds.size.height)}
    >
      {props.text}
    </Text>
  );
}

function FontProbes(props: {
  text: string;
  width: number;
  measureClass: string;
  naturalLineHeight: boolean;
  onHeight: (index: number, height: number) => void;
}) {
  return (
    <View
      accessibilityElementsHidden
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        overflow: "hidden",
        opacity: 0,
        pointerEvents: "none",
      }}
    >
      {/* One probe per FONT_SIZE_STEPS entry; recordProbe waits until every one has a height. */}
      <FontProbe
        text={props.text}
        width={props.width}
        stepClass={FONT_SIZE_STEPS[0]}
        measureClass={props.measureClass}
        naturalLineHeight={props.naturalLineHeight}
        onHeight={(height) => props.onHeight(0, height)}
      />
      <FontProbe
        text={props.text}
        width={props.width}
        stepClass={FONT_SIZE_STEPS[1]}
        measureClass={props.measureClass}
        naturalLineHeight={props.naturalLineHeight}
        onHeight={(height) => props.onHeight(1, height)}
      />
      <FontProbe
        text={props.text}
        width={props.width}
        stepClass={FONT_SIZE_STEPS[2]}
        measureClass={props.measureClass}
        naturalLineHeight={props.naturalLineHeight}
        onHeight={(height) => props.onHeight(2, height)}
      />
      <FontProbe
        text={props.text}
        width={props.width}
        stepClass={FONT_SIZE_STEPS[3]}
        measureClass={props.measureClass}
        naturalLineHeight={props.naturalLineHeight}
        onHeight={(height) => props.onHeight(3, height)}
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
  const naturalLineHeight = () => usesNaturalLineHeight(props.inputClass);
  const contentWidth = signal(0);
  // Read once: a later remount (the collapsed preview expanding) passes the remembered step.
  const fontStep = signal(
    stepped() ? clampFontStep(props.initialFontStep ?? LARGEST_FONT_STEP) : SMALLEST_FONT_STEP,
  );
  const fontClass = () => (stepped() ? FONT_SIZE_STEPS[clampFontStep(fontStep())] : "text-sm");
  const showProbes = () => stepped() && contentWidth() >= 1 && sourceText().length > 0;

  let sampleKey = "";
  let sampleHeights = FONT_SIZE_STEPS.map(() => 0);
  let sampleCount = 0;

  const containerPadding = () => {
    if (props.footer !== undefined) return "";
    return variant() === "card" ? "p-3" : "px-3 py-2";
  };

  effect(() => {
    if (!stepped()) return;
    if (sourceText().length === 0) fontStep.set(LARGEST_FONT_STEP);
  });

  effect(() => {
    if (!stepped()) return;
    props.onFontStep?.(fontStep());
  });

  function recordProbe(index: number, height: number) {
    if (!stepped() || height <= 0) return;
    const text = sourceText();
    const width = contentWidth();
    if (text.length === 0 || width < 1) return;
    const scale = fontScale();
    const key = `${Math.round(width)}:${scale}:${text}`;
    if (key !== sampleKey) {
      sampleKey = key;
      sampleHeights = FONT_SIZE_STEPS.map(() => 0);
      sampleCount = 0;
    }
    if (sampleHeights[index] === 0) sampleCount += 1;
    sampleHeights[index] = height;
    if (sampleCount < FONT_SIZE_STEPS.length) return;
    const next = pickFontStep(sampleHeights, fontFitBudget(scale), fontFitSlack(scale));
    if (fontStep() !== next) fontStep.set(next);
  }

  return (
    <View
      class={`${SURFACE_CLASSES[variant()]} focus-within:border-ring focus-within:ring-2 focus-within:ring-ring ${containerPadding()} ${props.disabled || props.readonly ? "opacity-60" : ""} ${motion.navigationFeedback} ${props.class ?? ""}`}
    >
      {/* Keep NSH's measured text overflow out of any enclosing Scroll. */}
      <View class={`overflow-hidden ${props.footer === undefined ? "w-full" : "px-3 pt-2"}`}>
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
          readonly={props.readonly}
          onChange={({ value }) => props.onChange?.(value)}
          onFocus={() => props.onFocus?.()}
          onSubmit={({ text }) => props.onSubmit?.(text)}
          onCompositionChange={(event) => props.onCompositionChange?.(event)}
          onLayout={({ bounds }) => {
            if (!stepped()) return;
            const next = bounds.size.width;
            if (next < 1 || Math.abs(next - contentWidth()) < 1) return;
            contentWidth.set(next);
          }}
          style={naturalLineHeight() ? { lineHeight: 0 } : undefined}
          class={`min-h-24 w-full bg-transparent ${fontClass()} placeholder:text-muted-foreground ${TEXT_CLASSES[variant()]} ${props.inputClass ?? ""}`}
        />
      </View>
      <If when={props.footer !== undefined}>
        <View class="px-1.5 pb-1.5">{props.footer}</View>
      </If>
      <If when={showProbes()}>
        <FontProbes
          text={sourceText()}
          width={contentWidth()}
          measureClass={measureClass()}
          naturalLineHeight={naturalLineHeight()}
          onHeight={(index, height) => recordProbe(index, height)}
        />
      </If>
    </View>
  );
}
