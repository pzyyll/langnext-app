import { effect, signal, View } from "nsh";
import { Application, currentWindow, titleBar, Tray, Window } from "nsh/desktop";
import trayIcon from "../assets/logos/icon.svg";
import { AppMenu } from "../components/app-menu";
import { PageSurface } from "../components/layout/page-surface";
import { Sidebar, type SidebarPage } from "../components/sidebar";
import { ModelsPage } from "../features/models/page";
import { SettingsPage } from "../features/settings/page";
import { transparency } from "../features/settings/transparency";

/** The app bar's height, which the platform centers the system's window
 * controls in: the same value as `window.titleBar.height` in nsh.json. */
const TITLE_BAR_HEIGHT = 42;

/** Puts the app in the system tray: a primary press brings the window back,
 * and the menu's Exit quits it. Exit calls `Application.quit` and does not use
 * the `quit` role, which would also bind Alt+F4. The tray belongs to the shell,
 * so it lives as long as the app does. */
function installTray() {
  Tray.set({
    icon: trayIcon,
    tooltip: "My Translator",
    onClick: () => Window.get("main")?.focus(),
    menu: [{ label: "Exit", onSelect: () => Application.quit() }],
  });
}

export function AppShell() {
  installTray();

  const win = currentWindow();
  effect(() => win.set({ backdrop: transparency() ? "popover" : "none" }));

  const page = signal<SidebarPage>("models");
  const selectModels = () => page.set("models");
  const selectSettings = () => page.set("settings");

  return (
    <View class="flex-1 bg-sidebar" classList={{ "bg-sidebar/70": transparency() }}>
      <View
        testID="title-bar"
        desktop={{ windowDrag: true }}
        class="flex-row items-center"
        style={{
          height: Math.max(TITLE_BAR_HEIGHT, titleBar().height),
          paddingLeft: titleBar().left,
          paddingRight: titleBar().right + 16,
        }}
      >
        <View class="w-13 shrink-0 items-center">
          <AppMenu />
        </View>
      </View>
      <View class="flex-1 flex-row">
        <Sidebar page={page()} onSelectModels={selectModels} onSelectSettings={selectSettings} />
        <If when={page() === "models"}>
          <PageSurface testID="models-page">
            <ModelsPage />
          </PageSurface>
        </If>
        <If when={page() === "settings"}>
          <PageSurface>
            <SettingsPage />
          </PageSurface>
        </If>
      </View>
    </View>
  );
}
