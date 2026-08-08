// ABOUTME: Happy DOM environment registration for Bun component tests.
// ABOUTME: Imported explicitly by DOM test modules; resetDom() clears DOM + Testing Library state.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let registered = false;
if (!registered) {
  GlobalRegistrator.register();
  registered = true;
}

/** Reset Testing Library mounted components and the shared document after each test. */
export function resetDom(): void {
  document.body.replaceChildren();
}
