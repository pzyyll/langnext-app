// ABOUTME: Frontend non-stream/stream translation orchestration with ordered fallback.
// ABOUTME: Applies stream deltas/errors from plugins; records history once on terminal outcomes.
import { invokeEffect } from "../../storage/invokeEffect";
import { runStorage } from "../../storage/runStorage";
import type { TranslateInput, TranslateResult } from "../../storage/types";
import { isRetryableCode, mapHttpStatus, normalizeProviderError } from "../providers/errors";
import { providerFetch, providerFetchStream } from "../providers/providerFetch";
import { requireProviderPlugin } from "../providers/registry";
import { SseEventDecoder, Utf8StreamDecoder } from "../providers/sse";
import { ProviderProtocolError, type StreamParseResult } from "../providers/types";
import { newClientRequestId } from "./newClientRequestId";
import {
  resolveTranslationContext,
  type TranslationContextSnapshots,
  type TranslationExecutionContext,
} from "./translationContext";

export type TranslationStreamHandlers = {
  onChunk: (delta: string) => void;
  onReset: (modelId: string) => void;
  onDone: (result: TranslateResult) => void;
  onError: (result: TranslateResult) => void;
};

async function recordHistoryBestEffort(input: {
  completionId: string;
  ok: boolean;
  translatedText: string;
  errorCode: string | null;
  message: string;
  modelId: string | null;
  modelDisplayName: string;
  providerDisplayName: string | null;
  profileId: string | null;
  profileName: string | null;
  latencyMs: number;
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  effectiveSourceLang: string | null;
  effectiveTargetLang: string | null;
}): Promise<void> {
  try {
    await runStorage(
      invokeEffect<void>("record_translation_history_completion", {
        input: {
          completionId: input.completionId,
          ok: input.ok,
          translatedText: input.translatedText,
          errorCode: input.errorCode,
          errorMessage: input.ok ? null : input.message,
          modelId: input.modelId,
          modelDisplayName: input.modelDisplayName,
          providerDisplayName: input.providerDisplayName,
          profileId: input.profileId,
          profileName: input.profileName,
          latencyMs: input.latencyMs,
          sourceLang: input.sourceLang,
          targetLang: input.targetLang,
          sourceText: input.sourceText,
          effectiveSourceLang: input.effectiveSourceLang,
          effectiveTargetLang: input.effectiveTargetLang,
        },
      }),
    );
  } catch {
    // Best-effort history write.
  }
}

function failureResult(
  errorCode: string,
  message: string,
  latencyMs: number,
  modelId?: string | null,
): TranslateResult {
  return {
    ok: false,
    translatedText: "",
    latencyMs,
    errorCode,
    message,
    modelId: modelId ?? null,
  };
}

function successResult(text: string, latencyMs: number, modelId: string): TranslateResult {
  return {
    ok: true,
    translatedText: text,
    latencyMs,
    errorCode: null,
    message: "OK",
    modelId,
  };
}

export async function runTranslationNonStream(
  input: TranslateInput,
  snapshots: TranslationContextSnapshots,
  signal?: AbortSignal,
): Promise<TranslateResult> {
  const started = performance.now();
  const ctx = resolveTranslationContext(input, snapshots);
  if (ctx.earlyFailure) {
    return failureResult(ctx.earlyFailure.errorCode, ctx.earlyFailure.message, 0);
  }
  return runAttempts(input, ctx, snapshots, false, undefined, signal, started);
}

export async function runTranslationStream(
  input: TranslateInput,
  snapshots: TranslationContextSnapshots,
  requestId: string,
  handlers: TranslationStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const started = performance.now();
  const ctx = resolveTranslationContext(input, snapshots);
  if (ctx.earlyFailure) {
    handlers.onError(failureResult(ctx.earlyFailure.errorCode, ctx.earlyFailure.message, 0));
    return;
  }
  const result = await runAttempts(input, ctx, snapshots, true, handlers, signal, started, requestId);
  if (result.ok) {
    handlers.onDone(result);
  } else if (result.errorCode === "cancelled") {
    // Cancellation: no terminal success/error callback contract for abandoned work.
    return;
  } else {
    handlers.onError(result);
  }
}

async function runAttempts(
  input: TranslateInput,
  ctx: TranslationExecutionContext,
  _snapshots: TranslationContextSnapshots,
  stream: boolean,
  handlers: TranslationStreamHandlers | undefined,
  signal: AbortSignal | undefined,
  started: number,
  parentRequestId?: string,
): Promise<TranslateResult> {
  let lastFailure: TranslateResult | null = null;
  let attempted = false;
  const completionId = crypto.randomUUID();

  for (let index = 0; index < ctx.attempts.length; index += 1) {
    if (signal?.aborted) {
      return failureResult("cancelled", "Request cancelled", Math.round(performance.now() - started));
    }
    const attempt = ctx.attempts[index]!;
    if (stream && handlers && index > 0) {
      handlers.onReset(attempt.modelId);
    }
    attempted = true;
    const requestId = parentRequestId && index === 0 ? parentRequestId : newClientRequestId("tr");
    try {
      const plugin = requireProviderPlugin(attempt.pluginId);
      const wire = plugin.buildChatRequest({
        operation: "translate",
        stream,
        modelKey: attempt.modelKey,
        systemPrompt: ctx.systemPrompt,
        userPrompt: ctx.userPrompt,
        temperature: attempt.temperature,
        maxTokens: attempt.maxTokens,
        thinking: attempt.thinking,
        imagePngBase64: null,
      });

      if (!stream) {
        const response = await providerFetch({
          requestId,
          providerInstanceId: attempt.providerId,
          wire,
          signal,
        });
        if (response.status < 200 || response.status >= 300) {
          const code = mapHttpStatus(response.status);
          lastFailure = failureResult(
            code,
            `Provider HTTP ${response.status}`,
            Math.round(performance.now() - started),
            attempt.modelId,
          );
          if (!isRetryableCode(code)) {
            break;
          }
          continue;
        }
        const text = plugin.parseChatResponse(response);
        const result = successResult(text, Math.round(performance.now() - started), attempt.modelId);
        await recordHistoryBestEffort({
          completionId,
          ok: true,
          translatedText: result.translatedText,
          errorCode: null,
          message: result.message,
          modelId: attempt.modelId,
          modelDisplayName: attempt.modelDisplayName,
          providerDisplayName: attempt.providerDisplayName,
          profileId: ctx.profileId,
          profileName: ctx.profileName,
          latencyMs: result.latencyMs,
          sourceLang: input.sourceLang,
          targetLang: input.targetLang,
          sourceText: input.text,
          effectiveSourceLang: input.effectiveSourceLangId ?? null,
          effectiveTargetLang: input.effectiveTargetLangId ?? null,
        });
        return result;
      }

      // Stream path
      const utf8 = new Utf8StreamDecoder();
      const sse = new SseEventDecoder();
      let accumulated = "";
      let httpStatus = 200;
      /** Provider-reported stream error (e.g. Responses `error` / `response.failed`). */
      let streamErrorMessage: string | null = null;

      const applyStreamEvent = (parsed: StreamParseResult): void => {
        if (parsed.kind === "delta") {
          accumulated += parsed.text;
          handlers?.onChunk(parsed.text);
          return;
        }
        if (parsed.kind === "error" && streamErrorMessage == null) {
          streamErrorMessage = parsed.message;
        }
      };

      await providerFetchStream(
        {
          requestId,
          providerInstanceId: attempt.providerId,
          wire,
          signal,
        },
        {
          onStarted: (status) => {
            httpStatus = status;
          },
          onChunk: (bytes) => {
            if (httpStatus < 200 || httpStatus >= 300 || streamErrorMessage != null) {
              return;
            }
            const text = utf8.push(bytes);
            const events = sse.push(text);
            for (const event of events) {
              applyStreamEvent(plugin.parseStreamEvent(event));
              if (streamErrorMessage != null) {
                break;
              }
            }
          },
        },
      );
      if (streamErrorMessage == null) {
        const tailText = utf8.finish();
        if (tailText) {
          for (const event of sse.push(tailText)) {
            applyStreamEvent(plugin.parseStreamEvent(event));
            if (streamErrorMessage != null) {
              break;
            }
          }
        }
      }
      if (streamErrorMessage == null) {
        for (const event of sse.finish()) {
          applyStreamEvent(plugin.parseStreamEvent(event));
          if (streamErrorMessage != null) {
            break;
          }
        }
      }

      if (httpStatus < 200 || httpStatus >= 300) {
        const code = mapHttpStatus(httpStatus);
        lastFailure = failureResult(
          code,
          `Provider HTTP ${httpStatus}`,
          Math.round(performance.now() - started),
          attempt.modelId,
        );
        if (!isRetryableCode(code)) {
          break;
        }
        continue;
      }
      if (streamErrorMessage != null) {
        // Surface provider stream errors to the UI toast via provider_error.
        // Try the next fallback model when available.
        lastFailure = failureResult(
          "provider_error",
          streamErrorMessage,
          Math.round(performance.now() - started),
          attempt.modelId,
        );
        continue;
      }
      const trimmed = accumulated.trim();
      if (!trimmed) {
        lastFailure = failureResult(
          "invalid_response",
          "Empty stream content",
          Math.round(performance.now() - started),
          attempt.modelId,
        );
        continue;
      }
      const result = successResult(trimmed, Math.round(performance.now() - started), attempt.modelId);
      await recordHistoryBestEffort({
        completionId,
        ok: true,
        translatedText: result.translatedText,
        errorCode: null,
        message: result.message,
        modelId: attempt.modelId,
        modelDisplayName: attempt.modelDisplayName,
        providerDisplayName: attempt.providerDisplayName,
        profileId: ctx.profileId,
        profileName: ctx.profileName,
        latencyMs: result.latencyMs,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        sourceText: input.text,
        effectiveSourceLang: input.effectiveSourceLangId ?? null,
        effectiveTargetLang: input.effectiveTargetLangId ?? null,
      });
      return result;
    } catch (error) {
      if (signal?.aborted) {
        return failureResult(
          "cancelled",
          "Request cancelled",
          Math.round(performance.now() - started),
          attempt.modelId,
        );
      }
      const normalized = normalizeProviderError(error);
      lastFailure = failureResult(
        normalized.code,
        normalized.message,
        Math.round(performance.now() - started),
        attempt.modelId,
      );
      const retryable =
        error instanceof ProviderProtocolError || (normalized.retryable && isRetryableCode(normalized.code as never));
      if (!retryable) {
        break;
      }
    }
  }

  const finalFailure =
    lastFailure ??
    failureResult(
      "validation_failed",
      attempted ? "All translation attempts failed" : "No translation attempt ran",
      Math.round(performance.now() - started),
    );
  if (attempted && finalFailure.errorCode !== "cancelled") {
    await recordHistoryBestEffort({
      completionId,
      ok: false,
      translatedText: "",
      errorCode: finalFailure.errorCode ?? "invalid_response",
      message: finalFailure.message,
      modelId: finalFailure.modelId ?? null,
      modelDisplayName:
        ctx.attempts.find((a) => a.modelId === finalFailure.modelId)?.modelDisplayName ??
        finalFailure.modelId ??
        "unknown",
      providerDisplayName: ctx.attempts.find((a) => a.modelId === finalFailure.modelId)?.providerDisplayName ?? null,
      profileId: ctx.profileId,
      profileName: ctx.profileName,
      latencyMs: finalFailure.latencyMs,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      sourceText: input.text,
      effectiveSourceLang: input.effectiveSourceLangId ?? null,
      effectiveTargetLang: input.effectiveTargetLangId ?? null,
    });
  }
  return finalFailure;
}
