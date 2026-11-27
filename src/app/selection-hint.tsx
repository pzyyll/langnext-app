import { cleanup, effect, signal, View, type Accessor, type Point } from "nsh";
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

/** How long one hint stays available after the release that showed it, while the pointer is away. */
export const SELECTION_HINT_DURATION_MS = 3_000;

/** The hint window's fixed size in points: one icon button, placed before it opens. */
export const SELECTION_HINT_SIZE = { width: 40, height: 40 } as const;

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
  onTranslate: (target: string) => void;
  onDismiss: () => void;
}

/**
 * One temporary Translate Selection icon beside a possible text drag.
 *
 * It never takes the focus, so the selection stays with the application that owns it. It reads
 * nothing: a click hands the captured target to the Quick Translate controller. The icon alone
 * shows the action; its accessible name carries the rest. The pointer resting on it holds it open.
 */
export function SelectionHintWindow(props: SelectionHintWindowProps) {
  const attached = signal<WindowRef | null>(null);
  const hovering = signal(false);
  const label = () => t("settings.shortcuts.selectionTranslate");

  // A new candidate moves an already open hint and gives it a fresh lifetime: the pointer must
  // come to rest on it again before it holds the hint open.
  effect(() => {
    const candidate = props.hint();
    hovering.set(false);
    if (candidate === null) return;
    const win = attached();
    if (win?.state()?.visible === true) win.setBounds({ origin: candidate.origin });
  });

  // The countdown runs only while the pointer is away, so the hint stays while the pointer rests
  // on it and the reader can look before clicking.
  effect(() => {
    if (props.hint() === null || hovering()) return;
    const timer = setTimeout(() => props.onDismiss(), SELECTION_HINT_DURATION_MS);
    cleanup(() => clearTimeout(timer));
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
      <View
        class="flex-1"
        onMouseEnter={() => hovering.set(true)}
        onMouseMove={() => hovering.set(true)}
        onMouseLeave={() => hovering.set(false)}
      >
        <Button
          testID="selection-hint-translate"
          size="icon"
          variant="ghost"
          class="size-full rounded-xl border border-border bg-background shadow-lg"
          accessibilityLabel={label()}
          onPress={() => {
            const candidate = props.hint();
            if (candidate === null) return;
            props.onTranslate(candidate.target);
            props.onDismiss();
          }}
        >
          <Icon name="mdi:translate" tone="brand" class="size-4 shrink-0" />
        </Button>
      </View>
    </Window>
  );
}
