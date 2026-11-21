import { mount } from "nsh";
import { initializeAiModules } from "./app/ai-setup";
import { AppShell } from "./app/shell";
import { loadSplitRailWidths } from "./components/layout/split-rail";
import { languageDetectionStore } from "./features/language-detection/settings";
import { loadModelsState } from "./features/models/store";
import { ocrSettingsStore } from "./features/ocr/settings";
import { loadSkippedNoticeDismissal } from "./features/presets/skipped-notice";
import { presetsStore } from "./features/presets/store";
import { loadQuickTranslatePreferences } from "./features/quick-translate/preferences";
import { loadAppearance } from "./features/settings/appearance";
import { loadLanguage } from "./features/settings/language";
import { loadSelectionCopy } from "./features/settings/selection-copy";
import { loadTransparency } from "./features/settings/transparency";

async function startApp() {
  initializeAiModules();
  await Promise.all([
    loadAppearance(),
    loadLanguage(),
    loadSelectionCopy(),
    loadTransparency(),
    loadQuickTranslatePreferences(),
    loadModelsState(),
    presetsStore.load(),
    loadSkippedNoticeDismissal(),
    languageDetectionStore.load(),
    ocrSettingsStore.load(),
    loadSplitRailWidths(),
  ]);
  mount(AppShell);
}

void startApp();
