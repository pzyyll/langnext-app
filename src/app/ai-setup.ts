import { initializeContributions } from "./contributions-setup";

/**
 * Backwards-compatible entry for isolated feature tests. It now populates the
 * unified contribution registry, including the AI modules registered by
 * `contributions-setup.ts`.
 */
export function initializeAiModules(): void {
  initializeContributions();
}
