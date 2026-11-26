import { batch, signal, untracked, type Accessor, type Bounds, type Point, type Size } from "nsh";
import { t } from "nsh/i18n";
import {
  displays,
  Window,
  type Display,
  type DisplayId,
  type WindowRef,
  type WindowState,
} from "nsh/desktop";
import {
  checkOcrReadiness,
  enabledOcrEntries,
  recognizeScreenshot,
} from "../features/ocr/recognize";
import type { SourceDelivery, SourceDeliveryKind } from "../features/quick-translate/session";
import type { SourceInputHandle } from "../features/quick-translate/source-editor";
import type { ScreenCaptureOverlayConfig, ScreenCapturePort } from "../platform/screen-capture";
import type { SelectionTextPort, SelectionTextRead } from "../platform/selection-text";
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
import { createLogger } from "../services/log";

const heightLog = createLogger("quick-translate/height");

export const QUICK_TRANSLATE_WINDOW_ID = "quick-translate";

export const POPUP_DEFAULT_SIZE = { width: 420, height: 360 } as const;
export const POPUP_MIN_SIZE = { width: 340, height: 120 } as const;

/** Longest time the OCR action waits for its own window to report itself hidden. */
const HIDE_TIMEOUT_MS = 1_000;
/** Interval between hidden checks; NSH reports the new value on its own schedule. */
const HIDE_POLL_MS = 16;
/** Caps follow-up retries when a native drag loop overwrites `setBounds`. */
const MAX_HEIGHT_FIT_RETRIES = 2;
/** Tolerance (pt) for recognizing that a settled drag kept the pre-fit width and height. */
const DRAG_SIZE_MATCH_TOLERANCE_PT = 1;

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

/** Why a valid selection read delivered no text; null leaves the draft untouched. */
export type QuickTranslateSelectionFeedback = "noSelection" | "unavailable";

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
  /** Foreground selection boundary; the production port is native, and the test harness injects one. */
  selectionText?: SelectionTextPort;
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
  /** Why the last valid selection read delivered no text; null hides it. */
  selectionFeedback: Accessor<QuickTranslateSelectionFeedback | null>;
  /** Whether a screen capture port exists, so the Screenshot Translate action can run. */
  canStartOcr: Accessor<boolean>;
  /** Bumps whenever the OCR action should take the keyboard focus back. */
  ocrFocusSeq: Accessor<number>;
  /** Blur, Escape, and outside-press dismissal stay off while the selection runs. */
  dismissalSuspended: Accessor<boolean>;
  open: () => void;
  close: () => void;
  activateDoubleCopy: (event: DoubleCopyActivationEvent) => Promise<void>;
  activateSelectionTranslate: () => Promise<void>;
  /** Reads and delivers the selection captured by a drag release, after the user clicks. */
  activateSelectionFromHint: (target: string) => Promise<void>;
  startOcr: () => Promise<void>;
  setPinned: (pinned: boolean) => void;
  togglePinned: () => void;
  toggleAutoTranslate: () => void;
  setSourceText: (text: string) => void;
  restoreSourceText: (text: string) => void;
  draftRevision: () => number;
  focusSourceInput: () => void;
  setMenuOpen: (menuId: string, open: boolean) => void;
  hasOpenOverlay: () => boolean;
  attachWindow: (win: WindowRef | null) => void;
  attachSourceInput: (input: SourceInputHandle | null) => void;
  verifyInitialBounds: (state: WindowState | null) => void;
  fitContentHeight: (win: WindowRef, height: number, fitId: number) => void;
  handleBoundsChange: (bounds: Bounds) => void;
  traceHeightFit: (event: string, details?: Record<string, unknown>) => void;
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

function heightFitWindowState(state: WindowState | null | undefined) {
  return state
    ? {
        visible: state.visible,
        mode: state.mode,
        bounds: state.bounds,
        contentSize: state.contentBounds.size,
        displayId: state.display?.id,
        workArea: state.display?.visibleBounds,
        scale: state.scaleFactor,
      }
    : null;
}

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
  const selectionText = options.selectionText;
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
  const selectionFeedbackSignal = signal<QuickTranslateSelectionFeedback | null>(null);
  const ocrFocusSeqSignal = signal(0);
  const openMenusSignal = signal<Record<string, boolean>>({});
  let windowRef: WindowRef | null = null;
  let sourceInputRef: SourceInputHandle | null = null;
  let closeCleanup: (() => void) | null = null;
  let stopPressMonitor: (() => void) | null = null;
  let needsBoundsCheck = false;
  let userMovedSinceOpen = false;
  let expectingOwnSetBounds = false;
  let pendingHeightFit: {
    win: WindowRef;
    contentHeight: number;
    fitId: number;
    beforeBounds: Bounds;
    targetHeight: number;
    tolerance: number;
    retriesLeft: number;
  } | null = null;
  let openGen = 0;
  let popupId = 0;
  let draftGen = 0;
  let sourceReadGen = 0;
  let selectionReading = false;
  let queuedSelection: {
    target: string;
    gen: number;
    draftAtDispatch: number;
    uiaOnly: boolean;
    done: () => void;
  } | null = null;
  let lastDeliverySeq = 0;
  let ocrRunGen = 0;
  let ocrActive = false;
  let ocrAbort: AbortController | null = null;

  const traceHeightFit: QuickTranslateController["traceHeightFit"] = (event, details) => {
    untracked(() => heightLog.info(event, { popupId, ...details }));
  };

  const focusWindowAndInput = () => {
    (windowRef ?? Window.get(QUICK_TRANSLATE_WINDOW_ID))?.focus();
    sourceInputRef?.focus();
  };

  const isSelecting = () => ocrStateSignal().phase === "selecting";
  const setOcrMessage = (message: string | null) => {
    ocrStateSignal.set({ phase: "idle", message });
  };
  const setSelectionFeedback = (feedback: QuickTranslateSelectionFeedback | null) => {
    if (selectionFeedbackSignal() === feedback) return;
    selectionFeedbackSignal.set(feedback);
  };

  /** Ends the running OCR request; late results see the older generation and drop. */
  const cancelOcr = () => {
    ocrRunGen += 1;
    ocrAbort?.abort();
    ocrAbort = null;
    ocrActive = false;
    ocrStateSignal.set(IDLE_OCR_STATE);
  };

  const replaceDraft = (text: string) => {
    if (ocrActive || ocrStateSignal().message !== null) cancelOcr();
    setSelectionFeedback(null);
    draftGen += 1;
    sourceSignal.set(text);
  };

  const releaseQueuedSelection = () => {
    const pending = queuedSelection;
    queuedSelection = null;
    pending?.done();
  };

  const close = () => {
    // A selection read can still be in flight before the popup exists.
    sourceReadGen += 1;
    releaseQueuedSelection();
    const hadState =
      openSignal() ||
      pinnedSignal() ||
      sourceDeliverySignal() !== null ||
      Object.keys(openMenusSignal()).length > 0;
    if (!hadState && windowRef === null && !ocrActive) {
      return;
    }
    traceHeightFit("closed");
    cancelOcr();
    openGen += 1;
    draftGen += 1;
    openSignal.set(false);
    pinnedSignal.set(false);
    sourceDeliverySignal.set(null);
    setSelectionFeedback(null);
    openMenusSignal.set({});
    windowRef = null;
    attachedWindowSignal.set(null);
    sourceInputRef = null;
    needsBoundsCheck = false;
    userMovedSinceOpen = false;
    expectingOwnSetBounds = false;
    pendingHeightFit = null;
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

  const openFrom = (trigger: SourceDeliveryKind | "manual") => {
    // While the screen selection runs, a shortcut or copy must not pull the popup forward.
    if (isSelecting()) {
      return;
    }
    if (openSignal()) {
      traceHeightFit("reused", { trigger });
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
    pendingHeightFit = null;
    popupId += 1;
    traceHeightFit("opening", { trigger, placement });
    placementSignal.set(placement);
    openSignal.set(true);
    startPressMonitor();
  };

  /** Replaces the draft with one delivered text and bumps the single delivery sequence. */
  const deliverSource = (text: string, kind: SourceDeliveryKind) => {
    const seq = lastDeliverySeq + 1;
    lastDeliverySeq = seq;
    draftGen += 1;
    traceHeightFit("source-delivered", { kind, seq, length: text.length });
    batch(() => {
      setSelectionFeedback(null);
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
    openFrom("clipboard");
    const capturedOpenGen = openGen;
    const capturedDraftGen = draftGen;
    const readGen = ++sourceReadGen;

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
      readGen !== sourceReadGen ||
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

  const readSelection = async (target: string, uiaOnly: boolean): Promise<SelectionTextRead> => {
    try {
      return await selectionText!.read(target, uiaOnly ? { uiaOnly: true } : undefined);
    } catch {
      return { status: "unavailable" };
    }
  };

  const selectionTargetIsCurrent = (target: string): boolean => {
    try {
      return selectionText!.isCurrent(target);
    } catch {
      return false;
    }
  };

  const applySelectionResult = (
    target: string,
    result: SelectionTextRead,
    gen: number,
    draftAtDispatch: number,
  ) => {
    if (gen !== sourceReadGen || draftAtDispatch !== draftGen) return;
    // UI Automation focus can change within the same native window and control.
    if (result.status === "stale" || !selectionTargetIsCurrent(target)) return;
    openFrom("selection");
    const text = result.status === "selected" ? result.text : "";
    if (text.trim().length > 0) {
      // A delivered selection replaces recognition. An empty read leaves it running.
      cancelOcr();
      setSelectionFeedback(null);
      deliverSource(text, "selection");
      return;
    }
    // Recognition keeps the status slot it already owns.
    if (ocrStateSignal().phase !== "idle") return;
    // A failed read replaces an earlier idle OCR message instead of stacking on it.
    if (ocrStateSignal().message !== null) setOcrMessage(null);
    setSelectionFeedback(result.status === "unavailable" ? "unavailable" : "noSelection");
  };

  /** One UI Automation read at a time. A newer press replaces the single queued target. */
  const runSelectionRead = async (
    target: string,
    gen: number,
    draftAtDispatch: number,
    uiaOnly: boolean,
  ) => {
    selectionReading = true;
    try {
      const result = await readSelection(target, uiaOnly);
      applySelectionResult(target, result, gen, draftAtDispatch);
    } finally {
      selectionReading = false;
    }

    const next = queuedSelection;
    queuedSelection = null;
    if (!next) return;
    if (
      next.gen !== sourceReadGen ||
      next.draftAtDispatch !== draftGen ||
      !selectionTargetIsCurrent(next.target)
    ) {
      next.done();
      return;
    }
    void runSelectionRead(next.target, next.gen, next.draftAtDispatch, next.uiaOnly).finally(
      next.done,
    );
  };

  /** Reads the foreground selection before the popup takes focus, then translates it once. */
  const activateSelectionTranslate = async (): Promise<void> => {
    if (!selectionText) return;
    // The native region overlay owns the screen until the user confirms or cancels it.
    if (isSelecting()) return;
    let target: string | null;
    try {
      target = selectionText.snapshot();
    } catch {
      target = null;
    }
    if (target === null) return;
    setSelectionFeedback(null);

    const gen = ++sourceReadGen;
    const draftAtDispatch = draftGen;
    if (selectionReading) {
      queuedSelection?.done();
      await new Promise<void>((resolve) => {
        queuedSelection = { target, gen, draftAtDispatch, uiaOnly: false, done: resolve };
      });
      return;
    }
    await runSelectionRead(target, gen, draftAtDispatch, false);
  };

  /**
   * Reads the selection captured by a drag release, after the user clicked its hint.
   *
   * UI Automation is the only reader here: this path never simulates a copy. A target that is no
   * longer current opens nothing.
   */
  const activateSelectionFromHint = async (target: string): Promise<void> => {
    if (!selectionText) return;
    if (isSelecting()) return;
    if (!selectionTargetIsCurrent(target)) return;
    setSelectionFeedback(null);
    const gen = ++sourceReadGen;
    const draftAtDispatch = draftGen;
    if (selectionReading) {
      queuedSelection?.done();
      await new Promise<void>((resolve) => {
        queuedSelection = { target, gen, draftAtDispatch, uiaOnly: true, done: resolve };
      });
      return;
    }
    await runSelectionRead(target, gen, draftAtDispatch, true);
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
   * An open popup hides during selection and keeps its draft and pin. When invoked directly,
   * the native selection starts without a popup; a confirmed crop opens it for recognition.
   */
  const startOcr = async () => {
    if (ocrActive || !captureRegion) return;
    // The overlay replaces any selection read that has not delivered yet.
    sourceReadGen += 1;
    releaseQueuedSelection();
    setSelectionFeedback(null);
    const hadPopup = openSignal();
    ocrActive = true;
    ocrStateSignal.set({ phase: "selecting", message: null });
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

    const revealWindow = () => {
      if (hadPopup) restoreWindow();
      else if (!openSignal()) openFrom("ocr");
    };

    const reportFailure = (message: string) => {
      setOcrMessage(message);
      revealWindow();
    };

    const isCurrent = () => runGen === ocrRunGen;
    const isStillWanted = () =>
      isCurrent() && draftGen === draftAtStart && openGen === closeAtStart;

    try {
      const readiness = await checkOcrReadiness(enabledOcrEntries());
      if (!isCurrent()) return;
      if (!readiness.ready) {
        reportFailure(readiness.reason ?? t("ocr.failure.unconfigured"));
        return;
      }

      if (hadPopup) {
        const win = windowRef ?? Window.get(QUICK_TRANSLATE_WINDOW_ID);
        if (!win) {
          reportFailure(t("ocr.failure.failed"));
          return;
        }
        hiddenWindow = win;
        win.hide();
        if (!(await waitForHidden(win, controller.signal))) {
          if (isCurrent()) reportFailure(t("ocr.failure.failed"));
          return;
        }
      }

      const captured = await captureRegion({
        signal: controller.signal,
        overlay: captureOverlay(),
      });
      if (!isStillWanted()) return;

      if (captured.status === "cancelled" || captured.status === "unavailable") {
        shouldRestoreFocus = true;
        return;
      }
      if (captured.status === "tooLarge") {
        shouldRestoreFocus = true;
        reportFailure(t("ocr.failure.imageTooLarge"));
        return;
      }
      if (captured.status === "failed") {
        shouldRestoreFocus = true;
        reportFailure(t("ocr.failure.failed"));
        return;
      }

      // Show the popup before asking the model, so the user can see the recognition status.
      ocrStateSignal.set({ phase: "recognizing", message: null });
      revealWindow();
      const outcome = await recognizeScreenshot(enabledOcrEntries(), captured.png, {
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
        reportFailure(t("ocr.failure.failed"));
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

  const verifyInitialBounds = (state: WindowState | null) => {
    traceHeightFit("window-state", { state: heightFitWindowState(state), needsBoundsCheck });
    if (!state || !needsBoundsCheck || userMovedSinceOpen) {
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
    const request = { origin: target.origin, ...(sizeShifted ? { size: target.size } : {}) };
    traceHeightFit("initial-bounds-request", { request });
    win.setBounds(request);
  };

  const openingSize = () => {
    const current = placementSignal();
    return current.kind === "cursor" ? current.bounds.size : current.size;
  };

  const applyContentHeightFit = (
    win: WindowRef,
    height: number,
    fitId: number,
    retriesLeft: number,
  ) => {
    if (!openSignal() || win !== windowRef) {
      traceHeightFit("fit-skipped", { fitId, reason: "inactive-window" });
      return;
    }
    const state = win.state();
    if (!state?.visible || state.mode !== "normal") {
      pendingHeightFit = null;
      traceHeightFit("fit-skipped", {
        fitId,
        reason: "window-not-ready",
        state: heightFitWindowState(state),
      });
      return;
    }
    const minHeight = Math.min(POPUP_MIN_SIZE.height, openingSize().height);
    const fit = resolvePopupContentFit(state, height, minHeight);
    traceHeightFit(fit ? "fit-request" : "fit-no-change", {
      fitId,
      height,
      minHeight,
      state: heightFitWindowState(state),
      request: fit,
    });
    if (!fit) {
      pendingHeightFit = null;
      return;
    }
    if (fit.size?.height !== undefined) {
      const scale = state.scaleFactor > 0 ? state.scaleFactor : 1;
      pendingHeightFit = {
        win,
        contentHeight: height,
        fitId,
        beforeBounds: state.bounds,
        targetHeight: fit.size.height,
        tolerance: 0.5 / scale,
        retriesLeft,
      };
    } else {
      pendingHeightFit = null;
    }
    win.setBounds(fit);
  };

  const fitContentHeight = (win: WindowRef, height: number, fitId: number) => {
    applyContentHeightFit(win, height, fitId, MAX_HEIGHT_FIT_RETRIES);
  };

  const reconcilePendingHeightFit = (bounds: Bounds) => {
    const pending = pendingHeightFit;
    if (!pending) return;
    if (!openSignal() || pending.win !== windowRef) {
      pendingHeightFit = null;
      return;
    }
    if (Math.abs(bounds.size.height - pending.targetHeight) < pending.tolerance) {
      pendingHeightFit = null;
      return;
    }
    const sizeTolerance = Math.max(pending.tolerance, DRAG_SIZE_MATCH_TOLERANCE_PT);
    const heightUnchanged =
      Math.abs(bounds.size.height - pending.beforeBounds.size.height) < sizeTolerance;
    const widthUnchanged =
      Math.abs(bounds.size.width - pending.beforeBounds.size.width) < sizeTolerance;
    const originMoved =
      Math.abs(bounds.origin.x - pending.beforeBounds.origin.x) >= pending.tolerance ||
      Math.abs(bounds.origin.y - pending.beforeBounds.origin.y) >= pending.tolerance;
    if (heightUnchanged && widthUnchanged && originMoved && pending.retriesLeft > 0) {
      const nextRetries = pending.retriesLeft - 1;
      traceHeightFit("fit-retry", {
        fitId: pending.fitId,
        retriesLeft: nextRetries,
        height: pending.contentHeight,
        bounds,
      });
      applyContentHeightFit(pending.win, pending.contentHeight, pending.fitId, nextRetries);
      return;
    }
    pendingHeightFit = null;
  };

  const handleBoundsChange = (bounds: Bounds) => {
    traceHeightFit("bounds-changed", { bounds, expectingOwnSetBounds, needsBoundsCheck });
    if (expectingOwnSetBounds) {
      expectingOwnSetBounds = false;
    } else {
      userMovedSinceOpen = true;
      needsBoundsCheck = false;
    }
    reconcilePendingHeightFit(bounds);
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
    selectionFeedback: () => selectionFeedbackSignal(),
    canStartOcr: () => captureRegion !== undefined,
    ocrFocusSeq: () => ocrFocusSeqSignal(),
    dismissalSuspended: () => ocrStateSignal().phase !== "idle",
    autoTranslate: options.autoTranslate ?? (() => autoTranslateSignal()),
    open: () => openFrom("manual"),
    close,
    activateDoubleCopy,
    activateSelectionTranslate,
    activateSelectionFromHint,
    startOcr,
    setPinned: (pinned: boolean) => pinnedSignal.set(pinned),
    togglePinned: () => pinnedSignal.set(!pinnedSignal()),
    toggleAutoTranslate: options.onToggleAutoTranslate
      ? options.onToggleAutoTranslate
      : () => autoTranslateSignal.set(!autoTranslateSignal()),
    setSourceText: (text) => {
      if (text !== sourceSignal()) replaceDraft(text);
    },
    restoreSourceText: (text) => {
      replaceDraft(text);
      sourceDeliverySignal.set(null);
    },
    draftRevision: () => draftGen,
    focusSourceInput: () => {
      sourceInputRef?.focus();
      const end = sourceSignal().length;
      sourceInputRef?.setSelection(end, end);
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
      traceHeightFit("window-ref", { attached: win !== null });
      if (win !== windowRef) pendingHeightFit = null;
      windowRef = win;
      attachedWindowSignal.set(win);
    },
    attachSourceInput: (input: SourceInputHandle | null) => {
      sourceInputRef = input;
      input?.focus();
    },
    verifyInitialBounds,
    fitContentHeight,
    handleBoundsChange,
    traceHeightFit,
    setOnCloseCleanup: (callback: (() => void) | null) => {
      closeCleanup = callback;
    },
  };
}
