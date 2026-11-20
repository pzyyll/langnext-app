import { signal, type Accessor, type Bounds, type InputRef, type Point, type Size } from "nsh";
import {
  displays,
  Window,
  type Display,
  type DisplayId,
  type GlobalShortcutModule,
  type WindowRef,
  type WindowState,
} from "nsh/desktop";
import {
  resolvePopupContentFit,
  resolvePopupPlacement,
  type CursorAnchorPoint,
  type DoubleCopyActivationEvent,
  type ResolvedPopupPlacement,
} from "../platform/quick-translate";

export const QUICK_TRANSLATE_WINDOW_ID = "quick-translate";
export const QUICK_TRANSLATE_SHORTCUT = "ctrl+shift+t";

export const POPUP_DEFAULT_SIZE = { width: 420, height: 360 } as const;
export const POPUP_MIN_SIZE = { width: 340, height: 120 } as const;

export type QuickTranslateShortcutBinding = Pick<GlobalShortcutModule, "register" | "unregister">;

export interface QuickTranslateControllerOptions {
  readCursorAnchor?: () => CursorAnchorPoint | null;
  getDisplays?: () => readonly Display[];
  readClipboardText?: () => Promise<string>;
  isDoubleCopyActive?: () => boolean;
  autoTranslate?: Accessor<boolean>;
  onToggleAutoTranslate?: () => void;
}

export interface QuickTranslateController {
  isOpen: Accessor<boolean>;
  isPinned: Accessor<boolean>;
  autoTranslate: Accessor<boolean>;
  openingDisplay: Accessor<DisplayId | undefined>;
  openingPosition: Accessor<Point | "center">;
  openingSize: Accessor<Size>;
  attachedWindow: Accessor<WindowRef | null>;
  sourceText: Accessor<string>;
  sourceDeliverySeq: Accessor<number>;
  open: () => void;
  close: () => void;
  activateDoubleCopy: (event: DoubleCopyActivationEvent) => Promise<void>;
  setPinned: (pinned: boolean) => void;
  togglePinned: () => void;
  toggleAutoTranslate: () => void;
  setSourceText: (text: string) => void;
  setMenuOpen: (menuId: string, open: boolean) => void;
  hasOpenOverlay: () => boolean;
  attachWindow: (win: WindowRef | null) => void;
  attachSourceInput: (input: InputRef | null) => void;
  verifyInitialBounds: (state: WindowState) => void;
  fitContentHeight: (height: number) => void;
  handleBoundsChange: (bounds: Bounds) => void;
  setOnCloseCleanup: (callback: (() => void) | null) => void;
}

/** Only Windows registers the global Quick Translate shortcut. */
export function canRegisterGlobalQuickTranslateShortcut(os: string): boolean {
  return os === "windows";
}

function resolveMainWindowDisplay(allDisplays: readonly Display[]): DisplayId | undefined {
  const mainDisplay = Window.get("main")?.state()?.display;
  if (mainDisplay) {
    return mainDisplay.id;
  }
  return allDisplays.find((entry) => entry.primary)?.id ?? allDisplays[0]?.id;
}

/** Owns Quick Translate window open/focus reuse, pin state, overlay tracking, and single-path cleanup. */
export function createQuickTranslateController(
  options: QuickTranslateControllerOptions = {},
): QuickTranslateController {
  const getAnchor = options.readCursorAnchor ?? (() => null);
  const getDisplaysList = options.getDisplays ?? displays;
  const readClipboard = options.readClipboardText ?? (async () => "");
  const isDoubleCopyEnabledFn = options.isDoubleCopyActive ?? (() => false);

  const openSignal = signal(false);
  const pinnedSignal = signal(false);
  const autoTranslateSignal = signal(false);
  const placementSignal = signal<ResolvedPopupPlacement>({
    kind: "center",
    size: POPUP_DEFAULT_SIZE,
  });
  const attachedWindowSignal = signal<WindowRef | null>(null);
  const sourceSignal = signal("");
  const clipboardDeliverySeqSignal = signal(0);
  const openMenusSignal = signal<Record<string, boolean>>({});
  let windowRef: WindowRef | null = null;
  let sourceInputRef: InputRef | null = null;
  let closeCleanup: (() => void) | null = null;
  let needsBoundsCheck = false;
  let userMovedSinceOpen = false;
  let expectingOwnSetBounds = false;
  let openGen = 0;
  let draftGen = 0;

  const focusWindowAndInput = () => {
    (windowRef ?? Window.get(QUICK_TRANSLATE_WINDOW_ID))?.focus();
    sourceInputRef?.focus();
  };

  const close = () => {
    const hadState =
      openSignal() ||
      pinnedSignal() ||
      sourceSignal() !== "" ||
      clipboardDeliverySeqSignal() !== 0 ||
      Object.keys(openMenusSignal()).length > 0;
    if (!hadState && windowRef === null) {
      return;
    }
    openGen += 1;
    draftGen += 1;
    openSignal.set(false);
    pinnedSignal.set(false);
    sourceSignal.set("");
    clipboardDeliverySeqSignal.set(0);
    openMenusSignal.set({});
    windowRef = null;
    attachedWindowSignal.set(null);
    sourceInputRef = null;
    needsBoundsCheck = false;
    userMovedSinceOpen = false;
    expectingOwnSetBounds = false;
    closeCleanup?.();
  };

  const open = () => {
    if (openSignal()) {
      focusWindowAndInput();
      return;
    }
    const availableDisplays = getDisplaysList();
    const placement = resolvePopupPlacement(
      getAnchor(),
      availableDisplays,
      POPUP_DEFAULT_SIZE,
      resolveMainWindowDisplay(availableDisplays),
    );
    needsBoundsCheck = placement.kind === "cursor";
    userMovedSinceOpen = false;
    expectingOwnSetBounds = false;
    placementSignal.set(placement);
    openSignal.set(true);
  };

  const activateDoubleCopy = async (event: DoubleCopyActivationEvent): Promise<void> => {
    if (!isDoubleCopyEnabledFn()) {
      return;
    }
    open();
    const capturedOpenGen = openGen;
    draftGen += 1;
    const capturedDraftGen = draftGen;

    if (!event.hasValidCopy) {
      return;
    }

    let copiedText: string;
    try {
      copiedText = await readClipboard();
    } catch {
      return;
    }

    if (capturedOpenGen !== openGen || capturedDraftGen !== draftGen) {
      return;
    }
    if (typeof copiedText !== "string" || copiedText.trim().length === 0) {
      return;
    }

    sourceSignal.set(copiedText);
    clipboardDeliverySeqSignal.set(clipboardDeliverySeqSignal() + 1);
  };

  const verifyInitialBounds = (state: WindowState) => {
    if (!needsBoundsCheck || userMovedSinceOpen) {
      return;
    }
    needsBoundsCheck = false;
    const currentPlacement = placementSignal();
    if (currentPlacement.kind !== "cursor") {
      return;
    }
    const target = currentPlacement.bounds;
    const originShifted =
      Math.abs(state.bounds.origin.x - target.origin.x) > 2 ||
      Math.abs(state.bounds.origin.y - target.origin.y) > 2;
    const sizeShifted =
      Math.abs(state.contentBounds.size.width - target.size.width) > 2 ||
      Math.abs(state.contentBounds.size.height - target.size.height) > 2;
    if (!originShifted && !sizeShifted) {
      return;
    }
    const win = windowRef ?? Window.get(QUICK_TRANSLATE_WINDOW_ID);
    if (!win) {
      return;
    }
    expectingOwnSetBounds = true;
    win.setBounds({
      origin: target.origin,
      ...(sizeShifted ? { size: target.size } : {}),
    });
  };

  const openingSize = () => {
    const current = placementSignal();
    return current.kind === "cursor" ? current.bounds.size : current.size;
  };

  const fitContentHeight = (height: number) => {
    if (!openSignal()) return;
    const win = windowRef;
    const state = win?.state();
    if (!win || !state?.visible || state.mode !== "normal") return;
    const minHeight = Math.min(POPUP_MIN_SIZE.height, openingSize().height);
    const fit = resolvePopupContentFit(state, height, minHeight);
    if (fit) win.setBounds(fit);
  };

  const handleBoundsChange = (_bounds: Bounds) => {
    if (expectingOwnSetBounds) {
      expectingOwnSetBounds = false;
      return;
    }
    userMovedSinceOpen = true;
    needsBoundsCheck = false;
  };

  return {
    isOpen: () => openSignal(),
    isPinned: () => pinnedSignal(),
    openingDisplay: () => placementSignal().display,
    openingPosition: () => {
      const current = placementSignal();
      return current.kind === "cursor" ? current.bounds.origin : "center";
    },
    openingSize,
    attachedWindow: () => attachedWindowSignal(),
    sourceText: () => sourceSignal(),
    sourceDeliverySeq: () => clipboardDeliverySeqSignal(),
    autoTranslate: options.autoTranslate ?? (() => autoTranslateSignal()),
    open,
    close,
    activateDoubleCopy,
    setPinned: (pinned: boolean) => pinnedSignal.set(pinned),
    togglePinned: () => pinnedSignal.set(!pinnedSignal()),
    toggleAutoTranslate: options.onToggleAutoTranslate
      ? options.onToggleAutoTranslate
      : () => autoTranslateSignal.set(!autoTranslateSignal()),
    setSourceText: (text: string) => {
      if (text === sourceSignal()) {
        return;
      }
      draftGen += 1;
      sourceSignal.set(text);
    },
    setMenuOpen: (menuId: string, openMenu: boolean) => {
      const current = openMenusSignal();
      if (openMenu) {
        if (current[menuId]) return;
        openMenusSignal.set({ ...current, [menuId]: true });
        return;
      }
      if (!current[menuId]) return;
      const next = { ...current };
      delete next[menuId];
      openMenusSignal.set(next);
    },
    hasOpenOverlay: () => Object.values(openMenusSignal()).some(Boolean),
    attachWindow: (win: WindowRef | null) => {
      windowRef = win;
      attachedWindowSignal.set(win);
    },
    attachSourceInput: (input: InputRef | null) => {
      sourceInputRef = input;
      input?.focus();
    },
    verifyInitialBounds,
    fitContentHeight,
    handleBoundsChange,
    setOnCloseCleanup: (callback: (() => void) | null) => {
      closeCleanup = callback;
    },
  };
}
