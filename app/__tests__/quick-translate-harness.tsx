import { keymap, mount, signal, Storage, Text, View } from "nsh";
import { Tray, Window, type MenuItem, type TrayOptions } from "nsh/desktop";
import { t } from "nsh/i18n";
import { loadSplitRailWidths } from "../../components/layout/split-rail";
import { Button } from "../../components/ui/button";
import { loadModelsState } from "../../features/models/store";
import { presetsStore } from "../../features/presets/store";
import { loadAppearance } from "../../features/settings/appearance";
import { loadLanguage } from "../../features/settings/language";
import { loadTransparency } from "../../features/settings/transparency";
import { initializeAiModules } from "../ai-setup";
import { QUICK_TRANSLATE_SHORTCUT } from "../quick-translate";
import { AppShell } from "../shell";

initializeAiModules();

export const HARNESS_SHORTCUT_MODE_KEY = "__test.qt.shortcutMode";
export const HARNESS_PLATFORM_OS_KEY = "__test.qt.platformOs";

type ActionMenuItem = Exclude<MenuItem, { type: "separator" }>;

function isActionMenuItem(entry: MenuItem | null | undefined | false): entry is ActionMenuItem {
  return Boolean(entry && typeof entry === "object" && "label" in entry);
}

function QuickTranslateHarness(config: {
  shortcutMode: "ok" | "false" | "reject";
  platformOs?: string;
}) {
  let latestTray: TrayOptions | null = null;
  let registeredCallback: (() => void) | null = null;
  const shellMounted = signal(true);
  const registerCount = signal(0);
  const unregisterCount = signal(0);
  const trayMenuLabels = signal("");
  const lastRegisteredShortcut = signal("");
  const mainHidden = signal(false);

  const invokeTrayQuickTranslate = () => {
    const entry = (latestTray?.menu ?? [])
      .filter(isActionMenuItem)
      .find((item) => item.label === t("tray.quickTranslate"));
    entry?.onSelect?.();
  };

  keymap.bind(
    QUICK_TRANSLATE_SHORTCUT,
    () => {
      registeredCallback?.();
    },
    { when: "always" },
  );

  return (
    <View class="flex-1">
      <If when={shellMounted()}>
        <AppShell
          platformOs={config.platformOs}
          trayModule={{
            set(options) {
              if (options) {
                latestTray = options;
                const labels = (options.menu ?? [])
                  .filter(isActionMenuItem)
                  .map((item) => item.label ?? "")
                  .join(",");
                trayMenuLabels.set(labels);
              }
              Tray.set(options);
            },
          }}
          globalShortcut={{
            async register(shortcut, onPress) {
              registerCount.set(registerCount() + 1);
              lastRegisteredShortcut.set(shortcut);
              registeredCallback = onPress;
              if (config.shortcutMode === "false") {
                return false;
              }
              if (config.shortcutMode === "reject") {
                throw new Error("shortcut conflict");
              }
              return true;
            },
            unregister() {
              unregisterCount.set(unregisterCount() + 1);
            },
          }}
        />
      </If>
      <View class="flex-row flex-wrap gap-2 px-4 py-1">
        <Button
          testID="harness-tray-quick-translate"
          label="Harness Tray QT"
          size="sm"
          onPress={invokeTrayQuickTranslate}
        />
        <Button
          testID="harness-hide-main-tray-flow"
          label="Harness Hide Flow"
          size="sm"
          onPress={() => {
            Window.get("main")?.hide();
            mainHidden.set(true);
            setTimeout(() => {
              invokeTrayQuickTranslate();
              setTimeout(() => {
                const qtWin = Window.get("quick-translate");
                qtWin?.on("close", () => {
                  setTimeout(() => {
                    latestTray?.onClick?.({ bounds: null });
                    mainHidden.set(!(Window.get("main")?.state()?.visible ?? true));
                  }, 30);
                });
              }, 20);
            }, 20);
          }}
        />
        <Button
          testID="harness-dispose-shell"
          label="Harness Dispose Shell"
          size="sm"
          onPress={() => shellMounted.set(false)}
        />
        <Text testID="harness-metrics">
          {`reg=${registerCount()}|unreg=${unregisterCount()}|shortcut=${lastRegisteredShortcut()}|tray=${trayMenuLabels()}|mainHidden=${mainHidden()}`}
        </Text>
      </View>
    </View>
  );
}

void Promise.all([
  loadAppearance(),
  loadLanguage(),
  loadTransparency(),
  loadModelsState(),
  presetsStore.load(),
  loadSplitRailWidths(),
  Storage.getItem(HARNESS_SHORTCUT_MODE_KEY),
  Storage.getItem(HARNESS_PLATFORM_OS_KEY),
]).then(([, , , , , , modeRaw, osRaw]) => {
  const shortcutMode = modeRaw === "false" || modeRaw === "reject" ? modeRaw : "ok";
  const platformOs = osRaw || undefined;
  mount(() => <QuickTranslateHarness shortcutMode={shortcutMode} platformOs={platformOs} />);
});
