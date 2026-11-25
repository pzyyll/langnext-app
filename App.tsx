import { mount, platform } from "nsh";
import { Window } from "nsh/desktop";
import { initializeAiModules } from "./src/app/ai-setup";
import { AppShell } from "./src/app/shell";
import { loadSplitRailWidths } from "./src/components/layout/split-rail";
import { languageDetectionStore } from "./src/features/language-detection/settings";
import { loadModelsState } from "./src/features/models/store";
import { ocrSettingsStore } from "./src/features/ocr/settings";
import { cleanupTtsPlaybackFiles } from "./src/features/tts/playback";
import { ttsSettingsStore } from "./src/features/tts/settings";
import { wordbookSettingsStore } from "./src/features/wordbook/settings";
import { loadSkippedNoticeDismissal } from "./src/features/presets/skipped-notice";
import { presetsStore } from "./src/features/presets/store";
import { loadQuickTranslatePreferences } from "./src/features/quick-translate/preferences";
import { loadAppearance } from "./src/features/settings/appearance";
import { loadLanguage } from "./src/features/settings/language";
import { loadLogLevel } from "./src/features/settings/log-level";
import { loadSelectionCopy } from "./src/features/settings/selection-copy";
import { loadSelectionHint } from "./src/features/settings/selection-hint";
import { loadSilentLaunch } from "./src/features/settings/silent-launch";
import { loadTransparency } from "./src/features/settings/transparency";
import { createLogger, logFile } from "./src/services/log";

const log = createLogger("app");

async function startApp() {
  await loadLogLevel();
  log.info(`Started on ${platform.os}; logs go to ${logFile() ?? "the platform's log"}`);
  initializeAiModules();
  try {
    try {
      await cleanupTtsPlaybackFiles();
    } catch {
      // Best-effort. A missing data directory must not keep the shell from mounting.
    }
    await Promise.all([
      loadAppearance(),
      loadLanguage(),
      loadSelectionCopy(),
      loadSelectionHint(),
      loadSilentLaunch(),
      loadTransparency(),
      loadQuickTranslatePreferences(),
      loadModelsState(),
      presetsStore.load(),
      loadSkippedNoticeDismissal(),
      languageDetectionStore.load(),
      ocrSettingsStore.load(),
      ttsSettingsStore.load(),
      wordbookSettingsStore.load(),
      loadSplitRailWidths(),
    ]);
    mount(AppShell);
  } catch (error) {
    // nsh.json opens the main window hidden and the shell shows it: a failed
    // start still shows it, so the app never stays invisible.
    Window.get("main")?.show();
    throw error;
  }
}

void startApp();
