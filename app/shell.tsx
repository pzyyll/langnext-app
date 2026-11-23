import { cleanup, effect, platform, signal, untracked, View } from "nsh";
import { Application, currentWindow, titleBar, Tray, Window, type TrayOptions } from "nsh/desktop";
import { t } from "nsh/i18n";
import trayIcon from "../assets/logos/icon.svg";
import { AppMenu } from "../components/app-menu";
import { PageSurface } from "../components/layout/page-surface";
import type { NavigationLeaveGuard } from "../components/layout/navigation-leave-guard";
import { Sidebar, type SidebarPage } from "../components/sidebar";
import { ToastViewport } from "../components/ui/toast";
import { ModelsPage } from "../features/models/page";
import { PresetsPage } from "../features/presets/page";
import { SettingsPage } from "../features/settings/page";
import type { TranslationShortcutBinding } from "../features/settings/shortcuts";
import { silentLaunch } from "../features/settings/silent-launch";
import { transparency } from "../features/settings/transparency";
import type { DoubleCopyBinding } from "../platform/quick-translate";
import {
  createQuickTranslateController,
  QuickTranslateWindow,
  registerQuickTranslateDoubleCopy,
  registerTranslationShortcuts,
  type QuickTranslateControllerOptions,
} from "./quick-translate";

/** The app bar's height, which the platform centers the system's window
 * controls in: the same value as `window.titleBar.height` in nsh.json. */
const TITLE_BAR_HEIGHT = 42;

export interface AppShellProps {
  globalShortcut?: TranslationShortcutBinding;
  doubleCopy?: DoubleCopyBinding;
  trayModule?: Pick<typeof Tray, "set">;
  platformOs?: string;
  quickTranslateOptions?: QuickTranslateControllerOptions;
}

/** Builds system tray configuration using the active locale. */
export function buildShellTrayOptions(onQuickTranslate: () => void): TrayOptions {
  return {
    icon: trayIcon,
    tooltip: "My Translator",
    onClick: () => Window.get("main")?.focus(),
    menu: [
      { label: t("tray.quickTranslate"), onSelect: onQuickTranslate },
      { label: t("tray.exit"), onSelect: () => Application.quit() },
    ],
  };
}

export function AppShell(props: AppShellProps = {}) {
  const quickTranslate = createQuickTranslateController(props.quickTranslateOptions);
  const trayApi = props.trayModule ?? Tray;

  // The popup's global press monitor runs only while it is open: disposal closes it.
  cleanup(() => quickTranslate.close());

  effect(() => {
    trayApi.set(buildShellTrayOptions(() => quickTranslate.open()));
  });

  const currentOs = props.platformOs ?? platform.os;
  const shortcuts = registerTranslationShortcuts(quickTranslate, props.globalShortcut, currentOs);
  registerQuickTranslateDoubleCopy(
    quickTranslate,
    props.doubleCopy,
    currentOs,
    shortcuts?.isRecordingInForeground,
  );

  const win = currentWindow();
  effect(() => win.set({ backdrop: transparency() ? "popover" : "none" }));
  // Every way of closing the main window keeps the app in the background: the
  // close button, Alt+F4, the taskbar and the window menu hide it. Only the
  // tray's Exit quits, and the tray icon brings the window back.
  win.set({ closeOnPress: false });
  win.on("closePress", () => win.hide());
  effect(() => {
    // nsh.json opens the main window hidden: a normal launch shows it, and a
    // silent one leaves it to the tray icon. Read once, so toggling the
    // setting later never shows a window the user hid.
    const silent = untracked(silentLaunch);
    if (!silent) win.show();
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
              platformOs={currentOs}
              onNavigateToModels={selectModels}
              shortcuts={shortcuts?.settings}
            />
          </PageSurface>
        </If>
      </View>
      <ToastViewport />
      <QuickTranslateWindow controller={quickTranslate} />
    </View>
  );
}
