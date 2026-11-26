// ABOUTME: Runtime shapes the OCR channels and the recognize feature share.
// ABOUTME: A channel reports a failure code; the feature localizes it through the channel's failureKey.

import type { CredentialRecord } from "../../framework/integrations";

/** One recognition budget; screen text is short, so a longer wait is a failure. */
export const OCR_TIMEOUT_MS = 30_000;

/** One screenshot handed to a channel, with the bounds its call runs under. */
export interface OcrRecognizeInput {
  /** The PNG bytes; the feature validated the signature and size once before the chain. */
  png: Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** What one channel reports before the feature chooses the user-facing copy. */
export type OcrChannelOutcome =
  | { status: "recognized"; text: string }
  | { status: "no_text" }
  | { status: "cancelled" }
  /** The channel cannot run right now; `reason` is already user-facing. */
  | { status: "unavailable"; reason: string }
  /** A vendor failure code the channel's `failureKey` maps to copy. */
  | { status: "failed"; failure: string };

/** Reads one credential field as trimmed text; a missing field is empty. */
export function credentialValue(credential: CredentialRecord | null, key: string): string {
  const value = credential?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** True for a JSON object that is not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
