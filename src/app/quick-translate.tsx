import {
  cleanup,
  Clipboard,
  computed,
  effect,
  platform,
  Scroll,
  signal,
  token,
  View,
  type ViewRef,
} from "nsh";
import { Application, currentWindow, GlobalShortcut, titleBar, Window } from "nsh/desktop";
import { t } from "nsh/i18n";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { toast } from "../components/ui/toast";
import { alignmentModel } from "../features/quick-translate/alignment-model";
import { beginHistoryAction } from "../features/quick-translate/history";
import { QuickTranslateHistoryMenu } from "../features/quick-translate/history-menu";
import { QuickTranslateLanguageBar } from "../features/quick-translate/language-menu";
import { QuickTranslateFooter, QuickTranslatePopup } from "../features/quick-translate/popup";
import {
  autoTranslatePreference,
  doubleCopyEnabled,
  markdownEnabledPreference,
  registerDoubleCopyRuntime,
  saveQuickTranslatePopupState,
} from "../features/quick-translate/preferences";
import {
  createQuickTranslateSession,
  type QuickTranslateSession,
} from "../features/quick-translate/session";
import { createAnkiClient } from "../features/wordbook/anki-client";
import { wordbookSettingsStore } from "../features/wordbook/settings";
import { sentenceAlignmentEnabled } from "../features/settings/quick-translate";
import { selectionCopyEnabled } from "../features/settings/selection-copy";
import {
  createTranslationShortcutSetting,
  formatShortcut,
  type TranslationShortcutBinding,
  type TranslationShortcutId,
} from "../features/settings/shortcuts";
import { canCaptureScreen, ScreenCapture } from "../platform/screen-capture";
import { canReadSelectionText, createSelectionTextPort } from "../platform/selection-text";
import { canMonitorPointerPress, type DoubleCopyBinding } from "../platform/quick-translate";
import {
  nativeDoubleCopyBinding,
  nativePointerPressBinding,
  readCursorAnchor,
} from "../platform/quick-translate-native";
import { logLevel } from "../services/log";
import {
  createQuickTranslateController as createPureQuickTranslateController,
  POPUP_MIN_SIZE,
  QUICK_TRANSLATE_WINDOW_ID,
  type QuickTranslateController,
  type QuickTranslateControllerOptions,
} from "./quick-translate-controller";

export {
  QUICK_TRANSLATE_WINDOW_ID,
  type QuickTranslateController,
  type QuickTranslateControllerOptions,
};

/** Creates the desktop Quick Translate controller backed by native cursor anchor, preferences, and clipboard access. */
export function createQuickTranslateController(
  options: QuickTranslateControllerOptions = {},
): QuickTranslateController {
  return createPureQuickTranslateController({
    readCursorAnchor,
    readClipboardText: () => Clipboard.readText(),
    isDoubleCopyActive: doubleCopyEnabled,
    onPointerPress: canMonitorPointerPress(platform.os)
      ? nativePointerPressBinding.onPointerPress
      : () => () => {},
    autoTranslate: autoTranslatePreference,
    onToggleAutoTranslate: () => {
      void saveQuickTranslatePopupState({ autoTranslate: !autoTranslatePreference() });
    },
    captureRegion: ScreenCapture.capture,
    captureOverlayTheme: () => ({
      accentColor: token("accent"),
      textColor: token("foreground"),
      backdropColor: token("background"),
    }),
    selectionText: canReadSelectionText(platform.os)
      ? createSelectionTextPort(selectionCopyEnabled)
      : undefined,
    ...options,
  });
}

/** Registers the Windows translation shortcuts and releases them with the shell. */
export function registerTranslationShortcuts(
  controller: QuickTranslateController,
  binding: TranslationShortcutBinding = GlobalShortcut,
  currentOs: string = platform.os,
) {
  // Selection does not depend on screen capture. All three actions are Windows-only.
  if (currentOs !== "windows") return undefined;

  const claimed = new Set<string>();
  const isRecordingInForeground = (): boolean =>
    Window.get("main")?.state()?.focused === true &&
    Object.values(settings).some((setting) => setting.recording());
  const createSetting = (id: TranslationShortcutId, onPress: () => void) =>
    createTranslationShortcutSetting(id, binding, onPress, isRecordingInForeground, claimed);
  const settings = {
    "quick-translate": createSetting("quick-translate", controller.open),
    "screenshot-translate": createSetting("screenshot-translate", () => void controller.startOcr()),
    "selection-translate": createSetting("selection-translate", () => {
      void controller.activateSelectionTranslate();
    }),
  };
  const entries = Object.values(settings);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    stopQuitListener();
    for (const setting of entries) setting.dispose();
  };

  const stopQuitListener = Application.on("quit", release);
  cleanup(release);

  // In case a saved Quick Translate chord matches the new screenshot default, keep the
  // existing shortcut. Each start claims its chord before awaiting native registration.
  void Promise.all(entries.map((setting) => setting.load())).then(() => {
    void settings["quick-translate"].start().then(() => {
      const setting = settings["quick-translate"];
      const chord = setting.shortcut();
      if (!released && chord !== null && setting.unavailable()) {
        toast.warning(t("quickTranslate.shortcutUnavailable", { shortcut: formatShortcut(chord) }));
      }
    });
    void settings["screenshot-translate"].start();
    void settings["selection-translate"].start();
  });

  return { settings, isRecordingInForeground };
}

/** Coordinates the Windows Raw Input double-copy listener with persisted opt-in preferences. */
export function registerQuickTranslateDoubleCopy(
  controller: QuickTranslateController,
  binding: DoubleCopyBinding = nativeDoubleCopyBinding,
  currentOs: string = platform.os,
  ignoreActivation: () => boolean = () => false,
): () => void {
  const stopRuntime = registerDoubleCopyRuntime({
    os: currentOs,
    start: () =>
      binding.onDoubleCopy((event) => {
        if (!ignoreActivation()) void controller.activateDoubleCopy(event);
      }),
    onStartupError: (message) => toast.error(message),
  });

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    stopQuitListener();
    stopRuntime();
  };

  const stopQuitListener = Application.on("quit", release);
  cleanup(release);
  return release;
}

/** Top + bottom border width (1 pt each) of the rounded frameless root container. */
const ROOT_BORDER_HEIGHT = 2;

/** Renders popup contents inside `<Window>` so `titleBar()` reads this window's caption area. */
function QuickTranslateWindowBody(props: {
  controller: QuickTranslateController;
  session: QuickTranslateSession;
}) {
  const session = props.session;
  const win = currentWindow();
  // NSH 0.7 can retain a closed window's effects after its replacement opens.
  const isCurrentWindow = computed(() => props.controller.attachedWindow() === win);
  const headerHeight = signal(0);
  const contentHeight = signal(0);
  const footerHeight = signal(0);
  const scrollRevision = signal(0);
  let fitId = 0;
  const markdownActionLabel = () =>
    t(markdownEnabledPreference() ? "quickTranslate.showPlainText" : "quickTranslate.showMarkdown");
  const ocrAction = signal<ViewRef | null>(null);
  let handledOcrFocusSeq = props.controller.ocrFocusSeq();
  // On Windows the first layout can arrive before the native window state.
  const readyToFit = computed(() => {
    const state = win.state();
    return state?.visible === true && state.mode === "normal";
  });

  // On Windows, show without activation, then focus only the popup once visible.
  if (platform.os === "windows") {
    let requestedFocus = false;
    effect(() => {
      if (requestedFocus || !win.state()?.visible) return;
      requestedFocus = true;
      win.focus();
    });
  }

  // A cancelled or failed selection puts the caret back on the action that started it.
  effect(() => {
    const seq = props.controller.ocrFocusSeq();
    if (seq === handledOcrFocusSeq) return;
    handledOcrFocusSeq = seq;
    ocrAction()?.focus();
  });

  effect(() => {
    if (!isCurrentWindow() || logLevel() !== "info") return;
    props.controller.traceHeightFit("content-state", {
      markdown: markdownEnabledPreference(),
      cards: session.cards().map(({ collapsed, result, backTranslation }) => ({
        collapsed,
        result: result.status,
        resultLength: "text" in result ? (result.text?.length ?? 0) : 0,
        backTranslation: backTranslation.status,
      })),
    });
  });

  effect(() => {
    if (!isCurrentWindow()) return;
    const header = headerHeight();
    const content = contentHeight();
    const footer = footerHeight();
    const ready = readyToFit();
    if (!ready || header <= 0 || content <= 0 || footer <= 0) {
      props.controller.traceHeightFit("fit-waiting", { ready, header, content, footer });
      return;
    }
    const id = ++fitId;
    const height = header + content + footer + ROOT_BORDER_HEIGHT;
    props.controller.traceHeightFit("fit-scheduled", {
      fitId: id,
      header,
      content,
      footer,
      height,
    });
    // Coalesce layout events and resize outside the native layout pass.
    let pending = true;
    const frame = requestAnimationFrame(() => {
      pending = false;
      props.controller.fitContentHeight(win, height, id);
    });
    cleanup(() => {
      cancelAnimationFrame(frame);
      if (pending) props.controller.traceHeightFit("fit-cancelled", { fitId: id });
    });
  });

  return (
    <View
      testID="quick-translate-surface"
      class="flex-1 overflow-hidden rounded-2xl border border-border bg-background text-foreground"
    >
      <View
        testID="quick-translate-header"
        onLayout={({ bounds }) => headerHeight.set(bounds.size.height)}
        desktop={{ windowDrag: true }}
        class="shrink-0 flex-row items-center justify-between gap-1 border-b border-border/70 bg-background"
        // Runtime platform titleBar() insets clear native caption buttons; 16 pt matches the px-4 body spine.
        style={{
          height: Math.max(44, titleBar().height),
          paddingLeft: titleBar().left + 16,
          paddingRight: titleBar().right + 16,
        }}
      >
        <View desktop={{ windowDrag: false }} class="min-w-0 shrink flex-row items-center">
          <QuickTranslateLanguageBar
            sourceLanguage={session.sourceLanguage()}
            targetLanguage={session.targetLanguage()}
            sourceDetection={session.sourceDetection()}
            canSwap={session.canSwapLanguages()}
            onSelectSourceLanguage={(language) => session.handleSourceLanguageChange(language)}
            onSelectTargetLanguage={(language) => session.handleTargetLanguageChange(language)}
            onSwapLanguages={() => session.handleSwapLanguages()}
            onSourceOpenChange={(open) => session.notifyOverlayOpenChange("source-language", open)}
            onTargetOpenChange={(open) => session.notifyOverlayOpenChange("target-language", open)}
          />
        </View>
        <View desktop={{ windowDrag: false }} class="shrink-0 flex-row items-center gap-0.5">
          <Button
            testID="quick-translate-auto-toggle"
            variant="brand-ghost"
            size="icon-sm"
            selected={props.controller.autoTranslate()}
            tooltip={
              props.controller.autoTranslate()
                ? t("quickTranslate.disableAutoTranslate")
                : t("quickTranslate.enableAutoTranslate")
            }
            accessibilityLabel={
              props.controller.autoTranslate()
                ? t("quickTranslate.disableAutoTranslate")
                : t("quickTranslate.enableAutoTranslate")
            }
            onPress={() => props.controller.toggleAutoTranslate()}
          >
            <Icon
              name={props.controller.autoTranslate() ? "mdi:flash" : "mdi:flash-outline"}
              tone={props.controller.autoTranslate() ? "brand" : "muted-foreground"}
              class="size-3.5"
            />
          </Button>
          <Button
            testID="quick-translate-markdown-toggle"
            variant="brand-ghost"
            size="icon-sm"
            selected={markdownEnabledPreference()}
            tooltip={markdownActionLabel()}
            accessibilityLabel={markdownActionLabel()}
            onPress={() =>
              void saveQuickTranslatePopupState({ markdownEnabled: !markdownEnabledPreference() })
            }
          >
            <Icon
              name={
                markdownEnabledPreference()
                  ? "mdi:language-markdown"
                  : "mdi:language-markdown-outline"
              }
              tone={markdownEnabledPreference() ? "brand" : "muted-foreground"}
              class="size-3.5"
            />
          </Button>
          <If when={canCaptureScreen(platform.os)}>
            <Button
              testID="quick-translate-ocr"
              variant="ghost"
              size="icon-sm"
              tooltip={t("quickTranslate.ocr")}
              accessibilityLabel={t("quickTranslate.ocr")}
              disabled={props.controller.dismissalSuspended()}
              onPress={() => void props.controller.startOcr()}
              ref={(node) => ocrAction.set(node)}
            >
              <Icon name="mdi:ocr" tone="muted-foreground" class="size-3.5" />
            </Button>
          </If>
          <QuickTranslateHistoryMenu
            available={props.controller.isOpen() && !props.controller.dismissalSuspended()}
            draftRevision={props.controller.draftRevision}
            onOpenChange={(open) => session.notifyOverlayOpenChange("history", open)}
            onRestore={session.handleRestoreHistory}
            onFocusSource={props.controller.focusSourceInput}
          />
          <Button
            testID="quick-translate-pin"
            variant="brand-ghost"
            size="icon-sm"
            selected={props.controller.isPinned()}
            tooltip={
              props.controller.isPinned() ? t("quickTranslate.unpin") : t("quickTranslate.pin")
            }
            accessibilityLabel={
              props.controller.isPinned() ? t("quickTranslate.unpin") : t("quickTranslate.pin")
            }
            onPress={() => props.controller.togglePinned()}
          >
            <Icon
              name={props.controller.isPinned() ? "mdi:pin" : "mdi:pin-outline"}
              tone={props.controller.isPinned() ? "brand" : "muted-foreground"}
              class="size-3.5"
            />
          </Button>
          <If when={titleBar().right === 0}>
            <View class="mx-0.5 h-3.5 w-px bg-border" />
            <Button
              testID="quick-translate-close"
              variant="destructive-ghost"
              size="icon-sm"
              tooltip={t("quickTranslate.close")}
              accessibilityLabel={t("quickTranslate.close")}
              onPress={() => props.controller.close()}
            >
              <Icon name="mdi:close" tone="muted-foreground" class="size-3.5" />
            </Button>
          </If>
        </View>
      </View>
      <Scroll
        class="min-h-0 flex-1"
        onScroll={() => scrollRevision.update((revision) => revision + 1)}
      >
        {/* Measure the natural content height, not the scroll viewport. */}
        <View
          class="shrink-0"
          onLayout={({ bounds }) => {
            if (!isCurrentWindow()) return;
            props.controller.traceHeightFit("content-layout", { size: bounds.size });
            contentHeight.set(bounds.size.height);
          }}
        >
          <QuickTranslatePopup
            session={session}
            markdownEnabled={markdownEnabledPreference()}
            ocrState={props.controller.ocrState}
            selectionFeedback={props.controller.selectionFeedback}
            onScreenshotTranslate={
              canCaptureScreen(platform.os) && props.controller.canStartOcr()
                ? () => void props.controller.startOcr()
                : undefined
            }
            playbackAllowed={() => props.controller.attachedWindow()?.state()?.visible === true}
            windowVisible={() => props.controller.isOpen() && win.state()?.visible !== false}
            scrollRevision={() => scrollRevision()}
            sentenceAlignmentEnabled={sentenceAlignmentEnabled}
            semanticModelReady={alignmentModel.ready}
            onAttachSourceInput={(node) => props.controller.attachSourceInput(node)}
          />
        </View>
      </Scroll>
      <View class="shrink-0" onLayout={({ bounds }) => footerHeight.set(bounds.size.height)}>
        <QuickTranslateFooter session={session} />
      </View>
    </View>
  );
}

/** Floating Quick Translate window with a session that survives native window close. */
export function QuickTranslateWindow(props: { controller: QuickTranslateController }) {
  const session = createQuickTranslateSession({
    windowOpen: props.controller.isOpen,
    sourceText: props.controller.sourceText,
    sourceDelivery: props.controller.sourceDelivery,
    onSourceTextChange: props.controller.setSourceText,
    onRestoreSourceText: props.controller.restoreSourceText,
    beginHistoryAction,
    autoTranslate: props.controller.autoTranslate,
    onOverlayOpenChange: (menuId, open) => props.controller.setMenuOpen(menuId, open),
    ankiEnabled: () => {
      const state = wordbookSettingsStore.view();
      return state.enabled && state.target !== null && state.error === null;
    },
    currentAnkiBinding: () => {
      const binding = wordbookSettingsStore.activeBinding();
      if (!binding) return null;
      return {
        profile: binding.profile,
        deckId: binding.deckId,
        noteTypeId: binding.noteTypeId,
        sourceField: binding.sourceField,
        translationField: binding.translationField,
      };
    },
    addToAnki: async (input) => {
      const key = await wordbookSettingsStore.readApiKey();
      return createAnkiClient(key ? { apiKey: key } : {}).addTranslation(input);
    },
  });

  effect(() => {
    const win = props.controller.attachedWindow();
    if (win) props.controller.verifyInitialBounds(win.state());
  });

  return (
    <Window
      id={QUICK_TRANSLATE_WINDOW_ID}
      open={props.controller.isOpen()}
      title={t("quickTranslate.title")}
      kind="panel"
      frame="none"
      transparent={true}
      level="floating"
      taskbar={false}
      resizable={true}
      minimizable={false}
      maximizable={false}
      closable={true}
      focusable={true}
      activate={platform.os !== "windows"}
      backdrop="none"
      shadow={true}
      defaultSize={props.controller.openingSize()}
      minSize={{
        width: Math.min(POPUP_MIN_SIZE.width, props.controller.openingSize().width),
        height: Math.min(POPUP_MIN_SIZE.height, props.controller.openingSize().height),
      }}
      display={props.controller.openingDisplay()}
      defaultPosition={props.controller.openingPosition()}
      closeOnPress={true}
      closeOnBlur={!props.controller.isPinned() && !props.controller.dismissalSuspended()}
      closeOnEscape={!props.controller.hasOpenOverlay() && !props.controller.dismissalSuspended()}
      onBoundsChange={({ bounds }) => props.controller.handleBoundsChange(bounds)}
      onOpenChange={({ open }) => {
        if (!open) {
          props.controller.close();
        }
      }}
      ref={(node) => props.controller.attachWindow(node)}
    >
      <QuickTranslateWindowBody controller={props.controller} session={session} />
    </Window>
  );
}
