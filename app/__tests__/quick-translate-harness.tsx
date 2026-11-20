import { keymap, mount, signal, Storage, Text, View } from "nsh";
import { Tray, Window, type MenuItem, type TrayOptions } from "nsh/desktop";
import { t } from "nsh/i18n";
import { loadSplitRailWidths } from "../../components/layout/split-rail";
import { Button } from "../../components/ui/button";
import { loadModelsState } from "../../features/models/store";
import { ocrSettingsStore } from "../../features/ocr/settings";
import { presetsStore } from "../../features/presets/store";
import { loadQuickTranslatePreferences } from "../../features/quick-translate/preferences";
import { loadAppearance } from "../../features/settings/appearance";
import { loadLanguage } from "../../features/settings/language";
import { loadTransparency } from "../../features/settings/transparency";
import type { DoubleCopyActivationEvent } from "../../platform/quick-translate";
import { initializeAiModules } from "../ai-setup";
import { QUICK_TRANSLATE_SHORTCUT } from "../quick-translate";
import { AppShell } from "../shell";

initializeAiModules();

export const HARNESS_SHORTCUT_MODE_KEY = "__test.qt.shortcutMode";
export const HARNESS_PLATFORM_OS_KEY = "__test.qt.platformOs";
export const HARNESS_DOUBLE_COPY_MODE_KEY = "__test.qt.doubleCopyMode";
export const HARNESS_DOUBLE_COPY_CLIPBOARD_KEY = "__test.qt.doubleCopyClipboard";
export const HARNESS_OCR_CAPTURE_KEY = "__test.qt.ocrCapture";

/** Smallest valid PNG: what the OS capture boundary returns for a confirmed selection. */
const HARNESS_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

type HarnessCaptureMode = "png" | "cancel" | "tooLarge" | "fail";

type ActionMenuItem = Exclude<MenuItem, { type: "separator" }>;

function isActionMenuItem(entry: MenuItem | null | undefined | false): entry is ActionMenuItem {
  return Boolean(entry && typeof entry === "object" && "label" in entry);
}

function QuickTranslateHarness(config: {
  shortcutMode: "ok" | "false" | "reject";
  doubleCopyMode: "ok" | "throw";
  initialClipboard: string;
  platformOs?: string;
  ocrCapture: HarnessCaptureMode;
}) {
  let latestTray: TrayOptions | null = null;
  let registeredCallback: (() => void) | null = null;
  let doubleCopyListener: ((event: DoubleCopyActivationEvent) => void) | null = null;
  let nextClipboardText = config.initialClipboard;
  const shellMounted = signal(true);
  const registerCount = signal(0);
  const unregisterCount = signal(0);
  const doubleCopyRegisterCount = signal(0);
  const doubleCopyStopCount = signal(0);
  const pointerPressRegisterCount = signal(0);
  const pointerPressStopCount = signal(0);
  const clipboardReadCount = signal(0);
  const trayMenuLabels = signal("");
  const lastRegisteredShortcut = signal("");
  const ocrCaptureCount = signal(0);
  const ocrCaptureCaption = signal("");
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
          quickTranslateOptions={{
            readClipboardText: async () => {
              clipboardReadCount.set(clipboardReadCount() + 1);
              return nextClipboardText;
            },
            captureRegion: async ({ overlay }) => {
              ocrCaptureCount.set(ocrCaptureCount() + 1);
              ocrCaptureCaption.set(overlay.caption);
              if (config.ocrCapture === "cancel") return { status: "cancelled" };
              if (config.ocrCapture === "tooLarge") return { status: "tooLarge" };
              if (config.ocrCapture === "fail") return { status: "failed" };
              return {
                status: "captured",
                png: Uint8Array.from(Buffer.from(HARNESS_PNG_BASE64, "base64")),
              };
            },
            onPointerPress() {
              pointerPressRegisterCount.set(pointerPressRegisterCount() + 1);
              return () => {
                pointerPressStopCount.set(pointerPressStopCount() + 1);
              };
            },
          }}
          doubleCopy={{
            onDoubleCopy(listener) {
              doubleCopyRegisterCount.set(doubleCopyRegisterCount() + 1);
              if (config.doubleCopyMode === "throw") {
                throw new Error("raw input unavailable");
              }
              doubleCopyListener = listener;
              return () => {
                doubleCopyStopCount.set(doubleCopyStopCount() + 1);
                if (doubleCopyListener === listener) {
                  doubleCopyListener = null;
                }
              };
            },
          }}
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
        <Button
          testID="harness-trigger-double-copy-valid"
          label="Harness Double Copy Valid"
          size="sm"
          onPress={() => doubleCopyListener?.({ hasValidCopy: true })}
        />
        <Button
          testID="harness-trigger-double-copy-invalid"
          label="Harness Double Copy Invalid"
          size="sm"
          onPress={() => doubleCopyListener?.({ hasValidCopy: false })}
        />
        <Button
          testID="harness-set-clipboard-empty"
          label="Harness Clipboard Empty"
          size="sm"
          onPress={() => {
            nextClipboardText = "";
          }}
        />
        <Button
          testID="harness-set-clipboard-second"
          label="Harness Clipboard Second"
          size="sm"
          onPress={() => {
            nextClipboardText = "Second copied phrase";
          }}
        />
        <Text>
          {(() => {
            const work = Window.get("quick-translate")?.state()?.display?.visibleBounds;
            return work ? `quick-work-area:${work.origin.y}:${work.size.height}` : "";
          })()}
        </Text>
        <Text testID="harness-metrics">
          {`ocrCap=${ocrCaptureCount()}|ocrCaption=${ocrCaptureCaption()}|reg=${registerCount()}|unreg=${unregisterCount()}|dcReg=${doubleCopyRegisterCount()}|dcStop=${doubleCopyStopCount()}|dcReads=${clipboardReadCount()}|ppReg=${pointerPressRegisterCount()}|ppStop=${pointerPressStopCount()}|shortcut=${lastRegisteredShortcut()}|tray=${trayMenuLabels()}|mainHidden=${mainHidden()}`}
        </Text>
      </View>
    </View>
  );
}

void Promise.all([
  loadAppearance(),
  loadLanguage(),
  loadTransparency(),
  loadQuickTranslatePreferences(),
  loadModelsState(),
  ocrSettingsStore.load(),
  presetsStore.load(),
  loadSplitRailWidths(),
  Storage.getItem(HARNESS_SHORTCUT_MODE_KEY),
  Storage.getItem(HARNESS_PLATFORM_OS_KEY),
  Storage.getItem(HARNESS_DOUBLE_COPY_MODE_KEY),
  Storage.getItem(HARNESS_DOUBLE_COPY_CLIPBOARD_KEY),
  Storage.getItem(HARNESS_OCR_CAPTURE_KEY),
]).then(([, , , , , , , , modeRaw, osRaw, dcModeRaw, dcClipboardRaw, ocrCaptureRaw]) => {
  const shortcutMode = modeRaw === "false" || modeRaw === "reject" ? modeRaw : "ok";
  const doubleCopyMode = dcModeRaw === "throw" ? "throw" : "ok";
  const initialClipboard = dcClipboardRaw ?? "";
  const platformOs = osRaw || undefined;
  const ocrCapture: HarnessCaptureMode =
    ocrCaptureRaw === "cancel" || ocrCaptureRaw === "tooLarge" || ocrCaptureRaw === "fail"
      ? ocrCaptureRaw
      : "png";
  mount(() => (
    <QuickTranslateHarness
      shortcutMode={shortcutMode}
      doubleCopyMode={doubleCopyMode}
      initialClipboard={initialClipboard}
      platformOs={platformOs}
      ocrCapture={ocrCapture}
    />
  ));
});
