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
import { Application, GlobalShortcut, titleBar, Window } from "nsh/desktop";
import { t } from "nsh/i18n";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { toast } from "../components/ui/toast";
import { QuickTranslateLanguageMenu } from "../features/quick-translate/language-menu";
import {
  QuickTranslateAddPresetMenu,
  QuickTranslatePopup,
} from "../features/quick-translate/popup";
import {
  autoTranslatePreference,
  doubleCopyEnabled,
  registerDoubleCopyRuntime,
  saveQuickTranslatePopupState,
} from "../features/quick-translate/preferences";
import { createQuickTranslateSession } from "../features/quick-translate/session";
import {
  createQuickTranslateShortcutSetting,
  formatShortcut,
  type QuickTranslateShortcutBinding,
} from "../features/settings/shortcuts";
import { canCaptureScreen, ScreenCapture } from "../platform/screen-capture";
import { canMonitorPointerPress, type DoubleCopyBinding } from "../platform/quick-translate";
import {
  nativeDoubleCopyBinding,
  nativePointerPressBinding,
  readCursorAnchor,
} from "../platform/quick-translate-native";
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
    ...options,
  });
}

/** Registers the saved Windows shortcut and releases it on shell disposal or quit. */
export function registerQuickTranslateShortcut(
  controller: QuickTranslateController,
  binding: QuickTranslateShortcutBinding = GlobalShortcut,
  currentOs: string = platform.os,
) {
  if (currentOs !== "windows") return undefined;

  const setting = createQuickTranslateShortcutSetting(
    binding,
    () => controller.open(),
    () => Window.get("main")?.state()?.focused === true,
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    stopQuitListener();
    setting.dispose();
  };

  const stopQuitListener = Application.on("quit", release);
  cleanup(release);

  void setting.start().then(() => {
    if (!released && setting.unavailable()) {
      toast.warning(
        t("quickTranslate.shortcutUnavailable", {
          shortcut: formatShortcut(setting.shortcut()),
        }),
      );
    }
  });

  return setting;
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
function QuickTranslateWindowBody(props: { controller: QuickTranslateController }) {
  const headerHeight = signal(0);
  const contentHeight = signal(0);
  const ocrAction = signal<ViewRef | null>(null);
  let handledOcrFocusSeq = props.controller.ocrFocusSeq();
  const session = createQuickTranslateSession({
    sourceText: props.controller.sourceText,
    sourceDelivery: props.controller.sourceDelivery,
    onSourceTextChange: (text) => props.controller.setSourceText(text),
    autoTranslate: props.controller.autoTranslate,
    onOverlayOpenChange: (menuId, open) => props.controller.setMenuOpen(menuId, open),
  });
  // On Windows the first layout can arrive before the native window state.
  const readyToFit = computed(() => {
    const state = props.controller.attachedWindow()?.state();
    return state?.visible === true && state.mode === "normal";
  });

  // A cancelled or failed selection puts the caret back on the action that started it.
  effect(() => {
    const seq = props.controller.ocrFocusSeq();
    if (seq === handledOcrFocusSeq) return;
    handledOcrFocusSeq = seq;
    ocrAction()?.focus();
  });

  effect(() => {
    const header = headerHeight();
    const content = contentHeight();
    if (!readyToFit() || header <= 0 || content <= 0) return;
    // Coalesce layout events and resize outside the native layout pass.
    const frame = requestAnimationFrame(() =>
      props.controller.fitContentHeight(header + content + ROOT_BORDER_HEIGHT),
    );
    cleanup(() => cancelAnimationFrame(frame));
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
        class="shrink-0 flex-row items-center justify-between gap-2 border-b border-border"
        // Runtime platform titleBar() insets clear native caption buttons; 12 pt matches the p-3 body inset.
        style={{
          height: Math.max(40, titleBar().height),
          paddingLeft: titleBar().left + 12,
          paddingRight: titleBar().right + 12,
        }}
      >
        <View desktop={{ windowDrag: false }} class="flex-row items-center gap-1">
          <QuickTranslateLanguageMenu
            sourceLanguage={session.sourceLanguage()}
            targetLanguage={session.targetLanguage()}
            onSelectSourceLanguage={(language) => session.handleSourceLanguageChange(language)}
            onSelectTargetLanguage={(language) => session.handleTargetLanguageChange(language)}
            onOpenChange={(open) => session.notifyOverlayOpenChange("language-menu", open)}
          />
          <Button
            testID="quick-translate-auto-toggle"
            variant="ghost"
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
              name={props.controller.autoTranslate() ? "lightning-solid" : "lightning"}
              tone={props.controller.autoTranslate() ? "foreground" : "muted-foreground"}
              class="size-3.5"
            />
          </Button>
          <QuickTranslateAddPresetMenu session={session} />
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
              <Icon name="scanning" tone="muted-foreground" class="size-3.5" />
            </Button>
          </If>
        </View>
        <View desktop={{ windowDrag: false }} class="flex-row items-center gap-1">
          <Button
            testID="quick-translate-pin"
            variant="ghost"
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
              name={props.controller.isPinned() ? "pin-solid" : "pin"}
              tone={props.controller.isPinned() ? "foreground" : "muted-foreground"}
              class="size-3.5"
            />
          </Button>
          <If when={titleBar().right === 0}>
            <Button
              testID="quick-translate-close"
              variant="ghost"
              size="icon-sm"
              tooltip={t("quickTranslate.close")}
              accessibilityLabel={t("quickTranslate.close")}
              onPress={() => props.controller.close()}
            >
              <Icon name="close" tone="muted-foreground" class="size-3.5" />
            </Button>
          </If>
        </View>
      </View>
      <Scroll class="min-h-0 flex-1">
        {/* Measure the natural content height, not the scroll viewport. */}
        <View class="shrink-0" onLayout={({ bounds }) => contentHeight.set(bounds.size.height)}>
          <QuickTranslatePopup
            session={session}
            ocrState={props.controller.ocrState}
            onAttachSourceInput={(node) => props.controller.attachSourceInput(node)}
          />
        </View>
      </Scroll>
    </View>
  );
}

/** Floating Stage 1/2 Quick Translate window controlled by the app shell. */
export function QuickTranslateWindow(props: { controller: QuickTranslateController }) {
  effect(() => {
    const win = props.controller.attachedWindow();
    const state = win?.state();
    if (state) {
      props.controller.verifyInitialBounds(state);
    }
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
      activate={true}
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
      <QuickTranslateWindowBody controller={props.controller} />
    </Window>
  );
}
