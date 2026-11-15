import { mount } from "nsh";
import { AppShell } from "./app/shell";
import { loadAppearance } from "./features/settings/appearance";

async function startApp() {
  await loadAppearance();
  mount(AppShell);
}

void startApp();
