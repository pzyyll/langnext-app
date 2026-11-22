import { mount } from "nsh";
import { Window } from "nsh/desktop";
import { initializeAiModules } from "./app/ai-setup";
import { AppShell } from "./app/shell";
import { loadSplitRailWidths } from "./components/layout/split-rail";
import { languageDetectionStore } from "./features/language-detection/settings";
import { loadModelsState } from "./features/models/store";
import { ocrSettingsStore } from "./features/ocr/settings";
import { ttsSettingsStore } from "./features/tts/settings";
import { loadSkippedNoticeDismissal } from "./features/presets/skipped-notice";
import { presetsStore } from "./features/presets/store";
import { loadQuickTranslatePreferences } from "./features/quick-translate/preferences";
import { loadAppearance } from "./features/settings/appearance";
import { loadLanguage } from "./features/settings/language";
import { loadSelectionCopy } from "./features/settings/selection-copy";
import { loadSilentLaunch } from "./features/settings/silent-launch";
import { loadTransparency } from "./features/settings/transparency";

async function startApp() {
  initializeAiModules();
  try {
    await Promise.all([
      loadAppearance(),
      loadLanguage(),
      loadSelectionCopy(),
      loadSilentLaunch(),
      loadTransparency(),
      loadQuickTranslatePreferences(),
      loadModelsState(),
      presetsStore.load(),
      loadSkippedNoticeDismissal(),
      languageDetectionStore.load(),
      ocrSettingsStore.load(),
      ttsSettingsStore.load(),
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
