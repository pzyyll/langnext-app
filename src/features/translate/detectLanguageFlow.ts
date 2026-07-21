// ABOUTME: Effect use-case for language detection via the detect_language IPC.
// ABOUTME: Optional requestId shares the cancel registry with translate streams.
import { Effect } from "effect";
import { invokeEffect } from "../../storage/invokeEffect";
import type { IpcError } from "../../storage/ipcError";
import type { DetectLanguageInput, DetectLanguageResult } from "../../storage/types";

/**
 * Detect the language of `input.text` via a non-streaming chat completion.
 *
 * Pass `requestId` so `cancel_translate` can abort mid-flight (same registry as
 * translate streams). Soft failures (`ok: false`) are still a successful Effect
 * with a result DTO; only IPC/transport failures fail the Effect as `IpcError`.
 */
export function detectLanguageFlow(
  input: DetectLanguageInput,
  requestId?: string,
): Effect.Effect<DetectLanguageResult, IpcError> {
  return invokeEffect<DetectLanguageResult>("detect_language", {
    input,
    requestId: requestId ?? null,
  });
}
