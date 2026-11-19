import { cleanup, Clipboard, effect, platform, Scroll, Text, View } from "nsh";
import { Application, GlobalShortcut, titleBar, Window } from "nsh/desktop";
import { t } from "nsh/i18n";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { toast } from "../components/ui/toast";
import { QuickTranslatePopup } from "../features/quick-translate/popup";
import {
  doubleCopyEnabled,
  registerDoubleCopyRuntime,
} from "../features/quick-translate/preferences";
import type { DoubleCopyBinding } from "../platform/quick-translate";
import { nativeDoubleCopyBinding, readCursorAnchor } from "../platform/quick-translate-native";
import {
  canRegisterGlobalQuickTranslateShortcut,
  createQuickTranslateController as createPureQuickTranslateController,
  POPUP_MIN_SIZE,
  QUICK_TRANSLATE_SHORTCUT,
  QUICK_TRANSLATE_WINDOW_ID,
  type QuickTranslateController,
  type QuickTranslateControllerOptions,
  type QuickTranslateShortcutBinding,
} from "./quick-translate-controller";

export {
  canRegisterGlobalQuickTranslateShortcut,
  QUICK_TRANSLATE_SHORTCUT,
  QUICK_TRANSLATE_WINDOW_ID,
  type QuickTranslateController,
  type QuickTranslateControllerOptions,
  type QuickTranslateShortcutBinding,
};

/** Creates the desktop Quick Translate controller backed by native cursor anchor and clipboard access. */
export function createQuickTranslateController(
  options: QuickTranslateControllerOptions = {},
): QuickTranslateController {
  return createPureQuickTranslateController({
    readCursorAnchor,
    readClipboardText: () => Clipboard.readText(),
    isDoubleCopyActive: doubleCopyEnabled,
    ...options,
  });
}

/** Registers `ctrl+shift+t` once on Windows and unregisters cleanly on shell disposal or quit. */
export function registerQuickTranslateShortcut(
  controller: QuickTranslateController,
  binding: QuickTranslateShortcutBinding = GlobalShortcut,
  currentOs: string = platform.os,
): () => void {
  if (!canRegisterGlobalQuickTranslateShortcut(currentOs)) {
    return () => {};
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    stopQuitListener();
    try {
      binding.unregister(QUICK_TRANSLATE_SHORTCUT);
    } catch {
      // Ignore cleanup failures while tearing down the shell.
    }
  };

  const stopQuitListener = Application.on("quit", release);
  cleanup(release);

  void (async () => {
    try {
      const accepted = await binding.register(QUICK_TRANSLATE_SHORTCUT, () => controller.open());
      if (!released && !accepted) {
        toast.warning(t("quickTranslate.shortcutUnavailable"));
      }
    } catch {
      if (!released) {
        toast.warning(t("quickTranslate.shortcutUnavailable"));
      }
    }
  })();

  return release;
}

/** Coordinates the Windows Raw Input double-copy listener with persisted opt-in preferences. */
export function registerQuickTranslateDoubleCopy(
  controller: QuickTranslateController,
  binding: DoubleCopyBinding = nativeDoubleCopyBinding,
  currentOs: string = platform.os,
): () => void {
  const stopRuntime = registerDoubleCopyRuntime({
    os: currentOs,
    start: () => binding.onDoubleCopy((event) => void controller.activateDoubleCopy(event)),
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

/** Renders popup contents inside `<Window>` so `titleBar()` reads this window's caption area. */
function QuickTranslateWindowBody(props: { controller: QuickTranslateController }) {
  const caption = titleBar();

  return (
    <View class="flex-1 bg-background text-foreground">
      <View
        testID="quick-translate-header"
        desktop={{ windowDrag: true }}
        class="shrink-0 flex-row items-center justify-between gap-2 border-b border-border bg-background pl-3"
        // Runtime platform titleBar() insets determine height and caption-button clearance.
        style={{
          height: Math.max(38, caption.height),
          paddingRight: caption.right + 8,
        }}
      >
        <Text class="text-xs font-medium text-foreground">{t("quickTranslate.title")}</Text>
        <View class="flex-row items-center gap-1">
          <Button
            testID="quick-translate-auto-toggle"
            variant="ghost"
            size="icon-sm"
            selected={props.controller.autoTranslate()}
            class={props.controller.autoTranslate() ? "bg-accent" : undefined}
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
          <Button
            testID="quick-translate-pin"
            variant="ghost"
            size="icon-sm"
            selected={props.controller.isPinned()}
            class={props.controller.isPinned() ? "bg-accent" : undefined}
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
        <QuickTranslatePopup
          sourceText={props.controller.sourceText}
          sourceDeliverySeq={props.controller.sourceDeliverySeq}
          onSourceTextChange={(text) => props.controller.setSourceText(text)}
          autoTranslate={props.controller.autoTranslate}
          onOverlayOpenChange={(menuId, open) => props.controller.setMenuOpen(menuId, open)}
          onAttachSourceInput={(node) => props.controller.attachSourceInput(node)}
        />
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
      titleBar={{ style: "hidden", height: 38 }}
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
      closeOnBlur={!props.controller.isPinned()}
      closeOnEscape={!props.controller.hasOpenOverlay()}
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
