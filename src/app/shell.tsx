import { cleanup, effect, platform, signal, untracked, View } from "nsh";
import {
  Application,
  currentWindow,
  displays,
  titleBar,
  Tray,
  Window,
  type TrayOptions,
} from "nsh/desktop";
import { t } from "nsh/i18n";
import trayIcon from "../../assets/logos/icon.svg";
import { AppMenu } from "../components/app-menu";
import { PageSurface } from "../components/layout/page-surface";
import type { NavigationLeaveGuard } from "../components/layout/navigation-leave-guard";
import { Sidebar, type SidebarPage } from "../components/sidebar";
import { toast, ToastViewport } from "../components/ui/toast";
import { ModelsPage } from "../features/models/page";
import { PresetsPage } from "../features/presets/page";
import { SettingsPage } from "../features/settings/page";
import {
  formatShortcut,
  type TranslationShortcutBinding,
  type TranslationShortcutId,
  type TranslationShortcutSetting,
} from "../features/settings/shortcuts";
import { silentLaunch } from "../features/settings/silent-launch";
import { transparency } from "../features/settings/transparency";
import {
  canDetectSelectionDrag,
  resolveSelectionHintPlacement,
  type DoubleCopyBinding,
  type PointerPressPoint,
  type SelectionGestureBinding,
  type SelectionGestureEvent,
} from "../platform/quick-translate";
import { nativeSelectionGestureBinding } from "../platform/quick-translate-native";
import {
  registerSelectionHintRuntime,
  selectionHintActive,
  selectionHintError,
} from "../features/settings/selection-hint";
import { canCaptureScreen } from "../platform/screen-capture";
import { applyTaskbarIcon } from "../platform/taskbar-icon";
import {
  createQuickTranslateController,
  QuickTranslateWindow,
  registerQuickTranslateDoubleCopy,
  registerTranslationShortcuts,
  type QuickTranslateControllerOptions,
} from "./quick-translate";
import {
  SELECTION_HINT_SIZE,
  SelectionHintWindow,
  type SelectionHintCandidate,
} from "./selection-hint";

/** The app bar's height, which the platform centers the system's window
 * controls in: the same value as `window.titleBar.height` in nsh.json. */
const TITLE_BAR_HEIGHT = 42;

export interface AppShellProps {
  globalShortcut?: TranslationShortcutBinding;
  doubleCopy?: DoubleCopyBinding;
  /** Left-button presses and possible text drags; unregistered until the opt-in is on. */
  selectionGesture?: SelectionGestureBinding;
  trayModule?: Pick<typeof Tray, "set">;
  platformOs?: string;
  quickTranslateOptions?: QuickTranslateControllerOptions;
}

export interface ShellTrayOptions {
  /** Opens the Quick Translate popup over the clipboard text. */
  onQuickTranslate: () => void;
  /** Starts the Screenshot Translate region selection. */
  onScreenshotTranslate: () => void;
  /** Hides the Screenshot Translate item where the platform has no screen selection. */
  canScreenshotTranslate: boolean;
}

/** Builds system tray configuration using the active locale. */
export function buildShellTrayOptions(options: ShellTrayOptions): TrayOptions {
  return {
    icon: trayIcon,
    tooltip: t("app.name"),
    onClick: () => Window.get("main")?.focus(),
    menu: [
      { label: t("tray.quickTranslate"), onSelect: options.onQuickTranslate },
      options.canScreenshotTranslate && {
        label: t("tray.screenshotTranslate"),
        onSelect: options.onScreenshotTranslate,
      },
      { label: t("tray.exit"), onSelect: () => Application.quit() },
    ],
  };
}

export function AppShell(props: AppShellProps = {}) {
  const quickTranslate = createQuickTranslateController(props.quickTranslateOptions);
  const trayApi = props.trayModule ?? Tray;
  const currentOs = props.platformOs ?? platform.os;

  // The popup's global press monitor runs only while it is open: disposal closes it.
  cleanup(() => quickTranslate.close());

  effect(() => {
    trayApi.set(
      buildShellTrayOptions({
        onQuickTranslate: () => quickTranslate.open(),
        onScreenshotTranslate: () => void quickTranslate.startOcr(),
        canScreenshotTranslate: canCaptureScreen(currentOs),
      }),
    );
  });
  const shortcuts = registerTranslationShortcuts(quickTranslate, props.globalShortcut, currentOs);
  registerQuickTranslateDoubleCopy(
    quickTranslate,
    props.doubleCopy,
    currentOs,
    shortcuts?.isRecordingInForeground,
  );

  const selectionHint = signal<SelectionHintCandidate | null>(null);
  const selectionHintPress = signal<PointerPressPoint | null>(null);
  const selectionShortcutLabel = () => {
    const chord = shortcuts?.settings["selection-translate"].shortcut() ?? null;
    return chord === null ? null : formatShortcut(chord);
  };

  // The hint shows only where a display resolves; the press that began the drag never dismisses it.
  const handleSelectionGesture = (event: SelectionGestureEvent) => {
    if (event.kind === "press") {
      selectionHintPress.set(event.press);
      return;
    }
    const placement = resolveSelectionHintPlacement(event.release, displays(), SELECTION_HINT_SIZE);
    if (placement === null) return;
    selectionHintPress.set(null);
    selectionHint.set({ release: event.release, target: event.target, ...placement });
  };

  /** Starts the one listener the opt-in allows; a refusal leaves the feature off. */
  const startSelectionGesture = (): (() => void) => {
    if (props.selectionGesture) {
      return props.selectionGesture.onSelectionGesture(handleSelectionGesture);
    }
    if (!canDetectSelectionDrag(currentOs)) {
      throw new Error("Selection drag monitoring is not available on this platform.");
    }
    return nativeSelectionGestureBinding.onSelectionGesture(handleSelectionGesture);
  };

  const stopSelectionHint = registerSelectionHintRuntime({
    os: currentOs,
    start: startSelectionGesture,
  });
  const stopSelectionHintQuit = Application.on("quit", stopSelectionHint);
  cleanup(() => {
    stopSelectionHintQuit();
    stopSelectionHint();
    selectionHint.set(null);
  });

  // Disabling the opt-in hides a hint the stopped listener left behind.
  effect(() => {
    if (!selectionHintActive()) selectionHint.set(null);
  });

  // A listener that cannot start says so once, after the first frame can show the toast.
  let reportedSelectionHintError: string | null = null;
  effect(() => {
    const message = selectionHintError();
    if (message === null || message === reportedSelectionHintError) return;
    reportedSelectionHintError = message;
    const timer = setTimeout(() => toast.error(message), 0);
    cleanup(() => clearTimeout(timer));
  });

  // Quick Translate or its screenshot workflow takes the screen from the hint.
  effect(() => {
    if (selectionHint() === null) return;
    if (quickTranslate.isOpen() || quickTranslate.ocrState().phase !== "idle") {
      selectionHint.set(null);
    }
  });

  return [
    <Window id="main">
      <MainWindow platformOs={currentOs} shortcuts={shortcuts?.settings} />
    </Window>,
    <SelectionHintWindow
      hint={selectionHint}
      press={selectionHintPress}
      shortcut={selectionShortcutLabel}
      onTranslate={(target) => void quickTranslate.activateSelectionFromHint(target)}
      onDismiss={() => selectionHint.set(null)}
    />,
    <QuickTranslateWindow controller={quickTranslate} />,
  ];
}

function MainWindow(props: {
  platformOs: string;
  shortcuts?: Record<TranslationShortcutId, TranslationShortcutSetting>;
}) {
  const win = currentWindow();
  effect(() => win.set({ backdrop: transparency() ? "popover" : "none" }));
  // Every way of closing the main window keeps the app in the background: the
  // close button, Alt+F4, the taskbar and the window menu hide it. Only the
  // tray's Exit quits, and the tray icon brings the window back.
  win.set({ closeOnPress: false });
  win.on("closePress", () => win.hide());
  effect(() => {
    // A declared window opens visible. Hide a silent launch once and leave it
    // to the tray; show a normal launch. Read once, so toggling the setting
    // later never shows a window the user hid.
    const silent = untracked(silentLaunch);
    if (silent) win.hide();
    else win.show();
  });
  effect(() => {
    // Windows draws a window's taskbar button by the window's own icon, and
    // NSH puts the app's icon on its hidden host window only. The platform
    // reports the window once it shows it: its handle is there then.
    if (win.state() !== null) void applyTaskbarIcon();
  });

  const page = signal<SidebarPage>("models");
  let activeLeaveGuard: NavigationLeaveGuard | null = null;

  const registerLeaveGuard = (guard: NavigationLeaveGuard) => {
    activeLeaveGuard = guard;
    return () => {
      if (activeLeaveGuard === guard) {
        activeLeaveGuard = null;
      }
    };
  };

  const navigateTo = (nextPage: SidebarPage) => {
    if (page() === nextPage) return;
    const proceed = () => page.set(nextPage);
    if (activeLeaveGuard && !activeLeaveGuard(proceed)) {
      return;
    }
    proceed();
  };

  const selectModels = () => navigateTo("models");
  const selectPresets = () => navigateTo("presets");
  const selectSettings = () => navigateTo("settings");

  return (
    <View class="flex-1 bg-sidebar" classList={{ "bg-sidebar/80": transparency() }}>
      <View
        testID="title-bar"
        desktop={{ windowDrag: true }}
        class="flex-row items-center"
        // Runtime platform titleBar() insets determine height and horizontal clearance.
        style={{
          height: Math.max(TITLE_BAR_HEIGHT, titleBar().height),
          paddingLeft: titleBar().left,
          paddingRight: titleBar().right + 16,
        }}
      >
        <View class="w-14 shrink-0 items-center">
          <AppMenu />
        </View>
      </View>
      <View class="flex-1 flex-row">
        <Sidebar
          page={page()}
          onSelectModels={selectModels}
          onSelectPresets={selectPresets}
          onSelectSettings={selectSettings}
        />
        <If when={page() === "models"}>
          <PageSurface testID="models-page" layout="split">
            <ModelsPage onRegisterLeaveGuard={registerLeaveGuard} />
          </PageSurface>
        </If>
        <If when={page() === "presets"}>
          <PageSurface testID="presets-page" layout="split">
            <PresetsPage
              onRegisterLeaveGuard={registerLeaveGuard}
              onNavigateToModels={selectModels}
            />
          </PageSurface>
        </If>
        <If when={page() === "settings"}>
          <PageSurface testID="settings-page" layout="split">
            <SettingsPage
              platformOs={props.platformOs}
              onNavigateToModels={selectModels}
              onRegisterLeaveGuard={registerLeaveGuard}
              shortcuts={props.shortcuts}
            />
          </PageSurface>
        </If>
      </View>
      <ToastViewport />
    </View>
  );
}
