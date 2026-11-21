import {
  batch,
  signal,
  type Accessor,
  type Bounds,
  type InputRef,
  type Point,
  type Size,
} from "nsh";
import { t } from "nsh/i18n";
import {
  displays,
  Window,
  type Display,
  type DisplayId,
  type WindowRef,
  type WindowState,
} from "nsh/desktop";
import { checkOcrReadiness, recognizeScreenshot } from "../features/ocr/recognize";
import { ocrSettingsStore } from "../features/ocr/settings";
import type { SourceDelivery, SourceDeliveryKind } from "../features/quick-translate/session";
import type { ScreenCaptureOverlayConfig, ScreenCapturePort } from "../platform/screen-capture";
import {
  boundsContainPoint,
  resolveAnchoredDisplayPoint,
  resolvePopupContentFit,
  resolvePopupPlacement,
  type CursorAnchorPoint,
  type DoubleCopyActivationEvent,
  type PointerPressPoint,
  type ResolvedPopupPlacement,
} from "../platform/quick-translate";

export const QUICK_TRANSLATE_WINDOW_ID = "quick-translate";

export const POPUP_DEFAULT_SIZE = { width: 420, height: 360 } as const;
export const POPUP_MIN_SIZE = { width: 340, height: 120 } as const;

/** Longest time the OCR action waits for its own window to report itself hidden. */
const HIDE_TIMEOUT_MS = 1_000;
/** Interval between hidden checks; NSH reports the new value on its own schedule. */
const HIDE_POLL_MS = 16;

/** Theme colors the native selection overlay paints with. */
export interface CaptureOverlayTheme {
  accentColor: string;
  textColor: string;
  backdropColor: string;
}

/** What the OCR action is doing now, plus any inline message it shows. */
export interface QuickTranslateOcrState {
  /** `selecting` covers the native overlay; `recognizing` covers the model request. */
  phase: "idle" | "selecting" | "recognizing";
  /** Localized alert to show in the source input's bottom-left toolbar; null hides it. */
  message: string | null;
}

export interface QuickTranslateControllerOptions {
  readCursorAnchor?: () => CursorAnchorPoint | null;
  getDisplays?: () => readonly Display[];
  readClipboardText?: () => Promise<string>;
  isDoubleCopyActive?: () => boolean;
  onPointerPress?: (listener: (event: PointerPressPoint) => void) => () => void;
  autoTranslate?: Accessor<boolean>;
  onToggleAutoTranslate?: () => void;
  /** OS capture boundary; the production port is native, and the test harness injects one. */
  captureRegion?: ScreenCapturePort["capture"];
  /** Theme colors for the native overlay; the desktop entry point supplies the tokens. */
  captureOverlayTheme?: () => CaptureOverlayTheme;
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
  sourceDelivery: Accessor<SourceDelivery | null>;
  ocrState: Accessor<QuickTranslateOcrState>;
  /** Bumps whenever the OCR action should take the keyboard focus back. */
  ocrFocusSeq: Accessor<number>;
  /** Blur, Escape, and outside-press dismissal stay off while the selection runs. */
  dismissalSuspended: Accessor<boolean>;
  open: () => void;
  close: () => void;
  activateDoubleCopy: (event: DoubleCopyActivationEvent) => Promise<void>;
  startOcr: () => Promise<void>;
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

function resolveMainWindowDisplay(allDisplays: readonly Display[]): DisplayId | undefined {
  const mainDisplay = Window.get("main")?.state()?.display;
  if (mainDisplay) {
    return mainDisplay.id;
  }
  return allDisplays.find((entry) => entry.primary)?.id ?? allDisplays[0]?.id;
}

const IDLE_OCR_STATE: QuickTranslateOcrState = { phase: "idle", message: null };

/** Owns Quick Translate window open/focus reuse, pin state, overlay tracking, and single-path cleanup. */
export function createQuickTranslateController(
  options: QuickTranslateControllerOptions = {},
): QuickTranslateController {
  const getAnchor = options.readCursorAnchor ?? (() => null);
  const getDisplaysList = options.getDisplays ?? displays;
  const readClipboard = options.readClipboardText ?? (async () => "");
  const isDoubleCopyEnabledFn = options.isDoubleCopyActive ?? (() => false);
  const onPointerPress = options.onPointerPress ?? (() => () => {});
  const captureRegion = options.captureRegion;
  const captureOverlayTheme =
    options.captureOverlayTheme ??
    ((): CaptureOverlayTheme => ({
      accentColor: "#ffffff",
      textColor: "#000000",
      backdropColor: "#ffffff",
    }));

  const openSignal = signal(false);
  const pinnedSignal = signal(false);
  const autoTranslateSignal = signal(false);
  const placementSignal = signal<ResolvedPopupPlacement>({
    kind: "center",
    size: POPUP_DEFAULT_SIZE,
  });
  const attachedWindowSignal = signal<WindowRef | null>(null);
  const sourceSignal = signal("");
  const sourceDeliverySignal = signal<SourceDelivery | null>(null);
  const ocrStateSignal = signal<QuickTranslateOcrState>(IDLE_OCR_STATE);
  const ocrFocusSeqSignal = signal(0);
  const openMenusSignal = signal<Record<string, boolean>>({});
  let windowRef: WindowRef | null = null;
  let sourceInputRef: InputRef | null = null;
  let closeCleanup: (() => void) | null = null;
  let stopPressMonitor: (() => void) | null = null;
  let needsBoundsCheck = false;
  let userMovedSinceOpen = false;
  let expectingOwnSetBounds = false;
  let openGen = 0;
  let draftGen = 0;
  let clipboardReadGen = 0;
  let lastDeliverySeq = 0;
  let ocrRunGen = 0;
  let ocrActive = false;
  let ocrAbort: AbortController | null = null;

  const focusWindowAndInput = () => {
    (windowRef ?? Window.get(QUICK_TRANSLATE_WINDOW_ID))?.focus();
    sourceInputRef?.focus();
  };

  const isSelecting = () => ocrStateSignal().phase === "selecting";
  const setOcrMessage = (message: string | null) => {
    ocrStateSignal.set({ phase: "idle", message });
  };

  /** Ends the running OCR request; late results see the older generation and drop. */
  const cancelOcr = () => {
    ocrRunGen += 1;
    ocrAbort?.abort();
    ocrAbort = null;
    ocrActive = false;
    ocrStateSignal.set(IDLE_OCR_STATE);
  };

  const close = () => {
    const hadState =
      openSignal() ||
      pinnedSignal() ||
      sourceSignal() !== "" ||
      sourceDeliverySignal() !== null ||
      Object.keys(openMenusSignal()).length > 0;
    if (!hadState && windowRef === null) {
      return;
    }
    cancelOcr();
    openGen += 1;
    draftGen += 1;
    openSignal.set(false);
    pinnedSignal.set(false);
    sourceSignal.set("");
    sourceDeliverySignal.set(null);
    openMenusSignal.set({});
    windowRef = null;
    attachedWindowSignal.set(null);
    sourceInputRef = null;
    needsBoundsCheck = false;
    userMovedSinceOpen = false;
    expectingOwnSetBounds = false;
    closeCleanup?.();
    stopPressMonitor?.();
    stopPressMonitor = null;
  };

  const hasOpenOverlay = () => Object.values(openMenusSignal()).some(Boolean);

  /**
   * Closes the unpinned popup when a global press lands outside it: the press never reached the
   * window, so neither `closeOnBlur` nor the in-window overlays hear it.
   */
  const handlePointerPress = (press: PointerPressPoint) => {
    // The selection surface is a separate native window; its presses are not dismissals.
    if (ocrStateSignal().phase !== "idle") {
      return;
    }
    if (!openSignal() || pinnedSignal()) {
      return;
    }
    const state = (windowRef ?? Window.get(QUICK_TRANSLATE_WINDOW_ID))?.state();
    if (!state?.visible) {
      return;
    }
    const target = resolveAnchoredDisplayPoint(press, getDisplaysList());
    if (!target || boundsContainPoint(state.bounds, target.point)) {
      return;
    }
    close();
  };

  const startPressMonitor = () => {
    if (stopPressMonitor) {
      return;
    }
    try {
      stopPressMonitor = onPointerPress(handlePointerPress);
    } catch {
      // Without the monitor, dismissal falls back to the window's own blur handling.
      stopPressMonitor = null;
    }
  };

  const open = () => {
    // While the screen selection runs, a shortcut or copy must not pull the popup forward.
    if (isSelecting()) {
      return;
    }
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
    startPressMonitor();
  };

  /** Replaces the draft with one delivered text and bumps the single delivery sequence. */
  const deliverSource = (text: string, kind: SourceDeliveryKind) => {
    const seq = lastDeliverySeq + 1;
    lastDeliverySeq = seq;
    draftGen += 1;
    batch(() => {
      sourceSignal.set(text);
      sourceDeliverySignal.set({ kind, seq });
    });
  };

  const activateDoubleCopy = async (event: DoubleCopyActivationEvent): Promise<void> => {
    if (!isDoubleCopyEnabledFn()) {
      return;
    }
    // Copied text cannot interrupt the native selection surface.
    if (isSelecting()) {
      return;
    }
    open();
    const capturedOpenGen = openGen;
    const capturedDraftGen = draftGen;
    const readGen = ++clipboardReadGen;

    if (!event.hasValidCopy) {
      return;
    }

    let copiedText: string;
    try {
      copiedText = await readClipboard();
    } catch {
      return;
    }

    if (
      readGen !== clipboardReadGen ||
      capturedOpenGen !== openGen ||
      capturedDraftGen !== draftGen ||
      isSelecting()
    ) {
      return;
    }
    if (typeof copiedText !== "string" || copiedText.trim().length === 0) {
      return;
    }

    // Only an actual clipboard delivery replaces the OCR result in flight.
    cancelOcr();
    deliverSource(copiedText, "clipboard");
  };

  const waitForHidden = async (win: WindowRef, signal: AbortSignal): Promise<boolean> => {
    const deadline = Date.now() + HIDE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) return false;
      if (win.state()?.visible === false) return true;
      await new Promise((resolve) => setTimeout(resolve, HIDE_POLL_MS));
    }
    return false;
  };

  const captureOverlay = (): ScreenCaptureOverlayConfig => ({
    caption: t("ocr.capture.instruction"),
    ...captureOverlayTheme(),
  });

  /**
   * Reads the selected screen region and replaces the source with its text.
   *
   * The popup keeps its draft and its window: it hides for the selection, restores with the same
   * pin state, discards its late results by generation, and revalidates the saved model before
   * the image leaves the machine.
   */
  const startOcr = async () => {
    if (!openSignal() || ocrActive || !captureRegion) {
      return;
    }
    ocrActive = true;
    const runGen = ++ocrRunGen;
    const draftAtStart = draftGen;
    const closeAtStart = openGen;
    const wasPinned = pinnedSignal();
    const controller = new AbortController();
    ocrAbort = controller;
    let hiddenWindow: WindowRef | null = null;
    let shouldRestoreFocus = false;

    /** Shows the same window with its pin state; the first call after a hide wins. */
    const restoreWindow = () => {
      if (hiddenWindow === null) return;
      const win = hiddenWindow;
      hiddenWindow = null;
      if (openGen !== closeAtStart || !openSignal()) return;
      // Pin first, so dismissal never resumes while the window is still hidden.
      pinnedSignal.set(wasPinned);
      win.show();
      win.focus();
    };

    const isCurrent = () => runGen === ocrRunGen;
    const isStillWanted = () =>
      isCurrent() && draftGen === draftAtStart && openGen === closeAtStart;

    try {
      const binding = ocrSettingsStore.settings();
      const readiness = await checkOcrReadiness(binding);
      if (!isCurrent()) return;
      if (!readiness.ready) {
        setOcrMessage(readiness.reason ?? t("ocr.failure.unconfigured"));
        return;
      }

      const win = windowRef ?? Window.get(QUICK_TRANSLATE_WINDOW_ID);
      if (!win) {
        setOcrMessage(t("ocr.failure.failed"));
        return;
      }

      ocrStateSignal.set({ phase: "selecting", message: null });
      win.hide();
      if (!(await waitForHidden(win, controller.signal))) {
        setOcrMessage(t("ocr.failure.failed"));
        return;
      }
      hiddenWindow = win;

      const captured = await captureRegion({
        signal: controller.signal,
        overlay: captureOverlay(),
      });
      // The selection is over: the popup returns before the model is asked, so the user can
      // read its status, edit the draft, or close the window while recognition runs.
      restoreWindow();
      if (!isStillWanted()) return;

      if (captured.status === "cancelled" || captured.status === "unavailable") {
        shouldRestoreFocus = true;
        return;
      }
      if (captured.status === "tooLarge") {
        shouldRestoreFocus = true;
        setOcrMessage(t("ocr.failure.imageTooLarge"));
        return;
      }
      if (captured.status === "failed") {
        shouldRestoreFocus = true;
        setOcrMessage(t("ocr.failure.failed"));
        return;
      }

      ocrStateSignal.set({ phase: "recognizing", message: null });
      const outcome = await recognizeScreenshot(binding, captured.png, {
        signal: controller.signal,
      });
      if (!isStillWanted()) return;

      switch (outcome.status) {
        case "recognized":
          deliverSource(outcome.text, "ocr");
          break;
        case "no_text":
          shouldRestoreFocus = true;
          setOcrMessage(t("ocr.failure.noText"));
          break;
        case "unavailable":
          shouldRestoreFocus = true;
          setOcrMessage(outcome.reason);
          break;
        case "failed":
          shouldRestoreFocus = true;
          setOcrMessage(outcome.message);
          break;
        case "cancelled":
          shouldRestoreFocus = true;
          break;
      }
    } catch {
      if (isCurrent()) {
        shouldRestoreFocus = true;
        setOcrMessage(t("ocr.failure.failed"));
      }
    } finally {
      if (runGen === ocrRunGen) {
        ocrAbort = null;
        ocrActive = false;
        restoreWindow();
        if (shouldRestoreFocus && openSignal()) {
          ocrFocusSeqSignal.set(ocrFocusSeqSignal() + 1);
        }
        ocrStateSignal.set({ phase: "idle", message: ocrStateSignal().message });
      }
    }
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
    sourceDelivery: () => sourceDeliverySignal(),
    ocrState: () => ocrStateSignal(),
    ocrFocusSeq: () => ocrFocusSeqSignal(),
    dismissalSuspended: () => ocrStateSignal().phase !== "idle",
    autoTranslate: options.autoTranslate ?? (() => autoTranslateSignal()),
    open,
    close,
    activateDoubleCopy,
    startOcr,
    setPinned: (pinned: boolean) => pinnedSignal.set(pinned),
    togglePinned: () => pinnedSignal.set(!pinnedSignal()),
    toggleAutoTranslate: options.onToggleAutoTranslate
      ? options.onToggleAutoTranslate
      : () => autoTranslateSignal.set(!autoTranslateSignal()),
    setSourceText: (text: string) => {
      if (text === sourceSignal()) {
        return;
      }
      // A user edit or clear supersedes a running read of the screen.
      if (ocrActive || ocrStateSignal().message !== null) {
        cancelOcr();
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
    hasOpenOverlay,
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
