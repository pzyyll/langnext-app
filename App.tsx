import { mount } from "nsh";
import { initializeAiModules } from "./app/ai-setup";
import { AppShell } from "./app/shell";
import { loadSplitRailWidths } from "./components/layout/split-rail";
import { loadModelsState } from "./features/models/store";
import { presetsStore } from "./features/presets/store";
import { loadQuickTranslatePreferences } from "./features/quick-translate/preferences";
import { loadAppearance } from "./features/settings/appearance";
import { loadLanguage } from "./features/settings/language";
import { loadTransparency } from "./features/settings/transparency";

async function startApp() {
  initializeAiModules();
  await Promise.all([
    loadAppearance(),
    loadLanguage(),
    loadTransparency(),
    loadQuickTranslatePreferences(),
    loadModelsState(),
    presetsStore.load(),
    loadSplitRailWidths(),
  ]);
  mount(AppShell);
}

void startApp();
