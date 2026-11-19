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
  resolvePopupPlacement,
  type CursorAnchorPoint,
  type ResolvedPopupPlacement,
} from "../platform/quick-translate";

export const QUICK_TRANSLATE_WINDOW_ID = "quick-translate";
export const QUICK_TRANSLATE_SHORTCUT = "ctrl+shift+t";

export const POPUP_DEFAULT_SIZE = { width: 420, height: 360 } as const;
export const POPUP_MIN_SIZE = { width: 340, height: 280 } as const;

export type QuickTranslateShortcutBinding = Pick<GlobalShortcutModule, "register" | "unregister">;

export interface QuickTranslateControllerOptions {
  readCursorAnchor?: () => CursorAnchorPoint | null;
  getDisplays?: () => readonly Display[];
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
  open: () => void;
  close: () => void;
  setPinned: (pinned: boolean) => void;
  togglePinned: () => void;
  toggleAutoTranslate: () => void;
  setSourceText: (text: string) => void;
  setMenuOpen: (menuId: string, open: boolean) => void;
  hasOpenOverlay: () => boolean;
  attachWindow: (win: WindowRef | null) => void;
  attachSourceInput: (input: InputRef | null) => void;
  verifyInitialBounds: (state: WindowState) => void;
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

  const openSignal = signal(false);
  const pinnedSignal = signal(false);
  const autoTranslateSignal = signal(false);
  const placementSignal = signal<ResolvedPopupPlacement>({
    kind: "center",
    size: POPUP_DEFAULT_SIZE,
  });
  const attachedWindowSignal = signal<WindowRef | null>(null);
  const sourceSignal = signal("");
  const openMenusSignal = signal<Record<string, boolean>>({});
  let windowRef: WindowRef | null = null;
  let sourceInputRef: InputRef | null = null;
  let closeCleanup: (() => void) | null = null;
  let needsBoundsCheck = false;
  let userMovedSinceOpen = false;
  let expectingOwnSetBounds = false;

  const focusWindowAndInput = () => {
    (windowRef ?? Window.get(QUICK_TRANSLATE_WINDOW_ID))?.focus();
    sourceInputRef?.focus();
  };

  const close = () => {
    const hadState =
      openSignal() ||
      pinnedSignal() ||
      sourceSignal() !== "" ||
      Object.keys(openMenusSignal()).length > 0;
    if (!hadState && windowRef === null) {
      return;
    }
    openSignal.set(false);
    pinnedSignal.set(false);
    sourceSignal.set("");
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
    autoTranslate: () => autoTranslateSignal(),
    openingDisplay: () => placementSignal().display,
    openingPosition: () => {
      const current = placementSignal();
      return current.kind === "cursor" ? current.bounds.origin : "center";
    },
    openingSize: () => {
      const current = placementSignal();
      return current.kind === "cursor" ? current.bounds.size : current.size;
    },
    attachedWindow: () => attachedWindowSignal(),
    sourceText: () => sourceSignal(),
    open,
    close,
    setPinned: (pinned: boolean) => pinnedSignal.set(pinned),
    togglePinned: () => pinnedSignal.set(!pinnedSignal()),
    toggleAutoTranslate: () => autoTranslateSignal.set(!autoTranslateSignal()),
    setSourceText: (text: string) => sourceSignal.set(text),
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
    handleBoundsChange,
    setOnCloseCleanup: (callback: (() => void) | null) => {
      closeCleanup = callback;
    },
  };
}
