// ABOUTME: The app's only contribution assembly entry; startup calls it once.
// ABOUTME: It registers every compiled-in contribution and rejects an inconsistent registry.
import { getContributionRegistry, type Diagnostic } from "../framework/contributions";
import { registerAiContributions } from "../contributions/ai";
import { registerDetectContributions } from "../contributions/detect";
import { registerOcrContributions } from "../contributions/ocr";
import { ttsChannelContributions } from "../contributions/tts";
import { createLogger } from "../services/log";

const log = createLogger("app/contributions");

const initialized = new WeakSet<object>();

function diagnosticSummary(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map((entry) => entry.message).join(" ");
}

/**
 * Populates the production registry once per registry instance. Startup errors
 * throw, so `App.tsx` shows them instead of running with a broken assembly.
 */
export function initializeContributions(): void {
  const registry = getContributionRegistry();
  if (initialized.has(registry)) return;
  registerAiContributions(registry);
  registerOcrContributions(registry);
  registerDetectContributions(registry);
  for (const contribution of ttsChannelContributions) {
    registry.registerCapability(contribution);
  }
  const diagnostics = registry.diagnostics();
  if (diagnostics.length > 0) {
    log.error("Contribution registry is inconsistent", diagnostics);
    throw new Error(diagnosticSummary(diagnostics));
  }
  initialized.add(registry);
}
