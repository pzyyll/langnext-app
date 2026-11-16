import { mount } from "nsh";
import { AppShell } from "./app/shell";
import { loadAppearance } from "./features/settings/appearance";
import { loadTransparency } from "./features/settings/transparency";

async function startApp() {
  await Promise.all([loadAppearance(), loadTransparency()]);
  mount(AppShell);
}

void startApp();
