// ABOUTME: One screenshot recognition over the enabled OCR channel definitions.
// ABOUTME: The PNG is validated once, then channels run in priority order through the shared chain.
import { t } from "nsh/i18n";
import type { OcrChannelOutcome, OcrRecognizeInput } from "../../integrations/ocr/recognition";
import {
  runChain,
  type CapabilityChannelDefinition,
  type ChannelBinding,
  type ChainStepOutcome,
  type CredentialRecord,
  type HostModels,
  type HostServices,
} from "../../framework/integrations";
import { aiClient } from "../../modules/ai/runtime/client";
import { createLogger } from "../../services/log";
import { resolveSavedModelRequest } from "../models/store";
import { ocrChannels } from "./store";

/** Largest PNG accepted for one upload; a bigger selection asks for a smaller region. */
export const OCR_MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export type OcrRecognitionOutcome =
  | { status: "recognized"; text: string }
  | { status: "no_text" }
  | { status: "cancelled" }
  /** The saved services or their models cannot recognize now; `reason` is user-facing. */
  | { status: "unavailable"; reason: string }
  | { status: "failed"; message: string };

export interface OcrReadiness {
  ready: boolean;
  reason: string | null;
}

export interface RecognizeScreenshotOptions {
  signal?: AbortSignal;
  /** Bounds one recognition request per channel; the channel default applies when absent. */
  timeoutMs?: number;
}

/** One enabled OCR channel and the binding it runs with. */
export interface OcrChannelEntry {
  id: string;
  binding: ChannelBinding<unknown>;
}

type OcrChannelDefinition = CapabilityChannelDefinition<
  unknown,
  OcrRecognizeInput,
  OcrChannelOutcome
>;

const log = createLogger("ocr/recognize");

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Saved-model access for one recognition call; the routes come from the models store. */
const ocrHostModels: HostModels = {
  resolveSaved: (modelId, purpose) => resolveSavedModelRequest(modelId, purpose),
  generateText: (connection, request, options) =>
    aiClient.generateText(connection, request, options),
  generateTextFromImage: (connection, request, options) =>
    aiClient.generateTextFromImage(connection, request, options),
};

function hostServices(credential: CredentialRecord | null): HostServices {
  return { credential, models: ocrHostModels, log };
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return false;
  }
  return true;
}

function invalidImage(): OcrRecognitionOutcome {
  return { status: "failed", message: t("ocr.failure.invalidImage") };
}

function rawPngFailure(bytes: Uint8Array): OcrRecognitionOutcome | null {
  if (!hasPngSignature(bytes)) return invalidImage();
  if (bytes.byteLength > OCR_MAX_IMAGE_BYTES) {
    return { status: "failed", message: t("ocr.failure.imageTooLarge") };
  }
  return null;
}

function definitionOf(id: string): OcrChannelDefinition | null {
  const definition = ocrChannels.definition(id);
  return definition === null ? null : (definition as unknown as OcrChannelDefinition);
}

/** Enabled OCR channels in priority order. */
export function enabledOcrEntries(): readonly OcrChannelEntry[] {
  const entries: OcrChannelEntry[] = [];
  for (const id of ocrChannels.order()) {
    const binding = ocrChannels.binding(id);
    if (binding === null || !binding.enabled) continue;
    entries.push({ id, binding });
  }
  return entries;
}

/**
 * Checks enabled OCR channels in priority order before capture starts: no request, no upload,
 * ready as soon as at least one enabled channel can run.
 */
export async function checkOcrReadiness(
  entries: readonly OcrChannelEntry[],
): Promise<OcrReadiness> {
  if (entries.length === 0) {
    return { ready: false, reason: t("ocr.failure.unconfigured") };
  }

  const outcome = await runChain<true, string, OcrChannelEntry>(
    entries,
    async (entry) => {
      const definition = definitionOf(entry.id);
      if (definition === null) {
        return { kind: "unavailable", reason: t("ocr.failure.unconfigured") };
      }
      const credential = await ocrChannels.readCredential(entry.binding.credentialRef);
      const readiness = await definition.readiness(entry.binding, hostServices(credential));
      return readiness.ready
        ? { kind: "done", value: true }
        : { kind: "unavailable", reason: readiness.reason };
    },
    { continueOn: () => true },
  );

  if (outcome.kind === "done") return { ready: true, reason: null };
  if (outcome.kind === "unavailable") {
    return { ready: false, reason: outcome.reason ?? t("ocr.failure.unconfigured") };
  }
  return { ready: false, reason: t("ocr.failure.unconfigured") };
}

async function runEntry(
  entry: OcrChannelEntry,
  input: OcrRecognizeInput,
): Promise<ChainStepOutcome<OcrRecognitionOutcome, string>> {
  const definition = definitionOf(entry.id);
  if (definition === null) {
    return { kind: "unavailable", reason: t("ocr.failure.unconfigured") };
  }

  const credential = await ocrChannels.readCredential(entry.binding.credentialRef);
  let result: OcrChannelOutcome;
  try {
    result = await definition.execute(entry.binding, input, hostServices(credential));
  } catch {
    log.warn("An OCR channel failed unexpectedly.");
    return { kind: "failed", failure: "ocr.failure.failed" };
  }

  switch (result.status) {
    case "recognized":
      return { kind: "done", value: { status: "recognized", text: result.text } };
    case "no_text":
      return { kind: "done", value: { status: "no_text" } };
    case "cancelled":
      return { kind: "cancelled" };
    case "unavailable":
      return { kind: "unavailable", reason: result.reason };
    case "failed":
      return {
        kind: "failed",
        failure: definition.failureKey(result.failure) ?? "ocr.failure.failed",
      };
  }
}

/**
 * Recognizes the text in one cropped PNG across enabled OCR channels in priority order.
 * Stops immediately on recognized text, explicit no-text, or cancellation, and falls back to
 * the next enabled channel when a channel is unavailable or fails.
 */
export async function recognizeScreenshot(
  entries: readonly OcrChannelEntry[],
  png: Uint8Array,
  options: RecognizeScreenshotOptions = {},
): Promise<OcrRecognitionOutcome> {
  if (options.signal?.aborted) return { status: "cancelled" };
  if (entries.length === 0) {
    return { status: "unavailable", reason: t("ocr.failure.unconfigured") };
  }

  const pngFailure = rawPngFailure(png);
  if (pngFailure) return pngFailure;

  const input: OcrRecognizeInput = {
    png,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  };
  const outcome = await runChain<OcrRecognitionOutcome, string, OcrChannelEntry>(
    entries,
    (entry) => runEntry(entry, input),
    { continueOn: () => true },
    options.signal,
  );

  // A failed step carries an i18n key; an unavailable step carries its localized reason.
  switch (outcome.kind) {
    case "done":
      return outcome.value;
    case "cancelled":
      return { status: "cancelled" };
    case "unavailable":
      return { status: "unavailable", reason: outcome.reason ?? t("ocr.failure.unconfigured") };
    case "failed":
      return { status: "failed", message: t(outcome.failure) };
  }
}
