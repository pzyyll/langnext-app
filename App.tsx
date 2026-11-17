import { mount } from "nsh";
import { AppShell } from "./app/shell";
import { loadModelsState } from "./features/models/store";
import { loadAppearance } from "./features/settings/appearance";
import { loadLanguage } from "./features/settings/language";
import { loadTransparency } from "./features/settings/transparency";

async function startApp() {
  await Promise.all([loadAppearance(), loadLanguage(), loadTransparency(), loadModelsState()]);
  mount(AppShell);
}

void startApp();
