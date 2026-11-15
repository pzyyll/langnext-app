import { signal, View } from "nsh";
import { titleBar } from "nsh/desktop";
import { AppMenu } from "../components/app-menu";
import { PageSurface } from "../components/page-surface";
import { Sidebar, type SidebarPage } from "../components/sidebar";
import { HomePage } from "../features/home/page";
import { ModelsPage } from "../features/models/page";
import { SettingsPage } from "../features/settings/page";

/** The app bar's height, which the platform centers the system's window
 * controls in: the same value as `window.titleBar.height` in nsh.json. */
const TITLE_BAR_HEIGHT = 42;

export function AppShell() {
  const page = signal<SidebarPage>("home");
  const selectHome = () => page.set("home");
  const selectModels = () => page.set("models");
  const selectSettings = () => page.set("settings");

  return (
    <View class="flex-1 bg-background">
      <View
        testID="title-bar"
        desktop={{ windowDrag: true }}
        class="flex-row items-center border-b border-sidebar-border bg-sidebar"
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
        <Sidebar
          page={page()}
          onSelectHome={selectHome}
          onSelectModels={selectModels}
          onSelectSettings={selectSettings}
        />
        <If when={page() === "home"}>
          <PageSurface>
            <HomePage />
          </PageSurface>
        </If>
        <If when={page() === "models"}>
          <PageSurface>
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
