import { initializeIntegrations } from "./integrations-setup";

/**
 * Backwards-compatible entry for isolated feature tests. It now populates the
 * unified integration registry, including the AI modules registered by
 * `integrations-setup.ts`.
 */
export function initializeAiModules(): void {
  initializeIntegrations();
}
