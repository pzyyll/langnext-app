// ABOUTME: The app's only integration assembly entry; startup calls it once.
// ABOUTME: It registers every compiled-in definition and rejects an inconsistent registry.
import { getIntegrationRegistry, type Diagnostic } from "../framework/integrations";
import { registerAiIntegrations } from "../integrations/ai";
import { registerDetectIntegrations } from "../integrations/detect";
import { registerOcrIntegrations } from "../integrations/ocr";
import { ttsChannelDefinitions } from "../integrations/tts";
import { createLogger } from "../services/log";

const log = createLogger("app/integrations");

const initialized = new WeakSet<object>();

function diagnosticSummary(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map((entry) => entry.message).join(" ");
}

/**
 * Populates the production registry once per registry instance. Startup errors
 * throw, so `App.tsx` shows them instead of running with a broken assembly.
 */
export function initializeIntegrations(): void {
  const registry = getIntegrationRegistry();
  if (initialized.has(registry)) return;
  registerAiIntegrations(registry);
  registerOcrIntegrations(registry);
  registerDetectIntegrations(registry);
  for (const definition of ttsChannelDefinitions) {
    registry.registerCapability(definition);
  }
  const diagnostics = registry.diagnostics();
  if (diagnostics.length > 0) {
    log.error("Integration registry is inconsistent", diagnostics);
    throw new Error(diagnosticSummary(diagnostics));
  }
  initialized.add(registry);
}
