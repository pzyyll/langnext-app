import { cleanup, effect, signal, Text, View, type Accessor, type Point } from "nsh";
import { displays, Window, type DisplayId, type WindowRef } from "nsh/desktop";
import { t } from "nsh/i18n";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import {
  boundsContainPoint,
  resolveAnchoredDisplayPoint,
  type PointerPressPoint,
} from "../platform/quick-translate";

/** The hint is its own native window so it never joins Quick Translate's layout. */
export const SELECTION_HINT_WINDOW_ID = "selection-hint";

/** How long one hint stays available after the release that showed it. */
export const SELECTION_HINT_DURATION_MS = 3_000;

/** The hint window's fixed size in points: one small action, placed before it opens. */
export const SELECTION_HINT_SIZE = { width: 232, height: 40 } as const;

/** One drag release the hint offers to translate, and the target it captured. */
export interface SelectionHintCandidate {
  /** The release, kept for the button's alternative placement checks. */
  release: PointerPressPoint;
  /** The opaque foreground target, read only after a click. */
  target: string;
  display: DisplayId;
  origin: Point;
}

export interface SelectionHintWindowProps {
  /** The one candidate to show; null hides the window. */
  hint: Accessor<SelectionHintCandidate | null>;
  /** The newest global press, used to dismiss a hint the press landed outside of. */
  press: Accessor<PointerPressPoint | null>;
  /** The configured Translate Selection shortcut, shown as the keyboard alternative. */
  shortcut: Accessor<string | null>;
  onTranslate: (target: string) => void;
  onDismiss: () => void;
}

/**
 * One temporary Translate Selection button beside a possible text drag.
 *
 * It never takes the focus, so the selection stays with the application that owns it. It reads
 * nothing: a click hands the captured target to the Quick Translate controller.
 */
export function SelectionHintWindow(props: SelectionHintWindowProps) {
  const attached = signal<WindowRef | null>(null);
  const label = () => t("settings.shortcuts.selectionTranslate");

  // A new candidate moves an already open hint and restarts its lifetime.
  effect(() => {
    const candidate = props.hint();
    if (candidate === null) return;
    const timer = setTimeout(() => props.onDismiss(), SELECTION_HINT_DURATION_MS);
    cleanup(() => clearTimeout(timer));
    const win = attached();
    if (win?.state()?.visible === true) win.setBounds({ origin: candidate.origin });
  });

  // A press anywhere else dismisses it; a press on the hint is the click that translates.
  effect(() => {
    const press = props.press();
    if (press === null) return;
    const state = attached()?.state();
    if (state?.visible !== true) return;
    const resolved = resolveAnchoredDisplayPoint(press, displays());
    if (!resolved || !boundsContainPoint(state.bounds, resolved.point)) props.onDismiss();
  });

  return (
    <Window
      id={SELECTION_HINT_WINDOW_ID}
      open={props.hint() !== null}
      title={label()}
      kind="panel"
      frame="none"
      transparent={true}
      level="floating"
      taskbar={false}
      resizable={false}
      minimizable={false}
      maximizable={false}
      closable={true}
      focusable={false}
      activate={false}
      pointerEvents="auto"
      backdrop="none"
      shadow={false}
      defaultSize={SELECTION_HINT_SIZE}
      display={props.hint()?.display}
      defaultPosition={props.hint()?.origin}
      closeOnPress={true}
      closeOnBlur={false}
      closeOnEscape={true}
      onOpenChange={({ open }) => {
        if (!open) props.onDismiss();
      }}
      ref={(node) => attached.set(node)}
    >
      <View class="flex-1 flex-row items-center rounded-xl border border-border bg-background p-0.5 shadow-lg">
        <Button
          testID="selection-hint-translate"
          size="sm"
          variant="ghost"
          class="flex-1 justify-start"
          accessibilityLabel={label()}
          onPress={() => {
            const candidate = props.hint();
            if (candidate === null) return;
            props.onTranslate(candidate.target);
            props.onDismiss();
          }}
        >
          <Icon name="mdi:translate" tone="brand" class="size-3.5 shrink-0" />
          <Text class="min-w-0 flex-1 truncate font-medium text-foreground">{label()}</Text>
          <If when={props.shortcut() !== null}>
            <Text class="shrink-0 text-muted-foreground">{props.shortcut() ?? ""}</Text>
          </If>
        </Button>
      </View>
    </Window>
  );
}
