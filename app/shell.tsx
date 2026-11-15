import { keymap, signal, Text, View } from "nsh";
import { titleBar } from "nsh/desktop";
import { PageSurface } from "../components/page-surface";
import { Sidebar, SIDEBAR_SHORTCUTS, type SidebarPage } from "../components/sidebar";
import { HomePage } from "../features/home/page";
import { SettingsPage } from "../features/settings/page";

/** The app bar's height, which the platform centers the system's window
 * controls in: the same value as `window.titleBar.height` in nsh.json. */
const TITLE_BAR_HEIGHT = 42;

export function AppShell() {
  const page = signal<SidebarPage>("home");
  const selectHome = () => page.set("home");
  const selectSettings = () => page.set("settings");
  keymap.bind(SIDEBAR_SHORTCUTS.home, selectHome);
  keymap.bind(SIDEBAR_SHORTCUTS.settings, selectSettings);

  return (
    <View class="flex-1 bg-background">
      <View
        testID="title-bar"
        desktop={{ windowDrag: true }}
        class="flex-row items-center border-b border-sidebar-border bg-sidebar"
        style={{
          height: Math.max(TITLE_BAR_HEIGHT, titleBar().height),
          paddingLeft: Math.max(20, titleBar().left + 12),
          paddingRight: titleBar().right + 16,
        }}
      >
        <Text class="text-sm font-medium text-sidebar-foreground">My Translator</Text>
      </View>
      <View class="flex-1 flex-row">
        <Sidebar page={page()} onSelectHome={selectHome} onSelectSettings={selectSettings} />
        <If when={page() === "home"}>
          <PageSurface>
            <HomePage />
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
