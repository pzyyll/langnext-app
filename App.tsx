import { mount, platform } from "nsh";
import { initializeIntegrations } from "./src/app/integrations-setup";
import { AppShell } from "./src/app/shell";
import { StartupError, startupFailureMessage } from "./src/app/startup-error";
import { loadSplitRailWidths } from "./src/components/layout/split-rail";
import { languageDetectionPreferences } from "./src/features/language-detection/preferences";
import { detectChannels } from "./src/features/language-detection/store";
import { loadModelsState } from "./src/features/models/store";
import { ocrChannels } from "./src/features/ocr/store";
import { cleanupTtsPlaybackFiles } from "./src/features/tts/playback";
import { ttsChannels } from "./src/features/tts/store";
import { wordbookSettingsStore } from "./src/features/wordbook/settings";
import { loadSkippedNoticeDismissal } from "./src/features/presets/skipped-notice";
import { presetsStore } from "./src/features/presets/store";
import { loadQuickTranslatePreferences } from "./src/features/quick-translate/preferences";
import { loadAppearance } from "./src/features/settings/appearance";
import { loadLanguage } from "./src/features/settings/language";
import { loadLogLevel } from "./src/features/settings/log-level";
import { loadSentenceAlignment } from "./src/features/settings/quick-translate";
import { loadSelectionCopy } from "./src/features/settings/selection-copy";
import { loadSelectionHint } from "./src/features/settings/selection-hint";
import { loadSilentLaunch } from "./src/features/settings/silent-launch";
import { loadTransparency } from "./src/features/settings/transparency";
import { createLogger, logFile } from "./src/services/log";

const log = createLogger("app");

async function startApp() {
  try {
    await loadLogLevel();
    log.info(`Started on ${platform.os}; logs go to ${logFile() ?? "the platform's log"}`);
    initializeIntegrations();
    try {
      await cleanupTtsPlaybackFiles();
    } catch {
      // Best-effort. A missing data directory must not keep the shell from mounting.
    }
    await Promise.all([
      loadAppearance(),
      loadLanguage(),
      loadSentenceAlignment(),
      loadSelectionCopy(),
      loadSelectionHint(),
      loadSilentLaunch(),
      loadTransparency(),
      loadQuickTranslatePreferences(),
      loadModelsState(),
      presetsStore.load(),
      loadSkippedNoticeDismissal(),
      languageDetectionPreferences.load(),
      detectChannels.load(),
      ocrChannels.load(),
      ttsChannels.load(),
      wordbookSettingsStore.load(),
      loadSplitRailWidths(),
    ]);
    mount(AppShell);
  } catch (error) {
    // Window model v2 opens no window until the app declares one, so the
    // failure gets a window of its own: a failed start is never invisible.
    log.error("Could not start the app", error);
    mount(StartupError, { message: startupFailureMessage(error) });
  }
}

void startApp();
